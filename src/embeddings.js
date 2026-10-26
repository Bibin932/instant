// Swappable embedding providers: local (free) | voyage (paid) | openai-compatible (OpenAI / Ollama)
const cfg = require('./config').embed;

const DEFAULTS = {
  local: 'Xenova/all-MiniLM-L6-v2',
  voyage: 'voyage-3.5-lite',
  'openai-compatible': 'text-embedding-3-small',
};
const model = cfg.model || DEFAULTS[cfg.provider];

function normalize(v) {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

let pipePromise;
async function local(texts) {
  pipePromise ||= import('@xenova/transformers').then((m) => m.pipeline('feature-extraction', model));
  const pipe = await pipePromise;
  const out = [];
  for (const t of texts) {
    const r = await pipe(t, { pooling: 'mean', normalize: true });
    out.push(Array.from(r.data));
  }
  return out;
}

async function voyage(texts, kind) {
  const r = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ input: texts, model, input_type: kind === 'query' ? 'query' : 'document' }),
  });
  if (!r.ok) throw new Error(`Voyage error ${r.status}: ${await r.text()}`);
  return (await r.json()).data.map((d) => d.embedding);
}

async function openaiCompatible(texts) {
  const base = (cfg.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const r = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey || 'none'}` },
    body: JSON.stringify({ input: texts, model }),
  });
  if (!r.ok) throw new Error(`Embeddings error ${r.status}: ${await r.text()}`);
  return (await r.json()).data.map((d) => d.embedding);
}

const impls = { local, voyage, 'openai-compatible': openaiCompatible };

async function embed(texts, kind = 'document') {
  const fn = impls[cfg.provider];
  if (!fn) throw new Error(`Unknown EMBED_PROVIDER "${cfg.provider}"`);
  const out = [];
  for (let i = 0; i < texts.length; i += 32) out.push(...(await fn(texts.slice(i, i + 32), kind)));
  return out.map(normalize);
}

// id changes if you switch provider/model, so old vectors are never mixed with new ones
module.exports = { id: `${cfg.provider}:${model}`, embed };
