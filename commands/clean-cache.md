---
description: Remove stale version directories under the plugin cache, keeping only the newest
argument-hint: "[--dry-run]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/clean-cache.sh:*)"]
---

# creditgauge :clean-cache

Targets the version directories that accumulate under the plugin
cache after every `/plugin install` roll-forward:

```
${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/creditgauge/creditgauge/
  0.2.7/        ← old, no longer used
  0.2.7.1/      ← old, no longer used
  0.2.8/        ← currently live
```

The `statusLine.command` written by `:install` is version-independent —
it `ls -d`s every version dir, sorts by version, and execs the
highest. So old version dirs are pure dead weight (~40-50MB each: full
source tree + node_modules). This command:

- Walks the cache, finds all `^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$`
  dirs (3- or 4-component versions; everything else is treated as
  decoy and left alone — `1.2`, `.orphaned_at_*`, `not-a-version`,
  etc.).
- Sorts numerically (not lexically — `0.2.10` sorts AFTER `0.2.9`).
- Keeps the newest. Removes the rest.
- Supports `--dry-run` for preview.
- Does NOT touch any non-version dir, any file, or the wrapper
  statusline itself. Idempotent: re-running is a no-op once only the
  newest remains.

After `:clean-cache` you can run `:install` (or `/plugin install
creditgauge@creditgauge`) again to refresh the remaining dir, or
just leave it — `install.sh` will detect the carried state from
the previous version automatically.

Execute the clean-cache script with whatever arguments were passed to
this command:

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/clean-cache.sh" $ARGUMENTS
```