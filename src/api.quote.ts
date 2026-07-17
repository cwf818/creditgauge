// v0.8.21+ — fetcher for `m_quote|address|…|field|…` tokens.
// Mirrors the data-driven shape of src/api.plan.ts (fetch + tolerant
// JSON parse + diagnostics) and the cache-aside pattern in
// src/index.ts:fetchProviderData (disk-shadowed TTL cache,
// stale-on-error via peek).
//
// Per-tick contract:
//   1. `index.ts:main()` calls `preFetchQuotes(cwd, nowMs)` after
//      stdin is parsed and the provider is resolved, BEFORE
//      `buildProviderLine` runs.
//   2. preFetchQuotes scans `cfg().statuslineTemplate` +
//      `cfg().lineTemplates.*` for every `m_quote|address|…` token
//      and dedupes by address. For the first one:
//        - cache.getWithAge(key, ttlMs) → if within TTL, skip the
//          fetch and reuse the cached body
//        - otherwise, await fetch(url, { signal: AbortSignal.timeout(5s) })
//          → on 2xx, cache.set(key, body, ttlMs)
//        - on non-2xx / network error / timeout, leave the previous
//          cache entry in place (stale-on-error). If no entry
//          exists, append a `warning` row to diagnostics.jsonl.
//   3. The returned body is passed to `buildProviderLine` →
//      `renderProviderLine` → `ctx.quoteBodies`, and the sync
//      renderer reads it via `ctx.quoteBodies.get(address)`.

import { execFileSync } from "node:child_process";
import { openSync, readFileSync, unlinkSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import * as cache from "./cache.ts";
import { configStore } from "./config.ts";
import * as diagnostics from "./diagnostics.ts";
import { parseFreq } from "./quotes.ts";

// v0.8.21+ — single-error classification: a curl `Command failed:`
// thrown by Node's child_process carries an embedded `code` (string)
// for errno-style failures. ENOENT means "binary not on PATH" —
// that's our trigger to fall back to node:https/http. EPERM /
// EACCES / ENOEXEC also qualify as "binary unusable"; we treat the
// whole `ENO*` + `EPERM`/`EACCES` family the same way. Other
// failures (timeouts, non-2xx exits, DNS) come from curl itself
// and are surfaced unchanged so a postmortem can attribute them
// to the network, not the spawn.
function isBinaryMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return false;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "EPERM" ||
      code === "EACCES" || code === "ENOEXEC") return true;
  // Some Node errors nest the code inside the message; not worth a
  // regex here — ENOENT covers the common case.
  return false;
}

// Run an HTTP(S) GET via node:http(s) core — no extra deps. `insecure`
// maps to `rejectUnauthorized: false` on the https path so the
// same `insecureTls` opt-in stays honored across both paths. 5s
// timeout; rejects on non-2xx (status ≥ 400) so a missing/wrong
// endpoint still produces a clean diagnostics row, matching curl
// `-f` semantics.
function fetchViaCore(
  url: URL,
  insecure: boolean,
): Promise<{ ok: true; body: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const lib = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = lib(
      {
        method: "GET",
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        headers: { Accept: "application/json" },
        ...(url.protocol === "https:"
          ? { rejectUnauthorized: !insecure }
          : {}),
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            resolve({ ok: false, reason: `HTTP ${res.statusCode}` });
          } else {
            resolve({ ok: true, body: data });
          }
        });
        res.on("error", (e) => {
          resolve({ ok: false, reason: e.message });
        });
      },
    );
    req.on("error", (e) => {
      resolve({ ok: false, reason: e.message });
    });
    req.setTimeout(5000, () => {
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}

// v0.8.21+ — value stored in `src/cache.ts` under the
// `<freqMs>:<address>` cache key. `binIndex` is the freq-bucket
// index from `floor(nowMs / freqMs)` at fetch time; the next tick
// only reuses this body when the current wall-clock bin still
// equals `binIndex`. Cross-bin → re-fetch so the address source
// has a fresh payload (matches the user's `|freq|1h`/`1m`/…
// semantic: the address itself is treated as a rotating stream).
type QuoteCacheEntry = {
  address: string;
  body: string;
  freqMs: number;
  binIndex: number;
};

function truncateForLog(s: string): string {
  return s.length > 120 ? s.slice(0, 119) + "…" : s;
}

// Walk a token list for the first `m_quote|address|<addr>|field|<path>`
// entry. We only ever cache one body — multiple address tokens in
// the same template collapse to a single endpoint.
//
// v0.8.21+ — `insecureTls` reflects the `|insecureTls|<b>` inline
// arg on the token so callers can opt into curl `-k` per-token
// without touching config.json. When the arg is absent, the value
// is `undefined` and the global `cfg().quoteInsecureTls` gate is
// authoritative; an explicit `|insecureTls|true|false` on the
// token overrides it for that tick.
//
// v0.8.21+ — `freq` reads `|freq|<raw>` (passed through the SAME
// `parseFreq` the local-quote renderer uses) so a single grammar
// governs both paths. When absent / unparseable we fall back to
// `1h` (matching the renderer's default for local QUOTES).
type QuoteTarget = {
  address: string;
  insecureTls?: boolean;
  // `ms` is the resolved bucket duration; `raw` is the original
  // inline arg string (used for diagnostics to surface what the
  // user actually typed — defaults to "1h" when the token omits
  // a `|freq|` arg).
  freq: { ms: number; raw: string };
};

function defaultFreq(): { ms: number; raw: string } {
  return { ms: 3_600_000, raw: "h" };
}

function scanTokens(toks: readonly string[]): QuoteTarget | null {
  for (const tok of toks) {
    const parts = tok.split("|");
    if (parts[0] !== "m_quote") continue;
    let address = "";
    let insecureTls: boolean | undefined;
    let freqRaw: string | undefined;
    // v0.8.34 — two-class pair grammar (`<name>:<value>` or
    // `<name>=<value>`, first separator wins). The v0.8.21-era
    // positional form `m_quote|address|<URL>|insecureTls|<bool>|…`
    // is no longer reachable: that token shape is rejected upstream
    // by the renderer's `parseInlineArgs`, so we never see it here.
    // Pairs the scanner doesn't care about (`color:`, `quote:`,
    // `author:`, `lang:`, `max:`, `wrap:`, `nulldrop:`) are silently
    // skipped — the renderer owns their semantics.
    for (let i = 1; i < parts.length; i++) {
      const pair = parts[i] ?? "";
      const sepIdx = pair.search(/[:=]/);
      if (sepIdx <= 0) continue;
      const name = pair.slice(0, sepIdx);
      const raw = pair.slice(sepIdx + 1);
      if (name === "address") {
        address = raw;
      } else if (name === "insecureTls") {
        const v = raw.toLowerCase();
        if (v === "true" || v === "1") insecureTls = true;
        else if (v === "false" || v === "0") insecureTls = false;
      } else if (name === "freq") {
        freqRaw = raw;
      }
    }
    if (address.length > 0) {
      const parsed = freqRaw !== undefined ? parseFreq(freqRaw) : null;
      const freq = parsed !== null
        ? { ms: parsed.ms, raw: freqRaw! }
        : defaultFreq();
      return { address, insecureTls, freq };
    }
  }
  return null;
}

// Test-only — exposes `scanTokens` so the v0.8.34 regression
// test can verify the pair grammar without poking at the full
// async preFetch pipeline. Production code never imports this.
export function __scanTokensForTest(
  toks: readonly string[],
): QuoteTarget | null {
  return scanTokens(toks);
}

async function fetchOne(
  address: string,
  insecureTls?: boolean,
): Promise<{ ok: true; body: string } | { ok: false; reason: string }> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { ok: false, reason: "unsupported scheme" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "unsupported scheme" };
  }
  // Capture stderr to a temp file so curl's exit-status detail
  // (e.g. "curl: (6) Could not resolve host") is preserved for
  // diagnostics instead of swallowed by stdio:[…,"ignore"]. tmp
  // filename: `<tmpdir>/creditgauge-curl-<pid>.log` — unique per
  // process so concurrent ticks (rare but possible) don't clobber
  // each other's stderr. Cleaned in catch / finally.
  //
  // v0.8.21 — use execFileSync("curl", argvArray) instead of
  // execSync("curl … <shellQuote(addr)>"). Node spawns curl
  // directly without an intermediate shell, so the URL arg is
  // passed verbatim — no risk of cmd.exe treating the single
  // quotes as a string wrapper (Windows would silently strip
  // them) or MSYS2 path-mangling the URL. argv length is also
  // uncapped by the shell's MAX_ARG_STRS limit on old Windows.
  const stderrPath = `${tmpdir()}/creditgauge-curl-${process.pid}.log`;
  // v0.8.21+ — opt-in TLS skip. Precedence (highest first):
  //   1. inline `|insecureTls|true|false` on the m_quote token
  //      (read by `preFetchQuotes` from the token's inline args)
  //   2. `cfg().quoteInsecureTls === true` from config.json
  // No env-var seed — the URL you skip TLS validation for is a
  // config-file decision, not a shell-environment one. When the
  // flag is set we append `-k` / `--insecure` to the curl argv so
  // self-signed / expired / untrusted-CA HTTPS endpoints work
  // without modifying the system CA bundle. The flag stays OFF by
  // default — a misconfigured upstream still surfaces TLS errors
  // loudly.
  const insecure = insecureTls ?? configStore.get().quoteInsecureTls === true;
  const curlArgs = ["-sSf", "--max-time", "5", "-S"];
  if (insecure) curlArgs.push("-k");
  curlArgs.push(address);
  let body: string;
  try {
    body = execFileSync("curl", curlArgs, {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", openSync(stderrPath, "w")],
    });
    // Success — drop the temp file quietly.
    try { unlinkSync(stderrPath); } catch { /* benign */ }
    return { ok: true, body };
  } catch (e) {
    // Read whatever curl wrote to stderr, append to reason so a
    // postmortem can see "exit 6 (DNS)" / "exit 28 (timeout)" /
    // "exit 60 (TLS cert)" / "exit 22 (HTTP >=400)" verbatim.
    let stderrTail = "";
    try {
      stderrTail = readFileSync(stderrPath, "utf8").trim();
    } catch { /* file gone or unreadable */ }
    try { unlinkSync(stderrPath); } catch { /* benign */ }
    const base = e instanceof Error ? e.message : String(e);

    // v0.8.21+ — fallback gate. When curl itself failed to LAUNCH
    // (binary not on PATH — typically legacy Windows without
    // System32\curl.exe, sandboxed envs that strip /usr/bin,
    // or PATH-truncated service processes), retry via node:http(s)
    // core so the user still gets their m_quote content instead
    // of silently falling back to the local QUOTES pool.
    //
    // The guard is intentionally narrow: ANY error curl produced
    // while actually running (timeout, HTTP>=400 exit 22, DNS exit
    // 6, TLS exit 60) is treated as a meaningful network problem
    // and surfaced unchanged — the user wants to see why their
    // endpoint failed, not have it silently covered up by a
    // second implementation that might mask the same root cause.
    if (isBinaryMissing(e)) {
      const fb = await fetchViaCore(url, insecure);
      if (fb.ok) return fb;
      // Fallback also failed — surface BOTH reasons so the
      // postmortem can tell the two apart (a 1st-stage ENOENT +
      // a 2nd-stage "ENOTFOUND" means "curl missing AND host
      // unreachable"; an ENOENT + "HTTP 500" means "curl missing
      // AND endpoint is broken").
      return {
        ok: false,
        reason: `curl missing (${String((e as { code?: unknown })?.code ?? "")}); node:http(s) fallback: ${fb.reason}`,
      };
    }
    return {
      ok: false,
      reason: stderrTail.length > 0 ? `${base} | stderr: ${stderrTail}` : base,
    };
  }
}

// Pre-fetch the first `m_quote|address|…` source referenced by the
// active lineTemplate + lineTemplates.* fragments. Returns a
// per-tick Map<address, body> for the renderer to read. Failures
// are recorded to diagnostics.jsonl (and reflected as a missing
// Map entry); successes are written to the disk-shadowed cache
// so the next tick (or the next process) can skip the fetch.
//
// The Map is intentionally per-tick (rebuilt every invocation) —
// the persistent cache lives in `src/cache.ts`. No module-level
// state survives between ticks.
export async function preFetchQuotes(
  cwd: string | null,
  nowMs: number,
): Promise<Map<string, string>> {
  void cwd; // per-project isolation lives in the global cache key
            // — all projects share the same row, so cwd is unused
  const out = new Map<string, string>();

  const cfg = configStore.get();
  const template = cfg.statuslineTemplate ?? [];
  const lineTemplates = cfg.lineTemplates ?? {};

  let target: QuoteTarget | null = scanTokens(template);
  if (target === null) {
    for (const k of Object.keys(lineTemplates)) {
      const t = scanTokens(lineTemplates[k] ?? []);
      if (t !== null) {
        target = t;
        break;
      }
    }
  }
  if (target === null) return out;

  // v0.8.21+ — bin-rotated cache-aside. The cache key includes
  // `freqMs` so two tokens addressing the same endpoint with
  // different freqs (e.g. `|freq|1h` and `|freq|1d`) keep
  // independent rotation streams. The cache value includes the
  // bin index at fetch time; we treat `binIndex === currentBin`
  // as a HIT (skip fetch; reuse body). Cross-bin → MISS; the TTL
  // is `4 × freqMs` so the cache row expires on its own even
  // without any tick ever crossing bins, but the binIndex check
  // is the actual gate.
  const currentBin = Math.floor(nowMs / target.freq.ms);
  const cacheKey = `quote:${target.freq.ms}:${target.address}`;
  const cached = cache.getWithAge<QuoteCacheEntry>(cacheKey, target.freq.ms * 4);
  if (
    cached !== null &&
    cached.value.address === target.address &&
    cached.value.freqMs === target.freq.ms &&
    cached.value.binIndex === currentBin
  ) {
    out.set(target.address, cached.value.body);
    return out;
  }

  const result = await fetchOne(target.address, target.insecureTls);
  if (!result.ok) {
    // Stale-on-error: keep the previous entry (peek ignores TTL so
    // even a stale row is surfaced for this tick). When the entry
    // also doesn't MATCH (address/freqMs differ), log a warning so
    // a postmortem can see the network failure — but DON'T add to
    // the returned Map; the renderer will fall back to local QUOTES.
    const stale = cache.peek<QuoteCacheEntry>(cacheKey);
    if (
      stale === null ||
      stale.address !== target.address ||
      stale.freqMs !== target.freq.ms
    ) {
      diagnostics.append(
        "error",
        "m_quote",
        `address fetch failed (curl exit): ${truncateForLog(target.address)} freq=${target.freq.raw} (reason=${result.reason})`,
        nowMs,
      );
    } else {
      out.set(target.address, stale.body);
    }
    return out;
  }

  cache.set(
    cacheKey,
    {
      address: target.address,
      body: result.body,
      freqMs: target.freq.ms,
      binIndex: currentBin,
    } satisfies QuoteCacheEntry,
    target.freq.ms * 4,
  );
  out.set(target.address, result.body);
  return out;
}
