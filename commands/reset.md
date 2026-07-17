---
description: Wipe the 3 cache files for the current project only (cache.json, state.json, cache.stat.json); preserves diagnostics + token-sample history
argument-hint: "[--dry-run]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/reset.sh:*)"]
---

# creditgauge :reset

Targets 3 runtime cache files for the **current project only** (other
projects' caches are never touched):

- `cache.json` — provider data cache (60s TTL on-disk shadow; top-level
  `state/cache.json` shared across projects — per-project isolation
  is via `<projectHash>:` key prefix, not by file split)
- `state.json` — per-project tick / acc / prev-tick state
  (`state/<projectHash>/state.json`)
- `cache.stat.json` — cross-project sum/avg stat cache (regenerated
  on next read; 300s TTL gate either way; top-level `state/cache.stat.json`)

When to use this:

- The statusline shows stale or wrong numbers (likely a corrupt
  `cache.json` from a provider schema change).
- `m_acc*` / `m_sum*` modules show weird values (stale `state.json`
  from an upgrade or a partially-failed tick).
- `cache.stat.json` is suspected of being stale or corrupt (rare;
  `m_statTtlStatus` should surface this).

What is INTENTIONALLY preserved:

- `state/upstream-cmd.{sh,txt}` and `state/config.json` — install /
  user state. Wiping these would break future uninstalls.
- `<sessionId>.jsonl` — append-only token-sample history (the data
  source for `m_sum*` modules).
- `diagnostics.jsonl` — append-only warning log.
- `<otherProjectHash>/**` — never touched.

Pass `--dry-run` to preview what would be removed without changing
anything.

Use `clean.sh --purge-runtime` to also wipe diagnostics + .jsonl, or
`uninstall.sh` to wipe everything. `:reset` is the targeted version
that keeps your history.

Execute the reset script with whatever arguments were passed:

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/reset.sh" $ARGUMENTS
```