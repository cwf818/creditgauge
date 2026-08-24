# name 模块 width 宽度限制参数（v1.2.1dev）

日期：2026-08-10
分支：`1.2.1dev`
状态：已批准设计

## 目标

给 9 个名称类模块新增内联参数 `width`，限制其 body 的终端显示宽度。默认 0 = 无限制（省略参数时 byte-identical）。在 `git_info` 片段中为 `m_dirName` 和 `m_branch` 设定 `width:25`。

## 模块范围（9 个）

- `m_gitName`（仓库名）、`m_dirName`（目录 basename）、`m_branch`（git 分支）、`m_repo`（host/owner/name 拼接）
- `m_model`、`m_provider`
- `m_ccVersion`、`m_session`、`m_effort`

## 参数语义

- 参数名：`width`，内联形式 `m_dirName|width:25`。
- 解析：非负整数。`0 ≤ width < 8` → 归一为 `0`（忽略参数，不截断）；`width ≥ 8` → 生效；非数字 / 负数 → badarg（模块 drop，与现有内联参数体系一致）。
- 计数单位：**终端显示列**（复用 `charDisplayWidth`，CJK/emoji=2 列、窄=1 列、零宽=0 列），ASCII 场景下等价于"22 个字符 + 3 个点"。
- 截断规则：body 显示列 `> N` 时，取前 `N-3` 列（逐码点累加，预算内最后一个完整码点截止，不切开 emoji）+ 追加 `...`（3 个 ASCII 点，3 列），总显示列 ≤ N。
- 作用范围：仅作用于**上色之前**的纯文本 body。
  - placeholder（`n/a`、`branch:n/a`）不截断。
  - `m_branch|withStatus:true` 的 `✅/🟠` 后缀不参与截断，只截分支名 body。
  - `m_repo` 作用于 join 后的 `host/owner/name` 整体。

## 实现

### `src/render.ts`

1. **`WIDTH_PARAM`**（命名参数解析器，镜像 `REPEAT_PARAM` 风格）：
   - `/^[0-9]+$/` 不匹配 → 返回 `null`（badarg）。
   - `n < 8` → 返回 `"0"`（归一为无限制）。
   - `n ≥ 8` → 返回 `raw`。

2. **`applyWidthLimit(body, width)`** 纯函数：
   - `width ≤ 0` → 原样返回。
   - 累计 `charDisplayWidth` 得 body 总列数，`≤ width` → 原样返回。
   - 否则逐码点累加，追加某码点会超过 `width - 3` 时停止；返回 `前缀 + "..."`。

3. **9 个模块的 `INLINE_SCHEMAS.named`** 全部追加 `...WIDTH_PARAM.named`。

4. **两个渲染路径都接入**：
   - MODULES 裸路径（`(c) => …`）：从 `c.passThrough?.width` 解析（外层 `m_template` 透传场景）。
   - INLINE_RENDERERS（`(params, ctx) => …`）：从 `params.width` 解析（内联显式 > 透传）。
   - 截断在 `wrapPlainDefault(...)` 调用之前作用到 body 字符串。
   - `m_branch`：截断 `info.branch` 后，再走 `withStatus` 后缀拼接。

### `src/config.template.ts`

- `git_info` 片段：
  - `"m_dirName"` → `"m_dirName|width:25"`
  - `"m_branch|withStatus:true"` → `"m_branch|withStatus:true|width:25"`
- `solo` preset 的 `"m_branch|withStatus:true"`（line 203）→ `"m_branch|withStatus:true|width:25"`（保持一致）。

## 测试（`src/render-tokens.test.ts`）

- width 省略 / `width:0` / `width:7` → body 原样，byte-identical。
- 长 ASCII body + `width:25` → 前 22 字符 + `...`，总 25 列。
- CJK body：显示列计数（如 13 个中文字符 = 26 列，`width:25` → 前 11 个中文 + `...` = 22 列 + 3 列 = 25 列）。
- emoji body：不在宽字符中间切割。
- `m_branch|withStatus:true|width:25` → 截断后的分支名 + `✅/🟠` 后缀照常。
- placeholder 路径不受 width 影响。
- `width:abc` / `width:-3` → badarg（模块 drop）。
- 现有 1182 测试保持通过（`config.test.ts` 只断言 preset 层，不受片段内改动影响）。

## 非目标

- 不改 `s_move` / `visibleCellLength`（已有实现直接复用 `charDisplayWidth`）。
- 不做模板级整行截断、不做 `m_truncate` 包装模块（方案 B/C 已否决）。
- 不引入 wcwidth 外部依赖。
