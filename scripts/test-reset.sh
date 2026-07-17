#!/usr/bin/env bash
# test-reset.sh — smoke tests for scripts/reset.sh.
#
# Builds a synthetic state tree, runs reset.sh against it, and asserts
# on what was / wasn't removed.
#
# Tests:
#   - all 3 target files present → all 3 removed; .jsonl + diagnostics
#     + upstream-cmd + sibling project untouched
#   - --dry-run prints the plan and removes nothing
#   - missing target file is skipped (no error)
#   - missing state dir → exit 0 with "nothing to reset"
#   - missing project hash subdir → exit 0 with "nothing to reset"
#   - re-run on already-cleaned state is a no-op (idempotent)
#   - --help prints the help block
#   - unknown arg exits 2
#   - per-test invariant: projectHash computed by reset.sh matches the
#     fixture's <projectHash>/ subdir name (so the test never gets out
#     of sync with the script's hash algorithm)
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESET_SH="${SCRIPT_DIR}/reset.sh"
if [ ! -f "$RESET_SH" ]; then
  echo "missing $RESET_SH" >&2
  exit 1
fi

# Use a fixture root under the current working directory (not /tmp) so
# that the script sees the SAME absolute path the test runner does.
# Git Bash on Windows rewrites /tmp/... to a different AppData path
# when accessed via HOME= env vs the runner's native $TMPDIR, which
# would mismatch the assertions. pwd is stable across both.
TEST_BASE="${TEST_BASE_OVERRIDE:-$(pwd)/.tmp-test-reset}"
rm -rf "$TEST_BASE"
mkdir -p "$TEST_BASE"

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
    echo "  FAIL $label (missing file: $path)"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_missing() {
  local label="$1" path="$2"
  if [ ! -e "$path" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (unexpected file: $path)"
    FAIL=$((FAIL + 1))
  fi
}

# Build a fixture state tree under $1 (the fixture root). The fixture
# places the project's hash subdir at the path projectHash(<PROJ_PATH>)
# would resolve to — so the test stays in sync with reset.sh's hash
# algorithm. $2 = PROJ_PATH (the path `cd` runs from inside the test;
# usually absolute, so the hash matches what `cd $PROJ && pwd` will see).
build_fixture() {
  local root="$1"
  local proj_path="$2"
  local hash
  hash="$(compute_hash "$proj_path")"
  local base="${root}/plugins/creditgauge/state"
  mkdir -p "${base}/${hash}"
  # v1.0.1+: cache.json is the top-level `state/cache.json` (shared
  # across projects; per-project isolation is via `<projectHash>:` key
  # prefix in src/cache.ts). state.json stays per-project under the
  # hash subdir.
  printf '{"key":"v1"}\n'     > "${base}/cache.json"
  printf '{"sid":"abc"}\n'    > "${base}/${hash}/state.json"
  printf '{"rows":[]}\n'      > "${base}/cache.stat.json"
  # Token sample + diagnostics MUST survive.
  printf '{"s":1}\n'          > "${base}/${hash}/abc123.jsonl"
  printf 'WARN\n'             > "${base}/${hash}/diagnostics.jsonl"
  # upstream-cmd + config at state root MUST survive.
  printf '#!/bin/sh\necho up\n' > "${base}/upstream-cmd.sh"
  printf 'up\n'                 > "${base}/upstream-cmd.txt"
  printf '{}\n'                 > "${base}/config.json"
  # A sibling project that MUST NOT be touched.
  mkdir -p "${base}/other-project"
  printf '{"sid":"other"}\n'       > "${base}/other-project/state.json"
  FIXTURE_ROOT="$root"
  FIXTURE_HASH="$hash"
}

# Mirror src/status-store.ts:projectHash() — must stay in sync.
compute_hash() {
  printf '%s' "$1" \
    | tr '\\' '-' 2>/dev/null \
    | tr '/' '-' 2>/dev/null \
    | tr ':' '-' 2>/dev/null \
    | tr '[:space:]	' '-' 2>/dev/null \
    | tr '[:cntrl:]' '-' 2>/dev/null \
    | tr 'A-Z' 'a-z' 2>/dev/null \
    | cut -c1-80
}

# Run reset.sh against the fixture. $1 = extra args ("" or "--dry-run").
# Captures stdout+stderr; echo's it for the caller.
# reset.sh reads $PWD directly (not argv), so we MUST cd into the
# project's hash-aligned path before invoking it — otherwise the
# script computes a hash for the test runner's CWD, not the fixture's.
# Uses $FIXTURE (current test's root) directly, NOT $FIXTURE_ROOT
# (which build_fixture sets as a side effect and which is stale across
# tests that don't call build_fixture).
run_reset() {
  local extra="$1"
  local out
  out=$(cd "$PROJ" && HOME="$FIXTURE" CLAUDE_CONFIG_DIR="$FIXTURE" \
        bash "$RESET_SH" $extra 2>&1) || true
  echo "$out"
}

# --- Tests -------------------------------------------------------------------

echo "== reset.sh: scope + dry-run + idempotence =="

echo "-- all 3 target files present --"
FIXTURE="$TEST_BASE/fixture-$RANDOM"
PROJ="$FIXTURE/proj"
mkdir -p "$PROJ"
# Pass the absolute PROJ path to build_fixture so its projectHash
# matches what `cd $PROJ && bash reset.sh` will compute.
build_fixture "$FIXTURE" "$PROJ"
# Sanity: compute_hash(absolute-path-to-proj) is reproducible.
assert_eq "compute_hash matches fixture hash" "$FIXTURE_HASH" "$(compute_hash "$PROJ")"

# Dry-run.
out=$(run_reset "--dry-run")
assert_eq "dry-run announces projectHash=${FIXTURE_HASH}" \
  "$(echo "$out" | grep -F "projectHash=${FIXTURE_HASH}" | head -1)" \
  "reset.sh: plan (projectHash=${FIXTURE_HASH})"
if echo "$out" | grep -qF "rm $FIXTURE_ROOT/plugins/creditgauge/state/cache.json"; then
  echo "  ok  dry-run plans cache.json (top-level)"
  PASS=$((PASS + 1))
else
  echo "  FAIL dry-run missing cache.json plan"
  echo "       output: $out"
  FAIL=$((FAIL + 1))
fi
if echo "$out" | grep -qF "rm $FIXTURE_ROOT/plugins/creditgauge/state/${FIXTURE_HASH}/state.json"; then
  echo "  ok  dry-run plans state.json"
  PASS=$((PASS + 1))
else
  echo "  FAIL dry-run missing state.json plan"
  FAIL=$((FAIL + 1))
fi
if echo "$out" | grep -qF "rm $FIXTURE_ROOT/plugins/creditgauge/state/cache.stat.json"; then
  echo "  ok  dry-run plans cache.stat.json"
  PASS=$((PASS + 1))
else
  echo "  FAIL dry-run missing cache.stat.json plan"
  FAIL=$((FAIL + 1))
fi
# Decoy entries must NOT appear in the plan.
if echo "$out" | grep -qE "(other-project|abc123\.jsonl|diagnostics\.jsonl|upstream-cmd)"; then
  echo "  FAIL dry-run plan mentions a must-preserve entry"
  echo "       output: $out"
  FAIL=$((FAIL + 1))
else
  echo "  ok  dry-run plan does not touch must-preserve entries"
  PASS=$((PASS + 1))
fi
# After dry-run, NOTHING was removed.
assert_file_exists "cache.json still present after dry-run" \
  "$FIXTURE_ROOT/plugins/creditgauge/state/cache.json"
assert_file_exists "state.json still present after dry-run" \
  "$FIXTURE_ROOT/plugins/creditgauge/state/${FIXTURE_HASH}/state.json"
assert_file_exists "cache.stat.json still present after dry-run" \
  "$FIXTURE_ROOT/plugins/creditgauge/state/cache.stat.json"

# Actual run.
run_reset "" >/dev/null
assert_file_missing "cache.json removed" \
  "$FIXTURE_ROOT/plugins/creditgauge/state/cache.json"
assert_file_missing "state.json removed" \
  "$FIXTURE_ROOT/plugins/creditgauge/state/${FIXTURE_HASH}/state.json"
assert_file_missing "cache.stat.json removed" \
  "$FIXTURE_ROOT/plugins/creditgauge/state/cache.stat.json"
# Must-preserve entries still present.
assert_file_exists "abc123.jsonl (token sample) preserved" \
  "$FIXTURE_ROOT/plugins/creditgauge/state/${FIXTURE_HASH}/abc123.jsonl"
assert_file_exists "diagnostics.jsonl preserved" \
  "$FIXTURE_ROOT/plugins/creditgauge/state/${FIXTURE_HASH}/diagnostics.jsonl"
assert_file_exists "upstream-cmd.sh preserved" \
  "$FIXTURE_ROOT/plugins/creditgauge/state/upstream-cmd.sh"
assert_file_exists "upstream-cmd.txt preserved" \
  "$FIXTURE_ROOT/plugins/creditgauge/state/upstream-cmd.txt"
assert_file_exists "config.json preserved" \
  "$FIXTURE_ROOT/plugins/creditgauge/state/config.json"
# Sibling project untouched.
assert_file_exists "other-project/state.json untouched" \
  "$FIXTURE_ROOT/plugins/creditgauge/state/other-project/state.json"
rm -rf "$FIXTURE"

echo "-- idempotent re-run on cleaned state --"
FIXTURE="$TEST_BASE/fixture-$RANDOM"
PROJ="$FIXTURE/proj"
mkdir -p "$PROJ"
build_fixture "$FIXTURE" "$PROJ"
# First run wipes everything.
run_reset "" >/dev/null
# Second run is a no-op.
out=$(run_reset "")
assert_eq "second run is no-op" \
  "reset.sh: nothing to reset — all 3 cache files missing for projectHash=${FIXTURE_HASH}" \
  "$out"
rm -rf "$FIXTURE"

echo "-- only some target files present (partial state) --"
FIXTURE="$TEST_BASE/fixture-$RANDOM"
PROJ="$FIXTURE/proj"
mkdir -p "$PROJ"
# build_fixture for hash alignment, but then strip state.json + cache.stat.json.
build_fixture "$FIXTURE" "$PROJ"
rm -f "$FIXTURE/plugins/creditgauge/state/${FIXTURE_HASH}/state.json"
rm -f "$FIXTURE/plugins/creditgauge/state/cache.stat.json"
out=$(run_reset "")
if echo "$out" | grep -qF "rm $FIXTURE_ROOT/plugins/creditgauge/state/cache.json"; then
  echo "  ok  partial state plans cache.json (top-level)"
  PASS=$((PASS + 1))
else
  echo "  FAIL partial state plan missing cache.json"
  echo "       output: $out"
  FAIL=$((FAIL + 1))
fi
if echo "$out" | grep -qF "rm $FIXTURE_ROOT/plugins/creditgauge/state/${FIXTURE_HASH}/state.json"; then
  echo "  FAIL partial state should NOT plan state.json (file missing)"
  FAIL=$((FAIL + 1))
else
  echo "  ok  partial state skips missing state.json"
  PASS=$((PASS + 1))
fi
rm -rf "$FIXTURE"

echo "-- missing state dir entirely --"
FIXTURE="$TEST_BASE/fixture-$RANDOM"
PROJ="$FIXTURE/proj"
mkdir -p "$PROJ"
# Don't create plugins/creditgauge/state at all.
out=$(run_reset "")
EXPECTED_FIXTURE="$FIXTURE"
assert_eq "missing state dir prints nothing-to-reset" \
  "reset.sh: nothing to reset — state dir does not exist (${EXPECTED_FIXTURE}/plugins/creditgauge/state)" \
  "$out"
rm -rf "$FIXTURE"

echo "-- state dir exists, project hash subdir missing --"
FIXTURE="$TEST_BASE/fixture-$RANDOM"
PROJ="$FIXTURE/proj"
mkdir -p "$PROJ"
# v1.0.1+ fixture: hash subdir holds state.json; cache.json + cache.stat.json
# live at the state root. To exercise the "all 3 missing" branch we
# must remove the hash subdir (which kills state.json) AND the two
# top-level files. Otherwise the top-level cache.json still exists
# and the script legitimately wipes it — that's correct behavior
# (not a no-op), but the fixture must construct the all-missing
# state to assert on it.
build_fixture "$FIXTURE" "$PROJ"
rm -rf "$FIXTURE/plugins/creditgauge/state/${FIXTURE_HASH}"
rm -f "$FIXTURE/plugins/creditgauge/state/cache.json"
rm -f "$FIXTURE/plugins/creditgauge/state/cache.stat.json"
out=$(run_reset "")
EXPECTED_HASH="$FIXTURE_HASH"
assert_eq "missing hash subdir prints nothing-to-reset" \
  "reset.sh: nothing to reset — all 3 cache files missing for projectHash=${EXPECTED_HASH}" \
  "$out"
rm -rf "$FIXTURE"

echo "-- --help prints the header --"
out=$(bash "$RESET_SH" --help 2>&1 | head -1)
assert_eq "--help shows comment header line 1" \
  "# reset.sh — wipe the creditgauge runtime caches for the CURRENT project" \
  "$out"

echo "-- unknown arg exits 2 --"
out=$(bash "$RESET_SH" --bogus 2>&1)
assert_eq "unknown arg stderr message" \
  "$(echo "$out" | tr '\n' '|')" \
  "reset.sh: unknown argument: --bogus|  usage: reset.sh [--dry-run]|"
# Exit code check.
bash "$RESET_SH" --bogus >/dev/null 2>&1
ec=$?
assert_eq "unknown arg exit code" "2" "$ec"

echo "-- hash algorithm mirrors src/status-store.ts:projectHash --"
# Direct comparison between the bash hash function and what TypeScript
# would produce. These mirror the unit assertions in
# src/token-store.test.ts:projectHash so a future refactor that
# changes the algorithm trips both the JS and bash tests.
assert_eq "D:\\WorkSpace\\topgauge → d--workspace-topgauge" \
  "$(compute_hash 'D:\WorkSpace\topgauge')" "d--workspace-topgauge"
assert_eq "/home/user/proj → -home-user-proj" \
  "$(compute_hash '/home/user/proj')" "-home-user-proj"
assert_eq "C:\\Program Files\\app → c--program-files-app" \
  "$(compute_hash 'C:\Program Files\app')" "c--program-files-app"
assert_eq "bare 'proj' → proj (no separators)" \
  "$(compute_hash 'proj')" "proj"

# --- Summary -----------------------------------------------------------------
echo ""
echo "test-reset.sh: $PASS pass, $FAIL fail"
exit $FAIL