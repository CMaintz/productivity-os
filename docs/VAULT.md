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
Every executor pass (section 4b, once a minute) reads Claude Code's own transcripts in `~/.claude/projects/` and keeps a note per session in `Sessions/`. Nothing runs inside your sessions: no hook, nothing in their context. It reads only what was added since the last pass, and skips headless runs (`claude -p`, the Product Forge's workers) and sub-agents. A session resumed in another folder stays one note. Transcripts untouched for two weeks before the first sync are left alone. Its bookkeeping lives in `~/.productivity-os/sessions-sync.json`, outside the vault, so it never syncs to your phone. The note's status is:
- `running`: working on a prompt.
- `waiting`: a tool call has had no result for over a minute, which usually means it needs your permission.
- `idle`: finished its turn, was interrupted, or silent for 30 minutes.

Home shows active sessions, and `/today` lists the ones waiting on you. Note previews are shortened. The full prompt text only goes to `_system/activity.jsonl`, which is git-ignored and excluded from Syncthing, so it stays on this PC.

```powershell
npm run hooks      # the usage status line; also removes the old session hook (backs settings up first)
```
The vault location defaults to `~/Vault`. Set `PRODUCTIVITY_VAULT` to use another path.

## 5. Keeping the vault up to date
- **After moving project folders** (or now and then): `npm run inventory` then `npm run vault`. New projects get notes. Existing notes get their `path`/`repo` updated and their **Docs** section rebuilt (Repo vs Local only). Your tasks, log and status are left alone.
  A note belongs to one checkout: it is matched by `path`, then by `repo` or name when its folder moved. A second clone of a repo gets its own note, prefixed with its parent folder when the name is taken, and worktrees get none.
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

## 11. Product Forge
`/forge <idea>` (or `npm run forge -- new "<outline>" --mode interview --stop-after spec,naming`) turns a few lines into a planned product, one stage per executor pass. `Forge/<slug>.md` holds its state and log, and each stage writes into the `Forge/<slug>/` folder:

1. **Spec** (`spec.md`): problem, users, user stories with acceptance criteria, non-goals, data model and open questions.
   - In **interview** mode it first writes up to 5 questions to `questions.md` and waits for your answers.
   - In **autonomous** mode it lists its assumptions instead.
2. **Stack** (`decisions/0001-stack.md`): an ADR that keeps Astro + Cloudflare + Supabase unless the spec clearly needs something else.
3. **Naming** (`naming.md`): 10–20 ranked candidates, plus an **Availability** table filled in by code, not the model. It checks `.com`/`.dev` (RDAP), npm and GitHub, and links trademark searches. "?" means a lookup failed. The top candidate becomes `name:` in `Forge/<slug>.md`; change it there if you prefer another, and a later rerun won't overwrite your choice.
4. **Plan** (`plan.md`): milestones and tickets in Foundry's format, with dependencies.

**Stop-points:** after each stage in `stop_after`, a card waits for you.
- **Do it** continues.
- **No**, with a reason, reruns the stage with your reason as feedback.
- `status: stopped` in `Forge/<slug>.md` halts the forge, even mid-stage.

**Each stage's output is checked** for its required sections. A bad output is retried once, then the forge stops as `failed`, with the reason in its Log.

**The plan always ends with a "create the repo and tickets" card.** Approving it, through `gh`:
- creates the private repo, with the spec, ADR, plan and naming in `docs/`
- adds Foundry's labels
- opens one issue per ticket in dependency order (tickets with nothing to wait for get `agent:ready`), plus an epic

**Build** (#19). Once the repo exists, the forge builds it, a step per executor pass:
- **Clone:** the repo is cloned into `projectsRoot` (from `_system/tools.json`, default `~/Projects`).
- **Workers:** each ticket whose dependencies are done gets a worker: a detached `claude -p "/feature <issue>"` in its own git worktree on `forge/T<n>`. At most `concurrency` run at once (default 2; set it in `_system/forge-builds/<slug>.json`).
- **Retries:** a worker that ends without a PR is retried once. After that, the ticket is `agent:blocked`.
- **Merging:** when a ticket's PR has every check green, a **merge card** proposes squash-merging exactly that commit. Merging stays your click until you promote it on the trust ladder (after 5 approvals, at most auto-notice). A merge closes the ticket and releases the tickets that depend on it.
- **The lead agent:** stuck tickets get one read-only look from the lead, which decides one of three things:
  - **unblock** it with guidance
  - **re-plan** it into smaller tickets
  - **ask you** on a card: write under `## Answer` and press Do it
- **Usage:** the status line from `npm run hooks` records your 5-hour and weekly usage there (a record older than 30 minutes is ignored). If `_system/usage.json` says the 5-hour or weekly window is at `usageLimit`% (default 80), no new worker starts until it resets. A worker that hits the limit pauses the build too.
- **Done:** when every ticket is closed, the forge is `built` and a card says so. Verifying (slice 3) is next.
- **Merge rules:** a PR is only proposed for merging when GitHub calls it clean (required checks reported, no conflicts) and every check is green. A red PR counts as a failed try, and the worker retries on the same branch.

**Verify** (#22). Approving the "built" card starts a verify round: three detached checks on merged `main`.
- **qa:** writes or updates a Playwright E2E test for every user story (shipped as a PR, which goes through a merge card). It runs them along with axe, Lighthouse, `npm audit` and a license check.
- **architecture and spec:** two reviewers, read-only, comparing the code with the ADRs and with `docs/spec.md`.
- **Reports:** each check ends with a JSON report, but code decides what counts. Each of these is a finding:
  - a story without both a qa check and a test in the repo tagged `story <n>`
  - any failing check, whatever severity qa gave it
  - a spec whose stories can't be read
  - a check without a usable report
- **Your E2E tests land on main:** qa's test PR joins the build for a merge card.
- **Usage limit:** a check stopped by the usage limit is retried after an hour, not filed as a bug.
- **Reviewer text:** it reaches workers only quoted and marked as untrusted.
- **Findings:** medium and high findings become `verify` tickets, the build fixes them, and the next round runs on its own. Low findings are listed in the forge's log.
- **Stopping:** after 3 rounds, or a round no better than the last, a card asks you. **Do it** fixes what's open and allows exactly one more round; **No** accepts the product as it is.
- **Done:** a clean round marks the forge `verified` and offers the demo. Accepting on the stop card offers it too.

**Demo** (#27). The "verified" card asks before anything goes to Cloudflare. Approving it:
- **Preview:** the forge itself, not a model, builds a fresh checkout of `main` in a detached run and has the repo's own wrangler run `wrangler preview --name demo` with your wrangler login. That gives an isolated Cloudflare preview; the forge never runs `wrangler deploy`. It needs a wrangler config in the product repo and wrangler 4.135 or later. Without them, or if the upload fails, the tour runs against a local server and the summary says why.
- **Tour:** an agent walks every user story in a browser and takes one screenshot per story. It has Playwright and `npm run preview`, and may write only `forge-demo/`. It runs without your Cloudflare and GitHub credentials: their tokens are removed from its environment, the stored wrangler and gh logins are hidden behind empty config folders, and git has no credential helper. Playwright scripts can still run code, so treat this as a strong barrier, not a proof. The forge copies only real PNG files inside the tour's checkout, never through a symlink.
- **Summary:** `Forge/<slug>/demo.md`, with what was built, a screenshot per story, known gaps (stories without a screenshot, open findings you accepted, verify's low findings, no preview and why) and the cost.
- **Cost:** every agent run of the forge (workers, lead, verify checks, tour) adds what it spent: the API-equivalent dollars from `claude -p` (on a subscription nothing is billed), tokens (prompt-cache re-reads shown separately) and minutes. With fresh usage records it also shows how many points of your weekly usage the run took.
- **Usage limit:** a tour stopped by it is retried after an hour.
- **Done:** the forge is `demoed`, and a card has the preview link. Delete the preview in the Cloudflare dashboard when you're done with it. Selling or handing over (slice 5) is next.

**Guardrails:**
- Workers get `gh` only for their ticket and PR: view, comment, label, PR create and checks. That means no merge, `api` or `repo` commands.
- Comments from anyone but you are treated as untrusted data.
- The product repo's `main` is protected (changes through PRs only) where your GitHub plan allows it.
- A GitHub hiccup skips one pass; it never fails the build.

Build state, workers and their logs live in `_system/forge-builds/`. The dashboard shows ticket progress.

**Safety:**
- Claude works inside `Forge/<slug>/` only, so it can't change the forge's state or skip your stop-points.
- The spec and plan stages have no web access; only stack and naming may search.
- Creating the repo is resumable: retrying after a failure reuses what was already made.

**Privacy:** outlines, specs and plans stay on the PC until you approve the repo card; the dashboard only shows each forge's name or slug, stage and status.

## 12. Sync to other PCs and Android
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
