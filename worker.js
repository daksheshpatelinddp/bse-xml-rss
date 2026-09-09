/*
 * BSE XML RSS – V1.2 (Telegram-only, CPU-optimized)
 * - Official BSE RSS (XML)
 * - Original fetchedAt is permanent
 * - Alerts only for new watchlist matches
 * - Notifications: Telegram only (ntfy removed)
 * - Burst polling now reads/writes KV once per cron invocation instead of
 *   once per sub-poll, and RSS tag parsing uses precompiled regexes, to
 *   keep CPU time per invocation low (Workers Free plan caps this at 10ms).
 *
 * KV binding: BSE_XML_RSS_DATA
 * Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */

const BSE_RSS_URL = "https://www.bseindia.com/data/xml/announcements.xml";

const MAX_RECENT_SEEN = 800;
const MAX_ALERTS = 500;       // how many watchlist matches to retain in KV history
const DISPLAY_LIMIT = 50;     // how many of those the frontend feed shows

const BURST_POLLS = 2;
;
const BURST_GAP_MS = 30000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
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
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: messageText,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("Telegram error:", err);
    return false;
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

// Precompiled once at module load. Building a new RegExp per tag per item
// (as the previous version did) recompiles the pattern on every call, which
// is the main reason a single burst poll (3x over ~150 items x 5 tags) could
// blow past the Workers Free plan's 10ms CPU budget for one invocation.
const TAG_REGEXES = {
  title: /<title[^>]*>([\s\S]*?)<\/title>/i,
  link: /<link[^>]*>([\s\S]*?)<\/link>/i,
  description: /<description[^>]*>([\s\S]*?)<\/description>/i,
  pubDate: /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i,
  scripcode: /<scripcode[^>]*>([\s\S]*?)<\/scripcode>/i,
};
const CDATA_RE = /<!\[CDATA\[([\s\S]*?)\]\]>/gi;

function extractTag(content, name) {
  const m = content.match(TAG_REGEXES[name]);
  if (!m) return "";
  return m[1]
    .replace(CDATA_RE, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// Only the top of the feed can contain genuinely new items (BSE's RSS is
// newest-first, and the rest of this file already assumes that ordering).
// During active trading hours the live feed can carry many hundreds of
// entries; fully parsing all of them (5 regex extractions + a fingerprint
// each) on every sub-poll is what pushes a single invocation past the
// Workers Free plan's 10ms CPU cap. Capping this is safe: it is extremely
// unlikely BSE publishes more than this many brand-new filings inside one
// polling interval.
const MAX_ITEMS_PER_POLL = 120;

// Finds only the byte range covering the newest MAX_ITEMS_PER_POLL <item>
// blocks and returns that as a substring, WITHOUT scanning the rest of the
// document. This matters because xmlText.split(/<item>/i) always scans the
// entire input first and only discards the extra pieces afterward — so
// capping "items kept" alone doesn't cap "text scanned". BSE's feed is
// cumulative for the whole trading day, so the raw text keeps growing
// hour by hour; this keeps per-poll cost tied to MAX_ITEMS_PER_POLL, not to
// how much the feed has grown by that point in the day.
const ITEM_OPEN_RE = /<item>/gi;

function boundedItemsXml(xmlText, maxItems) {
  ITEM_OPEN_RE.lastIndex = 0;
  let firstStart = -1;
  let lastStart = -1;
  let count = 0;
  let m;
  while ((m = ITEM_OPEN_RE.exec(xmlText)) !== null) {
    if (firstStart === -1) firstStart = m.index;
    lastStart = m.index;
    count++;
    if (count >= maxItems) break;
  }
  if (firstStart === -1) return "";
  const closeIdx = xmlText.indexOf("</item>", lastStart);
  const endIdx = closeIdx === -1 ? xmlText.length : closeIdx + "</item>".length;
  return xmlText.slice(firstStart, endIdx);
}

function parseRssItems(xmlText) {
  const items = [];
  const bounded = boundedItemsXml(xmlText, MAX_ITEMS_PER_POLL);
  const itemBlocks = bounded.split(/<item>/i).slice(1);

  for (const block of itemBlocks) {
    const end = block.indexOf("</item>");
    const content = end === -1 ? block : block.slice(0, end);

    const title = extractTag(content, "title");
    const link = extractTag(content, "link");
    const description = extractTag(content, "description");
    const pubDate = extractTag(content, "pubDate");
    const scripcode = extractTag(content, "scripcode");

    if (!title && !description) continue;
    items.push({ title, link, description, pubDate, scripcode });
  }
  return items;
}

async function getWatchlist(env) {
  if (!env.BSE_XML_RSS_DATA) return [];
  const data = await env.BSE_XML_RSS_DATA.get("watchlist", "json");
  return Array.isArray(data) ? data : [];
}

async function setWatchlist(env, watchlist) {
  if (!env.BSE_XML_RSS_DATA) throw new Error("BSE_XML_RSS_DATA is not bound.");
  await env.BSE_XML_RSS_DATA.put("watchlist", JSON.stringify(watchlist));
}

async function getNotificationSettings(env) {
  if (!env.BSE_XML_RSS_DATA) return { telegram: true };
  const data = await env.BSE_XML_RSS_DATA.get("notificationSettings", "json");
  return data || { telegram: true };
}

async function setNotificationSettings(env, settings) {
  if (!env.BSE_XML_RSS_DATA) throw new Error("BSE_XML_RSS_DATA is not bound.");
  await env.BSE_XML_RSS_DATA.put("notificationSettings", JSON.stringify(settings));
}

async function getRecentSeen(env) {
  if (!env.BSE_XML_RSS_DATA) return [];
  const data = await env.BSE_XML_RSS_DATA.get("recentSeen", "json");
  return Array.isArray(data) ? data : [];
}

async function saveRecentSeen(env, ids) {
  if (!env.BSE_XML_RSS_DATA) return;
  await env.BSE_XML_RSS_DATA.put("recentSeen", JSON.stringify(ids.slice(0, MAX_RECENT_SEEN)));
}

async function getAlertFingerprints(env) {
  if (!env.BSE_XML_RSS_DATA) return [];
  const data = await env.BSE_XML_RSS_DATA.get("alertFingerprints", "json");
  return Array.isArray(data) ? data : [];
}

async function saveAlertFingerprints(env, list) {
  if (!env.BSE_XML_RSS_DATA) return;
  await env.BSE_XML_RSS_DATA.put("alertFingerprints", JSON.stringify(list.slice(0, MAX_ALERTS * 2)));
}

async function getAlerts(env) {
  if (!env.BSE_XML_RSS_DATA) return [];
  const data = await env.BSE_XML_RSS_DATA.get("specialAlerts", "json");
  return Array.isArray(data) ? data : [];
}

async function saveAlerts(env, alerts) {
  if (!env.BSE_XML_RSS_DATA) return;
  await env.BSE_XML_RSS_DATA.put("specialAlerts", JSON.stringify(alerts.slice(0, MAX_ALERTS)));
}

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

async function pollOnce(env, cachedWatchlist) {
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

  const recentSeen = await getRecentSeen(env);
  const seenSet = new Set(recentSeen);

  if (recentSeen.length === 0) {
    // Baseline run (first ever poll, or after a KV reset) — nothing to
    // alert on yet, just record what we've seen.
    await saveRecentSeen(env, page.map((p) => p.fp));
    return { ok: true, status: "baseline", newAnnouncements: 0, newAlerts: 0, rows: items.length };
  }

  const newOnes = [];
  for (let i = 0; i < page.length; i++) {
    if (!seenSet.has(page[i].fp)) newOnes.push(page[i]);
  }

  if (newOnes.length === 0) {
    return { ok: true, newAnnouncements: 0, newAlerts: 0, rows: items.length };
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

      let telegramOk = false;
      if (settings.telegram !== false) {
        telegramOk = await sendTelegramAlert(`${company} (${scrip})`, title, scrip, link, fetchedAt, env);
      }

      if (telegramOk || settings.telegram === false) {
        alerts.unshift({
          company,
          scrip,
          title,
          link,
          fingerprint: fp,
          pubDate,
          fetchedAt,
          alert: true,
          alertCreatedAt: new Date().toISOString(),
        });
        alertFpSet.add(fp);
        newAlertCount++;
      }
    }
  }

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
  };
}

// Scheduled (cron) entry point. Runs pollOnce BURST_POLLS times with a gap
// between each, to catch announcements published mid-burst. This project's
// scope is watchlist alerts only (the general "show everything" feed was
// removed — see /areas/bse-xml-rss for the reasoning), so pollOnce itself
// is cheap: it only fingerprints+dedupes the fetched feed and builds full
// records for genuine new watchlist matches, never rebuilding a large
// stored list on every poll. That's what makes repeating it BURST_POLLS
// times affordable within the Workers Free plan's 10ms-per-invocation cap.
async function pollBurst(env) {
  const results = [];
  let totalNew = 0;
  let totalAlerts = 0;

  // Read once for the whole burst instead of once per poll — the
  // watchlist rarely changes mid-burst, and this saves redundant
  // KV reads + JSON.parse calls per cron tick.
  const watchlist = await getWatchlist(env);

  for (let i = 0; i < BURST_POLLS; i++) {
    const r = await pollOnce(env, watchlist);
    results.push(r);
    totalNew += r.newAnnouncements || 0;
    totalAlerts += r.newAlerts || 0;
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
          version: "1.1",
          note: "Original fetchedAt is permanent. Alerts only for new watchlist matches.",
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

      if (url.pathname === "/announcements") {
        const items = (await getAlerts(env)).slice(0, DISPLAY_LIMIT);
        return json({ ok: true, count: items.length, items });
      }

      if (url.pathname === "/alerts") {
        return json({ ok: true, items: await getAlerts(env) });
      }

      if (url.pathname === "/bse-announcements") {
        const items = (await getAlerts(env)).slice(0, DISPLAY_LIMIT);
        return json({ ok: true, count: items.length, items });
      }

      if (url.pathname === "/categories") {
        return json({ ok: true, categories: [] });
      }

   if (url.pathname === "/clear-alert-fingerprints") {
  await env.BSE_XML_RSS_DATA.put("alertFingerprints", "[]");
  return json({ ok: true, message: "Alert fingerprints cleared. Next new matches will send notifications." });
}

// Temporary force test – sends one Telegram message
if (url.pathname === "/test-alert") {
  const title = "TEST ALERT – BSE XML RSS";
  const body = "This is a forced test message. If you receive this, Telegram is working correctly.";
  const scrip = "000000";
  const link = "https://www.bseindia.com";
  const fetchedAt = new Date().toISOString();

  const telegramOk = await sendTelegramAlert(title, body, scrip, link, fetchedAt, env);

  return json({
    ok: true,
    telegram: telegramOk,
    message: "Test alert sent. Check Telegram."
  });
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
