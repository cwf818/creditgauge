// Entry point. Runs as the Claude Code statusline child process:
//   - Drains the session JSON from stdin (so the child never blocks on the
//     parent) and feeds it to parseTokenSnapshot for the m_token* modules.
//   - Gates on ANTHROPIC_BASE_URL via the providers config block: only when
//     it points at a configured provider does it fetch and render a line;
//     otherwise the line is hidden and upstream output passes through.
//   - Composes with upstream claude-hud output (passed via CREDITGAUGE_UPSTREAM
//     by scripts/wrapper.sh).
//   - Loads config.json once (falls back to DEFAULT_CONFIG if absent); every
//     tunable reads from there via the configStore singleton.
//
// Three-layer config precedence: defaults ⊕ config.json top-level ⊕
// providerEntry.config (highest). After matchProvider() resolves the active
// provider, applyProviderOverrides() merges its config so every cfg() call
// sees the per-provider view.
//
// Provider dispatch is data-driven: `fetchProviderData(provider, …)` resolves
// the matching plugin; TYPE only selects the canonical shape and renderer branch.

import * as cache from "./cache.ts";
import { type Quota, type Balance } from "./api.ts";
import type { Provider } from "./types.ts";
import { compose } from "./composition.ts";
import { type FetchResult, buildProviderLine } from "./dispatch.ts";
import { applyProviderOverrides, configStore, loadConfig } from "./config.ts";
import * as statusStore from "./status-store.ts";
import {
  fetchForProviderWithKind,
  getProviderEntry,
  matchProvider,
} from "./providers.ts";
import { resolvePluginOnDiskWithKind } from "./api.ts";
import { parseTokenSnapshot } from "./session-parse.ts";
import * as diagnostics from "./diagnostics.ts";
import { preFetchQuotes } from "./api.quote.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Read the upstream statusline output once at startup so the main flow and the
// crash handler can't drift apart on env-var reads.
const UPSTREAM = process.env.CREDITGAUGE_UPSTREAM;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

// Three outcomes the provider data layer can report:
//   fresh — we successfully obtained the data (from network or from a
//           within-TTL cache hit); `ageMs` is the time since the entry
//           was cached. The renderer's m_age module and forced-visibility
//           append both gate on `stale === true`, so fresh ticks render
//           no age suffix regardless of ageMs.
//   stale — fetch failed but a cached value exists; `ageMs` is how long
//           it's been since the last successful fetch (from cache.Entry.at).
//           `stale=true` triggers the broken-chain suffix (e.g. "⛓️‍💥 5m ago")
//           via either the m_age module or the forced-visibility append.
//   fail  — fetch failed AND no cached value; caller renders "not available!"
//
// FetchResult and buildProviderLine live in src/dispatch.ts so tests can
// import them without dragging in index.ts's stdin side effects.

// Per-tick child process: the in-memory cache resets every invocation.
// `cache.get` is the (defensive) hot path; `cache.peek` is the stale
// fallback in the fetch-failed branch. No persistent cross-tick cache by
// design — the age suffix is computed from the API response itself
// (`Window.resetStartAt` → "time since this window started").

// Cache key is the provider NAME (two Quota providers share a key — fine
// while their data shapes match). The data generic is `unknown`; the
// dispatcher narrows by entry.TYPE via the runtime `getWithAge<T>` overload.
//
// `token` comes from process.env.ANTHROPIC_AUTH_TOKEN (may be empty). Each
// fetcher prefers the entry's AUTHENTICATION_KEY over it ("always wins" — see
// ProviderEntry.AUTHENTICATION_KEY in src/types.ts); empty token AND empty
// AUTHENTICATION_KEY makes the fetcher return null → stale cache / fail line.
//
// Exported for unit tests to pin the `<provider>:pluginSource` cache-row
// invariant without the stdin→render pipeline. @internal — not public API.
export async function fetchProviderData(
  provider: Provider,
  token: string,
): Promise<FetchResult<unknown>> {
  const entry = getProviderEntry(provider);
  if (!entry) return { kind: "fail" };
  // We've verified the provider has a registered entry above, so the
  // `null` case in `Provider = string | null` is impossible. The
  // non-null assertion is localized to this function — callers can
  // still pass null safely because we early-return.
  const cacheKey = provider!;
  const ttlMs = configStore.get().cacheTtlMs;
  const timeoutMs = configStore.get().fetchTimeoutMs;

  // cache.getWithAge is generic; we dispatch on TYPE for the concrete
  // type (TS can't narrow `unknown` from entry.TYPE). The audit row
  // picks up cwd via the process-level session cwd store, so the
  // top-level cache.json row is attributed to the originating session.
  const readCache = <T>(): { value: T; ageMs: number } | null => {
    const hit = cache.getWithAge<T>(cacheKey, ttlMs);
    return hit ? { value: hit.value, ageMs: hit.ageMs } : null;
  };

  const peekCache = <T>(): { value: T; ageMs: number } | null => {
    const hit = cache.peekWithAge<T>(cacheKey);
    return hit ? { value: hit.value, ageMs: hit.ageMs } : null;
  };

  if (entry.TYPE === "QUOTA") {
    const cached = readCache<Quota>();
    if (cached)
      return { kind: "fresh", data: cached.value, ageMs: cached.ageMs };
  } else if (entry.TYPE === "BALANCE") {
    const cached = readCache<Balance>();
    if (cached)
      return { kind: "fresh", data: cached.value, ageMs: cached.ageMs };
  }

  try {
    // fetchForProviderWithKind also reports which side of the user-vs-builtin
    // fence resolved the provider. The kind is persisted under
    // `<provider>:pluginSource`, sharing the data row's TTL; the renderer
    // reads it via cache.peek WITHOUT a TTL gate so an override-file swap
    // reflects on the next tick even on a within-TTL data hit.
    const { data, pluginSource } = await fetchForProviderWithKind(
      provider,
      token,
      AbortSignal.timeout(timeoutMs),
    );
    // Always persist the pluginSource side, even when data is null, so
    // m_pluginSource renders ❗ for kind="missing" (no query_plugins/<id>/
    // file + not a built-in) regardless of whether the fetcher returned
    // usable data.
    cache.set(`${cacheKey}:pluginSource`, pluginSource, ttlMs);
    if (data) {
      cache.set(cacheKey, data, ttlMs);
      // ageMs=0 on a brand-new fetch — the renderer suppresses the
      // suffix on fresh ticks (stale=false gate).
      return { kind: "fresh", data, ageMs: 0 };
    }
    // Fetcher returned null (e.g. base_resp.status_code != 0). Treat
    // as a hard fail, but still try the stale cache.
    const stale =
      entry.TYPE === "QUOTA" ? peekCache<Quota>() : peekCache<Balance>();
    if (stale) return { kind: "stale", data: stale.value, ageMs: stale.ageMs };
    return { kind: "fail" };
  } catch {
    // Network / plugin error. Stale-on-error: keep showing the last good
    // value; the plugin loader records the underlying error.
    //
    // Also persist the pluginSource side: the import-time 404 path
    // (`query_plugins/<id>/index.js` missing for a non-builtin id) throws
    // BEFORE fetchForProviderWithKind returns, so computing the kind eagerly
    // via resolvePluginOnDiskWithKind here makes kind="missing" loud (❗)
    // on the next tick instead of silent.
    try {
      const { kind } = resolvePluginOnDiskWithKind(provider!);
      cache.set(`${cacheKey}:pluginSource`, kind, ttlMs);
    } catch {
      // resolvePluginOnDiskWithKind asserts a safe id; ignore failures
      // here so we don't shadow the original throw.
    }
    const stale =
      entry.TYPE === "QUOTA" ? peekCache<Quota>() : peekCache<Balance>();
    if (stale) return { kind: "stale", data: stale.value, ageMs: stale.ageMs };
    return { kind: "fail" };
  }
}

async function main(): Promise<void> {
  // Drain stdin ONCE at the top; the raw string feeds parseTokenSnapshot.
  const stdinRaw = await readStdin().catch(() => "");
  // Parse FIRST so the per-project cwd is available to the diagnostics
  // append; parsing is cheap and depends on nothing else in main().
  const tokens = parseTokenSnapshot(stdinRaw);
  // Populate the process-level session cwd store BEFORE any logFs* call so
  // cwd-unaware modules (cache.ts, config.ts, index.ts) get their audit rows
  // stamped with the originating session's cwd. Reset every tick (per-tick
  // child process) — _sessionCwd never leaks across sessions.
  diagnostics.setSessionCwd(tokens?.cwd ?? null);
  // Record the raw stdin frame for postmortem (gated by
  // CREDITGAUGE_DIAGNOSTICS_ENABLE). Always append — even empty — so a
  // reader can distinguish "plugin never reached this line" from "empty
  // stdin this tick". cwd routes the row to state/<projectHash>/diagnostics.jsonl
  // (avoids cross-project races).
  diagnostics.append("info", "stdin", stdinRaw, Date.now(), tokens?.cwd ?? null, undefined, "stdin");

  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const upstream = UPSTREAM;
  const provider = matchProvider(baseUrl);

  // Apply the active provider's `config` overlay BEFORE processAndSaveTick
  // so the cost computation sees the fully merged config (three-layer
  // precedence, providerEntry.config highest).
  const entry = provider !== null ? getProviderEntry(provider) : null;
  if (entry?.config) {
    applyProviderOverrides(entry.config);
  }

  // Centralized stdin-derived state pipeline. Runs AFTER provider resolution
  // and override application so normalizeTick can use the 5-layer token-price
  // cascade; always fires, regardless of whether any module produces output.
  statusStore.processAndSaveTick(tokens?.cwd ?? null, tokens, provider);

  // No provider match: still dispatch through buildProviderLine so
  // provider-AGNOSTIC modules (m_token*, m_session, m_version, m_model, …)
  // can emit. The dispatcher is entry-tolerant (renderDataLine in dispatch.ts):
  // a null provider skips both TYPE branches and the per-module `mode` filter
  // drops plan-/balance-only modules. The empty-output guard turns "ran but
  // produced nothing" back into a null line so upstream still falls through.
  if (provider === null) {
    const quoteBodies = await preFetchQuotes(tokens?.cwd ?? null, Date.now());
    const line = buildProviderLine(
      null,
      { kind: "fresh", data: null, ageMs: 0 },
      tokens,
      quoteBodies,
    );
    process.stdout.write(compose(upstream, line));
    return;
  }

  // Pre-read the env token once but DON'T short-circuit on empty: the
  // fetcher decides whether to call (it sees entry.AUTHENTICATION_KEY), so
  // an empty env token + configured AUTHENTICATION_KEY is a valid CI setup.
  const envToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const result = await fetchProviderData(provider, envToken ?? "");
  // Pre-fetch m_quote|address|… bodies (see src/api.quote.ts). Runs after
  // fetchProviderData so a stale provider value can't block a fresh quote,
  // and before buildProviderLine so the renderer reads the Map via ctx.
  const quoteBodies = await preFetchQuotes(tokens?.cwd ?? null, Date.now());
  const line = buildProviderLine(provider, result, tokens, quoteBodies);

  process.stdout.write(compose(upstream, line));
  // The tick commit() (above, after diagnostics.append) runs before the
  // null-provider branch so the status-store's writes flush regardless of
  // whether render ran.
}

// parseTokenSnapshot lives in ./session-parse.ts so unit tests can
// import it without dragging in index.ts's top-level main() side
// effects (which would hang in node:test).

// Handle unexpected throws by emitting upstream output (so claude-hud is
// never blanked by our crash). Token is never logged.
process.on("uncaughtException", (err) => {
  process.stderr.write(`creditgauge: ${(err as Error).message}\n`);
  process.stdout.write(UPSTREAM ?? "");
  process.exit(0);
});

// Load user config once before main() runs. ENOENT and parse errors
// fall back to DEFAULT_CONFIG (with a stderr line) — never blocks
// startup on a missing file.
await loadConfig();
// Wire the diagnostics subkey gate once per tick so isSubkeyEnabled() can
// AND-gate against the master env switch.
diagnostics.setDebugFlags(configStore.get().debug ?? {});
// Load the plugin version from .claude-plugin/plugin.json for m_version.
// Non-fatal if missing/parse-error (m_version renders ""). Tries
// "<runtime>/../.claude-plugin/plugin.json" (production cache layout) then
// "<runtime>/.claude-plugin/plugin.json" (dev checkout layout).
loadPluginVersion();
await main();

function loadPluginVersion(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", ".claude-plugin", "plugin.json"),
    join(here, ".claude-plugin", "plugin.json"),
  ];
  for (const p of candidates) {
    diagnostics.logFsRead(p, "index.loadPluginVersion", undefined, undefined, "pluginVersion");
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        configStore.setVersion(parsed.version);
        return;
      }
    } catch {
      // Malformed manifest: fall through to the next candidate.
      // The error is non-fatal — m_version degrades to rendering "".
    }
  }
  // No manifest found or all candidates malformed: leave version empty.
  // No stderr warn here either — dev runs from a checkout without a
  // built dist don't necessarily have plugin.json next to source.
}
