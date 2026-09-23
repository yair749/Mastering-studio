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

**Staff computers: once each, then nothing for staff to do**
The installer also puts a folder **"Export notifications - staff PC setup"** on the export PC's desktop, with your channel already filled in. Copy it to each staff computer and double-click `Install.cmd` in it. From then on, a normal Windows notification appears when an export finishes: no browser, and nothing to open. See [`STAFF.md`](STAFF.md). Phones and browsers still work with the link, if anyone wants them.

## What it does

- **Normal and background exports** (Background Tasks panel): waits until the file is really finished.
- **Batch exports**: exports that finish close together arrive as one notification, listing the files and the InDesign document they came from.
- **Multi-page JPG/PNG exports** (page-numbered files) are recognised: "Poster.jpg (12 files)".
- **Cancelled or failed exports**, including a failed export over an existing file of the same name: a "needs a look" warning instead.
- **Internet down:** keeps retrying for about 15 minutes. If it still can't send, it keeps the message and delivers it, marked "(Delayed)", with the next successful notification.
- **InDesign upgrades:** a daily self-check (09:00, or at the next start-up) installs the notifier into any new InDesign version by itself.
- **Staff computers** (the receiver in `receiver/`):
  - starts silently at every login
  - keeps a connection open
  - after sleep or an outage, catches up on anything missed in the last 12 hours
  - says "can't connect" after 10 minutes without internet, and "reconnected" when it's back
- **Remove it:** double-click `Uninstall.cmd` (on the export PC, or in the staff setup folder on a staff computer).

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
| PowerShell and Windows notifications (built into Windows) | The staff-computer receiver (`receiver/export-receiver.ps1`). ntfy's own Windows program can't show notifications without an extra tool that doesn't meet our 1000-star rule |

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
| A staff computer gets nothing | Check Windows **Settings → System → Notifications** is on and Do not disturb/Focus is off; see `%APPDATA%\ExportReceiver\receiver.log` on that computer; re-run `Install.cmd` from the staff setup folder |
| Browser users: only works while the tab is open | They skipped **Install** in the browser (see STAFF.md) |
| Want a new link (e.g. it leaked) | Delete the `topic=` line from `%APPDATA%\InDesignExportNotify\settings.txt`, run `Install.cmd` again, copy the new "staff PC setup" folder to each staff computer and run its `Install.cmd` again |

## Known limits

- **Only File → Export is covered.** InDesign doesn't announce Package, Print, Publish Online or Export to Adobe Express, so those send nothing. Book-panel exports are untested.
- **It checks that files were written, not that they're correct.**
- **It depends on ntfy.sh being up** (limit: 250 messages a day from the export PC).
- **One Windows user:** it only covers the Windows account it was installed on.
- **Brief window flash:** the daily self-check may flash a window for a moment when it runs.
- **Weekly pause (browser only):** browser notifications pause if the app isn't opened for a week. The Windows receiver has no such pause.
- **About 30 staff computers per office:** ntfy.sh allows about 30 open connections from one internet address. Beyond that, self-host or use phones/browsers for some people.
- **"Windows PowerShell" as the sender:** staff-computer notifications show that name as the source.
- **Do not disturb / Focus mode** hides notifications, like any other app's.
- **Per Windows user:** the staff receiver is installed per Windows user, so run `Install.cmd` as each person who uses that computer.

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
- **Staff receiver:** real PowerShell against a real ntfy server (`tests/test-receiver.sh`):
  - live messages, including a Hebrew file name
  - an accidental second copy (no duplicates)
  - computer off during exports (caught up, nothing repeated)
  - ntfy down past the warning time (warning, then "reconnected")
  - a silently dead connection (detected in 12 seconds)
  - Windows refusing one pop-up (logged and skipped)
  - setup, the paste-the-link mode, a bad link, and uninstall
- **Not tested:**
  - a real InDesign on a real Windows PC
  - Windows Task Scheduler
  - the actual Windows notification pop-up and the login shortcut (Windows-only; tested with stand-ins)

  Run `Install.cmd` on the export PC, set up one staff computer, and do a test export to confirm.
