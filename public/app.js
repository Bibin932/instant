const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const eventId = params.get('event') || 'wedding-demo';
let items = [], view = 'all', filtered = [], currentIndex = 0;
let faceMatches = null;
let faceModelsReady = false;
$('#year').textContent = new Date().getFullYear();
$('#eventTitle').textContent = eventId.split(/[-_]/).map(x => x ? x[0].toUpperCase()+x.slice(1) : '').join(' ') || 'The Celebration';
const isVideo = item => item.kind === 'video' || item.mimeType?.startsWith('video/');
function escapeHtml(s='') { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(msg) { const el=$('#toast'); el.textContent=msg; el.classList.add('show'); clearTimeout(window.toastTimer); window.toastTimer=setTimeout(()=>el.classList.remove('show'),2600); }
function activeItems() {
  const q=$('#searchInput').value.toLowerCase().trim();
  let list=items.filter(x => view==='all' || (view==='video' ? isVideo(x) : !isVideo(x)));
  if(q) list=list.filter(x => (x.originalName||'').toLowerCase().includes(q));
  if(faceMatches) list=list.filter(x => faceMatches.has(x.id));
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
  $('#emptyState').classList.toggle('show',filtered.length===0);
  $('#gallery').style.display=filtered.length===0?'none':'block';
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
$('#qrJump').onclick=()=>$('#qrSection').scrollIntoView({behavior:'smooth'});
async function loadQr(){
  try{const r=await fetch(`/api/qr/${encodeURIComponent(eventId)}`);const data=await r.json();if(!r.ok)throw new Error(data.error);$('#qrImage').src=data.dataUrl;$('#qrPlaceholder').style.display='none';$('#qrImage').dataset.url=data.url;}
  catch(e){$('#qrPlaceholder').textContent='QR unavailable';}
}
$('#downloadQr').onclick=()=>{const img=$('#qrImage');if(!img.src||!img.dataset.url)return toast('QR code is not ready yet.');const a=document.createElement('a');a.href=img.src;a.download=`${eventId}-qr.png`;a.click();};
$('#copyLink').onclick=async()=>{try{await navigator.clipboard.writeText($('#qrImage').dataset.url||location.href);toast('Gallery link copied!');}catch{toast('Copy this link: '+location.href);}};
$('#shareBtn').onclick=async()=>{const url=$('#qrImage').dataset.url||location.href;try{if(navigator.share)await navigator.share({title:$('#eventTitle').textContent+' gallery',text:'View and share the event photos',url});else{await navigator.clipboard.writeText(url);toast('Gallery link copied!');}}catch(e){if(e.name!=='AbortError')toast('Share the gallery link from your browser.');}};
// Face matching runs locally in the guest's browser. The selfie and descriptors are never sent to the server.
$('#faceJump').onclick=()=>$('#faceSearchSection').scrollIntoView({behavior:'smooth',block:'center'});
$('#clearFaceMatches').onclick=()=>{faceMatches=null;$('#clearFaceMatches').classList.add('hidden');$('#faceStatus').textContent='Showing all event photos.';render();};
async function ensureFaceModels(){
  if(faceModelsReady)return;
  if(!window.faceapi)throw new Error('Face recognition library could not load. Check your internet connection and refresh.');
  const modelUrl='https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights';
  $('#faceStatus').textContent='Loading face recognition models… this may take a moment on first use.';
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl),
    faceapi.nets.faceLandmark68Net.loadFromUri(modelUrl),
    faceapi.nets.faceRecognitionNet.loadFromUri(modelUrl)
  ]);
  faceModelsReady=true;
}
function loadImage(url){return new Promise((resolve,reject)=>{const img=new Image();img.crossOrigin='anonymous';img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('Could not read a gallery image'));img.src=url;});}
async function descriptorsFor(image){
  const found=await faceapi.detectAllFaces(image,new faceapi.TinyFaceDetectorOptions({inputSize:320,scoreThreshold:0.45})).withFaceLandmarks().withFaceDescriptors();
  return found.map(x=>x.descriptor);
}
function distance(a,b){let sum=0;for(let i=0;i<a.length;i++){const d=a[i]-b[i];sum+=d*d;}return Math.sqrt(sum);}
$('#matchFaceBtn').onclick=async()=>{
  const file=$('#selfieInput').files[0];
  if(!file){$('#faceStatus').textContent='Please take or choose a selfie first.';return;}
  if(!$('#faceConsent').checked){$('#faceStatus').textContent='Please confirm consent before running a face match.';return;}
  if(!file.type.startsWith('image/')){$('#faceStatus').textContent='Please choose an image file.';return;}
  $('#matchFaceBtn').disabled=true;$('#clearFaceMatches').classList.add('hidden');
  try{
    await ensureFaceModels();
    const selfieUrl=URL.createObjectURL(file);
    let selfieDescriptors=[];
    try{const selfie=await loadImage(selfieUrl);selfieDescriptors=await descriptorsFor(selfie);}finally{URL.revokeObjectURL(selfieUrl);}
    if(!selfieDescriptors.length)throw new Error('No clear face was detected. Try a front-facing selfie with good lighting.');
    const reference=selfieDescriptors[0];
    const photos=items.filter(x=>!isVideo(x));
    const matches=new Set();let checked=0;
    for(const item of photos){
      try{const img=await loadImage(item.url);const descriptors=await descriptorsFor(img);if(descriptors.some(d=>distance(reference,d)<0.52))matches.add(item.id);}
      catch(err){console.warn('Skipped face match for',item.originalName,err.message);}
      checked++;
      $('#faceStatus').textContent=`Checking gallery photos… ${checked} of ${photos.length}`;
    }
    faceMatches=matches;view='all';document.querySelectorAll('.view-btn').forEach(b=>b.classList.toggle('active',b.dataset.view==='all'));
    render();$('#clearFaceMatches').classList.remove('hidden');
    $('#faceStatus').textContent=`Found ${matches.size} likely match(es) from ${photos.length} gallery photo(s). This is an estimate, not a guaranteed identification.`;
    document.querySelector('#gallery').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(err){$('#faceStatus').textContent=err.message||'Face matching failed. Please try another photo.';}
  finally{$('#matchFaceBtn').disabled=false;}
};
loadGallery();loadQr();setInterval(loadGallery,12000);
