---
description: Wipe runtime cache files for the current project (cache.json, state.json, cache.stat.json)
argument-hint: "[--dry-run]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/reset.sh:*)"]
---

# creditgauge :reset

Targets 3 runtime cache files for the **current project only** (other
projects' caches are never touched):

- `cache.json` — per-project provider data cache (60s TTL on-disk
  shadow; v0.4.x Per-Project Layout)
- `state.json` — per-project tick / acc / prev-tick state
- `cache.stat.json` — cross-project sum/avg stat cache; regenerated
  on next read (TTL=300s gate either way)

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
- `<sessionId>.jsonl` — append-only token-sample history (debugging
  data; `m_sum*` modules read from this).
- `diagnostics.jsonl` — append-only warning log.
- `<otherProjectHash>/**` — never touched.

Use `clean.sh --purge-runtime` to also wipe diagnostics + .jsonl, or
`uninstall.sh` to wipe everything. `:reset` is the targeted version
that keeps your history.

Pass `--dry-run` to preview what would be removed without changing
anything.

Execute the reset script with whatever arguments were passed:

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/reset.sh" $ARGUMENTS
```