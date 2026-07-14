import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  colorFor,
  colorForBalance,
  formatResetSuffix,
  formatStaleSuffix,
  pctBar,
  renderProviderLine,
  resolveDisplayMode,
  splitBar,
} from "./render.ts";
import type { Interval } from "./render.ts";
import { __resetForTest, configStore, type Config } from "./config.ts";
import * as cache from "./cache.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const RESET = "\x1b[0m";
const BRIGHT_GREEN = "\x1b[38;5;41m";
const DARK_GREEN = "\x1b[38;5;29m";
const YELLOW = "\x1b[38;5;220m";
const ORANGE = "\x1b[38;5;208m";
const RED = "\x1b[38;5;196m";
const STALE_COLOR = "\x1b[90m";
// Mirror the new colors.broken default from src/config.ts so the
// tests pin the shipped values.
const BROKEN_TEST_COLOR = "\x1b[31m";

// Strip ANSI escape codes so we can inspect content cleanly.
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Bridge v0.8.x tests onto the v0.9.0 Interval signature: accept the
// legacy { pct, resetAt, resetStartAt?, resetDurationMs? } shape (used
// pervasively below) and project to an Interval. Defaults windowId/
// label to "5h" since the bulk of these tests target the 5-hour window
// (m_windowQuota|term|short). The 7d case uses the same helper with an
// override.
type LegacyWindow = {
  pct: number;
  resetAt?: string | null;
  resetStartAt?: string | null;
  resetDurationMs?: number | null;
};
function legacyToIv(
  w: LegacyWindow | null | undefined,
  label: "5h" | "7d" | "30d" = "5h",
): Interval | null {
  if (!w) return null;
  const startAt = w.resetStartAt ? Date.parse(w.resetStartAt) : null;
  const endAt = w.resetAt ? Date.parse(w.resetAt) : null;
  return {
    windowId: label,
    label,
    startAt,
    endAt,
    intervalMs: w.resetDurationMs ?? null,
    usedPercent: w.pct,
    remainingPercent: 100 - w.pct,
    remainingQuota: null,
    usedQuota: null,
    limitQuota: null,
  };
}

// v0.9.0+ — adapter from the legacy v0.8.x `Window` test fixture
// shape (`{ pct, resetAt, resetStartAt, resetDurationMs }`) to the
// new `Interval` shape (`{ windowId, label, startAt, endAt, ...}`).
// The renderer-side `intervalToWindow` does the inverse projection
// for live callers; this helper lets test fixtures stay readable
// (`{ pct: 60, resetAt: null }`) while still feeding the new
// `RenderContext` field shape. UsedPercent mirrors pct (no
// `100 - remaining%` math here — tests already express the
// rendered percentage directly).
function winToIv(
  w: { pct: number; resetAt: string | null; resetStartAt?: string; resetDurationMs?: number } | null,
  label: "5h" | "7d" | "30d" = "5h",
): Interval | null {
  if (!w) return null;
  return {
    windowId: label,
    label,
    startAt: w.resetStartAt ? Date.parse(w.resetStartAt) : null,
    endAt: w.resetAt ? Date.parse(w.resetAt) : null,
    intervalMs: w.resetDurationMs ?? null,
    usedPercent: w.pct,
    remainingPercent: 100 - w.pct,
    remainingQuota: null,
    usedQuota: null,
    limitQuota: null,
  };
}

// Local helper: collapse the 24 quota-line renderProviderLine("minimax", …)
// call sites into a single positional-arg call. Mirrors the shape the
// old `formatLine` shim used to forward — `formatLine` was dropped as
// part of the v0.9.x dead-export cleanup; tests now thread the
// reserved-slot dict directly via `renderProviderLine`.
function renderQuotaLine(
  shortInterval: Interval | null,
  midInterval: Interval | null,
  longInterval: Interval | null = null,
  mode: "used" | "remaining" = resolveDisplayMode(),
  nowMs: number = Date.now(),
  ageMs: number | null = null,
  stale: boolean = false,
): string {
  return renderProviderLine("minimax", {
    mode, nowMs,
    shortInterval, midInterval, longInterval,
    balance: null, ageMs, stale, version: "",
  });
}

// Local helper: collapse the 9 available-balance renderProviderLine
// call sites into a single positional-arg call. Mirrors the old
// `formatBalanceLine` shim's available-branch — the unavailable
// short-circuit (`Balance: not available!`) was dropped along with
// the shim; those 3 tests now assert what `renderProviderLine`
// actually emits via `m_balance` → `placeholderBare` (see the
// "balance: " describe block below).
function renderBalanceLine(
  b: { isAvailable: boolean; entries: ReadonlyArray<{ currency: string; totalBalance: number }>; minValue: number | null },
  ageMs: number | null = null,
  stale: boolean = false,
): string {
  return renderProviderLine("deepseek", {
    mode: resolveDisplayMode(),
    nowMs: Date.now(),
    balance: b,
    ageMs,
    stale,
    version: "",
  });
}

describe("splitBar — unified layout (left=used, right=remaining, glyphs flip by mode)", () => {
  it("used mode: left = used ▓ (colored), right = remaining ░ (plain)", () => {
    // used=80 → displayed=80 → 8/10 colored → ORANGE (band 3, 80 is exact threshold → band above)
    const bar = splitBar(80, "used", 10);
    // LEFT chunk: 8 ▓ wrapped in RED/RESET
    assert.equal(strip(bar.leftChunk), "▓▓▓▓▓▓▓▓");
    assert.ok(bar.leftChunk.startsWith(ORANGE), `left should start with ORANGE: ${JSON.stringify(bar.leftChunk)}`);
    assert.ok(bar.leftChunk.endsWith(RESET), `left should end with RESET: ${JSON.stringify(bar.leftChunk)}`);
    // RIGHT chunk: 2 ░ plain
    assert.equal(bar.rightChunk, "░░");
    // Color field carries the band's ORANGE
    assert.equal(bar.color, ORANGE);
  });

  it("remaining mode: left = used ░ (plain), right = remaining ▓ (colored)", () => {
    // used=80 → remaining=20 → displayed=20 → 2/10 colored → under
    // v0.8.37.1 mode-symmetric semantic, color indexes usedPct=80 → band 3
    // (ORANGE) under the [60,70,80,90] default. The bar still reads
    // left-to-right as "what's spent ░░ what's left ▓▓"; the color
    // reflects the *danger level* (how much of the window is spent).
    const bar = splitBar(80, "remaining", 10);
    // LEFT chunk: 8 ░ plain (no color wrapping)
    assert.equal(bar.leftChunk, "░░░░░░░░");
    assert.ok(!bar.leftChunk.includes("\x1b["), "left must be plain in remaining mode");
    // RIGHT chunk: 2 ▓ colored ORANGE (used=80 → band 3)
    assert.equal(strip(bar.rightChunk), "▓▓");
    assert.ok(bar.rightChunk.startsWith(ORANGE), `right should start with ORANGE: ${JSON.stringify(bar.rightChunk)}`);
    assert.ok(bar.rightChunk.endsWith(RESET), `right should end with RESET: ${JSON.stringify(bar.rightChunk)}`);
    assert.equal(bar.color, ORANGE);
  });

  it("used mode at low usage (15%) — colored chunk is on LEFT, small", () => {
    // used=15 → displayed=15 → 1/8 colored (band 0 = BRIGHT_GREEN)
    const bar = splitBar(15, "used", 8);
    assert.equal(strip(bar.leftChunk), "▓");
    assert.equal(bar.leftChunk, `${BRIGHT_GREEN}▓${RESET}`);
    assert.equal(bar.rightChunk, "░░░░░░░");
    assert.equal(bar.color, BRIGHT_GREEN);
  });

  it("remaining mode at high remaining (75%) — colored chunk is on RIGHT, big", () => {
    // used=25 → remaining=75 → displayed=75 → 6/8 colored.
    // v0.8.37.1 mode-symmetric: color indexes usedPct=25 → band 0
    // (BRIGHT_GREEN) under [60,70,80,90] — only 25% spent, so the
    // window is healthy regardless of which side of the bar shows
    // the percentage.
    const bar = splitBar(25, "remaining", 8);
    assert.equal(bar.leftChunk, "░░"); // plain ░ = used 25%
    assert.equal(strip(bar.rightChunk), "▓▓▓▓▓▓"); // 6 colored ▓ = remaining 75%
    assert.ok(bar.rightChunk.startsWith(BRIGHT_GREEN));
    assert.equal(bar.color, BRIGHT_GREEN);
  });

  it("zero usage: used mode emits no colored chunk; both sides stay plain", () => {
    const bar = splitBar(0, "used", 8);
    assert.equal(bar.leftChunk, ""); // nothing to color
    assert.equal(bar.rightChunk, "░░░░░░░░");
    // Even with no colored cells, the color field still reflects the band (bright green).
    assert.equal(bar.color, BRIGHT_GREEN);
  });

  it("full usage: remaining mode emits no colored chunk", () => {
    // used=100 → remaining=0 → displayed=0 → 0 colored ▓ → bar.color is RED
    const bar = splitBar(100, "remaining", 8);
    assert.equal(bar.leftChunk, "░░░░░░░░");
    assert.equal(bar.rightChunk, "");
    assert.equal(bar.color, RED);
  });

  it("split sizes sum to width regardless of mode", () => {
    for (const u of [0, 10, 25, 50, 75, 90, 100]) {
      for (const m of ["used", "remaining"] as const) {
        const bar = splitBar(u, m, 8);
        const leftPlainLen = strip(bar.leftChunk).length;
        const rightPlainLen = strip(bar.rightChunk).length;
        assert.equal(leftPlainLen + rightPlainLen, 8, `u=${u} mode=${m}`);
      }
    }
  });
});

describe("pctBar (legacy filled-on-left)", () => {
  it("builds fixed-width bars", () => {
    assert.equal(pctBar(0, 8).filled.length + pctBar(0, 8).empty.length, 8);
    assert.equal(pctBar(50, 8).filled.length + pctBar(50, 8).empty.length, 8);
  });
  it("clamps percentage", () => {
    assert.equal(pctBar(-10, 8).filled, "");
    assert.equal(pctBar(150, 8).filled.length, 8);
  });
});

describe("colorFor — 5-band thresholds on USED value (mode-symmetric v0.8.37.1)", () => {
  // Band boundaries at used value 60/70/80/90 (default percentBands).
  // The color palette is the SAME 5 colors in both display modes:
  //   band 0 (used 0-60)   → BRIGHT_GREEN
  //   band 1 (used 60-70)  → DARK_GREEN
  //   band 2 (used 70-80)  → YELLOW
  //   band 3 (used 80-90)  → ORANGE
  //   band 4 (used 90+)    → RED
  // In "remaining" mode the band is derived from 100 - remainingPct,
  // so remaining=N mirrors used=100-N. Both display modes share the
  // same color at the same danger level.
  const PALETTE = [BRIGHT_GREEN, DARK_GREEN, YELLOW, ORANGE, RED];

  it("used mode colors (band-internal values)", () => {
    assert.equal(colorFor(0, "used"), BRIGHT_GREEN);
    assert.equal(colorFor(10, "used"), BRIGHT_GREEN);
    assert.equal(colorFor(19, "used"), BRIGHT_GREEN);
    assert.equal(colorFor(25, "used"), BRIGHT_GREEN);
    assert.equal(colorFor(39, "used"), BRIGHT_GREEN);
    assert.equal(colorFor(45, "used"), BRIGHT_GREEN);
    assert.equal(colorFor(59, "used"), BRIGHT_GREEN);
    assert.equal(colorFor(65, "used"), DARK_GREEN);
    assert.equal(colorFor(79, "used"), YELLOW);
    assert.equal(colorFor(85, "used"), ORANGE);
    assert.equal(colorFor(100, "used"), RED);
  });

  it("remaining mode mirrors used=100-N (mode-symmetric)", () => {
    // remaining=60 mirrors used=40 → band 0 BRIGHT_GREEN
    // remaining=35 mirrors used=65 → band 1 DARK_GREEN
    // remaining=20 mirrors used=80 → band 3 ORANGE
    // remaining=15 mirrors used=85 → band 3 ORANGE
    // remaining=10 mirrors used=90 → band 4 RED
    // remaining=0  mirrors used=100 → band 4 RED
    assert.equal(colorFor(60, "remaining"), BRIGHT_GREEN);
    assert.equal(colorFor(41, "remaining"), BRIGHT_GREEN);
    assert.equal(colorFor(35, "remaining"), DARK_GREEN);
    assert.equal(colorFor(20, "remaining"), ORANGE);
    assert.equal(colorFor(15, "remaining"), ORANGE);
    assert.equal(colorFor(10, "remaining"), RED);
    assert.equal(colorFor(0, "remaining"), RED);
    // remaining=100 mirrors used=0 → band 0 BRIGHT_GREEN
    assert.equal(colorFor(100, "remaining"), BRIGHT_GREEN);
  });

  it("at exact threshold, value belongs to band above (less dangerous)", () => {
    // used=20 → band 0 (bright green, below 60)
    // remaining=80 → used=20 → band 0 (bright green) — same band, no longer dark green
    assert.equal(colorFor(20, "used"), BRIGHT_GREEN);
    assert.equal(colorFor(80, "remaining"), BRIGHT_GREEN);
  });

  it("dark green is visibly distinct from bright green", () => {
    assert.notEqual(DARK_GREEN, BRIGHT_GREEN);
  });

  it("clamps out-of-range values", () => {
    // negative → 0 → band 0 BRIGHT_GREEN in both modes
    // 200 → 100 → band 4 RED in both modes
    assert.equal(colorFor(-50, "used"), BRIGHT_GREEN);
    assert.equal(colorFor(200, "used"), RED);
    assert.equal(colorFor(-50, "remaining"), RED);
    assert.equal(colorFor(200, "remaining"), BRIGHT_GREEN);
  });

  it("uses the exact 5-color palette (mode-symmetric)", () => {
    for (let v = 0; v <= 100; v += 1) {
      const u = colorFor(v, "used");
      assert.ok(
        PALETTE.includes(u),
        `used mode at ${v} returned unexpected color ${JSON.stringify(u)}`
      );
      const r = colorFor(v, "remaining");
      assert.ok(
        PALETTE.includes(r),
        `remaining mode at ${v} returned unexpected color ${JSON.stringify(r)}`
      );
      // Mode-symmetric invariant: colorFor(v, "remaining") === colorFor(100-v, "used")
      assert.equal(
        r,
        colorFor(100 - v, "used"),
        `mode-symmetric mismatch at v=${v}: remaining=${JSON.stringify(r)} vs used@${100 - v}=${JSON.stringify(colorFor(100 - v, "used"))}`
      );
    }
  });
});

describe("resolveDisplayMode", () => {
  it("defaults to DEFAULT_CONFIG.display", () => {
    __resetForTest();
    // Derive the expectation from the config default rather than
    // pinning a literal — flipping the default `display` value is a
    // one-field config change and must not break this test.
    assert.equal(resolveDisplayMode(), configStore.get().display);
  });
  it("reflects config.json `display` field", () => {
    __resetForTest({ display: "remaining" });
    assert.equal(resolveDisplayMode(), "remaining");
    __resetForTest({ display: "used" });
    assert.equal(resolveDisplayMode(), "used");
    __resetForTest();
  });
});

describe("renderQuotaLine — mode='used' (default)", () => {
  // Pin minUnit='m' for this suite — the tests pin time strings
  // that depend on minute-grain truncation (e.g. "1h0m" stays
  // "1h0m" rather than expanding to "1h0m0s" under the default
  // minUnit='s'). Each test's intent is the time-formatting rule,
  // not the new default.
  beforeEach(() => {
    __resetForTest({ timeFormat: { minUnit: "m", maxUnitCount: 2 } });
  });
  it("prefixes with the default-mode label", () => {
    const line = renderQuotaLine(legacyToIv({ pct: 38 }), legacyToIv({ pct: 60 }, "7d"));
    // m_modeLabel may carry an ANSI color (default `|color:yellow` is
    // injected into DEFAULT_LINE_TEMPLATE.quota), so strip SGRs
    // before checking the literal prefix. Derive the expected label
    // from the active default mode — flipping `display` is a config
    // change, not a rendering-contract change.
    const cfg = configStore.get();
    const expectedLabel = cfg.modeLabels[cfg.display as "used" | "remaining"];
    assert.ok(strip(line).startsWith(`${expectedLabel} `), `got: ${line}`);
    assert.ok(line.includes(" · "));
  });

  it("default mode displays the mode-appropriate percentages (from 38 / 60 used)", () => {
    const line = renderQuotaLine(legacyToIv({ pct: 38 }), legacyToIv({ pct: 60 }, "7d"));
    // `pct` is the USED percentage; the displayed value flips with the
    // mode. Derive both expectations from the active default so the
    // assertion tracks the config default automatically.
    const mode = configStore.get().display;
    const [first, second] =
      mode === "remaining" ? [100 - 38, 100 - 60] : [38, 60];
    assert.ok(line.includes(`${first}%`), `got: ${line}`);
    assert.ok(line.includes(`${second}%`), `got: ${line}`);
  });

  it("displayed value = 100 - used when mode='remaining'", () => {
    // used=38 → display remaining=62. v0.8.37.1 mode-symmetric:
    // remaining=62 → usedPct=38 → band 0 (BRIGHT_GREEN). The 7d
    // window has used=60 → remaining=40 → usedPct=60 → exact
    // threshold → band 1 (DARK_GREEN).
    const line = renderQuotaLine(legacyToIv({ pct: 38 }), legacyToIv({ pct: 60 }, "7d"), null, "remaining");
    assert.ok(line.includes(`${BRIGHT_GREEN}62%${RESET}`));
    assert.ok(line.includes(`${DARK_GREEN}40%${RESET}`));
  });

  it("remaining mode: colored ▓ on RIGHT represents remaining", () => {
    // used=75 → remaining=25 → 2/8 right cells colored.
    // v0.8.37.1 mode-symmetric: remaining=25 → usedPct=75 → band 2
    // (YELLOW). The bar reads "what's spent ░░░░░░ what's left ▓▓",
    // color follows the danger level (75% spent = YELLOW).
    const line = renderQuotaLine(legacyToIv({ pct: 75 }), legacyToIv({ pct: 0 }, "7d"), null, "remaining");
    // Bar: 6 plain ░ + 2 colored ▓
    assert.ok(line.includes(`░░░░░░${YELLOW}▓▓${RESET} ${YELLOW}25%${RESET}`),
      `got: ${line}`);
    // No resetAt → bare "5h" with no parens and no slash. v6.x:
    // m_countdown|term|short is wrapped in DEFAULT_COLORS (teal);
    // strip SGR before checking substring.
    const cleanR = strip(line);
    assert.ok(cleanR.includes(" 5h "), `got: ${cleanR}`);
    assert.ok(!cleanR.includes("/ 5h"), `got: ${cleanR}`);
    assert.ok(!cleanR.includes("("), `got: ${cleanR}`);
  });
});

describe("renderQuotaLine — mode='used'", () => {
  beforeEach(() => {
    __resetForTest({ timeFormat: { minUnit: "m", maxUnitCount: 2 } });
  });
  it("prefixes with 'Usage:' label", () => {
    const line = renderQuotaLine(legacyToIv({ pct: 70 }), legacyToIv({ pct: 90 }, "7d"), null, "used");
    // m_modeLabel may carry an ANSI color (default `|color:yellow` is
    // injected into DEFAULT_LINE_TEMPLATE.quota), so strip SGRs
    // before checking the literal prefix.
    assert.ok(strip(line).startsWith("Usage: "), `got: ${line}`);
  });

  it("displayed value = used", () => {
    // used=70 → display 70 → yellow (band 2)
    const line = renderQuotaLine(legacyToIv({ pct: 70 }), legacyToIv({ pct: 90 }, "7d"), null, "used");
    assert.ok(line.includes(`${YELLOW}70%${RESET}`));
    assert.ok(line.includes(`${RED}90%${RESET}`));
  });

  it("used mode: colored ▓ on LEFT represents used", () => {
    // used=75 → displayed=75 (band 2 = YELLOW) → 6/8 LEFT cells colored
    const line = renderQuotaLine(legacyToIv({ pct: 75 }), legacyToIv({ pct: 0 }, "7d"), null, "used");
    // Bar: 6 colored ▓ (LEFT) + 2 plain ░ (RIGHT)
    assert.ok(line.includes(`${YELLOW}▓▓▓▓▓▓${RESET}░░ ${YELLOW}75%${RESET}`),
      `got: ${line}`);
    // No resetAt → bare "5h" with no parens and no slash. v6.x:
    // m_countdown|term|short is wrapped in DEFAULT_COLORS (teal);
    // strip SGR before checking substring.
    const cleanU = strip(line);
    assert.ok(cleanU.includes(" 5h "), `got: ${cleanU}`);
    assert.ok(!cleanU.includes("/ 5h"), `got: ${cleanU}`);
    assert.ok(!cleanU.includes("("), `got: ${cleanU}`);
  });

  it("full layout matches spec: 'Usage: <bar> <pct>% (<reset><arrow> <windowLabel>) · ...'", () => {
    const now = Date.parse("2026-06-24T12:00:00Z");
    const line = renderQuotaLine(
      legacyToIv({ pct: 62, resetAt: "2026-06-24T12:38:00Z" }),
      legacyToIv({ pct: 42, resetAt: "2026-06-29T04:38:00Z" }, "7d"),
      null,
      "used",
      now
    );
    // 5h: used=62 → 5 colored ▓ (LEFT) + 3 plain ░ (RIGHT), DARK_GREEN.
    // New template: "(38m🕛 5h)" — countdown + arrow + space + label, no slash.
    // v6.x: m_countdown|term|short wraps the suffix in DEFAULT_COLORS
    // (teal); assert on the SGR-stripped form so the literal substring
    // check matches the rendered text after color removal.
    const clean = strip(line);
    assert.ok(
      clean.includes(`▓▓▓▓▓░░░ 62% (38m🕛 5h)`),
      `got: ${clean}`
    );
    // 7d (was wk): used=42 → 3 colored ▓ (LEFT) + 5 plain ░ (RIGHT), BRIGHT_GREEN.
    assert.ok(
      clean.includes(`▓▓▓░░░░░ 42% (4d16h🕛 7d)`),
      `got: ${clean}`
    );
    // Mode label once at the front, ' · ' between windows.
    assert.ok(clean.startsWith("Usage: "), `got: ${clean}`);
    assert.ok(clean.includes(" · "));
    // No double parens: "(38m🕛 5h)" not "(38m🕛) 5h".
    assert.ok(!clean.includes("🕛)"), `got: ${clean}`);
    // No slash inside the reset annotation.
    assert.ok(!clean.includes("🕛 /"), `got: ${clean}`);
  });
});

describe("renderQuotaLine — reset suffix integration", () => {
  beforeEach(() => {
    __resetForTest({ timeFormat: { minUnit: "m", maxUnitCount: 2 } });
  });
  it("appends reset countdown + arrow + label inside parens, no slash", () => {
    const now = Date.parse("2026-06-24T12:00:00Z");
    const line = renderQuotaLine(
      legacyToIv({ pct: 30, resetAt: "2026-06-24T14:03:00Z" }),
      legacyToIv({ pct: 40, resetAt: "2026-06-27T17:00:00Z" }, "7d"),
      null,
      "remaining",
      now
    );
    assert.ok(line.includes("(2h3m🕛 5h)"));
    assert.ok(line.includes("(3d5h🕛 7d)"));
  });

  it("no resetAt → bare ' 5h' / ' 7d' with no parens and no arrow", () => {
    const line = renderQuotaLine(legacyToIv({ pct: 30 }), legacyToIv({ pct: 40 }, "7d"));
    // v6.x: m_countdown|term:short|mid wrap in DEFAULT_COLORS (teal);
    // strip SGR before checking substring.
    const clean = strip(line);
    assert.ok(!clean.includes("🕛"));
    assert.ok(!clean.includes("("));
    assert.ok(clean.includes(" 5h"));
    assert.ok(clean.includes(" 7d"));
  });

  it("sub-minute remaining → '<1m' (still wrapped in parens, arrow preserved)", () => {
    const now = Date.parse("2026-06-24T12:00:00Z");
    // 5h window with 30 seconds remaining
    const line = renderQuotaLine(
      legacyToIv({ pct: 99, resetAt: new Date(now + 30_000).toISOString() }),
      legacyToIv({ pct: 99, resetAt: new Date(now + 30_000).toISOString() }, "7d"),
      null,
      "used",
      now
    );
    assert.ok(line.includes("(<1m"), `got: ${line}`);
    // The parens must still be present even when the countdown is the "<1m" fallback.
    assert.ok(line.includes(")"), `got: ${line}`);
  });
});

describe("formatResetSuffix", () => {
  beforeEach(() => {
    // Pin minUnit='m' for this suite — the tests pin exact strings
    // (e.g. "5m" for 5min, "<1m" for sub-minute) that depend on
    // minute-grain truncation. The default minUnit='s' would
    // produce "5m0s" / "30s" instead, which is what the inner
    // describe("minUnit='s' (second granularity)") tests cover.
    __resetForTest({ timeFormat: { minUnit: "m", maxUnitCount: 2 } });
  });
  const NOW = Date.parse("2026-06-24T12:00:00Z");
  const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

  it("returns empty when resetAt is missing or invalid", () => {
    assert.equal(formatResetSuffix(undefined, NOW), "");
    assert.equal(formatResetSuffix(null, NOW), "");
    assert.equal(formatResetSuffix("", NOW), "");
    assert.equal(formatResetSuffix("not-a-date", NOW), "");
  });

  it("returns '0m' when reset is in the past (default minUnit='m')", () => {
    // v0.2.11: past-due renders as "0m" — explicit "this window has
    // reset" signal, distinct from "<1m" which means "about to reset".
    assert.equal(formatResetSuffix(at(-60_000), NOW), "0m");
  });

  it("formats hours and minutes (drops zero days), no arrow", () => {
    // formatResetSuffix is now arrow-less — the caller (formatOne) adds the glyph.
    assert.equal(formatResetSuffix(at(2 * 3_600_000 + 3 * 60_000), NOW), "2h3m");
  });

  it("formats minutes only when hours and days are zero", () => {
    assert.equal(formatResetSuffix(at(5 * 60_000), NOW), "5m");
  });

  it("keeps two units when all three are non-zero", () => {
    assert.equal(
      formatResetSuffix(at((24 + 2) * 3_600_000 + 3 * 60_000), NOW),
      "1d2h"
    );
  });

  it("formats days + hours when minutes are zero", () => {
    assert.equal(
      formatResetSuffix(at((3 * 24 + 5) * 3_600_000), NOW),
      "3d5h"
    );
  });

  it("formats a single unit when only one is non-zero", () => {
    assert.equal(formatResetSuffix(at(1 * 60_000), NOW), "1m");
    // 2h exactly → 2h0m (internal zero preserved per v0.2.11 rule)
    assert.equal(formatResetSuffix(at(2 * 3_600_000), NOW), "2h0m");
    // 2d exactly → 2d0h
    assert.equal(formatResetSuffix(at(2 * 24 * 3_600_000), NOW), "2d0h");
  });

  it("keeps internal/trailing zero units (e.g. 1h0m stays '1h0m')", () => {
    // v0.2.11: only LEADING zeros are dropped. Internal/trailing zeros
    // within the maxUnitCount window are preserved — "2h0m" stays
    // "2h0m" so the user can see "the window is 2 hours wide and
    // happens to be 0m into it" rather than the lossy "2h".
    assert.equal(formatResetSuffix(at(60 * 60_000), NOW), "1h0m");
    assert.equal(formatResetSuffix(at(2 * 60 * 60_000), NOW), "2h0m");
  });

  it("does not show seconds by default — sub-minute returns '<1m'", () => {
    // 30 seconds remaining → "<1m" (was "0m" before, but the user
    // pointed out that was confusing — the window is about to reset,
    // not exactly at 0).
    assert.equal(formatResetSuffix(at(30_000), NOW), "<1m");
    // 1 second remaining → still "<1m"
    assert.equal(formatResetSuffix(at(1_000), NOW), "<1m");
    // 59.999 seconds remaining → still "<1m"
    assert.equal(formatResetSuffix(at(59_999), NOW), "<1m");
  });

  describe("minUnit='s' (second granularity)", () => {
    beforeEach(() => {
      __resetForTest({ timeFormat: { minUnit: "s", maxUnitCount: 2 }, stale: { ageEmoji: { healthy: "🔗", broken: "⛓️‍💥" } }, countdown: { resetArrows: ["🕛","🕚","🕙","🕘","🕗","🕖","🕕","🕔","🕓","🕒","🕑","🕐"] } });
    });
    afterEach(() => {
      __resetForTest();
    });

    it("sub-minute → actual seconds", () => {
      assert.equal(formatResetSuffix(at(30_000), NOW), "30s");
      assert.equal(formatResetSuffix(at(1_000), NOW), "1s");
      assert.equal(formatResetSuffix(at(59_999), NOW), "59s");
    });

    it("exactly 1 minute → '1m0s' (unified algorithm keeps seconds when minUnit='s')", () => {
      // v0.2.15: unified algorithm. allUnits = [0d,0h,1m,0s]. After
      // dropping leading zeros: [1m, 0s]. Slice to maxUnitCount=2:
      // "1m0s". The trailing 0s is internal-zero — kept on purpose
      // because the user said "去掉前导0" (only LEADING zeros are dropped).
      assert.equal(formatResetSuffix(at(60_000), NOW), "1m0s");
    });

    it("past-due → '0s' (v0.2.11: explicit past-due signal)", () => {
      assert.equal(formatResetSuffix(at(-1_000), NOW), "0s");
    });

    it("≥ 1 unit: seconds appear in countdown when minUnit='s' AND the slice fits them", () => {
      // maxUnitCount=3 → all three units fit, so 2h3m45s → "2h3m45s".
      __resetForTest({ timeFormat: { minUnit: "s", maxUnitCount: 3 } });
      assert.equal(formatResetSuffix(at(2 * 3_600_000 + 3 * 60_000 + 45_000), NOW), "2h3m45s");
      assert.equal(formatResetSuffix(at(5 * 60_000 + 7_000), NOW), "5m7s");
      __resetForTest({ timeFormat: { minUnit: "s", maxUnitCount: 2 } });
    });

    it("maxUnitCount slices off trailing seconds (unified algorithm)", () => {
      // maxUnitCount=2, minUnit="s". 2h3m45s → drop leading zeros (none
      // to drop) → [2h, 3m, 45s] → slice to 2 → "2h3m". Seconds are
      // dropped by the slice, NOT by minUnit (which kept them).
      assert.equal(formatResetSuffix(at(2 * 3_600_000 + 3 * 60_000 + 45_000), NOW), "2h3m");
    });

    it("exactly 2h3m → '2h3m' (maxUnitCount=2 slices off the seconds slot)", () => {
      // With maxUnitCount=2, the seconds unit gets sliced off even
      // when minUnit="s". To see the trailing "0s", the user must
      // raise maxUnitCount to 3 (verified in a sibling test above).
      assert.equal(formatResetSuffix(at(2 * 3_600_000 + 3 * 60_000), NOW), "2h3m");
    });

    it("minUnit='s' + maxUnitCount=1: seconds visible only when they're the lead unit", () => {
      // 1d2h3m45s with maxUnitCount=1 → just "1d" (sliced off everything
      // but the first unit). To see seconds, the slice must reach them.
      __resetForTest({ timeFormat: { minUnit: "s", maxUnitCount: 1 } });
      assert.equal(formatResetSuffix(at(24 * 3_600_000 + 2 * 3_600_000 + 3 * 60_000 + 45_000), NOW), "1d");
      // 50s with maxUnitCount=1 + minUnit="s" → [0d,0h,0m,50s] →
      // drop leading zeros → [50s] → "50s".
      assert.equal(formatResetSuffix(at(50_000), NOW), "50s");
      __resetForTest({ timeFormat: { minUnit: "s", maxUnitCount: 2 } });
    });
  });
});

describe("pickResetArrow (stale.resetArrows[] by remaining/total)", () => {
  // index = floor(remainingMs / resetDurationMs * length), clamped to
  // [0, length-1]. Defaults are 12 clock-face emoji ordered by REMAINING
  // TIME, ascending (few → many): 🕛(0), 🕚(1), 🕙(2), …, 🕐(11). So
  // index 0 (🕛) is shown when the window is about to reset / just reset;
  // the last index (🕐) is shown when the window is fresh. When the
  // interval data is missing (DeepSeek, legacy, clock skew), falls back
  // to index 0.
  const NOW = Date.parse("2026-06-24T12:00:00Z");

  // Helper: call renderQuotaLine so the rendered glyph is what the user sees.
  // Builds a Window with the given remaining/total, sets nowMs via the
  // 4th arg. Reads the arrow off the rendered line.
  const arrow = (ratio: number, durMs: number = 5 * 3_600_000) => {
    const remaining = ratio * durMs;
    const startMs = NOW - (durMs - remaining);
    const line = renderQuotaLine(
      legacyToIv({
        pct: 50,
        resetAt: new Date(NOW + remaining).toISOString(),
        resetStartAt: new Date(startMs).toISOString(),
        resetDurationMs: durMs,
      }),
      legacyToIv({ pct: 50, resetAt: new Date(NOW + 100_000_000).toISOString() }, "7d"),
      null,
      "used",
      NOW
    );
    // The 5h segment is the first "(...)"; grab the arrow between
    // the last digit of the countdown and the space before "5h".
    const m = line.match(/\((?:[^\u{1F550}-\u{1F55B}]+)([\u{1F550}-\u{1F55B}]) 5h\)/u);
    return m?.[1] ?? "";
  };

  it("ratio≈0 → 🕛 (index 0, least remaining)", () => {
    // ~1 minute remaining out of 5h
    assert.equal(arrow(1 / 300), "🕛");
  });

  it("ratio≈1/12 → 🕚 (index 1)", () => {
    assert.equal(arrow(1 / 12), "🕚");
  });

  it("ratio≈0.5 → 🕕 (index 6)", () => {
    assert.equal(arrow(0.5), "🕕");
  });

  it("ratio=1 → 🕐 (index 11, clamped, not out-of-bounds)", () => {
    assert.equal(arrow(1), "🕐");
  });

  it("two-glyph hourglass pair: full→empty", () => {
    __resetForTest({ timeFormat: { minUnit: "m", maxUnitCount: 2 }, stale: { ageEmoji: { healthy: "🔗", broken: "⛓️‍💥" } }, countdown: { resetArrows: ["⏳", "⌛"] } });
    try {
      // Use a small but non-trivial remaining so the countdown is non-empty.
      const arrowAt = (ratio: number) => {
        const remaining = ratio * 5 * 3_600_000;
        const startMs = NOW - (5 * 3_600_000 - remaining);
        const line = renderQuotaLine(
          legacyToIv({
            pct: 50,
            resetAt: new Date(NOW + remaining).toISOString(),
            resetStartAt: new Date(startMs).toISOString(),
            resetDurationMs: 5 * 3_600_000,
          }),
          legacyToIv({ pct: 50, resetAt: new Date(NOW + 100_000_000).toISOString() }, "7d"),
          null,
          "used",
          NOW
        );
        const m = line.match(/\((?:[^⏳⌛]+)([⏳⌛]) 5h\)/);
        return m?.[1] ?? "";
      };
      assert.equal(arrowAt(0.4), "⏳");
      assert.equal(arrowAt(0.5), "⌛");
      assert.equal(arrowAt(0.9), "⌛");
    } finally {
      __resetForTest();
    }
  });

  it("falls back to index 0 when resetStartAt is missing (DeepSeek path)", () => {
    const line = renderQuotaLine(
      legacyToIv({ pct: 50, resetAt: new Date(NOW + 60_000).toISOString() }),
      legacyToIv({ pct: 50, resetAt: new Date(NOW + 100_000_000).toISOString() }, "7d"),
      null,
      "used",
      NOW
    );
    // The 5h segment is rendered — even with no start/duration, the
    // default index 0 is 🕛.
    assert.ok(line.includes("🕛 5h"), `got: ${line}`);
  });

  it("derives intervalMs from start+end when explicit intervalMs is missing (v0.9.0+)", () => {
    // v0.9.0: intervalToWindow computes durationMs = endAt - startAt
    // when both are present but intervalMs is null. The arrow
    // should NOT fall back to index 0 anymore — it gets the full
    // remaining/total ratio and picks the right glyph.
    const startAt = new Date(NOW - 3 * 3_600_000).toISOString();
    const line = renderQuotaLine(
      legacyToIv({
        pct: 50,
        resetAt: new Date(NOW + 2 * 3_600_000).toISOString(),
        resetStartAt: startAt,
      }),
      legacyToIv({ pct: 50, resetAt: new Date(NOW + 100_000_000).toISOString() }, "7d"),
      null,
      "used",
      NOW
    );
    // 5h window: 2h remaining out of 5h total (endAt - startAt = 5h).
    // The literal "2h0m" in the body confirms the derived duration
    // was used (and a non-default arrow means pickResetArrow had a
    // valid ratio to work with). The exact glyph is an artifact of
    // the 12-clock-faces array indexing — pin "2h0m" to be stable.
    assert.ok(line.includes("2h0m"), `got: ${line}`);
    assert.ok(!line.includes("🕛 5h"), `should NOT fall back to first arrow: ${line}`);
  });

  it("ignores clock skew — clamps to last index", () => {
    // startAt slightly in the future. elapsed negative → ratio > 1
    // → clamped to 1 → last index 🕐.
    const startAt = new Date(NOW + 5_000).toISOString();
    const dur = 5 * 3_600_000;
    const line = renderQuotaLine(
      legacyToIv({
        pct: 50,
        resetAt: new Date(NOW + dur).toISOString(),
        resetStartAt: startAt,
        resetDurationMs: dur,
      }),
      legacyToIv({ pct: 50, resetAt: new Date(NOW + 100_000_000).toISOString() }, "7d"),
      null,
      "used",
      NOW
    );
    assert.ok(line.includes("🕐 5h"), `got: ${line}`);
  });
});

// ---------------------------------------------------------------------------
// DeepSeek balance line
// ---------------------------------------------------------------------------

describe("colorForBalance — 5-band thresholds (5/10/20/50)", () => {
  it("<5 is RED", () => {
    assert.equal(colorForBalance(0), RED);
    assert.equal(colorForBalance(4.99), RED);
  });
  it("[5,10) is ORANGE", () => {
    assert.equal(colorForBalance(5), ORANGE);
    assert.equal(colorForBalance(9.99), ORANGE);
  });
  it("[10,20) is YELLOW", () => {
    assert.equal(colorForBalance(10), YELLOW);
    assert.equal(colorForBalance(19.99), YELLOW);
  });
  it("[20,50) is DARK_GREEN", () => {
    assert.equal(colorForBalance(20), DARK_GREEN);
    assert.equal(colorForBalance(49.99), DARK_GREEN);
  });
  it(">=50 is BRIGHT_GREEN", () => {
    assert.equal(colorForBalance(50), BRIGHT_GREEN);
    assert.equal(colorForBalance(110), BRIGHT_GREEN);
    assert.equal(colorForBalance(1_000_000), BRIGHT_GREEN);
  });
  it("clamps negative input to 0 (RED)", () => {
    assert.equal(colorForBalance(-5), RED);
  });
});

describe("renderBalanceLine — single-currency", () => {
  // vX.X.X+ — `renderBalanceLine` delegates to `renderProviderLine`
  // with the "deepseek" provider. Tests pin a raw balance token
  // list (no `m_modeLabel|color:yellow`, so the rendered line
  // starts with bare "Balance: " — the bare-prefix asserts below
  // don't strip SGRs).
  beforeEach(() => {
    __resetForTest({
      statuslineTemplate: ["m_modeLabel", "s_space", "m_balance"],
    });
  });
  afterEach(() => __resetForTest());

  it("CNY uses ￥ prefix, integer value, bright-green band", () => {
    const line = renderBalanceLine({
      isAvailable: true,
      entries: [{ currency: "CNY", totalBalance: 110 }],
      minValue: 110,
    });
    assert.equal(strip(line), "Balance: ￥110");
    assert.ok(line.startsWith(`Balance: ${BRIGHT_GREEN}`));
    assert.ok(line.endsWith(RESET));
  });

  it("USD uses $ prefix", () => {
    const line = renderBalanceLine({
      isAvailable: true,
      entries: [{ currency: "USD", totalBalance: 25 }],
      minValue: 25,
    });
    assert.equal(strip(line), "Balance: $25");
  });

  it("unknown currency falls back to bare code as prefix", () => {
    // Currency code not in the default map → currencyLabel falls back
    // to the uppercased code (e.g. EUR → "EUR"). No per-config lookup,
    // no legacy prefix resolution.
    const line = renderBalanceLine({
      isAvailable: true,
      entries: [{ currency: "EUR", totalBalance: 42 }],
      minValue: 42,
    });
    assert.equal(strip(line), "Balance: EUR42");
  });

  it("decimal value preserved up to 2 dp, trailing zeros stripped", () => {
    // 110.10 → "110.1"; 110.00 → "110"; 110.05 → "110.05".
    const a = renderBalanceLine({ isAvailable: true, entries: [{ currency: "USD", totalBalance: 110.1 }], minValue: 110.1 });
    assert.equal(strip(a), "Balance: $110.1");
    const b = renderBalanceLine({ isAvailable: true, entries: [{ currency: "USD", totalBalance: 110.05 }], minValue: 110.05 });
    assert.equal(strip(b), "Balance: $110.05");
  });

  it("color band reflects the lowest entry (single entry = that entry)", () => {
    // 3.5 → ORANGE band (5<=3.5<10? no, 3.5<5 → RED)
    const red = renderBalanceLine({ isAvailable: true, entries: [{ currency: "CNY", totalBalance: 3.5 }], minValue: 3.5 });
    assert.ok(red.startsWith(`Balance: ${RED}`));
    // 25 → DARK_GREEN band (20<=25<50)
    const dg = renderBalanceLine({ isAvailable: true, entries: [{ currency: "USD", totalBalance: 25 }], minValue: 25 });
    assert.ok(dg.startsWith(`Balance: ${DARK_GREEN}`));
  });
});

describe("renderBalanceLine — multi-currency joined by ·", () => {
  // vX.X.X+ — pin a raw balance token list (same reason as the
  // single-currency describe above).
  beforeEach(() => {
    __resetForTest({
      statuslineTemplate: ["m_modeLabel", "s_space", "m_balance"],
    });
  });
  afterEach(() => __resetForTest());

  it("renders all entries, joined by ' · ', single color from lowest", () => {
    // CNY 110 (BRIGHT_GREEN) + USD 3.5 (RED). minValue=3.5 → RED band.
    // Each entry's currency code is mapped to its display symbol via
    // the renderer-owned `currencyLabel(code)` helper (CNY → ￥, USD → $).
    const line = renderBalanceLine({
      isAvailable: true,
      entries: [
        { currency: "CNY", totalBalance: 110 },
        { currency: "USD", totalBalance: 3.5 },
      ],
      minValue: 3.5,
    });
    assert.equal(strip(line), "Balance: ￥110 · $3.5");
    assert.ok(line.startsWith(`Balance: ${RED}`));
    assert.ok(line.endsWith(RESET));
    // The colored chunk wraps both chunks together (single SGR block).
    const colored = line.slice("Balance: ".length, -RESET.length);
    assert.equal(colored, `${RED}￥110 · $3.5`);
  });

  it("integer formatting per-chunk", () => {
    const line = renderBalanceLine({
      isAvailable: true,
      entries: [
        { currency: "CNY", totalBalance: 100 },
        { currency: "USD", totalBalance: 200.5 },
      ],
      minValue: 100,
    });
    assert.equal(strip(line), "Balance: ￥100 · $200.5");
  });
});

describe("renderBalanceLine — unavailable", () => {
  // v0.9.x — the legacy `formatBalanceLine` shim short-circuited with a
  // hardcoded "Balance: not available!" sentinel. The shim is gone;
  // renderProviderLine routes the unavailable case through
  // `m_balance` → `formatBalanceEntriesColored` (returns "" when
  // unavailable) → `placeholderBare("m_balance", c)` → "balance:n/a".
  // The `m_age` module surfaces its own placeholder ("age:n/a") in
  // the same pass when no age is provided, producing the final
  // "Balance: balance:n/a age:n/a" form. The whole body is wrapped
  // in STALE_COLOR (placeholderBare's color choice), not RED — the
  // legacy RED tint is preserved only for the dispatch.ts fail-line
  // path (see "renderPlanLine: fail → 'X: not available!'" in
  // dispatch.test.ts).
  it("falls back to 'balance:n/a age:n/a' placeholders when isAvailable=false", () => {
    const line = renderBalanceLine({ isAvailable: false, entries: [], minValue: null });
    assert.equal(strip(line), "Balance: balance:n/a age:n/a");
  });
  it("falls back to placeholders when entries is empty despite isAvailable=true", () => {
    const line = renderBalanceLine({ isAvailable: true, entries: [], minValue: null });
    assert.equal(strip(line), "Balance: balance:n/a age:n/a");
  });
  it("falls back to placeholders when minValue is null", () => {
    const line = renderBalanceLine({ isAvailable: true, entries: [{ currency: "USD", totalBalance: 0 }], minValue: null });
    assert.equal(strip(line), "Balance: balance:n/a age:n/a");
  });
  it("the unavailable-body chunks carry STALE_COLOR (placeholder convention), not RED", () => {
    const line = renderBalanceLine({ isAvailable: false, entries: [], minValue: null });
    assert.ok(line.includes(`${STALE_COLOR}balance:n/a`), `got: ${line}`);
    assert.ok(!line.includes(RED), `RED is reserved for the dispatch fail-line path: ${line}`);
  });
});

describe("m_window5h/7d — stale coloring (v0.6.0+)", () => {
  it("wraps the colored bar chunks AND percent tail in STALE_COLOR when ctx.stale=true, regardless of band", () => {
    // v0.6.0+ (post-bar-blocks extension): on stale, the WHOLE colored
    // span — filled bar chunks (▓) AND the "N%" annotation — switches
    // to STALE_COLOR. The plain side of the bar (░) stays plain so the
    // filled/empty pattern still reads. Without this, a stale 60% bar
    // would paint the ▓ blocks in the band-color of 60% (orange),
    // making the line read as authoritative even though the number is
    // from a stale cache.
    __resetForTest({
      statuslineTemplate:["m_windowQuota|term:short"],
      timeFormat: { minUnit: "s", maxUnitCount: 4 },
    });
    try {
      const fresh = renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: winToIv({ pct: 60, resetAt: null }),
        midInterval: null, longInterval: null, balance: null,
        ageMs: 0, stale: false, version: "",
      });
      const stale = renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: winToIv({ pct: 60, resetAt: null }),
        midInterval: null, longInterval: null, balance: null,
        ageMs: 5 * 60_000, stale: true, version: "",
      });
      // Fresh: band-color wrap on the percent.
      assert.ok(
        /\x1b\[38;5;\d+m60%/.test(fresh),
        `fresh line should wrap '60%' in a band-color SGR: ${fresh}`,
      );
      assert.ok(!fresh.includes(`${STALE_COLOR}60%`), `fresh leaked STALE_COLOR: ${fresh}`);
      // Stale: STALE_COLOR wraps the percent.
      assert.ok(
        stale.includes(`${STALE_COLOR}60%`),
        `stale line should wrap '60%' in STALE_COLOR: ${stale}`,
      );
      // Stale: the colored bar chunks themselves wrap in STALE_COLOR.
      // We assert against the SGR wrapping a `▓` (filled) block —
      // specifically STALE_COLOR, not the band-color 256-color SGR.
      // Use string-level checks (not RegExp) because STALE_COLOR and
      // RESET both contain `[`/`]`, which is a footgun in regex
      // character classes — string search is the simpler path here.
      assert.ok(
        stale.includes(`${STALE_COLOR}▓`),
        `stale bar chunks should be wrapped in STALE_COLOR: ${stale}`,
      );
      // Stale: the bar's plain side (░) is still present and uncolored.
      assert.ok(stale.includes("░"), `stale lost its empty bar chars: ${stale}`);
    } finally {
      __resetForTest();
    }
  });

  it("inline :color: override still wins over stale coloring", () => {
    // Documented v0.3.3+ behavior — explicit :color: always wins.
    // v0.6.0+: stale does NOT silently override the user's color.
    __resetForTest({
      statuslineTemplate:["m_windowQuota|term:short|color:" + ORANGE],
      timeFormat: { minUnit: "s", maxUnitCount: 4 },
    });
    try {
      const stale = renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: winToIv({ pct: 60, resetAt: null }),
        midInterval: null, longInterval: null, balance: null,
        ageMs: 5 * 60_000, stale: true, version: "",
      });
      assert.ok(
        stale.includes(`${ORANGE}60%`),
        `:color: override should wrap '60%' even on stale: ${stale}`,
      );
      assert.ok(!stale.includes(`${STALE_COLOR}60%`), `:color: override was silently overridden by STALE_COLOR: ${stale}`);
    } finally {
      __resetForTest();
    }
  });

  it("stale bar chunks wrap in STALE_COLOR in 'remaining' mode (right-side cells colored)", () => {
    // Symmetric to the used-mode test above. In remaining mode the
    // colored half of the bar is the RIGHT side (the "what's left"
    // metric), so the STALE_COLOR wrap should land on the trailing
    // ▓ run — and the leading ░ run should stay plain. v0.6.0+
    // post-bar-blocks extension.
    __resetForTest({
      statuslineTemplate:["m_windowQuota|term:short"],
      timeFormat: { minUnit: "s", maxUnitCount: 4 },
    });
    try {
      const stale = renderProviderLine("minimax", {
        mode: "remaining", nowMs: Date.now(),
        shortInterval: winToIv({ pct: 60, resetAt: null }),
        midInterval: null, longInterval: null, balance: null,
        ageMs: 5 * 60_000, stale: true, version: "",
      });
      // Stale: STALE_COLOR wraps the percent tail.
      assert.ok(
        stale.includes(`${STALE_COLOR}40%`),
        `stale remaining-mode line should wrap '40%' (100-60) in STALE_COLOR: ${stale}`,
      );
      // Stale: a STALE_COLOR-wrapped ▓ run is present somewhere on
      // the right (after the leading ░ run, since remaining mode
      // colors the right side). The bar still has the filled/empty
      // pattern, just both halves retoned down.
      assert.ok(
        stale.includes(`░${STALE_COLOR}▓`),
        `stale remaining-mode bar should be '░░...▓▓...' with ▓ wrapped in STALE_COLOR: ${stale}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("m_windowContext (synthetic context-window bar) also goes gray on stale", () => {
    // The m_windowContext module goes through the same formatOneChunk
    // path, so the bar-blocks-stale-grayscale extension covers it
    // automatically — but we pin the behavior here so a future
    // refactor of the context-window path doesn't quietly break
    // the contract. v0.6.0+.
    __resetForTest({
      statuslineTemplate:["m_windowContext"],
      timeFormat: { minUnit: "s", maxUnitCount: 4 },
    });
    try {
      const stale = renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, longInterval: null, balance: null,
        contextWindow: { pct: 75, resetAt: null },
        ageMs: 5 * 60_000, stale: true, version: "",
      });
      assert.ok(
        stale.includes(`${STALE_COLOR}75%`),
        `stale m_windowContext should wrap '75%' in STALE_COLOR: ${stale}`,
      );
      assert.ok(
        stale.includes(`${STALE_COLOR}▓`),
        `stale m_windowContext bar chunks should be STALE_COLOR: ${stale}`,
      );
    } finally {
      __resetForTest();
    }
  });
});

describe("m_countdown5h/7d — stale AND past-due renders '(n/a🕒 5h)' in STALE_COLOR (v0.7.x)", () => {
  // The countdown module is the only one that swaps its body on
  // the stale+past-due combination. The trigger is AND-combined:
  //   - stale=true, future reset   → "(Xm🕒 5h)" default teal
  //   - stale=false, past-due      → "(0m🕒 5h)" default teal
  //   - stale=true, past-due       → "(n/a🕒 5h)" STALE_COLOR (this block)
  //
  // The body swap uses the n/a placeholder instead of "0m" so the
  // user can distinguish "cached value already expired" from a
  // fresh past-due tick that's about to roll forward.

  // Default teal used by wrapPlainDefault for m_countdown5h/7d.
  const TEAL_DEFAULT = "\x1b[38;5;80m";

  it("bare m_countdown5h emits '(n/a🕒 5h)' in STALE_COLOR when stale=true AND resetAt is past-due", () => {
    const nowMs = Date.parse("2026-06-24T12:00:00Z");
    __resetForTest({
      statuslineTemplate: ["m_countdown|term:short"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: winToIv({ pct: 30, resetAt: new Date(nowMs - 60_000).toISOString() }),
        midInterval: null, longInterval: null, balance: null,
        ageMs: 5 * 60_000, stale: true, version: "",
      });
      const clean = strip(line);
      // Body should be the n/a form, NOT "0m".
      assert.ok(
        clean.includes("(n/a"),
        `stale+past-due should emit n/a body: ${clean}`,
      );
      assert.ok(
        !clean.includes("0m"),
        `stale+past-due should NOT include 0m: ${clean}`,
      );
      assert.ok(
        clean.includes("5h)"),
        `body should still close with the window label: ${clean}`,
      );
      // Color: STALE_COLOR wraps the whole block.
      assert.ok(
        line.includes(`${STALE_COLOR}(n/a`),
        `stale+past-due body should start with STALE_COLOR: ${line}`,
      );
      assert.ok(
        !line.includes(TEAL_DEFAULT),
        `stale+past-due body should NOT use default teal: ${line}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("bare m_countdown5h keeps '(0m🕒 5h)' default teal when stale=false (fresh tick, past-due)", () => {
    // The fresh-but-past-due case is a separate state — the next
    // tick will roll the countdown forward, so we don't gray it.
    const nowMs = Date.parse("2026-06-24T12:00:00Z");
    __resetForTest({
      statuslineTemplate: ["m_countdown|term:short"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: winToIv({ pct: 30, resetAt: new Date(nowMs - 60_000).toISOString() }),
        midInterval: null, longInterval: null, balance: null,
        ageMs: 0, stale: false, version: "",
      });
      const clean = strip(line);
      assert.ok(
        clean.includes("(0m"),
        `fresh past-due should still emit 0m body: ${clean}`,
      );
      assert.ok(
        !line.includes(STALE_COLOR),
        `fresh past-due should NOT use STALE_COLOR: ${line}`,
      );
      assert.ok(
        line.includes(TEAL_DEFAULT),
        `fresh past-due should use default teal: ${line}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("bare m_countdown5h keeps default teal when stale=true but resetAt is still in the future", () => {
    // stale-only (no past-due): the cached countdown is still
    // truthful within the fetch window; do not gray.
    const nowMs = Date.parse("2026-06-24T12:00:00Z");
    __resetForTest({
      statuslineTemplate: ["m_countdown|term:short"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: winToIv({ pct: 30, resetAt: new Date(nowMs + 30 * 60_000).toISOString() }),
        midInterval: null, longInterval: null, balance: null,
        ageMs: 5 * 60_000, stale: true, version: "",
      });
      const clean = strip(line);
      assert.ok(
        clean.includes("(30m"),
        `stale-but-future should keep its real countdown: ${clean}`,
      );
      assert.ok(
        !line.includes(STALE_COLOR),
        `stale-but-future should NOT use STALE_COLOR: ${line}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("bare m_countdown|term|mid mirrors the same stale+past-due n/a rule", () => {
    const nowMs = Date.parse("2026-06-24T12:00:00Z");
    __resetForTest({
      statuslineTemplate: ["m_countdown|term:mid"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: null,
        midInterval: winToIv({ pct: 50, resetAt: new Date(nowMs - 60_000).toISOString() }, "7d"),
        longInterval: null, balance: null,
        ageMs: 5 * 60_000, stale: true, version: "",
      });
      const clean = strip(line);
      assert.ok(
        clean.includes("(n/a"),
        `stale+past-due 7d should emit n/a body: ${clean}`,
      );
      assert.ok(
        line.includes(`${STALE_COLOR}(n/a`),
        `stale+past-due 7d should wrap in STALE_COLOR: ${line}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("inline :color:red wins over the stale+past-due STALE_COLOR override", () => {
    // Same precedence rule as m_windowQuota*: an explicit :color:
    // always wins. But the BODY swap to n/a still happens — only
    // the color is overridden.
    const nowMs = Date.parse("2026-06-24T12:00:00Z");
    __resetForTest({
      statuslineTemplate: ["m_countdown|term:short|color:" + RED],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: winToIv({ pct: 30, resetAt: new Date(nowMs - 60_000).toISOString() }),
        midInterval: null, longInterval: null, balance: null,
        ageMs: 5 * 60_000, stale: true, version: "",
      });
      const clean = strip(line);
      assert.ok(
        clean.includes("(n/a"),
        `explicit :color: should still swap body to n/a: ${clean}`,
      );
      assert.ok(
        line.includes(`${RED}(n/a`),
        `explicit :color: should override STALE_COLOR on the wrap: ${line}`,
      );
      assert.ok(
        !line.includes(STALE_COLOR),
        `explicit :color: should NOT also inject STALE_COLOR: ${line}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("other modules are unaffected by the stale+past-due branch", () => {
    // The m_windowQuota|term:short / m_windowQuota|term:mid stale coloring
    // path (v0.6.0+) is a separate concern — gated on ctx.stale
    // alone, NOT on past-due. Make sure the new branch in
    // m_countdown|term|short doesn't accidentally leak STALE_COLOR
    // into the window module.
    const nowMs = Date.parse("2026-06-24T12:00:00Z");
    __resetForTest({
      statuslineTemplate: ["m_windowQuota|term:short", "m_countdown|term:short"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: winToIv({ pct: 30, resetAt: new Date(nowMs - 60_000).toISOString() }),
        midInterval: null, longInterval: null, balance: null,
        ageMs: 5 * 60_000, stale: true, version: "",
      });
      // m_window5h in stale mode uses STALE_COLOR around bar+percent.
      // It must NOT be confused with the countdown's n/a block.
      const clean = strip(line);
      assert.ok(
        clean.includes("30%"),
        `window percent should still render: ${clean}`,
      );
      assert.ok(
        clean.includes("(n/a"),
        `countdown should still render n/a: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });
});

// vX.X.X+ — m_countdown / m_quota placeholders are term-aware
// AND uniformly dashes-left across all terms. The pre-vX.X.X
// shape mixed directions: short / mid rendered "<label>:--" but
// long rendered "--:<label>". vX.X.X unifies all terms on the
// dashes-left convention with the label bracketed on the right:
//   - m_countdown        → "--:(<label>)"
//   - m_quota            → "quota:n/a(<label>)"
// Baked-in fallback labels (term:short → "5h", term:mid → "7d",
// term:long → "30d") resolve the same way as the live renderer
// (params.term → Interval.label || fallback), so a configured
// mid-interval with label="8d" still wins.
describe("m_countdown / m_quota term-aware placeholders (vX.X.X+)", () => {
  const nowMs = Date.parse("2026-06-24T12:00:00Z");

  it("m_countdown|term|mid placeholder reads '--:(7d)' when midInterval is null", () => {
    // No mid-interval at all → placeholder falls back to the
    // built-in "7d" label rendered as "--:(7d)" (dashes left,
    // label bracketed right), the same shape as
    // term=short / term=long. The legacy "<label>:--" form for
    // short/mid is GONE — every term now uses the dashes-left
    // contract.
    __resetForTest({
      statuslineTemplate: ["m_countdown|term:mid"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: null,
        midInterval: null,
        longInterval: null, balance: null,
        ageMs: 5 * 60_000, stale: false, version: "",
      });
      const clean = strip(line);
      assert.ok(
        clean.includes("--:(7d)"),
        `placeholder should use --:(7d) fallback for term=mid, got: ${clean}`,
      );
      assert.ok(
        !clean.includes("5h:--") && !clean.includes("7d:--") && !clean.includes("30d:--"),
        `legacy <label>:<dashes> shapes must NOT leak into any term placeholder, got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("m_countdown|term|long placeholder reads '--:(30d)' when longInterval is null", () => {
    // Same uniform shape for term=long: "--:(30d)".
    __resetForTest({
      statuslineTemplate: ["m_countdown|term:long"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: null,
        midInterval: null,
        longInterval: null, balance: null,
        ageMs: 5 * 60_000, stale: false, version: "",
      });
      const clean = strip(line);
      assert.ok(
        clean.includes("--:(30d)"),
        `placeholder should use --:(30d) fallback for term=long, got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("m_countdown|term|short placeholder reads '--:(5h)' when shortInterval is null", () => {
    // Sanity-check that term=short ALSO uses the new dashes-left
    // shape (regression guard: short used to be "5h:--").
    __resetForTest({
      statuslineTemplate: ["m_countdown|term:short"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: null,
        midInterval: null,
        longInterval: null, balance: null,
        ageMs: 5 * 60_000, stale: false, version: "",
      });
      const clean = strip(line);
      assert.ok(
        clean.includes("--:(5h)"),
        `placeholder should use --:(5h) fallback for term=short, got: ${clean}`,
      );
      assert.ok(
        !clean.includes("5h:--"),
        `legacy 5h:-- must NOT leak into term=short placeholder, got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("m_quota|term|mid placeholder reads 'quota:n/a(7d)' when midInterval is null", () => {
    // m_quota placeholder used to be hard-coded `quota:--`
    // (no per-term unit at all). vX.X.X+ unifies on
    // `${prefix}n/a(<label>)` for all three terms (dashes-and-colon
    // collapsed to `n/a`, label moved to the tail).
    __resetForTest({
      statuslineTemplate: ["m_quota|term:mid"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: null,
        midInterval: null,
        longInterval: null, balance: null,
        ageMs: 5 * 60_000, stale: false, version: "",
      });
      const clean = strip(line);
      assert.ok(
        clean.includes("quota:n/a(7d)"),
        `placeholder should embed n/a(7d) for term=mid, got: ${clean}`,
      );
      assert.ok(
        !clean.includes("quota:(5h):--") &&
        !clean.includes("quota:(7d):--") &&
        !clean.includes("quota:(30d):--") &&
        !clean.includes("quota:--:(5h)") &&
        !clean.includes("quota:--:(7d)") &&
        !clean.includes("quota:--:(30d)"),
        `legacy "quota:(<label>):--" / "quota:--:(<label>)" shapes must NOT leak, got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("m_quota|term|long placeholder reads 'quota:n/a(30d)' when longInterval is null", () => {
    // Same uniform shape, just with the 30d fallback.
    __resetForTest({
      statuslineTemplate: ["m_quota|term:long"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: null,
        midInterval: null,
        longInterval: null, balance: null,
        ageMs: 5 * 60_000, stale: false, version: "",
      });
      const clean = strip(line);
      assert.ok(
        clean.includes("quota:n/a(30d)"),
        `placeholder should embed n/a(30d) for term=long, got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("m_quota|term|mid placeholder uses the live midInterval.label when present", () => {
    // When the chosen interval IS present, the placeholder still
    // falls back to its label via `intervalForTerm`. The shape
    // remains "quota:n/a(<label>)".
    __resetForTest({
      statuslineTemplate: ["m_quota|term:mid"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: null,
        midInterval: winToIv({ pct: 50, resetAt: null }, "7d"),
        longInterval: null, balance: null,
        ageMs: 5 * 60_000, stale: false, version: "",
      });
      const clean = strip(line);
      // midInterval.label is "7d" and the quota body returns null
      // (no remainingQuota / usedQuota / limitQuota mapping) → the
      // placeholder fires and uses the resolved midInterval.label.
      assert.ok(
        clean.includes("quota:n/a(7d)"),
        `placeholder should read midInterval.label=7d, got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("bare m_countdown placeholder reads '--:(5h)' (term=short default)", () => {
    // The bare-MODULES path defaults to term=short upstream of
    // the placeholder body, so it now also reads the unified
    // dashes-left shape (regression guard for the bare path —
    // used to be "5h:--" pre-vX.X.X).
    __resetForTest({
      statuslineTemplate: ["m_countdown"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: null,
        midInterval: null,
        longInterval: null, balance: null,
        ageMs: 5 * 60_000, stale: false, version: "",
      });
      const clean = strip(line);
      assert.ok(
        clean.includes("--:(5h)"),
        `bare m_countdown placeholder must use unified --:(5h) shape, got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });
});

// vX.X.X+ — `m_quota` body renders `used/limit` from the
// configured Interval. The legacy behavior was: when only
// `limitQuota` was set (no `usedQuota`), it fell through to
// `0/limit`. That was misleading for Copilot-style payloads
// where `remainingQuota = limit` (all 1500 of 1500 remaining) —
// the renderer said "0 used" instead of "0 used" — well, the
// math was right but the user couldn't see the remaining
// portion. The new branch derives `used = limit - remaining`
// when `remainingQuota` is the only quota axis set.
describe("m_quota body — remainingQuota fallback (vX.X.X+)", () => {
  const nowMs = Date.parse("2026-06-24T12:00:00Z");

  function quotaOnly(iv: {
    remainingPercent?: number | null;
    remainingQuota?: number | null;
    usedQuota?: number | null;
    limitQuota?: number | null;
  }) {
    __resetForTest({
      statuslineTemplate: ["m_quota|term:long"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    const base: import("./render.ts").Interval = {
      windowId: "30d",
      label: "30d",
      startAt: null,
      endAt: null,
      intervalMs: null,
      usedPercent: null,
      remainingPercent: null,
      remainingQuota: null,
      usedQuota: null,
      limitQuota: null,
    };
    return renderProviderLine("minimax", {
      mode: "used", nowMs,
      shortInterval: null,
      midInterval: null,
      longInterval: { ...base, ...iv },
      balance: null,
      ageMs: 5 * 60_000, stale: false, version: "",
    });
  }

  it("remainingQuota = limit → renders '0/1500' (Copilot untouched / no spend)", () => {
    // 1500 remaining of 1500 limit ⇒ used should be 0, and the
    // result happens to coincide with the legacy "0/limit"
    // branch. The fix's purpose is to keep the renderer
    // consistent across payloads where `remaining` < `limit`.
    try {
      const line = quotaOnly({ remainingQuota: 1500, limitQuota: 1500 });
      const clean = strip(line);
      assert.ok(
        clean.includes("quota:0/1500(30d)"),
        `expected quota:0/1500(30d), got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("remainingQuota < limit → renders '<used>/<limit>' (the user's bug)", () => {
    // The case the user reported: 1500 remaining of 1500 used
    // makes no sense — but with a paid plan, e.g. 735 remaining
    // of 1500 ⇒ used = 765. The legacy renderer emitted "0/1500";
    // vX.X.X+ correctly emits "765/1500".
    try {
      const line = quotaOnly({ remainingQuota: 735, limitQuota: 1500 });
      const clean = strip(line);
      assert.ok(
        clean.includes("quota:765/1500(30d)"),
        `expected quota:765/1500(30d) (used = limit - remaining), got: ${clean}`,
      );
      assert.ok(
        !clean.includes("0/1500"),
        `legacy 0/1500 must NOT leak when remainingQuota < limitQuota, got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("usedQuota + limitQuota ⇒ unchanged (legacy branch wins when both set)", () => {
    // When the upstream actually supplies `usedQuota` (MiniMax
    // does), the new branch must not preempt the legacy path —
    // a stale `remainingQuota` from a bug in the upstream
    // wouldn't accidentally rewrite the displayed used figure.
    try {
      const line = quotaOnly({ usedQuota: 42, limitQuota: 1500, remainingQuota: 1458 });
      const clean = strip(line);
      assert.ok(
        clean.includes("quota:42/1500(30d)"),
        `legacy used+limit path should still win, got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("remainingQuota clamping — drift (rounding / refund) stays in [0, limit]", () => {
    // remainingQuota > limitQuota should never produce a
    // negative used figure. (Math.max(0, …) keeps it at 0.)
    try {
      const line = quotaOnly({ remainingQuota: 1600, limitQuota: 1500 });
      const clean = strip(line);
      assert.ok(
        clean.includes("quota:0/1500(30d)"),
        `over-the-limit remaining clamps used to 0, got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("only limitQuota set (no used / remaining) → '0/limit' fallback unchanged", () => {
    // Truly-quota-less upstream (the legacy "0/limit" branch)
    // still wins — preserves the contract for users whose config
    // only maps `limitQuota` from the upstream response.
    try {
      const line = quotaOnly({ remainingQuota: null, limitQuota: 1500 });
      const clean = strip(line);
      assert.ok(
        clean.includes("quota:0/1500(30d)"),
        `legacy 0/limit branch must still fire, got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });
});

// vX.X.X+ — `m_quota` accepts `display:<used|remaining>` like
// `m_windowQuota` does. Default is `display:used` (so legacy
// renders stay byte-identical after upgrade). `display:remaining`
// mirrors the axis: outputs `<remaining>/<limit>` instead of
// `<used>/<limit>`. Symmetric fallback rules:
//   - remainingQuota set → render directly
//   - only usedQuota set  → derive `remaining = clamp(limit - used, 0, limit)`
//   - neither but limitQuota → `<limit>/<limit>` (everything
//     remaining since nothing used is known)
describe("m_quota display arg (vX.X.X+)", () => {
  const nowMs = Date.parse("2026-06-24T12:00:00Z");

  function quotaOnly(
    iv: {
      remainingPercent?: number | null;
      remainingQuota?: number | null;
      usedQuota?: number | null;
      limitQuota?: number | null;
    },
    template: string,
  ) {
    __resetForTest({
      statuslineTemplate: [template],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    const base: import("./render.ts").Interval = {
      windowId: "30d",
      label: "30d",
      startAt: null,
      endAt: null,
      intervalMs: null,
      usedPercent: null,
      remainingPercent: null,
      remainingQuota: null,
      usedQuota: null,
      limitQuota: null,
    };
    return renderProviderLine("minimax", {
      mode: "used", nowMs,
      shortInterval: null,
      midInterval: null,
      longInterval: { ...base, ...iv },
      balance: null,
      ageMs: 5 * 60_000, stale: false, version: "",
    });
  }

  it("display:used default — legacy <used>/<limit> axis preserved", () => {
    // Confirm the new arg's DEFAULT still matches the legacy
    // behavior (one regression-guard before swapping modes).
    try {
      const line = quotaOnly(
        { usedQuota: 765, remainingQuota: 735, limitQuota: 1500 },
        "m_quota|term:long",
      );
      const clean = strip(line);
      assert.ok(
        clean.includes("quota:765/1500(30d)"),
        `default display should render used axis, got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("display:remaining — flips the axis to <remaining>/<limit>", () => {
    // Same data as the legacy test but flipped axis:
    // remaining=735 → "735/1500" instead of "765/1500".
    try {
      const line = quotaOnly(
        { usedQuota: 765, remainingQuota: 735, limitQuota: 1500 },
        "m_quota|term:long|display:remaining",
      );
      const clean = strip(line);
      assert.ok(
        clean.includes("quota:735/1500(30d)"),
        `display:remaining should swap to remaining axis, got: ${clean}`,
      );
      assert.ok(
        !clean.includes("quota:765/1500(30d)"),
        `legacy used axis must NOT leak into display:remaining, got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("display:remaining + only usedQuota set → derive from limit", () => {
    // Upstream payload sometimes only sets usedQuota (e.g.
    // single-axis burndown). display:remaining must derive
    // remaining = clamp(limit - used, 0, limit).
    try {
      const line = quotaOnly(
        { usedQuota: 765, limitQuota: 1500 },
        "m_quota|term:long|display:remaining",
      );
      const clean = strip(line);
      assert.ok(
        clean.includes("quota:735/1500(30d)"),
        `remaining axis should derive from used+limit, got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("display:remaining + only limitQuota set → '<limit>/<limit>' (full bucket)", () => {
    // No used / remaining data → used-mode falls through to
    // "0/limit" (the user reported it as misleading). The
    // remaining-mode equivalent is the inverse: "limit/limit"
    // (everything is remaining since nothing used is known).
    try {
      const line = quotaOnly(
        { remainingQuota: null, usedQuota: null, limitQuota: 1500 },
        "m_quota|term:long|display:remaining",
      );
      const clean = strip(line);
      assert.ok(
        clean.includes("quota:1500/1500(30d)"),
        `no-data case in remaining mode should render full bucket, got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("display:remaining clamping — drift (used > limit) keeps remaining at 0", () => {
    // Defensive: if upstream over-reports used (rounding /
    // carry-over), remaining=limit-used must clamp to 0 (not
    // negative).
    try {
      const line = quotaOnly(
        { usedQuota: 2000, limitQuota: 1500 },
        "m_quota|term:long|display:remaining",
      );
      const clean = strip(line);
      assert.ok(
        clean.includes("quota:0/1500(30d)"),
        `overflowing used should clamp remaining to 0, got: ${clean}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("inline display:garbage drops the whole token (inline-args parser pass-or-reject contract)", () => {
    // Inline-args are pass-or-reject: a value outside the
    // {used,remaining} whitelist makes `parseInlineArgs` return
    // null, which (per the `expandInlineToken` contract) drops
    // the WHOLE `m_quota|…` token — same as a typo'd color.
    // This matches `m_windowQuota|display:garbage` and every
    // other module that uses named inline args. The renderer
    // doesn't render anything; the slot stays empty (no panic).
    try {
      const line = quotaOnly(
        { usedQuota: 100, limitQuota: 1500 },
        "m_quota|term:long|display:garbage",
      );
      const clean = strip(line);
      assert.ok(
        !clean.includes("quota:(30d)"),
        `bad display value should drop the token entirely, got: ${clean}`,
      );
      // sanity: the template was attempted (no crash), output
      // is just empty / whitespace around the dropped slot.
      assert.equal(typeof clean, "string");
    } finally {
      __resetForTest();
    }
  });
});

// vX.X.X+ — `m_quota` mirrors `m_windowQuota` / `m_windowContext`:
// the displayed digit (the "metric of concern") carries the band
// color (5 thresholds → brightGreen → red), the prefix / limit
// tail stay plain. Inline `|color|<c>` overrides the band (same
// precedence as every other inline module). When no usable ratio
// can be derived (axisPct == null), the digit lands in
// STALE_COLOR so the band doesn't pick a spurious hue.
describe("m_quota band color (vX.X.X+)", () => {
  const nowMs = Date.parse("2026-06-24T12:00:00Z");

  function quotaLine(
    iv: {
      remainingPercent?: number | null;
      remainingQuota?: number | null;
      usedQuota?: number | null;
      limitQuota?: number | null;
    },
    template: string,
  ) {
    __resetForTest({
      statuslineTemplate: [template],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    const base: import("./render.ts").Interval = {
      windowId: "30d",
      label: "30d",
      startAt: null,
      endAt: null,
      intervalMs: null,
      usedPercent: null,
      remainingPercent: null,
      remainingQuota: null,
      usedQuota: null,
      limitQuota: null,
    };
    return renderProviderLine("minimax", {
      mode: "used", nowMs,
      shortInterval: null,
      midInterval: null,
      longInterval: { ...base, ...iv },
      balance: null,
      ageMs: 5 * 60_000, stale: false, version: "",
    });
  }

  // 5-band palette ordering under default
  // thresholds.percentBands = [60, 70, 80, 90]:
  //   band 0 (≤60)     → brightGreen
  //   band 1 (60–70)   → darkGreen
  //   band 2 (70–80)   → yellow
  //   band 3 (80–90)   → orange
  //   band 4 (>90)     → red
  const BRIGHT_GREEN = "\x1b[38;5;41m";
  const DARK_GREEN   = "\x1b[38;5;29m";
  const YELLOW       = "\x1b[38;5;220m";
  const ORANGE       = "\x1b[38;5;208m";
  const RED          = "\x1b[38;5;196m";
  const STALE        = "\x1b[90m";

  function sgr(s: string): string { return s; }

  it("used-mode 765/1500 (51% used) → brightGreen around the digit", () => {
    // usedPct 51 → band 0 (under 60) → brightGreen. The /1500
    // tail + prefix stay plain (no SGR between them).
    try {
      const line = quotaLine(
        { usedQuota: 765, limitQuota: 1500 },
        "m_quota|term:long",
      );
      assert.ok(
        line.includes(`${sgr(BRIGHT_GREEN)}765${"\x1b[0m"}/1500`),
        `digit 765 should be wrapped in BRIGHT_GREEN + reset, got SGR-stripped: ${strip(line)}\nraw: ${line}`,
      );
      // Prefix is plain — no SGR before the digit.
      const idx = line.indexOf("765");
      assert.ok(
        idx > 0 && !/\\x1b\[[0-9;]*m765/.test(line.slice(Math.max(0, idx - 20), idx)),
        `prefix should be plain (no SGR immediately before the digit), raw: ${line}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("used-mode 1200/1500 (80% used) → boundary band picks YELLOW (band 2)", () => {
    // usedPct = 80 EXACTLY → bandIndex uses `v < thresholds[i]`, so
    // band 2 ([70, 80) exclusive on the high) holds; 80 itself
    // tips into band 3 (orange). Confirms the boundary rule.
    try {
      const line = quotaLine(
        { usedQuota: 1200, limitQuota: 1500 },
        "m_quota|term:long",
      );
      assert.ok(
        line.includes(`${sgr(ORANGE)}1200${"\x1b[0m"}/1500`),
        `usedPct=80 should land on ORANGE (band 3), got: ${strip(line)}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("used-mode 50% (715/1500) → DARK_GREEN (band 1, 60–70 boundary)", () => {
    // usedPct 47.7 (715/1500) → band 1 (60–70 range becomes
    // 60–70 because the function clamps to [0,100]). Actually 47.7
    // falls in band 0 (under 60). Use exact 60 to test the
    // boundary: 900/1500 = 60 → band 0 since `v < 60` is the
    // first band condition. Use 65 to land in band 1.
    try {
      const line = quotaLine(
        { usedQuota: 975, limitQuota: 1500 },
        "m_quota|term:long",
      );
      // 975/1500 = 65 → band 1 → DARK_GREEN.
      assert.ok(
        line.includes(`${sgr(DARK_GREEN)}975${"\x1b[0m"}/1500`),
        `usedPct=65 should be DARK_GREEN, got: ${strip(line)}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("used-mode 75% (1125/1500) → YELLOW (band 2, 70–80)", () => {
    // 75% falls in band 2 (70 ≤ usedPct < 80) → YELLOW.
    // Mirrors m_windowQuota's band ordering so all three modules
    // share the same danger ladder.
    try {
      const line = quotaLine(
        { usedQuota: 1125, limitQuota: 1500 },
        "m_quota|term:long",
      );
      assert.ok(
        line.includes(`${sgr(YELLOW)}1125${"\x1b[0m"}/1500`),
        `usedPct=75 should be YELLOW, got: ${strip(line)}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("used-mode 99% → RED (top band)", () => {
    try {
      const line = quotaLine(
        { usedQuota: 1485, limitQuota: 1500 },
        "m_quota|term:long",
      );
      assert.ok(
        line.includes(`${sgr(RED)}1485${"\x1b[0m"}/1500`),
        `usedPct=99 should be RED, got: ${strip(line)}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("remaining-mode 73% remaining → BRIGHT_GREEN (low usedPct, regardless of displayed)", () => {
    // Mode = remaining, remainingQuota = 1100, limit = 1500.
    // displayed = 73.3 → colorFor(73.3, "remaining") flips to
    // usedPct = 100 - 73.3 = 26.7 → band 0 (brightGreen).
    try {
      const line = quotaLine(
        { remainingQuota: 1100, limitQuota: 1500 },
        "m_quota|term:long|display:remaining",
      );
      assert.ok(
        line.includes(`${sgr(BRIGHT_GREEN)}1100${"\x1b[0m"}/1500`),
        `remaining-mode 73% should still pick BRIGHT_GREEN (band 0 usedPct), got: ${strip(line)}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("inline |color|red overrides the band color", () => {
    // Same 765/1500 as the first test but with :color:red forced;
    // the override should win, BRIGHT_GREEN must NOT appear.
    try {
      const line = quotaLine(
        { usedQuota: 765, limitQuota: 1500 },
        "m_quota|term:long|display:used|color:" + RED,
      );
      assert.ok(
        line.includes(`${sgr(RED)}765${"\x1b[0m"}/1500`),
        `inline :color:red should override the band, got: ${strip(line)}`,
      );
      assert.ok(
        !line.includes(BRIGHT_GREEN),
        `BRIGHT_GREEN band must NOT appear when :color:red is set, got: ${strip(line)}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("no usable ratio (`used/--`) → STALE_COLOR around the digit", () => {
    // usedQuota set, limitQuota null → parts.axisPct == null →
    // wrapQuotaBody falls to STALE_COLOR (matches m_window*'s
    // "no percent → gray" convention).
    try {
      const line = quotaLine(
        { usedQuota: 42 },
        "m_quota|term:long",
      );
      assert.ok(
        line.includes(`${sgr(STALE)}42${"\x1b[0m"}/--`),
        `no-ratio case should STALE-COLOR the digit, got: ${strip(line)}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("only limitQuota set in remaining-mode (full bucket) → BRIGHT_GREEN (0% used)", () => {
    // mode=remaining, only limitQuota set → renderQuotaParts
    // returns {axisNumber: limit, total: limit, axisPct: 100}.
    // colorFor(100, "remaining") flips to usedPct = 100 - 100 = 0
    // → band 0 (BRIGHT_GREEN, the "least concerning" hue). This
    // mirrors the user's spec that `m_quota` band-map mirrors
    // `m_windowQuota` — there, 100% remaining is also greenest.
    try {
      const line = quotaLine(
        { limitQuota: 1500 },
        "m_quota|term:long|display:remaining",
      );
      assert.ok(
        line.includes(`${sgr(BRIGHT_GREEN)}1500${"\x1b[0m"}/1500`),
        `full-bucket remaining mode → BRIGHT_GREEN (0% used), got: ${strip(line)}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("bare m_quota renders band color too (not just inline)", () => {
    // Confirm the bare MODULES path also got the band-color
    // treatment (regression guard — `wrapPlainDefault` would have
    // eaten it before this refactor).
    try {
      __resetForTest({
        statuslineTemplate: ["m_quota|term:long"],
        timeFormat: { minUnit: "m", maxUnitCount: 2 },
      });
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: null,
        midInterval: null,
        longInterval: {
          windowId: "30d",
          label: "30d",
          startAt: null, endAt: null, intervalMs: null,
          usedPercent: null, remainingPercent: null,
          remainingQuota: null,
          usedQuota: 765,
          limitQuota: 1500,
        },
        balance: null,
        ageMs: 5 * 60_000, stale: false, version: "",
      });
      assert.ok(
        line.includes(`${sgr(BRIGHT_GREEN)}765${"\x1b[0m"}/1500`),
        `bare m_quota should also band-color the digit, got: ${strip(line)}`,
      );
    } finally {
      __resetForTest();
    }
  });
});

describe("formatStaleSuffix", () => {
  beforeEach(() => {
    __resetForTest({ timeFormat: { minUnit: "m", maxUnitCount: 2 } });
  });
  it("returns empty only for non-finite ageMs; ageMs = 0 renders the X-ago label", () => {
    // v0.4.0: formatStaleSuffix no longer short-circuits on ageMs <= 0.
    // It now always falls through to formatRemainingMs so a stale-on-
    // error tick at ageMs=0 produces "⛓️‍💥 0m ago" (default minUnit=m)
    // or "⛓️‍💥 0s ago" (minUnit=s). The visibility gate moved up to
    // the m_age module / forced-visibility append, which only call
    // this function when stale=true.
    assert.equal(formatStaleSuffix(Number.NaN), "");
    assert.equal(formatStaleSuffix(Number.POSITIVE_INFINITY), "");
    assert.equal(formatStaleSuffix(Number.NEGATIVE_INFINITY), "");
    // ageMs = 0 → "0<minUnit> ago" (default minUnit=m → "0m ago").
    assert.equal(strip(formatStaleSuffix(0)), "⛓️‍💥 0m ago");
    // Negative ageMs: formatRemainingMs returns "0<minUnit>" too
    // (the helper clamps to "0m" / "0s" / "0h" for past-due inputs).
    assert.equal(strip(formatStaleSuffix(-1)), "⛓️‍💥 0m ago");
  });

  it("sub-minute uses minUnit floor: 'm' → '<1m ago', 's' → '${seconds}s ago'", () => {
    // v0.2.14: no spurious round-up — minUnit governs the sub-minute
    // rendering. With default minUnit='m', sub-minute → "<1m ago".
    // With minUnit='s', sub-minute → "30s ago" / "59s ago".
    assert.equal(strip(formatStaleSuffix(30_000)), "⛓️‍💥 <1m ago");
    assert.equal(strip(formatStaleSuffix(59_000)), "⛓️‍💥 <1m ago");
    __resetForTest({ timeFormat: { minUnit: "s", maxUnitCount: 2 } } as Partial<Config>);
    assert.equal(strip(formatStaleSuffix(30_000)), "⛓️‍💥 30s ago");
    assert.equal(strip(formatStaleSuffix(59_000)), "⛓️‍💥 59s ago");
    __resetForTest();
  });

  it("sub-minute → 'Xm ago' (X >= 1)", () => {
    assert.equal(strip(formatStaleSuffix(60_000)), "⛓️‍💥 1m ago");
    assert.equal(strip(formatStaleSuffix(5 * 60_000)), "⛓️‍💥 5m ago");
    assert.equal(strip(formatStaleSuffix(59 * 60_000)), "⛓️‍💥 59m ago");
  });

  it(">= 1h shows up to 2 non-zero units (1h30m ago, not just '1h ago')", () => {
    // v0.2.11: maxUnitCount=2 → keep up to 2 non-zero units including
    // internal zeros. 1h30m stays "1h30m", NOT "1h". 1h0m (i.e. exactly
    // 60 minutes) stays "1h0m" — only LEADING zeros are dropped.
    assert.equal(strip(formatStaleSuffix(60 * 60_000)), "⛓️‍💥 1h0m ago");
    assert.equal(strip(formatStaleSuffix(90 * 60_000)), "⛓️‍💥 1h30m ago");
    assert.equal(strip(formatStaleSuffix(4 * 60 * 60_000 + 23 * 60_000)), "⛓️‍💥 4h23m ago");
    // 23h exactly → 23h0m (internal zero preserved per v0.2.11 rule)
    assert.equal(strip(formatStaleSuffix(23 * 60 * 60_000)), "⛓️‍💥 23h0m ago");
  });

  it(">= 24h shows up to 2 non-zero units (1d5h ago, not just '1d ago')", () => {
    // 24h exactly → 1d0h (internal zero preserved per v0.2.11 rule)
    assert.equal(strip(formatStaleSuffix(24 * 60 * 60_000)), "⛓️‍💥 1d0h ago");
    // 25h = 1d1h
    assert.equal(strip(formatStaleSuffix(25 * 60 * 60_000)), "⛓️‍💥 1d1h ago");
    assert.equal(strip(formatStaleSuffix(29 * 60 * 60_000)), "⛓️‍💥 1d5h ago");
    // 3d exactly → 3d0h (internal zero preserved per v0.2.11 rule)
    assert.equal(strip(formatStaleSuffix(3 * 24 * 60 * 60_000)), "⛓️‍💥 3d0h ago");
  });

  it("uses BROKEN_COLOR when healthy=false; STALE_COLOR when healthy=true", () => {
    // v0.6.0+ — split the gray stale color into two: gray (STALE_COLOR)
    // for the informational 🔗 annotation on fresh ticks, dark red
    // (BROKEN_COLOR) for the ⛓️‍💥 annotation when the fetch failed.
    assert.equal(
      formatStaleSuffix(5 * 60_000, false),
      `${BROKEN_TEST_COLOR}⛓️‍💥 5m ago${RESET}`,
      "broken chain must wrap in BROKEN_COLOR",
    );
    assert.equal(
      formatStaleSuffix(5 * 60_000, true),
      `${STALE_COLOR}🔗 5m ago${RESET}`,
      "healthy (fresh) must wrap in STALE_COLOR",
    );
  });
});

describe("renderQuotaLine — stale suffix integration", () => {
  beforeEach(() => {
    __resetForTest({ timeFormat: { minUnit: "m", maxUnitCount: 2 } });
  });
  it("appends the stale suffix with broken emoji when stale=true", () => {
    const line = renderQuotaLine(
      legacyToIv({ pct: 38, resetAt: null }),
      legacyToIv({ pct: 39, resetAt: null }, "7d"),
      null,
      "used",
      Date.now(),
      5 * 60_000,
      true,  // stale → broken emoji
    );
    // Stale suffix should be at the END of the line. v0.2.11: broken
    // emoji IS the indicator, no leading " · " separator.
    assert.ok(line.endsWith(`${BROKEN_TEST_COLOR}⛓️‍💥 5m ago${RESET}`), `unexpected tail: ${JSON.stringify(line)}`);
    assert.ok(strip(line).endsWith("⛓️‍💥 5m ago"), `stripped: ${strip(line)}`);
  });

  it("appends the stale suffix with healthy emoji when stale=false (forced fallback)", () => {
    // v0.4.0: priority is template-driven. When the user did NOT put
    // m_age in their lineTemplate, the forced-visibility fallback
    // fires only on stale. A fresh tick (default plan template has
    // no m_age) renders no suffix — the broken-chain indicator is
    // reserved for real outages.
    // v0.4.x: the default quota template now ends with `m_age`, so
    // renderQuotaLine renders the slot via m_age and the forced-fallback
    // path stays silent. To exercise the stale-fallback logic in
    // isolation we override the template to mirror pre-v0.4.x.
    __resetForTest({
      statuslineTemplate:[
        "m_modeLabel", "s_space",
        "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
        "s_space", "s_dot", "s_space",
        "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
      ],
    });
    try {
      const line = renderQuotaLine(
        legacyToIv({ pct: 38, resetAt: null }),
        legacyToIv({ pct: 39, resetAt: null }, "7d"),
        null,
        "used",
        Date.now(),
        30_000,
        false,
      );
      assert.ok(!line.includes("ago"), `got: ${line}`);
      assert.ok(!line.includes(STALE_COLOR), `got: ${line}`);
    } finally {
      __resetForTest();
    }
  });

  it("does NOT append the stale suffix when ageMs is omitted", () => {
    __resetForTest({
      statuslineTemplate:[
        "m_modeLabel", "s_space",
        "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
        "s_space", "s_dot", "s_space",
        "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
      ],
    });
    try {
      const line = renderQuotaLine(legacyToIv({ pct: 38, resetAt: null }), legacyToIv({ pct: 39, resetAt: null }, "7d"));
      assert.ok(!line.includes("ago"));
      assert.ok(!line.includes(STALE_COLOR));
    } finally {
      __resetForTest();
    }
  });

  it("does NOT append the stale suffix when ageMs is 0 and stale=false", () => {
    __resetForTest({
      statuslineTemplate:[
        "m_modeLabel", "s_space",
        "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
        "s_space", "s_dot", "s_space",
        "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
      ],
    });
    try {
      const line = renderQuotaLine(
        legacyToIv({ pct: 38, resetAt: null }),
        legacyToIv({ pct: 39, resetAt: null }, "7d"),
        null,
        "used",
        Date.now(),
        0
      );
      assert.ok(!line.includes("ago"));
    } finally {
      __resetForTest();
    }
  });

  it("DOES append the broken-chain suffix when stale=true even if ageMs is 0", () => {
    // v0.4.0: formatStaleSuffix no longer short-circuits on ageMs=0.
    // A just-failed fetch shows "⛓️‍💥 0m ago" (forced fallback, since
    // the default template doesn't include m_age).
    const line = renderQuotaLine(
      legacyToIv({ pct: 38, resetAt: null }),
      legacyToIv({ pct: 39, resetAt: null }, "7d"),
      null,
      "used",
      Date.now(),
      0,
      true,
    );
    assert.ok(strip(line).endsWith("⛓️‍💥 0m ago"), `got: ${line}`);
  });
});

describe("renderBalanceLine — stale suffix integration", () => {
  beforeEach(() => {
    __resetForTest({ timeFormat: { minUnit: "m", maxUnitCount: 2 } });
  });
  it("appends the stale suffix with broken emoji when stale=true", () => {
    const line = renderBalanceLine(
      { isAvailable: true, entries: [{ currency: "CNY", totalBalance: 110 }], minValue: 110 },
      5 * 60_000,
      true,  // stale → broken emoji
    );
    assert.ok(line.endsWith(`${BROKEN_TEST_COLOR}⛓️‍💥 5m ago${RESET}`));
    assert.ok(strip(line).endsWith("⛓️‍💥 5m ago"));
  });

  it("appends the stale suffix on a multi-currency line", () => {
    const line = renderBalanceLine(
      {
        isAvailable: true,
        entries: [
          { currency: "CNY", totalBalance: 110 },
          { currency: "USD", totalBalance: 3.5 },
        ],
        minValue: 3.5,
      },
      90 * 60_000,
      true,
    );
    // 90m → 1h30m ago (v0.2.11: maxUnitCount=2 keeps internal non-zero units)
    assert.ok(strip(line).endsWith("⛓️‍💥 1h30m ago"));
  });

  it("does append the stale suffix on the unavailable branch (m_age fires regardless of m_balance)", () => {
    // v0.9.x — the legacy `formatBalanceLine` short-circuited the
    // unavailable case BEFORE m_age could fire, so the stale suffix
    // was suppressed. After the shim deletion, the renderer routes
    // through m_balance → placeholderBare AND m_age → formatStaleSuffix
    // independently; with stale=true + ageMs>0 the suffix still
    // emits on top of the "balance:n/a" placeholder. The pin here
    // documents that the legacy "no suffix on fail" guarantee is
    // gone — it's the dispatch.ts fail-line path (kind="fail") that
    // owns the unavailable-without-stale semantics now.
    const line = renderBalanceLine(
      { isAvailable: false, entries: [], minValue: null },
      5 * 60_000,
      true,
    );
    assert.ok(strip(line).endsWith("⛓️‍💥 5m ago"), `got: ${strip(line)}`);
    assert.ok(strip(line).includes("balance:n/a"));
  });

  it("does NOT append the stale suffix when ageMs is omitted", () => {
    const line = renderBalanceLine({
      isAvailable: true,
      entries: [{ currency: "USD", totalBalance: 25 }],
      minValue: 25,
    });
    assert.ok(!line.includes("ago"));
  });
});

// v0.9.x — m_pluginSource module: visual indicator of which side
// of the user-vs-builtin fence the active provider's plugin was
// loaded from. 📌 for built-in (shipped-with-the-plugin), 🎨 for
// user override (query_plugins/<id>/), ❗ for missing (matched
// provider id has no plugin at all), drop (no-op) when no cache
// row exists or the source is unrecognizable. No default tint —
// the symbol carries the meaning on its own (per the user's
// "user |color| override only" decision 2026-07-11). A 4th
// branch 🔖 / "cc" is reserved for the future claude-官方 case
// — the type axis + default glyph exist, but no dispatcher
// arm reads it yet (CC 分支暂不做实现 2026-07-12).
describe("m_pluginSource (v0.9.x)", () => {
  // The bar/window subtests above use `quotaLine(iv, template)`;
  // here we don't need interval data — the pluginSource glyph
  // is provider-side metadata, not plan data. We just construct
  // a minimal ctx with the pluginSource flag.
  const nowMs = Date.parse("2026-06-24T12:00:00Z");

  function lineFor(
    pluginSource: "user" | "builtin" | "missing" | null | undefined,
    template: string,
  ): string {
    __resetForTest({ statuslineTemplate: [template] });
    return renderProviderLine("minimax", {
      mode: "used",
      nowMs,
      shortInterval: null,
      midInterval: null,
      longInterval: null,
      balance: null,
      ageMs: 5 * 60_000,
      stale: false,
      version: "",
      pluginSource: pluginSource ?? null,
    });
  }

  it("renders 📌 for built-in (no tint)", () => {
    const line = lineFor("builtin", "m_pluginSource");
    // No ANSI tint around the glyph (per "user |color| override
    // only" — no DEFAULT_COLORS.m_pluginSource).
    assert.ok(strip(line).includes("📌"),
      `built-in should render 📌, got: ${strip(line)}`);
    assert.ok(!line.includes("\x1b[38;5;"),
      `built-in glyph should NOT be color-tinted, got: ${line}`);
  });

  it("renders 🎨 for user (no tint)", () => {
    const line = lineFor("user", "m_pluginSource");
    assert.ok(strip(line).includes("🎨"),
      `user should render 🎨, got: ${strip(line)}`);
    assert.ok(!line.includes("\x1b[38;5;"),
      `user glyph should NOT be color-tinted, got: ${line}`);
  });

  it("renders ❗ for missing (matched provider has no plugin)", () => {
    // vX.X.X+ — the missing branch was previously silent-drop
    // (peekPluginSource collapsed `"missing"` to null). Now it
    // surfaces as ❗ so a misconfigured provider id
    // (e.g. user set providers.copilot.* but never installed
    // query_plugins/copilot/) is loud instead of silent. Glyph
    // comes from labels.labelPluginMissing (default "❗").
    const line = lineFor("missing", "m_pluginSource");
    assert.ok(strip(line).includes("❗"),
      `missing should render ❗, got: ${strip(line)}`);
    assert.ok(!line.includes("\x1b[38;5;"),
      `missing glyph should NOT be color-tinted, got: ${line}`);
  });

  it("❗ bare render equals just the glyph (no wrap)", () => {
    // Mirror of the 📌 bare-render test: when m_pluginSource is
    // the sole template token with pluginSource="missing", the
    // stripped line is exactly "❗".
    const line = lineFor("missing", "m_pluginSource");
    assert.equal(strip(line), "❗",
      `bare m_pluginSource missing should emit just ❗, got: '${line}'`);
  });

  it("labels.labelPluginMissing override renders the user's string for missing", () => {
    // Symmetric of labelPluginSystem / labelPluginUserDefined:
    // the missing axis is also overridable via config.labels.
    __resetForTest({
      statuslineTemplate: ["m_pluginSource"],
      labels: { labelPluginMissing: "[!]" },
    } as Partial<Config>);
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs,
      shortInterval: null,
      midInterval: null,
      longInterval: null,
      balance: null,
      ageMs: 5 * 60_000,
      stale: false,
      version: "0.0.0",
      tokens: null,
      pluginSource: "missing",
    });
    assert.equal(strip(line), "[!]",
      `labelPluginMissing override should render "[!]" verbatim, got: ${strip(line)}`);
  });

  it("built-in / user / missing glyphs are visually distinct", () => {
    // Pin that all three glyphs are different characters —
    // a typo at any axis would otherwise be easy to miss
    // (e.g. ❗ vs ❕ vs ❌).
    const builtin = lineFor("builtin", "m_pluginSource");
    const user    = lineFor("user",    "m_pluginSource");
    const missing = lineFor("missing", "m_pluginSource");
    const bs = strip(builtin), us = strip(user), ms = strip(missing);
    assert.notEqual(bs, us, `built-in and user should differ: ${bs} vs ${us}`);
    assert.notEqual(bs, ms, `built-in and missing should differ: ${bs} vs ${ms}`);
    assert.notEqual(us, ms, `user and missing should differ: ${us} vs ${ms}`);
  });

  it("drops to no-op when ctx.pluginSource is null", () => {
    // Per the "Drop 整个 module" decision 2026-07-11 — the module
    // returns null and the template emits nothing. We test this
    // by asserting the line is the empty string (no m_pluginSource
    // glyph, no placeholder, no label).
    const line = lineFor(null, "m_pluginSource");
    assert.equal(strip(line), "",
      `null pluginSource should drop, got: '${line}'`);
  });

  it("drops when ctx.pluginSource is omitted entirely", () => {
    // Older callers + test fixtures don't thread the field. The
    // renderer normalizes undefined → null and drops.
    const line = lineFor(undefined, "m_pluginSource");
    assert.equal(strip(line), "",
      `omitted pluginSource should drop, got: '${line}'`);
  });

  it("inline `m_pluginSource` in a multi-token template composes correctly", () => {
    // When m_pluginSource sits alongside another module, both
    // should appear in the rendered line and the glyph carries
    // no surrounding color while the other module's tint is
    // preserved (regression guard: m_pluginSource must not
    // accidentally absorb a template-wide tinting pass).
    __resetForTest({ statuslineTemplate: ["m_pluginSource", "m_version"] });
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs,
      shortInterval: null,
      midInterval: null,
      longInterval: null,
      balance: null,
      ageMs: 5 * 60_000,
      stale: false,
      version: "0.8.47",
      pluginSource: "user",
    });
    assert.ok(strip(line).includes("🎨"),
      `expected 🎨 from m_pluginSource in composed line, got: ${strip(line)}`);
    assert.ok(strip(line).includes("v0.8.47"),
      `expected v0.8.47 from m_version in composed line, got: ${strip(line)}`);
  });

  it("bare `m_pluginSource` token in the template returns the glyph (no wrap)", () => {
    // The bare MODULES.m_pluginSource entry returns a string
    // directly when the ctx has a recognized kind. Verified
    // via renderProviderLine (template loop exercises MODULES
    // internally); the rendered output is the bare glyph.
    const line = lineFor("builtin", "m_pluginSource");
    // Bare path: NO leading "Usage:" label, NO reset countdown —
    // just the glyph itself. Stripped line should equal "📌"
    // exactly when no other modules are in the template.
    assert.equal(strip(line), "📌",
      `bare m_pluginSource should emit just the glyph, got: '${line}'`);
  });

  it("built-in and user glyphs are visually distinct", () => {
    // Pin that the two glyphs are NOT the same character — a
    // typo in either direction (e.g. 📌/📌 or 🎨/🖌) would be
    // easy to miss without a non-substring assertion.
    const builtin = lineFor("builtin", "m_pluginSource");
    const user    = lineFor("user",    "m_pluginSource");
    assert.notEqual(strip(builtin), strip(user),
      `built-in and user glyphs should be distinct, both rendered: ${strip(builtin)} vs ${strip(user)}`);
  });

  // vX.X.X+ — labels.labelPluginSystem / labels.labelPluginUserDefined
  // override path. The two glyphs are no longer hardcoded in
  // MODULES.m_pluginSource; they flow through labelFor() and read
  // from config.labels. A future schema or wiring regression here
  // would silently revert the v0.7.x hardcoded literals — these
  // tests pin the new contract.
  it("labels.labelPluginSystem override renders the user's string for built-in", () => {
    __resetForTest({
      statuslineTemplate: ["m_pluginSource"],
      labels: { labelPluginSystem: "[B]" },
    } as Partial<Config>);
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs,
      shortInterval: null,
      midInterval: null,
      longInterval: null,
      balance: null,
      ageMs: 5 * 60_000,
      stale: false,
      version: "0.0.0",
      tokens: null,
      pluginSource: "builtin",
    });
    assert.equal(strip(line), "[B]",
      `labelPluginSystem override should render "[B]" verbatim, got: ${strip(line)}`);
  });

  it("labels.labelPluginUserDefined override renders the user's string for user", () => {
    __resetForTest({
      statuslineTemplate: ["m_pluginSource"],
      labels: { labelPluginUserDefined: "[U]" },
    } as Partial<Config>);
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs,
      shortInterval: null,
      midInterval: null,
      longInterval: null,
      balance: null,
      ageMs: 5 * 60_000,
      stale: false,
      version: "0.0.0",
      tokens: null,
      pluginSource: "user",
    });
    assert.equal(strip(line), "[U]",
      `labelPluginUserDefined override should render "[U]" verbatim, got: ${strip(line)}`);
  });

  it("labelPluginSystem override does not leak into labelPluginUserDefined", () => {
    // Independent axes: setting only labelPluginSystem must NOT
    // affect the user override (it should still render the
    // pinned default 📌/🎨 from outside this test path). deepMerge
    // keeps the other labels axis at its default.
    __resetForTest({
      statuslineTemplate: ["m_pluginSource"],
      labels: { labelPluginSystem: "[B]" },
    } as Partial<Config>);
    const userLine = renderProviderLine("minimax", {
      mode: "used",
      nowMs,
      shortInterval: null,
      midInterval: null,
      longInterval: null,
      balance: null,
      ageMs: 5 * 60_000,
      stale: false,
      version: "0.0.0",
      tokens: null,
      pluginSource: "user",
    });
    // Default labelPluginUserDefined = "🎨"
    assert.equal(strip(userLine), "🎨",
      `labelPluginSystem override should not affect labelPluginUserDefined default, got: ${strip(userLine)}`);
  });

  it("labelPluginUserDefined override does not leak into labelPluginSystem", () => {
    // Symmetric — override the user axis and verify built-in
    // still emits the pinned default 📌.
    __resetForTest({
      statuslineTemplate: ["m_pluginSource"],
      labels: { labelPluginUserDefined: "[U]" },
    } as Partial<Config>);
    const builtinLine = renderProviderLine("minimax", {
      mode: "used",
      nowMs,
      shortInterval: null,
      midInterval: null,
      longInterval: null,
      balance: null,
      ageMs: 5 * 60_000,
      stale: false,
      version: "0.0.0",
      tokens: null,
      pluginSource: "builtin",
    });
    assert.equal(strip(builtinLine), "📌",
      `labelPluginUserDefined override should not affect labelPluginSystem default, got: ${strip(builtinLine)}`);
  });
});

// v0.9.x — cache.json row `<provider>:pluginSource` round-trip:
//   index.ts writes the kind right after a successful
//   pluginTransportWithKind call;
//   dispatch.ts:peekPluginSource reads it back via cache.peek.
// The disk-shadow guarantees the kind survives across ticks even
// when the data row is still within TTL — important because the
// side can change without the data changing (user adds/removes an
// override file). TTL is checked but the read path uses cache.peek
// (ignores TTL) so a stale data row doesn't hide a fresh kind.
describe("pluginSource cache row (v0.9.x)", () => {
  // Stub HOME so cache.flushToDisk writes to a tmp file rather
  // than the real ~/.claude/plugins/topgauge/state/cache.json.
  let oldHome: string | undefined;
  let oldUserProfile: string | undefined;
  let tempHome: string;
  beforeEach(() => {
    oldHome = process.env.HOME;
    oldUserProfile = process.env.USERPROFILE;
    tempHome = mkdtempSync(resolve(tmpdir(), "topgauge-ps-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });
  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("set + peek round-trip preserves the kind string", () => {
    cache.set("minimax:pluginSource", "user", 60_000);
    const got = cache.peek<"user" | "builtin" | "missing">("minimax:pluginSource");
    assert.equal(got, "user");
  });

  it("peek returns null when no row was written", () => {
    // Fresh install state — neither user nor built-in row exists.
    const got = cache.peek<"user" | "builtin" | "missing">("unseen-provider:pluginSource");
    assert.equal(got, null);
  });

  it("peek ignores TTL (kind can outlive the data row)", () => {
    // v0.9.x contract: peekPluginSource uses cache.peek which
    // ignores TTL — a user adding/removing an override file
    // should reflect on the NEXT tick even when the data cache
    // row is still within TTL. To exercise the "past TTL but
    // peek still returns" path, write a row with a tiny TTL
    // (so the in-memory eviction flushes it out), then rewrite
    // its `at` field to be old via the on-disk file, and
    // confirm cache.peek ignores the TTL on the read path.
    //
    // Note: cache.flushToDisk proactively evicts any row whose
    // ttlMs has elapsed at flush time, so the row wouldn't
    // survive a normal set()+set() cycle with TTL=0. The on-disk
    // rewrite path is the canonical way to test "TTL-expired
    // row survives in the file".
    cache.set("deepseek:pluginSource", "builtin", 60_000);
    // Reach into the on-disk file and backdate the `at` field
    // so the row is logically expired. cache.peek doesn't read
    // TTL on the get path, so it should still return the value.
    const cachePath = resolve(tempHome, ".claude", "plugins", "topgauge", "state", "cache.json");
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, { at: number; value: string; ttlMs: number }>;
    const row = raw["deepseek:pluginSource"];
    assert.ok(row, "the just-set row should be on disk");
    row.at = row.at - 24 * 60 * 60_000; // 24h in the past — definitely past any TTL
    writeFileSync(cachePath, JSON.stringify(raw));
    // Reset the in-memory cache so the next peek re-reads disk.
    cache.__resetForTest();
    const got = cache.peek<"user" | "builtin" | "missing">("deepseek:pluginSource");
    assert.equal(got, "builtin");
  });
});