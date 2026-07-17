# Changelog

## v1.0.0

### Breaking

- **Renamed from `topgauge` to `creditgauge`. Hard cut — no compat shim.**
  Every user-visible identifier is renamed:
  - **Plugin / marketplace / repo name**: `topgauge` → `creditgauge` (was `topgauge-cc` in v0.7.0; formal product name `CreditGauge-CC`).
  - **Slash-command prefix**: `/topgauge:` → `/creditgauge:` (`:install`, `:uninstall`, `:clean`, `:clean-cache`).
  - **Env-var namespace**: `TOPGAUGE_*` → `CREDITGAUGE_*` (`TOPGAUGE_UPSTREAM` → `CREDITGAUGE_UPSTREAM`, `TOPGAUGE_UPSTREAM_CMD` → `CREDITGAUGE_UPSTREAM_CMD`, `TOPGAUGE_DIAGNOSTICS_ENABLE` → `CREDITGAUGE_DIAGNOSTICS_ENABLE`).
  - **`settings.json` marker**: `_topgauge_managed` → `_creditgauge_managed`.
  - **Cache / marketplace / state dir**: `~/.claude/plugins/topgauge/` → `~/.claude/plugins/creditgauge/` (cache `topgauge/`, marketplace `topgauge/`, state `topgauge/state/`).
  - **Repo URL**: `github.com/cwf818/topgauge` → `github.com/cwf818/creditgauge`. README badges, install/upgrade snippets updated.
  - **Stderr banner**: `topgauge:` → `creditgauge:`.
  - **Plugin version**: `0.9.8` → `1.0.0`.
  - **Provider strings FROZEN** — NOT renamed: `minimax`, `MiniMax`, `MiniMax-M3`, `minimaxi.com`, `Quota`, `BALANCE`, `DeepSeek`, `deepseek`, `/v1/token_plan/remains`, `/user/balance`.
  - **NO legacy dual-strip.** Unlike v0.7.0 (which kept `tokenplan-usage-hud` recognition for one release), v1.0.0 does NOT recognize `_topgauge_managed`. Re-running the new `:install` against a v0.9.x state reports "not installed" and leaves the old statusLine alone.
  - **NO state-dir migration.** `~/.claude/plugins/topgauge/state/` is wiped by `:uninstall`; `~/.claude/plugins/creditgauge/state/` starts empty. Token-sample JSONL history, diagnostics logs, and preserved upstream commands do NOT carry forward.
  - Per `new-feature-convention.md`: 不兼容旧实现;冲突直接覆盖而非 compat shim.

### Upgrade flow

```bash
# 1. Uninstall the OLD plugin (v0.9.x)
/topgauge:uninstall
# (or `bash scripts/uninstall.sh` if the v0.9.x cache is gone)

# 2. Install the NEW plugin
/plugin marketplace add cwf818/creditgauge
/plugin install creditgauge@creditgauge

# 3. Wire it into settings.json
/creditgauge:install
```

Optional: `~/.claude/plugins/topgauge/config.json` and `~/.claude/plugins/topgauge/query_plugins/` are preserved across `:uninstall` (config is treated as user data, not plugin state). Manually `mv` them into the new `creditgauge/` dir after step 1 if you want user plugins / provider entries to carry forward.

## v0.9.8

### Fix

- **`m_sum*|term:` on-disk cache key resolves to `intervals[term].windowId`.**
  Previously the term short-circuit in `parseWindowScope` (src/render.ts:3567) wrote the literal term key (e.g. `"short"`) as `windowKey`, so an equivalent `|window:5h|align:true|model:active` and `|term:short|model:active` minted two separate cache rows (`stat:MiniMax-M3:5h:true` vs `stat:MiniMax-M3:short:true`). One statistical intent now maps to one cache entry. `windowKey` resolves to `iv.windowId || termRaw` — when a provider declares `monthly.windowId = "30d"` and `long.windowId = "30d"`, both terms collapse onto `stat:<model>:30d:true`. Falls back to the term key literal when `windowId` is empty/missing.
- **`m_sumTtlStatus` inline dispatcher `skipLen` off-by-one.** The new module's `m_sumTtlStatus` is 14 chars (not 15 like `m_statTtlStatus`), so the dispatcher's `expandInlineToken(tok, "m_sumTtlStatus", 16, ctx)` sliced one byte too far and the `term:short|model:active` body came out as `"erm:short|model:active"`. After re-counting: `m_sumTtlStatus` is 14, +"|" = 15. Inline path now resolves correctly; bare form already worked.

### Add

- **`term` added to `m_template` passthrough whitelist.** An outer `m_template|<key>|term:short` now cascades to every inner `m_sum*` instead of failing loud (`badarg` → warn + drop). Inner module's own `params.term` still wins per the standard precedence rule (outer = fallback).
- **`m_sumTtlStatus` — per-filter TTL gauge, sibling of `m_statTtlStatus`.** `m_statTtlStatus` showed the freshest of ALL stat-cache keys; `m_sumTtlStatus` shows the TTL of the EXACT `stat:<model>:<windowKey>:<align>` row that `parseWindowScope` resolves for the active filter (model + window + align + term). Lets the user inspect freshness for a SPECIFIC `m_sum*` aggregate, not just the newest write to the cache. Inherits the `m_sum*` filter surface (`color` / `nulldrop` / `model` / `window` / `align` / `term`). Cache miss → `▆` placeholder in STALE_COLOR. `peekStatAgeMs` is TTL-IGNORING (mirrors `peekFreshestStatAgeMs`), so a row past its 300s TTL still renders — the user sees "0s" in red, knowing the aggregate is gone.

### Tests

- `src/render-tokens.test.ts` — fixture key updates at 7448, 7492 (`stat:MiniMax-M3:short:true` → `stat:MiniMax-M3:5h:true`).
- 4 new tests: positive (term + explicit window collide on one cache row), fallback (empty `windowId` → term key literal), collision (two terms with the same `windowId` share one entry), precedence (term + simultaneous `|window:<dhms>` → term wins).
- 8 new tests in `m_sumTtlStatus` describe block (6410-6580): placeholder on miss, fresh / half-aged / expired entries (3 tiers of 5-band color), per-filter key isolation (|term:short| vs |term:mid| peek distinct rows), |color|orange| override, |nulldrop|true| drop, explicit `|window:5h|align:true|` path (mirrors `|term:short|` to the same key).

### Docs

- `MANUAL.md:443-444` — add `term` to the missing `m_tokenIn` / `m_tokenOut` rows in the m_sum* arg column.
- `MANUAL.md:712` — append a sentence describing the windowId-keyed cache behavior and the empty-windowId fallback.
- `MANUAL.md:433-434` — new `m_sumTtlStatus` row in the m_* module table, alongside its `m_statTtlStatus`/`m_cacheTtlStatus` siblings.

## v0.9.7

### Add

- **Install-journal (write-ahead log) for settings.json.**
  `scripts/install.sh` now records every per-field change it makes to `settings.json.statusLine` to `${STATE_DIR}/install-journal.json`. Three action kinds: `create` (field did not exist before install), `mutate` (existing field changed; before/after snapshot), `clamp-down` (over-threshold value clamped). `scripts/lib/journal.mjs` is the new module exposing `readEntries` / `appendEntries` / `markApplied` and 50-entry rotation. The journal is the **authoritative record** of what install did — uninstall reads it (see below) to revert only the parts the user hasn't touched since.
- **`scripts/lib/edit-settings.mjs` — `ensure-refresh-interval` op.**
  Reads `settings.json.statusLine.refreshInterval`: missing → create at 10; `<= 10` → no-op; `> 10` → clamp down to 10 with stdout notice. Idempotent. Invoked by `install.sh` immediately after `write-managed`.
- **`scripts/lib/edit-settings.mjs` — `apply-journal-entry` op.**
  Per-field revert driver. For each unapplied journal entry, compares the entry's `after` snapshot against the **current** `settings.json`: matching fields are reverted (created → removed, mutated/clamp-down → restored to `before`), fields the user changed after install are preserved. The whole `statusLine` block is deleted when a single `create` entry's full after-snapshot still matches.
- **`scripts/uninstall.sh` — journal-driven restore is the new default.**
  Priority chain is now (1) install-journal (default path), (2) legacy `restore-from-file` from `state/upstream-cmd.txt`, (3) `restore-from-bak` from pre-managed `settings.json.bak.<ts>`, (4) `warning:no-restore-source`. Legacy (2) and (3) are kept as fallbacks for installs that pre-date the journal.
- **`statusLine.refreshInterval` is now managed by `install.sh`.**
  Creates the field at `10` when missing; clamps down to `10` with a stdout notice (`install.sh: clamped statusLine.refreshInterval from N to 10 — set it back manually if you want to keep N`) when the user's value exceeds `10`. Values `<= 10` are left alone.
- **Fresh-install no longer needs an `upstream-cmd.txt` placeholder.**
  The journal's `create` entry IS the record. Uninstall deletes the whole `statusLine` block when no field has been user-touched.

### Add (post-merge)

- **`acc_eval` fragment renamed to `combline1`, `stat_eval` merged into `combline1`/`combline2` siblings.**
  The session acc block and the 5h-align stat block are now a single `combline1` preset (separated by `s_move|pos:73` + `s_pipe|wrap:true`); the project acc block and 7d-align stat block are combined into `combline2` likewise. Same shape as before — fewer fragments, easier to compose.
- **`s_move|pos:73` (was `pos:70`, then `pos:71`).**
  Column cursor advanced by 3 cells to absorb the new 3-space pad after `🟢Session:` / `🟢Project:` (the wide-emoji compensation that `visibleCellLength` doesn't recognize as wide).
- **Per-Project state layout: `install-journal.json` is in the preserved group.**
  Sibling of `config.json` and `query_plugins/`; `:uninstall --completely` (or default) does NOT wipe it. Survives cache wipes because it lives in the STABLE state dir.

### Internal

- New `scripts/lib/journal.mjs` (no network, no side effects beyond `${STATE_DIR}/install-journal.json`).
- `scripts/lib/edit-settings.mjs`: new ops `ensure-refresh-interval` + `apply-journal-entry`; existing `write-managed` / `restore-from-file` / `restore-from-bak` / `status` unchanged.
- `scripts/install.sh`: captures `SL_BEFORE_JSON` / `SL_AFTER_JSON` around the `write-managed` call, appends a journal entry, then runs `ensure-refresh-interval`. Fresh-install path now also calls `mkdir -p "$STATE_DIR"` so the journal has somewhere to land.
- `scripts/uninstall.sh`: `HELPER` resolution at top, `JOURNAL_PATH` discovery under `STATE_DIR`, journal-first `SL_PLAN`, `restore-from-journal:*` apply case that calls `apply-journal-entry`.

### Tests

- `scripts/test-install.sh` — 3 new cases (16 assertions): fresh install records journal `create` + refreshInterval `create`; replace with `refreshInterval=30` records `clamp-down`; replace with `refreshInterval=5` is no-op (no journal entry).
- `scripts/test-uninstall.sh` — 5 new cases (8 assertions): fresh-journal-block-deleted, per-field-revert, clamp-down restore, clamp-down preserved, legacy fallback.
- `scripts/test-edit-settings.sh` — new sections for `ensure-refresh-interval` (create|10, no-op|10, clamp-down|30|10) and `apply-journal-entry` (block-delete after first apply, applied flag survives re-run).
- All 22 + 27 + 53 + 27 = 129 install/uninstall/edit-settings/clean-cache tests pass. `npm test` 1055/0.

## v0.9.6

### Add

- **`m_sumEstQuota` module — periodic quota estimate.**
  Renders `est:$30.20` (fixed 2dp, per-model currency prefix). Computed as the cross-project `m_sumTokenCost` formula (sumIn*in + sumOut*out + sumCachedIn*cachedIn) divided by the aligned plan window's `used%`, projecting the spent cost up to a full-period spend: `est = cost / (alignedUsedPercent / 100)`. New `labels.labelEstQuota` (default `"est:"`) for prefix override. Inline args: `color`, `nulldrop`, `model`, `window`, `align`, `term`, `valueOnly`. Three short-circuits all funnel into the `est:n/a` placeholder body for layout stability: `rows === 0` (no JSONL samples in window), `alignedUsedPercent == null` (non-aligned scan), `alignedUsedPercent === 0` (divide-by-zero guard). Natural opt-in form: `m_sumEstQuota|term:short|model:active` — no explicit `|align|true` needed.
- **`StatAggregate.alignedUsedPercent` field.**
  `getStatAggregate` now stamps the aligned plan window's `used%` onto the cache entry when `alignActive=true` (existing `align=true` + `|window|<windowId>` resolved path, plus the new `|term|<key>` opt-in). Read by `m_sumEstQuota` and any future consumer that needs the aligned used% without re-running the interval lookup. Populated structurally off the renderer-passed `filter.interval` — mirrors `intervalToWindow`'s used%-pick rule (used% wins, else `100 - remaining%`, else null) so a window with only `remainingPercent` is handled symmetrically.
- **`|term|<key>` inline arg for the m_sum* family.**
  Opt-in plan-aligned scan shortcut: `|term:<key>|model:<not all>` is equivalent to `|window:<intervals[term].windowId>|align:true|model:<same>`. Looks up `ctx.intervals[term]`, runs the scan from the interval's `startAt`, and stamps `alignedUsedPercent` on the cache entry. Mirrors the m_windowQuota / m_countdown / m_quota `term` arg shape but **opt-in** (unlike those modules where `term` defaults to `"short"` unconditionally) — defaulting `term` would silently re-define every bare m_sum* module as a 5h-aligned scan and break existing `|window|<dhms>` users. Requires `|model| != "all"` (a per-term scan without a model filter is ambiguous). Failure modes (interval missing / no usable `startAt`+`endAt`) silently fall through to the existing `|window|`/`|align|`/`dhms` path. All 13 m_sum* INLINE_SCHEMAS entries gain `...TERM_PARAM.named`. The bare MODULES form is unchanged (no params, no term).

### Add (post-merge)

- **`bigmodel` (智谱) user-defined QUOTA provider.**
  Ship `query_plugins/bigmodel/index.js` — a user-side plugin (alongside kimi / copilot-api, NOT in `DEFAULT_PROVIDERS`) that projects `GET https://bigmodel.cn/api/monitor/usage/quota/limit` onto the canonical Quota shape: `short` (5h) ← first `TOKENS_LIMIT` sorted by `nextResetTime` ASC, `mid` (7d) ← second `TOKENS_LIMIT` when present (new plans have a weekly cap; old plans only ship one), `long` (MCP monthly) ← `TIME_LIMIT` entry with absolute unit counts. `nextResetTime` is the only time anchor the API ships; back-derive `startAt = nextResetTime − intervalMs` so the renderer can pick a window-fill-aware reset arrow. `success:false` / empty `limits[]` returns null (host falls back to stale cache row). Registration snippet lives in the plugin header comment — the user adds it to `~/.claude/plugins/topgauge/config.json`'s `providers` block: `BASE_URL_COMPARED_TO=https://bigmodel.cn/api/anthropic`, `COMPARE_METHOD=INCLUDE`, `TYPE=QUOTA`. An experimental implementation by AI (referring to the BigModel `/v1/token_plan/remains` API documented at the cc-switch mirror); verify against a real BigModel API key before relying on it.

### Fix

- **`compareUrl` trailing-slash normalization.**
  `compareUrl(method, baseUrl, pattern)` now strips trailing slashes on both sides (`.replace(/\/+$/, "")`) after the existing `.toLowerCase()`, applied uniformly to all three compare methods (EXACT / INCLUDE / STARTWITH). A user with `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic/` now matches the EXACT-registered `https://api.minimaxi.com/anthropic` and vice versa — same for any custom provider with a trailing-slash variant on either side. The `STARTWITH` suffix-attack guard (`api.deepseek.com.evil.example` must NOT match `api.deepseek.com`) is preserved by indexing the ORIGINAL `baseUrl` at `pattern.length` so a trailing `/` lands exactly on the boundary character. Net effect: copy-pasting a base URL with or without a trailing slash no longer silently breaks provider routing.

## v0.8.43

### Remove

- **`m_tokenTotal` and `m_tokenSession` modules (hard delete).**
  Both modules rendered the same metric (`totals.input + totals.output +
  current.tokenCacheCreation + current.tokenCachedIn`) under two
  different hardcoded prefixes — `tot:` and `session:` respectively.
  Neither prefix is bound to `labels.*`, so they bypassed the
  v0.8.22 labels-unified cleanup and the v0.8.42 `|valueOnly|`
  inline arg was inapplicable to them. Removed per the user's
  "delete m_tokenTotal and m_tokenSession" directive and per the
  [[new-feature-convention]] memory (2026-07-09) — no compat
  shim, no alias fallback. Users who want the per-turn in+out
  combined metric should compose the two axes inline (e.g.
  `m_tokenIn + m_tokenOut`) or read `totals.tokenTotalIn +
  totals.tokenTotalOut` via their own template extension. Existing
  config.json lineTemplates that reference either module will
  surface an `unknown lineTemplate module 'm_tokenTotal' /
  'm_tokenSession'; ignoring` warning once per process and the
  chunk will drop — same contract as any unrecognized module
  token.
  - Removed from `MODULES` and `INLINE_RENDERERS` maps.
  - Removed from `INLINE_SCHEMAS` registry.
  - Removed from inline dispatch (both `m_tokenTotal|` and
    `m_tokenSession|` branches).
  - Removed shared helpers `inlineTokenTotalLabel` /
    `inlineTokenSessionLabel`.
  - Removed test in `src/render-tokens.test.ts`
    ("m_tokenSession / m_tokenTotal: same numeric totals").
  - Removed row from MANUAL.md §1.4 standalone modules table.
  - Removed row from README.md module index.
  - Cleaned `m_tokenTotalOut` / `m_tokenTotalIn` inline dispatch
    comments — the v0.8.42-era "must come BEFORE m_tokenTotal:"
    prefix-shadowing warning is no longer necessary.
  - Updated the v0.8.42 changelog entry to reflect the new
    non-label-using-modules exclusion list (m_tokenTotal /
    m_tokenSession are gone, not excluded).

## v0.8.42

### Add

- **`|valueOnly|<true|false>` inline arg on all label-using
  `m_*` modules (~36 modules: per-turn tokens / cost / speed /
  hit-rate / api-ms / api-calls, `m_acc*` family, `m_sum*`
  family, `m_memUsage`, `m_contextSize` / `m_contextWindowsSize`
  / `m_contextUsedPercent` / `m_contextRemainingPercent`,
  `m_tokenInTotal` / `m_tokenTotalOut` / `m_tokenTotalIn`,
  `m_accStartTime`, `m_sumStartTime`, `m_sumEndTime`).** Opt-in
  prefix strip — `m_tokenIn|valueOnly:true` renders `1.2K`
  (was `in:1.2K`), missing data → `n/a` (was `in:n/a`). Accepts
  only literal `true` / `false` (typos fail loud at the
  inline-args resolver and drop the chunk). Defaults to `false`
  so v0.8.x renders stay byte-identical. Forwarded through
  `m_template` via the passthrough whitelist so an outer
  `m_template|<key>|valueOnly:true` cascades to every
  label-using inner module. Non-label-using modules (window,
  countdown, quota, balance, age, version, session, model,
  repo, branch, gitStatus, ccVersion, sessionDuration,
  sessionApiDuration, linesAdded, linesRemoved, windowContext,
  cacheTtlStatus, statTtlStatus, windowMemUsage, quote, m_template,
  `s_*`) are out of scope by construction.

## v0.8.36

### Add

- **`m_windowMemUsage` module — system RAM used bar +
  5-band-colored percentage, parallel of `m_windowContext`.**
  Renders e.g. `▓▓▓▓▓░░░ 62%` (no label prefix — pure
  bar+percent shape, mirrors `m_windowContext`). New sibling
  of `m_memUsage` (which renders the absolute-bytes shape
  `Mem:15.9G/63.7G` with a fixed cyan tint).
  `m_windowMemUsage` reads the same `getMemUsage()` helper
  but normalizes to a 0..100 ratio, wraps it in a synthetic
  `Window`, and routes through `formatOneChunk` /
  `formatOneChunkColored`. The value color is driven by
  `colorFor(pct, "used")` so a user who tunes
  `thresholds.percentBands` (default `[20, 40, 60, 80]`) gets
  the matching RAM-band color automatically — brightGreen
  below 20%, darkGreen below 40%, yellow below 60%, orange
  below 80%, red at 80%+. Opt-in: the default `lineTemplate`
  does NOT include it, so existing renders stay byte-identical
  after upgrade.
  - Bare form: `m_windowMemUsage` — uses band color.
  - Inline form: `m_windowMemUsage|color:<c>|display:<used|remaining>|nulldrop:<bool>`
    — `|color|<c>` overrides the band color (override always
    wins, matching every other inline module);
    `|display|<used|remaining>` selects which side of the bar
    is colored and which percentage is shown (parallel to
    `m_windowContext`); `|nulldrop|<bool>` drops the chunk on
    null. Missing or zero-total `getMemUsage()` → `▓...▓ 100%`
    or `░...░ 0%` gauge placeholder (matches `m_windowContext`'s
    `placeholderGauge`), wrapped in `STALE_COLOR` (bare) or the
    user's `|color|` (inline).
  - No label customization — the renderer is label-free
    (parallel of `m_windowContext`). Users who want a
    `m_label|RAM%`-style prefix can add it as a separate
    template token.
  - Files: `src/render.ts` (MODULES entry, INLINE_RENDERERS
    entry, INLINE_SCHEMAS entry, dispatcher chain,
    PLACEHOLDERS, DEFAULT_COLORS), `src/render-tokens.test.ts`
    (4 regression tests mirroring the `m_windowContext`
    pattern).

## v0.8.34

### Fix

- **`m_quote|address:<URL>` no longer silently falls back to local QUOTES.**
  The v0.8.33 inline-args rewrite updated the renderer's
  `parseInlineArgs` to the two-class `|name:value|` grammar, but
  missed the parallel scanner in `src/api.quote.ts:scanTokens`. The
  scanner was still using the v0.8.21-era positional
  `parts[i] === "name"` checks, so a v0.8.33-shaped token like
  `m_quote|address:https://api.quotable.io/random|…` arrived with
  the pair string in slot 1, the equality check failed for every
  pair, and the function returned `null` — leaving
  `preFetchQuotes` to early-return an empty Map. The renderer then
  read from the empty Map, emitted a `address fetch failed (no
  body)` warning forever, and fell back to the local QUOTES list
  on every tick.
  The fix rewrites `scanTokens` to use the same first-`:`-or-`=`
  boundary rule as `parseInlineArgs`. The URL value's embedded
  `:` (e.g. the scheme in `https://…`) stays inside the value,
  matching the renderer's contract. Pairs the scanner doesn't
  care about (`color:`, `quote:`, `author:`, `lang:`, `max:`,
  `wrap:`, `nulldrop:`) are silently skipped. The pre-v0.8.33
  positional form is **not** preserved (it was a v0.8.33 breaking
  change).
  Regression test: `src/api.quote.test.ts:33` (user's exact
  template), `:43` (URL with `:`), `:54` (`=` separator), `:65`
  (extra pairs), `:74` (no address), `:80` (bad freq), `:91`
  (insecureTls truthy), `:106` (non-m_quote tokens), `:115` (old
  positional form).

### Change

- **m_quote fetch-failure diagnostics raised to `error` level.**
  `src/api.quote.ts:349` (preFetch curl/network failure) and
  `src/render.ts:4397/4415/4425` (render-time no-body /
  non-JSON / JSON-but-quote-miss) now emit at `error` instead of
  `warning`. The on-disk `level` field is a free string, so this
  is purely a noise/severity contract change for operators
  grepping `diagnostics.jsonl` by level. Affected test:
  `src/render-tokens.test.ts:687` updated accordingly.
- **`diagnostics.jsonl` file cap raised from 200 to 1000 lines.**
  `src/diagnostics.ts:DEFAULT_MAX_ENTRIES` is now 1000. A
  sustained failure mode (e.g. `m_quote|address:<URL>` with the
  endpoint down for several minutes) keeps enough tail to
  postmortem, without paying for an unbounded file in the steady
  state. Affected test: `src/diagnostics.test.ts:147` rewritten
  to flood 1100 lines and assert the most-recent 1000 are kept.

## v0.8.33

### Breaking

- **Inline-args grammar: two-class separator scheme.** The
  parser now uses TWO separator classes:
  1. **First-class `|` (pipe)** — structural. Splits the
     token into `[moduleName, (implicitValue,), pair1, pair2, …]`.
     Single-purpose: separate the parts of an inline-args
     expression.
  2. **Second-class `:` or `=` (first occurrence wins)** — pair
     boundary. Splits each `pair` into `[name, value]`.

  The previous v0.7.1–v0.8.32 positional `|name|value|value|…`
  form is **REMOVED**. The dispatcher treats unparseable
  segments (no `:`, no `=` boundary) as "unknown lineTemplate
  module" and drops them.

  New grammar:
  ```
  <token>[|<implicit>][|<name>:<value>][|<name>=<value>]…
  ```
  - The implicit slot (for `m_label`, `m_template`, `s_<n>` —
    first segment AFTER the module name) is `|`-bounded and
    may contain `:` or `=` freely (so `m_label|GPU: A100`
    parses correctly even though the label has a colon).
  - Each pair is split on the **first** `:` or `=`. The left
    side is the name; the right side is the rest of the
    string (so `color:red:blue` parses as
    `color = "red:blue"`).

  Examples (v0.8.33+):
  - `m_label|hello|color:red`
  - `m_label|GPU: A100|color:brightGreen`
  - `m_windowQuota|term:short|color:red`
  - `m_tokenIn|color=red` (equivalent to `:`, choose freely)
  - `m_sumTokenIn|window:7d|model:active|align:true`
  - `m_quote|address:https://v1.hitokoto.cn/|quote:hitokoto`
  - `s_dot|repeat:3|wrap:true`

  User action required: rewrite every
  `lineTemplates.<key>` entry in your
  `~/.claude/plugins/topgauge-cc/config.json` —
  replace `|name|value|` with `|name:value|` (or
  `|name=value|`). The plugin emits a one-time stderr
  warning per bad token; it does NOT auto-migrate.

### Added

- All v0.7.1+ tests, all v0.8.0–v0.8.32 tests, and all default
  presets in `src/config.ts` are updated to the new grammar
  so the bundled default renders remain functional.

## v0.8.32

### Added

- `|align|<true|false>` is a meaningful inline arg again on
  `m_sum*` modules, default `false`. `align=true` opts into
  the declared-`interval.windowId` lookup branch of the
  three-step resolver; `align=false` skips the lookup
  entirely and goes straight to free-form dhms. This is a
  reversal of v0.8.31, which had treated `align` as a no-op
  in favor of "did the `window` arg match a declared ID"
  semantics.

- `m_sumStartTime` / `m_sumEndTime` read `filter.alignActive`
  (renamed from v0.8.x; restored to its pre-v0.8.31 name).
  When `align=true` AND the resolver landed on a declared
  `interval.windowId`, the modules render the plan's
  `resetStartAt` / `resetAt` close instant. Otherwise they
  keep the empirical `min(row.startAt)` / `max(row.lastAt)`
  fallback. `m_sumTokenIn` / `m_sumTokenOut` /
  `m_sumTokenCachedIn` / `m_sumApiMs` / etc. are unaffected —
  they were never `align`-gated readers.

- The literal string `"all"` is reserved as the
  no-time-anchor sentinel for `m_sum*|window|`. `parseWindowScope`
  short-circuits on `"all"` before any windowId lookup, so
  users CANNOT name an `interval.windowId: "all"`. The
  reservation is enforced by the resolver (always
  short-circuits), not by config validation.

### Changed

- Bare `m_sum*` (no `|window|` arg) now defaults to
  `window="all"` instead of the legacy `window="5h"`. A bare
  `m_sumTokenIn` now reads the entire cross-project JSONL;
  explicit `|window|<dhms>` is the opt-in to a time-bounded
  scan, and `|window|<declaredId>|align|true` is the opt-in
  to a plan-aligned scan. Existing templates with explicit
  `|window|5h` (the most common form) keep working — they
  fall through to dhms wall-clock `5h` under the new
  `align=false` default.

- Stat-cache key at `src/status-store.ts:1207` re-adds the
  `:alignActive` segment (`stat:<model>:<windowKey>:<alignActive>`)
  because the resolver now buckets along it. The v0.8.31
  reduction to `stat:<model>:<windowKey>` was discarded
  since declared-windowId resolution can produce different
  `(sinceMs, interval)` pairs for the same `windowKey`
  literal depending on `align`. The 300s TTL still bounds
  abandoned entries.

- `intervals.<key>.windowId` accepts any string including
  digit prefixes. The v0.8.31 `w`-auto-prefix + warn
  behavior is removed — the new align-gated resolver makes
  the collision impossible (windowId lookup only runs when
  `align=true`; dhms lookup only runs when `align=false`),
  so users can name their windows freely.

### Hardening

- `m_template` passthrough axis reach tests (which exercise
  the `m_template|<key>|window|<v>` axis-forwarding path)
  are updated to reflect the new defaults: bare-key passthrough
  now reads the entire JSONL (matching the new bare `window=all`
  default) and the `|window|<declaredId>|align|true` form
  is required for plan-aligned scans.

## v0.8.29

### Added

- `m_acc*` modules now reconstruct cold slots from the JSONL
  sample stream. Previously, when `state.json` was missing
  (fresh install, after `:clean --purge-runtime`, accidental
  deletion), the first valid tick's `setAvg` seeded the
  `tickStatus:<dim>` slot from the current tick's delta only —
  historical JSONL data was discarded and the user saw a
  misleading `acc:0` followed by a one-tick blip. The new
  Stage 0 cold-slot replay runs BEFORE `setAvg` mutates the
  slot, marks the recovered aggregate into `_tickState.pending`,
  and lets the existing `commit()` flush everything in a single
  full-file rewrite (v1.0 one-write-per-tick invariant preserved).

### Behavior

- Three of the four `m_acc*` scopes participate: `session` /
  `project` / `model`. `ccsession` is intentionally excluded
  — it tracks one claude-code process invocation, so historical
  JSONL is semantically unrelated and replaying would mask
  process restarts. The regression-reset mark at Stage 1
  remains the only legitimate `ccsession` zero.
- The recovered aggregate is `mark()`-ed into `pending` so
  `setAvg` additively merges the current tick's delta on top
  of the recovered base. On invalid ticks (cwd+sessionId
  known but apiMs<=0), the recovered base is flushed standalone
  via `commit()` without this tick's delta — the historical
  truth is preserved without pollution from a bad row.
- `startAt` on the replayed slot is `min(row.startAt || row.at)`
  across matching rows. All-null / all-zero / empty JSONL →
  the natural cold-start `Date.now()` stamp from `setAvg`'s
  first-write branch fires instead. Mixed → `min(finite>0)`.
- Diagnostics: when `TOPGAUGE_DIAGNOSTICS_ENABLE=1`, a
  `replay-acc-init` row is appended to
  `state/<projectHash>/diagnostics.jsonl` per cold-slot
  replay (scope + aggregated counts + startAt). Default off
  → no row.
- Warm slots (where `startAt != null`) short-circuit the
  replay before any JSONL read, so a confirmed value is
  preserved across the wipe-and-rebuild boundary.

### Files

- `src/status-store.ts` — new `replayAccKey` (scope-to-slot
  key resolver), `replayAccInit` (the cold-slot JSONL replay
  helper, returns a `TickStatusValue` ready to `mark()`),
  `readReplaySamples` (per-scope I/O dispatcher), and
  `readProjectSamples` (mirrors `readAllSamples` but only
  walks one `projectHash` subdir — `TokenSample` doesn't
  carry `projectHash`, so the project-scope boundary is
  enforced at the I/O level). New Stage 0 in `processTick`
  (after the `normalizeTick` snapshot is set, before the
  existing Stage 1 regression-reset).
- `src/status-store.replay.test.ts` — NEW. 13 tests covering
  the cold-slot replay matrix: cold session / project /
  model replay, warm-slot short-circuit, empty JSONL fall-
  through, ccsession exclusion, invalid tick gate, regression
  tick interaction, startAt edge cases (all-null / all-zero
  / mixed), and diagnostics env-gate.
- `CHANGELOG.md` — this entry.

## v0.8.27

### Added

- `m_sumStartTime` / `m_sumEndTime` now honor `|align|true`.
  When the inline arg is set AND the matching ctx Window
  (fiveHour or weekly) ships `resetStartAt` / `resetAt`, the
  rendered timestamps reflect the plan window open/close
  — the authoritative "when did this window open / close"
  answer — instead of the empirical min/max of captured
  samples. Pairs cleanly with v0.8.26+ bare modules
  (where `|align|false` is now the default): opt into the
  plan-anchored boundary by passing `|align|true` through
  the inline form or an outer `m_template|<key>|align|true`.

### Behavior

- `m_sumStartTime|window|5h|align|true` →
  `start:<resetStartAt formatted>` when ctx.fiveHour ships
  `resetStartAt`. Falls back to empirical `min(row.startAt)`
  when the Window has no `resetStartAt` (plan anchor
  unavailable, not absent). Empty window (`agg.rows === 0`)
  still renders `start:n/a` placeholder.
- `m_sumEndTime|window|5h|7d|align|true` →
  `end:<resetAt formatted>`. `resetAt` is unconditional in
  `slotsToWindow`, so the anchor branch fires for every
  aligned scan in practice.
- `|align|false` (v0.8.26+ default for bare m_sum*) keeps
  the empirical min/max reading even when the plan anchor
  is available. Align is opt-in, never forced.

### Files

- `src/render.ts` — bare + inline renderers of
  `m_sumStartTime` / `m_sumEndTime` consult
  `filter.alignActive` + `ctx.fiveHour` / `ctx.weekly`
  before the empirical `agg.firstAt` / `agg.lastAt`
  fallback.
- `src/render-tokens.test.ts` — 4 new tests pin the
  behavior: 5h `align|true` honors resetStartAt, 7d
  `align|true` honors resetAt, `align|false` keeps
  empirical even when the anchor is available,
  `align|true` falls back to empirical when the Window
  ships no anchor.

## v0.8.26

### Changed

- Bare `m_sum*` modules (`m_sumTokenIn` / `m_sumTokenOut` /
  `m_sumTokenCachedIn` / `m_sumTokenTotalIn` / `m_sumApiMs` /
  `m_sumTokenHitRate` / `m_sumTokenInSpeed` /
  `m_sumTokenOutSpeed` / `m_sumApiCalls` /
  `m_sumStartTime` / `m_sumEndTime`) now default
  `|align|false` instead of `|align|true`. Without the inline
  arg the scan reads the trailing **wall-clock** window
  `[nowMs - N, nowMs]`, matching "last 5h / 7d of activity".
  Inline callers who want the plan-aligned refill bucket
  `[resetStartAt, resetStartAt + duration]` must opt in with
  `|align|true`. The behavior is unchanged when ctx.fiveHour /
  weekly Window doesn't ship a resetStartAt, or when
  `window="all"` — both already collapsed to wall-clock
  before this change.

### Files

- `src/render.ts` — `parseWindowScope` `alignRaw ??` default
  flipped `true` → `false`; `ALIGN_PARAM` doc updated to spell
  out the new default and its narrow scope.
- `src/render-tokens.test.ts` — 2 new tests pin the new default
  for both `bare m_sumTokenIn` and `inline m_sumTokenIn|window|5h|align|false`
  against the same resetStartAt fixture the `align|true` test
  uses, asserting both reads pick up the wall-clock path while
  the existing `align|true` test still gets the aligned bucket.

## v0.8.25

### Added

- `|abs|<true|false>` inline arg on `m_accStartTime` /
  `m_sumStartTime` / `m_sumEndTime`. When `true`, the rendered
  body widens from `HH:MM:SS` (default) to `YYYY-MM-DD HH:MM:SS`
  (sv-SE locale, 24h clock, ASCII-space separator). Default is
  `false` so v0.8.24 renders stay byte-identical after upgrade.
  - Inline form: `m_accStartTime|abs|true|...`,
    `m_sumStartTime|abs|true|...`, `m_sumEndTime|abs|true|...`.
  - Pass-through form: an outer
    `m_template|<key>|abs|true` flips the flag for every
    inner module at once (matches the v0.8.7+ pass-through
    contract used by `scope` / `window` / `model` / `align`).
  - Resolver accepts only literal `true` / `false`; any other
    value (e.g. `abs|yes`) drops the token via the standard
    inline-badarg path. Same discipline as `ALIGN_PARAM`.
- `formatAbsTime(epochMs, opts: { abs?: boolean })` helper
  signature widened. The signature is additive (the second
  arg is optional) — every existing v0.8.24 caller still
  compiles and renders identically.

### Files

- `src/render.ts` — new `ABS_PARAM` schema, three inline-schemas
  extended, six renderer sites updated (3 bare + 3 inline),
  `formatAbsTime` helper widened.
- `src/render-tokens.test.ts` — 6 new tests covering the abs
  helper unit (shape + null/non-finite) and the runtime
  module path (default byte-identical + `abs|true` widens +
  badarg drops + composition with `|color|`).

## v0.8.24

### Added

- `m_accStartTime` / `m_sumStartTime` / `m_sumEndTime` modules.
  `m_accStartTime` reads the ccsession slot's `startAt` (Unix-ms)
  by default and supports `:scope:<session|project|model|ccsession>`.
  `m_sumStartTime` aggregates `min(s.startAt)` over the JSONL
  sample rows; `m_sumEndTime` aggregates `max(s.lastAt)`. Both
  m_sum* modules support the full 5-axis arg surface (`:model:`,
  `:window:`, `:align:`, `:color:`, `:nulldrop:`). Format:
  `HH:MM:SS` local time (sv-SE locale, 24h clock). Default labels:
  `labelStartTime = "start:"`, `labelEndTime = "end:"`.
- `startAt` field on `TickStatusValue` / `AvgSnapshot` — first-write
  instant of the slot (Unix ms), stamped by `setAvg` /
  `bumpDeltaScope` on the first valid write. Refreshed by the
  ccsession regression-reset mark so a Claude Code process restart
  re-opens the window. Legacy rows backfill to `null` (renders
  `start:n/a` placeholder).
- `startAt` / `lastAt` fields on `TokenSample` (JSONL rows).
  `startAt` is the per-session first-tick instant, read-once-per-tick
  from the JSONL head line via the new `resolveFirstTickAt` helper
  (sticky across cc process restarts because the JSONL is the only
  stable per-session state). `lastAt` mirrors the row's `at` for
  self-describing min/max aggregation. Legacy rows backfill to
  `null`; `aggregateSamples` filters them out of the `firstAt`
  roll-up via `Number.isFinite` gate.
- `labelStartTime` / `labelEndTime` in the `labels.*` namespace
  (v0.8.24). New fields in the labels type, defaults in
  `DEFAULT_CONFIG.labels`, and entries in the field allowlist.
- `formatAbsTime(ms)` helper in `src/render.ts` — `HH:MM:SS`
  local time via `sv-SE` locale + `hour12: false` (same idiom
  as `diagnostics.ts:localIso`). Returns `"n/a"` on null /
  non-finite / non-positive inputs.
- `StatAggregate.firstAt` field — min(s.startAt) over filtered
  rows. Defaults to 0 when no row carries a valid startAt.

### Changed

- `validateNormalizedTick` adds a `MAX_SAMPLE_API_MS` (300_000 ms,
  5 min) sanity ceiling on per-tick `apiMs` (inclusive). A single
  pathological stdin reading (clock skew, provider bug, stale
  baseline) can no longer pollute the JSONL sample stream or the
  per-session accApiMs sum. Well above any realistic per-tick API
  call (typically <60s) but below the 10min "pathological" marker.
- `ccsession` regression-reset (`detectRegression` trigger) now
  stamps `startAt: Date.now()` on the reset value, so the very
  first frame after a Claude Code process restart renders the
  post-reset "process clock start" instant (not `"n/a"` → next
  tick).

## v0.8.14

### Changed (BREAKING)

- `statuslineTemplate` is **array-only**. Legacy bare-string
  preset-name values (`"1line"`, `"standard"`, etc., from
  v0.4.0–v0.8.13) auto-migrate to the equivalent `["m_template|_X"]`
  form with a one-shot stderr warning. To silence the warning,
  write the array form directly:
  ```diff
  - "statuslineTemplate": "standard",
  + "statuslineTemplate": ["m_template|_standard"],
  ```
- **Balance-provider default render is now silent.** Pre-v0.8.14,
  `statuslineTemplate: "1line"` on a DeepSeek (BALANCE) provider
  silently fell back to `BALANCE_PRESETS["simple"]`. This
  provider-type-aware fallback is GONE — v0.8.14+ requires explicit
  opt-in:
  ```diff
  - "statuslineTemplate": "1line", // used to render BALANCE_PRESETS["simple"]
  + "statuslineTemplate": ["m_template|_balance_simple|mode|balance"],
  ```
  This matches the project's "user is explicit, framework doesn't
  guess" philosophy (cf. v0.8.13's literal `api:` / `calls:` /
  `in:` / `out:` defaults).

### Added

- Built-in presets are now first-class entries in `lineTemplates`
  with `_`-prefixed keys. Plan: `_1line`, `_simple`,
  `_simple-alone`, `_standard`, `_standard-alone`, `_abundant`,
  `_complete`. Balance: `_balance_simple`, `_balance_simple-alone`.
  Reference them via `m_template|_X` (with optional
  `|mode|plan|balance` to constrain dispatch — default `mode:plan`).
- `m_template`'s `mode` filter is now the explicit
  provider-type-aware dispatch mechanism.
- User `lineTemplates` entries whose names start with `_` and
  collide with a built-in preset are warned + skipped (the
  built-in wins). Use a different key for your own presets.

### Removed

- `PLAN_PRESETS` and `BALANCE_PRESETS` exported constants are
  gone — their contents moved into `DEFAULT_LINE_TEMPLATES` with
  `_`-prefixed keys (and the bodies preserved byte-for-byte).

## v0.8.13

### Added

- Extended `labelFor()` resolver with four new axes
  (`labelApi` / `labelApiCalls` / `labelInSpeed` / `labelOutSpeed`)
  so the apiMs / apiCalls / inSpeed / outSpeed module families are
  independently configurable. Defaults match the v0.8.x literal
  strings (`api:` / `calls:` / `in:` / `out:`) so existing renders
  stay byte-identical until the user overrides via config.json
  `labels.*`.
- Fixed two pre-existing off-by-one dispatcher skipLen bugs in
  `src/render.ts`: `m_sumTokenInSpeed` was 19 (correct: 18),
  `m_sumTokenOutSpeed` was 20 (correct: 19). Both caused the
  `|nulldrop|false` inline form to silently drop with an
  "unknown lineTemplate module" warning.

## v0.7.0

### Renamed

- Plugin renamed from `tokenplan-usage-hud` to `topgauge-cc` (formal
  product name **ToPGauge-CC**). Every user-visible identifier is updated:
  - Package id (`package.json.name`), plugin name
    (`.claude-plugin/plugin.json.name`), marketplace id
    (`.claude-plugin/marketplace.json.name`).
  - Slash command prefix: `/tokenplan-usage-hud:<verb>` →
    `/topgauge-cc:<verb>`.
  - Env-var namespace: `TOKENPLAN_*` → `TOPGAUGE_*`
    (`TOKENPLAN_UPSTREAM` → `TOPGAUGE_UPSTREAM`,
    `TOKENPLAN_UPSTREAM_CMD` → `TOPGAUGE_UPSTREAM_CMD`,
    `TOKENPLAN_DIAGNOSTICS_ENABLE` → `TOPGAUGE_DIAGNOSTICS_ENABLE`).
  - `settings.json.statusLine._tokenplan_managed` marker →
    `_topgauge_managed`.
  - Internal state-dir path: `~/.claude/plugins/tokenplan-usage-hud/state/`
    → `~/.claude/plugins/topgauge-cc/state/`.
  - Stderr banner: `tokenplan-usage-hud:` → `topgauge-cc:`.
  - Plugin cache glob: `plugins/cache/tokenplan-usage-hud/tokenplan-usage-hud/*/`
    → `plugins/cache/topgauge-cc/topgauge-cc/*/`.
  - GitHub URLs: `github.com/cwf818/tokenplan-usage-hud` →
    `github.com/cwf818/topgauge-cc`. README badges, install/upgrade
    recipes, and `gh repo create` instructions all updated.

### Preserved (intentional)

- Provider-string constants — `minimax`, `MiniMax`, `MiniMax-M3`,
  `minimaxi.com`, `Quota`, `BALANCE`, `DeepSeek`, `deepseek`,
  `/v1/token_plan/remains`, `/user/balance` — are NOT renamed. They
  reference external API surfaces and are stable contract.
- Repo directory `D:\WorkSpace\tokenplan-usage-hud` is NOT renamed on
  disk in this release; only the plugin's user-visible identifiers
  change.

### Migration paths

- `scripts/install.sh` performs a **one-shot state-dir migration**: if
  `~/.claude/plugins/tokenplan-usage-hud/state/` exists and
  `~/.claude/plugins/topgauge-cc/state/` does NOT, the legacy tree is
  copied forward (preserving `upstream-cmd.sh`, `upstream-cmd.txt`,
  `cache.json`, `diagnostics.jsonl`, and any `<projectHash>/` token-sample
  sub-dirs). Idempotent: a re-run is a no-op. The legacy tree is left
  in place for inspection.
- `scripts/uninstall.sh` and `scripts/dev-uninstall.sh` perform a
  **one-release legacy dual-strip**: they recognize BOTH
  `tokenplan-usage-hud` and `topgauge-cc` (cache dirs, marketplace
  dirs, state dirs, `enabledPlugins` keys, `_tokenplan_managed` AND
  `_topgauge_managed` markers in `settings.json`). Existing pre-rename
  installs uninstall cleanly.
- `scripts/clean.sh --purge-runtime` and `scripts/clean-cache.sh` also
  walk both the new and the legacy cache/state roots so users get a
  fully purged system after one invocation.
- `scripts/test-install.sh` has a new regression test
  `--legacy one-shot state migration (v0.7.0: tokenplan-usage-hud -> topgauge-cc)`
  asserting the install script copies the legacy state dir forward
  when upgrading.

### Internals

- `scripts/uninstall.sh` was refactored to drive every dir / key
  lookup from a single `PLUGIN_NAMES=("topgauge-cc"
  "tokenplan-usage-hud")` array so the legacy dual-strip lives in one
  place rather than being sprayed across the script.
- `scripts/install.sh` and `scripts/lib/edit-settings.mjs` updated to
  write the new marker / cache glob / env-var wiring. The marker in
  `settings.json` becomes `_topgauge_managed`.
- All shell-script test fixtures (`scripts/test-install.sh`,
  `scripts/test-edit-settings.sh`, `scripts/test-clean-cache.sh`) and
  Node-side tests (`src/diagnostics.test.ts`,
  `src/render-tokens.test.ts`, `src/dispatch.test.ts`,
  `src/index-parse.test.ts`) were updated for the new names. The repo
  field in the captured `src/__fixtures__/stdin.real.json` fixture
  pins `name: topgauge-cc` to match the renamed plugin.

## v0.6.0

### Added

- Three optional per-provider HTTP request overrides on `ProviderEntry`:
  - `AUTHENTICATION_KEY` — Bearer token sent in the `Authorization` header.
    Always wins over `process.env.ANTHROPIC_AUTH_TOKEN` when present;
    no env fallback.
  - `METHOD` — closed enum (`"GET" | "POST" | "PUT" | "PATCH" |
    "DELETE"`). Defaults to `"GET"`. Bad values drop the whole entry
    (strict).
  - `BODY` — static JSON object sent as the request body. Only
    meaningful when `METHOD` is not GET. Plain object required;
    arrays / strings / numbers drop just the field (lenient). No
    template placeholders.
- `fetchBalance` accepts the same `provider` 4th argument as
  `fetchQuota` so BALANCE providers can declare the same overrides
  symmetrically. The dispatcher in `src/providers.ts` now passes the
  entry to both fetchers.
- `src/index.ts` no longer short-circuits the whole tick when
  `ANTHROPIC_AUTH_TOKEN` is empty — the fetcher decides whether to
  make the call (it sees `entry.AUTHENTICATION_KEY`). This makes per-provider
  credential rotation work in CI / sandboxed environments that don't
  carry the env var.

See `README.md § HTTP request overrides` for the worked example and
the strict-vs-lenient validation rules.

## v0.4.0

### Added

- 16 new statusline modules reading the captured Claude Code stdin
  payload (verbatim from `/statusline`'s stdin pipe):
  - `m_session`, `m_model`, `m_effort`, `m_repo`, `m_ccVersion` —
    session identity / metadata.
  - `m_sessionDuration`, `m_sessionApiDuration` — elapsed wall-clock
    duration in `1d2h3m` format.
  - `m_linesAdded`, `m_linesRemoved` — `+ 3965` / `- 967` style.
  - `m_tokenInTotal`, `m_tokenTotalOut` — session-cumulative input
    / output tokens (replaces the pre-v0.4.0 `m_tokenIn` /
    `m_tokenOut` semantics).
  - `m_contextSize`, `m_contextUsed` — context window size (compact
    form) and used percentage.
  - `m_windowContext` — bar + 5-band-colored percentage, parallel
    to `m_window5h` / `m_window7d`.
- New `src/__fixtures__/stdin.real.json` reference fixture capturing
  the full Claude Code session JSON shape (verified 2026-06-29).
- `TokenSnapshot` widened with new nullable sub-fields
  (`sessionName`, `modelDisplayName`, `effort`, `repo`, `ccversion`,
  `contextWindow`, `cost.totalApiDurationMs`, `cost.totalLinesAdded`,
  `cost.totalLinesRemoved`).
- `RenderContext` widened with `contextWindow: Window | null`
  (synthesized from `tokens.contextWindow.usedPct` for
  `m_windowContext`).
- `:display:used` / `:display:remaining` inline-args override for
  `m_window5h`, `m_window7d`, `m_windowContext`. Scoped to that
  module's bar computation only — does NOT mutate the global
  `display` config field. Accepts `used` / `remaining` verbatim
  (case-sensitive); anything else drops the token and warns once.
  The bare `m_window5h` form is byte-for-byte unchanged (still
  reads the global `display` config). Combine with `:color:` for
  both axes, e.g. `m_window5h:display:remaining:color:yellow`.
- `m_tokenInAvg` / `m_tokenOutAvg` modules — running-average per-API-call
  speed (`sum(current_tokens) / sum(delta_api) * 1000`, where
  `current_tokens` is the per-turn delta `current_usage.*`
  directly, NOT `current - prev`), backed by a per-session
  accumulator in `state/cache.json` (separate key
  `tickAvg:<sessionId>`, distinct from the per-tick `tickSpeed:`
  snapshot). Only valid-API-call ticks contribute
  (`delta_api > 0`); idle ticks don't accumulate. IN and OUT
  don't have to move together (a thinking-only turn adds 0
  input but real output, or vice versa), so we no longer
  require `delta_in >= 0 AND delta_out >= 0` — the contract
  `current_usage.*` is non-negative per-turn delta means
  regressions can't happen. First tick assumes `prev=0` and
  contributes. Like the speed modules, these always render —
  the slot in `lineTemplate.plan` is stable. Optional
  `:color:` override.
- Three per-session running-total modules — `m_totalTokenIn`,
  `m_totalTokenOut`, `m_totalTokenWithCacheIn`. Accumulate
  `current_usage.{input_tokens, output_tokens,
  cache_read_input_tokens}` directly across all
  valid-API-call ticks (`delta(total_api_duration_ms) > 0`;
  first tick assumes `prev=0`). The running totals live in
  the SAME `tickAvg:<sessionId>` cache slot that
  `m_tokenInAvg` / `m_tokenOutAvg` use — single source of
  truth. `AvgSnapshot` is extended with a `sumCache` field;
  both module families fire `setAvg` (idempotent — guarded by
  a per-render `_tickAvgWriteMemo` WeakMap so a template that
  mixes avg + totals + per-API-call modules still accumulates
  each delta exactly once). Always render — the first tick
  contributes (no more `in:0` / `out:0` / `cache:0` sentinels
  on the first tick), and idle ticks don't accumulate
  (`deltaApi <= 0`). `m_totalTokenWithCacheIn` renders
  `cache:--` when stdin lacks `current_usage.cache_read_input_tokens`
  (honest "data unavailable" signal, distinct from "no
  contributions yet"); otherwise `cache:<compact>`. Optional
  `:color:` override. The dispatcher lists
  `m_totalTokenWithCacheIn:` BEFORE the shorter
  `m_totalTokenIn:` / `m_totalTokenOut:` prefixes for
  prefix-shadowing safety (no actual shadowing — chars at
  index 17 differ — but listed first defensively).

### Changed

- `m_tokenIn` and `m_tokenOut` now read **`current_usage.{input,
  output}_tokens` directly as the per-turn delta** (Claude
  Code's session JSON already reports per-turn contribution —
  verified against the `stdin.real.json` fixture: `current_usage.
  input_tokens=140` while `total_input_tokens=126860`). The
  only subtraction is `delta(cost.total_api_duration_ms) > 0`
  — when API time grew this turn, the per-turn delta is
  valid. **No more `current - prev` subtraction**: the value
  IS the per-turn delta. The prev cache is only used to
  measure API time growth, not to compute token deltas. These
  modules **always render** — when no API call landed between
  ticks (idle tick with `delta(totalApiDurationMs) <= 0`) the
  chunk is **`in:0`**. First tick of a session, session change,
  or any cache miss now assumes **`prev.apiMs=0`** so the
  first turn still contributes its per-turn delta (no more
  `in:0` sentinel on first tick). For session-cumulative
  totals, use `m_tokenInTotal` / `m_tokenTotalOut` (or the
  existing `m_tokenTotal` / `m_tokenSession` for the
  in+out+cache total).
- `m_tokenInSpeed` and `m_tokenOutSpeed` compute the per-API-call
  throughput as **`current_usage.input_tokens /
  delta(total_api_duration_ms) * 1000`** (the per-turn delta
  is `current.*` directly, not `current - prev`). The renderer
  caches the previous tick's `totalApiDurationMs` (keyed by
  `sessionId`, disk-shadowed to `state/cache.json`). The
  direction-specific zero-rejection gate that previously
  collapsed `deltaIn == 0` to `-- t/s` is **gone** — a
  thinking-only turn that adds 0 input tokens but a real
  output rate shows the truthful `0.0 t/s` rate, not
  `-- t/s`. (A zero-delta gate conflated "API call landed but
  added nothing" with "no data / no API call" — a confusion
  the new contract removes.) **Always render** — only a true
  `deltaApi <= 0` (no API call) renders as `in:-- t/s`.
  First tick assumes `prev=0` and contributes its rate. The
  slot in `lineTemplate.plan` stays stable.
- `m_tokenInSpeed` / `m_tokenOutSpeed` cache the **last
  ACTIVE-tick tps per session** (key
  `tickSpeedDisplay:<sessionId>`, separate from
  `tickSpeed:<sessionId>`). On an idle tick
  (`deltaApi <= 0`), the module falls back to the cached tps
  and renders in **STALE_COLOR** (gray) — so the user reads
  the gray as "this is a stale measurement from a previous
  API call, not a real one now", and the speed module stops
  blinking through `-- t/s` between real measurements during
  fast statusline ticks. Idle ticks do NOT overwrite the
  cache — the cached value is "the last thing I measured"
  until the next active tick replaces it.
- New `:color:scale` inline-args value for `m_tokenInSpeed` /
  `m_tokenOutSpeed` (and the bare default — no `:color:` is
  now scale-aware). The scale maps tps to one of 5 colors
  (bright green / dark green / yellow / orange / red, faster
  = greener), with the OUT thresholds at `[10, 20, 40, 80]`
  t/s and the IN thresholds at `[50, 100, 200, 400]` t/s
  (input streams naturally run ~5× hotter than output).
  Thresholds are config-driven under
  `tokenFormat.speedScaleBands = { in, out }` — defaults
  match the values above. `:color:red` (or any other named
  shortcut / raw SGR) overrides scale on the **active**
  tick only — idle ticks always render STALE_COLOR
  regardless of `:color:` (gray is the canonical "inactive"
  signal, and inverting the override on idle ticks would
  conflate "stale measurement" with "this turn was actually
  this slow"). The MODULES path (bare `m_tokenInSpeed`)
  also defaults to scale, so the bare form and
  `:color:scale` are byte-equivalent.
- `m_ccversion` renamed to `m_ccVersion` for consistency with
  the other camelCase metadata modules (`m_sessionDuration`,
  `m_windowContext`, etc.). Module key, schema, renderer,
  dispatcher branch, tests, and docs updated. The bare
  `m_ccversion` token is no longer recognized and will hit the
  standard "unknown lineTemplate module" warn path.
- `parseTokenSnapshot` is shape-tolerant on the new `effort` field
  (accepts both bare strings and `{ level: "high" }` objects) and
  on the new `workspace.repo` field (preserves the sub-object even
  when some sub-fields are null, so the renderer can decide whether
  to render the partial join).
- `:nulldrop:<true|false>` inline-args parameter on every `m_*`
  module. **Default = `:nulldrop:false` (force placeholder when
  data is null)** so the slot stays in `lineTemplate.plan` and
  the line layout doesn't shift when stdin lacks a field (e.g.
  after `/clear` starts a new session and `used_percentage` is
  missing). `:nulldrop:true` opts OUT of the placeholder and
  preserves the v0.3.x drop-on-null behaviour for users who
  prefer the slot to disappear. Placeholder shape per family:
  pure-number → `<prefix>n/a` (e.g. `ctx:n/a`, `in:n/a`),
  number+unit → `-- <unit>` (e.g. `5h:--`, `+ --`, `- --`,
  `in:-- t/s`), gauge → `░░░░░░░░ 0%` (or `▓▓▓▓▓▓▓▓ 100%` in
  remaining mode), bare-string → `n/a`. The default color is
  `STALE_COLOR`; `:color:<c>` overrides as with every other
  inline module. The bare MODULES path is **unchanged** — bare
  `m_ctx` / `m_windowContext` / etc. still drop on null, since
  pre-v0.4.0 configs that listed bare tokens must not silently
  change behaviour. To opt a bare-style config into the
  placeholder, add the trailing colon (`m_ctx:`) — the inline
  form defaults to placeholder. Modules whose inline renderers
  already force a placeholder via the always-render rule
  (`m_tokenIn` / `m_tokenOut` / speed / avg / totals / `m_token5h`
  / `m_token7d`) accept `:nulldrop:` for schema uniformity but
  the parameter has no effect on their output.

### Changed (BREAKING)

- **`lineTemplate` config field is REMOVED in v0.4.0** — replaced
  by two new top-level fields:
  - **`lineTemplates`** — a registry of reusable template fragments.
    Values are token arrays. Allowed tokens: any `m_*` module
    **EXCEPT `m_template`**, plus `s_*` separators. Keys are
    user-chosen. Default-merged with the legacy `{ plan, balance }`
    shape so existing internal lookups keep working.
  - **`statuslineTemplate`** — the actual template the renderer
    walks. Accepts **a fixed preset name** (e.g. `"1line"`,
    `"simple"`, `"standard"`, `"abundant"`, `"complete"`,
    `"simple-alone"`, `"simple-alone"` for balance) **OR a raw
    token array**. Array form may include `m_template:` tokens
    and any other `m_*` / `s_*`. String form does NOT accept
    arbitrary `lineTemplates` keys — only the fixed preset names.
  - **Migration is a HARD BREAK** — the loader emits one
    `tokenplan-usage-hud: config lineTemplate is removed in v0.4.0`
    warning per config load and ignores the legacy field
    entirely. There is no auto-promotion of `lineTemplate.plan`
    → `lineTemplates.plan`. v0.3.x users who customized the
    `lineTemplate` block must rename it to `statuslineTemplate`
    (string preset or raw array) and move reusable fragments to
    `lineTemplates`. v0.4.0's default config produces the same
    rendering as v0.3.6's default — only customized configs
    require manual migration.

### Added (v0.4.0+)

- New `m_template:<key>[:mode:<plan|balance>][:nulldrop:<bool>]`
  inline-args module — expands the registered
  `lineTemplates[key]` fragment into the current render. Mode
  filter (`mode:<plan|balance>`, default `plan`) hides the
  chunk on the wrong provider type, so a single
  `lineTemplates` key can render differently for plan vs
  balance providers (e.g. share the `Usage:` / `Balance:`
  label, customize the body). Nesting is impossible: the
  loader strips `m_template:` tokens from any `lineTemplates`
  entry at load time. Missing key → warns + drops. Mode
  mismatch → silent drop (no warn). `:color:` is silently
  ignored on `m_template`; put `:color:` on the inner
  modules if needed.

### Changed (BREAKING) — Per-Project State Layout

The plugin's runtime state directory is now partitioned by
project, so multiple Claude Code sessions running in
**different** project directories never contend over the same
files. Assumption: one project directory → one Claude Code
session; multi-Claude workflows come from opening the project
in different directories.

**New layout** under
`~/.claude/plugins/tokenplan-usage-hud/state/`:

```
state/
  upstream-cmd.sh              # top-level — install/uninstall dependency, NOT touched
  upstream-cmd.txt             # top-level — install/uninstall dependency, NOT touched
  config.json                  # top-level — install/uninstall dependency, NOT touched
  <projectHash>/               # e.g. d--workspace-tokenplan-usage-hud
    cache.json                 # disk-shadowed TTL cache (per-project key isolation)
    diagnostics.jsonl          # append-only warning/error log (per-project)
    <sessionId>.jsonl          # token samples (was state/token-samples/<hash>/<sid>.jsonl)
```

- `cache.json`, `diagnostics.jsonl`, and token-samples have
  moved **off the top-level** and into
  `state/<projectHash(cwd)>/`. The `projectHash(cwd)` helper
  (lowercased, `\/: ` → `-`, control chars stripped, capped at
  80 chars) was already exported from `src/token-store.ts` —
  every per-tick IO path now derives its path from the cwd in
  `TokenSnapshot`.
- Cache key isolation across projects: `src/render.ts` prefixes
  every cache key with `<projectHash>:<key>`. The cache module
  API itself is unchanged — the prefix lives in render.ts so
  the disk format stays single-keyed and cache tests still pass
  with no mocks. Per-project `cache.json` files never share
  keys.
- Diagnostics: `append(level, source, msg, now?, cwd?)` /
  `readLatest(level, cwd?)` / `diagnosticsPath(cwd?)` gained
  an optional `cwd` argument. When omitted or null, writes fall
  back to the legacy top-level `state/diagnostics.jsonl` so
  plugin-level errors (e.g. config-parse warnings) still have
  somewhere to go. `src/index.ts` passes `tokens?.cwd ?? null`.
- Token samples: `sampleFilePath` now builds
  `state/<projectHash(cwd)>/<sessionId>.jsonl` directly (the
  intermediate `token-samples/` directory is gone). The
  `m_token5h` / `m_token7d` modules continue to call
  `readSamples(t.cwd, ...)` and get per-project isolation
  transparently.

**Migration for users upgrading from v0.4.0–v0.4.<n-1>**:
legacy top-level `cache.json` and `diagnostics.jsonl` are NOT
auto-migrated (no project information is recoverable from
them — start fresh). Legacy
`state/token-samples/<projectHash>/<sessionId>.jsonl` files
are also not auto-migrated on tick (would cost 3–10ms IO per
tick for time-decaying data). To preserve old token samples,
run the bundled one-shot helper:

```bash
bash scripts/migrate-state.sh         # actually move
bash scripts/migrate-state.sh --dry-run  # preview only
```

It `mv -n`s each
`state/token-samples/<hash>/<sid>.jsonl` →
`state/<hash>/<sid>.jsonl`, then `rmdir`s the empty project
subdirs and the empty `token-samples/` parent. Idempotent.

**Cleanup**: `clean.sh --purge-runtime` now walks every
`state/*/` subdir and removes its `cache.json`,
`diagnostics.jsonl`, and `<*.jsonl>` files. It still cleans
the legacy top-level `cache.json` / `diagnostics.jsonl` and
the `state/token-samples/` tree (one-shot upgrade path for
users who don't bother with `migrate-state.sh`). Top-level
`upstream-cmd.{sh,txt}` and `config.json` are NEVER purged —
install/uninstall depends on them.

`scripts/uninstall.sh` is unchanged at the code level — the
existing `rm -rf "$STATE_DIR"` is naturally compatible with
the per-project layout.

## v0.3.6

- `m_quote` module: numeric time format for `:freq` inline-args.
