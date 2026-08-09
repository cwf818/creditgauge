// Template defaults and template-only types. This module has no config-store
// or provider dependencies so it can be reused by the config facade.

// ----- Defaults — must match the config.ts hardcoded values exactly -----

// Separator tokens are the six named aliases — `s_space` / `s_dot` /
// `s_newline` / `s_tab` / `s_colon` / `s_pipe` — each rendered as its
// built-in literal character. Any other literal in a template can be
// dropped in as a free-form token (the renderer emits unknown tokens
// verbatim), or wrapped via `m_label|<your-text>`.

// Default line layout. A template is an ordered list of tokens; each
// token is either a display module ("m_<name>"), a named separator
// ("s_space" / "s_dot" / …), or a free-form literal. The renderer
// walks the list left-to-right and concatenates the output of each
// module. See render.ts:renderTemplate for the full grammar.
//
// Default layouts:
//   quota:   "Usage: <5h> <countdown5h> · <7d> <countdown7d>"
//   balance: "Balance: <balance>"
// The " · " between windows is a single self-padding `s_dot|wrap:true`;
// the spacing between adjacent m_* modules comes from auto-space
// (prefixSpace=true auto-prepends one space before each module).
//
// Source of truth for the `quota` / `balance` entries in
// DEFAULT_LINE_TEMPLATES. Tests reference this constant via __testing,
// so keep it in sync with the fragments.
const DEFAULT_LINE_TEMPLATE: {
  quota: string[];
  balance: string[];
} = {
  // The " · " between windows is a single self-padding `s_dot|wrap:true`;
  // auto-space (prefixSpace=true) supplies the inter-module spacing.
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

// Registry of reusable template fragments. Each value is a token array
// (the same shape as `statuslineTemplate`). Allowed tokens: `m_*`
// modules EXCEPT `m_template`, plus `s_*` separators. The loader strips
// `m_template` tokens at load time, so a fragment can never reference
// another fragment (no nesting).
//
// The renderer reads from this registry when it encounters an
// `m_template|<key>` token inside `statuslineTemplate` or a preset.
// Keys are user-overridable via `lineTemplates.<key>` in config.json;
// a `_`-prefixed user key is only rejected if it collides with a
// built-in key — a no-op safety net today, since no built-in fragment
// uses the `_` prefix.
export type LineTemplates = Record<string, string[]>;

// A statusline is a flat token array. The loader accepts
// `statuslineTemplate` as either an array (raw token list) or a preset
// name string resolved against DEFAULT_STATUSLINE_PRESETS.
export type StatuslineTemplate = string[];

// Fallback template used when there is no config.json or a preset name
// fails to resolve. Dispatches quota / balance by provider TYPE.
export const DEFAULT_STATUSLINE_TEMPLATE: StatuslineTemplate = ["m_template|quota|type:quota", "m_template|balance|type:balance"];

// Fragment library. `DEFAULT_LINE_TEMPLATES.<key>` is consumed via
// `m_template|<key>` indirection — fragments can be inlined anywhere in
// a template. This registry is DISTINCT from DEFAULT_STATUSLINE_PRESETS
// below: a preset is the WHOLE statusline (resolved by the top-level
// `statuslineTemplate: "<key>"`), a fragment is a reusable chunk. A
// fragment name is not a valid preset name and vice versa.
export const DEFAULT_LINE_TEMPLATES: LineTemplates = {
  // Standard quota / balance window renders, referenced by the presets
  // via `m_template|quota|type:quota` / `m_template|balance|type:balance`.
  // Bodies match DEFAULT_LINE_TEMPLATE.
  quota: DEFAULT_LINE_TEMPLATE.quota,
  balance: DEFAULT_LINE_TEMPLATE.balance,

  // "model_info" — provider + model on one line.
  model_info: [
    "m_label|💳: |color:blue",
    "m_provider",
    "/",
    "m_model"
  ],
  // "context_info" — context-window bar + used/limit usage.
  context_info: [
    "m_label|📜: |color:yellow",
    "m_windowContext|display:used",
    "m_contextUsage|valueOnly:true"
  ],
  // "plugin_info" — creditgauge name + version (used on the unknown
  // provider path, e.g. `|type:unknown`).
  plugin_info: [
    "m_label|CreditGauge |color:yellow",
    "m_version|color:yellow",
  ],
  // "mem_info" — system RAM bar + absolute used/total.
  mem_info: [
    "m_label|▦ : |color:yellow",
    "m_windowMemUsage|display:used",
    "m_memUsage|valueOnly:true",
  ],
  // "git_info" — git branch with clean/dirty status + line deltas.
  git_info: [
    "m_label|⎇ Git: |color:yellow",
    "m_branch|withStatus:true",
    "m_linesAdded",
    "m_linesRemoved",
  ],
  // "tickline" — per-turn tick diagnostics (stdin-only modules).
  "tickline": [
    "m_tokenOutSpeed",
    "m_tokenIn",
    "m_tokenOut",
    "m_tokenCachedIn",
    "m_tokenTotalIn",
    "m_apiMs",
  ],
  // "scopeline" — session/project-scoped accumulator totals.
  "scopeline": [
    "m_accTokenOutSpeed",
    "m_accTokenOut",
    "m_accTokenTotalIn",
    "m_accTokenHitRate",
    "m_accApiCalls"
  ],
  // "periodline" — period-scoped aggregates; the scan window is passed
  // by the caller via `|window:<dhms>` passthrough (e.g. `|window:5h`).
  "periodline": [
    "m_sumTokenOutSpeed|align:true",
    "m_sumTokenOut|align:true",
    "m_sumTokenTotalIn|align:true",
    "m_sumTokenHitRate|align:true",
    "m_sumApiCalls|align:true",
    "m_sumTokenCost|align:true|valueOnly:true"
  ],
  // "quote" — a rotating quote line.
  quote: [
    "m_quote|freq:120s|color:rainbow|lang:en|wrap:~",
  ],
};

// Top-level `statuslineTemplate` preset registry. Distinct from
// DEFAULT_LINE_TEMPLATES (fragments consumed via `m_template|<key>`):
// a preset here IS the whole statusline — the loader resolves a
// string-form `statuslineTemplate: "<key>"` against this registry and
// substitutes the body array. Fragment names are NOT valid here and
// vice versa.
//
// Preset bodies reuse fragments freely via `m_template|<fragment>` —
// the strip-on-load rule that blocks nesting *inside* a lineTemplates
// entry does not apply at the preset level.
export const DEFAULT_STATUSLINE_PRESETS: Record<string, StatuslineTemplate> = {
  // Provider-type dispatch: quota line for Quota providers, balance
  // line for BALANCE providers, plugin info for unknown providers.
  simple: [
    "m_template|quota|type:quota",
    "m_template|balance|type:balance",
    "m_template|plugin_info|type:unknown",
  ],

  // Multi-line layout: header (provider/model + context + memory),
  // per-turn ticks + git, session / project scopes with 5h/7d window
  // rows, then the quota/balance + quote tail.
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

  // Full layout: header (provider/model + context + memory + version),
  // per-turn ticks + git + per-session api/cost, then the session /
  // project scope rows each aligned to a plan window (5h / 7d), and the
  // quota/balance + pluginSource + quote tail.
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
