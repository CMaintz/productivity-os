#!/usr/bin/env node
// Creates (or tops up) the Obsidian vault from vault-template/. Never overwrites existing files.
//
// Usage:
//   node tools/vault/init.mjs [--path <vault dir>] [--from-inventory out/inventory.json] [--git]
// Defaults: --path %USERPROFILE%\Vault
//   --from-inventory  create Projects/<name>.md for new projects; for existing notes refresh only
//                     `path`/`repo` and the generated docs block (safe to re-run after moving folders)
//   --git             git init the vault (if not already a repo) and make an initial commit
//   --update-system   overwrite the system-owned files (CLAUDE.md, .claude/skills, Bases) with the
//                     template's newer versions; old copies go to _system/backup/<timestamp>/

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncProjects } from './projects.mjs';
import { writeFileAtomic } from '../lib/atomic-write.mjs';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vault-template');

function parseArgs(argv) {
  const a = { path: path.join(os.homedir(), 'Vault'), inventory: null, git: false, updateSystem: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--path') a.path = argv[++i];
    else if (argv[i] === '--from-inventory') a.inventory = argv[++i];
    else if (argv[i] === '--git') a.git = true;
    else if (argv[i] === '--update-system') a.updateSystem = true;
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

// Files the system owns. Your notes, Home.md, policy, memory, widget manifests and layout are never touched.
const SYSTEM = ['CLAUDE.md', 'Widgets.md', path.join('.claude', 'skills'), 'Bases', path.join('_system', 'widgets', 'views.md')];

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  if (fs.statSync(dir).isFile()) return [dir];
  return fs.readdirSync(dir).flatMap(n => listFiles(path.join(dir, n)));
}

/** Overwrites changed system-owned files from the template, backing up the old copies. */
export function updateSystem(src, vault, stamp = Date.now()) {
  const updated = [];
  for (const from of SYSTEM.flatMap(rel => listFiles(path.join(src, rel)))) {
    const rel = path.relative(src, from); const to = path.join(vault, rel);
    if (fs.existsSync(to) && fs.readFileSync(to).equals(fs.readFileSync(from))) continue;
    if (fs.existsSync(to)) {
      const backup = path.join(vault, '_system', 'backup', String(stamp), rel);
      fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.copyFileSync(to, backup);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); updated.push(rel);
  }
  return updated;
}

/** Tells the vault's skills where productivity-os lives, so they can run its tools. */
export function writeToolsConfig(vault, repoRoot = path.resolve(TEMPLATE, '..')) {
  const file = path.join(vault, '_system', 'tools.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  // mainHost: the PC that runs the executor. Set once, on the first setup; edit to move it.
  const config = { ...prev, productivityOs: repoRoot.replace(/\\/g, '/'), mainHost: prev.mainHost || os.hostname() };
  writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n');
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
  writeToolsConfig(a.path);
  if (a.updateSystem) console.log(`  system files updated: ${updateSystem(TEMPLATE, a.path).join(', ') || 'none (already current)'}`);
  console.log(`Vault: ${a.path}\n  template files created: ${t.created.length}, already present (kept): ${t.skipped.length}`);
  if (a.inventory) {
    const s = syncProjects(a.path, JSON.parse(fs.readFileSync(a.inventory, 'utf8')));
    console.log(`  project notes created: ${s.created.length}, refreshed: ${s.refreshed.length}, unchanged: ${s.unchanged.length}`);
  }
  if (a.git) { gitInit(a.path); console.log('  git: initialised and committed'); }
  console.log('\nNext: open the folder as a vault in Obsidian, install the plugins listed in docs/VAULT.md, then run `claude` in the vault and try /today.');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'init.mjs') main();
