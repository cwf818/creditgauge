---
description: Uninstall creditgauge (CreditGauge), restore settings.json, and wipe the plugin's cache, marketplace, and loader rows
argument-hint: "[--project | --dry-run | --completely]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/uninstall.sh:*)"]
---

# creditgauge :uninstall

Restores `settings.json` via the **install-journal** (primary path): each
field-level change made by `install.sh` is reverted if the current value still
matches the install snapshot; fields the user modified after install are
preserved. If no journal is available, falls back to the legacy path (stable
`plugins/creditgauge/state/upstream-cmd.txt` then most recent pre-managed
`settings.json.bak.<ts>`).

The ownership check uses the `statusLine.command` string itself
(`isOurWrapperCommand`) — the `_creditgauge_managed` marker is informational
only and is NOT required for uninstall to work.

After field-level restore, outputs a change report table showing which fields
were reverted, preserved, or required special handling.

Also strips `creditgauge@creditgauge` from `enabledPlugins` and
`extraKnownMarketplaces`, wipes `cache/creditgauge/`, the marketplace dir, and
the plugin's row from `installed_plugins.json` and `known_marketplaces.json`.
Backs up `settings.json` and the two JSON files with `.<name>.bak.<timestamp>`
before any destructive change. Runs `scripts/clean.sh` as its final step to
trim old backups (keeps only the most recent per file; user-named backups like
`settings.json.bak-pre-v0.1.8` are not touched). Idempotent — re-running on a
clean system prints "nothing to do" and exits 0.

**Default behavior (no flags)** is a *partial-preserve* uninstall: the
`state/` cache noise (`cache.json` / `cache.stat.json` /
`upstream-cmd.sh` / `upstream-cmd.txt` / per-project `state.json`) is
wiped, but your `config.json`, `query_plugins/` overrides, and the
per-project `<sessionId>.jsonl` token-sample history are preserved on
disk and listed in a post-uninstall hint so you can decide whether to
keep them or delete them manually.

**`--completely`** does a *full* uninstall: in addition to the cache
noise, it also nukes `config.json`, `query_plugins/`, and the `.jsonl`
history — equivalent to a fresh install afterwards. Use this when you
want to start from a clean slate.

The `env` block of `settings.json` is never touched (your
`ANTHROPIC_AUTH_TOKEN` and other env vars are preserved).

Execute the uninstall script with whatever arguments were passed to this
command:

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/uninstall.sh" $ARGUMENTS
```

After uninstall, re-install with:

```
/plugin marketplace add cwf818/creditgauge
/plugin install creditgauge@creditgauge
/reload-plugins
/creditgauge:install
```