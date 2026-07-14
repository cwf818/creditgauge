// Provider dispatch: maps a (provider, fetch-result) pair to a statusline
// line. Extracted from index.ts so it can be exercised by tests without
// touching process.stdin / process.env (and without importing index.ts,
// which has top-level `await main()` side effects).
//
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
// v0.2.21: switched from provider-name literals ("minimax" /
// "deepseek") to TYPE-based dispatch. buildProviderLine now reads
// the provider's `TYPE` field from the providers config block and
// routes accordingly. Adding a new provider requires a matching
// plugin module plus its config entry.

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

// v0.9.0+ — read the per-provider pluginSource row from cache.json.
// cache.peek ignores TTL (returns the last-written value), so a user
// adding/removing an override file reflects on the NEXT tick even
// when the data cache row is still within TTL — important because
// the side might change without the data changing. Returns null
// when no provider matched / no cache row exists yet.
//
// `"missing"` (the "matched provider id has neither user override
// nor built-in" case) is now passed through to the renderer so
// `m_pluginSource` can render ❗ — previously this collapsed to
// null here at the ctx boundary and the failure was silent (per
// the older "Drop 整个 module" decision). The new behavior makes
// misconfigured providers loud: a user with
// `providers.copilot.<...>` but no query_plugins/copilot/ file
// now sees ❗ in the statusline instead of nothing.
function peekPluginSource(
  provider: Provider | null,
): "user" | "builtin" | "missing" | null {
  if (!provider) return null;
  const cached = cache.peek<PluginResolution>(`${provider}:pluginSource`);
  if (cached === "user" || cached === "builtin" || cached === "missing") return cached;
  return null;
}

// Detect a "label-only" degenerate output: the renderer ran but every
// module returned null, leaving just `m_modeLabel + s_space + s_dot`
// in the rendered line. The strip removes ANSI escapes, the configured
// labels, AND the NAMED-ALIAS literals (" " for s_space, "·" for
// s_dot, …), because the preset templates compose s_space / s_dot
// directly. What's left should be a real module chunk or it's empty
// output. We also treat literal whitespace-only output as empty.
// Used by buildProviderLine's two empty-output guards below —
// neither the bare "not available!" path nor the upstream wrapper
// should write a label-only line.
//
// Named alias literals — must stay in sync with NAMED_SEPARATORS in
// render.ts. Hardcoded here rather than imported to keep this module
// free of cross-file circular-import risk; config and renderer are
// independently verified to expose the same set.
const NAMED_SEPARATOR_LITERALS = [" ", "·", "\n", "\t", ":", "|"];

function isEffectivelyEmpty(line: string): boolean {
  // Strip ANSI SGR sequences (e.g. \x1b[38;5;29m, \x1b[0m).
  const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
  // Strip the configured label(s) — "Usage:" / "Remain:" /
  // "Balance:" / a user's override. Compare against `cfg()` so a
  // config-driven label change doesn't break the check.
  const labels = [
    cfg().modeLabels.used,
    cfg().modeLabels.balance,
    cfg().modeLabels.remaining,
  ];
  let working = stripped;
  for (const label of labels) {
    // Replace each label occurrence with a space so we don't strip
    // the trailing punctuation twice on a "Usage: Usage:" malformed
    // output (paranoid — should never happen).
    working = working.split(label).join(" ");
  }
  // Strip the named-alias separator literals (s_space / s_dot /
  // …). vX.X.X+: the legacy `separators` config array is gone, so
  // only NAMED_SEPARATOR_LITERALS needs stripping. A label +
  // separator template (e.g. "Usage: · · ") should be treated as
  // non-empty.
  for (const sep of NAMED_SEPARATOR_LITERALS) {
    if (sep === "") continue;
    working = working.split(sep).join("");
  }
  // Any remaining non-whitespace = real module output. Whitespace-
  // only = label + separators = empty.
  return working.trim() === "";
}

export type FetchResult<T> =
  | { kind: "fresh"; data: T; ageMs: number }
  | { kind: "stale"; data: T; ageMs: number }
  | { kind: "fail" };

// v0.4.x — single adapter that converts a (provider, data) pair to
// the right ctx fields for renderProviderLine. Replaces the older
// `renderPlanLine` + the inline `entry.TYPE === "BALANCE"` branch
// in buildProviderLine: those two paths used to fork on TYPE and
// dispatch to the now-deleted `formatLine` vs `formatBalanceLine`
// shims (dropped in the v0.9.x dead-export cleanup), each of which
// had its own way of plumbing the data into the renderer.
//
// Now both shapes flow through here. The provider's TYPE controls
// which ctx fields are populated; the renderer's per-module `type`
// filter (Task #1) handles "plan-only module on a balance ctx"
// silently, so we no longer need a TYPE switch on the caller's
// side. renderProviderLine itself picks the template via
// providerTypeFor + statuslineTemplate.
//
// Returns null only when (1) the provider has no entry (defensive
// — matchProvider is the upstream gate) or (2) data is shape-
// incompatible with the resolved TYPE (returns null as today).
//
// ageMs / stale semantics (unchanged):
//   fresh.ageMs : 0 for a just-fetched tick; the cache age for a
//                 within-TTL cache hit. Renderer suppresses the
//                 suffix on fresh ticks (stale=false gate).
//   stale.ageMs : how long since the last successful fetch.
//                 Renderer appends "⛓️‍💥 Xm ago" (or "0s ago" if the
//                 fetch just failed).
function renderDataLine(
  provider: Provider,
  data: unknown,
  ageMs: number,
  stale: boolean,
  tokens: TokenSnapshot | null,
  quoteBodies?: Map<string, string>,
  // "user" | "builtin" | null — same shape the ctx field accepts.
  // "missing" is now passed through (was collapsed to null by
  // peekPluginSource in older rounds; the renderer now renders
  // ❗ for it via labels.labelPluginMissing).
  pluginSource?: "user" | "builtin" | "missing" | null,
): string | null {
  const entry = getProviderEntry(provider);
  const mode = resolveDisplayMode();
  // v0.4.x — entry-tolerant. With the "no provider configured"
  // early-return removed from buildProviderLine, we need to handle
  // the case where `entry` is null here too: there's no TYPE to
  // dispatch on, so we skip both branches and call
  // renderProviderLine with empty data slots (no fiveHour, no
  // weekly, no balance). providerTypeFor returns "unknown" for the
  // null entry, so plan-only modules attempt to render but drop on
  // null data, balance-only modules always drop, and any future
  // type:"unknown"-tagged module would emit. Provider-agnostic
  // modules (m_token*, m_version, m_session, …) emit normally —
  // that's the "no provider but still useful" path the user
  // explicitly wants.
  //
  // Returning the empty string (vs null) signals to buildProviderLine
  // "the renderer ran but produced no output", which it then
  // translates back into a null return so the upstream wrapper can
  // skip writing an empty line. Returning null directly here would
  // lose that distinction.
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
    // v0.9.4 — `intervals` is a Record<string, Interval|null>. The
    // dict is open: plugins may declare any key (e.g. "monthly") and
    // reference it via `m_windowQuota|term|<key>`. Three reserved
    // keys ("short" / "mid" / "long") are always seeded (ensured by
    // `ensureQuota`) so the renderer can read `ctx.intervals[term]`
    // uniformly. We only return null when every seeded entry is
    // null — i.e. the parser found no recognisable data for any
    // reserved term. Non-reserved keys alone are treated as opt-in
    // and don't gate the whole render.
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

// Maps a (provider, FetchResult) pair to the final statusline line.
//
// v0.4.x — collapsed: previously dispatched on `entry.TYPE` to
// `renderPlanLine` (Quota) or `formatBalanceLine` (BALANCE) and
// the per-TYPE helpers hardcoded their data shape. v0.9.x — both
// `formatLine` and `formatBalanceLine` are also gone; every path
// funnels through `renderDataLine` → `renderProviderLine`, which
// reads TYPE only to pick the right ctx fields (`fiveHour`/`weekly`
// vs `balance`) and delegates the rest to the per-module `type`
// filter. The fail-with-tokens branch was already a renderProviderLine
// call (it's been template-routed since v0.4.0); the bare-tokens-fail
// "Usage: not available!" branch is preserved verbatim for v0.2.20
// byte-for-byte compatibility.
//
// Display mode lives in configStore — the old TOPGAUGE_DISPLAY env
// var is gone (see README "Configuration"). For fresh ticks the
// m_age suffix is suppressed; for stale ticks the renderer appends
// the broken-chain "X ago" annotation (the m_age module OR the
// forced-visibility fallback, whichever fires first).
export function buildProviderLine(
  provider: Provider,
  result: FetchResult<unknown>,
  tokens?: TokenSnapshot | null,
  quoteBodies?: Map<string, string>,
): string | null {
  // v0.4.x — the "no provider configured" early-return was removed
  // here on purpose. Previously the plugin was purely a Quota or
  // BALANCE frontend, so a missing provider entry meant there was
  // nothing meaningful to display; returning null was a clean signal
  // for the upstream wrapper to fall through.
  //
  // Now the plugin also exposes provider-AGNOSTIC modules
  // (m_tokenIn / m_tokenOut / m_ctx / m_session / m_branch /
  // m_version / m_model / …) that read from the live stdin snapshot
  // and have nothing to do with provider state. When a user has only
  // one statusline slot and isn't on a supported provider
  // (ANTHROPIC_BASE_URL doesn't match any configured entry), these
  // provider-agnostic modules should still render — that's the
  // point of writing a custom statusline. We delegate to
  // renderProviderLine / renderDataLine and let the per-module
  // `mode` filter drop the plan-/balance-only modules naturally.
  //
  // We still return null when nothing rendered (the upstream wrapper
  // should not write an empty line); see the empty-output check at
  // the bottom of this function.
  if (result.kind === "fail") {
    // No cached data + fetch failed. Render a colored "not available!"
    // so the user sees the plugin is alive but the provider is
    // unreachable. Color matches the legacy "is_available: false"
    // branch in `formatBalanceLine` (RED) — the shim is gone now but
    // the RED tint for the dispatch fail-line path is preserved so
    // the two unavailable states (API-said-no vs fetch-failed) keep
    // the same hue. The available-but-empty path in renderProviderLine
    // uses STALE_COLOR instead (via m_balance → placeholderBare).
    //
    // `failLabelForProvider` returns the modeLabel verbatim (no
    // trailing space — m_modeLabel module relies on s_0 separators in
    // the lineTemplate). The fail-line path doesn't go through the
    // template, so we re-attach the space here to preserve the
    // v0.2.20 output ("Usage: not available!" / "Balance: not available!").
    //
    // v0.4.0+: still pass tokens through so a user's lineTemplate can
    // include m_tokenIn/m_tokenOut alongside the fail-line — they
    // render their own module output, independent of provider state.
    if (tokens) {
      // Render the fail label as a minimal template (just the label
      // module) so the m_token* modules can still emit alongside.
      // Without this, fail paths would skip the template entirely
      // and the user's opt-in token modules would never render.
      // We use the lineTemplate-style render so separators and
      // module skipping rules match the success path exactly.
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
      // Empty-output guard: the template ran but every module dropped
      // (no provider + no module-bearing tokens), leaving just
      // `m_modeLabel + s_0 + s_0` artifacts. We fall back to the
      // colored "not available!" string instead — a totally-empty
      // statusline (or a label-only one) is worse than the
      // conventional unavailable sentinel, which color-matches the
      // existing is_available:false / "fetch failed" cases.
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
  // Empty-output guard. Two paths land here:
  //   (a) renderDataLine returned the literal null (provider has
  //       an entry but data is unusable — both fiveHour + weekly
  //       missing on a Quota provider, OR the provider TYPE
  //       is something renderDataLine doesn't know how to handle),
  //   (b) renderDataLine returned a label-only degenerate output
  //       like "Usage: · · " (no provider data + no opt-in
  //       modules fired, leaving just m_modeLabel + leftover s_0
  //       separators).
  // Both should translate to a null return so the upstream wrapper
  // can detect "nothing to write" cleanly. isEffectivelyEmpty
  // catches case (b) — strict `line === ""` would let the typical
  // label-only degenerate output leak through.
  if (line == null) return null;
  if (isEffectivelyEmpty(line)) return null;
  return line;
}
