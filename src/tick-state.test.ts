// v1.0 — tests for the data-processor / tick-state pipeline.
// Data-processing (src/data-processor.ts:processTick) owns all
// writes to pending; tick-state.ts (src/tick-state.ts) is the
// in-memory Store backing those writes plus the on-disk commit.
// Each test isolates to a tmp status.json via setStatusPathResolver
// + __resetForTest, mirroring the harness used by render-tokens.test.ts.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as statusStore from "./status-store.ts";
import type { TokenSnapshot } from "./types.ts";

// Minimal valid TokenSnapshot for the validation-gate tests.
// totalIn > 0 AND totalOut > 0 AND totalApiDurationMs > 0 ⇒ valid.
//
// v0.8.23+ — `totalDurationMs` defaults to 500_000 (well above the
// 120_000 cold-start threshold in detectRegression) so the default
// token set exercises the "post-cold-start" path. Tests that want
// to drive regression detection override `totalDurationMs` per
// case (the default would otherwise suppress regression by
// hitting the cold-start guard).
const validTokens = (overrides: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  sessionId: "sess-test",
  cwd: "D:\\test",
  totals: { tokenTotalIn: 100, tokenTotalOut: 50 },
  current: { tokenIn: 100, tokenOut: 50, tokenCacheCreation: 0, tokenCachedIn: 0 },
  cost: { totalDurationMs: 500_000, totalApiDurationMs: 1000, totalLinesAdded: 0, totalLinesRemoved: 0 },
  ...overrides,
});

let _tmpDir: string;
let _prevConfigDir: string | undefined;

beforeEach(() => {
  _tmpDir = mkdtempSync(join(tmpdir(), "creditgauge-tick-state-"));
  _prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = _tmpDir;
  statusStore.setStatusPathResolver(() => join(_tmpDir, "status.json"));
  statusStore.__resetForTest();
  statusStore.resetTickStateForTest();
});

afterEach(() => {
  if (_prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = _prevConfigDir;
  statusStore.resetStatusPathResolver();
  statusStore.__resetForTest();
  statusStore.resetTickStateForTest();
});

describe("data-processor — pipeline basics", () => {
  it("beginTick + getState returns the seeded TickState", () => {
    const s = statusStore.beginTick("D:\\test", validTokens());
    assert.equal(s.cwd, "D:\\test");
    assert.ok(s.tokens);
    assert.equal(s.valid, true, "valid totals + totalApiMs → valid=true");
    assert.equal(s.dirty, false);
  });

  it("mark() flips dirty + populates pending; commit() flushes", () => {
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.mark("tickStatus:sess-test", statusStore.emptyTickStatus());
    assert.equal(statusStore.getState().dirty, true);
    statusStore.commit();
    assert.ok(existsSync(join(_tmpDir, "status.json")), "status.json written");
    const raw = readFileSync(join(_tmpDir, "status.json"), "utf8");
    const store = JSON.parse(raw) as Record<string, unknown>;
    assert.ok("tickStatus:sess-test" in store, "key persisted");
  });

  it("commit() is a no-op when dirty=false (pristine tick)", () => {
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.commit();
    assert.equal(existsSync(join(_tmpDir, "status.json")), false, "no file written");
  });
});

describe("data-processor — validation gate", () => {
  it("totalIn=0 → invalid (sample skipped, but staged mark flushes through commit)", () => {
    // v0.8.10-alpha.2 snapshot contract: commit() no longer
    // gates on `valid`. Staged marks (regression-reset, prev
    // baseline update) flush even when the validation gate
    // rejects the tick. Sample append (the JSONL row) is the
    // *only* thing skipped on invalid ticks.
    statusStore.beginTick("D:\\test", validTokens({
      totals: { tokenTotalIn: 0, tokenTotalOut: 50 },
    }));
    assert.equal(statusStore.getState().valid, false);
    statusStore.mark("tickStatus:sess-test", statusStore.emptyTickStatus());
    statusStore.commit();
    assert.equal(existsSync(join(_tmpDir, "status.json")), true,
      "v0.8.10-alpha.2 — invalid tick still flushes staged marks through commit");
  });

  it("totalOut=0 → invalid", () => {
    statusStore.beginTick("D:\\test", validTokens({
      totals: { tokenTotalIn: 100, tokenTotalOut: 0 },
    }));
    assert.equal(statusStore.getState().valid, false);
  });

  it("totalApiDurationMs=0 on first tick → apiMs back-derives from tokenOut → valid (v0.8.10-alpha.2 contract)", () => {
    // v0.8.10-alpha.2 (per user refinement 2026-07-04): when
    // there is no previous tick and totalApiDurationMs=0,
    // apiMs is back-derived via tokenOut * 1000 / 50 (the
    // v0.4.x legacy fallback). For default totalOut=50 that
    // yields apiMs=1000 > 0, so the tick IS valid.
    statusStore.beginTick("D:\\test", validTokens({
      cost: { totalDurationMs: 1000, totalApiDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0 },
    }));
    assert.equal(statusStore.getState().valid, true);
  });

  // v0.8.11-alpha → v0.8.23: regression detection is decoupled
  // from sessionId identity. Stale PREV_TICK carry-overs from a
  // prior session must STILL trigger the ccsession reset when the
  // totalDurationMs time-series rolls backward, otherwise the
  // accumulator keeps the prior session's totals forever.
  //
  // v0.8.23+: signal switched from `totalApiMs` to
  // `totalDurationMs` with a 120_000 ms cold-start guard. Both
  // prev and current must be ≥ 120_000 to exercise the
  // post-cold-start path. prev (600_000) > current (300_000)
  // triggers the regression.
  it("regression fires even when prev.sessionId differs from current (stale carry-over)", () => {
    // Seed a prev tick with totalDurationMs=600_000 from
    // session "old-sess".
    statusStore.beginTick("D:\\test", validTokens({
      cost: { totalDurationMs: 600_000, totalApiDurationMs: 1000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    }));
    statusStore.mark(statusStore.PREV_TICK_KEY, {
      ...statusStore.emptyPrevTickStatus(),
      totalApiMs: 1000,
      totalDurationMs: 600_000,
      sessionId: "old-sess",
      cwd: "D:\\test",
      model: null,
    });
    statusStore.commit();

    // New session, totalDurationMs dropped (process restart).
    // The baseline is nulled (no meaningful cross-session
    // subtract) but the regression-reset MUST still fire on
    // the ccsession slot.
    statusStore.resetTickStateForTest();
    statusStore.beginTick("D:\\test", validTokens({
      cost: { totalDurationMs: 300_000, totalApiDurationMs: 200, totalLinesAdded: 0, totalLinesRemoved: 0 },
      sessionId: "new-sess",
    }));
    assert.equal(
      statusStore.getState().snapshot?.invalidRegression, true,
      "regression fires across sessionId mismatch",
    );
  });

  // v0.8.23+ — cold-start guard: when current.totalDurationMs
  // is under 120_000 ms (a brand-new cc process whose prev
  // baseline is from a prior process), detectRegression MUST
  // suppress the regression flag. Without this guard, every
  // fresh cc cold start would falsely zero the ccsession
  // accumulator.
  it("regression suppressed on cold start (current.totalDurationMs < 120_000)", () => {
    // Seed a prev tick with a high totalDurationMs from a
    // prior session.
    statusStore.beginTick("D:\\test", validTokens({
      cost: { totalDurationMs: 600_000, totalApiDurationMs: 1000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    }));
    statusStore.mark(statusStore.PREV_TICK_KEY, {
      ...statusStore.emptyPrevTickStatus(),
      totalApiMs: 1000,
      totalDurationMs: 600_000,
      sessionId: "old-sess",
      cwd: "D:\\test",
      model: null,
    });
    statusStore.commit();

    // New session, fresh cc process. current.totalDurationMs
    // is sub-2-minute — prev.totalDurationMs is from a prior
    // process. Cold-start guard should suppress the
    // regression flag.
    statusStore.resetTickStateForTest();
    statusStore.beginTick("D:\\test", validTokens({
      cost: { totalDurationMs: 60_000, totalApiDurationMs: 200, totalLinesAdded: 0, totalLinesRemoved: 0 },
      sessionId: "new-sess",
    }));
    assert.equal(
      statusStore.getState().snapshot?.invalidRegression, false,
      "cold-start guard suppresses backward jump from prior process",
    );
  });

  it("null tokens → invalid (parse failure path)", () => {
    statusStore.beginTick("D:\\test", null);
    assert.equal(statusStore.getState().valid, false);
  });

  it("null cwd → valid (commit gates on cwd, not validation)", () => {
    // The validation gate runs on tokens only — cwd=null is
    // commit's concern (commit skips when cwd=null). Validating
    // with valid tokens + null cwd returns valid=true so the
    // in-memory pending map is still consumable by tests.
    statusStore.beginTick(null, validTokens());
    assert.equal(statusStore.getState().valid, true);
    statusStore.mark("tickStatus:sess-test", statusStore.emptyTickStatus());
    statusStore.commit(); // cwd=null → no disk write
    assert.equal(existsSync(join(_tmpDir, "status.json")), false);
  });
});

describe("data-processor — one-write-per-active-tick", () => {
  it("4 mark() calls + commit → 1 disk write of the merged store", () => {
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.mark("tickStatus:sess-test", statusStore.emptyTickStatus());
    statusStore.mark("lastActive:in", { direction: "in", tps: 12.5 });
    statusStore.mark("lastActive:out", { direction: "out", tps: 8.3 });
    statusStore.mark(statusStore.PREV_TICK_KEY, statusStore.emptyPrevTickStatus());
    statusStore.commit();

    // The on-disk file should be a single JSON object with all 4 keys.
    // (Pre-ccsession-removal this was 5 — the ccsession mark no
    // longer exists.)
    const raw = readFileSync(join(_tmpDir, "status.json"), "utf8");
    const store = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(
      Object.keys(store).length, 4,
      "exactly 4 entries persisted in one write",
    );
  });
});

describe("data-processor — crash-before-flush", () => {
  it("mark + resetTickStateForTest (no commit) → disk unchanged", () => {
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.mark("tickStatus:sess-test", statusStore.emptyTickStatus());
    // Simulate a crash: clear state without commit.
    statusStore.resetTickStateForTest();
    assert.equal(
      existsSync(join(_tmpDir, "status.json")), false,
      "no file written — write is deferred to commit",
    );
  });
});

describe("data-processor — concurrent-overlay commit (m_template nesting)", () => {
  // m_template creates inner render contexts; mark() calls from
  // the inner overlay must NOT cause the outer mark to lose its
  // value at commit time. The contract: pending is a flat Map;
  // the LAST mark() before commit wins per key (inner sees its
  // own overlay, outer replaces when its own mark lands).
  it("inner mark overlays, outer mark replaces — outer's value wins", () => {
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.mark("tickStatus:sess-test", { ...statusStore.emptyTickStatus(), accTokenIn: 100 });
    statusStore.mark("tickStatus:sess-test", { ...statusStore.emptyTickStatus(), accTokenIn: 200 });
    statusStore.commit();
    const raw = readFileSync(join(_tmpDir, "status.json"), "utf8");
    const store = JSON.parse(raw) as Record<string, { value: { accTokenIn: number } }>;
    assert.equal(store["tickStatus:sess-test"]?.value.accTokenIn, 200, "outer wins");
  });
});

describe("data-processor — getState throws without beginTick", () => {
  it("getState() with no prior beginTick throws a clear error", () => {
    assert.throws(() => statusStore.getState(), /without beginTick\(\)/);
  });
});

// v0.8.15-alpha — stdin-side error guard for context_window.used_percentage.
// Some stdins from error states surface `used_percentage=0` instead of
// `null`. The previous pipeline propagated the 0 straight to render,
// which displayed a misleading "0%". The fix: beginTick's normalizeTick
// path now substitutes the prev tick's contextUsedPercent when stdin
// reports exactly 0 AND prev has a usable value. Pinned cases:
//   - prev=null → stdin=0 stays 0 (no history to lie about)
//   - prev=null → stdin=null stays null (real "no data")
//   - prev=N   → stdin=0 substitutes N
//   - prev=N   → stdin=N keeps N
//   - prev=null → stdin=N keeps N
describe("data-processor — contextUsedPercent=0 carry-over (v0.8.15-alpha)", () => {
  // Wrap validTokens so each test can produce a fresh snapshot with
  // a chosen contextWindow; the helper spreads overrides cleanly.
  const tokensWithCw = (cw: { contextWindowSize: number | null; contextUsedPercent: number | null; contextRemainingPercent: number | null } | null): TokenSnapshot =>
    validTokens({ contextWindow: cw ?? undefined });

  it("first tick: prev=null + stdin=0 → stdin stays 0 (no history to substitute)", () => {
    // No prior prev tick — the normalization must NOT fabricate a
    // value. The renderer still surfaces "0%" so the user can see
    // the upstream probe reported a literal zero.
    const t = tokensWithCw({ contextWindowSize: 200000, contextUsedPercent: 0, contextRemainingPercent: 100 });
    statusStore.beginTick("D:\\test", t);
    assert.equal(t.contextWindow!.contextUsedPercent, 0,
      "v0.8.15-alpha — no prev → stdin 0 is preserved as-is");
  });

  it("first tick: prev=null + stdin=null → stdin stays null (real no-data)", () => {
    const t = tokensWithCw({ contextWindowSize: 200000, contextUsedPercent: null, contextRemainingPercent: null });
    statusStore.beginTick("D:\\test", t);
    assert.equal(t.contextWindow!.contextUsedPercent, null);
  });

  it("first tick: prev=null + stdin=63 → stdin stays 63 (normal)", () => {
    const t = tokensWithCw({ contextWindowSize: 200000, contextUsedPercent: 63, contextRemainingPercent: 37 });
    statusStore.beginTick("D:\\test", t);
    assert.equal(t.contextWindow!.contextUsedPercent, 63);
  });

  it("carry-over: prev=63 + stdin=0 → tokens mutated to 63 in-place", () => {
    // Seed prev via writePrevTickStatus so the next beginTick's
    // loadFromDiskInternal picks it up.
    statusStore.writePrevTickStatus("D:\\test", {
      ...statusStore.emptyPrevTickStatus(),
      totalApiMs: 1000,
      sessionId: "sess-test",
      cwd: "D:\\test",
      model: null,
      contextUsedPercent: 63,
    });
    statusStore.resetTickStateForTest();

    const t = tokensWithCw({ contextWindowSize: 200000, contextUsedPercent: 0, contextRemainingPercent: 100 });
    statusStore.beginTick("D:\\test", t);
    assert.equal(t.contextWindow!.contextUsedPercent, 63,
      "v0.8.15-alpha — stdin 0 substituted by prev 63 (in-place mutate)");
  });

  it("carry-over: prev=63 + stdin=63 → stdin keeps 63 (no substitution)", () => {
    statusStore.writePrevTickStatus("D:\\test", {
      ...statusStore.emptyPrevTickStatus(),
      totalApiMs: 1000,
      sessionId: "sess-test",
      cwd: "D:\\test",
      model: null,
      contextUsedPercent: 63,
    });
    statusStore.resetTickStateForTest();

    const t = tokensWithCw({ contextWindowSize: 200000, contextUsedPercent: 63, contextRemainingPercent: 37 });
    statusStore.beginTick("D:\\test", t);
    assert.equal(t.contextWindow!.contextUsedPercent, 63,
      "v0.8.15-alpha — normal >0 path bypasses substitution");
  });

  it("processTick writes the substituted value into PREV_TICK_KEY", () => {
    // End-to-end: stdin 0 with prev=63 → processTick stamps 63 (the
    // post-substitution value, not the original stdin 0) into the
    // pending PREV_TICK_KEY, so the next tick's prev carries 63
    // again rather than the bad stdin 0.
    statusStore.writePrevTickStatus("D:\\test", {
      ...statusStore.emptyPrevTickStatus(),
      totalApiMs: 1000,
      sessionId: "sess-test",
      cwd: "D:\\test",
      model: null,
      contextUsedPercent: 63,
    });
    statusStore.resetTickStateForTest();

    const t = tokensWithCw({ contextWindowSize: 200000, contextUsedPercent: 0, contextRemainingPercent: 100 });
    // Bump totalApiMs so the tick is not a regression (otherwise
    // the regression-reset mark would fire before our read).
    // v0.8.23+ — totalDurationMs also above the 120_000
    // cold-start threshold, in the same direction as the prev
    // baseline, so neither the v0.8.x apiMs nor the v0.8.23+
    // durationMs comparison can flag a regression.
    t.cost = { totalDurationMs: 500_000, totalApiDurationMs: 2000, totalLinesAdded: 0, totalLinesRemoved: 0 };
    statusStore.beginTick("D:\\test", t);
    statusStore.processTick("D:\\test", t);

    const s = statusStore.getState();
    const prev = s.pending[statusStore.PREV_TICK_KEY];
    assert.ok(prev && prev.kind === "prevTickStatus");
    assert.equal(prev!.value.contextUsedPercent, 63,
      "v0.8.15-alpha — processTick stamps post-substitution value (63), not raw stdin 0");
  });

  it("parseStore: legacy on-disk prevTickStatus without contextUsedPercent → null", () => {
    // Manually write a legacy state.json (a pre-v0.8.15-alpha
    // prevTickStatus entry that omits the new field) and confirm
    // loadFromDiskInternal backfills `null` rather than crashing
    // or synthesizing a number.
    const path = join(_tmpDir, "status.json");
    writeFileSync(path, JSON.stringify({
      [statusStore.PREV_TICK_KEY]: {
        at: Date.now(),
        value: {
          totalApiMs: 500,
          sessionId: "sess-legacy",
          cwd: "D:\\test",
          model: null,
          // — contextUsedPercent intentionally absent —
        },
      },
    }));
    statusStore.__resetForTest();

    const loaded = statusStore.readPrevTickStatus("D:\\test");
    assert.ok(loaded);
    assert.equal(loaded!.contextUsedPercent, null,
      "v0.8.15-alpha — missing field on legacy row backfills null");
  });
});

// v0.8.24 — sanity ceiling on the per-tick apiMs sample. The
// validation gate (src/status-store.ts:validateNormalizedTick)
// rejects samples with apiMs >= MAX_SAMPLE_API_MS so a single
// pathological stdin reading (clock skew, provider bug, stale
// baseline) cannot pollute the JSONL sample stream / the
// accApiMs accumulator. Pinned here so future constant changes
// surface in tests, not in production diagnostics.
//
// IMPORTANT: on the FIRST tick (no prev baseline), normalizeTick
// back-derives apiMs from tokenOut via `(out * 1000) / 50`
// (v0.8.10-alpha.2 fallback). To exercise the gate with a
// controlled apiMs value, each test seeds a prev tick with
// totalApiMs=0 first, so the next beginTick computes
// apiMs = totalApiMs - prevTotalApiMs = totalApiMs.
describe("data-processor — MAX_SAMPLE_API_MS sanity ceiling (v0.8.24)", () => {
  // Lock the constant value via an explicit import. If someone
  // bumps the constant, the test that asserts equality below
  // goes red so the intent is preserved (vs. silently testing a
  // different boundary).
  const { MAX_SAMPLE_API_MS } = statusStore;

  // Seed a prev tick with totalApiMs=0 so the next tick's
  // apiMs = totalApiMs - 0 = totalApiMs (no back-derivation).
  // totalDurationMs=500_000 (well above the 120_000 cold-start
  // threshold) keeps the regression detector quiet.
  const seedPrevBaseline = (): void => {
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.mark(statusStore.PREV_TICK_KEY, {
      ...statusStore.emptyPrevTickStatus(),
      totalApiMs: 0,
      totalDurationMs: 500_000,
      sessionId: "sess-test",
      cwd: "D:\\test",
      model: null,
    });
    statusStore.commit();
    statusStore.resetTickStateForTest();
  };

  it("apiMs = MAX_SAMPLE_API_MS → valid (boundary, inclusive upper bound)", () => {
    // The gate is `tick.apiMs <= MAX_SAMPLE_API_MS` (inclusive),
    // so the boundary value itself is still accepted. The gate
    // fires on the next ms above. This matches the contract
    // documented at src/status-store.ts:MAX_SAMPLE_API_MS.
    seedPrevBaseline();
    statusStore.beginTick("D:\\test", validTokens({
      cost: { totalDurationMs: 500_000, totalApiDurationMs: MAX_SAMPLE_API_MS, totalLinesAdded: 0, totalLinesRemoved: 0 },
    }));
    assert.equal(statusStore.getState().valid, true,
      "v0.8.24 — apiMs at the ceiling is accepted by the sanity gate");
  });

  it("apiMs = MAX_SAMPLE_API_MS + 1 → invalid (one above the ceiling)", () => {
    seedPrevBaseline();
    statusStore.beginTick("D:\\test", validTokens({
      cost: { totalDurationMs: 500_000, totalApiDurationMs: MAX_SAMPLE_API_MS + 1, totalLinesAdded: 0, totalLinesRemoved: 0 },
    }));
    assert.equal(statusStore.getState().valid, false,
      "v0.8.24 — apiMs one ms above the ceiling is rejected");
  });

  it("apiMs = 10 * MAX_SAMPLE_API_MS → invalid (far above ceiling)", () => {
    // A truly pathological reading (10× the 5min ceiling = 50min
    // of "apiMs" — far beyond any reasonable per-tick duration).
    // Must be rejected so it cannot contaminate the per-session
    // accApiMs sum.
    seedPrevBaseline();
    statusStore.beginTick("D:\\test", validTokens({
      cost: { totalDurationMs: 500_000, totalApiDurationMs: 10 * MAX_SAMPLE_API_MS, totalLinesAdded: 0, totalLinesRemoved: 0 },
    }));
    assert.equal(statusStore.getState().valid, false,
      "v0.8.24 — apiMs far above the ceiling is rejected");
  });
});

// v0.8.24 — startAt field on TickStatusValue / AvgSnapshot.
// The slot's "first-write" wall-clock instant. Read by
// m_accStartTime (per-slot) and (in aggregated form) by
// m_sumStartTime (cross-project min over JSONL rows). All three
// surviving slots (session / project / model) are stamped once
// on the first valid write and never refreshed — there's no
// roll-over semantic for those. (Pre-cleanup ccsession used to
// refresh on detectRegression; that scope was REMOVED.)
describe("data-processor — startAt first-write stamp (v0.8.24)", () => {
  it("setAvg first-write stamps startAt = Date.now() on a fresh session slot", () => {
    // setAvg's mark() call requires a prior beginTick to
    // initialize the in-memory pending map. Use a
    // beginTick("D:\\test", validTokens()) to set up the tick
    // (commit() is skipped — invalid tokens are fine, we just
    // need a cwd-bearing tick).
    const before = Date.now();
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.setAvg(
      "sess-fresh",
      {
        accTokenIn: 100,
        accTokenOut: 50,
        accTokenCachedIn: 0,
        accApiMs: 1000,
        accApiCalls: 1,
        accTokenTotalIn: 100,
        accTokenHitRate: 0,
      },
      "D:\\test",
    );
    const after = Date.now();
    const got = statusStore.peekAvg("sess-fresh", "D:\\test");
    assert.ok(got, "slot exists after first write");
    assert.ok(got!.startAt != null, "v0.8.24 — startAt stamped on first write");
    assert.ok(
      got!.startAt! >= before && got!.startAt! <= after,
      "startAt is within the first-write window",
    );
  });

  it("setAvg subsequent writes preserve the original startAt", () => {
    // First tick: write + commit so the slot is on disk.
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.setAvg(
      "sess-stick",
      {
        accTokenIn: 100, accTokenOut: 50, accTokenCachedIn: 0,
        accApiMs: 1000, accApiCalls: 1, accTokenTotalIn: 100, accTokenHitRate: 0,
      },
      "D:\\test",
    );
    statusStore.commit();
    const first = statusStore.peekAvg("sess-stick", "D:\\test")!.startAt;
    assert.ok(first != null);

    // Reset the in-memory store + tickState so the next tick
    // re-reads from disk (mirrors the per-tick child process
    // re-launch boundary).
    statusStore.resetTickStateForTest();
    statusStore.__resetForTest();

    // Wait a tick boundary.
    const start = Date.now();
    while (Date.now() === start) { /* spin 1ms */ }

    // Second tick: a fresh beginTick + setAvg. The on-disk
    // session slot still has startAt from the first write, so
    // readTickStatus returns the prior value and the
    // first-write stamp does NOT re-fire.
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.setAvg(
      "sess-stick",
      {
        accTokenIn: 200, accTokenOut: 100, accTokenCachedIn: 0,
        accApiMs: 2000, accApiCalls: 2, accTokenTotalIn: 200, accTokenHitRate: 0,
      },
      "D:\\test",
    );
    const second = statusStore.peekAvg("sess-stick", "D:\\test")!.startAt;
    assert.equal(second, first, "v0.8.24 — subsequent write preserves startAt");
  });

  // (Case "ccsession regression-reset refreshes startAt" was
  // REMOVED in this revision along with the ccsession scope
  // itself. The regression-reset path now only refreshes the
  // in-memory pending map for the surviving three scopes —
  // session / project / model — which have no roll-over
  // semantic, so the test no longer applies.)

  it("parseStore backfills startAt: null for legacy state.json rows", () => {
    // Hand-craft a legacy row (no startAt field) at the session
    // key, write it to disk, then read it back via peekAvg. The
    // legacy row MUST include `at` (parseStore rejects rows
    // without a numeric `at` — the wall-clock instant the row
    // was written). Pre-v0.8.24 rows on disk have `at` from the
    // existing setAvg / writeTickStatus path; only `startAt` is
    // net-new.
    const legacyRow = {
      at: Date.now(),
      kind: "tickStatus",
      value: {
        accTokenIn: 100, accTokenOut: 50, accTokenCachedIn: 0,
        accApiMs: 1000, accApiCalls: 1, accTokenTotalIn: 100, accTokenHitRate: 0,
        // startAt: <absent on purpose>
      },
    };
    const key = "tickStatus:sess-legacy";
    const store: Record<string, unknown> = { [key]: legacyRow };
    writeFileSync(join(_tmpDir, "status.json"), JSON.stringify(store), "utf8");
    statusStore.__resetForTest();
    statusStore.resetTickStateForTest();

    const got = statusStore.peekAvg("sess-legacy", "D:\\test");
    assert.ok(got, "legacy row loaded");
    assert.equal(got!.startAt, null, "v0.8.24 — legacy startAt backfilled to null");
  });
});
