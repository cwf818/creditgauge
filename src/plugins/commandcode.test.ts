// Unit tests for the commandcode user plugin's fill contract.
// Loads the captured real-shape fixtures at
// src/__fixtures__/quota.real.commandcode.json and
// src/__fixtures__/subscription.real.commandcode.json and asserts each of
// the three reserved interval slots (short / mid / long) maps to the right
// raw sub-tree and exposes the right derived fields.
//
// fillQuota returns the open-ended dict `{ short, mid, long }` directly
// (matches the v0.9.5 convention — the v0.9.4 `intervals:` wrapper was
// dropped). The host's ensureQuota wraps this back into the canonical
// Quota shape after the plugin returns. Tests below read the pre-
// wrapping dict directly so the contract is pinned here, not inside
// ensureQuota.
//
// The host loader never touches these functions — they exist solely
// to surface a regression in fillQuota before it reaches the statusline.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// commandcode/index.js is plain ESM JS with no .d.ts — typecheck allows
// the runtime import to resolve loosely. Tests stay pinned to the live
// plugin (no test-only re-implementation of fillQuota).
// @ts-expect-error no .d.ts for the user plugin
import { SHORT_INTERVAL_MS, MID_INTERVAL_MS, fillQuota, buildShort, buildMid, buildLong, QUOTA_LIMIT_BY_PLAN } from "../../query_plugins/commandcode/index.js";

const quotaFixturePath = fileURLToPath(
  new URL("../__fixtures__/quota.real.commandcode.json", import.meta.url),
);
const subFixturePath = fileURLToPath(
  new URL("../__fixtures__/subscription.real.commandcode.json", import.meta.url),
);

function loadQuotaFixture(): unknown {
  return JSON.parse(readFileSync(quotaFixturePath, "utf8"));
}

function loadSubFixture(): unknown {
  return JSON.parse(readFileSync(subFixturePath, "utf8"));
}

describe("commandcode plugin — fillQuota against quota.real.commandcode.json", () => {
  const quotaRaw = loadQuotaFixture() as { credits: Record<string, unknown>; windowLimits: Record<string, unknown> };
  const subRaw = loadSubFixture() as { data: Record<string, unknown> };
  const raw = { ...quotaRaw, subscriptionData: subRaw.data };
  const quota = fillQuota(raw as never);

  it("returns a non-null Partial<Quota>", () => {
    assert.ok(quota, "fillQuota should produce a quota");
  });

  describe("short (5h — windowLimits.fiveHour)", () => {
    it("derives usedPercent from used / cap, rounded to 2dp", () => {
      // used=1.1541096572 cap=14 → 8.2436404% → 8.24.
      assert.equal(quota!.short!.usedPercent, 8.24);
    });
    it("derives remainingPercent = 100 − usedPercent, rounded to 2dp", () => {
      // 91.75635959028…% → 91.76.
      assert.equal(quota!.short!.remainingPercent, 91.76);
    });
    it("uses the 5h interval constant", () => {
      assert.equal(quota!.short!.intervalMs, SHORT_INTERVAL_MS);
      assert.equal(SHORT_INTERVAL_MS, 5 * 60 * 60 * 1000);
    });
    it("back-derives startAt = resetAt − 5h", () => {
      assert.equal(quota!.short!.endAt, 1787685791161);
      assert.equal(quota!.short!.startAt, 1787685791161 - SHORT_INTERVAL_MS);
    });
    it("maps used / cap to usedQuota / limitQuota, cap−used to remainingQuota, all 2dp", () => {
      assert.equal(quota!.short!.usedQuota, 1.15);
      assert.equal(quota!.short!.limitQuota, 14);
      assert.equal(quota!.short!.remainingQuota, 12.85);
    });
    it("labels the window 5h", () => {
      assert.equal(quota!.short!.windowId, "5h");
      assert.equal(quota!.short!.label, "5h");
    });
  });

  describe("mid (7d — windowLimits.weekly)", () => {
    it("derives usedPercent from used / cap, rounded to 2dp", () => {
      // used=2.9021765643 cap=35 → 8.291933% → 8.29.
      assert.equal(quota!.mid!.usedPercent, 8.29);
    });
    it("uses the 7d interval constant", () => {
      assert.equal(quota!.mid!.intervalMs, MID_INTERVAL_MS);
      assert.equal(MID_INTERVAL_MS, 7 * 24 * 60 * 60 * 1000);
    });
    it("back-derives startAt = resetAt − 7d", () => {
      assert.equal(quota!.mid!.endAt, 1788254540662);
      assert.equal(quota!.mid!.startAt, 1788254540662 - MID_INTERVAL_MS);
    });
    it("maps used / cap to the quota axis, rounded to 2dp", () => {
      assert.equal(quota!.mid!.usedQuota, 2.9);
      assert.equal(quota!.mid!.limitQuota, 35);
      assert.equal(quota!.mid!.remainingQuota, 32.1);
    });
  });

  describe("long (30d — subscriptions.data plan-aware window)", () => {
    // planId=individual-goat → limit 70. monthlyCredits=67.0978234357.
    it("maps planId → quota limit", () => {
      assert.equal(QUOTA_LIMIT_BY_PLAN["individual-go"], 10);
      assert.equal(QUOTA_LIMIT_BY_PLAN["individual-goat"], 70);
      assert.equal(QUOTA_LIMIT_BY_PLAN["individual-pro"], 80);
      assert.equal(QUOTA_LIMIT_BY_PLAN["individual-max10"], 150);
      assert.equal(QUOTA_LIMIT_BY_PLAN["individual-max20"], 300);
    });
    it("sets limitQuota from the plan ladder", () => {
      assert.equal(quota!.long!.limitQuota, 70);
    });
    it("derives usedQuota = limit − monthlyCredits, rounded to 2dp", () => {
      // 70 − 67.0978234357 = 2.9021765643 → 2.9.
      assert.equal(quota!.long!.usedQuota, 2.9);
    });
    it("derives usedPercent = used / limit, rounded to 2dp", () => {
      // 2.9021765643 / 70 = 4.1459665204% → 4.15.
      assert.equal(quota!.long!.usedPercent, 4.15);
    });
    it("derives remainingPercent = 100 − usedPercent, rounded to 2dp", () => {
      // 95.8540334796% → 95.85.
      assert.equal(quota!.long!.remainingPercent, 95.85);
    });
    it("carries the credit balance as remainingQuota, rounded to 2dp", () => {
      // 67.0978234357 → 67.1.
      assert.equal(quota!.long!.remainingQuota, 67.1);
    });
    it("anchors startAt / endAt to currentPeriodStart / currentPeriodEnd", () => {
      assert.equal(quota!.long!.endAt, Date.parse("2026-09-25T09:03:37.000Z"));
      assert.equal(quota!.long!.startAt, Date.parse("2026-08-25T09:03:37.000Z"));
      assert.equal(quota!.long!.intervalMs, Date.parse("2026-09-25T09:03:37.000Z") - Date.parse("2026-08-25T09:03:37.000Z"));
    });
  });
});

describe("commandcode plugin — soft-fail + unit paths", () => {
  const subData = { planId: "individual-goat", currentPeriodStart: "2026-08-25T09:03:37.000Z", currentPeriodEnd: "2026-09-25T09:03:37.000Z" };
  const credits = { monthlyCredits: 67.0978234357 };

  it("returns null when windowLimits is missing", () => {
    assert.equal(fillQuota({ credits, subscriptionData: subData } as never), null);
  });
  it("returns null when credits is missing", () => {
    assert.equal(fillQuota({ windowLimits: {}, subscriptionData: subData } as never), null);
  });
  it("returns null when either window sub-object is missing", () => {
    assert.equal(
      fillQuota({ credits, windowLimits: { fiveHour: {} }, subscriptionData: subData } as never),
      null,
    );
  });
  it("returns null when subscriptionData is missing", () => {
    assert.equal(
      fillQuota({ credits, windowLimits: { fiveHour: {}, weekly: {} } } as never),
      null,
    );
  });
  it("buildShort returns null when used/cap/resetAt missing", () => {
    assert.equal(buildShort({ used: 1, cap: 14 } as never), null);
    assert.equal(buildShort({} as never), null);
  });
  it("buildMid returns null when used/cap/resetAt missing", () => {
    assert.equal(buildMid({ used: 1, cap: 35 } as never), null);
  });
  it("buildLong returns null when monthlyCredits missing", () => {
    assert.equal(buildLong(subData, {} as never), null);
  });
  it("buildLong returns null when planId is not in the ladder", () => {
    assert.equal(buildLong({ ...subData, planId: "enterprise-custom" }, credits as never), null);
  });
  it("buildLong returns null when currentPeriodEnd missing", () => {
    assert.equal(buildLong({ ...subData, currentPeriodEnd: undefined }, credits as never), null);
  });
  it("buildLong accepts epoch-ms currentPeriodEnd", () => {
    const out = buildLong({ ...subData, currentPeriodEnd: 1790327017000 }, credits as never);
    assert.ok(out);
    assert.equal(out!.endAt, 1790327017000);
  });
  it("buildLong derives the full quota axis from plan + credits", () => {
    const out = buildLong(subData, { monthlyCredits: "64.7275989213" } as never);
    assert.ok(out);
    assert.equal(out!.limitQuota, 70);
    assert.equal(out!.usedQuota, 5.27);   // 70 − 64.7275989213 → 5.27
    assert.equal(out!.remainingQuota, 64.73);
    assert.equal(out!.usedPercent, 7.53); // 5.2724010787 / 70 → 7.53
    assert.equal(out!.remainingPercent, 92.47);
  });
});
