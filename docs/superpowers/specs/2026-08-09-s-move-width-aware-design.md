# s_move 字符宽度感知 设计

日期: 2026-08-09
状态: 已批准（2026-08-09，方案 A + 等值 pos=51）

## 背景

用户要求（2026-08-09）:`s_move|pos:<n>` 的列计量从"JS 字符串长度"改成"按字符真实显示宽度"，这样 `standard` preset 里两个 `s_move` 的 `pos` 参数可以统一为同一个值（不必再用 52/51 这种补偿值）。

**根因分析**:

1. `visibleCellLength`（render.ts:5553）剥离 ANSI 后返回 `stripped.length`（**JS code-unit 数**）。🗪(U+1F5EA) 和 📦(U+1F4E6) 都是 astral 字符 → 在 JS 里都是 **2 个 code unit**。
2. `s_move|pos:N` 把下一字符垫到 **JS 第 N 列**（render.ts:6088-6103，`padLen = pos - ctx.lineCursor`）。
3. 旧 `standard` preset 里 L3 `🗪 : ` 垫到 52、L4 `📦: ` 垫到 51 → 在终端上 `|` 的显示列取决于 emoji 实际渲染宽度，两条线的对齐依赖"pos 差 1 + emoji 宽差"恰好抵消，**很脆**：换字体、换 label 就歪。更早的 47/46 因内容(48)超过 pos 直接是 badarg 丢弃（每次渲染都 warn）。
4. 用户终端实测（2026-08-09 逐题确认）:🗪 = **1 格**、📦 = **2 格**（标准东亚宽度表里两者都是 W=2，用户终端对 U+1F5EA 有特殊渲染）。

**用户决策**:
- **方案 A**:手写宽度函数，无依赖（符合 render.ts:5544 注释里"without pulling in a wcwidth dep"的既有设计约束）。不引 `string-width`/`wcwidth`（方案 B 违背约束且标准表给 🗪=2、不符实测，还得叠例外表）。
- **宽度函数按字符分类** + **例外表**精确编码 🗪=1。
- **`standard` 两个 `s_move` 改成等值 51/51**（保持当前 `|` 列位置；有正确宽度后等值即对齐）。

## 行为

### 新增 `charDisplayWidth(ch: string): number`

按单个码点（`for...of` 迭代，正确解代理对）返回显示格数:

| 宽度 | 判定 |
|---|---|
| **0** | 控制字符（U+0000–001F、U+007F–009F）；Unicode 类别 M（Mn/Mc/Me 组合字符）+ Cf（格式字符：ZWJ/ZWNJ/ZWSP/软连字符/BOM/方向标记）+ Zl/Zp → 用正则属性转义 `[\p{M}\p{Cf}\p{Zl}\p{Zp}]` 判定，免去手列巨大区段表 |
| **2** | 东亚宽度 W/F:经典 wcwidth 宽区段（U+1100–115F、U+2E80–A4CF、U+AC00–D7A3、U+F900–FAFF、U+FE10–19、U+FE30–6F、U+FF00–60、U+FFE0–E6、U+20000–2FFFD 等）+ 宽 emoji 区段（U+1F000–1FAFF 主块、U+2600–27BF emoji 呈现、U+231A–231B + U+23E9–23F3、U+25FD–25FE、U+2614–2615、U+2648–2653、U+2693、U+26A1、U+26AA–AB、U+26BD–BE、U+26C4–C5、U+26CE、U+26D4、U+26EA、U+26F2–F3、U+26F5、U+26FA、U+26FD、U+2705、U+270A–B、U+2728、U+274C、U+274E、U+2753–55、U+2757、U+2795–97、U+27B0、U+27BF、U+2B00–2BFF 中 emoji 子集）。精确范围在实现计划里落定 |
| **1** | 其余（ASCII、拉丁、希腊、西里尔、东亚宽度 A=模糊如 ▓ U+2593，按终端常规 1 格） |

**例外表**（模块级常量，注释标注校准依据，可扩展）:
- `U+1F5EA` (🗪) → **1**（用户终端实测窄；标准表给 2）

### `visibleCellLength` 改写（render.ts:5553）

保留现有 SGR 剥离逻辑，返回值从 `stripped.length` 改为 `for (const ch of stripped) w += charDisplayWidth(ch)`。

### `s_move` 语义不变

`s_move` 渲染器（render.ts:6088）不改动:`ctx.lineCursor` 现在是显示列，`padLen = pos - cursor`，垫空格后下一字符落在显示列 `pos`。已知局限（记入注释、不实现）:ZWJ 家庭 emoji（👨👩👧）按"宽 emoji 各 2 + ZWJ 0"高估；`char:` 传宽字符（如 `char:█`）会过垫。状态栏 label 均用不到，YAGNI。

## 实现结构

1. **新增 `charDisplayWidth`**（render.ts，放在 `visibleCellLength` 附近）:导出（供测试 import）。模块级 `EXCEPTIONS` 常量 + 预编译正则 `const ZW_RE = /[\p{M}\p{Cf}\p{Zl}\p{Zp}]/u`。
2. **`visibleCellLength` 改写**（render.ts:5553-5581）:保留 SGR 剥离循环，返回值换宽度求和。
3. **`standard` preset**（config.template.ts:319）:`s_move|pos:52` → `s_move|pos:51`（L4 的 51 不变）。两处注释说明"等值 pos + 宽度感知 → `|` 对齐"。

## 测试

- **新增 `charDisplayWidth` 单测**:ASCII=1、CJK=2、全角（U+FF00 区）=2、`🗪`=1（例外表）、`📦`=2、组合字符（如 `á` 的重音）=0、ZWJ=0、VS16=0、`▓`=1、控制字符=0。
- **新增 s_move + emoji 回归测试**（lineTemplate.test.ts）:`m_label|🗪 : x` + `s_move|pos:20` → 断言下一字符落在**显示列** 20（用 `charDisplayWidth` 语义验证，非 `stripped.length`）。
- **新增 `standard` preset 对齐测试**（render.test.ts 或 render-affix.test.ts）:渲染 standard，取 L3/L4 两行的 `|` 列号，断言相等。
- **现有测试不受影响**:s_move 现有测试全 ASCII（宽度 1 不变）；preset 守卫（render-affix.test.ts）已过滤 s_move；其他模板无 s_move。
- 全量 `npm run typecheck` + `npm test` 全绿。

## 部署

- minimal deploy（仅改现有 src 文件 render.ts + config.template.ts，无新文件）:`npm run build` → 复制 `dist/index.js` 进 `~/.claude/plugins/cache/creditgauge/creditgauge/1.2.0/dist/index.js` → node 探测 bundle 里的新标识（`charDisplayWidth` 产物 / `pos:51` 两处）确认生效。
- ⚠️ 重部署后 `standard` preset 的 `|`/periodline 块位置与当前一致（列 51），但计算路径从"JS 长度 + 补偿"换成"显示列 + 等值"——在用户终端应渲染相同；有出入则调例外表。

## 影响

- `standard` preset:s_move 从 52/51 变 51/51，视觉不变、对齐更稳。
- 用户自定义 lineTemplate 里的 s_move:凡含 CJK/emoji label 的，对齐从"错或脆"变"正确"；纯 ASCII 的字节级不变。
- `compact`/`simple` preset 无 s_move，不受影响。
