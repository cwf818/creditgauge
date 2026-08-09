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

// The `intervals` dict IS the source of truth. Three reserved keys
// (short / mid / long) ship with historical defaults (5h / 7d / 30d); the dict
// is otherwise OPEN — a plugin may declare any key (e.g. "monthly") referenced
// via `m_windowQuota|term|<key>`. An empty dict is the legitimate "no data"
// case (host treats it as all-null; the per-module placeholder fires).
//
// `ensureQuota` treats every dict key as a literal interval (no legacy
// shortInterval/midInterval/longInterval field mapping). Render reads go
// through ctx.intervals[key] uniformly.
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
  // Host-computed worst-case entry (lowest totalBalance). Not consulted by the
  // renderer (per-entry 5-band drives hue); retained for plugins doing
  // alerting/introspection, and ensureBalance keeps computing it.
  minValue: number | null;
};

export type PluginContext = {
  providerId: string;
  type: "QUOTA" | "BALANCE";
  signal?: AbortSignal;
  /** Raw provider entry from config.json (minus the internal `config` override
   *  block); user-defined fields flow through so plugins read custom params
   *  without hardcoding them. */
  providerEntry?: Record<string, unknown>;
};

// Single-method ABI. The plugin returns whatever shape it projected from the
// raw response (Partial<Quota> / Partial<Balance> / any opaque object); the
// host then runs ensureQuota / ensureBalance. Plugins never see the canonical
// Quota / Balance types — only their fill contract + ctx (signal).
export type AccountCreditPlugin = {
  fetchAccountCredit: (
    authenticationKey: string,
    context?: PluginContext,
  ) => unknown | Promise<unknown>;
};
