const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = __dirname;
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

if (fs.existsSync(envPath)) {
  console.log('.env already exists; leaving it unchanged.');
  process.exit(0);
}

let content = fs.readFileSync(examplePath, 'utf8');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
const adminPassword = randomToken(18);
const verifyToken = `meta_verify_${randomToken(24)}`;

content = content
  .replace('META_VERIFY_TOKEN=GENERATE_A_LONG_RANDOM_VALUE', `META_VERIFY_TOKEN=${verifyToken}`)
  .replace('ADMIN_PASSWORD=CHANGE_THIS_ADMIN_PASSWORD', `ADMIN_PASSWORD=${adminPassword}`);

fs.writeFileSync(envPath, content, { mode: 0o600 });
console.log('Created .env with a random webhook Verify Token and admin password.');
console.log('Admin username: admin');
console.log(`Admin password: ${adminPassword}`);
console.log(`Meta Verify Token: ${verifyToken}`);
console.log('Now edit .env and add your Meta App Secret, Page Access Token, and CRM API key.');
