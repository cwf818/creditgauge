// Kimi user plugin for topgauge. POST {scope:["FEATURE_CODING"]}
// → usages[] entry with resetTime + limits[] + totalQuota. Maps:
//   intervals.short ← usages.limits[0].detail  (intervalMs = window.duration MINUTES × 60s × 1000)
//   intervals.mid   ← usages.detail            (intervalMs = 7d, fixed — primary weekly cycle)
//   intervals.long  ← totalQuota.remaining     (percent only — no startAt/endAt/intervalMs available)
//
// ABI: default export is { fetchAccountCredit(authenticationKey, ctx) },
// same shape as the built-in minimax / deepseek plugins. The host runs
// ensureQuota on the returned Partial<Quota> to derive the canonical
// shape. The plugin author never sees canonical Quota / Interval.
//
// AUTHENTICATION_KEY: the Kimi dashboard's localStorage `access_token`
// (the one issued after browser login at https://kimi.com), NOT the
// API token under Settings. Configure it via providers.kimi.AUTHENTICATION_KEY
// in ~/.claude/plugins/topgauge/config.json. The plugin sends it as
// `Authorization: Bearer <key>` against the GetUsages endpoint.
//
// Auth note: the GetUsages endpoint is the same gRPC-over-HTTP the
// browser dashboard hits, so the localStorage access_token is the
// only credential Kimi accepts. If you log out / refresh from the
// browser, copy the new access_token out of localStorage and paste
// it back into config.json — the cache row `kimi:pluginSource` does
// not gate on credential validity, so a stale token shows up as a
// silent `Remain: --:…` placeholder until the renderer falls back.

const ENDPOINT =
  "https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages";
// Fixed 1-week interval for the primary cycle (midInterval). Kimi's
// `usages.detail` only ships resetTime, not the cycle length — the
// spec says it covers a 7-day rolling window.
const MID_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))
    return Number(v);
  return null;
}
function epochMs(iso) {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// Pick the FEATURE_CODING scope out of usages[]. Kimi's quota
// response may include other scopes (chat / research / etc) — we
// only render the coding one, matching the user's
// ANTHROPIC_BASE_URL=https://api.kimi.com/coding/ context.
function findCodingUsage(raw) {
  const usages = Array.isArray(raw?.usages) ? raw.usages : [];
  return usages.find((u) => isRecord(u) && u.scope === "FEATURE_CODING") ?? null;
}

// shortInterval ← usages.limits[0].detail. The rolling sub-window's
// length is `window.duration` expressed in MINUTES (`timeUnit`
// "TIME_UNIT_MINUTE"); multiply by 60×1000 to land on intervalMs.
// resetTime is the only time anchor Kimi ships — back-derive
// startAt = resetAt - intervalMs so the window-fill-aware reset
// arrow gets a direction.
function shortInterval(usage) {
  const limits = Array.isArray(usage?.limits) ? usage.limits : [];
  const first = limits[0];
  if (!isRecord(first)) return null;
  const detail = first.detail;
  const window = first.window;
  if (!isRecord(detail) || !isRecord(window)) return null;
  const remainingPct = asNumber(detail.remaining);
  const resetAt = epochMs(detail.resetTime);
  if (remainingPct == null || resetAt == null) return null;
  const minutes = asNumber(window.duration);
  if (minutes == null) return null;
  const intervalMs = minutes * 60 * 1000;
  return {
    windowId: "5h",
    label: "5h",
    startAt: resetAt - intervalMs,
    endAt: resetAt,
    intervalMs,
    remainingPercent: remainingPct,
    usedPercent: 100 - remainingPct,
    remainingQuota: asNumber(detail.remaining),
    usedQuota: null,
    limitQuota: asNumber(detail.limit),
  };
}

// midInterval ← usages.detail. The primary 7-day cycle — Kimi only
// ships resetTime (not startTime), so we back-derive startAt
// against a fixed 7-day window. The intervalMs is not derivable
// from the payload; the spec treats it as a known 1-week constant.
function midInterval(usage) {
  const detail = usage?.detail;
  if (!isRecord(detail)) return null;
  const remainingPct = asNumber(detail.remaining);
  const resetAt = epochMs(detail.resetTime);
  if (remainingPct == null || resetAt == null) return null;
  return {
    windowId: "7d",
    label: "7d",
    startAt: resetAt - MID_INTERVAL_MS,
    endAt: resetAt,
    intervalMs: MID_INTERVAL_MS,
    remainingPercent: remainingPct,
    usedPercent: 100 - remainingPct,
    remainingQuota: asNumber(detail.remaining),
    usedQuota: asNumber(detail.used),
    limitQuota: asNumber(detail.limit),
  };
}

// longInterval ← totalQuota.remaining. Only the percentage is
// derivable — Kimi doesn't ship a resetTime / cycle anchor for the
// total quota, so startAt / endAt / intervalMs are all null.
// ensureInterval's "fewer than 2 non-null time fields" rule then
// collapses the time group to nulls, and the renderer falls back
// to its interval-less placeholder path.
function longInterval(raw) {
  const tq = raw?.totalQuota;
  if (!isRecord(tq)) return null;
  // totalQuota fields are percentages (used: "8", remaining: "92",
  // limit: "100" → 8% used, 92% remaining). They aren't complements
  // of each other — Kimi ships used and remaining as independent
  // percentages of the same denominator.
  const remainingPct = asNumber(tq.remaining);
  if (remainingPct == null) return null;
  return {
    windowId: "30d",
    label: "30d",
    startAt: null,
    endAt: null,
    intervalMs: null,
    remainingPercent: remainingPct,
    usedPercent: asNumber(tq.used),
    remainingQuota: remainingPct,
    usedQuota: asNumber(tq.used),
    limitQuota: asNumber(tq.limit),
  };
}

function fillQuota(raw) {
  const usage = findCodingUsage(raw);
  if (!usage) return null;
  // v0.9.5 — open-ended intervals dict returned directly (the
  // v0.9.4 `intervals: { … }` wrapper was dropped per the new-
  // feature hard-cut convention). The three reserved keys
  // (`short` / `mid` / `long`) keep the v0.9.x contract; arbitrary
  // additional windows can be added by including them here and
  // referencing them from `m_windowQuota|term|<key>` in the template.
  return {
    short: shortInterval(usage),
    mid: midInterval(usage),
    long: longInterval(raw),
  };
}

export default {
  async fetchAccountCredit(authenticationKey, ctx) {
    if (!authenticationKey) return null;
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal: ctx?.signal,
      headers: {
        Authorization: `Bearer ${authenticationKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ scope: ["FEATURE_CODING"] }),
    });
    if (!response.ok)
      throw new Error(`kimi GetUsages HTTP ${response.status}`);
    const raw = JSON.parse(await response.text());
    return fillQuota(raw);
  },
};

// Named exports for unit tests. The host loader only ever consumes
// `default`; these let kimi.test.ts pin the fill contract.
export {
  ENDPOINT,
  MID_INTERVAL_MS,
  fillQuota,
  shortInterval,
  midInterval,
  longInterval,
  findCodingUsage,
};
