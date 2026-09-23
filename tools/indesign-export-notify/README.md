# InDesign export notifier

Get a pop-up on your computer (or phone) when an InDesign export finishes on the export PC.

## Setup: 2 minutes, no server

**On the export PC**
1. Download this folder (all files together) to the export PC.
2. Make sure InDesign has been opened at least once on this Windows account.
3. Double-click **`Install.cmd`**.

It installs the notifier into every InDesign version on the PC and sends you a test notification. It also puts an **"Export notifications"** link on the desktop and copies it to the clipboard. Restart InDesign.

**Staff**
Send them the link plus [`STAFF.md`](STAFF.md). They open the link, click **Allow**, then **Install**. That's it.

**Test it:** export something small. Everyone subscribed gets **✅ InDesign export finished** with the file name.

## What it does

- **Normal and background exports** (Background Tasks panel): waits until the file is really finished.
- **Batch exports**: exports that finish close together arrive as one notification, not one per file.
- **Cancelled or failed exports**: a "needs a look" warning instead.
- Reinstalling keeps the same link, so staff don't need a new one.
- **Remove it:** double-click `Uninstall.cmd`.

## How it's built (community first, all free)

| Piece | Role |
|---|---|
| InDesign's built-in scripting (`afterExport` event) | Knows when an export happens (`export-notify.jsx`) |
| [ntfy](https://github.com/binwiederhier/ntfy), 34k★, free hosted service at ntfy.sh | Delivers the notifications and provides the staff web app |
| curl / PowerShell (built into Windows) | Sends the message |

Our own code is only the ~150-line InDesign script and the installer.

## Privacy

- Notifications go through the free public ntfy.sh service. The installer makes a long random channel name (like a password) that nobody can guess. **Anyone who has the link can read the notifications**, so keep it inside the agency.
- Messages contain only the file names and the PC name. No files or contents are sent. ntfy.sh deletes messages after 12 hours.
- Don't want client names in file names to leave the office? Run `Install.cmd -HideFileNames` from a command prompt, and notifications just say "Done (2)". A fully private self-hosted option is in [`optional-self-hosting/`](optional-self-hosting/SETUP.md), but it's much more setup.
- Per our policy, run the files through the sandbox security check first. They're short, readable scripts.

## If something doesn't work

| Problem | Fix |
|---|---|
| Installer says InDesign folder not found | Open InDesign once on this Windows account, close it, run `Install.cmd` again |
| No test notification | The export PC needs internet access to `ntfy.sh` |
| Staff get nothing | They must click **Allow**; check Windows **Settings → Notifications** allows Chrome/Edge |
| Only works while the browser tab is open | They skipped **Install** in step 3 of STAFF.md |
| Want a new link (e.g. it leaked) | Delete `%APPDATA%\InDesignExportNotify\channel.txt`, run `Install.cmd` again, send staff the new link |

## Tested

- **Installer:** tested with PowerShell against a fake InDesign folder layout (two versions, English and Hebrew language folders). It installed into each one, reused the same link on reinstall, hid file names when asked, rejected a bad channel name, uninstalled cleanly, and delivered the test notification to a real ntfy server.
- **Notification delivery:** tested against the real ntfy server and web app, including Hebrew file names.
- **Not tested yet:** a real InDesign on a real Windows PC. There wasn't one available. That's the first thing to check with your test export.
