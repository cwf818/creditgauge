#!/usr/bin/env node

/**
 * opencode.ai 认证工具 — 用于 CreditGauge
 *
 * 功能:
 *   1. 检测 opencode 插件是否已安装 (config.json → providers.opencode)
 *   2. 获取 workspace ID (从 AUTHENTICATION_KEY 或交互式输入)
 *   3. 打开浏览器完成 GitHub OAuth 登录
 *   4. 保存 session-cookies 供 fetchAccountCredit 使用
 *
 * Cookie 保存位置:
 *   ~/.claude/plugins/creditgauge/credentials/opencode/<workspaceId>.session-cookies.json
 *
 * 用法:
 *   node auth.js                              # 交互式，按需输入 workspace ID
 *   node auth.js --workspace-id wrk_01KX2...  # 直接指定
 *   node auth.js --mode github-auto           # 自动 GitHub OAuth（需设密码）
 *
 * 依赖:
 *   Playwright + Chromium 浏览器 — 运行时会自动检测并提示安装。
 */

// =========================================================================
// 依赖 — 保持 CommonJS 以兼容 raw node 调用
// playwright 为动态加载，未安装时自动提示
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
// Chromium 可执行文件检测 (安装后提醒)
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

/** opencode.ai 工作区 URL 模板 */
const WORKSPACE_URL_TPL = "https://opencode.ai/workspace/%s/go";

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
const CREDENTIALS_DIR = path.join(CREDITGAUGE_DIR, "credentials", "opencode");

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

function ensureOpencodeInstalled(config) {
  const provider = config?.providers?.opencode;
  if (!provider) {
    console.error("错误: opencode 插件未安装");
    console.error("");
    console.error("请在 config.json 中添加以下配置后重试：");
    console.error(`  ${CONFIG_PATH}`);
    console.error("");
    console.error(JSON.stringify(
      {
        providers: {
          opencode: {
            TYPE: "QUOTA",
            BASE_URL_COMPARED_TO: "http://127.0.0.1:3456",
            COMPARE_METHOD: "EXACT",
            AUTHENTICATION_KEY: "wrk_xxxxxxxxxxxxxxxxxxxxxxxxxx",
          },
        },
      },
      null,
      2
    ));
    console.error("");
    console.error("或运行 npx creditgauge plugin add opencode");
    process.exit(1);
  }
  return provider;
}

// =========================================================================
// Workspace ID 获取
// =========================================================================

/**
 * 从命令行参数解析 --workspace-id <value>
 */
function parseCliWorkspaceId() {
  const idx = process.argv.indexOf("--workspace-id");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1].trim();
  }
  return null;
}

/**
 * 从配置获取 workspace ID。
 * 优先顺序: CLI 参数 → config.json AUTHENTICATION_KEY → 交互式输入
 */
async function resolveWorkspaceId(config) {
  // 1) CLI 参数
  const cliId = parseCliWorkspaceId();
  if (cliId) return cliId;

  // 2) 配置中已有的 AUTHENTICATION_KEY
  const existing = config.providers.opencode.AUTHENTICATION_KEY;
  if (existing && existing !== "wrk_xxxxxxxxxxxxxxxxxxxxxxxxxx") {
    return existing;
  }

  // 3) 交互式输入
  return await promptWorkspaceId(config);
}

/**
 * 交互式输入 workspace ID，并写入 config.json
 */
function promptWorkspaceId(config) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(
      "\n请输入 opencode.ai 工作区 ID\n(格式: wrk_xxxxxxxxxxxxxxxxxxxxxxxxxx)\n> ",
      (input) => {
        rl.close();
        const id = input.trim();

        if (!id.startsWith("wrk_")) {
          console.error("错误: 工作区 ID 应以 wrk_ 开头");
          process.exit(1);
        }
        if (id.length < 10) {
          console.error("错误: 工作区 ID 格式不正确");
          process.exit(1);
        }

        // 保存到 config.json
        config.providers.opencode.AUTHENTICATION_KEY = id;
        saveConfig(config);
        console.log("  ✓ 工作区 ID 已保存到配置文件");
        resolve(id);
      }
    );
  });
}

// =========================================================================
// Browser 管理
// =========================================================================

function cookieFilePath(workspaceId) {
  if (!fs.existsSync(CREDENTIALS_DIR)) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  }
  return path.join(CREDENTIALS_DIR, `${workspaceId}.session-cookies.json`);
}

async function createBrowser(pw, headless = false) {
  const browser = await pw.chromium.launch({
    headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-web-security",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);

  return { browser, context, page };
}

async function saveCookies(context, workspaceId) {
  const cookies = await context.cookies();
  const filePath = cookieFilePath(workspaceId);
  fs.writeFileSync(filePath, JSON.stringify(cookies, null, 2), "utf-8");
  console.log(`  ✓ Cookie 已保存 (${cookies.length} 个)`);
  console.log(`    路径: ${filePath}`);
  return filePath;
}

async function loadCookies(context, workspaceId) {
  const filePath = cookieFilePath(workspaceId);
  if (!fs.existsSync(filePath)) return false;
  const cookies = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  await context.addCookies(cookies);
  console.log(`  ✓ Cookie 已恢复 (${cookies.length} 个)`);
  return true;
}

// =========================================================================
// 登录状态检测
// =========================================================================

async function checkLoggedIn(page, workspaceUrl) {
  // 当前 URL 是否已进入 workspace
  const url = page.url();
  if (url.includes("/workspace/") && url.hostname === "opencode.ai") return true;

  // 检查页面是否包含登录关键词
  const hasLoginUi = await page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();
    return ["sign in", "signin", "log in", "login", "continue with github"].some(
      (kw) => text.includes(kw)
    );
  });
  return !hasLoginUi;
}

// =========================================================================
// 登录策略
// =========================================================================

/**
 * 交互式登录 — 打开有头浏览器，用户手动完成 GitHub OAuth
 */
async function loginInteractive(page, workspaceUrl) {
  console.log("  → 正在导航到工作区...");
  await page.goto(workspaceUrl, { waitUntil: "networkidle" });

  const loggedIn = await checkLoggedIn(page, workspaceUrl);
  if (loggedIn) {
    console.log("  ✓ 已登录");
    return true;
  }

  console.log("");
  console.log("  ⚠ 请在浏览器中手动完成 GitHub OAuth 登录");
  console.log("  ⚠ 登录成功后脚本将自动继续...");
  console.log("");

  await page.waitForURL(
    (url) => url.hostname === "opencode.ai" && url.pathname.includes("/workspace/"),
    { timeout: 180000 }
  );

  console.log("  ✓ 登录成功");
  return true;
}

/**
 * 自动 GitHub OAuth — 自动填写凭证（2FA 仍需手动处理）
 */
async function loginGitHubAuto(page, workspaceUrl, githubCreds) {
  const { username, password } = githubCreds;

  if (!username || !password) {
    console.error("  ✗ 请设置 GITHUB_USERNAME 和 GITHUB_PASSWORD 环境变量");
    return false;
  }

  console.log("  → 正在导航到工作区...");
  await page.goto(workspaceUrl, { waitUntil: "networkidle" });

  if (await checkLoggedIn(page, workspaceUrl)) {
    console.log("  ✓ 已登录");
    return true;
  }

  // 点击 "Continue with GitHub"
  console.log("  → 正在跳转至 GitHub OAuth...");
  const githubBtn = page.locator('a[href*="/github/authorize"]');
  await githubBtn.first().waitFor({ timeout: ACTION_TIMEOUT });
  await githubBtn.first().click();

  // 等待 GitHub 登录页
  await page.waitForURL((url) => url.hostname === "github.com", { timeout: ACTION_TIMEOUT });

  // 填写表单
  console.log("  → 正在填写 GitHub 凭证...");
  await page.fill('input[name="login"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('input[type="submit"]');

  // 等待回到 opencode.ai
  console.log("  → 等待 OAuth 授权完成...");
  try {
    await page.waitForURL(
      (url) => url.hostname === "opencode.ai" && url.pathname.includes("/workspace/"),
      { timeout: 120000 }
    );
    console.log("  ✓ 登录成功");
    return true;
  } catch (_err) {
    const currentUrl = page.url();

    // 2FA 处理
    if (currentUrl.includes("two-factor") || currentUrl.includes("2fa")) {
      console.log("  ⚠ 检测到 2FA 验证，请在浏览器中手动完成...");
      await page.waitForURL(
        (url) => url.hostname === "opencode.ai" && url.pathname.includes("/workspace/"),
        { timeout: 180000 }
      );
      console.log("  ✓ 登录成功");
      return true;
    }

    // Authorize 按钮
    if (currentUrl.includes("authorize")) {
      console.log("  → 正在点击 Authorize...");
      const btn = page.locator('button:has-text("Authorize"), button:has-text("authorize")');
      if (await btn.isVisible()) {
        await btn.click();
        await page.waitForURL(
          (url) => url.hostname === "opencode.ai" && url.pathname.includes("/workspace/"),
          { timeout: 60000 }
        );
        console.log("  ✓ 登录成功");
        return true;
      }
    }

    console.error("  ✗ 登录失败");
    return false;
  }
}

// =========================================================================
// CLI 参数解析
// =========================================================================

function parseMode() {
  const idx = process.argv.indexOf("--mode");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1].trim();
  }
  return "interactive";
}

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
  const mode = parseMode();
  const headless = parseHeadless();

  console.log("");
  console.log("==========================================");
  console.log("  opencode.ai 认证 (CreditGauge)");
  console.log(`  模式: ${mode}`);
  console.log("==========================================");
  console.log("");

  // ---- 1. 加载配置并检测插件 ----
  const config = loadConfig();
  ensureOpencodeInstalled(config);

  // ---- 2. 获取 workspace ID ----
  const workspaceId = await resolveWorkspaceId(config);
  const workspaceUrl = WORKSPACE_URL_TPL.replace("%s", workspaceId);

  console.log(`  工作区 ID: ${workspaceId}`);
  console.log(`  工作区 URL: ${workspaceUrl}`);
  console.log(`  用户目录: ${CREDITGAUGE_DIR}`);
  console.log(`  Cookie 保存: ${cookieFilePath(workspaceId)}`);

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
    if (mode !== "interactive") {
      const restored = await loadCookies(context, workspaceId);
      if (restored) {
        console.log("  → 正在验证 Cookie 会话...");
        await page.goto(workspaceUrl, { waitUntil: "networkidle" });
        loginSuccess = await checkLoggedIn(page, workspaceUrl);
        if (loginSuccess) {
          console.log("  ✓ Cookie 会话有效");
        } else {
          console.log("  ⚠ Cookie 已过期，需要重新登录");
        }
      }
    }

    // 执行登录
    if (!loginSuccess) {
      switch (mode) {
        case "github-auto":
          loginSuccess = await loginGitHubAuto(page, workspaceUrl, {
            username: process.env.GITHUB_USERNAME || "",
            password: process.env.GITHUB_PASSWORD || "",
          });
          break;
        case "cookie-restore":
          console.error("  ✗ Cookie 恢复失败，请先运行 interactive 模式完成登录");
          await browser.close();
          process.exit(1);
          break;
        case "interactive":
        default:
          loginSuccess = await loginInteractive(page, workspaceUrl);
          break;
      }
    }

    if (!loginSuccess) {
      console.error("  ✗ 登录失败");
      await browser.close();
      process.exit(1);
    }

    // ---- 5. 保存 Cookie ----
    console.log("");
    console.log("  → 正在保存 Cookie...");
    const savedPath = await saveCookies(context, workspaceId);

    console.log("");
    console.log("==========================================");
    console.log("  认证完成");
    console.log("==========================================");
    console.log(`  Cookie 文件: ${savedPath}`);
    console.log(`  工作区 ID:   ${workspaceId}`);
    console.log(`  该 Cookie 将在约 30 天后过期`);
    console.log("  过期后请重新运行此工具获取新 Cookie");
    console.log("");
  } catch (err) {
    console.error(`  ✗ 错误: ${err.message}`);

    // 保存错误截图
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
