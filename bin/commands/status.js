/**
 * creditgauge status [provider]   —   creditgauge plugin status [provider]
 *
 * Query account usage / balance for one or all configured providers and
 * print a human-readable report.
 *
 * Behavior:
 *   - No <provider>   → report every provider currently configured in
 *                       ~/.claude/plugins/creditgauge/config.json (providers.*)
 *   - With <provider> → report only that provider (must be configured)
 *
 * Resolution order for the plugin module (same as the statusline runtime
 * in src/api.ts):
 *   1. ~/.claude/plugins/creditgauge/query_plugins/<id>/index.{js,mjs}
 *      (user-installed / user-overridden; install.sh seeds the bundled
 *      minimax / deepseek here)
 *   2. <package>/query_plugins/<id>/index.js (the bundled copy)
 *
 * ABI: default export must be { fetchAccountCredit(authenticationKey, ctx?) }.
 * The raw result is normalised host-side with the same ensureQuota /
 * ensureBalance logic as src/plugins/parsers.ts before rendering.
 *
 * Exit codes:
 *   0 — every queried provider succeeded
 *   1 — at least one provider failed (each failure is printed inline)
 *   2 — usage error (unknown provider id / not configured / missing config)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as cfg from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** CLI timeout per provider fetch (the statusline runtime uses 5s). */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Default entries for the bundled providers when they are NOT configured in
 * config.json. The statusline runtime matches them via ANTHROPIC_BASE_URL and
 * uses entry.AUTHENTICATION_KEY first, then the env token; the CLI has no
 * BASE_URL to match, so it queries by id and falls back to the same env token.
 */
const BUNDLED_DEFAULTS = {
  minimax: { TYPE: "QUOTA", AUTHENTICATION_KEY: process.env.ANTHROPIC_AUTH_TOKEN ?? "" },
  deepseek: { TYPE: "BALANCE", AUTHENTICATION_KEY: process.env.ANTHROPIC_AUTH_TOKEN ?? "" },
};

// ---------------------------------------------------------------------------
// Plugin resolution
// ---------------------------------------------------------------------------

function userPluginCandidates(providerId) {
  const dir = path.join(
    os.homedir(),
    ".claude", "plugins", "creditgauge", "query_plugins", providerId,
  );
  return [path.join(dir, "index.js"), path.join(dir, "index.mjs")];
}

function bundledPluginPath(providerId) {
  // pkgRoot/bin/commands/status.js → pkgRoot/query_plugins/<id>/index.js
  return path.join(__dirname, "..", "..", "query_plugins", providerId, "index.js");
}

/** Resolve the plugin file for a provider id, or null when neither side has one. */
export function resolvePluginPath(providerId) {
  for (const p of userPluginCandidates(providerId)) {
    if (fs.existsSync(p)) return p;
  }
  const bundled = bundledPluginPath(providerId);
  if (fs.existsSync(bundled)) return bundled;
  return null;
}

// ---------------------------------------------------------------------------
// Canonical normalizers — port of src/plugins/parsers.ts (ensureInterval /
// ensureQuota / ensureBalance) so the CLI never depends on the TS sources.
// ---------------------------------------------------------------------------

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

const RESERVED_INTERVAL_KEYS = ["short", "mid", "long"];
const RESERVED_DEFAULT_WINDOW_IDS = { short: "5h", mid: "7d", long: "30d" };

function ensureTimeGroup(value) {
  const startRaw = asNumber(value.startAt);
  const endRaw = asNumber(value.endAt);
  const intervalRaw = asNumber(value.intervalMs);
  const nonNullCount =
    (startRaw != null ? 1 : 0) +
    (endRaw != null ? 1 : 0) +
    (intervalRaw != null ? 1 : 0);
  if (nonNullCount < 2) {
    return { startAt: null, endAt: null, intervalMs: null };
  }
  if (startRaw != null && endRaw != null) {
    return { startAt: startRaw, endAt: endRaw, intervalMs: intervalRaw ?? (endRaw - startRaw) };
  }
  if (startRaw != null && intervalRaw != null) {
    return { startAt: startRaw, endAt: startRaw + intervalRaw, intervalMs: intervalRaw };
  }
  if (endRaw != null && intervalRaw != null) {
    return { startAt: endRaw - intervalRaw, endAt: endRaw, intervalMs: intervalRaw };
  }
  return { startAt: null, endAt: null, intervalMs: null };
}

function ensureInterval(value, key) {
  if (!isRecord(value)) return null;
  const remainingRaw = asNumber(value.remainingPercent);
  const usedRaw = asNumber(value.usedPercent);
  const remainingPercent = usedRaw != null ? 100 - usedRaw : remainingRaw;
  const usedPercent = usedRaw != null ? usedRaw : (
    remainingRaw != null ? 100 - remainingRaw : null
  );
  const time = ensureTimeGroup(value);
  const fallback = RESERVED_INTERVAL_KEYS.includes(key)
    ? RESERVED_DEFAULT_WINDOW_IDS[key]
    : key;
  const windowId = typeof value.windowId === "string" ? value.windowId : fallback;
  const label = typeof value.label === "string"
    ? value.label
    : (typeof value.windowId === "string" ? value.windowId : fallback);

  return {
    windowId,
    label,
    startAt: time.startAt,
    endAt: time.endAt,
    intervalMs: time.intervalMs,
    remainingPercent,
    usedPercent,
    remainingQuota: asNumber(value.remainingQuota),
    usedQuota: asNumber(value.usedQuota),
    limitQuota: asNumber(value.limitQuota),
  };
}

/** Accept the open dict shape { short, mid, long, <any> } → { intervals }. */
function ensureQuota(value) {
  if (!isRecord(value)) return null;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "all") continue;
    out[k] = v == null ? null : ensureInterval(v, k);
  }
  for (const reserved of RESERVED_INTERVAL_KEYS) {
    if (!(reserved in out)) out[reserved] = null;
  }
  return { intervals: out };
}

function ensureBalance(value) {
  if (!value || typeof value !== "object") return null;
  const partial = value;
  const entries = Array.isArray(partial.entries) ? partial.entries : [];
  const isAvailable = partial.isAvailable ?? true;
  let minValue = null;
  if (entries.length > 0) {
    minValue = entries[0].totalBalance;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].totalBalance < minValue) minValue = entries[i].totalBalance;
    }
  }
  return { isAvailable, entries, minValue };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchProvider(providerId, entry) {
  const pluginPath = resolvePluginPath(providerId);
  if (!pluginPath) {
    throw new Error(
      `plugin file not found — checked query_plugins/${providerId}/ (user and bundled)`,
    );
  }
  let mod;
  try {
    mod = await import(pathToFileURL(pluginPath).href);
  } catch (err) {
    throw new Error(`failed to load plugin ${pluginPath}: ${err.message ?? err}`);
  }
  const plugin = mod.default;
  if (!plugin || typeof plugin !== "object" ||
      typeof plugin.fetchAccountCredit !== "function") {
    throw new Error(
      `plugin ${pluginPath}: default export must be { fetchAccountCredit(authenticationKey, context?) }`,
    );
  }

  const { config: _drop, ...entryRest } = entry;
  const ctx = {
    providerId,
    type: entry.TYPE,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    providerEntry: entryRest,
  };
  const raw = await plugin.fetchAccountCredit(entry.AUTHENTICATION_KEY ?? "", ctx);
  if (entry.TYPE === "QUOTA") return ensureQuota(raw);
  if (entry.TYPE === "BALANCE") return ensureBalance(raw);
  throw new Error(`unsupported provider TYPE: ${entry.TYPE}`);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const COLORS = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

/** True when stdout is a TTY (ANSI colors OK). */
function useColor() {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function color(code, text) {
  if (!useColor() || !code) return text;
  return COLORS[code] + text + COLORS.reset;
}

/** 10-cell usage bar: filled cells = used%. */
function bar(usedPercent) {
  const pct = usedPercent == null ? 0 : Math.max(0, Math.min(100, usedPercent));
  const filled = Math.round(pct / 10);
  return "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);
}

function barColor(usedPercent) {
  if (usedPercent == null) return "dim";
  if (usedPercent >= 90) return "red";
  if (usedPercent >= 70) return "yellow";
  if (usedPercent >= 50) return "";
  return "green";
}

/** 1234567 → "1,234,567" (also works for decimals). */
function fmtNumber(n, maxDigits = 2) {
  if (n == null) return "—";
  return Number(n.toFixed(2)).toLocaleString("en-US", { maximumFractionDigits: maxDigits });
}

/**
 * Sentinel floor for epoch-ms fields. Values at/below this are treated as
 * "no time" (APIs commonly ship 0 or 1970-era zeros for windows that were
 * never started / already reset) and render as a cycle length instead of a
 * bogus 1970 date.
 */
const MIN_EPOCH_MS = 1_000_000_000; // 2001-09-09

/** ms → "1d 2h 3m" (drop zero units; seconds only when total < 1m). */
function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const parts = [];
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  return parts.join(" ");
}

function fmtDateTime(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Render one Quota interval line. */
function fmtIntervalLine(interval) {
  const usedPct = interval?.usedPercent ?? null;
  const pctText = usedPct == null
    ? color("dim", "n/a")
    : `${fmtNumber(usedPct, 1)}%`;
  const barText = usedPct == null
    ? color("dim", "\u2591".repeat(10))
    : color(barColor(usedPct), bar(usedPct));

  // Quota axis (when the plugin reports absolute numbers).
  let quotaText = "";
  if (interval && interval.limitQuota != null) {
    const used = interval.usedQuota ?? (interval.limitQuota - (interval.remainingQuota ?? 0));
    quotaText = `已用 ${fmtNumber(used)} / ${fmtNumber(interval.limitQuota)}`;
  } else if (interval && interval.remainingPercent != null && usedPct != null) {
    quotaText = `剩余 ${fmtNumber(interval.remainingPercent)}%`;
  }

  // Reset time: prefer the countdown (endAt known), else absolute time.
  // endAt sentinels (0 / 1970-era) degrade to the cycle length.
  let resetText = color("dim", "—");
  if (interval) {
    const now = Date.now();
    if (interval.endAt != null && interval.endAt > MIN_EPOCH_MS) {
      const remaining = interval.endAt - now;
      if (remaining > 0) {
        resetText = color("dim", `重置 ${fmtDuration(remaining)} 后`);
      } else {
        resetText = color("dim", `重置于 ${fmtDateTime(interval.endAt)}`);
      }
    } else if (interval.intervalMs != null) {
      resetText = color("dim", `周期 ${fmtDuration(interval.intervalMs)}`);
    }
  }

  const label = String(interval?.label ?? interval?.windowId ?? "?");
  const pieces = [barText, pctText];
  if (quotaText) pieces.push(quotaText);
  pieces.push(resetText);
  return `  ${label.padEnd(6)}${pieces.join("  ")}`;
}

function fmtBalanceLine(balance) {
  if (!balance || balance.isAvailable === false) {
    return color("red", "  账户不可用 (isAvailable=false)");
  }
  const entries = balance?.entries ?? [];
  if (entries.length === 0) {
    return color("dim", "  无余额数据");
  }
  return entries
    .map((e) => {
      const cur = String(e.currency || "?").toUpperCase();
      return `  ${cur.padEnd(4)}${fmtNumber(e.totalBalance)}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printHelp() {
  process.stdout.write(
    [
      "creditgauge status — query account usage/balance",
      "",
      "Usage:",
      "  npx creditgauge status [provider]",
      "  npx creditgauge plugin status [provider]",
      "",
      "  Without <provider>, reports every provider configured in config.json",
      "  plus the bundled minimax / deepseek (unconfigured built-ins use the",
      "  ANTHROPIC_AUTH_TOKEN env var, or providers.<id>.AUTHENTICATION_KEY).",
      "  With <provider>, reports only that provider (must be configured or a built-in).",
      "",
      "Examples:",
      "  npx creditgauge status",
      "  npx creditgauge status commandcode",
      "  npx creditgauge plugin status opencode",
    ].join("\n") + "\n",
  );
}

export default async function pluginStatus(args) {
  if (args[0] === "--help" || args[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  const config = cfg.load();
  const providers = config.providers || {};

  // Resolve the target provider list. Bundled providers (minimax / deepseek)
  // are always reportable: configured entries from config.json win; an
  // unconfigured built-in falls back to BUNDLED_DEFAULTS (env token) and is
  // queried the same way, so `npx creditgauge status` sees all five providers.
  let targets;
  if (args[0]) {
    const providerId = args[0];
    if (!providers[providerId] && !BUNDLED_DEFAULTS[providerId]) {
      console.error(`Error: provider "${providerId}" is not installed`);
      console.error("Run first: npx creditgauge plugin add " + providerId);
      process.exit(2);
    }
    targets = [providerId];
  } else {
    targets = Object.keys(providers);
    // Append bundled providers that are not configured (they get the
    // default entry + env-token fallback below).
    for (const id of Object.keys(BUNDLED_DEFAULTS)) {
      if (!(id in providers)) targets.push(id);
    }
    if (targets.length === 0) {
      console.error("Error: no providers configured in config.json");
      console.error("Run first: npx creditgauge plugin add <provider>");
      process.exit(2);
    }
  }

  console.log("");
  const label = args[0] ? `用量 (${args[0]})` : `用量 (${targets.length} 个 provider)`;
  console.log(color("cyan", `\u{1F4CA} creditgauge ${label}`));
  console.log("");

  let failures = 0;
  for (const providerId of targets) {
    const entry = providers[providerId] ?? BUNDLED_DEFAULTS[providerId];
    const title = color("cyan", `\u2500\u2500 ${providerId} `) +
      color("dim", "\u2500".repeat(Math.max(0, 52 - providerId.length - 2)));

    // Unconfigured built-in with no env token: nothing to query with. Show a
    // hint instead of a misleading "插件返回 null" / network error.
    if (!providers[providerId] && !entry.AUTHENTICATION_KEY) {
      console.log(title);
      console.log(
        color("yellow", "  未配置密钥 — 设置 ANTHROPIC_AUTH_TOKEN 环境变量，"),
      );
      console.log(
        color("yellow", "  或在 config.json 的 providers." + providerId + ".AUTHENTICATION_KEY 中填写"),
      );
      console.log("");
      continue;
    }

    try {
      const data = await fetchProvider(providerId, entry);
      console.log(title);
      if (data == null) {
        console.log(color("yellow", "  (无数据 — 插件返回 null)"));
      } else if (entry.TYPE === "QUOTA") {
        const intervals = data.intervals || {};
        const present = Object.values(intervals).filter(Boolean);
        if (present.length === 0) {
          console.log(color("yellow", "  (无窗口数据)"));
        } else {
          for (const it of present) {
            const line = fmtIntervalLine(it);
            if (line) console.log(line);
          }
        }
      } else if (entry.TYPE === "BALANCE") {
        console.log(fmtBalanceLine(data));
      }
      console.log("");
    } catch (err) {
      failures++;
      console.log(title);
      console.log(color("red", `  \u2717 查询失败: ${err.message ?? err}`));
      console.log("");
    }
  }

  process.exit(failures === 0 ? 0 : 1);
}

// Named exports for unit tests (host CLI consumes only `default`).
export {
  ensureQuota,
  ensureBalance,
  fmtIntervalLine,
  fmtBalanceLine,
  fmtDuration,
  fmtDateTime,
};
