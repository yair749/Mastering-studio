# InDesign export notifier

Get a browser notification when an InDesign export finishes on the export PC. Staff open **https://export-pc** in Chrome or Edge, log in, and get a desktop pop-up (even with the tab closed) plus a history of recent exports.

No new app to build or maintain. This is about 150 lines of glue between things that already exist:

| Piece | What it does | Why it was chosen |
|---|---|---|
| InDesign scripting `afterExport` event | Built into InDesign. Fires when an export happens. | Free, no third-party code |
| [ntfy](https://github.com/binwiederhier/ntfy) (34k★) | Notification server with a web app. Self-hosted on the export PC as a Windows service. | Free, open source, web-based |
| [mkcert](https://github.com/FiloSottile/mkcert) (59k★) | HTTPS certificate for the office network | Browsers only allow notifications over HTTPS |
| `curl` | Sends the notification from InDesign to ntfy | Ships with Windows 10 1803+ and macOS |

No existing project with 1000+ stars does "notify when InDesign export is done". The search came back empty, so this glue is the minimum.

## Files

- `export-notify.jsx`: the InDesign startup script.
- `server/SETUP.md`: step-by-step self-hosting guide for the export PC. **Start here.**
- `server/server.yml`: ntfy config template (private, login required, browser push enabled).

## Setup

1. Set up the server: follow [`server/SETUP.md`](server/SETUP.md). It ends with a `tk_...` token.
2. In `export-notify.jsx`, set `token` to that token. `server` and `topic` are already set for the self-hosted setup.
3. Copy `export-notify.jsx` into InDesign's startup scripts folder on the export PC:
   ```
   %APPDATA%\Adobe\InDesign\<Version>\<locale>\Scripts\startup scripts\
   ```
   (for example `...\InDesign\Version 20.0\en_US\Scripts\startup scripts\`). Create `startup scripts` if it doesn't exist. Restart InDesign.
4. Export something. Everyone subscribed gets "InDesign export finished" with the file name(s).

## Behaviour

- **Background exports** (PDF exports from the Background Tasks panel): the script waits until InDesign has no running background tasks and the output file exists.
- **Batch exports**: exports that finish close together are grouped into one notification, not one per file.
- **Cancelled or failed exports**: if the export ends but the file isn't there, you get a high-priority "InDesign export needs a look" notification.
- **Timeout**: after `timeoutHours` (default 8) it stops waiting and tells you.

## Security

- Everything stays on the office network. The server rejects anyone who isn't logged in. Staff can only read notifications; the InDesign script's token can only send them.
- The script's HTTP port (2586) listens only on the export PC itself. Staff connect over HTTPS.
- The script only reads the exported file's name and whether it exists, then sends one request with curl. Read it before installing; it is short.
- Per our policy, put ntfy and mkcert through the sandbox security checks before installing them (`server/SETUP.md` step 0).

## Tested

The server side was tested on Linux with the official ntfy v2.28.0 release (checksum verified) and mkcert v1.4.4, using this `server.yml` with only the paths changed:

- Anonymous send and read are refused (403). A wrong password is refused (401).
- The staff login can read but not send. The script token can send but not read.
- The exact request the `.jsx` builds is accepted, and the Hebrew filename in it comes through intact.
- The web app requires a login, shows the messages live, and serves the web-push key.

**Not tested yet:** the `.jsx` inside a real InDesign, and the Windows service and certificate steps. There was no Windows or InDesign machine available. Do the first run on the export PC with `ntfy serve` in a window (SETUP.md step 6) so any problem shows on screen.
