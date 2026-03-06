require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const Parser = require("rss-parser");

const parser = new Parser();
const STATE_FILE = path.join(__dirname, "seenLinkedin.json");
const KEYWORDS_FILE = path.join(__dirname, "linkedin-keywords.json");

const DEFAULT_POLL_SECONDS = 600;
const MAX_SEEN = 2000;
const DEFAULT_MAX_ALERTS_PER_CYCLE = 5;
const DEFAULT_MAX_POST_AGE_HOURS = 48;

// Google News RSS query groups for LinkedIn posts
const RSS_QUERY_GROUPS = [
  "(%22clay.com%22+OR+%22clay+gtm%22+OR+%22clay+automation%22+OR+%22clay+workflows%22+OR+%22clay+operator%22+OR+%22clay+specialist%22+OR+%22clay+consultant%22+OR+%22clay+expert%22+OR+%22clay+builder%22)",
  "(%22gtm+engineer%22+OR+%22go+to+market+engineer%22+OR+%22revenue+operations+engineer%22+OR+%22growth+operations+engineer%22)",
  "(%22campaign+executive%22+OR+%22campaign+manager%22+OR+%22marketing+operations%22)"
];

// LinkedIn jobs API search queries
const JOB_SEARCH_QUERIES = [
  "clay operator",
  "clay specialist",
  "clay consultant",
  "clay expert",
  "clay builder",
  "gtm engineer",
  "go to market engineer",
  "revenue operations engineer",
  "growth operations engineer",
  "gtm",
  "campaign executive",
  "campaign manager",
  "marketing operations"
];

const DEFAULT_RSS_FEEDS = RSS_QUERY_GROUPS.map(
  (q) => `https://news.google.com/rss/search?q=site:linkedin.com/posts+(hiring+OR+%22looking+for%22+OR+%22we+are+hiring%22)+${q}+when:1d&hl=en&gl=US&ceid=US:en`
);

const LINKEDIN_JOB_SEARCH_BASE =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";

// --- Helpers ---

function cleanText(text) {
  return (text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirst(input, regex) {
  const m = input.match(regex);
  return m ? cleanText(m[1]) : "";
}

function normalize(text) {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Strip seniority/noise prefixes for title dedup
function stripNoise(title) {
  return normalize(title)
    .replace(/^(sr\.?|senior|lead|principal|staff|junior|jr\.?|associate|remote)\s+/g, "")
    .replace(/\s*[\-–|]\s*remote\s*$/g, "")
    .replace(/\s*\(remote\)\s*$/g, "")
    .trim();
}

// Normalise a LinkedIn URL to strip tracking params and country subdomains
function urlKey(link) {
  if (!link) return "";
  // Strip query string (refId, trackingId change each request)
  let url = link.split("?")[0];
  // Normalise country subdomains: pk.linkedin.com -> www.linkedin.com
  url = url.replace(/^https?:\/\/[a-z]{2}\.linkedin\.com/i, "https://www.linkedin.com");
  return url.toLowerCase();
}

// Title+company key for secondary dedup
function titleKey(item) {
  const t = stripNoise(item.title || "");
  const c = normalize((item.company || "").split(/\s*[\|·]\s*/)[0]);
  return `${t}|||${c}`;
}

// --- State ---

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { seen: {}, sentTitles: {}, stats: {} };
    }
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    // Support legacy array format
    let seen = raw.seen;
    if (Array.isArray(seen)) {
      seen = {};
      for (const k of raw.seen) seen[k] = 1;
    }
    return {
      seen: (seen && typeof seen === "object") ? seen : {},
      sentTitles: (raw.sentTitles && typeof raw.sentTitles === "object" && !Array.isArray(raw.sentTitles)) ? raw.sentTitles : {},
      stats: (raw.stats && typeof raw.stats === "object") ? raw.stats : {}
    };
  } catch (err) {
    console.log("Failed to read state:", err.message);
    return { seen: {}, sentTitles: {}, stats: {} };
  }
}

function trimSeen(seen) {
  const keys = Object.keys(seen);
  if (keys.length <= MAX_SEEN) return seen;
  const trimmed = {};
  for (const k of keys.slice(-MAX_SEEN)) trimmed[k] = seen[k];
  return trimmed;
}

function writeState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        seen: trimSeen(state.seen || {}),
        sentTitles: state.sentTitles || {},
        stats: state.stats || {}
      },
      null,
      2
    )
  );
}

// --- Stats ---

function getLocalDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function rollStatsDate(stats) {
  const today = getLocalDateKey();
  if (stats.date !== today) {
    return { date: today, cyclesToday: 0, matchedToday: 0, sentToday: 0, lastSummaryDate: stats.lastSummaryDate || "" };
  }
  return stats;
}

// --- Keywords ---

function getKeywords() {
  try {
    const keywords = JSON.parse(fs.readFileSync(KEYWORDS_FILE, "utf8"));
    if (!Array.isArray(keywords) || keywords.length === 0) throw new Error("Empty keywords");
    return keywords.map(normalize).filter(Boolean);
  } catch (err) {
    throw new Error("linkedin-keywords.json is empty or invalid: " + err.message);
  }
}

// --- LinkedIn Jobs API ---

function parseLinkedinJobCards(html, query) {
  const cards = html.split(/<li(?=\s|>)/i).slice(1);
  const items = [];

  for (const card of cards) {
    let href = extractFirst(card, /href="([^"]*\/jobs\/view\/[^"]+)"/i);
    if (!href) continue;
    if (href.startsWith("/")) href = `https://www.linkedin.com${href}`;

    const title = extractFirst(card, /class="base-search-card__title"[\s\S]*?>([\s\S]*?)<\/h3>/i);
    const company = extractFirst(card, /class="base-search-card__subtitle"[\s\S]*?>([\s\S]*?)<\/h4>/i);
    const location = extractFirst(card, /class="job-search-card__location"[\s\S]*?>([\s\S]*?)<\/span>/i);
    const datetime = extractFirst(card, /<time[^>]*datetime="([^"]+)"/i);
    const timeText = extractFirst(card, /<time[^>]*>([\s\S]*?)<\/time>/i);

    items.push({
      title: title || "LinkedIn Job",
      company: company || "",
      link: href,
      contentSnippet: [company, location, timeText].filter(Boolean).join(" | "),
      pubDate: datetime || new Date().toISOString(),
      isoDate: datetime || new Date().toISOString(),
      sourceFeed: `linkedin-jobs:${query}`
    });
  }

  return items;
}

async function fetchLinkedinJobs() {
  const allItems = [];

  for (const query of JOB_SEARCH_QUERIES) {
    try {
      const url =
        `${LINKEDIN_JOB_SEARCH_BASE}?keywords=${encodeURIComponent(query)}` +
        `&location=${encodeURIComponent("Worldwide")}` +
        `&f_WT=2&f_TPR=r86400&sortBy=DD&start=0`;

      const res = await axios.get(url, {
        timeout: 20000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept-Language": "en-US,en;q=0.9"
        }
      });

      const items = parseLinkedinJobCards(res.data || "", query);
      allItems.push(...items);
      console.log(`LinkedIn jobs [${query}]: ${items.length} results`);
    } catch (err) {
      console.log(`LinkedIn jobs failed [${query}]: ${err.message}`);
    }
  }

  return allItems;
}

// --- RSS Feeds ---

// Extract the real LinkedIn URL from a Google News RSS item.
// Google News wraps the original URL in a redirect; the real URL is in the
// item content HTML as an <a href="..."> pointing to linkedin.com.
function extractLinkedinUrl(item) {
  // Try content / summary HTML first — Google News embeds the source href there
  const html = item.content || item.summary || item["content:encoded"] || "";
  const match = html.match(/href="(https?:\/\/(?:www\.)?linkedin\.com[^"]+)"/i);
  if (match) return match[1].split("?")[0];

  // Fallback: use the item link if it already points to linkedin.com
  const link = item.link || item.guid || "";
  if (/linkedin\.com/i.test(link)) return link.split("?")[0];

  // Nothing useful — return empty so we skip this item
  return "";
}

async function fetchRssFeeds() {
  const feedUrls = DEFAULT_RSS_FEEDS;
  const results = await Promise.allSettled(feedUrls.map((url) => parser.parseURL(url)));
  const items = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      const feedItems = result.value.items || [];
      for (const item of feedItems) {
        const linkedinUrl = extractLinkedinUrl(item);
        if (!linkedinUrl) continue; // skip if we can't get a real LinkedIn URL
        items.push({ ...item, link: linkedinUrl, sourceFeed: feedUrls[i] });
      }
      console.log(`RSS OK: ${feedItems.length} items`);
    } else {
      console.log(`RSS failed: ${result.reason?.message}`);
    }
  }

  return items;
}

// --- Matching ---

function matchesKeywords(item, keywords) {
  const text = normalize(
    [item.title, item.contentSnippet, item.content].filter(Boolean).join(" ")
  );
  return keywords.filter((k) => text.includes(k));
}

function isWithinAge(item, maxAgeHours) {
  const raw = item.isoDate || item.pubDate;
  if (!raw) return true; // allow if no date
  const d = new Date(raw);
  if (isNaN(d.getTime())) return true; // allow if unparseable
  const ageMs = Date.now() - d.getTime();
  return ageMs >= 0 && ageMs <= maxAgeHours * 3600 * 1000;
}

// --- Telegram ---

async function sendTelegram(message) {
  if (process.env.DRY_RUN === "1") {
    console.log("DRY_RUN:", message.slice(0, 100));
    return true;
  }

  const token = (process.env.BOT_TOKEN || "").trim();
  const groupId = (process.env.GROUP_ID || "").trim();

  if (!token || !groupId) throw new Error("BOT_TOKEN or GROUP_ID missing");

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await axios.post(url, { chat_id: groupId, text: message, disable_web_page_preview: true }, { timeout: 15000 });
      return true;
    } catch (err) {
      const retryAfter = err.response?.data?.parameters?.retry_after;
      if (err.response?.status === 429 && retryAfter) {
        await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      } else if (attempt === 3) {
        console.log("Telegram failed:", err.response?.data || err.message);
        return false;
      } else {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  return false;
}

function formatMessage(item, matchedKeywords) {
  const title = item.title || "LinkedIn Opportunity";
  const company = item.company || "";
  const summary = (item.contentSnippet || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const type = (item.link || "").includes("/jobs/") ? "Job" : "Post";

  return [
    "LinkedIn Hiring Alert",
    "",
    `Type: ${type}`,
    `Title: ${title}`,
    company ? `Company: ${company}` : null,
    summary ? `Details: ${summary}` : null,
    `Keywords: ${matchedKeywords.join(", ")}`,
    `Link: ${item.link}`
  ].filter(Boolean).join("\n");
}

// --- Daily Summary ---

async function maybeSendDailySummary(state) {
  if (process.env.DAILY_SUMMARY !== "1") return;
  const hour = Number(process.env.SUMMARY_HOUR || 22);
  const now = new Date();
  const today = getLocalDateKey();
  if (state.stats.lastSummaryDate === today) return;
  if (now.getHours() < hour) return;

  const msg = [
    "LinkedIn Daily Summary",
    `Date: ${today}`,
    `Cycles: ${state.stats.cyclesToday || 0}`,
    `Matched: ${state.stats.matchedToday || 0}`,
    `Sent: ${state.stats.sentToday || 0}`
  ].join("\n");

  const ok = await sendTelegram(msg);
  if (ok) {
    state.stats.lastSummaryDate = today;
    writeState(state);
  }
}

// --- Main cycle ---

async function runCycle() {
  const keywords = getKeywords();
  const maxPostAgeHours = Number(process.env.MAX_POST_AGE_HOURS || DEFAULT_MAX_POST_AGE_HOURS) || DEFAULT_MAX_POST_AGE_HOURS;
  const maxAlertsPerCycle = Number(process.env.MAX_ALERTS_PER_CYCLE || DEFAULT_MAX_ALERTS_PER_CYCLE) || DEFAULT_MAX_ALERTS_PER_CYCLE;

  const state = readState();
  state.stats = rollStatsDate(state.stats);

  console.log(`\n=== Cycle at ${new Date().toISOString()} ===`);

  // Fetch all items in parallel
  const [rssItems, jobItems] = await Promise.all([
    fetchRssFeeds(),
    fetchLinkedinJobs()
  ]);

  const allItems = [...rssItems, ...jobItems];
  console.log(`Total raw items: ${allItems.length}`);

  // Dedup by URL key into a Map (same job from multiple queries = 1 entry)
  const uniqueByUrl = new Map();
  for (const item of allItems) {
    const uk = urlKey(item.link);
    if (uk && !uniqueByUrl.has(uk)) {
      uniqueByUrl.set(uk, item);
    }
  }
  console.log(`Unique by URL: ${uniqueByUrl.size}`);

  let sent = 0;
  let skippedSeen = 0;
  let skippedKeyword = 0;
  let skippedAge = 0;
  let skippedTitle = 0;

  for (const [uk, item] of uniqueByUrl) {
    if (sent >= maxAlertsPerCycle) break;

    // Skip if URL already seen
    if (state.seen[uk]) {
      skippedSeen++;
      continue;
    }

    // Age check
    if (!isWithinAge(item, maxPostAgeHours)) {
      skippedAge++;
      state.seen[uk] = 1;
      continue;
    }

    // Keyword match
    const matched = matchesKeywords(item, keywords);
    if (matched.length === 0) {
      skippedKeyword++;
      state.seen[uk] = 1; // mark as seen so we don't re-check
      continue;
    }

    // Title+company dedup (catches Sr./Senior/Lead variants)
    const tk = titleKey(item);
    if (state.sentTitles[tk]) {
      skippedTitle++;
      state.seen[uk] = 1;
      console.log(`Skip duplicate title: "${item.title}"`);
      continue;
    }

    // Send alert
    const message = formatMessage(item, matched);
    const ok = await sendTelegram(message);

    if (ok) {
      state.seen[uk] = 1;
      state.sentTitles[tk] = new Date().toISOString();
      state.stats.sentToday = (state.stats.sentToday || 0) + 1;
      sent++;
      writeState(state); // write after every send (crash-safe)
      console.log(`SENT [${sent}]: ${item.title}`);
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  state.stats.cyclesToday = (state.stats.cyclesToday || 0) + 1;
  state.stats.matchedToday = (state.stats.matchedToday || 0) + sent;
  writeState(state);

  console.log(`Done: sent=${sent}, skipped(seen=${skippedSeen}, keyword=${skippedKeyword}, age=${skippedAge}, titleDup=${skippedTitle})`);

  await maybeSendDailySummary(state);
}

// --- Entry point ---

async function start() {
  console.log("LinkedIn notifier starting...");

  if (process.env.RUN_ONCE === "1") {
    await runCycle();
    return;
  }

  const pollSeconds = Number(process.env.LINKEDIN_POLL_SECONDS || DEFAULT_POLL_SECONDS) || DEFAULT_POLL_SECONDS;

  if (process.env.STARTUP_PING === "1") {
    await sendTelegram("LinkedIn notifier is live. Monitoring for jobs matching your keywords.");
  }

  await runCycle();
  setInterval(() => runCycle().catch((e) => console.log("Cycle error:", e.message)), pollSeconds * 1000);
  console.log(`Polling every ${pollSeconds}s.`);
}

start().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
