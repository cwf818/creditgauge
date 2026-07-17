import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cache from "./cache.ts";
const {
  clear,
  get,
  getWithAge,
  peek,
  peekWithAge,
  set,
  resetCachePathResolver,
  setCachePathResolver,
  __resetForTest: resetForTest,
} = cache;

// v0.8.21+ — FILE-SCOPE path resolver. Without this, the cache
// module's `flushToDisk()` writes to the user's live
// `~/.claude/plugins/creditgauge/state/cache.json` — which is
// shared with the running plugin and your interactive shell
// sessions. Tests fixture values (k1/k2/d--workspace-X/tickSpeed:…)
// would clobber real cache rows. We point the resolver at an
// ephemeral mkdtempSync dir ONCE at file load, and override it
// only inside `describe("cache disk persistence")` and
// `describe("cache — v0.8.x TTL flush + legacy key cleanup")`.
// afterEach below restores the file-scope default so inner
// describes don't leak their tmp dir choice to siblings.
let _ephemeralDir: string;
_ephemeralDir = mkdtempSync(join(tmpdir(), "creditgauge-cache-test-"));
setCachePathResolver(() => join(_ephemeralDir, "cache.json"));

describe("cache", () => {
  it("returns null on miss", () => {
    clear("k1");
    assert.equal(get("k1", 60_000), null);
  });

  it("returns the value within TTL", () => {
    clear("k2");
    set("k2", { foo: 1 });
    assert.deepEqual(get("k2", 60_000), { foo: 1 });
  });

  it("returns null after TTL expires", async () => {
    clear("k3");
    set("k3", "v");
    // Past dates always have strictly-greater diff than any positive ttl.
    const past = Date.now() - 10_000;
    (cache as any).store.set("k3", { at: past, value: "v" });
    assert.equal(get("k3", 1000), null);
  });

  it("peek returns the last value regardless of TTL (stale-on-error)", () => {
    clear("k4");
    set("k4", "still-here");
    // Backdate so any positive ttl is exceeded.
    (cache as any).store.set("k4", { at: Date.now() - 10_000, value: "still-here" });
    assert.equal(peek("k4"), "still-here");
    assert.equal(get("k4", 1000), null); // expired for get
    assert.equal(peek("k4"), "still-here"); // still available for peek
  });

  it("clear removes a key", () => {
    set("k5", "x");
    clear("k5");
    assert.equal(get("k5", 60_000), null);
    assert.equal(peek("k5"), null);
  });
});

describe("peekWithAge", () => {
  it("returns null on miss", () => {
    clear("k6");
    assert.equal(peekWithAge("k6"), null);
  });

  it("returns { value, ageMs } on hit with ageMs >= 0", async () => {
    clear("k7");
    set("k7", { foo: 1 });
    // Backdate to give the entry a known age.
    const past = Date.now() - 5_000;
    (cache as any).store.set("k7", { at: past, value: { foo: 1 } });
    const r = peekWithAge<{ foo: number }>("k7");
    assert.ok(r);
    assert.deepEqual(r!.value, { foo: 1 });
    // ageMs is computed at peek time; allow a tiny tolerance for wall-clock
    // drift between the backdate and the assertion.
    assert.ok(r!.ageMs >= 5_000, `expected ageMs >= 5000, got ${r!.ageMs}`);
    assert.ok(r!.ageMs < 6_000, `expected ageMs < 6000, got ${r!.ageMs}`);
  });

  it("ignores TTL — peekWithAge returns data even when get() would expire", () => {
    clear("k8");
    set("k8", "stale");
    (cache as any).store.set("k8", { at: Date.now() - 10 * 60_000, value: "stale" });
    assert.equal(get("k8", 1_000), null); // expired for get
    const r = peekWithAge<string>("k8");
    assert.ok(r);
    assert.equal(r!.value, "stale");
    assert.ok(r!.ageMs >= 10 * 60_000);
  });
});

// ----- v0.8.16 — TTL-aware peek for m_cacheTtlStatus -----
//
// peekWithTtl returns {ageMs, ttlMs} keyed on the caller's key.
// TTL-IGNORING (the renderer needs to render the gauge even when
// the entry is past TTL — that's the "will refresh next tick" case).
// It exposes the entry's stored ttlMs so the renderer can compute
// remainingFraction = (ttlMs - ageMs) / ttlMs.
//
// v0.9.x — keyed against the active provider's cache row (NOT the
// cross-provider freshest — that leaked one provider's freshness
// into another's display). The per-provider key is what callers
// pass in.

describe("peekWithTtl", () => {
  it("returns null on miss", () => {
    clear("ttl-miss");
    assert.equal((cache as any).peekWithTtl("ttl-miss"), null);
  });

  it("returns { ageMs, ttlMs } on hit, ttlMs reflects the value passed to set()", () => {
    clear("ttl-set");
    set("ttl-set", { x: 1 }, 60_000);
    const r = (cache as any).peekWithTtl("ttl-set");
    assert.ok(r);
    assert.equal(r!.ttlMs, 60_000);
    assert.ok(r!.ageMs >= 0);
    assert.ok(r!.ageMs < 1_000);
  });

  it("returns ttlMs=0 for entries written without a ttlMs argument", () => {
    // Legacy callers (cache.set(key, value) without ttlMs) produce
    // entries with no recorded ttl. peekWithTtl surfaces ttlMs=0 so
    // the renderer can detect "no TTL configured" and drop / placehold.
    clear("ttl-legacy");
    set("ttl-legacy", "legacy");
    const r = (cache as any).peekWithTtl("ttl-legacy");
    assert.ok(r);
    assert.equal(r!.ttlMs, 0);
  });

  it("ignores TTL — returns the entry even when past ttlMs", () => {
    clear("ttl-stale");
    set("ttl-stale", "still-here", 1_000);
    (cache as any).store.set("ttl-stale", {
      at: Date.now() - 10_000,
      value: "still-here",
      ttlMs: 1_000,
    });
    assert.equal(get("ttl-stale", 1_000), null); // expired for get
    const r = (cache as any).peekWithTtl("ttl-stale");
    assert.ok(r);
    assert.equal(r!.ttlMs, 1_000);
    assert.ok(r!.ageMs >= 10_000);
  });
});

describe("peekWithTtl — active-provider scoping (v0.9.x)", () => {
  it("returns null when the active-provider key has no entry, even if other keys exist", () => {
    // The "no provider matched" / "freshly-installed user plugin" case:
    // only DeepSeek has a cache row; the active provider (MiniMax)
    // has no row yet. peekWithTtl must not fall through to any other
    // row — the renderer would then show DeepSeek's freshness
    // while reporting MiniMax's quota on the line above.
    clear("deepseek");
    clear("minimax");
    set("deepseek", { x: 1 }, 60_000);
    (cache as any).store.set("deepseek", {
      at: Date.now() - 1_000, // very fresh
      value: { x: 1 },
      ttlMs: 60_000,
    });
    assert.equal((cache as any).peekWithTtl("minimax"), null);
  });

  it("returns the active-provider row's { ageMs, ttlMs } independent of other rows", () => {
    // Two providers, MiniMax is much older than DeepSeek. The MiniMax
    // key should report its own age (~45s), NOT DeepSeek's (~5s).
    clear("deepseek");
    clear("minimax");
    (cache as any).store.set("deepseek", {
      at: Date.now() - 5_000,
      value: { x: 1 },
      ttlMs: 60_000,
    });
    (cache as any).store.set("minimax", {
      at: Date.now() - 45_000,
      value: { x: 2 },
      ttlMs: 60_000,
    });
    const r = (cache as any).peekWithTtl("minimax");
    assert.ok(r);
    assert.equal(r!.ttlMs, 60_000);
    assert.ok(
      r!.ageMs >= 44_000 && r!.ageMs < 47_000,
      `expected MiniMax ageMs≈45000, got ${r!.ageMs}`,
    );
  });
});

describe("getWithAge", () => {
  it("returns null on miss", () => {
    clear("g1");
    assert.equal(getWithAge("g1", 60_000), null);
  });

  it("returns { value, ageMs } on within-TTL hit", () => {
    clear("g2");
    set("g2", { foo: 1 });
    const r = getWithAge<{ foo: number }>("g2", 60_000);
    assert.ok(r);
    assert.deepEqual(r!.value, { foo: 1 });
    // Just-set entry: ageMs is tiny (sub-second on a fast machine).
    assert.ok(r!.ageMs >= 0, `expected ageMs >= 0, got ${r!.ageMs}`);
    assert.ok(r!.ageMs < 1_000, `expected ageMs < 1000, got ${r!.ageMs}`);
  });

  it("returns { value, ageMs } reflecting actual cache age (not 0)", async () => {
    // v0.2.20: getWithAge is what index.ts uses to surface the cache
    // hit's age — the whole point of this helper is that the returned
    // ageMs is the cache's true age, not zero. Without this property
    // the fix to "thread ageMs on fresh cache hit" would be a no-op.
    clear("g3");
    set("g3", "hello");
    // Backdate so the entry has a known age of 5s.
    (cache as any).store.set("g3", { at: Date.now() - 5_000, value: "hello" });
    const r = getWithAge<string>("g3", 60_000);
    assert.ok(r);
    assert.equal(r!.value, "hello");
    assert.ok(r!.ageMs >= 5_000, `expected ageMs >= 5000, got ${r!.ageMs}`);
    assert.ok(r!.ageMs < 6_000, `expected ageMs < 6000, got ${r!.ageMs}`);
  });

  it("returns null when entry is past TTL (age > ttlMs)", () => {
    clear("g4");
    set("g4", "old");
    // Backdate past TTL: entry is 10s old, ttl is 1s.
    (cache as any).store.set("g4", { at: Date.now() - 10_000, value: "old" });
    assert.equal(getWithAge("g4", 1_000), null);
  });

  it("respects TTL boundary: age just over ttlMs returns null", () => {
    clear("g5");
    set("g5", "edge");
    // Age comfortably past ttlMs — the comparison is strict `>`, but
    // we use a generous margin to dodge wall-clock drift between the
    // backdate call and the getWithAge call (mirrors the existing
    // ttl-expired test's tolerance approach).
    (cache as any).store.set("g5", {
      at: Date.now() - 10_000,
      value: "edge",
    });
    assert.equal(getWithAge("g5", 1_000), null);
  });

  it("matches get() on hit/miss semantics (within TTL only)", () => {
    // getWithAge is the TTL-respecting sibling of peekWithAge. The
    // hit/miss decisions should be identical to get(); the only
    // difference is that getWithAge also returns the age.
    clear("g6");
    set("g6", "v");
    assert.equal(get("g6", 60_000), "v");
    assert.equal(getWithAge("g6", 60_000)?.value, "v");

    // After backdating past TTL, both report a miss.
    (cache as any).store.set("g6", { at: Date.now() - 10_000, value: "v" });
    assert.equal(get("g6", 1_000), null);
    assert.equal(getWithAge("g6", 1_000), null);
  });
});

// ----- Per-Project Key Isolation (v0.4.x+) -----
//
// The cache module is intentionally cwd-unaware: a single Map, a
// single on-disk file. Per-project isolation is achieved by
// `src/render.ts`'s `projectCacheKey(cwd, key)` helper, which
// prefixes every key with `projectHash(cwd):` before it reaches
// this module. This describe block verifies the contract that the
// render-side helper relies on: when two keys happen to look
// identical AFTER the projectHash prefix is applied (i.e. the
// render layer is fed a different cwd, or no cwd), the cache
// module treats them as distinct entries. (The actual
// `projectCacheKey` helper is private to render.ts — these tests
// exercise the public cache API directly with prefixed keys to
// validate the contract.)

describe("cache — per-project key isolation contract", () => {
  beforeEach(() => {
    resetForTest();
  });
  afterEach(() => {
    resetForTest();
  });

  it("two distinct prefixed keys are stored as distinct entries", () => {
    set("d--workspace-alpha:tickSpeed:sess-1", { apiMs: 100 });
    set("d--workspace-beta:tickSpeed:sess-1", { apiMs: 200 });
    assert.deepEqual(peek("d--workspace-alpha:tickSpeed:sess-1"), { apiMs: 100 });
    assert.deepEqual(peek("d--workspace-beta:tickSpeed:sess-1"), { apiMs: 200 });
  });

  it("the same unprefixed key is the global slot (no project isolation)", () => {
    // Sanity: cache itself does NOT prefix. A writer that omits the
    // projectHash prefix would collide with a writer that also omits
    // it (including a writer that runs with cwd=null and falls
    // through to the literal "_" prefix). render.ts MUST always
    // call projectCacheKey; this test pins that contract by
    // showing the bare-key path is shared.
    set("tickSpeed:sess-1", { apiMs: 1 });
    set("tickSpeed:sess-1", { apiMs: 2 });
    assert.deepEqual(peek("tickSpeed:sess-1"), { apiMs: 2 });
  });
});

// ----- Disk persistence -----
//
// v0.2.22: cache entries are shadowed to disk under state/cache.json so
// cacheTtlMs is meaningful across per-tick child-process spawns. These
// tests isolate the disk path to a tmp dir per test (via
// setCachePathResolver) and simulate the "two-tick" sequence by calling
// resetCachePathResolver / resetCachePathResolver (which doesn't actually
// exist; the trick is to use the path resolver hook to point at a fresh
// file each "process") — see the helper below.

describe("cache disk persistence", () => {
  // Per-test tmp dir. Each test gets its own file so the in-memory Map
  // can't leak between tests via a shared disk shadow.
  let dir: string;
  let cacheFile: string;

  // The cache module exports a module-level `store` Map; we can't
  // easily "spawn a new process" inside a test, so to simulate the
  // cross-tick case we use the __resetForTest hook — it clears the
  // in-memory Map AND resets the lazy-load guard so the next get/peek
  // re-reads from disk.
  function resetModuleState(): void {
    resetForTest();
  }

  function setupTmpDir(): void {
    dir = mkdtempSync(join(tmpdir(), "tokenplan-cache-test-"));
    cacheFile = join(dir, "cache.json");
    setCachePathResolver(() => cacheFile);
  }

  function teardownTmpDir(): void {
    resetCachePathResolver();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; tmp dir will be reaped by the OS.
    }
  }

  it("writes to disk on set()", () => {
    setupTmpDir();
    try {
      resetModuleState();
      set("persist-1", { hello: "world" });
      // File must exist and round-trip via raw read (bypassing cache).
      const raw = JSON.parse(readFileSync(cacheFile, "utf8"));
      assert.ok(raw["persist-1"], "entry should be on disk");
      assert.equal(raw["persist-1"].value.hello, "world");
      assert.ok(
        typeof raw["persist-1"].at === "number",
        "at should be a number",
      );
    } finally {
      teardownTmpDir();
    }
  });

  it("loads from disk on first access (simulated cross-tick hit)", () => {
    setupTmpDir();
    try {
      // --- "tick 1": write through the API, then "exit" (clear
      // in-memory state but leave the file).
      resetModuleState();
      const now = Date.now();
      set("cross-tick", { pct: 42 });
      resetModuleState();
      assert.equal((cache as any).store.size, 0, "store cleared");

      // --- "tick 2": bare read — should pick up the disk entry.
      const v = get<{ pct: number }>("cross-tick", 60_000);
      assert.ok(v, "expected cross-tick hit from disk");
      assert.equal(v!.pct, 42);

      // The age on disk was ~milliseconds ago, so a 60s TTL must hit.
      const withAge = getWithAge<{ pct: number }>("cross-tick", 60_000);
      assert.ok(withAge, "expected within-TTL hit");
      assert.ok(
        withAge!.ageMs >= 0 && withAge!.ageMs < 60_000,
        `ageMs should be within TTL, got ${withAge!.ageMs}`,
      );

      // Skip the "now" variable shadow check — we used it just to
      // emphasize that we're testing the wall-clock path.
      void now;
    } finally {
      teardownTmpDir();
    }
  });

  it("TTL is enforced on disk-loaded entries (cross-tick stale)", () => {
    setupTmpDir();
    try {
      resetModuleState();
      // Write a stale entry DIRECTLY to disk (at = 10 minutes ago) and
      // then simulate tick 2. The entry should load but get() must
      // refuse it because ageMs > ttlMs.
      const stale = { at: Date.now() - 10 * 60_000, value: { old: true } };
      writeFileSync(cacheFile, JSON.stringify({ "stale-on-disk": stale }));

      resetModuleState();
      assert.equal(get("stale-on-disk", 60_000), null);
      // peek() ignores TTL — the value is still recoverable for the
      // stale-on-error fallback path.
      assert.deepEqual(peek("stale-on-disk"), { old: true });
    } finally {
      teardownTmpDir();
    }
  });

  it("ignores a missing cache file silently", () => {
    setupTmpDir();
    try {
      resetModuleState();
      // No file exists; get/peek should return null and not throw.
      assert.equal(get("never-set", 60_000), null);
      assert.equal(peek("never-set"), null);
    } finally {
      teardownTmpDir();
    }
  });

  it("ignores a malformed cache file (one stderr warn, no crash)", () => {
    setupTmpDir();
    try {
      resetModuleState();
      writeFileSync(cacheFile, "{not valid json");
      // Capture stderr — the module warns but does not throw.
      const origStderr = process.stderr.write.bind(process.stderr);
      let warned = false;
      (process.stderr.write as unknown) = (
        chunk: string | Uint8Array,
        ...rest: unknown[]
      ): boolean => {
        const s = typeof chunk === "string" ? chunk : chunk.toString();
        if (s.includes("cache file is malformed")) warned = true;
        return (origStderr as unknown as (
          c: string | Uint8Array,
          ...r: unknown[]
        ) => boolean)(chunk, ...rest);
      };
      try {
        assert.equal(get("anything", 60_000), null);
        assert.equal(warned, true, "expected a stderr warning");
      } finally {
        process.stderr.write = origStderr;
      }
    } finally {
      teardownTmpDir();
    }
  });

  it("clear(key) removes the entry from disk; clear() wipes the file", () => {
    setupTmpDir();
    try {
      resetModuleState();
      set("k-a", "v-a");
      set("k-b", "v-b");
      clear("k-a");

      // k-a gone, k-b still present on disk.
      const afterSingle = JSON.parse(readFileSync(cacheFile, "utf8"));
      assert.equal(afterSingle["k-a"], undefined);
      assert.equal(afterSingle["k-b"].value, "v-b");

      // Simulate tick 2: only k-b reappears.
      resetModuleState();
      assert.equal(get("k-a", 60_000), null);
      assert.equal(get("k-b", 60_000), "v-b");

      // Full clear wipes the file content.
      clear();
      const afterFull = JSON.parse(readFileSync(cacheFile, "utf8"));
      assert.deepEqual(afterFull, {});
    } finally {
      teardownTmpDir();
    }
  });

  it("set() overwrites a stale on-disk entry and refreshes `at`", () => {
    setupTmpDir();
    try {
      resetModuleState();
      const old = { at: Date.now() - 5 * 60_000, value: { v: 1 } };
      writeFileSync(cacheFile, JSON.stringify({ refresh: old }));
      resetModuleState();

      // Tick 2: re-fetch (simulating TTL expiry) and overwrite.
      set("refresh", { v: 2 });

      const raw = JSON.parse(readFileSync(cacheFile, "utf8"));
      assert.equal(raw.refresh.value.v, 2);
      // `at` must have been refreshed to ~now (well under 5min ago).
      const ageMs = Date.now() - raw.refresh.at;
      assert.ok(
        ageMs < 1_000,
        `expected refreshed at ≈ now, got ageMs=${ageMs}`,
      );
    } finally {
      teardownTmpDir();
    }
  });

  it("load is lazy and idempotent (no double-read after a hit)", () => {
    setupTmpDir();
    try {
      resetModuleState();
      set("lazy", "x");

      // After set(), _loaded is true. Subsequent get() calls must NOT
      // re-read the file. We can't easily prove "no read" without
      // mocking fs, but we can prove the contract: hitting get()
      // repeatedly returns the same value (the in-memory Map is
      // authoritative after first load).
      for (let i = 0; i < 5; i++) {
        assert.equal(get("lazy", 60_000), "x");
      }
      // And _loaded must still be true after the loop — we can't reach
      // the module-private flag, but the multiple successful hits prove
      // it didn't reset mid-flight.
      assert.equal(get("lazy", 60_000), "x");
    } finally {
      teardownTmpDir();
    }
  });
});

// ----- v0.8.x: TTL-aware flush + legacy key cleanup -----
//
// After the stat cache rewrite (`sum:v1:…` → `stat:model:window:align`)
// the disk file could hold hundreds of stale `sum:v1:*` entries because
// cache.set never deletes unreferenced keys. Two new behaviors:
//
//   1. set(key, value, ttlMs) records the entry's TTL; flushToDisk
//      prunes expired entries (those with `ttlMs` AND age > ttlMs).
//      Entries lacking `ttlMs` (legacy disk entries written by older
//      versions) are kept verbatim — their TTL is still enforced by
//      get()/peek(), we just don't proactively reclaim them here.
//   2. loadFromDisk strips sum:v1:* / avg:v1:* legacy keys before they
//      re-enter the in-memory store.

describe("cache — v0.8.x TTL flush + legacy key cleanup", () => {
  let dir: string;
  let cacheFile: string;

  function resetModuleState(): void {
    resetForTest();
  }

  function setupTmpDir(): void {
    dir = mkdtempSync(join(tmpdir(), "creditgauge-cache-v8-"));
    cacheFile = join(dir, "cache.json");
    setCachePathResolver(() => cacheFile);
  }

  function teardownTmpDir(): void {
    resetCachePathResolver();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; tmp dir will be reaped by the OS.
    }
  }

  it("flushToDisk evicts entries whose ttlMs has elapsed", () => {
    setupTmpDir();
    try {
      resetModuleState();
      // Set with a 1s TTL, then backdate to make it already-expired
      // by the time we trigger the next set() (which is when flush
      // runs). The expired entry must NOT appear in the flushed file.
      set("will-expire", { v: 1 }, 1_000);
      (cache as any).store.set("will-expire", {
        at: Date.now() - 10_000,
        value: { v: 1 },
        ttlMs: 1_000,
      });
      // The next set triggers flushToDisk.
      set("keep", { v: 2 }, 60_000);

      const raw = JSON.parse(readFileSync(cacheFile, "utf8"));
      assert.equal(raw["will-expire"], undefined, "expired entry should be evicted");
      assert.ok(raw["keep"], "fresh entry should survive");
      assert.deepEqual(raw["keep"].value, { v: 2 });
      assert.equal(raw["keep"].ttlMs, 60_000, "ttlMs should round-trip on disk");
    } finally {
      teardownTmpDir();
    }
  });

  it("flushToDisk keeps legacy entries without ttlMs (no proactive eviction)", () => {
    // Entries written by pre-v0.8.x code lack `ttlMs` on disk. flush
    // must NOT delete them (their age check is the caller's job via
    // get()). The only way to remove them is via clear() or by the
    // legacy-prefix filter on load.
    setupTmpDir();
    try {
      resetModuleState();
      const stale = { at: Date.now() - 10 * 60_000, value: { old: true } };
      writeFileSync(
        cacheFile,
        JSON.stringify({ "no-ttl-legacy": stale }),
      );
      resetModuleState();
      // Trigger a flush by setting an unrelated key.
      set("trigger", "x", 60_000);

      const raw = JSON.parse(readFileSync(cacheFile, "utf8"));
      assert.ok(
        raw["no-ttl-legacy"],
        "legacy entry without ttlMs must survive flush",
      );
      assert.ok(raw["trigger"], "new entry must also survive");
    } finally {
      teardownTmpDir();
    }
  });

  it("loadFromDisk strips sum:v1:* and avg:v1:* legacy keys", () => {
    // Pre-fix: cache.json held hundreds of sum:v1:… entries because
    // the old key embedded sinceMs (different per call). After the
    // refactor these are unreachable; loadFromDisk now drops them on
    // sight, so the next flush writes a clean file.
    setupTmpDir();
    try {
      const fixture = {
        "sum:v1:kimi-k2.6:1783029296489:false": {
          at: Date.now() - 60_000,
          value: { sumIn: 1, rows: 1 },
        },
        "sum:v1:MiniMax-M3:1783032209946:false": {
          at: Date.now() - 60_000,
          value: { sumIn: 2, rows: 2 },
        },
        "avg:v1:kimi:0:false": {
          at: Date.now() - 60_000,
          value: { sumIn: 3, rows: 3 },
        },
        "stat:MiniMax-M3:5h:false": {
          at: Date.now() - 60_000,
          value: { sumIn: 4, rows: 4 },
        },
        minimax: { at: Date.now() - 60_000, value: { data: "stays" } },
      };
      writeFileSync(cacheFile, JSON.stringify(fixture));

      resetModuleState();
      // Trigger load (any get/peek does it). Legacy keys must NOT
      // be in the in-memory store.
      get("stat:MiniMax-M3:5h:false", 60_000);

      const storeKeys = Array.from((cache as any).store.keys()).sort();
      assert.deepEqual(
        storeKeys,
        ["minimax", "stat:MiniMax-M3:5h:false"],
        `legacy sum:v1:*/avg:v1:* keys must be stripped; got ${JSON.stringify(storeKeys)}`,
      );

      // Subsequent flush must NOT write the legacy keys back.
      set("after-flush", "x", 60_000);
      const raw = JSON.parse(readFileSync(cacheFile, "utf8"));
      assert.equal(raw["sum:v1:kimi-k2.6:1783029296489:false"], undefined);
      assert.equal(raw["sum:v1:MiniMax-M3:1783032209946:false"], undefined);
      assert.equal(raw["avg:v1:kimi:0:false"], undefined);
      assert.ok(raw["stat:MiniMax-M3:5h:false"], "stat: key survives");
      assert.ok(raw["minimax"], "non-legacy key survives");
      assert.ok(raw["after-flush"], "new key present");
    } finally {
      teardownTmpDir();
    }
  });
});

// v0.8.21+ — file-scope cleanup of the ephemeral dir created at
// module load (see header). Without this, dozens of test runs would
// litter `os.tmpdir()` with empty cache.json files; with this, the
// process leaves no trace. Runs on its own (the inner describes'
// `teardownTmpDir()` reset the resolver back to `_ephemeralDir`-
// based one, which is the file-scope default — no conflict).
after(() => {
  resetCachePathResolver();
  try { rmSync(_ephemeralDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});