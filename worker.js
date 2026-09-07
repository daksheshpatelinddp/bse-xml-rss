/*
 * BSE FASTEST JSON API – V1.2
 * Dedicated project for BSE corporate announcements via JSON API only.
 *
 * - Frontend shows only watchlist-matched announcements (last 50)
 * - Sends Telegram / ntfy alerts ONLY for watchlist matches
 * - Preserves original first-fetched time
 *
 * KV binding: BSE_FASTEST_JSONAPIKV
 * Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, NTFY_TOPIC
 */

const BSE_ANN_API =
  "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";

const MAX_RECENT_SEEN = 800;
const MAX_ALERTS = 500;       // how many watchlist matches to retain in KV history
const DISPLAY_LIMIT = 50;     // how many of those the frontend feed shows

const BURST_POLLS = 4;
const BURST_GAP_MS = 14000;

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

function getIstDateStr() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const yyyy = ist.getUTCFullYear();
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(ist.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
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

function parsePubDate(row) {
  let pubDate = row.DissemDT || row.News_submission_dt || row.NEWS_DT || row.DT_TM || "";
  if (!pubDate) return "";
  pubDate = String(pubDate).trim();
  try {
    if (!pubDate.includes("Z") && !pubDate.includes("+") && pubDate.indexOf("-", 10) === -1) {
      pubDate = pubDate.replace(" ", "T") + "+05:30";
    }
    const d = new Date(pubDate);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch (e) {}
  return String(row.DissemDT || row.NEWS_DT || "");
}

function computeFingerprint(row) {
  const att = String(row.ATTACHMENTNAME || "").trim().toLowerCase();
  if (att) return `att:${att}`;
  const scrip = String(row.SCRIP_CD || "").trim();
  const title = String(row.HEADLINE || row.NEWSSUB || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const day = String(row.DissemDT || row.NEWS_DT || "").slice(0, 10);
  return `st:${scrip}|${title}|${day}`;
}

function matchesWatchlist(row, watchlist) {
  if (!watchlist || !watchlist.length) return false;
  const itemScrip = String(row.SCRIP_CD || "").trim();
  const itemCompany = String(row.SLONGNAME || "").toLowerCase().trim();

  for (let i = 0; i < watchlist.length; i++) {
    const w = watchlist[i];
    const ws = String(w.scrip || "").trim();
    if (ws && itemScrip && ws === itemScrip) return true;
    const wn = String(w.name || "").toLowerCase().trim();
    if (wn.length >= 3 && itemCompany && itemCompany.indexOf(wn) !== -1) return true;
  }
  return false;
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
      await env.BSE_FASTEST_JSONAPIKV.put(key, value);
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
  if (!env.BSE_FASTEST_JSONAPIKV) return [];
  const data = await env.BSE_FASTEST_JSONAPIKV.get("watchlist", "json");
  return Array.isArray(data) ? data : [];
}

async function setWatchlist(env, watchlist) {
  if (!env.BSE_FASTEST_JSONAPIKV) throw new Error("BSE_FASTEST_JSONAPIKV is not bound.");
  await kvPut(env, "watchlist", JSON.stringify(watchlist));
}

async function getNotificationSettings(env) {
  if (!env.BSE_FASTEST_JSONAPIKV) return { telegram: true, ntfy: true };
  const data = await env.BSE_FASTEST_JSONAPIKV.get("notificationSettings", "json");
  return data || { telegram: true, ntfy: true };
}

async function setNotificationSettings(env, settings) {
  if (!env.BSE_FASTEST_JSONAPIKV) throw new Error("BSE_FASTEST_JSONAPIKV is not bound.");
  await kvPut(env, "notificationSettings", JSON.stringify(settings));
}

async function getRecentSeen(env) {
  if (!env.BSE_FASTEST_JSONAPIKV) return [];
  const data = await env.BSE_FASTEST_JSONAPIKV.get("recentSeen", "json");
  return Array.isArray(data) ? data : [];
}

async function saveRecentSeen(env, ids) {
  if (!env.BSE_FASTEST_JSONAPIKV) return;
  await kvPut(env, "recentSeen", JSON.stringify(ids.slice(0, MAX_RECENT_SEEN)));
}

async function getAlertFingerprints(env) {
  if (!env.BSE_FASTEST_JSONAPIKV) return [];
  const data = await env.BSE_FASTEST_JSONAPIKV.get("alertFingerprints", "json");
  return Array.isArray(data) ? data : [];
}

async function saveAlertFingerprints(env, list) {
  if (!env.BSE_FASTEST_JSONAPIKV) return;
  await kvPut(env, "alertFingerprints", JSON.stringify(list.slice(0, MAX_ALERTS * 2)));
}

async function getAlerts(env) {
  if (!env.BSE_FASTEST_JSONAPIKV) return [];
  const data = await env.BSE_FASTEST_JSONAPIKV.get("specialAlerts", "json");
  return Array.isArray(data) ? data : [];
}

async function saveAlerts(env, alerts) {
  if (!env.BSE_FASTEST_JSONAPIKV) return;
  await kvPut(env, "specialAlerts", JSON.stringify(alerts.slice(0, MAX_ALERTS)));
}

async function saveLastNtfyStatus(env, status) {
  if (!env.BSE_FASTEST_JSONAPIKV) return;
  await kvPut(env, "lastNtfyStatus", JSON.stringify(status));
}

async function getLastNtfyStatus(env) {
  if (!env.BSE_FASTEST_JSONAPIKV) return null;
  return await env.BSE_FASTEST_JSONAPIKV.get("lastNtfyStatus", "json");
}

/* ---------- core logic ---------- */

async function fetchJsonPage1() {
  const dateStr = getIstDateStr();
  const url =
    `${BSE_ANN_API}?pageno=1` +
    `&strCat=-1&subcategory=-1` +
    `&strPrevDate=${dateStr}&strToDate=${dateStr}` +
    `&strSearch=P&strscrip=&strType=C`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.bseindia.com/",
      Origin: "https://www.bseindia.com",
      "Cache-Control": "no-cache",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!response.ok) throw new Error(`BSE JSON HTTP ${response.status}`);
  const data = await response.json();
  return data && Array.isArray(data.Table) ? data.Table : [];
}

async function pollOnce(env, cachedWatchlist) {
  const fetchedAt = new Date().toISOString();
  let rows = [];
  try {
    rows = await fetchJsonPage1();
  } catch (err) {
    console.error("fetch failed:", err);
    return { ok: false, error: String(err), newAnnouncements: 0, newAlerts: 0 };
  }

  if (!rows.length) {
    return { ok: true, newAnnouncements: 0, newAlerts: 0, rows: 0 };
  }

  const page = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const fp = computeFingerprint(row);
    if (!fp) continue;
    page.push({ row, fp });
  }

  // Cheap "is anything new at all?" check. The only KV write below
  // (recentSeen, and alerts when a watchlist item matches) happens
  // when something has actually changed — most polls end here.
  const recentSeen = await getRecentSeen(env);
  const seenSet = new Set(recentSeen);

  if (recentSeen.length === 0) {
    // Baseline run (first ever poll, or after a KV reset) — nothing
    // to alert on yet, just record what we've seen.
    await saveRecentSeen(env, page.map((p) => p.fp));
    return { ok: true, status: "baseline", newAnnouncements: 0, newAlerts: 0, rows: rows.length };
  }

  const newOnes = [];
  for (let i = 0; i < page.length; i++) {
    if (!seenSet.has(page[i].fp)) newOnes.push(page[i]);
  }

  if (newOnes.length === 0) {
    return { ok: true, newAnnouncements: 0, newAlerts: 0, rows: rows.length };
  }

  const watchlist = cachedWatchlist || (await getWatchlist(env));
  const settings = await getNotificationSettings(env);

  let newAlertCount = 0;
  let alerts = null;
  let alertFpSet = null;

  if (watchlist.length > 0) {
    for (let i = 0; i < newOnes.length; i++) {
      const { row, fp } = newOnes[i];
      if (!matchesWatchlist(row, watchlist)) continue;

      if (!alertFpSet) {
        alertFpSet = new Set(await getAlertFingerprints(env));
        alerts = await getAlerts(env);
      }
      if (alertFpSet.has(fp)) continue;

      const company = String(row.SLONGNAME || "").trim() || "Scrip";
      const scrip = String(row.SCRIP_CD || "").trim();
      const title = String(row.HEADLINE || row.NEWSSUB || "New Announcement").trim();
      let link = "";
      if (row.ATTACHMENTNAME) {
        link = `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${row.ATTACHMENTNAME}`;
      } else if (row.NSURL) {
        link = row.NSURL;
      }

      // Use the first-seen time (this is a brand-new item, so current fetchedAt is correct)
      if (settings.telegram !== false) {
        await sendTelegramAlert(`${company} (${scrip})`, title, scrip, link, fetchedAt, env);
      }
      if (settings.ntfy !== false) {
        await sendNtfyAlert(`${company} (${scrip})`, title, scrip, link, fetchedAt, env);
      }

      const pubDate = parsePubDate(row);

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
    rows: rows.length,
    totalSeen: updatedSeen.length,
  };
}

async function pollBurst(env) {
  const results = [];
  let totalNew = 0;
  let totalAlerts = 0;

  // Read once for the whole burst instead of once per poll — the
  // watchlist rarely changes mid-burst, and this saves 3 redundant
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
          app: "BSE Fastest JSON API",
          version: "1.1.2",
          note: "Shows all announcements. Alerts only for watchlist. /announcements + /alerts + /monitor + /ntfy-test + /ntfy-status",
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

      // Fires one real ntfy notification right now and reports exactly
      // what ntfy.sh returned (or the exact error), so a delivery
      // problem shows up immediately instead of only in worker logs.
      if (url.pathname === "/ntfy-test") {
        await sendNtfyAlert(
          "BSE Fastest — test alert",
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