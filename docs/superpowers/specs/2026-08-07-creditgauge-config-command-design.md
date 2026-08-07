# /creditgauge:config 命令设计

日期: 2026-08-07
状态: 已批准（2026-08-07）

## 背景

creditgauge（CreditGauge-CC）目前有 6 个 slash 命令（install / uninstall / clean /
clean-cache / clean-journal / reset），均为 Pattern B2（`commands/*.md` +
` ```! ` fenced block + `allowed-tools` 指向 `scripts/<name>.sh`）。

本次新增 `/creditgauge:config`，支持两类操作：
1. 禁用/启用 upstream（若存在）。
2. 把 config.json 的 `statuslineTemplate` 切换为选定的 preset 名。

## 参数语法

```
/creditgauge:config                     # 打印当前状态（只读）
/creditgauge:config --preset-<name>     # 切换 statuslineTemplate 到 preset
/creditgauge:config --disable-upstream  # 禁用 upstream（若存在）
/creditgauge:config --enable-upstream   # 重新启用 upstream
/creditgauge:config --dry-run           # 只打印将做的操作，不改动
```

- 一次调用可组合多个动作（每个动作独立执行并打印自己的结果行）；`--dry-run` 是修饰符，可与动作参数组合。
- 未知 flag → 报错 + 打印用法。
- 未知 preset 名 → 报错 + 列出合法 preset。
- 可用 preset（`DEFAULT_STATUSLINE_PRESETS` 的 key）：
  `simple` / `compact` / `standard` / `abundant` / `standard-slim`。
  该列表硬编码在 `config.sh` 中，并带注释要求与 `src/config.template.ts` 同步。

## 组件结构

```
commands/config.md           # Pattern B2 slash command
scripts/config.sh            # bash 入口：解析参数、解析路径、调 node 助手
scripts/lib/edit-config.mjs  # Node 助手：读写 config.json 的 statuslineTemplate
scripts/test-config.sh       # 回归测试（隔离 tmpdir，镜像 test-install.sh）
```

- `.claude-plugin/plugin.json` 的 `commands` 数组新增 `./commands/config.md`。
- 路径解析与现有脚本一致：`CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"`。
- 无 `--project` 变体：config.json 恒为用户级 `plugins/creditgauge/config.json`。

### config.sh（bash 入口）

- 参数解析：`--preset-*`（取前缀后剩余部分为 preset 名）、`--disable-upstream`、
  `--enable-upstream`、`--dry-run`、`--help|-h`、未知参数报错。
- 解析 `CLAUDE_ROOT`，计算：
  - `CONFIG_FILE="${CLAUDE_ROOT}/plugins/creditgauge/config.json"`
  - `STATE_DIR="${CLAUDE_ROOT}/plugins/creditgauge/state"`
  - `UPSTREAM_CMD="${STATE_DIR}/upstream-cmd.sh"`
  - `UPSTREAM_DISABLED="${STATE_DIR}/upstream-cmd.sh.disabled"`
- 无参数 → 打印当前状态（见「状态视图」）。
- `--disable-upstream` / `--enable-upstream` 为纯文件操作（见「upstream 切换」）。
- `--preset-<name>` → 调 `node "${SCRIPT_DIR}/lib/edit-config.mjs" <config-file> set-preset <name>`。
- `--dry-run`：所有动作只打印 `would <动作>`，零改动（upstream 重命名和 preset 写入都走 dry-run 分支）。

### lib/edit-config.mjs（Node 助手）

镜像 `scripts/lib/edit-settings.mjs` 的读-改-写模式：

- **读取**：`readFileSync(configFile, "utf8")`。文件不存在 → 视为空对象 `{}`（对 `--preset-X` 意味着会新建文件）。
- **坏 JSON** → stderr 报错、退出码非零、不覆盖原文件。
- **写**：设置 `"statuslineTemplate": "<name>"`（字符串形式——loader 已支持字符串即 preset 名，
  且与 install.sh 播种的 `config.min.json` 一致），**保留其他所有字段**。
- **行尾**：检测原文件 CRLF/LF，写回时保留（同 `edit-settings.mjs` 的 `writeJson`）。

## --preset-<name> 语义

- 读-改-写 config.json，只动 `statuslineTemplate` 字段。
- 若当前值是自定义字符串数组（非 preset）→ 打印一条提示说明它被替换。
- config.json 不存在 → 新建，内容仅含 `{"statuslineTemplate": "<name>"}`。

## --[disable/enable]-upstream 语义

**机制：在稳定 state 目录重命名文件**（零运行时改动，无需碰 settings.json）。

```
~/.claude/plugins/creditgauge/state/
  upstream-cmd.sh            # 存在 → upstream 生效（wrapper 的 `[ -f ]` 检查通过）
  upstream-cmd.sh.disabled   # 存在 → upstream 被禁用（重命名后 `[ -f ]` 失败）
```

选这个机制的原因：
- `statusLine.command` 里的 `export CREDITGAUGE_UPSTREAM_CMD=.../upstream-cmd.sh`
  是静态的、由 `buildLatestCacheCommand` 生成；wrapper.sh 的
  `[ -f "$CREDITGAUGE_UPSTREAM_CMD" ]` 天然以文件存在性为开关。
- 改 settings.json 会与 install-journal 交互、增加 `isOurWrapperCommand` 脆弱性。
- 改 wrapper.sh 需随每个版本发布，且版本回滚时旧 wrapper 不认识新标记。
- 重命名是原子、可逆、跨版本稳定（state 目录是 stable 位置）。

状态机：
- `--disable-upstream`：`upstream-cmd.sh` 存在 → `mv` 为 `.disabled`；
  已是 disabled 或两者皆无 → no-op + 提示。
- `--enable-upstream`：`.disabled` 存在 → 改回；`upstream-cmd.sh` 已存在 →
  no-op（已启用）；两者皆无 → no-op + 提示「没有可恢复的 upstream」。

小清理：把 `upstream-cmd.sh.disabled` 加进 `uninstall.sh` 的 `ALWAYS_STATE_FILES`
wipe 列表，避免 uninstall 后残留。

## 状态视图（无参数）

```
当前配置:
  statuslineTemplate: standard-slim   (preset)
  upstream:           enabled   (state/upstream-cmd.sh)
```

- statuslineTemplate：
  - 字符串且匹配 preset → `(preset)`
  - 字符串但不匹配 → `(unknown preset: "xxx")` + 列出合法值
  - 数组 → `(custom template, N tokens)`
- upstream：`enabled` / `disabled (preserved)` / `none (no upstream was preserved)`。

## 错误处理

- 所有文件操作前检查目标存在性；`mv` 失败 → 非零退出 + stderr 消息。
- config.json 解析失败（坏 JSON）→ 不覆盖，报错退出，提示用户手动修复。
- `--dry-run` 打印每个动作的「would do」行，零改动。

## 测试（scripts/test-config.sh）

隔离 tmpdir，镜像 `test-install.sh` 的 fixture 风格：

1. 无参输出（preset + upstream 状态行）。
2. `--preset-standard` 写入字符串、保留其他字段、行尾保留。
3. 未知 preset → 非零 + 合法列表。
4. `--disable-upstream` / `--enable-upstream` 重命名往返 + 幂等性（重复 disable/enable）。
5. 不存在 upstream 时 disable/enable → no-op + 提示。
6. `--dry-run` 零改动。
7. 坏 JSON 的 config.json → 报错不覆盖。
8. config.json 不存在时 `--preset-X` 新建文件。

## 发布注意

新命令要生效于**已安装的插件**，需要 bump 版本号 + full mirror（plugin.json 的
commands 数组变了）。按版本策略（[[plugin-json-version-sync]]），版本 bump 只在显式
要求时执行——本次先落在 repo，需要时再发布。
