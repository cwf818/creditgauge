#!/usr/bin/env bash
# config.sh — read/modify creditgauge's runtime config via the
# /creditgauge:config slash command.
#
# Usage:
#   config.sh                        # print current status (read-only)
#   config.sh --preset-<name>        # set statuslineTemplate to a preset name
#   config.sh --disable-upstream     # disable the upstream chain (rename state/upstream-cmd.sh -> .disabled)
#   config.sh --enable-upstream      # re-enable it (rename back)
#   config.sh --dry-run [...]        # print actions, change nothing
#   config.sh --help|-h
#
# Multiple action flags may be combined in one invocation; --dry-run is a
# modifier. The upstream toggle works by renaming the file in the STABLE
# state dir: wrapper.sh only runs the upstream when state/upstream-cmd.sh
# exists ([ -f "$CREDITGAUGE_UPSTREAM_CMD" ]), so a rename flips the switch
# without touching settings.json.
#
# Valid presets (MUST stay in sync with DEFAULT_STATUSLINE_PRESETS keys in
# src/config.template.ts): simple, compact, standard, solo.

set -u

DRY_RUN=0
ACTION_PRESET=""
ACTION_DISABLE=0
ACTION_ENABLE=0
HELP=0
VALID_PRESETS="simple compact standard solo"

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --disable-upstream) ACTION_DISABLE=1 ;;
    --enable-upstream) ACTION_ENABLE=1 ;;
    --preset-*)
      ACTION_PRESET="${arg#--preset-}"
      if [ -z "$ACTION_PRESET" ]; then
        echo "config.sh: --preset- requires a preset name" >&2
        echo "usage: /creditgauge:config [--preset-<name>] [--disable-upstream] [--enable-upstream] [--dry-run]" >&2
        exit 2
      fi
      ;;
    --help|-h) HELP=1 ;;
    *)
      echo "config.sh: unknown argument: $arg" >&2
      echo "usage: /creditgauge:config [--preset-<name>] [--disable-upstream] [--enable-upstream] [--dry-run]" >&2
      exit 2
      ;;
  esac
done

# Convert a POSIX-style path to the format Node.js prefers on this OS.
# On native Linux/macOS this is a no-op. On Git Bash it converts
# /c/Users/... -> C:\Users\... so Node doesn't read the path relative to cwd.
winpath() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$p" 2>/dev/null || echo "$p"
  else
    echo "$p"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER="${SCRIPT_DIR}/lib/edit-config.mjs"
if [ ! -f "$HELPER" ]; then
  echo "config.sh: missing helper ${HELPER}" >&2
  exit 1
fi

CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CONFIG_FILE="${CLAUDE_ROOT}/plugins/creditgauge/config.json"
STATE_DIR="${CLAUDE_ROOT}/plugins/creditgauge/state"
UPSTREAM_CMD="${STATE_DIR}/upstream-cmd.sh"
UPSTREAM_DISABLED="${STATE_DIR}/upstream-cmd.sh.disabled"
WIN_CONFIG_FILE="$(winpath "$CONFIG_FILE")"

# Classify the current statuslineTemplate into a human line. Mirrors the
# loader's own resolution: string = preset name, array = custom template.
template_status_line() {
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const presets = process.argv[2].split(" ");
    if (!fs.existsSync(p)) {
      console.log("(default — no config.json; quota/balance dispatch)");
      process.exit(0);
    }
    let d;
    try { d = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) { console.error("config.sh: config.json not valid JSON: " + e.message); process.exit(1); }
    const t = d && typeof d === "object" ? d.statuslineTemplate : undefined;
    if (typeof t === "string") {
      if (presets.includes(t)) console.log(t + "   (preset)");
      else console.log(t + "   (unknown preset; valid: " + presets.join(" ") + ")");
    } else if (Array.isArray(t)) {
      console.log("(custom template, " + t.length + " tokens)");
    } else {
      console.log("(no statuslineTemplate — default preset)");
    }
  ' "$WIN_CONFIG_FILE" "$VALID_PRESETS"
}

print_status() {
  echo "当前配置:"
  local tline
  tline="$(template_status_line)" || exit 1
  echo "  statuslineTemplate: ${tline}"
  if [ -f "$UPSTREAM_CMD" ]; then
    echo "  upstream:           enabled   (state/upstream-cmd.sh)"
  elif [ -f "$UPSTREAM_DISABLED" ]; then
    echo "  upstream:           disabled (preserved at state/upstream-cmd.sh.disabled)"
  else
    echo "  upstream:           none (no upstream was preserved)"
  fi
}

disable_upstream() {
  if [ -f "$UPSTREAM_CMD" ] && [ -f "$UPSTREAM_DISABLED" ]; then
    echo "config.sh: both ${UPSTREAM_CMD} and ${UPSTREAM_DISABLED} exist; resolve manually" >&2
    exit 1
  fi
  if [ ! -f "$UPSTREAM_CMD" ]; then
    if [ -f "$UPSTREAM_DISABLED" ]; then
      echo "upstream already disabled (no-op)"
    else
      echo "no upstream to disable (no upstream-cmd.sh found)"
    fi
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    echo "would disable upstream: rename state/upstream-cmd.sh -> state/upstream-cmd.sh.disabled"
    return 0
  fi
  if ! mv "$UPSTREAM_CMD" "$UPSTREAM_DISABLED"; then
    echo "config.sh: mv failed for upstream disable" >&2
    exit 1
  fi
  echo "disabled upstream: renamed state/upstream-cmd.sh -> state/upstream-cmd.sh.disabled"
}

enable_upstream() {
  if [ -f "$UPSTREAM_CMD" ] && [ -f "$UPSTREAM_DISABLED" ]; then
    echo "config.sh: both ${UPSTREAM_CMD} and ${UPSTREAM_DISABLED} exist; resolve manually" >&2
    exit 1
  fi
  if [ ! -f "$UPSTREAM_DISABLED" ]; then
    if [ -f "$UPSTREAM_CMD" ]; then
      echo "upstream already enabled (no-op)"
    else
      echo "no preserved upstream to enable"
    fi
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    echo "would enable upstream: rename state/upstream-cmd.sh.disabled -> state/upstream-cmd.sh"
    return 0
  fi
  if ! mv "$UPSTREAM_DISABLED" "$UPSTREAM_CMD"; then
    echo "config.sh: mv failed for upstream enable" >&2
    exit 1
  fi
  echo "enabled upstream: restored state/upstream-cmd.sh from state/upstream-cmd.sh.disabled"
}

if [ "$HELP" = 1 ]; then
  sed -n '2,20p' "$0"
  exit 0
fi

# No action flags -> read-only status view.
if [ -z "$ACTION_PRESET" ] && [ "$ACTION_DISABLE" = 0 ] && [ "$ACTION_ENABLE" = 0 ]; then
  print_status
  echo ""
  echo "用法: /creditgauge:config [--preset-<name>] [--disable-upstream] [--enable-upstream] [--dry-run]"
  exit 0
fi

if [ -n "$ACTION_PRESET" ]; then
  if ! echo " $VALID_PRESETS " | grep -qF " $ACTION_PRESET "; then
    echo "config.sh: unknown preset '${ACTION_PRESET}'; valid presets: ${VALID_PRESETS}" >&2
    exit 1
  fi
  if [ "$DRY_RUN" = 1 ]; then
    echo "would set statuslineTemplate: ${ACTION_PRESET} in ${CONFIG_FILE}"
  else
    # v2 — ensure the plugin config dir exists (fresh system without :install);
    # the node helper writes into it and would otherwise ENOENT.
    mkdir -p "$(dirname "$CONFIG_FILE")"
    node "$HELPER" "$WIN_CONFIG_FILE" set-preset "$ACTION_PRESET" || exit 1
  fi
fi

if [ "$ACTION_DISABLE" = 1 ]; then
  disable_upstream
fi

if [ "$ACTION_ENABLE" = 1 ]; then
  enable_upstream
fi
