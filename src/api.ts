// Dynamic provider-plugin loader and canonical provider data exports.
//
// Every provider is an in-process ESM plugin living under a single
// `query_plugins/<id>/` layout. Resolution order:
//   1. ~/.claude/plugins/creditgauge/query_plugins/<id>/index.{js,mjs}
//      (user-installed / user-overridden plugin — install.sh seeds the
//      bundled minimax / deepseek here)
//   2. <package>/query_plugins/<id>/index.js (the bundled copy, e.g. a
//      dev checkout or a cache dir where install.sh hasn't run yet)
// There is no "built-in vs user" distinction anymore — the first file
// found wins, and the host treats all plugins identically.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as diagnostics from "./diagnostics.ts";
import type { ProviderEntry } from "./types.ts";
import type {
  AccountCreditPlugin,
  Balance,
  BalanceEntry,
  Interval,
  PluginContext,
  Quota,
} from "./plugins/data.ts";
import { ensureBalance, ensureQuota } from "./plugins/parsers.ts";

export type {
  AccountCreditPlugin,
  Balance,
  BalanceEntry,
  Interval,
  PluginContext,
  Quota,
};
export {
  ensureInterval,
  ensureQuota,
  ensureBalance,
} from "./plugins/parsers.ts";

const PLUGIN_TIMEOUT_MS = 5_000;
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]+$/;

// User plugin root: ~/.claude/plugins/creditgauge/query_plugins/
export function queryPluginsDir(): string {
  return join(homedir(), ".claude", "plugins", "creditgauge", "query_plugins");
}

function assertSafeProviderId(providerId: string): void {
  if (!PROVIDER_ID_RE.test(providerId)) {
    throw new Error(`invalid provider id "${providerId}"`);
  }
}

export function queryPluginPath(providerId: string): string {
  assertSafeProviderId(providerId);
  return join(queryPluginsDir(), providerId, "index.js");
}

function queryPluginPathMjs(providerId: string): string {
  assertSafeProviderId(providerId);
  return join(queryPluginsDir(), providerId, "index.mjs");
}

// Bundled plugin root: <package>/query_plugins/<id>/index.js. Resolved
// relative to the current module — from dist/index.js this is
// <pkgRoot>/query_plugins/, from src/api.ts (dev / tsx tests) it is
// also <pkgRoot>/query_plugins/.
function bundledPluginPath(providerId: string): string {
  assertSafeProviderId(providerId);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "query_plugins", providerId, "index.js");
}

// Resolve the plugin file for a provider id, or null when neither the
// user dir nor the bundled copy has one. User plugins at
// ~/.claude/plugins/creditgauge/query_plugins/<id>/ always win over the
// bundled copy — override is silent (no stderr warn, no diagnostics
// append) per the user's "静默覆盖" decision (2026-07-11).
export function resolvePluginOnDisk(providerId: string): string | null {
  assertSafeProviderId(providerId);
  const js = queryPluginPath(providerId);
  if (existsSync(js)) return js;
  const mjs = queryPluginPathMjs(providerId);
  if (existsSync(mjs)) return mjs;
  const bundled = bundledPluginPath(providerId);
  if (existsSync(bundled)) return bundled;
  // No file anywhere — return the user-side path so an import-time 404
  // surfaces the right hint ("check query_plugins/").
  return js;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveAuthenticationKey(entry: ProviderEntry, token: string): string {
  return entry.AUTHENTICATION_KEY ?? token ?? "";
}

// Load + dispatch a provider's plugin. Returns the plugin's raw output
// (the host runs ensureQuota / ensureBalance afterwards). Throws on
// plugin load / ABI / timeout errors with a path-qualified message.
export async function pluginTransport(
  providerId: string,
  token: string,
  context?: PluginContext,
): Promise<unknown> {
  const pluginPath = resolvePluginOnDisk(providerId);
  if (!pluginPath) {
    const message = `plugin ${providerId}: no file under query_plugins/${providerId}/ (user or bundled)`;
    diagnostics.append("warning", "fetch", message, Date.now());
    throw new Error(message);
  }
  let module: { default?: AccountCreditPlugin };
  try {
    module = (await import(pathToFileURL(pluginPath).href)) as typeof module;
  } catch (error) {
    const message = `plugin ${pluginPath}: ${(error as Error).message ?? String(error)}`;
    diagnostics.append("warning", "fetch", message, Date.now());
    throw new Error(message);
  }

  const plugin = module.default;
  if (!plugin || typeof plugin !== "object" ||
      typeof plugin.fetchAccountCredit !== "function") {
    const message = `plugin ${pluginPath}: default export must be { fetchAccountCredit(authenticationKey, context?) }`;
    diagnostics.append("warning", "fetch", message, Date.now());
    throw new Error(message);
  }

  try {
    return await withTimeout(
      Promise.resolve(plugin.fetchAccountCredit(token, context)),
      PLUGIN_TIMEOUT_MS,
      `plugin ${pluginPath} fetchAccountCredit`,
    );
  } catch (error) {
    const message = `plugin ${pluginPath} fetchAccountCredit: ${(error as Error).message ?? String(error)}`;
    diagnostics.append("warning", "fetch", message, Date.now());
    throw new Error(message);
  }
}

// Fetch the provider's data through its dynamically imported plugin and
// normalize it to the canonical shape (Quota for QUOTA, Balance for
// BALANCE). Returns null when the plugin reported "no data" (e.g.
// base_resp.status_code != 0). Throws on plugin or network error; the
// caller catches and falls back to stale cache.
export async function fetchForProviderById(
  providerName: string | null,
  entry: ProviderEntry | null,
  token: string,
  signal: AbortSignal | undefined,
): Promise<Quota | Balance | null> {
  if (!entry || !providerName) return null;
  const { config: _config, ...entryRest } = entry;
  const context: PluginContext = {
    providerId: providerName,
    type: entry.TYPE,
    ...(signal ? { signal } : {}),
    providerEntry: entryRest as Record<string, unknown>,
  };
  const partial = await pluginTransport(
    providerName,
    resolveAuthenticationKey(entry, token),
    context,
  );
  // Host-side ensure. The plugin returned whatever shape its `fill`
  // decided to project; we run the canonical normaliser here so the
  // plugin author never has to know about ensureQuota /
  // ensureBalance / Quota / Balance types.
  if (entry.TYPE === "QUOTA")      return ensureQuota(partial);
  else if (entry.TYPE === "BALANCE") return ensureBalance(partial);
  else {
    const exhaustive: never = entry.TYPE;
    throw new Error(`unsupported provider TYPE: ${exhaustive}`);
  }
}
