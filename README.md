# Multi-Page Meta Admin update

This is a **targeted update** for the currently working `faces.cybercodix.com` project. It adds Page/form management to the existing `/admin` without replacing the CRM API contract or the existing webhook routes.

## Files included

Replace only these files in the existing repository:

- `server.js` — adds authenticated `/admin/api/meta/*` proxy routes. Existing webhook and retry routes are retained.
- `public/admin.html` — adds the Meta Lead Sync accounts/forms panel to the existing admin page; existing webhook summary and recent-lead table are retained.
- `meta-lead-sync/lead-sync.js` — adds multi-Page polling and a localhost-only management API on the existing health port (`127.0.0.1:3111`). Existing lead mapping, CRM endpoint, dry-run behavior, retry timing, and `state.json` processing are retained.
- `.gitignore` — excludes the Page-token registry and polling runtime data from Git.
- `meta-lead-sync/README.md` — adds operation notes.

No `package.json`, dependency, Nginx, PM2, systemd unit, `.env`, `meta-lead-sync/.env`, or runtime data file is included in this update.

## What the new panel does

- Lists connected Facebook Pages by Page name and ID.
- Shows connection status and last check time.
- Lists each Page's Instant Forms and Meta form status.
- Lets the admin refresh forms, pause/enable a Page, pause/enable each ACTIVE form, and disconnect a Page.
- Shows total processed leads, delivered leads, retries/failures, and per-Page/per-form counts from the poller's existing `data/state.json`.
- Lets an admin connect another Page by pasting its **Page Access Token**. The server validates the token and discovers the Page's forms.
- New Pages and newly discovered forms are paused by default. The existing configured Page's current all-forms behavior is preserved during the first migration.
- Page tokens are stored server-side in `meta-lead-sync/data/connections.json` with mode `0600`; the token is never returned to the browser. The management API binds only to `127.0.0.1` and is proxied through the existing Basic-Auth-protected `/admin`.

## Safety: deploy without replacing runtime data

1. Push the included source files to GitHub. Do not add `.env` or any `data/*.json` files.
2. After deployment reaches the VPS, make a backup before restarting either service:

   ```bash
   cd /www/wwwroot/faces.cybercodix.com/instant
   umask 077
   BACKUP="/root/meta-admin-backup-$(date +%Y%m%d-%H%M%S)"
   mkdir -p "$BACKUP/public" "$BACKUP/meta-lead-sync"
   cp server.js "$BACKUP/server.js"
   cp public/admin.html "$BACKUP/public/admin.html"
   cp meta-lead-sync/lead-sync.js "$BACKUP/meta-lead-sync/lead-sync.js"
   [ ! -f meta-lead-sync/data/state.json ] || cp meta-lead-sync/data/state.json "$BACKUP/meta-lead-sync/state.json"
   [ ! -f meta-lead-sync/data/connections.json ] || cp meta-lead-sync/data/connections.json "$BACKUP/meta-lead-sync/connections.json"
   echo "Backup saved to: $BACKUP"
   ```

3. Check syntax before restarting:

   ```bash
   cd /www/wwwroot/faces.cybercodix.com/instant
   node --check server.js
   node --check meta-lead-sync/lead-sync.js
   ```

4. Restart only the two existing services so the new admin routes and polling manager are loaded:

   ```bash
   systemctl restart faces-meta-bridge
   systemctl restart meta-lead-sync
   ```

   Do not change the Nginx vhost, port 3100/3111, the CRM endpoint, or WACRM.

5. Verify both services and the local management health endpoint:

   ```bash
   systemctl status faces-meta-bridge meta-lead-sync --no-pager
   curl -sS http://127.0.0.1:3111/health
   journalctl -u meta-lead-sync -n 30 --no-pager
   ```

6. Open `https://faces.cybercodix.com/admin` and refresh. The existing webhook cards remain at the top; the new polling/Page/form panel appears below the integration configuration.

## First-start migration and existing lead history

- On the first start, if `meta-lead-sync/data/connections.json` does not exist, the poller migrates the current `META_PAGE_ID` / `META_PAGE_TOKENS_JSON` configuration from the existing parent `.env` into that protected file.
- The existing configured Page is enabled and its currently discovered forms are enabled, preserving the current polling behavior.
- `meta-lead-sync/data/state.json` is read and updated in place. **Do not delete, replace, or commit it.**
- New Pages connected from the dashboard are added with forms paused. Enable only the forms you intend to route to the CRM.
- Disconnecting a Page removes its saved Page token and stops polling it, but does not delete its processed-lead history.

## Rollback

If any issue appears, restore the three backed-up code files (`server.js`, `public/admin.html`, and `meta-lead-sync/lead-sync.js`) from the backup directory and restart the same two services. Do not delete `meta-lead-sync/data/state.json` or `connections.json`; the old single-Page code ignores `connections.json` and continues using the original parent `.env` Page token configuration.

## Important operational note

The existing webhook bridge and the polling sync are separate delivery paths. Their dashboard counts are shown separately rather than added together. If both paths are active for the same Page/form and both are configured to send to the same CRM, they can create duplicate CRM entries unless the CRM enforces a shared idempotency/deduplication key. Keep only one delivery path active for a given Page/form unless you have confirmed cross-path deduplication.
