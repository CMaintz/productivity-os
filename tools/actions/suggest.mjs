#!/usr/bin/env node
// Turns the vault's current state into action cards using the rules in rules.mjs.
// Safe to run often: cards are deduped by key, and never-listed ones are skipped.
// Usage: node tools/actions/suggest.mjs [--vault <dir>]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fieldsOf } from '../lib/frontmatter.mjs';
import { suggestions } from './rules.mjs';
import { createCard } from './cards.mjs';

const mdFiles = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.md')) : []);

export function vaultState(vault) {
  const dir = path.join(vault, 'Projects');
  const projects = mdFiles(dir).map(f => ({ slug: path.basename(f, '.md'), ...fieldsOf(fs.readFileSync(path.join(dir, f), 'utf8')) }));
  return { projects, inboxCount: mdFiles(path.join(vault, 'Inbox')).length };
}

export function suggestAll(vault, now = new Date()) {
  return suggestions(vaultState(vault), now).map(spec => createCard(vault, spec, now.toISOString())).filter(Boolean);
}

function main() {
  const i = process.argv.indexOf('--vault');
  const vault = i > 0 ? process.argv[i + 1] : process.env.PRODUCTIVITY_VAULT || path.join(os.homedir(), 'Vault');
  const created = suggestAll(vault);
  console.log(created.length ? `New cards:\n${created.map(f => `  ${path.relative(vault, f)}`).join('\n')}` : 'No new cards.');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'suggest.mjs') main();
