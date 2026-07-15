// BigModel (智谱) user plugin for topgauge. Plain ESM JS — same shape
// as the built-in minimax / deepseek plugins and the user-side kimi
// plugin under ~/.claude/plugins/topgauge/query_plugins/<id>/.
//
// ABI: default export is { fetchAccountCredit(authenticationKey, ctx) },
// where `ctx` exposes { signal }. The returned object is a
// Partial<Quota> (host runs `ensureQuota` on it to produce the
// canonical Quota shape). The plugin author never has to know about
// the canonical Quota / Interval types — only the fill contract + the
// ctx argument.
//
// Source endpoint:
//   GET https://bigmodel.cn/api/monitor/usage/quota/limit
//   Authorization: Bearer <apiKey>
//   Content-Type: application/json
// Response shape (raw):
//   { success: boolean, data: { level: string, limits: Array<{
//     type: "TOKENS_LIMIT" | "TIME_LIMIT",
//     percentage?: number,        // used% (0..100), only on TOKENS_LIMIT
//     nextResetTime?: number,     // epoch ms, on both types
//     remaining?: number,         // remaining quota units, TIME_LIMIT only
//     currentValue?: number,      // used quota units, TIME_LIMIT only
//     usage?: number,             // limit quota units, TIME_LIMIT only
//     ...
//   }> }, msg?: string }
//
// The API client may also return `response.success === false` with
// a `msg` — that case surfaces as a soft fail (fillQuota returns null,
// host falls back to the stale cache row).

// An experimental implementation version by AI, referring to
// https://github.com/farion1231/cc-switch/issues/1588#issuecomment-4233258553
// Should be verified by a valid BigModel account with a valid API key.
//
// --- Registration (user-defined provider, not in DEFAULT_PROVIDERS) ---
//
// bigmodel is not bundled as a built-in (lives alongside kimi /
// copilot-api). To wire it up, add an entry to the providers block
// in ~/.claude/plugins/topgauge/config.json:
//
//   "providers": {
//     "bigmodel": {
//       "TYPE": "QUOTA",
//       "BASE_URL_COMPARED_TO": "https://bigmodel.cn/api/anthropic",
//       "COMPARE_METHOD": "INCLUDE",
//       "config": {}
//     }
//   }
//
// Then set:
//   ANTHROPIC_BASE_URL=https://bigmodel.cn/api/anthropic
//   ANTHROPIC_AUTH_TOKEN=<your bigmodel apiKey>
//
// and the plugin at ~/.claude/plugins/topgauge/query_plugins/bigmodel/
// index.js (this file) will be picked up — the loader resolves
// query_plugins/<id>/index.js BEFORE the bundled built-in tree, so
// pluginSource renders as 🎨 (labelPluginUserDefined). To swap in a
// custom bigmodel plugin, just overwrite this file; no config change
// needed.

const ENDPOINT = "https://bigmodel.cn/api/monitor/usage/quota/limit";
// Fixed 5h / 7d windows for the two TOKENS_LIMIT slots. The BigModel
// API only ships nextResetTime (not the cycle length), so the interval
// length is a known constant per slot — same approach as the kimi
// plugin's midIntervalMs constant.
const SHORT_INTERVAL_MS = 5 * 60 * 60 * 1000; // 5h
const MID_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))
    return Number(v);
  return null;
}

// Build a canonical-style Interval from a TOKENS_LIMIT entry. The
// percentage field is used% (0..100) per the reference extractor in
// CLAUDE.md — usedPercent = percentage, remainingPercent =
// 100 - percentage. nextResetTime is the only time anchor; back-
// derive startAt = nextResetTime - intervalMs so the renderer can
// pick a window-fill-aware reset arrow.
function tokensLimitInterval(entry, intervalMs, fallbackWindowId, fallbackLabel) {
  if (!isRecord(entry)) return null;
  const usedPct = asNumber(entry.percentage);
  const resetAt = asNumber(entry.nextResetTime);
  if (usedPct == null || resetAt == null) return null;
  return {
    windowId: fallbackWindowId,
    label: fallbackLabel,
    startAt: resetAt - intervalMs,
    endAt: resetAt,
    intervalMs,
    usedPercent: usedPct,
    remainingPercent: 100 - usedPct,
    usedQuota: null,
    remainingQuota: null,
    limitQuota: null,
  };
}

// Build a canonical-style Interval from a TIME_LIMIT entry. The three
// quota fields (remaining / currentValue / usage) carry absolute unit
// counts (the reference extractor renders this with unit="次"). We
// surface them on remainingQuota / usedQuota / limitQuota so the
// m_windowQuota renderer can pick a unit-absolute display, and leave
// the percent fields null since TIME_LIMIT doesn't ship a percentage.
function timeLimitInterval(entry, fallbackWindowId, fallbackLabel) {
  if (!isRecord(entry)) return null;
  const remaining = asNumber(entry.remaining);
  const used = asNumber(entry.currentValue);
  const limit = asNumber(entry.usage);
  const resetAt = asNumber(entry.nextResetTime);
  if (remaining == null && used == null && limit == null) return null;
  // Mirror the kimi convention: only set the time group when the
  // payload ships a reset timestamp. BigModel's TIME_LIMIT is the
  // monthly MCP quota — the cycle is a calendar month, but we don't
  // know which calendar month without a clock-side back-derivation.
  // Skip the start/end fields entirely when nextResetTime is absent
  // so ensureTimeGroup's "fewer than 2 non-null time fields" rule
  // drops them all to null.
  const time = resetAt != null
    ? { startAt: resetAt, endAt: null, intervalMs: null }
    : { startAt: null, endAt: null, intervalMs: null };
  return {
    windowId: fallbackWindowId,
    label: fallbackLabel,
    ...time,
    usedPercent: null,
    remainingPercent: null,
    remainingQuota: remaining,
    usedQuota: used,
    limitQuota: limit,
  };
}

// Raw → Partial<Quota>. Splits `data.limits[]` by `type`:
//   - TOKENS_LIMIT  → first one (sorted by nextResetTime asc) is the
//                     5h slot, second one (when present) is the 7d slot.
//   - TIME_LIMIT    → MCP monthly quota, projects onto `long`.
// Returns null when `response.success === false` or `data.limits` is
// missing/empty — that's the soft-fail signal the host surfaces as
// "not available".
function fillQuota(raw) {
  if (!isRecord(raw)) return null;
  if (raw.success === false) return null;
  const data = raw.data;
  if (!isRecord(data)) return null;
  const limits = Array.isArray(data.limits) ? data.limits : [];
  // Soft-fail when the payload carries no usable quota entries —
  // matches the kimi plugin's `findCodingUsage === null → null`
  // contract so the host falls back to the stale cache row instead
  // of rendering a "no data" line. An empty limits array after a
  // successful response is unusual but legitimate (account has no
  // plan / suspended) and we treat it the same way.
  if (limits.length === 0) return null;

  // Stable sort by nextResetTime ASC so the "first" entry is the one
  // due to reset soonest — matches the reference extractor's
  // `tokenLimits.sort((a, b) => a.nextResetTime - b.nextResetTime)`.
  const tokensLimits = limits
    .filter((l) => isRecord(l) && l.type === "TOKENS_LIMIT")
    .slice()
    .sort((a, b) => {
      const ar = asNumber(a.nextResetTime) ?? Number.POSITIVE_INFINITY;
      const br = asNumber(b.nextResetTime) ?? Number.POSITIVE_INFINITY;
      return ar - br;
    });
  const timeLimits = limits.find((l) => isRecord(l) && l.type === "TIME_LIMIT");

  return {
    short: tokensLimitInterval(tokensLimits[0], SHORT_INTERVAL_MS, "5h", "5h"),
    mid: tokensLimitInterval(tokensLimits[1], MID_INTERVAL_MS, "7d", "7d"),
    long: timeLimitInterval(timeLimits, "monthly", "MCP"),
  };
}

export default {
  async fetchAccountCredit(authenticationKey, ctx) {
    if (!authenticationKey) return null;
    const response = await fetch(ENDPOINT, {
      method: "GET",
      signal: ctx?.signal,
      headers: {
        Authorization: authenticationKey.startsWith("Bearer ")
          ? authenticationKey
          : `Bearer ${authenticationKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    if (!response.ok)
      throw new Error(`bigmodel quota HTTP ${response.status}`);
    const raw = JSON.parse(await response.text());
    return fillQuota(raw);
  },
};

// Named exports for unit tests. The host loader only ever consumes
// `default`; these let bigmodel.test.ts pin the fill contract.
export {
  ENDPOINT,
  SHORT_INTERVAL_MS,
  MID_INTERVAL_MS,
  fillQuota,
  tokensLimitInterval,
  timeLimitInterval,
};