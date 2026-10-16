#!/usr/bin/env node
// Claude Code hook: keeps Sessions/<date>-<project>-<id>.md in the vault up to date and
// appends to _system/activity.jsonl. Installed by tools/hooks/install.mjs for the
// SessionStart, UserPromptSubmit, Notification, Stop and SessionEnd events.
//
// It must never get in Claude's way: it prints nothing (stdout from some hooks is
// added to Claude's context), always exits 0, and does nothing if the vault is missing.
// Vault location: $PRODUCTIVITY_VAULT, else ~/Vault.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { activityLine, sessionFile, statusFor, updateNote } from './sessions.mjs';
import { noteForPath, slug } from '../vault/projects.mjs';

const vault = process.env.PRODUCTIVITY_VAULT || path.join(os.homedir(), 'Vault');

/**
 * The project a cwd belongs to: the nearest folder with a .git, else the cwd itself, and a
 * worktree's main checkout. Its note is the one whose `path` is that folder; notes without
 * a path are found by name.
 */
export function projectFor(cwd, vaultDir) {
  let dir = path.resolve(cwd || '.');
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) { dir = d; break; }
    if (path.dirname(d) === d) break;
  }
  dir = mainCheckout(dir);
  const file = noteForPath(vaultDir, dir);
  if (file) return { slug: path.basename(file, '.md'), note: `Projects/${path.basename(file, '.md')}` };
  const s = slug(path.basename(dir)) || 'unknown';
  const note = fs.existsSync(path.join(vaultDir, 'Projects', `${s}.md`)) ? `Projects/${s}` : null;
  return { slug: s, note };
}

// A worktree's .git is a file pointing at <main>/.git/worktrees/<name>.
function mainCheckout(dir) {
  let gitDir;
  try { gitDir = fs.readFileSync(path.join(dir, '.git'), 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)?.[1]; } catch { return dir; }
  if (!gitDir) return dir;
  const wt = path.resolve(dir, gitDir);
  return path.basename(path.dirname(wt)) === 'worktrees' ? path.dirname(path.dirname(path.dirname(wt))) : dir;
}

/** A session keeps its note across midnight: reuse the file that already has its id. */
function noteFor(input, project, now) {
  const id = String(input.session_id || 'unknown').slice(0, 8);
  const hit = fs.readdirSync(path.join(vault, 'Sessions')).find(f => f.endsWith(`-${id}.md`));
  return hit ? path.join(vault, 'Sessions', hit) : sessionFile(vault, input, project, now);
}

function handle(input) {
  if (!fs.existsSync(path.join(vault, 'Sessions')) || !statusFor(input.hook_event_name)) return;
  const now = new Date().toISOString();
  const project = projectFor(input.cwd, vault);
  const file = noteFor(input, project, now);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  fs.writeFileSync(file, updateNote(existing, input, project, now));
  fs.mkdirSync(path.join(vault, '_system'), { recursive: true });
  fs.appendFileSync(path.join(vault, '_system', 'activity.jsonl'), activityLine(input, project, now));
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try { handle(JSON.parse(raw)); } catch { /* never block Claude */ }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'session-hook.mjs') main().finally(() => process.exit(0));
