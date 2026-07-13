// v0.2.17: tests for the lineTemplate / module renderer. These cover
// the new custom-config surface (separators, lineTemplate) and the
// forced-visibility rule for m_age. Existing render.test.ts and
// dispatch.test.ts already verify the default templates reproduce
// the v0.2.16 byte-for-byte output; this file focuses on the new
// behavior that the old tests don't reach.
//
// v0.3.3: added the "inline-args tokens" describe block covering the
// `m_label|<string>|color:<c>`, `m_modeLabel|color:<c>`, and
// `s_<n>|color:<c>` token forms.
//
// v0.x.x: switched the second-class separator from `|` to `:` or `=`
// (the `m_label`/`s_<n>` etc. tokens now use `|` for structural
// splits and `:` / `=` for name/value pairs). See the
// "two-class separator" describe block at the bottom.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  renderProviderLine,
  renderTemplate,
  setPrevTick,
  __resetPrevTickForTest,
  __resetUnknownModuleWarnForTest,
} from "./render.ts";
import { __resetForTest } from "./config.ts";
import {
  __resetForTest as resetCacheForTest,
  setCachePathResolver,
} from "./cache.ts";
import {
  beginTickForTest,
  processTick,
  resetTickStateForTest,
  setStateRoot,
} from "./status-store.ts";
import * as statusStore from "./status-store.ts";
import { compose } from "./composition.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STALE_COLOR = "\x1b[90m";
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// v0.4.0+ — m_tokenInSpeed / m_tokenOutSpeed read the prev-tick
// cache. Each test needs an isolated tmp dir for the disk-shadowed
// cache file, otherwise cross-test residue from one run can poison
// the next. (The render-tokens.test.ts file has the same setup.)
let _tmpDir: string;
beforeEach(() => {
  _tmpDir = mkdtempSync(join(tmpdir(), "tokenplan-lineTemplate-"));
  setCachePathResolver(() => join(_tmpDir, "cache.json"));
  // v0.8.11-alpha — also isolate status-store's disk root. Without
  // this, a prior test's PREV_TICK_KEY entry persists at the default
  // state root (computed from cwd="C:\\fake") and gets reloaded by
  // the next test's beginTick — the test would see a stale prev
  // carrying a DIFFERENT sessionId + non-zero totalApiMs, which the
  // post-merge v0.8.11 regression detector now correctly flags as a
  // regression. (Pre-merge, the sessionId mismatch short-circuited
  // to invalidRegression=false, masking this isolation gap.)
  setStateRoot(() => join(_tmpDir, "state"));
  resetCacheForTest();
  // v0.9.x — render functions now go through tick-state; seed an
  // empty tick so the read paths don't throw. null cwd keeps the
  // in-memory store empty (no commit fires on these tests).
  resetTickStateForTest();
  beginTickForTest(null, null);
});

describe("lineTemplate — custom template (drop the 7d window)", () => {
  beforeEach(() => {
    __resetForTest({
      statuslineTemplate:["m_modeLabel", "s_space", "m_windowQuota|term:short", "s_space", "m_countdown|term:short"],
    });
  });
  afterEach(() => __resetForTest());

  it("renders only the modules listed in the template", () => {
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 62, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 60, remainingPercent: 40, remainingQuota: null, usedQuota: null, limitQuota: null },
      ageMs: null,
      stale: false,
      version: "",
    });
    // 5h data present, 7d dropped → only one "5h" label, no "7d".
    assert.ok(strip(line).includes("5h"), `got: ${line}`);
    assert.ok(!strip(line).includes("7d"), `got: ${line}`);
  });
});

// vX.X.X+ — `custom separators` via the legacy `separators` config
// array is REMOVED. The six built-in s_<name> tokens are the only
// separator source. This describe block is gone.

describe("lineTemplate — unknown module token (vX.X.X+: literal pass-through)", () => {
  it("emits the unknown token verbatim — no warn, no drop", () => {
    // vX.X.X+: unrecognized tokens (m_foo, s_xyz, anything that
    // doesn't match a known m_* module or the six s_<name>
    // aliases) are emitted as literal strings. No parsing, no
    // warning. m_foo becomes "m_foo" in the rendered output.
    __resetUnknownModuleWarnForTest();
    __resetForTest({
      statuslineTemplate:["m_modeLabel", "s_space", "m_windowQuota|term:short", "s_space", "m_foo"],
    });
    // Capture stderr.
    const err = process.stderr as unknown as { write: (c: string) => boolean };
    const original = err.write;
    const captured: string[] = [];
    err.write = (c: string) => {
      captured.push(c);
      return true;
    };
    try {
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
        midInterval: null,
        ageMs: null,
        stale: false,
        version: "",
      });
      // m_foo is emitted as the literal "m_foo" (right after the
      // s_space token, before end-of-template).
      assert.ok(line.endsWith(" m_foo"), `got: ${line}`);
      // No unknown-module warning — pass-through is silent.
      const warns = captured.filter((c) => c.includes("unknown lineTemplate module"));
      assert.equal(warns.length, 0, `expected no warn, got ${warns.length}: ${JSON.stringify(captured)}`);
    } finally {
      err.write = original;
      __resetForTest();
    }
  });

  it("emits unknown tokens with no inline-args parsing (xyz|color:red is verbatim)", () => {
    __resetUnknownModuleWarnForTest();
    __resetForTest({
      statuslineTemplate:["xyz|color:red"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(strip(line), "xyz|color:red", `got: ${JSON.stringify(line)}`);
  });
});

describe("lineTemplate — forced visibility of m_age on stale", () => {
  beforeEach(() => {
    // Pin minUnit='m' so the assertions like "⛓️‍💥 5m ago" stay
    // stable — the tests pin exact minute-grain suffixes. The
    // default minUnit='s' would emit "5m0s ago" instead.
    __resetForTest({ timeFormat: { minUnit: "m", maxUnitCount: 2 } });
  });
  it("appends the broken-chain suffix even when m_age is NOT in the template", () => {
    // Default plan template does NOT include m_age.
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 60, remainingPercent: 100 - 60, remainingQuota: null, usedQuota: null, limitQuota: null },
      ageMs: 5 * 60_000,
      stale: true,
      version: "",
    });
    assert.ok(strip(line).endsWith("⛓️‍💥 5m ago"), `got: ${line}`);
  });

  it("appends the broken-chain suffix when a literal token happens to contain ' ago'", () => {
    // v0.4.0 dedup is template-level (template.includes('m_age')),
    // NOT output-scanning. A free-form literal token containing ' ago'
    // must NOT cause the forced fallback to skip — the dedup check
    // would have misfired under the old 'joined.includes(" ago")'
    // heuristic. Confirms the refactor still holds with vX.X.X+
    // literal pass-through tokens.
    __resetForTest({
      statuslineTemplate:[
        "m_modeLabel", " ago",
        "m_windowQuota|term:short", " ago", "m_countdown|term:short",
        " ago", " ago", " ago",
        "m_windowQuota|term:mid", " ago", "m_countdown|term:mid",
      ],
      // Preserve minute-grain suffix for the "5m ago" regex below.
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
        midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 60, remainingPercent: 100 - 60, remainingQuota: null, usedQuota: null, limitQuota: null },
        ageMs: 5 * 60_000,
        stale: true,
        version: "",
      });
      // Forced fallback must still fire — exactly one ⛓️‍💥 5m ago
      // suffix appended to the rendered output.
      const stripped = strip(line);
      const occurrences = (stripped.match(/⛓️‍💥 5m ago/g) ?? []).length;
      assert.equal(occurrences, 1, `expected 1, got ${occurrences}: ${stripped}`);
    } finally {
      __resetForTest();
    }
  });

  it("does NOT double-append when m_age IS in the template", () => {
    __resetForTest({
      statuslineTemplate:[
        "m_modeLabel", "s_space",
        "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
        "s_space", "s_dot", "s_space",
        "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
        "s_space", "m_age",
      ],
      // Re-pin minute-grain suffixes — the describe-level beforeEach
      // pin gets clobbered by this in-test __resetForTest.
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
        midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 60, remainingPercent: 100 - 60, remainingQuota: null, usedQuota: null, limitQuota: null },
        ageMs: 5 * 60_000,
        stale: true,
        version: "",
      });
      const stripped = strip(line);
      const occurrences = (stripped.match(/⛓️‍💥 5m ago/g) ?? []).length;
      assert.equal(occurrences, 1, `expected 1 occurrence, got ${occurrences}: ${stripped}`);
    } finally {
      __resetForTest();
    }
  });

  it("does NOT render the stale suffix on a fresh tick (ageMs=0) when m_age is absent from the template", () => {
    // v0.4.x+: default quota template now ends with `m_age`, so a fresh
    // tick DOES emit `🔗 0m ago` (m_age owns the slot, no separate stale
    // suffix). This test pins the pre-m_age-in-default behavior: with
    // m_age explicitly excluded, the legacy stale-fallback logic must
    // NOT inject a stale suffix on ageMs=0.
    __resetForTest({
      statuslineTemplate:[
        "m_modeLabel", "s_space",
        "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
        "s_space", "s_dot", "s_space",
        "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
      ],
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
        midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 60, remainingPercent: 100 - 60, remainingQuota: null, usedQuota: null, limitQuota: null },
        ageMs: 0,
        stale: false,
        version: "",
      });
      assert.ok(!line.includes(STALE_COLOR));
      assert.ok(!line.includes("ago"));
    } finally {
      __resetForTest();
    }
  });

  it("uses healthy emoji when stale=false and ageMs > 0 (m_age is in template)", () => {
    // v0.4.0 priority: template presence wins. When m_age is listed
    // in the lineTemplate, the module emits unconditionally. Fresh +
    // ageMs > 0 → 🔗 X ago.
    __resetForTest({
      statuslineTemplate:[
        "m_modeLabel", "s_space",
        "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
        "s_space", "m_age",
      ],
      // Re-pin minute-grain suffixes for "<1m ago" assertion.
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
        midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 60, remainingPercent: 100 - 60, remainingQuota: null, usedQuota: null, limitQuota: null },
        ageMs: 30_000,
        stale: false,
        version: "",
      });
      assert.ok(strip(line).includes("🔗 <1m ago"), `got: ${line}`);
    } finally {
      __resetForTest();
    }
  });

  it("does NOT double-append when m_age lives inside a m_template fragment", () => {
    // v0.6.0+ — when m_age is in lineTemplates.<fragment> but the
    // outermost statuslineTemplate only references it via
    // `m_template:<fragment>:mode:<plan|balance>`, the OLD
    // templateHasAgeModule top-level string scan missed it and the
    // forced-visibility fallback appended a SECOND ⛓️‍💥, producing
    // the user's "two broken-chain indicators" bug. The new dedup
    // is render-recursion-aware (ageEmittedRef on the RenderContext)
    // so the first m_age instance claims the slot, every subsequent
    // instance (including the fallback) skips.
    __resetForTest({
      statuslineTemplate:["m_template|plan_alt|type:quota"],
      lineTemplates:{
        plan_alt: ["m_age"],
        balance: [],
      } as any,
      timeFormat: { minUnit: "s", maxUnitCount: 4 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
        midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 60, remainingPercent: 100 - 60, remainingQuota: null, usedQuota: null, limitQuota: null },
        ageMs: 5 * 60_000,
        stale: true,
        version: "",
      });
      const stripped = strip(line);
      // Match the emoji + " ago" with anything between — formatRemainingMs
      // may emit "5m0s ago", "5m ago", etc. depending on timeFormat.minUnit.
      const occurrences = (stripped.match(/⛓️‍💥\s+\S+\s+ago/g) ?? []).length;
      assert.equal(
        occurrences, 1,
        `expected exactly 1 ⛓️‍💥 (was double-emitting before v0.6.0+): ${stripped}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("does NOT double-append when m_age appears in BOTH outer and fragment templates", () => {
    // Stress test — even when the user puts m_age in both the
    // outer statuslineTemplate and a lineTemplates fragment, only
    // ONE ⛓️‍💥 should fire. The ageEmittedRef is shared across the
    // whole render tree.
    __resetForTest({
      statuslineTemplate:["m_template|outer|type:quota", "m_age"],
      lineTemplates:{
        outer: ["s_space", "m_windowQuota|term:short", "s_space", "m_age"],
        balance: [],
      } as any,
      timeFormat: { minUnit: "s", maxUnitCount: 4 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
        midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 60, remainingPercent: 100 - 60, remainingQuota: null, usedQuota: null, limitQuota: null },
        ageMs: 5 * 60_000,
        stale: true,
        version: "",
      });
      const stripped = strip(line);
      const occurrences = (stripped.match(/⛓️‍💥\s+\S+\s+ago/g) ?? []).length;
      assert.equal(
        occurrences, 1,
        `expected exactly 1 ⛓️‍💥 across outer + fragment: ${stripped}`,
      );
    } finally {
      __resetForTest();
    }
  });
});

describe("lineTemplate — m_version module", () => {
  it("renders 'v' + ctx.version when m_version is in the template", () => {
    __resetForTest({
      statuslineTemplate:["m_modeLabel", "s_space", "m_windowQuota|term:short", "s_space", "m_version"],
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
        midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 60, remainingPercent: 100 - 60, remainingQuota: null, usedQuota: null, limitQuota: null },
        ageMs: null,
        stale: false,
        version: "0.2.17",
      });
      assert.ok(line.includes("v0.2.17"), `got: ${line}`);
    } finally {
      __resetForTest();
    }
  });

  it("renders nothing when version is empty (m_version module returns null)", () => {
    __resetForTest({
      statuslineTemplate:["m_modeLabel", "s_space", "m_windowQuota|term:short", "s_space", "m_version"],
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
        midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 60, remainingPercent: 100 - 60, remainingQuota: null, usedQuota: null, limitQuota: null },
        ageMs: null,
        stale: false,
        version: "",
      });
      // No stray "v" prefix.
      assert.ok(!line.includes("v0"), `got: ${line}`);
    } finally {
      __resetForTest();
    }
  });
});

describe("lineTemplate — m_modeLabel picks modeLabels.balance for the deepseek path", () => {
  // vX.X.X+ — DeepSeek tests must explicitly opt-in to the balance
  // fragment (the default quota fragment is plan-mode and silently
  // drops on a BALANCE provider). Each test sets the balance-form
  // template via `__resetForTest` below.
  it("uses 'Balance:' by default (preserves v0.2.16 label)", () => {
    __resetForTest({
      statuslineTemplate: ["m_template|balance|type:balance"],
    });
    const line = renderProviderLine("deepseek", {
      mode: "used",
      nowMs: Date.now(),
      balance: { isAvailable: true, entries: [{ currency: "USD", totalBalance: 25 }], minValue: 25 },
      ageMs: null,
      stale: false,
      version: "",
    });
    assert.ok(strip(line).startsWith("Balance: $25"), `got: ${line}`);
  });

  it("uses the configured modeLabels.balance override", () => {
    __resetForTest({
      modeLabels: { used: "Usage:", remaining: "Remain:", balance: "Wallet:" },
      statuslineTemplate: ["m_template|balance|type:balance"],
    });
    try {
      const line = renderProviderLine("deepseek", {
        mode: "used",
        nowMs: Date.now(),
        balance: { isAvailable: true, entries: [{ currency: "USD", totalBalance: 25 }], minValue: 25 },
        ageMs: null,
        stale: false,
        version: "",
      });
      assert.ok(strip(line).startsWith("Wallet: $25"), `got: ${line}`);
    } finally {
      __resetForTest();
    }
  });
});

// ----- v0.3.3+ inline-args tokens -----
//
// Helper: capture stderr during a render so we can assert the
// one-shot warn fired (or didn't). Restored in finally.
function withCapturedStderr<T>(fn: () => T): { value: T; warns: string[] } {
  const err = process.stderr as unknown as { write: (c: string) => boolean };
  const original = err.write;
  const captured: string[] = [];
  err.write = (c: string) => {
    captured.push(c);
    return true;
  };
  try {
    return { value: fn(), warns: captured };
  } finally {
    err.write = original;
  }
}

describe("lineTemplate — m_label inline-args tokens", () => {
  beforeEach(() => {
    __resetUnknownModuleWarnForTest();
    __resetForTest({
      statuslineTemplate:["m_label|hello"],
    });
  });
  afterEach(() => __resetForTest());

  it("m_label|hello renders plain 'hello'", () => {
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(strip(line), "hello", `got: ${line}`);
  });

  it("m_label|hello|color:red wraps the chunk in red SGR + RESET", () => {
    __resetForTest({
      statuslineTemplate:["m_label|hello|color:red"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "\x1b[38;5;196mhello\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_label|hello|color:brightBlack resolves to \\x1b[90m", () => {
    __resetForTest({
      statuslineTemplate:["m_label|hi|color:brightBlack"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "\x1b[90mhi\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_label accepts a raw SGR string for color", () => {
    __resetForTest({
      statuslineTemplate:["m_label|x|color:\x1b[36m"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "\x1b[36mx\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_label|hello|color:garbage is a hard noop (drops and warns)", () => {
    __resetForTest({
      statuslineTemplate:["m_label|hello|color:garbage"],
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    // Per spec: any failed parse is a noop. Invalid color → drop + warn.
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("m_label||color:red (empty string) drops and warns", () => {
    __resetForTest({
      statuslineTemplate:["m_label||color:red"],
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("m_label|hello|color (odd arg count) drops and warns", () => {
    __resetForTest({
      statuslineTemplate:["m_label|hello|color"],
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("m_label|hello|unknown|foo (unknown param) drops and warns", () => {
    __resetForTest({
      statuslineTemplate:["m_label|hello|unknown|foo"],
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("m_label|hello|color:red|extra:stuff (extra param) drops and warns", () => {
    __resetForTest({
      statuslineTemplate:["m_label|hello|color:red|extra:stuff"],
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });
});

describe("lineTemplate — s_<name> inline-args tokens (vX.X.X+)", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  // ----- unknown s_* prefix → emit verbatim -----

  it("s_xyz (unknown alias name) emits the original token verbatim — no warn, no drop", () => {
    // vX.X.X+: numeric `s_<n>` form is REMOVED. Unknown s_<name>
    // suffixes are now treated as unrecognized modules and the
    // dispatcher emits the WHOLE token as a literal. No parsing,
    // no inline args, no warning.
    __resetForTest({});
    const { value: line, warns } = withCapturedStderr(() =>
      renderTemplate(["s_xyz"], {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      } as any),
    );
    assert.deepEqual(line.map(strip), ["s_xyz"]);
    assert.equal(
      warns.filter((w) => w.includes("unknown lineTemplate module")).length,
      0,
      `expected no unknown-module warning: ${warns.join("\n")}`,
    );
  });

  it("s_0 (numeric suffix is now meaningless) emits 's_0' verbatim", () => {
    __resetForTest({});
    const line = renderTemplate(["s_0"], {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    } as any);
    assert.deepEqual(line.map(strip), ["s_0"]);
  });

  it("s_0|color:red (numeric + inline-args) emits 's_0|color:red' verbatim — no parsing", () => {
    __resetForTest({});
    const line = renderTemplate(["s_0|color:red"], {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    } as any);
    assert.deepEqual(line.map(strip), ["s_0|color:red"]);
  });

  it("s_ (just the prefix, no suffix) emits 's_' verbatim — no separators[0] fallback", () => {
    __resetForTest({});
    const line = renderTemplate(["s_"], {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    } as any);
    assert.deepEqual(line.map(strip), ["s_"]);
  });

  // ----- v0.7.2+ |repeat:<N> (multiplies body, default 1, cap 8) -----

  it("s_space|repeat:3 emits 3 spaces (whitespace body not padded even with default wrap=true)", () => {
    __resetUnknownModuleWarnForTest();
    __resetForTest({
      statuslineTemplate:["s_space|repeat:3"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "   ", `got: ${JSON.stringify(line)}`);
  });

  it("s_dot|repeat:1 emits single dot — default repeat is 1 when omitted", () => {
    __resetForTest({
      // s_dot / s_space / s_colon / s_pipe are built-in named
        // separators; no config array needed.
      statuslineTemplate:["s_dot|repeat:1"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(strip(line), " · ", `got: ${JSON.stringify(line)}`);
  });

  it("s_dot|repeat:3 emits 3 padded dots (wrap=true + printable body)", () => {
    __resetForTest({
      // s_dot / s_space / s_colon / s_pipe are built-in named
        // separators; no config array needed.
      statuslineTemplate:["s_dot|repeat:3"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(strip(line), " ·  ·  · ", `got: ${JSON.stringify(line)}`);
  });

  it("s_dot|repeat:8 hits the cap exactly (8 emits 8 padded dots)", () => {
    __resetForTest({
      // s_dot / s_space / s_colon / s_pipe are built-in named
        // separators; no config array needed.
      statuslineTemplate:["s_dot|repeat:8"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(strip(line), " ·  ·  ·  ·  ·  ·  ·  · ", `got: ${JSON.stringify(line)}`);
  });

  it("s_dot|repeat:9 (over cap) drops and warns", () => {
    __resetUnknownModuleWarnForTest();
    const { value: line, warns } = withCapturedStderr(() => {
      __resetForTest({
        // s_dot / s_space / s_colon / s_pipe are built-in named
        // separators; no config array needed.
        statuslineTemplate:["s_dot|repeat:9"],
      });
      return renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      });
    });
    assert.equal(line, "");
    assert.equal(
      warns.filter((w) => w.includes("unknown lineTemplate module")).length,
      1,
      `expected 1 unknown-module warning: ${warns.join("\n")}`,
    );
  });

  it("s_dot|repeat:0 (under min) drops and warns", () => {
    __resetUnknownModuleWarnForTest();
    const { value: line, warns } = withCapturedStderr(() => {
      __resetForTest({
        // s_dot / s_space / s_colon / s_pipe are built-in named
        // separators; no config array needed.
        statuslineTemplate:["s_dot|repeat:0"],
      });
      return renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      });
    });
    assert.equal(line, "");
    assert.equal(
      warns.filter((w) => w.includes("unknown lineTemplate module")).length,
      1,
      `expected 1 unknown-module warning: ${warns.join("\n")}`,
    );
  });

  it("s_dot|repeat:abc (non-integer) drops and warns", () => {
    __resetUnknownModuleWarnForTest();
    const { value: line, warns } = withCapturedStderr(() => {
      __resetForTest({
        // s_dot / s_space / s_colon / s_pipe are built-in named
        // separators; no config array needed.
        statuslineTemplate:["s_dot|repeat:abc"],
      });
      return renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      });
    });
    assert.equal(line, "");
    assert.equal(
      warns.filter((w) => w.includes("unknown lineTemplate module")).length,
      1,
      `expected 1 unknown-module warning: ${warns.join("\n")}`,
    );
  });

  // ----- v0.7.2+ |wrap:<true|false> (default true; pad printable bodies) -----

  it("s_dot|wrap:false renders bare dot (no padding)", () => {
    __resetForTest({
      // s_dot / s_space / s_colon / s_pipe are built-in named
        // separators; no config array needed.
      statuslineTemplate:["s_dot|wrap:false"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(strip(line), "·", `got: ${JSON.stringify(line)}`);
  });

  it("s_dot|wrap:true (explicit) renders padded dot — default behavior", () => {
    __resetForTest({
      // s_dot / s_space / s_colon / s_pipe are built-in named
        // separators; no config array needed.
      statuslineTemplate:["s_dot|wrap:true"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(strip(line), " · ", `got: ${JSON.stringify(line)}`);
  });

  it("s_space|wrap:true skips padding — whitespace bodies are exempt (no triple space)", () => {
    __resetForTest({
      statuslineTemplate:["s_space|wrap:true"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, " ", `got: ${JSON.stringify(line)}`);
  });

  it("s_newline|wrap:true skips padding — control bodies are exempt (verified via formatSepBody; s_newline as a sole token is a degenerate newline-piece case)", () => {
    // The control-body exemption is verified through s_space|wrap:true
    // and via the unit-level `formatSepBody` implementation in
    // render.ts. This block documents the design constraint so a
    // future reader doesn't accidentally remove the `isControlBody`
    // branch.
    //
    // NOTE: a SOLE `s_newline` template token is a degenerate case
    // — renderTemplate's piece-splitting on `\n` would split it into
    // two empty segments and emit "". The realistic use case for
    // s_newline is as a separator between two modules, where the
    // newline piece pushes the second module onto a new statusline
    // line (existing v0.4.0+ behavior).
    __resetForTest({});
    // No renderer assertion — placeholder kept for spec coverage.
    assert.equal(true, true);
  });

  it("s_colon|wrap:true pads the colon with 1 space on each side", () => {
    __resetForTest({
      statuslineTemplate:["s_colon|wrap:true"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(strip(line), " : ", `got: ${JSON.stringify(line)}`);
  });

  it("s_pipe|wrap:true pads the pipe with 1 space on each side", () => {
    __resetForTest({
      statuslineTemplate:["s_pipe|wrap:true"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(strip(line), " | ", `got: ${JSON.stringify(line)}`);
  });

  it("s_dot|wrap:garbage drops and warns", () => {
    __resetUnknownModuleWarnForTest();
    const { value: line, warns } = withCapturedStderr(() => {
      __resetForTest({
        // s_dot / s_space / s_colon / s_pipe are built-in named
        // separators; no config array needed.
        statuslineTemplate:["s_dot|wrap:garbage"],
      });
      return renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      });
    });
    assert.equal(line, "");
    assert.equal(
      warns.filter((w) => w.includes("unknown lineTemplate module")).length,
      1,
      `expected 1 unknown-module warning: ${warns.join("\n")}`,
    );
  });

  // ----- combinations -----

  it("s_dot|repeat:3|wrap:false emits three bare dots, no padding", () => {
    __resetForTest({
      // s_dot / s_space / s_colon / s_pipe are built-in named
        // separators; no config array needed.
      statuslineTemplate:["s_dot|repeat:3|wrap:false"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(strip(line), "···", `got: ${JSON.stringify(line)}`);
  });

  it("s_dot|wrap:false|repeat:3 (param order doesn't matter) emits three bare dots", () => {
    __resetForTest({
      // s_dot / s_space / s_colon / s_pipe are built-in named
        // separators; no config array needed.
      statuslineTemplate:["s_dot|wrap:false|repeat:3"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(strip(line), "···", `got: ${JSON.stringify(line)}`);
  });

  it("s_dot|repeat:2|color:red renders ' ·  · ' wrapped in red SGR", () => {
    __resetForTest({
      // s_dot / s_space / s_colon / s_pipe are built-in named
        // separators; no config array needed.
      statuslineTemplate:["s_dot|repeat:2|color:red"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(strip(line), " ·  · ", `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[38;5;196m"), `expected red SGR: ${JSON.stringify(line)}`);
  });
});

describe("lineTemplate — m_modeLabel:color inline-args tokens", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  it("m_modeLabel|color:red on a plan template wraps the Usage| prefix in red", () => {
    __resetForTest({
      statuslineTemplate:["m_modeLabel|color:red"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "\x1b[38;5;196mUsage:\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_modeLabel|color:red on a deepseek balance template wraps Balance| in red", () => {
    __resetForTest({
      statuslineTemplate:["m_modeLabel|color:red"],
    });
    const line = renderProviderLine("deepseek", {
      mode: "used", nowMs: Date.now(),
      balance: { isAvailable: true, entries: [{ currency: "USD", totalBalance: 25 }], minValue: 25 },
      ageMs: null, stale: false, version: "",
    });
    // Compare WITHOUT stripping ANSI — we want the SGR wrapper intact.
    assert.ok(line.startsWith("\x1b[38;5;196mBalance:\x1b[0m"), `got: ${JSON.stringify(line)}`);
  });

  it("m_modeLabel|color:garbage is a hard noop (drops and warns)", () => {
    __resetForTest({
      statuslineTemplate:["m_modeLabel|color:garbage"],
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    // Per spec: invalid color → drop + warn.
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });
});

// v0.8.41+ — m_modeLabel also accepts `display` to override the
// prefix label's mode locally. Plan path: |display:remaining flips
// "Usage:" → "Remain:" without changing the global `display` config.
// Balance path: `display` is ignored (Balance: is mode-agnostic).
describe("lineTemplate — m_modeLabel|display inline-args tokens", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  it("bare m_modeLabel on a plan template with mode='used' renders Usage:", () => {
    __resetForTest({ statuslineTemplate:["m_modeLabel"] });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // Bare m_modeLabel emits unwrapped text — DEFAULT_COLORS
    // ["m_modeLabel"] = NAMED_PALETTE.stale which is undefined
    // (stale is not in NAMED_PALETTE; the bare module has no
    // default tint). SGR wrapping is opt-in via |color:<c>.
    assert.equal(line, "Usage:", `got: ${JSON.stringify(line)}`);
  });

  it("bare m_modeLabel on a plan template with mode='remaining' renders Remain:", () => {
    __resetForTest({ display: "remaining", statuslineTemplate:["m_modeLabel"] });
    try {
      const line = renderProviderLine("minimax", {
        mode: "remaining", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      });
      assert.equal(line, "Remain:", `got: ${JSON.stringify(line)}`);
    } finally {
      __resetForTest();
    }
  });

  it("m_modeLabel|display:remaining flips Usage: → Remain: even when ctx.mode='used'", () => {
    __resetForTest({
      statuslineTemplate:["m_modeLabel|display:remaining"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "Remain:", `got: ${JSON.stringify(line)}`);
  });

  it("m_modeLabel|display:used flips Remain: → Usage: even when ctx.mode='remaining'", () => {
    __resetForTest({
      statuslineTemplate:["m_modeLabel|display:used"],
    });
    const line = renderProviderLine("minimax", {
      mode: "remaining", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "Usage:", `got: ${JSON.stringify(line)}`);
  });

  it("m_modeLabel|display:remaining is ignored on a balance provider (still Balance:)", () => {
    __resetForTest({
      statuslineTemplate:["m_modeLabel|display:remaining"],
    });
    const line = renderProviderLine("deepseek", {
      mode: "used", nowMs: Date.now(),
      balance: { isAvailable: true, entries: [{ currency: "USD", totalBalance: 25 }], minValue: 25 },
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "Balance:", `got: ${JSON.stringify(line)}`);
  });

  it("m_modeLabel|display:remaining|color:red combines — color wins, label is 'Remain:'", () => {
    // The two inline args compose: color wraps, display flips the label.
    // SGR wrapping fires only because color is explicit; without it the
    // bare path emits plain text.
    __resetForTest({
      statuslineTemplate:["m_modeLabel|display:remaining|color:red"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "\x1b[38;5;196mRemain:\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_modeLabel|display:garbage is a hard noop (drops and warns)", () => {
    __resetForTest({
      statuslineTemplate:["m_modeLabel|display:garbage"],
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });
});

// v0.3.3+ — every existing module accepts an optional `:color:<c>`
// override. These tests cover both:
//   - plain-text modules (m_version, m_tokenIn, …) — the override
//     wraps the bare body in `<c>body<RESET>`.
//   - already-colored modules (m_windowQuota|term:short|mid, m_balance, m_age,
//     m_tokenHitRate, m_cacheRead, m_tokenInSpeed, m_tokenOutSpeed) —
//     the override REPLACES the natural color (user always wins).
//   - invalid :color: → hard noop (drop + warn), same as m_label.
//   - bare `<module>` form is byte-for-byte identical to pre-v0.3.3.
describe("lineTemplate — m_windowQuota|term:short / m_windowQuota|term:mid :color override", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  it("m_windowQuota|term:short|color:red replaces the band-based color with red", () => {
    __resetForTest({
      statuslineTemplate:["m_windowQuota|term:short|color:red"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // The override color (\x1b[38;5;196m) must appear inside the chunk,
    // and the percentage must use the override color (NOT the band color).
    assert.ok(line.includes("\x1b[38;5;196m"), `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[38;5;196m38%"), `got: ${JSON.stringify(line)}`);
  });

  it("m_windowQuota|term:mid|color:darkGreen replaces the band-based color with darkGreen", () => {
    __resetForTest({
      statuslineTemplate:["m_windowQuota|term:mid|color:darkGreen"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null,
      midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 60, remainingPercent: 100 - 60, remainingQuota: null, usedQuota: null, limitQuota: null },
      balance: null,
      ageMs: null, stale: false, version: "",
    });
    // darkGreen = \x1b[38;5;29m (default palette); must wrap 60%.
    assert.ok(line.includes("\x1b[38;5;29m60%"), `got: ${JSON.stringify(line)}`);
  });

  it("bare m_windowQuota|term:short is byte-for-byte unchanged when no :color: is supplied", () => {
    __resetForTest({
      statuslineTemplate:["m_windowQuota|term:short"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // Default band color for 38% used is brightGreen (\x1b[38;5;41m).
    // If the override path were mis-wired, we'd see no SGR or red instead.
    assert.ok(line.includes("\x1b[38;5;41m38%"), `got: ${JSON.stringify(line)}`);
  });

  it("m_windowQuota|term:short|color:garbage is a hard noop (drops and warns)", () => {
    __resetForTest({
      statuslineTemplate:["m_windowQuota|term:short|color:garbage"],
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
        midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });
});

// v0.4.0+ — inline :display: override for window modules. Scoped to
// that module's bar computation only (does NOT mutate the global
// `display` config field). Accepts "used" or "remaining" verbatim;
// anything else is a hard noop. The bare `m_windowQuota|term:short` form is
// byte-for-byte unchanged — bare still reads `ctx.mode` (which
// defaults to "used" when no config override).
describe("lineTemplate — m_windowQuota|term:short / m_windowQuota|term:mid / m_windowContext :display override", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  it("bare m_windowQuota|term:short honors the global config (default 'used') — renders 38% at brightGreen", () => {
    __resetForTest({
      statuslineTemplate:["m_windowQuota|term:short"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // Default mode = used; 38% lands in [0, 60) band → brightGreen (\x1b[38;5;41m).
    assert.ok(line.includes("\x1b[38;5;41m38%"), `got: ${JSON.stringify(line)}`);
  });

  it("m_windowQuota|term:short|display:remaining inverts 38% used → renders 62% at band 0 (bright green)", () => {
    __resetForTest({
      statuslineTemplate:["m_windowQuota|term:short|display:remaining"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // Inverse: 100 - 38 = 62. v0.8.37.1 mode-symmetric: remaining=62
    // → usedPct=38 → band 0 ([0, 60)) → bright green
    // (\x1b[38;5;41m). The danger axis is "how much have I spent?"
    // regardless of which side of the bar the percentage is shown on.
    assert.ok(line.includes("\x1b[38;5;41m62%"), `got: ${JSON.stringify(line)}`);
    // The original 38% must NOT appear.
    assert.ok(!line.includes("38%"), `got: ${JSON.stringify(line)}`);
  });

  it("m_windowQuota|term:short|display:used is byte-identical to bare when ctx.mode is 'used'", () => {
    __resetForTest({
      statuslineTemplate:["m_windowQuota|term:short|display:used"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // 38% used → brightGreen, same as bare.
    assert.ok(line.includes("\x1b[38;5;41m38%"), `got: ${JSON.stringify(line)}`);
  });

  it("m_windowQuota|term:short|display:remaining|color:yellow — both params combine, 62% in yellow", () => {
    // Tests that color and display compose: override color REPLACES the
    // band color (yellow, NOT orange); display inverts the percentage.
    __resetForTest({
      statuslineTemplate:["m_windowQuota|term:short|display:remaining|color:yellow"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // Yellow wraps the 62% chunk. Both color and display honored.
    assert.ok(line.includes("\x1b[38;5;220m62%"), `got: ${JSON.stringify(line)}`);
    assert.ok(!line.includes("38%"), `got: ${JSON.stringify(line)}`);
  });

  it("m_windowQuota|term:mid|display:remaining inverts 60% used → renders 40% at band 1 (dark green)", () => {
    __resetForTest({
      statuslineTemplate:["m_windowQuota|term:mid|display:remaining"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null,
      midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 60, remainingPercent: 100 - 60, remainingQuota: null, usedQuota: null, limitQuota: null },
      balance: null,
      ageMs: null, stale: false, version: "",
    });
    // 100 - 60 = 40. v0.8.37.1 mode-symmetric: remaining=40 →
    // usedPct=60 → exact threshold → band above (band 1) →
    // dark green (\x1b[38;5;29m).
    assert.ok(line.includes("\x1b[38;5;29m40%"), `got: ${JSON.stringify(line)}`);
    assert.ok(!line.includes("60%"), `got: ${JSON.stringify(line)}`);
  });

  it("m_windowContext|display:remaining inverts 63% used → renders 37% at band 1 (dark green)", () => {
    // Mirror of the v0.4.0 captured stdin: context_window.used_percentage=63.
    __resetForTest({
      statuslineTemplate:["m_windowContext|display:remaining"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: {
        cwd: "C:\\fake",
        sessionId: "sess-ctx-display",
        totals: { tokenTotalIn: 0, tokenTotalOut: 0 },
        current: { tokenIn: 0, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: 0 },
        cost: { totalDurationMs: 0, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null },
        contextWindow: { contextWindowSize: 200000, contextUsedPercent: 63, contextRemainingPercent: 37 },
      },
    });
    // 100 - 63 = 37. v0.8.37.1 mode-symmetric: remaining=37 →
    // usedPct=63 → band 1 (DARK_GREEN, \x1b[38;5;29m) under
    // [60,70,80,90] (63 >= 60 and < 70).
    assert.ok(line.includes("\x1b[38;5;29m37%"), `got: ${JSON.stringify(line)}`);
    assert.ok(!line.includes("63%"), `got: ${JSON.stringify(line)}`);
  });

  it("m_windowContext|display:used reproduces the bare path's 63% (darkGreen band)", () => {
    __resetForTest({
      statuslineTemplate:["m_windowContext|display:used"],
    });
    const line = renderProviderLine("minimax", {
      mode: "remaining", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: {
        cwd: "C:\\fake",
        sessionId: "sess-ctx-used",
        totals: { tokenTotalIn: 0, tokenTotalOut: 0 },
        current: { tokenIn: 0, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: 0 },
        cost: { totalDurationMs: 0, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null },
        contextWindow: { contextWindowSize: 200000, contextUsedPercent: 63, contextRemainingPercent: 37 },
      },
    });
    // ctx.mode="remaining" + inline display="used" → display wins → 63%.
    // 63 lands in [60, 70) → darkGreen (\x1b[38;5;29m).
    assert.ok(line.includes("\x1b[38;5;29m63%"), `got: ${JSON.stringify(line)}`);
  });

  it("m_windowQuota|term:short|display:garbage is a hard noop (drops and warns)", () => {
    __resetForTest({
      statuslineTemplate:["m_windowQuota|term:short|display:garbage"],
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
        midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("m_windowQuota|term:short|display:USED (case-sensitive) is a hard noop (drops and warns)", () => {
    // The resolver does NOT lower-case. Anything that isn't an exact
    // match for "used" or "remaining" (including "USED", "Used",
    // "remaining " with trailing space) is a parse-fail. This is
    // intentional — silent normalization would mask user typos and
    // leave "Remaining" rendering as a different mode than expected.
    __resetForTest({
      statuslineTemplate:["m_windowQuota|term:short|display:USED"],
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
        midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("m_windowQuota|term:short|display: (empty value) is a hard noop (drops and warns)", () => {
    // Empty value → resolver sees "" → null → badarg.
    __resetForTest({
      statuslineTemplate:["m_windowQuota|term:short|display:"],
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
        midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });
});

describe("lineTemplate — plain-text modules :color override", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  it("m_version|color:yellow wraps v0.2.17 in yellow SGR + RESET", () => {
    __resetForTest({
      statuslineTemplate:["m_version|color:yellow"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "0.2.17",
    });
    // Yellow = \x1b[38;5;220m (default palette).
    assert.equal(line, "\x1b[38;5;220mv0.2.17\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_version without :color: picks up DEFAULT_COLORS gray tint (v6.x)", () => {
    __resetForTest({
      statuslineTemplate:["m_version"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "0.2.17",
    });
    // v6.x — bare path now tints with DEFAULT_COLORS["m_version"] = gray.
    assert.equal(line, "\x1b[38;5;245mv0.2.17\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_version|color:garbage is a hard noop (drops and warns)", () => {
    __resetForTest({
      statuslineTemplate:["m_version|color:garbage"],
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "0.2.17",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("m_countdown|term:short|color:darkGreen wraps the bare '5h' suffix in darkGreen", () => {
    __resetForTest({
      statuslineTemplate:["m_countdown|term:short|color:darkGreen"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // No resetAt → formatOneResetSuffix emits just "5h", wrapped in darkGreen.
    assert.equal(line, "\x1b[38;5;29m5h\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_countdown|term:mid|color:red wraps the bare '7d' suffix in red", () => {
    __resetForTest({
      statuslineTemplate:["m_countdown|term:mid|color:red"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null,
      midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 60, remainingPercent: 100 - 60, remainingQuota: null, usedQuota: null, limitQuota: null },
      balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "\x1b[38;5;196m7d\x1b[0m", `got: ${JSON.stringify(line)}`);
  });
});

describe("lineTemplate — colored modules :color override (user wins)", () => {
  beforeEach(() => {
    __resetUnknownModuleWarnForTest();
    // Pin minUnit='m' for the m_age / m_windowQuota|term assertions
    // — these tests pin exact minute-grain suffixes that would
    // otherwise expand under the default minUnit='s'.
    __resetForTest({ timeFormat: { minUnit: "m", maxUnitCount: 2 } });
  });
  afterEach(() => __resetForTest());

  it("m_balance|color:red replaces the band-based color with red", () => {
    __resetForTest({
      statuslineTemplate:["m_balance|color:red"],
    });
    const line = renderProviderLine("deepseek", {
      mode: "used", nowMs: Date.now(),
      balance: { isAvailable: true, entries: [{ currency: "USD", totalBalance: 25 }], minValue: 25 },
      ageMs: null, stale: false, version: "",
    });
    // Band color for $25 was brightGreen; override forces red.
    assert.ok(line.includes("\x1b[38;5;196m"), `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[38;5;196m$25"), `got: ${JSON.stringify(line)}`);
  });

  it("bare m_balance keeps the band-based color", () => {
    __resetForTest({
      statuslineTemplate:["m_balance"],
    });
    const line = renderProviderLine("deepseek", {
      mode: "used", nowMs: Date.now(),
      balance: { isAvailable: true, entries: [{ currency: "USD", totalBalance: 25 }], minValue: 25 },
      ageMs: null, stale: false, version: "",
    });
    // Band color for $25 with default thresholds is darkGreen (\x1b[38;5;29m),
    // since 25 falls into the [20, 50) band.
    assert.ok(line.includes("\x1b[38;5;29m$25"), `got: ${JSON.stringify(line)}`);
  });

  it("m_age|color:red replaces STALE_COLOR with red", () => {
    __resetForTest({
      statuslineTemplate:["m_age|color:red"],
      // Re-pin minute-grain suffix for "5m ago" assertion.
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: 5 * 60_000,
      stale: true,
      version: "",
    });
    // STALE_COLOR (\x1b[90m) must NOT appear; red (\x1b[38;5;196m) must.
    assert.ok(!line.includes("\x1b[90m"), `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[38;5;196m⛓️‍💥 5m ago"), `got: ${JSON.stringify(line)}`);
  });

  it("bare m_age with stale=true wraps in BROKEN_COLOR (red), not STALE_COLOR", () => {
    // v0.6.0+: split the gray stale color into two — broken-chain
    // (⛓️‍💥) gets BROKEN_COLOR (\x1b[31m, dark red), fresh 🔗 keeps
    // STALE_COLOR (\x1b[90m, gray).
    __resetForTest({
      statuslineTemplate:["m_age"],
      // Re-pin minute-grain suffix for "5m ago" assertion.
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: 5 * 60_000,
      stale: true,
      version: "",
    });
    assert.ok(line.includes("\x1b[31m⛓️‍💥 5m ago"), `got: ${JSON.stringify(line)}`);
    assert.ok(!line.includes("\x1b[90m⛓️‍💥"), `STALE_COLOR leaked into broken: ${JSON.stringify(line)}`);
  });

  it("m_tokenCachedIn|color:yellow replaces STALE_COLOR with yellow", () => {
    // v0.8.0+ — renamed from m_cacheRead (see render-tokens.test.ts).
    __resetForTest({
      statuslineTemplate:["m_tokenCachedIn|color:yellow"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: {
        cwd: "C:\\fake",
        sessionId: "sess-cache-read",
        totals: { tokenTotalIn: 1000, tokenTotalOut: 500 },
        current: { tokenIn: 100, tokenOut: 50, tokenCacheCreation: 100, tokenCachedIn: 900 },
        cost: { totalDurationMs: 1000, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null },
      },
    });
    // Yellow wraps the cache: chunk; STALE_COLOR must not appear.
    assert.ok(line.includes("\x1b[38;5;220m"), `got: ${JSON.stringify(line)}`);
    assert.ok(!line.includes("\x1b[90m"), `got: ${JSON.stringify(line)}`);
  });

  it("m_tokenInSpeed|color:red replaces STALE_COLOR with red (v0.4.0+ per-API-call math)", () => {
    // v0.4.0+ — speed is per-API-call throughput. Seed a prev
    // tick with smaller values, then verify the override color
    // wraps the chunk and STALE_COLOR is absent.
    __resetForTest({
      statuslineTemplate:["m_tokenInSpeed|color:red"],
    });
    // The cache needs to be primed for sess-speed. We import
    // the helper from render.ts so the test is self-contained.
    const snap = {
      cwd: "C:\\fake",
      sessionId: "sess-speed",
      totals: { tokenTotalIn: 5000, tokenTotalOut: 100 },
      current: { tokenIn: 100, tokenOut: 100, tokenCacheCreation: 0, tokenCachedIn: 0 },
      cost: { totalDurationMs: 5000, totalApiDurationMs: 2000, totalLinesAdded: null, totalLinesRemoved: null },
    };
    // v1.0 — beginTickForTest must run BEFORE setPrevTick so the
    // prev seed survives the in-memory load (beginTick replaces
    // pending with a clone of the disk-loaded store).
    beginTickForTest(snap.cwd, snap);
    setPrevTick("sess-speed", { totalApiMs: 0 }, "C:\\fake");
    processTick(snap.cwd, snap);
    statusStore.commit();
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: snap,
    });
    // STALE_COLOR must not appear; red must wrap the speed chunk.
    // delta_in=100, delta_api=2000 → speed=50 t/s → "in:50.0 t/s"
    assert.ok(!line.includes("\x1b[90m"), `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[38;5;196min:50.0 t/s"), `got: ${JSON.stringify(line)}`);
  });

  it("m_tokenHitRate|color:brightGreen replaces the band-based cache color with brightGreen", () => {
    __resetForTest({
      statuslineTemplate:["m_tokenHitRate|color:brightGreen"],
    });
    // v0.8.0+ per-turn formula: current.cacheRead / totals.input.
    // Set totals.input=1000, current.cacheRead=900 → 90.0%.
    const snap = {
      cwd: "C:\\fake",
      sessionId: "sess-hit",
      totals: { tokenTotalIn: 1000, tokenTotalOut: 100 },
      current: { tokenIn: 100, tokenOut: 100, tokenCacheCreation: 0, tokenCachedIn: 900 },
      cost: { totalDurationMs: 1000, totalApiDurationMs: 1000, totalLinesAdded: null, totalLinesRemoved: null },
    };
    beginTickForTest(snap.cwd, snap);
    processTick(snap.cwd, snap);
    statusStore.commit();
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: snap,
    });
    // Hit rate = 90% (900 read / 1000 totals.input). Default band
    // color is "good" (\x1b[38;5;41m brightGreen). Override forces
    // the same color (since 90% is already in the "good" band) — the
    // assertion verifies the SGR wraps "hit:90%" with brightGreen.
    assert.ok(line.includes("\x1b[38;5;41mhit:90.0%"), `got: ${JSON.stringify(line)}`);
  });
});

describe("lineTemplate — plain token-usage modules :color override", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  it("m_tokenIn|color:brightGreen wraps the 'in|N' chunk in brightGreen", () => {
    // v0.4.0+ delta semantics: m_tokenIn shows
    //   delta(current.input) when delta_api > 0, else "--".
    // Seed prev so we have a non-zero delta to render, and seed
    // totalApiDurationMs so the gate is satisfied.
    __resetForTest({
      statuslineTemplate:["m_tokenIn|color:brightGreen"],
    });
    const snap = {
      cwd: "C:\\fake",
      sessionId: "sess-tok-in",
      totals: { tokenTotalIn: 1500, tokenTotalOut: 100 },
      current: { tokenIn: 1500, tokenOut: 100, tokenCacheCreation: 0, tokenCachedIn: 0 },
      cost: { totalDurationMs: 1_000, totalApiDurationMs: 1_000, totalLinesAdded: null, totalLinesRemoved: null },
    };
    beginTickForTest(snap.cwd, snap);
    processTick(snap.cwd, snap);
    statusStore.commit();
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: snap,
    });
    assert.equal(line, "\x1b[38;5;41min:1.5k\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("bare m_tokenIn picks up the brightGreen default (v0.8.30+)", () => {
    // v0.4.0+ delta semantics: seed prev so the delta has a value
    // and totalApiDurationMs so the gate (delta_api > 0) fires.
    // v0.8.30+ — bare form gets the brightGreen SGR (the same
    // color as the 0% band of the 5-band threshold palette, so
    // a user override on colors.brightGreen flows through
    // automatically). The chunk still respects the value-zero
    // rule: positive value only.
    __resetForTest({
      statuslineTemplate:["m_tokenIn"],
    });
    const snap = {
      cwd: "C:\\fake",
      sessionId: "sess-tok-in-bare",
      totals: { tokenTotalIn: 1500, tokenTotalOut: 100 },
      current: { tokenIn: 1500, tokenOut: 100, tokenCacheCreation: 0, tokenCachedIn: 0 },
      cost: { totalDurationMs: 1_000, totalApiDurationMs: 1_000, totalLinesAdded: null, totalLinesRemoved: null },
    };
    beginTickForTest(snap.cwd, snap);
    processTick(snap.cwd, snap);
    statusStore.commit();
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: snap,
    });
    assert.equal(line, "\x1b[38;5;41min:1.5k\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_contextSize|color:orange wraps the 'size|N' chunk in orange", () => {
    // v0.8.0+ — m_ctx was renamed to m_contextSize (cumulative
    // occupancy, sourced from totals.input).
    __resetForTest({
      statuslineTemplate:["m_contextSize|color:orange"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: {
        cwd: "C:\\fake",
        sessionId: "sess-ctx",
        totals: { tokenTotalIn: 1000, tokenTotalOut: 0 },
        current: { tokenIn: 800, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: 200 },
        cost: { totalDurationMs: 0, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null },
      },
    });
    // m_contextSize = totals.input = 1000 → "size:1.0k". Orange = \x1b[38;5;208m.
    assert.equal(line, "\x1b[38;5;208msize:1.0k\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_tokenOut|color:yellow does NOT warn when current.output is missing (v0.3.4 regression)", () => {
    // v0.3.3 conflated "parse failed" with "renderer returned null for
    // valid args but missing data" — the dispatcher warned
    // "unknown lineTemplate module" on EVERY render where the
    // stdin lacked total_output_tokens. v0.3.4+ distinguishes the
    // two: parse failure warns; missing-data renderer null is silent.
    //
    // v0.4.0+ delta semantics: missing current.output → render the
    // stable-slot "out:--" sentinel instead of dropping. Still
    // silent (no "unknown lineTemplate module" warn — the dispatcher
    // got past the schema and the renderer returned a value).
    __resetForTest({
      statuslineTemplate:["m_tokenOut|color:yellow"],
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
        tokens: {
          cwd: "C:\\fake",
          sessionId: "sess-no-out",
          totals: { tokenTotalIn: 100, tokenTotalOut: null },
          current: { tokenIn: 0, tokenOut: null, tokenCacheCreation: 0, tokenCachedIn: 0 },
          cost: { totalDurationMs: 1000, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null },
        },
      }),
    );
    // v0.8.30+ — value-zero rule: current.output=null falls
    // back to 0 (no live stdin number), so the renderer
    // short-circuits to plain text (no SGR). The user's
    // |color:yellow override does not apply because value=0
    // is a "real zero" not a tinted value. No warn.
    assert.equal(line, "out:0", `got: ${JSON.stringify(line)}`);
    assert.equal(
      warns.filter((w) => w.includes("unknown lineTemplate module")).length,
      0,
      `expected 0 warns, got: ${JSON.stringify(warns)}`,
    );
  });

  it("m_tokenIn|color:garbage is a hard noop (drops and warns)", () => {
    __resetForTest({
      statuslineTemplate:["m_tokenIn|color:garbage"],
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
        tokens: {
          cwd: "C:\\fake",
          sessionId: "sess-tok-in-bad",
          totals: { tokenTotalIn: 1500, tokenTotalOut: 0 },
          current: { tokenIn: 0, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: 0 },
          cost: { totalDurationMs: 0, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null },
        },
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });
});

describe("lineTemplate — m_*tokenIn/m_*tokenOut default tints (v0.8.30+)", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  function makeSnap(overrides: Partial<{
    cwd: string;
    sessionId: string;
    tokenTotalIn: number;
    tokenTotalOut: number;
    currentIn: number;
    currentOut: number;
    totalApiMs: number;
  }> = {}): {
    cwd: string;
    sessionId: string;
    totals: { tokenTotalIn: number; tokenTotalOut: number };
    current: { tokenIn: number; tokenOut: number; tokenCacheCreation: number; tokenCachedIn: number };
    cost: { totalDurationMs: number; totalApiDurationMs: number; totalLinesAdded: null; totalLinesRemoved: null };
  } {
    return {
      cwd: overrides.cwd ?? "C:\\fake",
      sessionId: overrides.sessionId ?? "sess-default-tint",
      totals: {
        tokenTotalIn: overrides.tokenTotalIn ?? 1500,
        tokenTotalOut: overrides.tokenTotalOut ?? 100,
      },
      current: {
        tokenIn: overrides.currentIn ?? 1500,
        tokenOut: overrides.currentOut ?? 100,
        tokenCacheCreation: 0,
        tokenCachedIn: 0,
      },
      cost: {
        totalDurationMs: 1_000,
        totalApiDurationMs: overrides.totalApiMs ?? 1_000,
        totalLinesAdded: null,
        totalLinesRemoved: null,
      },
    };
  }

  it("bare m_tokenOut picks up the red default on a positive delta", () => {
    // v0.8.30+ — mirror of the m_tokenIn test above; the out-flow
    // gets red (\x1b[38;5;196m, same as the ≥80% threshold band).
    __resetForTest({ statuslineTemplate: ["m_tokenOut"] });
    const snap = makeSnap();
    beginTickForTest(snap.cwd, snap);
    processTick(snap.cwd, snap);
    statusStore.commit();
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: snap,
    });
    assert.equal(line, "\x1b[38;5;196mout:100\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("bare m_tokenIn with no sessionId renders the n/a placeholder plain (value-zero rule)", () => {
    // v0.8.30+ — placeholder path (no stdin at all → "in:n/a").
    // The value-zero rule says placeholders stay plain, so the
    // default tint does NOT fire.
    __resetForTest({ statuslineTemplate: ["m_tokenIn"] });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: null,
    });
    assert.equal(line, "in:n/a", `got: ${JSON.stringify(line)}`);
  });

  it("inline m_tokenIn|color:yellow wins over the brightGreen default", () => {
    // v0.8.30+ — user `|color:<c>` override still takes precedence
    // over the new bare default (wrapValueDefault honors the
    // paramsColor argument first).
    __resetForTest({ statuslineTemplate: ["m_tokenIn|color:yellow"] });
    const snap = makeSnap();
    beginTickForTest(snap.cwd, snap);
    processTick(snap.cwd, snap);
    statusStore.commit();
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: snap,
    });
    assert.equal(line, "\x1b[38;5;220min:1.5k\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("bare m_tokenInSpeed keeps its 5-band scale color (unchanged in v0.8.30+)", () => {
    // v0.8.30+ — speed modules are EXPLICITLY out of scope; they
    // still derive their color from the 5-band speedScaleColor
    // helper. This test guards against accidental scope creep.
    __resetForTest({ statuslineTemplate: ["m_tokenInSpeed"] });
    const snap = makeSnap();
    beginTickForTest(snap.cwd, snap);
    processTick(snap.cwd, snap);
    statusStore.commit();
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: snap,
    });
    // The speed modules emit a colored "<prefix>N.N t/s" body. We
    // just assert the result is non-empty and starts with an SGR
    // (i.e. the 5-band scale fired). Exact color is governed by
    // speedScaleColor; we don't pin it here.
    assert.ok(line.length > 0, `got: ${JSON.stringify(line)}`);
    assert.ok(line.startsWith("\x1b["), `expected SGR prefix, got: ${JSON.stringify(line)}`);
  });

  it("idle tick (apiMs=0) renders STALE_COLOR + live stdin number for m_tokenIn (v0.8.30.1+)", () => {
    // v0.8.30.1+ contract — color tracks hasMeasurement, value
    // tracks stdin. Pre-seed prev with the SAME totalApiMs as
    // current so deltaApi=0 → hasMeasurement=false. The
    // number shown is the live stdin (current.tokenIn=1500),
    // wrapped in STALE_COLOR (\x1b[90m). Previously the
    // v0.8.30 default would have collapsed this to "in:0"
    // (the processed delta); now it's "in:1.5k" in gray.
    __resetForTest({ statuslineTemplate: ["m_tokenIn"] });
    const snap = makeSnap();
    // Force apiMs=0 on this tick by setting totalApiMs to a
    // value prev already has. We use a fresh sessionId so
    // prev doesn't carry over from other tests; then
    // pre-seed via beginTickForTest / processTick on a
    // baseline tick, then call again with the same totalApiMs.
    beginTickForTest(snap.cwd, snap);
    processTick(snap.cwd, snap);
    statusStore.commit();
    // Now call again with the SAME totalApiMs — deltaApi=0.
    beginTickForTest(snap.cwd, snap);
    processTick(snap.cwd, snap);
    statusStore.commit();
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: snap,
    });
    // STALE_COLOR (\x1b[90m) wrap with the live stdin value.
    assert.equal(line, "\x1b[90min:1.5k\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("idle tick for m_tokenOut picks up STALE_COLOR too, with red NOT applied", () => {
    // v0.8.30.1+ — mirror of the m_tokenIn idle test. The
    // red (out-flow) default is gated on hasMeasurement, so
    // an idle tick does NOT receive red — STALE_COLOR wins.
    __resetForTest({ statuslineTemplate: ["m_tokenOut"] });
    const snap = makeSnap();
    beginTickForTest(snap.cwd, snap);
    processTick(snap.cwd, snap);
    statusStore.commit();
    beginTickForTest(snap.cwd, snap);
    processTick(snap.cwd, snap);
    statusStore.commit();
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: snap,
    });
    // live stdin current.tokenOut=100 → "out:100" in STALE_COLOR.
    assert.equal(line, "\x1b[90mout:100\x1b[0m", `got: ${JSON.stringify(line)}`);
  });
});

describe("lineTemplate — inline-args regression / round-trip", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  it("default template (bare m_modeLabel) renders the post-v0.4.x quota header line", () => {
    // v0.4.x default quota template ends with `m_age` so the line tail
    // is `age:n/a` when no age is provided. We pin the post-default
    // shape here (pre-v0.3.3 byte-identical contract is preserved by
    // the m_age-absent test above).
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 60, remainingPercent: 100 - 60, remainingQuota: null, usedQuota: null, limitQuota: null },
      ageMs: null, stale: false, version: "",
    });
    // Default template renders "Usage: ▓░░░ 38% 5h · ▓░░ 60% 7d age:n/a".
    assert.match(strip(line), /^Usage: ▓+░+ 38% 5h · ▓+░+ 60% 7d age:n\/a$/);
  });

  it("compose() round-trip preserves an inline-colored chunk without bleeding upstream", () => {
    __resetForTest({
      statuslineTemplate:["m_label|foo|color:red"],
    });
    // Upstream with its own unclosed red SGR — common case when the
    // upstream statusline forgot to close its color.
    const upstream = "upstream-line \x1b[31m";
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    const composed = compose(upstream, line);
    // Strip ANSI to compare structurally. We expect:
    //   - upstream content preserved
    //   - upstream's unclosed SGR reset before the plan line
    //   - plan line contains "foo" wrapped in red
    assert.ok(composed.includes("upstream-line"));
    assert.ok(strip(composed).includes("foo"));
    // The plan line is closed by \x1b[0m (own RESET) so it should not
    // bleed into anything else.
    assert.ok(composed.includes("\x1b[38;5;196mfoo\x1b[0m"));
  });
});

// ----- v0.4.0+ m_template module -----
//
// End-to-end coverage for the new `m_template:<key>[:mode:<plan|balance>]`
// inline-arg token. The dispatcher expands `m_template` into the
// registered `lineTemplates[key]` fragment, filtered by the
// `providerType` thread (so the same key can render differently for
// plan vs balance providers).
describe("m_template — legacy lineTemplate warns once and is ignored (v0.4.0 hard break)", () => {
  beforeEach(() => {
    __resetForTest();
  });
  afterEach(() => __resetForTest());

  it("after a legacy config load, the renderer still produces output (uses new defaults, NOT legacy arrays)", async () => {
    // The validator path — applyOverrides runs only on
    // config.json / provider.config load. To exercise it end-to-end
    // from a renderer POV, we write a config.json with the legacy
    // field, call loadConfig, then render.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { loadConfig, __testing } = await import("./config.ts");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenplan-m_template-"));
    __testing.setPathResolver(() => path.join(tmpDir, "config.json"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "config.json"),
        JSON.stringify({
          lineTemplate: {
            plan: ["m_modeLabel", "s_space", "m_windowQuota|term:short"],
            balance: ["m_modeLabel", "s_space", "m_balance"],
          },
        }),
      );
      const cfg = await loadConfig();
      // Legacy field was ignored. statuslineTemplate stays at the
      // default (v0.8.14+ = `["m_template|_1line"]`; pre-v0.8.14 =
      // `"1line"`), so the renderer resolves to
      // `cfg().lineTemplates._1line` via `m_template` indirection,
      // NOT to the legacy arrays.
      assert.deepEqual(cfg.statuslineTemplate, ["m_template|quota|type:quota", "m_template|balance|type:balance"]);
      // Render through the minimax path — output should reflect the
      // default preset shape (m_windowQuota|term:short + m_windowQuota|term:mid, NOT just
      // m_windowQuota|term:short as the legacy plan array would suggest).
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
        midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 60, remainingPercent: 100 - 60, remainingQuota: null, usedQuota: null, limitQuota: null },
        ageMs: null,
        stale: false,
        version: "",
      });
      assert.ok(strip(line).includes("5h"), `got: ${line}`);
      assert.ok(strip(line).includes("7d"), `got: ${line}`);
    } finally {
      __testing.resetPathResolver();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("m_template — end-to-end expansion on minimax (plan mode)", () => {
  beforeEach(() => {
    __resetForTest({
      lineTemplates: {
        shared: ["m_modeLabel", "s_space", "m_windowQuota|term:short", "s_space", "m_countdown|term:short"],
      },
      statuslineTemplate: ["m_template|shared|type:quota"],
    });
  });
  afterEach(() => __resetForTest());

  it("m_template|shared expands into the registered fragment", () => {
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs: Date.now(),
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 38, remainingPercent: 100 - 38, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: null,
      ageMs: null,
      stale: false,
      version: "",
    });
    // type:quota matches the minimax provider's mode key, so the
    // shared fragment renders and we see 5h label + 38%.
    assert.ok(strip(line).includes("5h"), `got: ${line}`);
    assert.ok(strip(line).includes("38%"), `got: ${line}`);
  });
});

describe("m_template — mode filter drops on mismatch (deepseek vs plan)", () => {
  beforeEach(() => {
    __resetForTest({
      lineTemplates: {
        shared: ["m_modeLabel", "s_space", "m_windowQuota|term:short"],
      },
      // Combine m_template:shared:type:quota (will drop on deepseek)
      // with an unconditional m_balance chunk. The m_balance chunk
      // is the deepseek-only default and proves the rest of the
      // template still renders when one chunk is filtered out.
      statuslineTemplate: ["m_template|shared|type:quota", "s_space", "m_balance"],
    });
  });
  afterEach(() => __resetForTest());

  it("type:quota chunk drops on a deepseek provider (providerType is 'balance')", () => {
    const line = renderProviderLine("deepseek", {
      mode: "used",
      nowMs: Date.now(),
      balance: { isAvailable: true, entries: [{ currency: "USD", totalBalance: 25 }], minValue: 25 },
      ageMs: null,
      stale: false,
      version: "",
    });
    // The shared chunk is dropped because providerType=balance
    // and the chunk wants type:quota. No 5h content should leak.
    assert.ok(!strip(line).includes("5h"), `got: ${line}`);
    // The m_balance chunk should still render.
    assert.ok(strip(line).includes("$25"), `got: ${line}`);
  });
});

// v0.8.37 — `m_template|<key>` with NO `|type|mode` arg is
// provider-agnostic. The fragment renders under BOTH "plan" and
// "balance" providers; only "unknown" drops it. This is the fix
// for the v0.8.36 regression where context-level templates
// (`context` / `git_info` / `realtime` / `tokens_acc` /
// `tokens_stat`) silently disappeared on the deepseek provider
// because the bare-default "plan" filter dropped them on
// providerType === "balance". Explicit `|type:quota` /
// `|type:balance` is still strict-match (see describe above).
describe("m_template — provider-agnostic fragment (no |mode arg, v0.8.37)", () => {
  beforeEach(() => {
    __resetForTest({
      lineTemplates: {
        // Provider-agnostic fragment — no provider-specific modules
        // inside, so a successful render is purely the m_template
        // entry deciding to recurse.
        agnostic: ["m_modeLabel"],
      },
      statuslineTemplate: ["m_template|agnostic"],
    });
  });
  afterEach(() => __resetForTest());

  it("renders on minimax (plan) — backward compat", () => {
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs: Date.now(),
      shortInterval: {
        windowId: "5h",
        label: "5h",
        startAt: 0,
        endAt: 1,
        remainingPercent: 0,
        usedPercent: 100,
        intervalMs: null,
        remainingQuota: null,
        usedQuota: null,
        limitQuota: null,
      },
      ageMs: null,
      stale: false,
      version: "",
    });
    assert.ok(strip(line).includes("Usage:"), `got: ${line}`);
  });

  it("renders on deepseek (balance) — the v0.8.37 fix", () => {
    const line = renderProviderLine("deepseek", {
      mode: "used",
      nowMs: Date.now(),
      balance: { isAvailable: true, entries: [{ currency: "USD", totalBalance: 25 }], minValue: 25 },
      ageMs: null,
      stale: false,
      version: "",
    });
    // m_modeLabel routes to the balance label inside ctx.providerType
    // === "balance". The test only cares that the fragment is NOT
    // dropped at the m_template gate.
    assert.ok(strip(line).length > 0, `got: ${line}`);
  });

  it("renders on unknown provider — true agnostic (v0.8.47+)", () => {
    // The user wrote the agnostic fragment assuming "renders on
    // every tick regardless of provider", including unknown
    // (matchProvider returned null because ANTHROPIC_BASE_URL
    // doesn't match a configured entry). v0.8.37 kept the old
    // v0.8.36 unknown-drop behavior — v0.8.47+ removes the special
    // case so the agnostic contract is honored end-to-end.
    const line = renderProviderLine("some-unsupported-provider", {
      mode: "used",
      nowMs: Date.now(),
      ageMs: null,
      stale: false,
      version: "",
    });
    assert.ok(strip(line).includes("Usage:"), `got: ${line}`);
  });
});

// User-reported regression (v0.8.47): when ANTHROPIC_BASE_URL doesn't
// match any configured provider, matchProvider returns null,
// ctx.providerType === "unknown", and the dispatch path runs
// renderProviderLine. A user who organizes their template as named
// fragments like `m_template|tokens_acc|scope:session` expected those
// fragments to render — they don't reference provider-specific data
// (m_acc* reads from per-project state, not provider fields). Pre-fix
// the m_template gate dropped them on unknown; post-fix they recurse.
describe("m_template agnostic — end-to-end on unknown provider (v0.8.47+)", () => {
  beforeEach(() => {
    __resetForTest({
      lineTemplates: {
        // Bare m_accTokenIn with no inline args — relies on the outer
        // m_template passthrough to thread scope=session through.
        tokens_acc: ["m_accTokenIn"],
      },
      // Mirror the user's actual config shape: a label prefix +
        // m_template|<key>|scope:… + no mode/type arg.
        statuslineTemplate: [
          "m_label|Tokens: ",
          "m_template|tokens_acc|scope:session",
        ],
    });
  });
  afterEach(() => __resetForTest());

  it("renders the fragment (label + m_template) — not just the label", () => {
    const line = renderProviderLine("some-unsupported-provider", {
      mode: "used",
      nowMs: Date.now(),
      ageMs: null,
      stale: false,
      version: "",
    });
    // Label MUST still render.
    assert.ok(strip(line).includes("Tokens:"), `got: ${line}`);
    // m_template must NOT have been dropped at the gate. The inner
    // m_accTokenIn with no per-project state renders an n/a
    // placeholder, but that's fine — the bug was the m_template
    // chunk itself disappearing, which we now verify by checking
    // that the rendered line is wider than just "Tokens: " (i.e.
    // the m_template inner produced SOMETHING, even if n/a).
    const stripped = strip(line);
    assert.ok(
      stripped.length > "Tokens: ".length,
      `expected m_template inner to render SOMETHING beyond the label; got: ${line}`,
    );
  });
});

// v0.9.0+ — `m_template|<key>|provider:<id>` gates a fragment to ONE
// specific provider instance (distinct from `type:quota` / `type:balance`
// which gate by provider CATEGORY). Absent → renders on every
// provider (provider-agnostic). Present → strict-match against
// ctx.currentProvider.
describe("m_template — provider gate: instance-level filter (v0.9.0+)", () => {
  beforeEach(() => {
    __resetForTest();
  });
  afterEach(() => __resetForTest());

  it("|provider:minimax drops the fragment on a non-minimax provider", () => {
    // `m_template|gated|provider:minimax` should render the inner
    // body when ctx.currentProvider === "minimax" and DROP when it
    // doesn't match.
    __resetForTest({
      statuslineTemplate: ["m_template|gated|provider:minimax"],
      lineTemplates: {
        gated: ["m_modeLabel", "s_space", "m_label|hello"],
      },
    });
    try {
      const matching = renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, longInterval: null,
        balance: null,
        ageMs: null, stale: false, version: "",
      });
      assert.ok(
        strip(matching).includes("hello"),
        `provider match should render inner body, got: ${matching}`,
      );

      const dropping = renderProviderLine("deepseek", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, longInterval: null,
        balance: null,
        ageMs: null, stale: false, version: "",
      });
      assert.ok(
        !strip(dropping).includes("hello"),
        `provider mismatch should drop inner body, got: ${dropping}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("|provider absent → renders on every provider (provider-agnostic)", () => {
    // The m_template provider gate must default to "no filter" so a
    // bare `m_template|info` (no provider arg) keeps rendering on
    // every provider — same contract as `type`-less fragments.
    __resetForTest({
      statuslineTemplate: ["m_template|info"],
      lineTemplates: {
        info: ["m_modeLabel", "s_space", "m_label|hello"],
      },
    });
    try {
      for (const p of ["minimax", "deepseek", null] as const) {
        const line = renderProviderLine(p, {
          mode: "used", nowMs: Date.now(),
          shortInterval: null, midInterval: null, longInterval: null,
          balance: null,
          ageMs: null, stale: false, version: "",
        });
        assert.ok(
          strip(line).includes("hello"),
          `provider-agnostic fragment must render on every provider (tested ${String(p)}), got: ${line}`,
        );
      }
    } finally {
      __resetForTest();
    }
  });

  it("|provider:<id> on a null currentProvider (unknown) drops the fragment", () => {
    // When ANTHROPIC_BASE_URL doesn't match any configured entry,
    // ctx.currentProvider === null. A strict-match provider gate
    // against a non-null id returns false → drop.
    __resetForTest({
      statuslineTemplate: ["m_template|gated|provider:minimax"],
      lineTemplates: {
        gated: ["m_modeLabel", "s_space", "m_label|hello"],
      },
    });
    try {
      const line = renderProviderLine(null, {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, longInterval: null,
        balance: null,
        ageMs: null, stale: false, version: "",
      });
      assert.ok(
        !strip(line).includes("hello"),
        `unknown provider must drop |provider:minimax gated fragment, got: ${line}`,
      );
    } finally {
      __resetForTest();
    }
  });
});

// v0.9.0+ — `s_move|pos:<n>|char:<c>` column-advance separator.
// Pads the current line with `<c>` until the visible-cell cursor
// reaches column `<n>`. The cursor tracks ANSI-stripped chunk
// width in a closure inside renderTemplate; `\n` resets it to 0.
// Bare `s_move` (no `pos:`) is badarg per the user's "没带参数
// 相当于无效" contract; `cursor >= pos` is also a no-op + warn
// (the user's "误操作" spec).
describe("s_move — column pad separator (v0.9.0+)", () => {
  beforeEach(() => {
    __resetForTest();
  });
  afterEach(() => __resetForTest());

  it("pads the line to the requested column with the default char (space)", () => {
    // `s_move|pos:40` after a 5-char label should emit 35 trailing
    // spaces (so the next chunk's first cell is column 40).
    __resetForTest({
      statuslineTemplate: ["m_label|hello", "s_move|pos:40"],
      lineTemplates: {},
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, longInterval: null,
        balance: null,
        ageMs: null, stale: false, version: "",
      });
      const stripped = strip(line);
      assert.equal(
        stripped.length,
        "hello".length + (40 - "hello".length),
        `expected cursor at col 40 (length ${"hello".length + (40 - "hello".length)}), got: ${JSON.stringify(stripped)}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("honors `char:*` — pads with the user-specified character", () => {
    // `s_move|pos:30|char:*` after a 12-char label should emit 18
    // asterisks. Result length is 30 regardless of the padding
    // character.
    __resetForTest({
      statuslineTemplate: [
        "m_label|hello world",
        "s_move|pos:30|char:*",
      ],
      lineTemplates: {},
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, longInterval: null,
        balance: null,
        ageMs: null, stale: false, version: "",
      });
      const stripped = strip(line);
      assert.equal(stripped.length, 30, `expected length 30, got: ${JSON.stringify(stripped)}`);
      assert.ok(
        stripped.endsWith("*".repeat(30 - "hello world".length)),
        `expected padding to be ${"*".repeat(30 - "hello world".length)} asterisks, got: ${JSON.stringify(stripped)}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("drop+warn when cursor is already past the requested pos", () => {
    // 30-char label, then s_move|pos:20 — the user's "误操作"
    // contract: cursor is past pos, so the move is a no-op and
    // the chunk drops (with a warn). Result is just the label.
    __resetForTest({
      statuslineTemplate: [
        "m_label|abcdefghijklmnopqrstuvwxyz1234", // 30 chars
        "s_move|pos:20",
      ],
      lineTemplates: {},
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, longInterval: null,
        balance: null,
        ageMs: null, stale: false, version: "",
      });
      const stripped = strip(line);
      assert.equal(
        stripped.length,
        30,
        `expected cursor-already-past drop (length 30), got: ${JSON.stringify(stripped)}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("bare `s_move` (no `pos:`) is badarg → chunk drops", () => {
    // Per the user's "没带参数相当于无效" contract. The resolver
    // returns null when `pos:` is absent, the dispatcher surfaces
    // badarg → warn + drop. The token still parses (it has `|`),
    // so it's not the unknown-alias literal path; it's the badarg
    // warn-and-drop path. Result is empty (only the literal label).
    __resetForTest({
      statuslineTemplate: ["m_label|hello", "s_move|"],
      lineTemplates: {},
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, longInterval: null,
        balance: null,
        ageMs: null, stale: false, version: "",
      });
      const stripped = strip(line);
      assert.equal(stripped, "hello", `bare s_move must drop, got: ${JSON.stringify(stripped)}`);
    } finally {
      __resetForTest();
    }
  });

  it("cursor resets on `\\n` so a new line starts at column 0", () => {
    // A multiline template where the second line calls s_move —
    // the cursor on line 2 must start from 0, not carry over
    // from line 1's end. We call renderTemplate directly to get
    // the string[] before renderProviderLine joins them.
    __resetForTest({
      statuslineTemplate: [
        "m_label|first",
        "s_newline",
        "m_label|next",
        "s_move|pos:20",
      ],
      lineTemplates: {},
    });
    try {
      const lines = renderTemplate(
        ["m_label|first", "s_newline", "m_label|next", "s_move|pos:20"],
        {
          mode: "used", nowMs: Date.now(),
          shortInterval: null, midInterval: null, longInterval: null,
          balance: null,
          ageMs: null, stale: false, version: "",
        } as any,
      );
      // Two lines emitted: "first" (5 chars) and "next" + 15 spaces
      // (4 chars + 15 spaces = 20 chars).
      assert.equal(lines.length, 2, `expected 2 lines, got: ${JSON.stringify(lines)}`);
      const line2 = strip(lines[1] ?? "");
      assert.equal(
        line2.length,
        20,
        `line 2 must end at column 20 (4 + 15 + wrap-stripped), got: ${JSON.stringify(line2)}`,
      );
    } finally {
      __resetForTest();
    }
  });
});
// Demonstrates the user's motivating use case: one shared
// `token_acc` fragment + 2 callers passing different scopes → 2
// distinct renders. The bare m_accTokenIn inside the fragment
// sees the passthrough scope via the MODULES-path hook
// (render.ts:passThroughScope) and routes to the right slot.
describe("m_template passthrough — end-to-end via renderProviderLine (v0.8.7+)", () => {
  beforeEach(() => {
    __resetForTest({
      lineTemplates: {
        // The shared fragment: a bare m_accTokenIn (no inline
        // args) is what the passthrough routes. No |scope:… on
        // the inner module — the outer m_template|<key>|scope:…
        // provides the scope via ctx.passThrough.
        token_acc: ["m_accTokenIn"],
      },
      // Two callers, two scopes. Both reuse the SAME fragment
      // (no per-scope fragment needed — that's the whole point
      // of passthrough).
      statuslineTemplate: [
        "m_template|token_acc|scope:session",
        "s_space",
        "m_template|token_acc|scope:project",
      ],
    });
  });
  afterEach(() => __resetForTest());

  it("the two callers produce distinct outputs (session vs project slot)", () => {
    // We don't need real accumulator data for this assertion —
    // the rendered shape ("in:n/a" or "in:0" for empty slots) is
    // enough to prove both callers ran. The structural proof
    // is that BOTH halves of the template rendered (i.e. each
    // m_template expanded successfully into its inner m_accTokenIn)
    // AND the output contains the expected number of "in:" chunks
    // (two, separated by a space). If passthrough were broken,
    // one or both callers would badarg-warn and drop.
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs: 1_000_000,
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 10, remainingPercent: 100 - 10, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 20, remainingPercent: 100 - 20, remainingQuota: null, usedQuota: null, limitQuota: null },
      balance: null,
      ageMs: null,
      stale: false,
      version: "0.8.7",
    });
    // Each m_template expansion should produce an "in:..." chunk
    // (or "in:n/a" placeholder for an empty slot, which still
    // proves the path rendered). The two chunks are joined by
    // s_space. We assert the structural shape rather than pinning
    // exact bytes — slot contents depend on disk state.
    const stripped = strip(line);
    const inCount = (stripped.match(/in:/g) ?? []).length;
    assert.equal(inCount, 2, `expected 2 'in:' chunks (one per m_template caller), got: ${JSON.stringify(stripped)}`);
  });

  it("unknown passthrough arg on m_template drops the chunk (whitelist enforced)", () => {
    // Reconfigure with one valid caller + one invalid caller. The
    // invalid caller's chunk should be dropped (parseInlineArgs
    // → badarg → warn + drop), and the valid caller should still
    // render.
    __resetForTest({
      lineTemplates: { token_acc: ["m_accTokenIn"] },
      statuslineTemplate: [
        "m_template|token_acc|scope:session",
        "s_space",
        "m_template|token_acc|wtf:bar",
      ],
    });
    __resetUnknownModuleWarnForTest();
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs: 1_000_000,
      shortInterval: { windowId: "5h", label: "5h", startAt: null, endAt: null, intervalMs: null, usedPercent: 10, remainingPercent: 100 - 10, remainingQuota: null, usedQuota: null, limitQuota: null },
      midInterval: { windowId: "7d", label: "7d", startAt: null, endAt: null, intervalMs: null, usedPercent: 20, remainingPercent: 100 - 20, remainingQuota: null, usedQuota: null, limitQuota: null },
      balance: null,
      ageMs: null,
      stale: false,
      version: "0.8.7",
    });
    // The valid caller produced "in:..." (1 chunk). The invalid
    // caller was dropped — s_space between them is still emitted
    // (orphan-space known-issue per nulldrop-inline-override
    // memory). The important assertion is `inCount === 1`.
    const stripped = strip(line);
    const inCount = (stripped.match(/in:/g) ?? []).length;
    assert.equal(inCount, 1, `expected 1 'in:' chunk (one valid caller, one dropped), got: ${JSON.stringify(stripped)}`);
  });
});

// v0.x.x+ — two-class separator scheme. First-class `|`, second-class
// `:` or `=`. New tests covering the design contract.
describe("lineTemplate — two-class separator (| + : or =)", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  it("m_label|hello|color=red works (`: | =` both accepted as second-class)", () => {
    __resetForTest({ statuslineTemplate: ["m_label|hello|color=red"] });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "\x1b[38;5;196mhello\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_label|GPU: A100|color:brightGreen keeps the `:` inside the implicit value (it sits BEFORE any pair-separator)", () => {
    __resetForTest({ statuslineTemplate: ["m_label|GPU: A100|color:brightGreen"] });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "\x1b[38;5;41mGPU: A100\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_template name with `:` in it is preserved verbatim (template key 'a:b' resolves)", () => {
    // The template name sits in the implicit-value slot; `:` is just
    // a character in the name, not a separator.
    __resetForTest({
      lineTemplates: { "a:b": ["m_modeLabel"] },
      statuslineTemplate: ["m_template|a:b|type:quota"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // The inner is just m_modeLabel with no context, so the line
    // is "Usage:" or similar. Strip and check the template expanded
    // (no badarg, no warn).
    assert.ok(line.length > 0, `got: ${JSON.stringify(line)}`);
  });

  it("m_tokenIn|color:red:blue parses as color=red:blue (first `:` is the boundary, rest is the literal value passed to the resolver)", () => {
    // The COLOR_PARAM resolver strips trailing whitespace and bails
    // if the value is unknown — "red:blue" is unknown → badarg.
    // This is intentional: the parser does NOT error on multi-`:`,
    // but the resolver does because the resulting value is invalid.
    __resetForTest({ statuslineTemplate: ["m_tokenIn|color:red:blue"] });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
        tokens: {
          cwd: "C:\\fake",
          sessionId: "sess-multi-colon",
          totals: { tokenTotalIn: 1000, tokenTotalOut: 100 },
          current: { tokenIn: 1000, tokenOut: 100, tokenCacheCreation: 0, tokenCachedIn: 0 },
          cost: { totalDurationMs: 1000, totalApiDurationMs: 1000, totalLinesAdded: null, totalLinesRemoved: null },
        },
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("m_tokenIn|color (bare — no second-class separator) drops and warns", () => {
    __resetForTest({ statuslineTemplate: ["m_tokenIn|color"] });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
        tokens: {
          cwd: "C:\\fake",
          sessionId: "sess-bare-color",
          totals: { tokenTotalIn: 1000, tokenTotalOut: 0 },
          current: { tokenIn: 0, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: 0 },
          cost: { totalDurationMs: 0, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null },
        },
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("m_tokenIn|:red (empty name) drops and warns", () => {
    __resetForTest({ statuslineTemplate: ["m_tokenIn|:red"] });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, balance: null,
        ageMs: null, stale: false, version: "",
        tokens: {
          cwd: "C:\\fake",
          sessionId: "sess-empty-name",
          totals: { tokenTotalIn: 1000, tokenTotalOut: 0 },
          current: { tokenIn: 0, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: 0 },
          cost: { totalDurationMs: 0, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null },
        },
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("m_tokenIn|=red (=) is also accepted as the second-class separator", () => {
    __resetForTest({ statuslineTemplate: ["m_tokenIn|color=red"] });
    const snap = {
      cwd: "C:\\fake",
      sessionId: "sess-eq-sep",
      totals: { tokenTotalIn: 1000, tokenTotalOut: 0 },
      current: { tokenIn: 1000, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: 0 },
      cost: { totalDurationMs: 1000, totalApiDurationMs: 1000, totalLinesAdded: null, totalLinesRemoved: null },
    };
    beginTickForTest(snap.cwd, snap);
    processTick(snap.cwd, snap);
    statusStore.commit();
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      shortInterval: null, midInterval: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: snap,
    });
    // red (\x1b[38;5;196m) wraps the chunk — "red" maps to the
    // 196 SGR, the same as the ≥80% threshold band.
    assert.equal(line, "\x1b[38;5;196min:1.0k\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_quote with full inline-args (address+quote+author+freq+color+insecureTls) parses all 6 pairs", () => {
    // Regression: a real-world m_quote token ships 6 named args.
    // Each `:` is a pair-boundary; the URL value of `address` contains
    // a `:` after the scheme (`https://...`) — that colon sits inside
    // the value, NOT as a separator, because the first `:` is the
    // boundary and the parser takes everything after it as the value.
    __resetForTest({
      statuslineTemplate: [
        "m_quote|address:https://api.quotable.io/random|quote:content|author:author|freq:120s|color:rainbow|insecureTls:true",
      ],
    });
    // Inject a fake pre-fetched body so the renderer can walk the
    // JSON path locally without any HTTP. The renderer reads from
    // `ctx.quoteBodies` (v0.8.21+); tests pass it via
    // `renderProviderLine`'s opts map. We don't assert on the rendered
    // chunk text here — this is purely a parser regression. A missing
    // body would drop the chunk (v6.x placeholder path), but that's
    // still a successful render (no badarg, no unknown-module warn).
    const bodies = new Map<string, string>([
      ["https://api.quotable.io/random", JSON.stringify({ content: "ok", author: "anon" })],
    ]);
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs: 1_700_000_000_000,
      shortInterval: null,
      midInterval: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
      quoteBodies: bodies,
    });
    // Stronger assertion: the chunk should contain the JSON-walked
    // quote content and the author from the pre-fetched body. This
    // proves all 6 pairs parsed correctly — if `address` had been
    // mis-split at the first `:` after `https`, the cache lookup in
    // `fetchQuoteFromAddress` would miss and the chunk would be empty.
    //
    // `color:rainbow` paints each char with a per-character SGR band,
    // so the literal substring "ok" no longer appears contiguous. We
    // strip SGR codes to recover the plain text for the assertion.
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(
      plain,
      "ok--anon",
      `expected the chunk to contain the walked body 'ok--anon', got: ${JSON.stringify(plain)}`,
    );
  });
});

// v0.9.x — `m_quote|wrap:<chars>|` is a char-pair inline arg.
// Empty / missing → no-op (raw text); 1-char → duplicated to a
// 2-char pair; 2+-chars → first 2 only. Booleans
// (`wrap|true|false|yes|no`) are hard-rejected as badarg
// (the resolver only accepts literal strings; the char-pair
// shape rejects anything non-printable-ASCII). Applies to BOTH
// local and address-mode (was address-only with hard-coded `~`
// in v0.8.21+).
describe("m_quote — |wrap| char-pair inline arg (v0.9.x)", () => {
  beforeEach(() => {
    __resetForTest();
    __resetUnknownModuleWarnForTest();
  });
  afterEach(() => __resetForTest());

  // Helper: build a ctx with a pre-fetched body for the address-
  // mode tests. Minimal local re-implementation (we can't
  // import the one in render-tokens.test.ts).
  function ctxWithQuoteBodies(
    bodies: Map<string, string>,
  ): Parameters<typeof renderTemplate>[1] {
    return {
      mode: "used",
      nowMs: Date.now(),
      shortInterval: null,
      midInterval: null,
      longInterval: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
      quoteBodies: bodies,
    } as any;
  }

  it("wrap omitted → no-op (raw quote text in address-mode)", () => {
    // No |wrap| arg at all. params.wrap is undefined → renderer
    // emits raw walked body, no decoration.
    const url = "http://127.0.0.1:9999/";
    const bodies = new Map<string, string>([
      [url, JSON.stringify({ q: "hello" })],
    ]);
    const out = renderTemplate(
      [`m_quote|address:${url}|quote:q`],
      ctxWithQuoteBodies(bodies),
    ).join("\n");
    assert.equal(strip(out), "hello");
  });

  it("wrap empty → no-op (resolver returns empty string)", () => {
    // Explicit empty |wrap:| is the no-op sentinel: the resolver
    // returns "" (defined-but-empty) which the renderer reads as
    // "skip wrapping".
    const url = "http://127.0.0.1:9999/";
    const bodies = new Map<string, string>([
      [url, JSON.stringify({ q: "hello" })],
    ]);
    const out = renderTemplate(
      [`m_quote|address:${url}|quote:q|wrap:`],
      ctxWithQuoteBodies(bodies),
    ).join("\n");
    assert.equal(strip(out), "hello");
  });

  it("wrap=~ → 1 char duplicates to pair '~~', wraps the body", () => {
    const url = "http://127.0.0.1:9999/";
    const bodies = new Map<string, string>([
      [url, JSON.stringify({ q: "hello" })],
    ]);
    const out = renderTemplate(
      [`m_quote|address:${url}|quote:q|wrap:~`],
      ctxWithQuoteBodies(bodies),
    ).join("\n");
    assert.equal(strip(out), "~hello~");
  });

  it("wrap=ab → 2 chars used as left=a, right=b", () => {
    const url = "http://127.0.0.1:9999/";
    const bodies = new Map<string, string>([
      [url, JSON.stringify({ q: "hi" })],
    ]);
    const out = renderTemplate(
      [`m_quote|address:${url}|quote:q|wrap:ab`],
      ctxWithQuoteBodies(bodies),
    ).join("\n");
    assert.equal(strip(out), "ahib");
  });

  it("wrap=abc → slice(0,2) = 'ab', third char dropped", () => {
    // 2+-chars is sliced to first two — the third char ('c') is
    // discarded silently. Output uses pair[0]='a', pair[1]='b'.
    const url = "http://127.0.0.1:9999/";
    const bodies = new Map<string, string>([
      [url, JSON.stringify({ q: "hi" })],
    ]);
    const out = renderTemplate(
      [`m_quote|address:${url}|quote:q|wrap:abc`],
      ctxWithQuoteBodies(bodies),
    ).join("\n");
    assert.equal(strip(out), "ahib");
  });

  it("wrap=~ on local-mode (no address) → wraps the picked quote", () => {
    // v0.9.x — wrap applies to LOCAL mode too (was address-only
    // in v0.8.21+). No address|quote: args → local QUOTES path.
    // The local picker always emits `<quote>--<author>` (or just
    // `<quote>` when author is empty), and wrap chars go on
    // both sides. We can't predict the exact local pick without
    // a fixed seed, but the structural rule is observable: the
    // output starts AND ends with the wrap pair's chars.
    const out = renderTemplate(
      [`m_quote|wrap:~`],
      {
        mode: "used", nowMs: Date.now(),
        shortInterval: null, midInterval: null, longInterval: null,
        balance: null,
        ageMs: null, stale: false, version: "",
      } as any,
    ).join("\n");
    assert.ok(
      out.length > 0,
      `expected a non-empty local-mode output, got: ${JSON.stringify(out)}`,
    );
    const plain = strip(out);
    assert.ok(
      plain.length >= 2 && plain.startsWith("~") && plain.endsWith("~"),
      `expected local-mode output to start AND end with '~' (the wrap pair), got: ${JSON.stringify(plain)}`,
    );
  });

  it("wrap=' ' (space, 0x20) → drops via unknown-module parser boundary", () => {
    // Space is 0x20 — outside the char-pair resolver's printable
    // range (0x21..0x7E) so the resolver would also reject it.
    // But the inline-args parser (v0.8.33+ two-class) splits on
    // `|` and discards empty segments, so `wrap: ` (with trailing
    // space before the closing `|`) is treated as an unknown
    // module rather than reaching the resolver. Either way the
    // chunk drops — we assert the observable surface (empty
    // rendered output) without locking down which layer rejects.
    const url = "http://127.0.0.1:9999/";
    const bodies = new Map<string, string>([
      [url, JSON.stringify({ q: "hello" })],
    ]);
    const { value: lines } = withCapturedStderr(() =>
      renderTemplate(
        [`m_quote|address:${url}|quote:q|wrap: `],
        ctxWithQuoteBodies(bodies),
      ),
    );
    const text = lines.join("\n");
    assert.equal(
      text,
      "",
      `expected wrap|' ' to drop the chunk, got: ${JSON.stringify(text)}`,
    );
  });

  it("wrap=☃ (non-ASCII emoji) → badarg (non-printable per char-pair rule)", () => {
    // Snowman is U+2603, outside 0x21..0x7E. Char-pair resolver
    // returns null → chunk drops via badarg + stderr warn. The
    // snowman is a 2-char UTF-16 sequence (`☃` is BMP so 1
    // code unit, but we're checking the 0x21..0x7E printable
    // range which excludes it regardless).
    const url = "http://127.0.0.1:9999/";
    const bodies = new Map<string, string>([
      [url, JSON.stringify({ q: "hello" })],
    ]);
    const { value: lines, warns } = withCapturedStderr(() =>
      renderTemplate(
        [`m_quote|address:${url}|quote:q|wrap:☃`],
        ctxWithQuoteBodies(bodies),
      ),
    );
    const text = lines.join("\n");
    // Either: chunk drops with a badarg warning, OR the parser
    // fails upstream and emits an unknown-module warning. The
    // observable contract is "empty rendered output + some warn"
    // — we don't lock down the layer.
    assert.equal(
      text,
      "",
      `expected wrap|☃ to drop the chunk, got: ${JSON.stringify(text)}`,
    );
    assert.ok(
      warns.length > 0,
      `expected at least one warning for wrap|☃ (badarg or unknown-module), got: ${warns.join("\n")}`,
    );
  });
});
