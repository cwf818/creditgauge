// Tiny persistent TTL cache for the statusline: in-memory Map hot path,
// shadowed to disk under ~/.claude/plugins/creditgauge/state/cache.json.
// The plugin is a fresh node process per statusLine tick, so without the
// disk shadow `cacheTtlMs` would be meaningless (empty Map every spawn) —
// the shadow lets a within-TTL hit on tick N+1 skip the network fetch.
//
// Key namespaces are chosen by callers (not render.ts): index.ts uses the
// provider name; api.quote.ts uses `quote:<freqMs>:<address>`; render.ts
// reads via peekWithTtl/peek. NO per-project prefixing — all projects share
// this single top-level file.
//
// Stale-on-error: callers fall back to `peek(key)` on fetch failure; peek
// ignores TTL and returns whatever the disk has.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logFsMkdir, logFsRead, logFsWrite } from "./diagnostics.ts";

// homedir() is only the last-resort fallback when both HOME and USERPROFILE
// are unset (some sandboxed environments strip both).

type Entry<T> = { at: number; value: T; ttlMs?: number };

// Legacy pre-rewrite stat-cache keys (sum:v1:*, avg:v1:*). Unreachable now
// but still on disk (cache.set never deletes); strip on load so the next
// flush doesn't re-write them.
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
// One JSON file, Record<key, Entry>, written synchronously on every set()/
// clear(). Writes are infrequent (≤ once per cacheTtlMs) so sync writeFile
// is fine. Lives in state/ (sibling of config.json), which uninstall.sh
// already wipes.

function defaultCachePath(): string {
  // Prefer CLAUDE_CONFIG_DIR (matches diagnostics.ts / status-store.ts),
  // else $HOME/.claude. Single top-level state/cache.json shared by all
  // projects — key namespaces are caller-chosen, not per-project prefixed.
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

// True once disk was loaded this process; guards against re-reading on
// every get() when the in-memory Map already has the data.
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
  // Top-level file — audit row goes to the top-level diagnostics.jsonl
  // (cwd=null bypasses the session cwd store).
  logFsRead(loadPath, "cache.loadFromDisk", undefined, null, "cache");
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
    // Drop legacy sum:v1:*/avg:v1:* keys — unreachable from any get()/peek()
    // call site; keeping them would leak them back to disk on the next flush.
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
  logFsMkdir(dir, "cache.flushToDisk", null, "cache");
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
  // Flush every in-memory entry verbatim. TTL is enforced only at read time
  // (get/getWithAge); we deliberately do NOT evict expired entries here —
  // the stale-on-error fallback (peek/peekWithAge) needs them past TTL.
  const obj: Record<string, Entry<unknown>> = {};
  for (const [k, v] of store) {
    obj[k] = v;
  }
  const payload = JSON.stringify(obj);
  logFsWrite(path, "cache.flushToDisk", payload.length, null, "cache");
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

// TTL-aware sibling of peekWithAge: returns value AND age while within TTL,
// null on miss/expiry. Lets consumers (e.g. m_age) surface freshness even
// on a hit.
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

// Sibling of peek that also returns age (for the renderer's " · 5m ago"
// stale annotation). Null on miss, same shape as peek.
export function peekWithAge<T>(key: string): { value: T; ageMs: number } | null {
  loadFromDisk();
  const e = store.get(key) as Entry<T> | undefined;
  if (!e) return null;
  return { value: e.value, ageMs: Date.now() - e.at };
}

// Sibling of peekWithAge that also returns ttlMs. TTL-IGNORING (null only
// on miss, NEVER on expiry) so the renderer can show "cache past TTL,
// refresh next tick" rather than dropping the line. Used by m_cacheTtlStatus.
// Keyed lookup against the ACTIVE provider's row — each provider runs on its
// own clock, so reading across all keys would leak freshness between them.
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