// Runtime state boundary for stdin-derived data. Owns three state files
// under `${CLAUDE_CONFIG_DIR}/plugins/creditgauge/state/`:
//
//   - `cache.stat.json`                    — cross-project sum/avg stat cache
//   - `<projectHash>/state.json`           — per-project accumulated state
//   - `<projectHash>/<sessionId>.jsonl`    — append-only normalized samples
//
// Single home of the per-tick pipeline (beginTick / processTick / mark /
// setAvg / commit): loads state, normalizes + validates stdin, updates
// accumulators / prevTickStatus / lastActive, flushes state.json once,
// and appends one JSONL row when valid.

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  append as appendDiag,
  isSubkeyEnabled,
  logFsList,
  logFsMkdir,
  logFsRead,
  logFsStat,
  logFsWrite,
} from "./diagnostics.ts";
import type { TokenSample, TokenSnapshot } from "./types.ts";
import { normalizeUrl } from "./utils.ts";
import { configStore, resolveTokenPrice } from "./config.ts";

// ----- Persisted value families ------------------------------------------------

export type TickStatusValue = {
  accTokenIn: number;
  accTokenOut: number;
  accTokenCachedIn: number;
  accTokenTotalIn: number;
  accApiMs: number;
  accApiCalls: number;
  // Derived ratio persisted at write time so render reads it straight:
  // accTokenCachedIn / accTokenTotalIn * 100 (zero denominator → 0).
  accTokenHitRate: number;
  // Unix-ms instant of this slot's first valid write (stamped by
  // setAvg / bumpDeltaScope). null = "no writes yet" → start:n/a.
  startAt?: number | null;
  // Accumulated per-tick token costs by currency; value is a decimal
  // string to avoid floating-point drift. Empty = none accumulated.
  costs: Array<{ currency: string; value: string }>;
};
// The only field the next tick subtracts against is `totalApiMs`
// (apiMs = current - prev); all other per-turn fields are read
// straight from TokenSnapshot. `totalDurationMs` joins the cursor
// as detectRegression's signal (stdin cost.total_duration_ms — the cc
// process wall-clock, monotonic per tick). The two are read
// independently — totalDurationMs never feeds apiMs.
export type PrevTickStatusValue = {
  totalApiMs: number;
  totalDurationMs: number;
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  // Carry-over for stdin context_window.used_percentage: when a tick
  // reports 0 (an observed error), beginTick falls back to this prev
  // value. Null when no prior non-null value was ever observed.
  contextUsedPercent: number | null;
};

export type LastActiveValue = {
  direction: "in" | "out" | "apiMs" | "tokenHitRate";
  tps: number;
};

export const PREV_TICK_KEY = "prevTickStatus";

export type Entry =
  | { at: number; value: TickStatusValue; kind: "tickStatus" }
  | { at: number; value: PrevTickStatusValue; kind: "prevTickStatus" }
  | { at: number; value: LastActiveValue; kind: "lastActive" };

export type Store = Record<string, Entry>;

// The only derived delta in the pipeline; speed/apiMs modules use it.
// Everything else reads TickSnapshot.{in, out, ...} directly.
export type ApiMsDelta = {
  apiMs: number;        // -1 = regression sentinel, 0 = idle, >0 = real delta
  totalApiMs: number;   // current tick stdin value
};

// Flat projection of the current tick's stdin snapshot + the derived
// apiMs. No write-back payload — next tick re-reads from disk.
export type TickSnapshot = {
  hasMeasurement: boolean;
  in: number;
  out: number;
  cachedIn: number;
  totalIn: number;
  totalOut: number;
  totalApiMs: number;
  apiMs: number;
  // Per-tick cost derived at processTick time; null when no price matches.
  cost: { currency: string; value: string } | null;
};

export type AvgSnapshot = {
  accTokenIn: number;
  accTokenOut: number;
  accApiMs: number;
  accTokenCachedIn: number;
  accApiCalls: number;
  accTokenTotalIn: number;
  // Mirror of TickStatusValue.accTokenHitRate, pre-computed.
  accTokenHitRate: number;
  // Propagated from TickStatusValue.startAt; rendered via formatAbsTime.
  startAt?: number | null;
  // Propagated from TickStatusValue.costs; optional for test call sites.
  costs?: Array<{ currency: string; value: string }>;
};

// Internal per-tick snapshot: full stdin snapshot + derived apiMs +
// regression flag + speed/rate metrics.
type CurrentTick = {
  sessionId: string;
  cwd: string;
  // Active-model id (stdin.model.id). Drives the per-model accumulator
  // slot key and the JSONL sample.model stamp (stable id, not label).
  modelId: string | null;
  // snapshot fields — read straight from stdin, no cross-tick subtract
  in: number;
  out: number;
  cachedIn: number;
  hasCachedIn: boolean;
  cacheCreation: number;
  totalIn: number | null;
  totalOut: number | null;
  totalApiMs: number;
  // the only derived delta
  apiMs: number;
  // baseline cursor + regression detection
  prevTotalApiMs: number | null;
  invalidRegression: boolean;
  // derived metrics used by speed / hit-rate modules
  tokenHitRate: number | null;
  tokenInSpeed: number | null;
  tokenOutSpeed: number | null;
  // Per-tick token cost (stdin deltas × tokenPrices); null when no match.
  cost: { currency: string; value: string } | null;
};

export type ProcessResult = {
  valid: boolean;
  snapshot: CurrentTick | null;
  measurement: TickSnapshot;
  wroteState: boolean;
  wroteSample: boolean;
};

export type TickState = {
  cwd: string | null;
  tokens: TokenSnapshot | null;
  loaded: Store;
  pending: Store;
  dirty: boolean;
  prevTick: PrevTickStatusValue | null;
  valid: boolean;
  measurement: TickSnapshot | null;
  snapshot: CurrentTick | null;
  sample: TokenSample | null;
};

export type SumFilter = {
  // Each unique windowKey (declared interval.windowId, "all", or a
  // free-form dhms string) mints its own `stat:<model>:<windowKey>`
  // cache entry; TTL=300s keeps abandoned entries bounded.
  windowKey: string;
  sinceMs: number;
  modelFilter?: string;
  // Default provider filter: only rows whose base_url matches the
  // normalized ANTHROPIC_BASE_URL (set by parseWindowScope).
  // undefined = no filtering.
  providerBaseUrl?: string;
  // Renderer-side SumFilter adds windowIdMatch/interval/windowMs read
  // at the parseWindowScope call site; status-store treats the filter
  // structurally, so those aren't redeclared here.
};

export type StatAggregate = {
  sumIn: number;
  sumOut: number;
  sumCached: number;
  sumTotalIn: number;
  sumApiMs: number;
  rows: number;
  calls: number;
  lastAt: number;
  // min(s.at) across the filtered rows. 0 when no row carries a
  // valid at. Drives m_sumStartTime rendering.
  firstAt: number;
  // Plan-window used% captured at getStatAggregate time when the caller
  // resolved an aligned scan (alignActive=true) with a usable percent;
  // null otherwise. Read from the structurally-passed filter.interval.
  alignedUsedPercent?: number | null;
  generatedAt: number;
  // Per-currency cost totals over the window; optional for test call sites.
  costs?: Array<{ currency: string; value: string }>;
};

type StatCacheEntry<T> = { at: number; value: T; ttlMs?: number };

const EMPTY_TICK: TickSnapshot = {
  hasMeasurement: false,
  in: 0,
  out: 0,
  cachedIn: 0,
  totalIn: 0,
  totalOut: 0,
  totalApiMs: 0,
  apiMs: 0,
  cost: null,
};

const STAT_CACHE_TTL_MS = 300_000;

// ----- Shared state root + path helpers ---------------------------------------

function defaultStateRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return join(claudeRoot, "plugins", "creditgauge", "state");
}

let _stateRoot: () => string = defaultStateRoot;

export function stateRoot(): string {
  return _stateRoot();
}

export function setStateRoot(fn: () => string): void {
  _stateRoot = fn;
  _loaded.clear();
  _stores.clear();
  __resetStatCacheForTest();
}

export function resetStateRoot(): void {
  _stateRoot = defaultStateRoot;
  _loaded.clear();
  _stores.clear();
  __resetStatCacheForTest();
}

export function projectHash(cwd: string): string {
  return cwd
    .replace(/[\\/:]/g, "-")
    .replace(/[\s\x00-\x1f\x7f]/g, "-")
    .toLowerCase()
    .slice(0, 80);
}

export function stateFilePath(cwd: string): string {
  return join(stateRoot(), projectHash(cwd), "state.json");
}

export function statusFilePath(cwd: string): string {
  return stateFilePath(cwd);
}

export function sampleFilePath(cwd: string, sessionId: string): string {
  return join(stateRoot(), projectHash(cwd), `${sessionId}.jsonl`);
}

export function statCacheFilePath(): string {
  return join(stateRoot(), "cache.stat.json");
}

let _pathResolver: (cwd: string) => string = statusFilePath;
let _statCachePathResolver: () => string = statCacheFilePath;

export function setStatusPathResolver(fn: (cwd: string) => string): void {
  _pathResolver = fn;
}

export function resetStatusPathResolver(): void {
  _pathResolver = statusFilePath;
}

export function setStatCachePathResolver(fn: () => string): void {
  _statCachePathResolver = fn;
}

export function resetStatCachePathResolver(): void {
  _statCachePathResolver = statCacheFilePath;
}

// ----- Per-project store load/flush -------------------------------------------

const _stores = new Map<string, Store>();
const _loaded = new Set<string>();

function cloneStore(store: Store): Store {
  const out: Store = {};
  for (const [key, entry] of Object.entries(store)) {
    if (entry.kind === "prevTickStatus") {
      out[key] = { at: entry.at, kind: entry.kind, value: { ...entry.value } };
      continue;
    }
    if (entry.kind === "lastActive") {
      out[key] = { at: entry.at, kind: entry.kind, value: { ...entry.value } };
      continue;
    }
    out[key] = { at: entry.at, kind: entry.kind, value: { ...entry.value } };
  }
  return out;
}

function parseStore(raw: string): Store {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write("creditgauge: state file is malformed; ignoring\n");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Store = {};
  for (const [key, rawEntry] of Object.entries(parsed as Record<string, unknown>)) {
    const e = rawEntry as { at?: unknown; value?: unknown };
    if (typeof e.at !== "number" || !e.value || typeof e.value !== "object") continue;
    if (
      key === "lastActive:in" ||
      key === "lastActive:out" ||
      key === "lastActive:apiMs" ||
      key === "lastActive:tokenHitRate"
    ) {
      const v = e.value as Record<string, unknown>;
      const direction: LastActiveValue["direction"] =
        key === "lastActive:in"
          ? "in"
          : key === "lastActive:out"
            ? "out"
            : key === "lastActive:apiMs"
              ? "apiMs"
              : "tokenHitRate";
      out[key] = {
        at: e.at,
        kind: "lastActive",
        value: {
          direction,
          tps: typeof v.tps === "number" ? v.tps : 0,
        },
      };
      continue;
    }
    if (key === PREV_TICK_KEY) {
      const v = e.value as Record<string, unknown>;
      // Only totalApiMs + identity participate in cross-tick math;
      // legacy in/out/cachedIn/totalIn fields are silently dropped.
      out[key] = {
        at: e.at,
        kind: "prevTickStatus",
        value: {
          totalApiMs: typeof v.totalApiMs === "number" ? v.totalApiMs : 0,
          // Legacy rows lack totalDurationMs; backfill with 0 so the
          // cold-start guard doesn't fire on a freshly-upgraded file.
          totalDurationMs: typeof v.totalDurationMs === "number"
            ? v.totalDurationMs
            : 0,
          sessionId: typeof v.sessionId === "string" ? v.sessionId : null,
          cwd: typeof v.cwd === "string" ? v.cwd : null,
          model: typeof v.model === "string" ? v.model : null,
          // Legacy rows: missing → null (start of history).
          contextUsedPercent: typeof v.contextUsedPercent === "number"
            ? v.contextUsedPercent
            : null,
        },
      };
      continue;
    }
    if (key.startsWith("tickStatus:")) {
      const v = e.value as Record<string, unknown>;
      const accTokenIn = typeof v.accTokenIn === "number" ? v.accTokenIn
        : typeof v.accIn === "number" ? v.accIn : 0;
      const accTokenCachedIn = typeof v.accTokenCachedIn === "number" ? v.accTokenCachedIn
        : typeof v.accCached === "number" ? v.accCached : 0;
      const accTokenTotalIn = typeof v.accTokenTotalIn === "number" ? v.accTokenTotalIn : 0;
      // Backfill accTokenHitRate for legacy rows (zero-denominator → 0).
      const accTokenHitRate = typeof v.accTokenHitRate === "number"
        ? v.accTokenHitRate
        : accTokenTotalIn > 0 ? (accTokenCachedIn / accTokenTotalIn) * 100 : 0;
      out[key] = {
        at: e.at,
        kind: "tickStatus",
        value: {
          accTokenIn,
          accTokenOut: typeof v.accTokenOut === "number" ? v.accTokenOut
            : typeof v.accOut === "number" ? v.accOut : 0,
          accTokenCachedIn,
          accTokenTotalIn,
          accApiMs: typeof v.accApiMs === "number" ? v.accApiMs : 0,
          accApiCalls: typeof v.accApiCalls === "number" ? v.accApiCalls
            : typeof v.accApiCount === "number" ? v.accApiCount : 0,
          accTokenHitRate,
          // Legacy rows read as null → start:n/a until the next valid write.
          startAt: typeof v.startAt === "number" ? v.startAt : null,
          // Backfill costs from legacy rows.
          costs: coerceCostsArray(v.costs),
        },
      };
    }
  }
  return out;
}

function loadStoreFromPath(path: string, cwd: string): Store | null {
  logFsRead(path, "status-store.loadFromDisk", undefined, cwd, "statusStore");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseStore(raw);
}

function loadFromDiskInternal(cwd: string): Store {
  const cached = _stores.get(cwd);
  if (cached) return cached;
  if (_loaded.has(cwd)) {
    const empty: Store = {};
    _stores.set(cwd, empty);
    return empty;
  }
  _loaded.add(cwd);

  const primaryPath = _pathResolver(cwd);
  let store = loadStoreFromPath(primaryPath, cwd);
  if (store == null) store = {};
  _stores.set(cwd, store);
  return store;
}

function flushToDiskInternal(cwd: string, store: Store): void {
  const path = _pathResolver(cwd);
  const dir = dirname(path);
  logFsMkdir(dir, "status-store.flushToDisk", cwd, "statusStore");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    process.stderr.write("creditgauge: state mkdir failed; in-memory only\n");
    return;
  }
  const payload = JSON.stringify(store);
  logFsWrite(path, "status-store.flushToDisk", payload.length, cwd, "statusStore");
  try {
    writeFileSync(path, payload);
  } catch {
    process.stderr.write("creditgauge: state write failed; in-memory only\n");
    return;
  }
  _stores.set(cwd, store);
}

export function loadFromDisk(cwd: string): Store {
  return loadFromDiskInternal(cwd);
}

export function flushToDisk(cwd: string, store: Store): void {
  flushToDiskInternal(cwd, store);
}

export function emptyTickStatus(): TickStatusValue {
  return {
    accTokenIn: 0,
    accTokenOut: 0,
    accTokenCachedIn: 0,
    accTokenTotalIn: 0,
    accApiMs: 0,
    accApiCalls: 0,
    accTokenHitRate: 0,
    // "No writes yet" sentinel; stamped with Date.now() on first valid write.
    startAt: null,
    costs: [],
  };
}

export function emptyPrevTickStatus(): PrevTickStatusValue {
  return {
    totalApiMs: 0,
    // Zero sentinel for "no prior measurement"; next active tick writes the real value.
    totalDurationMs: 0,
    sessionId: null,
    cwd: null,
    model: null,
    // null = no prior history; beginTick substitutes only when prev is non-null.
    contextUsedPercent: null,
  };
}

function makeEntry(key: string, value: Entry["value"]): Entry {
  if (key === PREV_TICK_KEY) {
    return { at: Date.now(), kind: "prevTickStatus", value: value as PrevTickStatusValue };
  }
  if (
    key === "lastActive:in" ||
    key === "lastActive:out" ||
    key === "lastActive:apiMs" ||
    key === "lastActive:tokenHitRate"
  ) {
    return { at: Date.now(), kind: "lastActive", value: value as LastActiveValue };
  }
  if (key.startsWith("tickStatus:")) {
    return { at: Date.now(), kind: "tickStatus", value: value as TickStatusValue };
  }
  throw new Error(
    `status-store: unknown key "${key}" — must be ${PREV_TICK_KEY}, ` +
      `tickStatus:<dim>, or lastActive:<in|out|apiMs|tokenHitRate>`,
  );
}

function activeStoreFor(cwd: string | null | undefined): Store | null {
  if (_tickState) {
    if (_tickState.cwd == null) return _tickState.pending;
    if (cwd == null) return _tickState.pending;
    if (_tickState.cwd === cwd) return _tickState.pending;
  }
  if (cwd) return loadFromDiskInternal(cwd);
  return null;
}

export function readTickStatus(
  cwd: string | null | undefined,
  key: string,
): TickStatusValue | null {
  const store = activeStoreFor(cwd);
  if (!store) return null;
  const e = store[key];
  if (!e || e.kind !== "tickStatus") return null;
  return e.value;
}

export function writeTickStatus(
  cwd: string | null | undefined,
  key: string,
  value: TickStatusValue,
): void {
  if (!cwd) return;
  const store = cloneStore(loadFromDiskInternal(cwd));
  store[key] = { at: Date.now(), kind: "tickStatus", value };
  // Also seed the in-memory pending map so a subsequent processTick /
  // beginTickForTest(null, null) read path sees the write without a
  // fresh load-from-disk.
  if (_tickState) {
    _tickState.pending[key] = { at: Date.now(), kind: "tickStatus", value };
    _tickState.dirty = true;
  }
  flushToDiskInternal(cwd, store);
}

export function readPrevTickStatus(
  cwd: string | null | undefined,
): PrevTickStatusValue | null {
  const store = activeStoreFor(cwd);
  if (!store) return null;
  const e = store[PREV_TICK_KEY];
  if (!e || e.kind !== "prevTickStatus") return null;
  return e.value;
}

export function writePrevTickStatus(
  cwd: string | null | undefined,
  value: PrevTickStatusValue,
): void {
  if (!cwd) return;
  const store = cloneStore(loadFromDiskInternal(cwd));
  store[PREV_TICK_KEY] = { at: Date.now(), kind: "prevTickStatus", value };
  // Also seed pending so setPrevTick → beginTickForTest keeps the seed.
  if (_tickState) {
    _tickState.pending[PREV_TICK_KEY] = {
      at: Date.now(),
      kind: "prevTickStatus",
      value,
    };
    _tickState.dirty = true;
  }
  flushToDiskInternal(cwd, store);
}

// Declared for future opt-in; the read path no longer compares against it.
export const LAST_ACTIVE_TTL_MS = 60_000;
// Sanity ceiling on the per-tick apiMs sample: values at or above this
// bound are rejected so a pathological stdin reading (clock skew,
// provider bug, stale baseline) can't pollute the JSONL stream / the
// accApiMs sum. NOT a fetch timeout (that's config-driven in index.ts
// via AbortSignal.timeout). 5min — above any realistic per-tick call
// (typically <60s), below the 10min "pathological" marker.
export const MAX_SAMPLE_API_MS = 300_000;

export function readLastActive(
  cwd: string | null | undefined,
  direction: "in" | "out" | "apiMs" | "tokenHitRate",
): number | null {
  const store = activeStoreFor(cwd);
  if (!store) return null;
  const e = store[`lastActive:${direction}`];
  if (!e || e.kind !== "lastActive") return null;
  return Number.isFinite(e.value.tps) ? e.value.tps : null;
}

export function writeLastActive(
  cwd: string | null | undefined,
  direction: "in" | "out" | "apiMs" | "tokenHitRate",
  tps: number,
): void {
  if (!cwd) return;
  const store = cloneStore(loadFromDiskInternal(cwd));
  store[`lastActive:${direction}`] = {
    at: Date.now(),
    kind: "lastActive",
    value: { direction, tps },
  };
  flushToDiskInternal(cwd, store);
}

// ----- Sample JSONL ownership --------------------------------------------------

export function appendSample(
  cwd: string,
  sessionId: string,
  sample: TokenSample,
): void {
  const path = sampleFilePath(cwd, sessionId);
  const dir = dirname(path);
  logFsMkdir(dir, "status-store.appendSample", cwd, "statusStore");
  try {
    mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify(sample) + "\n";
    logFsWrite(path, "status-store.appendSample", payload.length, cwd, "statusStore");
    appendFileSync(path, payload, "utf8");
  } catch {
    process.stderr.write("creditgauge: token-sample append failed\n");
  }
}

function coerceSampleRow(r: Record<string, unknown>, sinceMs: number): TokenSample | null {
  if (
    typeof r.at !== "number" ||
    r.at < sinceMs ||
    typeof r.totalIn !== "number" ||
    typeof r.totalOut !== "number"
  ) {
    return null;
  }
  return {
    at: r.at,
    totalIn: r.totalIn,
    totalOut: r.totalOut,
    in: typeof r.in === "number" ? r.in : 0,
    out: typeof r.out === "number" ? r.out : 0,
    cacheCreation: typeof r.cacheCreation === "number" ? r.cacheCreation : 0,
    cacheIn: typeof r.cacheIn === "number" ? r.cacheIn : 0,
    cost:
      r.cost != null &&
      typeof r.cost === "object" &&
      typeof (r.cost as Record<string, unknown>).currency === "string" &&
      typeof (r.cost as Record<string, unknown>).value === "string"
        ? {
            currency: (r.cost as Record<string, unknown>).currency as string,
            value: (r.cost as Record<string, unknown>).value as string,
          }
        : undefined,
    model: typeof r.model === "string" ? r.model : undefined,
    base_url: typeof r.base_url === "string" ? r.base_url : undefined,
    totalApiMs: typeof r.totalApiMs === "number" ? r.totalApiMs : undefined,
    apiMs: typeof r.apiMs === "number" ? r.apiMs : undefined,
    prevApiMs:
      r.prevApiMs === null
        ? null
        : typeof r.prevApiMs === "number"
          ? r.prevApiMs
          : undefined,
  };
}

export function readSamples(
  cwd: string,
  sessionId: string,
  sinceMs: number,
  modelFilter?: string,
): TokenSample[] {
  const path = sampleFilePath(cwd, sessionId);
  logFsRead(path, "status-store.readSamples", undefined, cwd, "statusStore");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: TokenSample[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const sample = coerceSampleRow(parsed as Record<string, unknown>, sinceMs);
    if (!sample) continue;
    if (modelFilter !== undefined && sample.model !== modelFilter) continue;
    out.push(sample);
  }
  return out;
}

export function readAllSamples(sinceMs: number): TokenSample[] {
  const root = stateRoot();
  const out: TokenSample[] = [];
  logFsList(root, "status-store.readAllSamples", undefined, "statusStore");
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root);
  } catch {
    return [];
  }
  for (const projDir of projectDirs) {
    const projPath = join(root, projDir);
    logFsStat(projPath, "status-store.readAllSamples", undefined, "statusStore");
    let st;
    try {
      st = statSync(projPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    logFsList(projPath, "status-store.readAllSamples", undefined, "statusStore");
    let sessions: string[];
    try {
      sessions = readdirSync(projPath);
    } catch {
      continue;
    }
    for (const f of sessions) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(projPath, f);
      if (sinceMs > 0) {
        logFsStat(path, "status-store.readAllSamples", undefined, "statusStore");
        let fst;
        try {
          fst = statSync(path);
        } catch {
          continue;
        }
        if (fst.mtimeMs < sinceMs) continue;
      }
      logFsRead(path, "status-store.readAllSamples", undefined, undefined, "statusStore");
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object") continue;
        const sample = coerceSampleRow(parsed as Record<string, unknown>, sinceMs);
        if (!sample) continue;
        out.push(sample);
      }
    }
  }
  return out;
}

// ----- Cold-slot JSONL replay -----
// When state.json is missing (fresh install / :clean --purge-runtime),
// setAvg's first write would seed each tickStatus slot from the current
// tick's delta only — a misleading acc:0 followed by a one-tick blip.
// This block mirrors the m_sum* pattern (readAllSamples / stat-cache
// TTL) for the persistent m_acc* scopes (session / project / model).
// Replay runs in processTick Stage 0, before setAvg mutates the slot:
//   - valid ticks: setAvg merges this tick's delta on top of the base
//   - invalid ticks: the recovered base flushes standalone (no bad row)
//   - render sees the value via the existing pending read path

function replayAccKey(
  scope: "session" | "project" | "model",
  args: {
    sessionId?: string | null;
    cwd?: string | null;
    // stdin.model.id for scope=model slot key.
    modelId?: string | null;
  },
): string | null {
  if (scope === "session") {
    if (!args.sessionId) return null;
    return `tickStatus:${args.sessionId}`;
  }
  if (scope === "project") {
    if (!args.cwd) return null;
    return `tickStatus:${projectHash(args.cwd)}`;
  }
  // scope === "model"
  if (!args.modelId) return null;
  return `tickStatus:${args.modelId}`;
}

// Read-once per-scope JSONL walk:
//   session → one <sessionId>.jsonl; project → every *.jsonl under the
//   projectHash dir; model → that set filtered by sample.model.
// sinceMs=0 → no time cutoff (full history).
function readReplaySamples(
  scope: "session" | "project" | "model",
  args: {
    sessionId?: string | null;
    cwd?: string | null;
    // JSONL rows stamp stdin.model.id; filter compares against it.
    modelId?: string | null;
  },
): TokenSample[] {
  if (scope === "session") {
    if (!args.sessionId || !args.cwd) return [];
    return readSamples(args.cwd, args.sessionId, 0);
  }
  // project / model — read per-project; readAllSamples would conflate
  // projects sharing the state root.
  if (!args.cwd) return [];
  const all = readProjectSamples(args.cwd, 0);
  if (scope === "project") return all;
  // scope === "model"
  if (!args.modelId) return [];
  return all.filter((s) => s.model === args.modelId);
}

// Mirrors readAllSamples' walk but visits only the one projectHash subdir.
function readProjectSamples(cwd: string, sinceMs: number): TokenSample[] {
  const dir = join(stateRoot(), projectHash(cwd));
  logFsList(dir, "status-store.readProjectSamples", undefined, "statusStore");
  const out: TokenSample[] = [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const path = join(dir, f);
    if (sinceMs > 0) {
      logFsStat(path, "status-store.readProjectSamples", undefined, "statusStore");
      let fst;
      try {
        fst = statSync(path);
      } catch {
        continue;
      }
      if (fst.mtimeMs < sinceMs) continue;
    }
    logFsRead(path, "status-store.readProjectSamples", undefined, undefined, "statusStore");
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const sample = coerceSampleRow(parsed as Record<string, unknown>, sinceMs);
      if (!sample) continue;
      out.push(sample);
    }
  }
  return out;
}

// Cold-slot replay: returns a TickStatusValue to mark() into pending,
// or null when the slot is warm (startAt set), JSONL has no matching
// rows, or the slot key can't be built (missing ids).
export function replayAccInit(
  scope: "session" | "project" | "model",
  args: {
    sessionId?: string | null;
    cwd?: string | null;
    modelId?: string | null;
  },
): TickStatusValue | null {
  const key = replayAccKey(scope, args);
  if (!key) return null;
  // Warm-slot short-circuit (reads pending first to avoid a same-tick
  // "warmed, now cold again" race).
  const existing = readTickStatus(args.cwd, key);
  if (existing && existing.startAt != null) return null;

  const samples = readReplaySamples(scope, args);
  if (samples.length === 0) return null;

  // Aggregate the same fields setAvg writes (mapped to TickStatusValue
  // names). accTokenTotalIn sums per-row deltas (sumIn + sumCached).
  let accTokenIn = 0;
  let accTokenOut = 0;
  let accTokenCachedIn = 0;
  let accTokenTotalIn = 0;
  let accApiMs = 0;
  let accApiCalls = 0;
  let firstAt = Number.POSITIVE_INFINITY;
  const costsMap = new Map<string, number>();
  for (const s of samples) {
    accTokenIn += s.in;
    accTokenOut += s.out;
    accTokenCachedIn += s.cacheIn;
    accTokenTotalIn += s.in + s.cacheIn;
    accApiMs += s.apiMs ?? 0;
    if ((s.apiMs ?? 0) > 0) accApiCalls += 1;
    // firstAt = min(s.at), matching aggregateSamples.
    const candidate = (Number.isFinite(s.at) && s.at > 0) ? s.at : null;
    if (candidate != null && candidate < firstAt) firstAt = candidate;
    // Accumulate cost by currency from the JSONL samples.
    if (s.cost) {
      const prev = costsMap.get(s.cost.currency) ?? 0;
      costsMap.set(s.cost.currency, prev + parseFloat(s.cost.value));
    }
  }
  if (!Number.isFinite(firstAt)) firstAt = Date.now();

  // Build the costs array from the map.
  const costs: Array<{ currency: string; value: string }> = [];
  for (const [currency, total] of costsMap) {
    costs.push({ currency, value: total.toFixed(10) });
  }

  return {
    accTokenIn,
    accTokenOut,
    accTokenCachedIn,
    accTokenTotalIn,
    accApiMs,
    accApiCalls,
    accTokenHitRate: accTokenTotalIn > 0
      ? (accTokenCachedIn / accTokenTotalIn) * 100
      : 0,
    startAt: firstAt,
    costs,
  };
}

// ----- Stat cache ownership ----------------------------------------------------

const _statCacheStore = new Map<string, StatCacheEntry<unknown>>();
let _statCacheLoaded = false;

function loadStatCacheFromDisk(): void {
  if (_statCacheLoaded) return;
  _statCacheLoaded = true;
  const path = _statCachePathResolver();
  logFsRead(path, "status-store.loadStatCache", undefined, null, "statCache");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write("creditgauge: stat cache file is malformed; ignoring\n");
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const e = value as { at?: unknown; value?: unknown; ttlMs?: unknown };
    if (typeof e.at !== "number" || !("value" in e)) continue;
    const ttlMs = typeof e.ttlMs === "number" && e.ttlMs > 0 ? e.ttlMs : undefined;
    _statCacheStore.set(key, { at: e.at, value: e.value, ttlMs });
  }
}

function flushStatCacheToDisk(): void {
  const path = _statCachePathResolver();
  const dir = dirname(path);
  logFsMkdir(dir, "status-store.flushStatCache", null, "statCache");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    process.stderr.write("creditgauge: stat cache mkdir failed; in-memory only\n");
    return;
  }
  const now = Date.now();
  const obj: Record<string, StatCacheEntry<unknown>> = {};
  for (const [k, v] of _statCacheStore) {
    if (v.ttlMs != null && now - v.at > v.ttlMs) {
      _statCacheStore.delete(k);
      continue;
    }
    obj[k] = v;
  }
  const payload = JSON.stringify(obj);
  logFsWrite(path, "status-store.flushStatCache", payload.length, null, "statCache");
  try {
    writeFileSync(path, payload);
  } catch {
    process.stderr.write("creditgauge: stat cache write failed; in-memory only\n");
  }
}

function getStatCache<T>(key: string, ttlMs: number): T | null {
  loadStatCacheFromDisk();
  const e = _statCacheStore.get(key) as StatCacheEntry<T> | undefined;
  if (!e) return null;
  if (Date.now() - e.at > ttlMs) return null;
  return e.value;
}

function setStatCache<T>(key: string, value: T, ttlMs: number): void {
  loadStatCacheFromDisk();
  _statCacheStore.set(key, { at: Date.now(), value, ttlMs });
  flushStatCacheToDisk();
}

// TTL-ignoring peek for one stat-cache key: null on miss, never on
// expiry (so render can show "past TTL, refreshes next tick").
export function peekStatAgeMs(key: string): { ageMs: number; ttlMs: number } | null {
  loadStatCacheFromDisk();
  const e = _statCacheStore.get(key) as StatCacheEntry<unknown> | undefined;
  if (!e) return null;
  return { ageMs: Date.now() - e.at, ttlMs: e.ttlMs ?? 0 };
}

// TTL-ignoring peek for the freshest entry across all stat-cache keys
// (the cache can hold many model/window/align rows).
export function peekFreshestStatAgeMs(): { ageMs: number; ttlMs: number } | null {
  loadStatCacheFromDisk();
  let best: { at: number; ageMs: number; ttlMs: number } | null = null;
  for (const e of _statCacheStore.values()) {
    if (best == null || e.at > best.at) {
      best = { at: e.at, ageMs: Date.now() - e.at, ttlMs: e.ttlMs ?? 0 };
    }
  }
  return best ? { ageMs: best.ageMs, ttlMs: best.ttlMs } : null;
}

// Test seam: seed stat-cache rows without the readAllSamples scan path.
export function setStatCacheForTest<T>(key: string, value: T, ttlMs: number): void {
  setStatCache(key, value, ttlMs);
}

// Test seam: backdate a seeded row to simulate aging without
// monkey-patching Date.now.
export function setStatCacheAtForTest(key: string, at: number): void {
  const e = _statCacheStore.get(key);
  if (!e) throw new Error(`setStatCacheAtForTest: key "${key}" not found`);
  _statCacheStore.set(key, { at, value: e.value, ttlMs: e.ttlMs });
}

export function __resetStatCacheForTest(): void {
  _statCacheStore.clear();
  _statCacheLoaded = false;
}

function aggregateSamples(samples: TokenSample[]): StatAggregate {
  let sumIn = 0;
  let sumOut = 0;
  let sumCached = 0;
  let sumApiMs = 0;
  let lastAt = 0;
  // tracks min(s.at) over filtered rows, symmetric with
  // lastAt = max(s.at). firstAt <= 0 triggers the placeholder.
  let firstAt = Number.POSITIVE_INFINITY;
  let calls = 0;
  const costsMap = new Map<string, number>();
  for (const s of samples) {
    sumIn += s.in;
    sumOut += s.out;
    sumCached += s.cacheIn;
    sumApiMs += s.apiMs ?? 0;
    if ((s.apiMs ?? 0) > 0) calls += 1;
    if (s.at > lastAt) lastAt = s.at;
    if (
      Number.isFinite(s.at) &&
      s.at > 0 &&
      s.at < firstAt
    ) {
      firstAt = s.at;
    }
    // Accumulate cost by currency.
    if (s.cost) {
      const prev = costsMap.get(s.cost.currency) ?? 0;
      costsMap.set(s.cost.currency, prev + parseFloat(s.cost.value));
    }
  }
  if (!Number.isFinite(firstAt)) firstAt = 0;
  const costs: Array<{ currency: string; value: string }> = [];
  for (const [currency, total] of costsMap) {
    costs.push({ currency, value: total.toFixed(10) });
  }
  return {
    sumIn,
    sumOut,
    sumCached,
    sumTotalIn: sumIn + sumCached,
    sumApiMs,
    rows: samples.length,
    calls,
    lastAt,
    firstAt,
    generatedAt: Date.now(),
    costs,
  };
}

// Single source of truth for the stat-cache key string (mirrors
// getStatAggregate's composer — MUST stay in sync with it).
export function statKeyForFilter(filter: SumFilter): string {
  const base = `stat:${filter.modelFilter ?? "all"}:${filter.windowKey}:${(filter as { alignActive?: boolean }).alignActive ?? false}`;
  return filter.providerBaseUrl ? `${base}:${filter.providerBaseUrl}` : base;
}

export function getStatAggregate(filter: SumFilter): StatAggregate {
  // `:alignActive` segment: align=true (declared windowId) and
  // align=false (dhms/"all") scans can land different sinceMs on the
  // same windowKey literal, so bucketing along align keeps the two
  // readings in disjoint cache slots. Free-form dhms values
  // (alignActive=false) mint their own entries via the literal key.
  const key = statKeyForFilter(filter);
  const cached = getStatCache<StatAggregate>(key, STAT_CACHE_TTL_MS);
  if (cached) return cached;
  const samples = readAllSamples(filter.sinceMs);
  const filtered =
    filter.modelFilter === undefined
      ? samples
      : samples.filter((s) => s.model === filter.modelFilter);
  // Default provider filter: only rows whose base_url matches ANTHROPIC_BASE_URL.
  const providerFiltered =
    filter.providerBaseUrl === undefined
      ? filtered
      : filtered.filter((s) => s.base_url === filter.providerBaseUrl);
  const agg = aggregateSamples(providerFiltered);
  // On an aligned scan (alignActive=true), stamp the plan window's
  // used% onto the aggregate (read defensively off the structurally-
  // passed filter.interval).
  const f = filter as SumFilter & {
    alignActive?: boolean;
    interval?: { usedPercent?: number | null; remainingPercent?: number | null } | null;
  };
  if (f.alignActive === true && f.interval != null) {
    agg.alignedUsedPercent = intervalUsedPercent(f.interval);
  }
  setStatCache(key, agg, STAT_CACHE_TTL_MS);
  return agg;
}

// Mirror of render.ts's used%-pick rule: used% wins, else 100 -
// remaining%, else null. Kept here to avoid a status-store → render dep.
function intervalUsedPercent(
  iv: { usedPercent?: number | null; remainingPercent?: number | null },
): number | null {
  if (iv.usedPercent != null) {
    return Math.max(0, Math.min(100, iv.usedPercent));
  }
  if (iv.remainingPercent != null) {
    return Math.max(0, Math.min(100, 100 - iv.remainingPercent));
  }
  return null;
}

// ----- In-memory tick state ----------------------------------------------------

let _tickState: TickState | null = null;

// The prev cursor carries only totalApiMs (baseline for apiMs).
// Detection is purely numeric — a backward roll means the cc process
// restarted; sessionId identity plays no part.
function resolvePreviousBaseline(
  tokens: TokenSnapshot | null,
  prev: PrevTickStatusValue | null,
): { prevTotalApiMs: number | null } {
  if (!tokens?.sessionId || !prev) {
    return { prevTotalApiMs: null };
  }
  return { prevTotalApiMs: prev.totalApiMs };
}

// stdin-side error guard for context_window.used_percentage: a 0 from
// an error-state stdin would render as a misleading "0%". Substitute
// prev when stdin reports 0 and prev is non-null; null/positive stdin
// passes through. Substitutes tokens.contextWindow.contextUsedPercent
// in place (m_contextUsedPercent reads that path verbatim).
function applyContextUsedPercentCarryOver(
  tokens: TokenSnapshot,
  prev: PrevTickStatusValue | null,
): void {
  const cw = tokens.contextWindow;
  if (!cw) return;
  const stdinPct = cw.contextUsedPercent;
  if (stdinPct === null || stdinPct === undefined) return;
  if (stdinPct !== 0) return;
  // stdin reports 0 — only substitute when prev has a real prior value.
  if (prev && prev.contextUsedPercent !== null) {
    tokens.contextWindow = {
      ...cw,
      contextUsedPercent: prev.contextUsedPercent,
    };
  }
}

// Regression detection: a backward totalDurationMs jump (stdin
// cost.total_duration_ms — the cc process wall-clock, monotonic per
// tick, even when idle) means the cc process restarted. Guards:
//   1. 120s cold-start — a fresh process's small totalDurationMs is
//      compared against a prior process's baseline; suppress the false
//      fire (the baseline is replaced before the next tick anyway).
//   2. contextUsedPercent===0 stdin-error guard — a malformed probe can
//      roll totalDurationMs backward; suppress unless carry-over has
//      already substituted a non-zero prev value.
// Identity (sessionId/cwd) is NOT part of the check — it would miss the
// common "ran a different cc command" restart.
const COLD_START_THRESHOLD_MS = 120_000;

function detectRegression(
  tokens: TokenSnapshot | null,
  prev: PrevTickStatusValue | null,
): boolean {
  if (!tokens?.sessionId || !prev) return false;
  const currentTotalDurationMs = tokens.cost?.totalDurationMs;
  if (currentTotalDurationMs == null
      || !Number.isFinite(currentTotalDurationMs)) return false;
  // Cold-start guard: suppress false fires on a fresh cc process.
  if (currentTotalDurationMs < COLD_START_THRESHOLD_MS) return false;
  // stdin-error guard for contextUsedPercent — see block comment above.
  const cw = tokens.contextWindow;
  if (cw && cw.contextUsedPercent === 0) return false;
  return currentTotalDurationMs < prev.totalDurationMs;
}

function normalizeTick(
  tokens: TokenSnapshot | null,
  prev: PrevTickStatusValue | null,
  provider: string | null,
): { snapshot: CurrentTick | null; measurement: TickSnapshot } {
  if (!tokens || !tokens.sessionId || !tokens.cwd) {
    return { snapshot: null, measurement: EMPTY_TICK };
  }
  // stdin-side error guard for context_window.used_percentage (in-place
  // mutation; render reads the same reference). See applyContextUsedPercentCarryOver.
  applyContextUsedPercentCarryOver(tokens, prev);
  const in_ = tokens.current.tokenIn;
  const out_ = tokens.current.tokenOut;
  const totalApiMs = tokens.cost.totalApiDurationMs;
  const totalIn = tokens.totals.tokenTotalIn ?? null;
  const totalOut = tokens.totals.tokenTotalOut ?? null;
  if (
    in_ == null ||
    !Number.isFinite(in_) ||
    out_ == null ||
    !Number.isFinite(out_) ||
    totalApiMs == null ||
    !Number.isFinite(totalApiMs) ||
    totalIn == null ||
    totalOut == null
  ) {
    return { snapshot: null, measurement: EMPTY_TICK };
  }

  const { prevTotalApiMs } = resolvePreviousBaseline(tokens, prev);
  // Regression detection is purely numerical (see detectRegression).
  const invalidRegression = detectRegression(tokens, prev);
  // apiMs is THE unique cross-tick delta. With no prev baseline (first
  // tick after install/cache wipe), back-derive from tokenOut via the
  // legacy v0.4.x formula: tokenOut * 1000 / 50 (50 t/s fall-back rate).
  const apiMs = invalidRegression || prevTotalApiMs === null
      ? (out_ * 1000) / 50
      : totalApiMs - prevTotalApiMs;
  const cachedIn = tokens.current.tokenCachedIn ?? 0;
  const hasCachedIn = tokens.current.tokenCachedIn != null;
  // Validation gate (user contract): totalOut > 0 && apiMs > 0. totalIn
  // is deliberately excluded — a cache-read-only tick can have totalIn
  // == 0 and still be a real measurement.
  const valid = totalOut > 0 && apiMs > 0;
  const tokenHitRate =
    totalIn > 0 ? (cachedIn / totalIn) * 100 : null;
  const tokenInSpeed = apiMs > 0 ? (in_ / apiMs) * 1000 : null;
  const tokenOutSpeed = apiMs > 0 ? (out_ / apiMs) * 1000 : null;

  // Per-tick cost (stdin deltas × tokenPrices via the 5-layer cascade),
  // resolved at processTick time so the value is frozen in the sample
  // and accumulator. null when no price entry matches.
  let cost: { currency: string; value: string } | null = null;
  const modelId = tokens.modelId ?? null;
  if (modelId) {
    const tp = resolveTokenPrice(configStore.get(), provider, modelId);
    if (tp && tp.in + tp.out + tp.cachedIn > 0) {
      const raw = (in_ * tp.in + out_ * tp.out + cachedIn * tp.cachedIn) / 1_000_000;
      cost = { currency: tp.currency, value: raw.toFixed(10) };
    }
  }

  // Env-gated full-snapshot smoke row (default off) for postmortem
  // confirmation of the pre-compute math.
  if (isSubkeyEnabled("smokeNormalizeTick")) {
    appendDiag(
      "info",
      "smoke-normalizeTick",
      `invalidRegression=${invalidRegression} valid=${valid} totalApiMs=${totalApiMs} apiMs=${apiMs.toFixed(3)} in=${in_} out=${out_} cachedIn=${cachedIn} totalIn=${totalIn} totalOut=${totalOut} tokenHitRate=${tokenHitRate?.toFixed(2) ?? "null"} tokenInSpeed=${tokenInSpeed?.toFixed(2) ?? "null"} tokenOutSpeed=${tokenOutSpeed?.toFixed(2) ?? "null"} sid=${tokens?.sessionId ?? "null"}`,
      Date.now(),
      tokens?.cwd ?? undefined,
      "status-store.normalizeTick",
    );
  }

  const measurement: TickSnapshot = {
    hasMeasurement: valid,
    in: valid ? in_ : 0,
    out: valid ? out_ : 0,
    cachedIn: valid && hasCachedIn ? cachedIn : 0,
    totalIn: totalIn ?? 0,
    totalOut: totalOut ?? 0,
    totalApiMs,
    apiMs: valid ? apiMs : 0,
    // Always populated so idle ticks can STALE_COLOR the last-known
    // cost (render reads r.cost before checking hasMeasurement).
    cost,
  };

  return {
    snapshot: {
      sessionId: tokens.sessionId,
      cwd: tokens.cwd,
      // stdin.model.id — per-model slot key + sample.model stamp.
      modelId: tokens.modelId ?? null,
      in: in_,
      out: out_,
      cachedIn,
      hasCachedIn,
      cacheCreation: tokens.current.tokenCacheCreation ?? 0,
      totalIn,
      totalOut,
      totalApiMs,
      apiMs,
      prevTotalApiMs,
      invalidRegression,
      tokenHitRate,
      tokenInSpeed,
      tokenOutSpeed,
      cost,
    },
    measurement,
  };
}

function validateNormalizedTick(tick: CurrentTick | null): boolean {
  if (!tick) return false;
  // Validation gate (per user contract): totalOut > 0 && apiMs > 0,
  // plus the MAX_SAMPLE_API_MS sanity ceiling (apiMs <= 5min; rejects
  // clock-skew / provider-bug readings that would pollute the JSONL).
  return (tick.totalOut ?? 0) > 0 && tick.apiMs > 0 && tick.apiMs <= MAX_SAMPLE_API_MS;
}

export function beginTick(cwd: string | null, tokens: TokenSnapshot | null): TickState {
  const loaded = cwd ? loadFromDiskInternal(cwd) : {};
  const prevEntry = loaded[PREV_TICK_KEY];
  const prev = prevEntry?.kind === "prevTickStatus" ? prevEntry.value : null;
  // Provider unknown at beginTick (pre-matchProvider): pass null so the
  // gate uses config.tokenPrices.json; processTick re-runs it later.
  const { snapshot, measurement } = normalizeTick(tokens, prev, null);
  _tickState = {
    cwd,
    tokens,
    loaded,
    pending: cloneStore(loaded),
    dirty: false,
    prevTick: prev,
    valid: validateNormalizedTick(snapshot),
    measurement,
    snapshot,
    sample: null,
  };
  return _tickState;
}

export function getState(): TickState {
  if (!_tickState) {
    throw new Error(
      "status-store: getState() called without beginTick() — every render must be wrapped in a tick",
    );
  }
  return _tickState;
}

export function mark(key: string, value: Entry["value"]): void {
  const s = getState();
  s.pending[key] = makeEntry(key, value);
  s.dirty = true;
}

export function commit(): void {
  const s = _tickState;
  if (!s) return;
  if (!s.cwd) return;
  // Flush on dirty regardless of `valid` — the gate governs sample-row
  // emission only. At most one full-file rewrite per tick (invariant).
  if (!s.dirty) return;
  flushToDiskInternal(s.cwd, s.pending);
}

export function resetTickStateForTest(): void {
  _tickState = null;
}

export function beginTickForTest(
  cwd: string | null = null,
  tokens: TokenSnapshot | null = null,
): TickState {
  beginTick(cwd, tokens);
  _tickState!.dirty = false;
  return _tickState!;
}

// ----- Render/query helpers ----------------------------------------------------

// Returns just the prev-cursor (the one field the next tick subtracts
// against). Identity mismatch (different sessionId) → null.
export type PrevTickSnapshot = {
  totalApiMs: number;
};

export function peekPrevTick(
  sessionId: string,
  cwd?: string | null,
): PrevTickSnapshot | null {
  const prev = readPrevTickStatus(cwd);
  if (!prev) return null;
  if (prev.sessionId !== null && prev.sessionId !== sessionId) return null;
  return { totalApiMs: prev.totalApiMs };
}

export function peekLastSpeed(
  _sessionId: string,
  direction: "in" | "out",
  cwd?: string | null,
): number | null {
  void _sessionId;
  return readLastActive(cwd, direction);
}

export function peekLastApiMs(
  _sessionId: string,
  cwd?: string | null,
): number | null {
  void _sessionId;
  return readLastActive(cwd, "apiMs");
}

export function peekLastTokenHitRate(
  _sessionId: string,
  cwd?: string | null,
): number | null {
  void _sessionId;
  return readLastActive(cwd, "tokenHitRate");
}

export function peekAvg(
  sessionId: string,
  cwd?: string | null,
): AvgSnapshot | null {
  if (!sessionId) return null;
  const v = readTickStatus(cwd, `tickStatus:${sessionId}`);
  if (!v) return null;
  return {
    accTokenIn: v.accTokenIn,
    accTokenOut: v.accTokenOut,
    accApiMs: v.accApiMs,
    accTokenCachedIn: v.accTokenCachedIn,
    accApiCalls: v.accApiCalls,
    accTokenTotalIn: v.accTokenTotalIn,
    accTokenHitRate: v.accTokenHitRate,
    // v0.8.24+ — propagated from TickStatusValue.startAt.
    startAt: v.startAt ?? null,
    costs: v.costs ?? [],
  };
}

export function readAccumulator(
  scope: "session" | "project" | "model",
  args: {
    sessionId?: string | null;
    cwd?: string | null;
    // stdin.model.id — per-model slot key.
    modelId?: string | null;
  },
): AvgSnapshot | null {
  let key: string | null = null;
  if (scope === "session") {
    if (!args.sessionId) return null;
    key = `tickStatus:${args.sessionId}`;
  } else if (scope === "project") {
    if (!args.cwd) return null;
    key = `tickStatus:${projectHash(args.cwd)}`;
  } else {
    if (!args.modelId) return null;
    key = `tickStatus:${args.modelId}`;
  }
  const v = readTickStatus(args.cwd, key);
  if (!v) return null;
  return {
    accTokenIn: v.accTokenIn,
    accTokenOut: v.accTokenOut,
    accApiMs: v.accApiMs,
    accTokenCachedIn: v.accTokenCachedIn,
    accApiCalls: v.accApiCalls,
    accTokenTotalIn: v.accTokenTotalIn,
    accTokenHitRate: v.accTokenHitRate,
    // v0.8.24+ — propagated from TickStatusValue.startAt.
    startAt: v.startAt ?? null,
    costs: v.costs ?? [],
  };
}

// Render-facing accessor: the current tick's snapshot + derived apiMs
// (EMPTY_TICK when no tick is active).
export function getDeltaForRender(): TickSnapshot {
  return _tickState?.measurement ?? EMPTY_TICK;
}

// ----- Write-side helpers -----

export function computeAndCacheTickDeltaPure(
  tokens: TokenSnapshot | null,
): TickSnapshot {
  const prev = _tickState?.prevTick ?? null;
  // Outside the normal tick pipeline (no provider context): pass null so
  // cost resolution uses config.tokenPrices.json without overrides.
  return normalizeTick(tokens, prev, null).measurement;
}

// setPrevTick stamps only totalApiMs (the field the next tick subtracts
// for apiMs); identity is preserved for peekPrevTick's mismatch guard.
// totalDurationMs joins the cursor for detectRegression — the snap
// payload only carries totalApiMs (legacy contract), so the duration
// value is carried forward from the prev baseline, not wiped.
export function setPrevTick(
  _sessionId: string,
  snap: PrevTickSnapshot,
  cwd?: string | null,
  identity?: { sessionId?: string | null; cwd?: string | null; model?: string | null; contextUsedPercent?: number | null },
): void {
  void _sessionId;
  if (!cwd) return;
  // Delegate to writePrevTickStatus so the seed reaches both disk and
  // the in-memory pending map (mark-only used to be clobbered).
  const prev = readPrevTickStatus(cwd) ?? emptyPrevTickStatus();
  // Preserve the prior value when the caller omits contextUsedPercent —
  // wiping it would silently disable the carry-over fallback next tick.
  const nextContextUsedPercent = identity?.contextUsedPercent !== undefined
    ? identity.contextUsedPercent
    : prev.contextUsedPercent;
  writePrevTickStatus(cwd, {
    totalApiMs: snap.totalApiMs,
    // Legacy callers don't thread a duration; preserve the prev baseline
    // (processTick's mark() writes the fresh value same tick).
    totalDurationMs: prev.totalDurationMs,
    sessionId: identity?.sessionId ?? prev.sessionId,
    cwd: identity?.cwd ?? prev.cwd,
    model: identity?.model ?? prev.model,
    contextUsedPercent: nextContextUsedPercent,
  });
}

export function setLastSpeed(
  _sessionId: string,
  direction: "in" | "out",
  tps: number,
  cwd?: string | null,
): void {
  void _sessionId;
  void cwd;
  mark(`lastActive:${direction}`, { direction, tps });
}

export function setLastApiMs(
  _sessionId: string,
  deltaApiMs: number,
  cwd?: string | null,
): void {
  void _sessionId;
  void cwd;
  mark("lastActive:apiMs", { direction: "apiMs", tps: deltaApiMs });
}

export function setLastTokenHitRate(
  _sessionId: string,
  pct: number,
  cwd?: string | null,
): void {
  void _sessionId;
  void cwd;
  mark("lastActive:tokenHitRate", { direction: "tokenHitRate", tps: pct });
}

// Coerce raw to a costs array, tolerating legacy/malformed entries.
function coerceCostsArray(raw: unknown): Array<{ currency: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e) =>
      e != null &&
      typeof e === "object" &&
      typeof (e as Record<string, unknown>).currency === "string" &&
      typeof (e as Record<string, unknown>).value === "string",
  ) as Array<{ currency: string; value: string }>;
}

// Accumulate one per-tick cost delta into the costs array (sums by
// currency, toFixed(10)); never mutates the input array.
function accumulateCosts(
  existing: Array<{ currency: string; value: string }>,
  delta: { currency: string; value: string },
): Array<{ currency: string; value: string }> {
  const copy = existing.map((c) => ({ ...c }));
  const idx = copy.findIndex((c) => c.currency === delta.currency);
  if (idx >= 0) {
    const sum = parseFloat(copy[idx].value) + parseFloat(delta.value);
    copy[idx] = { currency: delta.currency, value: sum.toFixed(10) };
  } else {
    copy.push({ currency: delta.currency, value: delta.value });
  }
  return copy;
}

export function setAvg(
  sessionId: string,
  snap: AvgSnapshot,
  cwd?: string | null,
  extras?: {
    // stdin.model.id — per-model slot key.
    modelId?: string | null;
    deltaApiCalls?: number;
    currentApiMs?: number;
    deltaTokenIn?: number;
    deltaTokenOut?: number;
    deltaTokenCachedIn?: number;
    deltaApiMs?: number;
    deltaTokenTotalIn?: number;
    // Per-tick cost delta to accumulate.
    deltaCost?: { currency: string; value: string } | null;
  },
): void {
  if (!sessionId) return;
  const incrementCalls = extras?.deltaApiCalls ?? 0;
  const deltaTokenIn = extras?.deltaTokenIn ?? 0;
  const deltaTokenOut = extras?.deltaTokenOut ?? 0;
  const deltaTokenCachedIn = extras?.deltaTokenCachedIn ?? 0;
  const deltaApiMs = extras?.deltaApiMs ?? 0;
  const deltaTokenTotalIn = extras?.deltaTokenTotalIn ?? 0;

  const sessionKey = `tickStatus:${sessionId}`;
  const sessionCurrent = readTickStatus(cwd, sessionKey) ?? emptyTickStatus();
  const sessionNext: TickStatusValue = { ...sessionCurrent };
  // First-write stamp: Date.now() when startAt is null, then preserved.
  // (No regression-reset path — session identity is bound to sessionId.)
  if (sessionNext.startAt == null) {
    sessionNext.startAt = Date.now();
  }
  // accTokenTotalIn is accumulate-additive like the other acc fields:
  // += the per-tick tokenTotalIn (which itself is a per-turn snapshot,
  // NOT cross-tick cumulative — unlike cost.totalApiDurationMs).
  sessionNext.accTokenIn += snap.accTokenIn;
  sessionNext.accTokenOut += snap.accTokenOut;
  sessionNext.accTokenCachedIn += snap.accTokenCachedIn;
  sessionNext.accApiMs += snap.accApiMs;
  sessionNext.accTokenTotalIn += snap.accTokenTotalIn;
  sessionNext.accApiCalls += snap.accApiCalls;
  // Recompute the ratio from the post-add accumulators so render reads
  // it straight (accTokenCachedIn / accTokenTotalIn * 100).
  sessionNext.accTokenHitRate = sessionNext.accTokenTotalIn > 0
    ? (sessionNext.accTokenCachedIn / sessionNext.accTokenTotalIn) * 100
    : 0;
  // Accumulate per-tick cost by currency.
  if (extras?.deltaCost && extras.deltaCost.value) {
    sessionNext.costs = accumulateCosts(sessionNext.costs, extras.deltaCost);
  }
  mark(sessionKey, sessionNext);

  const bumpDeltaScope = (key: string) => {
    const current = readTickStatus(cwd, key) ?? emptyTickStatus();
    const next: TickStatusValue = { ...current };
    // Same first-write stamp rule as the session slot.
    if (next.startAt == null) {
      next.startAt = Date.now();
    }
    next.accTokenIn += deltaTokenIn;
    next.accTokenOut += deltaTokenOut;
    next.accTokenCachedIn += deltaTokenCachedIn;
    next.accApiMs += deltaApiMs;
    // All scopes accumulate accTokenTotalIn additively (like the other acc fields).
    next.accTokenTotalIn += deltaTokenTotalIn;
    next.accApiCalls += incrementCalls;
    // Refresh the cached ratio after every scope bump.
    next.accTokenHitRate = next.accTokenTotalIn > 0
      ? (next.accTokenCachedIn / next.accTokenTotalIn) * 100
      : 0;
    // Accumulate per-tick cost by currency.
    if (extras?.deltaCost && extras.deltaCost.value) {
      next.costs = accumulateCosts(next.costs, extras.deltaCost);
    }
    mark(key, next);
  };

  if (cwd && (incrementCalls > 0 || deltaTokenIn || deltaTokenOut || deltaTokenCachedIn || deltaApiMs || deltaTokenTotalIn)) {
    bumpDeltaScope(`tickStatus:${projectHash(cwd)}`);
  }
  if (extras?.modelId && (incrementCalls > 0 || deltaTokenIn || deltaTokenOut || deltaTokenCachedIn || deltaApiMs || deltaTokenTotalIn)) {
    bumpDeltaScope(`tickStatus:${extras.modelId}`);
  }
}

export function processTick(
  cwd: string | null,
  tokens: TokenSnapshot | null,
  provider: string | null,
): void {
  const s = getState();
  const prevEntry = s.pending[PREV_TICK_KEY];
  const prev = prevEntry?.kind === "prevTickStatus" ? prevEntry.value : null;
  const { snapshot, measurement } = normalizeTick(tokens, prev, provider);
  // measurement always reflects the freshest normalizeTick result even
  // on invalid ticks (0 + hasMeasurement=false keeps the line
  // consistent with the v1.0 contract).
  s.snapshot = snapshot;
  s.valid = validateNormalizedTick(snapshot);
  s.measurement = measurement;

  // Stage 0: cold-slot JSONL replay — for each tickStatus:<dim> slot
  // with no startAt, recover the aggregate from JSONL history BEFORE
  // setAvg mutates it (setAvg then merges this tick's delta on top;
  // commit flushes in one rewrite). Runs even on invalid ticks: the
  // recovered base is historical truth, and the invalid delta is
  // dropped (setAvg is gated on s.valid), so history isn't polluted.
  const REPLAY_SCOPES = ["session", "project", "model"] as const;
  if (cwd && tokens?.sessionId) {
    const replayArgs = {
      sessionId: tokens.sessionId,
      cwd,
      // Pass stdin.model.id so the per-model slot key aligns with sample.model.
      modelId: tokens.modelId ?? null,
    };
    for (const scope of REPLAY_SCOPES) {
      const key = replayAccKey(scope, replayArgs);
      if (!key) continue;
      const existing = readTickStatus(cwd, key);
      if (existing && existing.startAt != null) continue;
      const replay = replayAccInit(scope, replayArgs);
      if (replay) {
        mark(key, replay);
        if (isSubkeyEnabled("statusStore")) {
          appendDiag(
            "info",
            "replay-acc-init",
            `scope=${scope} accTokenIn=${replay.accTokenIn} accTokenOut=${replay.accTokenOut} accTokenCachedIn=${replay.accTokenCachedIn} accTokenTotalIn=${replay.accTokenTotalIn} accApiMs=${replay.accApiMs} accApiCalls=${replay.accApiCalls} startAt=${replay.startAt}`,
            Date.now(),
            cwd,
            "status-store.replayAccInit",
          );
        }
      }
    }
  }

  // Prev cursor is staged AFTER the validity guard so an invalid tick
  // never advances it (the guard returns before the mark below).

  if (!s.valid || !snapshot || !tokens?.sessionId) {
    s.sample = null;
    return;
  }

  // Stage the prev-cursor: the next tick reads totalApiMs (apiMs =
  // current - prev), totalDurationMs (regression signal), and
  // contextUsedPercent (carry-over for a mistaken 0). totalDurationMs
  // is sourced from stdin cost.total_duration_ms; when stdin omits it,
  // fall back to the prev value so the check keeps a baseline.
  const prevForCarry = prevEntry?.kind === "prevTickStatus"
    ? prevEntry.value
    : null;
  mark(PREV_TICK_KEY, {
    totalApiMs: snapshot.totalApiMs,
    totalDurationMs: tokens.cost?.totalDurationMs
      ?? prevForCarry?.totalDurationMs
      ?? 0,
    sessionId: tokens.sessionId,
    cwd,
    model: tokens.modelId ?? null,
    contextUsedPercent: tokens.contextWindow?.contextUsedPercent ?? null,
  });

  // Accumulators get snapshot values straight (no cross-tick
  // subtraction on per-turn fields). accTokenHitRate is pre-computed
  // here so the per-session slot reads it directly.
  const initialCachedIn = snapshot.hasCachedIn ? snapshot.cachedIn : 0;
  const initialTokenTotalIn = snapshot.totalIn ?? 0;
  setAvg(tokens.sessionId, {
    accTokenIn: snapshot.in,
    accTokenOut: snapshot.out,
    accApiMs: snapshot.apiMs,
    accTokenCachedIn: initialCachedIn,
    accApiCalls: 1,
    accTokenTotalIn: initialTokenTotalIn,
    accTokenHitRate: initialTokenTotalIn > 0
      ? (initialCachedIn / initialTokenTotalIn) * 100
      : 0,
  }, cwd, {
    // Pass stdin.model.id through to setAvg's per-model slot.
    modelId: tokens.modelId ?? null,
    deltaApiCalls: 1,
    deltaTokenIn: snapshot.in,
    deltaTokenOut: snapshot.out,
    deltaTokenCachedIn: snapshot.hasCachedIn ? snapshot.cachedIn : 0,
    deltaApiMs: snapshot.apiMs,
    deltaTokenTotalIn: snapshot.totalIn ?? 0,
    deltaCost: snapshot.cost,
  });

  if (snapshot.tokenInSpeed != null) {
    setLastSpeed(tokens.sessionId, "in", snapshot.tokenInSpeed, cwd);
  }
  if (snapshot.tokenOutSpeed != null) {
    setLastSpeed(tokens.sessionId, "out", snapshot.tokenOutSpeed, cwd);
  }
  setLastApiMs(tokens.sessionId, snapshot.apiMs, cwd);
  if (snapshot.tokenHitRate != null) {
    setLastTokenHitRate(tokens.sessionId, snapshot.tokenHitRate, cwd);
  }

  s.sample =
    snapshot.totalIn != null && snapshot.totalOut != null
      ? {
          at: Date.now(),
          totalIn: snapshot.totalIn,
          totalOut: snapshot.totalOut,
          in: snapshot.in,
          out: snapshot.out,
          cacheCreation: snapshot.cacheCreation,
          cacheIn: snapshot.cachedIn,
          cost: snapshot.cost ?? undefined,
          model: snapshot.modelId ?? undefined,
          base_url: normalizeUrl(process.env.ANTHROPIC_BASE_URL ?? "") || undefined,
          totalApiMs: snapshot.totalApiMs,
          apiMs: snapshot.apiMs,
          prevApiMs: snapshot.prevTotalApiMs,
        }
      : null;
}

export function processAndSaveTick(
  cwd: string | null,
  tokens: TokenSnapshot | null,
  provider: string | null,
): ProcessResult {
  beginTick(cwd, tokens);
  processTick(cwd, tokens, provider);
  const s = getState();
  // `valid` doesn't gate state flush — only sample-row emission.
  const shouldWriteState = !!s.cwd && s.dirty;
  commit();
  let wroteSample = false;
  if (s.valid && s.sample && tokens?.sessionId && cwd) {
    appendSample(cwd, tokens.sessionId, s.sample);
    wroteSample = true;
  }
  return {
    valid: s.valid,
    snapshot: s.snapshot,
    measurement: s.measurement ?? EMPTY_TICK,
    wroteState: shouldWriteState,
    wroteSample,
  };
}

// ----- Test-only resets --------------------------------------------------------

export function __resetForTest(): void {
  _loaded.clear();
  _stores.clear();
  _tickState = null;
}
