// Tiny persistent TTL cache for the statusline.
//
// Single-process Map for the hot path; shadowed to disk under
// ~/.claude/plugins/creditgauge/state/cache.json so the
// cache survives across per-tick child-process invocations.
//
// The plugin runs as a fresh node process on every Claude Code
// statusLine tick — without persistence, `cacheTtlMs` is meaningless
// (the Map is empty on every spawn). v0.2.22 adds a disk shadow so
// a within-TTL hit on tick N+1 actually short-circuits the network
// fetch on tick N+1.
//
// Per-Project Isolation (v0.4.x+): the cache module itself is
// cwd-unaware — all public APIs (get/set/peek/clear/...) take
// `(key, ttlMs)` and write to a single on-disk file. Isolation
// between concurrent Claude Code instances running on different
// projects is achieved by `src/render.ts`, which prefixes every
// key with `projectHash(cwd):` before calling into this module.
// That keeps the cache module's API stable and its test hooks
// (setCachePathResolver / __resetForTest) unchanged. See
// `src/render.ts` `projectCacheKey` for the prefix helper.
//
// Stale-on-error: callers should fall back to `peek(key)` if a fetch
// throws. peek ignores TTL — it returns whatever the disk has.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logFsMkdir, logFsRead, logFsWrite } from "./diagnostics.ts";

// Note: homedir() is still imported above for the rare case where
// both HOME and USERPROFILE are unset (some sandboxed environments
// strip both). defaultCachePath() prefers the explicit env vars first
// and only falls back to homedir() as a last resort.

type Entry<T> = { at: number; value: T; ttlMs?: number };

// v0.8.x — legacy key prefixes from the v0.8.0-pre stat cache
// (sum:v1:*, avg:v1:*). The schema-v1 keys embedded `sinceMs` in
// the key itself, which exploded the key space (one entry per
// sinceMs instance). After the rewrite to `stat:model:window:align`
// the old keys are unreachable but the disk file still holds them
// because cache.set never deleted entries. We strip them on load
// so the next flush writes them out. Subsequent reloads will not
// re-introduce them (no new code writes the old prefixes).
const LEGACY_KEY_PREFIXES = ["sum:v1:", "avg:v1:"];
function isLegacyKey(key: string): boolean {
  for (const p of LEGACY_KEY_PREFIXES) {
    if (key.startsWith(p)) return true;
  }
  return false;
}

// Exported for tests; treat as read-only outside of this module.
export const store = new Map<string, Entry<unknown>>;

// ----- Disk shadow -----
//
// One file, JSON-encoded Record<key, Entry>. Written synchronously on
// every set() / clear(). The statusLine child-process model means
// writes are infrequent (≤ once per cacheTtlMs), so a sync writeFile
// is fine — the alternative (async) would need a write-queue and a
// "did it flush before exit?" guarantee that's overkill here.
//
// The file lives in the existing state/ dir (sibling of config.json).
// scripts/uninstall.sh already wipes state/, so uninstall cleans up
// the cache file with no extra code.

function defaultCachePath(): string {
  // v0.4.x+: prefer CLAUDE_CONFIG_DIR (matches the rest of the plugin,
  // including diagnostics.ts and token-store.ts). Fall back to
  // $HOME/.claude on platforms / setups where CLAUDE_CONFIG_DIR is
  // not set. Note: this is the top-level `state/cache.json`; per-project
  // isolation is handled in `src/render.ts` via key prefixing, not by
  // writing a different file per project — see module header.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return join(
    claudeRoot,
    "plugins",
    "creditgauge",
    "state",
    "cache.json",
  );
}

let _pathResolver: () => string = defaultCachePath;

// Test hook: point the disk path at a temp file. Production code never
// sets it; the path is purely a function of $HOME.
export function setCachePathResolver(fn: () => string): void {
  _pathResolver = fn;
}

export function resetCachePathResolver(): void {
  _pathResolver = defaultCachePath;
}

// True once we've attempted to load from disk for this process. Guards
// against re-reading on every get() — the file is small (a handful of
// entries) but reading it on every tick is wasteful when the in-memory
// Map already has the data.
let _loaded = false;

// Test-only: simulate "new process" between two cache calls. Clears the
// in-memory Map AND resets the lazy-load guard so the next get/peek
// will hit the disk again. Production code never calls this.
export function __resetForTest(): void {
  store.clear();
  _loaded = false;
}

function loadFromDisk(): void {
  if (_loaded) return;
  _loaded = true;
  const loadPath = _pathResolver();
  // Top-level file — route the audit row to the top-level
  // diagnostics.jsonl (passing cwd=null bypasses the global session
  // cwd store so the row lands where a postmortem reader expects to
  // find cross-project IO).
  logFsRead(loadPath, "cache.loadFromDisk", undefined, null);
  let raw: string;
  try {
    raw = readFileSync(loadPath, "utf8");
  } catch {
    // ENOENT or unreadable: silent. An empty / missing cache file is
    // the steady state for a fresh install — there is nothing to load.
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON (truncated write, manual edit, etc): warn once but
    // do not crash the statusline. The next set() will overwrite the
    // file with valid JSON.
    process.stderr.write(
      "creditgauge: cache file is malformed; ignoring\n",
    );
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return;
  }
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    // v0.8.x — drop legacy sum:v1:*/avg:v1:* keys. They were written
    // by the pre-refactor stat cache and are no longer reachable
    // from any get()/peek() call site. Keeping them in the in-memory
    // Map would just leak them back to disk on the next flush.
    if (isLegacyKey(key)) continue;
    const e = raw as { at?: unknown; value?: unknown; ttlMs?: unknown };
    if (
      typeof e.at === "number" &&
      Number.isFinite(e.at) &&
      "value" in e
    ) {
      const ttlMs = typeof e.ttlMs === "number" && e.ttlMs > 0 ? e.ttlMs : undefined;
      store.set(key, { at: e.at, value: e.value, ttlMs });
    }
  }
}

function flushToDisk(): void {
  const path = _pathResolver();
  const dir = dirname(path);
  logFsMkdir(dir, "cache.flushToDisk", null);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // mkdir failure: don't try to write — the in-memory Map is still
    // authoritative for this process. Surface a one-line warning so
    // the user can investigate permissions / disk-full.
    process.stderr.write(
      "creditgauge: cache mkdir failed; in-memory only\n",
    );
    return;
  }
  // v0.8.x — TTL-aware flush. Before writing, evict any entry whose
  // own ttlMs has elapsed. Entries written before this change (no
  // ttlMs on disk) are kept verbatim — their TTL is still enforced
  // by get()/peek(), we just don't proactively reclaim them here.
  const now = Date.now();
  const obj: Record<string, Entry<unknown>> = {};
  for (const [k, v] of store) {
    if (v.ttlMs != null && now - v.at > v.ttlMs) {
      store.delete(k);
      continue;
    }
    obj[k] = v;
  }
  const payload = JSON.stringify(obj);
  logFsWrite(path, "cache.flushToDisk", payload.length, null);
  try {
    writeFileSync(path, payload);
  } catch {
    process.stderr.write(
      "creditgauge: cache write failed; in-memory only\n",
    );
  }
}

export function get<T>(key: string, ttlMs: number): T | null {
  loadFromDisk();
  const e = store.get(key) as Entry<T> | undefined;
  if (!e) return null;
  if (Date.now() - e.at > ttlMs) return null;
  return e.value;
}

// TTL-aware sibling of peekWithAge. Returns the entry's value AND its age
// when the entry is still within TTL; returns null on miss or after
// expiration. Use this when the caller wants the freshness signal even
// on a successful cache hit — a fresh hit at age=500ms is semantically
// different from a fresh hit at age=59s, and downstream consumers
// (e.g. the m_age lineTemplate module) can choose to surface that.
export function getWithAge<T>(
  key: string,
  ttlMs: number,
): { value: T; ageMs: number } | null {
  loadFromDisk();
  const e = store.get(key) as Entry<T> | undefined;
  if (!e) return null;
  const ageMs = Date.now() - e.at;
  if (ageMs > ttlMs) return null;
  return { value: e.value, ageMs };
}

export function set<T>(key: string, value: T, ttlMs?: number): void {
  loadFromDisk();
  store.set(key, { at: Date.now(), value, ttlMs });
  flushToDisk();
}

export function peek<T>(key: string): T | null {
  loadFromDisk();
  const e = store.get(key) as Entry<T> | undefined;
  return e ? e.value : null;
}

// Sibling of peek that ALSO returns the entry's age in milliseconds. Used by
// the renderer to print a "stale" annotation (" · 5m ago") when we're
// displaying a cached value after a fetch error. Returns null on miss (same
// shape as peek), so callers can use `if (!cached) ...` uniformly.
export function peekWithAge<T>(key: string): { value: T; ageMs: number } | null {
  loadFromDisk();
  const e = store.get(key) as Entry<T> | undefined;
  if (!e) return null;
  return { value: e.value, ageMs: Date.now() - e.at };
}

// v0.8.16 — Sibling of peekWithAge that ALSO returns the entry's ttlMs.
// TTL-IGNORING (returns null only on miss, NEVER on expiry) so the
// renderer can show "cache is past TTL, will refresh next tick" rather
// than dropping the line entirely. Used by m_cacheTtlStatus to render
// the TTL gauge without coupling display to freshness.
//
// v0.9.x — keyed lookup against the ACTIVE provider's cache row.
// Each provider is requested independently on its own clock; reading
// the freshest entry across all keys would leak one provider's
// freshness into another's display.
export function peekWithTtl(key: string): { ageMs: number; ttlMs: number } | null {
  loadFromDisk();
  const e = store.get(key) as Entry<unknown> | undefined;
  if (!e) return null;
  return { ageMs: Date.now() - e.at, ttlMs: e.ttlMs ?? 0 };
}

export function clear(key?: string): void {
  loadFromDisk();
  if (key === undefined) store.clear();
  else store.delete(key);
  flushToDisk();
}