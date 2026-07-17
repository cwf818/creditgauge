export type Interval = {
  windowId: string;
  label: string;
  startAt: number | null;
  endAt: number | null;
  intervalMs: number | null;
  remainingPercent: number | null;
  usedPercent: number | null;
  remainingQuota: number | null;
  usedQuota: number | null;
  limitQuota: number | null;
};

// v0.9.4 — the `intervals` dict IS the source of truth. Three reserved
// keys (short / mid / long) ship with the historical defaults
// (5h / 7d / 30d) so existing plugin authors and the built-in
// minimax/deepseek/kimi/copilot plugins keep working without
// renaming; the dict is otherwise OPEN — a plugin may declare any
// additional key (e.g. "monthly", "yearly", "weekday-peak") and
// reference it via `m_windowQuota|term|<key>`. Empty dict is the
// legitimate "no data" case (the host treats it as "all slots
// null" and the per-module placeholder fires).
//
// For backward compat, the host's `ensureQuota` ALSO accepts the
// legacy `shortInterval` / `midInterval` / `longInterval` fields on
// the raw plugin output and maps them onto the reserved keys. The
// Quota type itself only exposes `intervals` — the legacy fields
// are an `ensureQuota`-level concern, not part of the canonical
// shape (so render-time reads go through `ctx.intervals["short"]`
// / `ctx.intervals[anyOtherKey]` uniformly).
export type Quota = {
  intervals: Record<string, Interval | null>;
};

export type BalanceEntry = {
  currency: string;
  totalBalance: number;
};

export type Balance = {
  isAvailable: boolean;
  entries: BalanceEntry[];
  // v2026.07.17+: host-computed worst-case entry value (lowest
  // totalBalance). The renderer no longer consults this for color
  // (per-entry 5-band now drives hue). The field is retained so
  // plugins reading it for alerting/introspection keep working,
  // and ensureBalance keeps computing it.
  minValue: number | null;
};

export type PluginContext = {
  providerId: string;
  type: "QUOTA" | "BALANCE";
  signal?: AbortSignal;
};

// v0.8.47+ — single-method ABI. The plugin returns whatever shape
// it decided to project from the raw response (a Partial<Quota> /
// Partial<Balance>, or any opaque object the plugin wants). The
// host then runs ensureQuota / ensureBalance on the result. Plugins
// never see the canonical Quota / Balance types — only their fill
// contract + the ctx argument (signal).
export type AccountCreditPlugin = {
  fetchAccountCredit: (
    authenticationKey: string,
    context?: PluginContext,
  ) => unknown | Promise<unknown>;
};
