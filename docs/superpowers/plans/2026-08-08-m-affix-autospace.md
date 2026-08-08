# m_* prefix/suffix 自动空格 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `|prefix:|` / `|suffix:|` inline params to every `m_*` module (except `m_label`/`m_template`) plus global `prefixSpace` (default true) / `suffixSpace` (default false) toggles, so templates can drop their explicit `s_space` tokens while keeping full per-position control.

**Architecture:** `parseInlineArgs` gains a global allowlist for `prefix`/`suffix` (gated by the schema key so separators and `m_label`/`m_template` still reject them). `expandInlineToken` threads the parsed affix out on `InlineResult`. `renderTemplate` applies a single `applyAffix()` wrapper to every `m_*` module chunk, governed by three render-side rules (R1 line-start suppress, R2 trailing-whitespace suppress, R3 token-adjacency) plus a symmetric lookahead rule for the auto-suffix.

**Tech Stack:** TypeScript, node:test (no framework), esbuild bundle.

## Global Constraints

- No version bump; `vX.X.X+` markers in comments.
- `prefixSpace` default `true`, `suffixSpace` default `false`.
- Explicit `|prefix:|` / `|suffix:|` always wins over the global default (empty value = explicit "off").
- Affix params accepted on ALL `m_*` modules EXCEPT `m_label` and `m_template` (those reject → badarg + warn + drop).
- Affix renders OUTSIDE the color span (prefix precedes the first SGR, suffix follows the reset).
- Auto-prefix fires only when R3 (prev token is an `m_*` module) AND R1 (line non-empty) AND R2 (visible line doesn't already end in whitespace).
- Auto-suffix fires only when the next token starts with `m_` (lookahead).
- Built-in fragments/presets must render byte-identically under default `prefixSpace=true` (regression guard).
- Per user git policy (`git-commit-policy` memory): do NOT auto-commit per step; batch commits at task-switch points only. Commit steps below are placeholders for the switch-point batch.
- Spec: `docs/superpowers/specs/2026-08-08-m-affix-autospace-design.md`.

## File Structure

- `src/config.ts` — Config type + DEFAULT_CONFIG + applyOverrides: add `prefixSpace` / `suffixSpace`.
- `src/config.test.ts` — config field tests.
- `src/render.ts` — `parseInlineArgs` (key param + allowlist), `InlineResult` (affix field), `expandInlineToken` (thread affix), `applyAffix` + `stripSgrCodes` helpers, `renderTemplate` loop (isModule/prevIsModule/prevEndsWs tracking + affix application).
- `src/render-affix.test.ts` — NEW: per-rule tests + byte-identity sweep.
- `docs/superpowers/specs/2026-08-08-m-affix-autospace-design.md` — already written.

---

### Task 1: Config plumbing (`prefixSpace` / `suffixSpace`)

**Files:**
- Modify: `src/config.ts` (Config interface near line 401; DEFAULT_CONFIG near line 545; applyOverrides near line 1393)
- Test: `src/config.test.ts`

**Interfaces:**
- Produces: `Config.prefixSpace: boolean`, `Config.suffixSpace: boolean`. DEFAULT_CONFIG values `prefixSpace: true`, `suffixSpace: false`. `applyOverrides` validates both as booleans (invalid → `warn` + default). Read via `cfg().prefixSpace` / `cfg().suffixSpace`.

- [ ] **Step 1: Write the failing config tests**

Append a new `describe` block to `src/config.test.ts` (uses the existing `dir` / `writeFileSync` / `loadConfig` setup already in that file):

```ts
describe("m_* auto-space affix toggles (vX.X.X+)", () => {
  it("defaults: prefixSpace=true, suffixSpace=false", async () => {
    const cfg = await loadConfig();
    assert.equal(cfg.prefixSpace, true);
    assert.equal(cfg.suffixSpace, false);
  });

  it("config.json overrides are applied", async () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ prefixSpace: false, suffixSpace: true }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.prefixSpace, false);
    assert.equal(cfg.suffixSpace, true);
  });

  it("non-boolean prefixSpace warns and falls back to default", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ prefixSpace: "yes" }));
    const cfg = await loadConfig();
    assert.equal(cfg.prefixSpace, true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/config.test.ts`
Expected: FAIL — `cfg.prefixSpace` is `undefined` (field doesn't exist on Config yet).

- [ ] **Step 3: Add the fields to the Config interface**

In `src/config.ts`, immediately after the `timeFormat: TimeFormat;` line (~401), insert:

```ts
  // vX.X.X+ — m_* auto-space affix toggles. prefixSpace (default
  // true) auto-prepends a space before each module per R1/R2/R3;
  // suffixSpace (default false) auto-appends a space before a
  // following module. Explicit |prefix:| / |suffix:| overrides the
  // global default per module.
  prefixSpace: boolean;
  suffixSpace: boolean;
```

- [ ] **Step 4: Add the defaults to DEFAULT_CONFIG**

Immediately after the `timeFormat: DEFAULT_TIME_FORMAT,` line (~545), insert:

```ts
  prefixSpace: true,
  suffixSpace: false,
```

- [ ] **Step 5: Add applyOverrides validation**

In `src/config.ts`, immediately after the `timeFormat` validation block (~1393), insert:

```ts
  // vX.X.X+ — auto-space affix toggles. Non-boolean → warn + default.
  if ("prefixSpace" in raw) {
    if (typeof raw.prefixSpace === "boolean") out.prefixSpace = raw.prefixSpace;
    else warn("prefixSpace must be a boolean; using default");
  }
  if ("suffixSpace" in raw) {
    if (typeof raw.suffixSpace === "boolean") out.suffixSpace = raw.suffixSpace;
    else warn("suffixSpace must be a boolean; using default");
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx tsx --test src/config.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + full-suite sanity**

Run: `npm run typecheck && npm test`
Expected: both green (the new defaults are read-only; no existing test renders differently yet because the renderer hasn't been changed).

- [ ] **Step 8: Commit (switch-point batch per git policy)**

---

### Task 2: Render core — affix parse + application + per-rule tests

**Files:**
- Modify: `src/render.ts` (`parseInlineArgs` ~7384, `expandInlineToken` ~7443, `InlineResult` ~7439, add helpers + `renderTemplate` loop ~7458)
- Test: `src/render-affix.test.ts` (NEW)

**Interfaces:**
- Consumes: `Config.prefixSpace`, `Config.suffixSpace` (Task 1).
- Produces:
  - `parseInlineArgs(remainder, schema, key?)` — third optional `key` param gates the affix allowlist.
  - `type InlineResult = { kind: "ok"; value: string | null; affix?: { prefix?: string; suffix?: string } } | { kind: "badarg" }`
  - `applyAffix(piece, explicit, state)` — returns the affixed chunk (see code below).
  - `stripSgrCodes(s)` — ANSI-SGR strip helper.

- [ ] **Step 1: Write the failing per-rule tests**

Create `src/render-affix.test.ts`:

```ts
// vX.X.X+ — m_* prefix/suffix auto-space tests. Spec:
// docs/superpowers/specs/2026-08-08-m-affix-autospace-design.md
// prefixSpace (default true) auto-prepends a space before each m_*
// module (except m_label / m_template) per R1/R2/R3; suffixSpace
// (default false) auto-appends before a following module. Explicit
// |prefix:| / |suffix:| always overrides the global default.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderProviderLine, renderTemplate } from "./render.ts";
import { __resetForTest } from "./config.ts";
import {
  DEFAULT_LINE_TEMPLATES,
  DEFAULT_STATUSLINE_PRESETS,
} from "./config.template.ts";
import { setCachePathResolver, resetCacheForTest } from "./cache.ts";
import { setStateRoot } from "./status-store.ts";
import { resetTickStateForTest, beginTickForTest } from "./tick-state.ts";
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

  it("explicit |prefix:\" · \"| renders the dot idiom in one token", () => {
    assert.equal(
      strip(line(["m_version", "m_version|prefix:\" · \""])),
      "v0.0.0 · v0.0.0",
    );
  });

  it("explicit |suffix:| appends after the module", () => {
    assert.equal(strip(line(["m_version|suffix:/", "m_model"])), "v0.0.0/MiniMax-M3");
  });

  it("prefix/suffix render OUTSIDE the color span", () => {
    const raw = line(["m_version|color:red|prefix:\" · \""]);
    assert.ok(raw.includes(" · \x1b[31m"), `prefix must precede color: ${JSON.stringify(raw)}`);
  });

  it("m_label rejects prefix/suffix (badarg → warn + drop)", () => {
    assert.equal(strip(line(["m_label|Context: |prefix:x"])), "");
  });

  it("m_template rejects prefix/suffix (badarg → warn + drop)", () => {
    assert.equal(strip(line(["m_template|information|suffix:x"])), "");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/render-affix.test.ts`
Expected: FAIL — adjacent-module tests glue (`v0.0.0MiniMax-M3`), `|prefix:` tokens badarg-drop.

- [ ] **Step 3: Change `InlineResult` + `parseInlineArgs` + `expandInlineToken`**

In `src/render.ts`:

1. Extend the `InlineResult` type (~7439) to carry the parsed affix:

```ts
type InlineResult =
  | { kind: "ok"; value: string | null; affix?: { prefix?: string; suffix?: string } }
  | { kind: "badarg" };
```

2. Add the `key` param and affix allowlist to `parseInlineArgs` (replace the whole function at ~7384):

```ts
function parseInlineArgs(
  remainder: string,
  schema: InlineSchema,
  key?: string,
): Record<string, ResolvedValue> | null {
  if (remainder === "") {
    return schema.implicit ? null : {};
  }
  const parts = remainder.split("|");

  let out: Record<string, ResolvedValue> = {};
  let i = 0;

  if (schema.implicit) {
    const v = parts[0]!;
    const r = schema.implicit.resolver(v);
    if (r === null) return null;
    out[schema.implicit.name] = r;
    i = 1;
  }

  // vX.X.X+ — `prefix` / `suffix` accepted on every m_* module
  // (EXCEPT m_label / m_template) via a global allowlist instead of
  // being spread into ~50 schemas. Separators (s_ / s_move) and the
  // two excluded modules reject them → badarg.
  const allowAffix =
    key != null && key.startsWith("m_") && key !== "m_label" && key !== "m_template";

  for (; i < parts.length; i++) {
    const pair = parts[i]!;
    const sepIdx = pair.search(/[:=]/);
    if (sepIdx <= 0) return null;
    const name = pair.slice(0, sepIdx);
    const raw = pair.slice(sepIdx + 1);
    if (name in schema.named) {
      const r = schema.named[name]!(raw);
      if (r === null) return null;
      out[name] = r;
    } else if (allowAffix && (name === "prefix" || name === "suffix")) {
      // Any string value including empty (empty = explicit "off").
      out[name] = raw;
    } else {
      return null;
    }
  }
  return out;
}
```

3. Update `expandInlineToken` (~7443) to pass `key` and thread the affix out:

```ts
function expandInlineToken(
  tok: string,
  key: string,
  skipLen: number,
  ctx: RenderContext,
): InlineResult | undefined {
  const schema = INLINE_SCHEMAS[key];
  if (schema === undefined) return undefined;
  const params = parseInlineArgs(tok.slice(skipLen), schema, key);
  if (params === null) return { kind: "badarg" };
  const rendered = INLINE_RENDERERS[key]!(params, ctx);
  if (rendered === INLINE_BADARG) return { kind: "badarg" };
  // vX.X.X+ — thread explicit prefix/suffix out to renderTemplate,
  // which applies them per the R1/R2/R3 rules.
  const affix: { prefix?: string; suffix?: string } = {};
  if (params.prefix !== undefined) affix.prefix = params.prefix as string;
  if (params.suffix !== undefined) affix.suffix = params.suffix as string;
  return {
    kind: "ok",
    value: rendered,
    ...(affix.prefix !== undefined || affix.suffix !== undefined ? { affix } : {}),
  };
}
```

- [ ] **Step 4: Add `applyAffix` + `stripSgrCodes` helpers**

Insert immediately before `export function renderTemplate(` (~7457):

```ts
// vX.X.X+ — strip SGR color codes so the auto-space rules can inspect
// the VISIBLE trailing character of the in-progress line.
function stripSgrCodes(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// vX.X.X+ — auto-space affix application for m_* module chunks.
//   explicit (|prefix:| / |suffix:|) always wins over the global
//   defaults (cfg.prefixSpace / cfg.suffixSpace). Auto prefix fires
//   only when the immediately preceding token was an m_* module (R3),
//   the line is non-empty (R1), and the visible line doesn't already
//   end in whitespace (R2). Auto suffix fires only when the NEXT
//   token is an m_* module (symmetric lookahead).
function applyAffix(
  piece: string,
  explicit: { prefix?: string; suffix?: string } | undefined,
  state: {
    prevIsModule: boolean;
    prevEndsWs: boolean;
    lineStart: boolean;
    nextIsModule: boolean;
  },
): string {
  const c = cfg();
  let prefix: string;
  if (explicit?.prefix !== undefined) {
    prefix = explicit.prefix;
  } else if (c.prefixSpace && state.prevIsModule && !state.lineStart && !state.prevEndsWs) {
    prefix = " ";
  } else {
    prefix = "";
  }
  let suffix: string;
  if (explicit?.suffix !== undefined) {
    suffix = explicit.suffix;
  } else if (c.suffixSpace && state.nextIsModule) {
    suffix = " ";
  } else {
    suffix = "";
  }
  if (prefix === "" && suffix === "") return piece;
  return prefix + piece + suffix;
}
```

- [ ] **Step 5: Update the `renderTemplate` loop**

In `src/render.ts` `renderTemplate`:

1. Before the `for` loop, after `let lineCursor = 0;` (~7494), add the adjacency state:

```ts
  // vX.X.X+ — auto-space tracking. prevIsModule = was the previous
  // token an m_* module (incl. dropped ones); prevEndsWs = does the
  // current line's visible text end in whitespace.
  let prevIsModule = false;
  let prevEndsWs = false;
```

2. After `let piece: string | null = null;` (~7505), add per-token flags:

```ts
    let isModule = false;
    let explicitAffix: { prefix?: string; suffix?: string } | undefined;
```

3. Inline provider-type filter drop (~7541): count the dropped module as a module for the next token:

```ts
        if (need && need !== ctx.providerType) {
          // known m_ module dropped by provider type → still counts
          // as a module for the next token's auto-space.
          prevIsModule = true;
          continue;
        }
```

4. Inline tail (~7874): handle badarg vs ok, set isModule/explicitAffix on ok:

```ts
      if (inline?.kind === "badarg") {
        if (sLiteralPiece !== null) {
          piece = sLiteralPiece;
          prevIsModule = false;
        } else {
          warnUnknownModuleOnce(tok);
          prevIsModule = true;
          continue;
        }
      } else {
        piece = inline?.kind === "ok" ? inline.value : tok;
        if (inline?.kind === "ok") {
          isModule = tok.startsWith("m_");
          if (inline.affix) explicitAffix = inline.affix;
        }
      }
```

5. Bare `m_` path (~7917): type-drop counts as a module; a real render sets isModule:

```ts
        if (mod.type != null && mod.type !== ctx.providerType) {
          prevIsModule = true;
          continue;
        }
        piece = mod(ctx);
        isModule = true;
```

6. Uniform tail — immediately before `if (piece == null || piece === "") continue;` (~7931), insert:

```ts
    // vX.X.X+ — apply prefix/suffix to m_* module chunks, then update
    // the adjacency state for the next token.
    if (isModule && piece != null && piece !== "") {
      piece = applyAffix(piece, explicitAffix, {
        prevIsModule,
        prevEndsWs,
        lineStart: current === "",
        nextIsModule: template[i + 1]?.startsWith("m_") ?? false,
      });
    }
    prevIsModule = isModule;
```

7. After the inner `\n`-split append loop closes (after the `for (let j = 0; j < segments.length; j++)` loop, ~7960), update prevEndsWs:

```ts
    prevEndsWs = /\s$/.test(stripSgrCodes(current));
```

- [ ] **Step 6: Run the rule tests**

Run: `npx tsx --test src/render-affix.test.ts`
Expected: PASS (all rule tests in the file).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors (`applyAffix` reads `cfg().prefixSpace` which Task 1 added).

- [ ] **Step 8: Commit (switch-point batch per git policy)**

---

### Task 3: Byte-identity sweep + full-suite regression

**Files:**
- Modify: `src/render-affix.test.ts` (add sweep)
- Test: full `npm test`

**Interfaces:**
- Consumes: `renderTemplate`, `DEFAULT_LINE_TEMPLATES`, `DEFAULT_STATUSLINE_PRESETS` (all exported).

- [ ] **Step 1: Write the byte-identity sweep test**

Append to `src/render-affix.test.ts`:

```ts
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
    // m_quote is excluded from the sweep: it selects its quote from a
    // time-derived index which can differ between the two renders and
    // flake the equality. Everything else is deterministic.
    const all = [
      ...Object.values(DEFAULT_LINE_TEMPLATES),
      ...Object.values(DEFAULT_STATUSLINE_PRESETS),
    ].filter((tpl) => !tpl.some((t) => t.startsWith("m_quote") || t === "m_template|quote"));

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
```

- [ ] **Step 2: Run the sweep**

Run: `npx tsx --test src/render-affix.test.ts`
Expected: PASS — the sweep proves every deterministic built-in fragment/preset renders byte-identical with auto-space on vs off (the three rules suppress auto-space wherever a junction already has an explicit separator/literal).

- [ ] **Step 3: Run the full suite and fix any tight-adjacency test**

Run: `npm test`
Expected: all pass. Known candidates that rely on *tight module adjacency* (two modules with no separator) were audited and should still pass because their assertions are `includes`-based or dedup-guarded (`render.test.ts:1360/2566`, `lineTemplate.test.ts:349`, `render-tokens.test.ts:4226`).

If any test FAILS because it asserted a tight-adjacency concatenation (the documented semantic change), fix it by adding `prefixSpace: false` to that test's `__resetForTest(...)` override so the test's original intent (module rendering, not spacing) is preserved. Re-run `npm test` until green.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit (switch-point batch per git policy)**

---

### Task 4: Local deploy (minimal overwrite)

**Files:**
- Modify: none in `src/` — deploy only.

- [ ] **Step 1: Build + copy into the runtime cache**

```bash
npm run build
HIGHEST=$(ls -d ~/.claude/plugins/cache/creditgauge/creditgauge/*/ | sort -V | tail -1)
cp dist/index.js "${HIGHEST}dist/index.js"
```

- [ ] **Step 2: Smoke-check the cache bundle**

```bash
grep -c "applyAffix" "${HIGHEST}dist/index.js"
```
Expected: `> 0` (confirms the runtime bundle contains the new code). Per the local-deploy procedure, `npm test` alone is insufficient — the statusline reads the cache bundle, not `src/`.

- [ ] **Step 3: Report done** — summarize the four rules, the token-count reduction (`tokens_tick` 17→9), and the semantic change (tight-adjacency now spaces).
