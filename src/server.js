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
  const { botId, sessionId, message } = req.body || {};
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
    console.error('chat error:', e);
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

  const { hits: found, best } = await rag.retrieve(bot.id, message);
  if (!found.length || best < cfg.minScore) {
    send({ type: 'token', text: fallback });
    return log(fallback, false); // shows up in "unanswered" so you know what to add
  }

  const context = found.map((h, i) => `[${i + 1}] Source: ${h.source}\n${h.text}`).join('\n\n');
  const system = `${bot.system_prompt}

Answer using ONLY the context below. If the answer is not in the context, say you don't know and suggest contacting the team. Keep answers short and clear.

<context>
${context}
</context>`;
  const messages = [...sess.history.slice(-6), { role: 'user', content: message }];
  let full = '';
  for await (const t of stream({ system, messages })) { full += t; send({ type: 'token', text: t }); }
  sess.history.push({ role: 'user', content: message }, { role: 'assistant', content: full });
  if (answerCache.size > 500) answerCache.delete(answerCache.keys().next().value);
  answerCache.set(key, full);
  await log(full, true);
}

// ---------- admin API ----------
const admin = express.Router();
admin.use((req, res, next) => (req.get('x-admin-key') === cfg.adminKey ? next() : res.status(401).json({ error: 'Invalid admin key' })));
app.use('/api/admin', admin);

admin.get('/bots', wrap(async (req, res) => res.json(await db.all('SELECT * FROM bots ORDER BY created_at DESC'))));

admin.post('/bots', wrap(async (req, res) => {
  const b = req.body || {};
  const id = 'bot_' + crypto.randomBytes(4).toString('hex');
  await db.run('INSERT INTO bots(id,name,system_prompt,welcome,color,fallback,allowed_origins,flows,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [
    id, b.name || 'Assistant',
    b.system_prompt || `You are a friendly support assistant for ${b.name || 'this website'}.`,
    b.welcome || 'Hi! How can I help you today?', b.color || '#2b5cff',
    b.fallback || null, b.allowed_origins || '*', JSON.stringify(b.flows || flowEngine.defaultFlows), Date.now()]);
  res.json(await getBot(id));
}));

admin.put('/bots/:id', wrap(async (req, res) => {
  const bot = await getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Not found' });
  const b = { ...bot, ...req.body };
  if (typeof b.flows !== 'string') b.flows = JSON.stringify(b.flows);
  try { if (!Array.isArray(JSON.parse(b.flows))) throw 0; } catch { return res.status(400).json({ error: 'flows must be a JSON array' }); }
  await db.run('UPDATE bots SET name=?,system_prompt=?,welcome=?,color=?,fallback=?,allowed_origins=?,flows=? WHERE id=?',
    [b.name, b.system_prompt, b.welcome, b.color, b.fallback, b.allowed_origins, b.flows, bot.id]);
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

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message }); });

if (require.main === module) {
  if (cfg.adminKey === 'change-me') console.warn('WARNING: set ADMIN_KEY in .env before deploying');
  db.init()
    .then(() => app.listen(cfg.port, () => console.log(`Chatbot platform running on port ${cfg.port}  (admin: /admin.html)`)))
    .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
}
module.exports = app;
