# Reusable AI Chatbot Platform

One backend, many websites. Each website gets its own bot (own PDFs, web pages, flows) and adds it with one script tag.
Works with a **paid API (Claude)** or a **zero-cost setup** (Groq/Gemini free tiers, or Ollama on your own machine). You switch in `.env`, with no code changes.

## aaPanel setup (VPS)

1. **Database:** aaPanel > Database > Add database. Note the name, username and password. Keep host `127.0.0.1`, port `3306`.
2. **Node.js:** aaPanel > App Store > install **Node.js version manager** (and **PM2 manager**). Install Node 18 or newer (20 recommended).
3. **Upload:** unzip the project into e.g. `/www/wwwroot/chatbot`, then run in a terminal:
   ```bash
   cd /www/wwwroot/chatbot
   npm install
   cp .env.example .env && nano .env     # fill ADMIN_KEY, DB_*, and your LLM settings
   ```
4. **Run:** add it in PM2 manager (startup file `src/server.js`, project dir above) or run `pm2 start src/server.js --name chatbot`. Tables are created automatically on first start.
5. **Domain + HTTPS:** aaPanel > Website > Add site (e.g. `bot.yourdomain.com`) > Reverse proxy to `http://127.0.0.1:3000`, then enable SSL (Let's Encrypt). Turn **off** proxy caching, and if streaming looks choppy add `proxy_buffering off;` in the proxy's config.
6. Open `https://bot.yourdomain.com/admin.html` and your embed snippet will use that domain.

If you chose the free local embeddings and `@xenova/transformers` fails to install, use `EMBED_PROVIDER=openai-compatible` with Ollama or `voyage` instead.

## Quick start (any machine)

```bash
npm install
cp .env.example .env      # then edit: ADMIN_KEY, and your LLM settings
npm start
```

Open http://localhost:3000/admin.html, enter your `ADMIN_KEY`, create a bot, upload a PDF or add a URL, and copy the embed snippet:

```html
<script src="https://YOUR-SERVER/widget.js" data-bot-id="bot_xxxxxxxx"></script>
```

Optional attributes: `data-color="#0a7a5c"` (override the bot color), `data-api="https://..."` (different server).

## Paid vs zero-cost

| | Paid (best quality) | Zero cost |
|---|---|---|
| Answers (LLM) | `LLM_PROVIDER=anthropic` + Claude key (Haiku 5.5 is fast and cheap) | `openai-compatible` + Groq or Gemini free key, or Ollama locally |
| Indexing (embeddings) | `EMBED_PROVIDER=voyage` | `EMBED_PROVIDER=local` (default, free, no key) |

Copy-paste presets are in `.env.example`. Free-tier limits and model names change, so check each provider's docs.
If you change the embedding provider or model, re-add your sources (old vectors are ignored automatically, not mixed).

## How it works

1. **Ingest:** PDF or web page, then text, then ~1200-character chunks, then embeddings stored in MySQL/MariaDB.
2. **Chat:** each message first checks **flows**. If none match, the bot embeds the question and finds the top matching chunks. The LLM answers from only those chunks, and the answer streams to the widget.
3. **Saves money:** if nothing in the knowledge base matches (`MIN_SCORE`), the LLM is not called at all. The bot sends the fallback reply and the question appears in "unanswered" in the admin page. Repeat questions are served from a cache.

## Flows

Edit them per bot in the admin page. Each flow is JSON:

```json
{
  "id": "contact",
  "button": "Talk to sales",
  "triggers": ["pricing", "contact"],
  "steps": [
    { "ask": "What's your name?", "save": "name", "validate": "required" },
    { "ask": "Thanks {name}, your email?", "save": "email", "validate": "email" },
    { "ask": "Which plan?", "save": "plan", "options": ["Basic", "Pro"] },
    { "action": "save_lead" },
    { "action": "webhook", "url": "https://your-site.com/api/leads" },
    { "say": "Thanks {name}, we'll be in touch." }
  ]
}
```

- `button`: shows a quick-reply chip when the chat opens.
- `triggers`: words that start the flow when a short message contains them.
- `validate`: `required`, `email`, `phone`, or `number`.
- Users can type `cancel` at any step.
- Leads appear in the admin page. The webhook sends `{flow, botId, data}`.

## Cost and safety controls

- `DAILY_MESSAGE_LIMIT` caps LLM answers per bot per day. `RATE_PER_MIN` limits each IP.
- Set a monthly spend limit in your Anthropic console too.
- "Allowed websites" in bot settings restricts which domains may use a bot (browser Origin check). Treat it as a convenience, not strong security.
- Keep `ADMIN_KEY` secret and serve over HTTPS in production. The URL ingest fetches any http(s) address you give it, so keep the admin page private.

## Deploying

See "aaPanel setup" below. Any VPS with Node 18+ and MySQL/MariaDB works.

## Scaling later

Vectors are searched in memory, which is fast up to roughly 50k chunks per bot. Beyond that, move `chunks` to Postgres + pgvector or Qdrant (only `src/rag.js` and `src/ingest.js` need to change).
