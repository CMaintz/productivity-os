import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listForges } from '../forge.mjs';
import { loadBuild, mergeTicketPr, progressOf } from '../build.mjs';
import { WORKER_TOOLS } from '../workers.mjs';
import { parseDecision } from '../lead.mjs';
import { runOnce } from '../../actions/executor.mjs';
import { harness } from './build-fakes.mjs';

const { NOW, at, building, pass, ticket, labels, cardBy, press } = harness();

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
  assert.match((await pass(w, 3)).join(), /T1: gave up; retrying.*T1: worker started/);
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

  const pr2 = w.gh.openPr(2, 12);
  w.sys.finish('ok');
  await pass(w, 8);
  w.gh.prs.find(p => p.number === pr2).state = 'MERGED';
  assert.match((await pass(w, 9)).join(), /T2: done.*T3: worker started/, 'a PR merged by hand, without "Closes", still finishes its ticket');
  assert.ok(w.gh.calls.some(c => c.args.join(' ') === 'issue close 12 --repo me/tidewell --comment Done in #' + pr2 + '.'));
  w.gh.issues.get(13).state = 'CLOSED';
  await pass(w, 10);
  const f = listForges(w.v)[0];
  assert.equal(f.stage, 'built');
  assert.equal(f.status, 'waiting');
  const built = cardBy(w, 'forge_review');
  assert.match(built.text, /All 3 tickets are done/);
  press(built, 'done');
  assert.match((await pass(w, 11)).join(), /verify round 1/, 'approving the build starts verifying it');
});

test('build: no merge card until GitHub itself calls the PR clean (a required check may not have reported yet)', async () => {
  const w = building();
  await pass(w, 1);
  const pr = w.gh.openPr(1, 11, ['pass']);
  w.gh.prs.find(p => p.number === pr).mergeState = 'BLOCKED';
  w.sys.finish('shipped');
  await pass(w, 2);
  assert.equal(cardBy(w, 'forge_merge_pr'), undefined);
  w.gh.prs.find(p => p.number === pr).mergeState = 'CLEAN';
  assert.match((await pass(w, 3)).join(), /merge card proposed/);
});

test('workers can never merge, call the API or manage repos through gh', () => {
  assert.doesNotMatch(WORKER_TOOLS, /gh pr merge|gh api|gh repo|Bash\(gh:\*\)|Bash\(gh \*\)/);
});

test('build: a merge card refuses a PR that turned red', () => {
  const w = building();
  const pr = w.gh.openPr(1, 11, ['pass', 'fail']);
  assert.equal(mergeTicketPr({ params: { repo: 'me/tidewell', pr, sha: `sha${pr}`, issue: 11 } }, { gh: w.gh.run }).ok, false);
  assert.ok(!w.gh.calls.some(c => c.args[1] === 'merge'));
});

test('build: two failures block the ticket; the lead (detached, read-only) unblocks, re-plans or asks you', async () => {
  const w = building();
  await pass(w, 1);
  w.sys.finish('nope', true);
  await pass(w, 2);
  w.sys.finish('still nope', true);
  assert.match((await pass(w, 3)).join(), /T1: blocked after 2 tries.*T1: lead agent started/);
  const leadRun = w.sys.started.at(-1);
  assert.match(leadRun.prompt, /still nope/, 'the lead sees the failure');
  assert.doesNotMatch(leadRun.tools, /Write|Edit|git/, 'the lead only reads');
  assert.deepEqual(await pass(w, 4), [], 'the executor does not wait for the lead');
  w.sys.finish('Looked at it.\nUNBLOCK: Use the existing list component.', false, /lead agent/);
  assert.match((await pass(w, 5)).join(), /T1: lead unblocked it.*T1: worker started/);
  assert.ok(w.gh.calls.some(c => c.args[1] === 'comment' && /Use the existing list component/.test(c.input)));

  w.gh.issues.get(11).labels.add('agent:blocked');
  w.sys.finish('blocked myself', false, /feature/);
  assert.match((await pass(w, 6)).join(), /the worker says it's blocked.*lead agent started/, 'a repeated block gets a fresh lead run');
  assert.match(w.sys.started.at(-1).prompt, /Number them from T4/);
  w.sys.finish('REPLAN:\n### T4: Part A\nDepends on: none\nIntent: a\nAcceptance criteria:\n- [ ] a\nScope boundaries:\n- a\nPointers:\n- a\n\n### T5: Part B\nDepends on: T4, T2\nIntent: b\nAcceptance criteria:\n- [ ] b\nScope boundaries:\n- b\nPointers:\n- b\n', false, /lead agent/);
  assert.match((await pass(w, 7)).join(), /T1: lead re-planned it into T4, T5/);
  assert.equal(ticket(w, 1).state, 'replaced');
  assert.deepEqual(ticket(w, 5).deps, [4, 2], 'new tickets may depend on existing ones');
  assert.equal(w.gh.issues.get(11).state, 'CLOSED');
  assert.equal(ticket(w, 2).state, 'waiting', 'T2 waits for the replacements, not the closed T1');

  w.gh.issues.get(ticket(w, 4).issue).labels.add('agent:blocked');
  w.sys.finish('x', false, /feature/);
  await pass(w, 8);
  w.sys.finish('ESCALATE: Should lists be shared by link or by invite?', false, /lead agent/);
  assert.match((await pass(w, 9)).join(), /T4: asked you/);
  const q = cardBy(w, 'forge_question');
  assert.match(q.text, /shared by link or by invite/);
  press(q, 'approved', '\n## Answer\nBy invite only.\n');
  runOnce(w.v, { now: at(10) });
  assert.match((await pass(w, 11)).join(), /T4: released with your answer/);
  assert.ok(w.gh.calls.some(c => /The owner answered: By invite only\./.test(c.input ?? '')));
});

test('build: a red PR is a failed try; GitHub errors skip the pass without failing the forge', async () => {
  const w = building();
  await pass(w, 1);
  w.gh.openPr(1, 11, ['pass', 'fail']);
  w.sys.finish('shipped');
  assert.match((await pass(w, 2)).join(), /PR #\d+ has failing checks: c1; retrying.*T1: worker started/);
  const real = w.gh.run;
  w.gh.run = args => { if (args[0] === 'issue' && args[1] === 'list') throw new Error('HTTP 502: Bad Gateway'); return real(args); };
  assert.match((await pass(w, 3)).join(), /GitHub error, trying again next pass: HTTP 502/);
  assert.deepEqual(await pass(w, 4), [], 'the same error is logged once');
  assert.equal(listForges(w.v)[0].status, 'running');
  assert.ok(ticket(w, 1).run, 'the running worker is still tracked');
});

test('build: usage pacing and usage-limit pauses', async () => {
  const w = building();
  fs.writeFileSync(path.join(w.v, '_system', 'usage.json'), JSON.stringify({ fiveHourPct: 91, weeklyPct: 40, resetsAt: '2026-10-15T11:00:00Z', recordedAt: at(0).toISOString() }));
  assert.match((await pass(w, 1)).join(), /usage at 91% \(limit 80%\); paused until 2026-10-15T11:00:00Z/);
  assert.equal(w.sys.started.length, 0);
  fs.writeFileSync(path.join(w.v, '_system', 'usage.json'), JSON.stringify({ fiveHourPct: 10, weeklyPct: 10, resetsAt: '2026-10-15T08:00:00Z', recordedAt: at(120).toISOString() }));
  assert.deepEqual(await pass(w, 30), [], 'the pause holds until its reset time');
  assert.match((await pass(w, 121)).join(), /T1: worker started/);
  w.sys.finish('Claude usage limit reached. Try again at 3pm.', true);
  assert.match((await pass(w, 122)).join(), /hit the usage limit; paused until/);
  assert.equal(ticket(w, 1).attempts, 0, "a usage stop isn't the ticket's fault");
  assert.equal(ticket(w, 1).run, null);
  assert.equal(loadBuild(w.v, 'tidy-flat').paused_until, at(122 + 60).toISOString(), 'a reset time in the past pauses for an hour, not zero');
});

test('build: a stale usage record does not pause the build', async () => {
  const w = building();
  fs.writeFileSync(path.join(w.v, '_system', 'usage.json'), JSON.stringify({ fiveHourPct: 95, weeklyPct: 50, resetsAt: '2026-10-15T11:00:00Z', recordedAt: '2026-10-15T07:00:00Z' }));
  assert.match((await pass(w, 1)).join(), /usage record is from 2026-10-15T07:00:00Z, too old to trust.*T1: worker started/);
  assert.deepEqual(await pass(w, 2), [], 'said once, not every pass');
});

test('build: a stuck worker is stopped after the time limit and counts as a failure', async () => {
  const w = building();
  await pass(w, 1);
  const pid = w.sys.started[0].pid;
  assert.deepEqual(await pass(w, 179), []);
  assert.match((await pass(w, 181)).join(), /retrying/);
  assert.deepEqual(w.sys.killed, [pid]);
});
