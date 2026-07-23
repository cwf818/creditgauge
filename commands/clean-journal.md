---
description: Remove old .jsonl journal files under state/<projectHash>/ by age or --all
argument-hint: "[--days <N> | --all | --dry-run]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/clean-journal.sh:*)"]
---

# creditgauge :clean-journal

Targets the append-only JSONL token-sample history files at
`state/<projectHash>/<sessionId>.jsonl`. These accumulate over
time and can use significant disk space.

## Behavior

- **Default**: removes `.jsonl` files older than **7 days**
- `--days <N>`: remove files older than N days
- `--all`: remove ALL `.jsonl` journal files (use with caution)

## Safety

- Only removes files matching `*.jsonl` under `state/<projectHash>/`
- Never touches `diagnostics.jsonl`, `cache.json`, or `state.json`
- `--dry-run` previews what would be removed without deleting

## Examples

```
# Preview what files older than 7 days would be removed
/creditgauge:clean-journal --dry-run

# Remove files older than 30 days
/creditgauge:clean-journal --days 30

# Remove every journal file
/creditgauge:clean-journal --all
```
