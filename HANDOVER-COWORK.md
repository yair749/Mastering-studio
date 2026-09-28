# Handover to Claude Cowork: finish the InDesign export tools on the export PC

**For:** Claude Cowork, running on the export PC.
**Owner:** Yair (ONE Agency). He is not a developer and is tired of doing steps by hand.
**Your job:** do every step you can yourself. Only ask the owner for what Windows won't let you do (the "Yes" permission prompt, clicking inside InDesign). When you need him, give **one** short, exact instruction at a time, then check the result yourself.

---

## 1. The rules (the owner's standing rules)

- **Don't build what already exists.** Look to the community first.
- **Free over paid.**
- **Only projects with 1000+ GitHub stars.** Check the star count before recommending anything.
- **Only build safe, usable software.** It must be safe to run as it is:
  - only official, signed sources (e.g. winget);
  - exact versions;
  - nothing hidden downloaded or run;
  - services limited to the office network;
  - setup simple enough to use straight away.
- **No silent failures.** Anything that can break must show a message or a log line, or repair itself.
- **Simplest fix that works.** No new servers, accounts or setup steps unless there's no other way.
- **Keep existing installs working.** Upgrades must keep:
  - the settings, **Desktop\ExportQueue\config.json**;
  - the job history, **Desktop\ExportQueue\data\\**;
  - the phone **notification channel**, **%APPDATA%\InDesignExportNotify\channel.txt**.
- **Talk plainly.** Give exact clicks, and say what is proven and what isn't.

## 2. Never delete or change these

| What | Where |
|---|---|
| Export Queue settings | `C:\Users\ONE_Legacy\Desktop\ExportQueue\config.json` |
| Export Queue job history | `C:\Users\ONE_Legacy\Desktop\ExportQueue\data\` |
| Notification channel (the link on everyone's phones) | `%APPDATA%\InDesignExportNotify\channel.txt` |
| Size-Sorted Export settings and log | `%APPDATA%\SizeSortedExport\` |
| The owner's other InDesign scripts | `%APPDATA%\Adobe\InDesign\Version 21.0\<language>\Scripts\Scripts Panel\` (e.g. "Layout_Lay…", "ONE - Batc…") |
| Client drives and client files | M:, N:, O:, P:, R:, W:, X:, Y:, I:, L:, G: (Google Drive), `Desktop\Size Test` |

## 3. The export PC

- **Windows user:** `ONE_Legacy`, Desktop `C:\Users\ONE_Legacy\Desktop`.
- **InDesign:** InDesign 2026, settings folder `%APPDATA%\Adobe\InDesign\Version 21.0\`.
- **Node.js:** 24.19, installed.
- **Client drives:** mapped from file servers 192.168.1.11, .13 and .14, e.g. `\\192.168.1.13\MG_Mega` = M:, `\\192.168.1.14\One Agency` = N:.
- **Google Drive:** Google Drive for desktop is installed (G:).

## 4. The three tools and where each one stands

### A. InDesign export notifier (phone notification when an export finishes)
- **Installed, OLD version.** `%APPDATA%\InDesignExportNotify\` contains only `channel.txt`: there's no `app` folder and no `settings.txt`.
- **Why it matters:** the newer tools (Export Queue, Size-Sorted Export) send problems to the phone through the notifier's `app\send-notification.ps1`. With the old version, phone alerts show as "off".
- **Update files:** **IndesignExportNotify.zip** (attached with this document). Its `Install.cmd` reads the old `channel.txt` and keeps the same channel, so the phone link doesn't change.

### B. Export Queue (web page where designers send exports to this PC)
- **Running now: version 1.0.0**, from `C:\Users\ONE_Legacy\Desktop\ExportQueue`, which is the folder holding `config.json` and `data`.
- **Version 2.0.0 is on the PC but not installed.** It was extracted into a folder inside that folder: `C:\Users\ONE_Legacy\Desktop\ExportQueue\ExportQueue`. You can recognise it by its `indesign-scripts` folder and `"version": "2.0.0"` in `package.json`.
- **What 2.0.0 adds:**
  - a Browse button, live file checks and several files at once;
  - Open/Download of finished files;
  - it runs in the background, and its firewall rule works on any network type but only for office computers;
  - Start menu tools: **Open, Check, Restart, Stop**;
  - safe upgrades;
  - it puts the latest Size-Sorted script into InDesign.

### C. Size-Sorted Export (InDesign window that exports each page into a folder named after its size)
- **Installed: version 1.0.0**, in InDesign's Scripts panel (User).
- **Proven in real InDesign on 28 Sep 2026:** a 9-page document gave 27 files (PDF, JPEG and PNG) in `_Exports\1361x765`, with correct names and page order. The JPEGs were exactly 1361 × 765 px, each PDF was 1 page, and the original was unchanged.
- **Version 1.1.0** is in `Desktop\ExportQueue\ExportQueue\indesign-scripts\SizeSortedExport.jsx`. It adds phone alerts, reads the old `channel.txt`, and an update switches over without restarting InDesign.

## 5. Failed tasks so far (count: 4, of which 1 is still open)

| # | What failed | Status |
|---|---|---|
| F1 | Install.cmd was opened from inside the zip (Windows temp copy) | Fixed: the installer now stops with a clear message |
| F2 | Windows PowerShell 5.1 couldn't read `package-lock.json` (empty property name) | Fixed and tested |
| F3 | **The v2.0.0 upgrade didn't happen:** the zip went into a nested folder, so the old installer ran and the InDesign script stayed at 1.0.0 | **OPEN: task 1 and task 2 below** |
| F4 | Claude Code kept giving the owner long manual steps instead of doing them | **Being fixed by this handover:** you do the steps |

## 6. Checklist: do these in order

Tick each one only after you've **checked** it.

### Task 1: Move version 2.0.0 into the right folder (fixes F3)
1. [ ] Confirm `Desktop\ExportQueue\ExportQueue\package.json` says `"version": "2.0.0"` and that folder has `indesign-scripts\SizeSortedExport.jsx`.
2. [ ] Confirm `Desktop\ExportQueue\config.json` and `Desktop\ExportQueue\data\` exist. **Keep both.**
3. [ ] Copy **everything** from `Desktop\ExportQueue\ExportQueue\` into `Desktop\ExportQueue\`, replacing files with the same name. The inner folder has no `config.json` or `data`, so nothing of those is overwritten.
4. [ ] Delete **only** the inner folder `Desktop\ExportQueue\ExportQueue\`.
5. [ ] **Check:**
   - `Desktop\ExportQueue\package.json` says 2.0.0;
   - `Desktop\ExportQueue\indesign-scripts\` exists;
   - `config.json` and `data\` are still there.

### Task 2: Update the InDesign script to 1.1.0 (no installer needed)
1. [ ] Find the language folder in `%APPDATA%\Adobe\InDesign\Version 21.0\` (e.g. `en_US` or `en_GB`): it's the one with a `Scripts\Scripts Panel` folder inside.
2. [ ] Copy `Desktop\ExportQueue\indesign-scripts\SizeSortedExport.jsx` into that `Scripts\Scripts Panel\` folder, replacing the old copy. **Don't touch the other scripts there.**
3. [ ] **Check:** the copied file contains `var VERSION = "1.1.0";`.
4. [ ] **Owner, one step:** "In InDesign's Scripts panel, double-click **SizeSortedExport.jsx**." The window title must say **Size-Sorted Export 1.1.0**, and the root folder should still be `Desktop\Size Test`.

### Task 3: Install Export Queue 2.0.0
1. [ ] Start the installer, **as the normal user, not as administrator**:
   - if you can run programs on this PC: `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\ONE_Legacy\Desktop\ExportQueue\windows\Install-ExportQueue.ps1"`;
   - otherwise ask the owner: "Double-click **Desktop\ExportQueue\windows\Install.cmd**."
2. [ ] **Owner, one step:** "When Windows asks *Do you want to allow this app to make changes?*, click **Yes**." That's for the firewall, and for stopping the PC from sleeping.
3. [ ] **Check the installer's output for these lines:**
   - `OK Node.js 24.19.0`
   - "The export queue (version 1.0.0) is running: stopping it for the upgrade"
   - `OK Settings ...` (kept or updated, with the client drives listed)
   - `OK Firewall ...` and `OK This PC no longer goes to sleep ...`
   - `OK InDesign script 'SizeSortedExport' is up to date`
   - `OK Running (version 2.0.0)`
   - the **address designers use**, e.g. `http://192.168.1.x:8080/`. Write it down for the owner.
4. [ ] **If it stops with "Setup stopped: …":** copy the exact line and look it up in section 8. If a black window titled **InDesign Export Queue** is still open (the old version), close it and run the installer again.

### Task 4: Check it works
1. [ ] Open `http://localhost:8080/api/health`. It must show `"ok":true` and `"version":"2.0.0"`.
2. [ ] **Owner, one step:** "Click **Start** → **InDesign Export Queue** → **Check Export Queue**." Every line should say **[OK]**. Read any **[!!]** line and do its "Fix".
3. [ ] **Check the start-up shortcut:** `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\InDesign Export Queue.lnk` exists and points at `...\Desktop\ExportQueue\windows\Control-ExportQueue.ps1`.

### Task 5: Test from a designer's computer
1. [ ] **Owner:** "On a designer's computer, open the address from task 3. Type a name, click **Browse…**, pick a small InDesign file on a client drive, tick **PDF (Print)**, then **Add to queue**."
2. [ ] **Check:** the job ends **Done**, and **Open** shows the PDF.

### Task 6: Update the export notifier (turns phone alerts on)
1. [ ] Extract **IndesignExportNotify.zip** to `Desktop\IndesignExportNotify`. Extract to the Desktop itself, not into a nested folder.
2. [ ] Run its `Install.cmd` (or ask the owner to double-click it).
3. [ ] **Check:**
   - `%APPDATA%\InDesignExportNotify\settings.txt` exists, and its `topic=` equals the old `channel.txt` (same channel, same phone link);
   - `%APPDATA%\InDesignExportNotify\app\send-notification.ps1` exists;
   - a test notification arrived.
4. [ ] **Owner:** "Close and reopen InDesign, then double-click **SizeSortedExport.jsx**." The log must say **"Problems are also sent to your phone"**.

### Task 7: Size test with pages of different sizes
1. [ ] Put a copy of a document with **different page sizes** into `Desktop\Size Test`. Never use the original.
2. [ ] **Owner:** "On the Size-Sorted dashboard, click **Execute Batch Export**."
3. [ ] **Check:** `Desktop\Size Test\_Exports\` has one folder per page size, each page is in the right one, and there are no red **X** lines in the log.

### Task 8: Get the owner's answers (for the next build)
Ask, and note the answers for Claude Code:
- [ ] Which export formats do designers use besides PDF, JPEG, PNG, IDML and Package (EPS, EPUB, HTML)?
- [ ] Do they need CMYK JPEGs, or only RGB?
- [ ] Should the web queue also export new files from a Google Drive folder automatically, or is choosing files on the web page enough?

## 7. What comes next (Claude Code builds it, not you)

Designers don't want presets: they want control over every setting. The plan is to put everything into the **web Export Queue**:
- **Step 1:**
  - "export each page separately, sorted into size folders";
  - JPEG and PNG with every InDesign setting;
  - PDF General, Compression, Marks & Bleeds;
  - remembered and saved settings per designer.
- **Step 2:** the other PDF tabs (Output, Advanced, Security) and PDF (Interactive).

## 8. If something goes wrong

| Message | What to do |
|---|---|
| "Install.cmd was opened from inside the zip" | Extract the zip first (right-click → Extract All → Desktop), then run it from the extracted folder |
| "Node.js 22.13 or newer is needed" | Shouldn't happen (24.19 is installed). Check `node --version` |
| "No mapped network drive was found" | Open a client drive in File Explorer once, then run the installer again |
| "The running export queue could not be stopped" | Close the old black **InDesign Export Queue** window, or restart the PC, then run the installer again |
| "You clicked No, so the firewall and sleep settings were not changed" | Run the installer again and click **Yes** |
| "InDesign's scripts folder wasn't found" | Open InDesign once, close it, run the installer again |
| The InDesign script still says 1.0.0 | Do task 2 again; the file in Scripts Panel must contain `VERSION = "1.1.0"` |
| Designers can't open the page | Use the IP address from task 3, not the PC name. **Check Export Queue** shows the firewall state |
| Anything else | Copy the exact message, and the last lines of `Desktop\ExportQueue\data\logs\launcher.log` and `server.log`, for Claude Code |

## 9. Report back

When you're done (or stuck), give the owner and Claude Code:
1. The checklist with ticks, and anything that failed with its **exact** message.
2. The address designers use.
3. The results of **Check Export Queue**.
4. The owner's answers from task 8.
