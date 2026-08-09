// Lightweight git info for m_branch / m_gitStatus: reads only branch +
// dirty bit (no ahead/behind, untracked lists, or diff stats) so the
// statusline stays responsive. Each render spawns at most TWO git
// subprocesses per cwd (rev-parse + status), fronted by a Map<cwd, …>
// cache with a 60s default TTL. readGitInfo(cwd) → { branch, dirty } |
// null (null when cwd is missing / not a repo / git unavailable).
//
// execFileSync is fine because the process is short-lived, the ops are
// O(ms) on warm caches, and it keeps the implementation dependency-free.
// Stale-on-error: a failed refresh returns the previous value (even if
// expired) so the statusline never blanks. No ahead/behind — it requires an
// upstream tracking ref, which fresh clones / detached HEADs lack.

import { execFileSync } from "node:child_process";

type GitInfo = {
  branch: string;
  dirty: boolean;
};

let _cache: Map<string, { at: number; value: GitInfo | null }> = new Map();
const DEFAULT_TTL_MS = 60_000;
const GIT_TIMEOUT_MS = 2_000; // hard cap so a hung git can't stall the statusline

function execGit(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      // suppress the "fatal: not a git repository" stderr noise —
      // a non-git cwd is the most common case and we don't want it
      // polluting the user's statusline stderr.
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return null;
  }
}

// Fresh read for one cwd: rev-parse --abbrev-ref HEAD, then
// status --porcelain (no --branch → no branch-header line, so any
// non-empty output = dirty). Returns null when cwd is missing, not in a
// git work tree, or any git command fails.
export function readGitInfoFresh(cwd: string | null | undefined): GitInfo | null {
  if (!cwd) return null;
  const branch = execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch == null) return null;
  // Detached HEAD is treated as "no useful branch" — m_branch drops
  // instead of rendering "branch:HEAD".
  if (branch === "HEAD") return null;
  const status = execGit(cwd, ["status", "--porcelain"]);
  if (status == null) return null;
  // No --branch → no header line; any non-empty output = dirty.
  return { branch, dirty: status.length > 0 };
}

// Cached read. Process-local Map (no disk shadow): cwd changes invalidate
// it anyway and the 60s TTL makes a stale read negligible. ttlMs=0 forces
// a fresh read (tests).
export function readGitInfo(
  cwd: string | null | undefined,
  ttlMs: number = DEFAULT_TTL_MS,
): GitInfo | null {
  if (!cwd) return null;
  const now = Date.now();
  const cached = _cache.get(cwd);
  if (cached && ttlMs > 0 && now - cached.at < ttlMs) {
    return cached.value;
  }
  const fresh = readGitInfoFresh(cwd);
  _cache.set(cwd, { at: now, value: fresh });
  return fresh;
}

// Test-only: drop the entire cache. Tests that exercise both
// "with cache" and "without cache" branches call this between cases
// to avoid cross-test pollution.
export function __resetGitInfoCacheForTest(): void {
  _cache = new Map();
}