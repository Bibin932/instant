# Cybercodix Instant Share — MVP

A responsive Node.js event gallery prototype for photos and videos, with:
- Mobile-first dark editorial UI
- Event-specific galleries via `?event=wedding-demo`
- Multi-file upload and upload progress
- QR code generation and download
- Auto-refreshing gallery
- Photo/video filters, search, sorting, lightbox
- Optional Google Drive backup using a service account
- Optional FTP receiver process (see limitations below)

## Requirements
- Node.js 20+
- npm
- For Google Drive backup: a Google Cloud project, Drive API enabled, and a service account

## Run locally
```bash
npm install
cp .env.example .env
npm start
```
Open http://localhost:3000/?event=wedding-demo

Upload a few test JPEG/MP4 files. The QR code will point to `BASE_URL`; for phones on the same Wi-Fi, set `BASE_URL=http://YOUR-LAPTOP-LAN-IP:3000`. For internet access, deploy behind HTTPS and set `BASE_URL` to the public domain.

## Google Drive backup
Google Drive is configured as an **optional backup**, not the primary live delivery layer. The application serves the gallery from its local media directory so guests can view files quickly. The Drive API backup runs after upload when enabled.

1. Create/select a Google Cloud project and enable Google Drive API.
2. Create a service account and download its JSON credentials.
3. Put the JSON file in the project root as `google-service-account.json` (never commit it).
4. Create a Drive folder and share it with the service account's email as Editor.
5. Set `GOOGLE_DRIVE_FOLDER_ID=your_folder_id` and `GOOGLE_DRIVE_BACKUP=true` in `.env`.
6. Restart the app and test with a small file.

For large files and unstable connections, Google recommends resumable uploads. This MVP's Drive backup uses the Node.js Google API client and streams files; for production-scale video, implement resumable uploads and retry queues. See https://developers.google.com/workspace/drive/api/guides/manage-uploads

## Camera Wi-Fi / FTP
Camera models vary. A camera with FTP transfer can be configured to send JPEGs to the FTP receiver, or a laptop relay can receive camera uploads and forward them to the app. Start the FTP process separately:
```bash
npm run ftp
```
Set `FTP_HOST`, `FTP_PORT`, `FTP_USER`, `FTP_PASSWORD`, and `FTP_ROOT` in `.env`. Configure the camera's FTP destination to the laptop/server IP and port 2121. This is a basic development receiver, not a hardened public FTP service. Do not expose plain FTP directly to the internet. Use a VPN/private network or SFTP/FTPS for production.

**Important MVP limitation:** FTP receiver stores incoming files in `data/uploads` but does not automatically register them in the gallery index yet. For a real event, use the web uploader or implement the small ingestion/indexing bridge described below. Do not rely on FTP ingestion until that bridge is tested with your camera.

## Face-wise sorting / albums
The UI includes a face-search panel, but **automated face matching is not implemented in this MVP**. Face matching requires a model, indexing pipeline, face embeddings and careful biometric privacy controls. Recommended production approach:
- Add an opt-in face-search feature with explicit notice and consent.
- Run face detection/embedding in a dedicated worker or browser, depending on scale.
- Store encrypted embeddings associated with media IDs; don't store raw selfie images longer than necessary.
- Use similarity thresholds, allow users to review matches, and provide delete/retention controls.
- Don't identify people by name; use the submitted selfie to find visually similar images.
- For a quick pilot, manually create albums or use a vetted face-search provider only after reviewing its privacy/security terms.

## Suggested production architecture
- Node.js + Express API and admin authentication
- PostgreSQL for events, media metadata and permissions
- S3-compatible object storage (AWS S3, Cloudflare R2, or equivalent) for primary media storage
- CDN/signed URLs for efficient gallery delivery
- Queue worker for thumbnails, video poster frames, face embeddings and retries
- Google Drive as a secondary archive/backup, not the public serving layer
- HTTPS, event access codes, expiring signed links, rate limiting, file validation, malware scanning, storage lifecycle policies and audit logs

## Before using at a wedding
- Test the exact camera model and upload method.
- Keep camera memory-card originals.
- Use a reliable Wi-Fi router plus mobile hotspot backup.
- Use JPEGs for quick gallery delivery and retain RAW originals locally.
- Confirm the photographer and couple agree to uploads and sharing.
- Don't use guests' images in marketing without permission.
- Add an event passcode or private access control before production use.

## Deploy
Deploy to a Node.js host with persistent storage or attach a persistent volume. On shared hosting, confirm Node.js apps and persistent writable storage are supported. Do not deploy this prototype publicly without adding authentication, access control, secure HTTPS and storage policies.

## API routes
- `GET /api/health`
- `GET /api/events/:eventId`
- `POST /api/upload/:eventId` — multipart form field `files`
- `GET /api/qr/:eventId`
- `POST /api/admin/events` — requires `x-admin-key` header

The public event IDs are currently guessable. Add event passwords or signed invite tokens before real private events.
