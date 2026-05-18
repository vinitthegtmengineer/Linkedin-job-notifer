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

// Countries to exclude from job alerts
const EXCLUDED_COUNTRIES = ["bangladesh", "pakistan", "kenya"];

// Job title patterns to exclude (not related to your skills)
const EXCLUDED_TITLE_PATTERNS = [
  /sem\s*campaign/i,
  /seo\s*campaign/i,
  /search\s*engine\s*marketing/i,
  /search\s*engine\s*optimization/i,
  /ppc\s*manager/i,
  /paid\s*search/i,
  /google\s*ads/i,
  /facebook\s*ads/i,
  /paid\s*social/i,
  /social\s*media\s*manager/,
  /content\s*writer/,
  /copywriter/,
  /content\s*marketing/,
  // Exclude all Director-level titles
  /^\s*director\s+/i,
  /\s+director\s+/i,
  // Exclude all Head-level titles
  /^\s*head\s+of\s+/i,
  /\s+head\s+of\s+/i,
  // Exclude VP, VP of, Vice President
  /^\s*vp\s+/i,
  /\s+vp\s+/i,
  /vice\s+president/i,
  // Exclude other senior titles
  /^\s*chief/i,
  /^\s*sVP\s+/i,
  /^\s*evp\s+/i,
  // Exclude Founding GTM Engineer and GTM Director
  /founding\s+gtm\s*engineer/i,
  /gtm\s+director/i
];

// Google News RSS query groups for LinkedIn posts
const RSS_QUERY_GROUPS = [
  "(%22clay.com%22+OR+%22clay+gtm%22+OR+%22clay+automation%22+OR+%22clay+workflows%22+OR+%22clay+operator%22+OR+%22clay+specialist%22+OR+%22clay+consultant%22+OR+%22clay+expert%22+OR+%22clay+builder%22)",
  "(%22gtm+engineer%22+OR+%22go+to+market+engineer%22+OR+%22growth+operations+engineer%22)",
  "(%22campaign+executive%22+OR+%22campaign+manager%22+OR+%22marketing+operations%22)",
  "(%22cold+email%22+OR+%22outbound+sales%22+OR+%22sdr%22+OR+%22bdr%22+OR+%22sales+development%22+OR+%22lead+generation%22)",
  "(%22growth+outreach+specialist%22+OR+%22outreach+specialist%22)",
  "(%22account+executive%22+OR+%22sales+development+representative%22)"
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
  "growth operations engineer",
  "gtm",
  "campaign executive",
  "campaign manager",
  "marketing operations",
  "cold email",
  "outbound sales",
  "bdr",
  "lead generation",
  "growth outreach specialist",
  "outreach specialist",
  "account executive",
  "sales development representative"
];

// Only fetch LinkedIn POSTS that contain explicit hiring phrases alongside the role keywords
const DEFAULT_RSS_FEEDS = RSS_QUERY_GROUPS.flatMap((q, idx) => {
  // Group 0 = clay terms, Group 1 = gtm engineer terms, Group 2 = marketing ops
  // Add extra broader hiring search for gtm/marketing groups to catch more posts
  if (idx === 0) {
    return [`https://news.google.com/rss/search?q=site:linkedin.com/posts+(%22we+are+hiring%22+OR+%22we%27re+hiring%22+OR+%22now+hiring%22+OR+%22job+opening%22+OR+%22open+role%22+OR+%22open+position%22+OR+%22apply+now%22+OR+%22join+our+team%22+OR+%22careers+page%22+OR+%22check+out+our+open+roles%22+OR+%22hiring+specialists%22+OR+%22hiring+experts%22)+${q}+when:2d&hl=en&gl=US&ceid=US:en`];
  }
  // For gtm engineer and marketing ops, add a broader "hiring" search too
  return [
    `https://news.google.com/rss/search?q=site:linkedin.com/posts+(%22we+are+hiring%22+OR+%22we%27re+hiring%22+OR+%22now+hiring%22+OR+%22job+opening%22+OR+%22open+role%22+OR+%22open+position%22+OR+%22apply+now%22+OR+%22join+our+team%22+OR+%22careers+page%22+OR+%22check+out+our+open+roles%22)+${q}+when:2d&hl=en&gl=US&ceid=US:en`,
    // Extra broad search: just "hiring" + keywords, longer timeframe
    `https://news.google.com/rss/search?q=site:linkedin.com/posts+(hiring)+${q}+when:3d&hl=en&gl=US&ceid=US:en`
  ];
});

// Hiring intent words — RSS items must contain at least one of these to be sent
const HIRING_INTENT = [
  "we are hiring", "we're hiring", "now hiring", "job opening", "open role",
  "open position", "apply now", "join our team", "looking to hire",
  "seeking a", "seeking an", "we need a", "we need an", "hiring a", "hiring an",
  "recruiting", "job opportunity", "career opportunity", "#hiring", "hiring ",
  "careers page", "check out our open roles", "hiring specialists", "hiring experts",
  "hiring GTM", "hiring marketing", "hiring for", "hiring GTM engineer",
  "hiring hubspot", "hiring revops", "full time", "full-time"
];

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
        // Debug: log ALL extracted URLs (not just successful ones)
        if (items.length < 10 && !linkedinUrl) {
          console.log(`RSS no URL: title="${(item.title || "").slice(0, 40)}" | link="${(item.link || "").slice(0, 50)}"`);
        }
        if (!linkedinUrl) continue; // skip if we can't get a real LinkedIn URL

        // Debug: log raw RSS items before filtering
        if (items.length < 5) {
          console.log(`RSS raw: ${linkedinUrl.slice(0, 50)} | ${(item.title || "").slice(0, 40)}`);
        }

        // Only keep posts that contain actual hiring intent
        const itemText = normalize(
          [item.title, item.contentSnippet, item.content, item.summary].filter(Boolean).join(" ")
        );
        const hasHiringIntent = HIRING_INTENT.some((phrase) => itemText.includes(phrase));
        if (!hasHiringIntent) {
          // console.log(`RSS skip (no hiring intent): ${(item.title || "").slice(0, 60)}`);
          continue;
        }

        // Debug: log first few RSS items after filtering
        if (items.length < 5) {
          console.log(`RSS item (passed): ${linkedinUrl.slice(0, 50)}`);
        }
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

function isWithinAge(item, maxAgeHours, source) {
  // RSS posts skip age check since Google News already filters by time in query
  const isRss = source && source.startsWith('http');
  if (isRss) return true;

  const raw = item.isoDate || item.pubDate;
  if (!raw) return true; // allow if no date
  const d = new Date(raw);
  if (isNaN(d.getTime())) return true; // allow if unparseable
  const ageMs = Date.now() - d.getTime();
  return ageMs >= 0 && ageMs <= maxAgeHours * 3600 * 1000;
}

function isExcludedLocation(item) {
  const location = normalize(item.contentSnippet || "");
  return EXCLUDED_COUNTRIES.some((country) => location.includes(country));
}

function isExcludedTitle(item) {
  const title = item.title || "";
  return EXCLUDED_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

// Check if a LinkedIn Jobs API job is truly remote
function isRemoteJob(item) {
  const location = normalize(item.contentSnippet || "");
  const title = normalize(item.title || "");

  // If title explicitly says remote, treat as remote
  if (/\bremote\b/.test(title)) return true;

  // If location explicitly indicates remote, treat as remote
  const remoteLocationIndicators = [
    /\bremote\b/i,
    /\bworldwide\b/i,
    /\banywhere\b/i,
    /\bglobal\b/i,
    /\bEU\b/i,
    /\beurope\b/i,
    /\bUK\b/i,
    /\bUnited Kingdom\b/i,
    /\bUSA?\s*wide\b/i,
    /\bnationwide\b/i
  ];
  if (remoteLocationIndicators.some(ind => ind.test(location))) return true;

  // Trust LinkedIn's f_WT=2 filter — if it came through, accept it
  return true;
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
  // Always use clean URL (no tracking params, normalised to www.linkedin.com)
  const cleanLink = urlKey(item.link);

  return [
    "LinkedIn Hiring Alert",
    "",
    `Type: ${type}`,
    `Title: ${title}`,
    company ? `Company: ${company}` : null,
    summary ? `Details: ${summary}` : null,
    `Keywords: ${matchedKeywords.join(", ")}`,
    `Link: ${cleanLink}`
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

  // Fetch LinkedIn Jobs API only (RSS disabled for cleaner remote filtering)
  const [rssItems, jobItems] = await Promise.all([
    Promise.resolve([]), // disabled
    fetchLinkedinJobs()
  ]);

  const allItems = [...jobItems];
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

  // Debug: count RSS vs Jobs and show first few URLs
  let rssCount = 0;
  let jobCount = 0;
  let sampleRss = [];
  let sampleJobs = [];
  for (const [uk, item] of uniqueByUrl) {
    const isRss = item.sourceFeed && item.sourceFeed.startsWith('http');
    if (isRss) {
      rssCount++;
      if (sampleRss.length < 3) sampleRss.push({ url: uk.slice(0, 60), source: item.sourceFeed?.slice(0, 40) });
    } else {
      jobCount++;
      if (sampleJobs.length < 3) sampleJobs.push({ url: uk.slice(0, 60), source: item.sourceFeed });
    }
  }
  console.log(`RSS posts: ${rssCount}, Jobs: ${jobCount}`);
  console.log(`Sample RSS:`, JSON.stringify(sampleRss));
  console.log(`Sample Jobs:`, JSON.stringify(sampleJobs));

  let sent = 0;
  let skippedSeen = 0;
  let skippedKeyword = 0;
  let skippedAge = 0;
  let skippedCountry = 0;
  let skippedTitlePattern = 0;
  let skippedTitle = 0;

  for (const [uk, item] of uniqueByUrl) {
    if (sent >= maxAlertsPerCycle) break;

    // Skip if URL already seen
    if (state.seen[uk]) {
      skippedSeen++;
      continue;
    }

    // Age check (pass source to give RSS more lenient window)
    const itemIsRss = item.sourceFeed && item.sourceFeed.startsWith('http');
    if (!isWithinAge(item, maxPostAgeHours, item.sourceFeed)) {
      // Debug: log RSS items that fail age check
      if (itemIsRss) {
        console.log(`RSS age skip: ${(item.title || "").slice(0, 50)} | date: ${item.isoDate || item.pubDate || 'none'}`);
      }
      skippedAge++;
      state.seen[uk] = 1;
      continue;
    }

    // Use the itemIsRss computed earlier

    // Location exclusion check - skip for RSS posts since location info is unreliable
    if (!itemIsRss && isExcludedLocation(item)) {
      skippedCountry++;
      state.seen[uk] = 1;
      continue;
    }

    // Title exclusion check (SEM, SEO, etc.) - skip for RSS posts
    if (!itemIsRss && isExcludedTitle(item)) {
      skippedTitlePattern++;
      state.seen[uk] = 1;
      continue;
    }

    // Remote check - skip onsite/hybrid jobs from LinkedIn Jobs API
    if (!itemIsRss && !isRemoteJob(item)) {
      skippedCountry++;
      state.seen[uk] = 1;
      continue;
    }

    // Keyword match - RSS items skip this since query already has keywords
    let matched = [];
    if (!itemIsRss) {
      // Only filter Jobs by keywords, not RSS posts
      matched = matchesKeywords(item, keywords);
      if (matched.length === 0) {
        skippedKeyword++;
        state.seen[uk] = 1;
        continue;
      }
    } else {
      // For RSS posts, use a default matched keyword since query already has keywords
      matched = ['RSS hiring post'];
    }

    // Title+company dedup (catches Sr./Senior/Lead variants)
    const tk = titleKey(item);
    if (state.sentTitles[tk]) {
      if (itemIsRss) {
        console.log(`RSS title dup skip: "${item.title}"`);
      }
      skippedTitle++;
      state.seen[uk] = 1;
      continue;
    }

    // Send alert
    const message = formatMessage(item, matched);
    if (itemIsRss) {
      console.log(`RSS SENDING: "${item.title}" | company: "${item.company || 'none'}" | key: "${tk}"`);
    }
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

  console.log(`Done: sent=${sent}, skipped(seen=${skippedSeen}, keyword=${skippedKeyword}, age=${skippedAge}, country=${skippedCountry}, titlePattern=${skippedTitlePattern}, titleDup=${skippedTitle})`);

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
