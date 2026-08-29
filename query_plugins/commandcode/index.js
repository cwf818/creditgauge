// CommandCode user plugin for creditgauge. Plain ESM JS — same ABI as the
// built-in minimax / deepseek plugins and the sibling user plugins
// (opencode / kimi / bigmodel / copilot-api).
//
// Endpoints (GET):
//   https://api.commandcode.ai/internal/billing/credits
//   https://api.commandcode.ai/internal/billing/subscriptions
//   Cookie: <session cookies from auth.cjs>
//
// Raw response shapes (verified 2026-08-26):
//   credits:
//   {
//     credits: { belowThreshold, creditThreshold, monthlyCredits,
//                purchasedCredits, premiumMonthlyCredits, opensourceMonthlyCredits },
//     windowLimits: {
//       limited: boolean,
//       exceeded: null,
//       fiveHour: { used, cap, exceeded, resetAt },   // resetAt = epoch ms
//       weekly:   { used, cap, exceeded, resetAt },
//     },
//   }
//   subscriptions: { success, data: { …currentPeriodStart, currentPeriodEnd,
//                                     planId, status, … } }
//
// Projection:
//   intervals.short  ← windowLimits.fiveHour (5h rolling window)
//   intervals.mid    ← windowLimits.weekly   (7d rolling window)
//   intervals.long   ← subscriptions.data → plan-aware monthly window:
//                       limitQuota     = planId → QUOTA_LIMIT_BY_PLAN
//                       usedQuota      = limitQuota − credits.monthlyCredits
//                       usedPercent    = usedQuota / limitQuota
//                       remainingQuota = credits.monthlyCredits
//                       startAt/endAt  = currentPeriodStart/currentPeriodEnd
//   AUTHENTICATION_KEY is the dashboard account slug ("cwf81881rl") — the
//   plugin derives the usage page URL + session-cookie path from it, and
//   forwards it to both billing endpoints (which require it).
//
// Auth: the account uses the same save-cookie flow as opencode. Run
//   npx creditgauge plugin auth commandcode
// which opens a headed Chromium (Playwright), lets you log in at
//   https://commandcode.ai/<slug>/settings/usage
// and persists the session cookies to
//   ~/.claude/plugins/creditgauge/credentials/commandcode/<slug>.session-cookies.json

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------- constants ----------

const CREDENTIALS_DIR = join(
  homedir(),
  ".claude", "plugins", "creditgauge", "credentials", "commandcode"
);
/** 统一认证文件: { provider, id, savedAt, cookies } — 由 `plugin auth` 写入 */
const AUTH_FILE = join(CREDENTIALS_DIR, "auth.json");
const BILLING_ENDPOINT = "https://api.commandcode.ai/internal/billing/credits";
const SUBSCRIPTIONS_ENDPOINT = "https://api.commandcode.ai/internal/billing/subscriptions";
const USAGE_PAGE_TPL = "https://commandcode.ai/%s/settings/usage";

// Fixed windows — CommandCode's rolling limits are the same 5h / 7d cadence
// as the MiniMax plan; intervalMs is a known constant per slot (the API only
// ships resetAt, not the cycle length — same approach as the kimi plugin's
// midIntervalMs / bigmodel's SHORT_INTERVAL_MS).
const SHORT_INTERVAL_MS = 5 * 60 * 60 * 1000;  // 5h
const MID_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

// planId → monthly quota limit (credits per subscription period). Assigned
// from the CommandCode pricing ladder; individual-go is the free tier.
const QUOTA_LIMIT_BY_PLAN = {
  "individual-go": 10,
  "individual-goat": 70,
  "individual-pro": 80,
  "individual-max10": 150,
  "individual-max20": 300,
};

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

function asEpochMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// Round to at most 2 decimal places — keeps quota output compact while
// preserving integer caps and 0/100 boundaries exactly.
function round2(v) {
  return Math.round(v * 100) / 100;
}

function cookiePathForAccount(accountId) {
  return `${CREDENTIALS_DIR}/${accountId}.session-cookies.json`;
}

function usagePageUrlFor(accountId) {
  return USAGE_PAGE_TPL.replace("%s", accountId);
}

/**
 * 读取统一认证文件 credentials/commandcode/auth.json。
 * 返回 { id, cookies } 或 null。ID 与 Cookie 由认证工具一次性写入,
 * 插件无需再从 config.json 的 AUTHENTICATION_KEY 推断。
 */
function loadAuthFile() {
  try {
    if (!existsSync(AUTH_FILE)) return null;
    const raw = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "") return null;
    if (!Array.isArray(raw.cookies)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Build a Cookie header string from a cookie array (Playwright format).
 * Only cookies whose domain is commandcode.ai or a subdomain of it are kept.
 */
function buildCookieHeaderFromCookies(cookies) {
  if (!Array.isArray(cookies)) return "";
  const relevant = cookies.filter(
    (c) => c.domain === "commandcode.ai" || c.domain.endsWith(".commandcode.ai")
  );
  return relevant.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Build a Cookie header string from a Playwright-format cookie JSON file.
 * Kept for backwards compatibility with older <id>.session-cookies.json files.
 */
function buildCookieHeader(cookiePath) {
  if (!cookiePath || !existsSync(cookiePath)) return "";
  const cookies = JSON.parse(readFileSync(cookiePath, "utf-8"));
  return buildCookieHeaderFromCookies(cookies);
}

// ---------- interval builders ----------

// Rolling 5h window. used / cap / resetAt all present → full quota axis.
// usedPercent = used / cap * 100, remainingPercent = 100 - usedPercent.
function buildShort(wl) {
  if (!isRecord(wl)) return null;
  const used = asNumber(wl.used);
  const cap = asNumber(wl.cap);
  const resetAt = asNumber(wl.resetAt);
  if (used == null || cap == null || resetAt == null) return null;
  const usedPct = (used / cap) * 100;
  return {
    windowId: "5h",
    label: "5h",
    startAt: resetAt - SHORT_INTERVAL_MS,
    endAt: resetAt,
    intervalMs: SHORT_INTERVAL_MS,
    remainingPercent: round2(100 - usedPct),
    usedPercent: round2(usedPct),
    remainingQuota: round2(cap - used),
    usedQuota: round2(used),
    limitQuota: round2(cap),
  };
}

// Rolling 7d window — mirror of buildShort with the weekly cadence.
function buildMid(wl) {
  if (!isRecord(wl)) return null;
  const used = asNumber(wl.used);
  const cap = asNumber(wl.cap);
  const resetAt = asNumber(wl.resetAt);
  if (used == null || cap == null || resetAt == null) return null;
  const usedPct = (used / cap) * 100;
  return {
    windowId: "7d",
    label: "7d",
    startAt: resetAt - MID_INTERVAL_MS,
    endAt: resetAt,
    intervalMs: MID_INTERVAL_MS,
    remainingPercent: round2(100 - usedPct),
    usedPercent: round2(usedPct),
    remainingQuota: round2(cap - used),
    usedQuota: round2(used),
    limitQuota: round2(cap),
  };
}

// Plan-aware 30d monthly window, fed from the subscriptions payload. The
// monthly quota limit comes from the planId → QUOTA_LIMIT_BY_PLAN ladder;
// usage is the quota consumed this period (limit − remaining credits), so
// the percent axis is real (unlike the old credit-balance-only long slot).
// currentPeriodEnd anchors the reset time.
function buildLong(subData, credits) {
  if (!isRecord(subData) || !isRecord(credits)) return null;
  const planId = subData.planId;
  const limit = QUOTA_LIMIT_BY_PLAN[planId];
  const monthly = asNumber(credits.monthlyCredits);
  const endAt = asEpochMs(subData.currentPeriodEnd);
  if (limit == null || monthly == null || endAt == null) return null;
  const startAt = asEpochMs(subData.currentPeriodStart);
  const used = limit - monthly;
  const usedPct = (used / limit) * 100;
  return {
    windowId: "30d",
    label: "30d",
    startAt: startAt ?? null,
    endAt,
    intervalMs: endAt - startAt,
    remainingPercent: round2(100 - usedPct),
    usedPercent: round2(usedPct),
    remainingQuota: round2(monthly),
    usedQuota: round2(used),
    limitQuota: limit,
  };
}

// ---------- fill ----------

function fillQuota(raw) {
  if (!isRecord(raw)) return null;
  const wl = raw.windowLimits;
  const credits = raw.credits;
  const subData = raw.subscriptionData;
  if (!isRecord(wl) || !isRecord(credits) || !isRecord(subData)) return null;
  // soft-fail on any missing sub-object — the whole projection is void.
  if (!isRecord(wl.fiveHour) || !isRecord(wl.weekly)) return null;
  return {
    short: buildShort(wl.fiveHour),
    mid: buildMid(wl.weekly),
    long: buildLong(subData, credits),
  };
}

// ---------- public API ----------

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json",
};

/**
 * GET a billing endpoint, returning the parsed JSON. Throws on network /
 * HTTP / JSON failure so a missing subscription (e.g. plan not in the
 * ladder) never yields a partial quota.
 */
async function getJson(url, cookieHeader, signal) {
  const response = await fetch(url, {
    headers: { Cookie: cookieHeader, ...DEFAULT_HEADERS },
    signal,
  });
  if (!response.ok) throw new Error(`commandcode ${url} HTTP ${response.status}`);
  return JSON.parse(await response.text());
}

export default {
  /**
   * @param {string} [authenticationKey] — CommandCode dashboard account slug
   *   (e.g. "cwf81881rl"). 可选: 优先读取 auth.json 中的 id + cookies;
   *   仅在 auth.json 不存在时回退到 authenticationKey 定位旧 cookie 文件。
   * @param {object} [ctx] - { signal?: AbortSignal }
   * @returns {Promise<object|null>} { short, mid, long } or null
   */
  async fetchAccountCredit(authenticationKey, ctx) {
    const auth = loadAuthFile();
    let accountId = authenticationKey || null;
    let cookieHeader = "";

    if (auth) {
      accountId = auth.id || accountId;
      cookieHeader = buildCookieHeaderFromCookies(auth.cookies);
    }
    // 兼容旧文件: <id>.session-cookies.json
    if (!cookieHeader && accountId) {
      cookieHeader = buildCookieHeader(cookiePathForAccount(accountId));
    }

    if (cookieHeader === "") {
      throw new Error(
        `no session cookies found for commandcode — run: npx creditgauge plugin auth commandcode`,
      );
    }
    const [creditsRaw, subRaw] = await Promise.all([
      getJson(BILLING_ENDPOINT, cookieHeader, ctx?.signal),
      getJson(SUBSCRIPTIONS_ENDPOINT, cookieHeader, ctx?.signal),
    ]);
    const raw = {
      credits: creditsRaw.credits,
      windowLimits: creditsRaw.windowLimits,
      subscriptionData: subRaw?.data ?? null,
    };
    return fillQuota(raw);
  },
};

// Named exports for unit tests. The host loader only ever consumes
// `default`; these let commandcode.test.ts pin the fill contract.
export {
  SHORT_INTERVAL_MS,
  MID_INTERVAL_MS,
  USAGE_PAGE_TPL,
  BILLING_ENDPOINT,
  SUBSCRIPTIONS_ENDPOINT,
  QUOTA_LIMIT_BY_PLAN,
  buildShort,
  buildMid,
  buildLong,
  fillQuota,
  loadAuthFile,
  buildCookieHeaderFromCookies,
};
