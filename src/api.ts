// Dynamic provider-plugin loader and canonical provider data exports.
//
// Every provider is an in-process ESM plugin. Built-in plugins are emitted
// under dist/plugins/<id>/index.js; user plugins live under the stable
// ~/.claude/plugins/creditgauge/query_plugins/<id>/ directory.

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
// v0.9.x — copilot is no longer a built-in (moved to a user plugin
// shipped under query_plugins/copilot/). Only minimax + deepseek
// remain bundled. Unknown IDs still resolve to a missing-plugin
// hint via the user-side fallback path.
const BUILTIN_PLUGIN_IDS = new Set(["minimax", "deepseek"]);
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]+$/;

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

function builtInPluginPath(providerId: string, root: "dist" | "src"): string {
  assertSafeProviderId(providerId);
  // root=dist → dist/plugins/<id>/index.js (emitted by
  // scripts/copy-builtin-plugins.mjs); root=src →
  // src/plugins/<id>/index.js (used by node --import tsx unit
  // tests before a build, where the dist copy may be stale).
  const base = root === "dist"
    ? dirname(fileURLToPath(import.meta.url))
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
  return join(base, "plugins", providerId, "index.js");
}

// v0.9.0+ — which side of the override fence resolved.
// `user`     — query_plugins/<id>/index.{js,mjs} hit, OVERRIDES built-in.
// `builtin`  — fell through to dist|src/plugins/<id>/index.js.
// `missing`  — neither side produced a file (will 404 at import time).
export type PluginResolution = "user" | "builtin" | "missing";

export function resolveBuiltInPluginOnDisk(providerId: string): string {
  if (!BUILTIN_PLUGIN_IDS.has(providerId)) return builtInPluginPath(providerId, "dist");
  const emitted = builtInPluginPath(providerId, "dist");
  if (existsSync(emitted)) return emitted;
  const source = builtInPluginPath(providerId, "src");
  if (existsSync(source)) return source;
  return emitted;
}

// v0.9.0+ — full override-aware resolution. User plugins take
// precedence: `~/.claude/plugins/creditgauge/query_plugins/<id>/index.js`
// (or `.mjs`) always wins over the bundled built-in of the same id.
// Built-in remains the fallback when no user file exists. Built-in
// IDs are no longer a closed set — anyone can ship a `minimax` /
// `deepseek` / `copilot` plugin of their own at the user path and
// it will load instead of the bundled one. Override is silent
// (no stderr warn, no diagnostics append) — per the user's
// "静默覆盖" decision (2026-07-11).

// v0.9.0+ — reports which side of the user-vs-builtin fence
// resolved the provider (so the host can surface the side to the
// renderer without re-doing the file lookup). `kind` is `"user"`
// when query_plugins/<id>/ hit, `"builtin"` when the bundled
// dist|src/plugins/<id>/index.js fell through, and `"missing"`
// when neither produced a file (the import call will throw a 404
// before this point in practice; the value surfaces here only if
// the loader is changed to lazy-import).
export function resolvePluginOnDiskWithKind(
  providerId: string,
): { path: string; kind: PluginResolution } {
  assertSafeProviderId(providerId);
  const js = queryPluginPath(providerId);
  if (existsSync(js)) return { path: js, kind: "user" };
  const mjs = queryPluginPathMjs(providerId);
  if (existsSync(mjs)) return { path: mjs, kind: "user" };
  // Built-in only resolves for the canonical 2 IDs (minimax,
  // deepseek). For unknown ids there's no fallback — return the
  // user-side path so the import-time 404 surfaces the right hint
  // ("check query_plugins/").
  if (BUILTIN_PLUGIN_IDS.has(providerId)) {
    return { path: resolveBuiltInPluginOnDisk(providerId), kind: "builtin" };
  }
  return { path: js, kind: "missing" };
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

// v0.9.x — kind-returning sibling of the legacy `pluginTransport`
// (deleted in v0.9.x dead-export cleanup). Same load + dispatch
// pipeline, but also reports which side of the user-vs-builtin
// fence resolved the provider (so the host can surface the side
// to the renderer without re-doing the file lookup). `kind` is
// `"user"` when query_plugins/<id>/ hit, `"builtin"` when the
// bundled dist|src/plugins/<id>/index.js fell through, and
// `"missing"` when neither produced a file (the import call will
// throw a 404 before this point in practice; the value surfaces
// here only if the loader is changed to lazy-import).
export async function pluginTransportWithKind(
  providerId: string,
  token: string,
  context?: PluginContext,
): Promise<{ result: unknown; kind: PluginResolution }> {
  const { path: pluginPath, kind } = resolvePluginOnDiskWithKind(providerId);
  // v0.9.0+ — annotate the load error with the override side so
  // a user-plugin crash says "user plugin X" instead of just
  // "plugin X". The kind lives only in the error message; the
  // resolution itself is silent (no stderr, no diagnostics on
  // success — per "静默覆盖").
  const sideLabel = kind === "user" ? "user plugin" : kind === "builtin" ? "built-in plugin" : "plugin";
  let module: { default?: AccountCreditPlugin };
  try {
    module = (await import(pathToFileURL(pluginPath).href)) as typeof module;
  } catch (error) {
    const message = `${sideLabel} ${pluginPath}: ${(error as Error).message ?? String(error)}`;
    diagnostics.append("warning", "fetch", message, Date.now());
    throw new Error(message);
  }

  const plugin = module.default;
  if (!plugin || typeof plugin !== "object" ||
      typeof plugin.fetchAccountCredit !== "function") {
    const message = `${sideLabel} ${pluginPath}: default export must be { fetchAccountCredit(authenticationKey, context?) }`;
    diagnostics.append("warning", "fetch", message, Date.now());
    throw new Error(message);
  }

  try {
    const result = await withTimeout(
      Promise.resolve(plugin.fetchAccountCredit(token, context)),
      PLUGIN_TIMEOUT_MS,
      `${sideLabel} ${pluginPath} fetchAccountCredit`,
    );
    return { result, kind };
  } catch (error) {
    const message = `${sideLabel} ${pluginPath} fetchAccountCredit: ${(error as Error).message ?? String(error)}`;
    diagnostics.append("warning", "fetch", message, Date.now());
    throw new Error(message);
  }
}

// v0.9.x — kind-returning sibling of the legacy
// `fetchForProviderById` (deleted in v0.9.x dead-export cleanup).
// Same dispatch + ensure pipeline but reports the override side
// (`"user" | "builtin" | "missing"`) so the host can persist it
// alongside the data in cache.json (m_pluginSource renderer reads
// it back).
export async function fetchForProviderByIdWithKind(
  providerName: string | null,
  entry: ProviderEntry | null,
  token: string,
  signal: AbortSignal | undefined,
): Promise<{ data: Quota | Balance | null; pluginSource: PluginResolution }> {
  if (!entry || !providerName) return { data: null, pluginSource: "missing" };
  const context: PluginContext = {
    providerId: providerName,
    type: entry.TYPE,
    ...(signal ? { signal } : {}),
  };
  const { result: partial, kind } = await pluginTransportWithKind(
    providerName,
    resolveAuthenticationKey(entry, token),
    context,
  );
  // Host-side ensure. The plugin returned whatever shape its `fill`
  // decided to project; we run the canonical normaliser here so the
  // plugin author never has to know about ensureQuota /
  // ensureBalance / Quota / Balance types.
  let data: Quota | Balance | null;
  if (entry.TYPE === "QUOTA")      data = ensureQuota(partial);
  else if (entry.TYPE === "BALANCE") data = ensureBalance(partial);
  else {
    const exhaustive: never = entry.TYPE;
    throw new Error(`unsupported provider TYPE: ${exhaustive}`);
  }
  return { data, pluginSource: kind };
}


