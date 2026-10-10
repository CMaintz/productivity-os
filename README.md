# productivity-os

A personal productivity OS: an Obsidian vault, Claude Code and a dashboard at `dash.maintz.dev`. The full design is in [docs/BRAINSTORM.md](docs/BRAINSTORM.md).

## Phase 0: projects inventory (read-only)

Requirements: Node 20+ and git. The `gh` CLI is optional; it's used for the GitHub cross-check.

```powershell
npm run inventory          # scans %USERPROFILE%\Projects + *Projects siblings + source\repos
# or pick roots yourself:
node tools/inventory/inventory.mjs --root C:\Users\akash\Projects --root C:\Users\akash\IdeaProjects --out out
```

Outputs `out/inventory.md` (a report) and `out/inventory.json`. To get a proposed structure, open Claude Code in this repo and ask it to **"reorganise my projects"**. This runs the `reorganise-projects` skill, which writes `out/reorg-proposal.md`. Nothing gets moved.

Tests: `npm test`.
