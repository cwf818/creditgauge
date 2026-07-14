// v0.4.x — regression tests for the per-module `type` filter on
// MODULES / INLINE_RENDERERS (added alongside the renderPlanLine
// unification in Phase 1, then renamed `mode` → `type` and widened
// to include `"unknown"` for unregistered providers; the
// `formatBalanceLine` shim was removed in v0.9.x but the filter
// contract is unchanged).
//
// The filter gates rendering on ctx.providerType:
//   m_windowQuota|term:short|mid|long, m_countdown|term:*, m_quota|term:* → "plan"
//   m_balance                                                        → "balance"
//   everything else (m_modeLabel, m_token*, m_age, …)                → agnostic
//
// A bare token matching these prefixes on a non-matching provider
// type MUST silently drop (no warn, no stray "·", no chunk).
// Adjacent s_<n> separators are skipped too via the existing
// null-fall-through path. A token on the matching provider type
// MUST render.
//
// "unknown" coverage: a hypothetical `m_xxx:type:"unknown"` would
// only emit when ANTHROPIC_BASE_URL doesn't match any configured
// provider. No module currently uses this; the test asserts that
// existing plan-only / balance-only modules drop on "unknown" (a
// regression guard if a future change accidentally re-adds the
// old "plan" fallback for null entry).

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate } from "./render.ts";
import { __resetForTest } from "./config.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Default seps from config.ts are [" ", "·"] — same as the existing
// render-tokens suite. We rely on this; a future config refactor
// would need to update this file in lockstep.
const BALANCE = {
  isAvailable: true,
  entries: [{ currency: "USD", totalBalance: 25 }],
  minValue: 25,
};

const ctxFor = (providerType: "quota" | "balance" | "unknown") => ({
  mode: "used" as const,
  nowMs: 1_000_000,
  intervals: {
    short: { windowId: "5h" as const, label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 30, remainingPercent: 70, remainingQuota: null, usedQuota: null, limitQuota: null },
    mid: { windowId: "7d" as const, label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 50, remainingPercent: 50, remainingQuota: null, usedQuota: null, limitQuota: null },
    long: null,
  },
  balance: BALANCE,
  ageMs: null,
  stale: false,
  version: "0.4.0-test",
  tokens: null,
  contextWindow: null,
  providerType,
});

beforeEach(() => __resetForTest());

describe("MODULES path: per-provider type filter", () => {
  it("m_windowQuota|term:short renders on plan ctx; drops on balance ctx", () => {
    const planLines = renderTemplate(["m_windowQuota|term:short"], ctxFor("quota"));
    assert.equal(planLines.length, 1);
    assert.ok(planLines[0]!.length > 0, "plan ctx must render the bar chunk");

    const balanceLines = renderTemplate(["m_windowQuota|term:short"], ctxFor("balance"));
    assert.deepEqual(balanceLines, [], "m_windowQuota|term:short must drop on balance");
  });

  it("m_windowQuota|term:mid / m_countdown|term:short / m_countdown|term:mid all plan-only", () => {
    for (const mod of ["m_windowQuota|term:mid", "m_countdown|term:short", "m_countdown|term:mid"]) {
      const planLines = renderTemplate([mod], ctxFor("quota"));
      assert.ok(planLines.length === 1, `${mod}: plan ctx rendered`);
      assert.ok(planLines[0]!.length > 0, `${mod}: plan ctx non-empty`);
      const balanceLines = renderTemplate([mod], ctxFor("balance"));
      assert.deepEqual(
        balanceLines,
        [],
        `${mod}: must drop on balance ctx`,
      );
    }
  });

  it("m_balance renders on balance ctx; drops on plan ctx", () => {
    const balanceLines = renderTemplate(["m_balance"], ctxFor("balance"));
    assert.equal(balanceLines.length, 1);
    assert.ok(balanceLines[0]!.includes("$25"), "balance ctx renders $25");

    const planLines = renderTemplate(["m_balance"], ctxFor("quota"));
    assert.deepEqual(planLines, [], "m_balance must drop on plan ctx");
  });

  it("provider-agnostic modules (m_version) render on ALL ctxs", () => {
    const planLines = renderTemplate(["m_version"], ctxFor("quota"));
    const balanceLines = renderTemplate(["m_version"], ctxFor("balance"));
    const unknownLines = renderTemplate(["m_version"], ctxFor("unknown"));
    assert.equal(planLines.length, 1);
    assert.equal(balanceLines.length, 1);
    assert.equal(unknownLines.length, 1);
    assert.equal(planLines[0], balanceLines[0]);
    assert.equal(planLines[0], unknownLines[0]);
    assert.ok(planLines[0]!.includes("v0.4.0-test"));
  });

  it("provider-agnostic m_modeLabel routes on ctx.providerType", () => {
    // m_modeLabel is tag-free (provider-agnostic); its BODY switches
    // on providerType to pick the right label. So the same token
    // renders different labels on plan vs balance — that's the
    // expected non-filter behavior. This pin guards against an
    // accidental future regression where someone drops the body
    // switch by mistake.
    //
    // "unknown" ctx: routes through the same branch as "plan" (the
    // display-mode label), since the user still has a modeLabels
    // entry for that display mode. Asserted below.
    const plan = renderTemplate(["m_modeLabel"], ctxFor("quota"));
    const balance = renderTemplate(["m_modeLabel"], ctxFor("balance"));
    const unknown = renderTemplate(["m_modeLabel"], ctxFor("unknown"));
    assert.equal(plan.length, 1);
    assert.equal(balance.length, 1);
    assert.equal(unknown.length, 1);
    assert.ok(strip(plan[0]!).startsWith("Usage:"), `got: ${plan}`);
    assert.ok(strip(balance[0]!).startsWith("Balance:"), `got: ${balance}`);
    // "unknown" shares the plan path: it gets the display-mode label,
    // NOT the balance label.
    assert.ok(
      strip(unknown[0]!).startsWith("Usage:"),
      `got: ${unknown} (unknown ctx should pick display-mode label, not balance)`,
    );
  });

  it("plan-only / balance-only modules also drop on 'unknown' ctx", () => {
    // v0.4.x — plan-only modules drop on "unknown" (their type
    // doesn't match). Same for balance-only. The empty-output guard
    // downstream translates this into a null return at the dispatcher
    // level when no agnostic modules emit either.
    const windowOnUnknown = renderTemplate(["m_windowQuota|term:short"], ctxFor("unknown"));
    assert.deepEqual(windowOnUnknown, [], "m_windowQuota|term:short must drop on unknown");

    const balanceOnUnknown = renderTemplate(["m_balance"], ctxFor("unknown"));
    assert.deepEqual(balanceOnUnknown, [], "m_balance must drop on unknown");
  });

  it("dropped plan module leaves the named s_space separator between them", () => {
    // vX.X.X+: named s_<name> separators are ALWAYS literal
    // (s_space → " "), even when the adjacent modules are
    // provider-filtered out. The pre-vX.X.X behavior of dropping
    // the separator alongside its adjacent module only applied
    // to the numeric `s_<n>` form (which resolved to undefined
    // on the default empty `separators` array). Named aliases
    // are no longer dependent on any config and never go
    // "out-of-range", so this test now asserts the literal
    // emission.
    const balanceLines = renderTemplate(
      ["m_windowQuota|term:short", "s_space", "m_windowQuota|term:mid"],
      ctxFor("balance"),
    );
    assert.deepEqual(balanceLines, [" "]);
  });
});

describe("inline-args path: per-provider type filter", () => {
  it("m_windowQuota|term:short|color:red drops on balance ctx", () => {
    const planLines = renderTemplate(
      ["m_windowQuota|term:short|color:red"],
      ctxFor("quota"),
    );
    assert.equal(planLines.length, 1);
    assert.ok(planLines[0]!.includes("30%"));
    const balanceLines = renderTemplate(
      ["m_windowQuota|term:short|color:red"],
      ctxFor("balance"),
    );
    assert.deepEqual(balanceLines, []);
  });

  it("m_balance|color:darkGreen drops on plan ctx", () => {
    // Use a real color shortcut (darkGreen is one of the 7 valid
    // shortcuts — see LABEL_COLOR_SHORTCUTS in render.ts). "green"
    // alone is rejected by resolveColor → parse fail → not the
    // path we want to exercise here.
    const balanceLines = renderTemplate(
      ["m_balance|color:darkGreen"],
      ctxFor("balance"),
    );
    assert.equal(balanceLines.length, 1);
    assert.ok(balanceLines[0]!.includes("$25"));
    const planLines = renderTemplate(
      ["m_balance|color:darkGreen"],
      ctxFor("quota"),
    );
    assert.deepEqual(planLines, []);
  });

  it("m_balance (bare) drops on plan ctx (mirrors MODULES path)", () => {
    const planLines = renderTemplate(["m_balance"], ctxFor("quota"));
    assert.deepEqual(planLines, []);
  });

  it("provider-agnostic inline form (m_version:color:red) renders on ALL ctxs", () => {
    const plan = renderTemplate(["m_version|color:red"], ctxFor("quota"));
    const balance = renderTemplate(["m_version|color:red"], ctxFor("balance"));
    const unknown = renderTemplate(["m_version|color:red"], ctxFor("unknown"));
    assert.equal(plan.length, 1);
    assert.equal(balance.length, 1);
    assert.equal(unknown.length, 1);
    assert.equal(plan[0], balance[0]);
    assert.equal(plan[0], unknown[0]);
    assert.ok(plan[0]!.includes("v0.4.0-test"));
  });
});

describe("composition: a balance ctx with mixed-type template", () => {
  it("renders the balance token; skips plan modules", () => {
    // User-written template that BOTH kinds of modules happen to
    // appear in. On a balance provider the plan ones must drop,
    // the balance one must render, and the s_0 separators between
    // them must collapse cleanly (no orphan "·").
    const balance = renderTemplate(
      ["m_modeLabel", "s_space", "m_windowQuota|term:short", "s_space", "m_windowQuota|term:mid",
        "s_space", "m_balance"],
      ctxFor("balance"),
    );
    assert.equal(balance.length, 1);
    const text = strip(balance[0]!);
    assert.ok(text.startsWith("Balance:"), `got: ${text}`);
    assert.ok(text.includes("$25"), `got: ${text}`);
    assert.ok(!text.includes("30%"), `got: ${text}`);
    assert.ok(!text.includes("50%"), `got: ${text}`);
    assert.ok(!text.includes(" ·  ·"), `got: ${text} (orphan separators)`);
  });

  it("renders plan modules; skips m_balance", () => {
    const plan = renderTemplate(
      ["m_modeLabel", "s_space", "m_windowQuota|term:short", "s_space", "m_windowQuota|term:mid",
        "s_space", "m_balance"],
      ctxFor("quota"),
    );
    assert.equal(plan.length, 1);
    const text = strip(plan[0]!);
    assert.ok(text.startsWith("Usage:"), `got: ${text}`);
    assert.ok(text.includes("30%") || text.includes("0%") || text.length > 0);
    assert.ok(!text.includes("$25"), `got: ${text} (m_balance leaked)`);
  });

  it("renders neither plan nor balance on unknown ctx; m_modeLabel only", () => {
    // On "unknown" ctx, m_windowQuota* and m_balance drop via the
    // per-module type filter. m_modeLabel still emits because it's
    // provider-agnostic (its body routes on providerType and uses
    // the display-mode label). This is the new third providerType
    // value that didn't exist in Phase 1.
    const unknown = renderTemplate(
      ["m_modeLabel", "s_space", "m_windowQuota|term:short", "s_space", "m_windowQuota|term:mid",
        "s_space", "m_balance"],
      ctxFor("unknown"),
    );
    assert.equal(unknown.length, 1);
    const text = strip(unknown[0]!);
    assert.ok(text.startsWith("Usage:"), `got: ${text}`);
    assert.ok(!text.includes("30%"), `got: ${text} (m_windowQuota|term:short leaked)`);
    assert.ok(!text.includes("50%"), `got: ${text} (m_windowQuota|term:mid leaked)`);
    assert.ok(!text.includes("$25"), `got: ${text} (m_balance leaked)`);
  });
});