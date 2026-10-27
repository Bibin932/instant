// Load .env from the project folder no matter where pm2/aaPanel starts the app from
const envPath = require('path').join(__dirname, '../.env');
const envFound = require('fs').existsSync(envPath);
require('dotenv').config({ path: envPath });
const e = process.env;
module.exports = {
  envPath,
  envFound,
  port: +e.PORT || 3000,
  adminKey: e.ADMIN_KEY || 'change-me',
  llm: {
    provider: e.LLM_PROVIDER || 'anthropic',
    apiKey: e.LLM_API_KEY || e.ANTHROPIC_API_KEY,
    baseURL: e.LLM_BASE_URL,
    model: e.LLM_MODEL || 'claude-haiku-5-5',
    maxTokens: +e.MAX_TOKENS || 500,
  },
  embed: {
    provider: e.EMBED_PROVIDER || 'local',
    apiKey: e.EMBED_API_KEY,
    baseURL: e.EMBED_BASE_URL,
    model: e.EMBED_MODEL,
  },
  db: { url: e.DATABASE_URL },
  topK: +e.TOP_K || 5,
  minScore: e.MIN_SCORE !== undefined ? +e.MIN_SCORE : 0.25,
  dailyLimit: +e.DAILY_MESSAGE_LIMIT || 500,
  ratePerMin: +e.RATE_PER_MIN || 20,
};
