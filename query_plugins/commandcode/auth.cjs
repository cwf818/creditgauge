#!/usr/bin/env node
/**
 * commandcode.ai 认证 — 零依赖 CDP 版 (替代 Playwright 版)。
 *
 * 原 Playwright 实现备份于同目录 auth-playwright.cjs; 通用逻辑在
 * ../auth-cdp.cjs (支持登录后自动识别账号 ID, 无需提供 AUTHENTICATION_KEY)。
 *
 * 用法 (与旧版兼容):
 *   node auth.cjs                                  # 登录后自动识别 ID
 *   node auth.cjs --account-id cwf81881rl          # 直接指定账号 slug
 */
require("../auth-cdp.cjs").main(["commandcode", ...process.argv.slice(2)]);
