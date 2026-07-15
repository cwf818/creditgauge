// Unit tests for the bigmodel user plugin's fill contract.
// Loads the captured real-shape fixture at
// src/__fixtures__/quota.real.bigmodel.json and asserts the canonical
// Quota intervals (short = first TOKENS_LIMIT, mid = second
// TOKENS_LIMIT, long = TIME_LIMIT).
//
// fillQuota returns the open-ended dict `{ short, mid, long }` directly
// (matches the v0.9.5 convention — the v0.9.4 `intervals:` wrapper was
// dropped). The host's ensureQuota wraps this back into the canonical
// Quota shape after the plugin returns. Tests below read the pre-
// wrapping dict directly so the contract is pinned here, not inside
// ensureQuota.
//
// The host loader never touches these functions — they exist solely
// to surface a regression in fillQuota before it reaches the
// statusline.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// bigmodel/index.js is plain ESM JS with no .d.ts — typecheck allows
// the runtime import to resolve loosely. Tests stay pinned to the
// live plugin (no test-only re-implementation of fillQuota).
// @ts-expect-error no .d.ts for the user plugin
import { SHORT_INTERVAL_MS, MID_INTERVAL_MS, fillQuota, tokensLimitInterval, timeLimitInterval } from "../../query_plugins/bigmodel/index.js";

const fixturePath = fileURLToPath(
  new URL("../__fixtures__/quota.real.bigmodel.json", import.meta.url),
);

function loadFixture(): unknown {
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

describe("bigmodel plugin — fillQuota against quota.real.bigmodel.json", () => {
  const raw = loadFixture();
  const quota = fillQuota(raw as never);

  it("returns a non-null Partial<Quota>", () => {
    assert.ok(quota, "fillQuota should produce a quota");
  });

  describe("short (5h TOKENS_LIMIT — earliest reset)", () => {
    it("picks the TOKENS_LIMIT with the smallest nextResetTime", () => {
      // Fixture has two TOKENS_LIMITs: nextResetTime=1751898000000
      // (percentage=42) and nextResetTime=1752230400000 (percentage=18).
      // The sort picks the 1751898000000 entry first.
      assert.equal(quota!.short!.usedPercent, 42);
      assert.equal(quota!.short!.remainingPercent, 58);
    });
    it("uses the 5h interval constant", () => {
      assert.equal(quota!.short!.intervalMs, SHORT_INTERVAL_MS);
      assert.equal(SHORT_INTERVAL_MS, 5 * 60 * 60 * 1000);
    });
    it("back-derives startAt = endAt − intervalMs", () => {
      assert.equal(quota!.short!.endAt, 1751898000000);
      assert.equal(quota!.short!.startAt, 1751898000000 - SHORT_INTERVAL_MS);
    });
    it("labels the window 5h", () => {
      assert.equal(quota!.short!.windowId, "5h");
      assert.equal(quota!.short!.label, "5h");
    });
  });

  describe("mid (7d TOKENS_LIMIT — second entry)", () => {
    it("picks the second TOKENS_LIMIT (after sort)", () => {
      assert.equal(quota!.mid!.usedPercent, 18);
      assert.equal(quota!.mid!.remainingPercent, 82);
    });
    it("uses the 7d interval constant", () => {
      assert.equal(quota!.mid!.intervalMs, MID_INTERVAL_MS);
      assert.equal(MID_INTERVAL_MS, 7 * 24 * 60 * 60 * 1000);
    });
    it("back-derives startAt = endAt − intervalMs", () => {
      assert.equal(quota!.mid!.endAt, 1752230400000);
      assert.equal(quota!.mid!.startAt, 1752230400000 - MID_INTERVAL_MS);
    });
  });

  describe("long (TIME_LIMIT — MCP monthly)", () => {
    it("projects the three quota fields verbatim", () => {
      assert.equal(quota!.long!.remainingQuota, 800);
      assert.equal(quota!.long!.usedQuota, 200);
      assert.equal(quota!.long!.limitQuota, 1000);
    });
    it("leaves percent fields null (TIME_LIMIT ships no percentage)", () => {
      assert.equal(quota!.long!.usedPercent, null);
      assert.equal(quota!.long!.remainingPercent, null);
    });
    it("seeds startAt from nextResetTime (host's ensureTimeGroup will drop endAt/intervalMs to null because only 1 of the 3 time fields is non-null)", () => {
      assert.equal(quota!.long!.startAt, 1753200000000);
      assert.equal(quota!.long!.endAt, null);
      assert.equal(quota!.long!.intervalMs, null);
    });
    it("labels the window monthly/MCP", () => {
      assert.equal(quota!.long!.windowId, "monthly");
      assert.equal(quota!.long!.label, "MCP");
    });
  });

  describe("soft-fail paths", () => {
    it("returns null when response.success is false", () => {
      assert.equal(
        fillQuota({ success: false, msg: "token expired" } as never),
        null,
      );
    });
    it("returns null when data.limits is missing", () => {
      assert.equal(fillQuota({ success: true, data: {} } as never), null);
    });
    it("returns null when limits is an empty array", () => {
      assert.equal(
        fillQuota({ success: true, data: { limits: [] } } as never),
        null,
      );
    });
  });
});

describe("bigmodel plugin — tokensLimitInterval unit", () => {
  it("returns null when percentage is missing", () => {
    assert.equal(
      tokensLimitInterval({ nextResetTime: 1 }, 1000, "5h", "5h"),
      null,
    );
  });
  it("returns null when nextResetTime is missing", () => {
    assert.equal(
      tokensLimitInterval({ percentage: 50 }, 1000, "5h", "5h"),
      null,
    );
  });
});

describe("bigmodel plugin — timeLimitInterval unit", () => {
  it("returns null when all three quota fields are missing", () => {
    assert.equal(
      timeLimitInterval({ nextResetTime: 1 }, "monthly", "MCP"),
      null,
    );
  });
  it("returns null for the no-time-anchor case (nextResetTime absent)", () => {
    const out = timeLimitInterval(
      { remaining: 100, currentValue: 50, usage: 150 },
      "monthly",
      "MCP",
    );
    assert.ok(out);
    assert.equal(out!.remainingQuota, 100);
    assert.equal(out!.startAt, null);
    assert.equal(out!.endAt, null);
    assert.equal(out!.intervalMs, null);
  });
});