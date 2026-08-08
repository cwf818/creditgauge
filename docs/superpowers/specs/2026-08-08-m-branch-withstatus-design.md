# m_branch withStatus 参数设计

日期: 2026-08-08
状态: 已批准（2026-08-08）

## 背景

用户要求（2026-08-08）：`m_branch` 增加 `withStatus:true/false` 参数，默认 `true`，使用 clean/dirty 颜色（`m_gitStatus` 同款），dirty 时在分支名后追加 `*`。

**探索发现**：
- `m_branch`（`render.ts:2981`）：裸形式渲染 `wrapPlainDefault("m_branch", branch, undefined)` → teal 默认色（`DEFAULT_COLORS.m_branch` = `NAMED_PALETTE.teal`），只显示分支名。
- `m_gitStatus`（`render.ts:2984-2988`）：`dirty ? NAMED_PALETTE.brown : BRIGHT_GREEN`，body 为 `"dirty"`/`"clean"` —— 即本设计的 clean/dirty 颜色来源。
- `readGitInfo(cwd)`（`src/git-info.ts`）→ `{ branch, dirty } | null`。
- `m_branch` 在默认 `git_info` fragment（`config.template.ts:300`）中，所以默认 `withStatus:true` 会改变默认渲染。
- INLINE_SCHEMAS 现状：`m_branch: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } }`；dispatcher skipLen 9。
- 参数 schema 形状：`{ named: { withStatus: (raw) => raw==="true"||raw==="false" ? raw : null } }`（`NULDROP_PARAM` / `VALUEONLY_PARAM` 同款 validator，非法值 → badarg）。

**用户决策**（2026-08-08 确认，后续两次细化）：
- 默认 `false`：裸 `m_branch` 无 suffix（teal 分支名，byte-identical 旧行为）；`|withStatus:true|` 显式开启 suffix。
- withStatus 只控制 suffix（dirty → `*`、clean → `✓`）及其 clean/dirty 色；分支主体保持原色逻辑（teal 默认，`|color|` 只覆盖主体）。

## 行为

### withStatus:true（显式开启）

`info = readGitInfo(cwd)`：
- `info == null` → placeholder `branch:n/a`（不变）。
- **主体** = `info.branch`，颜色按 m_branch 原逻辑：teal 默认色（`DEFAULT_COLORS.m_branch`），`|color|<c>` 覆盖主体色。
- **suffix** = `info.dirty ? "*" : "✓"`，颜色 = `info.dirty ? NAMED_PALETTE.brown : BRIGHT_GREEN`（与 `m_gitStatus` 颜色一致）—— clean/dirty 色只作用在 suffix 上。
- `|color|<c>` 只作用于主体，suffix 保持其 clean/dirty 色。

### withStatus:false / 默认

- 裸 `m_branch` 或 `|withStatus:false|`：`wrapPlainDefault("m_branch", branch, undefined)` → teal 默认色、无 suffix，与今天渲染 byte-identical。
- `|color|<c>` 覆盖主体色仍然赢。

## 注册位

| 位 | 内容 |
|---|---|
| 新常量 | `WITHSTATUS_PARAM = { named: { withStatus: (raw) => raw==="true"\|"false" ? raw : null } }` |
| INLINE_SCHEMAS | `m_branch: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...WITHSTATUS_PARAM.named } }` |
| MODULES（bare） | 重写：读 `c.passThrough?.withStatus`（默认 false，`!== "true"` 则无 suffix） |
| INLINE_RENDERERS | 重写：读 `params.withStatus`（默认 false，`!== "true"` 则无 suffix） |
| dispatcher | skipLen 9 不变 |
| PLACEHOLDERS | 不变（`branch:n/a`） |
| DEFAULT_COLORS | 不变（`m_branch: teal`，供 withStatus:false 路径使用） |

## 行为变化提示

默认 `git_info` fragment（`config.template.ts:298-307`）含 `m_branch` + `m_gitStatus`。默认 `withStatus:false` 后该行保持不变：
- clean：`⎇ Git: <teal>main</teal> clean`
- dirty：`⎇ Git: <teal>main</teal> dirty`

分支与 `m_gitStatus` 双份状态提示仅在用户显式 `|withStatus:true|` 时出现（suffix ✓/* + clean/dirty 词）；是否从模板去掉 `m_gitStatus` 由用户自行决定，不在本设计范围。

## 测试

在 `render-tokens.test.ts` 的 m_branch describe 块新增/更新：
1. 裸 `m_branch`（默认 withStatus:false）：teal `main`，无 `✓`/`*`（clean 与 dirty 都验证）。
2. `m_branch|withStatus:true`：clean → teal `main` + 绿色 `✓`；dirty → teal `main` + 棕色 `*`。
3. `m_branch|withStatus:false`：teal 分支名无 suffix（现有测试行为保持）。
4. `m_branch|color:red|withStatus:true`：主体红，suffix 保持 clean/dirty 色。
5. `m_template|git_info|withStatus:false` passthrough：teal 分支无 suffix。
6. 非 git repo → `branch:n/a` placeholder（不变）。

## 不做的

- 不 bump 版本号（`vX.X.X+` 标记保留）。
- 不改 `m_gitStatus` / `readGitInfo`。
- 不从 `git_info` fragment 移除 `m_gitStatus`。
- 不加 label 轴（`branch:` 占位不变）。

## 部署

实现 + 测试全绿后：`npm run build` → `cp dist/index.js` 进 cache 最高版本目录 → `grep -c` 冒烟确认新代码在运行时 bundle 中。
