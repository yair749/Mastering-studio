# InDesign export notifier

Get a pop-up on your computer (or phone) when an InDesign export finishes on the export PC.

## Setup: 2 minutes, no server

**On the export PC**
1. Download this folder (all files together) to the export PC.
2. Make sure InDesign has been opened at least once on this Windows account.
3. Double-click **`Install.cmd`**. Then close and reopen InDesign.

The installer:
- installs the notifier into every InDesign version on the PC;
- sends a test notification;
- puts two links on the desktop:
  - **"Export notifications"**: for staff (also copied to the clipboard)
  - **"Export notifier status (admin)"**: just for you, see *Knowing it works* below

Already installed an earlier version? Just run `Install.cmd` again. It keeps the same link.

**Staff**
Send them the "Export notifications" link plus [`STAFF.md`](STAFF.md). They open the link, click **Allow**, then **Install**.

## What it does

- **Normal and background exports** (Background Tasks panel): waits until the file is really finished.
- **Batch exports**: exports that finish close together arrive as one notification, listing the files and the InDesign document they came from.
- **Multi-page JPG/PNG exports** (page-numbered files) are recognised: "Poster.jpg (12 files)".
- **Cancelled or failed exports**, including a failed export over an existing file of the same name: a "needs a look" warning instead.
- **Internet down:** keeps retrying for about 15 minutes. If it still can't send, it keeps the message and delivers it, marked "(Delayed)", with the next successful notification.
- **InDesign upgrades:** a daily self-check (09:00, or at the next start-up) installs the notifier into any new InDesign version by itself.
- **Remove it:** double-click `Uninstall.cmd`.

## Knowing it works

Open the **"Export notifier status (admin)"** link and subscribe, like staff do with theirs. You'll see:
- **Notifier running**: every time InDesign starts on the export PC.
- **Daily check OK**: once a day.
- **Notifier installed into a new InDesign version**: after an upgrade.

If these stop coming, something is wrong. Look at `%APPDATA%\InDesignExportNotify\notifier.log` on the export PC; every failed send is written there.

## How it's built (community first, all free)

| Piece | Role |
|---|---|
| InDesign's built-in scripting (`beforeExport` / `afterExport` events) | Knows when an export happens (`export-notify.jsx`) |
| [ntfy](https://github.com/binwiederhier/ntfy), 34k★, free hosted service at ntfy.sh | Delivers the notifications and provides the staff web app |
| PowerShell and Task Scheduler (built into Windows) | Sending with retries (`send-notification.ps1`), install and daily self-check (`Install-ExportNotify.ps1`) |

Where things live on the export PC: `%APPDATA%\InDesignExportNotify\` holds the settings (`settings.txt`), a copy of the notifier (`app\`), messages waiting to be sent (`outbox\`) and the log.

## Privacy

- Notifications go through the free public ntfy.sh service on a long random channel name that nobody can guess. **Anyone who has the link can read the notifications, and could also post to the channel**, so keep it inside the agency.
- Messages contain only the file names, the InDesign document name and the PC name. No files or contents are sent. ntfy.sh deletes messages after 12 hours.
- To keep names out of notifications, run `Install.cmd -HideFileNames` from a command prompt in this folder. Messages then just say "Done (2)". `-ShowFileNames` turns names back on.
- A fully private self-hosted option is in [`optional-self-hosting/`](optional-self-hosting/SETUP.md), but it's much more setup.
- Per our policy, run the files through the sandbox security check first. They're short, readable scripts.

## If something doesn't work

| Problem | Fix |
|---|---|
| Installer says InDesign folder not found | Open InDesign once on this Windows account, close it, run `Install.cmd` again |
| "Couldn't reach ntfy.sh" | The export PC needs internet access to `ntfy.sh`; details are in `notifier.log` |
| "Couldn't schedule the daily self-check" | Everything else works; re-run `Install.cmd` after InDesign upgrades |
| Staff get nothing | They must click **Allow**; check Windows **Settings → Notifications** allows Chrome/Edge |
| Only works while the browser tab is open | They skipped **Install** in step 3 of STAFF.md |
| Want a new link (e.g. it leaked) | Delete the `topic=` line from `%APPDATA%\InDesignExportNotify\settings.txt`, run `Install.cmd` again, send staff the new link |

## Known limits

- **Only File → Export is covered.** InDesign doesn't announce Package, Print, Publish Online or Export to Adobe Express, so those send nothing. Book-panel exports are untested.
- **It checks that files were written, not that they're correct.**
- **It depends on ntfy.sh being up** (limit: 250 messages a day from the export PC).
- **One Windows user:** it only covers the Windows account it was installed on.
- **Brief window flash:** the daily self-check may flash a window for a moment when it runs.
- **Weekly pause for staff:** notifications pause if they don't open the app for a week; they get a warning first.

## Tested

- **InDesign script:** 14 scenarios against a stand-in for InDesign's scripting API (`node tests/test-export-notify.js`):
  - new file, failed overwrite, successful overwrite
  - multi-page JPG
  - background export running, then finishing
  - batch export with a Hebrew file name
  - hidden names
  - VBScript turned off
  - start-up status message
- **Installer and sender:** real PowerShell against a real ntfy server:
  - upgrading over the first version while keeping the link
  - test and status messages
  - internet down (retries, log, delayed delivery)
  - self-repair after a simulated InDesign upgrade
  - daily check
  - hidden names surviving the daily check
  - uninstall and reinstall
- **Not tested:**
  - a real InDesign on a real Windows PC
  - Windows Task Scheduler (not available in the test environment)

  Run `Install.cmd` on the export PC and do a test export to confirm.
