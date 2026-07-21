// opencode.ai creditgauge plugin — fetch-based (no Playwright)
//
// Scrapes the workspace page for usage quotas using plain HTTP fetch + cookies.
// Maps the three usage cards:
//   "Rolling Usage" → short  (3h rolling window, resets in ~hours)
//   "Weekly Usage"  → mid    (7d window)
//   "Monthly Usage" → long   (30d window)
//
// AUTHENTICATION_KEY: The opencode.ai workspace ID (e.g. "wrk_xxxxxxxxxxxxxxxxxxxxxxxxxx").
// The plugin derives everything from this single value:
//   - Session-cookie file: ~/.claude/plugins/creditgauge/credentials/opencode/<id>.session-cookies.json
//   - Workspace URL:        https://opencode.ai/workspace/<id>/go
//
// Configure via providers.opencode in config.json:
//
//   "opencode": {
//     "TYPE": "QUOTA",
//     "BASE_URL_COMPARED_TO": "https://opencode.ai",
//     "COMPARE_METHOD": "STARTWITH",
//     "AUTHENTICATION_KEY": "wrk_xxxxxxxxxxxxxxxxxxxxxxxxxx"
//   }
//
// No WORKSPACE_URL needed — the plugin builds it from AUTHENTICATION_KEY.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------- constants ----------

const CREDENTIALS_DIR = join(
  homedir(),
  ".claude", "plugins", "creditgauge", "credentials", "opencode"
);
const WORKSPACE_ORIGIN = "https://opencode.ai";

// ---------- helpers ----------

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))
    return Number(v);
  return null;
}

function cookiePathForWorkspace(workspaceId) {
  return `${CREDENTIALS_DIR}/${workspaceId}.session-cookies.json`;
}

function workspaceUrlFor(workspaceId) {
  return `${WORKSPACE_ORIGIN}/workspace/${workspaceId}/go`;
}

/**
 * Parse a human-readable reset duration like:
 *   "2 hours 54 minutes"
 *   "1 day 8 hours"
 *   "29 days 21 hours"
 * Returns milliseconds.
 */
function parseDuration(str) {
  if (!str || typeof str !== "string") return null;
  const s = str.toLowerCase().trim();
  const parts = {};

  // Match English: "2 hours", "54 minutes", "1 day", "3h", "1d"
  const re = /(\d+)\s*(days?|hours?|minutes?|min|h|d)\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const raw = m[2];
    const key =
      raw === "d" || raw === "day" || raw === "days"
        ? "day"
        : raw === "h" || raw === "hour" || raw === "hours"
          ? "hour"
          : raw === "min" || raw === "minute" || raw === "minutes"
            ? "minute"
            : raw;
    parts[key] = parseInt(m[1], 10);
  }

  // Match Chinese: "2 小时", "54 分钟", "1 天"
  const reZh = /(\d+)\s*(天|小时|分钟|分)/g;
  while ((m = reZh.exec(s)) !== null) {
    const unit = m[2];
    if (unit === "天") parts["day"] = parseInt(m[1], 10);
    else if (unit === "小时") parts["hour"] = parseInt(m[1], 10);
    else if (unit === "分钟" || unit === "分") parts["minute"] = parseInt(m[1], 10);
  }

  let totalMs = 0;
  if (parts["day"]) totalMs += parts["day"] * 86400000;
  if (parts["hour"]) totalMs += parts["hour"] * 3600000;
  if (parts["minute"]) totalMs += parts["minute"] * 60000;
  return totalMs || null;
}

// ---------- HTTP fetching ----------

/**
 * Build a Cookie header string from a cookie JSON file (Playwright format).
 */
function buildCookieHeader(cookiePath) {
  if (!cookiePath || !existsSync(cookiePath)) return "";
  const cookies = JSON.parse(readFileSync(cookiePath, "utf-8"));
  // Only include cookies for opencode.ai domain
  const relevant = cookies.filter(
    (c) => c.domain === "opencode.ai" || c.domain.endsWith(".opencode.ai")
  );
  return relevant.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Fetch the workspace page HTML using plain HTTP with cookies.
 * @param {string} url - the workspace URL
 * @param {string} cookiePath - path to .session-cookies.json
 * @param {object} [ctx] - { signal?: AbortSignal }
 */
async function fetchPageHtml(url, cookiePath, ctx) {
  const cookieHeader = buildCookieHeader(cookiePath);

  const response = await fetch(url, {
    headers: {
      Cookie: cookieHeader,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: ctx?.signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.text();
}

// ---------- HTML parsing ----------

/**
 * Parse usage data from the server-rendered HTML.
 * Extracts the three usage cards (Rolling, Weekly, Monthly).
 *
 * Returns an array of { label, percent, resetText } matching the
 * original Playwright scraper's output format, or null on failure.
 */
function parseUsageCards(html) {
  // Find all usage-item blocks in the rendered HTML
  const itemRegex =
    /<div[^>]*data-slot="usage-item"[^>]*>[\s\S]*?<\/div>\s*<!--\/-->/g;
  const blocks = html.match(itemRegex);

  if (!blocks || blocks.length === 0) return null;

  const cards = [];

  for (const block of blocks) {
    // Strip HTML comments first (Qwik uses <!--$--> / <!--/--> markers)
    const clean = block.replace(/<!--[\s\S]*?-->/g, "");

    // Extract label
    const labelMatch = clean.match(
      /data-slot="usage-label"[^>]*>\s*([^<]+?)\s*<\//,
    );
    if (!labelMatch) continue;
    const label = labelMatch[1].trim();

    // Extract percent value from usage-value
    const valueMatch = clean.match(
      /data-slot="usage-value"[^>]*>[\s\S]*?([\d.]+)[\s\S]*?%\s*<\//,
    );
    const percent = valueMatch ? parseFloat(valueMatch[1]) : null;

    // Extract reset time text (after stripping comments)
    const resetMatch = clean.match(
      /data-slot="reset-time"[^>]*>\s*([^<]+?)\s*<\//,
    );
    const resetText = resetMatch ? resetMatch[1].trim() : "";

    cards.push({ label, percent, resetText });
  }

  return cards.length > 0 ? cards : null;
}

// ---------- page scraping (fetch-based) ----------

/**
 * Scrape the opencode.ai workspace page using HTTP fetch + cookies.
 * @param {string} workspaceUrl - e.g. "https://opencode.ai/workspace/wrk_xxx/go"
 * @param {string} cookiePath - path to .session-cookies.json
 * @param {object} [ctx] - { signal?: AbortSignal }
 */
async function scrapeWorkspace(workspaceUrl, cookiePath, ctx) {
  const html = await fetchPageHtml(workspaceUrl, cookiePath, ctx);
  const cards = parseUsageCards(html);
  return cards;
}

// ---------- interval builders ----------

const SHORT_INTERVAL_MS = 5 * 60 * 60 * 1000; // 5 hours
const MID_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LONG_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function buildShort(card) {
  if (!card || card.percent == null) return null;
  const usedPct = card.percent;
  const resetMs = parseDuration(card.resetText);
  if (resetMs == null) return null;

  const now = Date.now();
  const endAt = now + resetMs;
  const startAt = endAt - SHORT_INTERVAL_MS;

  return {
    windowId: "5h",
    label: "5h",
    startAt,
    endAt,
    intervalMs: SHORT_INTERVAL_MS,
    remainingPercent: 100 - usedPct,
    usedPercent: usedPct,
    remainingQuota: null,
    usedQuota: null,
    limitQuota: null,
  };
}

function buildMid(card) {
  if (!card || card.percent == null) return null;
  const usedPct = card.percent;
  const resetMs = parseDuration(card.resetText);
  if (resetMs == null) return null;

  const now = Date.now();
  const endAt = now + resetMs;
  const startAt = endAt - MID_INTERVAL_MS;

  return {
    windowId: "7d",
    label: "7d",
    startAt,
    endAt,
    intervalMs: MID_INTERVAL_MS,
    remainingPercent: 100 - usedPct,
    usedPercent: usedPct,
    remainingQuota: null,
    usedQuota: null,
    limitQuota: null,
  };
}

function buildLong(card) {
  if (!card || card.percent == null) return null;
  const usedPct = card.percent;
  const resetMs = parseDuration(card.resetText);
  if (resetMs == null) return null;

  const now = Date.now();
  const endAt = now + resetMs;
  const startAt = endAt - LONG_INTERVAL_MS;

  return {
    windowId: "30d",
    label: "30d",
    startAt,
    endAt,
    intervalMs: LONG_INTERVAL_MS,
    remainingPercent: 100 - usedPct,
    usedPercent: usedPct,
    remainingQuota: null,
    usedQuota: null,
    limitQuota: null,
  };
}

// ---------- label matching ----------

function findCard(cards, labelKey) {
  if (!Array.isArray(cards)) return null;
  return cards.find(
    (c) => c && c.label && c.label.trim().toLowerCase() === labelKey,
  );
}

function fillQuota(cards) {
  const shortCard = findCard(cards, "rolling usage");
  const midCard = findCard(cards, "weekly usage");
  const longCard = findCard(cards, "monthly usage");
  return {
    short: buildShort(shortCard),
    mid: buildMid(midCard),
    long: buildLong(longCard),
  };
}

// ---------- public API ----------

export default {
  /**
   * @param {string} authenticationKey - opencode.ai workspace ID (e.g. "wrk_xxxxxxxxxxxxxxxxxxxxxxxxxx")
   * @param {object} [ctx] - { signal?: AbortSignal }
   * @returns {Promise<object|null>} { short, mid, long } or null
   */
  async fetchAccountCredit(authenticationKey, ctx) {
    if (!authenticationKey) return null;
    const workspaceUrl = workspaceUrlFor(authenticationKey);
    const cookiePath = cookiePathForWorkspace(authenticationKey);
    const cards = await scrapeWorkspace(workspaceUrl, cookiePath, ctx);
    if (!cards || cards.length === 0) return null;
    return fillQuota(cards);
  },
};

// Named exports for unit testing
export {
  SHORT_INTERVAL_MS,
  MID_INTERVAL_MS,
  LONG_INTERVAL_MS,
  fillQuota,
  buildShort,
  buildMid,
  buildLong,
  parseDuration,
  findCard,
  scrapeWorkspace,
};
