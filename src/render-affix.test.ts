// vX.X.X+ — m_* prefix/suffix auto-space tests. Spec:
// docs/superpowers/specs/2026-08-08-m-affix-autospace-design.md
// prefixSpace (default true) auto-prepends a space before each m_*
// module (except m_label / m_template) per R1/R2/R3; suffixSpace
// (default false) auto-appends before a following module. Explicit
// |prefix:| / |suffix:| always overrides the global default.
//
// NOTE vs the implementation plan's Task 2 test file:
//  - imports corrected to the real module layout (`__resetForTest as
//    resetCacheForTest` from cache.ts; resetTickStateForTest /
//    beginTickForTest live in status-store.ts, not tick-state.ts).
//  - the "color span" assertion checks the prefix precedes the actual
//    red SGR this codebase emits (`\x1b[38;5;196m`), not `\x1b[31m`.
//  - `renderTemplate` / DEFAULT_LINE_TEMPLATES /
//    DEFAULT_STATUSLINE_PRESETS power Task 3's byte-identity sweep
//    (appended at the bottom of this file).
//
// vX.X.X+ — the sweep at the bottom is now a CLEANUP byte-identity
// guard: the redundant `s_space` tokens were dropped from the
// built-in templates (auto-space under prefixSpace=true reproduces
// the spacing), so the "prefixSpace off vs on" premise is INVERTED.
// The guard renders each built-in BOTH from its pre-cleanup snapshot
// (src/__fixtures__/pre-affix-templates.ts — captured verbatim from
// HEAD `0aa054e`) AND from the cleaned DEFAULT_LINE_TEMPLATES /
// DEFAULT_STATUSLINE_PRESETS, both under prefixSpace=true, and
// asserts the outputs are identical. I.e. "the s_space cleanup is
// byte-identical — pre-cleanup templates render identically to the
// cleaned ones under prefixSpace=true".

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderProviderLine, renderTemplate } from "./render.ts";
import { DEFAULT_LINE_TEMPLATES, DEFAULT_STATUSLINE_PRESETS } from "./config.template.ts";
import {
  PRE_CLEANUP_LINE_TEMPLATES,
  PRE_CLEANUP_STATUSLINE_PRESETS,
} from "./__fixtures__/pre-affix-templates.ts";
import { __resetForTest } from "./config.ts";
import {
  __resetForTest as resetCacheForTest,
  setCachePathResolver,
} from "./cache.ts";
import {
  beginTickForTest,
  resetTickStateForTest,
  setStateRoot,
} from "./status-store.ts";
import type { TokenSnapshot } from "./types.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

let _tmpDir: string;
beforeEach(() => {
  _tmpDir = mkdtempSync(join(tmpdir(), "affix-"));
  setCachePathResolver(() => join(_tmpDir, "cache.json"));
  setStateRoot(() => join(_tmpDir, "state"));
  resetCacheForTest();
  resetTickStateForTest();
  beginTickForTest(null, null);
  __resetForTest();
});
afterEach(() => __resetForTest());

// Minimal TokenSnapshot so m_token*/m_model/m_provider render real
// values in the affix tests.
const SNAP: TokenSnapshot = {
  sessionId: "sess-affix",
  cwd: "D:\\test",
  totals: { tokenTotalIn: 163479, tokenTotalOut: 155 },
  current: {
    tokenIn: 38,
    tokenOut: 155,
    tokenCacheCreation: 0,
    tokenCachedIn: 163441,
  },
  cost: {
    totalDurationMs: 600_000,
    totalApiDurationMs: 60_000,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
  },
  sessionName: "affix-session",
  modelDisplayName: "MiniMax-M3",
  modelId: "MiniMax-M3",
  effort: "high",
  contextWindow: {
    contextWindowSize: 200000,
    contextUsedPercent: 63,
    contextRemainingPercent: 37,
  },
};

// Render a custom statuslineTemplate via renderProviderLine("minimax").
function line(tpl: string[], overrides: Record<string, unknown> = {}): string {
  __resetForTest({
    statuslineTemplate: tpl,
    ...overrides,
  });
  try {
    return renderProviderLine("minimax", {
      mode: "used",
      nowMs: 1_000_000,
      shortInterval: {
        windowId: "5h", label: "5h", startAt: null, endAt: null,
        intervalMs: null, usedPercent: 30, remainingPercent: 70,
        remainingQuota: null, usedQuota: null, limitQuota: null,
      },
      midInterval: {
        windowId: "7d", label: "7d", startAt: null, endAt: null,
        intervalMs: null, usedPercent: 50, remainingPercent: 50,
        remainingQuota: null, usedQuota: null, limitQuota: null,
      },
      longInterval: null,
      balance: null,
      ageMs: 5 * 60_000,
      stale: false,
      version: "0.0.0",
      tokens: SNAP,
    });
  } finally {
    __resetForTest();
  }
}

describe("m_* auto-space (prefixSpace=true default)", () => {
  it("R1: no leading space on the first module of a line", () => {
    assert.equal(strip(line(["m_modeLabel", "m_version"])), "Usage: v0.0.0");
  });

  it("R1: no leading space after s_newline", () => {
    assert.equal(strip(line(["m_version", "s_newline", "m_version"])), "v0.0.0\nv0.0.0");
  });

  it("R3: no auto space after a literal token", () => {
    assert.equal(strip(line(["m_version", "/", "m_model"])), "v0.0.0/MiniMax-M3");
  });

  it("R2: no double space after m_label with trailing space", () => {
    assert.equal(strip(line(["m_label|Context: ", "m_version"])), "Context: v0.0.0");
  });

  it("R2: colored m_label trailing space still suppresses", () => {
    assert.equal(
      strip(line(["m_label|Context: |color:yellow", "m_version"])),
      "Context: v0.0.0",
    );
  });

  it("R2: no double space after s_dot|wrap:both", () => {
    assert.equal(
      strip(line(["m_version", "s_dot|wrap:both", "m_version"])),
      "v0.0.0 · v0.0.0",
    );
  });

  it("adjacent modules get a single space", () => {
    assert.equal(strip(line(["m_version", "m_model"])), "v0.0.0 MiniMax-M3");
  });

  it("a dropped middle module preserves spacing", () => {
    // m_balance is balance-typed → type-drop on the minimax (quota) ctx.
    assert.equal(strip(line(["m_version", "m_balance", "m_model"])), "v0.0.0 MiniMax-M3");
  });

  it("a dropped first module yields no leading space", () => {
    assert.equal(strip(line(["m_balance", "m_model"])), "MiniMax-M3");
  });

  it("explicit |prefix:| (empty) disables the auto space", () => {
    assert.equal(strip(line(["m_modeLabel", "m_version|prefix:"])), "Usage:v0.0.0");
  });

  it("explicit |prefix: · | renders the dot idiom in one token", () => {
    assert.equal(
      strip(line(["m_version", "m_version|prefix: · "])),
      "v0.0.0 · v0.0.0",
    );
  });

  it("explicit |suffix:| appends after the module", () => {
    // Suffix appends; the next module's auto-prefix still fires per R1/R2/R3.
    assert.equal(strip(line(["m_version|suffix:/", "m_model"])), "v0.0.0/ MiniMax-M3");
    // An explicit empty prefix on the next module glues instead.
    assert.equal(strip(line(["m_version|suffix:/", "m_model|prefix:"])), "v0.0.0/MiniMax-M3");
  });

  it("prefix/suffix render OUTSIDE the color span", () => {
    const raw = line(["m_version|color:red|prefix: · "]);
    assert.ok(raw.startsWith(" · \x1b["), `prefix must precede color: ${JSON.stringify(raw)}`);
  });

  it("suffix renders OUTSIDE the color span (after the reset)", () => {
    // The colored body ends with the reset code (`\x1b[0m`); the suffix
    // must follow it, not sit inside the red span.
    const raw = line(["m_version|color:red|suffix: · "]);
    assert.ok(
      raw.endsWith("\x1b[0m · "),
      `suffix must follow the color reset: ${JSON.stringify(raw)}`,
    );
  });

  it("`=` pair separator works identically to `:`", () => {
    // Structural `|` then `=` pair boundary (v0.8.33+); the affix arg
    // parses exactly like the `:` form.
    assert.equal(
      strip(line(["m_version|prefix=· ", "m_model"])),
      "· v0.0.0 MiniMax-M3",
    );
  });

  it("unknown m_* token counts as a module predecessor", () => {
    // Unknown m_* renders verbatim but is NOT itself auto-spaced (it is
    // not a rendered module) — it glues onto the previous chunk.
    assert.equal(strip(line(["m_version", "m_foo"])), "v0.0.0m_foo");
    // Module-shaped predecessor: the following real module auto-spaces.
    assert.equal(strip(line(["m_foo", "m_version"])), "m_foo v0.0.0");
  });

  it("m_label rejects prefix/suffix (badarg → warn + drop)", () => {
    assert.equal(strip(line(["m_label|Context: |prefix:x"])), "");
  });

  it("m_template rejects prefix/suffix (badarg → warn + drop)", () => {
    assert.equal(strip(line(["m_template|information|suffix:x"])), "");
  });

  it("separator rejects prefix/suffix (badarg → warn + drop)", () => {
    // Separators must not accept affix args — the token is badarg-dropped.
    assert.equal(strip(line(["s_space|prefix:x"])), "");
  });

  it("fragment → module gets auto space (m_template counts as a module)", () => {
    assert.equal(
      strip(line(["m_template|f", "m_version"], { lineTemplates: { f: ["m_model"] } })),
      "MiniMax-M3 v0.0.0",
    );
  });

  it("module → fragment glues under default (fragment first module is line-start)", () => {
    assert.equal(
      strip(line(["m_modeLabel", "m_template|f"], { lineTemplates: { f: ["m_model"] } })),
      "Usage:MiniMax-M3",
    );
  });

  it("suffixSpace=true closes the module → fragment gap", () => {
    assert.equal(
      strip(line(["m_modeLabel", "m_template|f"], { suffixSpace: true, lineTemplates: { f: ["m_model"] } })),
      "Usage: MiniMax-M3",
    );
  });
});

describe("suffixSpace=true (symmetrical lookahead)", () => {
  it("module run single-spaced, no leading/trailing space", () => {
    assert.equal(
      strip(line(["m_modeLabel", "m_version", "m_model"], { suffixSpace: true })),
      "Usage: v0.0.0 MiniMax-M3",
    );
  });

  it("no trailing space before s_newline", () => {
    assert.equal(
      strip(line(["m_version", "s_newline", "m_version"], { suffixSpace: true })),
      "v0.0.0\nv0.0.0",
    );
  });

  it("known edge: trailing space when the next module drops", () => {
    assert.equal(strip(line(["m_version", "m_balance"], { suffixSpace: true })), "v0.0.0 ");
  });
});

describe("both toggles on", () => {
  it("R2 suppresses the prefix → single space, not double", () => {
    assert.equal(
      strip(line(["m_version", "m_model"], { prefixSpace: true, suffixSpace: true })),
      "v0.0.0 MiniMax-M3",
    );
  });
});

describe("built-in templates stay byte-identical under the s_space cleanup (prefixSpace=true)", () => {
  // Realistic ctx: the intervals carry a reset time (nowMs = 1_000_000,
  // endAt = 30min-after-epoch, so the countdowns render as e.g. "13m").
  // A resetAt-less interval would make the m_countdown|valueOnly modules
  // (quota_all_compact) DROP, and a dropped module cannot reproduce the
  // removed s_space via auto-prefix — a degenerate render that never
  // happens in production (MiniMax always ships a reset time). Under this
  // realistic ctx every built-in module renders, so the sweep verifies the
  // production path.
  const ctxFor = (providerType: "quota" | "balance" | "unknown") => ({
    mode: "used" as const,
    nowMs: 1_000_000,
    intervals: {
      short: { windowId: "5h", label: "5h", startAt: 400_000, endAt: 1_800_000, intervalMs: 1_400_000, usedPercent: 30, remainingPercent: 70, remainingQuota: null, usedQuota: null, limitQuota: null },
      mid: { windowId: "7d", label: "7d", startAt: 400_000, endAt: 2_200_000, intervalMs: 1_800_000, usedPercent: 50, remainingPercent: 50, remainingQuota: null, usedQuota: null, limitQuota: null },
      long: null,
    },
    balance: null,
    ageMs: null,
    stale: false,
    version: "0.0.0",
    tokens: SNAP,
    contextWindow: { pct: 40 },
    providerType,
    currentProvider: "minimax",
  });

  it("the s_space cleanup is byte-identical — pre-cleanup renders match the cleaned ones under prefixSpace=true", () => {
    // Expand one level of m_template|<key> refs (fragments can't nest).
    const tokensOf = (tpl: readonly string[]): string[] => {
      const out: string[] = [];
      for (const t of tpl) {
        const m = /^m_template\|([^|]+)/.exec(t);
        if (m) {
          const inner = DEFAULT_LINE_TEMPLATES[m[1]!];
          if (inner) out.push(...inner);
        } else {
          out.push(t);
        }
      }
      return out;
    };
    const TTL_GAUGES = ["m_statTtlStatus", "m_sumTtlStatus", "m_cacheTtlStatus"];
    const isFlaky = (tokens: readonly string[]): boolean =>
      tokens.some(
        (t) =>
          t.startsWith("m_quote") ||
          TTL_GAUGES.some((g) => t === g || t.startsWith(`${g}|`)),
      );
    // TTL-gauge modules (m_statTtlStatus / m_sumTtlStatus / m_cacheTtlStatus)
    // read wall-clock Date.now() for their age and must be excluded from
    // the equality sweep — the pre-pass and cleaned-pass can see different
    // ages and flake the byte-identity. m_quote is also excluded
    // conservatively (time-bucketed selection — keep the swept set stable).
    //
    // The cleaned registry must cover exactly the pre-cleanup snapshot's
    // key set — a drifted key means the guard silently stops covering
    // some template.
    assert.deepEqual(
      [...Object.keys(DEFAULT_LINE_TEMPLATES)].sort(),
      [...Object.keys(PRE_CLEANUP_LINE_TEMPLATES)].sort(),
      "DEFAULT_LINE_TEMPLATES keys must match the pre-cleanup snapshot",
    );
    assert.deepEqual(
      [...Object.keys(DEFAULT_STATUSLINE_PRESETS)].sort(),
      [...Object.keys(PRE_CLEANUP_STATUSLINE_PRESETS)].sort(),
      "DEFAULT_STATUSLINE_PRESETS keys must match the pre-cleanup snapshot",
    );

    // ctx selection: a template whose expansion carries a direct
    // balance-only module (m_balance) and NO direct quota-only module
    // (m_windowQuota / m_countdown / m_quota) renders under the BALANCE
    // provider — the only ctx where its modules stay alive. On a quota
    // ctx the m_balance would type-drop, and then the removed s_space
    // (which the drop cannot reproduce via auto-prefix) would legitimately
    // change the render — a degenerate case that never happens in
    // production (the balance body only renders on DeepSeek). Everything
    // else renders under the default quota ctx. `simple` carries both
    // families via type-gated m_template refs, but only one family
    // survives per ctx (the other is dropped wholesale), so quota ctx is
    // correct for it.
    const hasQuotaOnly = (tokens: readonly string[]): boolean =>
      tokens.some((t) => /^m_(windowQuota|countdown|quota)(\||$)/.test(t));
    const hasBalanceOnly = (tokens: readonly string[]): boolean =>
      tokens.some((t) => /^m_balance(\||$)/.test(t));
    const ctxForTpl = (tpl: readonly string[]): ReturnType<typeof ctxFor> => {
      const tokens = tokensOf(tpl);
      return hasBalanceOnly(tokens) && !hasQuotaOnly(tokens)
        ? ctxFor("balance")
        : ctxFor("quota");
    };

    const preByKey = new Map<string, readonly string[]>([
      ...Object.entries(PRE_CLEANUP_LINE_TEMPLATES),
      ...Object.entries(PRE_CLEANUP_STATUSLINE_PRESETS),
    ]);
    const curByKey = new Map<string, readonly string[]>([
      ...Object.entries(DEFAULT_LINE_TEMPLATES),
      ...Object.entries(DEFAULT_STATUSLINE_PRESETS),
    ]);
    // NOTE: preset-level comparisons are by-construction identical — the
    // preset bodies keep their m_template|<key> refs, which renderTemplate
    // resolves to the LIVE (cleaned) fragment registries on both sides.
    // The meaningful guard is the fragment (line-template) level, where
    // every removed s_space lives in a direct token array.
    let swept = 0;
    for (const [key, cur] of curByKey) {
      if (isFlaky(tokensOf(cur))) continue;
      const pre = preByKey.get(key);
      assert.ok(pre, `pre-cleanup snapshot is missing template "${key}"`);
      const ctx = ctxForTpl(cur);
      __resetForTest({ prefixSpace: true, suffixSpace: false });
      const preOut = renderTemplate(pre, ctx);
      __resetForTest({ prefixSpace: true, suffixSpace: false });
      const curOut = renderTemplate(cur, ctx);
      __resetForTest();
      assert.deepEqual(
        curOut,
        preOut,
        `s_space cleanup changed built-in template "${key}": ${JSON.stringify(cur)}`,
      );
      swept++;
    }
    assert.ok(swept >= 15, `sweep should cover most built-ins, got ${swept}`);
  });
});

