---
name: capture
description: Quick capture into the vault with triage. Use for "/capture <text>", "note this", "remind me to", "idea:".
---

# /capture <text>

Follow `CLAUDE.md`.

1. **Classify the text:**
   - **task for a known project:** append `- [ ] <text>` under that project note's `## Tasks`, adding a `📅` date if one is mentioned.
   - **task, no project:** add it to today's daily note under `## Tasks`.
   - **writing idea:** create `Writing/<slug>.md` from `Templates/post.md` with `status: idea`.
   - **spec or product idea:** create `Specs/<slug>.md` from `Templates/spec.md` with `status: outline`.
   - **anything else, or unsure:** create `Inbox/YYYY-MM-DD-HHmm-<slug>.md` containing the text.

   To match projects, compare against `Projects/*.md` names and their `repo`. If no match is clear, use the Inbox. Don't guess.
2. **Log** to `_system/changelog.md`, and commit if the vault is git.
3. **Reply in one line:** where the text went, as a wikilink.
