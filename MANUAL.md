# ToPGauge — Configuration Manual

The complete configuration reference. Every top-level field, every provider entry, every preset, every shipped fragment, every inline-arg axis, every module.

User-facing quickstart + ops procedures (install, uninstall, clean, commands, dev loop) live at [README.md](./README.md). The plugin ABI for writing custom providers lives at [HOW_TO_CREATE_A_PLUGIN.md](./HOW_TO_CREATE_A_PLUGIN.md). Per-version history lives at [CHANGELOG.md](./CHANGELOG.md).

## Table of contents

1. [Configuration file](#1-configuration-file)
2. [Top-level schema](#2-top-level-schema)
3. [Providers](#3-providers)
4. [Plugin output contract](#4-plugin-output-contract)
5. [statuslineTemplate](#5-statuslinetemplate)
6. [Built-in presets](#6-built-in-presets)
7. [Shipped fragments](#7-shipped-fragments)
8. [Module reference](#8-module-reference)
9. [Inline-args grammar](#9-inline-args-grammar)
10. [Inline-arg axes](#10-inline-arg-axes)
11. [Separators](#11-separators)
12. [Color values](#12-color-values)
13. [Drop semantics and `nulldrop`](#13-drop-semantics-and-nulldrop)
14. [Per-module type filters](#14-per-module-type-filters)
15. [`m_pluginSource`](#15-m_pluginsource)
16. [`m_quote`](#16-m_quote)
17. [Token usage family](#17-token-usage-family)
18. [Composition with the upstream statusline](#18-composition-with-the-upstream-statusline)
19. [Recipes](#19-recipes)

---

## 1. Configuration file

Path:
- **Unix**: `~/.claude/plugins/topgauge/config.json`
- **Windows**: `%USERPROFILE%\.claude\plugins\topgauge\config.json`

Missing file → all defaults (bit-for-byte identical to no config). Malformed JSON or a single bad field → one stderr line (`topgauge: config <reason>; using defaults`) and the default for that field only. The plugin never blanks the statusline on bad config.

A reference copy with every field is at [config.example.json](./config.example.json). Copy it to the path above and edit.

---

## 2. Top-level schema

Every key honored by the loader, with its type, default, and validator. Source-of-truth: `src/config.ts:DEFAULT_CONFIG` + `applyOverrides`.

```jsonc
{
  // > 0; success-cache TTL in ms
  "cacheTtlMs": 60000,

  // > 0; per-request HTTP timeout
  "fetchTimeoutMs": 5000,

  // "used" | "remaining" — global display mode for window modules
  "display": "used",

  // Line prefix per provider TYPE
  "modeLabels": {
    "used": "Usage:",
    "remaining": "Remain:",
    "balance": "Balance:"
  },

  // 256-color ANSI palette. Each value is either a symbolic shortcut
  // (brightGreen / darkGreen / yellow / orange / red / brightBlack)
  // or a literal ANSI SGR string matching `^\x1b\[[0-9;]*m$`.
  // Strings containing newlines are rejected.
  "colors": {
    "brightGreen": "brightGreen",
    "darkGreen":   "darkGreen",
    "yellow":      "yellow",
    "orange":      "orange",
    "red":         "red",
    "stale":       "brightBlack",  // dim-gray for the "⛓️‍💥 X ago" suffix
    "broken":      "red"           // hard-fail fallback
  },

  // Band cutoffs (4 ascending numbers each).
  // percentBands drives m_windowQuota / m_windowContext / m_windowMemUsage;
  // balanceBands drives m_balance.
  "thresholds": {
    "percentBands": [60, 70, 80, 90],
    "balanceBands": [5, 10, 20, 50]
  },

  // Stale-on-error annotation. Appended directly after the template
  // output; place a custom separator explicitly in the lineTemplate
  // (e.g. add an `s_space` token after `m_windowQuota|term:short`).
  "stale": {
    "ageEmoji": { "healthy": "🔗", "broken": "⛓️‍💥" }
  },

  // Per-module label prefix overrides.
  "labels": {
    "labelTokenIn":                 "in:",
    "labelTokenOut":                "out:",
    "labelTokenTotalIn":            "in:",
    "labelTokenTotalOut":           "out:",        // shared with m_tokenTotalOut
    "labelTokenCachedIn":           "cache:",
    "labelTokenHitRate":            "hit:",
    "labelApi":                     "api:",
    "labelApiCalls":                "calls:",
    "labelInSpeed":                 "in:",
    "labelOutSpeed":                "out:",
    "labelContextSize":             "size:",
    "labelContextWindowsSize":      "size:",
    "labelContextUsedPercent":      "used:",
    "labelContextRemainingPercent": "remain:",
    "labelMemUsage":                "Mem:",
    "labelStartTime":               "start:",
    "labelEndTime":                 "end:",
    "labelPluginSystem":            "📌",
    "labelPluginUserDefined":       "🎨",
    "labelPluginMissing":           "❗",
    "labelPluginCC":                "🔖"
  },

  // 3-band palette for the m_tokenHitRate module. Bands chosen by
  // cacheHitThresholds (in tokenFormat below).
  "cacheHitColors": {
    "good": "brightGreen", // ≥ 80%
    "warn": "yellow",      // ≥ 50%
    "bad":  "orange"       // < 50%
  },

  // Bar geometry.
  "bar": {
    "width":  8,    // 3..64
    "filled": "▓",
    "empty":  "░"
  },

  // Top-level knobs governing ALL time rendering.
  "timeFormat": {
    // Smallest unit shown on time countdowns.
    //   "m":           sub-minute shows as "<1m"
    //   "s" (default): sub-minute shows as actual seconds (e.g. "47s")
    "minUnit": "s",
    // How many non-zero units to show. Clamped to [1, 4].
    //   1d2h3m4s → "1d2h"
    //   2h0m     → "2h0m"   (NOT "2h" — internal zeros preserved)
    //   0d0h5m   → "5m"     (leading zeros dropped)
    "maxUnitCount": 2
  },

  // Reset-countdown glyphs. Indexed by remainingMs/resetDurationMs
  // (left-to-right = "few remaining → many remaining"). Index 0 shown
  // when remaining ≈ 0 (about to reset); last entry shown when remaining ≈
  // total (fresh). Providers without start_time (DeepSeek) fall back
  // to index 0.
  "countdown": {
    "resetArrows": ["🕛","🕚","🕙","🕘","🕗","🕖","🕕","🕔","🕓","🕒","🕑","🕐"]
  },

  // Compact number formatting for the m_token* modules.
  //   < thresholds[0] → raw integer ("342")
  //   < thresholds[1] → "<x.y>k"   ("12.3k")
  //   ≥ thresholds[1] → "<x.y>M"   ("1.2M")
  "tokenFormat": {
    "thresholds":         [1000, 1000000],
    "precision":          1,
    "speedPrecision":     1,
    "cachePctPrecision":  1,
    "cacheHitThresholds": [50, 80],
    // 5-band tps color scale (ascending tps = ascending danger).
    "speedScaleBands":    {
      "in":  [10, 50, 200, 1000],
      "out": [10, 50, 200, 1000]
    }
  },

  // Registry of reusable template fragments. Each value is a token array.
  // Allowed tokens: any m_* module EXCEPT m_template, plus s_* separators.
  // Keys are user-chosen; the renderer reads from this registry when it
  // sees an `m_template|<key>` token inside `statuslineTemplate`.
  // Keys that collide with a shipped fragment are warned + skipped.
  "lineTemplates": {
    "myHeader": ["m_modeLabel", "s_space", "m_windowQuota|term:short"]
  },

  // Top-level template. Either a string (preset name from §6) or a
  // string[] (raw token list). Default:
  //   ["m_template|quota|type:quota", "m_template|balance|type:balance"]
  "statuslineTemplate": ["m_template|quota|type:quota", "m_template|balance|type:balance"],

  // Per-model cost computation for m_tokenCost / m_accTokenCost / m_sumTokenCost.
  // Missing model → renders as "cost:n/a". Zero rates are valid.
  "tokenPrices": {
    "MiniMax-M3": { "in": 0, "out": 0, "cachedIn": 0, "currency": "USD" }
  },

  // Pass --insecure / -k to curl for m_quote address-mode fetches.
  "quoteInsecureTls": false,

  // Provider registry. See §3.
  "providers": {
    "minimax":  { "TYPE": "QUOTA",   "BASE_URL_COMPARED_TO": "https://api.minimaxi.com/anthropic", "COMPARE_METHOD": "EXACT" },
    "deepseek": { "TYPE": "BALANCE", "BASE_URL_COMPARED_TO": "https://api.deepseek.com/anthropic", "COMPARE_METHOD": "EXACT" }
  }
}
```

### Field validators (cross-cutting)

- `colors.*` — symbolic shortcut OR literal ANSI SGR matching `^\x1b\[[0-9;]*m$`. Newlines rejected.
- `thresholds.*` — exactly 4 finite ascending numbers.
- `bar.width` — integer in `[3, 64]`.
- Numeric fields — finite, positive where relevant.
- `lineTemplates.<key>` — non-empty array of strings. Loader strips nested `m_template*` tokens (no recursive indirection).

---

## 3. Providers

The `providers` block is a `Record<string, ProviderEntry>`. Each entry declares how `ANTHROPIC_BASE_URL` is matched and which plugin handles the request.

| Field                  | Required | Notes |
|------------------------|----------|-------|
| `TYPE`                 | yes      | `"QUOTA"` (5h + 7d two-window line) or `"BALANCE"` (account-balance line). Selects the plugin output shape and the renderer fail-line label. |
| `BASE_URL_COMPARED_TO` | yes      | URL pattern to match `ANTHROPIC_BASE_URL` against. Non-empty string. |
| `COMPARE_METHOD`       | no       | `"EXACT"` (default) · `"INCLUDE"` (substring) · `"STARTWITH"` (prefix with suffix-attack guard). |
| `AUTHENTICATION_KEY`   | no       | Alternative credential that overrides `process.env.ANTHROPIC_AUTH_TOKEN` for this provider. Keeps plugin source credential-free. Plugin receives it as the first arg to `fetchAccountCredit` and forwards on the upstream `Authorization` header. When unset, the env token takes over. Bad values (non-string, empty string) drop just the field; the entry still loads and the fetcher falls back to the env token. |
| `config`               | no       | Per-provider override of any top-level config key EXCEPT `providers` (no recursion). Nested `providers` keys are forbidden. |

### `COMPARE_METHOD` modes

| Mode       | Match logic                                            | Suffix-attack guard |
|------------|--------------------------------------------------------|---------------------|
| `EXACT`    | `baseUrl === pattern`                                  | n/a — exact match.  |
| `INCLUDE`  | `baseUrl.includes(pattern)`                            | n/a — substring.    |
| `STARTWITH`| `baseUrl.startsWith(pattern)`                          | Character right after the prefix must be `undefined`, `/`, `?`, or `#`. So `https://api.deepseek.com.evil.example` is rejected even though it `startsWith("https://api.deepseek.com")`. |

### Built-in defaults

| Id        | TYPE      | BASE_URL_COMPARED_TO                          | COMPARE_METHOD |
|-----------|-----------|-----------------------------------------------|----------------|
| `minimax` | `"QUOTA"` | `https://api.minimaxi.com/anthropic`          | `EXACT`        |
| `deepseek`| `"BALANCE"`| `https://api.deepseek.com/anthropic`         | `EXACT`        |

A user entry inherits missing fields from the built-in default for the same id. To add a new provider, append a new key:

```jsonc
{
  "providers": {
    "moonshot": {
      "TYPE": "BALANCE",
      "BASE_URL_COMPARED_TO": "https://api.moonshot.cn/anthropic",
      "COMPARE_METHOD": "EXACT"
    }
  }
}
```

The cache key for a provider's response is its name (two Quota providers get separate cache slots). The matcher's iteration order is insertion order of the `providers` object — the first matching entry wins.

---

## 4. Plugin output contract

Every plugin returns a canonical `Quota` or `Balance` object directly. The host doesn't ship a path-expression resolver — every plugin owns its own parsing.

```ts
type Interval = {
  windowId:    string | null;       // default = key (short → "5h", mid → "7d", long → "30d")
  label:       string | null;       // free-form; overrides m_windowQuota's "(5h)" suffix
  startAt:     number | string | null; // epoch ms (recommended) OR ISO-8601 string
  endAt:       number | string | null;
  intervalMs:  number | null;
  remainingPercent: number | null;  // 0..100
  usedPercent:      number | null;  // 0..100; required for the bar to fill
  remainingQuota:   number | null;
  usedQuota:        number | null;
  limitQuota:       number | null;
};

type Quota = {
  intervals: Record<string, Interval | null>; // open dict; 3 reserved keys "short"/"mid"/"long"
};

type BalanceEntry = {
  currency:     string,        // ISO 4217 ("USD", "CNY") or free-form
  totalBalance: number,
  // Display prefix is derived from `currency` via the renderer's
  // `currencyLabel(code)` helper (CNY/RMB → ￥, USD → $, others → bare
  // uppercase code). Plugins no longer carry a label per entry.
};

type Balance = {
  isAvailable: boolean,
  entries:     BalanceEntry[],
  minValue:    number | null,  // high-water mark for color banding
};
```

### Host normalizers

The host runs `ensureQuota` / `ensureBalance` on whatever the plugin returns. A plugin can ship `Partial<Quota>` / `Partial<Balance>` and let the host fill canonical defaults.

**`ensureInterval` rules** (`src/plugins/parsers.ts`):
- `startAt` + `endAt` + `intervalMs` — at least 2 of 3 must be non-null; the third is derived.
- `startAt` / `endAt` accept epoch ms (number) OR ISO-8601 string. ISO strings are `Date.parse`d.
- `intervalMs` accepts number only (it's a duration, not an instant).
- Only 1 of the 3 present → entire time group collapses to nulls (render falls back to placeholder).
- `remainingPercent` ↔ `usedPercent`: one derives the other as `100 − x`. When both present, `usedPercent` wins.
- Default `windowId` / `label` per slot: `short → "5h"`, `mid → "7d"`, `long → "30d"`. For non-reserved keys (e.g. `monthly` / `yearly`), the key itself is the default windowId.

**`ensureBalance` rules**:
- `entries` missing or empty + `isAvailable = false` → placeholder "not available!".
- `entries` missing or empty + `isAvailable = true` (or missing) → "n/a".
- `minValue` host-computed as `min(entries[].totalBalance)`.

### Plugin ABI

```ts
// src/plugins/data.ts:47-52
export type AccountCreditPlugin = {
  fetchAccountCredit: (
    authenticationKey: string,    // entry.AUTHENTICATION_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? ""
    context?: PluginContext,
  ) => unknown | Promise<unknown>; // host normalises via ensureQuota / ensureBalance
};

export type PluginContext = {
  providerId: string,                              // e.g. "kimi"
  type:        "QUOTA" | "BALANCE",                // mirrors the entry's TYPE
  signal?:     AbortSignal,                        // per-tick timeout — MUST forward on fetch
};
```

### Override resolution order

For a provider id `<id>`:

1. `~/.claude/plugins/topgauge/query_plugins/<id>/index.js` (then `.mjs`) — user override (silently wins).
2. `dist|src/plugins/<id>/index.js` — built-in (only for canonical built-in ids `minimax`, `deepseek`).
3. Otherwise: miss. The host writes `<provider>:pluginSource = "missing"` to the cache row and `m_pluginSource` renders ❗.

Id safety regex: `^[A-Za-z0-9_-]+$`. Timeout: 5s (`PLUGIN_TIMEOUT_MS` in `src/api.ts`). On any load / timeout / contract error, the host writes a `warning` row to `diagnostics.jsonl` and surfaces the side (`user plugin <path>: <err>` vs `built-in plugin <path>: <err>`).

Full ABI walkthrough (authoring recipes, fillQuota patterns, standalone testing): [HOW_TO_CREATE_A_PLUGIN.md](./HOW_TO_CREATE_A_PLUGIN.md).

---

## 5. statuslineTemplate

Two accepted forms for the top-level `statuslineTemplate`:

| Form         | Shape                       | Resolution                                                                                |
|--------------|-----------------------------|--------------------------------------------------------------------------------------------|
| **Array**    | `string[]` (raw token list) | Each token is `m_*`, `s_*`, or a literal. Tokens that don't match either emit verbatim.   |
| **String**   | a preset name               | Looked up in `DEFAULT_STATUSLINE_PRESETS`. Valid names: `simple`, `compact`, `standard`, `abundant`. Unknown preset → warn + fall back to the array-form default. |

Default: `["m_template|quota|type:quota", "m_template|balance|type:balance"]` — provider-type dispatch.

### `m_template` dispatch

```ts
m_template|<key>                            // looks up lineTemplates.<key>; missing → warn + drop
m_template|<key>|type:quota|balance         // gates to a specific provider TYPE; absent = provider-agnostic
m_template|<key>|provider:<id>              // gates to a specific provider instance (e.g. "minimax")
```

Every other inline arg (`scope`, `model`, `window`, `align`, `color`, `nulldrop`, `valueOnly`) is **forwarded** to the inner modules as passthrough. Inner-explicit-wins: if the inner token uses the same arg explicitly, the inner value beats the passthrough.

Nesting protection: `lineTemplates` entries cannot themselves contain `m_template*` tokens (stripped at load time).

---

## 6. Built-in presets

Four presets ship in `DEFAULT_STATUSLINE_PRESETS` (`src/config.template.ts:419-516`). Set `"statuslineTemplate": "<name>"` in `config.json` to use one. To customize, copy the body into `lineTemplates.<your_key>` and reference it via `m_template|<your_key>`.

| Key         | Lines | Use it when                                                                                       |
|-------------|-------|---------------------------------------------------------------------------------------------------|
| `simple`    | 1     | One-line minimal: provider-type dispatch + `m_age`. Default for users chaining another statusline. |
| `compact`   | 4     | Multi-line eval stack (`tick_eval` / `acc_eval` / `stat_eval`) + a single-line dispatch footer + mem-info + version. Mid-density. |
| `standard`  | 5     | Adds an `information` + `git_info` header row above the `compact` eval stack.                      |
| `abundant`  | 9     | Per-scope `tokens_acc` (session/model/project) + per-window `tokens_stat` (5h-align / 7d-align) + `m_quote`. Kitchen-sink; verbose. |

Source bodies: `src/config.template.ts:DEFAULT_STATUSLINE_PRESETS`.

---

## 7. Shipped fragments

13 fragments ship in `DEFAULT_LINE_TEMPLATES` (`src/config.template.ts:157-402`). Each is a token array consumed via `m_template|<key>` from `statuslineTemplate` or from a preset body.

| Key            | Summary                                                                                                                  |
|----------------|--------------------------------------------------------------------------------------------------------------------------|
| `quota`        | `m_modeLabel` + 5h window + 7d window. Provider-type-aware quota render via `m_windowQuota`. Matches `type:quota`.       |
| `quota_all`    | as `quota` plus a third `term:long` group.                                                                               |
| `balance`      | `m_modeLabel` + `m_balance`. Matches `type:balance`.                                                                     |
| `tokens_tick`  | Per-turn tick diagnostics: speed (in/out), hit rate, `m_apiMs`, in/out/cached/total tokens, `m_tokenCost`.              |
| `tokens_acc`   | Session-scoped accumulator: speed (in/out), hit rate, `m_accApiMs`, in/out/cached/total tokens, `m_accApiCalls`, `m_accTokenCost`, `m_accStartTime`. Inline arg `:scope:<session\|project\|model>`. |
| `tokens_stat`  | Cross-project sum/avg scan: speed (in/out), hit rate, `m_sumApiMs`, in/out/cached/total tokens, `m_sumApiCalls`, `m_sumTokenCost`, `m_sumStartTime`, `m_sumEndTime`. Inline args `:window:<dhms\|all>`, `:model:<active\|name\|all>`, `:align:<true\|false>`. |
| `information`  | `[m_model] Context: <bar> <used>/<cap> \| Memory: <bar> <used>/<total>`.                                                |
| `mem_info`     | `Memory: <bar> <used>/<total>`.                                                                                          |
| `git_info`     | `Git: <branch> <status> <linesAdded> <linesRemoved>`.                                                                    |
| `git_info_all` | `Git: <repo> <branch> <status> <linesAdded> <linesRemoved>`.                                                             |
| `context_all`  | `Context: <bar> <used> <cap> <usedPct> <remainingPct>`.                                                                  |
| `tick_eval`    | Per-turn tick diagnostics with `⚡Tick-tock:` label prefix (cyan) + rotating quote.                                       |
| `acc_eval`     | Session + project scoped accumulators on one logical row separated by `s_pipe|wrap:true`.                                |
| `stat_eval`    | 5h-align + 7d-align cross-project scans with `⌛<window>:` label prefixes (yellow) + `m_statTtlStatus` at the tail.      |

---

## 8. Module reference

Every module the renderer recognizes. **Type filter** tells you which provider TYPE the module is gated to (`plan` / `balance` / `unknown`); modules with no entry apply to every TYPE.

### 8.1 Provider data (plan / balance)

| Module | Renders (shape example) | Source field | Type filter | Inline args |
| ------ | ----------------------- | ------------ | ----------- | ----------- |
| `m_modeLabel` | `Usage:` / `Remain:` / `Balance:`. | derived from `providerType` + global `display` | agnostic | `color`, `nulldrop` |
| `m_windowQuota\|term:short\|mid\|long` (default `term=short`) | Bar + colored % of the chosen interval, e.g. `▓░░░░░░░ 9%`. | canonical `Interval.{usedPercent,remainingPercent,startAt,endAt}` | plan | `color`, `display`, `term`, `nulldrop` |
| `m_countdown\|term:<key>` (default `term=short`) | `(4h47m🕔 5h)` reset countdown with fill-state arrow. `term` is the intervals dict key (`short` / `mid` / `long` or any plugin-declared key like `monthly`). | canonical `Interval.{startAt,endAt,intervalMs}` | plan | `color`, `term`, `nulldrop` |
| `m_quota\|term:<key>` (default `term=short`) | Quota display, e.g. `quota(5h):100/500`. `term` accepts any intervals dict key. | canonical `Interval.{usedQuota,limitQuota}` | plan | `color`, `term`, `nulldrop` |
| `m_balance` | `CNY 110.00 · USD 5.00`. | `balance.entries[]` | balance | `color`, `nulldrop` |
| `m_age` | `🔗 5m ago` (fresh) / `⛓️‍💥 5m ago` (stale). | `ageMs`, `stale` | agnostic | `color`, `nulldrop` |
| `m_version` | `v0.9.0` plugin version. | `version` from `.claude-plugin/plugin.json` | agnostic | `color`, `nulldrop` |
| `m_memUsage` | System RAM usage, `Mem:15.9G/63.7G`. | `os.totalmem()` / `os.freemem()` | agnostic | `color`, `nulldrop`, `valueOnly` |
| `m_windowMemUsage` | System RAM used bar + 5-band-colored percentage, e.g. `▓▓▓▓▓░░░ 62%`. | `os.totalmem()` / `os.freemem()` | agnostic | `color`, `display`, `nulldrop` |
| `m_windowContext` | Context-window used bar + 5-band-colored percentage, e.g. `▓▓▓▓▓░░░ 82%`. | `tokens.contextWindow.contextUsedPercent` | agnostic | `color`, `display`, `nulldrop` |
| `m_cacheTtlStatus` | TTL-gauge glyph + fixed-second remaining suffix, e.g. `▆ 23s`. Reads the ACTIVE provider's cache row (keyed by `currentProvider`), not the cross-provider freshest — each provider is requested on its own clock. Bypasses `timeFormat.minUnit` so the suffix is always seconds. | `cache.peekWithTtl(currentProvider)` | agnostic | `color`, `nulldrop` |
| `m_statTtlStatus` | TTL-gauge glyph + fixed-second remaining suffix, e.g. `▆ 23s`. Bypasses `timeFormat.minUnit` so the suffix is always seconds. | `statusStore.peekFreshestStatAgeMs()` | agnostic | `color`, `nulldrop` |
| `m_label\|<text>` | Literal `<text>`. | inline | agnostic | `color`, `nulldrop` |
| `m_template\|<key>[\|type:quota\|balance\|provider:<id>]` | Inserts `lineTemplates.<key>` in place. | inline key | filtered by `type` / `provider` | `type`, `provider`, plus passthrough (§10) |

### 8.2 Per-turn / Acc / Sum family

Three semantic variants per metric: **per-turn** (stdin-only, zero IO), **acc** (in-memory three-layer accumulator: session / project / model), **sum/avg** (cross-project JSONL scan, TTL=300s).

| Module | Inline args (per-turn) | Inline args (acc) | Inline args (sum) |
| ------ | ---------------------- | ----------------- | ----------------- |
| `m_tokenIn` / `m_accTokenIn` / `m_sumTokenIn` | `color`, `nulldrop` | `color`, `nulldrop`, `scope` | `color`, `nulldrop`, `model`, `window`, `align` |
| `m_tokenOut` / `m_accTokenOut` / `m_sumTokenOut` | `color`, `nulldrop` | `color`, `nulldrop`, `scope` | `color`, `nulldrop`, `model`, `window`, `align` |
| `m_tokenCachedIn` / `m_accTokenCachedIn` / `m_sumTokenCachedIn` | `color`, `nulldrop` | `color`, `nulldrop`, `scope` | `color`, `nulldrop`, `model`, `window`, `align` |
| `m_tokenInTotal` / `m_accTokenTotalIn` / `m_sumTokenTotalIn` | `color`, `nulldrop` | `color`, `nulldrop`, `scope` | `color`, `nulldrop`, `model`, `window`, `align` |
| `m_tokenTotalOut` | `color`, `nulldrop` | — | — |
| `m_apiMs` / `m_accApiMs` / `m_sumApiMs` | `color`, `nulldrop` | `color`, `nulldrop`, `scope` | `color`, `nulldrop`, `model`, `window`, `align` |
| `m_apiCalls` / `m_accApiCalls` / `m_sumApiCalls` | `color`, `nulldrop` | `color`, `nulldrop`, `scope` | `color`, `nulldrop`, `model`, `window`, `align` |
| `m_tokenHitRate` / `m_accTokenHitRate` / `m_sumTokenHitRate` | `color`, `nulldrop` | `color`, `nulldrop`, `scope` | `color`, `nulldrop`, `model`, `window`, `align` |
| `m_tokenInSpeed` / `m_accTokenInSpeed` / `m_sumTokenInSpeed` | `color`, `nulldrop` | `color`, `nulldrop`, `scope` | `color`, `nulldrop`, `model`, `window`, `align` |
| `m_tokenOutSpeed` / `m_accTokenOutSpeed` / `m_sumTokenOutSpeed` | `color`, `nulldrop` | `color`, `nulldrop`, `scope` | `color`, `nulldrop`, `model`, `window`, `align` |
| `m_tokenCost` / `m_accTokenCost` / `m_sumTokenCost` | `color`, `nulldrop` | `color`, `nulldrop`, `scope` | `color`, `nulldrop`, `model`, `window`, `align` |
| `m_accStartTime` | — | `color`, `nulldrop`, `scope`, `abs` | — |
| `m_sumStartTime` | — | — | `color`, `nulldrop`, `model`, `window`, `align`, `abs` |
| `m_sumEndTime` | — | — | `color`, `nulldrop`, `model`, `window`, `align`, `abs` |

**Per-turn value-zero rule**: value = 0 renders as `in:0` / `out:0` / `calls:0` (don't hide).

**Per-turn idle-stale-color rule** (`m_tokenIn` / `m_tokenOut` only): active tick → brightGreen (in) / red (out); idle tick → cached value under `STALE_COLOR` (gray). User `|color|<c>` overrides both branches.

**Per-turn hit-rate / speed / apiMs idle**: TTL gate disabled — idle tick surfaces cached value, `STALE_COLOR`ed, never expires.

### 8.3 Singleton modules

| Module | Renders | Source | Inline args |
| ------ | ------- | ------ | ----------- |
| `m_contextSize` | Cumulative context input tokens, `size:163.5k`. | `tokens.totals.tokenTotalIn` | `color`, `nulldrop`, `valueOnly` |
| `m_contextWindowsSize` | Capacity of the context window, `size:200k`. | `context_window.size` | `color`, `nulldrop`, `valueOnly` |
| `m_contextUsedPercent` | Percentage of capacity used, `used:82%`. | `context_window.usedPct` | `color`, `nulldrop` |
| `m_contextRemainingPercent` | Percentage of capacity remaining, `remain:18%`. | `context_window.remainingPct` | `color`, `nulldrop` |

### 8.4 Session metadata

| Module | Renders | Source | Inline args |
| ------ | ------- | ------ | ----------- |
| `m_session` | Session name, e.g. `fix-bar-color-regressions`. | `tokens.sessionName` | `color`, `nulldrop` |
| `m_model` | Display name of active model, e.g. `MiniMax-M3`. | `tokens.modelDisplayName` | `color`, `nulldrop` |
| `m_effort` | Effort level: `low` / `medium` / `high` / `max`. | `tokens.effort` | `color`, `nulldrop` |
| `m_repo` | `host/owner/name`, e.g. `github.com/cwf818/topgauge`. | `tokens.workspace.repo` | `color`, `nulldrop` |
| `m_branch` | Current git branch. | git info from cwd | `color`, `nulldrop` |
| `m_gitStatus` | Git dirty / clean indicator. | git status | `color`, `nulldrop` |
| `m_ccVersion` | Claude Code version, e.g. `2.1.191`. | `tokens.ccversion` | `color`, `nulldrop` |
| `m_sessionDuration` | Wall-clock duration of session, `2h 15m`. | `tokens.cost.totalDurationMs` | `color`, `nulldrop` |
| `m_sessionApiDuration` | API-only duration, `1m 23s`. | `tokens.cost.totalApiDurationMs` | `color`, `nulldrop` |
| `m_linesAdded` | Lines added in the session, `+ 1.2k`. | `tokens.cost.totalLinesAdded` | `color`, `nulldrop` |
| `m_linesRemoved` | Lines removed in the session, `- 340`. | `tokens.cost.totalLinesRemoved` | `color`, `nulldrop` |

---

## 9. Inline-args grammar

```
<token>[|<implicit>][|<name>:<value>][|<name>=<value>]…
```

- **Structural separator**: `|` splits the token into `[prefix, (implicitValue,) pair1, pair2, …]`.
- **Pair boundary**: `:` or `=` — splits `<name>[:=]<value>` at the **first** occurrence. The remainder is verbatim the value (so `m_tokenIn|color:red:blue` parses `red:blue` as a single value).
- **Implicit slot**: when the schema declares an `implicit`, the FIRST segment is the implicit value (e.g. `m_label|<text>`, `m_template|<key>`, `s_<name>`). It is `|`-bounded and may contain `:` / `=` freely.
- **Bare module names** with no `|` go through the original dispatcher path. Adding inline args never changes the default render of any existing token.
- **Order** doesn't matter; duplicates keep the last.
- **Errors**: unknown `name`, malformed pair (no `:`, no `=`, unknown name, resolver-rejected value) → dispatcher warns to stderr and drops the token.

---

## 10. Inline-arg axes

| Name        | Accepted values                                                                | Default            | Scope                                                                              |
| ----------- | ------------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------- |
| `color`     | SGR string OR shortcut (`red`, `green`, `yellow`, `blue`, `cyan`, `magenta`, `white`, `gray`, `orange`, `purple`, plus `rainbow`/`rand-rainbow`/`hue` for `m_quote`) | module's natural palette | All `m_*` modules. Replaces the module's band color. Always wins. |
| `nulldrop`  | `true` \| `false`                                                              | `false`            | All `m_*` modules. `false` → keep placeholder slot; `true` → drop the chunk.        |
| `display`   | `used` \| `remaining`                                                          | global `display`   | Window modules only (`m_windowQuota`/`m_windowContext`/`m_windowMemUsage`). Flip which side of the bar is colored and which percentage is shown. Inline wins over config. |
| `term`      | any non-empty string (reserved: `short` / `mid` / `long`)                     | `short`            | `m_windowQuota` / `m_countdown` / `m_quota`. Selects the intervals dict key — three reserved plus any plugin-declared (`monthly`, `yearly`, …). |
| `type`      | `quota` \| `balance`                                                           | (provider-agnostic) | `m_template` only. Filter sub-template by provider TYPE. Absent = universal.        |
| `provider`  | any non-empty string                                                           | (no per-instance gate) | `m_template` only. Gates to one specific provider instance.                  |
| `scope`     | `session` \| `project` \| `model`                                              | `session`          | `m_acc*` only. Pick which slot of the three-layer accumulator.                       |
| `model`     | `active` \| `all` \| `<name>`                                                  | `active`           | `m_sum*` only. Narrow the JSONL scan.                                              |
| `window`    | `<dhms>` (e.g. `5h`, `7d`, `1h30m`) \| `all` \| `<interval.windowId>`           | `all`              | `m_sum*` only. Time window for the scan. `all` is the no-time-anchor sentinel. To resolve a `<id>` against a declared windowId, pass `|align:true`. |
| `align`     | `true` \| `false`                                                              | `false`            | `m_sum*` only. Opt-in flag for declared-windowId resolution. `align=true` looks up `<interval.windowId>` first; on a match the scan runs plan-anchored against that interval's `resetStartAt`. On miss (or `align=false`) the resolver falls through to free-form dhms. |
| `freq`      | `<digits><unit>` (e.g. `120s`, `1h`, `30m`)                                    | `h`                | `m_quote` only. Bucket size for quote rotation.                                     |
| `address`   | URL string                                                                     | `""`               | `m_quote` only. When non-empty, fetch the URL and use the body as the quote source. |
| `fields`    | Comma-separated dot-paths (e.g. `hitokoto,from,from_who`)                     | `""`               | `m_quote` only. Each path is walked against the JSON response. Renders as `field1: field2:`. |
| `quote`     | dot-path string                                                                | `""`               | `m_quote` only. Single-path convenience for the quote body. Rendered as `~<quote>~`. |
| `author`    | dot-path string                                                                | `""`               | `m_quote` only. Single-path convenience for the author field. Pairs with `quote`.   |
| `lang`      | dot-path string                                                                | `""`               | `m_quote` only. Optional language code path; not rendered, only steers the bundle.   |
| `max`       | positive integer                                                               | `1024`             | `m_quote` only. CJK-weighted character budget for the rendered quote body.           |
| `wrap`      | `true` \| `false`                                                              | `true`             | `m_quote` / `s_*`. Wrap the body in `~…~` (m_quote) or pad with spaces (s_*).       |
| `insecureTls` | `true` \| `false`                                                            | `false`            | `m_quote` only. Pass `curl -k` so TLS validation is skipped against the address.    |
| `abs`       | `true` \| `false`                                                              | `false`            | `m_accStartTime` / `m_sumStartTime` / `m_sumEndTime`. Widens `HH:MM:SS` to `YYYY-MM-DD HH:MM:SS`. |
| `valueOnly` | `true` \| `false`                                                              | `false`            | All label-using `m_*` modules. Strips the leading label prefix from both live + placeholder bodies. |
| `repeat`    | `<1..8>` (integer)                                                             | `1`                | `s_*` only. Multiply the separator body.                                            |
| `pos` / `char` | `pos: 0..999` (integer), `char: single printable non-newline`                | —                  | `s_move` only. Column cursor + optional padding char.                                |

### `m_template` passthrough

When an outer `m_template|<key>|…` receives extra named args beyond the intrinsics (`key`, `type`, `provider`), those args are pushed down to the inner modules as a **passthrough** view. Inner-explicit-wins: if the inner token uses the same arg explicitly, the inner value beats the passthrough.

```jsonc
// Outer scope|project → bare m_accTokenIn inside reads project scope.
// Inner explicit |scope|session → wins; m_accTokenIn reads session scope.
{
  "statuslineTemplate": ["m_template|acc|scope:project"],
  "lineTemplates": {
    "acc": [
      "m_accTokenIn",
      "s_space",
      "m_accTokenIn|scope:session"
    ]
  }
}
```

---

## 11. Separators

The template grammar has exactly six built-in separator tokens. Anything else (including the old numeric `s_<n>` form) is treated as an unrecognized module and emitted verbatim.

### 11.1 Named separator aliases

| Token       | Literal  | Notes                                              |
|-------------|----------|----------------------------------------------------|
| `s_space`   | `" "`    | Single space.                                      |
| `s_dot`     | `"·"`    | Middle dot (U+00B7).                               |
| `s_newline` | `"\n"`   | Line break — splits render into "above / below".   |
| `s_tab`     | `"\t"`   | Tab character.                                     |
| `s_colon`   | `":"`    | Colon.                                             |
| `s_pipe`    | `"\|"`   | Pipe.                                              |

### 11.2 Placement rules

- Adjacent separators around a dropped module are skipped — a null `m_tokenOut` won't leave `… · · …` artifacts.
- Leading/trailing separators are trimmed at the renderer level.
- `s_newline` acts as a hard break: output above the break is the upstream section, the break itself goes into composition, output below is appended.

### 11.3 Free-form literal tokens

Any token the renderer cannot match against `m_*` or the six `s_*` aliases is emitted verbatim — no parsing, no warning, no inline-args support. Useful for dropping a static label like `STATUS:` or `·` (custom glyph) into your template without escaping.

```
["m_modeLabel", "PROMPT:", "s_space", "m_windowQuota|term:short"]
// → "Usage: PROMPT: ▓░░░░ 38% (5h)"
```

To get a colored literal, use `m_label|<text>|color:<c>`.

### 11.4 `repeat` and `wrap`

```
s_dot|repeat:3          → "···"
s_dot|repeat:3|wrap:true → " · · · "
s_space|repeat:4        → "    "   (whitespace body skips wrap padding)
s_newline|repeat:2      → "\n\n"  (control body skips wrap padding)
```

- `repeat` is an integer 1..8; out-of-range → drop.
- `wrap=true` pads printable bodies with one space on each side; whitespace / control bodies skip the padding.

### 11.5 `s_move`

`s_move|pos:<0..999>` moves the column cursor to the given column. Optional `|char:<single printable char>` emits a padding character (default ` `). Bare `s_move` is a badarg.

---

## 12. Color values

Three categories accepted by `|color|<c>`:

1. **Shortcut name** — `red`, `green`, `yellow`, `blue`, `cyan`, `magenta`, `white`, `gray`, `orange`, `purple` (plus `brightBlack` / `brightGreen` / `darkGreen` from the palette config). Expands to a built-in 256-color SGR.
2. **Raw SGR escape** — any string starting with `\x1b[`.
3. **`m_quote` extras** — `rainbow` (cycles bands), `rand-rainbow` (random per render), `hue` (continuous from wall-clock).

`STALE_COLOR` (`\x1b[90m`) and `BROKEN_COLOR` (`\x1b[31m`) are the two implicit fallback colors used when a module's data is missing or its fetch is broken — see `colors.stale` and `colors.broken` in §2.

---

## 13. Drop semantics and `nulldrop`

| Form                                       | Behavior when underlying data is `null`                              |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `m_*` (bare)                               | DROP — module skipped, adjacent separators trimmed.                  |
| `m_*\|nulldrop:false` (default inline)     | PLACEHOLDER — module renders a fixed `STALE_COLOR`-wrapped body so the layout stays stable. |
| `m_*\|nulldrop:true`                       | DROP — same as bare form.                                            |

Placeholder shapes per module class:

| Module class                  | Placeholder body                          |
| ----------------------------- | ----------------------------------------- |
| pure number                   | `<prefix>n/a` (e.g. `in:n/a`)             |
| number + unit                 | `-- <unit>` (e.g. `5h:--`)                |
| gauge (window)                | `░░░░░░░░ 0%` (gray)                       |
| countdown / quota             | `<label>:--` (gray)                       |
| bare string                   | `n/a`                                     |
| ratio (hit-rate family)       | `<prefix>n/a%` (e.g. `hit:n/a%`)          |

`m_windowQuota|term:short|mid|long` (any term) always renders the gauge shape with the `STALE_COLOR` band when stale, regardless of `display` mode.

**Value-zero rule**: when the module's data path yields the literal number `0` (not `null`), the module renders the value as `0` (e.g. `in:0`, `calls:0`). Divide-by-zero renders as `--`.

---

## 14. Per-module type filters

The renderer tags each module with a `type` value. A module's emit is skipped when the active provider's TYPE doesn't match.

| TYPE value | Active when                                       |
| ---------- | ------------------------------------------------- |
| `quota`    | Provider has `TYPE: "QUOTA"`.                     |
| `balance`  | Provider has `TYPE: "BALANCE"`.                   |
| `unknown`  | No provider entry matched `ANTHROPIC_BASE_URL`.   |

`agnostic` modules (everything not labeled quota/balance) emit on every tick. `m_template` with neither `type` nor `provider` set is **universal** — emits on all three TYPEs.

---

## 15. `m_pluginSource`

Visual indicator of which side of the user-vs-builtin fence the active provider's plugin resolved from.

| `ctx.pluginSource` value | Glyph (default) | Meaning                                                                                |
| ------------------------ | --------------- | -------------------------------------------------------------------------------------- |
| `"builtin"`              | `📌`             | Plugin loaded from the bundled `dist/plugins/<id>/` tree.                              |
| `"user"`                 | `🎨`             | Plugin loaded from a user override at `~/.claude/plugins/topgauge/query_plugins/<id>/`. |
| `"missing"`              | `❗`             | `matchProvider` returned an id but neither user nor built-in produced a file.            |
| `null` / `undefined`     | (drop)          | No provider matched, or no cache row yet.                                              |

Glyphs come from `labels.labelPluginSystem / .labelPluginUserDefined / .labelPluginMissing` (defaults `📌 / 🎨 / ❗`). A 4th axis `labelPluginCC` (default `🔖`) is reserved for a future "claude 官方" branch.

The cache row key is `<provider>:pluginSource`, written by `index.ts:main` right after each successful `pluginTransportWithKind` call. The renderer reads it via `cache.peek` (TTL-ignoring) so a user adding/removing their override file reflects on the next tick without waiting for the data row to expire.

---

## 16. `m_quote`

A rotating quote, frequency-bucketed (local) or strings from a remote endpoint.

- **Local mode** (no `address`) — pulls from the bundled `quotes.json` (100+ bilingual entries). Bucket rotation by `|freq:<dhms>` (default `h`).
- **Remote mode** (`|address:<URL>`) — fetches the URL via `curl -sSf --max-time 5` (with `node:http(s)` core fallback when curl isn't on PATH), JSON-parses the body, and walks the dot paths in `|quote:<p>|author:<p>|lang:<p>` against it. The body is rendered as `~<quote>~` (or `~<quote>--<author>~` when `author` is set); pass `|wrap:false` for the bare form. The `|fields:<a,b,c>` form is also accepted — all dot paths are walked and rendered as `field1: field2:` (trailing colon).
- On any fetch / parse / walk failure (curl exit, non-JSON body, any path miss), the renderer falls back to the local `quotes.json` list **and appends a row to `diagnostics.jsonl`** (gated on `TOPGAUGE_DIAGNOSTICS_ENABLE=1`) with `source = "m_quote"`.

### Inline args

`freq`, `color` (incl. `rainbow`/`rand-rainbow`/`hue`), `address`, `fields`, `quote`, `author`, `lang`, `max` (CJK-weighted char budget, default 1024), `wrap`, `insecureTls`.

### Online endpoint examples

```
m_quote|address:https://v1.hitokoto.cn/|quote:hitokoto|author:from_who
m_quote|address:https://api.quotable.io/random|quote:content|author:author
m_quote|address:https://api.xygeng.cn/one|quote:data.content|author:data.name
```

---

## 17. Token usage family

Three-tier semantic split (per-turn / acc / sum) plus the cost three-tuple. Source: stdin (`tokens.*`) for per-turn; `state/<projectHash>/status.json` for acc; `state/<projectHash>/cache.json` cross-project scan (TTL=300s) for sum.

### Per-turn modules

Read `current_usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` and the cumulative `context_window.{total_input_tokens, total_output_tokens}`. Invariant: `total_input_tokens == current.input_tokens + current.cache_read_input_tokens`. Violations write a `warning` row to `diagnostics.jsonl` (gated on `TOPGAUGE_DIAGNOSTICS_ENABLE=1`, 60s dedupe).

### Acc modules

Three-layer in-memory accumulator (session / project / model). Each tick's `current_usage.*` is added to the active scope's slot. Cold slots replay from JSONL on first valid tick.

### Sum modules

Cross-project JSONL scan. Inline args `model` (default `active`), `window` (default `all`), `align` (default `false`). With `align=true` and a `<interval.windowId>` declared in the active provider's plugin output, the scan runs plan-anchored against that interval's `resetStartAt`.

### `m_tokenCost` / `m_accTokenCost` / `m_sumTokenCost`

Computed as `tokenIn * price.in + tokenOut * price.out + tokenCachedIn * price.cachedIn`. Price per model lives in `config.tokenPrices.<modelId>` (`{ in, out, cachedIn, currency }`). Missing model → renders as `cost:n/a`. Zero rates are valid.

Tiered precision via `tokenFormat.precision`:
- `value >= 1`           → `1.2345` (4 dp)
- `value >= 0.01`        → `12.345` (3 dp)
- `value >= 0.0001`      → `1.23` (2 dp)
- `value < 0.0001`       → `1.2` (1 dp)

---

## 18. Composition with the upstream statusline

Tokens that produce a `\n` (`s_newline`, or any multi-line body) split the rendered output into "above the break" and "below the break" chunks:

- Everything ABOVE the first newline is **prepended** to the upstream output (whatever `TOPGAUGE_UPSTREAM` contains).
- Everything BELOW is **appended** after the upstream.

This is how a multi-line preset renders: a multi-line plan section + a multi-line balance section, sandwiched around the upstream statusline.

---

## 19. Recipes

### Minimal — just the mode label and 5h window

```jsonc
"statuslineTemplate": ["m_modeLabel", "s_space", "m_windowQuota|term:short"]
```

### Default-style

```jsonc
"statuslineTemplate": [
  "m_modeLabel|color:yellow",
  "s_space",
  "m_windowQuota|term:short",
  "s_dot",
  "s_space",
  "m_windowQuota|term:mid",
  "s_space",
  "m_age|color:gray"
]
```

### Plan-only with custom 5h color override + sum tokens

```jsonc
"statuslineTemplate": [
  "m_template|plan|type:quota",
  "s_newline",
  "m_template|balance|type:balance"
],
"lineTemplates": {
  "plan": [
    "m_windowQuota|term:short|color:red|display:remaining",
    "s_space",
    "m_countdown|term:short",
    "s_dot",
    "s_space",
    "m_windowQuota|term:mid",
    "s_space",
    "m_countdown|term:mid",
    "s_newline",
    "m_sumTokenIn|window:5h",
    "s_dot",
    "s_space",
    "m_sumTokenHitRate|window:5h|align:true"
  ],
  "balance": [
    "m_balance",
    "s_space",
    "m_age"
  ]
}
```

### Universal renderer (no `type:` gate)

On a Quota provider the `usage` branch renders; on a BALANCE provider the `balance` branch renders. Both branches use the same outer token list; `type:` is omitted so the dispatcher doesn't drop either side.

```jsonc
"statuslineTemplate": [
  "m_template|usage",
  "s_newline",
  "m_template|balance"
],
"lineTemplates": {
  "usage":   ["m_modeLabel", "s_space", "m_windowQuota|term:short", "s_space", "m_age"],
  "balance": ["m_modeLabel", "s_space", "m_balance", "s_space", "m_age"]
}
```

### Compose with the upstream statusline via a preset

```jsonc
"statuslineTemplate": "standard"
```