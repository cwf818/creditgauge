// GitHub Copilot built-in plugin. Plain ESM JS — same shape as a
// user-written plugin at ~/.claude/plugins/topgauge/query_plugins/<id>/.
//
// ABI: default export is { fetchAccountCredit(authenticationKey, ctx) },
// where `ctx` exposes { signal, intervals, currencies }. The returned
// object is a Partial<Quota> (host runs `ensureQuota` on it to produce
// the canonical Quota shape). The plugin author never sees the
// canonical Quota / Interval types — only the fill contract + the
// `ctx` argument.
//
// Source endpoint (v0.8.47+):
//   POST /usage  on http://localhost:4141  (the copilot-proxy
//   sidecar that's already running on the user's machine).
// Response shape (raw):
//   { quota_snapshots: { premium_interactions: { percent_remaining,
//                                                quota_remaining,
//                                                entitlement } } }
//
// All Copilot spend flows through the natural-month window — there
// is no short/mid term available. We project premium_interactions
// onto the canonical reserved `long` slot, and let `short` / `mid`
// resolve to null (the renderer drops them on a Copilot-only
// display). `startAt` / `endAt` are computed from the call clock
// as natural-month boundaries (start of this month → start of next
// month, local time) so the renderer can draw a window-fill-aware
// reset arrow.

const ENDPOINT = "http://localhost:4141/usage";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

// Natural-month boundaries for `nowMs`. Local time (matches what
// most billing dashboards show) — start of this month 00:00:00 →
// start of next month 00:00:00. Returns null when `nowMs` is not
// a finite epoch (defensive: callers always pass Date.now()).
function naturalMonthBounds(nowMs) {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return null;
  const d = new Date(nowMs);
  if (Number.isNaN(d.getTime())) return null;
  // Anchor to the user's local zone — Date(year, month, day)
  // constructs in local time, so month boundaries resolve here
  // without an explicit TZ argument.
  const startAt = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
  const endAt = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
  return { startAt, endAt };
}

// Raw → Partial<Quota>. Only the reserved `long` slot is filled;
// `short` / `mid` stay null and the renderer drops them on a
// Copilot-only display. Returns null when the response is missing
// the premium_interactions block — that's the soft-fail signal the
// host surfaces as "not available".
function fillQuota(raw, nowMs) {
  if (!isRecord(raw)) return null;
  const snapshots = raw.quota_snapshots;
  if (!isRecord(snapshots)) return null;
  const premium = snapshots.premium_interactions;
  if (!isRecord(premium)) return null;

  const remainingPercent = asNumber(premium.percent_remaining);
  const remainingQuota = asNumber(premium.quota_remaining);
  const limitQuota = asNumber(premium.entitlement);

  const bounds = naturalMonthBounds(nowMs);

  return {
    short: null,
    mid: null,
    long: {
      // windowId / label resolution lives in `ensureInterval`: with
      // both fields absent it falls back to the canonical
      // "30d" label — the user's `providers.copilot.intervals.
      // long.label` config override still wins on top of
      // that. We don't bake a label in here so providers (and
      // users) keep full control.
      remainingPercent,
      remainingQuota,
      limitQuota,
      ...(bounds ?? {}),
    },
  };
}

export default {
  async fetchAccountCredit(authenticationKey, ctx) {
    // Copilot's proxy sidecar is on localhost and is implicit
    // authenticated by IP — no Bearer token required. We still
    // accept `authenticationKey` for symmetry with other plugins
    // (downstream routers may want to forward it as a header).
    const headers = { Accept: "application/json" };
    if (authenticationKey) headers.Authorization = `Bearer ${authenticationKey}`;
    const response = await fetch(ENDPOINT, {
      method: "GET",
      signal: ctx?.signal,
      headers,
    });
    if (!response.ok) throw new Error(`copilot usage HTTP ${response.status}`);
    const raw = JSON.parse(await response.text());
    return fillQuota(raw, Date.now());
  },
};

// Named exports for unit tests. The host loader only ever consumes
// `default`; these let copilot.test.ts pin the contract.
export { ENDPOINT, fillQuota, naturalMonthBounds };
