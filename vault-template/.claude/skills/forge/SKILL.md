---
name: forge
description: Start a Product Forge run - turn a product or big-feature idea into a spec, stack decision, name and ticket plan in a new repo. Use for "/forge <idea>", "forge this", "spec and plan a product for...".
---

# /forge <idea>

The Product Forge takes an outline through four stages, one per executor pass: **spec → stack → naming → plan**. The forge's state and log live in `Forge/<slug>.md`; every stage writes its file in the `Forge/<slug>/` folder. It stops where you say, and it creates nothing outside the vault until you approve the final "create the repo and tickets" card.

1. **Get the outline.** Ask for a few lines if the user hasn't given them: what it is, who it's for, and the one thing it must do well. Don't spec it yourself; the forge does that.
2. **Pick the mode** (ask if unclear):
   - `interview` (default): the forge first writes up to 5 questions to `questions.md` and waits for the answers.
   - `autonomous`: it decides for itself and lists every assumption in `spec.md` under "Assumptions".
3. **Pick the stop-points:** after which stages to wait for review. The default is `spec,naming`. The plan always stops at the repo card.
4. **Start it:**
   ```
   node <productivityOs>/tools/forge/forge.mjs new "<outline>" --mode interview --stop-after spec,naming
   ```
5. **Tell the user what happens next:**
   - Progress shows in `Forge/<slug>.md` (its Log) and on the dashboard.
   - At each stop a card appears. **Do it** continues. **No**, with a reason, reruns that stage with the reason as feedback.
   - The user can rename the product at the naming stop by editing `name:` in `Forge/<slug>.md`.
   - Setting `status: stopped` there halts the forge.
   - After the repo card, the forge builds: agents work the tickets, merge cards ask before each merge, and a lead agent asks the user on a card when a ticket is truly stuck. Then verify rounds check every user story end-to-end and send findings back into the build, asking the user if they stop converging.
