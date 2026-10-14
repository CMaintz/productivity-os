# Vault setup

## 1. Create the vault (on the main PC)
```powershell
npm run inventory   # if you haven't already: gives the vault one note per project
npm run vault       # creates %USERPROFILE%\Vault from vault-template/, seeds Projects/, git init + commit
# custom location: node tools/vault/init.mjs --path D:\Vault --from-inventory out/inventory.json --git
```
The script is safe to re-run: it only adds files that are missing and never overwrites. Projects with a commit in the last 60 days start as `active`; the rest start as `paused`. Fix any wrong statuses in the Projects base.

Keep the vault **outside** `Projects`. It isn't a project.

## 2. Obsidian
Open the folder as a vault, then:
- **Core plugins** (Settings → Core plugins): Bases, Daily notes, Templates. The template already configures their settings.
- **Community plugins:**
  - **Tasks:** task queries on Home and due dates.
  - **Homepage:** set it to open `Home.md` on startup.
  - Later phases: **Meta Bind** for action-card buttons and **Datacore** for custom widgets and the project file panel.

## 3. Claude Code in the vault
```powershell
cd $env:USERPROFILE\Vault
claude
/plugin marketplace add kepano/obsidian-skills   # teaches Claude Obsidian markdown, Bases and Canvas syntax
```
Then try `/today`, `/capture buy a domain for the blog redesign`, and `/shutdown`. The rules Claude follows are in `CLAUDE.md` and `_system/policy.md`, and every change it makes is logged in `_system/changelog.md`.

## 4. Track your Claude Code sessions
```powershell
npm run hooks      # adds the session hook to ~/.claude/settings.json (backs it up first)
```
From then on, every Claude Code session on this PC gets a note in `Sessions/`. The note's status is:
- `running`: working on a prompt.
- `waiting`: needs your permission or input, and says why.
- `idle`: finished its turn.
- `ended`: closed.

Home shows active sessions, and `/today` lists the ones waiting on you. Note previews are shortened. The full prompt text only goes to `_system/activity.jsonl`, which is git-ignored and excluded from Syncthing, so it stays on this PC.

The vault location defaults to `~/Vault`. Set `PRODUCTIVITY_VAULT` to use another path. To remove the hook: `node tools/hooks/install.mjs --uninstall`.

## 5. Keeping the vault up to date
- **After moving project folders** (or now and then): `npm run inventory` then `npm run vault`. New projects get notes. Existing notes get their `path`/`repo` updated and their **Docs** section rebuilt (Repo vs Local only). Your tasks, log and status are left alone.
- **When the template improves** (new skills, Bases, contract): `node tools/vault/init.mjs --update-system`. This replaces `CLAUDE.md`, `.claude/skills/` and `Bases/`, and copies the old versions to `_system/backup/<timestamp>/`. `Home.md` is yours, so it's never replaced. If you set the vault up before sessions existed, add this to it:
  ```markdown
  ## Claude sessions
  ![[Sessions.base#Active]]
  ```

## 6. GitHub data in project notes
```powershell
npm run github     # needs `gh auth login`; read-only on GitHub
```
Every project note with a `repo` gets:
- A generated `## GitHub` section: default-branch CI, open PRs with CI and review state, Foundry agent tickets (ready, working, blocked) and open issues.
- Frontmatter fields: `ci`, `open_prs`, `failing_prs`, `agent_blocked`. These feed the **Needs attention** view on Home.

`/today` runs the sync itself, and `/resume <project>` and `/next` use this data.

## 7. Action cards and the executor
Suggestions arrive as **cards** in `_system/actions/`, shown on Home under **Waiting on me**. Each card has buttons:
- **Do it**
- **Not now** (comes back tomorrow)
- **No** (with an optional "why not")
- **Always do this**
- **Never suggest this**
- **Undo**

The buttons only change the card's `status`, so they work on your phone too. They need the **Meta Bind** community plugin.

The **executor** on the main PC does the work:
- Picks up approved cards, runs them, and writes the result onto the card.
- Records every decision in `_system/policy.md`, the trust ladder. Enough approvals in a row produce a card proposing the next level ("let pause_stale_project run on its own"). A reject or undo drops the type back a level.
- Never raises an action type above its `max`. Anything that sends, spends, deletes or merges stays at "suggest".

| Card type | Where it comes from | What "Do it" does |
|---|---|---|
| `fix_ci` | default branch failing | A Claude Code session in the repo fixes it on a branch and opens a PR. Never pushes to main or merges. |
| `pause_stale_project` | active, but untouched for 21 days | Sets `status: paused`. Undo restores it. |
| `triage_inbox` | 5+ notes in Inbox | Claude files them per `CLAUDE.md`. Starts at auto-notice. |
| `reminder` | blocked agent tickets | Nothing; marks it seen. |
| `claude_task` | `/suggest` (judgement calls) | A Claude Code session runs the card's instructions. Always needs a click. |

```powershell
npm run suggest     # create cards from the current vault state (also part of /today)
npm run executor    # one pass by hand
powershell -ExecutionPolicy Bypass -File tools\actions\install-executor.ps1   # run it hidden at logon: a pass every minute, suggestions hourly
```
- **Usage:** Claude runs use your subscription (`claude -p`), so each approved `fix_ci`, `triage_inbox` or `claude_task` card counts toward your usage limits.
- **Main PC only:** the executor runs only on the PC named in `_system/tools.json` (`mainHost`, set on first setup) and never twice at once.

## 8. Web dashboard
`dash.maintz.dev` shows the vault from anywhere: today's top 3, cards with working buttons, Claude sessions, projects needing attention, and active projects. The executor keeps it in sync:
- **Before each pass:** it applies button presses from the dashboard to the card notes. These are the same fields Meta Bind sets, and a press only counts if the card is still waiting on it.
- **After each pass:** it publishes a fresh snapshot.

The snapshot holds metadata only (titles, statuses, counts, one-line reasons), never note text, tasks or prompts. Setup is in `docs/SETUP-GUIDE.md` step 8. The code is in `dashboard/`, `tools/dashboard/` and `supabase/migrations/`.

## 9. Sync to other PCs and Android
- **Syncthing** (free). On Android use **Syncthing-Fork**, because the official Android app was discontinued.
  - Share the vault folder with your other devices.
  - The template's `.stignore` excludes `.git`, so git history stays on the main PC only. Syncing a `.git` folder between devices can corrupt it.
- **Or Obsidian Sync** (paid, simplest). If you use it, exclude nothing; git stays local on the main PC either way.
- Run Claude Code against the vault **only on the main PC**, so that two agents never edit at the same time.

## What's in the template
| Path | Purpose |
|---|---|
| `CLAUDE.md` | Agent contract: folders, frontmatter schema, what it may do without asking |
| `Home.md` | Dashboard: today's tasks, pending action cards, active projects, writing pipeline, inbox |
| `Bases/*.base` | Views over the frontmatter (projects, writing, actions, specs, sessions, inbox) |
| `Templates/` | Templates for daily, project, post, spec and action-card notes |
| `.claude/skills/` | `/today`, `/capture`, `/shutdown` |
| `_system/` | Policy (trust ladder), changelog, memory/preferences, action cards |
