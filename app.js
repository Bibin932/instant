const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const eventId = params.get('event') || 'wedding-demo';
let items = [], view = 'all', filtered = [], currentIndex = 0;
$('#year').textContent = new Date().getFullYear();
$('#eventTitle').textContent = eventId.split(/[-_]/).map(x => x ? x[0].toUpperCase()+x.slice(1) : '').join(' ') || 'The Celebration';
const isVideo = item => item.kind === 'video' || item.mimeType?.startsWith('video/');
function escapeHtml(s='') { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(msg) { const el=$('#toast'); el.textContent=msg; el.classList.add('show'); clearTimeout(window.toastTimer); window.toastTimer=setTimeout(()=>el.classList.remove('show'),2600); }
function activeItems() {
  const q=$('#searchInput').value.toLowerCase().trim();
  let list=items.filter(x => view==='all' || (view==='video' ? isVideo(x) : !isVideo(x)));
  if(q) list=list.filter(x => (x.originalName||'').toLowerCase().includes(q));
  const sort=$('#sortSelect').value;
  list.sort((a,b)=>sort==='oldest'?new Date(a.uploadedAt)-new Date(b.uploadedAt):sort==='name'?(a.originalName||'').localeCompare(b.originalName||''):new Date(b.uploadedAt)-new Date(a.uploadedAt));
  return list;
}
function render() {
  filtered=activeItems();
  $('#photoCount').textContent=items.filter(x=>!isVideo(x)).length;
  $('#videoCount').textContent=items.filter(isVideo).length;
  $('#gallery').innerHTML=filtered.map((item,i)=>`<article class="media-card" data-index="${i}" tabindex="0" role="button" aria-label="Open ${escapeHtml(item.originalName)}">
    ${isVideo(item)?`<video src="${item.url}" preload="metadata" muted playsinline></video><span class="play-badge">▶</span>`:`<img src="${item.url}" loading="lazy" alt="${escapeHtml(item.originalName)}" onerror="this.style.display='none'">`}
    <span class="media-overlay"></span><div class="media-meta"><span class="media-name">${escapeHtml(item.originalName||'Event moment')}</span><span class="media-type">${isVideo(item)?'VIDEO':'PHOTO'}</span></div></article>`).join('');
  $('#emptyState').classList.toggle('show',items.length===0);
  $('#gallery').style.display=items.length===0?'none':'block';
  $('#gallery').querySelectorAll('.media-card').forEach(card=>{
    const open=()=>openLightbox(Number(card.dataset.index));
    card.addEventListener('click',open);
    card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});
  });
}
async function loadGallery() {
  try {
    const r=await fetch(`/api/events/${encodeURIComponent(eventId)}`);
    if(!r.ok) throw new Error('Gallery unavailable');
    const data=await r.json(); items=data.items||[]; render();
  } catch(e) { console.error(e); toast('Could not refresh gallery. Check the server connection.'); }
}
function openLightbox(index) {
  if(!filtered.length) return;
  currentIndex=(index+filtered.length)%filtered.length;
  const item=filtered[currentIndex];
  $('#lightboxContent').innerHTML=isVideo(item)?`<video src="${item.url}" controls autoplay playsinline></video>`:`<img src="${item.url}" alt="${escapeHtml(item.originalName)}">`;
  $('#lightboxCaption').textContent=item.originalName||'Event moment';
  $('#lightbox').classList.remove('hidden');
}
function closeLightbox(){ $('#lightbox').classList.add('hidden'); $('#lightboxContent').innerHTML=''; }
$('#lightboxClose').onclick=closeLightbox;
$('#prevMedia').onclick=()=>openLightbox(currentIndex-1);
$('#nextMedia').onclick=()=>openLightbox(currentIndex+1);
$('#lightbox').addEventListener('click',e=>{if(e.target.id==='lightbox')closeLightbox();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeLightbox();if(!$('#lightbox').classList.contains('hidden')&&e.key==='ArrowLeft')openLightbox(currentIndex-1);if(!$('#lightbox').classList.contains('hidden')&&e.key==='ArrowRight')openLightbox(currentIndex+1);});
document.querySelectorAll('.view-btn').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.view-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');view=btn.dataset.view;render();}));
$('#searchInput').addEventListener('input',render); $('#sortSelect').addEventListener('change',render);
function chooseFiles(){ $('#fileInput').click(); }
$('#uploadJump').onclick=()=>$('#uploadSection').scrollIntoView({behavior:'smooth'});
$('#emptyUpload').onclick=()=>{ $('#uploadSection').scrollIntoView({behavior:'smooth'}); chooseFiles(); };
$('#uploadBtn').onclick=chooseFiles;
$('#fileInput').addEventListener('change',()=>{const files=[...$('#fileInput').files];$('#uploadQueue').textContent=files.length?`${files.length} file(s) selected · ${(files.reduce((n,f)=>n+f.size,0)/1024/1024).toFixed(1)} MB total`:'';$('#uploadBtn').textContent=files.length?'Upload '+files.length+' file(s)':'Choose photos & videos';});
const drop=$('#dropzone');
drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('dragover');});
drop.addEventListener('dragleave',()=>drop.classList.remove('dragover'));
drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('dragover');if(e.dataTransfer.files.length){uploadFiles([...e.dataTransfer.files]);}});
function uploadFiles(files) {
  if(!files.length)return;
  const data=new FormData();files.forEach(f=>data.append('files',f));
  $('#uploadStatus').textContent='Uploading… please keep this page open.';
  $('#uploadBtn').disabled=true;
  const xhr=new XMLHttpRequest();
  xhr.open('POST',`/api/upload/${encodeURIComponent(eventId)}`);
  xhr.upload.onprogress=e=>{if(e.lengthComputable)$('#uploadStatus').textContent=`Uploading… ${Math.round(e.loaded/e.total*100)}%`;};
  xhr.onload=()=>{ $('#uploadBtn').disabled=false;$('#fileInput').value='';$('#uploadQueue').textContent='';$('#uploadBtn').textContent='Choose photos & videos';
    let result={};try{result=JSON.parse(xhr.responseText);}catch{}
    if(xhr.status>=200&&xhr.status<300){$('#uploadStatus').textContent=`✓ ${result.uploaded} file(s) added to the gallery`;toast('Your memories are now in the gallery!');loadGallery();}
    else $('#uploadStatus').textContent=result.error||'Upload failed. Please try again.';
  };
  xhr.onerror=()=>{$('#uploadBtn').disabled=false;$('#uploadStatus').textContent='Network error. Try again when connected.';};
  xhr.send(data);
}
$('#uploadBtn').addEventListener('click',()=>{const files=[...$('#fileInput').files];if(!files.length){chooseFiles();return;}uploadFiles(files);});
$('#qrJump').onclick=()=>$('#qrSection').scrollIntoView({behavior:'smooth'});
async function loadQr(){
  try{const r=await fetch(`/api/qr/${encodeURIComponent(eventId)}`);const data=await r.json();if(!r.ok)throw new Error(data.error);$('#qrImage').src=data.dataUrl;$('#qrPlaceholder').style.display='none';$('#qrImage').dataset.url=data.url;}
  catch(e){$('#qrPlaceholder').textContent='QR unavailable';}
}
$('#downloadQr').onclick=()=>{const img=$('#qrImage');if(!img.src||!img.dataset.url)return toast('QR code is not ready yet.');const a=document.createElement('a');a.href=img.src;a.download=`${eventId}-qr.png`;a.click();};
$('#copyLink').onclick=async()=>{try{await navigator.clipboard.writeText($('#qrImage').dataset.url||location.href);toast('Gallery link copied!');}catch{toast('Copy this link: '+location.href);}};
$('#shareBtn').onclick=async()=>{const url=$('#qrImage').dataset.url||location.href;try{if(navigator.share)await navigator.share({title:$('#eventTitle').textContent+' gallery',text:'View and share the event photos',url});else{await navigator.clipboard.writeText(url);toast('Gallery link copied!');}}catch(e){if(e.name!=='AbortError')toast('Share the gallery link from your browser.');}};
// Face-match UI is deliberately privacy-aware: no face data is uploaded by this MVP.
$('#faceBtn').onclick=()=>$('#facePanel').classList.toggle('hidden');
$('#closeFace').onclick=()=>$('#facePanel').classList.add('hidden');
$('#matchFaceBtn').onclick=()=>{const f=$('#selfieInput').files[0];$('#faceStatus').textContent=f?'Face matching model is not bundled. See README to configure a local browser model; no selfie has been uploaded.':'Please choose a selfie first.';};
loadGallery();loadQr();setInterval(loadGallery,12000);
