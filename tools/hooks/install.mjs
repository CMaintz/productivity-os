#!/usr/bin/env node
// Sets (or removes) the status line that records subscription usage for the Product Forge
// (statusline.mjs) in Claude Code's user settings, chaining any you had. It also removes the old
// session hook: session notes now come from Claude Code's transcripts (tools/sessions/).
//
// Usage: node tools/hooks/install.mjs [--uninstall] [--settings <path>]
// Default settings file: ~/.claude/settings.json (a timestamped backup is written first).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The session hook this used to install; npm run hooks removes it from your settings.
const MARKER = 'session-hook.mjs';
const STATUS_MARKER = 'statusline.mjs';
const CHAIN = / --chain (\S+)$/;

// Forward slashes work in both cmd and Git Bash, which Claude Code uses on Windows.
const hookCommand = file => `node "${file.replace(/\\/g, '/')}"`;

/** Our usage-recording status line; an existing one keeps running behind it (--chain). */
export function withStatusLine(settings, command = hookCommand(path.join(HERE, 'statusline.mjs'))) {
  const base = withoutStatusLine(settings);
  const prev = base.statusLine?.type === 'command' ? base.statusLine : null;
  // The chained line travels as JSON (its command and its own refresh), so uninstall restores both.
  const chain = prev ? ` --chain ${Buffer.from(JSON.stringify({ command: prev.command, refreshInterval: prev.refreshInterval })).toString('base64')}` : '';
  const refreshInterval = Math.min(Number(prev?.refreshInterval) || 60, 60);
  return { ...base, statusLine: { ...(prev ?? {}), type: 'command', command: `${command}${chain}`, refreshInterval } };
}

/** Our status line removed; the one it chained, if any, restored as it was. */
export function withoutStatusLine(settings) {
  const cur = settings.statusLine;
  if (!String(cur?.command ?? '').includes(STATUS_MARKER)) return settings;
  const { statusLine, ...rest } = settings;
  const chained = statusLine.command.match(CHAIN);
  if (!chained) return rest;
  const prev = JSON.parse(Buffer.from(chained[1], 'base64').toString('utf8'));
  const { refreshInterval, ...kept } = statusLine;
  return { ...rest, statusLine: { ...kept, command: prev.command, ...(prev.refreshInterval ? { refreshInterval: prev.refreshInterval } : {}) } };
}

const isOurs = group => (group.hooks || []).some(h => String(h.command || '').includes(MARKER));

/** Removes the old session hook's groups from every event, dropping events left empty. */
export function withoutHook(settings) {
  const hooks = { ...(settings.hooks || {}) };
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = hooks[ev].filter(g => !isOurs(g));
    if (!hooks[ev].length) delete hooks[ev];
  }
  return { ...settings, hooks };
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--settings');
  const file = i >= 0 ? args[i + 1] : path.join(os.homedir(), '.claude', 'settings.json');
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const next = args.includes('--uninstall') ? withoutStatusLine(withoutHook(current)) : withStatusLine(withoutHook(current));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  console.log(`${args.includes('--uninstall') ? 'Removed' : 'Installed'} the usage status line in ${file} (and removed the old session hook, if it was there).`);
  if (!args.includes('--uninstall')) console.log('Restart running Claude Code sessions to pick it up. Session notes come from the executor now.');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'install.mjs') main();
