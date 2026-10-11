#!/usr/bin/env node
// Creates (or tops up) the Obsidian vault from vault-template/. Never overwrites existing files.
//
// Usage:
//   node tools/vault/init.mjs [--path <vault dir>] [--from-inventory out/inventory.json] [--git]
// Defaults: --path %USERPROFILE%\Vault
//   --from-inventory  also create Projects/<name>.md for every scanned project (skips existing notes)
//   --git             git init the vault (if not already a repo) and make an initial commit

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vault-template');
const ACTIVE_DAYS = 60;

function parseArgs(argv) {
  const a = { path: path.join(os.homedir(), 'Vault'), inventory: null, git: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--path') a.path = argv[++i];
    else if (argv[i] === '--from-inventory') a.inventory = argv[++i];
    else if (argv[i] === '--git') a.git = true;
  }
  return a;
}

export function copyTemplate(src, dest, created = [], skipped = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name); const to = path.join(dest, e.name);
    if (e.isDirectory()) { copyTemplate(from, to, created, skipped); continue; }
    if (fs.existsSync(to)) { skipped.push(to); continue; }
    fs.copyFileSync(from, to); created.push(to);
  }
  return { created, skipped };
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const yamlStr = s => JSON.stringify(s ?? '');

export function projectNote(p, today = new Date()) {
  const last = p.lastCommitDate || p.newest;
  const ageDays = last ? (today - new Date(last)) / 864e5 : Infinity;
  const docs = (p.docs || []).filter(d => d.type !== 'note').slice(0, 15)
    .map(d => `- ${d.type}: \`${d.path}\``).join('\n');
  return `---
type: project
status: ${ageDays <= ACTIVE_DAYS ? 'active' : 'paused'}
area: 
repo: ${p.github || ''}
path: ${yamlStr(p.path)}
priority: 2
next: 
updated: ${(last || today.toISOString()).slice(0, 10)}
---
# ${p.name}

## What & why
${p.languages?.length ? `Languages: ${p.languages.join(', ')}.` : ''}${p.lastCommitSubject ? ` Last commit: "${p.lastCommitSubject}".` : ''}

## Tasks

## Decisions
${docs || '<!-- none found by the inventory -->'}

## Log
`;
}

export function seedProjects(vault, inventory, today = new Date()) {
  const dir = path.join(vault, 'Projects'); fs.mkdirSync(dir, { recursive: true });
  const created = []; const skipped = [];
  for (const p of inventory.projects || []) {
    const file = path.join(dir, `${slug(p.name)}.md`);
    if (fs.existsSync(file)) { skipped.push(file); continue; }
    fs.writeFileSync(file, projectNote(p, today)); created.push(file);
  }
  return { created, skipped };
}

function gitInit(vault) {
  const run = args => execFileSync('git', args, { cwd: vault, stdio: 'ignore' });
  if (!fs.existsSync(path.join(vault, '.git'))) run(['init', '-q']);
  run(['add', '-A']);
  try { run(['commit', '-qm', 'vault: initial setup from productivity-os template']); } catch { /* nothing new to commit */ }
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const t = copyTemplate(TEMPLATE, a.path);
  console.log(`Vault: ${a.path}\n  template files created: ${t.created.length}, already present (kept): ${t.skipped.length}`);
  if (a.inventory) {
    const s = seedProjects(a.path, JSON.parse(fs.readFileSync(a.inventory, 'utf8')));
    console.log(`  project notes created: ${s.created.length}, existing (kept): ${s.skipped.length}`);
  }
  if (a.git) { gitInit(a.path); console.log('  git: initialised and committed'); }
  console.log('\nNext: open the folder as a vault in Obsidian, install the plugins listed in docs/VAULT.md, then run `claude` in the vault and try /today.');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'init.mjs') main();
