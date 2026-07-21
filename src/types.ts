// Provider discriminated union. A single `ANTHROPIC_BASE_URL` selects exactly
// one provider at runtime; `null` means "no provider — render nothing".
//
// v0.2.21: Provider widened to `string | null` — providers are now
// data-driven via the `providers` config block (see src/config.ts and
// src/providers.ts). Adding a provider requires a config entry and a
// plugin module, but does not require editing this type union. The TYPE
// discriminator drives the plugin output shape and renderer / fail-label
// path.

export type Provider = string | null;

// Closed enum for now. If a new TYPE is added, the fetcher / renderer /
// template selection logic grows a new branch — data shape changes
// cannot be made data-driven (they need code to interpret them).
export type ProviderType = "QUOTA" | "BALANCE";

export type CompareMethod = "EXACT" | "INCLUDE" | "STARTWITH";

// ----- v0.4.0+ token-usage module ---------------------------------------
//
// One row appended per statusline tick. Source = stdin (per probe schema
// captured 2026-06-27). Persisted to disk so m_token5h/m_token7d can
// query "how many tokens in the last N hours" across ticks.
//
// `at` is the wall-clock timestamp (Unix ms) when this tick fired.
// `in`/`out` mirror `context_window.total_input_tokens` /
// `total_output_tokens` — the per-tick cumulative numbers from Claude
// Code. `ctx_*` mirror `context_window.current_usage.*` — the
// post-turn context snapshot. `cwd` is the project working directory
// from stdin, used to scope the on-disk path (see token-store.ts).
// v0.8.0+ — TokenSample field rename. The previous names were
// semantically backward (e.g. `in` actually held the session-cumulative
// `totals.input`, while `ctx_in` held the per-turn delta). v0.8.0
// aligns the field names with the module family they feed into:
//
//   totalIn        = session-cumulative input tokens (was `in`)
//                      → m_tokenTotalIn, m_sumTokenTotalIn
//   totalOut       = session-cumulative output tokens (was `out`)
//                      → m_tokenTotalOut (v0.8.0+ rename from
//                        m_tokenOutTotal), m_sumTokenOut
//   in             = per-turn input delta (was `ctx_in`)
//                      → m_tokenIn, m_sumTokenIn
//   cacheIn        = per-turn cache_read_input_tokens (was `ctx_read`)
//                      → m_tokenCachedIn, m_sumTokenCachedIn
//   cacheCreation  = per-turn cache_creation_input_tokens (was `ctx_creation`)
//                      → no module yet (reserved)
//   totalApiMs     = session-cumulative cost.totalApiDurationMs (was `apiMs`)
//                      → recorded for off-line audit; not consumed by
//                        any module directly (m_accApiMs reads in-memory)
//   apiMs          = per-tick delta of cost.totalApiDurationMs (was `deltaApiMs`)
//                      → m_apiMs, m_sumApiMs
//
// v0.8.0 is still pre-release; this rename is not backward-compatible
// with v0.4.x / v0.5.x / v0.6.x / v0.7.x jsonl rows. On-disk files
// from those versions are NOT migrated — the next tick writes the
// new schema and old rows are simply ignored by the v0.8.0 reader
// (no `at`/`totalIn`/`totalOut` → skipped). This is consistent with
// the v0.8.0 major-version bump and avoids a complex field-by-field
// migration for stale state files.
export type TokenSample = {
  at: number;
  // Required numeric fields — the reader drops rows that lack these
  // (older v0.4.x–v0.7.x rows missing the renamed fields are skipped).
  totalIn: number;
  totalOut: number;
  // Per-turn deltas — sum of these over a window = m_sumTokenIn /
  // m_sumTokenOut. Added in v0.8.0+; m_sumTokenOut was previously
  // broken because it summed the cumulative `out` column. Now
  // symmetric with `in` (also per-turn).
  in: number;
  out: number;
  cacheIn: number;
  cacheCreation: number;
  // v6.x — session+cwd are encoded in the path
  // (`state/<projectHash>/<sessionId>.jsonl`), so the row no longer
  // carries them. `model` and `totalApiMs` are stamped when
  // totalApiDurationMs>0 so per-model splits are available to
  // m_sumTokenIn:window:5h / m_sumTokenIn:window:7d consumers (the
  // v0.8.0+ replacements for the v0.4.x m_token5h / m_token7d
  // modules). `apiMs` (formerly `deltaApiMs`) is the per-tick
  // increment of `cost.totalApiDurationMs` since the prior append
  // (first tick assumes prior=0), so off-line consumers can
  // reconstruct per-API-call latency without replaying the in-memory
  // prev-tick cache. It also feeds the v0.8.0+ m_apiMs module and
  // the m_sumApiMs aggregate. Older rows without these optional
  // fields read as undefined.
  model?: string;
  // The ANTHROPIC_BASE_URL at write time — lets off-line consumers
  // distinguish which provider's data is in this row. undefined for
  // legacy rows.
  base_url?: string;
  totalApiMs?: number;
  apiMs?: number;
  // v0.8.x — the cached prev apiMs at write time. Lets off-line
  // inspectors distinguish a real delta from a fallback path:
  //   prevApiMs === null  → cache miss on first tick (no baseline);
  //                          apiMs may be the fallback value (out/50*1000)
  //                          or the full session total if totalApiMs > 0.
  //   prevApiMs === 0     → cache hit but baseline was zero.
  //   prevApiMs > 0       → normal case, apiMs = totalApiMs - prevApiMs.
  // undefined for legacy rows written before this field existed.
  prevApiMs?: number | null;
};

// What the renderer needs to know about a single tick. Built once in
// src/index.ts (drains stdin, samples, appends to disk) and passed to
// the renderer's `RenderContext` extension below.
//
// `current` = post-turn snapshot (used by m_tokenIn, m_tokenOut,
//            m_tokenCachedIn, m_tokenHitRate, m_tokenInSpeed,
//            m_tokenOutSpeed). `totals` = session cumulative (used by
//            m_tokenInTotal, m_tokenTotalOut, m_tokenTotalIn).
//            `cost` = stdin.cost block. `contextWindow` = context
//            window size + used% (m_contextSize, m_contextUsedPercent,
//            m_windowContext). The session-identity / metadata
//            fields (sessionName, modelDisplayName, effort, repo,
//            ccversion) feed the corresponding m_* modules verbatim.
//
// v0.8.0+ — semantic clarification:
//   - `current.tokenIn` / `current.tokenOut` / `current.tokenCachedIn`
//     are PER-TURN DELTAS (the contract formalized in
//     [[per-turn-delta-contract]]). The user's invariant
//     `total_input_tokens == input_tokens + cache_read_input_tokens`
//     must hold; a diagnostics warning is emitted on violation.
//   - `totals.tokenTotalIn` / `totals.tokenTotalOut` are session-cumulative.
//
// v0.9.x — module-keyed field naming. Each parse-time field is now
// named for its primary reader module so the path from stdin to
// renderer is one hop, no layer of indirection. The `current` group
// still encodes "per-turn delta" (vs the `totals` group encoding
// "session-cumulative") because the type-level invariant rides on
// that distinction. Naming summary:
//
//   current.tokenIn         ← m_tokenIn,         stdin: current_usage.input_tokens
//   current.tokenOut        ← m_tokenOut,        stdin: current_usage.output_tokens
//   current.tokenCachedIn   ← m_tokenCachedIn,   stdin: current_usage.cache_read_input_tokens
//   current.tokenCacheCreation ← (no module yet), stdin: current_usage.cache_creation_input_tokens
//   totals.tokenTotalIn     ← m_tokenTotalIn / m_tokenInTotal / m_contextSize
//                                  stdin: context_window.total_input_tokens
//   totals.tokenTotalOut    ← m_tokenTotalOut,   stdin: context_window.total_output_tokens
//   contextWindow.contextWindowSize        ← m_contextWindowSize (typo fixed),
//                                                stdin: context_window.context_window_size
//   contextWindow.contextUsedPercent       ← m_contextUsedPercent,
//                                                stdin: context_window.used_percentage
//   contextWindow.contextRemainingPercent  ← m_contextRemainingPercent,
//                                                stdin: context_window.remaining_percentage
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
    // v0.4.0+ — extended cost fields. Marked optional so older
    // test fixtures (pre-v0.4.0) type-check; the parser always
    // populates them on the live path.
    totalApiDurationMs?: number | null;
    totalLinesAdded?: number | null;
    totalLinesRemoved?: number | null;
  };
  // v0.4.0+ — session identity / metadata read from stdin root.
  // Marked optional (with `?`) so existing test fixtures that
  // construct a TokenSnapshot without the v0.4.0+ fields still
  // type-check. The parser always populates them; the renderer
  // null-checks each field before reading. Optional types better
  // reflect the "missing is fine" contract at the renderer level.
  sessionName?: string | null;
  // v0.9.x — display name from stdin.model.display_name. Read by
  // m_model (the human-readable label) and as the JSONL sample.model
  // STAMP in older versions. Kept alongside modelId because the
  // display axis and the id axis serve different purposes (label vs.
  // identifier).
  modelDisplayName?: string | null;
  // v0.9.x — model id from stdin.model.id. The canonical active-
  // model identifier for tokenPrices lookup, the JSONL sample.model
  // stamp, and the per-model accumulator slot key. Distinct from
  // modelDisplayName so users can configure price by the stable id
  // while m_model still surfaces the friendly display label.
  modelId?: string | null;
  effort?: string | null;
  repo?: { host: string | null; owner: string | null; name: string | null } | null;
  ccversion?: string | null;
  // v0.4.0+ — context window stats read from stdin.context_window.
  contextWindow?: {
    contextWindowSize: number | null;
    contextUsedPercent: number | null;
    contextRemainingPercent: number | null;
  };
};

// v0.8.0+ — per-session / per-model / per-project accumulator
// snapshot. Replaces the v0.4.x `AvgSnapshot` type (which used the
// `sum*` prefix). The setAvg / peekAvg / __resetAvgForTest helpers in
// src/render.ts return / consume this shape. Field semantics:
//
//   accTokenIn        — accumulated current.input across API calls
//   accTokenOut       — accumulated current.output across API calls
//   accTokenCachedIn  — accumulated current.cacheRead across API calls
//                       (renamed from `accTokenCachedIn` so the name matches
//                       the per-turn module `m_tokenCachedIn`)
//   accApiMs          — accumulated cost.total_api_duration_ms across API
//                       calls (cumulative, not per-tick delta — the
//                       per-tick writeBack uses `apiMs` directly)
//   accApiCalls       — count of valid API calls that produced
//                       input tokens (see sumApiCount contract in
//                       render.ts:computeTickAvg)
//
// The same shape is persisted at three slots in `status.json`:
//   tickStatus             (project-wide, accumulating)
//   tickStatus:<sessionId> (per-session, absolute since reset)
//   tickStatus:<modelName> (per-model, accumulating)
//
// All three are kept in sync by setAvg's atomic three-slot write
// (see render.ts:947-1035).
export type AccSnapshot = {
  accTokenIn: number;
  accTokenOut: number;
  accTokenCachedIn: number;
  accApiMs: number;
  accApiCalls: number;
};

// One provider's declarative config block. All fields are required;
// the mergeConfig validator drops malformed entries (with a stderr
// warn) rather than auto-filling them, so a typo can't silently
// produce a half-configured provider.
//
// v0.4.0+ — added optional `config` block: a per-provider override
// of any top-level Config field (cacheTtlMs, colors, timeFormat,
// lineTemplate, etc.). Merged into the active Config at startup in
// main() via configStore.applyProviderOverrides(provider). The
// `providers` key is forbidden inside `config` to avoid recursion;
// other top-level keys can be safely overridden on a per-provider
// basis (e.g. "minimax needs fetchTimeoutMs=3000 because the API is
// slow; deepseek uses the default 5000").
//
// v0.9.x — the per-provider `intervals` block (path-expression
// mapping onto raw response fields) was REMOVED. Built-in and
// user plugins own their own parsing via `fillQuota`/`fillBalance`
// (they return canonical Quota/Balance objects directly), so
// there's no host-side path-walker left to configure. Plugins
// only see `{ providerId, type, signal? }`.
export type ProviderEntry = {
  TYPE: ProviderType;
  BASE_URL_COMPARED_TO: string;
  COMPARE_METHOD: CompareMethod;
  // Provider-specific Config overrides. Same shape as the top-level
  // config.json (minus the `providers` key itself). Validated at
  // config-load time: must be a plain object; unknown keys are
  // forwarded to the existing per-field validators (same warn
  // behavior as the top-level config).
  config?: Record<string, unknown>;
  // Provider-specific credential. It takes precedence over
  // process.env.ANTHROPIC_AUTH_TOKEN and is passed to the plugin's
  // fetchAccountCredit method.
  AUTHENTICATION_KEY?: string;
};