# Stale Usage Components Color Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider-backed `m_countdown` and `m_quota` render with forced `STALE_COLOR` whenever the provider data is stale, matching the existing `m_windowQuota` behavior.

**Architecture:** Keep stale handling local to the two affected module families. Pass `RenderContext.stale` into the quota-body color helper and wrap countdown bodies at both bare-module and inline-renderer call sites; do not change shared countdown formatting or unrelated modules. Stale color takes precedence over explicit inline `|color|...` values, while fresh rendering remains unchanged.

**Tech Stack:** TypeScript, Node built-in test runner, `tsx`, ANSI SGR string assertions, esbuild bundle.

## Global Constraints

- `stale === true` always selects `STALE_COLOR` for `m_countdown` and the colored quota number, even when inline `|color|...` is present.
- `m_windowQuota` behavior remains unchanged.
- Preserve existing text bodies, placeholder shapes, display modes, term selection, and reset `n/a` semantics.
- Do not add a global stale abstraction or change unrelated modules.
- Do not modify config schema, provider/cache behavior, or version numbers.
- Run `npm test`, `npm run typecheck`, `npm run build`, and the documented local cache deployment/smoke check before declaring completion.

---

### Task 1: Pin the forced-stale behavior with tests

**Files:**
- Modify: `src/render.test.ts:1155-1364` (existing `m_countdown` stale-color describe block)
- Modify: `src/render.test.ts` near the existing `m_quota` body/display describes (around lines 1584-1790)

**Interfaces:**
- Consumes: `renderProviderLine`, `renderTemplate`, `winToIv`, `legacyToIv`, `strip`, `STALE_COLOR`, `RED`, and the existing `RenderContext.stale` test setup.
- Produces: failing tests that define stale precedence for both bare and inline countdown/quota paths.

- [ ] **Step 1: Update the stale-future countdown expectation**

In the existing test named `bare m_countdown5h keeps default teal when stale=true but resetAt is still in the future`, keep the same input and body assertion, but replace the old “must not be gray” assertion with forced-gray assertions:

```ts
assert.ok(
  line.includes(`${STALE_COLOR}🕛30m`),
  `stale-but-future should wrap the real countdown in STALE_COLOR: ${line}`,
);
assert.ok(
  !line.includes(TEAL_DEFAULT),
  `stale-but-future should not use the default teal: ${line}`,
);
```

The test must still assert that stripped output contains `30m·5h`, proving stale changes only color and not the useful future countdown body.

- [ ] **Step 2: Update the stale inline-color precedence expectation**

In the existing test named `inline :color:red wins over the stale+past-due STALE_COLOR override`, rename it to describe forced stale precedence and replace the red-win assertions with:

```ts
assert.ok(
  line.includes(`${STALE_COLOR}🕛n/a`),
  `stale must force STALE_COLOR even with explicit :color: ${line}`,
);
assert.ok(
  !line.includes(RED),
  `stale must suppress the explicit red override: ${line}`,
);
```

Retain the `n/a·5h` body assertions so the test continues to pin the stale+past-due body swap.

- [ ] **Step 3: Add inline future-countdown forced-gray coverage**

Add a test in the same describe block using `statuslineTemplate: ["m_countdown|term:short|color:" + RED]`, a future reset (`nowMs + 30 * 60_000`), and `stale: true`. Assert the stripped line contains `30m·5h`, the line contains `${STALE_COLOR}🕛30m`, and the line contains neither `RED` nor `TEAL_DEFAULT`.

- [ ] **Step 4: Add stale quota band-color coverage**

Add a focused `m_quota` test with an interval containing quota fields, for example:

```ts
const interval: import("./render.ts").Interval = {
  windowId: "5h",
  label: "5h",
  startAt: null,
  endAt: null,
  intervalMs: null,
  usedPercent: 60,
  remainingPercent: 40,
  remainingQuota: null,
  usedQuota: 900,
  limitQuota: 1500,
};
```

Render `m_quota|term:short` with `stale: true` and assert:

```ts
assert.ok(strip(line).includes("quota: 900/1500"));
assert.ok(line.includes(`${STALE_COLOR}900${"\x1b[0m"}/1500`));
assert.ok(!line.includes(YELLOW)); // 60% is normally a band color in this fixture/config.
```

Use the existing render helper/context shape rather than introducing a new production fixture.

- [ ] **Step 5: Add stale quota inline-color precedence coverage**

Render the same quota interval through `m_quota|term:short|color:` plus `RED`, with `stale: true`. Assert the body remains `quota: 900/1500`, the numeric span uses `STALE_COLOR`, and the line does not contain `RED`. Add a fresh counterpart only if needed to preserve the existing explicit-color contract; the implementation must leave fresh user colors unchanged.

- [ ] **Step 6: Run the focused tests and verify they fail before implementation**

Run:

```bash
npx tsc --noEmit
node --test --import tsx src/render.test.ts
```

Expected: the typecheck passes, while the render test run fails specifically on the updated stale-future countdown expectation, the updated stale inline-color expectation, and the new stale quota assertions. Existing unrelated tests must not fail.

- [ ] **Step 7: Commit the test contract**

```bash
git add src/render.test.ts
git commit -m "test(render): require forced stale color for usage modules"
```

---

### Task 2: Implement forced stale color in both renderer paths

**Files:**
- Modify: `src/render.ts:608-630` (`wrapQuotaBody`)
- Modify: `src/render.ts:1474-1499` (bare `MODULES.m_countdown` and `MODULES.m_quota`)
- Modify: `src/render.ts:4555-4593` (inline `INLINE_RENDERERS.m_countdown` and `INLINE_RENDERERS.m_quota`)

**Interfaces:**
- Consumes: `RenderContext.stale`, existing `STALE_COLOR`, `RESET`, `formatOneResetSuffix`, `formatCountdownValueOnly`, `formatStalePastDueResetSuffix`, and `renderQuotaParts`.
- Produces: `wrapQuotaBody(parts, mode, userColor, valueOnly, stale)` with `stale` defaulting to `false`, plus forced-gray behavior at all four module call sites.

- [ ] **Step 1: Add an explicit stale parameter to `wrapQuotaBody`**

Change the signature without disturbing existing argument order:

```ts
function wrapQuotaBody(
  parts: NonNullable<ReturnType<typeof renderQuotaParts>>,
  mode: DisplayMode,
  userColor: string | undefined,
  valueOnly: boolean = false,
  stale: boolean = false,
): string {
```

Change only the tint selection to make stale win over user color and ratio-derived colors:

```ts
let tint: string;
if (stale) {
  tint = STALE_COLOR;
} else if (userColor) {
  tint = userColor;
} else if (parts.axisPct == null) {
  tint = STALE_COLOR;
} else {
  tint = colorFor(parts.axisPct, mode);
}
```

Keep prefix, total formatting, `valueOnly`, and RESET placement unchanged.

- [ ] **Step 2: Pass stale through the bare quota module**

Update the bare `MODULES.m_quota` call from:

```ts
return wrapQuotaBody(parts, c.mode, undefined, c.passThrough?.valueOnly === "true");
```

to:

```ts
return wrapQuotaBody(
  parts,
  c.mode,
  undefined,
  c.passThrough?.valueOnly === "true",
  c.stale,
);
```

- [ ] **Step 3: Make the bare countdown gray for every stale body**

Retain the existing stale+past-due branch. For the normal body, split the body computation from the fresh wrapper:

```ts
if (isStaleAndPastDue(w, c.stale, c.nowMs)) {
  return `${STALE_COLOR}${formatStalePastDueResetSuffix(iv.label, w, c.nowMs)}${RESET}`;
}
const body = formatOneResetSuffix(iv.label, w, c.nowMs);
if (c.stale) return `${STALE_COLOR}${body}${RESET}`;
return wrapPlainDefault("m_countdown", body, undefined);
```

This makes stale future-reset and stale no-reset label-only bodies gray without changing their text.

- [ ] **Step 4: Make inline countdown stale precedence explicit**

In `INLINE_RENDERERS.m_countdown`, keep the existing stale+past-due `valueOnly`/full-body shape, but choose `STALE_COLOR` whenever `ctx.stale` is true. For the normal body branch, bypass `wrapPlainDefault` on stale:

```ts
const body = valueOnly
  ? formatCountdownValueOnly(w, ctx.nowMs)
  : formatOneResetSuffix(iv.label, w, ctx.nowMs);
if (body === "") return null;
if (ctx.stale) return `${STALE_COLOR}${body}${RESET}`;
return wrapPlainDefault("m_countdown", body, params.color as string | undefined);
```

For the stale+past-due branch, replace the user-color-first selection with:

```ts
const color = ctx.stale ? STALE_COLOR : (params.color as string | undefined) ?? STALE_COLOR;
```

This preserves the existing fresh behavior and ensures explicit red cannot override stale gray.

- [ ] **Step 5: Pass stale through the inline quota module**

Update the inline call from:

```ts
return wrapQuotaBody(parts, mode, params.color as string | undefined, passThroughOr(params, ctx, "valueOnly") === "true");
```

to:

```ts
return wrapQuotaBody(
  parts,
  mode,
  params.color as string | undefined,
  passThroughOr(params, ctx, "valueOnly") === "true",
  ctx.stale,
);
```

Do not alter the placeholder path; `placeholderWithColor` remains unchanged because this task concerns rendered usage data, while missing-data placeholders already have their established color precedence.

- [ ] **Step 6: Run the focused render tests and typecheck**

Run:

```bash
npx tsc --noEmit
node --test --import tsx src/render.test.ts
```

Expected: typecheck passes and the complete render test file passes, including the changed stale-future, forced-inline-color, and quota tests.

- [ ] **Step 7: Commit the implementation**

```bash
git add src/render.ts
git commit -m "fix(render): force stale gray on usage components"
```

---

### Task 3: Run full verification and deploy the bundle

**Files:**
- Modify: `dist/index.js` only through the prescribed build command.
- Deploy: current highest-version local plugin cache under `~/.claude/plugins/cache/creditgauge/creditgauge/`.

**Interfaces:**
- Consumes: committed `src/render.ts` and tests.
- Produces: verified source tests, typecheck, build artifact, and cache bundle containing the stale-color implementation.

- [ ] **Step 1: Run the complete automated test suite**

```bash
npm test
```

Expected: all repository tests pass; report the exact pass/fail counts rather than assuming the historical count.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: `tsc --noEmit` exits 0 with no diagnostics.

- [ ] **Step 3: Build the runtime bundle**

```bash
npm run build
```

Expected: esbuild writes `dist/index.js`, and built-in plugin copies remain present under `dist/plugins/`.

- [ ] **Step 4: Mirror the built bundle into the active cache**

```bash
HIGHEST=$(ls -d ~/.claude/plugins/cache/creditgauge/creditgauge/*/ | sort -V | tail -1)
cp dist/index.js "${HIGHEST}dist/index.js"
cp -r dist/plugins "${HIGHEST}dist/plugins"
grep -c "wrapQuotaBody" "${HIGHEST}dist/index.js"
```

Expected: the final count is greater than 0. Do not create a partial new version directory or bump the plugin version.

- [ ] **Step 5: Check the final working tree and summarize verification**

```bash
git status --short
git log -3 --oneline
```

Expected: only the intended source/test commits and generated build output state are present; report any generated-file differences or deployment limitations explicitly.
