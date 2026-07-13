#!/usr/bin/env bash
# install.sh — install the topgauge (ToPGauge) wrapper into Claude
# Code's settings.json. For uninstalling use the dedicated
# /topgauge:uninstall slash command (which calls scripts/uninstall.sh
# directly — the source of truth).
#
# Usage:
#   install.sh                       # install at user-level (default)
#   install.sh --project             # install at project-level (cwd)
#   install.sh --restore [--project] # restore settings.json from .bak.<ts>
#   install.sh --dry-run [...]       # print actions, change nothing
#
# Behavior:
#   - Idempotent: re-running on an already-managed statusLine is a no-op.
#   - If a non-managed statusLine is found, the current settings.json is backed
#     up to settings.json.bak.<ISO-timestamp>, and the original statusLine
#     command is preserved in <claude-root>/plugins/topgauge/state/upstream-cmd.sh
#     (sibling of config.json) so the wrapper can invoke it as the upstream.
#     This location is STABLE across /plugin install rolls — the per-version
#     cache dir can come and go, but the state dir is permanent.
#   - Settings are rewritten via scripts/lib/edit-settings.js, which preserves
#     the original line ending (CRLF on Windows, LF elsewhere).
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

PROJECT_LEVEL=0
RESTORE=0
DRY_RUN=0
INSTALL_MODE=""
ORIGINAL_CMD=""
for arg in "$@"; do
  case "$arg" in
    --project) PROJECT_LEVEL=1 ;;
    --restore) RESTORE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *)
      echo "install.sh: unknown argument: $arg" >&2
      # v0.9.x — `--uninstall` was removed; point at the dedicated
      # /topgauge:uninstall slash command instead of letting the
      # generic "unknown argument" line cover it.
      if [ "${arg:-}" = "--uninstall" ]; then
        echo "install.sh: --uninstall was removed in v0.9.x; use the /topgauge:uninstall slash command (or scripts/uninstall.sh directly)." >&2
      fi
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
HELPER="${SCRIPT_DIR}/lib/edit-settings.mjs"
if [ ! -f "$HELPER" ]; then
  echo "install.sh: missing helper ${HELPER}" >&2
  exit 1
fi

CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PLUGIN_BASE="${CLAUDE_ROOT}/plugins/cache/topgauge/topgauge"
PLUGIN_DIR=$(ls -d ${PLUGIN_BASE}/*/ 2>/dev/null \
  | awk -F/ '{ print $(NF-1) "\t" $(0) }' \
  | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n \
  | tail -1 | cut -f2-)
# State lives at a STABLE location — sibling of config.json
# (~/.claude/plugins/topgauge/state/) — so it survives
# /plugin install rolls and cache wipes. v0.2.19 moved it here from
# the per-version ${PLUGIN_DIR}/state/ so a future uninstall can find
# the pre-managed command even after the cache has been cleaned.
STATE_DIR="${CLAUDE_ROOT}/plugins/topgauge/state"
UPSTREAM_CMD_FILE="${STATE_DIR}/upstream-cmd.sh"
UPSTREAM_CMD_ONLY="${STATE_DIR}/upstream-cmd.txt"
# v0.9.0+ — bundled query_plugins drop-in dir. Users can drop
# scripts at ~/.claude/plugins/topgauge/query_plugins/<provider>/
# index.js and wire a custom data source via providers.<provider>.
# ENDPOINT="" in their config. Created on every (re-)install; users
# who don't use it leave it empty. Symmetric with config.json
# (~/.claude/plugins/topgauge/config.json) — sibling of state/.
QUERY_PLUGINS_DIR="${CLAUDE_ROOT}/plugins/topgauge/query_plugins"
WRAPPER="${PLUGIN_DIR%/}/scripts/wrapper.sh"

if [ -z "$PLUGIN_DIR" ] || [ ! -f "$WRAPPER" ]; then
  echo "install.sh: cannot find plugin cache. Expected ${PLUGIN_BASE}/<version>/scripts/wrapper.sh" >&2
  echo "install.sh: install via '/plugin install topgauge@topgauge' first." >&2
  exit 1
fi

# Build the entry bundle and standalone built-in plugins on demand. The
# marketplace install copies the source tree but does not run npm build, so
# a fresh install needs all runtime artifacts before statusLine can start.
DIST_JS="${PLUGIN_DIR%/}/dist/index.js"
DIST_MINIMAX="${PLUGIN_DIR%/}/dist/plugins/minimax/index.js"
DIST_DEEPSEEK="${PLUGIN_DIR%/}/dist/plugins/deepseek/index.js"
if [ ! -f "$DIST_JS" ] || [ ! -f "$DIST_MINIMAX" ] || [ ! -f "$DIST_DEEPSEEK" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    echo "install.sh: --dry-run: would build runtime artifacts (${DIST_JS}, ${DIST_MINIMAX}, and ${DIST_DEEPSEEK}) (npm install && npm run build) in ${PLUGIN_DIR%/}"
  else
    if ! command -v npm >/dev/null 2>&1; then
      echo "install.sh: npm not found on PATH; cannot build runtime artifacts" >&2
      echo "install.sh: install Node.js (https://nodejs.org) and re-run." >&2
      exit 1
    fi
    echo "install.sh: runtime artifacts missing; running npm install + npm run build in ${PLUGIN_DIR%/}" >&2
    (
      cd "${PLUGIN_DIR%/}" || exit 1
      npm install --no-audit --no-fund || exit 1
      npm run build || exit 1
    ) || exit 1
  fi
fi

# Soft-runtime check: the v0.8.21 `m_quote|address|…` fetcher runs
# `curl` via `node:child_process.execFileSync`, which resolves
# `curl` on the GUI shell's PATH (NOT the user's interactive shell).
# Coverage by OS:
#   - macOS   : /usr/bin/curl ships since 10.6 ✓
#   - Linux   : present on every major distro ✓
#   - Windows : C:\Windows\System32\curl.exe ships since Win10 1803 ✓
#                (Windows 7/8 lacks it — users on those editions need
#                to install curl separately)
# We don't gate install on this — the plugin renders correctly
# without curl — but a heads-up helps users on locked-down or
# legacy systems notice the failure mode (m_quote stays blank
# and a diagnostics warning fires).
if ! command -v curl >/dev/null 2>&1; then
  echo "install.sh: WARNING: curl not found on PATH; m_quote|address|... will fall back to local QUOTES" >&2
  echo "install.sh: WARNING: install curl from https://curl.se and ensure curl.exe is on PATH" >&2
fi

# Ensure query_plugins/ exists so a provider-author can drop in a
# plugin without re-running install.sh. Skipped on --dry-run so the
# dry-run log doesn't claim success.
# (v0.9.x: the --uninstall thin shim that used to live here was
# removed; uninstall is now handled exclusively by /topgauge:uninstall.)
if [ "$DRY_RUN" != 1 ]; then
  mkdir -p "$QUERY_PLUGINS_DIR"
fi

# Resolve target settings file.
if [ "$PROJECT_LEVEL" = 1 ]; then
  TARGET=".claude/settings.json"
  if [ ! -f "$TARGET" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      echo "install.sh: --dry-run: would create ${TARGET} (project-level)"
    else
      mkdir -p .claude
      printf '{\n  "permissions": {\n    "defaultMode": "bypassPermissions"\n  }\n}\n' > "$TARGET"
    fi
  fi
else
  TARGET="${CLAUDE_ROOT}/settings.json"
fi

if [ ! -f "$TARGET" ]; then
  echo "install.sh: target settings file not found: ${TARGET}" >&2
  exit 1
fi

WIN_TARGET=$(winpath "$TARGET")
WIN_UPSTREAM=$(winpath "$UPSTREAM_CMD_FILE")
WIN_UPSTREAM_ONLY=$(winpath "$UPSTREAM_CMD_ONLY")
WIN_WRAPPER=$(winpath "$WRAPPER")

# --- Restoration path: replace target with most recent .bak.<ts> --------------
if [ "$RESTORE" = 1 ]; then
  BAK=$(ls -t "${TARGET}.bak."* 2>/dev/null | head -1 || true)
  if [ -z "$BAK" ]; then
    echo "install.sh: no backup file found at ${TARGET}.bak.<ts>" >&2
    exit 1
  fi
  if [ "$DRY_RUN" = 1 ]; then
    echo "install.sh: --dry-run: would restore ${TARGET} from ${BAK}"
    exit 0
  fi
  cp "$BAK" "$TARGET"
  echo "install.sh: restored ${TARGET} from ${BAK}"
  exit 0
fi

# --- Install path ------------------------------------------------------------

CURRENT=$(node "$HELPER" "$WIN_TARGET" status)

case "$CURRENT" in
  managed)
    # Carry the upstream-cmd forward into our stable STATE_DIR
    # (${CLAUDE_ROOT}/plugins/topgauge/state/), in case:
    #   - The user just upgraded from v0.2.18 (where state lived at
    #     the per-version cache dir); the OLD location still has the
    #     pre-managed command, and we need to move it to the new home.
    #   - The previous version's cache was wiped but a foreign-install
    #     state survived somewhere (rare).
    #   - The user manually deleted ${CLAUDE_ROOT}/plugins/topgauge/state/
    #     after uninstall but the settings.json still points at us.
    #
    # Sources to check, in priority order:
    #   1. The PREVIOUS per-version cache dir's state/ (v0.2.18 and older).
    #   2. The stable state dir itself (already populated — nothing to do).
    #
    # Only copy into STATE_DIR if it's currently missing upstream-cmd.txt
    # — we don't want to clobber a state we already have.
    if [ ! -f "$UPSTREAM_CMD_ONLY" ]; then
      PREV=$(ls -d ${PLUGIN_BASE}/*/ 2>/dev/null \
        | awk -F/ '{ print $(NF-1) "\t" $(0) }' \
        | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n \
        | tail -2 | head -1 | cut -f2-)
      if [ -n "$PREV" ] && [ "$PREV" != "${PLUGIN_DIR%/}/" ] && [ -f "${PREV%/}/state/upstream-cmd.txt" ]; then
        # Create STATE_DIR first (-p is idempotent). Even on a fresh
        # install this is the first time the dir exists.
        mkdir -p "$STATE_DIR"
        # Copy each file individually so we never overwrite a file
        # that's already in place. cp -n is "no clobber" on POSIX/
        # Git-Bash; fall back to a guarded loop on systems where it's
        # not available.
        if cp -n "${PREV%/}/state/upstream-cmd.sh" "${STATE_DIR}/upstream-cmd.sh" 2>/dev/null \
           && cp -n "${PREV%/}/state/upstream-cmd.txt" "${STATE_DIR}/upstream-cmd.txt" 2>/dev/null; then
          : # cp -n succeeded — both files came from PREV
        else
          for f in upstream-cmd.sh upstream-cmd.txt; do
            if [ ! -f "${STATE_DIR}/${f}" ] && [ -f "${PREV%/}/state/${f}" ]; then
              cp "${PREV%/}/state/${f}" "${STATE_DIR}/${f}"
            fi
          done
        fi
        # Preserve the original exec bit — upstream-cmd.sh is invoked
        # as a bash script later (see uninstall.sh), so it must be
        # executable.
        chmod +x "${STATE_DIR}/upstream-cmd.sh" 2>/dev/null || true
        echo "install.sh: migrated legacy state/ from $(basename "${PREV%/}") to ${STATE_DIR}"
      fi
    fi
    echo "install.sh: ${TARGET} already managed by topgauge; no-op."
    exit 0
    ;;
  none)
    INSTALL_MODE="fresh"
    ORIGINAL_CMD=""
    ;;
  foreign:*)
    INSTALL_MODE="replace"
    ORIGINAL_CMD="${CURRENT#foreign:}"
    ;;
esac

if [ "$DRY_RUN" = 1 ]; then
  echo "install.sh: --dry-run summary"
  echo "  target:        ${TARGET}"
  echo "  mode:          ${INSTALL_MODE}"
  echo "  wrapper:       ${WRAPPER}"
  if [ "$INSTALL_MODE" = "replace" ]; then
    echo "  would back up: ${TARGET} -> ${TARGET}.bak.<ISO-timestamp>"
    echo "  would write:   ${UPSTREAM_CMD_FILE}"
    echo "  original cmd:  ${ORIGINAL_CMD}"
  fi
  SEED_TARGET="${CLAUDE_ROOT}/plugins/topgauge/config.json"
  if [ ! -f "$SEED_TARGET" ]; then
    echo "  would seed:    ${SEED_TARGET} (cacheTtlMs=60000, statuslineTemplate=standard, providers={}, labels glyph overrides)"
  else
    echo "  would keep:    ${SEED_TARGET} (already present)"
  fi
  echo "  new statusLine command will set TOPGAUGE_UPSTREAM_CMD to:"
  if [ "$INSTALL_MODE" = "replace" ]; then
    echo "    ${UPSTREAM_CMD_FILE}"
  else
    echo "    (empty — plugin runs as sole statusline)"
  fi
  exit 0
fi

if [ "$INSTALL_MODE" = "replace" ]; then
  TS=$(date +%Y%m%dT%H%M%S)
  cp "$TARGET" "${TARGET}.bak.${TS}"
  mkdir -p "$STATE_DIR"
  if [ ! -f "$UPSTREAM_CMD_ONLY" ]; then
    {
      printf '#!/usr/bin/env bash\n'
      printf '# Original statusLine.command preserved by topgauge install.sh\n'
      printf '# Restored via: install.sh --uninstall\n'
      printf 'exec %s\n' "$ORIGINAL_CMD"
    } > "$UPSTREAM_CMD_FILE"
    chmod +x "$UPSTREAM_CMD_FILE"
    # Also write the bare original command (no shebang/comments) so --uninstall
    # can re-embed it verbatim into statusLine.command.
    printf '%s\n' "$ORIGINAL_CMD" > "$UPSTREAM_CMD_ONLY"
    echo "install.sh: preserved original command at ${UPSTREAM_CMD_FILE}"
  else
    echo "install.sh: preserved existing upstream command at ${UPSTREAM_CMD_FILE}"
  fi
  echo "install.sh: backed up ${TARGET} -> ${TARGET}.bak.<TS>"
fi

# config.json seed: when the user has no config.json on disk, write a
# basic one so the runtime has a starting point (otherwise
# src/config.ts:loadConfig falls back to DEFAULT_CONFIG and only the
# two-module DEFAULT_STATUSLINE_TEMPLATE renders). Triggered on every
# install mode (fresh / replace / managed) — gated only on the file
# being absent — so a user who re-installs over a foreign statusLine
# still gets a config.json. Existing config.json files are NEVER
# overwritten: re-running :install is a strict no-op for the seed step.
#
# The body uses the `standard` preset (information / git / tick_eval /
# acc_eval / stat_eval / quota / balance / age / version — see
# DEFAULT_STATUSLINE_PRESETS in src/config.template.ts), pins
# `cacheTtlMs` to the runtime default, and carries the 8 label glyph
# overrides that match the standard preset's per-turn / acc / sum
# token modules. The remaining 14 label axes inherit DEFAULT_CONFIG
# defaults — callers who add `m_memUsage` / `m_quota` etc. get the
# canonical `Mem:` / `quota:` prefixes for free.
SEED_DIR="${CLAUDE_ROOT}/plugins/topgauge"
SEED_FILE="${SEED_DIR}/config.json"
if [ ! -f "$SEED_FILE" ]; then
  mkdir -p "$SEED_DIR"
  cat > "$SEED_FILE" <<'SEED_EOF'
{
  "cacheTtlMs": 60000,
  "statuslineTemplate": "standard",
  "providers": {},
  "labels": {
    "labelTokenIn":        "↓",
    "labelTokenOut":       "↑",
    "labelTokenInSpeed":   "↓",
    "labelTokenOutSpeed":  "↑",
    "labelTokenCachedIn":  "⧉ ",
    "labelTokenHitRate":   "⦿ ",
    "labelApiCalls":       "⎌ ",
    "labelTokenTotalIn":   "⌬ "
  }
}
SEED_EOF
  echo "install.sh: seeded basic config at ${SEED_FILE}"
fi

node "$HELPER" "$WIN_TARGET" write-managed "$WIN_WRAPPER" "$WIN_UPSTREAM"
echo "install.sh: installed wrapper into ${TARGET}"