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
import { normalizeUrl } from "./utils.ts";

// ----- URL matching -----

// Three modes, all case-insensitive AND trailing-slash-insensitive: URLs are
// normalized (lowercased, trailing slash stripped) before comparing, so a user
// with a trailing-slash ANTHROPIC_BASE_URL matches an EXACT-registered
// base and vice versa.
//
// `STARTWITH` adds a suffix-attack guard: the char right after the prefix must
// be undefined (end), "/", "?", or "#" — rejecting `https://api.deepseek.com.evil.example`.
// The guard indexes the ORIGINAL baseUrl at pattern.length (not the stripped
// length) so a trailing-slash variant still lands the check on the trailing "/".
export function compareUrl(
  method: CompareMethod,
  baseUrl: string,
  pattern: string,
): boolean {
  const url = normalizeUrl(baseUrl);
  const pat = normalizeUrl(pattern);
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

// Fetch the provider's data through its dynamically imported plugin, returning
// the canonical shape (Quota for QUOTA, Balance for BALANCE). Throws on plugin
// or network error; the caller catches and falls back to stale cache. The
// `unknown` return is intentional — callers narrow by entry.TYPE, keeping this
// module ignorant of concrete shapes. Also returns the plugin-resolution side
// ("user" | "builtin" | "missing") so the host can persist it for m_pluginSource.
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

// The "fail" line's prefix label, picked from modeLabels by TYPE.
export function failLabelForProvider(provider: Provider): string {
  const entry = getProviderEntry(provider);
  const modeLabels = configStore.get().modeLabels;
  if (!entry) return modeLabels.used;
  if (entry.TYPE === "QUOTA") return modeLabels.used;
  return modeLabels.balance;
}

// Map a provider's TYPE to the renderer-facing discriminator:
// QUOTA → "quota", BALANCE → "balance", null entry → "unknown". The renderer
// uses it as the per-module `type` filter target and the m_modeLabel routing
// key. A distinct "unknown" (vs the old "plan" fallthrough) lets m_modeLabel
// choose a dedicated no-provider label, lets type filters opt into unknown
// independently of quota, and keeps quota-only modules (m_template|type|quota,
// m_windowQuota) dropping on unknown like they do on balance.
export function providerTypeFor(
  provider: Provider,
): "quota" | "balance" | "unknown" {
  const entry = getProviderEntry(provider);
  if (!entry) return "unknown";
  if (entry.TYPE === "QUOTA") return "quota";
  return "balance";
}
