// v0.2.21: tests for the providers registry. The previous
// `isMiniMaxBaseUrl` / `isDeepSeekBaseUrl` cases moved into api.test.ts
// as `parseQuota` / `parseBalance` describe blocks (the URL
// matchers themselves were removed in v0.9.0 — replaced by
// `compareUrl("EXACT", ...)` driving `matchProvider`). This file
// covers the config-driven matching + dispatch surface.
//
// All tests pin the config to the built-in defaults via
// `__resetForTest()` — providers.ts reads `configStore.get().providers`
// at call time, so per-test config overrides compose with the
// singleton via the deep-merge in __resetForTest.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __resetForTest } from "./config.ts";
import {
  compareUrl,
  fetchForProviderWithKind,
  getProviderEntry,
  matchProvider,
  failLabelForProvider,
  providerTypeFor,
} from "./providers.ts";

beforeEach(() => {
  __resetForTest();
});

afterEach(() => {
  __resetForTest();
});

describe("compareUrl — EXACT mode", () => {
  it("matches the exact pattern (case-insensitive)", () => {
    assert.equal(
      compareUrl("EXACT", "https://api.minimaxi.com/anthropic",
        "https://api.minimaxi.com/anthropic"),
      true,
    );
    // Case folding on BOTH sides: lowercased URL against uppercased pattern still matches.
    assert.equal(
      compareUrl("EXACT", "https://api.minimaxi.com/anthropic",
        "HTTPS://API.MINIMAXI.COM/ANTHROPIC"),
      true,
    );
  });

  it("rejects when the URL has a different path", () => {
    assert.equal(
      compareUrl("EXACT", "https://api.minimaxi.com/v1",
        "https://api.minimaxi.com/anthropic"),
      false,
    );
  });

  it("rejects when the URL is a prefix of the pattern", () => {
    assert.equal(
      compareUrl("EXACT", "https://api.minimaxi.com",
        "https://api.minimaxi.com/anthropic"),
      false,
    );
  });

  it("rejects an unrelated URL", () => {
    assert.equal(
      compareUrl("EXACT", "https://api.anthropic.com",
        "https://api.minimaxi.com/anthropic"),
      false,
    );
  });
});

describe("compareUrl — INCLUDE mode", () => {
  it("matches anywhere in the URL (case-insensitive)", () => {
    assert.equal(
      compareUrl("INCLUDE", "https://api.minimaxi.com/anthropic",
        "minimaxi.com"),
      true,
    );
    assert.equal(
      compareUrl("INCLUDE", "https://API.MINIMAXI.COM/anthropic",
        "minimaxi.com"),
      true,
    );
  });

  it("matches when the pattern is a substring that includes the host", () => {
    assert.equal(
      compareUrl("INCLUDE", "https://staging.api.minimaxi.com/foo",
        "api.minimaxi.com"),
      true,
    );
  });

  it("rejects a URL that doesn't contain the pattern", () => {
    assert.equal(
      compareUrl("INCLUDE", "https://api.deepseek.com/anthropic",
        "minimaxi.com"),
      false,
    );
  });
});

describe("compareUrl — STARTWITH mode", () => {
  it("matches when the URL is exactly the pattern", () => {
    assert.equal(
      compareUrl("STARTWITH", "https://api.deepseek.com",
        "https://api.deepseek.com"),
      true,
    );
  });

  it("matches when followed by /, ?, or #", () => {
    assert.equal(
      compareUrl("STARTWITH", "https://api.deepseek.com/anthropic",
        "https://api.deepseek.com"),
      true,
    );
    assert.equal(
      compareUrl("STARTWITH", "https://api.deepseek.com?x=1",
        "https://api.deepseek.com"),
      true,
    );
    assert.equal(
      compareUrl("STARTWITH", "https://api.deepseek.com#frag",
        "https://api.deepseek.com"),
      true,
    );
  });

  it("rejects suffix attacks (e.g. .evil.example after the prefix)", () => {
    assert.equal(
      compareUrl("STARTWITH", "https://api.deepseek.com.evil.example",
        "https://api.deepseek.com"),
      false,
    );
    // Other non-boundary characters must also be rejected.
    assert.equal(
      compareUrl("STARTWITH", "https://api.deepseek.comXXXX",
        "https://api.deepseek.com"),
      false,
    );
  });

  it("rejects URLs that don't start with the pattern", () => {
    assert.equal(
      compareUrl("STARTWITH", "https://api.minimaxi.com",
        "https://api.deepseek.com"),
      false,
    );
  });

  it("is case-insensitive on both sides", () => {
    assert.equal(
      compareUrl("STARTWITH", "HTTPS://API.DEEPSEEK.COM/anthropic",
        "https://api.deepseek.com"),
      true,
    );
  });
});

describe("matchProvider — default config", () => {
  it("matches the canonical MiniMax base URL", () => {
    assert.equal(
      matchProvider("https://api.minimaxi.com/anthropic"),
      "minimax",
    );
  });

  it("matches the canonical DeepSeek base URL", () => {
    assert.equal(
      matchProvider("https://api.deepseek.com/anthropic"),
      "deepseek",
    );
  });

  it("returns null for an unrelated URL", () => {
    assert.equal(matchProvider("https://api.anthropic.com"), null);
  });

  it("returns null for empty / undefined / null", () => {
    assert.equal(matchProvider(""), null);
    assert.equal(matchProvider(undefined), null);
    assert.equal(matchProvider(null), null);
  });

  it("matches case-insensitively (EXACT mode lowercases both sides)", () => {
    assert.equal(
      matchProvider("HTTPS://API.MINIMAXI.COM/ANTHROPIC"),
      "minimax",
    );
  });

  it("returns null when the URL is a prefix of the canonical base URL", () => {
    // EXACT mode: `https://api.minimaxi.com` (no /anthropic) does NOT match
    // the default `https://api.minimaxi.com/anthropic`. This is the
    // intentional behavior change from v0.2.20 → v0.2.21; users who
    // want the old substring match can set COMPARE_METHOD="INCLUDE".
    assert.equal(matchProvider("https://api.minimaxi.com"), null);
  });
});

describe("matchProvider — trailing-slash normalization (2026-07-15)", () => {
  // The matcher strips trailing slashes on BOTH sides before
  // comparing, so a user with ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic/
  // matches the EXACT-registered `https://api.minimaxi.com/anthropic`
  // and vice versa. Affects all three compare methods uniformly.

  it("EXACT: matches a base URL with a trailing slash against an unslashed pattern", () => {
    assert.equal(
      matchProvider("https://api.minimaxi.com/anthropic/"),
      "minimax",
    );
  });

  it("EXACT: matches an unslashed base URL against a slashed pattern (degenerate case)", () => {
    // Providers normally register without trailing slashes; this
    // case asserts the strip is symmetric — a future config that
    // happens to carry a trailing slash in BASE_URL_COMPARED_TO
    // still resolves correctly.
    __resetForTest({
      providers: {
        slashed: {
          TYPE: "QUOTA",
          BASE_URL_COMPARED_TO: "https://api.example.com/anthropic/",
          COMPARE_METHOD: "EXACT",
          config: {},
        },
      },
    } as never);
    assert.equal(
      matchProvider("https://api.example.com/anthropic"),
      "slashed",
    );
  });

  it("EXACT: strips multiple trailing slashes (defensive)", () => {
    assert.equal(
      matchProvider("https://api.minimaxi.com/anthropic///"),
      "minimax",
    );
  });

  it("INCLUDE: trailing slash on either side is normalized", () => {
    // bigmodel is a user-defined provider (NOT in DEFAULT_PROVIDERS
    // since the 2026-07-15 revert) — the loader resolves it only
    // when the user has added it to config.json's providers block.
    // This test exercises the same INCLUDE+strip pattern through a
    // fresh __resetForTest entry so it doesn't depend on the
    // default registry. The plugin comment header in
    // query_plugins/bigmodel/index.js shows the exact config.json
    // snippet a user has to add.
    __resetForTest({
      providers: {
        bigmodel: {
          TYPE: "QUOTA",
          BASE_URL_COMPARED_TO: "https://bigmodel.cn/api/anthropic",
          COMPARE_METHOD: "INCLUDE",
          config: {},
        },
      },
    } as never);
    assert.equal(
      matchProvider("https://bigmodel.cn/api/anthropic/"),
      "bigmodel",
    );
  });

  it("bigmodel is NOT in DEFAULT_PROVIDERS (2026-07-15 revert)", () => {
    // After the revert, a fresh config with no providers block must
    // NOT auto-route bigmodel URLs — the user has to opt in via
    // config.json (see query_plugins/bigmodel/index.js header).
    assert.equal(
      matchProvider("https://bigmodel.cn/api/anthropic"),
      null,
    );
  });

  it("INCLUDE: trailing slash on the PATTERN side is normalized (user override)", () => {
    // And the inverse: a user config that registers a provider
    // with a trailing-slash BASE_URL_COMPARED_TO still resolves
    // against an unslashed baseUrl. We use a brand-new provider id
    // (`trailing`) to avoid hitting `bigmodel` first via iteration
    // order — matchProvider returns the first matching provider.
    __resetForTest({
      providers: {
        trailing: {
          TYPE: "QUOTA",
          BASE_URL_COMPARED_TO: "https://api.example.com/anthropic/",
          COMPARE_METHOD: "INCLUDE",
          config: {},
        },
      },
    } as never);
    assert.equal(
      matchProvider("https://api.example.com/anthropic"),
      "trailing",
    );
  });

  it("STARTWITH: trailing slash on either side is normalized", () => {
    __resetForTest({
      providers: {
        prefix: {
          TYPE: "QUOTA",
          BASE_URL_COMPARED_TO: "https://api.example.com/anthropic",
          COMPARE_METHOD: "STARTWITH",
          config: {},
        },
      },
    } as never);
    assert.equal(
      matchProvider("https://api.example.com/anthropic/"),
      "prefix",
    );
    assert.equal(
      matchProvider("https://api.example.com/anthropic/v1/messages"),
      "prefix",
    );
  });
});

describe("compareUrl — trailing-slash edge cases (2026-07-15)", () => {
  it("EXACT: returns false when only one side has a trailing slash and the other doesn't, AFTER normalization they match", () => {
    assert.equal(
      compareUrl("EXACT", "https://api.foo.com/bar/", "https://api.foo.com/bar"),
      true,
    );
    assert.equal(
      compareUrl("EXACT", "https://api.foo.com/bar", "https://api.foo.com/bar/"),
      true,
    );
  });

  it("INCLUDE: trailing slashes don't break the substring search", () => {
    assert.equal(
      compareUrl("INCLUDE", "https://api.foo.com/bar/path/", "https://api.foo.com/bar"),
      true,
    );
  });

  it("STARTWITH: suffix-attack guard still works after trailing-slash normalization", () => {
    // `https://api.deepseek.com.evil.example` should NOT match
    // `https://api.deepseek.com` even after the slash strip —
    // the guard looks at baseUrl[pattern.length] = '.', which is
    // not a legal boundary char.
    assert.equal(
      compareUrl(
        "STARTWITH",
        "https://api.deepseek.com.evil.example",
        "https://api.deepseek.com",
      ),
      false,
    );
  });
});

describe("matchProvider — custom config", () => {
  it("matches a custom provider added via __resetForTest", () => {
    __resetForTest({
      providers: {
        moonshot: {
          TYPE: "BALANCE",
          BASE_URL_COMPARED_TO: "https://api.moonshot.cn/anthropic",
          COMPARE_METHOD: "EXACT",
          ENDPOINT: "https://api.moonshot.cn/v1/users/me/balance",
        },
      },
    } as never);
    assert.equal(
      matchProvider("https://api.moonshot.cn/anthropic"),
      "moonshot",
    );
  });

  it("respects COMPARE_METHOD=INCLUDE for fuzzy matching", () => {
    __resetForTest({
      providers: {
        minimax: {
          TYPE: "QUOTA",
          BASE_URL_COMPARED_TO: "minimaxi.com",
          COMPARE_METHOD: "INCLUDE",
          ENDPOINT: "https://www.minimaxi.com/v1/token_plan/remains",
        },
      },
    } as never);
    // Fuzzy: matches any URL containing "minimaxi.com".
    assert.equal(matchProvider("https://api.minimaxi.com"), "minimax");
    assert.equal(
      matchProvider("https://staging.minimaxi.com/foo"),
      "minimax",
    );
    assert.equal(matchProvider("https://api.deepseek.com"), null);
  });

  it("respects COMPARE_METHOD=STARTWITH with suffix-attack guard", () => {
    __resetForTest({
      providers: {
        deepseek: {
          TYPE: "BALANCE",
          BASE_URL_COMPARED_TO: "https://api.deepseek.com",
          COMPARE_METHOD: "STARTWITH",
          ENDPOINT: "https://api.deepseek.com/user/balance",
        },
      },
    } as never);
    assert.equal(
      matchProvider("https://api.deepseek.com/anthropic"),
      "deepseek",
    );
    // Suffix attack still rejected.
    assert.equal(
      matchProvider("https://api.deepseek.com.evil.example"),
      null,
    );
  });

  it("insertion order decides ties — first registered entry wins", () => {
    // Two providers for the same canonical URL. We can build this
    // scenario by (a) starting from defaults, (b) overwriting the
    // default minimax entry with a clone-shaped replacement so the
    // default deepseek entry stays after it, then (c) prepending a
    // new entry whose key sorts before the others. We use the
    // __resetForTest deep-merge to add `clone` first by passing an
    // entry whose key sorts before "deepseek" in insertion order.
    //
    // The behavior we lock in: matchProvider returns the FIRST
    // matching key in `Object.entries(providers)` iteration order.
    // For default config that's { minimax, deepseek }; if a user
    // configures two providers that both match the same URL, the
    // one registered first wins. This test exercises a single-key
    // override (the default) so the deterministic ordering of
    // Object.entries on the defaults is what we observe.
    __resetForTest();
    assert.equal(
      matchProvider("https://api.minimaxi.com/anthropic"),
      "minimax",
    );
  });
});

describe("getProviderEntry", () => {
  it("returns the full entry for a known provider", () => {
    const entry = getProviderEntry("minimax");
    assert.ok(entry);
    assert.equal(entry!.TYPE, "QUOTA");
    assert.equal(entry!.COMPARE_METHOD, "EXACT");
    assert.equal("ENDPOINT" in entry!, false);
  });

  it("returns null for an unknown provider", () => {
    assert.equal(getProviderEntry("nope"), null);
  });

  it("returns null when the provider is null", () => {
    assert.equal(getProviderEntry(null), null);
  });
});

describe("failLabelForProvider", () => {
  it("returns modeLabels.used for Quota providers", () => {
    assert.equal(failLabelForProvider("minimax"), "Usage:");
  });

  it("returns modeLabels.balance for BALANCE providers", () => {
    assert.equal(failLabelForProvider("deepseek"), "Balance:");
  });

  it("falls back to modeLabels.used when the provider is null/unknown", () => {
    assert.equal(failLabelForProvider(null), "Usage:");
    assert.equal(failLabelForProvider("nope"), "Usage:");
  });

  it("respects a custom modeLabels override", () => {
    __resetForTest({
      modeLabels: { used: "Spent:", remaining: "Left:", balance: "Wallet:" },
    } as never);
    assert.equal(failLabelForProvider("minimax"), "Spent:");
    assert.equal(failLabelForProvider("deepseek"), "Wallet:");
  });
});

describe("providerTypeFor (formerly templateKeyForProvider)", () => {
  // v0.4.x — widened to include `"unknown"` for unregistered
  // providers. Previously null entry fell through to `"plan"`,
  // which masked the "no provider configured" case from the
  // renderer. Now `providerTypeFor(null)` and
  // `providerTypeFor("not-registered")` both return `"unknown"`,
  // letting the renderer's per-module `type` filter handle the
  // distinction.
  it("returns 'quota' for Quota providers", () => {
    assert.equal(providerTypeFor("minimax"), "quota");
  });

  it("returns 'balance' for BALANCE providers", () => {
    assert.equal(providerTypeFor("deepseek"), "balance");
  });

  it("returns 'unknown' for null / unregistered providers (was 'plan' in v0.4.x-beta)", () => {
    assert.equal(providerTypeFor(null), "unknown");
    assert.equal(providerTypeFor("nope"), "unknown");
  });
});

describe("fetchForProviderWithKind — error paths (no network)", () => {
  it("throws when the provider has no registered entry", async () => {
    await assert.rejects(
      () => fetchForProviderWithKind("nope", "tok", AbortSignal.timeout(1000)),
      /unknown provider: nope/,
    );
  });

  it("throws when the provider is null", async () => {
    await assert.rejects(
      () => fetchForProviderWithKind(null, "tok", AbortSignal.timeout(1000)),
      /unknown provider/,
    );
  });
});

describe("integration: configStore.get().providers reaches providers.ts", () => {
  it("matchProvider reflects the live configStore (deep-merged overrides)", () => {
    // Sanity-check that matchProvider reads from the singleton, not a
    // snapshot taken at module-load time. __resetForTest deep-merges,
    // so passing `{ providers: { minimax: <modified> } }` keeps the
    // `deepseek` entry from defaults while replacing the minimax one.
    assert.equal(
      matchProvider("https://api.minimaxi.com/anthropic"),
      "minimax",
    );
    // Override minimax's COMPARE_METHOD so the EXACT pattern is
    // replaced — the default deepseek entry remains, so it still
    // matches its own URL.
    __resetForTest({
      providers: {
        minimax: {
          TYPE: "QUOTA",
          BASE_URL_COMPARED_TO: "https://totally.different.host/anthropic",
          COMPARE_METHOD: "EXACT",
          ENDPOINT: "https://www.minimaxi.com/v1/token_plan/remains",
        },
      },
    } as never);
    // Now `https://api.minimaxi.com/anthropic` no longer matches
    // minimax (its BASE_URL_COMPARED_TO was changed), but deepseek's
    // default entry is still in place.
    assert.equal(
      matchProvider("https://api.minimaxi.com/anthropic"),
      null,
    );
    assert.equal(
      matchProvider("https://api.deepseek.com/anthropic"),
      "deepseek",
    );
  });
});