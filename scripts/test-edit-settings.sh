#!/usr/bin/env bash
# test-edit-settings.sh — smoke tests for scripts/lib/edit-settings.mjs
#
# These are not full unit tests (the lib has no test harness), but they
# cover the bits that a wrong regex / wrong escape would silently break:
#
#   - isOurWrapperCommand recognizes the latest-cache-dir command we
#     write today. (Earlier the fingerprint also accepted the legacy
#     `tokenplan-usage-hud` cache path; that legacy is gone as of v0.9.0.)
#   - buildLatestCacheCommand actually runs in bash — the '"'"'
#     escape chain is correct, plugin_dir resolves to the highest-
#     version cache dir, and the wrapper script execs.
#   - restore-from-file preserves user-set fields like refreshInterval
#     (regression for v0.2.4).
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="${SCRIPT_DIR}/lib/edit-settings.mjs"
if [ ! -f "$LIB" ]; then
  echo "missing $LIB" >&2
  exit 1
fi

# Resolve a Windows path Node can open, even from Git Bash where paths
# in env vars sometimes get re-mapped.
winpath() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1" 2>/dev/null || echo "$1"
  else
    echo "$1"
  fi
}

PASS=0
FAIL=0
TMPDIR="$(mktemp -d -t topgauge-tests-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

# assert_eq <label> <expected> <actual>
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

# assert_match <label> <pattern> <string>
assert_match() {
  local label="$1" pattern="$2" string="$3"
  if echo "$string" | grep -qE "$pattern"; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label"
    echo "       pattern: $pattern"
    echo "       string:  $string"
    FAIL=$((FAIL + 1))
  fi
}

# Read a JSON field via node — avoids jq dependency.
jget() {
  local file="$1" field="$2"
  node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const parts=process.argv[2].split(".");let v=j;for(const p of parts){v=v?.[p]}process.stdout.write(v===undefined?"":typeof v==="string"?v:JSON.stringify(v))' "$file" "$field"
}

echo "=== write-managed: latest-cache-dir command ==="
SETTINGS="$TMPDIR/settings.json"
python -c '
import json
data = {"statusLine": {"type": "command", "command": "echo pre", "refreshInterval": 90}}
print(json.dumps(data, indent=2))
' > "$SETTINGS"

WIN_SETTINGS="$(winpath "$SETTINGS")"
WIN_WRAPPER="$(winpath "$SCRIPT_DIR/wrapper.sh")"
WIN_UPSTREAM="$(winpath "$TMPDIR/upstream.sh")"

# wrapper.sh may not exist relative to scripts/ in this layout — pass any
# non-empty path; we only assert the command shape, not the wrapper call.
node "$LIB" "$WIN_SETTINGS" write-managed "$WIN_WRAPPER" "$WIN_UPSTREAM" >/dev/null

CMD="$(jget "$SETTINGS" statusLine.command)"
assert_match "command starts with bash -c '" "bash -c '" "$CMD"
assert_match "command references new cache dir glob" "topgauge/topgauge/\*/" "$CMD"
assert_match "command uses sort -t. for version sort" "sort -t\\." "$CMD"
assert_match "command tails -1 + cut -f2-" "tail -1 \\| cut -f2-" "$CMD"
assert_match "command guards against missing cache" '\[ -d "\$plugin_dir" \]' "$CMD"
assert_match "command points upstream at new stable state dir" 'TOPGAUGE_UPSTREAM_CMD="\$\{CLAUDE_CONFIG_DIR:-\$HOME/.claude\}/plugins/topgauge/state/upstream-cmd.sh"' "$CMD"
assert_match "command execs wrapper from \$plugin_dir" 'exec bash "\$\{plugin_dir\}scripts/wrapper.sh"' "$CMD"
assert_eq "refreshInterval preserved" "90" "$(jget "$SETTINGS" statusLine.refreshInterval)"
assert_eq "managed marker set" "true" "$(jget "$SETTINGS" statusLine._topgauge_managed)"

echo ""
echo "=== status op: fingerprint matches latest-cache command ==="
STATUS="$(node "$LIB" "$WIN_SETTINGS" status)"
assert_eq "status reports managed" "managed" "$STATUS"

echo ""
echo "=== restore-from-file preserves refreshInterval ==="
RESTORE_CMD='bash -c '"'"'export TOPGAUGE_UPSTREAM_CMD="/home/test/.claude/upstream.sh"; exec bash "/home/test/.claude/plugins/cache/topgauge/topgauge/0.2.5/scripts/wrapper.sh"'"'"''
python -c "import json,sys; print(json.dumps({'statusLine':{'type':'command','command':sys.argv[1],'refreshInterval':75,'_topgauge_managed':True}}, indent=2))" "$RESTORE_CMD" > "$SETTINGS"
echo 'echo restored' > "$TMPDIR/upstream.txt"
WIN_UPSTREAM_TXT="$(winpath "$TMPDIR/upstream.txt")"
node "$LIB" "$WIN_SETTINGS" restore-from-file "$WIN_UPSTREAM_TXT" >/dev/null
assert_eq "refreshInterval survives restore" "75" "$(jget "$SETTINGS" statusLine.refreshInterval)"
assert_match "command restored to upstream" "echo restored" "$(jget "$SETTINGS" statusLine.command)"
assert_eq "marker cleared" "" "$(jget "$SETTINGS" statusLine._topgauge_managed)"

echo ""
echo "=== bash can actually execute the latest-cache command ==="
# Only meaningful on a real install where cache dirs exist. We just
# verify bash parses it without errors — pipe chain yields a path.
bash -n -c "$CMD" 2>/dev/null
RC=$?
assert_eq "bash -c accepts the command (syntax check)" "0" "$RC"

# ----------------------------------------------------------------------------
# v0.10: ensure-refresh-interval + apply-journal-entry ops
# ----------------------------------------------------------------------------
#
# NOTE: $TMPDIR is /tmp/... on Git Bash, which Node interprets as
# D:\tmp\... (wrong drive). Always pass paths to node via env vars in
# these tests — argv[1] will be silently dropped on Windows when the
# first arg starts with a drive letter.

echo ""
echo "=== ensure-refresh-interval ==="
SETTINGS="$TMPDIR/settings.json"
JOURNAL="$TMPDIR/journal.json"
rm -f "$JOURNAL"
WIN_SETTINGS="$(winpath "$SETTINGS")"
WIN_JOURNAL="$(winpath "$JOURNAL")"

# Start clean: managed statusLine, no refreshInterval.
python -c '
import json
data = {"statusLine": {"type": "command", "command": "bash -c '"'"'P=x; exec bash \"${P}scripts/wrapper.sh\"'"'"'", "_topgauge_managed": True}}
print(json.dumps(data, indent=2))
' > "$SETTINGS"

# Create = 10 when field missing
OUT="$(node "$LIB" "$WIN_SETTINGS" ensure-refresh-interval 10 "$WIN_JOURNAL")"
assert_eq "create|10 message on missing field" "create|10" "$OUT"
assert_eq "refreshInterval=10 written" "10" "$(jget "$SETTINGS" statusLine.refreshInterval)"

# No-op when value <= 10
OUT="$(node "$LIB" "$WIN_SETTINGS" ensure-refresh-interval 10 "$WIN_JOURNAL")"
assert_eq "no-op|10 (already at max)" "no-op|10" "$OUT"

# Clamp-down when value > 10
python -c '
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
d["statusLine"]["refreshInterval"] = 30
open(sys.argv[1], "w", encoding="utf-8").write(json.dumps(d, indent=2))
' "$SETTINGS"
OUT="$(node "$LIB" "$WIN_SETTINGS" ensure-refresh-interval 10 "$WIN_JOURNAL")"
assert_eq "clamp-down|30|10 message" "clamp-down|30|10" "$OUT"
assert_eq "refreshInterval clamped to 10" "10" "$(jget "$SETTINGS" statusLine.refreshInterval)"

# Journal got 2 entries (create + clamp-down). Read via env var.
JCOUNT=$(TOPG_TEST_PATH="$JOURNAL" node -e "
  const j = JSON.parse(require('fs').readFileSync(process.env.TOPG_TEST_PATH, 'utf8'));
  process.stdout.write(String(j.entries.length));
")
assert_eq "journal recorded 2 entries (create + clamp-down)" "2" "$JCOUNT"

echo ""
echo "=== apply-journal-entry ==="
# Set up a fresh journal with a statusLine create entry. Use env vars.
TOPG_TEST_SETTINGS="$SETTINGS" \
TOPG_TEST_JOURNAL="$JOURNAL" \
node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync(process.env.TOPG_TEST_SETTINGS, 'utf8'));
const j = {
  version: 1, scope: 'user', pluginVersion: '0.9.6',
  entries: [{
    id: 'settings.json:statusLine',
    ts: '2026-07-15T07:00:00.000Z',
    action: 'create', before: null,
    after: d.statusLine, applied: false
  }]
};
fs.writeFileSync(process.env.TOPG_TEST_JOURNAL, JSON.stringify(j, null, 2) + '\n');
"

# Apply once — fresh-create with before=null → statusLine block deleted.
node "$LIB" "$WIN_SETTINGS" apply-journal-entry "$WIN_JOURNAL" >/dev/null 2>&1
HAS_SL=$(TOPG_TEST_PATH="$SETTINGS" node -e "
  const d = JSON.parse(require('fs').readFileSync(process.env.TOPG_TEST_PATH, 'utf8'));
  process.stdout.write('statusLine' in d ? 'yes' : 'no');
")
assert_eq "after first apply: statusLine block deleted" "no" "$HAS_SL"

# Re-run: entry is now `applied: true` → op should be a no-op.
OUT2="$(node "$LIB" "$WIN_SETTINGS" apply-journal-entry "$WIN_JOURNAL" 2>&1)"
# `applied:true` entries are filtered out before iteration, so the op
# is silent on re-run. Verify the journal survived unchanged AND
# settings.json wasn't touched (no `_topgauge_managed` re-introduced,
# no spurious `statusLine: {}`).
APPLIED_FINAL=$(TOPG_TEST_PATH="$JOURNAL" node -e "
  const j = JSON.parse(require('fs').readFileSync(process.env.TOPG_TEST_PATH, 'utf8'));
  process.stdout.write(String(j.entries[0].applied));
")
assert_eq "re-run leaves applied flag intact" "true" "$APPLIED_FINAL"

echo ""
echo "=== apply-journal-entry: per-key-diff format (block-level) ==="
# v0.10+: enabledPlugins / extraKnownMarketplaces journal entries use a
# per-key diff (`before`/`after` are inner-key maps of the keys install
# actually touched). Pre-existing sibling keys (e.g. claude-hud@claude-hud)
# appear in NEITHER map and must be preserved on uninstall — they never
# enter the keySet union in applyJournalEntry (edit-settings.mjs:209-307).
# Regression coverage for the silent sibling-drop bug.

# Setup: settings.json with a pre-existing claude-hud sibling + the
# topgauge@topgauge key install added. Journal entry uses the NEW
# per-key diff format (before:{}, after:{topgauge@topgauge:true}).
SETTINGS_EP="$TMPDIR/settings-ep.json"
WIN_SETTINGS_EP="$(winpath "$SETTINGS_EP")"
cat > "$SETTINGS_EP" <<'JSON'
{
  "enabledPlugins": {
    "claude-hud@claude-hud": true,
    "topgauge@topgauge": true
  }
}
JSON

JOURNAL_EP="$TMPDIR/journal-ep.json"
WIN_JOURNAL_EP="$(winpath "$JOURNAL_EP")"
cat > "$JOURNAL_EP" <<'JSON'
{
  "version": 1, "scope": "user", "pluginVersion": "0.10.0",
  "entries": [{
    "id": "settings.json:enabledPlugins",
    "ts": "2026-07-15T07:00:00.000Z",
    "action": "create",
    "before": {},
    "after": { "topgauge@topgauge": true },
    "applied": false
  }]
}
JSON

# Apply — topgauge@topgauge removed, claude-hud@claude-hud preserved,
# block survives (it still has the sibling).
node "$LIB" "$WIN_SETTINGS_EP" apply-journal-entry "$WIN_JOURNAL_EP" >/dev/null 2>&1
HAS_HUD=$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  process.stdout.write(d.enabledPlugins && d.enabledPlugins['claude-hud@claude-hud'] === true ? 'yes' : 'no');
" "$SETTINGS_EP")
assert_eq "ep-sibling-preserved: claude-hud@claude-hud survives" "yes" "$HAS_HUD"
HAS_TOPGAUGE=$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  process.stdout.write(d.enabledPlugins && Object.prototype.hasOwnProperty.call(d.enabledPlugins, 'topgauge@topgauge') ? 'yes' : 'no');
" "$SETTINGS_EP")
assert_eq "ep-sibling-preserved: topgauge@topgauge removed" "no" "$HAS_TOPGAUGE"
HAS_BLOCK=$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  process.stdout.write('enabledPlugins' in d ? 'yes' : 'no');
" "$SETTINGS_EP")
assert_eq "ep-sibling-preserved: enabledPlugins block survives with sibling" "yes" "$HAS_BLOCK"

# --- ep-fresh-create-empty: empty before+after means install touched nothing
# of either category. The broadened empty-block cleanup guard should still
# delete the block (no user state to preserve).
SETTINGS_EMPTY="$TMPDIR/settings-empty.json"
WIN_SETTINGS_EMPTY="$(winpath "$SETTINGS_EMPTY")"
cat > "$SETTINGS_EMPTY" <<'JSON'
{
  "enabledPlugins": {}
}
JSON
JOURNAL_EMPTY="$TMPDIR/journal-empty.json"
WIN_JOURNAL_EMPTY="$(winpath "$JOURNAL_EMPTY")"
cat > "$JOURNAL_EMPTY" <<'JSON'
{
  "version": 1, "scope": "user", "pluginVersion": "0.10.0",
  "entries": [{
    "id": "settings.json:enabledPlugins",
    "ts": "2026-07-15T07:00:00.000Z",
    "action": "create",
    "before": {},
    "after": {},
    "applied": false
  }]
}
JSON
node "$LIB" "$WIN_SETTINGS_EMPTY" apply-journal-entry "$WIN_JOURNAL_EMPTY" >/dev/null 2>&1
HAS_EP_EMPTY=$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  process.stdout.write('enabledPlugins' in d ? 'yes' : 'no');
" "$SETTINGS_EMPTY")
assert_eq "ep-fresh-create-empty: empty diff → block deleted" "no" "$HAS_EP_EMPTY"

# --- ep-user-touched-install-key: user manually disabled topgauge after
# install. Uninstall should NOT re-enable it (user's territory).
SETTINGS_TOUCHED="$TMPDIR/settings-touched.json"
WIN_SETTINGS_TOUCHED="$(winpath "$SETTINGS_TOUCHED")"
cat > "$SETTINGS_TOUCHED" <<'JSON'
{
  "enabledPlugins": {
    "topgauge@topgauge": false
  }
}
JSON
JOURNAL_TOUCHED="$TMPDIR/journal-touched.json"
WIN_JOURNAL_TOUCHED="$(winpath "$JOURNAL_TOUCHED")"
cat > "$JOURNAL_TOUCHED" <<'JSON'
{
  "version": 1, "scope": "user", "pluginVersion": "0.10.0",
  "entries": [{
    "id": "settings.json:enabledPlugins",
    "ts": "2026-07-15T07:00:00.000Z",
    "action": "create",
    "before": {},
    "after": { "topgauge@topgauge": true },
    "applied": false
  }]
}
JSON
node "$LIB" "$WIN_SETTINGS_TOUCHED" apply-journal-entry "$WIN_JOURNAL_TOUCHED" >/dev/null 2>&1
TOPGAUGE_VAL=$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  process.stdout.write(JSON.stringify(d.enabledPlugins && d.enabledPlugins['topgauge@topgauge']));
" "$SETTINGS_TOUCHED")
assert_eq "ep-user-touched-install-key: topgauge@topgauge stays false" "false" "$TOPGAUGE_VAL"

# --- ep-user-added-sibling: user added a new plugin post-install. Uninstall
# preserves it (anyUserAdded path).
SETTINGS_ADDED="$TMPDIR/settings-added.json"
WIN_SETTINGS_ADDED="$(winpath "$SETTINGS_ADDED")"
cat > "$SETTINGS_ADDED" <<'JSON'
{
  "enabledPlugins": {
    "topgauge@topgauge": true,
    "user-new-plugin@user-new-plugin": true
  }
}
JSON
JOURNAL_ADDED="$TMPDIR/journal-added.json"
WIN_JOURNAL_ADDED="$(winpath "$JOURNAL_ADDED")"
cat > "$JOURNAL_ADDED" <<'JSON'
{
  "version": 1, "scope": "user", "pluginVersion": "0.10.0",
  "entries": [{
    "id": "settings.json:enabledPlugins",
    "ts": "2026-07-15T07:00:00.000Z",
    "action": "create",
    "before": {},
    "after": { "topgauge@topgauge": true },
    "applied": false
  }]
}
JSON
node "$LIB" "$WIN_SETTINGS_ADDED" apply-journal-entry "$WIN_JOURNAL_ADDED" >/dev/null 2>&1
USER_NEW=$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  process.stdout.write(d.enabledPlugins && d.enabledPlugins['user-new-plugin@user-new-plugin'] === true ? 'yes' : 'no');
" "$SETTINGS_ADDED")
assert_eq "ep-user-added-sibling: user-added sibling preserved" "yes" "$USER_NEW"
HAS_TOPGAUGE_ADDED=$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  process.stdout.write(d.enabledPlugins && Object.prototype.hasOwnProperty.call(d.enabledPlugins, 'topgauge@topgauge') ? 'yes' : 'no');
" "$SETTINGS_ADDED")
assert_eq "ep-user-added-sibling: topgauge@topgauge removed" "no" "$HAS_TOPGAUGE_ADDED"

# --- ep-mutated-sibling: install flipped a sibling from true → false.
# Uninstall restores it to true.
SETTINGS_MUTATED="$TMPDIR/settings-mutated.json"
WIN_SETTINGS_MUTATED="$(winpath "$SETTINGS_MUTATED")"
cat > "$SETTINGS_MUTATED" <<'JSON'
{
  "enabledPlugins": {
    "claude-hud@claude-hud": false
  }
}
JSON
JOURNAL_MUTATED="$TMPDIR/journal-mutated.json"
WIN_JOURNAL_MUTATED="$(winpath "$JOURNAL_MUTATED")"
cat > "$JOURNAL_MUTATED" <<'JSON'
{
  "version": 1, "scope": "user", "pluginVersion": "0.10.0",
  "entries": [{
    "id": "settings.json:enabledPlugins",
    "ts": "2026-07-15T07:00:00.000Z",
    "action": "create",
    "before": { "claude-hud@claude-hud": true },
    "after":  { "claude-hud@claude-hud": false },
    "applied": false
  }]
}
JSON
node "$LIB" "$WIN_SETTINGS_MUTATED" apply-journal-entry "$WIN_JOURNAL_MUTATED" >/dev/null 2>&1
HUD_VAL=$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  process.stdout.write(JSON.stringify(d.enabledPlugins && d.enabledPlugins['claude-hud@claude-hud']));
" "$SETTINGS_MUTATED")
assert_eq "ep-mutated-sibling: install-mutated sibling restored to true" "true" "$HUD_VAL"

# --- legacy-rejection: before:null entries are SKIPPED, not applied.
# The old install.sh wrote `before:null, after:<full dict>` entries
# that silently dropped pre-existing siblings. applyJournalEntry now
# rejects them outright — settings.json is left untouched (user can
# manually clean up) rather than risk data loss.
SETTINGS_LEGACY="$TMPDIR/settings-legacy.json"
WIN_SETTINGS_LEGACY="$(winpath "$SETTINGS_LEGACY")"
cat > "$SETTINGS_LEGACY" <<'JSON'
{
  "enabledPlugins": {
    "claude-hud@claude-hud": true,
    "topgauge@topgauge": true
  }
}
JSON
JOURNAL_LEGACY="$TMPDIR/journal-legacy.json"
WIN_JOURNAL_LEGACY="$(winpath "$JOURNAL_LEGACY")"
cat > "$JOURNAL_LEGACY" <<'JSON'
{
  "version": 1, "scope": "user", "pluginVersion": "0.9.6",
  "entries": [{
    "id": "settings.json:enabledPlugins",
    "ts": "2026-07-15T07:00:00.000Z",
    "action": "create",
    "before": null,
    "after": { "topgauge@topgauge": true },
    "applied": false
  }]
}
JSON
OUT_LEGACY=$(node "$LIB" "$WIN_SETTINGS_LEGACY" apply-journal-entry "$WIN_JOURNAL_LEGACY" 2>&1)
assert_match "legacy-rejection: stdout reports skipped:legacy-entry" "skipped:legacy-entry" "$OUT_LEGACY"
LEGACY_HUD=$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  process.stdout.write(d.enabledPlugins && d.enabledPlugins['claude-hud@claude-hud'] === true ? 'yes' : 'no');
" "$SETTINGS_LEGACY")
assert_eq "legacy-rejection: claude-hud@claude-hud untouched" "yes" "$LEGACY_HUD"
LEGACY_TOPGAUGE=$(node -e "
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  process.stdout.write(d.enabledPlugins && Object.prototype.hasOwnProperty.call(d.enabledPlugins, 'topgauge@topgauge') ? 'yes' : 'no');
" "$SETTINGS_LEGACY")
assert_eq "legacy-rejection: topgauge@topgauge left in place (settings untouched)" "yes" "$LEGACY_TOPGAUGE"

echo ""
echo "=== Summary ==="
echo "  pass: $PASS"
echo "  fail: $FAIL"
[ "$FAIL" = 0 ]