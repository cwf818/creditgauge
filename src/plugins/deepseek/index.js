// DeepSeek built-in plugin. Plain ESM JS — same shape as a
// user-written plugin at ~/.claude/plugins/creditgauge/query_plugins/<id>/.
//
// ABI: default export is { fetchAccountCredit(authenticationKey, ctx) },
// where `ctx` exposes { signal }. The returned object is a
// Partial<Balance> (host will run `ensureBalance` on it to produce the
// canonical Balance shape). The plugin author never has to know about
// the canonical Quota / Balance types — only their fill contract + the
// ctx argument (signal).

const ENDPOINT = "https://api.deepseek.com/user/balance";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

// Project the raw DeepSeek balance response into a Partial<Balance>.
// DeepSeek returns `{ is_available, balance_infos: [{ currency, total_balance, ... }] }`
// — each balance_info element has the currency code already, so we just
// coerce total_balance → number and build the canonical entries.
// Entries whose totalBalance fails to coerce are dropped (matches the
// v0.x parseBalance behaviour). An empty entries[] + isAvailable=true
// flows through ensureBalance as the "no data" path; an
// isAvailable=false empty entries flows as the "account frozen" path.
function fillBalance(raw) {
  if (!isRecord(raw)) return null;

  const availRaw = raw.is_available;
  let isAvailable;
  if (typeof availRaw === "boolean") {
    isAvailable = availRaw;
  } else if (typeof availRaw === "string" && availRaw.toLowerCase() === "false") {
    isAvailable = false;
  }

  const entries = [];
  const infos = raw.balance_infos;
  if (Array.isArray(infos)) {
    for (const info of infos) {
      if (!isRecord(info)) continue;
      const currency = info.currency;
      if (typeof currency !== "string" || currency === "") continue;
      const totalBalance = asNumber(info.total_balance);
      if (totalBalance == null) continue;
      entries.push({ currency, totalBalance });
    }
  }

  return { isAvailable, entries };
}

export default {
  async fetchAccountCredit(authenticationKey, ctx) {
    if (!authenticationKey) return null;
    const response = await fetch(ENDPOINT, {
      signal: ctx?.signal,
      headers: {
        Authorization: `Bearer ${authenticationKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) throw new Error(`DeepSeek balance HTTP ${response.status}`);
    const raw = JSON.parse(await response.text());
    return fillBalance(raw);
  },
};
