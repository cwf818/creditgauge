# m_quota valueOnly 支持 + 格式调整 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `m_quota` 加 `valueOnly` 参数支持,并将输出格式从 `quota:<axis>/<total>(<label>)` 改为 `quota: <axis>/<total>`(valueOnly 时 `<axis>/<total>`)。

**Architecture:** 复用现有 valueOnly 模式:`VALUEONLY_PARAM` 进 INLINE_SCHEMA,两条渲染路径(MODULES + INLINE_RENDERERS)把 valueOnly 标志传进 `wrapQuotaBody`,`placeholderQuota` 读 `params.valueOnly` / `ctx.passThrough?.valueOnly`。格式变化通过删掉 `renderQuotaParts` 返回的 `label` 字段 + 默认 `labelQuota` 加尾随空格实现。

**Tech Stack:** TypeScript / esbuild / node:test + tsx。

## Global Constraints

- `m_quota` schema 只允许 `color / display / term / nulldrop / valueOnly`(其余 named 参数 → badarg → warn + drop)。
- 颜色规则不变:digit 用 `colorFor(axisPct, mode)` band tint;`userColor` 覆盖赢;`axisPct == null` → STALE_COLOR;`/total` 永远 plain。
- 默认 quota fragment(`config.template.ts:66`)的 `valueOnly:true` **保留不动**(选项 A)→ 默认渲染 `1499.4/1500`。
- 不 bump 版本号(1.2.0 保持);minimal deploy 覆盖 cache bundle。
- `renderQuotaParts` 返回的 `label` 字段是死代码 → 删除(返回类型 + **8** 处 return——注意 spec 里写的 7 是笔误)。

---

### Task 1: m_quota 格式调整 — 去掉 `(label)` 尾缀 + 默认 label 加尾随空格

**Files:**
- Modify: `src/render.ts:569-659` (renderQuotaParts — 删 `label` 字段), `src/render.ts:670-691` (wrapQuotaBody), `src/render.ts:4826-4847` (placeholderQuota), 若干注释 (`:99`, `:180`, `:223-225`, `:548-554`, `:581`, `:689`, `:4829-4844`)
- Modify: `src/config.ts:348-352` (注释), `src/config.ts:520` (`labelQuota` 默认值)
- Test: `src/render.test.ts` (m_quota 断言更新)

**Interfaces:**
- Consumes: 无(Task 1 是纯格式变化)
- Produces: `wrapQuotaBody(parts, mode, userColor, valueOnly?)` 新签名;`renderQuotaParts` 返回类型去掉 `label`;`placeholderQuota(params, ctx)` 不再读 `label`。Task 2 依赖这些签名。

- [ ] **Step 1: 更新 render.test.ts 断言到新格式(先写失败的测试)**

把下列断言从 `quota:.../...(30d)` 改为 `quota: .../...`、`quota:n/a(7d)` 改为 `quota: n/a`。逐处(按出现顺序):

| 行 | 旧 | 新 |
|---|---|---|
| 1513 | `clean.includes("quota:n/a(7d)")` | `clean.includes("quota: n/a")` |
| 1546 | `clean.includes("quota:n/a(30d)")` | `clean.includes("quota: n/a")` |
| 1575 | `clean.includes("quota:n/a(7d)")` | `clean.includes("quota: n/a")` |
| 1664 | `clean.includes("quota:0/1500(30d)")` | `clean.includes("quota: 0/1500")` |
| 1665 | `` `expected quota:0/1500(30d), got: ${clean}` `` | `` `expected quota: 0/1500, got: ${clean}` `` |
| 1681 | `clean.includes("quota:765/1500(30d)")` | `clean.includes("quota: 765/1500")` |
| 1682 | `` `expected quota:765/1500(30d) (used = limit - remaining), got: ${clean}` `` | `` `expected quota: 765/1500 (used = limit - remaining), got: ${clean}` `` |
| 1702 | `clean.includes("quota:42/1500(30d)")` | `clean.includes("quota: 42/1500")` |
| 1717 | `clean.includes("quota:0/1500(30d)")` | `clean.includes("quota: 0/1500")` |
| 1733 | `clean.includes("quota:0/1500(30d)")` | `clean.includes("quota: 0/1500")` |
| 1799 | `clean.includes("quota:765/1500(30d)")` | `clean.includes("quota: 765/1500")` |
| 1817 | `clean.includes("quota:735/1500(30d)")` | `clean.includes("quota: 735/1500")` |
| 1821 | `!clean.includes("quota:765/1500(30d)")` | `!clean.includes("quota: 765/1500")` |
| 1840 | `clean.includes("quota:735/1500(30d)")` | `clean.includes("quota: 735/1500")` |
| 1860 | `clean.includes("quota:1500/1500(30d)")` | `clean.includes("quota: 1500/1500")` |
| 1879 | `clean.includes("quota:0/1500(30d)")` | `clean.includes("quota: 0/1500")` |

顺带更新测试标题与注释中字面的旧形状:
- 1494 标题 `…reads 'quota:n/a(7d)'…` → `…reads 'quota: n/a'…`
- 1530 标题 `…reads 'quota:n/a(30d)'…` → `…reads 'quota: n/a'…`
- 1554 标题 `…uses the live midInterval.label when present` → `…renders 'quota: n/a' regardless of the live interval's label`;1556-1557 注释同步
- 1400 注释 `m_quota → "quota:n/a(<label>)"` → `m_quota → "quota: n/a"`

band-color 测试(`1975-2180`)用 `line.includes(`${COLOR}digit${RESET}/total`)` 子串断言,**不需要改**(旧 `(30d)` 尾缀不影响子串匹配;prefix-plainness 检查在 `:1988-1992`,新格式下依旧无 SGR 前缀)。默认模板测试(`renderQuotaLine` 345-389)因 `nulldrop:true` 在无 quota 数据时 drop m_quota,也不受影响。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test --import tsx src/render.test.ts`
Expected: m_quota 相关 case FAIL(代码仍输出 `quota:0/1500(30d)`,测试期望 `quota: 0/1500`)。

- [ ] **Step 3: 实现格式变化**

**3a. `renderQuotaParts`(`src/render.ts:569-659`)**:删返回类型里的 `label: string;`,删函数体 `const label = iv.label;`,删全部 8 处 return 的 `label,`。新函数:

```ts
function renderQuotaParts(
  iv: Interval,
  mode: DisplayMode = "used",
): {
  prefix: string;
  axisNumber: number;    // the displayed digit
  total: number | null;  // the right side ("1500" or "--")
  axisPct: number | null;// 0..100 of the displayed digit relative to limit
} | null {
  const prefix = labelFor("quota");

  if (mode === "remaining") {
    if (iv.remainingQuota != null && iv.limitQuota != null) {
      return {
        prefix,
        axisNumber: iv.remainingQuota,
        total: iv.limitQuota,
        axisPct: (iv.remainingQuota / iv.limitQuota) * 100,
      };
    }
    if (iv.usedQuota != null && iv.limitQuota != null) {
      const remaining = iv.limitQuota - iv.usedQuota;
      const clamped = Math.max(0, Math.min(iv.limitQuota, remaining));
      return {
        prefix,
        axisNumber: clamped,
        total: iv.limitQuota,
        axisPct: (clamped / iv.limitQuota) * 100,
      };
    }
    if (iv.limitQuota != null) {
      return {
        prefix,
        axisNumber: iv.limitQuota,
        total: iv.limitQuota,
        axisPct: 100, // nothing used ⇒ full remaining
      };
    }
    if (iv.remainingQuota != null) {
      return {
        prefix,
        axisNumber: iv.remainingQuota,
        total: null,
        axisPct: null, // no limit → no ratio possible
      };
    }
    return null;
  }

  // mode === "used" (default)
  if (iv.usedQuota != null && iv.limitQuota != null) {
    return {
      prefix,
      axisNumber: iv.usedQuota,
      total: iv.limitQuota,
      axisPct: (iv.usedQuota / iv.limitQuota) * 100,
    };
  }
  if (iv.remainingQuota != null && iv.limitQuota != null) {
    const used = iv.limitQuota - iv.remainingQuota;
    const clamped = Math.max(0, Math.min(iv.limitQuota, used));
    return {
      prefix,
      axisNumber: clamped,
      total: iv.limitQuota,
      axisPct: (clamped / iv.limitQuota) * 100,
    };
  }
  if (iv.limitQuota != null) {
    return {
      prefix,
      axisNumber: 0,
      total: iv.limitQuota,
      axisPct: 0, // nothing known used ⇒ 0% consumed
    };
  }
  if (iv.usedQuota != null) {
    return {
      prefix,
      axisNumber: iv.usedQuota,
      total: null,
      axisPct: null,
    };
  }
  return null;
}
```

**3b. `wrapQuotaBody`(`src/render.ts:670-691`)**:加 `valueOnly: boolean = false` 参数,body 去掉 `(${parts.label})`,valueOnly 时去掉 `${parts.prefix}`。新函数:

```ts
function wrapQuotaBody(
  parts: NonNullable<ReturnType<typeof renderQuotaParts>>,
  mode: DisplayMode,
  userColor: string | undefined,
  valueOnly: boolean = false,
): string {
  const total = parts.total == null ? "--" : `${parts.total}`;
  // Pick the tint: user override wins; else band color when
  // ratio is known; else STALE_COLOR (matches m_window*'s
  // "no percent → gray" convention).
  let tint: string;
  if (userColor) {
    tint = userColor;
  } else if (parts.axisPct == null) {
    tint = STALE_COLOR;
  } else {
    tint = colorFor(parts.axisPct, mode);
  }
  // vX.X.X+ — `(label)` tail dropped; valueOnly strips the prefix.
  //   normal    → `quota:<axis>/<total>`   (e.g. `quota: 413.7/1500`)
  //   valueOnly → `<axis>/<total>`          (e.g. `413.7/1500`)
  const body = `${tint}${parts.axisNumber}${RESET}/${total}`;
  return valueOnly ? body : `${parts.prefix}${body}`;
}
```

**3c. `placeholderQuota`(`src/render.ts:4826-4847`)**:valueOnly-aware、去 `(label)`。新函数:

```ts
function placeholderQuota(
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
): string {
  // vX.X.X+ — `(label)` tail is gone; valueOnly drops the prefix.
  //   normal    → "quota:n/a"
  //   valueOnly → "n/a"
  const valueOnly = params.valueOnly === "true" || ctx.passThrough?.valueOnly === "true";
  const prefix = valueOnly ? "" : labelFor("quota");
  return `${prefix}n/a`;
}
```

(`placeholderTermLabel` 仍被 m_countdown 使用,保留不动。)

**3d. 注释同步**(`src/render.ts`):
- `:99` `quota(5h):123/500` → `quota: 123/500`
- `:180` `("quota(5h):123/500")` → `("quota: 123/500")`
- `:223-225` 的 `quota(5h):123/500` → `quota: 123/500`
- `:548-554` 注释块的 `quota(5h):…` → `quota: …`
- `:581` `quota:<axis>/<total>(<label>)` → `quota:<axis>/<total>`
- `:689`(wrapQuotaBody 上方注释)同步为 3b 里的新注释
- `:4829-4844`(placeholderQuota 上方注释)同步为 3c 里的新注释

**3e. `src/config.ts:520`**:`labelQuota: "quota:",` → `labelQuota: "quota: ",`

**3f. `src/config.ts:348-351` 注释**:

```ts
    // v0.9.0+ — quota module prefix. Read by `m_quota` (per-term
    // via the `|term|short|mid|long` inline arg). Default
    // `"quota: "` (trailing space) renders as e.g. `quota: 123/500`
    // (the `(label)` tail is gone in vX.X.X+). valueOnly drops the
    // prefix entirely. Override via config.json.
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test --import tsx src/render.test.ts`
Expected: 全部 PASS(m_quota 相关 + band-color + 默认模板)。

- [ ] **Step 5: 全量验证**

Run: `npm test && npm run typecheck`
Expected: 1099 tests 全 PASS;typecheck 无输出。

- [ ] **Step 6: Commit**

```bash
git add src/render.ts src/config.ts src/render.test.ts
git commit -m "feat(render): m_quota drops (label) tail; labelQuota default gains trailing space
"
```

---

### Task 2: m_quota valueOnly 支持(schema + 两条渲染路径)

**Files:**
- Modify: `src/render.ts:5654` (INLINE_SCHEMAS — m_quota 加 `VALUEONLY_PARAM.named`)
- Modify: `src/render.ts:2079-2086` (MODULES 入口)
- Modify: `src/render.ts:6208-6223` (INLINE_RENDERERS 入口)
- Test: `src/render.test.ts` (新增 valueOnly describe block)

**Interfaces:**
- Consumes: Task 1 的 `wrapQuotaBody(parts, mode, userColor, valueOnly?)`、`placeholderQuota(params, ctx)`(valueOnly-aware)
- Produces: `m_quota|valueOnly:true` 合法(不再 badarg);`m_quota` 支持外层 `m_template|…|valueOnly:true` 透传

- [ ] **Step 1: 写 valueOnly 测试(先红)**

在 `src/render.test.ts` 末尾追加新的 describe block:

```ts
// vX.X.X+ — `m_quota` accepts |valueOnly|true: the prefix (and the
// now-removed `(label)` tail) disappear, leaving just the colored
// `<axis>/<total>` body. Mirrors the other valueOnly-capable modules.
describe("m_quota valueOnly (vX.X.X+)", () => {
  const nowMs = Date.parse("2026-06-24T12:00:00Z");

  function quotaIv(over: Partial<import("./render.ts").Interval> = {}): import("./render.ts").Interval {
    return {
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
      ...over,
    };
  }

  it("m_quota|valueOnly:true renders just the axis/total body (no prefix)", () => {
    __resetForTest({
      statuslineTemplate: ["m_quota|term:long|valueOnly:true"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: null,
        midInterval: null,
        longInterval: quotaIv({ usedQuota: 765, limitQuota: 1500 }),
        balance: null,
        ageMs: 5 * 60_000, stale: false, version: "",
      });
      const clean = strip(line);
      assert.equal(clean, "765/1500", `expected bare 765/1500, got: ${clean}`);
      assert.ok(!clean.includes("quota"), `valueOnly must not leak the prefix, got: ${clean}`);
    } finally {
      __resetForTest();
    }
  });

  it("m_quota|valueOnly:true keeps the band color on the digit", () => {
    __resetForTest({
      statuslineTemplate: ["m_quota|term:long|valueOnly:true"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: null,
        midInterval: null,
        longInterval: quotaIv({ usedQuota: 765, limitQuota: 1500 }),
        balance: null,
        ageMs: 5 * 60_000, stale: false, version: "",
      });
      // usedPct=51 → band 0 → BRIGHT_GREEN on the digit, /1500 plain.
      assert.ok(
        line.includes(`${BRIGHT_GREEN}765${RESET}/1500`),
        `valueOnly digit should keep the band tint, got: ${strip(line)}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("m_quota|valueOnly:true|color:<c> — user override wraps the whole body", () => {
    __resetForTest({
      statuslineTemplate: ["m_quota|term:long|valueOnly:true|color:" + RED],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: null,
        midInterval: null,
        longInterval: quotaIv({ usedQuota: 765, limitQuota: 1500 }),
        balance: null,
        ageMs: 5 * 60_000, stale: false, version: "",
      });
      assert.ok(
        line.includes(`${RED}765${RESET}/1500`),
        `valueOnly + color override should win, got: ${strip(line)}`,
      );
    } finally {
      __resetForTest();
    }
  });

  it("m_quota|valueOnly:true placeholder renders bare 'n/a' when no quota data", () => {
    __resetForTest({
      statuslineTemplate: ["m_quota|term:long|valueOnly:true"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: null,
        midInterval: null,
        longInterval: quotaIv(),
        balance: null,
        ageMs: 5 * 60_000, stale: false, version: "",
      });
      const clean = strip(line);
      assert.equal(clean, "n/a", `valueOnly placeholder should be bare n/a, got: ${clean}`);
    } finally {
      __resetForTest();
    }
  });

  it("m_template|frag|valueOnly:true cascades to an inner m_quota", () => {
    __resetForTest({
      lineTemplates: { q: ["m_quota|term:long"] },
      statuslineTemplate: ["m_template|q|valueOnly:true"],
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used", nowMs,
        shortInterval: null,
        midInterval: null,
        longInterval: quotaIv({ usedQuota: 765, limitQuota: 1500 }),
        balance: null,
        ageMs: 5 * 60_000, stale: false, version: "",
      });
      assert.equal(
        strip(line),
        "765/1500",
        `m_template passthrough valueOnly should strip the prefix, got: ${strip(line)}`,
      );
    } finally {
      __resetForTest();
    }
  });
});
```

新增 block 里用到的常量(`BRIGHT_GREEN` / `RED` / `RESET` / `strip` / `__resetForTest` / `renderProviderLine`)在文件顶部已定义。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test --import tsx src/render.test.ts`
Expected: 新增 5 个 case FAIL(`m_quota|…|valueOnly:true` 当前是 badarg → token 整个 drop → 输出为空)。

- [ ] **Step 3: 实现**

**3a. schema(`src/render.ts:5654`)**:

```ts
  m_quota: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...TERM_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } },
```

**3b. MODULES 入口(`src/render.ts:2085`)**:

```ts
    return wrapQuotaBody(parts, c.mode, undefined, c.passThrough?.valueOnly === "true");
```

**3c. INLINE_RENDERERS 入口(`src/render.ts:6223`)**:

```ts
    return wrapQuotaBody(parts, mode, params.color as string | undefined, params.valueOnly === "true");
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test --import tsx src/render.test.ts`
Expected: 全部 PASS(含新增 5 个 valueOnly case)。

- [ ] **Step 5: 全量验证**

Run: `npm test && npm run typecheck`
Expected: 全 PASS;typecheck 干净。

- [ ] **Step 6: Commit**

```bash
git add src/render.ts src/render.test.ts
git commit -m "feat(render): m_quota supports |valueOnly|true (inline + m_template passthrough)
"
```

---

### Task 3: 全量验证 + minimal deploy

**Files:**
- (无源码改动)
- Deploy 目标:`~/.claude/plugins/cache/creditgauge/creditgauge/1.2.0/dist/index.js`

**Interfaces:**
- Consumes: Task 1 + Task 2 的源码变更

- [ ] **Step 1: 全量测试 + typecheck**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS,typecheck 干净。

- [ ] **Step 2: build + 覆盖 cache bundle**

```bash
npm run build
HIGHEST=$(ls -d ~/.claude/plugins/cache/creditgauge/creditgauge/*/ | sort -V | tail -1)
cp dist/index.js "${HIGHEST}dist/index.js"
```

- [ ] **Step 3: 冒烟检查(必须 > 0)**

```bash
grep -c -F 'm_quota|term:long|display:remaining|valueOnly' "$(ls -d ~/.claude/plugins/cache/creditgauge/creditgauge/*/ | sort -V | tail -1)dist/index.js"
```

Expected: `1`(该默认模板 token 字符串;部署 bundle 里之前没有 valueOnly —— 这个 grep 同时证明(b)新 bundle 已生效、(b)valueOnly 默认模板已上线;`-F` 是固定字符串匹配,防止 `|` 被当 regex 交替)。若为 `0`,停止并排查(先 `npm run dev:uninstall` + 重启所有 Claude Code 会话解决 EPERM,再走完整 mirror 流程)。

- [ ] **Step 4: 向用户确认可见变化**

通知用户:重部署后状态栏 m_quota 从 `quota:1499.4/1500(30d)` 变为 `1499.4/1500`(选项 A 已确认);若 config.json 里放了带 `valueOnly:true` 的 `m_quota` token,现在能正常渲染(不再 badarg drop)。

- [ ] **Step 5: 可选 end-to-end 冒烟**

Run:
```bash
echo '{}' | ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic ANTHROPIC_AUTH_TOKEN=dummy node dist/index.js
```
Expected: 不崩溃(缺 token 会走 fetch-fail → stale/cache 路径;主要确认 dist/index.js 可执行、无 import 错误)。
