// Entry point. Runs as the Claude Code statusline child process:
//   - Reads the session JSON from stdin (we don't use it; we drain it so the
//     child doesn't block on the parent).
//   - Gates on ANTHROPIC_BASE_URL via the providers config block
//     (src/providers.ts): only when pointing at a configured provider
//     does it fetch and render a line. Otherwise the line is hidden and
//     upstream output passes through.
//   - Composes with upstream claude-hud output (passed via CREDITGAUGE_UPSTREAM
//     by the bash wrapper in scripts/wrapper.sh).
//   - Loads ~/.claude/plugins/creditgauge/config.json once at
//     startup; every tunable (cache TTL, fetch timeout, colors, display
//     mode, …) reads from there via the configStore singleton.
//
// v0.4.0+: three-layer config precedence
//   defaults  ⊕  config.json top-level  ⊕  providerEntry.config
// with providerEntry.config having the highest priority. After
// matchProvider() resolves the active provider, main() invokes
// applyProviderOverrides(providerEntry.config) so every downstream
// cfg() call sees the merged view. Useful for per-provider tuning
// (e.g. "minimax needs fetchTimeoutMs=3000 because the API is slow;
// deepseek uses the default 5000") without restating the global
// config for each provider.
//
// Provider dispatch is data-driven via the providers config block. A
// single `fetchProviderData(provider, …)` resolves the matching plugin;
// TYPE only selects the canonical result shape and renderer branch.

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

// The plugin is a per-tick child process — every invocation is a fresh
// process, so the in-memory cache is reset on every tick. Within a
// single tick we still go through `cache.get` for the (defensive) hot
// path, but its only real consumer is the `cache.peek` fallback in the
// fetch-failed branch. There is no persistent cross-tick cache by
// design: the age suffix is computed from the API response itself
// (`Window.resetStartAt` → "time since this window started"), so the
// user sees a meaningful value on every successful tick without any
// disk state.

// v0.2.21: the cache key is now the provider NAME (was a constant
// string per TYPE in v0.2.20). Two Quota providers would share
// a key today — that's fine since they have identical data shapes,
// but if a future provider of the same TYPE returns a different
// shape, this becomes a real distinction to make.
//
// The data generic is `unknown` because the dispatcher narrows
// based on entry.TYPE. We do a runtime check below to pick the right
// `getWithAge<T>` overload.
// `token` is the env-sourced value read once by main() from
// process.env.ANTHROPIC_AUTH_TOKEN (may be empty). Each fetcher
// prefers the entry's AUTHENTICATION_KEY over this; an empty `token` plus an
// empty AUTHENTICATION_KEY causes the fetcher to return null and the
// dispatcher to fall back to the stale cache / fail line. The
// previous v0.5.x behavior of short-circuiting the whole tick on
// empty env token was dropped in v0.6.0 to support per-provider
// credential overrides (see the ProviderEntry.AUTHENTICATION_KEY docstring
// in src/types.ts for the "always wins" rule).
// v0.9.x — exported for unit tests so the cache-row invariant
// (`<provider>:pluginSource` written independently of `data`
// being null) can be pinned without spinning up the full
// stdin → render pipeline. Not part of the public API surface;
// treat as @internal.
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

  // cache.getWithAge is generic on the data shape. We dispatch on
  // TYPE for the concrete type; unknown is the cross-type union.
  // (noinspection is needed because TS can't narrow `unknown` to
  // Quota/Balance purely from entry.TYPE.) The audit row in
  // diagnostics.jsonl picks up cwd via the process-level session
  // cwd store (set by `setSessionCwd` once `parseTokenSnapshot`
  // has parsed stdin above), so the top-level cache.json row
  // is automatically attributed to the originating session.
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
    // v0.9.0+ — fetchForProviderWithKind also reports which side of
    // the user-vs-builtin fence resolved the provider. The kind is
    // persisted into cache.json under a sibling key
    // (`<provider>:pluginSource`) so the m_pluginSource renderer can
    // read it back across ticks even on cached data hits. The data
    // cache row and the pluginSource cache row share a TTL — a stale
    // data row also renders a stale kind (which is correct: the user
    // could have swapped their override file since the last fetch,
    // so the renderer reads the kind via cache.peek WITHOUT a TTL
    // gate — see src/render.ts m_pluginSource).
    const { data, pluginSource } = await fetchForProviderWithKind(
      provider,
      token,
      AbortSignal.timeout(timeoutMs),
    );
    // vX.X.X+ — always persist the pluginSource side, even when
    // data is null. The previous `if (data)` gate suppressed the
    // kind row on the missing-plugin path, so m_pluginSource
    // dropped to no-op instead of rendering ❗ for a misconfigured
    // provider id. Now the kind lives independently of the data
    // row: a user whose provider resolves to kind="missing"
    // (no query_plugins/<id>/ file + not a built-in) sees ❗
    // regardless of whether the fetcher returned usable data.
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
    // value. The dynamic plugin loader records the underlying error; this
    // layer translates the throw to a FetchResult.
    //
    // vX.X.X+ — also persist the pluginSource side. The import-time
    // 404 path (`query_plugins/<id>/index.js` does not exist for a
    // non-builtin id like `kimi`) throws BEFORE
    // fetchForProviderWithKind returns, so the `pluginSource: "missing"`
    // row would otherwise never be written. Computing the kind eagerly
    // via resolvePluginOnDiskWithKind + writing it here makes the
    // missing-plugin failure mode loud: the next tick renders ❗
    // instead of dropping silently.
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
  // Drain stdin ONCE at the top. The raw string is fed to
  // parseTokenSnapshot, which produces a TokenSnapshot for the
  // m_token* renderer modules. A previous dev-only runProbe() helper
  // used to also consume the raw for schema discovery; it was removed
  // in v0.4.0 once the schema was confirmed.
  const stdinRaw = await readStdin().catch(() => "");
  // v0.4.x+: parse FIRST so the per-project cwd is available to the
  // diagnostics append (Per-Project Layout — see src/diagnostics.ts).
  // TokenSnapshot parsing is cheap (regex + small object walk) and
  // does not depend on anything in this function.
  const tokens = parseTokenSnapshot(stdinRaw);
  // Populate the process-level session cwd store BEFORE any subsequent
  // logFs* call. This is the architectural decision behind the v0.8.7+
  // fs-audit rework: cwd-unaware modules (cache.ts reading the shared
  // top-level cache.json, config.ts loading the shared top-level
  // config.json, index.ts probing the plugin manifest) can call
  // logFs*(path, fn) with no cwd parameter and still have their audit
  // rows stamped with the originating session's cwd. The store is
  // reset on every tick — the plugin is a per-tick child process so
  // _sessionCwd never leaks across sessions.
  diagnostics.setSessionCwd(tokens?.cwd ?? null);
  // Centralized stdin-derived state pipeline. status-store owns the
  // per-project state transaction, validation gate, one-shot state.json
  // flush, and the optional sample JSONL append. It runs before render
  // regardless of whether any module ends up producing output.
  statusStore.processAndSaveTick(tokens?.cwd ?? null, tokens);
  // Record the raw stdin frame for postmortem. Gated by the same
  // CREDITGAUGE_DIAGNOSTICS_ENABLE switch as the rest of diagnostics.jsonl
  // (no-op when off). Source "stdin" so it doesn't collide with the
  // existing "config" warning source. Always append — even when empty —
  // so a postmortem reader can distinguish "plugin never reached this
  // line" from "Claude Code sent an empty stdin this tick".
  //
  // cwd is passed so the line lands in
  // `state/<projectHash>/diagnostics.jsonl` rather than the legacy
  // top-level file — keeping concurrent Claude Code instances on
  // different projects from racing on the same write stream.
  diagnostics.append("info", "stdin", stdinRaw, Date.now(), tokens?.cwd ?? null);

  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const upstream = UPSTREAM;
  const provider = matchProvider(baseUrl);

  // v0.4.x — when no provider entry matches ANTHROPIC_BASE_URL,
  // dispatch through buildProviderLine anyway so provider-AGNOSTIC
  // modules (m_token*, m_session, m_version, m_model, …) can still
  // emit. Previously the plugin was a pure Quota / BALANCE
  // frontend, so a missing provider entry meant there was nothing
  // meaningful to display; returning null early was a clean signal
  // for the upstream wrapper to fall through. Now the dispatcher is
  // entry-tolerant (see renderDataLine in dispatch.ts): a null
  // provider skips both TYPE branches, calls renderProviderLine
  // with empty ctx data slots, and the per-module `mode` filter
  // drops plan-only / balance-only modules naturally. The empty-
  // output guard translates "renderer ran but produced nothing"
  // back to a null line so the upstream wrapper still falls through
  // when no agnostic modules fired either.
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

  // v0.4.0+ — apply the active provider's `config` overlay on top of
  // the just-loaded config snapshot. Three-layer precedence becomes
  //   defaults  ⊕  config.json top-level  ⊕  providerEntry.config
  // with providerEntry.config having the highest priority. Runs once
  // per tick (the plugin is a per-tick child process) so the active
  // Config seen by every cfg() call downstream is already the merged
  // view. If the matched provider has no `config` block, this is a
  // no-op (applyProviderOverrides early-returns on undefined input).
  const entry = getProviderEntry(provider);
  if (entry?.config) {
    applyProviderOverrides(entry.config);
  }

  // v0.6.0+ — pre-read the env token once but DON'T short-circuit
  // on empty. The fetcher decides whether to make the call (it sees
  // entry.AUTHENTICATION_KEY). An empty env token with a non-empty
  // entry.AUTHENTICATION_KEY is a valid config-driven setup (e.g. CI without
  // env vars); the previous v0.5.x behavior of writing nothing on
  // empty env would silently break that flow.
  const envToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const result = await fetchProviderData(provider, envToken ?? "");
  // v0.8.21+ — pre-fetch m_quote|address|… bodies (Node fetch,
  // per-(freqMs,address) disk cache keyed by binIndex). See
  // src/api.quote.ts. Runs after fetchProviderData so the user
  // never sees a statusline where a stale provider value blocks
  // a fresh quote, and before buildProviderLine so the renderer
  // can read the populated Map via ctx.quoteBodies.
  const quoteBodies = await preFetchQuotes(tokens?.cwd ?? null, Date.now());
  const line = buildProviderLine(provider, result, tokens, quoteBodies);

  process.stdout.write(compose(upstream, line));
  // v1.0 — tickStateCommit() moved up (before the null-provider
  // branch) so the data-processor's writes flush regardless of
  // whether render ran. See the call above, between
  // diagnostics.append and the provider dispatch.
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
// v0.2.17: load the plugin version from .claude-plugin/plugin.json
// and inject it into the configStore so the m_version display module
// can render it. Failure to find/parse the manifest is non-fatal —
// m_version simply renders nothing when version is empty. We try
// both "<runtime>/../.claude-plugin/plugin.json" (production layout
// where the bundle lives at <plugin-cache>/dist/index.js) and
// "<runtime>/.claude-plugin/plugin.json" (dev layout where the
// runtime file lives next to the manifest in the repo root).
loadPluginVersion();
await main();

function loadPluginVersion(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", ".claude-plugin", "plugin.json"),
    join(here, ".claude-plugin", "plugin.json"),
  ];
  for (const p of candidates) {
    diagnostics.logFsRead(p, "index.loadPluginVersion");
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
