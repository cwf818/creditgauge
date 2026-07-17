#!/usr/bin/env bash
# test-clean-cache.sh — smoke tests for scripts/clean-cache.sh.
#
# Builds a synthetic cache base with several version dirs (and a few
# decoy entries to exercise the filter), runs clean-cache.sh with
# various inputs, and asserts on the plan / actual filesystem state.
#
# Tests:
#   - empty cache base → "nothing to clean"
#   - single version dir → "nothing to clean"
#   - multiple version dirs → keeps newest, removes the rest
#   - decoy entries (non-version dirs like `.orphaned_at` parent,
#     `..`, hidden dirs) are NOT touched
#   - --dry-run produces a plan but does not remove anything
#   - actual run produces the same result as --dry-run
#   - 4-component versions (e.g. 0.2.7.1) sort correctly (numeric, not lex)
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLEAN_SH="${SCRIPT_DIR}/clean-cache.sh"
if [ ! -f "$CLEAN_SH" ]; then
  echo "missing $CLEAN_SH" >&2
  exit 1
fi

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

assert_file_exists() {
  local label="$1" path="$2"
  if [ -f "$path" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (missing file: $path)"
    FAIL=$((FAIL + 1))
  fi
}

# Build a fixture cache base. Args: a list of version names to create.
# Also creates a few decoy entries that must NOT be touched.
build_fixture() {
  local root
  root="$(mktemp -d -t creditgauge-cleancache-test-XXXXXX)"
  local base="${root}/plugins/cache/creditgauge/creditgauge"
  mkdir -p "$base"
  for v in "$@"; do
    mkdir -p "${base}/${v}"
    # Put a real-looking file inside so the dir has some weight (the
    # script doesn't care, but it makes the test more realistic).
    printf '# stub for %s\n' "$v" > "${base}/${v}/package.json"
  done
  # Decoy entries that must NOT be removed.
  mkdir -p "${base}/.orphaned_at_parent"            # hidden dir
  mkdir -p "${base}/not-a-version"                  # literal letters
  mkdir -p "${base}/1.2"                             # 2-component
  printf 'decoy file\n' > "${base}/decoy.txt"        # file, not a dir
  FIXTURE_ROOT="$root"
  FIXTURE_BASE="$base"
}

# Run clean-cache.sh against the fixture, with optional --dry-run.
run_clean() {
  local extra_args="$1"
  local out
  out=$(HOME="$FIXTURE_ROOT" CLAUDE_CONFIG_DIR="$FIXTURE_ROOT" \
        bash "$CLEAN_SH" $extra_args 2>&1) || true
  echo "$out"
}

# --- Tests -------------------------------------------------------------------

echo "== clean-cache.sh: keep-newest-only semantics =="

echo "-- empty cache base --"
build_fixture
out=$(run_clean "")
# The fixture creates the cache base dir (mkdir -p $base) so the
# script sees it as existing; the "no version dirs" message is what
# we get instead. Decoy entries must still be untouched.
assert_dir_exists "decoy hidden dir untouched" "${FIXTURE_BASE}/.orphaned_at_parent"
assert_dir_exists "decoy 'not-a-version' untouched" "${FIXTURE_BASE}/not-a-version"
assert_dir_exists "decoy '1.2' untouched" "${FIXTURE_BASE}/1.2"
assert_file_exists "decoy.txt file untouched" "${FIXTURE_BASE}/decoy.txt"
if echo "$out" | grep -qE "nothing to clean|at most one version dir present"; then
  echo "  ok  prints nothing-to-clean"
  PASS=$((PASS + 1))
else
  echo "  FAIL empty-cache output unexpected: $out"
  FAIL=$((FAIL + 1))
fi
rm -rf "$FIXTURE_ROOT"

echo "-- single version dir --"
build_fixture 0.2.8
out=$(run_clean "")
assert_dir_exists "0.2.8 kept" "${FIXTURE_BASE}/0.2.8"
assert_eq "prints nothing-to-clean" "clean-cache.sh: nothing to clean — at most one version dir present (0.2.8)" "$out"
rm -rf "$FIXTURE_ROOT"

echo "-- multiple version dirs (numeric sort, 4-component) --"
build_fixture 0.2.7 0.2.7.1 0.2.8
# Sanity: verify our sort would pick 0.2.8 as the newest.
out=$(run_clean "--dry-run")
if echo "$out" | grep -qF "keep:    0.2.8"; then
  echo "  ok  dry-run announces keep=0.2.8"
  PASS=$((PASS + 1))
else
  echo "  FAIL dry-run missing keep=0.2.8"
  echo "       output: $out"
  FAIL=$((FAIL + 1))
fi
# Sanity: 0.2.7.1 sorts AFTER 0.2.7 but BEFORE 0.2.8 (numeric, not lex).
# 0.2.7.1 = 0.2.7 + "1" suffix; 0.2.7.1 must be removed too.
if echo "$out" | grep -qF "rm -rf ${FIXTURE_BASE}/0.2.7"; then
  echo "  ok  dry-run plans to remove 0.2.7"
  PASS=$((PASS + 1))
else
  echo "  FAIL dry-run missing plan for 0.2.7"
  echo "       output: $out"
  FAIL=$((FAIL + 1))
fi
if echo "$out" | grep -qF "rm -rf ${FIXTURE_BASE}/0.2.7.1"; then
  echo "  ok  dry-run plans to remove 0.2.7.1"
  PASS=$((PASS + 1))
else
  echo "  FAIL dry-run missing plan for 0.2.7.1"
  echo "       output: $out"
  FAIL=$((FAIL + 1))
fi
# After dry-run, NOTHING was removed yet.
assert_dir_exists "0.2.7 still present after dry-run" "${FIXTURE_BASE}/0.2.7"
assert_dir_exists "0.2.7.1 still present after dry-run" "${FIXTURE_BASE}/0.2.7.1"
assert_dir_exists "0.2.8 still present after dry-run" "${FIXTURE_BASE}/0.2.8"
# Decoy dirs must not appear in the plan.
if echo "$out" | grep -qE "rm -rf .*(\.orphaned_at_parent|not-a-version|1\.2|decoy\.txt)"; then
  echo "  FAIL dry-run would touch a decoy entry"
  echo "       output: $out"
  FAIL=$((FAIL + 1))
else
  echo "  ok  dry-run does not mention any decoy entry"
  PASS=$((PASS + 1))
fi
# Now actually run (no --dry-run) and verify removals.
out=$(run_clean "")
assert_dir_missing "0.2.7 removed" "${FIXTURE_BASE}/0.2.7"
assert_dir_missing "0.2.7.1 removed" "${FIXTURE_BASE}/0.2.7.1"
assert_dir_exists "0.2.8 kept (newest)" "${FIXTURE_BASE}/0.2.8"
# Decoys untouched after the real run too.
assert_dir_exists ".orphaned_at_parent decoy untouched" "${FIXTURE_BASE}/.orphaned_at_parent"
assert_dir_exists "not-a-version decoy untouched" "${FIXTURE_BASE}/not-a-version"
assert_dir_exists "1.2 decoy untouched (now correctly skipped as non-version)" "${FIXTURE_BASE}/1.2"
assert_file_exists "decoy.txt file untouched" "${FIXTURE_BASE}/decoy.txt"
rm -rf "$FIXTURE_ROOT"

echo "-- re-running on already-cleaned cache is a no-op --"
build_fixture 0.2.8
out=$(run_clean "")
assert_eq "nothing-to-clean on second pass" \
  "clean-cache.sh: nothing to clean — at most one version dir present (0.2.8)" \
  "$out"
rm -rf "$FIXTURE_ROOT"

echo "-- many versions, only the newest is kept --"
build_fixture 0.1.0 0.1.5 0.2.0 0.2.7 0.2.8
run_clean "" >/dev/null
assert_dir_missing "0.1.0 removed" "${FIXTURE_BASE}/0.1.0"
assert_dir_missing "0.1.5 removed" "${FIXTURE_BASE}/0.1.5"
assert_dir_missing "0.2.0 removed" "${FIXTURE_BASE}/0.2.0"
assert_dir_missing "0.2.7 removed" "${FIXTURE_BASE}/0.2.7"
assert_dir_exists "0.2.8 kept" "${FIXTURE_BASE}/0.2.8"
rm -rf "$FIXTURE_ROOT"

# --- Summary -----------------------------------------------------------------
echo ""
echo "test-clean-cache.sh: $PASS pass, $FAIL fail"
exit $FAIL
