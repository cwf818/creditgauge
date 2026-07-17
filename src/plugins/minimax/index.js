// MiniMax built-in plugin. Plain ESM JS — same shape as a
// user-written plugin at ~/.claude/plugins/creditgauge/query_plugins/<id>/.
//
// ABI: default export is { fetchAccountCredit(authenticationKey, ctx) },
// where `ctx` exposes { signal }. The returned object is
// a Partial<Quota> (host will run `ensureQuota` on it to produce
// the canonical Quota shape). The plugin author never has to know
// about the canonical Quota / Balance types.

const ENDPOINT = "https://www.minimaxi.com/v1/token_plan/remains";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStatusCode(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

// Raw → Partial<Quota>. Selects the "general" entry from
// `model_remains[]` and projects the two MiniMax windows onto the
// canonical reserved `short` / `mid` keys (the `long` slot is null
// for this provider). Returns null when the response is missing
// base_resp / status_code != 0 / the "general" entry is absent —
// those cases propagate to the host as a soft fail.
function fillQuota(raw) {
  if (!isRecord(raw)) return null;

  const baseResp = raw.base_resp;
  if (isRecord(baseResp)) {
    const statusCode = asStatusCode(baseResp.status_code);
    if (statusCode !== null && statusCode !== 0) return null;
  }

  if (!Array.isArray(raw.model_remains)) return null;
  const general = raw.model_remains.find(
    (entry) => isRecord(entry) && entry.model_name === "general",
  );
  if (!general) return null;

  return {
    short: {
      remainingPercent: general.current_interval_remaining_percent,
      startAt: general.start_time,
      endAt: general.end_time,
    },
    mid: {
      remainingPercent: general.current_weekly_remaining_percent,
      startAt: general.weekly_start_time,
      endAt: general.weekly_end_time,
    },
    long: null,
  };
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
    if (!response.ok) throw new Error(`MiniMax token plan HTTP ${response.status}`);
    const raw = JSON.parse(await response.text());
    return fillQuota(raw);
  },
};