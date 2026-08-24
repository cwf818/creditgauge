# 用量组件 stale 灰色显示设计

日期: 2026-08-17
状态: 已批准（2026-08-17）

## 背景

用户要求：与用量相关的组件 `m_windowQuota`、`m_countdown`、`m_quota` 在 provider fetch 处于 `stale` 状态时显示灰色。现状是 `m_windowQuota` 已经将关注侧 bar 和百分比切换为 `STALE_COLOR`；`m_countdown` 只在 stale 且 reset 已过期时显示灰色的 `n/a`；`m_quota` 仅在无法计算 quota 比例时因 `axisPct == null` 使用 `STALE_COLOR`，没有读取 provider-level 的 `stale` 标志。

用户确认：**stale 时强制使用 `STALE_COLOR`，覆盖显式 inline `|color|...`。**

## 目标行为

### m_countdown

- `stale === false`：保持当前默认颜色和正文格式。
- `stale === true`：无论 reset 时间是否存在、是否未来或已过期，整个正文使用 `STALE_COLOR`。
  - stale + future reset：灰色的正常 `<arrow><countdown>·<label>` 正文。
  - stale + past-due reset：灰色的 `<arrow>n/a·<label>` 正文，现有行为保留。
  - stale + no reset：灰色的 label-only 正文（如有可渲染 label）。
- 缺少 interval 或无法投影为 window 时，继续走现有 placeholder 路径；placeholder 的既有灰色语义不改变。
- `|color|...` 不得覆盖 stale 的 `STALE_COLOR`。

### m_quota

- `stale === false`：保持现有行为：quota 数字按 band 着色；无法计算比例时使用 `STALE_COLOR`；显式 `|color|...`（如适用）保持现有优先级。
- `stale === true`：quota 正文中的数字强制使用 `STALE_COLOR`，即使存在可计算的 band 百分比或显式用户颜色。
- quota 的 prefix 和 limit tail 保持当前 plain 结构；只切换当前由 `wrapQuotaBody` 着色的数字部分，不改变文本格式。
- 缺少 quota 数据时，继续走现有 placeholder 路径。

### m_windowQuota

保持现状，不改变其 bar/百分比 stale 着色和已有 inline color 规则；本次只补齐另外两个组件。

## 推荐实现

采用**目标模块定向接入**，不新增全局 stale 抽象：

1. 扩展 `wrapQuotaBody` 的参数，增加 `stale: boolean = false`（或等价的显式参数）。颜色选择优先级为：
   1. `stale === true` → `STALE_COLOR`；
   2. 否则存在 `userColor` → 用户颜色；
   3. 否则 `axisPct == null` → `STALE_COLOR`；
   4. 否则使用 `colorFor(axisPct, mode)`。
2. `m_quota` 调用 `wrapQuotaBody` 时传入 `c.stale`。
3. `m_countdown` 在现有 stale+past-due 分支之外，统一包装所有正常 reset suffix 正文：当 `c.stale` 为 true 时返回 `${STALE_COLOR}${body}${RESET}`；fresh 路径保持 `wrapPlainDefault`。
4. 不修改低层 `formatOneResetSuffix`、`formatCountdownValueOnly` 或其他模块的通用格式化语义，避免把 provider fetch stale 传播到实时 stdin 等不同数据源。

## 数据流与边界

`renderProviderLine` 将 provider fetch 失败后的缓存状态以 `RenderContext.stale` 传给模板渲染。模块本身负责把该状态映射到显示颜色：`m_countdown` 处理完整 reset suffix，`m_quota` 处理 quota 数字色。数据正文、placeholder、mode、term/window 选择均保持不变。

显式 inline color 是正常 fresh 数据的用户覆盖能力；在 stale 数据上强制灰色是数据可信度标记，因此 stale 优先级高于用户颜色。该规则只应用于本次涉及的 provider-backed 模块，不改变 token、speed、context 等其他模块已有的 stale 规则。

## 测试设计

在现有 `src/render.test.ts` 的 quota/countdown 测试附近增加或调整测试：

- `m_countdown|term:short`：stale + future reset 的正常倒计时正文包含 `STALE_COLOR`，不包含默认 teal。
- `m_countdown|term:short`：stale + past-due 继续输出 `n/a` 且使用 `STALE_COLOR`。
- `m_countdown|term:short`：stale + no reset 的 label-only 正文使用 `STALE_COLOR`（如当前测试/配置能构造该路径）。
- `m_countdown|term:short|color:<user>`：stale 时仍使用 `STALE_COLOR`，不使用用户颜色；fresh 时保留用户颜色。
- `m_quota|term:short`：stale + 可计算比例的 quota 数字使用 `STALE_COLOR`，而不是 band 色。
- `m_quota|term:short|color:<user>`：stale 时仍使用 `STALE_COLOR`，不使用用户颜色。
- fresh `m_quota` 的 band 色、prefix/limit plain 结构保持现有断言。
- 现有 `m_windowQuota` stale、inline color、remaining/used 测试保持通过。

测试断言应同时使用 `strip` 验证正文未改变，并直接检查 SGR 以验证颜色优先级。

## 非目标

- 不修改 `m_windowQuota` 的 stale 实现。
- 不改变 stale+past-due 的 `n/a` 业务规则。
- 不把所有模块的 stale 颜色统一重构为一个全局 helper。
- 不修改配置 schema、默认颜色、provider/cache 行为或版本号。

## 部署与验证

按项目约定执行：

1. `npm test`
2. `npm run typecheck`
3. `npm run build`
4. 将新的 `dist/index.js` 复制到当前最高版本的本地 plugin cache，并用本次变更的唯一标识做 grep smoke check。

不 bump 版本号；本次只修改现有 source/test 文件。
