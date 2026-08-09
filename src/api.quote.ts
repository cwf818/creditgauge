// Fetcher for `m_quote|address|…|field|…` tokens. Mirrors the cache-aside
// pattern of fetchProviderData (disk-shadowed TTL cache, stale-on-error via
// peek) and the tolerant-parse + diagnostics shape of the built-in plugins.
//
// Per-tick contract:
//   1. index.ts:main() calls preFetchQuotes(cwd, nowMs) after stdin parse and
//      provider resolution, BEFORE buildProviderLine runs.
//   2. preFetchQuotes scans statuslineTemplate + lineTemplates.* for the first
//      m_quote token: within-TTL cache hit → reuse body; else fetch with a 5s
//      timeout → on 2xx cache.set; on failure keep the old entry (stale-on-
//      error) or append a `warning` diagnostics row if none exists.
//   3. The body lands in ctx.quoteBodies for the sync renderer to read.

import { execFileSync } from "node:child_process";
import { openSync, readFileSync, unlinkSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import * as cache from "./cache.ts";
import { configStore } from "./config.ts";
import * as diagnostics from "./diagnostics.ts";
import { parseFreq } from "./quotes.ts";

// Classify a curl spawn error: ENOENT/ENOTDIR/EPERM/EACCES/ENOEXEC mean the
// binary can't launch ("not on PATH") → fall back to node:http(s). Everything
// else (timeouts, non-2xx, DNS) came from curl itself and is surfaced as-is.
function isBinaryMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return false;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "EPERM" ||
      code === "EACCES" || code === "ENOEXEC") return true;
  // Some Node errors nest the code inside the message; not worth a
  // regex here — ENOENT covers the common case.
  return false;
}

// HTTP(S) GET via node core — no deps. `insecure` → rejectUnauthorized:false
// on https. 5s timeout; non-2xx (≥400) rejects, matching curl `-f`.
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

// Cache value under `quote:<freqMs>:<address>`. `binIndex` is
// floor(nowMs / freqMs) at fetch time; a later tick only reuses the body
// when the current wall-clock bin matches (cross-bin → re-fetch, treating
// the address as a rotating stream per the user's |freq|).
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
// entry. Only one body is ever cached — multiple address tokens in the same
// template collapse to a single endpoint.
//
// `insecureTls` comes from the token's `|insecureTls|<b>` inline arg;
// absent → the global cfg().quoteInsecureTls gate is authoritative.
// `freq` reads `|freq|<raw>` through the same parseFreq the local-quote
// renderer uses (one grammar for both paths); absent/unparseable → `1h`.
type QuoteTarget = {
  address: string;
  insecureTls?: boolean;
  // `ms` = resolved bucket duration; `raw` = original inline arg (for
  // diagnostics; "1h" default when the token omits |freq|).
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
  // Capture curl's stderr to `<tmpdir>/creditgauge-curl-<pid>.log` so
  // exit-status detail survives for diagnostics (unique per process).
  // execFileSync("curl", argvArray) spawns curl directly — no shell, so the
  // URL passes verbatim (no cmd.exe quote-stripping / MSYS2 path-mangling)
  // and argv length isn't capped by MAX_ARG_STRS.
  const stderrPath = `${tmpdir()}/creditgauge-curl-${process.pid}.log`;
  // Opt-in TLS skip. Precedence: inline |insecureTls| on the token, then
  // cfg().quoteInsecureTls. No env-var seed. Set → append `-k` to curl argv
  // (self-signed / expired / untrusted-CA endpoints work); OFF by default so
  // TLS errors stay loud.
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

    // Fallback gate: only retry via node:http(s) when curl failed to LAUNCH
    // (binary not on PATH). Errors curl produced while running (timeout,
    // HTTP>=400, DNS, TLS) are meaningful network problems and surface
    // unchanged — a second implementation could mask the same root cause.
    if (isBinaryMissing(e)) {
      const fb = await fetchViaCore(url, insecure);
      if (fb.ok) return fb;
      // Surface BOTH reasons so a postmortem can separate "curl missing"
      // from the fallback's own failure.
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

// Pre-fetch the first m_quote|address|… source in the active template;
// returns a per-tick Map<address, body> for the renderer. Failures record a
// diagnostics row (and a missing Map entry); successes hit the disk-shadowed
// cache so the next process skips the fetch. The Map is per-tick — no
// module-level state survives.
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

  // Bin-rotated cache-aside. Key includes freqMs (independent streams per
  // freq); value carries the bin index at fetch time. binIndex === currentBin
  // → HIT (reuse body); cross-bin → MISS. TTL is 4 × freqMs so the row
  // expires on its own; the binIndex check is the actual gate.
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
    // Stale-on-error: surface the previous entry (peek ignores TTL). If it
    // doesn't match (address/freqMs differ), log a warning but don't add to
    // the Map — the renderer falls back to local QUOTES.
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
        undefined,
        undefined,
        "parse",
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
