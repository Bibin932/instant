/* Embeddable chatbot widget. Usage:
   <script src="https://YOUR-SERVER/widget.js" data-bot-id="bot_xxx"></script>
   Optional: data-color="#0a7" data-api="https://other-server" */
(function () {
  const script = document.currentScript;
  const botId = script && script.dataset.botId;
  if (!botId) return console.warn('chatbot: data-bot-id is missing');
  const API = script.dataset.api || new URL(script.src).origin;

  let sid;
  try {
    sid = localStorage.getItem('cb_sid_' + botId);
    if (!sid) { sid = crypto.randomUUID(); localStorage.setItem('cb_sid_' + botId, sid); }
  } catch { sid = crypto.randomUUID(); }

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .launcher { position: fixed; right: 20px; bottom: 20px; width: 56px; height: 56px; border: 0; border-radius: 50%;
      background: var(--c); color: #fff; cursor: pointer; display: grid; place-items: center; z-index: 2147483000;
      box-shadow: 0 4px 16px rgba(0,0,0,.25); }
    .launcher:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid #fff; outline-offset: -5px; box-shadow: 0 0 0 2px var(--c); }
    .panel { position: fixed; right: 20px; bottom: 88px; width: 370px; max-width: calc(100vw - 24px); height: 540px;
      max-height: calc(100vh - 110px); background: #fff; color: #1b1f24; border-radius: 14px; display: none;
      flex-direction: column; overflow: hidden; z-index: 2147483000; box-shadow: 0 12px 40px rgba(0,0,0,.28); }
    .panel.open { display: flex; }
    header { background: var(--c); color: #fff; padding: 14px 16px; font-weight: 600; font-size: 15px; display: flex; justify-content: space-between; align-items: center; }
    header button { background: none; border: 0; color: #fff; font-size: 22px; cursor: pointer; line-height: 1; }
    .msgs { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 8px; background: #f5f6f8; }
    .m { max-width: 86%; padding: 9px 12px; border-radius: 12px; font-size: 14.5px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
    .bot { background: #fff; align-self: flex-start; border: 1px solid #e3e6ea; border-bottom-left-radius: 4px; }
    .user { background: var(--c); color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
    .m a { color: inherit; text-decoration: underline; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; align-self: flex-start; }
    .chips button { border: 1px solid var(--c); color: var(--c); background: #fff; border-radius: 16px; padding: 6px 12px; font-size: 13.5px; cursor: pointer; }
    .chips button:hover { background: var(--c); color: #fff; }
    .dots span { display: inline-block; width: 6px; height: 6px; margin: 0 2px; border-radius: 50%; background: #9aa3ad; animation: b 1.2s infinite; }
    .dots span:nth-child(2) { animation-delay: .15s; } .dots span:nth-child(3) { animation-delay: .3s; }
    @keyframes b { 0%, 60%, 100% { opacity: .3 } 30% { opacity: 1 } }
    @media (prefers-reduced-motion: reduce) { .dots span { animation: none; opacity: .6; } }
    form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #e3e6ea; background: #fff; }
    input { flex: 1; border: 1px solid #cfd5dc; border-radius: 20px; padding: 9px 14px; font-size: 14.5px; color: #1b1f24; background: #fff; }
    form button { border: 0; background: var(--c); color: #fff; border-radius: 20px; padding: 0 16px; font-size: 14px; cursor: pointer; }
    form button:disabled { opacity: .5; cursor: default; }
    @media (max-width: 480px) { .panel { right: 0; bottom: 0; width: 100vw; max-width: 100vw; height: 100vh; max-height: 100vh; border-radius: 0; } }
  </style>
  <button class="launcher" aria-label="Open chat"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg></button>
  <section class="panel" role="dialog" aria-label="Chat">
    <header><span class="title">Chat</span><button class="close" aria-label="Close chat">&times;</button></header>
    <div class="msgs" aria-live="polite"></div>
    <form><input type="text" placeholder="Type your message" aria-label="Message" maxlength="1000" autocomplete="off"><button type="submit">Send</button></form>
  </section>`;

  const $ = (s) => root.querySelector(s);
  const panel = $('.panel'), msgs = $('.msgs'), input = $('input'), sendBtn = $('form button');
  host.style.setProperty('--c', script.dataset.color || '#2b5cff');
  root.host.style.cssText = '--c:' + (script.dataset.color || '#2b5cff');

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const render = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

  function addMsg(text, who) {
    const el = document.createElement('div');
    el.className = 'm ' + who;
    el.innerHTML = render(text);
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }
  function addChips(options, onPick) {
    const wrap = document.createElement('div');
    wrap.className = 'chips';
    options.forEach((o) => {
      const b = document.createElement('button');
      b.textContent = o.label;
      b.onclick = () => { wrap.remove(); onPick(o); };
      wrap.appendChild(b);
    });
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
  }

  let busy = false;
  async function send(text, shown) {
    if (busy || !text.trim()) return;
    busy = true; sendBtn.disabled = true;
    addMsg(shown || text, 'user');
    const typing = document.createElement('div');
    typing.className = 'm bot dots';
    typing.innerHTML = '<span></span><span></span><span></span>';
    msgs.appendChild(typing);
    msgs.scrollTop = msgs.scrollHeight;
    let live = null, raw = '';
    try {
      const r = await fetch(API + '/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botId, sessionId: sid, message: text }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Request failed');
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!line.startsWith('data: ')) continue;
          const ev = JSON.parse(line.slice(6));
          typing.remove();
          if (ev.type === 'token') {
            if (!live) { live = addMsg('', 'bot'); raw = ''; }
            raw += ev.text; live.innerHTML = render(raw); msgs.scrollTop = msgs.scrollHeight;
          } else if (ev.type === 'message' || ev.type === 'error') {
            live = null;
            addMsg(ev.text, 'bot');
            if (ev.options && ev.options.length) addChips(ev.options.map((o) => ({ label: o, message: o })), (o) => send(o.message, o.label));
          }
        }
      }
    } catch (e) {
      typing.remove();
      addMsg(e.message || 'Connection problem. Please try again.', 'bot');
    }
    typing.remove();
    busy = false; sendBtn.disabled = false; input.focus();
  }

  $('form').onsubmit = (e) => { e.preventDefault(); const v = input.value; input.value = ''; send(v); };
  $('.launcher').onclick = () => { panel.classList.toggle('open'); if (panel.classList.contains('open')) input.focus(); };
  $('.close').onclick = () => panel.classList.remove('open');

  fetch(API + '/api/bots/' + botId + '/config').then((r) => r.json()).then((c) => {
    if (c.error) return console.warn('chatbot:', c.error);
    $('.title').textContent = c.name;
    if (!script.dataset.color && c.color) root.host.style.cssText = '--c:' + c.color;
    addMsg(c.welcome, 'bot');
    if (c.buttons && c.buttons.length) addChips(c.buttons, (b) => send(b.message, b.label));
  }).catch(() => console.warn('chatbot: could not reach ' + API));
})();
