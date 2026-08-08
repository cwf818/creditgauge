# m_memUsage Band-Color + m_memUsed/m_memTotal Finalize — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `m_memUsage` a two-tone render (band-colored used chunk + cyan prefix/total) and finalize the already-existing `m_memUsed`/`m_memTotal` modules (skipLen bug, broken indentation, zero test coverage).

**Architecture:** One module-local helper `renderMemUsageBody` is shared by the bare `MODULES` path and the inline `INLINE_RENDERERS` path to build the two-tone body. The `m_memTotal` inline dispatcher skipLen is corrected from `12` to `11` (`key.length + 1`). New tests pin the band-color structure and the `m_memUsed`/`m_memTotal` wiring.

**Tech Stack:** TypeScript (`src/render.ts`, `src/render-tokens.test.ts`), `node:test` + `tsx`, esbuild.

## Global Constraints

- **No version bump.** `vX.X.X+` source markers stay as-is (version-bump-policy: only bump when explicitly requested).
- **m_memUsed / m_memTotal keep cyan default** (`DEFAULT_COLORS` entries unchanged in value).
- **m_memUsage band color = `colorFor(pct, "used")`**, mode pinned to `"used"` (RAM-bytes display has no used/remaining semantics; danger axis is always usedPct — mirrors `m_windowMemUsage`). `thresholds.percentBands` default `[60,70,80,90]`.
- **`|color|<c>` on m_memUsage overrides the whole line** (override always wins, same contract as `wrapPlainDefault`).
- **Do not touch `config.template.ts`** presets.
- **Placeholder paths unchanged** (`placeholderBare` / `placeholderWithColor`).
- **Host RAM is non-deterministic** → all new tests assert structure/shape, never byte values.
- **Cyan default = `\x1b[38;5;51m`** (bright cyan, 256-color; NOT `\x1b[36m`).

Spec: `docs/superpowers/specs/2026-08-08-memusage-bandcolor-design.md`

---

### Task 1: Fix `m_memTotal` inline skipLen (TDD)

**Files:**
- Modify: `src/render.ts:7694-7696`
- Test: `src/render-tokens.test.ts` (new top-level `describe` block inserted after the `renderTemplate — v0.8.0+ labels.* config customization` describe, which closes at line 5972; i.e. after the `});` on line 5972 and before the `// v0.8.0+ — tickStatus field renames` comment on line 5974)

**Interfaces:**
- Produces: `describe("renderTemplate — m_memUsed / m_memTotal (vX.X.X+)")` — the shared home for all m_memUsed/m_memTotal tests (Task 3 adds more tests inside it).

The inline dispatcher consumes `key.length + 1` chars before the args (the `|` included). For `m_memTotal` (10 chars) that is **11**, but the committed code passes **12**. `expandInlineToken(tok, key, skipLen, ctx)` does `tok.slice(skipLen)` — with skipLen 12 on `m_memTotal|valueOnly:true` the remainder becomes `alueOnly:true`, `parseInlineArgs` sees an unknown named arg → returns `null` → `{ kind: "badarg" }` → the whole chunk drops (empty output).

- [ ] **Step 1: Write the failing regression test**

Insert a new top-level describe block after `src/render-tokens.test.ts:5972`:

```ts
// vX.X.X+ — m_memUsed / m_memTotal standalone byte modules. Both read
// getMemUsage() (same source as m_memUsage) and render a single labeled
// byte value. Byte values are host-dependent → prefix/shape-only asserts.
describe("renderTemplate — m_memUsed / m_memTotal (vX.X.X+)", () => {
  it("m_memTotal|valueOnly|true renders (inline skipLen = key.length + 1)", () => {
    // The inline dispatcher consumes key.length + 1 chars (11 for
    // m_memTotal). A too-large skipLen (12) slices one char off the
    // first arg → parseInlineArgs sees "alueOnly:true" → badarg → the
    // whole chunk drops (empty output). Both the value path ("8.0G")
    // and the placeholder path ("n/a") produce NON-empty output when
    // args parse, so asserting non-empty output pins the skipLen.
    const out = renderTemplate(
      ["m_memTotal|valueOnly:true"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.notEqual(strip(out), "");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx --test-name-pattern "m_memTotal\|valueOnly" src/render-tokens.test.ts`
Expected: FAIL — `assert.notEqual(strip(out), "")` fails because output is empty (`badarg` drop).

- [ ] **Step 3: Fix the skipLen**

In `src/render.ts`, change lines 7694-7696:

```ts
      } else if (tok.startsWith("m_memTotal|")) {
        // m_memTotal → 10 chars + "|" = 12 skipLen.
        inline = expandInlineToken(tok, "m_memTotal", 12, ctx);
```
→
```ts
      } else if (tok.startsWith("m_memTotal|")) {
        // m_memTotal → 10 chars + "|" = 11 skipLen.
        inline = expandInlineToken(tok, "m_memTotal", 11, ctx);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx --test-name-pattern "m_memTotal\|valueOnly" src/render-tokens.test.ts`
Expected: PASS — output is non-empty (`8.0G` value path or `n/a` placeholder path).

- [ ] **Step 5: Commit**

```bash
git add src/render.ts src/render-tokens.test.ts
git commit -m "fix(render): m_memTotal inline skipLen 12 → 11 (key.length + 1)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `m_memUsage` two-tone band color (TDD)

**Files:**
- Modify: `src/render.ts` — add helper `renderMemUsageBody` at module scope (immediately above the `// v0.8.17+ — system RAM usage` comment at line 3208); rewire the bare renderer `m_memUsage` (lines 3216-3226) and the inline renderer `m_memUsage` (lines 7056-7063)
- Test: `src/render-tokens.test.ts` — add one test inside the existing `renderTemplate — v0.8.0+ labels.* config customization` describe, next to the existing `m_memUsage|color|red` test (ends line 5898)

**Interfaces:**
- Consumes: `formatMemBytes(bytes: number | null): string` (render.ts:265), `colorFor(displayedPct: number, mode: DisplayMode): string` (render.ts:413), `DEFAULT_COLORS.m_memUsage` (render.ts:4025), `RESET`.
- Produces: `function renderMemUsageBody(prefix: string, used: number, total: number, paramsColor: string | undefined): string` — returns the fully-colored body; `|color|` → whole line in that color, else used-chunk band + cyan rest.

Current `m_memUsage` wraps the whole body in cyan via `wrapPlainDefault`. Target: when no `|color|`, the used chunk (left of `/`) is band-colored via `colorFor(pct, "used")`, and prefix + `/` + total keep cyan (`\x1b[38;5;51m`). With `|color|<c>`, the whole line wraps in `<c>`.

- [ ] **Step 1: Write the failing test**

Insert after `src/render-tokens.test.ts:5898` (the `m_memUsage|color|red` test's closing `});`):

```ts
  it("m_memUsage| used chunk band-colored; prefix + /total stay cyan (no |color|)", () => {
    const out = renderTemplate(["m_memUsage"], ctxFor(fakeSnapshot())).join("\n");
    const s = strip(out);
    if (/n\/a$/.test(s)) return; // placeholder path — no bytes to two-tone
    assert.match(s, /^Mem:\d.*\/.*$/);
    // used chunk is its own SGR segment, closed with RESET before "/".
    assert.match(out, /\x1b\[0m\//);
    // "Mem:" prefix carries the cyan default (bright cyan 38;5;51).
    assert.match(out, /\x1b\[38;5;51mMem:/);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx --test-name-pattern "used chunk band-colored" src/render-tokens.test.ts`
Expected: FAIL — current output is `\x1b[38;5;51mMem:X.XG/Y.YG\x1b[0m` (whole line cyan, single RESET at end), so `\x1b[0m/` is absent.

- [ ] **Step 3: Implement the helper + rewire both paths**

Add at true module scope in `src/render.ts`, immediately above `const MODULES` (opens at line 1951) — NOT above the line-3208 comment, which sits INSIDE the MODULES object literal where a bare `function` declaration is a syntax error:

```ts
// vX.X.X+ — build the m_memUsage body as a two-tone string. With the
// user's |color|<c>, the whole "<prefix><used>/<total>" line is wrapped
// in that color (override always wins, same contract as
// wrapPlainDefault). With NO color, the used chunk (left of "/") gets
// band color via colorFor(pct, "used") — thresholds.percentBands
// (default [60,70,80,90]) — and prefix + "/" + total keep the module's
// DEFAULT_COLORS entry (bright cyan). mode is pinned to "used" because
// a RAM-bytes display has no used/remaining semantics: the danger axis
// is always "how much RAM is spent", so the color always indexes by
// usedPct (mirrors m_windowMemUsage's color rule).
function renderMemUsageBody(
  prefix: string,
  used: number,
  total: number,
  paramsColor: string | undefined,
): string {
  const usedStr = formatMemBytes(used);
  const totalStr = formatMemBytes(total);
  if (paramsColor) return `${paramsColor}${prefix}${usedStr}/${totalStr}${RESET}`;
  const pct = total > 0 ? (used / total) * 100 : 0;
  const usedColor = colorFor(pct, "used");
  const restColor = DEFAULT_COLORS.m_memUsage;
  const wrap = (s: string) => (restColor ? `${restColor}${s}${RESET}` : s);
  // "/" is a plain separator between the band-colored used chunk and the
  // cyan-wrapped total (so the used chunk's RESET lands directly before
  // "/", which the structural test asserts via /\x1b\[0m\//).
  return `${wrap(prefix)}${usedColor}${usedStr}${RESET}/${wrap(totalStr)}`;
}
```

Rewire the **bare** renderer (`src/render.ts:3216-3226`) — replace the `return wrapPlainDefault(...)` call:

```ts
  m_memUsage: (c) => {
    // vX.X.X+ — |valueOnly|true drops the "Mem:" prefix.
    const prefix = c.passThrough?.valueOnly === "true" ? "" : labelFor("memUsage");
    const m = getMemUsage();
    if (!m) return placeholderBare("m_memUsage", c);
    return renderMemUsageBody(prefix, m.used, m.total, undefined);
  },
```

Rewire the **inline** renderer (`src/render.ts:7056-7063`) — replace the `return wrapPlainDefault(...)` call:

```ts
  m_memUsage: (params, ctx) => {
    const m = getMemUsage();
    if (!m) return placeholderWithColor("m_memUsage", params, ctx);
    // vX.X.X+ — |valueOnly|true drops the "Mem:" prefix.
    const prefix = params.valueOnly === "true" ? "" : labelFor("memUsage");
    return renderMemUsageBody(prefix, m.used, m.total, params.color as string | undefined);
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx --test-name-pattern "used chunk band-colored" src/render-tokens.test.ts`
Expected: PASS — output contains `\x1b[0m/` and `\x1b[38;5;51mMem:`.

Also run the full mem-module tests to confirm no regression:

Run: `node --test --import tsx src/render-tokens.test.ts`
Expected: all pass, including the existing `m_memUsage|color|red` override test (line 5885) and the label-prefix tests (lines 5726, 5740).

- [ ] **Step 5: Commit**

```bash
git add src/render.ts src/render-tokens.test.ts
git commit -m "feat(render): m_memUsage two-tone — band-colored used chunk, cyan rest

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `m_memUsed` / `m_memTotal` test coverage + cleanup

**Files:**
- Modify: `src/render.ts` — indentation fixes at lines 4027, 4944, 5632-5634; module-count comment at line 4561
- Test: `src/render-tokens.test.ts` — add tests inside the `renderTemplate — m_memUsed / m_memTotal (vX.X.X+)` describe created in Task 1

**Interfaces:**
- Consumes: `renderTemplate`, `ctxFor`, `fakeSnapshot`, `strip`, `withLabels`, `assert` (all already imported/defined in `render-tokens.test.ts`).

These tests pin existing (already-working) behavior — they pass on the first run. The cleanup steps are non-TDD (pure formatting).

- [ ] **Step 1: Add the remaining tests**

Inside the `describe("renderTemplate — m_memUsed / m_memTotal (vX.X.X+)")` block, after the skipLen test, add:

```ts
  it("m_memUsed renders 'used:<bytes>'", () => {
    const out = renderTemplate(["m_memUsed"], ctxFor(fakeSnapshot())).join("\n");
    assert.match(strip(out), /^used:(n\/a|\d.*)$/);
  });

  it("m_memTotal renders 'total:<bytes>'", () => {
    const out = renderTemplate(["m_memTotal"], ctxFor(fakeSnapshot())).join("\n");
    assert.match(strip(out), /^total:(n\/a|\d.*)$/);
  });

  it("labelMemUsed override reaches m_memUsed prefix", () => {
    withLabels({ labelMemUsed: "RAM:" }, () => {
      const out = renderTemplate(["m_memUsed"], ctxFor(fakeSnapshot())).join("\n");
      assert.match(strip(out), /^RAM:(n\/a|\d.*)$/);
    });
  });

  it("labelMemTotal override reaches m_memTotal prefix", () => {
    withLabels({ labelMemTotal: "RAM:" }, () => {
      const out = renderTemplate(["m_memTotal"], ctxFor(fakeSnapshot())).join("\n");
      assert.match(strip(out), /^RAM:(n\/a|\d.*)$/);
    });
  });

  it("m_memUsed|nulldrop|true drops the placeholder on a null result", () => {
    const out = renderTemplate(
      ["m_memUsed|nulldrop:true"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.doesNotMatch(strip(out), /n\/a/);
  });

  it("m_memTotal|nulldrop|true drops the placeholder on a null result", () => {
    const out = renderTemplate(
      ["m_memTotal|nulldrop:true"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.doesNotMatch(strip(out), /n\/a/);
  });

  it("m_memUsed|color|red override applies the user's SGR", () => {
    const out = renderTemplate(
      ["m_memUsed|color:red"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    const s = strip(out);
    if (/n\/a$/.test(s)) return; // placeholder — no live value to color
    assert.match(s, /^used:/);
    assert.match(out, /\x1b\[(?:31|38;5;\d+)m/);
  });

  it("m_memTotal|color|red override applies the user's SGR", () => {
    const out = renderTemplate(
      ["m_memTotal|color:red"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    const s = strip(out);
    if (/n\/a$/.test(s)) return; // placeholder — no live value to color
    assert.match(s, /^total:/);
    assert.match(out, /\x1b\[(?:31|38;5;\d+)m/);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they pass**

Run: `node --test --import tsx --test-name-pattern "m_memUsed|m_memTotal" src/render-tokens.test.ts`
Expected: all PASS on first run (behavior already wired in commit `0b15e18`).

- [ ] **Step 3: Fix the broken indentation + stale count comment**

In `src/render.ts`:

1. Line 4027 — align with the siblings (add 2 leading spaces):
```ts
  m_memUsage: NAMED_PALETTE.cyan,
  m_memUsed: NAMED_PALETTE.cyan,
m_memTotal: NAMED_PALETTE.cyan,
```
→
```ts
  m_memUsage: NAMED_PALETTE.cyan,
  m_memUsed: NAMED_PALETTE.cyan,
  m_memTotal: NAMED_PALETTE.cyan,
```

2. Line 4944 — align with siblings:
```ts
  m_memUsage: placeholderLabelOr("memUsage"),
  m_memUsed: placeholderLabelOr("memUsed"),
m_memTotal: placeholderLabelOr("memTotal"),
```
→
```ts
  m_memUsage: placeholderLabelOr("memUsage"),
  m_memUsed: placeholderLabelOr("memUsed"),
  m_memTotal: placeholderLabelOr("memTotal"),
```

3. Lines 5632-5634 — align the comment and both entries:
```ts
  // vX.X.X+ — m_memUsed / m_memTotal inline-args. Same shape as
// m_memUsage: color + nulldrop + valueOnly.
m_memUsed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
m_memTotal: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
```
→
```ts
  // vX.X.X+ — m_memUsed / m_memTotal inline-args. Same shape as
  // m_memUsage: color + nulldrop + valueOnly.
  m_memUsed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
  m_memTotal: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
```

4. Line 4561 — update the module count:
```ts
// (~36 modules: the per-turn / m_acc* / m_sum* / m_memUsage
```
→
```ts
// (~38 modules: the per-turn / m_acc* / m_sum* / m_memUsage
```

5. `src/render.ts:1956-1957` — the `renderMemUsageBody` header comment claims
`prefix + "/" + total keep the module's DEFAULT_COLORS entry (bright cyan)`, but
the `/` is a plain separator (Task 2). Correct the comment:
```ts
// (default [60,70,80,90]) — and prefix + "/" + total keep the module's
// DEFAULT_COLORS entry (bright cyan). mode is pinned to "used" because
```
→
```ts
// (default [60,70,80,90]) — and prefix and total keep the module's
// DEFAULT_COLORS entry (bright cyan); the "/" is a plain separator
// between the band-colored used chunk and the cyan total. mode is pinned
// to "used" because
```

- [ ] **Step 4: Run typecheck + full test suite**

Run: `npm run typecheck`
Expected: clean, no errors.

Run: `npm test`
Expected: 1099 tests pass (plus the new ones — total grows by ~12).

- [ ] **Step 5: Commit**

```bash
git add src/render.ts src/render-tokens.test.ts
git commit -m "test(render): cover m_memUsed/m_memTotal; fix indent + module count

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Deploy to the runtime cache

Per CLAUDE.md "Dev loop: minimal deploy after every src/ change". Claude Code's statusline reads the cache bundle on every tick — the source-tree changes above are invisible until `dist/index.js` is rebuilt and copied over.

**Files:**
- Run: `npm run build`
- Run: copy `dist/index.js` into the highest version dir under the cache
- Verify: `grep -c renderMemUsageBody` on the cache bundle must be `> 0`

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: esbuild emits `dist/index.js`; `scripts/copy-builtin-plugins.mjs` runs.

- [ ] **Step 2: Copy the bundle into the runtime cache**

Run:
```bash
HIGHEST=$(ls -d ~/.claude/plugins/cache/creditgauge/creditgauge/*/ | sort -V | tail -1)
cp dist/index.js "${HIGHEST}dist/index.js"
```

- [ ] **Step 3: Smoke check the cache bundle contains the new code**

Run: `grep -c "renderMemUsageBody" "$(ls -d ~/.claude/plugins/cache/creditgauge/creditgauge/*/ | sort -V | tail -1)dist/index.js"`
Expected: a number `> 0` (the new helper is minified into the bundle).

- [ ] **Step 4: Optional live smoke test**

Run: `echo '{}' | ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic node dist/index.js`
Expected: a statusline line renders (token-plan or placeholder), no crash. (Requires `ANTHROPIC_AUTH_TOKEN` set; skip if unavailable.)

---

## Self-Review

**Spec coverage:**
- m_memUsage band-color (used chunk band / rest cyan, `|color|` whole-line override) → Task 2 ✓
- m_memTotal skipLen 12→11 → Task 1 ✓
- Indentation fixes (4027, 4944, 5632-5634) → Task 3 ✓
- Module-count comment (~36→~38) → Task 3 ✓
- Zero tests for m_memUsed/m_memTotal → Tasks 1 + 3 (12 new tests) ✓
- No version bump, cyan default preserved, no config.template.ts changes, placeholder paths unchanged → Global Constraints ✓
- Deploy → Task 4 ✓

**Placeholder scan:** No TBD/TODO; every code step has full code and exact commands with expected output.

**Type consistency:** `renderMemUsageBody(prefix, used, total, paramsColor)` — same 4-arg signature in both call sites (Task 2). `describe("renderTemplate — m_memUsed / m_memTotal (vX.X.X+)")` referenced by Tasks 1 and 3 with matching name.
