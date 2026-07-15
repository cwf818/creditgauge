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
  root="$(mktemp -d -t topgauge-ju-XXXXXX)"
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
  local cache="${plugins}/cache/topgauge/topgauge/0.9.6"
  local state="${plugins}/topgauge"
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
    const d = { statusLine: { type: "command", command, _topgauge_managed: true } };
    if (refresh !== "absent") d.statusLine.refreshInterval = parseInt(refresh, 10);
    fs.writeFileSync(path, JSON.stringify(d, null, 2) + "\n");
  '
}

WRAPPER_CMD='bash -c '"'"'plugin_dir=/home/test/.claude/plugins/cache/topgauge/topgauge/0.9.6; exec bash "${plugin_dir}scripts/wrapper.sh"'"'"''

echo "-- fresh uninstall: journal-driven, statusLine deleted entirely --"
ROOT=$(build_journal_fixture)
SETTINGS="${ROOT}/settings.json"
JOURNAL="${ROOT}/plugins/topgauge/state/install-journal.json"
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
run_uninstall "$ROOT" >/dev/null 2>&1
HAS_SL=$(TOPG_TEST_SETTINGS="$SETTINGS" node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env["TOPG_TEST_SETTINGS"],"utf8"));
  process.stdout.write("statusLine" in d ? "yes" : "no");
')
assert_eq "[fresh-journal] statusLine removed from settings.json" "no" "$HAS_SL"
APPLIED=$(TOPG_TEST_JOURNAL="$JOURNAL" node -e '
  const j = JSON.parse(require("fs").readFileSync(process.env["TOPG_TEST_JOURNAL"],"utf8"));
  process.stdout.write(j.entries[0].applied ? "yes" : "no");
')
assert_eq "[fresh-journal] journal entry marked applied" "yes" "$APPLIED"
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
JOURNAL="${ROOT}/plugins/topgauge/state/install-journal.json"
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
    _topgauge_managed: true,
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
JOURNAL="${ROOT}/plugins/topgauge/state/install-journal.json"
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
        after: { type: "command", command: process.env["TOPG_TEST_COMMAND"], _topgauge_managed: true },
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
JOURNAL="${ROOT}/plugins/topgauge/state/install-journal.json"
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
        after: { type: "command", command: process.env["TOPG_TEST_COMMAND"], _topgauge_managed: true },
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
  > "${ROOT}/plugins/topgauge/state/upstream-cmd.sh"
printf 'echo ccstatusline\n' \
  > "${ROOT}/plugins/topgauge/state/upstream-cmd.txt"
chmod +x "${ROOT}/plugins/topgauge/state/upstream-cmd.sh"
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

# ============================================================================
# Summary
# ============================================================================

echo ""
echo "tests: PASS=${PASS} FAIL=${FAIL}"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
