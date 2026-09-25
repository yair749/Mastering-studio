# Project rules

These are the owner's standing rules for this repository. Follow them in every session without being asked.

## How we choose tools
- **Don't build what already exists.** Look to the community first.
- **Free over paid.**
- **Only use projects with 1000+ GitHub stars.** Check the star count before recommending anything.
- **Sandbox first.** Anything we download is put through a sandbox security check before it runs on a real machine. Say so whenever a new download is involved, and give the checksum or verification step if one exists.

## Reliability rules (the export notifier and anything else we ship here)
The goal is a fail-safe system the owner can just trust. Less complex usually means better.

- **Apply reliability fixes proactively.** After any change, list the gaps: ways it could fail silently, miss an event, or give a wrong answer. Fix the ones that are small and low-risk in the same change, without waiting to be asked. Only ask first about fixes that add real complexity, cost money, or change how people use it.
- **No silent failures.** If something can break, there must be a visible signal (status message, log, warning), or it must repair itself.
- **Prefer the simplest fix that works.** Don't add servers, accounts, certificates or extra setup steps unless there is no simpler way. Setup for the owner and staff must stay "double-click / open a link".
- **Test before pushing.** Run `node tools/indesign-export-notify/tests/test-export-notify.js` and `tools/indesign-export-notify/tests/test-receiver.sh <pwsh> <ntfy>`, and test the other PowerShell scripts with a real ntfy server whenever they change. For the export queue (`tools/export-queue`), run `npm test` and `npm run test:windows` (needs `pwsh`) there, and check the UI in a browser in simulate mode. Be explicit about what could not be tested (for example: no real InDesign or Windows available).
- **Keep existing installs working.** Changes must upgrade cleanly over what is already installed on the export PC, and must keep the existing notification link.

## Talking to the owner
The owner is not a developer. Explain in plain language, give exact click-by-click steps, and say clearly what is proven and what isn't.
