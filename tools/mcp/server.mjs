#!/usr/bin/env node
// The productivity-os MCP server, local stdio only: a remote one would put the vault on the
// network. Read tools return the dashboard snapshot's rows (see views.mjs), so nothing reaches
// the client's model that the dashboard doesn't already publish; there is deliberately no tool
// that reads a note. The one write proposes a pending card. Nothing here approves or runs one.
//
// Usage: node tools/mcp/server.mjs [--vault <dir>]   (npm run mcp)

import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { collections } from '../dashboard/snapshot.mjs';
import { vaultFromArgs } from '../lib/cli.mjs';
import { card, openCards, projects, today } from './views.mjs';
import { ACTIONS, proposeCard } from './propose.mjs';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const reply = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], ...(isError ? { isError } : {}) });

const READS = [
  ['today', "Today's Top 3 and the number of open tasks, from the daily note.", today],
  ['list_projects', 'Every non-archived project: status, priority, next step, CI and PR counts.', projects],
  ['list_cards', 'Open action cards (pending, approved, running, snoozed): title, reason, risk, status.', openCards],
  ['recent_sessions', 'Claude Code sessions from the last 7 days: project, status, what each is waiting for.', c => c.sessions],
];

function registerReads(server, vault, now) {
  for (const [name, description, view] of READS) {
    server.registerTool(name, { description, annotations: READ }, () => reply(view(collections(vault, now()))));
  }
  server.registerTool('get_card', {
    description: "One card by key. A finished card shows only its status, never what it produced.",
    inputSchema: { key: z.string().min(1) }, annotations: READ,
  }, ({ key }) => {
    const found = card(collections(vault, now()), key);
    return found ? reply(found) : reply(`No card with key ${key}.`, true);
  });
}

const PROPOSAL = {
  action: z.enum(ACTIONS).describe('reminder: nothing runs. claude_task: an unattended Claude Code session, once you approve.'),
  title: z.string().min(1).max(120).regex(/^[^\r\n]+$/, 'one line'),
  reason: z.string().min(1).max(500).describe('Why this is worth doing; shown on the card.'),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  context: z.string().max(200).optional().describe('A wikilink such as [[Projects/site]].'),
  params: z.object({ cwd: z.string(), prompt: z.string().max(8000) }).optional().describe('claude_task only: the repo folder and the full prompt.'),
};

function registerPropose(server, vault, now) {
  server.registerTool('propose_card', {
    description: 'Proposes an action card. It always lands as pending: you approve it in Obsidian, on the phone or on the dashboard, and the executor on the PC runs it. Actions on the Never suggest list are refused.',
    inputSchema: PROPOSAL, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => {
    const r = proposeCard(vault, input, now());
    if (r.error) return reply(r.error, true);
    // The policy level is what this action type would get from the suggester; this card waits regardless.
    return reply({ key: r.key, file: r.file, status: 'pending', policy_level: r.level, note: 'Waits for the user to approve it; nothing runs until then.' });
  });
}

/** The server over one vault. `now` is a clock so tests can pin "today". */
export function createServer({ vault, now = () => new Date() }) {
  const server = new McpServer({ name: 'productivity-os', version: '0.1.0' });
  registerReads(server, vault, now);
  registerPropose(server, vault, now);
  return server;
}

async function main() {
  const vault = path.resolve(vaultFromArgs());
  // stdout is the protocol channel, so diagnostics go to stderr.
  if (!fs.existsSync(vault)) { console.error(`No vault at ${vault}. Pass --vault <dir> or set PRODUCTIVITY_VAULT.`); process.exit(2); }
  await createServer({ vault }).connect(new StdioServerTransport());
}

if (process.argv[1] && path.basename(process.argv[1]) === 'server.mjs') main();
