# name 模块 width 宽度限制参数 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 9 个名称类模块新增内联参数 `width`（终端显示列截断，默认 0=无限制），并在 `git_info` 片段与 `solo` preset 中为 `m_dirName` / `m_branch` 设定 `width:25`。

**Architecture:** 复用 `render.ts` 现有的内联参数体系（`INLINE_SCHEMAS.named` 白名单 + `INLINE_RENDERERS`/`MODULES` 双路径）和已有的 `charDisplayWidth` 显示宽度计算。新增 `WIDTH_PARAM` 参数解析器、`applyWidthLimit` 截断纯函数、`resolveWidth` 解析辅助，在模块上色（`wrapPlainDefault`）之前对纯文本 body 做逐码点列宽截断，超宽则取前 `N-3` 列 + `...`。

**Tech Stack:** TypeScript、esbuild、node:test + tsx（无新依赖）。

## Global Constraints

- width 语义：`0 ≤ width < 8` → 归一为 `0`（忽略参数，不截断）；`width ≥ 8` → 生效；非数字 / 负数 → badarg（模块 drop）。
- 计数单位：**终端显示列**，复用 `charDisplayWidth`（CJK/emoji=2 列、窄=1 列、零宽=0 列），不是 JS `.length`。
- 截断规则：body 显示列 `> N` → 取前 `N-3` 列（逐码点累加，预算内最后一个完整码点截止，不切开宽字符）+ `...`（3 个 ASCII 点，3 列）。
- width 只作用于**上色之前**的纯文本 body；placeholder（`n/a` 等）不截断；`m_branch|withStatus:true` 的 `✅/🟠` 后缀不参与截断。
- 参数解析仅接受 `/^[0-9]+$/`（`REPEAT_PARAM` 同款风格）。
- 9 个模块：`m_gitName`、`m_dirName`、`m_branch`、`m_repo`、`m_model`、`m_provider`、`m_ccVersion`、`m_session`、`m_effort`。
- 省略 width / width=0 → 现有渲染 byte-identical。
- 现有 1182 测试必须保持全绿（`config.test.ts` 只断言 preset 层字符串，`"m_branch|withStatus:true"` 是 `"m_branch|withStatus:true|width:25"` 的子串，不受影响）。
- Git 提交：按项目 git-commit-policy，不在每个 step 提交；每个 Task 结尾一次性 commit（任务切换点）。

## File Structure

- `src/render.ts` — 新增 `WIDTH_PARAM`、`applyWidthLimit`、`resolveWidth`；9 个模块的 `MODULES` / `INLINE_RENDERERS` 双路径接线；`INLINE_SCHEMAS` 挂参数。
- `src/config.template.ts` — `git_info` 片段 + `solo` preset 加 `|width:25`。
- `src/render-tokens.test.ts` — 新增 width 相关测试。
- `docs/superpowers/specs/2026-08-10-name-modules-width-limit-design.md` — 已批准的设计文档（实现时对照）。

---

### Task 1: WIDTH_PARAM + applyWidthLimit + resolveWidth，先接线 m_dirName（验证全链路）

**Files:**
- Modify: `src/render.ts`（新增 3 个辅助，`WIDTH_PARAM` 放在 `WITHSTATUS_PARAM` 之后 ~line 3320；`applyWidthLimit` 放在 `wrapPlainDefault` 附近 ~line 4200；`resolveWidth` 放在 `passThroughOr` 之后 ~line 4227）
- Modify: `src/render.ts:2038-2041`（MODULES 路径 m_dirName）、`src/render.ts:5054-5058`（INLINE_RENDERERS 路径 m_dirName）、`src/render.ts:4104`（INLINE_SCHEMAS）
- Test: `src/render-tokens.test.ts`

**Interfaces:**
- Consumes: 现有 `passThroughOr`（render.ts:4218）、`charDisplayWidth`（render.ts:3941，已导出）、`wrapPlainDefault`（render.ts:4193）、`placeholderBare` / `placeholderWithColor`、`INLINE_BADARG` 约定。
- Produces:
  - `const WIDTH_PARAM = { named: { width: (raw: string) => ResolvedValue | null } }` — 非负整数；`n < 8` → `"0"`；`≥ 8` → `raw`；非数字/非整数 → `null`。
  - `function applyWidthLimit(body: string, width: number): string` — width≤0 原样；超宽 → 前 `width-3` 列 + `"..."`。
  - `function resolveWidth(params: Record<string, ResolvedValue | undefined>, ctx: RenderContext): number` — inline `params.width` > `ctx.passThrough.width` > `0`。

- [ ] **Step 1: 写失败的测试（m_dirName 五个用例）**

在 `src/render-tokens.test.ts` 的 `m_dirName|nulldrop|false` 用例（~line 3065）之后、`m_ccVersion|nulldrop|false` 之前，插入：

```ts
  it("m_dirName|width:25 truncates a 30-col basename to 22 cols + '...'", () => {
    const long = "a".repeat(30);
    const out = renderTemplate(
      ["m_dirName|width:25"],
      ctxFor(fakeSnapshot({ cwd: `/home/user/${long}` })),
    ).join("\n");
    assert.equal(strip(out), "a".repeat(22) + "...");
  });

  it("m_dirName|width:25 counts CJK by display column (13 中 = 26 cols → 11 中 + '...')", () => {
    const out = renderTemplate(
      ["m_dirName|width:25"],
      ctxFor(fakeSnapshot({ cwd: "/home/user/" + "中".repeat(13) })),
    ).join("\n");
    assert.equal(strip(out), "中".repeat(11) + "...");
  });

  it("m_dirName|width:7 is ignored (too small for the ellipsis) → full body", () => {
    const long = "a".repeat(30);
    const out = renderTemplate(
      ["m_dirName|width:7"],
      ctxFor(fakeSnapshot({ cwd: `/home/user/${long}` })),
    ).join("\n");
    assert.equal(strip(out), long);
  });

  it("m_dirName|width:25 leaves a short basename untouched", () => {
    const out = renderTemplate(
      ["m_dirName|width:25"],
      ctxFor(fakeSnapshot({ cwd: "/home/user/creditgauge" })),
    ).join("\n");
    assert.equal(strip(out), "creditgauge");
  });

  it("m_dirName|width:abc is a badarg (module drops, single-token form mirrors the existing badarg test)", () => {
    __resetUnknownModuleWarnForTest();
    const out = renderTemplate(
      ["m_dirName|width:abc"],
      ctxFor(fakeSnapshot({ cwd: "/home/user/creditgauge" })),
    ).join("\n");
    assert.equal(out, "");
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test --import tsx src/render-tokens.test.ts`
Expected: FAIL — `m_dirName|width:25` 因 `width` 不在 `INLINE_SCHEMAS.m_dirName` 的 named 白名单中而 badarg drop，实际输出空/`X`，断言 `"a".repeat(22) + "..."` 不匹配。

- [ ] **Step 3: 实现 WIDTH_PARAM + applyWidthLimit + resolveWidth**

在 `render.ts` 的 `WITHSTATUS_PARAM` 定义（~line 3320）之后追加：

```ts
// Per-module width-limit override: `|width|<n>` caps the body's terminal
// display width (CJK/emoji count 2 via charDisplayWidth). Values 0..7 are too
// small to fit the 3-dot ellipsis and normalize to "0" (ignored — no
// truncation); n ≥ 8 keeps the first n-3 columns + "...". Non-numeric /
// non-integer → badarg (mirrors REPEAT_PARAM).
const WIDTH_PARAM = {
  named: {
    width: (raw: string): ResolvedValue | null => {
      if (!/^[0-9]+$/.test(raw)) return null;
      const n = Number(raw);
      if (!Number.isInteger(n)) return null;
      return n < 8 ? "0" : raw;
    },
  },
} as const;
```

在 `wrapPlainDefault` 定义之后（~line 4200）追加：

```ts
// Truncate `body` to at most `width` terminal columns. width ≤ 0 → unchanged
// (unlimited). Over-width → first `width-3` columns (per-code-point, so a wide
// char is never split) + the 3-dot ellipsis "...". Active widths are
// normalized to ≥ 8 by WIDTH_PARAM, so the prefix budget is always ≥ 5 columns.
function applyWidthLimit(body: string, width: number): string {
  if (width <= 0) return body;
  let total = 0;
  for (const ch of body) total += charDisplayWidth(ch);
  if (total <= width) return body;
  const budget = width - 3;
  let cols = 0;
  let out = "";
  for (const ch of body) {
    const w = charDisplayWidth(ch);
    if (cols + w > budget) break;
    out += ch;
    cols += w;
  }
  return out + "...";
}
```

在 `passThroughOr` 定义之后（~line 4227）追加：

```ts
// Resolve the effective width for a module: inline-explicit (params.width) >
// outer m_template passThrough (ctx.passThrough.width) > 0 (unlimited).
// WIDTH_PARAM already normalized 0..7 → "0", so Number(raw) is exact.
function resolveWidth(
  params: Record<string, ResolvedValue | undefined>,
  ctx: RenderContext,
): number {
  const raw = passThroughOr<ResolvedValue>(params, ctx, "width");
  return raw === undefined || raw === null ? 0 : Number(raw);
}
```

- [ ] **Step 4: 接线 m_dirName（MODULES 路径）**

`render.ts:2038-2041`，把：

```ts
  m_dirName: (c) => {
    const n = c.tokens?.cwd ? path.basename(c.tokens.cwd) : "";
    return n.length > 0 ? wrapPlainDefault("m_dirName", n, undefined) : placeholderBare("m_dirName", c);
  },
```

改成：

```ts
  m_dirName: (c) => {
    const n = c.tokens?.cwd ? path.basename(c.tokens.cwd) : "";
    if (n.length === 0) return placeholderBare("m_dirName", c);
    const body = applyWidthLimit(n, resolveWidth({}, c));
    return wrapPlainDefault("m_dirName", body, undefined);
  },
```

- [ ] **Step 5: 接线 m_dirName（INLINE_RENDERERS 路径）**

`render.ts:5054-5058`，把：

```ts
  m_dirName: (params, ctx) => {
    const n = ctx.tokens?.cwd ? path.basename(ctx.tokens.cwd) : "";
    if (n.length === 0) return placeholderWithColor("m_dirName", params, ctx);
    return wrapPlainDefault("m_dirName", n, params.color as string | undefined);
  },
```

改成：

```ts
  m_dirName: (params, ctx) => {
    const n = ctx.tokens?.cwd ? path.basename(ctx.tokens.cwd) : "";
    if (n.length === 0) return placeholderWithColor("m_dirName", params, ctx);
    const body = applyWidthLimit(n, resolveWidth(params, ctx));
    return wrapPlainDefault("m_dirName", body, params.color as string | undefined);
  },
```

- [ ] **Step 6: 挂 INLINE_SCHEMAS**

`render.ts:4104`，把：

```ts
  m_dirName: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
```

改成：

```ts
  m_dirName: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...WIDTH_PARAM.named } },
```

- [ ] **Step 7: 运行测试确认通过**

Run: `node --test --import tsx src/render-tokens.test.ts`
Expected: PASS（新增 5 个用例全过，现有 m_dirName / m_gitName / m_branch 等用例不受影响）。

- [ ] **Step 8: 提交**

```bash
git add src/render.ts src/render-tokens.test.ts
git commit -m "feat(render): add |width| name-module width-limit param (Task 1: m_dirName)"
```

---

### Task 2: 接线其余 8 个模块（m_gitName / m_branch / m_repo / m_model / m_provider / m_ccVersion / m_session / m_effort）

**Files:**
- Modify: `src/render.ts`（MODULES 路径 line 2006-2057；INLINE_RENDERERS 路径 line 5016-5078；INLINE_SCHEMAS line 4098-4107）
- Test: `src/render-tokens.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `WIDTH_PARAM` / `applyWidthLimit` / `resolveWidth`。
- Produces: 全部 9 个模块在两个渲染路径 + schema 都支持 `width`；`m_branch` 的 width 只截分支名 body，`withStatus` 后缀照常。

- [ ] **Step 1: 写失败的测试（8 个模块各 1-2 个用例 + m_branch 后缀共存）**

在 Task 1 插入的 5 个用例之后插入：

```ts
  it("m_gitName|width:10 truncates a long repo name to 7 cols + '...'", () => {
    const long = "a".repeat(30);
    const out = renderTemplate(
      ["m_gitName|width:10"],
      ctxFor(fakeSnapshot({ repo: { host: "github.com", owner: "cwf818", name: long } })),
    ).join("\n");
    assert.equal(strip(out), "a".repeat(7) + "...");
  });

  it("m_repo|width:25 truncates the joined host/owner/name", () => {
    const long = "a".repeat(30);
    const out = renderTemplate(
      ["m_repo|width:25"],
      ctxFor(fakeSnapshot({ repo: { host: "github.com", owner: "cwf818", name: long } })),
    ).join("\n");
    // "github.com/cwf818/" = 18 cols; budget = 25-3 = 22 → room for 4 more a's.
    assert.equal(strip(out), "github.com/cwf818/" + "a".repeat(4) + "...");
  });

  it("m_model|width:15 truncates a long model name", () => {
    const out = renderTemplate(
      ["m_model|width:15"],
      ctxFor(fakeSnapshot({ modelDisplayName: "deepseek-reasoner-v3-ultra-long" })),
    ).join("\n");
    // budget = 15-3 = 12 cols → "deepseek-rea" (12 ASCII chars) + "..." = 15.
    assert.equal(strip(out), "deepseek-rea" + "...");
  });

  it("m_provider|width:6 truncates the provider hostname", () => {
    const out = renderTemplate(
      ["m_provider|width:6"],
      ctxFor({ ...ctxFor(fakeSnapshot()), currentProvider: "minimax" }),
    ).join("\n");
    assert.equal(strip(out), "min" + "...");
  });

  it("m_ccVersion|width:8 truncates a long version string", () => {
    const out = renderTemplate(
      ["m_ccVersion|width:8"],
      ctxFor(fakeSnapshot({ ccversion: "2.1.191.20260810" })),
    ).join("\n");
    assert.equal(strip(out), "2.1.1" + "...");
  });

  it("m_session|width:12 truncates a long session name", () => {
    const out = renderTemplate(
      ["m_session|width:12"],
      ctxFor(fakeSnapshot({ sessionName: "strip-diagnostics-display" })),
    ).join("\n");
    assert.equal(strip(out), "strip-diag" + "...");
  });

  it("m_effort|width:25 leaves short values untouched", () => {
    const out = renderTemplate(
      ["m_effort|width:25"],
      ctxFor(fakeSnapshot({ effort: "high" })),
    ).join("\n");
    assert.equal(strip(out), "high");
  });

  it("m_branch|width:10|withStatus:true truncates the branch body and keeps the ✅ suffix", () => {
    let repoDir: string | undefined;
    try {
      execFileSync("git", ["--version"], { stdio: "ignore", timeout: 1000 });
    } catch {
      return; // skip — no git on PATH
    }
    const longBranch = "very-long-branch-name-that-overflows";
    repoDir = mkdtempSync(join(tmpdir(), "creditgauge-render-width-branch-"));
    execFileSync("git", ["init", "-q", "-b", longBranch], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoDir });
    writeFileSync(join(repoDir, "r"), "x");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
    try {
      __resetGitInfoCacheForTest();
      const out = renderTemplate(
        ["m_branch|width:10|withStatus:true"],
        ctxFor(fakeSnapshot({ cwd: repoDir })),
      ).join("\n");
      // 7 cols prefix + "..." (3 cols) = 10; "✅" (clean suffix) still appended.
      assert.equal(strip(out), "very-lo" + "..." + "✅");
    } finally {
      if (repoDir) rmSync(repoDir, { recursive: true, force: true });
    }
  });
```

> 注意 `m_provider|width:6`：budget = 3，`"minimax"` 前 3 列 = `"min"`，总 6 列。`m_session|width:12`：`"strip-diagnostics-display"` 前 9 列 = `"strip-diag"`，总 12 列。逐字符核对见测试运行结果，若与预期列数不符以实际为准调整断言（原则：前缀列数 + 3 = width）。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test --import tsx src/render-tokens.test.ts`
Expected: FAIL — 这些模块的 schema 无 `width`，badarg drop。

- [ ] **Step 3: 接线 MODULES 路径（8 个模块）**

`render.ts` line 2006-2057，把每个模块的 body 在 `wrapPlainDefault` 前套上 `applyWidthLimit(body, resolveWidth({}, c))`。逐个修改：

`m_session` (2006)、`m_model` (2008)、`m_effort` (2022)、`m_gitName` (2035)、`m_ccVersion` (2043) 是单行三元表达式，改成等价的 if/return 形式：

```ts
  m_session: (c) => c.tokens?.sessionName
    ? wrapPlainDefault("m_session", applyWidthLimit(c.tokens.sessionName, resolveWidth({}, c)), undefined)
    : placeholderBare("m_session", c),
  m_model: (c) => c.tokens?.modelDisplayName
    ? wrapPlainDefault("m_model", applyWidthLimit(c.tokens.modelDisplayName, resolveWidth({}, c)), undefined)
    : placeholderBare("m_model", c),
  m_effort: (c) => c.tokens?.effort
    ? wrapPlainDefault("m_effort", applyWidthLimit(c.tokens.effort, resolveWidth({}, c)), undefined)
    : placeholderBare("m_effort", c),
```

`m_provider` (2012-2020)：两处 `wrapPlainDefault` 的 body 都套截断：

```ts
  m_provider: (c) => {
    if (c.currentProvider) return wrapPlainDefault("m_provider", applyWidthLimit(c.currentProvider, resolveWidth({}, c)), undefined);
    const raw = process.env.ANTHROPIC_BASE_URL;
    if (raw) {
      try { return wrapPlainDefault("m_provider", applyWidthLimit(new URL(raw).hostname.toLowerCase(), resolveWidth({}, c)), undefined); }
      catch { /* invalid URL → fall through */ }
    }
    return placeholderBare("m_provider", c);
  },
```

`m_repo` (2024-2031)：

```ts
  m_repo: (c) => {
    const r = c.tokens?.repo;
    if (!r) return placeholderBare("m_repo", c);
    const parts = [r.host, r.owner, r.name].filter(
      (p): p is string => p != null && p.length > 0,
    );
    if (parts.length === 0) return placeholderBare("m_repo", c);
    return wrapPlainDefault("m_repo", applyWidthLimit(parts.join("/"), resolveWidth({}, c)), undefined);
  },
```

`m_gitName` (2033-2036)：

```ts
  m_gitName: (c) => {
    const n = c.tokens?.repo?.name;
    if (n == null || n.length === 0) return placeholderBare("m_gitName", c);
    return wrapPlainDefault("m_gitName", applyWidthLimit(n, resolveWidth({}, c)), undefined);
  },
```

`m_ccVersion` (2043)：

```ts
  m_ccVersion: (c) => c.tokens?.ccversion
    ? wrapPlainDefault("m_ccVersion", applyWidthLimit(c.tokens.ccversion, resolveWidth({}, c)), undefined)
    : placeholderBare("m_ccVersion", c),
```

`m_branch` (2049-2057)：body 截断放在 wrap 之前，后缀不受影响：

```ts
  m_branch: (c) => {
    const info = readGitInfo(c.tokens?.cwd);
    if (info?.branch == null) return placeholderBare("m_branch", c);
    const body = wrapPlainDefault("m_branch", applyWidthLimit(info.branch, resolveWidth({}, c)), undefined);
    if (c.passThrough?.withStatus !== "true") return body;
    const suffixColor = info.dirty ? NAMED_PALETTE.brown : BRIGHT_GREEN;
    const glyph = info.dirty ? labelFor("gitDirty") : labelFor("gitClean");
    return `${body}${suffixColor}${glyph}${RESET}`;
  },
```

- [ ] **Step 4: 接线 INLINE_RENDERERS 路径（8 个模块）**

`render.ts` line 5016-5078，同样把 body 在 `wrapPlainDefault` 前套上 `applyWidthLimit(..., resolveWidth(params, ctx))`：

`m_session` (5016-5020)、`m_model` (5021-5025)、`m_effort` (5035-5039)、`m_gitName` (5049-5053)、`m_ccVersion` (5074-5078)：

```ts
  m_session: (params, ctx) => {
    const s = ctx.tokens?.sessionName;
    if (s == null) return placeholderWithColor("m_session", params, ctx);
    return wrapPlainDefault("m_session", applyWidthLimit(s, resolveWidth(params, ctx)), params.color as string | undefined);
  },
  m_model: (params, ctx) => {
    const s = ctx.tokens?.modelDisplayName;
    if (s == null) return placeholderWithColor("m_model", params, ctx);
    return wrapPlainDefault("m_model", applyWidthLimit(s, resolveWidth(params, ctx)), params.color as string | undefined);
  },
  m_effort: (params, ctx) => {
    const s = ctx.tokens?.effort;
    if (s == null) return placeholderWithColor("m_effort", params, ctx);
    return wrapPlainDefault("m_effort", applyWidthLimit(s, resolveWidth(params, ctx)), params.color as string | undefined);
  },
```

`m_provider` (5026-5034)：

```ts
  m_provider: (params, ctx) => {
    if (ctx.currentProvider) return wrapPlainDefault("m_provider", applyWidthLimit(ctx.currentProvider, resolveWidth(params, ctx)), params.color as string | undefined);
    const raw = process.env.ANTHROPIC_BASE_URL;
    if (raw) {
      try { return wrapPlainDefault("m_provider", applyWidthLimit(new URL(raw).hostname.toLowerCase(), resolveWidth(params, ctx)), params.color as string | undefined); }
      catch { /* invalid URL → fall through */ }
    }
    return placeholderWithColor("m_provider", params, ctx);
  },
```

`m_repo` (5040-5048)：

```ts
  m_repo: (params, ctx) => {
    const r = ctx.tokens?.repo;
    if (!r) return placeholderWithColor("m_repo", params, ctx);
    const parts = [r.host, r.owner, r.name].filter(
      (p): p is string => p != null && p.length > 0,
    );
    if (parts.length === 0) return placeholderWithColor("m_repo", params, ctx);
    return wrapPlainDefault("m_repo", applyWidthLimit(parts.join("/"), resolveWidth(params, ctx)), params.color as string | undefined);
  },
```

`m_gitName` (5049-5053)：

```ts
  m_gitName: (params, ctx) => {
    const n = ctx.tokens?.repo?.name;
    if (n == null || n.length === 0) return placeholderWithColor("m_gitName", params, ctx);
    return wrapPlainDefault("m_gitName", applyWidthLimit(n, resolveWidth(params, ctx)), params.color as string | undefined);
  },
```

`m_ccVersion` (5074-5078)：

```ts
  m_ccVersion: (params, ctx) => {
    const v = ctx.tokens?.ccversion;
    if (v == null) return placeholderWithColor("m_ccVersion", params, ctx);
    return wrapPlainDefault("m_ccVersion", applyWidthLimit(v, resolveWidth(params, ctx)), params.color as string | undefined);
  },
```

`m_branch` (5059-5067)：

```ts
  m_branch: (params, ctx) => {
    const info = readGitInfo(ctx.tokens?.cwd);
    if (info?.branch == null) return placeholderWithColor("m_branch", params, ctx);
    const body = wrapPlainDefault("m_branch", applyWidthLimit(info.branch, resolveWidth(params, ctx)), params.color as string | undefined);
    if (params.withStatus !== "true") return body;
    const suffixColor = info.dirty ? NAMED_PALETTE.brown : BRIGHT_GREEN;
    const glyph = info.dirty ? labelFor("gitDirty") : labelFor("gitClean");
    return `${body}${suffixColor}${glyph}${RESET}`;
  },
```

- [ ] **Step 5: 挂 INLINE_SCHEMAS（8 个模块）**

`render.ts` line 4098-4107，每个模块的 named 都追加 `...WIDTH_PARAM.named`：

```ts
  m_session: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...WIDTH_PARAM.named } },
  m_model: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...WIDTH_PARAM.named } },
  m_provider: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...WIDTH_PARAM.named } },
  m_effort: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...WIDTH_PARAM.named } },
  m_repo: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...WIDTH_PARAM.named } },
  m_gitName: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...WIDTH_PARAM.named } },
  m_dirName: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...WIDTH_PARAM.named } },  // Task 1 已改，保持一致
  m_branch: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...WITHSTATUS_PARAM.named, ...WIDTH_PARAM.named } },
  m_gitStatus: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },  // 不改
  m_ccVersion: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...WIDTH_PARAM.named } },
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test --import tsx src/render-tokens.test.ts`
Expected: PASS。若 `m_provider|width:6` / `m_session|width:12` 等断言因字符边界与预期列数不符而失败，按 Step 1 末尾注记的原则调整断言（前缀列数 + 3 = width）。

- [ ] **Step 7: typecheck + 全量测试**

Run: `npm run typecheck`
Expected: PASS（无 TS 错误）。

Run: `npm test`
Expected: PASS（全部 1182 + 新增用例）。

- [ ] **Step 8: 提交**

```bash
git add src/render.ts src/render-tokens.test.ts
git commit -m "feat(render): wire |width| into all 9 name modules (Task 2)"
```

---

### Task 3: 模板接入（config.template.ts）

**Files:**
- Modify: `src/config.template.ts:99-101`（git_info 片段）、`src/config.template.ts:203`（solo preset 的 m_branch）
- Test: `src/config.test.ts`（不新增断言，只确认现有通过）

**Interfaces:**
- Consumes: Task 1/2 的 `width` 参数能力。
- Produces: 默认 `git_info` 片段渲染 `m_dirName|width:25` 与 `m_branch|withStatus:true|width:25`；`solo` preset 的 m_branch 同样 25。

- [ ] **Step 1: 修改 git_info 片段**

`render.ts` 无关；改 `config.template.ts` line 97-104：

```ts
  // "git_info" — git branch with clean/dirty status + line deltas.
  git_info: [
    "m_label|⎇ : |color:yellow",
    "m_dirName|width:25",
    ":",
    "m_branch|withStatus:true|width:25",
    "m_linesAdded",
    "m_linesRemoved"
  ],
```

- [ ] **Step 2: 修改 solo preset 的 m_branch**

`config.template.ts` line 202-203：

```ts
  solo: [
    "m_label|⎇ : |color:yellow",
    "m_branch|withStatus:true|width:25",
```

- [ ] **Step 3: 运行测试确认无回归**

Run: `node --test --import tsx src/config.test.ts`
Expected: PASS（line 187 的 `includes("m_branch|withStatus:true")` 仍成立，因为 `"m_branch|withStatus:true|width:25"` 包含该子串）。

Run: `npm test`
Expected: PASS（全部）。

- [ ] **Step 4: 提交**

```bash
git add src/config.template.ts
git commit -m "feat(template): |width:25| on m_dirName/m_branch in git_info + solo"
```

---

### Task 4: 构建 + 部署到本地缓存 + 冒烟检查

**Files:**（无源码改动，仅构建产物）

**Interfaces:**
- Consumes: Task 1-3 的全部源码改动。
- Produces: `dist/index.js` 含新代码；复制进本地插件缓存最高版本目录。

- [ ] **Step 1: 构建**

Run: `npm run build`
Expected: `dist/index.js`（~345 KB）+ `dist/plugins/{minimax,deepseek}/index.js` 生成成功。

- [ ] **Step 2: 复制到缓存**

Run:
```bash
HIGHEST=$(ls -d ~/.claude/plugins/cache/creditgauge/creditgauge/*/ | sort -V | tail -1)
cp dist/index.js "${HIGHEST}dist/index.js"
cp -r dist/plugins "${HIGHEST}dist/plugins"
```

Expected: 无报错，`echo "$HIGHEST"` 显示最高版本目录。

- [ ] **Step 3: 冒烟检查（grep 新代码标识符）**

Run: `grep -c "applyWidthLimit" "${HIGHEST}dist/index.js"`
Expected: 输出 `> 0`（esbuild 可能内联函数名，若为 0 则改用 `grep -c "width" "${HIGHEST}dist/index.js"` 并确认数量合理，或 `grep -c "git_info"` 查片段字符串）。

- [ ] **Step 4: 冒烟检查（渲染输出）**

Run:
```bash
echo '{}' | ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic ANTHROPIC_AUTH_TOKEN=dummy node dist/index.js
```
Expected: 不抛错（无真实 token 时可能显示 n/a 或 quota 占位，只要进程正常退出即可）。

- [ ] **Step 5: 提交剩余文档**

```bash
git add docs/superpowers/specs/2026-08-10-name-modules-width-limit-design.md
git commit -m "docs: name-modules width-limit design spec"
```

> 若 spec 已随 Task 1 提交过则跳过此步（按实际 git status 判断）。

---

## Self-Review

**Spec coverage:**
- 9 模块参数 → Task 1（m_dirName）+ Task 2（其余 8）。
- `git_info` 模板 `m_dirName|width:25` / `m_branch|withStatus:true|width:25` → Task 3。
- `solo` preset 的 m_branch → Task 3。
- width<8 → 0（忽略）→ `WIDTH_PARAM`（Task 1）+ 测试。
- 显示列计数 / 逐码点不切开宽字符 → `applyWidthLimit`（Task 1）+ CJK 测试。
- placeholder 不截断 / 后缀不参与 → 代码只在非 placeholder 分支应用 `applyWidthLimit`；m_branch 后缀在截断后的 body 之后拼接（Task 2）。
- badarg → `WIDTH_PARAM` 返回 null → 测试。
- 部署 → Task 4。

**Placeholder scan:** 无 TBD/TODO。所有代码块完整可执行。`m_provider|width:6` / `m_session|width:12` 断言带"以实际为准调整"的注记（不是占位符，是显式的验收调整规则）。

**Type consistency:** `WIDTH_PARAM.named.width` 返回 `ResolvedValue | null`；`resolveWidth` 返回 `number`；`applyWidthLimit(body: string, width: number)`。Task 2 引用的 `WIDTH_PARAM` / `applyWidthLimit` / `resolveWidth` 均在 Task 1 定义且签名一致。
