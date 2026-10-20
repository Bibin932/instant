# Cybercodix Instant Share — MVP

A responsive Node.js event gallery prototype for photos and videos, with:
- Mobile-first dark editorial UI
- Event-specific galleries via `?event=wedding-demo`
- Multi-file upload and upload progress
- QR code generation and download
- Auto-refreshing gallery
- Photo/video filters, search, sorting, lightbox
- Optional Google Drive backup using a service account
- Optional FTP camera receiver that automatically registers stable uploads in the matching event gallery

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

## Camera Wi-Fi / FTP ingestion

The FTP receiver now watches an isolated inbox, waits until a file stops changing, moves supported photo/video files into the website media directory, and registers them in `data/media-index.json` for the configured event. The gallery auto-refreshes every 12 seconds, so newly ingested files should appear without reloading the page.

### Configure a camera receiver

1. Run the web app and create/use an event ID, for example `wedding-demo`.
2. Copy `.env.example` to `.env`; set a strong unique `FTP_PASSWORD`, `FTP_EVENT_ID`, `FTP_USER`, and `FTP_ROOT`.
3. Start the web app with `npm start`, then start the receiver separately with `npm run ftp`. These are two processes; use a process manager or two services in production.
4. Configure the camera with the receiver's reachable host, FTP port, username/password, and upload directory `/`. Enable automatic FTP transfer if the camera supports it.
5. For passive FTP across a firewall, open the control port and the configured passive range (`FTP_PASV_MIN`–`FTP_PASV_MAX`) and set `FTP_PASV_URL` to the receiver's public IP/DNS. Do not set it to `0.0.0.0`.
6. Take a test JPEG and short video. Confirm both appear in `/?event=YOUR_EVENT_ID` and scan that event's QR code. Keep the camera card originals.

### Hosting and security notes

- **Hostinger shared Node.js hosting may not allow inbound custom ports or persistent extra processes.** If so, run the FTP receiver on a VPS or a laptop/mini-PC relay and send the files to the web app. The FTP receiver needs network reachability on its control and passive ports.
- This example listens with **plain FTP**, which does not encrypt passwords or image/video data. Use it only on a trusted private network/VPN; for public internet, deploy a properly configured FTPS receiver or secure VPN. `ftp-srv` supports TLS configuration, but this sample does not configure certificates.
- One receiver instance is configured for one `FTP_EVENT_ID`. For multiple simultaneous events, run separate receiver instances with separate users, inboxes, and event IDs, or implement per-user event mapping. Never share one event's credentials with another event.
- The receiver supports JPEG/JPG, PNG, WebP, GIF, HEIC/HEIF, MP4, MOV, WebM and MKV by file extension. RAW camera files are not published in the gallery. Use JPEG+RAW or archive RAW separately.
- The receiver only processes files once their size/modified time remains stable over multiple polling cycles. Camera temp filenames or unsupported extensions are ignored. Test your exact camera model/firmware before an event; Wi-Fi alone does not guarantee FTP capability.
- For production scale, use object storage as primary media storage, with durable metadata, retries, thumbnail processing, monitoring and access control.

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
- `GET /api/admin/status` — admin dashboard metrics and receiver heartbeat; requires `x-admin-key` header
- `POST /api/admin/control` — body `{ "active": true|false }` and `x-admin-key` header; pauses/resumes FTP ingestion

The public event IDs are currently guessable. Add event passwords or signed invite tokens before real private events.


## Admin dashboard

Open `https://YOUR-DOMAIN/admin.html` and enter the same `ADMIN_KEY` configured in the server environment. The dashboard shows website/FTP receiver connectivity, transfer totals, photos/videos, the last heartbeat, and recent files. It refreshes every 10 seconds. Use **Pause transfers** to stop registering incoming FTP files in the gallery while leaving them in the FTP inbox; **Activate transfers** resumes ingestion.

The dashboard control file (`data/ftp-control.json`) and FTP status heartbeat (`data/ftp-status.json`) must be shared by the web server and FTP receiver on the same persistent filesystem for pause/resume and live status to work. If the receiver runs on a separate VPS or laptop, these local-file controls will not communicate across machines; use an authenticated remote control/status API or relay service instead. Configure a long random `ADMIN_KEY`, keep it out of GitHub, and use HTTPS.

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


## Guest face search and admin-only uploads

- The public gallery has no upload form. Manual uploads are available only in `/admin.html` after authenticating with the server-side `ADMIN_KEY`.
- The protected upload endpoint is `POST /api/admin/upload/:eventId` and requires the `x-admin-key` header. The old public upload endpoint is removed.
- Guests can choose/capture a selfie and search for likely matching gallery photos. Face detection/descriptor comparison runs in the guest browser using face-api.js and its model files from public CDNs. The selfie is not posted to this server. An explicit consent checkbox is required.
- Face search currently scans the loaded event's photos in the browser each time, so large galleries may be slow. It does not match faces inside videos. Model loading requires internet access to the configured CDNs. For production, consider self-hosting and pinning the model assets and adding a server-side indexed workflow only with explicit consent and an appropriate retention policy.
- Face matches are probabilistic and can be wrong; do not use them for identity verification or access control.
