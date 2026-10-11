---
name: shutdown
description: End-of-day shutdown. Logs what got done today (from checked tasks and git commits across project repos), carries over unfinished tasks, drafts tomorrow's top 3. Use for "/shutdown", "end of day", "wrap up".
---

# /shutdown

Follow `CLAUDE.md`.

1. **What got done:**
   - Tasks checked today, in today's daily note and in project notes.
   - Git commits made today by me in every project that has a `path`: `git -C <path> log --since=midnight --author="$(git config user.email)" --oneline`.
   - Claude sessions in `Sessions/` that changed today.
2. **Write `## Log` in today's daily note** as short bullets grouped by project. Append one line to each touched project's `## Log` and update its `updated` date.
3. **Carry over:** collect unchecked items from today's `## Top 3` and `## Tasks`. Create tomorrow's daily note from the template if it doesn't exist, and put those items under `## Carry over`.
   - Track postponements: if an item has been carried over 3 or more times (count the `↻` marks you add each time), don't carry it silently. Ask whether to do it, split it, delegate it or drop it.
4. **Draft tomorrow's `## Top 3`** with one-line reasons, so the user can change it in the morning.
5. **Ask one question at most:** "Anything else to log or drop?" Then log to `_system/changelog.md` and commit if git.
