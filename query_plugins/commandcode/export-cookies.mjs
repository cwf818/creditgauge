#!/usr/bin/env node
// Convert a browser cookies export into the plugin's Playwright-format
// credentials file, so you can authenticate without fighting the Cloudflare
// login wall in an automated browser.
//
// Flow:
//   1. Log into commandcode.ai in your NORMAL browser (Chrome/Edge/Firefox).
//   2. Export the cookies with a browser extension (EditThisCookie /
//      Cookie-Editor / "Get cookies.txt" JSON exporters all work).
//   3. Run:
//        node export-cookies.mjs <exported.json> [account-slug]
//      and the file is written to
//        ~/.claude/plugins/creditgauge/credentials/commandcode/<slug>.session-cookies.json
//   4. Verify: node test.mjs live   (needs AUTHENTICATION_KEY env)
//
// Accepted export shapes (any of these fields present is enough):
//   - Playwright / Puppeteer: {name, value, domain, path, expires, httpOnly, secure, sameSite}
//   - EditThisCookie:         {name, value, domain, ...}  (adds hostOnly/storeId/id)
//   - Minimal:                {name, value, domain}  — the plugin only reads these three.
//
// expires is normalized to a number (epoch seconds); missing / 0 / session →
// -1 (session cookie). domain leading-dots are stripped so both "commandcode.ai"
// and ".commandcode.ai" entries normalize the same way.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ARGS = process.argv.slice(2);
const CREDENTIALS_DIR = join(
  homedir(),
  ".claude", "plugins", "creditgauge", "credentials", "commandcode"
);

function usage() {
  console.error(`用法:
  node export-cookies.mjs <导出文件> [account-slug]

<导出文件>    浏览器扩展导出的 cookie JSON 文件路径。
[account-slug] 你的 commandcode 账号 slug (usage 页面 URL 中的 <slug>)。
               不填则从 ~/.claude/plugins/creditgauge/config.json 的
               providers.commandcode.AUTHENTICATION_KEY 读取。
`);
}

function readConfigSlug() {
  try {
    const p = join(homedir(), ".claude", "plugins", "creditgauge", "config.json");
    if (!existsSync(p)) return null;
    const cfg = JSON.parse(readFileSync(p, "utf-8"));
    const key = cfg?.providers?.commandcode?.AUTHENTICATION_KEY;
    if (typeof key === "string" && key !== "" && key !== "your-account-slug") return key;
  } catch (_) {
    /* config may not exist / be malformed — fall through */
  }
  return null;
}

function normalizeExpires(raw) {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
  }
  return -1; // session cookie / no expiry
}

// Normalize one exported cookie into the Playwright shape. Returns null when
// the entry is unusable (no name/value/domain).
function normalizeCookie(c) {
  if (!c || typeof c !== "object") return null;
  if (typeof c.name !== "string" || c.name === "") return null;
  if (typeof c.value !== "string") return null;
  if (typeof c.domain !== "string" || c.domain === "") return null;
  let domain = c.domain;
  if (domain.startsWith(".")) domain = domain.slice(1);
  return {
    name: c.name,
    value: c.value,
    domain,
    path: typeof c.path === "string" && c.path !== "" ? c.path : "/",
    expires: normalizeExpires(c.expires),
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite:
      typeof c.sameSite === "string" && ["Lax", "Strict", "None"].includes(c.sameSite)
        ? c.sameSite
        : "Lax",
  };
}

const [exportPath, slugArg] = ARGS;

if (!exportPath) {
  usage();
  process.exit(1);
}

if (!existsSync(exportPath)) {
  console.error(`错误: 找不到导出文件 ${exportPath}`);
  process.exit(1);
}

// ---- load + parse the export ----
let raw;
try {
  raw = JSON.parse(readFileSync(exportPath, "utf-8"));
} catch (e) {
  console.error(`错误: 无法解析导出文件 (JSON 格式错误): ${e.message}`);
  process.exit(1);
}
const list = Array.isArray(raw) ? raw : [raw];

// ---- normalize ----
const cookies = list.map(normalizeCookie).filter(Boolean);
if (cookies.length === 0) {
  console.error("错误: 导出文件里没有可用的 cookie (需要 name/value/domain 字段的对象数组)。");
  process.exit(1);
}

// ---- resolve the account slug ----
const slug = slugArg || readConfigSlug();
if (!slug) {
  console.error("错误: 无法确定账号 slug。请在命令行传入: node export-cookies.mjs <导出文件> <slug>");
  process.exit(1);
}

mkdirSync(CREDENTIALS_DIR, { recursive: true });
const outPath = join(CREDENTIALS_DIR, `${slug}.session-cookies.json`);
writeFileSync(outPath, JSON.stringify(cookies, null, 2) + "\n", "utf-8");

// ---- report ----
const ccCount = cookies.filter(
  (c) => c.domain === "commandcode.ai" || c.domain.endsWith(".commandcode.ai")
).length;
console.log(`  ✓ 已转换 ${cookies.length} 个 cookie (其中 commandcode.ai 相关 ${ccCount} 个)`);
console.log(`    写入: ${outPath}`);
if (ccCount === 0) {
  console.warn("  ⚠ 没有 commandcode.ai 域的 cookie —— 请确认你是在 commandcode.ai 登录后导出的。");
} else {
  console.log("");
  console.log("  验证查询: AUTHENTICATION_KEY=<slug> node test.mjs live");
}
