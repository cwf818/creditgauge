import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  __resetForTest,
  __testing,
  configStore,
  loadConfig,
  resolveTokenPrice,
} from "./config.ts";
import { DEFAULT_LINE_TEMPLATES, DEFAULT_STATUSLINE_PRESETS } from "./config.template.ts";

let dir: string;
let tpDir: string;
beforeEach(() => {
  __resetForTest();
  dir = mkdtempSync(join(tmpdir(), "creditgauge-config-"));
  tpDir = mkdtempSync(join(tmpdir(), "creditgauge-tp-"));
  __testing.setPathResolver(() => join(dir, "config.json"));
  __testing.setTokenPricesPathResolver(() => join(tpDir, "config.tokenPrices.json"));
});
afterEach(() => {
  __testing.resetPathResolver();
  __testing.resetTokenPricesPathResolver();
  __resetForTest();
  rmSync(dir, { recursive: true, force: true });
  rmSync(tpDir, { recursive: true, force: true });
});

describe("provider defaults", () => {
  it("registers MiniMax as Quota and DeepSeek as BALANCE", () => {
    const providers = configStore.get().providers;
    assert.equal(providers.minimax.TYPE, "QUOTA");
    assert.equal(providers.deepseek.TYPE, "BALANCE");
    assert.equal("ENDPOINT" in providers.minimax, false);
  });

  it("uses AUTHENTICATION_KEY as the provider credential field", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      providers: {
        custom: {
          TYPE: "BALANCE",
          BASE_URL_COMPARED_TO: "https://custom.example/anthropic",
          COMPARE_METHOD: "EXACT",
          AUTHENTICATION_KEY: "configured",
        },
      },
    }));
    await loadConfig();
    assert.equal(configStore.get().providers.custom.AUTHENTICATION_KEY, "configured");
    assert.equal("BEARER_KEY" in (configStore.get().providers.custom as object), false);
  });
});

describe("config facade", () => {
  it("loads rendering overrides without replacing provider defaults", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      display: "remaining",
      modeLabels: { remaining: "Left:" },
    }));
    await loadConfig();
    assert.equal(configStore.get().display, "remaining");
    assert.equal(configStore.get().modeLabels.remaining, "Left:");
    assert.equal(configStore.get().providers.minimax.TYPE, "QUOTA");
  });

  it("exposes the split template constants through config.ts", () => {
    assert.ok(__testing.DEFAULT_CONFIG.statuslineTemplate.length > 0);
    assert.ok(__testing.DEFAULT_CONFIG.lineTemplates.model_info.length > 0);
  });
});

describe("statuslineTemplate — string-form preset lookup (vX.X.X+)", () => {
  // Each string-form statuslineTemplate in config.json is resolved
  // against DEFAULT_STATUSLINE_PRESETS at load time. The loader
  // clones the preset body so a later mutation doesn't leak back.
  it('"simple" resolves to the simple preset body', async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "simple" }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.statuslineTemplate[0], "m_template|quota|type:quota");
    assert.ok(cfg.statuslineTemplate.includes("m_template|quota|type:quota"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|balance|type:balance"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|plugin_info|type:unknown"));
  });

  it('"standard" resolves to the standard preset body', async () => {
    // The `standard` preset composes the fragment library: git_info +
    // context_info + mem_info + version on line 1, model_info + tickline
    // (+ per-session api/cost) on line 2, the session/project scopelines
    // paired with per-window periodlines (5h / 7d) on lines 3-4, then
    // the quota/balance dispatch, and quote + version on the last
    // line.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "standard" }));
    const cfg = await loadConfig();
    assert.ok(cfg.statuslineTemplate[0].startsWith("m_template|git_info"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|tickline"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|scopeline|scope:session"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|periodline|window:5h"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|periodline|window:7d"));
    assert.ok(!cfg.statuslineTemplate.includes("m_pluginSource"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|quota|type:quota"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|balance|type:balance"));
  });

  it('"compact" resolves to the compact preset body', async () => {
    // Lock the current compact body shape: 6 lines — git_info fragment
    // (⎇) + context bar + ▦ memory, model_info (provider/model) + ⚡
    // tickline fragment, session scopeline + ⏱️/🪙, project scopeline +
    // ⌛5h/⌛7d window rows, quota/balance dispatch (⚖️), quote (~). No
    // information / tick_eval / combline* / per-window stat fragments
    // (those belong to `standard`). If a future refactor re-points
    // `compact` at a different layout, this test breaks loudly so we
    // don't silently swap a 1-line `simple` body into a 6-line slot or
    // vice-versa.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "compact" }));
    const cfg = await loadConfig();
    // L1 opens with the git_info fragment (branch + status).
    assert.equal(cfg.statuslineTemplate[0], "m_template|git_info");
    assert.ok(cfg.statuslineTemplate.includes("m_memUsage|valueOnly:true"));
    // L2 provider/model + tick diagnostics via the model_info + tickline
    // fragments.
    assert.ok(cfg.statuslineTemplate.includes("m_template|model_info"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|tickline"));
    // The tickline fragment itself carries the per-turn token family.
    const tickline = DEFAULT_LINE_TEMPLATES["tickline"];
    assert.ok(tickline.includes("m_tokenTotalIn"));
    assert.ok(tickline.includes("m_apiMs"));
    assert.ok(!cfg.statuslineTemplate.includes("m_version"), "compact no longer shows m_version");
    // L3 session acc via the scopeline fragment (scope passed through m_template).
    assert.ok(cfg.statuslineTemplate.includes("m_template|scopeline|scope:session"));
    assert.ok(cfg.statuslineTemplate.includes("m_accApiMs|scope:session|valueOnly:true"));
    assert.ok(cfg.statuslineTemplate.includes("m_accTokenCost|scope:session|valueOnly:true"));
    // L4 project acc + ⌛5h/⌛7d aligned window rows.
    assert.ok(cfg.statuslineTemplate.includes("m_template|scopeline|scope:project"));
    assert.ok(cfg.statuslineTemplate.includes("m_sumTokenTotalIn|align:true|window:5h"));
    assert.ok(cfg.statuslineTemplate.includes("m_sumApiCalls|align:true|window:5h"));
    assert.ok(cfg.statuslineTemplate.includes("m_sumTokenTotalIn|align:true|window:7d"));
    assert.ok(cfg.statuslineTemplate.includes("m_sumApiCalls|align:true|window:7d"));
    // L5 quota/balance dispatch — the quota half is the shared `quota`
    // fragment (3 windows + countdowns + remaining tail).
    assert.ok(cfg.statuslineTemplate.includes("m_template|quota|type:quota"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|balance|type:balance"));
    // L6 quote.
    assert.ok(cfg.statuslineTemplate.includes("m_template|quote"));
    // The scopeline fragment itself is the session/project acc line.
    // vX.X.X+ — the 🗪 / 📦 per-scope labels moved OUT of the shared
    // fragment into the `standard` preset, so the fragment is label-
    // free and reusable at any scope. The compact preset leaves its
    // scopelines unlabeled; only the ⚡ tickline prefix is added here.
    const scopeline = DEFAULT_LINE_TEMPLATES.scopeline;
    assert.ok(!scopeline.includes("m_label"), "scopeline fragment is label-free");
    assert.ok(scopeline.includes("m_accTokenOutSpeed"));
    assert.ok(scopeline.includes("m_accTokenOut"));
    assert.ok(scopeline.includes("m_accTokenTotalIn"));
    assert.ok(scopeline.includes("m_accTokenHitRate"));
    assert.ok(scopeline.includes("m_accApiCalls"));
    // The ⚡ tickline prefix now lives at the preset level (it used to
    // be hardcoded inside the tickline fragment).
    assert.ok(cfg.statuslineTemplate.includes("m_label|⚡: |color:orange"));
    // The standard preset supplies the per-scope labels for its own
    // scopeline usages (compact intentionally renders them bare).
    const standard = DEFAULT_STATUSLINE_PRESETS.standard;
    assert.ok(standard.includes("m_label|🗪 : |color:orange"));
    assert.ok(standard.includes("m_label|📦: |color:orange"));
    // 6 logical lines = 5 newlines in the array.
    const newlines = cfg.statuslineTemplate.filter((t) => t === "s_newline").length;
    assert.equal(newlines, 5, `expected 5 s_newline (6-line layout), got ${newlines}`);
    // No legacy eval-stack fragments (those belong to the pre-rebuild compact).
    assert.ok(!cfg.statuslineTemplate.some((t) => t.startsWith("m_template|tick_eval")));
    assert.ok(!cfg.statuslineTemplate.some((t) => t.startsWith("m_template|combline")));
    // No per-window stat / plugin-source fragments (those belong to `standard` / `simple`).
    assert.ok(!cfg.statuslineTemplate.some((t) => t.startsWith("m_template|tokens_stat|")));
    assert.ok(!cfg.statuslineTemplate.some((t) => t.startsWith("m_pluginSource")));
  });

  it('"solo" resolves to the solo preset body (self-contained three-line layout)', async () => {
    // Standalone three-line preset: line 1 composes the git, context, and
    // memory fragments; line 2 composes model information and session
    // metrics; line 3 dispatches quota/balance by provider type.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "solo" }));
    const cfg = await loadConfig();
    // L1 references the compact git/context/memory fragments.
    assert.equal(cfg.statuslineTemplate[0], "m_template|git_info");
    assert.ok(cfg.statuslineTemplate.includes("m_template|context_info"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|mem_info"));
    const gitInfo = DEFAULT_LINE_TEMPLATES.git_info;
    assert.ok(gitInfo.includes("m_branch|withStatus:true|width:25"));
    assert.ok(gitInfo.includes("m_linesAdded"));
    assert.ok(gitInfo.includes("m_linesRemoved"));
    // L2 is model information plus session-scoped metrics.
    assert.ok(cfg.statuslineTemplate.includes("m_template|model_info"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|scopeline|scope:session"));
    assert.ok(cfg.statuslineTemplate.includes("m_accApiMs|scope:session|valueOnly:true"));
    assert.ok(cfg.statuslineTemplate.includes("m_accTokenCost|scope:session|valueOnly:true"));
    // L3 dispatches quota/balance by provider type.
    assert.ok(cfg.statuslineTemplate.includes("m_template|quota|type:quota"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|balance|type:balance"));
    assert.ok(!cfg.statuslineTemplate.includes("m_template|plugin_info|type:unknown"));
    // 3 logical lines = 2 newlines in the array.
    const newlines = cfg.statuslineTemplate.filter((t) => t === "s_newline").length;
    assert.equal(newlines, 2, `expected 2 s_newline (3-line layout), got ${newlines}`);
  });

  it("unknown string falls back to DEFAULT_STATUSLINE_TEMPLATE with one warn", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "bogus" }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.statuslineTemplate, ["m_template|quota|type:quota", "m_template|balance|type:balance"]);
  });

  it("labels default includes labelContextUsage: 'ctx:'", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({}));
    const cfg = await loadConfig();
    assert.equal(cfg.labels.labelContextUsage, "ctx:");
  });

  it("array-form statuslineTemplate still works (no preset lookup)", async () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ statuslineTemplate: ["m_modeLabel", "s_space", "m_balance"] }),
    );
    const cfg = await loadConfig();
    assert.deepEqual(cfg.statuslineTemplate, ["m_modeLabel", "s_space", "m_balance"]);
  });

  it("fragment key (DEFAULT_LINE_TEMPLATES-only) is NOT a valid preset name", async () => {
    // model_info is in DEFAULT_LINE_TEMPLATES but NOT in
    // DEFAULT_STATUSLINE_PRESETS. Setting it as statuslineTemplate
    // must fall back with a warn, NOT silently resolve.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "model_info" }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.statuslineTemplate, ["m_template|quota|type:quota", "m_template|balance|type:balance"]);
  });
});

describe("Config.debug parser", () => {
  let prevEnable: string | undefined;

  beforeEach(() => {
    prevEnable = process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
  });

  afterEach(() => {
    if (prevEnable === undefined) delete process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE;
    else process.env.CREDITGAUGE_DIAGNOSTICS_ENABLE = prevEnable;
  });

  it("missing debug → {}", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ display: "used" }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.debug, {});
  });

  it("accepts 1 / true / yes for known subkeys", async () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        debug: { stdin: "1", cache: "true", statusStore: "yes", parse: true },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.debug.stdin, true);
    assert.equal(cfg.debug.cache, true);
    assert.equal(cfg.debug.statusStore, true);
    assert.equal(cfg.debug.parse, true);
  });

  it("unknown subkeys silently ignored", async () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ debug: { stdin: true, typo: true } }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.debug.stdin, true);
    assert.equal((cfg.debug as Record<string, unknown>).typo, undefined);
  });

  it("non-object debug falls back to {}", async () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ debug: "not an object" }),
    );
    const cfg = await loadConfig();
    assert.deepEqual(cfg.debug, {});
  });
});

// vX.X.X+ — config.json is optional; tokenPrices.json resolves
// independently so cost modules work without config.json.
describe("no config.json", () => {
  it("returns DEFAULT_CONFIG when config.json is missing", async () => {
    // dir has no config.json — path resolver points at a non-existent file.
    const cfg = await loadConfig();
    // DEFAULT_CONFIG has "remaining" display mode on default.
    assert.equal(cfg.cacheTtlMs, 60_000);
    assert.equal(cfg.fetchTimeoutMs, 5_000);
    assert.equal(cfg.display, "remaining");
  });

  it("loads tokenPrices.json even when config.json is missing", async () => {
    writeFileSync(
      join(tpDir, "config.tokenPrices.json"),
      JSON.stringify({ default: { currency: "CNY", in: 1.5, out: 3.0, cachedIn: 0.3 } }),
    );
    const cfg = await loadConfig();
    assert.ok(cfg.tokenPrices.default !== undefined);
    assert.equal(cfg.tokenPrices.default!.currency, "CNY");
    assert.equal(cfg.tokenPrices.default!.in, 1.5);
    assert.equal(cfg.tokenPrices.default!.out, 3.0);
  });

  it("returns empty tokenPrices when both config.json and tokenPrices.json are missing", async () => {
    // Neither dir nor tpDir has any file.
    const cfg = await loadConfig();
    assert.deepEqual(cfg.tokenPrices, {});
  });

  it("still loads tokenPrices from independent path when config.json exists but tokenPrices.json is in a different dir", async () => {
    // Write config.json in dir, tokenPrices.json in tpDir (different paths).
    writeFileSync(join(dir, "config.json"), JSON.stringify({ display: "used" }));
    writeFileSync(
      join(tpDir, "config.tokenPrices.json"),
      JSON.stringify({ default: { currency: "USD", in: 2.0, out: 8.0, cachedIn: 0.5 } }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.display, "used");
    assert.equal(cfg.tokenPrices.default!.currency, "USD");
    assert.equal(cfg.tokenPrices.default!.in, 2.0);
  });

  it("falls back to empty tokenPrices on malformed tokenPrices.json", async () => {
    writeFileSync(join(tpDir, "config.tokenPrices.json"), "not json");
    const cfg = await loadConfig();
    assert.deepEqual(cfg.tokenPrices, {});
  });
});

describe("m_* auto-space affix toggles (vX.X.X+)", () => {
  it("defaults: prefixSpace=true, suffixSpace=false", async () => {
    const cfg = await loadConfig();
    assert.equal(cfg.prefixSpace, true);
    assert.equal(cfg.suffixSpace, false);
  });

  it("config.json overrides are applied", async () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ prefixSpace: false, suffixSpace: true }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.prefixSpace, false);
    assert.equal(cfg.suffixSpace, true);
  });

  it("non-boolean prefixSpace warns and falls back to default", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ prefixSpace: "yes" }));
    const cfg = await loadConfig();
    assert.equal(cfg.prefixSpace, true);
  });

  it("non-boolean suffixSpace warns and falls back to default", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ suffixSpace: "yes" }));
    // Capture stderr — the loader warns, then falls back to the default.
    const origWrite = process.stderr.write.bind(process.stderr);
    const writes: string[] = [];
    (process.stderr.write as unknown) = (chunk: string | Uint8Array): boolean => {
      writes.push(String(chunk));
      return true;
    };
    try {
      const cfg = await loadConfig();
      assert.equal(cfg.suffixSpace, false);
      assert.ok(
        writes.some((w) => /suffixSpace must be a boolean/.test(w)),
        `expected stderr warn; got ${JSON.stringify(writes)}`,
      );
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

// vX.X.X+ — resolveTokenPrice: a price entry whose currency is outside
// the provider's CURRENCY filter may be converted to CURRENCY[0] via the
// exchange-rate table (global default fallback). No safe conversion path
// → the entry stays rejected (cost:n/a).
describe("resolveTokenPrice — CURRENCY-filter conversion fallback (vX.X.X+)", () => {
  const base = () => ({
    tokenPrices: {
      default: { currency: "CNY", in: 3, out: 9, cachedIn: 0.1 },
    },
    exchangeRates: { USD: 0.15 },
    providers: {
      commandcode: {
        TYPE: "QUOTA",
        BASE_URL_COMPARED_TO: "http://127.0.0.1:5411",
        COMPARE_METHOD: "STARTWITH",
        CURRENCY: ["USD"],
      },
    },
  });

  it("entry outside the filter converts to CURRENCY[0] when rates exist", () => {
    __resetForTest(base() as never);
    const r = resolveTokenPrice(configStore.get(), "commandcode", "deepseek-v4-flash");
    assert.ok(r !== null);
    assert.equal(r!.currency, "USD");
    assert.equal(r!.in, 3 * 0.15);
    assert.equal(r!.out, 9 * 0.15);
    assert.equal(r!.cachedIn, 0.1 * 0.15);
  });

  it("bracket-suffixed model id converts via the stripped retry", () => {
    __resetForTest(base() as never);
    const r = resolveTokenPrice(configStore.get(), "commandcode", "deepseek-v4-flash[1m]");
    assert.ok(r !== null);
    assert.equal(r!.currency, "USD");
    assert.equal(r!.in, 3 * 0.15);
  });

  it("entry outside the filter stays rejected when rates are empty", () => {
    __resetForTest({ ...base(), exchangeRates: {} } as never);
    const r = resolveTokenPrice(configStore.get(), "commandcode", "deepseek-v4-flash");
    assert.equal(r, null);
  });

  it("entry whose currency already matches the filter is accepted unchanged", () => {
    __resetForTest({
      ...base(),
      tokenPrices: {
        default: { currency: "USD", in: 0.14, out: 0.28, cachedIn: 0.0028 },
      },
    } as never);
    const r = resolveTokenPrice(configStore.get(), "commandcode", "deepseek-v4-flash");
    assert.ok(r !== null);
    assert.equal(r!.currency, "USD");
    assert.equal(r!.in, 0.14);
  });

  it("no CURRENCY filter → entry accepted as-is regardless of currency", () => {
    // minimax has no CURRENCY in DEFAULT_PROVIDERS → no filter.
    __resetForTest({ ...base(), providers: {} } as never);
    const r = resolveTokenPrice(configStore.get(), "minimax", "MiniMax-M3");
    assert.ok(r !== null);
    assert.equal(r!.currency, "CNY");
    assert.equal(r!.in, 3);
  });

  it("empty CURRENCY array keeps rejecting every entry", () => {
    __resetForTest({
      ...base(),
      providers: {
        commandcode: {
          TYPE: "QUOTA",
          BASE_URL_COMPARED_TO: "http://127.0.0.1:5411",
          COMPARE_METHOD: "STARTWITH",
          CURRENCY: [],
        },
      },
    } as never);
    const r = resolveTokenPrice(configStore.get(), "commandcode", "deepseek-v4-flash");
    assert.equal(r, null);
  });
});
