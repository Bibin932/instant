# Meta Lead Sync — Multi-App OAuth

This service polls enabled Instant Forms from multiple Facebook Pages connected through multiple Meta Apps. Its local management API listens only on `127.0.0.1:3111` and is proxied through the existing authenticated Admin server.

## Admin-driven setup

- Register each Meta App from `/admin` with its display name, App ID and App Secret.
- Add the Admin Panel callback URL to that Meta App's Valid OAuth Redirect URIs.
- Use **Connect Facebook Pages** to start Facebook OAuth for that specific App.
- Pages available to the authorizing Facebook user are imported; the service discovers each Page's ACTIVE/INACTIVE forms.
- New Pages and Forms begin paused. Enable the Page and only the ACTIVE Forms to send their leads to the existing CRM.

The service requests `leads_retrieval`, `pages_show_list`, `pages_read_engagement` and `ads_management`. Meta permissions, App Review/Advanced Access, App mode and Page access/lead access must be approved by Meta and the Page owner. This implementation polls; it does not set up or subscribe Meta Webhooks for each App.

## CRM behavior

All connected Apps, Pages and Forms share the current CRM endpoint, payload mode and field mapping in the existing service `.env`. No CRM/WACRM source is changed by this update. The poller uses a 60-second default interval and the existing persistent lead state to avoid resending leads already marked `sent`.

## Encrypted runtime data

On first start this version creates `data/secret.key` (32 random bytes, mode `0600`). It encrypts `data/apps.json` (App Secrets) and `data/connections.json` (Page Access Tokens) using AES-256-GCM. `data/` is mode `0700`; encrypted files and the key are mode `0600`. Existing plaintext `connections.json` is migrated on startup. `data/state.json` remains a separate protected status/history file.

Back up `secret.key`, `apps.json`, `connections.json` and `state.json` together. Never commit them. Losing `secret.key` makes the encrypted App registry and Page-token registry unreadable; the service stops rather than silently replacing it.

## Live validation

Local syntax and security tests do not replace a real Meta test. After setup, authorize one App, enable one Page and one ACTIVE Form, submit a controlled lead, and verify one CRM record. Avoid routing the same Page/Form through both the legacy webhook bridge and this polling service unless cross-path CRM deduplication is enabled.

The old root `.env` is deliberately left unchanged for the independent legacy webhook bridge. If it contains `META_APP_SECRET`, it remains subject to the root `.env` file permissions; this new AES-GCM registry encryption applies to the multi-App registry and dashboard-managed Page-token connections.
