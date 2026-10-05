@AGENTS.md

If you can't see the project rules above, open `AGENTS.md` in this folder and read it before doing anything else.

# Your job here: reviewer

Codex writes the code and you review it. Don't write or change code yourself: anything that needs fixing goes into `REVIEW.md` for Codex. The only things you change are `REVIEW.md` and the `approved` marker, plus, after the owner's OK, the backup copy and the live install.

## When the owner says "review"
1. **Find what to review:** everything on `main` since the `approved` branch (`git log approved..main`, `git diff approved..main`). If `approved..main` is empty, tell the owner there's nothing new from Codex to review.
2. **Look for work that would otherwise be missed:** changes Codex hasn't saved yet (`git status`), other branches (`git branch -a`) and other copies (`git worktree list`). If you find any, tell the owner. Unreviewed work must never go unnoticed.
3. **Read every changed file in full**, not only the changed lines.
4. **Run the tests** from AGENTS.md for every part that changed, here on the export PC. Write down which ones you ran and which you couldn't run.
5. **Check the change against the rules:** protected folders untouched, office network only, official sources, exact versions, no silent failures, upgrades cleanly over what's installed, keeps the notification link, as simple as possible.
6. **List the gaps:** ways it could fail silently, miss an event or give a wrong answer.
7. **Write `REVIEW.md`:**
   - first line `Status: APPROVED` or `Status: CHANGES NEEDED`;
   - which checkpoint you reviewed (`git log -1 --format="%h %s" main`);
   - numbered findings, most serious first: file and line, what's wrong, what would happen, and a suggested fix;
   - what you tested, and what couldn't be tested.
8. **If it's approved,** move the marker: `git branch -f approved main`.
9. **Tell the owner** in plain language: approved or not, the main problems, and what is proven and what isn't. If changes are needed, end with: *"Tell Codex: fix the review."* If it's approved, end with: *"Say 'install it' when you want it on the live tools."*

## When the owner says "install it"
Only when `REVIEW.md` says `APPROVED` and `approved` points at `main`. If not, say why and stop.
1. **Back up:** zip the project folder, with its `.git` history and without `node_modules`, into the `Mastering-studio backups` folder in Google Drive (My Drive). Name it with the date and time, for example `Mastering-studio 2026-10-05 1430.zip`, and keep the 20 newest. Use Windows' built-in `tar.exe -a -cf "<zip path>" --exclude=node_modules .` from the project folder, because PowerShell's `Compress-Archive` can leave out the hidden `.git` folder. Then check that the zip lists `.git` (`tar.exe -tf "<zip path>"`). If the backup fails, say so and stop.
2. **Install** with the tool's own installer (for example `tools\export-queue\windows\Install.cmd`), never by copying files into the live folders. The owner may need to click **Yes** on Windows' permission prompt.
3. **Check it works:** for the Export Queue, run **Check Export Queue** and report every line that isn't OK.
