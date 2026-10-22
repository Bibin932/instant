const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const eventId = (params.get('event') || 'wedding-demo').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'wedding-demo';
const eventName = eventId.split(/[-_]/).map(x => x ? x[0].toUpperCase() + x.slice(1) : '').join(' ') || 'The Celebration';
const SAVE_KEY = `momentra:${eventId}:album`;

let items = [], matchIds = null, tab = 'all', view = 'all', filtered = [], currentIndex = 0;
let selfieBlob = null, selfieThumb = '', stream = null, searching = false, lastSearchCount = 0;

$('#year').textContent = new Date().getFullYear();
$('#gateEvent').textContent = eventName.toUpperCase();
$('#albumEvent').textContent = eventName.toUpperCase();

const isVideo = i => i.kind === 'video' || i.mimeType?.startsWith('video/');
const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(window.tt); window.tt = setTimeout(() => el.classList.remove('show'), 2600); }
function status(msg, kind = '') { const el = $('#faceStatus'); el.textContent = msg; el.className = 'face-status ' + kind; }
const show = (el, on = true) => $(el).classList.toggle('hidden', !on);

/* ---------- screens ---------- */
function showGate() { stopCamera(); show('#gate', true); show('#album', false); resetScan(); window.scrollTo({ top: 0 }); }
function showAlbum() { stopCamera(); show('#gate', false); show('#album', true); render(); window.scrollTo({ top: 0 }); }

/* ---------- camera ---------- */
function stopCamera() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } $('#camVideo').srcObject = null; $('#stage').classList.remove('live'); }
function resetScan() {
  selfieBlob = null; $('#selfiePreview').classList.add('hidden'); $('#camVideo').classList.remove('hidden');
  show('#stageIdle', true); show('#stageBusy', false); $('#stage').classList.remove('scanning', 'captured');
  show('#cameraBtn', true); show('#captureBtn', false); show('#searchBtn', false); show('#retakeBtn', false);
  status('Center your face in the oval, in good light.');
}
async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { status('Live camera is not available here — opening your camera app instead.'); return pickFile(true); }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
    $('#camVideo').srcObject = stream;
    $('#stage').classList.add('live'); show('#stageIdle', false);
    show('#cameraBtn', false); show('#captureBtn', true);
    status('Look straight at the camera, then tap Capture.');
  } catch { status('Camera permission was blocked. Allow camera access, or choose a photo instead.', 'err'); }
}
function capture() {
  const v = $('#camVideo'); if (!v.videoWidth) return status('Camera is still starting — try again.', 'err');
  const max = 1024, s = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  c.toBlob(b => b ? setSelfie(b) : status('Could not capture. Please retry.', 'err'), 'image/jpeg', 0.9);
}
function pickFile(useCamera) {
  const input = $('#selfieInput'); if (useCamera) input.setAttribute('capture', 'user'); else input.removeAttribute('capture'); input.click();
}
function setSelfie(blob) {
  stopCamera(); selfieBlob = blob;
  if (selfieThumb) URL.revokeObjectURL(selfieThumb);
  selfieThumb = URL.createObjectURL(blob);
  const img = $('#selfiePreview'); img.src = selfieThumb; img.classList.remove('hidden'); $('#camVideo').classList.add('hidden');
  $('#stage').classList.add('captured'); show('#stageIdle', false);
  show('#cameraBtn', false); show('#captureBtn', false); show('#searchBtn', true); show('#retakeBtn', true);
  status('Looks good? Tick consent and tap “Find my photos”.');
}
$('#cameraBtn').onclick = openCamera;
$('#captureBtn').onclick = capture;
$('#retakeBtn').onclick = () => { resetScan(); openCamera(); };
$('#uploadSelfieBtn').onclick = () => pickFile(false);
$('#selfieInput').onchange = e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) return status('Please choose a JPEG, PNG or WebP image.', 'err');
  setSelfie(f);
};
$('#skipBtn').onclick = () => { tab = 'all'; showAlbum(); syncTabs(); };

/* ---------- AI face search (same endpoint as before) ---------- */
async function runSearch(silent = false) {
  if (!selfieBlob || searching) return;
  searching = true;
  if (!silent) { $('#stage').classList.add('scanning'); show('#stageBusy', true); show('#searchBtn', false); show('#retakeBtn', false); status('Scanning faces across the event gallery…'); }
  try {
    const form = new FormData(); form.append('selfie', selfieBlob, 'selfie.jpg');
    const r = await fetch(`/api/events/${encodeURIComponent(eventId)}/search`, { method: 'POST', body: form });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Face search failed.');
    matchIds = new Set((data.matches || []).map(m => m.id));
    lastSearchCount = items.length;
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ ids: [...matchIds], at: Date.now() })); } catch {}
    if (!silent) { tab = 'mine'; view = 'all'; syncTabs(); showAlbum(); }
    else render();
  } catch (e) {
    if (!silent) {
      $('#stage').classList.remove('scanning'); show('#stageBusy', false); show('#searchBtn', true); show('#retakeBtn', true);
      status(e.message || 'Face search failed. Please try again.', 'err');
    }
  } finally { searching = false; }
}
$('#searchBtn').onclick = () => {
  if (!selfieBlob) return status('Take a selfie first.', 'err');
  if (!$('#faceConsent').checked) { $('#faceConsent').closest('label').classList.add('shake'); setTimeout(() => $('#faceConsent').closest('label').classList.remove('shake'), 500); return status('Please tick the consent box to continue.', 'err'); }
  runSearch(false);
};

/* ---------- album / gallery ---------- */
function syncTabs() {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.view === view));
}
function list() {
  let l = items.filter(x => tab === 'all' || (matchIds && matchIds.has(x.id)));
  if (view !== 'all') l = l.filter(x => view === 'video' ? isVideo(x) : !isVideo(x));
  const s = $('#sortSelect').value;
  return l.sort((a, b) => s === 'oldest' ? new Date(a.uploadedAt) - new Date(b.uploadedAt) : new Date(b.uploadedAt) - new Date(a.uploadedAt));
}
function render() {
  filtered = list();
  const mine = matchIds ? items.filter(x => matchIds.has(x.id)).length : 0;
  $('#mineCount').textContent = mine; $('#allCount').textContent = items.length;
  const hasAlbum = !!matchIds;
  $('#albumTitle').textContent = tab === 'mine' ? 'Your album' : 'All event photos';
  $('#albumSub').textContent = tab === 'mine' ? `${mine} moment${mine === 1 ? '' : 's'} with you` : `${items.length} moments shared`;
  $('#tabMine').style.display = hasAlbum ? '' : 'none';
  if (!hasAlbum && tab === 'mine') tab = 'all';
  const av = $('#meAvatar');
  av.innerHTML = selfieThumb ? `<img src="${selfieThumb}" alt="You">` : (hasAlbum ? '☺' : '✦');
  $('#rescanBtn').textContent = hasAlbum ? '◎ Rescan face' : '◎ Find my photos';
  $('#saveAllBtn').disabled = filtered.filter(x => !isVideo(x)).length === 0;

  $('#gallery').innerHTML = filtered.map((it, i) => `<article class="media-card" data-index="${i}" tabindex="0" role="button" aria-label="Open ${esc(it.originalName)}">
    ${isVideo(it) ? `<video src="${it.url}" preload="metadata" muted playsinline></video><span class="play-badge">▶</span>` : `<img src="${it.url}" loading="lazy" alt="${esc(it.originalName)}" onerror="this.style.display='none'">`}
    <a class="dl-btn" href="${it.url}" download="${esc(it.originalName || 'moment')}" aria-label="Save" onclick="event.stopPropagation()">↓</a></article>`).join('');
  $('#gallery').style.display = filtered.length ? '' : 'none';

  const e = $('#emptyState'); e.classList.toggle('show', filtered.length === 0);
  if (!filtered.length) {
    const mineEmpty = tab === 'mine';
    $('#emptyIcon').textContent = mineEmpty ? '☺' : '✧';
    $('#emptyTitle').textContent = mineEmpty ? 'No photos of you yet' : 'Your gallery is waiting';
    $('#emptyText').textContent = mineEmpty ? 'Try a brighter, front-facing selfie — and check back soon, new photos are added live.' : 'New photos will appear here as soon as they are shot.';
    show('#emptyAction', mineEmpty);
  }
  document.querySelectorAll('.media-card').forEach(c => {
    const open = () => openLightbox(Number(c.dataset.index));
    c.onclick = open; c.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
}
async function loadGallery() {
  try {
    const r = await fetch(`/api/events/${encodeURIComponent(eventId)}`); if (!r.ok) throw 0;
    const d = await r.json(); const grew = (d.items || []).length > items.length; items = d.items || [];
    if ($('#album').classList.contains('hidden') === false) render();
    // new photos arrived while we still hold the selfie in memory → refresh the album quietly
    if (grew && selfieBlob && items.length > lastSearchCount) runSearch(true);
  } catch { /* keep last state */ }
}
document.querySelectorAll('.tab').forEach(t => t.onclick = () => { tab = t.dataset.tab; syncTabs(); render(); });
document.querySelectorAll('.chip').forEach(c => c.onclick = () => { view = c.dataset.view; syncTabs(); render(); });
$('#sortSelect').onchange = render;
$('#rescanBtn').onclick = showGate;
$('#emptyAction').onclick = showGate;

/* ---------- save ---------- */
$('#saveAllBtn').onclick = async () => {
  const photos = filtered.filter(x => !isVideo(x));
  if (!photos.length) return;
  toast(`Saving ${photos.length} photo${photos.length > 1 ? 's' : ''}…`);
  for (const p of photos) { const a = document.createElement('a'); a.href = p.url; a.download = p.originalName || 'moment'; document.body.appendChild(a); a.click(); a.remove(); await new Promise(r => setTimeout(r, 350)); }
};

/* ---------- lightbox ---------- */
function openLightbox(i) {
  if (!filtered.length) return;
  currentIndex = (i + filtered.length) % filtered.length; const it = filtered[currentIndex];
  $('#lightboxContent').innerHTML = isVideo(it) ? `<video src="${it.url}" controls autoplay playsinline></video>` : `<img src="${it.url}" alt="${esc(it.originalName)}">`;
  $('#lightboxCaption').textContent = `${currentIndex + 1} / ${filtered.length}`;
  const s = $('#lightboxSave'); s.href = it.url; s.download = it.originalName || 'moment';
  show('#lightbox', true);
}
function closeLightbox() { show('#lightbox', false); $('#lightboxContent').innerHTML = ''; }
$('#lightboxClose').onclick = closeLightbox;
$('#prevMedia').onclick = () => openLightbox(currentIndex - 1);
$('#nextMedia').onclick = () => openLightbox(currentIndex + 1);
$('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') closeLightbox(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeLightbox(); show('#shareSheet', false); }
  if ($('#lightbox').classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft') openLightbox(currentIndex - 1); if (e.key === 'ArrowRight') openLightbox(currentIndex + 1);
});
let tx = 0; $('#lightbox').addEventListener('touchstart', e => tx = e.touches[0].clientX, { passive: true });
$('#lightbox').addEventListener('touchend', e => { const d = e.changedTouches[0].clientX - tx; if (Math.abs(d) > 60) openLightbox(currentIndex + (d < 0 ? 1 : -1)); });

/* ---------- share / QR (same /api/qr endpoint) ---------- */
async function loadQr() {
  try { const r = await fetch(`/api/qr/${encodeURIComponent(eventId)}`); const d = await r.json(); if (!r.ok) throw 0; $('#qrImage').src = d.dataUrl; $('#qrImage').dataset.url = d.url; $('#qrPlaceholder').style.display = 'none'; }
  catch { $('#qrPlaceholder').textContent = 'QR unavailable'; }
}
$('#shareBtn').onclick = () => show('#shareSheet', true);
$('#sheetClose').onclick = () => show('#shareSheet', false);
$('#shareSheet').addEventListener('click', e => { if (e.target.id === 'shareSheet') show('#shareSheet', false); });
$('#downloadQr').onclick = () => { const i = $('#qrImage'); if (!i.src || !i.dataset.url) return toast('QR is not ready yet.'); const a = document.createElement('a'); a.href = i.src; a.download = `${eventId}-qr.png`; a.click(); };
$('#copyLink').onclick = async () => {
  const url = $('#qrImage').dataset.url || location.href;
  try { if (navigator.share) await navigator.share({ title: `${eventName} gallery`, url }); else { await navigator.clipboard.writeText(url); toast('Gallery link copied!'); } }
  catch (e) { if (e.name !== 'AbortError') toast('Copy this link: ' + url); }
};

/* ---------- boot ---------- */
(async function boot() {
  loadQr();
  await loadGallery();
  let saved = null; try { saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch {}
  if (saved?.ids?.length) { matchIds = new Set(saved.ids); tab = 'mine'; syncTabs(); showAlbum(); toast('Welcome back — your album is ready.'); }
  else showGate();
  setInterval(loadGallery, 12000);
})();
