# Token Input Invariant Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the token-input invariant warning and fallback to account for `cache_creation_input_tokens`, treating a missing creation value as zero.

**Architecture:** Keep the existing `parseTokenSnapshot()` boundary and diagnostics flow. Add a local zero-default only inside the invariant calculation, update the diagnostic operands and fallback arithmetic, and preserve `TokenSnapshot.current.tokenCacheCreation` as nullable for all other consumers.

**Tech Stack:** TypeScript, Node.js built-in `node:test`, `tsx`, esbuild, npm scripts.

## Global Constraints

- The invariant is `total_input_tokens == input_tokens + cache_read_input_tokens + (cache_creation_input_tokens ?? 0)`.
- A missing or invalid `cache_creation_input_tokens` value is treated as `0` for this invariant only.
- Preserve `null` semantics for `TokenSnapshot.current.tokenCacheCreation` outside the invariant calculation.
- Keep diagnostics level `warning`, source `tokenTotalIn-invariant`, opt-in gating, deduplication, and file layout unchanged.
- Do not change TokenSample serialization, accumulator behavior, provider dispatch, or render behavior.
- Do not bump the plugin version for this source-only fix.

---

### Task 1: Add regression tests for complete token accounting

**Files:**
- Modify: `src/index-parse.test.ts:219-336`

**Interfaces:**
- Consumes: `parseTokenSnapshot(raw: string): TokenSnapshot | null` and the existing sandboxed `diagnosticsPath()` helper.
- Produces: Failing regression tests that require creation-cache tokens in invariant validation and fallback arithmetic.

- [ ] **Step 1: Update the invariant contract comments and add the valid nonzero case**

Change the suite comments from the two-term formula to the complete formula, then add this test immediately after the existing real-fixture test:

```ts
  it("nonzero cache creation satisfies invariant (3 + 79266 + 182 = 79451) — no warn", () => {
    const cwd = "D:\\invariant-nonzero-creation";
    const raw = JSON.stringify({
      session_id: "sess-nonzero-creation",
      cwd,
      context_window: {
        total_input_tokens: 79451,
        current_usage: {
          input_tokens: 3,
          cache_creation_input_tokens: 182,
          cache_read_input_tokens: 79266,
        },
      },
    });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.current.tokenCacheCreation, 182);
    assert.equal(lastLine(cwd), null, "complete input accounting should not warn");
  });
```

- [ ] **Step 2: Make the existing missing-creation violation assert zero-default behavior**

Keep the existing violation payload without a `cache_creation_input_tokens` property so it covers the selected missing-field policy. Update its title/comment and add this assertion beside the existing operand assertions:

```ts
    assert.match(e.msg, /cache_creation_input_tokens\(0\)/);
```

Keep the expected fallback at `150`, because `200 - 50 - 0 = 150`.

- [ ] **Step 3: Add a nonzero creation violation and complete fallback assertion**

Add this test after the missing-creation violation test:

```ts
  it("violation subtracts cache creation in tokenIn fallback", () => {
    const cwd = "D:\\invariant-nonzero-creation-violation";
    const raw = JSON.stringify({
      session_id: "sess-nonzero-creation-violation",
      cwd,
      context_window: {
        total_input_tokens: 200,
        current_usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 25,
          cache_read_input_tokens: 50,
        },
      },
    });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    const line = lastLine(cwd);
    assert.ok(line, "expected a warning line to be written");
    const e = JSON.parse(line!) as { msg: string };
    assert.match(e.msg, /cache_creation_input_tokens\(25\)/);
    assert.equal(snap!.current.tokenIn, 125, "fallback should be 200-50-25");
  });
```

- [ ] **Step 4: Run the parser tests to verify the new tests fail for the intended reason**

Run:

```bash
node --test --import tsx src/index-parse.test.ts
```

Expected: the new nonzero-creation test reports a `tokenTotalIn-invariant` warning instead of passing, and the nonzero fallback test reports `tokenIn` as `150` instead of `125`. The existing tests may also fail on the newly required diagnostic operand until the parser is updated. Do not change production code in this step.

### Task 2: Implement the minimal parser and documentation correction

**Files:**
- Modify: `src/session-parse.ts:8-15,120-144`
- Modify: `src/types.ts:82-92`
- Modify: `src/index-parse.test.ts:219-336`

**Interfaces:**
- Consumes: Parsed nullable `TokenSnapshot.current.tokenCacheCreation`.
- Produces: Updated `parseTokenSnapshot()` behavior with unchanged return type and diagnostics API.

- [ ] **Step 1: Add the local zero-default and complete formula**

In `src/session-parse.ts`, update the module and invariant comments to state the three-term formula. Immediately before the existing invariant `if`, add:

```ts
  const cacheCreation = snap.current.tokenCacheCreation ?? 0;
```

Keep the existing guard for non-null `tokenTotalIn`, `tokenIn`, and `tokenCachedIn`; do not require `tokenCacheCreation` to be non-null. Replace the comparison with:

```ts
    snap.totals.tokenTotalIn !==
      snap.current.tokenIn + snap.current.tokenCachedIn + cacheCreation
```

- [ ] **Step 2: Update warning operands and fallback arithmetic**

Replace the diagnostic template literal with:

```ts
      `total_input_tokens=${snap.totals.tokenTotalIn} != input_tokens(${snap.current.tokenIn}) + cache_read_input_tokens(${snap.current.tokenCachedIn}) + cache_creation_input_tokens(${cacheCreation})`,
```

Replace the fallback assignment with:

```ts
    snap.current.tokenIn = Math.max(
      0,
      snap.totals.tokenTotalIn - snap.current.tokenCachedIn - cacheCreation,
    );
```

Retain the same warning level, source, timestamp, cwd, and `parse` subkey arguments.

- [ ] **Step 3: Synchronize type and test comments**

Update the invariant prose in `src/types.ts` and `src/index-parse.test.ts` to say:

```text
 total_input_tokens == input_tokens + cache_read_input_tokens + cache_creation_input_tokens
```

and explicitly note that missing creation cache is treated as zero for this check. Do not alter unrelated field comments.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
node --test --import tsx src/index-parse.test.ts
npm run typecheck
```

Expected: all parser tests pass, including the nonzero valid case, the missing-creation zero case, the nonzero fallback case, and diagnostics-gate behavior; typecheck exits with status 0.

- [ ] **Step 5: Commit the implementation**

```bash
git add src/session-parse.ts src/types.ts src/index-parse.test.ts
git commit -m "fix(parse): include cache creation in token invariant" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 3: Full verification and local runtime deployment

**Files:**
- No additional source files; update the installed highest-version runtime bundle generated from `dist/`.

**Interfaces:**
- Consumes: The committed parser correction and the repository npm scripts.
- Produces: Verified source tests, typecheck, build output, and a cache bundle containing the updated warning formula.

- [ ] **Step 1: Run the complete test suite**

Run:

```bash
npm test
```

Expected: exit status 0 with all tests passing and zero failures.

- [ ] **Step 2: Build the distributable bundle**

Run:

```bash
npm run build
```

Expected: exit status 0 and updated `dist/index.js` plus built-in plugin copies under `dist/plugins/`.

- [ ] **Step 3: Mirror the build into the highest installed plugin cache**

Run:

```bash
HIGHEST=$(ls -d ~/.claude/plugins/cache/creditgauge/creditgauge/*/ | sort -V | tail -1)
cp dist/index.js "${HIGHEST}dist/index.js"
cp -r dist/plugins "${HIGHEST}dist/plugins"
grep -c "cache_creation_input_tokens" "${HIGHEST}dist/index.js"
```

Expected: the final count is greater than zero, confirming the live statusline bundle contains the new diagnostic operand.

- [ ] **Step 4: Perform the schema-coupled smoke check**

Run:

```bash
node dist/index.js < src/__fixtures__/stdin.real.json
```

Expected: the process exits successfully and renders statusline output without a parser exception. The fixture has `cache_creation_input_tokens: 0`, so it must not create an invariant warning.

- [ ] **Step 5: Confirm final repository state**

Run:

```bash
git status --short --branch
git diff --check
```

Expected: no uncommitted source changes and no whitespace errors. The generated `dist/` artifacts are ignored or unchanged according to the repository configuration.
