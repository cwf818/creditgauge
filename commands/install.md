---
description: Install the creditgauge (CreditGauge) statusline wrapper into Claude Code's settings.json (for uninstall use the dedicated :uninstall slash command)
argument-hint: "[--restore | --project | --dry-run]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/install.sh:*)"]
---

# creditgauge :install

The wrapper writes the latest-cache-dir command into `statusLine.command`,
backs up any pre-existing statusLine to `settings.json.bak.<ISO-timestamp>`,
and preserves the original command in `<claude-root>/plugins/creditgauge/state/upstream-cmd.sh`
(sibling of `config.json`, stable across `/plugin install` rolls and cache
wipes) so it can be re-invoked as the upstream. Re-running on an
already-managed statusLine is a no-op (`_creditgauge_managed: true`).

The script runs locally with no network access and never prints
`ANTHROPIC_AUTH_TOKEN`.

**Uninstalling:** v0.9.x dropped the legacy `--uninstall` flag that
this command used to forward. Use the dedicated `/creditgauge:uninstall`
slash command (which calls `scripts/uninstall.sh` directly — the
source of truth).

Execute the install script with whatever arguments were passed to this
command:

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" $ARGUMENTS
```