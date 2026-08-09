---
description: Read or modify creditgauge runtime config — switch statuslineTemplate to a preset, or disable/enable the upstream chain
argument-hint: "[--preset-<name> | --disable-upstream | --enable-upstream] [--dry-run]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/config.sh:*)"]
---

# creditgauge :config

Reads or modifies creditgauge's runtime config. Runs locally with no network
access and never prints `ANTHROPIC_AUTH_TOKEN`.

- **No arguments** — prints the current status: which `statuslineTemplate`
  preset is active, and whether the upstream statusline chain is enabled.
- **`--preset-<name>`** — sets `statuslineTemplate` to the named preset in
  `~/.claude/plugins/creditgauge/config.json`. All other config keys and the
  file's line ending are preserved; an absent config.json is created. A custom
  `string[]` template is replaced (with a notice). Valid presets:
  `simple`, `compact`, `standard`.
- **`--disable-upstream`** — disables the upstream statusline chain by
  renaming `state/upstream-cmd.sh` → `state/upstream-cmd.sh.disabled`
  (the original command is preserved and can be re-enabled).
- **`--enable-upstream`** — re-enables a previously disabled upstream by
  renaming the file back.
- **`--dry-run`** — prints the actions without changing anything.

Multiple action flags may be combined in one invocation.

Execute the config script with whatever arguments were passed:

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/config.sh" $ARGUMENTS
```
