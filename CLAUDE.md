# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code statusline plugin (`creditgauge`, formal name **CreditGauge-CC**) that renders **MiniMax token-plan usage** (5-hour and weekly windows) **or DeepSeek account balance**, picked by `ANTHROPIC_BASE_URL`. The plugin ships its own installer (`scripts/install.sh`) that hooks into Claude Code's `statusLine` slot and (optionally) chains any pre-existing statusline (e.g. `ccstatusline`, `claude-hud`) as the upstream. When `ANTHROPIC_BASE_URL` does not point at a supported provider, the plugin hides itself and passes upstream output through unchanged.

The plugin is shipped as a **single-plugin marketplace**: the repo root IS the marketplace, and `.claude-plugin/plugin.json` declares the plugin. Install with `/plugin marketplace add cwf818/creditgauge` then `/plugin install creditgauge@creditgauge`, then run `/creditgauge:install` to wire it into `settings.json`. Uninstall with `/creditgauge:uninstall` (a self-contained cleanup that works even after the cache and marketplace are gone).

**v1.0.0** — Renamed from `topgauge` to `creditgauge` (hard cut, no compat shim). Full mapping in CHANGELOG; provider strings (`minimax` / `MiniMax` / `DeepSeek` etc.) are unchanged.

**v0.7.0** — Renamed from `tokenplan-usage-hud` to `topgauge` (state-dir migration + legacy dual-strip one release).

## Commands

```bash
npm install          # install dev deps (esbuild, typescript, tsx, @types/node)
npm run typecheck    # tsc --noEmit
npm test             # node --test via tsx (1182 tests across api/render/cache/composition, ~3.8s)
npm run build        # esbuild → dist/index.js (single self-contained ESM bundle, target=node18)
npm run dev          # esbuild --watch
```

There is no separate `lint` step; `typecheck` covers it. Tests run with built-in `node:test` + `tsx` — no vitest/jest dependency.

## Architecture

```
src/
  index.ts            # entry — stdin drain, provider dispatch, cache, render, compose, loadConfig()
  types.ts            # Provider union + transport-free config/data types
  api.ts              # dynamic plugin loader + canonical Quota/Balance exports
  plugins/data.ts     # plugin ABI and canonical Quota/Balance shapes
  plugins/parsers.ts  # built-in field-mapping parsers
  plugins/minimax/    # standalone Quota plugin source
  plugins/deepseek/   # standalone BALANCE plugin source
  # v0.8.36+ — m_windowMemUsage is the RAM-usage sibling of
  # m_memUsage (which renders absolute bytes "Mem:X.XG/Y.YG" as a
  # two-tone string: the used chunk is band-colored via
  # colorFor(pct, "used"), only the prefix + total keep the module's
  # fixed cyan tint). m_windowMemUsage renders a bar+percent chunk
  # (parallel of m_windowContext) — `▓▓▓▓▓░░░ 62%` — by wrapping
  # getMemUsage()'s 0..100 ratio in a synthetic Window and routing
  # through formatOneChunk / formatOneChunkColored. The value color
  # is driven by colorFor(pct, "used") so thresholds.percentBands
  # drives the hue. NO label prefix. Wired into the standard preset
  # via the mem_info fragment (m_template|mem_info).
  render.ts           # v1.0 READ-ONLY against status-store's per-tick pending map: pctBar + ANSI color thresholds + renderProviderLine (sole public entry; the legacy formatLine / formatBalanceLine shims were dropped in v0.9.x); NO setAvg/setPrevTick/setLastSpeed calls (those live in status-store.ts)
  status-store.ts     # v1.0 per-tick state owner — beginTick / processTick / mark / setAvg / setPrevTick / setLastSpeed|ApiMs|TokenHitRate / computeAndCacheTickDeltaPure / getDeltaForRender / commit; owns ALL writes to the in-memory pending store + the single commit() flush to state/<projectHash>/state.json + the append-only JSONL samples
  cache.ts            # TTL + stale-on-error (Map<key, {at, value}>) — TTL passed in by index.ts from configStore
  config.ts           # config loader/store and provider facade
  config.providers.ts  # provider defaults, type validation, effective mappings
  config.template.ts   # line-template defaults and template-only types
  composition.ts      # reads CREDITGAUGE_UPSTREAM env, prepends (preserving ANSI/multi-line) and appends line
  __fixtures__/       # quota.real.minimax.json, balance.real.json, balance.multi.json, stdin.real.json, …
  session-parse.ts    # parseTokenSnapshot — stdin JSON → TokenSnapshot (extracted from index.ts so unit tests don't drag index side effects)
  *.test.ts           # node:test unit tests
.claude-plugin/
  plugin.json         # plugin manifest (name, version, commands, homepage)
  marketplace.json    # single-plugin marketplace wiring
commands/
  install.md          # /creditgauge:install slash command (Pattern B2 — loader-executes-script via `!`-fenced block + ${CLAUDE_PLUGIN_ROOT}; scoped allowed-tools)
  uninstall.md        # /creditgauge:uninstall slash command (Pattern B2)
  clean.md            # /creditgauge:clean slash command (Pattern B2)
  clean-cache.md      # /creditgauge:clean-cache slash command (Pattern B2)
  clean-journal.md    # /creditgauge:clean-journal slash command (Pattern B2)
  reset.md            # /creditgauge:reset slash command (Pattern B2)
  config.md           # /creditgauge:config slash command (Pattern B2)
scripts/
  wrapper.sh          # bash wrapper: CREDITGAUGE_UPSTREAM_CMD → CREDITGAUGE_UPSTREAM → us
  install.sh          # settings.json patcher (install/restore/dry-run; uninstall is its own command in v0.9.x+)
  uninstall.sh        # self-contained uninstaller (used by :uninstall and dev:uninstall)
  clean.sh            # trim old .bak.<ts> files, keeping only the most recent per file
  clean-cache.sh      # remove stale plugin-cache version dirs, keeping only the newest
  clean-journal.sh    # remove old state/<projectHash>/*.jsonl journal files by age or --all
  config.sh           # read/modify runtime config (statuslineTemplate preset switch, upstream chain toggle)
  reset.sh            # wipe cache.json + state.json + cache.stat.json for the current project only
  migrate-state.sh    # legacy state/token-samples/<hash>/ → state/<hash>/ migration helper
  dev-uninstall.sh    # DEV-ONLY thin shim → exec uninstall.sh
  lib/edit-settings.mjs # ESM helper used by install.sh
  lib/edit-config.mjs   # ESM helper used by config.sh
  lib/journal.mjs       # install-journal read/write helper used by uninstall.sh
  lib/project-hash.sh   # shared projectHash(cwd) helper for shell scripts
  test-*.sh           # isolated-tmpdir shell regression tests (install/uninstall/edit-settings/clean-cache/reset/config/rename-consistency)
settings.example.json # template (NEVER commit a real settings.json)
```

### How it runs

Claude Code's `statusLine.command` spawns a child process that reads a session JSON from stdin and writes statusline text to stdout. Per-turn invocation — the plugin must be fast and never block.

1. `statusLine.command` (written by `scripts/lib/edit-settings.mjs` `write-managed` op) is a `bash -c '…'` snippet that, at invocation time, `ls -d`s every directory under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/creditgauge/creditgauge/*/`, sorts by version (`sort -t. -k1,1n …`), tails the highest, and execs `scripts/wrapper.sh` from that `plugin_dir`. Same pattern claude-hud uses. This makes the command **version-independent** — when `/plugin install` rolls the cache forward (0.2.5 → 0.2.6), the existing `statusLine` keeps working without re-running `install.sh`. The command then optionally runs the bash script at `$CREDITGAUGE_UPSTREAM_CMD` (so the user can compose with another statusline, e.g. `ccstatusline` or `claude-hud`), captures its stdout into the `CREDITGAUGE_UPSTREAM` env var, then execs `dist/index.js` forwarding stdin. If `CREDITGAUGE_UPSTREAM_CMD` is unset, `CREDITGAUGE_UPSTREAM` is empty and this plugin becomes the sole statusline. Note: `CREDITGAUGE_UPSTREAM_CMD` is an **absolute path** to a bash script (a shebang + `exec bash -c '...'` wrapper written by install.sh), not a shell command line — older v0.1.10–v0.1.11 used `bash -c` against the path and silently failed; v0.1.12 runs it as a script (`bash "$CREDITGAUGE_UPSTREAM_CMD"`).
2. `src/index.ts` reads stdin, matches `ANTHROPIC_BASE_URL` against `config.json.providers`, and dispatches through `src/api.ts` to a dynamically imported built-in or user plugin. The selected provider's `AUTHENTICATION_KEY` overrides `process.env.ANTHROPIC_AUTH_TOKEN`.
3. Plugins fetch and parse their own upstream responses. They return the canonical `Quota` or `Balance` shape through the shared `fetchAccountCredit(authenticationKey, context?)` ABI. Every plugin — bundled (`minimax` / `deepseek`) or user-written — lives under the single `query_plugins/<id>/` layout. Resolution order: `~/.claude/plugins/creditgauge/query_plugins/<id>/index.{js,mjs}` (user-installed / user-overridden, silently wins — no config flag, no stderr warn, no `diagnostics.jsonl` row) then `<package>/query_plugins/<id>/index.js` (the bundled copy). `install.sh` seeds the bundled `minimax` / `deepseek` into the user dir on every (re-)install (no-clobber: a user file at the same id is never overwritten). The MiniMax plugin's response parser accepts two shapes:
   - **Real shape** (verified against `https://www.minimaxi.com/v1/token_plan/remains` on 2026-06-24): `{ model_remains: [{ model_name, current_interval_remaining_percent, current_weekly_remaining_percent, start_time, end_time, weekly_start_time, weekly_end_time, … }, …], base_resp: { status_code } }`. We pick the entry with the **lowest interval remaining %** as the source of truth (the most-active model). `start_time`/`end_time` (and their weekly counterparts) populate `Window.resetStartAt` and `Window.resetDurationMs` so the renderer can pick a window-fill-aware reset arrow.
   - **Legacy/fallback shape**: `{ data: { five_hour: { remaining, limit }, weekly: { remaining, limit } } }` — for any provider that returns the simpler schema (no start fields → reset arrow falls back to `resetArrows[0]`).
4. Cache: `src/cache.ts` holds a single 60-second TTL entry. On fetch failure it returns the stale value so the statusline doesn't blank.
5. Render: `src/render.ts` emits a single compact line `Usage: ▓░░░░░░░ 9% 🕔4h47m·5h · ▓▓░░░░░░ 25% 🕔2d8h·7d`. Layout: a single mode label prefix (`Usage:` or `Remain:`), then per-window `<bar> <coloredN%><RESET> <glyph><countdown>·<windowLabel>` segments joined with ` · `. When the window has no reset time (DeepSeek, legacy), the segment renders as ` <windowLabel>` (no arrow/countdown). Sub-minute remaining renders with second precision (`47s`) by default (`timeFormat.minUnit: "s"`); set `timeFormat.minUnit: "m"` to collapse sub-minute to `<1m`. `m_countdown|valueOnly:true` renders just `<glyph><countdown>` (no `·` window label). Default mode is **`remaining`** (line begins with `Remain:`); set `display: "used"` in `config.json` to switch. 5-band colors (256-color SGR): bright green / dark green / yellow / orange / red, applied to the displayed value at `thresholds.percentBands` boundaries (default `[60, 70, 80, 90]`). The colored chunk is always on the right side of the bar, sized by the displayed value. The reset arrow glyph comes from `stale.resetArrows` (default 12 clock-face emoji `🕛,🕚,🕙,…,🕐`), indexed by `remainingMs / resetDurationMs` so the array reads left-to-right as "few remaining → many remaining" (i.e. ascending by remaining-time ratio). Two glyphs (`["⏳","⌛"]`) reproduce the v0.2.1 hourglass pair; one glyph is static. Providers without start data (DeepSeek, legacy) fall back to index 0.
6. Compose: `src/composition.ts` emits upstream (whatever `CREDITGAUGE_UPSTREAM` contains — possibly multi-line, possibly ANSI-colored) on the leading lines and our line last. It strips only trailing whitespace, injects `\x1b[0m` if upstream ends with an unclosed SGR, and otherwise preserves upstream verbatim.
7. **Token-usage modules (v0.8.0+):** In addition to the tokenplan 5h/7d window display, the plugin reads the session JSON from stdin (verified schema: `context_window.{total_input_tokens, total_output_tokens, current_usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}}`, `cost.total_duration_ms`, `session_id`, `cwd`) and exposes fine-grained modules via `lineTemplate`. Modules are split into three tiers — **per-turn** (stdin-only, zero IO), **acc** (in-memory three-layer accumulator: session / project / model), and **sum/avg** (cross-project JSONL scan, TTL=300s). All modules are opt-in — the default `lineTemplate` does NOT include any token module, so existing v0.7.x configs render byte-identical after upgrade. The `m_tokenTotalIn` invariant (`total_input_tokens == current.input_tokens + current.cache_read_input_tokens`) is verified in `session-parse.ts` and a violation emits a `warning` to `state/<projectHash>/diagnostics.jsonl` (gated by `CREDITGAUGE_DIAGNOSTICS_ENABLE=1`, 60s dedupe).

   **Per-turn modules (stdin-only):**
   - `m_tokenIn` / `m_tokenOut` — current.input / current.output (per-turn deltas)
   - `m_tokenCachedIn` — current.cacheRead
   - `m_tokenTotalIn` — totals.input (session cumulative)
   - `m_tokenInTotal` / `m_tokenTotalOut` — totals.input / totals.output (session cumulative; v0.8.0+ renamed from `m_tokenOutTotal` to sit in the `totalOut` family alongside `totalOut` on-disk / `m_accTokenOut` / `m_sumTokenOut`)
   - `m_tokenInSpeed` / `m_tokenOutSpeed` — session-avg tps (last-active-tick cache, color:scale). v0.8.x R7 — TTL gate disabled: idle ticks always surface the cached value STALE_COLORed, never expire. The `LAST_ACTIVE_TTL_MS` constant in `status-store.ts` is retained for future opt-in via config, but the read path no longer compares against it.
   - `m_apiMs` — per-turn delta of `cost.totalApiDurationMs` formatted as dhms time string with the `labels.labelApiMs` prefix (default `api:`) (e.g. `api:1m`, `api:5s`, `api:<1m`); idle tick → cached value STALE_COLORed (R7; previously the `api:n/a` placeholder after 60s — R9 unified on n/a body to align with the rest of the n/a-family placeholders). Honors `timeFormat.minUnit` (`s` default → second precision; `m` opt-in → sub-minute collapses to `<1m`). Reuses `computeAndCacheTickDelta` memo so prev-tick baseline is shared with `m_tokenIn` / `m_tokenOut` / `m_tokenInSpeed`.
   - `m_contextSize` — totals.input (actual used)
   - `m_contextWindowSize` — context_window.size (capacity; typo preserved)
   - `m_contextUsedPercent` / `m_contextRemainingPercent` — contextWindow.usedPct / .remainingPct
   - `m_tokenHitRate` — per-turn `m_tokenCachedIn / m_tokenTotalIn`. v0.8.x R7 — TTL gate disabled: idle ticks (or stdin lacking cacheRead) surface the cached percentage STALE_COLORed, never expire. Same `LAST_ACTIVE_TTL_MS` retention note as the speed/apiMs modules.

   **Acc modules (three-layer in-memory accumulator, see `status-store.ts`):**
   - `m_accTokenIn` / `m_accTokenOut` / `m_accTokenCachedIn` — per-tick current.input / current.output / current.cacheRead
   - `m_accTokenTotalIn` — per-tick totals.input delta
   - `m_accApiMs` — per-tick cost.totalApiDurationMs delta
   - `m_accApiCalls` — `accApiCount` (count of valid API calls in the chosen scope's slot, renders `calls:N`)
   - `m_accTokenHitRate` — `m_accTokenCachedIn / m_accTokenTotalIn` (renders `hit:N%` — v0.8.x R8 unified the prefix with m_tokenHitRate / m_sumTokenHitRate so all three hit-rate modules share the same `hit:` prefix)
   - Inline args: `:scope:<session|project|model|ccsession>` (default `ccsession` — per-claude-code-process, resets only on totalApiMs regression), `:nulldrop:<b>`, `:color:<c>`.

   **Sum/avg modules (cross-project JSONL scan, TTL=300s):**
   - `m_sumTokenIn` / `m_sumTokenOut` / `m_sumTokenCachedIn` / `m_sumTokenTotalIn` — sum of ctx_in / out / ctx_read / in over the window
   - `m_sumApiMs` — sum of deltaApiMs over the window
   - `m_sumTokenHitRate` — `sumTokenCachedIn / sumTokenTotalIn` over the window
   - `m_sumTokenInSpeed` / `m_sumTokenOutSpeed` — `sumTokenIn / sumApiMs * 1000` (t/s) over the window
   - Inline args: `:window:<dhms|all>` (default all), `:model:<active|name|all>` (default all), `:align:<true|false>` (default true when model=active AND window∈{5h,7d} AND ctx.fiveHour/weekly.resetStartAt is set, else wall-clock fallback), `:nulldrop:<b>`, `:color:<c>`. vX.X.X+ — default provider filter (always on when `ANTHROPIC_BASE_URL` is set) narrows JSONL rows to the current provider. `term` alias no longer requires `modelFilter` to be set.

   **Removed in v0.8.0 (no alias):** `m_token5h`, `m_token7d`, `m_tokenInAvg`, `m_tokenOutAvg`, `m_ctx` (→ `m_contextSize`), `m_cachedTokenIn` (→ `m_tokenCachedIn`), `m_cacheRead` (→ `m_tokenCachedIn`), `m_contextUsed` (→ `m_contextUsedPercent`). The old v0.4.0 ADR at `memory/token-usage-design-adr.md` is marked DEPRECATED — refer to [[token-modules-redesign-v0-8-0]] + [[sum-avg-modules-step2]] for the v0.8.0 contract.

   The append-only JSONL state file `state/<projectHash>/<sessionId>.jsonl` (~120B per tick, ~700KB over 7d) is the data source for sum/avg; per-turn modules read stdin directly. The cross-project scanner `readAllSamples(sinceMs)` walks every `state/<projectHash>/` subdir and concatenates per-row `TokenSample`s.

### Per-Project State Layout (v0.4.x+)

#### Per-tick write invariant (v1.0)

The per-tick pipeline is a two-phase split between **status-store (writes)** and **render (reads)** — owned entirely by `src/status-store.ts`. The pipeline:

1. **`beginTick(cwd, tokens)`** (index.ts:main, right after `diagnostics.setSessionCwd`) — loads `state/<projectHash>/state.json` into a per-tick `pending` map, validates the snapshot (see below), and exposes the pending map for the data-processor to mutate.
2. **`processTick(cwd, tokens, provider)`** (index.ts:main, AFTER provider resolution + `applyProviderOverrides`) — ALREADY-RUNS data-processing pipeline. Runs after provider resolution so the cost computation in `normalizeTick` can use the full 5-layer token price cascade (provider overrides + config.tokenPrices.json). **Always fires**, independent of the user's `lineTemplate`. Even an empty template still has the data-processor run, so the next tick has a baseline. Five stages, gated on the validation flag:
   - **Stage 1** — regression-reset: if `current.totalDurationMs < prev.totalDurationMs` (claude-code process restarted; v0.8.23+ signal with a 120_000 ms cold-start guard), `mark(CCSESSION_KEY, emptyTickStatus())`.
   - **Stage 2** — compute deltas via `computeAndCacheTickDeltaPure(tokens)`; stash on `_state.delta` for render reads (no on-disk side effect).
   - **Stage 3** — `setPrevTick`: writes PREV_TICK_KEY for next tick's baseline.
   - **Stage 4** — `setAvg` for the per-session slot (accIn / accOut / accApiMs / accApiCount / accTotalIn).
   - **Stage 4b** — `setAvg` for the cache track (`accCached` only, when stdin shipped `cache_read_input_tokens`).
   - **Stage 5** — `lastActive:*` marks: `tpsIn`, `tpsOut`, `apiMs`, `tokenHitRate` for the speed/cache/idle-render fallbacks.
3. **`commit()`** (index.ts:main, between `appendSample` and the provider-dispatch branch) — flushes `pending` to `state/<projectHash>/state.json` as ONE full-file rewrite. No-op when:
   - `dirty === false` (nothing was marked — pristine / idle tick);
   - `valid === false` (validation gate failed — see below);
   - `cwd === null` (no per-project dir to write to).
4. **Render** (`buildProviderLine` → `renderTemplate`) — PURE READ against `statusStore.getState().pending[key]`. NO `mark` / `setAvg` / `setPrevTick` / `setLastSpeed` / `setLastApiMs` / `setLastTokenHitRate` calls anywhere in `src/render.ts`. Reads go through `getDeltaForRender()` / `peekAcc` / `peekPrevTick` / `peekLastSpeed` / `peekLastApiMs` / `peekLastTokenHitRate`. mid-render mutations.

**Invariant**: **at most one full-file rewrite per tick** (zero on invalid / idle / pristine ticks). The previous v0.8.x code path fired 5–13 `writeFileSync` calls per active render (`accPrimer`, `accCachePrimer`, `setLastSpeed`, `setPrevTick`); v0.9.x collapsed that to one, and **v1.0 fully decoupled writes from reads** so render is read-only against the in-memory store. No `writeTickStatus` bypass anywhere — the v0.9.x regression-reset "immediate write" exception is gone; in v1.0 the reset is a regular `mark` that flushes alongside every other write via the same single `commit()`.

**Validation gate** (per user contract 2026-07-04): `tokens.totals.tokenTotalOut > 0 AND apiMs > 0` (totalIn dropped; on the first tick with no prev baseline, `apiMs` is back-derived from tokenOut via the legacy v0.4.x formula `tokenOut × 1000 / 50`). Invalid ticks commit nothing — but **`processTick` Stages 3-5 are skipped on invalid ticks**, only Stage 1 (regression-reset) always fires. Writes staged in `pending` (regression reset mark) survive in-memory until the next valid tick when `commit()` flushes them. The renderer can still read pending (which is a clone of the loaded on-disk state) so render never crashes on invalid ticks — it just falls back to placeholder / "0" / last-cached values via the existing `getDeltaForRender` sentinel + `peekLast*` fallbacks.

**`MAX_SAMPLE_API_MS` ceiling + stale-baseline self-heal** (post-v1.2.0): a raw `apiMs` delta (`totalApiMs − prevTotalApiMs`) above the 5-min ceiling means the prev baseline is stale — the statusline wasn't invoked for a long stretch while the cc process's `cost.total_api_duration_ms` (process-cumulative, NOT session-cumulative) kept growing. `normalizeTick` treats that as "no prev baseline": it back-derives `apiMs` from `tokenOut`, so the tick is valid and `setPrevTick` re-anchors the baseline to the current `totalApiMs`; the next tick computes a normal delta. The pathological raw value never reaches the JSONL stream / `accApiMs` sum. Without this the stale baseline never advances (setPrevTick is gated on valid) and every tick stays invalid forever — a permanent lockout that froze `state.json` / samples / `acc*` scopes (yunbisai 2026-08-09). A back-derived `apiMs` that is itself pathological (enormous `tokenOut`) is still rejected by `validateNormalizedTick`'s final ceiling net.

**Module-keyed field naming** (v0.9.x+): `TokenSnapshot` fields are named for their primary reader module — `tokens.current.tokenIn` (read by `m_tokenIn`), `tokens.totals.tokenTotalIn` (read by `m_tokenTotalIn`), `tokens.contextWindow.contextWindowSize` (read by `m_contextWindowSize`), etc. The grouping (`current` for per-turn deltas, `totals` for session-cumulative, `contextWindow` for capacity/percentages, `cost` for stdin `cost.*` fields) is preserved so the `total_input_tokens == input_tokens + cache_read_input_tokens` invariant check in `src/session-parse.ts` still rides on the type-level signal.

### Per-Project State Layout (v0.4.x+)

The runtime state directory is partitioned by project so multiple Claude Code sessions in different project directories never contend over the same files. Assumption: one project directory → one Claude Code session.

```
~/.claude/plugins/creditgauge/
  config.json                  # top-level — user config, sibling of state/ (NOT inside it)
  config.tokenPrices.json      # top-level — per-model token pricing, seeded by install.sh, 5-layer cascade
  state/
    upstream-cmd.sh            # top-level — install/uninstall dependency, NOT touched per tick
    upstream-cmd.txt           # top-level — install/uninstall dependency, NOT touched per tick
    cache.json                 # single top-level disk-shadowed TTL cache, shared across projects via <projectHash>: key prefix
    cache.stat.json            # cross-project sum/avg stat cache (TTL=300s)
    diagnostics.jsonl          # legacy top-level fallback log (cwd=null writes)
    <projectHash>/             # e.g. d--workspace-creditgauge-cc (the actual cwd on this machine)
      state.json               # per-project accumulated tick/acc/prev-tick state (the v1.0 single-commit target)
      diagnostics.jsonl        # append-only warning/error log (per-project)
      <sessionId>.jsonl        # token samples (was state/token-samples/<hash>/<sid>.jsonl)
```

- All per-tick IO paths derive their location from `projectHash(cwd)` (lowercased, `\/: ` → `-`, control chars stripped, capped at 80 chars; exported from `src/status-store.ts`).
- `state/cache.json` is a single top-level file shared across all projects; `src/render.ts` prefixes every cache key with `<projectHash>:` so entries never collide. The cache module API (`get`/`set`/etc.) is unchanged — the prefix is a render-side concern only.
- `src/diagnostics.ts` gained an optional `cwd` parameter on `append` / `readLatest` / `diagnosticsPath`. When omitted or null (e.g. plugin-level config-parse warnings), writes fall back to the legacy top-level `state/diagnostics.jsonl`.
- Legacy migration for users upgrading from v0.4.0–v0.4.<n-1>: legacy top-level `cache.json` / `diagnostics.jsonl` are NOT auto-migrated (no project info recoverable). Legacy `state/token-samples/<projectHash>/<sessionId>.jsonl` files can be preserved with `bash scripts/migrate-state.sh` (or `--dry-run` to preview). Idempotent — `mv -n` is a no-op when the destination already exists.
- `scripts/clean.sh --purge-runtime` walks every `state/<projectHash>/` subdir and removes its `cache.json`, `diagnostics.jsonl`, and `<sessionId>.jsonl` files, plus the top-level `state/cache.stat.json`. Top-level `upstream-cmd.{sh,txt}` are NEVER purged. For the targeted "wipe THIS project's cache.json + state.json + cache.stat.json" case, use `scripts/reset.sh` (`/creditgauge:reset`), which preserves diagnostics + token-sample history. (v0.7.0: also wipes the legacy `plugins/tokenplan-usage-hud/state/` tree left behind by users upgrading from the pre-rename install — both via the projectHash walk and a final whole-subtree wipe.)

### How `:install` / `:uninstall` / `:clean` run

`commands/*.md` are **Pattern B2** slash commands (same shape as `claude-plugins-official/ralph-loop`): the body is a ` ```! ` fenced block that the loader executes directly with the framework-provided `CLAUDE_PLUGIN_ROOT` env var pointing at the installed cache dir, scoped via `allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/<name>.sh:*)`. Arguments typed after the slash command are appended via `$ARGUMENTS`. The LLM sees the script's stdout but does not need to act — this eliminates the "LLM received the prompt but chose to describe instead of executing" failure mode that affected the older Pattern A `commands/install.md` (v0.1.0–v0.2.6, where the markdown was a prose instruction to the LLM). For these three commands there is no LLM reasoning to do — `install.sh` / `uninstall.sh` / `clean.sh` are already idempotent, parameter-complete, and self-verifying.

### How `install.sh` patches `settings.json`

The install script is the **only** way the plugin writes to `settings.json`. The marketplace install copies files into the cache but does not claim `statusLine` (the manifest declares no `statusLine` field). `/creditgauge:install` does the patching:

1. Resolves the active `settings.json` (user-level by default; `--project` for project-level). If `--project` and the file is missing, creates a minimal one (it does NOT copy from user-level).
2. **One-shot state-dir migration (v0.7.0):** if `${CLAUDE_ROOT}/plugins/tokenplan-usage-hud/state/` exists and `${CLAUDE_ROOT}/plugins/creditgauge/state/` does NOT, copies the legacy contents forward (preserving `upstream-cmd.sh`, `upstream-cmd.txt`, `cache.json`, `diagnostics.jsonl`, `<projectHash>/` subtree) so existing token-sample history, diagnostics logs, and preserved upstream commands follow the user. Idempotent and safe to re-run.
3. Reads `statusLine` via `scripts/lib/edit-settings.mjs`:
   - `isOurWrapperCommand(sl.command)` → the wrapper command string points to our cache → already ours, no-op.
   - `command` is some foreign string → back up the file to `settings.json.bak.<ISO-timestamp>`, preserve the original command at `<claude-root>/plugins/creditgauge/state/upstream-cmd.sh` (with shebang) and `<claude-root>/plugins/creditgauge/state/upstream-cmd.txt` (bare command), then rewrite `statusLine` to invoke our wrapper with `CREDITGAUGE_UPSTREAM_CMD=<upstream-cmd.sh>`. The state dir is sibling of `config.json` — STABLE across `/plugin install` rolls and cache wipes, so a future uninstall can always find it.
   - no `statusLine` → just install our wrapper.
4. Seeds `config.tokenPrices.json` if absent (sibling of `config.json`): writes a minimal file with a global `default` price entry so the cost modules (`m_tokenCost` / `m_accTokenCost` / `m_sumTokenCost`) have a fallback value. Existing files are NEVER overwritten — re-running `:install` is a no-op for this step.
5. Rewrites the file via `scripts/lib/edit-settings.mjs`, which preserves the original line ending (CRLF on Windows, LF elsewhere).

`scripts/uninstall.sh` is the uninstall entry point — invoked by `/creditgauge:uninstall` (slash command) and `npm run dev:uninstall` (CLI). It works even when the plugin cache is gone. The restore strategy:
   1. **Install-journal** (primary): the journal records every per-field change made by `install.sh`. `applyJournalEntry` reverts fields that still match the install snapshot and preserves any field the user modified after install. Outputs a change report table showing which fields were reverted, preserved, or required special handling.
   2. **Legacy file restore** (no journal): restore from `state/upstream-cmd.txt` (stable state dir → highest-version cache → most recent `settings.json.bak.<ts>` whose `statusLine` does NOT point to our wrapper).
It also removes `creditgauge@creditgauge` from `settings.json.enabledPlugins` and wipes `cache/`, `marketplaces/`, `plugins/creditgauge/state/`, and the loader's JSON rows. v0.7.0 also strips the legacy `tokenplan-usage-hud@tokenplan-usage-hud` key and wipes the legacy `cache/`, `marketplaces/`, `plugins/tokenplan-usage-hud/state/` paths (one-release legacy dual-strip). Idempotent. See `scripts/uninstall.sh` for the full state machine.

v0.9.x: `install.sh --uninstall` was REMOVED. The thin shim that used to forward to `uninstall.sh` is gone — use `/creditgauge:uninstall` (or call `scripts/uninstall.sh` directly). `install.sh --uninstall` now exits 2 with a hint message pointing at the dedicated command.

`install.sh --restore` is a coarser recovery: it copies the most recent `settings.json.bak.<ts>` over the current `settings.json`, regardless of what changed since.

## Installation into Claude Code

The plugin is delivered as files at a fixed cache path: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/creditgauge/creditgauge/<version>/`. The `wrapper.sh`, `install.sh`, and `dist/index.js` are picked up by the marketplace machinery once the version directory exists.

After install, run `/creditgauge:install` to wire the wrapper into `settings.json`. The script writes `_creditgauge_managed: true` as an informational marker, but the **authoritative check** is `isOurWrapperCommand()` — whether the `statusLine.command` string still points to our cache path. Re-running on an already-owned statusLine (wrapper command matches) is a no-op regardless of the marker. If another plugin later overwrites `statusLine`, just re-run `/creditgauge:install` — it detects the command is foreign and re-establishes it.

**This plugin must be the sole `statusLine` owner.** Claude Code does not currently compose two plugins' `statusLine` fields — the later-installed plugin wins. To compose with another statusline (e.g. `ccstatusline`), invoke it from inside our wrapper via `CREDITGAUGE_UPSTREAM_CMD` rather than installing it as a second plugin.

## Security

- `ANTHROPIC_AUTH_TOKEN` is read from `process.env` and used only as the Bearer header for a single GET. It is **never** logged, written to stdout, persisted, or echoed in error messages.
- `.gitignore` excludes `.claude/settings.json` (which contains the live token in this project) and `~/.claude/settings.json` is the user's file — never modify it programmatically without preserving all other keys.
- `scripts/install.sh` only touches `settings.json`; it never reads `env.ANTHROPIC_AUTH_TOKEN` and never writes it to a different file.
- `settings.example.json` is a checked-in template; never put a real token in it.
- See `SECURITY.md` for full policy.

## Testing notes

- `npm test` runs all 1182 tests in ~3.8s. No network calls in tests — they exercise pure functions and fixtures.
- The captured real response lives at `src/__fixtures__/quota.real.minimax.json` and is the source of truth for the MiniMax parser's shape assumptions. If MiniMax changes the API, capture a fresh response and update both the fixture and the MiniMax plugin parser (`query_plugins/minimax/index.js`).
- Live smoke test (no Claude Code needed): `echo '{}' | ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic ANTHROPIC_AUTH_TOKEN=<token> node dist/index.js`.
- Live install smoke test: `bash scripts/install.sh --dry-run` then `bash scripts/install.sh` then `bash scripts/uninstall.sh` (or `bash scripts/uninstall.sh --dry-run` first).
- Live uninstall smoke test: `bash scripts/uninstall.sh --dry-run` then `bash scripts/uninstall.sh`. Re-run to confirm idempotency.
- Shell-script regression tests: `bash scripts/test-install.sh`, `bash scripts/test-uninstall.sh`, `bash scripts/test-edit-settings.sh`, `bash scripts/test-clean-cache.sh`, `bash scripts/test-config.sh`, `bash scripts/test-reset.sh`, `bash scripts/test-rename-consistency.sh` — all use isolated tmpdirs, no real settings.json touched.

## Build & release

- `npm run build` produces `dist/index.js` (~345 KB), the single runtime entry artifact. Plugins are plain JS under `query_plugins/` (bundled copies ship in the package; `install.sh` seeds `minimax` / `deepseek` into `~/.claude/plugins/creditgauge/query_plugins/`).
- Tag releases as `vX.Y.Z`; marketplace install picks up the highest version directory under `~/.claude/plugins/cache/<plugin>/<plugin>/`.
- Push to GitHub via `gh repo create cwf818/creditgauge --public --source=. --remote=origin --push` then `git push --tags`. (This requires `gh` CLI auth — see README "Push to GitHub" if `gh` is not available.)

## Dev loop: re-installing the plugin from scratch

When iterating on the install flow itself (changes to `scripts/install.sh`, `scripts/lib/edit-settings.mjs`, the `commands/install.md` slash command, or the version), you need to **fully wipe** the plugin's on-disk state before `/plugin install` will re-fetch the new version. The plugin loader caches the marketplace and refuses to bump an already-installed plugin, so a stale `installed_plugins.json` row or a stale `known_marketplaces.json` row can block upgrades silently (and on Windows the loader surfaces this as `EPERM: operation not permitted, rename ... -> ... .bak`).

Use the bundled dev helper (does **not** touch `settings.json` — your statusLine is preserved):

```bash
# Preview what will be removed (no changes):
npm run dev:uninstall:dry

# Actually wipe creditgauge state:
npm run dev:uninstall
# — or:  bash scripts/dev-uninstall.sh
```

It removes:
- the creditgauge row from `installed_plugins.json` and `known_marketplaces.json` (with timestamped `.bak.<ts>` backups of both files). v0.7.0 also strips the legacy `tokenplan-usage-hud` keys if present.
- `cache/creditgauge/`, `marketplaces/creditgauge/`, and the loader's leftover `marketplaces/cwf818-creditgauge/` directory. v0.7.0 also wipes the legacy `cache/tokenplan-usage-hud/`, `marketplaces/tokenplan-usage-hud/`, and `plugins/tokenplan-usage-hud/state/` paths (legacy dual-strip).

Then re-install:

```
/plugin marketplace add cwf818/creditgauge
/plugin install creditgauge@creditgauge
/reload-plugins
/creditgauge:install
```

## Dev loop: minimal deploy after every src/ change

**Always run this immediately after `npm test` (or after editing src/)**, before declaring any task done. Claude Code's statusline reads `~/.claude/plugins/cache/creditgauge/creditgauge/<HIGHEST_VERSION>/dist/index.js` on every tick — editing source without rebuilding + overwriting the cache bundle leaves the runtime reading yesterday's code, and the user sees no change on the statusline.

```bash
npm run build
HIGHEST=$(ls -d ~/.claude/plugins/cache/creditgauge/creditgauge/*/ | sort -V | tail -1)
cp dist/index.js "${HIGHEST}dist/index.js"
cp -r query_plugins "${HIGHEST}query_plugins"  # bundled plugin copies (minimax / deepseek)
# Smoke check: pick a unique identifier from your change and grep
# for it in the cache bundle. Count must be > 0.
grep -c "<unique_identifier_from_your_change>" "${HIGHEST}dist/index.js"
```

The trailing `grep -c` is the smoke check: it must be `> 0` to confirm the cache bundle contains the new code. Pure `npm test` is insufficient — tests exercise the source tree, not the runtime cache.

When the change adds new files under `src/` (not just edits existing modules), or touches `scripts/wrapper.sh` / `scripts/install.sh` / `.claude-plugin/*.json`, the minimal overwrite is NOT enough — fall back to the **full mirror** flow above (bump version, mirror sources, update installed_plugins.json, re-run install).

Why this is "every task, not just when asked": the deploy is fast (~50ms cp of a ~345 KB bundle) and idempotent. Skipping it produces confusing bugs where tests pass but the statusline reads stale. See `memory/local-deploy-procedure.md` for the full procedure and history.

If the loader still says "EPERM" after `dev:uninstall`, the most common cause is a Claude Code process holding a file lock on the marketplace dir. **Quit all running Claude Code sessions** (not just this one) and re-run `npm run dev:uninstall`.