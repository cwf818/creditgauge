#!/usr/bin/env bash
# clean-journal.sh — purge old .jsonl journal files under state/<projectHash>/
#
# Targets the append-only JSONL token-sample history files at
#   ${CLAUDE_ROOT}/plugins/creditgauge/state/<projectHash>/*.jsonl
#
# By default, removes journal files older than 7 days (configurable via
# --days <N>). Pass --all to remove every journal file regardless of age.
#
# Usage:
#   clean-journal.sh                  # remove .jsonl files older than 7 days
#   clean-journal.sh --days 30        # remove .jsonl files older than 30 days
#   clean-journal.sh --all            # remove ALL .jsonl journal files
#   clean-journal.sh --dry-run        # preview without deleting
#   clean-journal.sh -h | --help
#
# Safety:
#   - Only removes files matching *.jsonl under state/<projectHash>/
#   - Never touches diagnostics.jsonl or cache.json files
#   - Dry-run mode lists what would be removed

set -euo pipefail

DRY_RUN=false
ALL=false
DAYS=7

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --all) ALL=true; shift ;;
    --days) DAYS="$2"; shift 2 ;;
    -h|--help)
      sed -n '3,/^$/p' "$0" | sed 's/^# //;s/^#$//'
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
BASE="${CLAUDE_ROOT}/plugins/creditgauge/state"

if [ ! -d "$BASE" ]; then
  echo "clean-journal: no state directory at ${BASE}"
  exit 0
fi

REMOVED=0
SKIPPED=0

while IFS= read -r -d '' file; do
  rel="${file#$BASE/}"
  if $ALL; then
    if $DRY_RUN; then
      echo "  would remove:  ${rel}"
    else
      rm -f "$file"
      echo "  removed:       ${rel}"
    fi
    REMOVED=$((REMOVED + 1))
  else
    # Check age: remove if older than DAYS days
    if [ -f "$file" ]; then
      mtime=$(stat -c %Y "$file" 2>/dev/null || stat -f %m "$file" 2>/dev/null || echo "0")
      now=$(date +%s)
      age=$(( (now - mtime) / 86400 ))
      if [ "$age" -ge "$DAYS" ]; then
        if $DRY_RUN; then
          echo "  would remove:  ${rel} (${age}d old)"
        else
          rm -f "$file"
          echo "  removed:       ${rel} (${age}d old)"
        fi
        REMOVED=$((REMOVED + 1))
      else
        SKIPPED=$((SKIPPED + 1))
      fi
    fi
  fi
done < <(find "$BASE" -maxdepth 2 -name '*.jsonl' -not -name 'diagnostics.jsonl' -print0)

if $DRY_RUN; then
  echo "clean-journal: dry-run — would remove ${REMOVED} file(s), ${SKIPPED} would be kept"
else
  echo "clean-journal: removed ${REMOVED} file(s), kept ${SKIPPED}"
fi
