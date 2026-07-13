# query_plugins — user-side provider plugins

User-shipped plugin drop-ins that extend the built-in `minimax` / `deepseek`
set without forking the repo. The host loader resolves the active provider
from `ANTHROPIC_BASE_URL` against `config.providers`, then loads either
the bundled built-in **or** a same-named file under this directory —
whichever the filesystem hands back. User plugins take precedence, so
dropping a file here is how you ship a replacement without touching
`src/`.

The plugin must be a single ESM file exporting
`default { fetchAccountCredit(authenticationKey, ctx) }`. See
[`../HOW_TO_CREATE_A_PLUGIN.md`](../HOW_TO_CREATE_A_PLUGIN.md) for the
full ABI and the fill contract.

## Install directory

Drop a single `<id>/index.js` (or `.mjs`) at:

- **Unix**: `~/.claude/plugins/topgauge/query_plugins/<id>/`
- **Windows**: `%USERPROFILE%\.claude\plugins\topgauge\query_plugins\<id>\`

The `<id>` must match a `providers.<id>` entry in `config.json` (the
loader hands the id straight through).

## config.json wiring

The plugin needs a provider entry that points at it. Set the active
provider via `ANTHROPIC_BASE_URL` and add the matching block to
`~/.claude/plugins/topgauge/config.json`:

```jsonc
{
  "providers": {
    "<id>": {
      "baseUrl": "https://<provider-host>",
      // Plugin-specific knobs go here. Most plugins need at minimum:
      "AUTHENTICATION_KEY": "<credential>",
      // Optional template / fail-label / interval overrides:
      "template": "minimal",
      "failLabel": "unavailable"
    }
  }
}
```

Plugin keys land on the `ctx` argument the host passes in, so the plugin
author reads `ctx.intervals` / `ctx.currencies` / etc. directly from the
config block you wrote above. No host-side schema change is needed when
you add new fields.

## Bundled examples

### `kimi/` — Moonshot Kimi (kimi.com)

Endpoint:
`POST https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages`

Three windows:
- `5h` rolling sub-window (`usages.limits[0].detail`)
- `7d` primary weekly cycle (`usages.detail`)
- `30d` total-quota percentage only (`totalQuota.remaining` — no
  resetTime / startAt / endAt available, so the renderer drops the
  time group)

#### `AUTHENTICATION_KEY` — REQUIRED, non-obvious source

The Kimi dashboard's `localStorage.access_token` (the one issued after
browser login at <https://kimi.com>) — **NOT** the API token under
Settings. The plugin sends it as `Authorization: Bearer <key>` against
the dashboard's gRPC-over-HTTP endpoint.

To grab it:

1. Open <https://kimi.com> in your browser, log in.
2. DevTools → Application → Local Storage → `https://kimi.com` → copy
   the value of `access_token`.
3. Paste it into `config.json`:

   ```jsonc
   {
     "providers": {
       "kimi": {
         "baseUrl": "https://api.kimi.com/coding/",
         "AUTHENTICATION_KEY": "<paste access_token here>"
       }
     }
   }
   ```

**Refresh cadence.** Kimi's auth tokens expire with the browser session
and there is no programmatic refresh — when you log out / re-login,
re-extract the new `access_token` and update `config.json`. A stale
token does **not** throw a visible error; the plugin silently returns
null and the renderer falls back to a `Remain: --:…` placeholder.

### `copilot-api/` — GitHub Copilot (via copilot-proxy sidecar)

Endpoint: `GET http://localhost:4141/usage` — the copilot-proxy
sidecar that runs on the user's machine.

One window: `30d` natural-month cycle (`premium_interactions`,
projected onto `longInterval`). `shortInterval` / `midInterval` stay
null and the renderer drops them on a Copilot-only display. The
`startAt` / `endAt` are computed locally as the natural-month
boundaries (start of this month → start of next month, local time)
so the renderer can draw a window-fill-aware reset arrow.

#### `AUTHENTICATION_KEY` — OPTIONAL

The proxy sidecar is on `localhost` and is implicit-authenticated by
IP. Most users leave `AUTHENTICATION_KEY` unset; the plugin only
attaches `Authorization: Bearer <key>` if the field is non-empty.
Leave it out unless your copilot-proxy variant requires it.

```jsonc
{
  "providers": {
    "copilot": {
      "baseUrl": "http://localhost:1141",
      "AUTHENTICATION_KEY": ""
    }
  }
}
```