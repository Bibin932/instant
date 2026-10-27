const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const cfg = require('./config');
const db = require('./db');
const rag = require('./rag');
const ingest = require('./ingest');
const flowEngine = require('./flows');
const { stream } = require('./llm');
const embedder = require('./embeddings');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '../public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- helpers ----------
const getBot = (id) => db.get('SELECT * FROM bots WHERE id = ?', [id]);
const parseFlows = (bot) => { try { return JSON.parse(bot.flows || '[]'); } catch { return []; } };
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
function originOk(bot, req) {
  const allowed = (bot.allowed_origins || '*').trim();
  if (allowed === '*') return true;
  return allowed.split(',').map((s) => s.trim()).includes(req.get('origin'));
}

// in-memory sessions, answer cache, rate limit
const sessions = new Map();
function session(botId, id) {
  const key = `${botId}:${id}`;
  if (!sessions.has(key)) sessions.set(key, { history: [], flow: null, seen: Date.now() });
  const s = sessions.get(key);
  s.seen = Date.now();
  return s;
}
setInterval(() => { for (const [k, s] of sessions) if (Date.now() - s.seen > 3600e3) sessions.delete(k); }, 600e3).unref();

const answerCache = new Map();
const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip, now = Date.now();
  const h = hits.get(ip) || { n: 0, reset: now + 60e3 };
  if (now > h.reset) { h.n = 0; h.reset = now + 60e3; }
  h.n++;
  hits.set(ip, h);
  if (h.n > cfg.ratePerMin) return res.status(429).json({ error: 'Too many messages, please slow down.' });
  next();
}

// ---------- public API ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/bots/:id/config', wrap(async (req, res) => {
  const bot = await getBot(req.params.id);
  if (!bot || !originOk(bot, req)) return res.status(404).json({ error: 'Bot not found' });
  res.json({
    name: bot.name,
    welcome: bot.welcome,
    color: bot.color,
    buttons: parseFlows(bot).filter((f) => f.button).map((f) => ({ label: f.button, message: `flow:${f.id}` })),
  });
}));

app.post('/api/chat', rateLimit, async (req, res) => {
  const { botId, sessionId } = req.body || {};
  const message = typeof req.body?.message === 'string' ? req.body.message.replace(/\u0000/g, '') : req.body?.message;
  const bot = botId && (await getBot(botId));
  if (!bot || !originOk(bot, req)) return res.status(404).json({ error: 'Bot not found' });
  if (typeof message !== 'string' || !message.trim() || message.length > 1000)
    return res.status(400).json({ error: 'Message must be 1-1000 characters' });

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const sess = session(botId, String(sessionId || req.ip));
  const flows = parseFlows(bot);
  const ctx = {
    botId,
    saveLead: (flow, data) => db.run('INSERT INTO leads(bot_id,flow,data,created_at) VALUES(?,?,?,?)', [botId, flow, JSON.stringify(data), Date.now()]),
  };

  try {
    let flow = sess.flow && flows.find((f) => f.id === sess.flow.flowId);
    let input = message;
    if (!flow) {
      sess.flow = null;
      flow = flowEngine.match(flows, message);
      if (flow) { sess.flow = { flowId: flow.id, i: 0, data: {}, waiting: false }; input = undefined; }
    }
    if (flow) {
      const r = await flowEngine.advance(flow, sess.flow, input, ctx);
      r.out.forEach((m) => send({ type: 'message', text: m.text, options: m.options }));
      if (r.done) sess.flow = null;
    } else {
      await answer(bot, sess, message.trim(), send, String(sessionId || ''));
    }
  } catch (e) {
    console.error('chat error:', e && e.message ? e.message : e, e && e.status ? `(HTTP ${e.status})` : '');
    send({ type: 'error', text: 'Sorry, something went wrong. Please try again.' });
  } finally {
    send({ type: 'done' });
    res.end();
  }
});

async function answer(bot, sess, message, send, sessionId) {
  const log = (a, ok) => db.run('INSERT INTO logs(bot_id,session,question,answer,answered,created_at) VALUES(?,?,?,?,?,?)', [bot.id, sessionId, message, a, ok ? 1 : 0, Date.now()]);
  const fallback = bot.fallback || "I'm not sure about that. Could you rephrase, or contact our team?";

  const dayStart = new Date().setHours(0, 0, 0, 0);
  const { n: used } = await db.get('SELECT COUNT(*) AS n FROM logs WHERE bot_id = ? AND created_at > ?', [bot.id, dayStart]);
  if (used >= cfg.dailyLimit) return send({ type: 'token', text: 'This assistant has reached its daily limit. Please try again tomorrow.' });

  const key = `${bot.id}|${norm(message)}`;
  if (answerCache.has(key)) { const c = answerCache.get(key); send({ type: 'token', text: c }); return log(c, true); }

  // Follow-ups like "and the price?" are searched together with the previous question
  const prev = [...sess.history].reverse().find((m) => m.role === 'user');
  const searchText = prev && message.length < 60 ? `${prev.content} ${message}` : message;
  const { hits: found, best } = await rag.retrieve(bot.id, searchText);
  const grounded = found.length > 0 && best >= cfg.minScore;

  if (!grounded && (bot.mode || 'hybrid') === 'strict') {
    send({ type: 'token', text: fallback });
    return log(fallback, false); // shows up in the admin list so you know what to add
  }

  let system;
  if (grounded) {
    const context = found.map((h, i) => `[${i + 1}] Source: ${h.source}\n${h.text}`).join('\n\n');
    system = `${bot.system_prompt}

Use the context below first, especially for facts about this business. If the context only partly covers the question, combine it with your general knowledge. Never invent business-specific facts (prices, policies, contact details, availability); if they are not in the context, say you don't have that information. Keep answers clear and concise.

<context>
${context}
</context>`;
  } else {
    system = `${bot.system_prompt}

No matching business documents were found for this question. Answer helpfully from your general knowledge and the conversation so far. Do not invent business-specific facts (prices, policies, contact details, availability); if asked for those, say you don't have that information and suggest contacting the team. Keep answers clear and concise.`;
  }
  const messages = [...sess.history.slice(-6), { role: 'user', content: message }];
  let full = '';
  for await (const t of stream({ system, messages })) { full += t; send({ type: 'token', text: t }); }
  sess.history.push({ role: 'user', content: message }, { role: 'assistant', content: full });
  if (answerCache.size > 500) answerCache.delete(answerCache.keys().next().value);
  answerCache.set(key, full);
  await log(full, grounded);
}

// ---------- admin API ----------
const admin = express.Router();
admin.use((req, res, next) => (req.get('x-admin-key') === cfg.adminKey ? next() : res.status(401).json({ error: 'Invalid admin key' })));
app.use('/api/admin', admin);

admin.get('/bots', wrap(async (req, res) => res.json(await db.all('SELECT * FROM bots ORDER BY created_at DESC'))));

admin.post('/bots', wrap(async (req, res) => {
  const b = req.body || {};
  const id = 'bot_' + crypto.randomBytes(4).toString('hex');
  await db.run('INSERT INTO bots(id,name,system_prompt,welcome,color,fallback,allowed_origins,flows,created_at,mode) VALUES(?,?,?,?,?,?,?,?,?,?)', [
    id, b.name || 'Assistant',
    b.system_prompt || `You are a friendly support assistant for ${b.name || 'this website'}.`,
    b.welcome || 'Hi! How can I help you today?', b.color || '#2b5cff',
    b.fallback || null, b.allowed_origins || '*', JSON.stringify(b.flows || flowEngine.defaultFlows), Date.now(), b.mode === 'strict' ? 'strict' : 'hybrid']);
  res.json(await getBot(id));
}));

admin.put('/bots/:id', wrap(async (req, res) => {
  const bot = await getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Not found' });
  const b = { ...bot, ...req.body };
  if (typeof b.flows !== 'string') b.flows = JSON.stringify(b.flows);
  try { if (!Array.isArray(JSON.parse(b.flows))) throw 0; } catch { return res.status(400).json({ error: 'flows must be a JSON array' }); }
  await db.run('UPDATE bots SET name=?,system_prompt=?,welcome=?,color=?,fallback=?,allowed_origins=?,flows=?,mode=? WHERE id=?',
    [b.name, b.system_prompt, b.welcome, b.color, b.fallback, b.allowed_origins, b.flows, b.mode === 'strict' ? 'strict' : 'hybrid', bot.id]);
  answerCache.clear();
  res.json(await getBot(bot.id));
}));

admin.delete('/bots/:id', wrap(async (req, res) => {
  for (const t of ['chunks', 'sources', 'logs', 'leads']) await db.run(`DELETE FROM ${t} WHERE bot_id = ?`, [req.params.id]);
  await db.run('DELETE FROM bots WHERE id = ?', [req.params.id]);
  rag.invalidate(req.params.id);
  res.json({ ok: true });
}));

admin.get('/bots/:id/sources', wrap(async (req, res) => res.json(await db.all('SELECT * FROM sources WHERE bot_id = ? ORDER BY id DESC', [req.params.id]))));
admin.delete('/bots/:id/sources/:sid', wrap(async (req, res) => {
  await db.run('DELETE FROM chunks WHERE source_id = ? AND bot_id = ?', [req.params.sid, req.params.id]);
  await db.run('DELETE FROM sources WHERE id = ? AND bot_id = ?', [req.params.sid, req.params.id]);
  rag.invalidate(req.params.id); answerCache.clear();
  res.json({ ok: true });
}));

admin.post('/bots/:id/pdf', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a PDF as "file"' });
  const text = await ingest.pdfToText(req.file.buffer);
  res.json(await ingest.addSource(req.params.id, 'pdf', req.file.originalname, text));
}));
admin.post('/bots/:id/url', wrap(async (req, res) => {
  const { url, crawl, maxPages } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });
  res.json(await ingest.addUrl(req.params.id, url, { crawl: !!crawl, maxPages: Math.min(+maxPages || 15, 100) }));
}));
admin.post('/bots/:id/text', wrap(async (req, res) => {
  const { name, text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text is required' });
  res.json(await ingest.addSource(req.params.id, 'text', name || 'Pasted text', text));
}));

admin.get('/bots/:id/logs', wrap(async (req, res) => {
  const only = req.query.unanswered ? 'AND answered = 0' : '';
  res.json(await db.all(`SELECT * FROM logs WHERE bot_id = ? ${only} ORDER BY id DESC LIMIT 200`, [req.params.id]));
}));
admin.get('/bots/:id/leads', wrap(async (req, res) => res.json(await db.all('SELECT * FROM leads WHERE bot_id = ? ORDER BY id DESC LIMIT 200', [req.params.id]))));

// Checks each part separately so you can see exactly what is failing
admin.get('/diagnose', wrap(async (req, res) => {
  const out = {};
  const step = async (name, fn) => {
    try { out[name] = { ok: true, ...(await fn()) }; }
    catch (e) { out[name] = { ok: false, error: String((e && e.message) || e).slice(0, 500) }; }
  };
  await step('config', async () => {
    if (!cfg.envFound) throw new Error(`.env file NOT found at ${cfg.envPath}. Create it there (copy .env.example to .env) and restart with: pm2 restart chatbot --update-env`);
    return { envFile: 'found', provider: cfg.llm.provider, model: cfg.llm.model, baseURL: cfg.llm.baseURL || '(default)', llmKey: cfg.llm.apiKey ? 'set' : 'EMPTY', embeddings: embedder.id };
  });
  await step('database', async () => { await db.get('SELECT 1 AS ok'); return {}; });
  await step('knowledge', async () => {
    const t = await db.get('SELECT COUNT(*) AS n FROM chunks WHERE bot_id = ?', [req.query.botId]);
    const u = await db.get('SELECT COUNT(*) AS n FROM chunks WHERE bot_id = ? AND model = ?', [req.query.botId, embedder.id]);
    if (t.n === 0) throw new Error('No indexed text yet. Add a PDF or web page.');
    if (u.n === 0) throw new Error(`Your ${t.n} chunks were indexed with a different embedding model than the current one (${embedder.id}). Remove the sources and add them again.`);
    return { chunks: t.n, usable: u.n };
  });
  await step('embeddings', async () => { const [v] = await embedder.embed(['test'], 'query'); return { model: embedder.id, dimensions: v.length }; });
  await step('llm', async () => {
    let t = '';
    for await (const x of stream({ system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'ping' }] })) { t += x; if (t.length > 40) break; }
    return { provider: cfg.llm.provider, model: cfg.llm.model, reply: t.trim().slice(0, 40) || '(empty)' };
  }).then(() => {
    const l = cfg.llm;
    if (!out.llm.ok && l.provider === 'anthropic' && l.apiKey && !l.apiKey.startsWith('sk-ant'))
      out.llm.error = 'LLM_PROVIDER is "anthropic" (the default) but your key is not an Anthropic key. For Gemini set LLM_PROVIDER=openai-compatible, LLM_BASE_URL and LLM_MODEL in .env, then restart with: pm2 restart chatbot --update-env. Original error: ' + out.llm.error;
  });
  res.json(out);
}));

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message }); });

console.log(`AI model: provider=${cfg.llm.provider} model=${cfg.llm.model}${cfg.llm.baseURL ? ' url=' + cfg.llm.baseURL : ''} | embeddings: ${embedder.id}`);
if (cfg.adminKey === 'change-me') console.warn('WARNING: set ADMIN_KEY in .env before deploying');
db.init()
  .then(() => app.listen(cfg.port, () => console.log(`Chatbot platform running on port ${cfg.port}  (admin: /admin.html)`)))
  .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
