# Handover: set up "Codex codes, Claude reviews" on the export PC

**For:** Claude on the export PC: the **Code** tab of the Claude desktop app (best, because it reads `CLAUDE.md` by itself), or Cowork.
**Owner:** Yair (ONE Agency). He isn't a developer and is tired of doing steps by hand.
**Your job:** do every step you can yourself. Only ask the owner for what Windows won't let you do (the "Yes" prompt) or what only he knows, one short question at a time. Then check the result yourself.

---

## 1. What the owner decided
- **Codex writes the code. Claude reviews it.** Claude doesn't write code.
- **Everything lives on this export PC.** GitHub isn't used from now on.
- The rules for both are in `AGENTS.md` (Codex reads it by itself) and `CLAUDE.md` (it loads `AGENTS.md` for Claude, and holds your reviewer steps). Read both now.

**Why the two can't talk to each other directly:** the plugins that connect Codex and Claude were checked and ruled out:
- OpenAI's Codex plugin for Claude Code has a known Windows problem: its reviews and tasks come back empty without an error, unless Codex is given full access to the whole PC.
- The plugin that works the other way round (Claude inside Codex) has about 200 GitHub stars, below the owner's 1000+ rule.

So they hand work to each other through files in one shared folder.

**On hold:** don't do the install tasks in `HANDOVER-COWORK.md` yet. Codex's work may already be ahead of that version. The first install happens after the first review below is approved.

## 2. Steps

### Step 1: Check the tools
- Run `git --version`. If Git is missing, install it from Windows' official source: `winget install --id Git.Git --exact --source winget`. Write down the version it installed.
- Run `node --version` (24.19 is expected).

### Step 2: Find Codex's folder
Ask the owner: *"Which folder do you open in Codex?"* If he doesn't know, look for recently changed folders containing `tools\export-queue`, `package.json` or `AGENTS.md` (Desktop, Documents, `C:\Users\ONE_Legacy\Projects`). Confirm the folder with him before you go on.

- **If it's a normal folder:** it becomes the project folder. Leave it where it is, so Codex keeps working in it.
- **If it's a live folder** (for example `Desktop\ExportQueue`), Codex has been editing the running tools directly. Tell the owner, and don't change the live folder. Copy only the code, without `config.json`, `data\`, `node_modules\`, logs or `demo\`, into `C:\Users\ONE_Legacy\Projects\Mastering-studio`. Ask him to open that folder in Codex from now on.
- **If it's inside Google Drive (G:):** copy it out the same way into `C:\Users\ONE_Legacy\Projects\Mastering-studio`. Syncing can damage the history while Codex works.

### Step 3: Bring in the last GitHub version, so nothing is lost
1. Download `https://github.com/yair749/Mastering-studio/archive/refs/heads/claude/compassionate-curie-z36k9m.zip` and extract it into `Downloads\Mastering-studio-github`, **not** into the project folder.
2. Compare it with the project folder. Give the owner a short list of three things:
   - what only GitHub has (for example: Size-Sorted Export 1.1.0, and the Export Queue installer that recognises old queue copies running from any folder);
   - what only Codex has;
   - what both changed differently.
3. **Don't overwrite Codex's files.** Anything that's only in GitHub and still needed goes into `REVIEW.md` as a finding for Codex to bring in.

### Step 4: Set up the project folder
1. Copy `AGENTS.md`, `CLAUDE.md` and `.gitignore` from the GitHub download into the project folder.
   - If there's already an `AGENTS.md` (Codex may have written one), combine the two. Keep the owner's rules word for word, and put Codex's notes below them.
   - If there's already a `.gitignore`, add the line `REVIEW.md` to it.
2. **If the folder isn't a git repository yet:**
   - run `git init -b main`;
   - run `git config user.name "ONE export PC"` and `git config user.email "export-pc@localhost"`;
   - first save the GitHub version as a checkpoint, *"GitHub version (written by Claude, up to 28 Sep 2026)"*, if the folder layouts match;
   - then save Codex's folder on top as a second checkpoint, *"Codex's work so far"*.
3. **If it already is a git repository:** save any unsaved work as a checkpoint, *"Codex's work so far"*. Make sure the work is on `main`: check `git branch -a` and `git worktree list`, and ask the owner before combining anything.
4. **Create the `approved` marker** at the last version a Claude reviewed:
   - the GitHub-version checkpoint from step 2, or commit `356d407` if the history contains it;
   - if neither exists, the current checkpoint. Treat the comparison in Step 3 as the first review, and say so in `REVIEW.md`.

   Command: `git branch approved <checkpoint>`.

### Step 5: First review
Follow "When the owner says review" in `CLAUDE.md`. The first review covers Codex's work since the `approved` marker, plus the findings from Step 3. Tell the owner the result.

### Step 6: Backups
Create the folder `Mastering-studio backups` in Google Drive (My Drive). Make a first backup right away, as described under "install it" in `CLAUDE.md`. Check the zip lists `.git`.

### Step 7: Give the owner his cheat sheet
Show him this, and offer to save it as `Codex and Claude - how to.txt` on the Desktop:

> **Making a change (four sentences, two apps, same folder):**
> 1. **In Codex:** say what you want changed. Wait until Codex says it's done and saved.
> 2. **In Claude (Code tab):** type **review**.
> 3. If Claude says *changes needed*: **in Codex**, type **fix the review**. Then go back to 2.
> 4. When Claude says *approved*: **in Claude**, type **install it**, and click **Yes** if Windows asks.
>
> If you use Cowork instead of the Code tab, start with: *"Read CLAUDE.md in the project folder first."*
> If Codex asks where a new chat should run, pick the option that works in your own folder on this PC (usually **Local**), not Worktree or Cloud.
> In Codex, keep the normal mode where it asks before doing anything outside the project folder. Don't choose **Full access**: this PC holds every client's files.

### Step 7b: Superpowers in Codex
The owner wants Superpowers (obra/superpowers) in Codex. Codex's plugins are installed inside the Codex app, so give the owner these steps, one at a time:
1. In the Codex app, click **Plugins** in the sidebar.
2. Find **Superpowers** in the **Coding** section and click the **+** next to it. Follow the prompts.
3. In a new Codex chat in the project folder, type: *"Do you have Superpowers? List its skills, then read AGENTS.md and tell me what it says about Superpowers."*

It works if Codex lists skills such as brainstorming, writing-plans, test-driven-development and verification-before-completion, and says it will work on `main` with no separate worktree. If it doesn't, tell the owner. Never let Superpowers seem active when it isn't.

### Step 8: Test the whole loop once
Ask Codex, through the owner, for a tiny harmless change: for example, one line in a README. Then run the loop once from start to finish: review, approve, back up. Skip the install for a README-only change. That proves the hand-over works before real work goes through it.

## 3. When you're done
Tell the owner, in plain language:
- which folder is the project folder;
- what the GitHub comparison found;
- the first review's result;
- where the backups are.

Also suggest this once: the GitHub repository is public, and it shows the office network addresses and client drive names. Now that it's no longer used, he can make it private: on github.com, open the repository → **Settings** → bottom of the page → **Change visibility** → **Private**. Wait until Step 3 is done, because the download link stops working once it's private.
