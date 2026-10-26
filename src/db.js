// MySQL / MariaDB (create the database in aaPanel > Database, then fill DB_* in .env)
const mysql = require('mysql2/promise');
const c = require('./config').db;

const pool = mysql.createPool({
  host: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
  charset: 'utf8mb4', waitForConnections: true, connectionLimit: 10,
});

const run = async (sql, params = []) => (await pool.query(sql, params))[0];
const all = run;
const get = async (sql, params = []) => (await run(sql, params))[0];

const schema = [
  `CREATE TABLE IF NOT EXISTS bots(
    id VARCHAR(40) PRIMARY KEY, name VARCHAR(255), system_prompt TEXT, welcome TEXT, color VARCHAR(20),
    fallback TEXT NULL, allowed_origins TEXT, flows MEDIUMTEXT, created_at BIGINT
  ) CHARACTER SET utf8mb4`,
  `CREATE TABLE IF NOT EXISTS sources(
    id INT AUTO_INCREMENT PRIMARY KEY, bot_id VARCHAR(40), type VARCHAR(20), name VARCHAR(1000), chunks INT, created_at BIGINT,
    KEY idx_bot (bot_id)
  ) CHARACTER SET utf8mb4`,
  `CREATE TABLE IF NOT EXISTS chunks(
    id INT AUTO_INCREMENT PRIMARY KEY, bot_id VARCHAR(40), source_id INT, text MEDIUMTEXT, embedding MEDIUMBLOB, model VARCHAR(120),
    KEY idx_bot (bot_id), KEY idx_source (source_id)
  ) CHARACTER SET utf8mb4`,
  `CREATE TABLE IF NOT EXISTS logs(
    id INT AUTO_INCREMENT PRIMARY KEY, bot_id VARCHAR(40), \`session\` VARCHAR(80), question TEXT, answer MEDIUMTEXT,
    answered TINYINT, created_at BIGINT, KEY idx_bot_time (bot_id, created_at)
  ) CHARACTER SET utf8mb4`,
  `CREATE TABLE IF NOT EXISTS leads(
    id INT AUTO_INCREMENT PRIMARY KEY, bot_id VARCHAR(40), flow VARCHAR(80), data MEDIUMTEXT, created_at BIGINT,
    KEY idx_bot (bot_id)
  ) CHARACTER SET utf8mb4`,
];

async function init() {
  if (!c.user || !c.database) throw new Error('Set DB_USER, DB_PASSWORD and DB_NAME in .env (create the database in aaPanel first)');
  for (const sql of schema) await pool.query(sql);
}

module.exports = { run, all, get, init, pool };
