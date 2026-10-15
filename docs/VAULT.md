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

## 9. Widgets
Everything on the dashboard is a widget: a small JSON file in `_system/widgets/`, placed by `_system/layouts/dashboard.json`.
- **Sources:**
  - `snapshot` covers projects, cards, sessions and today.
  - `notes` covers any folder, publishing only the frontmatter fields the widget lists.
- **Views:** `stat`, `list`, `table`, `kanban`, `bar`, plus the built-in `today` and `cards`.
- **Getting a new one:** ask `/widget show my drafts by platform`. It arrives as an action card; approve it to add the widget, or Undo to remove it.
- **In Obsidian:** the same Preact views render through the **Datacore** plugin. `Widgets.md` shows how to embed one. Install Datacore (Community plugins) for this.
- **Code:**
  - `dashboard/src/widgets/` holds the views.
  - `tools/widgets/` holds the query engine, validation and manifests.
  - `npm run widgets:build` regenerates `views.md` and the demo data. Tests fail if you forget.

## 10. Code widgets
When a manifest isn't enough (custom layout, interaction, or a view `where`/`sort` can't express), the orchestrator asks for a **code widget**: a small Preact component an agent builds, tests and ships through a PR. Code widgets render on the **web dashboard only**; in Obsidian their panel says so.

1. **Request:** `/widget` proposes a `build_code_widget` card. Approving it opens an `agent:ready` + `widget:code` ticket for the Foundry `/feature` loop. These cards always need your click.
2. **Build:** the agent adds `dashboard/src/widgets/code/<id>/`:
   - `widget.ts`: `createWidget(host)` returns `({ m, rows, ctx }) => VNode`, using `host.h`.
   - `widget.json`: the manifest, with `view: "code:<id>"`, a `snapshot` source over projects, cards or sessions, and a `permissions` block listing exactly the collection and fields it reads, with `connectors: []`.
   - `fixture.json`: sample `rows`, plus `expect`, strings the render must contain.

   It then runs `node tools/widgets/code-registry.mjs`, which writes `code/catalog.ts` (manifests and fixtures) and `code/renderers.ts` (the code).
3. **Isolation:**
   - Each code widget runs in its own **sandboxed iframe** (`allow-scripts` only). That gives it an opaque origin with no access to the page, your session, storage or card buttons.
   - The frame's CSP allows no network at all.
   - It receives its rows and the time, and can only send back its height or an error.
   - The dashboard page itself never loads widget code; it only imports the catalog.
   - An ESLint rule also keeps widget code free of network, storage, DOM globals, timers and dynamic code.
4. **Ship:**
   - `node tools/widgets/guard.mjs` passes only when the PR:
     - stays inside widget folders, plus the two generated files, which must be exactly what the generator writes
     - keeps `view` equal to `code:<id>`
     - doesn't widen what any widget reads: its permissions or its source
   - Then CI auto-merges and deploys. Anything else is labelled `widget:needs-review` for you.
5. **Install:** the executor checks merged `widget:code` PRs every 10 minutes (via `gh`). Each new widget arrives as an **auto-notice** card, already live, with **Undo**. Undo takes it off the dashboard at once, and a follow-up card offers to remove its code. A GitHub hiccup is retried; only a real 404 counts as "removed".
6. **Off-switch:**
   - The dashboard reports crashes to Supabase: widget id and message, under the id of the frame that crashed.
   - After 3 crashes in 24 hours, the executor switches the widget off (`"disabled": true` in the layout) and proposes a `fix_widget` ticket. The ticket carries only the error types; the messages stay on the vault card.
   - The fix ships the same way and switches it back on.

Preview any code widget from its fixture: `npm --workspace dashboard run dev`, then `/?demo&widget=<id>` (or `widget=all`).

## 11. Sync to other PCs and Android
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
