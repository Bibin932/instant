# Meta Multi-App Admin Update

Targeted source update for the existing `faces.cybercodix.com` project. It adds multiple Meta App OAuth connections, automatic Page/Form discovery, Admin-controlled Page/Form selection, and encrypted credential storage while retaining the existing CRM delivery pipeline.

Read `INSTALL-MULTI-APP-OAUTH.md` before deploying. Back up the live code and runtime files first. Do not replace `.env`, CRM/WACRM code, `state.json`, or the existing systemd/Nginx configuration.

Automated security checks: `node --test tests/meta-security.test.js` (10 passing tests in the package validation run).
