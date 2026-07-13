#!/usr/bin/env bash
# test-uninstall.sh — smoke tests for the v0.9.x partial-preserve
# semantics in scripts/uninstall.sh.
#
# The branches under test:
#   - DEFAULT (no flags): partial-preserve — topgauge/config.json,
#     topgauge/query_plugins/, and per-project .jsonl files are
#     preserved; a post-uninstall hint lists their paths.
#   - --completely: full uninstall — also wipes config.json,
#     query_plugins/, and the .jsonl history. No hint printed.
#   - ALWAYS wipe: state/cache.json, state/cache.stat.json,
#     state/upstream-cmd.{sh,txt}, state/<projectHash>/state.json
#     go regardless of flags.
#   - --keep-state: removed in v0.9.x. The script now rejects it as
#     an unknown argument (exit 2) — verified by the
#     [unknown-flag] case below.
#
# Each test builds a synthetic CLAUDE_ROOT in a tmpdir, monkey-patches
# HOME / CLAUDE_CONFIG_DIR to point at it, and runs uninstall.sh
# against the fixture. Real user settings.json is never touched.
#
# Tests don't drive the full uninstall (statusLine restore + market-
# place JSON strip) — they only exercise the partial-preserve wipe
# paths. The fixture is a minimal settings.json WITHOUT
# `_topgauge_managed: true`, so the statusLine branch is skipped
# (matches "leave it alone" branch in scripts/uninstall.sh).
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNINSTALL_SH="${SCRIPT_DIR}/uninstall.sh"
if [ ! -f "$UNINSTALL_SH" ]; then
  echo "missing $UNINSTALL_SH" >&2
  exit 1
fi

# --- Test helpers ------------------------------------------------------------

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label"
    echo "       expected: $expected"
    echo "       actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_exists() {
  local label="$1" path="$2"
  if [ -f "$path" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (missing: $path)"
    FAIL=$((FAIL + 1))
  fi
}

assert_dir_exists() {
  local label="$1" path="$2"
  if [ -d "$path" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (missing dir: $path)"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_missing() {
  local label="$1" path="$2"
  if [ ! -f "$path" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (unexpected file: $path)"
    FAIL=$((FAIL + 1))
  fi
}

assert_dir_missing() {
  local label="$1" path="$2"
  if [ ! -d "$path" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (unexpected dir: $path)"
    FAIL=$((FAIL + 1))
  fi
}

assert_match_str() {
  local label="$1" pattern="$2" haystack="$3"
  if echo "$haystack" | grep -qF -- "$pattern"; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (pattern not found: $pattern)"
    echo "       output: $haystack"
    FAIL=$((FAIL + 1))
  fi
}

# Build a fresh fixture mirroring the on-disk layout described in
# CLAUDE.md. We deliberately do NOT mark settings.json as ours (no
# _topgauge_managed marker) so uninstall.sh's statusLine-restore
# branch is skipped and we exercise ONLY the wipe logic.
#
# $ROOT/                                    (synthetic CLAUDE_ROOT)
#   plugins/cache/topgauge/topgauge/0.9.0/  (cache stub for statusLine probe)
#   plugins/topgauge/
#     config.json                            (user-owned; must NOT be wiped)
#     query_plugins/minimax/index.js         (user override; must NOT be wiped)
#     state/
#       cache.json                           (must be wiped)
#       cache.stat.json                      (must be wiped)
#       upstream-cmd.sh                      (must be wiped)
#       upstream-cmd.txt                     (must be wiped)
#       d--workspace-topgauge/
#         ca62...jsonl                       (sample; default wipes, --keep-state preserves)
#         state.json                         (must be wiped)
#   plugins/installed_plugins.json           (synthetic; uninstall strips the row)
#   plugins/known_marketplaces.json          (synthetic; uninstall strips the row)
#   settings.json                            (no marker; uninstall skips restore)
build_fixture() {
  local root
  root="$(mktemp -d -t topgauge-uninstall-test-XXXXXX)"
  local plugins="${root}/plugins"
  local cache="${plugins}/cache/topgauge/topgauge/0.9.0"
  local state="${plugins}/topgauge"
  mkdir -p "${cache}/dist" "${cache}/scripts" \
           "${state}/query_plugins/minimax" \
           "${state}/state/d--workspace-topgauge"

  # Synthetic plugin source layout — uninstall.sh resolves paths off
  # CLAUDE_ROOT so layout matters, not file contents.
  printf '# stub\n' > "${cache}/dist/index.js"
  printf '# stub\n' > "${cache}/scripts/wrapper.sh"
  chmod +x "${cache}/scripts/wrapper.sh"

  # User-owned artifacts that must NOT be wiped (default branch).
  printf '{"providers":{"minimax":{"provider":"minimax"}}}\n' \
    > "${state}/config.json"
  printf '#!/usr/bin/env bash\necho user-override\n' \
    > "${state}/query_plugins/minimax/index.js"
  chmod +x "${state}/query_plugins/minimax/index.js"

  # Cache noise — must be wiped unconditionally.
  printf '{"k":"v"}\n' > "${state}/state/cache.json"
  printf '{"stats":[]}\n' > "${state}/state/cache.stat.json"
  cat > "${state}/state/upstream-cmd.sh" <<'EOF'
#!/usr/bin/env bash
echo previous
EOF
  printf 'echo previous\n' > "${state}/state/upstream-cmd.txt"
  chmod +x "${state}/state/upstream-cmd.sh"

  # Per-project tickStatus — must be wiped.
  printf '{"prevTick":{}}\n' \
    > "${state}/state/d--workspace-topgauge/state.json"

  # Token-sample history — conditional.
  printf '{"at":1}\n{"at":2}\n' \
    > "${state}/state/d--workspace-topgauge/ca625a72-test-session.jsonl"

  # Settings + loader JSONs (synthetic; no marker).
  printf '{}' > "${root}/settings.json"
  printf '{"plugins":{"topgauge@topgauge":[]}}\n' \
    > "${plugins}/installed_plugins.json"
  printf '{"topgauge":{"source":"github"}}\n' \
    > "${plugins}/known_marketplaces.json"

  echo "$root"
}

# Run uninstall.sh inside a sandboxed CLAUDE_ROOT.
#   $1 = root from build_fixture()
#   $2... = uninstall.sh args
run_uninstall() {
  local root="$1"; shift
  (
    # Subshell isolation: never let the sandbox leak to the parent
    # environment. The statusLine-restore branch needs HOME for
    # default settings.json resolution; we override both knobs.
    export HOME="$root"
    export CLAUDE_CONFIG_DIR="$root"
    cd "$root"
    bash "$UNINSTALL_SH" "$@"
  )
}

# ============================================================================
# Tests
# ============================================================================

echo "== v0.9.x partial-preserve: DEFAULT (no flags) =="

ROOT=$(build_fixture)
OUT=$(run_uninstall "$ROOT" 2>&1)

# config.json + query_plugins/ preserved
assert_file_exists  "[default] topgauge/config.json preserved" \
  "${ROOT}/plugins/topgauge/config.json"
assert_file_exists  "[default] topgauge/query_plugins/minimax/index.js preserved" \
  "${ROOT}/plugins/topgauge/query_plugins/minimax/index.js"
assert_dir_exists   "[default] topgauge/query_plugins/ dir preserved" \
  "${ROOT}/plugins/topgauge/query_plugins"

# Always-wiped cache noise gone
assert_file_missing "[default] state/cache.json wiped" \
  "${ROOT}/plugins/topgauge/state/cache.json"
assert_file_missing "[default] state/cache.stat.json wiped" \
  "${ROOT}/plugins/topgauge/state/cache.stat.json"
assert_file_missing "[default] state/upstream-cmd.sh wiped" \
  "${ROOT}/plugins/topgauge/state/upstream-cmd.sh"
assert_file_missing "[default] state/upstream-cmd.txt wiped" \
  "${ROOT}/plugins/topgauge/state/upstream-cmd.txt"

# Always-wiped per-project state.json gone
assert_file_missing "[default] state/<hash>/state.json wiped" \
  "${ROOT}/plugins/topgauge/state/d--workspace-topgauge/state.json"

# Default-preserved .jsonl survives (this is the differentiating
# branch from v0.9.x pre-rename — the .jsonl is preserved by default,
# and only --completely wipes it)
assert_file_exists  "[default] state/<hash>/<sid>.jsonl preserved" \
  "${ROOT}/plugins/topgauge/state/d--workspace-topgauge/ca625a72-test-session.jsonl"

# Cache dir wiped (matched the always-wipe list)
assert_file_missing "[default] cache/topgauge/* wiped" \
  "${ROOT}/plugins/cache/topgauge"

# Post-uninstall hint lists preserved paths (default mode)
assert_match_str "[default] hint mentions config.json" \
  "config.json" "$OUT"
assert_match_str "[default] hint mentions query_plugins" \
  "query_plugins" "$OUT"
assert_match_str "[default] hint mentions .jsonl path" \
  "ca625a72-test-session.jsonl" "$OUT"
assert_match_str "[default] hint mentions --completely" \
  "--completely" "$OUT"

rm -rf "$ROOT"

echo ""
echo "== v0.9.x partial-preserve: --completely =="

ROOT=$(build_fixture)
OUT=$(run_uninstall "$ROOT" --completely 2>&1)

# config.json + query_plugins/ GONE
assert_file_missing "[completely] topgauge/config.json wiped" \
  "${ROOT}/plugins/topgauge/config.json"
assert_file_missing "[completely] topgauge/query_plugins/ dir wiped" \
  "${ROOT}/plugins/topgauge/query_plugins"

# .jsonl wiped
assert_file_missing "[completely] state/<hash>/<sid>.jsonl wiped" \
  "${ROOT}/plugins/topgauge/state/d--workspace-topgauge/ca625a72-test-session.jsonl"

# Always-wiped still gone
assert_file_missing "[completely] state/cache.json wiped" \
  "${ROOT}/plugins/topgauge/state/cache.json"
assert_file_missing "[completely] state/<hash>/state.json wiped" \
  "${ROOT}/plugins/topgauge/state/d--workspace-topgauge/state.json"

# Post-uninstall message confirms full uninstall
assert_match_str "[completely] full-uninstall message" \
  "--completely" "$OUT"

# --completely also rmdir's the now-empty topgauge/ parent dir
assert_dir_missing "[completely] topgauge/ parent dir removed" \
  "${ROOT}/plugins/topgauge"

rm -rf "$ROOT"

echo ""
echo "== v0.9.x --completely + untracked file: topgauge/ stays, exit 0 =="

ROOT=$(build_fixture)
# Plant an untracked file the script doesn't know about (simulates
# a __legacy__/ migration leftover or a user-saved note). rmdir
# must fail with ENOTEMPTY — we want the dir to stay, NOT to
# silently nuke the untracked file.
mkdir -p "${ROOT}/plugins/topgauge/state/d--workspace-topgauge/__legacy__"
echo "user-saved-stuff" \
  > "${ROOT}/plugins/topgauge/state/d--workspace-topgauge/__legacy__/readme.txt"

# Capture exit code via a subshell wrapper around run_uninstall.
OUT=$( (
  export HOME="$ROOT"
  export CLAUDE_CONFIG_DIR="$ROOT"
  cd "$ROOT"
  bash "$UNINSTALL_SH" --completely
); echo "RC=$?")
RC=${OUT##*RC=}
OUT=${OUT%RC=*}

# The untracked file MUST survive (rmdir failure is non-fatal).
assert_file_exists "[untracked] __legacy__/readme.txt preserved" \
  "${ROOT}/plugins/topgauge/state/d--workspace-topgauge/__legacy__/readme.txt"
# The topgauge/ parent dir MUST stay (it's non-empty thanks to
# the untracked file).
assert_dir_exists "[untracked] topgauge/ parent dir stays (rmdir ENOTEMPTY)" \
  "${ROOT}/plugins/topgauge"
# The script MUST still exit 0.
assert_eq "[untracked] script still exits 0" "0" "$RC"
# The full-uninstall message MUST still be printed.
assert_match_str "[untracked] full-uninstall message still printed" \
  "every topgauge/ artifact was wiped" "$OUT"

rm -rf "$ROOT"

echo ""
echo "== v0.9.x partial-preserve: dry-run =="

ROOT=$(build_fixture)
OUT=$(run_uninstall "$ROOT" --dry-run 2>&1)

# Default plan wipes the always-list (cache noise + state.json) but
# KEEPS .jsonl (so it must NOT appear in the plan).
assert_match_str "[dry-run] default wipes state.json" \
  "d--workspace-topgauge/state.json" "$OUT"
assert_match_str "[dry-run] default wipes cache.json" \
  "topgauge/state/cache.json" "$OUT"
assert_match_str "[dry-run] default wipes upstream-cmd.txt" \
  "topgauge/state/upstream-cmd.txt" "$OUT"

# Inverse assertion: .jsonl wipe must NOT appear in the default plan.
if echo "$OUT" | grep -qF -- "ca625a72-test-session.jsonl"; then
  echo "  FAIL [dry-run default] plan contains .jsonl wipe (should be preserved)"
  FAIL=$((FAIL + 1))
else
  echo "  ok  [dry-run default] plan omits .jsonl wipe"
  PASS=$((PASS + 1))
fi
# Same for config.json / query_plugins in the default plan.
if echo "$OUT" | grep -qF -- "topgauge/config.json"; then
  echo "  FAIL [dry-run default] plan contains config.json wipe (should be preserved)"
  FAIL=$((FAIL + 1))
else
  echo "  ok  [dry-run default] plan omits config.json wipe"
  PASS=$((PASS + 1))
fi
if echo "$OUT" | grep -qF -- "topgauge/query_plugins"; then
  echo "  FAIL [dry-run default] plan contains query_plugins wipe (should be preserved)"
  FAIL=$((FAIL + 1))
else
  echo "  ok  [dry-run default] plan omits query_plugins wipe"
  PASS=$((PASS + 1))
fi

# Verify dry-run did NOT actually delete anything
assert_file_exists "[dry-run] cache.json still on disk" \
  "${ROOT}/plugins/topgauge/state/cache.json"
assert_file_exists "[dry-run] config.json still on disk" \
  "${ROOT}/plugins/topgauge/config.json"

# --completely plan SHOULD include .jsonl + config.json + query_plugins.
OUT_C=$(run_uninstall "$ROOT" --dry-run --completely 2>&1)
assert_match_str "[dry-run + --completely] plan wipes .jsonl" \
  "ca625a72-test-session.jsonl" "$OUT_C"
assert_match_str "[dry-run + --completely] plan wipes config.json" \
  "topgauge/config.json" "$OUT_C"
assert_match_str "[dry-run + --completely] plan wipes query_plugins" \
  "topgauge/query_plugins" "$OUT_C"
assert_match_str "[dry-run + --completely] plan rmdirs topgauge/ (if empty)" \
  "rmdir" "$OUT_C"
assert_match_str "[dry-run + --completely] plan rmdirs the right path" \
  "topgauge (if empty after wipes)" "$OUT_C"

# Dry-run + --dry-run message
assert_match_str "[dry-run] explicit no-change message" \
  "--dry-run, no changes made" "$OUT"

rm -rf "$ROOT"

echo ""
echo "== v0.9.x partial-preserve: hint on FIRST run only =="

ROOT=$(build_fixture)
OUT1=$(run_uninstall "$ROOT" 2>&1)
# First-run hint mentions config.json
assert_match_str "[first-run hint] mentions config.json" \
  "config.json" "$OUT1"

# Second run on the same fixture: the always-wipe targets are gone,
# but config.json / query_plugins / .jsonl still exist (default mode
# preserves them). The hint still fires (because the preserved files
# are on disk), and the script exits 0.
set +e
run_uninstall "$ROOT" >/dev/null 2>&1
EC=$?
set -e
assert_eq "[second-run] idempotent exit code is 0" "0" "$EC"

rm -rf "$ROOT"

echo ""
echo "== v0.9.x partial-preserve: unknown --keep-state rejected =="

# v0.9.x removed --keep-state. Passing it must fail loudly (exit 2)
# with a usage hint, NOT silently default to the old behavior. This
# guards against users with muscle memory from older releases silently
# getting the wrong wipe set.
ROOT=$(build_fixture)
set +e
OUT=$(run_uninstall "$ROOT" --keep-state 2>&1)
EC=$?
set -e
assert_eq "[unknown-flag] --keep-state exit code is 2" "2" "$EC"
assert_match_str "[unknown-flag] usage hint" \
  "usage: uninstall.sh" "$OUT"
# Crucially: nothing was wiped, so config.json + .jsonl still exist
# (the script bailed before the wipe phase).
assert_file_exists "[unknown-flag] config.json untouched" \
  "${ROOT}/plugins/topgauge/config.json"
assert_file_exists "[unknown-flag] .jsonl untouched" \
  "${ROOT}/plugins/topgauge/state/d--workspace-topgauge/ca625a72-test-session.jsonl"

rm -rf "$ROOT"

# ============================================================================
# Summary
# ============================================================================

echo ""
echo "tests: PASS=${PASS} FAIL=${FAIL}"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
