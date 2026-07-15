// Runtime state boundary for stdin-derived data.
//
// This module owns three related state files under
// `${CLAUDE_CONFIG_DIR}/plugins/topgauge/state/`:
//
//   - `cache.stat.json`                    — cross-project sum/avg stat cache
//   - `<projectHash>/state.json`           — per-project accumulated state
//   - `<projectHash>/<sessionId>.jsonl`    — append-only normalized samples
//
// The write path is intentionally centralized here:
//
//   stdin -> parseTokenSnapshot -> processAndSaveTick -> render
//
// `processAndSaveTick()` loads the project state, normalizes stdin,
// validates it, updates accumulators / prevTickStatus / lastActive,
// flushes `state.json` once, and appends one JSONL row when valid.
//
// Compatibility:
//   - `src/token-store.ts`, `src/tick-state.ts`, and `src/data-processor.ts`
//     are kept as thin compatibility shims that re-export the APIs now
//     implemented here.

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
  logFsList,
  logFsMkdir,
  logFsRead,
  logFsStat,
  logFsWrite,
} from "./diagnostics.ts";
import type { TokenSample, TokenSnapshot } from "./types.ts";

// ----- Persisted value families ------------------------------------------------

export type TickStatusValue = {
  accTokenIn: number;
  accTokenOut: number;
  accTokenCachedIn: number;
  accTokenTotalIn: number;
  accApiMs: number;
  accApiCalls: number;
  // v0.8.10-alpha.3 — derived ratio, computed at processTick write
  // time and persisted alongside the raw accumulators. Render reads
  // it straight (no recompute). Formula:
  //   accTokenHitRate = accTokenCachedIn / accTokenTotalIn * 100
  // Zero denominator (no totalIn accumulated this slot) → 0.
  accTokenHitRate: number;
  // v0.8.24+ — wall-clock instant this slot received its first
  // valid write (Unix ms). Stamped by setAvg / bumpDeltaScope
  // on first write (when readTickStatus returns null OR
  // startAt is null). `null` = "no writes yet" → m_accStartTime
  // renders the "start:n/a" placeholder.
  startAt?: number | null;
};
// the ONLY field the next tick subtracts against is `totalApiMs`
// (apiMs = current.totalApiMs - prev.totalApiMs). All other per-turn
// fields live on `TokenSnapshot` as snapshot fields and are read
// straight, not derived. Identity (sessionId/cwd/model) is kept for
// stale-baseline detection.
//
// v0.8.23+ — `totalDurationMs` joins the cursor alongside
// `totalApiMs`. detectRegression now reads `totalDurationMs`
// (stdin `cost.total_duration_ms` — the wall-clock cost of the
// running claude-code process) as the regression signal, since
// that field increments monotonically per tick on every observed
// stdin producer. `totalApiMs` stays in the cursor because it's
// still the source for the per-tick api-ms delta. The two are
// read independently — totalDurationMs never feeds apiMs.
export type PrevTickStatusValue = {
  totalApiMs: number;
  totalDurationMs: number;
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  // v0.8.15-alpha — carry-over for stdin `context_window.used_percentage`.
  // When the next tick arrives with contextUsedPercent===0 (an
  // observed error from the stdin producer), beginTick falls back
  // to this prev value rather than surfacing a misleading "0%".
  // Null when no prior tick has ever observed a non-null value.
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

// v0.8.10-alpha.2 — the only derived delta in the whole pipeline.
// Speed modules (m_tokenInSpeed, m_tokenOutSpeed, m_apiMs) use this.
// The rest of the render path reads `TickSnapshot.{in, out, ...}` directly.
export type ApiMsDelta = {
  apiMs: number;        // -1 = regression sentinel, 0 = idle, >0 = real delta
  totalApiMs: number;   // current tick stdin value
};

// v0.8.10-alpha.2 — TickSnapshot replaces TickDeltaResult. It's a flat
// projection of the current tick's stdin snapshot + the single derived
// `apiMs`. No "writeBack" payload — next tick re-reads from disk.
export type TickSnapshot = {
  hasMeasurement: boolean;
  in: number;
  out: number;
  cachedIn: number;
  totalIn: number;
  totalOut: number;
  totalApiMs: number;
  apiMs: number;
};

export type AvgSnapshot = {
  accTokenIn: number;
  accTokenOut: number;
  accApiMs: number;
  accTokenCachedIn: number;
  accApiCalls: number;
  accTokenTotalIn: number;
  // v0.8.10-alpha.3 — mirror of TickStatusValue.accTokenHitRate,
  // pre-computed by the data-processor.
  accTokenHitRate: number;
  // v0.8.24+ — propagated from TickStatusValue.startAt. The
  // renderer reads it through peekAcc / readAccumulator and
  // formats via formatAbsTime.
  startAt?: number | null;
};

// v0.8.10-alpha.2 — internal per-tick snapshot for the data-processor.
// Carries the full stdin snapshot + the single derived apiMs +
// regression flag + derived speed/rate metrics. Renamed from
// `NormalizedTick` because "normalized" was the old "delta of two
// snapshots" mental model.
type CurrentTick = {
  sessionId: string;
  cwd: string;
  // v0.9.x — active-model id (stdin.model.id). Drives the per-model
  // accumulator slot key and the JSONL sample.model stamp. Was
  // modelDisplayName in v0.8.x; renamed so per-model pricing +
  // filtering use the stable id, not the friendly label.
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
  // vX.X.X — `windowKey` widened from the v0.8.x closed union to
  // `string`. Each unique windowKey (declared `interval.windowId`,
  // the literal "all" sentinel, or a free-form dhms string) mints
  // its own stat cache entry under `stat:<model>:<windowKey>`. The
  // v0.8.x cap of ≤ 12 entries (2 model × 3 window × 2 align) is
  // gone — cache.ts's TTL=300s keeps abandoned entries bounded.
  windowKey: string;
  sinceMs: number;
  modelFilter?: string;
  // The renderer-side SumFilter declares more fields
  // (`windowIdMatch` / `interval` / `windowMs`) used by
  // m_sumStartTime / m_sumEndTime — those are read at the
  // parseWindowScope call site, not here, so we deliberately
  // don't redeclare them on this side of the import boundary.
  // Status-store treats the parameter structurally: any object
  // with these three core fields is accepted.
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
  // v0.8.24+ — min(s.startAt) across the filtered rows. 0 when
  // no row carries a valid startAt (legacy / missing). Drives
  // m_sumStartTime's "earliest session start" rendering.
  firstAt: number;
  // vX.X.X — used% of the plan window this aggregate was aligned
  // to, captured at getStatAggregate time. Populated ONLY when the
  // caller resolved an aligned scan (alignActive=true) AND the
  // matched interval carries a usable percent; null otherwise
  // (non-aligned / "all" / dhms scans, or a window with no
  // percent). Read from the structurally-passed `filter.interval`,
  // mirroring render.ts's intervalToWindow used%-pick rule.
  alignedUsedPercent?: number | null;
  generatedAt: number;
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
};

const STAT_CACHE_TTL_MS = 300_000;

// ----- Shared state root + path helpers ---------------------------------------

function defaultStateRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return join(claudeRoot, "plugins", "topgauge", "state");
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
    process.stderr.write("topgauge: state file is malformed; ignoring\n");
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
      // v0.8.10-alpha.2 — only totalApiMs + identity participate in
      // any cross-tick math. Legacy `in/out/cachedIn/totalIn` fields
      // on disk (from pre-alpha versions) are silently dropped.
      out[key] = {
        at: e.at,
        kind: "prevTickStatus",
        value: {
          totalApiMs: typeof v.totalApiMs === "number" ? v.totalApiMs : 0,
          // v0.8.23+ — totalDurationMs cursor. Legacy rows written
          // before v0.8.23 lack this field; backfill with 0 so a
          // backward-jump guard at next tick (current=0 vs prev=0)
          // doesn't accidentally fire a regression reset on a
          // freshly-upgraded state file.
          totalDurationMs: typeof v.totalDurationMs === "number"
            ? v.totalDurationMs
            : 0,
          sessionId: typeof v.sessionId === "string" ? v.sessionId : null,
          cwd: typeof v.cwd === "string" ? v.cwd : null,
          model: typeof v.model === "string" ? v.model : null,
          // v0.8.15-alpha — backfill contextUsedPercent for legacy
          // prev rows. Missing field → null (start of history); a
          // numeric 0/100 stays 0/100 as parsed.
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
      // v0.8.10-alpha.3 — backfill accTokenHitRate for legacy rows
      // that don't have it persisted. Compute from the parsed raw
      // accumulators so a missing field gets a meaningful value
      // on first read (the next processTick will overwrite with
      // the fresh formula anyway). Zero-denominator → 0.
      // Formula: accTokenCachedIn / accTokenTotalIn * 100
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
          // v0.8.24+ — backfill. Legacy rows (pre-v0.8.24)
          // read as null → m_accStartTime shows "start:n/a"
          // placeholder until the next valid tick stamps
          // Date.now() via setAvg / bumpDeltaScope.
          startAt: typeof v.startAt === "number" ? v.startAt : null,
        },
      };
    }
  }
  return out;
}

function loadStoreFromPath(path: string, cwd: string): Store | null {
  logFsRead(path, "status-store.loadFromDisk", undefined, cwd);
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
  logFsMkdir(dir, "status-store.flushToDisk", cwd);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    process.stderr.write("topgauge: state mkdir failed; in-memory only\n");
    return;
  }
  const payload = JSON.stringify(store);
  logFsWrite(path, "status-store.flushToDisk", payload.length, cwd);
  try {
    writeFileSync(path, payload);
  } catch {
    process.stderr.write("topgauge: state write failed; in-memory only\n");
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
    // v0.8.24+ — "no writes yet" sentinel. setAvg /
    // bumpDeltaScope stamp Date.now() on the first valid
    // write.
    startAt: null,
  };
}

export function emptyPrevTickStatus(): PrevTickStatusValue {
  return {
    totalApiMs: 0,
    // v0.8.23+ — see [[detectRegression-totaldurationms]]. Zero
    // sentinel for "no prior measurement"; the next active tick
    // writes the real stdin value.
    totalDurationMs: 0,
    sessionId: null,
    cwd: null,
    model: null,
    // v0.8.15-alpha — null = no prior history; beginTick does NOT
    // substitute when prev is also null (a fresh install or after
    // `clean` naturally surfaces the first tick's stdin value as-is,
    // including a 0 from a malformed probe).
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
  // v0.8.10-alpha.2 — also seed the in-memory pending map so
  // a subsequent processTick on this cwd sees the seed without
  // requiring an explicit beginTick + load from disk. The
  // activeStoreFor fallback returns _tickState.pending when
  // _tickState.cwd is null (the test setup convention
  // beginTickForTest(null, null)), so updating pending is
  // the only way to reach the read path even when the active
  // tick's cwd doesn't match this write's cwd.
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
  // v0.8.10-alpha.2 — also seed the in-memory pending map so a
  // subsequent beginTickForTest on this cwd sees the seed
  // (beginTick loads from disk into pending, so the on-disk
  // write is the source of truth — but seeding pending as well
  // means a test that fires setPrevTick then beginTickForTest
  // doesn't lose the seed to a "pending was empty" race).
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

export const LAST_ACTIVE_TTL_MS = 60_000;
// v0.8.24 — sanity ceiling on the per-tick apiMs sample
// (validateNormalizedTick, below). Rejects apiMs values at or
// above this bound so a single pathological stdin reading
// (clock skew, provider bug, stale baseline) cannot pollute
// the JSONL sample stream / the per-session accApiMs sum.
// NOT a fetch timeout — the real fetch timeout is config-driven
// (configStore.get().fetchTimeoutMs) and applied in src/index.ts
// via AbortSignal.timeout(). Set to 5min — well above any
// realistic per-tick API call (typically <60s) but below the
// 10min "pathological" marker. Pin in tick-state.test.ts.
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
  logFsMkdir(dir, "status-store.appendSample", cwd);
  try {
    mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify(sample) + "\n";
    logFsWrite(path, "status-store.appendSample", payload.length, cwd);
    appendFileSync(path, payload, "utf8");
  } catch {
    process.stderr.write("topgauge: token-sample append failed\n");
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
    model: typeof r.model === "string" ? r.model : undefined,
    totalApiMs: typeof r.totalApiMs === "number" ? r.totalApiMs : undefined,
    apiMs: typeof r.apiMs === "number" ? r.apiMs : undefined,
    prevApiMs:
      r.prevApiMs === null
        ? null
        : typeof r.prevApiMs === "number"
          ? r.prevApiMs
          : undefined,
    // v0.8.24+ — backfill. Legacy rows (pre-v0.8.24) read as
    // null; aggregateSamples' Number.isFinite gate filters
    // them out of the firstAt roll-up so a single legacy
    // file can't drag the min down to 0.
    startAt: typeof r.startAt === "number" ? r.startAt : null,
    lastAt: typeof r.lastAt === "number" ? r.lastAt : null,
  };
}

export function readSamples(
  cwd: string,
  sessionId: string,
  sinceMs: number,
  modelFilter?: string,
): TokenSample[] {
  const path = sampleFilePath(cwd, sessionId);
  logFsRead(path, "status-store.readSamples", undefined, cwd);
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
  logFsList(root, "status-store.readAllSamples");
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root);
  } catch {
    return [];
  }
  for (const projDir of projectDirs) {
    const projPath = join(root, projDir);
    logFsStat(projPath, "status-store.readAllSamples");
    let st;
    try {
      st = statSync(projPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    logFsList(projPath, "status-store.readAllSamples");
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
        logFsStat(path, "status-store.readAllSamples");
        let fst;
        try {
          fst = statSync(path);
        } catch {
          continue;
        }
        if (fst.mtimeMs < sinceMs) continue;
      }
      logFsRead(path, "status-store.readAllSamples");
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

// ----- v0.8.29 — cold-slot JSONL replay ----------------------------------------
//
// When state.json is missing (fresh install, after `:clean --purge-runtime`,
// accidental deletion), setAvg's first valid write seeded each tickStatus
// slot from the CURRENT tick's delta only — historical JSONL was discarded.
// The user saw a misleading `acc:0` followed by a one-tick blip instead of
// the cumulative number they expected.
//
// This block mirrors the m_sum* pattern (readAllSamples / cache.stat.json
// TTL) for the three persistent m_acc* scopes (session / project / model).
//
// Replay runs in processTick Stage 0 — BEFORE setAvg mutates the slot. The
// recovered aggregate is mark()'ed into _tickState.pending, so:
//   - on valid ticks, setAvg additively merges this tick's delta on top
//     of the recovered base (single commit per tick preserved)
//   - on invalid ticks, the recovered base is flushed standalone (no
//     delta; we don't pollute history with a bad row)
//   - render sees the recovered value via the existing pending read path
//     (no firstWriteKeys side-channel needed)

function replayAccKey(
  scope: "session" | "project" | "model",
  args: {
    sessionId?: string | null;
    cwd?: string | null;
    // v0.9.x — active-model id (stdin.model.id) for scope=model
    // slot key. Renamed from modelDisplayName.
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

// v0.8.29 — read-once per-scope helper. Walks the JSONL stream scoped
// to one slot:
//   session  → state/<projectHash>/<sessionId>.jsonl (one file)
//   project  → every *.jsonl under state/<projectHash>/ (cross-session)
//   model    → every *.jsonl under state/<projectHash>/ filtered by
//              sample.model === args.modelId
// sinceMs=0 → no time cutoff; replay reads the full history.
function readReplaySamples(
  scope: "session" | "project" | "model",
  args: {
    sessionId?: string | null;
    cwd?: string | null;
    // v0.9.x — renamed from modelDisplayName. JSONL rows now stamp
    // modelId (stdin.model.id), so the filter compares against the
    // active model id, not the friendly label.
    modelId?: string | null;
  },
): TokenSample[] {
  if (scope === "session") {
    if (!args.sessionId || !args.cwd) return [];
    return readSamples(args.cwd, args.sessionId, 0);
  }
  // project / model — read per-project to honor the project-scope
  // boundary (TokenSample doesn't carry projectHash; reading from
  // readAllSamples would conflate with other projects under the same
  // state root on a multi-project machine).
  if (!args.cwd) return [];
  const all = readProjectSamples(args.cwd, 0);
  if (scope === "project") return all;
  // scope === "model"
  if (!args.modelId) return [];
  return all.filter((s) => s.model === args.modelId);
}

// readProjectSamples — mirrors readAllSamples' inner walk, but only
// visits the one projectHash subdir matching cwd. Same coerceSampleRow
// filter, same mtime cutoff semantics.
function readProjectSamples(cwd: string, sinceMs: number): TokenSample[] {
  const dir = join(stateRoot(), projectHash(cwd));
  logFsList(dir, "status-store.readProjectSamples");
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
      logFsStat(path, "status-store.readProjectSamples");
      let fst;
      try {
        fst = statSync(path);
      } catch {
        continue;
      }
      if (fst.mtimeMs < sinceMs) continue;
    }
    logFsRead(path, "status-store.readProjectSamples");
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

// v0.8.29 — cold-slot replay. Returns a TickStatusValue ready to
// mark() into pending, or null when:
//   - slot already has a startAt (warm — replay is a no-op, the
//     user's confirmed value is preserved)
//   - JSONL has zero matching rows (no history to recover; the
//     current tick's setAvg will populate from this tick's delta)
//   - missing sessionId / cwd / modelId (no slot to recover)
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
  // Short-circuit on warm slot — preserves the user's confirmed
  // value. Reads via activeStoreFor so a same-tick in-memory
  // pending entry is preferred over the on-disk file (avoids
  // a "warmed earlier in this tick, cold again now" race).
  const existing = readTickStatus(args.cwd, key);
  if (existing && existing.startAt != null) return null;

  const samples = readReplaySamples(scope, args);
  if (samples.length === 0) return null;

  // Aggregate the same fields setAvg writes. Mirrors aggregateSamples
  // but mapped to TickStatusValue field names. Note: accTokenTotalIn
  // here is the PER-TICK-DELTA accumulator (sum of per-row
  // totalIn-deltas), matching aggregateSamples' sumTotalIn ==
  // sumIn + sumCached semantics.
  let accTokenIn = 0;
  let accTokenOut = 0;
  let accTokenCachedIn = 0;
  let accTokenTotalIn = 0;
  let accApiMs = 0;
  let accApiCalls = 0;
  let firstAt = Number.POSITIVE_INFINITY;
  for (const s of samples) {
    accTokenIn += s.in;
    accTokenOut += s.out;
    accTokenCachedIn += s.cacheIn;
    accTokenTotalIn += s.in + s.cacheIn;
    accApiMs += s.apiMs ?? 0;
    if ((s.apiMs ?? 0) > 0) accApiCalls += 1;
    // startAt precedence: explicit row.startAt > row.at > skip.
    // The > 0 gate filters legacy "0" sentinels and the
    // POSITIVE_INFINITY default; the min roll-up matches the
    // existing aggregateSamples firstAt semantics.
    const candidate = (s.startAt != null && Number.isFinite(s.startAt) && s.startAt > 0)
      ? s.startAt
      : (Number.isFinite(s.at) && s.at > 0 ? s.at : null);
    if (candidate != null && candidate < firstAt) firstAt = candidate;
  }
  if (!Number.isFinite(firstAt)) firstAt = Date.now();

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
  };
}

// ----- Stat cache ownership ----------------------------------------------------

const _statCacheStore = new Map<string, StatCacheEntry<unknown>>();
let _statCacheLoaded = false;

function loadStatCacheFromDisk(): void {
  if (_statCacheLoaded) return;
  _statCacheLoaded = true;
  const path = _statCachePathResolver();
  logFsRead(path, "status-store.loadStatCache", undefined, null);
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
    process.stderr.write("topgauge: stat cache file is malformed; ignoring\n");
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
  logFsMkdir(dir, "status-store.flushStatCache", null);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    process.stderr.write("topgauge: stat cache mkdir failed; in-memory only\n");
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
  logFsWrite(path, "status-store.flushStatCache", payload.length, null);
  try {
    writeFileSync(path, payload);
  } catch {
    process.stderr.write("topgauge: stat cache write failed; in-memory only\n");
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

// v0.8.16 — TTL-IGNORING peek for a specific stat-cache key.
// Mirrors cache.peekWithTtl: returns null on miss, NEVER on expiry,
// so the renderer can show "cache is past TTL, will refresh next
// tick". Used by m_statTtlStatus's per-key variant.
export function peekStatAgeMs(key: string): { ageMs: number; ttlMs: number } | null {
  loadStatCacheFromDisk();
  const e = _statCacheStore.get(key) as StatCacheEntry<unknown> | undefined;
  if (!e) return null;
  return { ageMs: Date.now() - e.at, ttlMs: e.ttlMs ?? 0 };
}

// v0.8.16 — TTL-IGNORING peek for the freshest entry across all
// stat-cache keys. Used by m_statTtlStatus because the stat cache
// can hold many keys (one per model/window/align combination) and
// we display the freshest so the user always sees the most-recently-
// scanned entry.
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

// v0.8.16 — Test seam for m_statTtlStatus tests. Exposes the
// private setStatCache so tests can seed rows without going
// through getStatAggregate's full readAllSamples scan path.
// Mirrors the `__resetCacheForTest` pattern in cache.ts.
export function setStatCacheForTest<T>(key: string, value: T, ttlMs: number): void {
  setStatCache(key, value, ttlMs);
}

// v0.8.16 — Test seam for backdating an already-seeded stat-cache
// row. Used by m_statTtlStatus tests to simulate aged entries
// without monkey-patching Date.now (which would also break
// setStatCache's internal `at` stamping). Mirrors the backdate
// pattern cache tests use via `(cache as any).store.set(…)`.
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
  // vX.X.X — `firstAt` now tracks min(s.at) over filtered rows,
  // symmetric with `lastAt` = max(s.at). The v0.8.24 design
  // read row.startAt (a separate per-session first-tick stamp
  // unrelated to the window's data range), so m_sumStartTime
  // reported the session's first-ever tick — not the earliest
  // tick inside the filtered window. m_sumEndTime has always
  // read max(s.at), so the two modules now describe the same
  // window's empirical bounds. coerceSampleRow still reads
  // `r.startAt` for legacy back-compat (v0.8.24 rows on disk),
  // but it's no longer consulted by this aggregate. The m_sumStartTime
  // renderer treats firstAt <= 0 as placeholder.
  let firstAt = Number.POSITIVE_INFINITY;
  let calls = 0;
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
  }
  if (!Number.isFinite(firstAt)) firstAt = 0;
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
  };
}

export function getStatAggregate(filter: SumFilter): StatAggregate {
  // vX.X.X — `:alignActive` segment RESTORED. The renderer-side
  // parseWindowScope buckets along `alignActive` because the
  // declared-windowId branch (align=true) and the dhms /
  // "all" branches (align=false) can produce different
  // (sinceMs, modelFilter) for the same `windowKey` literal.
  // E.g. `|window|monthly|align|true` scans sinceMs =
  // Date.parse(interval.resetStartAt), while `|window|monthly|align|false`
  // (no dhms parse) drops with warn — but if a user later
  // aliases `windowId: "5h"` to a 5-hour declared interval AND
  // also writes `|window|5h|align|false`, the same `windowKey`
  // string lands on different (sinceMs, interval) pairs.
  // Bucketing along align keeps the two readings in disjoint
  // cache slots so they don't poison each other. Free-form dhms
  // values (always alignActive=false) still mint their own entries
  // via the literal `windowKey` (`stat:...:2h30m:false`).
  const key = `stat:${filter.modelFilter ?? "all"}:${filter.windowKey}:${(filter as { alignActive?: boolean }).alignActive ?? false}`;
  const cached = getStatCache<StatAggregate>(key, STAT_CACHE_TTL_MS);
  if (cached) return cached;
  const samples = readAllSamples(filter.sinceMs);
  const filtered =
    filter.modelFilter === undefined
      ? samples
      : samples.filter((s) => s.model === filter.modelFilter);
  const agg = aggregateSamples(filtered);
  // vX.X.X — when the caller resolved an aligned scan
  // (alignActive=true), stamp the aligned plan window's used% onto
  // the aggregate so downstream renders can read it without a
  // second interval lookup. `filter.interval` is passed
  // structurally by the renderer (render.ts's SumFilter carries it;
  // status-store's SumFilter deliberately doesn't redeclare it), so
  // we read it defensively off an `unknown`-widened view.
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

// vX.X.X — mirror of render.ts's intervalToWindow used%-pick rule:
// used% wins when present; else derive from 100 - remaining%; else
// null (no percent available). Kept here (not imported from
// render.ts) to avoid a status-store → render dependency edge.
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

// v0.8.11-alpha — the prev cursor carries ONLY totalApiMs. Returns
// it (as the baseline for `apiMs = current - baseline`) or null when
// there's no history. The signal is purely numeric: a forward roll
// is an api-call duration; a backward roll means the cumulative
// counter restarted (cc restarted) and detectRegression flags the
// tick as a reset. Nothing about sessionId identity participates in
// this math — the numeric direction IS the truth.
function resolvePreviousBaseline(
  tokens: TokenSnapshot | null,
  prev: PrevTickStatusValue | null,
): { prevTotalApiMs: number | null } {
  if (!tokens?.sessionId || !prev) {
    return { prevTotalApiMs: null };
  }
  return { prevTotalApiMs: prev.totalApiMs };
}

// v0.8.15-alpha — stdin-side error guard for context_window.used_percentage.
// Observed stdins from error states occasionally surface
// `used_percentage=0` instead of `null`, which the renderer would
// display as a literal "0%". When the prev tick carries a usable
// value (non-null), fall back to it so the line stays consistent.
// Three-state decision matrix:
//   stdin === null      → keep null (real "no data")
//   stdin  > 0          → keep as-is (real percentage)
//   stdin === 0         → error sentinel: substitute prev IF prev is
//                         non-null; otherwise leave the 0 for
//                         transparency (no carry-over to lie about)
// The substitution target is `tokens.contextWindow.contextUsedPercent`,
// since `m_contextUsedPercent` reads stdin's path verbatim — no
// separate propagation through the TickSnapshot / measurement layer.
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

// v0.8.11-alpha → v0.8.23: regression detection.
//
// Originally the signal was `current.totalApiMs < prev.totalApiMs`
// (stdin `cost.total_api_duration_ms`). That counter tracks the
// cumulative API roundtrip time and increments only on actual
// API calls — when a user idle-gazes for 30s with no API activity,
// totalApiMs stays put and a subsequent restart is harder to spot
// because the counter barely moves.
//
// v0.8.23+ — switched the primary signal to
// `current.totalDurationMs < prev.totalDurationMs` (stdin
// `cost.total_duration_ms`, the wall-clock cost of the running
// cc process). totalDurationMs increments monotonically per tick
// on every observed stdin producer, so it's a more reliable
// "the cc process restarted" trigger — even an idle session shows
// clock progression.
//
// Two extra guards keep the check well-behaved on edge cases:
//
//   1. **120s cold-start threshold** — the first tick of a fresh
//      cc process carries `totalDurationMs ≈ 0`. Comparing against
//      a prev baseline from a prior process (which could be any
//      positive number up to hours) would falsely fire a regression
//      on EVERY cold start. When the current totalDurationMs is
//      under 120_000 (2 minutes), the cc process is brand-new and
//      we treat the backward jump as expected — the prev baseline
//      is from a different process and will be replaced by the
//      current value before the next tick.
//
//   2. **contextUsedPercent===0 stdin-error guard** (carried over
//      from v0.8.15-alpha) — when the caller observes
//      `contextUsedPercent===0` AND no carry-over applies (prev
//      null), `totalDurationMs` may roll backward as a side effect
//      of the malformed probe rather than a real cc restart.
//      Suppress the regression flag in that case. When carry-over
//      substitutes a non-zero prev value, contextUsedPercent is
//      already != 0 by the time detectRegression runs
//      (normalizeTick applies carry-over first), so the guard
//      naturally does not fire.
//
// Identity (sessionId/cwd) is still NOT part of the check — a
// regression detection that also requires identity would miss the
// common "I ran a different cc command" restart case.
const COLD_START_THRESHOLD_MS = 120_000;

// v0.8.24+ — read-once-per-tick helper. Returns the
// wall-clock instant of the first tick for the current
// session, which becomes the row-level `startAt` for every
// JSONL sample we write. For a fresh session (no JSONL file
// yet, or empty / unreadable), returns Date.now() — this row
// IS the first tick, so its own startAt === its own at.
//
// Reads the JSONL head line (oldest tick — JSONL appends to
// the END, so the first tick is at the TOP). The first line
// is the smallest one; subsequent reads of the same file
// (this is per-tick, so every tick after the first hits the
// same page-cached line) are amortized to ~µs.
//
// Why not an in-memory sticky: the statusline runs as a
// per-tick child process (see diagnostics.ts:148-152), so an
// in-memory sticky dies between ticks. The first tick of
// every cc restart would compute a fresh "first tick"
// (wrong semantic — the session hasn't restarted, only the
// cc process has). Reading from disk gives the correct
// per-session persistence with one cheap read per tick.
function resolveFirstTickAt(cwd: string, sessionId: string): number {
  const path = sampleFilePath(cwd, sessionId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return Date.now();
  }
  const nl = raw.indexOf("\n");
  const firstLine = nl === -1 ? raw : raw.slice(0, nl);
  if (!firstLine) return Date.now();
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return Date.now();
  }
  if (!parsed || typeof parsed !== "object") return Date.now();
  const row = parsed as Record<string, unknown>;
  // Prefer the explicit startAt field. Fall back to the row's
  // own `at` for legacy rows written before this field existed
  // — the row's own at IS the first-tick instant for that
  // file, and the same file is read on every subsequent tick
  // so the roll-up is stable.
  if (typeof row.startAt === "number" && Number.isFinite(row.startAt) && row.startAt > 0) {
    return row.startAt;
  }
  if (typeof row.at === "number" && Number.isFinite(row.at) && row.at > 0) {
    return row.at;
  }
  return Date.now();
}

function detectRegression(
  tokens: TokenSnapshot | null,
  prev: PrevTickStatusValue | null,
): boolean {
  if (!tokens?.sessionId || !prev) return false;
  const currentTotalDurationMs = tokens.cost?.totalDurationMs;
  if (currentTotalDurationMs == null
      || !Number.isFinite(currentTotalDurationMs)) return false;
  // v0.8.23+ — cold-start guard. On the first tick of a fresh
  // cc process, totalDurationMs is small (sub-2-minute by
  // definition). Comparing against the prev baseline (from a
  // prior process) would falsely flag a regression; suppress.
  if (currentTotalDurationMs < COLD_START_THRESHOLD_MS) return false;
  // v0.8.15-alpha — stdin-side error guard for contextUsedPercent
  // (carried forward). See block comment above.
  const cw = tokens.contextWindow;
  if (cw && cw.contextUsedPercent === 0) return false;
  return currentTotalDurationMs < prev.totalDurationMs;
}

function normalizeTick(
  tokens: TokenSnapshot | null,
  prev: PrevTickStatusValue | null,
): { snapshot: CurrentTick | null; measurement: TickSnapshot } {
  if (!tokens || !tokens.sessionId || !tokens.cwd) {
    return { snapshot: null, measurement: EMPTY_TICK };
  }
  // v0.8.15-alpha — stdin-side error guard for context_window.used_percentage.
  // Observed stdins from error states occasionally surface
  // `used_percentage=0` instead of `null`, which the renderer would
  // display as a literal "0%". When the prev tick carries a usable
  // value (non-null, non-zero error sentinel), fall back to it so
  // the line stays consistent. This mutation is in-place against
  // the caller's TokenSnapshot — render reads `tokens.contextWindow.
  // contextUsedPercent` directly off the same reference, so no
  // separate propagation path is needed.
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
  // v0.8.11-alpha — regression detection is purely numerical and
  // independent of sessionId identity: a backward totalApiMs jump
  // always means the cumulative counter restarted (cc restarted),
  // regardless of whose sessionId the prev baseline belonged to.
  const invalidRegression = detectRegression(tokens, prev);
  // apiMs is THE unique cross-tick delta. When prevTotalApiMs is
  // null (no history yet — first tick after install/cache wipe),
  // back-derive apiMs from tokenOut via the legacy v0.4.x formula:
  // apiMs = tokenOut * 1000 / 50 (assumes a 50 t/s fall-back rate so
  // the first tick's speed gates render a real value rather than 0).
  const apiMs = invalidRegression || prevTotalApiMs === null
      ? (out_ * 1000) / 50
      : totalApiMs - prevTotalApiMs;
  const cachedIn = tokens.current.tokenCachedIn ?? 0;
  const hasCachedIn = tokens.current.tokenCachedIn != null;
  // v0.8.10-alpha.2 — validation gate uses session-cumulative totals
  // (user contract pinned to the totals.* fields). The per-turn
  // current.tokenIn / tokenOut are snapshot fields, not gates.
  const valid = totalIn > 0 && totalOut > 0 && apiMs > 0;
  const tokenHitRate =
    totalIn > 0 ? (cachedIn / totalIn) * 100 : null;
  const tokenInSpeed = apiMs > 0 ? (in_ / apiMs) * 1000 : null;
  const tokenOutSpeed = apiMs > 0 ? (out_ / apiMs) * 1000 : null;

  // v0.8.11-alpha — full-snapshot smoke diagnostic at the post-derive
  // point: env-gated (default off), one line per tick carrying every
  // field computed above so a postmortem can confirm accTokenHitRate /
  // accTokenTotalIn pre-compute math at the source rather than chasing
  // it through the read path.
  if (process.env.TOPGAUGE_DIAGNOSTICS_ENABLE === "1") {
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
  };

  return {
    snapshot: {
      sessionId: tokens.sessionId,
      cwd: tokens.cwd,
      // v0.9.x — active-model id (stdin.model.id). Drives the
      // per-model accumulator slot key and the JSONL sample.model
      // stamp. Was modelDisplayName in v0.8.x.
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
    },
    measurement,
  };
}

function validateNormalizedTick(tick: CurrentTick | null): boolean {
  if (!tick) return false;
  // v0.8.10-alpha.2 — session-cumulative totals (per user contract).
  // v0.8.24 — MAX_SAMPLE_API_MS sanity ceiling (inclusive: a tick
  // with apiMs <= 5min is accepted; anything above is rejected so
  // a clock-skew / provider-bug reading cannot pollute the JSONL
  // sample stream or the per-session accApiMs sum). The 5min cap
  // is well above any realistic per-tick API call (typically <60s)
  // but below the "10min pathological" marker.
  return (tick.totalIn ?? 0) > 0 && (tick.totalOut ?? 0) > 0 && tick.apiMs > 0 && tick.apiMs <= MAX_SAMPLE_API_MS;
}

export function beginTick(cwd: string | null, tokens: TokenSnapshot | null): TickState {
  const loaded = cwd ? loadFromDiskInternal(cwd) : {};
  const prevEntry = loaded[PREV_TICK_KEY];
  const prev = prevEntry?.kind === "prevTickStatus" ? prevEntry.value : null;
  const { snapshot, measurement } = normalizeTick(tokens, prev);
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
  // v0.8.10-alpha.2 — flush on dirty regardless of `valid`.
  // Validation gate now governs sample-row emission only
  // (see processTick — `s.sample` stays null on invalid).
  // v1.0 invariant preserved: at most one full-file rewrite per
  // tick (one or zero).
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

// v0.8.10-alpha.2 — peekPrevTick returns just the prev-cursor (the
// one field the next tick subtracts against). Identity match is
// still applied so a stale baseline from a different sessionId is
// masked out.
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
  };
}

export function readAccumulator(
  scope: "session" | "project" | "model",
  args: {
    sessionId?: string | null;
    cwd?: string | null;
    // v0.9.x — active-model id (stdin.model.id). Renamed from
    // modelDisplayName; the per-model slot key namespace now keys
    // off the stable id, not the friendly label.
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
  };
}

// v0.8.10-alpha.2 — render-facing snapshot accessor. Returns the
// current tick's snapshot + the derived apiMs (or EMPTY_TICK when
// no tick is active). Render reads it for speed/apiMs modules and
// pulls per-turn fields straight from here without any
// "delta of two snapshots" math.
export function getDeltaForRender(): TickSnapshot {
  return _tickState?.measurement ?? EMPTY_TICK;
}

// ----- Write-side helpers (compat with old data-processor surface) ------------

export function computeAndCacheTickDeltaPure(
  tokens: TokenSnapshot | null,
): TickSnapshot {
  const prev = _tickState?.prevTick ?? null;
  return normalizeTick(tokens, prev).measurement;
}

// v0.8.10-alpha.2 — setPrevTick now stamps only totalApiMs (the one
// field the next tick subtracts against for `apiMs`). Identity
// (sessionId/cwd/model) is preserved across ticks so peekPrevTick's
// identity-mismatch guard has something to compare against.
//
// v0.8.23+ — `totalDurationMs` joins the cursor alongside
// totalApiMs (added to detectRegression's regression signal).
// setPrevTick's snap payload is preserved (legacy callers thread
// only totalApiMs); the new field is carried forward from the
// prev baseline so a stale setPrevTick call doesn't wipe the
// duration history — the v0.8.11-alpha totalApiMs-only contract
// survives on the snap argument.
export function setPrevTick(
  _sessionId: string,
  snap: PrevTickSnapshot,
  cwd?: string | null,
  identity?: { sessionId?: string | null; cwd?: string | null; model?: string | null; contextUsedPercent?: number | null },
): void {
  void _sessionId;
  if (!cwd) return;
  // v0.8.10-alpha.2 — delegate to writePrevTickStatus so the
  // seed reaches BOTH disk (so the next beginTickForTest's
  // loadFromDiskInternal picks it up) AND the in-memory pending
  // map (so a same-tick setAvg call sees the seed). The earlier
  // mark-only path wrote only to pending, which got clobbered
  // by beginTick's loadFromDiskInternal overwrite.
  const prev = readPrevTickStatus(cwd) ?? emptyPrevTickStatus();
  // v0.8.15-alpha — caller (processTick) stamps the current
  // tick's effective contextUsedPercent into identity. We preserve
  // the prior value when caller omits the field so a future caller
  // that forgets to thread it doesn't accidentally wipe history
  // (a wiped prev.contextUsedPercent would silently disable the
  // carry-over fallback the next tick).
  const nextContextUsedPercent = identity?.contextUsedPercent !== undefined
    ? identity.contextUsedPercent
    : prev.contextUsedPercent;
  writePrevTickStatus(cwd, {
    totalApiMs: snap.totalApiMs,
    // v0.8.23+ — legacy setPrevTick callers don't thread a new
    // duration value; preserve the prev baseline so the cursor
    // is not wiped. processTick's own mark() call writes the
    // fresh value the same tick.
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

export function setAvg(
  sessionId: string,
  snap: AvgSnapshot,
  cwd?: string | null,
  extras?: {
    // v0.9.x — active-model id (stdin.model.id). Renamed from
    // modelDisplayName; per-model slot key now keys off the id.
    modelId?: string | null;
    deltaApiCalls?: number;
    currentApiMs?: number;
    deltaTokenIn?: number;
    deltaTokenOut?: number;
    deltaTokenCachedIn?: number;
    deltaApiMs?: number;
    deltaTokenTotalIn?: number;
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
  // v0.8.24+ — first-write stamp. Stamps Date.now() on the very
  // first write to a session slot (when startAt is null), then
  // preserves the original value across subsequent writes. The
  // session slot only ever has a "first write" moment — there is
  // no regression-reset path here (session identity is bound to
  // sessionId, which doesn't roll over).
  if (sessionNext.startAt == null) {
    sessionNext.startAt = Date.now();
  }
  // v0.8.10-alpha.2 (per user refinement 2026-07-04) —
  // `accTokenTotalIn` is an ACCUMULATE-ADDITIVE accumulator
  // following the same shape as accTokenIn / accTokenOut /
  // accTokenCachedIn:
  //   accTokenTotalIn = accTokenTotalIn + tokenTotalIn
  // The naming convention is `acc<Field>` matching the
  // stdout prefix schema (m_accTokenTotalIn) and the on-disk
  // TickStatusValue field. The "tokenTotalIn" value from
  // stdin IS a per-tick snapshot (NOT cross-tick cumulative),
  // but the ACCUMULATOR aggregates it across ticks for
  // cross-session analytics — that's a deliberate
  // accumulator choice, NOT a semantic confusion with
  // "total_api_duration_ms" which IS truly cross-tick
  // cumulative.
  sessionNext.accTokenIn += snap.accTokenIn;
  sessionNext.accTokenOut += snap.accTokenOut;
  sessionNext.accTokenCachedIn += snap.accTokenCachedIn;
  sessionNext.accApiMs += snap.accApiMs;
  sessionNext.accTokenTotalIn += snap.accTokenTotalIn;
  sessionNext.accApiCalls += snap.accApiCalls;
  // v0.8.10-alpha.3 — recompute accTokenHitRate from the post-add
  // raw accumulators. Persisted to disk on next commit() so the
  // render pipeline can read it straight without recomputing.
  // Formula: accTokenCachedIn / accTokenTotalIn * 100
  sessionNext.accTokenHitRate = sessionNext.accTokenTotalIn > 0
    ? (sessionNext.accTokenCachedIn / sessionNext.accTokenTotalIn) * 100
    : 0;
  mark(sessionKey, sessionNext);

  const bumpDeltaScope = (key: string) => {
    const current = readTickStatus(cwd, key) ?? emptyTickStatus();
    const next: TickStatusValue = { ...current };
    // v0.8.24+ — same first-write stamp rule as the session
    // slot. For project/model, the "first write" branch fires
    // when the slot's startAt is null (no prior history).
    if (next.startAt == null) {
      next.startAt = Date.now();
    }
    next.accTokenIn += deltaTokenIn;
    next.accTokenOut += deltaTokenOut;
    next.accTokenCachedIn += deltaTokenCachedIn;
    next.accApiMs += deltaApiMs;
    // v0.8.10-alpha.2 — session / project / model all accumulate
    // `accTokenTotalIn` additively: `+= tokenTotalIn` per tick,
    // identical to accTokenIn / accTokenOut / accTokenCachedIn.
    next.accTokenTotalIn += deltaTokenTotalIn;
    next.accApiCalls += incrementCalls;
    // v0.8.10-alpha.3 — same derived-field recompute as the
    // session slot. After every scope bump, the cached ratio is
    // refreshed so m_accTokenHitRate can read straight.
    // Formula: accTokenCachedIn / accTokenTotalIn * 100
    next.accTokenHitRate = next.accTokenTotalIn > 0
      ? (next.accTokenCachedIn / next.accTokenTotalIn) * 100
      : 0;
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
): void {
  const s = getState();
  const prevEntry = s.pending[PREV_TICK_KEY];
  const prev = prevEntry?.kind === "prevTickStatus" ? prevEntry.value : null;
  const { snapshot, measurement } = normalizeTick(tokens, prev);
  // v0.8.15-alpha — measurement reflects the freshest normalizeTick
  // result even on invalid ticks. The render path's computeTickDelta
  // reads r.in / r.out here, gated on r.hasMeasurement; surfacing a
  // 0-with-hasMeasurement-false on invalid keeps the line consistent
  // with the prior v1.0 contract (no partial-write visibility to
  // render) rather than carrying the EMPTY_TICK zeros forward.
  s.snapshot = snapshot;
  s.valid = validateNormalizedTick(snapshot);
  s.measurement = measurement;

  // v0.8.29 — Stage 0: cold-slot JSONL replay. For each
  // tickStatus:<dim> slot that has no startAt on disk (state.json
  // was wiped / never existed), scan the JSONL history and
  // re-populate the slot with the recovered aggregate BEFORE
  // setAvg mutates it. The subsequent setAvg will additively
  // merge this tick's delta on top of the recovered base, and
  // commit() flushes everything in a single full-file rewrite
  // (v1.0 invariant preserved).
  //
  // Replay runs even when s.valid is false (invalid tick —
  // cwd + sessionId are still known). The recovered aggregate
  // is the historical truth; the invalid tick's delta is dropped
  // because setAvg is gated on s.valid. If commit() later
  // flushes the slot without this tick's delta, that's the
  // correct outcome — we preserved the historical aggregate
  // without polluting it with a bad row.
  const REPLAY_SCOPES = ["session", "project", "model"] as const;
  if (cwd && tokens?.sessionId) {
    const replayArgs = {
      sessionId: tokens.sessionId,
      cwd,
      // v0.9.x — pass modelId (stdin.model.id) into replayAccKey
      // so the per-model slot key namespace aligns with the new
      // sample.model stamp.
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
        if (process.env.TOPGAUGE_DIAGNOSTICS_ENABLE === "1") {
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

  // v0.8.10-alpha.2 — prev-tick baseline update fires BEFORE the
  // validity guard, so it reaches disk even on an invalid tick
  // (apiMs == -1). The commit gate in commit() is no longer gated
  // on `valid`, so `dirty === true` is sufficient to flush
  // `pending`.

  if (!s.valid || !snapshot || !tokens?.sessionId) {
    s.sample = null;
    return;
  }

  // Stage the prev-cursor. The next tick reads `prev.totalApiMs`
  // to compute `apiMs = current - prev`, `prev.totalDurationMs`
  // to compute the regression signal (see `detectRegression`),
  // and `prev.contextUsedPercent` to substitute a real prior
  // value when stdin mistakenly reports `used_percentage=0`
  // (see applyContextUsedPercentCarryOver).
  // `tokens.contextWindow.contextUsedPercent` is already the
  // post-carry-over value when normalizeTick has run, so reading
  // it here persists the substituted value to disk.
  //
  // v0.8.23+ — totalDurationMs is sourced from stdin
  // `cost.total_duration_ms`. It's a separate counter from
  // totalApiMs (the latter tracks per-call API roundtrips; the
  // former tracks the cc process wall-clock). It increments on
  // every tick and survives longer API-idle gaps, making it a
  // more reliable regression signal — see [[detectRegression-totaldurationms]].
  // When stdin omits the field (older producers), fall back to
  // the prev value so the regression check still has a baseline.
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

  // Accumulators get the current snapshot values straight — no
  // cross-tick subtraction on per-turn fields. `accTokenTotalIn` keeps its
  // own internal last-value semantics (see setAvg) so the user's
  // `m_accTokenIn|field|total` line-template still gets a meaningful
  // delta accumulator.
  // v0.8.10-alpha.3 — accTokenHitRate is pre-computed here (raw
  // accumulators) so the per-session slot READS it directly
  // without recomputation. Stage 4 below refines it on subsequent
  // ticks; this initial value is correct for the very first tick
  // when no prior state exists.
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
    // v0.9.x — pass modelId through to setAvg's per-model slot.
    modelId: tokens.modelId ?? null,
    deltaApiCalls: 1,
    deltaTokenIn: snapshot.in,
    deltaTokenOut: snapshot.out,
    deltaTokenCachedIn: snapshot.hasCachedIn ? snapshot.cachedIn : 0,
    deltaApiMs: snapshot.apiMs,
    deltaTokenTotalIn: snapshot.totalIn ?? 0,
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
          model: snapshot.modelId ?? undefined,
          totalApiMs: snapshot.totalApiMs,
          apiMs: snapshot.apiMs,
          prevApiMs: snapshot.prevTotalApiMs,
          // v0.8.24+ — per-row time anchors. startAt is the
          // per-session first-tick instant (read-once-per-tick
          // from the JSONL head line via resolveFirstTickAt);
          // lastAt mirrors the current row's at so the
          // m_sumStartTime / m_sumEndTime aggregations are
          // self-describing without re-deriving from at.
          startAt: cwd && tokens.sessionId
            ? resolveFirstTickAt(cwd, tokens.sessionId)
            : Date.now(),
          lastAt: Date.now(),
        }
      : null;
}

export function processAndSaveTick(
  cwd: string | null,
  tokens: TokenSnapshot | null,
): ProcessResult {
  beginTick(cwd, tokens);
  processTick(cwd, tokens);
  const s = getState();
  // v0.8.10-alpha.2 — `s.valid` no longer gates flush. Sample-row
  // emission is still gated on `s.valid` (invalid ticks don't have
  // a meaningful row to append).
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
