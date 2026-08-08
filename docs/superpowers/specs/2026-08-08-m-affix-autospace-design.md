# m_* prefix/suffix 自动空格设计

日期: 2026-08-08
状态: 已批准（2026-08-08）

## 背景

用户要求（2026-08-08）：模板 / preset 里 `s_space` 分隔符用得太多。方案：除 `m_label` / `m_template` 外的所有 `m_*` 模块增加 `prefix` / `suffix` 两个 inline 参数 + 两个全局开关 `prefixSpace`（默认 `true`）/ `suffixSpace`（默认 `false`）。模块相邻时自动补空格，显式参数压过默认，从而去掉模板里成排的 `s_space` token，同时保留逐点可控性。

**探索发现（已核实）**：
- `renderTemplate`（`render.ts:7458`）顺序拼接 token；非 `m_`/`s_` 字面 token 原样输出。
- `parseInlineArgs`（`render.ts:7384`）对未知 named 参数返回 `null`（`render.ts:7414` `if (!(name in schema.named)) return null`）→ badarg + warn + drop。所以 `prefix`/`suffix` 必须进每个模块的 schema。
- `m_template`（`render.ts:7268`）递归 `renderTemplate(inner.slice(), innerCtx)`（`render.ts:7345`），inner 从空行开始 → **fragment 内第一个模块天然像「行首」**，自动前缀被抑制。
- `m_template` passthrough（`render.ts:7340-7343`）除 `key`/`type`/`providers` 外全部透传给内部模块 → 排除 `m_template` 可避免 `prefix`/`suffix` 泄漏给 fragment 内所有模块。
- 全局配置：`cfg()` 顶层字段（`timeFormat` / `stale` 同款模式），新增 `prefixSpace` / `suffixSpace` 两个 boolean。

## 行为

### 全局开关

- `prefixSpace`（config.json，默认 `true`）：模块自动加**前缀空格**。
- `suffixSpace`（config.json，默认 `false`）：模块自动加**后缀空格**。
- 显式 `|prefix:X|` / `|suffix:X|` 总是压过全局默认（`|prefix:` 空值 = 显式关闭自动前缀）。

两个开关互相独立。**同时开启不会出双空格**：R2（前序空白抑制）会让后缀加完空格后、下一个模块的前缀被抑制，module run 下实际效果与单开等价。差异只在边界场景：
- `suffixSpace` 额外补上「模块 → fragment」的空格（后缀 lookahead 把 `m_template` 计入模块）；`prefixSpace` 补「fragment → 模块」。
- `suffixSpace` 的 drop edge 仍在（下一个模块 nulldrop 时残留尾随空格）。

### 自动前缀 —— 三条渲染侧规则

自动前缀仅在同时满足以下条件时生效：

- **R3 紧邻模块**：前一个 token 是 `m_` 模块（含 `m_label` / `m_template` 作为前驱 token 计入；含被 `nulldrop` drop 的模块——drop 后 spacing 仍保留）。
- **R1 行首抑制**：当前行可见内容非空（行首、`s_newline` 之后、fragment 递归起点都视为行首）。
- **R2 前序空白抑制**：前一个模块的**可见**输出不以空白结尾（ANSI-strip 后判断；覆盖 `m_label|Context: ` 的尾随空格、`s_dot|wrap:both` 渲染出的 `" · "`）。

即：`cfg().prefixSpace && prevTokenIsModule && !lineStart && !prevVisibleEndsWs`。

### 自动后缀 —— 对称 lookahead

自动后缀仅在下一个 token 是 `m_` 模块时生效（`template[i+1]?.startsWith("m_")`，含 `m_label` / `m_template`）：

- 因此 `suffixSpace=true` 时：模块间单空格；行尾 / `s_newline` 前 / 分隔符前**无尾随空格**。
- 已知 edge：下一个模块被 `nulldrop` 时残留一个尾随空格（接受，左到右渲染器无法预知 drop）。
- 不需要 R2 对称版（「下一个块以空白开头则抑制」）——模块输出不以空白开头。

即：`cfg().suffixSpace && nextTokenIsModule`。

### 显式参数

- `|prefix:X|`：X 原样前置（可含空格、`:`、`=`；**不可含 `|`**——`|` 是结构分隔符）。空值 = 关闭自动前缀。
- `|suffix:X|`：同上，追加在后。
- `prefix` / `suffix` 渲染在**颜色 span 之外**（无色，同 `s_dot`）。
- 排除 `m_label` / `m_template`：其 schema 无 `prefix`/`suffix` → `m_label|…|prefix:x` / `m_template|…|prefix:x` 走 badarg + warn（符合 unknown-arg 约定，且避免 m_template passthrough 泄漏）。

### fragment 边界（文档化约束）

- `m_template` 被排除 + 递归从空行开始 → fragment 内第一个模块不自动加前缀。
- 紧凑写法（裸模块列表）适用于 **fragment 内部 / 单层模板**；fragment 之间（preset 层）仍用显式分隔符（`s_space` / `s_pipe|wrap` / `s_newline`）——现有 preset 本来就是这么写的，行为不变。
- 若要在「模块后直接跟 fragment」时留空格：把 label / 前缀放进 fragment 内部（如 `m_label|Usage: ` 自带尾随空格），或开 `suffixSpace`，或显式 `s_space`。
- `m_template` 作为**前驱 / 后继 token** 计入「紧邻模块」（R3 / 后缀 lookahead），所以「fragment → 后续模块」会自动补前缀空格。

## 示例

### `tokens_tick`：17 → 9 token

```ts
// 现在（17 token：9 模块 + 8 个 s_space）
["m_tokenInSpeed","s_space","m_tokenOutSpeed","s_space",…,"m_tokenCost"]

// 新（prefixSpace=true 默认，9 token）
["m_tokenInSpeed","m_tokenOutSpeed","m_tokenHitRate","m_apiMs",
 "m_tokenIn","m_tokenOut","m_tokenCachedIn","m_tokenTotalIn","m_tokenCost"]
```

fragment 内第一个模块 `m_tokenInSpeed` 在递归行首 → 不自动加前缀；其余相邻模块 → 自动空格。输出与今天 byte-identical。

### " · " idiom：3 → 1 token

```ts
// 现在："m_windowQuota|term:short", "s_space", "s_dot", "s_space", "m_countdown|term:short"
// 新：  "m_windowQuota|term:short", "m_countdown|term:mid|prefix:\" · \""
```

## 注册位

| 位 | 内容 |
|---|---|
| 新常量 | `PREFIX_PARAM = { named: { prefix: (raw) => raw } }`（接受任意值含空） |
| 新常量 | `SUFFIX_PARAM = { named: { suffix: (raw) => raw } }` |
| config 默认 | `prefixSpace: true` / `suffixSpace: false`（config shape 顶层 boolean，`timeFormat` 同款） |
| applyOverrides | 校验 boolean，非法 → warn + 默认值 |
| INLINE_SCHEMAS | 每个 `m_*` 模块（除 `m_label` / `m_template`）的 `named` 增加 `...PREFIX_PARAM.named, ...SUFFIX_PARAM.named`（约 50 处机械改动） |
| InlineResult | 增加 `affix?: { prefix?: string; suffix?: string }`，`expandInlineToken` 把显式参数带出给 renderTemplate |
| renderTemplate | 模块 chunk 产出后统一调 `applyAffix(piece, explicitAffix, state)`；维护 `prevTokenIsModule` / `prevVisibleEndsWs`（ANSI-strip 后判断 `/\s$/`）/ `nextTokenIsModule`（`template[i+1]?.startsWith("m_")`）状态 |
| MODULES（bare） | 无显式 affix → 只走自动逻辑（bare 模块也要自动前缀） |
| dispatcher | skipLen 不变（`prefix`/`suffix` 是 named 参数，不影响 implicit 槽） |

### renderTemplate 循环顺序（关键）

```
for tok:
  isModule = false; explicitAffix = null
  分发（现有分支）：inline 分支带出 explicitAffix；bare m_ / inline m_ 分支置 isModule = true
  if (isModule && piece 非 null 非空):
    piece = applyAffix(piece, explicitAffix, { prevIsModule, lineStart: current==="", prevEndsWs, nextIsModule })
  prevIsModule = isModule            // 用旧值判定，用后更新
  if (piece == null || piece === "") continue
  追加到 current + 更新 prevEndsWs（ANSI-strip 后的 current 是否以空白结尾）
```

## 行为变化提示

- 内置模板全部使用显式分隔符（`s_space` / `s_dot|wrap` / 字面量）——在三条规则下，默认 `prefixSpace=true` 对**所有内置 fragment / preset 渲染 byte-identical**。用 byte-identity 回归测试证明。
- 唯一的语义变更：**两个模块紧邻、中间无任何 token** 从今天的「拼接」变成「空格分隔」。内置无依赖；依赖紧凑拼接的用户模板会变（知情决策，符合 `new-feature-convention`）。
- `m_label|…|prefix:x` / `m_template|…|prefix:x` → badarg + warn + drop（unknown-arg 约定）。

## 测试

在 `render-tokens.test.ts`（或新建 `render-affix.test.ts`）新增 describe：

1. **Byte-identity**：遍历 `DEFAULT_LINE_TEMPLATES` 全部 value + `DEFAULT_STATUSLINE_PRESETS` 全部 value，`prefixSpace=false`（≈旧行为）与 `prefixSpace=true`（默认）渲染结果断言相等。
2. **R1 行首**：`["m_tokenIn","m_tokenOut"]` 行首 → `123 456`（无前导空格）；`s_newline` 后同样无前导空格。
3. **R3 紧邻**：`["m_provider","/","m_model"]` → `anthropic/model`（字面量 `/` 不被撑开）。
4. **R2 空白**：`["m_label|Context: ","m_windowContext"]`（含彩色变体）→ 无双空格；`["m_a","s_dot|wrap:both","m_b"]` → `a · b`（无双空格）。
5. **drop**：`["m_a","m_b|nulldrop:true","m_c"]` → `a c`（drop 后 spacing 保留）；第一个模块 drop → 无行首空格。
6. **显式覆盖**：`|prefix:" · "|` → " · " idiom；`|prefix:`（空）→ 关掉自动前缀。
7. **颜色 span 外**：`m_tokenIn|color:red|prefix:" · "` → 前缀无色、值红色。
8. **suffixSpace=true**：模块相邻单空格；行尾 / `s_newline` 前 / 分隔符前无尾随空格；已知 drop edge。
9. **排除**：`m_label|prefix:x` / `m_template|prefix:x` → badarg（warn + drop）。
10. **m_template 相邻**：`["m_template|A","m_age"]` → fragment 与 m_age 自动空格；`["m_modeLabel","m_template|B"]` 默认前缀下紧贴（fragment 行首语义），`suffixSpace=true` 时补上。
11. **双开关**：`prefixSpace=true + suffixSpace=true` → 单空格（R2 抑制下一个模块的前缀，不双空格）。
12. **parseInlineArgs 空值**：`m_tokenIn|prefix:` 解析为 `prefix=""`，非 badarg。

## 不做的

- 不 bump 版本号（`vX.X.X+` 标记保留）。
- 不迁移内置 fragment / preset 到紧凑写法（该特性使其可行，但迁移本身不在本设计范围，作为后续可选项）。
- 不改 `s_*` 分隔符 / `wrap` / `repeat` 现有行为。
- 不给 `m_label` / `m_template` 加 `prefix`/`suffix`。
- 不做前缀/后缀的自动互斥（双开由 R2 抑制为单空格，无冲突）。

## 部署

实现 + 测试全绿后：`npm run build` → `cp dist/index.js` 进 cache 最高版本目录 → `grep -c` 冒烟确认新代码在运行时 bundle 中。
