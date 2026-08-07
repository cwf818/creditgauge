# m_memUsage band-color + m_memUsed/m_memTotal 收尾设计

日期: 2026-08-08
状态: 已批准（2026-08-08）

## 背景

用户要求"增加 m_memUsed 和 m_memTotal 模块;m_memUsage 默认颜色仍保持青色,未指定颜色时 `/` 左侧的 used 数据使用 bandcolor"。

**探索发现**:`m_memUsed` / `m_memTotal` 已在 commit `0b15e18`("feat: new modules, valueOnly support, and fixes")中实现并提交,bare + inline + `labels.labelMemUsed`/`labelMemTotal` + cyan 默认色 + placeholder + inline schema + dispatcher 都已接好。但存在 4 处问题:

1. **零测试** — 两模块无任何 `.test.ts` 覆盖。
2. **`m_memTotal` skipLen 写错** — `render.ts:7696` 传 `12`,按 `key.length + 1` 应为 `11`(`m_memTotal` 是 10 字符),会导致 inline 参数被多切 1 字符。
3. **缩进损坏** — `render.ts:4027`、`4944`、`5633-5634` 的 `m_memTotal:` 行缺缩进。
4. **模块计数注释过期** — `render.ts:4561` 的 "~36 modules"。

`m_memUsage` 目前整行包 cyan(`wrapPlainDefault`),无 band color。

**用户决策**(2026-08-08):
- 按"完善现有实现"处理,不推倒重写。
- `m_memUsage` 未指定颜色时,used 段取 band color,prefix + `/` + total 保持 cyan;`|color:X|` 整行覆盖。
- `m_memUsed` 保持 cyan 默认,不引入 band color。

## 行为变更

### m_memUsage 双色渲染

未指定 `|color|` 时,输出由"整行 cyan"改为:
`<cyan>Mem:</cyan><bandColor>2.3G</bandColor><cyan>/8.0G</cyan>`

- used 段( `/` 左侧)颜色 = `colorFor(pct, "used")`,`pct = (m.used / m.total) * 100`,走 `thresholds.percentBands`(默认 `[60,70,80,90]`)。
- **固定 `mode="used"` 传给 `colorFor`**:bytes 显示没有 used/remaining 语义,危险轴永远是"RAM 用了多少",不跟随 `c.mode`(与 `m_windowMemUsage` 的颜色语义一致——剩余模式也会被 `colorFor` 翻回 usedPct)。
- prefix、`/`、total 三处用模块默认色(`DEFAULT_COLORS.m_memUsage`,cyan)。
- `|color:<c>|` 覆盖 → 整行包用户色(override 永远赢,与 `wrapPlainDefault` 契约一致)。
- placeholder 路径不变。

### 实现结构

提取 module-local 共享 helper(两路径复用):

```ts
function renderMemUsageBody(prefix: string, used: number, total: number, paramsColor: string | undefined): string {
  const usedStr = formatMemBytes(used);
  const totalStr = formatMemBytes(total);
  if (paramsColor) return `${paramsColor}${prefix}${usedStr}/${totalStr}${RESET}`;
  const pct = total > 0 ? (used / total) * 100 : 0;
  const usedColor = colorFor(pct, "used");
  const restColor = DEFAULT_COLORS.m_memUsage;
  const wrap = (s: string) => (restColor ? `${restColor}${s}${RESET}` : s);
  return `${wrap(prefix)}${usedColor}${usedStr}${RESET}${wrap(`/${totalStr}`)}`;
}
```

- bare 路径(`render.ts:3216`):`return renderMemUsageBody(prefix, m.used, m.total, undefined);`
- inline 路径(`render.ts:7056`):`return renderMemUsageBody(prefix, m.used, m.total, params.color as string | undefined);`

## m_memUsed / m_memTotal 修复

- **skipLen**:`m_memTotal|` 从 `12` → `11`,修正注释(`render.ts:7695-7696`)。
- **缩进**:修复 `render.ts:4027`、`4944`、`5633-5634` 三处缺缩进行。
- **模块计数注释**:`render.ts:4561` 更新。

## 测试

在 `render-tokens.test.ts` 新增 `m_memUsed`/`m_memTotal` describe 块,沿用 m_memUsage 的 shape-only 风格(宿主 RAM 非确定性 → 只断言结构):

1. bare 输出 `used:X.XG` / `total:Y.YG`(strip 后 prefix 断言)。
2. `labelMemUsed` / `labelMemTotal` override 到达 prefix;默认值 byte-identical(`used:` / `total:`)。
3. inline `|nulldrop:true` 在 null 路径 drop placeholder。
4. inline `|color:red` 应用用户 SGR。
5. **skipLen 回归测试**:`m_memTotal|valueOnly:true` → strip 后不含 `total:` prefix。若 skipLen=12 会把 `v` 吃掉,`valueOnly` 解析失败 → prefix 保留 → 测试红,能抓住此 bug。

m_memUsage band-color 结构测试(现有 4 个 m_memUsage 测试为 shape-only,不会破坏):
- 未指定颜色时,输出含 `\x1b[0m/`(used 段单独着色并 RESET 关闭后再出现 `/`),strip 后仍为 `Mem:X.XG/Y.YG`。
- `|color:red` 整行红(现有测试已覆盖)。

## 不做的

- 不 bump 版本号(`vX.X.X+` 标记保留;version-bump-policy 只显式要求才 bump)。
- 不改 `config.template.ts` 的 preset 引用。
- 不给 m_memUsage 加 `display` 参数。
- 不改 m_memUsed / m_memTotal 默认色(cyan)。
- 不引入 passthrough-color 行为变化(保持现状 `params.color`)。

## 部署

实现 + 测试全绿后:`npm run build` → `cp dist/index.js` 进 cache 最高版本目录 → `grep -c` 冒烟确认新代码在运行时 bundle 中。
