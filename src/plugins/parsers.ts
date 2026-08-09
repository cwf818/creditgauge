// Pure normalizers used by built-in dynamic plugins + the host's post-fetch
// step. Plugins return whatever shape they projected; the host runs
// ensureQuota / ensureBalance / ensureInterval here so plugin authors never
// need the canonical Quota / Balance types. No host-side path-walker exists —
// plugins do their own parsing.

import type { Balance, BalanceEntry, Interval, Quota } from "./data.js";

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// v0.9.4 — the `intervals` dict is the source of truth. Three reserved
// keys ("short" / "mid" / "long") ship with the historical
// windowId defaults (5h / 7d / 30d) so existing plugin authors and
// the built-in plugins keep working without renaming; the dict is
// otherwise OPEN — a plugin may declare any additional key (e.g.
// "monthly" / "yearly" / "weekday-peak") and reference it via
// `m_windowQuota|term|<key>`. The `all` key is reserved by the
// renderer's parseWindowScope sentinel and is never valid as a
// dict key.
const RESERVED_INTERVAL_KEYS = ["short", "mid", "long"] as const;
type ReservedIntervalKey = (typeof RESERVED_INTERVAL_KEYS)[number];

// v0.9.4 — built-in windowId defaults for the three reserved keys.
// Mirrors the historical v0.4.x "5h / 7d / 30d" defaults so existing
// plugin authors don't have to set `windowId` explicitly when they
// already use the canonical reserved names.
const RESERVED_DEFAULT_WINDOW_IDS: Record<ReservedIntervalKey, string> = {
  short: "5h",
  mid:   "7d",
  long:  "30d",
};

function isReservedIntervalKey(key: string): key is ReservedIntervalKey {
  return (RESERVED_INTERVAL_KEYS as readonly string[]).includes(key);
}

function ensureTimeGroup(value: Record<string, unknown>): {
  startAt: number | null;
  endAt: number | null;
  intervalMs: number | null;
} {
  const startRaw = asNumber(value.startAt);
  const endRaw = asNumber(value.endAt);
  const intervalRaw = asNumber(value.intervalMs);
  const nonNullCount = (startRaw != null ? 1 : 0)
    + (endRaw != null ? 1 : 0)
    + (intervalRaw != null ? 1 : 0);
  if (nonNullCount < 2) {
    return { startAt: null, endAt: null, intervalMs: null };
  }

  let startAt = startRaw;
  let endAt = endRaw;
  if (startAt != null && endAt != null) {
    return { startAt, endAt, intervalMs: intervalRaw ?? (endAt - startAt) };
  }
  if (startAt != null && intervalRaw != null) {
    endAt = startAt + intervalRaw;
    return { startAt, endAt, intervalMs: intervalRaw };
  }
  if (endAt != null && intervalRaw != null) {
    startAt = endAt - intervalRaw;
    return { startAt, endAt, intervalMs: intervalRaw };
  }
  return { startAt: null, endAt: null, intervalMs: null };
}

// Normalize a single Interval payload. `key` is the dict key the
// interval sits under (e.g. "short" / "mid" / "long" / "monthly");
// the reserved-key default windowId is only consulted when the
// payload itself doesn't ship one. Non-reserved keys with no
// explicit windowId fall back to the key name verbatim, so
// `intervals: { monthly: { … } }` produces `windowId: "monthly"`.
export function ensureInterval(
  value: unknown,
  key: string,
): Interval | null {
  if (!isRecord(value)) return null;
  const remainingRaw = asNumber(value.remainingPercent);
  const usedRaw = asNumber(value.usedPercent);
  const remainingPercent = usedRaw != null ? 100 - usedRaw : remainingRaw;
  const usedPercent = usedRaw != null ? usedRaw : (
    remainingRaw != null ? 100 - remainingRaw : null
  );
  const time = ensureTimeGroup(value);
  const fallback = isReservedIntervalKey(key)
    ? RESERVED_DEFAULT_WINDOW_IDS[key]
    : key;
  const windowId = typeof value.windowId === "string" ? value.windowId : fallback;
  const label = typeof value.label === "string"
    ? value.label
    : (typeof value.windowId === "string" ? value.windowId : fallback);

  return {
    windowId,
    label,
    startAt: time.startAt,
    endAt: time.endAt,
    intervalMs: time.intervalMs,
    remainingPercent,
    usedPercent,
    remainingQuota: asNumber(value.remainingQuota),
    usedQuota: asNumber(value.usedQuota),
    limitQuota: asNumber(value.limitQuota),
  };
}

// Accept the open dict shape `{ short, mid, long, <any> }` directly from the
// plugin (the old `{ intervals: { … } }` wrapper is gone). `all` is rejected
// as a dict key — it's reserved by parseWindowScope's no-time-anchor sentinel
// and accepting it would shadow the m_sum*|window|all short-circuit.
export function ensureQuota(value: unknown): Quota | null {
  if (!isRecord(value)) return null;
  const out: Record<string, Interval | null> = {};

  for (const [k, v] of Object.entries(value)) {
    if (k === "all") continue;
    out[k] = v == null ? null : ensureInterval(v, k);
  }

  // Always seed the three reserved keys so the renderer never has
  // to special-case the "key absent from dict" path (it can read
  // `ctx.intervals[term]` and treat `undefined`/`null` identically
  // as "no data"). Pre-existing entries are preserved verbatim.
  for (const reserved of RESERVED_INTERVAL_KEYS) {
    if (!(reserved in out)) out[reserved] = null;
  }

  return { intervals: out };
}

// Host normalizer: applies the is_available fallback (missing → optimistic
// true), derives minValue, and is the ONLY place the canonical Balance shape
// is produced (the plugin projects raw → Partial<Balance>). Returns null when
// `value` is not a record. minValue isn't used for color anymore (per-entry
// 5-band drives hue); kept for downstream plugins / introspection.
export function ensureBalance(value: unknown): Balance | null {
  if (!value || typeof value !== "object") return null;
  const partial = value as { isAvailable?: boolean; entries?: BalanceEntry[] };
  const entries = Array.isArray(partial.entries) ? partial.entries : [];
  const isAvailable = partial.isAvailable ?? true;

  if (!isAvailable) {
    return {
      isAvailable: false,
      entries,
      minValue: entries.length === 0
        ? null
        : Math.min(...entries.map((e) => e.totalBalance)),
    };
  }

  let minValue: number | null = null;
  if (entries.length > 0) {
    minValue = entries[0].totalBalance;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].totalBalance < minValue) minValue = entries[i].totalBalance;
    }
  }

  return { isAvailable: true, entries, minValue };
}