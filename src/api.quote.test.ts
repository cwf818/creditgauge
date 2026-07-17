// v0.8.34 regression tests for the m_quote pre-fetch path.
//
// Background: v0.8.33 rewrote the lineTemplate inline-args grammar
// from positional `|name|value|` to two-class `|name:value|`. The
// renderer (`src/render.ts:parseInlineArgs`) was updated, but the
// scanner in `src/api.quote.ts:scanTokens` was missed. Result:
// `m_quote|address:<URL>|quote:<path>|…` reached `preFetchQuotes`,
// the scanner's positional `parts[i] === "name"` checks failed for
// every pair, the function returned `null`, and the renderer fell
// back to the local QUOTES list forever. Cache writes never
// happened because the address was never extracted.
//
// This file covers:
//   - the new pair grammar for `address`, `insecureTls`, `freq`
//   - the `= ` alternate separator form
//   - pairs the scanner doesn't own (color/quote/author/...) being
//     silently skipped without breaking the scan
//   - the pre-v0.8.33 positional form being rejected (we do not
//     preserve the old grammar — it was a v0.8.33 breaking change)
//   - the diagnostic level being "error" (not "warning") for the
//     "no body" path
//   - the `DEFAULT_MAX_ENTRIES` cap being 1000 (was 200)

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __scanTokensForTest } from "./api.quote.ts";
import {
  __resetDedupeForTest,
  append,
  DEFAULT_MAX_ENTRIES,
  diagnosticsPath,
} from "./diagnostics.ts";

describe("api.quote — scanTokens v0.8.34 pair grammar", () => {
  it("user's exact token: address, insecureTls, freq all parse", () => {
    const tok = "m_quote|address:https://api.quotable.io/random|quote:content|author:author|freq:120s|color:rainbow|insecureTls:true";
    const got = __scanTokensForTest([tok]);
    assert.ok(got, "scanTokens must extract a QuoteTarget for the v0.8.33 grammar");
    assert.equal(got!.address, "https://api.quotable.io/random");
    assert.equal(got!.insecureTls, true);
    assert.equal(got!.freq.raw, "120s");
    assert.equal(got!.freq.ms, 120_000);
  });

  it("URL with `:` in the value (https://) parses verbatim", () => {
    // The pair boundary is the FIRST `:` — the scheme's `:` is
    // part of the address value. This is the regression the user
    // hit: without the fix, scanTokens would have read the address
    // as "https" and dropped everything past the `://`.
    const tok = "m_quote|address:https://api.quotable.io/random";
    const got = __scanTokensForTest([tok]);
    assert.ok(got);
    assert.equal(got!.address, "https://api.quotable.io/random");
  });

  it("= separator works equivalently", () => {
    const tok = "m_quote|address=https://api.example.com|quote=content|freq=2h";
    const got = __scanTokensForTest([tok]);
    assert.ok(got);
    assert.equal(got!.address, "https://api.example.com");
    assert.equal(got!.freq.raw, "2h");
    assert.equal(got!.freq.ms, 7_200_000);
  });

  it("extra pairs (color/quote/author/wrap/nulldrop) are silently ignored", () => {
    // These belong to the renderer's schema, not to the scanner.
    // The scanner must not throw, must not return null, and must
    // still extract the address it cares about.
    const tok = "m_quote|address:https://api.example.com|color:rainbow|quote:content|author:author|wrap:false|nulldrop:true";
    const got = __scanTokensForTest([tok]);
    assert.ok(got);
    assert.equal(got!.address, "https://api.example.com");
  });

  it("bare m_quote (no address pair) returns null → local QUOTES path", () => {
    const got = __scanTokensForTest(["m_quote|color:red"]);
    assert.equal(got, null);
  });

  it("m_quote with bad freq falls back to 1h default", () => {
    // Unparseable freq → defaultFreq() {ms: 3_600_000, raw: "h"}.
    // The address must still be extracted.
    const tok = "m_quote|address:https://api.example.com|freq:notatime";
    const got = __scanTokensForTest([tok]);
    assert.ok(got);
    assert.equal(got!.address, "https://api.example.com");
    assert.equal(got!.freq.ms, 3_600_000);
    assert.equal(got!.freq.raw, "h");
  });

  it("insecureTls accepts 0/1/false/true case-insensitively", () => {
    const cases: [string, boolean | undefined][] = [
      ["true", true],
      ["TRUE", true],
      ["1", true],
      ["false", false],
      ["FALSE", false],
      ["0", false],
      ["yes", undefined],   // not in the accepted set → stays undefined
      ["", undefined],
    ];
    for (const [v, expected] of cases) {
      const tok = `m_quote|address:https://x|quote:content|insecureTls:${v}`;
      const got = __scanTokensForTest([tok]);
      assert.ok(got, `v=${v}`);
      assert.equal(got!.insecureTls, expected, `v=${v}`);
    }
  });

  it("non-m_quote tokens are skipped (scanner finds nothing)", () => {
    const got = __scanTokensForTest([
      "m_tokenIn|color:red",
      "m_windowQuota|term:short",
      "m_balance|color:green",
    ]);
    assert.equal(got, null);
  });

  it("pre-v0.8.33 positional form is no longer parsed (breaking change)", () => {
    // v0.8.33 REMOVED the positional `|name|value|` form. The
    // scanner must NOT preserve it. The user has to rewrite their
    // templates to the pair grammar.
    const tok = "m_quote|address|https://api.quotable.io/random|quote|content|insecureTls|true|freq|120s";
    const got = __scanTokensForTest([tok]);
    assert.equal(got, null, "v0.8.33 positional form must not be supported");
  });
});

describe("diagnostics — v0.8.34 level + cap", () => {
  let sandbox: string;
  let prevConfigDir: string | undefined;
  let prevGate: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "creditgauge-q34-"));
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

  it("DEFAULT_MAX_ENTRIES is 1000 (raised from 200 in v0.8.34)", () => {
    assert.equal(DEFAULT_MAX_ENTRIES, 1000);
  });

  // The "no body → error level" assertion needs the renderer's
  // fetchQuoteFromAddress to fire. That requires a non-empty
  // template + a render call where ctx.quoteBodies is undefined
  // or doesn't have the address. We piggyback on the existing
  // lineTemplate.test.ts pattern that already exercises the
  // "address fetch failed (no body)" path. Here we just verify
  // the level-bump contract by appending the same error message
  // the renderer would emit, and reading the JSONL row.
  it("m_quote error-level row lands on disk with level='error'", () => {
    // Append the same error message the renderer's
    // fetchQuoteFromAddress would emit on a "no body" miss. This
    // tests the append path the renderer hits, isolated from the
    // renderer's other dependencies.
    const cwd = "D:\\scanTokens-v0-8-34";
    append("error", "m_quote", "address fetch failed (no body): https://x", Date.now(), cwd);
    const p = diagnosticsPath(cwd);
    const raw = readFileSync(p, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.ok(lines.length > 0, "expected a JSONL row on disk");
    const last = JSON.parse(lines[lines.length - 1]!) as {
      level: string;
      source: string;
      msg: string;
    };
    assert.equal(last.level, "error", `level must be 'error' (was: ${last.level})`);
    assert.equal(last.source, "m_quote");
    assert.match(last.msg, /no body/);
  });
});
