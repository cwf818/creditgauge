---
description: Read or modify creditgauge runtime config — switch statuslineTemplate to a preset, force a provider, or disable/enable the upstream chain
argument-hint: "[--preset-<name> | --provider-<id> | --clear-provider | --disable-upstream | --enable-upstream] [--dry-run]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/config.sh:*)"]
---

# creditgauge :config

Reads or modifies creditgauge's runtime config. Runs locally with no network
access and never prints `ANTHROPIC_AUTH_TOKEN`.

- **No arguments** — prints the current status: which `statuslineTemplate`
  preset is active, the `providerOverride` (if any), and whether the upstream
  statusline chain is enabled.
- **`--preset-<name>`** — sets `statuslineTemplate` to the named preset in
  `~/.claude/plugins/creditgauge/config.json`. All other config keys and the
  file's line ending are preserved; an absent config.json is created. A custom
  `string[]` template is replaced (with a notice). Valid presets:
  `simple`, `compact`, `standard`.
- **`--provider-<id>`** — sets `providerOverride` to `<id>`, forcing that
  provider and skipping `ANTHROPIC_BASE_URL` matching. Use it for local proxies
  that share a host and differ only by an arbitrary port. **`<id>` must already
  be a key in the config's `providers` object** — otherwise the command exits
  with an error and writes nothing. If a plugin file for `<id>` isn't found, it
  still writes but prints a note (the statusline runtime re-checks and will warn
  and fall back to URL matching).
- **`--clear-provider`** — sets `providerOverride` back to `""` (URL matching
  applies again). A missing config.json is a no-op.
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
