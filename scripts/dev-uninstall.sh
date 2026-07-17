#!/usr/bin/env bash
# dev-uninstall.sh — DEV-ONLY: wipe all on-disk state for creditgauge
# (CreditGauge) so /plugin install can re-fetch a clean copy from the
# marketplace.
#
# Functionally identical to /creditgauge:uninstall (which runs
# scripts/uninstall.sh). This script exists so the developer can run the
# same cleanup from `npm run dev:uninstall` even when the slash command
# can't be invoked (e.g. plugin not yet loaded, or being iterated on).
#
# Behavior (delegated to scripts/uninstall.sh):
#   - Restores settings.json.statusLine (from the stable
#     state/upstream-cmd.txt — sibling of config.json — or the most
#     recent pre-managed .bak.<ts>).
#   - Removes `creditgauge@creditgauge` from
#     settings.json.enabledPlugins.
#   - Wipes cache/creditgauge/, the marketplace dir, the
#     `cwf818-creditgauge` alias, AND the stable
#     plugins/creditgauge/state/ dir.
#   - Strips the plugin's row from installed_plugins.json and
#     known_marketplaces.json (with timestamped .bak.<TS> backups).
#   - Backs up settings.json before any destructive change.
#   - Idempotent. Local-only. Never reads ANTHROPIC_AUTH_TOKEN.
#
# Usage:
#   scripts/dev-uninstall.sh           # actually delete
#   scripts/dev-uninstall.sh --dry-run # show what would be deleted, no changes
#   npm run dev:uninstall              # same as scripts/dev-uninstall.sh
#   npm run dev:uninstall:dry          # same as scripts/dev-uninstall.sh --dry-run
#
# After this script, the user can re-run:
#   /plugin marketplace add cwf818/creditgauge
#   /plugin install creditgauge@creditgauge
#   /reload-plugins
#   /creditgauge:install
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$SCRIPT_DIR/uninstall.sh" "$@"