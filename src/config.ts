// User-tunable configuration for topgauge (ToPGauge).
//
// Loaded once at startup from
//   ~/.claude/plugins/topgauge/config.json
// (Windows: %USERPROFILE%\.claude\plugins\topgauge\config.json).
//
// Missing file → DEFAULT_CONFIG silently. Malformed JSON or a single
// bad field → one stderr line + DEFAULT_CONFIG. Never crashes.
//
// Precedence: config.json > hardcoded defaults. The earlier
// TOPGAUGE_DISPLAY env var is gone — anyone who used it must migrate
// to config.json's `display` field (see README "Configuration").

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CompareMethod,
  ProviderEntry,
  ProviderType,
} from "./types.ts";
import * as diagnostics from "./diagnostics.ts";
import {
  DEFAULT_PROVIDERS,
  VALID_COMPARE_METHODS,
  VALID_PROVIDER_TYPES,
} from "./config.providers.ts";

import {
  DEFAULT_LINE_TEMPLATES,
  DEFAULT_STATUSLINE_PRESETS,
  DEFAULT_STATUSLINE_TEMPLATE,
  type LineTemplates,
  type StatuslineTemplate,
} from "./config.template.ts";

export {
  DEFAULT_LINE_TEMPLATES,
  DEFAULT_STATUSLINE_PRESETS,
  DEFAULT_STATUSLINE_TEMPLATE,
};
export type { LineTemplates, StatuslineTemplate };

// 256-color SGR sequences. The colors are kept as plain ANSI strings
// (not symbolic names) so a downstream user can copy/paste a value
// from `console.log` and paste it into config.json without translation.
// "brightBlack" is accepted on input as a shortcut for "\x1b[90m".
const DEFAULT_COLORS = {
  brightGreen: "\x1b[38;5;41m",
  darkGreen: "\x1b[38;5;29m",
  yellow: "\x1b[38;5;220m",
  orange: "\x1b[38;5;208m",
  red: "\x1b[38;5;196m",
  stale: "\x1b[90m",
  // v0.6.0+ — broken-chain color (used by formatStaleSuffix when
  // the m_age "⛓️‍💥 X ago" annotation fires, i.e. the fetch failed
  // and we're rendering the last successful cached value). Distinct
  // from `colors.stale` (gray, used for the fresh 🔗 annotation) so
  // the user can read the two states at a glance.
  broken: "\x1b[31m",
};

// v0.4.0+ — 3-band palette for the m_tokenHitRate module. Higher is
// better: cache_read / (cache_read + cache_creation) ≥ 80% → green,
// 50–80% → yellow, <50% → orange. Bands chosen to match the visual
// vocabulary of the existing 5-band thresholds (green/yellow/orange)
// so the cache-hit rate reads as "another health indicator" rather
// than a separate dimension.
const DEFAULT_CACHE_HIT_COLORS = {
  good: "\x1b[38;5;41m", // bright green, ≥ 80%
  warn: "\x1b[38;5;220m", // yellow, 50–80%
  bad: "\x1b[38;5;208m", // orange, < 50%
};

const DEFAULT_CACHE_HIT_THRESHOLDS: [number, number] = [50, 80];

const DEFAULT_THRESHOLDS: {
  percentBands: [number, number, number, number];
  balanceBands: [number, number, number, number];
} = {
  // 5-band cutoffs for MiniMax percentage rendering.
  percentBands: [60, 70, 80, 90],
  // 5-band cutoffs for DeepSeek balance rendering (absolute units, not %).
  balanceBands: [5, 10, 20, 50],
};

const DEFAULT_CURRENCY: {
  prefixes: Record<string, string>;
  fallback: string;
  default: string;
} = {
  prefixes: { USD: "$", CNY: "￥", RMB: "￥" },
  // Fallback prefix when the API returns an unknown currency code.
  fallback: "￥",
  // Currency assumed when an entry omits its `currency` field.
  default: "CNY",
};

const DEFAULT_STALE = {
  // Emoji pair prepended to the "X ago" annotation when the fetch
  // failed. The broken glyph is what the user actually sees (no
  // leading separator) — it's the indicator of network failure.
  // v0.2.17: removed the legacy `separator` field. The stale
  // annotation is now appended directly after the template output
  // (no leading separator). If a custom separator is needed, place
  // it in the lineTemplate explicitly.
  ageEmoji: { healthy: "🔗", broken: "⛓️‍💥" },
  // Glyphs appended to the reset countdown (e.g. "2h3m🕛"). The picker
  // indexes into this array by `remainingMs / resetDurationMs`, so the
  // array reads left-to-right as "few remaining → many remaining":
  //   index 0        : remainingMs ≈ 0 (just reset / about to reset)
  //   last index     : remainingMs ≈ resetDurationMs (fresh)
  // `min(…, length-1)` clamps ratio=1.0 to the last entry instead of
  // running off the end. Twelve clock-face emoji give a smooth visual
  // ramp from 12 o'clock (🕛, least remaining) around to 1 o'clock
  // (🕐, most remaining); two glyphs give a binary "hourglass" pair
  // (full/empty); one glyph is a static indicator. Providers without
};

const DEFAULT_BAR = {
  width: 8,
  filled: "▓",
  empty: "░",
};

// v0.4.0+ — number-format knobs for the m_token* modules. Two layers:
//   `thresholds` drives the human-compact notation (matches formatRemainingMs:
//   below the smallest threshold → raw integer; otherwise k / M suffix).
//   `precision` controls decimal places per tier (currently 1; tests can
//   bump to 2 if a user wants more granularity).
//   `speedPrecision` / `cachePctPrecision` independently tune t/s and %.
//   `cacheHitThresholds` mirrors DEFAULT_CACHE_HIT_THRESHOLDS — exposed
//   as a config field so a user who wants different bands can override
//   without touching the colors block.
// v0.4.0+ — 5-band scale thresholds for the m_tokenInSpeed /
// m_tokenOutSpeed modules (`:color:scale` / bare default). The
// bands are picked at the FAST end: tps >= bands[3] → fastest
// band (bright green); tps < bands[0] → slowest band (red).
// `in` uses 5× the `out` thresholds because input streams
// naturally run hotter than output — without the 5× factor the
// `in` module would always read as "fastest green", which
// would defeat the purpose of a gradient. Users can override
// both bands in config.json's `tokenFormat.speedScaleBands`.
const DEFAULT_SPEED_SCALE_BANDS = {
  in: [50, 100, 200, 400] as [number, number, number, number],
  out: [10, 20, 40, 80] as [number, number, number, number],
};

const DEFAULT_TOKEN_FORMAT = {
  // [<1k] → "342", [<1M] → "12.3k", [≥1M] → "1.2M". Aligns with the
  // readable upper bound of typical session totals (rare to see > 1M
  // tokens in a single Claude Code session, but possible over a 7d window).
  thresholds: [1_000, 1_000_000] as [number, number],
  precision: 1,
  speedPrecision: 1,
  cachePctPrecision: 1,
  cacheHitThresholds: DEFAULT_CACHE_HIT_THRESHOLDS,
  speedScaleBands: DEFAULT_SPEED_SCALE_BANDS,
};

type DisplayMode = "used" | "remaining";

// Top-level time-format knobs. They govern ALL time rendering in the
// plugin — reset countdown AND stale-age suffix AND any future caller
// (e.g. an "elapsed since session start" line). Keeping them at top
// level (rather than buried under `stale`) means a user who wants
// second-level granularity anywhere gets it everywhere consistently.
type TimeFormat = {
  // Smallest unit shown on time countdowns. Units BELOW this granularity
  // are never rendered directly — when all remaining units collapse to
  // zero (or get truncated), the formatter falls back to "<1<minUnit>"
  // (positive remaining) or "0<minUnit>" (past-due).
  //   "m":           sub-minute shows as "<1m".
  //   "s" (default): sub-minute shows as actual seconds (e.g. "47s").
  //   "h":           sub-hour shows as "<1h" (useful for windows where
  //                  minute-precision is noise — e.g. the weekly reset).
  minUnit: "m" | "s" | "h";
  // How many non-zero units to display. After dropping units below
  // minUnit AND dropping leading zero units, takes up to maxUnitCount
  // from the start — including any internal/trailing zero units.
  // Clamped to [1, 4]. Examples (minUnit="m"):
  //   1d2h3m4s → "1d2h"
  //   2h3m4s   → "2h3m"
  //   2h0m     → "2h0m"   (NOT "2h" — internal zeros preserved)
  //   0d0h5m   → "5m"     (leading zeros dropped)
  //   0d0h30s  → "<1m"    (all extracted units zero under minUnit)
  maxUnitCount: number;
};

const DEFAULT_TIME_FORMAT: TimeFormat = {
  minUnit: "s",
  maxUnitCount: 2,
};

// Reset-countdown visualization. Belongs with the countdown, NOT with
// the stale-on-error annotation (which is a separate concern).
type Countdown = {
  // Glyphs appended to the reset countdown (e.g. "2h3m🕛"). The picker
  // indexes into this array by remainingMs / resetDurationMs, so the array
  // reads left-to-right as "few remaining → many remaining":
  //   index 0  : remainingMs ≈ 0 (just reset / about to reset)
  //   last     : remainingMs ≈ resetDurationMs (fresh)
  // min(..., length-1) clamps ratio=1.0 to the last entry. Twelve clock-face
  // emoji give a smooth visual ramp from 12 o'clock (🕛, least remaining)
  // around to 1 o'clock (🕐, most remaining); two glyphs give a binary
  // hourglass pair; one glyph is static. Providers without start_time
  // (DeepSeek, legacy) fall back to index 0.
  resetArrows: string[];
};

const DEFAULT_COUNTDOWN: Countdown = {
  resetArrows: [
    "🕛",
    "🕚",
    "🕙",
    "🕘",
    "🕗",
    "🕖",
    "🕕",
    "🕔",
    "🕓",
    "🕒",
    "🕑",
    "🕐",
  ],
};


// Declarative provider list. Each entry describes URL matching,
// rendering overrides, interval/currency mappings, and credentials.
// Acquisition and parsing are owned by the dynamically imported plugin
// selected by the provider key.
const DEFAULT_CONFIG: {
  cacheTtlMs: number;
  fetchTimeoutMs: number;
  display: DisplayMode;
  modeLabels: { used: string; remaining: string; balance: string };
  // v0.8.0+ — top-level prefix labels for the per-turn / acc /
  // sum-avg token-stat axes. Every value already includes its
  // trailing colon (e.g. "in:") so the renderer can just concat.
  //
  // v0.8.22+ — names renamed to 1:1 mirror the `m_*` module names
  // they back, so a reader looking at `m_tokenIn` immediately knows
  // to look at `labels.labelTokenIn`. Each label name is shared
  // across the per-turn / acc / sum-avg module of the same family
  // (e.g. `labelTokenIn` covers m_tokenIn / m_accTokenIn /
  // m_sumTokenIn); per-family override was deliberately NOT
  // exposed — the three family variants render the same axis
  // (in-flow / out-flow / cache-read / …) and per-family split
  // would be confusing rather than useful.
  //
  // Defaults reproduce the v0.8.x hardcoded literal strings so
  // existing renders stay byte-identical until the user overrides
  // labels.* in config.json. Old v0.8.13–v0.8.21 names
  // (labelIn / labelOut / labelCacheIn / labelTotalIn /
  // labelApi / labelApiCalls / labelInSpeed / labelOutSpeed /
  // labelMemUsage) are accepted as deprecated aliases — see
  // `applyOverrides` for the migration warning + value mirror.
  labels: {
    // per-turn / acc / sum-avg of token-IN flow
    labelTokenIn: string;
    // per-turn / acc / sum-avg of token-OUT flow
    labelTokenOut: string;
    // per-turn / acc / sum-avg of cache-read flow
    labelTokenCachedIn: string;
    // per-turn / acc / sum-avg of total-IN (input + cache-read)
    labelTokenTotalIn: string;
    // per-turn / acc / sum-avg of API roundtrip time (dhms body)
    labelApiMs: string;
    // per-turn / acc / sum-avg of API call count (integer body)
    labelApiCalls: string;
    // v0.8.13+ — per-turn / acc / sum-avg of token-IN throughput
    // (t/s). Shares `labelTokenIn` semantics across families.
    labelTokenInSpeed: string;
    // per-turn / acc / sum-avg of token-OUT throughput (t/s).
    labelTokenOutSpeed: string;
    // v0.8.17+ — system RAM usage label exposed via m_memUsage.
    labelMemUsage: string;
    // v0.8.22+ — cache hit-rate ratio (lifted out of the v0.8.x
    // R8 hardcoded "hit:" prefix into the labels namespace).
    labelTokenHitRate: string;
    // v0.8.23+ — context-window occupancy / capacity / pct
    // prefixes (were hardcoded "size:" / "size:" / "used:" /
    // "remain:" in v0.8.22). Defaults preserve the literals so
    // existing renders stay byte-identical.
    labelContextSize: string;
    labelContextWindowsSize: string;
    labelContextUsedPercent: string;
    labelContextRemainingPercent: string;
    // v0.8.24+ — start of the tick statistics window. Read by
    // m_accStartTime and m_sumStartTime (the cross-project min
    // of per-row startAt). Default "start:" preserves a clean
    // axis to override via config.json.
    labelStartTime: string;
    // v0.8.24+ — end of the tick statistics window. Read by
    // m_sumEndTime (the cross-project max of per-row lastAt).
    // Default "end:" mirrors the startTime default.
    labelEndTime: string;
    // v0.9.0+ — quota module prefix. Read by `m_quota` (per-term
    // via the new `|term|short|mid|long` inline arg). Default
    // `"quota:"` preserves a clean axis to override via
    // config.json. Renders as e.g. `quota(5h):123/500`.
    labelQuota: string;
    // vX.X.X+ — token cost module prefix. Read by m_tokenCost /
    // m_accTokenCost / m_sumTokenCost. Default "cost:" preserves
    // a clean axis to override via config.json.
    labelTokenCost: string;
    // vX.X.X+ — m_sumEstQuota module prefix. Reads the plan
    // window's aligned used% (captured on the StatAggregate at
    // getStatAggregate time) to estimate the periodic quota.
    // Renders as "est:$30.20" (fixed 2dp + per-model currency).
    // Default "est:" preserves a clean axis to override via
    // config.json.
    labelEstQuota: string;
    // vX.X.X+ — glyph shown by `m_pluginSource` when the active
    // provider's plugin resolved to the bundled built-in tree
    // (`dist|src/plugins/<id>/index.js`). Default "📌" preserves
    // the v0.9.x ship literal so existing renders stay byte-
    // identical; user-overridable to any string (e.g. "B:", "🔧",
    // "[built-in]"). The user-side counterpart is
    // `labelPluginUserDefined`.
    labelPluginSystem: string;
    // vX.X.X+ — glyph shown by `m_pluginSource` when the active
    // provider's plugin resolved to a user override at
    // `~/.claude/plugins/topgauge/query_plugins/<id>/`. Default
    // "🎨" preserves the v0.9.x ship literal; user-overridable
    // independently of `labelPluginSystem`.
    labelPluginUserDefined: string;
    // vX.X.X+ — glyph shown by `m_pluginSource` for the
    // future "claude 官方" branch (data sourced from stdin).
    // Default "🔖" — reserved as a type-level axis only; not
    // yet wired into the renderer's dispatch table (per the
    // user's "CC 分支暂不做实现" decision 2026-07-12). The
    // label is exposed so a follow-up branch can read it
    // without a type change, and so users can override the
    // literal in advance if they want.
    labelPluginCC: string;
    // vX.X.X+ — glyph shown by `m_pluginSource` when the
    // matched provider id has no plugin (neither user override
    // nor built-in). Default "❗" makes the failure mode loud
    // instead of silent — `peekPluginSource` no longer folds
    // `kind="missing"` to null.
    labelPluginMissing: string;
  };
  colors: typeof DEFAULT_COLORS;
  cacheHitColors: typeof DEFAULT_CACHE_HIT_COLORS;
  thresholds: typeof DEFAULT_THRESHOLDS;
  currency: typeof DEFAULT_CURRENCY;
  stale: typeof DEFAULT_STALE;
  bar: typeof DEFAULT_BAR;
  countdown: Countdown;
  timeFormat: TimeFormat;
  // v0.4.0+ — registry of reusable template fragments consumed by
  // the m_template module's first argument.
  lineTemplates: typeof DEFAULT_LINE_TEMPLATES;
  // v0.8.14+ — array-only. The template actually rendered is
  // always a `string[]` of tokens (may include `m_template|_X`
  // references that pull chunks from `lineTemplates`). Legacy
  // string-form values from v0.4.0–v0.8.13 configs are
  // auto-migrated by `applyOverrides` to the equivalent
  // `["m_template|_X"]` form with a one-shot warn.
  statuslineTemplate: string[];
  tokenFormat: typeof DEFAULT_TOKEN_FORMAT;
  // v0.9.x — per-model token pricing dict for the m_tokenCost /
  // m_accTokenCost / m_sumTokenCost modules. Keyed by stdin.model.id
  // (NOT display_name). Each value has the same {in, out, cachedIn,
  // currency} shape as the legacy tokenPrice field (removed in
  // v0.9.x — no compat shim). Missing keys render cost:n/a
  // placeholder. Default `{}` means every model is a miss → every
  // cost module renders cost:n/a until the user opts in.
  tokenPrices: Record<string, {
    in: number;       // price per input token
    out: number;      // price per output token
    cachedIn: number; // price per cache-read token
    currency: string; // currency code e.g. "USD", "CNY"
  }>;
  // Plugin version, populated at startup by index.ts from
  // .claude-plugin/plugin.json. The m_version display module reads
  // this field; tests inject values via __resetForTest.
  version: string;
  // v0.2.21: declarative provider registry. See DEFAULT_PROVIDERS
  // above and src/providers.ts for the matcher / dispatcher.
  providers: Record<string, ProviderEntry>;
  // v0.9.x — the top-level `intervals` config block was REMOVED.
  // Plugin authors do their own parsing in `fillQuota`/`fillBalance`
  // (returning canonical Quota/Balance objects directly), so the
  // host no longer ships a path-expression resolver to configure.
  // If you need path-driven parsing in a custom plugin, write it
  // inline in the plugin — the host has no surface for it.
  // (legacy field retained in JSON for now would warn-and-drop;
  // see applyOverrides below)
  // v0.8.21+ — `m_quote|address|…` fetcher passes `--insecure` /
  // `-k` to curl so self-signed / expired / untrusted-CA HTTPS
  // endpoints work without patching the system CA bundle. Always
  // opt-in (default `false`) so a misconfigured upstream still
  // surfaces TLS errors loudly. Two ways to flip it on:
  //   1. `"quoteInsecureTls": true` in config.json (global default)
  //   2. `|insecureTls|<true|false>` inline arg on a specific
  //      `m_quote` token (per-token override; beats the config
  //      value when the arg is present)
  // There is intentionally NO env-var seed for this flag — the
  // URL you're willing to skip TLS validation for is a config-
  // level decision, not a shell-environment one.
  quoteInsecureTls: boolean;
} = {
  cacheTtlMs: 60_000,
  fetchTimeoutMs: 5_000,
  display: "remaining",
  // "balance" was added in v0.2.17 alongside the lineTemplate refactor
  // so the m_modeLabel module for the DeepSeek path can pick it up. Defaults
  // to "Balance:" to preserve the v0.2.16 hardcoded literal.
  modeLabels: { used: "Usage:", remaining: "Remain:", balance: "Balance:" },
  // v0.8.22+ — values mirror the v0.8.x hardcoded literals
  // exactly: "in:" for both labelTokenIn and labelTokenInSpeed
  // (the per-turn / acc / sum-avg form was always the same prefix
  // before the v0.8.13 split), "out:" likewise for the matching
  // out-axis. Existing renders stay byte-identical without any
  // user intervention.
  labels: {
    labelTokenIn: "in:",
    labelTokenOut: "out:",
    labelTokenCachedIn: "cache:",
    labelTokenTotalIn: "total:",
    labelApiMs: "api:",
    labelApiCalls: "calls:",
    labelTokenInSpeed: "in:",
    labelTokenOutSpeed: "out:",
    labelMemUsage: "Mem:",
    labelTokenHitRate: "hit:",
    // v0.8.23+ — context-window prefixes (defaults preserve the
    // v0.8.22 hardcoded literals so existing renders stay
    // byte-identical).
    labelContextSize: "size:",
    labelContextWindowsSize: "size:",
    labelContextUsedPercent: "used:",
    labelContextRemainingPercent: "remain:",
    // v0.8.24+ — start/end of the tick statistics window. Net-new
    // axes (no v0.8.23 default to preserve), so the literals are
    // pure v0.8.24 conventions.
    labelStartTime: "start:",
    labelEndTime: "end:",
    // v0.9.0+ — quota module prefix default. Matches the
    // v0.8.x "labelFoo:" convention (trailing colon included
    // so the renderer can concat without a separator).
    labelQuota: "quota:",
    // vX.X.X+ — token cost module prefix default. Matches the
    // existing "labelFoo:" convention (trailing colon included
    // so the renderer can concat without a separator).
    labelTokenCost: "cost:",
    // vX.X.X+ — m_sumEstQuota module prefix default. Matches the
    // existing "labelFoo:" convention (trailing colon included
    // so the renderer can concat without a separator).
    labelEstQuota: "est:",
    // vX.X.X+ — m_pluginSource glyph defaults. These ARE the
    // v0.9.x ship literals (📌 / 🎨) — unlike the other label*
    // defaults which preserve v0.8.x hardcoded prefixes, these
    // are net-new axes and have no historical default to match.
    // The renderer drops the module entirely when ctx.pluginSource
    // is null (per the "Drop 整个 module" decision 2026-07-11), so
    // these defaults only surface on actual built-in / user hits.
    // labelPluginCC + labelPluginMissing are net-new in this
    // round (2026-07-12); "❗" makes the missing-plugin case
    // loud (was previously silent-drop), "🔖" is reserved for
    // a future CC branch (CC 分支暂不做实现).
    labelPluginSystem: "📌",
    labelPluginUserDefined: "🎨",
    labelPluginCC: "🔖",
    labelPluginMissing: "❗",
  },
  colors: DEFAULT_COLORS,
  cacheHitColors: DEFAULT_CACHE_HIT_COLORS,
  thresholds: DEFAULT_THRESHOLDS,
  currency: DEFAULT_CURRENCY,
  stale: DEFAULT_STALE,
  bar: DEFAULT_BAR,
  countdown: DEFAULT_COUNTDOWN,
  timeFormat: DEFAULT_TIME_FORMAT,
  lineTemplates: DEFAULT_LINE_TEMPLATES,
  statuslineTemplate: DEFAULT_STATUSLINE_TEMPLATE,
  tokenFormat: DEFAULT_TOKEN_FORMAT,
  // v0.9.x — tokenPrices defaults (empty dict — opt-in per model).
  // Every model id is a lookup miss by default, so the cost
  // modules render cost:n/a until the user adds entries.
  tokenPrices: {},
  version: "",
  providers: DEFAULT_PROVIDERS,
  quoteInsecureTls: false,
};

export type Config = typeof DEFAULT_CONFIG;

// ----- Module-level singleton -----
//
// Set once via loadConfig() at startup. Tests use __resetForTest to
// inject overrides without touching disk. Reading is synchronous: every
// consumer just calls configStore.get() at the moment of need.

let _current: Config = DEFAULT_CONFIG;

export const configStore = {
  get(): Config {
    return _current;
  },
  // Inject the plugin version loaded from .claude-plugin/plugin.json
  // at startup. Mutates the current Config's `version` field in place
  // — the test reset path also resets it (see __resetForTest). Tests
  // can call this directly to simulate the startup injection without
  // touching the filesystem.
  setVersion(v: string): void {
    _current.version = v;
  },
};

// ----- Loader -----

function defaultConfigPath(): string {
  return join(
    homedir(),
    ".claude",
    "plugins",
    "topgauge",
    "config.json",
  );
}

// Test hook: replace the path resolver so tests can point at a temp
// file without monkey-patching node:os. Production code never sets it.
let _pathResolver: () => string = defaultConfigPath;

export async function loadConfig(): Promise<Config> {
  const path = _pathResolver();

  // Cheap existence probe — the common case is no config file, no need
  // to even open the file descriptor.
  diagnostics.logFsRead(path, "config.loadConfig");
  if (!existsSync(path)) {
    _current = DEFAULT_CONFIG;
    return _current;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    warn(`read failed (${(e as Error).message}); using defaults`);
    _current = DEFAULT_CONFIG;
    return _current;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    warn(`invalid JSON (${(e as Error).message}); using defaults`);
    _current = DEFAULT_CONFIG;
    return _current;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn("root must be a JSON object; using defaults");
    _current = DEFAULT_CONFIG;
    return _current;
  }

  _current = mergeConfig(parsed as Record<string, unknown>);
  return _current;
}

// v0.4.0+ — apply a provider-specific Config override on top of the
// active snapshot. Called from index.ts:main() after loadConfig() and
// matchProvider() so the active Config seen by every consumer
// (configStore.get()) is already the merged view:
//
//   defaults  ⊕  config.json top-level  ⊕  providerEntry.config
//             (lowest)                  (highest)
//
// Implementation: deep-clone the current snapshot, run the same
// per-field validators on top of the provider.config object, replace
// the active snapshot. Reusing the validators (rather than merging
// provider.config as JSON and re-running mergeConfig) keeps the
// precedence math explicit and avoids re-cloning defaults.
//
// Stale-on-error behavior: the active snapshot may have been built
// from a malformed user config (some fields silently fell back to
// defaults with a stderr warn). Re-validating provider.config on top
// of that snapshot means the provider layer's overrides get the SAME
// per-field validation as the top-level config — typos in
// provider.config still produce stderr warns, never silent acceptance.
export function applyProviderOverrides(raw: Record<string, unknown>): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  if ("providers" in raw) {
    warn(
      "provider.config must not contain a nested 'providers' key (would recurse); ignoring",
    );
    delete (raw as Record<string, unknown>).providers;
  }
  const base = JSON.parse(JSON.stringify(_current)) as Config;
  _current = applyOverrides(base, raw);
}

// v0.4.0+ — exported so renderer modules (src/render.ts) can warn
// about runtime issues like `m_template:missingkey` without
// duplicating the stderr + diagnostics JSONL wiring. Config-side
// callers (this file) keep using the bare name.
export function warn(msg: string): void {
  process.stderr.write(`topgauge: config ${msg}\n`);
  // v0.4.0+ — also append to the diagnostics JSONL log so the
  // m_warning module can surface the latest signal and the user can
  // postmortem the plugin's recent history. Stderr stays the
  // primary surface for live debugging; the log is the persistent
  // record. Disk errors are swallowed inside diagnostics.append.
  diagnostics.append("warning", "config", msg);
}

// ----- Per-field validation + merge -----
//
// Each validator returns the validated value, or DEFAULT_CONFIG's
// value on failure (with a stderr warning). Per-section isolation:
// a bad `colors` block does NOT poison `cacheTtlMs` — independent
// try/catches around each validator keep partial configs working.

function isFinitePositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isAscending4Tuple(v: unknown): v is [number, number, number, number] {
  if (!Array.isArray(v) || v.length !== 4) return false;
  if (!v.every(isFiniteNumber)) return false;
  for (let i = 1; i < v.length; i++) {
    if ((v[i] as number) <= (v[i - 1] as number)) return false;
  }
  return true;
}

// Accept an ANSI SGR string OR a known symbolic shortcut.
const COLOR_SHORTCUTS: Record<string, string> = {
  brightBlack: "\x1b[90m",
  brightGreen: "\x1b[38;5;41m",
  darkGreen: "\x1b[38;5;29m",
  yellow: "\x1b[38;5;220m",
  orange: "\x1b[38;5;208m",
  red: "\x1b[38;5;196m",
};

function normalizeColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (COLOR_SHORTCUTS[v]) return COLOR_SHORTCUTS[v];
  // Accept any SGR sequence (\x1b[...m) — we don't try to validate the
  // exact byte sequence, just that it looks like an SGR. Reject strings
  // that contain newlines so a JSON mistake can't inject multi-line
  // escape codes into the rendered statusline.
  if (/^\x1b\[[0-9;]*m$/.test(v)) return v;
  return null;
}

// v0.4.0+ — internal helper that applies a raw override object on
// top of an existing Config snapshot. Used by both mergeConfig (the
// config.json loader) and applyProviderOverrides (the provider-level
// config overlay). Per-field validators are identical between the
// two callers, so the precedence is:
//
//   defaults  ⊕  config.json  ⊕  providerEntry.config
//
// where each step runs the same validators in sequence.
//
// Why a separate helper: extracting this from mergeConfig keeps the
// validation logic in ONE place. If we re-ran mergeConfig from scratch
// for the provider layer, we'd lose the user-config fixes (e.g. a
// top-level `cacheTtlMs` that was repaired with a stderr warn would
// get re-clobbered by an unrelated bad value in provider.config).
// Re-validating on top of the merged snapshot keeps each layer's
// effect independent.
function applyOverrides(base: Config, raw: Record<string, unknown>): Config {
  // Deep-clone the input Config — we mutate freely and don't want to
  // touch the caller's object. JSON round-trip is fine here: Config
  // is plain data, no functions / Dates / Maps.
  const out = JSON.parse(JSON.stringify(base)) as Config;

  // cacheTtlMs
  if ("cacheTtlMs" in raw) {
    if (isFinitePositiveNumber(raw.cacheTtlMs)) {
      out.cacheTtlMs = raw.cacheTtlMs;
    } else {
      warn("cacheTtlMs must be a positive number; using default");
    }
  }

  // cacheTtlMs
  if ("cacheTtlMs" in raw) {
    if (isFinitePositiveNumber(raw.cacheTtlMs)) {
      out.cacheTtlMs = raw.cacheTtlMs;
    } else {
      warn("cacheTtlMs must be a positive number; using default");
    }
  }

  // fetchTimeoutMs
  if ("fetchTimeoutMs" in raw) {
    if (isFinitePositiveNumber(raw.fetchTimeoutMs)) {
      out.fetchTimeoutMs = raw.fetchTimeoutMs;
    } else {
      warn("fetchTimeoutMs must be a positive number; using default");
    }
  }

  // display
  if ("display" in raw) {
    const d = raw.display;
    if (d === "used" || d === "remaining") {
      out.display = d;
    } else {
      warn('display must be "used" or "remaining"; using default');
    }
  }

  // modeLabels
  if ("modeLabels" in raw) {
    const ml = raw.modeLabels;
    if (ml && typeof ml === "object" && !Array.isArray(ml)) {
      const m = ml as Record<string, unknown>;
      if (typeof m.used === "string") out.modeLabels.used = m.used;
      else if ("used" in m)
        warn("modeLabels.used must be a string; using default");
      if (typeof m.remaining === "string")
        out.modeLabels.remaining = m.remaining;
      else if ("remaining" in m)
        warn("modeLabels.remaining must be a string; using default");
      // v0.2.17: added alongside the lineTemplate refactor so m_modeLabel
      // can pick it up for the DeepSeek (balance) path. Replaces the
      // hardcoded "Balance: " literal in the legacy `formatBalanceLine`
      // shim (dropped in the v0.9.x dead-export cleanup; the "Balance:"
      // prefix now flows through m_modeLabel).
      if (typeof m.balance === "string") out.modeLabels.balance = m.balance;
      else if ("balance" in m)
        warn("modeLabels.balance must be a string; using default");
    } else {
      warn("modeLabels must be an object; using default");
    }
  }

  // v0.8.0+ — top-level token-label overrides. Same partial-merge
  // shape as modeLabels: each field is optional, invalid types are
  // dropped with a one-line warn, valid strings overwrite the
  // default verbatim (no further coercion — callers append the
  // value to a number, so the configured string must not contain
  // a trailing space).
  if ("labels" in raw) {
    const l = raw.labels;
    if (l && typeof l === "object" && !Array.isArray(l)) {
      const lm = l as Record<string, unknown>;
      const fields: Array<keyof typeof out.labels> = [
        "labelTokenIn",
        "labelTokenOut",
        "labelTokenCachedIn",
        "labelTokenTotalIn",
        "labelApiMs",
        "labelApiCalls",
        "labelTokenInSpeed",
        "labelTokenOutSpeed",
        "labelMemUsage",
        "labelTokenHitRate",
        "labelContextSize",
        "labelContextWindowsSize",
        "labelContextUsedPercent",
        "labelContextRemainingPercent",
        // v0.8.24+ — start/end of the tick statistics window.
        // Net-new axes (no v0.8.23 default to preserve).
        "labelStartTime",
        "labelEndTime",
        // v0.9.0+ — quota module prefix. Net-new axis; default
        // "quota:" preserved (see DEFAULT_CONFIG.labels above).
        "labelQuota",
        // vX.X.X+ — token cost module prefix.
        "labelTokenCost",
        // vX.X.X+ — m_sumEstQuota module prefix.
        "labelEstQuota",
        // vX.X.X+ — m_pluginSource glyph axis (system / user / cc / missing).
        // The renderer reads these via `labelFor("pluginSystem")` /
        // `labelFor("pluginUserDefined")` /
        // `labelFor("pluginCC")` (reserved, not yet dispatched) /
        // `labelFor("pluginMissing")` so users can replace the
        // ship defaults (📌 / 🎨 / 🔖 / ❗) with any string via
        // labels.labelPluginSystem / .labelPluginUserDefined /
        // .labelPluginCC / .labelPluginMissing.
        "labelPluginSystem",
        "labelPluginUserDefined",
        "labelPluginCC",
        "labelPluginMissing",
      ];
      for (const f of fields) {
        if (typeof lm[f] === "string") {
          out.labels[f] = lm[f] as string;
        } else if (f in lm) {
          warn(`labels.${f} must be a string; using default`);
        }
      }
      // v0.8.22+ — old v0.8.13–v0.8.21 names (labelIn / labelOut /
      // labelCacheIn / labelTotalIn / labelApi / labelInSpeed /
      // labelOutSpeed) are NOT accepted. Users must rename in
      // their config.json. We intentionally don't mirror values
      // silently: a stray old name silently adopting a new prefix
      // would mask config bugs and a noisy warn + drop is the
      // right failure mode. Also catches the transient v0.8.22
      // labelTokenTotalOut (reverted before release).
      // Note: `labelApiCalls` and `labelMemUsage` were not renamed
      // — they're the SAME identifier in v0.8.13+ and v0.8.22+, so
      // they remain in `fields` above. We don't list them here.
      const knownOldNames = [
        "labelIn",
        "labelOut",
        "labelCacheIn",
        "labelTotalIn",
        "labelTokenTotalOut",
        "labelApi",
        "labelInSpeed",
        "labelOutSpeed",
      ];
      for (const old of knownOldNames) {
        if (old in lm) {
          warn(
            `labels.${old} is removed in v0.8.22; remove it from ` +
            `your config.json (see release notes)`,
          );
        }
      }
    } else {
      warn("labels must be an object; using default");
    }
  }

  // v0.9.x — top-level `intervals` config block REMOVED. The
  // `intervals` key is silently dropped if present in the user's
  // config.json (no warn, no migration path). Plugin authors do
  // their own parsing in `fillQuota`/`fillBalance` — the host
  // doesn't expose a path-expression surface anymore. Custom
  // plugins that need it inline a tiny local walker (see
  // src/plugins/deepseek/index.js:readPath for the shape).

  // colors — per-field validation, partial acceptance
  if ("colors" in raw) {
    const c = raw.colors;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const cm = c as Record<string, unknown>;
      for (const key of [
        "brightGreen",
        "darkGreen",
        "yellow",
        "orange",
        "red",
        "stale",
        "broken",
      ] as const) {
        if (key in cm) {
          const norm = normalizeColor(cm[key]);
          if (norm) {
            out.colors[key] = norm;
          } else {
            warn(
              `colors.${key} must be an ANSI SGR string or a known shortcut; using default`,
            );
          }
        }
      }
    } else {
      warn("colors must be an object; using default");
    }
  }

  // v0.4.0+ — cacheHitColors. Same per-field validator as `colors`
  // (ANSI SGR or a known shortcut). Three bands: good / warn / bad.
  if ("cacheHitColors" in raw) {
    const c = raw.cacheHitColors;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const cm = c as Record<string, unknown>;
      for (const key of ["good", "warn", "bad"] as const) {
        if (key in cm) {
          const norm = normalizeColor(cm[key]);
          if (norm) {
            out.cacheHitColors[key] = norm;
          } else {
            warn(
              `cacheHitColors.${key} must be an ANSI SGR string or a known shortcut; using default`,
            );
          }
        }
      }
    } else {
      warn("cacheHitColors must be an object; using default");
    }
  }

  // thresholds
  if ("thresholds" in raw) {
    const t = raw.thresholds;
    if (t && typeof t === "object" && !Array.isArray(t)) {
      const tm = t as Record<string, unknown>;
      if ("percentBands" in tm) {
        if (isAscending4Tuple(tm.percentBands)) {
          out.thresholds.percentBands = tm.percentBands;
        } else {
          warn(
            "thresholds.percentBands must be 4 ascending numbers; using default",
          );
        }
      }
      if ("balanceBands" in tm) {
        if (isAscending4Tuple(tm.balanceBands)) {
          out.thresholds.balanceBands = tm.balanceBands;
        } else {
          warn(
            "thresholds.balanceBands must be 4 ascending numbers; using default",
          );
        }
      }
    } else {
      warn("thresholds must be an object; using default");
    }
  }

  // currency
  if ("currency" in raw) {
    const c = raw.currency;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const cm = c as Record<string, unknown>;
      if ("prefixes" in cm) {
        if (
          cm.prefixes &&
          typeof cm.prefixes === "object" &&
          !Array.isArray(cm.prefixes)
        ) {
          const merged: Record<string, string> = {
            ...DEFAULT_CURRENCY.prefixes,
          };
          for (const [k, v] of Object.entries(
            cm.prefixes as Record<string, unknown>,
          )) {
            if (typeof v === "string") merged[k.toUpperCase()] = v;
          }
          out.currency.prefixes = merged;
        } else {
          warn("currency.prefixes must be an object; using default");
        }
      }
      if ("fallback" in cm) {
        if (typeof cm.fallback === "string")
          out.currency.fallback = cm.fallback;
        else warn("currency.fallback must be a string; using default");
      }
      if ("default" in cm) {
        if (typeof cm.default === "string") out.currency.default = cm.default;
        else warn("currency.default must be a string; using default");
      }
    } else {
      warn("currency must be an object; using default");
    }
  }

  // stale — v0.2.17 dropped the legacy `separator` field. The stale
  // annotation is now appended directly after the template output
  // (no leading separator). The `stale` block is still accepted for
  // forward-compat (e.g. ageEmoji overrides), but only `ageEmoji` is
  // recognized; unknown sub-keys are silently ignored.
  if ("stale" in raw) {
    const s = raw.stale;
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      warn("stale must be an object; using default");
    }
  }

  // countdown — top-level (reset countdown visualization).
  if ("countdown" in raw) {
    const c = raw.countdown;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const cm = c as Record<string, unknown>;
      if ("resetArrows" in cm) {
        const arr = cm.resetArrows;
        if (
          Array.isArray(arr) &&
          arr.every((v) => typeof v === "string" && !/\n/.test(v)) &&
          arr.length > 0
        ) {
          out.countdown.resetArrows = arr as string[];
        } else {
          warn(
            "countdown.resetArrows must be a non-empty array of single-line strings; using default",
          );
        }
      }
    } else {
      warn("countdown must be an object; using default");
    }
  }

  // timeFormat — top-level (governs reset countdown AND stale suffix).
  if ("timeFormat" in raw) {
    const tf = raw.timeFormat;
    if (tf && typeof tf === "object" && !Array.isArray(tf)) {
      const t = tf as Record<string, unknown>;
      if ("minUnit" in t) {
        if (t.minUnit === "m" || t.minUnit === "s" || t.minUnit === "h")
          out.timeFormat.minUnit = t.minUnit;
        else warn('timeFormat.minUnit must be "m", "s", or "h"; using default');
      }
      if ("maxUnitCount" in t) {
        if (isFiniteNumber(t.maxUnitCount))
          out.timeFormat.maxUnitCount = Math.max(
            1,
            Math.min(4, Math.floor(t.maxUnitCount)),
          );
        else warn("timeFormat.maxUnitCount must be a number; using default");
      }
    } else {
      warn("timeFormat must be an object; using default");
    }
  }

  // v0.4.0+ — tokenFormat (compact number formatting for m_token* modules).
  // All sub-keys are optional; missing → keep default.
  if ("tokenFormat" in raw) {
    const tf = raw.tokenFormat;
    if (tf && typeof tf === "object" && !Array.isArray(tf)) {
      const t = tf as Record<string, unknown>;
      if ("thresholds" in t) {
        if (
          Array.isArray(t.thresholds) &&
          t.thresholds.length === 2 &&
          t.thresholds.every(isFinitePositiveNumber)
        ) {
          const pair = t.thresholds as [number, number];
          if (pair[0] < pair[1]) out.tokenFormat.thresholds = pair;
          else
            warn(
              "tokenFormat.thresholds must be 2 ascending positive numbers; using default",
            );
        } else {
          warn(
            "tokenFormat.thresholds must be [lo, hi] of positive numbers; using default",
          );
        }
      }
      for (const k of [
        "precision",
        "speedPrecision",
        "cachePctPrecision",
      ] as const) {
        if (k in t) {
          if (isFiniteNumber(t[k]) && (t[k] as number) >= 0 && (t[k] as number) <= 4)
            out.tokenFormat[k] = Math.floor(t[k] as number);
          else
            warn(`tokenFormat.${k} must be an integer in [0, 4]; using default`);
        }
      }
      if ("cacheHitThresholds" in t) {
        if (
          Array.isArray(t.cacheHitThresholds) &&
          t.cacheHitThresholds.length === 2 &&
          t.cacheHitThresholds.every(isFiniteNumber)
        ) {
          const pair = t.cacheHitThresholds as [number, number];
          if (pair[0] < pair[1]) out.tokenFormat.cacheHitThresholds = pair;
          else
            warn(
              "tokenFormat.cacheHitThresholds must be 2 ascending numbers; using default",
            );
        } else {
          warn(
            "tokenFormat.cacheHitThresholds must be [lo, hi] numbers; using default",
          );
        }
      }
      // v0.4.0+ — speed scale band overrides. Each direction is
      // an ascending 4-tuple. We validate strictly: a 3-tuple
      // silently falls back to the default; a 5-tuple is also
      // rejected (only 5 bands = 4 thresholds; 4 cutoffs define
      // them).
      if ("speedScaleBands" in t) {
        const sb = t.speedScaleBands;
        if (sb && typeof sb === "object" && !Array.isArray(sb)) {
          const sbm = sb as Record<string, unknown>;
          for (const dir of ["in", "out"] as const) {
            if (dir in sbm) {
              const arr = sbm[dir];
              if (
                Array.isArray(arr) &&
                arr.length === 4 &&
                arr.every(isFiniteNumber)
              ) {
                const quad = arr as [number, number, number, number];
                const ascending = quad[0] < quad[1] && quad[1] < quad[2] && quad[2] < quad[3];
                if (ascending)
                  out.tokenFormat.speedScaleBands[dir] = quad;
                else
                  warn(
                    `tokenFormat.speedScaleBands.${dir} must be 4 ascending numbers; using default`,
                  );
              } else {
                warn(
                  `tokenFormat.speedScaleBands.${dir} must be a 4-tuple of numbers; using default`,
                );
              }
            }
          }
        } else {
          warn("tokenFormat.speedScaleBands must be an object; using default");
        }
      }
    } else {
      warn("tokenFormat must be an object; using default");
    }
  }

  // bar
  if ("bar" in raw) {
    const b = raw.bar;
    if (b && typeof b === "object" && !Array.isArray(b)) {
      const bm = b as Record<string, unknown>;
      if ("width" in bm) {
        // Accept any finite number in [3, 64] — narrower than the [3,32]
        // range first sketched, because wider bars look bad in any
        // statusline context the user might compose this with.
        if (
          isFiniteNumber(bm.width) &&
          (bm.width as number) >= 3 &&
          (bm.width as number) <= 64
        ) {
          out.bar.width = bm.width;
        } else {
          warn("bar.width must be an integer in [3, 64]; using default");
        }
      }
      if ("filled" in bm) {
        if (typeof bm.filled === "string" && !/\n/.test(bm.filled))
          out.bar.filled = bm.filled;
        else warn("bar.filled must be a single-line string; using default");
      }
      if ("empty" in bm) {
        if (typeof bm.empty === "string" && !/\n/.test(bm.empty))
          out.bar.empty = bm.empty;
        else warn("bar.empty must be a single-line string; using default");
      }
    } else {
      warn("bar must be an object; using default");
    }
  }

  // vX.X.X+ — the `separators` config field is REMOVED. Legacy
  // configs that still carry one are silently ignored (no warn, no
  // migration path). Use one of the six built-in s_<name> tokens or
  // `m_label|<text>` for custom separators.

  // v0.4.0+ — legacy `lineTemplate` is REMOVED. The loader still
  // detects the key (so a v0.3.x user gets a clear, actionable
  // warning) but does not migrate or honor the field. Users must
  // move to `statuslineTemplate` (top-level rendered template) +
  // `lineTemplates` (reusable template fragments consumed by
  // `m_template`). The fields are intentionally NOT auto-promoted
  // because the mapping (which preset name to pick) is
  // best-effort and would surprise users with non-default
  // templates — better to make them explicitly migrate.
  if ("lineTemplate" in raw) {
    warn(
      "lineTemplate is removed in v0.4.0; use lineTemplates + " +
      "statuslineTemplate instead. See CHANGELOG.md for the upgrade " +
      "path. Ignoring the legacy field.",
    );
  }

  // v0.4.0+ — `lineTemplates` is a Record<string, string[]> of
  // reusable template fragments. The m_template module's first
  // argument is a key into this record. Nesting protection: any
  // entry containing `m_template` (bare or with colon args) is
  // stripped with a warning — recursion would be invisible to the
  // loader and infinite at render time.
  if ("lineTemplates" in raw) {
    const lt = raw.lineTemplates;
    if (!lt || typeof lt !== "object" || Array.isArray(lt)) {
      warn("lineTemplates must be an object of string arrays; using defaults");
    } else {
      const ltm = lt as Record<string, unknown>;
      const merged: LineTemplates = { ...out.lineTemplates };
      for (const [name, value] of Object.entries(ltm)) {
        // v0.8.14+ — `_`-prefix is reserved for built-in presets.
        // Loader rejects user `lineTemplates._*` entries whose name
        // collides with a key in DEFAULT_LINE_TEMPLATES (the built-in
        // wins, user's entry is dropped with a warn). User-defined
        // `_custom` entries that don't collide with a built-in key
        // are preserved (the `_` is just a naming convention, not
        // ownership). The built-in `_balance_simple`,
        // `_balance_simple-alone`, `_1line`, etc. are protected.
        if (
          name.startsWith("_") &&
          Object.prototype.hasOwnProperty.call(DEFAULT_LINE_TEMPLATES, name)
        ) {
          warn(
            `lineTemplates.${name}: the \`_\`-prefix is reserved for ` +
            `built-in presets; skipping user override. Use a ` +
            `different key (e.g. drop the underscore).`,
          );
          continue;
        }
        if (!Array.isArray(value)) {
          warn(`lineTemplates.${name} must be an array of strings; skipping`);
          continue;
        }
        const cleaned: string[] = [];
        for (const item of value) {
          if (typeof item !== "string") continue;
          if (item === "m_template" || item.startsWith("m_template|")) {
            warn(
              `lineTemplates.${name}: m_template is only allowed inside ` +
              `statuslineTemplate; dropping "${item}"`,
            );
            continue;
          }
          cleaned.push(item);
        }
        if (cleaned.length === 0) {
          warn(`lineTemplates.${name} is empty after cleaning; skipping`);
          continue;
        }
        merged[name] = cleaned;
      }
      out.lineTemplates = merged;
    }
  }

  // vX.X.X+ — `statuslineTemplate` accepts both array-form (raw
  // token list) and string-form (a preset name resolved against
  // DEFAULT_STATUSLINE_PRESETS). String-form lets users reference a
  // whole preset without inlining the body in config.json. A bare
  // fragment name (DEFAULT_LINE_TEMPLATES key) is NOT valid here —
  // presets and fragments live in distinct registries, on purpose.
  if ("statuslineTemplate" in raw) {
    const st = raw.statuslineTemplate;
    if (Array.isArray(st)) {
      const cleaned: string[] = [];
      for (const item of st) {
        if (typeof item === "string") cleaned.push(item);
      }
      out.statuslineTemplate =
        cleaned.length > 0 ? cleaned : DEFAULT_STATUSLINE_TEMPLATE.slice();
    } else if (typeof st === "string") {
      const preset = DEFAULT_STATUSLINE_PRESETS[st];
      if (preset !== undefined) {
        // Clone the body so a later user mutation of their
        // in-memory config doesn't leak back into the registry.
        out.statuslineTemplate = preset.slice();
      } else {
        warn(
          `statuslineTemplate "${st}" is not a known preset ` +
          `(valid: ${Object.keys(DEFAULT_STATUSLINE_PRESETS).join(", ")}); ` +
          `use a string[] (e.g. ["m_template|quota|type:quota"]) or a ` +
          `preset name. Using DEFAULT_STATUSLINE_TEMPLATE.`,
        );
        out.statuslineTemplate = DEFAULT_STATUSLINE_TEMPLATE.slice();
      }
    } else {
      warn(
        "statuslineTemplate must be a string or string[]; using default",
      );
    }
  }

  // v0.8.21+ — opt-in curl --insecure gate. Default false (TLS
  // errors surface normally); user opts in via
  // `"quoteInsecureTls": true` in config.json. No env-var seed —
  // this is a config-file decision. Any non-boolean value
  // (string/number/...) is treated as a typo and silently falls
  // back to the safe default with a stderr warn — the same lenient
  // pattern as fetchTimeoutMs / cacheTtlMs validation.
  if ("quoteInsecureTls" in raw) {
    const v = raw.quoteInsecureTls;
    if (typeof v === "boolean") {
      out.quoteInsecureTls = v;
    } else {
      warn("quoteInsecureTls must be a boolean; using default");
    }
  }

  // v0.9.x — tokenPrices: opt-in per-model pricing for m_tokenCost
  // family. Top-level keys are stdin.model.id values. The legacy
  // tokenPrice (singular, scalar) was REMOVED in v0.9.x — if seen,
  // emit a stderr warn and ignore it. No compat shim (per
  // [[new-feature-convention]]).
  if ("tokenPrice" in raw) {
    warn("tokenPrice is removed; use tokenPrices (per-model dict keyed by model.id) instead — ignoring");
  }
  if ("tokenPrices" in raw) {
    const tp = raw.tokenPrices;
    if (tp && typeof tp === "object" && !Array.isArray(tp)) {
      for (const [modelId, entry] of Object.entries(tp as Record<string, unknown>)) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          warn(`tokenPrices.${modelId} must be an object; ignoring entry`);
          continue;
        }
        const em = entry as Record<string, unknown>;
        const built = { in: 0, out: 0, cachedIn: 0, currency: "USD" };
        for (const key of ["in", "out", "cachedIn"] as const) {
          if (key in em) {
            if (typeof em[key] === "number" && Number.isFinite(em[key] as number) && (em[key] as number) >= 0) {
              built[key] = em[key] as number;
            } else {
              warn(`tokenPrices.${modelId}.${key} must be a non-negative number; using default`);
            }
          }
        }
        if ("currency" in em) {
          if (typeof em.currency === "string" && (em.currency as string).length > 0) {
            built.currency = (em.currency as string).toUpperCase();
          } else {
            warn(`tokenPrices.${modelId}.currency must be a non-empty string; using default`);
          }
        }
        out.tokenPrices[modelId] = built;
      }
    } else {
      warn("tokenPrices must be an object; using default {}");
    }
  }

  // Note: the `providers` block is handled separately by mergeConfig
  // (the only caller that processes user-provided provider entries).
  // applyProviderOverrides rejects `providers` at the top of the
  // function, so this helper intentionally doesn't touch it.

  return out;
}

// v0.4.0+ — top-level config.json loader. Wraps applyOverrides with
// the `providers` block handling that lives only at the top layer.
function mergeConfig(raw: Record<string, unknown>): Config {
  const out = applyOverrides(
    JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config,
    raw,
  );

  // providers — Record<string, ProviderEntry>. User config is
  // deep-merged on top of DEFAULT_PROVIDERS: existing keys have
  // their fields overridden; new keys are appended. Per-entry
  // validation drops malformed entries with a stderr warn rather
  // than auto-filling (so a typo can't silently produce a half-
  // configured provider with the wrong rendering or authentication settings).
  //
  // The "missing `providers` key in user config" case falls back
  // to DEFAULT_PROVIDERS via the deep-clone at the top of
  // mergeConfig — so existing users without a `providers` block
  // keep working unchanged.
  if ("providers" in raw) {
    const p = raw.providers;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      warn("providers must be an object; using default");
    } else {
      const pm = p as Record<string, unknown>;
      const merged: Record<string, ProviderEntry> = {};
      for (const [name, defaultEntry] of Object.entries(DEFAULT_PROVIDERS)) {
        // Start with the default for known keys; user overrides
        // fields on top below. A partial user entry inherits the
        // remaining matcher, rendering, and authentication fields from
        // the default — so the user can change just one knob without
        // restating the whole entry. A non-object user value (string,
        // array, null) is a user error — drop the entry and warn.
        let seed: Record<string, unknown> | null = null;
        if (name in pm) {
          if (pm[name] && typeof pm[name] === "object" && !Array.isArray(pm[name])) {
            seed = { ...defaultEntry };
            for (const [k, v] of Object.entries(pm[name] as Record<string, unknown>)) {
              if (v !== undefined) seed[k] = v;
            }
          } else {
            warn(`providers.${name} must be an object; dropping`);
          }
        } else {
          // User did not mention this default key → keep it as-is.
          seed = { ...defaultEntry };
        }
        if (seed) {
          const validated = validateProviderEntry(name, seed);
          if (validated) merged[name] = validated;
        }
      }
      // Append any user-defined provider keys NOT in DEFAULT_PROVIDERS.
      for (const [name, value] of Object.entries(pm)) {
        if (name in merged) continue;
        const entry = validateProviderEntry(name, value);
        if (entry) merged[name] = entry;
      }
      out.providers = merged;
    }
  }

  return out;
}

// Validate one ProviderEntry. Returns the validated entry or null if
// the entry is fatally malformed. The caller (`mergeConfig`) is
// responsible for filling missing fields from the default entry
// before calling this — we validate the merged result, not the raw
// user input. A partial user entry thus preserves the remaining
// matcher, rendering, and authentication fields from the default;
// an invalid `TYPE` on an otherwise-OK entry drops the whole thing.
function validateProviderEntry(_name: string, v: unknown): ProviderEntry | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    warn("provider entry must be an object; dropping");
    return null;
  }
  const e = v as Record<string, unknown>;
  // TYPE
  const t = e.TYPE;
  if (typeof t !== "string" || !VALID_PROVIDER_TYPES.has(t as ProviderType)) {
    warn(`provider TYPE must be "QUOTA" or "BALANCE" (got ${JSON.stringify(t)}); dropping`);
    return null;
  }
  // BASE_URL_COMPARED_TO
  const base = e.BASE_URL_COMPARED_TO;
  if (typeof base !== "string" || base.length === 0) {
    warn("provider BASE_URL_COMPARED_TO must be a non-empty string; dropping");
    return null;
  }
  // COMPARE_METHOD
  const cm = e.COMPARE_METHOD;
  if (typeof cm !== "string" || !VALID_COMPARE_METHODS.has(cm as CompareMethod)) {
    warn(`provider COMPARE_METHOD must be one of "EXACT", "INCLUDE", "STARTWITH" (got ${JSON.stringify(cm)}); dropping`);
    return null;
  }
  let validatedAuthenticationKey: string | undefined;
  if ("AUTHENTICATION_KEY" in e && e.AUTHENTICATION_KEY !== undefined) {
    if (typeof e.AUTHENTICATION_KEY === "string" && e.AUTHENTICATION_KEY.length > 0) {
      validatedAuthenticationKey = e.AUTHENTICATION_KEY;
    } else {
      warn("provider AUTHENTICATION_KEY must be a non-empty string; dropping the field");
    }
  }
  // v0.4.0+ — optional provider-specific Config overrides. Validated
  // here only for shape (must be a plain object, no nested `providers`
  // key to avoid recursion). The fields inside `config` are merged
  // into the active Config snapshot at startup via
  // configStore.applyProviderOverrides(provider); per-field validators
  // are applied at THAT time so a typo still produces a stderr warn.
  if ("config" in e && e.config !== undefined) {
    const c = e.config;
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      warn(`provider.config must be an object (got ${typeof c}); dropping the entry`);
      return null;
    }
    const cm = c as Record<string, unknown>;
    if ("providers" in cm) {
      warn(
        "provider.config must not contain a nested 'providers' key (would recurse); dropping the entry",
      );
      return null;
    }
  }
  // Forward the validated `config` block (or omit it entirely if
  // the user didn't supply one) so downstream readers see a
  // consistent shape.
  const validatedConfig =
    "config" in e &&
    e.config &&
    typeof e.config === "object" &&
    !Array.isArray(e.config)
      ? (e.config as Record<string, unknown>)
      : undefined;
  // v0.9.x — per-provider `intervals` block REMOVED. Plugins
  // own their own parsing, so the host doesn't expose this field
  // anymore. (User config.json that still carries
  // `providers.<id>.intervals` is silently ignored at the type
  // level — the field isn't part of ProviderEntry, so the JSON
  // loader drops it via the validateProviderEntry shallow
  // assign. No warn, no migration path.)
  //
  // Same treatment for `providers.<id>.currencies` — plugins
  // parse their own BALANCE responses directly. The legacy
  // host-side merge layer is gone.
  return {
    TYPE: t as ProviderType,
    BASE_URL_COMPARED_TO: base,
    COMPARE_METHOD: cm as CompareMethod,
    ...(validatedConfig ? { config: validatedConfig } : {}),
    ...(validatedAuthenticationKey ? { AUTHENTICATION_KEY: validatedAuthenticationKey } : {}),
  };
}

// ----- Test-only -----

export function __resetForTest(overrides?: Partial<Config>): void {
  if (overrides === undefined) {
    // v0.2.17: deep-clone DEFAULT_CONFIG before assigning. setVersion()
    // mutates _current.version in place; if _current WERE DEFAULT_CONFIG
    // itself, that mutation would leak across reset calls. Cloning
    // makes the reset path symmetric with the overrides branch.
    _current = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
    return;
  }
  // Deep-merge so tests can override `stale: { separator: " · " }`
  // without erasing colors / bar / etc. Plain `...DEFAULT_CONFIG,
  // ...overrides` would replace the whole `stale` object with a partial
  // one missing separator / ageEmoji.
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
  const merged = deepMerge(
    base,
    overrides as Record<string, unknown>,
  ) as Config;
  _current = merged;
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (over === null || typeof over !== "object" || Array.isArray(over))
    return over;
  if (base === null || typeof base !== "object" || Array.isArray(base))
    return over;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = v === undefined ? out[k] : deepMerge(out[k], v);
  }
  return out;
}

export const __testing = {
  DEFAULT_CONFIG,
  configPath: defaultConfigPath,
  setPathResolver(fn: () => string): void {
    _pathResolver = fn;
  },
  resetPathResolver(): void {
    _pathResolver = defaultConfigPath;
  },
};
