# productivity-os

A personal productivity OS: an Obsidian vault, Claude Code and a dashboard at `dash.maintz.dev`.

Layout:
- `tools/` holds the PC-side scripts: inventory, reorganise, vault, hooks, GitHub sync, action cards and the executor, and the dashboard sync.
- `vault-template/` is the vault.
- `dashboard/` is the web dashboard (an Astro static app).
- `supabase/` holds the dashboard schema. The full design is in [docs/BRAINSTORM.md](docs/BRAINSTORM.md).

**Everything you need to do yourself is listed in [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md).** Run `claude` in this repo and type `/pos-setup`, and a local Claude works through it with you.

## Getting started (Windows, main PC)

You need [Node 22+](https://nodejs.org) and [Git for Windows](https://git-scm.com). The `gh` CLI is optional; it's used for the GitHub cross-check.

```powershell
cd C:\Users\akash\Projects
git clone https://github.com/CMaintz/productivity-os
cd productivity-os        # run every command below from here
```

The scripts always scan `C:\Users\akash\Projects` and its sibling folders, wherever the repo itself lives. Their output goes to `productivity-os\out\`, which git ignores.

## Phase 0: projects inventory (read-only)

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

## MCP server (Claude Desktop)

`npm run mcp` starts a local stdio MCP server over the vault (`--vault <dir>`, else `$PRODUCTIVITY_VAULT`, else `~/Vault`). It lets Claude Desktop answer "what's on my plate?" and propose action cards:
- `today`, `list_projects`, `list_cards`, `get_card` and `recent_sessions` return the same headlines, statuses and counts the dashboard publishes. There is no tool that reads a note, and a finished card shows only its status, never its result.
- `propose_card` adds a `pending` card (`reminder` or `claude_task`) through `tools/actions/cards.mjs`. It refuses anything on the policy's Never suggest list. You approve the card in Obsidian, on the phone or on the dashboard, and the executor runs it; there are no approve, run or undo tools.

`npm run mcp:install` adds it to Claude Desktop's config (`%APPDATA%\Claude\claude_desktop_config.json`), keeping your other servers and writing a backup first. Run it from your main clone, since the entry points at this checkout. The entry looks like this:

```json
{
  "mcpServers": {
    "productivity-os": {
      "command": "<absolute path to mise's node.exe>",
      "args": ["C:/Users/akash/Projects/productivity-os/tools/mcp/server.mjs", "--vault", "C:/Users/akash/Vault"]
    }
  }
}
```

`command` is the absolute Node path because Claude Desktop starts servers without mise on its PATH. Call `node` directly rather than `npm run mcp`: npm prints a banner to stdout, which is the protocol channel. Restart Claude Desktop after a change.

Tests: `npm test`.
