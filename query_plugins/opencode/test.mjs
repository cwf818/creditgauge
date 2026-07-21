// 简单测试：导入 opencode 插件，传入 Cookie 文件路径和 WORKSPACE_URL，打印结果
// 用法: OPENCODE_WORKSPACE_URL=https://opencode.ai/workspace/wrk_xxx/go node test.mjs
import plugin from "./index.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cookiePath = join(__dirname, "..", ".session-cookies.json");
const workspaceUrl = process.env.OPENCODE_WORKSPACE_URL;

if (!workspaceUrl) {
  console.error("请设置 OPENCODE_WORKSPACE_URL 环境变量");
  process.exit(1);
}

console.log("Cookie 文件:", cookiePath);
console.log("WORKSPACE_URL:", workspaceUrl);
console.log("正在抓取 opencode.ai 工作区用量...\n");

const result = await plugin.fetchAccountCredit(cookiePath, {
  providerEntry: { WORKSPACE_URL: workspaceUrl },
});

if (!result) {
  console.log("未获取到数据（Cookie 可能已过期）");
  process.exit(1);
}

console.log("========== 用量数据 ==========\n");

for (const [key, interval] of Object.entries(result)) {
  if (!interval) {
    console.log(`[${key}] 无数据`);
    continue;
  }
  console.log(`[${key}] (${interval.label})`);
  console.log(`  剩余:    ${interval.remainingPercent}%`);
  console.log(`  已用:    ${interval.usedPercent}%`);
  console.log(`  窗口:    ${(interval.intervalMs / 3600000).toFixed(1)}h`);
  console.log(`  重置于:  ${new Date(interval.endAt).toLocaleString()}`);
  console.log(`  起始于:  ${new Date(interval.startAt).toLocaleString()}`);
  console.log();
}

console.log("========== JSON 原始输出 ==========");
console.log(JSON.stringify(result, null, 2));
