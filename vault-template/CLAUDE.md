# Vault contract

This is the user's personal productivity vault (Obsidian). These are your standing rules for working in it.

## Layout
| Folder | Purpose | Your access |
|---|---|---|
| `Inbox/` | Unsorted captures | create; move out when triaging |
| `Daily/` | One note per day, `YYYY-MM-DD.md` | create/update today's and tomorrow's note |
| `Projects/` | One note per project (`<name>.md`) | update the `## Log`, `## Tasks` and `next` sections; create from template |
| `Writing/` | Post ideas and drafts | create ideas; edit drafts **only when asked** |
| `Specs/` | Product/feature specs | create/update when asked |
| `Sessions/` | One note per Claude Code session, written by the session hook (`tools/hooks/` in productivity-os) | read; you may set `status: ended` on stale ones |
| `Raw/` | Imported sources (PDFs, old md) | **read-only, never edit or delete** |
| `Archive/` | Finished or dead material | move in **only via an approved action card** |
| `Templates/`, `Bases/` | Note templates and dashboard views | change only when asked |
| `_system/` | Your memory, policy, changelog, action cards | yours to maintain |

## Frontmatter schema (keep it exact; Bases views depend on it)
- **project:** `type: project`, `status: idea|active|paused|done|archived`, `area`, `repo: owner/name`, `path` (local folder), `priority: 1|2|3`, `next` (one line), `updated: YYYY-MM-DD`
  - **Written by the GitHub sync (don't edit by hand):** `ci: passing|failing|pending|none`, `open_prs`, `failing_prs`, `agent_blocked`, `github_synced`.
  - The `## GitHub` and `## Docs` sections between `<!-- ...:start -->`/`<!-- ...:end -->` markers are generated. Leave them alone.
- **post:** `type: post`, `status: idea|draft|edit|scheduled|published`, `platforms: [blog, devto, linkedin]`, `publish_date`, `slug`
- **spec:** `type: spec`, `status: outline|drafting|ready|building|done`, `project`, `mode: interview|autonomous`
- **action** (cards in `_system/actions/`, created by `tools/actions/cards.mjs`, never by hand): `type: action`, `action`, `key`, `params` (JSON), `reason`, `risk: low|medium|high`, `status: pending|approved|rejected|snoozed|running|done|failed|undone|expired`, `level`, `decided_by: you|policy`, `context`, `expires`
- **daily:** `type: daily`, `date: YYYY-MM-DD`
- **session** (written by the hook, don't hand-edit): `type: session`, `status: idle|running|waiting|ended`, `project`, `cwd`, `session_id`, `started`, `updated`, `prompts`, `last_prompt`, `waiting_for`
- **source:** `type: source`, `origin` (original path or URL), `imported: YYYY-MM-DD`

Tasks are checklist items written in Tasks-plugin format: `- [ ] text 📅 YYYY-MM-DD ⏫`. They live in project notes under `## Tasks` and in daily notes.

## Autonomy (see `_system/policy.md` for current levels)
- **You may do without asking (low-risk):**
  - Create or update daily notes.
  - Triage `Inbox/` items into the right place.
  - Append to a project's `## Log` and `## Tasks`.
  - Fix frontmatter so it matches the schema.
  - Add links between notes.
- **Ask first (write an action card in `_system/actions/` or ask in chat):**
  - Moving or renaming notes outside `Inbox/`.
  - Editing the body of a note the user wrote.
  - Anything in `Writing/` drafts.
  - Archiving.
- **Never:**
  - Delete files. Propose archiving instead.
  - Edit `Raw/`.
  - Send, post or publish anything.
  - Touch folders outside the vault, except to read project repos.

## Tools
`_system/tools.json` says where the productivity-os repo lives (`productivityOs`). Run its scripts from there:
- **GitHub sync** (read-only on GitHub): `node <productivityOs>/tools/github/sync.mjs`. Refreshes the `## GitHub` section and frontmatter of every project note that has a `repo`. Needs `gh` logged in. If it fails, say so and carry on without the GitHub data.

## Action cards
- **Proposing.** To propose something that needs the user's OK, create a card. Don't just do it, and don't write card files by hand:
  ```
  node <productivityOs>/tools/actions/cards.mjs create '{"action":"claude_task","key":"<stable-unique-key>","title":"…","reason":"…","explain":"what happens if approved","undo":"how to reverse it","risk":"low|medium|high","context":"[[Projects/x]]","params":{"cwd":"<repo path>","prompt":"<full instructions for an unattended Claude Code session>"}}'
  ```
  - `claude_task` cards always need a click. Their prompt must be self-contained, and must say: work on a branch, never push to main, never merge, never delete.
- **Who runs them.** The executor (`tools/actions/executor.mjs`) on the main PC carries out approved cards and records every decision in `_system/policy.md`. That's the trust ladder: approvals earn autonomy, rejects and undos take it away. Don't edit card `status` yourself; that's the user's button.
- **Before proposing.** Read `_system/memory/preferences.md` and the **Never suggest** list in `_system/policy.md` first. When a user rejects a card with a `decline_reason`, add the lesson to `preferences.md`.

## Every change gets logged
Append one line per change to `_system/changelog.md`: `- YYYY-MM-DD HH:MM <skill/agent> <what> [[note]]`.
If the vault is a git repo, commit at the end of each run: `git add -A && git commit -m "<skill>: <summary>"`. A single revert then undoes the run.

## Memory
Before you suggest anything, read `_system/memory/preferences.md`. When the user rejects a suggestion and says why, add the reason there so the same suggestion isn't made again.

## Writing style for notes
Keep notes short and scannable. Prefer wikilinks (`[[Projects/foo]]`). Don't write summaries nobody asked for.
