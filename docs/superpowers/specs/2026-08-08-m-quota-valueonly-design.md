# m_quota valueOnly 支持 + 格式调整 设计

日期: 2026-08-08
状态: 已批准（2026-08-08）

## 背景

用户要求（2026-08-08）:给 `m_quota` 加 `valueOnly` 参数支持,格式为正常 `quota: 413.7/1500`、valueOnly 时 `413.7/1500`。

**探索发现**:

1. **m_quota 当前不支持 valueOnly**(三重证据):
   - inline schema(`render.ts:5654`)只有 `color / display / term / nulldrop`,没有 `VALUEONLY_PARAM.named` → `parseInlineArgs` 对未知参数 `return null`(`render.ts:7433`)→ badarg → warn + drop。
   - bare MODULES 入口(`render.ts:2079-2086`)不读 `c.passThrough?.valueOnly`(对比 `m_windowQuota` `render.ts:2045` 有)。
   - INLINE_RENDERERS 入口(`render.ts:6208-6223`)不读 `params.valueOnly`。
2. **HEAD 与部署 bundle 不同步**:HEAD `config.template.ts:66` 默认 quota fragment 带 `m_quota|term:long|display:remaining|valueOnly:true|nulldrop:true`(valueOnly 不支持 → badarg → 丢弃);部署 1.2.0 bundle 的默认 fragment 是 `...|nulldrop:true`(无 valueOnly)→ 渲染 `quota:1499.4/1500(30d)` 正常。这就是"内置能显示、config.json 丢失"的原因——用户把带 `valueOnly:true` 的 token 放进 `lineTemplates.quota` 覆盖内置 fragment,命中同样的 badarg → 整个模块 drop。
3. 当前 `m_quota` body:`${labelFor("quota")}<digit>/<total>(<label>)`(`render.ts:690`),label 默认 `"quota:"`(`config.ts:520`)。
4. `renderQuotaParts` / `wrapQuotaBody` 只被 m_quota 两条路径消费,无其他调用方。

**用户决策**(2026-08-08 逐题确认):
- **正常格式**:完全按字面 `quota: 1499.4/1500` —— 默认 label 加尾随空格(`"quota: "`),去掉 `(30d)` 后缀。
- **valueOnly 格式**:`1499.4/1500`(无 label、无括号)。
- **默认 fragment 的 `valueOnly:true` 保留**(选项 A)→ 默认渲染 `1499.4/1500`(裸数字,旁边已有 m_windowQuota 百分比条 + m_countdown 倒计时提供窗口上下文)。

## 行为

### 渲染

| 模式 | 输出 |
|---|---|
| 正常(数据齐) | `<prefix><tint><digit>RESET/<total>` → `quota: 1499.4/1500` |
| valueOnly(数据齐) | `<tint><digit>RESET/<total>` → `1499.4/1500` |
| 正常(数据缺) | `quota: n/a`(STALE_COLOR 包裹) |
| valueOnly(数据缺) | `n/a`(STALE_COLOR 包裹) |

- **颜色规则不变**:digit 用 `colorFor(axisPct, mode)` 5-band tint(`userColor` 覆盖赢;`axisPct == null` → STALE_COLOR);`/<total>` 保持 plain。valueOnly 只去 prefix,颜色规则照旧。
- **`(label)` 后缀删除**:live body 和 placeholder 都不再渲染 `(<term-label>)`(如 `(30d)`)。`renderQuotaParts` 返回的 `label` 字段变为死代码,一并删除(返回类型 + 7 处 return)。

### 实现结构

1. **schema**(`render.ts:5654`):m_quota 的 named 加 `...VALUEONLY_PARAM.named`。
2. **`wrapQuotaBody`**(`render.ts:670`)签名加 `valueOnly: boolean = false`:
   - body = `${tint}${parts.axisNumber}${RESET}/${total}`(去掉 `(${parts.label})`);
   - valueOnly ? body : `${parts.prefix}${body}`。
3. **MODULES 入口**(`render.ts:2079`):`wrapQuotaBody(parts, c.mode, undefined, c.passThrough?.valueOnly === "true")`。
4. **INLINE_RENDERERS 入口**(`render.ts:6208`):`wrapQuotaBody(parts, mode, params.color, params.valueOnly === "true")`。
5. **placeholderQuota**(`render.ts:4835`):读 `params.valueOnly === "true" || ctx.passThrough?.valueOnly === "true"`;valueOnly → `"n/a"`,否则 `${prefix}n/a`。不再走 `placeholderTermLabel`(label 后缀删除)。
6. **默认 label**(`config.ts:520`):`labelQuota: "quota:"` → `"quota: "`(尾随空格);同步更新 `config.ts:348-351` 过时注释(`quota(5h):123/500` → 新形状)。
7. **默认 fragment**(`config.template.ts:66`):不动(保留 `valueOnly:true`,选项 A)。

### 测试

- 更新 `render.test.ts` 现有 m_quota 断言:
  - `quota:0/1500(30d)` → `quota: 0/1500`
  - `quota:765/1500(30d)` → `quota: 765/1500`
  - `quota:42/1500(30d)` → `quota: 42/1500`
  - placeholder `quota:n/a(7d)` / `quota:n/a(30d)` → `quota: n/a`
  - `render.ts:689` / `4830-4832` / `4844` 注释同步。
- 新增 valueOnly 测试:
  - inline `m_quota|term:long|valueOnly:true` → `1499.4/1500`(band 色在 digit,`/1500` plain)。
  - 外层 `m_template|<key>|valueOnly:true` 透传到内层 m_quota。
  - placeholder:`m_quota|valueOnly:true`(数据缺)→ `n/a`。
  - 颜色覆盖:`m_quota|valueOnly:true|color:<c>` 整段包用户色。
- 检查 `render-tokens.test.ts` / `render-providerType.test.ts` / `render-affix.test.ts` / `dispatch.test.ts` 是否有 m_quota 断言需要同步(已确认 `m_quota`/`quota:` 只在 `render.test.ts` 命中)。
- **默认模板测试不受影响**:`renderQuotaLine`(render.test.ts:345+)用 DEFAULT_LINE_TEMPLATE.quota 渲染,但 m_quota token 带 `nulldrop:true` → legacyToIv 窗口无 quota 字段时 renderQuotaParts 返回 null → placeholder → nulldrop:true → chunk drop。所以默认模板在无 quota 数据时依旧不显示 m_quota,renderQuotaLine 断言不变;`render-affix.test.ts` 只查无双空格,同样不受影响。

### 部署

- `npm test` → `npm run build` → 复制 `dist/index.js` 进 `~/.claude/plugins/cache/creditgauge/creditgauge/1.2.0/dist/index.js`(minimal deploy,不 bump 版本)。
- ⚠️ 重部署后用户状态栏 m_quota 从 `quota:1499.4/1500(30d)` 变为 `1499.4/1500`(HEAD 默认 fragment 的 valueOnly:true 生效)—— 已确认(选项 A)。

### 用户 config.json 影响

- `m_quota|...|valueOnly:true...` 在 `lineTemplates` 里不再 badarg → "丢失该模块" 修复。
- 用户当前 config.json 只有 `quote` fragment;`statuslineTemplate: "standard"` 的 quota 行走 `m_template|quota` → 内置 quota fragment;自定义则加 `"quota": [...]` 覆盖。
