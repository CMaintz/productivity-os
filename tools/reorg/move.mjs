#!/usr/bin/env node
// Executes an approved reorganisation plan. Dry run unless --apply is given.
//
// Usage:
//   node tools/reorg/move.mjs <plan.json>                 # dry run: check every move, change nothing
//   node tools/reorg/move.mjs <plan.json> --apply         # perform the moves, write an undo log
//   node tools/reorg/move.mjs --undo <reorg-log.json>     # reverse a previous apply
// Options: --allow-dirty (move repos with uncommitted/unpushed work), --home <dir>, --out <dir>
//
// plan.json: { "moves": [ { "from": "C:\\...\\old", "to": "C:\\...\\new", "reason": "..." } ] }
// The plan is written by the reorganise-projects agent after the user approves the proposal.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { claudeEncode } from '../inventory/inventory.mjs';

const LOCK_HINT = 'close IDEs/terminals/Explorer windows using it, then re-run';

function parseArgs(argv) {
  const a = { plan: null, undo: null, apply: false, allowDirty: false, home: os.homedir(), out: 'out' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--apply') a.apply = true;
    else if (k === '--allow-dirty') a.allowDirty = true;
    else if (k === '--undo') a.undo = argv[++i];
    else if (k === '--home') a.home = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (!a.plan) a.plan = k;
  }
  return a;
}

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

// Uncommitted, stashed or unpushed work. Moving keeps it intact, but we still want it saved first.
export function unsavedWork(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return [];
  const issues = [];
  const status = git(dir, ['status', '--porcelain']);
  if (status) issues.push(`${status.split('\n').length} uncommitted change(s)`);
  if (git(dir, ['stash', 'list'])) issues.push('stashes');
  const ahead = git(dir, ['for-each-ref', '--format=%(upstream:track)', 'refs/heads']);
  if (ahead && /ahead/.test(ahead)) issues.push('unpushed commits');
  return issues;
}

// ---------- validation ----------
function checkOverlaps(moves) {
  const errors = [];
  moves.forEach((m, i) => moves.forEach((n, j) => {
    if (i >= j) return;
    if (samePath(m.to, n.to)) errors.push(`moves ${i + 1} and ${j + 1} share destination ${m.to}`);
    if (isInside(n.from, m.from) || isInside(m.from, n.from)) errors.push(`moves ${i + 1} and ${j + 1} overlap (one source contains the other)`);
    if (isInside(m.to, n.from) || isInside(n.to, m.from)) errors.push(`moves ${i + 1} and ${j + 1} conflict (a destination is inside another move's source)`);
  }));
  return errors;
}

export function checkMove(m, { allowDirty }) {
  const problems = []; const warnings = [];
  if (!m.from || !m.to) return { problems: ['move needs "from" and "to"'], warnings };
  if (!path.isAbsolute(m.from) || !path.isAbsolute(m.to)) problems.push('paths must be absolute');
  if (!fs.existsSync(m.from)) problems.push('source does not exist');
  if (fs.existsSync(m.to) && !samePath(m.from, m.to)) problems.push('destination already exists');
  if (isInside(m.to, m.from)) problems.push('destination is inside the source');
  if (path.parse(path.resolve(m.from)).root.toLowerCase() !== path.parse(path.resolve(m.to)).root.toLowerCase()) {
    problems.push('source and destination are on different drives (rename would not be atomic)');
  }
  if (problems.length) return { problems, warnings };
  const unsaved = unsavedWork(m.from);
  if (unsaved.length) (allowDirty ? warnings : problems).push(`unsaved work: ${unsaved.join(', ')}${allowDirty ? '' : ' (commit/push first, or pass --allow-dirty)'}`);
  if (['.venv', 'venv'].some(v => fs.existsSync(path.join(m.from, v)))) warnings.push('Python venv has absolute paths: recreate it after the move');
  return { problems, warnings };
}

// ---------- Claude Code history ----------
// History lives in ~/.claude/projects/<encoded cwd>. Encoding is lossy ("foo-bar" vs "foo/bar"),
// so prefix matches are confirmed by reading the real cwd recorded in a transcript.
function transcriptCwd(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return null; }
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n', 50);
    for (const line of lines) {
      try { const cwd = JSON.parse(line).cwd; if (cwd) return cwd; } catch { /* skip partial line */ }
    }
  }
  return null;
}

export function historyRenames(from, to, home) {
  const base = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(base)) return [];
  const prefix = claudeEncode(from);
  const out = [];
  for (const name of fs.readdirSync(base)) {
    if (name !== prefix && !name.startsWith(prefix + '-')) continue;
    const cwd = name === prefix ? from : transcriptCwd(path.join(base, name));
    if (!cwd || !(samePath(cwd, from) || isInside(cwd, from))) continue;
    const newCwd = path.join(to, path.relative(from, cwd));
    out.push({ from: path.join(base, name), to: path.join(base, claudeEncode(newCwd)) });
  }
  return out;
}

// ---------- plan / apply / undo ----------
export function planMoves(plan, opts) {
  const moves = plan.moves || [];
  const globalErrors = checkOverlaps(moves);
  const results = moves.map(m => ({ ...m, ...checkMove(m, opts), history: m.from && m.to ? historyRenames(m.from, m.to, opts.home) : [] }));
  for (const r of results) {
    for (const h of r.history) if (fs.existsSync(h.to)) r.warnings.push(`Claude history target exists, history not moved: ${path.basename(h.to)}`);
  }
  return { globalErrors, results };
}

function rename(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

export function applyMoves(checked, opts) {
  const log = { appliedAt: new Date().toISOString(), home: opts.home, done: [], failed: [], skipped: [] };
  for (const r of checked.results) {
    if (r.problems.length) { log.skipped.push({ from: r.from, to: r.to, problems: r.problems }); continue; }
    try {
      rename(r.from, r.to);
    } catch (e) {
      const hint = ['EPERM', 'EBUSY', 'EACCES'].includes(e.code) ? ` (${LOCK_HINT})` : '';
      log.failed.push({ from: r.from, to: r.to, error: `${e.code || e.message}${hint}` });
      continue;
    }
    const history = [];
    for (const h of r.history) {
      if (fs.existsSync(h.to)) continue;
      try { rename(h.from, h.to); history.push(h); } catch { /* history is best-effort */ }
    }
    log.done.push({ from: r.from, to: r.to, reason: r.reason, history, warnings: r.warnings });
  }
  return log;
}

export function undoLog(log) {
  const result = { restored: [], failed: [] };
  for (const d of [...log.done].reverse()) {
    try {
      if (fs.existsSync(d.from)) throw new Error('original path is occupied again');
      rename(d.to, d.from);
      for (const h of d.history) if (!fs.existsSync(h.from) && fs.existsSync(h.to)) rename(h.to, h.from);
      result.restored.push(d.from);
    } catch (e) {
      result.failed.push({ path: d.to, error: e.code || e.message });
    }
  }
  return result;
}

// ---------- output ----------
function printPlan(checked, apply) {
  const ok = checked.results.filter(r => !r.problems.length).length;
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${ok}/${checked.results.length} moves ready\n`);
  checked.globalErrors.forEach(e => console.log(`✗ plan: ${e}`));
  for (const r of checked.results) {
    console.log(`${r.problems.length ? '✗' : '✓'} ${r.from}\n    → ${r.to}${r.reason ? `   (${r.reason})` : ''}`);
    r.problems.forEach(p => console.log(`    ✗ ${p}`));
    r.warnings.forEach(w => console.log(`    ! ${w}`));
    if (r.history.length) console.log(`    ↳ Claude history: ${r.history.length} folder(s) follow`);
  }
}

const POST_MOVE = [
  'Re-open moved projects from their new path in your IDE (JetBrains/VS Code recent lists still show old paths).',
  'Recreate any Python venvs flagged above.',
  'Old Claude sessions now live under the new path; their transcripts still mention the old cwd, which is harmless.',
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.undo) {
    const res = undoLog(JSON.parse(fs.readFileSync(args.undo, 'utf8')));
    console.log(`Restored ${res.restored.length}, failed ${res.failed.length}`);
    res.failed.forEach(f => console.log(`✗ ${f.path}: ${f.error}`));
    process.exit(res.failed.length ? 1 : 0);
  }
  if (!args.plan) { console.error('Usage: move.mjs <plan.json> [--apply] [--allow-dirty] | --undo <log.json>'); process.exit(2); }
  const opts = { allowDirty: args.allowDirty, home: args.home };
  const checked = planMoves(JSON.parse(fs.readFileSync(args.plan, 'utf8')), opts);
  printPlan(checked, args.apply);
  if (checked.globalErrors.length) { console.log('\nPlan has conflicts; nothing was moved.'); process.exit(1); }
  if (!args.apply) { console.log('\nDry run only. Re-run with --apply to move.'); return; }
  const log = applyMoves(checked, opts);
  fs.mkdirSync(args.out, { recursive: true });
  const logPath = path.join(args.out, `reorg-log-${log.appliedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  console.log(`\nMoved ${log.done.length}, skipped ${log.skipped.length}, failed ${log.failed.length}.`);
  log.failed.forEach(f => console.log(`✗ ${f.from}: ${f.error}`));
  console.log(`Undo log: ${logPath}  (undo: node tools/reorg/move.mjs --undo "${logPath}")\n`);
  POST_MOVE.forEach(s => console.log(`- ${s}`));
}

if (process.argv[1] && path.basename(process.argv[1]) === 'move.mjs') main();
