// Template defaults and template-only types. This module has no config-store
// or provider dependencies so it can be reused by the config facade.

// ----- Defaults — must match today's hardcoded values exactly -----

// Default separator strings referenced from lineTemplate as s_0, s_1, ….
// Empty by default in v0.4.x — the v0.4.0-release style built-in
// characters (" ", "·") are now also available as NAMED ALIASES
// vX.X.X+ — `separators` config array and the numeric `s_<n>`
// dispatch are REMOVED. The six built-in characters
// (`s_space` / `s_dot` / `s_newline` / `s_tab` / `s_colon` /
// `s_pipe`) are the only separator tokens. To render any other
// literal in your template, use `m_label|<your-text>` (or just
// drop a free-form token — the renderer emits unknown tokens
// verbatim now).

// Default line layout. A template is an ordered list of tokens; each
// token is either a display module ("m_<name>"), a named separator
// ("s_space" / "s_dot" / …), or a free-form literal. The renderer
// walks the list left-to-right and concatenates the output of each
// module, with s_<name> rendered as the built-in literal character.
// See render.ts:renderTemplate for the full grammar.
//
// Defaults reproduce the v0.2.16 output byte-for-byte:
//   quota:   "Usage: <5h> <countdown5h> · <7d> <countdown7d>"
//   balance: "Balance: <balance>"
// with s_space / s_dot / s_space composing " · " between windows.
//
// v0.4.0+ — kept around as the SOURCE OF TRUTH for the `quota` / `balance`
// entries inside `DEFAULT_LINE_TEMPLATES`. The legacy top-level
// `lineTemplate: { plan, balance }` config field is REMOVED in v0.4.0+
// (loader warns + ignores); the `m_template` module reads from
// `lineTemplates[key]` instead. Tests still reference this constant via
// __testing, so don't remove.
const DEFAULT_LINE_TEMPLATE: {
  quota: string[];
  balance: string[];
} = {
  // v0.4.x — the default template uses the NAMED ALIASES (s_space,
  // s_dot) so it works with the new empty default `separators`
  // array. The visual output is byte-for-byte identical to the
  // v0.4.0 release: the `s_0 + s_1 + s_0` composition is replaced
  // with `s_space + s_dot + s_space`, both producing " · ".
  quota: [
    "m_modeLabel|color:yellow", "s_space",
    "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
    "s_space", "m_age"
  ],
  balance: ["m_modeLabel|color:yellow", "s_space", "m_balance", "s_space", "m_age"],
};

// v0.4.0+ — registry of reusable template fragments. Each value is a
// token array (the same shape as the v0.3.x `lineTemplate.{quota,balance}`
// entries). Allowed tokens: `m_*` modules EXCEPT `m_template`, plus
// `s_*` separators. The loader strips `m_template:` tokens at load
// time so nesting is impossible.
//
// Keys are user-chosen (e.g. `foo`, `myWorkload`). The renderer reads
// from this registry when it encounters an `m_template|<key>` token
// inside `statuslineTemplate`. The legacy `PLAN_PRESETS` /
// `BALANCE_PRESETS` tables (v0.4.0–v0.8.13) are GONE in v0.8.14 — the
// seven plan + two balance presets are now first-class entries in
// this registry with `_`-prefixed keys. Plan presets
// (`_1line` / `_simple` / `_simple-alone` / `_standard` /
// `_standard-alone` / `_abundant` / `_complete`) target Quota
// providers; balance presets (`_balance_simple` /
// `_balance_simple-alone`) target BALANCE providers (DeepSeek). The
// user references them via `m_template|_X` (with optional
// `|mode|plan|balance` to constrain dispatch to one provider type —
// `m_template` defaults to `mode:plan`).
//
// `_`-prefix = built-in preset, NOT overridable by user. The loader
// rejects user `lineTemplates._*` entries whose name collides with a
// built-in key (warn + skip). Use a different key for user-defined
// presets.
//
// Default entries point at the same arrays DEFAULT_LINE_TEMPLATE uses,
// so the legacy "quota" / "balance" key names continue to resolve for
// backward-compatible lookups via `m_template:quota` / `:balance`.
export type LineTemplates = Record<string, string[]>;


// v0.8.14+ — `statuslineTemplate` is array-only. The legacy string-form
// preset-name value (`"1line"`, `"standard"`, etc.) is auto-migrated
// by `applyOverrides` to the equivalent `["m_template|_X"]` form with
// a one-shot stderr warning. Use the array form directly to silence
// the warning. The PLAN_PRESETS / BALANCE_PRESETS tables (v0.4.0–
// v0.8.13) are gone — presets are now first-class entries in
// `DEFAULT_LINE_TEMPLATES` with `_`-prefixed keys.
export type StatuslineTemplate = string[];

// Default render = `["m_template|_1line"]`. The `_1line` body is the
// byte-identical rename of the v0.4.0–v0.8.13 `PLAN_PRESETS["1line"]`
// body, so existing users with no config.json see the same render
// they did before v0.8.14 (Quota provider — the default mode of
// `m_template` matches).
export const DEFAULT_STATUSLINE_TEMPLATE: StatuslineTemplate = ["m_template|quota|type:quota", "m_template|balance|type:balance"];

// vX.X.X+ — built-in preset family (`_1line` / `_simple` /
// `_simple-alone` / `_standard` / `_standard-alone` / `_abundant` /
// `_complete` / `_balance_simple` / `_balance_simple-alone`) is
// REMOVED. There are no `_`-prefixed built-in presets anymore; the
// fragment library in DEFAULT_LINE_TEMPLATES (tokens_tick /
// tokens_acc / tokens_stat / information / tick_eval / stat_eval /
// git_info_all / context_all + quota / balance) is the user-facing
// surface. The `_`-prefix collision check in applyOverrides
// (config.ts) is retained as a no-op safety net so a future
// re-introduction of `_`-prefix built-ins won't quietly lose user
// overrides.
//
// vX.X.X+ — top-level `statuslineTemplate` presets (`simple` /
// `standard` / `abundant`) live in a sibling registry
// DEFAULT_STATUSLINE_PRESETS, NOT in DEFAULT_LINE_TEMPLATES. The
// distinction: DEFAULT_LINE_TEMPLATES.<key> is consumed via
// `m_template|<key>` indirection (fragments can be inlined anywhere
// in a template); DEFAULT_STATUSLINE_PRESETS.<key> is consumed
// directly by `statuslineTemplate: "<key>"` at the top level (a
// preset is the WHOLE statusline, not a fragment). Putting both in
// the same registry would conflate the two namespaces and let
// users shoot themselves in the foot with `m_template|simple`.
// `simple` here has no relation to the legacy v0.8.x `_simple`
// fragment (which was removed).
// DEFAULT_LINE_TEMPLATES with `_`-prefix. Bodies were migrated
// byte-for-byte from the v0.4.0–v0.8.13 PLAN_PRESETS /
// BALANCE_PRESETS tables; the bodies themselves are unchanged.
//
// Naming convention (carried over from the legacy PLAN_PRESETS /
// BALANCE_PRESETS tables):
//
//   Quota presets (default mode of `m_template` is "plan", so
//   no `|mode|plan` arg needed):
//     _1line / _simple       : tokenplan only, single line, compact
//                              (_simple is an alias of _1line — same body)
//     _simple-alone          : single line with "Usage:" label prefix
//                              (for the user running this plugin as
//                              the SOLE statusline — no upstream chain)
//     _standard              : 2 lines (tokenplan on line 0, context
//                              & token on line 1). Companion: this
//                              plugin chains an upstream statusline
//                              for session info.
//     _standard-alone        : 3 lines (adds session on line 0).
//     _abundant              : 4 lines (adds git on line 0).
//     _complete              : 5 lines (adds totals on line 3).
//
//   BALANCE presets (use `m_template|_X|mode|balance` to constrain
//   dispatch to BALANCE providers — the default `m_template` mode of
//   "plan" would silently drop these on a Quota provider):
//     _balance_simple        : default balance render
//                              ("Balance: <balance>")
//     _balance_simple-alone  : balance render with explicit
//                              "Balance:" label prefix for solo use.
//
// Per-module coloring is omitted from the presets (no `:color:` arg)
// — the user can override per module by inlining the preset into
// their own array if they want.
export const DEFAULT_LINE_TEMPLATES: LineTemplates = {
  // Legacy "quota" / "balance" entries — preserved for back-compat
  // with pre-v0.8.14 configs that referenced `m_template:quota` /
  // `:balance`. Bodies match DEFAULT_LINE_TEMPLATE (the `s_space +
  // s_dot + s_space` composition that produces " · " between
  // windows).
  quota: DEFAULT_LINE_TEMPLATE.quota,
  balance: DEFAULT_LINE_TEMPLATE.balance,

  quota_all: [
    "m_modeLabel|color:yellow", "s_space",
    "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:long", "s_space", "m_countdown|term:long",
    "s_space", "m_age"
  ],

  // ----- User-facing fragment library (vX.X.X+) -----
  // Reference via `m_template|<key>` from statuslineTemplate.
  // Tokens render left-to-right; bare literals like "[", "]",
  // "/" are emitted verbatim by the renderer (unknown tokens →
  // literal passthrough). All module names below resolve in
  // src/render.ts; the `tokens_tick` family mirrors the per-turn /
  // acc / sum-avg three-tier split of the v0.8.x contract.
  tokens_tick: [
    "m_tokenInSpeed",
    "s_space",
    "m_tokenOutSpeed",
    "s_space",
    "m_tokenHitRate",
    "s_space",
    "m_apiMs",
    "s_space",
    "m_tokenIn",
    "s_space",
    "m_tokenOut",
    "s_space",
    "m_tokenCachedIn",
    "s_space",
    "m_tokenTotalIn",
    "s_space",
    "m_tokenCost"
  ],
  tokens_acc: [
    "m_accTokenInSpeed",
    "s_space",
    "m_accTokenOutSpeed",
    "s_space",
    "m_accTokenHitRate",
    "s_space",
    "m_accApiMs",
    "s_space",
    "m_accTokenIn",
    "s_space",
    "m_accTokenOut",
    "s_space",
    "m_accTokenCachedIn",
    "s_space",
    "m_accTokenTotalIn",
    "s_space",
    "m_accApiCalls",
    "s_space",
    "m_accTokenCost",
    "s_space",
    "m_accStartTime|abs:true",
  ],
  tokens_stat: [
    "m_sumTokenInSpeed",
    "s_space",
    "m_sumTokenOutSpeed",
    "s_space",
    "m_sumTokenHitRate",
    "s_space",
    "m_sumApiMs",
    "s_space",
    "m_sumTokenIn",
    "s_space",
    "m_sumTokenOut",
    "s_space",
    "m_sumTokenCachedIn",
    "s_space",
    "m_sumTokenTotalIn",
    "s_space",
    "m_sumApiCalls",
    "s_space",
    "m_sumTokenCost",
    "s_space",
    "m_sumStartTime|abs:true",
    "s_space",
    "m_sumEndTime",
  ],
  // "information" — context window + memory + git pipeline on one
  // line; the inline `|wrap:true` on `s_pipe` wraps the trailing
  // body so the rendered segment pads out (cf. s_*|wrap| memo).
  information: [
    "[",
    "m_model",
    "] ",
    "m_label|Context: |color:yellow",
    "m_windowContext|display:used",
    "s_space",
    "m_contextSize|valueOnly:true",
    "/",
    "m_contextWindowsSize|valueOnly:true",
  ],
  mem_info: [
    "m_label|▦ Memory: |color:yellow",
    "m_windowMemUsage|display:used",
    "s_space",
    "m_memUsage|valueOnly:true",
    "s_pipe|wrap:true",
    "m_version|color:yellow",
  ],
  git_info: [
    "m_label|⎇ Git: |color:yellow",
    "m_branch",
    "s_space",
    "m_gitStatus",
    "s_space",
    "m_linesAdded",
    "s_space",
    "m_linesRemoved",
  ],
  // "tick_eval" — per-turn tick diagnostics paired with the
  // session-scoped accumulator (scope:session filters to the
  // current Claude Code process slot; resets on totalApiMs
  // regression per v0.8.x contract).
  tick_eval: [
    "m_label|⚡Tick-tock: |color:cyan",
    "s_tab",
    "m_tokenInSpeed",
    "s_space",
    "m_tokenOutSpeed",
    "s_space",
    "m_tokenIn",
    "s_space",
    "m_tokenOut",
    "s_space",
    "m_apiMs",
    "s_space",
    "m_tokenCachedIn",
    "s_space",
    "m_tokenTotalIn",
    "s_space",
    "m_template|quote",
  ],
  acc_eval: [
    "m_label|🟢Session: |color:orange",
    "s_tab",
    "m_accTokenInSpeed|scope:session",
    "s_space",
    "m_accTokenOutSpeed|scope:session",
    "s_space",
    "m_accTokenIn|scope:session",
    "s_space",
    "m_accTokenOut|scope:session",
    "s_space",
    "m_accTokenCachedIn|scope:session",
    "s_space",
    "m_accTokenHitRate|scope:session",
    "s_space",
    "m_accApiCalls|scope:session",
    "s_move|pos:74",
    "s_pipe|wrap:true",
    "m_label|🟢Project: |color:orange",
    "m_accTokenInSpeed|scope:project",
    "s_space",
    "m_accTokenOutSpeed|scope:project",
    "s_space",
    "m_accTokenIn|scope:project",
    "s_space",
    "m_accTokenOut|scope:project",
    "s_space",
    "m_accTokenCachedIn|scope:project",
    "s_space",
    "m_accTokenHitRate|scope:project",
    "s_space",
    "m_accApiCalls|scope:project",
  ],
  // "stat_eval" — cross-project JSONL scan aligned to the 5h /
  // 7d plan windows. `m_statTtlStatus` at the tail surfaces the
  // cache freshness of the underlying sum/avg scan (TTL=300s).
  stat_eval: [
    "m_label|⌛5h-align: |color:yellow",
    "s_tab",
    "m_sumTokenInSpeed|window:5h|align:true",
    "s_space",
    "m_sumTokenOutSpeed|window:5h|align:true",
    "s_space",
    "m_sumTokenIn|window:5h|align:true",
    "s_space",
    "m_sumTokenOut|window:5h|align:true",
    "s_space",
    "m_sumTokenCachedIn|window:5h|align:true",
    "s_space",
    "m_sumTokenHitRate|window:5h|align:true",
    "s_space",
    "m_sumApiCalls|window:5h|align:true",
    "s_move|pos:74",
    "s_pipe|wrap:true",
    "m_label|⌛7d-align: |color:yellow",
    "m_sumTokenInSpeed|window:7d|align:true",
    "s_space",
    "m_sumTokenOutSpeed|window:7d|align:true",
    "s_space",
    "m_sumTokenIn|window:7d|align:true",
    "s_space",
    "m_sumTokenOut|window:7d|align:true",
    "s_space",
    "m_sumTokenCachedIn|window:7d|align:true",
    "s_space",
    "m_sumTokenHitRate|window:7d|align:true",
    "s_space",
    "m_sumApiCalls|window:7d|align:true",
    "s_space",
    "m_statTtlStatus",
  ],
  git_info_all: [
    "m_label|⎇ Git: |color:yellow",
    "m_repo",
    "s_space",
    "m_branch",
    "s_space",
    "m_gitStatus",
    "s_space",
    "m_linesAdded",
    "s_space",
    "m_linesRemoved",
  ],
  context_all: [
    "m_label|Context: |color:yellow",
    "m_windowContext|display:used",
    "s_space",
    "m_contextSize",
    "s_space",
    "m_contextWindowsSize",
    "s_space",
    "m_contextUsedPercent",
    "s_space",
    "m_contextRemainingPercent",
  ],
  quote: [
    "m_quote|freq:120s|color:rainbow|lang:en|wrap:~",
  ],
};

// vX.X.X+ — top-level `statuslineTemplate` preset registry. Distinct
// from DEFAULT_LINE_TEMPLATES (which holds fragments consumed via
// `m_template|<key>`). A preset here IS the whole statusline — the
// loader resolves a string-form `statuslineTemplate: "<key>"`
// against this registry and substitutes the body array. Fragment
// names (`tokens_tick` / `information` / etc.) are NOT valid here
// and vice versa.
//
// Bodies reuse fragments where helpful — `m_template|<fragment>`
// indirection inside a preset body is fine; the strip-on-load rule
// that blocks nesting of `m_template:<key>` *inside lineTemplates
// entries* still applies (a fragment cannot itself reference
// another fragment). At the preset level there is no such
// restriction — a preset can compose as many fragments as it
// wants.
export const DEFAULT_STATUSLINE_PRESETS: Record<string, StatuslineTemplate> = {
  // minimal: provider-type-aware quota/balance dispatch +
  // m_age (chain emoji) + m_pluginSource.
  simple: [
    "m_pluginSource",
    "m_template|quota|type:quota",
    "m_template|balance|type:balance"
  ],
  // multi-line: context-info / tick-eval / stat-eval stacked.
  compact: [
    "m_template|tick_eval",
    "s_newline",
    "m_template|acc_eval",
    "s_newline",
    "m_template|stat_eval",
    "s_newline",
    "m_pluginSource",
    "m_template|quota|type:quota",
    "m_template|balance|type:balance",
    "s_space",
    "m_template|mem_info",
  ],
  standard: [
    "m_template|information",
    "s_space",
    "m_template|mem_info",
    "s_newline",
    "m_template|tick_eval",
    "s_newline",
    "m_template|acc_eval",
    "s_newline",
    "m_template|stat_eval",
    "s_newline",
    "m_pluginSource",
    "m_template|quota|type:quota",
    "m_template|balance|type:balance",
    "s_space",
    "m_template|git_info",
  ],
  // kitchen-sink: every fragment + per-scope acc + per-window
  // stat + long-interval quota + chain emoji + version.
  abundant: [
    "m_template|information",
    "s_space",
    "m_template|mem_info",
    "s_newline",
    "m_template|git_info_all",
    "s_pipe|wrap:true",
    "m_template|quote",
    "s_newline",
    "m_label|⚡Tick-tock: |color:cyan",
    "s_tab",
    "m_template|tokens_tick",
    "s_newline",
    "m_label|🟢Session: |color:orange",
    "s_tab",
    "m_template|tokens_acc|scope:session",
    "s_newline",
    "m_label|🟢Model: |color:orange",
    "s_tab",
    "m_template|tokens_acc|scope:model",
    "s_newline",
    "m_label|🟢Project: |color:orange",
    "s_tab",
    "m_template|tokens_acc|scope:project",
    "s_newline",
    "m_label|⌛2h:|color:yellow",
    "s_tab",
    "s_tab",
    "m_template|tokens_stat|window:2h",
    "s_newline",
    "m_label|⌛5h-align:|color:yellow",
    "s_tab",
    "m_template|tokens_stat|window:5h|align:true",
    "s_newline",
    "m_label|⌛7d-align:|color:yellow",
    "s_tab",
    "m_template|tokens_stat|window:7d|align:true",
    "s_space",
    "m_statTtlStatus",
    "s_newline",
    "m_pluginSource",
    "m_template|quota_all|type:quota",
    "m_template|balance|type:balance",
    "s_space",
    "m_quota|term:long|display:remaining|nulldrop:true"
  ],
};

