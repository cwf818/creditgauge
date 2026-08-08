# m_contextUsage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `m_contextUsage` module that renders context-window usage as `ctx:<band-colored used>/<blue total>` (two-tone, mirroring `m_memUsage`).

**Architecture:** Parallel clone of `m_memUsage`. A module-local `renderContextUsageBody(prefix, used, total, paramsColor)` builds the two-tone string (`formatCompactToken` for both sides, `colorFor(pct, "used")` for the used chunk, `DEFAULT_COLORS.m_contextUsage` = `NAMED_PALETTE.blue` for prefix/total). Data: `used = tokens.totals.tokenTotalIn`, `total = tokens.contextWindow.contextWindowSize`. Registered in the 5 standard slots (MODULES / DEFAULT_COLORS / PLACEHOLDERS / INLINE_SCHEMAS / INLINE_RENDERERS / dispatcher) + a new `contextUsage` label axis.

**Tech Stack:** TypeScript, `node:test` + `tsx`, esbuild. No new dependencies.

## Global Constraints

- **Data source:** `used = c.tokens.totals.tokenTotalIn`, `total = c.tokens.contextWindow.contextWindowSize`. Both non-null and `total > 0` required to render; otherwise placeholder `ctx:n/a`.
- **Format:** `formatCompactToken` on both sides (e.g. `ctx:163.5k/200.0k`). NOT `formatMemBytes`, NOT raw integers.
- **Default prefix:** `labelFor("contextUsage")` → `labels.labelContextUsage` default `"ctx:"`.
- **Two-tone color:** no `|color|` → used chunk = `colorFor(pct, "used")` (thresholds.percentBands, mode pinned to `"used"`), prefix + total = `DEFAULT_COLORS.m_contextUsage` (blue), `/` is a plain separator. With `|color|<c>` → whole line wrapped in the user color (override always wins).
- **value-zero rule:** `used = 0, total > 0` renders `ctx:0/200.0k` (do NOT hide zero).
- **Placeholder:** missing used / missing total / `total <= 0` → `placeholderBare` (STALE_COLOR, `ctx:n/a`); `|valueOnly:true|` strips the prefix in both live and placeholder paths.
- **No version bump** — use `vX.X.X+` markers (version-bump-policy).
- **No default-template changes** — `m_contextUsage` is opt-in; do NOT touch `src/config.template.ts`.
- **Do NOT modify `renderMemUsageBody` or any existing module** — the new helper is a parallel clone.
- **Dispatcher skipLen:** `"m_contextUsage"` is 14 chars → `skipLen` = 15 (key.length + 1).
- Colors (SGR codes): blue = `\x1b[38;5;33m`, brightGreen = `\x1b[38;5;41m`, STALE = `\x1b[90m`.

---

### Task 1: Failing tests for m_contextUsage

**Files:**
- Modify: `src/render-tokens.test.ts` (append a new `describe` block near the `m_memUsed / m_memTotal` block, which ends around line 6076)

**Interfaces:**
- Consumes: existing test helpers `fakeSnapshot`, `ctxFor`, `strip`, `withLabels`, `renderTemplate` (already defined in this file — `fakeSnapshot` at line 70, `ctxFor` at line 134, `withLabels` at line 175).
- Produces: the `m_contextUsage` behavior contract that Task 3 must satisfy.

- [ ] **Step 1: Write the failing test block**

Append this `describe` block to `src/render-tokens.test.ts` (immediately after the `m_memUsed / m_memTotal` describe block ends, ~line 6076):

```ts
describe("renderTemplate — m_contextUsage (vX.X.X+ two-tone context x/y)", () => {
  // Default fakeSnapshot: tokenTotalIn=163479 → "163.5k",
  // contextWindowSize=200000 → "200.0k", pct=81.7% → band 3 → orange.
  it("bare renders ctx:<bandUsed>/<blueTotal>", () => {
    const out = renderTemplate(["m_contextUsage"], ctxFor(fakeSnapshot())).join("\n");
    const s = strip(out);
    // fixture is deterministic — no placeholder-path guard needed.
    assert.equal(s, "ctx:163.5k/200.0k");
    // used chunk is its own SGR segment, closed with RESET before "/".
    assert.match(out, /\x1b\[0m\//);
    // "ctx:" prefix carries the blue default (38;5;33).
    assert.match(out, /\x1b\[38;5;33mctx:/);
    // total chunk also blue.
    assert.match(out, /\x1b\[38;5;33m200\.0k/);
  });

  it("used chunk band color follows colorFor(pct, used)", () => {
    // tokenTotalIn=100000, capacity=200000 → pct=50 → band 0 (brightGreen 38;5;41).
    const snap = fakeSnapshot({
      totals: { tokenTotalIn: 100000, tokenTotalOut: 0 },
      contextWindow: { contextWindowSize: 200000, contextUsedPercent: 50, contextRemainingPercent: 50 },
    });
    const out = renderTemplate(["m_contextUsage"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "ctx:100.0k/200.0k");
    assert.match(out, /\x1b\[38;5;41m100\.0k/);
  });

  it("|valueOnly:true| drops the ctx: prefix", () => {
    const out = renderTemplate(["m_contextUsage|valueOnly:true"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "163.5k/200.0k");
  });

  it("|color|red| overrides the whole line", () => {
    const out = renderTemplate(["m_contextUsage|color:red"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "ctx:163.5k/200.0k");
    assert.match(out, /\x1b\[(?:31|38;5;\d+)m/);
  });

  it("missing used → ctx:n/a placeholder (STALE_COLOR)", () => {
    const snap = fakeSnapshot({ totals: { tokenTotalIn: null, tokenTotalOut: 0 } });
    const out = renderTemplate(["m_contextUsage"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "ctx:n/a");
    assert.match(out, /\x1b\[90m/);
  });

  it("missing capacity → ctx:n/a placeholder", () => {
    const snap = fakeSnapshot({
      contextWindow: { contextWindowSize: null, contextUsedPercent: 0, contextRemainingPercent: 0 },
    });
    const out = renderTemplate(["m_contextUsage"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "ctx:n/a");
  });

  it("used=0, capacity>0 → ctx:0/200.0k (value-zero rule)", () => {
    const snap = fakeSnapshot({
      totals: { tokenTotalIn: 0, tokenTotalOut: 0 },
      contextWindow: { contextWindowSize: 200000, contextUsedPercent: 0, contextRemainingPercent: 100 },
    });
    const out = renderTemplate(["m_contextUsage"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "ctx:0/200.0k");
    // pct=0 → band 0 brightGreen.
    assert.match(out, /\x1b\[38;5;41m0/);
  });

  it("labelContextUsage override reaches the prefix (withLabels)", () => {
    withLabels({ labelContextUsage: "占用:" }, () => {
      const out = renderTemplate(["m_contextUsage"], ctxFor(fakeSnapshot())).join("\n");
      assert.equal(strip(out), "占用:163.5k/200.0k");
    });
  });

  it("inline form routes through the dispatcher (skipLen 15)", () => {
    // |valueOnly:true must parse so the prefix drops; a wrong skipLen
    // would leave "ctx:" in place.
    const out = renderTemplate(["m_contextUsage|valueOnly:true"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "163.5k/200.0k");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -A4 "m_contextUsage" | head -40`
Expected: FAIL — `m_contextUsage` is an unknown token, so it renders literally (per the s-separators-and-unknown-modules contract: unknown tokens pass through as-is on both bare and inline paths). E.g. `actual: 'm_contextUsage'` vs `expected: 'ctx:163.5k/200.0k'`.

- [ ] **Step 3: Commit**

```bash
git add src/render-tokens.test.ts
git commit -m "test(render): red tests for m_contextUsage two-tone context x/y"
```

---

### Task 2: Config surface — `labelContextUsage` axis

**Files:**
- Modify: `src/config.ts` (three edits: Labels interface, DEFAULT_CONFIG.labels, fields whitelist)
- Modify: `src/config.test.ts` (one assertion in the full-config-load test)

**Interfaces:**
- Consumes: nothing (standalone type+default plumbing).
- Produces: `Config["labels"]["labelContextUsage"]` (`string`, default `"ctx:"`), consumed by Task 3's `labelFor("contextUsage")`.

- [ ] **Step 1: Write the failing config-default test**

In `src/config.test.ts`, find the `it("...full config...")` or `loadConfig()` test that asserts `cfg.labels` defaults (search for an existing `labels` deep-equal or a `cfg.labels.labelMemUsage` assertion; if none exists, add this `it` block right after the "unknown string falls back..." test at ~line 177):

```ts
it("labels default includes labelContextUsage: 'ctx:'", async () => {
  writeFileSync(join(dir, "config.json"), JSON.stringify({}));
  const cfg = await loadConfig();
  assert.equal(cfg.labels.labelContextUsage, "ctx:");
});
```

Note: if the test file already has a `labels` defaults test, add `assert.equal(cfg.labels.labelContextUsage, "ctx:")` there instead of creating a new block.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -B2 -A6 "labelContextUsage" | head -30`
Expected: FAIL with a TypeScript error (`labelContextUsage` does not exist on `Labels`) — the test won't even compile.

- [ ] **Step 3: Add the field to the Labels interface**

In `src/config.ts`, in the `labels:` block of the `Config` type, after the `labelContextRemainingPercent: string;` line (~line 334), add:

```ts
    labelContextRemainingPercent: string;
    // vX.X.X+ — m_contextUsage two-tone x/y prefix (used/capacity).
    // Default "ctx:" (lowercase, matching the context-module family
    // style). Override via labels.labelContextUsage.
    labelContextUsage: string;
```

- [ ] **Step 4: Add the default**

In `src/config.ts`, in `DEFAULT_CONFIG.labels`, after `labelContextRemainingPercent: "remain:",` (~line 498), add:

```ts
    labelContextRemainingPercent: "remain:",
    // vX.X.X+ — m_contextUsage two-tone x/y prefix.
    labelContextUsage: "ctx:",
```

- [ ] **Step 5: Add to the fields whitelist**

In `src/config.ts`, in the `fields: Array<keyof typeof out.labels>` array (~line 1121), after `"labelContextRemainingPercent",` (line 1137), add:

```ts
        "labelContextRemainingPercent",
        // vX.X.X+ — m_contextUsage two-tone x/y prefix axis.
        "labelContextUsage",
```

- [ ] **Step 6: Run tests to verify the config test passes**

Run: `npm test 2>&1 | grep -E "tests [0-9]+|pass [0-9]+|fail [0-9]+" | head -3`
Expected: 0 failures in the config suite (the module tests from Task 1 still fail — that's expected until Task 3).

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(config): labelContextUsage axis (default 'ctx:')"
```

---

### Task 3: Module implementation (render.ts)

**Files:**
- Modify: `src/render.ts` (seven edits: `renderContextUsageBody` helper, MODULES entry, LabelAxis union, `labelFor` case, DEFAULT_COLORS, PLACEHOLDERS, INLINE_SCHEMAS, INLINE_RENDERERS, dispatcher, module-count comment)

**Interfaces:**
- Consumes: `Config["labels"]["labelContextUsage"]` (Task 2), `colorFor(pct, "used")` (existing, render.ts:413), `formatCompactToken` (existing, render.ts:3314), `placeholderBare` / `placeholderWithColor` / `placeholderLabelOr` (existing), `NAMED_PALETTE.blue` (existing, render.ts:3939).
- Produces: the `m_contextUsage` module satisfying every Task 1 test.

- [ ] **Step 1: Add the `renderContextUsageBody` helper**

In `src/render.ts`, immediately after the `renderMemUsageBody` function (which ends at line 1978), add:

```ts
// vX.X.X+ — build the m_contextUsage body as a two-tone string,
// mirroring renderMemUsageBody but for context-window tokens. With
// the user's |color|<c>, the whole "<prefix><used>/<total>" line is
// wrapped in that color (override always wins, same contract as
// wrapPlainDefault). With NO color, the used chunk (left of "/")
// gets band color via colorFor(pct, "used") — thresholds.percentBands
// (default [60,70,80,90]) — and prefix and total keep the module's
// DEFAULT_COLORS entry (blue); the "/" is a plain separator between
// the band-colored used chunk and the blue total. mode is pinned to
// "used" because an occupancy x/y display has no used/remaining
// semantics: the danger axis is always "how much context is spent",
// so the color always indexes by usedPct (mirrors m_memUsage).
function renderContextUsageBody(
  prefix: string,
  used: number,
  total: number,
  paramsColor: string | undefined,
): string {
  const usedStr = formatCompactToken(used);
  const totalStr = formatCompactToken(total);
  if (paramsColor) return `${paramsColor}${prefix}${usedStr}/${totalStr}${RESET}`;
  const pct = total > 0 ? (used / total) * 100 : 0;
  const usedColor = colorFor(pct, "used");
  const restColor = DEFAULT_COLORS.m_contextUsage;
  const wrap = (s: string) => (restColor ? `${restColor}${s}${RESET}` : s);
  const prefixSpan = prefix ? wrap(prefix) : "";
  return `${prefixSpan}${usedColor}${usedStr}${RESET}/${wrap(totalStr)}`;
}
```

- [ ] **Step 2: Add the MODULES (bare) entry**

In `src/render.ts`, inside the `MODULES` object, immediately after the `m_memTotal` entry (which ends at line 3298, just before the closing `};` at line 3299), add:

```ts
  // vX.X.X+ — context-window usage x/y (used/capacity). Data source
  // mirrors m_contextSize (used = totals.tokenTotalIn) and
  // m_contextWindowSize (capacity = contextWindow.contextWindowSize),
  // formatted with formatCompactToken on both sides. The two-tone
  // body (band-colored used chunk + blue prefix/total) is built by
  // renderContextUsageBody. value=0 renders as "0" (value-zero rule);
  // missing used/capacity → "ctx:n/a" placeholder.
  m_contextUsage: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "ctx:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("contextUsage");
    const used = c.tokens?.totals?.tokenTotalIn;
    const total = c.tokens?.contextWindow?.contextWindowSize;
    if (used == null || total == null || total <= 0) return placeholderBare("m_contextUsage", c);
    return renderContextUsageBody(prefix, used, total, undefined);
  },
```

- [ ] **Step 3: Add the label axis**

In `src/render.ts`, in the `LabelAxis` union type (~line 171), after `| "contextRemainingPercent"` (line 177), add:

```ts
  | "contextSize" | "contextWindowSize" | "contextUsedPercent" | "contextRemainingPercent" // v0.8.23+
  | "contextUsage" // vX.X.X+ — m_contextUsage two-tone x/y prefix ("ctx:")
```

And in the `labelFor` switch (~line 194), after the `case "contextRemainingPercent":` line (214), add:

```ts
    case "contextRemainingPercent": return labels.labelContextRemainingPercent;
    case "contextUsage": return labels.labelContextUsage;
```

- [ ] **Step 4: Add DEFAULT_COLORS entry**

In `src/render.ts`, in the `DEFAULT_COLORS` module-color map, after the `m_memTotal: NAMED_PALETTE.cyan,` line (4053), add:

```ts
  m_memTotal: NAMED_PALETTE.cyan,
  // vX.X.X+ — m_contextUsage. Blue rest color (prefix + total). The
  // used chunk is band-colored internally by renderContextUsageBody
  // (colorFor(pct, "used")), so this entry only tints the rest.
  m_contextUsage: NAMED_PALETTE.blue,
```

- [ ] **Step 5: Add PLACEHOLDERS entry**

In `src/render.ts`, in the `PLACEHOLDERS` map, after the `m_memTotal: placeholderLabelOr("memTotal"),` line (4970), add:

```ts
  m_memTotal: placeholderLabelOr("memTotal"),
  // vX.X.X+ — m_contextUsage placeholder. "ctx:n/a" (prefix dropped
  // when |valueOnly|true is set). Mirrors m_memUsage's shape.
  m_contextUsage: placeholderLabelOr("contextUsage"),
```

- [ ] **Step 6: Add INLINE_SCHEMAS entry**

In `src/render.ts`, in the `INLINE_SCHEMAS` map, after the `m_memTotal:` inline-schema entry (line 5660), add:

```ts
  m_memTotal: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  // vX.X.X+ — m_contextUsage inline-args. Same shape as m_memUsage:
  // color + nulldrop + valueOnly. |color|<c> overrides the whole
  // two-tone body; with no color, used chunk band-colored + rest blue.
  m_contextUsage: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
```

- [ ] **Step 7: Add INLINE_RENDERERS entry**

In `src/render.ts`, in the `INLINE_RENDERERS` map, after the `m_memUsage:` inline renderer (which ends at line 7088), add:

```ts
  // vX.X.X+ — context-window usage inline form. Mirror of the bare
  // MODULES entry but with the user's |color|<c> override applied
  // before the default tint (override always wins).
  m_contextUsage: (params, ctx) => {
    const used = ctx.tokens?.totals?.tokenTotalIn;
    const total = ctx.tokens?.contextWindow?.contextWindowSize;
    if (used == null || total == null || total <= 0) return placeholderWithColor("m_contextUsage", params, ctx);
    const prefix = params.valueOnly === "true" ? "" : labelFor("contextUsage");
    return renderContextUsageBody(prefix, used, total, params.color as string | undefined);
  },
```

- [ ] **Step 8: Add the dispatcher branch**

In `src/render.ts`, in the inline dispatcher chain, after the `m_memUsed|` branch (which ends at line 7718), add:

```ts
      } else if (tok.startsWith("m_memUsed|")) {
        // m_memUsed → 9 chars + "|" = 10 skipLen.
        inline = expandInlineToken(tok, "m_memUsed", 10, ctx);
      } else if (tok.startsWith("m_contextUsage|")) {
        // m_contextUsage → 14 chars + "|" = 15 skipLen.
        inline = expandInlineToken(tok, "m_contextUsage", 15, ctx);
```

- [ ] **Step 9: Bump the module-count comment**

In `src/render.ts`, the comment at line 4587 says `(~38 modules: ...)`. Change `~38 modules` to `~39 modules` (m_contextUsage added).

- [ ] **Step 10: Run the full test suite**

Run: `npm test 2>&1 | tail -8`
Expected: `tests 1118`, `pass 1118`, `fail 0` (1109 existing + 9 new m_contextUsage tests).

- [ ] **Step 11: Run typecheck**

Run: `npm run typecheck`
Expected: no output (clean).

- [ ] **Step 12: Commit**

```bash
git add src/render.ts
git commit -m "feat(render): m_contextUsage two-tone context x/y (blue rest, band-colored used)"
```

---

### Task 4: Build + local deploy + smoke check

**Files:**
- Modify: none (build artifact only)

**Interfaces:**
- Consumes: the finished `dist/index.js` from `npm run build`.

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: `Done in <ms>` (esbuild) + the `copy-builtin-plugins` lines.

- [ ] **Step 2: Copy into the highest cache version dir**

Run:

```bash
HIGHEST=$(ls -d ~/.claude/plugins/cache/creditgauge/creditgauge/*/ | sort -V | tail -1)
cp dist/index.js "${HIGHEST}dist/index.js"
echo "${HIGHEST}"
```

Expected: prints the cache dir (e.g. `/c/Users/chen/.claude/plugins/cache/creditgauge/creditgauge/1.2.0/`).

- [ ] **Step 3: Smoke-check the cache bundle**

Run:

```bash
HIGHEST=$(ls -d ~/.claude/plugins/cache/creditgauge/creditgauge/*/ | sort -V | tail -1)
grep -c 'm_contextUsage' "${HIGHEST}dist/index.js"
grep -c 'ctx:' "${HIGHEST}dist/index.js"
```

Expected: both counts `> 0`. Note: the `💳`-style emoji isn't involved here, but be aware esbuild escapes non-ASCII to `\u{...}` — `m_contextUsage` and `ctx:` are pure ASCII so literal grep works.

- [ ] **Step 4: Confirm working tree is clean**

Run: `git status --short`
Expected: empty (all changes committed).
