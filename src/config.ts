// User-tunable configuration for creditgauge.
// Loaded once at startup from
// $CLAUDE_CONFIG_DIR/plugins/creditgauge/config.json
// (fallback: ~/.claude/plugins/creditgauge/config.json).
// Absent file → hardcoded DEFAULT_CONFIG. Malformed JSON or a single
// bad field → one stderr line + DEFAULT_CONFIG. Never crashes.
// Precedence: config.json > hardcoded defaults.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CompareMethod,
  ProviderEntry,
  ProviderType,
  TokenPriceEntry,
  TokenPricesFile,
  TokenPricesOverride,
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
  // Broken-chain color for the m_age "⛓️‍💥 X ago" annotation (fetch
  // failed, rendering last cached value). Distinct from `colors.stale`
  // (gray, fresh 🔗 annotation) so the two states read differently.
  broken: "\x1b[31m",
};

// 3-band palette for the m_tokenHitRate module. Higher is better:
// cache_read / (cache_read + cache_creation) ≥ 80% → green,
// 50–80% → yellow, <50% → orange.
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
  prefixes: { USD: "$", CNY: "¥", RMB: "¥" },
  // Fallback prefix when the API returns an unknown currency code.
  fallback: "¥",
  // Currency assumed when an entry omits its `currency` field.
  default: "CNY",
};

const DEFAULT_STALE = {
  // Emoji pair for the "X ago" annotation. `broken` marks a failed
  // fetch (rendering last cached value); `healthy` marks a fresh
  // chain. Appended directly after template output (no leading
  // separator — place one in lineTemplate if needed).
  ageEmoji: { healthy: "🔗", broken: "⛓️‍💥" },
};

const DEFAULT_BAR = {
  width: 8,
  filled: "▓",
  empty: "░",
};

// m_token* number-format knobs: thresholds (k/M compact notation),
// per-axis precisions, cacheHitThresholds override, and the 5-band
// speedScaleBands for m_tokenInSpeed / m_tokenOutSpeed (tps ≥ bands[3]
// → brightest; < bands[0] → red; `in` bands are 5× `out` because input
// streams run hotter).
const DEFAULT_SPEED_SCALE_BANDS = {
  in: [50, 100, 200, 400] as [number, number, number, number],
  out: [10, 20, 40, 80] as [number, number, number, number],
};

const DEFAULT_TOKEN_FORMAT = {
  // [<1k] → "342", [<1M] → "12.3k", [≥1M] → "1.2M".
  thresholds: [1_000, 1_000_000] as [number, number],
  precision: 1,
  speedPrecision: 1,
  cachePctPrecision: 1,
  cacheHitThresholds: DEFAULT_CACHE_HIT_THRESHOLDS,
  speedScaleBands: DEFAULT_SPEED_SCALE_BANDS,
};

type DisplayMode = "used" | "remaining";

// Top-level time-format knobs governing ALL time rendering (reset
// countdown, stale suffix, etc.). minUnit = smallest unit rendered;
// units below it collapse to "<1<minUnit>" (or "0<minUnit>" past-due):
// "m" → sub-minute shows "<1m"; "s" (default) → real seconds ("47s");
// "h" → sub-hour shows "<1h". maxUnitCount (clamped [1,4]) takes up to
// N non-zero units after dropping below-minUnit + leading zeros, while
// preserving internal/trailing zeros: 2h3m4s → "2h3m", 2h0m → "2h0m".
type TimeFormat = {
  minUnit: "m" | "s" | "h";
  maxUnitCount: number;
};

const DEFAULT_TIME_FORMAT: TimeFormat = {
  minUnit: "s",
  maxUnitCount: 2,
};

// Reset-countdown glyphs (e.g. "2h3m🕛"). Indexed by
// remainingMs / resetDurationMs (ascending remaining-time ratio);
// min(…, length-1) clamps ratio=1.0. Providers without start_time
// (DeepSeek, legacy) fall back to index 0.
type Countdown = {
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


// Per-subkey diagnostics opt-in, AND-gated with
// CREDITGAUGE_DIAGNOSTICS_ENABLE (see diagnostics.ts:isSubkeyEnabled).
// Truthy strings ("1"/"true"/"yes") and boolean true accepted;
// unknown keys silently dropped.
function parseDebugFlags(
  raw: unknown,
): Partial<Record<import("./diagnostics.ts").Subkey, boolean>> {
  const validKeys = new Set<import("./diagnostics.ts").Subkey>([
    "stdin",
    "statusStore",
    "config",
    "cache",
    "statCache",
    "smokeNormalizeTick",
    "pluginVersion",
    "parse",
  ]);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Partial<Record<import("./diagnostics.ts").Subkey, boolean>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!validKeys.has(k as import("./diagnostics.ts").Subkey)) continue;
    if (v === true) {
      out[k as import("./diagnostics.ts").Subkey] = true;
    } else if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "1" || s === "true" || s === "yes") {
        out[k as import("./diagnostics.ts").Subkey] = true;
      }
      // else: leave unset (falsy)
    }
    // else (number, object, null, undefined): leave unset
  }
  return out;
}

// Declarative provider list. Each entry describes URL matching,
// rendering overrides, interval/currency mappings, and credentials.
// Acquisition and parsing are owned by the dynamically imported plugin
// selected by the provider key.
const DEFAULT_CONFIG: {
  cacheTtlMs: number;
  fetchTimeoutMs: number;
  display: DisplayMode;
  modeLabels: { used: string; remaining: string; balance: string };
  // Top-level prefix labels for the token-stat axes. Names mirror the
  // m_* modules they back (labelTokenIn ← m_tokenIn); each value
  // already includes its trailing colon ("in:"). Shared across the
  // per-turn / acc / sum-avg families of the same axis. Defaults
  // reproduce the hardcoded literals so existing renders stay
  // byte-identical; old v0.8.13–v0.8.21 names (labelIn, labelOut, …)
  // are accepted as deprecated aliases (see applyOverrides).
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
    // per-turn / acc / sum-avg of token-IN throughput (t/s); shares
    // `labelTokenIn` default across families.
    labelTokenInSpeed: string;
    // per-turn / acc / sum-avg of token-OUT throughput (t/s).
    labelTokenOutSpeed: string;
    // system RAM usage label (m_memUsage).
    labelMemUsage: string;
    // system RAM used/total-bytes labels (m_memUsed / m_memTotal).
    labelMemUsed: string;
    labelMemTotal: string;
    // cache hit-rate ratio (m_tokenHitRate).
    labelTokenHitRate: string;
    // context-window occupancy / capacity / pct prefixes (m_context*).
    labelContextSize: string;
    labelContextWindowSize: string;
    labelContextUsedPercent: string;
    labelContextRemainingPercent: string;
    // m_contextUsage two-tone x/y prefix (used/capacity); default "ctx:".
    labelContextUsage: string;
    // tick-window start/end prefixes (m_accStartTime / m_sumStartTime /
    // m_sumEndTime; cross-project min of startAt / max of lastAt).
    labelStartTime: string;
    labelEndTime: string;
    // m_quota prefix; default "quota: " (trailing space) renders
    // "quota: 123/500"; valueOnly drops it.
    labelQuota: string;
    // m_tokenCost / m_accTokenCost / m_sumTokenCost prefix; default "cost:".
    labelTokenCost: string;
    // m_sumEstQuota prefix (estimates periodic quota from the plan
    // window's aligned used%); renders "est:$30.20".
    labelEstQuota: string;
    // m_pluginSource glyphs: 📌 built-in, 🎨 user override at
    // query_plugins/<id>/, 🔖 reserved future "claude 官方" branch,
    // ❗ matched provider has no plugin (neither user nor built-in).
    labelPluginSystem: string;
    labelPluginUserDefined: string;
    labelPluginCC: string;
    labelPluginMissing: string;
    // m_branch|withStatus:true clean/dirty suffix glyphs; default "✅" / "🟠".
    labelGitClean: string;
    labelGitDirty: string;
  };
  colors: typeof DEFAULT_COLORS;
  cacheHitColors: typeof DEFAULT_CACHE_HIT_COLORS;
  thresholds: typeof DEFAULT_THRESHOLDS;
  currency: typeof DEFAULT_CURRENCY;
  stale: typeof DEFAULT_STALE;
  bar: typeof DEFAULT_BAR;
  countdown: Countdown;
  timeFormat: TimeFormat;
  // m_* auto-space affixes. prefixSpace (default true) prepends a
  // space before each module; suffixSpace (default false) appends one
  // before a following module. Explicit |prefix:| / |suffix:| wins.
  prefixSpace: boolean;
  suffixSpace: boolean;
  // Reusable template fragments consumed by m_template's first argument.
  lineTemplates: typeof DEFAULT_LINE_TEMPLATES;
  // The template actually rendered: a string[] of tokens (may include
  // `m_template|_X` refs pulling chunks from `lineTemplates`).
  statuslineTemplate: string[];
  tokenFormat: typeof DEFAULT_TOKEN_FORMAT;
  // Per-model token pricing for the m_tokenCost family, loaded from
  // config.tokenPrices.json at startup. Nested provider→model dict
  // with `default` fallback at each level; the active provider's
  // config.json override lives in tokenPricesOverride (priorities
  // 1/3 of resolveTokenPrice's 5-layer cascade). {} → cost:n/a.
  tokenPrices: TokenPricesFile;
  // Provider-scoped token-price override set by applyProviderOverrides
  // from the active provider's config block. Flat model→price dict
  // (already scoped); `default` = provider fallback. Null when none.
  // Priorities 1/3 of the resolution cascade.
  tokenPricesOverride: TokenPricesOverride;
  // Exchange rates from config.tokenPrices.json default block
  // (1 baseCurrency = rate targetCurrency). Empty when unconfigured.
  exchangeRates: Record<string, number>;
  // Plugin version from .claude-plugin/plugin.json, set at startup by
  // index.ts; read by m_version. Tests inject via __resetForTest.
  version: string;
  // Declarative provider registry; see DEFAULT_PROVIDERS.
  providers: Record<string, ProviderEntry>;
  // top-level `intervals` was REMOVED — plugins parse their own responses.
  // `m_quote` fetcher passes `--insecure` to curl so self-signed /
  // expired / untrusted-CA HTTPS endpoints work. Opt-in (default
  // false); enabled via config `quoteInsecureTls` or a per-token
  // `|insecureTls|<true|false>` arg. No env-var seed — it's a
  // config-level decision.
  quoteInsecureTls: boolean;
  // Per-subkey diagnostics opt-in (AND-gated with the env var; see parseDebugFlags).
  debug: Partial<Record<import("./diagnostics.ts").Subkey, boolean>>;
} = {
  cacheTtlMs: 60_000,
  fetchTimeoutMs: 5_000,
  display: "remaining",
  // Mode label prefixes (m_modeLabel); defaults preserve hardcoded literals.
  modeLabels: { used: "Usage:", remaining: "Remain:", balance: "Balance:" },
  // Defaults mirror the hardcoded literals so existing renders stay byte-identical.
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
    labelMemUsed: "used:",
    labelMemTotal: "total:",
    labelTokenHitRate: "hit:",
    // Context-window prefixes (defaults preserve hardcoded literals).
    labelContextSize: "size:",
    labelContextWindowSize: "size:",
    labelContextUsedPercent: "used:",
    labelContextRemainingPercent: "remain:",
    // m_contextUsage two-tone x/y prefix.
    labelContextUsage: "ctx:",
    // Tick-window start/end prefixes.
    labelStartTime: "start:",
    labelEndTime: "end:",
    // "quota: " (trailing space) so the concat reads "quota: 123/500".
    labelQuota: "quota: ",
    // "cost:" — trailing colon so the renderer can concat.
    labelTokenCost: "cost:",
    // "est:" — trailing colon so the renderer can concat.
    labelEstQuota: "est:",
    // m_pluginSource glyphs: 📌 built-in, 🎨 user override, 🔖 reserved
    // CC branch, ❗ missing plugin (renderer drops the module when
    // pluginSource is null).
    labelPluginSystem: "📌",
    labelPluginUserDefined: "🎨",
    labelPluginCC: "🔖",
    labelPluginMissing: "❗",
    // m_branch|withStatus:true clean/dirty suffix glyphs.
    labelGitClean: "✅",
    labelGitDirty: "🟠",
  },
  colors: DEFAULT_COLORS,
  cacheHitColors: DEFAULT_CACHE_HIT_COLORS,
  thresholds: DEFAULT_THRESHOLDS,
  currency: DEFAULT_CURRENCY,
  stale: DEFAULT_STALE,
  bar: DEFAULT_BAR,
  countdown: DEFAULT_COUNTDOWN,
  timeFormat: DEFAULT_TIME_FORMAT,
  prefixSpace: true,
  suffixSpace: false,
  lineTemplates: DEFAULT_LINE_TEMPLATES,
  statuslineTemplate: DEFAULT_STATUSLINE_TEMPLATE,
  tokenFormat: DEFAULT_TOKEN_FORMAT,
  // {} — every model is a lookup miss → cost:n/a until the user adds
  // entries to config.tokenPrices.json.
  tokenPrices: {},
  // null — set by applyProviderOverrides when the provider config has tokenPrices.
  tokenPricesOverride: null,
  // Extra fields on config.tokenPrices.json's `default` entry are
  // exchange rates from the base currency to the named currency
  // (e.g. default.USD = 0.15 → 1 CNY = 0.15 USD when default.currency
  // = "CNY"). Empty when unconfigured.
  exchangeRates: {} as Record<string, number>,
  version: "",
  providers: DEFAULT_PROVIDERS,
  quoteInsecureTls: false,
  // {} — all subkeys off until configured.
  debug: {} as Partial<Record<import("./diagnostics.ts").Subkey, boolean>>,
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
  // Inject the plugin version at startup (mutates _current in place).
  setVersion(v: string): void {
    _current.version = v;
  },
};

// Convert a price entry's currency via the exchange-rate table (pivot
// = baseCurrency). Returns null when the pair has no safe conversion
// path (a rate is missing or ≤0) — the caller keeps rejecting the entry
// so a wrong-currency cost is never silently accepted. scale =
// toRate/fromRate with base→X treated as X's own rate.
function convertPriceEntryTo(
  entry: TokenPriceEntry,
  target: string,
  rates: Record<string, number>,
  baseCurrency: string,
): TokenPriceEntry | null {
  if (entry.currency === target) return entry;
  const fromRate = entry.currency === baseCurrency ? 1 : rates[entry.currency];
  const toRate = target === baseCurrency ? 1 : rates[target];
  if (!(fromRate != null && fromRate > 0) || !(toRate != null && toRate > 0)) {
    return null;
  }
  const scale = toRate / fromRate;
  return {
    in: entry.in * scale,
    out: entry.out * scale,
    cachedIn: entry.cachedIn * scale,
    currency: target,
  };
}

// Apply a provider's CURRENCY filter to one candidate price entry:
//   - no filter (undefined) → accept as-is
//   - entry currency in the filter → accept as-is
//   - otherwise → convert to CURRENCY[0] via exchangeRates when a safe
//     path exists; reject when it doesn't. An empty CURRENCY array keeps
//     its current all-reject semantics (CURRENCY[0] undefined → null).
function acceptPriceEntry(
  entry: TokenPriceEntry,
  currencyFilter: string[] | undefined,
  config: Config,
): TokenPriceEntry | null {
  if (!currencyFilter) return entry;
  if (currencyFilter.includes(entry.currency)) return entry;
  const target = currencyFilter[0];
  if (!target) return null;
  return convertPriceEntryTo(
    entry,
    target,
    config.exchangeRates,
    config.tokenPrices.default?.currency ?? "CNY",
  );
}

// Resolve the effective token price for provider+model via the
// 5-layer cascade (highest first):
//   1. config.json providers.<p>.config.tokenPrices.<model>
//   2. config.tokenPrices.json <provider>.<model>
//   3. config.json providers.<p>.config.tokenPrices.default
//   4. config.tokenPrices.json <provider>.default
//   5. config.tokenPrices.json default
// Every layer passes through the provider's CURRENCY filter: an entry
// whose currency is outside the filter is converted to CURRENCY[0] via
// the exchange-rate table (default block's non-standard fields) when a
// safe path exists — so a CNY global default can still price a USD-only
// provider — and rejected otherwise. No match → null (callers render
// cost:n/a). Accepts a Config snapshot + providerId + modelId. When the
// model name ends with `[...]` (e.g. `deepseek-v4-flash[1m]`) and
// nothing matches, retry with the bracket suffix stripped.
export function resolveTokenPrice(
  config: Config,
  providerId: string | null,
  modelId: string | null,
): TokenPriceEntry | null {
  if (!modelId) return null;

  const override = config.tokenPricesOverride;
  const file = config.tokenPrices;

  // Provider CURRENCY filter: only price entries whose currency is in
  // this array are accepted (avoids silently wrong costs from a
  // different-currency fallback). An entry outside the filter may still
  // be converted to CURRENCY[0] via exchange rates (see acceptPriceEntry).
  // Absent = no filter.
  const currencyFilter: string[] | undefined =
    providerId
      ? (config.providers[providerId] as Record<string, unknown> | undefined)
          ?.CURRENCY as string[] | undefined
      : undefined;

  // 1. Provider override — specific model
  if (override?.[modelId]) {
    const c = acceptPriceEntry(override[modelId], currencyFilter, config);
    if (c) return c;
  }

  // 2. File — specific model
  if (providerId) {
    const providerBlock = file[providerId];
    if (providerBlock && typeof providerBlock === "object" && !Array.isArray(providerBlock)) {
      const modelEntry = (providerBlock as Record<string, unknown>)[modelId];
      if (modelEntry && typeof modelEntry === "object" && !Array.isArray(modelEntry)) {
        const e = modelEntry as Record<string, unknown>;
        if (typeof e.in === "number" && typeof e.out === "number" &&
            typeof e.cachedIn === "number" && typeof e.currency === "string") {
          const c = acceptPriceEntry(
            { in: e.in, out: e.out, cachedIn: e.cachedIn, currency: e.currency },
            currencyFilter,
            config,
          );
          if (c) return c;
        }
      }
    }
  }

  // 3. Provider override — default
  if (override?.default) {
    const c = acceptPriceEntry(override.default, currencyFilter, config);
    if (c) return c;
  }

  // 4. File — provider default
  if (providerId) {
    const providerBlock = file[providerId];
    if (providerBlock && typeof providerBlock === "object" && !Array.isArray(providerBlock)) {
      const def = (providerBlock as Record<string, unknown>).default;
      if (def && typeof def === "object" && !Array.isArray(def)) {
        const e = def as Record<string, unknown>;
        if (typeof e.in === "number" && typeof e.out === "number" &&
            typeof e.cachedIn === "number" && typeof e.currency === "string") {
          const c = acceptPriceEntry(
            { in: e.in, out: e.out, cachedIn: e.cachedIn, currency: e.currency },
            currencyFilter,
            config,
          );
          if (c) return c;
        }
      }
    }
  }

  // 5. File — global default
  if (file.default) {
    const c = acceptPriceEntry(file.default, currencyFilter, config);
    if (c) return c;
  }

  // Bracket-suffix fallback: strip trailing `[...]` and retry
  // (recursion handles multiple groups, e.g. `foo[1m][2m]`).
  const bracketMatch = modelId.match(/^(.+)\[[^\]]*\]$/);
  if (bracketMatch) {
    return resolveTokenPrice(config, providerId, bracketMatch[1]);
  }

  return null;
}

// ----- Loader -----

function defaultConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return join(
    claudeRoot,
    "plugins",
    "creditgauge",
    "config.json",
  );
}

// Test hook: replace the path resolver so tests can point at a temp
// file without monkey-patching node:os. Production code never sets it.
let _pathResolver: () => string = defaultConfigPath;

// config.tokenPrices.json path — independent of config.json's location.
function defaultTokenPricesPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return join(claudeRoot, "plugins", "creditgauge", "config.tokenPrices.json");
}

let _tokenPricesPathResolver: () => string = defaultTokenPricesPath;

export async function loadConfig(): Promise<Config> {
  const path = _pathResolver();

  // Cheap existence probe — the common case is no config file, no need
  // to even open the file descriptor.
  diagnostics.logFsRead(path, "config.loadConfig", undefined, undefined, "config");
  if (!existsSync(path)) {
    // No config file — minimal DEFAULT_STATUSLINE_TEMPLATE; other
    // modules only render when the user opts in via config.json.
    _current = {
      ...DEFAULT_CONFIG,
      statuslineTemplate: DEFAULT_STATUSLINE_TEMPLATE,
    };
    // Always load token prices even without config.json (independent path).
    _current.tokenPrices = loadTokenPricesFile();
  _current.exchangeRates = loadExchangeRates();
    return _current;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    warn(`read failed (${(e as Error).message}); using defaults`);
    _current = DEFAULT_CONFIG;
    _current.tokenPrices = loadTokenPricesFile();
  _current.exchangeRates = loadExchangeRates();
    return _current;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    warn(`invalid JSON (${(e as Error).message}); using defaults`);
    _current = DEFAULT_CONFIG;
    _current.tokenPrices = loadTokenPricesFile();
  _current.exchangeRates = loadExchangeRates();
    return _current;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn("root must be a JSON object; using defaults");
    _current = DEFAULT_CONFIG;
    _current.tokenPrices = loadTokenPricesFile();
  _current.exchangeRates = loadExchangeRates();
    return _current;
  }

  // Merge user config on top of DEFAULT_CONFIG, then apply
  // fine-grained debug flags on top of the merged result.
  _current = mergeConfig(parsed as Record<string, unknown>);
  _current.debug = parseDebugFlags((parsed as Record<string, unknown>).debug);

  // Load config.tokenPrices.json; on failure keep {} (cost:n/a).
  _current.tokenPrices = loadTokenPricesFile();
  _current.exchangeRates = loadExchangeRates();

  return _current;
}

// Parse config.tokenPrices.json (independent of config.json's location).
// Returns the parsed file, or {} on any failure (missing/bad JSON/wrong shape).
function loadTokenPricesFile(): TokenPricesFile {
  const path = _tokenPricesPathResolver();

  diagnostics.logFsRead(path, "config.loadTokenPricesFile", undefined, undefined, "config");
  if (!existsSync(path)) return {};

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    warn(`config.tokenPrices.json read failed (${(e as Error).message}); using default {}`);
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    warn(`config.tokenPrices.json invalid JSON (${(e as Error).message}); using default {}`);
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn("config.tokenPrices.json root must be a JSON object; using default {}");
    return {};
  }

  const obj = parsed as Record<string, unknown>;
  const out: TokenPricesFile = {};

  // Validate the `default` global fallback entry.
  if ("default" in obj) {
    const entry = validateTokenPriceEntry(obj.default, "default");
    if (entry) out.default = entry;
  }

  // Validate per-provider blocks.
  for (const [key, val] of Object.entries(obj)) {
    if (key === "default") continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) {
      warn(`config.tokenPrices.json.${key} must be an object; skipping`);
      continue;
    }
    const providerBlock = val as Record<string, unknown>;
    const providerOut: Record<string, TokenPriceEntry> = {};

    if ("default" in providerBlock) {
      const entry = validateTokenPriceEntry(providerBlock.default, `${key}.default`);
      if (entry) providerOut.default = entry;
    }

    for (const [modelId, entry] of Object.entries(providerBlock)) {
      if (modelId === "default") continue;
      const validated = validateTokenPriceEntry(entry, `${key}.${modelId}`);
      if (validated) providerOut[modelId] = validated;
    }

    if (Object.keys(providerOut).length > 0) {
      out[key] = providerOut;
    }
  }

  return out;
}

// Extra fields on config.tokenPrices.json's `default` entry are
// exchange rates from the base currency (e.g. default.USD = 0.15).
// Returns {} when no rates exist.
function loadExchangeRates(): Record<string, number> {
  const path = _tokenPricesPathResolver();
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const obj = parsed as Record<string, unknown>;
  const defBlock = obj.default;
  if (!defBlock || typeof defBlock !== "object" || Array.isArray(defBlock)) return {};
  const rates: Record<string, number> = {};
  const knownKeys = new Set(["in", "out", "cachedIn", "currency"]);
  for (const [key, val] of Object.entries(defBlock)) {
    if (!knownKeys.has(key) && typeof val === "number" && Number.isFinite(val) && val > 0) {
      rates[key.toUpperCase()] = val;
    }
  }
  return rates;
}

// Validate one tokenPrices entry; returns the entry or null on failure.
function validateTokenPriceEntry(
  raw: unknown,
  path: string,
): TokenPriceEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warn(`config.tokenPrices.json ${path} must be an object; skipping`);
    return null;
  }
  const em = raw as Record<string, unknown>;
  const built: TokenPriceEntry = { in: 0, out: 0, cachedIn: 0, currency: "USD" };
  let ok = true;
  for (const key of ["in", "out", "cachedIn"] as const) {
    if (key in em) {
      if (typeof em[key] === "number" && Number.isFinite(em[key] as number) && (em[key] as number) >= 0) {
        built[key] = em[key] as number;
      } else {
        warn(`config.tokenPrices.json ${path}.${key} must be a non-negative number; using default`);
        ok = false;
      }
    }
  }
  if ("currency" in em) {
    if (typeof em.currency === "string" && (em.currency as string).length > 0) {
      built.currency = (em.currency as string).toUpperCase();
    } else {
      warn(`config.tokenPrices.json ${path}.currency must be a non-empty string; using default`);
      ok = false;
    }
  }
  return ok || Object.keys(em).length > 0 ? built : null;
}

// Apply a provider-specific Config override on top of the active
// snapshot (called from index.ts after loadConfig + matchProvider so
// every consumer sees the merged view):
//
//   defaults  ⊕  config.json top-level  ⊕  providerEntry.config
//             (lowest)                  (highest)
//
// Deep-clones the current snapshot and re-runs the same per-field
// validators on provider.config — a typo there still produces a stderr
// warn, never silent acceptance, and user-config fixes are preserved.
export function applyProviderOverrides(raw: Record<string, unknown>): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  if ("providers" in raw) {
    warn(
      "provider.config must not contain a nested 'providers' key (would recurse); ignoring",
    );
    delete (raw as Record<string, unknown>).providers;
  }
  const base = JSON.parse(JSON.stringify(_current)) as Config;
  _current = applyOverrides(base, raw, true);
}

// Exported so renderer modules (src/render.ts) can reuse the stderr +
// diagnostics-JSONL wiring (e.g. m_template:missingkey).
export function warn(msg: string): void {
  process.stderr.write(`creditgauge: config ${msg}\n`);
  // Also append to the diagnostics JSONL so m_warning can surface it.
  // Disk errors are swallowed inside diagnostics.append.
  diagnostics.append("warning", "config", msg);
}

// ----- Per-field validation + merge -----
// Each validator returns the validated value or DEFAULT_CONFIG's value
// with a stderr warning. Sections are isolated: a bad `colors` block
// does NOT poison `cacheTtlMs`.

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
  // Accept any SGR sequence (\x1b[...m); reject newlines so a JSON
  // mistake can't inject multi-line escape codes into the statusline.
  if (/^\x1b\[[0-9;]*m$/.test(v)) return v;
  return null;
}

// Apply a raw override object on top of an existing Config snapshot.
// Used by both mergeConfig and applyProviderOverrides — each step runs
// the same validators in sequence, so precedence is:
//
//   defaults  ⊕  config.json  ⊕  providerEntry.config
//
// Re-validating on top of the merged snapshot (instead of re-running
// mergeConfig) keeps each layer's effect independent.
function applyOverrides(base: Config, raw: Record<string, unknown>, isProviderOverride = false): Config {
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
      // DeepSeek (balance) path prefix — flows through m_modeLabel.
      if (typeof m.balance === "string") out.modeLabels.balance = m.balance;
      else if ("balance" in m)
        warn("modeLabels.balance must be a string; using default");
    } else {
      warn("modeLabels must be an object; using default");
    }
  }

  // Top-level label overrides. Same partial-merge shape as modeLabels:
  // fields optional, invalid types dropped with a one-line warn. Values
  // are used verbatim (no trailing space — callers append to a number).
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
        "labelMemUsed",
        "labelMemTotal",
        "labelTokenHitRate",
        "labelContextSize",
        "labelContextWindowSize",
        "labelContextUsedPercent",
        "labelContextRemainingPercent",
        "labelContextUsage",
        "labelStartTime",
        "labelEndTime",
        "labelQuota",
        "labelTokenCost",
        "labelEstQuota",
        "labelPluginSystem",
        "labelPluginUserDefined",
        "labelPluginCC",
        "labelPluginMissing",
        "labelGitClean",
        "labelGitDirty",
      ];
      for (const f of fields) {
        if (typeof lm[f] === "string") {
          out.labels[f] = lm[f] as string;
        } else if (f in lm) {
          warn(`labels.${f} must be a string; using default`);
        }
      }
      // Old v0.8.13–v0.8.21 names (labelIn / labelOut / …) are hard-
      // rejected with a warn — never silently mirrored, which would
      // mask config bugs. (`labelApiCalls` / `labelMemUsage` were not
      // renamed, so they stay in `fields` above.)
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

  // top-level `intervals` was REMOVED — silently dropped if present.
  // Plugins parse their own responses in fillQuota/fillBalance.

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

  // Same per-field validator as `colors`; three bands good / warn / bad.
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

  // `stale` block accepted (e.g. ageEmoji), but only ageEmoji is
  // recognized; unknown sub-keys silently ignored.
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

  // vX.X.X+ — auto-space affix toggles. Non-boolean → warn + default.
  if ("prefixSpace" in raw) {
    if (typeof raw.prefixSpace === "boolean") out.prefixSpace = raw.prefixSpace;
    else warn("prefixSpace must be a boolean; using default");
  }
  if ("suffixSpace" in raw) {
    if (typeof raw.suffixSpace === "boolean") out.suffixSpace = raw.suffixSpace;
    else warn("suffixSpace must be a boolean; using default");
  }

  // tokenFormat (compact numbers for m_token*); all sub-keys optional.
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
      // Speed scale band overrides — strictly an ascending 4-tuple
      // (3- or 5-tuples are rejected).
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
        // Any finite number in [3, 64].
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

  // The `separators` config field is REMOVED — silently ignored if
  // present. Use the six s_<name> tokens or m_label|<text>.

  // Legacy `lineTemplate` is REMOVED — detected so a v0.3.x user gets
  // a clear warning, but not migrated (the preset mapping would be
  // best-effort). Use statuslineTemplate + lineTemplates.
  if ("lineTemplate" in raw) {
    warn(
      "lineTemplate is removed in v0.4.0; use lineTemplates + " +
      "statuslineTemplate instead. See CHANGELOG.md for the upgrade " +
      "path. Ignoring the legacy field.",
    );
  }

  // Reusable template fragments keyed for m_template's first arg.
  // Entries containing `m_template` are stripped with a warning
  // (recursion would be infinite at render time).
  if ("lineTemplates" in raw) {
    const lt = raw.lineTemplates;
    if (!lt || typeof lt !== "object" || Array.isArray(lt)) {
      warn("lineTemplates must be an object of string arrays; using defaults");
    } else {
      const ltm = lt as Record<string, unknown>;
      const merged: LineTemplates = { ...out.lineTemplates };
      for (const [name, value] of Object.entries(ltm)) {
        // `_`-prefix colliding with a built-in preset is rejected (the
        // built-in wins, user entry dropped with a warn); non-colliding
        // `_custom` entries are preserved.
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

  // Accepts array-form (raw token list) or string-form (a preset name
  // from DEFAULT_STATUSLINE_PRESETS). A bare lineTemplates fragment
  // name is NOT valid here — presets and fragments are distinct.
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

  // Opt-in curl --insecure gate (default false). Non-boolean values
  // fall back to the safe default with a stderr warn.
  if ("quoteInsecureTls" in raw) {
    const v = raw.quoteInsecureTls;
    if (typeof v === "boolean") {
      out.quoteInsecureTls = v;
    } else {
      warn("quoteInsecureTls must be a boolean; using default");
    }
  }

  // tokenPrice (singular) REMOVED — warn and ignore.
  if ("tokenPrice" in raw) {
    warn("tokenPrice is removed; use tokenPrices (per-model dict keyed by model.id) instead — ignoring");
  }
  // tokenPrices: top-level config.json → warn + ignore (moved to
  // config.tokenPrices.json); provider-level → validated into
  // out.tokenPricesOverride (priorities 1/3 of the cascade).
  if ("tokenPrices" in raw) {
    const tp = raw.tokenPrices;
    if (!isProviderOverride) {
      // Top-level pricing moved to config.tokenPrices.json; silently
      // ignored here (no migration shim).
      if (tp && typeof tp === "object" && !Array.isArray(tp) && Object.keys(tp as Record<string, unknown>).length > 0) {
        warn("tokenPrices in config.json is ignored; pricing moved to config.tokenPrices.json — copy your entries there");
      }
    } else {
      // Provider-level: validate into the active provider's override
      // (flat model→price dict).
      if (tp && typeof tp === "object" && !Array.isArray(tp)) {
        const override: NonNullable<TokenPricesOverride> = {};
        for (const [modelId, entry] of Object.entries(tp as Record<string, unknown>)) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            warn(`tokenPrices.${modelId} must be an object; ignoring entry`);
            continue;
          }
          const em = entry as Record<string, unknown>;
          const built: TokenPriceEntry = { in: 0, out: 0, cachedIn: 0, currency: "USD" };
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
          override[modelId] = built;
        }
        out.tokenPricesOverride = Object.keys(override).length > 0 ? override : null;
      } else {
        warn("providers.<p>.config.tokenPrices must be an object; ignoring");
      }
    }
  }

  // Note: `providers` is handled by mergeConfig only — this helper
  // intentionally doesn't touch it (applyProviderOverrides rejects it).

  return out;
}

// Top-level config.json loader — wraps applyOverrides plus the
// `providers` block handling that lives only at this layer.
function mergeConfig(raw: Record<string, unknown>): Config {
  const out = applyOverrides(
    JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config,
    raw,
  );

  // providers — deep-merged on top of DEFAULT_PROVIDERS (existing keys
  // override fields; new keys appended). Malformed entries are dropped
  // with a stderr warn, never auto-filled. A missing `providers` key
  // falls back to DEFAULT_PROVIDERS via the deep-clone above.
  if ("providers" in raw) {
    const p = raw.providers;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      warn("providers must be an object; using default");
    } else {
      const pm = p as Record<string, unknown>;
      const merged: Record<string, ProviderEntry> = {};
      for (const [name, defaultEntry] of Object.entries(DEFAULT_PROVIDERS)) {
        // Partial user entries inherit remaining fields from the
        // default; a non-object value drops the entry with a warn.
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

// Validate one ProviderEntry (merged result, not raw input — the caller
// fills missing fields from the default first). Returns null on fatal
// malformation (e.g. invalid TYPE drops the whole entry).
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
  // Provider-specific Config overrides, validated here only for shape
  // (plain object, no nested `providers` key). Merged into the active
  // snapshot at startup by applyProviderOverrides (per-field validators
  // run then, so a typo still warns).
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
  // Forward the validated config block, or omit it when absent.
  const validatedConfig =
    "config" in e &&
    e.config &&
    typeof e.config === "object" &&
    !Array.isArray(e.config)
      ? (e.config as Record<string, unknown>)
      : undefined;
  // per-provider `intervals` and `currencies` blocks REMOVED — plugins
  // own their parsing, so these fields are dropped at the type level
  // (not part of ProviderEntry). Unknown user-defined fields (e.g.
  // WORKSPACE_URL) are forwarded so plugins can read custom parameters.
  const knownKeys = new Set([
    "TYPE",
    "BASE_URL_COMPARED_TO",
    "COMPARE_METHOD",
    "config",
    "AUTHENTICATION_KEY",
  ]);
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(e)) {
    if (!knownKeys.has(key) && key in e) {
      extra[key] = e[key];
    }
  }
  return {
    TYPE: t as ProviderType,
    BASE_URL_COMPARED_TO: base,
    COMPARE_METHOD: cm as CompareMethod,
    ...(validatedConfig ? { config: validatedConfig } : {}),
    ...(validatedAuthenticationKey ? { AUTHENTICATION_KEY: validatedAuthenticationKey } : {}),
    ...extra,
  };
}

// ----- Test-only -----

export function __resetForTest(overrides?: Partial<Config>): void {
  if (overrides === undefined) {
    // Deep-clone DEFAULT_CONFIG so setVersion()'s in-place mutation
    // can't leak across reset calls.
    _current = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
    return;
  }
  // Deep-merge so a partial override (e.g. stale.ageEmoji) doesn't
  // erase sibling fields.
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
  // Independent tokenPrices path hooks for no-config testing.
  setTokenPricesPathResolver(fn: () => string): void {
    _tokenPricesPathResolver = fn;
  },
  resetTokenPricesPathResolver(): void {
    _tokenPricesPathResolver = defaultTokenPricesPath;
  },
};
