# InDesign Export Queue

Designers send InDesign export jobs from their own computers to the dedicated **export PC**. They open a web page on the office network, fill in the file path and export settings, and follow progress live. The export PC runs one job at a time, so InDesign is never overloaded, and nobody has to touch the export PC.

![Dashboard](docs/dashboard.png)

---

## 1. Tech stack (all free and open source)

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node.js 22 LTS or newer** | Free. Runs natively on Windows and includes a SQLite database, so there's no database server to install. |
| Web server / API | **Express 5** ([expressjs/express](https://github.com/expressjs/express), 69k★) | The standard Node web framework. It's the only third-party dependency. |
| Queue + job history | **SQLite, built into Node** (`node:sqlite`) | Jobs survive restarts and power cuts, and a job is claimed with one atomic database update, so it can never run twice. |
| Live updates | **Server-Sent Events** (a browser standard) | The dashboard updates instantly with no polling and no extra library, and browsers reconnect by themselves. |
| Web UI | **Plain HTML, CSS and JavaScript** | Custom-built for this workflow. No build step, no framework and no CDN, so it works offline on the LAN and there's nothing to go out of date. |
| InDesign control | **PowerShell → InDesign COM (`DoScript`) → ExtendScript** | Adobe's official Windows automation interface. The export runs synchronously, so "done" really means done. |

**Considered and rejected:**
- **BullMQ (9.4k★):** needs a Redis or PostgreSQL server running on the export PC. That's one more service to install and keep alive, for no benefit with a single worker.
- **React or Vue:** add a build pipeline for a two-screen tool.
- **Existing render farms:** [nexrender](https://github.com/inlife/nexrender) (1.8k★) is for After Effects only, and nothing with 1000+ stars exists for InDesign. Its job-lifecycle design inspired the queue here, but its code isn't used.

## 2. Architecture

```
 Designer PCs / Macs (browser)                     Export PC (Windows, logged-in user)
 ┌──────────────────────────┐   HTTP + live      ┌───────────────────────────────────────────┐
 │  http://EXPORT-PC:8080   │ ◀────events──────▶ │ Node.js  src/server.js                    │
 │  • submission form       │                    │   API (Express) ──▶ SQLite queue (jobs.db)│
 │  • queue dashboard       │                    │   worker: 1 job at a time                 │
 └──────────────────────────┘                    │      │                                    │
                                                  │      ▼ powershell run-indesign.ps1        │
                                                  │   InDesign COM DoScript                   │
                                                  │      ▼                                    │
                                                  │   indesign-worker.jsx (opens, exports,    │
                                                  │   verifies, closes) ──▶ result JSON       │
                                                  └───────────────────────────────────────────┘
                                                         reads/writes \\NAS\Projects\...
```

| File | Role |
|---|---|
| `src/server.js` | Entry point: config, database, worker, web server, graceful shutdown, crash → restart |
| `src/api.js` | REST API + live event stream, validation errors returned per form field |
| `src/db.js` | SQLite job store and queue (atomic claim, crash recovery, history clean-up) |
| `src/worker.js` | Runs pending jobs in order; decides output file names without overwriting |
| `src/indesign.js` | Talks to InDesign through PowerShell; one call at a time, with a timeout |
| `src/paths.js` | Translates Mac/other-drive paths to the export PC's paths; refuses anything outside the allowed drives |
| `src/jobs.js` | The submission rules: formats, presets, page ranges, bleed/slug, package options |
| `scripts/run-indesign.ps1` | COM bridge: connects to (or starts) InDesign and runs the ExtendScript |
| `scripts/indesign-worker.jsx` | Inside InDesign: open → check links/fonts → export → verify output → close |
| `public/` | The web UI (form + dashboard) |
| `windows/` | Install, start (auto-restart) and uninstall scripts for the export PC |

### How a job runs
1. **Submit:** the designer submits. The server translates the path, checks it's on an allowed drive, and checks the `.indd` file exists **before** queuing, so typos fail instantly and don't leave a failed job for later.
2. **Claim:** the worker claims the oldest pending job (an atomic update, so it can't be claimed twice) and picks an output name. By default that's next to the source, and it never overwrites unless asked: `Poster.pdf`, then `Poster (2).pdf`, and so on.
3. **Hand-off to InDesign:** the job goes to InDesign as a JSON file. InDesign's dialogs are switched off during the job, so a missing-font dialog can't block the unattended PC.
4. **Checks before exporting:** InDesign checks for missing links and fonts. They're reported as warnings, or they stop the job if "Don't export if links or fonts are missing" is ticked.
5. **Export:**
   - **PDF (Print)** applies the chosen preset through a temporary copy (built-in presets are locked), so bleed, slug and page range can be set per job. The copy is removed afterwards.
   - **PDF (Interactive)** and **IDML** use InDesign's own export.
   - **Package** uses *File → Package*: fonts, links and a report, plus IDML and/or PDF if chosen.
6. **Verify:** the job only counts as **completed** if the output really exists and was rewritten. The document is closed without saving (unless it was already open on the export PC, in which case it's left open).
7. **Live dashboard:** every open dashboard updates instantly. The submitter gets a pop-up when their job completes or fails, and failures can also go to ntfy.

## 3. Setting up the export PC

> **Sandbox first:** put the Node.js installer and this folder through your security check before installing. Node.js is signed by the OpenJS Foundation; after installation, `npm ci` installs exactly the versions pinned in `package-lock.json`.

1. **Copy this folder** to the export PC, e.g. to the Desktop.
2. **Log in as the Windows user who runs InDesign.** InDesign must be installed and signed in for that user.
3. Right-click **`windows\Install.cmd`** → **Run as administrator**. Administrator rights are only needed for the firewall rule. It does everything else by itself:
   - installs Node.js with winget if it's missing (Node.js is free and signed by the OpenJS Foundation);
   - installs the dependencies;
   - finds this PC's network drives and writes `config.json`, including the `/Volumes/<share>` paths Macs use (it only asks for the drive address if none is mapped);
   - makes the queue start at every login;
   - opens the port for the office network;
   - starts the queue.
4. **Test it from a designer's computer:**
   - Open `http://EXPORT-PC:8080/` (the address is shown in the queue window).
   - Click **Load from InDesign** under the preset field. This checks the connection to InDesign.
   - Submit a small export.

**For a fully unattended PC:** set Windows to sign in automatically, or leave the user logged in, and disable sleep. InDesign needs a logged-in desktop session, so it can't run as a background Windows service. Everything else starts by itself at login.

### `config.json`

| Setting | Meaning |
|---|---|
| `port`, `host` | Where the web page is served. `0.0.0.0` means reachable from the whole office network. |
| `accessKey` | Optional shared password. If set, each browser is asked for it once. |
| `allowedRoots` | Folders jobs may read from and write to, e.g. `"\\\\NAS\\Projects"` or `"P:\\"`. Anything else is refused. In JSON, every `\` is written `\\`. |
| `pathMappings` | How designers' paths map to the export PC. For example, Mac users see `/Volumes/Projects`, while the export PC sees `\\NAS\Projects`. The longest matching `from` wins. |
| `defaultOutputSubfolder` | `""` saves next to the InDesign file. A name like `"Exports"` saves in that subfolder, which is created if needed. |
| `indesign.executor` | `"indesign"` (real). `"simulate"` is only for trying the system out, or for development, on a PC without InDesign. |
| `indesign.progId` | `"InDesign.Application"` uses the installed version. Use `"InDesign.Application.2026"` to force a specific one when several are installed. |
| `indesign.jobTimeoutMinutes` | How long one export may take (default 60). |
| `indesign.killInDesignOnTimeout` | `true` (default): a hung InDesign is closed so the queue carries on. The job is marked failed with the reason. |
| `retentionDays` | How long finished jobs stay in the history (default 30). |
| `ntfy` | Optional push notifications for `failed` and/or `completed` jobs. If the **InDesign export notifier** (`tools/indesign-export-notify`) is installed on this PC, its channel is used automatically for failures. Successful exports are already announced by that notifier. |

## 4. Using it (designers)

1. Open `http://EXPORT-PC:8080/` (bookmark it). Enter your name once; the browser remembers it.
2. Paste the path of the `.indd` file:
   - **Windows:** Shift + right-click the file → **Copy as path**.
   - **Mac:** in Finder, right-click the file, hold **Option**, and choose **Copy "…" as Pathname**.
3. Choose the format. For PDF (Print), pick a preset; the list comes from the export PC's InDesign.
4. Set pages (`All`, `1-4, 7`, or `+1-+3` for absolute page positions in documents with sections) and bleed/slug.
5. Click **Add to queue** and follow the job in the dashboard. **Only my jobs** filters the list to your own.
   - **Failed** jobs show InDesign's reason.
   - **Warnings** list missing links and fonts.
   - **Run again** re-queues a finished job.
   - **Cancel** removes a waiting job.

## 5. Reliability and safety

| Situation | What happens |
|---|---|
| Server crashes | `start.cmd` restarts it within 10 s. A job that was running is marked **failed** ("server stopped while this job was running"), never silently re-run. Waiting jobs are kept. |
| PC restarts | The queue starts at login. Waiting jobs are still there. |
| InDesign hangs or shows an unexpected dialog | After `jobTimeoutMinutes` the job fails with a clear reason. InDesign is closed (if configured) so the next job can run. |
| Network drive unavailable | The path is checked when the job is submitted **and** again when it runs, and a clear message is shown. |
| Wrong or missing preset | The job fails and lists the presets that *are* installed. |
| InDesign says "done" but no file appeared | The job is marked **failed**, never "completed". |
| Server unreachable | The page shows "Offline", and keeps trying to reconnect. |
| Started twice | The second copy explains that the queue is already running, and stops. |
| Security | Only paths inside `allowedRoots` are accepted, and `..` is refused. Pages are protected against script injection (strict content security policy, no HTML from job data). There's an optional access key. |
| Logs | `data\logs\server.log` (rotated, 3 × 5 MB). |

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| Designers can't open the page | Run `windows\Install.cmd` as administrator (firewall), or check the address shown in the queue window. |
| "Could not start or connect to InDesign" | Open InDesign once by hand as this Windows user (licence and sign-in). If several versions are installed, set `indesign.progId`. |
| "That location isn't on a drive the export PC is allowed to use" | Add the drive to `allowedRoots`, or add a `pathMappings` entry for how that designer sees it. |
| "doesn't exist or the export PC can't see it" | The export PC must reach the same share. Check it in File Explorer **as the queue's Windows user**. UNC paths (`\\NAS\...`) are more reliable than drive letters. |
| Jobs time out | Increase `indesign.jobTimeoutMinutes` for very large documents. Also check the export PC for an InDesign dialog, such as crash recovery after a forced close. |

## 7. What is tested

`npm test` runs 32 automated tests:
- **Server end to end:** real HTTP, a real database and real files, with a stand-in for InDesign. Covers queue order, output naming, validation, cancel and re-run, live events, the access key, crash recovery, and config errors.
- **Path rules:** Windows, Mac and `smb://` paths, mappings, and refusal of anything outside the allowed drives.
- **`indesign-worker.jsx`:** run against a stand-in for InDesign's scripting model. Covers preset copying, bleed, slug and page range, missing links and fonts, package arguments, output checks, and cleanup.
- **The PowerShell bridge code:** success, InDesign errors, crashes, missing results, and timeouts.

The web UI was also checked in a real browser, in simulation mode, on desktop and phone sizes.

**Not tested yet:** real Adobe InDesign on a real Windows PC, which wasn't available in the development environment. Do the first real run with a copy of a small document:
- Check each format once.
- Look at the PDF's bleed and page range.
- Try one package.

Report anything unexpected along with the job's error text.

**Known limits:**
- The export is one step inside InDesign, so progress is shown as elapsed time, not a percentage.
- Page ranges use InDesign's page names (section numbering).
- Dialogs that InDesign shows *at start-up* (such as crash recovery) appear before any script runs. After a forced close, check the export PC once.

## Development

```
npm install
npm test
# Try it without InDesign: set "indesign": { "executor": "simulate" } and point
# "allowedRoots" at a local folder, then:
npm start
```
