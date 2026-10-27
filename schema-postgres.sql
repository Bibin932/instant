-- Optional: run this in Supabase > SQL Editor if you want to create the tables by hand.
CREATE TABLE IF NOT EXISTS bots(id VARCHAR(40) PRIMARY KEY, name TEXT, system_prompt TEXT, welcome TEXT, color VARCHAR(20), fallback TEXT, allowed_origins TEXT, flows TEXT, created_at BIGINT, mode VARCHAR(10) DEFAULT 'hybrid');
CREATE TABLE IF NOT EXISTS sources(id SERIAL PRIMARY KEY, bot_id VARCHAR(40), type VARCHAR(20), name TEXT, chunks INT, created_at BIGINT);
CREATE TABLE IF NOT EXISTS chunks(id SERIAL PRIMARY KEY, bot_id VARCHAR(40), source_id INT, text TEXT, embedding BYTEA, model VARCHAR(120));
CREATE TABLE IF NOT EXISTS logs(id SERIAL PRIMARY KEY, bot_id VARCHAR(40), session VARCHAR(80), question TEXT, answer TEXT, answered SMALLINT, created_at BIGINT);
CREATE TABLE IF NOT EXISTS leads(id SERIAL PRIMARY KEY, bot_id VARCHAR(40), flow VARCHAR(80), data TEXT, created_at BIGINT);
CREATE INDEX IF NOT EXISTS idx_sources_bot ON sources(bot_id);
CREATE INDEX IF NOT EXISTS idx_chunks_bot ON chunks(bot_id);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);
CREATE INDEX IF NOT EXISTS idx_logs_bot_time ON logs(bot_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_bot ON leads(bot_id);
ALTER TABLE bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
-- Already created the tables earlier? Run just this line:
ALTER TABLE bots ADD COLUMN IF NOT EXISTS mode VARCHAR(10) DEFAULT 'hybrid';
