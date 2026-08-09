// Persistent JSONL warning/error log. Per-project layout: with a cwd,
// the log lives at `state/<projectHash>/diagnostics.jsonl`; without one
// (plugin-level errors like config-parse warns) it falls back to the
// legacy top-level `state/diagnostics.jsonl`. Each line is a structured
// record {"at","level","source","msg",...}. Consumers: the m_error /
// m_warning display modules (read the latest line per level) and
// postmortem tailing. Capped at DEFAULT_MAX_ENTRIES lines, oldest
// dropped. Opt-in: writing is OFF unless CREDITGAUGE_DIAGNOSTICS_ENABLE
// is truthy ("1"/"true"/"yes", case-insensitive) — the file can hold
// sensitive fragments, so we don't write unless asked. The stderr
// "append failed" line is independent of that gate.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectHash } from "./status-store.ts";

// ----- Path -----

function stateRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return join(claudeRoot, "plugins", "creditgauge", "state");
}

// cwd → state/<projectHash>/diagnostics.jsonl; else legacy top-level
// state/diagnostics.jsonl.
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

// One JSONL row. `at` is epoch-ms; `iso` is the same instant as a
// local-tz ISO8601 string (sv-SE, human-readable). `fn` = calling
// function in module.funcName form (file-IO audit rows only); `cwd` =
// the row's project (project-scoped rows only). Both omitted on disk
// when unset.
export type Entry = {
  at: number;
  iso: string;
  level: Level;
  source: string;
  fn?: string;
  msg: string;
  cwd?: string;
};

// Cap on file length; append drops the oldest lines beyond this.
// 1000 keeps enough tail for a sustained failure mode (e.g. an
// m_quote|address endpoint down for minutes) to postmortem.
export const DEFAULT_MAX_ENTRIES = 1000;

// ----- Process-level session cwd store -----
// The statusline runs as a per-tick child process. `setSessionCwd` is
// called once per tick from index.ts after stdin is parsed; `append` /
// the logFs* helpers read the value so cwd-unaware modules (cache.ts,
// index.ts) still stamp their audit rows with the originating session's
// cwd. A single module-private `_sessionCwd` is safe — child processes
// never share state across invocations.
let _sessionCwd: string | null | undefined = undefined;

export function setSessionCwd(cwd: string | null | undefined): void {
  _sessionCwd = cwd;
}

// Session cwd, normalized to undefined when empty/null (module-private).
function currentSessionCwd(): string | undefined {
  if (typeof _sessionCwd !== "string" || _sessionCwd.length === 0) {
    return undefined;
  }
  return _sessionCwd;
}

// Local-tz ISO8601 string for an epoch-ms instant (sv-SE locale =
// stable "YYYY-MM-DD HH:MM:SS.mmm" shape, lexically sortable). Host
// default tz (no timeZone option) — read by humans in their own clock.
function localIso(epochMs: number): string {
  // Host local tz when `timeZone` is omitted; cast silences strict mode.
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

// True iff CREDITGAUGE_DIAGNOSTICS_ENABLE is "1"/"true"/"yes"
// (case-insensitive); unset = OFF. The log is opt-in — it should not
// silently fill up.
export function isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

// ----- Debug subkeys -----
// Per-subsystem opt-in for append() / logFs* writes, AND-gated with
// the env var (the master switch).
export type Subkey =
  | "stdin"
  | "statusStore"
  | "config"
  | "cache"
  | "statCache"
  | "smokeNormalizeTick"
  | "pluginVersion"
  | "parse";

// Per-tick mutable singleton, set once from index.ts after loadConfig().
const _debugFlags: Partial<Record<Subkey, boolean>> = {};

export function setDebugFlags(flags: Partial<Record<Subkey, boolean>>): void {
  // Replace, don't merge — the caller may clear stale subkeys by
  // omitting them; unknown keys are silently dropped.
  for (const k of Object.keys(_debugFlags) as Subkey[]) {
    delete _debugFlags[k];
  }
  for (const k of Object.keys(flags) as Subkey[]) {
    _debugFlags[k] = flags[k] === true;
  }
}

export function __resetDebugFlagsForTest(): void {
  for (const k of Object.keys(_debugFlags) as Subkey[]) {
    delete _debugFlags[k];
  }
}

// True iff (env truthy) AND (flags[subkey] === true). Unknown subkeys
// always return false — the caller should typecheck.
export function isSubkeyEnabled(
  subkey: Subkey,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isEnabled(env)) return false;
  return _debugFlags[subkey] === true;
}

// ----- Dedupe window -----

// In-process dedupe: a failing fetch could append the same error every
// ~1s tick. A map keyed `<source>:<msg-hash>` suppresses repeats for
// DEDUPE_WINDOW_MS (60s). Per-tick child process → cleared each tick;
// one entry per repeated error per tick stays useful.
const DEDUPE_WINDOW_MS = 60_000;
const _dedupeMap = new Map<string, number>();

function dedupeKey(source: string, msg: string): string {
  // Per-source message fingerprint (capped at 200 chars so a giant
  // error string doesn't bloat the map).
  return `${source}:${msg.slice(0, 200)}`;
}

// True if a fresh append should be allowed; records emission time.
function shouldEmit(source: string, msg: string, now: number): boolean {
  const k = dedupeKey(source, msg);
  const last = _dedupeMap.get(k);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
    return false;
  }
  _dedupeMap.set(k, now);
  return true;
}

// Test-only: clear the dedupe map so two calls in a row both land
// without sleeping 60s.
export function __resetDedupeForTest(): void {
  _dedupeMap.clear();
}

// ----- Append -----

// Append one entry. Atomic at the OS level for small writes (<= PIPE_BUF);
// creates the parent dir on demand; disk errors are swallowed (stderr
// only) so the statusline never blocks. No-ops when the opt-in gate is
// off. cwd routing: explicit string → project-scoped file; null → legacy
// top-level file; undefined → the per-tick session cwd store (so
// cwd-unaware modules still stamp their rows). fn (module.funcName) is
// set by the file-IO audit helpers only.
export function append(
  level: Level,
  source: string,
  msg: string,
  now: number = Date.now(),
  cwd?: string | null,
  fn?: string,
  subkey?: Subkey,
): void {
  if (subkey !== undefined ? !isSubkeyEnabled(subkey) : !isEnabled()) return;
  if (!shouldEmit(source, msg, now)) return;
  // Resolve cwd: undefined → per-tick session cwd store (cwd-unaware
  // callers); null → legacy top-level file (shared-file audit rows like
  // cache.json reads); non-empty string → that session's project file.
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
    // fn before msg so a postmortem sees call-site then body.
    ...(fn ? { fn } : {}),
    msg,
    // cwd recorded so concurrent windows sharing a state root can be
    // disambiguated; stamped last.
    ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
    // Truncate to the last MAX_ENTRIES lines (best-effort).
    trimToMax(path, DEFAULT_MAX_ENTRIES);
  } catch {
    process.stderr.write("creditgauge: diagnostics append failed\n");
  }
}

// ----- File-IO audit helpers -----
// Thin wrappers for the per-tick file IO sites (cache.ts,
// status-store.ts, config.ts, index.ts). Reuse the opt-in gate and the
// per-project JSONL layout. Source taxonomy: fs:read / fs:write /
// fs:list / fs:stat / fs:mkdir. Audit rows ride the same 60s dedupe as
// fetch warnings — repeated identical reads collapse to one row (grep
// the `at` cluster for volume). Not in scope: stdin reads,
// stdout/stderr writes, and the diagnostics file's own IO.

const IO_SOURCE = {
  read: "fs:read",
  write: "fs:write",
  list: "fs:list",
  stat: "fs:stat",
  mkdir: "fs:mkdir",
} as const;

// Path-based message (capped ~250B); projectHash already rides in state
// paths, so no extra per-project dedupe is needed.
function ioMsg(path: string, bytes?: number): string {
  const base = path.length > 200 ? path.slice(0, 199) + "…" : path;
  return typeof bytes === "number" ? `${base} (${bytes}B)` : base;
}

// Record a file read (readFileSync / existsSync). `bytes` = payload
// size when known. `fn` = call site (e.g. "cache.loadFromDisk"); `cwd`
// overrides the session store. Rides the 60s dedupe (see header).
export function logFsRead(path: string, fn?: string, bytes?: number, cwd?: string | null, subkey?: Subkey): void {
  if (subkey !== undefined ? !isSubkeyEnabled(subkey) : !isEnabled()) return;
  append("info", IO_SOURCE.read, ioMsg(path, bytes), Date.now(), cwd, fn);
}

// Record a file write (writeFileSync / appendFileSync). `bytes` is
// the payload size written when known.
export function logFsWrite(path: string, fn?: string, bytes?: number, cwd?: string | null, subkey?: Subkey): void {
  if (subkey !== undefined ? !isSubkeyEnabled(subkey) : !isEnabled()) return;
  append("info", IO_SOURCE.write, ioMsg(path, bytes), Date.now(), cwd, fn);
}

// Record a directory listing (readdirSync).
export function logFsList(path: string, fn?: string, cwd?: string | null, subkey?: Subkey): void {
  if (subkey !== undefined ? !isSubkeyEnabled(subkey) : !isEnabled()) return;
  append("info", IO_SOURCE.list, ioMsg(path), Date.now(), cwd, fn);
}

// Record a stat() call.
export function logFsStat(path: string, fn?: string, cwd?: string | null, subkey?: Subkey): void {
  if (subkey !== undefined ? !isSubkeyEnabled(subkey) : !isEnabled()) return;
  append("info", IO_SOURCE.stat, ioMsg(path), Date.now(), cwd, fn);
}

// Record a mkdir({recursive:true}) call (may be a no-op if the dir
// already exists).
export function logFsMkdir(path: string, fn?: string, cwd?: string | null, subkey?: Subkey): void {
  if (subkey !== undefined ? !isSubkeyEnabled(subkey) : !isEnabled()) return;
  append("info", IO_SOURCE.mkdir, ioMsg(path), Date.now(), cwd, fn);
}

// Trim a JSONL file to its last N lines (synchronous; file is small).
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

// Most recent entry of a given level (for m_error / m_warning), or
// null when none exists / the file is malformed. Walks the JSONL
// backward — the typical 1-3 line fresh-error case hits immediately.
// cwd: project-scoped file when provided, else legacy top-level.
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
        // Pre-iso rows: backfill from `at` so consumers see a stable shape.
        iso: typeof r.iso === "string" ? r.iso : localIso(at),
        level,
        source: typeof r.source === "string" ? r.source : "",
        // Mirrors the on-disk field order (fn before msg).
        fn: typeof r.fn === "string" ? r.fn : undefined,
        msg: r.msg,
        // Parsed back so a renderer can annotate with the session's dir.
        cwd: typeof r.cwd === "string" ? r.cwd : undefined,
      };
    }
  }
  return null;
}

// ----- Format -----

// Compact display string for m_error / m_warning. Message rendered
// verbatim; prepends iso; optional fn + cwd between iso and the
// truncated msg. Shape: `<glyph> <iso>[ <fn>] <msg>[ <cwd>]`.
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