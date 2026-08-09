// Provider dispatch: maps a (provider, fetch-result) pair to a statusline
// line. Extracted from index.ts so tests can exercise it without process.stdin
// / process.env (or index.ts's top-level `await main()`).
//
// Three outcomes the provider data layer can report:
//   fresh — data obtained (network or within-TTL cache hit); `ageMs` is the
//           entry's age. Renderer gates the age suffix on stale===true, so
//           fresh ticks show none regardless of ageMs.
//   stale — fetch failed but a cached value exists; `ageMs` is time since the
//           last successful fetch. stale=true triggers the broken-chain
//           suffix ("⛓️‍💥 5m ago") via m_age or the forced-visibility append.
//   fail  — fetch failed AND no cached value; caller renders "not available!"
//
// Dispatch is TYPE-based (reads the provider's TYPE field from the providers
// config block). Adding a new provider requires a matching plugin + config.

import type { Quota, Balance, PluginResolution } from "./api.ts";
import {
  RED,
  renderProviderLine,
  RESET,
  resolveDisplayMode,
} from "./render.ts";
import { configStore } from "./config.ts";
import {
  failLabelForProvider,
  getProviderEntry,
} from "./providers.ts";
import * as cache from "./cache.ts";
import type { Provider, TokenSnapshot } from "./types.ts";

// Tiny local alias — used twice in the empty-output guard below.
const cfg = (): ReturnType<typeof configStore.get> => configStore.get();

// Read the per-provider pluginSource row via cache.peek (TTL-ignoring), so an
// override-file change reflects on the NEXT tick even within the data row's
// TTL. Returns null when no provider matched / no row exists. `"missing"`
// (matched id with no user override and no built-in) is passed through so
// m_pluginSource renders ❗ — a misconfigured provider is loud, not silent.
function peekPluginSource(
  provider: Provider | null,
): "user" | "builtin" | "missing" | null {
  if (!provider) return null;
  const cached = cache.peek<PluginResolution>(`${provider}:pluginSource`);
  if (cached === "user" || cached === "builtin" || cached === "missing") return cached;
  return null;
}

// Detect a "label-only" degenerate output (renderer ran but every module
// dropped, leaving just m_modeLabel + s_* separators). Strips ANSI escapes,
// configured labels, and the named-alias literals (" " for s_space, "·" for
// s_dot, …), since preset templates compose those directly; anything left must
// be real module output. Whitespace-only = label + separators = empty.
// Used by buildProviderLine's two empty-output guards.
//
// The literals must stay in sync with NAMED_SEPARATORS in render.ts; hardcoded
// here (not imported) to avoid a circular import.
const NAMED_SEPARATOR_LITERALS = [" ", "·", "\n", "\t", ":", "|"];

function isEffectivelyEmpty(line: string): boolean {
  // Strip ANSI SGR sequences (e.g. \x1b[38;5;29m, \x1b[0m).
  const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
  // Strip the configured labels ("Usage:" / "Remain:" / "Balance:" /
  // override) against `cfg()` so a config change doesn't break the check.
  const labels = [
    cfg().modeLabels.used,
    cfg().modeLabels.balance,
    cfg().modeLabels.remaining,
  ];
  let working = stripped;
  for (const label of labels) {
    // Replace each occurrence with a space (paranoid: avoids double-stripping
    // "Usage: Usage:").
    working = working.split(label).join(" ");
  }
  // Strip named-alias separator literals. A label + separator template
  // (e.g. "Usage: · · ") should still count as non-empty.
  for (const sep of NAMED_SEPARATOR_LITERALS) {
    if (sep === "") continue;
    working = working.split(sep).join("");
  }
  // Non-whitespace left = real module output; whitespace-only = empty.
  return working.trim() === "";
}

export type FetchResult<T> =
  | { kind: "fresh"; data: T; ageMs: number }
  | { kind: "stale"; data: T; ageMs: number }
  | { kind: "fail" };

// Single adapter converting a (provider, data) pair into the ctx fields for
// renderProviderLine. The provider's TYPE controls which ctx fields populate
// (intervals vs balance); the renderer's per-module `type` filter silently
// drops plan-only modules on a balance ctx — no caller-side TYPE switch.
//
// Returns null only when (1) the provider has no entry (defensive — the
// upstream gate is matchProvider) or (2) data is shape-incompatible with the
// resolved TYPE.
//
// ageMs / stale semantics:
//   fresh.ageMs: 0 for a just-fetched tick; cache age for a within-TTL hit.
//                Renderer suppresses the suffix on fresh ticks.
//   stale.ageMs: time since the last successful fetch; renders "⛓️‍💥 Xm ago".
function renderDataLine(
  provider: Provider,
  data: unknown,
  ageMs: number,
  stale: boolean,
  tokens: TokenSnapshot | null,
  quoteBodies?: Map<string, string>,
  // "user" | "builtin" | "missing" — the ctx field accepts all three;
  // "missing" renders ❗ via labels.labelPluginMissing.
  pluginSource?: "user" | "builtin" | "missing" | null,
): string | null {
  const entry = getProviderEntry(provider);
  const mode = resolveDisplayMode();
  // Entry-tolerant: with no entry there's no TYPE to dispatch on, so call
  // renderProviderLine with empty data slots. providerTypeFor returns
  // "unknown" → plan-/balance-only modules drop on null data while
  // provider-agnostic modules (m_token*, m_version, …) emit normally.
  //
  // Returning "" (vs null) means "renderer ran but produced no output";
  // buildProviderLine translates that back into null so upstream skips the
  // empty line. Null directly here would lose the distinction.
  if (!entry) {
    return renderProviderLine(provider, {
      mode,
      nowMs: Date.now(),
      ageMs,
      stale,
      version: configStore.get().version,
      tokens,
      quoteBodies,
      pluginSource: pluginSource ?? null,
    });
  }
  if (entry.TYPE === "QUOTA") {
    const r = data as Quota;
    // `intervals` is an open Record<string, Interval|null>: plugins may
    // declare any key (e.g. "monthly") and reference it via
    // `m_windowQuota|term|<key>`. The reserved short/mid/long keys are always
    // seeded (ensureQuota) so the renderer reads ctx.intervals[term] uniformly.
    // Null return only when every reserved entry is null — non-reserved keys
    // alone are opt-in and don't gate the render.
    if (
      r.intervals.short == null &&
      r.intervals.mid == null &&
      r.intervals.long == null
    ) return null;
    return renderProviderLine(provider, {
      mode,
      nowMs: Date.now(),
      intervals: r.intervals,
      ageMs,
      stale,
      version: configStore.get().version,
      tokens,
      quoteBodies,
      pluginSource: pluginSource ?? null,
    });
  }
  if (entry.TYPE === "BALANCE") {
    return renderProviderLine(provider, {
      mode,
      nowMs: Date.now(),
      balance: data as Balance,
      ageMs,
      stale,
      version: configStore.get().version,
      tokens,
      quoteBodies,
      pluginSource: pluginSource ?? null,
    });
  }
  return null;
}

// Maps a (provider, FetchResult) pair to the final statusline line. All
// paths funnel through renderDataLine → renderProviderLine; TYPE only picks
// the ctx fields (intervals vs balance), the per-module `type` filter handles
// the rest. The bare "not available!" fail branch is preserved byte-for-byte.
//
// Display mode lives in configStore. Fresh ticks suppress the m_age suffix;
// stale ticks append the broken-chain "X ago" annotation (m_age or the
// forced-visibility fallback, whichever fires first).
export function buildProviderLine(
  provider: Provider,
  result: FetchResult<unknown>,
  tokens?: TokenSnapshot | null,
  quoteBodies?: Map<string, string>,
): string | null {
  // No early-return on a missing provider: provider-AGNOSTIC modules
  // (m_tokenIn / m_session / m_branch / m_version / …) read the live stdin
  // snapshot and should still render when ANTHROPIC_BASE_URL matches no
  // entry. Delegate to renderProviderLine and let the per-module `mode`
  // filter drop plan-/balance-only modules. Still return null when nothing
  // rendered (the upstream wrapper shouldn't write an empty line) — see the
  // empty-output check below.
  if (result.kind === "fail") {
    // No cached data + fetch failed → colored "not available!" (plugin alive,
    // provider unreachable). RED matches the is_available:false hue so the two
    // unavailable states (API-said-no vs fetch-failed) look the same.
    // failLabelForProvider returns the modeLabel without a trailing space
    // (m_modeLabel relies on named s_* separators), so the fail-line re-attaches
    // it here ("Usage: not available!"). Still passes tokens through so
    // m_token* modules render their own output alongside.
    if (tokens) {
      // Render the fail label through the template machinery so opt-in
      // m_token* modules still emit alongside — separators and skip rules
      // match the success path exactly.
      const line = renderProviderLine(provider, {
        mode: resolveDisplayMode(),
        nowMs: Date.now(),
        ageMs: null,
        stale: true,
        version: configStore.get().version,
        tokens,
        quoteBodies,
        pluginSource: peekPluginSource(provider),
      });
      // Empty-output guard: every module dropped, leaving label + separator
      // artifacts. Fall back to the colored "not available!" sentinel, which
      // color-matches the is_available:false / "fetch failed" cases.
      if (isEffectivelyEmpty(line)) {
        return `${failLabelForProvider(provider)} ${RED}not available!${RESET}`;
      }
      return line;
    }
    return `${failLabelForProvider(provider)} ${RED}not available!${RESET}`;
  }
  const line = renderDataLine(
    provider,
    result.data,
    result.ageMs,
    result.kind === "stale",
    tokens ?? null,
    quoteBodies,
    peekPluginSource(provider),
  );
  // Empty-output guard: (a) renderDataLine returned literal null (data
  // unusable — all reserved intervals missing on Quota, or an unknown TYPE);
  // (b) it returned a label-only degenerate line ("Usage: · · "). Both map to
  // null so upstream detects "nothing to write"; isEffectivelyEmpty catches
  // (b) — strict "" would let the label-only output leak through.
  if (line == null) return null;
  if (isEffectivelyEmpty(line)) return null;
  return line;
}
