// Pure rendering helpers: split-bar (left colorless / right colored),
// 5-band thresholds, ANSI coloring, and line assembly.
//
// All tunable values (colors, thresholds, bar geometry, currency
// prefixes, display-mode labels, stale annotation formatting) come
// from the singleton in ./config.ts. The defaults in config.ts match
// today's hardcoded values exactly.
//
// v0.2.17: the line layout is now driven by a `lineTemplate` config
// field — an ordered list of display-module tokens (m_modeLabel,
// m_window5h, m_countdown5h, m_window7d, m_countdown7d, m_balance,
// m_age, m_version) and separator references (s_0, s_1, …). New
// code should call `renderProviderLine` directly with the open-ended
// `intervals` dict shape (v0.9.4) so non-reserved terms aren't
// dropped on the floor.

import { configStore, warn } from "./config.ts";
import { providerTypeFor } from "./providers.ts";
import * as diagnostics from "./diagnostics.ts";
import {
  getDeltaForRender,
  peekLastSpeed,
  peekLastApiMs,
  peekLastTokenHitRate,
  peekAvg,
  type AvgSnapshot,
  type PrevTickSnapshot,
} from "./status-store.ts";
import type { TokenSnapshot } from "./types.ts";
import {
  buildRainbow,
  buildHue,
  parseFreq,
  pickQuoteEntry,
  pickQuoteEntryFiltered,
  quoteIndex,
  truncateQuote,
  type QuoteFreq,
} from "./quotes.ts";
import { readGitInfo } from "./git-info.ts";
import * as statusStore from "./status-store.ts";
import * as cache from "./cache.ts";
// v0.8.17+ — m_memUsage data source. Darwin shells out to
// `vm_stat` for active+wired pages; other platforms fall back to
// os.totalmem() - os.freemem().
import * as os from "node:os";
import { execSync } from "node:child_process";
export type { PrevTickSnapshot, AvgSnapshot };

type Window = {
  // Percentage USED in [0, 100]. May be fractional; we'll round.
  pct: number;
  // ISO timestamp string when the window resets, if known.
  resetAt?: string | null;
  // ISO timestamp string for when the current window STARTED. Paired with
  // resetAt so we can compute the window's total duration and pick a
  // fill-state-appropriate reset arrow (⏳ when plenty of time remains,
  // ⌛ when the window is mostly consumed). Optional — DeepSeek has no
  // such concept, so missing fields fall back to the legacy single-arrow.
  resetStartAt?: string | null;
  // Window length in milliseconds (resetAt - resetStartAt). Optional;
  // required for the split-arrow logic, falls back to a single arrow when
  // missing. Kept as a separate field so callers don't have to re-parse the
  // ISO strings inside hot render paths.
  resetDurationMs?: number | null;
};

// v0.9.x — unified interval shape. Replaces the v0.5.0–v0.8.x
// pair-of-Windows model (`Quota.fiveHour` / `Quota.weekly`) with
// three independent intervals. v0.9.4 — those three slots collapse
// into a single open-ended `intervals` dict
// (`Record<string, Interval|null>`); the three reserved keys
// ("short" / "mid" / "long") ship with the historical windowId
// defaults (5h / 7d / 30d) so existing renders stay byte-identical
// after upgrade. The fields are populated by the plugin's
// `fillQuota` and normalised by `ensureInterval` in
// src/plugins/parsers.ts. The renderer (m_windowQuota / m_countdown /
// m_quota) reads these fields directly. `Window` (above) is still the
// shape `formatOneChunk` and `formatOneResetSuffix` consume;
// `intervalToWindow` (below) projects an `Interval` → `Window` when
// the gauge / countdown rendering path needs to fire.
export type Interval = {
  // Built-in defaults: shortInterval → "5h", midInterval → "7d",
  // longInterval → "30d". Configurable via `intervals.<key>.windowId`.
  //
  // vX.X.X — `windowId` is now `string`, not the v0.9.0 closed
  // union "5h" | "7d" | "30d", because user-supplied `intervals.*.
  // windowId` values flow through to runtime Intervals verbatim
  // (config.ts auto-prefixes digit-leading values with `w` so they
  // can never be mistaken for a parseable dhms string, but
  // otherwise any string identifier is allowed). Field is purely
  // a label — the renderer reads `iv.label` (defaulting to the
  // same value) for display, NOT `iv.windowId`, so widening has
  // no observable effect on existing renders.
  windowId: string;
  // Built-in default: same as windowId. Configurable via
  // `intervals.<key>.label`. The renderer reads this to print the
  // window's display label (e.g. "5h" in `quota(5h):123/500`).
  label: string;
  // Epoch ms when the window started, or null if unknown.
  startAt: number | null;
  // Epoch ms when the window resets, or null if unknown.
  endAt: number | null;
  // Window length in ms (derived endAt - startAt when both are
  // present and the user didn't supply intervalMs directly). Used
  // by the renderer's fill-state arrow picker. Null when neither
  // startAt nor endAt nor intervalMs is available.
  intervalMs: number | null;
  // [0, 100] — at least one of {remainingPercent, usedPercent}
  // is always non-null after ensureInterval. The two are
  // mirror-derived when only one is mapped.
  remainingPercent: number | null;
  usedPercent: number | null;
  // Quota group — integer units (no normalization). Any subset of
  // {remainingQuota, usedQuota, limitQuota} may be present; the
  // renderer (`m_quota`) decides what's enough to render.
  remainingQuota: number | null;
  usedQuota: number | null;
  limitQuota: number | null;
};

type DisplayMode = "remaining" | "used";

// v0.9.0+ — interval-term selector used by m_windowQuota / m_countdown /
// m_quota. v0.9.4 — the `intervals` dict is open, so the term is no
// longer a closed union; it can be any string the plugin declared.
// TERM_PARAM accepts the byte-for-byte inline resolver behaviour
// — the renderer reads `ctx.intervals[term]` for ANY string, so
// passing e.g. `m_windowQuota|term|monthly` just works
// (placeholder when the key is missing).

// Shorthand for the active config snapshot. Reading configStore.get()
// on every call would be wasteful for hot paths (every
// renderProviderLine call does many color/band lookups) — the helpers
// below read it lazily.
function cfg() {
  return configStore.get();
}

// v0.8.22+ — top-level token-label resolver. Each call reads
// configStore (same lazy-read pattern as `cfg()`) and returns the
// configured prefix for the requested axis. v0.8.22 unified all
// label names under the `labelToken*` / `labelApi*` namespace so
// a user who overrides one family member (e.g. `labelTokenIn`)
// sees the rename propagate consistently to every module that
// reads the same semantic axis (`m_tokenIn` / `m_accTokenIn` /
// `m_sumTokenIn`):
//   "in"        → cfg().labels.labelTokenIn
//   "out"       → cfg().labels.labelTokenOut
//   "cacheIn"   → cfg().labels.labelTokenCachedIn
//   "totalIn"   → cfg().labels.labelTokenTotalIn
//   "inSpeed"   → cfg().labels.labelTokenInSpeed
//   "outSpeed"  → cfg().labels.labelTokenOutSpeed
//   "apiMs"     → cfg().labels.labelApiMs
//   "apiCalls"  → cfg().labels.labelApiCalls
//   "memUsage"  → cfg().labels.labelMemUsage
//   "hitRate"   → cfg().labels.labelTokenHitRate (v0.8.22+; was
//                  hardcoded "hit:" before — see `src/render.ts`
//                  m_tokenHitRate / m_accTokenHitRate /
//                  m_sumTokenHitRate)
//
// Defaults reproduce the v0.8.x literal strings ("in:" / "out:"
// / "cache:" / "Total:" / "api:" / "calls:" / "hit:" / "Mem:")
// so existing line templates render byte-identical until the user
// overrides `labels.*` in config.json. Speed defaults are
// intentionally independent of the corresponding in/out token-
// axis defaults so a user who renames `labelTokenIn` for the
// token-axis family can keep the speed axis reading as
// "in:12.3 t/s" (or override it independently).
type LabelAxis =
  | "in" | "out" | "cacheIn" | "totalIn"
  | "inSpeed" | "outSpeed" | "apiMs" | "apiCalls"
  | "memUsage" // v0.8.36+ windowMemUsage axis removed in the bar+percent refactor (parallel of m_windowContext)
  | "hitRate"   // v0.8.22+ — lifted out of hardcoded literal
  | "contextSize" | "contextWindowsSize" | "contextUsedPercent" | "contextRemainingPercent" // v0.8.23+
  | "startTime" | "endTime" // v0.8.24+ — start/end of the tick statistics window
  | "quota"   // v0.9.0+ — quota module prefix ("quota(5h):123/500")
  | "cost"    // vX.X.X+ — token cost module prefix ("cost:$0.0123")
  | "pluginSystem"        // vX.X.X+ — m_pluginSource glyph when built-in (default "⚙")
  | "pluginUserDefined"   // vX.X.X+ — m_pluginSource glyph when user override (default "🎨")
  | "pluginCC"            // vX.X.X+ — m_pluginSource glyph reserved for the
                          // future "claude 官方" branch (data from stdin).
                          // Default "🔖"; not yet wired into the renderer's
                          // dispatch table (per the user's "CC 分支暂不做实现"
                          // decision 2026-07-12) — the axis is here so the
                          // label is overridable via labels.labelPluginCC
                          // without a follow-up type change.
  | "pluginMissing";      // vX.X.X+ — m_pluginSource glyph when the matched
                          // provider id has no plugin (neither user override
                          // nor built-in). Default "❗".
function labelFor(axis: LabelAxis): string {
  const labels = cfg().labels;
  switch (axis) {
    case "in": return labels.labelTokenIn;
    case "out": return labels.labelTokenOut;
    case "cacheIn": return labels.labelTokenCachedIn;
    case "totalIn": return labels.labelTokenTotalIn;
    case "inSpeed": return labels.labelTokenInSpeed;
    case "outSpeed": return labels.labelTokenOutSpeed;
    case "apiMs": return labels.labelApiMs;
    case "apiCalls": return labels.labelApiCalls;
    case "memUsage": return labels.labelMemUsage;
    case "hitRate": return labels.labelTokenHitRate;
    // v0.8.23+ — context-window prefix knobs (were hardcoded
    // "size:" / "size:" / "used:" / "remain:" in v0.8.22).
    case "contextSize": return labels.labelContextSize;
    case "contextWindowsSize": return labels.labelContextWindowsSize;
    case "contextUsedPercent": return labels.labelContextUsedPercent;
    case "contextRemainingPercent": return labels.labelContextRemainingPercent;
    // v0.8.24+ — start/end of the tick statistics window.
    // m_accStartTime / m_sumStartTime use labelStartTime;
    // m_sumEndTime uses labelEndTime. Defaults "start:" / "end:"
    // (per config.ts:DEFAULT_CONFIG.labels).
    case "startTime": return labels.labelStartTime;
    case "endTime": return labels.labelEndTime;
    // v0.9.0+ — quota module prefix. Default "quota:" (set in
    // config.ts:DEFAULT_CONFIG.labels.labelQuota). Reads "used/limit"
    // in `m_quota|term|short`'s body, e.g. "quota(5h):123/500".
    case "quota": return labels.labelQuota;
    // vX.X.X+ — token cost module prefix. Default "cost:" (set in
    // config.ts:DEFAULT_CONFIG.labels.labelTokenCost). Read by
    // m_tokenCost / m_accTokenCost / m_sumTokenCost.
    case "cost": return labels.labelTokenCost;
    // vX.X.X+ — m_pluginSource glyph axes. Defaults "📌" / "🎨" /
    // "🔖" / "❗" (set in config.ts:DEFAULT_CONFIG.labels). Users
    // override via labels.labelPluginSystem /
    // labels.labelPluginUserDefined / labels.labelPluginCC /
    // labels.labelPluginMissing — anything string-shaped works
    // (e.g. "B:", "🔧", "[built-in]").
    case "pluginSystem":       return labels.labelPluginSystem;
    case "pluginCC":           return labels.labelPluginCC;
    case "pluginMissing":      return labels.labelPluginMissing;
    case "pluginUserDefined":  return labels.labelPluginUserDefined;
  }
}

// vX.X.X+ — for the bare MODULES render path (which receives a
// pre-prefixed string from helpers like computeTickDelta /
// computeTickSpeed / accBody): strip the leading label verbatim
// when ctx.passThrough?.valueOnly === "true". Cheap string-prefix
// check — label defaults are short ASCII ("in:", "out:", etc.)
// and the value-only path is opt-in. Falls through to the original
// value when the prefix doesn't match (defensive: the placeholder
// path might emit "n/a" without a label, and we don't want to
// chop it).
function stripLabelIfValueOnly(value: string, axis: LabelAxis, strip: boolean): string {
  if (!strip) return value;
  const prefix = labelFor(axis);
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

// v0.8.17+ — system RAM byte formatter. 1024-base (matches
// ccstatusline / htop / macOS Activity Monitor convention). G tier
// uses .toFixed(1), M/K tiers use .toFixed(0). Returns "n/a" on
// null so the call site can simply template-literal concat.
export function formatMemBytes(bytes: number | null): string {
  if (bytes == null) return "n/a";
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  const KB = 1024;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)}G`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(0)}M`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(0)}K`;
  return `${bytes}B`;
}

// v0.8.24+ — format a Unix-ms timestamp as `HH:MM:SS` local
// time (or, with `opts.abs === true`, as `YYYY-MM-DD HH:MM:SS`).
// Used by m_accStartTime / m_sumStartTime / m_sumEndTime to
// render the start/end of the tick statistics window. The
// sv-SE locale is the documented "give me an ISO8601-shaped
// local time" idiom (same as diagnostics.ts:localIso) — it
// produces a 24-hour clock, no AM/PM, no leading-zero drop, no
// locale-dependent surprise formatting. With year/month/day
// added it produces `YYYY-MM-DD` so the abs form reads
// `YYYY-MM-DD HH:MM:SS` end-to-end — no `T` separator, just a
// literal space, so ANSI layouts stay clean.
//
// Returns "n/a" on null / non-finite / non-positive inputs so
// call sites can simply template-literal concat.
export function formatAbsTime(
  epochMs: number | null | undefined,
  opts: { abs?: boolean } = {},
): string {
  if (epochMs == null || !Number.isFinite(epochMs) || epochMs <= 0) return "n/a";
  const d = new Date(epochMs);
  if (opts.abs === true) {
    const date = d.toLocaleDateString("sv-SE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const time = d.toLocaleTimeString("sv-SE", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    return `${date} ${time}`;
  }
  return d.toLocaleTimeString("sv-SE", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// v0.8.17+ — sample system memory. Darwin shells out to `vm_stat`
// for active+wired pages (matches ccstatusline's htop-style
// calculation; more accurate than os.freemem on macOS because it
// includes inactive but reclaimable memory). Other platforms fall
// back to os.totalmem() - os.freemem(). Returns null only when the
// vm_stat output cannot be parsed on Darwin (sandbox / restricted
// shell fall through to the os.* path inside the catch).
function getMemUsage(): { used: number; total: number } | null {
  const total = os.totalmem();
  let used: number;
  if (os.platform() === "darwin") {
    try {
      const out = execSync("vm_stat", {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const pageSize = out.match(/page size of (\d+) bytes/);
      const active = out.match(/Pages active:\s+(\d+)/);
      const wired = out.match(/Pages wired down:\s+(\d+)/);
      if (!pageSize || !active || !wired) return null;
      used =
        (parseInt(active[1]!, 10) + parseInt(wired[1]!, 10)) *
        parseInt(pageSize[1]!, 10);
    } catch {
      // vm_stat not on PATH or restricted → fall back to os.*
      used = total - os.freemem();
    }
  } else {
    used = total - os.freemem();
  }
  return { used, total };
}

// Exported so sibling modules (src/dispatch.ts, src/composition.ts) can
// compose colored output without duplicating these literal strings.
export const RESET = "\x1b[0m";

// 256-color SGR sequences are read from configStore so a user can
// override any band via config.json. We re-export them under the same
// names so existing imports (RED, RESET) keep working.
export const BRIGHT_GREEN = configStore.get().colors.brightGreen;
export const DARK_GREEN = configStore.get().colors.darkGreen;
export const YELLOW = configStore.get().colors.yellow;
export const ORANGE = configStore.get().colors.orange;
export const RED = configStore.get().colors.red;
// Used for the stale-on-error annotation (" · 5m ago"). ANSI bright black
// (\x1b[90m) reads as "dim gray" on both light and dark terminals.
export const STALE_COLOR = configStore.get().colors.stale;
// v0.6.0+ — distinct color for the BROKEN-chain "⛓️‍💥 X ago" annotation
// emitted when the fetch failed AND we're rendering the last cached
// value (formatStaleSuffix with healthy=false). Splits the gray stale
// color into a two-axis vocabulary: gray for "informational / fresh
// but stale-data" (🔗), dark red for "degraded / fetch failed" (⛓️‍💥).
// Default `\x1b[31m` (basic dark red) — high contrast on light/dark
// terminals, no 256-color palette dependence.
export const BROKEN_COLOR = configStore.get().colors.broken;

// v0.8.37.1 — thresholds.percentBands is indexed against usedPct
// regardless of display mode. Both modes share the same danger axis
// ("how much of the window have I spent?") so the color follows
// usedPct-derived band 0..4 from paletteByUsed() alone. The
// v0.8.36-era reverse-palette trick was removed: under the
// asymmetric default [60,70,80,90] it produced non-intuitive colors
// at the high-remaining end (remaining=60 → ORANGE when users
// expected DARK_GREEN). Mode-symmetric semantic: remaining=N
// mirrors used=100-N; both display modes agree at the same danger
// level.
function colorThresholds(): readonly number[] {
  return cfg().thresholds.percentBands;
}

// 5-color palette indexed by band (0..4). Band 0 = healthy (bright
// green), band 4 = exhausted (red). The band axis is the USED
// percentage, so this palette is used directly in both display
// modes (remaining mode derives the band from 100 - remainingPct).
function paletteByUsed(): readonly string[] {
  const c = cfg().colors;
  return [c.brightGreen, c.darkGreen, c.yellow, c.orange, c.red];
}

function bandIndex(value: number, thresholds: readonly number[]): number {
  // thresholds[i] is the upper bound for band i (exclusive on the low end).
  // 5 bands total: [0, t0), [t0, t1), [t1, t2), [t2, t3), [t3, 100].
  // Values exactly AT a threshold belong to the band above it (the less
  // dangerous band) — this matches the natural reading of "0/20/40/60/80"
  // where 20 itself marks the transition INTO dark green, not the end of
  // bright green.
  const v = Math.max(0, Math.min(100, value));
  for (let i = 0; i < thresholds.length; i++) {
    if (v < thresholds[i]) return i;
  }
  return thresholds.length; // top band
}

export function colorFor(displayedPct: number, mode: DisplayMode): string {
  // Index the palette against usedPct regardless of display mode.
  // In "remaining" mode the user is staring at a remaining percentage,
  // but the danger axis is still "how much have I spent?" — so flip
  // to usedPct before banding. result: remaining=60 → used=40 →
  // band 0 (bright green) under the [60,70,80,90] default.
  const usedPct = mode === "remaining" ? 100 - displayedPct : displayedPct;
  const idx = bandIndex(usedPct, colorThresholds());
  return paletteByUsed()[idx];
}

// Split-bar with a fixed positional layout:
//   [<USED cells>][<REMAINING cells>]
// USED cells use the configured "filled" glyph (default ▓), REMAINING
// cells use the configured "empty" glyph (default ░). The side that
// gets COLORED depends on the mode:
//   used mode      → color the LEFT (used cells)     — colored by used%
//   remaining mode → color the RIGHT (remaining cells) — colored by remaining%
// This is the unified rule "left = used, right = remaining; the metric the
// user is thinking about as 'danger' is the one that gets the color".
type SplitBar = {
  leftChunk: string; // LEFT half of bar — colored if mode==='used', plain otherwise
  rightChunk: string; // RIGHT half of bar — colored if mode==='remaining', plain otherwise
  color: string;
};

export function splitBar(
  usedPct: number,
  mode: DisplayMode,
  width = configStore.get().bar.width,
): SplitBar {
  const used = Math.max(0, Math.min(100, usedPct));
  const remaining = 100 - used;

  // Color follows the DISPLAYED value (the number shown next to the bar).
  const displayed = mode === "remaining" ? remaining : used;
  const color = colorFor(displayed, mode);

  const coloredSize = Math.round((displayed / 100) * width);
  const plainSize = Math.max(0, width - coloredSize);

  const filled = cfg().bar.filled;
  const empty = cfg().bar.empty;

  // Layout: left = used cells, right = remaining cells. The side that
  // gets color wraps is the "metric of concern" (used in "used" mode,
  // remaining in "remaining" mode). Glyphs flip in remaining mode so
  // the bar reads left-to-right as "what's spent ▓▓▓░░░ what's left":
  //   used      : left=used▓ (colored),  right=remaining░ (plain)
  //   remaining : left=used░ (plain),    right=remaining▓ (colored)
  if (mode === "used") {
    const left = filled.repeat(coloredSize);
    const right = empty.repeat(plainSize);
    return {
      leftChunk: coloredSize > 0 ? `${color}${left}${RESET}` : "",
      rightChunk: right,
      color,
    };
  }
  // mode === "remaining"
  const left = empty.repeat(plainSize);
  const right = filled.repeat(coloredSize);
  return {
    leftChunk: left,
    rightChunk: coloredSize > 0 ? `${color}${right}${RESET}` : "",
    color,
  };
}

// Backwards-compatible simple "filled on left" bar — exported for tests but
// not used by formatOne anymore.
export function pctBar(usedPctValue: number, width = configStore.get().bar.width): { filled: string; empty: string } {
  const clamped = Math.max(0, Math.min(100, usedPctValue));
  const filledCount = Math.round((clamped / 100) * width);
  const emptyCount = Math.max(0, width - filledCount);
  return {
    filled: cfg().bar.filled.repeat(filledCount),
    empty: cfg().bar.empty.repeat(emptyCount),
  };
}

// v0.9.0+ — project an `Interval` into the `Window` shape the
// gauge / countdown renderers consume. Returns null when the
// interval has no usable percent data (the same condition that
// drives the v0.8.x `slotsToWindow` in src/plugins/parsers.ts:160-175 to return
// null). Mirrors the v0.8.x projection rules:
//
//   pct             ← usedPercent (or 100 - remainingPercent if
//                     usedPercent is null). Clamped to [0, 100].
//   resetAt         ← ISO of endAt (null when endAt is null).
//   resetStartAt    ← ISO of startAt (null when startAt is null).
//   resetDurationMs ← endAt - startAt (null when either is null
//                     or endAt <= startAt — same edge case as the
//                     v0.8.x code path).
//
// Quota fields (remainingQuota / usedQuota / limitQuota) are NOT
// projected — they're consumed by `m_quota` directly, never by the
// gauge / countdown modules. Time-only intervals (no percent data)
// still return a Window here so `m_countdown` can render the
// `<label>--` placeholder against `iv.label` (no percent means
// `m_windowQuota` falls back to its own placeholder).
function intervalToWindow(i: Interval): Window | null {
  // Pick the used%. Mirrors the v0.8.x rule: used wins when both
  // are populated; if only remainingPercent is non-null, derive
  // used as 100 - x.
  let usedPct: number | null;
  if (i.usedPercent != null) {
    usedPct = i.usedPercent;
  } else if (i.remainingPercent != null) {
    usedPct = 100 - i.remainingPercent;
  } else {
    usedPct = null;
  }
  if (usedPct == null) return null;

  const resetIso = tsToIso(i.endAt);
  const startIso = tsToIso(i.startAt);
  let durationMs: number | null = null;
  if (i.startAt != null && i.endAt != null && i.endAt > i.startAt) {
    durationMs = i.endAt - i.startAt;
  }
  const w: Window = {
    pct: Math.max(0, Math.min(100, usedPct)),
    resetAt: resetIso,
  };
  if (startIso !== null) w.resetStartAt = startIso;
  if (durationMs !== null) w.resetDurationMs = durationMs;
  return w;
}

// v0.9.0+ — render the quota body for an `Interval`. Returns null
// when neither quota nor limit is present (the caller falls back to
// the placeholder). Renders per the user spec:
//   used + limit  → "quota(5h):123/500"
//   limit only    → "quota(5h):0/500"
//   used only     → "quota(5h):123/--"
//   none          → null
// The label in `(5h)` is read from the live `Interval.label` (so a
// user who set the plugin's `Interval.shortInterval.label = "5h🕐"`
// sees that label in the body). The leading `quota:` prefix is
// read from `labels.labelQuota` via `labelFor("quota")`.
// v0.9.0+ — splits an Interval's quota axis into the structural
// parts so the renderer can color just the digit (the "metric of
// concern"), not the prefix / limit tail. Mirrors the
// `m_windowQuota` / `m_windowContext` convention where only the
// displayed value gets the band color and the static labels stay
// plain.
//
// Returns null when there's no body to render (placeholder path
// takes over). `axisPct` is the displayed percentage the band
// index is computed against — null when no percent can be derived
// (e.g. `used/--` or `--/1500` with no ratio); the caller then
// falls back to STALE_COLOR or no color so the digit doesn't get
// a spurious band tint.
function renderQuotaParts(
  iv: Interval,
  mode: DisplayMode = "used",
): {
  prefix: string;
  label: string;
  axisNumber: number;    // the displayed digit
  total: number | null;  // the right side ("1500" or "--")
  axisPct: number | null;// 0..100 of the displayed digit relative to limit
} | null {
  // vX.X.X+ — label moved from prefix-head to the tail of the body
  // (after the `<axis>/<total>` slice), so the shape is now
  // `quota:<axis>/<total>(<label>)` instead of `quota:(<label>):<axis>/<total>`.
  const prefix = labelFor("quota");
  const label = iv.label;

  if (mode === "remaining") {
    if (iv.remainingQuota != null && iv.limitQuota != null) {
      return {
        prefix, label,
        axisNumber: iv.remainingQuota,
        total: iv.limitQuota,
        axisPct: (iv.remainingQuota / iv.limitQuota) * 100,
      };
    }
    if (iv.usedQuota != null && iv.limitQuota != null) {
      const remaining = iv.limitQuota - iv.usedQuota;
      const clamped = Math.max(0, Math.min(iv.limitQuota, remaining));
      return {
        prefix, label,
        axisNumber: clamped,
        total: iv.limitQuota,
        axisPct: (clamped / iv.limitQuota) * 100,
      };
    }
    if (iv.limitQuota != null) {
      return {
        prefix, label,
        axisNumber: iv.limitQuota,
        total: iv.limitQuota,
        axisPct: 100, // nothing used ⇒ full remaining
      };
    }
    if (iv.remainingQuota != null) {
      return {
        prefix, label,
        axisNumber: iv.remainingQuota,
        total: null,
        axisPct: null, // no limit → no ratio possible
      };
    }
    return null;
  }

  // mode === "used" (default)
  if (iv.usedQuota != null && iv.limitQuota != null) {
    return {
      prefix, label,
      axisNumber: iv.usedQuota,
      total: iv.limitQuota,
      axisPct: (iv.usedQuota / iv.limitQuota) * 100,
    };
  }
  if (iv.remainingQuota != null && iv.limitQuota != null) {
    const used = iv.limitQuota - iv.remainingQuota;
    const clamped = Math.max(0, Math.min(iv.limitQuota, used));
    return {
      prefix, label,
      axisNumber: clamped,
      total: iv.limitQuota,
      axisPct: (clamped / iv.limitQuota) * 100,
    };
  }
  if (iv.limitQuota != null) {
    return {
      prefix, label,
      axisNumber: 0,
      total: iv.limitQuota,
      axisPct: 0, // nothing known used ⇒ 0% consumed
    };
  }
  if (iv.usedQuota != null) {
    return {
      prefix, label,
      axisNumber: iv.usedQuota,
      total: null,
      axisPct: null,
    };
  }
  return null;
}

// vX.X.X+ — band-color a quota body, mirroring m_windowQuota:
// the displayed digit (the "metric of concern") gets the
// `colorFor(displayedPct, mode)` band tint, the prefix / limit
// tail stays plain. `userColor` overrides the band (same precedence
// as every other inline module's :color| override). When the band
// index can't be derived (axisPct == null), STALE_COLOR applies.
// Default-mode users (no inline color) get the band's natural hue
// instead of the legacy single tint from `DEFAULT_COLORS.m_quota`,
// which is the behavior change the user asked for.
function wrapQuotaBody(
  parts: NonNullable<ReturnType<typeof renderQuotaParts>>,
  mode: DisplayMode,
  userColor: string | undefined,
): string {
  const total = parts.total == null ? "--" : `${parts.total}`;
  // Pick the tint: user override wins; else band color when
  // ratio is known; else STALE_COLOR (matches m_window*'s
  // "no percent → gray" convention).
  let tint: string;
  if (userColor) {
    tint = userColor;
  } else if (parts.axisPct == null) {
    tint = STALE_COLOR;
  } else {
    tint = colorFor(parts.axisPct, mode);
  }
  // vX.X.X+ — label moved from the prefix slot to the tail;
  // shape: `${prefix}<axis>/<total>(<label>)` — e.g.
  // `quota:413.7/1500(30d)`.
  return `${parts.prefix}${tint}${parts.axisNumber}${RESET}/${total}(${parts.label})`;
}

// v0.9.0+ — epoch-ms → ISO timestamp. Local to render.ts (same
// impl as the v0.8.x src/plugins/parsers.ts:tsToIso; hoisted here so
// intervalToWindow can use it without dragging the api module
// into render's hot path).
function tsToIso(ms: number | null): string | null {
  if (ms == null) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

// v0.2.17: factor of formatOne() — returns the bar + colored-percent
// portion only (no reset countdown, no window label). The reset
// annotation is rendered by the m_countdown5h / m_countdown7d modules
// independently so the lineTemplate can place them as separate tokens.
// `formatOne` is kept as the canonical helper that joins these two
// parts (plus a leading space) for callers that want the old combined
// form (and for tests that assert on it).
function formatOneChunk(
  w: Window,
  mode: DisplayMode,
  width = cfg().bar.width,
  // v0.6.0+: when stale=true, the WHOLE colored span (bar chunks
  // AND percent tail) wraps in STALE_COLOR instead of the band-based
  // color — the gray sweep is meant to read as "this number is
  // lying; the fetch failed". splitBar() itself is left untouched
  // (tests assert on its .color field at render.test.ts:30-93), so
  // we post-process its output here: rebuild the colored bar chunks
  // directly with STALE_COLOR wrapping. The plain (uncolored) side
  // of the bar stays plain — we only override the side that would
  // have been band-colored. Inline :color| overrides still win
  // (see formatOneChunkColored and the INLINE_RENDERERS no-:color|
  // branch path below).
  stale: boolean = false,
): string {
  const usedPct = Math.max(0, Math.min(100, Math.round(w.pct)));
  const remainingPct = 100 - usedPct;
  const displayedPct = mode === "remaining" ? remainingPct : usedPct;
  const bar = splitBar(usedPct, mode, width);
  if (!stale) {
    return `${bar.leftChunk}${bar.rightChunk} ${bar.color}${displayedPct}%${RESET}`;
  }
  // stale=true → rewrite the colored chunks AND the percent tail in
  // STALE_COLOR. The plain side of the bar (whichever half is not
  // the "metric of concern" for the active mode) stays plain so the
  // user can still read the "what's used vs what's left" shape from
  // the bar's filled/empty glyph pattern.
  const filled = cfg().bar.filled;
  const empty = cfg().bar.empty;
  const coloredSize = Math.round((displayedPct / 100) * width);
  const plainSize = Math.max(0, width - coloredSize);
  let leftChunk: string;
  let rightChunk: string;
  if (mode === "used") {
    const left = filled.repeat(coloredSize);
    const right = empty.repeat(plainSize);
    leftChunk = coloredSize > 0 ? `${STALE_COLOR}${left}${RESET}` : "";
    rightChunk = right;
  } else {
    const left = empty.repeat(plainSize);
    const right = filled.repeat(coloredSize);
    leftChunk = left;
    rightChunk = coloredSize > 0 ? `${STALE_COLOR}${right}${RESET}` : "";
  }
  return `${leftChunk}${rightChunk} ${STALE_COLOR}${displayedPct}%${RESET}`;
}

// v0.3.3+ variant: same layout, but the colored side of the bar AND
// the percentage are wrapped in `override` instead of the band-based
// color. The plain (uncolored) side of the bar stays plain. Used by
// the inline-args path when the user supplied a `|color|<c>` override
// on m_window5h / m_window7d — the user's color REPLACES the natural
// band-based color (no "ignore on conflict" carve-out; the override
// always wins). Returns the same string shape as `formatOneChunk`.
function formatOneChunkColored(
  w: Window,
  mode: DisplayMode,
  override: string,
  width = cfg().bar.width,
): string {
  const usedPct = Math.max(0, Math.min(100, Math.round(w.pct)));
  const remainingPct = 100 - usedPct;
  const displayedPct = mode === "remaining" ? remainingPct : usedPct;
  const filled = cfg().bar.filled;
  const empty = cfg().bar.empty;
  const coloredSize = Math.round((displayedPct / 100) * width);
  const plainSize = Math.max(0, width - coloredSize);
  if (mode === "used") {
    const left = filled.repeat(coloredSize);
    const right = empty.repeat(plainSize);
    const leftChunk = coloredSize > 0 ? `${override}${left}${RESET}` : "";
    return `${leftChunk}${right} ${override}${displayedPct}%${RESET}`;
  }
  // mode === "remaining"
  const left = empty.repeat(plainSize);
  const right = filled.repeat(coloredSize);
  const rightChunk = coloredSize > 0 ? `${override}${right}${RESET}` : "";
  return `${left}${rightChunk} ${override}${displayedPct}%${RESET}`;
}

// Decide whether a window's countdown should be displayed as the
// `n/a` placeholder — when ctx.stale (fetch failed; serving cached
// data) AND the cached resetAt is already in the past. AND-only
// because:
//   - stale=true, future reset: cached countdown still useful.
//   - stale=false, past-due reset: a fresh fetch is due any
//     moment; the next tick will roll the countdown forward.
function isStaleAndPastDue(w: Window, stale: boolean, nowMs: number): boolean {
  if (!stale) return false;
  if (!w.resetAt) return false;
  const t = Date.parse(w.resetAt);
  if (!Number.isFinite(t)) return false;
  return t <= nowMs;
}

// Build the `(n/a<arrow> <label>)` body that replaces the regular
// past-due "(0m<arrow> <label>)" body when ctx.stale AND resetAt
// is in the past. The arrow still comes from pickResetArrow so the
// user sees the same fill-state glyph they would have seen for
// that elapsed ratio — index 0 when ratio ≤ 0 (matches the
// fresh-data past-due path). Caller is responsible for wrapping
// the body in STALE_COLOR.
function formatStalePastDueResetSuffix(
  windowLabel: string,
  w: Window,
  nowMs: number,
): string {
  const arrow = pickResetArrow(nowMs, w.resetStartAt, w.resetDurationMs);
  return `(n/a${arrow} ${windowLabel})`;
}
function formatOneResetSuffix(
  windowLabel: string,
  w: Window,
  nowMs: number = Date.now(),
): string {
  if (!windowLabel) return "";
  // Two pieces: the countdown (e.g. "2h3m") and the arrow (e.g. "🕛").
  // Both are derived from the same Window + nowMs; the arrow is the
  // single thing we always have even when the countdown is empty
  // (e.g. "<1m" or just the arrow alone if resetAt is present but
  // remaining is 0). Template:
  //   resetAt present → "(<countdown><arrow> <windowLabel>)"
  //   resetAt missing  → "<windowLabel>" (DeepSeek / legacy — no
  //   reset info at all, don't fake it with a default arrow)
  const resetSuffix = formatResetSuffix(w.resetAt, nowMs);
  const arrow = pickResetArrow(nowMs, w.resetStartAt, w.resetDurationMs);
  return w.resetAt
    ? `(${resetSuffix}${arrow} ${windowLabel})`
    : windowLabel;
}

// Compact "remaining time until reset" formatter. Returns the countdown
// portion of the reset annotation (no arrow, no parens) — e.g. "2h3m",
// "<1m" for sub-minute, or "0m" for past-due. The caller (`formatOne`)
// appends the window label and the fill-state arrow glyph picked by
// `pickResetArrow`.
//
// The actual formatting rules live in `formatRemainingMs` (shared with
// the stale-age suffix). See that function's doc comment for the full
// `minUnit` × `maxUnitCount` matrix.
export function formatResetSuffix(
  resetAt: string | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (!resetAt) return "";
  const t = Date.parse(resetAt);
  if (!Number.isFinite(t)) return "";
  const remainingMs = t - nowMs;

  return formatRemainingMs(remainingMs);
}

// Pure helper: format a non-negative number of milliseconds as a
// `1d2h3m4s` style countdown, respecting `timeFormat.minUnit` (the
// smallest unit that may appear) and `timeFormat.maxUnitCount` (how
// many non-zero units to show). Top-level config so the formatting
// is consistent across reset countdowns and stale-age suffixes.
//
// Unified algorithm:
//   1. Extract [days, hours, minutes, seconds] from remainingMs.
//   2. Drop units below minUnit (so "m" drops s, "h" drops m+s).
//   3. Drop leading zero units from the trimmed list.
//   4. If the trimmed list is empty → "<1<minUnit>" (positive) or
//      "0<minUnit>" (past-due).
//   5. Slice the remaining list to maxUnitCount, join as `1d2h3m4s`.
//
// Examples (maxUnitCount=2):
//   remaining=2h3m45s minUnit="m" → "2h3m"   (s dropped by minUnit)
//   remaining=2h3m45s minUnit="s" → "2h3m"   (slice cuts s — s > maxUnitCount budget)
//   remaining=2h3m45s minUnit="s", maxUnitCount=3 → "2h3m45s"
//   remaining=2h3m0s  minUnit="s", maxUnitCount=3 → "2h3m0s" (internal zeros kept)
//   remaining=50s      minUnit="m" → "<1m"
//   remaining=50s      minUnit="s" → "50s"
//   remaining=50m      minUnit="h" → "<1h"
//   remaining=2h0m     minUnit="m" → "2h0m"   (internal zero kept)
//   remaining=1d2h3m4s minUnit="m", maxUnitCount=2 → "1d2h"
//   remaining=0        → "0m" / "0s" / "0h" depending on minUnit
export function formatRemainingMs(remainingMs: number): string {
  if (!Number.isFinite(remainingMs)) return "";

  const minUnit = cfg().timeFormat.minUnit;
  const maxUnitCount = Math.max(
    1,
    Math.min(4, Math.floor(cfg().timeFormat.maxUnitCount)),
  );

  const totalSeconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  // Past-due: explicit "0<minUnit>" so the user sees a clear "this
  // window has reset" signal — distinct from "<1<minUnit>" which means
  // "less than 1 unit left" (about to reset).
  if (remainingMs <= 0) return `0${minUnit}`;

  // Build the full unit list, then trim units below minUnit granularity.
  // Order matters: largest → smallest, so "leading zero drop" naturally
  // strips the high-order zeros before the units we care about.
  const allUnits: Array<[number, string]> = [
    [days, "d"],
    [hours, "h"],
    [minutes, "m"],
    [seconds, "s"],
  ];
  // Pre-compute unit→rank once so we can filter and compare without
  // re-allocating per item (TS also dislikes inline-object indexing).
  // Larger rank = smaller unit (s > m > h > d), so `rank[u] <= minUnitRank`
  // keeps units AT or ABOVE minUnit in size (i.e. drops units below it).
  const rank: Record<string, number> = { d: 0, h: 1, m: 2, s: 3 };
  const minUnitRank = rank[minUnit];
  const trimmed = allUnits.filter(([, u]) => rank[u] <= minUnitRank);

  // Drop leading zero units (so "0d0h5m" → "5m", not "0d0h5m").
  let leadingZeroCount = 0;
  while (
    leadingZeroCount < trimmed.length &&
    trimmed[leadingZeroCount][0] === 0
  ) {
    leadingZeroCount++;
  }
  const nonzero = trimmed.slice(leadingZeroCount);

  // All extracted units zero (or all below minUnit) → "<1<minUnit>"
  // floor. Wins over maxUnitCount — "<1<minUnit>" is the truth, not
  // a lossy empty string.
  if (nonzero.length === 0) return `<1${minUnit}`;

  // Take the first maxUnitCount (keeps internal/trailing zeros —
  // "2h0m" stays "2h0m").
  return nonzero.slice(0, maxUnitCount).map(([v, u]) => `${v}${u}`).join("");
}

// v0.9.x — Fixed-second TTL formatter for m_cacheTtlStatus /
// m_statTtlStatus. UNLIKE formatRemainingMs, this ignores
// `timeFormat.minUnit` (and global minUnit): the user explicitly
// asked for a fixed-second suffix on the TTL gauge regardless of
// what timeFormat the rest of the statusline uses. Same shape as
// formatRemainingMs's edge cases so the two paths read alike:
//
//   remainingMs = 23_500  → "23s"
//   remainingMs =  1_000  → "1s"
//   remainingMs =   500   → "<1s"   (sub-second floor; about-to-expire)
//   remainingMs = 60_000  → "60s"
//   remainingMs <= 0      → "0s"    (past-due; mirrors "0<minUnit>")
//   remainingMs = NaN     → ""
//
// `Math.floor(remainingMs / 1000)` truncates so a 23.5s TTL shows
// as "23s" — the bar gauge already encodes the fractional state,
// the suffix reports the full seconds the user can reliably rely
// on (the conservative floor — never overstate remaining TTL).
export function formatTtlSeconds(remainingMs: number): string {
  if (!Number.isFinite(remainingMs)) return "";
  if (remainingMs <= 0) return "0s";
  const secs = Math.floor(remainingMs / 1000);
  if (secs < 1) return "<1s";
  return `${secs}s`;
}

// Pick a reset-countdown glyph from the configured array by how full the
// window still is. Index = floor(remainingMs / resetDurationMs * length),
// so the array reads left-to-right as "fresh → about to reset":
//   index 0        : right after the window reset (ratio = 0)
//   last index     : just before the next reset    (ratio ≈ 1)
// `min(…, length-1)` clamps ratio=1.0 to the last entry instead of
// running off the end. Falls back to index 0 when the interval data is
// missing (DeepSeek, legacy shape, clock skew) — same "neutral" reading
// for any unknown state, so users don't see a glyph swap just because
// we couldn't parse the new fields.
function pickResetArrow(
  nowMs: number,
  resetStartAt: string | null | undefined,
  resetDurationMs: number | null | undefined,
): string {
  const arrows = cfg().countdown.resetArrows;
  const first = arrows[0] ?? "";
  if (resetStartAt == null || resetDurationMs == null) return first;
  const startMs = Date.parse(resetStartAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(resetDurationMs) || resetDurationMs <= 0) {
    return first;
  }
  const elapsed = nowMs - startMs;
  // Clamp ratio to [0, 1] — negative remaining means we're past the
  // window end (formatResetSuffix already filters those, but defense in
  // depth). Slightly-above-1 (clock skew) clamps to the last index.
  const ratio = Math.max(0, Math.min(1, (resetDurationMs - elapsed) / resetDurationMs));
  const idx = Math.min(arrows.length - 1, Math.floor(ratio * arrows.length));
  return arrows[idx];
}

// Compact "age of cached value" formatter for the trailing annotation.
// The `healthy` flag toggles the emoji: 🔗 for fresh (data is current,
// within-TTL cache hit) or ⛓️‍💥 for stale (fetch failed, showing
// cached data). SGR-wrapped in STALE_COLOR and RESET-terminated.
// Returns "" only when ageMs is non-finite (NaN / ±Infinity).
//
// The X time uses the SAME template as the reset countdown
// (formatRemainingMs) with the same `timeFormat.minUnit` and
// `timeFormat.maxUnitCount` knobs:
//   ageMs = 0          → "0<minUnit> ago"   (e.g. "0m ago", "0s ago")
//   sub-minute (0..59s) → "<1<minUnit> ago" or "${seconds}s ago"
//   minUnit="m" → "<1m ago"  (the "<" floor reads "less than 1 minute")
//   minUnit="s" → "${seconds}s ago" (no spurious round-up — second
//                                  granularity is fine-grained enough
//                                  that we don't need to lie about it)
//
// Visibility is gated by the caller: the m_age module emits whenever
// `ageMs != null` (the user explicitly opted in by listing it in the
// lineTemplate); renderProviderLine's forced-visibility block emits
// only when `stale === true` (the user did NOT list m_age but the
// renderer still wants a broken-chain indicator on real outages).
export function formatStaleSuffix(
  ageMs: number,
  healthy: boolean = false,
  override?: string,
): string {
  if (!Number.isFinite(ageMs)) return "";
  const emoji = healthy ? cfg().stale.ageEmoji.healthy : cfg().stale.ageEmoji.broken;
  const label = `${formatRemainingMs(ageMs)} ago`;
  // v0.3.3+: `override` replaces the default color when supplied
  // (used by the inline-args m_age|color|… path; override always
  // wins regardless of broken/fresh).
  // v0.6.0+: split the default into two — STALE_COLOR (gray) for the
  // informational 🔗 annotation on fresh ticks, BROKEN_COLOR (red)
  // for the ⛓️‍💥 annotation when the fetch failed and the cache is
  // serving stale data.
  const color = override ?? (healthy ? STALE_COLOR : BROKEN_COLOR);
  return `${color}${emoji} ${label}${RESET}`;
}

// Read the configured display mode. The earlier TOPGAUGE_DISPLAY env
// var is gone (per the v0.2.0 config-file migration); anyone using it
// must move to config.json's `display` field.
export function resolveDisplayMode(): DisplayMode {
  return cfg().display;
}

// ----- DeepSeek balance line -------------------------------------------------
//
// Distinct from the MiniMax percentage thresholds (0/20/40/60/80): a balance
// is an ABSOLUTE amount, not a percentage, so the bands live at the
// configured thresholds (default 5/10/20/50 — red / orange / yellow / dark
// green / bright green). Lower balance = more urgent, so the lowest band
// (red) corresponds to the LOWEST value — same intuitive direction as the
// "remaining" mode of the MiniMax render.

function balanceThresholds(): readonly number[] {
  return cfg().thresholds.balanceBands;
}

// Lowest value → RED, then orange → yellow → dark green → bright green.
function balancePalette(): readonly string[] {
  const c = cfg().colors;
  return [c.red, c.orange, c.yellow, c.darkGreen, c.brightGreen];
}

function balanceBandIndex(value: number): number {
  const t = balanceThresholds();
  for (let i = 0; i < t.length; i++) {
    if (value < t[i]) return i;
  }
  return t.length; // top band
}

export function colorForBalance(value: number): string {
  const v = Math.max(0, value);
  return balancePalette()[balanceBandIndex(v)];
}

// Format a single numeric value for display: integers as "100", floats as
// "110.00". Trim trailing zeros for cases like "110.10" → "110.1".
function formatBalanceValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  // toFixed(2) then strip trailing zeros and a dangling dot.
  return v.toFixed(2).replace(/\.?0+$/, "");
}

// Display prefix for one balance entry. The `label` field was retired
// from the BalanceEntry schema; `currencyLabel(code)` resolves the
// display prefix from the currency code, with a hard-coded fallback
// to the uppercased code (e.g. "EUR10.50") for unmapped codes —
// never blanks, so a new provider currency never silently disappears.
function formatBalanceChunk(currency: string, v: number): string {
  return `${currencyLabel(currency)}${formatBalanceValue(v)}`;
}

// Currency-code → display-symbol lookup. Hard-coded default map covers
// the currencies DeepSeek + the most common USD-denominated providers
// expose; unmapped codes fall back to the uppercased code so a plugin
// for a less common currency still renders something readable
// (e.g. `currencyLabel("EUR") → "EUR"`).
//
// The host deliberately does NOT carry this map in config (per the
// "全部通过插件进行独立解析" directive): a plugin that wants a custom
// symbol for a non-default currency can emit a different currency
// code, or surface its own m_label module. Renaming the mapped
// symbols (e.g. user prefers `"$"` for CNY too) requires editing this
// one helper.
function currencyLabel(code: string): string {
  switch (code) {
    case "CNY":
    case "RMB":
      return "￥";
    case "USD":
      return "$";
    default:
      return code.toUpperCase();
  }
}

type BalanceLike = {
  isAvailable: boolean;
  // vX.X.X+ — entries are now `{ currency, totalBalance }` only; the
  // display prefix is derived from `currency` via `currencyLabel`.
  // Plugin authors emitting pre-built Balance objects must not ship
  // a `label` field — the schema no longer carries it.
  entries: ReadonlyArray<{ currency: string; totalBalance: number }>;
  minValue: number | null;
};

// v0.2.17: refactor of the balance-line renderer so the m_balance module can
// produce a complete colored chunk (prefix + " · "-joined entries
// wrapped in a single SGR block). Returns "" when there's nothing to
// render so the m_balance module can return null and the template
// renderer skips the surrounding s_0 separators cleanly.
//
// v0.3.3+ `override` parameter: when supplied, replaces the band-based
// `colorForBalance` choice (used by the inline-args m_balance path).
function formatBalanceEntriesColored(b: BalanceLike, override?: string): string {
  if (!b.isAvailable || b.entries.length === 0 || b.minValue == null) {
    return "";
  }
  const chunks = b.entries.map((e) => formatBalanceChunk(e.currency, e.totalBalance));
  // Color follows the LOWEST entry — most urgent currency drives the hue.
  const color = override ?? colorForBalance(b.minValue);
  return `${color}${chunks.join(" · ")}${RESET}`;
}

// ----- lineTemplate / module renderer (v0.2.17) -------------------------
//
// A lineTemplate is an ordered list of tokens. Two token kinds:
//   m_<name>  — a display module (registered in MODULES below)
//   s_<name>  — a built-in separator literal (s_space / s_dot / s_newline / s_tab / s_colon / s_pipe)
//
// The renderer walks the template left-to-right, concatenating each
// module's output. Modules return null to signal "hidden in this
// context" — a null return SKIPS the surrounding separators too, so a
// hidden window doesn't leave orphan spaces or "·" in the output. This
// is what makes "drop the 7d window by removing m_window7d from the
// template" a clean operation rather than producing
// "Usage: <5h> ·  " with a trailing orphan separator.
//
// Unknown module names (typos) expand to "" and emit ONE stderr
// warning per render — capped at once-per-render to avoid log spam
// since the renderer runs on every statusline tick.
type RenderContext = {
  mode: DisplayMode;
  nowMs: number;
  // v0.9.4 — open-ended `intervals` dict replaces the v0.9.0 trio
  // of fixed slots (`shortInterval` / `midInterval` / `longInterval`).
  // The three reserved keys ("short" / "mid" / "long") are always
  // seeded by `ensureQuota` so legacy `m_windowQuota|term|short`
  // / `mid` / `long` lookups keep working byte-for-byte. New
  // plugins can declare arbitrary keys (e.g. "monthly") and
  // reference them via `m_windowQuota|term|monthly`. `Window` is
  // still the shape `formatOneChunk` / `formatOneResetSuffix`
  // consume; `intervalToWindow` projects an `Interval` →
  // `Window` when the gauge / countdown rendering path needs to
  // fire. Old code paths (m_sum* align-aware scans) read
  // `Object.values(intervals)` to find a matching `windowId`.
  intervals?: Record<string, Interval | null>;
  // v0.9.4 — legacy back-compat. Test helpers and a handful of internal
  // call sites still construct ctx with flat `shortInterval` /
  // `midInterval` / `longInterval` fields. `renderTemplate` and
  // `renderProviderLine` fold these into the reserved dict keys
  // (`short` / `mid` / `long`) when `intervals` is absent. The
  // canonical ctx has only `intervals`.
  shortInterval?: Interval | null;
  midInterval?: Interval | null;
  longInterval?: Interval | null;
  balance: BalanceLike | null;
  ageMs: number | null;
  stale: boolean;
  version: string;
  // v0.4.0+ — live stdin snapshot for the m_token* modules. Always
  // present on the main flow (index.ts builds one before invoking
  // renderProviderLine); tests inject a fake via __resetForTest.
  tokens: TokenSnapshot | null;
  // v0.4.0+ — synthetic Window for the m_windowContext module.
  // Synthesized from tokens.contextWindow.contextUsedPercent; only `pct` is
  // read by formatOneChunk. Null when stdin lacks used_percentage.
  contextWindow: Window | null;
  // v0.4.x — the provider's TYPE discriminator. Populated by
  // renderProviderLine from providerTypeFor. `"quota"` for
  // Quota providers, `"balance"` for BALANCE providers, and
  // `"unknown"` when ANTHROPIC_BASE_URL doesn't match any
  // supported provider.
  // configured provider (the entry-tolerant dispatch path).
  // Used by per-module `type` filters and by m_modeLabel's label
  // routing. Renamed from the v0.4.x-beta `providerModeKey` to
  // avoid collision with the display-mode field `mode` (`used` /
  // `remaining` / `balance`); the type discriminator is a TYPE, not
  // a mode.
  providerType: "quota" | "balance" | "unknown";
  // v0.9.0+ — the active provider INSTANCE id (e.g. `"minimax"` /
  // `"deepseek"`). Populated by renderProviderLine
  // from the `provider` arg; null when ANTHROPIC_BASE_URL didn't
  // match any configured entry. Distinct from `providerType`
  // (which is the category discriminator `quota` / `balance` /
  // `unknown`). Used by `m_template|<key>|provider:<id>` to gate a
  // fragment to ONE specific provider (where `type:quota` matches
  // every quota-mode provider).
  currentProvider?: import("./types.ts").Provider;
  // v0.9.0+ — current column cursor for `s_move|pos:<n>` column-
  // advance. Initialized to 0 by renderTemplate at the start of
  // each render; reset to 0 on every `\n` (newline in a chunk
  // closes the line); bumped by the ANSI-stripped display width of
  // every emitted chunk. Width is measured in UTF-16 code units
  // (JavaScript `String.length`) — not east-asian display columns
  // — but that's a deliberate simplification: statusline cells
  // round to the JS-string length closely enough for `s_move` to
  // act as a printable-cell column pad, and full wcwidth is a
  // heavier dep than this single-param construct warrants. ANSI
  // SGR sequences are stripped before counting so the cursor
  // tracks visible cells, not raw byte length.
  lineCursor?: number;
  // v0.6.0+ — mutable cross-recursion dedup ref for the m_age module.
  // Initialized to `{ value: false }` by renderProviderLine and
  // propagated by reference through any nested `m_template:`
  // expansions (m_template passes ctx as-is; only the inner template
  // array is sliced). The first m_age instance to emit sets .value
  // = true; subsequent m_age instances (and the forced-visibility
  // append in renderProviderLine) see .value=true and skip. Replaces
  // the older templateHasAgeModule string-match which only scanned
  // the top-level token list and missed m_age nested inside
  // lineTemplates.* fragments.
  ageEmittedRef?: { value: boolean };
  // v0.8.7+ — passthrough args from an outer `m_template|<key>|...`
  // expansion. Populated by the m_template renderer with its own
  // parsed `params` (minus the `key` and `mode` intrinsics) before
  // recursing into `renderTemplate(inner, ctx)`. Downstream
  // `INLINE_RENDERER`s read `ctx.passThrough?.[<name>]` as a
  // fallback when their local `params[<name>]` is undefined — so an
  // inner module's own explicit arg always wins. See
  // `passThroughOr()` below. The field is created fresh per
  // m_template invocation; nested m_template is impossible because
  // config.ts strips them at load time.
  passThrough?: Record<string, ResolvedValue>;
  // v0.8.21+ — quote bodies pre-fetched by `preFetchQuotes` in
  // `index.ts:main()` (see `src/api.quote.ts`). Keyed by raw
  // address string. A missing key (or undefined map) means the
  // fetch failed / was skipped / the active template had no
  // `m_quote|address|…` token — the renderer's address-mode path
  // falls back to local QUOTES in that case. Lifetime is one tick;
  // built fresh by `preFetchQuotes` and threaded into ctx here.
  quoteBodies?: Map<string, string>;
  // v0.9.0+ — which side of the user-vs-builtin fence the active
  // provider's plugin was loaded from on the most recent fetch.
  // Populated by index.ts:main() from cache.json row
  // `<provider>:pluginSource` (set by fetchProviderData right after
  // a successful pluginTransportWithKind call). `null` when no
  // provider matched, no cache row was ever written (fresh install),
  // or the row has been evicted — m_pluginSource drops to no-op in
  // all three cases per the "Drop 整个 module" decision 2026-07-11.
  // Optional on the type so test fixtures and older callers (which
  // never knew about plugin sources) can build a ctx without it;
  // renderProviderLine normalizes missing → null at construction.
  pluginSource?: "user" | "builtin" | "missing" | null;
};

// v0.4.x — modules may declare a `type` filter so they only render
// for one provider kind. With the unification of `renderPlanLine`
// (and the legacy `formatBalanceLine` shim, dropped in v0.9.x) into
// a single `renderDataLine`, the per-provider gate that used to
// live in dispatch.ts:buildProviderLine now lives here: a bare
// `m_window5h` in a balance provider's template silently drops (the
// module is type:`"quota"`), and `m_balance` in a
// quota provider's template silently drops too. Modules without a
// type tag (m_token*, m_age, m_version, …) are provider-agnostic
// and emit on every ctx.
//
// The renderer applies the filter by inspecting `mod.type` and
// comparing against `ctx.providerType`. A module function is still
// canonical; the `type` field is read-only metadata on the same
// record.
//
// v0.4.x — `type` widened to include `"unknown"` (a hypothetical
// `m_xxx:type:"unknown"` would only emit when ANTHROPIC_BASE_URL
// doesn't match any configured provider). No module currently
// uses this — quota-only and balance-only modules drop on unknown
// because their `type` value doesn't match. Reserved for future
// modules that want to render only in the unregistered case
// (e.g. an m_setupHint module that nudges the user toward running
// `/topgauge:install`).
type Module = ((ctx: RenderContext) => string | null) & {
  type?: "quota" | "balance" | "unknown";
};

// v0.8.x — cwf-tickStatus-v2. Per-tick state lives in
// `state/<projectHash>/status.json` (managed by src/status-store.ts).
// Two slot families with clearly separated roles:
//
//   (A) tickStatus:<...>  — PURE ACCUMULATORS (the user-defined
//       rule: "tickStatus 只表示累计状态"). Three dimensions, all
//       written by setAvg's atomic path:
//
//         tickStatus:<sessionId>   per-session (clear-bounded)
//         tickStatus:<projectHash> per-project (cwd-bounded, NO prefix)
//         tickStatus:<model>       per-model (modelDisplayName)
//
//       value shape (TickStatusValue, acc-only — no per-tick fields):
//         accTokenIn         — accumulated current.input
//         accTokenOut        — accumulated current.output
//         accTokenCachedIn   — accumulated current.cacheRead
//         accTokenTotalIn    — per-tick-delta-accumulator of totalIn
//         accApiMs           — += deltaApiMs (delta-accumulator
//                              across all three scopes; the
//                              sessionId change naturally zeros
//                              the session slot, the projectHash
//                              change naturally zeros the project
//                              slot, and a brand-new model name
//                              starts the model slot from 0)
//         accApiCalls        — accumulated API-call count
//
//
//   (B) prevTickStatus  — SINGLETON, NOT per-dimension. Holds the
//       last tick's stdin snapshot. Used by the writer to (i)
//       compute the per-tick delta and (ii) detect a regression
//       (current totalApiMs < prevTickStatus.totalApiMs means the
//       Claude Code process restarted; the tick is dropped from
//       the sample row, since the baseline no longer applies).
//
//       value shape (PrevTickStatusValue):
//         in/out/cachedIn/totalIn/totalApiMs — previous tick's values
//         sessionId/cwd/model                 — identity for debug
//
// accApiCalls contract (unchanged from v0.8.0):
//   On a tick where deltaApiMs > 0 AND input_tokens > 0 (a real
//   API call that produced input tokens), accApiCalls += 1. The
//   gate is AND, not OR — a tick with deltaApiMs > 0 but
//   input_tokens == 0 does NOT count.
//
// v1.0 — PrevTickSnapshot lives in src/status-store.ts; the
// re-export at the top of this file preserves the test fixture
// import surface.
//
// v1.0 — peekPrevTick lives in src/status-store.ts. Render is
// read-only; the re-export below preserves the test fixture
// import surface.
export { peekPrevTick } from "./status-store.ts";// v1.0 — setPrevTick / setLastSpeed / setLastApiMs /
// setLastTokenHitRate live in src/status-store.ts. Render is
// read-only; these are the writer-side helpers. The re-exports
// below preserve the test fixture import surface (e.g. tests
// importing setPrevTick from "../src/render.ts").

export {
  setPrevTick as setPrevTick,
  setLastSpeed as setLastSpeed,
  setLastApiMs as setLastApiMs,
  setLastTokenHitRate as setLastTokenHitRate,
} from "./status-store.ts";

// ----- lastActive (v0.4.x) --------------------------------------------
//
// Stores the LAST active-tick tps per direction (in / out), so an
// idle tick (deltaApi == 0) that would otherwise render "-- t/s"
// can fall back to the cached value. Stored in status.json under
// the `lastActive:in` / `lastActive:out` keys (no sessionId in the
// key — project-wide singleton per direction). 60s TTL is enforced
// inside status-store.ts; writes happen ONLY on active ticks so the
// cached value is always "the last thing I measured".
//
// Reads ignore the per-session dimension: caller passes the
// session-agnostic tps and reads a project-wide value. Different
// from the old tickSpeedDisplay:<direction>:<sessionId> model
// which partitioned by session — the user explicitly asked for
// the session dimension to be dropped (the last-active signal is
// a "what was the overall rate we last saw" reading, useful
// across sessions). The sessionId argument is kept in the
// signature for back-compat with existing test fixtures.
//
// v1.0 — read side (peekLastSpeed / peekLastApiMs /
// peekLastTokenHitRate) re-exported from -processor.
export {
  peekLastSpeed,
  peekLastApiMs,
  peekLastTokenHitRate,
} from "./status-store.ts";

// Test-only: clear the in-memory + disk tickStatus:<sid> entry.
// Production code never calls this. No-op stub: same rationale as
// __resetLastSpeedForTest above.
export function __resetPrevTickForTest(
  _sessionId: string,
  _cwd?: string | null,
): void {
  // v1.0 — in v0.9.x the seed pattern was
  // stashPrevTick(..., {apiMs:0, in:0, out:0, cacheRead:0}). Now
  // tests should use setPrevTick (still exported) or
  // processTick directly.
}

// v1.0 — peekAvg moved to src/status-store.ts. Render is
// read-only; the re-export below preserves the test fixture
// import surface.
export { peekAvg } from "./status-store.ts";

// v0.8.x cwf-tickStatus-v2 — read the three-layer accumulator at
// a chosen scope. Used by the m_acc* module family. The three
// scopes:
//
//   session  → tickStatus:<sessionId>          (clear-bounded)
//   project  → tickStatus:<projectHash(cwd)>   (cwd-bounded; no prefix)
//   model    → tickStatus:<modelId>   (per-model)
//
// Returns null when the slot has never been written, so the
// module can render a placeholder rather than fabricating a "0".
function peekAcc(
  scope: "session" | "project" | "model",
  ctx: RenderContext,
): AvgSnapshot | null {
  const t = ctx.tokens;
  const cwd = t?.cwd ?? undefined;
  if (scope === "session") {
    if (!t?.sessionId) return null;
    return peekAvg(t.sessionId, cwd);
  }
  return statusStore.readAccumulator(scope, {
    sessionId: t?.sessionId,
    cwd,
    // v0.9.x — pass the active-model id (stdin.model.id) so the
    // per-model slot lookup uses the same identifier as the new
    // sample.model stamp and the new tokenPrices keys.
    modelId: t?.modelId,
  });
}

// Canonical write path was retired to src/status-store.ts (see
// `setAvg` there). The -processor (processTick Stages 4 + 4b) is
// the sole caller; this module is read-only. Re-exported below
// for back-compat with test fixtures.
//
// Scope contract (post-ccsession cleanup): the three surviving
// scopes all DELTA-ACCUMULATE the in/out/cached/totalIn/apiMs/
// apiCount scalars. The ccsession-specific regression-reset
// quirk was removed: a Claude Code process restart no longer
// zeroes a separate per-process slot, because that slot no
// longer exists. The relevant regression detection in
// detectRegression still fires (it gates sample-row emission);
// it just no longer needs a ccsession-specific mark path.
export { setAvg } from "./status-store.ts";
// AvgSnapshot / peekAvg re-exports sit at the top of the file.

// v1.0 — _tickDeltaMemo / _tickAvgWriteMemo / _tickCacheWriteMemo
// are GONE. The -processor (src/status-store.ts) calls
// computeAndCacheTickDeltaPure once per tick and stashes the result
// on tickState.delta. Render reads it via getDeltaForRender() —
// no per-render memoization needed because there's a single
// producer per tick.

// v1.0 — the deferred setPrevTick queue / _pendingPrevTick /
// commitPrevTickOnce / _renderDepth are GONE. The -processor
// (src/status-store.ts:processTick) sets PREV_TICK_KEY once per
// tick BEFORE render begins, so all render contexts (outer,
// m_template inner) see the same baseline via peekPrevTick. No
// per-render memo or queue needed.
//
// For back-compat with test fixtures that imported
// __resetPendingPrevTickForTest, the stub below is preserved as a
// no-op (see tests using it).

// v1.0 — computeAndCacheTickDelta is GONE. The -processor
// (src/status-store.ts:computeAndCacheTickDeltaPure) owns the
// pure delta math; it stashes the result on tickState.delta.
// Render modules read via getDeltaForRender(). No per-render
// memoization needed — single producer per tick.
//
// Per-API-call delta semantics (unchanged from v0.9.x):
//   - current_usage.* is the per-turn delta (NOT subtracted from
//     prev). Only deltaApiMs is a TRUE subtraction (cost.totalApi-
//     DurationMs is session-cumulative).
//   - Gating is deltaApi > 0 ONLY. In/out/cache_read don't need
//     to all move together.
//   - First tick assumes prev=0 so the first turn still contributes.

// Compute the per-API-call throughput for one of {in, out}. v0.4.0+
// — always returns a non-null value. The module occupies a stable
// slot in the user's lineTemplate; a missing-data render is
// "in:-- t/s", not a drop. This keeps the line layout stable across
// ticks — the user always sees the module where they put it, and
// learns to read "--" as "no data / nothing to report".
//
// math (when hasDelta):
//   tps = current_in_or_out / delta_api * 1000
//
// Missing-data conditions (render "in:-- t/s"):
//   - no current snapshot data
//   - delta_api <= 0 (no API call between ticks) AND no cached
//     value from a previous active tick to fall back to
//
// v0.4.0+ (revised 2026-06-29 + 2026-06-29): per-turn deltas
// don't need a direction-specific zero-rejection gate. IN and
// OUT don't have to move together — a thinking-only turn adds
// 0 input tokens but 0 output tokens too; a synthesized-message
// turn adds 0 input but real output. The truthful rate is
// 0.0 t/s, not "-- t/s". We render 0.0 directly so the user
// sees the real measurement and learns the difference between
// "0 t/s" (real zero) and "in:-- t/s" (no data).
//
// v0.4.0+ second revision: cache the last ACTIVE-tick tps per
// session. On an idle tick (no API call this turn), fall back
// to the cached tps so the speed module doesn't blink
// in:-- t/s between real measurements during fast statusline
// ticks. The cache is only written on active ticks (idle ticks
// preserve the previous measurement). Returns an `active` flag
// so the caller can pick color: active = scale band, inactive
// = STALE_COLOR (the user reads the gray as "this is a stale
// measurement from a previous API call, not a real one now").
function computeTickSpeed(
  ctx: RenderContext,
  direction: "in" | "out",
  color: string,
): {
  value: string;
  active: boolean;
  tps: number | null;
} {
  // v0.8.10-alpha.2 — render reads `getDeltaForRender()` which now
  // returns TickSnapshot ({ hasMeasurement, in, out, ..., apiMs }).
  // No writeBack field — there is no prev-writeBack payload anymore.
  // v0.8.13+ — speed prefix routes through labelFor
  // (labels.labelInSpeed / labels.labelOutSpeed) so the per-turn
  // speed module is independently configurable from the in/out
  // token-axis labels. Defaults remain "in:" / "out:" matching
  // today's literal strings byte-for-byte.
  const prefix = labelFor(direction === "in" ? "inSpeed" : "outSpeed");
  const t = ctx.tokens;
  if (!t || !t.sessionId) {
    return {
      value: `${prefix}n/a`,
      active: false,
      tps: null,
    };
  }
  const r = getDeltaForRender();
  if (!r.hasMeasurement) {
    // Idle tick — fall back to the last active measurement if
    // we have one, otherwise render the truthful "0.0 t/s".
    const cached = peekLastSpeed(t.sessionId, direction, t.cwd);
    if (cached != null) {
      return {
        value: `${STALE_COLOR}${prefix}${formatSpeed(cached)}${RESET}`,
        active: false,
        tps: cached,
      };
    }
    return {
      value: `${color}${prefix}${formatSpeed(0)}${RESET}`,
      active: false,
      tps: 0,
    };
  }
  const tok = direction === "in" ? r.in : r.out;
  const tps = (tok / r.apiMs) * 1000;
  return {
    value: `${color}${prefix}${formatSpeed(tps)}${RESET}`,
    active: true,
    tps,
  };
}

// v0.8.13+ — m_accTokenInSpeed / m_accTokenOutSpeed helper. Reads
// from the chosen scope's accumulator (session / project / model)
// and computes the throughput as accToken* / accApiMs * 1000
// (t/s). Mirrors the structure of computeTickSpeed (the per-turn
// twin), but pulls values from peekAcc rather than the per-tick
// delta. Returns:
//   - "n/a" placeholder when scope has never been written
//     (no v from peekAcc) — same `direction:n/a` shape as
//     the per-turn sibling.
//   - "0 t/s" plain when accApiMs > 0 but accToken* === 0
//     (the value-zero rule at [[render-value-zero-rule]]).
//   - scale-colored "N t/s" when accApiMs > 0 AND the chosen
//     token accumulator is positive (the active, measurable
//     case).
function computeAccSpeed(
  ctx: RenderContext,
  scope: "session" | "project" | "model",
  direction: "in" | "out",
  color: string,
): {
  value: string;
  active: boolean;
  tps: number | null;
} {
  // v0.8.13+ — speed prefix routes through labelFor
  // (labels.labelInSpeed / labels.labelOutSpeed) so the per-acc
  // speed module is independently configurable from the in/out
  // token-axis labels. Defaults remain "in:" / "out:" matching
  // today's literal strings byte-for-byte.
  const prefix = labelFor(direction === "in" ? "inSpeed" : "outSpeed");
  const v = peekAcc(scope, ctx);
  if (!v) {
    return { value: `${prefix}n/a`, active: false, tps: null };
  }
  if (v.accApiMs === 0) {
    // No API duration accumulated yet → "direction:0 t/s" plain
    // (the natural zero state — the value-zero rule says count:0
    // is real data, not a placeholder).
    return {
      value: `${prefix}${formatSpeed(0)}`,
      active: false,
      tps: 0,
    };
  }
  const tok = direction === "in" ? v.accTokenIn : v.accTokenOut;
  const tps = (tok / v.accApiMs) * 1000;
  return {
    value: `${color}${prefix}${formatSpeed(tps)}${RESET}`,
    active: true,
    tps,
  };
}

// Per-API-call raw token delta. v6.x — distinguishes three states:
//
//   - snapshot data missing (tokens / sessionId / current.tokenIn
//     absent)         → `${direction}:n/a`  (no stdin at all)
//   - idle tick       → `${direction}:0`    (stdin present, no
//                                             delta this tick —
//                                             truthful "0 this turn")
//   - active tick     → `${direction}:${formatCompactToken(n)}`
//
// v0.4.0+ previously collapsed the first two into "in:0", which
// conflated "no data" with "real zero". The new rule (per user
// direction): 0 renders as "0" (never hidden); null renders as
// "n/a". Idle ticks (hasDelta=false) still return "in:0" because
// the snapshot was read but the per-turn delta genuinely is 0 —
// that IS a zero value, not missing data.
//
// Uses formatCompactToken so single-call token counts read the
// same as the cumulative modules (e.g. "in:140", "in:12.3k").
function computeTickDelta(
  ctx: RenderContext,
  direction: "in" | "out",
): { value: string; numeric: number | null; stale: boolean } {
  const t = ctx.tokens;
  const prefix = labelFor(direction);
  // v0.8.10-alpha.2 — `hasMeasurement` mirrors the validity gate
  // (totals.tokenTotalIn > 0 AND totals.tokenTotalOut > 0 AND apiMs > 0).
  // v0.8.30+ — `numeric` carries the live-stdin value
  // (`tokens.current.tokenIn` / `tokenOut`) so the renderer can
  // still surface a real number on idle ticks (apiMs=0) instead
  // of collapsing to a processed "0". The gate is independent
  // from the value: an idle tick has `numeric > 0` AND
  // `stale === true`, which the renderer maps to STALE_COLOR
  // (matching the v0.8.x R7 convention of "live stdin's
  // last-known measurement, gray-wrapped"). `numeric: null`
  // means no stdin at all (placeholder path).
  // v0.8.30.1+ — `stale` is the explicit hasMeasurement mirror
  // (true = the per-tick pipeline rejected this tick, so the
  // number shown is from stdin, not from a measured delta).
  if (!t || !t.sessionId) {
    return { value: `${prefix}n/a`, numeric: null, stale: false };
  }
  const r = getDeltaForRender();
  // Pull the live stdin value directly. The processed delta
  // (`r.in` / `r.out`) collapses to 0 on idle ticks; we want
  // the user to see the actual stdin number, not the zero
  // that the validation gate writes to the snapshot.
  const liveN = direction === "in" ? t.current.tokenIn : t.current.tokenOut;
  const liveNumeric =
    typeof liveN === "number" && Number.isFinite(liveN) ? liveN : 0;
  if (!r.hasMeasurement) {
    // Idle tick — hasMeasurement is false, so the displayed
    // body is the live stdin number prefixed with the
    // direction label. numeric carries the same value so the
    // renderer's color gate sees a positive number; the
    // `stale` flag routes the wrap to STALE_COLOR instead of
    // brightGreen / red.
    return { value: `${prefix}${formatCompactToken(liveNumeric)}`, numeric: liveNumeric, stale: true };
  }
  const n = direction === "in" ? r.in : r.out;
  return { value: `${prefix}${formatCompactToken(n)}`, numeric: n, stale: false };
}

// Per-session running average speed across all valid API
// calls. Combines the prevTick (per-API-call math) with the
// AvgSnapshot (running totals). The math across the session:
//   sum_in  / sum_api  * 1000  (and same for out)
// Only valid-API-call ticks contribute (deltaApi > 0 AND
// deltaTokenIn / deltaTokenOut >= 0); idle and regression ticks don't.
// Renders "--" when no valid tick has accumulated yet (sumApi
// is still 0 after this tick — i.e. nothing usable came in).
// Color defaults to STALE_COLOR; the inline :color| path
// overrides it.
//
// Side effects: fires BOTH the prevTick write (so the next
// tick's computeAndCacheTickDelta sees a fresh baseline) AND
// the avg accumulate write. This means computeTickAvg is
// self-sufficient — putting m_tokenInAvg alone in a template
// with no speed / raw-delta modules still works.

// v0.8.x cwf-tickStatus-v2 — the m_totalToken* / m_totalTokenWithCacheIn
// module family (and its computeTickTotals helper) was REMOVED
// in this version. The accumulator access for "session-cumulative
// in/out/cache" now goes through the m_acc* family with
// scope=session (the default). For example:
//   m_totalTokenIn          → m_accTokenIn
//   m_totalTokenOut         → m_accTokenOut
//   m_totalTokenWithCacheIn → m_accTokenCachedIn
// No alias is provided — the old names drop with the
// v0.8.x cwf-tickStatus-v2 rename (consistent with the v0.8.0
// removal of m_token5h / m_token7d / m_tokenInAvg / m_tokenOutAvg).

// v1.0 — body factory for the m_acc* family. Renders the
// chosen accumulator field at a chosen scope. Output shape:
//
//   scope=session (default) → "acc:N"
//   scope=project           → "acc(total):N"
//   scope=model             → "acc(<modelId>):N"
//
// Reads the three-layer accumulator via peekAcc. The -processor
// (src/status-store.ts:processTick) has already written the
// per-tick deltas to tickState.pending BEFORE render begins, so
// this is a pure read. Placeholder when the chosen slot has never
// been written (no prior tick, no model for the model scope, no
// sessionId for the session scope). Zero accumulator renders as
// "acc:0" (value-zero rule, never dropped).

// v1.0 — accPrimer / accCachePrimer are GONE. The -processor
// (processTick Stages 4 + 4b) owns the accumulator writes now.
// Render is pure read.

function accBody(
  ctx: RenderContext,
  field: "in" | "out" | "cached" | "total" | "apiMs" | "apiCalls",
  scope?: "session" | "project" | "model",
  stripLabel?: boolean,
): string {
  // vX.X.X+ — |valueOnly|true propagates from a bare m_acc* module
  // (read via ctx.passThrough?.valueOnly) or from an inline-form
  // m_acc* renderer (explicit stripLabel arg from passThroughOr).
  // When set, every prefix below collapses to "" so the rendered
  // body is the bare number.
  const strip = stripLabel ?? ctx.passThrough?.valueOnly === "true";
  const useScope = scope ?? "session";
  const v = peekAcc(useScope, ctx);
  if (!v) {
    // v0.8.x cwf-tickStatus-v2 — the accTokenCachedIn track only writes
    // when stdin carries the cache field. m_accTokenCachedIn /
    // m_accTokenTotalIn / m_accTokenHitRate must still honor
    // the "field not shipped" → "--" contract, so we don't fire
    // accCachePrimer here on a missing slot — the placeholder
    // shape is the only honest signal in that case.
    return placeholderAcc(field, useScope, strip);
  }
  // v0.8.10-alpha.3 — removed the "field not shipped" cache guard.
// cache_read_input_tokens absence on the current stdin does not
// imply an empty slot at any scope (session / project / model
// all accumulate across ticks). Renderers that hit a missing
// slot fall through to the existing `if (!v)` branch above and
// produce `prefix:n/a` via placeholderAcc.
  // v1.0 — accCachePrimer is gone. The -processor already
  // wrote accTokenCachedIn (Stage 4b) when stdin shipped
  // cache_read_input_tokens. Re-read after Stage 4b in case the
  // first peekAcc fired before the -processor's writes (rare
  // in production — processTick runs before renderTemplate — but
  // tests sometimes interleave).
  const v2 = peekAcc(useScope, ctx) ?? v;
  let n: number;
  switch (field) {
    case "in": n = v2.accTokenIn; break;
    case "out": n = v2.accTokenOut; break;
    case "cached": n = v2.accTokenCachedIn; break;
    case "apiMs": n = v2.accApiMs; break;
    case "apiCalls": n = v2.accApiCalls; break;
    case "total": n = v2.accTokenIn + v2.accTokenCachedIn; break;
  }
  // v0.8.0+ — acc* family prefixes use the same label axes as their
  // per-turn siblings. m_accTokenIn/Out/CachedIn/TotalIn share
  // labelIn / labelOut / labelCacheIn / labelTotalIn;
  // m_accApiMs routes through labelFor("apiMs") (= labels.labelApi)
  // and m_accApiCalls through labelFor("apiCalls") (= labels.labelApiCalls).
  // Both render via formatRemainingMs / String(n) so the accumulator
  // matches m_apiMs's "api:1m" dhms shape and m_apiCalls's "calls:N"
  // count shape (rather than the v0.7.x raw-ms `acc:60.0k` literal).
  // Honors the same timeFormat.minUnit / maxUnitCount knobs as the
  // per-turn sibling. Defaults reproduce the v0.7.x literal "acc:"
  // prefix for the in/out/cached/total fields via the corresponding
  // label.* defaults, and "api:" / "calls:" for the apiMs / apiCalls
  // fields via labels.labelApi / labels.labelApiCalls.
  let prefix: string;
  let body: string;
  // vX.X.X+ — when stripLabel is on, every prefix resolves to ""
  // so the rendered body is the bare number / dhms / count.
  const p = (axis: LabelAxis): string => strip ? "" : labelFor(axis);
  switch (field) {
    case "in": prefix = p("in"); body = formatCompactToken(n); break;
    case "out": prefix = p("out"); body = formatCompactToken(n); break;
    case "cached": prefix = p("cacheIn"); body = formatCompactToken(n); break;
    case "total": prefix = p("totalIn"); body = formatCompactToken(n); break;
    // v0.8.x — m_accApiMs now renders `api:<dhms>` to mirror m_apiMs.
    // The accumulator value (accApiMs) is session-cumulative
    // totalApiMs, so the formatted string grows monotonically as
    // the session ages (e.g. "api:5m", "api:1h12m").
    // v0.8.13+ — prefix is configurable via labels.labelApi
    // (labelFor("apiMs")); default "api:" preserves the v0.8.x
    // literal so existing renders stay byte-identical.
    case "apiMs": prefix = p("apiMs"); body = formatRemainingMs(n); break;
    // v0.8.x — m_accApiCalls mirrors m_apiCalls's `calls:N` shape
    // (the value-zero rule says count:0 still renders, since
    // zero is a real measured count, not a "no data" signal).
    // v0.8.13+ — prefix is configurable via labels.labelApiCalls
    // (labelFor("apiCalls")); default "calls:" preserves the
    // v0.8.x literal so existing renders stay byte-identical.
    case "apiCalls": prefix = p("apiCalls"); body = String(n); break;
  }
  return `${prefix}${body}`;
}

// m_accTokenHitRate — session-aggregate formula
// (accTokenCachedIn / (accTokenCachedIn + accTokenIn) * 100). Colored via the
// cacheHitColor palette (good ≥ 80%, warn ≥ 50%, bad < 50%).
// Zero denominator (no input and no cache reads) renders
// "hit:0.0%"; missing-acc placeholder when the slot has never
// been written.
//
// v0.8.x R8 — prefix unified with m_tokenHitRate: both modules
// now render "hit:N%" (was "acc:N%" for the acc variant). The
// acc/sum/per-turn triple shares the same "hit:" prefix so
// users can compose them in a lineTemplate without having to
// re-bind the prefix. The scope distinction is still visible
// via the surrounding context (m_acc* siblings use the same
// default session scope, m_tokenHitRate is per-turn).
//
// v0.8.10-alpha.3 — collapsed. The render pipeline no longer
// computes the ratio (it was: accTokenCachedIn / (accTokenCachedIn
// + accTokenIn) * 100). The data-processor now writes the
// pre-computed ratio to TickStatusValue.accTokenHitRate at every
// setAvg scope (session / project / model) and the module reads
// it straight. Zero-acc case maps to 0 (rendered as "hit:0.0%").
// Missing-slot case → placeholderAcc("hitRate", …).

// m_acc* placeholder shape: "acc:n/a" for plain fields, "acc:n/a%"
// for the hit-rate module. Used when the chosen scope has no
// accumulator written yet. The `scope` arg is currently unused (we
// render the same placeholder regardless of scope) — included so
// the call site is self-documenting and a future tweak that
// distinguishes scopes (e.g. "acc(total):n/a") has a hook.
function placeholderAcc(
  field: "in" | "out" | "cached" | "total" | "apiMs" | "apiCalls" | "hitRate" | "startTime",
  _scope: "session" | "project" | "model",
  stripLabel?: boolean,
): string {
  // v0.8.0+ labels.* — the four token-axis fields read their
  // prefix from labelFor so the placeholder matches the user's
  // configured labelTokenIn / labelTokenOut / labelTokenCachedIn
  // / labelTokenTotalIn.
  // v0.8.13+ — apiMs / apiCalls also go through labelFor so the
  // "api:n/a" / "calls:n/a" placeholders follow the configured
  // labelApiMs / labelApiCalls defaults.
  // v0.8.22+ — hitRate joined the labels namespace too
  // (labels.labelTokenHitRate, default "hit:"), so users can
  // override the per-turn / acc / sum hit-rate prefix as a single
  // knob instead of the v0.8.x hardcoded literal.
  // v0.8.24+ — startTime joined for m_accStartTime. The
  // "start:n/a" placeholder mirrors the in/out/apiMs shape.
  // vX.X.X+ — when stripLabel is on (forwarded from the m_acc*
  // MODULES entry that read ctx.passThrough?.valueOnly === "true"),
  // every prefix collapses to "" so the placeholder reads "n/a" /
  // "n/a%" with no leading label — mirrors the live-render path.
  const p = (axis: LabelAxis): string => stripLabel ? "" : labelFor(axis);
  let prefix: string;
  switch (field) {
    case "in": prefix = p("in"); break;
    case "out": prefix = p("out"); break;
    case "cached": prefix = p("cacheIn"); break;
    case "total": prefix = p("totalIn"); break;
    case "apiMs": prefix = p("apiMs"); break;
    case "apiCalls": prefix = p("apiCalls"); break;
    case "hitRate": prefix = p("hitRate"); break;
    case "startTime": prefix = p("startTime"); break;
  }
  // v0.8.10-alpha.3 — placeholderAcc simplified: no fieldNotShipped
// branch. cache_read absence on stdin no longer triggers the "--"
// shape — the simpler rule is: missing slot → `prefixn/a` for plain
// fields and `prefixn/a%` for hit-rate. Stale color wrapping is
// preserved.
  let body: string;
  if (field === "hitRate") {
    body = `${prefix}n/a%`;
  } else {
    body = `${prefix}n/a`;
  }
  return `${STALE_COLOR}${body}${RESET}`;
}

const MODULES: Record<string, Module> = {
  // v0.4.x — body routes on ctx.providerType. providerType === "balance"
  // gets the dedicated Balance label; providerType === "quota" or
  // "unknown" both get the display-mode label (`used` / `remaining`).
  // "unknown" sharing the quota label is intentional — there's no
  // quota-shaped provider configured, but if the user's display mode
  // is "used" we still want "Usage:" as the prefix. The surrounding
  // m_windowQuota / m_balance modules carry the per-provider `type`
  // filter; m_modeLabel doesn't need to. Returns the label WITHOUT a
  // trailing space — the surrounding s_0 separator token provides spacing.
  m_modeLabel: (c) => wrapPlainDefault("m_modeLabel",
    c.providerType === "balance"
      ? cfg().modeLabels.balance
      : cfg().modeLabels[c.mode],
    undefined),
  // v0.9.0+ — unified m_windowQuota module (replaces v0.5.0–v0.8.x
// `m_window5h` + `m_window7d`). Reads `c.intervals["short"]` (the
// 5-hour default term) and projects it through `intervalToWindow`
// for the gauge render. Inline form accepts `|term|<key>` to pick
// a different interval (legacy `short` / `mid` / `long` still
// work; arbitrary keys like `monthly` are also fine as long as the
// plugin populates that dict slot). The hard-coded "5h" / "7d"
// labels from the v0.8.x renderers are gone — the gauge is data-
// driven, driven entirely by the Interval's `pct` field.
m_windowQuota: Object.assign(
  ((c: RenderContext) => {
    const iv = (c.intervals ?? {})["short"] ?? null;
    if (!iv) return placeholderBare("m_windowQuota", c);
    const w = intervalToWindow(iv);
    if (!w) return placeholderBare("m_windowQuota", c);
    return formatOneChunk(w, c.mode, cfg().bar.width, c.stale);
  }),
  { type: "quota" as const },
),
  // Reset-suffix portion of the shortInterval (default term). The
  // label is read from the live `Interval.label` rather than being
  // hard-coded — so a user with `intervals.shortInterval.label =
  // "5h🕐"` sees their custom label in the placeholder too. The
  // stale+past-due branch reads the same label so the "(n/a<arrow>
  // <label>)" body stays in sync with the active renderer.
m_countdown: Object.assign(
  ((c: RenderContext) => {
    const iv = (c.intervals ?? {})["short"] ?? null;
    if (!iv) return placeholderBare("m_countdown", c);
    const w = intervalToWindow(iv);
    if (!w) return placeholderBare("m_countdown", c);
    if (isStaleAndPastDue(w, c.stale, c.nowMs)) {
      return `${STALE_COLOR}${formatStalePastDueResetSuffix(iv.label, w, c.nowMs)}${RESET}`;
    }
    return wrapPlainDefault("m_countdown", formatOneResetSuffix(iv.label, w, c.nowMs), undefined);
  }),
  { type: "quota" as const },
),
  // v0.9.0+ — quota module. Reads the quota group from
  // `c.intervals["short"]` (default term; bare form), and the
  // chosen `term` slot for the inline form. Renders
  // `<labelQuota>(<interval.label>):<axis>/limit` shape where
  // `<axis>` is `used` by default and `remaining` when
  // `c.mode === "remaining"` (mirrors `m_windowQuota`). The
  // placeholder (rendered when no quota data is present) is
  // `${labelFor("quota")}(<term-label>):--` — bare defaults to
  // `c.intervals["short"]?.label`; inline honors `params.term` so
  // a `m_quota|term|mid` placeholder reads `(7d):--`, not `(5h):--`.
m_quota: Object.assign(
  ((c: RenderContext) => {
    const iv = (c.intervals ?? {})["short"] ?? null;
    if (!iv) return placeholderBare("m_quota", c);
    const parts = renderQuotaParts(iv, c.mode);
    if (!parts) return placeholderBare("m_quota", c);
    return wrapQuotaBody(parts, c.mode, undefined);
  }),
  { type: "quota" as const },
),
  // The DeepSeek balance chunk. v6.x: when there's nothing to
  // render (unavailable / empty / no min), emit a "balance:n/a"
  // placeholder instead of dropping. Aligns with the bare-vs-inline
  // parity rule.
  m_balance: Object.assign(
    ((c: RenderContext) => c.balance ? formatBalanceEntriesColored(c.balance) || placeholderBare("m_balance", c) : placeholderBare("m_balance", c)),
    { type: "balance" as const },
  ),
  // Stale-age annotation. v6.x: when ageMs is missing, emit
  // "age:n/a" placeholder (was: drop). The :nulldrop|true inline
  // override still drops for users wanting v0.3.x semantics.
  m_age: (c) => {
    if (c.ageMs == null) return placeholderBare("m_age", c);
    // v0.6.0+ — dedup against any other m_age that already emitted
    // anywhere in the recursive render tree. The forced-visibility
    // append in renderProviderLine reads the same ref; the FIRST
    // m_age to fire (whichever instance it is) claims the slot,
    // all subsequent instances return null.
    if (c.ageEmittedRef?.value) return null;
    if (c.ageEmittedRef) c.ageEmittedRef.value = true;
    return formatStaleSuffix(c.ageMs, !c.stale);
  },
  // Plugin version (e.g. "v0.2.17"). v6.x: empty version → emit
  // "v:n/a" placeholder (was: drop). Aligns with the bare-vs-inline
  // parity rule.
  m_version: (c) => (c.version ? wrapPlainDefault("m_version", `v${c.version}`, undefined) : placeholderBare("m_version", c)),
  // v0.9.0+ — visual indicator of whether the active provider's
  // plugin was loaded from the bundled built-in tree, from the
  // user's query_plugins/ override dir, or was missing entirely
  // (matched provider id has no plugin — neither user override
  // nor built-in). Glyph comes from the labels namespace
  // (labels.labelPluginSystem / .labelPluginUserDefined /
  // .labelPluginMissing) so users can override via config.json
  // — defaults 📌 / 🎨 / ❗ preserve the v0.9.x ship literals
  // (the ❗ default is new in this round; previously the missing
  // case was silent-drop). No default tint — the symbol carries
  // the meaning on its own, and the statusline has limited color
  // budget. When the source is unknown (no provider matched, or
  // cache row hasn't been written yet), the module returns null
  // and the template drops it. Per the user's "Drop 整个 module"
  // decision 2026-07-11 — we don't emit a "source:n/a"
  // placeholder, so an unconfigured user with this token in
  // their template sees no noise on the statusline.
  // (A 4th branch, "cc" / 🔖, is reserved for the future
  // claude-官方 case — the type axis + default glyph are wired,
  // but the dispatch table doesn't yet read it per the user's
  // "CC 分支暂不做实现" decision 2026-07-12.)
  m_pluginSource: (c) => {
    if (c.pluginSource === "builtin") return labelFor("pluginSystem");
    if (c.pluginSource === "user")    return labelFor("pluginUserDefined");
    if (c.pluginSource === "missing") return labelFor("pluginMissing");
    return null;
  },
  // ----- v0.4.0+ token-usage modules -----
  // Each module is independent and returns null when its source data
  // isn't available, so users compose freely via lineTemplate. The
  // default plan / balance templates do NOT include any of these —
  // existing users see no change on upgrade.

  // Per-API-call input tokens. v0.4.0+ — semantics changed
  // again: from "raw current_usage.input_tokens (absolute)" to
  // "delta of current.input vs the previous tick's snapshot, but
  // ONLY when an actual API call happened between ticks". The
  // same prevTick cache that m_tokenInSpeed uses is read here;
  // the gate is identical (delta_api > 0). When no API call
  // landed, this module renders "in:--" — same stable-slot
  // pattern as the speed modules — so the user can SEE whether
  // the current turn produced output or just sat idle. For the
  // session-cumulative intent, see m_tokenInTotal / m_tokenTotalOut
  // / m_tokenTotalIn.
  m_tokenIn: (c) => {
    const r = computeTickDelta(c, "in");
    // vX.X.X+ — |valueOnly|true strips the leading label from
    // the pre-prefixed r.value (computeTickDelta builds
    // `${labelFor("in")}${body}`).
    const body = stripLabelIfValueOnly(r.value, "in", c.passThrough?.valueOnly === "true");
    // v1.0 — setPrevTick moved to status-store.ts:processTick
    // Stage 3. Render is read-only.
    // v0.8.30+ — bare default tint (brightGreen) on positive
    // value when the tick is active (hasMeasurement=true).
    // Idle ticks (hasMeasurement=false) get STALE_COLOR
    // instead, even when stdin still ships a positive number
    // — the value-zero rule + the per-turn-delta-contract
    // (delta_api=0 → no API call landed) both apply, so the
    // number shown is "live stdin, not a measured delta" and
    // gray-wraps to flag that. 0 and n/a stay plain.
    if (r.numeric == null || r.numeric === 0) return body;
    if (r.stale) return `${STALE_COLOR}${body}${RESET}`;
    return wrapValueDefault("m_tokenIn", r.numeric, body, undefined);
  },
  // Per-API-call output tokens (see m_tokenIn for the gate
  // rationale — output-only turns, thinking-only turns, idle
  // turns all produce different "out:--" / "out:N" signals).
  // v0.8.30+ — bare default tint (red) on positive value; see
  // m_tokenIn for the wrap contract and the STALE_COLOR rule.
  // vX.X.X+ — |valueOnly|true strips the leading label.
  m_tokenOut: (c) => {
    const r = computeTickDelta(c, "out");
    const body = stripLabelIfValueOnly(r.value, "out", c.passThrough?.valueOnly === "true");
    // v1.0 — setPrevTick moved to status-store.ts:processTick
    // Stage 3. Render is read-only.
    if (r.numeric == null || r.numeric === 0) return body;
    if (r.stale) return `${STALE_COLOR}${body}${RESET}`;
    return wrapValueDefault("m_tokenOut", r.numeric, body, undefined);
  },
  // v0.8.0+ — renamed from `m_ctx`. The new semantic: "context
  // size" = `context_window.total_input_tokens` (the cumulative
  // amount of input tokens currently in the context window).
  // Previously `m_ctx` computed `current.input + current.cacheCreation
  // + current.cacheRead` (the per-turn context length). The new
  // semantic is what users mean when they say "size" — the actual
  // occupancy, sourced from the cumulative `total_input_tokens`
  // field. Prefix: `size:<N>`. The capacity (upper bound) is a
  // separate module: `m_contextWindowsSize` (typo preserved per
  // user direction). See [[token-modules-redesign-v0-8-0]].
  //
  // v6.x: zero length renders as "size:0" (the user's "0 直接显示"
  // rule). The placeholder path is reserved for the truly
  // missing-data case (no totals.tokenTotalIn at all).
  // v0.8.23+ — prefix routes through labelFor("contextSize")
  // (labels.labelContextSize; default "size:") so the user can
  // override the context-occupancy prefix without touching the
  // v0.8.22 hardcoded literal.
  m_contextSize: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "size:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("contextSize");
    const total = c.tokens?.totals?.tokenTotalIn;
    if (total == null) return placeholderBare("m_contextSize", c);
    return `${prefix}${formatCompactToken(total)}`;
  },
  // v0.8.0+ — semantic change: per-turn hit rate, not session-aggregate.
  // New formula: m_tokenCachedIn / m_tokenTotalIn (per-turn snapshot)
  //   = current_usage.cache_read_input_tokens / context_window.total_input_tokens
  // The session-aggregate formula
  //   (accTokenCachedIn / (accTokenCachedIn + accTokenIn), v0.4.x semantics) is now
  // exposed as a separate module: m_accTokenHitRate (see
  // [[token-modules-redesign-v0-8-0]]). Coloring still uses the
  // cacheHitColor palette (good ≥ 80%, warn ≥ 50%, bad < 50%).
  //
  // Zero denominator (no input and no cache reads) renders as
  // "hit:0.0%" — the "0 直接显示" rule. Missing-totals or
  // missing-cacheRead → "hit:n/a" placeholder.
  m_tokenHitRate: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "hit:" prefix from
    // every branch (cached fallback, idle-stale, live, zero).
    // v0.9.x — prefix routes through labels.labelTokenHitRate
    // (was hardcoded literal "hit:" in v0.8.x). placeholderBare
    // path already goes through labelFor("hitRate") so the
    // data path catches up here.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("hitRate");
    const t = c.tokens;
    if (!t) return placeholderBare("m_tokenHitRate", c);
    const total = t.totals?.tokenTotalIn;
    const cacheRead = t.current?.tokenCachedIn;
    if (total == null || cacheRead == null) {
      // v0.8.x — mirror m_apiMs / m_tokenInSpeed / m_tokenOutSpeed:
      // when the field is not shipped this tick but a prior
      // measurement sits in the lastActive:tokenHitRate slot
      // within the 60s TTL window, surface it STALE_COLORed
      // instead of dropping to the "hit:n/a" placeholder. The
      // user-facing rationale: the per-turn hit rate is a
      // reading that decays slowly; an idle tick should display
      // the last known value, not blank.
      if (c.tokens?.sessionId) {
        const cached = peekLastTokenHitRate(c.tokens.sessionId, c.tokens.cwd);
        if (cached != null) {
          return wrapPlainDefault(
            "m_tokenHitRate",
            `${prefix}${cached.toFixed(cachePctPrecision())}%`,
            STALE_COLOR,
          );
        }
      }
      return placeholderBare("m_tokenHitRate", c);
    }
    if (total === 0) return `${STALE_COLOR}${prefix}0.0%${RESET}`;
    const pct = (cacheRead / total) * 100;
    // v0.8.x — cache the active measurement so subsequent ticks
    // that lack cacheRead can fall back to it (mirrors setLastSpeed
    // / setLastApiMs). Only persist when the per-tick delta is
    // actually present (the gate above already required cacheRead
    // v1.0 — setLastTokenHitRate moved to status-store.ts:processTick
    // Stage 5. Render is read-only.
    // v0.8.x — "active" coloring: the per-turn hit rate is only
    // a fresh reading when the API actually did work this tick
    // (hasDelta=true from computeAndCacheTickDelta, the same
    // signal m_tokenInSpeed / m_tokenOutSpeed / m_apiMs use to
    // decide STALE_COLOR vs band-color). An idle tick's
    // current.cacheRead is the same value the prior tick had
    // (the field doesn't change when the API is idle), so the
    // displayed rate is "from a previous API call" — gray it,
    // matching the tps siblings. The setLastTokenHitRate above
    // already idempotently overwrites with the same value, so
    // the cache is unaffected by an idle re-render.
    const r = getDeltaForRender();
    // v1.0 — setPrevTick moved to status-store.ts:processTick Stage 3. Render is read-only.
    if (!r.hasMeasurement) {
      return wrapPlainDefault(
        "m_tokenHitRate",
        `${prefix}${pct.toFixed(cachePctPrecision())}%`,
        STALE_COLOR,
      );
    }
    const color = cacheHitColor(pct);
    return `${color}${prefix}${pct.toFixed(cachePctPrecision())}%${RESET}`;
  },
  // v0.8.0+ — renamed from `m_cacheRead`. The old name's `cache`
  // prefix collided conceptually with m_tokenHitRate (which is the
  // session-aggregate hit-rate percentage). The new name lives in
  // the `m_token*` family: it's "this turn's cache-read input
  // tokens", a sibling of m_tokenIn / m_tokenOut / m_tokenTotalIn.
  // See [[token-modules-redesign-v0-8-0]] for the rename rationale.
  //
  // Source: `current_usage.cache_read_input_tokens` (per-turn snapshot,
  // not session-cumulative). Single-color (STALE_COLOR). v6.x: zero
  // reads now render as "cache:0"; null cacheRead field on a present
  // snapshot falls back to placeholder "cache:n/a". The bare-token
  // shape dropped the `(XX%)` share suffix in v0.8.6+ — the
  // dedicated m_tokenHitRate module renders the ratio for users who
  // want it, keeping m_tokenCachedIn focused on the raw token count.
  m_tokenCachedIn: (c) => {
    // v0.8.13 — color unified with the m_token* sibling family:
    // bare form emits PLAIN text (no STALE_COLOR wrap). Matches
    // m_tokenIn / m_tokenOut / m_tokenInTotal / m_tokenTotalOut /
    // m_tokenTotalIn, which all delegate to wrapPlain and render
    // with no SGR by default. The user's `:color|<c>` inline
    // override still applies.
    //
    // v0.8.13 — cacheRead=null (field not shipped by stdin) renders
    // as "cache:0" (same as the real-zero case). The truly
    // missing-snapshot case (tokens=null) also returns "cache:0"
    // (not the placeholder) so the module always reads "cache:N".
    //
    // v0.8.13+ — non-zero / non-null default tint: when
    // cacheRead is a positive number, wrap the chunk in the
    // brown SGR (DEFAULT_COLORS.m_tokenCachedIn). value=0
    // stays plain (the value-zero rule); null already collapsed
    // to "cache:0" above and is also plain.
    // vX.X.X+ — |valueOnly|true drops the leading "cache:" prefix
    // from every branch (live, zero, null-fallback).
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("cacheIn");
    const t = c.tokens?.current;
    if (!t) return `${prefix}0`;
    if (t.tokenCachedIn == null) return `${prefix}0`;
    return wrapValueDefault(
      "m_tokenCachedIn",
      t.tokenCachedIn,
      `${prefix}${formatCompactToken(t.tokenCachedIn)}`,
      undefined,
    );
  },
  // v0.8.40+ — per-turn token cost. Computed from current.* × the
  // active model's price entry (cfg().tokenPrices[ctx.tokens.modelId]).
  // When no entry exists for the active model (the default), the
  // module falls back to placeholder "cost:n/a". Idle ticks mirror
  // m_tokenIn's "live but stale" pattern: cost is calculated from
  // live stdin values and wrapped in STALE_COLOR.
  m_tokenCost: (c) => {
    // v0.8.40+ — |valueOnly|true drops the "cost:" prefix from
    // both the idle-stale branch and the live wrap branch.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("cost");
    const t = c.tokens;
    if (!t || !t.sessionId) return placeholderBare("m_tokenCost", c);
    // v0.9.x — look up the active model's price entry by
    // stdin.model.id. Null on miss → placeholder.
    const tp = resolveTokenPrice(t.modelId ?? null);
    // v0.9.x — miss OR all-zero prices → placeholder (matches
    // the v0.8.40 "unconfigured → cost:n/a" contract; an entry
    // with in/out/cachedIn=0 is still treated as unconfigured).
    if (!tp || tp.in + tp.out + tp.cachedIn <= 0) return placeholderBare("m_tokenCost", c);
    const r = getDeltaForRender();
    const liveIn = t.current.tokenIn ?? 0;
    const liveOut = t.current.tokenOut ?? 0;
    const liveCached = t.current.tokenCachedIn ?? 0;
    // tokenPrices values are per-million-tokens; divide by 1,000,000.
    const liveCost = ((tp.in / 1_000_000) * liveIn) + ((tp.out / 1_000_000) * liveOut) + ((tp.cachedIn / 1_000_000) * liveCached);
    if (!r.hasMeasurement) {
      // Idle tick: live stdin values × price, stale-colored
      return `${STALE_COLOR}${prefix}${formatCostWithCurrency(liveCost, tp.currency)}${RESET}`;
    }
    const cost = ((tp.in / 1_000_000) * r.in) + ((tp.out / 1_000_000) * r.out) + ((tp.cachedIn / 1_000_000) * r.cachedIn);
    return wrapValueDefault("m_tokenCost", cost, `${prefix}${formatCostWithCurrency(cost, tp.currency)}`, undefined);
  },
  // v0.4.0+ — per-API-call input speed. Reads the previous-tick
  // snapshot from cache (keyed by sessionId) and computes
  // delta(current.input) / delta(cost.totalApiDurationMs) * 1000.
  // The bare form (and `:color|scale`) applies the 5-band scale
  // color via speedScaleColor: faster = greener, slower = redder;
  // the `:color|<shortcut|SGR>` form overrides with a single color
  // (e.g. `:color|red`). computeTickSpeed handles the cached /
  // idle case by switching to STALE_COLOR regardless of the
  // caller's color — gray signals "inactive: this measurement is
  // from a previous API call, not this tick".
  m_tokenInSpeed: (c) => {
    // First call with a temporary color to discover the tps
    // (for the active case); the actual rendered value comes
    // from a second call with the proper color. Two
    // computeAndCacheTickDelta calls is fine — the per-render
    // memo makes the second call free.
    const probe = computeTickSpeed(c, "in", STALE_COLOR);
    const color = probe.active
      ? speedScaleColor("in", probe.tps ?? 0)
      : STALE_COLOR; // unused — computeTickSpeed forces STALE
    const r = computeTickSpeed(c, "in", color);
    // vX.X.X+ — |valueOnly|true strips the leading label from
    // computeTickSpeed's pre-prefixed output (e.g. STALE_COLOR
    // + "in:" + format + RESET). The "in:" label sits between
    // the SGR opener and the value; we strip the literal
    // labelFor("inSpeed") substring when valueOnly is set.
    if (c.passThrough?.valueOnly !== "true") return r.value;
    const lbl = labelFor("inSpeed");
    return r.value.includes(lbl) ? r.value.replace(lbl, "") : r.value;
  },
  // v0.4.0+ — per-API-call output speed (see m_tokenInSpeed for
  // the math + drop conditions).
  // vX.X.X+ — |valueOnly|true strips the leading label.
  m_tokenOutSpeed: (c) => {
    const probe = computeTickSpeed(c, "out", STALE_COLOR);
    const color = probe.active
      ? speedScaleColor("out", probe.tps ?? 0)
      : STALE_COLOR;
    const r = computeTickSpeed(c, "out", color);
    if (c.passThrough?.valueOnly !== "true") return r.value;
    const lbl = labelFor("outSpeed");
    return r.value.includes(lbl) ? r.value.replace(lbl, "") : r.value;
  },
  // v0.8.x cwf-tickStatus-v2 — m_totalToken* / m_totalTokenWithCacheIn
  // REMOVED. Use the m_acc* family with scope=session (default):
  //   m_totalTokenIn          → m_accTokenIn
  //   m_totalTokenOut         → m_accTokenOut
  //   m_totalTokenWithCacheIn → m_accTokenCachedIn
  // v0.8.0+ — six per-session/per-model/per-project accumulators
  // (m_accTokenIn / m_accTokenOut / m_accTokenCachedIn /
  // m_accTokenTotalIn / m_accApiMs / m_accTokenHitRate). They all
  // read the three-layer accumulator (session / project / model)
  // via peekAcc and render in the same shape:
  //
  //   m_accTokenIn                 → "in:163.5k"        (session default)
  //   m_accTokenIn:scope:project   → "in:42.3k"         (project cross-session)
  //   m_accTokenIn:scope:model     → "in:12.4k"         (model cross-session)
  //   m_accTokenIn:scope:ccsession → badarg             (REMOVED in this rev)
  //
  // The acc value is a real measured number, not a delta — 0 is
  // rendered as "acc:0" (the value-zero rule). The placeholder path
  // is reserved for the truly-missing-data case (no session, no
  // model for the model scope, no prior accumulator write).
  //
  // These six modules re-use the same accumulator that m_totalToken*
  // / m_tokenInAvg / m_tokenOutAvg maintain — no new tick-side
  // writes. The first valid tick of a session primes the slot;
  // until then, the placeholder fires.
  // v0.8.0+ — the bare m_acc* forms render at the default scope
  // (session if a sessionId exists in the live snapshot, else
  // project). The inline form `m_acc*:scope:<session|project|model>`
  // overrides; the inline path is wired in INLINE_RENDERERS below
  // and uses the same accBody helper for raw fields plus a direct
  // v.accTokenHitRate read for the hit-rate module.
  // v0.8.7+ — when a `scope` is on `ctx.passThrough` (i.e. an outer
  // m_template forwarded it), the bare form honors it the same way
  // the inline form does, so `m_template|<key>|scope|project` can
  // route a bare `m_accTokenIn` (no inline args) to the project
  // scope. Inner-explicit-wins: when the inner token is the inline
  // form `m_accTokenIn|scope|...`, that arg beats the passthrough.
  m_accTokenIn: (c) => {
    // v0.8.30+ — bare default tint (brightGreen) on positive
    // accumulator value. accBody returns the rendered string
    // (or placeholderAcc on a null slot); we read the same slot
    // through peekAcc to drive the wrap decision so the tint
    // matches what gets rendered.
    const scope = passThroughScope(c);
    const useScope = scope ?? "session";
    const v = peekAcc(useScope, c);
    const n = v ? v.accTokenIn : 0;
    return wrapValueDefault("m_accTokenIn", n, accBody(c, "in", scope), undefined);
  },
  m_accTokenOut: (c) => {
    // v0.8.30+ — bare default tint (red) on positive value; see
    // m_accTokenIn for the wrap contract.
    const scope = passThroughScope(c);
    const useScope = scope ?? "session";
    const v = peekAcc(useScope, c);
    const n = v ? v.accTokenOut : 0;
    return wrapValueDefault("m_accTokenOut", n, accBody(c, "out", scope), undefined);
  },
  // v0.8.13+ — non-zero, non-null default tint. accBody returns
  // plain `${prefix}${body}`; the wrap below paints the chunk
  // brown/blue when the underlying slot is a positive number,
  // leaves value=0 plain (value-zero rule), and is unreachable
  // on the null placeholder branch (placeholderAcc already
  // returned inside accBody).
  m_accTokenCachedIn: (c) => {
    const scope = passThroughScope(c);
    const useScope = scope ?? "session";
    const v = peekAcc(useScope, c);
    const n = v ? v.accTokenCachedIn : 0;
    return wrapValueDefault("m_accTokenCachedIn", n, accBody(c, "cached", scope), undefined);
  },
  m_accTokenTotalIn: (c) => {
    const scope = passThroughScope(c);
    const useScope = scope ?? "session";
    const v = peekAcc(useScope, c);
    // accBody computes total as accTokenIn + accTokenCachedIn;
    // mirror that here for the wrap decision so the tint
    // matches the rendered value.
    const n = v ? v.accTokenIn + v.accTokenCachedIn : 0;
    return wrapValueDefault("m_accTokenTotalIn", n, accBody(c, "total", scope), undefined);
  },
  m_accApiMs: (c) => {
    const scope = passThroughScope(c);
    const useScope = scope ?? "session";
    const v = peekAcc(useScope, c);
    const n = v ? v.accApiMs : 0;
    return wrapValueDefault("m_accApiMs", n, accBody(c, "apiMs", scope), undefined);
  },
  // v0.8.x — m_accApiCalls mirrors m_apiCalls (`calls:N`) but reads
  // the chosen scope's accApiCalls slot from status.json. Default
  // scope is session (per-session accumulator; clear-bounded).
  // Inline `m_accApiCalls|scope|project` etc. to widen or narrow.
  // value=0 still renders as `calls:0` (the value-zero rule —
  // count:0 is real data, not a placeholder).
  // v0.8.13+ — non-zero, non-null default tint wraps the chunk
  // cyan via DEFAULT_COLORS.m_accApiCalls.
  m_accApiCalls: (c) => {
    const scope = passThroughScope(c);
    const useScope = scope ?? "session";
    const v = peekAcc(useScope, c);
    const n = v ? v.accApiCalls : 0;
    return wrapValueDefault("m_accApiCalls", n, accBody(c, "apiCalls", scope), undefined);
  },
  // vX.X.X+ — accumulated token cost. Computed at render time from
  // peekAcc(scope).{accTokenIn,accTokenOut,accTokenCachedIn} × tokenPrice.
  // When all prices are zero (the default) the module falls back to
  // placeholder "cost:n/a". Scope resolved via passThrough (default session).
  m_accTokenCost: (c) => {
    // v0.8.40+ — |valueOnly|true drops the "cost:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("cost");
    const scope = passThroughScope(c);
    const useScope = scope ?? "session";
    const v = peekAcc(useScope, c);
    if (!v) return placeholderBare("m_accTokenCost", c);
    // v0.9.x — active-model price entry. The accumulator is
    // per-scope (session/project/model); cost is priced off the
    // CURRENT active model, not the slot's source model. Miss →
    // placeholder.
    const tp = resolveTokenPrice(c.tokens?.modelId ?? null);
    // v0.9.x — miss OR all-zero prices → placeholder (matches
    // the v0.8.40 "unconfigured → cost:n/a" contract).
    if (!tp || tp.in + tp.out + tp.cachedIn <= 0) return placeholderBare("m_accTokenCost", c);
    // tokenPrices values are per-million-tokens; divide by 1,000,000.
    const cost = ((tp.in / 1_000_000) * v.accTokenIn) + ((tp.out / 1_000_000) * v.accTokenOut) + ((tp.cachedIn / 1_000_000) * v.accTokenCachedIn);
    return wrapValueDefault("m_accTokenCost", cost, `${prefix}${formatCostWithCurrency(cost, tp.currency)}`, undefined);
  },
  // v0.8.13+ — m_accTokenInSpeed / m_accTokenOutSpeed — session-
  // cumulative throughput (t/s) computed from the chosen scope's
  // accumulator: accTokenIn / accApiMs * 1000 (or accTokenOut).
  // Mirrors the m_tokenInSpeed / m_tokenOutSpeed contract:
  //   bare form / `:color|scale` / no `:color|` → 5-band scale
  //   color via speedScaleColor (DEFAULT_SPEED_SCALE_BANDS),
  //   faster = greener.
  //   `:color|<shortcut|SGR>` → that exact color.
  //   passive reading (peekAcc returned null → no scope ever
  //   primed) → "direction:n/a" placeholder.
  // Default scope session matches the rest of the m_acc* family;
  // inline `|scope|project` etc. widens/narrows the rollup.
  // Two-call pattern (probe + render) mirrors m_tokenInSpeed so
  // the active case picks the band color from the actual tps.
  m_accTokenInSpeed: (c) => {
    const scope = passThroughScope(c) ?? "session";
    const probe = computeAccSpeed(c, scope, "in", STALE_COLOR);
    const color = probe.active
      ? speedScaleColor("in", probe.tps ?? 0)
      : STALE_COLOR; // unused — computeAccSpeed emits "direction:n/a"
    const r = computeAccSpeed(c, scope, "in", color);
    // vX.X.X+ — |valueOnly|true strips the leading label.
    if (c.passThrough?.valueOnly !== "true") return r.value;
    const lbl = labelFor("inSpeed");
    return r.value.includes(lbl) ? r.value.replace(lbl, "") : r.value;
  },
  m_accTokenOutSpeed: (c) => {
    const scope = passThroughScope(c) ?? "session";
    const probe = computeAccSpeed(c, scope, "out", STALE_COLOR);
    const color = probe.active
      ? speedScaleColor("out", probe.tps ?? 0)
      : STALE_COLOR;
    const r = computeAccSpeed(c, scope, "out", color);
    if (c.passThrough?.valueOnly !== "true") return r.value;
    const lbl = labelFor("outSpeed");
    return r.value.includes(lbl) ? r.value.replace(lbl, "") : r.value;
  },
  // m_accTokenHitRate — session-aggregate formula
  // (accTokenCachedIn / (accTokenCachedIn + accTokenIn) * 100), the v0.4.x semantic
  // that m_tokenHitRate (per-turn) replaced. Coloring uses the
  // cacheHitColor palette. v0.8.x — renamed from m_accCacheHitRate
  // to align the namespace with m_tokenHitRate (per-turn) and
  // m_sumTokenHitRate (cross-project).
  // v0.8.10-alpha.3 — reads TickStatusValue.accTokenHitRate directly
  // (data-processor pre-computes at setAvg time).
  m_accTokenHitRate: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "hit:" prefix.
    // v0.9.x — prefix routes through labels.labelTokenHitRate
    // (was hardcoded literal "hit:" in v0.8.x). placeholderAcc
    // path already goes through labelFor("hitRate") so the
    // data path catches up here.
    const stripLabel = c.passThrough?.valueOnly === "true";
    const useScope = passThroughScope(c) ?? "session";
    const v = peekAcc(useScope, c);
    if (!v) return placeholderAcc("hitRate", useScope, stripLabel);
    const pct = v.accTokenHitRate;
    const color = cacheHitColor(pct);
    const prefix = stripLabel ? "" : labelFor("hitRate");
    return `${color}${prefix}${pct.toFixed(cachePctPrecision())}%${RESET}`;
  },
  // v0.8.24+ — start of the tick statistics window. Reads
  // TickStatusValue.startAt for the chosen scope (default
  // session, matching the other m_acc* modules) and renders
  // `<labelStartTime>HH:MM:SS` (sv-SE locale, 24h clock). The
  // startAt field is first-write-stamped by setAvg; a legacy
  // state.json with no startAt falls through to the
  // `start:n/a` placeholder.
  // v0.8.25+ — bare form honors `passThrough.abs === "true"`
  // (set by an outer `m_template|...|abs|true`) to widen the
  // body to YYYY-MM-DD HH:MM:SS. Default stays HH:MM:SS so
  // existing renders are byte-identical.
  m_accStartTime: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "start:" prefix.
    const stripLabel = c.passThrough?.valueOnly === "true";
    const useScope = passThroughScope(c) ?? "session";
    const v = peekAcc(useScope, c);
    const startAt = v?.startAt ?? null;
    if (startAt == null) return placeholderAcc("startTime", useScope, stripLabel);
    const abs = c.passThrough?.abs === "true";
    const prefix = stripLabel ? "" : labelFor("startTime");
    return `${prefix}${formatAbsTime(startAt, { abs })}`;
  },
  // v0.8.0+ — sum/avg advanced statistics. 5 plain sums (in/out/
  // cached/total/apiMs) + 3 ratios (tokenHitRate + tokenInSpeed +
  // tokenOutSpeed). All default to "|model|active" + "|window|5h"
  // + "|align|true" — the inline form `m_sumTokenIn|window|7d` etc
  // overrides. See parseWindowScope + fetchSumAggregate for the
  // resolution path; results are cached in state/cache.json under
  // the "stat:<model>:<window>:<align>" key (window ∈ {"5h","7d",
  // "all"}) with TTL=300s. sinceMs is derived but not part of the
  // key, capping the cache at 12 entries.
  m_sumTokenIn: (c) => {
    // v0.8.7+ — bare m_sum* reads passThrough from ctx (set by an
    // outer `m_template|<key>|window|...|model|...|align|...`)
    // so the outer axes reach the inner modules without per-token
    // re-declaration. v0.8.14+ — zero-row aggregate renders the
    // "in:n/a" placeholder (was: drop) to mirror m_accTokenIn's
    // placeholderAcc. Empty filter (bad window key) still drops
    // (NOT placeholder — the whole axis is unusable).
    // v0.8.30+ — bare default tint (brightGreen) on positive sum;
    // sum=0 stays plain (value-zero rule).
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumTokenIn", c);
    // vX.X.X+ — |valueOnly|true drops the "in:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("in");
    return wrapValueDefault(
      "m_sumTokenIn",
      agg.sumIn,
      `${prefix}${formatCompactToken(agg.sumIn)}`,
      undefined,
    );
  },
  m_sumTokenOut: (c) => {
    // v0.8.7+ — bare m_sum* reads c.passThrough (forwarded by an outer m_template); v0.8.14+ — zero-row renders placeholder (was: drop)
    // v0.8.30+ — bare default tint (red) on positive sum; see
    // m_sumTokenIn for the wrap contract.
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumTokenOut", c);
    // vX.X.X+ — |valueOnly|true drops the "out:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("out");
    return wrapValueDefault(
      "m_sumTokenOut",
      agg.sumOut,
      `${prefix}${formatCompactToken(agg.sumOut)}`,
      undefined,
    );
  },
  m_sumTokenCachedIn: (c) => {
    // v0.8.7+ — bare m_sum* reads c.passThrough (forwarded by an outer m_template); v0.8.14+ — zero-row renders placeholder (was: drop)
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumTokenCachedIn", c);
    // vX.X.X+ — |valueOnly|true drops the "cache:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("cacheIn");
    // v0.8.13+ — non-zero, non-null default tint (brown) on
    // positive sums; value=0 stays plain (value-zero rule).
    return wrapValueDefault("m_sumTokenCachedIn", agg.sumCached, `${prefix}${formatCompactToken(agg.sumCached)}`, undefined);
  },
  m_sumTokenTotalIn: (c) => {
    // v0.8.7+ — bare m_sum* reads c.passThrough (forwarded by an outer m_template); v0.8.14+ — zero-row renders placeholder (was: drop)
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumTokenTotalIn", c);
    // vX.X.X+ — |valueOnly|true drops the "total:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("totalIn");
    return wrapValueDefault("m_sumTokenTotalIn", agg.sumTotalIn, `${prefix}${formatCompactToken(agg.sumTotalIn)}`, undefined);
  },
  // v0.8.40+ — windowed token cost. Computed from sumIn/Out/Cached ×
  // the model's price entry. When no entry exists for the resolved
  // model id (default) → placeholder.
  m_sumTokenCost: (c) => {
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumTokenCost", c);
    // v0.9.x — explicit |model|<literal> wins; otherwise active
    // model id. |model|all falls back to active (sum-all doesn't
    // make sense for pricing — the price is per-model). When
    // modelFilter is set, use it; else use ctx.tokens.modelId.
    const lookupId = filter.modelFilter !== undefined ? filter.modelFilter : c.tokens?.modelId;
    const tp = resolveTokenPrice(lookupId ?? null);
    // v0.9.x — miss OR all-zero prices → placeholder (matches
    // the v0.8.40 "unconfigured → cost:n/a" contract).
    if (!tp || tp.in + tp.out + tp.cachedIn <= 0) return placeholderBare("m_sumTokenCost", c);
    // v0.8.40+ — |valueOnly|true drops the "cost:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("cost");
    const cost = ((tp.in / 1_000_000) * agg.sumIn) + ((tp.out / 1_000_000) * agg.sumOut) + ((tp.cachedIn / 1_000_000) * agg.sumCached);
    return wrapValueDefault("m_sumTokenCost", cost, `${prefix}${formatCostWithCurrency(cost, tp.currency)}`, undefined);
  },
  m_sumApiMs: (c) => {
    // v0.8.7+ — bare m_sum* reads c.passThrough (forwarded by an outer m_template); v0.8.14+ — zero-row renders placeholder (was: drop)
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumApiMs", c);
    // vX.X.X+ — |valueOnly|true drops the "api:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("apiMs");
    // v0.8.13+ — prefix routes through labelFor(labels.labelApi);
    // default "api:" preserves the v0.8.x literal.
    return wrapValueDefault("m_sumApiMs", agg.sumApiMs, `${prefix}${formatRemainingMs(agg.sumApiMs)}`, undefined);
  },
  // v0.8.x — m_avg* renamed to m_sum* to align the namespace with
  // the cross-project JSONL scan family (m_sumTokenIn/Out/...).
  // m_sumTokenHitRate replaces m_avgCacheHitRate (the SUM-OF-
  // CACHED-OVER-TOTAL formula, NOT the per-turn m_tokenHitRate);
  // m_sumTokenInSpeed / m_sumTokenOutSpeed replace the
  // m_avgTokenInSpeed / m_avgTokenOutSpeed tps averages. The old
  // m_avg* names are REMOVED with no alias (consistent with the
  // v0.8.0 major-bump).
  m_sumTokenHitRate: (c) => {
    // v0.8.7+ — bare m_sum* reads c.passThrough (forwarded by an outer m_template); v0.8.14+ — zero-row renders placeholder (was: drop)
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    const denom = agg.sumIn + agg.sumCached;
    if (agg.rows === 0 || denom === 0) return placeholderBare("m_sumTokenHitRate", c);
    const pct = (agg.sumCached / denom) * 100;
    // vX.X.X+ — |valueOnly|true drops the "hit:" prefix.
    // v0.9.x — prefix routes through labels.labelTokenHitRate
    // (was hardcoded literal "hit:" in v0.8.x).
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("hitRate");
    return `${cacheHitColor(pct)}${prefix}${pct.toFixed(cachePctPrecision())}%${RESET}`;
  },
  m_sumTokenInSpeed: (c) => {
    // v0.8.7+ — bare m_sum* reads c.passThrough (forwarded by an outer m_template); v0.8.14+ — zero-row renders placeholder (was: drop)
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.sumApiMs === 0) return placeholderBare("m_sumTokenInSpeed", c);
    const tps = (agg.sumIn / agg.sumApiMs) * 1000;
    // v0.8.13+ — wrap with the 5-band scale color
    // (DEFAULT_SPEED_SCALE_BANDS.in). Matches the m_tokenInSpeed
    // convention: faster → green, slower → red.
    // v0.8.13+ — prefix routes through labelFor(labels.labelInSpeed)
    // so the speed module is independently configurable from
    // labels.labelIn (default "in:" preserves today's literal).
    // vX.X.X+ — |valueOnly|true drops the "in:" prefix.
    const color = speedScaleColor("in", tps);
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("inSpeed");
    return `${color}${prefix}${formatSpeed(tps)}${RESET}`;
  },
  m_sumTokenOutSpeed: (c) => {
    // v0.8.7+ — bare m_sum* reads c.passThrough (forwarded by an outer m_template); v0.8.14+ — zero-row renders placeholder (was: drop)
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.sumApiMs === 0) return placeholderBare("m_sumTokenOutSpeed", c);
    const tps = (agg.sumOut / agg.sumApiMs) * 1000;
    // v0.8.13+ — prefix routes through labelFor(labels.labelOutSpeed);
    // default "out:" preserves today's literal.
    const color = speedScaleColor("out", tps);
    // vX.X.X+ — |valueOnly|true drops the "out:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("outSpeed");
    return `${color}${prefix}${formatSpeed(tps)}${RESET}`;
  },
  // v0.8.x — total count of API calls (rows with apiMs > 0) in the
  // window. Honors :model|, :window|, :align| like the other
  // m_sum* modules. Despite the family being "sum" (cross-tick
  // aggregate), the value is a COUNT, not a token — kept under the
  // m_sum prefix because the rendering path is the same
  // (windowed cross-project JSONL scan → single cached aggregate).
  m_sumApiCalls: (c) => {
    // v0.8.7+ — bare m_sum* reads c.passThrough (forwarded by an outer m_template); v0.8.14+ — zero-row renders placeholder (was: drop)
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.calls === 0) return placeholderBare("m_sumApiCalls", c);
    // vX.X.X+ — |valueOnly|true drops the "calls:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("apiCalls");
    // v0.8.13+ — non-zero, non-null default tint (cyan) on
    // positive counts; value=0 short-circuits to null above.
    // v0.8.13+ — prefix routes through labelFor(labels.labelApiCalls);
    // default "calls:" preserves the v0.8.x literal.
    return wrapValueDefault("m_sumApiCalls", agg.calls, `${prefix}${agg.calls}`, undefined);
  },
  // v0.8.24+ — start of the tick statistics window across the
  // filtered JSONL rows. Aggregates min(s.startAt) over the
  // window/model/align-filtered sample set (read-once-per-tick
  // from the head line + per-row from coerceSampleRow). Legacy
  // rows (pre-v0.8.24, startAt: null) are filtered out by the
  // aggregate's Number.isFinite gate, so an all-legacy window
  // renders the `start:n/a` placeholder. Pass-through axes from
  // an outer m_template|...| follow the same convention as the
  // other m_sum* modules.
  //
  // v0.8.27+ — when align=true AND the matching ctx Window
  // (fiveHour or weekly) ships resetStartAt, surface the plan
  // window's open instant instead of the empirical
  // min(s.startAt). The plan anchor is the authoritative answer
  // to "when did this window open"; the empirical firstAt is
  // only the oldest captured sample, which can drift earlier
  // than the window for any number of reasons (claude-code
  // process restart at the tail, JSONL rolls over, etc.).
  // align=false (v0.8.26+ default) keeps the empirical reading.
  // resetStartAt missing on the Window → fall back to
  // agg.firstAt (the plan anchor is unavailable, not absent).
  m_sumStartTime: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "start:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("startTime");
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumStartTime", c);
    const abs = c.passThrough?.abs === "true";
    // vX.X.X — align semantics gated on the new `|align|<true|false>`
    // inline arg (default false). When align=true AND the resolved
    // filter came from the declared-windowId branch
    // (`alignActive=true` + `interval!=null`), render the plan's
    // resetStartAt anchor. When align=false (default) OR the resolution
    // fell through to dhms (alignActive=false), keep the empirical
    // min(row.startAt) reading — matches v0.8.26+ default behavior.
    if (filter.alignActive && filter.interval != null) {
      const w = intervalToWindow(filter.interval);
      if (
        w != null &&
        typeof w.resetStartAt === "string" &&
        (w.resetDurationMs ?? 0) > 0
      ) {
        const anchorMs = Date.parse(w.resetStartAt);
        if (Number.isFinite(anchorMs)) {
          return `${prefix}${formatAbsTime(anchorMs, { abs })}`;
        }
      }
    }
    if (!Number.isFinite(agg.firstAt) || agg.firstAt <= 0) {
      return placeholderBare("m_sumStartTime", c);
    }
    return `${prefix}${formatAbsTime(agg.firstAt, { abs })}`;
  },
  // v0.8.24+ — end of the tick statistics window across the
  // filtered JSONL rows. Aggregates max(s.lastAt) over the
  // window/model/align-filtered sample set. lastAt mirrors the
  // row's `at` field (the wall-clock instant of that tick), so
  // max(lastAt) is the "newest tick" in the window — the dual
  // of m_sumStartTime. Empty / all-legacy window → `end:n/a`.
  //
  // v0.8.27+ — when align=true AND the matching ctx Window
  // ships resetAt, surface the plan window's close instant
  // instead of the empirical max(s.lastAt). resetAt is
  // unconditional in slotsToWindow, so this branch fires for
  // every aligned scan in practice (the only miss case is when
  // the Window itself is null, which collapses to the
  // empirical path).
  m_sumEndTime: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "end:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("endTime");
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumEndTime", c);
    const abs = c.passThrough?.abs === "true";
    // vX.X.X — symmetric with m_sumStartTime above. align=true +
    // declared-windowId resolution → plan's resetAt close instant;
    // everything else (align=false default, or dhms / "all"
    // resolution) → empirical max(s.lastAt) fallback. The v0.8.x
    // `alignActive` flag is gone — the resolver emits `alignActive`
    // directly off the resolution path.
    if (filter.alignActive && filter.interval != null) {
      const w = intervalToWindow(filter.interval);
      if (w != null && typeof w.resetAt === "string") {
        const anchorMs = Date.parse(w.resetAt);
        if (Number.isFinite(anchorMs)) {
          return `${prefix}${formatAbsTime(anchorMs, { abs })}`;
        }
      }
    }
    if (!Number.isFinite(agg.lastAt) || agg.lastAt <= 0) {
      return placeholderBare("m_sumEndTime", c);
    }
    return `${prefix}${formatAbsTime(agg.lastAt, { abs })}`;
  },
  // v0.3.6+ — bare `m_quote` (no inline args). Picks a quote from
  // the hourly window and renders it plain (no SGR wrapper). Opt-in
  // — the default plan / balance templates do NOT include it.
  //
  // v0.8.21+ — also renders the entry's `author` as a
  // `--<author>` suffix when one is supplied. Plain `<quote>` is
  // the no-author case. Sanitize + 60-char-budget truncate apply
  // (mirrors the inline renderer's default) so any local entry
  // over the cap is clipped + suffixed with `...`.
  m_quote: (c) => {
    const freq = parseFreq("h");
    if (!freq) return null; // unreachable — "h" is always valid
    const entry = pickQuoteEntry(freq, c.nowMs);
    const quote = truncateQuote(entry.quote, 60);
    const author = entry.author ? truncateQuote(entry.author, 60) : null;
    return author ? `${quote}--${author}` : quote;
  },

  // ----- v0.4.0+ session-info / metadata modules -----
  // These read fields from the live stdin payload. The default
  // plan / balance templates do NOT include any of these — they are
  // strictly opt-in via lineTemplate.

  // Session name (stdin.session_name). v6.x: bare form now emits
  // "n/a" placeholder when missing (was: drop).
  m_session: (c) => c.tokens?.sessionName ? wrapPlainDefault("m_session", c.tokens.sessionName, undefined) : placeholderBare("m_session", c),
  // Model display name (stdin.model.display_name). v6.x: bare
  // form emits "n/a" placeholder when missing.
  m_model: (c) => c.tokens?.modelDisplayName ? wrapPlainDefault("m_model", c.tokens.modelDisplayName, undefined) : placeholderBare("m_model", c),
  // Effort level (stdin.effort, polymorphic — already coerced to
  // string by parseTokenSnapshot). v6.x: bare form emits "n/a"
  // placeholder when missing.
  m_effort: (c) => c.tokens?.effort ? wrapPlainDefault("m_effort", c.tokens.effort, undefined) : placeholderBare("m_effort", c),
  // Repository identity (stdin.workspace.repo). v6.x: when no
  // component is available, emit "n/a" placeholder instead of drop.
  m_repo: (c) => {
    const r = c.tokens?.repo;
    if (!r) return placeholderBare("m_repo", c);
    const parts = [r.host, r.owner, r.name].filter(
      (p): p is string => p != null && p.length > 0,
    );
    return parts.length > 0 ? wrapPlainDefault("m_repo", parts.join("/"), undefined) : placeholderBare("m_repo", c);
  },
  // Claude Code CLI version (stdin.version). v6.x: bare form
  // emits "n/a" placeholder when missing.
  m_ccVersion: (c) => c.tokens?.ccversion ? wrapPlainDefault("m_ccVersion", c.tokens.ccversion, undefined) : placeholderBare("m_ccVersion", c),
  // Current git branch. v6.x: cwd missing / not a git repo /
  // detached HEAD now emit "branch:n/a" placeholder (was: drop).
  m_branch: (c) => readGitInfo(c.tokens?.cwd)?.branch ? wrapPlainDefault("m_branch", readGitInfo(c.tokens!.cwd)!.branch!, undefined) : placeholderBare("m_branch", c),
  // Git working-tree cleanliness indicator. v6.x: missing git
  // info → "git:n/a" placeholder (was: drop).
  m_gitStatus: (c) => {
    const info = readGitInfo(c.tokens?.cwd);
    if (info == null) return placeholderBare("m_gitStatus", c);
    return wrapPlainDefault("m_gitStatus", info.dirty ? "dirty" : "clean", undefined);
  },
  // Deprecated alias — see m_ccVersion above.
  m_ccversion: (c) => c.tokens?.ccversion ? wrapPlainDefault("m_ccversion", c.tokens.ccversion, undefined) : placeholderBare("m_ccversion", c),
  // Session elapsed wall-clock (stdin.cost.total_duration_ms).
  // v6.x: missing field → "--" placeholder (was: drop). 0 ms is
  // a real value and renders as "0s".
  m_sessionDuration: (c) => {
    const ms = c.tokens?.cost.totalDurationMs;
    return ms != null ? wrapPlainDefault("m_sessionDuration", formatRemainingMs(ms), undefined) : placeholderBare("m_sessionDuration", c);
  },
  // Session API-call time (stdin.cost.total_api_duration_ms). v6.x:
  // missing field → "--" placeholder.
  m_sessionApiDuration: (c) => {
    const ms = c.tokens?.cost.totalApiDurationMs;
    return ms != null ? wrapPlainDefault("m_sessionApiDuration", formatRemainingMs(ms), undefined) : placeholderBare("m_sessionApiDuration", c);
  },
  // v0.8.0+ — per-turn delta of cost.totalApiDurationMs rendered
  // as a dhms time string with the configurable labelApi prefix
  // (v0.8.13+; default "api:"). Reuses the shared
  // computeAndCacheTickDelta memo (same r.apiMs that
  // m_tokenIn / m_tokenOut / m_tokenInSpeed read), so the
  // prev-tick baseline is maintained regardless of which
  // per-turn module appears in the user's template.
  //
  // Gate: hasDelta (deltaApi > 0). Idle ticks → "api:n/a"
  // placeholder via PLACEHOLDERS; first tick with prev=0
  // baseline → real value (per the per-turn-delta contract:
  // current_usage IS the per-turn delta, so the safe assumption
  // is prior=0). No snapshot / no sessionId → placeholder.
  //
  // The writeBack path mirrors m_tokenIn / m_tokenOut: when
  // computeAndCacheTickDelta returns a non-null writeBack we
  // fire setPrevTick so the NEXT tick has a fresh baseline.
  // When this module is rendered alone in a template (no other
  // per-turn module), the writeBack here is the only one —
  // still sufficient because setPrevTick is idempotent and the
  // next tick's computeAndCacheTickDelta will overwrite with
  // the freshest snapshot.
  m_apiMs: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "api:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("apiMs");
    const t = c.tokens;
    if (!t || !t.sessionId) return placeholderBare("m_apiMs", c);
    const r = getDeltaForRender();
    // v1.0 — setPrevTick moved to status-store.ts:processTick Stage 3. Render is read-only.
    if (!r.hasMeasurement) {
      // v0.8.x — mirror m_tokenInSpeed/m_tokenOutSpeed: when this
      // tick has no API-call delta, fall back to the last cached
      // deltaApiMs within the 60s TTL window instead of dropping
      // to "api:n/a". The cached value is rendered STALE_COLORed
      // (gray) so the user sees the reading is from a previous
      // API call, not this tick — same convention as the tps
      // siblings. Outside the TTL or with no prior measurement,
      // we still drop to the placeholder.
      const cached = peekLastApiMs(t.sessionId, t.cwd);
      if (cached != null) {
        return wrapPlainDefault(
          "m_apiMs",
          `${prefix}${formatRemainingMs(cached)}`,
          STALE_COLOR,
        );
      }
      return placeholderBare("m_apiMs", c);
    }
    // v1.0 — setLastApiMs moved to status-store.ts:processTick
    // Stage 5. Render is read-only.
    // v0.8.13+ — non-zero, non-null default tint: when the
    // per-turn apiMs delta is a positive number the body is
    // wrapped in the brown SGR (DEFAULT_COLORS.m_apiMs).
    // value=0 stays plain (value-zero rule); STALE_COLOR still
    // wins on the cached/idle branch above.
    // v0.8.13+ — prefix routes through labelFor(labels.labelApi);
    // default "api:" preserves the v0.8.x literal.
    return wrapValueDefault("m_apiMs", r.apiMs, `${prefix}${formatRemainingMs(r.apiMs)}`, undefined);
  },
  // Session-cumulative lines added (stdin.cost.total_lines_added).
  // v6.x: missing field → "+ --" placeholder (was: drop). Zero is
  // a real value and renders as "+ 0".
  m_linesAdded: (c) => {
    const n = c.tokens?.cost.totalLinesAdded;
    return n != null ? wrapPlainDefault("m_linesAdded", `+ ${n}`, undefined) : placeholderBare("m_linesAdded", c);
  },
  // Session-cumulative lines removed. v6.x: missing → "- --".
  m_linesRemoved: (c) => {
    const n = c.tokens?.cost.totalLinesRemoved;
    return n != null ? wrapPlainDefault("m_linesRemoved", `- ${n}`, undefined) : placeholderBare("m_linesRemoved", c);
  },
  // Session-cumulative input tokens (stdin.context_window.total_input_tokens).
  // v6.x: totals.tokenTotalIn=null → "in:n/a" placeholder (was: drop).
  // v0.8.30+ — bare default tint (brightGreen) on positive value;
  // 0 and n/a stay plain per the value-zero rule.
  m_tokenInTotal: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "in:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("in");
    const n = c.tokens?.totals.tokenTotalIn;
    if (n == null) return placeholderBare("m_tokenInTotal", c);
    return wrapValueDefault(
      "m_tokenInTotal",
      n,
      `${prefix}${formatCompactToken(n)}`,
      undefined,
    );
  },
  // Session-cumulative output tokens. v6.x: totals.tokenTotalOut=null →
  // "out:n/a" placeholder. v0.8.0+ — renamed from `m_tokenOutTotal`
  // to `m_tokenTotalOut` so it sits in the `totalOut` family
  // alongside `m_accTokenOut` (in-memory acc) / `m_sumTokenOut`
  // (cross-project sum) / `totalOut` on-disk jsonl column. Source
  // unchanged: reads `tokens.totals.tokenTotalOut` (= stdin
  // `context_window.total_output_tokens`) directly, distinct from
  // `m_accTokenOut`'s in-memory accumulator rollup.
  // v0.8.30+ — bare default tint (red) on positive value.
  m_tokenTotalOut: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "out:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("out");
    const n = c.tokens?.totals.tokenTotalOut;
    if (n == null) return placeholderBare("m_tokenTotalOut", c);
    return wrapValueDefault(
      "m_tokenTotalOut",
      n,
      `${prefix}${formatCompactToken(n)}`,
      undefined,
    );
  },
  // v0.8.0+ — new module added to fix the v0.8.0 contract gap.
  // Source: same as m_tokenInTotal (stdin.context_window.
  // total_input_tokens); the distinguishing semantics is that
  // m_tokenTotalIn is in the total_input family alongside
  // m_accTokenTotalIn / m_sumTokenTotalIn, all sharing the
  // labelTotalIn label. The bare form below is identical to
  // m_tokenInTotal's data path; the two names exist so callers
  // can pick the family whose label matches their config.
  m_tokenTotalIn: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "total:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("totalIn");
    const n = c.tokens?.totals.tokenTotalIn;
    // v0.8.13+ — non-zero, non-null default tint (blue). When
    // totals.tokenTotalIn is a positive number the body is
    // wrapped in DEFAULT_COLORS.m_tokenTotalIn; null → placeholder;
    // 0 stays plain (value-zero rule — same convention as
    // m_tokenCachedIn).
    if (n == null) return placeholderBare("m_tokenTotalIn", c);
    return wrapValueDefault(
      "m_tokenTotalIn",
      n,
      `${prefix}${formatCompactToken(n)}`,
      undefined,
    );
  },
  // Project-wide count of valid API calls since first tick.
  // v6.x: missing cwd → "calls:n/a" placeholder (was: "calls:0").
  // Calls=0 still renders as "calls:0" — the v0.4.x always-render
  // design stays intact. v0.8.13+ — prefix routes through
  // labelFor(labels.labelApiCalls); default "calls:" preserves
  // the v0.8.x literal so existing renders are byte-identical.
  m_apiCalls: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "calls:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("apiCalls");
    const cwd = c.tokens?.cwd;
    if (!cwd) return placeholderBare("m_apiCalls", c);
    const acc = statusStore.readAccumulator("project", { cwd });
    // v0.8.13+ — non-zero, non-null default tint: when the
    // project-wide counter is a positive integer the body is
    // wrapped in DEFAULT_COLORS.m_apiCalls (cyan). "calls:0"
    // stays plain (the value-zero rule — same as
    // m_tokenIn/m_tokenOut "in:0"/"out:0"; see
    // [[render-value-zero-rule]]).
    if (!acc) return `${prefix}0`;
    return wrapValueDefault("m_apiCalls", acc.accApiCalls, `${prefix}${acc.accApiCalls}`, undefined);
  },
  // v0.8.0+ — renamed from `m_contextSize`. The old name now lives
  // at `m_contextSize` with a different source (the cumulative
  // occupancy, see m_contextSize entry above). The new name holds
  // the capacity (upper bound) of the context window. Typo
  // `Widows` is preserved per user direction.
  //
  // Source: `context_window.context_window_size`. v6.x: size=null →
  // "size:n/a" placeholder. v0.8.23+ — prefix routes through
  // labelFor("contextWindowsSize") (labels.labelContextWindowsSize;
  // default "size:").
  m_contextWindowsSize: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "size:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("contextWindowsSize");
    const sz = c.tokens?.contextWindow?.contextWindowSize;
    return sz != null
      ? wrapPlainDefault("m_contextWindowsSize", `${prefix}${formatCompactToken(sz)}`, undefined)
      : placeholderBare("m_contextWindowsSize", c);
  },
  // v0.8.0+ — renamed from `m_contextUsed` (the `Percent` suffix
  // makes the unit explicit and matches m_tokenHitRate's % output
  // style). Source: `context_window.used_percentage`. v6.x:
  // contextUsedPercent=null → "n/a%" placeholder. Zero renders as "0%".
  // v0.8.23+ — prefix routes through labelFor("contextUsedPercent")
  // (labels.labelContextUsedPercent; default "used:").
  m_contextUsedPercent: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "used:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("contextUsedPercent");
    const pct = c.tokens?.contextWindow?.contextUsedPercent;
    return pct != null
      ? wrapPlainDefault("m_contextUsedPercent", `${prefix}${pct}%`, undefined)
      : placeholderBare("m_contextUsedPercent", c);
  },
  // v0.8.0+ — new per-turn module. Sibling of m_contextUsedPercent,
  // rendering the inverse: the unused share of the context window.
  // Source: `context_window.remaining_percentage`. Zero renders
  // as "0%"; null → "remain:n/a%" placeholder. v0.8.23+ — prefix
  // routes through labelFor("contextRemainingPercent")
  // (labels.labelContextRemainingPercent; default "remain:").
  m_contextRemainingPercent: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "remain:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("contextRemainingPercent");
    const pct = c.tokens?.contextWindow?.contextRemainingPercent;
    return pct != null
      ? wrapPlainDefault("m_contextRemainingPercent", `${prefix}${pct}%`, undefined)
      : placeholderBare("m_contextRemainingPercent", c);
  },
  // Context window bar + 5-band-colored percentage. v6.x: bare
  // form now follows the placeholder rule — when the synthetic
  // Window is missing, render the gray gauge placeholder. Zero
  // pct still renders as a 0-value bar (the user's "0 直接显示"
  // rule preserves the natural 0-value render path).
  m_windowContext: (c) =>
    c.contextWindow ? formatOneChunk(c.contextWindow, c.mode, cfg().bar.width, c.stale) : placeholderBare("m_windowContext", c),
  // v0.8.16 — TTL gauge modules. Each picks a TTL-aware entry
  // from its respective cache (response cache for m_cacheTtlStatus,
  // stat cache for m_statTtlStatus), computes remainingFraction =
  // (ttlMs - ageMs) / ttlMs, and emits one of TTL_BAR_CHARS picked
  // by the fraction. Color is computed by ttlStatusColor (5-band
  // palette). v0.9.x — also append a fixed-second TTL suffix
  // ("▆ 23s") via formatTtlSeconds, which intentionally bypasses
  // `timeFormat.minUnit` so the TTL gauge stays second-granular
  // regardless of the global timeFormat. Missing / no-ttlMs
  // entries fall through to the placeholder (single ▆ in
  // STALE_COLOR) with no numeric suffix.
  //
  // v0.9.x — m_cacheTtlStatus reads the ACTIVE provider's cache row
  // (keyed by ctx.currentProvider), NOT the cross-provider freshest.
  // Each provider requests its quota/balance independently on its
  // own clock; reading the freshest across providers leaks the
  // freshness of one provider into another (e.g. a DeepSeek balance
  // update hiding a stale MiniMax quota). The stat cache, by
  // contrast, is process-shared and updated as a whole, so its
  // "freshest" helper is still the right pick for m_statTtlStatus.
  m_cacheTtlStatus: (c) => {
    const key = c.currentProvider;
    if (key == null) return placeholderBare("m_cacheTtlStatus", c);
    const entry = cache.peekWithTtl(key);
    if (!entry || entry.ttlMs <= 0) return placeholderBare("m_cacheTtlStatus", c);
    const remaining = (entry.ttlMs - entry.ageMs) / entry.ttlMs;
    const suffix = formatTtlSeconds(entry.ttlMs - entry.ageMs);
    return `${ttlStatusColor(remaining)}${ttlStatusChar(remaining)}${RESET} ${suffix}`;
  },
  m_statTtlStatus: (c) => {
    const entry = statusStore.peekFreshestStatAgeMs();
    if (!entry || entry.ttlMs <= 0) return placeholderBare("m_statTtlStatus", c);
    const remaining = (entry.ttlMs - entry.ageMs) / entry.ttlMs;
    const suffix = formatTtlSeconds(entry.ttlMs - entry.ageMs);
    return `${ttlStatusColor(remaining)}${ttlStatusChar(remaining)}${RESET} ${suffix}`;
  },
  // v0.8.17+ — system RAM usage. Darwin reads vm_stat; other
  // platforms fall back to os.totalmem() - os.freemem(). Format
  // matches ccstatusline's "Mem:15.9G/63.7G" shape. query failure
  // → "Mem:n/a" placeholder wrapped in STALE_COLOR. value=0 is
  // impossible (os.totalmem is always > 0 on a real machine),
  // so the value-zero rule does not apply here. wrapPlainDefault
  // (not wrapValueDefault) because the body is a string, not a
  // numeric value that needs the value-zero/--branching.
  m_memUsage: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "Mem:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("memUsage");
    const m = getMemUsage();
    if (!m) return placeholderBare("m_memUsage", c);
    return wrapPlainDefault(
      "m_memUsage",
      `${prefix}${formatMemBytes(m.used)}/${formatMemBytes(m.total)}`,
      undefined,
    );
  },
  // v0.8.36+ — system RAM used bar + 5-band-colored percentage.
  // Parallel of m_windowContext (which renders the context-window
  // bar+percent from stdin used_percentage). m_windowMemUsage
  // reads the same getMemUsage() helper as m_memUsage (Darwin:
  // vm_stat; else os.totalmem()/os.freemem()) but normalizes to a
  // 0..100 ratio, wraps it in a synthetic Window, and emits
  // formatOneChunk — so the value color is driven by
  // colorFor(pct, "used") (i.e. thresholds.percentBands, default
  // [60, 70, 80, 90]) and the bar chunk is sized by usedPct. NO
  // label prefix — pure bar+percent shape, matches m_windowContext.
  // m_total <= 0 guard is defensive — os.totalmem is always > 0 on
  // a real machine, but a sandboxed test env could zero it.
  m_windowMemUsage: (c) => {
    const m = getMemUsage();
    if (!m || m.total <= 0) return placeholderBare("m_windowMemUsage", c);
    const pct = (m.used / m.total) * 100;
    return formatOneChunk({ pct } as Window, c.mode, cfg().bar.width, c.stale);
  },
};

// Cap unknown-module warnings to once per process so a template typo
// doesn't spam stderr on every statusline tick (which is every few
// seconds in active sessions). A one-shot warn is enough — the user
// will see it on the first invocation.
let _unknownModuleWarned = false;

// ----- v0.4.0+ token-module helpers -----

// Compact token formatter: <thresholds[0] → raw integer, <thresholds[1]
// → "<x.y>k", else "<x.y>M". Matches formatRemainingMs's tier shape
// but uses token-specific thresholds (default 1k / 1M). Negative or
// non-finite inputs fall back to "0". Exported so tests can pin the
// behavior at threshold boundaries.
export function formatCompactToken(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  const t = cfg().tokenFormat;
  const [lo, hi] = t.thresholds;
  if (n < lo) return String(Math.floor(n));
  if (n < hi) return `${(n / 1_000).toFixed(t.precision)}k`;
  return `${(n / 1_000_000).toFixed(t.precision)}M`;
}

// Speed formatter: t/s with k suffix above 1000. Mirrors ccstatusline's
// formatSpeed. Null → "—". Exported for tests.
export function formatSpeed(tps: number | null): string {
  if (tps == null || !Number.isFinite(tps)) return "—";
  const precision = cfg().tokenFormat.speedPrecision;
  if (Math.abs(tps) >= 1000) {
    return `${(tps / 1000).toFixed(precision)}k t/s`;
  }
  return `${tps.toFixed(precision)} t/s`;
}

// v0.8.40+ — tiered-precision cost formatter for m_tokenCost family.
// At least 2 decimal places, at most 5:
//   < 0.01 → 5dp, < 0.1 → 4dp, < 1 → 3dp, >= 1 → 2dp
// Non-finite / negative → "0.00". Currency-agnostic; the renderer
// wraps with formatCostWithCurrency to attach the per-model prefix.
export function formatCost(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0.00";
  if (n === 0) return "0.00";
  let precision: number;
  if (n < 0.01) precision = 5;
  else if (n < 0.1) precision = 4;
  else if (n < 1) precision = 3;
  else precision = 2;
  return n.toFixed(precision);
}

// v0.9.x — per-model token-price resolver. Returns the configured
// price entry for the given model id (stdin.model.id), or null
// when there's no entry — the caller falls back to cost:n/a
// placeholder. Single source of truth for "is there a price for
// this model?" — sits in render.ts (next to formatCost) because
// the contract is a renderer-level business decision, not a
// schema concern. Keeping config.ts purely about schema and
// validation.
type TokenPriceEntry = { in: number; out: number; cachedIn: number; currency: string };
function resolveTokenPrice(modelId: string | null): TokenPriceEntry | null {
  if (!modelId) return null;
  const m = cfg().tokenPrices;
  if (!m) return null;
  return m[modelId] ?? null;
}

// v0.9.x — currency-aware cost formatter. USD (the historical
// default) renders bare to keep existing renders byte-identical;
// any other currency is prepended with no separator (e.g.
// "￥264.12", "CNY 264.12" — the trailing space is a v0.9.x
// convenience for ASCII codes; v0.9.x drop it for symbol codes
// where a space breaks the visual). Co-located with formatCost
// because the two formatters are a matched pair — formatCost
// produces the digits, this attaches the per-model currency
// prefix.
function formatCostWithCurrency(cost: number, currency: string): string {
  const body = formatCost(cost);
  if (!currency || currency === "USD") return body;
  return `${currency}${body}`;
}

// v0.4.0+ — 5-band color picker for the speed scale.
// Faster = greener; slower = redder. Same color palette
// shape as the existing 5-band gauge modules
// (m_window5h/7d/context): bright green / dark green /
// yellow / orange / red, indexed from the FAST end.
//
// `in` uses 5× the `out` thresholds (per the user's spec:
// out: [10, 20, 40, 80], in: [50, 100, 200, 400]) — input
// streams naturally run hotter than output, so the bands
// are scaled accordingly. The thresholds are config-driven
// (cfg().tokenFormat.speedScaleBands) but the defaults match
// the user-requested bands. Returns an SGR string; the
// caller wraps the value with the RESET suffix.
export function speedScaleColor(
  direction: "in" | "out",
  tps: number,
): string {
  const c = cfg().colors;
  // Same 5-color palette the gauge modules use. Index 0 =
  // fastest (bright green); index 4 = slowest (red).
  const palette = [
    c.brightGreen, // brightest green — fastest
    c.darkGreen,
    c.yellow,
    c.orange,
    c.red,         // red — slowest
  ];
  const bands = direction === "in"
    ? cfg().tokenFormat.speedScaleBands.in
    : cfg().tokenFormat.speedScaleBands.out;
  // bands are sorted ascending; we want to pick the band
  // that the tps falls INTO from the FAST end. tps >= bands[3]
  // → fastest (palette[0]); tps < bands[0] → slowest
  // (palette[4]).
  if (tps >= bands[3]) return palette[0];
  if (tps >= bands[2]) return palette[1];
  if (tps >= bands[1]) return palette[2];
  if (tps >= bands[0]) return palette[3];
  return palette[4];
}

function cachePctPrecision(): number {
  return cfg().tokenFormat.cachePctPrecision;
}

// v0.8.16 — 8-char TTL gauge palette. Index 0 = full TTL, index 7
// = empty. Picked by remainingFraction ∈ [0, 1] via
// `floor((1 - fraction) * 8)` so the visual matches a "filling up"
// bar (top char at max TTL, bottom char at zero TTL).
const TTL_BAR_CHARS = ["█", "▇", "▆", "▅", "▄", "▃", "▂", "▁"] as const;

function ttlStatusChar(remainingFraction: number): string {
  if (!Number.isFinite(remainingFraction) || remainingFraction <= 0) return TTL_BAR_CHARS[7]!;
  if (remainingFraction >= 1) return TTL_BAR_CHARS[0]!;
  const idx = Math.min(7, Math.floor((1 - remainingFraction) * 8));
  return TTL_BAR_CHARS[idx]!;
}

// v0.8.16 — 5-band palette matching speedScaleColor's vocabulary.
// Reuses cfg().colors.* so user config overrides (e.g. redefining
// brightGreen / darkGreen / yellow / orange / red) take effect.
function ttlStatusColor(remainingFraction: number): string {
  const c = cfg().colors;
  if (!Number.isFinite(remainingFraction) || remainingFraction <= 0) return c.red;
  if (remainingFraction > 0.8) return c.brightGreen;
  if (remainingFraction > 0.6) return c.darkGreen;
  if (remainingFraction > 0.4) return c.yellow;
  if (remainingFraction > 0.2) return c.orange;
  return c.red;
}

// 3-band cache-hit color picker (good / warn / bad) using
// cacheHitColors + cacheHitThresholds from config. Exported for tests.
export function cacheHitColor(pct: number): string {
  const [lo, hi] = cfg().tokenFormat.cacheHitThresholds;
  const c = cfg().cacheHitColors;
  if (pct >= hi) return c.good;
  if (pct >= lo) return c.warn;
  return c.bad;
}

// Read samples for the (cwd, session) from the current snapshot,
// filter to the [now - windowMs, now] range, sum the delta between
// the FIRST and LAST sample in the window, and format as
// "<label>:<compact>". Returns null when:
//   - tokens/sessionId/cwd missing
//   - no samples in the window yet (fresh session)
//   - only one sample (can't compute a delta)
// The "first sample baseline + last sample now" approach matches how
// total_input_tokens / total_output_tokens are session-cumulative on
// stdin — delta = (cumulative at end of window) - (cumulative at start
// of window) = tokens used during the window.
//
// v6.x: total===0 (real zero in the window) now returns "label:0"
// instead of null. The user reads "0" as "tracked, nothing in the
// window" — distinct from the missing-data case (no samples) which
// goes through placeholderBare at the call site.
// v0.8.0+ — parse a human duration string into milliseconds.
// Supports "all" (returns the sentinel "all") and any chain of
// `<digits><unit>` where unit ∈ {d, h, m, s}. The chain is
// accumulated in canonical order (d → h → m → s) regardless of
// the input order, so "1m2h" and "2h1m" parse identically.
// Returns null on malformed input (no digits, bad unit, etc.).
//
// Examples:
//   parseDhms("5h")    → 5 * 3600 * 1000
//   parseDhms("7d")    → 7 * 86400 * 1000
//   parseDhms("1h30m") → 1*3600*1000 + 30*60*1000
//   parseDhms("2d12h") → 2*86400*1000 + 12*3600*1000
//   parseDhms("all")   → "all" (sentinel)
//   parseDhms("")      → null
//   parseDhms("5x")    → null
function parseDhms(raw: string | undefined): number | "all" | null {
  if (raw == null) return null;
  if (raw === "all") return "all";
  if (raw.length === 0) return null;
  // Match `<digits><unit>` pairs. The order doesn't matter — we
  // sum into a single accumulator and pick each unit's contribution
  // by its letter. Allows e.g. "5h30m" and "30m5h".
  const re = /(\d+)([dhms])/g;
  let ms = 0;
  let matched = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const n = Number(m[1]);
    const u = m[2];
    if (!Number.isFinite(n) || n <= 0) return null;
    switch (u) {
      case "d": ms += n * 86400 * 1000; break;
      case "h": ms += n * 3600 * 1000; break;
      case "m": ms += n * 60 * 1000; break;
      case "s": ms += n * 1000; break;
    }
    matched += m[0].length;
  }
  if (matched === 0) return null;
  // Trailing junk (e.g. "5hz") is a parse-fail. The whole string
  // must consist of digit/unit pairs.
  if (matched !== raw.length) return null;
  return ms;
}

// vX.X.X — resolve the effective (windowKey, sinceMs, interval,
// alignActive, modelFilter) for a sum/avg scan.
//
//   windowKey   — cache key segment. Either the literal "all"
//                 sentinel, a declared `interval.windowId` (only
//                 when align=true resolves through it; align=false
//                 skips the lookup), or a free-form dhms string.
//                 Each unique windowKey mints its own stat cache
//                 entry under `stat:<modelFilter>:<windowKey>:<alignActive>`.
//
//   sinceMs     — wall-clock anchor for the JSONL scan. Rows with
//                 `at < sinceMs` are filtered out (readAllSamples
//                 + coerceSampleRow both gate on this).
//                 For align-active windowId resolution: sinceMs =
//                 Date.parse(window.resetStartAt) — the plan
//                 window's open instant.
//                 For dhms resolution: sinceMs = ctx.nowMs -
//                 parsedDhmsMs.
//                 For "all": sinceMs = 0.
//
//   interval    — the matched Interval when alignActive is true;
//                 null otherwise. Carried on SumFilter so
//                 m_sumStartTime / m_sumEndTime can render the
//                 plan-anchor without re-walking the three slots.
//                 (Not part of the cache key — same windowKey can
//                 resolve to different Intervals across providers,
//                 but the cache is per-render so this is fine in
//                 practice.)
//
//   alignActive — true iff parseWindowScope resolved through the
//                 declared windowId branch. Wall-clock scans
//                 (align=false + dhms, OR align=true + dhms fall-
//                 through) keep alignActive=false. Required for the
//                 m_sumStartTime/EndTime plan-anchor rendering path.
//
//   modelFilter — undefined (all rows), "active" (current model),
//                 or a literal model name.
type SumFilter = {
  windowKey: string;
  sinceMs: number;
  interval: Interval | null;
  alignActive: boolean;
  modelFilter?: string;
};

// vX.X.X — look up which Interval (if any) declares a given
// windowId. Walks the open-ended `intervals` dict on ctx and
// returns the first that matches. Used by parseWindowScope for the
// `|window|<declaredWindowId>` lookup path so a user can write
// `|window|monthly` against `intervals.monthly.windowId =
// "monthly"` and (with `|align|true`) get the plan-aligned scan.
// v0.9.4 — the `intervals` dict is open, so this lookup hits
// arbitrary keys (not just the v0.9.x three reserved slots).
function matchIntervalByWindowId(
  ctx: RenderContext,
  windowId: string,
): Interval | null {
  for (const iv of Object.values(ctx.intervals ?? {})) {
    if (iv != null && iv.windowId === windowId) return iv;
  }
  return null;
}

function parseWindowScope(
  ctx: RenderContext,
  params: Record<string, ResolvedValue | undefined>,
): SumFilter | null {
  // Resolve model first — shared across every branch below.
  const modelRaw = (params.model as string | undefined) ?? "active";
  let modelFilter: string | undefined;
  if (modelRaw === "all") {
    modelFilter = undefined;
  } else if (modelRaw === "active") {
    // v0.9.x — active-model id (stdin.model.id). Was
    // modelDisplayName in v0.8.x; renamed so the JSONL row filter
    // matches the new sample.model stamp (which now also stamps
    // modelId).
    modelFilter = ctx.tokens?.modelId ?? undefined;
  } else {
    modelFilter = modelRaw;
  }

  // Bare form defaults to "all" (no time anchor) — opposite of the
  // legacy v0.8.x "5h" default. A bare `m_sumTokenIn` now reads
  // the entire cross-project JSONL; explicit `|window|<dhms>` is
  // the opt-in to a time-bounded scan, and `|window|<declaredId>`
  // requires `|align|true` to resolve as a plan-anchored scan.
  // The literal "all" is RESERVED — parseWindowScope uses it as
  // the no-time-anchor sentinel and short-circuits before any
  // windowId lookup, so users CANNOT name an interval
  // `windowId: "all"` (the matchIntervalByWindowId lookup never
  // runs against the reserved string).
  const windowRaw = (params.window as string | undefined) ?? "all";

  // v0.8.27 default was `true`; v0.8.26 flipped it to `false`;
  // vX.X.X restores the explicit opt-in form (default false),
  // matching the discipline of |abs| / |nulldrop| — alignment is
  // a deliberate choice, not an accident of resolution.
  const alignRaw = (params.align as string | undefined) ?? "false";
  const alignWanted = alignRaw === "true";

  // "all" sentinel: short-circuit BEFORE any windowId check so the
  // reserved "all" id can never collide with a declared
  // interval.windowId of the same name. Behaves identically to
  // v0.8.x for this case: scan everything since epoch.
  if (windowRaw === "all") {
    return {
      windowKey: "all",
      sinceMs: 0,
      interval: null,
      alignActive: false,
      modelFilter,
    };
  }

  // Branch A — align=true: try the declared-windowId lookup
  // first. On match with a valid resetStartAt, run a
  // plan-aligned scan; on miss (or matched-but-no-anchor) fall
  // through to dhms if parseable.
  if (alignWanted) {
    const matchedIv = matchIntervalByWindowId(ctx, windowRaw);
    if (matchedIv != null) {
      const w = intervalToWindow(matchedIv);
      if (
        w != null &&
        typeof w.resetStartAt === "string" &&
        typeof w.resetDurationMs === "number" &&
        w.resetDurationMs > 0
      ) {
        const anchorMs = Date.parse(w.resetStartAt);
        if (Number.isFinite(anchorMs)) {
          return {
            windowKey: windowRaw,
            sinceMs: anchorMs,
            interval: matchedIv,
            alignActive: true,
            modelFilter,
          };
        }
      }
    }
  }

  // Branch B — dhms: the wall-clock fallback. align=true + windowId
  // miss lands here; align=false ALWAYS lands here (no windowId
  // lookup at all, so users who wrote `|window|monthly` with
  // `|align|false` will drop with the warn below).
  const dhmsMs = parseDhms(windowRaw);
  if (typeof dhmsMs === "number" && dhmsMs > 0) {
    return {
      windowKey: windowRaw,
      sinceMs: ctx.nowMs - dhmsMs,
      interval: null,
      alignActive: false,
      modelFilter,
    };
  }

  // Drop + warn. The user can recover by either:
  //   - opt into align=true (so windowId lookup runs) and ensure
  //     the value is a configured interval.windowId; OR
  //   - rewrite as a parseable dhms duration.
  warn(
    `m_sum*|window "${windowRaw}" is not parseable as dhms` +
    (alignWanted ? "" : ` (and align=false skips the interval.windowId lookup); pass |window|<dhms>` +
    ` or |window|<declared interval.windowId>|align|true to fix`) +
    `; dropping the module.`,
  );
  return null;
}

// v0.8.12 — resetStartAt is an ISO string in Window (see src/types.ts
// Window.resetStartAt: string | null). Earlier revision of
// parseWindowScope type-checked `typeof w.resetStartAt === "number"`
// which never matched; aligned mode silently fell through to the
// wall-clock fallback (nowMs - 5h / nowMs - 7d), inflating m_sum*
// totals to the full wall-clock window. Fixed in v0.8.12: parse
// the ISO string with Date.parse and gate on Number.isFinite so a
// bad string falls back to wall-clock instead of NaN-poisoning the
// scan.
// the StatAggregate dict below. ReadAllSamples is called with the
// resolved sinceMs and applies a mtime pre-filter to skip stale
// files before opening them.
type StatAggregate = statusStore.StatAggregate;

function fetchSumAggregate(filter: SumFilter): StatAggregate {
  return statusStore.getStatAggregate(filter);
}


function warnUnknownModuleOnce(name: string): void {
  if (_unknownModuleWarned) return;
  _unknownModuleWarned = true;
  process.stderr.write(`topgauge: unknown lineTemplate module '${name}'; ignoring\n`);
}

// Reset the once-per-process warn flag. Exported so tests can clear
// it between cases and observe the warning on demand.
export function __resetUnknownModuleWarnForTest(): void {
  _unknownModuleWarned = false;
}

// Expand a template into rendered lines. Each output element is one
// rendered line — separators and module pieces that contain "\n" are
// split into separate line segments. Empty segments are dropped so a
// trailing "\n" separator doesn't emit a blank line at the end.
//
// Modules that return null (or "") cause their immediately adjacent
// s_N tokens to be skipped too — see the comment on RenderContext for
// the reasoning. Empty segments from the splitting pass get the same
// treatment.
// ----- v0.3.3+ inline-args tokens -----
//
// Three token forms now take colon-delimited parameters:
//
//   s_<n>[:color|<c>]
//   m_label:<string>[:color|<c>]
//   m_modeLabel[:color|<c>]
//
// General grammar: <prefix>(:<param>:<value>)*. Even segment count is
// required after the prefix; odd counts drop the token. Every
// (param, value) pair must be in the prefix's registered schema;
// unknown params drop the token. The renderer for the prefix takes the
// resolved { param: value } object plus the render context and returns
// the chunk text (or null to drop).
//
// Future parameterized modules (m_model, …) plug in by adding an entry
// to both INLINE_SCHEMAS and INLINE_RENDERERS. The bare <prefix> form
// (no colon) still routes through MODULES as before — so existing
// templates using bare `m_modeLabel` / `s_0` keep working byte-for-byte.

// v6.x — additional named SGR constants for the per-module default
// colors below. These are 256-color SGR strings (not theme-driven),
// chosen to be visually distinguishable from each other AND from
// the 5-band palette so DEFAULT_COLORS entries read as "this module's
// natural tint" rather than blending with the threshold colors.
const NAMED_PALETTE: Record<string, string> = {
  cyan: "\x1b[38;5;51m",         // bright cyan
  blue: "\x1b[38;5;33m",         // mid blue
  magenta: "\x1b[38;5;201m",     // hot pink/magenta
  purple: "\x1b[38;5;141m",      // violet
  teal: "\x1b[38;5;80m",         // dim teal
  brown: "\x1b[38;5;130m",       // earth brown
  gray: "\x1b[38;5;245m",        // mid gray (different from stale's dark gray)
  lavender: "\x1b[38;5;183m",    // soft lavender
};

// v6.x — DEFAULT_COLORS maps each non-numeric m_* module to its
// hardcoded default tint. Numeric modules (5-band / speed-scale /
// gauge / cache-hit) keep their existing color logic and are NOT in
// this map. The dispatcher / INLINE_RENDERERS use this as a fallback
// when `params.color` is empty — so users always see SOME color on
// bare-form modules, and `|color|<c>` overrides as before.
const DEFAULT_COLORS: Record<string, string> = {
  // String-class identifiers / metadata
  m_session: NAMED_PALETTE.purple,
  m_model: NAMED_PALETTE.cyan,
  m_effort: NAMED_PALETTE.magenta,
  m_repo: NAMED_PALETTE.blue,
  m_branch: NAMED_PALETTE.teal,
  m_gitStatus: NAMED_PALETTE.brown,
  m_ccVersion: NAMED_PALETTE.gray,
  m_ccversion: NAMED_PALETTE.gray, // deprecated alias — same color
  m_age: NAMED_PALETTE.stale,      // (already STALE_COLOR-shaped)
  m_version: NAMED_PALETTE.gray,
  m_balance: NAMED_PALETTE.lavender,
  m_modeLabel: NAMED_PALETTE.stale,
  m_label: NAMED_PALETTE.cyan,
  // Duration / count class (numeric but NOT 5-band / scale)
  m_sessionDuration: NAMED_PALETTE.brown,
  m_sessionApiDuration: NAMED_PALETTE.brown,
  // v0.8.0+ — per-turn delta of cost.totalApiDurationMs,
  // formatted as a dhms time string ("api:5s" / "api:1m30s").
  // Brown matches the existing time-format family; the "api:"
  // prefix is hardcoded (not part of the labels.* axis set).
  //
  // v0.8.13+ — non-zero, non-null default tint: m_apiMs
  // (per-turn delta), m_accApiMs (session-cumulative), and
  // m_sumApiMs (cross-project windowed) all share the brown
  // SGR whenever the underlying value is a positive number;
  // value=0 stays plain (the value-zero rule at
  // [[render-value-zero-rule]]), null falls through to the
  // STALE_COLORed placeholder path.
  m_apiMs: NAMED_PALETTE.brown,
  m_accApiMs: NAMED_PALETTE.brown,
  m_sumApiMs: NAMED_PALETTE.brown,
  m_linesAdded: "\x1b[1;38;5;22m",   // bold + dark green (muted git-style added)
  m_linesRemoved: "\x1b[1;38;5;88m", // bold + dim red (muted git-style removed)
  // m_apiCalls (per-turn project-wide counter), m_accApiCalls
  // (session/project/model accumulator), and m_sumApiCalls
  // (windowed cross-project count) all share the cyan SGR on
  // positive values; "calls:0" stays plain.
  m_apiCalls: NAMED_PALETTE.cyan,
  m_accApiCalls: NAMED_PALETTE.cyan,
  m_sumApiCalls: NAMED_PALETTE.cyan,
  // v0.8.30+ — m_tokenIn / m_tokenOut family default tint.
  // Reuses the 5-band palette colors (brightGreen = 0% band,
  // red = 80% band) so a user who customizes the threshold
  // colors gets consistent flow indicators automatically.
  // Resolved from configStore at module load (mirrors
  // LABEL_COLOR_SHORTCUTS below); helpers that need to honor
  // a runtime colors.* override call resolveTokenFlowColor()
  // instead of reading DEFAULT_COLORS directly.
  m_tokenIn: configStore.get().colors.brightGreen,
  m_tokenOut: configStore.get().colors.red,
  m_tokenInTotal: configStore.get().colors.brightGreen,
  m_tokenTotalOut: configStore.get().colors.red,
  m_accTokenIn: configStore.get().colors.brightGreen,
  m_accTokenOut: configStore.get().colors.red,
  m_sumTokenIn: configStore.get().colors.brightGreen,
  m_sumTokenOut: configStore.get().colors.red,
  m_countdown: NAMED_PALETTE.teal,
  m_contextSize: NAMED_PALETTE.gray,
  m_contextWindowsSize: NAMED_PALETTE.gray,
  m_contextUsedPercent: NAMED_PALETTE.gray,
  m_contextRemainingPercent: NAMED_PALETTE.gray,
  // v0.8.24+ — start/end time of the tick statistics window.
  // Gray = "neutral data" (matches the context-window family);
  // the user's labels.labelStartTime / labels.labelEndTime knob
  // controls the literal prefix ("start:" / "end:" defaults).
  m_accStartTime: NAMED_PALETTE.gray,
  m_sumStartTime: NAMED_PALETTE.gray,
  m_sumEndTime: NAMED_PALETTE.gray,
  // v0.8.0+ — m_acc* family. The two plain numeric in/out
  // accumulators had STALE_COLOR (gray) here in v0.8.x —
  // "data" rather than "status". v0.8.30+ moved them to
  // brightGreen / red up top alongside their m_tokenIn /
  // m_tokenOut siblings, so the in-flow / out-flow tint
  // applies to the bare and inline forms. m_accTokenCachedIn
  // / m_accTokenTotalIn are upgraded to brown / blue (v0.8.13+)
  // for the non-zero-non-null rule; m_accTokenHitRate is
  // governed by the band-based cacheHitColor helper, so the
  // DEFAULT_COLORS entry is moot for the value but keeps the
  // dispatcher / inline path happy.
  // v0.8.13+ — non-zero, non-null default tint family. Brown is
  // the cache-token hue (matches the time-format family); blue
  // is the total-input hue (sits in the input-family row).
  m_tokenCachedIn: NAMED_PALETTE.brown,
  m_tokenTotalIn: NAMED_PALETTE.blue,
  m_accTokenCachedIn: NAMED_PALETTE.brown,
  m_accTokenTotalIn: NAMED_PALETTE.blue,
  m_sumTokenCachedIn: NAMED_PALETTE.brown,
  m_sumTokenTotalIn: NAMED_PALETTE.blue,
  m_accTokenHitRate: NAMED_PALETTE.stale,
  // v0.8.17+ — system RAM usage. Default cyan matches ccstatusline's
  // "Mem:..." widget hue so users migrating from ccstatusline get
  // a familiar color until they override.
  m_memUsage: NAMED_PALETTE.cyan,
  // v0.8.36+ — m_windowMemUsage. Moot for the value tint (the
  // renderer uses colorFor(pct, "used") not wrapPlainDefault),
  // but kept so the dispatcher doesn't warn on bare-form paths
  // that defensively index DEFAULT_COLORS. Mirrors m_memUsage
  // cyan so an upgrade preserves a familiar hue.
  m_windowMemUsage: NAMED_PALETTE.cyan,
  // vX.X.X+ — cost module default tint. Gold/yellow from the
  // config-driven palette — monetary values sit in the yellow/
  // orange family, distinct from the green/red/blue/brown of
  // the existing token-flow modules.
  m_tokenCost: configStore.get().colors.yellow,
  m_accTokenCost: configStore.get().colors.yellow,
  m_sumTokenCost: configStore.get().colors.yellow,
};

// Snapshot of `cfg().colors` + the `brightBlack` input shortcut. Read
// once at module load so render hot paths don't touch configStore per
// call. Mirrors the pattern at lines 56-63.
const LABEL_COLOR_SHORTCUTS: Record<string, string> = (() => {
  const c = configStore.get().colors;
  return {
    brightGreen: c.brightGreen,
    darkGreen: c.darkGreen,
    yellow: c.yellow,
    orange: c.orange,
    red: c.red,
    stale: c.stale,
    brightBlack: "\x1b[90m",
    // v6.x — additional named shortcuts exposed via `:color|<name>`
    // (e.g. `:color|cyan` on a string module). Identical to the
    // entries in NAMED_PALETTE; duplicated here so resolveColor can
    // look them up without scanning NAMED_PALETTE separately.
    cyan: NAMED_PALETTE.cyan,
    blue: NAMED_PALETTE.blue,
    magenta: NAMED_PALETTE.magenta,
    purple: NAMED_PALETTE.purple,
    teal: NAMED_PALETTE.teal,
    brown: NAMED_PALETTE.brown,
    gray: NAMED_PALETTE.gray,
    lavender: NAMED_PALETTE.lavender,
  };
})();

// Pure resolver for `<colorvalue>`. Accepts shortcut names and raw
// SGR strings (`\x1b[…m`). Returns null on anything else so the
// caller can warn + soft-fallback to plain text.
//
// v0.3.5+: the SPECIAL shortcut set (rainbow / rand-rainbow / hue)
// is NOT returned by this resolver — those need per-text processing
// (buildRainbow / buildHue from src/quotes.ts), not a single SGR
// string. They're handled at a higher level by `applyColor` below.
// This resolver only validates shortcut-as-SGR and raw-SGR strings.
// v0.4.0+ — sentinel string returned by resolveColor when the
// user writes `:color|scale`. The speed-module renderers
// (m_tokenInSpeed / m_tokenOutSpeed, both bare default and
// inline) detect this token and replace it with the per-band
// scale color via speedScaleColor(). For all other modules
// the value behaves as opaque — they'd never see it because
// their schema doesn't accept a custom color palette, and
// resolving it to the literal string means a bug in the
// caller that swallows it just renders uncolored (the SGR
// would be invalid, but the chunk would still display).
const SCALE_COLOR_SENTINEL = "__SCALE__";

function resolveColor(value: string): string | null {
  if (value === "scale") return SCALE_COLOR_SENTINEL;
  if (LABEL_COLOR_SHORTCUTS[value]) return LABEL_COLOR_SHORTCUTS[value];
  if (/^\x1b\[[0-9;]*m$/.test(value)) return value;
  return null;
}

// Tagged result for the higher-level `resolveColorParam` (used by
// m_quote and any other future module that wants the
// rainbow/hue shortcuts). Not exported via INLINE_SCHEMAS's
// `ParamResolver` return type (which is `ResolvedValue | null`,
// i.e. string | number | null) — the m_quote schema's `color`
// resolver does a string-tag instead, and the renderer recognizes
// the 3 magic strings as "apply buildRainbow / buildHue".
type ColorParam =
  | { kind: "sgr"; value: string } // wrap text with `<sgr>…<RESET>`
  | { kind: "rainbow"; salt: number } // per-char SGR; salt offsets the rotation
  | { kind: "hue" } // single-hue wrap from buildHue
  | { kind: "none" };

// Resolve the full `<colorvalue>` namespace: shortcut names, raw
// SGR strings, plus the 3 special values. Returns a tagged result
// the renderer pattern-matches against. Same null-on-bad-value
// contract as `resolveColor` so the dispatcher can warn + drop.
export function resolveColorParam(value: string): ColorParam | null {
  if (value === "rainbow") return { kind: "rainbow", salt: 0 };
  if (value === "rand-rainbow") return { kind: "rainbow", salt: 1 };
  if (value === "hue") return { kind: "hue" };
  const sgr = resolveColor(value);
  if (sgr === null) return null;
  return { kind: "sgr", value: sgr };
}

// Apply a resolved ColorParam to a plain-text body. Used by
// m_quote (and any future module that opts into the full color
// grammar). Safe ONLY for plain-text bodies — colored bodies must
// use their override-aware helpers (e.g. formatOneChunkColored).
//
// The `seed` argument seeds rainbow / hue color generation so a
// caller can tie color choice to a frequency window (same window
// → same color). Callers that don't care about per-window color
// stability can pass 0.
export function applyColor(
  body: string,
  param: ColorParam,
  seed: number,
): string {
  if (body === "") return body;
  switch (param.kind) {
    case "sgr":
      return `${param.value}${body}${RESET}`;
    case "rainbow":
      return buildRainbow(body, seed + param.salt);
    case "hue":
      return buildHue(body, seed);
    case "none":
      return body;
  }
}

// Encode a ColorParam as a string so it round-trips through the
// generic `params.color: string` channel that INLINE_RENDERERS uses.
// The decoder is `paramFromString`. This keeps the existing
// ResolvedValue = string | number contract intact.
const COLOR_KIND_SGR = "\x00COLOR:sgr:";
const COLOR_KIND_RAINBOW = "\x00COLOR:rainbow:";
const COLOR_KIND_HUE = "\x00COLOR:hue:";

export function encodeColorParam(p: ColorParam): string {
  switch (p.kind) {
    case "sgr":
      return COLOR_KIND_SGR + p.value;
    case "rainbow":
      return COLOR_KIND_RAINBOW + String(p.salt);
    case "hue":
      return COLOR_KIND_HUE;
    case "none":
      return "";
  }
}

export function decodeColorParam(encoded: string | undefined): ColorParam {
  if (encoded === undefined || encoded === "") return { kind: "none" };
  if (encoded.startsWith(COLOR_KIND_SGR)) {
    return { kind: "sgr", value: encoded.slice(COLOR_KIND_SGR.length) };
  }
  if (encoded.startsWith(COLOR_KIND_RAINBOW)) {
    const salt = Number(encoded.slice(COLOR_KIND_RAINBOW.length));
    return { kind: "rainbow", salt: Number.isFinite(salt) ? salt : 0 };
  }
  if (encoded.startsWith(COLOR_KIND_HUE)) {
    return { kind: "hue" };
  }
  // Fallback: treat the string as a raw SGR. (Shouldn't happen
  // since the resolver validates, but defensive.)
  return { kind: "sgr", value: encoded };
}

type ResolvedValue = string | number;

type ParamResolver = (raw: string) => ResolvedValue | null;

// Sentinel: renderers return this to signal "args parsed fine but
// semantically invalid" (e.g. m_label with an empty string, s_<n>
// with an out-of-range index). The dispatcher warns once on this;
// a plain null is treated as "no data to show" (silent drop, same
// as the bare MODULES path).
const INLINE_BADARG = Symbol("inline-badarg");

type InlineRenderer = (
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
) => string | null | typeof INLINE_BADARG;

// Per-prefix inline schema. The first segment after the prefix is the
// value of the implicit param (`implicit`). Subsequent segments come in
// `name:value` pairs resolved against `named`. Future parameterized
// modules (m_model, …) plug in here.
type InlineSchema = {
  implicit?: { name: string; resolver: ParamResolver };
  named: Record<string, ParamResolver>;
};

// v0.3.3+: every existing module accepts an optional `|color|<c>`
// override via inline-args. The named param is `color` for all of
// them — same shortcut table and raw-SGR rules as `m_label`.
//
// For modules that emit plain text (no internal SGR), the override
// is a simple wrap. For modules that already apply a band-based /
// single-color SGR (m_window5h/7d, m_balance, m_tokenHitRate,
// m_cacheRead, m_age, m_tokenInSpeed, m_tokenOutSpeed), the override
// REPLACES the natural color choice — the user's `color` always wins.
// (Per spec: "如果与现有颜色方案冲突，则无视该参数" — interpreted as
// "if the user explicitly asked for a color, ignore the natural
// scheme in favor of theirs".)
const COLOR_PARAM = {
  named: {
    color: (raw: string) => resolveColor(raw),
  },
} as const;

// v0.4.0+ — per-module null-drop override. Accepts "true" or "false"
// verbatim; anything else is a parse-fail and the inline token is
// dropped (same as :color|<garbage>). Semantics:
//
//   nulldrop omitted / nulldrop:false  → DEFAULT. Force a stable
//     placeholder when the data is missing — the module ALWAYS
//     renders, regardless of whether the underlying field is null.
//     This keeps the line layout stable across ticks and matches
//     the user's expectation that an explicitly-listed module in
//     lineTemplate should occupy its slot.
//   nulldrop:true                      → opt out of the placeholder
//     and preserve the v0.3.x "drop on null" behavior. The module
//     disappears and adjacent separators are skipped.
//
// The bare MODULES path (no inline args) keeps the original drop
// semantics — bare `m_contextSize` (or any m_token* module) still
// drops on null. To get the placeholder behavior the user must
// use the inline form `m_contextSize` (which now defaults to
// placeholder — see above). This is a BREAKING change for any
// existing inline template that lists a module whose value is
// sometimes null (the slot is now always
// visible). Users who want the old drop behavior add
// `:nulldrop|true` to those tokens.
//
// Placeholder shape per module (see PLACEHOLDERS in render.ts
// for the dispatch):
//   pure-number modules        → STALE_COLOR wrap on "n/a" (e.g.
//                                "in:n/a", "ctx:n/a", "cache:n/a")
//   number+unit modules        → STALE_COLOR wrap on "-- <unit>"
//                                (e.g. "5h:--", "session:--", "+ --")
//   gauge modules              → STALE_COLOR wrap on
//                                "░░░░░░░░ 0%" (parallel to the
//                                natural 0-value render)
//   bare-string modules        → STALE_COLOR wrap on "n/a"
// v0.8.21+ — m_quote `wrap` param. v0.9.x redesign: char-pair
// instead of bool. Empty/missing value is a no-op (raw text
// rendered as-is); one printable char duplicates to a 2-char
// pair (e.g. `wrap=~` → `~~`, applied as `<text>`); two-or-more
// printable chars take the first two (e.g. `wrap=ab…` → `ab`).
// Left wrap = pair[0], right wrap = pair[1]. Non-printable
// (control / non-ASCII / 0x7F DEL) is badarg. Applies to BOTH
// local and address-mode (was address-only in v0.8.21+ — the
// asymmetry is the reason for the redesign). The pair rides
// through `applyColor` so wrap chars inherit the same tint as
// the body (mirror the v0.8.44 `|wrap:<chars>|` bucket-D
// convention).
const QUOTE_WRAP_CHARS_PARAM = {
  named: {
    wrap: (raw: string): ResolvedValue | null => {
      // Empty = no-op sentinel (returned so params.wrap is
      // defined-but-empty, which the renderer reads as "skip
      // wrapping"). Caller must distinguish empty (no-op) from
      // missing (also no-op) by checking the raw value's length.
      if (raw === "") return raw;
      // Take first two characters; if only one is supplied,
      // duplicate it (so `wrap=~` ≡ `wrap=~~`).
      let pair: string;
      if (raw.length === 1) {
        pair = raw + raw;
      } else if (raw.length >= 2) {
        pair = raw.slice(0, 2);
      } else {
        return null;
      }
      // Both must be printable ASCII (0x21..0x7E). Anything else
      // — control chars, whitespace, DEL, non-ASCII — is badarg.
      for (let i = 0; i < 2; i++) {
        const code = pair.charCodeAt(i);
        if (code < 0x21 || code > 0x7e) return null;
      }
      return pair;
    },
  },
} as const;

const NULDROP_PARAM = {
  named: {
    nulldrop: (raw: string): ResolvedValue | null =>
      raw === "true" || raw === "false" ? raw : null,
  },
} as const;

// v0.7.2+ — separator `repeat` parameter. Multiplies the rendered
// body N times so a single token can emit e.g. 3 spaces (`s_space|
// repeat|3` → `"   "`). Capped at 8 to keep a runaway config from
// blowing up the statusline width. Default 1 when omitted. Out-of-
// range (non-integer, < 1, or > 8) is a badarg → warn + drop.
const SEP_REPEAT_MAX = 8;
const REPEAT_PARAM = {
  named: {
    repeat: (raw: string): ResolvedValue | null => {
      if (!/^[0-9]+$/.test(raw)) return null;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > SEP_REPEAT_MAX) return null;
      return raw;
    },
  },
} as const;

// v0.7.2+ — separator `wrap` parameter. Default `true`. When true,
// bodies that are NOT whitespace/control get padded with one
// space on each side (so `s_dot|wrap|true` renders ` · ` instead
// of just `·`). Bodies that are pure whitespace/control
// (`s_space`, `s_tab`, `s_newline`, and any array entry that's
// a single ASCII whitespace or NUL/STP/etc.) are returned
// as-is regardless — wrapping would either create multi-space
// runs (with `s_space`) or push the next module onto a new line
// twice (`s_newline`).
const WRAP_PARAM = {
  named: {
    wrap: (raw: string): ResolvedValue | null =>
      raw === "true" || raw === "false" ? raw : null,
  },
} as const;

// v0.9.0+ — `s_move|pos:<n>|char:<c>` pads the current line with
// `<c>` until the cursor reaches column `pos`. Default pos=0,
// char=" ". When the cursor is already at or past `pos` the move
// is a no-op + warn (per the user's "误操作" spec — the call is a
// bug because moving left / holding steady in a column-advance
// construct is meaningless). `pos` MUST be present — bare `s_move`
// (no `pos:` pair) is rejected by the resolver as a badarg.
//
// Resolver shape:
//   pos  → non-negative integer (0..999 cap keeps a runaway config
//          from blowing up the statusline width; 999 cells is well
//          past every terminal's nominal width).
//   char → a single non-control printable character (validated by
//          the dispatcher's ANSI-strip width helper — see
//          renderTemplate's cursor tracking). Empty string is
//          accepted as a sentinel for "move without emitting" (the
//          dispatcher still updates the cursor so subsequent
//          chunks line up); multi-char is rejected as badarg to
//          keep the column math unambiguous.
const MOVE_PARAM = {
  named: {
    pos: (raw: string): ResolvedValue | null => {
      if (!/^[0-9]+$/.test(raw)) return null;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 999) return null;
      return raw;
    },
    char: (raw: string): ResolvedValue | null => {
      // Empty string = "move without emitting" sentinel (the
      // cursor still advances). One printable non-newline char is
      // the normal case. Anything else is badarg.
      if (raw === "") return raw;
      if (raw.length !== 1) return null;
      const code = raw.charCodeAt(0);
      if (code < 33 || code === 127 || code === 10 || code === 13) {
        return null;
      }
      return raw;
    },
  },
} as const;

// Classify a separator body as "whitespace/control" (no padding
// even under wrap=true) or "printable" (pad with 1 space on each
// side). Pure: only inspects the body's own characters. Used by
// the s_ renderer's wrap step.
function isControlBody(body: string): boolean {
  if (body === "") return true;
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    // ASCII whitespace (tab=9, LF=10, CR=13, space=32, VT=11, FF=12)
    // and any C0 control char (< 32) or DEL (127) is "control" for
    // wrap purposes. Anything else (regular printable, multi-byte
    // UTF-8 like `·`, anything else) is "printable" and pads.
    if (code < 33) return true;
    if (code === 127) return true;
  }
  return false;
}

// Pure: format a separator body with the parsed repeat count and
// the wrap flag. Repeat=0 is rejected upstream by the resolver
// (returns null), so this layer can assume n >= 1. wrap=true
// + non-control body pads with 1 space on each side; wrap=false
// returns body as-is.
function formatSepBody(body: string, repeat: string, wrap: string): string {
  const n = Number(repeat);
  const inner = wrap === "true" && !isControlBody(body)
    ? ` ${body} `
    : body;
  let out = "";
  for (let i = 0; i < n; i++) out += inner;
  return out;
}

// v0.8.0+ — three-layer accumulator scope selector (used by
// m_acc*). Accepts "session" (default), "project", or "model".
// "ccsession" was REMOVED in this revision and is intentionally
// rejected with badarg (see resolveAccScope / passThroughScope);
// the SCOPE_PARAM here only enumerates surviving scopes, so a
// stray "ccsession" string fails the accept-set check at the
// param level (and the resolve* helpers would throw anyway for
// passthrough-only paths). Anything else is a parse-fail and the
// inline token is dropped (same as :color|<garbage>). The model
// scope is a no-op when the live TokenSnapshot has no
// modelId (the placeholder path fires); project scope
// reads the project-wide slot, which is null until at least one
// tick has accumulated into it.
const SCOPE_PARAM = {
  named: {
    scope: (raw: string): ResolvedValue | null =>
      raw === "session" || raw === "project" || raw === "model" ? raw : null,
  },
} as const;

// v0.8.0+ — sum/avg module inline args.
//
// `:model|<active|name|all>` — narrow the jsonl scan to one model
//   identity, "active" (the model currently displayed in m_model),
//   or "all" (every row). Default is "active". The literal "all"
//   skips per-row model filtering entirely.
//
// `:window|<dhms|all>` — the time window to scan. Accepts any
//   `<digits><unit>` chain parseable by parseDhms (e.g. "5h",
//   "7d", "1h30m", "2d12h"), plus the special "all" sentinel
//   (no time filter, scan the entire jsonl). Default is "5h".
//
// `:align|<true|false>` — when true AND window ∈ {5h, 7d} AND
//   ctx.fiveHour/weekly has resetStartAt+resetDurationMs, use the
//   plan-aligned window [resetStartAt, resetStartAt + duration]
//   instead of the wall-clock [now - windowMs, now]. The
//   tokenplan "5h since 14:00" anchor matters here — without
//   align, the wall-clock window can read N% under 100% even at
//   full quota because we miss the recent refill. Default true.
const MODEL_PARAM = {
  named: {
    model: (raw: string): ResolvedValue | null =>
      raw === "active" || raw === "all" || raw.length > 0 ? raw : null,
  },
} as const;

const WINDOW_PARAM = {
  named: {
    window: (raw: string): ResolvedValue | null =>
      parseDhms(raw) !== null ? raw : null,
  },
} as const;

// v0.8.0+ — `:align|<true|false>` — gates the plan-anchored
// scan path against the dhms wall-clock path on m_sum*
// modules. Resolver accepts only literal `true` / `false` so
// typos fail loud at the inline-args resolver rather than
// silently no-op'ing — matches the discipline used by ABS_PARAM
// and other boolean gates.
//
// vX.X.X — restored. Default is `false` so a bare `m_sum*` or
// `m_sum*|window|<dhms>` reads wall-clock. `|align|true` opts
// into the plan-anchored path: with `|window|<declaredId>` the
// scan anchors to the matching Interval's resetStartAt; with
// `|window|<unparseable string>` it falls through to dhms if
// parseable, else drops. With `|align|false` the windowId
// branch is skipped entirely — `|window|<declaredId>` reads as
// plain dhms (and a literally parseable dhms value still
// resolves; a value like `"monthly"` would drop because dhms
// can't parse it). See parseWindowScope for the full
// resolution tree.
const ALIGN_PARAM = {
  named: {
    align: (raw: string): ResolvedValue | null =>
      raw === "true" || raw === "false" ? raw : null,
  },
} as const;

// v0.9.0+ — interval-term selector for m_windowQuota / m_countdown /
// m_quota. v0.9.4 — the `intervals` dict is open-ended, so `term`
// accepts ANY non-empty string (the bare form defaults to
// "short" upstream of the dispatcher). `all` is reserved by
// parseWindowScope's no-time-anchor sentinel and is rejected here
// so a user typo (`m_windowQuota|term|all`) fails loud at the
// inline-args resolver rather than silently no-op'ing. Empty
// strings and whitespace-only values are likewise dropped.
const TERM_PARAM = {
  named: {
    term: (raw: string): ResolvedValue | null => {
      if (raw === "all") return null;
      if (raw.trim() === "") return null;
      return raw;
    },
  },
} as const;

// v0.4.0+ — per-module display-mode override (scoped to the bar
// computation for the window modules). Accepts "used" or
// "remaining" verbatim; anything else is a parse-fail and the
// inline token is dropped (same as :color|<garbage>). Resolution is
// deliberately narrow — the module-level `display` config field
// (RESOLVED via resolveDisplayMode) stays the default for the bare
// `m_window5h` form. Inline display wins when present, so users can
// e.g. show 5h as "remaining" while the global config is "used".
const DISPLAY_PARAM = {
  named: {
    display: (raw: string): ResolvedValue | null =>
      raw === "used" || raw === "remaining" ? raw : null,
  },
} as const;

// v0.8.25+ — boolean toggle that widens the m_accStartTime /
// m_sumStartTime / m_sumEndTime rendered body from
// `HH:MM:SS` (default) to `YYYY-MM-DD HH:MM:SS`. Accepts
// only literal `true` or `false` so typos fail loud at the
// inline-args resolver rather than silently no-op'ing —
// matches the discipline used by ALIGN_PARAM. Default of
// the bare form is `HH:MM:SS` so v0.8.24 renders stay
// byte-identical after upgrade.
const ABS_PARAM = {
  named: {
    abs: (raw: string): ResolvedValue | null =>
      raw === "true" || raw === "false" ? raw : null,
  },
} as const;

// vX.X.X+ — boolean toggle that strips the leading label prefix
// from the rendered body. Applies to every label-using m_* module
// (~36 modules: the per-turn / m_acc* / m_sum* / m_memUsage
// families). Default `false` so v0.8.x renders stay
// byte-identical after upgrade. When `true`, the leading
// `labelFor(axis)` prefix is dropped from BOTH the live render
// path AND the placeholder path:
//   m_tokenIn|valueOnly:true           → "1.2K"   (was "in:1.2K")
//   m_tokenIn|valueOnly:true (no data) → "n/a"    (was "in:n/a")
// Forwarded through m_template via the passthrough whitelist, so
// an outer `m_template|<key>|valueOnly:true` drives every
// label-using inner module. Accepts only literal `true` / `false`
// so typos fail loud at the inline-args resolver rather than
// silently no-op'ing — mirrors the discipline used by ALIGN_PARAM
// and ABS_PARAM.
const VALUEONLY_PARAM = {
  named: {
    valueOnly: (raw: string): ResolvedValue | null =>
      raw === "true" || raw === "false" ? raw : null,
  },
} as const;

// ----- v0.4.0+ placeholder shapes for nulldrop:false -----------------------
//
// Each constant is a closure over the inline-args params + ctx so the
// INLINE_RENDERERS can pull a precomputed placeholder body. Every
// placeholder wraps its body in `${STALE_COLOR}…${RESET}` so a missing
// gauge / number reads as "dim gray, no data" — visually distinct
// from a real value (which is colored by the band palette or wrapped
// in the user's :color| override). The :color| inline override still
// wins when present (it REPLACES the placeholder's STALE_COLOR wrap,
// matching the existing "user override always wins" rule).

// pure-number placeholder body: "<prefix>n/a" — PLAIN text. The
// STALE_COLOR wrap is applied by the INLINE_RENDERER (via
// wrapPlain / formatOneChunkColored) so a `|color|<c>` inline
// override REPLACES the default STALE_COLOR, matching the
// existing "user color always wins" rule for every other module.
// The prefix matches the module's normal inline label (e.g.
// "ctx:", "in:", "out:", "cache:") so a nulldrop placeholder reads
// like the same module just with "n/a" instead of a real number.
// Bare-string modules pass prefix="" (e.g. m_session → just "n/a").
function placeholderNA(
  prefix: string,
): (_params: Record<string, ResolvedValue>, _ctx: RenderContext) => string {
  return (_p, _c) => `${prefix}n/a`;
}

// number+unit placeholder body: PLAIN text. The STALE_COLOR wrap
// is applied by the INLINE_RENDERER (via wrapPlain) for the same
// reason as placeholderNA. The `body` is the COMPLETE placeholder
// text the module would otherwise emit (e.g. "5h:--", "+ --",
// "-- t/s"). Bare-number modules pass body="--" with no suffix
// (e.g. m_sessionDuration → "--", matching the existing
// formatRemainingMs shape).
function placeholderDashesUnit(
  body: string,
): (_params: Record<string, ResolvedValue>, _ctx: RenderContext) => string {
  return (_p, _c) => body;
}

// v0.9.0+ — variant of `placeholderDashesUnit` whose body is a
// function of the live `RenderContext` AND the resolved inline
// `params`. Used by `m_countdown` so its placeholder reflects
// the per-term label driven by `params.term` (e.g. `5h:--`,
// `7d:--`, `30d:--` depending on which term is rendering — not
// the legacy hard-coded "5h" default). When the chosen interval
// is null the body falls back to a built-in label by term so the
// placeholder always renders something readable.
//
// vX.X.X+ — `params.term` is the source of truth for label
// selection. The bare-MODULES path always defaults to "short"
// upstream of this helper, so bare `m_countdown` keeps reading
// `c.shortInterval?.label`. The inline path now passes the
// `term` through, which fixes the v0.8.x bug where
// `m_countdown|term|mid` would render "(5h:--)" instead of
// "(7d:--)" when the mid-term interval was missing.
function placeholderDashesUnitFn(
  body: (params: Record<string, ResolvedValue>, ctx: RenderContext) => string,
): (params: Record<string, ResolvedValue>, ctx: RenderContext) => string {
  return (p, c) => body(p, c);
}

// Term-aware renderer-context lookup. Mirrors the renderer-side
// `term → Interval` switch (used in m_windowQuota / m_countdown /
// m_quota) so placeholder + live bodies agree on what interval
// they read. v0.9.4 — `term` is the literal dict key
// (`ctx.intervals[term]`), NOT a fixed union. Default is "short"
// to match the bare-MODULES default; any other string is a
// passthrough to the dict.
function intervalForTerm(
  term: string | undefined,
  ctx: RenderContext,
): Interval | null {
  const key = term ?? "short";
  return (ctx.intervals ?? {})[key] ?? null;
}

// Built-in fallback labels for the three reserved terms when the
// chosen interval is null. Non-reserved terms (e.g. "monthly")
// fall back to the term string itself, since the renderer has no
// historical default for them. Matches the v0.9.x "5h / 7d / 30d"
// convention so existing renders stay byte-identical.
const PLACEHOLDER_TERM_FALLBACK: Record<string, string> = {
  short: "5h",
  mid: "7d",
  long: "30d",
};

function termFallbackLabel(term: string): string {
  return PLACEHOLDER_TERM_FALLBACK[term] ?? term;
}

// Standard per-term + per-interval label resolver shared by
// m_countdown / m_quota placeholders. `wrap` receives the
// resolved term-label (e.g. "5h" / "7d" / "30d"); callers shape
// the body uniformly across terms. The vX.X.X+ convention is
// dashes-or-n/a-left, label-bracketed-right:
//   - m_countdown        → "--:(<label>)"
//   - m_quota            → "${prefix}n/a(<label>)"
function placeholderTermLabel(
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
  wrap: (label: string) => string,
): string {
  const term = (params.term as string | undefined) ?? "short";
  const iv = intervalForTerm(term, ctx);
  const label = iv?.label ?? termFallbackLabel(term);
  return wrap(label);
}

// v0.9.0+ — quota module placeholder. Per-term, all terms share
// the same "${labelFor("quota")}n/a(<label>)" shape (vX.X.X+:
// dashes collapsed to `n/a`, label moved to tail to mirror the
// live body's `quota:<axis>/<total>(<label>)` shape):
//   - short → "quota:n/a(5h)"
//   - mid   → "quota:n/a(7d)"
//   - long  → "quota:n/a(30d)"
// Bare-MODULES default term is "short" upstream of this helper,
// so bare `m_quota` keeps reading `c.shortInterval?.label`.
function placeholderQuota(
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
): string {
  const prefix = labelFor("quota");
  return placeholderTermLabel(params, ctx, (label) =>
    // vX.X.X+ — shape aligned with the live body: label lives
    // at the tail, the gap marker is `n/a` (no `--:` pair).
    //   short / mid / long → "${prefix}n/a(<label>)"
    //     e.g. "quota:n/a(5h)", "quota:n/a(7d)", "quota:n/a(30d)"
    `${prefix}n/a(${label})`,
  );
}

// gauge placeholder body: returns PLAIN text (no SGR). The
// INLINE_RENDERER handles the SGR wrap via wrapPlain (so a
// `|color|<c>` override can REPLACE the default STALE_COLOR just
// like every other module). The placeholder shape is a 0-value
// bar — "used" mode shows an empty bar with "0%"; "remaining"
// mode shows a full bar with "100%". The synthetic pct=0 keeps
// the bar geometry aligned with the natural 0-value render path
// (see render-tokens.test.ts: "m_windowContext: usedPct=0").
function placeholderGauge(
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
): string {
  const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
  const empty = cfg().bar.empty;
  const filled = cfg().bar.filled;
  const width = cfg().bar.width;
  if (mode === "used") {
    return `${empty.repeat(width)} 0%`;
  }
  // mode === "remaining": full filled bar, "100%".
  return `${filled.repeat(width)} 100%`;
}

// Module → placeholder dispatcher. Each module opts into ONE of
// the four shape families by listing its `placeholder` body. The
// INLINE_RENDERER consults this table when the data path returns
// null/empty AND params.nulldrop === "false".
//
// Add a module here ONLY if its bare-module null case is currently
// a `return null`. The four families cover every existing drop
// case: pure-number ("n/a"), number+unit ("-- <unit>"), gauge
// ("gray bar + 0%"), bare-string ("n/a").
//
// v0.8.0+: placeholderNA / placeholderDashesUnit factories take
// the prefix (or body) as a string OR as a function. The function
// form is used for the four `labels.*` axes (in / out / cacheIn /
// totalIn) so the placeholder reflects the user's configured
// label rather than the hardcoded literal. The function is
// invoked at placeholder-fire time, reading configStore.get()
// at the same moment the renderer did.
type PlaceholderBody = (
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
) => string;

// Label-aware NA placeholder: receives the LabelAxis enum (one
// of the eight axes — four v0.8.0 token-axis plus four v0.8.13+
// apiMs / apiCalls / inSpeed / outSpeed). The body defers label
// resolution until placeholder-fire time so any subsequent config
// override is picked up. Defaults reproduce the v0.7.x
// literal-string behavior exactly because cfg().labels.labelIn
// === "in:" etc., and the v0.8.13+ axes default to today's
// literals ("api:" / "calls:" / "in:" / "out:" for speed).
function placeholderLabelOr(axis: LabelAxis): PlaceholderBody {
  // vX.X.X+ — when |valueOnly|true is set (via inline args or via
  // m_template passthrough), drop the leading label prefix so the
  // placeholder matches the live-render path's "value only" shape.
  return (p, _c) => `${p.valueOnly === "true" ? "" : labelFor(axis)}n/a`;
}

const PLACEHOLDERS: Record<string, PlaceholderBody> = {
  // pure-number — placeholder shape is "<prefix>n/a"
  m_tokenInTotal: placeholderLabelOr("in"),
  m_tokenTotalOut: placeholderLabelOr("out"),
  // v0.8.13+ — m_apiCalls placeholder routes through labelFor
  // (labels.labelApiCalls) so the prefix matches the user's
  // configured labelApiCalls default. Was hardcoded "calls:" via
  // placeholderNA; the live-read variant mirrors the rest of the
  // label-axis modules (in/out/cache/total).
  m_apiCalls: placeholderLabelOr("apiCalls"),
  // v0.8.x cwf-tickStatus-v2 — m_totalToken* / m_totalTokenWithCacheIn
  // REMOVED. Use the m_acc* family with scope=session (default).
  // m_acc* — v0.8.0+ labels.*: the four token-axis acc modules
  // (m_accTokenIn/Out/CachedIn/TotalIn) share their prefix with
  // the per-turn siblings via labelFor. m_accTokenHitRate
  // (v0.8.x R8) also mirrors its per-turn sibling — "hit:"
  // prefix, matching m_tokenHitRate / m_sumTokenHitRate. The
  // :scope: inline arg is ignored at the placeholder level
  // (placeholderNA / placeholderLabelOr returns the same body
  // regardless of scope — see placeholderAcc comment for the
  // future-extension hook). v0.8.13+ — m_accApiMs / m_accApiCalls
  // / m_accTokenInSpeed / m_accTokenOutSpeed also route through
  // labelFor (labels.labelApi / labelApiCalls / labelInSpeed /
  // labelOutSpeed); defaults preserve today's literal strings.
  m_accTokenIn: placeholderLabelOr("in"),
  m_accTokenOut: placeholderLabelOr("out"),
  m_accTokenCachedIn: placeholderLabelOr("cacheIn"),
  m_accTokenTotalIn: placeholderLabelOr("totalIn"),
  // v0.8.13+ — m_accApiMs / m_accApiCalls placeholders route
  // through labelFor (labels.labelApi / labels.labelApiCalls) so
  // the prefix follows the configured defaults. Defaults remain
  // "api:" / "calls:" so existing renders stay byte-identical.
  m_accApiMs: placeholderLabelOr("apiMs"),
  m_accApiCalls: placeholderLabelOr("apiCalls"),
  // v0.8.13+ — m_accTokenInSpeed / m_accTokenOutSpeed placeholders.
  // Use the dedicated labelInSpeed / labelOutSpeed axis (was:
  // shared the in/out token-axis labelFor). Defaults remain "in:"
  // / "out:" so existing renders stay byte-identical until the
  // user overrides either axis independently.
  m_accTokenInSpeed: placeholderLabelOr("inSpeed"),
  m_accTokenOutSpeed: placeholderLabelOr("outSpeed"),
  // v0.8.x R8 → v0.8.22: m_accTokenHitRate / m_tokenHitRate /
  // m_sumTokenHitRate all share the `hit:` prefix via
  // labels.labelTokenHitRate (was hardcoded in v0.8.x). The
  // placeholder bodies keep the `n/a%` shape for the ratio
  // modules and `n/a` for the bare per-turn form so existing
  // renders stay byte-identical until the user overrides the
  // label. Reading at placeholder-fire time keeps the rendered
  // prefix in sync with any post-load config override.
  m_accTokenHitRate: (p, _c) => `${p.valueOnly === "true" ? "" : labelFor("hitRate")}n/a%`,
  m_tokenCachedIn: placeholderDashesUnit("cache:0"),
  m_tokenHitRate: (p, _c) => `${p.valueOnly === "true" ? "" : labelFor("hitRate")}n/a`,
  // v0.8.23+ — context-window placeholders route through the
  // dedicated labelContext* axes (labels.labelContextSize /
  // labelContextWindowsSize / labelContextUsedPercent /
  // labelContextRemainingPercent; defaults "size:" / "size:" /
  // "used:" / "remain:" preserve the v0.8.22 hardcoded literals).
  m_contextSize: (p, _c) => `${p.valueOnly === "true" ? "" : labelFor("contextSize")}n/a`,
  m_contextWindowsSize: (p, _c) => `${p.valueOnly === "true" ? "" : labelFor("contextWindowsSize")}n/a`,
  // m_contextUsedPercent's natural shape is "${pct}%" — the
  // placeholder preserves the unit suffix so users see "used:n/a%"
  // rather than bare "n/a" when usedPct is null.
  m_contextUsedPercent: (p, _c) => `${p.valueOnly === "true" ? "" : labelFor("contextUsedPercent")}n/a%`,
  m_contextRemainingPercent: (p, _c) => `${p.valueOnly === "true" ? "" : labelFor("contextRemainingPercent")}n/a%`,
  // number+unit — placeholder shape is the module's normal body
  // with "--" swapped in for the numeric value (e.g. "5h:--",
  // "+ --", "-- t/s"). Empty body = bare dash.
  m_sessionDuration: placeholderDashesUnit("--"),
  m_sessionApiDuration: placeholderDashesUnit("--"),
  // v0.8.0+ — per-turn API-ms delta placeholder. Body uses the
  // shared "n/a" so it lines up with the n/a-family placeholders
  // (m_sumApiMs → "api:n/a", m_tokenHitRate → "hit:n/a",
  // m_contextSize → "size:n/a"). v0.8.13+ — prefix routes
  // through labelFor(labels.labelApi); default "api:" preserves
  // the v0.8.x literal so existing renders stay byte-identical.
  // Previously used dashes-unit ("api:--"); R9 unified on n/a so
  // users composing api-ms alongside sum-api see the same body
  // for "no reading yet".
  m_apiMs: placeholderLabelOr("apiMs"),
  m_linesAdded: placeholderDashesUnit("+ --"),
  m_linesRemoved: placeholderDashesUnit("- --"),
  // v0.8.0+ — sum/avg advanced statistics placeholders. Same shape
  // as the rendered output: "in:n/a" / "out:n/a" / "cache:n/a" /
  // "api:n/a" for the 5 plain modules; "hit:n/a%" for the ratio.
  // Empty aggregate (no rows in window) triggers the placeholder.
  m_sumTokenIn: placeholderLabelOr("in"),
  m_sumTokenOut: placeholderLabelOr("out"),
  m_sumTokenCachedIn: placeholderLabelOr("cacheIn"),
  m_sumTokenTotalIn: placeholderLabelOr("totalIn"),
  // v0.8.13+ — m_sumApiMs / m_sumApiCalls route through labelFor
  // (labels.labelApi / labels.labelApiCalls); defaults remain
  // "api:" / "calls:" so existing renders stay byte-identical.
  m_sumApiMs: placeholderLabelOr("apiMs"),
  // v0.8.14 — ratio gets the `%` suffix to mirror m_accTokenHitRate's
  // `hit:n/a%` placeholderAcc shape (was `hit:n/a`; the % was
  // missing in the v0.8.13 PLACEHOLDERS entry despite the inline
  // comment claiming otherwise).
  // v0.8.22+ — prefix routes through labels.labelTokenHitRate
  // via labelFor("hitRate") so the user can override the
  // per-turn / acc / sum hit-rate prefix as a single knob.
  m_sumTokenHitRate: (p, _c) => `${p.valueOnly === "true" ? "" : labelFor("hitRate")}n/a%`,
  // v0.8.13+ — speed axes get their own labelFor slot
  // (labels.labelInSpeed / labels.labelOutSpeed) so a user can
  // rename speed prefixes independently of the in/out token-axis
  // family. Defaults remain "in:" / "out:" matching today's
  // literal strings byte-for-byte.
  m_sumTokenInSpeed: placeholderLabelOr("inSpeed"),
  m_sumTokenOutSpeed: placeholderLabelOr("outSpeed"),
  m_sumApiCalls: placeholderLabelOr("apiCalls"),
  // v0.8.24+ — start/end time of the tick statistics window.
  // m_sumStartTime aggregates min(s.startAt) over the filtered
  // rows; m_sumEndTime aggregates max(s.lastAt). Placeholder
  // shape: "<labelStartTime>n/a" / "<labelEndTime>n/a" (labels
  // routed through labelFor so the configured labelStartTime /
  // labelEndTime defaults apply). The m_accStartTime sibling
  // routes through placeholderAcc, not the PLACEHOLDERS map.
  m_sumStartTime: placeholderLabelOr("startTime"),
  m_sumEndTime: placeholderLabelOr("endTime"),
  // v0.8.0+ — newly added m_tokenTotalIn (session-cumulative
  // total_input_tokens). Shares the labelTotalIn axis with its
  // sum/avg siblings.
  m_tokenTotalIn: placeholderLabelOr("totalIn"),
  // gauge (placeholder shape is the gray 0% / 100% bar)
  m_windowQuota: placeholderGauge,
  m_windowContext: placeholderGauge,
  // v0.8.16 — TTL gauge placeholders. Custom shape: single ▆ char
  // (NOT "ttl:n/a"). Returns PLAIN text (no SGR); the STALE_COLOR
  // wrap is applied by placeholderBare / placeholderWithColor,
  // matching every other module's contract. Inline
  // `m_cacheTtlStatus|color|gray` overrides to the user's color of
  // choice.
  m_cacheTtlStatus: () => "▆",
  m_statTtlStatus: () => "▆",
  // bare-string (no prefix to recover from; just "n/a")
  m_session: placeholderNA(""),
  m_model: placeholderNA(""),
  m_effort: placeholderNA(""),
  m_repo: placeholderNA(""),
  m_branch: placeholderNA("branch:"),
  m_gitStatus: placeholderNA("git:"),
  m_ccVersion: placeholderNA(""),
  m_ccversion: placeholderNA(""),
  // v6.x: per-API-call token modules. Previously these had no
  // placeholder registration — bare forms dropped on null and the
  // inline path produced "in:-- t/s" / "in:--" sentinels. New
  // rule (per user direction): null → "n/a"; idle tick (delta=0)
  // → "in:0" / "out:0" / "in:0.0 t/s"; 0 is always rendered, never
  // hidden. The bare MODULES paths now route through these
  // placeholders instead of returning null so layout stays stable.
  m_tokenIn: placeholderLabelOr("in"),
  m_tokenOut: placeholderLabelOr("out"),
  // v0.8.13+ — speed axes route through the dedicated
  // labelInSpeed / labelOutSpeed slot so the prefix can be
  // configured independently from labels.labelIn / labels.labelOut.
  // Defaults remain "in:" / "out:" matching the previous literal
  // strings byte-for-byte; a user who renames labelIn="In:" will
  // see "In:42" for tokens BUT still "in:12.3 t/s" for the speed
  // module until they also override labelInSpeed.
  m_tokenInSpeed: placeholderLabelOr("inSpeed"),
  m_tokenOutSpeed: placeholderLabelOr("outSpeed"),
  // v0.8.17+ — system RAM usage. Resolves to "<label>n/a" so the
  // placeholder body stays in lockstep with the user's labels.labelMemUsage
  // override (renaming the label renames the placeholder too).
  m_memUsage: placeholderLabelOr("memUsage"),
  // v0.8.36+ — m_windowMemUsage placeholder mirrors m_windowContext:
  // a gray gauge (filled-bar "100%" in remaining mode, empty-bar
  // "0%" in used mode). Color is STALE_COLOR.
  m_windowMemUsage: placeholderGauge,
  // v6.x: previously drop-by-design modules (no age info / no
  // version / no reset data / no balance). Now also follow the
  // placeholder rule — they occupy their slot so adjacent
  // separators don't shift. :nulldrop|true remains the opt-out.
  m_age: placeholderNA("age:"),
  m_version: placeholderNA("v:"),
  m_countdown: placeholderDashesUnitFn((p, c) =>
    // Per-term shape — uniform dashes-left, label-right:
    //   short / mid / long → "--:(<label>)"
    //     e.g. "--:(5h)", "--:(7d)", "--:(30d)"
    placeholderTermLabel(p, c, (label) => `--:(${label})`),
  ),
  m_balance: placeholderNA("balance:"),
  m_quota: placeholderQuota,
  // vX.X.X+ — token cost module placeholders. Render "cost:n/a" so
  // the placeholder stays in lockstep with labelTokenCost overrides.
  m_tokenCost: placeholderLabelOr("cost"),
  m_accTokenCost: placeholderLabelOr("cost"),
  m_sumTokenCost: placeholderLabelOr("cost"),
};

// Render a placeholder body unless the user has explicitly opted
// out via `:nulldrop|true`, OR the module has no registered
// placeholder shape. The default is FORCED placeholder (every
// inline-listed module keeps its slot even when data is null).
// Returns null when the user opted out, so the caller's drop path
// takes over (matching the bare MODULES drop behavior).
//
// The returned string is PLAIN text (no SGR); the caller is
// expected to wrap it in the user's chosen color (defaults to
// STALE_COLOR via placeholderWithColor), matching the existing
// "override wins" pattern for every other inline module.
function placeholderOrNull(
  modKey: string,
  params: Record<string, ResolvedValue>,
  _ctx: RenderContext,
): string | null {
  if (params.nulldrop === "true") return null;
  const body = PLACEHOLDERS[modKey];
  if (!body) return null;
  return body(params, _ctx);
}

// Render a placeholder (when active) wrapped in the user's
// `|color|<c>` override, or STALE_COLOR by default. Returns null
// when the user opted out of the placeholder (`nulldrop:true`)
// OR the module has no registered placeholder shape — the caller's
// null-fall-through path takes over (drop, same as bare MODULES
// behavior).
//
// The STALE_COLOR default is what makes a missing-data placeholder
// visually distinct from a real value (a real `ctx:163.5k` is
// band-colored; a placeholder `ctx:n/a` is gray). Note: this is
// the OPPOSITE of wrapPlain (which returns plain text when no
// color is supplied) — placeholder rendering ALWAYS wraps, even
// without an override.
function placeholderWithColor(
  modKey: string,
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
): string | null {
  const body = placeholderOrNull(modKey, params, ctx);
  if (body == null) return null;
  const color = (params.color as string | undefined) ?? STALE_COLOR;
  return `${color}${body}${RESET}`;
}

// v6.x — bare-path variant of placeholderWithColor. Used by MODULES
// (the bare form, no inline-args) so a module's null case renders
// its PLACEHOLDERS body wrapped in STALE_COLOR, matching the inline
// default. Returns null when the module has no registered shape
// (preserves the legacy drop-by-design behavior — but as of v6.x,
// every module in MODULES has either a placeholder or a different
// always-render strategy, so this null return is only a defensive
// fallback). Color override is not supported on the bare path
// (mod.color is a no-op for bare tokens; the inline path remains
// the only way to customize placeholder color).
//
// `ctx` is required because placeholderGauge reads ctx.mode to
// pick between the used ("░...░ 0%") and remaining ("▓...▓ 100%")
// gauge placeholder shapes. Pure-NA and dashes-unit bodies ignore
// ctx, so passing the real render context is safe and uniform.
function placeholderBare(modKey: string, ctx: RenderContext): string | null {
  const body = PLACEHOLDERS[modKey];
  if (!body) return null;
  return `${STALE_COLOR}${body({}, ctx)}${RESET}`;
}

// Extended-color schema used by `m_quote`. Accepts the standard
// 7 shortcuts + raw SGR + the 3 special shortcuts (rainbow /
// rand-rainbow / hue). The resolver encodes the tagged ColorParam
// as a string (using NUL-prefix sentinels in `encodeColorParam`)
// so it round-trips through the generic INLINE_SCHEMAS contract
// (`params.color: string | undefined`). The m_quote renderer
// decodes via `decodeColorParam`.
const QUOTE_COLOR_PARAM = {
  named: {
    color: (raw: string) => {
      const p = resolveColorParam(raw);
      if (p === null) return null;
      return encodeColorParam(p);
    },
  },
} as const;

const QUOTE_FREQ_PARAM = {
  named: {
    freq: (raw: string) => {
      // Shape-validate the single-unit time format up front so a
      // clearly-wrong token (e.g. "yearly", "2h10m", "5x") is
      // rejected before reaching the renderer. The renderer then
      // calls parseFreq() to extract the bucket size. We pass the
      // raw string through (rather than the parsed QuoteFreq
      // object) so the ResolvedValue = string | number channel
      // doesn't need a sentinel round-trip.
      if (raw === "") return null;
      // Bare unit letter → valid shorthand.
      if (raw === "d" || raw === "h" || raw === "m" || raw === "s") return raw;
      // Numeric form: <digits><unit>. Reject multi-unit, unknown
      // units, leading zeros, and empty digit runs here so the
      // renderer's parseFreq() never sees malformed input.
      if (raw.length < 2) return null;
      const unit = raw[raw.length - 1];
      if (unit !== "d" && unit !== "h" && unit !== "m" && unit !== "s") return null;
      const digits = raw.slice(0, -1);
      if (digits === "") return null;
      if (!/^[0-9]+$/.test(digits)) return null;
      if (digits.length > 1 && digits[0] === "0") return null;
      return raw;
    },
  },
} as const;

// v0.8.18+ — m_quote `address` param. Empty string (default) keeps
// the local QUOTES array path. Non-empty string is treated as a URL
// to fetch with `fetch()` (Node 18+ native; statusline lives in a
// short-lived child process per tick, so we don't cache — matching
// the per-tick live-sample model of m_memUsage).
const QUOTE_ADDRESS_PARAM = {
  named: {
    // Accept any non-empty URL. We don't validate the scheme here
    // (http / https / file / etc.) because the user knows their
    // own network policy; a fetch failure just falls through to
    // the drop path the same as a missing local quote.
    address: (raw: string) => (raw.length > 0 ? raw : null),
  },
} as const;

// v0.8.21+ — m_quote `quote` param (was `field` in v0.8.20+).
// A single dot-separated path into the fetched JSON: `a.b`,
// `quotes.0.quotestring`, `hitokoto`. The walked value is the
// quote text rendered between the `~` brackets.
//
// An empty `quote` is a legal "no walk" marker (v0.8.18
// backwards-compat: a plain-text body returned by the endpoint
// is rendered verbatim when no path is supplied). The renderer
// distinguishes the two by checking `params.quote !== undefined`
// — missing arg vs empty arg.
const QUOTE_QUOTE_PARAM = {
  named: {
    quote: (raw: string) => {
      if (raw.length === 0) return raw;
      if (raw.startsWith(".") || raw.endsWith(".") || raw.includes("..")) {
        return null;
      }
      return raw;
    },
  },
} as const;

// v0.8.21+ — m_quote `author` param. A single dot-separated path
// into the fetched JSON (e.g. `from_who`). The walked value is
// the author rendered as the `--<author>` half of the
// `~<quote>--<author>~` output. Missing arg OR a walk that
// yields null/empty means "no author suffix" — the renderer
// emits the bare `~<quote>~` instead.
const QUOTE_AUTHOR_PARAM = {
  named: {
    author: (raw: string) => {
      if (raw.length === 0) return null;
      if (raw.startsWith(".") || raw.endsWith(".") || raw.includes("..")) {
        return null;
      }
      return raw;
    },
  },
} as const;

// v0.8.21+ — m_quote `lang` param. A CSV list of language codes
// (matches `QuoteEntry.lang` — currently "en" and "zh").
// Restricts local-quote rotation to the listed languages. Empty
// arg or all-unknown codes fall back to "no filter".
const QUOTE_LANG_PARAM = {
  named: {
    lang: (raw: string) => {
      const parts = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length === 0) return null;
      // Drop anything not in the known set — better to silently
      // filter than to reject the whole token for a typo.
      const known = parts.filter((p) => p === "en" || p === "zh");
      if (known.length === 0) return null;
      return known.join(",");
    },
  },
} as const;

// v0.8.21+ — m_quote `max` param. The CJK-weighted char budget
// for the rendered quote (CJK=2, latin=1, default 60 → 30 中文
// chars or 60 英文 chars). An integer in [0, 999]. `0` opts
// out of truncation (sanitize still runs). Anything outside the
// shape is rejected (badarg → warn + drop).
const QUOTE_MAX_PARAM = {
  named: {
    max: (raw: string) => {
      if (!/^[0-9]+$/.test(raw)) return null;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 999) return null;
      return raw;
    },
  },
} as const;

// v0.8.21+ — `|insecureTls|<b>` per-token override for the m_quote
// fetcher. Accepts the standard boolean spellings (`true`/`false`/
// `1`/`0`) so the renderer schema can record the request and pass
// it down to `preFetchQuotes` in src/api.quote.ts. The TOKEN arg is
// AUTHORITATIVE — when present it overrides config.json's
// `quoteInsecureTls` for that fetch — so users can opt into curl
// `-k` only on specific tokens (e.g. a self-signed dev mirror) and
// keep strict TLS elsewhere. Omitting the arg means "fall back to
// the config gate" (cf. fetchOne in api.quote.ts).
const QUOTE_INSECURE_TLS_PARAM = {
  named: {
    insecureTls: (raw: string) => {
      const v = raw.toLowerCase();
      if (v === "true" || v === "1" || v === "false" || v === "0") return raw;
      return null;
    },
  },
} as const;

// v0.8.18+ — walk a JSON value along a dot-separated path, mirroring
// the recursive shape inspection in `parseQuota` (plugins/parsers.ts). At each
// step: if the current value is a string, return it (and IGNORE the
// rest of the path — the field param is only meaningful for object
// / array navigation). If it's an object, treat the segment as a
// key. If it's an array, treat the segment as a non-negative integer
// index. If the segment is malformed for the current container, or
// the path runs out before a string is found, return null.
export function getFieldByPath(value: unknown, path: string): string | null {
  const segs = path.split(".");
  let cur: unknown = value;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (typeof cur === "string") {
      // String is terminal — return as-is regardless of remaining
      // path (per the user's contract: "如果拿到的已经是字符串,
      // 则忽略 field 参数").
      return cur;
    }
    if (cur == null) return null;
    if (Array.isArray(cur)) {
      if (!/^[0-9]+$/.test(seg)) return null;
      const idx = parseInt(seg, 10);
      if (idx < 0 || idx >= cur.length) return null;
      cur = cur[idx];
      continue;
    }
    if (typeof cur === "object") {
      const obj = cur as Record<string, unknown>;
      if (!(seg in obj)) return null;
      cur = obj[seg];
      continue;
    }
    // Number / boolean / etc. — not navigable; stop here.
    return null;
  }
  // Reached end of path. Final value must be a string to be
  // renderable; anything else (object / array / number) returns
  // null so the caller can fall through to the drop path.
  return typeof cur === "string" ? cur : null;
}

// v0.8.19+ — fetch a remote quote payload via `curl` (synchronous).
// Mirrors the tolerant shape inspection pattern from
// src/plugins/parsers.ts:parseQuota (try JSON parse → walk path → return
// string). `renderTemplate` is sync (per-tick deadline in the
// statusline slot) so the renderer can't await; `curl -sSf` is
// shipped on every modern OS (Win10+1803, macOS, Linux distros)
// and follows the same execSync pattern as m_memUsage's vm_stat
// path. Curl failures throw → caught and translated to null so
// the caller falls through to the local QUOTES fallback path.
//
// `paths` is the parsed list of dot-paths from the `fields` arg.
// Each path is walked INDEPENDENTLY against the parsed JSON; the
// collected strings are joined as `path1: path2: path3:` — every
// path contributes a colon-terminated segment, even if its walk
// yielded "" (the renderer treats an empty field as "miss").
//
// v0.8.20+ — every failure path appends a structured warning to
// `diagnostics.jsonl` (gated on TOPGAUGE_DIAGNOSTICS_ENABLE)
// so a postmortem can grep why the local QUOTES fallback fired.
// The log row includes the address (truncated to keep the JSONL
// row ~250B) and the reason token; the `source` field is
// `m_quote` so a postmortem can filter for this module. The
// 60s in-process dedupe in diagnostics.append keeps a sustained
// network outage from drowning the file.
//
// v0.8.21+ — read a pre-fetched quote body from `ctx.quoteBodies`
// (populated by `preFetchQuotes` in `src/api.quote.ts`) and walk
// the user's `quote` (and optional `author`) path. Pure sync; no
// IO at render time. The fetch + disk-cache all happen ahead of
// `buildProviderLine` in `index.ts:main()`; by the time the
// renderer runs, the body is either present in the Map (and we
// produce {quote, author}) or absent (and the caller falls back
// to local QUOTES).
//
// Returns the walked strings when found; returns null only when:
//   - ctx.quoteBodies is undefined or the address key is missing
//   - body is not valid JSON AND quote is the empty marker
//   - quote walk yields null (the author's miss is tolerated —
//     the renderer still produces `~<quote>~` without the
//     `--<author>` suffix).
//
// `author` may be undefined (no author arg in the token); in that
// case the author slot is left null and the caller emits
// `~<quote>~`.
function fetchQuoteFromAddress(
  address: string,
  quote: string,
  author: string | undefined,
  ctx: RenderContext,
): { quote: string; author: string | null } | null {
  const body = ctx.quoteBodies?.get(address);
  if (body === undefined) {
    diagnostics.append(
      "error",
      "m_quote",
      `address fetch failed (no body): ${truncateForLog(address)}`,
      ctx.nowMs,
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    if (quote === "") {
      // v0.8.18 short-circuit — a plain-text body is rendered
      // verbatim when no quote path is supplied. author slot is
      // null (no path-walk succeeded on a non-JSON body).
      return { quote: body, author: null };
    }
    diagnostics.append(
      "error",
      "m_quote",
      `address fetch returned non-JSON body: ${truncateForLog(address)}`,
      ctx.nowMs,
    );
    return null;
  }
  const q = getFieldByPath(parsed, quote);
  if (q === null) {
    diagnostics.append(
      "error",
      "m_quote",
      `address fetch OK but quote miss: ${truncateForLog(address)} (quote=${quote})`,
      ctx.nowMs,
    );
    return null;
  }
  let a: string | null = null;
  if (author && author.length > 0) {
    const aw = getFieldByPath(parsed, author);
    a = aw ?? null;
  }
  return { quote: q, author: a };
}

// v0.8.20+ — truncate a user-supplied address for diagnostic
// logging. Caps at 120 chars to keep the JSONL row under ~250B
// while still surfacing enough of the URL for a postmortem to
// identify which endpoint failed.
function truncateForLog(s: string): string {
  return s.length > 120 ? s.slice(0, 119) + "…" : s;
}

// v0.8.18+ — small string hash for color-band seeding when the
// quote comes from a remote address (no time-based quoteIndex
// available). djb2 — non-crypto, deterministic, ~3 lines.
function stringHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33 + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

// vX.X.X+ — six named separator aliases. Each `s_<name>` token
// resolves to its built-in literal character. The legacy numeric
// `s_<n>` form and the `separators` config array are REMOVED —
// if you need a custom separator character, use one of these six
// (or wrap a literal `m_label|<your-token>` if you really need
// something different).
//
// Encoding note: ResolvedValue is a `string | number` union, so
// we tag the alias form as `"alias:<name>"` (still a string) and
// carry that through the inline-schema machinery. The numeric
// branch is gone — resolveSepBody returns INLINE_BADARG for any
// non-alias input.
// v0.7.1+ — `pipe` joins the alias table. Mirrors the new inline-args
// separator (see parseInlineArgs). Pure render output, NOT the
// inline-args delimiter itself.
const NAMED_SEPARATORS: ReadonlyMap<string, string> = new Map([
  ["space",   " "],
  ["dot",     "·"],
  ["newline", "\n"],
  ["tab",     "\t"],
  ["colon",   ":"],
  ["pipe",    "|"],
]);

const SEP_ALIAS_PREFIX = "alias:";

function resolveSepRef(raw: string): string | number | null {
  const alias = NAMED_SEPARATORS.get(raw);
  if (alias !== undefined) return SEP_ALIAS_PREFIX + raw;
  return null;
}

// Decode the value of `params.index` (set by resolveSepRef) into
// the literal separator body. Only the alias path is supported
// now; any other input returns INLINE_BADARG (unreachable in
// practice since resolveSepRef already filters).
function resolveSepBody(index: string | number): string | typeof INLINE_BADARG {
  if (typeof index === "string" && index.startsWith(SEP_ALIAS_PREFIX)) {
    const name = index.slice(SEP_ALIAS_PREFIX.length);
    return NAMED_SEPARATORS.get(name) ?? INLINE_BADARG;
  }
  return INLINE_BADARG;
}

// v0.9.0+ — ANSI SGR strip + display-width counter for `s_move`.
// Strips ESC[…m (color/style) and ESC[…<letter> (cursor moves
// handled as "no width" anyway — only SGR can leak into chunks
// since renderers don't emit cursor moves). Width is JS string
// length of the stripped result; deliberately NOT wcwidth (east-
// asian wide chars count as 1, not 2). The trade-off is "good
// enough for the column-pad use case without pulling in a wcwidth
// dep" — the user's examples are all ASCII-padded, and the
// statusline's primary consumer is plain-ASCII data.
//
// Used by renderTemplate's cursor tracking on every emitted
// chunk (the cursor lives in a closure, not in ctx, so a nested
// m_template's render never observes a half-updated value from
// its outer).
function visibleCellLength(s: string): number {
  // Replace each SGR with empty; `\x1b` = ESC, `[`, then any
  // number of params (digits + `;`) + a final letter.
  let stripped = "";
  let i = 0;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code === 0x1b && i + 1 < s.length && s.charCodeAt(i + 1) === 0x5b) {
      // Skip the CSI introducer and any params until the final
      // letter byte (0x40..0x7E). This covers SGR (m), cursor
      // moves (H/J/K), and any other CSI we might encounter — all
      // are zero-width for the column cursor.
      let j = i + 2;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) {
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    stripped += s[i];
    i++;
  }
  return stripped.length;
}

const INLINE_SCHEMAS: Record<string, InlineSchema> = {
  s_: {
    // vX.X.X+ — the implicit param accepts ONLY a named alias
    // (`s_space`, `s_dot`, `s_newline`, `s_tab`, `s_colon`,
    // `s_pipe`). The numeric `s_<n>` form is REMOVED — those tokens
    // are unrecognized and emitted as literals by the dispatcher.
    //
    // v0.7.2+ — added `|repeat|<1..8>` and `|wrap|<true|false>`
    // named params for inline separators. repeat multiplies the
    // body (1 default, max 8 — see REPEAT_PARAM). wrap=true pads
    // printable bodies with 1 space on each side so e.g.
    // `s_dot|wrap|true` renders " · " instead of "·"; whitespace
    // bodies (`s_space`, `s_tab`, `s_newline`) skip the padding.
    // See [[repeat-and-wrap-on-separator]].
    implicit: {
      name: "index",
      resolver: resolveSepRef,
    },
    named: {
      ...COLOR_PARAM.named,
      ...NULDROP_PARAM.named,
      ...REPEAT_PARAM.named,
      ...WRAP_PARAM.named,
    },
  },
  // v0.9.0+ — column-pad separator. `s_move|pos:<n>|char:<c>`
  // pads the current line with `<c>` until the visible-cell
  // cursor reaches column `<n>`. Bare `s_move` (no `pos:`) is
  // badarg per the user's "没带参数相当于无效" contract. The
  // dispatcher tracks the visible-cell cursor in a closure
  // (reset to 0 on every `\n`); the renderer reads it via the
  // passed-in `lineCursor` ctx field. NO implicit value — pos
  // and char are both named.
  s_move: {
    named: {
      ...MOVE_PARAM.named,
      ...COLOR_PARAM.named,
    },
  },
  m_label: {
    implicit: { name: "string", resolver: (raw) => raw },
    named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named },
  },
  m_modeLabel: {
    // No implicit — the string is derived from ctx. The first segment,
    // if present, MUST be a name in `named` (i.e. starts a name:value
    // pair). Otherwise the token is malformed. v0.8.41+: also
    // accepts `display` to override the prefix label's mode locally
    // (e.g. `m_modeLabel|display:remaining` flips "Usage:" →
    // "Remain:" without changing the global `display` config).
    // Ignored on the balance path (Balance: is mode-agnostic).
    named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...NULDROP_PARAM.named },
  },
  // v0.3.3+ — every existing module also accepts an optional :color|
  // override. Schema is empty (`{}`) when the module takes no implicit
  // param; the renderer just reads params.color and applies it.
  m_windowQuota: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...TERM_PARAM.named, ...NULDROP_PARAM.named } },
  m_countdown: { named: { ...COLOR_PARAM.named, ...TERM_PARAM.named, ...NULDROP_PARAM.named } },
  m_quota: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...TERM_PARAM.named, ...NULDROP_PARAM.named } },
  m_balance: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_age: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_version: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_tokenOut: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_contextSize: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_tokenHitRate: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_tokenCachedIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_tokenInSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_tokenOutSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  // v0.8.x cwf-tickStatus-v2 — m_totalToken* / m_totalTokenWithCacheIn
  // REMOVED. The m_acc* family replaces them.
  // v0.8.0+ — m_acc* family accepts :scope:<session|project|model>
  // (default session for the bare form) and the standard :color|
  // override + :nulldrop| opt-out. The legacy "ccsession" scope
  // was REMOVED in this revision and surfaces as badarg at
  // module-eval time (see resolveAccScope).
  m_accTokenIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_accTokenOut: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_accTokenCachedIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_accTokenTotalIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_accApiMs: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_accApiCalls: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  // v0.8.13+ — m_accTokenInSpeed / m_accTokenOutSpeed. Same arg
  // surface as the other m_acc* modules (color / nulldrop / scope).
  m_accTokenInSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_accTokenOutSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_accTokenHitRate: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  // v0.8.24+ — start of the tick statistics window. Same arg
  // surface as the other m_acc* modules (color / nulldrop / scope).
  // v0.8.25+ — |abs|<true|false> toggles YYYY-MM-DD HH:MM:SS vs HH:MM:SS.
  // vX.X.X+ — |valueOnly|<true|false> strips the label prefix (default false).
  m_accStartTime: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...ABS_PARAM.named, ...VALUEONLY_PARAM.named } },
  // v0.8.0+ — sum/avg advanced statistics. All 8 accept the same
  // 5 inline args: :model|<active|name|all>, :window|<dhms|all>,
  // :align|<true|false>, :color|<c>, :nulldrop|<b>. The WINDOW
  // resolver rejects malformed dhms strings at parse time →
  // badarg → dispatcher warn + drop. Same for the MODEL/ALIGN
  // schemas.
  m_sumTokenIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumTokenOut: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumTokenCachedIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumTokenTotalIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumApiMs: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumTokenHitRate: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumTokenInSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumTokenOutSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumApiCalls: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...VALUEONLY_PARAM.named } },
  // v0.8.24+ — start/end of the tick statistics window. Same 5-axis
  // arg surface as the other m_sum* modules (model/window/align +
  // color/nulldrop). Empty window / all-legacy rows → placeholder
  // (rendered via the matching m_sumStartTime / m_sumEndTime
  // PLACEHOLDERS entry — see `placeholderBare` at the dispatcher).
  // v0.8.25+ — |abs|<true|false> toggles YYYY-MM-DD HH:MM:SS vs HH:MM:SS.
  // vX.X.X+ — |valueOnly|<true|false> strips the label prefix (default false).
  m_sumStartTime: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...ABS_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumEndTime: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...ABS_PARAM.named, ...VALUEONLY_PARAM.named } },
  // v0.3.6+ — quote module. Accepts `:freq|<numeric-time>` and
  // `:color|<sgr|shortcut|rainbow|rand-rainbow|hue>`. The freq
  // grammar is the single-unit time format `<digits><unit>` (bare
  // unit letter = 1<unit>) — see QUOTE_FREQ_PARAM. Default freq
  // (`h` = 1h) is applied at the RENDERER level when params.freq
  // is undefined.
  m_quote: {
    named: {
      ...QUOTE_FREQ_PARAM.named,
      ...QUOTE_COLOR_PARAM.named,
      ...QUOTE_ADDRESS_PARAM.named,
      ...QUOTE_QUOTE_PARAM.named,
      ...QUOTE_AUTHOR_PARAM.named,
      ...QUOTE_LANG_PARAM.named,
      ...QUOTE_MAX_PARAM.named,
      ...QUOTE_INSECURE_TLS_PARAM.named,
      ...QUOTE_WRAP_CHARS_PARAM.named,
      ...NULDROP_PARAM.named,
    },
  },
  // v0.4.0+ — session-info / metadata modules. All take only the
  // optional :color| override (mirror the m_token* pattern).
  m_session: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_model: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_effort: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_repo: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_branch: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_gitStatus: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_ccVersion: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_ccversion: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_sessionDuration: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_sessionApiDuration: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  // v0.8.0+ — per-turn API-ms delta. Same inline-args grammar as
  // m_sessionDuration (color + nulldrop). The dispatcher accepts
  // both `:color|` and `:nulldrop|` overrides via this schema.
  m_apiMs: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_linesAdded: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_linesRemoved: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenInTotal: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_tokenTotalOut: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_tokenTotalIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_apiCalls: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_contextWindowsSize: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_contextUsedPercent: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_contextRemainingPercent: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_windowContext: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...NULDROP_PARAM.named } },
  // v0.8.16 — TTL gauge inline-args. Same shape as the rest of
  // the named-args family (color + nulldrop). `:color|<c>` REPLACES
  // the 5-band scale color; there is no `:scale|` opt-back-in
  // sentinel because TTL is binary "data vs missing" and forcing
  // green-on-fresh / red-on-stale is the natural rendering.
  m_cacheTtlStatus: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_statTtlStatus: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  // v0.8.17+ — system RAM usage inline-args. Same shape as the rest
  // of the named-args family (color + nulldrop). No scale / band
  // color for the value itself: the body is a string ("X.XG/Y.YG")
  // and the per-module DEFAULT_COLORS tint applies by default.
  m_memUsage: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  // v0.8.36+ — m_windowMemUsage inline-args. Same shape as
  // m_windowContext: color + display + nulldrop. |color|<c>
  // overrides the 5-band percentBands color; |display|<used|
  // remaining> selects which side of the bar is colored and
  // which percentage is shown (parallel to m_windowContext);
  // |nulldrop|<bool> drops the chunk on null.
  m_windowMemUsage: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...NULDROP_PARAM.named } },
  // vX.X.X+ — per-turn token cost inline-args. Same shape as the
  // per-turn m_token* family (color + nulldrop).
  m_tokenCost: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  // vX.X.X+ — accumulated token cost inline-args. Same arg surface
  // as m_accApiCalls (color + nulldrop + scope).
  m_accTokenCost: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  // vX.X.X+ — windowed token cost inline-args. Same 5-axis arg
  // surface as the other m_sum* modules (color + nulldrop + model +
  // window + align).
  m_sumTokenCost: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...VALUEONLY_PARAM.named } },
  // v0.4.0+ — sub-template reference. First argument is the key
  // into cfg().lineTemplates (the user's reusable-fragment
  // registry). Optional `:type|<plan|balance>` filter (default
  // "quota"): when the current provider's type key does not match,
  // the chunk drops so adjacent separators are skipped. We do
  // NOT accept `:color|` here — propagating a color across an
  // expanded template requires a more invasive design (the
  // expansion's internal modules would need to inherit or be
  // re-styled). Users wanting per-chunk color put `:color|` on
  // the inner modules inside their lineTemplates entry.
  //
  // m_template's `type` named arg is the providerType filter.
  // Accepts `quota` or `balance` — matches ctx.providerType
  // values verbatim. NOT forwarded via passThrough (m_template-
  // local concern, not an arg value to push to inner modules).
  m_template: {
    implicit: {
      name: "key",
      resolver: (raw) =>
        typeof raw === "string" && raw !== "" ? raw : null,
    },
    named: {
      type: (raw) => (raw === "quota" || raw === "balance" ? raw : null),
      // v0.9.0+ — `provider:<id>` gates the fragment to ONE specific
      // provider instance (e.g. `minimax` / `deepseek`).
      // Resolver accepts any non-empty string; the dispatcher does
      // strict-match against `ctx.currentProvider`. Absent → no gate
      // (fragment renders on every provider). Distinct from `type`
      // which gates by provider CATEGORY (`quota` / `balance`) and
      // matches every quota-mode provider — `provider` is the
      // narrower per-instance knob.
      provider: (raw) => (typeof raw === "string" && raw !== "" ? raw : null),
      // v0.8.7+ — passthrough whitelist. Each of these named
      // params is accepted on `m_template` and forwarded to the
      // inner module list as a fallback when the inner module's
      // own `params[<name>]` is undefined. Unknown args still
      // fail loud (parseInlineArgs → badarg → warn + drop), so
      // typos are not silently accepted. The whitelist mirrors
      // the param atoms that the `m_acc*` / `m_sum*` /
      // `m_template` consumers actually read.
      //
      // vX.X.X — `ALIGN_PARAM` retired in favor of
      // `ALIGN_PARAM` (no-op resolver that accepts
      // `true` / `false` for back-compat). Forwarding the no-op
      // `align` param to inner modules is still useful so a
      // pre-upgrade outer template carrying
      // `m_template|<key>|align|true` continues to parse without
      // the no-op value drowning out an inner module's own
      // `window` / `model` declarations on the same token.
      ...NULDROP_PARAM.named,
      ...COLOR_PARAM.named,
      ...SCOPE_PARAM.named,
      ...MODEL_PARAM.named,
      ...WINDOW_PARAM.named,
      ...ALIGN_PARAM.named,
      // vX.X.X+ — |valueOnly|<true|false> forwarded so an outer
      // m_template|<key>|valueOnly:true cascades to every
      // label-using inner module (per-turn / m_acc* / m_sum* /
      // m_memUsage). Default false.
      ...VALUEONLY_PARAM.named,
    },
  },
};

// Pure helper: wrap a plain-text body in `<color>…<RESET>`. Returns
// the body unchanged when `color` is undefined. Safe ONLY for bodies
// that don't already contain SGR sequences — colored bodies must use
// their override-aware helper (e.g. formatOneChunkColored).
function wrapPlain(body: string, color: string | undefined): string {
  return color ? `${color}${body}${RESET}` : body;
}

// v6.x — wrap a plain-text body with either the user's `|color|<c>`
// override or the module's hardcoded DEFAULT_COLORS entry. Used by
// every non-numeric m_* INLINE_RENDERER so bare-form parity holds:
// bare `m_session` (no params) tints to purple, and inline
// `m_session|color|green` overrides to green — exactly as the user
// would expect.
function wrapPlainDefault(
  modKey: string,
  body: string,
  paramsColor: string | undefined,
): string {
  const color = paramsColor ?? DEFAULT_COLORS[modKey];
  return color ? `${color}${body}${RESET}` : body;
}

// v0.8.13+ — "non-zero, non-null" default tint. Mirrors
// wrapPlainDefault but ONLY applies the color when `value` is a
// finite number and value > 0. The value=0 case emits plain text
// (matches the value-zero rule at [[render-value-zero-rule]]); the
// null/undefined case means the caller already took the
// placeholder path, so this helper is unreachable from there.
// Use when a module's DEFAULT_COLORS entry should NOT show on the
// natural 0 render (so "0" stays plain, "163.4k" is tinted).
function wrapValueDefault(
  modKey: string,
  value: number | null | undefined,
  body: string,
  paramsColor: string | undefined,
): string {
  const color = paramsColor ?? (typeof value === "number" && value > 0 ? DEFAULT_COLORS[modKey] : undefined);
  return color ? `${color}${body}${RESET}` : body;
}

// v0.8.7+ — resolve an inline-arg value with passthrough fallback.
// Resolution order: local `params[name]` (the inner module's own
// explicit arg) > `ctx.passThrough?.[name]` (an outer m_template's
// forwarded arg) > undefined (caller applies its own DEFAULT).
// Used by the m_acc* and m_sum* renderers so that a single
// `m_template|<key>|scope|model` caller can drive the inner
// module's `scope` choice without the inner module having to
// declare it. Inner-explicit-wins is the documented contract —
// the user explicitly chose it over a passthrough-beats-explicit
// alternative.
function passThroughOr<T extends ResolvedValue>(
  params: Record<string, ResolvedValue | undefined>,
  ctx: RenderContext,
  name: string,
): T | undefined {
  const local = params[name] as T | undefined;
  if (local !== undefined) return local;
  const pt = ctx.passThrough?.[name];
  return pt === undefined ? undefined : (pt as T);
}

// v0.8.7+ — build a merged `params` view that fills in any missing
// keys from `ctx.passThrough`. Used by renderers that hand `params`
// wholesale to a helper (e.g. `parseWindowScope`), so the helper
// can stay params-only and still see the outer m_template's
// forwarded values. Returns a fresh object — the original
// `params` is not mutated. Inner-explicit-wins is preserved
// because the merge is a one-way fill: local keys are kept as-is
// and only undefined slots take the passthrough value.
function mergePassThrough(
  params: Record<string, ResolvedValue | undefined>,
  ctx: RenderContext,
): Record<string, ResolvedValue | undefined> {
  if (!ctx.passThrough) return params;
  const out: Record<string, ResolvedValue | undefined> = { ...params };
  for (const [k, v] of Object.entries(ctx.passThrough)) {
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}

// Inline-form scope resolution for the m_acc* family. Reads from
// the inline params first, falls back to passThrough, then to
// "session". Throws badarg on the REMOVED "ccsession" scope so a
// leftover user config surfaces immediately at module-eval time
// instead of silently falling back to the new default. The single
// chokepoint keeps the m_acc* dispatchers thin and ensures the
// bare form (no params, no passThrough) and the inline form
// (`m_accTokenIn|scope|project`) share the same reject path.
function resolveAccScope(
  params: Record<string, ResolvedValue | undefined>,
  ctx: RenderContext,
): "session" | "project" | "model" {
  const raw = passThroughOr<ResolvedValue>(params, ctx, "scope");
  const v = raw === undefined || raw === null ? undefined : raw;
  if (v === "ccsession") {
    throw new Error(
      `badarg: scope="ccsession" is no longer supported — ` +
        `the m_acc* family now covers only session/project/model ` +
        `(use one of those, or omit :scope: for the session default)`,
    );
  }
  if (v === "session" || v === "project" || v === "model") return v;
  return "session";
}

// v0.8.7+ — passThroughScope handles MODULES-bare-path renderers
// that don't go through INLINE_RENDERERS and therefore can't call
// `passThroughOr(params, ctx, "scope")` — they only see
// `ctx.passThrough`. The legacy "ccsession" scope was REMOVED in
// this revision and is rejected with badarg so a leftover user
// config surfaces immediately rather than silently falling back
// to the new default. Returns undefined when passthrough is
// absent or the value is not a recognized scope (the caller then
// applies its own default).
function passThroughScope(
  ctx: RenderContext,
): "session" | "project" | "model" | undefined {
  const v = ctx.passThrough?.scope;
  if (v === "ccsession") {
    throw new Error(
      `badarg: scope="${v}" is no longer supported — ` +
        `the m_acc* family now covers only session/project/model ` +
        `(use one of those, or omit :scope: for the session default)`,
    );
  }
  if (v === "session" || v === "project" || v === "model") {
    return v;
  }
  return undefined;
}

// v0.4.x — parallel to MODULES' per-module `type` tag. Each entry
// here mirrors its INLINE_RENDERERS counterpart's provider scope:
// the inline form `m_windowQuota|color|…` is also plan-only; `m_balance|…`
// is balance-only. The bare-module dispatcher at line ~3220 enforces
// the same filter via `MODULES[name].type`; this map keeps the
// inline path symmetric so a `m_windowQuota|color|red` in a balance
// provider's template drops the same way the bare form does.
//
// Untagged entries (key absent from this map) are provider-agnostic;
// the dispatcher treats the absence of a key as "no type filter",
// matching the MODULES-default of type === undefined.
//
// Renamed from INLINE_MODE_FILTERS to INLINE_TYPE_FILTERS in v0.4.x
// to avoid collision with the display-mode field (`used` /
// `remaining` / `balance`).
const INLINE_TYPE_FILTERS: Partial<Record<string, "quota" | "balance" | "unknown">> = {
  m_windowQuota: "quota",
  m_countdown: "quota",
  m_quota: "quota",
  m_balance: "balance",
};

// v0.8.21+ — local QUOTES picker shared by the `m_quote` inline
// renderer and its bare MODULES twin. Honors `freq` (default
// 1h) + optional `lang` CSV filter. Returns null when the
// schema rejects the freq arg so the caller can fall through
// to `INLINE_BADARG` (or surface the placeholder path).
function pickLocalQuote(
  params: Readonly<Record<string, ResolvedValue>>,
  langRaw: string | undefined,
  ctx: RenderContext,
): string | null {
  const raw = params.freq as string | undefined;
  const parsed: QuoteFreq | null = parseFreq(raw ?? "h");
  if (!parsed) return null;
  const langs = (langRaw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const entry = langs.length > 0
    ? pickQuoteEntryFiltered(parsed, ctx.nowMs, langs)
    : pickQuoteEntry(parsed, ctx.nowMs);
  const maxRaw = params.max as string | undefined;
  const max = maxRaw !== undefined ? Number(maxRaw) : 60;
  const quote = truncateQuote(entry.quote, max);
  const author = entry.author ? truncateQuote(entry.author, max) : null;
  return author ? `${quote}--${author}` : quote;
}

// v0.8.21+ — deterministic seed for the color shortcut helpers
// (rainbow / hue) used by the local QUOTES path. Mirrors the
// bucket index so the same `freq` + `nowMs` lands on the same
// color band. Falls back to 0 when the freq arg is malformed.
function quoteLocalSeed(
  params: Readonly<Record<string, ResolvedValue>>,
  langRaw: string | undefined,
  ctx: RenderContext,
): number {
  const raw = params.freq as string | undefined;
  const parsed: QuoteFreq | null = parseFreq(raw ?? "h");
  if (!parsed) return 0;
  void langRaw;
  return quoteIndex(parsed, ctx.nowMs);
}

// Per-prefix renderer. Returns the chunk text (or null to drop).
const INLINE_RENDERERS: Record<string, InlineRenderer> = {
  // v0.9.0+ — column-pad renderer. Reads ctx.lineCursor (set by
  // the dispatcher's per-chunk closure; see renderTemplate), and
  // emits `repeat(char, pos - cursor)` to advance to `pos`.
  //
  // Cursor semantics:
  //   cursor >= pos → "误操作" (per the user's spec): the move
  //     would not advance (or would go backward) — warn + drop.
  //     Empty `char:` is treated as "move without emitting" and
  //     is also a no-op + warn when cursor >= pos (since the
  //     cursor doesn't move, there's nothing to do).
  //   cursor <  pos → emit (pos - cursor) chars; the dispatcher
  //     then accumulates the rendered chunk's width and bumps
  //     lineCursor to `pos`.
  //
  // Bare `s_move` (no `pos:` pair) is rejected upstream by the
  // MOVE_PARAM resolver: pos has no default — the schema's named
  // resolver returns null when `pos:` is absent, parseInlineArgs
  // surfaces that as badarg, and the dispatcher's existing
  // badarg path warns + drops the chunk.
  s_move: (params, ctx) => {
    const posRaw = params.pos as string | undefined;
    if (posRaw === undefined) return INLINE_BADARG; // bare form
    const pos = Number(posRaw);
    const cursor = ctx.lineCursor ?? 0;
    if (cursor >= pos) {
      // "误操作" — moving left or holding steady is a no-op +
      // warn. Per the user's spec this is treated like badarg.
      return INLINE_BADARG;
    }
    const ch = (params.char as string | undefined) ?? " ";
    const padLen = pos - cursor;
    if (padLen === 0) return INLINE_BADARG; // belt-and-braces
    const body = ch.repeat(padLen);
    return wrapPlain(body, params.color as string | undefined);
  },
  s_: (params, _ctx) => {
    // params.index is the output of resolveSepRef: a plain
    // number for the index form, or a "alias:<name>" string
    // for the named form. resolveSepBody decodes both and
    // returns either the literal body or INLINE_BADARG
    // (out-of-range). Inline-args path through here.
    const body = resolveSepBody(params.index);
    if (body === INLINE_BADARG) return INLINE_BADARG;
    // v0.7.2+ — repeat N times (validated by REPEAT_PARAM resolver
    // upstream; default "1"), then optionally pad with 1 space on
    // each side when wrap=true and the body is non-control. See
    // formatSepBody.
    const repeat = (params.repeat as string | undefined) ?? "1";
    const wrap = (params.wrap as string | undefined) ?? "true";
    const shape = formatSepBody(body, repeat, wrap);
    return wrapPlain(shape, params.color as string | undefined);
  },
  m_label: (params, _ctx) => {
    const s = params.string as string;
    if (s === "") return INLINE_BADARG; // empty payload is malformed
    return wrapPlain(s, params.color as string | undefined);
  },
  m_modeLabel: (params, ctx) => {
    // Mirrors the MODULES["m_modeLabel"] body: balance path → balance
    // label, else the mode-aware label. v6.x: inline form now ALSO
    // tints with DEFAULT_COLORS["m_modeLabel"] (=stale gray) so bare
    // vs inline parity holds for the prefix label too.
    // v0.8.41+: `display` inline arg overrides the label's mode locally
    // (e.g. `m_modeLabel|display:remaining` flips "Usage:" → "Remain:"
    // without changing the global `display` config). Ignored on the
    // balance path — Balance: has no used/remaining distinction.
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const s = ctx.providerType === "balance"
      ? cfg().modeLabels.balance
      : cfg().modeLabels[mode];
    return wrapPlainDefault("m_modeLabel", s, params.color as string | undefined);
  },
  m_windowQuota: (params, ctx) => {
    // v0.9.0+ — replaces v0.5.0–v0.8.x `m_window5h` + `m_window7d`.
    // The `term` inline arg picks which interval to read:
    //   |term|short  → c.intervals["short"] (default)
    //   |term|mid    → c.intervals["mid"]
    //   |term|long   → c.intervals["long"]
    //   |term|<any>  → c.intervals[<any>] (v0.9.4: open-ended
    //                    dict; "monthly" / "yearly" / etc. all
    //                    resolve via the same lookup)
    // Missing interval → placeholder. No percent data on the
    // resolved Interval → also placeholder (intervalToWindow
    // returns null when usedPercent/remainingPercent are both null).
    const term = (params.term as string | undefined) ?? "short";
    const iv = intervalForTerm(term, ctx);
    if (!iv) return placeholderWithColor("m_windowQuota", params, ctx);
    const w = intervalToWindow(iv);
    if (!w) return placeholderWithColor("m_windowQuota", params, ctx);
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const color = params.color as string | undefined;
    if (color) return formatOneChunkColored(w, mode, color);
    return formatOneChunk(w, mode, cfg().bar.width, ctx.stale);
  },
  m_countdown: (params, ctx) => {
    // v0.9.0+ — replaces v0.5.0–v0.8.x `m_countdown5h` +
    // `m_countdown7d`. Same `term` arg as `m_windowQuota` (open
    // dict in v0.9.4+). The label printed in `(n/a<arrow> <label>)`
    // and `(4h47m🕔 <label>)` is read from the live `Interval.label`
    // (no more hard-coded "5h" / "7d" strings).
    const term = (params.term as string | undefined) ?? "short";
    const iv = intervalForTerm(term, ctx);
    if (!iv) return placeholderWithColor("m_countdown", params, ctx);
    const w = intervalToWindow(iv);
    if (!w) return placeholderWithColor("m_countdown", params, ctx);
    if (isStaleAndPastDue(w, ctx.stale, ctx.nowMs)) {
      const userColor = params.color as string | undefined;
      const color = userColor ?? STALE_COLOR;
      const body = formatStalePastDueResetSuffix(iv.label, w, ctx.nowMs);
      return `${color}${body}${RESET}`;
    }
    const body = formatOneResetSuffix(iv.label, w, ctx.nowMs);
    if (body === "") return null;
    return wrapPlainDefault("m_countdown", body, params.color as string | undefined);
  },
  m_quota: (params, ctx) => {
    // v0.9.0+ — NEW module. vX.X.X+ — label moved to the tail,
    // so the shape is now `<labelQuota><axis>/<limit>(<interval.label>)`
    // (placeholder: `<labelQuota>n/a(<interval.label>)`).
    // `term` arg same shape as `m_windowQuota` / `m_countdown`
    // (v0.9.4+ open-ended dict lookup).
    // vX.X.X+ — `display` inline arg swaps the rendered axis:
    //   |display|used      → `<used>/<limit>`      (default)
    //   |display|remaining → `<remaining>/<limit>`
    const term = (params.term as string | undefined) ?? "short";
    const iv = intervalForTerm(term, ctx);
    if (!iv) return placeholderWithColor("m_quota", params, ctx);
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const parts = renderQuotaParts(iv, mode);
    if (!parts) return placeholderWithColor("m_quota", params, ctx);
    return wrapQuotaBody(parts, mode, params.color as string | undefined);
  },
  m_balance: (params, ctx) => {
    // v6.x: missing balance → "balance:n/a" placeholder (was:
    // drop). Multi-currency join still prefers the real chunk
    // when available; the placeholder only fires on the truly
    // empty case. Default tint comes from DEFAULT_COLORS — see
    // wrapPlainDefault below.
    if (!ctx.balance) return placeholderWithColor("m_balance", params, ctx);
    const color = (params.color as string | undefined) ?? DEFAULT_COLORS["m_balance"];
    const text = formatBalanceEntriesColored(ctx.balance, color);
    return text || placeholderWithColor("m_balance", params, ctx);
  },
  m_age: (params, ctx) => {
    // v6.x: missing ageMs → "age:n/a" placeholder (was: drop).
    if (ctx.ageMs == null) return placeholderWithColor("m_age", params, ctx);
    // v0.6.0+ — same cross-recursion dedup as the bare-MODULES path.
    // Whichever m_age instance fires first (bare or inline, top-level
    // or inside an m_template: fragment) claims the slot.
    if (ctx.ageEmittedRef?.value) return null;
    if (ctx.ageEmittedRef) ctx.ageEmittedRef.value = true;
    const color = (params.color as string | undefined) ?? DEFAULT_COLORS["m_age"];
    return formatStaleSuffix(ctx.ageMs, !ctx.stale, color);
  },
  m_version: (params, ctx) => {
    // v6.x: missing version → "v:n/a" placeholder (was: drop).
    if (!ctx.version) return placeholderWithColor("m_version", params, ctx);
    return wrapPlainDefault("m_version", `v${ctx.version}`, params.color as string | undefined);
  },
  m_tokenIn: (params, ctx) => {
    const r = computeTickDelta(ctx, "in");
    // vX.X.X+ — |valueOnly|true strips the leading label from
    // the pre-prefixed r.value (computeTickDelta builds
    // `${labelFor("in")}${body}`).
    const stripLabel = params.valueOnly === "true";
    const body = stripLabelIfValueOnly(r.value, "in", stripLabel);
    // v1.0 — setPrevTick moved to status-store.ts:processTick Stage 3. Render is read-only.
    // v0.8.30+ — bare default tint (brightGreen) on positive
    // value when the tick is active (hasMeasurement=true).
    // Idle ticks (hasMeasurement=false) get STALE_COLOR with
    // the live stdin number, per the v0.8.30.1 contract: color
    // tracks hasMeasurement, value tracks stdin. The user's
    // `|color|<c>` override wins on the active path; on the
    // idle path the user's color is honored (gray is a
    // semantic signal — "this is a stale read", not a
    // cosmetic preference — but the override is more specific
    // than the implicit STALE_COLOR).
    const userColor = params.color as string | undefined;
    if (r.numeric == null || r.numeric === 0) return body;
    if (r.stale) {
      return userColor ? `${userColor}${body}${RESET}` : `${STALE_COLOR}${body}${RESET}`;
    }
    return wrapValueDefault("m_tokenIn", r.numeric, body, userColor);
  },
  m_tokenOut: (params, ctx) => {
    const r = computeTickDelta(ctx, "out");
    // vX.X.X+ — |valueOnly|true strips the leading label.
    const stripLabel = params.valueOnly === "true";
    const body = stripLabelIfValueOnly(r.value, "out", stripLabel);
    // v1.0 — setPrevTick moved to status-store.ts:processTick Stage 3. Render is read-only.
    // v0.8.30+ — see m_tokenIn inline for the wrap contract.
    const userColor = params.color as string | undefined;
    if (r.numeric == null || r.numeric === 0) return body;
    if (r.stale) {
      return userColor ? `${userColor}${body}${RESET}` : `${STALE_COLOR}${body}${RESET}`;
    }
    return wrapValueDefault("m_tokenOut", r.numeric, body, userColor);
  },
  // v0.8.0+ — inline form of m_contextSize (cumulative occupancy,
  // total_input_tokens). See MODULES entry for the new semantic.
  // v0.8.23+ — prefix routes through labelFor("contextSize")
  // (labels.labelContextSize; default "size:").
  m_contextSize: (params, ctx) => {
    // vX.X.X+ — |valueOnly|true drops the "size:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("contextSize");
    const total = ctx.tokens?.totals?.tokenTotalIn;
    if (total == null) return placeholderWithColor("m_contextSize", params, ctx);
    return wrapPlain(
      `${prefix}${formatCompactToken(total)}`,
      params.color as string | undefined,
    );
  },
  // v0.8.0+ — per-turn hit rate (see MODULES entry for the
  // formula and rename rationale). The inline form takes an
  // optional `:color|` override; the bare form is the canonical
  // per-turn hit rate. The session-aggregate formula moved to
  // m_accTokenHitRate.
  m_tokenHitRate: (params, ctx) => {
    // vX.X.X+ — |valueOnly|true drops the "hit:" prefix.
    // v0.9.x — prefix routes through labels.labelTokenHitRate
    // (was hardcoded literal "hit:" in v0.8.x).
    const prefix = params.valueOnly === "true" ? "" : labelFor("hitRate");
    const t = ctx.tokens;
    if (!t) return placeholderWithColor("m_tokenHitRate", params, ctx);
    const total = t.totals?.tokenTotalIn;
    const cacheRead = t.current?.tokenCachedIn;
    if (total == null || cacheRead == null) {
      // v0.8.x — TTL-bounded cache fallback (mirrors MODULES path
      // and the m_apiMs / m_tokenInSpeed convention). Idle tick
      // within 60s of the last active tick renders the cached
      // percentage in STALE_COLOR; outside the window or with no
      // prior measurement, the placeholder drops in. STALE_COLOR
      // wins over the user's |color| override, matching
      // computeTickSpeed's convention — gray is the canonical
      // "this is from a previous tick" signal.
      if (t.sessionId) {
        const cached = peekLastTokenHitRate(t.sessionId, t.cwd);
        if (cached != null) {
          return wrapPlainDefault(
            "m_tokenHitRate",
            `${prefix}${cached.toFixed(cachePctPrecision())}%`,
            STALE_COLOR,
          );
        }
      }
      return placeholderWithColor("m_tokenHitRate", params, ctx);
    }
    if (total === 0) return `${STALE_COLOR}${prefix}0.0%${RESET}`;
    const pct = (cacheRead / total) * 100;
    // v1.0 — setLastTokenHitRate moved to status-store.ts:processTick
    // Stage 5. Render is read-only.
    // v0.8.x — "active" coloring (mirrors MODULES body and the
    // m_tokenInSpeed / m_tokenOutSpeed / m_apiMs convention). The
    // per-turn hit rate is only a fresh reading when the API
    // actually did work this tick (hasDelta=true). An idle tick
    // renders STALE_COLOR regardless of the user's |color|
    // override, matching computeTickSpeed.
    const r = getDeltaForRender();
    // v1.0 — setPrevTick moved to status-store.ts:processTick Stage 3. Render is read-only.
    if (!r.hasMeasurement) {
      return wrapPlainDefault(
        "m_tokenHitRate",
        `${prefix}${pct.toFixed(cachePctPrecision())}%`,
        STALE_COLOR,
      );
    }
    const color = (params.color as string | undefined) ?? cacheHitColor(pct);
    return `${color}${prefix}${pct.toFixed(cachePctPrecision())}%${RESET}`;
  },
  // v0.8.0+ — renamed from `m_cacheRead` (see MODULES entry). The
  // `(XX%)` share suffix was dropped in v0.8.6+ — use m_tokenHitRate
  // for the ratio.
  m_tokenCachedIn: (params, ctx) => {
    // v0.8.13 — cacheRead=null renders as "cache:0" (same as
    // the real-zero case). Treats "field not shipped" as zero so
    // the inline module always reads "cache:N" (no placeholder text
    // mixing with the value path).
    //
    // v0.8.13 — color unified with the m_token* sibling family:
    // default is PLAIN (no STALE_COLOR wrap), matching
    // m_tokenIn / m_tokenOut / m_tokenInTotal / m_tokenTotalOut.
    // The user's `|color|<c>` override still applies via wrapPlain.
    //
    // v0.8.13+ — non-zero / non-null default tint: when the
    // cacheRead value is a positive number, the chunk is wrapped
    // in DEFAULT_COLORS.m_tokenCachedIn (brown). value=0
    // (either explicit or null-as-zero collapse) stays plain.
    // vX.X.X+ — |valueOnly|true drops the "cache:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("cacheIn");
    const t = ctx.tokens?.current;
    if (!t) return wrapValueDefault("m_tokenCachedIn", 0, `${prefix}0`, params.color as string | undefined);
    if (t.tokenCachedIn == null) return wrapValueDefault("m_tokenCachedIn", 0, `${prefix}0`, params.color as string | undefined);
    return wrapValueDefault(
      "m_tokenCachedIn",
      t.tokenCachedIn,
      `${prefix}${formatCompactToken(t.tokenCachedIn)}`,
      params.color as string | undefined,
    );
  },
  // v0.8.40+ — per-turn token cost inline. Mirrors m_tokenCost MODULES
  // body (computed from current.* × the active model's price entry).
  // Same arg surface as m_tokenCachedIn (color + nulldrop + valueOnly).
  m_tokenCost: (params, ctx) => {
    const t = ctx.tokens;
    if (!t || !t.sessionId) return placeholderWithColor("m_tokenCost", params, ctx);
    // v0.9.x — active-model price entry. Miss OR all-zero prices
    // → placeholder (matches the v0.8.40 contract).
    const tp = resolveTokenPrice(t.modelId ?? null);
    if (!tp || tp.in + tp.out + tp.cachedIn <= 0) return placeholderWithColor("m_tokenCost", params, ctx);
    const r = getDeltaForRender();
    const liveIn = t.current.tokenIn ?? 0;
    const liveOut = t.current.tokenOut ?? 0;
    const liveCached = t.current.tokenCachedIn ?? 0;
    // tokenPrices values are per-million-tokens; divide by 1,000,000.
    const liveCost = ((tp.in / 1_000_000) * liveIn) + ((tp.out / 1_000_000) * liveOut) + ((tp.cachedIn / 1_000_000) * liveCached);
    const userColor = params.color as string | undefined;
    // v0.8.40+ — |valueOnly|true drops the "cost:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("cost");
    if (!r.hasMeasurement) {
      const color = userColor ?? STALE_COLOR;
      return `${color}${prefix}${formatCostWithCurrency(liveCost, tp.currency)}${RESET}`;
    }
    const cost = ((tp.in / 1_000_000) * r.in) + ((tp.out / 1_000_000) * r.out) + ((tp.cachedIn / 1_000_000) * r.cachedIn);
    return wrapValueDefault("m_tokenCost", cost, `${prefix}${formatCostWithCurrency(cost, tp.currency)}`, userColor);
  },
  // v0.4.0+ — :color|scale (or no :color| at all) → 5-band
  // scale color on the active tick, STALE_COLOR on the
  // cached/inactive tick. :color|<shortcut|SGR> → that exact
  // color on the active tick, STALE_COLOR on the cached
  // tick (per the user's "inactive 不受 :color| 影响"
  // decision — gray is the canonical "stale" signal).
  m_tokenInSpeed: (params, ctx) => {
    const probe = computeTickSpeed(ctx, "in", STALE_COLOR);
    const userColor = params.color as string | undefined;
    const activeColor =
      userColor === SCALE_COLOR_SENTINEL || userColor == null
        ? speedScaleColor("in", probe.tps ?? 0)
        : (userColor ?? STALE_COLOR);
    const r = computeTickSpeed(ctx, "in", activeColor);
    // v1.0 — setPrevTick moved to status-store.ts:processTick Stage 3. Render is read-only.
    // vX.X.X+ — |valueOnly|true strips the "in:" prefix. computeTickSpeed
    // pre-prefixes the value with labelFor("inSpeed"), so we strip that
    // substring (colored chunk is downstream of the label).
    if (params.valueOnly === "true") return r.value.replace(labelFor("inSpeed"), "");
    return r.value;
  },
  m_tokenOutSpeed: (params, ctx) => {
    const probe = computeTickSpeed(ctx, "out", STALE_COLOR);
    const userColor = params.color as string | undefined;
    const activeColor =
      userColor === SCALE_COLOR_SENTINEL || userColor == null
        ? speedScaleColor("out", probe.tps ?? 0)
        : (userColor ?? STALE_COLOR);
    const r = computeTickSpeed(ctx, "out", activeColor);
    // v1.0 — setPrevTick moved to status-store.ts:processTick Stage 3. Render is read-only.
    // vX.X.X+ — |valueOnly|true strips the "out:" prefix.
    if (params.valueOnly === "true") return r.value.replace(labelFor("outSpeed"), "");
    return r.value;
  },
  // v0.8.x cwf-tickStatus-v2 — m_totalToken* / m_totalTokenWithCacheIn
  // REMOVED. Use the m_acc* family (scope=session default).
  // v0.8.0+ — 6 acc modules (m_accTokenIn / Out / CachedIn / TotalIn /
  // ApiMs / CacheHitRate). Three-layer granularity via :scope:
  //   session (default) — per-claude-code-session (clear-bounded)
  //   project — crosses session boundaries within the same cwd
  //   model — crosses session boundaries within the same model
  // All read from the v0.8.0 AccSnapshot slot populated by setAvg
  // (which writes 3 slots per tick: session/project/model). The
  // scope→slot mapping is hidden inside peekAcc; renderers just
  // pass the resolved scope through. The legacy `scope=ccsession`
  // surface was REMOVED; a leftover config surfaces as badarg
  // (see resolveAccScope).
  m_accTokenIn: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    // v0.8.30+ — bare default tint (brightGreen) on positive
    // accumulator value. `wrapValueDefault` replaces the
    // previous `wrapPlainDefault` so the value-zero rule
    // applies: acc:0 stays plain.
    const v = peekAcc(scope, ctx);
    const n = v ? v.accTokenIn : 0;
    return wrapValueDefault("m_accTokenIn", n, accBody(ctx, "in", scope, passThroughOr<string>(params, ctx, "valueOnly") === "true"), passThroughOr<string>(params, ctx, "color"));
  },
  m_accTokenOut: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    // v0.8.30+ — bare default tint (red) on positive value; see
    // m_accTokenIn for the wrap contract.
    const v = peekAcc(scope, ctx);
    const n = v ? v.accTokenOut : 0;
    return wrapValueDefault("m_accTokenOut", n, accBody(ctx, "out", scope, passThroughOr<string>(params, ctx, "valueOnly") === "true"), passThroughOr<string>(params, ctx, "color"));
  },
  m_accTokenCachedIn: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    const v = peekAcc(scope, ctx);
    const n = v ? v.accTokenCachedIn : 0;
    return wrapValueDefault("m_accTokenCachedIn", n, accBody(ctx, "cached", scope, passThroughOr<string>(params, ctx, "valueOnly") === "true"), passThroughOr<string>(params, ctx, "color"));
  },
  m_accTokenTotalIn: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    const v = peekAcc(scope, ctx);
    const n = v ? v.accTokenIn + v.accTokenCachedIn : 0;
    return wrapValueDefault("m_accTokenTotalIn", n, accBody(ctx, "total", scope, passThroughOr<string>(params, ctx, "valueOnly") === "true"), passThroughOr<string>(params, ctx, "color"));
  },
  m_accApiMs: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    const v = peekAcc(scope, ctx);
    const n = v ? v.accApiMs : 0;
    return wrapValueDefault("m_accApiMs", n, accBody(ctx, "apiMs", scope, passThroughOr<string>(params, ctx, "valueOnly") === "true"), passThroughOr<string>(params, ctx, "color"));
  },
  m_accApiCalls: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    const v = peekAcc(scope, ctx);
    const n = v ? v.accApiCalls : 0;
    return wrapValueDefault("m_accApiCalls", n, accBody(ctx, "apiCalls", scope, passThroughOr<string>(params, ctx, "valueOnly") === "true"), passThroughOr<string>(params, ctx, "color"));
  },
  // vX.X.X+ — accumulated token cost inline. Computed from peekAcc ×
  // tokenPrice. Same arg surface as m_accApiCalls (color/nulldrop/scope).
  m_accTokenCost: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    const v = peekAcc(scope, ctx);
    if (!v) return placeholderWithColor("m_accTokenCost", params, ctx);
    // v0.9.x — active-model price entry. Miss OR all-zero prices
    // → placeholder (matches the v0.8.40 contract).
    const tp = resolveTokenPrice(ctx.tokens?.modelId ?? null);
    if (!tp || tp.in + tp.out + tp.cachedIn <= 0) return placeholderWithColor("m_accTokenCost", params, ctx);
    const cost = ((tp.in / 1_000_000) * v.accTokenIn) + ((tp.out / 1_000_000) * v.accTokenOut) + ((tp.cachedIn / 1_000_000) * v.accTokenCachedIn);
    // v0.8.40+ — |valueOnly|true drops the "cost:" prefix.
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("cost");
    return wrapValueDefault("m_accTokenCost", cost, `${prefix}${formatCostWithCurrency(cost, tp.currency)}`, passThroughOr<string>(params, ctx, "color"));
  },
  // v0.8.13+ — inline m_accTokenInSpeed / m_accTokenOutSpeed.
  // Mirrors m_tokenInSpeed / m_tokenOutSpeed contract: `:color|scale`
  // (or no `:color|`) → 5-band scale on the active rollup, the
  // user's explicit `:color|<c>` wins over the scale, and the
  // `peekAcc==null` path emits "direction:n/a".
  m_accTokenInSpeed: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    const probe = computeAccSpeed(ctx, scope, "in", STALE_COLOR);
    const userColor = passThroughOr<string>(params, ctx, "color");
    const activeColor =
      userColor === SCALE_COLOR_SENTINEL || userColor == null
        ? (probe.active ? speedScaleColor("in", probe.tps ?? 0) : STALE_COLOR)
        : userColor;
    const r = computeAccSpeed(ctx, scope, "in", activeColor);
    // vX.X.X+ — |valueOnly|true strips the "in:" prefix from r.value.
    if (passThroughOr<string>(params, ctx, "valueOnly") === "true") return r.value.replace(labelFor("inSpeed"), "");
    return r.value;
  },
  m_accTokenOutSpeed: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    const probe = computeAccSpeed(ctx, scope, "out", STALE_COLOR);
    const userColor = passThroughOr<string>(params, ctx, "color");
    const activeColor =
      userColor === SCALE_COLOR_SENTINEL || userColor == null
        ? (probe.active ? speedScaleColor("out", probe.tps ?? 0) : STALE_COLOR)
        : userColor;
    const r = computeAccSpeed(ctx, scope, "out", activeColor);
    // vX.X.X+ — |valueOnly|true strips the "out:" prefix from r.value.
    if (passThroughOr<string>(params, ctx, "valueOnly") === "true") return r.value.replace(labelFor("outSpeed"), "");
    return r.value;
  },
  // Hit rate is special: session-scoped by default. Pass
  // :scope:project / :scope:model to widen the rollup.
  // v0.8.10-alpha.3 — reads TickStatusValue.accTokenHitRate directly.
  m_accTokenHitRate: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    const v = peekAcc(scope, ctx);
    if (!v) return placeholderAcc("hitRate", scope, passThroughOr<string>(params, ctx, "valueOnly") === "true");
    const pct = v.accTokenHitRate;
    const color = passThroughOr<string>(params, ctx, "color") ?? cacheHitColor(pct);
    // vX.X.X+ — |valueOnly|true drops the "hit:" prefix.
    // v0.9.x — prefix routes through labels.labelTokenHitRate
    // (was hardcoded literal "hit:" in v0.8.x).
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("hitRate");
    return `${color}${prefix}${pct.toFixed(cachePctPrecision())}%${RESET}`;
  },
  // v0.8.24+ — start of the tick statistics window. Inline form
  // supports :scope: (default session) and :color: override on
  // the rendered "HH:MM:SS" body. Missing slot / legacy
  // state.json without startAt → `start:n/a` placeholder.
  m_accStartTime: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    const v = peekAcc(scope, ctx);
    // vX.X.X+ — |valueOnly|true drops the "start:" prefix.
    const strip = passThroughOr<string>(params, ctx, "valueOnly") === "true";
    const startAt = v?.startAt ?? null;
    if (startAt == null) return placeholderAcc("startTime", scope, strip);
    const userColor = passThroughOr<string>(params, ctx, "color");
    // v0.8.25+ — |abs|inline override; default off so v0.8.24 renders are byte-identical.
    const abs = passThroughOr<string>(params, ctx, "abs") === "true";
    const prefix = strip ? "" : labelFor("startTime");
    return wrapPlain(`${prefix}${formatAbsTime(startAt, { abs })}`, userColor);
  },
  // v0.8.0+ — sum/avg inline renderers. Same body shape as the
  // bare-form MODULES entries; the inline path passes params so
  // :model|/:window|/:align| take effect. A parse failure on the
  // inline args has already dropped the token at the schema
  // resolver, so parseWindowScope here is the runtime fallback
  // for unexpected shapes (null → INLINE_BADARG path).
  m_sumTokenIn: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumTokenIn", params, ctx);
    // v0.8.30+ — bare default tint (brightGreen) on positive
    // sum; user `|color|<c>` override wins; sum=0 stays plain
    // (value-zero rule).
    // vX.X.X+ — |valueOnly|true drops the "in:" prefix.
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("in");
    return wrapValueDefault(
      "m_sumTokenIn",
      agg.sumIn,
      `${prefix}${formatCompactToken(agg.sumIn)}`,
      passThroughOr<string>(params, ctx, "color"),
    );
  },
  m_sumTokenOut: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumTokenOut", params, ctx);
    // v0.8.30+ — bare default tint (red) on positive sum; see
    // m_sumTokenIn for the wrap contract.
    // vX.X.X+ — |valueOnly|true drops the "out:" prefix.
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("out");
    return wrapValueDefault(
      "m_sumTokenOut",
      agg.sumOut,
      `${prefix}${formatCompactToken(agg.sumOut)}`,
      passThroughOr<string>(params, ctx, "color"),
    );
  },
  m_sumTokenCachedIn: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumTokenCachedIn", params, ctx);
    // vX.X.X+ — |valueOnly|true drops the "cache:" prefix.
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("cacheIn");
    return wrapValueDefault("m_sumTokenCachedIn", agg.sumCached, `${prefix}${formatCompactToken(agg.sumCached)}`, passThroughOr<string>(params, ctx, "color"));
  },
  m_sumTokenTotalIn: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumTokenTotalIn", params, ctx);
    // vX.X.X+ — |valueOnly|true drops the "total:" prefix.
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("totalIn");
    return wrapValueDefault("m_sumTokenTotalIn", agg.sumTotalIn, `${prefix}${formatCompactToken(agg.sumTotalIn)}`, passThroughOr<string>(params, ctx, "color"));
  },
  // vX.X.X+ — windowed token cost inline. Same 5-axis arg surface
  // as the other m_sum* modules (model/window/align + color/nulldrop).
  m_sumTokenCost: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumTokenCost", params, ctx);
    // v0.9.x — explicit |model|<literal> wins; otherwise active
    // model id. (Same rule as the MODULES form.)
    const lookupId = filter.modelFilter !== undefined ? filter.modelFilter : ctx.tokens?.modelId;
    const tp = resolveTokenPrice(lookupId ?? null);
    // v0.9.x — miss OR all-zero prices → placeholder (matches
    // the v0.8.40 "unconfigured → cost:n/a" contract).
    if (!tp || tp.in + tp.out + tp.cachedIn <= 0) return placeholderWithColor("m_sumTokenCost", params, ctx);
    const cost = ((tp.in / 1_000_000) * agg.sumIn) + ((tp.out / 1_000_000) * agg.sumOut) + ((tp.cachedIn / 1_000_000) * agg.sumCached);
    // v0.8.40+ — |valueOnly|true drops the "cost:" prefix.
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("cost");
    return wrapValueDefault("m_sumTokenCost", cost, `${prefix}${formatCostWithCurrency(cost, tp.currency)}`, passThroughOr<string>(params, ctx, "color"));
  },
  m_sumApiMs: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumApiMs", params, ctx);
    // v0.8.13+ — prefix routes through labelFor(labels.labelApi);
    // default "api:" preserves the v0.8.x literal.
    // vX.X.X+ — |valueOnly|true drops the "api:" prefix.
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("apiMs");
    return wrapValueDefault("m_sumApiMs", agg.sumApiMs, `${prefix}${formatRemainingMs(agg.sumApiMs)}`, passThroughOr<string>(params, ctx, "color"));
  },
  m_sumTokenHitRate: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    const denom = agg.sumIn + agg.sumCached;
    if (agg.rows === 0 || denom === 0) return placeholderWithColor("m_sumTokenHitRate", params, ctx);
    const pct = (agg.sumCached / denom) * 100;
    // vX.X.X+ — |valueOnly|true drops the "hit:" prefix.
    // v0.9.x — prefix routes through labels.labelTokenHitRate
    // (was hardcoded literal "hit:" in v0.8.x).
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("hitRate");
    return `${cacheHitColor(pct)}${prefix}${pct.toFixed(cachePctPrecision())}%${RESET}`;
  },
  m_sumTokenInSpeed: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (process.env.TOPGAUGE_DEBUG_SUMSPEED) {
      // eslint-disable-next-line no-console
      console.error("[diag-renderer] m_sumTokenInSpeed params=", JSON.stringify(params), "filter=", filter);
    }
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.sumApiMs === 0) return placeholderWithColor("m_sumTokenInSpeed", params, ctx);
    const tps = (agg.sumIn / agg.sumApiMs) * 1000;
    // v0.8.13+ — speedScaleColor (`:color|scale` → scale,
    // `:color|<c>` → that color, no `:color|` → scale default).
    // v0.8.13+ — prefix routes through labelFor(labels.labelInSpeed);
    // default "in:" preserves today's literal.
    // vX.X.X+ — |valueOnly|true drops the "in:" prefix.
    const userColor = passThroughOr<string>(params, ctx, "color");
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("inSpeed");
    const color =
      userColor === SCALE_COLOR_SENTINEL || userColor == null
        ? speedScaleColor("in", tps)
        : userColor;
    return `${color}${prefix}${formatSpeed(tps)}${RESET}`;
  },
  m_sumTokenOutSpeed: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.sumApiMs === 0) return placeholderWithColor("m_sumTokenOutSpeed", params, ctx);
    const tps = (agg.sumOut / agg.sumApiMs) * 1000;
    // v0.8.13+ — prefix routes through labelFor(labels.labelOutSpeed);
    // default "out:" preserves today's literal.
    // vX.X.X+ — |valueOnly|true drops the "out:" prefix.
    const userColor = passThroughOr<string>(params, ctx, "color");
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("outSpeed");
    const color =
      userColor === SCALE_COLOR_SENTINEL || userColor == null
        ? speedScaleColor("out", tps)
        : userColor;
    return `${color}${prefix}${formatSpeed(tps)}${RESET}`;
  },
  // v0.8.x — total count of API calls in window. See MODULES twin.
  m_sumApiCalls: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.calls === 0) return placeholderWithColor("m_sumApiCalls", params, ctx);
    // v0.8.13+ — prefix routes through labelFor(labels.labelApiCalls);
    // default "calls:" preserves the v0.8.x literal.
    // vX.X.X+ — |valueOnly|true drops the "calls:" prefix.
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("apiCalls");
    return wrapValueDefault("m_sumApiCalls", agg.calls, `${prefix}${agg.calls}`, passThroughOr<string>(params, ctx, "color"));
  },
  // v0.8.24+ — start of the tick statistics window across the
  // filtered JSONL rows. min(s.startAt) over the
  // window/model/align-filtered sample set. Empty / all-legacy
  // window → `start:n/a` placeholder (m_sumStartTime PLACEHOLDERS
  // entry). Same 5-axis arg surface as the other m_sum* modules.
  m_sumStartTime: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumStartTime", params, ctx);
    const abs = passThroughOr<string>(params, ctx, "abs") === "true";
    const color = passThroughOr<string>(params, ctx, "color");
    // vX.X.X+ — |valueOnly|true drops the "start:" prefix.
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("startTime");
    // vX.X.X — mirror of the bare-form branch above: align=true
    // + declared-windowId resolution sets `alignActive=true +
    // interval!=null`, which gates the plan-anchor rendering
    // (window.resetStartAt). align=false (default) OR dhms / "all"
    // resolution lands on the empirical agg.firstAt branch below.
    if (filter.alignActive && filter.interval != null) {
      const w = intervalToWindow(filter.interval);
      if (
        w != null &&
        typeof w.resetStartAt === "string" &&
        (w.resetDurationMs ?? 0) > 0
      ) {
        const anchorMs = Date.parse(w.resetStartAt);
        if (Number.isFinite(anchorMs)) {
          return wrapPlain(`${prefix}${formatAbsTime(anchorMs, { abs })}`, color);
        }
      }
    }
    if (!Number.isFinite(agg.firstAt) || agg.firstAt <= 0) {
      return placeholderWithColor("m_sumStartTime", params, ctx);
    }
    return wrapPlain(`${prefix}${formatAbsTime(agg.firstAt, { abs })}`, color);
  },
  // v0.8.24+ — end of the tick statistics window across the
  // filtered JSONL rows. max(s.lastAt) over the filtered sample
  // set. lastAt mirrors the row's `at` field (the wall-clock
  // instant of that tick), so max(lastAt) is the "newest tick"
  // in the window — the dual of m_sumStartTime. Empty /
  // all-legacy window → `end:n/a` placeholder.
  // v0.8.27+ — align=true surfaces the plan window's close
  // instant (ctx.fiveHour/weekly.resetAt) when the matching
  // Window ships one.
  m_sumEndTime: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumEndTime", params, ctx);
    const abs = passThroughOr<string>(params, ctx, "abs") === "true";
    const color = passThroughOr<string>(params, ctx, "color");
    // vX.X.X+ — |valueOnly|true drops the "end:" prefix.
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("endTime");
    // vX.X.X — mirror of the bare-form branch above. align=true +
    // declared-windowId resolution → plan window's resetAt close
    // instant; everything else (align=false default, or dhms /
    // "all" resolution) → empirical max(s.lastAt) fallback. The
    // v0.8.x `alignActive` flag is gone — the resolver emits
    // `alignActive` directly off the resolution path.
    if (filter.alignActive && filter.interval != null) {
      const w = intervalToWindow(filter.interval);
      if (w != null && typeof w.resetAt === "string") {
        const anchorMs = Date.parse(w.resetAt);
        if (Number.isFinite(anchorMs)) {
          return wrapPlain(`${prefix}${formatAbsTime(anchorMs, { abs })}`, color);
        }
      }
    }
    if (!Number.isFinite(agg.lastAt) || agg.lastAt <= 0) {
      return placeholderWithColor("m_sumEndTime", params, ctx);
    }
    return wrapPlain(`${prefix}${formatAbsTime(agg.lastAt, { abs })}`, color);
  },
  m_quote: (params, ctx) => {
    // v0.8.21+ — when `address` is non-empty, fetch the remote
    // payload (pre-fetched by `preFetchQuotes`, see
    // `src/api.quote.ts`) and walk the `quote` (+ optional
    // `author`) paths to extract strings. On any failure
    // (no body, non-JSON body where `quote` is non-empty, or
    // quote path miss) we FALL BACK to the local QUOTES path.
    // Pass |nulldrop|true (default) to drop the chunk on
    // local-quote miss instead of surfacing the placeholder.
    //
    // Output format (v0.9.x — `wrap` redesign):
    //   - `wrap` missing or empty → raw `<quote>--<author>` text
    //   - `wrap=<chars>` → `<pair[0]><quote>--<author><pair[1]>`
    //     where `pair` is 1-char-duped / 2+-sliced from `wrap`
    //   - applies to BOTH address-mode and local-mode (was
    //     address-only with hard-coded `~` in v0.8.21+).
    //   - bare-body short-circuit (no `quote:` path → raw body
    //     verbatim) is un-wrapped so the user sees the exact body
    //     they fetched.
    //
    // The fetch path IGNORES `freq` / `lang` for rotation
    // (remote payloads are not window-bucketed — the user picks
    // an endpoint that returns stable strings or rotates on its
    // own schedule).
    const address = params.address as string | undefined;
    const quoteRaw = (params.quote as string | undefined) ?? "";
    const authorRaw = params.author as string | undefined;
    const langRaw = params.lang as string | undefined;
    // `quote` arg present (even if empty) → user opted into the
    // address-mode branch. Missing arg → local QUOTES.
    const hasQuote = (params.quote as string | undefined) !== undefined;
    // `wrap` is a 2-char string when supplied (the schema's
    // char-pair resolver has already normalized 1-char duplicate
    // and 2+-slice). Empty string OR undefined both mean
    // "no-op, render raw text". passThroughOr keeps the
    // m_template|<key>|wrap|<chars> passthrough working.
    const wrapPair = passThroughOr<string>(params, ctx, "wrap");
    const applyWrap = (body: string, walkedJson: boolean): string => {
      // Bare-body short-circuit (v0.8.18) — user opted out of
      // walking by not setting `quote:`, return verbatim with
      // no brackets. Otherwise wrap if a 2-char pair was supplied.
      if (!walkedJson) return body;
      if (!wrapPair || wrapPair.length !== 2) return body;
      return `${wrapPair[0]}${body}${wrapPair[1]}`;
    };
    let text: string;
    let seed: number;
    if (address && address.length > 0 && hasQuote) {
      const remote = fetchQuoteFromAddress(address, quoteRaw, authorRaw, ctx);
      if (remote !== null) {
        const maxRaw = params.max as string | undefined;
        const max = maxRaw !== undefined ? Number(maxRaw) : 60;
        const tQuote = truncateQuote(remote.quote, max);
        const tAuthor = remote.author ? truncateQuote(remote.author, max) : null;
        const authorSuffix = tAuthor ? `--${tAuthor}` : "";
        const inner = `${tQuote}${authorSuffix}`;
        const walkedJson = quoteRaw.length > 0;
        text = applyWrap(inner, walkedJson);
        // Seed for the color shortcut helpers (rainbow / hue).
        // Hash the body (NOT the wrapped text) so distinct
        // truncations of the same remote source still get
        // distinct color bands — wrapping chars don't shift the
        // band selection.
        seed = stringHash(tQuote);
      } else {
        // Fetch / parse / quote-miss → fall back to local QUOTES.
        const local = pickLocalQuote(params, langRaw, ctx);
        if (local === null) return INLINE_BADARG;
        // Local-mode always wraps (no bare-body short-circuit —
        // the local picker always emits a well-formed
        // `<quote>--<author>` body, so wrapping it is meaningful).
        text = applyWrap(local, true);
        seed = quoteLocalSeed(params, langRaw, ctx);
      }
    } else {
      // Local QUOTES path. Default freq = 1h. The schema resolver
      // already shape-validated the raw string; we now parse it
      // into a QuoteFreq {count, unit, ms} object that the picker
      // needs. params.freq is undefined when the token is just
      // `m_quote` or `m_quote|color|red`. On a malformed-but-
      // shape-valid string we INLINE_BADARG here; in practice
      // parseFreq rejects the same set the resolver.
      const local = pickLocalQuote(params, langRaw, ctx);
      if (local === null) return INLINE_BADARG;
      text = applyWrap(local, true);
      seed = quoteLocalSeed(params, langRaw, ctx);
    }
    const color = decodeColorParam(params.color as string | undefined);
    return applyColor(text, color, seed);
  },
  // v0.4.0+ — session-info / metadata inline renderers. All mirror
  // their MODULES counterparts but accept an optional :color| override.
  m_session: (params, ctx) => {
    const s = ctx.tokens?.sessionName;
    if (s == null) return placeholderWithColor("m_session", params, ctx);
    return wrapPlainDefault("m_session", s, params.color as string | undefined);
  },
  m_model: (params, ctx) => {
    const s = ctx.tokens?.modelDisplayName;
    if (s == null) return placeholderWithColor("m_model", params, ctx);
    return wrapPlainDefault("m_model", s, params.color as string | undefined);
  },
  m_effort: (params, ctx) => {
    const s = ctx.tokens?.effort;
    if (s == null) return placeholderWithColor("m_effort", params, ctx);
    return wrapPlainDefault("m_effort", s, params.color as string | undefined);
  },
  m_repo: (params, ctx) => {
    const r = ctx.tokens?.repo;
    if (!r) return placeholderWithColor("m_repo", params, ctx);
    const parts = [r.host, r.owner, r.name].filter(
      (p): p is string => p != null && p.length > 0,
    );
    if (parts.length === 0) return placeholderWithColor("m_repo", params, ctx);
    return wrapPlainDefault("m_repo", parts.join("/"), params.color as string | undefined);
  },
  m_branch: (params, ctx) => {
    const branch = readGitInfo(ctx.tokens?.cwd)?.branch;
    if (branch == null) return placeholderWithColor("m_branch", params, ctx);
    return wrapPlainDefault("m_branch", branch, params.color as string | undefined);
  },
  m_gitStatus: (params, ctx) => {
    const info = readGitInfo(ctx.tokens?.cwd);
    if (info == null) return placeholderWithColor("m_gitStatus", params, ctx);
    return wrapPlainDefault("m_gitStatus", info.dirty ? "dirty" : "clean", params.color as string | undefined);
  },
  m_ccVersion: (params, ctx) => {
    const v = ctx.tokens?.ccversion;
    if (v == null) return placeholderWithColor("m_ccVersion", params, ctx);
    return wrapPlainDefault("m_ccVersion", v, params.color as string | undefined);
  },
  // Deprecated alias — same body as m_ccVersion.
  m_ccversion: (params, ctx) => {
    const v = ctx.tokens?.ccversion;
    if (v == null) return placeholderWithColor("m_ccversion", params, ctx);
    return wrapPlainDefault("m_ccversion", v, params.color as string | undefined);
  },
  m_sessionDuration: (params, ctx) => {
    const ms = ctx.tokens?.cost.totalDurationMs;
    if (ms == null) return placeholderWithColor("m_sessionDuration", params, ctx);
    return wrapPlainDefault("m_sessionDuration", formatRemainingMs(ms), params.color as string | undefined);
  },
  m_sessionApiDuration: (params, ctx) => {
    const ms = ctx.tokens?.cost.totalApiDurationMs;
    if (ms == null) return placeholderWithColor("m_sessionApiDuration", params, ctx);
    return wrapPlainDefault("m_sessionApiDuration", formatRemainingMs(ms), params.color as string | undefined);
  },
  // v0.8.0+ — per-turn API-ms delta (mirror of MODULES path with
  // inline-args color support). Bare-form default color comes
  // from DEFAULT_COLORS.m_apiMs; the inline `:color|` override
  // takes precedence here.
  m_apiMs: (params, ctx) => {
    const t = ctx.tokens;
    if (!t || !t.sessionId) return placeholderWithColor("m_apiMs", params, ctx);
    const r = getDeltaForRender();
    // vX.X.X+ — |valueOnly|true drops the "api:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("apiMs");
    // v1.0 — setPrevTick moved to status-store.ts:processTick Stage 3. Render is read-only.
    if (!r.hasMeasurement) {
      // v0.8.x — TTL-bounded cache fallback (mirrors MODULES path
      // and the m_tokenInSpeed/m_tokenOutSpeed convention). Idle
      // tick within 60s of the last active tick renders the
      // cached deltaApiMs in STALE_COLOR; outside the window or
      // with no prior measurement, the placeholder drops in.
      const cached = peekLastApiMs(t.sessionId, t.cwd);
      if (cached != null) {
        // v0.8.x — the user's inline `|color|` override loses to
        // the STALE_COLOR convention here, matching the tps
        // siblings: gray signals "this is from a previous API
        // call, not this tick" regardless of the user's color
        // choice. See computeTickSpeed.
        return wrapPlainDefault(
          "m_apiMs",
          `${prefix}${formatRemainingMs(cached)}`,
          STALE_COLOR,
        );
      }
      return placeholderWithColor("m_apiMs", params, ctx);
    }
    // v1.0 — setLastApiMs moved to status-store.ts:processTick
    // Stage 5. Render is read-only.
    // v0.8.13+ — non-zero, non-null default tint: when the
    // per-turn apiMs delta is a positive number, wrap in
    // DEFAULT_COLORS.m_apiMs (brown). 0 stays plain (value-zero
    // rule); STALE_COLOR still wins on the cached/idle branch
    // above. v0.8.13+ — prefix routes through labelFor
    // (labels.labelApi); default "api:" preserves the v0.8.x literal.
    return wrapValueDefault("m_apiMs", r.apiMs, `${prefix}${formatRemainingMs(r.apiMs)}`, params.color as string | undefined);
  },
  m_linesAdded: (params, ctx) => {
    const n = ctx.tokens?.cost.totalLinesAdded;
    if (n == null) return placeholderWithColor("m_linesAdded", params, ctx);
    return wrapPlainDefault("m_linesAdded", `+ ${n}`, params.color as string | undefined);
  },
  m_linesRemoved: (params, ctx) => {
    const n = ctx.tokens?.cost.totalLinesRemoved;
    if (n == null) return placeholderWithColor("m_linesRemoved", params, ctx);
    return wrapPlainDefault("m_linesRemoved", `- ${n}`, params.color as string | undefined);
  },
  m_tokenInTotal: (params, ctx) => {
    const t = ctx.tokens;
    if (!t || t.totals.tokenTotalIn == null) return placeholderWithColor("m_tokenInTotal", params, ctx);
    // v0.8.30+ — bare default tint (brightGreen) on positive
    // value; user `|color|<c>` override wins; 0 stays plain.
    // vX.X.X+ — |valueOnly|true drops the "in:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("in");
    return wrapValueDefault(
      "m_tokenInTotal",
      t.totals.tokenTotalIn,
      `${prefix}${formatCompactToken(t.totals.tokenTotalIn)}`,
      params.color as string | undefined,
    );
  },
  m_tokenTotalOut: (params, ctx) => {
    const t = ctx.tokens;
    if (!t || t.totals.tokenTotalOut == null) return placeholderWithColor("m_tokenTotalOut", params, ctx);
    // v0.8.30+ — bare default tint (red) on positive value; see
    // m_tokenInTotal inline for the wrap contract.
    // vX.X.X+ — |valueOnly|true drops the "out:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("out");
    return wrapValueDefault(
      "m_tokenTotalOut",
      t.totals.tokenTotalOut,
      `${prefix}${formatCompactToken(t.totals.tokenTotalOut)}`,
      params.color as string | undefined,
    );
  },
  // v0.8.0+ — total_input_tokens under the labelTotalIn label
  // family. Reads the same input as m_tokenInTotal; the two
  // modules differ in which labels.* axis labels them.
  //
  // v0.8.13+ — non-zero, non-null default tint: when
  // totals.tokenTotalIn is a positive number, wrap in
  // DEFAULT_COLORS.m_tokenTotalIn (blue). value=0 stays plain;
  // null → placeholderWithColor.
  m_tokenTotalIn: (params, ctx) => {
    const t = ctx.tokens;
    if (!t || t.totals.tokenTotalIn == null) return placeholderWithColor("m_tokenTotalIn", params, ctx);
    // vX.X.X+ — |valueOnly|true drops the "total:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("totalIn");
    return wrapValueDefault(
      "m_tokenTotalIn",
      t.totals.tokenTotalIn,
      `${prefix}${formatCompactToken(t.totals.tokenTotalIn)}`,
      params.color as string | undefined,
    );
  },
  // v0.4.x — project-wide count of valid API calls (sumApiCount
  // in tickStatus). Reads the same project-wide slot the
  // accumulator writes to. Renders "calls:N"; renders "calls:0"
  // (plain, or in the `|color|<c>` SGR) when the slot is
  // uninitialized. (`:nulldrop|` is a no-op here — the function
  // never returns null, same as m_tokenIn / m_tokenOut via
  // computeTickDelta.)
  //
  // v0.8.13+ — non-zero, non-null default tint wraps the chunk
  // cyan via DEFAULT_COLORS.m_apiCalls when the value is a
  // positive count. value=0 → plain "calls:0" (value-zero rule),
  // and any explicit user `:color|<c>` ALWAYS applies even on
  // the zero path (override wins over the natural plain emit).
  m_apiCalls: (params, ctx) => {
    const cwd = ctx.tokens?.cwd;
    // v0.8.13+ — prefix routes through labelFor(labels.labelApiCalls);
    // default "calls:" preserves the v0.8.x literal.
    // vX.X.X+ — |valueOnly|true drops the "calls:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("apiCalls");
    if (!cwd) return wrapPlainDefault("m_apiCalls", `${prefix}0`, params.color as string | undefined);
    const acc = statusStore.readAccumulator("project", { cwd });
    if (!acc) return wrapPlainDefault("m_apiCalls", `${prefix}0`, params.color as string | undefined);
    return wrapValueDefault("m_apiCalls", acc.accApiCalls, `${prefix}${acc.accApiCalls}`, params.color as string | undefined);
  },
  // v0.8.0+ — inline form of m_contextWindowsSize (capacity).
  // v0.8.23+ — context-window inline forms route through the
  // dedicated labelContext* axes (labels.labelContext*; defaults
  // "size:" / "size:" / "used:" / "remain:" preserve the v0.8.22
  // hardcoded literals).
  m_contextWindowsSize: (params, ctx) => {
    const sz = ctx.tokens?.contextWindow?.contextWindowSize;
    if (sz == null) return placeholderWithColor("m_contextWindowsSize", params, ctx);
    // vX.X.X+ — |valueOnly|true drops the "size:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("contextWindowsSize");
    return wrapPlainDefault("m_contextWindowsSize", `${prefix}${formatCompactToken(sz)}`, params.color as string | undefined);
  },
  // v0.8.0+ — inline form of m_contextUsedPercent.
  m_contextUsedPercent: (params, ctx) => {
    const pct = ctx.tokens?.contextWindow?.contextUsedPercent;
    if (pct == null) return placeholderWithColor("m_contextUsedPercent", params, ctx);
    // vX.X.X+ — |valueOnly|true drops the "used:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("contextUsedPercent");
    return wrapPlainDefault("m_contextUsedPercent", `${prefix}${pct}%`, params.color as string | undefined);
  },
  // v0.8.0+ — inline form of m_contextRemainingPercent.
  m_contextRemainingPercent: (params, ctx) => {
    const pct = ctx.tokens?.contextWindow?.contextRemainingPercent;
    if (pct == null) return placeholderWithColor("m_contextRemainingPercent", params, ctx);
    // vX.X.X+ — |valueOnly|true drops the "remain:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("contextRemainingPercent");
    return wrapPlainDefault("m_contextRemainingPercent", `${prefix}${pct}%`, params.color as string | undefined);
  },
  m_windowContext: (params, ctx) => {
    if (!ctx.contextWindow) return placeholderWithColor("m_windowContext", params, ctx);
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const color = params.color as string | undefined;
    if (color) return formatOneChunkColored(ctx.contextWindow, mode, color);
    // v0.6.0+: stale-aware — see m_window5h/7d path. :color| above
    // always wins, so explicit user color stays sticky even on stale.
    return formatOneChunk(ctx.contextWindow, mode, cfg().bar.width, ctx.stale);
  },
  // v0.8.16 — TTL gauge inline-args renderer. Mirror of the bare
  // MODULES entry but with the user's |color|<c> override applied
  // before the scale color (override always wins; matches the
  // wrapPlainDefault contract for every other module). v0.9.x —
  // also append the fixed-second TTL suffix via formatTtlSeconds
  // (see MODULES entry for the rationale), AND route through the
  // ACTIVE provider's cache row (see MODULES entry for the
  // per-provider rationale).
  m_cacheTtlStatus: (params, ctx) => {
    const key = ctx.currentProvider;
    if (key == null) return placeholderWithColor("m_cacheTtlStatus", params, ctx);
    const entry = cache.peekWithTtl(key);
    if (!entry || entry.ttlMs <= 0) return placeholderWithColor("m_cacheTtlStatus", params, ctx);
    const remaining = (entry.ttlMs - entry.ageMs) / entry.ttlMs;
    const userColor = params.color as string | undefined;
    const color = userColor ?? ttlStatusColor(remaining);
    const suffix = formatTtlSeconds(entry.ttlMs - entry.ageMs);
    return `${color}${ttlStatusChar(remaining)}${RESET} ${suffix}`;
  },
  m_statTtlStatus: (params, ctx) => {
    const entry = statusStore.peekFreshestStatAgeMs();
    if (!entry || entry.ttlMs <= 0) return placeholderWithColor("m_statTtlStatus", params, ctx);
    const remaining = (entry.ttlMs - entry.ageMs) / entry.ttlMs;
    const userColor = params.color as string | undefined;
    const color = userColor ?? ttlStatusColor(remaining);
    const suffix = formatTtlSeconds(entry.ttlMs - entry.ageMs);
    return `${color}${ttlStatusChar(remaining)}${RESET} ${suffix}`;
  },
  // v0.8.17+ — system RAM usage inline form. Mirror of the bare
  // MODULES entry but with the user's |color|<c> override applied
  // before the default tint (override always wins; matches the
  // wrapPlainDefault contract for every other module).
  m_memUsage: (params, ctx) => {
    const m = getMemUsage();
    if (!m) return placeholderWithColor("m_memUsage", params, ctx);
    // vX.X.X+ — |valueOnly|true drops the "Mem:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("memUsage");
    const body = `${prefix}${formatMemBytes(m.used)}/${formatMemBytes(m.total)}`;
    return wrapPlainDefault("m_memUsage", body, params.color as string | undefined);
  },
  // v0.8.36+ — inline form of m_windowMemUsage. Mirror of the
  // m_windowContext inline path: |color|<c> override → use the
  // fixed-color chunk; no |color| → use formatOneChunk so the
  // band color follows percentBands. |display| overrides the
  // mode (used/remaining) the same way m_windowContext does.
  m_windowMemUsage: (params, ctx) => {
    const m = getMemUsage();
    if (!m || m.total <= 0) return placeholderWithColor("m_windowMemUsage", params, ctx);
    const pct = (m.used / m.total) * 100;
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const color = params.color as string | undefined;
    const window: Window = { pct } as Window;
    if (color) return formatOneChunkColored(window, mode, color);
    return formatOneChunk(window, mode, cfg().bar.width, ctx.stale);
  },
  // v0.4.0+ — expand a registered lineTemplates fragment. The
  // loader strips any `m_template:` tokens from lineTemplates
  // arrays (config.ts applyOverrides), so the recursive call below
  // cannot itself reach an `m_template:` token. We `.slice()` the
  // inner array to defend against any future in-place mutation.
  // Missing key → warn + drop (renderer null path, same as bare
  // MODULES drop). Type mismatch → silent drop (no warn; the user
  // explicitly asked for a type filter).
  m_template: (params, ctx) => {
    const key = params.key as string;
    const inner = cfg().lineTemplates[key];
    if (!inner) {
      warn(
        `m_template: lineTemplates["${key}"] is undefined; dropping chunk`,
      );
      return null;
    }
    // v0.8.15+ — `type` is the only intrinsic name; matches
    // ctx.providerType values verbatim (`quota` / `balance`).
    // Explicit `|type:quota` / `|type:balance` is strict-match
    // against ctx.providerType — an unknown provider (matchProvider
    // returned null) does NOT match either, so an explicit-type
    // fragment is silently dropped when ANTHROPIC_BASE_URL doesn't
    // match a configured provider. That's intentional: a fragment
    // gated on `type:quota` is asking for quota-only data, which
    // doesn't exist on an unknown provider.
    //
    // v0.8.37 — when the user does NOT pass `type`, the
    // fragment is provider-agnostic and renders under "quota" /
    // "balance" providers (context-level templates like `context` /
    // `git_info` / `realtime` / `tokens_acc` / `tokens_stat`
    // typically fall in this bucket — they read from stdin +
    // per-project state, not from provider-specific fields, and the
    // user's intent is "show this on every tick regardless of
    // provider"). The previous "default = plan" silently dropped
    // these on the balance provider.
    //
    // v0.8.47+ — extend the agnostic guarantee to unknown providers.
    // The previous v0.8.37 contract said "provider-agnostic renders
    // on every tick regardless of provider", but the implementation
    // dropped the fragment on ctx.providerType === "unknown" (i.e.
    // when matchProvider returned null because ANTHROPIC_BASE_URL
    // didn't match any configured entry). That contradicted the
    // surrounding architecture: dispatch.ts already routes
    // provider-AGNOSTIC modules (m_token*, m_session, m_version,
    // m_branch, …) through renderProviderLine on the unknown path,
    // and m_windowMemUsage / m_memUsage / m_label render fine on
    // that path. Dropping only the m_template|<key> chunks broke
    // the "one statusline slot, agnostic modules still emit on
    // every provider" promise for users who organize their
    // template as a top-level statuslineTemplate composed of named
    // fragments. Now the agnostic gate has no provider-type filter
    // at all — only explicit `|type:…` does strict-match.
    const wantExplicit = params.type as "quota" | "balance" | undefined;
    if (wantExplicit != null && ctx.providerType !== wantExplicit) return null;
    // v0.9.0+ — `provider:<id>` strict-match gate against the
    // active provider instance id. Absent → no gate (renders on
    // every provider, same as `type`-less). Present → drop unless
    // `ctx.currentProvider` (the `provider` arg of
    // renderProviderLine) equals the configured id verbatim.
    // null ctx.currentProvider means ANTHROPIC_BASE_URL didn't
    // match any configured entry, so the gate returns false (drop).
    const wantProvider = params.provider as string | undefined;
    if (wantProvider != null && ctx.currentProvider !== wantProvider) {
      return null;
    }
    // v0.8.7+ — passthrough: build a passThrough view from every
    // param except the THREE intrinsics (`key` is the lookup target;
    // `type` / `provider` are m_template-local provider-gate
    // concerns — NOT values to push to inner modules). Nested
    // m_template is
    // impossible because config.ts strips them at load time, so we
    // don't need to merge with a pre-existing passThrough on the
    // outer context.
    const passThrough: Record<string, ResolvedValue> = {};
    for (const [k, v] of Object.entries(params)) {
      if (k === "key" || k === "type" || k === "provider") continue;
      passThrough[k] = v as ResolvedValue;
    }
    const innerCtx: RenderContext = { ...ctx, passThrough };
    const lines = renderTemplate(inner.slice(), innerCtx);
    return lines.join("\n");
  },
};

// v0.x.x+ — Two-class separator scheme for inline args.
// First-class separator is `|` (single-purpose: structural, splits
// the token into [moduleName, (implicitValue,), pair1, pair2, …]).
// Second-class separator is `:` or `=` (splits a pair into
// [name, value] at the FIRST occurrence; the remainder of the
// string is part of the value).
//
// Why two classes: the previous v0.7.1+ design used `|` for BOTH
// module-boundary and pair-boundary, with position (odd/even
// segment) deciding whether a segment was a name or a value.
// That made param values unable to contain `|` at all, and the
// grammar was unreadable (`m_tokenIn|color|red` reads as three
// opaque tokens). With the new scheme:
//   - `m_tokenIn|color:red` — natural: the `:` marks name/value
//     boundary.
//   - `m_label|GPU: A100|color:brightGreen` — implicit value
//     contains `:` because it sits BEFORE any pair-separator.
//   - `m_tokenIn|color:red:blue` — the FIRST `:` is the boundary,
//     the rest is the literal value passed to the resolver. Users
//     who need a `:` in a value should not write it; the parser
//     does not error on multi-`:` values (per spec 2026-07-09).
//
// Layout:
//   - If the schema has an `implicit` param, the FIRST segment is
//     its value (verbatim, may contain `:` / `=`).
//   - Otherwise the FIRST segment, if present, must be a pair
//     (i.e. start with `<name>[:=]<value>`).
//   - Each remaining segment is one pair.
//
// Returns null on:
//   - any resolver returning null (bad value)
//   - pair missing `:` / `=` separator
//   - pair with empty name (e.g. `:red` or `=red`)
//   - unknown param name in the named section
function parseInlineArgs(
  remainder: string,
  schema: InlineSchema,
): Record<string, ResolvedValue> | null {
  if (remainder === "") {
    // Empty remainder with an implicit param means "missing required
    // param" → null. Empty remainder without an implicit is fine.
    return schema.implicit ? null : {};
  }
  const parts = remainder.split("|");

  let out: Record<string, ResolvedValue> = {};
  let i = 0;

  if (schema.implicit) {
    const v = parts[0]!;
    const r = schema.implicit.resolver(v);
    if (r === null) return null;
    out[schema.implicit.name] = r;
    i = 1;
  }

  // Each remaining segment must be a `<name>[:=]<value>` pair.
  for (; i < parts.length; i++) {
    const pair = parts[i]!;
    const sepIdx = pair.search(/[:=]/);
    // sepIdx === -1 → no separator; sepIdx === 0 → empty name.
    if (sepIdx <= 0) return null;
    const name = pair.slice(0, sepIdx);
    const raw = pair.slice(sepIdx + 1);
    if (!(name in schema.named)) return null;
    const r = schema.named[name]!(raw);
    if (r === null) return null;
    out[name] = r;
  }
  return out;
}

// Try to expand an inline-args token. Returns one of:
//   - { kind: "ok",     value }    — chunk text (possibly empty)
//   - { kind: "badarg" }            — parse failed (warn + drop)
//   - undefined                     — no schema for this prefix (caller
//                                     falls through to the unknown-module
//                                     path; rare — only fires when a
//                                     typo slips past the dispatcher).
//
// `key` is the bare prefix (used as the schema/renderer lookup key —
// no trailing colon). `skipLen` is how many characters of the token
// to consume before the remainder starts.
//
// v0.3.4+ — distinguish parse failure from "renderer returned null
// for valid args but missing data". Previously the dispatcher warned
// on ANY null return, which made modules like m_tokenOut (returns
// null when stdin lacks total_output_tokens) wrongly warn on the
// "unknown lineTemplate module" path.
type InlineResult =
  | { kind: "ok"; value: string | null }
  | { kind: "badarg" };

function expandInlineToken(
  tok: string,
  key: string,
  skipLen: number,
  ctx: RenderContext,
): InlineResult | undefined {
  const schema = INLINE_SCHEMAS[key];
  if (schema === undefined) return undefined;
  const params = parseInlineArgs(tok.slice(skipLen), schema);
  if (params === null) return { kind: "badarg" };
  const rendered = INLINE_RENDERERS[key]!(params, ctx);
  if (rendered === INLINE_BADARG) return { kind: "badarg" };
  return { kind: "ok", value: rendered };
}

export function renderTemplate(template: readonly string[], ctx: RenderContext): string[] {
  // v0.9.4 — synthesize a guaranteed non-null `intervals` dict. The
  // type allows it to be absent (test helpers + legacy call sites
  // supply the flat `shortInterval` / `midInterval` /
  // `longInterval` fields instead); module code can then rely on
  // `ctx.intervals[term]` without a nullable guard.
  if (
    !ctx.intervals &&
    (ctx.shortInterval != null || ctx.midInterval != null || ctx.longInterval != null)
  ) {
    ctx = {
      ...ctx,
      intervals: {
        short: ctx.shortInterval ?? null,
        mid: ctx.midInterval ?? null,
        long: ctx.longInterval ?? null,
      },
      shortInterval: undefined,
      midInterval: undefined,
      longInterval: undefined,
    };
  }
  // Even when neither is supplied, ensure `ctx.intervals` is a
  // non-null dict so per-module placeholders fire uniformly.
  if (!ctx.intervals) ctx = { ...ctx, intervals: {} };
  // v1.0 — _renderDepth tracking and the deferred setPrevTick
  // commit are GONE. The -processor (processTick Stage 3)
  // sets PREV_TICK_KEY once per tick BEFORE render begins, so
  // every render context (outer, m_template inner) sees the same
  // baseline via peekPrevTick. No depth counter needed.
  const lines: string[] = [];
  let current = "";
  // v0.9.0+ — column cursor for `s_move|pos:<n>`. Tracked
  // in-statement (closure) instead of mutating ctx so a render
  // mid-flight (e.g. nested m_template) can't see a half-baked
  // cursor value. Mutated on every chunk; reset to 0 on `\n`.
  let lineCursor = 0;
  for (let i = 0; i < template.length; i++) {
    const tok = template[i];
    if (tok == null) continue;
    // v0.9.0+ — sync the closure cursor into ctx so inline-args
    // renderers (s_move) can read it. The renderer returns the
    // padding chunk; the dispatcher's normal chunk-accumulate
    // step bumps the closure cursor by that chunk's width, which
    // for a correctly-aligned s_move is exactly `pos - old cursor`,
    // landing the cursor on `pos` for the next chunk to consume.
    ctx.lineCursor = lineCursor;
    let piece: string | null = null;
    // v0.3.3+ — inline-args tokens (s_<n>|…, m_label|…, m_modeLabel|…,
    // and every other m_<name>|…). Only fire when the token contains
    // "|" so the bare forms (s_0, m_modeLabel, m_window5h, …) keep
    // routing through MODULES as before.
    if (tok.includes("|")) {
      // v0.4.x — provider-type filter for inline-args tokens. We
      // extract the prefix (everything before the first "|") and
      // consult INLINE_TYPE_FILTERS. When the prefix carries a tag
      // and it doesn't match ctx.providerType, we silently drop
      // the whole token WITHOUT entering the long prefix chain
      // below. This keeps the per-prefix `type` tag symmetrical
      // with MODULES' `type` field so a `m_window5h|color:red` in a
      // balance provider's template drops identically to its bare
      // form.
      //
      // Special case: s_<n>|… is a separator, not a module, so we
      // skip the type check (separators are provider-agnostic).
      // m_label|… and m_template|… are also provider-agnostic by
      // design; their prefix is absent from INLINE_TYPE_FILTERS so
      // the lookup is a no-op. Missing-key (unknown prefix) is also
      // a no-op — the long chain below will produce inline=undefined
      // and the unknown-module warn path will fire there.
      //
      // Renamed from the v0.4.x-beta `INLINE_MODE_FILTERS` /
      // `ctx.providerModeKey` to avoid collision with the
      // display-mode field on RenderContext.
      //
      // v0.7.1+ — inline-args separator is `|`, not `:`. See
      // parseInlineArgs for the rationale.
      const pipeAt = tok.indexOf("|");
      const inlinePrefix = pipeAt > 0 && tok.startsWith("m_")
        ? tok.slice(0, pipeAt)
        : "";
      if (inlinePrefix) {
        const need = INLINE_TYPE_FILTERS[inlinePrefix];
        if (need && need !== ctx.providerType) {
          continue;
        }
      }
      // The prefix → key/skipLen table. Keep them in sync with the
      // INLINE_SCHEMAS / INLINE_RENDERERS entries above. A typo here
      // means the token silently routes through MODULES (which won't
      // match the literal pipe-bearing string) and falls through
      // to the unknown-module warn.
      let inline: InlineResult | undefined;
      let sLiteralPiece: string | null = null;
      if (tok.startsWith("s_")) {
        // s_<name>|… → skip "s_" (length 2), remainder starts at
        // the alias name. vX.X.X+: unknown aliases (numeric
        // `s_0|color:red`, or unknown `s_xyz|repeat:3`) emit the
        // WHOLE token as a literal, no parsing, no warning. KNOWN
        // aliases with bad args (e.g. `s_dot|repeat:9`) still fall
        // through to the badarg warn-and-drop path below.
        //
        // v0.9.0+ — s_move gets its own route: it isn't a NAMED
        // separator (it has params, not a literal body), so it
        // doesn't sit in NAMED_SEPARATORS, but it still wants the
        // inline-args parse path. Detect "s_move|" specifically and
        // dispatch through expandInlineToken with skipLen=7. Bare
        // `s_move` (no `|`) hits the unknown-alias literal path
        // below (which matches the user's "没带参数相当于无效"
        // contract — without params there's nothing to dispatch,
        // and emitting the bare token verbatim is the consistent
        // "unknown s_* alias" behavior).
        const aliasPart = tok.slice(2, tok.indexOf("|"));
        if (aliasPart === "move") {
          inline = expandInlineToken(tok, "s_move", 7, ctx);
        } else if (NAMED_SEPARATORS.has(aliasPart)) {
          inline = expandInlineToken(tok, "s_", 2, ctx);
        } else {
          sLiteralPiece = tok;
          inline = undefined;
        }
      } else if (tok.startsWith("m_label|")) {
        // m_label|<args> → skip "m_|" (length 8), remainder starts
        // at the string value.
        inline = expandInlineToken(tok, "m_label", 8, ctx);
      } else if (tok.startsWith("m_modeLabel|")) {
        // m_modeLabel|<args> → skip "m_|" (length 12).
        inline = expandInlineToken(tok, "m_modeLabel", 12, ctx);
      } else if (tok.startsWith("m_windowQuota|")) {
        // v0.9.0+ — unified window module. `m_windowQuota|term|short`
        // (default) → shortInterval; `|term|mid` → midInterval;
        // `|term|long` → longInterval. Inline args: color, display,
        // term, nulldrop. Skip "m_windowQuota|" (length 14).
        inline = expandInlineToken(tok, "m_windowQuota", 14, ctx);
      } else if (tok.startsWith("m_countdown|")) {
        // v0.9.0+ — unified countdown module. Same `term` arg as
        // m_windowQuota. Skip "m_countdown|" (length 12).
        inline = expandInlineToken(tok, "m_countdown", 12, ctx);
      } else if (tok.startsWith("m_quota|")) {
        // v0.9.0+ — new quota module. Renders the quota group as
        // `${labelQuota}(<interval.label>):used/limit`. Same `term`
        // arg as m_windowQuota / m_countdown. Skip "m_quota|" (length 8).
        inline = expandInlineToken(tok, "m_quota", 8, ctx);
      } else if (tok.startsWith("m_balance|")) {
        inline = expandInlineToken(tok, "m_balance", 10, ctx);
      } else if (tok.startsWith("m_age|")) {
        inline = expandInlineToken(tok, "m_age", 6, ctx);
      } else if (tok.startsWith("m_version|")) {
        inline = expandInlineToken(tok, "m_version", 10, ctx);
      } else if (tok.startsWith("m_tokenIn|")) {
        inline = expandInlineToken(tok, "m_tokenIn", 10, ctx);
      } else if (tok.startsWith("m_tokenOut|")) {
        inline = expandInlineToken(tok, "m_tokenOut", 11, ctx);
      } else if (tok.startsWith("m_tokenInTotal|")) {
        // Longer prefix must come BEFORE m_tokenIn: would match first;
        // m_tokenIn: would shadow m_tokenInTotal|color|… if ordered
        // the other way.
        inline = expandInlineToken(tok, "m_tokenInTotal", 15, ctx);
      } else if (tok.startsWith("m_tokenTotalOut|")) {
        // m_tokenTotalOut: (16 chars) must come BEFORE m_tokenOut:
        // (12 chars) so the longer literal wins — otherwise
        // `m_tokenTotalOut|color|red` would match the m_tokenOut:
        // branch with remainder "TotalOut|color|red" and parse-fail.
        inline = expandInlineToken(tok, "m_tokenTotalOut", 16, ctx);
      } else if (tok.startsWith("m_apiCalls|")) {
        // m_apiCalls|color|<c> / |nulldrop|… → skip "m_apiCalls|"
        // (length 11).
        inline = expandInlineToken(tok, "m_apiCalls", 11, ctx);
      } else if (tok.startsWith("m_tokenTotalIn|")) {
        inline = expandInlineToken(tok, "m_tokenTotalIn", 15, ctx);
      } else if (tok.startsWith("m_contextSize|")) {
        inline = expandInlineToken(tok, "m_contextSize", 14, ctx);
      } else if (tok.startsWith("m_tokenHitRate|")) {
        // m_tokenHitRate → skip prefix+pipe (15 chars).
        inline = expandInlineToken(tok, "m_tokenHitRate", 15, ctx);
      } else if (tok.startsWith("m_tokenCachedIn|")) {
        inline = expandInlineToken(tok, "m_tokenCachedIn", 16, ctx);
      } else if (tok.startsWith("m_tokenCost|")) {
        inline = expandInlineToken(tok, "m_tokenCost", 12, ctx);
      } else if (tok.startsWith("m_tokenInSpeed|")) {
        inline = expandInlineToken(tok, "m_tokenInSpeed", 15, ctx);
      } else if (tok.startsWith("m_tokenOutSpeed|")) {
        inline = expandInlineToken(tok, "m_tokenOutSpeed", 16, ctx);
      } else if (tok.startsWith("m_accTokenCachedIn|")) {
        // Longer prefix listed first defensively (18 chars) — siblings
        // m_accTokenIn (12), m_accTokenOut (13), m_accTokenTotalIn
        // (16) share the "m_accToken" stem but differ at index 13/14/15.
        inline = expandInlineToken(tok, "m_accTokenCachedIn", 19, ctx);
      } else if (tok.startsWith("m_accTokenTotalIn|")) {
        // m_accTokenTotalIn → skip prefix+pipe (18 chars). Listed
        // before m_accTokenIn / m_accTokenOut to avoid prefix-shadow.
        inline = expandInlineToken(tok, "m_accTokenTotalIn", 18, ctx);
      } else if (tok.startsWith("m_accTokenInSpeed|")) {
        // v0.8.13+ — m_accTokenInSpeed → skip prefix+pipe (18).
        // MUST be listed BEFORE m_accTokenIn (13) so the longer
        // literal wins — otherwise `m_accTokenInSpeed|color|red`
        // would match the m_accTokenIn branch and parse-fail.
        inline = expandInlineToken(tok, "m_accTokenInSpeed", 18, ctx);
      } else if (tok.startsWith("m_accTokenOutSpeed|")) {
        // v0.8.13+ — m_accTokenOutSpeed → skip prefix+pipe (19).
        // MUST be listed BEFORE m_accTokenOut (14) so the longer
        // literal wins — `m_accTokenOutSpeed|...|xxx` would
        // otherwise match the m_accTokenOut branch and parse-fail.
        inline = expandInlineToken(tok, "m_accTokenOutSpeed", 19, ctx);
      } else if (tok.startsWith("m_accTokenCost|")) {
        // vX.X.X+ — m_accTokenCost → skip prefix+pipe (15 chars).
        // Listed before m_accTokenOut (14) so the longer literal wins.
        inline = expandInlineToken(tok, "m_accTokenCost", 15, ctx);
      } else if (tok.startsWith("m_accTokenOut|")) {
        // m_accTokenOut → skip prefix+pipe (14 chars).
        inline = expandInlineToken(tok, "m_accTokenOut", 14, ctx);
      } else if (tok.startsWith("m_accTokenIn|")) {
        // m_accTokenIn → skip prefix+pipe (13 chars).
        inline = expandInlineToken(tok, "m_accTokenIn", 13, ctx);
      } else if (tok.startsWith("m_accApiMs|")) {
        // m_accApiMs → skip prefix+pipe (11 chars).
        inline = expandInlineToken(tok, "m_accApiMs", 11, ctx);
      } else if (tok.startsWith("m_accApiCalls|")) {
        // m_accApiCalls → skip prefix+pipe (14 chars). Listed
        // before m_accTokenHitRate (19) and the m_sum* family to
        // keep the m_acc* cluster contiguous; shares length with
        // m_sumApiCalls (14) but diverges at index 5 ('c' vs 's').
        inline = expandInlineToken(tok, "m_accApiCalls", 14, ctx);
      } else if (tok.startsWith("m_accTokenHitRate|")) {
        // m_accTokenHitRate → skip prefix+pipe (18 chars). Renamed
        // from m_accCacheHitRate to align the namespace with
        // m_tokenHitRate (per-turn) / m_sumTokenHitRate
        // (cross-project). 18 chars shares length with
        // m_accTokenTotalIn (18) and m_sumTokenTotalIn (18) but
        // diverges at position 14 ('H' vs 'T' / 'T'), so no shadow.
        inline = expandInlineToken(tok, "m_accTokenHitRate", 18, ctx);
      } else if (tok.startsWith("m_accStartTime|")) {
        // v0.8.24+ — m_accStartTime → skip prefix+pipe (15 chars).
        // Diverges from m_accTokenHitRate (18) at position 14
        // ('S' vs 'H') so no shadow despite being in the m_acc*
        // cluster.
        inline = expandInlineToken(tok, "m_accStartTime", 15, ctx);
      } else if (tok.startsWith("m_sumTokenOutSpeed|")) {
        // v0.8.x — m_avgTokenOutSpeed renamed to m_sumTokenOutSpeed.
        // "m_sumTokenOutSpeed" is 18 chars + "|" = 19 chars of
        // prefix. Shares length with m_sumTokenCachedIn (19)
        // but diverges at position 14 ('O' vs 'C'). MUST be
        // listed before m_sumTokenOut (14) to avoid the
        // m_sumTokenOutSpeed|...|xxx token being matched by
        // startsWith("m_sumTokenOut|").
        // v0.8.13+ — fixed skipLen from buggy 20 to 19 (off-by-one).
        inline = expandInlineToken(tok, "m_sumTokenOutSpeed", 19, ctx);
      } else if (tok.startsWith("m_sumTokenCost|")) {
        // vX.X.X+ — m_sumTokenCost → skip prefix+pipe (15 chars).
        // Listed before m_sumTokenCachedIn (19) / m_sumTokenIn (13) /
        // m_sumTokenOut (14) — diverges at position 11 ('C' vs 'I'/'O'),
        // but convention is longer-first within the m_sum* cluster.
        // Length 15: "m_sumTokenCost" = 14 chars + "|" = 15.
        inline = expandInlineToken(tok, "m_sumTokenCost", 15, ctx);
      } else if (tok.startsWith("m_sumTokenCachedIn|")) {
        // 19 chars; siblings m_sumTokenIn (12) / m_sumTokenOut (13) /
        // m_sumTokenTotalIn (17) / m_sumApiMs (10) /
        // m_sumTokenInSpeed (18) / m_sumTokenHitRate (18) differ at
        // later positions.
        inline = expandInlineToken(tok, "m_sumTokenCachedIn", 19, ctx);
      } else if (tok.startsWith("m_sumTokenInSpeed|")) {
        // v0.8.x — m_avgTokenInSpeed renamed to m_sumTokenInSpeed.
        // "m_sumTokenInSpeed" is 17 chars + "|" = 18 chars of prefix.
        // Shares length with m_sumTokenTotalIn (18) and
        // m_sumTokenHitRate (18) but diverges at position 14 ('I' vs
        // 'T' / 'H'). MUST be listed before m_sumTokenIn (13) to
        // avoid the m_sumTokenInSpeed|...|xxx token being matched
        // by startsWith("m_sumTokenIn|").
        // v0.8.13+ — fixed skipLen from buggy 19 to 18 (the prior
        // off-by-one caused parseInlineArgs to slice the leading
        // 'n' off 'nulldrop|false' and return params=null).
        inline = expandInlineToken(tok, "m_sumTokenInSpeed", 18, ctx);
      } else if (tok.startsWith("m_sumTokenTotalIn|")) {
        inline = expandInlineToken(tok, "m_sumTokenTotalIn", 18, ctx);
      } else if (tok.startsWith("m_sumTokenHitRate|")) {
        // v0.8.x — m_avgCacheHitRate renamed to m_sumTokenHitRate.
        // 18 chars; shares length with m_sumTokenTotalIn (18) and
        // m_sumTokenInSpeed (18) but diverges at position 14 ('H'
        // vs 'T' / 'I'). The user-facing hit-rate prefix ("hit:N%")
        // is unchanged; the rename aligns the namespace with the
        // cross-project JSONL scan family (sits next to
        // m_sumTokenIn/Out/etc.).
        inline = expandInlineToken(tok, "m_sumTokenHitRate", 18, ctx);
      } else if (tok.startsWith("m_sumTokenOut|")) {
        inline = expandInlineToken(tok, "m_sumTokenOut", 14, ctx);
      } else if (tok.startsWith("m_sumApiCalls|")) {
        inline = expandInlineToken(tok, "m_sumApiCalls", 14, ctx);
      } else if (tok.startsWith("m_sumStartTime|")) {
        // v0.8.24+ — m_sumStartTime → skip prefix+pipe (15 chars).
        // Listed before the 14-char m_sum* siblings to keep the
        // "longer literal first" defensive ordering convention.
        // Diverges from m_sumTokenOut / m_sumApiCalls (14) at
        // position 6 ('S' vs 'T' / 'A') so no shadow.
        inline = expandInlineToken(tok, "m_sumStartTime", 15, ctx);
      } else if (tok.startsWith("m_sumEndTime|")) {
        // v0.8.24+ — m_sumEndTime → skip prefix+pipe (13 chars).
        // Shares length with m_sumTokenIn (13) but diverges at
        // position 6 ('E' vs 'T'), so no shadow.
        inline = expandInlineToken(tok, "m_sumEndTime", 13, ctx);
      } else if (tok.startsWith("m_sumTokenIn|")) {
        inline = expandInlineToken(tok, "m_sumTokenIn", 13, ctx);
      } else if (tok.startsWith("m_sumApiMs|")) {
        inline = expandInlineToken(tok, "m_sumApiMs", 11, ctx);
      } else if (tok.startsWith("m_quote|")) {
        // m_quote|freq|<…>|color|<…> → skip "m_quote|" (length 8).
        inline = expandInlineToken(tok, "m_quote", 8, ctx);
      } else if (tok.startsWith("m_session|")) {
        inline = expandInlineToken(tok, "m_session", 10, ctx);
      } else if (tok.startsWith("m_model|")) {
        inline = expandInlineToken(tok, "m_model", 8, ctx);
      } else if (tok.startsWith("m_effort|")) {
        inline = expandInlineToken(tok, "m_effort", 9, ctx);
      } else if (tok.startsWith("m_repo|")) {
        inline = expandInlineToken(tok, "m_repo", 7, ctx);
      } else if (tok.startsWith("m_branch|")) {
        // m_branch|color|<c> → skip "m_|" (length 9).
        inline = expandInlineToken(tok, "m_branch", 9, ctx);
      } else if (tok.startsWith("m_gitStatus|")) {
        // m_gitStatus|color|<c> → skip "m_|" (length 12).
        inline = expandInlineToken(tok, "m_gitStatus", 12, ctx);
      } else if (tok.startsWith("m_ccVersion|")) {
        // m_ccVersion|color|<c> → skip "m_|" (length 12).
        inline = expandInlineToken(tok, "m_ccVersion", 12, ctx);
      } else if (tok.startsWith("m_ccversion|")) {
        // Deprecated alias — same dispatch as m_ccVersion: above.
        // Pre-rename configs may still use the lowercase form.
        inline = expandInlineToken(tok, "m_ccversion", 12, ctx);
      } else if (tok.startsWith("m_sessionApiDuration|")) {
        // Longer prefix must come BEFORE m_sessionDuration: for the
        // same prefix-shadowing reason as the m_tokenIn family.
        inline = expandInlineToken(tok, "m_sessionApiDuration", 21, ctx);
      } else if (tok.startsWith("m_sessionDuration|")) {
        inline = expandInlineToken(tok, "m_sessionDuration", 18, ctx);
      } else if (tok.startsWith("m_apiMs|")) {
        // v0.8.0+ — per-turn API-ms delta. No prefix-shadowing
        // concern: m_apiMs (8) and m_accApiMs (11) share the
        // "m_a" prefix but diverge at position 3 ("piMs" vs
        // "ccApiMs"), so the literal startsWith check is exact.
        // Placed adjacent to m_sessionDuration for cohesion
        // (both are dhms time-format modules).
        inline = expandInlineToken(tok, "m_apiMs", 8, ctx);
      } else if (tok.startsWith("m_linesAdded|")) {
        inline = expandInlineToken(tok, "m_linesAdded", 13, ctx);
      } else if (tok.startsWith("m_linesRemoved|")) {
        // m_linesRemoved|color|<c> → skip "m_|" (length 15).
        inline = expandInlineToken(tok, "m_linesRemoved", 15, ctx);
      } else if (tok.startsWith("m_contextWindowsSize|")) {
        // m_contextWindowsSize → skip prefix+colon (21 chars).
        inline = expandInlineToken(tok, "m_contextWindowsSize", 21, ctx);
      } else if (tok.startsWith("m_contextUsedPercent|")) {
        inline = expandInlineToken(tok, "m_contextUsedPercent", 21, ctx);
      } else if (tok.startsWith("m_contextRemainingPercent|")) {
        inline = expandInlineToken(tok, "m_contextRemainingPercent", 25, ctx);
      } else if (tok.startsWith("m_windowContext|")) {
        inline = expandInlineToken(tok, "m_windowContext", 16, ctx);
      } else if (tok.startsWith("m_template|")) {
        // m_template|<key>[|type|<plan|balance>][|nulldrop|<bool>]
        // → skip "m_template|" (length 11). v0.8.15+ — `type` is
        // the recommended intrinsic name; legacy `mode` arg is
        // still accepted (parseInlineArgs goes through both
        // resolvers; the renderer-side check prefers `type` when
        // both are present).
        inline = expandInlineToken(tok, "m_template", 11, ctx);
      } else if (tok.startsWith("m_cacheTtlStatus|")) {
        // m_cacheTtlStatus → 16 chars + "|" = 17 skipLen.
        inline = expandInlineToken(tok, "m_cacheTtlStatus", 17, ctx);
      } else if (tok.startsWith("m_statTtlStatus|")) {
        // m_statTtlStatus → 15 chars + "|" = 16 skipLen.
        inline = expandInlineToken(tok, "m_statTtlStatus", 16, ctx);
      } else if (tok.startsWith("m_memUsage|")) {
        // m_memUsage → 10 chars + "|" = 11 skipLen.
        inline = expandInlineToken(tok, "m_memUsage", 11, ctx);
      } else if (tok.startsWith("m_windowMemUsage|")) {
        // m_windowMemUsage → 16 chars + "|" = 17 skipLen.
        inline = expandInlineToken(tok, "m_windowMemUsage", 17, ctx);
      }
      // Parse failure (bad |color|, unknown param, odd segment count)
// → warn + drop. Renderer returning null for valid args (e.g.
// m_tokenOut when stdin lacks total_output_tokens) is NOT a
// parse failure — silently skip the chunk, same as the bare
// MODULES path. (v0.3.4+: previously we conflated the two
// and wrongly warned "unknown module" on missing data.)
//
// vX.X.X+ — `s_*|…` tokens with an unknown alias fall through
// here too, but instead of warn + drop they emit the WHOLE token
// as a literal (set by `sLiteralPiece` above). This preserves the
// new "unrecognized token → verbatim" contract for inline-args
// forms too.
      if (inline?.kind === "badarg") {
        if (sLiteralPiece !== null) {
          piece = sLiteralPiece;
        } else {
          warnUnknownModuleOnce(tok);
          continue;
        }
      } else {
        piece = inline?.kind === "ok" ? inline.value : tok;
      }
    } else if (tok.startsWith("s_")) {
      // Bare s_<…> fast path. Only named aliases (s_space, s_dot,
      // s_newline, s_tab, s_colon, s_pipe) resolve to a literal —
      // any other s_* suffix is unrecognized and the WHOLE token is
      // emitted as a literal string. Inline-args (with optional
      // color|) handles the `s_<…>|color|<c>` form via the new path
      // above; this branch only fires for the no-pipe shorthand.
      const suffix = tok.slice(2);
      const alias = NAMED_SEPARATORS.get(suffix);
      if (alias !== undefined) {
        piece = alias;
      } else {
        // Unknown s_* suffix → emit the original token verbatim,
        // no parsing, no warning. (No compat fallback; the user
        // gets exactly what they wrote.)
        piece = tok;
      }
    } else if (tok.startsWith("m_")) {
      const mod = MODULES[tok];
      if (!mod) {
        // Unknown m_* module → emit the original token verbatim,
        // no parsing, no warning.
        piece = tok;
      } else {
        // v0.4.x — provider-type filter. Modules tagged with a type
        // (`m_windowQuota: "quota"`, `m_balance: "balance"`, …) silently
        // drop on a non-matching provider type. Untagged modules
        // (m_token*, m_age, m_version, …) skip the check and emit
        // on every ctx — those are provider-agnostic by design.
        //
        // The drop is a no-op — the chunk is skipped AND adjacent
        // s_<name> separators are skipped too via the same null-
        // fall-through the MODULES renderer already implements.
        if (mod.type != null && mod.type !== ctx.providerType) {
          continue;
        }
        piece = mod(ctx);
      }
    } else {
      // Anything that didn't start with `m_` or `s_` (or didn't
      // match an inline prefix in the long chain above) is treated
      // as a free-form literal token. vX.X.X+: unrecognized tokens
      // are emitted verbatim — no parsing, no warning. Useful for
      // dropping a free-text label like `prompt: ` or `STATUS` into
      // the template without escaping.
      piece = tok;
    }
    if (piece == null || piece === "") continue;
    // Split the piece on '\n' so a "\n" separator or a future module
    // that embeds newlines naturally produces multi-line output. The
    // first segment is appended to the in-progress current line; any
    // further segments start a new line (and the trailing one keeps
    // the new "current" line for the next piece to append to).
    const segments = piece.split("\n");
    for (let j = 0; j < segments.length; j++) {
      const seg = segments[j]!;
      if (j === 0) {
        current += seg;
      } else {
        // Push the completed line and start a new one. Skip empty
        // lines that arise from consecutive "\n\n" splits.
        if (current.length > 0) lines.push(current);
        current = seg;
      }
      // v0.9.0+ — update the visible-cell cursor on every segment.
      // The cursor is what `s_move|pos:<n>` reads via
      // ctx.lineCursor (which is initialized from the closure at
      // the top of renderTemplate). ANSI SGR bytes are stripped
      // before counting so color/style output doesn't inflate the
      // column count. Each `\n` resets the cursor to 0 because
      // the new line starts at column 0.
      if (j < segments.length - 1) {
        lineCursor = visibleCellLength(seg);
      } else {
        lineCursor += visibleCellLength(seg);
      }
    }
  }
  // Flush whatever's left in the in-progress line.
  if (current.length > 0) lines.push(current);
  // v1.0 — _renderDepth tracking removed. setPrevTick fires
  // from the -processor BEFORE render begins, so no deferred
  // commit / depth counter is needed here.
  return lines;
}

// Top-level renderer used by dispatch.ts. Selects the right template
// for the provider, builds the context, and — critically — force-
// appends the m_age stale suffix when the result is `stale` AND the
// template didn't already emit it. This preserves the v0.2.16
// invariant that a stale-on-error tick always carries a visible
// broken-chain indicator, regardless of what the user put in their
// lineTemplate.
export function renderProviderLine(
  provider: import("./types.ts").Provider,
  ctx: Omit<RenderContext, "intervals" | "balance" | "tokens" | "contextWindow" | "providerType"> & {
    // v0.9.4 — open-ended `intervals` dict replaces the v0.9.0 trio
    // of fixed slots (`shortInterval` / `midInterval` /
    // `longInterval`). Caller (dispatch.ts) passes the parsed
    // Quota's intervals dict directly. Missing → empty dict,
    // which the renderer treats as "all slots null" and the
    // per-module placeholder fires.
    intervals?: Record<string, Interval | null>;
    // v0.9.4 — back-compat: legacy callers (and existing tests) still
    // pass `shortInterval` / `midInterval` / `longInterval` as flat
    // fields. When present and `intervals` is absent, we fold them
    // into the reserved dict keys (`short` / `mid` / `long`).
    shortInterval?: Interval | null;
    midInterval?: Interval | null;
    longInterval?: Interval | null;
    balance?: BalanceLike | null;
    // v0.4.0+ — optional for back-compat with tests/callers that
    // don't thread a TokenSnapshot. Defaults to null, which causes
    // all m_token* modules to skip rendering.
    tokens?: TokenSnapshot | null;
    // v0.4.0+ — optional. Synthesized from tokens.contextWindow.contextUsedPercent
    // when omitted. Only read by m_windowContext.
    contextWindow?: Window | null;
    // v0.8.21+ — optional. Pre-fetched quote bodies from
    // `preFetchQuotes` (see `src/api.quote.ts`). The m_quote
    // address-mode renderer reads this map; absent means "no
    // pre-fetched bodies for this tick" and the renderer falls
    // back to local QUOTES.
    quoteBodies?: Map<string, string>;
    // v0.9.0+ — optional. Which side of the user-vs-builtin fence
    // the active provider's plugin was loaded from, or `"missing"`
    // when the matched provider id has no plugin (neither user
    // override nor built-in). Populated by
    // `dispatch.ts:buildProviderLine` from the per-provider cache
    // row. Absent → null → m_pluginSource drops to no-op (per the
    // "Drop 整个 module" decision 2026-07-11 — we don't surface
    // "source:n/a" for unconfigured users). The `"missing"`
    // value previously collapsed to null here too; it now
    // surfaces as ❗ so a misconfigured provider id (e.g. user
    // set providers.copilot but never installed the plugin)
    // is loud instead of silent.
    pluginSource?: "user" | "builtin" | "missing" | null;
  },
): string {
  // v0.4.0+ — synthesize the contextWindow Window from
  // tokens.contextWindow.contextUsedPercent when not supplied. formatOneChunk
  // only reads `pct`, so this minimal shape is enough.
  const usedPct = ctx.tokens?.contextWindow?.contextUsedPercent;
  const contextWindow =
    ctx.contextWindow !== undefined
      ? ctx.contextWindow
      : usedPct != null
        ? { pct: usedPct }
        : null;
  // v0.2.21: template picked by provider TYPE via providers.ts, not
  // by provider-name literal. Same outward behavior — defaults put
  // Quota at "quota" and BALANCE at "balance" — but the
  // indirection lets a third provider slot in without code changes.
  //
  // v0.8.14+ — `statuslineTemplate` is always `string[]`. The legacy
  // preset-name lookup against PLAN_PRESETS / BALANCE_PRESETS (v0.4.0
  // –v0.8.13) is gone — the seven plan + two balance presets are now
  // first-class entries in `cfg().lineTemplates` with `_`-prefixed
  // keys, and the user references them via `m_template|_X` (with
  // optional `|mode|plan|balance` to constrain dispatch to one
  // provider type — `m_template` defaults to `mode:plan`).
  //
  // The provider type is still threaded through to the full ctx so
  // per-module `type` filters can compare against it.
  // providerTypeFor returns "quota" / "balance" / "unknown"
  // (replaces the older templateKeyForProvider name).
  const providerType = providerTypeFor(provider);
  const cfgSnap = cfg();
  const fullCtx: RenderContext = {
    mode: ctx.mode,
    nowMs: ctx.nowMs,
    // v0.9.4 — prefer explicit `intervals` dict (new dispatch path);
    // fall back to folding flat `shortInterval` / `midInterval` /
    // `longInterval` (legacy callers + existing tests). When neither
    // is provided, treat as "all slots null" so per-module
    // placeholders fire.
    intervals:
      ctx.intervals ??
      (ctx.shortInterval != null || ctx.midInterval != null || ctx.longInterval != null
        ? {
            short: ctx.shortInterval ?? null,
            mid: ctx.midInterval ?? null,
            long: ctx.longInterval ?? null,
          }
        : {}),
    balance: ctx.balance ?? null,
    ageMs: ctx.ageMs,
    stale: ctx.stale,
    version: ctx.version,
    tokens: ctx.tokens ?? null,
    contextWindow,
    providerType,
    // v0.9.0+ — active provider instance id (e.g. `"minimax"`).
    // Drives `m_template|<key>|provider:<id>` strict-match gates;
    // null when ANTHROPIC_BASE_URL didn't match a configured entry
    // so a `|provider:<id>` gate returns false and the fragment drops.
    currentProvider: provider,
    // v0.6.0+ — single-owner dedup ref. Propagated by reference
    // through any nested m_template: expansions; each m_age instance
    // (bare + inline-args) checks + sets this slot so the WHOLE render
    // emits ⛓️‍💥/🔗 at most once even when the user's template contains
    // m_age in multiple places.
    ageEmittedRef: { value: false },
    // v0.8.21+ — per-tick quote body map from preFetchQuotes.
    // Undefined when no address-mode m_quote token is active.
    quoteBodies: ctx.quoteBodies,
    // v0.9.0+ — default to null so older callers (tests that
    // construct ctx inline) don't have to thread the field.
    // m_pluginSource drops to no-op in that case.
    pluginSource: ctx.pluginSource ?? null,
  };
  // v0.8.14+ — `statuslineTemplate` is always a `string[]` after
  // loader-side auto-migration. `.slice()` keeps the snapshot-
  // defensive pattern (we don't want subsequent external mutations
  // to leak into the render).
  const template = cfgSnap.statuslineTemplate.slice();
  const lines = renderTemplate(template, fullCtx);
  // Forced visibility for the age annotation (stale-only fallback):
  // when the user did NOT put m_age in their lineTemplate AND the
  // fetch was stale, append the broken-chain suffix to the rendered
  // line. This preserves the v0.2.16 invariant that a network
  // failure is always visible, no matter what the user put in their
  // template.
  //
  // Dedup v0.6.0+ — moved from a top-level string scan
  // (`templateHasAgeModule`, which only saw the outermost tokens and
  // missed m_age nested inside lineTemplates.* fragments) to a
  // render-recursion-aware check: `fullCtx.ageEmittedRef.value`
  // flips to true the moment ANY m_age instance (bare or inline,
  // top-level or nested via m_template:) fires. The first m_age
  // emits; this fallback sees the ref and skips, eliminating the
  // "⛓️‍💥 ⛓️‍💥" double-append the old logic produced.
  if (
    ctx.ageMs != null &&
    ctx.stale &&
    fullCtx.ageEmittedRef !== undefined &&
    !fullCtx.ageEmittedRef.value
  ) {
    fullCtx.ageEmittedRef.value = true;
    const suffix = formatStaleSuffix(ctx.ageMs, false);
    // The suffix carries its own SGR close, so it slots onto the
    // last line regardless of how many lines the template emitted.
    if (lines.length === 0) {
      lines.push(suffix);
    } else {
      lines[lines.length - 1] = (lines[lines.length - 1] ?? "") + suffix;
    }
  }
  return lines.join("\n");
}
