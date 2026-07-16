#!/usr/bin/env node
// journal.mjs — read/append/mark-applied for the install-journal.
//
// The install-journal is a write-ahead log of every modification install.sh
// makes to settings.json (or to its own state dir). uninstall.sh reads
// each entry and reverses the change field-by-field, comparing the
// current value against the entry's `after` snapshot — if they match
// (i.e. the user didn't touch the field since install), the change is
// reverted; if they differ (user touched it), the change is left in
// place. This is the user's stated principle: "记录install时发生的操作，
// uninstall时进行恢复;只恢复install的时候修改的项目内容。"
//
// File location: ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/topgauge/state/
//                install-journal.json
// Falls back to lib/edit-settings.mjs's readJson/writeJson semantics for
// line-ending preservation (CRLF on Windows, LF elsewhere).
//
// Schema (v1):
//   {
//     "version": 1,
//     "scope": "user" | "project",
//     "pluginVersion": "0.9.6",
//     "entries": [
//       {
//         "id": "settings.json:statusLine",            // dotted-path id
//         "ts": "2026-07-15T08:31:02.000Z",              // ISO 8601 UTC
//         "action": "create" | "mutate" | "clamp-down",
//         "before": <previous value | null>,
//         "after":  <new value>,
//         "applied": <boolean | undefined>              // set true by uninstall
//       }
//     ]
//   }
//
// Semantics of `before` / `after` for block-level entries
// (settings.json:enabledPlugins, settings.json:extraKnownMarketplaces):
//
//   `before` and `after` are INNER-KEY MAPS restricted to the keys
//   install actually touched. Pre-existing sibling keys (e.g.
//   claude-hud@claude-hud in enabledPlugins) appear in NEITHER map
//   and are therefore invisible to applyJournalEntry's keySet union
//   (edit-settings.mjs:209-307) — they are preserved on uninstall
//   per the user's principle ("只恢复install的时候修改的项目内容").
//   Per-key classification:
//     absent in B, present in A           → install CREATED   → after[k] = A[k]
//     present in B, absent in A           → install REMOVED   → before[k] = B[k]
//     present in B ∩ A, deepEqual(B,A)    → untouched sibling → OMIT
//     present in B ∩ A, differs          → install MUTATED  → before[k] = B[k], after[k] = A[k]
//   `action: "create"` is still used (the top-level block is owned
//   by install).
//
//   `before` and `after` are always non-null objects. applyJournalEntry
//   refuses legacy-style entries (entry.before === null) with
//   `skipped:legacy-entry` — they would silently drop pre-existing
//   sibling keys. If a journal on disk is from a pre-fix install, the
//   legacy entries are marked applied but settings.json is left
//   untouched; the user manually removes any residual topgauge keys.
//
//   An empty `before` AND empty `after` (install touched nothing of
//   either category) means install.sh SKIPPED the entry entirely —
//   no journal row is written for that block.
//
// Caller contract:
//   appendEntries(<journal-file-path>, [...entries])       — write
//   readEntries(<journal-file-path>)                       → entries[]
//   markApplied(<journal-file-path>, id1, id2, ...)        — flip applied
//   rotateIfFull(<journal-file-path>, max=50, keepTail=20) — compact

import {
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  readSync,
  closeSync,
  statSync,
} from "node:fs";

const SCHEMA_VERSION = 1;
const DEFAULT_MAX = 50;
const DEFAULT_KEEP_TAIL = 20;

function nowIsoUtc() {
  // Date.now() inside scripts is NOT allowed — keep timestamp sourcing
  // here so callers can swap to a fake clock in tests by editing this
  // one function.
  return new Date().toISOString();
}

function detectEol(path) {
  // Mirrors edit-settings.mjs#writeJson CRLF detection: read up to 64
  // bytes of head, look for 0x0d.
  let eol = "\n";
  try {
    const size = statSync(path).size;
    if (size === 0) return "\n";
    const head = Buffer.alloc(Math.min(64, size));
    const fd = openSync(path, "r");
    readSync(fd, head, 0, head.length, 0);
    closeSync(fd);
    if (head.includes(0x0d)) eol = "\r\n";
  } catch {
    /* missing file / unreadable → default LF */
  }
  return eol;
}

function atomicWrite(path, body, eol) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, body.replace(/\n/g, eol));
  renameSync(tmp, path);
}

export function normalizeJournal(raw, scope, pluginVersion) {
  // Accept whatever's on disk; coerce to schema v1. Missing fields are
  // filled with safe defaults so a corrupt or older file doesn't crash
  // the caller.
  if (!raw || typeof raw !== "object") {
    return {
      version: SCHEMA_VERSION,
      scope: scope || "user",
      pluginVersion: pluginVersion || "unknown",
      entries: [],
    };
  }
  return {
    version: SCHEMA_VERSION,
    scope: raw.scope || scope || "user",
    pluginVersion: raw.pluginVersion || pluginVersion || "unknown",
    entries: Array.isArray(raw.entries) ? raw.entries : [],
  };
}

export function readEntries(journalPath, opts = {}) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(journalPath, "utf8"));
  } catch {
    // Missing file, corrupt JSON, permission denied — all fail-open.
    // uninstall.sh must never crash the uninstall because the journal
    // is unreadable; legacy fallback takes over.
    return normalizeJournal(null, opts.scope, opts.pluginVersion).entries;
  }
  return normalizeJournal(
    raw,
    opts.scope,
    opts.pluginVersion,
  ).entries;
}

export function readJournal(journalPath, opts = {}) {
  // Strict read for callers who want to inspect the whole journal (used
  // by tests). Like readEntries but returns the full object.
  let raw;
  try {
    raw = JSON.parse(readFileSync(journalPath, "utf8"));
  } catch {
    return normalizeJournal(null, opts.scope, opts.pluginVersion);
  }
  return normalizeJournal(raw, opts.scope, opts.pluginVersion);
}

export function appendEntries(journalPath, entries, opts = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  const existing = readJournal(journalPath, opts);
  const stamped = entries.map((e) => ({
    id: e.id,
    ts: e.ts || nowIsoUtc(),
    action: e.action,
    before: "before" in e ? e.before : null,
    after: "after" in e ? e.after : null,
    applied: e.applied === true,
  }));
  const merged = {
    ...existing,
    entries: [...existing.entries, ...stamped],
  };

  // Apply rotation BEFORE writing — small entries arrays never trigger.
  rotateInPlace(merged, opts.max ?? DEFAULT_MAX, opts.keepTail ?? DEFAULT_KEEP_TAIL);

  const eol = detectEol(journalPath);
  atomicWrite(journalPath, JSON.stringify(merged, null, 2) + "\n", eol);
  return stamped.length;
}

export function markApplied(journalPath, ids, opts = {}) {
  const idSet = new Set(Array.isArray(ids) ? ids : [ids]);
  if (idSet.size === 0) return 0;
  const j = readJournal(journalPath, opts);
  let touched = 0;
  for (const entry of j.entries) {
    if (idSet.has(entry.id) && !entry.applied) {
      entry.applied = true;
      touched++;
    }
  }
  if (touched === 0) return 0;
  const eol = detectEol(journalPath);
  atomicWrite(journalPath, JSON.stringify(j, null, 2) + "\n", eol);
  return touched;
}

function rotateInPlace(journal, max, keepTail) {
  // Compact old entries when total length exceeds `max`. The first
  // `entries.length - keepTail` are folded into a single sentinel
  // `{action:"rotate", keptCount}` entry so the journal stays bounded
  // without losing forensic info — the sentinel tells uninstall exactly
  // which entries were the "old" install-session's worth.
  const n = journal.entries.length;
  if (n <= max) return;
  const foldCount = n - keepTail;
  const foldEntries = journal.entries.slice(0, foldCount);
  const tailEntries = journal.entries.slice(foldCount);
  const sentinel = {
    id: "_rotate",
    ts: nowIsoUtc(),
    action: "rotate",
    before: null,
    after: { keptCount: foldEntries.length },
    applied: false,
  };
  journal.entries = [sentinel, ...tailEntries];
}

// CLI entry: invoked directly from bash. Examples:
//   node scripts/lib/journal.mjs read   <path>
//   node scripts/lib/journal.mjs append <path> <entry-json>
//   node scripts/lib/journal.mjs mark   <path> <id> [<id> ...]
//
// Guard: only run when invoked as the main module AND argv[2] is one of
// our known subcommands. This lets other .mjs files `import` from this
// module without triggering the CLI handler — the dynamic-import path
// inside edit-settings.mjs#ensure-refresh-interval passes journal.mjs
// as the wrapper for itself, and we must not interpret the journal's
// real filesystem path as a CLI subcommand.
const CLI_CMDS = new Set(["read", "append", "mark"]);
const [, , maybeCmd, ...cliArgs] = process.argv;
if (process.argv[1] && process.argv[1].endsWith("journal.mjs") && CLI_CMDS.has(maybeCmd)) {
  let rc = 0;
  try {
    switch (maybeCmd) {
      case "read": {
        const [path] = cliArgs;
        const j = readJournal(path);
        process.stdout.write(JSON.stringify(j, null, 2) + "\n");
        break;
      }
      case "append": {
        const [path, ...entryJsons] = cliArgs;
        const entries = entryJsons.map((s) => JSON.parse(s));
        const n = appendEntries(path, entries);
        process.stdout.write(`appended ${n}\n`);
        break;
      }
      case "mark": {
        const [path, ...ids] = cliArgs;
        const n = markApplied(path, ids);
        process.stdout.write(`marked ${n}\n`);
        break;
      }
    }
  } catch (e) {
    console.error(`journal.mjs: ${e.message}`);
    rc = 1;
  }
  process.exit(rc);
}
