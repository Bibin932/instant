# Meta Lead Ads -> CRM (self-hosted Node.js)

This is a separate polling service. It does not modify the existing `server.js`, webhook route, Nginx vhost, or WACRM/CRM application code.

## Requirements

- Node.js 20 or newer.
- The existing project `.env` one directory above this folder must contain `META_PAGE_TOKENS_JSON` keyed by Page ID.
- The existing project must have `dotenv` installed (it is already used by the current project).
- A CRM HTTPS API endpoint and its expected JSON/authentication contract.

## Install on the existing VPS

Upload/extract this folder to:

`/www/wwwroot/faces.cybercodix.com/instant/meta-lead-sync`

Then run:

```bash
cd /www/wwwroot/faces.cybercodix.com/instant/meta-lead-sync
cp .env.example .env
chmod 600 .env
nano .env
```

Keep `DRY_RUN=true` initially. The service reads the Page token for `META_PAGE_ID` from the existing parent file:

`/www/wwwroot/faces.cybercodix.com/instant/.env`

It does not require copying the token into this new folder.

## First safe test

Check the existing `.env` contains a valid `META_PAGE_TOKENS_JSON` object for the Page ID. Then install/start the independent service:

```bash
cp meta-lead-sync.service /etc/systemd/system/meta-lead-sync.service
systemctl daemon-reload
systemctl enable --now meta-lead-sync
systemctl status meta-lead-sync --no-pager
journalctl -u meta-lead-sync -f
```

In dry-run mode it fetches Meta lead records but does not call the CRM. Logs show only lead IDs, form IDs, and field names—not lead values. Health check:

```bash
curl -sS http://127.0.0.1:3111/health
```

## First-run behavior

By default, the first start records a baseline timestamp and does not import older leads. This avoids unexpectedly pushing historical/test leads into the CRM. New leads created after the service starts are eligible. Meta sample leads such as `test@meta.com` and names containing `<test lead:` are excluded by default.

To intentionally backfill the form history, set `SYNC_HISTORICAL_LEADS=true` in this service's `.env`. Test leads remain excluded unless `SYNC_TEST_LEADS=true` is also set.

## CRM configuration

Do not set `DRY_RUN=false` until the CRM API contract has been confirmed. Configure:

- `CRM_API_URL`: the exact HTTPS endpoint.
- `CRM_API_METHOD`: usually `POST`.
- `CRM_BEARER_TOKEN`: optional Bearer token if the API uses it.
- `CRM_HEADERS_JSON`: optional additional headers as a JSON object, e.g. `{"X-API-Key":"..."}`.
- `CRM_FIELD_MAP_JSON`: optional map from source keys (`full_name`, `email`, `phone_number`, `meta_lead_id`, `page_id`, `form_id`, `created_time`, `fields`, `raw_field_data`, `source`) to CRM field names.
- `CRM_STATIC_FIELDS_JSON`: optional fixed values required by the CRM.

With an empty field map, the service sends this standard JSON structure:

```json
{
  "meta_lead_id": "...",
  "source": "facebook_lead_ads",
  "page_id": "...",
  "form_id": "...",
  "created_time": "...",
  "full_name": "...",
  "email": "...",
  "phone_number": "...",
  "fields": {"...": "..."},
  "raw_field_data": []
}
```

The CRM must accept that structure, or `CRM_FIELD_MAP_JSON` must be configured to match its schema. The service sends an `Idempotency-Key: meta-lead-{lead_id}` header. The CRM should honor that header or enforce a unique constraint on `meta_lead_id` to protect against duplicates if a request succeeds remotely but the network fails before the local service records the success.

After the endpoint and field mapping are confirmed, set `DRY_RUN=false`, then restart:

```bash
systemctl restart meta-lead-sync
journalctl -u meta-lead-sync -f
```

## State and logs

Local delivery state is stored at `data/state.json` with restrictive permissions. Sent leads are not sent again. Failed requests are retried with exponential backoff. Do not delete `data/state.json` after going live, or the service may send previously imported leads again.

This service polls active and inactive Page forms every `POLL_INTERVAL_SECONDS` (default 60). Meta API access still depends on the Page token and the app's granted Meta permissions. Self-hosting does not bypass Meta App Review / Advanced Access requirements for production lead retrieval.

## Multi-Page admin management

The existing authenticated dashboard at `https://faces.cybercodix.com/admin` now includes a **Meta Lead Sync · Accounts & Forms** section.

- Existing Page token configuration is migrated on first start into `data/connections.json` with the existing Page's active-form behavior preserved.
- Add another Page by pasting that Page's Page Access Token into the dashboard. The service validates the token, resolves the Page name, and discovers its lead forms.
- Newly connected Pages have their forms paused by default. Enable only the forms that should send leads to the CRM.
- Each Page and form shows its own lead totals, CRM deliveries, retrying and failed counts, status, and last check time.
- Pausing a Page or form stops future polling; it does not delete lead history. Disconnecting a Page removes its stored token and connection but keeps processed lead history.
- Tokens are stored in `data/connections.json` with mode `0600`; that file is ignored by Git. The local management API binds only to `127.0.0.1:HEALTH_PORT`; the existing admin server proxies it behind its existing Basic Authentication.

Do not commit `.env`, `data/state.json`, or `data/connections.json`. Back up the two JSON data files before deployment or server maintenance. The webhook bridge statistics and polling-service statistics are shown separately because they are two different delivery paths.
