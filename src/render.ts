// Pure rendering helpers: split-bar, 5-band thresholds, ANSI coloring,
// and line assembly. All tunable values come from the singleton in
// ./config.ts. The line layout is driven by the `statuslineTemplate`
// config field — an ordered list of display-module tokens and
// separator references.
//
// Render is READ-ONLY against the per-tick in-memory state; all writes
// go through src/status-store.ts (processTick + single commit()).

import { configStore, warn } from "./config.ts";
import { normalizeUrl } from "./utils.ts";
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
// m_memUsage data source: Darwin shells out to `vm_stat`, others use os.*.
import * as os from "node:os";
import { execSync } from "node:child_process";
// m_dirName derives its body from stdin.cwd via path.basename.
import * as path from "node:path";
export type { PrevTickSnapshot, AvgSnapshot };

type Window = {
  // Percentage USED in [0, 100]. May be fractional; we'll round.
  pct: number;
  // ISO timestamp when the window resets, if known.
  resetAt?: string | null;
  // ISO timestamp when the current window STARTED. Paired with resetAt to
  // compute duration + pick a fill-state arrow; missing on providers with no
  // window concept (DeepSeek), which falls back to the legacy single arrow.
  resetStartAt?: string | null;
  // Window length in ms (resetAt - resetStartAt). Required for the split-arrow
  // logic; kept separate so hot render paths don't re-parse the ISO strings.
  resetDurationMs?: number | null;
};

// Unified interval shape. The `intervals` dict is open-ended; the three
// reserved keys ("short" / "mid" / "long") ship with windowId defaults
// 5h / 7d / 30d. Fields are populated by the plugin's `fillQuota` and
// normalised by `ensureInterval` in src/plugins/parsers.ts.
// `intervalToWindow` (below) projects an `Interval` → `Window` for the
// gauge / countdown renderers.
export type Interval = {
  // Free-form string identifier (any value allowed; config.ts auto-prefixes
  // digit-leading values with `w`). Purely a label — the renderer reads
  // `iv.label` for display, NOT `iv.windowId`, so widening is invisible.
  windowId: string;
  // Built-in default: same as windowId. Printed as the window's display label
  // (e.g. "5h" in `quota: 123/500`).
  label: string;
  // Epoch ms when the window started, or null if unknown.
  startAt: number | null;
  // Epoch ms when the window resets, or null if unknown.
  endAt: number | null;
  // Window length in ms (endAt - startAt when both are present and the user
  // didn't supply intervalMs directly). Used by the fill-state arrow picker.
  intervalMs: number | null;
  // [0, 100] — at least one of {remainingPercent, usedPercent} is always
  // non-null after ensureInterval; the two are mirror-derived.
  remainingPercent: number | null;
  usedPercent: number | null;
  // Quota group — integer units (no normalization). Any subset may be present;
  // `m_quota` decides what's enough to render.
  remainingQuota: number | null;
  usedQuota: number | null;
  limitQuota: number | null;
};

type DisplayMode = "remaining" | "used";

// Interval-term selector used by m_windowQuota / m_countdown / m_quota.
// The `intervals` dict is open-ended, so `term` accepts any string the plugin
// declared; the renderer reads `ctx.intervals[term]` (placeholder when missing).

// Shorthand for the active config snapshot. Reading configStore.get()
// on every call would be wasteful for hot paths (every
// renderProviderLine call does many color/band lookups) — the helpers
// below read it lazily.
function cfg() {
  return configStore.get();
}

// Top-level token-label resolver. Reads configStore (lazy, same as `cfg()`)
// and returns the configured prefix for the requested axis. All label names
// live under the `labelToken*` / `labelApi*` namespace so overriding one
// family member propagates to every module on that semantic axis
// (`m_tokenIn` / `m_accTokenIn` / `m_sumTokenIn` all read labelTokenIn):
//   "in" → labelTokenIn, "out" → labelTokenOut, "cacheIn" → labelTokenCachedIn,
//   "totalIn" → labelTokenTotalIn, "inSpeed" → labelTokenInSpeed,
//   "outSpeed" → labelTokenOutSpeed, "apiMs" → labelApiMs,
//   "apiCalls" → labelApiCalls, "memUsage" → labelMemUsage,
//   "hitRate" → labelTokenHitRate
// Defaults reproduce the v0.8.x literals ("in:" / "out:" / "cache:" /
// "Total:" / "api:" / "calls:" / "hit:" / "Mem:") so existing templates
// render byte-identical. Speed defaults are intentionally independent of the
// in/out token-axis defaults.
type LabelAxis =
  | "in" | "out" | "cacheIn" | "totalIn"
  | "inSpeed" | "outSpeed" | "apiMs" | "apiCalls"
  | "memUsage" | "memUsed" | "memTotal"
  | "hitRate"
  | "contextSize" | "contextWindowSize" | "contextUsedPercent" | "contextRemainingPercent"
  | "contextUsage"           // "ctx:" two-tone x/y prefix
  | "startTime" | "endTime"  // tick statistics window start/end
  | "quota"                  // "quota: 123/500"
  | "cost"                   // token cost prefix
  | "est"                    // periodic quota estimate prefix
  | "pluginSystem"        // m_pluginSource glyph — built-in (default "📌")
  | "pluginUserDefined"   // m_pluginSource glyph — user override (default "🎨")
  | "pluginCC"            // m_pluginSource glyph — reserved "claude 官方" branch (default
                          // "🔖"); not yet wired into the dispatch table (CC 分支暂不做实现
                          // 2026-07-12), but overridable via labels.labelPluginCC.
  | "pluginMissing"       // m_pluginSource glyph — matched provider id has no plugin (default "❗")
  | "gitClean" | "gitDirty";  // m_branch|withStatus:true clean/dirty suffix glyphs (defaults "✅" / "🟠")
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
    case "memUsed": return labels.labelMemUsed;
    case "memTotal": return labels.labelMemTotal;
    case "hitRate": return labels.labelTokenHitRate;
    // Context-window prefixes ("size:" / "used:" / "remain:").
    case "contextSize": return labels.labelContextSize;
    case "contextWindowSize": return labels.labelContextWindowSize;
    case "contextUsedPercent": return labels.labelContextUsedPercent;
    case "contextRemainingPercent": return labels.labelContextRemainingPercent;
    case "contextUsage": return labels.labelContextUsage;
    // Start/end of the tick statistics window. Defaults "start:" / "end:".
    case "startTime": return labels.labelStartTime;
    case "endTime": return labels.labelEndTime;
    // Quota module prefix, default "quota: " (trailing space).
    case "quota": return labels.labelQuota;
    // Token cost module prefix, default "cost:".
    case "cost": return labels.labelTokenCost;
    // Periodic quota estimate prefix, default "est:".
    case "est": return labels.labelEstQuota;
    // m_pluginSource glyphs, defaults "📌" / "🎨" / "🔖" / "❗".
    case "pluginSystem":       return labels.labelPluginSystem;
    case "pluginCC":           return labels.labelPluginCC;
    case "pluginMissing":      return labels.labelPluginMissing;
    case "pluginUserDefined":  return labels.labelPluginUserDefined;
    // m_branch|withStatus:true clean/dirty suffix glyphs, defaults "✅" / "🟠".
    case "gitClean": return labels.labelGitClean;
    case "gitDirty": return labels.labelGitDirty;
  }
}

// For the bare MODULES render path (which receives a pre-prefixed string from
// helpers like computeTickDelta / computeTickSpeed / accBody): strip the
// leading label when valueOnly. Falls through when the prefix doesn't match
// (the placeholder path may emit "n/a" without a label).
function stripLabelIfValueOnly(value: string, axis: LabelAxis, strip: boolean): string {
  if (!strip) return value;
  const prefix = labelFor(axis);
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

// System RAM byte formatter (1024-base). G tier uses .toFixed(1), M/K use
// .toFixed(0). Returns "n/a" on null so call sites can concat directly.
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

// Format a Unix-ms timestamp as `HH:MM:SS` local time (or
// `YYYY-MM-DD HH:MM:SS` with opts.abs). Used by m_accStartTime /
// m_sumStartTime / m_sumEndTime. The sv-SE locale is the documented
// "ISO8601-shaped local time" idiom (24h clock, no AM/PM) — same as
// diagnostics.ts:localIso. Returns "n/a" on null / non-finite / non-positive
// inputs so call sites can concat directly.
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

// Sample system memory. Darwin shells out to `vm_stat` for active+wired pages
// (more accurate than os.freemem on macOS); other platforms use os.totalmem() -
// os.freemem(). Returns null only when vm_stat can't be parsed (the catch
// falls through to the os.* path).
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
// Distinct color for the BROKEN-chain "⛓️‍💥 X ago" annotation (fetch failed,
// rendering cached value). Splits the gray stale vocabulary: gray for
// informational 🔗, dark red for degraded ⛓️‍💥. Default `\x1b[31m`.
export const BROKEN_COLOR = configStore.get().colors.broken;

// thresholds.percentBands is indexed against usedPct regardless of display
// mode — both modes share the same danger axis ("how much have I spent?").
// remaining=N mirrors used=100-N, so both display modes agree at the same
// danger level.
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
  // thresholds[i] is the upper bound of band i (low-exclusive): 5 bands
  // [0,t0)..[t3,100]. Values exactly AT a threshold fall in the band above
  // (less dangerous) — matching "0/20/40/60/80" where 20 is the transition
  // into dark green.
  const v = Math.max(0, Math.min(100, value));
  for (let i = 0; i < thresholds.length; i++) {
    if (v < thresholds[i]) return i;
  }
  return thresholds.length; // top band
}

export function colorFor(displayedPct: number, mode: DisplayMode): string {
  // Index against usedPct regardless of mode: remaining=60 → used=40 →
  // band 0 under the [60,70,80,90] default.
  const usedPct = mode === "remaining" ? 100 - displayedPct : displayedPct;
  const idx = bandIndex(usedPct, colorThresholds());
  return paletteByUsed()[idx];
}

// Split-bar: [<USED cells>][<REMAINING cells>]. USED cells use the "filled"
// glyph (▓), REMAINING use "empty" (░). The colored side is the "metric of
// concern": left (used) in used mode, right (remaining) in remaining mode.
type SplitBar = {
  leftChunk: string;  // LEFT half of bar — colored if mode==='used', plain otherwise
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

  // Left = used, right = remaining; the "metric of concern" side gets color.
  // Glyphs flip in remaining mode so the bar reads "spent ▓▓▓░░░ left":
  //   used      : left=used▓ (colored), right=remaining░ (plain)
  //   remaining : left=used░ (plain),   right=remaining▓ (colored)
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
// not used by the render pipeline anymore.
export function pctBar(usedPctValue: number, width = configStore.get().bar.width): { filled: string; empty: string } {
  const clamped = Math.max(0, Math.min(100, usedPctValue));
  const filledCount = Math.round((clamped / 100) * width);
  const emptyCount = Math.max(0, width - filledCount);
  return {
    filled: cfg().bar.filled.repeat(filledCount),
    empty: cfg().bar.empty.repeat(emptyCount),
  };
}

// Project an `Interval` into the `Window` shape the gauge / countdown renderers
// consume. Returns null when the interval has no usable percent data.
//   pct ← usedPercent (or 100 - remainingPercent), clamped [0,100]
//   resetAt ← ISO of endAt; resetStartAt ← ISO of startAt
//   resetDurationMs ← endAt - startAt (null when either is null or endAt <= startAt)
// Quota fields are NOT projected — `m_quota` consumes them directly.
function intervalToWindow(i: Interval): Window | null {
  // used wins when both are populated; else derive from remainingPercent.
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

// Split an Interval's quota axis into structural parts so the renderer can
// color just the digit (the "metric of concern"), not the prefix/limit tail.
// Returns null when there's no body to render. Renders per spec:
//   used + limit → "quota: 123/500"; limit only → "quota: 0/500";
//   used only → "quota: 123/--"; none → null
// `axisPct` is the band index's percentage — null when no ratio can be derived
// (e.g. `used/--`), and the caller falls back to STALE_COLOR / no color so the
// digit never gets a spurious band tint. The `quota:` prefix comes from
// `labelFor("quota")`.
function renderQuotaParts(
  iv: Interval,
  mode: DisplayMode = "used",
): {
  prefix: string;
  axisNumber: number;    // the displayed digit
  total: number | null;  // the right side ("1500" or "--")
  axisPct: number | null;// 0..100 of the displayed digit relative to limit
} | null {
  const prefix = labelFor("quota");

  if (mode === "remaining") {
    if (iv.remainingQuota != null && iv.limitQuota != null) {
      return {
        prefix,
        axisNumber: iv.remainingQuota,
        total: iv.limitQuota,
        axisPct: (iv.remainingQuota / iv.limitQuota) * 100,
      };
    }
    if (iv.usedQuota != null && iv.limitQuota != null) {
      const remaining = iv.limitQuota - iv.usedQuota;
      const clamped = Math.max(0, Math.min(iv.limitQuota, remaining));
      return {
        prefix,
        axisNumber: clamped,
        total: iv.limitQuota,
        axisPct: (clamped / iv.limitQuota) * 100,
      };
    }
    if (iv.limitQuota != null) {
      return {
        prefix,
        axisNumber: iv.limitQuota,
        total: iv.limitQuota,
        axisPct: 100, // nothing used ⇒ full remaining
      };
    }
    if (iv.remainingQuota != null) {
      return {
        prefix,
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
      prefix,
      axisNumber: iv.usedQuota,
      total: iv.limitQuota,
      axisPct: (iv.usedQuota / iv.limitQuota) * 100,
    };
  }
  if (iv.remainingQuota != null && iv.limitQuota != null) {
    const used = iv.limitQuota - iv.remainingQuota;
    const clamped = Math.max(0, Math.min(iv.limitQuota, used));
    return {
      prefix,
      axisNumber: clamped,
      total: iv.limitQuota,
      axisPct: (clamped / iv.limitQuota) * 100,
    };
  }
  if (iv.limitQuota != null) {
    return {
      prefix,
      axisNumber: 0,
      total: iv.limitQuota,
      axisPct: 0, // nothing known used ⇒ 0% consumed
    };
  }
  if (iv.usedQuota != null) {
    return {
      prefix,
      axisNumber: iv.usedQuota,
      total: null,
      axisPct: null,
    };
  }
  return null;
}

// Band-color a quota body: the digit gets `colorFor(displayedPct, mode)`,
// prefix/limit tail stays plain. `userColor` overrides the band (same
// precedence as every inline module's :color|); axisPct==null → STALE_COLOR
// (matches the m_window* "no percent → gray" convention).
function wrapQuotaBody(
  parts: NonNullable<ReturnType<typeof renderQuotaParts>>,
  mode: DisplayMode,
  userColor: string | undefined,
  valueOnly: boolean = false,
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
  // valueOnly strips the prefix:
  //   normal → `quota: <axis>/<total>` (e.g. `quota: 413.7/1500`)
  //   valueOnly → `<axis>/<total>` (e.g. `413.7/1500`)
  const body = `${tint}${parts.axisNumber}${RESET}/${total}`;
  return valueOnly ? body : `${parts.prefix}${body}`;
}

// v0.9.0+ — epoch-ms → ISO timestamp. Local to render.ts so
// intervalToWindow can use it without dragging the api module
// into render's hot path.
function tsToIso(ms: number | null): string | null {
  if (ms == null) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

// Bar + colored-percent portion only (no countdown/label) — the reset
// annotation is rendered independently by m_countdown. formatOneResetSuffix
// is the companion helper that emits `<arrow><countdown>·<label>`.
function formatOneChunk(
  w: Window,
  mode: DisplayMode,
  width = cfg().bar.width,
  // stale=true → the WHOLE colored span (bar chunks + percent tail) wraps in
  // STALE_COLOR ("this number is from a failed fetch"). splitBar() is left
  // untouched (tests assert on its .color), so we rebuild the colored chunks
  // here; the plain side stays plain. Inline :color| overrides still win.
  stale: boolean = false,
): string {
  const usedPct = Math.max(0, Math.min(100, Math.round(w.pct)));
  const remainingPct = 100 - usedPct;
  const displayedPct = mode === "remaining" ? remainingPct : usedPct;
  const bar = splitBar(usedPct, mode, width);
  if (!stale) {
    return `${bar.leftChunk}${bar.rightChunk} ${bar.color}${displayedPct}%${RESET}`;
  }
  // Rewrite the colored chunks + percent tail in STALE_COLOR; the plain side
  // stays plain so the used/remaining shape is still readable.
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

// Same layout as formatOneChunk but the colored side + percentage wrap in
// `override` (used by the inline-args `|color|<c>` path on gauge modules).
// The user's color REPLACES the band-based color — the override always wins.
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

// |valueOnly|true variant: just the colored percentage (e.g. "81%"), no bar
// chunks. Color is the user override or the band color from splitBar.
function formatPercentOnly(w: Window, mode: DisplayMode, overrideColor?: string): string {
  const usedPct = Math.max(0, Math.min(100, Math.round(w.pct)));
  const displayedPct = mode === "remaining" ? 100 - usedPct : usedPct;
  const color = overrideColor ?? splitBar(usedPct, mode).color;
  return `${color}${displayedPct}%${RESET}`;
}

// Whether a window's countdown becomes the `n/a` placeholder: stale (fetch
// failed, serving cached) AND the cached resetAt is already in the past.
// AND-only — stale+future reset is still useful; fresh+past-due means the next
// tick will roll the countdown forward.
function isStaleAndPastDue(w: Window, stale: boolean, nowMs: number): boolean {
  if (!stale) return false;
  if (!w.resetAt) return false;
  const t = Date.parse(w.resetAt);
  if (!Number.isFinite(t)) return false;
  return t <= nowMs;
}

// Build the `<arrow>n/a·<label>` body used when stale AND resetAt is past-due.
// Arrow still comes from pickResetArrow (index 0 when ratio ≤ 0). Caller wraps
// in STALE_COLOR.
function formatStalePastDueResetSuffix(
  windowLabel: string,
  w: Window,
  nowMs: number,
): string {
  const arrow = pickResetArrow(nowMs, w.resetStartAt, w.resetDurationMs);
  return `${arrow}n/a·${windowLabel}`;
}
function formatOneResetSuffix(
  windowLabel: string,
  w: Window,
  nowMs: number = Date.now(),
): string {
  if (!windowLabel) return "";
  // Template:
  //   resetAt present → "<arrow><countdown>·<windowLabel>"
  //   resetAt missing → "<windowLabel>" (DeepSeek / legacy — no reset info,
  //                     don't fake it with a default arrow)
  const resetSuffix = formatResetSuffix(w.resetAt, nowMs);
  const arrow = pickResetArrow(nowMs, w.resetStartAt, w.resetDurationMs);
  return w.resetAt
    ? `${arrow}${resetSuffix}·${windowLabel}`
    : windowLabel;
}

// |valueOnly|true variant: just the arrow + countdown (e.g. "🕑25d20h"), no
// `·` window label. Returns "" when no reset time is available.
function formatCountdownValueOnly(w: Window, nowMs: number): string {
  const resetSuffix = formatResetSuffix(w.resetAt, nowMs);
  const arrow = pickResetArrow(nowMs, w.resetStartAt, w.resetDurationMs);
  return w.resetAt ? `${arrow}${resetSuffix}` : "";
}

// Countdown portion of the reset annotation (no arrow/label) — e.g. "2h3m",
// "<1m", "0m". Formatting rules live in `formatRemainingMs` (shared with the
// stale-age suffix).
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

// Format remaining ms as a `1d2h3m4s` countdown honoring
// `timeFormat.minUnit` (smallest unit shown) and `timeFormat.maxUnitCount`
// (non-zero units to show). Algorithm: extract d/h/m/s → drop units below
// minUnit → drop leading zeros → empty ⇒ "<1<minUnit>" (positive) or
// "0<minUnit>" (past-due) → slice to maxUnitCount. Internal zeros are kept
// ("2h0m"); a minUnit-excluded tail is dropped (50s, minUnit="m" → "<1m").
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

// Fixed-second TTL suffix for m_cacheTtlStatus / m_statTtlStatus. Ignores
// `timeFormat.minUnit` — the TTL gauge is always second-granular.
//   >= 1s → "Ns" (floor); 500..999ms → "<1s"; <= 0 → "0s"; NaN → ""
// The floor never overstates remaining TTL (the bar gauge carries the fraction).
export function formatTtlSeconds(remainingMs: number): string {
  if (!Number.isFinite(remainingMs)) return "";
  if (remainingMs <= 0) return "0s";
  const secs = Math.floor(remainingMs / 1000);
  if (secs < 1) return "<1s";
  return `${secs}s`;
}

// Pick a reset-countdown glyph by how full the window is: index =
// floor(remainingMs / resetDurationMs * length), clamped so the array reads
// left-to-right as "fresh → about to reset". Falls back to index 0 when the
// interval data is missing (DeepSeek, legacy shape, clock skew).
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
  // Clamp to [0, 1] — past-the-end (negative) and clock-skew (>1) both clamp.
  const ratio = Math.max(0, Math.min(1, (resetDurationMs - elapsed) / resetDurationMs));
  const idx = Math.min(arrows.length - 1, Math.floor(ratio * arrows.length));
  return arrows[idx];
}

// "age of cached value" formatter for the trailing annotation. `healthy`
// toggles the emoji: 🔗 fresh / ⛓️‍💥 stale (fetch failed). Wrapped in
// STALE_COLOR and RESET-terminated; returns "" only for non-finite ageMs.
// Uses the same template as the reset countdown (formatRemainingMs +
// timeFormat knobs): 0 → "0<minUnit> ago"; sub-minute → "<1m ago"
// (minUnit="m") or "${s}s ago" (minUnit="s").
// Visibility is caller-gated: m_age emits whenever ageMs != null;
// renderProviderLine's forced-visibility block emits only when stale === true.
export function formatStaleSuffix(
  ageMs: number,
  healthy: boolean = false,
  override?: string,
): string {
  if (!Number.isFinite(ageMs)) return "";
  const emoji = healthy ? cfg().stale.ageEmoji.healthy : cfg().stale.ageEmoji.broken;
  const label = `${formatRemainingMs(ageMs)} ago`;
  // Default color split: STALE_COLOR (gray) for the informational 🔗 on fresh
  // ticks, BROKEN_COLOR (red) for ⛓️‍💥 when the fetch failed. An explicit
  // m_age|color| override always wins regardless of broken/fresh.
  const color = override ?? (healthy ? STALE_COLOR : BROKEN_COLOR);
  return `${color}${emoji} ${label}${RESET}`;
}

// Read the configured display mode (config.json `display`; the old
// CREDITGAUGE_DISPLAY env var is gone).
export function resolveDisplayMode(): DisplayMode {
  return cfg().display;
}

// ----- DeepSeek balance line -------------------------------------------------
//
// A balance is an ABSOLUTE amount, so the bands live at the configured
// thresholds (default 5/10/20/50 — red / orange / yellow / dark green /
// bright green). Lower balance = more urgent, so the lowest band (red) is the
// lowest value — same direction as "remaining" mode.

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

// Display prefix for one balance entry: `currencySymbol(code)` resolves it,
// with a fallback to the uppercased code for unmapped codes — never blanks.
function formatBalanceChunk(currency: string, v: number): string {
  return `${currencySymbol(currency)}${formatBalanceValue(v)}`;
}

// Currency-code → display-symbol lookup. Covers DeepSeek + common
// USD-denominated currencies; unmapped codes fall back to the uppercased code.
// Deliberately NOT in config (per "全部通过插件进行独立解析"): a plugin wanting
// a custom symbol can emit a different code or surface its own m_label module.
function currencySymbol(code: string): string {
  switch (code) {
    case "CNY":
    case "RMB":
      return "¥";
    case "USD":
      return "$";
    default:
      return code.toUpperCase();
  }
}

type BalanceLike = {
  isAvailable: boolean;
  // Entries are `{ currency, totalBalance }` only; the display prefix comes
  // from `currency` via `currencySymbol`. No `label` field in the schema.
  entries: ReadonlyArray<{ currency: string; totalBalance: number }>;
  minValue: number | null;
};

// Render the balance line as a " · "-joined set of per-entry colored chunks.
// Each entry is colored by its own totalBalance via colorForBalance (NOT
// minValue), so a multi-currency account reflects each currency's urgency
// (CNY 110 → bright green, USD 3.5 → red). `override` forces one color on
// every entry. Returns "" when there's nothing to render (module drops).
export function formatBalanceEntriesColored(b: BalanceLike, override?: string): string {
  if (!b.isAvailable || b.entries.length === 0 || b.minValue == null) {
    return "";
  }
  return b.entries
    .map((e) => {
      const color = override ?? colorForBalance(e.totalBalance);
      return `${color}${formatBalanceChunk(e.currency, e.totalBalance)}${RESET}`;
    })
    .join(" · ");
}

// ----- lineTemplate / module renderer ------------------------------------
//
// A lineTemplate is an ordered list of tokens: `m_<name>` display modules
// (registered in MODULES below) and `s_<name>` separator literals. The
// renderer concatenates module output left-to-right. A module returning null
// is "hidden in this context" — the surrounding separators are SKIPPED too, so
// no orphan spaces or "·" remain. Unknown module names (typos) expand to ""
// and emit ONE stderr warning per render (capped to avoid tick spam).
type RenderContext = {
  mode: DisplayMode;
  nowMs: number;
  // Open-ended `intervals` dict. The reserved keys ("short" / "mid" / "long")
  // are seeded by `ensureQuota` so legacy `|term|short`/`mid`/`long` lookups
  // keep working; plugins may declare arbitrary keys. m_sum* align-aware scans
  // read `Object.values(intervals)` to find a matching `windowId`.
  intervals?: Record<string, Interval | null>;
  // Legacy back-compat: callers/tests still construct ctx with flat
  // `shortInterval` / `midInterval` / `longInterval`; renderTemplate /
  // renderProviderLine fold them into the reserved dict keys when `intervals`
  // is absent. Canonical ctx has only `intervals`.
  shortInterval?: Interval | null;
  midInterval?: Interval | null;
  longInterval?: Interval | null;
  balance: BalanceLike | null;
  ageMs: number | null;
  stale: boolean;
  version: string;
  // Live stdin snapshot for the m_token* modules. Always present on the main
  // flow (index.ts builds one before invoking renderProviderLine).
  tokens: TokenSnapshot | null;
  // Synthetic Window for m_windowContext, synthesized from
  // tokens.contextWindow.contextUsedPercent (only `pct` is read). Null when
  // stdin lacks used_percentage.
  contextWindow: Window | null;
  // The provider TYPE discriminator (providerTypeFor): "quota" / "balance" /
  // "unknown". Used by per-module `type` filters and m_modeLabel's label
  // routing. (Renamed from `providerModeKey` to avoid collision with the
  // display-mode field `mode`.)
  providerType: "quota" | "balance" | "unknown";
  // The active provider INSTANCE id (e.g. "minimax"); null when no configured
  // entry matched. Distinct from `providerType` (the category). Used by
  // `m_template|<key>|providers:<id1,id2>` gates.
  currentProvider?: import("./types.ts").Provider;
  // Column cursor for `s_move|pos:<n>`. Initialized to 0 by renderTemplate,
  // reset to 0 on `\n`, bumped by each chunk's ANSI-stripped display width
  // (per-code-point via charDisplayWidth — emoji/CJK = 2, narrow = 1).
  lineCursor?: number;
  // Cross-recursion dedup ref for m_age. Initialized to `{ value: false }` by
  // renderProviderLine and propagated by reference through nested m_template
  // expansions; the first m_age to emit claims the slot, later instances skip.
  ageEmittedRef?: { value: boolean };
  // Passthrough args from an outer `m_template|<key>|...` expansion. Built by
  // the m_template renderer (minus key/type/providers intrinsics) before
  // recursing; INLINE_RENDERERs read it as a fallback when their local param
  // is undefined (inner-explicit wins). Fresh per m_template invocation;
  // nested m_template is impossible (config.ts strips them at load time).
  passThrough?: Record<string, ResolvedValue>;
  // Quote bodies pre-fetched by `preFetchQuotes` (index.ts:main), keyed by raw
  // address. Missing key → the address-mode path falls back to local QUOTES.
  // One-tick lifetime.
  quoteBodies?: Map<string, string>;
  // Which side of the user-vs-builtin fence the active provider's plugin was
  // loaded from on the most recent fetch (cache row `<provider>:pluginSource`).
  // null → m_pluginSource drops to no-op. Optional so test fixtures / older
  // callers can build a ctx without it; renderProviderLine normalizes → null.
  pluginSource?: "user" | "builtin" | "missing" | null;
  // Normalized ANTHROPIC_BASE_URL, used by m_sum* to filter JSONL rows to the
  // current provider. undefined (no provider configured) skips the filter.
  providerBaseUrl?: string;
};

// Modules may declare a `type` filter so they only render for one provider
// kind: a `type:"quota"` module (m_windowQuota) silently drops on a balance
// provider's template and vice-versa; untagged modules (m_token*, m_age, …)
// are provider-agnostic. The renderer compares `mod.type` against
// `ctx.providerType`. `"unknown"` is reserved for modules that want to render
// only when ANTHROPIC_BASE_URL matches no configured provider (no module
// currently uses it).
type Module = ((ctx: RenderContext) => string | null) & {
  type?: "quota" | "balance" | "unknown";
};

// v0.8.x cwf-tickStatus-v2. Per-tick state lives in
// `state/<projectHash>/state.json` (managed by src/status-store.ts).
// Two slot families:
//
//   (A) tickStatus:<...> — PURE ACCUMULATORS (只表示累计状态). Three
//       dimensions, all written by setAvg's atomic path:
//         tickStatus:<sessionId>   per-session (clear-bounded)
//         tickStatus:<projectHash> per-project (cwd-bounded, no prefix)
//         tickStatus:<model>       per-model (modelDisplayName)
//       value shape (acc-only, no per-tick fields):
//         accTokenIn / accTokenOut / accTokenCachedIn — accumulated
//           current.input / output / cacheRead
//         accTokenTotalIn — per-tick-delta-accumulator of totalIn
//         accApiMs — += deltaApiMs (delta-accumulator across all three
//           scopes; a sessionId/project/model change naturally zeros the slot)
//         accApiCalls — accumulated API-call count
//
//   (B) prevTickStatus — SINGLETON (not per-dimension). Last tick's
//       snapshot, used to compute the per-tick delta and detect a regression
//       (totalApiMs < prev means the CC process restarted; the tick is
//       dropped from the sample row). Shape: in/out/cachedIn/totalIn/
//       totalApiMs + sessionId/cwd/model.
//
// accApiCalls AND-gate: on a tick where deltaApiMs > 0 AND input_tokens > 0
// (a real API call that produced input tokens), accApiCalls += 1. A tick with
// deltaApiMs > 0 but input_tokens == 0 does NOT count.
//
// Re-exported for the test fixture import surface (implementations live in
// src/status-store.ts — the writer-side helpers are called by the -processor,
// not render).
export { peekPrevTick } from "./status-store.ts";

export {
  setPrevTick as setPrevTick,
  setLastSpeed as setLastSpeed,
  setLastApiMs as setLastApiMs,
  setLastTokenHitRate as setLastTokenHitRate,
} from "./status-store.ts";

// ----- lastActive (v0.4.x) -----
//
// Stores the LAST active-tick tps per direction (in / out) so an idle tick
// (deltaApi == 0) falls back to the cached value instead of "--/s". Stored in
// state.json under `lastActive:in` / `lastActive:out` (project-wide singleton).
// R7 — 60s TTL gate DISABLED: cache is permanent last-known-good, idle ticks
// always surface the cached value STALE_COLORed and never expire. Writes happen
// ONLY on active ticks; sessionId arg kept for test-fixture back-compat.
export {
  peekLastSpeed,
  peekLastApiMs,
  peekLastTokenHitRate,
} from "./status-store.ts";

// Test-only no-op stub (production never calls this); tests should use
// setPrevTick (still exported) or processTick directly.
export function __resetPrevTickForTest(
  _sessionId: string,
  _cwd?: string | null,
): void {}

// Re-exported for tests (implementation lives in status-store.ts).
export { peekAvg } from "./status-store.ts";

// Read the three-layer accumulator at a chosen scope (m_acc* family):
//   session → tickStatus:<sessionId> (clear-bounded)
//   project → tickStatus:<projectHash(cwd)> (cwd-bounded)
//   model   → tickStatus:<modelId> (per-model)
// Returns null when the slot has never been written (module renders a
// placeholder rather than fabricating a "0").
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
    // Per-model slot lookup uses stdin.model.id (matches sample.model + tokenPrices keys).
    modelId: t?.modelId,
  });
}

// setAvg re-exported for back-compat with test fixtures (the -processor is
// the sole caller; render is read-only). The three surviving scopes all
// DELTA-ACCUMULATE the in/out/cached/totalIn/apiMs/apiCount scalars; there is
// no per-process slot to zero on CC-process restart (detectRegression still
// fires — it gates sample-row emission).
export { setAvg } from "./status-store.ts";

// v1.0 — per-render memoization is GONE: the -processor calls
// computeAndCacheTickDeltaPure once per tick and stashes the result on
// tickState.delta; render reads it via getDeltaForRender() (single producer
// per tick). PREV_TICK_KEY is set once before render, so all contexts (outer,
// m_template inner) see the same baseline via peekPrevTick.
//
// Per-API-call delta semantics:
//   - current_usage.* IS the per-turn delta (NOT subtracted from prev); only
//     deltaApiMs is a TRUE subtraction (totalApiDurationMs is session-cumulative).
//   - Gating is deltaApi > 0 ONLY — in/out/cache_read don't need to move together.
//   - First tick assumes prev=0 so the first turn still contributes.

// Compute the per-API-call throughput for one of {in, out}. Always returns a
// non-null value — a missing-data render is "in:--/s", not a drop, so the
// module keeps its stable slot in the lineTemplate.
//
// math (when hasDelta): tps = current_in_or_out / delta_api * 1000
//
// Missing-data conditions (render "in:--/s"): no snapshot, or delta_api <= 0
// AND no cached tps from a previous active tick to fall back to. IN and OUT
// don't need to move together — a synthesized-message turn adds 0 input but
// real output, so the truthful rate 0.0/s renders as "0.0/s", not "--/s".
//
// The last ACTIVE-tick tps is cached per session; idle ticks fall back to it
// (no in:--/s blink between measurements). Returns an `active` flag so the
// caller picks color: active = scale band, inactive = STALE_COLOR (gray reads
// "measurement from a previous API call").
function computeTickSpeed(
  ctx: RenderContext,
  direction: "in" | "out",
  color: string,
): {
  value: string;
  active: boolean;
  tps: number | null;
} {
  // Speed prefix routes through labelFor (labels.labelInSpeed / labelOutSpeed),
  // independent of the in/out token-axis labels. Defaults "in:" / "out:".
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
    // we have one, otherwise render the truthful "0.0/s".
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

// m_accTokenInSpeed / m_accTokenOutSpeed helper. Reads the chosen scope's
// accumulator and computes accToken* / accApiMs * 1000 (t/s). Mirrors
// computeTickSpeed (the per-turn twin) but pulls from peekAcc. Returns:
//   - "direction:n/a" when the scope has never been written
//   - "0/s" plain when accApiMs > 0 but accToken* === 0 (value-zero rule)
//   - scale-colored "N/s" when accApiMs > 0 AND the token accumulator is positive
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
  // Speed prefix via labelFor (labelInSpeed / labelOutSpeed), defaults "in:" / "out:".
  const prefix = labelFor(direction === "in" ? "inSpeed" : "outSpeed");
  const v = peekAcc(scope, ctx);
  if (!v) {
    return { value: `${prefix}n/a`, active: false, tps: null };
  }
  if (v.accApiMs === 0) {
    // No API duration yet → "direction:0/s" plain (zero is real data, not a placeholder).
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

// Per-API-call raw token delta. Distinguishes three states:
//   - snapshot missing (tokens / sessionId / current.tokenIn absent) → "in:n/a"
//   - idle tick (stdin present, no delta this turn) → "in:0" (truthful zero)
//   - active tick → "in:<formatCompactToken(n)>"
// Rule: 0 renders as "0" (never hidden); null renders as "n/a". Uses
// formatCompactToken so single-call counts match the cumulative modules.
function computeTickDelta(
  ctx: RenderContext,
  direction: "in" | "out",
): { value: string; numeric: number | null; stale: boolean } {
  const t = ctx.tokens;
  const prefix = labelFor(direction);
  // `hasMeasurement` mirrors the validity gate (tokenTotalIn > 0 AND
  // tokenTotalOut > 0 AND apiMs > 0). `numeric` carries the live-stdin value
  // so idle ticks (apiMs=0) still surface a real number, mapped to STALE_COLOR
  // (live stdin's last-known measurement, gray-wrapped). `numeric: null` means
  // no stdin at all (placeholder). `stale` = hasMeasurement mirror.
  if (!t || !t.sessionId) {
    return { value: `${prefix}n/a`, numeric: null, stale: false };
  }
  const r = getDeltaForRender();
  // Pull the live stdin value directly — the processed delta collapses to 0
  // on idle ticks, but the user should see the actual stdin number.
  const liveN = direction === "in" ? t.current.tokenIn : t.current.tokenOut;
  const liveNumeric =
    typeof liveN === "number" && Number.isFinite(liveN) ? liveN : 0;
  if (!r.hasMeasurement) {
    // Idle tick — display the live stdin number (numeric carries the same
    // value); `stale` routes the wrap to STALE_COLOR instead of the band color.
    return { value: `${prefix}${formatCompactToken(liveNumeric)}`, numeric: liveNumeric, stale: true };
  }
  const n = direction === "in" ? r.in : r.out;
  return { value: `${prefix}${formatCompactToken(n)}`, numeric: n, stale: false };
}

// m_tokenInAvg / m_tokenOutAvg / computeTickAvg REMOVED — session-averaged
// speed is now m_accTokenInSpeed / m_accTokenOutSpeed (see computeAccSpeed).

// The m_totalToken* family is REMOVED — use the m_acc* family with
// scope=session (default): m_totalTokenIn → m_accTokenIn,
// m_totalTokenOut → m_accTokenOut, m_totalTokenWithCacheIn → m_accTokenCachedIn.
// No aliases are provided.

// Body factory for the m_acc* family. Renders the chosen accumulator field at
// a chosen scope (default session). The -processor has already written the
// per-tick deltas to tickState.pending before render, so this is a pure read.
// Placeholder when the chosen slot has never been written; zero renders as
// "0" (value-zero rule). (accPrimer / accCachePrimer are GONE — the
// -processor owns the accumulator writes.)
function accBody(
  ctx: RenderContext,
  field: "in" | "out" | "cached" | "total" | "apiMs" | "apiCalls",
  scope?: "session" | "project" | "model",
  stripLabel?: boolean,
): string {
  // valueOnly collapses every prefix below to "" (bare number).
  const strip = stripLabel ?? ctx.passThrough?.valueOnly === "true";
  const useScope = scope ?? "session";
  const v = peekAcc(useScope, ctx);
  if (!v) {
    // Missing slot → placeholder (the only honest signal — the cachedIn track
    // only writes when stdin ships the cache field).
    return placeholderAcc(field, useScope, strip);
  }
  // cache_read absence on the current stdin does NOT imply an empty slot at any
  // scope (all scopes accumulate across ticks) — a missing slot falls through
  // to the `if (!v)` branch above → placeholderAcc. Re-read once in case the
  // first peekAcc fired before the -processor's writes (tests sometimes
  // interleave; in production processTick runs before renderTemplate).
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
  // The acc* family uses the same label axes as its per-turn siblings
  // (labelIn / labelOut / labelCacheIn / labelTotalIn / labelApi /
  // labelApiCalls). apiMs renders via formatRemainingMs ("api:1m" dhms shape),
  // apiCalls via String(n) ("calls:N") — both honoring timeFormat knobs.
  let prefix: string;
  let body: string;
  // stripLabel → every prefix resolves to "" (bare number / dhms / count).
  const p = (axis: LabelAxis): string => strip ? "" : labelFor(axis);
  switch (field) {
    case "in": prefix = p("in"); body = formatCompactToken(n); break;
    case "out": prefix = p("out"); body = formatCompactToken(n); break;
    case "cached": prefix = p("cacheIn"); body = formatCompactToken(n); break;
    case "total": prefix = p("totalIn"); body = formatCompactToken(n); break;
    // apiMs → `api:<dhms>` mirroring m_apiMs (accApiMs is session-cumulative,
    // so the string grows monotonically: "api:5m", "api:1h12m").
    case "apiMs": prefix = p("apiMs"); body = formatRemainingMs(n); break;
    // apiCalls → `calls:N` mirroring m_apiCalls (count:0 still renders — zero
    // is a real count, not a "no data" signal).
    case "apiCalls": prefix = p("apiCalls"); body = String(n); break;
  }
  return `${prefix}${body}`;
}

// m_accTokenHitRate — session-aggregate hit rate. status-store
// pre-computes the ratio into TickStatusValue.accTokenHitRate at every setAvg
// scope; the module reads it straight. Colored via cacheHitColor (good ≥ 80%,
// warn ≥ 50%, bad < 50%). Zero-acc → "hit:0.0%"; missing slot →
// placeholderAcc. Shares the "hit:" prefix with m_tokenHitRate / m_sumTokenHitRate.

// m_acc* placeholder: "prefix:n/a" for plain fields, "prefix:n/a%" for
// hit-rate. Used when the chosen scope has no accumulator yet. `_scope` is
// unused (same placeholder regardless of scope) — kept as a future hook.
function placeholderAcc(
  field: "in" | "out" | "cached" | "total" | "apiMs" | "apiCalls" | "hitRate" | "startTime",
  _scope: "session" | "project" | "model",
  stripLabel?: boolean,
): string {
  // All prefixes route through labelFor (labels.label*). stripLabel → every
  // prefix collapses to "" so the placeholder reads "n/a" / "n/a%".
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
  // Missing slot → "prefixn/a" for plain fields, "prefixn/a%" for hit-rate,
  // wrapped in STALE_COLOR.
  let body: string;
  if (field === "hitRate") {
    body = `${prefix}n/a%`;
  } else {
    body = `${prefix}n/a`;
  }
  return `${STALE_COLOR}${body}${RESET}`;
}

// Build the m_memUsage body as a two-tone string. With |color|<c>, the whole
// "<prefix><used>/<total>" line wraps in that color (override always wins).
// Without color, the used chunk gets the band color via colorFor(pct, "used")
// (thresholds.percentBands) and prefix/total keep the module's default tint
// (cyan). Mode is pinned to "used" — a RAM display has no used/remaining
// semantics; the danger axis is always "how much RAM is spent".
function renderMemUsageBody(
  prefix: string,
  used: number,
  total: number,
  paramsColor: string | undefined,
): string {
  const usedStr = formatMemBytes(used);
  const totalStr = formatMemBytes(total);
  if (paramsColor) return `${paramsColor}${prefix}${usedStr}/${totalStr}${RESET}`;
  const pct = total > 0 ? (used / total) * 100 : 0;
  const usedColor = colorFor(pct, "used");
  const restColor = DEFAULT_COLORS.m_memUsage;
  const wrap = (s: string) => (restColor ? `${restColor}${s}${RESET}` : s);
  const prefixSpan = prefix ? wrap(prefix) : "";
  return `${prefixSpan}${usedColor}${usedStr}${RESET}/${wrap(totalStr)}`;
}

// Build the m_contextUsage body as a two-tone string, mirroring
// renderMemUsageBody but for context tokens. |color|<c> wraps the whole line;
// without color, the used chunk gets the band color (colorFor(pct, "used"))
// and prefix/total keep the module's default tint (blue). Mode pinned to
// "used" — an x/y occupancy display has no used/remaining semantics.
// NOTE: the pct "else 0" and wrap ": s" fallbacks are unreachable (callers
// pre-filter total <= 0 and the blue default is truthy); kept for diff-parity.
function renderContextUsageBody(
  prefix: string,
  used: number,
  total: number,
  paramsColor: string | undefined,
): string {
  const usedStr = formatCompactToken(used);
  const totalStr = formatCompactToken(total);
  if (paramsColor) return `${paramsColor}${prefix}${usedStr}/${totalStr}${RESET}`;
  const pct = total > 0 ? (used / total) * 100 : 0;
  const usedColor = colorFor(pct, "used");
  const restColor = DEFAULT_COLORS.m_contextUsage;
  const wrap = (s: string) => (restColor ? `${restColor}${s}${RESET}` : s);
  const prefixSpan = prefix ? wrap(prefix) : "";
  return `${prefixSpan}${usedColor}${usedStr}${RESET}/${wrap(totalStr)}`;
}

const MODULES: Record<string, Module> = {
  // Body routes on ctx.providerType: balance → the dedicated Balance label;
  // quota AND unknown → the display-mode label ("used"/"remaining") — an
  // unconfigured provider still wants "Usage:" when mode is "used". Returns
  // the label WITHOUT a trailing space (the separator token provides spacing).
  m_modeLabel: (c) => wrapPlainDefault("m_modeLabel",
    c.providerType === "balance"
      ? cfg().modeLabels.balance
      : cfg().modeLabels[c.mode],
    undefined),
  // Unified m_windowQuota gauge. Reads `c.intervals["short"]` (default term;
  // `|term|<key>` picks another — legacy short/mid/long or any declared key)
  // and projects it through `intervalToWindow`. Gauge is data-driven entirely
  // by the Interval's `pct` field (no hard-coded "5h"/"7d" labels).
m_windowQuota: Object.assign(
  ((c: RenderContext) => {
    const iv = (c.intervals ?? {})["short"] ?? null;
    if (!iv) return placeholderBare("m_windowQuota", c);
    const w = intervalToWindow(iv);
    if (!w) return placeholderBare("m_windowQuota", c);
    // |valueOnly|true strips the bar, showing just the colored percent.
    if (c.passThrough?.valueOnly === "true") return formatPercentOnly(w, c.mode);
    return formatOneChunk(w, c.mode, cfg().bar.width, c.stale);
  }),
  { type: "quota" as const },
),
  // Reset-suffix portion of the default-term interval. Label is read from the
  // live `Interval.label` (not hard-coded) so custom labels appear in the
  // placeholder and the stale+past-due "<arrow>n/a·<label>" body too.
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
  // Quota module. Reads the quota group from `c.intervals["short"]` (bare) or
  // the chosen `term` slot (inline). Renders `<labelQuota><axis>/<limit>`
  // (e.g. "quota: 123/500"), where `<axis>` is `used` by default and
  // `remaining` when `c.mode === "remaining"`. Placeholder is term-agnostic:
  // "quota: n/a".
m_quota: Object.assign(
  ((c: RenderContext) => {
    const iv = (c.intervals ?? {})["short"] ?? null;
    if (!iv) return placeholderBare("m_quota", c);
    const parts = renderQuotaParts(iv, c.mode);
    if (!parts) return placeholderBare("m_quota", c);
    return wrapQuotaBody(parts, c.mode, undefined, c.passThrough?.valueOnly === "true");
  }),
  { type: "quota" as const },
),
  // The DeepSeek balance chunk. When there's nothing to render, emit a
  // "balance:n/a" placeholder instead of dropping (bare-vs-inline parity).
  m_balance: Object.assign(
    ((c: RenderContext) => c.balance ? formatBalanceEntriesColored(c.balance) || placeholderBare("m_balance", c) : placeholderBare("m_balance", c)),
    { type: "balance" as const },
  ),
  // Stale-age annotation. When ageMs is missing, emit "age:n/a" placeholder
  // (:nulldrop|true restores the drop behavior).
  m_age: (c) => {
    if (c.ageMs == null) return placeholderBare("m_age", c);
    // Dedup against any m_age that already emitted anywhere in the recursive
    // render tree — the first instance claims the slot, later ones return null.
    if (c.ageEmittedRef?.value) return null;
    if (c.ageEmittedRef) c.ageEmittedRef.value = true;
    return formatStaleSuffix(c.ageMs, !c.stale);
  },
  // Plugin version. Empty version → "v:n/a" placeholder (was: drop).
  m_version: (c) => (c.version ? wrapPlainDefault("m_version", `v${c.version}`, undefined) : placeholderBare("m_version", c)),
  // Visual indicator of which side of the user-vs-builtin fence the active
  // provider's plugin was loaded from: built-in 📌, user override 🎨, or
  // missing ❗ (matched id has no plugin). Glyphs come from labels.* (config-
  // overridable). No default tint — the symbol carries the meaning. Unknown
  // source (no provider matched / no cache row) → null, so the template drops
  // it (no "source:n/a" noise). A 4th branch, "cc" / 🔖, is reserved for the
  // future claude-官方 case but not yet wired into the dispatch table.
  m_pluginSource: (c) => {
    if (c.pluginSource === "builtin") return labelFor("pluginSystem");
    if (c.pluginSource === "user")    return labelFor("pluginUserDefined");
    if (c.pluginSource === "missing") return labelFor("pluginMissing");
    return null;
  },
  // ----- token-usage modules -----
  // Each module is independent and returns null when its source data is
  // unavailable; the default plan / balance templates do NOT include any of
  // these (existing users see no change on upgrade).

  // Per-API-call input tokens: the delta of current.input vs the previous
  // tick's snapshot, but ONLY when an API call happened between ticks (the
  // same gate + prevTick cache as m_tokenInSpeed). No API call landed → the
  // live stdin number (or "in:0"), gray-wrapped as stale. For session-
  // cumulative totals see m_tokenInTotal / m_tokenTotalOut / m_tokenTotalIn.
  m_tokenIn: (c) => {
    const r = computeTickDelta(c, "in");
    // valueOnly strips the leading label from the pre-prefixed r.value.
    const body = stripLabelIfValueOnly(r.value, "in", c.passThrough?.valueOnly === "true");
    // Active tick → bare default tint (brightGreen) on positive value; idle
    // ticks (hasMeasurement=false) get STALE_COLOR even when stdin ships a
    // positive number ("live stdin, not a measured delta"). 0 and n/a stay plain.
    if (r.numeric == null || r.numeric === 0) return body;
    if (r.stale) return `${STALE_COLOR}${body}${RESET}`;
    return wrapValueDefault("m_tokenIn", r.numeric, body, undefined);
  },
  // Per-API-call output tokens (see m_tokenIn for the gate). Bare default
  // tint (red) on positive value; idle → STALE_COLOR. |valueOnly| strips label.
  m_tokenOut: (c) => {
    const r = computeTickDelta(c, "out");
    const body = stripLabelIfValueOnly(r.value, "out", c.passThrough?.valueOnly === "true");
    if (r.numeric == null || r.numeric === 0) return body;
    if (r.stale) return `${STALE_COLOR}${body}${RESET}`;
    return wrapValueDefault("m_tokenOut", r.numeric, body, undefined);
  },
  // Context occupancy = `context_window.total_input_tokens` (cumulative input
  // tokens currently in the window; the old m_ctx per-turn length semantic is
  // gone). Prefix "size:N"; capacity is a separate module (m_contextWindowSize).
  // Zero renders "size:0"; placeholder only when totals.tokenTotalIn is absent.
  m_contextSize: (c) => {
    // |valueOnly|true drops the "size:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("contextSize");
    const total = c.tokens?.totals?.tokenTotalIn;
    if (total == null) return placeholderBare("m_contextSize", c);
    return `${prefix}${formatCompactToken(total)}`;
  },
  // Per-turn hit rate: m_tokenCachedIn / m_tokenTotalIn =
  // current.cacheRead / totals.totalIn. (The session-aggregate formula is a
  // separate module: m_accTokenHitRate.) Colored via cacheHitColor (good ≥ 80%,
  // warn ≥ 50%, bad < 50%). Zero denominator → "hit:0.0%"; missing totals or
  // cacheRead → "hit:n/a" placeholder.
  m_tokenHitRate: (c) => {
    // |valueOnly|true drops the "hit:" prefix from every branch (cached
    // fallback, idle-stale, live, zero); otherwise prefix = labelFor("hitRate").
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("hitRate");
    const t = c.tokens;
    if (!t) return placeholderBare("m_tokenHitRate", c);
    const total = t.totals?.tokenTotalIn;
    const cacheRead = t.current?.tokenCachedIn;
    if (total == null || cacheRead == null) {
      // Field not shipped this tick → surface the cached lastActive:tokenHitRate
      // value STALE_COLORed instead of "hit:n/a" (R7 — the TTL gate is disabled,
      // cache is permanent last-known-good; an idle tick shows the last value).
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
    // "Active" coloring: the per-turn hit rate is only a fresh reading when the
    // API did work this tick (hasDelta=true, same signal as the tps siblings).
    // An idle tick's current.cacheRead is unchanged, so the rate is "from a
    // previous API call" — gray it, matching the tps convention.
    const r = getDeltaForRender();
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
  // This turn's cache-read input tokens (current_usage.cache_read_input_tokens,
  // per-turn snapshot). Zero reads render "cache:0"; null cacheRead on a present
  // snapshot → placeholder "cache:n/a". No `(XX%)` share suffix — m_tokenHitRate
  // renders the ratio; this module stays on the raw token count.
  m_tokenCachedIn: (c) => {
    // Bare form emits PLAIN text (matches the m_token* siblings; the user's
    // :color|<c> override still applies). cacheRead=null (field not shipped)
    // and a missing snapshot both render "cache:0" so the module always reads
    // "cache:N". Positive value gets the brown default tint; 0 stays plain.
    // |valueOnly|true drops the "cache:" prefix on every branch.
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
  // Per-turn token cost from current.* × the active model's price entry. No
  // entry for the active model → "cost:n/a" placeholder. Idle ticks mirror
  // m_tokenIn's "live but stale" pattern (STALE_COLOR-wrapped).
  m_tokenCost: (c) => {
    // Per-tick cost from the snapshot (computed at processTick time from stdin
    // deltas × tokenPrices — no render-time price resolution).
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("cost");
    const t = c.tokens;
    if (!t || !t.sessionId) return placeholderBare("m_tokenCost", c);
    const r = getDeltaForRender();
    const snapshotCost = r.cost;
    if (!snapshotCost) return placeholderBare("m_tokenCost", c);
    if (!r.hasMeasurement) {
      // Idle tick: stale-colored snapshot cost.
      return `${STALE_COLOR}${prefix}${formatCostDict(snapshotCost)}${RESET}`;
    }
    const cost = parseFloat(snapshotCost.value);
    return wrapValueDefault("m_tokenCost", cost, `${prefix}${formatCostDict(snapshotCost)}`, undefined);
  },
  // Per-API-call input speed: delta(current.input) / delta(totalApiDurationMs)
  // * 1000. The bare form (and `:color|scale`) applies the 5-band scale color
  // (faster = greener); `:color|<shortcut|SGR>` overrides with a single color.
  // computeTickSpeed switches the cached/idle case to STALE_COLOR regardless of
  // the caller's color — gray signals "inactive measurement".
  m_tokenInSpeed: (c) => {
    // Probe call discovers the tps, then a second call renders with the right
    // color (the second delta call is free — single producer per tick).
    const probe = computeTickSpeed(c, "in", STALE_COLOR);
    const color = probe.active
      ? speedScaleColor("in", probe.tps ?? 0)
      : STALE_COLOR; // unused — computeTickSpeed forces STALE
    const r = computeTickSpeed(c, "in", color);
    // |valueOnly|true strips the labelFor("inSpeed") literal from the
    // pre-prefixed output (it sits between the SGR opener and the value).
    if (c.passThrough?.valueOnly !== "true") return r.value;
    const lbl = labelFor("inSpeed");
    return r.value.includes(lbl) ? r.value.replace(lbl, "") : r.value;
  },
  // Per-API-call output speed (see m_tokenInSpeed for math + drop conditions).
  // |valueOnly|true strips the leading label.
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
  // The m_totalToken* family is REMOVED — use the m_acc* family (m_totalTokenIn
  // → m_accTokenIn, m_totalTokenOut → m_accTokenOut, m_totalTokenWithCacheIn →
  // m_accTokenCachedIn).
  //
  // Six accumulators read the three-layer accumulator (session / project /
  // model) via peekAcc. 0 renders as "0" (value-zero rule); the placeholder
  // fires only on the truly-missing case. Bare forms default to session; inline
  // `m_acc*|scope:<session|project|model>` overrides, and an outer m_template's
  // forwarded `scope` is honored too (inner-explicit wins).
  m_accTokenIn: (c) => {
    // Bare default tint (brightGreen) on positive accumulator value; we read
    // the same slot through peekAcc so the tint matches what gets rendered.
    const scope = passThroughScope(c);
    const useScope = scope ?? "session";
    const v = peekAcc(useScope, c);
    const n = v ? v.accTokenIn : 0;
    return wrapValueDefault("m_accTokenIn", n, accBody(c, "in", scope), undefined);
  },
  m_accTokenOut: (c) => {
    // Bare default tint (red) on positive value; see m_accTokenIn for the contract.
    const scope = passThroughScope(c);
    const useScope = scope ?? "session";
    const v = peekAcc(useScope, c);
    const n = v ? v.accTokenOut : 0;
    return wrapValueDefault("m_accTokenOut", n, accBody(c, "out", scope), undefined);
  },
  // Non-zero, non-null default tint (brown) on a positive slot; value=0 stays
  // plain; unreachable on the null placeholder branch (placeholderAcc already
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
    // accBody computes total as accTokenIn + accTokenCachedIn; mirror that here
    // for the wrap decision so the tint matches the rendered value.
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
  // Mirrors m_apiCalls (`calls:N`) but reads the scope's accApiCalls slot from
  // state.json (default scope session; |scope| to widen/narrow). value=0 still
  // renders `calls:0` (value-zero rule). Non-zero default tint: cyan.
  m_accApiCalls: (c) => {
    const scope = passThroughScope(c);
    const useScope = scope ?? "session";
    const v = peekAcc(useScope, c);
    const n = v ? v.accApiCalls : 0;
    return wrapValueDefault("m_accApiCalls", n, accBody(c, "apiCalls", scope), undefined);
  },
  // Accumulated token cost from peekAcc (each tick's cost frozen at processTick).
  // All prices zero (default) → "cost:n/a" placeholder. Scope via passThrough.
  m_accTokenCost: (c) => {
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("cost");
    const scope = passThroughScope(c);
    const useScope = scope ?? "session";
    const v = peekAcc(useScope, c);
    if (!v) return placeholderBare("m_accTokenCost", c);
    if (!v.costs || v.costs.length === 0) return placeholderBare("m_accTokenCost", c);
    // Sum all currencies' float values for wrapValueDefault's
    // "is this a positive number?" check (color banding).
    const total = v.costs.reduce((s, e) => s + parseFloat(e.value), 0);
    return wrapValueDefault("m_accTokenCost", total, `${prefix}${formatCostsArray(v.costs)}`, undefined);
  },
  // Session-cumulative throughput (accToken* / accApiMs * 1000) from the
  // chosen scope's accumulator. No color → 5-band scale (faster = greener);
  // |color|<c> → that color; unprimed scope → "direction:n/a". Default scope
  // session; probe+render picks the band color from the actual tps.
  m_accTokenInSpeed: (c) => {
    const scope = passThroughScope(c) ?? "session";
    const probe = computeAccSpeed(c, scope, "in", STALE_COLOR);
    const color = probe.active
      ? speedScaleColor("in", probe.tps ?? 0)
      : STALE_COLOR;
    const r = computeAccSpeed(c, scope, "in", color);
    // |valueOnly|true strips the leading label.
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
  // Session-aggregate hit rate (status-store pre-computes accTokenHitRate at
  // setAvg time). Colored via cacheHitColor. Renamed from m_accCacheHitRate.
  m_accTokenHitRate: (c) => {
    // |valueOnly|true drops the "hit:" prefix; else prefix = labelFor("hitRate").
    const stripLabel = c.passThrough?.valueOnly === "true";
    const useScope = passThroughScope(c) ?? "session";
    const v = peekAcc(useScope, c);
    if (!v) return placeholderAcc("hitRate", useScope, stripLabel);
    const pct = v.accTokenHitRate;
    const color = cacheHitColor(pct);
    const prefix = stripLabel ? "" : labelFor("hitRate");
    return `${color}${prefix}${pct.toFixed(cachePctPrecision())}%${RESET}`;
  },
  // Start of the tick statistics window: renders TickStatusValue.startAt at the
  // chosen scope as `<labelStartTime>HH:MM:SS`. startAt is first-write-stamped
  // by setAvg; a legacy state.json without startAt → "start:n/a" placeholder.
  // `abs` (via passThrough) widens the body to YYYY-MM-DD HH:MM:SS.
  m_accStartTime: (c) => {
    // |valueOnly|true drops the "start:" prefix.
    const stripLabel = c.passThrough?.valueOnly === "true";
    const useScope = passThroughScope(c) ?? "session";
    const v = peekAcc(useScope, c);
    const startAt = v?.startAt ?? null;
    if (startAt == null) return placeholderAcc("startTime", useScope, stripLabel);
    const abs = c.passThrough?.abs === "true";
    const prefix = stripLabel ? "" : labelFor("startTime");
    return `${prefix}${formatAbsTime(startAt, { abs })}`;
  },
  // Sum/avg cross-project scan. 5 plain sums + 3 ratios; defaults
  // |model|all + |window|all + |align|false (see parseWindowScope +
  // fetchSumAggregate; results cached under "stat:<model>:<window>:<align>"
  // with TTL=300s).
  m_sumTokenIn: (c) => {
    // Bare m_sum* reads passThrough from an outer m_template. Zero-row
    // aggregate → "in:n/a" placeholder; an empty filter (bad window key)
    // still drops. Bare default tint (brightGreen) on positive sum; 0 plain.
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumTokenIn", c);
    // |valueOnly|true drops the "in:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("in");
    return wrapValueDefault(
      "m_sumTokenIn",
      agg.sumIn,
      `${prefix}${formatCompactToken(agg.sumIn)}`,
      undefined,
    );
  },
  m_sumTokenOut: (c) => {
    // Reads c.passThrough; zero-row → placeholder. Bare default tint (red) on positive sum.
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumTokenOut", c);
    // |valueOnly|true drops the "out:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("out");
    return wrapValueDefault(
      "m_sumTokenOut",
      agg.sumOut,
      `${prefix}${formatCompactToken(agg.sumOut)}`,
      undefined,
    );
  },
  m_sumTokenCachedIn: (c) => {
    // Reads c.passThrough (outer m_template); zero-row → placeholder (was: drop)
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumTokenCachedIn", c);
    // |valueOnly|true drops the "cache:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("cacheIn");
    // Non-zero positive sums get the brown default tint; value=0 stays plain.
    return wrapValueDefault("m_sumTokenCachedIn", agg.sumCached, `${prefix}${formatCompactToken(agg.sumCached)}`, undefined);
  },
  m_sumTokenTotalIn: (c) => {
    // Reads c.passThrough (outer m_template); zero-row → placeholder.
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumTokenTotalIn", c);
    // |valueOnly|true drops the "total:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("totalIn");
    return wrapValueDefault("m_sumTokenTotalIn", agg.sumTotalIn, `${prefix}${formatCompactToken(agg.sumTotalIn)}`, undefined);
  },
  // Windowed token cost from sumIn/Out/Cached × the model's price entry.
  // No entry for the resolved model id (default) → placeholder.
  m_sumTokenCost: (c) => {
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumTokenCost", c);
    // Costs summed from JSONL samples at aggregateSamples time.
    if (!agg.costs || agg.costs.length === 0) return placeholderBare("m_sumTokenCost", c);
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("cost");
    const total = agg.costs.reduce((s, e) => s + parseFloat(e.value), 0);
    return wrapValueDefault("m_sumTokenCost", total, `${prefix}${formatCostsArray(agg.costs)}`, undefined);
  },
  // Periodic quota estimate: same price math as m_sumTokenCost but divided by
  // the aligned plan window's used% to project spent cost up to a full period —
  // est = cost / (alignedUsedPercent / 100). Fixed 2dp output ("$30.20").
  // Short-circuits on rows===0 or alignedUsedPercent null/0. Requires
  // alignActive=true (|window|<declared id>|align|true). Multi-currency costs
  // consolidate via exchange rates from config.tokenPrices.json.
  m_sumEstQuota: (c) => {
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumEstQuota", c);
    if (!agg.costs || agg.costs.length === 0) return placeholderBare("m_sumEstQuota", c);
    const pct = agg.alignedUsedPercent;
    if (pct == null) return placeholderBare("m_sumEstQuota", c);
    if (pct === 0) return placeholderBare("m_sumEstQuota", c);
    // Resolve target currency via exchange rates.
    const rates = cfg().exchangeRates;
    const baseCurrency = cfg().tokenPrices.default?.currency ?? "CNY";
    const providerId = c.currentProvider ?? null;
    const targetCurrency = resolveEstQuotaTargetCurrency(agg.costs, rates, baseCurrency, providerId);
    const single = convertCostsToCurrency(agg.costs, targetCurrency, rates, baseCurrency);
    if (!single) return placeholderBare("m_sumEstQuota", c);
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("est");
    const cost = parseFloat(single.value);
    const est = cost / (pct / 100);
    return wrapValueDefault("m_sumEstQuota", est, `${prefix}${formatEstCostWithCurrency(est, single.currency)}`, undefined);
  },
  m_sumApiMs: (c) => {
    // Reads c.passThrough (outer m_template); zero-row → placeholder.
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumApiMs", c);
    // |valueOnly|true drops the "api:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("apiMs");
    return wrapValueDefault("m_sumApiMs", agg.sumApiMs, `${prefix}${formatRemainingMs(agg.sumApiMs)}`, undefined);
  },
  // m_sumTokenHitRate replaces m_avgCacheHitRate — SUM-OF-CACHED-OVER-TOTAL,
  // NOT the per-turn m_tokenHitRate. Old m_avg* names REMOVED with no alias.
  m_sumTokenHitRate: (c) => {
    // Reads c.passThrough; zero-row → placeholder.
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    const denom = agg.sumIn + agg.sumCached;
    if (agg.rows === 0 || denom === 0) return placeholderBare("m_sumTokenHitRate", c);
    const pct = (agg.sumCached / denom) * 100;
    // |valueOnly|true drops the "hit:" prefix; else prefix = labelFor("hitRate").
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("hitRate");
    return `${cacheHitColor(pct)}${prefix}${pct.toFixed(cachePctPrecision())}%${RESET}`;
  },
  m_sumTokenInSpeed: (c) => {
    // Reads c.passThrough (outer m_template); zero-row → placeholder (was: drop)
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.sumApiMs === 0) return placeholderBare("m_sumTokenInSpeed", c);
    const tps = (agg.sumIn / agg.sumApiMs) * 1000;
    // 5-band scale color via speedScaleColor (faster → green, slower → red);
    // prefix via labelFor(labelInSpeed), default "in:".
    const color = speedScaleColor("in", tps);
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("inSpeed");
    return `${color}${prefix}${formatSpeed(tps)}${RESET}`;
  },
  m_sumTokenOutSpeed: (c) => {
    // Reads c.passThrough; zero-row → placeholder.
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.sumApiMs === 0) return placeholderBare("m_sumTokenOutSpeed", c);
    const tps = (agg.sumOut / agg.sumApiMs) * 1000;
    // Prefix via labelFor(labelOutSpeed), default "out:".
    const color = speedScaleColor("out", tps);
    // |valueOnly|true drops the "out:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("outSpeed");
    return `${color}${prefix}${formatSpeed(tps)}${RESET}`;
  },
  // Total count of API calls (rows with apiMs > 0) in the window. The value is
  // a COUNT, not a token, but shares the m_sum rendering path.
  m_sumApiCalls: (c) => {
    // Reads c.passThrough; zero-row → placeholder.
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.calls === 0) return placeholderBare("m_sumApiCalls", c);
    // |valueOnly|true drops the "calls:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("apiCalls");
    // Cyan default tint on positive counts.
    return wrapValueDefault("m_sumApiCalls", agg.calls, `${prefix}${agg.calls}`, undefined);
  },
  // Start of the tick statistics window across the filtered JSONL rows:
  // min(s.startAt) (legacy null-startAt rows filtered by the Number.isFinite
  // gate → "start:n/a"). With align=true AND a matched interval shipping
  // resetStartAt, surfaces the plan window's open instant (the authoritative
  // anchor; the empirical firstAt can drift — process restart at the tail,
  // JSONL rollover). align=false (default) keeps the empirical min; missing
  // resetStartAt → fall back to agg.firstAt.
  m_sumStartTime: (c) => {
    // |valueOnly|true drops the "start:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("startTime");
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumStartTime", c);
    const abs = c.passThrough?.abs === "true";
    // align=true + declared-windowId resolution → plan's resetStartAt anchor;
    // otherwise (align=false default, or dhms/"all") → empirical firstAt.
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
  // End of the tick statistics window across the filtered JSONL rows:
  // aggregates max(s.lastAt) — the "newest tick" in the window, the dual of
  // m_sumStartTime. Empty / all-legacy window → "end:n/a". With align=true AND
  // a matching Window that ships resetAt, surfaces the plan window's close
  // instant instead of the empirical max(s.lastAt).
  m_sumEndTime: (c) => {
    // |valueOnly|true drops the "end:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("endTime");
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderBare("m_sumEndTime", c);
    const abs = c.passThrough?.abs === "true";
    // align=true + declared-windowId resolution → plan's resetAt close instant;
    // otherwise → empirical max(s.lastAt) fallback.
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
  // Bare `m_quote` (no inline args): picks a quote from the hourly window and
  // renders it plain. Appends `--<author>` when the entry has one; sanitize +
  // 60-char-budget truncate apply (any over-cap entry is clipped + suffixed
  // with "..."). Opt-in — not in the default templates.
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

  // Session name (stdin.session_name); missing → "n/a" placeholder.
  m_session: (c) => c.tokens?.sessionName ? wrapPlainDefault("m_session", c.tokens.sessionName, undefined) : placeholderBare("m_session", c),
  // Model display name (stdin.model.display_name); missing → "n/a".
  m_model: (c) => c.tokens?.modelDisplayName ? wrapPlainDefault("m_model", c.tokens.modelDisplayName, undefined) : placeholderBare("m_model", c),
  // Active provider instance id (e.g. "minimax"). When unmatched but
  // ANTHROPIC_BASE_URL is set, extracts the hostname (protocol/port/sub-paths
  // stripped). Both absent → "n/a" placeholder.
  m_provider: (c) => {
    if (c.currentProvider) return wrapPlainDefault("m_provider", c.currentProvider, undefined);
    const raw = process.env.ANTHROPIC_BASE_URL;
    if (raw) {
      try { return wrapPlainDefault("m_provider", new URL(raw).hostname.toLowerCase(), undefined); }
      catch { /* invalid URL → fall through */ }
    }
    return placeholderBare("m_provider", c);
  },
  // Effort level (stdin.effort, already coerced to string); missing → "n/a".
  m_effort: (c) => c.tokens?.effort ? wrapPlainDefault("m_effort", c.tokens.effort, undefined) : placeholderBare("m_effort", c),
  // Repository identity (stdin.workspace.repo); no component → "n/a".
  m_repo: (c) => {
    const r = c.tokens?.repo;
    if (!r) return placeholderBare("m_repo", c);
    const parts = [r.host, r.owner, r.name].filter(
      (p): p is string => p != null && p.length > 0,
    );
    return parts.length > 0 ? wrapPlainDefault("m_repo", parts.join("/"), undefined) : placeholderBare("m_repo", c);
  },
  // Repo name only (stdin.workspace.repo.name); missing/empty → "n/a".
  m_gitName: (c) => {
    const n = c.tokens?.repo?.name;
    return n != null && n.length > 0 ? wrapPlainDefault("m_gitName", n, undefined) : placeholderBare("m_gitName", c);
  },
  // Current directory basename (stdin.cwd); missing or root → "n/a".
  m_dirName: (c) => {
    const n = c.tokens?.cwd ? path.basename(c.tokens.cwd) : "";
    return n.length > 0 ? wrapPlainDefault("m_dirName", n, undefined) : placeholderBare("m_dirName", c);
  },
  // Claude Code CLI version (stdin.version); missing → "n/a".
  m_ccVersion: (c) => c.tokens?.ccversion ? wrapPlainDefault("m_ccVersion", c.tokens.ccversion, undefined) : placeholderBare("m_ccVersion", c),
  // Current git branch; missing git info → "branch:n/a" placeholder.
  // |withStatus|<true|false> (default false): controls ONLY the status suffix
  // and its color — clean → "✅" brightGreen, dirty → "🟠" brown (same colors
  // as m_gitStatus); the branch body keeps its own color. Glyphs read
  // labels.labelGitClean / labelGitDirty (defaults "✅" / "🟠").
  m_branch: (c) => {
    const info = readGitInfo(c.tokens?.cwd);
    if (info?.branch == null) return placeholderBare("m_branch", c);
    const body = wrapPlainDefault("m_branch", info.branch, undefined);
    if (c.passThrough?.withStatus !== "true") return body;
    const suffixColor = info.dirty ? NAMED_PALETTE.brown : BRIGHT_GREEN;
    const glyph = info.dirty ? labelFor("gitDirty") : labelFor("gitClean");
    return `${body}${suffixColor}${glyph}${RESET}`;
  },
  // Git working-tree cleanliness indicator; missing git info → "git:n/a".
  m_gitStatus: (c) => {
    const info = readGitInfo(c.tokens?.cwd);
    if (info == null) return placeholderBare("m_gitStatus", c);
    const color = info.dirty ? NAMED_PALETTE.brown : BRIGHT_GREEN;
    return wrapPlainDefault("m_gitStatus", info.dirty ? "dirty" : "clean", color);
  },
  // Deprecated alias — see m_ccVersion above.
  m_ccversion: (c) => c.tokens?.ccversion ? wrapPlainDefault("m_ccversion", c.tokens.ccversion, undefined) : placeholderBare("m_ccversion", c),
  // Session elapsed wall-clock (stdin.cost.total_duration_ms); missing → "--".
  // 0 ms is a real value and renders as "0s".
  m_sessionDuration: (c) => {
    const ms = c.tokens?.cost.totalDurationMs;
    return ms != null ? wrapPlainDefault("m_sessionDuration", formatRemainingMs(ms), undefined) : placeholderBare("m_sessionDuration", c);
  },
  // Session API-call time (stdin.cost.total_api_duration_ms); missing → "--".
  m_sessionApiDuration: (c) => {
    const ms = c.tokens?.cost.totalApiDurationMs;
    return ms != null ? wrapPlainDefault("m_sessionApiDuration", formatRemainingMs(ms), undefined) : placeholderBare("m_sessionApiDuration", c);
  },
  // Per-turn delta of cost.totalApiDurationMs as a dhms string with the
  // labelApi prefix (default "api:"). Reuses the shared delta baseline (same
  // r.apiMs as m_tokenIn / m_tokenOut / m_tokenInSpeed). Gate: hasDelta
  // (deltaApi > 0). Idle ticks → cached "api:<dhms>" STALE_COLORed (R7 —
  // cache never expires); first tick assumes prev=0 (current_usage IS the
  // per-turn delta). No snapshot / no sessionId → placeholder.
  m_apiMs: (c) => {
    // |valueOnly|true drops the "api:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("apiMs");
    const t = c.tokens;
    if (!t || !t.sessionId) return placeholderBare("m_apiMs", c);
    const r = getDeltaForRender();
    if (!r.hasMeasurement) {
      // Idle tick → fall back to the last cached deltaApiMs, STALE_COLORed
      // (R7 — cache never expires); no prior measurement → placeholder.
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
    // Positive per-turn delta → brown default tint; 0 stays plain (STALE_COLOR
    // still wins on the cached/idle branch above).
    return wrapValueDefault("m_apiMs", r.apiMs, `${prefix}${formatRemainingMs(r.apiMs)}`, undefined);
  },
  // Session-cumulative lines added (stdin.cost.total_lines_added); missing →
  // "+--". Zero is a real value and renders as "+0".
  m_linesAdded: (c) => {
    const n = c.tokens?.cost.totalLinesAdded;
    return n != null ? wrapPlainDefault("m_linesAdded", `+${n}`, undefined) : placeholderBare("m_linesAdded", c);
  },
  // Session-cumulative lines removed; missing → "---".
  m_linesRemoved: (c) => {
    const n = c.tokens?.cost.totalLinesRemoved;
    return n != null ? wrapPlainDefault("m_linesRemoved", `-${n}`, undefined) : placeholderBare("m_linesRemoved", c);
  },
  // Session-cumulative input tokens (stdin.context_window.total_input_tokens);
  // null → "in:n/a". Bare default tint (brightGreen) on positive value; 0/n/a plain.
  m_tokenInTotal: (c) => {
    // |valueOnly|true drops the "in:" prefix.
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
  // Session-cumulative output tokens: `tokens.totals.tokenTotalOut` (=
  // stdin context_window.total_output_tokens), distinct from m_accTokenOut's
  // in-memory rollup. Null → "out:n/a". Bare default tint (red) on positive value.
  m_tokenTotalOut: (c) => {
    // |valueOnly|true drops the "out:" prefix.
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
  // Same source as m_tokenInTotal (stdin.context_window.total_input_tokens),
  // but in the `totalIn` family (labelTotalIn, alongside m_accTokenTotalIn /
  // m_sumTokenTotalIn). The two names let callers pick the label family.
  m_tokenTotalIn: (c) => {
    // |valueOnly|true drops the "total:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("totalIn");
    const n = c.tokens?.totals.tokenTotalIn;
    // Positive value → blue default tint; null → placeholder; 0 stays plain.
    if (n == null) return placeholderBare("m_tokenTotalIn", c);
    return wrapValueDefault(
      "m_tokenTotalIn",
      n,
      `${prefix}${formatCompactToken(n)}`,
      undefined,
    );
  },
  // Project-wide count of valid API calls since first tick. Missing cwd →
  // "calls:n/a"; calls=0 still renders "calls:0" (always-render design).
  m_apiCalls: (c) => {
    // |valueOnly|true drops the "calls:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("apiCalls");
    const cwd = c.tokens?.cwd;
    if (!cwd) return placeholderBare("m_apiCalls", c);
    const acc = statusStore.readAccumulator("project", { cwd });
    // Positive count → cyan default tint; "calls:0" stays plain (value-zero rule).
    if (!acc) return `${prefix}0`;
    return wrapValueDefault("m_apiCalls", acc.accApiCalls, `${prefix}${acc.accApiCalls}`, undefined);
  },
  // Capacity (upper bound) of the context window
  // (context_window.context_window_size; the `Widows` typo is preserved).
  // size=null → "size:n/a" placeholder.
  m_contextWindowSize: (c) => {
    // |valueOnly|true drops the "size:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("contextWindowSize");
    const sz = c.tokens?.contextWindow?.contextWindowSize;
    return sz != null
      ? wrapPlainDefault("m_contextWindowSize", `${prefix}${formatCompactToken(sz)}`, undefined)
      : placeholderBare("m_contextWindowSize", c);
  },
  // Context-window occupancy (context_window.used_percentage). null →
  // "n/a%" placeholder; zero renders as "0%".
  m_contextUsedPercent: (c) => {
    // |valueOnly|true drops the "used:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("contextUsedPercent");
    const pct = c.tokens?.contextWindow?.contextUsedPercent;
    return pct != null
      ? wrapPlainDefault("m_contextUsedPercent", `${prefix}${pct}%`, undefined)
      : placeholderBare("m_contextUsedPercent", c);
  },
  // The inverse of m_contextUsedPercent: the unused share of the context
  // window (context_window.remaining_percentage). Zero renders "0%"; null →
  // "remain:n/a%" placeholder.
  m_contextRemainingPercent: (c) => {
    // |valueOnly|true drops the "remain:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("contextRemainingPercent");
    const pct = c.tokens?.contextWindow?.contextRemainingPercent;
    return pct != null
      ? wrapPlainDefault("m_contextRemainingPercent", `${prefix}${pct}%`, undefined)
      : placeholderBare("m_contextRemainingPercent", c);
  },
  // Context-window bar + 5-band-colored percentage. Missing synthetic Window →
  // gray gauge placeholder; zero pct still renders as a 0-value bar.
  m_windowContext: (c) =>
    c.contextWindow
      ? (c.passThrough?.valueOnly === "true"
          ? formatPercentOnly(c.contextWindow, c.mode)
          : formatOneChunk(c.contextWindow, c.mode, cfg().bar.width, false))
      : placeholderBare("m_windowContext", c),
  // TTL gauge modules. Each computes remainingFraction = (ttlMs - ageMs) /
  // ttlMs, emits a TTL_BAR_CHARS glyph by fraction + a fixed-second suffix via
  // formatTtlSeconds (bypasses timeFormat.minUnit — the gauge is always
  // second-granular). Missing / no-ttlMs → placeholder (single ▆ in
  // STALE_COLOR, no suffix). m_cacheTtlStatus reads the ACTIVE provider's row
  // (keyed by ctx.currentProvider), NOT the cross-provider freshest — each
  // provider fetches on its own clock, so freshest would leak one provider's
  // freshness into another. The stat cache is process-shared and updated as a
  // whole, so its freshest helper is right for m_statTtlStatus.
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
  // m_sumTtlStatus: per-filter TTL gauge — shows the TTL of the EXACT
  // stat-cache row that parseWindowScope resolves for the active m_sum* filter
  // (model + window + align + term), not the freshest across keys. Same glyph
  // + color + fixed-second suffix as m_statTtlStatus; miss → placeholder.
  m_sumTtlStatus: (c) => {
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return placeholderBare("m_sumTtlStatus", c);
    const key = statusStore.statKeyForFilter(filter);
    const entry = statusStore.peekStatAgeMs(key);
    if (!entry || entry.ttlMs <= 0) return placeholderBare("m_sumTtlStatus", c);
    const remaining = (entry.ttlMs - entry.ageMs) / entry.ttlMs;
    const suffix = formatTtlSeconds(entry.ttlMs - entry.ageMs);
    return `${ttlStatusColor(remaining)}${ttlStatusChar(remaining)}${RESET} ${suffix}`;
  },
  // System RAM usage in ccstatusline's "Mem:15.9G/63.7G" shape. Query failure
  // → "Mem:n/a" STALE_COLORed. value=0 is impossible (os.totalmem > 0), so the
  // value-zero rule doesn't apply. Two-tone body built by renderMemUsageBody.
  m_memUsage: (c) => {
    // |valueOnly|true drops the "Mem:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("memUsage");
    const m = getMemUsage();
    if (!m) return placeholderBare("m_memUsage", c);
    return renderMemUsageBody(prefix, m.used, m.total, undefined);
  },
  // System RAM used bar + 5-band-colored percentage — the parallel of
  // m_windowContext. Reads getMemUsage() (vm_stat on Darwin, else os.*),
  // normalizes to a 0..100 ratio, wraps it in a synthetic Window, and emits
  // formatOneChunk (value color via colorFor(pct, "used")). NO label prefix —
  // pure bar+percent, matches m_windowContext. The m_total <= 0 guard is
  // defensive (a sandboxed test env could zero os.totalmem).
  m_windowMemUsage: (c) => {
    const m = getMemUsage();
    if (!m || m.total <= 0) return placeholderBare("m_windowMemUsage", c);
    const pct = (m.used / m.total) * 100;
    const w = { pct } as Window;
    // |valueOnly|true strips the bar, showing just the colored percent.
    if (c.passThrough?.valueOnly === "true") return formatPercentOnly(w, c.mode);
    return formatOneChunk(w, c.mode, cfg().bar.width, false);
  },
  // System RAM used bytes, "used:X.XG" (getMemUsage()).
  m_memUsed: (c) => {
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("memUsed");
    const m = getMemUsage();
    if (!m) return placeholderBare("m_memUsed", c);
    return wrapPlainDefault(
      "m_memUsed",
      `${prefix}${formatMemBytes(m.used)}`,
      undefined,
    );
  },
  // System RAM total bytes, "total:X.XG".
  m_memTotal: (c) => {
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("memTotal");
    const m = getMemUsage();
    if (!m) return placeholderBare("m_memTotal", c);
    return wrapPlainDefault(
      "m_memTotal",
      `${prefix}${formatMemBytes(m.total)}`,
      undefined,
    );
  },
  // Context-window usage x/y (used = totals.tokenTotalIn, capacity =
  // contextWindowSize), formatCompactToken on both sides, two-tone body built
  // by renderContextUsageBody. value=0 renders "0"; missing used/capacity →
  // "ctx:n/a" placeholder.
  m_contextUsage: (c) => {
    // |valueOnly|true drops the "ctx:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("contextUsage");
    const used = c.tokens?.totals?.tokenTotalIn;
    const total = c.tokens?.contextWindow?.contextWindowSize;
    if (used == null || total == null || total <= 0) return placeholderBare("m_contextUsage", c);
    return renderContextUsageBody(prefix, used, total, undefined);
  },
};

// Cap unknown-module warnings to once per process so a template typo doesn't
// spam stderr on every statusline tick.
let _unknownModuleWarned = false;

// ----- token-module helpers -----

// Compact token formatter: below thresholds[0] → raw integer, below
// thresholds[1] → "<x.y>k", else "<x.y>M" (token-specific thresholds,
// default 1k / 1M). Negative / non-finite → "0". Exported for tests.
export function formatCompactToken(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  const t = cfg().tokenFormat;
  const [lo, hi] = t.thresholds;
  if (n < lo) return String(Math.floor(n));
  if (n < hi) return `${(n / 1_000).toFixed(t.precision)}k`;
  return `${(n / 1_000_000).toFixed(t.precision)}M`;
}

// Speed formatter: tokens/s shown as "/s" with k suffix above 1000. Mirrors ccstatusline.s
// formatSpeed. Null → "—". Exported for tests.
export function formatSpeed(tps: number | null): string {
  if (tps == null || !Number.isFinite(tps)) return "—";
  const precision = cfg().tokenFormat.speedPrecision;
  if (Math.abs(tps) >= 1000) {
    return `${(tps / 1000).toFixed(precision)}k/s`;
  }
  return `${tps.toFixed(precision)}/s`;
}

// Tiered-precision cost formatter for the m_tokenCost family: < 0.01 → 5dp,
// < 0.1 → 4dp, < 1 → 3dp, >= 1 → 2dp. Non-finite / negative → "0.00".
// Currency-agnostic; formatCostWithCurrency attaches the prefix.
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

// Currency-aware cost formatter: formatCost produces the digits, this attaches
// the per-model currency symbol (always via currencySymbol — e.g. "$0.0012").
function formatCostWithCurrency(cost: number, currency: string): string {
  return `${currencySymbol(currency)}${formatCost(cost)}`;
}

// Fixed-2dp cost formatter for m_sumEstQuota — the estimate lives at a much
// larger magnitude than per-call cost, so always-2dp matches the "保留2位小数"
// contract and keeps the render stable across a window. Non-finite / negative
// → "0.00".
function formatEstCost(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0.00";
  return n.toFixed(2);
}

// Currency-aware wrapper for the periodic quota estimate (same symbol rule as
// formatCostWithCurrency, so cost and est share the prefix shape).
function formatEstCostWithCurrency(cost: number, currency: string): string {
  return `${currencySymbol(currency)}${formatEstCost(cost)}`;
}

// Format a single cost dict {currency, value} using currencySymbol for the
// display prefix.
function formatCostDict(cost: { currency: string; value: string }): string {
  return formatCostWithCurrency(parseFloat(cost.value), cost.currency);
}

// Format a costs array as comma+space-separated entries, each with its own
// currency symbol. Empty array → "n/a" for the caller's placeholder path.
// Single-currency renders identically to formatCostDict (no trailing comma).
function formatCostsArray(costs: Array<{ currency: string; value: string }>): string {
  return costs.map((c) => formatCostDict(c)).join(", ");
}

// Convert a value from one currency to another via exchange rates. Rates map:
// currency → rate (1 baseCurrency = rate currency). Cross-currency pairs go
// through the base (typically CNY). Missing rate → 1:1 fallback (no conversion).
function convertCurrency(
  value: number,
  fromCurrency: string,
  toCurrency: string,
  rates: Record<string, number>,
  baseCurrency: string,
): number {
  if (fromCurrency === toCurrency) return value;
  if (!Number.isFinite(value) || value <= 0) return 0;
  // Step 1: fromCurrency → baseCurrency
  let inBase: number;
  if (fromCurrency === baseCurrency) {
    inBase = value;
  } else {
    const rate = rates[fromCurrency];
    inBase = rate != null && rate > 0 ? value / rate : value;
  }
  // Step 2: baseCurrency → toCurrency
  if (toCurrency === baseCurrency) return inBase;
  const rate = rates[toCurrency];
  return rate != null && rate > 0 ? inBase * rate : inBase;
}

// Resolve m_sumEstQuota's target currency: provider CURRENCY[0] if set; else
// the currency whose baseCurrency-converted value is largest. Falls back to
// costs[0].currency when single-currency or no rates.
function resolveEstQuotaTargetCurrency(
  costs: Array<{ currency: string; value: string }>,
  rates: Record<string, number>,
  baseCurrency: string,
  providerId: string | null,
): string {
  if (costs.length <= 1) return costs[0]?.currency ?? baseCurrency;
  // Rule 1: Provider has CURRENCY field — use first entry
  if (providerId) {
    const entry = (cfg().providers[providerId] as Record<string, unknown> | undefined);
    const currencyFilter = entry?.CURRENCY as string[] | undefined;
    if (currencyFilter && currencyFilter.length > 0) {
      return currencyFilter[0];
    }
  }
  // Rule 2: No CURRENCY → convert each cost to baseCurrency, pick the
  // original currency whose baseCurrency-equivalent is largest.
  let bestCurrency = costs[0].currency;
  let bestValue = -1;
  for (const c of costs) {
    const val = parseFloat(c.value);
    if (!Number.isFinite(val) || val <= 0) continue;
    const inBase = convertCurrency(val, c.currency, baseCurrency, rates, baseCurrency);
    if (inBase > bestValue) {
      bestValue = inBase;
      bestCurrency = c.currency;
    }
  }
  return bestCurrency;
}

// Convert a multi-currency costs array to a single target currency (sums each
// after conversion). Returns null when costs is empty.
function convertCostsToCurrency(
  costs: Array<{ currency: string; value: string }>,
  targetCurrency: string,
  rates: Record<string, number>,
  baseCurrency: string,
): { currency: string; value: string } | null {
  if (costs.length === 0) return null;
  if (costs.length === 1 && costs[0].currency === targetCurrency) {
    return costs[0];
  }
  let total = 0;
  for (const c of costs) {
    const val = parseFloat(c.value);
    if (!Number.isFinite(val)) continue;
    total += convertCurrency(val, c.currency, targetCurrency, rates, baseCurrency);
  }
  return { currency: targetCurrency, value: total.toFixed(10) };
}

// 5-band speed-scale color: faster = greener, slower = redder (bright green /
// dark green / yellow / orange / red, indexed from the FAST end). `in` uses 5×
// the `out` thresholds (out: [10,20,40,80], in: [50,100,200,400]) — input runs
// hotter. Bands are config-driven (cfg().tokenFormat.speedScaleBands).
// Returns an SGR string; the caller adds RESET.
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

// 8-char TTL gauge palette. Index 0 = full TTL, index 7 = empty. Picked by
// remainingFraction ∈ [0,1] via `floor((1 - fraction) * 8)` so the visual
// matches a "filling up" bar (top char at max TTL, bottom at zero).
const TTL_BAR_CHARS = ["█", "▇", "▆", "▅", "▄", "▃", "▂", "▁"] as const;

function ttlStatusChar(remainingFraction: number): string {
  if (!Number.isFinite(remainingFraction) || remainingFraction <= 0) return TTL_BAR_CHARS[7]!;
  if (remainingFraction >= 1) return TTL_BAR_CHARS[0]!;
  const idx = Math.min(7, Math.floor((1 - remainingFraction) * 8));
  return TTL_BAR_CHARS[idx]!;
}

// 5-band palette matching speedScaleColor's vocabulary (reuses cfg().colors.*).
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

// Parse a human duration string into ms. Supports "all" (sentinel) and any
// chain of `<digits><unit>` (d/h/m/s), accumulated in canonical order
// regardless of input order ("1m2h" == "2h1m"). Returns null on malformed
// input (no digits, bad unit, trailing junk).
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
  // Trailing junk (e.g. "5hz") is a parse-fail — the whole string must
  // consist of digit/unit pairs.
  if (matched !== raw.length) return null;
  return ms;
}

// Effective (windowKey, sinceMs, interval, alignActive, modelFilter) for a
// sum/avg scan.
//   windowKey — cache key segment: "all" sentinel, a declared
//     interval.windowId (only when align=true resolves through it), or a
//     free-form dhms string. Each unique key mints its own stat cache entry
//     under `stat:<modelFilter>:<windowKey>:<alignActive>`.
//   sinceMs — wall-clock anchor for the JSONL scan (rows with `at < sinceMs`
//     are filtered out). The plan window's open instant when align-active, else
//     ctx.nowMs - dhms, else 0 for "all".
//   interval — the matched Interval when alignActive (for m_sumStartTime /
//     m_sumEndTime's plan-anchor; NOT part of the cache key).
//   alignActive — true iff resolved through the declared windowId branch
//     (required for the plan-anchor rendering path).
//   modelFilter — undefined (all), "active" (current model), or a literal name.
//   providerBaseUrl — normalized ANTHROPIC_BASE_URL (default provider filter).
type SumFilter = {
  windowKey: string;
  sinceMs: number;
  interval: Interval | null;
  alignActive: boolean;
  modelFilter?: string;
  providerBaseUrl?: string;
};

// Look up the first Interval in the open-ended `intervals` dict declaring a
// given windowId. Used by parseWindowScope's `|window|<declaredWindowId>` path
// (e.g. `|window|monthly` against intervals.monthly.windowId) so a user can
// write `|window|monthly|align|true` for a plan-aligned scan.
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
  // Default provider filter: when a provider is configured (ctx.providerBaseUrl
  // set), always filter JSONL rows by the normalized ANTHROPIC_BASE_URL. No
  // user-facing `provider` inline arg yet; this is a fixed default.
  const providerBaseUrl = ctx.providerBaseUrl;
  const hasProvider = providerBaseUrl !== undefined && providerBaseUrl !== "";

  // Resolve model first — shared across every branch below.
  const modelRaw = (params.model as string | undefined) ?? "all";
  let modelFilter: string | undefined;
  if (modelRaw === "all") {
    modelFilter = undefined;
  } else if (modelRaw === "active") {
    // Active-model id (stdin.model.id; renamed from modelDisplayName so the
    // JSONL row filter matches the new sample.model stamp).
    modelFilter = ctx.tokens?.modelId ?? undefined;
  } else {
    modelFilter = modelRaw;
  }

  // `|term|<key>` for the m_sum* family: looks up `ctx.intervals[term]` and,
  // on a hit, runs a plan-aligned scan from the interval's `startAt` with the
  // interval stamped on the filter (so getStatAggregate populates
  // alignedUsedPercent and m_sumEstQuota gets a usable estimate). It's a
  // convenience alias for `|window|<intervals[term].windowId>|align|true`;
  // model is orthogonal. Missing interval / no usable startAt+endAt falls
  // through to the window/align/dhms logic below.
  const termRaw = params.term;
  if (typeof termRaw === "string" && termRaw !== "all") {
    const iv = intervalForTerm(termRaw, ctx);
    if (iv != null) {
      const w = intervalToWindow(iv);
      if (
        w != null &&
        typeof w.resetStartAt === "string" &&
        typeof w.resetDurationMs === "number" &&
        w.resetDurationMs > 0
      ) {
        const anchorMs = Date.parse(w.resetStartAt);
        if (Number.isFinite(anchorMs)) {
          return {
            // windowKey resolves to intervals[term].windowId (fallback: the term
            // key literal), so |term:short| and |window:5h|align:true| share one
            // stat cache entry.
            windowKey: iv.windowId || termRaw,
            sinceMs: anchorMs,
            interval: iv,
            alignActive: true,
            modelFilter,
            ...(hasProvider ? { providerBaseUrl } : {}),
          };
        }
      }
    }
  }

  // Bare form defaults to "all" (no time anchor — reads the whole cross-project
  // JSONL). `|window|<dhms>` opts into a time-bounded scan; `|window|<declaredId>`
  // needs `|align|true` for a plan-anchored scan. The literal "all" is RESERVED
  // as the no-time-anchor sentinel and short-circuits before any windowId
  // lookup, so users cannot name an interval `windowId: "all"`.
  const windowRaw = (params.window as string | undefined) ?? "all";

  // align defaults to false (explicit opt-in, like |abs| / |nulldrop|).
  const alignRaw = (params.align as string | undefined) ?? "false";
  const alignWanted = alignRaw === "true";

  // "all" sentinel: short-circuit before any windowId check so the reserved id
  // can never collide with a declared interval.windowId (scan since epoch).
  if (windowRaw === "all") {
    return {
      windowKey: "all",
      sinceMs: 0,
      interval: null,
      alignActive: false,
      modelFilter,
      ...(hasProvider ? { providerBaseUrl } : {}),
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
            ...(hasProvider ? { providerBaseUrl } : {}),
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
      ...(hasProvider ? { providerBaseUrl } : {}),
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

// resetStartAt is an ISO string (src/types.ts Window.resetStartAt); parse it
// with Date.parse and gate on Number.isFinite so a bad string falls back to
// wall-clock instead of NaN-poisoning the scan.
type StatAggregate = statusStore.StatAggregate;

function fetchSumAggregate(filter: SumFilter): StatAggregate {
  return statusStore.getStatAggregate(filter);
}


function warnUnknownModuleOnce(name: string): void {
  if (_unknownModuleWarned) return;
  _unknownModuleWarned = true;
  process.stderr.write(`creditgauge: unknown lineTemplate module '${name}'; ignoring\n`);
}

// Reset the once-per-process warn flag. Exported so tests can clear
// it between cases and observe the warning on demand.
export function __resetUnknownModuleWarnForTest(): void {
  _unknownModuleWarned = false;
}

// ----- inline-args tokens -----
//
// Inline forms take `|`-delimited params (see parseInlineArgs for the current
// two-class grammar). The bare `<prefix>` form (no inline args) routes through
// MODULES as before, so existing templates keep working byte-for-byte.

// Named SGR constants for per-module default colors (256-color, not
// theme-driven) — visually distinct from each other and from the 5-band
// palette so defaults read as "this module's natural tint".
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

// DEFAULT_COLORS maps each non-numeric m_* module to its default tint. Numeric
// modules (5-band / speed-scale / gauge / cache-hit) keep their own color
// logic and are NOT here. Used as a fallback when `params.color` is empty, so
// bare-form modules always show some color; `|color|<c>` overrides as before.
const DEFAULT_COLORS: Record<string, string> = {
  // String-class identifiers / metadata
  m_session: NAMED_PALETTE.purple,
  m_model: configStore.get().colors.orange,
  m_provider: configStore.get().colors.yellow,
  m_effort: NAMED_PALETTE.magenta,
  m_repo: NAMED_PALETTE.blue,
  m_gitName: NAMED_PALETTE.purple,
  m_dirName: NAMED_PALETTE.purple,
  m_branch: NAMED_PALETTE.teal,
  // m_gitStatus is NOT in DEFAULT_COLORS — its color is value-dependent
  // (dirty → brown, clean → bright green) and set inline in the render
  // paths below.
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
  // m_apiMs / m_accApiMs / m_sumApiMs share brown on positive values; 0 plain,
  // null → STALE_COLORed placeholder. ("api:" prefix is hardcoded, not a labels axis.)
  m_apiMs: NAMED_PALETTE.brown,
  m_accApiMs: NAMED_PALETTE.brown,
  m_sumApiMs: NAMED_PALETTE.brown,
  m_linesAdded: "\x1b[1;38;5;22m",   // bold + dark green (muted git-style added)
  m_linesRemoved: "\x1b[1;38;5;88m", // bold + dim red (muted git-style removed)
  // The calls-count modules (m_apiCalls / m_accApiCalls / m_sumApiCalls) share
  // cyan on positive values; "calls:0" stays plain.
  m_apiCalls: NAMED_PALETTE.cyan,
  m_accApiCalls: NAMED_PALETTE.cyan,
  m_sumApiCalls: NAMED_PALETTE.cyan,
  // m_tokenIn / m_tokenOut family tint reuses the 5-band palette (brightGreen =
  // 0% band, red = 80% band) so threshold-color customizations flow through.
  // Resolved from configStore at module load; helpers honoring a runtime
  // colors.* override call resolveTokenFlowColor() instead.
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
  m_contextWindowSize: NAMED_PALETTE.gray,
  m_contextUsedPercent: NAMED_PALETTE.gray,
  m_contextRemainingPercent: NAMED_PALETTE.gray,
  // Start/end of the tick statistics window — gray "neutral data" (labels
  // labelStartTime / labelEndTime control the "start:" / "end:" prefixes).
  m_accStartTime: NAMED_PALETTE.gray,
  m_sumStartTime: NAMED_PALETTE.gray,
  m_sumEndTime: NAMED_PALETTE.gray,
  // Non-zero, non-null default tint family: brown = cache-token hue, blue =
  // total-input hue. m_accTokenHitRate is governed by cacheHitColor (this
  // entry is moot for the value but keeps the dispatcher/inline path happy).
  m_tokenCachedIn: NAMED_PALETTE.brown,
  m_tokenTotalIn: NAMED_PALETTE.blue,
  m_accTokenCachedIn: NAMED_PALETTE.brown,
  m_accTokenTotalIn: NAMED_PALETTE.blue,
  m_sumTokenCachedIn: NAMED_PALETTE.brown,
  m_sumTokenTotalIn: NAMED_PALETTE.blue,
  m_accTokenHitRate: NAMED_PALETTE.stale,
  // System RAM usage — cyan matches ccstatusline's "Mem:..." hue for migrating users.
  m_memUsage: NAMED_PALETTE.cyan,
  m_memUsed: NAMED_PALETTE.cyan,
  m_memTotal: NAMED_PALETTE.cyan,
  // m_contextUsage — blue rest color (prefix + total); the used chunk is
  // band-colored internally by renderContextUsageBody.
  m_contextUsage: NAMED_PALETTE.blue,
  // m_windowMemUsage — moot for the value tint (colorFor(pct, "used")), kept
  // so the dispatcher doesn't warn on bare-form paths that index DEFAULT_COLORS.
  m_windowMemUsage: NAMED_PALETTE.cyan,
  // Cost modules — gold/yellow (monetary values sit in the yellow/orange
  // family, distinct from the token-flow hues).
  m_tokenCost: configStore.get().colors.yellow,
  m_accTokenCost: configStore.get().colors.yellow,
  m_sumTokenCost: configStore.get().colors.yellow,
  m_sumEstQuota: configStore.get().colors.yellow,
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
    // Additional named shortcuts via `:color|<name>` — duplicated from
    // NAMED_PALETTE so resolveColor doesn't scan that table separately.
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

// Pure resolver for `<colorvalue>`. Accepts shortcut names and raw SGR
// strings (`\x1b[…m`); returns null on anything else so the caller can
// warn + soft-fallback to plain text. The SPECIAL set (rainbow /
// rand-rainbow / hue) is NOT resolved here — those need per-text processing
// (buildRainbow / buildHue from src/quotes.ts), handled by `applyColor`.
//
// `:color|scale` resolves to the SCALE_COLOR_SENTINEL; speed-module renderers
// (m_tokenInSpeed / m_tokenOutSpeed) detect it and substitute the per-band
// scale color via speedScaleColor(). Other modules never see it (their
// schemas accept no custom palette), so a swallowed value just renders
// uncolored.
const SCALE_COLOR_SENTINEL = "__SCALE__";

function resolveColor(value: string): string | null {
  if (value === "scale") return SCALE_COLOR_SENTINEL;
  if (LABEL_COLOR_SHORTCUTS[value]) return LABEL_COLOR_SHORTCUTS[value];
  if (/^\x1b\[[0-9;]*m$/.test(value)) return value;
  return null;
}

// Tagged result for the higher-level `resolveColorParam` (used by m_quote and
// future rainbow/hue modules). Not the INLINE_SCHEMAS `ParamResolver` return
// type (`ResolvedValue | null`) — the m_quote `color` resolver string-tags
// instead, and the renderer recognizes the 3 magic strings as
// "apply buildRainbow / buildHue".
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

// Apply a resolved ColorParam to a plain-text body (m_quote and future
// full-color-grammar modules). Safe ONLY for plain-text bodies. `seed` ties
// rainbow/hue color to a frequency window (same window → same color); pass 0
// when per-window stability isn't needed.
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

// Encode a ColorParam as a string so it round-trips through the generic
// `params.color: string` channel (decoded by decodeColorParam).
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
// semantically invalid" (e.g. m_label with an empty string, an
// s_<name> alias that isn't recognized). The dispatcher warns once on
// this; a plain null is treated as "no data to show" (silent drop, same
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

// Every module accepts an optional `|color|<c>` override. For plain-text
// modules it's a simple wrap; for modules that already apply a band-based /
// single-color SGR the override REPLACES the natural color — the user's color
// always wins (per spec: "如果与现有颜色方案冲突，则无视该参数").
const COLOR_PARAM = {
  named: {
    color: (raw: string) => resolveColor(raw),
  },
} as const;

// Per-module null-drop override ("true"/"false" verbatim; anything else is a
// parse-fail and the token drops). nulldrop omitted / "false" → FORCE the
// placeholder when data is missing (module always renders, layout stable);
// nulldrop:"true" → opt out ("drop on null", adjacent separators skipped). The
// bare MODULES path keeps the original drop-on-null semantics; users wanting
// the old drop add `:nulldrop|true`.
//
// Placeholder shapes (see PLACEHOLDERS): pure-number → "n/a" ("in:n/a");
// number+unit → "-- <unit>" ("5h:--"); gauge → gray "░░░░ 0%"; bare-string →
// "n/a". All STALE_COLOR-wrapped.
// m_quote `wrap` param — a 2-char pair (left/right) rather than a bool.
// Empty/missing = no-op; one printable char duplicates to a pair (`wrap=~` →
// `~~`); 2+ chars take the first two. Non-printable (control / non-ASCII / DEL)
// is badarg. Applies to BOTH local and address-mode; the pair rides through
// applyColor so wrap chars inherit the body's tint.
const QUOTE_WRAP_CHARS_PARAM = {
  named: {
    wrap: (raw: string): ResolvedValue | null => {
      // Empty = no-op sentinel (defined-but-empty; the renderer reads it as
      // "skip wrapping"). Caller distinguishes empty from missing by length.
      if (raw === "") return raw;
      // Take the first two characters; a single char duplicates (wrap=~ ≡ ~~).
      let pair: string;
      if (raw.length === 1) {
        pair = raw + raw;
      } else if (raw.length >= 2) {
        pair = raw.slice(0, 2);
      } else {
        return null;
      }
      // Both must be printable ASCII (0x21..0x7E); anything else is badarg.
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

// Separator `repeat` parameter — multiplies the body N times (`s_space|repeat|3`
// → "   "). Capped at 8 to keep runaway configs from blowing up the statusline
// width; default 1. Out-of-range (non-integer, < 1, > 8) is a badarg.
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

// Separator `wrap` parameter (default `both`). Pads a NON-control body with one
// space on the named side(s): `left` → " ·", `right` → "· ", `both` → " · ",
// `none` → "·". Legacy `true`/`false` remain accepted as aliases for `both`/
// `none` (normalized so the formatter only sees the four modes). Pure
// whitespace/control bodies (s_space, s_tab, s_newline) are returned as-is
// under every mode — wrapping would create multi-space runs or double-newline.
const WRAP_PARAM = {
  named: {
    wrap: (raw: string): ResolvedValue | null => {
      switch (raw) {
        case "left":
        case "right":
        case "both":
        case "none":
          return raw;
        case "true":
          return "both"; // legacy alias
        case "false":
          return "none"; // legacy alias
        default:
          return null;
      }
    },
  },
} as const;

// `s_move|pos:<n>|char:<c>` pads the current line with `<c>` until the cursor
// reaches column `pos` (defaults pos=0, char=" "). Cursor already at/past pos →
// no-op + warn ("误操作" spec — moving left/steady is meaningless). `pos` MUST
// be present (bare s_move is a badarg). pos: non-negative integer capped at
// 999; char: a single non-control printable char (empty = "move without
// emitting" sentinel — the cursor still advances); multi-char is a badarg.
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
// under ANY wrap mode) or "printable" (pad with 1 space on the
// named side(s)). Pure: only inspects the body's own characters.
// Used by the s_ renderer's wrap step.
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
// the wrap mode. Repeat=0 is rejected upstream by the resolver
// (returns null), so this layer can assume n >= 1. wrap is one of
// `left` | `right` | `both` | `none` — WRAP_PARAM already
// normalizes the legacy `true`/`false` aliases, so only the four
// canonical modes reach here. A NON-control body pads with 1
// space on the named side(s); `none` and control/whitespace
// bodies return the body as-is.
function formatSepBody(body: string, repeat: string, wrap: string): string {
  const n = Number(repeat);
  const control = isControlBody(body);
  let inner: string;
  if (wrap === "none" || control) {
    inner = body;
  } else if (wrap === "left") {
    inner = ` ${body}`;
  } else if (wrap === "right") {
    inner = `${body} `;
  } else {
    inner = ` ${body} `; // "both" (default; catch-all fallback)
  }
  let out = "";
  for (let i = 0; i < n; i++) out += inner;
  return out;
}

// Three-layer accumulator scope selector (m_acc*): "session" (default),
// "project", or "model". Anything else is a parse-fail → token dropped. The
// removed "ccsession" is rejected as badarg by resolveAccScope/passThroughScope.
// The model scope is a no-op when the live snapshot has no modelId (placeholder
// fires); the project scope reads the project-wide slot (null until a tick
// accumulates).
const SCOPE_PARAM = {
  named: {
    scope: (raw: string): ResolvedValue | null =>
      raw === "session" || raw === "project" || raw === "model" ? raw : null,
  },
} as const;

// sum/avg inline args:
//   :model|<active|name|all> — narrow the JSONL scan to one model identity
//     ("active" = the current model; default "all" = every row, no filtering).
//   :window|<dhms|all> — the time window to scan (any parseDhms chain like
//     "5h"/"7d", or "all" = no time filter; default "all").
//   :align|<true|false> — true resolves `|window|<key>` against a declared
//     interval.windowId and scans the plan-aligned window [resetStartAt, +
//     duration] instead of the wall-clock [now - windowMs, now]. Without align
//     the wall-clock window can read under 100% even at full quota (we miss the
//     recent refill). Default false.
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

// `:align|<true|false>` gates the plan-anchored scan vs the dhms wall-clock
// path on m_sum*. Accepts only literal true/false (typos fail loud). Default
// false — a bare m_sum* or |window|<dhms> reads wall-clock. |align|true opts
// into the plan-anchored path: with |window|<declaredId> the scan anchors to
// that Interval's resetStartAt; with an unparseable window it falls through to
// dhms if parseable, else drops. With align=false the windowId branch is
// skipped entirely. See parseWindowScope for the full resolution tree.
const ALIGN_PARAM = {
  named: {
    align: (raw: string): ResolvedValue | null =>
      raw === "true" || raw === "false" ? raw : null,
  },
} as const;

// Interval-term selector for m_windowQuota / m_countdown / m_quota. The
// `intervals` dict is open-ended, so `term` accepts any non-empty string (bare
// form defaults to "short"). "all" is reserved by parseWindowScope's sentinel
// and rejected here so a typo fails loud. For the m_sum* family, `term` also
// resolves to intervals[term].windowId in the cache key, so |term:short| and
// |window:5h|align:true| share one cache entry (fallback: the term literal).
const TERM_PARAM = {
  named: {
    term: (raw: string): ResolvedValue | null => {
      if (raw === "all") return null;
      if (raw.trim() === "") return null;
      return raw;
    },
  },
} as const;

// Per-module display-mode override for the window modules. Accepts "used" or
// "remaining" verbatim; anything else is a parse-fail → dropped. Narrow by
// design: the module-level `display` config stays the bare-form default, and
// inline display wins when present (e.g. 5h as "remaining" while global is "used").
const DISPLAY_PARAM = {
  named: {
    display: (raw: string): ResolvedValue | null =>
      raw === "used" || raw === "remaining" ? raw : null,
  },
} as const;

// Widens the m_accStartTime / m_sumStartTime / m_sumEndTime body from
// `HH:MM:SS` (default) to `YYYY-MM-DD HH:MM:SS`. Accepts only literal
// true/false (typos fail loud).
const ABS_PARAM = {
  named: {
    abs: (raw: string): ResolvedValue | null =>
      raw === "true" || raw === "false" ? raw : null,
  },
} as const;

// Strips the leading label prefix from the rendered body on every label-using
// m_* module (per-turn / m_acc* / m_sum* / m_memUsage). Dropped from BOTH the
// live and placeholder paths: m_tokenIn|valueOnly:true → "1.2K" (was "in:1.2K").
// Forwarded through m_template's passthrough whitelist. Accepts only literal
// true/false (typos fail loud).
const VALUEONLY_PARAM = {
  named: {
    valueOnly: (raw: string): ResolvedValue | null =>
      raw === "true" || raw === "false" ? raw : null,
  },
} as const;

// Per-module status-marker override: drives m_branch's clean/dirty suffix
// (default false — no suffix). Enabled → clean "✅" / dirty "🟠" from
// labels.labelGitClean/labelGitDirty, each in its own color; `|color|` tints
// the branch body only. Invalid values → badarg.
const WITHSTATUS_PARAM = {
  named: {
    withStatus: (raw: string): ResolvedValue | null =>
      raw === "true" || raw === "false" ? raw : null,
  },
} as const;

// ----- placeholder shapes for nulldrop:false -------------------------------
//
// Each constant is a closure over params + ctx so INLINE_RENDERERS can pull a
// precomputed placeholder body. Every placeholder wraps its body in
// `${STALE_COLOR}…${RESET}` ("dim gray, no data"), and a `|color|` override
// REPLACES that STALE_COLOR wrap (user override always wins).

// Pure-number placeholder: "<prefix>n/a" (PLAIN — the STALE_COLOR wrap is
// applied by the INLINE_RENDERER so `|color|` can replace it). The prefix
// matches the module's normal label ("ctx:", "in:", ...); bare-string modules
// pass prefix="" (m_session → "n/a").
function placeholderNA(
  prefix: string,
): (_params: Record<string, ResolvedValue>, _ctx: RenderContext) => string {
  return (_p, _c) => `${prefix}n/a`;
}

// Number+unit placeholder: the complete body the module would emit with "--"
// in place of the value (e.g. "5h:--", "+ --"); PLAIN text, STALE_COLOR
// applied by the INLINE_RENDERER.
function placeholderDashesUnit(
  body: string,
): (_params: Record<string, ResolvedValue>, _ctx: RenderContext) => string {
  return (_p, _c) => body;
}

// Variant of placeholderDashesUnit whose body is a function of ctx + params.
// Used by m_countdown so its placeholder reflects the per-term label driven by
// `params.term` (e.g. "5h:--", "7d:--", "30d:--"), with a built-in fallback
// label when the chosen interval is null. `params.term` is the source of truth
// (bare m_countdown defaults to "short" upstream).
function placeholderDashesUnitFn(
  body: (params: Record<string, ResolvedValue>, ctx: RenderContext) => string,
): (params: Record<string, ResolvedValue>, ctx: RenderContext) => string {
  return (p, c) => body(p, c);
}

// Term-aware renderer-context lookup. Mirrors the renderer-side
// `term → Interval` switch (m_windowQuota / m_countdown / m_quota) so
// placeholder + live bodies agree on what interval they read. `term` is the
// literal dict key (`ctx.intervals[term]`); default "short" matches the
// bare-MODULES default; any other string passes through to the dict.
function intervalForTerm(
  term: string | undefined,
  ctx: RenderContext,
): Interval | null {
  const key = term ?? "short";
  return (ctx.intervals ?? {})[key] ?? null;
}

// Built-in fallback labels for the three reserved terms when the chosen
// interval is null. Non-reserved terms (e.g. "monthly") fall back to the term
// string itself (no historical default). Matches the "5h / 7d / 30d" convention
// so existing renders stay byte-identical.
const PLACEHOLDER_TERM_FALLBACK: Record<string, string> = {
  short: "5h",
  mid: "7d",
  long: "30d",
};

function termFallbackLabel(term: string): string {
  return PLACEHOLDER_TERM_FALLBACK[term] ?? term;
}

// Standard per-term + per-interval label resolver used by the
// m_countdown placeholder. `wrap` receives the resolved term-label
// (e.g. "5h" / "7d" / "30d"); the caller shapes the body uniformly
// across terms. The vX.X.X+ convention is dashes-left, label after a
// "·":
//   - m_countdown        → "--·<label>"
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

// Quota module placeholder — term-agnostic: every term renders
// "${labelFor("quota")}n/a" (valueOnly drops the prefix): normal → "quota: n/a",
// valueOnly → "n/a".
function placeholderQuota(
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
): string {
  const valueOnly = params.valueOnly === "true" || ctx.passThrough?.valueOnly === "true";
  const prefix = valueOnly ? "" : labelFor("quota");
  return `${prefix}n/a`;
}

// Gauge placeholder: PLAIN text (no SGR — the INLINE_RENDERER wraps via
// wrapPlain so `|color|` can replace STALE_COLOR). Shape is a 0-value bar:
// "used" → empty bar "0%"; "remaining" → full bar "100%".
function placeholderGauge(
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
): string {
  const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
  const valueOnly = params.valueOnly === "true";
  const empty = cfg().bar.empty;
  const filled = cfg().bar.filled;
  const width = cfg().bar.width;
  if (mode === "used") {
    return valueOnly ? "0%" : `${empty.repeat(width)} 0%`;
  }
  // mode === "remaining": full filled bar, "100%".
  return valueOnly ? "100%" : `${filled.repeat(width)} 100%`;
}

// Module → placeholder dispatcher. Each module opts into one of the four shape
// families by listing its `placeholder` body; the INLINE_RENDERER consults this
// table when the data path returns null/empty AND params.nulldrop === "false".
// Add a module here ONLY if its bare-module null case is a `return null`. The
// prefix/body factories can be a function, so the placeholder reflects the
// user's configured labels.* at placeholder-fire time.
type PlaceholderBody = (
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
) => string;

// Label-aware NA placeholder: defers labelFor(axis) resolution until
// placeholder-fire time so post-load config overrides are picked up. valueOnly
// drops the prefix (placeholder matches the live "value only" shape).
function placeholderLabelOr(axis: LabelAxis): PlaceholderBody {
  return (p, _c) => `${p.valueOnly === "true" ? "" : labelFor(axis)}n/a`;
}

const PLACEHOLDERS: Record<string, PlaceholderBody> = {
  // pure-number — placeholder shape is "<prefix>n/a"
  m_tokenInTotal: placeholderLabelOr("in"),
  m_tokenTotalOut: placeholderLabelOr("out"),
  // m_apiCalls placeholder routes through labelFor(labelApiCalls).
  m_apiCalls: placeholderLabelOr("apiCalls"),
  // m_acc* placeholders share the per-turn prefixes via labelFor (the :scope:
  // inline arg is ignored at the placeholder level — same body regardless of
  // scope). The hit-rate triple (m_accTokenHitRate / m_tokenHitRate /
  // m_sumTokenHitRate) shares the "hit:" prefix.
  m_accTokenIn: placeholderLabelOr("in"),
  m_accTokenOut: placeholderLabelOr("out"),
  m_accTokenCachedIn: placeholderLabelOr("cacheIn"),
  m_accTokenTotalIn: placeholderLabelOr("totalIn"),
  m_accApiMs: placeholderLabelOr("apiMs"),
  m_accApiCalls: placeholderLabelOr("apiCalls"),
  m_accTokenInSpeed: placeholderLabelOr("inSpeed"),
  m_accTokenOutSpeed: placeholderLabelOr("outSpeed"),
  m_accTokenHitRate: (p, _c) => `${p.valueOnly === "true" ? "" : labelFor("hitRate")}n/a%`,
  m_tokenCachedIn: placeholderDashesUnit("cache:0"),
  m_tokenHitRate: (p, _c) => `${p.valueOnly === "true" ? "" : labelFor("hitRate")}n/a`,
  // Context-window placeholders route through the labelContext* axes.
  m_contextSize: (p, _c) => `${p.valueOnly === "true" ? "" : labelFor("contextSize")}n/a`,
  m_contextWindowSize: (p, _c) => `${p.valueOnly === "true" ? "" : labelFor("contextWindowSize")}n/a`,
  // Preserves the "%" unit suffix so users see "used:n/a%" when usedPct is null.
  m_contextUsedPercent: (p, _c) => `${p.valueOnly === "true" ? "" : labelFor("contextUsedPercent")}n/a%`,
  m_contextRemainingPercent: (p, _c) => `${p.valueOnly === "true" ? "" : labelFor("contextRemainingPercent")}n/a%`,
  // number+unit — placeholder shape is the module's normal body
  // with "--" swapped in for the numeric value (e.g. "5h:--",
  // "+ --", "--/s"). Empty body = bare dash.
  m_sessionDuration: placeholderDashesUnit("--"),
  m_sessionApiDuration: placeholderDashesUnit("--"),
  // m_apiMs placeholder — "api:n/a" (R9 unified the apiMs family on n/a).
  m_apiMs: placeholderLabelOr("apiMs"),
  m_linesAdded: placeholderDashesUnit("+--"),
  m_linesRemoved: placeholderDashesUnit("---"),
  // Sum placeholders mirror the rendered shape ("in:n/a" ... "hit:n/a%"); an
  // empty aggregate (no rows in window) triggers the placeholder.
  m_sumTokenIn: placeholderLabelOr("in"),
  m_sumTokenOut: placeholderLabelOr("out"),
  m_sumTokenCachedIn: placeholderLabelOr("cacheIn"),
  m_sumTokenTotalIn: placeholderLabelOr("totalIn"),
  m_sumApiMs: placeholderLabelOr("apiMs"),
  // Ratio keeps the "%" suffix ("hit:n/a%") to mirror placeholderAcc.
  m_sumTokenHitRate: (p, _c) => `${p.valueOnly === "true" ? "" : labelFor("hitRate")}n/a%`,
  // Speed axes use their own labelFor slot (labelInSpeed / labelOutSpeed).
  m_sumTokenInSpeed: placeholderLabelOr("inSpeed"),
  m_sumTokenOutSpeed: placeholderLabelOr("outSpeed"),
  m_sumApiCalls: placeholderLabelOr("apiCalls"),
  // Start/end of the tick statistics window ("<labelStartTime>n/a"). The
  // m_accStartTime sibling routes through placeholderAcc, not this map.
  m_sumStartTime: placeholderLabelOr("startTime"),
  m_sumEndTime: placeholderLabelOr("endTime"),
  m_tokenTotalIn: placeholderLabelOr("totalIn"),
  // Gauge — gray 0% / 100% bar.
  m_windowQuota: placeholderGauge,
  m_windowContext: placeholderGauge,
  // TTL gauge placeholders — custom single ▆ glyph (NOT "ttl:n/a"); STALE_COLOR
  // wrap applied by placeholderBare / placeholderWithColor.
  m_cacheTtlStatus: () => "▆",
  m_statTtlStatus: () => "▆",
  m_sumTtlStatus: () => "▆",
  // bare-string (no prefix to recover from; just "n/a")
  m_session: placeholderNA(""),
  m_model: placeholderNA(""),
  m_provider: placeholderNA(""),
  m_effort: placeholderNA(""),
  m_repo: placeholderNA(""),
  m_gitName: placeholderNA(""),
  m_dirName: placeholderNA(""),
  m_branch: placeholderNA("branch:"),
  m_gitStatus: placeholderNA("git:"),
  m_ccVersion: placeholderNA(""),
  m_ccversion: placeholderNA(""),
  // Per-API-call token modules. Previously bare forms dropped on null (inline
  // emitted "in:--/s" / "in:--" sentinels). Rule: null → "n/a"; idle tick
  // (delta=0) → "in:0" / "out:0" / "in:0.0/s"; 0 always rendered, never hidden.
  // Bare MODULES paths route through these placeholders so layout stays stable.
  m_tokenIn: placeholderLabelOr("in"),
  m_tokenOut: placeholderLabelOr("out"),
  // Speed axes route through the dedicated labelInSpeed / labelOutSpeed slot
  // so the prefix configures independently from labels.labelIn/Out. Defaults
  // stay "in:" / "out:" matching the old literals byte-for-byte.
  m_tokenInSpeed: placeholderLabelOr("inSpeed"),
  m_tokenOutSpeed: placeholderLabelOr("outSpeed"),
  // System RAM usage. Resolves to "<label>n/a" so the placeholder body stays
  // in lockstep with labels.labelMemUsage (renaming the label renames the
  // placeholder too).
  m_memUsage: placeholderLabelOr("memUsage"),
  m_memUsed: placeholderLabelOr("memUsed"),
  m_memTotal: placeholderLabelOr("memTotal"),
  // m_contextUsage placeholder: "ctx:n/a" (prefix dropped with |valueOnly|true).
  m_contextUsage: placeholderLabelOr("contextUsage"),
  // m_windowMemUsage placeholder mirrors m_windowContext: a gray gauge
  // (filled-bar "100%" in remaining mode, empty-bar "0%" in used mode),
  // colored STALE_COLOR.
  m_windowMemUsage: placeholderGauge,
  // Previously drop-by-design modules (no age/version/reset/balance data).
  // Now also follow the placeholder rule — they occupy their slot so adjacent
  // separators don't shift. :nulldrop|true remains the opt-out.
  m_age: placeholderNA("age:"),
  m_version: placeholderNA("v:"),
  m_countdown: placeholderDashesUnitFn((p, c) =>
    // Per-term shape: uniform dashes-left, label-right (matches the live
    // "<arrow><countdown>·<label>" but with no arrow and dashes) →
    // short/mid/long render "--·<label>", e.g. "--·5h".
    placeholderTermLabel(p, c, (label) => `--·${label}`),
  ),
  m_balance: placeholderNA("balance:"),
  m_quota: placeholderQuota,
  // Token cost placeholders render "cost:n/a" so the placeholder stays in
  // lockstep with labelTokenCost overrides.
  m_tokenCost: placeholderLabelOr("cost"),
  m_accTokenCost: placeholderLabelOr("cost"),
  m_sumTokenCost: placeholderLabelOr("cost"),
  // m_sumEstQuota placeholder: same shape as m_sumTokenCost (prefix + "n/a")
  // so both modules show a uniform "no reading yet" body. The renderer's
  // three short-circuits (rows===0, alignedUsedPercent null/0) all funnel
  // into this body — "no data" vs "no plan" collapses to one n/a for layout
  // stability, matching the rest of the m_sum* family.
  m_sumEstQuota: placeholderLabelOr("est"),
};

// Render a placeholder body unless `:nulldrop|true` or the module has no
// registered shape. The default is FORCED placeholder (every inline-listed
// module keeps its slot even when data is null). Returns PLAIN text (the caller
// wraps in the user's color / STALE_COLOR).
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

// Render a placeholder wrapped in the user's `|color|<c>` or STALE_COLOR.
// Returns null on nulldrop:true or a missing shape (caller's drop path). The
// STALE_COLOR default makes missing data visibly gray (vs a band-colored real
// value); unlike wrapPlain, placeholder rendering ALWAYS wraps.
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

// Bare-path variant of placeholderWithColor (no inline args): a module's null
// case renders its PLACEHOLDERS body in STALE_COLOR. Returns null when no shape
// is registered (defensive — every MODULES module now has a placeholder or an
// always-render strategy). `ctx` is needed for placeholderGauge's mode-based
// used/remaining shapes; NA/dashes-unit bodies ignore it.
function placeholderBare(modKey: string, ctx: RenderContext): string | null {
  const body = PLACEHOLDERS[modKey];
  if (!body) return null;
  return `${STALE_COLOR}${body({}, ctx)}${RESET}`;
}

// Extended-color schema for m_quote: the standard shortcuts + raw SGR + the 3
// special shortcuts (rainbow / rand-rainbow / hue), encoded as a string
// (encodeColorParam) so it round-trips through the generic params.color channel.
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
      // Shape-validate the single-unit time format so a wrong token ("yearly",
      // "2h10m", "5x") is rejected before reaching parseFreq(). We pass the raw
      // string through (not a parsed QuoteFreq) to keep the string|number channel.
      if (raw === "") return null;
      // Bare unit letter → valid shorthand.
      if (raw === "d" || raw === "h" || raw === "m" || raw === "s") return raw;
      // Numeric form <digits><unit>: reject multi-unit, unknown units, leading
      // zeros, and empty digit runs here so parseFreq() never sees malformed input.
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

// m_quote `address` param: empty (default) → local QUOTES; non-empty → a URL
// fetched per tick (no cache — the statusline is a short-lived child process).
// Any non-empty URL is accepted (no scheme validation — the user knows their
// network policy); a fetch failure falls through to the local-quote drop path.
const QUOTE_ADDRESS_PARAM = {
  named: {
    address: (raw: string) => (raw.length > 0 ? raw : null),
  },
} as const;

// m_quote `quote` param: a dot-separated JSON path (`a.b`, `quotes.0.x`). An
// empty `quote` is the legal "no walk" marker (a plain-text body is rendered
// verbatim); the renderer distinguishes missing vs empty via
// `params.quote !== undefined`.
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

// m_quote `author` param: a dot-separated JSON path (e.g. `from_who`). Missing
// arg or a null/empty walk means "no author suffix" (bare `~<quote>~`).
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

// m_quote `lang` param: a CSV list of language codes (matches QuoteEntry.lang,
// currently "en"/"zh"). Restricts local-quote rotation; empty or all-unknown
// codes fall back to "no filter".
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

// m_quote `max` param: the CJK-weighted char budget (CJK=2, latin=1; default
// 60 → 30 中文 chars or 60 英文 chars). Integer in [0, 999]; `0` opts out of
// truncation (sanitize still runs). Anything else is rejected.
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

// `|insecureTls|<b>` per-token override for the m_quote fetcher (boolean
// spellings `true`/`false`/`1`/`0`). When present it overrides config.json's
// `quoteInsecureTls` for that fetch (opt into curl -k only on specific tokens);
// omitted = fall back to the config gate.
const QUOTE_INSECURE_TLS_PARAM = {
  named: {
    insecureTls: (raw: string) => {
      const v = raw.toLowerCase();
      if (v === "true" || v === "1" || v === "false" || v === "0") return raw;
      return null;
    },
  },
} as const;

// Walk a JSON value along a dot-separated path. At each step: a string is
// terminal (return it, ignoring the rest of the path — "如果拿到的已经是字符串,
// 则忽略 field 参数"); an object treats the segment as a key; an array treats
// it as a non-negative integer index. Malformed segment / path run-out → null.
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

// Read a pre-fetched quote body from ctx.quoteBodies (populated by
// `preFetchQuotes` in src/api.quote.ts ahead of render — pure sync, no IO at
// render time) and walk the `quote` (+ optional `author`) path. Returns the
// walked strings, or null when: no body / the body is non-JSON (with a
// non-empty quote marker) / the quote walk misses (the author's miss is
// tolerated → `~<quote>~`). Every failure path appends a structured
// diagnostics.jsonl warning (gated on CREDITGAUGE_DIAGNOSTICS_ENABLE, address
// truncated to keep rows ~250B) and the caller falls back to local QUOTES.
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
      undefined,
      undefined,
      "parse",
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    if (quote === "") {
      // Plain-text body rendered verbatim when no quote path is supplied (author null).
      return { quote: body, author: null };
    }
    diagnostics.append(
      "error",
      "m_quote",
      `address fetch returned non-JSON body: ${truncateForLog(address)}`,
      ctx.nowMs,
      undefined,
      undefined,
      "parse",
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
      undefined,
      undefined,
      "parse",
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

// Truncate a user-supplied address for diagnostic logging (120 chars keeps the
// JSONL row under ~250B while still identifying the failed endpoint).
function truncateForLog(s: string): string {
  return s.length > 120 ? s.slice(0, 119) + "…" : s;
}

// Small string hash for color-band seeding when the quote comes from a remote
// address (no time-based quoteIndex). djb2 — non-crypto, deterministic.
function stringHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33 + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

// Six named separator aliases. Each `s_<name>` token resolves to its built-in
// literal character. The legacy numeric `s_<n>` form and the `separators`
// config array are REMOVED — for a custom character use one of these six (or
// an m_label literal). `pipe` is pure render output, NOT the inline-args
// delimiter itself (see parseInlineArgs).
//
// Encoding note: ResolvedValue is `string | number`, so the alias form is
// tagged as `"alias:<name>"` (still a string) through the inline-schema
// machinery; resolveSepBody returns INLINE_BADARG for any non-alias input.
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

// Per-code-point display width for s_move column padding. WIDTH_EXCEPTIONS
// encodes terminal-specific deviations (🗪 U+1F5EA renders 1 cell on the user's
// terminal despite EAW W). Zero-width chars (combining marks, format controls,
// separators) are classified via Unicode property escapes; wide chars use the
// wcwidth East-Asian-Wide + emoji-presentation ranges. Everything else is 1.
const WIDTH_EXCEPTIONS: Record<number, number> = {
  0x1f5ea: 1, // renders narrow (1) on the user's terminal; the EAW table says W (2)
};

// M = combining marks, Cf = format controls (ZWJ/ZWNJ/ZWSP/soft hyphen/BOM/
// variation selectors), Zl/Zp = line/paragraph separators — all zero-width.
const ZERO_WIDTH_RE = /[\p{M}\p{Cf}\p{Zl}\p{Zp}]/u;

// East Asian Wide / Fullwidth + emoji-presentation ranges (U+1F5EA is handled
// by WIDTH_EXCEPTIONS, not here).
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],    // Hangul Jamo
  [0x231a, 0x231b],    // ⌚ ⌛
  [0x23e9, 0x23f3],    // ⏩…⏳ (emoji-presentation subset of Misc Technical)
  [0x25fd, 0x25fe],    // ◽ ◾
  [0x2600, 0x27bf],    // Misc Symbols + Dingbats (common emoji-presentation set)
  [0x2b00, 0x2bff],    // Misc Symbols and Arrows (incl. ⭐, ➡)
  [0x2e80, 0xa4cf],    // CJK Radicals…Yi Syllables
  [0xac00, 0xd7a3],    // Hangul Syllables
  [0xf900, 0xfaff],    // CJK Compatibility Ideographs
  [0xfe10, 0xfe19],    // Vertical Forms
  [0xfe30, 0xfe6f],    // CJK Compatibility Forms
  [0xff00, 0xff60],    // Fullwidth Forms
  [0xffe0, 0xffe6],    // Fullwidth Signs
  [0x1f000, 0x1f64f],  // Mahjong…Emoticons (incl. 📦 U+1F4E6)
  [0x1f650, 0x1f67f],  // Ornamental Dingbats
  [0x1f680, 0x1f6ff],  // Transport & Map
  [0x1f780, 0x1f7ff],  // Geometric Shapes Extended
  [0x1f800, 0x1f8ff],  // Supplemental Arrows-C
  [0x1f900, 0x1f9ff],  // Supplemental Symbols & Pictographs
  [0x1fa00, 0x1faff],  // Symbols & Pictographs Extended (incl. 🪙 U+1FA99)
  [0x20000, 0x2fffd],  // CJK Ext B-F
  [0x30000, 0x3fffd],  // CJK Ext G+
];

// Display width of a single code point (a one-code-point string, as produced
// by `for...of` iteration). Returns 0 / 1 / 2.
export function charDisplayWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  const ex = WIDTH_EXCEPTIONS[cp];
  if (ex !== undefined) return ex;
  // Control characters (incl. ESC/TAB) and the DEL/C1 block.
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (ZERO_WIDTH_RE.test(ch)) return 0;
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
  }
  return 1;
}

// ANSI SGR strip + display-width counter for s_move. Strips ESC[…m and
// ESC[…<letter> (all zero-width for the column cursor), then sums per-code-
// point display widths via charDisplayWidth (emoji/CJK = 2, narrow = 1,
// zero-width = 0) so the cursor matches the terminal's actual columns, not JS
// string length. Used by renderTemplate's cursor tracking on every chunk (the
// cursor lives in a closure, not ctx, so nested m_template renders never see a
// half-updated value).
function visibleCellLength(s: string): number {
  // Replace each SGR with empty; `\x1b` = ESC, `[`, then any number of params
  // (digits + `;`) + a final letter byte (0x40..0x7E).
  let stripped = "";
  let i = 0;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code === 0x1b && i + 1 < s.length && s.charCodeAt(i + 1) === 0x5b) {
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
  // Width-aware: sum per-code-point display width instead of JS string length.
  // `for...of` iterates full code points, so surrogate-pair emoji measure as
  // one glyph (not 2 units).
  let width = 0;
  for (const ch of stripped) width += charDisplayWidth(ch);
  return width;
}

const INLINE_SCHEMAS: Record<string, InlineSchema> = {
  s_: {
    // The implicit param accepts ONLY a named alias (s_space / s_dot /
    // s_newline / s_tab / s_colon / s_pipe); the numeric s_<n> form is REMOVED
    // (unrecognized tokens emit as literals). Named params: |repeat|<1..8> and
    // |wrap|<left|right|both|none> (legacy true/false aliases kept). repeat
    // multiplies the body (default 1); wrap pads a printable body with one space
    // on the named side(s) — whitespace bodies skip padding under every mode.
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
  // Column-pad separator: `s_move|pos:<n>|char:<c>` pads until the visible-cell
  // cursor reaches column `<n>`. Bare `s_move` (no `pos:`) is badarg ("没带参数
  // 相当于无效"). The dispatcher tracks the cursor in a closure (reset on `\n`),
  // read via ctx.lineCursor. NO implicit value — pos and char are both named.
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
    // No implicit — the string is derived from ctx. The first segment, if
    // present, must be a name in `named` (a name:value pair) or the token is
    // malformed. Accepts `display` to override the label's mode locally
    // (e.g. `m_modeLabel|display:remaining` → "Remain:"); ignored on the
    // balance path (Balance: is mode-agnostic).
    named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...NULDROP_PARAM.named },
  },
  // Every module also accepts an optional :color| override; a module with no
  // implicit param has an empty schema and the renderer just applies params.color.
  m_windowQuota: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...TERM_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_countdown: { named: { ...COLOR_PARAM.named, ...TERM_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_quota: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...TERM_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_balance: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_age: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_version: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_pluginSource: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_tokenOut: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_contextSize: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_tokenHitRate: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_tokenCachedIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_tokenInSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_tokenOutSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  // m_acc* family accepts :scope:<session|project|model> (default session for
  // the bare form) + color / nulldrop / valueOnly. The removed "ccsession"
  // scope surfaces as badarg at module-eval time (see resolveAccScope).
  m_accTokenIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_accTokenOut: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_accTokenCachedIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_accTokenTotalIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_accApiMs: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_accApiCalls: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_accTokenInSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_accTokenOutSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_accTokenHitRate: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  // m_accStartTime: same m_acc* surface + |abs|<true|false> (widen to
  // YYYY-MM-DD HH:MM:SS) + valueOnly.
  m_accStartTime: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...ABS_PARAM.named, ...VALUEONLY_PARAM.named } },
  // All m_sum* modules accept the same inline args: :model|<active|name|all>,
  // :window|<dhms|all>, :align|<true|false>, :color|<c>, :nulldrop|<b>,
  // :term|<key>. Malformed dhms strings are rejected at parse time → badarg.
  m_sumTokenIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...TERM_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumTokenOut: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...TERM_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumTokenCachedIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...TERM_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumTokenTotalIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...TERM_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumApiMs: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...TERM_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumTokenHitRate: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...TERM_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumTokenInSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...TERM_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumTokenOutSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...TERM_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumApiCalls: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...TERM_PARAM.named, ...VALUEONLY_PARAM.named } },
  // m_sumStartTime / m_sumEndTime: same m_sum* surface + |abs| + valueOnly.
  m_sumStartTime: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...TERM_PARAM.named, ...ABS_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumEndTime: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...TERM_PARAM.named, ...ABS_PARAM.named, ...VALUEONLY_PARAM.named } },
  // Quote module. Accepts :freq|<numeric-time> (single-unit format
  // `<digits><unit>`, bare letter = 1<unit>; default `h` applied at the
  // RENDERER level when params.freq is undefined) plus color / address /
  // quote / author / lang / max / insecureTls / wrap / nulldrop.
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
  // Session-info / metadata modules — color + nulldrop only.
  m_session: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_model: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_provider: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_effort: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_repo: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_gitName: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_dirName: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_branch: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...WITHSTATUS_PARAM.named } },
  m_gitStatus: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_ccVersion: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_ccversion: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_sessionDuration: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_sessionApiDuration: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  // Per-turn API-ms delta — color + nulldrop + valueOnly.
  m_apiMs: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_linesAdded: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_linesRemoved: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenInTotal: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_tokenTotalOut: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_tokenTotalIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_apiCalls: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_contextWindowSize: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_contextUsedPercent: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_contextRemainingPercent: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_windowContext: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  // TTL gauge inline-args (color + nulldrop). |color|<c> REPLACES the 5-band
  // scale color; there's no :scale| opt-back-in because TTL is binary
  // "data vs missing" — green-on-fresh / red-on-stale is the natural render.
  m_cacheTtlStatus: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_statTtlStatus: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  // System RAM usage inline-args (color + nulldrop + valueOnly). |color|<c>
  // overrides the whole two-tone body; with no color, the used chunk is
  // band-colored internally (colorFor) and prefix + total stay cyan.
  m_memUsage: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  // m_memUsed / m_memTotal inline-args — same shape as m_memUsage.
  m_memUsed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_memTotal: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  // m_contextUsage inline-args — same shape as m_memUsage. |color|<c> overrides
  // the whole two-tone body; with no color, used chunk band-colored + rest blue.
  m_contextUsage: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  // m_windowMemUsage inline-args — same shape as m_windowContext (color +
  // display + nulldrop). |color|<c> overrides the percentBands color; |display|
  // selects which side of the bar is colored and which percentage is shown.
  m_windowMemUsage: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  // Per-turn token cost inline-args — same shape as the m_token* family.
  m_tokenCost: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  // Cost modules — same arg surface as their non-cost siblings (scope for
  // m_accTokenCost; the full m_sum* surface for m_sumTokenCost / m_sumEstQuota).
  m_accTokenCost: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumTokenCost: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...TERM_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_sumEstQuota: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...TERM_PARAM.named, ...VALUEONLY_PARAM.named } },
  // m_sumTtlStatus inherits the m_sum* filter surface (so an outer
  // |model|/|window|/...| targets the exact stat-cache key). No valueOnly — the
  // body is a glyph + suffix, not a value.
  m_sumTtlStatus: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named, ...TERM_PARAM.named } },
  // Sub-template reference. First arg is the key into cfg().lineTemplates.
  // `type` is a providerType filter (quota/balance/unknown — NOT forwarded via
  // passThrough); `providers:<id1,id2>` gates by provider INSTANCE (comma-
  // separated; renders when any entry matches ctx.currentProvider). :color| is
  // NOT accepted here — per-chunk color goes on the inner modules. The
  // passthrough whitelist (nulldrop/color/scope/model/window/align/term/
  // valueOnly/withStatus) forwards args to inner modules as a fallback when the
  // inner module's own param is undefined (inner-explicit wins; unknown args
  // fail loud as badarg).
  m_template: {
    implicit: {
      name: "key",
      resolver: (raw) =>
        typeof raw === "string" && raw !== "" ? raw : null,
    },
    named: {
      type: (raw) => (raw === "quota" || raw === "balance" || raw === "unknown" ? raw : null),
      providers: (raw) => (typeof raw === "string" && raw !== "" ? raw : null),
      ...NULDROP_PARAM.named,
      ...COLOR_PARAM.named,
      ...SCOPE_PARAM.named,
      ...MODEL_PARAM.named,
      ...WINDOW_PARAM.named,
      ...ALIGN_PARAM.named,
      ...TERM_PARAM.named,
      ...VALUEONLY_PARAM.named,
      ...WITHSTATUS_PARAM.named,
    },
  },
};

// Pure helper: wrap a plain-text body in `<color>…<RESET>`. Returns the body
// unchanged when `color` is undefined. Safe ONLY for bodies without existing
// SGR sequences (colored bodies must use their override-aware helper).
function wrapPlain(body: string, color: string | undefined): string {
  return color ? `${color}${body}${RESET}` : body;
}

// Wrap with the user's `|color|<c>` override or the module's DEFAULT_COLORS
// entry — gives bare and inline forms the same tint.
function wrapPlainDefault(
  modKey: string,
  body: string,
  paramsColor: string | undefined,
): string {
  const color = paramsColor ?? DEFAULT_COLORS[modKey];
  return color ? `${color}${body}${RESET}` : body;
}

// "Non-zero, non-null" default tint: like wrapPlainDefault but ONLY colors when
// `value` is a finite number > 0 (value=0 stays plain per the value-zero rule;
// null/undefined is unreachable — the caller already took the placeholder path).
function wrapValueDefault(
  modKey: string,
  value: number | null | undefined,
  body: string,
  paramsColor: string | undefined,
): string {
  const color = paramsColor ?? (typeof value === "number" && value > 0 ? DEFAULT_COLORS[modKey] : undefined);
  return color ? `${color}${body}${RESET}` : body;
}

// Resolve an inline-arg value with passthrough fallback. Order: local
// `params[name]` (inner-explicit wins) > `ctx.passThrough?.[name]` (outer
// m_template's forwarded arg) > undefined (caller applies its own DEFAULT).
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

// Build a merged `params` view filling missing keys from `ctx.passThrough` (so
// helpers like parseWindowScope stay params-only). Returns a fresh object;
// one-way fill preserves inner-explicit-wins.
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

// Inline-form scope resolution for the m_acc* family: inline params first, then
// passThrough, then "session". Throws badarg on the REMOVED "ccsession" scope
// so a leftover config surfaces at module-eval time instead of silently
// falling back. The single chokepoint keeps the bare and inline forms on the
// same reject path.
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

// passThroughScope is for MODULES-bare-path renderers that can't call
// passThroughOr — they only see ctx.passThrough. The removed "ccsession" is
// rejected with badarg; returns undefined when passthrough is absent or not a
// recognized scope (the caller applies its own default).
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

// Parallel to MODULES' per-module `type` tag — keeps the inline path symmetric
// so `m_windowQuota|color|red` drops on a balance provider exactly like the
// bare form. Untagged entries (key absent) are provider-agnostic.
const INLINE_TYPE_FILTERS: Partial<Record<string, "quota" | "balance" | "unknown">> = {
  m_windowQuota: "quota",
  m_countdown: "quota",
  m_quota: "quota",
  m_balance: "balance",
};

// Local QUOTES picker shared by the m_quote inline renderer and its bare
// MODULES twin. Honors `freq` (default 1h) + optional `lang` CSV filter.
// Returns null on a rejected freq arg (caller falls through to INLINE_BADARG).
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

// Deterministic seed for the color shortcut helpers (rainbow/hue) on the local
// QUOTES path — mirrors the bucket index so the same freq + nowMs lands on the
// same color band. Falls back to 0 when the freq arg is malformed.
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
  // Column-pad renderer. Reads ctx.lineCursor (set by the dispatcher's
  // per-chunk closure) and emits `repeat(char, pos - cursor)` to advance to
  // `pos`. cursor >= pos → "误操作" (wouldn't advance / would go backward) —
  // warn + drop. Bare s_move (no `pos:`) is rejected upstream by MOVE_PARAM
  // (pos has no default) → badarg.
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
    // params.index is resolveSepRef's output (a "alias:<name>" string);
    // resolveSepBody decodes it to the literal body or INLINE_BADARG.
    const body = resolveSepBody(params.index);
    if (body === INLINE_BADARG) return INLINE_BADARG;
    // repeat N times (default "1") then pad per wrap (default "both");
    // control/whitespace bodies skip padding. See formatSepBody.
    const repeat = (params.repeat as string | undefined) ?? "1";
    const wrap = (params.wrap as string | undefined) ?? "both";
    const shape = formatSepBody(body, repeat, wrap);
    return wrapPlain(shape, params.color as string | undefined);
  },
  m_label: (params, _ctx) => {
    const s = params.string as string;
    if (s === "") return INLINE_BADARG; // empty payload is malformed
    return wrapPlain(s, params.color as string | undefined);
  },
  m_modeLabel: (params, ctx) => {
    // Mirrors the MODULES body (balance → Balance label, else the mode-aware
    // label). DEFAULT_COLORS["m_modeLabel"] is undefined, so it renders PLAIN
    // unless the user supplies |color|. `display` overrides the mode locally;
    // ignored on the balance path.
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const s = ctx.providerType === "balance"
      ? cfg().modeLabels.balance
      : cfg().modeLabels[mode];
    return wrapPlainDefault("m_modeLabel", s, params.color as string | undefined);
  },
  m_windowQuota: (params, ctx) => {
    // `term` picks which interval to read (default "short"; open-ended dict —
    // "monthly"/"yearly"/etc. all resolve the same way). Missing interval or no
    // percent data → placeholder.
    const term = (params.term as string | undefined) ?? "short";
    const iv = intervalForTerm(term, ctx);
    if (!iv) return placeholderWithColor("m_windowQuota", params, ctx);
    const w = intervalToWindow(iv);
    if (!w) return placeholderWithColor("m_windowQuota", params, ctx);
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const valueOnly = params.valueOnly === "true";
    const color = params.color as string | undefined;
    if (valueOnly) return formatPercentOnly(w, mode, color);
    if (color) return formatOneChunkColored(w, mode, color);
    return formatOneChunk(w, mode, cfg().bar.width, ctx.stale);
  },
  m_countdown: (params, ctx) => {
    // Same `term` arg as m_windowQuota. The label in `<arrow>n/a·<label>` /
    // `<arrow>4h47m·<label>` comes from the live `Interval.label` (no hard-coded
    // "5h"/"7d"). |valueOnly|true strips the `·` window label (just arrow+countdown).
    const term = (params.term as string | undefined) ?? "short";
    const iv = intervalForTerm(term, ctx);
    if (!iv) return placeholderWithColor("m_countdown", params, ctx);
    const w = intervalToWindow(iv);
    if (!w) return placeholderWithColor("m_countdown", params, ctx);
    const valueOnly = params.valueOnly === "true";
    if (isStaleAndPastDue(w, ctx.stale, ctx.nowMs)) {
      const userColor = params.color as string | undefined;
      const color = userColor ?? STALE_COLOR;
      if (valueOnly) {
        const arrow = pickResetArrow(ctx.nowMs, w.resetStartAt, w.resetDurationMs);
        return `${color}${arrow}n/a${RESET}`;
      }
      const body = formatStalePastDueResetSuffix(iv.label, w, ctx.nowMs);
      return `${color}${body}${RESET}`;
    }
    const body = valueOnly
      ? formatCountdownValueOnly(w, ctx.nowMs)
      : formatOneResetSuffix(iv.label, w, ctx.nowMs);
    if (body === "") return null;
    return wrapPlainDefault("m_countdown", body, params.color as string | undefined);
  },
  m_quota: (params, ctx) => {
    // Renders `<labelQuota><axis>/<limit>` (placeholder `<labelQuota>n/a`).
    // `term` same as m_windowQuota / m_countdown; `display` swaps the axis:
    // |display|used → `<used>/<limit>` (default), |display|remaining →
    // `<remaining>/<limit>`.
    const term = (params.term as string | undefined) ?? "short";
    const iv = intervalForTerm(term, ctx);
    if (!iv) return placeholderWithColor("m_quota", params, ctx);
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const parts = renderQuotaParts(iv, mode);
    if (!parts) return placeholderWithColor("m_quota", params, ctx);
    return wrapQuotaBody(parts, mode, params.color as string | undefined, passThroughOr(params, ctx, "valueOnly") === "true");
  },
  m_balance: (params, ctx) => {
    // Missing balance → "balance:n/a" placeholder; the placeholder only fires
    // on the truly empty case.
    if (!ctx.balance) return placeholderWithColor("m_balance", params, ctx);
    const color = (params.color as string | undefined) ?? DEFAULT_COLORS["m_balance"];
    const text = formatBalanceEntriesColored(ctx.balance, color);
    return text || placeholderWithColor("m_balance", params, ctx);
  },
  m_age: (params, ctx) => {
    // Missing ageMs → "age:n/a" placeholder.
    if (ctx.ageMs == null) return placeholderWithColor("m_age", params, ctx);
    // Cross-recursion dedup (same as the bare path): the first m_age instance
    // (bare or inline, top-level or nested) claims the slot.
    if (ctx.ageEmittedRef?.value) return null;
    if (ctx.ageEmittedRef) ctx.ageEmittedRef.value = true;
    const color = (params.color as string | undefined) ?? DEFAULT_COLORS["m_age"];
    return formatStaleSuffix(ctx.ageMs, !ctx.stale, color);
  },
  m_version: (params, ctx) => {
    // Missing version → "v:n/a" placeholder.
    if (!ctx.version) return placeholderWithColor("m_version", params, ctx);
    return wrapPlainDefault("m_version", `v${ctx.version}`, params.color as string | undefined);
  },
  m_pluginSource: (params, ctx) => {
    // Mirrors the MODULES path: glyph per resolution kind, NO default tint —
    // only an explicit |color| applies one. No cache row → null (no-op).
    const glyph =
      ctx.pluginSource === "builtin" ? labelFor("pluginSystem") :
      ctx.pluginSource === "user" ? labelFor("pluginUserDefined") :
      ctx.pluginSource === "missing" ? labelFor("pluginMissing") :
      null;
    if (glyph == null) return null;
    const color = params.color as string | undefined;
    return color ? `${color}${glyph}${RESET}` : glyph;
  },
  m_tokenIn: (params, ctx) => {
    const r = computeTickDelta(ctx, "in");
    // |valueOnly|true strips the leading label from the pre-prefixed r.value.
    const stripLabel = params.valueOnly === "true";
    const body = stripLabelIfValueOnly(r.value, "in", stripLabel);
    // Active tick → bare default tint (brightGreen) on positive value; idle
    // (hasMeasurement=false) → STALE_COLOR with the live stdin number (color
    // tracks hasMeasurement, value tracks stdin). The user's |color| wins on
    // the active path and is honored on the idle path.
    const userColor = params.color as string | undefined;
    if (r.numeric == null || r.numeric === 0) return body;
    if (r.stale) {
      return userColor ? `${userColor}${body}${RESET}` : `${STALE_COLOR}${body}${RESET}`;
    }
    return wrapValueDefault("m_tokenIn", r.numeric, body, userColor);
  },
  m_tokenOut: (params, ctx) => {
    const r = computeTickDelta(ctx, "out");
    // |valueOnly|true strips the leading label.
    const stripLabel = params.valueOnly === "true";
    const body = stripLabelIfValueOnly(r.value, "out", stripLabel);
    // See m_tokenIn inline for the wrap contract.
    const userColor = params.color as string | undefined;
    if (r.numeric == null || r.numeric === 0) return body;
    if (r.stale) {
      return userColor ? `${userColor}${body}${RESET}` : `${STALE_COLOR}${body}${RESET}`;
    }
    return wrapValueDefault("m_tokenOut", r.numeric, body, userColor);
  },
  // Inline form of m_contextSize (cumulative occupancy).
  m_contextSize: (params, ctx) => {
    // |valueOnly|true drops the "size:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("contextSize");
    const total = ctx.tokens?.totals?.tokenTotalIn;
    if (total == null) return placeholderWithColor("m_contextSize", params, ctx);
    return wrapPlain(
      `${prefix}${formatCompactToken(total)}`,
      params.color as string | undefined,
    );
  },
  // Per-turn hit rate (see MODULES entry for the formula). The inline form
  // takes an optional |color| override; the session-aggregate formula moved to
  // m_accTokenHitRate.
  m_tokenHitRate: (params, ctx) => {
    // |valueOnly|true drops the "hit:" prefix (routes through
    // labels.labelTokenHitRate).
    const prefix = params.valueOnly === "true" ? "" : labelFor("hitRate");
    const t = ctx.tokens;
    if (!t) return placeholderWithColor("m_tokenHitRate", params, ctx);
    const total = t.totals?.tokenTotalIn;
    const cacheRead = t.current?.tokenCachedIn;
    if (total == null || cacheRead == null) {
      // Cache fallback (R7 — TTL gate disabled, cache never expires): idle tick
      // renders the cached percentage in STALE_COLOR; with no prior measurement,
      // the placeholder drops in. STALE_COLOR wins over the user's |color|
      // override — gray is the canonical "from a previous tick" signal.
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
    // "Active" coloring (same convention as the tps siblings): the rate is only
    // fresh when the API did work this tick (hasDelta=true); idle → STALE_COLOR
    // regardless of the user's |color| override.
    const r = getDeltaForRender();
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
  // Inline form of m_tokenCachedIn (the `(XX%)` share suffix was dropped —
  // m_tokenHitRate renders the ratio). cacheRead=null / missing snapshot →
  // "cache:0" (field-not-shipped as zero). Default PLAIN; positive value gets
  // the brown tint; 0 stays plain. |valueOnly|true drops the prefix.
  m_tokenCachedIn: (params, ctx) => {
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
  // Per-turn token cost inline (mirrors the MODULES body).
  m_tokenCost: (params, ctx) => {
    const t = ctx.tokens;
    if (!t || !t.sessionId) return placeholderWithColor("m_tokenCost", params, ctx);
    const r = getDeltaForRender();
    const snapshotCost = r.cost;
    if (!snapshotCost) return placeholderWithColor("m_tokenCost", params, ctx);
    const userColor = params.color as string | undefined;
    const prefix = params.valueOnly === "true" ? "" : labelFor("cost");
    if (!r.hasMeasurement) {
      const color = userColor ?? STALE_COLOR;
      return `${color}${prefix}${formatCostDict(snapshotCost)}${RESET}`;
    }
    const cost = parseFloat(snapshotCost.value);
    return wrapValueDefault("m_tokenCost", cost, `${prefix}${formatCostDict(snapshotCost)}`, userColor);
  },
  // :color|scale (or no :color|) → 5-band scale color on the active tick,
  // STALE_COLOR on the cached/inactive tick. :color|<shortcut|SGR> → that exact
  // color on the active tick, STALE_COLOR on the cached tick ("inactive 不受
  // :color| 影响" — gray is the canonical stale signal).
  m_tokenInSpeed: (params, ctx) => {
    const probe = computeTickSpeed(ctx, "in", STALE_COLOR);
    const userColor = params.color as string | undefined;
    const activeColor =
      userColor === SCALE_COLOR_SENTINEL || userColor == null
        ? speedScaleColor("in", probe.tps ?? 0)
        : (userColor ?? STALE_COLOR);
    const r = computeTickSpeed(ctx, "in", activeColor);
    // |valueOnly|true strips the pre-prefixed labelFor("inSpeed") substring.
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
    // |valueOnly|true strips the "out:" prefix.
    if (params.valueOnly === "true") return r.value.replace(labelFor("outSpeed"), "");
    return r.value;
  },
  // m_acc* inline renderers — three-layer granularity via :scope: session
  // (default, per-CC-process, clear-bounded) / project (crosses sessions in the
  // same cwd) / model (crosses sessions for the same model). All read the
  // AccSnapshot slot populated by setAvg; the scope→slot mapping is hidden in
  // peekAcc. The removed `ccsession` surface surfaces as badarg (resolveAccScope).
  m_accTokenIn: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    // Bare default tint (brightGreen) on positive value; acc:0 stays plain.
    const v = peekAcc(scope, ctx);
    const n = v ? v.accTokenIn : 0;
    return wrapValueDefault("m_accTokenIn", n, accBody(ctx, "in", scope, passThroughOr<string>(params, ctx, "valueOnly") === "true"), passThroughOr<string>(params, ctx, "color"));
  },
  m_accTokenOut: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    // Bare default tint (red) on positive value; see m_accTokenIn.
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
  // Accumulated token cost inline. Computed from peekAcc × tokenPrice. Same
  // arg surface as m_accApiCalls (color/nulldrop/scope).
  m_accTokenCost: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    const v = peekAcc(scope, ctx);
    if (!v) return placeholderWithColor("m_accTokenCost", params, ctx);
    if (!v.costs || v.costs.length === 0) return placeholderWithColor("m_accTokenCost", params, ctx);
    const total = v.costs.reduce((s, e) => s + parseFloat(e.value), 0);
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("cost");
    return wrapValueDefault("m_accTokenCost", total, `${prefix}${formatCostsArray(v.costs)}`, passThroughOr<string>(params, ctx, "color"));
  },
  // Inline m_accTokenInSpeed / m_accTokenOutSpeed: mirrors m_tokenInSpeed —
  // |color|scale (or none) → 5-band scale on the active rollup; |color|<c>
  // wins over the scale; peekAcc==null → "direction:n/a".
  m_accTokenInSpeed: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    const probe = computeAccSpeed(ctx, scope, "in", STALE_COLOR);
    const userColor = passThroughOr<string>(params, ctx, "color");
    const activeColor =
      userColor === SCALE_COLOR_SENTINEL || userColor == null
        ? (probe.active ? speedScaleColor("in", probe.tps ?? 0) : STALE_COLOR)
        : userColor;
    const r = computeAccSpeed(ctx, scope, "in", activeColor);
    // |valueOnly|true strips the "in:" prefix from r.value.
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
    // |valueOnly|true strips the "out:" prefix from r.value.
    if (passThroughOr<string>(params, ctx, "valueOnly") === "true") return r.value.replace(labelFor("outSpeed"), "");
    return r.value;
  },
  // Hit rate: session-scoped by default (pass :scope:project/:scope:model to
  // widen). Reads TickStatusValue.accTokenHitRate directly.
  m_accTokenHitRate: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    const v = peekAcc(scope, ctx);
    if (!v) return placeholderAcc("hitRate", scope, passThroughOr<string>(params, ctx, "valueOnly") === "true");
    const pct = v.accTokenHitRate;
    const color = passThroughOr<string>(params, ctx, "color") ?? cacheHitColor(pct);
    // |valueOnly|true drops the "hit:" prefix; else prefix = labelFor("hitRate").
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("hitRate");
    return `${color}${prefix}${pct.toFixed(cachePctPrecision())}%${RESET}`;
  },
  // Start of the tick statistics window. Inline form supports :scope: (default
  // session) + :color: on the "HH:MM:SS" body; missing slot / legacy state.json
  // without startAt → "start:n/a" placeholder.
  m_accStartTime: (params, ctx) => {
    const scope = resolveAccScope(params, ctx);
    const v = peekAcc(scope, ctx);
    // |valueOnly|true drops the "start:" prefix.
    const strip = passThroughOr<string>(params, ctx, "valueOnly") === "true";
    const startAt = v?.startAt ?? null;
    if (startAt == null) return placeholderAcc("startTime", scope, strip);
    const userColor = passThroughOr<string>(params, ctx, "color");
    // |abs| widens the body; default off (HH:MM:SS).
    const abs = passThroughOr<string>(params, ctx, "abs") === "true";
    const prefix = strip ? "" : labelFor("startTime");
    return wrapPlain(`${prefix}${formatAbsTime(startAt, { abs })}`, userColor);
  },
  // Sum/avg inline renderers — same bodies as the bare MODULES entries, but
  // params (model/window/align) take effect. parseWindowScope here is the
  // runtime fallback for unexpected shapes (null → INLINE_BADARG).
  m_sumTokenIn: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumTokenIn", params, ctx);
    // Bare default tint (brightGreen) on positive sum; user |color| wins; 0 plain.
    // |valueOnly|true drops the "in:" prefix.
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
    // Bare default tint (red) on positive sum; |valueOnly|true drops the prefix.
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
    // |valueOnly|true drops the "cache:" prefix.
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("cacheIn");
    return wrapValueDefault("m_sumTokenCachedIn", agg.sumCached, `${prefix}${formatCompactToken(agg.sumCached)}`, passThroughOr<string>(params, ctx, "color"));
  },
  m_sumTokenTotalIn: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumTokenTotalIn", params, ctx);
    // |valueOnly|true drops the "total:" prefix.
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("totalIn");
    return wrapValueDefault("m_sumTokenTotalIn", agg.sumTotalIn, `${prefix}${formatCompactToken(agg.sumTotalIn)}`, passThroughOr<string>(params, ctx, "color"));
  },
  // Windowed token cost inline (m_sum* arg surface).
  m_sumTokenCost: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumTokenCost", params, ctx);
    // Reads costs summed from the aggregate.
    if (!agg.costs || agg.costs.length === 0) return placeholderWithColor("m_sumTokenCost", params, ctx);
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("cost");
    const total = agg.costs.reduce((s, e) => s + parseFloat(e.value), 0);
    return wrapValueDefault("m_sumTokenCost", total, `${prefix}${formatCostsArray(agg.costs)}`, passThroughOr<string>(params, ctx, "color"));
  },
  // Inline form of m_sumEstQuota (mirrors the bare form). Multi-currency costs
  // consolidated via exchange rates from config.tokenPrices.json.
  m_sumEstQuota: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumEstQuota", params, ctx);
    if (!agg.costs || agg.costs.length === 0) return placeholderWithColor("m_sumEstQuota", params, ctx);
    const pct = agg.alignedUsedPercent;
    if (pct == null) return placeholderWithColor("m_sumEstQuota", params, ctx);
    if (pct === 0) return placeholderWithColor("m_sumEstQuota", params, ctx);
    // Resolve target currency via exchange rates.
    const rates = cfg().exchangeRates;
    const baseCurrency = cfg().tokenPrices.default?.currency ?? "CNY";
    const providerId = ctx.currentProvider ?? null;
    const targetCurrency = resolveEstQuotaTargetCurrency(agg.costs, rates, baseCurrency, providerId);
    const single = convertCostsToCurrency(agg.costs, targetCurrency, rates, baseCurrency);
    if (!single) return placeholderWithColor("m_sumEstQuota", params, ctx);
    const cost = parseFloat(single.value);
    const est = cost / (pct / 100);
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("est");
    return wrapValueDefault("m_sumEstQuota", est, `${prefix}${formatEstCostWithCurrency(est, single.currency)}`, passThroughOr<string>(params, ctx, "color"));
  },
  m_sumApiMs: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumApiMs", params, ctx);
    // Prefix via labelFor(labels.labelApi); default "api:" preserves the
    // v0.8.x literal. |valueOnly|true drops it.
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
    // |valueOnly|true drops the "hit:" prefix; else prefix = labelFor("hitRate").
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("hitRate");
    return `${cacheHitColor(pct)}${prefix}${pct.toFixed(cachePctPrecision())}%${RESET}`;
  },
  m_sumTokenInSpeed: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (process.env.CREDITGAUGE_DEBUG_SUMSPEED) {
      // eslint-disable-next-line no-console
      console.error("[diag-renderer] m_sumTokenInSpeed params=", JSON.stringify(params), "filter=", filter);
    }
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.sumApiMs === 0) return placeholderWithColor("m_sumTokenInSpeed", params, ctx);
    const tps = (agg.sumIn / agg.sumApiMs) * 1000;
    // speedScaleColor (:color|scale or none → scale; :color|<c> → that color);
    // prefix via labelFor(labelInSpeed); |valueOnly|true drops the prefix.
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
    // Prefix via labelFor(labelOutSpeed); |valueOnly|true drops the prefix.
    const userColor = passThroughOr<string>(params, ctx, "color");
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("outSpeed");
    const color =
      userColor === SCALE_COLOR_SENTINEL || userColor == null
        ? speedScaleColor("out", tps)
        : userColor;
    return `${color}${prefix}${formatSpeed(tps)}${RESET}`;
  },
  // Total count of API calls in window (see MODULES twin).
  m_sumApiCalls: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.calls === 0) return placeholderWithColor("m_sumApiCalls", params, ctx);
    // |valueOnly|true drops the "calls:" prefix.
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("apiCalls");
    return wrapValueDefault("m_sumApiCalls", agg.calls, `${prefix}${agg.calls}`, passThroughOr<string>(params, ctx, "color"));
  },
  // Start of the tick statistics window across the filtered JSONL rows:
  // min(s.startAt). Empty / all-legacy window → "start:n/a" placeholder.
  m_sumStartTime: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumStartTime", params, ctx);
    const abs = passThroughOr<string>(params, ctx, "abs") === "true";
    const color = passThroughOr<string>(params, ctx, "color");
    // |valueOnly|true drops the "start:" prefix.
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("startTime");
    // align=true + declared-windowId resolution → plan's resetStartAt anchor;
    // otherwise → empirical agg.firstAt branch below.
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
  // End of the tick statistics window across the filtered JSONL rows:
  // max(s.lastAt) — the "newest tick" in the window, the dual of
  // m_sumStartTime. Empty / all-legacy window → "end:n/a" placeholder.
  // align=true surfaces the plan window's close instant when a matching Window
  // ships one.
  m_sumEndTime: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumEndTime", params, ctx);
    const abs = passThroughOr<string>(params, ctx, "abs") === "true";
    const color = passThroughOr<string>(params, ctx, "color");
    // |valueOnly|true drops the "end:" prefix.
    const prefix = passThroughOr<string>(params, ctx, "valueOnly") === "true" ? "" : labelFor("endTime");
    // align=true + declared-windowId resolution → plan's resetAt close instant;
    // otherwise → empirical max(s.lastAt) fallback.
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
    // When `address` is non-empty, walk the pre-fetched remote payload's
    // `quote` (+ optional `author`) paths; on any failure FALL BACK to the local
    // QUOTES path. Output format: `wrap` missing/empty → raw `<quote>--<author>`
    // text; `wrap=<chars>` → wrapped in the 2-char pair (1-char duped / 2+-sliced).
    // The bare-body short-circuit (no `quote:` path → raw body verbatim) is
    // un-wrapped. The fetch path IGNORES `freq`/`lang` for rotation (remote
    // payloads are not window-bucketed).
    const address = params.address as string | undefined;
    const quoteRaw = (params.quote as string | undefined) ?? "";
    const authorRaw = params.author as string | undefined;
    const langRaw = params.lang as string | undefined;
    // `quote` arg present (even if empty) → address-mode branch; missing → local QUOTES.
    const hasQuote = (params.quote as string | undefined) !== undefined;
    // `wrap` is a 2-char string when supplied; empty/undefined = no-op (raw text).
    const wrapPair = passThroughOr<string>(params, ctx, "wrap");
    const applyWrap = (body: string, walkedJson: boolean): string => {
      // Bare-body short-circuit (no `quote:` path) → verbatim, no brackets.
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
        // Seed rainbow/hue from the body (not the wrapped text) so distinct
        // truncations of the same source get distinct bands.
        seed = stringHash(tQuote);
      } else {
        // Fetch / parse / quote-miss → fall back to local QUOTES (always wraps —
        // the local picker emits a well-formed body).
        const local = pickLocalQuote(params, langRaw, ctx);
        if (local === null) return INLINE_BADARG;
        text = applyWrap(local, true);
        seed = quoteLocalSeed(params, langRaw, ctx);
      }
    } else {
      // Local QUOTES path (default freq = 1h; schema resolver already validated).
      const local = pickLocalQuote(params, langRaw, ctx);
      if (local === null) return INLINE_BADARG;
      text = applyWrap(local, true);
      seed = quoteLocalSeed(params, langRaw, ctx);
    }
    const color = decodeColorParam(params.color as string | undefined);
    return applyColor(text, color, seed);
  },
  // Session-info / metadata inline renderers — mirror their MODULES
  // counterparts but accept an optional :color| override.
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
  m_provider: (params, ctx) => {
    if (ctx.currentProvider) return wrapPlainDefault("m_provider", ctx.currentProvider, params.color as string | undefined);
    const raw = process.env.ANTHROPIC_BASE_URL;
    if (raw) {
      try { return wrapPlainDefault("m_provider", new URL(raw).hostname.toLowerCase(), params.color as string | undefined); }
      catch { /* invalid URL → fall through */ }
    }
    return placeholderWithColor("m_provider", params, ctx);
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
  m_gitName: (params, ctx) => {
    const n = ctx.tokens?.repo?.name;
    if (n == null || n.length === 0) return placeholderWithColor("m_gitName", params, ctx);
    return wrapPlainDefault("m_gitName", n, params.color as string | undefined);
  },
  m_dirName: (params, ctx) => {
    const n = ctx.tokens?.cwd ? path.basename(ctx.tokens.cwd) : "";
    if (n.length === 0) return placeholderWithColor("m_dirName", params, ctx);
    return wrapPlainDefault("m_dirName", n, params.color as string | undefined);
  },
  m_branch: (params, ctx) => {
    const info = readGitInfo(ctx.tokens?.cwd);
    if (info?.branch == null) return placeholderWithColor("m_branch", params, ctx);
    const body = wrapPlainDefault("m_branch", info.branch, params.color as string | undefined);
    if (params.withStatus !== "true") return body;
    const suffixColor = info.dirty ? NAMED_PALETTE.brown : BRIGHT_GREEN;
    const glyph = info.dirty ? labelFor("gitDirty") : labelFor("gitClean");
    return `${body}${suffixColor}${glyph}${RESET}`;
  },
  m_gitStatus: (params, ctx) => {
    const info = readGitInfo(ctx.tokens?.cwd);
    if (info == null) return placeholderWithColor("m_gitStatus", params, ctx);
    const color = (params.color as string | undefined) ?? (info.dirty ? NAMED_PALETTE.brown : BRIGHT_GREEN);
    return wrapPlainDefault("m_gitStatus", info.dirty ? "dirty" : "clean", color);
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
  // Per-turn API-ms delta (mirror of MODULES with inline color support).
  m_apiMs: (params, ctx) => {
    const t = ctx.tokens;
    if (!t || !t.sessionId) return placeholderWithColor("m_apiMs", params, ctx);
    const r = getDeltaForRender();
    // |valueOnly|true drops the "api:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("apiMs");
    if (!r.hasMeasurement) {
      // Idle tick → cached deltaApiMs in STALE_COLOR (R7 — never expires);
      // with no prior measurement, placeholder. The user's |color| loses to
      // STALE_COLOR here (gray = "previous API call", matching the tps siblings).
      const cached = peekLastApiMs(t.sessionId, t.cwd);
      if (cached != null) {
        return wrapPlainDefault(
          "m_apiMs",
          `${prefix}${formatRemainingMs(cached)}`,
          STALE_COLOR,
        );
      }
      return placeholderWithColor("m_apiMs", params, ctx);
    }
    // Positive per-turn delta → brown default tint; 0 stays plain.
    return wrapValueDefault("m_apiMs", r.apiMs, `${prefix}${formatRemainingMs(r.apiMs)}`, params.color as string | undefined);
  },
  m_linesAdded: (params, ctx) => {
    const n = ctx.tokens?.cost.totalLinesAdded;
    if (n == null) return placeholderWithColor("m_linesAdded", params, ctx);
    return wrapPlainDefault("m_linesAdded", `+${n}`, params.color as string | undefined);
  },
  m_linesRemoved: (params, ctx) => {
    const n = ctx.tokens?.cost.totalLinesRemoved;
    if (n == null) return placeholderWithColor("m_linesRemoved", params, ctx);
    return wrapPlainDefault("m_linesRemoved", `-${n}`, params.color as string | undefined);
  },
  m_tokenInTotal: (params, ctx) => {
    const t = ctx.tokens;
    if (!t || t.totals.tokenTotalIn == null) return placeholderWithColor("m_tokenInTotal", params, ctx);
    // Bare default tint (brightGreen) on positive value; user |color| wins; 0 plain.
    // |valueOnly|true drops the "in:" prefix.
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
    // Bare default tint (red) on positive value; |valueOnly|true drops the prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("out");
    return wrapValueDefault(
      "m_tokenTotalOut",
      t.totals.tokenTotalOut,
      `${prefix}${formatCompactToken(t.totals.tokenTotalOut)}`,
      params.color as string | undefined,
    );
  },
  // total_input_tokens under the labelTotalIn label family — same input as
  // m_tokenInTotal, differing only in the labels.* axis. Positive value gets
  // the blue default tint; value=0 stays plain; null → placeholderWithColor.
  m_tokenTotalIn: (params, ctx) => {
    const t = ctx.tokens;
    if (!t || t.totals.tokenTotalIn == null) return placeholderWithColor("m_tokenTotalIn", params, ctx);
    // |valueOnly|true drops the "total:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("totalIn");
    return wrapValueDefault(
      "m_tokenTotalIn",
      t.totals.tokenTotalIn,
      `${prefix}${formatCompactToken(t.totals.tokenTotalIn)}`,
      params.color as string | undefined,
    );
  },
  // Project-wide count of valid API calls (accApiCalls in the project slot).
  // Renders "calls:N", "calls:0" when uninitialized (:nulldrop is a no-op —
  // never returns null). Cyan default tint on positive counts; value=0 plain;
  // an explicit |color| always applies even on the zero path.
  m_apiCalls: (params, ctx) => {
    const cwd = ctx.tokens?.cwd;
    // |valueOnly|true drops the "calls:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("apiCalls");
    if (!cwd) return wrapPlainDefault("m_apiCalls", `${prefix}0`, params.color as string | undefined);
    const acc = statusStore.readAccumulator("project", { cwd });
    if (!acc) return wrapPlainDefault("m_apiCalls", `${prefix}0`, params.color as string | undefined);
    return wrapValueDefault("m_apiCalls", acc.accApiCalls, `${prefix}${acc.accApiCalls}`, params.color as string | undefined);
  },
  // Inline form of m_contextWindowSize (capacity).
  m_contextWindowSize: (params, ctx) => {
    const sz = ctx.tokens?.contextWindow?.contextWindowSize;
    if (sz == null) return placeholderWithColor("m_contextWindowSize", params, ctx);
    // |valueOnly|true drops the "size:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("contextWindowSize");
    return wrapPlainDefault("m_contextWindowSize", `${prefix}${formatCompactToken(sz)}`, params.color as string | undefined);
  },
  // Inline form of m_contextUsedPercent.
  m_contextUsedPercent: (params, ctx) => {
    const pct = ctx.tokens?.contextWindow?.contextUsedPercent;
    if (pct == null) return placeholderWithColor("m_contextUsedPercent", params, ctx);
    // |valueOnly|true drops the "used:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("contextUsedPercent");
    return wrapPlainDefault("m_contextUsedPercent", `${prefix}${pct}%`, params.color as string | undefined);
  },
  // Inline form of m_contextRemainingPercent.
  m_contextRemainingPercent: (params, ctx) => {
    const pct = ctx.tokens?.contextWindow?.contextRemainingPercent;
    if (pct == null) return placeholderWithColor("m_contextRemainingPercent", params, ctx);
    // |valueOnly|true drops the "remain:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("contextRemainingPercent");
    return wrapPlainDefault("m_contextRemainingPercent", `${prefix}${pct}%`, params.color as string | undefined);
  },
  m_windowContext: (params, ctx) => {
    if (!ctx.contextWindow) return placeholderWithColor("m_windowContext", params, ctx);
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const valueOnly = params.valueOnly === "true";
    const color = params.color as string | undefined;
    if (valueOnly) return formatPercentOnly(ctx.contextWindow, mode, color);
    if (color) return formatOneChunkColored(ctx.contextWindow, mode, color);
    // :color| above always wins, so explicit user color stays sticky even on stale.
    return formatOneChunk(ctx.contextWindow, mode, cfg().bar.width, false);
  },
  // TTL gauge inline renderer: same as the MODULES entry but with |color|<c>
  // applied before the scale color (override always wins), the fixed-second
  // suffix, and the ACTIVE provider's cache row (see MODULES entry).
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
  // Inline form of m_sumTtlStatus: |color|<c> override wins before the
  // default 5-band scale. parseWindowScope reads from `merged` so an outer
  // m_template passthrough on model/window/align/term flows in (whitelist
  // extends TERM_PARAM since v0.9.8).
  m_sumTtlStatus: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return placeholderWithColor("m_sumTtlStatus", params, ctx);
    const key = statusStore.statKeyForFilter(filter);
    const entry = statusStore.peekStatAgeMs(key);
    if (!entry || entry.ttlMs <= 0) return placeholderWithColor("m_sumTtlStatus", params, ctx);
    const remaining = (entry.ttlMs - entry.ageMs) / entry.ttlMs;
    const userColor = params.color as string | undefined;
    const color = userColor ?? ttlStatusColor(remaining);
    const suffix = formatTtlSeconds(entry.ttlMs - entry.ageMs);
    return `${color}${ttlStatusChar(remaining)}${RESET} ${suffix}`;
  },
  // System RAM usage inline form. |color|<c> override wins before the
  // default tint (matches the wrapPlainDefault contract).
  m_memUsage: (params, ctx) => {
    const m = getMemUsage();
    if (!m) return placeholderWithColor("m_memUsage", params, ctx);
    // |valueOnly|true drops the "Mem:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("memUsage");
    return renderMemUsageBody(prefix, m.used, m.total, params.color as string | undefined);
  },
  // Context-window usage inline form. |color|<c> override wins before the
  // default tint.
  m_contextUsage: (params, ctx) => {
    const used = ctx.tokens?.totals?.tokenTotalIn;
    const total = ctx.tokens?.contextWindow?.contextWindowSize;
    if (used == null || total == null || total <= 0) return placeholderWithColor("m_contextUsage", params, ctx);
    const prefix = params.valueOnly === "true" ? "" : labelFor("contextUsage");
    return renderContextUsageBody(prefix, used, total, params.color as string | undefined);
  },
  // System RAM used bytes inline form. |color|<c> override wins.
  m_memUsed: (params, ctx) => {
    const m = getMemUsage();
    if (!m) return placeholderWithColor("m_memUsed", params, ctx);
    const prefix = params.valueOnly === "true" ? "" : labelFor("memUsed");
    const body = `${prefix}${formatMemBytes(m.used)}`;
    return wrapPlainDefault("m_memUsed", body, params.color as string | undefined);
  },
  // System RAM total bytes inline form. Same shape as m_memUsed but reads m.total.
  m_memTotal: (params, ctx) => {
    const m = getMemUsage();
    if (!m) return placeholderWithColor("m_memTotal", params, ctx);
    const prefix = params.valueOnly === "true" ? "" : labelFor("memTotal");
    const body = `${prefix}${formatMemBytes(m.total)}`;
    return wrapPlainDefault("m_memTotal", body, params.color as string | undefined);
  },
  // Inline form of m_windowMemUsage. |color|<c> → fixed-color chunk; no
  // |color| → formatOneChunk so band color follows percentBands. |display|
  // overrides the mode (used/remaining) like m_windowContext.
  m_windowMemUsage: (params, ctx) => {
    const m = getMemUsage();
    if (!m || m.total <= 0) return placeholderWithColor("m_windowMemUsage", params, ctx);
    const pct = (m.used / m.total) * 100;
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const valueOnly = params.valueOnly === "true";
    const color = params.color as string | undefined;
    const window: Window = { pct } as Window;
    if (valueOnly) return formatPercentOnly(window, mode, color);
    if (color) return formatOneChunkColored(window, mode, color);
    return formatOneChunk(window, mode, cfg().bar.width, false);
  },
  // Expand a registered lineTemplates fragment. The loader strips any
  // `m_template:` tokens from lineTemplates arrays (config.ts
  // applyOverrides), so the recursive call below cannot itself reach an
  // `m_template:` token; we `.slice()` the inner array defensively.
  // Missing key → warn + drop (renderer null path). Type mismatch → silent
  // drop (no warn; the user explicitly asked for a type filter).
  m_template: (params, ctx) => {
    const key = params.key as string;
    const inner = cfg().lineTemplates[key];
    if (!inner) {
      warn(
        `m_template: lineTemplates["${key}"] is undefined; dropping chunk`,
      );
      return null;
    }
    // `type` is the only intrinsic name; matches ctx.providerType verbatim
    // (`quota` / `balance` / `unknown`). Explicit |type:quota| / |type:balance|
    // is strict-match — an unknown provider does NOT match quota/balance, so
    // an explicit-type fragment is silently dropped (intentional: quota-gated
    // fragments want quota-only data). `type:unknown` renders only when no
    // configured provider matches. No `type` → fragment is provider-agnostic
    // and renders on every provider regardless of ctx.providerType (context-
    // level templates like `context` / `realtime` / `tokens_stat` read from
    // stdin + per-project state; the old v0.8.37 "default = plan" silently
    // dropped these on balance and unknown providers).
    const wantExplicit = params.type as "quota" | "balance" | undefined;
    if (wantExplicit != null && ctx.providerType !== wantExplicit) return null;
    // `providers:<id1,id2,...>` OR-match gate against the active provider
    // instance id. Absent → no gate. Present → drop unless ctx.currentProvider
    // is in the list. null ctx.currentProvider means ANTHROPIC_BASE_URL didn't
    // match any configured entry, so the gate returns false (drop).
    const wantProvidersRaw = params.providers as string | undefined;
    if (wantProvidersRaw != null) {
      const list = wantProvidersRaw.split(",").map(s => s.trim()).filter(s => s !== "");
      if (!list.includes(ctx.currentProvider ?? "")) {
        return null;
      }
    }
    // Passthrough: every param except the intrinsics (`key` is the lookup
    // target; `type` / `providers` are m_template-local gates, NOT values to
    // push to inner modules). Nested m_template is impossible (config.ts
    // strips them), so no merge with a pre-existing passThrough is needed.
    const passThrough: Record<string, ResolvedValue> = {};
    for (const [k, v] of Object.entries(params)) {
      if (k === "key" || k === "type" || k === "providers") continue;
      passThrough[k] = v as ResolvedValue;
    }
    const innerCtx: RenderContext = { ...ctx, passThrough };
    const lines = renderTemplate(inner.slice(), innerCtx);
    return lines.join("\n");
  },
};

// Two-class separator scheme for inline args (v0.8.33+). First-class `|` is
// structural (splits token into [moduleName, (implicitValue,), pair…]).
// Second-class `:` or `=` splits a pair at the FIRST occurrence; the rest of
// the string is the value (multi-`:` values are allowed — no error). The old
// v0.7.1+ position-based scheme made values unable to contain `|` and was
// unreadable; now `m_tokenIn|color:red` is natural, `m_label|GPU: A100|color:x`
// keeps `:` in the implicit value, `color:red:blue` → value "red:blue".
//
// Layout: implicit param → FIRST segment is its value (verbatim). Otherwise the
// FIRST segment, if present, must be a pair (`<name>[:=]<value>`). Each
// remaining segment is one pair.
//
// Returns null on: resolver returning null, pair missing `:` / `=`, empty
// pair name, or unknown param name in the named section.
function parseInlineArgs(
  remainder: string,
  schema: InlineSchema,
  key?: string,
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

  // `prefix` / `suffix` accepted on every m_* module (EXCEPT m_label /
  // m_template) via a global allowlist instead of ~50 schemas. Separators
  // (s_ / s_move) and the two excluded modules reject them → badarg.
  const allowAffix =
    key != null && key.startsWith("m_") && key !== "m_label" && key !== "m_template";

  // Each remaining segment must be a `<name>[:=]<value>` pair.
  for (; i < parts.length; i++) {
    const pair = parts[i]!;
    const sepIdx = pair.search(/[:=]/);
    // sepIdx === -1 → no separator; sepIdx === 0 → empty name.
    if (sepIdx <= 0) return null;
    const name = pair.slice(0, sepIdx);
    const raw = pair.slice(sepIdx + 1);
    if (name in schema.named) {
      const r = schema.named[name]!(raw);
      if (r === null) return null;
      out[name] = r;
    } else if (allowAffix && (name === "prefix" || name === "suffix")) {
      // Any string value including empty (empty = explicit "off"); affix values
      // are verbatim, no quote stripping. Use a trailing space (or s_) for
      // leading/trailing whitespace.
      out[name] = raw;
    } else {
      return null;
    }
  }
  return out;
}

// Try to expand an inline-args token. Returns:
//   - { kind: "ok", value } — chunk text (possibly empty)
//   - { kind: "badarg" }    — parse failed (warn + drop)
//   - undefined             — no schema for this prefix (caller falls through
//                             to the unknown-module path).
// `key` is the bare prefix (schema/renderer lookup key, no trailing colon);
// `skipLen` is how many chars to consume before the remainder starts.
// Distinguishes parse failure from "renderer returned null for valid args but
// missing data" (v0.3.4+), so modules like m_tokenOut don't wrongly warn.
type InlineResult =
  | { kind: "ok"; value: string | null; affix?: { prefix?: string; suffix?: string } }
  | { kind: "badarg" };

function expandInlineToken(
  tok: string,
  key: string,
  skipLen: number,
  ctx: RenderContext,
): InlineResult | undefined {
  const schema = INLINE_SCHEMAS[key];
  if (schema === undefined) return undefined;
  const params = parseInlineArgs(tok.slice(skipLen), schema, key);
  if (params === null) return { kind: "badarg" };
  const rendered = INLINE_RENDERERS[key]!(params, ctx);
  if (rendered === INLINE_BADARG) return { kind: "badarg" };
  // Thread explicit prefix/suffix out to renderTemplate (R1/R2/R3 rules).
  const affix: { prefix?: string; suffix?: string } = {};
  if (params.prefix !== undefined) affix.prefix = params.prefix as string;
  if (params.suffix !== undefined) affix.suffix = params.suffix as string;
  return {
    kind: "ok",
    value: rendered,
    ...(affix.prefix !== undefined || affix.suffix !== undefined ? { affix } : {}),
  };
}

// Strip SGR color codes so the auto-space rules can inspect the VISIBLE
// trailing character of the in-progress line.
function stripSgrCodes(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// Auto-space affix application for m_* module chunks. Explicit (|prefix:| /
// |suffix:|) always wins over the global defaults (cfg.prefixSpace /
// cfg.suffixSpace). Auto prefix fires only when the preceding token was an
// m_* module (R3), the line is non-empty (R1), and the visible line doesn't
// already end in whitespace (R2). Auto suffix fires only when the NEXT token
// is an m_* module (symmetric lookahead).
function applyAffix(
  piece: string,
  explicit: { prefix?: string; suffix?: string } | undefined,
  state: {
    prevIsModule: boolean;
    prevEndsWs: boolean;
    lineStart: boolean;
    nextIsModule: boolean;
  },
): string {
  const c = cfg();
  let prefix: string;
  if (explicit?.prefix !== undefined) {
    prefix = explicit.prefix;
  } else if (
    c.prefixSpace &&
    state.prevIsModule &&
    !state.lineStart &&
    !state.prevEndsWs
  ) {
    prefix = " ";
  } else {
    prefix = "";
  }
  let suffix: string;
  if (explicit?.suffix !== undefined) {
    suffix = explicit.suffix;
  } else if (c.suffixSpace && state.nextIsModule) {
    suffix = " ";
  } else {
    suffix = "";
  }
  if (prefix === "" && suffix === "") return piece;
  return prefix + piece + suffix;
}

export function renderTemplate(template: readonly string[], ctx: RenderContext): string[] {
  // Synthesize a guaranteed non-null `intervals` dict. The type allows it to
  // be absent (test helpers + legacy call sites supply the flat
  // shortInterval / midInterval / longInterval fields instead); module code
  // can then rely on `ctx.intervals[term]` without a nullable guard.
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
  // v1.0 — _renderDepth tracking and the deferred setPrevTick commit are
  // gone: processTick Stage 3 sets PREV_TICK_KEY once BEFORE render begins,
  // so every render context (outer, m_template inner) sees the same baseline
  // via peekPrevTick. No depth counter needed.
  const lines: string[] = [];
  let current = "";
  // Column cursor for `s_move|pos:<n>`. Kept in a closure (not on ctx) so a
  // render mid-flight (e.g. nested m_template) can't see a half-baked value.
  // Mutated on every chunk; reset to 0 on `\n`.
  let lineCursor = 0;
  // Auto-space tracking. prevIsModule = previous token was an m_* module
  // (incl. dropped ones / m_template); prevEndsWs = the line's visible text
  // ends in whitespace.
  let prevIsModule = false;
  let prevEndsWs = false;
  for (let i = 0; i < template.length; i++) {
    const tok = template[i];
    if (tok == null) continue;
    // Sync the closure cursor into ctx so inline-args renderers (s_move) can
    // read it. The renderer returns the padding chunk; the dispatcher's
    // normal accumulate step bumps the closure cursor by that chunk's width.
    ctx.lineCursor = lineCursor;
    let piece: string | null = null;
    // Per-token affix flags. isModule = this token receives an auto/explicit
    // affix (m_template excluded: the fragment's first inner module is at its
    // own line-start, so an outer auto-prefix would double-space);
    // explicitAffix = the |prefix:| / |suffix:| parsed from this token.
    let isModule = false;
    let explicitAffix: { prefix?: string; suffix?: string } | undefined;
    // Inline-args tokens (s_<name>|…, m_label|…, every other m_<name>|…). Only
    // fire when the token contains "|" so bare forms route through MODULES.
    if (tok.includes("|")) {
      // Provider-type filter (INLINE_TYPE_FILTERS): when the prefix carries a
      // tag that doesn't match ctx.providerType, silently drop the whole token
      // without entering the prefix chain — symmetric with MODULES' `type`
      // field. s_<name>|… is a separator (provider-agnostic), m_label/m_template
      // are provider-agnostic (absent from the filters), and unknown prefixes
      // are a no-op (the unknown-module warn path fires later). Separator is
      // `|` (v0.7.1+), see parseInlineArgs.
      const pipeAt = tok.indexOf("|");
      const inlinePrefix = pipeAt > 0 && tok.startsWith("m_")
        ? tok.slice(0, pipeAt)
        : "";
      if (inlinePrefix) {
        const need = INLINE_TYPE_FILTERS[inlinePrefix];
        if (need && need !== ctx.providerType) {
          // A known m_ module dropped by provider type still counts as a module
          // for the next token's auto-space.
          prevIsModule = true;
          continue;
        }
      }
      // Prefix → key/skipLen table. Keep in sync with INLINE_SCHEMAS /
      // INLINE_RENDERERS; a typo routes the token through MODULES (no match)
      // and falls to the unknown-module warn.
      let inline: InlineResult | undefined;
      if (tok.startsWith("s_")) {
        // s_<name>|… → skip "s_" (length 2), remainder starts at the alias
        // name. UNKNOWN aliases (numeric s_0, unknown s_xyz) emit the WHOLE
        // token as a literal, no parse, no warn; KNOWN aliases with bad args
        // still hit the badarg warn-and-drop path.
        //
        // s_move gets its own route: it isn't a NAMED separator (params, not
        // a literal body) so it's not in NAMED_SEPARATORS, but it still wants
        // the inline-args parse path — dispatch "s_move|" via skipLen=7. Bare
        // `s_move` (no `|`) hits the unknown-alias literal path (no params →
        // nothing to dispatch → emit verbatim).
        const aliasPart = tok.slice(2, tok.indexOf("|"));
        if (aliasPart === "move") {
          inline = expandInlineToken(tok, "s_move", 7, ctx);
        } else if (NAMED_SEPARATORS.has(aliasPart)) {
          inline = expandInlineToken(tok, "s_", 2, ctx);
        } else {
          inline = undefined;
        }
      } else if (tok.startsWith("m_label|")) {
        // m_label|<args> → skip "m_label|" (length 8); remainder is the string value.
        inline = expandInlineToken(tok, "m_label", 8, ctx);
      } else if (tok.startsWith("m_modeLabel|")) {
        // m_modeLabel|<args> → skip "m_modeLabel|" (length 12).
        inline = expandInlineToken(tok, "m_modeLabel", 12, ctx);
      } else if (tok.startsWith("m_windowQuota|")) {
        // Unified window module: `|term|short` (default) / mid / long select
        // the interval. Inline args: color, display, term, nulldrop. Skip 14.
        inline = expandInlineToken(tok, "m_windowQuota", 14, ctx);
      } else if (tok.startsWith("m_countdown|")) {
        // Unified countdown module. Same `term` arg as m_windowQuota. Skip 12.
        inline = expandInlineToken(tok, "m_countdown", 12, ctx);
      } else if (tok.startsWith("m_quota|")) {
        // Quota module — renders `${labelQuota}<used>/<limit>`. Same `term`
        // arg as m_windowQuota / m_countdown. Skip 8.
        inline = expandInlineToken(tok, "m_quota", 8, ctx);
      } else if (tok.startsWith("m_balance|")) {
        inline = expandInlineToken(tok, "m_balance", 10, ctx);
      } else if (tok.startsWith("m_age|")) {
        inline = expandInlineToken(tok, "m_age", 6, ctx);
      } else if (tok.startsWith("m_version|")) {
        inline = expandInlineToken(tok, "m_version", 10, ctx);
      } else if (tok.startsWith("m_pluginSource|")) {
        // Unique stem, no prefix-shadowing concern. Skip 15.
        inline = expandInlineToken(tok, "m_pluginSource", 15, ctx);
      } else if (tok.startsWith("m_tokenIn|")) {
        inline = expandInlineToken(tok, "m_tokenIn", 10, ctx);
      } else if (tok.startsWith("m_tokenOut|")) {
        inline = expandInlineToken(tok, "m_tokenOut", 11, ctx);
      } else if (tok.startsWith("m_tokenInTotal|")) {
        // Longer prefix MUST come before m_tokenIn — otherwise m_tokenIn
        // shadows m_tokenInTotal|color|….
        inline = expandInlineToken(tok, "m_tokenInTotal", 15, ctx);
      } else if (tok.startsWith("m_tokenTotalOut|")) {
        // 16 chars BEFORE m_tokenOut (12) so the longer literal wins —
        // otherwise `m_tokenTotalOut|color|red` matches m_tokenOut with
        // remainder "TotalOut|color|red" and parse-fails.
        inline = expandInlineToken(tok, "m_tokenTotalOut", 16, ctx);
      } else if (tok.startsWith("m_apiCalls|")) {
        // Skip "m_apiCalls|" (length 11).
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
        // Longer prefix listed first (19 chars) — siblings share the
        // "m_accToken" stem.
        inline = expandInlineToken(tok, "m_accTokenCachedIn", 19, ctx);
      } else if (tok.startsWith("m_accTokenTotalIn|")) {
        // Skip prefix+pipe (18 chars). Listed before m_accTokenIn / m_accTokenOut
        // to avoid prefix-shadow.
        inline = expandInlineToken(tok, "m_accTokenTotalIn", 18, ctx);
      } else if (tok.startsWith("m_accTokenInSpeed|")) {
        // Skip prefix+pipe (18). MUST be before m_accTokenIn (13) so the
        // longer literal wins.
        inline = expandInlineToken(tok, "m_accTokenInSpeed", 18, ctx);
      } else if (tok.startsWith("m_accTokenOutSpeed|")) {
        // Skip prefix+pipe (19). MUST be before m_accTokenOut (14) so the
        // longer literal wins.
        inline = expandInlineToken(tok, "m_accTokenOutSpeed", 19, ctx);
      } else if (tok.startsWith("m_accTokenCost|")) {
        // Skip prefix+pipe (15). Before m_accTokenOut (14) so the longer wins.
        inline = expandInlineToken(tok, "m_accTokenCost", 15, ctx);
      } else if (tok.startsWith("m_accTokenOut|")) {
        // Skip prefix+pipe (14).
        inline = expandInlineToken(tok, "m_accTokenOut", 14, ctx);
      } else if (tok.startsWith("m_accTokenIn|")) {
        // Skip prefix+pipe (13).
        inline = expandInlineToken(tok, "m_accTokenIn", 13, ctx);
      } else if (tok.startsWith("m_accApiMs|")) {
        // Skip prefix+pipe (11).
        inline = expandInlineToken(tok, "m_accApiMs", 11, ctx);
      } else if (tok.startsWith("m_accApiCalls|")) {
        // Skip prefix+pipe (14). Diverges from m_sumApiCalls (14) at index 5
        // ('c' vs 's').
        inline = expandInlineToken(tok, "m_accApiCalls", 14, ctx);
      } else if (tok.startsWith("m_accTokenHitRate|")) {
        // Skip prefix+pipe (18). Diverges from m_accTokenTotalIn (18) at
        // position 14 ('H' vs 'T'), so no shadow.
        inline = expandInlineToken(tok, "m_accTokenHitRate", 18, ctx);
      } else if (tok.startsWith("m_accStartTime|")) {
        // Skip prefix+pipe (15). Diverges from m_accTokenHitRate (18) at
        // position 14 ('S' vs 'H').
        inline = expandInlineToken(tok, "m_accStartTime", 15, ctx);
      } else if (tok.startsWith("m_sumTokenOutSpeed|")) {
        // Skip prefix+pipe (19). MUST be before m_sumTokenOut (14) so
        // `m_sumTokenOutSpeed|…` doesn't match startsWith("m_sumTokenOut|").
        // skipLen fixed 20→19 (off-by-one).
        inline = expandInlineToken(tok, "m_sumTokenOutSpeed", 19, ctx);
      } else if (tok.startsWith("m_sumEstQuota|")) {
        // Skip prefix+pipe (14). Grouped near the top of the m_sum* cluster.
        inline = expandInlineToken(tok, "m_sumEstQuota", 14, ctx);
      } else if (tok.startsWith("m_sumTokenCost|")) {
        // Skip prefix+pipe (15). Longer-first within the m_sum* cluster.
        inline = expandInlineToken(tok, "m_sumTokenCost", 15, ctx);
      } else if (tok.startsWith("m_sumTokenCachedIn|")) {
        // Skip prefix+pipe (19). Siblings differ at later positions.
        inline = expandInlineToken(tok, "m_sumTokenCachedIn", 19, ctx);
      } else if (tok.startsWith("m_sumTokenInSpeed|")) {
        // Skip prefix+pipe (18). MUST be before m_sumTokenIn (13) so
        // `m_sumTokenInSpeed|…` doesn't match startsWith("m_sumTokenIn|").
        // skipLen fixed 19→18 (off-by-one sliced leading 'n' off
        // 'nulldrop|false' → params=null).
        inline = expandInlineToken(tok, "m_sumTokenInSpeed", 18, ctx);
      } else if (tok.startsWith("m_sumTokenTotalIn|")) {
        inline = expandInlineToken(tok, "m_sumTokenTotalIn", 18, ctx);
      } else if (tok.startsWith("m_sumTokenHitRate|")) {
        // Skip prefix+pipe (18). User-facing prefix ("hit:N%") unchanged.
        inline = expandInlineToken(tok, "m_sumTokenHitRate", 18, ctx);
      } else if (tok.startsWith("m_sumTokenOut|")) {
        inline = expandInlineToken(tok, "m_sumTokenOut", 14, ctx);
      } else if (tok.startsWith("m_sumApiCalls|")) {
        inline = expandInlineToken(tok, "m_sumApiCalls", 14, ctx);
      } else if (tok.startsWith("m_sumStartTime|")) {
        // Skip prefix+pipe (15). Diverges from 14-char siblings at
        // position 6 ('S'), so no shadow.
        inline = expandInlineToken(tok, "m_sumStartTime", 15, ctx);
      } else if (tok.startsWith("m_sumEndTime|")) {
        // Skip prefix+pipe (13). Shares length with m_sumTokenIn but
        // diverges at position 6 ('E' vs 'T'), so no shadow.
        inline = expandInlineToken(tok, "m_sumEndTime", 13, ctx);
      } else if (tok.startsWith("m_sumTokenIn|")) {
        inline = expandInlineToken(tok, "m_sumTokenIn", 13, ctx);
      } else if (tok.startsWith("m_sumApiMs|")) {
        inline = expandInlineToken(tok, "m_sumApiMs", 11, ctx);
      } else if (tok.startsWith("m_quote|")) {
        // Skip "m_quote|" (length 8).
        inline = expandInlineToken(tok, "m_quote", 8, ctx);
      } else if (tok.startsWith("m_session|")) {
        inline = expandInlineToken(tok, "m_session", 10, ctx);
      } else if (tok.startsWith("m_model|")) {
        inline = expandInlineToken(tok, "m_model", 8, ctx);
      } else if (tok.startsWith("m_provider|")) {
        inline = expandInlineToken(tok, "m_provider", 11, ctx);
      } else if (tok.startsWith("m_effort|")) {
        inline = expandInlineToken(tok, "m_effort", 9, ctx);
      } else if (tok.startsWith("m_repo|")) {
        inline = expandInlineToken(tok, "m_repo", 7, ctx);
      } else if (tok.startsWith("m_branch|")) {
        // Skip "m_branch|" (length 9).
        inline = expandInlineToken(tok, "m_branch", 9, ctx);
      } else if (tok.startsWith("m_gitStatus|")) {
        // Skip "m_gitStatus|" (length 12).
        inline = expandInlineToken(tok, "m_gitStatus", 12, ctx);
      } else if (tok.startsWith("m_gitName|")) {
        // Skip "m_gitName|" (length 10).
        inline = expandInlineToken(tok, "m_gitName", 10, ctx);
      } else if (tok.startsWith("m_dirName|")) {
        // Skip "m_dirName|" (length 10).
        inline = expandInlineToken(tok, "m_dirName", 10, ctx);
      } else if (tok.startsWith("m_ccVersion|")) {
        // Skip "m_ccVersion|" (length 12).
        inline = expandInlineToken(tok, "m_ccVersion", 12, ctx);
      } else if (tok.startsWith("m_ccversion|")) {
        // Deprecated lowercase alias — pre-rename configs may still use it.
        inline = expandInlineToken(tok, "m_ccversion", 12, ctx);
      } else if (tok.startsWith("m_sessionApiDuration|")) {
        // Longer prefix must come BEFORE m_sessionDuration (same
        // prefix-shadowing reason as the m_tokenIn family).
        inline = expandInlineToken(tok, "m_sessionApiDuration", 21, ctx);
      } else if (tok.startsWith("m_sessionDuration|")) {
        inline = expandInlineToken(tok, "m_sessionDuration", 18, ctx);
      } else if (tok.startsWith("m_apiMs|")) {
        // Per-turn API-ms delta. No shadow concern: m_apiMs (8) and
        // m_accApiMs (11) diverge at position 3, so startsWith is exact.
        inline = expandInlineToken(tok, "m_apiMs", 8, ctx);
      } else if (tok.startsWith("m_linesAdded|")) {
        inline = expandInlineToken(tok, "m_linesAdded", 13, ctx);
      } else if (tok.startsWith("m_linesRemoved|")) {
        // Skip "m_linesRemoved|" (length 15).
        inline = expandInlineToken(tok, "m_linesRemoved", 15, ctx);
      } else if (tok.startsWith("m_contextWindowSize|")) {
        // Skip prefix+pipe (20 chars).
        inline = expandInlineToken(tok, "m_contextWindowSize", 20, ctx);
      } else if (tok.startsWith("m_contextUsedPercent|")) {
        inline = expandInlineToken(tok, "m_contextUsedPercent", 21, ctx);
      } else if (tok.startsWith("m_contextRemainingPercent|")) {
        inline = expandInlineToken(tok, "m_contextRemainingPercent", 25, ctx);
      } else if (tok.startsWith("m_windowContext|")) {
        inline = expandInlineToken(tok, "m_windowContext", 16, ctx);
      } else if (tok.startsWith("m_template|")) {
        // m_template|<key>[|type|<quota|balance|unknown>]
        // [|providers|<id1,id2>][|nulldrop|<bool>] → skip 11. Named args:
        // `type` (provider-type gate) and plural `providers` (per-instance
        // OR-match); there is no `mode` arg.
        inline = expandInlineToken(tok, "m_template", 11, ctx);
      } else if (tok.startsWith("m_cacheTtlStatus|")) {
        // Skip prefix+pipe (17).
        inline = expandInlineToken(tok, "m_cacheTtlStatus", 17, ctx);
      } else if (tok.startsWith("m_statTtlStatus|")) {
        // Skip prefix+pipe (16).
        inline = expandInlineToken(tok, "m_statTtlStatus", 16, ctx);
      } else if (tok.startsWith("m_sumTtlStatus|")) {
        // Skip prefix+pipe (15). Differs from other m_sum* prefixes at the
        // 5th char after "m_sum" ('T'), so no collision.
        inline = expandInlineToken(tok, "m_sumTtlStatus", 15, ctx);
      } else if (tok.startsWith("m_memUsage|")) {
        // Skip prefix+pipe (11).
        inline = expandInlineToken(tok, "m_memUsage", 11, ctx);
      } else if (tok.startsWith("m_windowMemUsage|")) {
        // Skip prefix+pipe (17).
        inline = expandInlineToken(tok, "m_windowMemUsage", 17, ctx);
      } else if (tok.startsWith("m_memUsed|")) {
        // Skip prefix+pipe (10).
        inline = expandInlineToken(tok, "m_memUsed", 10, ctx);
      } else if (tok.startsWith("m_contextUsage|")) {
        // Skip prefix+pipe (15).
        inline = expandInlineToken(tok, "m_contextUsage", 15, ctx);
      } else if (tok.startsWith("m_memTotal|")) {
        // Skip prefix+pipe (11).
        inline = expandInlineToken(tok, "m_memTotal", 11, ctx);
      }
      // Parse failure (bad |color|, unknown param, odd segment count)
// → warn + drop. Renderer returning null for valid args (e.g. m_tokenOut
// when stdin lacks total_output_tokens) is NOT a parse failure — silently
// skip, same as the bare MODULES path (v0.3.4+: previously conflated the two
// and wrongly warned "unknown module"). Unknown s_*|… aliases leave `inline`
// undefined → skip badarg, fall to `else`, emit the whole token verbatim.
      if (inline?.kind === "badarg") {
        warnUnknownModuleOnce(tok);
        // A badarg-dropped m_ module still counts as a module for the next
        // token's auto-space (same preserve-spacing-on-drop as the
        // provider-type drop).
        prevIsModule = true;
        continue;
      } else {
        piece = inline?.kind === "ok" ? inline.value : tok;
        if (inline?.kind === "ok") {
          // Inline m_* modules carry the affix. m_template is excluded (the
          // fragment's first inner module is at its own line-start) but still
          // counts as a module predecessor via prevIsModule below.
          isModule = tok.startsWith("m_") && !tok.startsWith("m_template|");
          if (inline.affix) explicitAffix = inline.affix;
        }
      }
    } else if (tok.startsWith("s_")) {
      // Bare s_<…> fast path (no-pipe shorthand; `s_<…>|color|<c>` is
      // handled by the inline path above). Only named aliases resolve to a
      // literal; any other s_* suffix is emitted verbatim, no parse, no warn.
      const suffix = tok.slice(2);
      const alias = NAMED_SEPARATORS.get(suffix);
      if (alias !== undefined) {
        piece = alias;
      } else {
        // Unknown s_* suffix → emit the original token verbatim (no compat
        // fallback; the user gets exactly what they wrote).
        piece = tok;
      }
    } else if (tok.startsWith("m_")) {
      const mod = MODULES[tok];
      if (!mod) {
        // Unknown m_* module → emit the original token verbatim, no warn.
        piece = tok;
      } else {
        // Provider-type filter: type-tagged modules (m_windowQuota: "quota",
        // m_balance: "balance") silently drop on a non-matching provider type.
        // Untagged modules (m_token*, m_age, m_version) are provider-agnostic
        // and emit on every ctx.
        if (mod.type != null && mod.type !== ctx.providerType) {
          // A type-dropped module still counts as a module for the next
          // token's auto-space (spacing survives the drop).
          prevIsModule = true;
          continue;
        }
        piece = mod(ctx);
        // A rendered bare m_ module gets the auto affix.
        isModule = true;
      }
    } else {
      // Anything that didn't start with `m_` or `s_` (or match an inline
      // prefix) is a free-form literal token, emitted verbatim — useful for
      // dropping a free-text label like `prompt: ` or `STATUS` without escaping.
      piece = tok;
    }
    // Apply prefix/suffix to m_* module chunks, then update adjacency state.
    if (isModule && piece != null && piece !== "") {
      piece = applyAffix(piece, explicitAffix, {
        prevIsModule,
        prevEndsWs,
        lineStart: current === "",
        nextIsModule: template[i + 1]?.startsWith("m_") ?? false,
      });
    }
    prevIsModule = isModule || tok.startsWith("m_");
    if (piece == null || piece === "") continue;
    // Split the piece on '\n' so a "\n" separator (or a module embedding
    // newlines) produces multi-line output. First segment appends to the
    // in-progress line; further segments start new lines.
    const segments = piece.split("\n");
    for (let j = 0; j < segments.length; j++) {
      const seg = segments[j]!;
      if (j === 0) {
        current += seg;
      } else {
        // Push the completed line and start a new one. Skip empty lines
        // that arise from consecutive "\n\n" splits.
        if (current.length > 0) lines.push(current);
        current = seg;
      }
      // Update the visible-cell cursor on every segment (what `s_move|pos:<n>`
      // reads via ctx.lineCursor). ANSI SGR bytes are stripped before counting
      // so color output doesn't inflate the column count. Each `\n` resets the
      // cursor to 0 because the new line starts at column 0.
      if (j < segments.length - 1) {
        lineCursor = visibleCellLength(seg);
      } else {
        lineCursor += visibleCellLength(seg);
      }
    }
    // After the whole piece lands, record whether the line's VISIBLE text now
    // ends in whitespace (R2 check for the next token's auto-prefix).
    // ANSI-stripped so colored chunks don't hide a trailing space.
    prevEndsWs = /\s$/.test(stripSgrCodes(current));
  }
  // Flush whatever's left in the in-progress line.
  if (current.length > 0) lines.push(current);
  // v1.0 — setPrevTick fires from the -processor BEFORE render begins, so no
  // deferred commit / depth counter is needed here.
  return lines;
}

// Top-level renderer used by dispatch.ts. Selects the right template for the
// provider, builds the context, and force-appends the m_age stale suffix when
// the result is `stale` AND the template didn't already emit it — preserving
// the invariant that a stale-on-error tick always carries a visible
// broken-chain indicator regardless of lineTemplate.
export function renderProviderLine(
  provider: import("./types.ts").Provider,
  ctx: Omit<RenderContext, "intervals" | "balance" | "tokens" | "contextWindow" | "providerType"> & {
    // Open-ended `intervals` dict replaces the v0.9.0 trio of fixed slots
    // (shortInterval / midInterval / longInterval). Caller passes the parsed
    // Quota's intervals dict directly. Missing → empty dict → "all slots
    // null" → per-module placeholder fires.
    intervals?: Record<string, Interval | null>;
    // Back-compat: legacy callers/tests pass the flat slots. When present and
    // `intervals` is absent, we fold them into the reserved keys
    // (`short` / `mid` / `long`).
    shortInterval?: Interval | null;
    midInterval?: Interval | null;
    longInterval?: Interval | null;
    balance?: BalanceLike | null;
    // Optional for back-compat with callers that don't thread a TokenSnapshot.
    // Defaults to null → all m_token* modules skip rendering.
    tokens?: TokenSnapshot | null;
    // Optional. Synthesized from tokens.contextWindow.contextUsedPercent when
    // omitted. Only read by m_windowContext.
    contextWindow?: Window | null;
    // Optional. Pre-fetched quote bodies from `preFetchQuotes` (src/api.quote.ts);
    // absent → m_quote falls back to local QUOTES.
    quoteBodies?: Map<string, string>;
    // Optional. Which side of the user-vs-builtin fence the active provider's
    // plugin was loaded from, or `"missing"` when the matched id has no plugin.
    // Populated by dispatch.ts:buildProviderLine from the per-provider cache
    // row. Absent → null → m_pluginSource drops to no-op (no "source:n/a" for
    // unconfigured users). `"missing"` surfaces as ❗ so a misconfigured
    // provider id (e.g. providers.copilot without the plugin) is loud.
    pluginSource?: "user" | "builtin" | "missing" | null;
  },
): string {
  // Synthesize the contextWindow Window from
  // tokens.contextWindow.contextUsedPercent when not supplied. formatOneChunk
  // only reads `pct`, so this minimal shape is enough.
  const usedPct = ctx.tokens?.contextWindow?.contextUsedPercent;
  const contextWindow =
    ctx.contextWindow !== undefined
      ? ctx.contextWindow
      : usedPct != null
        ? { pct: usedPct }
        : null;
  // Template picked by provider TYPE via providerTypeFor ("quota"/"balance"/
  // "unknown") — the indirection lets a third provider slot in without code
  // changes, and the type is threaded to ctx so per-module `type` filters
  // compare against it.
  //
  // `statuslineTemplate` accepts an array (raw token list) or a string-form
  // preset name resolved against DEFAULT_STATUSLINE_PRESETS (simple/compact/
  // standard) at config load; fragments (DEFAULT_LINE_TEMPLATES) are
  // referenced via `m_template|<fragment>`.
  const providerType = providerTypeFor(provider);
  const cfgSnap = cfg();
  const fullCtx: RenderContext = {
    mode: ctx.mode,
    nowMs: ctx.nowMs,
    // Prefer explicit `intervals` dict (new dispatch path); fall back to
    // folding the flat slots (legacy callers + tests). Neither → "all slots
    // null" so per-module placeholders fire.
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
    // Active provider instance id (e.g. "minimax"). Drives
    // `m_template|<key>|providers:<id1,id2>` OR-match gates; null when
    // ANTHROPIC_BASE_URL didn't match a configured entry → the gate returns
    // false and the fragment drops.
    currentProvider: provider,
    // Single-owner dedup ref, propagated by reference through nested
    // m_template expansions. Each m_age instance (bare + inline) checks/sets
    // this slot so the whole render emits the broken-chain glyph at most once.
    ageEmittedRef: { value: false },
    // Per-tick quote body map from preFetchQuotes. Undefined when no
    // address-mode m_quote token is active.
    quoteBodies: ctx.quoteBodies,
    // Default to null so legacy callers (tests constructing ctx inline) don't
    // have to thread the field; m_pluginSource drops to no-op in that case.
    pluginSource: ctx.pluginSource ?? null,
    // Default provider filter for m_sum* modules. Computed from
    // ANTHROPIC_BASE_URL; empty/unset → undefined (skip provider filtering).
    // Used by parseWindowScope.
    providerBaseUrl: (() => {
      const raw = process.env.ANTHROPIC_BASE_URL ?? "";
      return raw ? normalizeUrl(raw) : undefined;
    })(),
  };
  // statuslineTemplate is normalized to `string[]` at config load (string-form
  // preset names resolve to their body there). `.slice()` is snapshot-defensive
  // so subsequent external mutations can't leak into the render.
  const template = cfgSnap.statuslineTemplate.slice();
  const lines = renderTemplate(template, fullCtx);
  // Forced visibility for the age annotation: when the user did NOT put m_age
  // in their lineTemplate AND the fetch was stale, append the broken-chain
  // suffix (v0.2.16 invariant: a network failure is always visible).
  //
  // Dedup is render-recursion-aware: `fullCtx.ageEmittedRef.value` flips true
  // the moment ANY m_age instance (bare or inline, top-level or nested via
  // m_template) fires — replacing the old top-level string scan that missed
  // m_age inside fragments and double-appended the glyph.
  if (
    ctx.ageMs != null &&
    ctx.stale &&
    fullCtx.ageEmittedRef !== undefined &&
    !fullCtx.ageEmittedRef.value
  ) {
    fullCtx.ageEmittedRef.value = true;
    const suffix = formatStaleSuffix(ctx.ageMs, false);
    // The suffix carries its own SGR close, so it slots onto the last line
    // regardless of how many lines the template emitted.
    if (lines.length === 0) {
      lines.push(suffix);
    } else {
      lines[lines.length - 1] = (lines[lines.length - 1] ?? "") + suffix;
    }
  }
  return lines.join("\n");
}
