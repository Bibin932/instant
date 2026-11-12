'use strict';

/**
 * Self-hosted Meta Lead Ads -> CRM polling bridge.
 * Runs independently from the existing webhook/CRM application.
 * Node.js 20+; uses built-in fetch and the existing dotenv dependency.
 *
 * The management API binds to 127.0.0.1 only. The existing authenticated
 * /admin application proxies requests to it; Page tokens are never returned.
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
const CONNECTIONS_FILE = path.join(DATA_DIR, 'connections.json');

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
  try { return JSON.parse(raw); }
  catch { throw new Error(`${name} must contain valid JSON`); }
}

const CONFIG = {
  // Kept for backwards-compatible migration from the existing single-Page setup.
  pageId: process.env.META_PAGE_ID || '',
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
  crmPayloadMode: (process.env.CRM_PAYLOAD_MODE || 'online_leads').toLowerCase(),
  crmTableName: process.env.CRM_TABLE_NAME || 'OnlineLeads-qr2mdczhwfhc7nmmkiafsfjlui-prod',
  crmAssignedTo: process.env.CRM_ASSIGNED_TO || '1572c311-936b-42d3-a829-67041840d5b4',
  crmFormType: process.env.CRM_FORM_TYPE || 'LANGUAGE',
  crmCampaignName: process.env.CRM_CAMPAIGN_NAME || '',
  crmDefaultLanguage: process.env.CRM_DEFAULT_LANGUAGE || '',
  crmDefaultCourse: process.env.CRM_DEFAULT_COURSE || '',
  crmDefaultRemarks: process.env.CRM_DEFAULT_REMARKS || '',
  crmHideLead: envBool('CRM_HIDE_LEAD', false),
  crmDuplicateNameFields: envBool('CRM_DUPLICATE_FULL_NAME_IN_FIRST_LAST', true),
  crmTimeoutMs: envInt('CRM_TIMEOUT_MS', 20000, 1000, 120000),
};

if (!CONFIG.dryRun && !CONFIG.crmUrl) throw new Error('CRM_API_URL is required when DRY_RUN=false');
if (!/^https:\/\//i.test(CONFIG.crmUrl) && !CONFIG.dryRun) throw new Error('CRM_API_URL must use HTTPS');
if (!['POST', 'PUT', 'PATCH'].includes(CONFIG.crmMethod)) throw new Error('CRM_API_METHOD must be POST, PUT, or PATCH');
if (!['online_leads', 'generic'].includes(CONFIG.crmPayloadMode)) throw new Error('CRM_PAYLOAD_MODE must be online_leads or generic');
if (!CONFIG.crmHeaders || Array.isArray(CONFIG.crmHeaders) || typeof CONFIG.crmHeaders !== 'object') throw new Error('CRM_HEADERS_JSON must be a JSON object');
if (!CONFIG.crmFieldMap || Array.isArray(CONFIG.crmFieldMap) || typeof CONFIG.crmFieldMap !== 'object') throw new Error('CRM_FIELD_MAP_JSON must be a JSON object');

let state = null;
let connections = [];
let pollInProgress = false;
let lastPollAt = null;
let lastPollError = null;
let counters = { forms: 0, leadsSeen: 0, sent: 0, failed: 0, ignored: 0 };

function log(level, message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : '';
  process.stdout.write(`${new Date().toISOString()} [${level}] ${message}${suffix}\n`);
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, filePath);
  await fs.chmod(filePath, 0o600).catch(() => {});
}

async function saveState() {
  await atomicWriteJson(STATE_FILE, state);
}

async function saveConnections() {
  await atomicWriteJson(CONNECTIONS_FILE, { version: 1, updated_at: new Date().toISOString(), pages: connections });
}

async function loadState() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.leads || typeof parsed.leads !== 'object') throw new Error('invalid state structure');
    state = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read ${STATE_FILE}: ${error.message}. Back up and inspect this file before restarting.`);
    state = { version: 1, created_at: new Date().toISOString(), baseline_unix: Math.floor(Date.now() / 1000), leads: {} };
    await saveState();
    log('INFO', 'Created first-run baseline. Existing leads will not be imported unless SYNC_HISTORICAL_LEADS=true.');
  }
}

function legacyTokenMap() {
  let tokens = {};
  try { tokens = JSON.parse(process.env.META_PAGE_TOKENS_JSON || '{}'); }
  catch { throw new Error('META_PAGE_TOKENS_JSON in the existing project .env is not valid JSON'); }
  if (!tokens || Array.isArray(tokens) || typeof tokens !== 'object') throw new Error('META_PAGE_TOKENS_JSON must be a JSON object keyed by Page ID');
  if (CONFIG.pageId && process.env.META_PAGE_ACCESS_TOKEN) tokens[CONFIG.pageId] = process.env.META_PAGE_ACCESS_TOKEN;
  return tokens;
}

async function loadConnections() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(await fs.readFile(CONNECTIONS_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.pages)) throw new Error('invalid connections structure');
    connections = parsed.pages.filter(page => page && /^\d+$/.test(String(page.id || '')) && typeof page.token === 'string' && page.token.length > 20);
    // Keep a parent .env token current for the legacy Page while retaining
    // dashboard-managed tokens for all additional Pages.
    const legacy = legacyTokenMap();
    for (const page of connections) {
      if (page.token_source === 'parent_env' && legacy[page.id] && page.token !== legacy[page.id]) page.token = legacy[page.id];
    }
    await saveConnections();
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read ${CONNECTIONS_FILE}: ${error.message}. Back up and inspect this file before restarting.`);
  }

  const tokens = legacyTokenMap();
  if (CONFIG.pageId && !tokens[CONFIG.pageId]) throw new Error(`No Page token found for ${CONFIG.pageId}. Check META_PAGE_TOKENS_JSON in ${ROOT_ENV}`);
  const entries = Object.entries(tokens).filter(([id, token]) => /^\d+$/.test(id) && typeof token === 'string' && token.length > 20);
  if (!entries.length) throw new Error(`No Page tokens found. Configure META_PAGE_TOKENS_JSON in ${ROOT_ENV}`);

  connections = entries.map(([id, token]) => ({
    id,
    name: id,
    token,
    token_source: 'parent_env',
    enabled: id === CONFIG.pageId || !CONFIG.pageId,
    connected_at: new Date().toISOString(),
    last_checked_at: null,
    last_error: '',
    forms_refreshed_at: null,
    auto_enable_new_forms: id === CONFIG.pageId || !CONFIG.pageId,
    forms: [],
  }));
  await saveConnections();
  log('INFO', 'Migrated Page token configuration into the protected multi-Page registry', { pages: connections.length });
}

function pageTokenFor(pageId) {
  const page = connections.find(item => item.id === String(pageId));
  return page?.token || '';
}

function graphUrl(pathOrUrl, params = {}, token) {
  if (!token) throw new Error('A Page Access Token is not configured for this Page');
  const url = pathOrUrl instanceof URL
    ? new URL(pathOrUrl.toString())
    : new URL(`https://graph.facebook.com/${CONFIG.graphVersion}/${String(pathOrUrl).replace(/^\/+/, '')}`);
  if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com') throw new Error('Rejected unexpected Meta pagination URL');
  if (!(pathOrUrl instanceof URL)) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  url.searchParams.set('access_token', token);
  return url;
}

async function graphGet(pathOrUrl, params = {}, token) {
  const url = graphUrl(pathOrUrl, params, token);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
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

async function fetchPageForms(pageId, token) {
  const forms = [];
  let next = graphUrl(`${pageId}/leadgen_forms`, { fields: 'id,name,status', limit: 100 }, token);
  let pages = 0;
  while (next && pages < 20) {
    const result = await graphGet(next, {}, token);
    if (Array.isArray(result.data)) forms.push(...result.data);
    next = result.paging?.next ? new URL(result.paging.next) : null;
    pages += 1;
  }
  if (next) log('WARN', 'Stopped form pagination at safety limit (20 pages)', { page_id: pageId });
  return forms;
}

async function refreshPage(page, defaultNewFormsEnabled = false) {
  const profile = await graphGet(page.id, { fields: 'id,name' }, page.token);
  if (String(profile.id) !== String(page.id)) throw new Error('The supplied token did not resolve to the expected Facebook Page');
  const discovered = await fetchPageForms(page.id, page.token);
  const oldById = new Map((page.forms || []).map(form => [String(form.id), form]));
  page.forms = discovered.filter(form => form && form.id).map(form => {
    const old = oldById.get(String(form.id));
    return {
      id: String(form.id),
      name: String(form.name || 'Untitled form'),
      status: String(form.status || 'UNKNOWN'),
      enabled: old ? Boolean(old.enabled) : Boolean(defaultNewFormsEnabled),
      added_at: old?.added_at || new Date().toISOString(),
    };
  });
  page.name = String(profile.name || page.name || page.id);
  page.last_checked_at = new Date().toISOString();
  page.forms_refreshed_at = page.last_checked_at;
  page.last_error = '';
  await saveConnections();
  return page;
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

function normalizeFieldKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findFieldByAliases(fields, aliases, keywordFallbacks = []) {
  const entries = Object.entries(fields || {});
  const normalizedAliases = aliases.map(normalizeFieldKey);
  for (const [key, value] of entries) {
    if (normalizedAliases.includes(normalizeFieldKey(key))) return Array.isArray(value) ? (value[0] || '') : value;
  }
  for (const keyword of keywordFallbacks) {
    const normalizedKeyword = normalizeFieldKey(keyword);
    const found = entries.find(([key]) => normalizeFieldKey(key).includes(normalizedKeyword));
    if (found) return Array.isArray(found[1]) ? (found[1][0] || '') : found[1];
  }
  return '';
}

function makeOnlineLeadsPayload(lead) {
  const fields = extractFields(lead.field_data);
  const fullName = String(firstValue(fields, ['full_name', 'name'])).trim();
  const phone = String(firstValue(fields, ['phone_number', 'phone', 'mobile_number', 'mobile', 'telephone', 'wa_number', 'whatsapp_number'])).trim();
  const email = String(firstValue(fields, ['email', 'email_address'])).trim();
  const interestedCourse = String(findFieldByAliases(fields, ['interestedCourse', 'interested_course', 'course', 'course_name', 'program', 'program_name'], ['interestedcourse', 'course', 'program']) || CONFIG.crmDefaultCourse).trim();
  const remarks = String(findFieldByAliases(fields, ['remarks', 'specialization', 'course_details', 'course_specialization', 'branch'], ['remarks', 'specialization', 'course_details']) || CONFIG.crmDefaultRemarks).trim();
  const language = String(findFieldByAliases(fields, ['preferedLanguage', 'preferredLanguage', 'prefered_language', 'preferred_language', 'language'], ['preferredlanguage', 'preferedlanguage', 'language']) || CONFIG.crmDefaultLanguage).trim();
  const campaignName = String(findFieldByAliases(fields, ['campainName', 'campaignName', 'campaign_name'], ['campaignname']) || CONFIG.crmCampaignName).trim();

  let firstName = fullName;
  let lastName = CONFIG.crmDuplicateNameFields ? fullName : '';
  if (!CONFIG.crmDuplicateNameFields && fullName) {
    const parts = fullName.split(/\s+/);
    firstName = parts.shift() || '';
    lastName = parts.join(' ');
  }

  return {
    tableName: CONFIG.crmTableName,
    data: [{
      firstName,
      lastName,
      email,
      phone,
      interestedCourse,
      remarks,
      assignedTo: CONFIG.crmAssignedTo,
      campainName: campaignName,
      waNumber: phone,
      formType: CONFIG.crmFormType,
      preferedLanguage: language,
      hideLead: CONFIG.crmHideLead,
    }],
  };
}

function makeCanonicalPayload(lead, page) {
  if (CONFIG.crmPayloadMode === 'online_leads') return makeOnlineLeadsPayload(lead);
  const fields = extractFields(lead.field_data);
  const payload = {
    meta_lead_id: String(lead.id),
    source: 'facebook_lead_ads',
    page_id: page.id,
    page_name: page.name,
    form_id: lead.form_id || '',
    created_time: lead.created_time || '',
    full_name: firstValue(fields, ['full_name', 'name']),
    email: firstValue(fields, ['email']),
    phone_number: firstValue(fields, ['phone_number', 'phone', 'mobile_number', 'telephone']),
    fields,
    raw_field_data: Array.isArray(lead.field_data) ? lead.field_data : [],
  };
  for (const [key, value] of Object.entries(payload)) if (value === undefined || value === null) delete payload[key];
  if (!Object.keys(CONFIG.crmFieldMap).length) return { ...CONFIG.crmStaticFields, ...payload };
  const mapped = { ...CONFIG.crmStaticFields };
  for (const [sourceKey, destinationKey] of Object.entries(CONFIG.crmFieldMap)) {
    if (typeof destinationKey === 'string' && destinationKey.trim() && Object.prototype.hasOwnProperty.call(payload, sourceKey)) mapped[destinationKey] = payload[sourceKey];
  }
  return mapped;
}

async function sendToCrm(lead, page) {
  const payload = makeCanonicalPayload(lead, page);
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
  if (!response.ok) throw new Error(`CRM returned HTTP ${response.status} ${response.statusText}`.trim());
  return response.status;
}

function leadContext(lead, page) {
  const form = (page.forms || []).find(item => String(item.id) === String(lead.form_id));
  return {
    page_id: page.id,
    page_name: page.name,
    form_id: String(lead.form_id || ''),
    form_name: form?.name || '',
  };
}

async function processLead(lead, page) {
  const id = String(lead.id || '');
  if (!id) return;
  counters.leadsSeen += 1;
  const existing = state.leads[id];
  if (existing?.status === 'sent' || existing?.status === 'ignored') return;
  if (CONFIG.dryRun && existing?.status === 'dry_run') return;
  if (existing?.next_retry_at && Date.now() < existing.next_retry_at) return;

  const context = leadContext(lead, page);
  const createdUnix = lead.created_time ? Math.floor(new Date(lead.created_time).getTime() / 1000) : 0;
  if (!CONFIG.historical && createdUnix && createdUnix <= state.baseline_unix) {
    state.leads[id] = { ...existing, ...context, status: 'ignored', reason: 'created_before_sync_baseline', updated_at: new Date().toISOString() };
    counters.ignored += 1;
    await saveState();
    return;
  }

  const fields = extractFields(lead.field_data);
  if (!CONFIG.includeTestLeads && isMetaTestLead(fields)) {
    state.leads[id] = { ...existing, ...context, status: 'ignored', reason: 'meta_test_lead', updated_at: new Date().toISOString() };
    counters.ignored += 1;
    await saveState();
    log('INFO', 'Ignored Meta sample/test lead', { lead_id: id, page_id: page.id, form_id: lead.form_id || '' });
    return;
  }

  if (CONFIG.dryRun) {
    state.leads[id] = { ...existing, ...context, status: 'dry_run', updated_at: new Date().toISOString() };
    await saveState();
    const preview = makeCanonicalPayload(lead, page);
    const previewRecord = CONFIG.crmPayloadMode === 'online_leads' ? (Array.isArray(preview.data) ? preview.data[0] || {} : {}) : preview;
    log('DRY-RUN', 'Lead found; CRM request not sent', {
      lead_id: id,
      page_id: page.id,
      page_name: page.name,
      form_id: lead.form_id || '',
      field_names: Object.keys(fields),
      crm_payload_mode: CONFIG.crmPayloadMode,
      crm_table_name: preview.tableName || undefined,
      crm_record_fields: Object.keys(previewRecord),
      populated_fields: Object.entries(previewRecord).filter(([key, value]) => key !== 'hideLead' && value !== '' && value !== null && value !== undefined).map(([key]) => key),
    });
    return;
  }

  const attempts = (existing?.attempts || 0) + 1;
  try {
    const status = await sendToCrm(lead, page);
    state.leads[id] = { ...existing, ...context, status: 'sent', attempts, crm_http_status: status, sent_at: new Date().toISOString() };
    counters.sent += 1;
    await saveState();
    log('SUCCESS', 'Lead delivered to CRM', { lead_id: id, page_id: page.id, form_id: lead.form_id || '', crm_http_status: status });
  } catch (error) {
    const delay = retryDelayMs(attempts);
    state.leads[id] = {
      ...existing,
      ...context,
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
      page_id: page.id,
      form_id: lead.form_id || '',
      attempt: attempts,
      retry_in_seconds: Math.round(delay / 1000),
      error: String(error.message).slice(0, 180),
    });
  }
}

function retryDelayMs(attempts) {
  return Math.min(60 * 60 * 1000, 30000 * (2 ** Math.min(attempts - 1, 7)));
}

async function pollForm(form, page) {
  let next = graphUrl(`${form.id}/leads`, { fields: 'id,created_time,field_data,form_id', limit: 100 }, page.token);
  let pages = 0;
  while (next && pages < CONFIG.maxPagesPerForm) {
    const result = await graphGet(next, {}, page.token);
    const leads = Array.isArray(result.data) ? result.data : [];
    for (const lead of leads) await processLead({ ...lead, form_id: lead.form_id || form.id }, page);
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
  if (next && pages >= CONFIG.maxPagesPerForm) log('WARN', 'Reached per-form pagination safety limit; remaining pages will be checked next cycle', { page_id: page.id, form_id: form.id });
}

async function runPoll() {
  if (pollInProgress) return;
  pollInProgress = true;
  counters = { forms: 0, leadsSeen: 0, sent: 0, failed: 0, ignored: 0 };
  const pageErrors = [];
  try {
    const enabledPages = connections.filter(page => page.enabled && page.token);
    for (const page of enabledPages) {
      let pageFormError = '';
      try {
        const lastRefresh = Date.parse(page.forms_refreshed_at || '') || 0;
        if (!page.forms?.length || Date.now() - lastRefresh >= 10 * 60 * 1000) {
          await refreshPage(page, Boolean(page.auto_enable_new_forms));
          // Existing Page retains its legacy all-forms behavior only during migration.
          page.auto_enable_new_forms = false;
          await saveConnections();
        } else {
          page.last_checked_at = new Date().toISOString();
          page.last_error = '';
        }
        const activeForms = (page.forms || []).filter(form => form.enabled && String(form.status).toUpperCase() === 'ACTIVE');
        counters.forms += activeForms.length;
        log('INFO', 'Polling enabled Page forms', { page_id: page.id, page_name: page.name, enabled_forms: activeForms.length, total_forms: page.forms.length });
        for (const form of activeForms) {
          try { await pollForm(form, page); }
          catch (error) {
            pageFormError = String(error.message).slice(0, 300);
            pageErrors.push({ page_id: page.id, error: pageFormError });
            log('ERROR', 'Could not poll form', { page_id: page.id, form_id: form.id, error: pageFormError.slice(0, 200) });
          }
        }
        page.last_checked_at = new Date().toISOString();
        page.last_error = pageFormError;
      } catch (error) {
        page.last_checked_at = new Date().toISOString();
        page.last_error = String(error.message).slice(0, 300);
        pageErrors.push({ page_id: page.id, error: page.last_error });
        log('ERROR', 'Could not check connected Page', { page_id: page.id, error: page.last_error });
      }
      await saveConnections();
    }
    if (!enabledPages.length) log('WARN', 'No enabled Facebook Pages. Connect a Page and enable at least one lead form in /admin.');
    lastPollAt = new Date().toISOString();
    lastPollError = enabledPages.length > 0 && enabledPages.every(page => Boolean(page.last_error)) ? 'All enabled Pages failed their Meta API checks' : null;
    log('INFO', 'Polling cycle finished', { ...counters, enabledPages: enabledPages.length, pageErrors: pageErrors.length });
  } catch (error) {
    lastPollError = String(error.message).slice(0, 300);
    log('ERROR', 'Meta polling cycle failed', { error: lastPollError });
  } finally {
    pollInProgress = false;
  }
}

function countLeadRecords(pageId, formId) {
  const all = Object.values(state?.leads || {}).filter(record => {
    const recordPageId = record.page_id || CONFIG.pageId;
    if (String(recordPageId) !== String(pageId)) return false;
    if (formId && String(record.form_id || '') !== String(formId)) return false;
    return true;
  });
  return {
    total: all.length,
    sent: all.filter(item => item.status === 'sent').length,
    retrying: all.filter(item => item.status === 'retry').length,
    failed: all.filter(item => item.status === 'failed').length,
    ignored: all.filter(item => item.status === 'ignored').length,
    dry_run: all.filter(item => item.status === 'dry_run').length,
  };
}

function pageSummary(page) {
  const counts = countLeadRecords(page.id);
  return {
    id: page.id,
    name: page.name,
    enabled: Boolean(page.enabled),
    connected_at: page.connected_at || null,
    last_checked_at: page.last_checked_at || null,
    last_error: page.last_error || '',
    connection_status: page.last_error ? 'error' : (page.last_checked_at ? 'connected' : 'checking'),
    forms_count: (page.forms || []).length,
    active_forms_count: (page.forms || []).filter(form => form.enabled && String(form.status).toUpperCase() === 'ACTIVE').length,
    counts,
    forms: (page.forms || []).map(form => ({
      id: form.id,
      name: form.name,
      status: form.status,
      enabled: Boolean(form.enabled),
      counts: countLeadRecords(page.id, form.id),
    })),
  };
}

function overview() {
  const pages = connections.map(pageSummary);
  const totals = pages.reduce((acc, page) => {
    acc.total_leads += page.counts.total;
    acc.sent += page.counts.sent;
    acc.retrying += page.counts.retrying;
    acc.failed += page.counts.failed;
    acc.ignored += page.counts.ignored;
    acc.dry_run += page.counts.dry_run;
    acc.active_pages += page.enabled ? 1 : 0;
    acc.connected_pages += page.connection_status === 'connected' ? 1 : 0;
    acc.forms += page.forms_count;
    acc.active_forms += page.active_forms_count;
    return acc;
  }, { pages: pages.length, active_pages: 0, connected_pages: 0, forms: 0, active_forms: 0, total_leads: 0, sent: 0, retrying: 0, failed: 0, ignored: 0, dry_run: 0 });
  return {
    ok: !lastPollError,
    service: { running: true, dry_run: CONFIG.dryRun, poll_interval_seconds: CONFIG.pollSeconds, poll_in_progress: pollInProgress, last_poll_at: lastPollAt, last_poll_error: lastPollError },
    totals,
    pages,
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 32768) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Expected a JSON object');
  return value;
}

async function handleManagementRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    const body = {
      ok: !lastPollError,
      page_id: CONFIG.pageId || null,
      page_count: connections.length,
      dry_run: CONFIG.dryRun,
      poll_interval_seconds: CONFIG.pollSeconds,
      poll_in_progress: pollInProgress,
      last_poll_at: lastPollAt,
      last_poll_error: lastPollError,
      counters,
    };
    return sendJson(res, lastPollError ? 503 : 200, body);
  }
  if (req.method === 'GET' && pathname === '/admin/overview') return sendJson(res, 200, overview());

  if (req.method === 'POST' && pathname === '/admin/pages') {
    const body = await readJsonBody(req);
    const token = String(body.pageToken || '').trim();
    if (token.length < 30 || token.length > 10000) return sendJson(res, 400, { error: 'Enter a valid Page Access Token.' });
    // Validate token and verify that it grants access to the Page's lead forms.
    const profile = await graphGet('me', { fields: 'id,name' }, token);
    const id = String(profile.id || '');
    if (!/^\d+$/.test(id)) return sendJson(res, 400, { error: 'The token did not resolve to a Facebook Page.' });
    const existing = connections.find(page => page.id === id);
    if (existing) {
      existing.token = token;
      existing.token_source = 'dashboard';
      existing.name = String(profile.name || existing.name || id);
      await refreshPage(existing, false);
      existing.auto_enable_new_forms = false;
      await saveConnections();
      return sendJson(res, 200, { ok: true, message: 'Page token updated. Existing form selections were preserved.', page: pageSummary(existing) });
    }
    const page = {
      id,
      name: String(profile.name || id),
      token,
      token_source: 'dashboard',
      enabled: true,
      connected_at: new Date().toISOString(),
      last_checked_at: null,
      last_error: '',
      forms_refreshed_at: null,
      auto_enable_new_forms: false,
      forms: [],
    };
    await refreshPage(page, false); // Newly discovered forms start paused until explicitly enabled.
    connections.push(page);
    await saveConnections();
    log('INFO', 'Facebook Page connected from admin dashboard', { page_id: id, forms: page.forms.length });
    return sendJson(res, 201, { ok: true, message: 'Page connected. Select the forms you want to sync.', page: pageSummary(page) });
  }

  const pageEnabledMatch = pathname.match(/^\/admin\/pages\/(\d+)\/enabled$/);
  if (req.method === 'POST' && pageEnabledMatch) {
    const page = connections.find(item => item.id === pageEnabledMatch[1]);
    if (!page) return sendJson(res, 404, { error: 'Page not found.' });
    const body = await readJsonBody(req);
    page.enabled = body.enabled === true;
    await saveConnections();
    return sendJson(res, 200, { ok: true, page: pageSummary(page) });
  }

  const refreshMatch = pathname.match(/^\/admin\/pages\/(\d+)\/refresh$/);
  if (req.method === 'POST' && refreshMatch) {
    const page = connections.find(item => item.id === refreshMatch[1]);
    if (!page) return sendJson(res, 404, { error: 'Page not found.' });
    await refreshPage(page, false);
    return sendJson(res, 200, { ok: true, page: pageSummary(page) });
  }

  const formEnabledMatch = pathname.match(/^\/admin\/pages\/(\d+)\/forms\/(\d+)\/enabled$/);
  if (req.method === 'POST' && formEnabledMatch) {
    const page = connections.find(item => item.id === formEnabledMatch[1]);
    if (!page) return sendJson(res, 404, { error: 'Page not found.' });
    const form = (page.forms || []).find(item => item.id === formEnabledMatch[2]);
    if (!form) return sendJson(res, 404, { error: 'Form not found. Refresh the Page forms list.' });
    const body = await readJsonBody(req);
    const enabled = body.enabled === true;
    if (enabled && String(form.status).toUpperCase() !== 'ACTIVE') return sendJson(res, 409, { error: 'Only ACTIVE Meta forms can be enabled.' });
    form.enabled = enabled;
    await saveConnections();
    return sendJson(res, 200, { ok: true, page: pageSummary(page) });
  }

  const removeMatch = pathname.match(/^\/admin\/pages\/(\d+)$/);
  if (req.method === 'DELETE' && removeMatch) {
    const index = connections.findIndex(item => item.id === removeMatch[1]);
    if (index < 0) return sendJson(res, 404, { error: 'Page not found.' });
    const [removed] = connections.splice(index, 1);
    await saveConnections();
    log('INFO', 'Facebook Page disconnected from polling', { page_id: removed.id });
    return sendJson(res, 200, { ok: true, message: 'Page disconnected. Previously processed lead history was preserved.' });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function startHealthServer() {
  if (!CONFIG.healthPort) return;
  const server = http.createServer((req, res) => {
    Promise.resolve(handleManagementRequest(req, res)).catch(error => {
      const message = String(error.message || 'Request failed').slice(0, 300);
      const status = /token|Meta Graph API/i.test(message) ? 400 : 500;
      log('WARN', 'Local admin API request failed', { route: req.url, error: message });
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.destroy();
    });
  });
  server.listen(CONFIG.healthPort, '127.0.0.1', () => {
    log('INFO', 'Local management API listening', { url: `http://127.0.0.1:${CONFIG.healthPort}` });
  });
}

async function main() {
  await loadState();
  await loadConnections();
  log('INFO', 'Meta Lead Sync starting', {
    legacy_page_id: CONFIG.pageId || null,
    connected_pages: connections.length,
    crm_payload_mode: CONFIG.crmPayloadMode,
    crm_configured: Boolean(CONFIG.crmUrl),
    graph_version: CONFIG.graphVersion,
    poll_seconds: CONFIG.pollSeconds,
    dry_run: CONFIG.dryRun,
    historical_sync: CONFIG.historical,
    test_leads_enabled: CONFIG.includeTestLeads,
    state_file: STATE_FILE,
    connections_file: CONNECTIONS_FILE,
  });
  startHealthServer();
  await runPoll();
  setInterval(runPoll, CONFIG.pollSeconds * 1000);
}

main().catch(error => {
  log('FATAL', error.message);
  process.exit(1);
});
