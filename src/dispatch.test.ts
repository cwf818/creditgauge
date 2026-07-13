import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildProviderLine, type FetchResult } from "./dispatch.ts";
import type { Quota, Balance } from "./api.ts";
import type { TokenSnapshot } from "./types.ts";
import { __resetForTest, configStore } from "./config.ts";

// The mode label the renderer emits for the active default display
// mode (Usage: / Remain:). Derived from config so flipping the
// default `display` value doesn't break the prefix assertions below.
const defaultModeLabel = () => {
  const cfg = configStore.get();
  return cfg.modeLabels[cfg.display as "used" | "remaining"];
};

const RESET = "\x1b[0m";
const RED = "\x1b[38;5;196m";
const STALE_COLOR = "\x1b[90m";
// v0.6.0+ — broken-chain color (matches colors.broken default).
const BROKEN_COLOR = "\x1b[31m";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// A minimally valid Quota payload (two windows) — enough for the renderer.
const MINI_DATA: Quota = {
  shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 62, remainingQuota: null, usedQuota: null, limitQuota: null },
  midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 39, remainingPercent: 61, remainingQuota: null, usedQuota: null, limitQuota: null },
  longInterval: null,
};

// A minimally valid Balance payload.
const DEEP_DATA: Balance = {
  isAvailable: true,
  entries: [{ currency: "USD", totalBalance: 25 }],
  minValue: 25,
};

// Pin config defaults the tests rely on so a future config refactor
// doesn't quietly break the assertions below.
const pinDefaults = () =>
  __resetForTest({
    cacheTtlMs: 60_000,
    stale: {
      ageEmoji: { healthy: "🔗", broken: "⛓️‍💥" },
    },
    timeFormat: { minUnit: "m", maxUnitCount: 2 },
    // vX.X.X+ — `statuslineTemplate` is array-only. Pin a raw
    // token list (no `m_modeLabel|color:yellow`, no fragment
    // indirection — the bare-prefix asserts below expect
    // "Usage: " / "Balance: " without an ANSI SGR prefix).
    // Tests that exercise DeepSeek rendering get the balance
    // piece via `m_modeLabel` + `m_balance`. Each test that
    // wants a different template overrides `statuslineTemplate`
    // directly via the second arg to `__resetForTest`.
    statuslineTemplate: [
      "m_modeLabel", "s_space", "m_balance",
      "s_newline",
      "m_modeLabel", "s_space",
      "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
      "s_space", "s_dot", "s_space",
      "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
    ],
  });

describe("buildProviderLine — fresh (no age suffix; data just arrived)", () => {
  it("MiniMax: fresh tick with ageMs=0 renders no X-ago suffix", () => {
    pinDefaults();
    const result: FetchResult<Quota> = { kind: "fresh", data: MINI_DATA, ageMs: 0 };
    const line = buildProviderLine("minimax", result);
    assert.ok(line);
    // vX.X.X+ — m_modeLabel here is bare (no `|color:yellow`), but
    // the trailing balance fragment prepends a deepseek-only line
    // (m_balance). Strip SGRs to be safe across future color
    // injections.
    assert.ok(strip(line!).startsWith(`${defaultModeLabel()} `));
    assert.ok(!line!.includes("ago"));
    assert.ok(!line!.includes(STALE_COLOR));
  });

  it("DeepSeek: fresh tick with ageMs=0 renders no X-ago suffix (no window concept)", () => {
    pinDefaults();
    const result: FetchResult<Balance> = { kind: "fresh", data: DEEP_DATA, ageMs: 0 };
    const line = buildProviderLine("deepseek", result);
    assert.ok(line);
    // vX.X.X+ — m_modeLabel in DEFAULT_LINE_TEMPLATE.balance carries
    // `|color:yellow`, so strip SGRs before the literal-prefix check.
    assert.ok(strip(line!).startsWith("Balance: "));
    assert.ok(strip(line!).startsWith("Balance: $25"));
    assert.ok(!line!.includes("ago"));
  });

  it("MiniMax: within-TTL cache hit (ageMs>0) renders NO age suffix (default template has no m_age)", () => {
    // v0.4.0 priority: template presence wins. Default plan/balance
    // templates do NOT include m_age, so a within-TTL cache hit
    // (fresh, ageMs > 0) renders no suffix — the broken-chain
    // indicator is reserved for stale state. Users opt in to the
    // healthy-emoji path by listing m_age in their lineTemplate.
    pinDefaults();
    const result: FetchResult<Quota> = {
      kind: "fresh",
      data: MINI_DATA,
      ageMs: 30_000,
    };
    const line = buildProviderLine("minimax", result);
    assert.ok(line);
    assert.ok(!line!.includes("ago"), `got: ${line}`);
    assert.ok(!line!.includes(STALE_COLOR), `got: ${line}`);
  });

  it("DeepSeek: within-TTL cache hit (ageMs>0) renders NO age suffix (default template has no m_age)", () => {
    pinDefaults();
    const result: FetchResult<Balance> = {
      kind: "fresh",
      data: DEEP_DATA,
      ageMs: 5 * 60_000,
    };
    const line = buildProviderLine("deepseek", result);
    assert.ok(line);
    assert.ok(!line!.includes("ago"), `got: ${line}`);
    assert.ok(!line!.includes(STALE_COLOR), `got: ${line}`);
  });

  it("MiniMax: fresh cache hit WITH m_age in template renders healthy 🔗", () => {
    // v0.4.0 priority: template presence wins. When the user lists
    // m_age in their lineTemplate, the module emits unconditionally
    // (no stale gating). Fresh + ageMs > 0 → 🔗 X ago.
    pinDefaults();
    __resetForTest({
      statuslineTemplate: [
        "m_modeLabel", "s_space",
        "m_windowQuota|term|short", "s_space", "m_countdown|term|short",
        "s_space", "m_age",
      ],
      // Preserve minute-grain suffix so "<1m ago" matches under
      // the default minUnit='s' (which would emit "30s ago"
      // instead). Same pin as pinDefaults() carries.
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const result: FetchResult<Quota> = {
        kind: "fresh",
        data: MINI_DATA,
        ageMs: 30_000,
      };
      const line = buildProviderLine("minimax", result);
      assert.ok(line);
      assert.ok(strip(line!).endsWith("🔗 <1m ago"), `got: ${line}`);
    } finally {
      __resetForTest();
    }
  });

  it("null provider + no tokens: returns null (nothing useful to render)", () => {
    // v0.4.x — the "no provider + no tokens + no data" path returns
    // null because the renderer would only produce a label-only
    // degenerate output (default plan template drops every module).
    // The empty-output guard catches that and translates it back to
    // null. The old behavior was to bail at the very top of
    // buildProviderLine; we now let the renderer run and recognize
    // the emptiness downstream, which keeps the per-module filter
    // pipeline consistent.
    pinDefaults();
    const result: FetchResult<Quota> = { kind: "fresh", data: MINI_DATA, ageMs: 0 };
    assert.equal(buildProviderLine(null, result), null);
  });
});

describe("buildProviderLine — stale (fetch failed, cache reused; broken emoji)", () => {
  it("MiniMax: appends dim '⛓️‍💥 5m ago' suffix (broken emoji on stale)", () => {
    pinDefaults();
    // Stale-on-error → ageMs from cache.peekWithAge (time since last
    // successful fetch), NOT from any API timestamp.
    const result: FetchResult<Quota> = {
      kind: "stale",
      data: MINI_DATA,
      ageMs: 5 * 60_000,
    };
    const line = buildProviderLine("minimax", result);
    assert.ok(line);
    assert.ok(strip(line!).endsWith("⛓️‍💥 5m ago"));
    assert.ok(line!.endsWith(`${BROKEN_COLOR}⛓️‍💥 5m ago${RESET}`));
  });

  it("DeepSeek: appends dim '⛓️‍💥 1h30m ago' suffix (maxUnitCount=2 keeps minutes)", () => {
    pinDefaults();
    const result: FetchResult<Balance> = {
      kind: "stale",
      data: DEEP_DATA,
      ageMs: 90 * 60_000,
    };
    const line = buildProviderLine("deepseek", result);
    assert.ok(line);
    // 90 minutes = 1h30m, NOT "1h" (maxUnitCount=2 keeps internal non-zero units).
    assert.ok(strip(line!).endsWith("⛓️‍💥 1h30m ago"));
  });

  it("stale line still renders the actual cached data (not 'not available!')", () => {
    pinDefaults();
    const result: FetchResult<Balance> = {
      kind: "stale",
      data: DEEP_DATA,
      ageMs: 5 * 60_000,
    };
    const line = buildProviderLine("deepseek", result);
    assert.ok(strip(line!).includes("$25"));
    assert.ok(!strip(line!).includes("not available"));
  });

  it("MiniMax: stale ageMs=0 renders '⛓️‍💥 0m ago' (just-failed fetch)", () => {
    // v0.4.0: formatStaleSuffix no longer short-circuits on ageMs=0.
    // A fetch that just failed at this instant now shows
    // "⛓️‍💥 0m ago" (or "<1s ago" with minUnit=s) instead of a bare
    // emoji. The visibility gate is now stale=true at the renderer.
    pinDefaults();
    const result: FetchResult<Quota> = {
      kind: "stale",
      data: MINI_DATA,
      ageMs: 0,
    };
    const line = buildProviderLine("minimax", result);
    assert.ok(line);
    assert.ok(strip(line!).endsWith("⛓️‍💥 0m ago"), `got: ${line}`);
  });
});

describe("buildProviderLine — fail", () => {
  it("MiniMax: renders 'Usage: not available!' in RED", () => {
    pinDefaults();
    const result: FetchResult<Quota> = { kind: "fail" };
    const line = buildProviderLine("minimax", result);
    assert.equal(line, `Usage: ${RED}not available!${RESET}`);
    assert.equal(strip(line!), "Usage: not available!");
  });

  it("DeepSeek: renders 'Balance: not available!' in RED", () => {
    pinDefaults();
    const result: FetchResult<Balance> = { kind: "fail" };
    const line = buildProviderLine("deepseek", result);
    assert.equal(line, `Balance: ${RED}not available!${RESET}`);
    assert.equal(strip(line!), "Balance: not available!");
  });

  it("null provider + fail + no tokens: renders 'Usage: not available!'", () => {
    // v0.4.x — the "no provider" early-return is gone. With no tokens
    // AND no provider, the only thing we can render is the colored
    // "not available!" sentinel using the default usage label —
    // matches the established fail-line semantics users already see
    // when ANTHROPIC_BASE_URL points at a supported provider but the
    // fetch fails. The empty-output guard at the bottom of
    // buildProviderLine re-routes the would-be-empty render through
    // failLabelForProvider + the RED sentinel.
    pinDefaults();
    const result: FetchResult<Quota> = { kind: "fail" };
    const line = buildProviderLine(null, result);
    assert.equal(line, `Usage: ${RED}not available!${RESET}`);
    assert.equal(strip(line!), "Usage: not available!");
  });

  it("fail line does NOT carry a stale suffix (nothing to be stale-of)", () => {
    pinDefaults();
    const result: FetchResult<Balance> = { kind: "fail" };
    const line = buildProviderLine("deepseek", result);
    assert.ok(!line!.includes("ago"));
    assert.ok(!line!.includes(STALE_COLOR));
  });
});

describe("buildProviderLine — null provider (no ANTHROPIC_BASE_URL match)", () => {
  // v0.4.x — when ANTHROPIC_BASE_URL doesn't match any configured
  // provider entry, the user still gets a statusline so long as
  // provider-AGNOSTIC modules have something to render. Plan-only
  // modules (m_windowQuota*, m_countdown*) and m_balance silently drop
  // via the per-module `mode` filter; everything else (m_token*,
  // m_version, m_session, …) renders normally because their data
  // sources (stdin snapshot) have nothing to do with provider
  // state. This is the "single statusline slot, no supported
  // provider" path the user explicitly opted into.
  const TOKENS: TokenSnapshot = {
    sessionId: "sess-test",
    cwd: "D:\\test",
    totals: { tokenTotalIn: 163479, tokenTotalOut: 155 },
    current: {
      tokenIn: 38,
      tokenOut: 155,
      tokenCacheCreation: 0,
      tokenCachedIn: 163441,
    },
    cost: { totalDurationMs: 600_000, totalApiDurationMs: 60_000, totalLinesAdded: 3965, totalLinesRemoved: 967 },
    sessionName: "strip-diagnostics-display",
    modelDisplayName: "MiniMax-M3",
    modelId: "MiniMax-M3",
    effort: "high",
    repo: { host: "github.com", owner: "cwf818", name: "topgauge" },
    ccversion: "2.1.191",
    contextWindow: { contextWindowSize: 200000, contextUsedPercent: 63, contextRemainingPercent: 37 },
  };

  it("null provider + fresh data + tokens: renders provider-agnostic modules", () => {
    pinDefaults();
    // Custom template: only provider-agnostic modules. On a null
    // provider every one should fire. Plan-only modules would drop
    // here; we deliberately exclude them so the assertion is
    // independent of mode filters.
    //
    // Uses m_tokenInTotal / m_tokenTotalOut (read from stdin
    // context_window.total_input_tokens) instead of m_tokenIn /
    // m_tokenOut — the latter are per-API-call DELTAS that depend
    // on the prior-tick cache, which is empty on the first render
    // and would show 0/0. Total modules are unconditional.
    //
    // Note: m_version is omitted from this template because the
    // dispatch path passes cfg().version (empty string by default
    // after __resetForTest), and m_version returns null on empty.
    // version propagation is exercised by other tests.
    __resetForTest({
      statuslineTemplate: [
        "m_session", "s_space", "m_model",
        "s_space", "m_tokenInTotal", "s_space", "m_tokenTotalOut",
      ],
    });
    try {
      const result: FetchResult<Quota> = {
        kind: "fresh",
        data: MINI_DATA,
        ageMs: 0,
      };
      const line = buildProviderLine(null, result, TOKENS);
      assert.ok(line, "null provider + tokens must produce a line");
      const text = strip(line!);
      // Provider-agnostic modules that match the template:
      assert.ok(text.includes("strip-diagnostics-display"), `got: ${text}`);
      assert.ok(text.includes("MiniMax-M3"), `got: ${text}`);
      assert.ok(text.includes("in:163.5k"), `got: ${text}`);
      assert.ok(text.includes("out:155"), `got: ${text}`);
    } finally {
      __resetForTest();
    }
  });

  it("null provider + fresh data + tokens + plan-only modules: those drop", () => {
    pinDefaults();
    // Mixed template — provider-agnostic + plan-only. On a null
    // provider the plan-only ones must drop, the agnostic ones fire.
    __resetForTest({
      statuslineTemplate: [
        "m_session", "s_space", "m_windowQuota|term|short", "s_space", "m_windowQuota|term|mid",
        "s_space", "m_balance", "s_space", "m_tokenInTotal",
      ],
    });
    try {
      const result: FetchResult<Quota> = {
        kind: "fresh",
        data: MINI_DATA,
        ageMs: 0,
      };
      const line = buildProviderLine(null, result, TOKENS);
      assert.ok(line, "non-empty line expected (m_session + m_tokenInTotal)");
      const text = strip(line!);
      assert.ok(text.includes("strip-diagnostics-display"), `got: ${text}`);
      assert.ok(text.includes("in:163.5k"), `got: ${text}`);
      // m_windowQuota|term|short / m_windowQuota|term|mid / m_balance must NOT have rendered:
      assert.ok(!text.includes("38%"), `got: ${text}`);
      assert.ok(!text.includes("39%"), `got: ${text}`);
      assert.ok(!text.includes("$"), `got: ${text}`);
    } finally {
      __resetForTest();
    }
  });

  it("null provider + fail + tokens: renders fail label + token modules (not 'not available!')", () => {
    pinDefaults();
    // v0.4.x — fail-with-tokens path renders the template (so the
    // user's m_token* modules emit) and falls back to the colored
    // "not available!" sentinel only when the rendered output is
    // effectively empty. With tokens present, m_tokenInTotal will
    // fire and the line is non-empty → return the template render,
    // not the hard-coded sentinel string. m_tokenInTotal (not
    // m_tokenIn) for the same reason as above — total is
    // unconditional, delta is cache-dependent.
    __resetForTest({
      statuslineTemplate: [
        "m_modeLabel", "s_space", "m_tokenInTotal",
      ],
    });
    try {
      const result: FetchResult<Quota> = { kind: "fail" };
      const line = buildProviderLine(null, result, TOKENS);
      assert.ok(line);
      const text = strip(line!);
      assert.ok(text.startsWith(defaultModeLabel()), `got: ${text}`);
      assert.ok(text.includes("in:163.5k"), `got: ${text}`);
      assert.ok(
        !text.includes("not available"),
        `got: ${text} (should NOT be the not-available! sentinel)`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("null provider + fresh data + no tokens: returns null (empty-output guard)", () => {
    pinDefaults();
    // Default template resolves to PLAN_PRESETS["1line"], which is
    // a sub-template that emits only the "plan" lineTemplate. With
    // no provider and no tokens, that whole fragment drops → the
    // empty-output guard kicks in → null.
    const result: FetchResult<Quota> = {
      kind: "fresh",
      data: MINI_DATA,
      ageMs: 0,
    };
    assert.equal(buildProviderLine(null, result), null);
  });

  it("null provider + fail + no tokens: returns the colored fail line (not null)", () => {
    // The empty-output guard translates "renderer would produce
    // nothing useful" into the conventional fail sentinel via
    // failLabelForProvider. So a null provider + fail + no tokens
    // surfaces "Usage: not available!" — exactly the same shape as
    // a configured provider's hard fail, so the user sees a
    // consistent signal across both paths.
    pinDefaults();
    const result: FetchResult<Quota> = { kind: "fail" };
    const line = buildProviderLine(null, result);
    assert.equal(line, `Usage: ${RED}not available!${RESET}`);
  });
});