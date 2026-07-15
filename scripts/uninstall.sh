#!/usr/bin/env bash
# uninstall.sh — full uninstall of topgauge (ToPGauge).
#
# Self-contained: works even if the plugin cache has been partially or
# fully wiped (e.g. after `npm run dev:uninstall`, or any manual
# `rm -rf`). Uses only bash + node (for safe JSON edits) + standard
# Unix tools. No network access. Never reads ANTHROPIC_AUTH_TOKEN.
#
# Behavior:
#   1. Restores settings.json.statusLine to the user's pre-topgauge
#      state. Strategy:
#        a. If statusLine._topgauge_managed === true AND
#           ${CLAUDE_ROOT}/plugins/topgauge/state/upstream-cmd.txt
#           exists, restore from that file (the original install.sh
#           --uninstall behavior, byte-for-byte). This is the STABLE
#           state location (sibling of config.json) as of v0.2.19; it
#           survives cache wipes, so this case covers the common
#           post-upgrade uninstall.
#        a'. (Legacy fallback for v0.2.18 and older) If the stable
#           state dir has no upstream-cmd.txt but any installed cache
#           version dir has one under <version>/state/, prefer the
#           NEWEST available legacy state file. This handles users
#           who installed v0.2.18, never re-ran :install on v0.2.19,
#           and now want to uninstall.
#        b. Else if statusLine._topgauge_managed === true, fall back
#           to the most recent settings.json.bak.<ts> in the same
#           dir whose statusLine does NOT have _topgauge_managed
#           (the state before the plugin was installed).
#        c. Else: statusLine is not ours, leave it alone.
#   2. Removes "topgauge@topgauge" from
#      settings.json.enabledPlugins (if present), preserving CRLF.
#   3. Backs up settings.json to settings.json.bak.<TS> before any
#      destructive change.
#   4. Wipes (v0.9.x — partial-preserve by default; --completely for full):
#        ALWAYS:
#        - cache/topgauge/
#        - marketplaces/topgauge/
#        - marketplaces/cwf818-topgauge/   (alias)
#        - state/{cache.json, cache.stat.json, upstream-cmd.{sh,txt}}
#        - state/install-journal.json      (install.sh's private per-field journal;
#                                           emptied after the apply pass, so it has
#                                           zero value once settings are reverted —
#                                           treated as cache noise, not user-owned)
#        - state/<projectHash>/state.json (per-project tick status)
#        PRESERVED in DEFAULT (no --completely):
#        - state/<projectHash>/<sessionId>.jsonl (token samples)
#        - topgauge/config.json            (user-owned config)
#        - topgauge/query_plugins/         (user plugin overrides)
#        WIPED by --completely (in addition to the always-list above):
#        - state/<projectHash>/<sessionId>.jsonl
#        - topgauge/config.json
#        - topgauge/query_plugins/
#        A post-uninstall hint lists any surviving user-owned paths so
#        the user can decide whether to delete them manually.
#   5. Strips the plugin row from installed_plugins.json and
#      known_marketplaces.json (with timestamped .bak.<TS> backups),
#      preserving CRLF.
#   6. Strips `extraKnownMarketplaces.topgauge` from
#      settings.json (Claude Code records the marketplace source there
#      too — leaving it would re-add the marketplace on next
#      /plugin marketplace add with no visible diff).
#
# Idempotency: every step is independently no-op-able. Re-running on
# a fully clean system prints a "nothing to do" message and exits 0.
#
# v0.9.x — partial-preserve semantics (default) + --completely:
#   - DEFAULT: preserve ~/.claude/plugins/topgauge/{config.json,
#     query_plugins/} and the per-project token-sample .jsonl files.
#     This is what the user gets when they run `/topgauge:uninstall`
#     with no arguments — the most common case. A post-uninstall hint
#     lists the surviving paths so the user can decide whether to
#     delete them manually.
#   - --completely: full uninstall. In addition to the always-wipe
#     list, also nuke config.json, query_plugins/, and the .jsonl
#     history. Use this when the user wants to start from a clean
#     slate (re-install is then equivalent to a fresh install).
#   - ALWAYS wipe: cache/topgauge/, marketplaces/topgauge/,
#     marketplaces/cwf818-topgauge/, state/{cache.json,
#     cache.stat.json, upstream-cmd.{sh,txt}, install-journal.json},
#     state/<projectHash>/state.json.
#
# Usage:
#   uninstall.sh                  # user-level; partial-preserve (default)
#   uninstall.sh --project        # project-level (cwd's .claude/settings.json)
#   uninstall.sh --dry-run        # print actions, change nothing
#   uninstall.sh --completely     # full uninstall: also wipe config,
#                                 #   query_plugins/, and .jsonl history
#   uninstall.sh -h | --help
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

PROJECT_LEVEL=0
DRY_RUN=0
KEEP_STATE=1   # default: preserve user-owned artifacts (config.json,
               # query_plugins/, and per-project .jsonl). --completely
               # flips this to 0 to nuke everything.

print_help() {
  sed -n '2,46p' "$0"
}

for arg in "$@"; do
  case "$arg" in
    --project) PROJECT_LEVEL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --completely) KEEP_STATE=0 ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "uninstall.sh: unknown argument: $arg" >&2
      echo "  usage: uninstall.sh [--project] [--dry-run] [--completely]" >&2
      exit 2
      ;;
  esac
done

CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PLUGINS_DIR="${CLAUDE_ROOT}/plugins"

# Resolve SCRIPT_DIR ONCE, at the top, before any rm -rf. Later in this
# script we wipe CACHE_DIR (the very directory this file lives in) — if
# we re-resolve SCRIPT_DIR after the wipe, the `cd "$(dirname "$0")"`
# fails with "No such file or directory" because the path no longer
# exists. The cached value still lets us locate clean.sh if it's
# somewhere else (rare but possible — e.g. when uninstall.sh is run
# from a copy outside the cache). If the directory is gone, the
# clean.sh invocation is silently skipped (clean is a nice-to-have,
# not a correctness requirement).
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
HELPER=""
if [ -n "$SCRIPT_DIR" ] && [ -f "${SCRIPT_DIR}/lib/edit-settings.mjs" ]; then
  HELPER="${SCRIPT_DIR}/lib/edit-settings.mjs"
fi

# --- Resolve settings target --------------------------------------------------
if [ "$PROJECT_LEVEL" = 1 ]; then
  TARGET=".claude/settings.json"
else
  TARGET="${CLAUDE_ROOT}/settings.json"
fi

# --- Plan: enumerate actions, then run --------------------------------------

TS=$(date +%Y%m%dT%H%M%S)
ACTIONS=()
DRY_NOTHING=1  # becomes 0 if at least one planned action is meaningful

# Action 1: restore statusLine (only if our marker is set)
SL_PLAN=""
# Module-scope STATE_DIR + JOURNAL_PATH — referenced by both the
# SL_PLAN planning block (when MANAGED=1) and the EP/EKM planning
# block (Action 2 below, which runs regardless of MANAGED). State
# lives at the STABLE location (sibling of config.json) so a
# future uninstall can find the journal even after the cache has
# been cleaned.
STATE_DIR="${PLUGINS_DIR}/topgauge/state"
JOURNAL_PATH="${STATE_DIR}/install-journal.json"
# Read the marker in pure bash via node (mirrors the install.sh
# edit-settings.mjs status op, but inlined so we don't depend on
# the cache being present). The marker is not enough: another plugin
# or a human may have overwritten statusLine.command after install.
# Trust the command shape (cache path + wrapper.sh suffix), not just
# the marker. See scripts/lib/edit-settings.mjs#isOurWrapperCommand
# for the matching logic — duplicated here only because we cannot
# easily `require` an mjs from inside a node -e heredoc.
MANAGED="0"
WIN_TARGET=""
if [ -f "$TARGET" ]; then
  if command -v cygpath >/dev/null 2>&1; then
    WIN_TARGET=$(cygpath -w "$TARGET" 2>/dev/null || echo "$TARGET")
  else
    WIN_TARGET="$TARGET"
  fi
  MANAGED=$(node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const isOurs = (cmd) => {
      if (typeof cmd !== "string" || cmd.length === 0) return false;
      const normalized = cmd.replaceAll("\\", "/");
      const hasCachePath = normalized.includes("plugins/cache/topgauge/topgauge/");
      return hasCachePath && /wrapper\.sh"'\''\s*$/.test(cmd);
    };
    try {
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      const sl = d && d.statusLine;
      const m = sl && sl._topgauge_managed === true && isOurs(sl.command);
      process.stdout.write(m ? "1" : "0");
    } catch (e) { process.stdout.write("0"); }
  ' "$WIN_TARGET" 2>/dev/null || echo "0")
fi

# JOURNAL_HAS_ENTRIES — module-scope. Used by both the SL_PLAN branch
# (when MANAGED=1) and the EP/EKM branch (always). The journal is the
# authoritative record of every field-level change install.sh made;
# apply-journal-entry drives per-field revert for statusLine AND for
# the top-level enabledPlugins / extraKnownMarketplaces blocks.
JOURNAL_HAS_ENTRIES="0"
if [ -f "$JOURNAL_PATH" ]; then
  JOURNAL_HAS_ENTRIES="$(node -e '
    try {
      const fs = require("fs");
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const n = (j.entries || []).filter(e => e && e.applied !== true && e.action !== "rotate").length;
      process.stdout.write(n > 0 ? "1" : "0");
    } catch (e) { process.stdout.write("0"); }
  ' "$JOURNAL_PATH" 2>/dev/null || echo "0")"
fi

# APPLY_JOURNAL — set whenever the journal has unapplied entries.
# This is the gate for whether `apply-journal-entry` runs. It is
# independent of MANAGED: even when statusLine is foreign/absent
# (MANAGED=0), the journal can still drive enabledPlugins /
# extraKnownMarketplaces cleanup. Without this OR, tests with only
# an enabledPlugins key (no statusLine) would silently skip the
# apply pass — leaving the block on disk and the user with a stale
# `{}` residue after uninstall.
APPLY_JOURNAL="0"
[ "$JOURNAL_HAS_ENTRIES" = "1" ] && APPLY_JOURNAL="1"

if [ "$MANAGED" = "1" ]; then
  # Priority for restoring settings.json.statusLine:
  #   1. install-journal — drives per-field revert (preserves any
  #      field the user touched after install).
  #   2. legacy restore-from-file — pre-journal installs may have
  #      only upstream-cmd.txt to revert from.
  #   3. legacy restore-from-bak — most recent pre-managed
  #      settings.json.bak.<ts>.
  if [ "$APPLY_JOURNAL" = "1" ]; then
    SL_PLAN="restore-from-journal:${JOURNAL_PATH}"
  else
  # Find the upstream-cmd.txt to restore from. Priority:
  #   1. The stable state dir (v0.2.19+): sibling of config.json,
  #      survives cache wipes.
  #   2. Any installed cache version's state/upstream-cmd.txt
  #      (legacy v0.2.18 and older). Pick the NEWEST version's file
  #      that exists — same ordering the statusLine wrapper uses.
  #   3. Most recent pre-managed settings.json.bak.<ts>.
  UPSTREAM_TXT=""
  if [ -f "${STATE_DIR}/upstream-cmd.txt" ]; then
    UPSTREAM_TXT="${STATE_DIR}/upstream-cmd.txt"
  elif [ -d "$CACHE_DIR" ]; then
    SELF_DIR=$(ls -d "${CACHE_DIR}/"*/ 2>/dev/null \
      | awk -F/ '{ print $(NF-1) "\t" $(0) }' \
      | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n \
      | tail -1 | cut -f2-)
    if [ -n "$SELF_DIR" ] && [ -f "${SELF_DIR%/}/state/upstream-cmd.txt" ]; then
      UPSTREAM_TXT="${SELF_DIR%/}/state/upstream-cmd.txt"
    fi
  fi
  if [ -n "$UPSTREAM_TXT" ]; then
    SL_PLAN="restore-from-file:${UPSTREAM_TXT}"
  else
    # Fall back: most recent .bak.<ts> whose statusLine is NOT managed
    BAK=""
    for f in $(ls -t "${TARGET}.bak."* 2>/dev/null); do
      if [ -z "$f" ]; then continue; fi
      BWIN=""
      if command -v cygpath >/dev/null 2>&1; then
        BWIN=$(cygpath -w "$f" 2>/dev/null || echo "$f")
      else
        BWIN="$f"
      fi
      M=$(node -e '
        const fs = require("fs");
        try {
          const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          const sl = d && d.statusLine;
          process.stdout.write(sl && sl._topgauge_managed === true ? "1" : "0");
        } catch (e) { process.stdout.write("0"); }
      ' "$BWIN" 2>/dev/null || echo "0")
      if [ "$M" = "0" ]; then
        BAK="$f"
        break
      fi
    done
    if [ -n "$BAK" ]; then
      SL_PLAN="restore-from-bak:${BAK}"
    else
      SL_PLAN="warning:no-restore-source"
    fi
  fi
  fi  # close the legacy fallback else
fi
if [ -n "$SL_PLAN" ]; then
  ACTIONS+=("statusLine: ${SL_PLAN}")
  DRY_NOTHING=0
fi

# Action 2: enabledPlugins + extraKnownMarketplaces are reverted via
# the install-journal. install.sh writes two top-level block entries
# (`settings.json:enabledPlugins`, `settings.json:extraKnownMarketplaces`)
# with `action=create, before=null` so apply-journal-entry removes the
# Claude-Loader-added keys while preserving any user customisations.
# The apply pass below (`apply-journal-entry`) processes them in the
# same loop as the statusLine entry — no separate apply step needed.
# APPLY_JOURNAL was computed module-scoped above so it covers this
# block even when MANAGED=0 (statusLine absent — only EP/EKM left to
# revert).
if [ "$APPLY_JOURNAL" = "1" ]; then
  HAS_EP_ENTRY=$(node -e '
    try {
      const fs = require("fs");
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const hit = (j.entries || []).some(e => e && e.id === "settings.json:enabledPlugins" && e.applied !== true);
      process.stdout.write(hit ? "1" : "0");
    } catch (e) { process.stdout.write("0"); }
  ' "${JOURNAL_PATH}" 2>/dev/null || echo "0")
  HAS_EKM_ENTRY=$(node -e '
    try {
      const fs = require("fs");
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const hit = (j.entries || []).some(e => e && e.id === "settings.json:extraKnownMarketplaces" && e.applied !== true);
      process.stdout.write(hit ? "1" : "0");
    } catch (e) { process.stdout.write("0"); }
  ' "${JOURNAL_PATH}" 2>/dev/null || echo "0")
  if [ "$HAS_EP_ENTRY" = "1" ]; then
    ACTIONS+=("enabledPlugins: applied via install-journal (per-field revert)")
    DRY_NOTHING=0
  fi
  if [ "$HAS_EKM_ENTRY" = "1" ]; then
    ACTIONS+=("extraKnownMarketplaces: applied via install-journal (per-field revert)")
    DRY_NOTHING=0
  fi
fi

# Action 3: wipe dirs.
#
# v0.9.x partial-preserve semantics:
#   - topgauge/{config.json, query_plugins/}  → ALWAYS preserved
#     (user-owned; the script can wipe them only on explicit request,
#     and even then we prefer to surface them as a hint rather than
#     silently nuke).
#   - topgauge/state/  → NEVER rm -rf'd. We DO wipe its CONTENTS
#     selectively below (top-level cache noise + per-project state.json;
#     .jsonl only if --completely is passed).
WIPE_DIRS=(
  "${PLUGINS_DIR}/cache/topgauge"
  "${PLUGINS_DIR}/marketplaces/topgauge"
  "${PLUGINS_DIR}/marketplaces/cwf818-topgauge"
)
for d in "${WIPE_DIRS[@]}"; do
  if [ -d "$d" ]; then
    ACTIONS+=("rm -rf ${d}")
    DRY_NOTHING=0
  fi
done

# Action 3b: state/ selective wipe.
#
# Splits state/ into "always wipe" + "wipe unless --completely".
# Top-level state/{cache.json, cache.stat.json, upstream-cmd.sh,
# upstream-cmd.txt} are cache noise that would confuse a re-install
# (stale upstream-cmd.txt points at a now-foreign command), so they
# go. install-journal.json is install.sh's private per-field revert
# log — once the apply-journal-entry pass above consumed every
# `applied: false` entry, the file holds nothing meaningful and would
# silently leak the user's settings.json history past uninstall.
# Treat it as cache noise (always wipe). Per-project
# state/<projectHash>/state.json is the tickStatus cache — same logic,
# always wiped. The .jsonl files ARE the token-sample history;
# preserved by default, wiped under --completely.
if [ -d "$STATE_DIR" ]; then
  ALWAYS_STATE_FILES=(
    "${STATE_DIR}/cache.json"
    "${STATE_DIR}/cache.stat.json"
    "${STATE_DIR}/upstream-cmd.sh"
    "${STATE_DIR}/upstream-cmd.txt"
    "${STATE_DIR}/install-journal.json"
  )
  for f in "${ALWAYS_STATE_FILES[@]}"; do
    if [ -f "$f" ]; then ACTIONS+=("rm -f ${f}"); DRY_NOTHING=0; fi
  done
  # Per-project state.json (always) + .jsonl (only under --completely)
  for proj_dir in "${STATE_DIR}"/*/; do
    [ -d "$proj_dir" ] || continue
    if [ -f "${proj_dir}state.json" ]; then
      ACTIONS+=("rm -f ${proj_dir}state.json")
      DRY_NOTHING=0
    fi
    if [ "$KEEP_STATE" != 1 ]; then
      for jsonl in "${proj_dir}"*.jsonl; do
        [ -f "$jsonl" ] || continue
        ACTIONS+=("rm -f ${jsonl}")
        DRY_NOTHING=0
      done
    fi
  done
fi

# Action 3c: --completely wipes user-owned artifacts (config.json +
# query_plugins/). Default branch leaves them on disk; the post-
# uninstall hint lists their paths so the user can decide.
if [ "$KEEP_STATE" != 1 ]; then
  if [ -f "${PLUGINS_DIR}/topgauge/config.json" ]; then
    ACTIONS+=("rm -f ${PLUGINS_DIR}/topgauge/config.json")
    DRY_NOTHING=0
  fi
  if [ -d "${PLUGINS_DIR}/topgauge/query_plugins" ]; then
    ACTIONS+=("rm -rf ${PLUGINS_DIR}/topgauge/query_plugins")
    DRY_NOTHING=0
  fi
  # --completely: once every file under topgauge/ is wiped, the
  # parent dir is empty and can be rmdir'd. List the candidate here
  # so the dry-run output is honest about the cleanup. The actual
  # rmdir is best-effort in the apply phase: if the user (or a
  # migration leftover like __legacy__/) put something untracked
  # in there, rmdir fails with ENOTEMPTY and the dir stays — no
  # data loss.
  if [ -d "${PLUGINS_DIR}/topgauge" ]; then
    ACTIONS+=("rmdir ${PLUGINS_DIR}/topgauge (if empty after wipes)")
    DRY_NOTHING=0
  fi
fi

# Action 4: strip JSON rows (single key).
INSTALLED_JSON="${PLUGINS_DIR}/installed_plugins.json"
KNOWN_JSON="${PLUGINS_DIR}/known_marketplaces.json"
if [ -f "$INSTALLED_JSON" ]; then
  HAS_ROW=$(node -e '
    const fs = require("fs");
    try {
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const k = process.argv[2];
      process.stdout.write(d.plugins && Object.prototype.hasOwnProperty.call(d.plugins, k) ? "1" : "0");
    } catch (e) { process.stdout.write("0"); }
  ' "$(cygpath -w "$INSTALLED_JSON" 2>/dev/null || echo "$INSTALLED_JSON")" "topgauge@topgauge" 2>/dev/null || echo "0")
  if [ "$HAS_ROW" = "1" ]; then
    ACTIONS+=("strip row(s) from ${INSTALLED_JSON}")
    DRY_NOTHING=0
  fi
fi
if [ -f "$KNOWN_JSON" ]; then
  HAS_ROW=$(node -e '
    const fs = require("fs");
    try {
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const k = process.argv[2];
      process.stdout.write(Object.prototype.hasOwnProperty.call(d, k) ? "1" : "0");
    } catch (e) { process.stdout.write("0"); }
  ' "$(cygpath -w "$KNOWN_JSON" 2>/dev/null || echo "$KNOWN_JSON")" "topgauge" 2>/dev/null || echo "0")
  if [ "$HAS_ROW" = "1" ]; then
    ACTIONS+=("strip row(s) from ${KNOWN_JSON}")
    DRY_NOTHING=0
  fi
fi

# --- Print plan --------------------------------------------------------------
if [ "$DRY_NOTHING" = 1 ]; then
  echo "uninstall.sh: nothing to do — topgauge is not installed"
  exit 0
fi

echo "uninstall.sh: plan"
for a in "${ACTIONS[@]}"; do
  echo "  $a"
done

if [ "$DRY_RUN" = 1 ]; then
  echo "uninstall.sh: --dry-run, no changes made"
  exit 0
fi

# --- Backup settings.json before any destructive change ----------------------
# Only back up if a settings-changing action is in the plan. Re-running
# on a clean system should not pile up empty .bak files.
NEEDS_SETTINGS_BACKUP=0
for a in "${ACTIONS[@]}"; do
  case "$a" in
    "statusLine: "*) NEEDS_SETTINGS_BACKUP=1 ;;
    "enabledPlugins: "*) NEEDS_SETTINGS_BACKUP=1 ;;
    "extraKnownMarketplaces: "*) NEEDS_SETTINGS_BACKUP=1 ;;
  esac
done
if [ "$NEEDS_SETTINGS_BACKUP" = 1 ] && [ -f "$TARGET" ]; then
  cp "$TARGET" "${TARGET}.bak.${TS}"
  echo "uninstall.sh: backup ${TARGET} -> ${TARGET}.bak.${TS}"
fi

# --- Apply: statusLine restore -----------------------------------------------
if [ -n "$SL_PLAN" ]; then
  case "$SL_PLAN" in
    restore-from-file:*)
      SRC="${SL_PLAN#restore-from-file:}"
      # Inline the restore-from-file op (mirrors edit-settings.mjs).
      # Hardened: only restore if the CURRENT command is actually ours.
      # If marker is set but command is foreign (another plugin / human
      # overwrote it), we still want to wipe the cache dirs, but the
      # statusLine is the user's now — don't touch it.
      node -e '
        const fs = require("fs");
        const target = process.argv[1];
        const src = process.argv[2];
        const original = fs.readFileSync(src, "utf8").trim();
        // Same fingerprint as the planning step above. Use a runtime
        // regex (matching `[\/\\]` for the separator) so single-backslash
        // Windows paths match — a String.includes needle built from
        // "[/\\\\]" requires 4 backslashes between segments and silently
        // misses every real Windows path.
        const isOurs = (cmd) => {
          if (typeof cmd !== "string" || cmd.length === 0) return false;
          const normalized = cmd.replaceAll("\\", "/");
          const hasCachePath = normalized.includes("plugins/cache/topgauge/topgauge/");
          return hasCachePath && /wrapper\.sh"'\''\s*$/.test(cmd);
        };
        const data = JSON.parse(fs.readFileSync(target, "utf8"));
        if (data.statusLine && isOurs(data.statusLine.command)) {
          // Mirror write-managed read-modify-write: shallow-copy the
          // CURRENT statusLine (which may carry user-set fields the user
          // added AFTER our install — most notably refreshInterval), then
          // overwrite only the keys we own. The earlier
          // "data.statusLine = {…}" form nuked every other field on
          // uninstall, silently dropping refreshInterval. See commit
          // 89e9e10 (v0.1.23) for the matching install-side fix.
          const next = Object.assign({}, data.statusLine);
          next.type = "command";
          next.command = original;
          delete next._topgauge_managed;
          data.statusLine = next;
        } else if (!data.statusLine) {
          data.statusLine = { type: "command", command: original };
        } else {
          process.stderr.write(
            "uninstall.sh: restore-from-file skipped — current statusLine.command is not the topgauge wrapper\n"
          );
        }
        let eol = "\n";
        const size = fs.statSync(target).size;
        if (size > 0) {
          const fd = fs.openSync(target, "r");
          const head = Buffer.alloc(Math.min(64, size));
          fs.readSync(fd, head, 0, head.length, 0);
          fs.closeSync(fd);
          if (head.includes(0x0d)) eol = "\r\n";
        }
        const body = JSON.stringify(data, null, 2) + "\n";
        fs.writeFileSync(target, body.replace(/\n/g, eol));
      ' "$WIN_TARGET" "$SRC"
      # Best-effort cleanup of the state files (they live in the cache
      # which we wipe below, but doing it here too handles the case
      # where the cache isn't writable for some reason).
      rm -f "${SRC%.txt}.sh" "$SRC" 2>/dev/null || true
      echo "uninstall.sh: restored statusLine from ${SRC}"
      ;;
    restore-from-journal:*)
      # Apply every unapplied entry from ${JOURNAL_PATH} via
      # edit-settings.mjs#apply-journal-entry. Each entry is read-
      # modify-written individually so the user's principle holds:
      # only fields that match the post-install snapshot are reverted;
      # fields the user touched are left as-is.
      SRC="${SL_PLAN#restore-from-journal:}"
      WIN_JOURNAL=""
      if command -v cygpath >/dev/null 2>&1; then
        WIN_JOURNAL=$(cygpath -w "$SRC" 2>/dev/null || echo "$SRC")
      else
        WIN_JOURNAL="$SRC"
      fi
      APPLY_OUT="$(node "$HELPER" "$WIN_TARGET" apply-journal-entry "$WIN_JOURNAL" 2>&1)" || {
        echo "uninstall.sh: apply-journal-entry failed — falling back to legacy behaviour" >&2
        echo "$APPLY_OUT" >&2
        # Fall back: leave a warning but continue with the rest of the
        # uninstall (cache wipe etc.). Restoring the wrapper to its
        # pre-install state via the .bak cascade is no longer safe
        # because the user has potentially been mutating settings.json
        # post-install; the journal is the only authoritative record.
        APPLY_OUT=""
      }
      if [ -n "$APPLY_OUT" ]; then
        echo "uninstall.sh: applied install-journal entries"
        echo "$APPLY_OUT" | sed 's/^/  /'
      fi
      ;;
    restore-from-bak:*)
      BAK="${SL_PLAN#restore-from-bak:}"
      cp "$BAK" "$TARGET"
      echo "uninstall.sh: restored ${TARGET} from ${BAK} (no upstream-cmd.txt available)"
      ;;
    warning:no-restore-source)
      # Last-resort: strip the marker but leave the wrapper as the
      # command. The user will see topgauge still wired up until they
      # manually fix it. Better than blanking statusLine entirely.
      node -e '
        const fs = require("fs");
        const target = process.argv[1];
        const data = JSON.parse(fs.readFileSync(target, "utf8"));
        if (data.statusLine) {
          delete data.statusLine._topgauge_managed;
        }
        let eol = "\n";
        const size = fs.statSync(target).size;
        if (size > 0) {
          const fd = fs.openSync(target, "r");
          const head = Buffer.alloc(Math.min(64, size));
          fs.readSync(fd, head, 0, head.length, 0);
          fs.closeSync(fd);
          if (head.includes(0x0d)) eol = "\r\n";
        }
        const body = JSON.stringify(data, null, 2) + "\n";
        fs.writeFileSync(target, body.replace(/\n/g, eol));
      ' "$WIN_TARGET"
      echo "uninstall.sh: WARNING — no upstream-cmd.txt and no pre-managed .bak found" >&2
      echo "uninstall.sh: stripped _topgauge_managed marker but left the wrapper as statusLine." >&2
      echo "uninstall.sh: manually edit settings.json.statusLine.command to restore your previous statusline." >&2
      ;;
  esac
fi

# enabledPlugins + extraKnownMarketplaces cleanup runs through the
# same apply-journal-entry path. When MANAGED=0 the SL_PLAN branch
# above is skipped, but the EP/EKM entries still need to be applied
# — fire the journal apply here unconditionally when APPLY_JOURNAL=1
# AND SL_PLAN didn't already cover it.
if [ "$APPLY_JOURNAL" = "1" ] && [ -z "$SL_PLAN" ]; then
  WIN_JOURNAL=""
  if command -v cygpath >/dev/null 2>&1; then
    WIN_JOURNAL=$(cygpath -w "$JOURNAL_PATH" 2>/dev/null || echo "$JOURNAL_PATH")
  else
    WIN_JOURNAL="$JOURNAL_PATH"
  fi
  APPLY_OUT="$(node "$HELPER" "$WIN_TARGET" apply-journal-entry "$WIN_JOURNAL" 2>&1)" || {
    echo "uninstall.sh: apply-journal-entry failed for top-level blocks" >&2
    echo "$APPLY_OUT" >&2
    APPLY_OUT=""
  }
  if [ -n "$APPLY_OUT" ]; then
    echo "uninstall.sh: applied install-journal entries (top-level blocks)"
    echo "$APPLY_OUT" | sed 's/^/  /'
  fi
fi

# --- Apply: wipe dirs --------------------------------------------------------
# On Windows, rm -rf can transiently fail with EPERM if an antivirus scanner,
# OneDrive/Dropbox sync client, or another Claude Code session holds a handle
# on the directory tree (this is also the failure mode that hits the loader's
# own `marketplace add` rename). Retry a few times before giving up — the
# handle is almost always released within a second. After rm, verify the
# directory is actually gone and warn loudly if not, so the user knows to
# quit any other Claude session and retry before running /plugin install.
rm_with_retry() {
  local d="$1"
  local i
  for i in 1 2 3; do
    if rm -rf "$d" 2>/dev/null; then
      if [ ! -d "$d" ]; then
        echo "uninstall.sh: removed ${d}"
        return 0
      fi
    fi
    if [ "$i" -lt 3 ]; then sleep 1; fi
  done
  if [ -d "$d" ]; then
    echo "uninstall.sh: WARNING — ${d} still exists after 3 attempts (EPERM?)" >&2
    echo "uninstall.sh: another Claude Code session, antivirus, or a sync client" >&2
    echo "uninstall.sh: is likely holding a handle on it. Quit all Claude Code" >&2
    echo "uninstall.sh: sessions and re-run uninstall.sh before /plugin install." >&2
    return 1
  fi
  echo "uninstall.sh: removed ${d}"
  return 0
}
for d in "${WIPE_DIRS[@]}"; do
  if [ -d "$d" ]; then
    rm_with_retry "$d"
  fi
done

# --- Apply: state/ selective wipes (v0.9.x partial-preserve) -----------------
# Mirrors Action 3b above. We never rm -rf state/ wholesale — query_plugins
# is sibling to state/ under topgauge/, and config.json is also sibling.
# Wholesale rm on state/ could bleed into the wrong directory if the path
# ever changes; selective per-file rm is safe + idempotent.
if [ -d "$STATE_DIR" ]; then
  for f in "${ALWAYS_STATE_FILES[@]}"; do
    if [ -f "$f" ]; then
      if rm -f "$f"; then
        echo "uninstall.sh: removed $f"
      else
        echo "uninstall.sh: WARNING — failed to remove $f" >&2
      fi
    fi
  done
  for proj_dir in "$STATE_DIR"/*/; do
    [ -d "$proj_dir" ] || continue
    # Wipe per-project state.json (always)
    if [ -f "${proj_dir}state.json" ]; then
      if rm -f "${proj_dir}state.json"; then
        echo "uninstall.sh: removed ${proj_dir}state.json"
      else
        echo "uninstall.sh: WARNING — failed to remove ${proj_dir}state.json" >&2
      fi
    fi
    # Wipe token-sample .jsonl only under --completely
    if [ "$KEEP_STATE" != 1 ]; then
      for jsonl in "${proj_dir}"*.jsonl; do
        [ -f "$jsonl" ] || continue
        if rm -f "$jsonl"; then
          echo "uninstall.sh: removed $jsonl"
        else
          echo "uninstall.sh: WARNING — failed to remove $jsonl" >&2
        fi
      done
    fi
  done
fi

# --- Apply: --completely wipes user-owned artifacts (config.json +
# query_plugins/). Default branch skips this entirely. The post-
# uninstall hint (below) lists surviving paths when in default mode.
if [ "$KEEP_STATE" != 1 ]; then
  if [ -f "${PLUGINS_DIR}/topgauge/config.json" ]; then
    if rm -f "${PLUGINS_DIR}/topgauge/config.json"; then
      echo "uninstall.sh: removed ${PLUGINS_DIR}/topgauge/config.json"
    else
      echo "uninstall.sh: WARNING — failed to remove config.json" >&2
    fi
  fi
  if [ -d "${PLUGINS_DIR}/topgauge/query_plugins" ]; then
    if rm -rf "${PLUGINS_DIR}/topgauge/query_plugins"; then
      echo "uninstall.sh: removed ${PLUGINS_DIR}/topgauge/query_plugins"
    else
      echo "uninstall.sh: WARNING — failed to remove query_plugins" >&2
    fi
  fi
  # rmdir the now-empty dir tree, depth-first so the parent's
  # emptiness precondition is met when we get to it. Best-effort:
  # `rmdir` fails with ENOTEMPTY if the user (or a __legacy__/
  # migration leftover) put an untracked file under topgauge/.
  # That's the correct outcome — we don't want to rm -rf a dir
  # we don't fully understand. Suppress stderr because "Directory
  # not empty" is expected, not a warning.
  for proj_dir in "${STATE_DIR}"/*/; do
    [ -d "$proj_dir" ] || continue
    rmdir "$proj_dir" 2>/dev/null || true
  done
  rmdir "${STATE_DIR}" 2>/dev/null || true
  rmdir "${PLUGINS_DIR}/topgauge" 2>/dev/null || true
  if [ ! -d "${PLUGINS_DIR}/topgauge" ]; then
    echo "uninstall.sh: removed empty ${PLUGINS_DIR}/topgauge/ dir"
  fi
fi

# --- Apply: strip JSON rows --------------------------------------------------
#
# Both strip_plugin_row_from_json and strip_plugin_key_from_json
# share an in-place JSON repair path. Claude Code's plugin loader
# has occasionally written strings containing bare backslashes
# (e.g. `installPath: "C:\Users\…"` — Windows path with single
# backslashes), which Node's strict JSON.parse rejects. The repair
# pass walks the file content statefully: inside any string value,
# escape `\X` to `\\X` when X is not one of the valid JSON escape
# characters (`"` `\` `/` `b` `f` `n` `r` `t` `u`). Valid escapes
# (e.g. `\\` `\"` `\n`) are passed through unchanged so the file
# round-trips cleanly through JSON.stringify afterwards. The
# pre-repair text is saved to a sibling `.pre-repair-<ts>.bak` so
# the user can recover if the repair misfires.
json_repair_bodies() {
  cat <<'JS_BODY'
    const fs = require("fs");
    const file = process.argv[1];
    const txt = fs.readFileSync(file, "utf8");
    const VALID_ESC = new Set(["\"", "\\", "/", "b", "f", "n", "r", "t", "u"]);
    function repairJson(s) {
      let out = "";
      let inStr = false;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
          if (ch === "\\") {
            const next = s[i + 1];
            if (next && VALID_ESC.has(next)) {
              out += "\\" + next; i++;
            } else if (next === undefined) {
              out += "\\\\";
            } else {
              out += "\\\\" + next; i++;
            }
          } else if (ch === "\"") {
            out += ch; inStr = false;
          } else {
            out += ch;
          }
        } else {
          if (ch === "\"") { out += ch; inStr = true; }
          else out += ch;
        }
      }
      return out;
    }
    let parsed;
    try {
      parsed = JSON.parse(txt);
    } catch (e) {
      const repaired = repairJson(txt);
      parsed = JSON.parse(repaired);  // throws if repair can't fix it
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      fs.writeFileSync(file + ".pre-repair-" + ts + ".bak", txt);
      fs.writeFileSync(file, repaired);
      process.stderr.write(
        "uninstall.sh: " + file + " was malformed (unescaped backslashes); " +
        "repaired in place (original at " + file + ".pre-repair-" + ts + ".bak)\n"
      );
    }
    let eol = "\n";
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, "r");
      const head = Buffer.alloc(Math.min(64, size));
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      if (head.includes(0x0d)) eol = "\r\n";
    }
    function writeBack(obj) {
      const body = JSON.stringify(obj, null, 2) + "\n";
      fs.writeFileSync(file, body.replace(/\n/g, eol));
    }
    function deleteByPath(obj, path) {
      if (!path.length) return false;
      const head = path[0];
      const tail = path.slice(1);
      if (tail.length === 0) {
        if (obj && Object.prototype.hasOwnProperty.call(obj, head)) {
          delete obj[head];
          return true;
        }
        return false;
      }
      if (obj == null || typeof obj !== "object" || !Object.prototype.hasOwnProperty.call(obj, head)) {
        return false;
      }
      return deleteByPath(obj[head], tail);
    }
JS_BODY
}

strip_plugin_row_from_json() {
  local file="$1"
  local key="$2"
  local win_path=""
  if command -v cygpath >/dev/null 2>&1; then
    win_path=$(cygpath -w "$file" 2>/dev/null || echo "$file")
  else
    win_path="$file"
  fi
  local body
  body="$(json_repair_bodies)"
  node -e "${body}
    deleteByPath(parsed, ['plugins', process.argv[2]]);
    writeBack(parsed);
  " "$win_path" "$key"
}

strip_plugin_key_from_json() {
  local file="$1"
  local key="$2"
  local win_path=""
  if command -v cygpath >/dev/null 2>&1; then
    win_path=$(cygpath -w "$file" 2>/dev/null || echo "$file")
  else
    win_path="$file"
  fi
  local body
  body="$(json_repair_bodies)"
  node -e "${body}
    deleteByPath(parsed, [process.argv[2]]);
    writeBack(parsed);
  " "$win_path" "$key"
}

if [ -f "$INSTALLED_JSON" ]; then
  if grep -q "topgauge@topgauge" "$INSTALLED_JSON" 2>/dev/null; then
    cp "$INSTALLED_JSON" "${INSTALLED_JSON}.bak.${TS}"
    echo "uninstall.sh: backup ${INSTALLED_JSON} -> ${INSTALLED_JSON}.bak.${TS}"
    strip_plugin_row_from_json "$INSTALLED_JSON" "topgauge@topgauge" \
      && echo "uninstall.sh: stripped topgauge@topgauge from ${INSTALLED_JSON}" \
      || echo "uninstall.sh: failed to strip topgauge@topgauge from ${INSTALLED_JSON}" >&2
  fi
fi

if [ -f "$KNOWN_JSON" ]; then
  if grep -q '"topgauge"' "$KNOWN_JSON" 2>/dev/null; then
    cp "$KNOWN_JSON" "${KNOWN_JSON}.bak.${TS}"
    echo "uninstall.sh: backup ${KNOWN_JSON} -> ${KNOWN_JSON}.bak.${TS}"
    strip_plugin_key_from_json "$KNOWN_JSON" "topgauge" \
      && echo "uninstall.sh: stripped topgauge from ${KNOWN_JSON}" \
      || echo "uninstall.sh: failed to strip topgauge from ${KNOWN_JSON}" >&2
  fi
fi

echo ""
echo "uninstall.sh: done. topgauge is fully removed."

# --- Post-uninstall hint (v0.9.x partial-preserve by default) -----------------
# v0.9.x: do NOT silently nuke user-owned artifacts in the default
# branch. Print their surviving paths so the user can decide whether
# to keep them on disk (re-install is faster) or delete them manually.
# Under --completely nothing is preserved, so the hint is suppressed.
#
# NOTE: list presence-not-existence. If the path was never created
# in the first place we still name it — the hint is informational,
# not a "this directory was just left behind" alert. (Finding out
# whether the path existed in this session would require a separate
# `ls` pass; the marginal value isn't worth the per-file fork.)
HINT_LINES=()
if [ "$KEEP_STATE" = 1 ]; then
  if [ -f "${PLUGINS_DIR}/topgauge/config.json" ]; then
    HINT_LINES+=("  ${PLUGINS_DIR}/topgauge/config.json")
  fi
  if [ -d "${PLUGINS_DIR}/topgauge/query_plugins" ]; then
    HINT_LINES+=("  ${PLUGINS_DIR}/topgauge/query_plugins/")
  fi
  for proj_dir in "${STATE_DIR}"/*/; do
    [ -d "$proj_dir" ] || continue
    shopt -s nullglob 2>/dev/null || true
    for jsonl in "${proj_dir}"*.jsonl; do
      [ -f "$jsonl" ] || continue
      HINT_LINES+=("  $jsonl")
    done
  done
fi
if [ "${#HINT_LINES[@]}" -gt 0 ]; then
  echo ""
  echo "uninstall.sh: the following user-owned artifacts were preserved."
  echo "  Delete them manually if you no longer need them, or add --completely"
  echo "  to this command to nuke them as well."
  for line in "${HINT_LINES[@]}"; do
    echo "$line"
  done
elif [ "$KEEP_STATE" != 1 ]; then
  # --completely: every user-owned artifact under topgauge/ is gone.
  # Note it explicitly so the user doesn't go looking for preserved
  # state that isn't there.
  echo ""
  echo "uninstall.sh: --completely — every topgauge/ artifact was wiped (full uninstall)."
fi

# --- Final: trim old backup files (keep only the most recent per file) -------
# This runs scripts/clean.sh so uninstall leaves a tidy filesystem. It is
# always safe — clean is a no-op when at most one backup per file exists.
# SCRIPT_DIR was resolved at the top of the script, before we wiped
# CACHE_DIR, so it still points at a valid location here even though
# this file is now gone. If the directory was gone at top-of-script
# time too (script run from a copy outside the cache), SCRIPT_DIR is
# empty and we just skip the final clean step.
if [ -n "${SCRIPT_DIR:-}" ] && [ -f "${SCRIPT_DIR}/clean.sh" ]; then
  PROJECT_FLAG=""
  [ "$PROJECT_LEVEL" = 1 ] && PROJECT_FLAG="--project"
  bash "${SCRIPT_DIR}/clean.sh" $PROJECT_FLAG || true
fi

echo ""
echo "  Re-install with: /plugin marketplace add cwf818/topgauge"
echo "                   /plugin install topgauge@topgauge"
echo "                   /reload-plugins"
echo "                   /topgauge:install"