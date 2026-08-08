# m_branch withStatus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `withStatus:true/false` param to `m_branch` (default `true`) that renders the branch with clean/dirty colors and a `*` suffix when dirty.

**Architecture:** Mirror of the `valueOnly` param pattern. New `WITHSTATUS_PARAM` named-arg validator; `m_branch` reads it in both the bare MODULES path (`c.passThrough?.withStatus`) and the INLINE_RENDERERS path (`params.withStatus`). When true, color = `info.dirty ? NAMED_PALETTE.brown : BRIGHT_GREEN` (same as `m_gitStatus`) and body = `branch + (dirty ? "*" : "")`. When false, keep the existing `wrapPlainDefault(branch, undefined)` teal rendering. `withStatus` also added to the `m_template` passthrough whitelist.

**Tech Stack:** TypeScript, `node:test` + `tsx`. No new dependencies.

## Global Constraints

- **withStatus default `true`** — a bare `m_branch` renders branch + status color + `*` when dirty.
- **withStatus:true**: color = `info.dirty ? NAMED_PALETTE.brown : BRIGHT_GREEN` (SGR `38;5;130` / `38;5;41`); body = `info.branch + (info.dirty ? "*" : "")`; the `*` is inside the same color span; `|color|<c>` overrides the whole span.
- **withStatus:false**: `wrapPlainDefault("m_branch", info.branch, params.color)` → teal default (SGR `38;5;80`), no `*`, no status color; `|color|<c>` still wins.
- **Placeholder unchanged**: `readGitInfo(cwd)` null / detached HEAD → `branch:n/a` (STALE).
- **Data**: `readGitInfo(cwd)` returns `{ branch, dirty } | null` (`src/git-info.ts`); read ONCE per render (current bare form calls it twice — fix that).
- **Registration spots**: new `WITHSTATUS_PARAM` constant; `INLINE_SCHEMAS.m_branch`; `m_template` passthrough whitelist; bare `MODULES.m_branch`; `INLINE_RENDERERS.m_branch`. Dispatcher skipLen stays 9; PLACEHOLDERS + DEFAULT_COLORS unchanged.
- **No version bump** — use `vX.X.X+` markers.
- **Do NOT modify** `m_gitStatus`, `readGitInfo`, or the `git_info` template fragment.

---

### Task 1: Failing tests for m_branch withStatus

**Files:**
- Modify: `src/render-tokens.test.ts` (in the session-info describe block, after the `m_gitStatus|nulldrop|false` test which ends ~line 2117)

**Interfaces:**
- Consumes: existing helpers `fakeSnapshot`, `ctxFor`, `strip`, `renderTemplate`, `__resetGitInfoCacheForTest` (imported at line 55), and `execFileSync` / `mkdtempSync` / `rmSync` / `join` / `tmpdir` / `writeFileSync` (imported lines 51-54). The temp-repo pattern mirrors the existing `m_gitStatus` test at lines 2065-2101.
- Produces: the `m_branch` withStatus behavior contract Task 2 must satisfy.

- [ ] **Step 1: Write the failing tests**

Append these three `it` blocks after the `m_gitStatus|nulldrop|false` test (which ends at line 2117):

```ts
  it("m_branch| withStatus defaults to true: clean → green 'main', dirty → brown 'main*'", () => {
    let repoDir: string | undefined;
    try {
      execFileSync("git", ["--version"], { stdio: "ignore", timeout: 1000 });
    } catch {
      return; // skip — no git on PATH
    }
    repoDir = mkdtempSync(join(tmpdir(), "creditgauge-render-branch-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoDir });
    writeFileSync(join(repoDir, "r"), "x");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });

    try {
      __resetGitInfoCacheForTest();
      const clean = renderTemplate(["m_branch"], ctxFor(fakeSnapshot({ cwd: repoDir }))).join("\n");
      assert.equal(strip(clean), "main");
      assert.ok(clean.includes("\x1b[38;5;41m"), `clean branch should be brightGreen: ${JSON.stringify(clean)}`);
      assert.ok(!clean.includes("*"), `clean branch has no star: ${JSON.stringify(clean)}`);

      writeFileSync(join(repoDir, "new"), "y");
      __resetGitInfoCacheForTest();
      const dirty = renderTemplate(["m_branch"], ctxFor(fakeSnapshot({ cwd: repoDir }))).join("\n");
      assert.equal(strip(dirty), "main*");
      assert.ok(dirty.includes("\x1b[38;5;130m"), `dirty branch should be brown: ${JSON.stringify(dirty)}`);
    } finally {
      if (repoDir) rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("m_branch|withStatus:false keeps teal branch, no star, no status color", () => {
    let repoDir: string | undefined;
    try {
      execFileSync("git", ["--version"], { stdio: "ignore", timeout: 1000 });
    } catch {
      return; // skip — no git on PATH
    }
    repoDir = mkdtempSync(join(tmpdir(), "creditgauge-render-branch-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoDir });
    writeFileSync(join(repoDir, "r"), "x");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });

    try {
      __resetGitInfoCacheForTest();
      const clean = renderTemplate(
        ["m_branch|withStatus:false"],
        ctxFor(fakeSnapshot({ cwd: repoDir })),
      ).join("\n");
      assert.equal(strip(clean), "main");
      assert.ok(clean.includes("\x1b[38;5;80m"), `withStatus:false keeps teal: ${JSON.stringify(clean)}`);

      writeFileSync(join(repoDir, "new"), "y");
      __resetGitInfoCacheForTest();
      const dirty = renderTemplate(
        ["m_branch|withStatus:false"],
        ctxFor(fakeSnapshot({ cwd: repoDir })),
      ).join("\n");
      assert.equal(strip(dirty), "main");
      assert.ok(!dirty.includes("*"), `withStatus:false dirty has no star: ${JSON.stringify(dirty)}`);
      assert.ok(dirty.includes("\x1b[38;5;80m"), `withStatus:false dirty keeps teal: ${JSON.stringify(dirty)}`);
    } finally {
      if (repoDir) rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("m_branch|color:red overrides the status color (default withStatus)", () => {
    // process.cwd() is a real git repo during tests; with |color|red +
    // default withStatus:true the whole span (branch + optional star)
    // is red, NOT the status color.
    const out = renderTemplate(
      ["m_branch|color:red"],
      ctxFor(fakeSnapshot({ cwd: process.cwd() })),
    ).join("\n");
    assert.ok(out.includes("\x1b[38;5;196m"), `got: ${JSON.stringify(out)}`);
    assert.ok(!out.includes("\x1b[38;5;41m"), `no brightGreen (status) should leak: ${JSON.stringify(out)}`);
    assert.ok(!out.includes("\x1b[38;5;130m"), `no brown (status) should leak: ${JSON.stringify(out)}`);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/render-tokens.test.ts 2>&1 | grep -E "withStatus|m_branch|tests [0-9]+|pass [0-9]+|fail [0-9]+" | head -20`
Expected: FAIL — `m_branch|withStatus:false` and `m_branch|color:red` both hit the INLINE_SCHEMAS unknown-arg badarg path (`withStatus` not in the schema → warn + drop → placeholder or literal), and the bare `m_branch` renders plain teal (no status color/star). E.g. `m_branch|withStatus:false` renders `main` WITHOUT teal or with a drop; `withStatus defaults to true` fails because bare `m_branch` has no star/status color.

- [ ] **Step 3: Commit**

```bash
git add src/render-tokens.test.ts
git commit -m "test(render): red tests for m_branch withStatus (clean/dirty color + dirty star)"
```

---

### Task 2: Implement withStatus

**Files:**
- Modify: `src/render.ts` (five edits: `WITHSTATUS_PARAM` constant, `INLINE_SCHEMAS.m_branch`, `m_template` passthrough whitelist, bare `MODULES.m_branch`, `INLINE_RENDERERS.m_branch`)

**Interfaces:**
- Consumes: `readGitInfo` (existing, `src/git-info.ts`), `NAMED_PALETTE.brown` (SGR `38;5;130`, render.ts:3992), `BRIGHT_GREEN` (SGR `38;5;41`), `placeholderBare` / `placeholderWithColor` / `wrapPlainDefault` (existing).
- Produces: `m_branch` satisfying every Task 1 test.

- [ ] **Step 1: Add the `WITHSTATUS_PARAM` constant**

In `src/render.ts`, immediately after the `VALUEONLY_PARAM` constant (which ends at line 4658), add:

```ts
// vX.X.X+ — per-module status-marker override. Accepts "true" or
// "false"; drives m_branch's clean/dirty color + "*" dirty suffix
// (default true). Invalid values → badarg at the inline-args
// resolver (mirrors NULDROP_PARAM / VALUEONLY_PARAM discipline).
const WITHSTATUS_PARAM = {
  named: {
    withStatus: (raw: string): ResolvedValue | null =>
      raw === "true" || raw === "false" ? raw : null,
  },
} as const;
```

- [ ] **Step 2: Extend the `m_branch` INLINE_SCHEMAS entry**

In `src/render.ts`, in the `INLINE_SCHEMAS` map, replace the `m_branch` entry (line 5681):

```ts
  m_branch: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
```

with:

```ts
  m_branch: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...WITHSTATUS_PARAM.named } },
```

- [ ] **Step 3: Add `withStatus` to the `m_template` passthrough whitelist**

In `src/render.ts`, in the `m_template` inline-schema named-args object, after the `...VALUEONLY_PARAM.named,` line (5814), add:

```ts
      ...VALUEONLY_PARAM.named,
      // vX.X.X+ — |withStatus|<true|false> forwarded so an outer
      // m_template|<key>|withStatus:false cascades to every inner
      // m_branch (e.g. a fragment-level opt-out). Default true.
      ...WITHSTATUS_PARAM.named,
    },
```

- [ ] **Step 4: Rewrite the bare `MODULES.m_branch` entry**

In `src/render.ts`, replace the `m_branch` entry (line 2981):

```ts
  m_branch: (c) => readGitInfo(c.tokens?.cwd)?.branch ? wrapPlainDefault("m_branch", readGitInfo(c.tokens!.cwd)!.branch!, undefined) : placeholderBare("m_branch", c),
```

with:

```ts
  // Current git branch. v6.x: cwd missing / not a git repo /
  // detached HEAD now emit "branch:n/a" placeholder (was: drop).
  // vX.X.X+ — |withStatus|<true|false> (default true): when true,
  // the branch renders with clean/dirty color (brightGreen / brown,
  // same as m_gitStatus) and a "*" dirty suffix; when false, the
  // plain teal branch name (pre-vX.X.X behavior). readGitInfo is
  // called once per render (the pre-vX.X.X form called it twice).
  m_branch: (c) => {
    const info = readGitInfo(c.tokens?.cwd);
    if (info?.branch == null) return placeholderBare("m_branch", c);
    if (c.passThrough?.withStatus === "false") {
      return wrapPlainDefault("m_branch", info.branch, undefined);
    }
    const color = info.dirty ? NAMED_PALETTE.brown : BRIGHT_GREEN;
    return wrapPlainDefault("m_branch", `${info.branch}${info.dirty ? "*" : ""}`, color);
  },
```

- [ ] **Step 5: Rewrite the `INLINE_RENDERERS.m_branch` entry**

In `src/render.ts`, replace the `m_branch` inline renderer (lines 6895-6899):

```ts
  m_branch: (params, ctx) => {
    const branch = readGitInfo(ctx.tokens?.cwd)?.branch;
    if (branch == null) return placeholderWithColor("m_branch", params, ctx);
    return wrapPlainDefault("m_branch", branch, params.color as string | undefined);
  },
```

with:

```ts
  m_branch: (params, ctx) => {
    const info = readGitInfo(ctx.tokens?.cwd);
    if (info?.branch == null) return placeholderWithColor("m_branch", params, ctx);
    if (params.withStatus === "false") {
      return wrapPlainDefault("m_branch", info.branch, params.color as string | undefined);
    }
    const color = params.color ?? (info.dirty ? NAMED_PALETTE.brown : BRIGHT_GREEN);
    return wrapPlainDefault("m_branch", `${info.branch}${info.dirty ? "*" : ""}`, color);
  },
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test 2>&1 | tail -6`
Expected: `tests 1122`, `pass 1122`, `fail 0` (1119 existing + 3 new m_branch tests).

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: no output (clean).

- [ ] **Step 8: Commit**

```bash
git add src/render.ts
git commit -m "feat(render): m_branch withStatus (default true) — clean/dirty color + dirty '*' suffix"
```

---

### Task 3: Build + local deploy + smoke check

**Files:**
- Modify: none (build artifact only)

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
grep -c 'withStatus' "${HIGHEST}dist/index.js"
grep -c '38;5;130' "${HIGHEST}dist/index.js"
```

Expected: both counts `> 0` (`withStatus` = the new param wiring; `38;5;130` = the brown SGR now used by the bare m_branch default path).

- [ ] **Step 4: Confirm working tree is clean**

Run: `git status --short`
Expected: empty (all changes committed).
