#!/usr/bin/env bash
# migrate-state.sh — one-shot migration from the v0.4.0–v0.4.<n-1>
# token-samples layout to the v0.4.x+ per-project layout.
#
# v0.4.0 through v0.4.<n-1> stored token-sample JSONL files at:
#   state/token-samples/<projectHash>/<sessionId>.jsonl
#
# v0.4.x+ moves the per-session file up one level (no `token-samples/`
# intermediate) to make per-project isolation uniform across all
# runtime state files (cache.json, diagnostics.jsonl, sample jsonl):
#   state/<projectHash>/<sessionId>.jsonl
#
# Why a separate tool (not auto-migration):
#   - Auto-migration would add 3-10ms IO to every statusline tick.
#   - Sample data is time-decaying — a week-old sample contributes
#     little to m_sumTokenIn / m_sumTokenOut (sum/avg modules over
#     the 5h/7d window). Most users are better off re-accumulating
#     from a clean slate.
#   - `scripts/uninstall.sh` already wipes the entire state/ tree
#     on uninstall, so users who don't care about preserving
#     history have an easy "reset to clean" path: uninstall, then
#     reinstall.
#
# This script moves the per-session files using `mv -n` (no-clobber)
# so it is safe to re-run after a partial migration. It does NOT
# touch the legacy top-level `state/cache.json` or
# `state/diagnostics.jsonl` — those files have no project
# information and cannot be migrated to the per-project layout
# automatically. They will simply be ignored by the new code paths.
#
# Usage:
#   migrate-state.sh            # perform the migration
#   migrate-state.sh --dry-run  # print what would be moved, change nothing
#   migrate-state.sh -h | --help
#
# Portable: Linux, macOS, Git Bash on Windows. Never reads
# ANTHROPIC_AUTH_TOKEN. No network access. Idempotent.

set -u

DRY_RUN=0

print_help() {
  sed -n '2,38p' "$0"
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "migrate-state.sh: unknown argument: $arg" >&2
      echo "  usage: migrate-state.sh [--dry-run]" >&2
      exit 2
      ;;
  esac
done

CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STATE_DIR="${CLAUDE_ROOT}/plugins/creditgauge/state"
if [ ! -d "$STATE_DIR" ]; then
  echo "migrate-state.sh: no state dir at $STATE_DIR"
  echo "  (nothing to migrate; you are already on the v0.4.x+ layout, or"
  echo "   this is a fresh install)"
  exit 0
fi
TOKEN_SAMPLES_DIR="${STATE_DIR}/token-samples"

if [ ! -d "$TOKEN_SAMPLES_DIR" ]; then
  echo "migrate-state.sh: no token-samples/ directory at $TOKEN_SAMPLES_DIR"
  echo "  (nothing to migrate; you are already on the v0.4.x+ layout, or"
  echo "   this is a fresh install)"
  exit 0
fi

MOVED=0
SKIPPED=0

# Walk token-samples/<projectHash>/<sessionId>.jsonl. We do NOT
# recurse deeper — the v0.4.0–v0.4.<n-1> layout was strictly two
# levels. `find … -maxdepth 3` is the portable shape (works on both
# BSD/macOS find and GNU find) and bounds the walk so we never pick
# up unrelated JSONL files that happen to live deeper.
shopt -s nullglob
for src in "${TOKEN_SAMPLES_DIR}"/*/*.jsonl; do
  [ -e "$src" ] || continue
  # src = $TOKEN_SAMPLES_DIR/<projectHash>/<sessionId>.jsonl
  # dst = $STATE_DIR/<projectHash>/<sessionId>.jsonl
  proj_hash="$(basename "$(dirname "$src")")"
  fname="$(basename "$src")"
  dst_dir="${STATE_DIR}/${proj_hash}"
  dst="${dst_dir}/${fname}"

  if [ -e "$dst" ]; then
    # Existing destination means either a previous partial migration
    # OR a per-tick append that already wrote to the new path (if
    # the user installed v0.4.x+ before running this script — the
    # append path creates files on demand, so a partial session
    # could have new-side data while older files still live on
    # the old side). `mv -n` will not clobber, and we let the user
    # decide via the SKIPPED count whether they want to investigate.
    echo "  skip (dst exists): $src -> $dst"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  echo "  mv $src -> $dst"
  if [ "$DRY_RUN" = 0 ]; then
    mkdir -p "$dst_dir"
    if mv -n "$src" "$dst" 2>/dev/null; then
      MOVED=$((MOVED + 1))
    else
      echo "  WARN: mv failed for $src" >&2
      SKIPPED=$((SKIPPED + 1))
    fi
  else
    MOVED=$((MOVED + 1))
  fi
done
shopt -u nullglob

# Clean up now-empty project-hash subdirs and the empty token-samples/
# parent. rmdir fails loudly on a non-empty dir, which is the right
# behavior (we don't want to rm -rf something the user did not intend).
if [ "$DRY_RUN" = 0 ]; then
  for proj_dir in "${TOKEN_SAMPLES_DIR}"/*/; do
    [ -d "$proj_dir" ] || continue
    rmdir "$proj_dir" 2>/dev/null || true
  done
  rmdir "$TOKEN_SAMPLES_DIR" 2>/dev/null || true
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "migrate-state.sh: --dry-run, no changes made (would have moved $MOVED, skipped $SKIPPED)"
else
  echo "migrate-state.sh: moved $MOVED, skipped $SKIPPED"
fi
