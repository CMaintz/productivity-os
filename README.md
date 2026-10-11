# productivity-os

A personal productivity OS: an Obsidian vault, Claude Code and a dashboard at `dash.maintz.dev`. The full design is in [docs/BRAINSTORM.md](docs/BRAINSTORM.md).

## Phase 0: projects inventory (read-only)

Requirements: Node 20+ and git. The `gh` CLI is optional; it's used for the GitHub cross-check.

```powershell
npm run inventory          # scans %USERPROFILE%\Projects + *Projects siblings + source\repos
# or pick roots yourself:
node tools/inventory/inventory.mjs --root C:\Users\akash\Projects --root C:\Users\akash\IdeaProjects --out out
```

Outputs `out/inventory.md` (a report) and `out/inventory.json`.

Then open Claude Code in this repo and ask it to **"reorganise my projects"**. This runs the `reorganise-projects` skill:
1. It writes `out/reorg-proposal.md`, which you review and edit.
2. Once you approve, it writes `out/reorg-plan.json` and runs a **dry run** of the mover.
3. When you say go, it applies the moves.

```powershell
node tools/reorg/move.mjs out/reorg-plan.json            # dry run (default)
node tools/reorg/move.mjs out/reorg-plan.json --apply    # move + write out/reorg-log-*.json
node tools/reorg/move.mjs --undo out/reorg-log-<ts>.json # reverse it
```

The mover's safety rules:
- It refuses to move a repo that has uncommitted, stashed or unpushed work.
- It refuses overlapping moves, existing destinations and moves across drives.
- It moves your Claude Code session history (`~/.claude/projects/...`) along with each project.

Next: set up the vault with [docs/VAULT.md](docs/VAULT.md).

Tests: `npm test`.
