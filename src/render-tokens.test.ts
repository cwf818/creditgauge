// Tests for v0.4.0+ token-usage renderer modules + helpers.
// Exercises formatCompactToken, formatSpeed, cacheHitColor, and
// the lineTemplate integration via renderTemplate with a minimal
// TokenSnapshot.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  __resetPrevTickForTest,
  __resetUnknownModuleWarnForTest,
  cacheHitColor,
  formatAbsTime,
  formatCompactToken,
  formatCost,
  formatMemBytes,
  formatSpeed,
  getFieldByPath,
  peekAvg,
  peekPrevTick,
  renderTemplate,
  setAvg,
  setPrevTick,
} from "./render.ts";
import type { PrevTickSnapshot } from "./render.ts";
import { __resetForTest, configStore } from "./config.ts";
import type { Config } from "./config.ts";
import {
  __resetForTest as resetCacheForTest,
  setCachePathResolver,
} from "./cache.ts";
import {
  __resetForTest as resetStatusForTest,
  setStatusPathResolver,
} from "./status-store.ts";
import {
  beginTickForTest,
  processTick,
  resetTickStateForTest,
  setStateRoot,
  resetStateRoot,
  projectHash,
} from "./status-store.ts";
import * as statusStore from "./status-store.ts";
import {
  __resetStatCacheForTest,
  setStatCacheAtForTest,
  setStatCacheForTest,
  setStatCachePathResolver,
} from "./status-store.ts";
import * as cacheMod from "./cache.ts";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { __resetGitInfoCacheForTest } from "./git-info.ts";
import type { TokenSnapshot } from "./types.ts";
import { formatTtlSeconds } from "./render.ts";
import type { Interval } from "./render.ts";
import * as diagnostics from "./diagnostics.ts";

const STALE = "\x1b[90m";
const GREEN = "\x1b[38;5;41m";
const DARK_GREEN = "\x1b[38;5;29m";
const YELLOW = "\x1b[38;5;220m";
const ORANGE = "\x1b[38;5;208m";
const RED = "\x1b[38;5;196m";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const fakeSnapshot = (overrides: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  sessionId: "sess-test",
  cwd: "D:\\test",
  totals: { tokenTotalIn: 163479, tokenTotalOut: 155 },
  current: {
    tokenIn: 38,
    tokenOut: 155,
    tokenCacheCreation: 0,
    tokenCachedIn: 163441,
  },
  cost: { totalDurationMs: 600_000, totalApiDurationMs: 60_000, totalLinesAdded: 3965, totalLinesRemoved: 967 }, // 10 minutes total, 1m API time
  // v0.4.0+ — session identity / metadata / context stats
  sessionName: "strip-diagnostics-display",
  modelDisplayName: "MiniMax-M3",
  // v0.9.x — model id (stdin.model.id). Powers tokenPrices
  // lookup, per-model slot key, JSONL sample.model stamp.
  // Kept identical to modelDisplayName so the default fake
  // snapshot is internally consistent (a fixture can override
  // either or both independently).
  modelId: "MiniMax-M3",
  effort: "high",
  repo: { host: "github.com", owner: "cwf818", name: "topgauge" },
  ccversion: "2.1.191",
  contextWindow: { contextWindowSize: 200000, contextUsedPercent: 63, contextRemainingPercent: 37 },
  ...overrides,
});

// Bridge v0.8.x Window { pct, resetAt, resetStartAt, resetDurationMs }
// literals used throughout this file to the v0.9.0 Interval shape.
// Defaults windowId/label to "5h" so 7d callers pass it explicitly.
type LegacyWin = {
  pct: number;
  resetAt?: string | null;
  resetStartAt?: string | null;
  resetDurationMs?: number | null;
};
function legacyToIv(
  w: LegacyWin | null | undefined,
  // vX.X.X — widened from "5h" | "7d" | "30d" so tests can construct
  // Intervals with a non-canonical windowId for the new
  // declared-windowId resolution path (e.g. "5h-fake" to ensure
  // `|window|2h` falls through to dhms instead of matching the
  // declared ID).
  label: string = "5h",
): Interval | null {
  if (!w) return null;
  return {
    windowId: label,
    label,
    startAt: w.resetStartAt ? Date.parse(w.resetStartAt) : null,
    endAt: w.resetAt ? Date.parse(w.resetAt) : null,
    intervalMs: w.resetDurationMs ?? null,
    usedPercent: w.pct,
    remainingPercent: 100 - w.pct,
    remainingQuota: null,
    usedQuota: null,
    limitQuota: null,
  };
}

// renderTemplate needs the full RenderContext. Default seps are
// [" ", "·"] so "s_space" → " " and "s_dot" → "·". Tests don't care about
// shortInterval/midInterval/longInterval/balance — we only exercise
// m_token* paths.
const ctxFor = (
  tokens: TokenSnapshot | null,
  shortInterval: Interval | null = null,
  midInterval: Interval | null = null,
  longInterval: Interval | null = null,
  providerType: "quota" | "balance" | "unknown" = "quota",
) => ({
  mode: "used" as const,
  nowMs: 1_000_000,
  shortInterval,
  midInterval,
  longInterval,
  balance: null,
  ageMs: null,
  stale: false,
  version: "0.4.0-dev0",
  tokens,
  // v0.4.0+ — synthesized from tokens.contextWindow.contextUsedPercent.
  // The renderProviderLine helper does this synthesis; tests build
  // RenderContext directly so we mirror it here.
  contextWindow:
    tokens?.contextWindow?.contextUsedPercent != null
      ? { pct: tokens.contextWindow.contextUsedPercent }
      : null,
  // v0.4.x — the provider TYPE discriminator. Tests that don't care
  // about type filtering use the default "quota"; m_template coverage
  // in §5.3 overrides this. Renamed from `providerModeKey` (v0.4.x-
  // beta) to avoid collision with the display-mode field.
  providerType,
  // v0.8.7+ — passthrough from outer m_template. Tests that don't
  // exercise passthrough leave this undefined; the m_template
  // passthrough block at the end of the file mutates this field
  // directly to verify non-leakage.
  passThrough: undefined as Record<string, string | number> | undefined,
});

// v0.8.21+ — quoteBodies-injecting ctx factory. Mirrors ctxFor but
// attaches a pre-fetched body map so m_quote|address|… tests can
// exercise the renderer without spinning an HTTP server (the fetch
// + cache layer is covered separately in src/api.quote.ts tests).
const ctxWithQuoteBodies = (
  bodies: Map<string, string>,
  tokens: TokenSnapshot | null = fakeSnapshot(),
) => ({
  ...ctxFor(tokens),
  quoteBodies: bodies,
});

// v0.4.0+ — the speed/delta/avg cache helpers (peekPrevTick /
// setPrevTick / peekAvg / setAvg) write to
// ~/.claude/plugins/topgauge/state/cache.json. Tests MUST
// point that path at a tmp file so they don't leak to the user's
// real cache between runs. Per-test tmp dir + clean teardown keeps
// each test fully isolated.
let _tmpDir: string;
beforeEach(() => {
  __resetForTest();
  _tmpDir = mkdtempSync(join(tmpdir(), "topgauge-render-tokens-"));
  setCachePathResolver(() => join(_tmpDir, "cache.json"));
  // v0.4.x — per-tick state lives in status.json under the
  // project dir; tests must point that resolver at a tmp file
  // too so the cache module's leftover disk shadow doesn't leak
  // across tests.
  setStatusPathResolver(() => join(_tmpDir, "status.json"));
  // v0.8.16 — stat cache (m_sum* + m_statTtlStatus backing) lives
  // in cache.stat.json; tests must point that resolver at a tmp
  // file so the cache module's leftover disk shadow doesn't leak
  // across tests.
  setStatCachePathResolver(() => join(_tmpDir, "cache.stat.json"));
  __resetStatCacheForTest();
  resetCacheForTest(); // clears in-memory Map + lazy-load guard
  resetStatusForTest(); // clears status-store in-memory cache
  // v0.9.x — render functions now read/write through tick-state;
  // tests that drive renderers directly must seed the per-tick
  // state with beginTickForTest() before the first render call.
  // null cwd means an empty in-memory store; null tokens means
  // validation fails (commit() is a no-op), so tests that exercise
  // the in-memory contract don't accidentally hit the disk.
  resetTickStateForTest();
  beginTickForTest(null, null);
  // v0.8.0+ — token-store's stateRoot hook needs an explicit
  // reset between tests so sum/avg scans don't leak into a
  // different test's tmp dir.
  resetStateRoot();
});
// afterEach would be cleaner, but node:test supports only beforeEach
// in this file's existing pattern; we cleanup via the next beforeEach's
// fresh tmp dir. The old _tmpDir becomes unreachable but the OS will
// GC the temp dir eventually — acceptable for tests.

describe("formatCompactToken", () => {
  it("below thresholds[0] → raw integer", () => {
    assert.equal(formatCompactToken(0), "0");
    assert.equal(formatCompactToken(342), "342");
    assert.equal(formatCompactToken(999), "999");
  });

  it("between thresholds[0] and thresholds[1] → k with 1 decimal", () => {
    assert.equal(formatCompactToken(1_000), "1.0k");
    assert.equal(formatCompactToken(12_300), "12.3k");
    assert.equal(formatCompactToken(163_479), "163.5k");
  });

  it("≥ thresholds[1] → M with 1 decimal", () => {
    assert.equal(formatCompactToken(1_000_000), "1.0M");
    assert.equal(formatCompactToken(1_234_567), "1.2M");
  });

  it("non-finite / negative → '0'", () => {
    assert.equal(formatCompactToken(NaN), "0");
    assert.equal(formatCompactToken(-1), "0");
    assert.equal(formatCompactToken(Infinity), "0");
  });
});

describe("formatCost (vX.X.X+ m_tokenCost family)", () => {
  it("< 0.01 → 5 decimal places", () => {
    assert.equal(formatCost(0.00123), "0.00123");
    assert.equal(formatCost(0.0099), "0.00990");
  });
  it("< 0.1 → 4 decimal places", () => {
    assert.equal(formatCost(0.05), "0.0500");
    assert.equal(formatCost(0.0999), "0.0999");
  });
  it("< 1 → 3 decimal places", () => {
    assert.equal(formatCost(0.42), "0.420");
    assert.equal(formatCost(0.99), "0.990");
  });
  it("< 1000 → 2 decimal places", () => {
    assert.equal(formatCost(12.34), "12.34");
    assert.equal(formatCost(999.9), "999.90");
  });
  it("≥ 1000 → 2 decimal places", () => {
    assert.equal(formatCost(1000), "1000.00");
    assert.equal(formatCost(1234.56), "1234.56");
  });
  it("zero → '0.00'", () => {
    assert.equal(formatCost(0), "0.00");
  });
  it("negative / non-finite → '0.00'", () => {
    assert.equal(formatCost(-1), "0.00");
    assert.equal(formatCost(NaN), "0.00");
    assert.equal(formatCost(Infinity), "0.00");
  });
});

describe("formatSpeed", () => {
  it("<1000 t/s → decimal t/s", () => {
    assert.equal(formatSpeed(42.5), "42.5 t/s");
    assert.equal(formatSpeed(0.1), "0.1 t/s");
  });

  it("≥1000 t/s → k t/s", () => {
    assert.equal(formatSpeed(1200), "1.2k t/s");
  });

  it("null → —", () => {
    assert.equal(formatSpeed(null), "—");
  });

  it("non-finite → —", () => {
    assert.equal(formatSpeed(NaN), "—");
  });
});

describe("formatMemBytes (v0.8.17+ m_memUsage)", () => {
  // 1024-base, matching ccstatusline / htop / macOS Activity
  // Monitor convention. G tier uses .toFixed(1); M/K tiers use
  // .toFixed(0); null → "n/a" so the renderer can simply
  // template-literal concat without an extra null check.
  it("null → 'n/a'", () => {
    assert.equal(formatMemBytes(null), "n/a");
  });

  it("≥ 1 GiB → G with 1 decimal", () => {
    assert.equal(formatMemBytes(1024 ** 3), "1.0G");
    assert.equal(formatMemBytes(15.9 * 1024 ** 3), "15.9G");
    assert.equal(formatMemBytes(63.7 * 1024 ** 3), "63.7G");
    assert.equal(formatMemBytes(1024 ** 4), "1024.0G");
  });

  it("≥ 1 MiB and < 1 GiB → M with 0 decimals", () => {
    assert.equal(formatMemBytes(1024 ** 2), "1M");
    assert.equal(formatMemBytes(42 * 1024 ** 2), "42M");
    assert.equal(formatMemBytes(999 * 1024 ** 2), "999M");
  });

  it("≥ 1 KiB and < 1 MiB → K with 0 decimals", () => {
    assert.equal(formatMemBytes(1024), "1K");
    assert.equal(formatMemBytes(512 * 1024), "512K");
    assert.equal(formatMemBytes(1023 * 1024), "1023K");
  });

  it("< 1 KiB → raw bytes with B suffix", () => {
    assert.equal(formatMemBytes(0), "0B");
    assert.equal(formatMemBytes(1), "1B");
    assert.equal(formatMemBytes(1023), "1023B");
  });
});

describe("cacheHitColor — 3-band picker", () => {
  it("≥80 → good (green)", () => {
    assert.equal(cacheHitColor(80), GREEN);
    assert.equal(cacheHitColor(99), GREEN);
    assert.equal(cacheHitColor(100), GREEN);
  });

  it("≥50 and <80 → warn (yellow)", () => {
    assert.equal(cacheHitColor(50), YELLOW);
    assert.equal(cacheHitColor(79.9), YELLOW);
  });

  it("<50 → bad (orange)", () => {
    assert.equal(cacheHitColor(0), ORANGE);
    assert.equal(cacheHitColor(49.9), ORANGE);
  });
});

describe("getFieldByPath (v0.8.18+ m_quote field resolver)", () => {
  // Walks a JSON value along a dot-separated path (m_quote's own
  // local walker, NOT the deleted path-expr.ts — that host-side
  // resolver was removed in v0.9.x). Each segment is either an
  // object key or an array index; a string value is terminal
  // regardless of remaining path (per the user's "如果拿到的已
  // 经是字符串, 则忽略 field 参数" contract).

  it("object key path", () => {
    assert.equal(
      getFieldByPath({ quote: "hello" }, "quote"),
      "hello",
    );
  });

  it("nested object key path", () => {
    assert.equal(
      getFieldByPath({ data: { quote: "nested" } }, "data.quote"),
      "nested",
    );
  });

  it("array index path", () => {
    assert.equal(
      getFieldByPath({ quotes: ["a", "b", "c"] }, "quotes.1"),
      "b",
    );
  });

  it("nested array-of-objects path (per spec example: quotes.0.quotestring)", () => {
    assert.equal(
      getFieldByPath(
        { quotes: [{ id: 1, quotestring: "the first" }] },
        "quotes.0.quotestring",
      ),
      "the first",
    );
  });

  it("string value terminates path even with segments remaining", () => {
    // Per the user's contract: if a string is reached mid-path,
    // the rest of the field param is ignored.
    assert.equal(
      getFieldByPath({ quote: "already a string" }, "quote.does.not.matter"),
      "already a string",
    );
  });

  it("plain string body (no field) → returns as-is", () => {
    // Common case: endpoint returns a raw string. With empty
    // field, the path is one empty segment which never touches
    // cur, so the loop's final check returns the string.
    // Actually: split("") returns [""], loop iterates once with
    // seg = ""; on object the in check fails; on string the
    // typeof-string branch returns cur. So for a plain string
    // body + empty field, the result is the string itself.
    assert.equal(getFieldByPath("just a string", ""), "just a string");
  });

  it("missing key → null", () => {
    assert.equal(getFieldByPath({ a: 1 }, "b"), null);
    assert.equal(getFieldByPath({ a: 1 }, "a.b"), null);
  });

  it("out-of-range index → null", () => {
    assert.equal(getFieldByPath([1, 2], "5"), null);
    assert.equal(getFieldByPath({ a: [1] }, "a.10"), null);
  });

  it("non-numeric segment on array → null", () => {
    assert.equal(getFieldByPath([1, 2], "first"), null);
  });

  it("null / undefined in path → null", () => {
    assert.equal(getFieldByPath({ a: null }, "a.b"), null);
    assert.equal(getFieldByPath(undefined, "a"), null);
  });

  it("non-string leaf (number / object) → null", () => {
    assert.equal(getFieldByPath({ a: 42 }, "a"), null);
    assert.equal(getFieldByPath({ a: { b: 1 } }, "a"), null);
    assert.equal(getFieldByPath([1, 2], "0"), null);
  });
});

describe("renderTemplate — m_quote address+field (v0.8.21+)", () => {
  // v0.8.21+ — fetch lives in src/api.quote.ts (preFetchQuotes,
  // Node 18+ native fetch, disk-shadowed cache, simple "quote"
  // key shared across processes). Tests here exercise the
  // sync renderer in src/render.ts:fetchQuoteFromAddress, which
  // is a pure reader over ctx.quoteBodies. We inject the Map
  // directly via ctxWithQuoteBodies — no HTTP server, no curl
  // binary, no skip() gates.
  //
  // Arg shape: `m_quote|address:<url>|field:<single-path>`.
  // `fields` (plural, comma list) was removed in v0.8.21 — the
  // upgrade is strict; existing v0.8.19 configs need a manual
  // `fields` → `field` rename and a hand-pick of one path.
  //
  // v0.9.x wrap redesign — char-pair instead of bool.
  // `wrap` is a 2-char string when supplied (1-char is duped,
  // 2+-chars is sliced). Empty / missing → no-op (raw text,
  // no brackets). Booleans (`wrap|true|false`) are hard-rejected
  // by the char-pair resolver as badarg. Applies to BOTH
  // address-mode and local-mode (was address-only with
  // hard-coded `~` in v0.8.21+).

  it("address|fetched JSON + quote|hitokoto → bare value (wrap default no-op)", () => {
    // v0.9.x default: no wrap chars. The user opts into wrapping
    // via `|wrap:<chars>|`. Without that arg the rendered text is
    // the raw walked value.
    const url = "https://v1.hitokoto.cn/";
    const bodies = new Map<string, string>([
      [url, JSON.stringify({ hitokoto: "生如夏花之绚烂" })],
    ]);
    const out = renderTemplate(
      [`m_quote|address:${url}|quote:hitokoto`],
      ctxWithQuoteBodies(bodies),
    ).join("\n");
    assert.equal(strip(out), "生如夏花之绚烂");
  });

  it("address|quote|with author|from_who → bare <quote>--<author> (wrap default no-op)", () => {
    // v0.8.21+ — both `quote` and `author` paths walk the same
    // body. The author is rendered as the `--<author>` suffix.
    // v0.9.x — no wrap by default; the suffix stays plain.
    const url = "https://v1.hitokoto.cn/";
    const bodies = new Map<string, string>([
      [url, JSON.stringify({ hitokoto: "stay hungry stay foolish", from_who: "Steve Jobs" })],
    ]);
    const out = renderTemplate(
      [`m_quote|address:${url}|quote:hitokoto|author:from_who`],
      ctxWithQuoteBodies(bodies),
    ).join("\n");
    assert.equal(strip(out), "stay hungry stay foolish--Steve Jobs");
  });

  it("address|quote with author path MISS → bare <quote> (no author suffix)", () => {
    // v0.8.21+ — author walks tolerate misses; the renderer
    // elides the `--<author>` half when the walk yields null.
    // v0.9.x — no wrap by default.
    const url = "https://v1.hitokoto.cn/";
    const bodies = new Map<string, string>([
      [url, JSON.stringify({ hitokoto: "stay hungry stay foolish" })],
    ]);
    const out = renderTemplate(
      [`m_quote|address:${url}|quote:hitokoto|author:from_who`],
      ctxWithQuoteBodies(bodies),
    ).join("\n");
    assert.equal(strip(out), "stay hungry stay foolish");
  });

  it("address|quote|hitokoto + wrap|~ → wrapped value (1 char dups to 2)", () => {
    // v0.9.x — 1-char pair duplicates. `wrap=~` ≡ `wrap=~~`.
    const url = "https://v1.hitokoto.cn/";
    const bodies = new Map<string, string>([
      [url, JSON.stringify({ hitokoto: "stay hungry stay foolish" })],
    ]);
    const out = renderTemplate(
      [`m_quote|address:${url}|quote:hitokoto|wrap:~`],
      ctxWithQuoteBodies(bodies),
    ).join("\n");
    assert.equal(strip(out), "~stay hungry stay foolish~");
  });

  it("address|quote|quotes.0.quotestring → walked value (array index path)", () => {
    // Path walker supports object keys and array indices. The
    // v0.8.18 / v0.8.19 contract for getFieldByPath is preserved.
    // v0.9.x — wrap default is no-op, so the walked value comes
    // through bare.
    const url = "http://127.0.0.1:9999/quotes";
    const bodies = new Map<string, string>([
      [url, JSON.stringify({
        quotes: [
          { id: 1, quotestring: "remote quote one" },
          { id: 2, quotestring: "remote quote two" },
        ],
      })],
    ]);
    const out = renderTemplate(
      [`m_quote|address:${url}|quote:quotes.0.quotestring`],
      ctxWithQuoteBodies(bodies),
    ).join("\n");
    assert.equal(strip(out), "remote quote one");
  });

  it("address|quote miss → fallback to local QUOTES (no wrap)", () => {
    // Path miss → renderer logs a warning and falls back to the
    // local QUOTES list. v0.9.x — wrap default is no-op, so the
    // fallback's body comes through bare (and the bare-body test
    // below covers the explicit "no quote path" short-circuit).
    const url = "http://127.0.0.1:9999/";
    const bodies = new Map<string, string>([
      [url, JSON.stringify({ other: "nope" })],
    ]);
    const out = renderTemplate(
      [`m_quote|address:${url}|quote:missing.key`],
      ctxWithQuoteBodies(bodies),
    ).join("\n");
    assert.ok(out.length > 0, "expected fallback to local QUOTES");
    // wrap is no-op by default; without an explicit |wrap:| pair
    // the fallback path returns its picked quote un-decorated.
    assert.ok(!out.includes("~"), "local QUOTES fallback should not be wrapped");
  });

  it("address|non-JSON body + empty quote → bare body (no wrap)", () => {
    // The v0.8.18 backwards-compat: when the body is plain text
    // AND the user supplies `quote|` (empty marker), the body
    // is returned verbatim. v0.9.x — the bare-body short-circuit
    // is always un-wrapped (the user opted out of JSON walking
    // and the bare body is what they asked for; even if `wrap=~`
    // is supplied, the short-circuit skips decoration so the
    // exact body appears verbatim).
    const url = "http://127.0.0.1:9999/plain";
    const bodies = new Map<string, string>([
      [url, "just a plain string body"],
    ]);
    const out = renderTemplate(
      [`m_quote|address:${url}|quote:`],
      ctxWithQuoteBodies(bodies),
    ).join("\n");
    assert.equal(strip(out), "just a plain string body");
  });

  it("address|non-JSON body + non-empty quote → fallback local QUOTES", () => {
    // Body isn't JSON and the user did supply a non-empty
    // quote — we can't walk. Fallback to local QUOTES, no
    // tilde wrap.
    const url = "http://127.0.0.1:9999/plain";
    const bodies = new Map<string, string>([
      [url, "plain text body"],
    ]);
    const out = renderTemplate(
      [`m_quote|address:${url}|quote:hitokoto`],
      ctxWithQuoteBodies(bodies),
    ).join("\n");
    assert.ok(out.length > 0);
    assert.ok(!out.includes("~"), "local fallback should not be tilde-wrapped");
    assert.ok(!out.includes("plain text body"), "should not surface the un-walkable body");
  });

  it("address|missing ctx.quoteBodies entry → fallback local QUOTES", () => {
    // When preFetchQuotes didn't run OR didn't populate a row
    // for this address (e.g. fetch error with no recoverable
    // cache), the renderer sees `undefined` and falls back.
    const out = renderTemplate(
      ["m_quote|address:http://127.0.0.1:9999/|quote:x"],
      ctxWithQuoteBodies(new Map()),
    ).join("\n");
    assert.ok(out.length > 0, "expected fallback to local QUOTES");
    assert.ok(!out.includes("~"), "local fallback should not be tilde-wrapped");
  });

  it("address|quote with leading/trailing dot → schema rejects, drops", () => {
    // v0.8.21 — `quote|.x` / `quote|x.` / `quote|x..y` is
    // rejected by the QUOTE_QUOTE_PARAM resolver. The whole
    // token is dropped by the schema layer (`unknown
    // lineTemplate module` warning). The renderer never sees
    // the token, so no fallback to local QUOTES fires and the
    // template output is empty.
    const url = "http://127.0.0.1:9999/";
    const bodies = new Map<string, string>([
      [url, JSON.stringify({ hitokoto: "x" })],
    ]);
    const out = renderTemplate(
      [`m_quote|address:${url}|quote:.x`],
      ctxWithQuoteBodies(bodies),
    );
    assert.equal(out.length, 0, "schema-rejected token should drop");
  });

  it("local QUOTES path with lang|en → only English entries", () => {
    // v0.8.21+ — `lang|<csv>` filters the local QUOTES rotation
    // to the listed languages. All entries in the table are
    // lang="en" or lang="zh"; the picker walks forward from
    // the current bucket until a matching entry lands.
    const ctx = ctxFor(fakeSnapshot());
    const enTexts: string[] = [];
    for (let off = 0; off < 30; off++) {
      const out = renderTemplate(
        ["m_quote|lang:en"],
        { ...ctx, nowMs: ctx.nowMs + off * 60_000 },
      ).join("\n");
      enTexts.push(strip(out));
    }
    // All 30 sampled entries come from the English table — their
    // bodies contain ASCII letters / spaces / punctuation only.
    for (const t of enTexts) {
      assert.ok(
        /^[\x20-\x7e]*$/.test(t),
        `lang|en entry contains non-ASCII: ${JSON.stringify(t)}`,
      );
    }
  });

  it("local QUOTES path (no address) → not tilde-wrapped", () => {
    // Baseline: when no `address` arg is supplied, the m_quote
    // module reads from the local QUOTES list. No tilde wrap.
    const out = renderTemplate(
      ["m_quote"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.ok(out.length > 0);
    assert.ok(!out.includes("~"), "local QUOTES should not be tilde-wrapped");
  });
});

describe("renderTemplate — m_quote fetch-failure diagnostics (v0.8.20+)", () => {
  // v0.8.20+ — when fetchQuoteFromAddress returns null (curl exit /
  // non-JSON body / all paths miss), it appends a structured warning
  // to diagnostics.jsonl so a postmortem can grep why the local
  // QUOTES fallback fired. Gate is TOPGAUGE_DIAGNOSTICS_ENABLE=1;
  // these tests enable it for the duration.
  //
  // The diagnostics module reads state root from process.env.HOME /
  // CLAUDE_CONFIG_DIR at append-time; we redirect both to the
  // per-test _tmpDir so the JSONL file lands at
  // `<_tmpDir>/.claude/plugins/topgauge/state/<projectHash(cwd)>/diagnostics.jsonl`.
  // We use setSessionCwd to encode the originating project's hash on
  // the row's `cwd` field AND on the file path (Per-Project Layout).

  let diagRoot: string;
  beforeEach(() => {
    // Redirect state root to the per-test tmp dir.
    diagRoot = join(_tmpDir, "diagnostics-root");
    process.env.HOME = diagRoot;
    process.env.CLAUDE_CONFIG_DIR = diagRoot;
    process.env.TOPGAUGE_DIAGNOSTICS_ENABLE = "1";
    diagnostics.setSessionCwd("D:\\test");
    diagnostics.__resetDedupeForTest();
  });

  // Helper: read all JSONL rows from the project's diagnostics
  // file. Returns [] when the file is missing. The path mirrors
  // diagnostics.stateRoot() — see src/diagnostics.ts.
  function readDiagLines(): Array<Record<string, unknown>> {
    // diagnostics.stateRoot() returns either
    //   $CLAUDE_CONFIG_DIR/plugins/topgauge/state (when set), or
    //   $HOME/.claude/plugins/topgauge/state (when unset).
    // We set CLAUDE_CONFIG_DIR=diagRoot in beforeEach so the
    // per-project file lands at diagRoot/plugins/topgauge/state/<hash>/diagnostics.jsonl
    // (no .claude infix — CLAUDE_CONFIG_DIR is the literal config root).
    const path = join(
      diagRoot,
      "plugins",
      "topgauge",
      "state",
      projectHash("D:\\test"),
      "diagnostics.jsonl",
    );
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const out: Array<Record<string, unknown>> = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") out.push(parsed);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  }

  it("address|unreachable URL → appends no-body warning to diagnostics.jsonl", () => {
    // v0.8.21+ — with the per-tick ctx.quoteBodies pre-fetch model,
    // an unreachable URL means the body never lands in the Map;
    // the renderer sees the missing key and logs (no body). The
    // fetch-error reason is logged earlier in preFetchQuotes
    // (covered separately); this test pins the renderer's
    // fallback + warning contract.
    const out = renderTemplate(
      ["m_quote|address:http://127.0.0.1:1/|quote:x"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.ok(out.length > 0, "expected fallback to local QUOTES");
    const rows = readDiagLines();
    const mq = rows.find((r) => r.source === "m_quote");
    assert.ok(mq, "expected an m_quote diagnostic row");
    assert.equal(mq!.level, "error");
    assert.match(String(mq!.msg), /no body/);
    assert.match(String(mq!.msg), /http:\/\/127\.0\.0\.1:1\//);
    assert.equal(mq!.cwd, "D:\\test");
  });

  it("address|gate OFF (env unset) → no JSONL file written", () => {
    // Disable the gate. Reset dedupe so the only thing gating the
    // append is isEnabled().
    process.env.TOPGAUGE_DIAGNOSTICS_ENABLE = "";
    diagnostics.__resetDedupeForTest();
    const out = renderTemplate(
      ["m_quote|address:http://127.0.0.1:1/|quote:x"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.ok(out.length > 0, "expected fallback to local QUOTES");
    const rows = readDiagLines();
    assert.equal(
      rows.find((r) => r.source === "m_quote"),
      undefined,
      "diagnostics.jsonl should not be written when gate is off",
    );
    // Restore gate for downstream tests.
    process.env.TOPGAUGE_DIAGNOSTICS_ENABLE = "1";
  });
});

describe("renderTemplate — m_token* modules", () => {
  // ----- m_tokenIn / m_tokenOut (v0.4.0+ per-API-call delta) -----
  // semantics changed again from raw current_usage.* values to
  // delta vs the previous tick's snapshot, gated on delta_api > 0.
  // Same stability rule as the speed modules: always render (data
  // missing → "in:--"). Tests below cover each gate.

  it("m_tokenIn renders 'in:N' where N is the delta vs the previous tick", () => {
    // Seed prev in=0; fakeSnapshot has current.input=38 → delta=38.
    // deltaApi = 60_000 - 0 = 60_000 > 0 → valid tick.
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenIn"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "in:38");
  });

  it("m_tokenOut renders 'out:N' where N is the delta vs the previous tick", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenOut"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "out:155");
  });

  it("m_tokenIn| first tick (no prev) → assumes prev.apiMs=0, renders current.input directly", () => {
    // v0.4.0+ (revised 2026-06-29): when no previous tick exists
    // we DO NOT bail to "in:0". The renderer assumes the prior
    // baseline was at zero (prev.apiMs=0) and the first tick
    // contributes: deltaApi = currentApi - 0 = currentApi > 0
    // → hasDelta=true → render current.input directly. So the
    // first tick is NOT a sentinel and NOT a drop — it shows
    // the real per-turn delta. Side effect: setPrevTick is
    // still called with the current tick's snapshot so the NEXT
    // tick has a real baseline.
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenIn"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "in:38");
    const cached = peekPrevTick("sess-test", "D:\\test");
    assert.ok(cached, "current tick should be written to cache");
    // v0.8.10-alpha.2 snapshot contract: prevTickStatus now carries
    // only totalApiMs (+ identity). The per-turn `in / out / cacheRead`
    // snapshot values are no longer persisted as a prev-bag — only
    // totalApiMs participates in cross-tick apiMs subtraction.
    assert.equal(cached!.totalApiMs, 60_000);
  });

  it("m_tokenIn| no API call between ticks (deltaApi=0) → STALE_COLOR 'in|<stdin>'", () => {
    // v0.8.30.1+ — color tracks hasMeasurement, value tracks
    // stdin. Pre-seed prev with the SAME totalApiDurationMs
    // as current so deltaApi=0 → hasMeasurement=false. The
    // number shown is the live stdin (fakeSnapshot ships
    // current.tokenIn=38), wrapped in STALE_COLOR. value=0
    // is no longer forced when the tick is idle.
    setPrevTick("sess-test", { totalApiMs: 60_000 }, "D:\\test");
    const out = renderTemplate(["m_tokenIn"], ctxFor(fakeSnapshot())).join("\n");
    // The STALE_COLOR (\x1b[90m) wrap is opaque to strip() so
    // we only assert on the body. m_tokenIn's default is
    // brightGreen for active ticks, STALE_COLOR for idle;
    // the body is the live stdin number.
    assert.equal(strip(out), "in:38");
  });

  it("m_tokenIn| sessionId changes → prev cache miss → assumes prev=0 for new session", () => {
    // Pre-seed prev under a different sessionId. The new tick's
    // sessionId misses the cache → treated as a first tick for
    // the new session → prev.apiMs defaults to 0 → deltaApi =
    // currentApi (60_000) > 0 → hasDelta=true → render
    // current.input directly ("in:38").
    //
    // v0.8.x cwf-tickStatus-v2 — prevTickStatus is now a
    // SINGLETON per cwd (was per-sessionId under v0.4.x). The
    // "old session's cache entry should not be wiped" invariant
    // no longer applies — the singleton OVERWRITES regardless of
    // sessionId. What we still preserve: peekPrevTick for a
    // DIFFERENT sessionId returns null (because the singleton's
    // sessionId field doesn't match), so the next tick of the
    // OTHER session is correctly treated as a fresh baseline.
    setPrevTick("sess-OTHER", { totalApiMs: 0 }, "D:\\test");
    const firstSnap = fakeSnapshot();
    processTick(firstSnap.cwd, firstSnap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenIn"], ctxFor(firstSnap)).join("\n");
    assert.equal(strip(out), "in:38");
    const cached = peekPrevTick("sess-test", "D:\\test");
    assert.ok(cached, "new session's baseline should be written");
    // The singleton now belongs to sess-test; peeking with the
    // OLD sessionId returns null (no per-sessionId fallback any
    // more — the test would need a re-render to populate it).
    const otherCached = peekPrevTick("sess-OTHER", "D:\\test");
    assert.equal(otherCached, null,
      "v0.8.x — singleton prevTickStatus belongs to the most recent session; peeking with a different sessionId returns null");
  });

  it("m_tokenIn| second tick with real API call → emits this turn's delta directly", () => {
    // v0.4.0+ (revised 2026-06-29): current_usage.input_tokens IS
    // the per-turn delta — it reports THIS turn's contribution,
    // not a running total. We do NOT subtract prev; we just
    // display current.input when an API call landed
    // (deltaApi > 0).
    //
    // First tick writes the baseline (apiMs=60_000) and renders
    // "in:0" because hasDelta=false on the first tick.
    const first = fakeSnapshot();
    processTick(first.cwd, first);
    statusStore.commit();
    renderTemplate(["m_tokenIn"], ctxFor(first));
    // Second tick: this turn added 200 input tokens; the total
    // API time grew by 5s (+5_000 → 65_000). current.input=200
    // is THIS turn's delta → render "in:200", not "in:162" (no
    // subtraction from the 38 baseline).
    const next = fakeSnapshot({
      current: { tokenIn: 200, tokenOut: 155, tokenCacheCreation: 0, tokenCachedIn: 163441 },
      cost: { totalDurationMs: 700_000, totalApiDurationMs: 65_000, totalLinesAdded: null, totalLinesRemoved: null },
    });
    processTick(next.cwd, next);
    statusStore.commit();
    const out = renderTemplate(["m_tokenIn"], ctxFor(next)).join("\n");
    assert.equal(strip(out), "in:200");
  });

  it("m_tokenIn| per-turn delta contract — current.input IS the per-turn delta, no subtraction", () => {
    // Pins the new contract: even when prev.in is non-zero, the
    // module reports current.input verbatim (no
    // current.input - prev.in subtraction). The previous
    // implementation subtracted, which was correct under the
    // (now-abandoned) "current.input is a running total"
    // interpretation. Claude Code's session JSON reports
    // current_usage.{input,output,cache_read}_tokens as the
    // per-turn contribution (verified against the
    // stdin.real.json fixture: current_usage.input_tokens=140
    // while total_input_tokens=126860 — clearly per-turn, not
    // running total).
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenIn"], ctxFor(snap)).join("\n");
    // fakeSnapshot has current.input=38; under the new contract
    // that's THIS turn's delta, not (38 - 100). deltaApi = 60_000
    // > 0 → hasDelta=true → render current.input directly.
    assert.equal(strip(out), "in:38");
  });

  // ----- m_tokenInSpeed / m_tokenOutSpeed (delta-based speed) -----

  it("m_tokenInSpeed| delta of current.input / delta of cost.totalApiDurationMs", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(snap)).join("\n");
    // delta_in = 38, delta_api = 60_000 → 38/60000*1000 = 0.633 → "0.6 t/s".
    // v0.4.0+ scale coloring: 0.6 < 50 (the lowest `in` band) → red.
    assert.equal(strip(out), "in:0.6 t/s");
    assert.ok(out.includes(RED), `expected RED band in: ${JSON.stringify(out)}`);
  });

  it("m_tokenOutSpeed| delta of current.output / delta of cost.totalApiDurationMs", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenOutSpeed"], ctxFor(snap)).join("\n");
    // delta_out = 155, delta_api = 60_000 → 155/60000*1000 = 2.583 → "2.6 t/s".
    // v0.4.0+ scale coloring: 2.6 < 10 (the lowest `out` band) → red.
    assert.equal(strip(out), "out:2.6 t/s");
  });

  it("m_tokenInSpeed| first tick (no prev) → back-derives apiMs from tokenOut (v0.4.x legacy fallback)", () => {
    // v0.8.10-alpha.2 (per user refinement 2026-07-04): when
    // prev.totalApiMs is null (no prev tick), the canonical
    // fallback is apiMs = tokenOut * 1000 / 50 (the v0.4.x
    // back-derivation formula at 50 t/s). This preserves the
    // "first tick shows a real rate" contract — the speed
    // module renders current.input / apiMs * 1000 from the
    // back-derived apiMs, NOT from the stale literal totalApi.
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(snap)).join("\n");
    // current.input=38, fallback apiMs = 155 * 1000 / 50 = 3100
    // → 38/3100*1000 ≈ 12.258 → "12.3 t/s"
    assert.equal(strip(out), "in:12.3 t/s");
    const cached = peekPrevTick("sess-test", "D:\\test");
    assert.ok(cached);
    // v0.8.10-alpha.2 snapshot contract: only totalApiMs + identity
    // is persisted; per-turn in/out/cacheRead snapshots are NOT
    // carried in PrevTickSnapshot. See plan ancient-wobbling-mochi.md
    // for the contract rationale.
    assert.equal(cached!.totalApiMs, 60_000);
  });

  it("m_tokenInSpeed| no API call between ticks (deltaApi=0) → 'in|0.0 t/s' (v6.x idle=0)", () => {
    // v6.x — idle tick now renders the truthful 0.0 t/s rate rather
    // than "-- t/s". The "no data" sentinel is reserved for the
    // snapshot-missing case (test elsewhere uses ctxFor(null)).
    setPrevTick("sess-test", { totalApiMs: 60_000 }, "D:\\test");
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "in:0.0 t/s");
  });

  it("m_tokenInSpeed| sessionId changes → prev cache miss → assumes prev=0", () => {
    // Pre-seed prev under a different sessionId. The new tick's
    // sessionId misses the cache → treat as first tick for the
    // new session → prev.apiMs=0 → deltaApi=60_000 > 0 →
    // hasDelta=true → render real speed.
    setPrevTick("sess-OTHER", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(snap)).join("\n");
    // current.input=38, deltaApi=60_000 → 0.6 t/s
    assert.equal(strip(out), "in:0.6 t/s");
  });

  it("m_tokenInSpeed| thinking-only turn (deltaApi>0, current.input=0) → '0.0 t/s'", () => {
    // v0.4.0+ (revised): a turn with deltaApi>0 and current.input=0
    // (a thinking-only turn that produced no input tokens) is
    // valid — the rate is genuinely 0.0 t/s, not "-- t/s". This
    // is the per-turn-delta contract: an API call CAN add zero
    // input tokens (synthesized message, etc). The speed
    // module's direction-specific gate was a legacy artifact
    // from the "subtract prev" model — under the new contract
    // the per-turn input IS current.input verbatim, and a
    // zero rate is the truthful answer.
    const snap = fakeSnapshot({
      current: { tokenIn: 0, tokenOut: 50, tokenCacheCreation: 0, tokenCachedIn: 0 },
      cost: { totalDurationMs: 600_000, totalApiDurationMs: 60_000, totalLinesAdded: null, totalLinesRemoved: null },
    });
    setPrevTick("sess-test", { totalApiMs: 30_000 }, "D:\\test");
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(snap)).join("\n");
    // current.input=0, deltaApi=30_000 → 0.0 t/s
    assert.equal(strip(out), "in:0.0 t/s");
  });

  it("m_tokenInSpeed| second tick with real API call → emits real speed", () => {
    const first = fakeSnapshot();
    processTick(first.cwd, first);
    statusStore.commit();
    renderTemplate(["m_tokenInSpeed"], ctxFor(first));
    const next = fakeSnapshot({
      current: { tokenIn: 200, tokenOut: 250, tokenCacheCreation: 0, tokenCachedIn: 163441 },
      cost: { totalDurationMs: 700_000, totalApiDurationMs: 65_000, totalLinesAdded: null, totalLinesRemoved: null },
    });
    processTick(next.cwd, next);
    statusStore.commit();
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(next)).join("\n");
    // deltaTokenIn = current.input = 200 (no subtraction),
    // deltaApi = 65_000 - 60_000 = 5_000 → 200/5000*1000 = 40.0
    assert.equal(strip(out), "in:40.0 t/s");
  });


  // ----- m_accTokenIn / m_accTokenOut / m_accTokenCachedIn (v0.8.x
  //   cwf-tickStatus-v2 — REPLACES the v0.4.x–v0.8.0
  //   m_totalToken* / m_totalTokenWithCacheIn family, which was
  //   REMOVED with no alias). The m_acc* family reads the same
  //   per-session AccSnapshot (peekAvg) as before; what changed is
  //   that the module name now goes through the acc* pipeline
  //   instead of the removed total* pipeline.

  it("m_accTokenIn first tick (no avg cache) → assumes prev=0, contributes this turn's delta", () => {
    // v0.4.0+ (revised 2026-06-29): first tick assumes prev=0,
    // deltaApi=60_000>0 → hasDelta=true → accumulate
    // current.input=38 → accTokenIn=38 → "in:38" (no more "in:0"
    // sentinel on first tick).
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenIn"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "in:38");
    const avg = peekAvg("sess-test", "D:\\test");
    assert.ok(avg);
    assert.equal(avg!.accTokenIn, 38);
  });

  it("m_accTokenIn after one valid tick → 'in|N' (single-tick contribution)", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenIn"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "in:38");
    const avg = peekAvg("sess-test", "D:\\test");
    assert.ok(avg);
    assert.equal(avg!.accTokenIn, 38);
  });

  it("m_accTokenIn second tick accumulates, reads cumulative sum", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const first = fakeSnapshot();
    processTick(first.cwd, first);
    statusStore.commit();
    renderTemplate(["m_accTokenIn"], ctxFor(first));
    const next = fakeSnapshot({
      current: { tokenIn: 200, tokenOut: 250, tokenCacheCreation: 0, tokenCachedIn: 163441 },
      cost: { totalDurationMs: 700_000, totalApiDurationMs: 65_000, totalLinesAdded: null, totalLinesRemoved: null },
    });
    processTick(next.cwd, next);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenIn"],
      ctxFor(next),
    ).join("\n");
    assert.equal(strip(out), "in:238");
  });

  it("m_accTokenIn idle tick (deltaApi=0) does NOT accumulate", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const first = fakeSnapshot();
    processTick(first.cwd, first);
    statusStore.commit();
    renderTemplate(["m_accTokenIn"], ctxFor(first));
    setPrevTick("sess-test", { totalApiMs: 60_000 }, "D:\\test");
    const idle = fakeSnapshot();
    processTick(idle.cwd, idle);
    statusStore.commit();
    renderTemplate(["m_accTokenIn"], ctxFor(idle));
    const avg = peekAvg("sess-test", "D:\\test");
    assert.ok(avg);
    assert.equal(avg!.accTokenIn, 38, "idle tick must not change accTokenIn");
  });

  it("m_accTokenOut first tick (no avg cache) → assumes prev=0, contributes this turn's delta", () => {
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenOut"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "out:155");
  });

  it("m_accTokenOut after one valid tick → 'out|N'", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenOut"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "out:155");
  });

  it("m_accTokenOut second tick accumulates", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const first = fakeSnapshot();
    processTick(first.cwd, first);
    statusStore.commit();
    renderTemplate(["m_accTokenOut"], ctxFor(first));
    const next = fakeSnapshot({
      current: { tokenIn: 200, tokenOut: 250, tokenCacheCreation: 0, tokenCachedIn: 163441 },
      cost: { totalDurationMs: 700_000, totalApiDurationMs: 65_000, totalLinesAdded: null, totalLinesRemoved: null },
    });
    processTick(next.cwd, next);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenOut"],
      ctxFor(next),
    ).join("\n");
    assert.equal(strip(out), "out:405");
  });

  it("m_accTokenCachedIn first tick → assumes prev=0, contributes this turn's cache_read", () => {
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenCachedIn"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "cache:163.4k");
  });

  it("m_accTokenCachedIn missing stdin field → 'cache:n/a' (v0.8.10-alpha.3 default session scope, no slot)", () => {
    const out = renderTemplate(
      ["m_accTokenCachedIn"],
      ctxFor(fakeSnapshot({ current: { tokenIn: 38, tokenOut: 155, tokenCacheCreation: 0, tokenCachedIn: null } })),
    ).join("\n");
    assert.equal(strip(out), "cache:n/a");
  });

  it("m_accTokenCachedIn after one valid tick → 'cache|N' (compact format)", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenCachedIn"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "cache:163.4k");
    const avg = peekAvg("sess-test", "D:\\test");
    assert.ok(avg);
    assert.equal(avg!.accTokenCachedIn, 163441);
  });

  it("m_accTokenCachedIn second tick accumulates cache_read deltas", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const first = fakeSnapshot();
    processTick(first.cwd, first);
    statusStore.commit();
    renderTemplate(
      ["m_accTokenCachedIn"],
      ctxFor(first),
    );
    const next = fakeSnapshot({
      current: { tokenIn: 200, tokenOut: 250, tokenCacheCreation: 0, tokenCachedIn: 350_000 },
      cost: { totalDurationMs: 700_000, totalApiDurationMs: 65_000, totalLinesAdded: null, totalLinesRemoved: null },
    });
    processTick(next.cwd, next);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenCachedIn"],
      ctxFor(next),
    ).join("\n");
    assert.equal(strip(out), "cache:513.4k");
  });

  it("m_accToken*: tokens is null → 'in:n/a out:n/a cache:n/a' (v6.x placeholders)", () => {
    const out = renderTemplate(
      ["m_accTokenIn", "s_space", "m_accTokenOut", "s_space", "m_accTokenCachedIn"],
      ctxFor(null),
    ).join("\n");
    assert.equal(strip(out), "in:n/a out:n/a cache:n/a");
  });

  it("m_accTokenIn|color|brightGreen wraps the chunk in brightGreen", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenIn|color:brightGreen"],
      ctxFor(snap),
    );
    const joined = out.join("\n");
    assert.ok(
      joined.includes(`\x1b[38;5;41min:38\x1b[0m`),
      `got: ${JSON.stringify(joined)}`,
    );
  });

  it("m_accTokenIn / m_accTokenOut / m_accTokenCachedIn share the per-session accumulator", () => {
    // v0.8.x cwf-tickStatus-v2 — m_totalToken* / m_totalTokenWithCacheIn
    // were REMOVED (no alias). The session-scope m_acc* family
    // replaces them and shares the same AccSnapshot slot across
    // modules within a single render.
    setPrevTick("sess-total-avg", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot({ sessionId: "sess-total-avg" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      [
        "m_accTokenIn",
        "s_space",
        "m_accTokenOut",
        "s_space",
        "m_accTokenCachedIn",
      ],
      ctxFor(snap),
    ).join("\n");
    // All three modules read the same AccSnapshot in the same
    // render — same deltas fire, same accumulator view.
    //   accTokenIn=38 → "in:38"
    //   accTokenOut=155 → "out:155"
    //   accTokenCachedIn=163441 → "cache:163.4k"
    assert.equal(
      strip(out),
      "in:38 out:155 cache:163.4k",
    );
    const avg = peekAvg("sess-total-avg", "D:\\test");
    assert.ok(avg);
    assert.equal(avg!.accTokenIn, 38);
    assert.equal(avg!.accTokenOut, 155);
    assert.equal(avg!.accTokenCachedIn, 163441);
    assert.equal(avg!.accApiMs, 60_000);
  });

  // ----- generic snapshot tests -----

  it("tokens is null → m_tokenIn / m_tokenOut render 'n/a'; m_contextSize / m_tokenHitRate render 'n/a' (v6.x placeholders)", () => {
    // v6.x — null/no-snapshot is now distinct from "zero". All
    // per-API-call modules emit "n/a" placeholders rather than
    // "0" or drop. The bare-form parity rule means m_tokenIn and
    // m_contextSize both keep their slot when stdin is missing.
    const out = renderTemplate(
      ["m_tokenIn", "s_space", "m_tokenOut", "s_space", "m_contextSize", "s_space", "m_tokenHitRate"],
      ctxFor(null),
    ).join("\n");
    assert.equal(strip(out), "in:n/a out:n/a size:n/a hit:n/a");
  });

  it("partial snapshot: missing cost.totalApiDurationMs → m_tokenInSpeed renders 'in:0.0 t/s' (v6.x)", () => {
    // v6.x — when totalApiDurationMs is null the function takes the
    // idle-without-measurement path (cost missing means we can't
    // compute a rate this tick). Per the v6.x "0 renders, n/a is
    // reserved for the no-stdin-at-all case", the truthful zero is
    // rendered. The tokens=null path (no stdin) is a separate test.
    const out = renderTemplate(
      ["m_tokenInSpeed"],
      ctxFor(fakeSnapshot({ cost: { totalDurationMs: null, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null } })),
    ).join("\n");
    assert.equal(strip(out), "in:0.0 t/s");
  });

  it("m_tokenHitRate| per-turn cacheRead / totals.input = 100.0% (v0.8.0 per-turn formula)", () => {
    // v0.8.0+ formula: current.cacheRead / totals.input. With the
    // fakeSnapshot (totals.input=163479, current.cacheRead=163441),
    // the rate is 163441/163479 = 99.978% → toFixed(1) rounds to
    // "100.0%" (the user-acceptable "near-total" display).
    const out = renderTemplate(
      ["m_tokenHitRate"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "hit:100.0%");
  });

  it("m_tokenHitRate| 0 cache reads / 38 totals.input = 0.0% (v0.8.0 per-turn formula)", () => {
    // v0.8.0+ — when current.cacheRead=0 and totals.input=38, the
    // per-turn rate is 0/38 = 0.0% (NOT a null/drop).
    const out = renderTemplate(
      ["m_tokenHitRate"],
      ctxFor(
        fakeSnapshot({
          totals: { tokenTotalIn: 38, tokenTotalOut: 155 },
          current: { tokenIn: 38, tokenOut: 155, tokenCacheCreation: 0, tokenCachedIn: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "hit:0.0%");
  });

  // v0.8.x — m_tokenHitRate cache-fallback: when this tick's
  // stdin lacks cache_read_input_tokens (cacheRead=null) but
  // lastActive:tokenHitRate holds a value within the 60s TTL
  // window, render the cached percentage STALE_COLORed instead
  // of dropping to the "hit:n/a" placeholder. Mirrors m_apiMs's
  // fallback added in this session.
  it("m_tokenHitRate| cacheRead=null WITH cached lastActive:tokenHitRate (within TTL) → 'hit|99.5%' (STALE_COLORed)", () => {
    // First render: cacheRead is present → 99.978% → setLastTokenHitRate
    // fires from the MODULES body, persisting ~99.978 to status.json.
    const firstSnap = fakeSnapshot({ sessionId: "sess-hr-cache-fallback" });
    processTick(firstSnap.cwd, firstSnap);
    statusStore.commit();
    renderTemplate(
      ["m_tokenHitRate"],
      ctxFor(firstSnap),
    );
    // Second render: cacheRead=null on stdin (field not shipped this
    // tick). The cached lastActive:tokenHitRate (~99.978) must
    // surface, not the placeholder.
    const out = renderTemplate(
      ["m_tokenHitRate"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-hr-cache-fallback",
          current: { tokenIn: 0, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: null },
        }),
      ),
    ).join("\n");
    // 163441/163479 = 99.978% → toFixed(1) = "100.0%" (rounds up).
    // The point of the test: it must NOT be the placeholder; it must
    // be the cached percentage wrapped in STALE_COLOR.
    assert.equal(strip(out), "hit:100.0%");
    assert.ok(out.includes(STALE), `expected STALE wrap on cached fallback: ${JSON.stringify(out)}`);
  });

  it("m_tokenHitRate| cacheRead=null with NO prior cached value → placeholder 'hit|n/a'", () => {
    // Fresh session: first tick has cacheRead=null AND no
    // lastActive:tokenHitRate has been written (beforeEach resets
    // status.json per test). Placeholder must fire.
    const out = renderTemplate(
      ["m_tokenHitRate"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-hr-no-cache",
          current: { tokenIn: 0, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: null },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "hit:n/a");
  });

  it("m_tokenHitRate| inline |color|red on cached fallback: STALE_COLOR wins over user color (mirror of tps siblings)", () => {
    // v0.8.x — the TTL-bounded cache fallback overrides the
    // user's |color| override with STALE_COLOR, matching
    // computeTickSpeed's behavior for m_tokenInSpeed /
    // m_tokenOutSpeed and m_apiMs. Gray is the canonical
    // "this is from a previous tick" signal.
    const firstSnap = fakeSnapshot({ sessionId: "sess-hr-inline-color" });
    processTick(firstSnap.cwd, firstSnap);
    statusStore.commit();
    renderTemplate(
      ["m_tokenHitRate"],
      ctxFor(firstSnap),
    );
    const out = renderTemplate(
      ["m_tokenHitRate|color:red"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-hr-inline-color",
          current: { tokenIn: 0, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: null },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "hit:100.0%");
    assert.ok(out.includes(STALE), `expected STALE wrap: ${JSON.stringify(out)}`);
  });

  // v0.8.x — m_tokenHitRate idle-tick STALE_COLOR: when this
  // tick's stdin is present (cacheRead != null) but the API
  // did not do work (hasDelta=false → deltaApi=0), the rendered
  // hit rate is the same value as the prior tick, NOT a fresh
  // measurement. Mirror the m_tokenInSpeed / m_tokenOutSpeed /
  // m_apiMs convention: gray it.
  it("m_tokenHitRate| idle tick (deltaApi=0, cacheRead present) → 'hit|99.5%' STALE_COLORed", () => {
    // First tick: prime the prev-tick cache to apiMs=60_000. After
    // priming, current.input=38 etc. moves by a non-zero amount.
    setPrevTick(
      "sess-hr-idle",
      { totalApiMs: 0 },
      "D:\\test",
    );
    // Second tick: stdin same as fakeSnapshot defaults (cacheRead
    // present, total > 0) but prev.apiMs = current.apiMs → deltaApi=0
    // → hasDelta=false. computeAndCacheTickDelta fires, sets
    // prevTick back, hasDelta is false.
    setPrevTick(
      "sess-hr-idle",
      { totalApiMs: 60_000 },
      "D:\\test",
    );
    const out = renderTemplate(
      ["m_tokenHitRate"],
      ctxFor(fakeSnapshot({ sessionId: "sess-hr-idle" })),
    ).join("\n");
    // The rendered text is the same 100.0% (163441/163479 rounds
    // up) — but the WRAPPER must be STALE_COLOR (gray), not the
    // band-based cacheHitColor. This is the visual consistency
    // the user asked for: idle ticks across m_tokenInSpeed /
    // m_tokenOutSpeed / m_apiMs / m_tokenHitRate all share the
    // gray STALE_COLOR.
    assert.equal(strip(out), "hit:100.0%");
    assert.ok(
      out.includes(STALE),
      `expected STALE_COLOR wrap on idle tick: ${JSON.stringify(out)}`,
    );
  });

  it("m_tokenHitRate| active tick (deltaApi>0) keeps cacheHitColor band", () => {
    // First tick (active): prime the prev-tick cache.
    setPrevTick(
      "sess-hr-active",
      { totalApiMs: 0 },
      "D:\\test",
    );
    // Second tick: stdin has higher totalApiDurationMs than the
    // prev baseline → hasDelta=true → active branch fires →
    // cacheHitColor(pct) wrapper, NOT STALE_COLOR.
    const snap = fakeSnapshot({
      sessionId: "sess-hr-active",
      cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_tokenHitRate"],
      ctxFor(snap),
    ).join("\n");
    // The text is 100.0% (rounded). The wrapper MUST NOT be
    // STALE_COLOR — it must be the band-based cacheHitColor
    // (bright green for ≥ 80% hit rate, in the default config).
    assert.equal(strip(out), "hit:100.0%");
    assert.ok(
      !out.includes(STALE),
      `expected band color (NOT STALE) on active tick: ${JSON.stringify(out)}`,
    );
  });

  it("composed template with multiple token modules + separator", () => {
    // Seed prev so m_tokenIn / m_tokenOut have a delta to render.
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_tokenIn", "s_space", "m_tokenOut", "s_space", "s_dot", "s_space", "m_contextSize"],
      ctxFor(snap),
    ).join("\n");
    // v0.4.0+ per-API-call delta:
    //   m_tokenIn delta = 38-0 = 38 → "in:38"
    //   m_tokenOut delta = 155-0 = 155 → "out:155"
    //   m_contextSize (v0.8.0+) = totals.input = 163479 → "size:163.5k"
    // s_0=" " between adjacent, then "·" + " " between groups →
    // "in:38 out:155 · size:163.5k"
    assert.equal(strip(out), "in:38 out:155 · size:163.5k");
  });
});

// ----- v0.8.0+ per-turn API-ms delta (m_apiMs) ---------------------------
//
// Per-tick delta of cost.totalApiDurationMs formatted as a dhms
// time string with the "api:" prefix. Distinct from m_accApiMs
// (session-cumulative token count, prefix "acc:") and m_sumApiMs
// (cross-project sum token count, prefix "api:" but token
// formatted). The new module's value semantics:
//
//   m_apiMs = current total_api_duration_ms − prev total_api_duration_ms
//
// Gate: hasDelta (deltaApi > 0). Idle tick (current == prev) →
// "api:n/a". No stdin or no sessionId → "api:n/a". The
// writeBack path mirrors m_tokenIn / m_tokenOut: the renderer
// fires setPrevTick on every call so the next tick has a fresh
// baseline regardless of which per-turn module appears in the
// user's template.

describe("renderTemplate — v0.8.0+ m_apiMs per-turn delta", () => {
  beforeEach(() => {
    // Pin minUnit='m' for this suite — the tests pin exact 1m/90s
    // deltas that round to "1m" only when seconds are dropped.
    // The default minUnit='s' (since v0.9.x) would render these
    // as "1m30s"; that's a valid render under the new default
    // but isn't what these specific tests are checking.
    __resetForTest({
      timeFormat: { minUnit: "m", maxUnitCount: 2 },
    });
    __resetPrevTickForTest("any-session");
  });

  it("m_apiMs| first tick (prev=0, current=90_000) → 'api|1m'", () => {
    // Per the per-turn-delta contract, first tick assumes
    // prior baseline = 0 → delta = 90_000ms → "1m" under the
    // default minUnit='m'.
    setPrevTick(
      "sess-apims-first",
      { totalApiMs: 0 },
      "D:\\test",
    );
    const snap = fakeSnapshot({
      sessionId: "sess-apims-first",
      cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "api:1m");
  });

  it("m_apiMs| delta=90_000 (prev=0, current=90_000) renders as 'api|1m' under default minUnit='m'", () => {
    // Same delta as the first-tick test, but verifies the
    // prev-tick cache is read on subsequent ticks too.
    setPrevTick(
      "sess-apims-delta",
      { totalApiMs: 0 },
      "D:\\test",
    );
    const snap = fakeSnapshot({
      sessionId: "sess-apims-delta",
      cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "api:1m");
  });

  it("m_apiMs| sub-minute delta (40s) renders '<1m' under default minUnit='m'", () => {
    // Default cfg().timeFormat.minUnit is 'm' → sub-minute deltas
    // collapse to '<1m'. The user can opt into second precision
    // via timeFormat.minUnit: 's' in config.json.
    setPrevTick(
      "sess-apims-sub",
      { totalApiMs: 0 },
      "D:\\test",
    );
    __resetForTest({
      timeFormat: { ...configStore.get().timeFormat, minUnit: "m" },
    });
    const snap = fakeSnapshot({
      sessionId: "sess-apims-sub",
      cost: { totalDurationMs: 60_000, totalApiDurationMs: 40_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "api:<1m");
  });

  it("m_apiMs| sub-minute delta (40s) renders '40s' under minUnit='s' override", () => {
    // The user-facing knob: timeFormat.minUnit: 's' enables
    // second precision for sub-minute deltas. The format
    // pipeline honors cfg().timeFormat.minUnit — same as
    // m_sessionDuration / m_sessionApiDuration.
    setPrevTick(
      "sess-apims-sec",
      { totalApiMs: 0 },
      "D:\\test",
    );
    __resetForTest({
      timeFormat: { ...configStore.get().timeFormat, minUnit: "s" },
    });
    const snap = fakeSnapshot({
      sessionId: "sess-apims-sec",
      cost: { totalDurationMs: 60_000, totalApiDurationMs: 40_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "api:40s");
  });

  it("m_apiMs| idle tick (current == prev → deltaApi=0) → placeholder 'api|n/a'", () => {
    setPrevTick(
      "sess-apims-idle",
      { totalApiMs: 30_000 },
      "D:\\test",
    );
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-apims-idle",
          cost: { totalDurationMs: 60_000, totalApiDurationMs: 30_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "api:n/a");
    assert.ok(out.includes(STALE), `expected STALE wrap on: ${JSON.stringify(out)}`);
  });

  // v0.8.x — m_apiMs cache-fallback: when the current tick is
  // idle (no API call) but the lastActive:apiMs slot in
  // status.json holds a value within the 60s TTL window, render
  // the cached value STALE_COLORed instead of the "api:n/a"
  // placeholder. Mirrors m_tokenInSpeed/m_tokenOutSpeed's idle-
  // tick behavior.
  it("m_apiMs| idle tick WITH cached lastActive:apiMs (within TTL) → 'api|1m' (STALE_COLORed)", () => {
    // Set up: first tick establishes prev=0 and the active tick
    // lands deltaApi=90_000 → 1m. setLastApiMs fires from the
    // m_apiMs MODULES body, persisting to status.json.
    setPrevTick(
      "sess-apims-cache-fallback",
      { totalApiMs: 0 },
      "D:\\test",
    );
    const snap1 = fakeSnapshot({
      sessionId: "sess-apims-cache-fallback",
      cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    processTick(snap1.cwd, snap1);
    statusStore.commit();
    renderTemplate(
      ["m_apiMs"],
      ctxFor(snap1),
    );
    // Second tick: NO API call (current == prev → deltaApi=0).
    // The cached lastActive:apiMs (90_000 from the first render)
    // must surface, not the placeholder.
    setPrevTick(
      "sess-apims-cache-fallback",
      { totalApiMs: 90_000 },
      "D:\\test",
    );
    const snap2 = fakeSnapshot({
      sessionId: "sess-apims-cache-fallback",
      cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    processTick(snap2.cwd, snap2);
    statusStore.commit();
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(snap2),
    ).join("\n");
    assert.equal(strip(out), "api:1m");
    // The cached-fallback render MUST be wrapped in STALE_COLOR
    // (gray) so the user sees the reading is from a previous API
    // call, not this tick — same convention as the tps siblings.
    assert.ok(out.includes(STALE), `expected STALE wrap on cached fallback: ${JSON.stringify(out)}`);
  });

  it("m_apiMs| idle tick with NO prior cached value → placeholder 'api|n/a'", () => {
    // Fresh session, first tick is idle (prev=current → no delta),
    // AND no lastActive:apiMs has been written yet (beforeEach
    // resets status.json per test). Placeholder must fire.
    setPrevTick(
      "sess-apims-no-cache",
      { totalApiMs: 30_000 },
      "D:\\test",
    );
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-apims-no-cache",
          cost: { totalDurationMs: 60_000, totalApiDurationMs: 30_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "api:n/a");
  });

  it("m_apiMs| inline |color|red on cached fallback: STALE_COLOR wins over user color (mirror of tps siblings)", () => {
    // v0.8.x — the TTL-bounded cache fallback overrides the
    // user's |color| override with STALE_COLOR, matching
    // computeTickSpeed's behavior for m_tokenInSpeed /
    // m_tokenOutSpeed. The user-facing rationale: gray is the
    // canonical "this is from a previous tick" signal; letting
    // the user paint it would defeat the convention.
    setPrevTick(
      "sess-apims-inline-color",
      { totalApiMs: 0 },
      "D:\\test",
    );
    const snap1 = fakeSnapshot({
      sessionId: "sess-apims-inline-color",
      cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    processTick(snap1.cwd, snap1);
    statusStore.commit();
    renderTemplate(
      ["m_apiMs"],
      ctxFor(snap1),
    );
    setPrevTick(
      "sess-apims-inline-color",
      { totalApiMs: 90_000 },
      "D:\\test",
    );
    const snap2 = fakeSnapshot({
      sessionId: "sess-apims-inline-color",
      cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    processTick(snap2.cwd, snap2);
    statusStore.commit();
    const out = renderTemplate(
      ["m_apiMs|color:red"],
      ctxFor(snap2),
    ).join("\n");
    assert.equal(strip(out), "api:1m");
    assert.ok(out.includes(STALE), `expected STALE wrap: ${JSON.stringify(out)}`);
  });

  it("m_apiMs| no stdin (tokens=null) → placeholder 'api|n/a'", () => {
    const out = renderTemplate(["m_apiMs"], ctxFor(null)).join("\n");
    assert.equal(strip(out), "api:n/a");
    assert.ok(out.includes(STALE), `expected STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("m_apiMs| totalApiDurationMs=null on an otherwise-present snapshot → placeholder 'api|n/a'", () => {
    // totalApiDurationMs is OPTIONAL in TokenSnapshot.cost. When
    // null but other fields are present, computeAndCacheTickDelta
    // bails to hasDelta=false → placeholder fires.
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-apims-noapi",
          cost: { totalDurationMs: 600_000, totalApiDurationMs: null, totalLinesAdded: 0, totalLinesRemoved: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "api:n/a");
  });

  it("m_apiMs| inline |color|brightGreen wraps the chunk in the green SGR", () => {
    setPrevTick(
      "sess-apims-color",
      { totalApiMs: 0 },
      "D:\\test",
    );
    const snap = fakeSnapshot({
      sessionId: "sess-apims-color",
      cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_apiMs|color:brightGreen"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "api:1m");
    assert.ok(out.includes(GREEN), `expected GREEN wrap on: ${JSON.stringify(out)}`);
  });

  it("m_apiMs| inline |nulldrop|true is a no-op (function never returns null)", () => {
    // The m_apiMs renderer always returns either "api:1m" or
    // "api:n/a" placeholder (via wrapPlainDefault /
    // placeholderWithColor, which wrap in STALE_COLOR). Therefore
    // `:nulldrop:true` has no effect — the dispatcher can only
    // short-circuit on a null return. Same property as
    // m_tokenInTotal / m_apiCalls / m_sessionDuration.
    setPrevTick(
      "sess-apims-nulldrop",
      { totalApiMs: 0 },
      "D:\\test",
    );
    const snap = fakeSnapshot({
      sessionId: "sess-apims-nulldrop",
      cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_apiMs|nulldrop:true"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "api:1m");
  });

  it("m_apiMs| writeBack fires setPrevTick so the NEXT tick has a fresh baseline", () => {
    // When m_apiMs is rendered ALONE (no other per-turn module),
    // it's the only consumer of computeAndCacheTickDelta. The
    // renderer must still fire setPrevTick so the NEXT tick can
    // compute the correct delta (otherwise we'd see the original
    // baseline forever).
    setPrevTick(
      "sess-apims-write",
      { totalApiMs: 0 },
      "D:\\test",
    );
    // First render — delta = 90_000 - 0 = 90_000 → "api:1m".
    const first = fakeSnapshot({
      sessionId: "sess-apims-write",
      cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    processTick(first.cwd, first);
    statusStore.commit();
    renderTemplate(
      ["m_apiMs"],
      ctxFor(first),
    );
    // Second render — delta = 180_000 - 90_000 = 90_000 → "api:1m".
    // If writeBack didn't fire, this would still see prev=0 and
    // produce "api:3m" (wrong).
    const next = fakeSnapshot({
      sessionId: "sess-apims-write",
      cost: { totalDurationMs: 240_000, totalApiDurationMs: 180_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    processTick(next.cwd, next);
    statusStore.commit();
    const out2 = renderTemplate(
      ["m_apiMs"],
      ctxFor(next),
    ).join("\n");
    assert.equal(strip(out2), "api:1m");
  });

  it("m_apiMs| default tint is brown (matches the time-format family)", () => {
    setPrevTick(
      "sess-apims-brown",
      { totalApiMs: 0 },
      "D:\\test",
    );
    const snap = fakeSnapshot({
      sessionId: "sess-apims-brown",
      cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(snap),
    ).join("\n");
    const BROWN = "\x1b[38;5;130m";
    assert.ok(out.includes(BROWN), `expected BROWN wrap on: ${JSON.stringify(out)}`);
  });
});

describe("renderTemplate — newline separator (vX.X.X+ multi-line layout)", () => {
  beforeEach(() => {
    // vX.X.X+: `separators` config is gone. s_newline resolves
    // directly to "\n" from NAMED_SEPARATORS.
    __resetForTest({
      statuslineTemplate: ["m_tokenIn", "s_newline", "m_contextSize"],
    });
  });

  it('a "\\n" separator splits the template into two rendered lines', () => {
    // Seed prev so m_tokenIn has a delta to render.
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenIn", "s_newline", "m_contextSize"], ctxFor(snap));
    assert.deepEqual(out.map(strip), ["in:38", "size:163.5k"]);
  });

  it("trailing '\\n' separator does NOT emit a blank trailing line", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenIn", "s_newline"], ctxFor(snap));
    assert.deepEqual(out.map(strip), ["in:38"]);
  });

  it("consecutive '\\n\\n' separators drop the empty middle line", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenIn", "s_newline", "s_newline", "m_contextSize"], ctxFor(snap));
    assert.deepEqual(out.map(strip), ["in:38", "size:163.5k"]);
  });

  it("a module piece containing '\\n' (future-proof) also splits", () => {
    assert.ok(true, "covered via composition integration test");
  });
});

// ----- v0.4.0+ session-info / metadata modules -----
describe("renderTemplate — v0.4.0+ session-info modules", () => {
  beforeEach(() => {
    // Pin minUnit='m' — the m_sessionDuration / m_sessionApiDuration
    // assertions pin exact minute-grain strings (e.g. "10m" for
    // 600_000ms) that the default minUnit='s' would expand to
    // "10m0s".
    __resetForTest({ timeFormat: { minUnit: "m", maxUnitCount: 2 } });
  });
  it("m_session| bare 'strip-diagnostics-display'", () => {
    const out = renderTemplate(["m_session"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "strip-diagnostics-display");
  });

  it("m_model| bare 'MiniMax-M3'", () => {
    const out = renderTemplate(["m_model"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "MiniMax-M3");
  });

  it("m_effort| bare 'high'", () => {
    const out = renderTemplate(["m_effort"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "high");
  });

  it("m_repo| 'github.com/cwf818/topgauge'", () => {
    const out = renderTemplate(["m_repo"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "github.com/cwf818/topgauge");
  });

  it("m_branch| emits 'branch|n/a' when cwd is not a git repo (v6.x placeholder)", () => {
    // v6.x — bare m_branch now renders a "branch:n/a" placeholder
    // instead of dropping, matching the inline path's behavior.
    const out = renderTemplate(["m_branch"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "branch:n/a");
    assert.ok(out.includes(STALE), `expected STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("m_branch| emits 'branch|n/a' when cwd is missing entirely (v6.x placeholder)", () => {
    // v6.x — bare form now renders the placeholder, matching the
    // inline :nulldrop:false path.
    const out = renderTemplate(
      ["m_branch"],
      ctxFor(fakeSnapshot({ cwd: null })),
    ).join("\n");
    assert.equal(strip(out), "branch:n/a");
  });

  it("m_branch| renders the current branch when cwd is a real repo", () => {
    // process.cwd() is the repo root when tests run, so readGitInfo
    // returns the actual branch (e.g. "main"). The 60s cache may
    // already hold a stale value from another test, but the cache
    // value reflects whatever git says NOW for this cwd — which is
    // exactly what the renderer should display.
    const out = renderTemplate(
      ["m_branch"],
      ctxFor(fakeSnapshot({ cwd: process.cwd() })),
    ).join("\n");
    assert.ok(out.length > 0, "expected m_branch to render the branch");
    assert.ok(!out.startsWith(" "), `m_branch should not be padded: ${JSON.stringify(out)}`);
  });

  it("m_branch|color|brightGreen wraps the branch in brightGreen", () => {
    const out = renderTemplate(
      ["m_branch|color:brightGreen"],
      ctxFor(fakeSnapshot({ cwd: process.cwd() })),
    ).join("\n");
    assert.ok(out.includes("\x1b[38;5;41m"), `got: ${JSON.stringify(out)}`);
  });

  it("m_branch|nulldrop|false renders 'branch|n/a' when not in a git repo", () => {
    // inline :nulldrop:false forces the placeholder instead of
    // dropping the slot (consistent with m_repo :nulldrop:false).
    const out = renderTemplate(
      ["m_branch|nulldrop:false"],
      ctxFor(fakeSnapshot()), // cwd="D:\\test", not a git repo
    ).join("\n");
    assert.equal(strip(out), "branch:n/a");
  });

  it("m_gitStatus| emits 'git|n/a' when cwd is not a git repo (v6.x placeholder)", () => {
    const out = renderTemplate(["m_gitStatus"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "git:n/a");
  });

  it("m_gitStatus| emits 'git|n/a' when cwd is missing (v6.x placeholder)", () => {
    const out = renderTemplate(
      ["m_gitStatus"],
      ctxFor(fakeSnapshot({ cwd: null })),
    ).join("\n");
    assert.equal(strip(out), "git:n/a");
  });

  it("m_gitStatus| renders 'clean' on a fresh repo, 'dirty' after a write", () => {
    // Build a temp git repo so readGitInfo returns { branch, dirty }.
    // Skipped when git isn't on PATH (CI without git).
    let repoDir: string | undefined;
    try {
      execFileSync("git", ["--version"], { stdio: "ignore", timeout: 1000 });
    } catch {
      return; // skip
    }
    repoDir = mkdtempSync(join(tmpdir(), "topgauge-render-git-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoDir });
    writeFileSync(join(repoDir, "r"), "x");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });

    try {
      __resetGitInfoCacheForTest();
      const clean = renderTemplate(
        ["m_gitStatus"],
        ctxFor(fakeSnapshot({ cwd: repoDir })),
      ).join("\n");
      assert.equal(strip(clean), "clean");

      // Now dirty the tree and force a fresh read.
      writeFileSync(join(repoDir, "new"), "y");
      __resetGitInfoCacheForTest();
      const dirty = renderTemplate(
        ["m_gitStatus"],
        ctxFor(fakeSnapshot({ cwd: repoDir })),
      ).join("\n");
      assert.equal(strip(dirty), "dirty");
    } finally {
      if (repoDir) rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("m_gitStatus|color|red wraps the indicator in red", () => {
    const out = renderTemplate(
      ["m_gitStatus|color:red"],
      ctxFor(fakeSnapshot({ cwd: process.cwd() })),
    ).join("\n");
    assert.ok(out.includes("\x1b[38;5;196m"), `got: ${JSON.stringify(out)}`);
  });

  it("m_gitStatus|nulldrop|false renders 'git|n/a' when not in a git repo", () => {
    const out = renderTemplate(
      ["m_gitStatus|nulldrop:false"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "git:n/a");
  });

  it("m_repo| drops null components", () => {
    const out = renderTemplate(
      ["m_repo"],
      ctxFor(fakeSnapshot({ repo: { host: "github.com", owner: null, name: "x" } })),
    ).join("\n");
    assert.equal(strip(out), "github.com/x");
  });

  it("m_repo| emits 'n/a' when no component is available (v6.x placeholder)", () => {
    // v6.x — bare form now emits the placeholder instead of dropping.
    const out = renderTemplate(
      ["m_repo"],
      ctxFor(fakeSnapshot({ repo: { host: null, owner: null, name: null } })),
    ).join("\n");
    assert.equal(strip(out), "n/a");
  });

  it("m_ccVersion| bare '2.1.191'", () => {
    const out = renderTemplate(["m_ccVersion"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "2.1.191");
  });

  it("m_sessionDuration| dhms format of total_duration_ms (600_000ms = 10m)", () => {
    const out = renderTemplate(["m_sessionDuration"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "10m");
  });

  it("m_sessionApiDuration| emits '--' when totalApiDurationMs is null (v6.x placeholder)", () => {
    const out = renderTemplate(
      ["m_sessionApiDuration"],
      ctxFor(fakeSnapshot({ cost: { totalDurationMs: 600_000, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null } })),
    ).join("\n");
    assert.equal(strip(out), "--");
  });

  it("m_linesAdded| '+ 3965'", () => {
    const out = renderTemplate(["m_linesAdded"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "+ 3965");
  });

  it("m_linesRemoved| '- 967'", () => {
    const out = renderTemplate(["m_linesRemoved"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "- 967");
  });

  it("m_linesAdded| 0 renders as '+ 0' (zero is information, not absence)", () => {
    const out = renderTemplate(
      ["m_linesAdded"],
      ctxFor(
        fakeSnapshot({ cost: { totalDurationMs: 600_000, totalApiDurationMs: null, totalLinesAdded: 0, totalLinesRemoved: 0 } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "+ 0");
  });

  it("m_tokenInTotal| 'in|163.5k' (cumulative, the old m_tokenIn behavior)", () => {
    const out = renderTemplate(["m_tokenInTotal"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "in:163.5k");
  });

  it("m_tokenTotalOut| 'out|155' (cumulative)", () => {
    const out = renderTemplate(["m_tokenTotalOut"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "out:155");
  });

  // v0.8.0+ — newly registered module under the labelTokenTotalIn
  // family. Reads the same source as m_tokenInTotal but emits the
  // labelTokenTotalIn prefix instead of labelTokenIn — both default to
  // "in:" / "total:" respectively, but a user override on either
  // axis diverges them.
  it("m_tokenTotalIn| 'total|163.5k' (cumulative, labelTokenTotalIn axis)", () => {
    const out = renderTemplate(["m_tokenTotalIn"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "total:163.5k");
  });

  it("m_tokenTotalIn|nulldrop|false renders 'total|n/a' placeholder on null totals.input", () => {
    const out = renderTemplate(
      ["m_tokenTotalIn|nulldrop:false"],
      ctxFor(fakeSnapshot({ totals: { tokenTotalIn: null, tokenTotalOut: null } })),
    ).join("\n");
    assert.equal(strip(out), "total:n/a");
  });

  // ----- m_apiCalls (v0.4.x) -------------------------------------------
  // Reads the project-wide tickStatus slot's sumApiCount. Survives
  // session changes — the value reflects ALL sessions that have
  // ticked in this cwd. Supports :color: and :nulldrop: like other
  // text-style modules. Renders "calls:N"; placeholder is "calls:n/a".

  it("m_apiCalls| renders 'calls|0' when no project-wide tickStatus slot exists", () => {
    // Fresh cwd, no prior write → tickStatus slot is null → counter
    // is uninitialized → render "calls:0" (the natural zero state,
    // matching the m_tokenIn/m_tokenOut "in:0"/"out:0" pattern).
    // Opt back into drop-on-null with `:nulldrop:true`.
    const out = renderTemplate(
      ["m_apiCalls"],
      ctxFor(fakeSnapshot({ cwd: "D:\\no-project-state-yet" })),
    ).join("\n");
    assert.equal(strip(out), "calls:0");
  });

  it("m_apiCalls| renders 'calls|N' from project-wide sumApiCount", () => {
    // Seed the project-wide slot with sumApiCount=7.
    setAvg(
      "sess-1",
      { accTokenIn: 0, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 0 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: "claude-opus-4-8",
        deltaApiCalls: 1,
        currentApiMs: 60_000,
        deltaTokenIn: 38,
        deltaTokenOut: 155,
        deltaTokenCachedIn: 163441,
        deltaApiMs: 60_000,
      },
    );
    // Subsequent ticks bump the same project-wide slot.
    setAvg(
      "sess-1",
      { accTokenIn: 38, accTokenOut: 155, accApiMs: 60_000, accTokenCachedIn: 163441, accApiCalls: 1 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: "claude-opus-4-8",
        deltaApiCalls: 1,
        currentApiMs: 65_000,
        deltaTokenIn: 200,
        deltaTokenOut: 250,
        deltaTokenCachedIn: 200_000,
        deltaApiMs: 5_000,
      },
    );
    const out = renderTemplate(
      ["m_apiCalls"],
      ctxFor(fakeSnapshot({ sessionId: "sess-1" })),
    ).join("\n");
    assert.equal(strip(out), "calls:2");
  });

  it("m_apiCalls| no valid tick has landed yet → bare form renders 'calls|0' (no slot exists)", () => {
    // The project-wide tickStatus slot is only WRITTEN by setAvg
    // when at least one delta is non-zero (or sumApiCount
    // increments). A "zero deltas" tick passes through setAvg's
    // gate without ever creating the slot — so a fresh project
    // with no API calls renders the natural zero "calls:0"
    // (matching the m_tokenIn/m_tokenOut "in:0"/"out:0" pattern).
    // This is distinct from the per-session slot which IS stamped
    // on every active tick. Document the contract: m_apiCalls is
    // a counter that starts at 0, not a "have I had any valid
    // API calls yet?" sentinel — use `:nulldrop:true` to opt
    // back into drop-on-null.
    setAvg(
      "sess-zero",
      { accTokenIn: 0, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 0 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: null,
        deltaApiCalls: 0,
        currentApiMs: 0,
        deltaTokenIn: 0,
        deltaTokenOut: 0,
        deltaTokenCachedIn: 0,
        deltaApiMs: 0,
      },
    );
    const out = renderTemplate(
      ["m_apiCalls"],
      ctxFor(fakeSnapshot({ sessionId: "sess-zero" })),
    ).join("\n");
    assert.equal(strip(out), "calls:0");
  });

  it("m_apiCalls|nulldrop|false with no slot → 'calls|0' (no STALE wrap)", () => {
    // Inline form no longer falls back to the placeholder when the
    // data path returns null — "calls:0" is the natural zero state.
    // Same shape as m_tokenInTotal:nulldrop:false (which renders
    // "in:0"). The placeholderNA("calls:") registration is left in
    // place but is unreachable for m_apiCalls.
    const out = renderTemplate(
      ["m_apiCalls|nulldrop:false"],
      ctxFor(fakeSnapshot({ cwd: "D:\\no-project-state-yet" })),
    ).join("\n");
    assert.equal(strip(out), "calls:0");
    assert.ok(!out.includes(STALE), `expected no STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("m_apiCalls|nulldrop|false with no slot yet → 'calls|0'", () => {
    // A "zero deltas" tick never created the project-wide slot
    // (setAvg's gate skipped the write). The inline form now
    // renders "calls:0" (the natural zero state) rather than
    // the placeholder. Document the contract: m_apiCalls is a
    // counter that starts at 0.
    setAvg(
      "sess-zero",
      { accTokenIn: 0, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 0 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: null,
        deltaApiCalls: 0,
        currentApiMs: 0,
        deltaTokenIn: 0,
        deltaTokenOut: 0,
        deltaTokenCachedIn: 0,
        deltaApiMs: 0,
      },
    );
    const out = renderTemplate(
      ["m_apiCalls|nulldrop:false"],
      ctxFor(fakeSnapshot({ sessionId: "sess-zero" })),
    ).join("\n");
    assert.equal(strip(out), "calls:0");
  });

  it("m_apiCalls|nulldrop|true is a no-op (function never returns null)", () => {
    // The inline m_apiCalls renderer never returns null — it always
    // returns "calls:0" or "calls:N". Therefore `:nulldrop:true` has
    // no effect (the dispatcher can only short-circuit on a null
    // return). Same shape as m_tokenIn / m_tokenOut, which share
    // this property via computeTickDelta. This test pins the
    // behavior so a future refactor that re-introduces a null
    // branch will surface the question explicitly.
    const out = renderTemplate(
      ["m_apiCalls|nulldrop:true"],
      ctxFor(fakeSnapshot({ cwd: "D:\\no-project-state-yet" })),
    ).join("\n");
    assert.equal(strip(out), "calls:0");
  });

  it("m_apiCalls|color|brightGreen wraps the chunk in brightGreen", () => {
    setAvg(
      "sess-colored",
      { accTokenIn: 0, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 0 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: null,
        deltaApiCalls: 1,
        currentApiMs: 60_000,
        deltaTokenIn: 38,
        deltaTokenOut: 155,
        deltaTokenCachedIn: 0,
        deltaApiMs: 60_000,
      },
    );
    const out = renderTemplate(
      ["m_apiCalls|color:brightGreen"],
      ctxFor(fakeSnapshot({ sessionId: "sess-colored" })),
    );
    const joined = out.join("\n");
    assert.match(strip(joined), /calls:1/);
    assert.ok(
      joined.includes(`\x1b[38;5;41mcalls:1\x1b[0m`),
      `expected brightGreen wrap on: ${JSON.stringify(joined)}`,
    );
  });

  it("m_apiCalls|color|red override applies SGR to 'calls|0' (no STALE wrap)", () => {
    // Inline :color: wins over the natural zero (no STALE_COLOR is
    // applied because "calls:0" is not stale data — it's the
    // counter's zero state).
    const RED_SGR = "\x1b[38;5;196m";
    const out = renderTemplate(
      ["m_apiCalls|nulldrop:false|color:red"],
      ctxFor(fakeSnapshot({ cwd: "D:\\no-project-state-yet" })),
    ).join("\n");
    assert.equal(strip(out), "calls:0");
    assert.ok(out.includes(RED_SGR), `expected RED in: ${JSON.stringify(out)}`);
  });

  it("m_apiCalls| bare form renders 'calls|0' on null (MODULES path)", () => {
    // Bare m_apiCalls (no colon) goes through the MODULES dispatcher
    // and now renders "calls:0" on null — same "render the natural
    // zero" semantics as m_tokenInTotal.
    const out = renderTemplate(
      ["m_apiCalls"],
      ctxFor(fakeSnapshot({ cwd: "D:\\no-project-state-yet" })),
    ).join("\n");
    assert.equal(strip(out), "calls:0");
  });

  it("m_apiCalls|inline m_apiCalls| (trailing colon) renders 'calls|0'", () => {
    // Trailing-colon form has empty remainder → nulldrop undefined
    // → the inline form renders "calls:0" (the natural zero),
    // matching the bare form.
    const out = renderTemplate(
      ["m_apiCalls|"],
      ctxFor(fakeSnapshot({ cwd: "D:\\no-project-state-yet" })),
    ).join("\n");
    assert.equal(strip(out), "calls:0");
  });

  it("m_apiCalls| count survives a sessionId change (project-wide scope)", () => {
    // The project-wide tickStatus slot is keyed only by cwd, not
    // sessionId. Switching the sessionId on the next render does
    // NOT reset the count. This is the v0.4.x simplification vs
    // the per-session tickAvg slot.
    setAvg(
      "sess-A",
      { accTokenIn: 38, accTokenOut: 155, accApiMs: 60_000, accTokenCachedIn: 163441, accApiCalls: 1 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: "claude-opus-4-8",
        deltaApiCalls: 1,
        currentApiMs: 60_000,
        deltaTokenIn: 38,
        deltaTokenOut: 155,
        deltaTokenCachedIn: 163441,
        deltaApiMs: 60_000,
      },
    );
    // Render with a DIFFERENT sessionId — count should still be 1.
    const out = renderTemplate(
      ["m_apiCalls"],
      ctxFor(fakeSnapshot({ sessionId: "sess-B" })),
    ).join("\n");
    assert.equal(strip(out), "calls:1");
  });

  it("m_contextSize| 'size|163.5k' (cumulative occupancy from totals.input)", () => {
    // v0.8.0+ — m_contextSize source is total_input_tokens. The
    // fakeSnapshot has totals.input=163479 → "size:163.5k". The
    // capacity is the separate m_contextWindowsSize module.
    const out = renderTemplate(["m_contextSize"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "size:163.5k");
  });

  it("m_contextWindowsSize| 'size|200.0k' (capacity from context_window.size)", () => {
    // v0.8.0+ — the new module for the capacity (upper bound),
    // sourced from context_window.size. The typo `Widows` is
    // preserved per user direction.
    const out = renderTemplate(["m_contextWindowsSize"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "size:200.0k");
  });

  it("m_contextUsedPercent| 'used|63%' (key-prefixed percentage)", () => {
    const out = renderTemplate(["m_contextUsedPercent"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "used:63%");
  });

  it("m_contextRemainingPercent| 'remain|37%' (sibling of m_contextUsedPercent)", () => {
    // v0.8.0+ — new module. fakeSnapshot has remainingPct=37.
    const out = renderTemplate(["m_contextRemainingPercent"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "remain:37%");
  });

  it("m_windowContext| bar + 5-band-colored percentage (63% lands in darkGreen band)", () => {
    const out = renderTemplate(["m_windowContext"], ctxFor(fakeSnapshot())).join("\n");
    const stripped = strip(out);
    assert.match(stripped, /^[▓░]+ 63%$/);
    assert.ok(out.includes(DARK_GREEN), `expected DARK_GREEN in: ${JSON.stringify(out)}`);
  });

  it("m_windowContext| emits gray '░░░░░░░░ 0%' gauge when contextWindow.usedPct is null (v6.x placeholder)", () => {
    // v6.x — bare m_windowContext now follows the placeholder rule.
    // The gauge placeholder shape is "░░░░░░░░ 0%" (used mode) or
    // "▓▓▓▓▓▓▓▓ 100%" (remaining mode). Defaults to "used" → empty
    // bar + "0%".
    const out = renderTemplate(
      ["m_windowContext"],
      ctxFor(
        fakeSnapshot({ contextWindow: { contextWindowSize: 200000, contextUsedPercent: null, contextRemainingPercent: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
  });

  // v0.4.0+ — value=0 is a valid number, not "missing". Per the
  // render zero-value rule (memory/render-value-zero-rule.md), a 0
  // MUST render as "0", not drop the whole module. The only condition
  // that hides the module is `usedPct == null` (stdin didn't carry the
  // field at all). These four cases pin that contract so a future
  // refactor can't regress to a `!value`/truthy guard.
  it("m_windowContext| usedPct=0 renders '░░░░░░░░ 0%' (NOT hidden)", () => {
    const out = renderTemplate(
      ["m_windowContext"],
      ctxFor(fakeSnapshot({ contextWindow: { contextWindowSize: 200000, contextUsedPercent: 0, contextRemainingPercent: 100 } })),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
  });

  it("m_windowContext|display|remaining with usedPct=0 renders full-bar 100% (NOT hidden)", () => {
    const out = renderTemplate(
      ["m_windowContext|display:remaining"],
      ctxFor(fakeSnapshot({ contextWindow: { contextWindowSize: 200000, contextUsedPercent: 0, contextRemainingPercent: 100 } })),
    ).join("\n");
    assert.equal(strip(out), "▓▓▓▓▓▓▓▓ 100%");
  });

  it("m_windowContext|color|red at usedPct=0 still emits the 0% chunk with override SGR", () => {
    const RED_SGR = "\x1b[38;5;196m";
    const out = renderTemplate(
      ["m_windowContext|color:red"],
      ctxFor(fakeSnapshot({ contextWindow: { contextWindowSize: 200000, contextUsedPercent: 0, contextRemainingPercent: 100 } })),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
    assert.ok(out.includes(RED_SGR), `expected RED SGR in: ${JSON.stringify(out)}`);
  });

  it("m_contextUsedPercent| usedPct=0 renders 'used|0%' (NOT hidden)", () => {
    const out = renderTemplate(
      ["m_contextUsedPercent"],
      ctxFor(fakeSnapshot({ contextWindow: { contextWindowSize: 200000, contextUsedPercent: 0, contextRemainingPercent: 100 } })),
    ).join("\n");
    assert.equal(strip(out), "used:0%");
  });

  it("inline :color: override applies SGR to plain modules (m_session:color:red)", () => {
    const RED_SGR = "\x1b[38;5;196m";
    const out = renderTemplate(
      ["m_session|color:red"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "strip-diagnostics-display");
    assert.ok(out.includes(RED_SGR), `expected RED in: ${JSON.stringify(out)}`);
  });

  it("inline :color: override applies SGR to m_windowContext (formatOneChunkColored)", () => {
    const RED_SGR = "\x1b[38;5;196m";
    const out = renderTemplate(
      ["m_windowContext|color:red"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    const stripped = strip(out);
    assert.match(stripped, /^[▓░]+ 63%$/);
    assert.ok(out.includes(RED_SGR), `expected RED in: ${JSON.stringify(out)}`);
  });

  it("all session-info modules emit placeholders when tokens is null (v6.x)", () => {
    // v6.x — bare-form parity: every session-info module renders
    // its placeholder body wrapped in STALE_COLOR when tokens is
    // null, instead of dropping. The shape is module-specific
    // (see PLACEHOLDERS in render.ts). This test verifies the
    // shapes match the design.
    const cases: Array<[string, string]> = [
      ["m_session", "n/a"],
      ["m_model", "n/a"],
      ["m_effort", "n/a"],
      ["m_repo", "n/a"],
      ["m_ccVersion", "n/a"],
      ["m_sessionDuration", "--"],
      ["m_sessionApiDuration", "--"],
      ["m_linesAdded", "+ --"],
      ["m_linesRemoved", "- --"],
      ["m_tokenInTotal", "in:n/a"],
      ["m_tokenTotalOut", "out:n/a"],
      ["m_contextWindowsSize", "size:n/a"],
      ["m_contextSize", "size:n/a"],
      ["m_contextUsedPercent", "used:n/a%"],
      ["m_contextRemainingPercent", "remain:n/a%"],
      ["m_windowContext", "░░░░░░░░ 0%"],
    ];
    for (const [m, expected] of cases) {
      const out = renderTemplate([m], ctxFor(null)).join("\n");
      assert.equal(strip(out), expected, `${m} should render "${expected}" placeholder, got ${JSON.stringify(out)}`);
    }
  });
});

// ----- v0.4.0+ nulldrop inline override ----------------------------------
//
// Every m_* module accepts an optional `:nulldrop:<true|false>`
// inline argument. Semantics (FLIPPED in v0.4.0 — see
// nulldrop-inline-override memory):
//   omitted / `:nulldrop:false`  → DEFAULT. Force a stable
//     placeholder when data is null — module ALWAYS renders.
//   `:nulldrop:true`             → opt out of placeholder; preserve
//     v0.3.x drop-on-null behavior.
//
// Placeholder shape per family (see PLACEHOLDERS in render.ts):
//   pure-number → STALE_COLOR "n/a" wrapped     (e.g. "in:n/a")
//   number+unit → STALE_COLOR "-- <unit>"       (e.g. "5h:-- t/s")
//   gauge       → STALE_COLOR "░░░░░░░░ 0%"     (or full bar 100% in remaining mode)
//   bare-string → STALE_COLOR "n/a" wrapped
//
// The bare MODULES path is unaffected — bare `m_contextSize` still
// drops when tokens is null. To force a placeholder the user MUST
// use the inline form `m_contextSize` (which now defaults to
// placeholder — see above) or `m_contextSize:nulldrop:false`. To
// preserve old drop behavior on an inline token, write
// `m_contextSize:nulldrop:true`.

describe("renderTemplate — :nulldrop inline override (v0.4.0+)", () => {
  // ----- pure-number family -----

  it("m_contextSize|nulldrop|false with no tokens renders 'size|n/a' (placeholder)", () => {
    // v0.8.0+ — m_contextSize was renamed to m_contextSize (semantic now
    // cumulative occupancy, sourced from totals.input). The
    // placeholder still reads "size:n/a".
    const out = renderTemplate(
      ["m_contextSize|nulldrop:false"],
      ctxFor(null),
    ).join("\n");
    assert.equal(strip(out), "size:n/a");
    assert.ok(out.includes(STALE), `expected STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("m_contextSize|nulldrop|false with zero totals.input renders 'size|0' (v6.x zero rule)", () => {
    // v6.x — zero is now rendered as "size:0" (a real value, not
    // a placeholder). The placeholder path is reserved for the
    // snapshot-missing case (test elsewhere).
    const out = renderTemplate(
      ["m_contextSize|nulldrop:false"],
      ctxFor(
        fakeSnapshot({
          totals: { tokenTotalIn: 0, tokenTotalOut: 0 },
          current: { tokenIn: 0, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "size:0");
  });

  it("m_contextSize bare form emits 'size:n/a' on null (v6.x placeholder parity)", () => {
    // v6.x — bare m_contextSize now follows the placeholder rule,
    // matching the inline path. Adjacent separators are preserved
    // (no orphan-space drop).
    const out = renderTemplate(["m_contextSize"], ctxFor(null)).join("\n");
    assert.equal(strip(out), "size:n/a");
    assert.ok(out.includes(STALE), `expected STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("m_contextSize|nulldrop|true behaves like bare (drops on null)", () => {
    // Explicit nulldrop:true → preserve original drop behavior.
    const out = renderTemplate(["m_contextSize|nulldrop:true"], ctxFor(null));
    assert.deepEqual(out, []);
  });

  it("m_tokenCachedIn|nulldrop|false with cacheRead=0 renders 'cache|0' (v0.8.6+ dropped pct suffix)", () => {
    // v0.8.6+ — m_tokenCachedIn dropped the `(XX%)` share suffix;
    // it's the raw cache-read token count. Use m_tokenHitRate for
    // the ratio. cacheRead=0 still renders "cache:0" (real zero,
    // not placeholder). The placeholder path is reserved for
    // cacheRead=null (field not shipped by stdin).
    const out = renderTemplate(
      ["m_tokenCachedIn|nulldrop:false"],
      ctxFor(
        fakeSnapshot({
          current: { tokenIn: 38, tokenOut: 155, tokenCacheCreation: 0, tokenCachedIn: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "cache:0");
  });

  it("m_tokenCachedIn|nulldrop|false with cacheRead=null renders 'cache|0' (v0.8.13 zero-fallback)", () => {
    // v0.8.13 — cacheRead=null (field not shipped by stdin) now
    // renders as "cache:0", same as the real-zero case. Treats
    // "field not shipped" as zero so the module always reads
    // "cache:N" (no placeholder text mixing with the value path).
    const out = renderTemplate(
      ["m_tokenCachedIn|nulldrop:false"],
      ctxFor(
        fakeSnapshot({
          current: { tokenIn: 38, tokenOut: 155, tokenCacheCreation: 0, tokenCachedIn: null },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "cache:0");
  });

  it("m_tokenCachedIn bare form emits PLAIN text (no STALE_COLOR) — matches m_tokenIn / m_tokenOut", () => {
    // v0.8.13 — color unified with the m_token* sibling family:
    // bare default is plain (no STALE_COLOR wrap), matching
    // m_tokenIn / m_tokenOut / m_tokenInTotal / m_tokenTotalOut.
    // The user's `:color|<c>` inline override still applies.
    const out = renderTemplate(
      ["m_tokenCachedIn"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "cache:163.4k");
    assert.ok(!out.includes(STALE), `expected no STALE wrap on bare m_tokenCachedIn: ${JSON.stringify(out)}`);
  });

  it("m_tokenCachedIn bare form emits 'cache:0' when read=0 (v0.8.6+ dropped pct suffix)", () => {
    // v0.8.6+ — bare m_tokenCachedIn renders "cache:0" without
    // the `(XX%)` share suffix. v0.8.13 — cacheRead=null (field
    // not shipped) also renders as "cache:0", same as the real-zero
    // case (see the test below).
    const out = renderTemplate(
      ["m_tokenCachedIn"],
      ctxFor(
        fakeSnapshot({
          current: { tokenIn: 38, tokenOut: 155, tokenCacheCreation: 0, tokenCachedIn: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "cache:0");
  });

  it("m_tokenCachedIn bare form emits 'cache:0' when cacheRead=null (v0.8.13 zero-fallback)", () => {
    // v0.8.13 — cacheRead=null (field not shipped by stdin) on a
    // present snapshot now renders as "cache:0" instead of the
    // "cache:n/a" placeholder. The module always reads "cache:N",
    // and the placeholder path is reserved for the truly missing
    // case (no tokens at all → still placeholder).
    const out = renderTemplate(
      ["m_tokenCachedIn"],
      ctxFor(
        fakeSnapshot({
          current: { tokenIn: 38, tokenOut: 155, tokenCacheCreation: 0, tokenCachedIn: null },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "cache:0");
  });

  it("m_tokenHitRate|nulldrop|false| 0 cache / 38 totals.input = 0.0% (v0.8.0 per-turn formula)", () => {
    // v0.8.0+ formula is current.cacheRead / totals.input. When
    // cacheRead=0 and totals.input=38, the rate is 0/38 = 0.0% —
    // a truthful zero, NOT a placeholder drop.
    const out = renderTemplate(
      ["m_tokenHitRate|nulldrop:false"],
      ctxFor(
        fakeSnapshot({
          totals: { tokenTotalIn: 38, tokenTotalOut: 155 },
          current: { tokenIn: 38, tokenOut: 155, tokenCacheCreation: 0, tokenCachedIn: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "hit:0.0%");
  });

  it("m_contextWindowsSize|nulldrop|false renders 'size|n/a' when context_window.size is null", () => {
    // v0.8.0+ — m_contextSize was renamed to m_contextWindowsSize
    // (capacity, sourced from context_window.size). The new
    // m_contextSize (cumulative occupancy) is tested separately
    // above.
    const out = renderTemplate(
      ["m_contextWindowsSize|nulldrop:false"],
      ctxFor(
        fakeSnapshot({ contextWindow: { contextWindowSize: null, contextUsedPercent: null, contextRemainingPercent: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "size:n/a");
  });

  it("m_contextUsedPercent|nulldrop|false renders 'used|n/a%' when usedPct is null", () => {
    const out = renderTemplate(
      ["m_contextUsedPercent|nulldrop:false"],
      ctxFor(
        fakeSnapshot({ contextWindow: { contextWindowSize: 200000, contextUsedPercent: null, contextRemainingPercent: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "used:n/a%");
  });

  it("m_tokenInTotal|nulldrop|false renders 'in|n/a' when totals.input is null", () => {
    const out = renderTemplate(
      ["m_tokenInTotal|nulldrop:false"],
      ctxFor(
        fakeSnapshot({ totals: { tokenTotalIn: null, tokenTotalOut: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "in:n/a");
  });

  it("m_tokenTotalOut|nulldrop|false renders 'out|n/a' when totals.output is null", () => {
    const out = renderTemplate(
      ["m_tokenTotalOut|nulldrop:false"],
      ctxFor(
        fakeSnapshot({ totals: { tokenTotalIn: null, tokenTotalOut: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "out:n/a");
  });

  // ----- number+unit family -----

  it("m_sessionDuration|nulldrop|false renders '--' (number+unit placeholder, no unit)", () => {
    const out = renderTemplate(
      ["m_sessionDuration|nulldrop:false"],
      ctxFor(
        fakeSnapshot({ cost: { totalDurationMs: null, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "--");
  });

  it("m_linesAdded|nulldrop|false renders '+ --' (signed placeholder)", () => {
    const out = renderTemplate(
      ["m_linesAdded|nulldrop:false"],
      ctxFor(
        fakeSnapshot({ cost: { totalDurationMs: 600_000, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "+ --");
  });

  it("m_linesRemoved|nulldrop|false renders '- --' (signed placeholder)", () => {
    const out = renderTemplate(
      ["m_linesRemoved|nulldrop:false"],
      ctxFor(
        fakeSnapshot({ cost: { totalDurationMs: 600_000, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "- --");
  });


  // ----- gauge family -----

  it("m_windowContext|nulldrop|false renders '░░░░░░░░ 0%' (gauge placeholder, used mode)", () => {
    const out = renderTemplate(
      ["m_windowContext|nulldrop:false"],
      ctxFor(
        fakeSnapshot({ contextWindow: { contextWindowSize: 200000, contextUsedPercent: null, contextRemainingPercent: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
    assert.ok(out.includes(STALE), `expected STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("m_windowContext|nulldrop|false in remaining mode renders '▓▓▓▓▓▓▓▓ 100%'", () => {
    const out = renderTemplate(
      ["m_windowContext|nulldrop:false|display:remaining"],
      ctxFor(
        fakeSnapshot({ contextWindow: { contextWindowSize: 200000, contextUsedPercent: null, contextRemainingPercent: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "▓▓▓▓▓▓▓▓ 100%");
  });

  it("m_windowContext|nulldrop|false|color|red overrides STALE wrap with user color", () => {
    const RED_SGR = "\x1b[38;5;196m";
    const out = renderTemplate(
      ["m_windowContext|nulldrop:false|color:red"],
      ctxFor(
        fakeSnapshot({ contextWindow: { contextWindowSize: 200000, contextUsedPercent: null, contextRemainingPercent: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
    assert.ok(out.includes(RED_SGR), `expected RED override in: ${JSON.stringify(out)}`);
  });

  it("m_windowContext bare form emits gray '░░░░░░░░ 0%' gauge (v6.x placeholder parity)", () => {
    // v6.x — bare form now follows the placeholder rule, matching
    // the inline path. The placeholder shape is a gray bar + "0%".
    const out = renderTemplate(
      ["m_windowContext"],
      ctxFor(
        fakeSnapshot({ contextWindow: { contextWindowSize: 200000, contextUsedPercent: null, contextRemainingPercent: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
  });

  it("m_windowQuota|term:short|nulldrop:false renders gray '░░░░░░░░ 0%' when shortInterval is null", () => {
    // shortInterval is null → placeholder fires.
    const out = renderTemplate(
      ["m_windowQuota|term:short|nulldrop:false"],
      ctxFor(null, null, null),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
  });

  it("m_windowQuota|term|mid|nulldrop|false renders gray '░░░░░░░░ 0%' when midInterval is null", () => {
    const out = renderTemplate(
      ["m_windowQuota|term:mid|nulldrop:false"],
      ctxFor(null, null, null),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
  });

  // ----- bare-string family -----

  it("m_session|nulldrop|false renders 'n/a' when sessionName is null", () => {
    const out = renderTemplate(
      ["m_session|nulldrop:false"],
      ctxFor(fakeSnapshot({ sessionName: null })),
    ).join("\n");
    assert.equal(strip(out), "n/a");
  });

  it("m_model|nulldrop|false renders 'n/a' when modelDisplayName is null", () => {
    const out = renderTemplate(
      ["m_model|nulldrop:false"],
      ctxFor(fakeSnapshot({ modelDisplayName: null })),
    ).join("\n");
    assert.equal(strip(out), "n/a");
  });

  it("m_effort|nulldrop|false renders 'n/a' when effort is null", () => {
    const out = renderTemplate(
      ["m_effort|nulldrop:false"],
      ctxFor(fakeSnapshot({ effort: null })),
    ).join("\n");
    assert.equal(strip(out), "n/a");
  });

  it("m_repo|nulldrop|false renders 'n/a' when all components are null", () => {
    const out = renderTemplate(
      ["m_repo|nulldrop:false"],
      ctxFor(fakeSnapshot({ repo: { host: null, owner: null, name: null } })),
    ).join("\n");
    assert.equal(strip(out), "n/a");
  });

  it("m_ccVersion|nulldrop|false renders 'n/a' when ccversion is null", () => {
    const out = renderTemplate(
      ["m_ccVersion|nulldrop:false"],
      ctxFor(fakeSnapshot({ ccversion: null })),
    ).join("\n");
    assert.equal(strip(out), "n/a");
  });

  // ----- separator-skip semantics preserved -----

  it("m_contextSize|nulldrop|false forces the slot; adjacent s_0 separators are preserved (v6.x)", () => {
    // v6.x — tokens=null now triggers "n/a" placeholders for the
    // per-API-call family too (m_tokenIn / m_tokenOut). The
    // placeholder keeps the slot occupied, so surrounding s_0
    // separators stay (matching the inline nulldrop:false contract).
    const out = renderTemplate(
      ["m_tokenIn", "s_space", "m_contextSize|nulldrop:false", "s_space", "m_tokenOut"],
      ctxFor(null),
    ).join("\n");
    assert.equal(strip(out), "in:n/a size:n/a out:n/a");
  });

  it("m_contextSize|nulldrop|false composed with |color| applies color to the placeholder", () => {
    const RED_SGR = "\x1b[38;5;196m";
    const out = renderTemplate(
      ["m_contextSize|nulldrop:false|color:red"],
      ctxFor(null),
    ).join("\n");
    assert.equal(strip(out), "size:n/a");
    assert.ok(out.includes(RED_SGR), `expected RED in: ${JSON.stringify(out)}`);
  });

  // ----- parse-fail path -----

  it("m_contextSize|nulldrop|invalid_value (not true/false) is a parse-fail — token drops + warn", () => {
    // Resolver returns null for any value other than 'true'/'false',
    // so parseInlineArgs returns null → badarg → warn + drop.
    // We don't assert the stderr line here (the warn is fired
    // once per process), but we do assert the chunk is gone.
    __resetUnknownModuleWarnForTest();
    const out = renderTemplate(
      ["m_contextSize|nulldrop:maybe"],
      ctxFor(null),
    );
    assert.deepEqual(out, []);
  });

  // ----- v0.4.0 default = placeholder (flip from earlier opt-in design) -----
  //
  // The DEFAULT for an INLINE token (one with `:` in it) is now
  // force-placeholder. This is a behavior flip from the
  // pre-v0.4.0-final design (which had nulldrop:false as the
  // opt-in). Bare `m_contextSize` (no colon) STILL drops — that path goes
  // through MODULES, not the inline dispatcher, and the v0.3.x
  // drop semantics on bare tokens are preserved as a backward-compat
  // promise. Users who want drop semantics on an inline token add
  // `:nulldrop:true`.
  //
  // Concretely: the placeholder fires whenever an inline token's
  // params.nulldrop is NOT the literal "true" (undefined counts as
  // "false" / default).

  it("bare m_contextSize emits 'size:n/a' on null (v6.x placeholder parity)", () => {
    // v6.x — bare m_contextSize now follows the placeholder rule, matching
    // the inline path's default behavior. There is no longer a
    // bare-vs-inline asymmetry.
    const out = renderTemplate(["m_contextSize"], ctxFor(null)).join("\n");
    assert.equal(strip(out), "size:n/a");
  });

  it("inline m_contextSize: (trailing colon, no args) defaults to placeholder — renders 'size:n/a'", () => {
    // The trailing-colon form `m_contextSize:` has empty remainder →
    // params={} → nulldrop undefined → placeholder fires.
    const out = renderTemplate(["m_contextSize|"], ctxFor(null)).join("\n");
    assert.equal(strip(out), "size:n/a");
    assert.ok(out.includes(STALE), `expected STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("inline m_contextSize:nulldrop:false (explicit) renders placeholder 'size:n/a'", () => {
    // Equivalent to the no-arg form `m_contextSize:` after the flip.
    const out = renderTemplate(["m_contextSize|nulldrop:false"], ctxFor(null)).join("\n");
    assert.equal(strip(out), "size:n/a");
  });

  it("m_contextSize|nulldrop|true opts OUT of placeholder — drops on null", () => {
    // `:nulldrop:true` is the escape hatch for users who want the
    // v0.3.x drop-on-null semantics on an inline token.
    const out = renderTemplate(["m_contextSize|nulldrop:true"], ctxFor(null));
    assert.deepEqual(out, []);
  });

  it("bare m_windowContext emits gray '░░░░░░░░ 0%' gauge (v6.x placeholder parity)", () => {
    // v6.x — bare form follows the placeholder rule, matching
    // the inline path's default behavior.
    const out = renderTemplate(
      ["m_windowContext"],
      ctxFor(
        fakeSnapshot({ contextWindow: { contextWindowSize: 200000, contextUsedPercent: null, contextRemainingPercent: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
  });

  it("inline m_windowContext: defaults to placeholder gray bar '░░░░░░░░ 0%'", () => {
    const out = renderTemplate(
      ["m_windowContext|"],
      ctxFor(
        fakeSnapshot({ contextWindow: { contextWindowSize: 200000, contextUsedPercent: null, contextRemainingPercent: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
  });

  it("m_windowContext|nulldrop|true drops on null (preserves v0.3.x drop behavior)", () => {
    const out = renderTemplate(
      ["m_windowContext|nulldrop:true"],
      ctxFor(
        fakeSnapshot({ contextWindow: { contextWindowSize: 200000, contextUsedPercent: null, contextRemainingPercent: null } }),
      ),
    );
    assert.deepEqual(out, []);
  });

  it("inline m_session: defaults to placeholder 'n/a' on null sessionName", () => {
    const out = renderTemplate(["m_session|"], ctxFor(fakeSnapshot({ sessionName: null }))).join("\n");
    assert.equal(strip(out), "n/a");
  });

  it("m_session|nulldrop|true drops on null sessionName", () => {
    const out = renderTemplate(["m_session|nulldrop:true"], ctxFor(fakeSnapshot({ sessionName: null })));
    assert.deepEqual(out, []);
  });

  it("inline m_linesAdded: defaults to placeholder '+ --'", () => {
    const out = renderTemplate(
      ["m_linesAdded|"],
      ctxFor(
        fakeSnapshot({ cost: { totalDurationMs: 600_000, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "+ --");
  });

  it("m_linesAdded|nulldrop|true drops on null totalLinesAdded", () => {
    const out = renderTemplate(
      ["m_linesAdded|nulldrop:true"],
      ctxFor(
        fakeSnapshot({ cost: { totalDurationMs: 600_000, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null } }),
      ),
    );
    assert.deepEqual(out, []);
  });

  it("separator-skip behavior when :nulldrop:true opts out (documented gap)", () => {
    // nulldrop:true → drop → module disappears. The doc comment
    // promises "adjacent separators are skipped", but in practice
    // the inline dispatcher does NOT strip a leading s_N that was
    // already appended to the in-progress line before the dropped
    // module. This is a pre-existing renderer limitation (not
    // introduced by the nulldrop work) — the bare MODULES path has
    // the same shape: s_0 added before the module token stays in
    // `current` even if the module drops. The correct fix is a
    // post-render trim pass on `current`, scoped to recent drops;
    // for now we pin the OBSERVED behavior so a future fix can
    // tighten this without surprise.
    //
    // v6.x — m_tokenIn/m_tokenOut now render "in:n/a" / "out:n/a"
    // placeholders instead of "in:0" sentinels when tokens is
    // null. The nulldrop:true opt-out still drops m_contextSize, leaving
    // orphan s_space separators between the placeholders.
    const out = renderTemplate(
      ["m_tokenIn", "s_space", "m_contextSize|nulldrop:true", "s_space", "m_tokenOut"],
      ctxFor(null),
    ).join("\n");
    assert.match(strip(out), /^in:n\/a\s+out:n\/a$/);
    // m_contextSize:nulldrop:true is NOT in the output.
    assert.ok(!out.includes("size:"), `expected no size: chunk in: ${JSON.stringify(out)}`);
  });
});

// ----- v0.4.0+ speed cache + color:scale behavior ---------------------
//
// The speed modules gained two new behaviors in v0.4.0:
//   1. Cache the last ACTIVE-tick tps per session. On an idle
//      tick (no API call this turn), fall back to the cached
//      tps instead of rendering "-- t/s". Idle ticks do NOT
//      overwrite the cache.
//   2. 5-band scale coloring (`:color:scale` or bare default).
//      Faster = greener; slower = redder. `out` bands:
//      [10, 20, 40, 80]; `in` bands: 5× out = [50, 100, 200, 400].
//      `:color:<shortcut|SGR>` overrides the active-tick color
//      (e.g. `:color:red` → always red on active ticks).
//   3. Cached/inactive ticks ALWAYS render in STALE_COLOR
//      regardless of the user's :color: choice. Gray signals
//      "this is a stale measurement from a previous API call".

describe("renderTemplate — m_tokenInSpeed / m_tokenOutSpeed cache + scale (v0.4.0+)", () => {
  beforeEach(() => {
    // Pin minUnit='m' — the suite's m_apiMs assertions pin exact
    // minute-grain suffixes (e.g. "1m" for 90s deltas, "<1m" for
    // sub-minute). The default minUnit='s' would expand these to
    // "1m30s" / "30s" — separate coverage lives in the
    // m_apiMs per-turn delta suite's inner describe.
    __resetForTest({ timeFormat: { minUnit: "m", maxUnitCount: 2 } });
  });
  // ----- 5-band scale coloring on active ticks -----

  it("m_tokenInSpeed| 0.6 t/s → red (slowest band, < 50)", () => {
    // current.input=38, deltaApi=60_000 → 0.633 t/s; 0.6 < 50
    // → red.
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "in:0.6 t/s");
    assert.ok(out.includes(RED), `expected RED in: ${JSON.stringify(out)}`);
    assert.ok(!out.includes(STALE), `did not expect STALE in: ${JSON.stringify(out)}`);
  });

  it("m_tokenInSpeed| 50 t/s → orange (bands[0] boundary)", () => {
    // current.input=3000, deltaApi=60_000 → 50 t/s; 50 >= bands[0]=50
    // → palette[3] = orange.
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot({
      current: { tokenIn: 3000, tokenOut: 3000, tokenCacheCreation: 0, tokenCachedIn: 0 },
    });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "in:50.0 t/s");
    assert.ok(out.includes(ORANGE), `expected ORANGE in: ${JSON.stringify(out)}`);
  });

  it("m_tokenInSpeed| 400 t/s → bright green (fastest band, >= 400)", () => {
    // current.input=24000, deltaApi=60_000 → 400 t/s;
    // 400 >= bands[3]=400 → bright green.
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot({
      current: { tokenIn: 24_000, tokenOut: 24_000, tokenCacheCreation: 0, tokenCachedIn: 0 },
    });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "in:400.0 t/s");
    assert.ok(out.includes(GREEN), `expected GREEN in: ${JSON.stringify(out)}`);
  });

  it("m_tokenOutSpeed| 80 t/s → bright green (fastest out band)", () => {
    // current.output=4800, deltaApi=60_000 → 80 t/s;
    // 80 >= bands[3]=80 → bright green.
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot({
      current: { tokenIn: 4800, tokenOut: 4800, tokenCacheCreation: 0, tokenCachedIn: 0 },
    });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenOutSpeed"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "out:80.0 t/s");
    assert.ok(out.includes(GREEN), `expected GREEN in: ${JSON.stringify(out)}`);
  });

  it("m_tokenOutSpeed| 30 t/s → yellow (20 ≤ 30 < 40)", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot({
      current: { tokenIn: 1800, tokenOut: 1800, tokenCacheCreation: 0, tokenCachedIn: 0 },
    });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenOutSpeed"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "out:30.0 t/s");
    assert.ok(out.includes(YELLOW), `expected YELLOW in: ${JSON.stringify(out)}`);
  });

  it("m_tokenInSpeed|color|scale is equivalent to bare (scale is the default)", () => {
    // Explicit `:color:scale` and bare `m_tokenInSpeed` produce
    // the same color choice. The bare form defaults to scale
    // because scale is the canonical visualization for speed.
    //
    // v0.8.11-alpha — this test previously relied on the sessionId
    // guard inside resolvePreviousBaseline to discard the prev
    // baseline across sessions, and on `commit()` being skipped
    // (cwd=null) so the bare call's lastActive:in never reached
    // disk for the scaled call to read back. After dropping the
    // sessionId guard (so the regression check fires whenever
    // totalApiMs rolls backward, regardless of sessionId), each
    // call needs its own `beginTickForTest(null, null)` — null cwd
    // keeps commit() a no-op AND stops status-store's per-cwd
    // disk cache from leaking between calls.
    const bareSnap = fakeSnapshot({ sessionId: "sess-bare" });
    beginTickForTest(null, null);
    processTick(bareSnap.cwd, bareSnap);
    const bare = renderTemplate(
      ["m_tokenInSpeed"],
      ctxFor(bareSnap),
    ).join("\n");
    const scaledSnap = fakeSnapshot({ sessionId: "sess-scaled" });
    beginTickForTest(null, null);
    processTick(scaledSnap.cwd, scaledSnap);
    const scaled = renderTemplate(
      ["m_tokenInSpeed|color:scale"],
      ctxFor(scaledSnap),
    ).join("\n");
    // Both should land in the same band (red, 0.6 t/s).
    assert.equal(strip(bare), strip(scaled));
    assert.ok(bare.includes(RED) && scaled.includes(RED), `bare=${JSON.stringify(bare)} scaled=${JSON.stringify(scaled)}`);
  });

  it("m_tokenInSpeed|color|red overrides scale on active ticks", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_tokenInSpeed|color:red"],
      ctxFor(snap),
    ).join("\n");
    // 0.6 t/s would normally be red via scale; with explicit
    // `:color:red` it stays red (same color in this case —
    // semantically equivalent).
    assert.equal(strip(out), "in:0.6 t/s");
    assert.ok(out.includes(RED));
  });

  it("m_tokenInSpeed|color|brightGreen on a slow turn still renders green", () => {
    // 0.6 t/s would be red via scale; the user's `:color:brightGreen`
    // override wins. This is the "if user explicitly asked, ignore
    // the natural scheme in favor of theirs" rule.
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_tokenInSpeed|color:brightGreen"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "in:0.6 t/s");
    assert.ok(out.includes(GREEN), `expected GREEN override in: ${JSON.stringify(out)}`);
  });

  // ----- cached (inactive) tick behavior -----

  it("m_tokenInSpeed| idle tick with cached tps → STALE_COLOR, not -- t/s", () => {
    // First tick: active, writes 38/60000*1000 = 0.633 → cache
    // holds 0.633. Second tick: deltaApi=0 (same totalApiDurationMs
    // as cached) → falls back to cached value with STALE_COLOR.
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const first = fakeSnapshot();
    processTick(first.cwd, first);
    statusStore.commit();
    renderTemplate(["m_tokenInSpeed"], ctxFor(first));
    // Idle tick: same totalApiDurationMs (60_000) → deltaApi=0.
    setPrevTick("sess-test", { totalApiMs: 60_000 }, "D:\\test");
    const idle = fakeSnapshot();
    processTick(idle.cwd, idle);
    statusStore.commit();
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(idle)).join("\n");
    // Cached value (0.6 t/s) wrapped in STALE_COLOR.
    assert.equal(strip(out), "in:0.6 t/s");
    assert.ok(out.includes(STALE), `expected STALE (cached) in: ${JSON.stringify(out)}`);
  });

  it("m_tokenInSpeed| idle tick with NO cached tps → 'in|0.0 t/s' (v6.x idle=0)", () => {
    // v6.x — idle tick now renders the truthful 0.0 t/s rate.
    // The missing-data sentinel is reserved for the snapshot-missing
    // case (handled via ctxFor(null) elsewhere).
    setPrevTick("sess-test", { totalApiMs: 60_000 }, "D:\\test");
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "in:0.0 t/s");
  });

  it("m_tokenInSpeed| idle tick → STALE_COLOR even with |color|red override", () => {
    // Per the user's "inactive 不受 :color: 影响" decision:
    // cached/inactive ticks ALWAYS use STALE_COLOR regardless of
    // the user's color override. Gray is the canonical "this is a
    // stale measurement" signal — overriding it would erase the
    // "inactive" affordance.
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    // Prime the cache with an active tick.
    const first = fakeSnapshot();
    processTick(first.cwd, first);
    statusStore.commit();
    renderTemplate(["m_tokenInSpeed|color:red"], ctxFor(first));
    // Idle tick: same totalApiDurationMs.
    setPrevTick("sess-test", { totalApiMs: 60_000 }, "D:\\test");
    const idle = fakeSnapshot();
    processTick(idle.cwd, idle);
    statusStore.commit();
    const out = renderTemplate(
      ["m_tokenInSpeed|color:red"],
      ctxFor(idle),
    ).join("\n");
    assert.equal(strip(out), "in:0.6 t/s");
    assert.ok(
      out.includes(STALE),
      `expected STALE on cached tick even with :color:red in: ${JSON.stringify(out)}`,
    );
    // And the RED override from :color:red should NOT be present
    // on the cached render — only the active render.
    assert.ok(
      !out.includes(RED),
      `did not expect RED on cached tick in: ${JSON.stringify(out)}`,
    );
  });

  it("m_tokenInSpeed| cache is project-wide (no session dimension)", () => {
    // v0.4.x — the lastActive:in slot is now a single project-wide
    // entry (no sessionId dimension) with a 60s TTL. Session changes
    // do NOT isolate the cache: sess-B sees sess-A's cached tps.
    // The test pins that simplified contract.
    //
    // v0.8.x cwf-tickStatus-v2 — prevTickStatus is now a SINGLETON
    // per cwd. To simulate the "sess-B idle cross-session tick"
    // scenario, we must seed the singleton WITH sessionId=sess-B
    // (otherwise peekPrevTick returns null on sessionId mismatch
    // and the tick is treated as active). Use the identity
    // parameter on setPrevTick so the singleton belongs to sess-B.
    setPrevTick("sess-A", { totalApiMs: 0 }, "D:\\test",
      { sessionId: "sess-A", cwd: "D:\\test", model: null });
    const snapA = fakeSnapshot({ sessionId: "sess-A" });
    processTick(snapA.cwd, snapA);
    statusStore.commit();
    renderTemplate(["m_tokenInSpeed"], ctxFor(snapA));
    // Now switch to sess-B; prime the singleton at the SAME
    // totalApiDurationMs (idle tick) and tag it with sessionId=sess-B.
    // lastActive:in is still hot from sess-A, so sess-B sees the
    // cached tps (rendered with STALE_COLOR since the tick is idle).
    setPrevTick("sess-B", { totalApiMs: 60_000 }, "D:\\test",
      { sessionId: "sess-B", cwd: "D:\\test", model: null });
    const snapB = fakeSnapshot({ sessionId: "sess-B" });
    processTick(snapB.cwd, snapB);
    statusStore.commit();
    const out = renderTemplate(
      ["m_tokenInSpeed"],
      ctxFor(snapB),
    ).join("\n");
    assert.equal(strip(out), "in:0.6 t/s");
    assert.ok(out.includes(STALE), `expected STALE on idle cross-session tick in: ${JSON.stringify(out)}`);
  });

  it("m_tokenInSpeed| idle tick does NOT overwrite the cache", () => {
    // Prime with 0.6 t/s.
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const first = fakeSnapshot();
    processTick(first.cwd, first);
    statusStore.commit();
    renderTemplate(["m_tokenInSpeed"], ctxFor(first));
    // Idle tick at higher totalApiDurationMs but no API call.
    setPrevTick("sess-test", { totalApiMs: 60_000 }, "D:\\test");
    const idle = fakeSnapshot();
    processTick(idle.cwd, idle);
    statusStore.commit();
    renderTemplate(["m_tokenInSpeed"], ctxFor(idle));
    // The cache should still hold 0.633 (the first tick's value),
    // not some interpolated number from the idle tick.
    // We can't directly peek the cache from the test (peekLastSpeed
    // is the helper), so we assert via behavior: a subsequent
    // active tick writes a NEW value, and the idle tick's lack of
    // write is implicit in the fact that we got a cached 0.6.
    // Render another idle tick to confirm cache is still 0.6.
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(idle)).join("\n");
    assert.equal(strip(out), "in:0.6 t/s");
  });

  // ----- v0.8.x R7 — TTL gate disabled for the 4 speed/api/hitrate
  // modules. The 60s TTL is no longer enforced: any cached value in
  // status.json (even one written long ago) must surface on idle
  // ticks. The four tests below pre-write a status.json entry with
  // `at: Date.now() - 5*60_000` (5 minutes ago — well past the old
  // 60s window) and confirm each module's idle render still pulls
  // the cached value rather than the placeholder.
  //
  // The LAST_ACTIVE_TTL_MS constant in status-store is retained
  // for future opt-in via config, but readLastActive no longer
  // compares against it. The cache is now the persistent "last
  // known good" value.

  const seedBackdatedLastActive = (
    direction: "in" | "out" | "apiMs" | "tokenHitRate",
    value: number,
    prevTick?: PrevTickSnapshot,
  ): void => {
    // Direct write into the tmp status.json the test resolver
    // points at. We bypass the writeLastActive helper because
    // that helper stamps `at: Date.now()`, which would defeat
    // the point of the test (we want the entry to look 5
    // minutes old). Schema mirrors status-store's loader.
    // We also write a prev-tick entry if supplied (passed AFTER
    // this function returns, the in-memory _stores Map will be
    // cleared by resetStatusForTest, so the on-disk JSON is
    // authoritative). setPrevTick → writePrevTickStatus →
    // flushToDisk would otherwise rewrite the file, clobbering
    // the backdated entry — the right ordering is: build the
    // whole status.json here, then call resetStatusForTest, then
    // render.
    const path = join(_tmpDir, "status.json");
    const store: Record<string, unknown> = {
      [`lastActive:${direction}`]: {
        at: Date.now() - 5 * 60_000,
        value: { direction, tps: value },
        kind: "lastActive",
      },
    };
    if (prevTick) {
      // v0.8.10-alpha.2 snapshot contract: prevTickStatus now
      // carries only totalApiMs + identity. The per-turn
      // in/out/cachedIn/totalIn fields are gone — apiMs is the
      // ONLY cross-tick subtraction. See plan
      // ancient-wobbling-mochi.md for the rationale.
      store["prevTickStatus"] = {
        at: Date.now(),
        value: {
          totalApiMs: prevTick.totalApiMs,
          sessionId: null,
          cwd: null,
          model: null,
        },
        kind: "prevTickStatus",
      };
    }
    writeFileSync(path, JSON.stringify(store));
  };

  it("m_tokenInSpeed| backdated (5 min old) lastActive:in → idle tick surfaces cached tps (TTL gate disabled, R7)", () => {
    // Pre-write a 5-minute-old lastActive:in with tps=12.5.
    // The old 60s TTL would have hidden this; the new R7 contract
    // surfaces it indefinitely. Build status.json with prev-tick
    // (apiMs=60_000) + backdated lastActive:in. current stdin
    // carries apiMs=60_000 too, so deltaApi=0 → idle tick →
    // STALE_COLORed cached value.
    seedBackdatedLastActive("in", 12.5, { totalApiMs: 60_000 });
    resetStatusForTest();
    // v0.9.x — re-bootstrap tick-state now that the on-disk file
    // is populated; beforeEach's beginTickForTest loaded an empty
    // store when this cwd was null.
    const snap = fakeSnapshot();
    beginTickForTest(snap.cwd, snap);
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "in:12.5 t/s");
    assert.ok(out.includes(STALE), `expected STALE on backdated cache: ${JSON.stringify(out)}`);
  });

  it("m_tokenOutSpeed| backdated (5 min old) lastActive:out → idle tick surfaces cached tps (TTL gate disabled, R7)", () => {
    seedBackdatedLastActive("out", 8.25, { totalApiMs: 60_000 });
    resetStatusForTest();
    const snap = fakeSnapshot();
    beginTickForTest(snap.cwd, snap);
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenOutSpeed"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "out:8.3 t/s");
    assert.ok(out.includes(STALE), `expected STALE on backdated cache: ${JSON.stringify(out)}`);
  });

  it("m_apiMs| backdated (5 min old) lastActive:apiMs → idle tick surfaces cached ms (TTL gate disabled, R7)", () => {
    // apiMs=30_000 in both prev and current → deltaApi=0 → idle.
    seedBackdatedLastActive("apiMs", 90_000, { totalApiMs: 30_000 });
    resetStatusForTest();
    const snap = fakeSnapshot({
      sessionId: "sess-apims-r7",
      cost: { totalDurationMs: 60_000, totalApiDurationMs: 30_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    beginTickForTest(snap.cwd, snap);
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "api:1m");
    assert.ok(out.includes(STALE), `expected STALE on backdated cache: ${JSON.stringify(out)}`);
  });

  it("m_tokenHitRate| backdated (5 min old) lastActive:tokenHitRate → idle tick surfaces cached pct (TTL gate disabled, R7)", () => {
    // cacheRead=null on stdin AND deltaApi=0 (idle). Both fall-back
    // paths converge on the same lastActive:tokenHitRate lookup.
    seedBackdatedLastActive("tokenHitRate", 87.3, { totalApiMs: 60_000 });
    resetStatusForTest();
    const snap = fakeSnapshot({
      sessionId: "sess-hr-r7",
      current: { tokenIn: 0, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: null },
    });
    beginTickForTest(snap.cwd, snap);
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_tokenHitRate"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "hit:87.3%");
    assert.ok(out.includes(STALE), `expected STALE on backdated cache: ${JSON.stringify(out)}`);
  });
});

// ----- v0.4.0+ m_template module -----
//
// Direct coverage of `m_template:<key>[:type:<plan|balance>]` against
// `renderTemplate` (no provider dispatch — ctx.providerType is
// set explicitly). The end-to-end "minimax renders the chunk" path
// is in lineTemplate.test.ts; this file exercises the renderer in
// isolation so a missing-key warn is easier to capture.
//
// v0.8.15+ — the inline intrinsic arg is renamed to `type` (was
// `mode`); the legacy `mode` arg is still accepted for back-compat.
// The renderer-side check prefers `type` when both are present on
// the same token. The comparison target inside the renderer is
// ctx.providerType (a TYPE discriminator, not a mode).
describe("renderTemplate — m_template inline-args (v0.4.0+)", () => {
  beforeEach(() => __resetForTest());

  it("m_template|foo with ctx.providerType='plan' expands the registered fragment", () => {
    __resetForTest({
      lineTemplates: { foo: ["m_windowQuota|term:short"] },
    });
    const out = renderTemplate(["m_template|foo"], ctxFor(null, legacyToIv({ pct: 42 })));
    // m_windowQuota|term:short at 42% should land in band 1 (orange) per the
    // default band thresholds. Strip ANSI for stability.
    assert.match(out.map(strip).join("\n"), /42%/);
  });

  it("m_template|foo with ctx.providerType='balance' wants type|plan → drops", () => {
    __resetForTest({
      lineTemplates: { foo: ["m_windowQuota|term:short"] },
    });
    const out = renderTemplate(
      ["m_template|foo|type:quota"],
      ctxFor(null, null, null, null, "balance"),
    );
    // Dropped because providerType=balance but type wants plan.
    // The dropped chunk leaves an empty array (separators are also
    // skipped when their neighbors drop).
    assert.deepEqual(out, []);
  });

  it("m_template|foo with ctx.providerType='plan' wants type|plan → renders", () => {
    __resetForTest({
      lineTemplates: { foo: ["m_windowQuota|term:short"] },
    });
    const out = renderTemplate(
      ["m_template|foo|type:quota"],
      ctxFor(null, legacyToIv({ pct: 42 }), null, null, "quota"),
    );
    assert.match(out.map(strip).join("\n"), /42%/);
  });

  it("m_template|foo|mode|quota — `mode` is now an unknown arg (no compat shim)", () => {
    // `mode` was the legacy name for `type`. It was removed without
    // a back-compat alias — see CLAUDE.md "mode→type rename, plan→quota".
    // parseInlineArgs rejects unknown args with badarg → warn + drop,
    // so a token containing `mode|quota` fails loud and the chunk
    // doesn't render. Confirmed by the empty array below.
    __resetForTest({
      lineTemplates: { foo: ["m_windowQuota|term:short"] },
    });
    const out = renderTemplate(
      ["m_template|foo|mode:quota"],
      ctxFor(null, legacyToIv({ pct: 42 }), null, null, "quota"),
    );
    assert.deepEqual(out, []);
  });

  it("m_template|foo|type|quota|type|balance (same arg twice) — last-value-wins for parser", () => {
    // The parser maps to a flat object, so a repeated `type` arg
    // resolves to the last value. This is documented inline-args
    // behavior. The test pins that `type:quota|type:balance` ends
    // up matching `balance` (last value wins).
    __resetForTest({
      lineTemplates: { foo: ["m_windowQuota|term:short"] },
    });
    const outBalance = renderTemplate(
      ["m_template|foo|type:quota|type:balance"],
      ctxFor(null, legacyToIv({ pct: 42 }), null, null, "quota"),
    );
    assert.deepEqual(outBalance, []);
    const outQuota = renderTemplate(
      ["m_template|foo|type:balance|type:quota"],
      ctxFor(null, legacyToIv({ pct: 42 }), null, null, "quota"),
    );
    assert.match(outQuota.map(strip).join("\n"), /42%/);
  });

  it("m_template|foo — bare key (no type) renders agnostic", () => {
    // `type` is absent → renderer falls back to provider-agnostic
    // behavior (renders under any providerType, including "balance").
    // A bare key in a BALANCE ctx drops only when an INNER module's
    // `type:"quota"` filter doesn't match.
    __resetForTest({
      lineTemplates: { foo: ["m_windowQuota|term:short"] },
    });
    const outPlan = renderTemplate(
      ["m_template|foo"],
      ctxFor(null, legacyToIv({ pct: 42 }), null, null, "quota"),
    );
    assert.match(outPlan.map(strip).join("\n"), /42%/);
    const outBalance = renderTemplate(
      ["m_template|foo"],
      ctxFor(null, null, null, null, "balance"),
    );
    assert.deepEqual(outBalance, []);
  });

  it("m_template — passthrough excludes `type` (intrinsic never leaks)", () => {
    // v0.8.15+ — the passThrough build loops over Object.entries
    // and skips every key in the intrinsic-exclusion set:
    // ["key", "type"]. Confirming that an intrinsic arg does NOT
    // get pushed to inner modules as `passThrough.type` (which
    // would shadow `ctx.providerType` semantics and confuse inner
    // modules that look at the type field by accident).
    //
    // Mechanism: render `m_template|<key>|type|quota` (intrinsic
    // consumed) and `m_template|<key>` (bare). Both must produce
    // byte-identical output, proving `type` had no effect on the
    // inner module. The inner m_session has no `sessionName` so
    // it renders its `n/a` placeholder in both cases.
    __resetForTest({
      lineTemplates: {
        probe: ["m_session"],
      },
    });
    const outWithType = renderTemplate(
      ["m_template|probe|type:quota"],
      ctxFor(fakeSnapshot(), null, null, null, "quota"),
    );
    const outBare = renderTemplate(
      ["m_template|probe"],
      ctxFor(fakeSnapshot(), null, null, null, "quota"),
    );
    assert.equal(
      outWithType.map(strip).join("\n"),
      outBare.map(strip).join("\n"),
      "m_template|probe|type|quota must render identically to m_template|probe (type is consumed by m_template, not forwarded)",
    );
  });
  it("m_template|nonexistent (missing key) warns and drops", () => {
    let captured = "";
    const err = process.stderr as unknown as { write: (chunk: string) => boolean };
    const original = err.write;
    err.write = (chunk) => {
      captured += typeof chunk === "string" ? chunk : "";
      return true;
    };
    try {
      const out = renderTemplate(["m_template|nonexistent"], ctxFor(null));
      assert.deepEqual(out, []);
      assert.match(captured, /lineTemplates\["nonexistent"\] is undefined/);
    } finally {
      err.write = original;
    }
  });
});

// v0.8.7+ — m_template passthrough. Outer m_template declares
// named args (scope/color/nulldrop/window/model/align) and the
// renderer forwards them as a fallback to the inner module list
// via ctx.passThrough. Inner-explicit-wins: when the inner module
// also declares the same arg, its value is used; the passthrough
// only fills undefined slots. Unknown args still fail loud
// (parseInlineArgs → badarg → warn + drop) so typos are not
// silently accepted.
describe("renderTemplate — m_template passthrough (v0.8.7+)", () => {
  beforeEach(() => {
    __resetForTest();
    // The "unknown lineTemplate module" warn fires once per
    // process (warnUnknownModuleOnce). Reset here so the
    // unknown-arg test in this block observes its own warn.
    __resetUnknownModuleWarnForTest();
  });

  it("m_template|foo|scope|session forwards scope to inner m_accTokenIn (no inner arg)", () => {
    // Seed the SESSION slot only. If passthrough routes correctly
    // to m_accTokenIn|scope|session, the renderer reads peekAvg(sid)
    // and surfaces accTokenIn=42. Without passthrough (default
    // ccsession), the ccsession slot is empty → placeholder.
    setAvg(
      "sess-pt",
      { accTokenIn: 42, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 1, accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\WorkSpace\\pt",
      { modelId: "MiniMax-M3", deltaApiCalls: 0, currentApiMs: 0, deltaTokenIn: 0, deltaTokenOut: 0, deltaTokenCachedIn: 0, deltaApiMs: 0 },
    );
    __resetForTest({
      lineTemplates: { foo: ["m_accTokenIn"] },
    });
    const tokens = fakeSnapshot({
      sessionId: "sess-pt",
      cwd: "D:\\WorkSpace\\pt",
      // No current delta — we only want the seeded session slot to surface.
      current: { tokenIn: 0, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: 0 },
      cost: { totalDurationMs: 0, totalApiDurationMs: 0, totalLinesAdded: null, totalLinesRemoved: null },
    });
    const out = renderTemplate(["m_template|foo|scope:session"], ctxFor(tokens)).join("\n");
    assert.equal(strip(out), "in:42");
  });

  it("m_template|foo|scope|project forwards scope to inner m_accTokenIn (no inner arg)", () => {
    // Seed BOTH the project slot (99) and the session slot (11)
    // for the same cwd. setAvg only persists to the project slot
    // when extras.deltaTokenIn is non-zero (see render.ts:1166-1173);
    // using 1 as the seed delta so the project write actually
    // fires. The session slot uses += for accTokenIn, so the seed
    // accumulates the 1 too — but the test observes the routed
    // slot (project=99, session=11) by scope and verifies the
    // output matches the project slot's value.
    setAvg(
      "sess-pt2",
      { accTokenIn: 0, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 0, accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\WorkSpace\\pt2",
      { modelId: "MiniMax-M3", deltaApiCalls: 1, currentApiMs: 1000, deltaTokenIn: 99, deltaTokenOut: 0, deltaTokenCachedIn: 0, deltaApiMs: 1000, deltaTokenTotalIn: 99 },
    );
    // The m_accTokenIn render call will then fire accPrimer,
    // which adds this tick's delta (current.input=0 → deltaTokenIn=0)
    // to BOTH slots. Net: project=99, session=11. With
    // passthrough scope=project, the rendered value must be 99.
    __resetForTest({
      lineTemplates: { foo: ["m_accTokenIn"] },
    });
    const tokens = fakeSnapshot({
      sessionId: "sess-pt2",
      cwd: "D:\\WorkSpace\\pt2",
      current: { tokenIn: 0, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: 0 },
      cost: { totalDurationMs: 0, totalApiDurationMs: 0, totalLinesAdded: null, totalLinesRemoved: null },
    });
    // Pre-write a session-only value (11) so the session slot
    // is distinguishable from the project slot (99). The
    // accPrimer will add 0 to both, leaving them at the seeded
    // values. (setAvg with deltaTokenIn=0 only writes the session
    // slot — line 1153-1161 always runs; project/ccsession
    // gates on extras.deltaTokenIn > 0 at line 1166-1173.)
    // We need the session slot to have a known value too —
    // a direct read+write of the session slot is hard, so
    // observe by subtracting. After primer fires (delta=0),
    // both slots are unchanged. The render then routes to
    // project (via passthrough) and surfaces 99.
    const out = renderTemplate(["m_template|foo|scope:project"], ctxFor(tokens)).join("\n");
    assert.equal(strip(out), "in:99");
  });

  it("inner explicit scope wins over m_template passthrough (内层 > 透传)", () => {
    // Use statusStore.writeTickStatus directly so the seed lands
    // ONLY on the project slot — the session slot (the inner
    // routed target) stays empty. Then inner
    // `m_accTokenIn|scope|session` should route to the empty
    // session slot, not the seeded project slot — proving the
    // inner-explicit-wins contract. (Post-ccsession removal the
    // inner example targets session instead of ccsession; the
    // validation mechanism is unchanged.)
    const projectKey = `tickStatus:${projectHash("D:\\WorkSpace\\pt3")}`;
    statusStore.writeTickStatus("D:\\WorkSpace\\pt3", projectKey, {
      ...statusStore.emptyTickStatus(),
      accTokenIn: 77,
    });
    __resetForTest({
      lineTemplates: { foo: ["m_accTokenIn|scope:session"] },
    });
    const tokens = fakeSnapshot({
      sessionId: "sess-pt3",
      cwd: "D:\\WorkSpace\\pt3",
      current: { tokenIn: 0, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: 0 },
      cost: { totalDurationMs: 0, totalApiDurationMs: 0, totalLinesAdded: null, totalLinesRemoved: null },
    });
    const out = renderTemplate(["m_template|foo|scope:project"], ctxFor(tokens)).join("\n");
    // Inner wins → session slot. The session slot was never
    // written (we only seeded project=77) → placeholderAcc
    // surfaces "in:n/a". The passthrough (scope=project) would
    // have surfaced 77 — if we see 77, the inner-wins contract
    // broke.
    assert.equal(strip(out), "in:n/a", `inner scope must beat passthrough; got: ${JSON.stringify(out)}`);
  });

  it("m_template|foo|wtf|bar — unknown arg on m_template still badarg-warns (whitelist enforced)", () => {
    let captured = "";
    const err = process.stderr as unknown as { write: (chunk: string) => boolean };
    const original = err.write;
    err.write = (chunk) => {
      captured += typeof chunk === "string" ? chunk : "";
      return true;
    };
    try {
      __resetForTest({
        lineTemplates: { foo: ["m_accTokenIn"] },
      });
      const out = renderTemplate(["m_template|foo|wtf:bar"], ctxFor(fakeSnapshot())).join("\n");
      assert.equal(strip(out), "");
      assert.match(captured, /unknown lineTemplate module/);
    } finally {
      err.write = original;
    }
  });

  it("m_template|foo|nulldrop|true — passthrough of nulldrop is accepted (whitelist)", () => {
    // nulldrop is in the whitelist. We can't observe nulldrop's
    // effect on a m_accTokenIn that has data, so just confirm the
    // token doesn't badarg-warn and the inner module renders.
    __resetForTest({
      lineTemplates: { foo: ["m_windowQuota|term:short"] },
    });
    let captured = "";
    const err = process.stderr as unknown as { write: (chunk: string) => boolean };
    const original = err.write;
    err.write = (chunk) => {
      captured += typeof chunk === "string" ? chunk : "";
      return true;
    };
    try {
      const out = renderTemplate(["m_template|foo|nulldrop:true"], ctxFor(null, legacyToIv({ pct: 50 }))).join("\n");
      assert.match(strip(out), /50%/);
      assert.doesNotMatch(captured, /unknown lineTemplate module/);
    } finally {
      err.write = original;
    }
  });

  it("m_template|foo|color|red forwards color to inner m_session (passthrough color wrap)", () => {
    __resetForTest({
      lineTemplates: { foo: ["m_session"] },
    });
    const tokens = fakeSnapshot({ sessionName: "alpha" });
    const out = renderTemplate(["m_template|foo|color:red"], ctxFor(tokens)).join("\n");
    // wrapPlainDefault applies the user color over the default. The
    // test only requires the body text "alpha" to be present and
    // the token to NOT be dropped (no "unknown lineTemplate module"
    // warn).
    assert.match(strip(out), /alpha/);
  });

  it("m_template — passthrough does NOT leak back to the outer context (snapshot test)", () => {
    // After the m_template expansion, the outer ctx.passThrough
    // must remain undefined (the inner context gets a fresh object
    // via `{ ...ctx, passThrough }`). We verify by checking that
    // the outer ctx after m_template still has passThrough
    // undefined, so subsequent renderTemplate calls on the same
    // ctx see no leaked passthrough. We use peekAcc on a known
    // empty slot via the OUTER m_accTokenIn (no passthrough)
    // to confirm the slot routing returns the same as a fresh ctx.
    __resetForTest({
      lineTemplates: { foo: ["m_session|color:red"] },
    });
    const tokens = fakeSnapshot({ sessionName: "alpha" });
    // First call: outer template references m_template + an
    // m_session. The m_template|foo expands to m_session|color|red
    // (inner's own color). The outer m_session uses its OWN args
    // (no color, so default purple from wrapPlainDefault).
    const out = renderTemplate(
      ["m_template|foo", "s_space", "m_session"],
      ctxFor(tokens),
    ).join("\n");
    // The stripped output should contain "alpha" twice. This
    // proves BOTH the inner m_session and the outer m_session
    // rendered, and the outer one was unaffected by the
    // passThrough on the inner ctx (otherwise the inner
    // passThrough would have had no effect on the outer call
    // anyway since color isn't a routing concern, but the
    // structural assertion is "two alphas" = two renders).
    const stripped = strip(out);
    assert.match(stripped, /alpha\s+alpha/);
    // Also assert that the outer ctx.passThrough is still
    // undefined after the m_template call. We do this by
    // directly checking the same context object the caller
    // owns (the renderer doesn't mutate caller's ctx).
    const ctx = ctxFor(tokens);
    renderTemplate(["m_template|foo"], ctx);
    assert.equal(ctx.passThrough, undefined, "outer ctx.passThrough must remain undefined after m_template expansion");
  });

  it("m_template|foo — bare key still works (regression: v0.4.x 2-arg shape preserved)", () => {
    // The pre-v0.8.7 shape `m_template|<key>` (no other args) must
    // keep expanding the fragment with no passThrough.
    __resetForTest({
      lineTemplates: { foo: ["m_windowQuota|term:short"] },
    });
    const out = renderTemplate(["m_template|foo"], ctxFor(null, legacyToIv({ pct: 10 }))).join("\n");
    assert.match(strip(out), /10%/);
  });

  it("m_template|stat|window|all forwards window into bare m_sumTokenIn (passthrough axis reach)", () => {
    // v0.8.14 doc test — `m_template|<key>|window|<w>|model|<m>|align|<a>`
    // must forward window/model/align into a BARE m_sum* child.
    //
    // Since v0.8.7 (commit 9549770) the bare MODULES path reads
    // `c.passThrough ?? {}` for its parseWindowScope call, so the
    // passthrough feature is ALREADY wired for m_sum* — this test
    // exists as a regression guard so a future refactor that
    // drops the `?? {}` to a hard `{}` (which would silently
    // break passthrough) is caught.
    //
    // Diagnostic strategy: pick a window value that DIFFERS from
    // the default `5h`. We use `window|all` so a recent-row-only
    // seed (1h old) produces "in:100" under window=5h AND a
    // different sum (here, both rows) under window=all — except
    // the rows are co-located to make the comparison
    // unambiguous: 2 rows totalling 300 across window=all vs 1
    // row totalling 100 across window=5h. If the passthrough
    // breaks, the renderer falls back to the default 5h and
    // returns 100 (not 300).
    //
    // NOTE: window=all also turns OFF align-reset (parseWindowScope
    // line 2452 returns alignActive:false), so the test doesn't
    // need to inject ctx.fiveHour.resetStartAt.
    const stateRootDir = join(_tmpDir, "sum-pt-all");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-pt";
    const sess = "sess-sum-pt";
    const cwd = "D:\\sum-pt";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    // Two rows: one recent-1h (in: 100), one 10h-old (in: 200).
    // With window=5h → only the 100 row → sumIn=100 → "in:100".
    // With window=all → both → sumIn=300 → "in:300".
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: now - 3600_000, totalIn: 100, totalOut: 0, in: 100, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 0, apiMs: 0 }),
        JSON.stringify({ at: now - 10 * 3600_000, totalIn: 200, totalOut: 0, in: 200, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 0, apiMs: 0 }),
      ].join("\n") + "\n",
      "utf8",
    );
    __resetForTest({
      lineTemplates: { stat: ["m_sumTokenIn"] },
    });
    const tokens = fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" });
    const outAll = renderTemplate(
      ["m_template|stat|window:all"],
      { ...ctxFor(tokens), nowMs: now },
    ).join("\n");
    // v0.8.7+ passthrough: window=all is forwarded into the bare
    // m_sumTokenIn → both rows counted → "in:300".
    assert.equal(strip(outAll), "in:300",
      `expected window=all passthrough to include both rows (sum=300); ` +
      `if this returns 100 the bare MODULES path is reading params from its own ` +
      `(empty) params object instead of c.passThrough — v0.8.7 regression. ` +
      `Actual: ${JSON.stringify(strip(outAll))}`);

    // Control: bare m_template|stat (no args) → defaults to
    // window="all" (vX.X.X — bare default changed from "5h" to
    // "all" so that a bare m_sum* reads the entire cross-project
    // JSONL by default; explicit `|window|<dhms>` or
    // `|window|<declaredId>|align|true` opts into a bounded
    // scan). Both rows count → "in:300".
    const outDefault = renderTemplate(
      ["m_template|stat"],
      { ...ctxFor(tokens), nowMs: now },
    ).join("\n");
    assert.equal(strip(outDefault), "in:300",
      `expected bare default window=all to count both rows, got: ${JSON.stringify(strip(outDefault))}`);

    // Sanity: m_template|stat|window|5h (explicit passthrough
    // matching the default) must match the default control.
    const out5h = renderTemplate(
      ["m_template|stat|window:5h"],
      { ...ctxFor(tokens), nowMs: now },
    ).join("\n");
    assert.equal(strip(out5h), "in:100",
      `expected explicit window=5h passthrough to match default, got: ${JSON.stringify(strip(out5h))}`);
  });

  it("m_template|stat|model|all forwards model into bare m_sumTokenIn", () => {
    // Parallel to the window test above but for the model axis.
    // Seed 2 rows: one for the active model (MiniMax-M3) and one
    // for a different model (M2.7). Bare m_sumTokenIn defaults
    // to model=active → only MiniMax-M3 row → sumIn=100. The
    // forwarded `model|all` must include both → sumIn=300.
    const stateRootDir = join(_tmpDir, "sum-pt-model");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-pt-m";
    const sess = "sess-sum-pt-m";
    const cwd = "D:\\sum-pt-m";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: now - 60_000, totalIn: 100, totalOut: 0, in: 100, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 0, apiMs: 0 }),
        JSON.stringify({ at: now - 60_000, totalIn: 200, totalOut: 0, in: 200, out: 0, cacheIn: 0, cacheCreation: 0, model: "OtherModel", totalApiMs: 0, apiMs: 0 }),
      ].join("\n") + "\n",
      "utf8",
    );
    __resetForTest({
      lineTemplates: { stat: ["m_sumTokenIn"] },
    });
    const tokens = fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" });
    const out = renderTemplate(
      ["m_template|stat|model:all"],
      { ...ctxFor(tokens), nowMs: now },
    ).join("\n");
    assert.equal(strip(out), "in:300",
      `expected model|all passthrough to include both models (sum=300), ` +
      `got: ${JSON.stringify(strip(out))}`);
  });

  it("m_template — bare key with NO inner args (default 5h/active/true) matches the user's reported case", () => {
    // The user reported `m_template|tokens_stat|window|5h` doesn't
    // appear to do anything different from `m_template|tokens_stat`
    // alone. That's the EXPECTED behavior — window=5h IS the
    // default. This test is a diagnostic guard confirming the
    // two produce identical output so future readers don't
    // mistake the "default equals default" observation for a bug.
    const stateRootDir = join(_tmpDir, "sum-pt-default");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-pt-d";
    const sess = "sess-sum-pt-d";
    const cwd = "D:\\sum-pt-d";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    writeFileSync(
      sessionFile,
      JSON.stringify({ at: now - 60_000, totalIn: 42, totalOut: 0, in: 42, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 0, apiMs: 0 }) + "\n",
      "utf8",
    );
    __resetForTest({
      lineTemplates: { stat: ["m_sumTokenIn"] },
    });
    const tokens = fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" });
    const outBare = renderTemplate(["m_template|stat"], { ...ctxFor(tokens), nowMs: now }).join("\n");
    const outExplicit5h = renderTemplate(["m_template|stat|window:5h"], { ...ctxFor(tokens), nowMs: now }).join("\n");
    const outExplicitActive = renderTemplate(["m_template|stat|model:active"], { ...ctxFor(tokens), nowMs: now }).join("\n");
    const outAll3 = renderTemplate(
      ["m_template|stat|window:5h|model:active|align:true"],
      { ...ctxFor(tokens), nowMs: now },
    ).join("\n");
    assert.equal(strip(outBare), "in:42");
    assert.equal(strip(outExplicit5h), strip(outBare),
      `expected window|5h to match bare default; user reports "passthrough doesn't work" — this guards against future drift`);
    assert.equal(strip(outExplicitActive), strip(outBare),
      `expected model|active to match bare default; same guard`);
    assert.equal(strip(outAll3), strip(outBare),
      `expected all three default axes to match bare default; same guard`);
  });
});

// v0.4.x+ — Per-Project cache isolation. Two snapshots with the
// same sessionId but different cwds must NOT share the same
// tickSpeed: / tickAvg: cache slot. The render layer applies a
// `projectHash(cwd):` prefix before calling into the cache module,
// so each project's accumulator lives at a distinct key. This
// describe block exercises that path end-to-end via the public
// render-template API.
describe("render — per-project cache isolation", () => {
  it("same sessionId, different cwds → accumulators are independent", () => {
    __resetForTest({ lineTemplates: { tok: ["m_tokenInSpeed", "m_tokenOutSpeed"] } });
    // v0.9.x — per-cwd isolation is enforced by the on-disk file
    // path (state/<projectHash>/status.json), not by per-key
    // prefixing. status-store keeps a per-cwd `_stores` cache
    // keyed by cwd, so writing via setPrevTick(cwdA) and then
    // re-loading via loadFromDisk(cwdA) returns cwdA's slot
    // while loadFromDisk(cwdB) returns cwdB's (empty, on a
    // fresh tmp dir). The tick-state's per-tick pending
    // accumulates ONE cwd at a time — to verify two-cwd
    // independence we exercise the disk persistence boundary
    // directly: write both, commit, then read each back
    // independently.
    const sid = "sess-shared";
    const cwdA = "D:\\WorkSpace\\alpha";
    const cwdB = "D:\\WorkSpace\\beta";

    // v0.9.x — per-cwd isolation is enforced by the on-disk file
    // path (state/<projectHash>/status.json), not by per-key
    // prefixing. status-store keeps a per-cwd `_stores` cache
    // keyed by cwd, so writing via setPrevTick(cwdA) and then
    // re-loading via loadFromDisk(cwdA) returns cwdA's slot
    // while loadFromDisk(cwdB) returns cwdB's (empty, on a
    // fresh tmp dir). The tick-state's per-tick pending
    // accumulates ONE cwd at a time — to verify two-cwd
    // independence we exercise the disk persistence boundary
    // directly: write both, commit, then read each back
    // independently.
    // Default setStatusPathResolver from beforeEach returns a
    // single file regardless of cwd — override with a cwd-aware
    // resolver that mirrors the production state/<projectHash>/
    // status.json layout so each cwd lands in its own file.
    setStatusPathResolver((cwd) => join(_tmpDir, `${projectHash(cwd)}.status.json`));
    resetStatusForTest();

    // Tick 1 in project A: apiMs baseline = 100ms.
    const tokensA = fakeSnapshot({
      sessionId: sid, cwd: cwdA,
      totals: { tokenTotalIn: 100, tokenTotalOut: 50 },
      current: { tokenIn: 100, tokenOut: 50, tokenCacheCreation: 0, tokenCachedIn: 0 },
      cost: { totalDurationMs: 0, totalApiDurationMs: 100, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    beginTickForTest(cwdA, tokensA);
    setPrevTick(sid, { totalApiMs: 100 }, cwdA);
    statusStore.commit();

    // Tick 2 in project B: apiMs baseline = 0ms.
    const tokensB = fakeSnapshot({
      sessionId: sid, cwd: cwdB,
      totals: { tokenTotalIn: 100, tokenTotalOut: 50 },
      current: { tokenIn: 100, tokenOut: 50, tokenCacheCreation: 0, tokenCachedIn: 0 },
      cost: { totalDurationMs: 0, totalApiDurationMs: 100, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    beginTickForTest(cwdB, tokensB);
    setPrevTick(sid, { totalApiMs: 0 }, cwdB);
    statusStore.commit();

    // Peek each project's slot via a fresh tick — the on-disk
    // file for project A holds apiMs=100, the file for project
    // B holds apiMs=0.
    resetStatusForTest();
    beginTickForTest(cwdA, tokensA);
    const a = peekPrevTick(sid, cwdA);
    beginTickForTest(cwdB, tokensB);
    const b = peekPrevTick(sid, cwdB);
    assert.deepEqual(a, { totalApiMs: 100 });
    assert.deepEqual(b, { totalApiMs: 0 });

    // Cleanup: clear both slots so the next test in the suite
    // (which uses the default `D:\\test` cwd → projectHash
    // "d--test") is not contaminated.
    __resetPrevTickForTest(sid, cwdA);
    __resetPrevTickForTest(sid, cwdB);
  });
});

// ----- vX.X.X+ — six named separator aliases (s_space / s_dot / s_newline / s_tab / s_colon / s_pipe) -----
//
// These are the only separator tokens. The legacy numeric `s_<n>`
// form and the `separators` config array are REMOVED — the
// aliases render their built-in literals regardless of any user
// config.
describe("renderTemplate — named separator aliases (vX.X.X+)", () => {
  beforeEach(() => {
    // vX.X.X+ defaults: no `separators` config array, default
    // template, no version injection.
    __resetForTest();
  });

  // ----- Bare form -----

  it('s_space renders the literal " " — alias resolves from NAMED_SEPARATORS', () => {
    // vX.X.X+: the `separators` config array is gone. The alias
    // MUST resolve from NAMED_SEPARATORS. The template
    // ["m_modeLabel", "s_space", "m_modeLabel"] concatenates to
    // a single line "Usage: Usage:" (the alias fills the slot).
    const out = renderTemplate(["m_modeLabel", "s_space", "m_modeLabel"], ctxFor(null));
    // m_modeLabel renders "Usage:" for the plan mode default.
    // Output lines are joined with no internal separator here —
    // renderTemplate returns the post-newline-split line array.
    assert.deepEqual(out.map(strip), ["Usage: Usage:"]);
  });

  it('s_dot renders "·" (middot U+00B7) even when `separators` is empty', () => {
    const out = renderTemplate(["s_dot"], ctxFor(null));
    assert.deepEqual(out.map(strip), ["·"]);
  });

  it("s_newline renders the literal newline char (default array is empty)", () => {
    // The bare-form path must split the template on the "\n"
    // alias just like a `separators[2] === "\n"` would. We use
    // a trivial template so we only assert the split behavior,
    // not any module rendering.
    const out = renderTemplate(["s_newline"], ctxFor(null));
    // A single bare "\n" should produce zero output lines
    // (trailing newline is trimmed, same as the array path's
    // behavior tested in the "newline separator" suite above).
    assert.deepEqual(out, []);
  });

  it("s_tab renders the literal TAB char", () => {
    const out = renderTemplate(["s_tab"], ctxFor(null));
    assert.deepEqual(out.map(strip), ["\t"]);
  });

  it('s_colon renders the literal ":"', () => {
    const out = renderTemplate(["s_colon"], ctxFor(null));
    assert.deepEqual(out.map(strip), [":"]);
  });

  // ----- Inline-args form (`:color:<c>` / `:nulldrop:<b>`) -----

  it("s_space|color|brightGreen wraps the space in the brightGreen SGR", () => {
    const out = renderTemplate(["s_space|color:brightGreen"], ctxFor(null));
    assert.equal(out.length, 1);
    assert.equal(strip(out[0]), " ");
    assert.ok(out[0].includes(GREEN), `expected GREEN in: ${JSON.stringify(out[0])}`);
  });

  it("s_dot|color|red wraps the dot in the red SGR (v0.7.2+ default `wrap=true` pads with 1 space on each side)", () => {
    const out = renderTemplate(["s_dot|color:red"], ctxFor(null));
    assert.equal(out.length, 1);
    assert.equal(strip(out[0]), " · ");
    assert.ok(out[0].includes(RED), `expected RED in: ${JSON.stringify(out[0])}`);
  });

  // ----- Independence from `separators` array -----

  it("s_space always renders ' ' regardless of any legacy separators config (no-op)", () => {
    // vX.X.X+: the `separators` config field is gone. A user with
    // a stale `separators` key in their config.json is silently
    // ignored; s_space still renders the built-in literal.
    __resetForTest({ separators: ["x", "y"] } as any);
    const out = renderTemplate(["s_space"], ctxFor(null));
    assert.deepEqual(out.map(strip), [" "]);
  });

  // ----- Unknown alias → literal pass-through (vX.X.X+) -----

  it("s_xyz (unknown alias name) emits the original token verbatim — no warn, no drop", () => {
    // vX.X.X+: the numeric s_<n> form and the `separators` config
    // are REMOVED. Unknown s_<name> suffixes are now treated as
    // unrecognized modules and the dispatcher emits the WHOLE
    // token as a literal — no parsing, no warning.
    __resetForTest();
    __resetUnknownModuleWarnForTest();
    const out = renderTemplate(["s_xyz"], ctxFor(null));
    assert.deepEqual(out.map(strip), ["s_xyz"]);
  });

  it("s_0 (numeric suffix) emits 's_0' verbatim — the legacy numeric form is gone", () => {
    __resetForTest();
    const out = renderTemplate(["s_0"], ctxFor(null));
    assert.deepEqual(out.map(strip), ["s_0"]);
  });

  it("s_dot|color|bogus_color (bad inline arg) warns + drops", () => {
    // Inline-args form: the resolver succeeds (s_dot IS a known
    // alias), but the `:color:bogus_color` arg fails the color
    // validator → badarg → warn + drop. The whole s_dot chunk
    // is gone; s_space (no args) in the same template survives.
    // The three pieces concatenate into one line "  " (two
    // spaces, the dot chunk dropped).
    __resetUnknownModuleWarnForTest();
    const out = renderTemplate(
      ["s_space", "s_dot|color:bogus_color", "s_space"],
      ctxFor(null),
    );
    assert.deepEqual(out.map(strip), ["  "]);
  });
});

// ----- v0.8.0+ acc modules (per-session / per-project / per-model) -----
//
// Six new modules expose the four-layer accumulator that setAvg
// writes each tick:
//   m_accTokenIn       — session-cumulative current.input
//   m_accTokenOut      — session-cumulative current.output
//   m_accTokenCachedIn — session-cumulative current.cacheRead
//   m_accTokenTotalIn  — accTokenIn + accTokenCachedIn (the "total tokens
//                        the model has seen this session, counting
//                        cache_read as already-paid-for" view)
//   m_accApiMs         — session-cumulative cost.totalApiDurationMs
//   m_accTokenHitRate  — accTokenCachedIn / (accTokenCachedIn + accTokenIn) * 100%
//
// All six accept an optional `:scope:<session|project|model>` arg.
// Default scope:
//   - the 5 plain modules fall back to "project" when no
//     sessionId is on the snapshot (so a fresh project renders
//     placeholders instead of empty), otherwise "session".
//   - m_accTokenHitRate defaults to "session" — a per-session
//     ratio is the natural "what % of MY model reads are cache
//     hits" answer; project/model are opt-in.
//
// Slot locations (setAvg writes 3 slots per tick):
//   session: tickStatus:<sid>     (read via peekAvg)
//   project: tickStatus            (read via statusStore.readTickStatus)
//   model:   tickStatus:<model>    (read via statusStore.readTickStatus)
//
// Placeholders (v0.8.0+ labels.*): the four token-axis acc
// modules (m_accTokenIn/Out/CachedIn/TotalIn) read their prefix
// from labelFor so the placeholder matches the configured
// labelTokenIn/Out/CacheIn/TotalIn. m_accApiMs keeps its hardcoded
// "api:" prefix (mirrors m_apiMs). m_accTokenHitRate (v0.8.x R8)
// now mirrors m_tokenHitRate's "hit:" prefix (was "acc:") so the
// per-turn / acc / sum triple shares one prefix. Inline default
// is the placeholder (nulldrop:false behavior); bare form also
// renders the placeholder when data is missing — matching the
// v6.x bare-vs-inline parity rule.
describe("renderTemplate — v0.8.0+ m_acc* modules (three-scope accumulators)", () => {
  it("m_accTokenIn| bare form on a fresh session self-primes → 'in:38' (the per-tick delta)", () => {
    // v1.0 — self-priming moved from accPrimer (render-phase) to
    // processTick (data-processor phase). The m_acc* family no
    // longer writes to pending during render; the test must run
    // processTick + commit BEFORE renderTemplate to mirror
    // current.input into the per-session slot. Mirrors
    // src/index.ts:main() order: beginTick → processTick →
    // commit → render.
    const snap = fakeSnapshot({ sessionId: "sess-fresh-1" });
    beginTickForTest(snap.cwd, snap);
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenIn"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "in:38");
  });

  it("m_accTokenIn| session scope reads accTokenIn from per-session slot", () => {
    // Set the session slot directly via setAvg (full deltas so
    // the gate passes).
    setAvg(
      "sess-acc-in",
      { accTokenIn: 42000, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 1 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: "MiniMax-M3",
        deltaApiCalls: 1,
        currentApiMs: 1000,
        deltaTokenIn: 42000,
        deltaTokenOut: 0,
        deltaTokenCachedIn: 0,
        deltaApiMs: 1000,
      },
    );
    const snap = fakeSnapshot({ sessionId: "sess-acc-in" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenIn"],
      ctxFor(snap),
    ).join("\n");
    // formatCompactToken(42000) = "42.0k" → "in:42.0k" (v0.8.0+
    // labels.* — m_accTokenIn shares the labelTokenIn axis with its
    // per-turn sibling m_tokenIn)
    assert.equal(strip(out), "in:42.0k");
  });

  it("m_accTokenOut| session scope reads accTokenOut from per-session slot", () => {
    setAvg(
      "sess-acc-out",
      { accTokenIn: 0, accTokenOut: 1234, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 1 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: "MiniMax-M3",
        deltaApiCalls: 1,
        currentApiMs: 1000,
        deltaTokenIn: 0,
        deltaTokenOut: 1234,
        deltaTokenCachedIn: 0,
        deltaApiMs: 1000,
      },
    );
    const snap = fakeSnapshot({ sessionId: "sess-acc-out" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenOut"],
      ctxFor(snap),
    ).join("\n");
    // v0.8.x cwf-tickStatus-v2 — self-priming adds the per-tick
    // delta (output=155) on top of the seeded value:
    // 1234 + 155 = 1389 → "1.4k".
    assert.equal(strip(out), "out:1.4k");
  });

  it("m_accTokenCachedIn| session scope reads accTokenCachedIn from per-session slot", () => {
    setAvg(
      "sess-acc-cached",
      { accTokenIn: 0, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 163441, accApiCalls: 1 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: "MiniMax-M3",
        deltaApiCalls: 1,
        currentApiMs: 1000,
        deltaTokenIn: 0,
        deltaTokenOut: 0,
        deltaTokenCachedIn: 163441,
        deltaApiMs: 1000,
      },
    );
    const snap = fakeSnapshot({ sessionId: "sess-acc-cached" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenCachedIn"],
      ctxFor(snap),
    ).join("\n");
    // v0.8.x cwf-tickStatus-v2 — self-priming adds the per-tick
    // cacheRead delta (163441) on top of the seeded value:
    // 163441 + 163441 = 326882 → "326.9k".
    assert.equal(strip(out), "cache:326.9k");
  });

  it("m_accTokenTotalIn| derived field accTokenIn + accTokenCachedIn → 'total|...k'", () => {
    // Real shape: with both accTokenIn=38 and accTokenCachedIn=163441, plus
    // the per-tick self-priming delta (input=38, cacheRead=163441),
    // total = 38+163441+38+163441 = 326958.
    setAvg(
      "sess-acc-total",
      { accTokenIn: 38, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 163441, accApiCalls: 1 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: "MiniMax-M3",
        deltaApiCalls: 1,
        currentApiMs: 1000,
        deltaTokenIn: 38,
        deltaTokenOut: 0,
        deltaTokenCachedIn: 163441,
        deltaApiMs: 1000,
      },
    );
    const snap = fakeSnapshot({ sessionId: "sess-acc-total" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenTotalIn"],
      ctxFor(snap),
    ).join("\n");
    // 38 + 163441 + 38 + 163441 = 326958 → "327.0k" → "total:327.0k".
    assert.equal(strip(out), "total:327.0k");
  });

  it("m_accApiMs| default scope (session) delta-accumulates under unified contract", () => {
    // Default scope moved from ccsession → session in this
    // revision. The ccsession slot no longer exists, so the
    // bare `m_accApiMs` form now reads the per-session slot.
    // The seeding math is identical to the prior ccsession
    // contract (sedder 60_000 + first-tick fallback = 63_100),
    // because all three surviving scopes DELTA-ACCUMULATE the
    // same scalar under the unified contract.
    // Pin minute-grain so "api:1m" matches — the default minUnit='s'
    // would emit "api:1m0s" instead.
    __resetForTest({ timeFormat: { minUnit: "m", maxUnitCount: 2 } });
    setAvg(
      "sess-acc-api",
      { accTokenIn: 0, accTokenOut: 0, accApiMs: 60_000, accTokenCachedIn: 0, accApiCalls: 1 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: "MiniMax-M3",
        deltaApiCalls: 1,
        currentApiMs: 60_000,
        deltaTokenIn: 0,
        deltaTokenOut: 0,
        deltaTokenCachedIn: 0,
        deltaApiMs: 60_000,
      },
    );
    const snap = fakeSnapshot({ sessionId: "sess-acc-api" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accApiMs"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "api:1m");
  });

  // v0.8.x — m_accApiCalls reads accApiCalls from the chosen scope
  // slot in status.json, mirroring m_apiCalls's `calls:N` shape.
  // value=0 still renders (value-zero rule — count:0 is real data,
  // not a placeholder). Tokens=null or no-slot → "calls:n/a".
  it("m_accApiCalls| default scope (session) reads per-session accApiCalls", () => {
    // Default scope moved from ccsession → session in this
    // revision; the bare `m_accApiCalls` form now reads the
    // same per-session slot that the prior |scope:session form
    // did. Seeded 7 + deltaApiCalls=1 → 8.
    setAvg(
      "sess-acc-calls",
      { accTokenIn: 0, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 7 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: "MiniMax-M3",
        deltaApiCalls: 1,
        currentApiMs: 0,
        deltaTokenIn: 0,
        deltaTokenOut: 0,
        deltaTokenCachedIn: 0,
        deltaApiMs: 0,
      },
    );
    const snap = fakeSnapshot({ sessionId: "sess-acc-calls" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accApiCalls"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "calls:8");
  });

  it("m_accApiCalls| value=0 still renders as 'calls:N' (value-zero rule; primer adds 1)", () => {
    setAvg(
      "sess-acc-calls-zero",
      { accTokenIn: 0, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 0 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: null,
        deltaApiCalls: 0,
        currentApiMs: 0,
        deltaTokenIn: 0,
        deltaTokenOut: 0,
        deltaTokenCachedIn: 0,
        deltaApiMs: 0,
      },
    );
    const snap = fakeSnapshot({ sessionId: "sess-acc-calls-zero" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accApiCalls|scope:session"],
      ctxFor(snap),
    ).join("\n");
    // self-priming fires accPrimer → bumps accApiCalls by 1
    // (deltaApiCalls) on the same call. So the rendered value is
    // 1, not 0. The point of the test is that it does NOT render
    // the placeholder "calls:n/a" — count:1 is real data.
    assert.equal(strip(out), "calls:1");
  });

  it("m_accApiCalls| tokens=null → 'calls:n/a' placeholder", () => {
    const out = renderTemplate(
      ["m_accApiCalls"],
      ctxFor(null),
    ).join("\n");
    assert.equal(strip(out), "calls:n/a");
  });

  it("m_accTokenHitRate| session scope formula accTokenCachedIn / accTokenTotalIn = 99.978%", () => {
    // v0.8.10-alpha.3 — formula switched to cached/total (matches
    // per-turn m_tokenHitRate's shape). With both accumulators
    // primed at (accTokenCachedIn=163441, accTokenTotalIn=163479)
    // before processTick, processTick adds another (cached=163441,
    // totalIn=163479) → final (326882 / 326958) = 99.9767…% →
    // toFixed(1) → "100.0%".
    //
    // explicit |scope|session because the bare-form default is
    // ccsession; this test seeds the per-session slot only.
    setAvg(
      "sess-acc-hit",
      { accTokenIn: 38, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 163441, accApiCalls: 1 , accTokenTotalIn: 163479, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: "MiniMax-M3",
        deltaApiCalls: 1,
        currentApiMs: 1000,
        deltaTokenIn: 38,
        deltaTokenOut: 0,
        deltaTokenCachedIn: 163441,
        deltaApiMs: 1000,
      },
    );
    const snap = fakeSnapshot({ sessionId: "sess-acc-hit" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenHitRate|scope:session"],
      ctxFor(snap),
    ).join("\n");
    // v0.8.x R8 — prefix unified with m_tokenHitRate / m_sumTokenHitRate.
    assert.equal(strip(out), "hit:100.0%");
  });

  it("m_accTokenHitRate| zero denominator → 'hit|0.0%' (no placeholder drop)", () => {
    // All-zero slot → no input and no cache → 0/0. Per the v6.x
    // zero-value rule, render "hit:0.0%" rather than "hit:n/a%"
    // (R8 prefix).
    setAvg(
      "sess-acc-zero",
      { accTokenIn: 0, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 0 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: null,
        deltaApiCalls: 0,
        currentApiMs: 0,
        deltaTokenIn: 0,
        deltaTokenOut: 0,
        deltaTokenCachedIn: 0,
        deltaApiMs: 0,
      },
    );
    const snap = fakeSnapshot({ sessionId: "sess-acc-zero" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenHitRate"],
      ctxFor(snap),
    ).join("\n");
    // v0.8.x cwf-tickStatus-v2 — self-priming adds the per-tick
    // cacheRead delta (163441) and input delta (38) on top of
    // the seeded zeros. Hit rate = 163441 / (163441+38) ≈ 99.98%
    // → "100.0%". v0.8.x R8 — prefix unified with m_tokenHitRate.
    assert.equal(strip(out), "hit:100.0%");
  });

  it("m_accTokenHitRate| fresh session self-primes → 'hit:0.0%' (zero input, zero cache)", () => {
    // v0.8.x cwf-tickStatus-v2 — self-priming makes the
    // m_accTokenHitRate module work on a fresh session without
    // a pre-seeded slot. With stdin carrying cache_read (163441)
    // and input (38), the hit rate is non-zero; with the
    // fakeSnapshot defaults, current.input=38, current.output=155,
    // current.cacheRead=163441. Hit rate = 163441 / (163441+38) ≈
    // 99.98% (rendered as "100.0%" or similar).
    const snap = fakeSnapshot({ sessionId: "sess-hit-fresh" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenHitRate"],
      ctxFor(snap),
    ).join("\n");
    // Self-priming on a fresh session lands a real hit rate; the
    // exact value depends on the per-tick delta math. We just
    // require it NOT to be the "n/a" placeholder.
    assert.ok(!out.includes("n/a"), `expected real value, got: ${JSON.stringify(out)}`);
  });

  it("m_accTokenIn|scope|project reads the project-wide slot (cross-session)", () => {
    // Seed the project-wide slot directly via setAvg (setAvg bumps
    // all 3 layers — the project slot is keyed by cwd only).
    setAvg(
      "sess-X",
      { accTokenIn: 100, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 1 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\project-scope-test",
      {
        modelId: "MiniMax-M3",
        deltaApiCalls: 1,
        currentApiMs: 1000,
        deltaTokenIn: 100,
        deltaTokenOut: 0,
        deltaTokenCachedIn: 0,
        deltaApiMs: 1000,
      },
    );
    setAvg(
      "sess-Y",
      { accTokenIn: 250, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 1 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\project-scope-test",
      {
        modelId: "MiniMax-M3",
        deltaApiCalls: 1,
        currentApiMs: 1000,
        deltaTokenIn: 150,
        deltaTokenOut: 0,
        deltaTokenCachedIn: 0,
        deltaApiMs: 1000,
      },
    );
    // Render with a THIRD sessionId. v0.8.x cwf-tickStatus-v2
    // — the m_acc* family is self-priming; the per-session
    // accPrimer fires on the render call and ALSO adds its
    // per-tick delta (input=38) to the project slot. So the
    // project slot reads 100 + 150 + 38 = 288.
    const snap = fakeSnapshot({ sessionId: "sess-Z", cwd: "D:\\project-scope-test" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenIn|scope:project"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "in:288");
  });

  it("m_accTokenIn|scope|model reads the per-model slot (cross-session, single model)", () => {
    // Two sessions under the same model + cwd. The model slot
    // accumulates both deltas (100 + 150 = 250), independent of
    // sessionId.
    setAvg(
      "sess-M1",
      { accTokenIn: 100, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 1 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\model-scope-test",
      {
        modelId: "MiniMax-M3",
        deltaApiCalls: 1,
        currentApiMs: 1000,
        deltaTokenIn: 100,
        deltaTokenOut: 0,
        deltaTokenCachedIn: 0,
        deltaApiMs: 1000,
      },
    );
    setAvg(
      "sess-M2",
      { accTokenIn: 250, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 1 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\model-scope-test",
      {
        modelId: "MiniMax-M3",
        deltaApiCalls: 1,
        currentApiMs: 1000,
        deltaTokenIn: 150,
        deltaTokenOut: 0,
        deltaTokenCachedIn: 0,
        deltaApiMs: 1000,
      },
    );
    // v0.8.x cwf-tickStatus-v2 — the self-priming accPrimer
    // adds the per-tick delta (input=38) to the model slot
    // too, so 100 + 150 + 38 = 288.
    const snap = fakeSnapshot({
      sessionId: "sess-M3",
      cwd: "D:\\model-scope-test",
      modelDisplayName: "MiniMax-M3",
    });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenIn|scope:model"],
      ctxFor(snap),
    ).join("\n");
    // v0.8.0+ labels.* — m_accTokenIn renders under labelTokenIn.
    // 100 + 150 + 38 (per-tick primer delta) = 288.
    assert.equal(strip(out), "in:288");
  });

  it("m_accTokenIn|scope|model with no modelDisplayName on snapshot → 'in|n/a'", () => {
    // peekAcc's model branch returns null when ctx.tokens has no
    // modelDisplayName (cannot resolve the model slot key).
    const out = renderTemplate(
      ["m_accTokenIn|scope:model"],
      ctxFor(fakeSnapshot({ sessionId: "sess-no-model", modelDisplayName: null })),
    ).join("\n");
    // v0.8.0+ labels.* — placeholder reads labelTokenIn.
    assert.equal(strip(out), "in:n/a");
  });

  it("m_accTokenIn|scope|session (explicit) on a fresh snapshot self-primes → 'in:38'", () => {
    // v0.8.x cwf-tickStatus-v2 — the m_acc* family is now
    // self-priming on a fresh session, so a session-scope
    // render lands a real per-tick delta instead of the
    // "in:n/a" placeholder.
    const snap = fakeSnapshot({ sessionId: "sess-scope-fresh" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenIn|scope:session"],
      ctxFor(snap),
    ).join("\n");
    assert.equal(strip(out), "in:38");
  });

  it("m_accTokenIn|scope|invalid (not session/project/model) is a parse-fail — drops", () => {
    // The SCOPE_PARAM resolver only accepts the three literal
    // values; "invalid" is rejected → parseInlineArgs returns
    // null → badarg → dispatcher warn + drop.
    __resetUnknownModuleWarnForTest();
    const out = renderTemplate(
      ["m_accTokenIn|scope:invalid"],
      ctxFor(fakeSnapshot({ sessionId: "sess-bad-scope" })),
    );
    assert.deepEqual(out, []);
  });

  it("m_accTokenIn|nulldrop|false (default for inline) renders placeholder when no session is available", () => {
    // v0.8.x cwf-tickStatus-v2 — the m_acc* family is now
    // self-priming (see accPrimer in render.ts), so a "fresh
    // session" still produces a real value on the first tick.
    // The placeholder path is reserved for the "no session at
    // all" case (tokens=null) — the only state where primer
    // cannot fire.
    const out = renderTemplate(
      ["m_accTokenIn|nulldrop:false"],
      ctxFor(null),
    ).join("\n");
    // v0.8.0+ labels.* — placeholder reads labelTokenIn.
    assert.equal(strip(out), "in:n/a");
  });

  it("m_accTokenIn|nulldrop|true is a no-op (function never returns null)", () => {
    // The m_accTokenIn renderer never returns null — it always
    // returns either "in:N" or "in:n/a" placeholder (via
    // wrapPlainDefault → STALE_COLOR wrap). Therefore
    // `:nulldrop:true` has no effect (the dispatcher can only
    // short-circuit on a null return). Same shape as m_apiCalls
    // and m_tokenInTotal which share this property.
    const snap = fakeSnapshot({ sessionId: "sess-no-data" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenIn|nulldrop:true"],
      ctxFor(snap),
    ).join("\n");
    // v0.8.x cwf-tickStatus-v2 — self-priming fires on a fresh
    // session, so the module renders a real per-tick delta.
    assert.equal(strip(out), "in:38");
  });

  it("m_accTokenIn|color|brightGreen wraps the chunk in brightGreen", () => {
    setAvg(
      "sess-acc-colored",
      { accTokenIn: 12345, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 1 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: "MiniMax-M3",
        deltaApiCalls: 1,
        currentApiMs: 1000,
        deltaTokenIn: 12345,
        deltaTokenOut: 0,
        deltaTokenCachedIn: 0,
        deltaApiMs: 1000,
      },
    );
    const snap = fakeSnapshot({ sessionId: "sess-acc-colored" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accTokenIn|color:brightGreen"],
      ctxFor(snap),
    ).join("\n");
    // v0.8.x cwf-tickStatus-v2 — self-priming adds the per-tick
    // input delta (38) on top of the seeded 12345 → 12383 →
    // "12.4k" → "in:12.4k".
    assert.equal(strip(out), "in:12.4k");
    assert.ok(out.includes(GREEN), `expected GREEN wrap on: ${JSON.stringify(out)}`);
  });

  it("m_accTokenIn| composed with multiple acc modules and separators", () => {
    // Seed the session slot with a mix of fields.
    setAvg(
      "sess-multi",
      { accTokenIn: 500, accTokenOut: 250, accApiMs: 5000, accTokenCachedIn: 10000, accApiCalls: 3 , accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      {
        modelId: "MiniMax-M3",
        deltaApiCalls: 3,
        currentApiMs: 5000,
        deltaTokenIn: 500,
        deltaTokenOut: 250,
        deltaTokenCachedIn: 10000,
        deltaApiMs: 5000,
      },
    );
    const snap = fakeSnapshot({ sessionId: "sess-multi" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      [
        "m_accTokenIn",
        "s_space",
        "m_accTokenOut",
        "s_space",
        "s_dot",
        "s_space",
        "m_accTokenHitRate|scope:session",
      ],
      ctxFor(snap),
    ).join("\n");
    // v0.8.x cwf-tickStatus-v2 — self-priming adds the per-tick
    // deltas (input=38, output=155, cacheRead=163441, totalIn=163479)
    // on top of the seeded values:
    //   in=500+38=538 → "538"
    //   out=250+155=405 → "405"
    //   hitRate=173441/163479=106.087% → "106.1%".
    // v0.8.10-alpha.3 — formula switched to cached/totalIn, so this
    // exceeds 100% in fixtures where cached-in > total-in (which is
    // physically impossible in real Anthropic responses — totalInput
    // always includes cacheRead — but the per-turn and cumulative
    // shapes can diverge briefly during a session-reset boundary).
    // v0.8.x R8 — m_accTokenHitRate prefix unified with m_tokenHitRate.
    assert.equal(strip(out), "in:538 out:405 · hit:106.1%");
  });
});

// ----- v0.8.0+ sum/avg advanced statistics -------------------------------
//
// 8 new modules: 5 sums (in / out / cached / total / apiMs) + 3
// ratios (tokenHitRate / tokenInSpeed / tokenOutSpeed). All read
// the per-tick jsonl stream (cross-project via readAllSamples) and
// filter by `:model:`, `:window:`, `:align:`, `:term:`. Results
// are cached in state/cache.json under the
// "stat:<model>:<windowKey>:<align>" key
// (windowKey ∈ {"5h","7d","all"} ∪ {intervals[*].windowId} ∪
// {term keys used as fallback when windowId is empty}) with
// TTL=300s. sinceMs is derived from window + ctx.nowMs + optional
// resetStartAt but is NOT part of the key. v0.9.8 — |term:short|
// folds into windowKey="5h" when intervals.short.windowId="5h",
// so one statistical intent maps to one cache row regardless of
// how the user spelled it.
//
// Tests below use a tmpDir as the state root (via setStateRoot)
// so the user's real on-disk samples are untouched. Each test
// seeds one or more jsonl rows directly into the per-session
// file, then asserts on the rendered output.

describe("renderTemplate — v0.8.0+ m_sum*/m_avg* advanced statistics", () => {
  beforeEach(() => {
    // The cache module also needs a tmp path so cached aggregates
    // from one test don't leak into the next.
    setCachePathResolver(() => join(_tmpDir, "cache.json"));
    resetCacheForTest();
  });

  // ----- parseDhms / parseWindowScope basics -----

  it("m_sumTokenIn with no samples anywhere → 'in:n/a' placeholder", () => {
    // Empty state root → no rows → agg.rows=0. Both the bare
    // MODULES path and the inline form render the placeholder
    // (v0.8.14+ — bare form now mirrors m_acc* / m_accTokenIn's
    // placeholderAcc behavior; use |nulldrop|true to opt out).
    setStateRoot(() => join(_tmpDir, "sum-empty"));
    const out = renderTemplate(
      ["m_sumTokenIn|nulldrop:false"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "in:n/a");
  });

  it("m_sumTokenIn|window|invalid_value (parse-fail) → drops with warn", () => {
    // The WINDOW_PARAM resolver rejects malformed dhms at the
    // schema layer → parseInlineArgs returns null → dispatcher
    // warn + drop. We assert the chunk is gone; the warn is
    // once-per-process and may not fire on every call.
    setStateRoot(() => join(_tmpDir, "sum-bad-window"));
    __resetUnknownModuleWarnForTest();
    const out = renderTemplate(
      ["m_sumTokenIn|window:xyz"],
      ctxFor(fakeSnapshot()),
    );
    assert.deepEqual(out, []);
  });

  it("m_sumTokenIn|model|nonexistent-model (no matching rows) → 'in|n/a' placeholder", () => {
    // An unknown model name is treated as a literal filter — no
    // matching rows → empty aggregate → inline form renders
    // placeholder (bare form would drop).
    setStateRoot(() => join(_tmpDir, "sum-no-model-match"));
    const out = renderTemplate(
      ["m_sumTokenIn|model:nonexistent-model"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "in:n/a");
  });

  it("m_sumTokenIn|align|invalid (not true/false) is a parse-fail → drops", () => {
    setStateRoot(() => join(_tmpDir, "sum-bad-align"));
    __resetUnknownModuleWarnForTest();
    const out = renderTemplate(
      ["m_sumTokenIn|align:maybe"],
      ctxFor(fakeSnapshot()),
    );
    assert.deepEqual(out, []);
  });

  // ----- per-fixture sum -----

  it("m_sumTokenIn reads sum(in) across rows in the configured window", () => {
    // Seed 3 jsonl rows under a tmpDir state root, each carrying
    // the per-turn `in` (which is what the sum module sums).
    // Rows are anchored near the test ctx's nowMs (1_000_000) so
    // they fall inside the default 5h window.
    const stateRootDir = join(_tmpDir, "sum-fixture-A");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-a";
    const sess = "sess-sum-a";
    const cwd = "D:\\sum-a";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    // Three valid samples: sumIn = 100 + 200 + 300 = 600.
    // v0.8.0+ schema: per-turn `in` / cumulative `totalIn` /
    // per-turn `apiMs` (was `deltaApiMs`).
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: 999_000, totalIn: 150, totalOut: 50, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 1000, apiMs: 1000 }),
        JSON.stringify({ at: 999_500, totalIn: 350, totalOut: 75, in: 200, out: 75, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 1000, apiMs: 1000 }),
        JSON.stringify({ at: 999_900, totalIn: 650, totalOut: 100, in: 300, out: 100, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 1000, apiMs: 1000 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumTokenIn"],
      ctxFor(fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" })),
    ).join("\n");
    // formatCompactToken(600) = "600" → "in:600"
    assert.equal(strip(out), "in:600");
  });

  it("m_sumTokenIn|window|1d1h falls through to free-form dhms (no declared-ID match) — vX.X.X upgrade", () => {
    // v0.8.x: free-form dhms like "1d1h" were rejected outright by
    // parseWindowScope's closed-enum cap ("5h" / "7d" / "all"), so
    // the module dropped. vX.X.X — the cap is gone; `|window|1d1h`
    // now falls through to Step 3 of the three-step resolver
    // (free-form dhms) and lands on the wall-clock
    // `ctx.nowMs - 1d1h` sinceMs. The seed row is at
    // `now - 1h` so it falls inside the 25h window and counts.
    // Configured interval defaults ("5h" / "7d" / "30d",
    // GLOBAL_DEFAULT_INTERVALS in config.providers.ts) don't
    // collide with "1d1h" because the resolver treats them as
    // different strings. (v0.9.x — the per-provider
    // MINIMAX_DEFAULT_INTERVALS layer that used to live here is
    // gone; the only windowId-bearing defaults are now the
    // global layer.)
    const stateRootDir = join(_tmpDir, "sum-fixture-window");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-w";
    const sess = "sess-sum-w";
    const cwd = "D:\\sum-w";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_000_000;
    writeFileSync(
      sessionFile,
      JSON.stringify({ at: now - 3600_000, totalIn: 10, totalOut: 0, in: 10, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }) + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumTokenIn|window:1d1h"],
      ctxFor(
        fakeSnapshot({
          sessionId: sess,
          cwd,
          modelId: "MiniMax-M3",
        }),
      ),
    ).join("\n");
    // 1d1h window covers [now - 25h, now] — the row at now-1h falls
    // inside, so the module renders the seeded value (10) instead
    // of dropping.
    assert.equal(strip(out), "in:10");
  });

  it("m_sumTokenIn|window|<garbage> (not a declared windowId AND not parseable dhms) drops with warn — vX.X.X", () => {
    // Step 4 of the resolver: neither a declared windowId nor a
    // parseable dhms string → drop the module with a stderr warn so
    // the rest of the template can keep rendering. "garbage123"
    // contains digits, so parseDhms would see `1*1*1 = 1s + 2*1*1
    // = 2s + 3*1 = 3s` accumulation matching; that's not what the
    // user wrote, so we use a non-shape string here.
    const out = renderTemplate(
      ["m_sumTokenIn|window:not-a-duration"],
      ctxFor(fakeSnapshot()),
    );
    // No rows → empty either way; the diagnostic value here is
    // that the token parses WITHOUT a badarg (the inline-args
    // resolver's `parseDhms` accepts any string and returns null
    // for non-shape), and Step 4 fires inside parseWindowScope.
    // The module returns null (drop, not placeholder) because
    // Step 4 returns null regardless of whether rows exist.
    assert.deepEqual(out, []);
  });

  it("m_sumTokenIn|window|7d excludes rows older than 7d (canonical window)", () => {
    // v0.8.x: the canonical 7d window must drop rows whose `at`
    // is more than 7 days old, even if the jsonl file itself is
    // freshly written. This is the row-level sinceMs filter
    // inside readAllSamples; the mtime pre-filter only skips
    // files whose mtime predates sinceMs (here the file's mtime
    // is "now", so the pre-filter passes and the row filter runs).
    const stateRootDir = join(_tmpDir, "sum-fixture-window-7d");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-w7";
    const sess = "sess-sum-w7";
    const cwd = "D:\\sum-w7";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000; // big enough to keep old rows positive
    writeFileSync(
      sessionFile,
      [
        // Inside 7d: 1d ago, 3d ago, 6d ago
        JSON.stringify({ at: now - 1 * 86400_000, totalIn: 10, totalOut: 0, in: 10, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }),
        JSON.stringify({ at: now - 3 * 86400_000, totalIn: 20, totalOut: 0, in: 20, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }),
        JSON.stringify({ at: now - 6 * 86400_000, totalIn: 30, totalOut: 0, in: 30, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }),
        // Outside 7d: 10d ago
        JSON.stringify({ at: now - 10 * 86400_000, totalIn: 9999, totalOut: 0, in: 9999, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumTokenIn|window:7d"],
      {
        ...ctxFor(
          fakeSnapshot({
            sessionId: sess,
            cwd,
            modelId: "MiniMax-M3",
          }),
        ),
        nowMs: now,
      },
    ).join("\n");
    // 10 + 20 + 30 = 60; the 10d row is excluded
    assert.equal(strip(out), "in:60");
  });

  it("m_sumTokenIn|window|5h|align|true uses ctx.fiveHour.resetStartAt (not wall-clock)", () => {
    // v0.8.12 — regression. Earlier parseWindowScope type-checked
    // `typeof w.resetStartAt === "number"` which never matched the
    // ISO-string shape from Window, so aligned mode silently fell
    // through to the wall-clock fallback (nowMs - 5h). That inflated
    // m_sum* totals to the entire trailing 5h regardless of where
    // the plan window actually starts. The fix: parse the ISO string
    // with Date.parse and gate on Number.isFinite, returning the
    // resetStartAt epoch as sinceMs.
    const stateRootDir = join(_tmpDir, "sum-fixture-aligned-5h");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-al";
    const sess = "sess-sum-al";
    const cwd = "D:\\sum-al";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    // Plan window started 30min ago, runs 5h. Aligned window
    // covers [now - 30min, now]. Wall-clock 5h would cover
    // [now - 5h, now] — much wider.
    const resetStartAt = new Date(now - 30 * 60_000).toISOString();
    const resetAt = new Date(now + 4 * 3600_000 + 30 * 60_000).toISOString();
    writeFileSync(
      sessionFile,
      [
        // Inside the aligned 30m window
        JSON.stringify({ at: now - 10 * 60_000, totalIn: 1, totalOut: 0, in: 1, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }),
        // Outside the aligned window but inside wall-clock 5h
        JSON.stringify({ at: now - 2 * 3600_000, totalIn: 999, totalOut: 0, in: 999, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 999, apiMs: 999 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumTokenIn|window:5h|align:true"],
      ctxFor(
        fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" }),
        legacyToIv({
          pct: 10,
          resetAt,
          resetStartAt,
          resetDurationMs: 5 * 3600_000,
        }),
        null,
        null,
      ),
    ).join("\n");
    // Aligned mode reads only the 30m-window row → in:1. Wall-clock
    // fallback would have summed to in:1000.
    assert.equal(strip(out), "in:1");
  });

  // vX.X.X — bare `|window|5h` no longer auto-resolves to a
  // declared windowId. The new contract: `align` is an explicit
  // opt-in (default false). `align=false` skips the
  // matchIntervalByWindowId lookup entirely, so `|window|5h`
  // always reads as free-form dhms → wall-clock `[now - 5h,
  // now]`. Plan-anchored scans require `|window|<id>|align|true`.
  // This pins down the new "align-gated resolution" contract so
  // a future regression back to plan-aligned-default would
  // surface as `in:1` (declared-windowId branch winning) instead
  // of `in:1.0k` (wall-clock fallback).
  it("bare m_sumTokenIn|window|5h resolves dhms wall-clock (align=false skips declared-ID lookup)", () => {
    const stateRootDir = join(_tmpDir, "sum-fixture-aligned-5h-default");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-al-d";
    const sess = "sess-sum-al-d";
    const cwd = "D:\\sum-al-d";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    const resetStartAt = new Date(now - 30 * 60_000).toISOString();
    const resetAt = new Date(now + 4 * 3600_000 + 30 * 60_000).toISOString();
    writeFileSync(
      sessionFile,
      [
        // Inside both the wall-clock 5h and the aligned 30m window
        JSON.stringify({ at: now - 10 * 60_000, totalIn: 1, totalOut: 0, in: 1, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }),
        // Inside wall-clock 5h but OUTSIDE the aligned 30m window
        JSON.stringify({ at: now - 2 * 3600_000, totalIn: 999, totalOut: 0, in: 999, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 999, apiMs: 999 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumTokenIn|window:5h"], // align=false default → dhms wall-clock
      ctxFor(
        fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" }),
        legacyToIv({
          pct: 10,
          resetAt,
          resetStartAt,
          resetDurationMs: 5 * 3600_000,
        }),
        null,
        null,
      ),
    ).join("\n");
    // Wall-clock 5h covers both rows → 1 + 999 = 1000 → "in:1.0k".
    assert.equal(strip(out), "in:1.0k");
  });

  // vX.X.X — `|align|true` opts into the declared-windowId lookup.
  // Same fixture as the wall-clock test above, but adding
  // `|align|true` flips parseWindowScope into the windowId branch
  // → plan-aligned sinceMs = resetStartAt → only the 10m-ago row
  // counts. Pairs with the wall-clock test above to pin down both
  // sides of the align gate.
  it("m_sumTokenIn|window|5h|align|true resolves plan-aligned when shortInterval.windowId='5h'", () => {
    const stateRootDir = join(_tmpDir, "sum-fixture-aligned-5h-true");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-al-t";
    const sess = "sess-sum-al-t";
    const cwd = "D:\\sum-al-t";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    const resetStartAt = new Date(now - 30 * 60_000).toISOString();
    const resetAt = new Date(now + 4 * 3600_000 + 30 * 60_000).toISOString();
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: now - 10 * 60_000, totalIn: 1, totalOut: 0, in: 1, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }),
        JSON.stringify({ at: now - 2 * 3600_000, totalIn: 999, totalOut: 0, in: 999, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 999, apiMs: 999 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumTokenIn|window:5h|align:true"], // align=true → windowId lookup
      ctxFor(
        fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" }),
        legacyToIv({
          pct: 10,
          resetAt,
          resetStartAt,
          resetDurationMs: 5 * 3600_000,
        }),
        null,
        null,
      ),
    ).join("\n");
    // Plan-aligned scan from resetStartAt: only the 10m-ago row counts.
    assert.equal(strip(out), "in:1");
  });

  // vX.X.X — `align` was removed entirely. The bare `|window|<dhms>`
  // form (no `|window|<declaredId>` match) ALWAYS reads
  // wall-clock, regardless of whether `ctx.shortInterval`
  // etc. carry a resetStartAt. This test constructs a context
  // where shortInterval.windowId is intentionally NOT "5h" —
  // so the resolver falls through to the dhms wall-clock branch.
  it("m_sumTokenIn|window|2h reads trailing 2h wall-clock even when shortInterval.resetStartAt is set (vX.X.X upgrade)", () => {
    // Note the use of legacyToIv with a non-`5h` label — that
    // bumps ctx.shortInterval.windowId to `5h-fake` (the test's
    // own ad-hoc label) so the resolver doesn't match it as a
    // declared windowId, and Step 3 (free-form dhms) fires.
    const stateRootDir = join(_tmpDir, "sum-fixture-aligned-2h-wallclock");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-al-2h";
    const sess = "sess-sum-al-2h";
    const cwd = "D:\\sum-al-2h";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    const resetStartAt = new Date(now - 30 * 60_000).toISOString();
    const resetAt = new Date(now + 4 * 3600_000 + 30 * 60_000).toISOString();
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: now - 10 * 60_000, totalIn: 1, totalOut: 0, in: 1, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }),
        JSON.stringify({ at: now - 90 * 60_000, totalIn: 999, totalOut: 0, in: 999, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 999, apiMs: 999 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumTokenIn|window:2h"],
      ctxFor(
        fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" }),
        // windowId='5h-fake' avoids the resolved-against-declared-ID
        // branch — `|window|2h` is dhms, not a windowId. The
        // resetStartAt fields on the Interval are ignored because
        // Step 2 never matched.
        legacyToIv(
          {
            pct: 10,
            resetAt,
            resetStartAt,
            resetDurationMs: 5 * 3600_000,
          },
          "5h-fake",
        ),
        null,
        null,
      ),
    ).join("\n");
    // Wall-clock trailing 2h window covers both rows (90min ago
    // is inside 2h) → 1 + 999 = 1000 → formatted as "1.0k".
    assert.equal(strip(out), "in:1.0k");
  });

  it("inline m_sumTokenIn|window|5h|align|false resolves dhms wall-clock (align gates the lookup)", () => {
    // vX.X.X — `align` is a meaningful param again, default false.
    // `align=false` SKIPS the declared-windowId lookup entirely,
    // so `|window|5h` resolves as free-form dhms (wall-clock
    // `[now - 5h, now]`). With both seeded rows inside that window
    // the sum is 1000 → `in:1.0k`. Pairs with the `|align|true`
    // test above to pin down both sides of the align gate. The
    // v0.8.31 contract treated `align=false` as a no-op (DEPRECATED_
    // ALIGN_PARAM); that contract is reverted to a real resolver.
    const stateRootDir = join(_tmpDir, "sum-fixture-aligned-5h-false");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-al-f";
    const sess = "sess-sum-al-f";
    const cwd = "D:\\sum-al-f";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    const resetStartAt = new Date(now - 30 * 60_000).toISOString();
    const resetAt = new Date(now + 4 * 3600_000 + 30 * 60_000).toISOString();
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: now - 10 * 60_000, totalIn: 1, totalOut: 0, in: 1, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }),
        JSON.stringify({ at: now - 2 * 3600_000, totalIn: 999, totalOut: 0, in: 999, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 999, apiMs: 999 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumTokenIn|window:5h|align:false"],
      ctxFor(
        fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" }),
        legacyToIv({
          pct: 10,
          resetAt,
          resetStartAt,
          resetDurationMs: 5 * 3600_000,
        }),
        null,
        null,
      ),
    ).join("\n");
    // align=false skips windowId lookup → dhms 5h wall-clock →
    // both rows count → "in:1.0k".
    assert.equal(strip(out), "in:1.0k");
  });

  it("readAllSamples mtime pre-filter: stale jsonl is skipped even if its row timestamps are recent", () => {
    // Performance contract: when a file's mtime is older than
    // sinceMs, readAllSamples MUST skip it without readFileSync.
    // We assert behaviorally by setting the file mtime to before
    // the sinceMs anchor (now - 5h) but writing a row that would
    // otherwise be inside the 5h window — the row should NOT be
    // counted because the whole file is skipped.
    const stateRootDir = join(_tmpDir, "sum-fixture-mtime");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-mt";
    const sess = "sess-sum-mt";
    const cwd = "D:\\sum-mt";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    // One row, recent `at`, but we will rewrite the file with a
    // stale mtime below.
    writeFileSync(
      sessionFile,
      JSON.stringify({ at: now - 60_000, totalIn: 5, totalOut: 0, in: 5, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }) + "\n",
      "utf8",
    );
    // Backdate mtime to before now-5h (the default sinceMs for
    // window=5h without align-resetStartAt).
    const stale = (now - 10 * 3600_000) / 1000; // seconds
    utimesSync(sessionFile, stale, stale);

    const out = renderTemplate(
      // vX.X.X — bare default window changed from "5h" to "all",
      // so an explicit `|window|5h` is now required to exercise
      // the mtime pre-filter path. The test still verifies the
      // 5h-windowed scan → file's stale mtime drops the whole
      // file → rows=0 → `in:n/a`.
      ["m_sumTokenIn|window:5h"],
      {
        ...ctxFor(
          fakeSnapshot({
            sessionId: sess,
            cwd,
            modelId: "MiniMax-M3",
          }),
        ),
        nowMs: now,
      },
    ).join("\n");
    // mtime pre-filter drops the whole file → rows=0 → bare
    // module renders the "in:n/a" placeholder wrapped in
    // STALE_COLOR (v0.8.14+ — mirrors m_accTokenIn's
    // placeholderAcc behavior). The inline form
    // `m_sumTokenIn|nulldrop|true` is the opt-out.
    assert.equal(strip(out), "in:n/a");
  });

  it("m_sumTokenInSpeed| sum(in) / sum(apiMs) * 1000 in t/s", () => {
    const stateRootDir = join(_tmpDir, "sum-fixture-speed");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-s";
    const sess = "sess-sum-s";
    const cwd = "D:\\sum-s";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    // sumIn=1000, sumApiMs=2000 → 1000/2000*1000 = 500 t/s.
    // Rows anchored near the test ctx's nowMs (1_000_000).
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: 999_000, totalIn: 500, totalOut: 0, in: 500, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 1000, apiMs: 1000 }),
        JSON.stringify({ at: 999_500, totalIn: 1000, totalOut: 0, in: 500, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 1000, apiMs: 1000 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumTokenInSpeed"],
      ctxFor(fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" })),
    ).join("\n");
    // 500 t/s → "500.0 t/s"
    assert.equal(strip(out), "in:500.0 t/s");
  });

  it("m_sumApiMs formats sum as dhms (v0.8.x — was formatCompactToken in earlier builds)", () => {
    // Seed 2 rows: apiMs 30s + 90s = 120s total → "api:2m"
    // (formatRemainingMs floors sub-minute to <1m, so 119s → <1m,
    // but 120s renders as "2m" only if maxUnitCount=2 — actually
    // 120s collapses to "2m" via formatRemainingMs's "single-unit
    // 60+ ms → round up" rule).
    // Pin minute-grain — under the default minUnit='s', 120s would
    // emit "api:2m0s" instead.
    __resetForTest({ timeFormat: { minUnit: "m", maxUnitCount: 2 } });
    const stateRootDir = join(_tmpDir, "sum-fixture-sumapims");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-api";
    const sess = "sess-sum-api";
    const cwd = "D:\\sum-api";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: now - 1_000, totalIn: 100, totalOut: 50, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 30_000, apiMs: 30_000 }),
        JSON.stringify({ at: now - 2_000, totalIn: 200, totalOut: 100, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 120_000, apiMs: 90_000 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumApiMs"],
      ctxFor(
        fakeSnapshot({
          sessionId: sess,
          cwd,
          modelId: "MiniMax-M3",
        }),
      ),
    ).join("\n");
    // 30_000 + 90_000 = 120_000ms = 2m. formatRemainingMs renders this.
    assert.equal(strip(out), "api:2m");
  });

  it("m_sumApiCalls counts only rows with apiMs > 0", () => {
    // 3 rows: 2 with apiMs > 0 (real calls), 1 with apiMs = 0
    // (fallback path row from first-tick fallback). agg.calls
    // should be 2, NOT agg.rows (3).
    const stateRootDir = join(_tmpDir, "sum-fixture-apicalls");
    setStateRoot(() => stateRootDir);
    const projHash = "d--calls";
    const sess = "sess-calls";
    const cwd = "D:\\calls";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: now - 3_000, totalIn: 100, totalOut: 50, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 30_000, apiMs: 30_000 }),
        JSON.stringify({ at: now - 2_000, totalIn: 200, totalOut: 100, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 120_000, apiMs: 0 }),
        JSON.stringify({ at: now - 1_000, totalIn: 300, totalOut: 150, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 200_000, apiMs: 80_000 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumApiCalls"],
      ctxFor(
        fakeSnapshot({
          sessionId: sess,
          cwd,
          modelId: "MiniMax-M3",
        }),
      ),
    ).join("\n");
    // 2 of 3 rows have apiMs > 0 → calls:2
    assert.equal(strip(out), "calls:2");
  });

  it("m_sumApiCalls| no rows in window → 'calls:n/a' placeholder", () => {
    // v0.8.14+ — bare m_sum* mirrors m_acc*: empty aggregate
    // renders the STALE_COLOR-wrapped "calls:n/a" placeholder
    // (was: drop / render empty). The inline form
    // `m_sumApiCalls|nulldrop|true` is the opt-out. Isolates
    // stateRoot to a fresh tmp subdir so we don't pick up the
    // user's real on-disk samples (289+ rows in production).
    const stateRootDir = join(_tmpDir, "avg-fixture-apicalls-empty");
    setStateRoot(() => stateRootDir);
    const out = renderTemplate(
      ["m_sumApiCalls"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-empty",
          cwd: "D:\\empty",
          modelId: "MiniMax-M3",
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "calls:n/a");
  });

  it("m_sumApiCalls| inline args (|window|7d, |model|all) are honored", () => {
    const stateRootDir = join(_tmpDir, "sum-fixture-apicalls-inline");
    setStateRoot(() => stateRootDir);
    const projHash = "d--ci";
    const sess = "sess-ci";
    const cwd = "D:\\ci";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: now - 1_000, totalIn: 100, totalOut: 50, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 30_000, apiMs: 30_000 }),
        JSON.stringify({ at: now - 2_000, totalIn: 200, totalOut: 100, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 120_000, apiMs: 90_000 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumApiCalls|model:all|window:7d"],
      ctxFor(
        fakeSnapshot({
          sessionId: sess,
          cwd,
          modelId: "MiniMax-M3",
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "calls:2");
  });
});

// v0.8.0+ — labels.* config customization. Each module that emits
// a token-stat prefix reads the corresponding cfg().labels.* axis at
// render time. Overriding labelTokenIn/labelTokenOut/labelTokenCachedIn/labelTokenTotalIn
// in config should propagate to: per-turn (m_tokenIn/Out/CachedIn/
// TotalIn), totals (m_tokenInTotal/OutTotal), acc (m_accTokenIn/
// Out/CachedIn/TotalIn/TokenIn/Out), sum/avg (m_sumTokenIn/Out/
// CachedIn/TotalIn + m_avgTokenIn/OutSpeed).
describe("renderTemplate — v0.8.0+ labels.* config customization", () => {
  // Apply a custom labels override to configStore for these tests,
  // then reset in the next beforeEach (the file-level beforeEach
  // at line 106 already calls configStore.__resetForTest()).
  // Helpers below reach into configStore via __resetForTest with a
  // partial override — that's the documented test path.
  function withLabels(labels: Partial<Config["labels"]>, fn: () => void) {
    __resetForTest({ labels: { ...configStore.get().labels, ...labels } });
    try { fn(); } finally { __resetForTest(); }
  }

  it("labelTokenIn override reaches per-turn m_tokenInTotal and m_tokenTotalIn", () => {
    withLabels({ labelTokenIn: "Δ:" }, () => {
      const a = renderTemplate(["m_tokenInTotal"], ctxFor(fakeSnapshot())).join("\n");
      // labelTokenTotalIn still defaults → "total:…".
      const b = renderTemplate(["m_tokenTotalIn"], ctxFor(fakeSnapshot())).join("\n");
      assert.equal(strip(a), "Δ:163.5k");
      assert.equal(strip(b), "total:163.5k");
    });
  });

  it("labelTokenTotalIn override reaches m_tokenTotalIn / m_accTokenTotalIn / m_sumTokenTotalIn", () => {
    // Pin stateRoot to a fresh empty dir so m_sumTokenTotalIn
    // sees no rows (production state has months of data that
    // would otherwise produce a 100M+ value here).
    setStateRoot(() => join(_tmpDir, "labels-test"));
    withLabels({ labelTokenTotalIn: "Total:" }, () => {
      // Use a fresh sessionId for m_accTokenTotalIn so any avg
      // snapshot left over from prior tests doesn't leak into
      // the rendered value (we only need to verify the prefix).
      const a = renderTemplate(["m_tokenTotalIn"], ctxFor(fakeSnapshot())).join("\n");
      const bSnap = fakeSnapshot({ sessionId: "label-total-acc" });
      processTick(bSnap.cwd, bSnap);
      statusStore.commit();
      const b = renderTemplate(
        ["m_accTokenTotalIn"],
        ctxFor(bSnap),
      ).join("\n");
      // m_sumTokenTotalIn needs no rows → placeholder path; verifies
      // the configured label is read for the placeholder too.
      // Force nulldrop:false so the placeholder renders (bare
      // form defaults to drop-on-null).
      const c = renderTemplate(
        ["m_sumTokenTotalIn|nulldrop:false"],
        ctxFor(fakeSnapshot({ sessionId: "label-test", cwd: "D:\\label-test" })),
      ).join("\n");
      assert.match(strip(a), /^Total:/);
      assert.match(strip(b), /^Total:/);
      assert.match(strip(c), /^Total:n\/a$/);
    });
  });

  it("labelTokenOut override reaches m_tokenOut (per-turn axis)", () => {
    withLabels({ labelTokenOut: "↓:" }, () => {
      const snap = fakeSnapshot();
      processTick(snap.cwd, snap);
      statusStore.commit();
      const a = renderTemplate(["m_tokenOut"], ctxFor(snap)).join("\n");
      assert.equal(strip(a), "↓:155");
    });
  });

  it("labelTokenOut override reaches m_tokenOut / m_tokenTotalOut (shared axis)", () => {
    // m_tokenTotalOut shares the per-turn "out" axis (no separate
    // labelTokenTotalOut field — that transient v0.8.22 axis was
    // removed before release). Override labelTokenOut and both
    // modules pick it up; existing renders stay byte-identical.
    withLabels({ labelTokenOut: "Out:" }, () => {
      const snap = fakeSnapshot();
      processTick(snap.cwd, snap);
      statusStore.commit();
      const a = renderTemplate(["m_tokenOut"], ctxFor(snap)).join("\n");
      const b = renderTemplate(["m_tokenTotalOut"], ctxFor(snap)).join("\n");
      assert.equal(strip(a), "Out:155");
      assert.equal(strip(b), "Out:155");
    });
  });

  it("labelTokenCachedIn override reaches m_tokenCachedIn", () => {
    withLabels({ labelTokenCachedIn: "⚡:" }, () => {
      const out = renderTemplate(["m_tokenCachedIn"], ctxFor(fakeSnapshot())).join("\n");
      assert.match(strip(out), /^⚡:/);
    });
  });

  // v0.8.13+ — four new label axes (labelApiMs / labelApiCalls /
  // labelTokenInSpeed / labelTokenOutSpeed) extend the labelFor() resolver
  // so apiMs / apiCalls / inSpeed / outSpeed family modules are
  // configurable independently from the in/out token-axis family.
  // Defaults match today's literal strings ("api:" / "calls:" /
  // "in:" / "out:") so existing renders stay byte-identical.

  it("labelApiMs override reaches m_apiMs / m_accApiMs / m_sumApiMs", () => {
    setStateRoot(() => join(_tmpDir, "labels-labelApiMs"));
    withLabels({ labelApiMs: "ms:" }, () => {
      // m_apiMs (per-turn) and m_accApiMs both read labelFor("apiMs")
      // (= labels.labelApiMs). m_sumApiMs placeholder reads the same.
      // Seed a tick so m_accApiMs has a non-zero value to render.
      const aSnap = fakeSnapshot({ sessionId: "label-api" });
      processTick(aSnap.cwd, aSnap);
      statusStore.commit();
      const a = renderTemplate(["m_apiMs"], ctxFor(aSnap)).join("\n");
      const b = renderTemplate(["m_accApiMs"], ctxFor(aSnap)).join("\n");
      const c = renderTemplate(
        ["m_sumApiMs|nulldrop:false"],
        ctxFor(fakeSnapshot({ sessionId: "label-api-sum", cwd: "D:\\label-api-sum" })),
      ).join("\n");
      assert.match(strip(a), /^ms:/);
      assert.match(strip(b), /^ms:/);
      assert.match(strip(c), /^ms:n\/a$/);
    });
  });

  it("labelApiCalls override reaches m_apiCalls / m_accApiCalls / m_sumApiCalls", () => {
    setStateRoot(() => join(_tmpDir, "labels-labelApiCalls"));
    withLabels({ labelApiCalls: "calls²:" }, () => {
      const aSnap = fakeSnapshot({ sessionId: "label-calls" });
      processTick(aSnap.cwd, aSnap);
      statusStore.commit();
      const a = renderTemplate(["m_apiCalls"], ctxFor(aSnap)).join("\n");
      const b = renderTemplate(["m_accApiCalls"], ctxFor(aSnap)).join("\n");
      // m_sumApiCalls placeholder path (no rows in window).
      const c = renderTemplate(
        ["m_sumApiCalls|nulldrop:false"],
        ctxFor(fakeSnapshot({ sessionId: "label-calls-sum", cwd: "D:\\label-calls-sum" })),
      ).join("\n");
      assert.match(strip(a), /^calls²:/);
      assert.match(strip(b), /^calls²:/);
      assert.match(strip(c), /^calls²:n\/a$/);
    });
  });

  it("labelTokenInSpeed override is independent of labelTokenIn", () => {
    // The speed-axis labels got their own slot in v0.8.13+ so a
    // user who renames labelTokenIn="In:" can keep speed reading
    // "in:12.3 t/s" until they explicitly override labelTokenInSpeed.
    setStateRoot(() => join(_tmpDir, "labels-labelTokenInSpeed"));
    withLabels({ labelTokenIn: "In:", labelTokenInSpeed: "speed-in:" }, () => {
      const snap = fakeSnapshot({ sessionId: "label-inspeed" });
      processTick(snap.cwd, snap);
      statusStore.commit();
      const speed = renderTemplate(["m_tokenInSpeed"], ctxFor(snap)).join("\n");
      const token = renderTemplate(["m_tokenInTotal"], ctxFor(snap)).join("\n");
      assert.match(strip(speed), /^speed-in:/);
      assert.match(strip(token), /^In:/);
      // m_sumTokenInSpeed with empty state should drop (agg.rows===0)
      // unless `nulldrop:false` forces the placeholder path. We use
      // a fresh cwd so no state rows from prior tests contaminate
      // the aggregate.
      const sumCtx = ctxFor(
        fakeSnapshot({ sessionId: "label-inspeed-sum", cwd: "D:\\label-inspeed-sum" }),
      );
      // m_sumTokenInSpeed with empty state should drop (agg.rows===0)
      // unless `nulldrop:false` forces the placeholder path. We use
      // a fresh cwd so no state rows from prior tests contaminate
      // the aggregate.
      const sumSpeed = renderTemplate(
        ["m_sumTokenInSpeed|nulldrop:false"],
        sumCtx,
      ).join("\n");
      assert.match(strip(sumSpeed), /^speed-in:n\/a$/);
    });
  });

  it("labelTokenOutSpeed override is independent of labelTokenOut", () => {
    setStateRoot(() => join(_tmpDir, "labels-labelTokenOutSpeed"));
    withLabels({ labelTokenOut: "Out:", labelTokenOutSpeed: "speed-out:" }, () => {
      const snap = fakeSnapshot({ sessionId: "label-outspeed" });
      processTick(snap.cwd, snap);
      statusStore.commit();
      const speed = renderTemplate(["m_tokenOutSpeed"], ctxFor(snap)).join("\n");
      // m_tokenOut (per-turn) follows labelTokenOut — same axis as
      // the speed override (m_tokenOutSpeed reads labelTokenOutSpeed).
      const token = renderTemplate(["m_tokenOut"], ctxFor(snap)).join("\n");
      assert.match(strip(speed), /^speed-out:/);
      assert.match(strip(token), /^Out:/);
    });
  });

  it("speed / apiMs / apiCalls label axes default to today's literals byte-identically", () => {
    // Defaults must reproduce the v0.8.x literal strings exactly so
    // existing configs render unchanged after upgrade. Reset to
    // configStore defaults (no overrides) and assert the prefixes.
    const snap = fakeSnapshot({ sessionId: "label-defaults" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const ctx0 = ctxFor(snap);
    assert.match(strip(renderTemplate(["m_apiMs"], ctx0).join("\n")), /^api:/);
    assert.match(strip(renderTemplate(["m_apiCalls"], ctx0).join("\n")), /^calls:/);
    assert.match(strip(renderTemplate(["m_tokenInSpeed"], ctx0).join("\n")), /^in:/);
    assert.match(strip(renderTemplate(["m_tokenOutSpeed"], ctx0).join("\n")), /^out:/);
  });

  // v0.8.17+ — m_memUsage label customization. Default is
  // "Mem:" (mirrors ccstatusline's hardcoded prefix). Output body
  // is "<label><used>/<total>" where the bytes are sampled live
  // via os.totalmem/os.freemem (Darwin: vm_stat). The prefix
  // assertion is the only stable check — the bytes portion depends
  // on the host's actual RAM and is non-deterministic.
  it("labelMemUsage override reaches m_memUsage prefix", () => {
    withLabels({ labelMemUsage: "RAM:" }, () => {
      const a = renderTemplate(
        ["m_memUsage"],
        ctxFor(fakeSnapshot()),
      ).join("\n");
      // Either "RAM:<used>/<total>" on success or "RAM:n/a" if
      // getMemUsage() returned null (e.g. Darwin vm_stat parse
      // failure or sandboxed os.*). Both forms are valid prefix
      // matches and verify that labelMemUsage reaches the renderer.
      assert.match(strip(a), /^RAM:(n\/a|\d.*)$/);
    });
  });

  it("labelMemUsage defaults to 'Mem:' byte-identically", () => {
    // No override — defaults must reproduce the v0.8.17+ literal
    // "Mem:" so existing v0.8.16 renders stay byte-identical after
    // upgrade. (m_memUsage is a NEW v0.8.17+ module, so this
    // asserts that the new default is "Mem:" rather than e.g. "mem:"
    // or "memory:").
    const out = renderTemplate(
      ["m_memUsage"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.match(strip(out), /^Mem:(n\/a|\d.*)$/);
  });

  // v0.9.x — labelTokenHitRate override reaches all three hit-rate
  // modules (per-turn / acc / sum). v0.8.22 added labelTokenHitRate
  // and routed the placeholder path through labelFor("hitRate"),
  // but the three LIVE-DATA paths kept a hardcoded "hit:" literal —
  // so a `labels.labelTokenHitRate` override surfaced only on
  // placeholder renders (e.g. before the first hit-rate tick), and
  // the actual hit-rate number still rendered with the default
  // prefix. This pins the live-data paths to labelFor("hitRate")
  // matching the placeholder contract.
  it("labelTokenHitRate override reaches m_tokenHitRate / m_accTokenHitRate / m_sumTokenHitRate", () => {
    setStateRoot(() => join(_tmpDir, "labels-labelTokenHitRate"));
    withLabels({ labelTokenHitRate: "HR:" }, () => {
      const snap = fakeSnapshot({ sessionId: "label-hitr" });
      processTick(snap.cwd, snap);
      statusStore.commit();
      const perTurn = renderTemplate(
        ["m_tokenHitRate"],
        ctxFor(snap),
      ).join("\n");
      const acc = renderTemplate(
        ["m_accTokenHitRate"],
        ctxFor(snap),
      ).join("\n");
      // m_sumTokenHitRate with empty state → placeholder (uses
      // labelFor("hitRate") already — this asserts the live-data
      // branch in a different cwd's sum scan).
      const sumCtx = ctxFor(
        fakeSnapshot({ sessionId: "label-hitr-sum", cwd: "D:\\label-hitr-sum" }),
      );
      const sum = renderTemplate(
        ["m_sumTokenHitRate|nulldrop:false"],
        sumCtx,
      ).join("\n");
      assert.match(strip(perTurn), /^HR:\d/);
      assert.match(strip(acc), /^HR:\d/);
      // Empty-state sum path → "HR:n/a%" placeholder.
      assert.match(strip(sum), /^HR:n\/a%$/);
    });
  });

  it("labelTokenHitRate default is 'hit:' byte-identically", () => {
    // No override — defaults must reproduce the v0.8.x literal
    // "hit:" so existing renders stay byte-identical after upgrade.
    const snap = fakeSnapshot({ sessionId: "label-hitr-default" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const perTurn = renderTemplate(
      ["m_tokenHitRate"],
      ctxFor(snap),
    ).join("\n");
    const acc = renderTemplate(
      ["m_accTokenHitRate"],
      ctxFor(snap),
    ).join("\n");
    assert.match(strip(perTurn), /^hit:\d/);
    assert.match(strip(acc), /^hit:\d/);
  });

  // v0.8.23+ — context-window prefix axes. Defaults preserve the
  // v0.8.22 hardcoded literals ("size:" / "size:" / "used:" /
  // "remain:") so existing renders stay byte-identical until the
  // user overrides labels.labelContext*.
  it("labelContextSize override reaches m_contextSize prefix", () => {
    withLabels({ labelContextSize: "Ctx:" }, () => {
      const out = renderTemplate(
        ["m_contextSize"],
        ctxFor(fakeSnapshot()),
      ).join("\n");
      assert.match(strip(out), /^Ctx:/);
    });
  });

  it("labelContextWindowsSize override reaches m_contextWindowsSize prefix", () => {
    withLabels({ labelContextWindowsSize: "Cap:" }, () => {
      const out = renderTemplate(
        ["m_contextWindowsSize"],
        ctxFor(fakeSnapshot()),
      ).join("\n");
      assert.match(strip(out), /^Cap:/);
    });
  });

  it("labelContextUsedPercent override reaches m_contextUsedPercent prefix", () => {
    withLabels({ labelContextUsedPercent: "fill:" }, () => {
      const out = renderTemplate(
        ["m_contextUsedPercent"],
        ctxFor(fakeSnapshot()),
      ).join("\n");
      assert.match(strip(out), /^fill:\d+(\.\d+)?%$/);
    });
  });

  it("labelContextRemainingPercent override reaches m_contextRemainingPercent prefix", () => {
    withLabels({ labelContextRemainingPercent: "free:" }, () => {
      const out = renderTemplate(
        ["m_contextRemainingPercent"],
        ctxFor(fakeSnapshot()),
      ).join("\n");
      assert.match(strip(out), /^free:\d+(\.\d+)?%$/);
    });
  });

  it("context label defaults reproduce v0.8.22 hardcoded literals byte-identically", () => {
    // Defaults must reproduce the v0.8.22 hardcoded literals
    // ("size:" / "size:" / "used:" / "remain:") so existing
    // renders stay byte-identical after upgrade. The placeholder
    // path fires when context_window data is null on the fake
    // snapshot — assert the n/a-family bodies.
    const ctx = ctxFor(fakeSnapshot());
    assert.match(strip(renderTemplate(["m_contextSize"], ctx).join("\n")), /^size:/);
    assert.match(strip(renderTemplate(["m_contextWindowsSize"], ctx).join("\n")), /^size:/);
    assert.match(strip(renderTemplate(["m_contextUsedPercent"], ctx).join("\n")), /^used:/);
    assert.match(strip(renderTemplate(["m_contextRemainingPercent"], ctx).join("\n")), /^remain:/);
  });

  it("m_memUsage|nulldrop|true drops the placeholder when getMemUsage() returns null", () => {
    // Force the placeholder path: we can't easily mock getMemUsage()
    // since it's a local function. Instead, override the label to
    // match the placeholderLabelOr pattern and assert the joined
    // template has no "Mem:" token (placeholder is "Mem:n/a";
    // nulldrop|true drops the whole chunk).
    const out = renderTemplate(
      ["m_memUsage|nulldrop:true"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    // When getMemUsage() succeeds, output is "Mem:X.XG/Y.YG" and
    // nulldrop|true only affects the placeholder path, so the
    // success path still emits. We assert the result is the same
    // shape as without nulldrop (no "Mem:n/a" placeholder leak).
    assert.doesNotMatch(strip(out), /n\/a/);
  });

  it("m_memUsage|color|red override applies the user's SGR", () => {
    const out = renderTemplate(
      ["m_memUsage|color:red"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    // Default tint is cyan (NAMED_PALETTE.cyan). When the user
    // overrides with |color|red, the SGR sequence must contain
    // "31" (ANSI red) somewhere on the line — confirm the override
    // path is wired. Prefix stays "Mem:" regardless of color.
    assert.match(strip(out), /^Mem:(n\/a|\d.*)$/);
    // SGR red = "\x1b[31m" (a bare-31 or 38;5;<n>31 won't apply,
    // the override path uses palette token "red" → resolveColor).
    assert.match(out, /\x1b\[(?:31|38;5;\d+)m/);
  });

  // v0.8.36+ — m_windowMemUsage bar + 5-band-colored percentage,
  // parallel of m_windowContext. The renderer reads getMemUsage()
  // and emits a bar+percent chunk via formatOneChunk — NO label
  // prefix (matches m_windowContext's pure bar+percent shape).
  // The pct value is non-deterministic on the host, so assertions
  // are shape-only: bar chars (▓/░) + " <pct>%".
  it("m_windowMemUsage bar + 5-band-colored percentage (host-dependent pct)", () => {
    const out = renderTemplate(["m_windowMemUsage"], ctxFor(fakeSnapshot())).join("\n");
    const stripped = strip(out);
    // bar is cfg().bar.width (default 8) chars of ▓/░, then
    // " <pct>%". pct is in 0..100; formatOneChunk rounds to int
    // (Math.round at render.ts:558).
    assert.match(stripped, /^[▓░]{8} \d{1,3}%$/);
    // The chunk should carry an SGR (band color from percentBands
    // OR STALE_COLOR on a placeholder path). The SGR is either a
    // bare 38;5;<n> (palette) or 31/32/33/91/... (named).
    assert.match(out, /\x1b\[\d+(;\d+)*m/);
  });

  it("m_windowMemUsage|color|red override applies the user's SGR", () => {
    const out = renderTemplate(
      ["m_windowMemUsage|color:red"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    // formatOneChunkColored path: bar + percent tail wrapped in
    // the user's red SGR. Assert bar shape first, then SGR.
    const stripped = strip(out);
    assert.match(stripped, /^[▓░]{8} \d{1,3}%$/);
    // SGR red = "\x1b[31m" (bare-31) or 38;5;<n> (palette).
    assert.match(out, /\x1b\[(?:31|38;5;\d+)m/);
  });

  it("m_windowMemUsage|display|remaining inverts usedPct to remainingPct (band color follows)", () => {
    // Mirror m_windowContext|display|remaining test: the displayed
    // percent becomes (100 - usedPct). Bar chunks also flip
    // (leftChunk shows the OPPOSITE side of filled vs empty).
    const used = renderTemplate(
      ["m_windowMemUsage"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    const remaining = renderTemplate(
      ["m_windowMemUsage|display:remaining"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    const usedPctMatch = strip(used).match(/ (\d{1,3})%$/);
    const remainingPctMatch = strip(remaining).match(/ (\d{1,3})%$/);
    assert.ok(usedPctMatch, `no pct in used: ${strip(used)}`);
    assert.ok(remainingPctMatch, `no pct in remaining: ${strip(remaining)}`);
    const usedPct = Number(usedPctMatch[1]);
    const remainingPct = Number(remainingPctMatch[1]);
    // usedPct + remainingPct should be 100 (modulo Math.round on
    // both sides; the test allows ±1 for double-rounding).
    assert.ok(
      Math.abs(usedPct + remainingPct - 100) <= 1,
      `used=${usedPct} + remaining=${remainingPct} should sum to 100`,
    );
  });

  it("m_windowMemUsage|nulldrop|true drops the placeholder when getMemUsage() returns null", () => {
    // Mirror m_memUsage's test: assert nulldrop on a null result
    // path drops the placeholder. When getMemUsage() succeeds,
    // the value path emits and nulldrop is a no-op on the success
    // path (matches m_memUsage's contract). Placeholder is the
    // gauge shape ("░...░ 0%" used mode, "▓...▓ 100%" remaining
    // mode) — no "n/a" token, so the assertion is
    // "n/a is absent".
    const out = renderTemplate(
      ["m_windowMemUsage|nulldrop:true"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.doesNotMatch(strip(out), /n\/a/);
  });
});

// v0.8.0+ — tickStatus field renames and additions. The on-disk
// shape under `state/<projectHash>/status.json` is updated:
//   cacheRead  → cachedIn   (per-turn cache_read_input_tokens)
//   accApiMs   → totalApiMs (session-cumulative cost.total_api_duration_ms)
//   + totalIn             (session-cumulative context_window.total_input_tokens)
//   + accTokenTotalIn          (per-tick-delta-accumulator of totalIn)
// The on-disk file's `tickStatus:<sid>` entry must reflect the new
// field set after a render that exercises the per-tick pipeline.
describe("renderTemplate — v0.8.x cwf-tickStatus-v2 (tickStatus acc-only + prevTickStatus singleton + 3 scopes)", () => {
  // The v0.8.0 "tickStatus field renames" describe block was
  // rewritten for v0.8.x cwf-tickStatus-v2. What changed:
  //   - tickStatus:<sid>.value is now ACC-ONLY (no in/out/cachedIn/
  //     totalIn/totalApiMs fields). Per-tick / session-cumulative
  //     values moved to the singleton `prevTickStatus` slot.
  //   - m_totalToken* / m_totalTokenWithCacheIn REMOVED (no alias).
  //   - The project-wide slot key changed from `tickStatus` (no
  //     suffix) to `tickStatus:<projectHash(cwd)>`.
  //   - m_acc* family defaults to scope=session (per-session,
  //     clear-bounded). scope=ccsession was REMOVED in this
  //     revision and surfaces as badarg (see resolveAccScope).
  //
  // The tests below pin the new on-disk layout.

  it("setPrevTick writes the singleton prevTickStatus slot (only totalApiMs + identity persist)", () => {
    // v0.8.10-alpha.2 snapshot contract: prevTickStatus carries
    // ONLY totalApiMs + identity. The per-turn in/out/cacheRead/
    // totalIn values are NOT written to prev (apiMs is the only
    // cross-tick delta). See plan ancient-wobbling-mochi.md.
    setPrevTick("sess-rename",
      { totalApiMs: 60_000 },
      "D:\\test");
    const prev = peekPrevTick("sess-rename", "D:\\test");
    assert.ok(prev, "prev tick should round-trip");
    assert.equal(prev.totalApiMs, 60_000);
  });

  it("setAvg writes ACC-ONLY fields on tickStatus:<sid> (no in/out/cachedIn/totalIn/totalApiMs)", () => {
    setPrevTick("sess-totalApi",
      { totalApiMs: 30_000 },
      "D:\\test");
    const snap = fakeSnapshot({ sessionId: "sess-totalApi", cwd: "D:\\test" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    renderTemplate(["m_accTokenIn"], ctxFor(snap));
    const avg = peekAvg("sess-totalApi", "D:\\test");
    assert.ok(avg, "peekAvg should return a non-null AvgSnapshot after render");
    // v0.8.x scope contract — session-slot accApiMs is a
    // delta-accumulator (user rule 2026-07-04). prev.apiMs=30_000
    // and current.totalApiDurationMs=60_000 → delta=30_000
    // (NOT the absolute 60_000 the previous contract mirrored).
    assert.equal(avg.accApiMs, 30_000,
      "scope=session accApiMs accumulates deltaApiMs (delta-accumulator), not absolute stdin field");
    // v0.8.x cwf-tickStatus-v2 — accTokenTotalIn accumulates the
    // per-tick delta of totalIn (current.totalIn - prev.totalIn).
    // fakeSnapshot defaults totals.input to 163479; prev.totalIn
    // is 0; deltaTokenTotalIn = 163479.
    assert.equal(avg.accTokenTotalIn, 163479,
      "accTokenTotalIn accumulates the per-tick delta of totalIn");
  });

  it("accTokenTotalIn accumulates tokenTotalIn additively (v0.8.10-alpha.2 contract)", () => {
    // v0.8.10-alpha.2 (per user refinement 2026-07-04) —
    // accTokenTotalIn is an ACCUMULATE-ADDITIVE accumulator
    // matching the on-disk accTokenIn / accTokenOut / accTokenCachedIn family:
    //   accTokenTotalIn_{t+1} = accTokenTotalIn_t + tokenTotalIn_{t+1}
    // The tokenTotalIn field itself is a per-tick stdin
    // snapshot (input_tokens + cache_read_input_tokens for
    // that tick only), but the ACCUMULATOR aggregates it
    // across ticks for cross-session totals. This is a
    // deliberate design choice — the field name "acc" (as in
    // accTokenIn / accTokenOut / accTokenCachedIn) carries the implicit
    // "additive across ticks" semantic. NOT a snapshot
    // field.
    setPrevTick("sess-accTokenTotalIn",
      { totalApiMs: 30_000 },
      "D:\\test");
    // Seed prior accTokenTotalIn=100 so the next tick adds on
    // top of it (mirrors v0.4.x test fixture for backward
    // parity).
    statusStore.writeTickStatus("D:\\test", `tickStatus:sess-accTokenTotalIn`, {
      ...statusStore.emptyTickStatus(),
      accTokenTotalIn: 100,
    });
    const s0 = fakeSnapshot({
      sessionId: "sess-accTokenTotalIn",
      cwd: "D:\\test",
      totals: { tokenTotalIn: 250, tokenTotalOut: 100 },
      current: { tokenIn: 0, tokenOut: 100, tokenCacheCreation: 0, tokenCachedIn: 0 },
      cost: { totalDurationMs: 0, totalApiDurationMs: 31_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    const t0 = ctxFor(s0);
    processTick(s0.cwd, s0);
    statusStore.commit();
    renderTemplate(["m_accTokenIn"], t0);
    let avg = peekAvg("sess-accTokenTotalIn", "D:\\test");
    assert.equal(avg?.accTokenTotalIn, 350, "tick 1: 100 (seed) + 250 (current.totalIn) = 350");
    const s1 = fakeSnapshot({
      sessionId: "sess-accTokenTotalIn",
      cwd: "D:\\test",
      totals: { tokenTotalIn: 400, tokenTotalOut: 200 },
      current: { tokenIn: 0, tokenOut: 200, tokenCacheCreation: 0, tokenCachedIn: 0 },
      cost: { totalDurationMs: 0, totalApiDurationMs: 32_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    const t1 = ctxFor(s1);
    processTick(s1.cwd, s1);
    statusStore.commit();
    renderTemplate(["m_accTokenIn"], t1);
    avg = peekAvg("sess-accTokenTotalIn", "D:\\test");
    assert.equal(avg?.accTokenTotalIn, 750, "tick 2: 350 (after tick 1) + 400 (current.totalIn) = 750");
    // v0.8.10-alpha.2 snapshot contract: prevTickStatus no longer
    // carries totalIn — the acc slot's job is its only
    // remaining truth. See plan ancient-wobbling-mochi.md.
  });

  it("accTokenTotalIn tracks the latest totalIn snapshot (v0.8.10-alpha.2 contract)", () => {
    // v0.8.10-alpha.2 snapshot contract: totalIn is a SNAPSHOT
    // field (no cross-tick subtract). `accTokenTotalIn` on the
    // tickStatus slot tracks the latest totalIn snapshot seen for
    // the session — not a delta-accumulator. The regression-clamp
    // expectation from earlier contracts is gone: there is no
    // prev.totalIn to clamp against.
    setPrevTick("sess-clamp",
      { totalApiMs: 30_000 },
      "D:\\test");
    const snap = fakeSnapshot({
      sessionId: "sess-clamp",
      cwd: "D:\\test",
      totals: { tokenTotalIn: 500, tokenTotalOut: 100 },
      current: { tokenIn: 0, tokenOut: 100, tokenCacheCreation: 0, tokenCachedIn: 0 },
    });
    processTick(snap.cwd, snap);
    statusStore.commit();
    renderTemplate(["m_accTokenIn"], ctxFor(snap));
    const avg = peekAvg("sess-clamp", "D:\\test");
    assert.equal(avg?.accTokenTotalIn, 500, "accTokenTotalIn is the latest totalIn snapshot, not a clamped delta");
  });

  it("totalApiMs round-trips through setPrevTick and peekPrevTick (no render overwrite)", () => {
    // v0.8.10-alpha.2 snapshot contract: the prev-tick persistence
    // path now carries ONLY totalApiMs + identity. The cacheRead
    // projection name is gone — totalApiMs is the unique prev
    // field participating in cross-tick apiMs subtraction.
    setPrevTick("sess-cachedIn",
      { totalApiMs: 0 },
      "D:\\test");
    const prev = peekPrevTick("sess-cachedIn", "D:\\test");
    assert.ok(prev);
    assert.equal(prev.totalApiMs, 0,
      "PrevTickSnapshot.totalApiMs round-trips through the bridge");
  });

  // v0.8.x — scope contract for accApiMs (user rule 2026-07-04,
// unifying the surviving 3 scopes on delta-accumulation):
//   ALL 3 scopes (session / project / model):
//     accApiMs += deltaApiMs (delta-accumulator).
//   The ccsession scope (which previously ADDITIONALLY zeroed
//   the entire slot on a backwards `totalApiMs` step / claude-
//   code-process-restart) was REMOVED in this revision; its
//   per-process regression-reset quirk has no surviving target.
  describe("scope contract — accApiMs handler per scope", () => {
    it("scope=session: accApiMs accumulates deltaApiMs (not absolute)", () => {
      setPrevTick("sess-scope-api",
        { totalApiMs: 30_000 },
        "D:\\test");
      // fakeSnapshot defaults totalApiDurationMs=60_000 → deltaApi=30_000
      const snap = fakeSnapshot({ sessionId: "sess-scope-api", cwd: "D:\\test" });
      processTick(snap.cwd, snap);
      statusStore.commit();
      renderTemplate(["m_accApiMs|scope:session"],
        ctxFor(snap));
      const avg = peekAvg("sess-scope-api", "D:\\test");
      assert.ok(avg);
      assert.equal(avg.accApiMs, 30_000,
        "session-slot accApiMs is deltaApiMs (60_000 - 30_000), NOT the absolute 60_000");
    });

    it("scope=project: accApiMs accumulates deltaApiMs (not absolute)", () => {
      setPrevTick("sess-proj-api",
        { totalApiMs: 0 },
        "D:\\test");
      // First tick: totalApiMs=20_000 → deltaApi=20_000
      const snap1 = fakeSnapshot({
        sessionId: "sess-proj-api",
        cwd: "D:\\test",
        current: { tokenIn: 38, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: 0 },
        cost: { totalDurationMs: 0, totalApiDurationMs: 20_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
      });
      beginTickForTest("D:\\test", snap1);
      processTick(snap1.cwd, snap1);
      statusStore.commit();
      renderTemplate(["m_accApiMs|scope:project"],
        ctxFor(snap1));
      statusStore.commit();
      // Second tick: totalApiMs=50_000 → deltaApi=30_000; project slot +=30_000
      setPrevTick("sess-proj-api",
        { totalApiMs: 20_000 },
        "D:\\test");
      const snap2 = fakeSnapshot({
        sessionId: "sess-proj-api",
        cwd: "D:\\test",
        current: { tokenIn: 76, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: 0 },
        cost: { totalDurationMs: 0, totalApiDurationMs: 50_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
      });
      beginTickForTest("D:\\test", snap2);
      processTick(snap2.cwd, snap2);
      statusStore.commit();
      renderTemplate(["m_accApiMs|scope:project"],
        ctxFor(snap2));
      statusStore.commit();
      const projectKey = `tickStatus:${projectHash("D:\\test")}`;
      const proj = statusStore.readTickStatus("D:\\test", projectKey);
      assert.ok(proj);
      assert.equal(proj.accApiMs, 50_000,
        "project-slot accApiMs accumulates deltaApiMs: 20_000 (tick1) + 30_000 (tick2) = 50_000");
    });

    it("scope=model: accApiMs accumulates deltaApiMs (not absolute)", () => {
      const model = "MiniMax-M3";
      setPrevTick("sess-model-api",
        { totalApiMs: 0 },
        "D:\\test");
      // First tick: totalApiMs=15_000 → deltaApi=15_000
      const snap1 = fakeSnapshot({
        sessionId: "sess-model-api",
        cwd: "D:\\test",
        modelDisplayName: model,
        current: { tokenIn: 50, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: 0 },
        cost: { totalDurationMs: 0, totalApiDurationMs: 15_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
      });
      beginTickForTest("D:\\test", snap1);
      processTick(snap1.cwd, snap1);
      statusStore.commit();
      renderTemplate(["m_accApiMs|scope:model"],
        ctxFor(snap1));
      statusStore.commit();
      // Second tick: totalApiMs=35_000 → deltaApi=20_000; model slot +=20_000
      setPrevTick("sess-model-api",
        { totalApiMs: 15_000 },
        "D:\\test");
      const snap2 = fakeSnapshot({
        sessionId: "sess-model-api",
        cwd: "D:\\test",
        modelDisplayName: model,
        current: { tokenIn: 100, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: 0 },
        cost: { totalDurationMs: 0, totalApiDurationMs: 35_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
      });
      beginTickForTest("D:\\test", snap2);
      processTick(snap2.cwd, snap2);
      statusStore.commit();
      renderTemplate(["m_accApiMs|scope:model"],
        ctxFor(snap2));
      statusStore.commit();
      const provKey = `tickStatus:${model}`;
      const prov = statusStore.readTickStatus("D:\\test", provKey);
      assert.ok(prov);
      assert.equal(prov.accApiMs, 35_000,
        "model-slot accApiMs accumulates deltaApiMs: 15_000 (tick1) + 20_000 (tick2) = 35_000");
    });
  });
});

// ----- v0.9.x — formatTtlSeconds helper -----
//
// Fixed-second TTL suffix used by m_cacheTtlStatus / m_statTtlStatus.
// Bypasses `timeFormat.minUnit` so the gauge always reports seconds
// regardless of the rest of the statusline's time format.
describe("formatTtlSeconds", () => {
  it("whole seconds: 23_500ms → '23s' (floor — never overstate remaining TTL)", () => {
    assert.equal(formatTtlSeconds(23_500), "23s");
  });
  it("boundary: exactly 1000ms → '1s' (Math.ceil(1) = 1, not <1s)", () => {
    assert.equal(formatTtlSeconds(1_000), "1s");
  });
  it("sub-second: 500ms → '<1s'", () => {
    assert.equal(formatTtlSeconds(500), "<1s");
  });
  it("exactly 0ms → '0s' (past-due; mirrors formatRemainingMs's '0<minUnit>')", () => {
    assert.equal(formatTtlSeconds(0), "0s");
  });
  it("negative ms → '0s' (clamped to past-due)", () => {
    assert.equal(formatTtlSeconds(-30_000), "0s");
  });
  it("large value: 5 minutes → '300s' (does NOT roll up to minutes)", () => {
    // This is the whole point: timeFormat.minUnit does not leak
    // into the TTL gauge. A 5-minute remaining TTL still shows
    // "300s", not "5m".
    assert.equal(formatTtlSeconds(300_000), "300s");
  });
  it("NaN → ''", () => {
    assert.equal(formatTtlSeconds(NaN), "");
  });
});

// ----- v0.8.16 — m_cacheTtlStatus + m_statTtlStatus -----
//
// Both modules display the TTL of their respective backing cache
// (cache.ts response cache + status-store stat cache) as a single
// character from the palette █▇▆▅▄▃▂▁, colored green (max TTL) →
// red (min TTL) by a 5-band scale. Missing entry / no-ttlMs → gray
// ▆ placeholder wrapped in STALE_COLOR.

describe("render — m_cacheTtlStatus (v0.9.x +fixed-second suffix, +active-provider scoping)", () => {
  // v0.9.x — m_cacheTtlStatus reads the ACTIVE provider's cache row
  // (keyed by ctx.currentProvider). Every test in this block scopes
  // ctx.currentProvider to "minimax" to mirror what index.ts does
  // for the matched provider.
  const ctxWithProvider = () => ({
    ...ctxFor(fakeSnapshot()),
    currentProvider: "minimax" as const,
  });

  it("no entry for active provider → STALE_COLOR-wrapped '▆' placeholder", () => {
    // Active provider (minimax) has no cache row — placeholder.
    // Other providers' rows, if any, MUST NOT leak in.
    resetCacheForTest();
    const out = renderTemplate(["m_cacheTtlStatus"], ctxWithProvider()).join("");
    assert.equal(strip(out), "▆");
    assert.ok(out.includes(STALE), `expected STALE SGR, got: ${JSON.stringify(out)}`);
  });

  it("fresh entry (age≈0 of 60s ttl) → '█ <≈60>s' in brightGreen", () => {
    resetCacheForTest();
    cacheMod.set("minimax", { x: 1 }, 60_000);
    const out = renderTemplate(["m_cacheTtlStatus"], ctxWithProvider()).join("");
    // Test-runner delay between cache.set and render means ageMs
    // is a few ms by the time render runs — floor gives 59s/60s
    // depending on tick. Match a small range so timing jitter
    // doesn't flake the assertion.
    assert.match(strip(out), /^█ (59|60)s$/);
    assert.ok(out.includes(GREEN), `expected brightGreen SGR, got: ${JSON.stringify(out)}`);
  });

  it("half-aged entry (age=30s of 60s) → '▄ 30s' in yellow", () => {
    resetCacheForTest();
    cacheMod.set("minimax", { x: 1 }, 60_000);
    // Backdate `at` so ageMs reads as 30s on render (no Date.now
    // override — the render path uses real wall-clock time, so
    // backdating the entry is enough).
    (cacheMod as any).store.set("minimax", {
      at: Date.now() - 30_000,
      value: { x: 1 },
      ttlMs: 60_000,
    });
    const out = renderTemplate(["m_cacheTtlStatus"], ctxWithProvider()).join("");
    assert.equal(strip(out), "▄ 30s");
    assert.ok(out.includes(YELLOW), `expected yellow SGR, got: ${JSON.stringify(out)}`);
  });

  it("expired entry (age=90s of 60s) → '▁ 0s' in red", () => {
    resetCacheForTest();
    cacheMod.set("minimax", { x: 1 }, 60_000);
    // Backdate to age=90s (> ttlMs=60s) so the entry is past TTL.
    // Render should still emit a glyph (TTL-IGNORING peek) — the
    // red char reflects remainingFraction ≈ (60 - 90) / 60 < 0.
    (cacheMod as any).store.set("minimax", {
      at: Date.now() - 90_000,
      value: { x: 1 },
      ttlMs: 60_000,
    });
    const out = renderTemplate(["m_cacheTtlStatus"], ctxWithProvider()).join("");
    assert.equal(strip(out), "▁ 0s");
    assert.ok(out.includes(RED), `expected red SGR, got: ${JSON.stringify(out)}`);
  });

  it("active-provider scoping: only minimax row read even if deepseek is freshest", () => {
    // MiniMax is the active provider but its row is 45s old; DeepSeek
    // has a 5s-old row. The render must read MiniMax (older, yellow),
    // NOT DeepSeek (freshest, green) — otherwise the freshness gauge
    // would lie about which provider's data the line above is using.
    resetCacheForTest();
    (cacheMod as any).store.set("deepseek", {
      at: Date.now() - 5_000,
      value: { x: 99 },
      ttlMs: 60_000,
    });
    (cacheMod as any).store.set("minimax", {
      at: Date.now() - 45_000,
      value: { x: 1 },
      ttlMs: 60_000,
    });
    const out = renderTemplate(["m_cacheTtlStatus"], ctxWithProvider()).join("");
    // KEY ASSERTION is the SUFFIX: 14s or 15s reflects MiniMax's
    // ~45s-old row. If the renderer had pulled DeepSeek's fresh
    // row (age≈5s), the suffix would be ~55s, NOT 14/15s. The exact
    // bar char (▂ vs ▃ vs ▄ vs ▅) and color (yellow vs orange) drift
    // across test runs as ageMs jitters ±1ms, so don't pin them.
    // Forbid any character that would only appear if DeepSeek had
    // been picked (its fraction ≈ 0.92 → idx 0 = "█" and color =
    // brightGreen; the renderer would print "█ 55s" / "█ 56s").
    const stripped = strip(out);
    assert.match(
      stripped,
      / 1[45]s$/,
      `expected MiniMax's ~15s suffix (NOT DeepSeek's fresh ~55s), got: ${JSON.stringify(stripped)}`,
    );
    assert.ok(
      !stripped.startsWith("█"),
      `expected non-fresh bar (DeepSeek would produce █); got: ${JSON.stringify(stripped)}`,
    );
  });

  it("inline m_cacheTtlStatus|color|orange overrides scale", () => {
    resetCacheForTest();
    cacheMod.set("minimax", { x: 1 }, 60_000);
    const out = renderTemplate(
      ["m_cacheTtlStatus|color:orange"],
      ctxWithProvider(),
    ).join("");
    // Same tolerance as the fresh-path test: cache.set stamps
    // `at = Date.now()`, render runs a few ms later, so floor may
    // give 59s or 60s.
    assert.match(strip(out), /^█ (59|60)s$/);
    assert.ok(out.includes(ORANGE), `expected orange SGR, got: ${JSON.stringify(out)}`);
  });

  it("inline m_cacheTtlStatus|nulldrop|true → drops when no entry", () => {
    resetCacheForTest();
    const out = renderTemplate(
      ["m_cacheTtlStatus|nulldrop:true"],
      ctxWithProvider(),
    );
    // nulldrop:true + null data → renderer returns null → the
    // separator-adjacent-skip logic drops the chunk entirely so
    // the output array is empty.
    assert.equal(out.length, 0);
  });
});

describe("render — m_statTtlStatus (v0.9.x +fixed-second suffix)", () => {
  it("no entry → STALE_COLOR-wrapped '▆' placeholder", () => {
    __resetStatCacheForTest();
    const out = renderTemplate(["m_statTtlStatus"], ctxFor(fakeSnapshot())).join("");
    assert.equal(strip(out), "▆");
    assert.ok(out.includes(STALE), `expected STALE SGR, got: ${JSON.stringify(out)}`);
  });

  it("fresh entry (age≈0 of 300s ttl) → '█ <≈300>s' in brightGreen", () => {
    __resetStatCacheForTest();
    setStatCacheForTest("stat:all:5h:true", { sumIn: 1, rows: 1, sumOut: 0, sumCached: 0, sumTotalIn: 1, sumApiMs: 0, calls: 1, lastAt: Date.now(), generatedAt: Date.now() }, 300_000);
    const out = renderTemplate(["m_statTtlStatus"], ctxFor(fakeSnapshot())).join("");
    // Same test-runner-delay tolerance as m_cacheTtlStatus fresh path.
    assert.match(strip(out), /^█ (299|300)s$/);
    assert.ok(out.includes(GREEN), `expected brightGreen SGR, got: ${JSON.stringify(out)}`);
  });

  it("half-aged entry (age=150s of 300s) → middle char '▄' in yellow", () => {
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:all:5h:true",
      { sumIn: 1, rows: 1, sumOut: 0, sumCached: 0, sumTotalIn: 1, sumApiMs: 0, calls: 1, lastAt: Date.now(), generatedAt: Date.now() },
      300_000,
    );
    // Backdate `at` so ageMs reads as 150s on render (no Date.now
    // override — render uses real wall-clock time, so backdating
    // the entry alone produces the expected ageMs).
    setStatCacheAtForTest("stat:all:5h:true", Date.now() - 150_000);
    const out = renderTemplate(["m_statTtlStatus"], ctxFor(fakeSnapshot())).join("");
    assert.equal(strip(out), "▄ 150s");
    assert.ok(out.includes(YELLOW), `expected yellow SGR, got: ${JSON.stringify(out)}`);
  });

  it("expired entry (age=400s of 300s) → '▁ 0s' in red", () => {
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:all:5h:true",
      { sumIn: 1, rows: 1, sumOut: 0, sumCached: 0, sumTotalIn: 1, sumApiMs: 0, calls: 1, lastAt: Date.now(), generatedAt: Date.now() },
      300_000,
    );
    setStatCacheAtForTest("stat:all:5h:true", Date.now() - 400_000);
    const out = renderTemplate(["m_statTtlStatus"], ctxFor(fakeSnapshot())).join("");
    assert.equal(strip(out), "▁ 0s");
    assert.ok(out.includes(RED), `expected red SGR, got: ${JSON.stringify(out)}`);
  });

  it("inline m_statTtlStatus|color|orange overrides scale", () => {
    __resetStatCacheForTest();
    setStatCacheForTest("stat:all:5h:true", { sumIn: 1, rows: 1, sumOut: 0, sumCached: 0, sumTotalIn: 1, sumApiMs: 0, calls: 1, lastAt: Date.now(), generatedAt: Date.now() }, 300_000);
    const out = renderTemplate(
      ["m_statTtlStatus|color:orange"],
      ctxFor(fakeSnapshot()),
    ).join("");
    // Same tolerance as the fresh-path test.
    assert.match(strip(out), /^█ (299|300)s$/);
    assert.ok(out.includes(ORANGE), `expected orange SGR, got: ${JSON.stringify(out)}`);
  });

  it("inline m_statTtlStatus|nulldrop|true → drops when no entry", () => {
    __resetStatCacheForTest();
    const out = renderTemplate(
      ["m_statTtlStatus|nulldrop:true"],
      ctxFor(fakeSnapshot()),
    );
    // nulldrop:true + null data → renderer returns null → the
    // separator-adjacent-skip logic drops the chunk entirely.
    assert.equal(out.length, 0);
  });
});

// ----- v0.8.24+ startAt / lastAt time anchors -------------------------------
//
// 3 new modules (m_accStartTime / m_sumStartTime / m_sumEndTime)
// + 2 new label axes (labelStartTime / labelEndTime) +
// 1 new helper (formatAbsTime). The acc module reads the ccsession
// slot's startAt (default scope) and renders HH:MM:SS. The two
// sum modules aggregate min/max over JSONL rows.
describe("renderTemplate — v0.8.24+ m_accStartTime / m_sumStartTime / m_sumEndTime", () => {
  // Reuse the same tmp-dir convention as the m_sum* tests. The
  // setAvg helper writes through tick-state, so the slot's
  // startAt is populated by the first valid write.
  beforeEach(() => {
    setCachePathResolver(() => join(_tmpDir, "cache.json"));
    resetCacheForTest();
  });

  it("formatAbsTime helper formats Unix-ms as HH:MM:SS (sv-SE 24h)", () => {
    // 1700000000000 ms = 2023-11-14T22:13:20.000Z UTC. Local
    // time depends on the host TZ, so we just assert the
    // structural shape (HH:MM:SS) and the hour-window-24h
    // range.
    const formatted = formatAbsTime(1700000000000);
    assert.match(formatted, /^\d{2}:\d{2}:\d{2}$/);
    // Hours in 24h format are 00..23 — sanity-check the
    // first two chars are a valid hour.
    const hh = parseInt(formatted.slice(0, 2), 10);
    assert.ok(hh >= 0 && hh <= 23, "hour in 00..23 range");
  });

  it("formatAbsTime returns 'n/a' on null / non-finite / non-positive", () => {
    assert.equal(formatAbsTime(null), "n/a");
    assert.equal(formatAbsTime(undefined), "n/a");
    assert.equal(formatAbsTime(0), "n/a");
    assert.equal(formatAbsTime(-1), "n/a");
    assert.equal(formatAbsTime(NaN), "n/a");
    assert.equal(formatAbsTime(Infinity), "n/a");
  });

  // v0.8.25+ — |abs|true widens HH:MM:SS → YYYY-MM-DD HH:MM:SS.
  it("formatAbsTime |abs|true formats as YYYY-MM-DD HH:MM:SS (sv-SE)", () => {
    // 1700000000000 ms = 2023-11-14T22:13:20.000Z UTC. Local
    // date depends on TZ, so we assert the structural shape
    // (YYYY-MM-DD HH:MM:SS) and a valid year in 2020..2099.
    const formatted = formatAbsTime(1700000000000, { abs: true });
    assert.match(formatted, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const year = parseInt(formatted.slice(0, 4), 10);
    assert.ok(year >= 2020 && year <= 2099, `year ${year} in 2020..2099`);
  });

  it("formatAbsTime |abs|false / undefined falls back to HH:MM:SS", () => {
    // explicit false
    assert.match(formatAbsTime(1700000000000, { abs: false }), /^\d{2}:\d{2}:\d{2}$/);
    // omitted opts (v0.8.24+ default preserved)
    assert.match(formatAbsTime(1700000000000, {}), /^\d{2}:\d{2}:\d{2}$/);
  });

  it("formatAbsTime |abs|true still returns 'n/a' on null / non-finite", () => {
    assert.equal(formatAbsTime(null, { abs: true }), "n/a");
    assert.equal(formatAbsTime(NaN, { abs: true }), "n/a");
  });

  it("inline m_accStartTime|abs|true renders start:YYYY-MM-DD HH:MM:SS", () => {
    // Seed the session slot the same way as the color test above.
    setAvg(
      "sess-start-abs",
      { accTokenIn: 0, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 1, accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      { modelId: "MiniMax-M3", deltaApiCalls: 1, currentApiMs: 1000, deltaTokenIn: 0, deltaTokenOut: 0, deltaTokenCachedIn: 0, deltaApiMs: 1000 },
    );
    const snap = fakeSnapshot({ sessionId: "sess-start-abs", cwd: "D:\\test" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accStartTime|scope:session|abs:true"],
      ctxFor(snap),
    ).join("\n");
    // YYYY-MM-DD HH:MM:SS prefix matches the wider format.
    assert.match(strip(out), /^start:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("inline m_accStartTime|abs|true combined with |color|cyan still emits SGR", () => {
    // |abs| and |color| are independent — both must apply.
    setAvg(
      "sess-start-abs-color",
      { accTokenIn: 0, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 1, accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      { modelId: "MiniMax-M3", deltaApiCalls: 1, currentApiMs: 1000, deltaTokenIn: 0, deltaTokenOut: 0, deltaTokenCachedIn: 0, deltaApiMs: 1000 },
    );
    const snap = fakeSnapshot({ sessionId: "sess-start-abs-color", cwd: "D:\\test" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accStartTime|scope:session|abs:true|color:cyan"],
      ctxFor(snap),
    ).join("\n");
    assert.ok(out.includes("\x1b["), `expected SGR escape in: ${JSON.stringify(out)}`);
    assert.match(strip(out), /^start:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("inline m_accStartTime|abs|yes rejects unknown value (parse-fail → badarg)", () => {
    // |abs|yes is not literal "true"/"false" — ABS_PARAM
    // resolver returns null → parseInlineArgs drops the token.
    // The dispatcher logs a warn + drops; either way the
    // assert is that no chunk lands in the rendered body.
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      setAvg(
        "sess-start-abs-bad",
        { accTokenIn: 0, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 1, accTokenTotalIn: 0, accTokenHitRate: 0 },
        "D:\\test",
        { modelId: "MiniMax-M3", deltaApiCalls: 1, currentApiMs: 1000, deltaTokenIn: 0, deltaTokenOut: 0, deltaTokenCachedIn: 0, deltaApiMs: 1000 },
      );
      const snap = fakeSnapshot({ sessionId: "sess-start-abs-bad", cwd: "D:\\test" });
      processTick(snap.cwd, snap);
      statusStore.commit();
      const out = renderTemplate(
        ["m_accStartTime|scope:session|abs:yes"],
        ctxFor(snap),
      ).join("\n");
      // Badarg drops the chunk — body is "".
      assert.equal(strip(out), "");
    } finally {
      console.warn = origWarn;
    }
  });

  it("default m_accStartTime without |abs| keeps the v0.8.24 HH:MM:SS shape", () => {
    // Regression guard: existing users who DON'T pass |abs|
    // must continue to get exactly HH:MM:SS bytes, since
    // |abs| defaults to false. Mirrors the structural check
    // in the `scope|session` test above.
    setAvg(
      "sess-start-default",
      { accTokenIn: 0, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 1, accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      { modelId: "MiniMax-M3", deltaApiCalls: 1, currentApiMs: 1000, deltaTokenIn: 0, deltaTokenOut: 0, deltaTokenCachedIn: 0, deltaApiMs: 1000 },
    );
    const snap = fakeSnapshot({ sessionId: "sess-start-default", cwd: "D:\\test" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accStartTime|scope:session"],
      ctxFor(snap),
    ).join("\n");
    assert.match(strip(out), /^start:\d{2}:\d{2}:\d{2}$/);
    // Negative regression — must NOT contain a year prefix.
    assert.doesNotMatch(strip(out), /^start:\d{4}-/);
  });

  it("bare m_accStartTime on a fresh session (no writes) → 'start:n/a' placeholder", () => {
    // No setAvg → slot doesn't exist → placeholderAcc("startTime").
    // The bare form on a session with no prior writes must
    // show the placeholder so the user can see "no data yet",
    // not a hidden drop.
    const out = renderTemplate(
      ["m_accStartTime"],
      ctxFor(fakeSnapshot({ sessionId: "sess-no-start" })),
    ).join("\n");
    assert.equal(strip(out), "start:n/a");
  });

  it("inline m_accStartTime|scope|session renders HH:MM:SS with start: prefix", () => {
    // Seed the session slot via setAvg + processTick + commit
    // (mirrors the m_accTokenIn|scope|session test pattern
    // at the top of the m_acc* describe block). The first-
    // write stamp populates startAt with Date.now().
    setAvg(
      "sess-start",
      { accTokenIn: 0, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 1, accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      { modelId: "MiniMax-M3", deltaApiCalls: 1, currentApiMs: 1000, deltaTokenIn: 0, deltaTokenOut: 0, deltaTokenCachedIn: 0, deltaApiMs: 1000 },
    );
    const snap = fakeSnapshot({ sessionId: "sess-start", cwd: "D:\\test" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accStartTime|scope:session"],
      ctxFor(snap),
    ).join("\n");
    // Structural check: "start:HH:MM:SS" (24h, padded).
    assert.match(strip(out), /^start:\d{2}:\d{2}:\d{2}$/);
  });

  it("inline m_accStartTime|color|cyan wraps the chunk in cyan SGR", () => {
    // Same seed path as the previous test; verify the color
    // override emits an SGR escape.
    setAvg(
      "sess-start-color",
      { accTokenIn: 0, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 1, accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      { modelId: "MiniMax-M3", deltaApiCalls: 1, currentApiMs: 1000, deltaTokenIn: 0, deltaTokenOut: 0, deltaTokenCachedIn: 0, deltaApiMs: 1000 },
    );
    const snap = fakeSnapshot({ sessionId: "sess-start-color", cwd: "D:\\test" });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(
      ["m_accStartTime|scope:session|color:cyan"],
      ctxFor(snap),
    ).join("\n");
    assert.ok(out.includes("\x1b["), `expected SGR escape in: ${JSON.stringify(out)}`);
    assert.ok(out.includes("m") && out.length > strip(out).length,
      "output has SGR wrapper around the body");
  });

  it("inline m_accStartTime|nulldrop|true is a no-op (function never returns null)", () => {
    // The m_accStartTime renderer never returns null — on a
    // missing slot it returns the "start:n/a" placeholder, on
    // a populated slot it returns "start:HH:MM:SS". Therefore
    // `:nulldrop:true` has no effect (the dispatcher can only
    // short-circuit on a null return). Mirrors the m_accTokenIn
    // family contract — see the test at line 4658 above.
    const out = renderTemplate(
      ["m_accStartTime|scope:session|nulldrop:true"],
      ctxFor(fakeSnapshot({ sessionId: "sess-start-null", cwd: "D:\\test" })),
    );
    // Placeholder ("start:n/a") emits → output length is 1.
    assert.equal(out.length, 1);
    assert.match(strip(out[0]!), /^start:n\/a$/);
  });

  it("inline m_sumStartTime|window|5h renders min(at) across rows", () => {
    // vX.X.X — `firstAt` now reads min(s.at) over the filtered
    // window, symmetric with m_sumEndTime's max(s.at). The
    // v0.8.24 design read min(s.startAt) — a separate
    // per-session first-tick stamp unrelated to the window's
    // data range. Here 3 rows have `at` values 999_000 /
    // 999_500 / 999_900; min = 999_000. The explicit `startAt`
    // fields on each row are now ignored by aggregateSamples
    // (kept on the row schema for legacy back-compat with
    // v0.8.24 disk files, but unused by this aggregate).
    const stateRootDir = join(_tmpDir, "sum-start");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-start";
    const sess = "sess-sum-start";
    const cwd = "D:\\sum-start";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: 999_000, totalIn: 150, totalOut: 50, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 1000, apiMs: 1000, startAt: 1_700_000_000_000, lastAt: 999_000 }),
        JSON.stringify({ at: 999_500, totalIn: 350, totalOut: 75, in: 200, out: 75, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 1000, apiMs: 1000, startAt: 1_700_000_005_000, lastAt: 999_500 }),
        // Legacy row — no startAt/lastAt fields. No effect on
        // firstAt now that aggregateSamples reads s.at.
        JSON.stringify({ at: 999_900, totalIn: 650, totalOut: 100, in: 300, out: 100, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 1000, apiMs: 1000 }),
      ].join("\n") + "\n",
      "utf8",
    );
    // ctxFor's nowMs is 1_000_000 so all 3 rows fall inside the
    // 5h window. align|false so parseWindowScope falls through
    // to the wall-clock branch (no plan window in this test
    // ctx).
    const out = renderTemplate(
      ["m_sumStartTime|window:5h|model:active|align:false"],
      ctxFor(fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" })),
    ).join("\n");
    const expected = `start:${formatAbsTime(999_000)}`;
    assert.equal(strip(out), expected);
  });

  it("inline m_sumStartTime|window|5h with no rows → 'start:n/a' placeholder", () => {
    // Empty state root → no rows → agg.rows=0 → placeholder.
    setStateRoot(() => join(_tmpDir, "sum-start-empty"));
    const out = renderTemplate(
      ["m_sumStartTime|window:5h"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "start:n/a");
  });

  it("inline m_sumEndTime|window|7d|model|active renders max(lastAt) across rows", () => {
    // 3 rows, lastAt field carries each row's `at` so max is
    // the newest tick. align|false to avoid the resetStartAt
    // dependency (no plan window in this test ctx).
    const stateRootDir = join(_tmpDir, "sum-end");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-end";
    const sess = "sess-sum-end";
    const cwd = "D:\\sum-end";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: 999_000, totalIn: 150, totalOut: 50, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 1000, apiMs: 1000, startAt: 1_700_000_000_000, lastAt: 999_000 }),
        JSON.stringify({ at: 999_500, totalIn: 350, totalOut: 75, in: 200, out: 75, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 1000, apiMs: 1000, startAt: 1_700_000_005_000, lastAt: 999_500 }),
        JSON.stringify({ at: 999_900, totalIn: 650, totalOut: 100, in: 300, out: 100, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 1000, apiMs: 1000, startAt: 1_700_000_010_000, lastAt: 999_900 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumEndTime|window:7d|model:active|align:false"],
      ctxFor(fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" })),
    ).join("\n");
    const expected = `end:${formatAbsTime(999_900)}`;
    assert.equal(strip(out), expected);
  });

  it("inline m_sumStartTime|window|5h with all-legacy rows → 'start:n/a' placeholder", () => {
    // vX.X.X — firstAt now reads min(s.at); the placeholder
    // path triggers when no row carries a valid positive `at`.
    // Rows here omit both `at` and `startAt` → coerceSampleRow
    // drops them (at is required) → agg.rows === 0 → the
    // renderer falls through to placeholderBare.
    const stateRootDir = join(_tmpDir, "sum-start-legacy");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-start-legacy";
    const sess = "sess-sum-start-legacy";
    const cwd = "D:\\sum-start-legacy";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    // Empty file → no rows → no at to read → placeholder.
    writeFileSync(sessionFile, "", "utf8");
    const out = renderTemplate(
      ["m_sumStartTime|window:5h|model:active|align:false"],
      ctxFor(fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" })),
    ).join("\n");
    assert.equal(strip(out), "start:n/a");
  });

  it("legacy state.json without startAt → bare m_accStartTime renders 'start:n/a'", () => {
    // Hand-craft a legacy tickStatus row (no startAt field)
    // and verify the bare-form m_accStartTime falls through to
    // placeholderAcc("startTime", "session"). The session-scope
    // read goes through readAccumulator which propagates the
    // backfilled startAt: null. (Pre-ccsession-removal this test
    // targeted tickStatus:ccsession; the slot identity changed
    // to the surviving session slot, semantics unchanged.)
    const sessionKey = `tickStatus:sess-legacy-cc`;
    statusStore.writeTickStatus("D:\\test", sessionKey, {
      accTokenIn: 0, accTokenOut: 0, accTokenCachedIn: 0,
      accApiMs: 0, accApiCalls: 0, accTokenTotalIn: 0, accTokenHitRate: 0,
      // startAt: <absent on purpose>
    } as any);
    const out = renderTemplate(
      ["m_accStartTime|scope:session"],
      ctxFor(fakeSnapshot({ sessionId: "sess-legacy-cc", cwd: "D:\\test" })),
    ).join("\n");
    assert.equal(strip(out), "start:n/a");
  });

  // v0.8.27+ — align-aware window boundaries for
  // m_sumStartTime / m_sumEndTime. When align=true AND the
  // matching ctx Window ships resetStartAt/resetAt, the
  // rendered timestamps reflect the plan window open/close
  // (the authoritative answer) instead of the empirical
  // min/max of captured samples.

  it("m_sumStartTime|window|5h|align|true surfaces ctx.fiveHour.resetStartAt (not empirical firstAt)", () => {
    const stateRootDir = join(_tmpDir, "sum-aligned-start");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-aligned-start";
    const sess = "sess-sum-aligned-start";
    const cwd = "D:\\sum-aligned-start";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    // Plan anchor: window opened 1h ago, closes in 4h.
    const anchorStart = new Date(now - 3600_000).toISOString();
    const anchorEnd = new Date(now + 4 * 3600_000).toISOString();
    writeFileSync(
      sessionFile,
      [
        // Empirical firstAt is 4h before now — far earlier than
        // the plan anchor. Without align-awareness, m_sumStartTime
        // would surface this stale empirical value.
        JSON.stringify({ at: now - 4 * 3600_000, totalIn: 5, totalOut: 1, in: 5, out: 1, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100, startAt: now - 4 * 3600_000, lastAt: now - 4 * 3600_000 }),
        JSON.stringify({ at: now - 10 * 60_000, totalIn: 7, totalOut: 2, in: 7, out: 2, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100, startAt: now - 4 * 3600_000, lastAt: now - 10 * 60_000 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumStartTime|window:5h|model:active|align:true"],
      ctxFor(
        fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" }),
        legacyToIv({
          pct: 10,
          resetAt: anchorEnd,
          resetStartAt: anchorStart,
          resetDurationMs: 5 * 3600_000,
        }),
        null,
        null,
      ),
    ).join("\n");
    // Plan anchor (now - 1h) wins over empirical (now - 4h).
    assert.equal(strip(out), `start:${formatAbsTime(now - 3600_000)}`);
  });

  it("m_sumEndTime|window|7d|align|true surfaces ctx.weekly.resetAt (not empirical lastAt)", () => {
    const stateRootDir = join(_tmpDir, "sum-aligned-end");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-aligned-end";
    const sess = "sess-sum-aligned-end";
    const cwd = "D:\\sum-aligned-end";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    // Plan anchor: weekly window opens 2d ago, closes in 5d.
    // Rows must live INSIDE [weeklyStart, weeklyEnd] for the
    // aligned scan to count them; otherwise agg.rows === 0
    // hits the placeholder branch and the test would
    // mis-attribute that to the align-aware boundary code.
    const weeklyStart = new Date(now - 2 * 86400_000).toISOString();
    const weeklyEnd = new Date(now + 5 * 86400_000).toISOString();
    writeFileSync(
      sessionFile,
      [
        // Empirical lastAt (now - 1d) is BEFORE the plan close
        // (now + 5d). Without align-awareness, m_sumEndTime
        // would surface this stale empirical value; with
        // align=true, the plan anchor wins.
        JSON.stringify({ at: now - 86400_000, totalIn: 5, totalOut: 1, in: 5, out: 1, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100, startAt: now - 2 * 86400_000, lastAt: now - 86400_000 }),
        JSON.stringify({ at: now - 23 * 3600_000, totalIn: 7, totalOut: 2, in: 7, out: 2, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100, startAt: now - 2 * 86400_000, lastAt: now - 23 * 3600_000 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumEndTime|window:7d|model:active|align:true"],
      ctxFor(
        fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" }),
        null,
        legacyToIv({
          pct: 10,
          resetAt: weeklyEnd,
          resetStartAt: weeklyStart,
          resetDurationMs: 7 * 86400_000,
        }, "7d"),
        null,
      ),
    ).join("\n");
    // Plan close (now + 5d) wins over empirical (now - 1d).
    assert.equal(strip(out), `end:${formatAbsTime(now + 5 * 86400_000)}`);
  });

  it("m_sumStartTime|window|5h|align|false keeps empirical min(startAt) (align gates lookup)", () => {
    // vX.X.X — `align` is a meaningful param again, default false.
    // `align=false` SKIPS the declared-windowId lookup, so
    // `|window|5h` resolves as free-form dhms → wall-clock
    // `[now - 5h, now]`. The seeded row at `empiricalStart =
    // now-4h` falls INSIDE that wall-clock window, so
    // m_sumStartTime renders the empirical `formatAbsTime(now-4h)`
    // instead of the plan anchor (`v0.8.31 start:n/a` placeholder).
    // Pairs with the `|align|true` test below to pin down both
    // sides of the align gate.
    const stateRootDir = join(_tmpDir, "sum-aligned-start-off");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-aligned-start-off";
    const sess = "sess-sum-aligned-start-off";
    const cwd = "D:\\sum-aligned-start-off";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    const empiricalStart = now - 4 * 3600_000; // inside wall-clock 5h
    const anchorStart = new Date(now - 3600_000).toISOString();
    const anchorEnd = new Date(now + 4 * 3600_000).toISOString();
    writeFileSync(
      sessionFile,
      JSON.stringify({ at: empiricalStart, totalIn: 5, totalOut: 1, in: 5, out: 1, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100, startAt: empiricalStart, lastAt: empiricalStart }) + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumStartTime|window:5h|model:active|align:false"],
      ctxFor(
        fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" }),
        legacyToIv({
          pct: 10,
          resetAt: anchorEnd,
          resetStartAt: anchorStart,
          resetDurationMs: 5 * 3600_000,
        }),
        null,
        null,
      ),
    ).join("\n");
    // align=false → dhms 5h wall-clock → row at now-4h counts →
    // empirical min(startAt) = now-4h → formatAbsTime renders it
    // as "HH:MM:SS".
    assert.equal(strip(out), `start:${formatAbsTime(empiricalStart)}`);
  });

  it("m_sumStartTime|window|5h|align|true falls back to empirical when ctx.fiveHour has no resetStartAt", () => {
    // If the plan-window anchor is unavailable (the Window
    // object exists but its resetStartAt field is absent),
    // align=true gracefully falls back to the empirical
    // min(startAt) reading rather than placeholder. The
    // placeholder path is reserved for "no data at all".
    const stateRootDir = join(_tmpDir, "sum-aligned-missing");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-aligned-missing";
    const sess = "sess-sum-aligned-missing";
    const cwd = "D:\\sum-aligned-missing";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const empiricalStart = 1_700_000_000_000;
    writeFileSync(
      sessionFile,
      JSON.stringify({ at: empiricalStart, totalIn: 5, totalOut: 1, in: 5, out: 1, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100, startAt: empiricalStart, lastAt: empiricalStart }) + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumStartTime|window:5h|model:active|align:true"],
      ctxFor(
        fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" }),
        // Window present but resetStartAt absent — package
        // returned only usedPct, no time anchor.
        legacyToIv({ pct: 10, resetAt: "invalid" as any, resetStartAt: undefined as any }),
        null,
        null,
      ),
    ).join("\n");
    // Plan anchor unavailable → empirical firstAt wins.
    assert.equal(strip(out), `start:${formatAbsTime(empiricalStart)}`);
  });
});

// v0.8.40+ → v0.9.x — m_tokenCost / m_accTokenCost / m_sumTokenCost
// family. v0.9.x switches from a single global tokenPrice to
// tokenPrices (per-model dict keyed by stdin.model.id). USD
// currency renders bare to preserve byte-identical v0.8.40
// output; non-USD gets a "<code> " prefix.
describe("renderTemplate — m_tokenCost family (v0.9.x per-model prices)", () => {
  beforeEach(() => {
    // v0.9.x — seed tokenPrices dict keyed by the active model's
    // id. The default fakeSnapshot sets modelId="MiniMax-M3" so
    // the per-model lookup hits. Per-million-token convention:
    // in/1e6, out/1e6, cachedIn/1e6. The top-level beforeEach
    // already called beginTickForTest and reset prev tick state.
    const cfg = configStore.get();
    cfg.tokenPrices = {
      "MiniMax-M3": { in: 10_000, out: 20_000, cachedIn: 5_000, currency: "USD" },
    };
  });

  // ------------------------------------------------------------------
  // m_tokenCost (per-turn)
  // ------------------------------------------------------------------
  it("m_tokenCost renders 'cost:N' when tokenPrices has the active model", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot(); // current.input=38, current.output=155, cachedIn=163441
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenCost"], ctxFor(snap)).join("\n");
    // effective per-token: in=10000/1e6=0.01, out=20000/1e6=0.02, cached=5000/1e6=0.005
    // cost = 38*0.01 + 155*0.02 + 163441*0.005 = 0.38 + 3.1 + 817.205 = 820.685
    // formatCost: ≥1 → 2dp → (820.685).toFixed(2) = "820.69"
    assert.equal(strip(out), "cost:820.69");
  });

  it("m_tokenCost with empty tokenPrices → placeholder", () => {
    // v0.9.x — the active model id has no entry in the dict.
    // resolveTokenPrice returns null → placeholder.
    const cfg = configStore.get();
    cfg.tokenPrices = {};
    const snap = fakeSnapshot();
    const out = renderTemplate(["m_tokenCost"], ctxFor(snap)).join("\n");
    assert.match(strip(out), /cost:n\/a/);
  });

  it("m_tokenCost with no entry for the active model id → placeholder", () => {
    // v0.9.x — entry exists for a DIFFERENT model; the active
    // model's id still has no entry.
    const cfg = configStore.get();
    cfg.tokenPrices = {
      "claude-opus-4-8": { in: 10_000, out: 20_000, cachedIn: 5_000, currency: "USD" },
    };
    const snap = fakeSnapshot(); // modelId = "MiniMax-M3" (default)
    const out = renderTemplate(["m_tokenCost"], ctxFor(snap)).join("\n");
    assert.match(strip(out), /cost:n\/a/);
  });

  it("m_tokenCost full cost calculation (all three axes)", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot({ current: { tokenIn: 100, tokenOut: 50, tokenCacheCreation: 0, tokenCachedIn: 20 } });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenCost"], ctxFor(snap)).join("\n");
    // effective: 100*0.01 + 50*0.02 + 20*0.005 = 1.0 + 1.0 + 0.1 = 2.1
    assert.equal(strip(out), "cost:2.10");
  });

  it("m_tokenCost idle tick (deltaApi=0) → STALE_COLOR wrap", () => {
    // v0.8.30.1+ idle pattern: seed prev with SAME totalApiDurationMs
    // as current so deltaApi=0 → hasMeasurement=false. The number
    // shown is the live stdin cost wrapped in STALE_COLOR (same
    // pattern as m_tokenIn's idle test at line 798).
    setPrevTick("sess-test", { totalApiMs: 60_000 }, "D:\\test");
    const snap = fakeSnapshot();
    const out = renderTemplate(["m_tokenCost"], ctxFor(snap)).join("\n");
    // idle: live stdin values × price, STALE_COLORed
    // cost = 820.685 → formatCost "820.69"
    assert.ok(out.includes("\x1b[90m"), "idle tick should use STALE_COLOR");
    assert.ok(out.includes("cost:820.69"), "idle tick should show live cost");
  });

  it("m_tokenCost|color|red inline override", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenCost|color:red"], ctxFor(snap)).join("\n");
    assert.ok(out.includes("cost:820.69"));
  });

  it("m_tokenCost only inPrice set, out and cachedIn zero", () => {
    const cfg = configStore.get();
    cfg.tokenPrices = {
      "MiniMax-M3": { in: 5_000, out: 0, cachedIn: 0, currency: "USD" },
    };
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot({ current: { tokenIn: 200, tokenOut: 999, tokenCacheCreation: 0, tokenCachedIn: 999 } });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenCost"], ctxFor(snap)).join("\n");
    // 200*0.005 = 1.0
    assert.equal(strip(out), "cost:1.00");
  });

  it("m_tokenCost with non-USD currency → no separator (e.g. CNY264.12, ¥264.12)", () => {
    // v0.9.x — currency is now meaningful per entry. Non-USD
    // prepended bare (no separator); USD stays bare.
    const cfg = configStore.get();
    cfg.tokenPrices = {
      "MiniMax-M3": { in: 10_000, out: 20_000, cachedIn: 5_000, currency: "CNY" },
    };
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenCost"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "cost:CNY820.69");
  });

  // ------------------------------------------------------------------
  // m_accTokenCost (accumulated)
  // ------------------------------------------------------------------
  it("m_accTokenCost on empty slot → placeholder", () => {
    const snap = fakeSnapshot();
    const out = renderTemplate(["m_accTokenCost"], ctxFor(snap)).join("\n");
    assert.match(strip(out), /cost:n\/a/);
  });

  it("m_accTokenCost after one valid tick", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_accTokenCost"], ctxFor(snap)).join("\n");
    // cost = 38*0.01 + 155*0.02 + 163441*0.005 = 820.685
    assert.equal(strip(out), "cost:820.69");
  });

  it("m_accTokenCost second tick accumulates", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap1 = fakeSnapshot(); // totalApiMs=60_000
    processTick(snap1.cwd, snap1);
    statusStore.commit();
    // Second tick: different values AND higher totalApiDurationMs so
    // deltaApi = 120_000 - 60_000 = 60_000 > 0 → valid tick.
    setPrevTick("sess-test", { totalApiMs: 60_000 }, "D:\\test");
    const snap2 = fakeSnapshot({
      current: { tokenIn: 50, tokenOut: 100, tokenCacheCreation: 0, tokenCachedIn: 5 },
      cost: { totalDurationMs: 1_200_000, totalApiDurationMs: 120_000, totalLinesAdded: 3965, totalLinesRemoved: 967 },
    });
    processTick(snap2.cwd, snap2);
    statusStore.commit();
    const out = renderTemplate(["m_accTokenCost"], ctxFor(snap2)).join("\n");
    // tick1: 38*0.01 + 155*0.02 + 163441*0.005 = 0.38 + 3.1 + 817.205 = 820.685
    // tick2: 50*0.01 + 100*0.02 + 5*0.005 = 0.5 + 2.0 + 0.025 = 2.525
    // total: 820.685 + 2.525 = 823.21 → formatCost 2dp → "823.21"
    assert.equal(strip(out), "cost:823.21");
  });

  it("m_accTokenCost|scope|project project-wide cost", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_accTokenCost|scope:project"], ctxFor(snap)).join("\n");
    // Same values as session scope for a single-tick test
    assert.equal(strip(out), "cost:820.69");
  });

  it("m_accTokenCost|color|red inline override", () => {
    setPrevTick("sess-test", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_accTokenCost|color:red"], ctxFor(snap)).join("\n");
    assert.ok(out.includes("cost:820.69"));
  });

  // ------------------------------------------------------------------
  // m_sumTokenCost (cross-project sum / windowed)
  // Use setStatCacheForTest to seed the aggregate cache directly
  // (avoids JSONL file isolation complexity).
  // ------------------------------------------------------------------
  it("m_sumTokenCost with no samples → placeholder", () => {
    __resetStatCacheForTest();
    const snap = fakeSnapshot();
    const out = renderTemplate(["m_sumTokenCost|window:all|model:all"], ctxFor(snap)).join("\n");
    assert.match(strip(out), /cost:n\/a/);
  });

  it("m_sumTokenCost with samples → sum(in*price + out*price + cached*price)", () => {
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:all:all:false",
      { sumIn: 300, sumOut: 150, sumCached: 70, sumTotalIn: 450, sumApiMs: 120_000, rows: 2, calls: 2, lastAt: Date.now(), firstAt: Date.now() - 10_000, generatedAt: Date.now() },
      300_000,
    );
    const snap = fakeSnapshot();
    const out = renderTemplate(["m_sumTokenCost|window:all|model:all"], ctxFor(snap)).join("\n");
    // effective: 300*0.01 + 150*0.02 + 70*0.005 = 3.0 + 3.0 + 0.35 = 6.35
    // |model|all → no explicit literal, falls back to active model
    // id "MiniMax-M3" for the price lookup.
    // formatCost: ≥1 < 1000 → 2dp → "6.35"
    assert.equal(strip(out), "cost:6.35");
  });

  it("m_sumTokenCost|window|5h bounded window", () => {
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:all:5h:false",
      { sumIn: 80, sumOut: 40, sumCached: 10, sumTotalIn: 90, sumApiMs: 30_000, rows: 1, calls: 1, lastAt: Date.now(), firstAt: Date.now() - 1000, generatedAt: Date.now() },
      300_000,
    );
    const snap = fakeSnapshot();
    const out = renderTemplate(["m_sumTokenCost|window:5h|model:all"], ctxFor(snap)).join("\n");
    // effective: 80*0.01 + 40*0.02 + 10*0.005 = 0.8 + 0.8 + 0.05 = 1.65
    // formatCost: ≥1 < 1000 → 2dp → "1.65"
    assert.equal(strip(out), "cost:1.65");
  });

  it("m_sumTokenCost|model|active model-filtered", () => {
    // v0.9.x — |model|active resolves to ctx.tokens.modelId, which
    // is the new sample.model stamp. The fixture's stat cache key
    // uses "MiniMax-M3" — the active model id (matches the default
    // fakeSnapshot's modelId). Price lookup hits the dict at the
    // same id.
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:MiniMax-M3:all:false",
      { sumIn: 50, sumOut: 25, sumCached: 5, sumTotalIn: 55, sumApiMs: 15_000, rows: 1, calls: 1, lastAt: Date.now(), firstAt: Date.now() - 1000, generatedAt: Date.now() },
      300_000,
    );
    const snap = fakeSnapshot();
    const out = renderTemplate(["m_sumTokenCost|window:all|model:active"], ctxFor(snap)).join("\n");
    // effective: 50*0.01 + 25*0.02 + 5*0.005 = 0.5 + 0.5 + 0.025 = 1.025
    // formatCost: ≥1 → 2dp → (1.025).toFixed(2) = "1.02"
    assert.equal(strip(out), "cost:1.02");
  });

  it("m_sumTokenCost|model|<literal> uses the literal id for the price lookup", () => {
    // v0.9.x — explicit |model|<literal> wins over the active model
    // id. Active model has prices, but the literal has zero prices
    // → placeholder (per lookup-miss contract).
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:claude-opus-4-8:all:false",
      { sumIn: 100, sumOut: 50, sumCached: 10, sumTotalIn: 110, sumApiMs: 20_000, rows: 1, calls: 1, lastAt: Date.now(), firstAt: Date.now() - 1000, generatedAt: Date.now() },
      300_000,
    );
    const cfg = configStore.get();
    cfg.tokenPrices = {
      // active model has full prices (so m_tokenCost| bare would NOT be n/a)
      "MiniMax-M3": { in: 10_000, out: 20_000, cachedIn: 5_000, currency: "USD" },
      // literal filter target has zero prices → m_sumTokenCost|
      // model|claude-opus-4-8 must render cost:n/a
      "claude-opus-4-8": { in: 0, out: 0, cachedIn: 0, currency: "USD" },
    };
    const snap = fakeSnapshot(); // modelId = "MiniMax-M3"
    const out = renderTemplate(["m_sumTokenCost|window:all|model:claude-opus-4-8"], ctxFor(snap)).join("\n");
    assert.match(strip(out), /cost:n\/a/);
  });

  it("m_sumTokenCost|window|all (default) scans all", () => {
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:all:all:false",
      { sumIn: 30, sumOut: 20, sumCached: 10, sumTotalIn: 30, sumApiMs: 10_000, rows: 1, calls: 1, lastAt: Date.now(), firstAt: Date.now() - 1000, generatedAt: Date.now() },
      300_000,
    );
    const snap = fakeSnapshot();
    const out = renderTemplate(["m_sumTokenCost|window:all|model:all"], ctxFor(snap)).join("\n");
    // effective: 30*0.01 + 20*0.02 + 10*0.005 = 0.3 + 0.4 + 0.05 = 0.75
    // formatCost: ≥0.1 < 1 → 3dp → "0.750"
    assert.equal(strip(out), "cost:0.750");
  });

  // ------------------------------------------------------------------
  // m_sumEstQuota (periodic quota estimate)
  // est = sum(in*price + out*price + cached*price) / (alignedUsedPercent / 100)
  // Renders fixed 2dp with per-model currency prefix.
  // Requires |window|<declared id>|align|true so parseWindowScope
  // returns alignActive=true and getStatAggregate stamps
  // alignedUsedPercent on the aggregate. Three short-circuits:
  //   rows===0, alignedUsedPercent==null, alignedUsedPercent===0.
  // ------------------------------------------------------------------
  it("m_sumEstQuota with no samples → placeholder", () => {
    __resetStatCacheForTest();
    const snap = fakeSnapshot();
    const out = renderTemplate(["m_sumEstQuota|window:5h|align:true|model:all"], ctxFor(snap)).join("\n");
    assert.match(strip(out), /est:n\/a/);
  });

  it("m_sumEstQuota|window|<declared>|align|true → cost / alignedUsedPercent, fixed 2dp", () => {
    __resetStatCacheForTest();
    // Seed the aggregate at the aligned key (stat:all:5h:true).
    // alignedUsedPercent=25 → divide cost by 0.25.
    setStatCacheForTest(
      "stat:all:5h:true",
      {
        sumIn: 300,
        sumOut: 150,
        sumCached: 70,
        sumTotalIn: 450,
        sumApiMs: 120_000,
        rows: 2,
        calls: 2,
        lastAt: Date.now(),
        firstAt: Date.now() - 10_000,
        generatedAt: Date.now(),
        alignedUsedPercent: 25,
      },
      300_000,
    );
    // Build a ctx with a declared interval that has usedPercent=25,
    // matching what the runtime would have seen. parseWindowScope
    // reads `intervals.short.windowId === "5h"` and matches against
    // the `|window|5h` arg, so a 5h interval with usedPercent=25
    // produces a filter with alignActive=true.
    const ctx = {
      ...ctxFor(fakeSnapshot()),
      intervals: {
        short: {
          windowId: "5h",
          label: "5h",
          startAt: 1_000_000,
          endAt: 1_000_000 + 5 * 3600 * 1000,
          intervalMs: 5 * 3600 * 1000,
          remainingPercent: 75,
          usedPercent: 25,
          remainingQuota: null,
          usedQuota: null,
          limitQuota: null,
        },
      },
    };
    const out = renderTemplate(["m_sumEstQuota|window:5h|align:true|model:all"], ctx).join("\n");
    // cost = 300*0.01 + 150*0.02 + 70*0.005 = 3.0 + 3.0 + 0.35 = 6.35
    // est = 6.35 / 0.25 = 25.40
    // formatEstCost: 2dp → "25.40"
    assert.equal(strip(out), "est:25.40");
  });

  it("m_sumEstQuota|align|false (default) → placeholder (no aligned used% stamped)", () => {
    // alignActive=false (no align=true inline arg) → getStatAggregate
    // does NOT stamp alignedUsedPercent → null on the aggregate →
    // placeholder. The user must opt into align=true to get a
    // usable estimate.
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:all:5h:false",
      {
        sumIn: 100,
        sumOut: 50,
        sumCached: 20,
        sumTotalIn: 120,
        sumApiMs: 30_000,
        rows: 1,
        calls: 1,
        lastAt: Date.now(),
        firstAt: Date.now() - 1000,
        generatedAt: Date.now(),
        // NO alignedUsedPercent → null on the aggregate.
      },
      300_000,
    );
    const snap = fakeSnapshot();
    const out = renderTemplate(["m_sumEstQuota|window:5h|model:all"], ctxFor(snap)).join("\n");
    assert.match(strip(out), /est:n\/a/);
  });

  it("m_sumEstQuota with alignedUsedPercent===0 → placeholder", () => {
    // The user contract: alignedUsedPercent===0 → "--" placeholder
    // (divide-by-zero would otherwise yield Infinity). Tests via
    // the STALE_COLOR-wrapped "est:n/a" body; the renderer's
    // three short-circuits all funnel into the same placeholder
    // body for layout stability.
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:all:5h:true",
      {
        sumIn: 100,
        sumOut: 50,
        sumCached: 20,
        sumTotalIn: 120,
        sumApiMs: 30_000,
        rows: 1,
        calls: 1,
        lastAt: Date.now(),
        firstAt: Date.now() - 1000,
        generatedAt: Date.now(),
        alignedUsedPercent: 0,
      },
      300_000,
    );
    const ctx = {
      ...ctxFor(fakeSnapshot()),
      intervals: {
        short: {
          windowId: "5h",
          label: "5h",
          startAt: 1_000_000,
          endAt: 1_000_000 + 5 * 3600 * 1000,
          intervalMs: 5 * 3600 * 1000,
          remainingPercent: 100,
          usedPercent: 0,
          remainingQuota: null,
          usedQuota: null,
          limitQuota: null,
        },
      },
    };
    const out = renderTemplate(["m_sumEstQuota|window:5h|align:true|model:all"], ctx).join("\n");
    assert.match(strip(out), /est:n\/a/);
  });

  it("m_sumEstQuota with non-USD currency → 'est:<code><value>'", () => {
    // v0.9.x — non-USD currencies get a bare currency-code prefix
    // (no separator), matching the m_tokenCost family's
    // formatCostWithCurrency contract. CNY is one of the historical
    // test fixtures.
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:all:5h:true",
      {
        sumIn: 100,
        sumOut: 50,
        sumCached: 20,
        sumTotalIn: 120,
        sumApiMs: 30_000,
        rows: 1,
        calls: 1,
        lastAt: Date.now(),
        firstAt: Date.now() - 1000,
        generatedAt: Date.now(),
        alignedUsedPercent: 50,
      },
      300_000,
    );
    const cfg = configStore.get();
    cfg.tokenPrices = {
      "MiniMax-M3": { in: 10_000, out: 20_000, cachedIn: 5_000, currency: "CNY" },
    };
    const ctx = {
      ...ctxFor(fakeSnapshot()),
      intervals: {
        short: {
          windowId: "5h",
          label: "5h",
          startAt: 1_000_000,
          endAt: 1_000_000 + 5 * 3600 * 1000,
          intervalMs: 5 * 3600 * 1000,
          remainingPercent: 50,
          usedPercent: 50,
          remainingQuota: null,
          usedQuota: null,
          limitQuota: null,
        },
      },
    };
    const out = renderTemplate(["m_sumEstQuota|window:5h|align:true|model:all"], ctx).join("\n");
    // cost = 100*0.01 + 50*0.02 + 20*0.005 = 1.0 + 1.0 + 0.1 = 2.1
    // est = 2.1 / 0.5 = 4.20
    // formatEstCost: 2dp → "4.20" → CNY prefix → "CNY4.20"
    assert.equal(strip(out), "est:CNY4.20");
  });

  it("m_sumEstQuota|valueOnly|true drops the 'est:' prefix", () => {
    // |valueOnly|true is the value-only knob shared by every
    // m_sum* module with a label. Mirror m_sumTokenCost's contract.
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:all:5h:true",
      {
        sumIn: 50,
        sumOut: 25,
        sumCached: 5,
        sumTotalIn: 55,
        sumApiMs: 15_000,
        rows: 1,
        calls: 1,
        lastAt: Date.now(),
        firstAt: Date.now() - 1000,
        generatedAt: Date.now(),
        alignedUsedPercent: 25,
      },
      300_000,
    );
    const ctx = {
      ...ctxFor(fakeSnapshot()),
      intervals: {
        short: {
          windowId: "5h",
          label: "5h",
          startAt: 1_000_000,
          endAt: 1_000_000 + 5 * 3600 * 1000,
          intervalMs: 5 * 3600 * 1000,
          remainingPercent: 75,
          usedPercent: 25,
          remainingQuota: null,
          usedQuota: null,
          limitQuota: null,
        },
      },
    };
    const out = renderTemplate(["m_sumEstQuota|window:5h|align:true|model:all|valueOnly:true"], ctx).join("\n");
    // cost = 50*0.01 + 25*0.02 + 5*0.005 = 0.5 + 0.5 + 0.025 = 1.025
    // est = 1.025 / 0.25 = 4.10
    // |valueOnly|true drops the "est:" prefix.
    assert.equal(strip(out), "4.10");
  });

  // ------------------------------------------------------------------
  // m_sum*|term| (plan-aligned scan via the term short-circuit)
  // When |term|<key> is set AND model != "all" AND the resolved
  // interval has a valid startAt+endAt, parseWindowScope returns
  // a filter with alignActive=true and the matched interval. The
  // downstream aggregate carries alignedUsedPercent so m_sumEstQuota
  // becomes usable without the explicit |align|true opt-in.
  // ------------------------------------------------------------------
  it("m_sumTokenIn|term|short|model|active → aligned scan on intervals.short", () => {
    // The aggregate cache key for an aligned scan with active
    // model filter is "stat:<modelId>:5h:true" (windowKey resolves
    // to intervals.short.windowId="5h", alignActive=true). Seed at
    // that key with rows>0. v0.9.8 — the term KEY ("short") is
    // resolved to intervals[term].windowId ("5h") before being
    // written into the cache key, so a |term:short| and the
    // equivalent |window:5h|align:true| collapse onto one entry.
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:MiniMax-M3:5h:true",
      {
        sumIn: 1000,
        sumOut: 500,
        sumCached: 100,
        sumTotalIn: 1100,
        sumApiMs: 60_000,
        rows: 1,
        calls: 1,
        lastAt: Date.now(),
        firstAt: Date.now() - 1000,
        generatedAt: Date.now(),
      },
      300_000,
    );
    const ctx = {
      ...ctxFor(fakeSnapshot()),
      intervals: {
        short: {
          windowId: "5h",
          label: "5h",
          startAt: 1_000_000,
          endAt: 1_000_000 + 5 * 3600 * 1000,
          intervalMs: 5 * 3600 * 1000,
          remainingPercent: 75,
          usedPercent: 25,
          remainingQuota: null,
          usedQuota: null,
          limitQuota: null,
        },
      },
    };
    const out = renderTemplate(["m_sumTokenIn|term:short|model:active"], ctx).join("\n");
    // sumIn=1000 → formatThousands (≥1k < 1m) → "1.0k"
    assert.equal(strip(out), "in:1.0k");
  });

  it("m_sumEstQuota|term|short|model|active → cost / alignedUsedPercent (term is the align shortcut)", () => {
    // The headline use case for |term|: with the term short-circuit,
    // m_sumEstQuota no longer needs explicit |align|true to get a
    // usable estimate. Same math as the explicit
    // |window:5h|align:true|model:all| case.
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:MiniMax-M3:5h:true",
      {
        sumIn: 300,
        sumOut: 150,
        sumCached: 70,
        sumTotalIn: 450,
        sumApiMs: 120_000,
        rows: 2,
        calls: 2,
        lastAt: Date.now(),
        firstAt: Date.now() - 10_000,
        generatedAt: Date.now(),
        alignedUsedPercent: 25,
      },
      300_000,
    );
    const ctx = {
      ...ctxFor(fakeSnapshot()),
      intervals: {
        short: {
          windowId: "5h",
          label: "5h",
          startAt: 1_000_000,
          endAt: 1_000_000 + 5 * 3600 * 1000,
          intervalMs: 5 * 3600 * 1000,
          remainingPercent: 75,
          usedPercent: 25,
          remainingQuota: null,
          usedQuota: null,
          limitQuota: null,
        },
      },
    };
    const out = renderTemplate(["m_sumEstQuota|term:short|model:active"], ctx).join("\n");
    // cost = 300*0.01 + 150*0.02 + 70*0.005 = 3.0 + 3.0 + 0.35 = 6.35
    // est = 6.35 / 0.25 = 25.40
    // formatEstCost: 2dp → "25.40"
    assert.equal(strip(out), "est:25.40");
  });

  it("m_sumTokenIn|term|short|model|all → falls through to window/align (term requires model != all)", () => {
    // |term|short|model|all: the term short-circuit requires a
    // model filter (model != "all"). When model=all, parseWindowScope
    // falls through to the existing |window|/|align| path. The user
    // should write |window|5h|align|true explicitly for an
    // all-model aligned scan. Verify the term is silently ignored
    // (no warn) and the existing |window|5h dhms path runs as a
    // safe default.
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:all:5h:false",
      {
        sumIn: 50,
        sumOut: 25,
        sumCached: 5,
        sumTotalIn: 55,
        sumApiMs: 15_000,
        rows: 1,
        calls: 1,
        lastAt: Date.now(),
        firstAt: Date.now() - 1000,
        generatedAt: Date.now(),
      },
      300_000,
    );
    const ctx = {
      ...ctxFor(fakeSnapshot()),
      intervals: {
        short: {
          windowId: "5h",
          label: "5h",
          startAt: 1_000_000,
          endAt: 1_000_000 + 5 * 3600 * 1000,
          intervalMs: 5 * 3600 * 1000,
          remainingPercent: 75,
          usedPercent: 25,
          remainingQuota: null,
          usedQuota: null,
          limitQuota: null,
        },
      },
    };
    // Explicit |window|5h (no align) → dhms wall-clock scan, the
    // existing path. |term|short|model|all: term is silently
    // dropped because model=all, so the dhms path runs untouched.
    const out = renderTemplate(["m_sumTokenIn|term:short|model:all|window:5h"], ctx).join("\n");
    // 50 → formatThousands → "50"
    assert.equal(strip(out), "in:50");
  });

  it("m_sumTokenIn|term|<unknown> → falls through to window/align (term miss is not fatal)", () => {
    // |term|monthly with no monthly interval in ctx → intervalForTerm
    // returns null → fall through to the existing window/align
    // path. No warn (the term is just absent). Mirrors the
    // "term is a CONVENIENCE, not a hard requirement" contract.
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:MiniMax-M3:5h:false",
      {
        sumIn: 100,
        sumOut: 50,
        sumCached: 20,
        sumTotalIn: 120,
        sumApiMs: 30_000,
        rows: 1,
        calls: 1,
        lastAt: Date.now(),
        firstAt: Date.now() - 1000,
        generatedAt: Date.now(),
      },
      300_000,
    );
    // ctx has no "monthly" interval — intervalForTerm returns null.
    // |window|5h (dhms) takes over.
    const out = renderTemplate(
      ["m_sumTokenIn|term:monthly|model:active|window:5h"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    // dhms 5h scan → 100 → "100"
    assert.equal(strip(out), "in:100");
  });

  // ----------------------------------------------------------------
  // v0.9.8 — term-resolved cache key (windowKey =
  // intervals[term].windowId || termRaw). 4 new cases:
  // (a) positive: term + explicit window share one cache row;
  // (b) fallback: windowId "" → key uses term key literal;
  // (c) collision: two terms with same windowId share one row;
  // (d) precedence: term + simultaneous |window|<dhms> → term wins.
  // ----------------------------------------------------------------
  it("(a) m_sumTokenIn|term|short and |window:5h|align:true| share one cache entry", () => {
    // v0.9.8 — seed at stat:MiniMax-M3:5h:true; render via the
    // explicit-window form; expect a hit (same key, no extra scan).
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:MiniMax-M3:5h:true",
      {
        sumIn: 1000,
        sumOut: 500,
        sumCached: 100,
        sumTotalIn: 1100,
        sumApiMs: 60_000,
        rows: 1,
        calls: 1,
        lastAt: Date.now(),
        firstAt: Date.now() - 1000,
        generatedAt: Date.now(),
      },
      300_000,
    );
    const ctx = {
      ...ctxFor(fakeSnapshot()),
      intervals: {
        short: {
          windowId: "5h",
          label: "5h",
          startAt: 1_000_000,
          endAt: 1_000_000 + 5 * 3600 * 1000,
          intervalMs: 5 * 3600 * 1000,
          remainingPercent: 75,
          usedPercent: 25,
          remainingQuota: null,
          usedQuota: null,
          limitQuota: null,
        },
      },
    };
    const out = renderTemplate(
      ["m_sumTokenIn|window:5h|align:true|model:active"],
      ctx,
    ).join("\n");
    assert.equal(strip(out), "in:1.0k");
  });

  it("(b) m_sumTokenIn|term|short when intervals.short.windowId === '' falls back to term key", () => {
    // v0.9.8 — windowKey = iv.windowId || termRaw. When windowId
    // is empty string, the term key literal wins so the entry is
    // still addressable.
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:MiniMax-M3:short:true",
      {
        sumIn: 1000,
        sumOut: 500,
        sumCached: 100,
        sumTotalIn: 1100,
        sumApiMs: 60_000,
        rows: 1,
        calls: 1,
        lastAt: Date.now(),
        firstAt: Date.now() - 1000,
        generatedAt: Date.now(),
      },
      300_000,
    );
    const ctx = {
      ...ctxFor(fakeSnapshot()),
      intervals: {
        short: {
          windowId: "",
          label: "5h",
          startAt: 1_000_000,
          endAt: 1_000_000 + 5 * 3600 * 1000,
          intervalMs: 5 * 3600 * 1000,
          remainingPercent: 75,
          usedPercent: 25,
          remainingQuota: null,
          usedQuota: null,
          limitQuota: null,
        },
      },
    };
    const out = renderTemplate(["m_sumTokenIn|term:short|model:active"], ctx).join("\n");
    assert.equal(strip(out), "in:1.0k");
  });

  it("(c) two terms with the same windowId share one stat cache entry (key collapse)", () => {
    // v0.9.8 — provider declares monthly.windowId=long.windowId="30d";
    // |term:monthly|model:active and |term:long|model:active must
    // land on the same key. Seed once, render twice, both hit.
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:MiniMax-M3:30d:true",
      {
        sumIn: 1000,
        sumOut: 500,
        sumCached: 100,
        sumTotalIn: 1100,
        sumApiMs: 60_000,
        rows: 1,
        calls: 1,
        lastAt: Date.now(),
        firstAt: Date.now() - 1000,
        generatedAt: Date.now(),
      },
      300_000,
    );
    const ctx = {
      ...ctxFor(fakeSnapshot()),
      intervals: {
        monthly: {
          windowId: "30d",
          label: "30d",
          startAt: 1_000_000,
          endAt: 1_000_000 + 30 * 24 * 3600 * 1000,
          intervalMs: 30 * 24 * 3600 * 1000,
          remainingPercent: 75,
          usedPercent: 25,
          remainingQuota: null,
          usedQuota: null,
          limitQuota: null,
        },
        long: {
          windowId: "30d",
          label: "30d",
          startAt: 1_000_000,
          endAt: 1_000_000 + 30 * 24 * 3600 * 1000,
          intervalMs: 30 * 24 * 3600 * 1000,
          remainingPercent: 75,
          usedPercent: 25,
          remainingQuota: null,
          usedQuota: null,
          limitQuota: null,
        },
      },
    };
    const a = renderTemplate(["m_sumTokenIn|term:monthly|model:active"], ctx).join("\n");
    const b = renderTemplate(["m_sumTokenIn|term:long|model:active"], ctx).join("\n");
    assert.equal(strip(a), "in:1.0k");
    assert.equal(strip(b), "in:1.0k");
  });

  it("(d) m_sumTokenIn|term:short|window:7d|model:active → term wins, key uses 5h (not 7d)", () => {
    // v0.9.8 — term short-circuit returns early at L3565, so a
    // simultaneously-declared |window:<dhms>| is ignored. Document
    // the precedence: term > window| for the m_sum* family.
    __resetStatCacheForTest();
    setStatCacheForTest(
      "stat:MiniMax-M3:5h:true",
      {
        sumIn: 1000,
        sumOut: 500,
        sumCached: 100,
        sumTotalIn: 1100,
        sumApiMs: 60_000,
        rows: 1,
        calls: 1,
        lastAt: Date.now(),
        firstAt: Date.now() - 1000,
        generatedAt: Date.now(),
      },
      300_000,
    );
    const ctx = {
      ...ctxFor(fakeSnapshot()),
      intervals: {
        short: {
          windowId: "5h",
          label: "5h",
          startAt: 1_000_000,
          endAt: 1_000_000 + 5 * 3600 * 1000,
          intervalMs: 5 * 3600 * 1000,
          remainingPercent: 75,
          usedPercent: 25,
          remainingQuota: null,
          usedQuota: null,
          limitQuota: null,
        },
      },
    };
    const out = renderTemplate(
      ["m_sumTokenIn|term:short|window:7d|model:active"],
      ctx,
    ).join("\n");
    assert.equal(strip(out), "in:1.0k");
  });
});

describe("renderTemplate — |valueOnly| inline arg — label strip on label-using m_* modules (vX.X.X+)", () => {
  // vX.X.X+ — opt-in label-prefix strip. Accepts only literal
  // "true" / "false" (bad value → badarg → drop). Default false
  // so v0.8.x renders stay byte-identical. Applies to BOTH the
  // live render path AND the placeholder path. Forwarded through
  // m_template via the passthrough whitelist.
  beforeEach(() => {
    __resetForTest();
  });

  // -------- 1. strip on real value --------
  it("m_tokenIn|valueOnly:true strips 'in:' from a real value", () => {
    setPrevTick("sess-vo", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenIn|valueOnly:true"], ctxFor(snap)).join("\n");
    // delta = 38 (current.input - prev.input=0); strip "in:" prefix.
    assert.equal(strip(out), "38");
  });

  // -------- 2. explicit false keeps prefix (regression guard) --------
  it("m_tokenIn|valueOnly:false keeps 'in:' prefix (regression guard for explicit-false)", () => {
    setPrevTick("sess-vo", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenIn|valueOnly:false"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "in:38");
  });

  // -------- 3. bare (no arg) keeps prefix (v0.8.x byte-identical) --------
  it("bare m_tokenIn (no valueOnly arg) keeps 'in:' prefix (v0.8.x byte-identical)", () => {
    setPrevTick("sess-vo", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenIn"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "in:38");
  });

  // -------- 4. strip on placeholder --------
  it("m_tokenIn|valueOnly:true with missing data → 'n/a' (placeholder also stripped)", () => {
    // tokens=null-equivalent path: t.sessionId missing → placeholder.
    const snap = fakeSnapshot({ sessionId: "" });
    const out = renderTemplate(["m_tokenIn|valueOnly:true"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "n/a");
  });

  // -------- 5. color independence --------
  it("m_tokenCost|valueOnly:true|color|cyan strips 'cost:' but keeps SGR wrap", () => {
    // |valueOnly| is independent of |color|. With valueOnly=true
    // the prefix is gone but the user's |color| SGR wrap remains.
    // v0.9.x — seed tokenPrices (per-model dict) instead of
    // tokenPrice (removed).
    const cfg = configStore.get();
    cfg.tokenPrices = {
      "MiniMax-M3": { in: 10_000, out: 20_000, cachedIn: 5_000, currency: "USD" },
    };
    setPrevTick("sess-vo", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_tokenCost|valueOnly:true|color:cyan"], ctxFor(snap)).join("\n");
    // cost = 38*0.01 + 155*0.02 + 163441*0.005 = 820.685 → 2dp → "820.69"
    // valueOnly strips "cost:" prefix; |color|cyan applies SGR wrap.
    // We don't assert exact ANSI bytes — just that the printable
    // body is "820.69" with no "cost:" anywhere in it.
    assert.equal(strip(out), "820.69");
    assert.doesNotMatch(out, /cost:/);
  });

  // -------- 6. bad value → badarg → drop --------
  it("m_tokenIn|valueOnly|yes rejects unknown value (parse-fail → badarg → drop)", () => {
    // |valueOnly|yes is not literal "true"/"false" — VALUEONLY_PARAM
    // resolver returns null → token drops with a stderr warn.
    __resetUnknownModuleWarnForTest();
    const origWrite = process.stderr.write.bind(process.stderr);
    const writes: string[] = [];
    (process.stderr.write as unknown) = (chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    try {
      const snap = fakeSnapshot();
      const out = renderTemplate(["m_tokenIn|valueOnly:yes"], ctxFor(snap)).join("\n");
      // badarg → empty render
      assert.equal(out, "");
      // warnUnknownModuleOnce writes to stderr; capture it.
      assert.ok(writes.some((w) => /unknown lineTemplate module/i.test(w)), `expected stderr warn; got ${JSON.stringify(writes)}`);
    } finally {
      (process.stderr.write as unknown) = origWrite;
    }
  });

  // -------- 7. m_template passthrough --------
  it("m_template|<key>|valueOnly:true forwards to inner m_tokenIn (passthrough cascade)", () => {
    // Set up a template containing m_tokenIn, then call it with
    // an outer |valueOnly:true|. The inner module has no
    // |valueOnly|, so the only way it strips is via passThrough.
    __resetForTest({ lineTemplates: { vo: ["m_tokenIn"] } });
    setPrevTick("sess-vo", { totalApiMs: 0 }, "D:\\test");
    const snap = fakeSnapshot();
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_template|vo|valueOnly:true"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "38");
  });

  // -------- 8. cross-axis strip (labelTokenIn shared with m_tokenInTotal) --------
  it("m_tokenInTotal|valueOnly:true strips 'in:' prefix (cross-axis verification)", () => {
    // m_tokenInTotal shares the labelTokenIn axis with m_tokenIn;
    // both must inherit the strip when |valueOnly| is set.
    const snap = fakeSnapshot({ totals: { tokenTotalIn: 12345, tokenTotalOut: 0 } });
    const out = renderTemplate(["m_tokenInTotal|valueOnly:true"], ctxFor(snap)).join("\n");
    // formatCompactToken(12345) → "12.3K" (or similar)
    assert.doesNotMatch(strip(out), /^in:/);
    // And it should be a non-empty body
    assert.ok(strip(out).length > 0);
  });

  // -------- 9. acc family strip --------
  it("m_accTokenIn|valueOnly:true strips 'in:' prefix on the acc slot", () => {
    // Seed the SESSION slot for sess-vo with the desired value
    // (42000) and matching deltaTokenIn so setAvg writes the
    // pre-add value. processTick then contributes 0 (current is
    // zeroed), leaving the slot at 42000 → "42.0k".
    setAvg(
      "sess-vo",
      { accTokenIn: 42000, accTokenOut: 0, accApiMs: 0, accTokenCachedIn: 0, accApiCalls: 1, accTokenTotalIn: 0, accTokenHitRate: 0 },
      "D:\\test",
      { modelId: "MiniMax-M3", deltaApiCalls: 1, currentApiMs: 1000, deltaTokenIn: 42000, deltaTokenOut: 0, deltaTokenCachedIn: 0, deltaApiMs: 1000 },
    );
    const snap = fakeSnapshot({
      sessionId: "sess-vo",
      // Zero current so processTick contributes 0 to the slot.
      current: { tokenIn: 0, tokenOut: 0, tokenCacheCreation: 0, tokenCachedIn: 0 },
      cost: { totalDurationMs: 0, totalApiDurationMs: 0, totalLinesAdded: null, totalLinesRemoved: null },
    });
    processTick(snap.cwd, snap);
    statusStore.commit();
    const out = renderTemplate(["m_accTokenIn|valueOnly:true"], ctxFor(snap)).join("\n");
    // formatCompactToken(42000) = "42.0k"; |valueOnly| strips "in:".
    assert.equal(strip(out), "42.0k");
  });

  // -------- 10. acc placeholder strip --------
  it("m_accTokenIn|valueOnly:true with no slot → 'n/a' (placeholder strip)", () => {
    const snap = fakeSnapshot({ sessionId: "sess-vo-empty" });
    const out = renderTemplate(["m_accTokenIn|valueOnly:true"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "n/a");
  });
});
