# Self-hosted Meta Lead Ads → Online Leads API sync

This is a standalone Node.js polling service. It does not modify the existing `server.js`, webhook route, Nginx configuration, WACRM, or CRM application code.

## What it sends

It polls the configured Meta Page's lead forms and reads new lead records using the Page Access Token in the parent project's `.env` (`META_PAGE_TOKENS_JSON`). It then sends one lead per request to the configured CRM API.

The supplied CRM endpoint is configured as:

`POST https://likv34svlb.execute-api.ap-south-1.amazonaws.com/prod/create-online-leads`

The JSON body follows the example contract exactly:

```json
{
  "tableName": "OnlineLeads-qr2mdczhwfhc7nmmkiafsfjlui-prod",
  "data": [
    {
      "firstName": "Full name from Meta",
      "lastName": "Full name from Meta",
      "email": "email from Meta",
      "phone": "phone from Meta or empty string",
      "interestedCourse": "course answer or configured default",
      "remarks": "specialization/remarks answer or configured default",
      "assignedTo": "1572c311-936b-42d3-a829-67041840d5b4",
      "campainName": "campaign answer/configured value or empty string",
      "waNumber": "phone from Meta or empty string",
      "formType": "LANGUAGE",
      "preferedLanguage": "language answer/configured default or empty string",
      "hideLead": false
    }
  ]
}
```

The property spellings `campainName` and `preferedLanguage` intentionally match the API example, including their spelling. The entire Meta name is copied to both `firstName` and `lastName` by default because that is how the supplied CRM examples are shaped. Set `CRM_DUPLICATE_FULL_NAME_IN_FIRST_LAST=false` only if the CRM owner confirms the API expects the name split into first and last parts.

### Field mapping

- `full_name` / `name` → `firstName` and `lastName`
- `email` / `email_address` → `email`
- `phone_number`, `phone`, `mobile_number`, `mobile`, `telephone`, `wa_number`, `whatsapp_number` → `phone` and `waNumber`
- course/program form answers → `interestedCourse`
- remarks/specialization/course-detail/branch answers → `remarks`
- preferred-language/language form answers → `preferedLanguage`
- `assignedTo`, `formType`, `hideLead`, table name → configured values
- campaign answer or `CRM_CAMPAIGN_NAME` → `campainName`

If the Meta form does not ask for course, specialization, or language, those fields remain empty unless an explicit default is configured. The service does not invent student answers. The campaign name also remains empty unless captured in fields or configured; retrieving the true campaign name from the Ad object may require additional Meta Ads permissions and is not assumed here.

## Requirements

- Node.js 20+.
- `dotenv` available in the parent project.
- Parent `.env` contains a valid `META_PAGE_TOKENS_JSON` object keyed by Page ID.
- Meta permission/token must allow lead retrieval for the Page and form.
- CRM API accepts HTTPS POST with the `tableName` and `data` structure above.

## Install / update

Copy this folder to:

`/www/wwwroot/faces.cybercodix.com/instant/meta-lead-sync`

Then:

```bash
cd /www/wwwroot/faces.cybercodix.com/instant/meta-lead-sync
cp -n .env.example .env
chmod 600 .env
nano .env
```

The service reads the Page token from the existing parent `.env`; do not duplicate the token in this folder.

## Safe test first

Keep:

```env
DRY_RUN=true
SYNC_TEST_LEADS=true
```

The service will retrieve leads and log a sanitized preview of CRM field names/populated fields. It will not call the CRM while `DRY_RUN=true`.

The first run creates a timestamp baseline and ignores older leads unless `SYNC_HISTORICAL_LEADS=true`. Do not delete `data/state.json` after starting; it tracks processed lead IDs.

## Configure CRM

The `.env.example` includes the endpoint and table name supplied by the CRM owner. Review these settings:

- `CRM_API_URL`: supplied AWS API Gateway endpoint.
- `CRM_API_METHOD=POST`.
- `CRM_PAYLOAD_MODE=online_leads`.
- `CRM_TABLE_NAME`: supplied table name.
- `CRM_ASSIGNED_TO`: supplied assignment UUID.
- `CRM_FORM_TYPE=LANGUAGE`: supplied form type.
- `CRM_CAMPAIGN_NAME`, `CRM_DEFAULT_LANGUAGE`, `CRM_DEFAULT_COURSE`, `CRM_DEFAULT_REMARKS`: optional defaults. Leave blank unless correct for this form.
- `CRM_BEARER_TOKEN` / `CRM_HEADERS_JSON`: optional. The supplied sample did not specify authentication; confirm with the API owner before adding credentials if the API returns 401/403.

The service sends `Idempotency-Key: meta-lead-{lead_id}`. Its local state also prevents normal repeat sends. Confirm the CRM accepts this header or uses its own duplicate rule; a local service cannot fully guarantee exactly-once insertion if the remote API commits a request but the network drops before the response arrives.

## Go live only after mapping review

Before enabling CRM writes:

1. Confirm the API owner accepts blank optional `phone`, course, remarks, campaign, or language values when a form does not collect them.
2. Confirm whether `firstName` and `lastName` should both contain the full name (the provided examples do) or should be split.
3. Confirm that the assigned user UUID and `formType=LANGUAGE` are correct for this Page/form.
4. Confirm the endpoint's authentication requirements. No auth header was shown in the supplied example.
5. Set `SYNC_TEST_LEADS=false` so Meta sample leads are never delivered to the live CRM.
6. Set `DRY_RUN=false` and restart the service.

```bash
systemctl restart meta-lead-sync
journalctl -u meta-lead-sync -f
```

## Health / logs

```bash
curl -sS http://127.0.0.1:3111/health
journalctl -u meta-lead-sync -n 50 --no-pager
```

The health endpoint is bound to localhost only. Logs omit personal lead values.

## Important Meta access note

Self-hosting removes third-party automation subscriptions but does not bypass Meta permissions, token expiry, app review, or production access restrictions for `leads_retrieval`.
