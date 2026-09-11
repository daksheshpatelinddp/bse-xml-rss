/*
 * BSE XML-RSS WORKER – HIGH PERFORMANCE V2.2 (TELEGRAM ONLY)
 * Merged Features: Watchlist CRUD, Notification Settings, Fingerprint Tracking, and Test Endpoints.
 * Maintained: Ultra-low CPU (<3ms) pointer-based XML parsing & KV logic from worker best cpu time.
 */

const BSE_RSS_URL = "https://www.bseindia.com/data/xml/announcements.xml";

const MAX_RECENT_SEEN = 800;
const MAX_ALERTS = 500;
const DISPLAY_LIMIT = 50;

// Set to 1 poll per scheduled trigger to avoid V8 context and GC CPU spikes
const BURST_POLLS = 1;

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
    .replace(/$/g, "&gt;");
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

/* ---------- Fast XML Parsing ---------- */

function getXmlTag(xmlString, tag) {
  const startTag = `<${tag}>`;
  const endTag = `</${tag}>`;
  const startIndex = xmlString.indexOf(startTag);
  if (startIndex === -1) return "";
  const endIndex = xmlString.indexOf(endTag, startIndex + startTag.length);
  if (endIndex === -1) return "";
  return xmlString.slice(startIndex + startTag.length, endIndex).trim();
}

function parseXmlFeed(xmlText) {
  const items = [];
  let pos = 0;

  while (true) {
    const itemStart = xmlText.indexOf("<item>", pos);
    if (itemStart === -1) break;
    const itemEnd = xmlText.indexOf("</item>", itemStart);
    if (itemEnd === -1) break;

    const itemBlock = xmlText.slice(itemStart + 6, itemEnd);
    const title = getXmlTag(itemBlock, "title");
    const link = getXmlTag(itemBlock, "link");
    const description = getXmlTag(itemBlock, "description");
    const pubDate = getXmlTag(itemBlock, "pubDate");

    const scripMatch = title.match(/\b\d{6}\b/) || description.match(/\b\d{6}\b/);
    const scrip = scripMatch ? scripMatch[0] : extractScripFromTitle(title);

    items.push({
      title,
      link,
      description,
      pubDate,
      scrip,
    });

    pos = itemEnd + 7;
  }

  return items;
}

function computeFingerprint(item) {
  const link = String(item.link || "").trim().toLowerCase();
  if (link && link.includes("attachlive")) {
    const file = link.split("/").pop();
    if (file) return `att:${file}`;
  }
  const scrip = String(item.scrip || "").trim();
  const title = String(item.title || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return `rss:${scrip}|${title}`;
}

function matchesWatchlist(item, watchlist) {
  if (!watchlist || !watchlist.length) return false;
  const itemScrip = String(item.scrip || "").trim();
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

/* ---------- Notifications (Telegram Only) ---------- */

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

/* ---------- KV Helpers ---------- */

function getKvBinding(env) {
  return  env.BSE_XML_RSS_DATA;
}

async function kvPut(env, key, value, attempts = 3) {
  const kv = getKvBinding(env);
  if (!kv) return;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await kv.put(key, value);
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
  const kv = getKvBinding(env);
  if (!kv) return [];
  const data = await kv.get("watchlist", "json");
  return Array.isArray(data) ? data : [];
}

async function setWatchlist(env, watchlist) {
  const kv = getKvBinding(env);
  if (!kv) throw new Error("KV store is not bound.");
  await kvPut(env, "watchlist", JSON.stringify(watchlist));
}

async function getNotificationSettings(env) {
  const kv = getKvBinding(env);
  if (!kv) return { telegram: true };
  const data = await kv.get("notificationSettings", "json");
  return data || { telegram: true };
}

async function setNotificationSettings(env, settings) {
  const kv = getKvBinding(env);
  if (!kv) throw new Error("KV store is not bound.");
  await kvPut(env, "notificationSettings", JSON.stringify(settings));
}

async function getRecentSeen(env) {
  const kv = getKvBinding(env);
  if (!kv) return [];
  const data = await kv.get("recentSeen", "json");
  return Array.isArray(data) ? data : [];
}

async function saveRecentSeen(env, ids) {
  await kvPut(env, "recentSeen", JSON.stringify(ids.slice(0, MAX_RECENT_SEEN)));
}

async function getAlertFingerprints(env) {
  const kv = getKvBinding(env);
  if (!kv) return [];
  const data = await kv.get("alertFingerprints", "json");
  return Array.isArray(data) ? data : [];
}

async function saveAlertFingerprints(env, list) {
  await kvPut(env, "alertFingerprints", JSON.stringify(list.slice(0, MAX_ALERTS * 2)));
}

async function getAlerts(env) {
  const kv = getKvBinding(env);
  if (!kv) return [];
  const data = await kv.get("specialAlerts", "json");
  return Array.isArray(data) ? data : [];
}

async function saveAlerts(env, alerts) {
  await kvPut(env, "specialAlerts", JSON.stringify(alerts.slice(0, MAX_ALERTS)));
}

/* ---------- Core Poll Function ---------- */

async function pollOnce(env, cachedWatchlist) {
  const fetchedAt = new Date().toISOString();
  let xmlText = "";

  try {
    const response = await fetch(BSE_RSS_URL, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Cache-Control": "no-cache",
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!response.ok) throw new Error(`BSE XML HTTP ${response.status}`);
    xmlText = await response.text();
  } catch (err) {
    console.error("XML Fetch Error:", err);
    return { ok: false, error: String(err) };
  }

  const items = parseXmlFeed(xmlText);
  if (!items.length) {
    return { ok: true, newAnnouncements: 0, newAlerts: 0, rows: 0 };
  }

  const page = [];
  for (let i = 0; i < items.length; i++) {
    const fp = computeFingerprint(items[i]);
    if (fp) page.push({ item: items[i], fp });
  }

  const recentSeen = await getRecentSeen(env);
  const seenSet = new Set(recentSeen);

  if (recentSeen.length === 0) {
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
      const scrip = String(item.scrip || extractScripFromTitle(item.title) || "").trim();
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

  // Update Recent Seen list
  const updatedSeen = [];
  const addSet = new Set();
  for (let i = 0; i < newOnes.length; i++) {
    addSet.add(newOnes[i].fp);
    updatedSeen.push(newOnes[i].fp);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    try {
      if (url.pathname === "/") {
        return json({
          status: "running",
          app: "BSE XML RSS Worker (Telegram Only)",
          version: "2.2.0",
          note: "High-performance XML parsing with complete watchlist & notification support.",
        });
      }

      if (url.pathname === "/monitor") {
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

      if (url.pathname === "/announcements" || url.pathname === "/bse-announcements") {
        const items = (await getAlerts(env)).slice(0, DISPLAY_LIMIT);
        return json({ ok: true, count: items.length, items });
      }

      if (url.pathname === "/alerts") {
        return json({ ok: true, items: await getAlerts(env) });
      }

      if (url.pathname === "/clear-alert-fingerprints") {
        const kv = getKvBinding(env);
        if (kv) await kv.put("alertFingerprints", "[]");
        return json({ ok: true, message: "Alert fingerprints cleared." });
      }

      if (url.pathname === "/test-alert") {
        const title = "TEST ALERT – BSE XML RSS";
        const body = "This is a forced test message from the high-performance worker.";
        const scrip = "000000";
        const link = "https://www.bseindia.com";
        const fetchedAt = new Date().toISOString();

        const telegramOk = await sendTelegramAlert(title, body, scrip, link, fetchedAt, env);

        return json({
          ok: true,
          telegram: telegramOk,
          message: "Test alert sent. Check Telegram.",
        });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollOnce(env));
  },
};
