// Parse the Claude Code session JSON from stdin into a TokenSnapshot for the
// m_token* / m_session* modules. Extracted from index.ts so unit tests can
// import it without index.ts's top-level `await main()` side effects.
//
// Tolerates partial input — any field may be missing; each renderer module
// null-checks its own piece.
//
// Invariant: total_input_tokens == input_tokens + cache_read_input_tokens +
// cache_creation_input_tokens. A missing creation-cache value is treated as
// zero for this check. A violation appends a `warning` to the per-project
// diagnostics log (gated by CREDITGAUGE_DIAGNOSTICS_ENABLE) — surfacing
// schema drift without breaking the render path.
//
// Field names are module-keyed (named for their primary reader): current.tokenIn
// (m_tokenIn), current.tokenCachedIn (m_tokenCachedIn), totals.tokenTotalIn
// (m_tokenTotalIn / m_tokenInTotal / m_contextSize — one source, three names).
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

  // `model` is a nested object: { id, display_name }.
  const modelObj =
    r.model && typeof r.model === "object" && !Array.isArray(r.model)
      ? (r.model as Record<string, unknown>)
      : null;
  // `effort` is polymorphic (bare string or { level, … }); coerce both to
  // string|null so the renderer needs no branch.
  const effortRaw = r.effort;
  let effort: string | null = null;
  if (typeof effortRaw === "string" && effortRaw.length > 0) {
    effort = effortRaw;
  } else if (
    effortRaw && typeof effortRaw === "object" && !Array.isArray(effortRaw)
  ) {
    effort = strOrNull((effortRaw as Record<string, unknown>).level);
  }
  // `workspace.repo` is { host, owner, name }; the renderer filters null
  // components and joins with `/`.
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

  // `workspace.project_dir` — the project root Claude Code was launched
  // in; distinct from cwd (a nested subdir opened mid-session). m_dirName
  // derives its basename from this (sole source).
  const projectDir = workspaceObj ? strOrNull(workspaceObj.project_dir) : null;

  const snap: TokenSnapshot = {
    sessionId: strOrNull(r.session_id),
    cwd: strOrNull(r.cwd),
    projectDir,
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
    // stdin.model.id is the canonical active-model identifier: powers
    // tokenPrices lookup, the JSONL sample.model stamp, and the per-model
    // accumulator slot key. Independent of modelDisplayName (display vs id).
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

  // Invariant check: total_input_tokens must equal input_tokens +
  // cache_read_input_tokens + cache_creation_input_tokens (verified on the
  // live 2026-06-29 sample and the stdin.real.json fixture). Missing creation
  // cache is treated as zero. A violation means provider schema drift — record
  // it (gated by CREDITGAUGE_DIAGNOSTICS_ENABLE, 60s dedupe) but don't break
  // the render path. Reads the module-keyed fields tokenTotalIn / tokenIn /
  // tokenCachedIn / tokenCacheCreation.
  const cacheCreation = snap.current.tokenCacheCreation ?? 0;
  if (
    snap.totals.tokenTotalIn != null &&
    snap.current.tokenIn != null &&
    snap.current.tokenCachedIn != null &&
    snap.totals.tokenTotalIn !==
      snap.current.tokenIn + snap.current.tokenCachedIn + cacheCreation
  ) {
    diagnostics.append(
      "warning",
      "tokenTotalIn-invariant",
      `total_input_tokens=${snap.totals.tokenTotalIn} != input_tokens(${snap.current.tokenIn}) + cache_read_input_tokens(${snap.current.tokenCachedIn}) + cache_creation_input_tokens(${cacheCreation})`,
      Date.now(),
      snap.cwd,
      undefined,
      "parse",
    );
    // On violation, derive tokenIn from the known totals and both cache
    // channels rather than propagating the bogus stdin value (often 0).
    snap.current.tokenIn = Math.max(
      0,
      snap.totals.tokenTotalIn - snap.current.tokenCachedIn - cacheCreation,
    );
  }

  return snap;
}