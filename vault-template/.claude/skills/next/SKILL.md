---
name: next
description: Recommends what to work on right now across all projects, given time, energy and what's urgent or blocked. Use for "/next", "what should I work on", "I have an hour, what now".
---

# /next [time] [energy]

Follow `CLAUDE.md`, and read `_system/memory/preferences.md` first. This skill only reads; it changes nothing without a yes.

1. **Context:** if the user didn't give it, ask in one line how much time they have and their energy (low, normal or high). Accept "skip".
2. **Candidates** (refresh the GitHub sync first if `github_synced` is older than today):
   - **Unblock others / broken things:**
     - Projects with `ci: failing` or `failing_prs > 0`.
     - `agent_blocked > 0`: an agent is stuck waiting on me.
     - Claude sessions with `status: waiting`.
     - PRs requesting my review.
   - **Commitments:** tasks due today or overdue, and today's `## Top 3`.
   - **Momentum:** active projects touched in the last 3 days with a clear `next`.
   - **Neglect:** active priority-1 projects not touched in 14+ days.
3. **Rank:** unblock first, then due items, then momentum, then neglect.
   - Fit the time: under 30 minutes → a quick unblock or review; over 2 hours → deep work on a momentum project.
   - Fit the energy: low → reviews, triage, small fixes; high → the hardest open problem.
   - Skip anything matching a rejected pattern in preferences.
4. **Reply with 3 options** (one line each: what, why now, rough size), then a recommendation. For a coding task, add the command to start: `cd "<path>"; claude`.
5. **Learn:** if the user rejects an option with a reason ("never on weekends", "hate frontend work at night"), add it to `_system/memory/preferences.md`.
