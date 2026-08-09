<pre>
[upstream statusline lines]
Usage: ▓▓▓▓░░░░ 40% 🕗1h27m·5h · ▓▓░░░░░░ 20% 🕔4d3h·7d    # Quota
Balance: ¥110.00 · $3.5                                        # Balance
</pre>

# CreditGauge

[![License](https://img.shields.io/github/license/cwf818/creditgauge)](LICENSE)
[![Tag](https://img.shields.io/github/tag/cwf818/creditgauge)](https://github.com/cwf818/creditgauge/tags)
[![Stars](https://img.shields.io/github/stars/cwf818/creditgauge)](https://github.com/cwf818/creditgauge/stargazers)

A provider-agnostic Claude Code statusline plugin for **token-plan usage / remaining quota**. It picks what to render from `ANTHROPIC_BASE_URL`, so the same plugin works against any supported provider's plan endpoint — no per-provider re-install. Currently supported:

- **MiniMax** — `Usage: …` / `Remain: …` (5-hour + weekly windows), from `/v1/token_plan/remains`
- **DeepSeek** — `Balance: …` (account balance), from `/user/balance`

For vanilla Anthropic, OpenRouter, or any other provider not on the list above, the plugin **hides itself** and passes any chained upstream statusline through unchanged.

We deliberately don't reimplement the kitchen-sink statuslines that already exist for vanilla Anthropic — [`claude-hud`](https://github.com/jarrodwatts/claude-hud) and [`ccstatusline`](https://github.com/sirmalloc/ccstatusline) cover that. This plugin focuses on provider-specific **quota / balance** data, plus lightweight usage statistics read from Claude Code's stdin payload.

ANSI colors are 5-band (256-color SGR): bright green / dark green / yellow / orange / red. Applied to the displayed value + the colored bar segment; the empty part of the bar stays uncolored so it remains readable.

## Snapshots

**`simple` preset** — minimal layout, single Quota line on its own, working with a pre-installed `claude-hud`:

![toPGauge simple preset](https://github.com/cwf818/creditgauge/raw/main/screenshots/screenshot-simple.png)

**`standard` preset** — context, memory, git, session / project / 5h-align / 7d-align scanners, plus the live quota line:

![toPGauge standard preset](https://github.com/cwf818/creditgauge/raw/main/screenshots/screenshot-standard.png)

## Documentation

- [**快速上手指南.md**](./快速上手指南.md) — 5-minute快速上手指南：效果、简介、安装、基本配置、插件、安全与协议。
- [**MANUAL.md**](./MANUAL.md) — exhaustive configuration reference. Top-level schema, provider entries, presets, fragments, inline-args grammar, full `m_*` module catalog, recipes, plugin ABI.
- [**HOW_TO_CREATE_A_PLUGIN.md**](./HOW_TO_CREATE_A_PLUGIN.md) — wire up a custom provider (kimi / moonshot / z.ai / etc.) without forking the plugin. User-side plugin ABI, fill contract, override resolution.
- [**CHANGELOG.md**](./CHANGELOG.md) — per-version change history (breaking changes, new modules, removed aliases, schema upgrades).

## Install

The plugin is a single-plugin marketplace. Install it in three steps:

```
/plugin marketplace add cwf818/creditgauge
/plugin install creditgauge@creditgauge
```

> After the plugin install, run `/reload-plugins` so the loader picks up the new commands before wiring it into `settings.json`. Forgetting this step is the most common cause of "command not found" right after install.

Then wire it into `settings.json`:

```
/creditgauge:install
```

This patches the active `settings.json` (user-level by default; pass `--project` for project-level):

### Install via npx (no marketplace required)

```
npx creditgauge
```

Launches a TUI (powered by @clack/prompts) with five options: Install,
Uninstall, Clean, View diagnostics, Exit. The TUI shells out to the same
`scripts/*.sh` that the slash commands use, so behavior is identical.

Non-interactive form (script-friendly):

```
npx creditgauge install          # user-level
npx creditgauge install --project   # project-level
npx creditgauge uninstall
npx creditgauge clean --dry-run
npx creditgauge reset
npx creditgauge diagnostics      # last 20 plugin warning/error entries
npx creditgauge plugin add       # install a query plugin (interactive)
npx creditgauge plugin remove    # remove a query plugin
npx creditgauge plugin auth      # authenticate a query plugin
npx creditgauge plugin list      # list available plugins
npx creditgauge --version
npx creditgauge --help
```

> The plugin must be in Claude Code's cache first
> (`~/.claude/plugins/cache/creditgauge/creditgauge/<version>/`).
> If it isn't, `npx creditgauge install` prints a hint pointing at the
> marketplace flow. Once installed once via marketplace, all subsequent
> `npx creditgauge install` calls work.

1. If `statusLine.command` already points to our wrapper (checked via `isOurWrapperCommand` — the command string itself, not the `_creditgauge_managed` marker), the command is a no-op.
2. Otherwise, the current `settings.json` is backed up to `settings.json.bak.<ISO-timestamp>`.
3. The original `statusLine.command` is preserved at `<claude-root>/plugins/creditgauge/state/upstream-cmd.sh` and `<claude-root>/plugins/creditgauge/state/upstream-cmd.txt` — sibling of `config.json`, **stable** across `/plugin install` rolls and cache wipes.
4. The `statusLine` is rewritten to invoke our wrapper, which sets `CREDITGAUGE_UPSTREAM_CMD=<upstream-cmd.sh>` so the original statusline runs above our line.
5. **`statusLine.refreshInterval` is managed**: if missing, it's created at `10`. If present and `> 10`, it's clamped down to `10` and a notice is printed to stdout (`install.sh: clamped statusLine.refreshInterval from N to 10 — set it back manually if you want to keep N`). Values `≤ 10` are left alone.

`install.sh` auto-builds `dist/index.js` if it's missing (the marketplace install only copies source, not the bundle). Re-running the slash command is always a no-op once installed.

### Install-journal (write-ahead log)

Every change `install.sh` makes to `settings.json` is recorded as a per-field entry in `<claude-root>/plugins/creditgauge/state/install-journal.json`. Three entry kinds:

| `action`     | Meaning                                                            |
| ------------ | ------------------------------------------------------------------ |
| `create`     | The field did not exist before install; `after` is the value we wrote. |
| `mutate`     | An existing field was changed; `before`/`after` snapshot both sides. |
| `clamp-down` | An over-threshold value was clamped (e.g. `refreshInterval` 30 → 10). |

Each entry has `{id, ts, action, before, after}`. The journal is the **authoritative record** of what install did — uninstall reads it (see below) to revert only the parts the user hasn't touched since. The journal itself lives in the **preserved** group (sibling of `config.json`), so `:uninstall` keeps it around unless you pass `--completely`. Hand-editing the file is supported; just keep the schema.

If you want to preview what install will do, run `/creditgauge:install --dry-run` first.

If your active `settings.json` doesn't exist at the project level, install creates a minimal one (with `permissions.defaultMode: bypassPermissions`). It does **not** copy from the user-level file.

### Restore from backup

```
/creditgauge:install --restore
```

Replaces the active `settings.json` with the most recent `settings.json.bak.<ts>`. Useful if you want to roll back an edit that wasn't made by us.

## Commands

Seven slash commands ship with the plugin:

| Command                       | What it does                                                              |
| ----------------------------- | ------------------------------------------------------------------------- |
| `/creditgauge:install`           | Wire the wrapper into `settings.json` (or `--restore`).                  |
| `/creditgauge:uninstall`         | Restore `settings.json`, wipe cache + marketplace + loader rows.         |
| `/creditgauge:clean`             | Trim old `.bak.<ts>` files (keeps the most recent per file).             |
| `/creditgauge:clean-cache`       | Remove stale version dirs from the plugin cache, keeping only the newest. |
| `/creditgauge:clean-journal`     | Remove old .jsonl journal files under state/<projectHash>/ by age or --all.                                                                  |
| `/creditgauge:reset`             | Wipe the 3 cache files for the current project only (cache.json, state.json, cache.stat.json); preserves diagnostics + token-sample history. |
| `/creditgauge:config`            | Read config state; switch statuslineTemplate preset; disable/enable upstream. |

Each is a Pattern B2 slash command — the body is a `!`-fenced shell block that loads `scripts/<name>.sh` directly via `${CLAUDE_PLUGIN_ROOT}`, with `allowed-tools` scoped to that script. See [Project layout](#project-layout) for the file map.

## Uninstall

```
/creditgauge:uninstall
```

This is a self-contained cleanup that works even after the plugin's cache and marketplace have been wiped. It does all of the following:

1. **Restore `statusLine`** — strategy in order:
   - If `<claude-root>/plugins/creditgauge/state/install-journal.json` has unapplied entries, apply them **field-by-field**: each entry's `after` is compared against the *current* `settings.json`; matching fields are reverted (created → removed, mutated → restored to `before`, clamped → restored to `before`), and fields the user changed after install are left alone. This is the journal-driven path — the **default for any install that ran with the journal writer enabled**.
   - Else (legacy / pre-journal install), fall back to `${CLAUDE_ROOT}/plugins/creditgauge/state/upstream-cmd.txt` (byte-for-byte restore of the original command).
   - Else, fall back to the most recent `settings.json.bak.<ts>` whose `statusLine.command` does **not** point to our wrapper (the state before the plugin was installed).
   - Else, strip the marker but leave the wrapper in place and print a warning.
2. **Remove `creditgauge@creditgauge` from `settings.json.enabledPlugins`** (other plugins preserved).
3. **Remove `creditgauge` from `settings.json.extraKnownMarketplaces`** (Claude Code records the marketplace source there too — leaving it would re-add the marketplace on next `/plugin marketplace add` with no visible diff).
4. **Wipe** `cache/creditgauge/`, `marketplaces/creditgauge/`, and the loader's leftover `marketplaces/cwf818-creditgauge/` alias.
5. **Strip the plugin's row** from `installed_plugins.json` and `known_marketplaces.json` (with timestamped `.bak.<TS>` backups).
6. **Trim old `.bak.<ts>` files** — invokes `scripts/clean.sh` as the final step so uninstall leaves a tidy filesystem (one newest backup per file). User-named backups like `settings.json.bak-pre-v0.1.8` are NOT touched.

`settings.json` and the two JSON files are backed up **before** any destructive change. Line endings (CRLF/LF) are preserved. The script is **idempotent** — re-running on a clean system prints `nothing to do` and exits 0. Add `--dry-run` to preview actions without modifying anything.

The `env` block of `settings.json` (including your `ANTHROPIC_AUTH_TOKEN`) is **not** touched. The script runs locally with no API calls and never reads `ANTHROPIC_AUTH_TOKEN`.

After uninstall, re-install with the four-step flow:

```
/plugin marketplace add cwf818/creditgauge
/plugin install creditgauge@creditgauge
/reload-plugins
/creditgauge:install
```

For dev iteration, `npm run dev:uninstall` (or `npm run dev:uninstall:dry`) does the same thing from the command line.

## Clean

```
/creditgauge:clean
```

Removes the old `.bak.YYYYMMDDTHHMMSS` backup files our installer leaves behind, keeping only the most recent one per base file:

- `settings.json.bak.<ts>` → keeps the newest
- `installed_plugins.json.bak.<ts>` → keeps the newest
- `known_marketplaces.json.bak.<ts>` → keeps the newest

User-named backups (e.g. `settings.json.bak-pre-v0.1.8`) are **not** touched — only the script-generated timestamp pattern. Idempotent: if at most one backup exists per file, prints `nothing to clean` and exits 0. Add `--dry-run` to preview.

The uninstall slash command already runs `clean.sh` as its final step, so explicit cleanup is usually unnecessary after a fresh uninstall. Use the clean command directly if you want to tidy up between installs, or if you've accumulated a lot of `.bak.<ts>` files from earlier dev iteration.

For dev iteration, `npm run settings:clean` (or `npm run settings:clean:dry`) does the same thing from the command line.

## Clean cache

```
/creditgauge:clean-cache
```

Every `/plugin install` rolls the cache forward — Claude Code creates a new `<version>` directory under `<cache>/creditgauge/` but does **not** remove the previous one. Old version dirs pile up over time (~40-50 MB each: full source tree + node_modules). The `statusLine.command` written by `:install` is already version-independent — it `ls -d`s every version dir, sorts by version, and `exec`s the highest — so old dirs are pure dead weight.

`/creditgauge:clean-cache` walks the cache, finds all `^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$` version directories, sorts numerically (so `0.2.10` sorts AFTER `0.2.9`, not lexically), keeps the newest, and removes the rest.

**Safety:** non-version entries (`.in_use`, `.orphaned_at_*`, hidden dirs, files, anything not matching the version regex) are left untouched. Idempotent: re-running is a no-op once only the newest remains. Add `--dry-run` to preview.

## How it composes with other statuslines

- The wrapper script is `scripts/wrapper.sh`. If `CREDITGAUGE_UPSTREAM_CMD` is set, it runs that path as a bash script (`bash "$CREDITGAUGE_UPSTREAM_CMD"`), captures stdout, and exposes it to the plugin entry as the `CREDITGAUGE_UPSTREAM` env var. If unset, the wrapper runs the plugin as the sole statusline.
- `CREDITGAUGE_UPSTREAM_CMD` is an **absolute path** to a bash script — `install.sh` writes one at `${CLAUDE_ROOT}/plugins/creditgauge/state/upstream-cmd.sh` whose body is `exec bash -c '<original-command>'`. This path is **stable** (sibling of `config.json`, NOT inside the per-version cache dir), so `/plugin install` rolls don't move it.
- The plugin preserves interior newlines in upstream output and injects `\x1b[0m` before its own line if upstream ends with an unclosed ANSI SGR — so multi-line, ANSI-colored upstream statuslines render correctly.

## Activation

The plugin picks a **provider** from `ANTHROPIC_BASE_URL` and renders exactly one line:

| `ANTHROPIC_BASE_URL`                    | Line                     | API                                                  |
| --------------------------------------- | ------------------------ | ---------------------------------------------------- |
| `https://api.minimaxi.com/anthropic`    | `Usage: …` / `Remain: …` | `GET https://www.minimaxi.com/v1/token_plan/remains` |
| `https://api.deepseek.com/anthropic`    | `Balance: …`             | `GET https://api.deepseek.com/user/balance`          |
| anything else (vanilla Anthropic, etc.) | (hidden)                 | —                                                    |

Both endpoints are called with `Authorization: Bearer $ANTHROPIC_AUTH_TOKEN` — the same token, no new env vars. The provider table lives in the `providers` config block (see [MANUAL.md §3](./MANUAL.md#3-providers)). On vanilla Anthropic, OpenRouter, or any other provider the plugin doesn't recognize, the line is hidden and any upstream output passes through unchanged.

### MiniMax token-plan line

<pre>
 Usage: ▓▓▓░░░░░ 38% 🕖47m·5h · ▓▓▓░░░░░ 39% 🕓4d47m·7d
Remain: ░░░▓▓▓▓▓ 62% 🕖47m·5h · ░░░▓▓▓▓▓ 61% 🕓4d47m·7d
</pre>

Two windows (5-hour + weekly), split-bar with colored percentage, reset
glyph + countdown, window label after a `·`. The bar
glyphs flip in remaining mode — both modes read left-to-right as
"what's spent → what's left":

- `used` mode: `▓▓▓▓▓░░░` — `▓` is consumed (colored), `░` is remaining (plain)
- `remaining` mode: `░░░░░▓▓` — `░` is consumed (plain), `▓` is remaining (colored)

The reset countdown uses the shared time-formatting template:

| Remaining | Rendered  | Note                                       |
| --------- | --------- | ------------------------------------------ |
| `-1ms`    | `0s`      | past-due, explicit "this window has reset" |
| `30s`     | `30s`     |                                            |
| `5m`      | `5m`      |                                            |
| `60m`     | `1h0m`    | internal zero preserved                    |
| `90m`     | `1h30m`   |                                            |
| `24h`     | `1d0h`    |                                            |

`maxUnitCount` (default `2`) controls how many units are shown. Leading
zeros are dropped (`0d0h5m` → `5m`); internal and trailing zeros are
kept (`2h0m` → `2h0m`, NOT `2h`). See `timeFormat.maxUnitCount` in
[MANUAL.md §2](./MANUAL.md#2-top-level-schema) for the full set of options.

### DeepSeek balance line

When `ANTHROPIC_BASE_URL` matches the configured `providers.deepseek` entry (default: exact match against `https://api.deepseek.com/anthropic`), the plugin fetches the user's account balance and renders:

```
Balance: ¥110.00             # is_available=true, single CNY entry
Balance: $25.00               # is_available=true, single USD entry
Balance: ¥110 · $3.5         # multi-currency: ALL entries from balance_infos,
                             # joined by ' · ', each entry colored independently
                             # by its own balance.
Balance: not available!       # is_available=false or no parseable entries
```

Per-currency display prefix: `USD` → `$`, `CNY` / `RMB` → `¥`. Any other
currency code is rendered as itself, uppercased (e.g. `EUR42.50`).

5-band color thresholds on **each entry's** numeric value
(`thresholds.balanceBands`, default `[5, 10, 20, 50]`) — see [MANUAL.md §2](./MANUAL.md#2-top-level-schema).

## Display mode

Default mode is **`remaining`** — the line begins with `Remain:` and the percentage shown is the percentage of the window you've left. The colored bar segment represents the remaining portion.

Switch to `used` mode via the config file:

```json
{ "display": "used" }
```

See [MANUAL.md §2](./MANUAL.md#2-top-level-schema) for the full schema.

In used mode the line begins with `Usage:` and the percentage is what's been consumed; the colored bar segment represents the consumed portion.

`display` is MiniMax-only — DeepSeek's `Balance:` line doesn't have a percentage to flip. The window / context-window / mem-usage modules (`m_windowQuota|term:short|mid|long`, `m_windowContext`, `m_windowMemUsage`) also accept an inline `|display:used|remaining` override that takes precedence over the global `display` for that one module.

## Configuration

The full schema (top-level keys, provider entries, presets, fragments, inline-args grammar, module reference) lives at [MANUAL.md §2 Configuration](./MANUAL.md#2-top-level-schema).

Path:

- **Unix**: `~/.claude/plugins/creditgauge/config.json`
- **Windows**: `%USERPROFILE%\.claude\plugins\creditgauge\config.json`

Loaded once at startup. **Missing file** → all defaults. **Malformed JSON** or a **single bad field** → one stderr line (`creditgauge: config <reason>; using defaults`) and the default for _that_ field only — the rest of your config is still honored. The plugin never blanks the statusline on bad config.

A reference with every field is at [config.example.json](./config.example.json). Copy it to the path above and edit.

## Diagnostics log

Opt-in JSONL log of plugin-internal events. Gated by two-level AND-gate:

1. Set the env var: `export CREDITGAUGE_DIAGNOSTICS_ENABLE=1`
2. Pick slices in `config.json`:
   ```json
   { "debug": { "stdin": true, "cache": true } }
   ```

Both must be truthy — env alone is no longer enough (v0.10.x behavior
change). 8 subkeys: `stdin`, `statusStore`, `config`, `cache`,
`statCache`, `smokeNormalizeTick`, `pluginVersion`, `parse`. See
[MANUAL.md SS20](./MANUAL.md#20-debug-logging) for the full subkey
table, truthy-value rules, and file location.

The log file lives at:
```
~/.claude/plugins/creditgauge/state/<projectHash>/diagnostics.jsonl
```

Capped at the last 1000 entries. Use it as a postmortem trail —
`tail -f` while debugging, or `grep` by level and source. Wipe with
`/creditgauge:reset` (per-project) or `/creditgauge:clean --purge-runtime`
(all projects).

## Auth

The plugin reuses `process.env.ANTHROPIC_AUTH_TOKEN` to call the provider's plan endpoint. **No new env vars.** See [SECURITY.md](./SECURITY.md) for how the token is handled.

## Caching

The Claude Code statusline is updated in response to interaction events by default (every prompt, every tool result). Starting with **Claude Code 2.1.97**, the `statusLine.refreshInterval` field is honored, letting the statusline refresh on a fixed cadence instead. Two scopes of "refresh interval" are involved and they're independent:

- **This plugin's 60 s TTL** — how long we cache a successful API response before re-fetching. MiniMax and DeepSeek have different rate-limit policies and refresh cadences; 60 s is a deliberate default that keeps the statusline responsive without hammering the API. Cache entries are shadowed to disk under the top-level `state/cache.json` (sibling of `config.json`, wiped by `:uninstall`), so the TTL is honored **across per-tick child-process spawns** — the second tick within 60 s reuses the first tick's value instead of re-fetching. Rows are keyed by provider id (the data row under the provider id, the plugin-source kind under `<provider>:pluginSource`), so different providers never collide on the same file.
- **Claude Code's `statusLine.refreshInterval`** — how often the harness invokes the statusline command. Set in `~/.claude/settings.json` independently of this plugin:

  ```json
  {
    "statusLine": {
      "type": "command",
      "command": "...",
      "refreshInterval": 60
    }
  }
  ```

  Unit is **seconds** (not milliseconds — that's a frequent footgun; the harness will reject or misbehave on values like `30000`). For this plugin, **30–120 s is a sensible range**: shorter than the 60 s TTL is wasted, much longer and the line lags behind reality. The `refreshInterval` value does **not** affect the API-call TTL — they are independent knobs.

  This plugin **manages `statusLine.refreshInterval`** as part of `:install`: if the field is missing, it's created at `10`; if it exceeds `10`, it's clamped down to `10` (with a stdout notice). See [Install-journal](#install-journal-write-ahead-log) below. Set it back manually if you want a higher cadence — uninstall will respect whatever value you chose.

### Failure handling

Three outcomes when the provider API is called:

| Outcome                    | What you see on the statusline                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh fetch                | The normal `Usage: …` / `Balance: …` line, no suffix on the default template. (Includes within-TTL cache hits — the broken-chain suffix is reserved for stale state. If your template includes `m_age`, you'll see a healthy `🔗 X ago` here instead.) |
| Fetch failed, cache exists | The last good value, **with a dim `⛓️‍💥 X ago` suffix** at the end (e.g. `Balance: ¥110 ⛓️‍💥 5m ago`). The broken-chain emoji IS the indicator (no leading separator).   |
| Fetch failed, no cache     | `Usage: not available!` (MiniMax) or `Balance: not available!` (DeepSeek) in red. Plugin is alive but the provider is unreachable.                                            |

The `X ago` format uses the **same template as the reset countdown**:
d/h/m units, `maxUnitCount=2` default, drop leading zeros but keep
internal/trailing zeros. Sub-minute follows `timeFormat.minUnit`:
`minUnit="m"` → `<1m ago`; `minUnit="s"` → `${seconds}s ago`. Examples
(with default `minUnit="s"`):

| Cached age  | Rendered suffix        |
| ----------- | ---------------------- |
| 30 s        | `⛓️‍💥 30s ago`          |
| 5 min       | `⛓️‍💥 5m ago`           |
| 90 min      | `⛓️‍💥 1h30m ago`         |
| 24 h        | `⛓️‍💥 1d0h ago`          |

The hard-fail `not available!` line intentionally has no age suffix
because there is no cached value to be stale-OF.

## Develop

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test             # node --test --import tsx src/**/*.test.ts
npm run build        # esbuild → dist/index.js
npm run dev          # esbuild --watch
```

### Per-tick pipeline

The per-tick pipeline is split between **data-processor (writes)** and **render (reads)** — owned by `src/data-processor.ts` and `src/tick-state.ts`. The render code (`src/render.ts`) is **read-only** against `tickState.pending`; it never calls `tickState.mark` / `setAvg` / `setPrevTick` / `setLastSpeed` / `setLastApiMs` / `setLastTokenHitRate`. Writes are coalesced into a single `commit()` flush per tick — at most one full-file rewrite of `state/<projectHash>/status.json` even on active renders.

### Response shape

The MiniMax plugin (`src/plugins/minimax/index.js`) projects the raw response into canonical `Quota` directly — there's no host-side parser layer to describe here. See [HOW_TO_CREATE_A_PLUGIN.md](./HOW_TO_CREATE_A_PLUGIN.md) for the plugin ABI and `src/plugins/minimax/index.js` for the worked example.

If `base_resp.status_code ≠ 0`, the response is treated as failure and the line is omitted.

The verified real shape (captured against `https://www.minimaxi.com/v1/token_plan/remains`):

```json
{
  "model_remains": [
    {
      "model_name": "...",
      "current_interval_remaining_percent": 60,
      "current_weekly_remaining_percent": 92,
      "end_time": "...",
      "weekly_end_time": "..."
    }
  ],
  "base_resp": { "status_code": 0 }
}
```

The plugin picks the entry with the **lowest interval remaining %** as the source of truth (the most-active model). If you capture a fresh response and the shape diverges, save it as `src/__fixtures__/remains.real.json` and tighten the parser in `src/plugins/minimax/index.js`.

The DeepSeek response shape is simpler — `{ is_available: bool, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }, ...] }` — and the parser iterates **all** entries so every currency the account holds is rendered.

### Dev loop: re-installing the plugin from scratch

When iterating on the install flow (changes to `scripts/install.sh`, `scripts/uninstall.sh`, the slash commands, the version, etc.) you need to fully wipe the plugin's on-disk state before `/plugin install` will re-fetch a clean copy. The plugin loader caches marketplace state and refuses to bump an already-installed plugin — on Windows this surfaces as `EPERM: operation not permitted, rename ... -> ... .bak`.

Use the bundled dev helper (does **not** touch `settings.json` — your statusLine is preserved):

```bash
# Preview what will be removed:
npm run dev:uninstall:dry

# Wipe creditgauge state:
npm run dev:uninstall
```

It removes:

- the creditgauge row from `installed_plugins.json` and `known_marketplaces.json` (with timestamped `.bak.<ts>` backups of both files).
- `cache/creditgauge/`, `marketplaces/creditgauge/`, and the loader's leftover `marketplaces/cwf818-creditgauge/` directory.

Then re-install:

```
/plugin marketplace add cwf818/creditgauge
/plugin install creditgauge@creditgauge
/reload-plugins
/creditgauge:install
```

If the loader still says "EPERM" after `dev:uninstall`, the most common cause is a Claude Code process holding a file lock on the marketplace dir. **Quit all running Claude Code sessions** (not just this one) and re-run `npm run dev:uninstall`.

## Project layout

```
src/
  index.ts            # entry — stdin drain, provider dispatch, cache, render, compose
  types.ts            # Provider = string | null; ProviderType / CompareMethod / ProviderEntry
  providers.ts        # URL matching, fetcher / template / fail-label dispatch
  plugins/minimax/index.js    # Quota fetch + tolerant parser for /v1/token_plan/remains
  plugins/deepseek/index.js   # BALANCE fetch + parser for /user/balance
  api.quote.ts        # m_quote remote fetch + dot-path scan
  quotes.ts           # bundled quotes.json (100+ bilingual entries) — m_quote local fallback
  render.ts           # read-only against tickState.pending; MODULES + INLINE_RENDERERS + INLINE_SCHEMAS dispatchers
  data-processor.ts   # processTick + setPrevTick + setAvg + setLastSpeed/ApiMs/TokenHitRate — owns ALL writes to tickState.pending
  tick-state.ts       # per-tick in-memory Store: beginTick / mark / commit
  status-store.ts     # three-layer acc (session/project/model) + cold-slot JSONL replay + stat cache
  cache.ts            # 60s TTL + stale-on-error; per-project cache.json shadowing
  composition.ts      # reads CREDITGAUGE_UPSTREAM, prepends (preserving ANSI/multi-line) and appends line
  config.ts           # loads ~/.claude/plugins/creditgauge/config.json; module-level singleton store
  diagnostics.ts      # JSONL append logger (opt-in via CREDITGAUGE_DIAGNOSTICS_ENABLE); 1000-line cap
  dispatch.ts         # providerType → module-set dispatch (provider-aware gating)
  git-info.ts         # m_branch / m_gitStatus read-side helpers (cwd-based)
  session-parse.ts    # parseTokenSnapshot — stdin JSON → TokenSnapshot; m_tokenTotalIn invariant check
  token-store.ts      # append-only JSONL state file at state/<projectHash>/<sessionId>.jsonl for m_acc* / m_sum*
  __fixtures__/       # remains.real.json, balance.real.json, balance.multi.json, …
  *.test.ts           # node:test unit tests
.claude-plugin/
  plugin.json         # plugin manifest (declares commands, version, keywords)
  marketplace.json    # single-plugin marketplace wiring
commands/
  install.md          # /creditgauge:install slash command
  uninstall.md        # /creditgauge:uninstall slash command
  clean.md            # /creditgauge:clean slash command
  clean-cache.md      # /creditgauge:clean-cache slash command
  config.md            # /creditgauge:config slash command
scripts/
  wrapper.sh          # bash wrapper: CREDITGAUGE_UPSTREAM_CMD → CREDITGAUGE_UPSTREAM → us
  install.sh          # settings.json patcher (install only)
  uninstall.sh        # self-contained uninstaller (used by :uninstall and dev:uninstall)
  clean.sh            # trim old .bak.<ts> files; --purge-runtime also wipes state/<projectHash>/{cache.json,diagnostics.jsonl,*.jsonl}
  clean-cache.sh      # prune old version dirs under cache/creditgauge/, keep newest
  migrate-state.sh    # legacy state/token-samples/<hash>/<sid>.jsonl → state/<hash>/<sid>.jsonl
  dev-uninstall.sh    # DEV-ONLY thin shim → exec uninstall.sh
  lib/edit-settings.mjs  # ESM helper used by install.sh
  test-edit-settings.sh  # shell regression tests for edit-settings.mjs
  test-install.sh        # shell regression tests for install.sh (isolated tmpdir)
  test-clean-cache.sh    # shell regression tests for clean-cache.sh
settings.example.json # template (NEVER commit real settings.json)
```

## What's new

**v1.1.9** — Token cost tracking at processTick time (cost stored in JSONL + accumulator, survives across sessions via replay); dedicated `config.tokenPrices.json` with 5-layer cascade; default provider filter on `m_sum*` modules now defaults to all models instead of active-only; install-journal change report display with tiered command handling; ⏱️ API ms integrated into default statusline preset; unified ¥ (U+00A5) symbol; fix uninstall.sh `set -u` crash.

**v1.1.8** — New `creditgauge-plugin` CLI (`npx creditgauge plugin add/remove/auth/list`) for query plugin lifecycle management; new opencode.ai workspace quota plugin; query plugin metadata registry (`query_plugins/plugins.json`). Supports `opencode`, `bigmodel`, `copilot-api`, `kimi` out of the box.

**v1.1.7** — New `npx creditgauge install` (auto-mirrors into plugin cache on cache miss, no marketplace required); new `/creditgauge:reset` slash command to wipe per-project runtime caches; new `standard-slim` preset with compressed header row and reduced spacing.

**v1.0.0** — Renamed from `topgauge` to `creditgauge` (hard cut, no compat shim). See CHANGELOG for the rename history (`tokenplan-usage-hud` → `topgauge` v0.7.0 → `creditgauge` v1.0.0).

**v0.9.7** — Install-journal: `install.sh` records every per-field change to `settings.json.statusLine` to a write-ahead log; `uninstall.sh` reverts field-by-field, preserving any field the user touched after install.

**v0.9.6** — `m_sumEstQuota|term:short` projects the spent cost up to a full-period spend using the aligned plan window's `used%`. Renders `est:$30.20` (fixed 2dp, per-model currency). Prefix is configurable via `labels.labelEstQuota` (default `"est:"`).

> Requires `tokenPrices.<modelId>` to be configured for the target model (see MANUAL §m_tokenCost). Without it, the module renders `est:n/a`.

## License

MIT — see [LICENSE](./LICENSE).