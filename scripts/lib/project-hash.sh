# scripts/lib/project-hash.sh — bash-side mirror of src/status-store.ts:projectHash().
#
# Source this file (do NOT execute it) and call `project_hash <abs_path>`.
# The caller is responsible for passing an absolute path (typically $PWD,
# or an absolute fixture path in tests).
#
# Why a separate file: the tr pipeline below used to live inline in
# scripts/reset.sh AND was duplicated verbatim in scripts/test-reset.sh
# (compute_hash helper). That duplication was load-bearing — both sides
# had to mirror src/status-store.ts byte-for-byte or the test would
# silently agree with the script while disagreeing with the TS runtime.
# This file is now the single bash-side source of truth; reset.sh and
# test-reset.sh source it.
#
# Why input normalization matters: the TS runtime reads cwd from stdin
# as a Windows-native string ("D:\WorkSpace\CreditGauge") and hashes it
# directly. reset.sh, when invoked from Git Bash, sees $PWD as the
# POSIX-style mount ("/d/WorkSpace/CreditGauge"). Without normalization,
# the two inputs hash to different strings (-d-workspace-... vs
# d--workspace-...) — meaning :reset never finds the user's real
# state.json. cygpath -w converts the POSIX form to the Windows form
# BEFORE hashing, so both inputs converge on the same hash.
#
# Detection order: cygpath first (ships with Git Bash / Cygwin / MSYS2
# — by far the common case), then wslpath (WSL only). Native Linux /
# macOS have neither tool and $PWD is already canonical, so neither
# branch fires and the input passes through unchanged. The fallback
# after each tool call (`|| printf '%s' "$input"`) is purely defensive
# — cygpath -w does not actually fail on non-existent paths (verified
# locally: it returns the converted form anyway), so the fallback
# should not trigger in practice. Mirrors the precedent in
# scripts/uninstall.sh:173-174.

project_hash() {
  local input="$1"
  if command -v cygpath >/dev/null 2>&1; then
    input="$(cygpath -w "$input" 2>/dev/null || printf '%s' "$input")"
  elif command -v wslpath >/dev/null 2>&1; then
    input="$(wslpath -w "$input" 2>/dev/null || printf '%s' "$input")"
  fi
  # Hash pipeline — byte-identical to src/status-store.ts:projectHash():
  #   replace(/[\\/:]/g, "-")           → \\, /, : each → -
  #   replace(/[\s\x00-\x1f\x7f]/g, "-") → whitespace + C0 controls + DEL → -
  #   toLowerCase()                     → A-Z → a-z
  #   slice(0, 80)                      → cap at 80 chars
  printf '%s' "$input" \
    | tr '\\' '-' 2>/dev/null \
    | tr '/' '-' 2>/dev/null \
    | tr ':' '-' 2>/dev/null \
    | tr '[:space:]	' '-' 2>/dev/null \
    | tr '[:cntrl:]' '-' 2>/dev/null \
    | tr 'A-Z' 'a-z' 2>/dev/null \
    | cut -c1-80
}