// Provider discriminated union. `ANTHROPIC_BASE_URL` selects one
// provider; null = "render nothing". Providers are data-driven via the
// `providers` config block — adding one needs a config entry + plugin,
// not a type edit. TYPE drives the output shape / renderer path.
export type Provider = string | null;

// Closed enum — a new TYPE grows a new fetcher/renderer branch (data
// shape changes need code, they can't be data-driven).
export type ProviderType = "QUOTA" | "BALANCE";

export type CompareMethod = "EXACT" | "INCLUDE" | "STARTWITH";

// Per-model token price, shared across config.ts / provider overrides / render.ts.
export type TokenPriceEntry = {
  in: number;       // price per 1M input tokens
  out: number;      // price per 1M output tokens
  cachedIn: number; // price per 1M cache-read tokens
  currency: string; // e.g. "USD", "CNY"
};

// Per-provider price block: flat model→price dict with optional
// `default` fallback. The `undefined` index value keeps `default` a
// valid named property for the index signature.
export type TokenPricesProviderBlock = {
  default?: TokenPriceEntry;
  [modelId: string]: TokenPriceEntry | undefined;
};

// config.tokenPrices.json shape — nested provider→model dict with
// `default` fallback at each level:
//   default → global fallback; <provider>.default → provider-level;
//   <provider>.<model> → specific model price
export type TokenPricesFile = {
  default?: TokenPriceEntry;
  [providerId: string]: TokenPricesProviderBlock | TokenPriceEntry | undefined;
};

// Provider-scoped override (config.json providers.<p>.config.tokenPrices):
// flat model→price dict, already scoped; `default` = provider fallback.
export type TokenPricesOverride = {
  default?: TokenPriceEntry;
  [modelId: string]: TokenPriceEntry | undefined;
} | null;

// ----- Token sample (one row per statusline tick) -----
// Source = stdin (per probe schema 2026-06-27). Persisted to disk so
// the cross-project sum/avg modules and cold-slot replay can query
// history across ticks. `at` = tick wall-clock (Unix ms). `totalIn` /
// `totalOut` are session-cumulative; `in`/`out`/`cacheIn`/`cacheCreation`
// are per-turn deltas. Session + cwd are encoded in the on-disk path
// (`state/<projectHash>/<sessionId>.jsonl`). Legacy rows (pre-v0.8.0)
// carry the old field semantics and are NOT migrated — the reader
// simply skips rows lacking at/totalIn/totalOut.
export type TokenSample = {
  at: number;
  // Required — the reader drops rows lacking these (legacy rows are skipped).
  totalIn: number;
  totalOut: number;
  // Per-turn deltas — sum over a window = m_sumTokenIn / m_sumTokenOut.
  in: number;
  out: number;
  cacheIn: number;
  cacheCreation: number;
  // Per-tick cost (stdin deltas × tokenPrices); undefined for legacy rows.
  cost?: { currency: string; value: string };
  // session+cwd live in the path, not the row. `model` (stdin.model.id)
  // and `totalApiMs` are stamped so per-model splits / 5h-7d windows are
  // available. `apiMs` = per-tick increment of cost.totalApiDurationMs
  // (first tick assumes prior=0) for off-line latency reconstruction.
  // Older rows read as undefined.
  model?: string;
  // ANTHROPIC_BASE_URL at write time (provider split); undefined for legacy rows.
  base_url?: string;
  totalApiMs?: number;
  apiMs?: number;
  // Cached prev apiMs at write time, letting inspectors tell a real
  // delta from a fallback: null = no baseline (apiMs may be the out/50*1000
  // fallback); 0 = baseline was zero; > 0 = normal (apiMs = totalApiMs - prev).
  prevApiMs?: number | null;
};

// What the renderer needs to know about one tick (built in index.ts
// from stdin). `current` = per-turn deltas (m_tokenIn / m_tokenOut /
// m_tokenCachedIn / m_tokenHitRate / speeds); `totals` = session-
// cumulative (m_tokenTotalIn / m_tokenTotalOut / m_contextSize);
// `cost` = stdin.cost; `contextWindow` = size + used%/remaining%.
// Contract: `current.tokenIn`/`tokenOut`/`tokenCachedIn` are PER-TURN
// deltas, and the invariant `total_input_tokens == input_tokens +
// cache_read_input_tokens` holds (violation → diagnostics warning).
// Field names are module-keyed (current.tokenIn ← m_tokenIn,
// totals.tokenTotalIn ← m_tokenTotalIn, contextWindow.contextWindowSize
// ← m_contextWindowSize) so stdin → render is one hop.
export type TokenSnapshot = {
  sessionId: string | null;
  cwd: string | null;
  totals: {
    tokenTotalIn: number | null;
    tokenTotalOut: number | null;
  };
  current: {
    tokenIn: number | null;
    tokenOut: number | null;
    tokenCacheCreation: number | null;
    tokenCachedIn: number | null;
  };
  cost: {
    totalDurationMs: number | null;
    // Optional so pre-v0.4.0 test fixtures type-check; parser always
    // populates them on the live path.
    totalApiDurationMs?: number | null;
    totalLinesAdded?: number | null;
    totalLinesRemoved?: number | null;
  };
  // stdin-root metadata. Optional so fixtures without them type-check;
  // the parser always populates them.
  sessionName?: string | null;
  // stdin.model.display_name — human-readable label (m_model). Kept
  // alongside modelId (label vs. identifier axes).
  modelDisplayName?: string | null;
  // stdin.model.id — canonical id for tokenPrices lookup, sample.model
  // stamp, and per-model accumulator key.
  modelId?: string | null;
  effort?: string | null;
  repo?: { host: string | null; owner: string | null; name: string | null } | null;
  ccversion?: string | null;
  // Context window stats from stdin.context_window.
  contextWindow?: {
    contextWindowSize: number | null;
    contextUsedPercent: number | null;
    contextRemainingPercent: number | null;
  };
};

// Per-session / per-model / per-project accumulator snapshot (setAvg
// writes; peekAvg / readAccumulator read). acc fields accumulate the
// per-turn deltas (accTokenCachedIn renamed from accCached to match
// m_tokenCachedIn). Persisted at three slots in
// state/<projectHash>/state.json — tickStatus:<sessionId> /
// tickStatus:<projectHash> / tickStatus:<modelId> — kept in sync by
// setAvg's atomic three-slot write.
export type AccSnapshot = {
  accTokenIn: number;
  accTokenOut: number;
  accTokenCachedIn: number;
  accApiMs: number;
  accApiCalls: number;
};

// One provider's declarative config block. All fields required — the
// mergeConfig validator drops malformed entries (with a stderr warn)
// rather than auto-filling them. `config` (optional): per-provider
// override of top-level Config fields, merged at startup via
// configStore.applyProviderOverrides; a nested `providers` key is
// forbidden (recursion). The per-provider `intervals` block was REMOVED
// — plugins own their own parsing via fillQuota/fillBalance.
export type ProviderEntry = {
  TYPE: ProviderType;
  BASE_URL_COMPARED_TO: string;
  COMPARE_METHOD: CompareMethod;
  // Config overrides, same shape as top-level config.json minus
  // `providers`. Validated at load; unknown keys hit the same
  // per-field validators/warns.
  config?: Record<string, unknown>;
  // Provider credential — overrides process.env.ANTHROPIC_AUTH_TOKEN.
  AUTHENTICATION_KEY?: string;
  // Accepted currencies for cost calc; resolveTokenPrice skips entries
  // outside it (avoids a wrong-currency fallback). Absent = no filter.
  CURRENCY?: string[];
};