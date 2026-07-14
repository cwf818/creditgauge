# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code statusline plugin (`topgauge`, formal name **ToPGauge-CC**) that renders **MiniMax token-plan usage** (5-hour and weekly windows) **or DeepSeek account balance**, picked by `ANTHROPIC_BASE_URL`. The plugin ships its own installer (`scripts/install.sh`) that hooks into Claude Code's `statusLine` slot and (optionally) chains any pre-existing statusline (e.g. `ccstatusline`, `claude-hud`) as the upstream. When `ANTHROPIC_BASE_URL` does not point at a supported provider, the plugin hides itself and passes upstream output through unchanged.

The plugin is shipped as a **single-plugin marketplace**: the repo root IS the marketplace, and `.claude-plugin/plugin.json` declares the plugin. Install with `/plugin marketplace add cwf818/topgauge` then `/plugin install topgauge@topgauge`, then run `/topgauge:install` to wire it into `settings.json`. Uninstall with `/topgauge:uninstall` (a self-contained cleanup that works even after the cache and marketplace are gone).

**v0.7.0 — renamed from `tokenplan-usage-hud` to `topgauge`.** Package id, marketplace id, plugin name, env-var namespace (`TOKENPLAN_*` → `TOPGAUGE_*`), slash-command prefix, internal state-dir path (`plugins/tokenplan-usage-hud/state/` → `plugins/topgauge/state/`), settings.json marker (`_tokenplan_managed` → `_topgauge_managed`), and stderr banner are all renamed. Provider strings (`minimax`, `MiniMax`, `MiniMax-M3`, `minimaxi.com`, `Quota`, `BALANCE`, `DeepSeek`, `deepseek`, `/v1/token_plan/remains`, `/user/balance`) are NOT renamed. Users upgrading from a pre-rename install get a one-shot state-dir migration in `install.sh`; `uninstall.sh` recognizes BOTH the old and the new name for at least one release.

## Commands

```bash
npm install          # install dev deps (esbuild, typescript, tsx, @types/node)
npm run typecheck    # tsc --noEmit
npm test             # node:test via tsx (64 tests across api/render/cache/composition)
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
  # m_memUsage (which renders absolute bytes "Mem:X.XG/Y.YG" with
  # a fixed cyan tint). m_windowMemUsage renders a bar+percent
  # chunk (parallel of m_windowContext) — `▓▓▓▓▓░░░ 62%` — by
  # wrapping getMemUsage()'s 0..100 ratio in a synthetic Window
  # and routing through formatOneChunk / formatOneChunkColored.
  # The value color is driven by colorFor(pct, "used") so
  # thresholds.percentBands drives the hue. NO label prefix.
  # Opt-in; not in any default lineTemplate.
  render.ts           # v1.0 READ-ONLY against tickState.pending: pctBar + ANSI color thresholds + renderProviderLine (sole public entry; the legacy formatLine / formatBalanceLine shims were dropped in v0.9.x); NO setAvg/setPrevTick/setLastSpeed calls (those moved to data-processor.ts)
  data-processor.ts   # v1.0 processTick + setPrevTick + setAvg + setLastSpeed/ApiMs/TokenHitRate + computeAndCacheTickDeltaPure + getDeltaForRender — owns ALL writes to tickState.pending
  cache.ts            # TTL + stale-on-error (Map<key, {at, value}>) — TTL passed in by index.ts from configStore
  config.ts           # config loader/store and provider facade
  config.providers.ts  # provider defaults, type validation, effective mappings
  config.template.ts   # line-template defaults and template-only types
  composition.ts      # reads TOPGAUGE_UPSTREAM env, prepends (preserving ANSI/multi-line) and appends line
  tick-state.ts       # v1.0 per-tick in-memory Store: beginTick / mark / commit; backing the data-processor's writes + the single commit() flush
  __fixtures__/       # remains.real.json, balance.real.json, balance.multi.json, …
  session-parse.ts    # parseTokenSnapshot — stdin JSON → TokenSnapshot (extracted from index.ts so unit tests don't drag index side effects)
  token-store.ts      # append-only JSONL state file at state/<projectHash>/<sessionId>.jsonl for sum/avg modules (v0.4.x+; v0.8.0 adds readAllSamples cross-project scan)
  *.test.ts           # node:test unit tests
.claude-plugin/
  plugin.json         # plugin manifest (name, version, commands, homepage)
  marketplace.json    # single-plugin marketplace wiring
commands/
  install.md          # /topgauge:install slash command (Pattern B2 — loader-executes-script via `!`-fenced block + ${CLAUDE_PLUGIN_ROOT}; scoped allowed-tools)
  uninstall.md        # /topgauge:uninstall slash command (Pattern B2)
  clean.md            # /topgauge:clean slash command (Pattern B2)
  clean-cache.md      # /topgauge:clean-cache slash command (Pattern B2)
scripts/
  wrapper.sh          # bash wrapper: TOPGAUGE_UPSTREAM_CMD → TOPGAUGE_UPSTREAM → us
  install.sh          # settings.json patcher (install/restore/dry-run; uninstall is its own command in v0.9.x+)
  uninstall.sh        # self-contained uninstaller (used by :uninstall and dev:uninstall)
  clean.sh            # trim old .bak.<ts> files, keeping only the most recent per file
  lib/edit-settings.mjs # ESM helper used by install.sh
  dev-uninstall.sh    # DEV-ONLY thin shim → exec uninstall.sh
  index.js            # gitignored, esbuild bundle, the actual entry point
settings.example.json # template (NEVER commit a real settings.json)
```

### How it runs

Claude Code's `statusLine.command` spawns a child process that reads a session JSON from stdin and writes statusline text to stdout. Per-turn invocation — the plugin must be fast and never block.

1. `statusLine.command` (written by `scripts/lib/edit-settings.mjs` `write-managed` op) is a `bash -c '…'` snippet that, at invocation time, `ls -d`s every directory under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/topgauge/topgauge/*/`, sorts by version (`sort -t. -k1,1n …`), tails the highest, and execs `scripts/wrapper.sh` from that `plugin_dir`. Same pattern claude-hud uses. This makes the command **version-independent** — when `/plugin install` rolls the cache forward (0.2.5 → 0.2.6), the existing `statusLine` keeps working without re-running `install.sh`. The command then optionally runs the bash script at `$TOPGAUGE_UPSTREAM_CMD` (so the user can compose with another statusline, e.g. `ccstatusline` or `claude-hud`), captures its stdout into the `TOPGAUGE_UPSTREAM` env var, then execs `dist/index.js` forwarding stdin. If `TOPGAUGE_UPSTREAM_CMD` is unset, `TOPGAUGE_UPSTREAM` is empty and this plugin becomes the sole statusline. Note: `TOPGAUGE_UPSTREAM_CMD` is an **absolute path** to a bash script (a shebang + `exec bash -c '...'` wrapper written by install.sh), not a shell command line — older v0.1.10–v0.1.11 used `bash -c` against the path and silently failed; v0.1.12 runs it as a script (`bash "$TOPGAUGE_UPSTREAM_CMD"`).
2. `src/index.ts` reads stdin, matches `ANTHROPIC_BASE_URL` against `config.json.providers`, and dispatches through `src/api.ts` to a dynamically imported built-in or user plugin. The selected provider's `AUTHENTICATION_KEY` overrides `process.env.ANTHROPIC_AUTH_TOKEN`.
3. Built-in plugins fetch and parse their own upstream responses. They return the canonical `Quota` or `Balance` shape through the shared `fetchAccountCredit(authenticationKey, context?)` ABI; user plugins use the same ABI and are loaded from `query_plugins/<id>/index.js` or `.mjs`. **v0.9.0+ — user plugins take precedence over built-ins:** placing a file at `~/.claude/plugins/topgauge/query_plugins/<id>/index.{js,mjs}` silently overrides the bundled built-in of the same `<id>` (so `minimax` / `deepseek` are no longer a closed set — any user can ship a same-id replacement). No config flag, no stderr warn, no `diagnostics.jsonl` row — resolution is silent. The override side is only surfaced when the user plugin *fails to load* (the error message prefixes with `user plugin …` vs the built-in's `built-in plugin …` so you can tell which file actually threw). **v0.9.0+ — `m_pluginSource` module:** renders 📌 when the active provider’s plugin resolved to the bundled built-in, 🎨 when a user override at `query_plugins/<id>/` won, ❗ when the matched provider id has no plugin at all (neither user override nor built-in). A 4th glyph 🔖 is reserved for a future “claude 官方” branch (data sourced from stdin) but the dispatch arm is not yet wired (CC 分支暂不做实现 2026-07-12). The host stashes the resolution kind into `cache.json` under `<provider>:pluginSource` right after a successful `pluginTransportWithKind` call (see `src/api.ts`). The renderer reads it via `cache.peek` (TTL-ignoring) so adding/removing an override file reflects on the next tick without waiting for the data row to expire. No default tint — the symbol carries the meaning on its own, with `|color|<c>` available as an inline override. When no cache row exists (fresh install / no provider matched), the module drops to no-op. The MiniMax plugin's response parser accepts two shapes:
   - **Real shape** (verified against `https://www.minimaxi.com/v1/token_plan/remains` on 2026-06-24): `{ model_remains: [{ model_name, current_interval_remaining_percent, current_weekly_remaining_percent, start_time, end_time, weekly_start_time, weekly_end_time, … }, …], base_resp: { status_code } }`. We pick the entry with the **lowest interval remaining %** as the source of truth (the most-active model). `start_time`/`end_time` (and their weekly counterparts) populate `Window.resetStartAt` and `Window.resetDurationMs` so the renderer can pick a window-fill-aware reset arrow.
   - **Legacy/fallback shape**: `{ data: { five_hour: { remaining, limit }, weekly: { remaining, limit } } }` — for any provider that returns the simpler schema (no start fields → reset arrow falls back to `resetArrows[0]`).
4. Cache: `src/cache.ts` holds a single 60-second TTL entry. On fetch failure it returns the stale value so the statusline doesn't blank.
5. Render: `src/render.ts` emits a single compact line `Usage: ▓░░░░░░░ 9% (4h47m🕔 5h) · ▓▓░░░░░░ 25% (2d8h🕔 7d)`. Layout: a single mode label prefix (`Usage:` or `Remain:`), then per-window `<bar> <coloredN%><RESET> (<countdown><glyph> <windowLabel>)` segments joined with ` · `. When the window has no reset time (DeepSeek, legacy), the segment renders as ` <windowLabel>` (no parens, no arrow). Sub-minute remaining renders as `<1m` by default (so a window about to reset is distinguishable from one with a full minute left) — set `stale.minUnit: "s"` to opt into second precision (`47s` instead). Default mode is **`used`** (line begins with `Usage:`); set `display: "remaining"` in `config.json` to switch. 5-band colors (256-color SGR): bright green / dark green / yellow / orange / red, applied to the displayed value at 0/20/40/60/80 boundaries. The colored chunk is always on the right side of the bar, sized by the displayed value. The reset arrow glyph comes from `stale.resetArrows` (default 12 clock-face emoji `🕛,🕚,🕙,…,🕐`), indexed by `remainingMs / resetDurationMs` so the array reads left-to-right as "few remaining → many remaining" (i.e. ascending by remaining-time ratio). Two glyphs (`["⏳","⌛"]`) reproduce the v0.2.1 hourglass pair; one glyph is static. Providers without start data (DeepSeek, legacy) fall back to index 0.
6. Compose: `src/composition.ts` emits upstream (whatever `TOPGAUGE_UPSTREAM` contains — possibly multi-line, possibly ANSI-colored) on the leading lines and our line last. It strips only trailing whitespace, injects `\x1b[0m` if upstream ends with an unclosed SGR, and otherwise preserves upstream verbatim.
7. **Token-usage modules (v0.8.0+):** In addition to the tokenplan 5h/7d window display, the plugin reads the session JSON from stdin (verified schema: `context_window.{total_input_tokens, total_output_tokens, current_usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}}`, `cost.total_duration_ms`, `session_id`, `cwd`) and exposes fine-grained modules via `lineTemplate`. Modules are split into three tiers — **per-turn** (stdin-only, zero IO), **acc** (in-memory three-layer accumulator: session / project / model), and **sum/avg** (cross-project JSONL scan, TTL=300s). All modules are opt-in — the default `lineTemplate` does NOT include any token module, so existing v0.7.x configs render byte-identical after upgrade. The `m_tokenTotalIn` invariant (`total_input_tokens == current.input_tokens + current.cache_read_input_tokens`) is verified in `session-parse.ts` and a violation emits a `warning` to `state/<projectHash>/diagnostics.jsonl` (gated by `TOPGAUGE_DIAGNOSTICS_ENABLE=1`, 60s dedupe).

   **Per-turn modules (stdin-only):**
   - `m_tokenIn` / `m_tokenOut` — current.input / current.output (per-turn deltas)
   - `m_tokenCachedIn` — current.cacheRead
   - `m_tokenTotalIn` — totals.input (session cumulative)
   - `m_tokenInTotal` / `m_tokenTotalOut` — totals.input / totals.output (session cumulative; v0.8.0+ renamed from `m_tokenOutTotal` to sit in the `totalOut` family alongside `totalOut` on-disk / `m_accTokenOut` / `m_sumTokenOut`)
   - `m_tokenInSpeed` / `m_tokenOutSpeed` — session-avg tps (last-active-tick cache, color:scale). v0.8.x R7 — TTL gate disabled: idle ticks always surface the cached value STALE_COLORed, never expire. The `LAST_ACTIVE_TTL_MS` constant in `status-store.ts` is retained for future opt-in via config, but the read path no longer compares against it.
   - `m_apiMs` — per-turn delta of `cost.totalApiDurationMs` formatted as dhms time string with hardcoded `api:` prefix (e.g. `api:1m`, `api:5s`, `api:<1m`); idle tick → cached value STALE_COLORed (R7; previously the `api:n/a` placeholder after 60s — R9 unified on n/a body to align with the rest of the n/a-family placeholders). Honors `timeFormat.minUnit` (`m` default → sub-minute collapses to `<1m`; `s` opt-in → second precision). Reuses `computeAndCacheTickDelta` memo so prev-tick baseline is shared with `m_tokenIn` / `m_tokenOut` / `m_tokenInSpeed`.
   - `m_contextSize` — totals.input (actual used)
   - `m_contextWindowsSize` — context_window.size (capacity; typo preserved)
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
   - Inline args: `:window:<dhms|all>` (default 5h), `:model:<active|name|all>` (default active), `:align:<true|false>` (default true; only effective when model=active AND window∈{5h,7d} AND ctx.fiveHour/weekly.resetStartAt is set, else wall-clock fallback), `:nulldrop:<b>`, `:color:<c>`.

   **Removed in v0.8.0 (no alias):** `m_token5h`, `m_token7d`, `m_tokenInAvg`, `m_tokenOutAvg`, `m_ctx` (→ `m_contextSize`), `m_cachedTokenIn` (→ `m_tokenCachedIn`), `m_cacheRead` (→ `m_tokenCachedIn`), `m_contextUsed` (→ `m_contextUsedPercent`). The old v0.4.0 ADR at `memory/token-usage-design-adr.md` is marked DEPRECATED — refer to [[token-modules-redesign-v0-8-0]] + [[sum-avg-modules-step2]] for the v0.8.0 contract.

   The append-only JSONL state file `state/<projectHash>/<sessionId>.jsonl` (~120B per tick, ~700KB over 7d) is the data source for sum/avg; per-turn modules read stdin directly. The cross-project scanner `readAllSamples(sinceMs)` walks every `state/<projectHash>/` subdir and concatenates per-row `TokenSample`s.

### Per-Project State Layout (v0.4.x+)

#### Per-tick write invariant (v1.0)

The per-tick pipeline is a two-phase split between **data-processor (writes)** and **render (reads)** — owned by `src/data-processor.ts` and `src/tick-state.ts`. The pipeline:

1. **`beginTick(cwd, tokens)`** (index.ts:main, right after `diagnostics.setSessionCwd`) — loads `state/<projectHash>/status.json` into a per-tick `pending` map, validates the snapshot (see below), and exposes the pending map for the data-processor to mutate.
2. **`processTick(cwd, tokens)`** (index.ts:main, right after `beginTick`) — ALREADY-RUNS data-processing pipeline. **Always fires**, independent of the user's `lineTemplate`. Even an empty template still has the data-processor run, so the next tick has a baseline. Five stages, gated on the validation flag:
   - **Stage 1** — regression-reset: if `prev.totalApiMs > current.totalApiDurationMs` (claude-code process restarted), `tickState.mark(CCSESSION_KEY, emptyTickStatus())`.
   - **Stage 2** — compute deltas via `computeAndCacheTickDeltaPure(tokens)`; stash on `_state.delta` for render reads (no on-disk side effect).
   - **Stage 3** — `setPrevTick`: writes PREV_TICK_KEY for next tick's baseline.
   - **Stage 4** — `setAvg` for the per-session slot (accIn / accOut / accApiMs / accApiCount / accTotalIn).
   - **Stage 4b** — `setAvg` for the cache track (`accCached` only, when stdin shipped `cache_read_input_tokens`).
   - **Stage 5** — `lastActive:*` marks: `tpsIn`, `tpsOut`, `apiMs`, `tokenHitRate` for the speed/cache/idle-render fallbacks.
3. **`commit()`** (index.ts:main, between `appendSample` and the provider-dispatch branch) — flushes `pending` to `status.json` as ONE full-file rewrite. No-op when:
   - `dirty === false` (nothing was marked — pristine / idle tick);
   - `valid === false` (validation gate failed — see below);
   - `cwd === null` (no per-project dir to write to).
4. **Render** (`buildProviderLine` → `renderTemplate`) — PURE READ against `tickState.getState().pending[key]`. NO `tickState.mark` / `setAvg` / `setPrevTick` / `setLastSpeed` / `setLastApiMs` / `setLastTokenHitRate` calls anywhere in `src/render.ts`. Reads go through `getDeltaForRender()` / `peekAcc` / `peekPrevTick` / `peekLastSpeed` / `peekLastApiMs` / `peekLastTokenHitRate`. mid-render mutations.

**Invariant**: **at most one full-file rewrite per tick** (zero on invalid / idle / pristine ticks). The previous v0.8.x code path fired 5–13 `writeFileSync` calls per active render (`accPrimer`, `accCachePrimer`, `setLastSpeed`, `setPrevTick`); v0.9.x collapsed that to one, and **v1.0 fully decoupled writes from reads** so render is read-only against the in-memory store. No `statusStore.writeTickStatus` bypass anywhere — the v0.9.x regression-reset "immediate write" exception is gone; in v1.0 the reset is a regular `tickState.mark` that flushes alongside every other write via the same single `commit()`.

**Validation gate** (per user contract 2026-07-04): `tokens.totals.tokenTotalIn > 0 AND tokens.totals.tokenTotalOut > 0 AND (tokens.cost.totalApiDurationMs - prevTickStatus.totalApiMs) > 0`. On the first tick (no prev baseline), the rule collapses to `totalApiDurationMs > 0`. Invalid ticks commit nothing — but **`processTick` Stages 3-5 are skipped on invalid ticks**, only Stage 1 (regression-reset) always fires. Writes staged in `pending` (regression reset mark) survive in-memory until the next valid tick when `commit()` flushes them. The renderer can still read pending (which is a clone of the loaded on-disk state) so render never crashes on invalid ticks — it just falls back to placeholder / "0" / last-cached values via the existing `getDeltaForRender` sentinel + `peekLast*` fallbacks.

**Module-keyed field naming** (v0.9.x+): `TokenSnapshot` fields are named for their primary reader module — `tokens.current.tokenIn` (read by `m_tokenIn`), `tokens.totals.tokenTotalIn` (read by `m_tokenTotalIn`), `tokens.contextWindow.contextWindowSize` (read by `m_contextWindowsSize`), etc. The grouping (`current` for per-turn deltas, `totals` for session-cumulative, `contextWindow` for capacity/percentages, `cost` for stdin `cost.*` fields) is preserved so the `total_input_tokens == input_tokens + cache_read_input_tokens` invariant check in `src/session-parse.ts` still rides on the type-level signal.

### Per-Project State Layout (v0.4.x+)

The runtime state directory is partitioned by project so multiple Claude Code sessions in different project directories never contend over the same files. Assumption: one project directory → one Claude Code session.

```
~/.claude/plugins/topgauge/state/
  upstream-cmd.sh              # top-level — install/uninstall dependency, NOT touched per tick
  upstream-cmd.txt             # top-level — install/uninstall dependency, NOT touched per tick
  config.json                  # top-level — install/uninstall dependency, NOT touched per tick
  <projectHash>/               # e.g. d--workspace-topgauge-cc (the actual cwd on this machine)
    cache.json                 # disk-shadowed TTL cache (per-project, key-prefixed by <projectHash>:)
    diagnostics.jsonl          # append-only warning/error log (per-project)
    <sessionId>.jsonl          # token samples (was state/token-samples/<hash>/<sid>.jsonl)
```

- All per-tick IO paths derive their location from `projectHash(cwd)` (lowercased, `\/: ` → `-`, control chars stripped, capped at 80 chars; exported from `src/token-store.ts`).
- `src/render.ts` prefixes every cache key with `<projectHash>:` so `cache.json` files never share keys across projects. The cache module API (`get`/`set`/etc.) is unchanged — the prefix is a render-side concern only.
- `src/diagnostics.ts` gained an optional `cwd` parameter on `append` / `readLatest` / `diagnosticsPath`. When omitted or null (e.g. plugin-level config-parse warnings), writes fall back to the legacy top-level `state/diagnostics.jsonl`.
- Legacy migration for users upgrading from v0.4.0–v0.4.<n-1>: legacy top-level `cache.json` / `diagnostics.jsonl` are NOT auto-migrated (no project info recoverable). Legacy `state/token-samples/<projectHash>/<sessionId>.jsonl` files can be preserved with `bash scripts/migrate-state.sh` (or `--dry-run` to preview). Idempotent — `mv -n` is a no-op when the destination already exists.
- `scripts/clean.sh --purge-runtime` walks every `state/*/` subdir and removes its `cache.json`, `diagnostics.jsonl`, and `<*.jsonl>` files. It still cleans the legacy top-level `cache.json` / `diagnostics.jsonl` and the `state/token-samples/` tree for users who skipped migration. Top-level `upstream-cmd.{sh,txt}` and `config.json` are NEVER purged. (v0.7.0: also wipes the legacy `plugins/tokenplan-usage-hud/state/` tree left behind by users upgrading from the pre-rename install — both via the projectHash walk and a final whole-subtree wipe.)

### How `:install` / `:uninstall` / `:clean` run

`commands/*.md` are **Pattern B2** slash commands (same shape as `claude-plugins-official/ralph-loop`): the body is a ` ```! ` fenced block that the loader executes directly with the framework-provided `CLAUDE_PLUGIN_ROOT` env var pointing at the installed cache dir, scoped via `allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/<name>.sh:*)`. Arguments typed after the slash command are appended via `$ARGUMENTS`. The LLM sees the script's stdout but does not need to act — this eliminates the "LLM received the prompt but chose to describe instead of executing" failure mode that affected the older Pattern A `commands/install.md` (v0.1.0–v0.2.6, where the markdown was a prose instruction to the LLM). For these three commands there is no LLM reasoning to do — `install.sh` / `uninstall.sh` / `clean.sh` are already idempotent, parameter-complete, and self-verifying.

### How `install.sh` patches `settings.json`

The install script is the **only** way the plugin writes to `settings.json`. The marketplace install copies files into the cache but does not claim `statusLine` (the manifest declares no `statusLine` field). `/topgauge:install` does the patching:

1. Resolves the active `settings.json` (user-level by default; `--project` for project-level). If `--project` and the file is missing, creates a minimal one (it does NOT copy from user-level).
2. **One-shot state-dir migration (v0.7.0):** if `${CLAUDE_ROOT}/plugins/tokenplan-usage-hud/state/` exists and `${CLAUDE_ROOT}/plugins/topgauge/state/` does NOT, copies the legacy contents forward (preserving `upstream-cmd.sh`, `upstream-cmd.txt`, `cache.json`, `diagnostics.jsonl`, `<projectHash>/` subtree) so existing token-sample history, diagnostics logs, and preserved upstream commands follow the user. Idempotent and safe to re-run.
3. Reads `statusLine` via `scripts/lib/edit-settings.mjs`:
   - `_topgauge_managed === true` → already ours, no-op.
   - `command` is some foreign string → back up the file to `settings.json.bak.<ISO-timestamp>`, preserve the original command at `<claude-root>/plugins/topgauge/state/upstream-cmd.sh` (with shebang) and `<claude-root>/plugins/topgauge/state/upstream-cmd.txt` (bare command), then rewrite `statusLine` to invoke our wrapper with `TOPGAUGE_UPSTREAM_CMD=<upstream-cmd.sh>`. The state dir is sibling of `config.json` — STABLE across `/plugin install` rolls and cache wipes, so a future uninstall can always find it.
   - no `statusLine` → just install our wrapper.
4. Rewrites the file via `scripts/lib/edit-settings.mjs`, which preserves the original line ending (CRLF on Windows, LF elsewhere).

`scripts/uninstall.sh` is the uninstall entry point — invoked by `/topgauge:uninstall` (slash command) and `npm run dev:uninstall` (CLI). It works even when the plugin cache is gone (priority order: stable `state/upstream-cmd.txt` → highest-version legacy `state/upstream-cmd.txt` → most recent pre-managed `settings.json.bak.<ts>`). It also removes `topgauge@topgauge` from `settings.json.enabledPlugins` and wipes `cache/`, `marketplaces/`, `plugins/topgauge/state/`, and the loader's JSON rows. v0.7.0 also strips the legacy `tokenplan-usage-hud@tokenplan-usage-hud` key and wipes the legacy `cache/`, `marketplaces/`, `plugins/tokenplan-usage-hud/state/` paths (one-release legacy dual-strip). Idempotent. See `scripts/uninstall.sh` for the full state machine.

v0.9.x: `install.sh --uninstall` was REMOVED. The thin shim that used to forward to `uninstall.sh` is gone — use `/topgauge:uninstall` (or call `scripts/uninstall.sh` directly). `install.sh --uninstall` now exits 2 with a hint message pointing at the dedicated command.

`install.sh --restore` is a coarser recovery: it copies the most recent `settings.json.bak.<ts>` over the current `settings.json`, regardless of what changed since.

## Installation into Claude Code

The plugin is delivered as files at a fixed cache path: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/topgauge/topgauge/<version>/`. The `wrapper.sh`, `install.sh`, and `dist/index.js` are picked up by the marketplace machinery once the version directory exists.

After install, run `/topgauge:install` to wire the wrapper into `settings.json`. The script marks `statusLine._topgauge_managed = true` so re-running it is a no-op. If another plugin later overwrites `statusLine`, just re-run `/topgauge:install` — it detects the marker is gone and re-establishes it.

**This plugin must be the sole `statusLine` owner.** Claude Code does not currently compose two plugins' `statusLine` fields — the later-installed plugin wins. To compose with another statusline (e.g. `ccstatusline`), invoke it from inside our wrapper via `TOPGAUGE_UPSTREAM_CMD` rather than installing it as a second plugin.

## Security

- `ANTHROPIC_AUTH_TOKEN` is read from `process.env` and used only as the Bearer header for a single GET. It is **never** logged, written to stdout, persisted, or echoed in error messages.
- `.gitignore` excludes `.claude/settings.json` (which contains the live token in this project) and `~/.claude/settings.json` is the user's file — never modify it programmatically without preserving all other keys.
- `scripts/install.sh` only touches `settings.json`; it never reads `env.ANTHROPIC_AUTH_TOKEN` and never writes it to a different file.
- `settings.example.json` is a checked-in template; never put a real token in it.
- See `SECURITY.md` for full policy.

## Testing notes

- `npm test` runs all 64 tests in ~250ms. No network calls in tests — they exercise pure functions and fixtures.
- The captured real response lives at `src/__fixtures__/remains.real.json` and is the source of truth for the parser's shape assumptions. If MiniMax changes the API, capture a fresh response and update both the fixture and `src/api.plan.ts`.
- Live smoke test (no Claude Code needed): `echo '{}' | ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic ANTHROPIC_AUTH_TOKEN=<token> node dist/index.js`.
- Live install smoke test: `bash scripts/install.sh --dry-run` then `bash scripts/install.sh` then `bash scripts/uninstall.sh` (or `bash scripts/uninstall.sh --dry-run` first).
- Live uninstall smoke test: `bash scripts/uninstall.sh --dry-run` then `bash scripts/uninstall.sh`. Re-run to confirm idempotency.
- Shell-script regression tests: `bash scripts/test-install.sh`, `bash scripts/test-uninstall.sh`, `bash scripts/test-edit-settings.sh`, `bash scripts/test-clean-cache.sh` — all use isolated tmpdirs, no real settings.json touched.

## Build & release

- `npm run build` produces `dist/index.js` (~9kb). This is the only artifact the runtime needs.
- Tag releases as `vX.Y.Z`; marketplace install picks up the highest version directory under `~/.claude/plugins/cache/<plugin>/<plugin>/`.
- Push to GitHub via `gh repo create cwf818/topgauge --public --source=. --remote=origin --push` then `git push --tags`. (This requires `gh` CLI auth — see README "Push to GitHub" if `gh` is not available.)

## Dev loop: re-installing the plugin from scratch

When iterating on the install flow itself (changes to `scripts/install.sh`, `scripts/lib/edit-settings.mjs`, the `commands/install.md` slash command, or the version), you need to **fully wipe** the plugin's on-disk state before `/plugin install` will re-fetch the new version. The plugin loader caches the marketplace and refuses to bump an already-installed plugin, so a stale `installed_plugins.json` row or a stale `known_marketplaces.json` row can block upgrades silently (and on Windows the loader surfaces this as `EPERM: operation not permitted, rename ... -> ... .bak`).

Use the bundled dev helper (does **not** touch `settings.json` — your statusLine is preserved):

```bash
# Preview what will be removed (no changes):
npm run dev:uninstall:dry

# Actually wipe topgauge state:
npm run dev:uninstall
# — or:  bash scripts/dev-uninstall.sh
```

It removes:
- the topgauge row from `installed_plugins.json` and `known_marketplaces.json` (with timestamped `.bak.<ts>` backups of both files). v0.7.0 also strips the legacy `tokenplan-usage-hud` keys if present.
- `cache/topgauge/`, `marketplaces/topgauge/`, and the loader's leftover `marketplaces/cwf818-topgauge/` directory. v0.7.0 also wipes the legacy `cache/tokenplan-usage-hud/`, `marketplaces/tokenplan-usage-hud/`, and `plugins/tokenplan-usage-hud/state/` paths (legacy dual-strip).

Then re-install:

```
/plugin marketplace add cwf818/topgauge
/plugin install topgauge@topgauge
/reload-plugins
/topgauge:install
```

## Dev loop: minimal deploy after every src/ change

**Always run this immediately after `npm test` (or after editing src/)**, before declaring any task done. Claude Code's statusline reads `~/.claude/plugins/cache/topgauge/topgauge/<HIGHEST_VERSION>/dist/index.js` on every tick — editing source without rebuilding + overwriting the cache bundle leaves the runtime reading yesterday's code, and the user sees no change on the statusline.

```bash
npm run build
HIGHEST=$(ls -d ~/.claude/plugins/cache/topgauge/topgauge/*/ | sort -V | tail -1)
cp dist/index.js "${HIGHEST}dist/index.js"
# Smoke check: pick a unique identifier from your change and grep
# for it in the cache bundle. Count must be > 0.
grep -c "<unique_identifier_from_your_change>" "${HIGHEST}dist/index.js"
```

The trailing `grep -c` is the smoke check: it must be `> 0` to confirm the cache bundle contains the new code. Pure `npm test` is insufficient — tests exercise the source tree, not the runtime cache.

When the change adds new files under `src/` (not just edits existing modules), or touches `scripts/wrapper.sh` / `scripts/install.sh` / `.claude-plugin/*.json`, the minimal overwrite is NOT enough — fall back to the **full mirror** flow above (bump version, mirror sources, update installed_plugins.json, re-run install).

Why this is "every task, not just when asked": the deploy is fast (~50ms cp of a 160kb bundle) and idempotent. Skipping it produces confusing bugs where tests pass but the statusline reads stale. See `memory/local-deploy-procedure.md` for the full procedure and history.

If the loader still says "EPERM" after `dev:uninstall`, the most common cause is a Claude Code process holding a file lock on the marketplace dir. **Quit all running Claude Code sessions** (not just this one) and re-run `npm run dev:uninstall`.