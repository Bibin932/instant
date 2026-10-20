(() => {
  const $ = (s) => document.querySelector(s);
  const state = { key: '', active: true, timer: null, busy: false };
  const fmtDate = (value) => value ? new Date(value).toLocaleString() : 'Not received';
  const fmtBytes = (bytes) => {
    if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB']; let n = Number(bytes), i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  };
  function toast(message, error = false) {
    const el = $('#toast'); el.textContent = message; el.classList.toggle('error-toast', error); el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3200);
  }
  async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'x-admin-key': state.key, ...(options.headers || {}) }, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error('Admin key is incorrect or ADMIN_KEY is not configured on the server.');
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }
  function setPill(el, text, mode) { el.textContent = text; el.className = `pill ${mode}`; }
  function render(data) {
    $('#dashboard').hidden = false; $('#auth-panel').hidden = true;
    $('#last-refresh').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    $('#server-time').textContent = `Server ${fmtDate(data.serverTime)}`;
    $('#total-transfers').textContent = data.transfers.total.toLocaleString();
    $('#daily-transfers').textContent = data.transfers.last24Hours.toLocaleString();
    $('#photo-count').textContent = data.transfers.photos.toLocaleString();
    $('#video-count').textContent = data.transfers.videos.toLocaleString();
    $('#total-size').textContent = fmtBytes(data.transfers.totalBytes);
    $('#website-status').textContent = data.website.status === 'online' ? 'Online' : 'Offline';
    $('#website-status').className = `pill ${data.website.status === 'online' ? 'online' : 'offline'}`;
    const ftp = data.ftp;
    const statusText = !ftp.connected ? 'Offline' : (ftp.active ? 'Connected · Active' : 'Connected · Paused');
    setPill($('#ftp-pill'), !ftp.connected ? 'Receiver offline' : (ftp.active ? 'Receiver active' : 'Receiver paused'), !ftp.connected ? 'offline' : (ftp.active ? 'online' : 'paused'));
    setPill($('#ftp-status'), statusText, !ftp.connected ? 'offline' : (ftp.active ? 'online' : 'paused'));
    $('#ftp-description').textContent = !ftp.connected ? 'No recent heartbeat. Check the FTP process and hosting ports.' : (ftp.active ? 'Receiver heartbeat detected; ingestion enabled.' : 'Receiver is reachable; ingestion is paused.');
    $('#heartbeat-time').textContent = fmtDate(ftp.lastHeartbeat);
    $('#last-transfer').textContent = fmtDate(data.transfers.lastTransferAt || ftp.lastTransferAt);
    $('#control-state').textContent = !ftp.connected ? 'Receiver offline' : (ftp.active ? 'Active' : 'Paused');
    $('#control-state').className = `control-state ${!ftp.connected ? 'is-offline' : (ftp.active ? 'is-active' : 'is-paused')}`;
    $('#control-title').textContent = !ftp.connected ? 'Receiver not connected' : (ftp.active ? 'Transfers are active' : 'Transfers are paused');
    $('#control-subtitle').textContent = !ftp.connected ? 'Start the FTP receiver process first' : (ftp.active ? 'New stable files will be added to the gallery' : 'New files wait in the FTP inbox');
    $('#big-control').className = `big-control ${!ftp.connected ? 'is-offline' : (ftp.active ? 'is-active' : 'is-paused')}`;
    $('#pause-btn').disabled = state.busy || !ftp.connected || !ftp.active;
    $('#activate-btn').disabled = state.busy || !ftp.connected || ftp.active;
    $('#ftp-error').hidden = !ftp.lastError;
    $('#ftp-error').textContent = ftp.lastError ? `Latest receiver error: ${ftp.lastError}` : '';
    $('#overall-title').textContent = !ftp.connected ? 'Website online · FTP receiver offline' : (ftp.active ? 'All monitored services connected' : 'FTP receiver connected · Transfers paused');
    $('#overall-detail').textContent = !ftp.connected ? 'The website API is responding, but the FTP receiver has not sent a recent heartbeat.' : (ftp.active ? 'The dashboard is receiving a recent FTP heartbeat.' : 'No files will be registered in galleries until transfers are activated.');
    $('#overall-banner').className = `status-banner ${!ftp.connected ? 'has-warning' : (ftp.active ? 'all-good' : 'is-paused')}`;
    const body = $('#recent-body');
    if (!data.recent.length) body.innerHTML = '<tr><td colspan="6" class="empty">No transfers registered yet.</td></tr>';
    else body.innerHTML = data.recent.map(item => `<tr><td><div class="file-cell"><span class="file-icon">${item.kind === 'video' ? '▶' : '▧'}</span><span title="${esc(item.name)}">${esc(item.name)}</span></div></td><td><span class="type-tag ${item.kind === 'video' ? 'video' : 'photo'}">${esc(item.kind || 'file')}</span></td><td><code>${esc(item.eventId || '—')}</code></td><td>${esc(item.source || 'web')}</td><td>${fmtBytes(item.size)}</td><td>${fmtDate(item.uploadedAt)}</td></tr>`).join('');
  }
  function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
  async function refresh(showError = false) {
    if (!state.key || state.busy) return;
    try { render(await api('/api/admin/status')); }
    catch (err) {
      if (showError || /Admin key/.test(err.message)) { $('#auth-panel').hidden = false; $('#dashboard').hidden = true; $('#auth-error').textContent = err.message; }
      else $('#last-refresh').textContent = `Refresh failed: ${err.message}`;
    }
  }
  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault(); state.key = $('#admin-key').value.trim(); $('#auth-error').textContent = '';
    try { render(await api('/api/admin/status')); $('#control-message').textContent = 'Connected to the admin API.'; if (state.timer) clearInterval(state.timer); state.timer = setInterval(() => refresh(), 10000); }
    catch (err) { $('#auth-error').textContent = err.message; state.key = ''; }
  });
  $('#refresh-btn').addEventListener('click', () => refresh(true));
  async function setActive(active) {
    if (!state.key || state.busy) return;
    state.busy = true; $('#pause-btn').disabled = true; $('#activate-btn').disabled = true;
    $('#control-message').textContent = active ? 'Activating transfers…' : 'Pausing transfers…';
    try {
      const result = await api('/api/admin/control', { method: 'POST', body: JSON.stringify({ active }) });
      $('#control-message').textContent = result.message; toast(result.message); await refresh();
    } catch (err) { $('#control-message').textContent = err.message; toast(err.message, true); }
    finally { state.busy = false; await refresh(); }
  }
  $('#pause-btn').addEventListener('click', () => setActive(false));
  $('#activate-btn').addEventListener('click', () => setActive(true));

  $('#admin-upload-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const eventId = $('#upload-event-id').value.trim();
    const files = $('#admin-files').files;
    if (!eventId || !files.length) return;
    const button = $('#admin-upload-btn');
    button.disabled = true; $('#admin-upload-status').textContent = `Uploading ${files.length} file(s)…`;
    const form = new FormData(); for (const file of files) form.append('files', file);
    try {
      const response = await fetch(`/api/admin/upload/${encodeURIComponent(eventId)}`, { method: 'POST', headers: { 'x-admin-key': state.key }, body: form, cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) throw new Error('Admin key is invalid or the server ADMIN_KEY is not configured.');
      if (!response.ok) throw new Error(data.error || `Upload failed (${response.status})`);
      $('#admin-upload-status').textContent = `✓ ${data.uploaded} file(s) added to event “${eventId}”.`;
      $('#admin-files').value = ''; toast(`${data.uploaded} file(s) uploaded successfully.`); await refresh();
    } catch (err) { $('#admin-upload-status').textContent = err.message; toast(err.message, true); }
    finally { button.disabled = false; }
  });
})();
