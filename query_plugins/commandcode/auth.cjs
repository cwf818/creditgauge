#!/usr/bin/env node

/**
 * commandcode.ai 认证工具 — 用于 CreditGauge
 *
 * 功能:
 *   1. 检测 commandcode 插件是否已安装 (config.json → providers.commandcode)
 *   2. 获取账号 slug (从 AUTHENTICATION_KEY 或交互式输入)
 *   3. 打开浏览器完成登录 (与 opencode 插件相同的保存-cookie 方式)
 *   4. 保存 session-cookies 供 fetchAccountCredit 使用
 *
 * Cookie 保存位置:
 *   ~/.claude/plugins/creditgauge/credentials/commandcode/<slug>.session-cookies.json
 *
 * 用法:
 *   node auth.cjs                                # 交互式，按需输入账号 slug
 *   node auth.cjs --account-id cwf81881rl        # 直接指定
 *
 * 依赖:
 *   Playwright + Chromium 浏览器 — 运行时会自动检测并提示安装。
 */

// =========================================================================
// 依赖 — CommonJS 以兼容 raw node 调用
// =========================================================================

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execSync } = require("child_process");
const { homedir } = require("os");

// =========================================================================
// Playwright 动态加载 + 自动安装
// =========================================================================

function ensurePlaywright() {
  try {
    return require("playwright");
  } catch (_) {
    console.log("");
    console.log("需要安装 Playwright + Chromium 浏览器才能运行认证。");
    console.log("是否自动安装? (约 300MB 下载)");
    console.log("");

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve, reject) => {
      rl.question("确认安装? [Y/n] ", (input) => {
        rl.close();
        const trimmed = input.trim().toLowerCase();
        if (trimmed === "n" || trimmed === "no") {
          console.log("已取消。");
          console.log("你也可以手动安装:");
          console.log("  npm install playwright");
          console.log("  npx playwright install chromium");
          process.exit(0);
        }

        console.log("  → 正在安装 playwright...");
        execSync("npm install playwright --no-save", { stdio: "inherit" });
        console.log("  → 正在安装 Chromium 浏览器...");
        execSync("npx playwright install chromium", { stdio: "inherit" });
        console.log("  ✓ 安装完成\n");

        resolve(require("playwright"));
      });
    });
  }
}

// =========================================================================
// Chromium 可执行文件检测
// =========================================================================

function checkChromiumInstalled(pw) {
  try {
    const execPath = pw.chromium.executablePath();
    if (!execPath || !fs.existsSync(execPath)) {
      console.log("  ⚠ Chromium 浏览器未安装，正在安装...");
      execSync("npx playwright install chromium", { stdio: "inherit" });
      console.log("  ✓ Chromium 安装完成");
    }
  } catch (_) {
    console.log("  → 正在安装 Chromium 浏览器...");
    execSync("npx playwright install chromium", { stdio: "inherit" });
  }
}

// =========================================================================
// 常量
// =========================================================================

/** usage 页面 URL 模板 */
const USAGE_PAGE_TPL = "https://commandcode.ai/%s/settings/usage";

/** 用量查询端点 — 用于导入 cookie 后的验证请求 */
const BILLING_ENDPOINT = "https://api.commandcode.ai/internal/billing/credits";

/** 用户级 CreditGauge 目录 */
function creditgaugeDir() {
  const home = homedir();
  if (!home) {
    console.error("错误: 无法确定用户主目录");
    process.exit(1);
  }
  return path.join(home, ".claude", "plugins", "creditgauge");
}

const CREDITGAUGE_DIR = creditgaugeDir();
const CONFIG_PATH = path.join(CREDITGAUGE_DIR, "config.json");
const CREDENTIALS_DIR = path.join(CREDITGAUGE_DIR, "credentials", "commandcode");

/** Playwright 超时 (ms) */
const NAV_TIMEOUT = 60000;
const ACTION_TIMEOUT = 30000;

// =========================================================================
// 配置读写
// =========================================================================

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("错误: 未找到 CreditGauge 配置文件");
    console.error(`  ${CONFIG_PATH}`);
    console.error("请确认已安装 CreditGauge。");
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (e) {
    console.error("错误: 无法解析配置文件 (JSON 格式错误)");
    console.error(`  ${CONFIG_PATH}`);
    process.exit(1);
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// =========================================================================
// 插件检测
// =========================================================================

function ensureCommandCodeInstalled(config) {
  const provider = config?.providers?.commandcode;
  if (!provider) {
    console.error("错误: commandcode 插件未安装");
    console.error("");
    console.error("请在 config.json 中添加以下配置后重试：");
    console.error(`  ${CONFIG_PATH}`);
    console.error("");
    console.error(JSON.stringify(
      {
        providers: {
          commandcode: {
            TYPE: "QUOTA",
            BASE_URL_COMPARED_TO: "https://api.commandcode.ai",
            COMPARE_METHOD: "STARTWITH",
            AUTHENTICATION_KEY: "your-account-slug",
          },
        },
      },
      null,
      2
    ));
    console.error("");
    console.error("或运行 npx creditgauge plugin add commandcode");
    process.exit(1);
  }
  return provider;
}

// =========================================================================
// 账号 slug 获取
// =========================================================================

function parseCliAccountId() {
  const idx = process.argv.indexOf("--account-id");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1].trim();
  }
  return null;
}

async function resolveAccountId(config) {
  const cliId = parseCliAccountId();
  if (cliId) return cliId;

  const existing = config.providers.commandcode.AUTHENTICATION_KEY;
  if (existing && existing !== "your-account-slug" && existing !== "REPLACE_ME") {
    return existing;
  }

  return await promptAccountId(config);
}

function promptAccountId(config) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(
      "\n请输入 commandcode.ai 账号 slug\n(即 usage 页面 https://commandcode.ai/<slug>/settings/usage 中的 <slug>)\n> ",
      (input) => {
        rl.close();
        const slug = input.trim();
        if (!/^[A-Za-z0-9_-]+$/.test(slug) || slug.length < 3) {
          console.error("错误: 账号 slug 格式不正确 (应为字母/数字/下划线/短横线)");
          process.exit(1);
        }

        config.providers.commandcode.AUTHENTICATION_KEY = slug;
        saveConfig(config);
        console.log("  ✓ 账号 slug 已保存到配置文件");
        resolve(slug);
      }
    );
  });
}

// =========================================================================
// Browser 管理
// =========================================================================

function cookieFilePath(accountId) {
  if (!fs.existsSync(CREDENTIALS_DIR)) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  }
  return path.join(CREDENTIALS_DIR, `${accountId}.session-cookies.json`);
}

async function createBrowser(pw, headless = false) {
  const browser = await pw.chromium.launch({
    headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-web-security",
      // 反 Cloudflare 指纹: 禁掉 webdriver 标志。Cloudflare 的 "Verification
      // unavailable" 提示通常是因为 navigator.webdriver===true 触发了它的
      // 自动浏览器检测 —— 但这不是唯一因子。如果仍被拦截, 该 arg 不会让问题
      // 变好也不会变差; 真正稳的方式是走"浏览器里手动完成人机验证"路径
      // (见 loginInteractive 中新增的验证完成检测)。
      "--disable-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    // 与普通用户一样保留一条真实的持久化指纹: 关闭 webdriver 痕迹。
    // Cloudflare 的验证码看重的往往是这几点 + 真实浏览器行为。
  });

  // 抹掉 navigator.webdriver 痕迹 (Playwright 注入的 getter 会置 true)。
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);

  return { browser, context, page };
}

async function saveCookies(context, accountId) {
  const cookies = await context.cookies();
  const filePath = cookieFilePath(accountId);
  fs.writeFileSync(filePath, JSON.stringify(cookies, null, 2), "utf-8");
  console.log(`  ✓ Cookie 已保存 (${cookies.length} 个)`);
  console.log(`    路径: ${filePath}`);
  return filePath;
}

async function loadCookies(context, accountId) {
  const filePath = cookieFilePath(accountId);
  if (!fs.existsSync(filePath)) return false;
  const cookies = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  await context.addCookies(cookies);
  console.log(`  ✓ Cookie 已恢复 (${cookies.length} 个)`);
  return true;
}

// =========================================================================
// 登录状态检测
// =========================================================================

async function checkLoggedIn(page, usageUrl) {
  const url = page.url();
  if (url.hostname === "commandcode.ai" && url.pathname.includes("/settings/usage")) {
    return true;
  }

  const hasLoginUi = await page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();
    return ["sign in", "signin", "log in", "login", "continue with github", "email"].some(
      (kw) => text.includes(kw)
    );
  });
  return !hasLoginUi;
}

// 检测页面是否停在 Cloudflare 的 "Verification unavailable" 拦截页。
// 拦截页通常是 Turnstile 因为检测到自动化浏览器而拒绝渲染验证码。
async function isCloudflareBlocked(page) {
  try {
    const text = await page.evaluate(() => document.body.innerText.toLowerCase());
    return (
      text.includes("verification unavailable") ||
      text.includes("refresh the page") ||
      text.includes("disable your content blocker") ||
      text.includes("enable javascript and cookies")
    );
  } catch (_) {
    return false;
  }
}

// 用当前浏览器会话的 cookie 去请求用量端点, 判断会话是否真的有效。
// 返回 null 表示无法判断 (请求失败/响应异常), true/false 表示明确结论。
async function verifyCookiesWithBilling(context) {
  try {
    const cookies = await context.cookies();
    const relevant = cookies.filter(
      (c) => c.domain === "commandcode.ai" || c.domain.endsWith(".commandcode.ai")
    );
    if (relevant.length === 0) return false;
    const cookieHeader = relevant.map((c) => `${c.name}=${c.value}`).join("; ");
    const res = await fetch(BILLING_ENDPOINT, {
      headers: {
        Cookie: cookieHeader,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!res.ok) return false;
    const body = JSON.parse(await res.text());
    return !!(body && body.credits && body.windowLimits);
  } catch (_) {
    return null;
  }
}

// 检测页面是否停在 Cloudflare 的 "Verification unavailable" 拦截页。
// 拦截页通常是 Turnstile 因为检测到自动化浏览器而拒绝渲染验证码。
async function isCloudflareBlocked(page) {
  try {
    const text = await page.evaluate(() => document.body.innerText.toLowerCase());
    return (
      text.includes("verification unavailable") ||
      text.includes("refresh the page") ||
      text.includes("disable your content blocker") ||
      text.includes("enable javascript and cookies")
    );
  } catch (_) {
    return false;
  }
}

// 用当前浏览器会话的 cookie 去请求用量端点, 判断会话是否真的有效。
// 返回 null 表示无法判断 (请求失败/响应异常), true/false 表示明确结论。
async function verifyCookiesWithBilling(context) {
  try {
    const cookies = await context.cookies();
    const relevant = cookies.filter(
      (c) => c.domain === "commandcode.ai" || c.domain.endsWith(".commandcode.ai")
    );
    if (relevant.length === 0) return false;
    const cookieHeader = relevant.map((c) => `${c.name}=${c.value}`).join("; ");
    const res = await fetch(BILLING_ENDPOINT, {
      headers: {
        Cookie: cookieHeader,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!res.ok) return false;
    const body = JSON.parse(await res.text());
    return !!(body && body.credits && body.windowLimits);
  } catch (_) {
    return null;
  }
}

// =========================================================================
// 登录策略 — 与 opencode auth.cjs 相同的"保存 cookie"方式
// =========================================================================

async function loginInteractive(page, usageUrl) {
  console.log("  → 正在导航到 usage 页面...");
  await page.goto(usageUrl, { waitUntil: "networkidle" });

  // Cloudflare 拦截页检测: 提示用户刷新重试 / 手动完成人机验证。
  // 这不会自动绕过验证码, 但把"为什么登录不了"说清楚, 并把浏览器留给用户。
  if (await isCloudflareBlocked(page)) {
    console.log("");
    console.log("  ⚠ 检测到 Cloudflare 人机验证拦截页");
    console.log("     ('Verification unavailable. Please refresh the page or disable your content blocker')");
    console.log("");
    console.log("  常见原因与对策:");
    console.log("    1. 自动浏览器指纹被 Cloudflare 识别 (最常见)");
    console.log("       → 在弹窗中手动完成验证 (如果它允许的话), 或");
    console.log("       → 关闭浏览器后重试; 有时多试几次会通过");
    console.log("    2. 页面缓存 / Cookie 异常");
    console.log("       → 按页面提示按 F5 刷新 (脚本不会自动刷新, 避免死循环)");
    console.log("");
    console.log("  如果反复失败, 可以先在你自己平时用的浏览器里登录");
    console.log("  commandcode.ai, 再把浏览器开发者工具 → Network 里任意请求");
    console.log("  的 Cookie 头粘贴给脚本 (见下方说明)。");
    console.log("");
  }

  const loggedIn = await checkLoggedIn(page, usageUrl);
  if (loggedIn) {
    console.log("  ✓ 已登录");
    return true;
  }

  console.log("");
  console.log("  ⚠ 请在浏览器中手动完成登录");
  console.log("  ⚠ 登录成功后脚本将自动继续...");
  console.log("");

  // 等待两种情况之一结束:
  //   a) URL 回到 usage 页面 (登录完成);
  //   b) 浏览器出现 Cloudflare 验证码, 用户手动点过之后回到 usage 页面。
  // 通过轮询 (而非 waitForURL) 同时监听, 避免 waitForURL 在验证码
  // 中间状态 URL 时误判。
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const u = page.url();
    if (u.startsWith("https://commandcode.ai/") && u.includes("/settings/usage")) {
      console.log("  ✓ 登录成功");
      return true;
    }
    // 停在 Cloudflare 拦截页时, 只是提示, 继续等待用户手动处理。
    if (await isCloudflareBlocked(page)) {
      console.log("  ⚠ 检测到 Cloudflare 验证码, 请在弹出的浏览器中手动完成...");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.error("  ✗ 登录超时 (180s)。请在浏览器中完成登录后重新运行。");
  return false;
}

// =========================================================================
// CLI 参数解析
// =========================================================================

function parseHeadless() {
  return process.argv.includes("--headless");
}

function parseDryRun() {
  return process.argv.includes("--dry-run");
}

// =========================================================================
// 主流程
// =========================================================================

async function main() {
  const headless = parseHeadless();

  console.log("");
  console.log("==========================================");
  console.log("  commandcode.ai 认证 (CreditGauge)");
  console.log("==========================================");
  console.log("");

  // ---- 1. 加载配置并检测插件 ----
  const config = loadConfig();
  ensureCommandCodeInstalled(config);

  // ---- 2. 获取账号 slug ----
  const accountId = await resolveAccountId(config);
  const usageUrl = USAGE_PAGE_TPL.replace("%s", accountId);

  console.log(`  账号 slug: ${accountId}`);
  console.log(`  Usage 页面: ${usageUrl}`);
  console.log(`  用户目录: ${CREDITGAUGE_DIR}`);
  console.log(`  Cookie 保存: ${cookieFilePath(accountId)}`);

  // ---- dry-run ----
  if (parseDryRun()) {
    console.log("");
    console.log("  [DRY-RUN] 模式 — 不执行实际操作。");
    console.log("  去掉 --dry-run 执行真实认证。");
    console.log("");
    process.exit(0);
  }

  console.log("");

  // ---- 3. 确保 Playwright + Chromium 可用 ----
  const pw = await ensurePlaywright();
  checkChromiumInstalled(pw);

  // ---- 4. 启动浏览器 ----
  console.log("  → 正在启动浏览器...");
  const { browser, context, page } = await createBrowser(pw, headless);

  let loginSuccess = false;

  try {
    // 先尝试恢复已保存的 Cookie
    const restored = await loadCookies(context, accountId);
    if (restored) {
      console.log("  → 正在验证 Cookie 会话...");

      // 优先用用量端点验证 (不依赖页面, 不受 Cloudflare 拦截影响)。
      const billingOk = await verifyCookiesWithBilling(context);
      if (billingOk === true) {
        loginSuccess = true;
        console.log("  ✓ Cookie 会话有效 (用量端点确认)");
      } else {
        await page.goto(usageUrl, { waitUntil: "networkidle" });
        if (await isCloudflareBlocked(page)) {
          console.log("  ⚠ 页面被 Cloudflare 人机验证拦截 (不影响已保存的 Cookie 有效性判断)");
        }
        loginSuccess = await checkLoggedIn(page, usageUrl);
        if (loginSuccess) {
          console.log("  ✓ Cookie 会话有效 (页面确认)");
        } else {
          console.log("  ⚠ Cookie 已过期或需要人机验证，重新走登录流程");
        }
      }
    }

    if (!loginSuccess) {
      loginSuccess = await loginInteractive(page, usageUrl);
    }

    if (!loginSuccess) {
      console.error("  ✗ 登录失败");
      await browser.close();
      process.exit(1);
    }

    // ---- 5. 保存 Cookie ----
    console.log("");
    console.log("  → 正在保存 Cookie...");
    const savedPath = await saveCookies(context, accountId);

    console.log("");
    console.log("==========================================");
    console.log("  认证完成");
    console.log("==========================================");
    console.log(`  Cookie 文件: ${savedPath}`);
    console.log(`  账号 slug:   ${accountId}`);
    console.log(`  过期后请重新运行此工具获取新 Cookie`);
    console.log("");
  } catch (err) {
    console.error(`  ✗ 错误: ${err.message}`);

    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const errShot = path.join(CREDENTIALS_DIR, `error-${ts}.png`);
      await page.screenshot({ path: errShot });
      console.log(`  → 错误截图已保存: ${errShot}`);
    } catch (_) {
      // 忽略截图失败
    }

    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
