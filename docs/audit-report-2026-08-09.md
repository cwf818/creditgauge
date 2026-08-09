# 注释与文档一致性审计报告

日期: 2026-08-09
分支: `docs/align-comments-docs`
基准: git HEAD `4ce94de`（v1.2.0）
方法: 四个只读审计 agent 并行对照 `src/` 现行代码逐项核实。严重度:
- **(A)** 直接与当前行为矛盾（最需修）
- **(B)** 过期/误导但无害
- **(C)** 历史叙述（准确记录当时状态）

---

## 执行摘要

审计覆盖全部用户文档（MANUAL / README / 快速上手指南 / HOW_TO_CREATE_A_PLUGIN / SECURITY）、全部 `src/*.ts` 注释、commands/scripts/plugin-manifest/CLAUDE.md、以及 docs/superpowers 的设计文档。共发现 **100+ 处**，其中约 **40 处 (A) 直接矛盾**。

**最严重的一个功能性问题**：**插件宣传 5 个预设，代码里只有 3 个。** `DEFAULT_STATUSLINE_PRESETS`（`src/config.template.ts`）只有 `simple` / `compact` / `standard`，但 `scripts/config.sh`、`commands/config.md`、`config.min.json`、`src/config.ts` 默认逻辑、CHANGELOG v1.2.0 都在引用不存在的 `abundant` 与 `standard-slim`。后果：
- 全新安装会 seed 一个 `statuslineTemplate: "standard-slim"` 的 `config.json` → 加载时 warn + 回退到最简 quota/balance 模板；
- `/creditgauge:config --preset-standard-slim` 写入一个被 loader 拒绝的值。
（按"均以当前项目为准"原则，修正方向 = 删掉不存在的预设引用，而不是在代码里补回它们。）

---

## 一、功能性产物（必须修，影响运行/命令）

| 位置 | 现状 | 问题 |
|---|---|---|
| `scripts/config.sh:19-29,87` | `VALID_PRESETS="simple compact standard abundant standard-slim"`；状态视图打印 `standard-slim (default preset)` | 其中 2 个预设不存在；"default preset" 说法不成立（无 config 时实际回退到最简模板） |
| `commands/config.md:18` | "Valid presets: simple, compact, standard, abundant, standard-slim" | 同上 |
| `config.min.json:8` | `"statuslineTemplate": "standard-slim"` | 不存在 → warn + 回退 |
| `src/config.ts:756-768` | 注释"use standard-slim as the default template" + `DEFAULT_STATUSLINE_PRESETS["standard-slim"] ?? …` | `["standard-slim"]` 恒为 undefined，默认模板实际是 quota/balance 两 token |
| `scripts/test-config.sh:116,141,169-189` | 断言过期预设名/标题 | 与 config.sh 同步失效 |
| `src/config.ts:420-426` 注释 | "statuslineTemplate 仅数组，legacy string 自动迁移" | 实际 string-form 预设名查找是现行行为，无自动迁移 |
| `.claude-plugin/marketplace.json:6-8` | 只说 4 个命令 | 实际 7 个（:clean-journal, :reset, :config 缺） |
| `settings.example.json:11-13` | 示例 statusLine 直接调 dist/index.js、缺 refreshInterval | 绕过 wrapper.sh 的 stdin tee；install.sh 总会写 refreshInterval |

---

## 二、用户文档矛盾

### MANUAL.md（17 处 A + ~20 处 B，最重灾区）
- 默认 display：文档 `used` → 实际 `remaining`
- `labels.*` 块出现不存在的 key（`labelTokenTotalOut`/`labelApi`/`labelInSpeed`/`labelOutSpeed`/`labelContextWindowsSize`）并遗漏现行 key（`labelApiMs`/`labelGitClean`/`labelGitDirty`/`labelQuota`/`labelMemUsed`/`labelMemTotal`/`labelContextUsage`）
- `labelTokenTotalIn` 默认 `in:` → 实际 `total:`
- `speedScaleBands` 默认值两处不符
- 预设：文档 5 个 / 实际 3 个；`standard-slim`/`abundant` 行、13 fragments / 实际 11 个；fragment 表列出的 `quota_all`/`tokens_tick`/`tokens_acc`/`tokens_stat`/`information`/`git_info_all`/`context_all`/`tick_eval`/`acc_eval`/`stat_eval` 全部不存在
- `m_quota` 形状、`m_balance` 货币符号示例、`provider`（应为 `providers`）轴、`model` 默认 `active`→实际 `all`、`max` 默认 `1024`→实际 60、bare 模块"DROP"→实际 STALE placeholder、`m_quote|wrap:false`（wrap 已是 char-pair）、sum 缓存 `state/<projectHash>/cache.json`→实际顶层 `state/cache.stat.json`、composition "上下拆分 prepend/append"→实际整体 append、`state/config.json`→实际 `config.json`、`COMPARE_METHOD` 默认 EXACT（用户条目缺字段会被丢弃）、颜色快捷名 `green`/`white`（实际 `brightGreen`/`darkGreen`，无 white）、`type` 缺 `unknown`、`m_branch` 缺 `withStatus` 内联参数、per-turn/acc/sum 模块缺 `valueOnly`

### README.md（11 处）
- 默认 mode `used` → 实际 `remaining`；`standard-slim` 预设不存在；`standard` 尾部无 `m_sumTtlStatus`；默认模板描述；多币种余额"按最低档统一上色"→实际逐条独立上色；缓存路径 `state/<projectHash>/cache.json`→实际顶层 `state/cache.json`；`api.plan.ts`/`api.balance.ts` 文件不存在（解析在 minimax/deepseek 插件里）；countdown `30s→<1m`（默认 minUnit 是 s）

### 快速上手指南.md（5 处）
- "5 种预设"、`standard-slim` 及 `tickline-slim`/`combline1-slim`/`combline2-slim` fragment、`information`/`git_info_all`/`tick_eval` fragment——全部不存在；§0 示例 countdown 格式过期

### HOW_TO_CREATE_A_PLUGIN.md（3 处）
- `COMPARE_METHOD` 默认 EXACT（用户条目缺字段会被丢弃）；`query_plugins/` 实际含 bigmodel/copilot-api/kimi/opencode；冒烟路径版本 0.9.2→1.2.0

### SECURITY.md
- 无矛盾（唯一干净的文档）

---

## 三、源码注释矛盾（按文件）

### src/config.ts
- `:420-426` statuslineTemplate "array-only + auto-migration" 注释（已过时）
- `:756-768` standard-slim 默认模板注释（已过时）
- `:104-123` DEFAULT_STALE 尾部注释块放错位置（描述的是 countdown.resetArrows）
- `:1074-1090` cacheTtlMs 校验块重复一次（死代码）

### src/render.ts
- `:183` labelFor pluginSystem 注释写默认 `⚙` → 实际 `📌`
- `:4714-4717,5946-5949` withStatus "default true + `*` dirty suffix" → 实际 default false + `🟠`
- `:2614-2622,4587-4598` m_sum* 默认 model/window/align → 实际 `all/all/false`
- `:1428-1429,2248-2255,3057-3064,6408-6415,7094-7098` lastActive/apiMs/hitRate "60s TTL" → 实际 R7 已禁用 TTL，永久 last-known-good
- `:8006-8011,5878-5892,5911-5928,5937` m_template `mode`/`plan`/`ALIGN_PARAM`/行号引用全过时或乱码
- `:9-15,711-717,875-877,1746-1761,699,509,2891,1167,2028,318,7684,7693,1202,1335,3573,7241,2838,6889,4593,7182,8312-8315` — 引用已删除模块/函数（`m_window5h/7d`、`s_<n>`、`formatOne`、`m_tokenInAvg`/`computeTickAvg`、`slotsToWindow`、`parseQuota`、`tsToIso`、`fiveHour/weekly` 字段、`sumApiCount`）
- `:4038,4041,6213-6216` `NAMED_PALETTE.stale` 键不存在 → `DEFAULT_COLORS.m_age`/`m_modeLabel` 为 undefined

### src/status-store.ts
- `:18-21` 说 token-store.ts/tick-state.ts/data-processor.ts 是 shim——三个文件已不存在
- `:2111-2115` 注释"prev baseline 在无效 tick 也落盘" → 实际 guard 提前 return，不落盘

### src/cache.ts
- `:13-21,77-79` 说 render.ts 用 `projectHash(cwd):` 前缀隔离——实际用 `cache.peekWithTtl(currentProvider)`，无前缀、无 projectCacheKey
- `:182-185` "flush 前 evict 过期条目" → 实际不 evict（两行注释互相矛盾，代码与第二行一致）

### src/git-info.ts
- `:66-74` "跑三次 git 调用含 status --porcelain --branch 首行分支状态" → 实际两次调用，无 --branch
- `:24` "与 api.plan.ts cache TTL 同步" → api.plan.ts 不存在

### src/api.quote.ts
- `:2` "mirrors src/api.plan.ts" → 文件不存在

### src/providers.ts
- `:134` "kept as a deprecated alias below" → 下方无该 alias

### src/dispatch.ts
- `:165-166,238-242,267,291,318,341,346` `fiveHour`/`weekly`/`m_ctx`/`s_<n>` 引用（已删）

### src/types.ts
- `:62-63` m_token5h/m_token7d 引用（已删）；`:244-274` AccSnapshot 注释指向已移动的 render.ts 辅助函数 + 行号过期，类型已死

### src/plugins/data.ts
- `:17` 说 minimax/deepseek/kimi/copilot 都是内置插件——实际只打包 minimax+deepseek
- `:24-30` 与 parsers.ts 注释自相矛盾（shortInterval/midInterval 字段映射是否还在——实际不映射）

### src/config.template.ts
- 近期已清理，无新问题

---

## 四、历史设计文档（docs/superpowers + CHANGELOG）

这些是按日期存档的设计记录，**建议保持历史原样**（改写会伪造历史）。但其中多处引用已与现行代码矛盾，对从当前代码出发的读者有误导。最误导的:
- `plans/2026-08-08-m-branch-withstatus.md` —— 全局约束写 "withStatus 默认 true + `*` + `|color|` 覆盖整个 span"，与现行默认 false + ✅/🟠 + body-only-color **完全相反**
- `specs/2026-08-08-m-branch-withstatus-design.md` —— ✓/* → 现行 ✅/🟠；git_info 已重设计
- `specs/2026-08-07-creditgauge-config-command-design.md` + 同名 plan —— 5 预设列表过期
- `specs/2026-08-08-m-quota-valueonly-design.md` + 同名 plan —— "option A 默认 fragment 保留 valueOnly" 已被次日反转
- `specs/2026-08-09-s-move-width-aware-design.md` + 同名 plan —— `s_move|pos:51` → 实际 45
- CHANGELOG v1.2.0 "Valid presets 含 abundant/standard-slim" —— 与现状矛盾（历史条目，不改，但注明）

---

## 五、建议的处理范围

1. **必改（A，current-facing）**：config.sh / commands/config.md / config.min.json / config.ts 默认逻辑与注释 / MANUAL.md / README.md / 快速上手指南.md / HOW_TO_CREATE_A_PLUGIN.md / src 全部矛盾注释 / marketplace.json / settings.example.json / install.sh 注释 / CLAUDE.md
2. **留历史（不改）**：docs/superpowers/specs|plans、CHANGELOG.md（可选给最误导的几篇加一行 "已被 xxx 取代" 注记）
3. **可选**：`config.ts:1074-1090` 重复 cacheTtlMs 校验死代码清理
