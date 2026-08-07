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
} from "./config.ts";
import { DEFAULT_LINE_TEMPLATES } from "./config.template.ts";

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
    assert.ok(__testing.DEFAULT_CONFIG.lineTemplates.tokens_stat.length > 0);
  });
});

describe("statuslineTemplate — string-form preset lookup (vX.X.X+)", () => {
  // Each string-form statuslineTemplate in config.json is resolved
  // against DEFAULT_STATUSLINE_PRESETS at load time. The loader
  // clones the preset body so a later mutation doesn't leak back.
  it('"simple" resolves to the simple preset body', async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "simple" }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.statuslineTemplate[0], "m_pluginSource");
    assert.ok(cfg.statuslineTemplate.includes("m_template|quota|type:quota"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|balance|type:balance"));
  });

  it('"standard" resolves to the standard preset body', async () => {
    // v0.4.x: tail of standard no longer appends `m_age` + `m_version`
    // — the default `quota` template already owns the age slot via
    // `m_age`, and `m_version` was deemed redundant with the plugin
    // source glyph (`m_pluginSource`) for version visibility.
    // v0.9.7+: acc_eval and stat_eval are merged into combline1 /
    // combline2 (session acc + 5h-align stat share one line, project
    // acc + 7d-align stat share the other).
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "standard" }));
    const cfg = await loadConfig();
    assert.ok(cfg.statuslineTemplate[0].startsWith("m_template|information"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|tick_eval"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|combline1"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|combline2"));
    assert.ok(cfg.statuslineTemplate.includes("m_pluginSource"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|quota|type:quota"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|balance|type:balance"));
  });

  it('"abundant" resolves to the abundant preset body', async () => {
    // v0.9.8+: dropped the 2h-latest stat line and per-window
    // `m_statTtlStatus` (freshest-of-all) — replaced with per-filter
    // `m_sumTtlStatus` so the TTL gauge sits next to each window's
    // stat line it actually belongs to.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "abundant" }));
    const cfg = await loadConfig();
    assert.ok(cfg.statuslineTemplate[0].startsWith("m_template|information"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|tokens_stat|window:5h|align:true"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|tokens_stat|window:7d|align:true"));
    assert.ok(cfg.statuslineTemplate.includes("m_sumTtlStatus|window:5h|align:true"));
    assert.ok(cfg.statuslineTemplate.includes("m_sumTtlStatus|window:7d|align:true"));
    assert.ok(!cfg.statuslineTemplate.includes("m_template|tokens_stat|window:2h"));
    assert.ok(!cfg.statuslineTemplate.includes("m_statTtlStatus"));
    assert.ok(cfg.statuslineTemplate.includes("m_quota|term:long|display:remaining|nulldrop:true"));
  });

  it('"compact" resolves to the compact preset body', async () => {
    // Lock the current compact body shape: 6 lines — inline header
    // (provider/model + 📜 context + ▦ memory), tickline-slim (⚡),
    // session acc + ⏱️/🪙 (🗪), project acc + git_info (📦), quota/
    // balance dispatch (⚖️), quote (~). No information / tick_eval /
    // combline* / per-window stat fragments (those belong to `standard`
    // / `abundant`). If a future refactor re-points `compact` at a
    // different layout, this test breaks loudly so we don't silently
    // swap a 1-line `simple` body into a 6-line slot or vice-versa.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "compact" }));
    const cfg = await loadConfig();
    // Line 0 opens the inline header (provider/model bracket).
    assert.equal(cfg.statuslineTemplate[0], "[");
    assert.ok(cfg.statuslineTemplate.includes("m_provider"));
    assert.ok(cfg.statuslineTemplate.includes("m_model"));
    // L2 tick diagnostics via the slim fragment.
    assert.ok(cfg.statuslineTemplate.includes("m_template|tickline-slim"));
    // L3 session acc (scope:session) + api/cost tail.
    assert.ok(cfg.statuslineTemplate.includes("m_accTokenOutSpeed|scope:session"));
    assert.ok(cfg.statuslineTemplate.includes("m_accTokenTotalIn|scope:session"));
    assert.ok(cfg.statuslineTemplate.includes("m_accApiCalls|scope:session"));
    assert.ok(cfg.statuslineTemplate.includes("m_accApiMs|scope:session|valueOnly:true"));
    assert.ok(cfg.statuslineTemplate.includes("m_accTokenCost|scope:session|valueOnly:true"));
    // L4 project acc (scope:project) + git footer.
    assert.ok(cfg.statuslineTemplate.includes("m_accTokenOutSpeed|scope:project"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|git_info"));
    // L5 quota/balance dispatch — the quota half is the dedicated
    // `quota_all_compact` fragment (3 windows + bare countdowns,
    // self-contained, ignores the config's `quota_all` override).
    assert.ok(cfg.statuslineTemplate.includes("m_template|quota_all_compact|type:quota"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|balance|type:balance"));
    // L6 quote.
    assert.ok(cfg.statuslineTemplate.includes("m_template|quote"));
    // The quota_all_compact fragment itself is the 3-window line.
    const qac = DEFAULT_LINE_TEMPLATES.quota_all_compact;
    assert.ok(qac.includes("m_modeLabel|color:yellow"));
    assert.ok(qac.includes("m_windowQuota|term:short"));
    assert.ok(qac.includes("m_windowQuota|term:long"));
    assert.ok(qac.includes("m_countdown|term:mid|valueOnly:true"));
    assert.ok(!qac.includes("m_sumEstQuota"), "quota_all_compact has no est-quota extras");
    assert.ok(!qac.includes("m_age"), "quota_all_compact has no age tail");
    // 6 logical lines = 5 newlines in the array.
    const newlines = cfg.statuslineTemplate.filter((t) => t === "s_newline").length;
    assert.equal(newlines, 5, `expected 5 s_newline (6-line layout), got ${newlines}`);
    // No legacy eval-stack fragments (those belong to the pre-rebuild compact).
    assert.ok(!cfg.statuslineTemplate.some((t) => t.startsWith("m_template|tick_eval")));
    assert.ok(!cfg.statuslineTemplate.some((t) => t.startsWith("m_template|combline")));
    // No per-window stat / plugin-source fragments (those belong to `abundant` / `simple`).
    assert.ok(!cfg.statuslineTemplate.some((t) => t.startsWith("m_template|tokens_stat|")));
    assert.ok(!cfg.statuslineTemplate.some((t) => t.startsWith("m_pluginSource")));
  });

  it("unknown string falls back to DEFAULT_STATUSLINE_TEMPLATE with one warn", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "bogus" }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.statuslineTemplate, ["m_template|quota|type:quota", "m_template|balance|type:balance"]);
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
    // tokens_tick is in DEFAULT_LINE_TEMPLATES but NOT in
    // DEFAULT_STATUSLINE_PRESETS. Setting it as statuslineTemplate
    // must fall back with a warn, NOT silently resolve.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "tokens_tick" }));
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
