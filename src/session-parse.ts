// Parse the Claude Code session JSON piped to stdin into a
// TokenSnapshot suitable for the m_token* / m_session* renderer
// modules.
//
// Extracted from src/index.ts so unit tests can import it without
// pulling in index.ts's top-level `await main()` and `loadConfig()`
// side effects (which would hang in node:test). The behavior is
// identical — same field paths, same null-coercion rules.
//
// Tolerates partial input: any field can be missing. The renderer
// modules each independently null-check their piece. v0.4.0+ adds
// session-identity / metadata fields (sessionName, modelDisplayName,
// effort, repo, ccversion), context-window stats (size, usedPct,
// remainingPct), and extended cost fields (totalApiDurationMs,
// totalLinesAdded, totalLinesRemoved).
//
// v0.8.0+ — invariant check on the parsed TokenSnapshot:
//   total_input_tokens == current.input_tokens + current.cache_read_input_tokens
// When violated, a `warning` is appended to the per-project
// diagnostics log (gated by CREDITGAUGE_DIAGNOSTICS_ENABLE). This
// surfaces schema drift early (e.g. a provider changing the
// cache_read accounting) without breaking the render path — the
// renderer still gets a fully populated snapshot. See
// [[token-modules-redesign-v0-8-0]] for the contract.
//
// v0.9.x — module-keyed naming (the parser's output shape is named
// after the modules that consume it): `current.input → current.tokenIn`
// (m_tokenIn), `current.cacheRead → current.tokenCachedIn`
// (m_tokenCachedIn), `totals.input → totals.tokenTotalIn` (m_tokenTotalIn
// + m_tokenInTotal + m_contextSize — same source, three module names).
// The invariant check below reads through the renamed fields.
import type { TokenSnapshot } from "./types.ts";
import * as diagnostics from "./diagnostics.ts";

export function parseTokenSnapshot(raw: string): TokenSnapshot | null {
  if (!raw || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const r = parsed as Record<string, unknown>;

  const cw = r.context_window;
  const cwObj =
    cw && typeof cw === "object" ? (cw as Record<string, unknown>) : null;
  const cu = cwObj?.current_usage;
  const cuObj =
    cu && typeof cu === "object" ? (cu as Record<string, unknown>) : null;

  const cost = r.cost;
  const costObj =
    cost && typeof cost === "object"
      ? (cost as Record<string, unknown>)
      : null;

  const numOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const strOrNull = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  // v0.4.0+ — extract session identity / metadata.
  // `model` is a nested object: { id, display_name }.
  const modelObj =
    r.model && typeof r.model === "object" && !Array.isArray(r.model)
      ? (r.model as Record<string, unknown>)
      : null;
  // `effort` is polymorphic: either a bare string ("high") or an
  // object ({ level: "high", ... }). We coerce both shapes to a
  // string|null at parse time so the renderer doesn't need a branch.
  const effortRaw = r.effort;
  let effort: string | null = null;
  if (typeof effortRaw === "string" && effortRaw.length > 0) {
    effort = effortRaw;
  } else if (
    effortRaw && typeof effortRaw === "object" && !Array.isArray(effortRaw)
  ) {
    effort = strOrNull((effortRaw as Record<string, unknown>).level);
  }
  // `workspace.repo` is { host, owner, name }. We extract per-field
  // and let the renderer decide whether to render (it filters null
  // components and joins with `/`).
  const workspaceObj =
    r.workspace && typeof r.workspace === "object" && !Array.isArray(r.workspace)
      ? (r.workspace as Record<string, unknown>)
      : null;
  const repoRaw = workspaceObj?.repo;
  let repo:
    | { host: string | null; owner: string | null; name: string | null }
    | null = null;
  if (repoRaw && typeof repoRaw === "object" && !Array.isArray(repoRaw)) {
    const ro = repoRaw as Record<string, unknown>;
    repo = {
      host: strOrNull(ro.host),
      owner: strOrNull(ro.owner),
      name: strOrNull(ro.name),
    };
  }

  const snap: TokenSnapshot = {
    sessionId: strOrNull(r.session_id),
    cwd: strOrNull(r.cwd),
    totals: {
      tokenTotalIn: numOrNull(cwObj?.total_input_tokens),
      tokenTotalOut: numOrNull(cwObj?.total_output_tokens),
    },
    current: {
      tokenIn: numOrNull(cuObj?.input_tokens),
      tokenOut: numOrNull(cuObj?.output_tokens),
      tokenCacheCreation: numOrNull(cuObj?.cache_creation_input_tokens),
      tokenCachedIn: numOrNull(cuObj?.cache_read_input_tokens),
    },
    cost: {
      totalDurationMs: numOrNull(costObj?.total_duration_ms),
      totalApiDurationMs: numOrNull(costObj?.total_api_duration_ms),
      totalLinesAdded: numOrNull(costObj?.total_lines_added),
      totalLinesRemoved: numOrNull(costObj?.total_lines_removed),
    },
    sessionName: strOrNull(r.session_name),
    modelDisplayName: strOrNull(modelObj?.display_name),
    // v0.9.x — read stdin.model.id as the canonical active-model
    // identifier. Powers tokenPrices lookup (per-model pricing
    // dict), JSONL sample.model stamp, and per-model accumulator
    // slot key. Independent of modelDisplayName so the display axis
    // (m_model) and the id axis (cost modules) can diverge.
    modelId: strOrNull(modelObj?.id),
    effort,
    repo,
    ccversion: strOrNull(r.version),
    contextWindow: {
      contextWindowSize: numOrNull(cwObj?.context_window_size),
      contextUsedPercent: numOrNull(cwObj?.used_percentage),
      contextRemainingPercent: numOrNull(cwObj?.remaining_percentage),
    },
  };

  // v0.8.0+ — invariant check: total_input_tokens must equal
  // (input_tokens + cache_read_input_tokens). Verified on the live
  // 2026-06-29 stdin sample (140 + 126720 = 126860) and on the
  // captured `stdin.real.json` fixture. A violation indicates
  // schema drift from a provider (cache_read accounting change,
  // a new "cache_creation" channel, etc.) — record it but don't
  // break the render path. The warning is gated by the
  // diagnostics system (env CREDITGAUGE_DIAGNOSTICS_ENABLE=1) and
  // deduped 60s per unique message. See diagnostics.ts.
  //
  // v0.9.x — reads through the module-keyed field names:
  // `snap.totals.tokenTotalIn` / `snap.current.tokenIn` /
  // `snap.current.tokenCachedIn`.
  if (
    snap.totals.tokenTotalIn != null &&
    snap.current.tokenIn != null &&
    snap.current.tokenCachedIn != null &&
    snap.totals.tokenTotalIn !== snap.current.tokenIn + snap.current.tokenCachedIn
  ) {
    diagnostics.append(
      "warning",
      "tokenTotalIn-invariant",
      `total_input_tokens=${snap.totals.tokenTotalIn} != input_tokens(${snap.current.tokenIn}) + cache_read_input_tokens(${snap.current.tokenCachedIn})`,
      Date.now(),
      snap.cwd,
    );
  }

  return snap;
}