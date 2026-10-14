---
name: resume
description: Context card for picking a project back up - where it stands, what was decided, what's open, and the next concrete step. Use for "/resume <project>", "where was I with X", "pick up X again".
---

# /resume <project>

Follow `CLAUDE.md`. This skill only reads (apart from the log line in step 4).

1. **Find the project note** in `Projects/`, matching by file name, title or `repo`. If more than one matches, ask which. Optionally run the GitHub sync for just this repo first: `node <productivityOs>/tools/github/sync.mjs --only <repo>`.
2. **Gather:**
   - **Note:** `What & why`, `next`, open `## Tasks`, the last ~10 `## Log` lines, and the `## GitHub` section (failing CI, PRs, blocked agent tickets).
   - **Decisions:** from `## Docs`, open the ADRs, decision records and audits changed in the last 60 days (at most 5, newest first) and pull out what they decided.
   - **Recent work:** `git -C <path> log --oneline -15`, `git -C <path> status --short`, and unpushed branches.
   - **Claude sessions:** `Sessions/` notes for this project from the last 14 days (status, `last_prompt`). Flag any that are still `waiting`.
   - **Daily notes:** mentions of the project in the last 7 daily notes.
3. **Reply with a card** of 15 lines or fewer:
   - **Where it stands:** two sentences.
   - **Decided:** up to 3 bullets, each citing its ADR or decision file.
   - **Open:** blocked or failing items first, then tasks.
   - **Next step:** one concrete action, small enough to start now. If `next` in the note is stale, say so and propose a new one.
   - **To continue in Claude Code:** `cd "<path>"; claude --continue` (or `claude` for a fresh session).
4. **Offer** to update the note's `next` field. Only change it if the user says yes. Log `/resume <project>` to `_system/changelog.md`.
