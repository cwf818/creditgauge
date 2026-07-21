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
already-owned statusLine (the `statusLine.command` string still points to our
wrapper) is a no-op — the check uses `isOurWrapperCommand()`, not the
`_creditgauge_managed` marker (which is informational only).

Also seeds `config.tokenPrices.json` (sibling of `config.json`) if absent,
providing a global default price entry for the cost modules (`m_tokenCost` /
`m_accTokenCost` / `m_sumTokenCost`). Existing files are never overwritten.

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