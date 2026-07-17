#!/usr/bin/env bash
# test-uninstall.sh — smoke tests for the v0.9.x partial-preserve
# semantics in scripts/uninstall.sh.
#
# The branches under test:
#   - DEFAULT (no flags): partial-preserve — creditgauge/config.json,
#     creditgauge/query_plugins/, and per-project .jsonl files are
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
# `_creditgauge_managed: true`, so the statusLine branch is skipped
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
# _creditgauge_managed marker) so uninstall.sh's statusLine-restore
# branch is skipped and we exercise ONLY the wipe logic.
#
# $ROOT/                                    (synthetic CLAUDE_ROOT)
#   plugins/cache/creditgauge/creditgauge/0.9.0/  (cache stub for statusLine probe)
#   plugins/creditgauge/
#     config.json                            (user-owned; must NOT be wiped)
#     query_plugins/minimax/index.js         (user override; must NOT be wiped)
#     state/
#       cache.json                           (must be wiped)
#       cache.stat.json                      (must be wiped)
#       upstream-cmd.sh                      (must be wiped)
#       upstream-cmd.txt                     (must be wiped)
#       d--workspace-creditgauge/
#         ca62...jsonl                       (sample; default wipes, --keep-state preserves)
#         state.json                         (must be wiped)
#   plugins/installed_plugins.json           (synthetic; uninstall strips the row)
#   plugins/known_marketplaces.json          (synthetic; uninstall strips the row)
#   settings.json                            (no marker; uninstall skips restore)
build_fixture() {
  local root
  root="$(mktemp -d -t creditgauge-uninstall-test-XXXXXX)"
  local plugins="${root}/plugins"
  local cache="${plugins}/cache/creditgauge/creditgauge/0.9.0"
  local state="${plugins}/creditgauge"
  mkdir -p "${cache}/dist" "${cache}/scripts" \
           "${state}/query_plugins/minimax" \
           "${state}/state/d--workspace-creditgauge"

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
    > "${state}/state/d--workspace-creditgauge/state.json"

  # Token-sample history — conditional.
  printf '{"at":1}\n{"at":2}\n' \
    > "${state}/state/d--workspace-creditgauge/ca625a72-test-session.jsonl"

  # Settings + loader JSONs (synthetic; no marker).
  printf '{}' > "${root}/settings.json"
  printf '{"plugins":{"creditgauge@creditgauge":[]}}\n' \
    > "${plugins}/installed_plugins.json"
  printf '{"creditgauge":{"source":"github"}}\n' \
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
assert_file_exists  "[default] creditgauge/config.json preserved" \
  "${ROOT}/plugins/creditgauge/config.json"
assert_file_exists  "[default] creditgauge/query_plugins/minimax/index.js preserved" \
  "${ROOT}/plugins/creditgauge/query_plugins/minimax/index.js"
assert_dir_exists   "[default] creditgauge/query_plugins/ dir preserved" \
  "${ROOT}/plugins/creditgauge/query_plugins"

# Always-wiped cache noise gone
assert_file_missing "[default] state/cache.json wiped" \
  "${ROOT}/plugins/creditgauge/state/cache.json"
assert_file_missing "[default] state/cache.stat.json wiped" \
  "${ROOT}/plugins/creditgauge/state/cache.stat.json"
assert_file_missing "[default] state/upstream-cmd.sh wiped" \
  "${ROOT}/plugins/creditgauge/state/upstream-cmd.sh"
assert_file_missing "[default] state/upstream-cmd.txt wiped" \
  "${ROOT}/plugins/creditgauge/state/upstream-cmd.txt"

# Always-wiped per-project state.json gone
assert_file_missing "[default] state/<hash>/state.json wiped" \
  "${ROOT}/plugins/creditgauge/state/d--workspace-creditgauge/state.json"

# Default-preserved .jsonl survives (this is the differentiating
# branch from v0.9.x pre-rename — the .jsonl is preserved by default,
# and only --completely wipes it)
assert_file_exists  "[default] state/<hash>/<sid>.jsonl preserved" \
  "${ROOT}/plugins/creditgauge/state/d--workspace-creditgauge/ca625a72-test-session.jsonl"

# Cache dir wiped (matched the always-wipe list)
assert_file_missing "[default] cache/creditgauge/* wiped" \
  "${ROOT}/plugins/cache/creditgauge"

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
assert_file_missing "[completely] creditgauge/config.json wiped" \
  "${ROOT}/plugins/creditgauge/config.json"
assert_file_missing "[completely] creditgauge/query_plugins/ dir wiped" \
  "${ROOT}/plugins/creditgauge/query_plugins"

# .jsonl wiped
assert_file_missing "[completely] state/<hash>/<sid>.jsonl wiped" \
  "${ROOT}/plugins/creditgauge/state/d--workspace-creditgauge/ca625a72-test-session.jsonl"

# Always-wiped still gone
assert_file_missing "[completely] state/cache.json wiped" \
  "${ROOT}/plugins/creditgauge/state/cache.json"
assert_file_missing "[completely] state/<hash>/state.json wiped" \
  "${ROOT}/plugins/creditgauge/state/d--workspace-creditgauge/state.json"

# Post-uninstall message confirms full uninstall
assert_match_str "[completely] full-uninstall message" \
  "--completely" "$OUT"

# --completely also rmdir's the now-empty creditgauge/ parent dir
assert_dir_missing "[completely] creditgauge/ parent dir removed" \
  "${ROOT}/plugins/creditgauge"

rm -rf "$ROOT"

echo ""
echo "== v0.9.x --completely + untracked file: creditgauge/ stays, exit 0 =="

ROOT=$(build_fixture)
# Plant an untracked file the script doesn't know about (simulates
# a __legacy__/ migration leftover or a user-saved note). rmdir
# must fail with ENOTEMPTY — we want the dir to stay, NOT to
# silently nuke the untracked file.
mkdir -p "${ROOT}/plugins/creditgauge/state/d--workspace-creditgauge/__legacy__"
echo "user-saved-stuff" \
  > "${ROOT}/plugins/creditgauge/state/d--workspace-creditgauge/__legacy__/readme.txt"

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
  "${ROOT}/plugins/creditgauge/state/d--workspace-creditgauge/__legacy__/readme.txt"
# The creditgauge/ parent dir MUST stay (it's non-empty thanks to
# the untracked file).
assert_dir_exists "[untracked] creditgauge/ parent dir stays (rmdir ENOTEMPTY)" \
  "${ROOT}/plugins/creditgauge"
# The script MUST still exit 0.
assert_eq "[untracked] script still exits 0" "0" "$RC"
# The full-uninstall message MUST still be printed.
assert_match_str "[untracked] full-uninstall message still printed" \
  "every creditgauge/ artifact was wiped" "$OUT"

rm -rf "$ROOT"

echo ""
echo "== v0.9.x partial-preserve: dry-run =="

ROOT=$(build_fixture)
OUT=$(run_uninstall "$ROOT" --dry-run 2>&1)

# Default plan wipes the always-list (cache noise + state.json) but
# KEEPS .jsonl (so it must NOT appear in the plan).
assert_match_str "[dry-run] default wipes state.json" \
  "d--workspace-creditgauge/state.json" "$OUT"
assert_match_str "[dry-run] default wipes cache.json" \
  "creditgauge/state/cache.json" "$OUT"
assert_match_str "[dry-run] default wipes upstream-cmd.txt" \
  "creditgauge/state/upstream-cmd.txt" "$OUT"

# Inverse assertion: .jsonl wipe must NOT appear in the default plan.
if echo "$OUT" | grep -qF -- "ca625a72-test-session.jsonl"; then
  echo "  FAIL [dry-run default] plan contains .jsonl wipe (should be preserved)"
  FAIL=$((FAIL + 1))
else
  echo "  ok  [dry-run default] plan omits .jsonl wipe"
  PASS=$((PASS + 1))
fi
# Same for config.json / query_plugins in the default plan.
if echo "$OUT" | grep -qF -- "creditgauge/config.json"; then
  echo "  FAIL [dry-run default] plan contains config.json wipe (should be preserved)"
  FAIL=$((FAIL + 1))
else
  echo "  ok  [dry-run default] plan omits config.json wipe"
  PASS=$((PASS + 1))
fi
if echo "$OUT" | grep -qF -- "creditgauge/query_plugins"; then
  echo "  FAIL [dry-run default] plan contains query_plugins wipe (should be preserved)"
  FAIL=$((FAIL + 1))
else
  echo "  ok  [dry-run default] plan omits query_plugins wipe"
  PASS=$((PASS + 1))
fi

# Verify dry-run did NOT actually delete anything
assert_file_exists "[dry-run] cache.json still on disk" \
  "${ROOT}/plugins/creditgauge/state/cache.json"
assert_file_exists "[dry-run] config.json still on disk" \
  "${ROOT}/plugins/creditgauge/config.json"

# --completely plan SHOULD include .jsonl + config.json + query_plugins.
OUT_C=$(run_uninstall "$ROOT" --dry-run --completely 2>&1)
assert_match_str "[dry-run + --completely] plan wipes .jsonl" \
  "ca625a72-test-session.jsonl" "$OUT_C"
assert_match_str "[dry-run + --completely] plan wipes config.json" \
  "creditgauge/config.json" "$OUT_C"
assert_match_str "[dry-run + --completely] plan wipes query_plugins" \
  "creditgauge/query_plugins" "$OUT_C"
assert_match_str "[dry-run + --completely] plan rmdirs creditgauge/ (if empty)" \
  "rmdir" "$OUT_C"
assert_match_str "[dry-run + --completely] plan rmdirs the right path" \
  "creditgauge (if empty after wipes)" "$OUT_C"

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
  "${ROOT}/plugins/creditgauge/config.json"
assert_file_exists "[unknown-flag] .jsonl untouched" \
  "${ROOT}/plugins/creditgauge/state/d--workspace-creditgauge/ca625a72-test-session.jsonl"

rm -rf "$ROOT"

# ============================================================================
# Journal-driven statusLine restore (v0.10)
# ============================================================================
#
# Uninstall now prefers the install-journal over the legacy
# upstream-cmd.txt path. The journal is the authoritative record of
# what install changed, and revert happens field-by-field: only fields
# that match the post-install snapshot are undone. Tests below cover
# the five cases the user enumerated in the redesign conversation.

echo ""
echo "== journal-driven restore: per-field revert =="

# Build a fixture deliberately managing the underlying `uninstall.sh`
# call: includes a stub scripts/lib so we can drive apply-journal-entry,
# and pre-populates install-journal.json / settings.json in known
# shapes.
build_journal_fixture() {
  local root
  # Use Node's os.tmpdir() so the path is in the form Node can read
  # when invoked by uninstall.sh: bash `mktemp -d -t ...` produces
  # `/tmp/...` which Node sees as `D:\tmp\...` — wrong path. Use
  # `mktemp -d` (Linux/Git Bash) for uniqueness, then forward through
  # Node to canonicalize.
  root="$(mktemp -d -t creditgauge-ju-XXXXXX)"
  # Normalize for Node: strip /tmp -> use os.tmpdir() instead.
  root="$(node -e '
    const os = require("os");
    const inP = process.argv[1];
    const base = os.tmpdir();
    const leaf = inP.split(/[\\\\\/]/).pop();
    const out = base + require("path").sep + leaf;
    require("fs").mkdirSync(out, { recursive: true });
    process.stdout.write(out);
  ' "$root")"
  local plugins="${root}/plugins"
  local cache="${plugins}/cache/creditgauge/creditgauge/0.9.6"
  local state="${plugins}/creditgauge"
  mkdir -p "${cache}/scripts/lib" "${cache}/dist" \
           "${state}/state" "${state}/query_plugins/minimax"

  # Stub so uninstall.sh can resolve scripts/lib/edit-settings.mjs.
  cp "${SCRIPT_DIR}/lib/edit-settings.mjs" "${cache}/scripts/lib/edit-settings.mjs"
  cp "${SCRIPT_DIR}/lib/journal.mjs"        "${cache}/scripts/lib/journal.mjs"
  printf '# stub\n' > "${cache}/dist/index.js"
  printf '# stub\n' > "${cache}/scripts/wrapper.sh"

  # config.json + query_plugins preserved by default.
  printf '{"providers":{"minimax":{"provider":"minimax"}}}\n' \
    > "${state}/config.json"
  printf '#!/usr/bin/env bash\necho user-override\n' \
    > "${state}/query_plugins/minimax/index.js"
  chmod +x "${state}/query_plugins/minimax/index.js"

  # settings.json + initial journals filled in by the per-test block.
  echo "$root"
}

# Write settings.json with a managed wrapper + optional refreshInterval.
# Uses the SAME wrapper-shape install.sh writes so isOurWrapperCommand
# matches.
#
# IMPORTANT: takes paths via env vars instead of argv because Git Bash
# on Windows mangles leading-drive-letter arguments like `C:\…` into
# nothing — the colon triggers path conversion, and the entire first
# argument gets eaten. Env vars round-trip cleanly.
write_managed_settings() {
  local path="$1"
  local refresh_value="$2"   # "absent" | numeric
  local command_value="$3"   # the wrapper-shaped bash -c command
  TOPG_TEST_PATH="$path" \
  TOPG_TEST_REFRESH="$refresh_value" \
  TOPG_TEST_COMMAND="$command_value" \
  node -e '
    const fs = require("fs");
    const path = process.env["TOPG_TEST_PATH"];
    const refresh = process.env["TOPG_TEST_REFRESH"];
    const command = process.env["TOPG_TEST_COMMAND"];
    const d = { statusLine: { type: "command", command, _creditgauge_managed: true } };
    if (refresh !== "absent") d.statusLine.refreshInterval = parseInt(refresh, 10);
    fs.writeFileSync(path, JSON.stringify(d, null, 2) + "\n");
  '
}

WRAPPER_CMD='bash -c '"'"'plugin_dir=/home/test/.claude/plugins/cache/creditgauge/creditgauge/0.9.6; exec bash "${plugin_dir}scripts/wrapper.sh"'"'"''

echo "-- fresh uninstall: journal-driven, statusLine deleted entirely --"
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
write_managed_settings "$SETTINGS" absent "$WRAPPER_CMD"
# Install-journal with a single create entry for statusLine.
TOPG_TEST_SETTINGS="$SETTINGS" \
TOPG_TEST_JOURNAL="$JOURNAL" \
node -e '
  const fs = require("fs");
  const settings = process.env["TOPG_TEST_SETTINGS"];
  const journal = process.env["TOPG_TEST_JOURNAL"];
  const sl = JSON.parse(fs.readFileSync(settings, "utf8")).statusLine;
  const j = {
    version: 1, scope: "user", pluginVersion: "0.9.6",
    entries: [{
      id: "settings.json:statusLine", ts: "2026-07-15T07:00:00Z",
      action: "create", before: null, after: sl, applied: false
    }]
  };
  fs.writeFileSync(journal, JSON.stringify(j, null, 2) + "\n");
'
# The on-disk install-journal is always wiped by uninstall (cache
# noise), so post-run we cannot read `entries[i].applied` from disk.
# Capture stdout instead — if uninstall.sh printed
# `applied: settings.json:statusLine` then the apply-journal-entry
# pass invoked markApplied (which writes `applied:true` synchronously
# before the wipe), which is the side effect the original disk
# assertion was checking.
OUT=$(run_uninstall "$ROOT" 2>&1)
HAS_SL=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env["TOPG_TEST_SETTINGS"],"utf8"));
  process.stdout.write("statusLine" in d ? "yes" : "no");
')
assert_eq "[fresh-journal] statusLine removed from settings.json" "no" "$HAS_SL"
assert_match_str "[fresh-journal] apply-journal-entry reported applied" "applied: settings.json:statusLine" "$OUT"
JOURNAL_GONE=$(TOPG_TEST_JOURNAL="$JOURNAL" node -e '
  process.stdout.write(require("fs").existsSync(process.env["TOPG_TEST_JOURNAL"]) ? "no" : "yes");
')
assert_eq "[fresh-journal] install-journal.json wiped after uninstall" "yes" "$JOURNAL_GONE"
rm -rf "$ROOT"

echo "-- install-shape replay: statusLine block entry without refreshInterval + sibling refreshInterval entry -> block fully removed --"
# install.sh writes the statusLine block-level entry with `after`
# captured BEFORE ensure-refresh-interval (so the after dict does NOT
# contain refreshInterval), then writes the refreshInterval entry as a
# separate field-level sibling. The post-apply empty-block sweep in
# edit-settings.mjs#apply-journal-entry handles the residual {}; this
# is the actual regression case the user reported on v0.9.7.
#
# The fixture has ON-DISK refreshInterval=10 (the post-install state)
# but the journal's statusLine entry `after` excludes refreshInterval
# (the install-time bug-shape). Apply pass: block-level writes back
# {refreshInterval: 10} (treats refreshInterval as user-added); field-
# level then deletes refreshInterval; Pass 2 sees {} and removes it.
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
write_managed_settings "$SETTINGS" 10 "$WRAPPER_CMD"
TOPG_TEST_SETTINGS="$SETTINGS" \
TOPG_TEST_JOURNAL="$JOURNAL" \
TOPG_TEST_COMMAND="$WRAPPER_CMD" \
node -e '
  const fs = require("fs");
  const settings = process.env.TOPG_TEST_SETTINGS;
  const journal  = process.env.TOPG_TEST_JOURNAL;
  const wrapper  = process.env.TOPG_TEST_COMMAND;
  // Mirror install.sh exactly: SL_AFTER snapshot DOES NOT include
  // refreshInterval (line 405 capture-then-ensure-refresh-interval
  // ordering at install time). On-disk statusLine retains it.
  const slAfter = { type: "command", command: wrapper, _creditgauge_managed: true };
  const j = {
    version: 1, scope: "user", pluginVersion: "0.9.7",
    entries: [
      { id: "settings.json:statusLine", ts: "2026-07-16",
        action: "create", before: null, after: slAfter, applied: false },
      { id: "settings.json:statusLine.refreshInterval", ts: "2026-07-16",
        action: "create", before: null, after: 10, applied: false }
    ]
  };
  fs.writeFileSync(journal, JSON.stringify(j, null, 2) + "\n");
'
OUT=$(run_uninstall "$ROOT" 2>&1)
HAS_SL=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write("statusLine" in d ? "yes" : "no");
')
assert_eq "[install-shape-replay] statusLine removed entirely (no residue)" "no" "$HAS_SL"
assert_match_str "[install-shape-replay] post-apply sweep printed cleaned:" \
  "cleaned: empty-block-deleted" "$OUT"
SL_VAL=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write(d.statusLine === undefined ? "undefined" : JSON.stringify(d.statusLine));
')
assert_eq "[install-shape-replay] on-disk statusLine is undefined (not {})" "undefined" "$SL_VAL"
rm -rf "$ROOT"

echo "-- post-apply sweep catches user-empty: user hand-emptied statusLine post-install --"
# Edge case: user hand-edits settings.json to `statusLine: {}` after
# install. applyJournalEntry's block-level branch is one in
# preserved:all-fields-user-touched (anyReverted=false because current
# already empty), so the block itself is untouched. The post-apply
# sweep then catches the empty block via installOwnedBlock (action=create,
# before=null) and removes it.
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
write_managed_settings "$SETTINGS" absent "$WRAPPER_CMD"
TOPG_TEST_SETTINGS="$SETTINGS" \
TOPG_TEST_JOURNAL="$JOURNAL" \
TOPG_TEST_COMMAND="$WRAPPER_CMD" \
node -e '
  const fs = require("fs");
  const settings = process.env.TOPG_TEST_SETTINGS;
  const journal  = process.env.TOPG_TEST_JOURNAL;
  const wrapper  = process.env.TOPG_TEST_COMMAND;
  // Force on-disk statusLine to {} (post-install hand-edit).
  fs.writeFileSync(settings, JSON.stringify({ statusLine: {} }, null, 2) + "\n");
  const slAfter = { type: "command", command: wrapper, _creditgauge_managed: true, refreshInterval: 10 };
  const j = {
    version: 1, scope: "user", pluginVersion: "0.9.7",
    entries: [
      { id: "settings.json:statusLine", ts: "2026-07-16",
        action: "create", before: null, after: slAfter, applied: false }
    ]
  };
  fs.writeFileSync(journal, JSON.stringify(j, null, 2) + "\n");
'
OUT=$(run_uninstall "$ROOT" 2>&1)
HAS_SL=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write("statusLine" in d ? "yes" : "no");
')
assert_eq "[user-empty] statusLine removed by post-apply sweep" "no" "$HAS_SL"
assert_match_str "[user-empty] post-apply sweep cleaned:" \
  "cleaned: empty-block-deleted" "$OUT"
rm -rf "$ROOT"

echo "-- mutate + pre-install empty: applyJournalEntry's mutate fast-path deletes the block (no Pass 2 needed) --"
# When pre-install `statusLine` was `{}` (user's empty config) and
# install overwrote it with a wrapper, uninstall should restore the
# pre-install empty state. applyJournalEntry's mutate-fast-path
# (edit-settings.mjs ~310-318) handles this: `restored = { ...
# beforeObj } = {}` → `Object.keys(restored).length === 0` → deletes
# the leaf. We verify this still works after adding the Pass 2
# sweep — the sweep must not interfere with the existing delete.
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
# Pre-install: statusLine is `{}`. Post-install: still `{}`
# (settings.json was never modified by install in this synthetic
# fixture, but the journal reflects the install-time transition).
TOPG_TEST_SETTINGS="$SETTINGS" \
TOPG_TEST_JOURNAL="$JOURNAL" \
TOPG_TEST_COMMAND="$WRAPPER_CMD" \
node -e '
  const fs = require("fs");
  const settings = process.env.TOPG_TEST_SETTINGS;
  const journal  = process.env.TOPG_TEST_JOURNAL;
  const wrapper  = process.env.TOPG_TEST_COMMAND;
  fs.writeFileSync(settings, JSON.stringify({ statusLine: {} }, null, 2) + "\n");
  const after = { type: "command", command: wrapper, _creditgauge_managed: true, refreshInterval: 10 };
  const j = {
    version: 1, scope: "user", pluginVersion: "0.9.7",
    entries: [
      { id: "settings.json:statusLine", ts: "2026-07-16",
        action: "mutate", before: {}, after, applied: false }
    ]
  };
  fs.writeFileSync(journal, JSON.stringify(j, null, 2) + "\n");
'
run_uninstall "$ROOT" >/dev/null 2>&1
HAS_BLOCK=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write("statusLine" in d ? "yes" : "no");
')
assert_eq "[mutate-empty-fast-path] statusLine block fully removed (matches pre-install null state)" "no" "$HAS_BLOCK"
rm -rf "$ROOT"

echo "-- per-field revert: statusLine create entry -> user only touched refreshInterval --"
# Settings: managed + refreshInterval=20 (user bumped from our default 10).
# Journal: a create entry for statusLine (the snapshot AT install time,
# when refreshInterval was 10), plus a create entry for
# refreshInterval=10. Apply-journal-entry must restore refreshInterval
# (because the snapshot equals current==20? no, current=20 vs after=10
# → preserved; specifically the statusLine block create entry has
# refreshInterval=10 in `after`, so current.refreshInterval=20 ≠ 10 →
# skipped, preserved at 20).
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
write_managed_settings "$SETTINGS" 20 "$WRAPPER_CMD"
TOPG_TEST_JOURNAL="$JOURNAL" \
TOPG_TEST_COMMAND="$WRAPPER_CMD" \
node -e '
  const fs = require("fs");
  const journal = process.env["TOPG_TEST_JOURNAL"];
  const wrapper = process.env["TOPG_TEST_COMMAND"];
  const before = null;
  const after = {
    type: "command",
    command: wrapper,
    _creditgauge_managed: true,
    refreshInterval: 10
  };
  const j = {
    version: 1, scope: "user", pluginVersion: "0.9.6",
    entries: [
      { id: "settings.json:statusLine", ts: "2026-07-15T07:00:00Z",
        action: "create", before, after, applied: false },
      { id: "settings.json:statusLine.refreshInterval", ts: "2026-07-15T07:00:00Z",
        action: "create", before: null, after: 10, applied: false }
    ]
  };
  fs.writeFileSync(journal, JSON.stringify(j, null, 2) + "\n");
'
run_uninstall "$ROOT" >/dev/null 2>&1
# Per-field revert must KEEP the user's 20 and KEEP the statusLine
# block (the user touched a field). Verifies only the marker /
# delete logic is intact.
HAS_BLOCK=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env["TOPG_TEST_SETTINGS"],"utf8"));
  process.stdout.write(d.statusLine ? "yes" : "no");
')
assert_eq "[per-field] statusLine preserved (user touched refreshInterval)" "yes" "$HAS_BLOCK"
RI=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env["TOPG_TEST_SETTINGS"],"utf8"));
  process.stdout.write(String(d.statusLine ? d.statusLine.refreshInterval : "missing"));
')
assert_eq "[per-field] refreshInterval preserved at user's value (20)" "20" "$RI"
rm -rf "$ROOT"

echo "-- clamp-down revert: user kept 10 -> restored to 30 --"
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
write_managed_settings "$SETTINGS" 10 "$WRAPPER_CMD"
TOPG_TEST_JOURNAL="$JOURNAL" \
TOPG_TEST_COMMAND="$WRAPPER_CMD" \
node -e '
  const fs = require("fs");
  const j = {
    version: 1, scope: "user", pluginVersion: "0.9.6",
    entries: [
      { id: "settings.json:statusLine", ts: "2026-07-15T07:00:00Z",
        action: "create", before: null,
        after: { type: "command", command: process.env["TOPG_TEST_COMMAND"], _creditgauge_managed: true },
        applied: false },
      { id: "settings.json:statusLine.refreshInterval", ts: "2026-07-15T07:00:00Z",
        action: "clamp-down", before: 30, after: 10, applied: false }
    ]
  };
  fs.writeFileSync(process.env["TOPG_TEST_JOURNAL"], JSON.stringify(j, null, 2) + "\n");
'
run_uninstall "$ROOT" >/dev/null 2>&1
RI=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env["TOPG_TEST_SETTINGS"],"utf8"));
  process.stdout.write(String(d.statusLine ? d.statusLine.refreshInterval : "missing"));
')
assert_eq "[clamp-down kept=10] refreshInterval restored to 30" "30" "$RI"
rm -rf "$ROOT"

echo "-- clamp-down revert: user changed to 50 -> preserved --"
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
write_managed_settings "$SETTINGS" 50 "$WRAPPER_CMD"
TOPG_TEST_JOURNAL="$JOURNAL" \
TOPG_TEST_COMMAND="$WRAPPER_CMD" \
node -e '
  const fs = require("fs");
  const j = {
    version: 1, scope: "user", pluginVersion: "0.9.6",
    entries: [
      { id: "settings.json:statusLine", ts: "2026-07-15T07:00:00Z",
        action: "create", before: null,
        after: { type: "command", command: process.env["TOPG_TEST_COMMAND"], _creditgauge_managed: true },
        applied: false },
      { id: "settings.json:statusLine.refreshInterval", ts: "2026-07-15T07:00:00Z",
        action: "clamp-down", before: 30, after: 10, applied: false }
    ]
  };
  fs.writeFileSync(process.env["TOPG_TEST_JOURNAL"], JSON.stringify(j, null, 2) + "\n");
'
run_uninstall "$ROOT" >/dev/null 2>&1
RI=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env["TOPG_TEST_SETTINGS"],"utf8"));
  process.stdout.write(String(d.statusLine ? d.statusLine.refreshInterval : "missing"));
')
assert_eq "[clamp-down user=50] refreshInterval preserved at 50" "50" "$RI"
rm -rf "$ROOT"

echo "-- legacy fallback: no install-journal -> still restore-from-file --"
# Pre-journal install: statusLine is managed, journal absent, but
# state/upstream-cmd.txt has the pre-install original. uninstall.sh
# detects "no journal entries" and falls back to the legacy path.
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
write_managed_settings "$SETTINGS" absent "$WRAPPER_CMD"
printf '#!/usr/bin/env bash\necho ccstatusline\n' \
  > "${ROOT}/plugins/creditgauge/state/upstream-cmd.sh"
printf 'echo ccstatusline\n' \
  > "${ROOT}/plugins/creditgauge/state/upstream-cmd.txt"
chmod +x "${ROOT}/plugins/creditgauge/state/upstream-cmd.sh"
OUT=$(run_uninstall "$ROOT" 2>&1)
assert_match_str "[legacy] stdout mentions legacy fallback" \
  "restored statusLine from" "$OUT"
RI_VAL=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env["TOPG_TEST_SETTINGS"],"utf8"));
  process.stdout.write(d.statusLine ? d.statusLine.command : "missing");
')
assert_match_str "[legacy] settings.json.statusLine.command restored" \
  "ccstatusline" "$RI_VAL"
rm -rf "$ROOT"

# -- top-level block per-field revert (v0.9.x+) ---------------------------
# When install records action=mutate for statusLine (replace-mode
# install: foreign→managed), uninstall must restore the foreign command
# and remove install-only fields (_creditgauge_managed). The previous
# implementation left the marker in place and the foreign command
# untouched when refreshInterval also existed.

echo "-- statusLine mutate: replace mode + user untouched → restore foreign command + drop marker --"
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
# Settings: managed wrapper + foreign-style marker (simulating the
# post-install state, where refreshInterval was clamped 30→10).
write_managed_settings "$SETTINGS" 30 "$WRAPPER_CMD"
TOPG_TEST_SETTINGS="$SETTINGS" \
TOPG_TEST_JOURNAL="$JOURNAL" \
TOPG_TEST_BEFORE='{"type":"command","command":"echo foreign","refreshInterval":30}' \
node -e '
  const fs = require("fs");
  const before = JSON.parse(process.env.TOPG_TEST_BEFORE);
  const settings = JSON.parse(fs.readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  const j = {
    version: 1, scope: "user", pluginVersion: "0.9.6",
    entries: [{
      id: "settings.json:statusLine", ts: "2026-07-15T07:00:00Z",
      action: "mutate", before, after: settings.statusLine, applied: false
    }]
  };
  fs.writeFileSync(process.env.TOPG_TEST_JOURNAL, JSON.stringify(j, null, 2) + "\n");
'
OUT=$(run_uninstall "$ROOT" 2>&1)
assert_match_str "[mutate-block-restore] apply-journal-entry reported reverted" \
  "reverted:block-restored" "$OUT"
CMD=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write(d.statusLine ? d.statusLine.command : "missing");
')
assert_eq "[mutate-block-restore] command restored to foreign" "echo foreign" "$CMD"
MARKER=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write(d.statusLine && d.statusLine._creditgauge_managed === true ? "yes" : "no");
')
assert_eq "[mutate-block-restore] _creditgauge_managed marker removed" "no" "$MARKER"
RI=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write(String(d.statusLine ? d.statusLine.refreshInterval : "missing"));
')
assert_eq "[mutate-block-restore] refreshInterval preserved (was in before)" "30" "$RI"
rm -rf "$ROOT"

echo "-- statusLine mutate: replace mode + user changed command → only marker removed --"
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
# Install snapshot (post-install, pre-user-touch): wrapper command +
# marker + refreshInterval. User then customises the command. The
# journal's `after` snapshot reflects the install-time post-install
# state (wrapper); the current settings has user's modified command.
write_managed_settings "$SETTINGS" 10 "$WRAPPER_CMD"
TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const fs = require("fs");
  const p = process.env.TOPG_TEST_SETTINGS;
  const d = JSON.parse(fs.readFileSync(p, "utf8"));
  d.statusLine.command = "echo mycustom";
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
'
TOPG_TEST_SETTINGS="$SETTINGS" \
TOPG_TEST_JOURNAL="$JOURNAL" \
TOPG_TEST_BEFORE='{"type":"command","command":"echo foreign","refreshInterval":30}' \
TOPG_TEST_AFTER="$WRAPPER_CMD" \
node -e '
  const fs = require("fs");
  const before = JSON.parse(process.env.TOPG_TEST_BEFORE);
  // `after` reflects the install-time post-install state: wrapper
  // command, marker, refreshInterval=10.
  const after = {
    type: "command",
    command: process.env.TOPG_TEST_AFTER,
    _creditgauge_managed: true,
    refreshInterval: 10
  };
  const j = {
    version: 1, scope: "user", pluginVersion: "0.9.6",
    entries: [{
      id: "settings.json:statusLine", ts: "2026-07-15T07:00:00Z",
      action: "mutate", before, after, applied: false
    }]
  };
  fs.writeFileSync(process.env.TOPG_TEST_JOURNAL, JSON.stringify(j, null, 2) + "\n");
'
run_uninstall "$ROOT" >/dev/null 2>&1
CMD=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write(d.statusLine ? d.statusLine.command : "missing");
')
assert_eq "[mutate-partial] user-custom command preserved" "echo mycustom" "$CMD"
MARKER=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write(d.statusLine && d.statusLine._creditgauge_managed === true ? "yes" : "no");
')
assert_eq "[mutate-partial] _creditgauge_managed marker removed" "no" "$MARKER"
rm -rf "$ROOT"

echo "-- enabledPlugins create (legacy before:null) → SKIPPED, settings untouched --"
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
# Pre-uninstall state: enabledPlugins.creditgauge@creditgauge=true (added by
# Claude Code's plugin loader during /plugin install). Legacy journal
# format: action=create, before=null, after=<full post-install dict>.
# applyJournalEntry now REJECTS legacy entries outright (they would
# silently drop pre-existing siblings). The entry is marked applied but
# settings.json is left untouched — the user manually removes any
# residual creditgauge keys.
TOPG_TEST_SETTINGS="$SETTINGS" \
TOPG_TEST_JOURNAL="$JOURNAL" \
node -e '
  const fs = require("fs");
  const settings = process.env.TOPG_TEST_SETTINGS;
  const journal = process.env.TOPG_TEST_JOURNAL;
  const d = { enabledPlugins: { "creditgauge@creditgauge": true } };
  fs.writeFileSync(settings, JSON.stringify(d, null, 2) + "\n");
  const j = {
    version: 1, scope: "user", pluginVersion: "0.9.6",
    entries: [{
      id: "settings.json:enabledPlugins", ts: "2026-07-15T07:00:00Z",
      action: "create", before: null, after: d.enabledPlugins, applied: false
    }]
  };
  fs.writeFileSync(journal, JSON.stringify(j, null, 2) + "\n");
'
OUT=$(run_uninstall "$ROOT" 2>&1)
assert_match_str "[ep-legacy] apply-journal-entry reported skipped" \
  "skipped:legacy-entry" "$OUT"
HAS_EP=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write("enabledPlugins" in d ? "yes" : "no");
')
assert_eq "[ep-legacy] enabledPlugins block survives (legacy entries don't touch settings)" "yes" "$HAS_EP"
EP_VAL=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write(d.enabledPlugins && d.enabledPlugins["creditgauge@creditgauge"] === true ? "yes" : "no");
')
assert_eq "[ep-legacy] creditgauge@creditgauge stays untouched" "yes" "$EP_VAL"
rm -rf "$ROOT"

echo "-- enabledPlugins create (legacy) with sibling → sibling + key both untouched --"
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
# Mixed scenario: legacy entry on disk + a sibling in settings.json.
# Critical regression coverage: under the old code, this would drop
# the sibling silently. Under the new code, settings.json is untouched.
TOPG_TEST_SETTINGS="$SETTINGS" \
TOPG_TEST_JOURNAL="$JOURNAL" \
node -e '
  const fs = require("fs");
  const d = { enabledPlugins: {
    "claude-hud@claude-hud": true,
    "creditgauge@creditgauge": false
  } };
  fs.writeFileSync(process.env.TOPG_TEST_SETTINGS, JSON.stringify(d, null, 2) + "\n");
  const j = {
    version: 1, scope: "user", pluginVersion: "0.9.6",
    entries: [{
      id: "settings.json:enabledPlugins", ts: "2026-07-15T07:00:00Z",
      action: "create", before: null, after: { "creditgauge@creditgauge": true },
      applied: false
    }]
  };
  fs.writeFileSync(process.env.TOPG_TEST_JOURNAL, JSON.stringify(j, null, 2) + "\n");
'
run_uninstall "$ROOT" >/dev/null 2>&1
EP=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write(JSON.stringify(d.enabledPlugins));
')
assert_eq "[ep-legacy-with-sibling] enabledPlugins fully preserved (no silent drops)" \
  '{"claude-hud@claude-hud":true,"creditgauge@creditgauge":false}' "$EP"
rm -rf "$ROOT"

echo "-- extraKnownMarketplaces create (legacy before:null) → SKIPPED, settings untouched --"
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
TOPG_TEST_SETTINGS="$SETTINGS" \
TOPG_TEST_JOURNAL="$JOURNAL" \
node -e '
  const fs = require("fs");
  const d = { extraKnownMarketplaces: { "creditgauge": { "source": "github", "repo": "cwf818/creditgauge" } } };
  fs.writeFileSync(process.env.TOPG_TEST_SETTINGS, JSON.stringify(d, null, 2) + "\n");
  const j = {
    version: 1, scope: "user", pluginVersion: "0.9.6",
    entries: [{
      id: "settings.json:extraKnownMarketplaces", ts: "2026-07-15T07:00:00Z",
      action: "create", before: null, after: d.extraKnownMarketplaces, applied: false
    }]
  };
  fs.writeFileSync(process.env.TOPG_TEST_JOURNAL, JSON.stringify(j, null, 2) + "\n");
'
OUT=$(run_uninstall "$ROOT" 2>&1)
assert_match_str "[ekm-legacy] apply-journal-entry reported skipped" \
  "skipped:legacy-entry" "$OUT"
HAS_EKM=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write("extraKnownMarketplaces" in d ? "yes" : "no");
')
assert_eq "[ekm-legacy] extraKnownMarketplaces block survives" "yes" "$HAS_EKM"
LOC=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write(
    d.extraKnownMarketplaces && d.extraKnownMarketplaces.creditgauge ? "present" : "missing"
  );
')
assert_eq "[ekm-legacy] creditgauge marketplace stays in place" "present" "$LOC"
rm -rf "$ROOT"

# ============================================================================
# Per-key-diff format (v0.10+): enabledPlugins / extraKnownMarketplaces
# journal entries use a per-key diff instead of a full-dict snapshot.
# Pre-existing sibling keys (e.g. claude-hud@claude-hud) appear in
# NEITHER map and must be preserved on uninstall — they never enter
# the keySet union in applyJournalEntry (edit-settings.mjs:209-307).
# Regression coverage for the silent sibling-drop bug.
# ============================================================================

echo "-- per-key-diff: EP sibling preserved on uninstall --"
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
TOPG_TEST_SETTINGS="$SETTINGS" \
TOPG_TEST_JOURNAL="$JOURNAL" \
node -e '
  const fs = require("fs");
  const settings = process.env.TOPG_TEST_SETTINGS;
  const journal = process.env.TOPG_TEST_JOURNAL;
  // Live settings: sibling + creditgauge@creditgauge.
  const d = {
    enabledPlugins: {
      "claude-hud@claude-hud": true,
      "creditgauge@creditgauge": true
    }
  };
  fs.writeFileSync(settings, JSON.stringify(d, null, 2) + "\n");
  // New-format journal: per-key diff. before:{} (install removed nothing);
  // after only has the keys creditgauge owns.
  const j = {
    version: 1, scope: "user", pluginVersion: "0.10.0",
    entries: [{
      id: "settings.json:enabledPlugins", ts: "2026-07-15T07:00:00Z",
      action: "create",
      before: {},
      after: { "creditgauge@creditgauge": true },
      applied: false
    }]
  };
  fs.writeFileSync(journal, JSON.stringify(j, null, 2) + "\n");
'
OUT=$(run_uninstall "$ROOT" 2>&1)
HAS_HUD=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write(d.enabledPlugins && d.enabledPlugins["claude-hud@claude-hud"] === true ? "yes" : "no");
')
assert_eq "[ep-diff-sibling-preserved] claude-hud@claude-hud survives" "yes" "$HAS_HUD"
HAS_TOPGAUGE=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write(d.enabledPlugins && Object.prototype.hasOwnProperty.call(d.enabledPlugins, "creditgauge@creditgauge") ? "yes" : "no");
')
assert_eq "[ep-diff-sibling-preserved] creditgauge@creditgauge removed" "no" "$HAS_TOPGAUGE"
HAS_BLOCK=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write("enabledPlugins" in d ? "yes" : "no");
')
assert_eq "[ep-diff-sibling-preserved] enabledPlugins block survives with sibling" "yes" "$HAS_BLOCK"
rm -rf "$ROOT"

echo "-- per-key-diff: EKM sibling preserved on uninstall --"
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
TOPG_TEST_SETTINGS="$SETTINGS" \
TOPG_TEST_JOURNAL="$JOURNAL" \
node -e '
  const fs = require("fs");
  const settings = process.env.TOPG_TEST_SETTINGS;
  const journal = process.env.TOPG_TEST_JOURNAL;
  const d = {
    extraKnownMarketplaces: {
      "claude-hud": { source: { source: "github", repo: "jarrodwatts/claude-hud" } },
      "creditgauge":  { source: { source: "github", repo: "cwf818/creditgauge" } }
    }
  };
  fs.writeFileSync(settings, JSON.stringify(d, null, 2) + "\n");
  const j = {
    version: 1, scope: "user", pluginVersion: "0.10.0",
    entries: [{
      id: "settings.json:extraKnownMarketplaces", ts: "2026-07-15T07:00:00Z",
      action: "create",
      before: {},
      after: { "creditgauge": { source: { source: "github", repo: "cwf818/creditgauge" } } },
      applied: false
    }]
  };
  fs.writeFileSync(journal, JSON.stringify(j, null, 2) + "\n");
'
OUT=$(run_uninstall "$ROOT" 2>&1)
HAS_HUD_EKM=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write(d.extraKnownMarketplaces && d.extraKnownMarketplaces["claude-hud"] ? "yes" : "no");
')
assert_eq "[ekm-diff-sibling-preserved] claude-hud marketplace survives" "yes" "$HAS_HUD_EKM"
HAS_CREDITGAUGE_EKM=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write(d.extraKnownMarketplaces && Object.prototype.hasOwnProperty.call(d.extraKnownMarketplaces, "creditgauge") ? "yes" : "no");
')
assert_eq "[ekm-diff-sibling-preserved] creditgauge marketplace removed" "no" "$HAS_CREDITGAUGE_EKM"
rm -rf "$ROOT"

echo "-- per-key-diff: user added a sibling plugin post-install → preserved --"
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
TOPG_TEST_SETTINGS="$SETTINGS" \
TOPG_TEST_JOURNAL="$JOURNAL" \
node -e '
  const fs = require("fs");
  const d = {
    enabledPlugins: {
      "creditgauge@creditgauge": true,
      "user-new-plugin@user-new-plugin": true
    }
  };
  fs.writeFileSync(process.env.TOPG_TEST_SETTINGS, JSON.stringify(d, null, 2) + "\n");
  const j = {
    version: 1, scope: "user", pluginVersion: "0.10.0",
    entries: [{
      id: "settings.json:enabledPlugins", ts: "2026-07-15T07:00:00Z",
      action: "create",
      before: {},
      after: { "creditgauge@creditgauge": true },
      applied: false
    }]
  };
  fs.writeFileSync(process.env.TOPG_TEST_JOURNAL, JSON.stringify(j, null, 2) + "\n");
'
run_uninstall "$ROOT" >/dev/null 2>&1
HAS_USER_NEW=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write(d.enabledPlugins && d.enabledPlugins["user-new-plugin@user-new-plugin"] === true ? "yes" : "no");
')
assert_eq "[ep-diff-user-added-sibling] user-added sibling preserved" "yes" "$HAS_USER_NEW"
HAS_CREDITGAUGE_ADDED=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write(d.enabledPlugins && Object.prototype.hasOwnProperty.call(d.enabledPlugins, "creditgauge@creditgauge") ? "yes" : "no");
')
assert_eq "[ep-diff-user-added-sibling] creditgauge@creditgauge removed" "no" "$HAS_CREDITGAUGE_ADDED"
rm -rf "$ROOT"

echo "-- per-key-diff: user disabled creditgauge post-install → preserved --"
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
TOPG_TEST_SETTINGS="$SETTINGS" \
TOPG_TEST_JOURNAL="$JOURNAL" \
node -e '
  const fs = require("fs");
  fs.writeFileSync(process.env.TOPG_TEST_SETTINGS, JSON.stringify({
    enabledPlugins: { "creditgauge@creditgauge": false }
  }, null, 2) + "\n");
  const j = {
    version: 1, scope: "user", pluginVersion: "0.10.0",
    entries: [{
      id: "settings.json:enabledPlugins", ts: "2026-07-15T07:00:00Z",
      action: "create",
      before: {},
      after: { "creditgauge@creditgauge": true },
      applied: false
    }]
  };
  fs.writeFileSync(process.env.TOPG_TEST_JOURNAL, JSON.stringify(j, null, 2) + "\n");
'
run_uninstall "$ROOT" >/dev/null 2>&1
CREDITGAUGE_VAL=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  process.stdout.write(JSON.stringify(d.enabledPlugins && d.enabledPlugins["creditgauge@creditgauge"]));
')
assert_eq "[ep-diff-user-touched] creditgauge@creditgauge stays false" "false" "$CREDITGAUGE_VAL"
rm -rf "$ROOT"

# ============================================================================
# JSON repair fallback (v0.10+)
# ============================================================================
#
# Claude Code's plugin loader has occasionally written Windows-path
# strings with bare backslashes (e.g. `"C:\Users\…"`), which Node's
# strict JSON.parse rejects. uninstall.sh's strip functions run an
# in-place repair when parse fails: inside string values, `\X` is
# rewritten to `\\X` when X isn't a valid JSON escape char. The
# pre-repair text is preserved as a sibling `.pre-repair-<ts>.bak`
# so the user can recover if the repair misfires.

echo "-- installed_plugins.json with bare backslashes → auto-repair + strip --"
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/creditgauge/state/install-journal.json"
INSTALLED="${ROOT}/plugins/installed_plugins.json"
mkdir -p "${ROOT}/plugins"
# No managed statusLine → uninstall hits the legacy restore-from-bak
# path (no journal entries, no SL_PLAN). Install a foreign statusLine
# so the SL restore-from-bak fallback kicks in and lets the rest of
# the script reach the JSON-strip phase.
cat > "${SETTINGS}" <<EOF
{
  "statusLine": {
    "type": "command",
    "command": "echo my-pre-creditgauge",
    "_creditgauge_managed": true
  }
}
EOF
cp "${SETTINGS}" "${SETTINGS}.bak.20260701T000000"
# Settings: no enabledPlugins block; install-journal: 1 entry for
# statusLine only.
TOPG_TEST_SETTINGS="$SETTINGS" \
TOPG_TEST_JOURNAL="$JOURNAL" \
node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync(process.env.TOPG_TEST_SETTINGS, "utf8"));
  const j = {
    version: 1, scope: "user", pluginVersion: "0.9.6",
    entries: [{
      id: "settings.json:statusLine", ts: "2026-07-15T07:00:00Z",
      action: "create", before: null,
      after: d.statusLine, applied: false
    }]
  };
  fs.writeFileSync(process.env.TOPG_TEST_JOURNAL, JSON.stringify(j, null, 2) + "\n");
'
# Malformed installed_plugins.json — bare backslashes in the creditgauge
# row's installPath (the exact shape Claude Code's loader has produced
# in some upgrade chains).
cat > "${INSTALLED}" <<EOF
{
  "version": 2,
  "plugins": {
    "creditgauge@creditgauge": [
      {
        "scope": "user",
        "installPath": "C:\Users\test\.claude\plugins\cache\creditgauge\creditgauge\0.9.7",
        "version": "0.9.7"
      }
    ]
  }
}
EOF
# Bare \X in JSON strings → strict JSON.parse refuses. Sanity-check.
PARSE_FAIL=$(node -e '
  try { JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write("no"); }
  catch (e) { process.stdout.write("yes"); }
' "$INSTALLED")
assert_eq "[json-repair] fixture is intentionally malformed" "yes" "$PARSE_FAIL"

OUT=$(run_uninstall "$ROOT" 2>&1)
# A repair line should appear in the output.
assert_match_str "[json-repair] stderr notes repair" \
  "was malformed" "$OUT"
# After repair + strip: row gone.
ROW_COUNT=$(node -e '
  const txt = require("fs").readFileSync(process.argv[1], "utf8");
  process.stdout.write(String((txt.match(/"creditgauge@creditgauge"/g) || []).length));
' "$INSTALLED")
assert_eq "[json-repair] creditgauge row stripped after auto-repair" "0" "$ROW_COUNT"
# Repaired file is valid JSON.
PARSE_OK=$(node -e '
  try { JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write("yes"); }
  catch (e) { process.stdout.write("no"); }
' "$INSTALLED")
assert_eq "[json-repair] repaired file parses cleanly" "yes" "$PARSE_OK"
# Pre-repair backup saved.
HAS_PRE_BAK=$(node -e '
  const fs = require("fs");
  const dir = process.argv[1];
  const files = fs.readdirSync(dir);
  process.stdout.write(files.some(f => f.startsWith("installed_plugins.json.pre-repair-")) ? "yes" : "no");
' "$(dirname "$INSTALLED")")
assert_eq "[json-repair] pre-repair sibling backup created" "yes" "$HAS_PRE_BAK"
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
