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


## Camera-to-gallery workflow (important)

The website cannot directly connect to every camera over Wi-Fi by itself. Camera wireless transfer features are manufacturer/model-specific. For cameras that support FTP transfer, use this reliable relay architecture:

1. Connect the camera and a laptop to the same dedicated Wi-Fi router (or use the camera's supported network mode).
2. Run a camera-compatible FTP/FTPS receiver on the laptop, configured with a dedicated upload folder. Configure the camera's FTP server address, port, username/password, and destination folder according to that camera's manual.
3. Run a **local relay agent** on the laptop to watch the incoming folder and upload completed files to `https://YOUR-DOMAIN/api/upload/EVENT_ID`. The relay must wait until a file stops growing before forwarding it. Keep the laptop awake and connected.
4. The gallery refreshes periodically and shows new media after the API accepts it. Keep the camera memory card as the original backup.

**Hostinger shared hosting is not a good place to run a camera-facing FTP listener** unless your plan explicitly allows inbound custom ports and persistent daemons. A camera on the event Wi-Fi cannot usually send FTP directly to a normal website URL. Use the laptop relay, a properly configured VPS with secure networking, or a supported manufacturer cloud workflow. Do not expose plain FTP credentials over the public internet. Prefer FTPS/SFTP or a private network/VPN for production.

### Preserving original image/video quality

The web uploader stores the uploaded file bytes without resizing or recompressing them. To preserve camera quality, set the camera's transfer mode to **original/full-size JPEG** (not resized web JPEG) and choose original/high-quality video transfer if the camera supports it. RAW files are currently not accepted by the web upload API; shoot RAW+JPEG if you need RAW originals, transfer RAW to a separate archive, and send JPEG previews to the gallery. Wi-Fi speed affects transfer time, not the file's intrinsic quality.

### Camera compatibility checklist

Before an event, check the exact camera model's manual for FTP transfer, wireless transmitter/app support, video transfer support, and whether it can transfer automatically after each shot. Some camera Wi-Fi functions only transfer selected JPEGs or require a manufacturer app; not every model supports automatic FTP or video transfer. Test a full-resolution JPEG and a short video before relying on it at an event.
