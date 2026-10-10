# Productivity OS — Brainstorm v0

## Decisions so far
- **Hybrid design.** The Obsidian vault holds the truth as plain markdown. Obsidian is where you work day to day, and a small web dashboard covers what Obsidian can't do well: live Claude session status, charts and quick phone checks.
- **Devices:** several Windows PCs plus a phone.
- **Web surface:** a private subdomain of maintz.dev (e.g. `dash.maintz.dev`). The site already uses Astro on Cloudflare with some Supabase, and the dashboard reuses that stack.
- **Projects root:** almost all repos live under one `Projects` folder. It needs reorganising, and a few folders still need moving into it.
- **Email/calendar:** a personal Outlook account. Gmail is unused, so it's ignored.
- **No vault yet.** We create a new one.
- **Claude subscription only, no API key.** All AI work runs through Claude Code on your login (see "Execution model").
- **Paths:**
  - `C:\Users\akash\Projects`
  - Siblings to fold in: `PhpStormProjects`, `IdeaProjects`, etc.
- **Later idea:** an always-on server running Claude Code plus the collector and executor.
- **Autonomy:** the agent does low-risk work on its own, asks before anything destructive, and logs every edit.
- **Sources:** GitHub, Claude Code sessions, calendar and email, writing and publishing, and existing markdown and PDFs.

## Architecture (4 layers)

```
 Sources ──► Ingest ──► VAULT (md + frontmatter, git) ──► Surfaces
 GitHub      hooks         Projects/ Tasks/ Writing/      Obsidian Home (Bases)
 Claude      MCP           Sessions/ Daily/ Raw/          Web dashboard (read-only)
 Calendar    scripts       _system/ (agent memory, log)   Phone (Obsidian mobile)
 Email/PDFs                         ▲
                                    │
                    Agent layer: Claude Code skills + Overseer
```

### 1. Vault (source of truth)
- **Strict frontmatter schema.** Every note has a `type` (project | task | session | post | source | daily) and may also have `status`, `project`, `area`, `due`, `priority` and `energy`. Bases, Claude and the web dashboard all read the same fields.
- **Folder layout:**
  - `Raw/` holds imported markdown and PDFs. These files are never edited.
  - `Projects/`, `Writing/`, `Daily/` and `Sessions/` hold your working notes.
  - `_system/` belongs to the agent: memory, suggestion queue, changelog.
- **Sync:**
  - Obsidian Sync (or Syncthing) keeps the phone and desktops in step.
  - Git on the main desktop records every agent run as one commit, so undoing an agent run is just reverting its commit.

### 2. Ingest / connectors
| Source | Mechanism |
|---|---|
| Claude Code (local) | Hooks on `SessionStart`, `Stop` and `Notification` run a script. The script writes or updates `Sessions/<id>.md` with project, status, last message, and whether it is waiting on you. |
| Claude Code (cloud) | No public list API. Routines report their own runs; other sessions are added by hand or via an end-of-session hook. |
| GitHub | GitHub MCP, or a script running `gh` on a schedule. It writes open PRs, CI state and review requests into each project note. |
| Calendar/email | **Personal** Outlook through Microsoft Graph. Graph accepts personal Microsoft accounts. Plan: a free Entra/Azure app registration (device-code login) plus a Graph-based Outlook MCP server, or our own small fetcher. Claude's Microsoft 365 connector is probably limited to work/school accounts (verify). Email triage only writes drafts and never sends. |
| Existing md/PDFs | A one-time import into `Raw/`, plus a lightweight index note per source. **No mass summarising**, because summaries bloat the vault. |
| Writing | `Writing/` pipeline: idea → draft → edit → scheduled → published, tracked per platform. |

### 2b. Project docs (ADRs, audits, decisions)
- **Repo indexer** (a script run on a schedule and after git pulls):
  - Scans the `Projects` folder recursively and finds projects by their `.git` folders, so reorganising subfolders doesn't break anything.
  - A non-git folder can be marked as a project with a `.project.yaml` file.
  - Extra folders outside `Projects` can be listed in `_system/sources.yaml`.
  - Which files count as docs is decided by glob rules in `_system/sources.yaml`.
  - Default rules: `docs/adr/**`, `docs/decisions/**`, `**/AUDIT*.md`, `**/*audit*.md`, `CLAUDE.md`, `README.md`, `CHANGELOG.md`, `docs/**/*.md`.
  - Each repo gets its own overrides.
- **Index, don't copy.** Each repo gets a `Projects/<repo>/docs.md` note listing every doc with:
  - type (adr | audit | decision | readme | changelog)
  - status
  - date
  - a one-line gist
  - a local path link and a GitHub link (the GitHub link works on the phone)

  Copying would mean two copies that drift apart and a bloated vault.
- **New or changed docs become action cards.** Examples: "ADR-012 added by agent session X → review", "Audit found 3 high-severity issues → create tasks?".
- **Autonomous-decision convention.** Every repo's `CLAUDE.md` tells agents to record any non-trivial decision they make on their own in `docs/decisions/YYYY-MM-DD-<slug>.md`. The record follows a short template: context, options, choice, confidence, and how to revert. The indexer gathers these into one "Decisions to review" view.
**File panel per project.** Each project note has a panel with two tabs:
- **Repo:** markdown files tracked in git, the same set as on GitHub.
- **Local:** markdown files that exist only on your PC: untracked or gitignored files in the clone (scratch notes, agent output, local audits) plus vault notes linked to the project.

Each row shows:
- the filename and folder
- a type badge (ADR, audit, decision, readme, changelog, note)
- the date it was last changed
- its git state (clean, modified or untracked)
- a one-line summary
- an "open" link: `vscode://` or `obsidian://` on desktop, GitHub on the phone

Extras:
- search
- group by folder
- pinned docs
- a "new since last look" dot

How it works:
- The indexer writes the file list once per project, to `Projects/<repo>/files.json`.
- In Obsidian, a Datacore widget shows that file as the tabbed panel. The web dashboard uses the same JSON with the same component.
- There is no note per file, so the vault stays clean.
- On the phone, the Local tab shows file names and summaries only, because the files themselves stay on the PC.
- **`/resume <project>` and `/next`** read the project's ADRs and recent decisions, so their suggestions follow the architecture choices you've already made.

### Windows specifics
- **Scripts** are written in Node/TypeScript, so the hooks, indexer, executor and web dashboard all share one language and data types. No bash dependency.
- **Claude Code hooks** call `node` scripts, so there are no PowerShell quoting issues.
- **Scheduling** uses Windows Task Scheduler or Claude Desktop scheduled tasks instead of cron.
- **The executor** runs as a small background service (e.g. a Node process started at login), and only on the "main" PC to avoid running the same job twice. A lock file in `_system/` ensures only one executor runs.
- **Git** uses `core.autocrlf=false` and `.gitattributes` with `* text=auto eol=lf`, so the vault doesn't flip line endings between machines.

### 3. Agent layer (Claude Code)
- **Contract** (`CLAUDE.md` in the vault):
  - Which folders the agent owns.
  - Which folders it must never touch.
  - What counts as low-risk.
  - That every action is logged to `_system/changelog.md`.
- **Skills / slash commands:**
  - `/today`: the morning brief, covering calendar, top 3 priorities, overdue items, sessions waiting on you, and PRs needing review.
  - `/capture`: quick inbox entry. Triage files it into the right place (a low-risk auto action).
  - `/shutdown`: logs what got done, carries the rest over, and drafts tomorrow.
  - `/weekly`: planned vs actual, stalled projects, and tasks postponed 3 or more times (do / split / drop?).
  - `/next`: "what should I work on now?", based on energy, time available, deadlines and momentum.
  - `/lint`: vault health check for orphans, stale projects, broken links and schema violations.
  - `/resume <project>`: a context card with the last session summary, the open threads and the next step.
- **Scheduling:**
  - Desktop scheduled tasks or cron run `claude -p` for the brief and the nightly lint.
  - Routines (cloud) only handle jobs that don't need the local vault.

### 4. Overseer (meta layer)
- **Activity log:** hooks append to `_system/activity.jsonl` (sessions, tools, projects, times).
- **Weekly retro agent:** reads the activity log, git history and the calendar, then produces at most 3 suggestions in `_system/suggestions.md`.
- **Accept/reject memory:** each suggestion is accepted or rejected, and rejections are remembered so the same idea doesn't come back.
- **Suggestion types:**
  - New widgets ("you check PR status 10×/day → add a PR widget").
  - New connectors ("you paste Linear links often → add Linear MCP").
  - New skills ("you typed this same prompt 5 times → make it a command").
  - Workflow changes ("you focus best 9–12; blocks after 3pm get postponed").
- **Memory:** `memory: user` subagent plus markdown files in `_system/memory/`. RAG or embeddings are added only if grep stops being enough.

### 4b. Action cards and earned autonomy
The overseer's suggestions become **action cards with buttons** instead of plain text.

**Card = one note in `_system/actions/`:**
```yaml
type: action
action: continue_agent        # create_widget | book_event | continue_agent | add_connector | new_skill | file_note ...
params: { project: blog-engine, session: abc123, goal: "finish RSS feed" }
reason: "Session stopped 2 days ago at 80%; you have a free 2h block tomorrow"
risk: medium                  # low | medium | high
status: pending               # pending → approved/rejected/snoozed → running → done/failed
context: [[Projects/blog-engine]]
expires: 2026-10-12
```

**Buttons:**
- **Do it**
- **Not now** (snooze)
- **No** (with an optional one-word reason)
- **Always do this**
- **Never suggest this**

Meta Bind buttons set the card's `status`. Clicking a button only changes a file, so it works the same in Obsidian, on the phone (synced) and in the web dashboard.

**Executor (desktop):**
- A file watcher (or a cron job every couple of minutes) picks up approved cards.
- It runs each one through `claude -p` with a per-action tool allowlist. For example, `continue_agent` resumes a session or starts a new one with the goal; `create_widget` writes a Bases view or Datacore widget; `book_event` uses the calendar MCP.
- It writes the result and an undo hint back onto the card and into the changelog.
- High-risk cards show a dry-run preview before running.

**Contextual placement:**
- Cards show up where they're relevant: a project's cards on that project's note, today's cards on Home, session cards on the session board.
- Events create them, for example:
  - CI failed → "Fix CI on PR #12".
  - A session is waiting on you → "Answer / let it continue".
  - A stalled project plus a free calendar slot → "Book a focus block".

**Earned autonomy (trust ladder per action type):**
1. **Suggest:** every card needs a click.
2. **Auto with notice:** the card runs on its own and shows up as done, with an Undo button.
3. **Silent:** the action runs and is only logged.

**How autonomy changes:**
- An action type moves up after N approvals in a row with no rejects or undos (e.g. 5 for low risk, 10 for medium). **The promotion is itself a card.** It never self-promotes silently.
- Any undo or reject moves it back down a step.
- "Always do this" is a manual shortcut straight to level 2.
- Rejection reasons and "never" choices are kept in `_system/memory/preferences.md`. The overseer reads them before it suggests anything.
- The current level of each action type is kept in `_system/policy.md`, which you can read and edit by hand.

**Hard ceilings** (stay on Suggest forever unless you change them):
- Sending anything to other people (email, posts, invites).
- Spending money.
- Deleting.
- Touching folders outside its own.
- Pushing to main.

### 4c. Universal widgets (buildable by the orchestrator)
Everything on a dashboard is a widget. That includes the core pieces (session board, file panel, action cards, today), so the system is built from the same parts it can create.

**Two kinds of widget:**
1. **Declarative.** This is the default and covers about 80% of cases.
   - A `widget.yaml` combines a **data source** with a **built-in view primitive**.
   - Data sources: vault query, Supabase view, GitHub, Graph/Outlook, Claude sessions, any MCP/HTTP endpoint.
   - Built-in views: stat, list, table, chart, kanban, timeline, calendar, file panel, card list, feed.
   - No code is involved, so the orchestrator can generate these safely.
2. **Code.** Only for when the built-in views can't do the job.
   - `widgets/<id>/` holds:
     - `widget.yaml`: the manifest, including permissions and data schema.
     - `fetch.ts`: the backend that produces the widget's JSON.
     - `view.tsx`: a React view, compatible with Preact so the same component runs in Obsidian (Datacore) and the web dashboard (Astro island).

**Example manifest:**
```yaml
id: pr-review-queue
title: PRs waiting on me
source: { kind: github, query: "is:open review-requested:@me" }
view: { kind: list, fields: [repo, title, age, ci] , actions: [open, "continue_agent"] }
refresh: 10m
surfaces: [home, project]
permissions: [github:read]
```

**Where things run:**
- **Fetchers** run either on the PC collector (for anything that needs local access) or in a Cloudflare Worker (for cloud APIs).
- **Secrets** stay server-side, and each fetcher only gets the permissions its manifest declares.
- **Custom views** render in a sandboxed iframe on the web.
- **Layouts** (`layouts/home.yaml`, `layouts/project.yaml`) say which widgets go where. The orchestrator can suggest changing them.

**Usage-driven evolution:**
- **What gets logged:**
  - The dashboard logs widget views, clicks, expands and dismissals to Supabase `usage_events`.
  - Claude Code hooks log what you ask Claude for.
- **What the orchestrator looks for:**
  - Repeated manual lookups, for example asking Claude "what's CI on X?" 6 times this week. → Card: "Create a CI status widget".
  - Widgets you never look at. → Card: "Remove or shrink the widget".
  - Widgets you always open together. → Card: "Merge them, or put them next to each other".
  - Missing data. → Card: "Add a connector".
- **Widget lifecycle:** suggested → preview → active → retired when unused.

**Build flow:**
- **Declarative widgets:** the agent writes the YAML and a preview shows up on the dashboard with Keep and Discard buttons.
- **Code widgets** go through the specs → PR pipeline:
  1. The agent works on a branch with tests: a fixture-data unit test, a schema check, and a Playwright render/screenshot test.
  2. CI runs, and Cloudflare builds a preview.
  3. If everything is green and the widget asks for no new permissions or connectors, it **auto-merges and deploys**, and you get a notice card with Undo.
  4. If it asks for new permissions, it needs your approval first.
- **Runtime guardrails:**
  - Every widget runs behind an error boundary or sandbox.
  - Repeated runtime errors switch the widget off automatically and open a "fix it" card.
  - Rolling back is one click.

**Widget gallery page:** lists installed widgets, suggested ones (with the reason for each), and retired ones (with one-click restore).

## Platform architecture: modules + widgets (unified)
Complex core features are **not** widgets. They are **first-party modules**. Modules and widgets are built on the same platform and follow the same contracts.

**Shared platform contracts:**
- **Data:** typed entities (project, file, session, card, spec, event) live in Supabase and are mirrored to the vault as markdown.
- **Actions:** every button anywhere is an action card going through the same executor and trust ladder.
- **Events:** one event log for all interactions (`usage_events`).
- **Layout:** pages are made of slots, and slots hold widgets.
- **Auth/permissions:** the same model for everything.

**Module** = a full feature with its own pages, backend and code. Modules ship with the core repo. Examples:
- Sessions
- Projects & file panel
- Specs / ticket-to-PR
- Orchestrator chat
- Action inbox
- Widget gallery

**Widget** = a tile placed in a layout slot. Widgets are declarative or code, as in 4c.

**A module also exposes widgets.** The Sessions module, for example, offers a "waiting on me" tile. Modules and widgets share the same data, actions and logging.

## Execution model (subscription only, no API key)
- **Every AI job runs as Claude Code on your login:**
  - `claude -p` started by the executor on the main PC.
  - Claude Desktop scheduled tasks.
  - Routines (cloud, for jobs that don't need local files).
  - The Claude GitHub Action with a subscription OAuth token (`claude setup-token`) for repo work.
- **The browser never calls the Anthropic API.** Orchestrator chat in the dashboard works like this:
  - The message is written to Supabase.
  - The executor runs `claude -p --resume <orchestrator-session>`.
  - The reply streams back through Realtime.
  - This only works while the PC is on; the "always-on server" idea would fix that later.
- **Usage budget:**
  - The status line reports your 5-hour and weekly usage %. A widget shows it.
  - The orchestrator pauses background jobs once usage passes a threshold you choose, so you aren't locked out of interactive work.

## Interaction logging (workflow insight)
- **Logged events:**
  - Dashboard: views, clicks, dismissals, card decisions.
  - Orchestrator chat: messages, which suggestions you accepted or rejected, and the reasons.
  - Claude Code hooks: `UserPromptSubmit`, `PostToolUse`, `Stop`, `Notification`, permission prompts, interrupts and session length.
- **Patterns the orchestrator looks for:**
  - The same permission prompt approved repeatedly → suggest an allowlist rule.
  - The same prompt typed repeatedly → suggest a skill or slash command.
  - Frequent interrupts or corrections in a repo → suggest a `CLAUDE.md` fix.
  - Sessions sitting "waiting on you" for a long time → suggest a notification or a widget.
  - A dashboard feature you never use → suggest removing it.
- **Privacy:** raw prompts stay local in `_system/activity.jsonl`. Only aggregates and metadata go to Supabase, unless you choose otherwise.

## Specs → PR module (integrates your ticket-to-PR tool)
1. **Write or brainstorm a spec in the dashboard.** The orchestrator helps by asking questions and pulling in project ADRs and existing docs.
2. **The spec is saved** as markdown in the vault and as a GitHub issue in the target repo.
3. **Pick the repo, then click "Build":**
   - The spec is handed to your ticket-to-PR pipeline. Alternatives are a local `claude -p` run or the Claude GitHub Action on the issue.
   - The agent writes a decision record for any choice it makes on its own.
4. **Progress shows on the session board:** PR, CI, review state and the Cloudflare preview link.
5. **Finishing:** coded widgets use this same pipeline.

## Surfaces
- **Obsidian Home** (Homepage plugin + Bases):
  - Today.
  - Active projects.
  - Session board (kanban: running / waiting on me / done).
  - Writing pipeline.
  - Suggestion inbox.
- **Web dashboard at `dash.maintz.dev`** (later):
  - Live Claude sessions, GitHub/CI status, charts (focus time, throughput, streaks), action-card buttons. Works as a PWA on the phone.
  - **Built as** an Astro app on Cloudflare (Pages/Workers), with Supabase as the backend.
  - **Push model:** the main PC sends a snapshot of the vault state to Supabase tables (projects, files, sessions, cards). The site never touches the vault directly.
  - **Supabase Realtime** keeps the session board and action cards live without refreshing.
  - **Button clicks** go into an `action_events` table in Supabase. The desktop executor polls the queue and applies each click as a card status change. Edits still happen only on the PC, so there are no sync conflicts.
  - **Authentication:** Cloudflare Access in front of the whole subdomain, plus Supabase row-level security on every table (single owner).
  - **Privacy:** the snapshot leaves out note bodies by default, sending only titles and metadata. Private areas can be excluded completely.

## Recommended Obsidian stack
- Bases, Tasks, Templater, Periodic Notes and Homepage.
- `kepano/obsidian-skills` for Claude.
- Optional: Agent Client or Claude Sidebar, for a Claude pane inside Obsidian.
- Dataview is legacy now. Datacore is only for one-off custom widgets.

## Phased roadmap
0. **Projects inventory & renovation (first real use):**
   - A script scans `C:\Users\akash\Projects` plus its siblings (`PhpStormProjects`, `IdeaProjects`, `WebstormProjects`, `source\repos`…).
   - For each folder it lists git remote, last commit, uncommitted changes and unpushed branches, size, language and docs found.
   - It also cross-checks against your GitHub repos: what's local-only and what's GitHub-only.
   - The agent proposes a new folder structure and each move as an action card (moves always need approval).
   - Structure is organised by kind, not status (a status change shouldn't move folders); only `_archive` is status-based.
   - **Moves are safe:**
     - Nothing with uncommitted or unpushed work moves until that work is saved.
     - Claude Code session history (`~/.claude/projects/<encoded-path>`) is renamed to the new path, so old sessions still show up.
     - Python venvs and absolute-path configs are flagged for rebuilding.
     - JetBrains recent-project lists get refreshed.
   - This also tests the card flow before anything depends on it.
1. **Widget runtime + MVP:** widget manifest format, the built-in view primitives, and the core widgets built with them.
   **MVP (rest):** vault schema, contract `CLAUDE.md`, Home dashboard, `/today`, `/capture`, `/shutdown`.
2. **Sessions + GitHub + repo docs indexer:** hooks feed the session board, GitHub data lands in project notes, and ADRs/audits/decisions are indexed per project. Adds `/resume` and `/next`.
3. **Calendar/email + writing pipeline + PDF import.**
4. **Overseer:** activity log, `/weekly`, action cards + executor, trust ladder.
5. **Web dashboard / PWA.**

## Pitfalls to avoid
- Over-automation (summary bloat).
- Auto-rescheduling without consent.
- Dashboard-tinkering as procrastination.
- Too many agents.
- Rule: automate only what you have already done by hand a few times.

## Open questions
- Which writing platforms (blog, LinkedIn, X, Substack…)?
- Which repo is the ticket-to-PR tool, and how is it triggered?
- Phone: iPhone or Android? This decides vault sync (Obsidian Sync vs Syncthing) and push notifications.
- Which PC is the main one that runs the executor?
- Where do the existing loose markdown and PDF files live?
- Project categories for the new structure?
