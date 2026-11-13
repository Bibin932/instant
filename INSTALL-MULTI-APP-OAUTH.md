# Multi-App / Multi-Page Meta Lead Ads → Existing CRM update

This is a targeted extension of the existing `faces.cybercodix.com` project. It adds a server-side Facebook Login OAuth flow so the Admin Panel can register multiple Meta Apps, authorize the Facebook accounts associated with each App, import their Pages and Instant Forms, and select which Page/Form combinations are polled into the existing CRM.

## What this update provides

- Register multiple Meta Apps from `/admin` using each App's name, App ID and App Secret.
- Validate each App ID/App Secret pair against Meta before storing it.
- Show the exact OAuth callback URL to add to each Meta App.
- Start a separate Facebook OAuth consent flow for each registered App.
- Import Pages available to the authorizing Facebook user for that App; the same Page can be represented under more than one App.
- Discover Instant Forms for every imported Page.
- Enable/pause a Page and enable/pause each ACTIVE Form from `/admin`.
- Display aggregate and per-Page/per-Form received, sent, retrying and failed counts.
- Continue sending all enabled lead forms through the existing `meta-lead-sync` CRM payload and endpoint. This update does not add a new CRM endpoint or change the CRM/WACRM application.
- Encrypt the App registry and Page-token registry at rest with AES-256-GCM.

The poller checks enabled forms on its configured interval (60 seconds by default). This build uses polling; it does **not** automatically add each App's Webhooks product or subscribe a Page to the `leadgen` webhook field.

## Files in this update

Copy these files into the existing repository, keeping the same paths:

- `server.js`
- `public/admin.html`
- `meta-lead-sync/lead-sync.js`
- `tests/meta-security.test.js`
- `INSTALL-MULTI-APP-OAUTH.md`
- `meta-lead-sync/README.md`

Merge the ignore entries from the included `.gitignore` into the project's existing `.gitignore`. Do not remove any existing ignore patterns.

No `package.json`, `package-lock.json`, `.env`, `meta-lead-sync/.env`, systemd unit, Nginx configuration, CRM/WACRM source, or runtime data is included. Do not replace those files.

## Safe deployment on the current VPS

### 1. Back up the working files and runtime data first

Run this on the VPS before deploying the source update:

```bash
cd /www/wwwroot/faces.cybercodix.com/instant
umask 077
BACKUP="/root/meta-multi-app-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP/public" "$BACKUP/meta-lead-sync" "$BACKUP/meta-lead-sync-data"
cp server.js "$BACKUP/server.js"
cp public/admin.html "$BACKUP/public/admin.html"
cp meta-lead-sync/lead-sync.js "$BACKUP/meta-lead-sync/lead-sync.js"
[ ! -f .env ] || cp .env "$BACKUP/root.env"
[ ! -f meta-lead-sync/.env ] || cp meta-lead-sync/.env "$BACKUP/meta-lead-sync/service.env"
for f in state.json connections.json apps.json secret.key; do
  [ ! -f "meta-lead-sync/data/$f" ] || cp "meta-lead-sync/data/$f" "$BACKUP/meta-lead-sync-data/$f"
done
echo "Backup saved to: $BACKUP"
```

Do not put the backup directory into Git or a public web directory. It contains credentials and/or lead-system state.

### 2. Deploy the source files

Push/deploy the files listed above to the same existing project paths. Do not upload or overwrite either `.env` file. Do not delete or replace `meta-lead-sync/data/state.json` or `connections.json`.

### 3. Confirm the HTTPS base URL

The existing root `.env` must contain:

```env
PUBLIC_BASE_URL=https://faces.cybercodix.com
```

Do not create duplicate `PUBLIC_BASE_URL` entries. The Meta Sync service reads the root `.env` as well as its local `.env`.

### 4. Run checks before restarting

```bash
cd /www/wwwroot/faces.cybercodix.com/instant
node --check server.js
node --check meta-lead-sync/lead-sync.js
node --test tests/meta-security.test.js
```

The package was checked locally with these same syntax/unit-test commands. The browser JavaScript embedded in `public/admin.html` was also extracted and passed `node --check`.

### 5. Restart the two existing services

Only after the checks pass:

```bash
systemctl restart faces-meta-bridge
systemctl restart meta-lead-sync
systemctl status faces-meta-bridge meta-lead-sync --no-pager
curl -sS http://127.0.0.1:3111/health
journalctl -u meta-lead-sync -n 40 --no-pager
```

The Meta Lead Sync service must remain bound to `127.0.0.1:3111`; do not expose port 3111 publicly. The existing public Admin server remains on the current port 3100 behind the existing Nginx configuration.

### 6. First startup storage migration

On startup, the new version creates `meta-lead-sync/data/secret.key` if one does not already exist. It then encrypts the existing plaintext `connections.json` registry when it reads and saves it. The App registry is also encrypted when first created or migrated.

Keep these files together and backed up securely:

- `meta-lead-sync/data/secret.key`
- `meta-lead-sync/data/connections.json`
- `meta-lead-sync/data/apps.json`
- `meta-lead-sync/data/state.json`

The service intentionally stops rather than creating a replacement key if encrypted data exists and `secret.key` is missing. Restore the matching key from backup; do not delete the encrypted files or generate a new key to try to fix it.

### 7. Configure each Meta App

For **each** Meta App you intend to connect:

1. Open that App in Meta for Developers.
2. Add/configure the Facebook Login product/use case that supports web OAuth.
3. Enable Client OAuth Login and Web OAuth Login if those controls are shown for that App.
4. In Valid OAuth Redirect URIs, add the exact callback displayed inside the Admin Panel. For this domain it should be:

   `https://faces.cybercodix.com/admin/meta/oauth/callback`

5. Ensure the App has the requested lead permissions available and approved for the people/Pages that will use it. This integration requests `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, and `ads_management`.
6. For production use with people who are not App roles, complete the Meta app mode, review and Advanced Access requirements that Meta applies to those permissions. Development-mode Apps generally have restrictions to App-role users/testers.

Meta's current Webhooks for Leads documentation identifies `leads_retrieval`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement` and `ads_management` for the webhook installation path, and specifies a Page token from a person with the Page's ADVERTISE task. This package polls instead of configuring webhooks, so it does not request `pages_manage_metadata` or subscribe `leadgen` on each Page. Actual access still depends on Meta approval and the authorizing person's Page/lead access.

### 8. Connect Apps and choose Pages/Forms from Admin

1. Open `https://faces.cybercodix.com/admin` and authenticate with the existing Admin credentials.
2. Under **Meta Apps · OAuth Connections**, enter the App display name, App ID and App Secret; click **Save Meta App**. The service validates the credential pair with Meta.
3. Click **Connect Facebook Pages** beside that App.
4. Sign in to Facebook and approve the requested permissions. The service exchanges the OAuth code server-side, verifies granted permissions, and imports Pages the user can access for that App.
5. The imported Page connections appear under Accounts & Forms. Newly imported Pages and Forms are paused by default.
6. Enable the required Page, then enable only the required Forms whose Meta status is `ACTIVE`.
7. Repeat for each Meta App. Every App uses the same existing CRM URL and field/payload mapping.

An authorized user may see more than one Page in Meta's consent/import result. Unwanted Pages can remain paused or be disconnected from the Admin Panel.

## Important operation notes

- Polling interval is `POLL_INTERVAL_SECONDS` (default 60 seconds; minimum 30 seconds in this build).
- A Page token is stored against the App that issued it. Graph calls use that App's secret to calculate `appsecret_proof`.
- A Page that is not returned by `/me/accounts` usually means the Facebook user has not been granted sufficient Page access, the App lacks permission access, or Meta has restricted the App/permission. Give the authorizing person the necessary Page/lead access and retry OAuth.
- Only ACTIVE Forms can be enabled.
- This update uses one existing CRM configuration/mapping for every connected App/Page/Form. Per-client different CRM endpoints, assignees or payload maps are not part of this patch.
- The old webhook bridge and this poller are separate delivery paths. Their dashboard counts remain separate. If a Page/Form is already sending the same leads through the old webhook bridge, do not also route that same form through polling unless the CRM enforces a shared deduplication key. The poller deduplicates within its own state; it cannot coordinate a transaction with the separate webhook queue.
- The OAuth callback and polling process do not expose App Secrets or Page tokens in the dashboard JSON responses.

## Security checks in this package

The automated tests cover:

1. App ID, App Secret and App display-name input validation.
2. App summaries do not expose App Secrets.
3. The OAuth callback URI must be HTTPS and is fixed to the configured origin.
4. OAuth state uses 32 cryptographically random bytes, expires after 10 minutes, and is consumed once.
5. The OAuth URL is restricted to Meta's HTTPS authorization host and requests only the listed permissions.
6. The same Page connected through two Apps has separate connection identifiers.
7. Page summaries do not expose Page tokens.
8. The local management listener binds to loopback, and the Admin callback checks a state cookie using a constant-time comparison.
9. Registry files use restrictive file modes and secrets remain server-side.
10. App secrets/Page tokens are encrypted with authenticated AES-256-GCM; ciphertext tampering and wrong-purpose decryption are rejected.

The Admin server additionally applies a 10-failed-login / 15-minute temporary IP block, same-origin checks to state-changing Admin API routes, HttpOnly/Secure/SameSite=Lax OAuth state cookies, fixed Meta/Graph HTTPS hosts, and server-side OAuth code exchange. The existing Admin uses inline JavaScript and retains its prior Content-Security-Policy configuration; strict CSP is not added by this patch.

## Test results and limits

The included suite currently passes **10/10 automated tests**. Both Node files pass `node --check`, and the inline dashboard JavaScript passes a separate syntax check. These are local code/security tests only: I cannot run a live Facebook authorization, App Review, real Page access check, or a new CRM submission without your Meta App credentials, a Facebook login session and access to your VPS. After deployment, complete one live OAuth connection and one controlled test lead, then confirm the CRM receives it once.

## Rollback

If a service does not start after deployment, restore the three backed-up source files (`server.js`, `public/admin.html`, `meta-lead-sync/lead-sync.js`) and restart the matching service(s). Preserve the data files and `secret.key`. If the new encrypted registries have already been written, the old code may not understand them; in that case, restore the matching pre-deployment copies of `connections.json` and any new `apps.json`/`secret.key` from the same backup set as well. Do not mix an encrypted registry with a different key.

**Legacy configuration note:** The original root `.env` is intentionally not rewritten by this patch. If it still contains `META_APP_SECRET` for the legacy webhook bridge, that pre-existing value remains in `.env` and relies on the file's existing restrictive permissions; the new multi-App registry and Page-token registry use AES-256-GCM encryption. Do not remove the legacy variable unless you have separately migrated/retired the old webhook bridge.
