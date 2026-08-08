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

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderProviderLine, renderTemplate } from "./render.ts";
import { DEFAULT_LINE_TEMPLATES, DEFAULT_STATUSLINE_PRESETS } from "./config.template.ts";
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

describe("built-in templates stay byte-identical under prefixSpace=true", () => {
  const ctxFor = (providerType: "quota" | "balance" | "unknown") => ({
    mode: "used" as const,
    nowMs: 1_000_000,
    intervals: {
      short: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 30, remainingPercent: 70, remainingQuota: null, usedQuota: null, limitQuota: null },
      mid: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 50, remainingPercent: 50, remainingQuota: null, usedQuota: null, limitQuota: null },
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

  it("renders identically with prefixSpace off vs on (default)", () => {
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
    // the equality sweep — the off-pass and on-pass can see different ages
    // and flake the byte-identity. m_quote is also excluded conservatively
    // (time-bucketed selection — keep the swept set stable).
    const all = [
      ...Object.values(DEFAULT_LINE_TEMPLATES),
      ...Object.values(DEFAULT_STATUSLINE_PRESETS),
    ].filter((tpl) => !isFlaky(tokensOf(tpl)));

    assert.ok(all.length >= 15, `sweep should cover most built-ins, got ${all.length}`);
    for (const tpl of all) {
      __resetForTest({ prefixSpace: false, suffixSpace: false });
      const off = renderTemplate(tpl, ctxFor("quota"));
      __resetForTest({ prefixSpace: true, suffixSpace: false });
      const on = renderTemplate(tpl, ctxFor("quota"));
      __resetForTest();
      assert.deepEqual(
        on,
        off,
        `prefixSpace auto-space changed a built-in template: ${JSON.stringify(tpl)}`,
      );
    }
  });
});

