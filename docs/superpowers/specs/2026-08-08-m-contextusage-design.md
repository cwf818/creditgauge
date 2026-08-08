# m_contextUsage 模块设计

日期: 2026-08-08
状态: 已批准（2026-08-08）

## 背景

用户要求（2026-08-08）：参照 `m_memUsage`，新增 `m_contextUsage` 模块，采用一样的 `x/y` 格式，默认蓝色，`used` 段使用 band color。

**探索发现**：
- `m_memUsage`（`render.ts`）已经是成熟模板：`renderMemUsageBody` 两色渲染（used 段 `colorFor(pct, "used")` 波段色 + prefix/total 保持模块默认色 cyan）+ 5 个注册位（MODULES / DEFAULT_COLORS / PLACEHOLDERS / INLINE_SCHEMAS / INLINE_RENDERERS / dispatcher）+ `labelFor("memUsage")` 轴。
- 现有 context 模块：`m_contextSize` 读 `totals.tokenTotalIn`（实际占用，紧凑 token 格式）；`m_contextWindowSize` 读 `contextWindow.contextWindowSize`（容量）。
- `formatCompactToken`（`render.ts:3314`）输出 `126.9k` 风格，`tokenFormat.thresholds` 三档 `[1k, 1M, 1B]`。

**用户决策**（2026-08-08 逐题确认）：
- **数据源**：`used = tokenTotalIn`，`total = contextWindowSize`。
- **格式**：`formatCompactToken` 紧凑 token（`ctx:126.9k/200k`），非字节风格、非原始整数。
- **默认前缀**：`ctx:`（`labels.labelContextUsage` 可覆盖，默认小写风格对齐现有 context 模块）。
- **实现**：平行克隆 m_memUsage（方案 A），不泛化 `renderMemUsageBody`、不碰 m_memUsage 现有代码。

## 行为

### 渲染

`m_contextUsage` 输出：`<blue>ctx:</blue><bandColor>126.9k</bandColor>/<blue>200k</blue>`

- **数据源**：`used = c.tokens.totals.tokenTotalIn`，`total = c.tokens.contextWindow.contextWindowSize`。
- **两色规则**（未指定 `|color|` 时）：
  - used 段（`/` 左侧）颜色 = `colorFor(pct, "used")`，`pct = (used / total) * 100`，走 `thresholds.percentBands`（默认 `[60,70,80,90]`）。
  - 固定 `mode="used"`：与 m_memUsage 同理，占用显示的危险轴永远是"用了多少"，不跟随 `c.mode`。
  - prefix 和 total 用模块默认色 `DEFAULT_COLORS.m_contextUsage` = `NAMED_PALETTE.blue`；`/` 是裸分隔符。
- `|color:<c>|` 覆盖 → 整行包用户色（override 永远赢，与 `wrapPlainDefault` 契约一致）。
- **value-zero 规则**：`used = 0, total > 0` → `ctx:0/200k`（0 直接显示，band 色为 0% 边界 = 亮绿）。
- **placeholder**：used 或 total 缺失、或 `total <= 0` → `STALE_COLOR` 包裹的 `ctx:n/a`（`placeholderLabelOr("contextUsage")`，valueOnly 时前缀空 → `n/a`）。

### 实现结构

新增 module-local helper（`renderMemUsageBody` 的 token 版镜像）：

```ts
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

- bare 路径：`m_contextUsage: (c) => { const used = …; const total = …; if (used == null || total == null || total <= 0) return placeholderBare("m_contextUsage", c); return renderContextUsageBody(prefix, used, total, undefined); }`，prefix = `labelFor("contextUsage")`（valueOnly 时空串）。
- inline 路径：`m_contextUsage: (params, ctx) => { …; return renderContextUsageBody(prefix, used, total, params.color as string | undefined); }`，missing → `placeholderWithColor("m_contextUsage", params, ctx)`。

## 注册位

| 位 | 内容 |
|---|---|
| MODULES（bare） | `m_contextUsage`（`render.ts` 元数据模块区，m_memUsage 附近） |
| DEFAULT_COLORS | `m_contextUsage: NAMED_PALETTE.blue` |
| PLACEHOLDERS | `m_contextUsage: placeholderLabelOr("contextUsage")` |
| INLINE_SCHEMAS | `m_contextUsage: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...VALUEONLY_PARAM.named } }` |
| INLINE_RENDERERS | `m_contextUsage`（`params.color` 透传） |
| dispatcher | `m_contextUsage|` → skipLen **15**（`"m_contextUsage"` 14 字符 + 1） |
| LabelAxis union | 加 `"contextUsage"`；`labelFor` 加 `case "contextUsage": return labels.labelContextUsage;` |

## 配置面

- `config.ts`：`Labels` 类型 + `DEFAULT_CONFIG.labels` 加 `labelContextUsage: "ctx:"`。

## 测试

在 `render-tokens.test.ts` 新增 `m_contextUsage` describe 块（fixture 用 stdin 带 `totals.tokenTotalIn` + `contextWindow.contextWindowSize`）：

1. bare 渲染 `ctx:126.9k/200k`：断言 used 段 ANSI = `colorFor(pct,"used")`、total 段 ANSI = `NAMED_PALETTE.blue`，strip 后为 `ctx:126.9k/200k`。
2. `|valueOnly:true|` 去 prefix → `126.9k/200k`。
3. `|color:red|` 整行红（override 赢）。
4. missing used / missing total / `total <= 0` → `ctx:n/a`（STALE_COLOR）。
5. `used = 0, total > 0` → `ctx:0/200k`（0 显示）。
6. band 边界：多个 pct 下 used 段颜色正确（`colorFor(pct,"used")`）。
7. dispatcher inline 路径：`m_contextUsage|color|green` 走 inline（skipLen 15 正确切参）。
8. `labels.labelContextUsage` 覆盖前缀；默认值 `ctx:` byte-identical。

## 不做的

- 不 bump 版本号（`vX.X.X+` 标记保留；version-bump-policy 只显式要求才 bump）。
- 不改 `config.template.ts` 的任何默认 preset / lineTemplate —— `m_contextUsage` 与所有 per-turn 模块一样 opt-in，用户自行加入配置。
- 不泛化 `renderMemUsageBody`（方案 B 被否）。
- 不加 `display` 参数（无 used/remaining 语义切换）。
- 不加 label 前缀 `Ctx:` 大写变体（用户选定 `ctx:`）。

## 部署

实现 + 测试全绿后：`npm run build` → `cp dist/index.js` 进 cache 最高版本目录 → `grep -c` 冒烟确认新代码在运行时 bundle 中。
