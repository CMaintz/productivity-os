---
name: suggest
description: The orchestrator's suggestion pass - runs the rule-based card generator, then looks across the vault, projects, sessions and activity for up to 3 high-value things worth proposing as action cards (new widgets, connectors, skills, workflow fixes, agent tasks). Use for "/suggest", "any suggestions?", "what could be improved".
---

# /suggest

Follow `CLAUDE.md`, especially "Action cards". Read `_system/memory/preferences.md` and the **Never suggest** list in `_system/policy.md` first.

1. **Rule-based cards:** run `node <productivityOs>/tools/actions/suggest.mjs` and note what it created.
2. **Look for patterns** the rules can't see. Use at most the last 14 days:
   - **Repeated prompts:** in `_system/activity.jsonl`, the same kind of request 3+ times → propose a skill or slash command.
   - **Repeated permission prompts:** in `Sessions/` `waiting_for`, the same tool or command asked about repeatedly → propose an allowlist entry (a `claude_task` in the right repo, editing `.claude/settings.json`).
   - **Projects drifting:** a `next` that hasn't changed in weeks, or tasks carried over 3+ times.
   - **Missing data:** the user keeps looking things up by hand → propose a widget or connector.
3. **Propose at most 3 cards** via `cards.mjs create`, each with:
   - a stable `key` (so it isn't proposed twice),
   - a one-sentence `reason` citing the evidence (counts, dates),
   - an honest `explain` and `undo`.

   Prefer small, reversible actions. Skip anything already covered by an open card.
4. **Reply** with what was created, in one line each, plus anything you noticed but didn't propose, and why.
