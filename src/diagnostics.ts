// v0.4.0+ — diagnostics log.
//
// Persistent JSONL append log for warnings and errors emitted during
// the plugin's lifetime.
//
// Per-Project Layout (v0.4.x+): when a `cwd` is provided to `append` /
// `readLatest` / `diagnosticsPath`, the log lives at
// `${CLAUDE_CONFIG_DIR}/plugins/creditgauge/state/<projectHash>/diagnostics.jsonl`.
// When `cwd` is omitted (or null/empty), the log falls back to the
// legacy top-level
// `${CLAUDE_CONFIG_DIR}/plugins/creditgauge/state/diagnostics.jsonl`.
// The fallback is used for plugin-level errors that have no project
// affiliation (e.g. config-parse warnings from `src/config.ts`).
//
// Each line is a structured record:
//
//   {"at":1782576199672,"level":"warn","source":"config","msg":"…"}
//
// Two consumers:
//   1. m_error / m_warning display modules (src/render.ts) — read the
//      most recent line of each level to render an inline indicator.
//   2. Postmortem — a user who wants to know "why did the plugin break
//      yesterday" can tail the file directly. JSONL is greppable and
//      structured (timestamp + level + source + message).
//
// Size policy: cap at 200 lines, oldest dropped on every append.
//   ~200B per line × 200 = ~40KB. Negligible. Anything older than
//   200 events is uninteresting by definition (we just want a tail).
//   The :clean slash command can wipe the file outright.
//
// Why NOT a separate "head" file (e.g. diagnostics.json with just the
// latest error/warning): every statusline tick is a fresh child
// process, so the in-memory cache of "last error" must be re-read
// from disk. Reading a 40KB JSONL and tailing the last matching line
// is fast (<1ms); a separate head file would shave ~0.5ms at the
// cost of double-write logic. Not worth it.
//
// Opt-in gate: writing the log file is OFF by default. Set
// `CREDITGAUGE_DIAGNOSTICS_ENABLE=1` (or `true` / `yes`, case-insensitive)
// to enable. Rationale: the file lives in the user's plugins dir and
// may contain sensitive fragments (paths, error text from upstream
// libraries), so we don't write unless the user explicitly asks.
// The stderr "append failed" line is independent of this gate —
// silent when the file write succeeds, present when it doesn't,
// regardless of opt-in state.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectHash } from "./status-store.ts";

// ----- Path -----

function stateRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return join(claudeRoot, "plugins", "creditgauge", "state");
}

// Resolve the diagnostics.jsonl path for a given project cwd. When
// `cwd` is a non-empty string, the file lives at
// `state/<projectHash(cwd)>/diagnostics.jsonl` (Per-Project Layout).
// When `cwd` is null/empty/undefined, we fall back to the legacy
// top-level `state/diagnostics.jsonl` so plugin-level errors that
// have no project affiliation (config-parse warnings, etc.) can still
// be logged.
function diagnosticsFilePath(cwd: string | null | undefined): string {
  if (cwd && cwd.length > 0) {
    return join(stateRoot(), projectHash(cwd), "diagnostics.jsonl");
  }
  return join(stateRoot(), "diagnostics.jsonl");
}

export function diagnosticsPath(cwd?: string | null): string {
  return diagnosticsFilePath(cwd);
}

// ----- Types -----

export type Level = "error" | "warning" | "info";

// One JSONL row. Structured so a postmortem reader can grep by level
// or by source without parsing the message.
//
// `at` is the epoch-ms timestamp (cheap to sort/compare); `iso` is the
// same instant rendered as a local-tz ISO8601 string (e.g.
// "2026-07-04T08:56:42.123+08:00") for human reading. Computed at append
// time so a postmortem never has to convert timestamps manually — the
// statusline runs cross-platform and the user's local-tz offset is
// whatever `Intl.DateTimeFormat().resolvedOptions().timeZone` reports
// on the host. v0.8.x+ keeps `at` for backward-compatible sorting and
// adds `iso` for greppability.
//
// `fn` is the calling function in `module.funcName` form (e.g.
// "cache.loadFromDisk", "token-store.appendSample"). Optional — only
// file-IO audit rows set it; warning/error rows (fetch / config /
// stdin) leave it undefined and the JSONL row omits the field.
//
// `cwd` is the project cwd the row belongs to. Optional — only
// rows that route to a project-scoped diagnostics.jsonl set it,
// and only when the path resolver had a non-null cwd to encode.
// Fetch / config / stdin rows whose path falls back to the legacy
// top-level file leave it undefined. A postmortem can grep for
// `"cwd":"D:\\WorkSpace\\foo"` across either the per-project or
// the top-level file to scope the trace to one of several
// concurrent sessions sharing the same state root.
export type Entry = {
  at: number;
  iso: string;
  level: Level;
  source: string;
  fn?: string;
  msg: string;
  cwd?: string;
};

// Cap on file length. Append drops the oldest line(s) when the file
// would exceed this — keeps the file bounded regardless of error
// rate. Tests can lower this via the optional 3rd arg to append.
// v0.8.34 — raised from 200 to 1000 so a sustained failure mode
// (e.g. m_quote|address:<URL> with the endpoint down for several
// minutes) keeps enough tail to postmortem, without paying for an
// unbounded file in the steady state.
export const DEFAULT_MAX_ENTRIES = 1000;

// ----- Process-level session cwd store -----
//
// The statusline runs as a per-tick child process spawned by Claude
// Code. Within a single tick we want every audit row (whether from
// `cache.loadFromDisk` reading the top-level cache.json, from
// `index.loadPluginVersion` reading plugin.json, or from
// `token-store.appendSample` writing the per-project sample jsonl)
// to carry the originating session's cwd on disk so a postmortem
// can disambiguate rows from concurrent panels sharing the same
// state root.
//
// Without a global store, every call site would have to be
// threaded with the cwd — a per-tick value that's only known after
// stdin is parsed, but used across the whole tick. That's
// invasive (cache.ts would have to take a cwd parameter on every
// public API just to forward it to the audit row) and pushes
// session-scoped state into modules whose design is "cwd-unaware
// at the function-signature level".
//
// The compromise: hold the cwd in a module-private variable
// `_sessionCwd` and let `append` (and the `logFs*` helpers it
// fronts) read from it. `setSessionCwd` is called ONCE per tick
// from `index.ts:main()` after stdin has been parsed; from that
// moment on, every audit row picks up the cwd automatically.
//
// Per-tick child processes never share state across invocations,
// so a single `_sessionCwd` is correct without locking.
let _sessionCwd: string | null | undefined = undefined;

export function setSessionCwd(cwd: string | null | undefined): void {
  _sessionCwd = cwd;
}

// Read the current session cwd, normalized to undefined when
// empty/null. Module-private — callers always go through `append`
// or the `logFs*` helpers, which apply this resolution.
function currentSessionCwd(): string | undefined {
  if (typeof _sessionCwd !== "string" || _sessionCwd.length === 0) {
    return undefined;
  }
  return _sessionCwd;
}

// Local-tz ISO8601 string for a given epoch-ms instant. Uses
// sv-SE locale as a stable "YYYY-MM-DD HH:MM:SS.mmm" shape so a
// postmortem reader can sort timestamps lexicographically without
// any timezone conversion. The offset suffix matches whatever the
// host's local-tz offset is at that instant — we don't normalize
// to UTC because the statusline is read by humans who want the
// time in their own clock.
//
// The sv-SE locale is essentially the ISO8601 "extended" format
// (YYYY-MM-DD HH:MM:SS) with a 24-hour clock. We replace the
// date/time separator to produce a lexical-equal-of-ISO output
// like "2026-07-04T08:56:42.123". Without `timeZone: undefined`
// explicit, we accept the host default — passing no `timeZone`
// option to Intl is the documented way to ask for local time.
function localIso(epochMs: number): string {
  // toLocaleString will be called with the host's local tz when
  // `timeZone` is omitted. The `--noEmit` TS pass accepts the
  // Intl option bag without `timeZone` — annotate the cast to
  // silence strict mode without runtime cost.
  const opts: Intl.DateTimeFormatOptions = {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  };
  return new Date(epochMs).toLocaleString("sv-SE", opts)
    .replace(" ", "T")
    // sv-SE uses ',' as the fractional-second separator. ISO8601
    // requires '.' — normalise so Date.parse() round-trips cleanly.
    .replace(/,(\d{3})$/, ".$1");
}

// ----- Gate -----

// True iff CREDITGAUGE_DIAGNOSTICS_ENABLE is set to a truthy value
// (1 / true / yes, case-insensitive). Anything else — including the
// variable being unset — is treated as OFF. The user's log file
// should not silently fill up; the gate is opt-in.
export function isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

// ----- Dedupe window -----

// In-process dedupe map: when fetch is failing continuously, the
// statusline tick fires ~once per second and an unguarded append
// would log the same error hundreds of times before the user even
// noticed. We keep a tiny map keyed by `<source>:<msg-hash>` with
// the last-emitted timestamp; the same key is suppressed for
// `DEDUPE_WINDOW_MS` milliseconds after the last append. Cleared
// at process exit (this is a per-tick child process, so the next
// tick starts fresh — a single entry of each repeated error per
// tick is still useful, and the JSONL file's 200-line cap means
// rapid-fire ticks can't drown out genuinely new errors).
const DEDUPE_WINDOW_MS = 60_000;
const _dedupeMap = new Map<string, number>();

function dedupeKey(source: string, msg: string): string {
  // Lightweight: a per-source fingerprint of the message. We don't
  // need cryptographic strength — just enough to keep "same error,
  // same provider" from re-emitting every tick. Cap the key at 200
  // chars so a giant error string doesn't bloat the map.
  return `${source}:${msg.slice(0, 200)}`;
}

// Returns true if a new append should be allowed. Records the
// emission time on success. Module-private — callers don't need
// the raw key, just the gate.
function shouldEmit(source: string, msg: string, now: number): boolean {
  const k = dedupeKey(source, msg);
  const last = _dedupeMap.get(k);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
    return false;
  }
  _dedupeMap.set(k, now);
  return true;
}

// Test-only — clear the dedupe map so a test that calls
// `appendFetchError` (or any other dedupe-gated append) twice in
// a row can verify both writes land without sleeping 60s.
export function __resetDedupeForTest(): void {
  _dedupeMap.clear();
}

// ----- Append -----

// Append one entry. Atomic at the OS level for small writes
// (<= PIPE_BUF, 4096B on Linux — well above our ~200B row). Creates
// the parent dir on demand. Disk errors are swallowed (stderr only)
// so the statusline never blocks on log-write failures. No-ops
// when the opt-in gate is off — see isEnabled() above.
//
// `cwd` (optional): when provided, the entry is written to the
// project-scoped diagnostics file at `state/<projectHash>/diagnostics.jsonl`.
// When omitted/null, the entry falls back to the legacy top-level
// `state/diagnostics.jsonl` (used for plugin-level errors with no
// project affiliation, e.g. config-parse warnings).
//
// v0.8.x+ — when `cwd` is not explicitly given, `append` reads
// from the process-level session cwd store (set via
// `setSessionCwd` from `index.ts:main()` after stdin is parsed)
// and uses that as both the file-routing key and the row's `cwd`
// field. This lets `logFs*` audit rows from cwd-unaware modules
// (e.g. cache.ts reading the top-level cache.json shared across
// concurrent panels) still carry the originating session's cwd on
// disk.
//
// v0.8.x+ — the same `cwd` argument (resolved or explicit) is
// also persisted onto the JSONL row under the `cwd` field so a
// postmortem reading the top-level file (or merging rows from
// multiple per-project files) can correlate each row back to the
// originating session without parsing the layout from disk paths.
// A null/empty cwd omits the field on disk.
//
// `fn` (optional, v0.8.x+): identifier of the calling function in
// `module.funcName` form (e.g. "cache.loadFromDisk"). Only the
// file-IO audit helpers set it; warning/error rows leave it off.
export function append(
  level: Level,
  source: string,
  msg: string,
  now: number = Date.now(),
  cwd?: string | null,
  fn?: string,
): void {
  if (!isEnabled()) return;
  if (!shouldEmit(source, msg, now)) return;
  // Resolve cwd: three states matter here:
  //   1. cwd === undefined → caller did not pass anything. Fall back
  //      to the process-level session cwd store (cwd-unaware
  //      callers; e.g. cache.ts reading the shared top-level
  //      cache.json).
  //   2. cwd === null      → caller explicitly opts out of the
  //      per-project file. The row lands in the top-level
  //      diagnostics.jsonl regardless of the session cwd store.
  //      Used by top-level IO (cache.loadFromDisk / cache.flushToDisk
  //      on the shared cache.json; index.loadPluginVersion probing
  //      the plugin manifest) — these audit rows describe a file
  //      shared across projects, so the postmortem reader expects
  //      to find them at the top level, not mixed into one session's
  //      per-project file.
  //   3. cwd is a non-empty string → caller-supplied cwd wins; the
  //      row lands in state/<projectHash>/diagnostics.jsonl for that
  //      session's own file.
  const resolvedCwd: string | undefined = (() => {
    if (cwd === null) return undefined;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
    return currentSessionCwd();
  })();
  const path = diagnosticsFilePath(resolvedCwd);
  const entry: Entry = {
    at: now,
    iso: localIso(now),
    level,
    source,
    // `fn` is emitted before `msg` so a postmortem reading the
    // JSONL sees the call-site identifier immediately followed
    // by the message body. Spread-into-position keeps the
    // fields strictly optional without a stray undefined.
    ...(fn ? { fn } : {}),
    msg,
    // `cwd` is recorded for cross-session debugging — multiple
    // Claude Code windows loading the plugin can share the same
    // state root, and the top-level diagnostics.jsonl is the
    // only one that sees every window's rows together. Stamped
    // last so the row reads `... fn msg cwd` — the previously
    // human-facing fields get prime position.
    ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
    // Truncate to the last MAX_ENTRIES lines. Best-effort: if any step
    // fails we just leave the file alone — the next append will retry.
    trimToMax(path, DEFAULT_MAX_ENTRIES);
  } catch {
    process.stderr.write("creditgauge: diagnostics append failed\n");
  }
}

// ----- File-IO audit helpers (v0.8.x+) -----
//
// Thin wrappers for the per-tick file IO sites (cache.ts,
// token-store.ts, status-store.ts, config.ts, index.ts) to record
// their disk activity to the diagnostics log. Reuses the opt-in
// gate (CREDITGAUGE_DIAGNOSTICS_ENABLE) and the per-project JSONL
// layout — the IO site's `path` is the same string the caller
// passed to fs.*, so the per-project scoping falls out naturally:
//   - IO under `${CLAUDE_CONFIG_DIR}/plugins/creditgauge/state/` —
//     cwd is already encoded in the path components the caller
//     passed in. We still surface each call's full path so a
//     postmortem can grep it without parsing the layout.
//   - IO under other locations (config.json at ~/.claude/...,
//     plugin.json at the cache dir) — also recorded.
//
// Why IS in the diagnostic's dedupe pipeline: fs audit rows do
// ride the same 60s shouldEmit() dedupe as fetch warnings. Audit
// semantics — "what kinds of IO did this tick do" — is well-served
// by collapsing repeated identical reads into one row: a per-tick
// `read cache.json` becomes a single JSONL entry that auto-dedupes
// with the prior tick's entry, rather than 60 identical rows
// filling the 200-line cap. To see the volume, the postmortem
// can grep for the timestamp cluster around `at`. If a caller
// wants un-deduped per-call logging they can call `append("info",
// …)` directly.
//
// The per-call `msg` is path-only when no byte count is given:
//   `read ${path}`
//   `write ${path} (${bytes}B)`
// Source taxonomy (so a postmortem can filter):
//   "fs:read"   — readFileSync / existsSync (existence probes count as
//                 reads; they cost the same syscall)
//   "fs:write"  — writeFileSync / appendFileSync
//   "fs:list"   — readdirSync
//   "fs:stat"   — statSync
//   "fs:mkdir"  — mkdirSync({recursive: true})
// Not in scope: stdin reads, process.stdout/stderr writes (pipes,
// not files), and the diagnostics file's own IO (the user said
// "日志文件本身除外" — the audit helpers only sit at the boundaries
// of OTHER files, never in diagnostics.ts's own IO path).

const IO_SOURCE = {
  read: "fs:read",
  write: "fs:write",
  list: "fs:list",
  stat: "fs:stat",
  mkdir: "fs:mkdir",
} as const;

// Truncate `path` to a stable per-call message. State paths under
// `${CLAUDE_CONFIG_DIR}/plugins/creditgauge/state/` are project-scoped
// — when the call site is in token-store.ts/status-store.ts, the
// `path` it already carries includes the projectHash, so no extra
// per-project dedupe is needed. We just cap the message length so
// the JSONL row stays within ~250B.
function ioMsg(path: string, bytes?: number): string {
  const base = path.length > 200 ? path.slice(0, 199) + "…" : path;
  return typeof bytes === "number" ? `${base} (${bytes}B)` : base;
}

// Record a file read (readFileSync / existsSync). `bytes` is the
// payload size when known (e.g. raw.length); omit for existence
// probes where no body was loaded.
//
// Dedupe: this intentionally rides the same 60s shouldEmit() dedupe
// as fetch warnings. Audit semantics — "what kinds of IO did this
// tick do" — is well-served by collapsing repeated identical reads
// into one row: a per-tick `read cache.json` becomes a single JSONL
// entry that auto-dedupes with the prior tick's entry, rather than
// 60 identical rows filling the 200-line cap. To see the volume,
// the postmortem can grep for the timestamp cluster around `at`.
// If a caller wants un-deduped per-call logging, they can call
// `append("info", ...)` directly.
// Record a file read (readFileSync / existsSync). `bytes` is the
// payload size when known (e.g. raw.length); omit for existence
// probes where no body was loaded. `fn` identifies the calling
// function (e.g. "cache.loadFromDisk") so a postmortem can grep
// by call site. `cwd` is an optional override — when omitted,
// `append` reads from the per-tick session cwd store (see
// `setSessionCwd`) so cwd-unaware callers (cache.ts reading the
// shared top-level cache.json) still get their audit rows stamped.
export function logFsRead(path: string, fn?: string, bytes?: number, cwd?: string | null): void {
  if (!isEnabled()) return;
  append("info", IO_SOURCE.read, ioMsg(path, bytes), Date.now(), cwd, fn);
}

// Record a file write (writeFileSync / appendFileSync). `bytes` is
// the payload size written when known.
export function logFsWrite(path: string, fn?: string, bytes?: number, cwd?: string | null): void {
  if (!isEnabled()) return;
  append("info", IO_SOURCE.write, ioMsg(path, bytes), Date.now(), cwd, fn);
}

// Record a directory listing (readdirSync).
export function logFsList(path: string, fn?: string, cwd?: string | null): void {
  if (!isEnabled()) return;
  append("info", IO_SOURCE.list, ioMsg(path), Date.now(), cwd, fn);
}

// Record a stat() call.
export function logFsStat(path: string, fn?: string, cwd?: string | null): void {
  if (!isEnabled()) return;
  append("info", IO_SOURCE.stat, ioMsg(path), Date.now(), cwd, fn);
}

// Record a mkdir({recursive:true}) call. mkdir is reported at the
// top of every write helper (cache.ts flush, token-store.ts
// appendSample, status-store.ts flushToDisk), so each is one
// audit row even though the actual filesystem call may be a
// no-op (dir already exists).
export function logFsMkdir(path: string, fn?: string, cwd?: string | null): void {
  if (!isEnabled()) return;
  append("info", IO_SOURCE.mkdir, ioMsg(path), Date.now(), cwd, fn);
}

// Trim a JSONL file to its last N lines. Reads the whole file (small),
// drops the head, writes back. Synchronous — keeps the API simple
// and is fast for our file size (40KB cap).
function trimToMax(path: string, max: number): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const lines = raw.split("\n");
  // lines.length includes a trailing empty string if the file ended
  // with \n. Drop that before counting.
  const real = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  if (real.length <= max) return;
  const kept = real.slice(-max);
  try {
    writeFileSync(path, kept.join("\n") + "\n", "utf8");
  } catch {
    // Best-effort — don't crash on a failed trim.
  }
}

// ----- Read -----

// Find the most recent entry of a given level. Used by m_error /
// m_warning to display the latest signal. Returns null when no entry
// of that level exists (clean state) or the file is malformed.
//
// Iterates the JSONL backward — the typical case (1-3 lines, fresh
// errors) hits the match immediately. For a fully-populated 200-line
// file this is O(200) which is still microseconds.
//
// `cwd` (optional): when provided, reads from the project-scoped
// file at `state/<projectHash>/diagnostics.jsonl`. When omitted/null,
// reads from the legacy top-level `state/diagnostics.jsonl`.
export function readLatest(level: Level, cwd?: string | null): Entry | null {
  const path = diagnosticsFilePath(cwd);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  // Walk backward. Skip the trailing empty string that split('\n')
  // leaves when the file ends with \n.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const r = parsed as Record<string, unknown>;
    if (r.level === level && typeof r.msg === "string") {
      const at = typeof r.at === "number" ? r.at : 0;
      return {
        at,
        // Older rows (pre v0.8.x, written before the `iso` field
        // landed) had no `iso`. Backfill from `at` so downstream
        // consumers see a stable shape regardless of file age.
        iso: typeof r.iso === "string" ? r.iso : localIso(at),
        level,
        source: typeof r.source === "string" ? r.source : "",
        // `fn` precedes `msg` to mirror the on-disk field order
        // (the postmortem reads them in the same sequence in both
        // the JSONL and the in-memory Entry shape).
        fn: typeof r.fn === "string" ? r.fn : undefined,
        msg: r.msg,
        // `cwd` is parsed back so a renderer that surfaces a
        // warning can annotate it with the originating session's
        // project dir (e.g. m_warning shows
        // "⚠ <iso> <fn> <msg> [cwd]").
        cwd: typeof r.cwd === "string" ? r.cwd : undefined,
      };
    }
  }
  return null;
}

// ----- Format -----

// Compact display string for the m_error / m_warning modules. The
// message is rendered verbatim — diagnostics are for the user, so the
// message is the signal, not a hash or code. Cap at a reasonable
// length to avoid blowing up the statusline.
//
// v0.8.x+ prepends the `iso` timestamp so a glance at the
// statusline tells the user WHEN the last warning/error fired
// (no need to cross-reference `at`); the optional `fn` and `cwd`
// sit between iso and the truncated msg so the statusline shape
// is: `<glyph> <iso>[ <fn>] <msg>[ <cwd>]`.
const MAX_DISPLAY_LEN = 80;
export function formatEntry(e: Entry): string {
  const truncated = e.msg.length > MAX_DISPLAY_LEN
    ? e.msg.slice(0, MAX_DISPLAY_LEN - 1) + "…"
    : e.msg;
  const fnPart = e.fn ? ` ${e.fn}` : "";
  const cwdPart = e.cwd ? ` [${e.cwd}]` : "";
  return `${levelGlyph(e.level)} ${e.iso}${fnPart} ${truncated}${cwdPart}`;
}

function levelGlyph(level: Level): string {
  return level === "error" ? "✖" : "⚠";
}