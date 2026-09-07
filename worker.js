/*
 * BSE XML RSS – V1.3
 * Alert-first monitor over the official BSE RSS (XML) feed.
 *
 * - Frontend shows only watchlist-matched announcements (last 50)
 * - Sends Telegram / ntfy alerts ONLY for watchlist matches
 * - Preserves original first-fetched time
 * - Brought in line with the bse-fastest-jsonapi corrections:
 *     - dropped the "all announcements" feed/KV store (this was the
 *       single biggest CPU cost — an unconditional 150-item
 *       JSON.stringify + KV put on every poll, even quiet ones)
 *     - ntfy now uses its JSON publish API instead of custom headers
 *       (non-ASCII title/body text was silently crashing the header-based
 *       version before the request even went out)
 *     - KV writes go through a retry-with-backoff wrapper (Workers KV
 *       allows only 1 write/sec per key)
 *     - watchlist is read once per burst and reused, and only fetched at
 *       all once we know there's something new to check
 *     - tag regexes for the RSS XML are compiled once at module scope
 *       instead of per item/per field
 *
 * KV binding: BSE_XML_RSS_DATA
 * Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, NTFY_TOPIC
 */

const BSE_RSS_URL = "https://www.bseindia.com/data/xml/announcements.xml";

const MAX_RECENT_SEEN = 50;
const MAX_ALERTS = 500;    // how many watchlist matches to retain in KV history
const DISPLAY_LIMIT = 50;  // how many of those the frontend feed shows

const BURST_POLLS = 2;
const BURST_GAP_MS = 18000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Precompiled once at module load — reused across every item, every poll,
// every invocation of this isolate. No `g` flag, so they are stateless and
// safe to share.
const RSS_TAG_NAMES = ["title", "link", "description", "pubDate", "scripcode"];
const TAG_REGEXES = Object.fromEntries(
  RSS_TAG_NAMES.map((name) => [name, new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i")])
);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeBseLink(rawLink) {
  var clean = String(rawLink || "").trim();
  if (!clean) return "https://www.bseindia.com";
  if (clean.indexOf("AttachLive") !== -1 || clean.indexOf("AttachHis") !== -1) {
    var fileName = clean.split("/").pop();
    if (fileName) return "https://www.bseindia.com/xml-data/corpfiling/AttachLive/" + fileName;
  }
  if (clean.indexOf("http") !== 0) {
    return clean.indexOf("/") === 0 ? "https://www.bseindia.com" + clean : "https://www.bseindia.com/" + clean;
  }
  return clean;
}

function escapeTelegramHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegramAlert(title, body, scrip, link, fetchedAt, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  var pdfLink = normalizeBseLink(link);
  var targetLink =
    pdfLink && pdfLink !== "https://www.bseindia.com"
      ? pdfLink
      : scrip
        ? "https://www.bseindia.com/stock-share-price/" + scrip
        : "https://www.bseindia.com";
  const formattedFetchTime = fetchedAt
    ? new Date(fetchedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })
    : "N/A";
  const messageText = `🔔 <b>${escapeTelegramHtml(title)}</b>\n\n${escapeTelegramHtml(body)}\n\n⏱ <b>Fetched:</b> ${formattedFetchTime}\n📎 <a href="${targetLink}">View</a>`;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: messageText,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    });
  } catch (err) {
    console.error("Telegram error:", err);
  }
}

async function sendNtfyAlert(title, body, scrip, link, fetchedAt, env) {
  // Trim defensively — a stray trailing newline/space pasted into the
  // secret (common with `wrangler secret put` on Windows) silently
  // breaks the request without ever showing an error.
  const topic = String(env.NTFY_TOPIC || "").trim();
  if (!topic) return;

  var pdfLink = normalizeBseLink(link);
  var targetLink =
    pdfLink && pdfLink !== "https://www.bseindia.com"
      ? pdfLink
      : scrip
        ? "https://www.bseindia.com/stock-share-price/" + scrip
        : "https://www.bseindia.com";

  const formattedFetchTime = fetchedAt
    ? new Date(fetchedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })
    : "N/A";

  // Use ntfy's JSON publish API instead of custom X-* headers.
  // Header values must be Latin-1/ASCII-safe — a rupee sign, emoji,
  // or any non-ASCII company/announcement text in X-Title/X-Click
  // makes fetch() throw "Invalid header value" before the request is
  // even sent. The JSON body has no such restriction, so this is both
  // more reliable and lets titles keep their original characters.
  const payload = {
    topic,
    title: String(title || "BSE Alert").slice(0, 200),
    message: `${body}\n\nFetched: ${formattedFetchTime}`.slice(0, 4000),
    click: targetLink,
    tags: ["chart_with_upwards_trend", "warning"],
    priority: 4,
  };

  try {
    const res = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });

    const resText = await res.text().catch(() => "");
    await saveLastNtfyStatus(env, {
      ok: res.ok,
      status: res.status,
      response: resText.slice(0, 500),
      topic,
      at: new Date().toISOString(),
    });

    if (!res.ok) {
      console.error("ntfy HTTP error:", res.status, resText);
    }
  } catch (err) {
    console.error("ntfy error:", err);
    await saveLastNtfyStatus(env, {
      ok: false,
      error: String(err && err.message ? err.message : err),
      topic,
      at: new Date().toISOString(),
    });
  }
}

function parsePubDateRss(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  try {
    const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
    if (m) {
      const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
      const mon = months[m[2]];
      if (mon !== undefined) {
        // BSE times are IST (UTC+5:30)
        const d = new Date(Date.UTC(+m[3], mon, +m[1], +m[4] - 5, +m[5] - 30, +m[6]));
        if (!isNaN(d.getTime())) return d.toISOString();
      }
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch (e) {}
  return s;
}

function extractScripFromTitle(title) {
  const m = String(title || "").match(/\((\d{6,})\)\s*$/);
  return m ? m[1] : "";
}

function extractCompanyFromTitle(title) {
  return String(title || "").replace(/\s*\(\d{6,}\)\s*$/, "").trim() || "Company";
}

function computeFingerprint(item) {
  const link = String(item.link || "").trim().toLowerCase();
  if (link) {
    const file = link.split("/").pop();
    if (file && file.length > 8) return `att:${file}`;
  }
  const scrip = String(item.scripcode || extractScripFromTitle(item.title) || "").trim();
  const desc = String(item.description || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const day = String(item.pubDate || "").slice(0, 10);
  return `st:${scrip}|${desc}|${day}`;
}

function matchesWatchlist(item, watchlist) {
  if (!watchlist || !watchlist.length) return false;
  const itemScrip = String(item.scripcode || extractScripFromTitle(item.title) || "").trim();
  const itemCompany = extractCompanyFromTitle(item.title).toLowerCase();

  for (let i = 0; i < watchlist.length; i++) {
    const w = watchlist[i];
    const ws = String(w.scrip || "").trim();
    if (ws && itemScrip && ws === itemScrip) return true;
    const wn = String(w.name || "").toLowerCase().trim();
    if (wn.length >= 3 && itemCompany && itemCompany.indexOf(wn) !== -1) return true;
  }
  return false;
}

function parseRssItems(xmlText) {
  const items = [];
  const itemBlocks = xmlText.split(/<item>/i).slice(1);

  for (const block of itemBlocks) {
    const end = block.indexOf("</item>");
    const content = end === -1 ? block : block.slice(0, end);

    function tag(name) {
      const m = content.match(TAG_REGEXES[name]);
      if (!m) return "";
      return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
    }

    const title = tag("title");
    const link = tag("link");
    const description = tag("description");
    const pubDate = tag("pubDate");
    const scripcode = tag("scripcode");

    if (!title && !description) continue;
    items.push({ title, link, description, pubDate, scripcode });
  }
  return items;
}

/* ---------- KV helpers ---------- */

// Workers KV allows at most 1 write/sec per key. If two requests try to
// write the same key within that window, one is rejected. This wraps
// every KV write with a few retries, backing off past the 1-second
// window with a little random jitter each time so concurrent retries
// don't keep landing on top of each other and colliding again.
async function kvPut(env, key, value, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await env.BSE_XML_RSS_DATA.put(key, value);
      return;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await sleep(1050 + Math.floor(Math.random() * 400));
      }
    }
  }
  throw lastErr;
}

async function getWatchlist(env) {
  if (!env.BSE_XML_RSS_DATA) return [];
  const data = await env.BSE_XML_RSS_DATA.get("watchlist", "json");
  return Array.isArray(data) ? data : [];
}

async function setWatchlist(env, watchlist) {
  if (!env.BSE_XML_RSS_DATA) throw new Error("BSE_XML_RSS_DATA is not bound.");
  await kvPut(env, "watchlist", JSON.stringify(watchlist));
}

async function getNotificationSettings(env) {
  if (!env.BSE_XML_RSS_DATA) return { telegram: true, ntfy: true };
  const data = await env.BSE_XML_RSS_DATA.get("notificationSettings", "json");
  return data || { telegram: true, ntfy: true };
}

async function setNotificationSettings(env, settings) {
  if (!env.BSE_XML_RSS_DATA) throw new Error("BSE_XML_RSS_DATA is not bound.");
  await kvPut(env, "notificationSettings", JSON.stringify(settings));
}

async function getRecentSeen(env) {
  if (!env.BSE_XML_RSS_DATA) return [];
  const data = await env.BSE_XML_RSS_DATA.get("recentSeen", "json");
  return Array.isArray(data) ? data : [];
}

async function saveRecentSeen(env, ids) {
  if (!env.BSE_XML_RSS_DATA) return;
  await kvPut(env, "recentSeen", JSON.stringify(ids.slice(0, MAX_RECENT_SEEN)));
}

async function getAlertFingerprints(env) {
  if (!env.BSE_XML_RSS_DATA) return [];
  const data = await env.BSE_XML_RSS_DATA.get("alertFingerprints", "json");
  return Array.isArray(data) ? data : [];
}

async function saveAlertFingerprints(env, list) {
  if (!env.BSE_XML_RSS_DATA) return;
  await kvPut(env, "alertFingerprints", JSON.stringify(list.slice(0, MAX_ALERTS * 2)));
}

async function getAlerts(env) {
  if (!env.BSE_XML_RSS_DATA) return [];
  const data = await env.BSE_XML_RSS_DATA.get("specialAlerts", "json");
  return Array.isArray(data) ? data : [];
}

async function saveAlerts(env, alerts) {
  if (!env.BSE_XML_RSS_DATA) return;
  await kvPut(env, "specialAlerts", JSON.stringify(alerts.slice(0, MAX_ALERTS)));
}

async function saveLastNtfyStatus(env, status) {
  if (!env.BSE_XML_RSS_DATA) return;
  await kvPut(env, "lastNtfyStatus", JSON.stringify(status));
}

async function getLastNtfyStatus(env) {
  if (!env.BSE_XML_RSS_DATA) return null;
  return await env.BSE_XML_RSS_DATA.get("lastNtfyStatus", "json");
}

/* ---------- core logic ---------- */

async function fetchRssItems() {
  const response = await fetch(BSE_RSS_URL, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/rss+xml, application/xml, text/xml, */*",
      Referer: "https://www.bseindia.com/",
      "Cache-Control": "no-cache",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!response.ok) throw new Error(`BSE RSS HTTP ${response.status}`);
  const xml = await response.text();
  return parseRssItems(xml);
}

async function pollOnce(env, cachedWatchlist, cachedRecentSeen) {
  const fetchedAt = new Date().toISOString();
  let items = [];
  try {
    items = await fetchRssItems();
  } catch (err) {
    console.error("fetch failed:", err);
    return { ok: false, error: String(err), newAnnouncements: 0, newAlerts: 0 };
  }

  if (!items.length) {
    return { ok: true, newAnnouncements: 0, newAlerts: 0, rows: 0 };
  }

  const page = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const fp = computeFingerprint(it);
    if (!fp) continue;
    page.push({ item: it, fp });
  }

  // Cheap "is anything new at all?" check. Within a burst, recentSeen is
  // passed in from the previous poll's in-memory result instead of being
  // re-read + re-parsed from KV every single poll — same data, far less
  // repeated JSON work per cron tick.
  const recentSeen = cachedRecentSeen || (await getRecentSeen(env));
  const seenSet = new Set(recentSeen);

  if (recentSeen.length === 0) {
    // Baseline run (first ever poll, or after a KV reset) — nothing
    // to alert on yet, just record what we've seen.
    const fps = page.map((p) => p.fp);
    await saveRecentSeen(env, fps);
    return { ok: true, status: "baseline", newAnnouncements: 0, newAlerts: 0, rows: items.length, updatedSeen: fps };
  }

  const newOnes = [];
  for (let i = 0; i < page.length; i++) {
    if (!seenSet.has(page[i].fp)) newOnes.push(page[i]);
  }

  if (newOnes.length === 0) {
    // Nothing new — hand the same recentSeen array back unchanged so the
    // burst loop can reuse it without another KV round trip.
    return { ok: true, newAnnouncements: 0, newAlerts: 0, rows: items.length, updatedSeen: recentSeen };
  }

  const watchlist = cachedWatchlist || (await getWatchlist(env));
  const settings = await getNotificationSettings(env);

  let newAlertCount = 0;
  let alerts = null;
  let alertFpSet = null;

  if (watchlist.length > 0) {
    for (let i = 0; i < newOnes.length; i++) {
      const { item, fp } = newOnes[i];
      if (!matchesWatchlist(item, watchlist)) continue;

      if (!alertFpSet) {
        alertFpSet = new Set(await getAlertFingerprints(env));
        alerts = await getAlerts(env);
      }
      if (alertFpSet.has(fp)) continue;

      const company = extractCompanyFromTitle(item.title);
      const scrip = String(item.scripcode || extractScripFromTitle(item.title) || "").trim();
      const title = String(item.description || item.title || "New Announcement").trim();
      const link = normalizeBseLink(item.link);
      const pubDate = parsePubDateRss(item.pubDate);

      // Use the first-seen time (this is a brand-new item, so current fetchedAt is correct)
      if (settings.telegram !== false) {
        await sendTelegramAlert(`${company} (${scrip})`, title, scrip, link, fetchedAt, env);
      }
      if (settings.ntfy !== false) {
        await sendNtfyAlert(`${company} (${scrip})`, title, scrip, link, fetchedAt, env);
      }

      alerts.unshift({
        company,
        scrip,
        title,
        link,
        fingerprint: fp,
        pubDate,
        fetchedAt,                 // first time we saw it
        alert: true,
        alertCreatedAt: new Date().toISOString(),
      });
      alertFpSet.add(fp);
      newAlertCount++;
    }
  }

  // update recentSeen
  const updatedSeen = [];
  const addSet = new Set();
  for (let i = 0; i < newOnes.length; i++) {
    const fp = newOnes[i].fp;
    if (!addSet.has(fp)) {
      addSet.add(fp);
      updatedSeen.push(fp);
    }
  }
  for (let i = 0; i < recentSeen.length; i++) {
    if (updatedSeen.length >= MAX_RECENT_SEEN) break;
    if (!addSet.has(recentSeen[i])) {
      addSet.add(recentSeen[i]);
      updatedSeen.push(recentSeen[i]);
    }
  }
  await saveRecentSeen(env, updatedSeen);

  if (newAlertCount > 0 && alerts && alertFpSet) {
    await saveAlerts(env, alerts);
    await saveAlertFingerprints(env, Array.from(alertFpSet));
  }

  return {
    ok: true,
    newAnnouncements: newOnes.length,
    newAlerts: newAlertCount,
    rows: items.length,
    totalSeen: updatedSeen.length,
    updatedSeen,
  };
}

async function pollBurst(env) {
  const results = [];
  let totalNew = 0;
  let totalAlerts = 0;

  // Read watchlist + recentSeen once for the whole burst instead of once
  // per poll. The watchlist essentially never changes mid-burst. recentSeen
  // DOES change poll-to-poll (new items get added to it), so instead of
  // re-reading it from KV each time, we carry the in-memory `updatedSeen`
  // that pollOnce already computed straight into the next call.
  const watchlist = await getWatchlist(env);
  let recentSeen = await getRecentSeen(env);

  for (let i = 0; i < BURST_POLLS; i++) {
    const r = await pollOnce(env, watchlist, recentSeen);
    results.push(r);
    totalNew += r.newAnnouncements || 0;
    totalAlerts += r.newAlerts || 0;
    if (r.updatedSeen) recentSeen = r.updatedSeen;
    if (i < BURST_POLLS - 1) await sleep(BURST_GAP_MS);
  }

  return {
    ok: true,
    mode: "burst",
    polls: BURST_POLLS,
    gapMs: BURST_GAP_MS,
    newAnnouncements: totalNew,
    newAlerts: totalAlerts,
    results,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    try {
      if (url.pathname === "/") {
        return json({
          status: "running",
          app: "BSE XML RSS",
          version: "1.3",
          note: "Alerts-only (watchlist matches, last 50). Original fetchedAt is permanent. /announcements + /alerts + /monitor + /ntfy-test + /ntfy-status",
        });
      }

      if (url.pathname === "/monitor") {
        const burst = url.searchParams.get("burst") === "1";
        if (burst) return json(await pollBurst(env));
        return json(await pollOnce(env));
      }

      if (url.pathname === "/watchlist") {
        if (request.method === "GET") return json({ ok: true, watchlist: await getWatchlist(env) });
        if (request.method === "POST") {
          const body = await request.json();
          await setWatchlist(env, body.watchlist || []);
          return json({ ok: true, watchlist: body.watchlist });
        }
      }

      if (url.pathname === "/notification-settings") {
        if (request.method === "GET") return json({ ok: true, settings: await getNotificationSettings(env) });
        if (request.method === "POST") {
          const body = await request.json();
          await setNotificationSettings(env, body);
          return json({ ok: true, settings: body });
        }
      }

      // Frontend main feed: only watchlist matches, most recent first,
      // capped for display (full history still kept via /alerts).
      if (url.pathname === "/announcements") {
        const items = (await getAlerts(env)).slice(0, DISPLAY_LIMIT);
        return json({ ok: true, count: items.length, items });
      }

      // Only watchlist-matched alerts (full retained history, up to MAX_ALERTS)
      if (url.pathname === "/alerts") {
        return json({ ok: true, items: await getAlerts(env) });
      }

      // Legacy alias, kept for backward compatibility — same as /announcements
      if (url.pathname === "/bse-announcements") {
        const items = (await getAlerts(env)).slice(0, DISPLAY_LIMIT);
        return json({ ok: true, count: items.length, items });
      }

      if (url.pathname === "/categories") {
        return json({ ok: true, categories: [] });
      }

      if (url.pathname === "/clear-alert-fingerprints") {
        await kvPut(env, "alertFingerprints", "[]");
        return json({ ok: true, message: "Alert fingerprints cleared. Next new matches will send notifications." });
      }

      // Fires one real ntfy notification right now and reports exactly
      // what ntfy.sh returned (or the exact error), so a delivery
      // problem shows up immediately instead of only in worker logs.
      if (url.pathname === "/ntfy-test") {
        await sendNtfyAlert(
          "BSE XML RSS — test alert",
          "If you see this on your device, ntfy delivery is working.",
          "TEST",
          "",
          new Date().toISOString(),
          env
        );
        return json({ ok: true, result: await getLastNtfyStatus(env) });
      }

      // Shows the outcome of the most recent ntfy send attempt
      // (triggered by /monitor or the cron), without sending a new one.
      if (url.pathname === "/ntfy-status") {
        return json({ ok: true, ntfyTopicConfigured: !!(env.NTFY_TOPIC && env.NTFY_TOPIC.trim()), last: await getLastNtfyStatus(env) });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollBurst(env));
  },
};
