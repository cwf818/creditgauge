// vX.X.X+ — m_* prefix/suffix auto-space tests. prefixSpace (default
// true) prepends a space before each m_* module (except m_label /
// m_template); suffixSpace (default false) appends before a following
// module; explicit |prefix:| / |suffix:| always overrides.
// The obsolete s_space-cleanup byte-identity sweep is gone; in its
// place is a lightweight preset render guard at the bottom of the file.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { charDisplayWidth, renderProviderLine } from "./render.ts";
import { DEFAULT_STATUSLINE_PRESETS } from "./config.template.ts";
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
    // tickline is a live fragment key; m_template's schema still rejects
    // the suffix arg → badarg → drop regardless of which key is used.
    assert.equal(strip(line(["m_template|tickline|suffix:x"])), "");
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

// vX.X.X+ — lightweight preset render guard. Replaces the obsolete
// s_space-cleanup byte-identity sweep's "templates compose" role:
// render each remaining statusline preset (simple / compact / standard)
// under prefixSpace=true with a deterministic ctx and assert the output
// is non-empty and free of double spaces. None of these presets carry a
// TTL-gauge module, and m_quote is deterministic given a fixed nowMs, so
// the guard is stable.
describe("statusline presets compose cleanly (no double space, prefixSpace=true)", () => {
  // Reuse the module-level `line()` helper's deterministic ctx (fixed
  // nowMs=1_000_000, real usedPercent intervals, SNAP tokens, ageMs,
  // version). The presets reference fragments via `m_template|<key>`,
  // which resolve to the live registry at render time.
  const PRESETS: Record<string, readonly string[]> = {
    simple: DEFAULT_STATUSLINE_PRESETS.simple,
    compact: DEFAULT_STATUSLINE_PRESETS.compact,
    standard: DEFAULT_STATUSLINE_PRESETS.standard,
  };

  for (const [name, tpl] of Object.entries(PRESETS)) {
    it(`${name} preset renders non-empty with no double space`, () => {
      // `s_move`'s column-pad legitimately emits runs of spaces (the
      // `standard` preset pads each scopeline block out to a fixed
      // column before its `|` separator), which would false-positive
      // the double-space check below. s_move's own behavior is covered
      // by the dedicated s_move tests in lineTemplate.test.ts, so strip
      // its tokens here and check the remaining composition.
      const tplNoMove = tpl.filter((t) => !t.startsWith("s_move"));
      const out = line([...tplNoMove], { prefixSpace: true });
      const clean = strip(out);
      assert.ok(
        clean.length > 0,
        `${name} preset should render non-empty, got: ${JSON.stringify(out)}`,
      );
      assert.ok(
        !clean.includes("  "),
        `${name} preset produced a double space: ${JSON.stringify(clean)}`,
      );
    });
  }

  // vX.X.X+ — the standard preset's two scopeline lines (L3 `🗪 : ` +
  // scopeline|session, L4 `📦: ` + scopeline|project) must have their
  // `|` separator at the SAME display column. s_move pads to an
  // absolute column, so width-aware measurement + equal pos values
  // (both 51) is what keeps them aligned. The display column must be
  // computed with charDisplayWidth: the two labels differ in emoji
  // width (🗪=1 vs 📦=2), so the raw JS indexOf differs even when the
  // display columns are equal.
  it("standard preset aligns both scopeline `|` at the same display column", () => {
    const out = line([...DEFAULT_STATUSLINE_PRESETS.standard], { prefixSpace: true });
    const lines = strip(out).split("\n");
    assert.ok(lines.length >= 4, `expected >=5 lines, got ${lines.length}: ${JSON.stringify(out)}`);
    const displayColOfPipe = (ln: string) => {
      const idx = ln.indexOf("|");
      assert.ok(idx > 0, `expected a pipe in line: ${JSON.stringify(ln)}`);
      let w = 0;
      for (const ch of ln.slice(0, idx)) w += charDisplayWidth(ch);
      return w;
    };
    const col3 = displayColOfPipe(lines[2]); // L3 `🗪` scopeline line
    const col4 = displayColOfPipe(lines[3]); // L4 `📦` scopeline line
    assert.equal(
      col4,
      col3,
      `expected aligned pipe (L3 col ${col3}, L4 col ${col4}): ${JSON.stringify(lines)}`,
    );
  });
});

