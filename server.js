import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import mime from 'mime-types';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATA = path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const EVENTS = path.join(DATA, 'events');
const FTP_STATUS_PATH = path.join(DATA, 'ftp-status.json');
const FTP_CONTROL_PATH = path.join(DATA, 'ftp-control.json');
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 250);
for (const dir of [DATA, UPLOADS, EVENTS]) fs.mkdirSync(dir, { recursive: true });

app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(UPLOADS, { maxAge: '1h', fallthrough: false }));

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimiter);

const indexPath = path.join(DATA, 'media-index.json');
function readIndex() {
  try { return JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch { return []; }
}
function writeIndex(items) {
  const temp = `${indexPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(items, null, 2));
  fs.renameSync(temp, indexPath);
}
function safeName(name) {
  return String(name || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-150);
}
function publicItem(item) {
  const { filename, ...rest } = item;
  return { ...rest, url: `/media/${encodeURIComponent(filename)}` };
}
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${randomUUID()}-${safeName(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    const allowed = /^(image\/(jpeg|png|webp|gif|heic|heif)|video\/(mp4|quicktime|webm|x-matroska))$/i.test(file.mimetype);
    cb(allowed ? null : new Error('Only supported image and video formats are allowed.'), allowed);
  }
});

async function backupToDrive(filePath, name, mimeType) {
  if (String(process.env.GOOGLE_DRIVE_BACKUP).toLowerCase() !== 'true') return null;
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) throw new Error('GOOGLE_DRIVE_FOLDER_ID is required when Drive backup is enabled.');
  const auth = new GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || './google-service-account.json',
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });
  const drive = google.drive({ version: 'v3', auth });
  const result = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType: mimeType || mime.lookup(name) || 'application/octet-stream', body: fs.createReadStream(filePath) },
    fields: 'id,name,mimeType,size'
  });
  return result.data;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'Cybercodix Instant Share', time: new Date().toISOString() }));

function adminAuthorized(req) {
  return Boolean(process.env.ADMIN_KEY) && req.get('x-admin-key') === process.env.ADMIN_KEY;
}
function readJsonFile(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}
function writeJsonFile(filePath, value) {
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, filePath);
}
app.get('/api/admin/status', (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ error: 'Admin key is missing or invalid.' });
  const items = readIndex();
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const recent = items.filter(x => Date.parse(x.uploadedAt || '') >= dayAgo);
  const totalBytes = items.reduce((sum, x) => sum + (Number(x.size) || 0), 0);
  const ftp = readJsonFile(FTP_STATUS_PATH, { state: 'unknown', lastHeartbeat: null, processed: 0, lastTransferAt: null, lastError: null });
  const control = readJsonFile(FTP_CONTROL_PATH, { active: true });
  const heartbeatAgeMs = ftp.lastHeartbeat ? now - Date.parse(ftp.lastHeartbeat) : Infinity;
  const ftpConnected = Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs < 45000;
  res.json({
    ok: true,
    serverTime: new Date().toISOString(),
    website: { status: 'online', uptimeSeconds: Math.round(process.uptime()) },
    ftp: { connected: ftpConnected, status: ftpConnected ? (control.active === false ? 'paused' : 'connected') : 'offline', active: control.active !== false, lastHeartbeat: ftp.lastHeartbeat || null, lastTransferAt: ftp.lastTransferAt || null, processed: Number(ftp.processed) || 0, lastError: ftp.lastError || null },
    transfers: { total: items.length, last24Hours: recent.length, photos: items.filter(x => x.kind === 'photo').length, videos: items.filter(x => x.kind === 'video').length, totalBytes, lastTransferAt: items[0]?.uploadedAt || null },
    recent: items.slice(0, 12).map(x => ({ id: x.id, eventId: x.eventId, name: x.originalName || x.filename, kind: x.kind, size: Number(x.size) || 0, uploadedAt: x.uploadedAt, source: x.source || 'web' }))
  });
});
app.post('/api/admin/control', (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ error: 'Admin key is missing or invalid.' });
  if (typeof req.body?.active !== 'boolean') return res.status(400).json({ error: 'Provide active: true or false.' });
  const control = { active: req.body.active, updatedAt: new Date().toISOString() };
  writeJsonFile(FTP_CONTROL_PATH, control);
  res.json({ ok: true, ...control, message: req.body.active ? 'FTP ingestion activated.' : 'FTP ingestion paused.' });
});

app.get('/api/events/:eventId', (req, res) => {
  const items = readIndex().filter(x => x.eventId === req.params.eventId);
  res.json({ eventId: req.params.eventId, items: items.map(publicItem) });
});

app.post('/api/admin/upload/:eventId', (req, res, next) => {
  if (!adminAuthorized(req)) return res.status(401).json({ error: 'Admin key is missing or invalid.' });
  next();
}, upload.array('files', 20), async (req, res) => {
  const eventId = String(req.params.eventId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!eventId) return res.status(400).json({ error: 'Invalid event ID.' });
  if (!req.files?.length) return res.status(400).json({ error: 'Choose at least one photo or video.' });
  const index = readIndex();
  const added = [];
  for (const f of req.files) {
    const item = {
      id: randomUUID(), eventId, filename: f.filename,
      originalName: safeName(f.originalname), mimeType: f.mimetype,
      kind: f.mimetype.startsWith('video/') ? 'video' : 'photo', size: f.size,
      uploadedAt: new Date().toISOString(), source: 'admin', driveBackup: null, faceTags: []
    };
    if (String(process.env.GOOGLE_DRIVE_BACKUP).toLowerCase() === 'true') {
      try { item.driveBackup = await backupToDrive(f.path, f.originalname, f.mimetype); }
      catch (err) { item.driveBackupError = err.message; }
    }
    index.unshift(item); added.push(publicItem(item));
  }
  writeIndex(index);
  res.status(201).json({ uploaded: added.length, items: added });
});

app.get('/api/qr/:eventId', async (req, res) => {
  const eventId = String(req.params.eventId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  const url = `${BASE_URL}/?event=${encodeURIComponent(eventId)}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 600, margin: 2, errorCorrectionLevel: 'H', color: { dark: '#101828', light: '#FFFFFF' } });
    res.json({ url, dataUrl });
  } catch { res.status(500).json({ error: 'Could not generate QR code.' }); }
});

// Optional simple event creation. Admin key is required; never expose it in the browser.
app.post('/api/admin/events', (req, res) => {
  if (!process.env.ADMIN_KEY || req.get('x-admin-key') !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const title = String(req.body?.title || 'Untitled event').trim().slice(0, 100);
  const eventId = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 35) || 'event'}-${randomUUID().slice(0, 6)}`;
  res.status(201).json({ eventId, title, galleryUrl: `${BASE_URL}/?event=${encodeURIComponent(eventId)}`, qrUrl: `/api/qr/${eventId}` });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File is larger than ${MAX_FILE_MB} MB.` });
  res.status(400).json({ error: err.message || 'Request failed.' });
});

app.listen(PORT, () => console.log(`Cybercodix Instant Share running at ${BASE_URL}`));
