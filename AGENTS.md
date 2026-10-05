# Project rules

These are the owner's standing rules for this project. Every AI that works here (Codex, Claude or any other) follows them in every session without being asked. Codex reads this file by itself; Claude loads it through `CLAUDE.md`.

## Who does what
- **Codex writes the code.**
- **Claude reviews it.** Claude checks, tests and explains. It doesn't write or change the code; anything that needs fixing goes into `REVIEW.md` for Codex.
- **The owner (Yair) decides.** Nothing is installed on the live tools until Claude has approved it and the owner has said OK.

## Where everything lives: the export PC
- **The project folder** (the folder that holds this file) is the only place where code is written. Don't put it inside Google Drive: syncing while Codex works can damage the history. Backups go to Google Drive as zip files instead.
- **Work directly in the project folder, on the `main` branch.** Don't leave work in another copy, worktree or branch. Claude only reviews `main`, so work anywhere else would never be reviewed.
- **The live tools are never edited by hand.** They change only through their installers (for example `Install.cmd`), after approval. Never delete or change:

| What | Where |
|---|---|
| The running Export Queue, its settings and job history | `C:\Users\ONE_Legacy\Desktop\ExportQueue\` (including `config.json` and `data\`) |
| The notification channel (the link on everyone's phones) | `%APPDATA%\InDesignExportNotify\` (including `channel.txt`) |
| Size-Sorted Export settings and log | `%APPDATA%\SizeSortedExport\` |
| InDesign's scripts, including the owner's own | `%APPDATA%\Adobe\InDesign\Version 21.0\<language>\Scripts\Scripts Panel\` |
| Client drives and client files | M:, N:, O:, P:, R:, W:, X:, Y:, I:, L:, G: (Google Drive), `Desktop\Size Test` |

- **Real InDesign tests** only when the Export Queue has no running or waiting jobs, and only on a copy of a small document in a new folder, never on the original.

## How a change gets from an idea to the live tools
1. **Codex, before you start anything:** open `REVIEW.md`. If its status is `CHANGES NEEDED`, fix those findings first. Under each finding, add `Fixed in <checkpoint>` or `Not fixing, because …`. Don't change the status line; only Claude does.
2. **Codex makes the change** and runs the tests (see *Test before handing over* below).
3. **Codex saves a checkpoint:** a git commit on `main`. The message says, in plain words, what changed, which tests ran and passed, and what could not be tested.
4. **Claude reviews** everything since the last approved checkpoint (the `approved` branch marks it). It writes the result in `REVIEW.md`: `APPROVED`, or `CHANGES NEEDED` with numbered findings. Repeat from step 1 until it says `APPROVED`. On approval, Claude moves the `approved` marker.
5. **Only when the owner says OK,** Claude saves a backup copy, installs the approved version with the installer, and checks that it works.

`REVIEW.md` is a hand-over note between Codex and Claude. It isn't saved in the history (it's in `.gitignore`).

## Superpowers (Codex's working method)
The owner installed Superpowers (obra/superpowers, MIT, from the official Codex plugin list) so Codex plans, tests first and checks its own work. Use its skills, but where they clash with this file, this file wins:
- **No separate copies or branches.** Skip `using-git-worktrees`, and skip `finishing-a-development-branch`'s branch, merge and pull-request steps. "Finished" here means: tests pass, a checkpoint is saved on `main` in this folder, and the work is handed to Claude.
- **Claude's review is still required.** Superpowers' own code review and checks are extra, not a replacement.
- **Plans and designs** go where Superpowers puts them (`docs/superpowers/`) and are saved in the checkpoint with the code, so Claude can review the code against them.
- **The brainstorming "visual companion"** may only run on this PC (`127.0.0.1`, its default). Never start it with `--host 0.0.0.0`.

## How we choose tools
- **Don't build what already exists.** Look to the community first.
- **Free over paid.**
- **Only use projects with 1000+ GitHub stars.** Check the star count before recommending anything.
- **Only build safe, usable software.** Everything we ship must be safe to run on the office machines as it is, with no separate security check needed. Only use official, signed sources (for example winget packages), pin exact versions, never download or run anything hidden, keep services limited to the office network, and keep setup simple enough that the owner and staff can use it straight away.

## Reliability rules (the export notifier and anything else we ship here)
The goal is a fail-safe system the owner can just trust. Less complex usually means better.

- **Apply reliability fixes proactively.** After any change, list the gaps: ways it could fail silently, miss an event, or give a wrong answer. Fix the ones that are small and low-risk in the same change, without waiting to be asked. Only ask first about fixes that add real complexity, cost money, or change how people use it.
- **No silent failures.** If something can break, there must be a visible signal (status message, log, warning), or it must repair itself.
- **Prefer the simplest fix that works.** Don't add servers, accounts, certificates or extra setup steps unless there is no simpler way. Setup for the owner and staff must stay "double-click / open a link".
- **Test before handing over.** Run `node tools/indesign-export-notify/tests/test-export-notify.js` and `tools/indesign-export-notify/tests/test-receiver.sh <pwsh> <ntfy>`, and test the other PowerShell scripts with a real ntfy server whenever they change. For the export queue (`tools/export-queue`), run `npm test` and `npm run test:windows` (needs `pwsh`) there, and check the UI in a browser in simulate mode. For the size-sorted export script, run `node --test tools/indesign-size-export/tests/test-size-export.js`. Be explicit about what could not be tested.
- **Keep existing installs working.** Changes must upgrade cleanly over what is already installed on the export PC, and must keep the existing notification link.

## Talking to the owner
The owner is not a developer. Explain in plain language, give exact click-by-click steps, and say clearly what is proven and what isn't.
