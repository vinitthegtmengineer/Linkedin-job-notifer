require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const Parser = require("rss-parser");

const parser = new Parser();
const STATE_FILE = path.join(__dirname, "seenLinkedin.json");
const KEYWORDS_FILE = path.join(__dirname, "linkedin-keywords.json");

const DEFAULT_POLL_SECONDS = 60;
const MAX_SEEN = 1000;
const DEFAULT_MAX_ALERTS_PER_CYCLE = 10;
const DEFAULT_MAX_POST_AGE_HOURS = 24;

const ROLE_QUERY_GROUPS = [
  "%22campaign+manager%22",
  "(%22clay.com%22+OR+%22clay+gtm%22+OR+%22clay+automation%22+OR+%22clay+workflows%22+OR+%22clay+operator%22+OR+%22clay+specialist%22+OR+%22clay+consultant%22+OR+%22clay+expert%22+OR+%22clay+builder%22)",
  "(%22revenue+operations+manager%22+OR+%22revops+engineer%22+OR+%22growth+operations+manager%22+OR+%22outbound+operations+manager%22+OR+%22marketing+operations+manager%22)",
  "(%22gtm+engineer%22+OR+%22go+to+market+engineer%22+OR+%22revenue+operations+engineer%22+OR+%22growth+operations+engineer%22)"
];

const JOB_SEARCH_QUERIES = [
  "campaign manager",
  "clay operator",
  "clay specialist",
  "clay consultant",
  "clay expert",
  "clay builder",
  "revenue operations manager",
  "revops engineer",
  "growth operations manager",
  "outbound operations manager",
  "marketing operations manager",
  "gtm engineer",
  "go to market engineer",
  "revenue operations engineer",
  "growth operations engineer"
];

const DEFAULT_FEEDS = ROLE_QUERY_GROUPS.map((roleQuery) =>
  `https://news.google.com/rss/search?q=site:linkedin.com/posts+(hiring+OR+job+opening)+(%22remote%22)+${roleQuery}+when:1d&hl=en-IN&gl=IN&ceid=IN:en`
);

const LINKEDIN_JOB_SEARCH_BASE =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";

function cleanText(text) {
  return (text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirst(input, regex) {
  const m = input.match(regex);
  return m ? cleanText(m[1]) : "";
}

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
      link: href,
      contentSnippet: [company, location, timeText].filter(Boolean).join(" | "),
      content: [company, location, timeText].filter(Boolean).join(" "),
      pubDate: datetime || "",
      isoDate: datetime || "",
      sourceFeed: `linkedin-jobs-api:${query}`
    });
  }

  return items;
}

async function fetchLinkedinJobSearchItems() {
  const queries = (process.env.JOB_SEARCH_QUERIES || "")
    .split(",")
    .map((q) => q.trim())
    .filter(Boolean);
  const finalQueries = queries.length ? queries : JOB_SEARCH_QUERIES;
  const allItems = [];

  for (const query of finalQueries) {
    try {
      const url =
        `${LINKEDIN_JOB_SEARCH_BASE}?keywords=${encodeURIComponent(query)}` +
        `&location=${encodeURIComponent("Worldwide")}` +
        `&f_WT=2&f_TPR=r86400&sortBy=DD&start=0`;

      const res = await axios.get(url, {
        timeout: 20000,
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      const items = parseLinkedinJobCards(res.data || "", query);
      allItems.push(...items);
      console.log(`LinkedIn jobs OK: ${items.length} from query "${query}"`);
    } catch (err) {
      console.log(`LinkedIn jobs failed for "${query}": ${err.message}`);
    }
  }

  return allItems;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.log(`Failed to read ${path.basename(filePath)}: ${err.message}`);
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function normalize(text) {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function getKeywords() {
  const keywords = readJson(KEYWORDS_FILE, []);
  if (!Array.isArray(keywords) || keywords.length === 0) {
    throw new Error("linkedin-keywords.json is empty or invalid");
  }
  return keywords.map(normalize).filter(Boolean);
}

function getFeedUrls() {
  const fromEnv = (process.env.LINKEDIN_FEEDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_FEEDS;
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function readState() {
  const data = readJson(STATE_FILE, { bootstrapped: false, seen: [] });
  const stats = data.stats && typeof data.stats === "object" ? data.stats : {};
  return {
    bootstrapped: Boolean(data.bootstrapped),
    seen: Array.isArray(data.seen) ? data.seen : [],
    stats: {
      date: typeof stats.date === "string" ? stats.date : "",
      cyclesToday: Number(stats.cyclesToday || 0),
      matchedToday: Number(stats.matchedToday || 0),
      sentToday: Number(stats.sentToday || 0),
      lastSummaryDate: typeof stats.lastSummaryDate === "string" ? stats.lastSummaryDate : ""
    }
  };
}

function trimSeen(seen) {
  return seen.length > MAX_SEEN ? seen.slice(-MAX_SEEN) : seen;
}

function writeState(state) {
  writeJson(STATE_FILE, {
    bootstrapped: Boolean(state.bootstrapped),
    seen: trimSeen(state.seen || []),
    stats: state.stats || {}
  });
}

function getLocalDateKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function rollStatsDate(stats) {
  const today = getLocalDateKey();
  if (stats.date !== today) {
    return {
      ...stats,
      date: today,
      cyclesToday: 0,
      matchedToday: 0,
      sentToday: 0
    };
  }
  return stats;
}

function getItemKey(item) {
  return item.guid || item.link;
}

function getItemText(item) {
  return normalize([item.title, item.contentSnippet, item.content].filter(Boolean).join(" "));
}

function getPublishedDate(item) {
  const raw = item.isoDate || item.pubDate;
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function isWithinAge(item, maxAgeHours) {
  const publishedDate = getPublishedDate(item);
  if (!publishedDate) return false;
  const ageMs = Date.now() - publishedDate.getTime();
  return ageMs >= 0 && ageMs <= maxAgeHours * 60 * 60 * 1000;
}

function isRemote(itemText) {
  const remoteTerms = [
    "remote",
    "work from home",
    "wfh",
    "anywhere",
    "distributed"
  ];
  return remoteTerms.some((term) => itemText.includes(term));
}

function detectType(itemText, link) {
  const l = (link || "").toLowerCase();
  if (l.includes("/jobs/")) return "job";
  if (l.includes("/posts/") || l.includes("/feed/update")) return "post";
  if (itemText.includes("hiring")) return "hiring-post";
  return "linkedin-item";
}

function getMatchedKeywords(itemText, keywords) {
  return keywords.filter((k) => itemText.includes(k));
}

function isMatch(item, keywords, options) {
  const text = getItemText(item);
  const matchedKeywords = getMatchedKeywords(text, keywords);

  if (matchedKeywords.length === 0) return { ok: false, text, matchedKeywords };
  if (options.requireRemote && !isRemote(text)) return { ok: false, text, matchedKeywords };
  if (!isWithinAge(item, options.maxPostAgeHours)) return { ok: false, text, matchedKeywords };

  return { ok: true, text, matchedKeywords };
}

function formatMessage(item, matchedKeywords, itemType) {
  const title = item.title || "LinkedIn Opportunity";
  const summary = (item.contentSnippet || item.content || "").replace(/\s+/g, " ").trim().slice(0, 250);
  const published = item.pubDate || item.isoDate || "Unknown time";

  return [
    "LinkedIn Hiring Alert",
    "",
    `Type: ${itemType}`,
    `Title: ${title}`,
    summary ? `Summary: ${summary}` : null,
    `Matched: ${matchedKeywords.join(", ")}`,
    `Published: ${published}`,
    `Link: ${item.link}`
  ].filter(Boolean).join("\n");
}

async function sendTelegram(message) {
  if (process.env.DRY_RUN === "1") return true;

  const token = (process.env.BOT_TOKEN || "").trim();
  const groupId = (process.env.GROUP_ID || "").trim();

  if (!token || !groupId) {
    throw new Error("BOT_TOKEN or GROUP_ID missing in .env");
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await axios.post(url, {
        chat_id: groupId,
        text: message,
        disable_web_page_preview: true
      }, { timeout: 15000 });
      return true;
    } catch (err) {
      const retryAfter = err.response?.data?.parameters?.retry_after;
      if (err.response?.status === 429 && retryAfter) {
        await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      } else if (attempt === 3) {
        console.log("Telegram send failed:", err.response?.data || err.message);
        return false;
      }
    }
  }

  return false;
}

async function maybeSendStartupPing() {
  const enabled = parseBoolean(process.env.STARTUP_PING, true);
  if (!enabled || process.env.DRY_RUN === "1") return;
  const text =
    process.env.STARTUP_PING_TEXT ||
    "LinkedIn notifier is live. Monitoring remote LinkedIn jobs/posts with your keyword filters.";
  await sendTelegram(text);
}

async function maybeSendDailySummary(state) {
  const enabled = parseBoolean(process.env.DAILY_SUMMARY, true);
  if (!enabled || process.env.DRY_RUN === "1") return;

  const hour = Number(process.env.SUMMARY_HOUR || 22);
  const minute = Number(process.env.SUMMARY_MINUTE || 0);
  const now = new Date();
  const today = getLocalDateKey();

  if (state.stats.lastSummaryDate === today) return;
  if (now.getHours() < hour) return;
  if (now.getHours() === hour && now.getMinutes() < minute) return;

  const msg = [
    "LinkedIn Daily Summary",
    `Date: ${today}`,
    `Cycles run: ${state.stats.cyclesToday}`,
    `Matched items: ${state.stats.matchedToday}`,
    `Alerts sent: ${state.stats.sentToday}`
  ].join("\n");

  const ok = await sendTelegram(msg);
  if (ok) {
    state.stats.lastSummaryDate = today;
    writeState(state);
  }
}

async function fetchFeedItems(feedUrls) {
  const results = await Promise.allSettled(feedUrls.map((url) => parser.parseURL(url)));
  const items = [];

  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const source = feedUrls[i];

    if (result.status === "fulfilled") {
      const feedItems = result.value.items || [];
      feedItems.forEach((item) => items.push({ ...item, sourceFeed: source }));
      console.log(`Feed OK: ${feedItems.length} from ${source}`);
    } else {
      console.log(`Feed failed: ${source} -> ${result.reason?.message || result.reason}`);
    }
  }

  return items;
}

async function runCycle() {
  const keywords = getKeywords();
  const feeds = getFeedUrls();
  const state = readState();
  state.stats = rollStatsDate(state.stats);
  const seenSet = new Set(state.seen);
  const requireRemote = parseBoolean(process.env.REQUIRE_REMOTE, true);
  const maxPostAgeHours = Number(process.env.MAX_POST_AGE_HOURS || DEFAULT_MAX_POST_AGE_HOURS) || DEFAULT_MAX_POST_AGE_HOURS;
  const maxAlertsPerCycle = Number(process.env.MAX_ALERTS_PER_CYCLE || DEFAULT_MAX_ALERTS_PER_CYCLE) || DEFAULT_MAX_ALERTS_PER_CYCLE;

  console.log(`Checking feeds at ${new Date().toISOString()} | remote=${requireRemote} | maxAgeHours=${maxPostAgeHours}`);

  const [rssItems, linkedinJobItems] = await Promise.all([
    fetchFeedItems(feeds),
    fetchLinkedinJobSearchItems()
  ]);
  const items = [...rssItems, ...linkedinJobItems];
  const sorted = items
    .filter((item) => item.link)
    .sort((a, b) => new Date(b.pubDate || b.isoDate || 0) - new Date(a.pubDate || a.isoDate || 0));

  if (!state.bootstrapped) {
    const keys = [...new Set(sorted.map(getItemKey).filter(Boolean))];
    writeState({ bootstrapped: true, seen: keys });
    console.log(`Bootstrapped with ${keys.length} existing items. Alerts start next cycle.`);
    return;
  }

  let sent = 0;
  const newSeen = [...state.seen];
  const stats = {
    total: sorted.length,
    seen: 0,
    keywordMiss: 0,
    remoteMiss: 0,
    ageMiss: 0,
    matched: 0
  };

  for (const item of sorted) {
    const key = getItemKey(item);
    if (!key || seenSet.has(key)) {
      stats.seen += 1;
      continue;
    }
    const matchResult = isMatch(item, keywords, { requireRemote, maxPostAgeHours });
    if (!matchResult.ok) {
      const text = matchResult.text || "";
      if (matchResult.matchedKeywords.length === 0) {
        stats.keywordMiss += 1;
      } else if (requireRemote && !isRemote(text)) {
        stats.remoteMiss += 1;
      } else {
        stats.ageMiss += 1;
      }
      continue;
    }
    stats.matched += 1;

    const itemType = detectType(matchResult.text, item.link);
    const message = formatMessage(item, matchResult.matchedKeywords, itemType);

    if (process.env.DRY_RUN === "1") {
      console.log(`DRY_RUN alert [${itemType}]:`, item.title);
      sent += 1;
      seenSet.add(key);
      newSeen.push(key);
      if (sent >= maxAlertsPerCycle) break;
      continue;
    }

    const ok = await sendTelegram(message);
    if (ok) {
      sent += 1;
      seenSet.add(key);
      newSeen.push(key);
      if (sent >= maxAlertsPerCycle) break;
    }

    await new Promise((r) => setTimeout(r, 1200));
  }

  state.stats.cyclesToday += 1;
  state.stats.matchedToday += stats.matched;
  state.stats.sentToday += sent;

  writeState({ bootstrapped: true, seen: newSeen, stats: state.stats });
  await maybeSendDailySummary({ bootstrapped: true, seen: newSeen, stats: state.stats });
  console.log(
    `Cycle stats: total=${stats.total}, seen=${stats.seen}, keywordMiss=${stats.keywordMiss}, remoteMiss=${stats.remoteMiss}, ageMiss=${stats.ageMiss}, matched=${stats.matched}, sent=${sent}`
  );
  console.log(sent ? `Sent ${sent} alert(s).` : "No new matched alerts.");
}

async function start() {
  const pollSeconds = Number(process.env.LINKEDIN_POLL_SECONDS || DEFAULT_POLL_SECONDS) || DEFAULT_POLL_SECONDS;
  await maybeSendStartupPing();
  await runCycle();
  if (process.env.RUN_ONCE === "1") return;
  setInterval(() => runCycle().catch((e) => console.log("Cycle error:", e.message)), pollSeconds * 1000);
  console.log(`Notifier running. Poll every ${pollSeconds}s.`);
}

start().catch((err) => {
  console.error("Startup error:", err.message);
  process.exit(1);
});
