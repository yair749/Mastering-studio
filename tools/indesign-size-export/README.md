# Size-Sorted Export (InDesign script)

A floating dashboard inside InDesign on the exporting machine. It exports **every page on its own**, into a folder named after **that page's size**. That suits documents that mix social posts, banners and print sheets:

```
My Drive/Clients/_Exports/
    1080x1080/     Poster_Page_01_1080x1080.jpg   .png   .pdf
    1920x1080/     Poster_Page_03_1920x1080.jpg ...
    A4/            Poster_Page_02_A4.pdf ...
    A4-landscape/  ...
```

It can export the active document, or every InDesign file in a folder such as a Google Drive folder. It can also **watch** that folder: new and changed files are exported by themselves once Google Drive has finished syncing them.

## Install (on the exporting machine)

1. In InDesign: **Window → Utilities → Scripts**.
2. In the Scripts panel, right-click **User** → **Reveal in Explorer** (Mac: **Reveal in Finder**).
3. Copy `SizeSortedExport.jsx` into that folder.
4. Double-click **SizeSortedExport.jsx** in the Scripts panel, and the dashboard opens. Running it again brings the same dashboard to the front.

To have the dashboard open every time InDesign starts, put the file in InDesign's **Startup Scripts** folder instead. That's the `Startup Scripts` folder next to `Scripts Panel`, one level up from the folder in step 2.

> **Sandbox first:** it's a plain text script with nothing to download. Read it or put it through your checks before copying it to the exporting machine.

## Using the dashboard

| Section | What it does |
|---|---|
| **Folders** | **Choose…** the root folder (e.g. `G:\My Drive\Clients`). Exports go into a subfolder of it (`_Exports`), which is never read as input. |
| **Documents** | *The active document*, or *Every InDesign file in the root folder* (subfolders too). **Watch** checks the folder every 1–30 minutes while InDesign is idle. |
| **Formats** | Tick PDF, JPEG and/or PNG. Choose a **PDF preset** (the list comes from this InDesign; **Refresh** after adding one). **Image resolution**: 72 keeps pixel sizes (a 1080 px page becomes 1080 px), 150/300 for print proofs, or Custom. |
| **Folder and file names** | Template tokens: `{doc}` `{page}` (01, 02…) `{pagename}` (the page number as shown in InDesign) `{size}` `{format}`. Size folders use paper names (A4, A3, Letter, DL…, `-landscape` when turned) and pixels (`1080x1350`) or millimetres (`200x99mm`) for everything else. |
| **Status** | Progress, and a log of everything that happened. ✗ lines are problems, ! lines are warnings. **Open log file** shows the full history (`export-log.txt`). |

Click **Execute Batch Export** to run it now.

## What it does to stay reliable

- **Files still syncing:** a file is only opened once its size and date have stayed the same (3 seconds for a manual run; two checks in a row for Watch). Empty, locked or still-changing files are skipped with the reason, then tried again next time.
- **One problem doesn't stop the batch.** A page or format that fails is logged with the document, page, size and format, and everything else still exports. A file InDesign can't open is logged, and the next one carries on.
- **Every file is verified.** An export only counts once the file really exists and isn't empty.
- **No dialogs block the machine.** Missing fonts, links and "convert document" prompts are switched off during a batch and back on afterwards.
- **Nothing is left changed:**
  - your own **File → Export** settings for JPEG, PNG and PDF are put back;
  - the temporary PDF preset is removed (leftovers from a crash are cleaned up next time);
  - documents the script opened are closed without saving, and documents that were already open stay open.
- **No overwriting by accident.** Two documents that would produce the same name get `Name (2)`, never replacing each other. With **Replace earlier exports** ticked, files of the same name from earlier runs are replaced.
- **Missing links are reported.** They usually mean Google Drive hasn't finished syncing the Links folder.
- **A document open elsewhere is noted.** If a designer has it open on another computer, the log says the last synced version was exported.

- **Problems reach your phone.** If the **InDesign export notifier** is installed on the exporting machine, failed exports and "the Google Drive folder can't be reached" are sent to the same phone channel as your export notifications. A dead folder alerts once, not every few minutes. The notifier already announces finished exports, so only problems are sent. The dashboard says at start-up whether phone alerts are on.
- **Watch mode comes back by itself.** It remembers that it was on, and carries on when the dashboard opens again. Put the script in **Startup Scripts** so that happens whenever InDesign starts.

## Tips for Google Drive

- On the exporting machine, set Google Drive for desktop to **Mirror files**, not *Stream files*: Drive icon → ⚙ Settings → Google Drive → **Mirror files**. Streamed files are only downloaded when opened, which makes every export slow and can time out.
- Keep links inside the synced folder (e.g. a `Links` folder next to the `.indd`), with the same folder structure on every machine.

## How it works (for adjusting it)

The code is split into small parts. Each is described at the top of `SizeSortedExport.jsx`.

- **The window's look:** all in `Dashboard.prototype.build`, between `LAYOUT` and `end of LAYOUT`. `LABEL_W` and `FIELD_W` set column widths, `logList.preferredSize` sets the log size, and each panel has its own `margins`.
- **Page size:** from `page.bounds` with the script's unit set to points. InDesign's pixel is the point, so a 1080 px page is 1080 pt. Paper sizes match within 0.5 mm; the paper list is `PAPER`.
- **Per-page export:** each format (`PdfExporter`, `JpegExporter`, `PngExporter`) sets its own options for one page just before exporting it, using that page's range (the page's name, or `+N` when two sections share a page name). The PDF preset is copied once per batch with *spreads* off, because built-in presets are locked.
- **Watch mode** uses an InDesign **idle task**, so it never interrupts work in progress. `#targetengine` (line 1) keeps the dashboard and the idle task alive after the script has run.

## Tests

`node --test tools/indesign-size-export/tests/test-size-export.js` runs the real script against a stand-in for InDesign and ScriptUI (`tests/indesign-stub.js`). That stand-in removes everything InDesign's older JavaScript doesn't have, so newer JavaScript used by mistake fails the test. 22 tests cover:
- size names and file names;
- mixed-size documents in all three formats, with the settings checked at each single export;
- failures that stop only one page;
- files still syncing, locked or empty;
- presets that aren't installed;
- name clashes, sections, and already-open documents;
- the watch logic;
- saved settings;
- the dashboard's buttons;
- phone alerts (and one real alert sent through the notifier's sender to a real ntfy server);
- Watch resuming after a restart.

**Not tested:**
- Real InDesign wasn't available. That includes the look of the window, and InDesign's exact behaviour with page ranges and preset copying.
- Clicks during a long batch: InDesign scripts can't react to them until the batch ends. The window still shows progress.

Try it first on a copy of one mixed-size document, and check each format once.

## Alongside the export queue

This script and the **export queue** (`tools/export-queue`) can both run on the same exporting machine. InDesign does one thing at a time: if the queue sends a job while this script is exporting, the job waits (up to 2 minutes) and then goes back into the queue until InDesign is free.
