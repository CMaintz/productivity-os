import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { advanceForges, listForges, newForge } from '../forge.mjs';
import { loadBuild, mergeTicketPr, progressOf } from '../build.mjs';
import { parseDecision } from '../lead.mjs';
import { listCards } from '../../actions/cards.mjs';
import { runOnce } from '../../actions/executor.mjs';
import { PLAN } from './fixtures.mjs';
import { fakeGitHub, fakeSystem } from './build-fakes.mjs';

const NOW = new Date('2026-10-15T09:00:00Z');
const at = m => new Date(NOW.valueOf() + m * 60_000);
const ISSUES = { 1: 11, 2: 12, 3: 13 };

/** A forge whose repo card just went through: stage build, plan with T1 <- T2 <- T3. */
function building() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
  fs.mkdirSync(path.join(v, '_system', 'actions'), { recursive: true });
  fs.writeFileSync(path.join(v, '_system', 'changelog.md'), '');
  fs.writeFileSync(path.join(v, '_system', 'tools.json'), JSON.stringify({ githubOwner: 'me', projectsRoot: path.join(v, 'Projects') }));
  newForge(v, 'Tidy flat', { now: NOW });
  const f = listForges(v)[0];
  fs.writeFileSync(path.join(f.dir, 'plan.md'), PLAN);
  fs.writeFileSync(f.file, f.text.replace('stage: spec', 'stage: build').replace('name: ""', 'name: "Tidewell"').replace('repo: ""', 'repo: "https://github.com/me/tidewell"').replace('---\n#', `issues: ${JSON.stringify(ISSUES)}\n---\n#`));
  return { v, gh: fakeGitHub(Object.values(ISSUES)), sys: fakeSystem() };
}

const pass = (w, m, runClaude = () => ({ ok: true, text: 'UNBLOCK: try again' })) => advanceForges(w.v, { now: at(m), runClaude, run: w.gh.run, sys: w.sys });
const ticket = (w, n) => loadBuild(w.v, 'tidy-flat').tickets[n];
const labels = (w, issue) => [...w.gh.issues.get(issue).labels].sort();
const cardBy = (w, action) => listCards(w.v).filter(c => c.action === action).at(-1);
const press = (c, status, extra = '') => fs.writeFileSync(c.file, c.text.replace(/^status: .*$/m, `status: ${status}`) + extra);

test('lead decisions: the last decision line wins; none means null', () => {
  assert.deepEqual(parseDecision('thinking...\nUNBLOCK: no\nmore\nESCALATE: Pay for X?'), { kind: 'ESCALATE', body: 'Pay for X?' });
  assert.equal(parseDecision('I would unblock: maybe'), null);
});

test('build: clone, workers in dependency order, retry, merge card, release, built', async () => {
  const w = building();
  assert.match((await pass(w, 1)).join(), /T1: worker started/);
  assert.ok(w.gh.calls.some(c => c.args[0] === 'repo' && c.args[1] === 'clone'), 'the repo is cloned');
  assert.equal(w.sys.started.length, 1, 'only T1 has no dependencies');
  assert.match(w.sys.started[0].prompt, /^\/feature https:\/\/github.com\/me\/tidewell\/issues\/11/);
  assert.match(w.sys.started[0].cwd, /tidewell-worktrees[\\/]T1$/);
  assert.deepEqual(labels(w, 11), ['agent:working']);
  assert.deepEqual(await pass(w, 2), [], 'nothing to say while the worker runs');

  w.sys.finish('gave up', true);
  assert.match((await pass(w, 3)).join(), /T1: worker ended without a PR; retrying.*T1: worker started/);
  const pr = w.gh.openPr(1, 11, ['pass', 'skipping']);
  w.sys.finish('shipped');
  assert.match((await pass(w, 4)).join(), new RegExp(`T1: worker finished with PR #${pr}.*merge card proposed`));
  const merge = cardBy(w, 'forge_merge_pr');
  assert.equal(merge.status, 'pending', 'merging needs you until the trust ladder says otherwise');
  assert.deepEqual(await pass(w, 5), [], 'one card per commit');

  press(merge, 'approved');
  runOnce(w.v, { now: at(6), ghRunner: w.gh.run });
  assert.equal(cardBy(w, 'forge_merge_pr').status, 'done');
  assert.ok(w.gh.calls.some(c => c.args.join(' ').includes(`pr merge ${pr} --repo me/tidewell --squash --delete-branch --match-head-commit sha${pr}`)));
  assert.match((await pass(w, 7)).join(), /T2: dependencies done; ready.*T2: worker started/);
  assert.equal(progressOf(w.v, 'tidy-flat'), '1/3');

  w.gh.issues.get(12).state = 'CLOSED';
  w.sys.finish('ok');
  await pass(w, 8);
  w.gh.issues.get(13).state = 'CLOSED';
  w.sys.finish('ok');
  await pass(w, 9);
  const f = listForges(w.v)[0];
  assert.equal(f.stage, 'built');
  assert.equal(f.status, 'done');
  assert.match(cardBy(w, 'reminder').text, /All 3 tickets are done/);
});

test('build: a merge card refuses a PR that turned red', () => {
  const w = building();
  const pr = w.gh.openPr(1, 11, ['pass', 'fail']);
  assert.equal(mergeTicketPr({ params: { repo: 'me/tidewell', pr, sha: `sha${pr}`, issue: 11 } }, { gh: w.gh.run }).ok, false);
  assert.ok(!w.gh.calls.some(c => c.args[1] === 'merge'));
});

test('build: two failures block the ticket; the lead unblocks, re-plans or asks you', async () => {
  const w = building();
  await pass(w, 1);
  w.sys.finish('nope', true);
  await pass(w, 2);
  w.sys.finish('still nope', true);
  const leadCalls = [];
  const unblock = (p, cwd, tools) => { leadCalls.push({ p, cwd, tools }); return { ok: true, text: 'Looked at it.\nUNBLOCK: Use the existing list component.' }; };
  assert.match((await pass(w, 3, unblock)).join(), /T1: blocked after 2 tries.*T1: lead unblocked it.*T1: worker started/);
  assert.match(leadCalls[0].p, /still nope/, 'the lead sees the failure');
  assert.doesNotMatch(leadCalls[0].tools, /Write|Edit/, 'the lead only reads');
  assert.ok(w.gh.calls.some(c => c.args[0] === 'issue' && c.args[1] === 'comment' && /Use the existing list component/.test(c.input)));

  w.gh.issues.get(11).labels.add('agent:blocked');
  w.sys.finish('blocked myself', false);
  const replan = () => ({ ok: true, text: 'REPLAN:\n### T1: Part A\nDepends on: none\nIntent: a\nAcceptance criteria:\n- [ ] a\nScope boundaries:\n- a\nPointers:\n- a\n\n### T2: Part B\nDepends on: T1\nIntent: b\nAcceptance criteria:\n- [ ] b\nScope boundaries:\n- b\nPointers:\n- b\n' });
  assert.match((await pass(w, 4, replan)).join(), /T1: lead re-planned it into T4, T5/);
  assert.equal(ticket(w, 1).state, 'replaced');
  assert.deepEqual(ticket(w, 5).deps, [4], 'new tickets keep their own dependencies');
  assert.equal(w.gh.issues.get(11).state, 'CLOSED');
  assert.equal(ticket(w, 2).state, 'waiting', 'T2 waits for the replacements, not the closed T1');

  w.gh.issues.get(ticket(w, 4).issue).labels.add('agent:blocked');
  w.sys.finish('x', false);
  const ask = () => ({ ok: true, text: 'ESCALATE: Should lists be shared by link or by invite?' });
  assert.match((await pass(w, 5, ask)).join(), /T4: asked you/);
  const q = cardBy(w, 'forge_question');
  assert.match(q.text, /shared by link or by invite/);
  press(q, 'approved', '\n## Answer\nBy invite only.\n');
  runOnce(w.v, { now: at(6) });
  assert.match((await pass(w, 7)).join(), /T4: released with your answer/);
  assert.ok(w.gh.calls.some(c => /The owner answered: By invite only\./.test(c.input ?? '')));
});

test('build: usage pacing and usage-limit pauses', async () => {
  const w = building();
  fs.writeFileSync(path.join(w.v, '_system', 'usage.json'), JSON.stringify({ fiveHourPct: 91, weeklyPct: 40, resetsAt: '2026-10-15T11:00:00Z' }));
  assert.match((await pass(w, 1)).join(), /usage at 91% \(limit 80%\); paused until 2026-10-15T11:00:00Z/);
  assert.equal(w.sys.started.length, 0);
  fs.writeFileSync(path.join(w.v, '_system', 'usage.json'), JSON.stringify({ fiveHourPct: 10, weeklyPct: 10 }));
  assert.deepEqual(await pass(w, 30), [], 'the pause holds until its reset time');
  assert.match((await pass(w, 121)).join(), /T1: worker started/);
  w.sys.finish('Claude usage limit reached. Try again at 3pm.', true);
  assert.match((await pass(w, 122)).join(), /hit the usage limit; paused until/);
  assert.equal(ticket(w, 1).attempts, 0, "a usage stop isn't the ticket's fault");
});

test('build: a stuck worker is stopped after the time limit and counts as a failure', async () => {
  const w = building();
  await pass(w, 1);
  const pid = w.sys.started[0].pid;
  assert.deepEqual(await pass(w, 179), []);
  assert.match((await pass(w, 181)).join(), /retrying/);
  assert.deepEqual(w.sys.killed, [pid]);
});
