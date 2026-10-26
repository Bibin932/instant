// Swappable LLM providers: anthropic (paid) | openai-compatible (Groq, Gemini, Ollama, OpenRouter, OpenAI...)
const cfg = require('./config').llm;

let client;
async function* stream({ system, messages }) {
  if (cfg.provider === 'anthropic') {
    const Anthropic = require('@anthropic-ai/sdk');
    client ||= new Anthropic({ apiKey: cfg.apiKey });
    const s = client.messages.stream({ model: cfg.model, max_tokens: cfg.maxTokens, system, messages });
    for await (const ev of s) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') yield ev.delta.text;
    }
  } else if (cfg.provider === 'openai-compatible') {
    const OpenAI = require('openai');
    client ||= new OpenAI({ apiKey: cfg.apiKey || 'none', baseURL: cfg.baseURL });
    const s = await client.chat.completions.create({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      stream: true,
      messages: [{ role: 'system', content: system }, ...messages],
    });
    for await (const chunk of s) {
      const t = chunk.choices?.[0]?.delta?.content;
      if (t) yield t;
    }
  } else {
    throw new Error(`Unknown LLM_PROVIDER "${cfg.provider}"`);
  }
}
module.exports = { stream };
