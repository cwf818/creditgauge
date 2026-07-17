// Tests for parseTokenSnapshot — the stdin → TokenSnapshot parser
// at the heart of the token-usage module. Validates against the
// real schema captured 2026-06-29 (see __fixtures__/stdin.real.json).

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTokenSnapshot } from "./session-parse.ts";
import {
  __resetDedupeForTest,
  diagnosticsPath,
} from "./diagnostics.ts";

// Real-shape fixture (captured 2026-06-29). Loaded once at module top
// so individual tests can assert against it without re-reading the file.
const STDIN_REAL = readFileSync(
  fileURLToPath(new URL("./__fixtures__/stdin.real.json", import.meta.url)),
  "utf8",
);

describe("parseTokenSnapshot — happy path", () => {
  it("extracts all fields from the captured stdin payload", () => {
    const snap = parseTokenSnapshot(STDIN_REAL);
    assert.ok(snap);
    // Existing fields (unchanged from v0.4.0 dev work)
    assert.equal(snap!.sessionId, "b2bee628-bc4f-4c79-a198-cb39b098b547");
    // cwd matches the captured fixture (D:\WorkSpace\topgauge — real
    // session payload from this machine, preserved as historical data).
    assert.equal(snap!.cwd, "D:\\WorkSpace\\topgauge");
    assert.equal(snap!.totals.tokenTotalIn, 126860);
    assert.equal(snap!.totals.tokenTotalOut, 265);
    assert.equal(snap!.current.tokenIn, 140);
    assert.equal(snap!.current.tokenOut, 265);
    assert.equal(snap!.current.tokenCacheCreation, 0);
    assert.equal(snap!.current.tokenCachedIn, 126720);
    assert.equal(snap!.cost.totalDurationMs, 74514744);
    // v0.4.0+ — session identity / metadata
    assert.equal(snap!.sessionName, "strip-diagnostics-display");
    assert.equal(snap!.modelDisplayName, "MiniMax-M3");
    assert.equal(snap!.effort, "high");
    // repo.name matches the captured fixture (topgauge — pre-rename repo name).
    assert.deepEqual(snap!.repo, {
      host: "github.com",
      owner: "cwf818",
      name: "topgauge",
    });
    assert.equal(snap!.ccversion, "2.1.191");
    // v0.4.0+ — context window
    assert.equal(snap!.contextWindow!.contextWindowSize, 200000);
    assert.equal(snap!.contextWindow!.contextUsedPercent, 63);
    assert.equal(snap!.contextWindow!.contextRemainingPercent, 37);
    // v0.4.0+ — extended cost
    assert.equal(snap!.cost.totalApiDurationMs, 8301407);
    assert.equal(snap!.cost.totalLinesAdded, 3965);
    assert.equal(snap!.cost.totalLinesRemoved, 967);
  });

  it("tolerates missing context_window", () => {
    const raw = JSON.stringify({ session_id: "x", cwd: "/y" });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.sessionId, "x");
    assert.equal(snap!.cwd, "/y");
    assert.equal(snap!.totals.tokenTotalIn, null);
    assert.equal(snap!.totals.tokenTotalOut, null);
    assert.equal(snap!.current.tokenIn, null);
    assert.equal(snap!.current.tokenCachedIn, null);
    assert.equal(snap!.cost.totalDurationMs, null);
    assert.equal(snap!.contextWindow!.contextWindowSize, null);
    assert.equal(snap!.contextWindow!.contextUsedPercent, null);
  });

  it("tolerates current_usage being a number instead of object", () => {
    // ccstatusline schema allows `current_usage: number | object`.
    // Our parser only handles the object shape; a bare number
    // yields null current.* fields, not an error.
    const raw = JSON.stringify({
      context_window: { current_usage: 12345 },
    });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.current.tokenIn, null);
    assert.equal(snap!.current.tokenCachedIn, null);
  });

  it("tolerates cost being missing", () => {
    const raw = JSON.stringify({ session_id: "x" });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.cost.totalDurationMs, null);
    assert.equal(snap!.cost.totalApiDurationMs, null);
    assert.equal(snap!.cost.totalLinesAdded, null);
    assert.equal(snap!.cost.totalLinesRemoved, null);
  });
});

describe("parseTokenSnapshot — v0.4.0+ field edge cases", () => {
  it("tolerates missing model", () => {
    const raw = JSON.stringify({ session_id: "x" });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.modelDisplayName, null);
  });

  it("tolerates model without display_name", () => {
    const raw = JSON.stringify({ model: { id: "foo" } });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.modelDisplayName, null);
  });

  it("tolerates missing workspace", () => {
    const raw = JSON.stringify({ session_id: "x" });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.repo, null);
  });

  it("tolerates workspace without repo", () => {
    const raw = JSON.stringify({ workspace: { current_dir: "/y" } });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.repo, null);
  });

  it("tolerates missing version", () => {
    const raw = JSON.stringify({ session_id: "x" });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.ccversion, null);
  });

  it("tolerates missing effort", () => {
    const raw = JSON.stringify({ session_id: "x" });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.effort, null);
  });

  it("tolerates effort as a string", () => {
    // Some clients may send effort as a bare string. Coerce to itself.
    const raw = JSON.stringify({ effort: "high" });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.effort, "high");
  });

  it("tolerates effort as an object with .level", () => {
    const raw = JSON.stringify({ effort: { level: "high" } });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.effort, "high");
  });

  it("tolerates effort as an object without .level", () => {
    const raw = JSON.stringify({ effort: { other: "x" } });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.effort, null);
  });

  it("tolerates repo with all-null sub-fields", () => {
    const raw = JSON.stringify({
      workspace: { repo: { host: null, owner: null, name: null } },
    });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    // The parser still constructs a sub-object; the renderer filters
    // it down to an empty join and returns null. This is intentional —
    // keeping the sub-object lets the renderer distinguish "repo was
    // present but empty" from "repo was missing".
    assert.deepEqual(snap!.repo, { host: null, owner: null, name: null });
  });

  it("tolerates repo with partial sub-fields", () => {
    const raw = JSON.stringify({
      workspace: { repo: { host: "github.com", owner: null, name: "x" } },
    });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.deepEqual(snap!.repo, { host: "github.com", owner: null, name: "x" });
  });

  it("tolerates missing context_window_size / used% / remaining%", () => {
    const raw = JSON.stringify({ context_window: { total_input_tokens: 100 } });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.contextWindow!.contextWindowSize, null);
    assert.equal(snap!.contextWindow!.contextUsedPercent, null);
    assert.equal(snap!.contextWindow!.contextRemainingPercent, null);
  });
});

describe("parseTokenSnapshot — null cases", () => {
  it("empty raw → null", () => {
    assert.equal(parseTokenSnapshot(""), null);
  });

  it("invalid JSON → null", () => {
    assert.equal(parseTokenSnapshot("not json"), null);
  });

  it("non-object root → null", () => {
    assert.equal(parseTokenSnapshot("123"), null);
    assert.equal(parseTokenSnapshot("null"), null);
    assert.equal(parseTokenSnapshot('"hello"'), null);
  });

  it("array root → null", () => {
    assert.equal(parseTokenSnapshot("[1, 2, 3]"), null);
  });
});

// v0.8.0+ — invariant check on parse:
//   total_input_tokens == current.input + current.cacheRead
// When violated, parseTokenSnapshot appends a `warning` to the
// per-project diagnostics log. The warning is gated by
// `CREDITGAUGE_DIAGNOSTICS_ENABLE=1`. Tests below exercise both
// the satisfied-invariant and violated-invariant paths against a
// sandboxed CLAUDE_CONFIG_DIR so the user's real diagnostics log
// is never touched.
describe("parseTokenSnapshot — v0.8.0 tokenTotalIn invariant", () => {
  let sandbox: string;
  let prevConfigDir: string | undefined;
  let prevGate: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "creditgauge-invariant-"));
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    prevGate = process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
    process.env.CLAUDE_CONFIG_DIR = sandbox;
    process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE = "1";
    __resetDedupeForTest();
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    if (prevGate === undefined) delete process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
    else process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE = prevGate;
    rmSync(sandbox, { recursive: true, force: true });
  });

  function lastLine(cwd: string | null): string | null {
    const p = diagnosticsPath(cwd);
    let raw: string;
    try { raw = readFileSync(p, "utf8"); } catch { return null; }
    const lines = raw.split("\n").filter((l) => l.length > 0);
    return lines.length > 0 ? lines[lines.length - 1]! : null;
  }

  it("real stdin (140 + 126720 = 126860) satisfies invariant — no warn", () => {
    const snap = parseTokenSnapshot(STDIN_REAL);
    assert.ok(snap);
    const line = lastLine(snap!.cwd);
    assert.equal(line, null, "no diagnostics line should be written");
  });

  it("violation: totals=200, in=100, cacheRead=50 → warn (200 != 100+50)", () => {
    const cwd = "D:\\invariant-test";
    const raw = JSON.stringify({
      session_id: "sess-1",
      cwd,
      context_window: {
        total_input_tokens: 200,
        current_usage: {
          input_tokens: 100,
          cache_read_input_tokens: 50,
        },
      },
    });
    parseTokenSnapshot(raw);
    const line = lastLine(cwd);
    assert.ok(line, "expected a warning line to be written");
    const e = JSON.parse(line!) as { level: string; source: string; msg: string };
    assert.equal(e.level, "warning");
    assert.equal(e.source, "tokenTotalIn-invariant");
    assert.match(e.msg, /total_input_tokens=200/);
    assert.match(e.msg, /input_tokens\(100\)/);
    assert.match(e.msg, /cache_read_input_tokens\(50\)/);
  });

  it("violation still renders the full snapshot (no throw)", () => {
    const raw = JSON.stringify({
      session_id: "sess-2",
      cwd: "D:\\invariant-test-2",
      context_window: {
        total_input_tokens: 999,
        current_usage: { input_tokens: 1, cache_read_input_tokens: 1 },
      },
    });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    // Returns the parsed values verbatim — invariant violation is
    // a signal, not a hard error.
    assert.equal(snap!.totals.tokenTotalIn, 999);
    assert.equal(snap!.current.tokenIn, 1);
    assert.equal(snap!.current.tokenCachedIn, 1);
  });

  it("missing field → invariant skipped (no warn on partial stdin)", () => {
    const raw = JSON.stringify({
      session_id: "sess-3",
      cwd: "D:\\invariant-test-3",
      context_window: { total_input_tokens: 100 },
      // current_usage absent — invariant requires all three fields
    });
    parseTokenSnapshot(raw);
    const line = lastLine("D:\\invariant-test-3");
    assert.equal(line, null, "no warn when input or cacheRead is null");
  });

  it("no warn when gate is OFF (opt-in diagnostics)", () => {
    delete process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
    const cwd = "D:\\invariant-test-4";
    const raw = JSON.stringify({
      session_id: "sess-4",
      cwd,
      context_window: {
        total_input_tokens: 200,
        current_usage: { input_tokens: 100, cache_read_input_tokens: 50 },
      },
    });
    parseTokenSnapshot(raw);
    const line = lastLine(cwd);
    assert.equal(line, null, "no warn when diagnostics gate is off");
  });
});
