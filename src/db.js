// PostgreSQL (works with Supabase). Set DATABASE_URL in .env.
const { Pool, types } = require('pg');
const url = require('./config').db.url;

types.setTypeParser(20, (v) => Number(v)); // BIGINT/COUNT come back as numbers, not strings

const local = /@(localhost|127\.0\.0\.1)/.test(url || '');
const pool = new Pool({ connectionString: url, max: 10, ssl: local ? false : { rejectUnauthorized: false } });
pool.on('error', (e) => console.error('db pool error:', e.message));

// Lets the rest of the code write "?" placeholders: converts to $1, $2, ...
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

let ready;
const ensure = () => (ready ||= init()); // creates tables once, before the first query, however the app was started

async function all(sql, params = []) {
  await ensure();
  return (await pool.query(toPg(sql), params)).rows;
}
async function get(sql, params = []) {
  return (await all(sql, params))[0];
}
// INSERT/UPDATE/DELETE. For INSERT, returns { insertId } of the (first) new row.
async function run(sql, params = []) {
  await ensure();
  const isInsert = /^\s*INSERT/i.test(sql) && !/RETURNING/i.test(sql);
  const r = await pool.query(toPg(isInsert ? `${sql} RETURNING id` : sql), params);
  return { insertId: isInsert ? r.rows[0]?.id : undefined, rowCount: r.rowCount };
}
// Bulk insert: rows = array of arrays matching cols
async function insertMany(table, cols, rows) {
  if (!rows.length) return;
  await ensure();
  const params = [];
  const values = rows.map((row) => `(${row.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`);
  await pool.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')}`, params);
}

const tables = ['bots', 'sources', 'chunks', 'logs', 'leads'];
const schema = [
  `CREATE TABLE IF NOT EXISTS bots(
    id VARCHAR(40) PRIMARY KEY, name TEXT, system_prompt TEXT, welcome TEXT, color VARCHAR(20),
    fallback TEXT, allowed_origins TEXT, flows TEXT, created_at BIGINT, mode VARCHAR(10) DEFAULT 'hybrid')`,
  `CREATE TABLE IF NOT EXISTS sources(
    id SERIAL PRIMARY KEY, bot_id VARCHAR(40), type VARCHAR(20), name TEXT, chunks INT, created_at BIGINT,
    status VARCHAR(12) DEFAULT 'ready', error TEXT)`,
  `CREATE TABLE IF NOT EXISTS chunks(
    id SERIAL PRIMARY KEY, bot_id VARCHAR(40), source_id INT, text TEXT, embedding BYTEA, model VARCHAR(120))`,
  `CREATE TABLE IF NOT EXISTS logs(
    id SERIAL PRIMARY KEY, bot_id VARCHAR(40), session VARCHAR(80), question TEXT, answer TEXT,
    answered SMALLINT, created_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS leads(
    id SERIAL PRIMARY KEY, bot_id VARCHAR(40), flow VARCHAR(80), data TEXT, created_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS idx_sources_bot ON sources(bot_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_bot ON chunks(bot_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_bot_time ON logs(bot_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_bot ON leads(bot_id)`,
];

async function init() {
  if (!url) throw new Error('Set DATABASE_URL in .env (Supabase dashboard > Connect)');
  for (const sql of schema) await pool.query(sql);
  await pool.query("ALTER TABLE sources ADD COLUMN IF NOT EXISTS status VARCHAR(12) DEFAULT 'ready'");
  await pool.query('ALTER TABLE sources ADD COLUMN IF NOT EXISTS error TEXT');
  await pool.query("UPDATE sources SET status = 'failed', error = 'Interrupted by a restart. Please add it again.' WHERE status = 'processing'");
  await pool.query("ALTER TABLE bots ADD COLUMN IF NOT EXISTS mode VARCHAR(10) DEFAULT 'hybrid'");
  // Supabase exposes the public schema through its REST API. Turning on Row Level Security with no
  // policies blocks that route; this server connects as the database owner, so it is unaffected.
  for (const t of tables) await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
}

module.exports = { run, all, get, insertMany, init: ensure, pool, toPg };
