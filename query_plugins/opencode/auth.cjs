#!/usr/bin/env node
/**
 * opencode.ai 认证 — 零依赖 CDP 版 (替代 Playwright 版)。
 *
 * 原 Playwright 实现备份于同目录 auth-playwright.cjs; 通用逻辑在
 * ../auth-cdp.cjs (支持登录后自动识别工作区 ID, 无需提供 AUTHENTICATION_KEY)。
 *
 * 用法 (与旧版兼容):
 *   node auth.cjs                                  # 登录后自动识别 ID
 *   node auth.cjs --workspace-id wrk_01KX2XFZ44C30W9T5Y9ZE9VQY4
 */
require("../auth-cdp.cjs").main(["opencode", ...process.argv.slice(2)]);
