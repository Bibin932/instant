import 'dotenv/config';
import FtpSrv from 'ftp-srv';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const host = process.env.FTP_HOST || '0.0.0.0';
const port = Number(process.env.FTP_PORT || 2121);
const username = process.env.FTP_USER || 'event-uploader';
const password = process.env.FTP_PASSWORD || 'change-this-password';
const root = path.resolve(process.env.FTP_ROOT || './data/uploads');
fs.mkdirSync(root, { recursive: true });

const ftpServer = new FtpSrv({ url: `ftp://${host}:${port}`, anonymous: false, greeting: ['Cybercodix Instant Share upload receiver'] });
ftpServer.on('login', ({ connection, username: user, password: pass }, resolve, reject) => {
  if (user !== username || pass !== password) return reject(new Error('Invalid FTP credentials'));
  resolve({ root, cwd: '/' });
  connection.on('STOR', (_error, filePath) => {
    console.log(`FTP received: ${path.basename(filePath)}`);
    console.log('Note: FTP-ingested files are saved to data/uploads. To show them in a gallery, use the browser uploader or register them in data/media-index.json.');
  });
});
ftpServer.listen().then(() => console.log(`FTP receiver listening on ${host}:${port}`)).catch(err => {
  console.error(err);
  process.exit(1);
});
