// Pure-validator helpers used by built-in dynamic plugins + the
// host's post-fetch normalisation step.
//
// Plugins return whatever shape their `fillQuota` / `fillBalance`
// decided to project from the raw response. The host runs the
// canonical normalisers (`ensureQuota` / `ensureBalance` /
// `ensureInterval`) here so the plugin author never has to know
// about the canonical Quota / Balance types — only their fill
// contract + the ctx argument (signal).
//
// v0.9.x — the path-expression projection layer
// (`parseQuota` / `parseBalance` / `path-expr.ts`) was REMOVED.
// Plugin authors do their own parsing and ship canonical objects
// directly; there's no host-side path-walker left to configure.

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

// v0.9.5 — accept the open-ended dict shape `{ short, mid, long,
// <any> }` directly from the plugin. The legacy v0.9.4 wrapper
// `{ intervals: { … } }` and the v0.9.x fixed-slot fields
// `{ shortInterval, midInterval, longInterval }` are both gone
// (hard cut per the v0.9.x new-feature convention; plugin authors
// upgraded to v0.9.4 already return the wrapper, so the upgrade is
// a single-line removal). The `all` reserved key is rejected as a
// dict key (reserved by parseWindowScope's no-time-anchor sentinel
// — accepting it would silently shadow the m_sum*|window|all
// short-circuit).
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

// Apply the is_available fallback contract (missing → optimistic
// true), derive `minValue` over the surviving entries, and guard the
// final shape. The plugin layer is responsible for projecting
// `raw → Partial<Balance>`; this function is the host's normaliser
// and is the ONLY place the canonical `Balance` shape is produced.
//
// Returns null when `value` is not a record.
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