// v0.8.29 — tests for the cold-slot JSONL replay path.
//
// When state.json is missing (fresh install, after `:clean
// --purge-runtime`, accidental deletion), the new `replayAccInit`
// helper reconstructs the tickStatus:<dim> slot from the JSONL
// history before setAvg mutates it. These tests exercise the full
// Stage 0 → setAvg → commit → read path with realistic fixtures.
//
// Harness mirrors tick-state.test.ts: setStatusPathResolver routes
// every cwd to a single tmp file (ignores real state layout), but
// setStateRoot routes the JSONL sample IO to a sibling tmp dir
// (matches the real `state/<projectHash>/<sessionId>.jsonl` shape).
//
// Why two tmp roots: statusPathResolver ignores cwd (every cwd
// writes to the same status.json) so per-tick state isolation
// doesn't need per-cwd directories. JSONL sample IO goes through
// the real stateRoot()/projectHash() path so the
// readSamples/readAllSamples/readProjectSamples walkers see the
// real on-disk shape.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as statusStore from "./status-store.ts";
import type { TokenSample, TokenSnapshot } from "./types.ts";

// Minimal valid TokenSnapshot (mirrors tick-state.test.ts harness).
const validTokens = (overrides: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  sessionId: "sess-test",
  cwd: "D:\\test",
  totals: { tokenTotalIn: 100, tokenTotalOut: 50 },
  current: { tokenIn: 100, tokenOut: 50, tokenCacheCreation: 0, tokenCachedIn: 0 },
  cost: { totalDurationMs: 500_000, totalApiDurationMs: 1000, totalLinesAdded: 0, totalLinesRemoved: 0 },
  ...overrides,
});

// Build a TokenSample with deterministic numeric fields. Each row
// contributes its (in, out, cacheIn, apiMs) to the replayed
// aggregate; calls is the count of apiMs>0 rows.
const makeSample = (overrides: Partial<TokenSample> = {}): TokenSample => ({
  at: 1_000_000,
  totalIn: 100,
  totalOut: 50,
  in: 100,
  out: 50,
  cacheIn: 0,
  cacheCreation: 0,
  apiMs: 1000,
  ...overrides,
});

let _tmpDir: string;
let _stateRootDir: string;
let _prevConfigDir: string | undefined;
let _prevDiagEnv: string | undefined;

beforeEach(() => {
  _tmpDir = mkdtempSync(join(tmpdir(), "creditgauge-replay-status-"));
  _stateRootDir = mkdtempSync(join(tmpdir(), "creditgauge-replay-state-"));
  _prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  _prevDiagEnv = process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
  process.env.CLAUDE_CONFIG_DIR = _tmpDir;
  // Route JSONL sample IO to the test root; per-project subdirs
  // get auto-created via mkdirSync in appendSample.
  statusStore.setStateRoot(() => _stateRootDir);
  statusStore.setStatusPathResolver(() => join(_tmpDir, "status.json"));
  statusStore.setStatCachePathResolver(() => join(_tmpDir, "stat-cache.json"));
  statusStore.__resetForTest();
  statusStore.resetTickStateForTest();
  statusStore.__resetStatCacheForTest();
});

afterEach(() => {
  if (_prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = _prevConfigDir;
  if (_prevDiagEnv === undefined) delete process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
  else process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE = _prevDiagEnv;
  statusStore.resetStateRoot();
  statusStore.resetStatusPathResolver();
  statusStore.resetStatCachePathResolver();
  statusStore.__resetForTest();
  statusStore.resetTickStateForTest();
  statusStore.__resetStatCacheForTest();
  // Wipe tmp dirs (best-effort; some OSes hold locks briefly).
  try { rmSync(_tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  try { rmSync(_stateRootDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("status-store — v0.8.29 cold-slot JSONL replay", () => {
  // ----- 1. Cold session slot, JSONL has rows -----
  it("cold session slot replays from JSONL: accTokenIn = sum of 3 rows + this tick", () => {
    // Seed JSONL with 3 rows in the matching <sid>.jsonl.
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_001, in: 100, out: 50, apiMs: 1000, startAt: 900_000 }));
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_002, in: 200, out: 80, apiMs: 1500, startAt: 900_000 }));
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_003, in: 50, out: 30, apiMs: 500, startAt: 900_000 }));

    // No state.json exists → beginTick loads {} → all slots cold.
    // The validTokens default is tokenIn=100, tokenOut=50, apiMs=1000.
    // processAndSaveTick:
    //   1. Stage 0 replay reads 3 rows → marks slot with 350/160/3
    //   2. setAvg adds this tick (tokenIn=100, tokenOut=50, calls=1)
    //   3. commit → state.json flushed with the merged value
    //   4. appendSample → this tick's row appended (now 4 rows in JSONL)
    statusStore.processAndSaveTick("D:\\test", validTokens());

    // Replayed (350) + this-tick (100) = 450. The new JSONL row
    // appended at step 4 is NOT included in the replay — replay ran
    // BEFORE the append. So the slot's value is replay_sum + delta.
    const slot = statusStore.readAccumulator("session", {
      sessionId: "sess-test",
      cwd: "D:\\test",
    });
    assert.ok(slot, "session slot exists after replay + setAvg");
    assert.equal(slot!.accTokenIn, 100 + 200 + 50 + 100, "replayed (350) + this-tick delta (100)");
    assert.equal(slot!.accTokenOut, 50 + 80 + 30 + 50, "replayed (160) + this-tick delta (50)");
    assert.equal(slot!.accApiCalls, 3 + 1, "3 JSONL rows + 1 this-tick call");
    assert.equal(slot!.startAt, 900_000, "min(row.startAt) preserved across replay");
  });

  // ----- 2. Cold project slot, JSONL across 2 sessions under same projectHash -----
  it("cold project slot aggregates across multiple sessions in the same projectHash", () => {
    // Two sessions under the same cwd (different sids, same
    // projectHash). Project slot should sum both.
    statusStore.appendSample("D:\\test", "sess-A", makeSample({ at: 1_000_001, in: 100, out: 50, apiMs: 1000, startAt: 800_000 }));
    statusStore.appendSample("D:\\test", "sess-A", makeSample({ at: 1_000_002, in: 50, out: 20, apiMs: 500, startAt: 800_000 }));
    statusStore.appendSample("D:\\test", "sess-B", makeSample({ at: 1_000_003, in: 200, out: 100, apiMs: 2000, startAt: 850_000 }));
    statusStore.appendSample("D:\\test", "sess-B", makeSample({ at: 1_000_004, in: 75, out: 25, apiMs: 750, startAt: 850_000 }));
    statusStore.appendSample("D:\\test", "sess-B", makeSample({ at: 1_000_005, in: 25, out: 10, apiMs: 250, startAt: 850_000 }));

    statusStore.processAndSaveTick("D:\\test", validTokens({ sessionId: "sess-A" }));

    const slot = statusStore.readAccumulator("project", { cwd: "D:\\test" });
    assert.ok(slot, "project slot exists after replay");
    // Project slot sums ALL 5 seeded rows under state/<hash>/.
    // Plus this-tick delta (tokenIn=100, tokenOut=50, calls=1).
    assert.equal(slot!.accTokenIn, 100 + 50 + 200 + 75 + 25 + 100, "5 JSONL rows + this-tick");
    assert.equal(slot!.accTokenOut, 50 + 20 + 100 + 25 + 10 + 50, "5 JSONL rows + this-tick");
    assert.equal(slot!.accApiCalls, 5 + 1, "5 JSONL rows + 1 this-tick call");
    // min(startAt) = 800_000 (sess-A rows)
    assert.equal(slot!.startAt, 800_000, "min(startAt) across all project rows");
  });

  // ----- 3. Cold model slot, JSONL has rows for multiple models -----
  it("cold model slot filters by sample.model", () => {
    statusStore.appendSample("D:\\test", "sess-X", makeSample({ at: 1_000_001, in: 100, out: 50, apiMs: 1000, model: "model-A", startAt: 700_000 }));
    statusStore.appendSample("D:\\test", "sess-X", makeSample({ at: 1_000_002, in: 200, out: 100, apiMs: 2000, model: "model-A", startAt: 700_000 }));
    statusStore.appendSample("D:\\test", "sess-X", makeSample({ at: 1_000_003, in: 999, out: 999, apiMs: 9999, model: "model-B", startAt: 750_000 }));
    statusStore.appendSample("D:\\test", "sess-X", makeSample({ at: 1_000_004, in: 50, out: 25, apiMs: 500, model: "model-A", startAt: 700_000 }));

    statusStore.processAndSaveTick("D:\\test", validTokens({ modelId: "model-A" }));

    const slot = statusStore.readAccumulator("model", {
      modelId: "model-A",
      cwd: "D:\\test",
    });
    assert.ok(slot, "model-A slot exists after replay");
    // Only model-A rows: 100 + 200 + 50 = 350 in. The model-B row (999)
    // must NOT contaminate the model-A aggregate. Plus this tick
    // (modelDisplayName="model-A", tokenIn=100) = 350 + 100.
    assert.equal(slot!.accTokenIn, 100 + 200 + 50 + 100, "only model-A rows + this-tick");
    assert.equal(slot!.accApiCalls, 3 + 1, "3 model-A rows + 1 this-tick call");
    assert.equal(slot!.startAt, 700_000, "min(startAt) for model-A rows");
  });

  // ----- 4. Warm slot present: replay short-circuits, user's value preserved -----
  it("warm slot (startAt != null): replay short-circuits, value preserved", () => {
    // Seed JSONL with rows that would aggregate to one value, then
    // also seed state.json with a warm slot that has a DIFFERENT
    // value (the user's "confirmed" number). Replay must NOT
    // overwrite the warm value.
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_001, in: 100, out: 50, apiMs: 1000, startAt: 600_000 }));
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_002, in: 200, out: 100, apiMs: 2000, startAt: 600_000 }));

    // Pre-seed state.json with a warm slot using a sentinel value.
    const statePath = join(_tmpDir, "status.json");
    writeFileSync(statePath, JSON.stringify({
      "tickStatus:sess-test": {
        at: 1,
        kind: "tickStatus",
        value: {
          accTokenIn: 999_999,
          accTokenOut: 0,
          accTokenCachedIn: 0,
          accTokenTotalIn: 0,
          accApiMs: 0,
          accApiCalls: 0,
          accTokenHitRate: 0,
          startAt: 500_000,
        },
      },
    }), "utf8");

    statusStore.processAndSaveTick("D:\\test", validTokens());

    const slot = statusStore.readAccumulator("session", {
      sessionId: "sess-test",
      cwd: "D:\\test",
    });
    assert.ok(slot, "session slot exists");
    // Warm value (999_999) preserved; JSONL's 300 (100+200) ignored.
    assert.equal(slot!.accTokenIn, 999_999 + 100, "warm value preserved + this-tick delta");
    assert.equal(slot!.startAt, 500_000, "warm startAt preserved (not overwritten by min(startAt))");
  });

  // ----- 5. Cold slot, empty JSONL: replay returns null, no mark() -----
  it("cold slot + empty JSONL: replay returns null, setAvg populates from this tick only", () => {
    // No JSONL rows seeded. state.json is also missing. beginTick
    // loads {}; replay finds no samples, returns null, no mark();
    // setAvg seeds the slot from this tick's delta alone.
    statusStore.processAndSaveTick("D:\\test", validTokens());

    const slot = statusStore.readAccumulator("session", {
      sessionId: "sess-test",
      cwd: "D:\\test",
    });
    assert.ok(slot, "slot exists after setAvg");
    // Only the current tick's contribution: tokenIn=100, tokenOut=50.
    assert.equal(slot!.accTokenIn, 100, "single-tick contribution only");
    assert.equal(slot!.accTokenOut, 50, "single-tick contribution only");
    assert.equal(slot!.accApiCalls, 1, "single-tick call count");
    // startAt stamped by setAvg's first-write branch (Date.now()).
    assert.ok(slot!.startAt != null, "startAt stamped by setAvg");
  });

  // (Case 6 — ccsession is NEVER replayed: REMOVED in this revision
  // along with the ccsession scope itself. The remaining three
  // scopes (session / project / model) are all in REPLAY_SCOPES.)

  // ----- 7. Invalid tick (no sessionId) → replay short-circuits at the gate -----
  it("invalid tick (sessionId missing): replay short-circuits, no JSONL read", () => {
    // Seed JSONL so a successful replay would observe 270 rows.
    for (let i = 0; i < 270; i++) {
      statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_001 + i, in: 10, out: 5, apiMs: 100, startAt: 300_000 }));
    }

    // sessionId is undefined → the `if (cwd && tokens?.sessionId)` gate
    // blocks the entire REPLAY_SCOPES loop.
    statusStore.processAndSaveTick("D:\\test", validTokens({ sessionId: undefined }));

    // No slot exists because processTick bailed on the validity gate
    // before setAvg fired. Replay also did not fire (gated on sessionId).
    const slot = statusStore.readAccumulator("session", {
      sessionId: "sess-test",
      cwd: "D:\\test",
    });
    assert.equal(slot, null, "no slot — replay gated, setAvg gated");
  });

  // (Case 8 — ccsession regression-reset interplay: REMOVED in this
  // revision along with the ccsession scope itself.)

  // ----- 9a. startAt edge case: all rows have startAt=null → Date.now() fallback -----
  it("startAt: all rows have startAt=null → replayed startAt = Date.now() (Date.now() fallback)", () => {
    // Rows are pre-v0.8.24 (no startAt field) — coerceSampleRow
    // backfills startAt=null. The replay loop must fall back to
    // row.at for these (or Date.now() if at is also bad).
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_001, in: 100, out: 50, apiMs: 1000, startAt: null }));
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_002, in: 50, out: 25, apiMs: 500, startAt: null }));

    const before = Date.now();
    statusStore.processAndSaveTick("D:\\test", validTokens());
    const after = Date.now();

    const slot = statusStore.readAccumulator("session", {
      sessionId: "sess-test",
      cwd: "D:\\test",
    });
    assert.ok(slot, "slot exists after replay");
    // min(startAt) is +Infinity when all rows are null → fallback to row.at
    // (1_000_001 / 1_000_002 are both well below before/after, so the
    // expected replayed startAt is 1_000_001, not Date.now()).
    assert.equal(slot!.startAt, 1_000_001, "min(row.at) when startAt is all-null");
    // And the slot is NOT Date.now() — confirm by checking < before.
    assert.ok(slot!.startAt! < before, "fallback used row.at, not Date.now()");
    void after;
  });

  // ----- 9b. startAt edge case: all rows have startAt=0 → Date.now() fallback -----
  it("startAt: all rows have startAt=0 → replayed startAt falls back to row.at", () => {
    // The > 0 gate in replayAccInit's candidate computation
    // filters 0; falls through to row.at.
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_005, in: 100, out: 50, apiMs: 1000, startAt: 0 }));
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_006, in: 50, out: 25, apiMs: 500, startAt: 0 }));

    statusStore.processAndSaveTick("D:\\test", validTokens());

    const slot = statusStore.readAccumulator("session", {
      sessionId: "sess-test",
      cwd: "D:\\test",
    });
    assert.ok(slot, "slot exists after replay");
    assert.equal(slot!.startAt, 1_000_005, "0 sentinels filtered; row.at used");
  });

  // ----- 9c. startAt edge case: mixed → min(finite>0) -----
  it("startAt: mixed (some null, some 0, some valid) → min(finite>0)", () => {
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_010, in: 100, out: 50, apiMs: 1000, startAt: null }));
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_011, in: 50, out: 25, apiMs: 500, startAt: 0 }));
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_012, in: 75, out: 35, apiMs: 750, startAt: 123_456 }));
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_013, in: 25, out: 15, apiMs: 250, startAt: 234_567 }));

    statusStore.processAndSaveTick("D:\\test", validTokens());

    const slot = statusStore.readAccumulator("session", {
      sessionId: "sess-test",
      cwd: "D:\\test",
    });
    assert.ok(slot, "slot exists after replay");
    // min(finite>0) over startAt: 123_456 (null and 0 are filtered)
    assert.equal(slot!.startAt, 123_456, "min(finite>0) startAt over all rows");
  });

  // ----- 10. Diagnostics env-gate: replay writes row when enabled, silent when disabled -----
  it("diagnostics: CREDITGAUGE_DIAGNOSTICS_ENABLE=1 writes replay-acc-init row; default off writes nothing", () => {
    // Note: src/diagnostics.ts:53 has its OWN stateRoot() that reads
    // process.env.CLAUDE_CONFIG_DIR directly and appends a hardcoded
    // "plugins/creditgauge/state/" segment. The setStateRoot hook in
    // status-store does NOT route diagnostics writes. So the
    // diagnostics file lives at:
    //   ${CLAUDE_CONFIG_DIR}/plugins/creditgauge/state/<projectHash>/diagnostics.jsonl
    // not at the JSONL stateRoot we configured for status-store.
    // The projectHash is the same either way (computed by the
    // exported projectHash() function), so we read from the right
    // path by computing it the same way.

    // Sub-test A: env=0 (default) — no row.
    const tmpA = mkdtempSync(join(tmpdir(), "creditgauge-diag-A-"));
    const stateA = mkdtempSync(join(tmpdir(), "creditgauge-diag-A-state-"));
    process.env.CLAUDE_CONFIG_DIR = tmpA;
    statusStore.setStateRoot(() => stateA);
    statusStore.setStatusPathResolver(() => join(tmpA, "status.json"));
    statusStore.setStatCachePathResolver(() => join(tmpA, "stat-cache.json"));
    statusStore.__resetForTest();
    statusStore.resetTickStateForTest();
    statusStore.__resetStatCacheForTest();

    process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE = "0";
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_001, in: 100, out: 50, apiMs: 1000, startAt: 50_000 }));
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_002, in: 200, out: 100, apiMs: 2000, startAt: 50_000 }));
    statusStore.processAndSaveTick("D:\\test", validTokens());

    const diagA = join(tmpA, "plugins", "creditgauge", "state", statusStore.projectHash("D:\\test"), "diagnostics.jsonl");
    if (existsSync(diagA)) {
      const content = readFileSync(diagA, "utf8");
      assert.ok(!content.includes("replay-acc-init"), "no replay-acc-init row when env=0");
    }
    rmSync(tmpA, { recursive: true, force: true });
    rmSync(stateA, { recursive: true, force: true });

    // Sub-test B: env=1 — row emitted. Separate tmp dir for the
    // dedupe map (per-process) — a different scope+counts msg gets
    // a different dedupe key, so this naturally writes a fresh row.
    const tmpB = mkdtempSync(join(tmpdir(), "creditgauge-diag-B-"));
    const stateB = mkdtempSync(join(tmpdir(), "creditgauge-diag-B-state-"));
    process.env.CLAUDE_CONFIG_DIR = tmpB;
    statusStore.setStateRoot(() => stateB);
    statusStore.setStatusPathResolver(() => join(tmpB, "status.json"));
    statusStore.setStatCachePathResolver(() => join(tmpB, "stat-cache.json"));
    statusStore.__resetForTest();
    statusStore.resetTickStateForTest();
    statusStore.__resetStatCacheForTest();

    process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE = "1";
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_001, in: 100, out: 50, apiMs: 1000, startAt: 50_000 }));
    statusStore.appendSample("D:\\test", "sess-test", makeSample({ at: 1_000_002, in: 200, out: 100, apiMs: 2000, startAt: 50_000 }));
    statusStore.processAndSaveTick("D:\\test", validTokens());

    const diagB = join(tmpB, "plugins", "creditgauge", "state", statusStore.projectHash("D:\\test"), "diagnostics.jsonl");
    assert.ok(existsSync(diagB), `diagnostics.jsonl exists at ${diagB}`);
    const content = readFileSync(diagB, "utf8");
    assert.ok(
      content.includes("replay-acc-init"),
      `expected replay-acc-init row in diagnostics; got: ${content.slice(0, 500)}`,
    );
    assert.ok(content.includes("scope=session"), "scope=session row emitted");
    rmSync(tmpB, { recursive: true, force: true });
    rmSync(stateB, { recursive: true, force: true });
  });
});
