#!/usr/bin/env node
// edit-settings.mjs — small helper for scripts/install.sh to read & write
// Claude Code settings.json without shell-quoting headaches.
//
// Usage:
//   node scripts/lib/edit-settings.mjs <target> <op> [...args]
//
// Operations:
//   status <target>
//       Prints one of: "managed" | "foreign:<command>" | "none"
//   write-managed <target> <wrapper> <upstream-cmd-file>
//       Rewrites statusLine to our managed wrapper. If upstream-cmd-file is
//       empty, leaves CREDITGAUGE_UPSTREAM_CMD unset.
//   restore-from-file <target> <upstream-cmd-file>
//       Replaces our managed statusLine with the contents of upstream-cmd-file
//       (the originally-preserved command).
//
// Targets must be absolute, native-OS paths (use `cygpath -w` on Git Bash).
// JSON output is 2-space indented; original line ending is preserved.

import {
  readFileSync,
  writeFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";

const [, , target, op, ...rest] = process.argv;

if (!target || !op) {
  console.error("edit-settings.mjs: missing target or op");
  process.exit(2);
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  const text = JSON.stringify(obj, null, 2) + "\n";
  // Preserve the original line ending: detect CRLF vs LF from a sample byte.
  let eol = "\n";
  try {
    const size = statSync(p).size;
    const head = Buffer.alloc(Math.min(64, size));
    const fd = openSync(p, "r");
    readSync(fd, head, 0, head.length, 0);
    closeSync(fd);
    if (head.includes(0x0d)) eol = "\r\n";
  } catch {
    /* target may be new; default to LF */
  }
  const body = text.replace(/\n/g, eol);
  writeFileSync(p, body);
}

// Build the bash -c command that install.sh writes into statusLine.command.
//
// Hardcoding the version-specific cache path (e.g. 0.2.5/scripts/wrapper.sh)
// in settings.json breaks the moment the cache rolls forward to a new
// version — settings still points at the old version's directory and the
// wrapper is missing. This helper produces a command that, at invocation
// time, resolves the highest-version directory under the plugin cache
// and execs scripts/wrapper.sh from there. Same pattern claude-hud uses
// for its own statusline.
//
// On bare systems where the cache hasn't been populated yet (e.g. the
// user ran :install before /plugin install ever finished copying files),
// the `ls … 2>/dev/null` returns empty, the chain yields plugin_dir="",
// the `[ -d "" ]` check fails, and we exit 1 with a stderr line —
// fail-fast rather than silently rendering nothing.
function buildLatestCacheCommand(_upstreamCmdFileUnused) {
  // Single-quoted bash -c body. We need literal single quotes inside
  // (for awk's '{ … }'), so we splice the standard '"'"' escape:
  //   close the outer '...',
  //   emit a literal ' via the 4-char sequence  '"'"'  ,
  //   reopen '...' for the rest.
  // The resulting command, when written into settings.json, will be one
  // line — bash sees it as a single argument to bash -c.
  //
  // Pattern, broken across lines for readability (NOT what's written):
  //   bash -c '
  //     plugin_dir=$(ls -d …/creditgauge/*/ | awk -F/ '\''{…}'\'' | sort … | tail -1 | cut -f2-)
  //     [ -d "$plugin_dir" ] || { echo … >&2; exit 1; }
  //     export CREDITGAUGE_UPSTREAM_CMD="<root>/plugins/creditgauge/state/upstream-cmd.sh"
  //     exec bash "${plugin_dir}scripts/wrapper.sh"
  //   '
  //
  // CREDITGAUGE_UPSTREAM_CMD points at a STABLE location
  // (<root>/plugins/creditgauge/state/upstream-cmd.sh) — NOT
  // inside the version-specific cache dir. Two reasons:
  //   1. config.json lives at <root>/plugins/creditgauge/, so
  //      the state dir is the obvious sibling and survives cache wipes
  //      (so an uninstall on a future version can still find the
  //      pre-managed command to restore).
  //   2. /plugin install rolls the cache forward (0.2.5 → 0.2.6);
  //      keeping state in a per-version dir means each new version
  //      starts with no upstream-cmd.sh and the loader has to copy it
  //      across. A fixed location eliminates that dance.
  //
  // plugin_dir is still needed to resolve the wrapper, because the
  // wrapper itself is per-version (it ships inside the cache dir).
  // The upstreamCmdFile arg is kept for API stability with the caller
  // (install.sh forwards both wrapper + upstream); it's intentionally
  // unused here.
  void _upstreamCmdFileUnused;
  return [
    "bash -c '",
    "plugin_dir=$(ls -d \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}\"/plugins/cache/creditgauge/creditgauge/*/ 2>/dev/null | awk -F/ '\"'\"'{ print $(NF-1) \"\\t\" $(0) }'\"'\"' | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1 | cut -f2-); ",
    "[ -d \"$plugin_dir\" ] || { echo \"creditgauge: no installed version found under cache\" >&2; exit 1; }; ",
    "export CREDITGAUGE_UPSTREAM_CMD=\"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/creditgauge/state/upstream-cmd.sh\"; ",
    "exec bash \"${plugin_dir}scripts/wrapper.sh\"",
    "'",
  ].join("");
}

// Apply a single install-journal entry to settings.json. Action semantics:
//   - create: install added a field that didn't exist before.
//       current == after → delete the field (or its parent block when it
//                            was the whole `statusLine` block)
//       current != after → preserve (user touched it after install)
//   - mutate: install replaced an existing field's value.
//       current == after → restore before (full revert)
//       current != after → preserve
//   - clamp-down: install shrunk a value (e.g. refreshInterval 30 → 10).
//       current == after  → restore before
//       current == before → already reverted, no-op
//       otherwise          → preserve (user changed to something new)
//
// Per-field revert — the user's stated principle ("如果已经与install之后
// 不同，说明用户或其他程序已修改，那么对比statusLine块里面的参数，删除
// 与install之后备份的版本相同的，留下那些被修改的"). The id is a
// dotted-path like `settings.json:statusLine.refreshInterval`; the
// leading "settings.json:" prefix is informational and ignored.
//
// For whole-block entries (id="settings.json:statusLine"), we read the
// current block and compare each key against after[]. Keys that match
// after are reset to before (or removed when before=null); keys that
// differ are left in place. This implements "整块 revert" — only the
// exact post-install snapshot is considered "ours".
function applyJournalEntry(data, entry) {
  const rawId = entry.id || "";
  const at = rawId.indexOf(":");
  const path = at >= 0 ? rawId.slice(at + 1).split(".") : rawId.split(".");
  if (path.length === 0 || path[0] === "") {
    return { action: "skipped:bad-id", changed: false };
  }

  // Resolve the current value at `path`. Mutation is rejected if any
  // intermediate node is missing OR not an object — this means we
  // can't descend into a value that the user has already deleted.
  let cur = data;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (cur == null || typeof cur !== "object" || !(k in cur)) {
      // Intermediate node missing → user deleted this branch already.
      return { action: "skipped:missing-parent", changed: false };
    }
    cur = cur[k];
  }
  const leafKey = path[path.length - 1];
  const hasKey = cur != null && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, leafKey);

  function deepEq(a, b) {
    // Strict equality on JSON-shaped values. Looser than a full deepEq,
    // but fits our use case: journal entries are produced by edit-
    // settings.mjs itself so shape parity is guaranteed. Falls back to
    // JSON.stringify for nested objects/arrays.
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return false;
    if (typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
    return false;
  }

  // Block-level entry. Fires for any path whose `after` snapshot is a
  // non-null, non-array object AND action is create/mutate. Covers:
  //   - settings.json:statusLine              (replace-mode install)
  //   - settings.json:enabledPlugins          (top-level plugin-enable dict)
  //   - settings.json:extraKnownMarketplaces  (top-level marketplace-source dict)
  //
  // Per-field classification (universal rule across all three blocks):
  //
  //   for each key k seen in any of {current, before, after}:
  //     inBefore && inAfter:
  //       current[k] === after[k]  → user didn't touch, REVERT to before[k]
  //       current[k] !== after[k]  → user touched, PRESERVE current[k]
  //     inBefore && !inAfter:
  //       install didn't write this key → user's territory → preserve as-is
  //     !inBefore && inAfter:
  //       install CREATED this key (was absent pre-install).
  //       current[k] === after[k]  → user didn't touch, DELETE
  //       current[k] !== after[k]  → user touched, PRESERVE current[k]
  //       k ∉ current              → user deleted post-install, no-op
  //     !inBefore && !inAfter:
  //       k ∈ current → user added post-install, PRESERVE
  //
  // Final disposition:
  //   create (before=null) + no user-touched fields + no user-added
  //     fields + every after-key deleted → delete cur[leafKey] entirely
  //     (the "fresh install → uninstall → block gone" path).
  //   mutate + no user-touched + no user-added → restore whole block
  //     to entry.before (every install-touched field reverted, no user
  //     modifications). If entry.before is empty, delete the leaf.
  //   otherwise (user touched/added anything) → write partial-revert
  //     `next` back to cur[leafKey].
  if (
    typeof entry.after === "object" &&
    entry.after !== null &&
    !Array.isArray(entry.after) &&
    hasKey &&
    (entry.action === "create" || entry.action === "mutate")
  ) {
    const current = cur[leafKey];
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return { action: "skipped:current-not-object", changed: false };
    }
    const isCreate = entry.action === "create";
    // Format expectations differ by entry id:
    //   settings.json:statusLine — single block; install writes the
    //     whole statusLine dict as `after`. `before === null` is a
    //     legitimate fresh-create signal (no prior statusLine). No
    //     sibling keys exist outside the block, so the legacy
    //     full-dict snapshot semantics don't cause data loss here.
    //   settings.json:enabledPlugins / settings.json:extraKnownMarketplaces
    //     — dicts of sibling entries (one per plugin / marketplace).
    //     A legacy `before === null` full-dict snapshot would silently
    //     drop pre-existing siblings, so those entries are REJECTED
    //     here; the new install.sh always writes them as per-key diffs
    //     (`before: {}` or a non-empty inner-key map).
    const isPluginDictEntry =
      rawId.endsWith(":enabledPlugins") ||
      rawId.endsWith(":extraKnownMarketplaces");
    if (isPluginDictEntry) {
      if (entry.before === null) {
        return { action: "skipped:legacy-entry", changed: false };
      }
      if (typeof entry.before !== "object" || Array.isArray(entry.before)) {
        return { action: "skipped:malformed-before", changed: false };
      }
    }
    const beforeObj = (entry.before && typeof entry.before === "object" && !Array.isArray(entry.before))
      ? entry.before
      : null;

    // Union of all keys touched by anyone (install, user-pre, user-post).
    const keySet = new Set();
    for (const k of Object.keys(current)) keySet.add(k);
    for (const k of Object.keys(entry.after)) keySet.add(k);
    if (beforeObj) for (const k of Object.keys(beforeObj)) keySet.add(k);

    const next = {};
    let anyReverted = false;
    let anyUserTouched = false;
    let anyUserAdded = false;

    for (const k of keySet) {
      const inBefore = beforeObj && Object.prototype.hasOwnProperty.call(beforeObj, k);
      const inAfter = Object.prototype.hasOwnProperty.call(entry.after, k);
      const inCurrent = Object.prototype.hasOwnProperty.call(current, k);

      if (inBefore && inAfter) {
        if (inCurrent && !deepEq(current[k], entry.after[k])) {
          // User touched an install-modified field — preserve.
          next[k] = current[k];
          anyUserTouched = true;
        } else if (inCurrent) {
          // Untouched by user — restore to before.
          next[k] = beforeObj[k];
          anyReverted = true;
        } else {
          // User deleted post-install — preserve absence (don't re-add).
          anyReverted = true;
        }
      } else if (inBefore && !inAfter) {
        // Install didn't touch this field — user's territory.
        if (inCurrent) {
          next[k] = current[k];
          anyUserAdded = true;
        }
        // else: user deleted post-install; preserve absence.
      } else if (!inBefore && inAfter) {
        // Install CREATED this field.
        if (inCurrent && !deepEq(current[k], entry.after[k])) {
          // User touched — preserve.
          next[k] = current[k];
          anyUserTouched = true;
        } else if (inCurrent) {
          // Untouched — delete the install-added field.
          anyReverted = true;
        }
        // else: user deleted post-install; already gone, no-op.
      } else {
        // !inBefore && !inAfter → k only in current → user added post-install.
        next[k] = current[k];
        anyUserAdded = true;
      }
    }

    if (!anyReverted) {
      return { action: "preserved:all-fields-user-touched", changed: false };
    }

    // mutate + no user modifications anywhere → restore whole block to before.
    // Covers the "replace-mode install: user didn't touch anything → restore
    // their foreign command and remove our marker" path that the previous
    // version got wrong.
    if (!isCreate && !anyUserTouched && !anyUserAdded) {
      const restored = beforeObj ? { ...beforeObj } : {};
      if (Object.keys(restored).length === 0) {
        delete cur[leafKey];
        return { action: "reverted:block-deleted", changed: true };
      }
      cur[leafKey] = restored;
      return { action: "reverted:block-restored", changed: true };
    }

    // create + everything install-added is gone + no user modifications
    // → delete the entire leaf. The "fresh install → uninstall → no
    // statusLine" path; leaving an empty object behind would be misleading.
    if (isCreate && !anyUserTouched && !anyUserAdded && Object.keys(next).length === 0) {
      delete cur[leafKey];
      return { action: "reverted:block-deleted", changed: true };
    }

    cur[leafKey] = next;
    return { action: "reverted:block-fields", changed: true };
  }

  // Field-level entry.
  if (!hasKey) {
    // Field doesn't exist on disk → either install wasn't run, or the
    // user has already removed it (including, for create, the whole
    // parent block). Nothing to revert, mark applied.
    return { action: "skipped:absent", changed: false };
  }
  const currentVal = cur[leafKey];
  if (entry.action === "create") {
    if (deepEq(currentVal, entry.after)) {
      delete cur[leafKey];
      return { action: "reverted:create-delete", changed: true };
    }
    return { action: "preserved:user-touched", changed: false };
  }
  if (entry.action === "mutate") {
    if (deepEq(currentVal, entry.after)) {
      cur[leafKey] = entry.before;
      return { action: "reverted:mutate-restore", changed: true };
    }
    return { action: "preserved:user-touched", changed: false };
  }
  if (entry.action === "clamp-down") {
    if (deepEq(currentVal, entry.after)) {
      cur[leafKey] = entry.before;
      return { action: "reverted:clamp-down", changed: true };
    }
    if (deepEq(currentVal, entry.before)) {
      return { action: "no-op:already-reverted", changed: false };
    }
    return { action: "preserved:user-touched", changed: false };
  }
  return { action: "skipped:unknown-action", changed: false };
}


// Fingerprint for the wrapper command install.sh writes. Two-part check:
//   1. The command path lives inside our plugin cache (the only place
//      install.sh points the wrapper at). Match either separator since
//      the actual paths in settings.json come from a Cygwin / native
//      boundary — on Windows install.sh converts via `cygpath -w` and
//      we see backslashes; on Linux/macOS we see forward slashes.
//   2. The command ends with `wrapper.sh"'` — the literal `bash -c '...'`
//      closing single-quote install.sh emits, preceded by the double-quote
//      that wraps the wrapper path inside the bash -c arg.
//
// Why this matters: _creditgauge_managed === true is a marker WE write, but
// a foreign command can be in place when (a) another plugin overwrites
// statusLine after ours, (b) the user hand-edits settings.json, or
// (c) Claude Code re-derives statusLine. The marker survives all of
// those. Trusting the marker alone causes uninstall to clobber the
// foreign command with our cached wrapper — losing the user's intent.
function isOurWrapperCommand(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  const normalized = command.replaceAll("\\", "/");
  const hasCachePath = normalized.includes("plugins/cache/creditgauge/creditgauge/");
  // Suffix: install.sh writes `bash -c '...exec bash "<path>"'`, so the
  // last three characters of the command are literally `sh"'`. The
  // trailing `'` distinguishes our wrapper from a different command
  // that happens to mention our cache path.
  return hasCachePath && /wrapper\.sh"'\s*$/.test(command);
}

switch (op) {
  case "status": {
    const data = readJson(target);
    const sl = data.statusLine;
    if (sl && sl._creditgauge_managed === true && isOurWrapperCommand(sl.command)) {
      // Both the marker AND the wrapper command are ours → safe to treat as
      // managed (uninstall can restore from upstream-cmd.txt; re-install is
      // a no-op).
      process.stdout.write("managed");
    } else if (sl && typeof sl.command === "string") {
      // Either no marker, or marker is set but the command is foreign
      // (another plugin / human overwrote it). Treat as foreign so install.sh
      // preserves the current command and writes a new upstream-cmd.sh.
      process.stdout.write("foreign:" + sl.command);
    } else {
      process.stdout.write("none");
    }
    break;
  }

  case "write-managed": {
    const [wrapper, upstreamCmdFile] = rest;
    const data = readJson(target);
    // The wrapper path coming in is the version-specific path install.sh
    // resolved at install time (e.g. C:\…\0.2.5\scripts\wrapper.sh).
    // That's not what we want in settings.json — hardcoding the version
    // means a subsequent /plugin install that bumps 0.2.5 → 0.2.6 leaves
    // the statusline pointing at a now-orphan path. Mirror claude-hud's
    // "ls + sort + tail" pattern instead: at invocation time the
    // wrapper resolves the highest-version directory under the plugin
    // cache, then execs scripts/wrapper.sh from there. Install-time
    // changes (bump version, copy a new dir into cache) become
    // automatically picked up.
    const prev = (data.statusLine && typeof data.statusLine === "object")
      ? data.statusLine
      : {};
    const next = { ...prev };
    next.type = "command";
    next.command = buildLatestCacheCommand(upstreamCmdFile || "");
    next._creditgauge_managed = true;
    data.statusLine = next;
    writeJson(target, data);
    break;
  }

  case "restore-from-file": {
    const [upstreamCmdOnly] = rest;
    const original = readFileSync(upstreamCmdOnly, "utf8").trim();
    const data = readJson(target);
    // Same guard as `status`: only restore when the current command is
    // actually ours. Otherwise the user (or another plugin) replaced the
    // command after install; touching it would clobber their intent.
    if (data.statusLine && isOurWrapperCommand(data.statusLine.command)) {
      // Mirror write-managed's read-modify-write: shallow-copy the
      // CURRENT statusLine (which may carry user-set fields the user
      // added AFTER our install — most notably refreshInterval), then
      // overwrite only the keys we own. Previously this op nuked every
      // other field by replacing the whole object, silently dropping
      // refreshInterval on every uninstall. See commit 89e9e10
      // (v0.1.23) for the matching install-side fix.
      const next = { ...data.statusLine };
      next.type = "command";
      next.command = original;
      delete next._creditgauge_managed;
      data.statusLine = next;
    } else if (!data.statusLine) {
      data.statusLine = { type: "command", command: original };
    } else {
      // Foreign command under a stale _creditgauge_managed marker — leave
      // it alone. The marker is no longer meaningful; the user owns the
      // current command.
      process.stderr.write(
        "edit-settings.mjs: restore-from-file skipped — current statusLine.command is not the creditgauge wrapper\n"
      );
    }
    writeJson(target, data);
    break;
  }

  case "ensure-refresh-interval": {
    // Read-modify-write `settings.json.statusLine.refreshInterval`.
    //   - missing  → write `maxSeconds` (default 10); record `create`
    //   - > max    → clamp to `maxSeconds`; record `clamp-down`
    //   - ≤ max    → no-op, no journal entry
    //
    // We intentionally don't touch any other field — including
    // `_creditgauge_managed`, which write-managed owns. If statusLine
    // doesn't exist, this op errors out (install is calling us before
    // write-managed; ordering matters).
    //
    // Args: [maxSeconds]
    // Stdout (Bash-readable):
    //   "create|10"          — field was created with the given value
    //   "clamp-down|30|10"   — clamped from 30 down to 10
    //   "no-op|5"            — already ≤ max
    //   "error|<msg>"        — settings.json without statusLine
    // Side effect on success:
    //   - settings.json mutated in place (with CRLF preserved)
    //   - journal entry appended to journalPath when provided
    const [maxSecondsStr, journalPath] = rest;
    const maxSeconds = Number.parseInt(maxSecondsStr, 10);
    if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
      process.stderr.write(`ensure-refresh-interval: invalid max='${maxSecondsStr}'\n`);
      process.exit(2);
    }
    const data = readJson(target);
    if (!data.statusLine || typeof data.statusLine !== "object") {
      process.stderr.write(
        "ensure-refresh-interval: settings.json has no statusLine; run write-managed first\n"
      );
      process.exit(1);
    }
    const beforeRaw = data.statusLine.refreshInterval;
    const before = typeof beforeRaw === "number" ? beforeRaw : null;
    if (before === null) {
      // Field was missing — create it.
      data.statusLine.refreshInterval = maxSeconds;
      writeJson(target, data);
      if (journalPath) {
        const { appendEntries } = await import("./journal.mjs");
        appendEntries(
          journalPath,
          [
            {
              id: "settings.json:statusLine.refreshInterval",
              action: "create",
              before: null,
              after: maxSeconds,
            },
          ],
        );
      }
      process.stdout.write(`create|${maxSeconds}\n`);
      break;
    }
    if (before > maxSeconds) {
      // Clamp down.
      data.statusLine.refreshInterval = maxSeconds;
      writeJson(target, data);
      if (journalPath) {
        const { appendEntries } = await import("./journal.mjs");
        appendEntries(
          journalPath,
          [
            {
              id: "settings.json:statusLine.refreshInterval",
              action: "clamp-down",
              before,
              after: maxSeconds,
            },
          ],
        );
      }
      process.stdout.write(`clamp-down|${before}|${maxSeconds}\n`);
      break;
    }
    // Already ≤ max: no-op.
    process.stdout.write(`no-op|${before}\n`);
    break;
  }

  case "apply-journal-entry": {
    // Args: [journalPath, entryId1, entryId2, ...]
    // Iterates entries; for each, calls applyJournalEntry against the
    // current settings.json. After each successful application, marks
    // the entry as applied via journal.mjs#markApplied so re-runs are
    // idempotent.
    const [journalPath, ...ids] = rest;
    if (!journalPath) {
      process.stderr.write("apply-journal-entry: journalPath required\n");
      process.exit(2);
    }
    const { readEntries, markApplied } = await import("./journal.mjs");
    const all = readEntries(journalPath);
    const idSet = ids.length > 0 ? new Set(ids) : null;
    const targets = idSet
      ? all.filter((e) => idSet.has(e.id))
      : all.filter((e) => !e.applied && e.action !== "rotate");
    const data = readJson(target);
    const applied = [];
    const skipped = [];
    for (const entry of targets) {
      const r = applyJournalEntry(data, entry);
      const summary = `${entry.id}|${r.action}`;
      if (r.changed) applied.push(summary);
      else skipped.push(summary);
    }
    writeJson(target, data);
    if (applied.length > 0) {
      markApplied(journalPath, applied.map((s) => s.split("|")[0]));
    }
    // Empty-block cleanup. Two passes; both observe the post-apply
    // shape of `data[leafKey]` rather than the journal-entry shape.
    //
    // Pass 1 (legacy / EP-EKM): a per-key-diff entry where install
    // touched nothing of either category (before={}, after={}) means
    // the entry was the sentinel install.sh uses for "no keys touched
    // on this top-level dict". If the block on disk is empty we drop
    // it.
    //
    // Pass 2 (post-apply invariant): a sibling field-level entry can
    // delete the last remaining key of a block after the block-level
    // entry ran, leaving `{}`. The classic example is
    // settings.json:statusLine (create, before=null, after=
    // {type, command, _creditgauge_managed}) immediately followed by
    // settings.json:statusLine.refreshInterval (create, before=null,
    // after=10). Pass 1 misses these because Pass 1's bothEmpty gate
    // requires before/after to be `{}`, but `before=null` for
    // statusLine's create entry is a legitimate fresh-create signal —
    // gate fails. Pass 2 doesn't gate on entry shape at all; it just
    // asks "is the block empty now?" and, if so, drops it.
    //
    // Claude Code refuses to load settings.json with an empty
    // statusLine, so the residual `{}` is not just cosmetic — it's
    // a load-failure. Mutate-mode entries with `before: {}` are
    // legitimate user state and must NOT be auto-deleted by Pass 2;
    // we restrict Pass 2 to entries whose leaf block install actually
    // owned (action=create with before=null, OR the leaf was empty
    // pre-apply — captured by `beforeEmptyObj`).
    let emptiedBlocks = 0;
    const seenLeaf = new Set();
    for (const entry of targets) {
      const rawId = entry.id || "";
      const at = rawId.indexOf(":");
      const idTail = at >= 0 ? rawId.slice(at + 1) : rawId;
      const leafKey = idTail.split(".")[0] || idTail;
      if (!leafKey || seenLeaf.has(leafKey)) continue;

      // Read the current shape; the decision hinges on it.
      const v = data && typeof data === "object" ? data[leafKey] : undefined;

      // Pass 1: per-key-diff create + bothEmpty (existing behaviour —
      // covers EP/EKM when neither sibling added a key).
      const beforeIsObj = entry.before && typeof entry.before === "object" && !Array.isArray(entry.before);
      const bothEmpty = beforeIsObj
        && Object.keys(entry.before).length === 0
        && entry.after
        && typeof entry.after === "object"
        && !Array.isArray(entry.after)
        && Object.keys(entry.after).length === 0;
      if (
        entry.action === "create" &&
        bothEmpty &&
        v && typeof v === "object" && !Array.isArray(v) &&
        Object.keys(v).length === 0
      ) {
        delete data[leafKey];
        emptiedBlocks++;
        seenLeaf.add(leafKey);
        continue;
      }

      // Pass 2: post-apply shape check. Only fire when install owned
      // the entire block. "Owned" here means the entry's before is
      // either null (create on absent block, as fresh-install statusLine
      // is) OR an empty object (the block was empty pre-install and
      // install replaced it with a non-empty dict — auto-revert the
      // auto-replace). Mutate-mode entries with `before: {}` look
      // ambiguous: pre-install the block may have been a legitimate
      // user-empty config, so we DON'T auto-delete. We also skip when
      // `before` is a populated object — install only mutated keys
      // the user had; preserving a post-revert `{}` honours the
      // user's intent.
      const beforeIsEmptyObj = beforeIsObj && Object.keys(entry.before).length === 0;
      const installOwnedBlock =
        entry.action === "create" && entry.before === null
        || (entry.action === "create" && beforeIsEmptyObj)
        || (entry.action === "mutate" && beforeIsEmptyObj);
      if (
        installOwnedBlock &&
        v && typeof v === "object" && !Array.isArray(v) &&
        Object.keys(v).length === 0
      ) {
        delete data[leafKey];
        emptiedBlocks++;
        seenLeaf.add(leafKey);
      }
    }
    if (emptiedBlocks > 0) writeJson(target, data);
    if (emptiedBlocks > 0) {
      for (let i = 0; i < emptiedBlocks; i++) {
        process.stdout.write(`cleaned: empty-block-deleted\n`);
      }
    }
    // Stdout: one line per entry decision, parseable from bash.
    for (const s of applied) process.stdout.write(`applied: ${s}\n`);
    for (const s of skipped) process.stdout.write(`skipped: ${s}\n`);
    break;
  }

  default:
    console.error(`edit-settings.mjs: unknown op '${op}'`);
    process.exit(2);
}