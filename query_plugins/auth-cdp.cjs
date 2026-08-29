#!/usr/bin/env node
/**
 * auth-cdp.cjs — 零依赖 Cookie 认证工具 (替代 Playwright 方案)
 *
 * 通过 Chrome DevTools Protocol (CDP) 从本机浏览器直接抓取会话 Cookie：
 *   - 不安装 playwright (省 ~300MB 下载)
 *   - 不启动自动化浏览器 —— 用的是你真实的浏览器与指纹,
 *     天然规避 Cloudflare 对自动化浏览器的 "Verification unavailable" 拦截
 *   - 复用你已登录的会话, 很多情况下连重新登录都不需要
 *
 * 支持 provider: opencode / commandcode
 *
 * 用法:
 *   node query_plugins/auth-cdp.cjs commandcode [--account-id <slug>]
 *   node query_plugins/auth-cdp.cjs opencode    [--workspace-id <wrk_xxx>]
 *
 * AUTHENTICATION_KEY 不再是必填项:
 *   - 已提供 (CLI 参数或 config.json) → 直接打开对应用量页
 *   - 未提供 → 打开登录页, 登录成功后从地址栏自动识别账号 ID
 *     (commandcode: https://commandcode.ai/<slug>/..., 页面侧边栏链接兜底;
 *      opencode:    https://opencode.ai/workspace/<wrk_xxx>...)
 *   - 识别到的 ID 与 Cookie 统一写入固定的
 *       ~/.claude/plugins/creditgauge/credentials/<provider>/auth.json
 *     (不回填 config.json; 插件端显式读取该文件)
 *
 * 流程:
 *   1. 若 9222 端口已有调试浏览器 → 直接复用 (可用你自己的默认 profile)
 *   2. 否则自动查找本机 Chrome/Edge, 用临时 profile + 调试端口拉起并打开登录页
 *   3. 在弹出的真实浏览器中完成登录 (已登录则直接继续)
 *   4. 脚本自动识别 ID 并抓取 Cookie, 也可按回车手动指定 ID
 *   5. 写入 auth.json: { provider, id, savedAt, cookies }
 *
 * 依赖: Node >= 21 (内置 fetch + WebSocket), 本机装有 Chrome/Edge。
 * 可选: 设环境变量 CHROME_PATH / EDGE_PATH 指定浏览器路径。
 */

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

// =========================================================================
// 常量
// =========================================================================

const DEBUG_PORT = 9222;
const DEBUG_ROOT = `http://127.0.0.1:${DEBUG_PORT}`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const CREDITGAUGE_DIR = path.join(os.homedir(), ".claude", "plugins", "creditgauge");
const CONFIG_PATH = path.join(CREDITGAUGE_DIR, "config.json");

const LOGIN_WAIT_MS = 10 * 60 * 1000; // 登录等待上限 10 分钟

/** commandcode 域名下不属于账号 slug 的保留路径段 */
const CC_RESERVED_SLUGS = new Set([
  "signin", "auth", "login", "signup", "register", "settings", "docs", "help",
  "pricing", "blog", "about", "contact", "terms", "privacy", "api", "download",
  "status", "changelog", "careers",
]);

// =========================================================================
// Provider 配置
// =========================================================================

const PROVIDERS = {
  commandcode: {
    label: "CommandCode",
    loginUrl: "https://commandcode.ai/signin",
    url: (id) => `https://commandcode.ai/${id}/settings/usage`,
    idArg: "--account-id",
    idHint: "账号 slug (字母/数字/下划线/短横线)",
    idValidate: (id) => /^[A-Za-z0-9_-]{3,}$/.test(id),
    idError: "账号 slug 格式不正确 (应为字母/数字/下划线/短横线)",
    domains: ["commandcode.ai"],
    // 地址栏提取已移除: 登录后默认跳转 https://commandcode.ai/studio, 路径首段
    // 不含 slug (会把 "studio" 误判为账号 ID)。ID 只依赖页面 usage 链接提取。
    extractIdFromUrl: null,
    // 页面内精确查找 usage 页面链接
    //   https://commandcode.ai/<id>/settings/usage   (绝对路径)
    //   /<id>/settings/usage                          (相对路径)
    extractIdFromPage() {
      return `(() => {
        const pats = [
          /^https:\\/\\/commandcode\\.ai\\/([A-Za-z0-9_-]{3,})\\/settings\\/usage/,
          /^\\/([A-Za-z0-9_-]{3,})\\/settings\\/usage/,
        ];
        const skip = new Set([${[...CC_RESERVED_SLUGS].map((s) => JSON.stringify(s)).join(",")}]);
        for (const a of document.querySelectorAll("a[href]")) {
          for (const re of pats) {
            const m = re.exec(a.href);
            if (m && !skip.has(m[1])) return m[1];
          }
        }
        return null;
      })()`;
    },
    // 用 billing 端点验证会话是否真的有效 —— 与旧 auth.cjs 相同的手段
    async autoConfirm(cookies) {
      const relevant = cookies.filter(
        (c) => c.domain === "commandcode.ai" || c.domain.endsWith(".commandcode.ai")
      );
      if (relevant.length === 0) return false;
      const header = relevant.map((c) => `${c.name}=${c.value}`).join("; ");
      try {
        const res = await fetch("https://api.commandcode.ai/internal/billing/credits", {
          headers: {
            Cookie: header,
            "User-Agent": USER_AGENT,
            Accept: "application/json",
          },
        });
        if (!res.ok) return false;
        const body = JSON.parse(await res.text());
        return !!(body && body.credits && body.windowLimits);
      } catch {
        return false;
      }
    },
  },

  opencode: {
    label: "opencode.ai",
    loginUrl: "https://opencode.ai/auth",
    url: (id) => `https://opencode.ai/workspace/${id}/go`,
    idArg: "--workspace-id",
    idHint: "工作区 ID (wrk_ 开头)",
    idValidate: (id) => id.startsWith("wrk_") && id.length >= 10,
    idError: "工作区 ID 应以 wrk_ 开头且长度不少于 10",
    domains: ["opencode.ai"],
    // 从地址栏识别: /workspace/<wrk_xxx>... 即工作区 ID
    extractIdFromUrl(href) {
      try {
        const u = new URL(href);
        if (u.hostname !== "opencode.ai" && u.hostname !== "www.opencode.ai") return null;
        const m = u.pathname.match(/\/workspace\/(wrk_[A-Za-z0-9_]{3,})/);
        return m ? m[1] : null;
      } catch {
        return null;
      }
    },
    extractIdFromPage: null,
    // 宽松检测: 登录后通常会有多个目标域 cookie; 不确定时按回车兜底
    autoConfirm(cookies) {
      const n = cookies.filter(
        (c) => c.domain === "opencode.ai" || c.domain.endsWith(".opencode.ai")
      ).length;
      return n >= 3;
    },
  },
};

// =========================================================================
// 工具函数
// =========================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function parseCliId(argv, provider) {
  const idx = argv.indexOf(provider.idArg);
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1].trim();
  return null;
}

function readConfigId(providerId) {
  const cfg = loadConfig();
  const key = cfg?.providers?.[providerId]?.AUTHENTICATION_KEY;
  if (typeof key === "string" && key && key !== "REPLACE_ME") return key;
  return null;
}

function promptId(providerId, provider) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n请输入 ${provider.label} 的 ${provider.idHint}\n> `, (input) => {
      rl.close();
      const id = input.trim();
      if (!provider.idValidate(id)) {
        console.error(`错误: ${provider.idError}`);
        process.exit(1);
      }
      resolve(id);
    });
  });
}

// =========================================================================
// CDP 客户端 (零依赖: Node 内置 fetch + WebSocket)
// =========================================================================

function probeCdp(port = DEBUG_PORT) {
  return fetch(`${DEBUG_ROOT}/json/version`)
    .then((res) => (res.ok ? res.json() : null))
    .then((info) => info?.webSocketDebuggerUrl || null)
    .catch(() => null);
}

/** 当前所有页面 target 的 URL — 用于识别登录后的跳转地址 */
async function getPageUrls() {
  const tabs = await fetch(`${DEBUG_ROOT}/json`)
    .then((r) => r.json())
    .catch(() => []);
  return (tabs || []).filter((t) => t.type === "page").map((t) => t.url || "");
}

/** 在第一个页面 target 里执行 JS, 返回返回值 (用于侧边栏链接兜底) */
async function evaluateInPage(expression) {
  const tabs = await fetch(`${DEBUG_ROOT}/json`)
    .then((r) => r.json())
    .catch(() => []);
  const page = (tabs || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) return null;
  const r = await cdpCall(page.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  return r.result?.value ?? null;
}

/**
 * 向 CDP 发送一条命令。target 为 browser-level 的 webSocketDebuggerUrl。
 * 返回 result 对象; 失败抛错。
 */
function cdpCall(wsUrl, method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      reject(new Error(`CDP ${method} 超时`));
    }, timeoutMs);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result || {});
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`CDP 连接失败: ${wsUrl}`));
    });
  });
}

/** 抓取浏览器全部 cookie。browser target 失败时 fallback 到第一个页面 target。 */
async function getAllCookies() {
  const browserWs = await probeCdp();
  if (!browserWs) throw new Error("没有可用的调试端口");
  try {
    const r = await cdpCall(browserWs, "Network.getAllCookies");
    if (Array.isArray(r.cookies)) return r.cookies;
  } catch { /* fall through */ }

  // fallback: 用页面 target
  const tabs = await fetch(`${DEBUG_ROOT}/json`)
    .then((r) => r.json())
    .catch(() => []);
  const page = (tabs || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("找不到可用的页面 target");
  const r = await cdpCall(page.webSocketDebuggerUrl, "Network.getAllCookies");
  return Array.isArray(r.cookies) ? r.cookies : [];
}

// =========================================================================
// 浏览器启动
// =========================================================================

function findBrowserExe() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    path.join(os.homedir(), "AppData/Local/Google/Chrome/Application/chrome.exe"),
    path.join(os.homedir(), "AppData/Local/Microsoft/Edge/Application/msedge.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** 用临时 profile 拉起带调试端口的浏览器, 返回 { child, profileDir } 或 null。 */
async function launchBrowser(exe, url) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "creditgauge-cdp-"));
  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=msEdgeFirstRunExperience",
      url,
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();

  // 等待调试端口就绪 (最多 20s)
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await probeCdp()) return { child, profileDir };
    await sleep(300);
  }
  try { child.kill(); } catch { /* noop */ }
  return null;
}

// =========================================================================
// 格式转换: CDP cookie → Playwright cookie (与旧 auth.cjs 输出一致)
// =========================================================================

function toPlaywrightFormat(cookies) {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: typeof c.domain === "string" && c.domain.startsWith(".") ? c.domain.slice(1) : c.domain,
    path: typeof c.path === "string" && c.path ? c.path : "/",
    expires: c.session ? -1 : typeof c.expires === "number" ? Math.floor(c.expires) : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite:
      typeof c.sameSite === "string" && ["Lax", "Strict", "None"].includes(c.sameSite)
        ? c.sameSite
        : "Lax",
  }));
}

// =========================================================================
// 主流程
// =========================================================================

async function main(argv) {
  const providerId = argv[0];
  const provider = PROVIDERS[providerId];
  if (!provider) {
    console.error(`错误: 未知 provider "${providerId}"`);
    console.error(`支持: ${Object.keys(PROVIDERS).join(", ")}`);
    process.exit(1);
  }

  console.log("");
  console.log("==========================================");
  console.log(`  ${provider.label} 认证 (CreditGauge · 零依赖 CDP)`);
  console.log("==========================================");
  console.log("");

  // ---- 1. 账号 ID: CLI → config → 登录后自动识别 (不再强制要求) ----
  const cliId = parseCliId(argv, provider);
  const cfgId = readConfigId(providerId);
  let id = cliId || cfgId;
  if (id && !provider.idValidate(id)) {
    console.error(`错误: 提供的 ID 格式不正确 (${provider.idError})`);
    process.exit(1);
  }
  if (id) console.log(`  账号 ID:    ${id} (来自 ${cliId ? "命令行" : "config.json"})`);
  else console.log(`  账号 ID:    无需提供, 登录后自动识别`);

  // ---- dry-run ----
  if (argv.includes("--dry-run")) {
    console.log(`  登录页:      ${provider.loginUrl}`);
    console.log("");
    console.log("  [DRY-RUN] 模式 — 不执行实际操作。");
    process.exit(0);
  }

  // ---- 2. 连接或拉起浏览器, 打开登录页 (有 ID 则直接打开对应页面) ----
  let launched = null;
  let browserWs = await probeCdp();
  if (browserWs) {
    console.log("  → 检测到已开启调试端口的浏览器, 直接复用。");
  } else {
    const exe = findBrowserExe();
    if (!exe) {
      console.error("  ✗ 未找到 Chrome/Edge, 请自行用调试模式启动浏览器:");
      console.error(`     <浏览器路径> --remote-debugging-port=${DEBUG_PORT}`);
      process.exit(1);
    }
    console.log(`  → 正在启动 ${path.basename(exe)} (临时 profile, 不影响你的日常浏览器)...`);
    launched = await launchBrowser(exe, id ? provider.url(id) : provider.loginUrl);
    if (!launched) {
      console.error(`  ✗ 浏览器启动失败 (调试端口 ${DEBUG_PORT} 未就绪)`);
      console.error("    可能是有其他浏览器占用了该端口, 请换端口或关闭后重试。");
      process.exit(1);
    }
    browserWs = await probeCdp();
  }

  // ---- 3. 提示登录 + 轮询 (自动识别 ID / 自动确认会话 / 强制输入兜底) ----
  const AUTO_EXTRACT_MS = 90 * 1000; // 自动识别窗口, 超时后强制要求手动输入
  console.log("");
  console.log(`  登录页:      ${provider.loginUrl}`);
  console.log("");
  console.log("  ⚠ 请在浏览器中完成登录 (已登录则直接继续)");
  console.log("  ⚠ 脚本会自动识别账号 ID 并抓取 Cookie;");
  console.log(`     识别不到时 ${Math.round(AUTO_EXTRACT_MS / 1000)}s 后要求手动输入, 按回车可随时跳过等待。`);
  console.log("");

  let enterPressed = false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", () => { enterPressed = true; });

  const deadline = Date.now() + LOGIN_WAIT_MS;
  const extractStart = Date.now();
  let idForced = false; // 是否已强制要求手动输入 (只弹一次)
  let confirmed = false;

  while (Date.now() < deadline) {
    // 用户按回车: 未识别到 ID 时立即手动输入
    if (enterPressed) {
      enterPressed = false;
      if (!id) {
        rl.close();
        id = await promptId(providerId, provider);
      }
    }

    // 未提供 ID → 自动识别 (地址栏 → 页面链接; provider 可禁用其一)
    if (!id) {
      let extracted = null;
      // 地址栏提取 (opencode 用; commandcode 已禁用, 登录页不含 slug)
      if (provider.extractIdFromUrl) {
        const urls = await getPageUrls().catch(() => []);
        for (const href of urls) {
          extracted = provider.extractIdFromUrl(href);
          if (extracted) break;
        }
      }
      // 页面内链接提取 (commandcode 查找 usage 页面链接)
      if (!extracted && provider.extractIdFromPage) {
        try {
          extracted = await evaluateInPage(provider.extractIdFromPage());
        } catch { /* noop */ }
      }
      if (extracted && provider.idValidate(extracted)) {
        id = extracted;
        console.log(`  ✓ 从浏览器识别到账号 ID: ${id}`);
      } else if (!idForced && Date.now() - extractStart > AUTO_EXTRACT_MS) {
        // 自动识别超时 → 强制要求手动输入 (用户已登录但识别不到的情况)
        idForced = true;
        rl.close();
        console.log("");
        console.log(`  ⚠ ${Math.round(AUTO_EXTRACT_MS / 1000)}s 内未能自动识别账号 ID。`);
        console.log(`    请手动输入 ${provider.label} 的 ${provider.idHint}:`);
        id = await promptId(providerId, provider);
      }
    }

    // 有 ID → 抓 cookie 并尝试确认会话
    if (id) {
      try {
        const raw = await getAllCookies();
        const relevant = toPlaywrightFormat(raw).filter((c) =>
          provider.domains.some((d) => c.domain === d || c.domain.endsWith("." + d))
        );
        if (relevant.length > 0 && (await provider.autoConfirm(relevant))) {
          const credsDir = path.join(CREDITGAUGE_DIR, "credentials", providerId);
          fs.mkdirSync(credsDir, { recursive: true });
          const authPath = path.join(credsDir, "auth.json");
          const payload = {
            provider: providerId,
            id,
            savedAt: new Date().toISOString(),
            cookies: relevant,
          };
          fs.writeFileSync(authPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
          console.log("");
          console.log(`  ✓ 认证信息已保存 (${relevant.length} 个 cookie, 目标域 ${provider.domains.join("/")})`);
          console.log(`    路径: ${authPath}`);
          console.log(`    账号 ID: ${id} (插件端直接读取 auth.json, 无需配置 AUTHENTICATION_KEY)`);
          confirmed = true;
          break;
        }
      } catch { /* 端口暂不可用则继续等 */ }
    }

    await sleep(2000);
  }

  if (rl.listenerCount("line") > 0) rl.close();

  if (!confirmed) {
    console.error("");
    console.error("  ✗ 未能在浏览器中完成登录/确认会话 (10 分钟超时)。");
    console.error("    请确认: 已登录、浏览器未关闭、Cookie 未被浏览器拦截。");
    if (launched) await cdpCall(browserWs, "Browser.close").catch(() => {});
    process.exit(1);
  }

  // ---- 4. 清理 ----
  if (launched) {
    try { await cdpCall(browserWs, "Browser.close"); } catch { /* 用户可能已手动关掉 */ }
    try { fs.rmSync(launched.profileDir, { recursive: true, force: true }); } catch { /* noop */ }
  }

  console.log("");
  console.log("==========================================");
  console.log("  认证完成");
  console.log("==========================================");
  console.log(`  现在可以直接运行 npx creditgauge status 查看用量`);
  console.log("");
}

// 供 wrapper 复用 (query_plugins/<provider>/auth.cjs 可 require 本文件)
module.exports = { main, PROVIDERS };

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`  ✗ 错误: ${err.message}`);
    process.exit(1);
  });
}
