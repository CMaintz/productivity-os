---
name: pos-setup
description: Walks the user through docs/SETUP-GUIDE.md - does the steps marked 🤖, stops with exact instructions at steps marked 🧑, verifies each, and tracks progress. Use for "/pos-setup", "set up productivity-os", "continue the productivity-os setup".
---

# /pos-setup

Work through `docs/SETUP-GUIDE.md` from top to bottom. Progress is tracked in `out/pos-setup-progress.md`, one line per step, e.g. `- [x] 3.1 vault refreshed 2026-10-13`. Create the file if it's missing. If it already exists, resume at the first unticked step and say where you're picking up.

For each step:
1. **🤖 steps:** run them, show a short summary of the result, then verify. For example: a file exists, a command exits 0, `gh auth status` passes.
2. **🧑 steps:** stop. Give the exact clicks, field values or commands, then wait for "done" or a question. Verify afterwards where you can, e.g. `gh variable list`, `wrangler secret list --name cmaintz-site`, or that a new note appeared in `Sessions/`.
3. **Steps that need a yes:** merging PRs, `--apply` on folder moves, editing `Home.md`, `~/.claude/settings.json` or the Claude Desktop config, deploying. Ask before running them, even though they're tagged 🤖.
4. **Ticking off:** tick the step off in `out/pos-setup-progress.md` only after it's verified.

Hard rules:
- **Secrets:** never ask the user to paste a secret into the chat, and never print one. Secrets are typed into `wrangler secret put` or `gh secret set` prompts in the user's own terminal, or generated and piped straight in (step 6.4).
- **Moves:** never move, delete or rename project folders except through `tools/reorg/move.mjs` with an approved plan (the `reorganise-projects` skill).
- **Failures:** if a command fails, diagnose it before retrying. Don't skip a step silently; mark it `- [ ] … (skipped: reason)` if the user says to skip.
- **Phase 2:** hand over to the `reorganise-projects` skill and continue here afterwards.
