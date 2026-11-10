'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const app = express();
app.set('trust proxy', env('TRUST_PROXY', '1'));
app.use(helmet({ contentSecurityPolicy: false }));
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ADMIN_FILE = path.join(ROOT, 'public', 'admin.html');

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function parseJsonEnv(name, fallback = {}) {
  const raw = env(name, JSON.stringify(fallback));
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
}

function timingSafeStringEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function initialState() {
  return { jobs: [], updatedAt: new Date().toISOString() };
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.jobs)) return initialState();
    return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Could not read state file; starting with empty state:', error.message);
    }
    return initialState();
  }
}

let state = loadState();
let saveChain = Promise.resolve();
let workerRunning = false;

function saveState() {
  state.updatedAt = new Date().toISOString();
  const snapshot = JSON.stringify(state, null, 2);
  const temp = `${STATE_FILE}.tmp`;
  saveChain = saveChain.catch(() => {}).then(async () => {
    await fs.promises.writeFile(temp, snapshot, { mode: 0o600 });
    await fs.promises.rename(temp, STATE_FILE);
  });
  return saveChain;
}

function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Meta CRM Bridge Admin"');
    return res.status(401).send('Authentication required');
  }

  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    res.setHeader('WWW-Authenticate', 'Basic realm="Meta CRM Bridge Admin"');
    return res.status(401).send('Invalid authentication');
  }

  const separator = decoded.indexOf(':');
  const username = separator >= 0 ? decoded.slice(0, separator) : '';
  const password = separator >= 0 ? decoded.slice(separator + 1) : '';
  const expectedUser = env('ADMIN_USERNAME', 'admin');
  const expectedPassword = env('ADMIN_PASSWORD');

  if (!expectedPassword || !timingSafeStringEqual(username, expectedUser) || !timingSafeStringEqual(password, expectedPassword)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Meta CRM Bridge Admin"');
    return res.status(401).send('Invalid username or password');
  }
  return next();
}

function verifyMetaSignature(rawBody, signatureHeader) {
  const appSecret = env('META_APP_SECRET');
  if (!appSecret || !signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  let supplied;
  try {
    supplied = Buffer.from(signatureHeader.slice(7), 'hex');
  } catch {
    return false;
  }
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function normaliseKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fieldMapFromData(fieldData) {
  const result = {};
  for (const field of Array.isArray(fieldData) ? fieldData : []) {
    const key = normaliseKey(field.name);
    if (!key) continue;
    const values = Array.isArray(field.values) ? field.values : [];
    result[key] = values.length > 1 ? values.join(', ') : (values[0] ?? '');
  }
  return result;
}

const DEFAULT_ALIASES = {
  fullName: ['full_name', 'name', 'your_name', 'student_name', 'full name'],
  firstName: ['first_name', 'firstname'],
  lastName: ['last_name', 'lastname', 'surname'],
  email: ['email', 'email_address', 'e_mail'],
  phone: ['phone_number', 'phone', 'mobile_number', 'mobile', 'contact_number'],
  waNumber: ['whatsapp_number', 'wa_number', 'whatsapp', 'phone_number', 'phone', 'mobile_number', 'mobile'],
  interestedCourse: ['interested_course', 'course_interested', 'course_interest', 'course', 'course_name', 'degree', 'interestedcourse'],
  remarks: ['remarks', 'specialization', 'specialisation', 'program', 'programme', 'course_details', 'subject', 'stream'],
  preferredLanguage: ['preferred_language', 'prefered_language', 'language'],
};

function getField(index, aliases) {
  for (const alias of aliases) {
    const key = normaliseKey(alias);
    if (Object.prototype.hasOwnProperty.call(index, key) && index[key] !== '') {
      return String(index[key]);
    }
  }
  return '';
}

async function graphGet(pathPart, token, fields) {
  const version = env('META_GRAPH_VERSION', 'v27.0');
  const url = new URL(`https://graph.facebook.com/${version}/${pathPart}`);
  if (fields) url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', token);

  const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 1000) }; }
  if (!response.ok) {
    const message = body?.error?.message || `Meta Graph API returned HTTP ${response.status}`;
    const code = body?.error?.code ? ` (code ${body.error.code})` : '';
    throw new Error(`Meta lead retrieval failed: ${message}${code}`);
  }
  return body;
}

function pageTokenFor(pageId) {
  const tokens = parseJsonEnv('META_PAGE_TOKENS_JSON', {});
  return (pageId && tokens[pageId]) || env('META_PAGE_ACCESS_TOKEN');
}

async function getCampaignName(adId, token) {
  if (!adId) return env('CRM_CAMPAIGN_NAME_DEFAULT', 'Meta Lead Ads');
  try {
    const ad = await graphGet(adId, token, 'name,campaign{name}');
    return ad?.campaign?.name || env('CRM_CAMPAIGN_NAME_DEFAULT', 'Meta Lead Ads');
  } catch (error) {
    console.warn(`Could not retrieve campaign for ad ${adId}: ${error.message}`);
    return env('CRM_CAMPAIGN_NAME_DEFAULT', 'Meta Lead Ads');
  }
}

function buildCrmRecord(metaLead, campaignName) {
  const index = fieldMapFromData(metaLead.field_data);
  const customAliases = parseJsonEnv('META_FIELD_ALIASES_JSON', {});
  const aliases = { ...DEFAULT_ALIASES, ...customAliases };

  const fullName = getField(index, aliases.fullName || DEFAULT_ALIASES.fullName);
  const first = getField(index, aliases.firstName || DEFAULT_ALIASES.firstName);
  const last = getField(index, aliases.lastName || DEFAULT_ALIASES.lastName);
  const phone = getField(index, aliases.phone || DEFAULT_ALIASES.phone);
  const whatsapp = getField(index, aliases.waNumber || DEFAULT_ALIASES.waNumber) || phone;
  const explicitCourse = getField(index, aliases.interestedCourse || DEFAULT_ALIASES.interestedCourse);
  const remarks = getField(index, aliases.remarks || DEFAULT_ALIASES.remarks);
  const language = getField(index, aliases.preferredLanguage || DEFAULT_ALIASES.preferredLanguage);

  // Meta forms often expose one full_name field. The supplied CRM example puts
  // that full name in both firstName and lastName, so mirror that convention
  // unless the Meta form provides separate first_name and last_name values.
  const firstName = first || fullName || '';
  const lastName = last || fullName || '';

  return {
    firstName,
    lastName,
    email: getField(index, aliases.email || DEFAULT_ALIASES.email),
    phone,
    interestedCourse: explicitCourse,
    remarks,
    assignedTo: env('CRM_ASSIGNED_TO', '1572c311-936b-42d3-a829-67041840d5b4'),
    campainName: campaignName || env('CRM_CAMPAIGN_NAME_DEFAULT', 'Meta Lead Ads'),
    waNumber: whatsapp,
    formType: env('CRM_FORM_TYPE', 'LANGUAGE'),
    preferedLanguage: language || env('CRM_PREFERRED_LANGUAGE', 'English'),
    hideLead: env('CRM_HIDE_LEAD', 'false').toLowerCase() === 'true',
  };
}

function buildCrmHeaders() {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const apiKey = env('CRM_API_KEY');
  if (apiKey) {
    const headerName = env('CRM_AUTH_HEADER', 'x-api-key');
    const prefix = env('CRM_AUTH_PREFIX');
    headers[headerName] = `${prefix ? `${prefix.trim()} ` : ''}${apiKey}`;
  }
  const extra = parseJsonEnv('CRM_EXTRA_HEADERS_JSON', {});
  for (const [key, value] of Object.entries(extra)) headers[key] = String(value);
  return headers;
}

async function pushToCrm(record, leadId) {
  const endpoint = env('CRM_API_URL');
  if (!endpoint) throw new Error('CRM_API_URL is not configured');
  if (!env('CRM_API_KEY')) throw new Error('CRM_API_KEY is not configured');

  const payload = {
    tableName: env('CRM_TABLE_NAME', 'OnlineLeads-qr2mdczhwfhc7nmmkiafsfjlui-prod'),
    data: [record],
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: buildCrmHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25000),
  });
  const responseText = await response.text();
  let responseBody = responseText;
  try { responseBody = JSON.parse(responseText); } catch { /* preserve text */ }

  if (!response.ok) {
    const detail = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
    throw new Error(`CRM API returned HTTP ${response.status}: ${detail.slice(0, 1000)}`);
  }
  return { status: response.status, body: responseBody };
}

async function processJob(job) {
  const token = pageTokenFor(job.pageId);
  if (!token) throw new Error(`No Page Access Token configured for Page ID ${job.pageId || '(missing)'}`);
  if (!env('META_APP_SECRET')) throw new Error('META_APP_SECRET is not configured');
  if (!env('CRM_API_KEY')) throw new Error('CRM_API_KEY is not configured');

  const metaLead = await graphGet(job.leadId, token, 'id,created_time,form_id,ad_id,field_data');
  const campaignName = await getCampaignName(metaLead.ad_id || job.adId, token);
  const record = buildCrmRecord(metaLead, campaignName);
  const crmResult = await pushToCrm(record, job.leadId);

  job.status = 'synced';
  job.syncedAt = new Date().toISOString();
  job.crmHttpStatus = crmResult.status;
  job.crmResponse = typeof crmResult.body === 'string'
    ? crmResult.body.slice(0, 500)
    : JSON.stringify(crmResult.body).slice(0, 500);
  job.name = `${record.firstName} ${record.lastName}`.trim();
  job.phone = record.phone;
  job.email = record.email;
  job.course = record.interestedCourse;
  job.campaign = record.campainName;
  job.lastError = '';
  await saveState();
}

function retryDelay(attempt) {
  const base = Number(env('RETRY_BASE_DELAY_MS', '5000'));
  return Math.min(base * (2 ** Math.max(0, attempt - 1)), 15 * 60 * 1000);
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const now = Date.now();
    const job = state.jobs.find(item =>
      (item.status === 'queued' || item.status === 'retrying') &&
      (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now)
    );
    if (!job) return;

    job.status = 'processing';
    job.attempts = Number(job.attempts || 0) + 1;
    job.lastAttemptAt = new Date().toISOString();
    await saveState();

    try {
      await processJob(job);
      console.log(`Lead ${job.leadId} synced to CRM.`);
    } catch (error) {
      job.lastError = error.message;
      const maxRetries = Number(env('MAX_RETRIES', '8'));
      if (job.attempts >= maxRetries) {
        job.status = 'failed';
        job.nextAttemptAt = null;
      } else {
        job.status = 'retrying';
        job.nextAttemptAt = new Date(Date.now() + retryDelay(job.attempts)).toISOString();
      }
      await saveState();
      console.error(`Lead ${job.leadId} attempt ${job.attempts} failed: ${error.message}`);
    }
  } finally {
    workerRunning = false;
  }
}

function pruneOldJobs() {
  const days = Number(env('JOB_RETENTION_DAYS', '30'));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const before = state.jobs.length;
  state.jobs = state.jobs.filter(job => {
    const created = Date.parse(job.receivedAt || '') || Date.now();
    return created >= cutoff || (job.status !== 'synced' && job.status !== 'failed');
  });
  if (state.jobs.length !== before) saveState().catch(error => console.error('Could not save pruned job state:', error.message));
}

// Public health endpoint.
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'meta-crm-bridge', time: new Date().toISOString() });
});

// Meta's initial webhook verification (GET).
app.get('/webhooks/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && timingSafeStringEqual(token, env('META_VERIFY_TOKEN'))) {
    return res.status(200).type('text/plain').send(String(challenge || ''));
  }
  return res.sendStatus(403);
});

// Receive the raw request body so Meta's HMAC signature can be checked correctly.
app.post('/webhooks/meta', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body)) return res.status(400).send('Expected application/json');
  if (!verifyMetaSignature(req.body, req.get('x-hub-signature-256'))) {
    return res.status(401).send('Invalid Meta webhook signature or missing META_APP_SECRET');
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  const newJobs = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'leadgen') continue;
      const value = change.value || {};
      const leadId = String(value.leadgen_id || '');
      if (!leadId) continue;
      const alreadyKnown = state.jobs.some(job => job.leadId === leadId);
      if (alreadyKnown) continue;
      newJobs.push({
        leadId,
        pageId: String(value.page_id || entry.id || ''),
        formId: String(value.form_id || ''),
        adId: String(value.ad_id || ''),
        createdTime: value.created_time || null,
        receivedAt: new Date().toISOString(),
        status: 'queued',
        attempts: 0,
        nextAttemptAt: null,
        lastError: '',
      });
    }
  }

  state.jobs.push(...newJobs);
  try {
    await saveState();
  } catch (error) {
    console.error('Could not persist webhook jobs:', error.message);
    return res.status(500).send('Could not queue event');
  }

  // Return quickly after durable queueing; the worker delivers to the CRM separately.
  res.sendStatus(200);
});

app.use(express.json({ limit: '100kb' }));

app.get('/admin', adminAuth, (_req, res) => res.sendFile(ADMIN_FILE));
app.get('/admin/api/summary', adminAuth, (_req, res) => {
  const jobs = state.jobs;
  res.json({
    received: jobs.length,
    synced: jobs.filter(job => job.status === 'synced').length,
    pending: jobs.filter(job => ['queued', 'processing', 'retrying'].includes(job.status)).length,
    failed: jobs.filter(job => job.status === 'failed').length,
    lastReceivedAt: jobs.length ? jobs[jobs.length - 1].receivedAt : null,
    jobs: [...jobs].sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt))).slice(0, 100),
  });
});

app.post('/admin/api/retry/:leadId', adminAuth, async (req, res) => {
  const leadId = String(req.params.leadId || '');
  const job = state.jobs.find(item => item.leadId === leadId);
  if (!job) return res.status(404).json({ error: 'Lead not found in local queue' });
  if (job.status === 'synced') return res.status(409).json({ error: 'Lead is already synced' });
  job.status = 'queued';
  job.attempts = 0;
  job.nextAttemptAt = null;
  job.lastError = '';
  await saveState();
  return res.json({ ok: true, message: 'Lead queued for retry' });
});

app.get('/admin/api/config-check', adminAuth, (_req, res) => {
  const missing = [];
  for (const name of ['META_APP_SECRET', 'META_VERIFY_TOKEN', 'CRM_API_URL', 'CRM_API_KEY']) {
    if (!env(name)) missing.push(name);
  }
  let hasPageToken = Boolean(env('META_PAGE_ACCESS_TOKEN'));
  try { hasPageToken = hasPageToken || Object.keys(parseJsonEnv('META_PAGE_TOKENS_JSON', {})).length > 0; } catch { missing.push('META_PAGE_TOKENS_JSON (invalid JSON)'); }
  if (!hasPageToken) missing.push('META_PAGE_ACCESS_TOKEN or META_PAGE_TOKENS_JSON');
  res.json({
    ok: missing.length === 0,
    missing,
    webhookUrl: `${env('PUBLIC_BASE_URL', `http://localhost:${PORT}`).replace(/\/$/, '')}/webhooks/meta`,
    crmEndpointConfigured: Boolean(env('CRM_API_URL')),
    crmAuthHeader: env('CRM_AUTH_HEADER', 'x-api-key'),
    graphVersion: env('META_GRAPH_VERSION', 'v27.0'),
  });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

if (!env('ADMIN_PASSWORD') || env('ADMIN_PASSWORD') === 'CHANGE_THIS_ADMIN_PASSWORD') {
  console.error('ADMIN_PASSWORD is missing or unchanged. Run `npm run setup` and configure .env first.');
  process.exit(1);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Meta CRM bridge listening on port ${PORT}`);
  console.log(`Webhook callback: ${env('PUBLIC_BASE_URL', `http://localhost:${PORT}`).replace(/\/$/, '')}/webhooks/meta`);
  console.log('Admin dashboard: /admin (HTTP Basic Auth)');
});

setInterval(() => runWorker().catch(error => console.error('Queue worker error:', error.message)), 3000);
setInterval(pruneOldJobs, 60 * 60 * 1000);
runWorker().catch(error => console.error('Initial worker error:', error.message));
