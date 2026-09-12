#!/usr/bin/env bash
# test-config.sh — smoke tests for scripts/config.sh + scripts/lib/edit-config.mjs
# (the /creditgauge:config slash command).
#
# These tests build a synthetic CLAUDE_CONFIG_DIR (fixture root), invoke the
# real config.sh with CLAUDE_CONFIG_DIR / HOME pointed at it, and assert on
# the resulting files / stdout. No real user state is touched.
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_SH="${SCRIPT_DIR}/config.sh"
if [ ! -f "$CONFIG_SH" ]; then
  echo "missing $CONFIG_SH" >&2
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

assert_match_str() {
  local label="$1" pattern="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$pattern"; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (pattern not found: $pattern)"
    echo "       output: $haystack"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_match_str() {
  local label="$1" pattern="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$pattern"; then
    echo "  FAIL $label (pattern unexpectedly found: $pattern)"
    echo "       output: $haystack"
    FAIL=$((FAIL + 1))
  else
    echo "  ok  $label"
    PASS=$((PASS + 1))
  fi
}

# Read a JSON field via node — same helper as test-install.sh.
jget_field() {
  local f="$1" path="$2"
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const parts = process.argv[2].split(".");
    let v = j;
    for (const p of parts) { v = v?.[p]; }
    process.stdout.write(v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
  ' "$f" "$path"
}

# Build a fresh fixture:
#   $FIXTURE_ROOT/                        (synthetic CLAUDE_CONFIG_DIR)
#     plugins/creditgauge/config.json     (only when write_config is called)
#     plugins/creditgauge/state/          (always created)
build_fixture() {
  FIXTURE_ROOT="$(mktemp -d -t creditgauge-config-test-XXXXXX)"
  mkdir -p "${FIXTURE_ROOT}/plugins/creditgauge/state"
  CONFIG_FILE="${FIXTURE_ROOT}/plugins/creditgauge/config.json"
  STATE_DIR="${FIXTURE_ROOT}/plugins/creditgauge/state"
}

write_config() { printf '%s\n' "$1" > "$CONFIG_FILE"; }

write_upstream() {
  printf '#!/usr/bin/env bash\necho "upstream"\n' > "${STATE_DIR}/upstream-cmd.sh"
  chmod +x "${STATE_DIR}/upstream-cmd.sh"
}

write_disabled() {
  printf '#!/usr/bin/env bash\necho "upstream"\n' > "${STATE_DIR}/upstream-cmd.sh.disabled"
}

# Run config.sh against the fixture, capturing stdout+stderr.
run_config() {
  CLAUDE_CONFIG_DIR="$FIXTURE_ROOT" HOME="$FIXTURE_ROOT" bash "$CONFIG_SH" "$@" 2>&1
}

# --- status view -------------------------------------------------------------

echo "-- status: no config.json, no upstream --"
build_fixture
out="$(run_config)"
assert_match_str "[status-default] default preset caption" "(default — no config.json; quota/balance dispatch)" "$out"
assert_match_str "[status-default] upstream none" "upstream:           none (no upstream was preserved)" "$out"

echo "-- status: preset string --"
build_fixture
write_config '{
  "statuslineTemplate": "compact"
}'
out="$(run_config)"
assert_match_str "[status-preset] preset caption" "statuslineTemplate: compact   (preset)" "$out"

echo "-- status: custom array --"
build_fixture
write_config '{
  "statuslineTemplate": ["m_version", "s_space", "m_tokenIn"]
}'
out="$(run_config)"
assert_match_str "[status-array] custom caption" "statuslineTemplate: (custom template, 3 tokens)" "$out"

echo "-- status: unknown preset string --"
build_fixture
write_config '{
  "statuslineTemplate": "nope"
}'
out="$(run_config)"
assert_match_str "[status-unknown] lists valid presets" "unknown preset; valid: simple compact solo standard" "$out"

echo "-- status: upstream enabled / disabled --"
build_fixture
write_upstream
out="$(run_config)"
assert_match_str "[status-upstream-on] enabled" "upstream:           enabled   (state/upstream-cmd.sh)" "$out"
rm -f "${STATE_DIR}/upstream-cmd.sh"
write_disabled
out="$(run_config)"
assert_match_str "[status-upstream-off] disabled" "upstream:           disabled (preserved at state/upstream-cmd.sh.disabled)" "$out"

# --- set-preset --------------------------------------------------------------

echo "-- set-preset: preserves other keys --"
build_fixture
write_config '{
  "modeLabels": { "used": "Usage:" },
  "cacheTtlMs": 60000
}'
out="$(run_config --preset-standard)"
assert_match_str "[set-preset] ok line" "set statuslineTemplate: standard" "$out"
assert_eq "[set-preset] wrote string form" "standard" "$(jget_field "$CONFIG_FILE" statuslineTemplate)"
assert_eq "[set-preset] preserved modeLabels.used" "Usage:" "$(jget_field "$CONFIG_FILE" modeLabels.used)"
assert_eq "[set-preset] preserved cacheTtlMs" "60000" "$(jget_field "$CONFIG_FILE" cacheTtlMs)"

echo "-- set-preset: creates config.json when absent --"
build_fixture
out="$(run_config --preset-compact)"
assert_match_str "[set-preset-create] ok line" "set statuslineTemplate: compact" "$out"
assert_file_exists "[set-preset-create] config.json created" "$CONFIG_FILE"
assert_eq "[set-preset-create] value" "compact" "$(jget_field "$CONFIG_FILE" statuslineTemplate)"

echo "-- set-preset: replaces custom array --"
build_fixture
write_config '{
  "statuslineTemplate": ["m_version", "s_space", "m_tokenIn"],
  "display": "used"
}'
out="$(run_config --preset-simple)"
assert_match_str "[set-preset-replace] replaced hint" "replaced custom template with 3 tokens" "$out"
assert_eq "[set-preset-replace] value" "simple" "$(jget_field "$CONFIG_FILE" statuslineTemplate)"
assert_eq "[set-preset-replace] preserved display" "used" "$(jget_field "$CONFIG_FILE" display)"

echo "-- set-preset: unknown preset errors --"
build_fixture
out="$(run_config --preset-nope 2>&1)"; rc=$?
assert_eq "[set-preset-unknown] exit code" "1" "$rc"
assert_match_str "[set-preset-unknown] lists valid presets" "valid presets: simple compact solo standard" "$out"

echo "-- set-preset: bad JSON leaves file untouched --"
build_fixture
write_config '{ this is not json'
before="$(cat "$CONFIG_FILE")"
out="$(run_config --preset-standard 2>&1)"; rc=$?
assert_eq "[set-preset-badjson] exit code" "1" "$rc"
assert_eq "[set-preset-badjson] file untouched" "$before" "$(cat "$CONFIG_FILE")"

# --- providerOverride: set / clear -------------------------------------------
# `--provider-<id>` writes config.json's top-level `providerOverride`, which the
# statusline runtime reads to skip ANTHROPIC_BASE_URL matching. <id> must be a
# key in `providers` (hard fail otherwise); a missing plugin is only a note.

write_plugin() {
  mkdir -p "${FIXTURE_ROOT}/plugins/creditgauge/query_plugins/$1"
  printf 'export function fetchAccountCredit() { return null; }\n' \
    > "${FIXTURE_ROOT}/plugins/creditgauge/query_plugins/$1/index.js"
}

write_config_providers() {
  write_config '{
  "display": "used",
  "providers": {
    "proxya": { "TYPE": "QUOTA", "BASE_URL_COMPARED_TO": "http://127.0.0.1:3456", "COMPARE_METHOD": "EXACT" },
    "proxyb": { "TYPE": "QUOTA", "BASE_URL_COMPARED_TO": "http://127.0.0.1", "COMPARE_METHOD": "STARTWITH" }
  }
}'
}

echo "-- status: providerOverride absent --"
build_fixture
write_config '{
  "display": "used"
}'
out="$(run_config)"
assert_match_str "[status-provider-none] none caption" "providerOverride:   (none — ANTHROPIC_BASE_URL matching)" "$out"

echo "-- status: providerOverride set and valid --"
build_fixture
write_config_providers
out="$(run_config --provider-proxya)"
assert_match_str "[set-provider] ok line" "set providerOverride: proxya" "$out"
assert_eq "[set-provider] wrote value" "proxya" "$(jget_field "$CONFIG_FILE" providerOverride)"
assert_eq "[set-provider] preserved display" "used" "$(jget_field "$CONFIG_FILE" display)"
assert_eq "[set-provider] preserved providers.proxyb.COMPARE_METHOD" "STARTWITH" "$(jget_field "$CONFIG_FILE" providers.proxyb.COMPARE_METHOD)"
out="$(run_config)"
assert_match_str "[status-provider-set] forced caption" "providerOverride:   proxya   (forced — URL matching skipped)" "$out"

echo "-- set-provider: no plugin for a valid provider id only warns --"
build_fixture
write_config_providers
out="$(run_config --provider-proxyb)"; rc=$?
assert_eq "[set-provider-noplugin] exit code" "0" "$rc"
assert_match_str "[set-provider-noplugin] note printed" "no plugin found at query_plugins/proxyb/" "$out"
assert_eq "[set-provider-noplugin] still wrote value" "proxyb" "$(jget_field "$CONFIG_FILE" providerOverride)"

echo "-- set-provider: plugin present suppresses the note --"
build_fixture
write_config_providers
write_plugin proxya
out="$(run_config --provider-proxya)"
assert_not_match_str "[set-provider-plugin] no note" "no plugin found" "$out"

echo "-- set-provider: unknown id errors, file untouched --"
build_fixture
write_config_providers
before="$(cat "$CONFIG_FILE")"
out="$(run_config --provider-nope 2>&1)"; rc=$?
assert_eq "[set-provider-unknown] exit code" "1" "$rc"
assert_match_str "[set-provider-unknown] explains" "is not a key in providers" "$out"
assert_match_str "[set-provider-unknown] lists known ids" "known providers: proxya, proxyb" "$out"
assert_eq "[set-provider-unknown] file untouched" "$before" "$(cat "$CONFIG_FILE")"

echo "-- set-provider: no config.json errors --"
build_fixture
out="$(run_config --provider-proxya 2>&1)"; rc=$?
assert_eq "[set-provider-noconfig] exit code" "1" "$rc"
assert_match_str "[set-provider-noconfig] explains" "no config.json" "$out"
assert_file_missing "[set-provider-noconfig] nothing created" "$CONFIG_FILE"

echo "-- set-provider: --provider- with no id errors --"
build_fixture
out="$(run_config --provider- 2>&1)"; rc=$?
assert_eq "[set-provider-empty] exit code" "2" "$rc"
assert_match_str "[set-provider-empty] usage" "usage: /creditgauge:config" "$out"

echo "-- clear-provider: reports the previous id --"
build_fixture
write_config_providers
run_config --provider-proxya >/dev/null
out="$(run_config --clear-provider)"
assert_match_str "[clear-provider] ok line" 'cleared providerOverride (was "proxya")' "$out"
assert_eq "[clear-provider] value cleared" "" "$(jget_field "$CONFIG_FILE" providerOverride)"
assert_eq "[clear-provider] preserved providers" "EXACT" "$(jget_field "$CONFIG_FILE" providers.proxya.COMPARE_METHOD)"

echo "-- clear-provider: idempotent --"
out="$(run_config --clear-provider)"
assert_match_str "[clear-provider-idempotent] no-op" "providerOverride already unset (no-op)" "$out"

echo "-- clear-provider: no config.json is a no-op, creates nothing --"
build_fixture
out="$(run_config --clear-provider)"
assert_match_str "[clear-provider-noconfig] no-op" "no config.json; nothing to clear (no-op)" "$out"
assert_file_missing "[clear-provider-noconfig] nothing created" "$CONFIG_FILE"

echo "-- dry-run: provider writes nothing --"
build_fixture
write_config_providers
before="$(cat "$CONFIG_FILE")"
out="$(run_config --provider-proxya --dry-run)"
assert_match_str "[dry-provider] would line" "would set providerOverride: proxya" "$out"
assert_eq "[dry-provider] file untouched" "$before" "$(cat "$CONFIG_FILE")"

echo "-- dry-run: clear-provider writes nothing --"
build_fixture
write_config_providers
run_config --provider-proxya >/dev/null
after_set="$(cat "$CONFIG_FILE")"
out="$(run_config --clear-provider --dry-run)"
assert_match_str "[dry-clear-provider] would line" "would clear providerOverride" "$out"
assert_eq "[dry-clear-provider] file untouched" "$after_set" "$(cat "$CONFIG_FILE")"

echo "-- provider and preset flags combine in one invocation --"
build_fixture
write_config_providers
out="$(run_config --preset-standard --provider-proxya)"
assert_match_str "[combined] preset written" "set statuslineTemplate: standard" "$out"
assert_match_str "[combined] provider written" "set providerOverride: proxya" "$out"
assert_eq "[combined] both in file" "proxya" "$(jget_field "$CONFIG_FILE" providerOverride)"
assert_eq "[combined] preset in file" "standard" "$(jget_field "$CONFIG_FILE" statuslineTemplate)"

# --- upstream toggle ---------------------------------------------------------

echo "-- disable: renames file --"
build_fixture
write_upstream
out="$(run_config --disable-upstream)"
assert_match_str "[disable] ok line" "disabled upstream" "$out"
assert_file_missing "[disable] original gone" "${STATE_DIR}/upstream-cmd.sh"
assert_file_exists "[disable] disabled present" "${STATE_DIR}/upstream-cmd.sh.disabled"

echo "-- disable: idempotent --"
out="$(run_config --disable-upstream)"
assert_match_str "[disable-idempotent] no-op" "upstream already disabled (no-op)" "$out"

echo "-- disable: no upstream --"
build_fixture
out="$(run_config --disable-upstream)"
assert_match_str "[disable-none] no-op" "no upstream to disable (no upstream-cmd.sh found)" "$out"

echo "-- enable: renames back --"
build_fixture
write_disabled
out="$(run_config --enable-upstream)"
assert_match_str "[enable] ok line" "enabled upstream" "$out"
assert_file_exists "[enable] restored" "${STATE_DIR}/upstream-cmd.sh"
assert_file_missing "[enable] disabled gone" "${STATE_DIR}/upstream-cmd.sh.disabled"

echo "-- enable: idempotent --"
out="$(run_config --enable-upstream)"
assert_match_str "[enable-idempotent] no-op" "upstream already enabled (no-op)" "$out"

echo "-- enable: no preserved upstream --"
build_fixture
out="$(run_config --enable-upstream)"
assert_match_str "[enable-none] no-op" "no preserved upstream to enable" "$out"

echo "-- both files exist: error --"
build_fixture
write_upstream
write_disabled
out="$(run_config --disable-upstream 2>&1)"; rc=$?
assert_eq "[both-exist] exit code" "1" "$rc"
assert_match_str "[both-exist] message" "resolve manually" "$out"

# --- dry-run ----------------------------------------------------------------

echo "-- dry-run: preset does not write --"
build_fixture
out="$(run_config --preset-standard --dry-run)"
assert_match_str "[dry-preset] would line" "would set statuslineTemplate: standard" "$out"
assert_file_missing "[dry-preset] no config created" "$CONFIG_FILE"

echo "-- dry-run: disable does not rename --"
build_fixture
write_upstream
out="$(run_config --disable-upstream --dry-run)"
assert_match_str "[dry-disable] would line" "would disable upstream" "$out"
assert_file_exists "[dry-disable] file intact" "${STATE_DIR}/upstream-cmd.sh"
assert_file_missing "[dry-disable] no disabled file" "${STATE_DIR}/upstream-cmd.sh.disabled"

# --- line ending preservation ------------------------------------------------

echo "-- set-preset preserves CRLF line endings --"
build_fixture
printf '{\r\n  "display": "used"\r\n}\r\n' > "$CONFIG_FILE"
out="$(run_config --preset-standard)"
assert_match_str "[crlf] ok line" "set statuslineTemplate: standard" "$out"
# GNU grep treats `\r\n` as a line terminator and strips the trailing `\r`
# before matching, so `grep -q $'\r'` can never match a CRLF file. Removing
# `\n` first makes any CR byte mid-stream and matchable — portable across
# GNU (Linux/Git Bash) and BSD (macOS) grep.
if tr -d '\n' < "$CONFIG_FILE" | grep -q $'\r'; then
  echo "  ok  [crlf] line ending preserved"
  PASS=$((PASS + 1))
else
  echo "  FAIL [crlf] line ending NOT preserved"
  FAIL=$((FAIL + 1))
fi

# --- unknown flag ------------------------------------------------------------

echo "-- unknown flag errors --"
build_fixture
out="$(run_config --bogus 2>&1)"; rc=$?
assert_eq "[unknown-flag] exit code" "2" "$rc"
assert_match_str "[unknown-flag] usage" "usage: /creditgauge:config" "$out"

rm -rf "$FIXTURE_ROOT"

# --- Summary -----------------------------------------------------------------
echo ""
echo "test-config.sh: $PASS pass, $FAIL fail"
exit $FAIL
