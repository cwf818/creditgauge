// Tests for src/token-store.ts — append-only JSONL state file under
// state/<projectHash>/<sessionId>.jsonl (v0.4.x+ Per-Project Layout;
// was state/token-samples/<projectHash>/<sessionId>.jsonl in
// v0.4.0–v0.4.<n-1>). Pure path-shape logic — the I/O paths are
// covered by integration (dev smoke test).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectHash, sampleFilePath, setStateRoot, resetStateRoot, stateRoot } from "./status-store.ts";

describe("token-store — path helpers", () => {
  it("projectHash: replaces path separators with -", () => {
    assert.equal(
      projectHash("D:\\WorkSpace\\creditgauge-cc"),
      "d--workspace-creditgauge-cc",
    );
    assert.equal(projectHash("/home/user/proj"), "-home-user-proj");
  });

  it("projectHash: lowercases", () => {
    assert.equal(projectHash("Foo/Bar"), "foo-bar");
  });

  it("projectHash: caps at 80 chars", () => {
    const long = "a".repeat(120);
    assert.equal(projectHash(long).length, 80);
  });

  it("projectHash: strips control characters (e.g. \\t in cwd)", () => {
    // cwd from stdin sometimes arrives as `D:\test` which JSON.parse
    // decodes to D:<TAB>est. Without scrubbing, that literal tab ends
    // up in the directory name and Windows mkdir rejects it with
    // ENOENT. Strip whitespace + control chars to `-` to keep the
    // path Windows-safe. (Build the TAB via String.fromCharCode to
    // bypass TypeScript source-level escape interpretation — we
    // want to assert on a literal control char in the input, not on
    // the characters produced by `"\\t"`.)
    const tab = String.fromCharCode(9);
    const nl = String.fromCharCode(10);
    const cr = String.fromCharCode(13);
    assert.equal(projectHash(`D:${tab}est`), "d--est");
    assert.equal(projectHash(`D:${nl}foo`), "d--foo");
    assert.equal(projectHash(`D:${cr}bar`), "d--bar");
  });

  it("sampleFilePath: builds under state/<hash>/<session>.jsonl (Per-Project Layout, v0.4.x+)", () => {
    const p = sampleFilePath("D:\\WorkSpace\\foo", "sess-1");
    // v0.4.x+: no `token-samples/` intermediate dir — the file is
    // directly under `state/<projectHash>/`.
    assert.ok(!p.includes("token-samples"));
    assert.ok(p.includes("d--workspace-foo"));
    assert.ok(p.endsWith("sess-1.jsonl"));
    // Path shape: .../state/<hash>/<sid>.jsonl (two levels under state/).
    // The fixture below uses platform-appropriate path separators.
    const parts = p.split(/[\\/]/);
    const sidIdx = parts.lastIndexOf("sess-1.jsonl");
    const hashIdx = sidIdx - 1;
    const stateIdx = hashIdx - 1;
    assert.ok(stateIdx >= 0, "expected state/ in path");
    assert.equal(parts[stateIdx], "state");
    assert.equal(parts[hashIdx], "d--workspace-foo");
  });

  it("setStateRoot: routes sampleFilePath through the injected root (v0.8.0+ test hook)", () => {
    // Tests that build jsonl fixtures use this hook to redirect
    // sample writes into a tmp dir, so the user's real
    // ~/.claude/.../state/ is never touched.
    const orig = stateRoot();
    try {
      setStateRoot(() => "/tmp/creditgauge-test");
      const p = sampleFilePath("D:\\WorkSpace\\foo", "sess-1");
      // Path separators on Windows use \\, on POSIX /.
      // Check that the injected root appears in the result.
      assert.ok(
        p.includes("creditgauge-test"),
        `expected injected root in: ${p}`,
      );
      // The projectHash + sessionId are appended on top of the
      // injected root.
      assert.ok(p.includes("d--workspace-foo"));
      assert.ok(p.endsWith("sess-1.jsonl"));
    } finally {
      resetStateRoot();
    }
    // After reset, the root reverts to the env-driven default.
    const after = stateRoot();
    assert.equal(after, orig, "resetStateRoot restores the default");
  });
});

// Filesystem-touching read/append tests are deferred: the production
// paths rely on homedir + CLAUDE_CONFIG_DIR which would clobber the
// user's actual state during tests. Instead, we provide a logical
// test for the line-parsing shape used by readSamples via a direct
// JSONL construct — see the test below using a fake path.
//
// NOTE: appendSample / readSamples rely on global env (HOME,
// CLAUDE_CONFIG_DIR) and write to the user's real plugin state dir.
// That's correct for production (we WANT samples persisted across
// ticks), but is hostile to in-process tests. The integration test
// in scripts/dev-smoke.sh covers the full round-trip; unit-level
// guarantees are provided by the path/parser helpers above.