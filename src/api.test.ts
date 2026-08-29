import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureInterval,
  ensureQuota,
  fetchForProviderById,
  pluginTransport,
  resolvePluginOnDisk,
} from "./api.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(here, "__fixtures__", name), "utf8"));

let oldHome: string | undefined;
let oldUserProfile: string | undefined;
let tempHome: string;

beforeEach(() => {
  oldHome = process.env.HOME;
  oldUserProfile = process.env.USERPROFILE;
  tempHome = mkdtempSync(resolve(tmpdir(), "creditgauge-api-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldUserProfile;
  rmSync(tempHome, { recursive: true, force: true });
});

// v0.9.x — parseQuota/parseBalance REMOVED: plugins parse in their
// own fetchAccountCredit and ship canonical Quota/Balance; the
// ensure* validators below cover the shape contract.

describe("ensure quota", () => {
  it("fills a partial interval with canonical nullable fields and derives values", () => {
    const interval = ensureInterval({
      remainingPercent: 66,
      startAt: 1_000,
      endAt: 5_000,
    }, "short");
    assert.deepEqual(interval, {
      windowId: "5h",
      label: "5h",
      startAt: 1_000,
      endAt: 5_000,
      intervalMs: 4_000,
      remainingPercent: 66,
      usedPercent: 34,
      remainingQuota: null,
      usedQuota: null,
      limitQuota: null,
    });
  });

  it("normalizes all quota slots and preserves explicit zero", () => {
    assert.deepEqual(ensureQuota({
      short: { remainingPercent: 0 },
    }), {
      intervals: {
        short: {
          windowId: "5h",
          label: "5h",
          startAt: null,
          endAt: null,
          intervalMs: null,
          remainingPercent: 0,
          usedPercent: 100,
          remainingQuota: null,
          usedQuota: null,
          limitQuota: null,
        },
        mid: null,
        long: null,
      },
    });
    assert.equal(ensureQuota(null), null);
  });
});

// MiniMax bundled plugin — mocks fetch and asserts the canonical
// Quota flowing out of fetchForProviderById (the fill helper is
// inlined in the plugin since v0.8.47+).
describe("MiniMax bundled plugin (end-to-end)", () => {
  it("selects the general model regardless of array order", async () => {
    const raw = fixture("quota.real.minimax.json") as {
      model_remains: Array<Record<string, unknown>>;
    };
    const reordered = {
      ...raw,
      model_remains: [...raw.model_remains].reverse(),
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify(reordered), { status: 200 });
    try {
      const quota = await fetchForProviderById(
        "minimax",
        {
          TYPE: "QUOTA",
          BASE_URL_COMPARED_TO: "https://api.minimaxi.com/anthropic",
          COMPARE_METHOD: "EXACT",
        },
        "secret",
        undefined,
      ) as unknown as {
        intervals: {
          short: { remainingPercent: number; usedPercent: number; intervalMs: number };
          mid: { remainingPercent: number; usedPercent: number; intervalMs: number };
          long: unknown;
        };
      };
      assert.equal(quota.intervals.short.remainingPercent, 66);
      assert.equal(quota.intervals.short.usedPercent, 34);
      assert.equal(quota.intervals.mid.remainingPercent, 61);
      assert.equal(quota.intervals.mid.intervalMs, 604_800_000);
      assert.equal(quota.intervals.long, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns null when the general model is absent", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        model_remains: [{ model_name: "video" }],
        base_resp: { status_code: 0 },
      }), { status: 200 });
    try {
      const result = await fetchForProviderById(
        "minimax",
        {
          TYPE: "QUOTA",
          BASE_URL_COMPARED_TO: "https://api.minimaxi.com/anthropic",
          COMPARE_METHOD: "EXACT",
        },
        "secret",
        undefined,
      );
      assert.equal(result, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns null on base_resp.status_code != 0", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        model_remains: [{ model_name: "general" }],
        base_resp: { status_code: 401 },
      }), { status: 200 });
    try {
      const result = await fetchForProviderById(
        "minimax",
        {
          TYPE: "QUOTA",
          BASE_URL_COMPARED_TO: "https://api.minimaxi.com/anthropic",
          COMPARE_METHOD: "EXACT",
        },
        "secret",
        undefined,
      );
      assert.equal(result, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("completes missing MiniMax fields via the host's ensureQuota", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        model_remains: [{
          model_name: "general",
          current_interval_remaining_percent: 0,
        }],
        base_resp: { status_code: 0 },
      }), { status: 200 });
    try {
      const quota = await fetchForProviderById(
        "minimax",
        {
          TYPE: "QUOTA",
          BASE_URL_COMPARED_TO: "https://api.minimaxi.com/anthropic",
          COMPARE_METHOD: "EXACT",
        },
        "secret",
        undefined,
      ) as unknown as {
        intervals: {
          short: { remainingPercent: number; usedPercent: number; startAt: number | null };
          mid: { remainingPercent: number | null };
        };
      };
      assert.equal(quota.intervals.short.remainingPercent, 0);
      assert.equal(quota.intervals.short.usedPercent, 100);
      assert.equal(quota.intervals.short.startAt, null);
      assert.equal(quota.intervals.mid.remainingPercent, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("dynamic plugin loader", () => {
  it("loads the bundled MiniMax plugin dynamically", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer secret");
      return new Response(JSON.stringify(fixture("quota.real.minimax.json")), { status: 200 });
    };
    try {
      // v0.8.47+: plugins return a partial shape via `fill`; the host
      // runs `ensureQuota` to produce the canonical Quota. Going
      // through `fetchForProviderById` is the end-to-end path; bare
      // `pluginTransport` returns the plugin's partial output
      // without normalization.
      const quota = await fetchForProviderById(
        "minimax",
        {
          TYPE: "QUOTA",
          BASE_URL_COMPARED_TO: "https://api.minimaxi.com/anthropic",
          COMPARE_METHOD: "EXACT",
        },
        "secret",
        undefined,
      ) as unknown as {
        intervals: {
          short: { remainingPercent: number; usedPercent: number; intervalMs: number };
          mid: { remainingPercent: number; usedPercent: number; intervalMs: number };
        };
      };
      assert.equal(quota.intervals.short.remainingPercent, 66);
      assert.equal(quota.intervals.short.usedPercent, 34);
      assert.equal(quota.intervals.short.intervalMs, 14_400_000);
      assert.equal(quota.intervals.mid.remainingPercent, 61);
      assert.equal(quota.intervals.mid.usedPercent, 39);
      assert.equal(quota.intervals.mid.intervalMs, 604_800_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes AUTHENTICATION_KEY-selected values to user plugins", async () => {
    const pluginDir = resolve(tempHome, ".claude", "plugins", "creditgauge", "query_plugins", "custom");
    mkdirSync(pluginDir, { recursive: true });
    // v0.8.47+: plugin ABI is a single `fetchAccountCredit` method
    // returning whatever shape the plugin chose to project (the host
    // runs ensureQuota / ensureBalance on the result).
    writeFileSync(resolve(pluginDir, "index.mjs"), `export default {
      fetchAccountCredit(token) {
        return { short: { remainingPercent: 50, usedPercent: 50, windowId: token, label: token, startAt: null, endAt: null, intervalMs: null, remainingQuota: null, usedQuota: null, limitQuota: null } };
      }
    };`);
    const path = resolvePluginOnDisk("custom");
    assert.ok(path!.endsWith("index.mjs"));
    const quota = await fetchForProviderById(
      "custom",
      {
        TYPE: "QUOTA",
        BASE_URL_COMPARED_TO: "https://custom.example/anthropic",
        COMPARE_METHOD: "EXACT",
        AUTHENTICATION_KEY: "configured-key",
      },
      "environment-key",
      undefined,
    ) as unknown as { intervals: { short: { windowId: string } } };
    assert.equal(quota.intervals.short.windowId, "configured-key");
  });

  it("rejects plugins missing fetchAccountCredit", async () => {
    const pluginDir = resolve(tempHome, ".claude", "plugins", "creditgauge", "query_plugins", "old");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(resolve(pluginDir, "index.mjs"), "export default { fetch() { return {}; } };");
    await assert.rejects(() => pluginTransport("old", "token"), /default export must be \{ fetchAccountCredit\(authenticationKey, context\?\) \}/);
  });

  it("passes partial output through pluginTransport unchanged", async () => {
    // pluginTransport returns whatever the plugin's fetchAccountCredit
    // produced — no canonical shape enforcement at this layer. The
    // host's ensureQuota / ensureBalance is responsible for the final
    // shape (see `fetchForProviderById`). Plugins can return any
    // projection they want; each ensure function decides what it can
    // normalise (or returns null if the projection isn't recognisable).
    const pluginDir = resolve(tempHome, ".claude", "plugins", "creditgauge", "query_plugins", "bad");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(resolve(pluginDir, "index.mjs"), `export default {
      fetchAccountCredit() { return "bad"; },
    };`);
    const result = await pluginTransport("bad", "token");
    assert.equal(result, "bad");
  });
});

// v0.9.x+ — all plugins (bundled or user-written) live under the single
// query_plugins/ layout. Resolution is: user dir first, bundled copy
// second. Pins the path-resolution contract and the end-to-end
// pluginTransport loading path.
describe("resolvePluginOnDisk", () => {
  function userDir(id: string): string {
    return resolve(tempHome, ".claude", "plugins", "creditgauge", "query_plugins", id);
  }

  it("returns the user path when query_plugins/<id>/index.js exists", () => {
    mkdirSync(userDir("custom"), { recursive: true });
    writeFileSync(resolve(userDir("custom"), "index.js"), "export default {};");
    const p = resolvePluginOnDisk("custom");
    assert.ok(p!.endsWith("index.js"));
  });

  it("returns the user path when only .mjs exists", () => {
    mkdirSync(userDir("custom"), { recursive: true });
    writeFileSync(resolve(userDir("custom"), "index.mjs"), "export default {};");
    const p = resolvePluginOnDisk("custom");
    assert.ok(p!.endsWith("index.mjs"));
  });

  it("prefers .js over .mjs (deterministic tie-break for both present)", () => {
    mkdirSync(userDir("custom"), { recursive: true });
    writeFileSync(resolve(userDir("custom"), "index.js"),  "export default {};");
    writeFileSync(resolve(userDir("custom"), "index.mjs"), "export default {};");
    const p = resolvePluginOnDisk("custom");
    assert.ok(p!.endsWith("index.js"));
  });

  it("falls back to the bundled query_plugins/ copy for minimax when no user file exists", () => {
    // No query_plugins/minimax/ in tempHome; resolution falls through
    // to the bundled copy at <pkgRoot>/query_plugins/minimax/index.js.
    const p = resolvePluginOnDisk("minimax");
    assert.ok(/[\\/]query_plugins[\\/]minimax[\\/]index\.js$/.test(p!),
      `path should resolve into the bundled query_plugins tree, got: ${p}`);
  });

  it("falls back to the bundled copy for the canonical 2 plugins (minimax, deepseek)", () => {
    for (const id of ["minimax", "deepseek"]) {
      const p = resolvePluginOnDisk(id);
      assert.ok(p, `${id} should resolve to a plugin file`);
      // Cross-platform path match: posix uses '/' between segments,
      // windows uses '\\'. The segment before <id> is always
      // 'query_plugins', and the file is always <id>/index.js.
      const re = new RegExp(`[\\\\/]query_plugins[\\\\/]${id}[\\\\/]index\\.js$`);
      assert.ok(re.test(p!),
        `${id} should resolve to its bundled plugin file, got: ${p}`);
    }
  });

  it("returns the user-side path for a missing plugin (copilot when not installed)", () => {
    // copilot ships only as a user-installable plugin — with no user
    // file and no bundled copy, resolution returns the would-be user
    // path so the import-time 404 surfaces the right hint.
    const p = resolvePluginOnDisk("copilot");
    const re = /[\\/]query_plugins[\\/]copilot[\\/]index\.js$/;
    assert.ok(re.test(p!),
      `expected path under query_plugins/, got: ${p}`);
  });

  it("user file wins over the bundled copy for the same id (minimax override)", () => {
    // Place a user minimax plugin in query_plugins/. The bundled copy
    // still exists on disk (this checkout has query_plugins/minimax/),
    // but the user file MUST take precedence.
    mkdirSync(userDir("minimax"), { recursive: true });
    const userPath = resolve(userDir("minimax"), "index.js");
    writeFileSync(userPath, `export default {
      fetchAccountCredit() {
        return {
          short: { remainingPercent: 11, usedPercent: 89, windowId: "user", label: "5h", startAt: null, endAt: null, intervalMs: null, remainingQuota: null, usedQuota: null, limitQuota: null },
          mid:   { remainingPercent: 22, usedPercent: 78, windowId: "user", label: "7d", startAt: null, endAt: null, intervalMs: null, remainingQuota: null, usedQuota: null, limitQuota: null },
          long:  null,
        };
      },
    };`);
    const p = resolvePluginOnDisk("minimax");
    assert.equal(p, userPath);
  });

  it("returns the would-be user path for unknown ids (no user file, no bundled copy)", () => {
    const p = resolvePluginOnDisk("totally-unknown-provider");
    // Path still points at the would-be user location — the import-time
    // 404 will then surface the right hint ("check query_plugins/").
    const re = /[\\/]query_plugins[\\/]totally-unknown-provider[\\/]index\.js$/;
    assert.ok(re.test(p!),
      `expected path under query_plugins/, got: ${p}`);
  });

  it("rejects invalid ids before touching the filesystem", () => {
    assert.throws(() => resolvePluginOnDisk("../escape"), /invalid provider id/);
    assert.throws(() => resolvePluginOnDisk("with/slash"),     /invalid provider id/);
    assert.throws(() => resolvePluginOnDisk("with space"),     /invalid provider id/);
  });
});

// End-to-end: a user plugin at query_plugins/minimax/ runs in place of
// the bundled copy. Uses an .mjs plugin + a stub fetch to prove the
// user file was the one that ran.
describe("pluginTransport override end-to-end", () => {
  it("user plugin at query_plugins/minimax/index.mjs wins over the bundled copy", async () => {
    const userDirPath = resolve(tempHome, ".claude", "plugins", "creditgauge", "query_plugins", "minimax");
    mkdirSync(userDirPath, { recursive: true });
    writeFileSync(resolve(userDirPath, "index.mjs"), `export default {
      fetchAccountCredit(token, ctx) {
        return {
          short: { remainingPercent: 42, usedPercent: 58, windowId: "user", label: "5h", startAt: null, endAt: null, intervalMs: null, remainingQuota: null, usedQuota: null, limitQuota: null },
          mid:   null,
          long:  null,
        };
      },
    };`);
    // fetch must NOT be called — the user plugin returns synchronously
    // without hitting the network. The bundled minimax plugin DOES hit
    // fetch, so any call here would prove the override didn't take.
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("bundled plugin should be overridden — fetch must NOT run");
    };
    try {
      const partial = await pluginTransport("minimax", "ignored");
      assert.equal(fetchCalled, false, "globalThis.fetch must not be invoked by the user plugin");
      // partial is the RAW plugin return value (before ensureQuota).
      // The user plugin in this test returns the v0.9.5 open-ended dict
      // shape, so we read it directly.
      const shape = partial as { short: { remainingPercent: number; windowId: string } };
      assert.equal(shape.short.remainingPercent, 42);
      assert.equal(shape.short.windowId, "user");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("bundled copy loads normally when no user override exists", async () => {
    // No query_plugins/minimax in tempHome → falls through to the
    // bundled copy. Stub fetch so the real HTTP call doesn't escape
    // the test runner. The bundled minimax plugin looks up
    // `model_name === "general"` inside `model_remains[]`, so the
    // stub must include that entry.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        model_remains: [{
          model_name: "general",
          current_interval_remaining_percent: 50,
          current_weekly_remaining_percent: 50,
          start_time: 0, end_time: 0,
          weekly_start_time: 0, weekly_end_time: 0,
        }],
        base_resp: { status_code: 0 },
      }), { status: 200 });
    };
    try {
      const partial = await pluginTransport("minimax", "ignored");
      assert.ok(partial, "bundled copy should return a non-null partial");
      // partial is the RAW plugin return value (before ensureQuota).
      // The bundled minimax plugin returns the v0.9.5 open-ended dict
      // shape `{ short, mid, long }` directly — the host wraps it back
      // into the canonical Quota via ensureQuota.
      const shape = partial as { short: { remainingPercent: number } | null };
      assert.equal(shape.short?.remainingPercent, 50);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
