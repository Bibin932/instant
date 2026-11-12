'use strict';

/**
 * Self-hosted Meta Lead Ads -> CRM polling bridge.
 * Runs independently from the existing webhook/CRM application.
 * Node.js 20+; uses the built-in fetch API and the existing dotenv dependency.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const dotenv = require('dotenv');

const ROOT_DIR = path.resolve(__dirname, '..');
const LOCAL_ENV = path.join(__dirname, '.env');
const ROOT_ENV = path.join(ROOT_DIR, '.env');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// Local settings are loaded first; existing project .env supplies the Page token.
dotenv.config({ path: LOCAL_ENV });
dotenv.config({ path: ROOT_ENV });

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function envInt(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
}

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing required setting: ${name}`);
  return value.trim();
}

const CONFIG = {
  pageId: required('META_PAGE_ID'),
  graphVersion: process.env.META_GRAPH_VERSION || 'v27.0',
  pollSeconds: envInt('POLL_INTERVAL_SECONDS', 60, 30, 3600),
  maxPagesPerForm: envInt('MAX_PAGES_PER_FORM', 10, 1, 100),
  historical: envBool('SYNC_HISTORICAL_LEADS', false),
  includeTestLeads: envBool('SYNC_TEST_LEADS', false),
  dryRun: envBool('DRY_RUN', true),
  healthPort: envInt('HEALTH_PORT', 3111, 0, 65535),
  crmUrl: process.env.CRM_API_URL || '',
  crmMethod: (process.env.CRM_API_METHOD || 'POST').toUpperCase(),
  crmBearerToken: process.env.CRM_BEARER_TOKEN || '',
  crmHeaders: parseJsonEnv('CRM_HEADERS_JSON', {}),
  crmFieldMap: parseJsonEnv('CRM_FIELD_MAP_JSON', {}),
  crmStaticFields: parseJsonEnv('CRM_STATIC_FIELDS_JSON', {}),
  crmTimeoutMs: envInt('CRM_TIMEOUT_MS', 20000, 1000, 120000),
};

let pageToken;
try {
  const tokens = JSON.parse(process.env.META_PAGE_TOKENS_JSON || '{}');
  pageToken = process.env.META_PAGE_ACCESS_TOKEN || tokens[CONFIG.pageId];
} catch {
  throw new Error('META_PAGE_TOKENS_JSON in the existing project .env is not valid JSON');
}
if (!pageToken) {
  throw new Error(`No Page token found for ${CONFIG.pageId}. Check META_PAGE_TOKENS_JSON in ${ROOT_ENV}`);
}
if (!CONFIG.dryRun && !CONFIG.crmUrl) {
  throw new Error('CRM_API_URL is required when DRY_RUN=false');
}
if (!/^https:\/\//i.test(CONFIG.crmUrl) && !CONFIG.dryRun) {
  throw new Error('CRM_API_URL must use HTTPS');
}
if (!['POST', 'PUT', 'PATCH'].includes(CONFIG.crmMethod)) {
  throw new Error('CRM_API_METHOD must be POST, PUT, or PATCH');
}
if (!CONFIG.crmHeaders || Array.isArray(CONFIG.crmHeaders) || typeof CONFIG.crmHeaders !== 'object') {
  throw new Error('CRM_HEADERS_JSON must be a JSON object');
}
if (!CONFIG.crmFieldMap || Array.isArray(CONFIG.crmFieldMap) || typeof CONFIG.crmFieldMap !== 'object') {
  throw new Error('CRM_FIELD_MAP_JSON must be a JSON object');
}

let state = null;
let pollInProgress = false;
let lastPollAt = null;
let lastPollError = null;
let counters = { forms: 0, leadsSeen: 0, sent: 0, failed: 0, ignored: 0 };

function log(level, message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : '';
  process.stdout.write(`${new Date().toISOString()} [${level}] ${message}${suffix}\n`);
}

async function saveState() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const temp = `${STATE_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(temp, STATE_FILE);
}

async function loadState() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.leads) throw new Error('invalid state structure');
    state = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Cannot read ${STATE_FILE}: ${error.message}. Back up and inspect this file before restarting.`);
    }
    state = {
      version: 1,
      created_at: new Date().toISOString(),
      baseline_unix: Math.floor(Date.now() / 1000),
      leads: {},
    };
    await saveState();
    log('INFO', 'Created first-run baseline. Existing leads will not be imported unless SYNC_HISTORICAL_LEADS=true.');
  }
}

function graphUrl(pathOrUrl, params = {}) {
  const url = pathOrUrl instanceof URL
    ? new URL(pathOrUrl.toString())
    : new URL(`https://graph.facebook.com/${CONFIG.graphVersion}/${String(pathOrUrl).replace(/^\/+/, '')}`);
  if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com') {
    throw new Error('Rejected unexpected Meta pagination URL');
  }
  if (!(pathOrUrl instanceof URL)) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  url.searchParams.set('access_token', pageToken);
  return url;
}

async function graphGet(pathOrUrl, params = {}) {
  const url = graphUrl(pathOrUrl, params);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.error) {
        const metaError = body.error || {};
        const message = metaError.message || `HTTP ${response.status}`;
        const retryable = response.status === 429 || response.status >= 500 || metaError.is_transient === true;
        const error = new Error(`Meta Graph API error (${response.status}${metaError.code ? ` / code ${metaError.code}` : ''}): ${message}`);
        error.retryable = retryable;
        throw error;
      }
      return body;
    } catch (error) {
      lastError = error;
      if (error.retryable === false || (error.retryable === undefined && attempt === 3)) break;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError;
}

function extractFields(fieldData) {
  const fields = {};
  for (const item of Array.isArray(fieldData) ? fieldData : []) {
    if (!item || !item.name) continue;
    const values = Array.isArray(item.values) ? item.values : [];
    fields[item.name] = values.length <= 1 ? (values[0] ?? '') : values;
  }
  return fields;
}

function firstValue(fields, names) {
  for (const name of names) {
    const value = fields[name];
    if (Array.isArray(value) && value.length) return value[0];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function isMetaTestLead(fields) {
  const name = String(firstValue(fields, ['full_name', 'name'])).toLowerCase();
  const email = String(firstValue(fields, ['email'])).toLowerCase();
  return name.includes('<test lead:') || email === 'test@meta.com';
}

function makeCanonicalPayload(lead) {
  const fields = extractFields(lead.field_data);
  const payload = {
    meta_lead_id: String(lead.id),
    source: 'facebook_lead_ads',
    page_id: CONFIG.pageId,
    form_id: lead.form_id || '',
    created_time: lead.created_time || '',
    full_name: firstValue(fields, ['full_name', 'name']),
    email: firstValue(fields, ['email']),
    phone_number: firstValue(fields, ['phone_number', 'phone', 'mobile_number', 'telephone']),
    fields,
    raw_field_data: Array.isArray(lead.field_data) ? lead.field_data : [],
  };
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) delete payload[key];
  }
  if (!Object.keys(CONFIG.crmFieldMap).length) return { ...CONFIG.crmStaticFields, ...payload };

  const mapped = { ...CONFIG.crmStaticFields };
  for (const [sourceKey, destinationKey] of Object.entries(CONFIG.crmFieldMap)) {
    if (typeof destinationKey !== 'string' || !destinationKey.trim()) continue;
    if (Object.prototype.hasOwnProperty.call(payload, sourceKey)) {
      mapped[destinationKey] = payload[sourceKey];
    }
  }
  return mapped;
}

async function sendToCrm(lead) {
  const payload = makeCanonicalPayload(lead);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Idempotency-Key': `meta-lead-${lead.id}`,
    ...CONFIG.crmHeaders,
  };
  if (CONFIG.crmBearerToken) headers.Authorization = `Bearer ${CONFIG.crmBearerToken}`;

  const response = await fetch(CONFIG.crmUrl, {
    method: CONFIG.crmMethod,
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(CONFIG.crmTimeoutMs),
  });
  if (!response.ok) {
    // Do not log response bodies: some CRM APIs echo submitted personal data.
    throw new Error(`CRM returned HTTP ${response.status} ${response.statusText}`.trim());
  }
  return response.status;
}

function retryDelayMs(attempts) {
  return Math.min(60 * 60 * 1000, 30000 * (2 ** Math.min(attempts - 1, 7)));
}

async function processLead(lead) {
  const id = String(lead.id || '');
  if (!id) return;
  counters.leadsSeen += 1;
  const existing = state.leads[id];
  if (existing?.status === 'sent' || existing?.status === 'ignored') return;
  if (CONFIG.dryRun && existing?.status === 'dry_run') return;
  if (existing?.next_retry_at && Date.now() < existing.next_retry_at) return;

  const createdUnix = lead.created_time ? Math.floor(new Date(lead.created_time).getTime() / 1000) : 0;
  if (!CONFIG.historical && createdUnix && createdUnix <= state.baseline_unix) {
    state.leads[id] = { status: 'ignored', reason: 'created_before_sync_baseline', updated_at: new Date().toISOString() };
    counters.ignored += 1;
    await saveState();
    return;
  }

  const fields = extractFields(lead.field_data);
  if (!CONFIG.includeTestLeads && isMetaTestLead(fields)) {
    state.leads[id] = { status: 'ignored', reason: 'meta_test_lead', updated_at: new Date().toISOString() };
    counters.ignored += 1;
    await saveState();
    log('INFO', 'Ignored Meta sample/test lead', { lead_id: id });
    return;
  }

  if (CONFIG.dryRun) {
    state.leads[id] = { status: 'dry_run', updated_at: new Date().toISOString() };
    await saveState();
    log('DRY-RUN', 'Lead found; CRM request not sent', {
      lead_id: id,
      form_id: lead.form_id || '',
      field_names: Object.keys(fields),
    });
    return;
  }

  const attempts = (existing?.attempts || 0) + 1;
  try {
    const status = await sendToCrm(lead);
    state.leads[id] = { status: 'sent', attempts, crm_http_status: status, sent_at: new Date().toISOString() };
    counters.sent += 1;
    await saveState();
    log('SUCCESS', 'Lead delivered to CRM', { lead_id: id, crm_http_status: status });
  } catch (error) {
    const delay = retryDelayMs(attempts);
    state.leads[id] = {
      status: 'retry',
      attempts,
      last_error: String(error.message).slice(0, 300),
      next_retry_at: Date.now() + delay,
      updated_at: new Date().toISOString(),
    };
    counters.failed += 1;
    await saveState();
    log('ERROR', 'CRM delivery failed; lead queued for retry', {
      lead_id: id,
      attempt: attempts,
      retry_in_seconds: Math.round(delay / 1000),
      error: String(error.message).slice(0, 180),
    });
  }
}

async function fetchAllForms() {
  const forms = [];
  let next = graphUrl(`${CONFIG.pageId}/leadgen_forms`, { fields: 'id,name,status', limit: 100 });
  let pages = 0;
  while (next && pages < 20) {
    const result = await graphGet(next);
    if (Array.isArray(result.data)) forms.push(...result.data);
    next = result.paging?.next ? new URL(result.paging.next) : null;
    pages += 1;
  }
  if (next) log('WARN', 'Stopped form pagination at safety limit (20 pages)');
  return forms;
}

async function pollForm(form) {
  let next = graphUrl(`${form.id}/leads`, {
    fields: 'id,created_time,field_data,form_id',
    limit: 100,
  });
  let pages = 0;
  while (next && pages < CONFIG.maxPagesPerForm) {
    const result = await graphGet(next);
    const leads = Array.isArray(result.data) ? result.data : [];
    for (const lead of leads) await processLead({ ...lead, form_id: lead.form_id || form.id });

    // In default mode, stop paging once this page is entirely older than the first-run baseline.
    if (!CONFIG.historical && leads.length > 0) {
      const allOlder = leads.every(lead => {
        if (!lead.created_time) return false;
        const unix = Math.floor(new Date(lead.created_time).getTime() / 1000);
        return unix > 0 && unix <= state.baseline_unix;
      });
      if (allOlder) break;
    }

    next = result.paging?.next ? new URL(result.paging.next) : null;
    pages += 1;
  }
  if (next && pages >= CONFIG.maxPagesPerForm) {
    log('WARN', 'Reached per-form pagination safety limit; remaining pages will be checked next cycle', { form_id: form.id });
  }
}

async function runPoll() {
  if (pollInProgress) return;
  pollInProgress = true;
  counters = { forms: 0, leadsSeen: 0, sent: 0, failed: 0, ignored: 0 };
  try {
    const forms = await fetchAllForms();
    counters.forms = forms.length;
    log('INFO', 'Polling Meta lead forms', { page_id: CONFIG.pageId, forms: forms.length });
    for (const form of forms) {
      if (!form?.id) continue;
      try {
        await pollForm(form);
      } catch (error) {
        log('ERROR', 'Could not poll form', { form_id: form.id, error: String(error.message).slice(0, 200) });
      }
    }
    lastPollAt = new Date().toISOString();
    lastPollError = null;
    log('INFO', 'Polling cycle finished', counters);
  } catch (error) {
    lastPollError = String(error.message).slice(0, 300);
    log('ERROR', 'Meta polling cycle failed', { error: lastPollError });
  } finally {
    pollInProgress = false;
  }
}

function startHealthServer() {
  if (!CONFIG.healthPort) return;
  const server = http.createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    const body = {
      ok: !lastPollError,
      page_id: CONFIG.pageId,
      dry_run: CONFIG.dryRun,
      poll_interval_seconds: CONFIG.pollSeconds,
      poll_in_progress: pollInProgress,
      last_poll_at: lastPollAt,
      last_poll_error: lastPollError,
      counters,
    };
    res.writeHead(lastPollError ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  });
  server.listen(CONFIG.healthPort, '127.0.0.1', () => {
    log('INFO', 'Local health endpoint listening', { url: `http://127.0.0.1:${CONFIG.healthPort}/health` });
  });
}

async function main() {
  await loadState();
  log('INFO', 'Meta Lead Sync starting', {
    page_id: CONFIG.pageId,
    graph_version: CONFIG.graphVersion,
    poll_seconds: CONFIG.pollSeconds,
    dry_run: CONFIG.dryRun,
    historical_sync: CONFIG.historical,
    test_leads_enabled: CONFIG.includeTestLeads,
    state_file: STATE_FILE,
  });
  startHealthServer();
  await runPoll();
  setInterval(runPoll, CONFIG.pollSeconds * 1000);
}

main().catch(error => {
  log('FATAL', error.message);
  process.exit(1);
});
