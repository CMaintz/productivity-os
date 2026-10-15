// The verify stage: three detached checks on the merged product, findings back into the build as
// tickets, bounded so it stops and asks when it isn't converging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listForges } from '../forge.mjs';
import { loadBuild } from '../build.mjs';
import { parseReport, storyNumbers } from '../verify.mjs';
import { runOnce } from '../../actions/executor.mjs';
import { harness } from './build-fakes.mjs';

const { at, building, pass, cardBy, press } = harness();
const SPEC = '# Spec\n## Problem\nx\n## User stories\n1. As a user, I want a list.\nAcceptance criteria:\n- [ ] saves\n2. As a user, I want to share it.\nAcceptance criteria:\n- [ ] link\n## Non-goals\nx\n';
const report = (checks, findings = []) => 'Done.\n```json\n' + JSON.stringify({ checks, findings }) + '\n```\n';
const ok = name => ({ name, ok: true, details: 'fine' });
const QA_CLEAN = report([ok('story 1'), ok('story 2'), ok('axe'), ok('lighthouse'), ok('npm audit'), ok('licenses')]);
const forge = w => listForges(w.v)[0];

/** A forge whose build just finished and whose "built" card you approved. */
async function readyToVerify() {
  const w = building({ spec: SPEC });
  for (const n of [11, 12, 13]) w.gh.issues.get(n).state = 'CLOSED';
  await pass(w, 1);
  press(cardBy(w, 'forge_review'), 'done');
  return w;
}

/** Finishes the three runs of the current round with the given reports. */
function finishRound(w, { qa = QA_CLEAN, arch = report([]), spec = report([]) } = {}) {
  w.sys.finish(qa, false, /^You are the qa/);
  w.sys.finish(arch, false, /^You are the architecture/);
  w.sys.finish(spec, false, /^You are the spec/);
}

test('reports: the last fenced JSON block, with checks and findings in the agreed shape', () => {
  assert.deepEqual(parseReport(report([ok('axe')], [{ title: 'x', severity: 'high', details: 'd' }])).report.findings[0].severity, 'high');
  assert.match(parseReport('no block here').error, /no JSON report/);
  assert.match(parseReport(report([], [{ title: 'x', severity: 'urgent' }])).error, /severity/);
  assert.match(parseReport('```json\n{"checks": "all good"}\n```').error, /checks/);
});

test('stories are read from the spec, not from what the qa agent chose to test', () => {
  assert.deepEqual(storyNumbers(SPEC), [1, 2]);
});

test('approving "built" starts three detached checks; reviewers are read-only', async () => {
  const w = await readyToVerify();
  assert.match((await pass(w, 2)).join(), /verify round 1: qa, architecture and spec checks started/);
  assert.equal(forge(w).stage, 'verify');
  const [qa, arch, spec] = w.sys.started.slice(-3);
  assert.match(qa.prompt, /^You are the qa/);
  assert.match(qa.tools, /Write/, 'qa writes the E2E tests');
  for (const r of [arch, spec]) assert.doesNotMatch(r.tools, /Write|Edit|Bash\(git:\*\)|Bash\(npm/, 'reviewers only read');
  assert.deepEqual(await pass(w, 3), [], 'nothing to do while they run');
});

test('findings of medium and up go back into the build as tickets; low ones are only noted; then verify runs again', async () => {
  const w = await readyToVerify();
  await pass(w, 2);
  finishRound(w, { arch: report([], [{ title: 'Unused helper in lib/', severity: 'low', details: 'dead code' }]), spec: report([], [{ title: 'Share link expires too early', severity: 'medium', details: 'story 2 says a week' }]) });
  assert.match((await pass(w, 3)).join(), /verify round 1: 1 finding to fix; back to build/);
  assert.equal(forge(w).stage, 'build');
  assert.match(forge(w).text, /low: Unused helper in lib\//);
  const created = w.gh.calls.filter(c => c.args[0] === 'issue' && c.args[1] === 'create');
  assert.equal(created.length, 1, 'the low finding is not ticketed');
  assert.ok(created[0].args.includes('verify') && created[0].args.includes('agent-feature'));
  const t = Object.values(loadBuild(w.v, 'tidy-flat').tickets).find(x => x.verify);
  assert.equal(t.state, 'ready', 'the fix ticket goes straight to the workers');
  w.gh.issues.get(t.issue).state = 'CLOSED';
  assert.match((await pass(w, 4)).join(), /verify round 2: qa, architecture and spec checks started/, 'no card between the fix and the next round');
  finishRound(w);
  assert.match((await pass(w, 5)).join(), /verified/);
  assert.equal(forge(w).stage, 'verified');
  assert.match(cardBy(w, 'reminder').text, /Verified in 2 rounds/);
});

test('coverage is enforced: a story without an E2E check, or a run without a usable report, is a high finding', async () => {
  const w = await readyToVerify();
  await pass(w, 2);
  finishRound(w, { qa: report([ok('story 1'), ok('axe')]), arch: 'I looked around and it seems fine.' });
  await pass(w, 3);
  const titles = w.gh.calls.filter(c => c.args[1] === 'create').map(c => c.args[c.args.indexOf('--title') + 1]);
  assert.ok(titles.some(t => /story 2 has no E2E check/.test(t)));
  assert.ok(titles.some(t => /architecture review produced no usable report/.test(t)));
});

test('a finding that still has an open ticket reuses it instead of opening a duplicate', async () => {
  const w = await readyToVerify();
  await pass(w, 2);
  const f = (...titles) => report([], titles.map(title => ({ title, severity: 'medium', details: 'd' })));
  finishRound(w, { spec: f('Share link expires too early', 'List title not saved') });
  await pass(w, 3);
  const fixes = Object.values(loadBuild(w.v, 'tidy-flat').tickets).filter(x => x.verify);
  for (const t of fixes) w.gh.issues.get(t.issue).state = 'CLOSED';
  await pass(w, 4);
  const reopened = fixes.find(t => t.verify === 'Share link expires too early').issue;
  w.gh.issues.get(reopened).state = 'OPEN';
  finishRound(w, { spec: f('Share link expires too early') });
  assert.match((await pass(w, 5)).join(), /1 finding to fix; back to build/);
  assert.equal(w.gh.calls.filter(c => c.args[1] === 'create').length, 2, 'no third issue');
  assert.equal(Object.values(loadBuild(w.v, 'tidy-flat').tickets).find(t => t.issue === reopened).state, 'ready', 'the open ticket goes back to the workers');
});

test('not converging: the same number of findings again stops on a card; continue or accept', async () => {
  const w = await readyToVerify();
  await pass(w, 2);
  const one = n => report([], [{ title: `Problem ${n}`, severity: 'medium', details: 'd' }]);
  finishRound(w, { spec: one(1) });
  await pass(w, 3);
  for (const t of Object.values(loadBuild(w.v, 'tidy-flat').tickets)) w.gh.issues.get(t.issue).state = 'CLOSED';
  await pass(w, 4);
  finishRound(w, { spec: one(2) });
  assert.match((await pass(w, 5)).join(), /verify isn't converging \(1 finding, 1 last round\); asking you/);
  const card = cardBy(w, 'forge_review');
  assert.match(card.text, /Problem 2/);
  assert.equal(forge(w).status, 'waiting');
  press(card, 'rejected');
  await pass(w, 6);
  assert.equal(forge(w).stage, 'verified', 'No means accept as is');
  assert.match(forge(w).text, /accepted with 1 open finding/);
});

test('three rounds at most, then it asks', async () => {
  const w = await readyToVerify();
  for (let r = 0; r < 3; r++) {
    await pass(w, 10 * r + 2);
    finishRound(w, { spec: report([], Array.from({ length: 3 - r }, (_, i) => ({ title: `R${r} issue ${i}`, severity: 'high', details: 'd' }))) });
    await pass(w, 10 * r + 3);
    for (const t of Object.values(loadBuild(w.v, 'tidy-flat').tickets)) w.gh.issues.get(t.issue).state = 'CLOSED';
    if (r < 2) await pass(w, 10 * r + 4);
  }
  assert.equal(forge(w).status, 'waiting');
  assert.match(cardBy(w, 'forge_review').text, /3 rounds/);
  press(cardBy(w, 'forge_review'), 'done');
  runOnce(w.v, { now: at(40) });
  assert.match((await pass(w, 41)).join(), /1 finding to fix; back to build/, 'Do it: fix what is open, then one more round');
  for (const t of Object.values(loadBuild(w.v, 'tidy-flat').tickets)) w.gh.issues.get(t.issue).state = 'CLOSED';
  assert.match((await pass(w, 42)).join(), /verify round 4/);
});
