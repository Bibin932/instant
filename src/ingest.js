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

// ---- background indexing (keeps HTTP requests short so proxies like Cloudflare don't time out) ----
let queue = Promise.resolve();
const enqueue = (job) => { queue = queue.then(job).catch((e) => console.error('ingest job error:', e.message)); };

async function createSource(botId, type, name) {
  const r = await db.run('INSERT INTO sources(bot_id,type,name,chunks,created_at,status) VALUES(?,?,?,?,?,?)', [botId, type, clean(name), 0, Date.now(), 'processing']);
  return r.insertId;
}
const fail = (id, e) => {
  console.error(`indexing source ${id} failed:`, e.message);
  return db.run("UPDATE sources SET status = 'failed', error = ? WHERE id = ?", [clean(e.message).slice(0, 500), id]);
};

async function indexSource(botId, sourceId, text) {
  try {
    const pieces = chunk(clean(text));
    if (!pieces.length) throw new Error('No readable text found (a scanned PDF with only images has no text to read).');
    const vectors = await embedder.embed(pieces, 'document');
    for (let i = 0; i < pieces.length; i += 100) {
      const rows = pieces.slice(i, i + 100).map((p, j) => [botId, sourceId, p, rag.toBlob(vectors[i + j]), embedder.id]);
      await db.insertMany('chunks', ['bot_id', 'source_id', 'text', 'embedding', 'model'], rows);
    }
    await db.run("UPDATE sources SET chunks = ?, status = 'ready', error = NULL WHERE id = ?", [pieces.length, sourceId]);
    rag.invalidate(botId);
  } catch (e) {
    await fail(sourceId, e);
  }
}

async function queueText(botId, type, name, text) {
  const id = await createSource(botId, type, name);
  enqueue(() => indexSource(botId, id, text));
  return { id, name: clean(name), status: 'processing' };
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

async function queueUrl(botId, startUrl, { crawl = false, maxPages = 15 } = {}) {
  const origin = new URL(startUrl);
  if (!/^https?:$/.test(origin.protocol)) throw new Error('Only http(s) URLs are allowed');
  const firstId = await createSource(botId, 'url', startUrl);
  enqueue(async () => {
    let spare = firstId; // the row created above is used for the first page that loads
    const todo = [startUrl], seen = new Set();
    let done = 0, lastError = null;
    while (todo.length && done < (crawl ? maxPages : 1)) {
      const url = todo.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      try {
        const page = await fetchPage(url);
        const id = spare ?? (await createSource(botId, 'url', url));
        if (spare) await db.run('UPDATE sources SET name = ? WHERE id = ?', [clean(url), id]);
        spare = null;
        await indexSource(botId, id, `${page.title}\n\n${page.text}`);
        done++;
        if (crawl) page.links.filter((l) => { try { return new URL(l).origin === origin.origin && !seen.has(l); } catch { return false; } }).forEach((l) => todo.push(l));
      } catch (e) {
        lastError = e;
        console.warn('skip', url, e.message);
      }
    }
    if (spare) await fail(spare, lastError || new Error('Could not read the page'));
  });
  return { id: firstId, name: startUrl, status: 'processing' };
}

module.exports = { clean, chunk, queueText, queueUrl, pdfToText };
