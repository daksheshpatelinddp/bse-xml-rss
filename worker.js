/*
 * BSE XML-RSS WORKER – HIGH PERFORMANCE V2.3 (WITH TEST ALERT ROUTE)
 */

const BSE_RSS_URL = "https://www.bseindia.com/data/xml-data/corpfiling/rss/bse_rss.xml";

const MAX_RECENT_SEEN = 800;
const MAX_ALERTS = 500;
const DISPLAY_LIMIT = 50;

// Memory Cache to bypass Cloudflare KV 60-second read delay
let MEMORY_WATCHLIST = null;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
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
    const scrip = scripMatch ? scripMatch[0] : "";

    items.push({ title, link, description, pubDate, scrip });
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
  const title = String(item.title || "").toLowerCase().replace(/\s+/g, " ").trim();
  return `rss:${scrip}|${title}`;
}

function matchesWatchlist(item, watchlist) {
  if (!watchlist || !watchlist.length) return false;
  const itemScrip = String(item.scrip || "").trim();
  const itemTitle = String(item.title || "").toLowerCase().trim();

  for (let i = 0; i < watchlist.length; i++) {
    const w = watchlist[i];
    const ws = String(typeof w === "object" ? w.scrip || w.symbol || w.code || "" : w).trim();
    if (ws && itemScrip && ws === itemScrip) return true;

    const wn = String(typeof w === "object" ? w.name || w.symbol || w.company || "" : w).toLowerCase().trim();
    if (wn.length >= 3 && itemTitle.includes(wn)) return true;
  }
  return false;
}

/* ---------- Telegram Notification ---------- */

async function sendTelegramAlert(title, body, scrip, link, fetchedAt, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  var targetLink = normalizeBseLink(link);
  const formattedFetchTime = fetchedAt
    ? new Date(fetchedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })
    : "N/A";
  const messageText = `🔔 <b>${escapeTelegramHtml(title)}</b>\n\n${escapeTelegramHtml(body)}\n\n⏱ <b>Fetched:</b> ${formattedFetchTime}\n📎 <a href="${targetLink}">View Document</a>`;
  
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

/* ---------- KV Helpers ---------- */

async function kvPut(env, key, value, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await env.BSE_XML_RSS_KV.put(key, value);
      return;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(1000);
    }
  }
  throw lastErr;
}

async function getWatchlist(env) {
  if (MEMORY_WATCHLIST !== null) return MEMORY_WATCHLIST;
  if (!env.BSE_XML_RSS_KV) return [];
  const data = await env.BSE_XML_RSS_KV.get("watchlist", "json");
  MEMORY_WATCHLIST = Array.isArray(data) ? data : [];
  return MEMORY_WATCHLIST;
}

async function saveWatchlist(env, watchlist) {
  MEMORY_WATCHLIST = watchlist;
  if (!env.BSE_XML_RSS_KV) return;
  await kvPut(env, "watchlist", JSON.stringify(watchlist));
}

async function getRecentSeen(env) {
  if (!env.BSE_XML_RSS_KV) return [];
  const data = await env.BSE_XML_RSS_KV.get("recentSeen", "json");
  return Array.isArray(data) ? data : [];
}

async function saveRecentSeen(env, ids) {
  if (!env.BSE_XML_RSS_KV) return;
  await kvPut(env, "recentSeen", JSON.stringify(ids.slice(0, MAX_RECENT_SEEN)));
}

async function getAlerts(env) {
  if (!env.BSE_XML_RSS_KV) return [];
  const data = await env.BSE_XML_RSS_KV.get("specialAlerts", "json");
  return Array.isArray(data) ? data : [];
}

async function saveAlerts(env, alerts) {
  if (!env.BSE_XML_RSS_KV) return;
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

  let newAlertCount = 0;
  let alerts = null;

  if (watchlist.length > 0) {
    for (let i = 0; i < newOnes.length; i++) {
      const { item, fp } = newOnes[i];
      if (!matchesWatchlist(item, watchlist)) continue;

      if (!alerts) alerts = await getAlerts(env);

      const title = item.title || "BSE Announcement";
      const body = item.description || title;

      await sendTelegramAlert(title, body, item.scrip, item.link, fetchedAt, env);

      alerts.unshift({
        title,
        scrip: item.scrip,
        link: item.link,
        pubDate: item.pubDate,
        fetchedAt,
        fingerprint: fp,
      });
      newAlertCount++;
    }
  }

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
  if (newAlertCount > 0 && alerts) {
    await saveAlerts(env, alerts);
  }

  return {
    ok: true,
    newAnnouncements: newOnes.length,
    newAlerts: newAlertCount,
    rows: items.length,
  };
}

/* ---------- Request Handler ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle Preflight OPTIONS Request
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === "/") {
        return json({ status: "running", app: "BSE XML RSS Worker", version: "2.3.0" });
      }

      // -------------------------------------------------------------
      // TEST TELEGRAM ALERT ENDPOINT
      // -------------------------------------------------------------
      if (url.pathname === "/test-alert") {
        const testTitle = "TEST ALERT: Gujarat Themis Biosyn Ltd";
        const testBody = "This is a test notification for GUJTHEM.";
        const testScrip = "506879";
        const testLink = "https://www.bseindia.com";
        const fetchedAt = new Date().toISOString();

        // 1. Send direct Telegram notification
        await sendTelegramAlert(testTitle, testBody, testScrip, testLink, fetchedAt, env);

        // 2. Persist mock alert into specialAlerts KV list for UI rendering
        const alerts = await getAlerts(env);
        alerts.unshift({
          title: testTitle,
          scrip: testScrip,
          link: testLink,
          pubDate: new Date().toUTCString(),
          fetchedAt,
          fingerprint: "test-fp-" + Date.now(),
        });
        await saveAlerts(env, alerts);

        return json({ ok: true, message: "Test alert dispatched to Telegram & Dashboard!" });
      }

      if (url.pathname === "/check" || url.pathname === "/monitor") {
        return json(await pollOnce(env));
      }

      if (url.pathname === "/announcements" || url.pathname === "/alerts") {
        const items = (await getAlerts(env)).slice(0, DISPLAY_LIMIT);
        return json({ ok: true, count: items.length, items });
      }

      // WATCHLIST ROUTE
      if (url.pathname === "/watchlist") {
        if (request.method === "GET") {
          const list = await getWatchlist(env);
          return json({ ok: true, watchlist: list, count: list.length });
        }

        if (request.method === "POST" || request.method === "PUT") {
          let parsedData;
          try {
            parsedData = await request.json();
          } catch (e) {
            const rawText = await request.text();
            parsedData = rawText.split("\n").map((line) => line.trim()).filter(Boolean);
          }

          let finalWatchlist = [];
          if (Array.isArray(parsedData)) {
            finalWatchlist = parsedData;
          } else if (parsedData && Array.isArray(parsedData.watchlist)) {
            finalWatchlist = parsedData.watchlist;
          } else if (parsedData && Array.isArray(parsedData.symbols)) {
            finalWatchlist = parsedData.symbols;
          }

          await saveWatchlist(env, finalWatchlist);
          return json({ ok: true, count: finalWatchlist.length, watchlist: finalWatchlist });
        }

        if (request.method === "DELETE") {
          await saveWatchlist(env, []);
          return json({ ok: true, message: "Watchlist cleared" });
        }
      }

      return json({ error: "Endpoint not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollOnce(env));
  },
};