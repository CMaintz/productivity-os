# Productivity OS — Brainstorm v0

## Decisions so far
- **Hybrid design.** The Obsidian vault holds the truth as plain markdown. Obsidian is where you work day to day, and a small web dashboard covers what Obsidian can't do well: live Claude session status, charts and quick phone checks.
- **Devices:** several Windows PCs plus a phone.
- **Web surface:** a private subdomain of maintz.dev (e.g. `dash.maintz.dev`). The site already uses Astro on Cloudflare with some Supabase, and the dashboard reuses that stack.
- **Projects root:** almost all repos live under one `Projects` folder. It needs reorganising, and a few folders still need moving into it.
- **Email/calendar:** a personal Outlook account. Gmail is unused, so it's ignored.
- **No vault yet.** We create a new one.
- **Phone: Android.** Syncthing (free) or Obsidian Sync both work, and notifications go through ntfy or web push.
- **Raw Claude Code prompts stay local.** Only aggregates go to Supabase.
- **Project structure:** decided after the inventory, which proposes 2–3 options using your actual repos.
- **Claude subscription only, no API key.** All AI work runs through Claude Code on your login (see "Execution model").
- **Paths:**
  - `C:\Users\akash\Projects`
  - Siblings to fold in: `PhpStormProjects`, `IdeaProjects`, etc.
- **Main PC:** the PC the user is on now. The executor registers machines by hostname on first run, and setup marks this one as main.
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
| Writing | `Writing/` pipeline: idea → draft → edit → scheduled → published, tracked per platform. Platforms: **your own blog** (maintz.dev), **LinkedIn**, and maybe **dev.to**. The blog is canonical: publishing means a PR to the site repo, assuming posts are markdown in Astro (verify). dev.to cross-posts through its API with `canonical_url` pointing back to the blog. LinkedIn gets a drafted post, and publishing it stays manual (copy plus a link), since sending things to people is a hard ceiling anyway. |

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

## Specs → PR module (integrates Foundry's ticket-to-PR)
1. **Write or brainstorm a spec in the dashboard.** The orchestrator helps by asking questions and pulling in project ADRs and existing docs.
2. **The spec is saved** as markdown in the vault and as a GitHub issue in the target repo.
3. **Pick the repo, then click "Build":**
   - The spec editor follows Foundry's ticket schema (`presets/tickets/ticket-schema.md`). It has four fields: **intent**, **acceptance-criteria checklist**, **scope boundaries** and **pointers**. The orchestrator helps fill them in, and "Build" stays disabled until all four are complete.
   - The spec becomes a GitHub issue on the `agent-feature` template. If the repo is missing Foundry's labels, a card offers to onboard it (`setup-labels.sh` / `foundry-init`).
   - **Build adapters** (one per trigger, chosen per project or per spec):
     - **Label:** set `agent:ready`, and a `/loop /feature` puller picks the issue up.
     - **Command:** the executor runs `/feature <issue-ref>` supervised in local Claude Code.
     - **API:** a Routine `/fire` call or the Claude GitHub Action on the issue, for when the PC is off.
   - The `/feature` driver works the issue until Foundry's gate passes, then hands it to `/ship`, which opens the PR.
   - The agent writes a decision record for any choice it makes on its own.
4. **Progress shows on the session board:** the ticket's label state (`agent:ready` → `agent:working` → `agent:blocked`), the issue thread log, PR, CI, review state and the Cloudflare preview link. When an issue goes to `agent:blocked`, an action card appears with the reason the agent posted on the thread.
5. **Finishing:** coded widgets use this same pipeline.

## Writing studio + blog editor (Writing module)
- **Editor in the dashboard.** You write and publish without touching the repo yourself.
  - The editor is markdown with a live preview using the site's own styles, plus frontmatter fields (title, tags, cover, canonical, publish date), image upload and an AI assist: outline, tighten, title ideas, SEO description.
  - **Decision: git-backed, with Keystatic.** Keystatic is chosen over Decap for these reasons:
    - It has a first-party Astro integration and typed schemas in TypeScript, matching how the site is built.
    - Its GitHub mode commits through the GitHub App/API, so you never touch git. **Draft posts live on branches**, and publishing merges them.
    - Its reader API lets the dashboard list posts and their state.
    - It is under active development. Decap needs a separate OAuth proxy, uses YAML config, and has slowed down.
  - **Setup:**
    - Keystatic is mounted in `cmaintz-site` at `/keystatic`.
    - Cloudflare Access protects that path.
    - It needs the `@astrojs/cloudflare` adapter for the admin routes (verify that combination in a spike; the fallback is serving the admin from `dash.maintz.dev`).
    - The dashboard's Writing module links straight into it.
  - **AI assist** (outline, tighten, titles, SEO description) runs from the dashboard or the orchestrator. Its suggestions are written as commits on the draft's branch, so you can review them in Keystatic.
  - Drafts live in the vault under `Writing/` and sync with the editor, so you can write in Obsidian or the dashboard.
- **Cross-posting on publish.** A post opts in through a frontmatter field you tick in Keystatic (`crosspost: [devto, linkedin]`). Ticking it counts as your approval.
  - A **GitHub Action in `cmaintz-site`** runs on each push to main. It finds new or changed posts that have `crosspost` set and syncs them.
  - Mapping each post to its remote article IDs is stored in Supabase, so re-runs are idempotent and edits get synced (dev.to `PUT`).
  - The dashboard shows each post's status per platform.

  Per platform:
  - **dev.to:** the API creates the article with `canonical_url` pointing to the maintz.dev post, so SEO credit goes to your blog.
  - **LinkedIn:** a post written for LinkedIn (hook, a short version and a link). It's published through LinkedIn's member-posting API if that works for a personal account (verify), otherwise copy plus open.
  - Optional later: Hashnode or Medium (both support canonical URLs).
  - Each platform's status (posted, URL, and reactions where an API allows) shows up on the post's page.
  - Cross-posting is "sending to people", so it only happens for platforms you ticked. Nothing is posted that you didn't tick.

## Product Forge (outline → spec → name → build → verify → sell)
A pipeline for building a new product, or a big feature for an existing project. Each stage writes its output to the vault and the repo, so you can step in at any point.

**Stages:**
1. **Outline.** A few lines from you, or a voice/text dump.
2. **Spec.** Choose a mode:
   - **Interview:** the agent asks focused questions, a few at a time.
   - **Autonomous:** the agent researches, decides for itself, and logs every assumption in `docs/decisions/` so you can review them.

   Output: PRD, user stories, acceptance criteria, non-goals, data model, and the architecture as ADRs.
2b. **Stack decision.**
   - The default is your stack: Astro + Cloudflare + Supabase + TypeScript, with Foundry's gate.
   - The agent checks the requirements against that default: realtime needs, heavy compute, mobile/native, offline, ML, compliance, scale, pricing.
   - It suggests a different stack only where the requirements clearly call for it, and writes an ADR comparing 2–3 options. The bias is toward the default, because a familiar stack is easier for you to maintain and to sell.
   - In interview mode it asks before switching. In autonomous mode it decides and flags the choice.
3. **Naming.**
   - 10–20 name candidates, each with its rationale.
   - Automatic checks for each: domain availability (RDAP), GitHub/npm/package names, social handles, and links to a trademark search (EUIPO/USPTO).
   - You pick one, or let the agent pick its top-ranked name.
4. **Plan.** The spec is split into Foundry tickets (an epic plus `agent-feature` issues) with dependencies, then ordered into milestones.
5. **Build.**
   - Foundry `/feature` loops run on the tickets, several at once in separate worktrees, each one held to the gate.
   - `/ship` opens a PR per ticket.
   - A **lead agent** watches the whole run. It re-plans when a ticket is blocked and keeps the architecture consistent with the ADRs.
6. **Verify end-to-end.** This happens in addition to the per-ticket gates:
   - **Playwright E2E:** walk every user story and click every button and link, checking for console errors and failed network calls.
   - **Backend:** API contract and integration tests against a real database (a Supabase branch or local).
   - **Quality:** accessibility (axe), Lighthouse/performance, a security review, and a dependency license audit.
   - **Fresh-context review agents:** one checks whether the build is rationally built (architecture, duplication, dead code) and one checks the result against the spec.
   - **Fix loop:** any failure becomes a ticket and goes back to step 5. The loop is bounded, and it escalates to you when it stops making progress.
7. **Demo.**
   - A deploy to a preview URL.
   - A screenshot tour and a short summary of what was built, with known gaps.
   - The run's cost in usage.
8. **Sell or hand over** (optional):
   - Landing page, one-pager, pitch deck, demo video script and screenshots/GIFs.
   - A marketplace listing draft (e.g. Acquire.com, Flippa).
   - A **handover pack** for a new owner: architecture, runbook, environment/secrets inventory, a license/IP audit, a transfer checklist (repo, domain, accounts) and a known-issues list.

**Controls:**
- **One click** runs everything. Before starting you can set **stop-points**, e.g. "stop after spec" or "stop after naming".
- At any stage you can type a few lines of feedback. The agent re-plans from that stage onward.
- **Usage-aware:** the run is paced across your subscription windows. It pauses near the 5-hour limit and resumes on its own.
- Where possible, runs go to cloud Claude Code sessions or Routines so they don't depend on the PC being on (verify which options are available on your plan).
- **Hard ceilings stay manual:**
  - Buying domains or anything else.
  - Publishing marketing.
  - Contacting buyers.
  - Production deploys with real users.
  - Transferring ownership.
- **Sandboxing:** each product gets a new repo with its own preview environments and no production secrets from your other projects.

**Defaults:** see stage 2b.

**Being realistic:** small-to-medium web apps are a good fit for full end-to-end autonomous builds. Large or unusual products will need more stop-points. The spec and the E2E suite set the quality ceiling, so the verify stage matters as much as the build stage.

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
Status (Oct 2026):
- **Done:** Phase 0 tools (inventory, mover), the vault MVP, the Phase 2 session hooks, and the per-project Repo/Local-only docs list.
- **Next:** the GitHub data in project notes, `/resume` and `/next`.

0. **Projects inventory & renovation (first real use):**
   - A script scans `C:\Users\akash\Projects` plus its siblings (`PhpStormProjects`, `IdeaProjects`, `WebstormProjects`, `source\repos`…).
   - For each folder it lists git remote, last commit, uncommitted changes and unpushed branches, size, language and docs found.
   - It also cross-checks against your GitHub repos: what's local-only and what's GitHub-only.
   - **Loose docs:** markdown and PDF files that sit outside any project, plus projects cluttered with root-level notes. The proposal gives each one a destination: a project's `docs/`, the vault (`Inbox/`, `Writing/`, `Raw/`), merge into an existing doc, or archive.
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
