---
description: Remove old .bak.<timestamp> backup files, keeping only the most recent per file
argument-hint: "[--project | --dry-run | --purge-runtime]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/clean.sh:*)"]
---

# creditgauge :clean

Targets the `.bak.YYYYMMDDTHHMMSS` files our install/uninstall scripts
leave behind:

- `settings.json.bak.<ts>`
- `installed_plugins.json.bak.<ts>`
- `known_marketplaces.json.bak.<ts>`

Keeps the most recent backup per file (sorted lexically — the ISO
timestamp is monotonic) and removes the rest. Does not touch user-named
backups like `settings.json.bak-pre-v0.1.8`. Idempotent — if at most one
backup exists per file, prints "nothing to clean" and exits 0.

Defaults to user-level (`~/.claude/`); pass `--project` for project-level
(cwd's `.claude/`).

## --purge-runtime

Pass `--purge-runtime` to also wipe the plugin's runtime state files.

v0.4.x+ Per-Project Layout: every `<projectHash>/` subdirectory under
`state/` is walked and the following files inside it are removed:

- `cache.json` — the on-disk fetch cache (60s TTL)
- `diagnostics.jsonl` — the persistent diagnostics log (only exists
  when `CREDITGAUGE_DIAGNOSTICS_ENABLE=1` has been set)
- `*.jsonl` — the per-session token-sample files backing the
  `m_acc*` / `m_sum*` module family.

After wiping all runtime files inside a project dir, the now-empty
directory itself is removed (via `rmdir` — fails safely on non-empty
dirs). Project dirs that still contain non-runtime files are left in
place.

`state/upstream-cmd.{sh,txt}` and `state/config.json` are NEVER
purged — they're managed by install/uninstall, not by per-tick IO,
and wiping them would break future uninstalls.

These files are user-level only — `--purge-runtime` is ignored
under `--project` (the state dir has no project-level counterpart).
Combined usage: `clean.sh --purge-runtime --dry-run` to preview.

The uninstall slash command (`/creditgauge:uninstall`) calls
this script as its final step (without `--purge-runtime`), so explicit
cleanup of backups is usually unnecessary after a fresh uninstall.
`--purge-runtime` is opt-in because the runtime state contains your
diagnostics history — only wipe when you actually want it gone.

Execute the clean script with whatever arguments were passed to this
command:

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/clean.sh" $ARGUMENTS
```