# m_windowQuota 实验性 label 参数 设计

日期: 2026-08-10
状态: 已批准（2026-08-10）

## 背景

用户要求（2026-08-10）:给 `m_windowQuota` 加**实验性** `label` 参数。`m_windowQuota|label:5h` 把 label 文本**居中覆盖**到 bar 上，覆盖格数 = label 的显示宽度，bar 总宽度不变。例:

| label | 25% used（`▓▓░░░░░░`） | 100% used（`▓▓▓▓▓▓▓▓`） |
|---|---|---|
| `5h` | `▓▓░5h░░░` | `▓▓▓5h▓▓▓` |
| `mo` | `▓▓░mo░░░` | `▓▓▓mo▓▓▓` |
| `5h7d`（4字） | `▓░5h7d░░` | `▓▓5h7d▓▓` |

超 4 个字符截断（按 code point）。

**探索发现**:

1. `m_windowQuota` 渲染链路:MODULES 入口（`render.ts:1400`）→ `formatOneChunk`（`render.ts:557`，stale 分支重建 chunk）；inline 入口（`render.ts:4451`）→ `formatOneChunkColored`（`render.ts:599`，`|color|` 覆盖）。三者都基于 `splitBar(usedPct, mode, width)`（`render.ts:331`，导出+被测试，**不动**）→ `{leftChunk, rightChunk, color}`。
2. bar 默认 `width: 8`、`filled: "▓"`、`empty: "░"`（`config.ts:100-104`）。
3. inline schema 是 named-only（`INLINE_SCHEMAS.m_windowQuota` `render.ts:4063`:color/display/term/nulldrop/valueOnly）→ `INLINE_RENDERERS.m_windowQuota`（`render.ts:4451`）。dispatcher skipLen = 14（`render.ts:5678-5681`，加参数不改前缀长度）。
4. `charDisplayWidth`（`render.ts:3969`）已存在，按显示宽度处理 CJK/emoji（宽字符=2 列）。
5. `placeholderGauge`（`render.ts:3446`）渲染 `░░░░░░░░ 0%` / `▓▓▓▓▓▓▓▓ 100%`，当前纯 plain。

**用户决策**（2026-08-10 逐题确认）:

- **label 着色（位置着色）**:label 字符当作普通 bar 格，**颜色由列位置决定**——`col < coloredSize`（used 模式，左侧）或 `col ≥ plainSize`（remaining 模式，右侧）着"关注侧"色，其余 plain。与字形内容无关，所以 `label:5h` 与 `label:▓▓` 完全等价。跨边界时逐字符断色（如 50% used、`5h` 落在 col 3–4 → `5` 着色、`h` plain）。
- **`|valueOnly:true|` + label**:静默忽略（percent-only 输出不变，不报错）。
- **placeholder 缺数据 + label**:居中显示在占位 bar 里（保持 placeholder 的 plain 风格，不额外着色）。

## 行为

### 渲染算法（`splitBarLabeled`，内部 helper）

1. `usedPct` clamp [0,100] 并 round；`remainingPct = 100 - usedPct`；`displayedPct = mode === "remaining" ? remainingPct : usedPct`。
2. `coloredSize = round(displayedPct/100 * width)`；`plainSize = width - coloredSize`。
3. 构建 `width` 个 display-column cells，每格 `{glyph, color}`:
   - **used mode**:`col < coloredSize` → `glyph = filled`、`color = coloredColor`；否则 `glyph = empty`、plain。
   - **remaining mode**:`col < plainSize` → `glyph = empty`、plain；`col ≥ plainSize` → `glyph = filled`、`color = coloredColor`。
4. **label 居中覆盖**:
   - 截断到 ≤ `width` 显示列（先按 4 code point，再按 width 列）。
   - `labelW = Σ charDisplayWidth(ch)`；`start = floor((width - labelW) / 2)`。
   - 每 label 字符映射到显示列（宽字符占 2 列 → slots 里同一 char 出现 2 次），覆盖 `cells[start+k].glyph = slot char`，**`color` 保持该列的原有位置色**。
5. **序列化**:按连续同色段合并 → `${color}${chars}${RESET}` run，plain 段不加 SGR。

无 label 时输出与现状**逐字节一致**（单色 run 结构相同）。

### 四条路径的 `coloredColor`

| 路径 | coloredColor | 说明 |
|---|---|---|
| 普通 | `colorFor(displayedPct, mode)` | 与现 `splitBar.color` 同值 |
| `\|color\|` override | 用户色 | 覆盖赢 |
| stale | `STALE_COLOR` | 关注侧 + percent 用 stale 色 |
| placeholder | — | 纯 plain 覆盖 label，不上色（保持现状） |

## 实现结构

1. **`LABEL_PARAM`**（`render.ts`，对齐 TERM_PARAM 附近）:
   ```ts
   const LABEL_PARAM = {
     named: {
       label: (raw: string): ResolvedValue | null => {
         const s = raw.trim();
         return s === "" ? null : [...s].slice(0, 4).join("");
       },
     },
   } as const;
   ```
   空/全空白 → badarg（drop + warn，对齐其他 named 参数）。
2. **schema**（`render.ts:4063`）:`m_windowQuota` 的 named 加 `...LABEL_PARAM.named`。dispatcher skipLen 仍是 14。
3. **新内部 helper** `splitBarLabeled(usedPct, mode, width, label, coloredColor): {leftChunk, rightChunk, color}`——算法见上；`leftChunk` 放全部 run、`rightChunk = ""`（内部专用，不是导出的 `splitBar`）。label 覆盖逻辑抽成 `overlayBarLabel(cells, width, label)`，placeholder 复用。
4. **`formatOneChunk`**（`render.ts:557`）加可选 `label?: string` 参数，改走 `splitBarLabeled`（`coloredColor = stale ? STALE_COLOR : colorFor(displayedPct, mode)`）。无 label 时 byte-identical。
5. **`formatOneChunkColored`**（`render.ts:599`）加可选 `label?: string`，`coloredColor = override`。
6. **`placeholderGauge`**（`render.ts:3446`）读 `params.label`，`overlayBarLabel` 居中覆盖到纯 bar body（plain）。
7. **`INLINE_RENDERERS.m_windowQuota`**（`render.ts:4451`）:`params.label` → 传给 `formatOneChunk` / `formatOneChunkColored`。
8. **MODULES 入口**（`render.ts:1400`）:不变（bare 无参数，label 只能 inline 传）。

## 交互规则

- `|valueOnly:true|` + label → label 静默忽略（`formatPercentOnly` 不接收 label）。
- interval 缺失 placeholder → label 居中显示（plain）。
- label 显示宽度 ≥ bar 宽度（最小 3）→ 进一步截断到恰好填满 `width` 列。
- CJK/emoji 宽字符 → 按 `charDisplayWidth` 显示宽度居中（覆盖 2 列）。
- `|color|` override / stale → 同一位置着色规则，关注侧用 override / stale 色。
- **不做**:`m_template` passthrough 白名单不加 `label`（实验性，只支持直接 inline `m_windowQuota|label:...`）；`m_countdown` / `m_quota` / `m_windowContext` / `m_windowMemUsage` 不加（范围仅 `m_windowQuota`）。

## 测试

- **新测试**（`lineTemplate.test.ts` 或 `render.test.ts`）:
  - `m_windowQuota|label:5h` 25% used → `▓▓░5h░░░ 25%`。
  - 100% used → `▓▓▓5h▓▓▓ 100%`，全部 band 色。
  - `|label:mo` → `▓▓▓mo▓▓▓`。
  - 4 字截断:`|label:5h7d8x` → label 显示 `5h7d`。
  - 边界逐字符断色:50% used、`5h` 落 col 3–4 → `5` 着色、`h` plain（`▓▓▓5` 色 + `h░░░` plain）。
  - remaining 模式:`m_windowQuota|display:remaining|label:5h`。
  - 宽字符 CJK label。
  - `label` + `valueOnly:true` → label 忽略、percent-only 不变。
  - placeholder:`m_windowQuota|nulldrop:false|label:mo`（interval 缺失）→ 占位 bar 显示 `▓▓▓mo▓▓▓`。
  - 空 label `|label:|` → badarg drop + warn。
  - `label` + `|color|` override / stale。
- **回归**:现有 `m_windowQuota` / `formatOneChunk` 测试全部不动，断言 byte-identical（无 label 时）。

## 部署

- `npm test`（全量 ~1182 测试）→ `npm run build` → 复制 `dist/index.js` 进 `~/.claude/plugins/cache/creditgauge/creditgauge/<HIGHEST_VERSION>/dist/index.js`（minimal deploy，不 bump 版本）。
- grep smoke check:在 cache bundle 里 grep 新 helper 唯一标识（如 `splitBarLabeled`），count > 0。
