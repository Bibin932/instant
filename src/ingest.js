const db = require('./db');
const embedder = require('./embeddings');
const rag = require('./rag');

// PostgreSQL rejects NUL (0x00) in text, and PDFs often contain it. Strip it and other control characters.
const clean = (s) => String(s).replace(/\u0000/g, '').replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');

function chunk(text, size = 1200, overlap = 150) {
  const units = text.replace(/\r/g, '').split(/(?<=[.!?])\s+|\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (let u of units) {
    while (u.length > size) {
      if (cur) { out.push(cur); cur = ''; }
      out.push(u.slice(0, size));
      u = u.slice(size - overlap);
    }
    if (cur && (cur + ' ' + u).length > size) {
      out.push(cur);
      cur = cur.slice(-overlap) + ' ' + u;
    } else {
      cur = cur ? cur + ' ' + u : u;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 30);
}

async function addSource(botId, type, name, text) {
  name = clean(name);
  const pieces = chunk(clean(text));
  if (!pieces.length) throw new Error(`No readable text found in ${name}`);
  const vectors = await embedder.embed(pieces, 'document');
  const src = await db.run('INSERT INTO sources(bot_id,type,name,chunks,created_at) VALUES(?,?,?,?,?)', [botId, type, name, pieces.length, Date.now()]);
  for (let i = 0; i < pieces.length; i += 100) {
    const rows = pieces.slice(i, i + 100).map((p, j) => [botId, src.insertId, p, rag.toBlob(vectors[i + j]), embedder.id]);
    await db.insertMany('chunks', ['bot_id', 'source_id', 'text', 'embedding', 'model'], rows);
  }
  rag.invalidate(botId);
  return { id: src.insertId, name, chunks: pieces.length };
}

async function pdfToText(buffer) {
  const pdf = require('pdf-parse/lib/pdf-parse.js'); // direct path avoids pdf-parse's debug-mode bug
  return (await pdf(buffer)).text;
}

async function fetchPage(url) {
  const cheerio = require('cheerio');
  const res = await fetch(url, { headers: { 'user-agent': 'ChatbotCrawler/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  if (!(res.headers.get('content-type') || '').includes('html')) throw new Error(`${url} is not an HTML page`);
  const $ = cheerio.load(await res.text());
  const links = [];
  $('a[href]').each((_, a) => {
    try { const u = new URL($(a).attr('href'), url); u.hash = ''; links.push(u.href); } catch {}
  });
  $('script,style,nav,footer,header,noscript,svg,iframe,form').remove();
  $('p,div,li,h1,h2,h3,h4,h5,tr,br').after('\n');
  const text = $('body').text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return { title: $('title').text().trim() || url, text, links };
}

async function addUrl(botId, startUrl, { crawl = false, maxPages = 15 } = {}) {
  const origin = new URL(startUrl);
  if (!/^https?:$/.test(origin.protocol)) throw new Error('Only http(s) URLs are allowed');
  const queue = [startUrl], seen = new Set(), added = [];
  while (queue.length && added.length < (crawl ? maxPages : 1)) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const page = await fetchPage(url);
      added.push(await addSource(botId, 'url', url, `${page.title}\n\n${page.text}`));
      if (crawl) page.links.filter((l) => new URL(l).origin === origin.origin && !seen.has(l)).forEach((l) => queue.push(l));
    } catch (e) {
      if (!crawl) throw e;
      console.warn('skip', url, e.message);
    }
  }
  return added;
}

module.exports = { clean, chunk, addSource, addUrl, pdfToText };
