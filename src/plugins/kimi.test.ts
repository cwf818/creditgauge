// Unit tests for the kimi user plugin's fill contract.
// Loads the captured real-shape fixture at
// src/__fixtures__/quota.real.kimi.json and asserts each of the
// three reserved interval slots (short / mid / long) maps to the
// right raw sub-tree and exposes the right derived fields.
//
// v0.9.5 — fillQuota returns the open-ended dict `{ short, mid,
// long }` directly (the v0.9.4 `intervals:` wrapper was dropped
// per the new-feature hard-cut convention). The host's ensureQuota
// wraps this back into the canonical Quota shape after the plugin
// returns. Tests below read the pre-wrapping dict directly.
//
// The host loader never touches these functions — they exist solely
// to pin the contract so a regression in fillQuota surfaces here
// before reaching the statusline.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// kimi/index.js is plain ESM JS with no .d.ts — typecheck allows
// the runtime import to resolve loosely. Tests stay pinned to the
// live plugin (no test-only re-implementation of fillQuota).
// @ts-expect-error no .d.ts for the user plugin
import { MID_INTERVAL_MS, fillQuota } from "../../query_plugins/kimi/index.js";

const fixturePath = fileURLToPath(
  new URL("../__fixtures__/quota.real.kimi.json", import.meta.url),
);

function loadFixture(): unknown {
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

describe("kimi plugin — fillQuota against quota.real.kimi.json", () => {
  const raw = loadFixture();
  const quota = fillQuota(raw as never);

  it("returns a non-null Partial<Quota>", () => {
    assert.ok(quota, "fillQuota should produce a quota");
  });

  // short ← usages.limits[0].detail. duration 300 minutes →
  // intervalMs = 300 × 60 × 1000 = 18_000_000 ms.
  describe("short", () => {
    it("reads remaining from usages.limits[0].detail.remaining", () => {
      assert.equal(quota!.short!.remainingPercent, 100);
      assert.equal(quota!.short!.remainingQuota, 100);
    });
    it("derives intervalMs from window.duration minutes", () => {
      assert.equal(quota!.short!.intervalMs, 300 * 60 * 1000);
    });
    it("back-derives startAt = resetTime − intervalMs", () => {
      const resetAt = Date.parse("2026-07-02T03:32:40.140865Z");
      assert.equal(quota!.short!.endAt, resetAt);
      assert.equal(
        quota!.short!.startAt,
        resetAt - 300 * 60 * 1000,
      );
    });
    it("limits[0].detail.limit populates limitQuota", () => {
      assert.equal(quota!.short!.limitQuota, 100);
    });
  });

  // mid ← usages.detail (the primary 7-day cycle).
  describe("mid", () => {
    it("reads remaining from usages.detail.remaining", () => {
      assert.equal(quota!.mid!.remainingPercent, 58);
      assert.equal(quota!.mid!.usedPercent, 42);
    });
    it("uses the fixed 1-week intervalMs (7d)", () => {
      assert.equal(quota!.mid!.intervalMs, MID_INTERVAL_MS);
      assert.equal(MID_INTERVAL_MS, 7 * 24 * 60 * 60 * 1000);
    });
    it("back-derives startAt = resetTime − 7d", () => {
      const resetAt = Date.parse("2026-07-07T11:32:40.140865Z");
      assert.equal(quota!.mid!.endAt, resetAt);
      assert.equal(quota!.mid!.startAt, resetAt - MID_INTERVAL_MS);
    });
    it("pulls limit/used from usages.detail.limit/used", () => {
      assert.equal(quota!.mid!.limitQuota, 100);
      assert.equal(quota!.mid!.usedQuota, 42);
    });
  });

  // long ← totalQuota.remaining. Kimi's totalQuota fields are
  // independent percentages on the same denominator (used:8,
  // remaining:92 of limit:100). Only the percentage is derivable —
  // Kimi ships no resetTime / cycle anchor for this field, so
  // startAt / endAt / intervalMs stay null.
  describe("long", () => {
    it("reads remaining from totalQuota.remaining (NOT 100−used)", () => {
      assert.equal(quota!.long!.remainingPercent, 92);
    });
    it("reads used directly from totalQuota.used (already a percentage)", () => {
      assert.equal(quota!.long!.usedPercent, 8);
    });
    it("leaves startAt / endAt / intervalMs null (no anchor available)", () => {
      assert.equal(quota!.long!.startAt, null);
      assert.equal(quota!.long!.endAt, null);
      assert.equal(quota!.long!.intervalMs, null);
    });
    it("populates remainingQuota + usedQuota + limitQuota", () => {
      assert.equal(quota!.long!.remainingQuota, 92);
      assert.equal(quota!.long!.usedQuota, 8);
      assert.equal(quota!.long!.limitQuota, 100);
    });
  });

  it("returns null when no FEATURE_CODING usage is present", () => {
    const empty = fillQuota({ usages: [], totalQuota: { remaining: "92" } } as never);
    assert.equal(empty, null);
  });
});
