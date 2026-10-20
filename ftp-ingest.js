import 'dotenv/config';
import FtpSrv from 'ftp-srv';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import mime from 'mime-types';

const host = process.env.FTP_HOST || '0.0.0.0';
const port = Number(process.env.FTP_PORT || 2121);
const username = process.env.FTP_USER || 'event-uploader';
const password = process.env.FTP_PASSWORD || '';
const eventId = String(process.env.FTP_EVENT_ID || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
const projectRoot = path.dirname(new URL(import.meta.url).pathname);
const resolveFromProject = value => path.resolve(projectRoot, value || '.');
const inbox = resolveFromProject(process.env.FTP_ROOT || './data/ftp-inbox');
const uploads = resolveFromProject(process.env.UPLOADS_ROOT || './data/uploads');
const dataDir = resolveFromProject('./data');
const indexPath = path.join(dataDir, 'media-index.json');
const statusPath = path.join(dataDir, 'ftp-status.json');
const controlPath = path.join(dataDir, 'ftp-control.json');
const pasvUrl = process.env.FTP_PASV_URL || undefined;
const pasvMin = Number(process.env.FTP_PASV_MIN || 40000);
const pasvMax = Number(process.env.FTP_PASV_MAX || 40100);
const pollMs = Math.max(1000, Number(process.env.FTP_POLL_MS || 3000));

if (!password || password === 'change-this-password') {
  console.error('Set a strong FTP_PASSWORD in .env before starting the FTP receiver.');
  process.exit(1);
}
if (!eventId) {
  console.error('Set FTP_EVENT_ID to the event ID that should receive camera uploads.');
  process.exit(1);
}
for (const dir of [inbox, uploads, dataDir]) fs.mkdirSync(dir, { recursive: true });

const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.mp4', '.mov', '.webm', '.mkv']);
const knownFiles = new Map();
let processedCount = 0;
let lastTransferAt = null;
let lastError = null;
function readJson(filePath, fallback) { try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; } }
function writeStatus(state = 'connected') {
  const status = { state, lastHeartbeat: new Date().toISOString(), processed: processedCount, lastTransferAt, lastError };
  const temp = `${statusPath}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(status, null, 2)); fs.renameSync(temp, statusPath); } catch (err) { console.error('Could not write FTP status:', err.message); }
}
const safeName = name => String(name || 'camera-upload').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-150) || 'camera-upload';
function readIndex() {
  try { return JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch { return []; }
}
function writeIndex(items) {
  const temp = `${indexPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(items, null, 2));
  fs.renameSync(temp, indexPath);
}
async function findFiles(dir) {
  const found = [];
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await findFiles(full));
    else if (entry.isFile() && !entry.name.startsWith('.') && allowedExtensions.has(path.extname(entry.name).toLowerCase())) found.push(full);
  }
  return found;
}
async function ingestStableFiles() {
  const control = readJson(controlPath, { active: true });
  writeStatus(control.active === false ? 'paused' : 'connected');
  if (control.active === false) return;
  let files;
  try { files = await findFiles(inbox); } catch (err) { console.error('Could not scan FTP inbox:', err.message); return; }
  const present = new Set(files);
  for (const oldPath of knownFiles.keys()) if (!present.has(oldPath)) knownFiles.delete(oldPath);
  for (const sourcePath of files) {
    try {
      const stat = await fs.promises.stat(sourcePath);
      const previous = knownFiles.get(sourcePath);
      if (!previous || previous.size !== stat.size || previous.mtimeMs !== stat.mtimeMs) {
        knownFiles.set(sourcePath, { size: stat.size, mtimeMs: stat.mtimeMs, stableChecks: 0 });
        continue;
      }
      previous.stableChecks += 1;
      if (previous.stableChecks < 2 || stat.size === 0) continue;

      const originalName = safeName(path.basename(sourcePath));
      const extension = path.extname(originalName).toLowerCase();
      const filename = `${Date.now()}-${randomUUID()}-${originalName}`;
      const destination = path.join(uploads, filename);
      await fs.promises.rename(sourcePath, destination);
      const mimeType = mime.lookup(extension) || 'application/octet-stream';
      const item = {
        id: randomUUID(), eventId, filename, originalName, mimeType,
        kind: mimeType.startsWith('video/') ? 'video' : 'photo',
        size: stat.size, uploadedAt: new Date().toISOString(),
        source: 'ftp-camera', driveBackup: null, faceTags: []
      };
      const index = readIndex();
      index.unshift(item);
      writeIndex(index);
      knownFiles.delete(sourcePath);
      processedCount += 1;
      lastTransferAt = new Date().toISOString();
      lastError = null;
      writeStatus('connected');
      console.log(`Gallery updated for event ${eventId}: ${originalName} (${stat.size} bytes)`);
    } catch (err) {
      lastError = err.message;
      writeStatus('error');
      console.error(`Could not ingest ${path.basename(sourcePath)}:`, err.message);
    }
  }
}

const ftpOptions = {
  url: `ftp://${host}:${port}`,
  anonymous: false,
  greeting: ['Cybercodix Instant Share camera receiver'],
  pasv_min: pasvMin,
  pasv_max: pasvMax,
  ...(pasvUrl ? { pasv_url: pasvUrl } : {})
};
const ftpServer = new FtpSrv(ftpOptions);
ftpServer.on('login', ({ username: user, password: pass }, resolve, reject) => {
  if (user !== username || pass !== password) return reject(new Error('Invalid FTP credentials'));
  // FTP client is confined to the inbox. Files are moved to the public media directory only after upload stabilizes.
  resolve({ root: inbox, cwd: '/' });
});
ftpServer.listen().then(() => {
  console.log(`FTP receiver listening on ${host}:${port}; event=${eventId}; inbox=${inbox}`);
  console.log(`Passive ports: ${pasvMin}-${pasvMax}${pasvUrl ? `; advertised host=${pasvUrl}` : ''}`);
  console.log('WARNING: Plain FTP does not encrypt credentials or files. Use only on a trusted private network or add FTPS/VPN protection.');
  writeStatus('connected');
  setInterval(ingestStableFiles, pollMs);
  ingestStableFiles();
}).catch(err => {
  console.error('FTP receiver failed to start:', err);
  process.exit(1);
});
