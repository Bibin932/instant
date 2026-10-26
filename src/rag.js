const db = require('./db');
const cfg = require('./config');
const embedder = require('./embeddings');

const cache = new Map(); // botId -> items[]
const toVec = (buf) => new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
const toBlob = (vec) => Buffer.from(new Float32Array(vec).buffer);

async function load(botId) {
  if (cache.has(botId)) return cache.get(botId);
  const rows = await db.all(`SELECT c.id, c.text, c.embedding, s.name AS source FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.bot_id = ? AND c.model = ?`, [botId, embedder.id]);
  const items = rows.map((r) => ({ id: r.id, text: r.text, source: r.source, vec: toVec(r.embedding) }));
  cache.set(botId, items);
  return items;
}

const invalidate = (botId) => cache.delete(botId);

async function retrieve(botId, question) {
  const items = await load(botId);
  if (!items.length) return { hits: [], best: 0 };
  const [q] = await embedder.embed([question], 'query');
  const scored = items.map((it) => {
    let dot = 0;
    for (let i = 0; i < q.length; i++) dot += q[i] * it.vec[i];
    return { text: it.text, source: it.source, score: dot };
  });
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, cfg.topK);
  return { hits, best: hits[0].score };
}

module.exports = { retrieve, invalidate, toBlob };
