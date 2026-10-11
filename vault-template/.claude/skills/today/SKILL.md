---
name: today
description: Morning brief. Builds or refreshes today's daily note with top 3 priorities, due/overdue tasks, pending action cards, project next-steps and GitHub items. Use for "/today", "morning brief", "what's on today".
---

# /today

Work in the vault root. Follow `CLAUDE.md`. Updating the daily note is low-risk, so do it without asking.

1. **Gather:**
   - Open tasks that are due today or overdue: grep `- \[ \]` lines with `📅 <date>` up to today in `Projects/` and `Daily/`.
   - Unchecked items under `## Carry over` and `## Tasks` in the most recent previous daily note.
   - Projects with `status: active`: their `next`, `priority` and `updated` (flag any not updated in 14+ days as stalled).
   - Action cards in `_system/actions/` with `status: pending`.
   - The number of notes in `Inbox/`.
   - Claude sessions in `Sessions/`:
     - Any with `status: waiting` are waiting on me. Read `waiting_for`.
     - Any that aren't `ended` but haven't been updated in 12+ hours are stale. Set them to `status: ended` (low-risk).
   - If the `gh` CLI works: PRs that request my review, my open PRs with failing checks, and issues labelled `agent:blocked` (`gh search prs --review-requested=@me --state=open`, `gh search issues --label agent:blocked --owner @me --state=open`).
   - Calendar: skip until a calendar connector exists, and leave `## Schedule` with a note saying so.
2. **Choose the top 3.** Weigh due dates, priority, momentum (recent activity), and anything blocking other work. Read `_system/memory/preferences.md` first. Give one short reason per item.
3. **Write `Daily/YYYY-MM-DD.md`.** If it doesn't exist, create it from `Templates/daily.md`. If it exists, only fill sections that are empty, plus `## Tasks` (merge, never duplicate). Never overwrite what the user wrote.
4. **Log** to `_system/changelog.md`, and commit if the vault is a git repo.
5. **Reply** with the brief in 10 lines or fewer: top 3, what's overdue, what's waiting on me (action cards and Claude sessions), and stalled projects.
