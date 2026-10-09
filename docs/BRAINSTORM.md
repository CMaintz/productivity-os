# Productivity OS — Brainstorm v0

## Decisions so far
- **Hybrid design.** The Obsidian vault holds the truth as plain markdown. Obsidian is where you work day to day, and a small web dashboard covers what Obsidian can't do well: live Claude session status, charts and quick phone checks.
- **Devices:** several desktops plus a phone.
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
| Calendar/email | MCP servers (Google or Microsoft). Email triage only writes drafts and never sends. |
| Existing md/PDFs | A one-time import into `Raw/`, plus a lightweight index note per source. **No mass summarising**, because summaries bloat the vault. |
| Writing | `Writing/` pipeline: idea → draft → edit → scheduled → published, tracked per platform. |

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

## Surfaces
- **Obsidian Home** (Homepage plugin + Bases):
  - Today.
  - Active projects.
  - Session board (kanban: running / waiting on me / done).
  - Writing pipeline.
  - Suggestion inbox.
- **Web dashboard** (later, read-only):
  - Live Claude sessions, GitHub/CI status, charts (focus time, throughput, streaks).
  - Works as a PWA on the phone.
  - Writes go through Claude or Obsidian only, to avoid sync conflicts.

## Recommended Obsidian stack
- Bases, Tasks, Templater, Periodic Notes and Homepage.
- `kepano/obsidian-skills` for Claude.
- Optional: Agent Client or Claude Sidebar, for a Claude pane inside Obsidian.
- Dataview is legacy now. Datacore is only for one-off custom widgets.

## Phased roadmap
1. **MVP:** vault schema, contract `CLAUDE.md`, Home dashboard, `/today`, `/capture`, `/shutdown`.
2. **Sessions + GitHub:** hooks feed the session board, and GitHub data lands in project notes. Adds `/resume` and `/next`.
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
- Which desktop operating systems (Windows, macOS or Linux)? This affects hooks and scheduling scripts.
- Calendar and email provider: Google or Microsoft/Outlook?
- Which writing platforms (blog, LinkedIn, X, Substack…)?
- Is there an existing vault, roughly how big is it, and where do the existing markdown and PDF files live?
- Claude subscription only, or also an API key (for SDK and dashboard jobs)?
