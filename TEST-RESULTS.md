# Local validation results

Run against the delivered source files:

- `node --check server.js` — passed
- `node --check meta-lead-sync/lead-sync.js` — passed
- Extracted inline JavaScript from `public/admin.html`, then `node --check` — passed
- `node --test tests/meta-security.test.js` — **10 passed, 0 failed**

The test suite includes App credential validation, public-secret non-disclosure, HTTPS redirect URI validation, random one-time OAuth state, allowed OAuth host/scopes, independent Page/App connection identifiers, Page-token non-disclosure, loopback-only management API, state-cookie protections, permission modes, AES-256-GCM encryption, wrong-purpose rejection and ciphertext-tamper rejection.

Not tested from this workspace: a real Meta OAuth consent/token exchange, Meta App Review/Advanced Access, live Page/Form visibility, live polling from a customer Page, or a new CRM API write. Those require credentials and access to the user's Meta Apps, Page accounts and VPS.
