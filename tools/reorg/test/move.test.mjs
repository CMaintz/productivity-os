import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planMoves, applyMoves, undoLog, historyRenames } from '../move.mjs';
import { claudeEncode } from '../../inventory/inventory.mjs';

const write = (p, s = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const gitc = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'ignore' });

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-'));
  const P = path.join(home, 'Projects');
  const clean = path.join(home, 'IdeaProjects', 'thing');
  write(path.join(clean, 'pom.xml')); gitc(clean, 'init', '-q'); gitc(clean, 'add', '.'); gitc(clean, 'commit', '-qm', 'i');
  const dirty = path.join(P, 'dirty');
  write(path.join(dirty, 'a.txt')); gitc(dirty, 'init', '-q'); gitc(dirty, 'add', '.'); gitc(dirty, 'commit', '-qm', 'i');
  write(path.join(dirty, 'a.txt'), 'changed');
  // Claude history: exact project, a subfolder session, and an unrelated sibling with a colliding prefix
  const hist = path.join(home, '.claude', 'projects');
  const sub = path.join(clean, 'sub');
  const sibling = clean + '-other';
  fs.mkdirSync(sibling);
  write(path.join(hist, claudeEncode(clean), 's1.jsonl'), JSON.stringify({ cwd: clean }) + '\n');
  write(path.join(hist, claudeEncode(sub), 's2.jsonl'), JSON.stringify({ cwd: sub }) + '\n');
  write(path.join(hist, claudeEncode(sibling), 's3.jsonl'), JSON.stringify({ cwd: sibling }) + '\n');
  return { home, P, clean, dirty, hist, sub, sibling };
}

test('dry run changes nothing and flags problems', () => {
  const f = fixture();
  const plan = { moves: [
    { from: f.clean, to: path.join(f.P, 'java', 'thing') },
    { from: f.dirty, to: path.join(f.P, 'misc', 'dirty') },
    { from: path.join(f.P, 'nope'), to: path.join(f.P, 'x') },
  ] };
  const c = planMoves(plan, { home: f.home, allowDirty: false });
  assert.equal(c.results[0].problems.length, 0);
  assert.match(c.results[1].problems.join(), /unsaved work/);
  assert.match(c.results[2].problems.join(), /does not exist/);
  assert.ok(fs.existsSync(f.clean));
  assert.ok(!fs.existsSync(path.join(f.P, 'java')));
});

test('history follows project and subfolders but not prefix-colliding siblings', () => {
  const f = fixture();
  const to = path.join(f.P, 'java', 'thing');
  const r = historyRenames(f.clean, to, f.home).map(h => path.basename(h.to)).sort();
  assert.deepEqual(r, [claudeEncode(to), claudeEncode(path.join(to, 'sub'))].sort());
});

const worktree = (root, name) => path.join(root, '.claude', 'worktrees', name);
const baseline = (f, to) => [claudeEncode(to), claudeEncode(path.join(to, 'sub'))];

test('history follows worktree sessions that started in the parent repo', () => {
  const f = fixture();
  const wt = worktree(f.clean, 'feat');
  const lowerCase = wt[0].toLowerCase() + wt.slice(1);
  write(path.join(f.hist, claudeEncode(wt), 's4.jsonl'), [f.clean, lowerCase].map(cwd => JSON.stringify({ cwd })).join('\n') + '\n');
  const to = path.join(f.P, 'java', 'thing');
  const r = historyRenames(f.clean, to, f.home).map(h => path.basename(h.to)).sort();
  assert.deepEqual(r, [...baseline(f, to), claudeEncode(worktree(to, 'feat'))].sort());
});

test('history follows folders holding only subagent transcripts', () => {
  const f = fixture();
  const agentsWt = worktree(f.clean, 'agents');
  write(path.join(f.hist, claudeEncode(agentsWt), 'id', 'subagents', 'a.jsonl'), JSON.stringify({ cwd: agentsWt }) + '\n');
  const to = path.join(f.P, 'java', 'thing');
  const r = historyRenames(f.clean, to, f.home).map(h => path.basename(h.to)).sort();
  assert.deepEqual(r, [...baseline(f, to), claudeEncode(worktree(to, 'agents'))].sort());
});

test('apply moves, carries history, skips blocked; undo restores', () => {
  const f = fixture();
  const to = path.join(f.P, 'java', 'thing');
  const opts = { home: f.home, allowDirty: false };
  const log = applyMoves(planMoves({ moves: [{ from: f.clean, to }, { from: f.dirty, to: path.join(f.P, 'm', 'dirty') }] }, opts), opts);
  assert.equal(log.done.length, 1);
  assert.equal(log.skipped.length, 1);
  assert.ok(fs.existsSync(path.join(to, 'pom.xml')));
  assert.ok(!fs.existsSync(f.clean));
  assert.ok(fs.existsSync(path.join(f.hist, claudeEncode(to), 's1.jsonl')));
  assert.ok(fs.existsSync(path.join(f.hist, claudeEncode(f.sibling), 's3.jsonl')));
  assert.ok(fs.existsSync(f.dirty));

  const res = undoLog(log);
  assert.equal(res.failed.length, 0);
  assert.ok(fs.existsSync(path.join(f.clean, 'pom.xml')));
  assert.ok(fs.existsSync(path.join(f.hist, claudeEncode(f.clean), 's1.jsonl')));
  assert.ok(fs.existsSync(path.join(f.hist, claudeEncode(f.sub), 's2.jsonl')));
});

test('allow-dirty downgrades unsaved work to a warning', () => {
  const f = fixture();
  const c = planMoves({ moves: [{ from: f.dirty, to: path.join(f.P, 'm', 'dirty') }] }, { home: f.home, allowDirty: true });
  assert.equal(c.results[0].problems.length, 0);
  assert.match(c.results[0].warnings.join(), /unsaved work/);
});

test('overlapping and conflicting moves are rejected as a whole', () => {
  const f = fixture();
  const c = planMoves({ moves: [
    { from: f.P, to: path.join(f.home, 'P2') },
    { from: f.dirty, to: path.join(f.home, 'x') },
    { from: f.clean, to: path.join(f.home, 'P2') },
  ] }, { home: f.home, allowDirty: true });
  assert.ok(c.globalErrors.some(e => /overlap/.test(e)));
  assert.ok(c.globalErrors.some(e => /share destination/.test(e)));
});
