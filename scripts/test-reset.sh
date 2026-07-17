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

# Source the bash-side projectHash implementation — single source of
# truth shared with scripts/reset.sh. If the algorithm drifts, both
# sides stay in sync (or both break the same way).
# shellcheck source=./lib/project-hash.sh
. "${SCRIPT_DIR}/lib/project-hash.sh"

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
  hash="$(project_hash "$proj_path")"
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
# (Implementation now lives in scripts/lib/project-hash.sh, sourced
# above. Do not reintroduce an inline copy.)

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
assert_eq "project_hash matches fixture hash" "$FIXTURE_HASH" "$(project_hash "$PROJ")"

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
# changes the algorithm trips both the JS and bash tests. Post-v1.0.0
# the repo root is `CreditGauge`, not `topgauge`, so the canonical
# Windows-form fixture now hashes to `d--workspace-creditgauge`.

# Canonical TS-side input form.
assert_eq "D:\\WorkSpace\\CreditGauge → d--workspace-creditgauge (TS input form)" \
  "$(project_hash 'D:\WorkSpace\CreditGauge')" "d--workspace-creditgauge"

# Bug regression: Git Bash sees this as $PWD but TS sees the form above.
# Both MUST hash to the same string after normalization.
if command -v cygpath >/dev/null 2>&1; then
  assert_eq "/d/WorkSpace/CreditGauge → d--workspace-creditgauge (Git Bash form, normalized via cygpath -w)" \
    "$(project_hash '/d/WorkSpace/CreditGauge')" "d--workspace-creditgauge"
  assert_eq "D:/WorkSpace/CreditGauge → d--workspace-creditgauge (mixed separators)" \
    "$(project_hash 'D:/WorkSpace/CreditGauge')" "d--workspace-creditgauge"
fi

# WSL equivalent of the same bug (only runs on WSL where wslpath exists).
if command -v wslpath >/dev/null 2>&1; then
  assert_eq "/mnt/d/WorkSpace/CreditGauge → d--workspace-creditgauge (WSL form, normalized via wslpath -w)" \
    "$(project_hash '/mnt/d/WorkSpace/CreditGauge')" "d--workspace-creditgauge"
fi

# Linux / macOS paths: only meaningful to assert when no path-
# translation tool is available. On Git Bash, `cygpath -w "/home/..."`
# converts the path to "$MSYS_ROOT/home/..." (e.g. `C:\Program Files\Git\home\user\proj`)
# rather than passing through, which is Git Bash's documented behavior
# for non-mount absolute paths. So these assertions gate on the
# absence of cygpath/wslpath to run only on platforms where the
# pass-through branch actually executes.
if ! command -v cygpath >/dev/null 2>&1 && ! command -v wslpath >/dev/null 2>&1; then
  assert_eq "/home/user/proj → -home-user-proj (no normalization)" \
    "$(project_hash '/home/user/proj')" "-home-user-proj"
  assert_eq "/Users/chen/proj → -users-chen-proj (macOS, no normalization)" \
    "$(project_hash '/Users/chen/proj')" "-users-chen-proj"
fi

# Whitespace inside path is also a separator (mirrors src/token-store.test.ts
# separators case + the programFiles case below). Pre-normalized
# (Windows-form input) so it works regardless of platform.
assert_eq "C:\\Program Files\\app → c--program-files-app" \
  "$(project_hash 'C:\Program Files\app')" "c--program-files-app"

# Bare name, no separators.
assert_eq "bare 'proj' → proj (no separators)" \
  "$(project_hash 'proj')" "proj"

# Lowercasing.
assert_eq "Foo/Bar → foo-bar (lowercased)" \
  "$(project_hash 'Foo/Bar')" "foo-bar"

# Control-char stripping (mirrors src/token-store.test.ts:29-44).
# Construct the string via printf to keep \t / \n / \r as raw bytes
# (rather than via $'\t' which some shells post-process).
# Pipe through a printf-based shell function that mimics project_hash's
# normalization contract on this exact input.
cr_input="$(printf 'D:\rbar')"
nl_input="$(printf 'D:\nfoo')"
tab_input="$(printf 'D:\test')"
assert_eq "D:<TAB>est → d--est (TAB stripped)" \
  "$(project_hash "$tab_input")" "d--est"
assert_eq "D:<NL>foo → d--foo (NL stripped)" \
  "$(project_hash "$nl_input")" "d--foo"
assert_eq "D:<CR>bar → d--bar (CR stripped)" \
  "$(project_hash "$cr_input")" "d--bar"

# 80-char cap (mirrors src/token-store.test.ts:24-27).
# Use a single-quoted 120-char string so the input is unambiguous;
# project_hash output ends with a trailing newline from the tr/cut
# pipeline, so strip it before measuring.
long="$(printf 'a%.0s' $(seq 1 120))"
assert_eq "120-char input length sanity" "${#long}" "120"
assert_eq "120-char input → 80-char hash" \
  "$(project_hash "$long" | tr -d '\n' | wc -c | tr -d ' ')" "80"

# --- Summary -----------------------------------------------------------------
echo ""
echo "test-reset.sh: $PASS pass, $FAIL fail"
exit $FAIL