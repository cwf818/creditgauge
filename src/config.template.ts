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
// The " · " between windows is a single `s_dot|wrap:true` (the legacy
// `s_space / s_dot / s_space` triple was collapsed to it when the
// redundant `s_space` tokens were dropped — auto-space under
// prefixSpace=true now provides the inter-module spacing).
//
// vX.X.X+ — the per-module `s_space` separators are GONE from the
// built-in arrays. The auto-space feature (prefixSpace, default true)
// reproduces exactly one space between adjacent m_* modules per
// R1/R2/R3, so the explicit tokens were redundant. s_space survives
// ONLY where auto-space cannot reproduce it: immediately adjacent to
// an `m_template|<key>` token (RULE B — m_template is excluded from
// the affix path), and inside the old " · " idiom's replacement
// (`s_dot|wrap:true`, which pads itself).
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
  // vX.X.X+ — the explicit `s_space` tokens are dropped (auto-space,
  // prefixSpace=true, reproduces the inter-module spacing) and the
  // legacy `s_space + s_dot + s_space` " · " composition is collapsed
  // to a single self-padding `s_dot|wrap:true`. The visual output is
  // byte-for-byte identical to the v0.4.x release.
  quota: [
    "m_modeLabel|color:yellow",
    "m_windowQuota|term:short",
    "m_countdown|term:short|valueOnly:true",
    "s_dot|wrap:true",
    "m_windowQuota|term:mid",
    "m_countdown|term:mid|valueOnly:true",
    "s_dot|wrap:true",
    "m_windowQuota|term:long",
    "m_countdown|term:long|valueOnly:true",
    "m_quota|term:long|display:remaining|nulldrop:true"
  ],
  balance: ["m_modeLabel|color:yellow", "m_balance", "m_age"],
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
// tokens_acc / tokens_stat / model_info / tickline / combline2 /
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
  // `:balance`. Bodies match DEFAULT_LINE_TEMPLATE (the " · " between
  // windows is a self-padding `s_dot|wrap:true`).
  quota: DEFAULT_LINE_TEMPLATE.quota,
  balance: DEFAULT_LINE_TEMPLATE.balance,

  // "model_info" — context window + memory + git pipeline on one
  // line; the inline `|wrap:true` on `s_pipe` wraps the trailing
  // body so the rendered segment pads out (cf. s_*|wrap| memo).
  model_info: [
    "m_label|💳: |color:blue",
    "m_provider",
    "/",
    "m_model"
  ],
  context_info: [
    "m_label|📜: |color:yellow",
    "m_windowContext|display:used",
    "m_contextUsage|valueOnly:true"
  ],
  plugin_info: [
    "m_label|CreditGauge |color:yellow",
    "m_version|color:yellow",
  ],
  mem_info: [
    "m_label|▦ : |color:yellow",
    "m_windowMemUsage|display:used",
    "m_memUsage|valueOnly:true",
  ],
  git_info: [
    "m_label|⎇ Git: |color:yellow",
    "m_branch|withStatus:true",
    "m_linesAdded",
    "m_linesRemoved",
  ],
  // "tickline" — per-turn tick diagnostics paired with the
  // session-scoped accumulator (scope:session filters to the
  // current Claude Code process slot; resets on totalApiMs
  // regression per v0.8.x contract).
  "tickline": [
    "m_tokenOutSpeed",
    "m_tokenIn",
    "m_tokenOut",
    "m_tokenCachedIn",
    "m_tokenTotalIn",
    "m_apiMs",
  ],
  "scopeline": [
    "m_accTokenOutSpeed",
    "m_accTokenOut",
    "m_accTokenTotalIn",
    "m_accTokenHitRate",
    "m_accApiCalls"
  ],
  "periodline": [
    "m_sumTokenOutSpeed|align:true",
    "m_sumTokenOut|align:true",
    "m_sumTokenTotalIn|align:true",
    "m_sumTokenHitRate|align:true",
    "m_sumApiCalls|align:true",
    "m_sumTokenCost|align:true|valueOnly:true"
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
// names (`tokens_tick` / `model_info` / etc.) are NOT valid here
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
    "m_template|quota|type:quota",
    "m_template|balance|type:balance",
    "m_template|plugin_info|type:unknown",
  ],

  // multi-line: context-info / tick-eval / stat-eval stacked.
  compact: [
    "m_template|model_info",
    "s_pipe|wrap:true",
    "m_template|context_info",
    "s_pipe|wrap:true",
    "m_label|▦: |color:yellow",
    "m_memUsage|valueOnly:true",
    "s_newline",

    "m_label|⚡: |color:orange",
    "m_template|tickline",
    "s_dot|wrap:true",
    "m_template|git_info",
    "s_newline",

    "m_label|🗪 : |color:orange",
    "m_template|scopeline|scope:session",
    "s_pipe|wrap:true",
    "m_label|⏱️: |color:yellow",
    "m_accApiMs|scope:session|valueOnly:true",
    "m_label|🪙: |color:yellow",
    "m_accTokenCost|scope:session|valueOnly:true",
    "s_newline",

    "m_label|📦: |color:orange",
    "m_template|scopeline|scope:project",
    "s_pipe|wrap:true",
    "m_label|⌛5h: |color:yellow",
    "m_sumTokenTotalIn|align:true|window:5h",
    "m_sumApiCalls|align:true|window:5h",
    "s_pipe|wrap:true",
    "m_label|⌛7d: |color:yellow",
    "m_sumTokenTotalIn|align:true|window:7d",
    "m_sumApiCalls|align:true|window:7d",
    "s_newline",

    "m_template|quota|type:quota",
    "m_template|balance|type:balance",
    "s_newline",
    "m_template|quote"
  ],

  standard: [
    "m_template|model_info",
    "s_pipe|wrap:true",
    "m_template|context_info",
    "s_pipe|wrap:true",
    "m_template|mem_info",
    "s_pipe|wrap:true",
    "m_version|color:orange",
    "s_newline",

    "m_label|⚡: |color:orange",
    "m_template|tickline",
    "s_dot|wrap:true",
    "m_template|git_info",
    "s_dot|wrap:true",
    "m_label|⏱️: |color:yellow",
    "m_accApiMs|scope:session|valueOnly:true",
    "m_label|🪙: |color:yellow",
    "m_accTokenCost|scope:session|valueOnly:true",
    "s_newline",

    "m_label|🗪 : |color:orange",
    "m_template|scopeline|scope:session",
    "s_move|pos:45",
    "s_pipe",
    "m_label|⌛5h: |color:yellow",
    "m_template|periodline|window:5h",
    "s_newline",

    "m_label|📦: |color:orange",
    "m_template|scopeline|scope:project",
    "s_move|pos:45",
    "s_pipe",
    "m_label|⌛7d: |color:yellow",
    "m_template|periodline|window:7d",
    "s_newline",

    "m_template|quota|type:quota",
    "m_template|balance|type:balance",
    "s_newline",
    "m_pluginSource",
    "s_space",
    "m_template|quote"
  ],
};

