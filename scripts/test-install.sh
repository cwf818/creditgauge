#!/usr/bin/env bash
# test-install.sh — smoke tests for the no-op / state-migrate-forward
# branch in scripts/install.sh.
#
# The branch under test:
#   - When statusLine._creditgauge_managed === true and the STABLE state
#     dir (${CLAUDE_ROOT}/plugins/creditgauge/state/) is missing the
#     upstream-cmd.txt, install.sh walks PLUGIN_BASE, finds the
#     SECOND-newest version dir (the one immediately before PLUGIN_DIR
#     in version order), and copies its state/ files (upstream-cmd.sh
#     + upstream-cmd.txt) into the STABLE state dir. This is the
#     v0.2.18 → v0.2.19 migration: per-version cache state moves to a
#     permanent location that survives cache wipes.
#   - The copy is "no clobber" — files already in the stable state dir
#     (because a previous :install set them, or because they were
#     already migrated) are not overwritten.
#
# These tests don't try to drive the real install.sh against the real
# user settings.json; they build a minimal PLUGIN_BASE (two version
# dirs) and a synthetic settings.json, then invoke install.sh with
# HOME / CLAUDE_CONFIG_DIR pointed at the fixture. The user-level path
# is exercised; project-level uses the same code path for the no-op
# branch.
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="${SCRIPT_DIR}/install.sh"
if [ ! -f "$INSTALL_SH" ]; then
  echo "missing $INSTALL_SH" >&2
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

# Build a fresh fixture:
#   $ROOT/                          (synthetic CLAUDE_ROOT)
#     settings.json                 (with _creditgauge_managed: true)
#     plugins/cache/creditgauge/
#       creditgauge/
#         0.2.7/state/upstream-cmd.{sh,txt}    (previous version, LEGACY location)
#         0.2.8/scripts/wrapper.sh             (current version)
#         0.2.8/dist/index.js                  (so dist-missing build is skipped)
#         0.2.8/scripts/install.sh + lib/      (the script under test)
#     plugins/creditgauge/state/                  (STABLE state dir, may be empty/pre-populated)
#
#   $STATUSLINE_CMD    statusLine.command value (with cache path baked in)
#   $PREV_STATE_DIR    previous version's legacy state dir
#   $STABLE_STATE_DIR  the new stable state dir (sibling of config.json)
#   $CURR_PLUGIN_DIR   current version's full path
#   $CURR_VERSION      current version string ("0.2.8")
build_fixture() {
  local with_prev_state="$1"   # "yes" or "no" — populate legacy 0.2.7/state
  local with_stable_state="$2" # "yes" or "no" — populate stable state/

  local root
  root="$(mktemp -d -t creditgauge-install-test-XXXXXX)"
  local base="${root}/plugins/cache/creditgauge/creditgauge"
  local curr="${base}/0.2.8"
  local prev="${base}/0.2.7"
  mkdir -p "${curr}/scripts/lib" "${curr}/dist/plugins/minimax" "${curr}/dist/plugins/deepseek" "${prev}/state" \
           "${root}/plugins/cache" \
           "${root}/plugins/creditgauge"

  # Previous version: state/ with the upstream-cmd that a v0.2.18 foreign
  # install would have written. Both sh and txt are present (the install.sh
  # replace branch writes both).
  cat > "${prev}/state/upstream-cmd.txt" <<'EOF'
echo "previous user statusline: ccstatusline"
EOF
  cat > "${prev}/state/upstream-cmd.sh" <<'EOF'
#!/usr/bin/env bash
echo "previous user statusline: ccstatusline"
EOF
  chmod +x "${prev}/state/upstream-cmd.sh"

  # Current version: scripts/wrapper.sh + the install.sh + lib + dist.
  # We symlink back to the real files in the repo so we test the real
  # install.sh, not a copy.
  ln -s "${SCRIPT_DIR}/wrapper.sh" "${curr}/scripts/wrapper.sh"
  ln -s "${SCRIPT_DIR}/install.sh" "${curr}/scripts/install.sh"
  ln -s "${SCRIPT_DIR}/lib/edit-settings.mjs" "${curr}/scripts/lib/edit-settings.mjs"
  # Provide stub runtime artifacts so the install script's "build on
  # demand" branch is skipped — tests must not need network access.
  printf '# stub\n' > "${curr}/dist/index.js"
  printf '# stub\n' > "${curr}/dist/plugins/minimax/index.js"
  printf '# stub\n' > "${curr}/dist/plugins/deepseek/index.js"

  # Optionally pre-populate the STABLE state dir (the "already migrated"
  # case). When with_stable_state=yes, write a DIFFERENT upstream-cmd so
  # we can assert install.sh did not clobber it.
  if [ "$with_stable_state" = "yes" ]; then
    mkdir -p "${root}/plugins/creditgauge/state"
    cat > "${root}/plugins/creditgauge/state/upstream-cmd.txt" <<'EOF'
echo "stable state — do not clobber"
EOF
    cat > "${root}/plugins/creditgauge/state/upstream-cmd.sh" <<'EOF'
#!/usr/bin/env bash
echo "stable state — do not clobber"
EOF
    chmod +x "${root}/plugins/creditgauge/state/upstream-cmd.sh"
  fi

  # settings.json with _creditgauge_managed: true (so install.sh hits the
  # no-op branch under test). The statusLine.command is hand-crafted to
  # pass edit-settings.mjs's isOurWrapperCommand fingerprint:
  #   - path contains plugins[/\]cache[/\]creditgauge[/\]creditgauge[/\]
  #   - ends with `wrapper.sh"'` (single-quote after closing double-quote)
  # The minimal shape that satisfies both: a `bash -c '…exec bash "<path>/scripts/wrapper.sh"'`
  # whose <path> contains the cache marker. We use the real install path.
  cat > "${root}/settings.json" <<EOF
{
  "statusLine": {
    "type": "command",
    "command": "bash -c 'plugin_dir=${curr}; exec bash \"\${plugin_dir}scripts/wrapper.sh\"'",
    "_creditgauge_managed": true
  }
}
EOF

  FIXTURE_ROOT="$root"
  CURR_PLUGIN_DIR="$curr"
  PREV_STATE_DIR="${prev}/state"
  STABLE_STATE_DIR="${root}/plugins/creditgauge/state"
  CURR_VERSION="0.2.8"
  # CLAUDE_CONFIG_DIR is the parent of `plugins/`, not `plugins/` itself.
  CLAUDE_CONFIG_DIR_VAL="$root"
}

# Run install.sh against a built fixture. Captures stdout; we don't
# care about exit code (the no-op branch exits 0).
run_install() {
  local out
  out=$(HOME="$FIXTURE_ROOT" CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR_VAL" \
        bash "$INSTALL_SH" 2>&1) || true
  echo "$out"
}

# --- Tests -------------------------------------------------------------------

echo "== install.sh: state-migrate-forward on no-op =="

echo "-- migrates legacy state/ from previous version when stable state/ is empty --"
build_fixture yes no
out=$(run_install)
assert_file_exists "upstream-cmd.txt migrated to stable state/" "${STABLE_STATE_DIR}/upstream-cmd.txt"
assert_file_exists "upstream-cmd.sh migrated to stable state/" "${STABLE_STATE_DIR}/upstream-cmd.sh"
assert_eq "upstream-cmd.txt content matches legacy" \
  "echo \"previous user statusline: ccstatusline\"" \
  "$(cat "${STABLE_STATE_DIR}/upstream-cmd.txt")"
if [ -x "${STABLE_STATE_DIR}/upstream-cmd.sh" ]; then
  echo "  ok  upstream-cmd.sh kept executable bit"
  PASS=$((PASS + 1))
else
  echo "  FAIL upstream-cmd.sh not executable"
  FAIL=$((FAIL + 1))
fi
assert_match_str "log line announces migration" "migrated legacy state/" "$out"
# Tear down.
rm -rf "$FIXTURE_ROOT"

echo "-- does NOT clobber stable state/ when already populated --"
build_fixture yes yes
out=$(run_install)
assert_eq "upstream-cmd.txt content untouched (stable preserved)" \
  "echo \"stable state — do not clobber\"" \
  "$(cat "${STABLE_STATE_DIR}/upstream-cmd.txt")"
assert_eq "upstream-cmd.sh content untouched" \
  "$(printf '#!/usr/bin/env bash\necho "stable state — do not clobber"\n')" \
  "$(cat "${STABLE_STATE_DIR}/upstream-cmd.sh")"
# The migration message should NOT appear when the files were already there.
if echo "$out" | grep -qF "migrated legacy state/"; then
  echo "  FAIL should not have printed migration log"
  FAIL=$((FAIL + 1))
else
  echo "  ok  did not log migration (stable state/ was already populated)"
  PASS=$((PASS + 1))
fi
rm -rf "$FIXTURE_ROOT"

echo "-- no previous version (only one cache dir): no-op without copying --"
root="$(mktemp -d -t creditgauge-install-test-XXXXXX)"
base="${root}/plugins/cache/creditgauge/creditgauge"
curr="${base}/0.2.8"
mkdir -p "${curr}/scripts/lib" "${curr}/dist/plugins/minimax" "${curr}/dist/plugins/deepseek" "${root}/plugins/creditgauge"
ln -s "${SCRIPT_DIR}/wrapper.sh" "${curr}/scripts/wrapper.sh"
ln -s "${SCRIPT_DIR}/install.sh" "${curr}/scripts/install.sh"
ln -s "${SCRIPT_DIR}/lib/edit-settings.mjs" "${curr}/scripts/lib/edit-settings.mjs"
printf '# stub\n' > "${curr}/dist/index.js"
printf '# stub\n' > "${curr}/dist/plugins/minimax/index.js"
printf '# stub\n' > "${curr}/dist/plugins/deepseek/index.js"
cat > "${root}/settings.json" <<EOF
{ "statusLine": { "type": "command", "command": "bash -c 'plugin_dir=${curr}; exec bash \"\${plugin_dir}scripts/wrapper.sh\"'", "_creditgauge_managed": true } }
EOF
out=$(HOME="$root" CLAUDE_CONFIG_DIR="$root" bash "$INSTALL_SH" 2>&1) || true
assert_file_missing "stable upstream-cmd.txt was NOT created from nowhere" \
  "${root}/plugins/creditgauge/state/upstream-cmd.txt"
if echo "$out" | grep -qF "migrated legacy state/"; then
  echo "  FAIL should not have printed migration log (no previous version)"
  FAIL=$((FAIL + 1))
else
  echo "  ok  no migration log when there's no previous version"
  PASS=$((PASS + 1))
fi
assert_match_str "standard no-op message printed" "already managed" "$out"
rm -rf "$root"

# --- Journal + refreshInterval -----------------------------------------------
#
# v0.10: install-journal records every modification install.sh makes to
# settings.json; uninstall reads entries field-by-field and only reverts
# ones the user hasn't touched. statusLine.refreshInterval is forced to
# be set (or clamped down) to 10 on install. These tests cover the
# happy paths so a regression in either flow surfaces immediately.

echo ""
echo "== install.sh: install-journal + refreshInterval =="

# Fixture: a "plugin cache" with only the script-under-test + dist
# stubs + lib. Settings target is synthetic — we point CLAUDE_CONFIG_DIR
# at the fixture root.
build_journal_fixture() {
  local with_status_line="$1"  # "yes" / "no" / "with-refresh"
  local root
  root="$(mktemp -d -t creditgauge-journal-test-XXXXXX)"
  local base="${root}/plugins/cache/creditgauge/creditgauge/0.9.6"
  mkdir -p "${base}/scripts/lib" "${base}/dist/plugins/minimax" "${base}/dist/plugins/deepseek"
  ln -sf "${SCRIPT_DIR}/wrapper.sh" "${base}/scripts/wrapper.sh"
  ln -sf "${SCRIPT_DIR}/install.sh" "${base}/scripts/install.sh"
  ln -sf "${SCRIPT_DIR}/lib/edit-settings.mjs" "${base}/scripts/lib/edit-settings.mjs"
  ln -sf "${SCRIPT_DIR}/lib/journal.mjs" "${base}/scripts/lib/journal.mjs"
  printf '# stub\n' > "${base}/dist/index.js"
  printf '# stub\n' > "${base}/dist/plugins/minimax/index.js"
  printf '# stub\n' > "${base}/dist/plugins/deepseek/index.js"
  case "$with_status_line" in
    no)
      printf '{}\n' > "${root}/settings.json"
      ;;
    with-refresh)
      printf '{}\n' > "${root}/settings.json"
      # Caller injects refreshInterval after fixture build.
      ;;
  esac
  FIXTURE_ROOT="$root"
  CACHE_BASE="$base"
}

# Read a JSON field via node — same helper as test-edit-settings.sh.
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

echo "-- fresh install: journal records statusLine create, refreshInterval create --"
build_journal_fixture no
out=$(HOME="$FIXTURE_ROOT" CLAUDE_CONFIG_DIR="$FIXTURE_ROOT" \
      bash "$CACHE_BASE/scripts/install.sh" 2>&1) || true
JOURNAL="$FIXTURE_ROOT/plugins/creditgauge/state/install-journal.json"
assert_file_exists "[journal] created on fresh install" "$JOURNAL"
assert_eq "[journal] contains exactly 2 entries (create statusLine, create refreshInterval)" \
  "2" \
  "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.entries.length)' "$JOURNAL")"
assert_eq "[journal] first entry id = settings.json:statusLine" \
  "settings.json:statusLine" \
  "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.entries[0].id)' "$JOURNAL")"
assert_eq "[journal] statusLine action = create" \
  "create" \
  "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.entries[0].action)' "$JOURNAL")"
assert_eq "[journal] refreshInterval entry recorded" \
  "settings.json:statusLine.refreshInterval" \
  "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.entries[1].id)' "$JOURNAL")"
assert_eq "[journal] refreshInterval after = 10" \
  "10" \
  "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.entries[1].after)' "$JOURNAL")"
assert_eq "[settings] statusLine.refreshInterval = 10" \
  "10" "$(jget_field "$FIXTURE_ROOT/settings.json" statusLine.refreshInterval)"
assert_match_str "[stdout] clamp/create message printed" "refreshInterval" "$out"
rm -rf "$FIXTURE_ROOT"

echo "-- replace install with refreshInterval=30 -> journal records clamp-down --"
build_journal_fixture with-refresh
# Hand-build a settings.json with a non-managed statusLine + refreshInterval=30
node -e '
  const fs = require("fs");
  const d = { statusLine: { type: "command", command: "echo alien", refreshInterval: 30 } };
  fs.writeFileSync(process.argv[1], JSON.stringify(d, null, 2) + "\n");
' "$FIXTURE_ROOT/settings.json"
out=$(HOME="$FIXTURE_ROOT" CLAUDE_CONFIG_DIR="$FIXTURE_ROOT" \
      bash "$CACHE_BASE/scripts/install.sh" 2>&1) || true
JOURNAL="$FIXTURE_ROOT/plugins/creditgauge/state/install-journal.json"
assert_file_exists "[journal] created on replace" "$JOURNAL"
assert_eq "[journal] refreshInterval entry action = clamp-down" \
  "clamp-down" \
  "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.entries[1].action)' "$JOURNAL")"
assert_eq "[journal] refreshInterval clamp-down before=30 after=10" \
  "30" \
  "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.entries[1].before)' "$JOURNAL")"
assert_eq "[settings] statusLine.refreshInterval clamped to 10" \
  "10" "$(jget_field "$FIXTURE_ROOT/settings.json" statusLine.refreshInterval)"
assert_match_str "[stdout] clamp-down 'clamp-down|30|10' line" "clamp-down|30|10" "$out"
rm -rf "$FIXTURE_ROOT"

echo "-- replace install with refreshInterval=5 (no-op) -> no journal entry for refreshInterval --"
build_journal_fixture with-refresh
node -e '
  const fs = require("fs");
  const d = { statusLine: { type: "command", command: "echo alien", refreshInterval: 5 } };
  fs.writeFileSync(process.argv[1], JSON.stringify(d, null, 2) + "\n");
' "$FIXTURE_ROOT/settings.json"
out=$(HOME="$FIXTURE_ROOT" CLAUDE_CONFIG_DIR="$FIXTURE_ROOT" \
      bash "$CACHE_BASE/scripts/install.sh" 2>&1) || true
JOURNAL="$FIXTURE_ROOT/plugins/creditgauge/state/install-journal.json"
assert_file_exists "[journal] created on replace (no-op refreshInterval)" "$JOURNAL"
COUNT=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.entries.length)' "$JOURNAL")
assert_eq "[journal] only 1 entry (statusLine mutate, refreshInterval skipped)" "1" "$COUNT"
assert_match_str "[stdout] no-op 'refreshInterval' message" "no-op|5" "$out"
rm -rf "$FIXTURE_ROOT"

echo "-- fresh install with pre-existing sibling: per-key diff excludes sibling --"
# v0.10+ install-journal writes a per-key diff for enabledPlugins so
# pre-existing sibling keys (e.g. claude-hud@claude-hud) are preserved on
# uninstall. The diff is computed by projecting the live settings.json
# down to the keys creditgauge owns (creditgauge@creditgauge in EP, creditgauge in
# EKM) — every other key is the user's and never enters the journal.
# Simulate the Claude-Code loader's behaviour: settings.json has both
# the sibling AND the creditgauge@creditgauge key (loader added it before
# install.sh ran). After install, journal EP entry should be:
#   before: {} (install didn't remove any pre-existing key)
#   after:  { "creditgauge@creditgauge": true } (install created exactly one key)
# The sibling claude-hud@claude-hud must NOT appear in either map.
build_journal_fixture no
node -e '
  const fs = require("fs");
  const d = {
    enabledPlugins: {
      "claude-hud@claude-hud": true,
      "creditgauge@creditgauge": true
    },
    extraKnownMarketplaces: {
      "claude-hud": { source: { source: "github", repo: "jarrodwatts/claude-hud" } },
      "creditgauge":  { source: { source: "github", repo: "cwf818/creditgauge" } }
    }
  };
  fs.writeFileSync(process.argv[1], JSON.stringify(d, null, 2) + "\n");
' "${FIXTURE_ROOT}/settings.json"
out=$(HOME="$FIXTURE_ROOT" CLAUDE_CONFIG_DIR="$FIXTURE_ROOT" \
      bash "$CACHE_BASE/scripts/install.sh" 2>&1) || true
JOURNAL="$FIXTURE_ROOT/plugins/creditgauge/state/install-journal.json"
assert_file_exists "[journal-ep-diff] journal created" "$JOURNAL"
# Locate the EP entry.
EP_BEFORE=$(node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const e = j.entries.find(x => x.id === "settings.json:enabledPlugins");
  process.stdout.write(JSON.stringify(e ? e.before : null));
' "$JOURNAL")
assert_eq "[journal-ep-diff] EP before = {} (sibling absent from before)" "{}" "$EP_BEFORE"
EP_AFTER=$(node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const e = j.entries.find(x => x.id === "settings.json:enabledPlugins");
  process.stdout.write(JSON.stringify(e ? e.after : null));
' "$JOURNAL")
assert_eq "[journal-ep-diff] EP after only has creditgauge@creditgauge (sibling absent from after)" \
  '{"creditgauge@creditgauge":true}' "$EP_AFTER"
# Same shape for EKM.
EKM_BEFORE=$(node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const e = j.entries.find(x => x.id === "settings.json:extraKnownMarketplaces");
  process.stdout.write(JSON.stringify(e ? e.before : null));
' "$JOURNAL")
assert_eq "[journal-ekm-diff] EKM before = {} (claude-hud absent from before)" "{}" "$EKM_BEFORE"
EKM_AFTER=$(node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const e = j.entries.find(x => x.id === "settings.json:extraKnownMarketplaces");
  process.stdout.write(JSON.stringify(e ? e.after : null));
' "$JOURNAL")
assert_eq "[journal-ekm-diff] EKM after only has creditgauge (claude-hud absent from after)" \
  '{"creditgauge":{"source":{"source":"github","repo":"cwf818/creditgauge"}}}' "$EKM_AFTER"
rm -rf "$FIXTURE_ROOT"

echo "-- fresh install with no loader keys: both EP and EKM entries skipped --"
# Loader didn't populate either dict (degenerate: only happens if
# /plugin install ran but somehow creditgauge wasn't added — e.g. a
# half-completed install). After = {} → entry skipped entirely.
build_journal_fixture no
node -e '
  const fs = require("fs");
  fs.writeFileSync(process.argv[1], "{}\n");
' "${FIXTURE_ROOT}/settings.json"
out=$(HOME="$FIXTURE_ROOT" CLAUDE_CONFIG_DIR="$FIXTURE_ROOT" \
      bash "$CACHE_BASE/scripts/install.sh" 2>&1) || true
JOURNAL="$FIXTURE_ROOT/plugins/creditgauge/state/install-journal.json"
assert_file_exists "[journal-no-loader] journal created" "$JOURNAL"
HAS_EP=$(node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const e = j.entries.find(x => x.id === "settings.json:enabledPlugins");
  process.stdout.write(e ? "yes" : "no");
' "$JOURNAL")
assert_eq "[journal-no-loader] EP entry skipped (loader didn't add creditgauge@creditgauge)" "no" "$HAS_EP"
HAS_EKM=$(node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const e = j.entries.find(x => x.id === "settings.json:extraKnownMarketplaces");
  process.stdout.write(e ? "yes" : "no");
' "$JOURNAL")
assert_eq "[journal-no-loader] EKM entry skipped (loader didn't add creditgauge)" "no" "$HAS_EKM"
rm -rf "$FIXTURE_ROOT"

# --- Summary -----------------------------------------------------------------
echo ""
echo "test-install.sh: $PASS pass, $FAIL fail"
exit $FAIL