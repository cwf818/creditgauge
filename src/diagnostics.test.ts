// Tests for src/diagnostics.ts — JSONL append logger + opt-in gate.
//
// We exercise the module against a sandboxed path under tmpdir so the
// tests don't touch the user's real ~/.claude/plugins/.../state dir.
// The path is overridden via process.env.CLAUDE_CONFIG_DIR; each test
// resets that env to a fresh dir, runs the assertions, and cleans up.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

describe("diagnostics — isEnabled", () => {
  it("returns false when env var is unset", () => {
    assert.equal(
      isEnabledWith({}),
      false,
      "default must be off (opt-in)",
    );
  });

  it("returns false when env var is empty string", () => {
    assert.equal(isEnabledWith({ CREDITGAUGE_DIAGNOSTICS_ENABLE: "" }), false);
  });

  it("accepts '1' (truthy)", () => {
    assert.equal(isEnabledWith({ CREDITGAUGE_DIAGNOSTICS_ENABLE: "1" }), true);
  });

  it("accepts 'true' (truthy, mixed case)", () => {
    assert.equal(isEnabledWith({ CREDITGAUGE_DIAGNOSTICS_ENABLE: "TRUE" }), true);
    assert.equal(isEnabledWith({ CREDITGAUGE_DIAGNOSTICS_ENABLE: "True" }), true);
  });

  it("accepts 'yes' (truthy, with surrounding whitespace)", () => {
    assert.equal(isEnabledWith({ CREDITGAUGE_DIAGNOSTICS_ENABLE: " yes " }), true);
  });

  it("rejects other values (0, no, false, arbitrary)", () => {
    assert.equal(isEnabledWith({ CREDITGAUGE_DIAGNOSTICS_ENABLE: "0" }), false);
    assert.equal(isEnabledWith({ CREDITGAUGE_DIAGNOSTICS_ENABLE: "no" }), false);
    assert.equal(isEnabledWith({ CREDITGAUGE_DIAGNOSTICS_ENABLE: "false" }), false);
    assert.equal(isEnabledWith({ CREDITGAUGE_DIAGNOSTICS_ENABLE: "off" }), false);
    assert.equal(isEnabledWith({ CREDITGAUGE_DIAGNOSTICS_ENABLE: "enabled" }), false);
  });
});

describe("diagnostics — append + readLatest", () => {
  let sandbox: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "creditgauge-diag-"));
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = sandbox;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    rmSync(sandbox, { recursive: true, force: true });
  });

  function enable() {
    process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE = "1";
  }

  function disable() {
    delete process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
  }

  it("does NOT write to disk when gate is off (default)", () => {
    disable();
    append("error", "config", "should not be persisted", 1_000, null);
    // The diagnostics file path lives under CLAUDE_CONFIG_DIR; assert
    // it (and its parent dirs) do not exist.
    const p = diagnosticsPath();
    assert.equal(existsSyncSafe(p), false, "no file should be created");
  });

  it("writes one JSONL row per call when gate is on", () => {
    enable();
    append("warning", "config", "first", 1_000, null);
    append("error", "fetch", "second", 2_000, null);

    const raw = readFileSync(diagnosticsPath(), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2);

    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    assert.equal(a.level, "warning");
    assert.equal(a.source, "config");
    assert.equal(a.msg, "first");
    assert.equal(a.at, 1_000);
    assert.equal(b.level, "error");
    assert.equal(b.source, "fetch");
    assert.equal(b.msg, "second");
    assert.equal(b.at, 2_000);
  });

  it("readLatest returns the most recent matching entry by level", () => {
    enable();
    append("warning", "a", "old warn", 1_000, null);
    append("error", "a", "err 1", 2_000, null);
    append("warning", "a", "new warn", 3_000, null);
    append("error", "a", "err 2", 4_000, null);

    // v0.8.x+ — readLatest now also returns `iso` and `fn`. We
    // assert the user-facing fields strictly and just check that
    // the new fields exist with the right types (host-tz shifts
    // make iso's exact string brittle across machines).
    const w = readLatest("warning", null);
    assert.ok(w);
    assert.equal(w!.at, 3_000);
    assert.equal(w!.level, "warning");
    assert.equal(w!.source, "a");
    assert.equal(w!.msg, "new warn");
    assert.equal(typeof w!.iso, "string");
    assert.ok(Number.isFinite(Date.parse(w!.iso)));

    const e = readLatest("error", null);
    assert.ok(e);
    assert.equal(e!.at, 4_000);
    assert.equal(e!.level, "error");
    assert.equal(e!.source, "a");
    assert.equal(e!.msg, "err 2");
    assert.equal(typeof e!.iso, "string");
  });

  it("readLatest returns null when no entry of that level exists", () => {
    enable();
    append("warning", "a", "only a warning", 1_000, null);
    assert.equal(readLatest("error", null), null);
  });

  it("readLatest returns null when the file doesn't exist (gate off path)", () => {
    disable();
    // No prior append — file doesn't exist. readLatest is intentionally
    // NOT gated (reads whatever is on disk), so this just confirms the
    // missing-file branch returns null cleanly.
    assert.equal(readLatest("error", null), null);
    assert.equal(readLatest("warning", null), null);
  });

  it("caps the file at 1000 lines, keeping the most recent (v0.8.34: was 200)", () => {
    enable();
    for (let i = 0; i < 1100; i++) {
      append("error", "flood", `e${i}`, i, null);
    }
    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1000, "must keep only the last 1000");

    const firstKept = JSON.parse(lines[0]);
    const lastKept = JSON.parse(lines[lines.length - 1]);
    // First 100 were dropped, so the first kept is e100.
    assert.equal(firstKept.msg, "e100");
    assert.equal(lastKept.msg, "e1099");
  });

  // v0.4.x+ Per-Project Layout: when a cwd is provided, the entry
  // is written to `state/<projectHash>/diagnostics.jsonl` rather
  // than the top-level file. Two concurrent projects must not see
  // each other's entries when readLatest is given the same cwd.
  it("per-project: append with cwd lands in state/<hash>/diagnostics.jsonl", () => {
    enable();
    const cwdA = "D:\\WorkSpace\\alpha";
    const cwdB = "D:\\WorkSpace\\beta";
    const pathA = diagnosticsPath(cwdA);
    const pathB = diagnosticsPath(cwdB);
    // Different projects → different files (never the legacy top-level).
    assert.notEqual(pathA, pathB);
    assert.ok(pathA.includes("alpha") || pathA.includes("d--workspace-alpha"),
      `expected per-project path, got: ${pathA}`);
    const pathAParent = pathA.split(/[\\/]/).slice(-2, -1)[0];
    assert.ok(!pathA.endsWith("diagnostics.jsonl") || pathAParent === "d--workspace-alpha",
      `expected pathA under a per-project subdir: ${pathA}`);

    append("error", "src", "from A", 1_000, cwdA);
    append("error", "src", "from B", 2_000, cwdB);

    // Top-level file should NOT exist (nothing was written without cwd).
    assert.equal(existsSyncSafe(diagnosticsPath(null)), false,
      "no top-level file when only per-project writes happened");

    // Each project reads back only its own entry (v0.8.x+ — Entry
    // also carries `iso` and `fn`, so we assert the user-facing
    // fields individually rather than deep-equal the whole object;
    // the iso string depends on the host's local-tz offset which
    // is non-portable across CI/dev machines).
    const a = readLatest("error", cwdA);
    assert.ok(a);
    assert.equal(a!.at, 1_000);
    assert.equal(a!.level, "error");
    assert.equal(a!.source, "src");
    assert.equal(a!.msg, "from A");
    assert.equal(typeof a!.iso, "string");

    const b = readLatest("error", cwdB);
    assert.ok(b);
    assert.equal(b!.at, 2_000);
    assert.equal(b!.level, "error");
    assert.equal(b!.source, "src");
    assert.equal(b!.msg, "from B");
    assert.equal(typeof b!.iso, "string");
  });

  it("per-project: empty-string cwd falls back to top-level", () => {
    enable();
    append("error", "src", "top-level fallback", 1_000, "");
    // Empty string is treated as "no project" — file lands at top level.
    assert.equal(existsSyncSafe(diagnosticsPath(null)), true);
    const e = readLatest("error", null);
    assert.ok(e);
    assert.equal(e!.at, 1_000);
    assert.equal(e!.level, "error");
    assert.equal(e!.source, "src");
    assert.equal(e!.msg, "top-level fallback");
    assert.equal(typeof e!.iso, "string");
  });

  it("formatEntry caps message at 80 chars with ellipsis", () => {
    const e: Entry = { at: 0, iso: "1970-01-01T00:00:00.000", level: "error", source: "x", msg: "x".repeat(200) };
    const out = formatEntry(e);
    // '<glyph> <iso> <trunc-msg>' — the slice trims to MAX_DISPLAY_LEN-1
    // = 79 before appending the ellipsis, so the msg body is exactly
    // 79 + '…' = 80 chars. Plus glyph + space + iso + space = 1+1+24+1.
    assert.ok(out.startsWith("✖ "));
    assert.ok(out.includes("1970-01-01T00:00:00.000"));
    assert.ok(out.endsWith("…"));
  });

  it("formatEntry uses ⚠ for warning level", () => {
    const e: Entry = { at: 0, iso: "1970-01-01T00:00:00.000", level: "warning", source: "x", msg: "hi" };
    assert.match(formatEntry(e), /^⚠ 1970-01-01T00:00:00\.000 hi$/);
  });
});

describe("diagnostics — file-IO audit helpers (v0.8.x+)", () => {
  // v0.8.x+ — per-tick file IO (cache.ts, token-store.ts,
  // status-store.ts, config.ts, index.ts) is routed through thin
  // logFs* wrappers that record each fs call to the diagnostics
  // JSONL under sources 'fs:read' / 'fs:write' / 'fs:list' /
  // 'fs:stat' / 'fs:mkdir'. The audit rides the same gate
  // (CREDITGAUGE_DIAGNOSTICS_ENABLE) and 60s dedupe as fetch
  // warnings — distinct enough row that a postmortem can
  // `level=info & source=fs:*` filter for it.
  let sandbox: string;
  let prevConfigDir: string | undefined;
  let prevEnable: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "creditgauge-diag-fs-"));
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = sandbox;
    diag.__resetDedupeForTest();
    prevEnable = process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
  });

  afterEach(() => {
    diag.__resetDedupeForTest();
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    if (prevEnable === undefined) delete process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
    else process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE = prevEnable;
    rmSync(sandbox, { recursive: true, force: true });
  });

  function enable() {
    process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE = "1";
  }

  function disable() {
    delete process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
  }

  function readFsRows(): { level: string; source: string; msg: string }[] {
    let raw: string;
    try {
      raw = readFileSync(diagnosticsPath(null), "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
      .filter((r: { source?: string }) =>
        typeof r.source === "string" && r.source.startsWith("fs:"),
      );
  }

  it("does NOT write when the opt-in gate is off", () => {
    disable();
    logFsRead("/tmp/whatever");
    logFsWrite("/tmp/x", undefined, 100);
    logFsList("/tmp");
    logFsStat("/tmp/x");
    logFsMkdir("/tmp/dir");
    assert.equal(
      existsSyncSafe(diagnosticsPath(null)),
      false,
      "no file should be created when the env gate is off",
    );
  });

  it("logFsRead records an info row with source 'fs:read'", () => {
    enable();
    logFsRead(join(sandbox, "cache.json"));
    const rows = readFsRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].level, "info");
    assert.equal(rows[0].source, "fs:read");
    assert.match(rows[0].msg, /cache\.json$/);
  });

  it("logFsWrite records the byte size in the message", () => {
    enable();
    logFsWrite(join(sandbox, "status.json"), undefined, 1234);
    const rows = readFsRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "fs:write");
    assert.match(rows[0].msg, /status\.json.*\(1234B\)/);
  });

  it("logFsList / logFsStat / logFsMkdir use their own sources", () => {
    enable();
    logFsList(join(sandbox, "state"));
    logFsStat(join(sandbox, "x.jsonl"));
    logFsMkdir(join(sandbox, "sub"));
    const rows = readFsRows();
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.source),
      ["fs:list", "fs:stat", "fs:mkdir"],
    );
  });

  it("different paths are distinct dedupe keys", () => {
    enable();
    logFsRead(join(sandbox, "a.json"));
    logFsRead(join(sandbox, "b.json"));
    assert.equal(readFsRows().length, 2, "two distinct paths → two rows");
  });

  it("identical paths within the 60s dedupe window collapse to one row", () => {
    enable();
    logFsRead(join(sandbox, "cache.json"));
    logFsRead(join(sandbox, "cache.json"));
    logFsRead(join(sandbox, "cache.json"));
    assert.equal(
      readFsRows().length,
      1,
      "the 60s dedupe collapses identical read sites into one row",
    );
  });

  it("truncates very long paths in the message (msg preview head)", () => {
    enable();
    const deep = join(sandbox, "x".repeat(300) + ".json");
    logFsRead(deep);
    const rows = readFsRows();
    assert.equal(rows.length, 1);
    // The full deep path is longer than 200 chars; the row should
    // still be JSON-parseable and the msg should end in '…'.
    assert.ok(rows[0].msg.endsWith("…"));
  });
});

describe("diagnostics — Entry schema (v0.8.x+: iso + fn)", () => {
  // v0.8.x+ — every JSONL row carries two new fields: `iso` (a
  // human-readable local-tz ISO8601 timestamp derived from `at`)
  // and an optional `fn` identifying the calling function in
  // `module.funcName` form. The `fn` field is set by the file-IO
  // audit helpers and omitted from fetch / config / stdin rows so
  // pre-existing warning flows are unchanged.
  let sandbox: string;
  let prevConfigDir: string | undefined;
  let prevEnable: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "creditgauge-diag-iso-"));
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = sandbox;
    diag.__resetDedupeForTest();
    prevEnable = process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
  });

  afterEach(() => {
    diag.__resetDedupeForTest();
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    if (prevEnable === undefined) delete process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
    else process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE = prevEnable;
    rmSync(sandbox, { recursive: true, force: true });
  });

  function enable() {
    process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE = "1";
  }

  function readRows(): Array<Record<string, unknown>> {
    let raw: string;
    try {
      raw = readFileSync(diagnosticsPath(null), "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
  }

  it("appended rows carry an `iso` field matching `at`", () => {
    enable();
    const AT = 1_700_000_000_000; // 2023-11-14T22:13:20Z
    append("info", "fetch", "hello", AT, null);
    const rows = readRows();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.at, AT);
    assert.equal(typeof row.iso, "string");
    // The ISO string should round-trip back to the same epoch ms
    // through Date.parse — host-tz offset shifts within an hour of
    // UTC, but the difference is small enough that the JS clock
    // stays inside a tolerance of a few minutes.
    const parsed = Date.parse(String(row.iso));
    assert.ok(
      Number.isFinite(parsed),
      `iso "${row.iso}" must round-trip through Date.parse`,
    );
    assert.ok(
      Math.abs(parsed - AT) < 60 * 60 * 1000,
      `iso "${row.iso}" must be within 1h of at=${AT}`,
    );
  });

  it("`fn` is omitted when the caller doesn't pass it (fetch/config rows)", () => {
    enable();
    append("warning", "fetch", "net err", 1_000, null);
    const rows = readRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fn, undefined, "fetch row should not carry fn");
  });

  it("logFsRead forwards `fn` to the JSONL row", () => {
    enable();
    logFsRead(
      join(sandbox, "cache.json"),
      "cache.loadFromDisk",
    );
    const rows = readRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "fs:read");
    assert.equal(rows[0].fn, "cache.loadFromDisk");
    assert.equal(typeof rows[0].iso, "string");
  });

  it("logFsWrite forwards `fn` too", () => {
    enable();
    logFsWrite(
      join(sandbox, "status.json"),
      "status-store.flushToDisk",
      123,
    );
    const rows = readRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "fs:write");
    assert.equal(rows[0].fn, "status-store.flushToDisk");
  });

  it("readLatest returns the new `fn` and `iso` fields", () => {
    enable();
    logFsRead(
      join(sandbox, "x.json"),
      "token-store.appendSample",
    );
    const e = readLatest("info", null);
    assert.ok(e, "expected an entry back");
    assert.equal(e!.fn, "token-store.appendSample");
    assert.equal(typeof e!.iso, "string");
    assert.ok(Number.isFinite(Date.parse(e!.iso)));
  });

  it("on-disk JSONL emits `fn` before `msg` (insertion-order)", () => {
    enable();
    logFsRead(
      join(sandbox, "cache.json"),
      "cache.loadFromDisk",
    );
    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const line = raw.split("\n").filter((l) => l.length > 0)[0];
    // JSON.stringify preserves insertion order for string keys
    // (ES2015 §5.2.5 — V8 follows this), so the offset of "fn": in
    // the line must precede the offset of "msg": in the same line.
    const fnIdx = line.indexOf('"fn"');
    const msgIdx = line.indexOf('"msg"');
    assert.ok(fnIdx > 0, `'fn' field should appear on disk: ${line}`);
    assert.ok(msgIdx > 0, `'msg' field should appear on disk: ${line}`);
    assert.ok(
      fnIdx < msgIdx,
      `"fn" must precede "msg" on disk — got fnIdx=${fnIdx}, msgIdx=${msgIdx}, line=${line}`,
    );
  });

  it("rows persisted with a cwd carry the cwd field on disk", () => {
    enable();
    const cwd = "D:\\WorkSpace\\alpha";
    append("info", "stdin", "frame", 1_000, cwd);
    const raw = readFileSync(diagnosticsPath(cwd), "utf8");
    const line = raw.split("\n").filter((l) => l.length > 0)[0];
    const parsed = JSON.parse(line);
    assert.equal(parsed.cwd, cwd, "row must persist the cwd argument");
  });

  it("rows persisted without a cwd omit the cwd field on disk", () => {
    enable();
    append("warning", "fetch", "net err", 1_000, null);
    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const line = raw.split("\n").filter((l) => l.length > 0)[0];
    const parsed = JSON.parse(line);
    assert.equal(parsed.cwd, undefined, "row must NOT have a cwd key when caller omitted it");
  });

  it("rows persisted with empty-string cwd omit the cwd field too", () => {
    enable();
    append("warning", "fetch", "net err", 1_000, "");
    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const line = raw.split("\n").filter((l) => l.length > 0)[0];
    const parsed = JSON.parse(line);
    assert.equal(parsed.cwd, undefined);
  });

  it("readLatest round-trips the cwd field", () => {
    enable();
    const cwd = "D:\\WorkSpace\\beta";
    append("info", "stdin", "x", 1_000, cwd);
    const e = readLatest("info", cwd);
    assert.ok(e);
    assert.equal(e!.cwd, cwd);
  });

  it("multiple cwds share the same top-level file when each drops cwd=null", () => {
    enable();
    // Both calls land in the legacy top-level diagnostics.jsonl
    // because they pass cwd=null. This simulates the case where
    // a non-cwd-aware caller (e.g. fetch warn) appends rows on
    // behalf of multiple sessions sharing one state root. The
    // row itself records no cwd (caller chose null) — the test
    // documents the chosen contract: per-row cwd is opt-in, never
    // inferred.
    append("info", "fetch", "session-A", 1_000, null);
    append("info", "fetch", "session-B", 2_000, null);
    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const rows = raw.split("\n").filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].cwd, undefined);
    assert.equal(rows[1].cwd, undefined);
  });

  it("formatEntry annotates the statusline with cwd when set", () => {
    const e: Entry = {
      at: 1_700_000_000_000,
      iso: "2023-11-14T22:13:20.000",
      level: "warning",
      source: "fetch",
      msg: "ECONNREFUSED",
      cwd: "D:\\WorkSpace\\gamma",
    };
    const out = formatEntry(e);
    assert.match(
      out,
      /^⚠ 2023-11-14T22:13:20\.000 ECONNREFUSED \[D:\\WorkSpace\\gamma\]$/,
    );
  });

  it("formatEntry prints iso and fn for an fs audit entry", () => {
    const e: Entry = {
      at: 1_700_000_000_000,
      iso: "2023-11-14T22:13:20.000",
      level: "info",
      source: "fs:read",
      msg: "/x/cache.json",
      fn: "cache.loadFromDisk",
    };
    const out = formatEntry(e);
    // info level falls back to the warning glyph (ℹ not currently in
    // the levelGlyph enum — see diagnostics.ts comment); the body
    // shape '<glyph> <iso> <fn> <msg>' is what we assert.
    assert.match(
      out,
      /^⚠ 2023-11-14T22:13:20\.000 cache\.loadFromDisk \/x\/cache\.json$/,
    );
  });
});

describe("diagnostics — fetch error dedupe (v0.6.x+)", () => {
  // v0.6.x+ — fetch failures fire on every statusline tick (~1Hz in
  // active sessions). Unguarded append would flood the JSONL log
  // and burn through the 200-line cap in 3 minutes of sustained
  // outage, hiding genuinely new errors. The dedupe map keeps a
  // single entry per (source, message, 60s window) so a sustained
  // failure is logged once per minute, not once per tick.
  let sandbox: string;
  let prevConfigDir: string | undefined;
  let prevEnable: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "tokenplan-diag-dedupe-"));
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = sandbox;
    prevEnable = process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
    process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE = "1";
    diag.__resetDedupeForTest();
  });

  afterEach(() => {
    diag.__resetDedupeForTest();
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    if (prevEnable === undefined) delete process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
    else process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE = prevEnable;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("suppresses identical (source, msg) within the 60s window", () => {
    append("warning", "fetch", "minimax (https://x): HTTP 503", 1_000, null);
    append("warning", "fetch", "minimax (https://x): HTTP 503", 5_000, null);
    append("warning", "fetch", "minimax (https://x): HTTP 503", 30_000, null);

    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1, "dedupe: 3 identical calls within 60s → 1 row");
  });

  it("passes through when the dedupe window has elapsed", () => {
    // 60_001 ms apart — one window tick past the 60s threshold.
    append("warning", "fetch", "minimax (https://x): HTTP 503", 1_000, null);
    append("warning", "fetch", "minimax (https://x): HTTP 503", 1_000 + 60_001, null);

    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2, "dedupe window expired → both writes land");
  });

  it("treats different sources or messages as distinct keys", () => {
    // The dedupe key is (source, msg) — level is intentionally NOT
    // part of the key, so a warning and an error with the same
    // message dedupe together. (This is intentional: from a
    // postmortem perspective, the same network outage producing
    // 60s of "warning" then 60s of "error" reads as one event, not
    // two.) So three distinct keys, not four.
    append("warning", "fetch", "minimax: HTTP 503", 1_000, null);
    append("warning", "fetch", "deepseek: HTTP 503", 1_000, null); // different msg
    append("warning", "config", "minimax: HTTP 503", 1_000, null); // different source
    append("error", "fetch", "minimax: HTTP 503", 1_000, null);   // same (source, msg) as line 1

    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 3, "3 distinct (source, msg) keys — level shares");
  });

  it("keys on the first 200 chars of the message", () => {
    const long = "x".repeat(500);
    const long2 = "x".repeat(500);
    append("warning", "fetch", long, 1_000, null);
    append("warning", "fetch", long2, 5_000, null);

    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1, "two 500-char messages with same first 200 chars are the same key");
  });
});

import * as diag from "./diagnostics.ts";

const {
  append,
  diagnosticsPath,
  formatEntry,
  isEnabled,
  logFsList,
  logFsMkdir,
  logFsRead,
  logFsStat,
  logFsWrite,
  readLatest,
} = diag;
type Entry = import("./diagnostics.ts").Entry;

// Helper: route isEnabled through a synthetic env object so the
// "isEnabled" tests don't have to touch process.env (which other
// tests in this file use). isEnabled's signature accepts a default
// of process.env, but accepting an explicit env object here lets us
// write pure-function-style assertions.
function isEnabledWith(env: Record<string, string | undefined>): boolean {
  const e: NodeJS.ProcessEnv = { ...env };
  return isEnabled(e);
}

// existsSync is sync and would cost an extra fs call per test —
// import lazily so the cost is paid only when this helper runs.
function existsSyncSafe(p: string): boolean {
  try {
    // Use a dynamic read so we don't need to import "existsSync"
    // up top just for this single use.
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}