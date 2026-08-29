// CommandCode plugin smoke test. Loads index.js and exercises fillQuota
// against a sample billing payload, then (optionally) hits the live endpoint
// with saved cookies.
// Usage:
//   node test.mjs            # pure unit: fillQuota over a synthetic payload
//   node test.mjs live       # live: requires cookies + AUTHENTICATION_KEY env
import plugin, { fillQuota } from "./index.js";

// ---------- unit: fillQuota over the real response shape ----------
const sample = {
  credits: {
    belowThreshold: false,
    creditThreshold: 0,
    monthlyCredits: 64.7275989213,
    purchasedCredits: 0,
    premiumMonthlyCredits: 0,
    opensourceMonthlyCredits: 64.7275989213,
  },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: {
      used: 1.1541096572,
      cap: 14,
      exceeded: false,
      resetAt: 1787685791161,
    },
    weekly: {
      used: 2.9021765643,
      cap: 35,
      exceeded: false,
      resetAt: 1788254540662,
    },
  },
  // subscriptions.data (planId=individual-goat → 70 quota limit)
  subscriptionData: {
    id: "sub_1U8GH7DSZgxV3MJKTpbWuSKI",
    status: "active",
    currentPeriodStart: "2026-08-25T09:03:37.000Z",
    currentPeriodEnd: "2026-09-25T09:03:37.000Z",
    planId: "individual-goat",
  },
};

const q = fillQuota(sample);
console.log("========== fillQuota(sample) ==========\n");
for (const [key, iv] of Object.entries(q)) {
  if (!iv) {
    console.log(`[${key}] 无数据`);
    continue;
  }
  console.log(`[${key}] (${iv.label})`);
  console.log(`  窗口:    ${(iv.intervalMs / 3600000).toFixed(1)}h`);
  console.log(`  已用:    ${iv.usedPercent?.toFixed(1)}%  (${iv.usedQuota}/${iv.limitQuota})`);
  console.log(`  剩余:    ${iv.remainingPercent?.toFixed(1)}%  (${iv.remainingQuota})`);
  console.log(`  重置于:  ${iv.endAt ? new Date(iv.endAt).toLocaleString() : "(无时间锚点)"}`);
  console.log();
}

// ---------- live fetch ----------
const live = process.argv[2] === "live";
if (live) {
  const key = process.env.AUTHENTICATION_KEY;
  if (!key) {
    console.error("live 模式需要 AUTHENTICATION_KEY 环境变量");
    process.exit(1);
  }
  console.log("========== live fetch ==========\n");
  const result = await plugin.fetchAccountCredit(key, {});
  console.log(JSON.stringify(result, null, 2));
}
