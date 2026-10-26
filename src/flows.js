// Flow engine: guided conversations defined as JSON per bot.
const validators = {
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  phone: (v) => /^[+\d][\d\s\-()]{6,}$/.test(v),
  number: (v) => v !== '' && !isNaN(+v),
  required: (v) => v.length > 0,
};
const fill = (s, data) => s.replace(/\{(\w+)\}/g, (_, k) => data[k] ?? '');

function match(flows, message) {
  const m = message.toLowerCase().trim();
  if (m.startsWith('flow:')) return flows.find((f) => f.id === m.slice(5));
  if (m.length > 60) return null; // long questions go to the knowledge base, not a flow
  return flows.find((f) => (f.triggers || []).some((t) => m.includes(t.toLowerCase())));
}

// state = { flowId, i, data, waiting }. Returns { out: [{text, options}], done }
async function advance(flow, state, input, ctx) {
  const out = [];
  if (state.waiting) {
    const step = flow.steps[state.i];
    const v = (input || '').trim();
    if (/^(cancel|stop|exit)$/i.test(v)) return { out: [{ text: 'No problem, I have cancelled that.' }], done: true };
    if (step.validate && validators[step.validate] && !validators[step.validate](v)) {
      return { out: [{ text: step.error || "That doesn't look right. Please try again, or type cancel to stop.", options: step.options }], done: false };
    }
    if (step.save) state.data[step.save] = v;
    state.waiting = false;
    state.i++;
  }
  while (state.i < flow.steps.length) {
    const s = flow.steps[state.i];
    if (s.say) {
      out.push({ text: fill(s.say, state.data) });
    } else if (s.ask) {
      out.push({ text: fill(s.ask, state.data), options: s.options });
      state.waiting = true;
      return { out, done: false };
    } else if (s.action === 'save_lead') {
      await ctx.saveLead(flow.id, state.data);
    } else if (s.action === 'webhook') {
      try {
        await fetch(s.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ flow: flow.id, botId: ctx.botId, data: state.data }),
          signal: AbortSignal.timeout(8000),
        });
      } catch (e) { console.error('webhook failed:', e.message); }
    }
    state.i++;
  }
  return { out, done: true };
}

const defaultFlows = [
  {
    id: 'contact',
    button: 'Talk to sales',
    triggers: ['contact', 'pricing', 'talk to sales', 'book a demo'],
    steps: [
      { ask: "Happy to help. What's your name?", save: 'name', validate: 'required' },
      { ask: 'Thanks {name}. What is your email?', save: 'email', validate: 'email', error: 'Please enter a valid email address.' },
      { ask: 'What would you like help with?', save: 'message', validate: 'required' },
      { action: 'save_lead' },
      { say: 'Thanks {name}, we have your details and will email you at {email} soon.' },
    ],
  },
];

module.exports = { match, advance, defaultFlows };
