#!/usr/bin/env bash
# reset.sh — wipe the creditgauge runtime caches for the CURRENT project
# (no other project's caches are touched).
#
# Targets (all under ${CLAUDE_ROOT}/plugins/creditgauge/state/):
#   - cache.json         — provider data cache (state/cache.json; TOP-LEVEL
#                          single file shared across projects; per-project
#                          isolation is via `<projectHash>:` key prefix in
#                          src/cache.ts / src/render.ts, NOT by file split)
#   - state.json         — per-project tick / acc / prev-tick state
#                          (state/<projectHash>/state.json; v0.4.x Per-Project Layout)
#   - cache.stat.json    — cross-project sum/avg stat cache, regenerated
#                          on next read (TTL=300s gate either way)
#                          (state/cache.stat.json; v0.9.8+; top-level,
#                           sibling of upstream-cmd.sh under state/)
#
# Intent: when you suspect the runtime caches are corrupt / stale /
# misleading, blow them away and let the next tick rebuild from
# stdin + provider responses. After `:reset`, the next statusline
# tick will:
#   - see `cache.json` missing → fetch fresh from the provider API
#   - see `state.json` missing → cold-start tickState from stdin's
#     current_usage (prevTick assumed 0; no regression-reset on
#     the very first `setPrevTick` because there's no previous
#     totalApiMs to regress against)
#   - see `cache.stat.json` missing → next m_sum*/m_stat* read goes
#     through the MISS branch and re-aggregates from raw JSONL
#     samples (single 300s throttle before another flush)
#
# What is INTENTIONALLY preserved:
#   - state/upstream-cmd.sh + state/upstream-cmd.txt — install-time
#     state. Wiping these would break future uninstalls.
#   - state/config.json — user-authored config + query_plugins/ overrides.
#   - state/<projectHash>/<sessionId>.jsonl — append-only token-sample
#     history (debugging data; the m_sum* modules read from this).
#   - state/<projectHash>/diagnostics.jsonl — append-only warning log.
#     Use `clean.sh --purge-runtime` to wipe diagnostics + .jsonl too.
#   - state/<otherProjectHash>/** — never touched; reset is scoped to
#     the CURRENT project's hash dir.
#   - cache/creditgauge/*, marketplaces/creditgauge/* — slash command
#     wrapper / install.sh territory; not reset's business.
#
# Usage:
#   reset.sh                # wipe current project's 3 caches
#   reset.sh --dry-run      # print what would be removed, change nothing
#   reset.sh -h | --help
#
# Side effects:
#   - First tick after `:reset` shows potentially-worse data
#     (cold cache → may hit slow path; cold tickState → first
#     tick's m_tokenInSpeed / m_apiMs show "idle" STALE_COLOR
#     placeholders because there's no last-active baseline yet).
#     By tick 2 everything is back to normal.
#   - The next tick will make ONE API call per enabled provider
#     (no cache.json to read from). Tokens are not extra — same
#     rate as the first ever tick the user made.
#
# Idempotent: re-running with nothing to clean exits 0 with
# "nothing to reset". Local-only. Never reads ANTHROPIC_AUTH_TOKEN.
# No network access.
#
# Portable: Linux, macOS, Git Bash on Windows. Uses the same hash
# algorithm as src/status-store.ts:projectHash() — `[\\/:]` and
# whitespace/control chars → `-`, lowercase, cap 80 chars.

set -u

DRY_RUN=0

print_help() {
  sed -n '2,55p' "$0"
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "reset.sh: unknown argument: $arg" >&2
      echo "  usage: reset.sh [--dry-run]" >&2
      exit 2
      ;;
  esac
done

CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STATE_DIR="${CLAUDE_ROOT}/plugins/creditgauge/state"

# Hash algorithm lives in scripts/lib/project-hash.sh (single source
# of truth on the bash side, mirrors src/status-store.ts:projectHash()).
# The helper normalizes the input via cygpath -w / wslpath -w when
# running under a POSIX-on-Windows translation layer (Git Bash, WSL),
# so this script sees the same hash the TS runtime would for the same
# actual project.
# shellcheck source=./lib/project-hash.sh
. "$(dirname "$0")/lib/project-hash.sh"
PROJECT_HASH="$(project_hash "$PWD")"

# Defensive: if the tr/lower pipeline collapsed everything to dashes
# (e.g. an empty $PWD), refuse rather than wipe state/<dashes...>/.
# Also reject anything that contains a slash (projectHash output must
# not contain path separators — that would let an attacker-controlled
# $PWD escape the state dir).
case "$PROJECT_HASH" in
  "" | */* | *'\')
    echo "reset.sh: refusing to compute projectHash from CWD='$PWD'" >&2
    echo "  → derived hash '$PROJECT_HASH' is unsafe" >&2
    exit 2
    ;;
esac

CACHE_JSON="${STATE_DIR}/cache.json"
STATE_JSON="${STATE_DIR}/${PROJECT_HASH}/state.json"
STAT_JSON="${STATE_DIR}/cache.stat.json"

if [ ! -d "${STATE_DIR}" ]; then
  echo "reset.sh: nothing to reset — state dir does not exist (${STATE_DIR})"
  exit 0
fi

REMOVE_LIST=()
for f in "$CACHE_JSON" "$STATE_JSON" "$STAT_JSON"; do
  if [ -e "$f" ]; then
    REMOVE_LIST+=("$f")
  fi
done

if [ "${#REMOVE_LIST[@]}" = 0 ]; then
  echo "reset.sh: nothing to reset — all 3 cache files missing for projectHash=${PROJECT_HASH}"
  exit 0
fi

echo "reset.sh: plan (projectHash=${PROJECT_HASH})"
# Always print one line per target (existing → rm, missing → skip),
# so the user can tell which files would be touched and which are
# already absent (a missing state.json on first run, or post-reset,
# shouldn't read as "the script forgot that file").
for f in "$CACHE_JSON" "$STATE_JSON" "$STAT_JSON"; do
  if [ -e "$f" ]; then
    echo "  rm $f"
  else
    echo "  skip $f (not present)"
  fi
done

if [ "$DRY_RUN" = 1 ]; then
  echo "reset.sh: --dry-run, no changes made"
  exit 0
fi

for f in "${REMOVE_LIST[@]}"; do
  rm -f "$f"
  echo "reset.sh: removed $f"
done

echo "reset.sh: done — ${#REMOVE_LIST[@]} cache file(s) wiped for this project"
