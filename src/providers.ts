// Provider registry — URL matching, plugin dispatch, and template /
// fail-label routing. Provider acquisition and parsing live in dynamically
// imported plugins; config.json only selects and configures them.
//
// All functions in this module read from `configStore.get().providers`
// at call time, so config changes via `__resetForTest` are picked up
// on the next call (no module-level state).

import { configStore } from "./config.ts";
import type {
  CompareMethod,
  Provider,
  ProviderEntry,
} from "./types.ts";
import { fetchForProviderByIdWithKind } from "./api.ts";

// ----- URL matching -----

// Three modes, all case-insensitive AND trailing-slash-insensitive
// (matches the v0.2.20 behavior of the hardcoded MiniMax / DeepSeek
// matchers, both of which called `.toLowerCase()` on the URL before
// comparing, plus the 2026-07-15 trailing-slash normalization so a
// user with `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic/`
// matches against the EXACT-registered
// `https://api.minimaxi.com/anthropic` and vice versa).
//
// `STARTWITH` has an extra suffix-attack guard: the character right
// after the prefix must be undefined (end of string), "/", "?", or
// "#". This rejects `https://api.deepseek.com.evil.example` even
// though it technically `startsWith("https://api.deepseek.com")` —
// the "." immediately after the prefix is not a valid boundary. The
// guard indexes into the ORIGINAL `baseUrl` at `pattern.length` (not
// the stripped length) so a trailing-slash variant like
// `https://api.minimaxi.com/anthropic/` against a pattern
// `https://api.minimaxi.com/anthropic` still has the boundary check
// land on the trailing `/` (a legal boundary char).
function stripTrailingSlashes(s: string): string {
  return s.replace(/\/+$/, "");
}

export function compareUrl(
  method: CompareMethod,
  baseUrl: string,
  pattern: string,
): boolean {
  const url = stripTrailingSlashes(baseUrl.toLowerCase());
  const pat = stripTrailingSlashes(pattern.toLowerCase());
  switch (method) {
    case "EXACT":
      return url === pat;
    case "INCLUDE":
      return url.includes(pat);
    case "STARTWITH": {
      if (!url.startsWith(pat)) return false;
      const tail = baseUrl[pattern.length];
      // undefined = exact match (no char after the prefix); /, ?, #
      // are the legal boundary characters.
      return tail === undefined || tail === "/" || tail === "?" || tail === "#";
    }
  }
}

// Find the first provider whose entry matches the given ANTHROPIC_BASE_URL.
// Returns the provider name (the map key) or null if no entry matches.
// Iteration order = insertion order of `configStore.get().providers`,
// so a user whose config puts `minimax` first will see that take
// precedence on a tie.
export function matchProvider(
  baseUrl: string | undefined | null,
): Provider {
  if (!baseUrl) return null;
  const providers = configStore.get().providers;
  for (const [name, entry] of Object.entries(providers)) {
    if (compareUrl(entry.COMPARE_METHOD, baseUrl, entry.BASE_URL_COMPARED_TO)) {
      return name;
    }
  }
  return null;
}

// Look up a provider's full entry by name. Returns null if the
// provider isn't registered (shouldn't happen for a name returned
// from matchProvider, but the call sites use null-checking for
// defensive narrowing).
export function getProviderEntry(provider: Provider): ProviderEntry | null {
  if (provider == null) return null;
  const providers = configStore.get().providers;
  return providers[provider] ?? null;
}

// ----- Type-driven dispatch -----

// Fetch the provider's data through its dynamically imported plugin.
// Returns the canonical data shape (Quota for Quota, Balance for
// BALANCE). Throws on plugin or network error; the caller catches and
// falls back to stale cache.
//
// The `unknown` return type is intentional: callers narrow at the
// call site based on `entry.TYPE`. This keeps providers.ts ignorant
// of the concrete data shapes.
// v0.9.0+ — kind-returning sibling of the legacy
// `fetchForProvider` (deleted in v0.9.x dead-export cleanup).
// Same dispatch path but also returns the resolution side
// (`"user" | "builtin" | "missing"`), so the host can persist the
// side into cache.json for the m_pluginSource renderer.
export async function fetchForProviderWithKind(
  provider: Provider,
  token: string,
  signal: AbortSignal,
): Promise<{ data: unknown; pluginSource: import("./api.ts").PluginResolution }> {
  const entry = getProviderEntry(provider);
  if (!entry) throw new Error(`unknown provider: ${String(provider)}`);
  const r = await fetchForProviderByIdWithKind(provider, entry, token, signal);
  // TYPE narrowing happens upstream (inside fetchForProviderByIdWithKind's
  // ensureQuota / ensureBalance). providers.ts stays TYPE-agnostic.
  return { data: r.data, pluginSource: r.pluginSource };
}

// The "fail" line's prefix label, picked from modeLabels based on
// TYPE. Replaces the hardcoded `"Usage: "` / `"Balance: "` literals
// previously in dispatch.ts:68-69 and render.ts:503.
export function failLabelForProvider(provider: Provider): string {
  const entry = getProviderEntry(provider);
  const modeLabels = configStore.get().modeLabels;
  if (!entry) return modeLabels.used;
  if (entry.TYPE === "QUOTA") return modeLabels.used;
  return modeLabels.balance;
}

// Map a provider's TYPE to the renderer-facing type discriminator.
// `Quota → "quota"`, `BALANCE → "balance"`, and null entry (no
// matching ANTHROPIC_BASE_URL) → `"unknown"`. The renderer uses
// this as the per-module `type` filter comparison target, and as
// the m_modeLabel routing key. Replaces the older
// `templateKeyForProvider` name — kept as a deprecated alias below
// for the build's lifetime.
//
// v0.4.x — return type widened to include `"unknown"`. Previously
// null entry fell through to `"plan"` so a user with no configured
// provider but a default quota template still rendered the quota
// line. With Phase 2 of the provider-agnostic refactor we want a
// distinct value here so:
//
//   1. `m_modeLabel` can choose a dedicated label for the "no
//      provider configured" case (vs "this provider is quota type").
//   2. Per-module `type` filters can opt-in to the unknown case
//      independently of quota. (None exist today; reserved for
//      future use.)
//   3. `m_template|<key>|type|quota` and the equivalent `m_windowQuota`
//      module still drop on unknown — that's the same as quota-only
//      modules dropping on balance.
export function providerTypeFor(
  provider: Provider,
): "quota" | "balance" | "unknown" {
  const entry = getProviderEntry(provider);
  if (!entry) return "unknown";
  if (entry.TYPE === "QUOTA") return "quota";
  return "balance";
}
