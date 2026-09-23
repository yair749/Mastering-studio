# InDesign export notifier

Get a push notification on your phone or desktop when an InDesign export finishes on the export PC.

No new app to build or maintain. This is about 150 lines of glue between two things that already exist:

| Piece | What it does | Why it was chosen |
|---|---|---|
| InDesign scripting `afterExport` event | Built into InDesign. Fires when an export happens. | Free, no third-party code |
| [ntfy](https://github.com/binwiederhier/ntfy) (34k★) | Push notifications over plain HTTP. Has Android, iOS and web/desktop apps. | Free, open source, self-hostable |
| `curl` | Sends the HTTP request | Ships with Windows 10 1803+ and macOS |

No existing project with 1000+ stars does "notify when InDesign export is done". The search came back empty, so this glue is the minimum.

## Setup (about 10 minutes)

1. **Pick a topic name.** On the public ntfy.sh server, anyone who knows the topic can read it, so use a long random name, for example `agency-export-7f3k9q2m8x`. For more privacy, self-host ntfy (see *Security* below).
2. **Test from the export PC first.** In PowerShell:
   ```powershell
   curl.exe -H "Title: test" -d "hello from the export PC" https://ntfy.sh/agency-export-7f3k9q2m8x
   ```
3. **Subscribe.** Install the ntfy app (Google Play, F-Droid or App Store), or open `https://ntfy.sh/app` in a browser, and subscribe to the same topic. Run the test again; you should get the notification.
4. **Edit `export-notify.jsx`.** Set `CONFIG.topic`, and `server`/`token` if you self-host.
5. **Install the script.** Copy it into InDesign's startup scripts folder:
   ```
   %APPDATA%\Adobe\InDesign\<Version>\<locale>\Scripts\startup scripts\
   ```
   (for example `...\InDesign\Version 20.0\en_US\Scripts\startup scripts\`). Create `startup scripts` if it doesn't exist. Restart InDesign.
6. Export something. You get "InDesign export finished" with the file name(s).

## Behaviour

- **Background exports** (PDF exports from the Background Tasks panel): the script waits until InDesign has no running background tasks and the output file exists.
- **Batch exports**: exports that finish close together are grouped into one notification, not one per file.
- **Cancelled or failed exports**: if the export ends but the file isn't there, you get a high-priority "InDesign export needs a look" notification.
- **Timeout**: after `timeoutHours` (default 8) it stops waiting and tells you.

## Security

- The script only reads the exported file's name and existence, and sends one HTTPS request with curl. Read it before installing; it is short.
- Filenames are sent to the ntfy server. If client names in filenames are confidential, **self-host ntfy** (single binary or Docker, see the ntfy docs) with access control. Then put your server URL in `server` and a token in `token`.
- Per our policy, put the ntfy server / app through the sandbox security checks before installing it.
