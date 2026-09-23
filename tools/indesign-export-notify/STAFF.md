# Export notifications on staff computers

## Automatic (recommended): nothing for staff to do

Do this once per computer (you or IT, about 1 minute):

1. Copy the folder **"Export notifications - staff PC setup"** from the export PC's desktop to the computer, via a USB stick or a shared drive.
2. Log in to that computer as the person who uses it, then double-click **`Install.cmd`** in the folder.
3. An **"Export notifications are on"** pop-up appears. Done.

From then on, a normal Windows notification appears when an export finishes: **"InDesign export finished — Done (1): Poster_A1.pdf — From: Client.indd"**. There's no browser or app to open. It starts silently at every login.
- **Computer asleep or off?** Missed exports (up to 12 hours) appear when it's back.
- **No internet for 10+ minutes?** It says "can't connect", then "reconnected", and it never stops trying.
- **Click a notification** to see the recent export list in the browser.
- **To remove it:** double-click `Uninstall.cmd` in the same folder.

Notifications don't appear? Check that Windows **Settings → System → Notifications** is on, that **Do not disturb / Focus** is off, and that "Windows PowerShell" isn't blocked in that list. Problems are logged in `%APPDATA%\ExportReceiver\receiver.log`.

## Optional: phone or browser
- **Phone:** install the free **ntfy** app (App Store / Google Play), tap **+**, and paste the channel name (the part after `ntfy.sh/` in the "Export notifications" link).
- **Browser:** open the "Export notifications" link in Chrome or Edge, click **Allow**, then **Install**.

Keep the link and the setup folder inside the agency. Anyone who has them can see the notifications.
