import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { advanceForges, listForges, newForge, forgeRows } from '../forge.mjs';
import { STAGES, checkOutput, parsePlan, topoOrder, candidates } from '../stages.mjs';
import { addAvailability, checkName } from '../naming.mjs';
import { listCards } from '../../actions/cards.mjs';
import { runOnce } from '../../actions/executor.mjs';
import { NAMING, PLAN, SPEC, fakeClaude, fakeGh, fetch404 } from './fixtures.mjs';

const NOW = new Date('2026-10-15T09:00:00Z');
const at = m => new Date(NOW.valueOf() + m * 60_000);

function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-'));
  fs.mkdirSync(path.join(v, '_system', 'actions'), { recursive: true });
  fs.writeFileSync(path.join(v, '_system', 'changelog.md'), '');
  fs.writeFileSync(path.join(v, '_system', 'tools.json'), JSON.stringify({ githubOwner: 'me' }));
  return v;
}
const forge = v => listForges(v)[0];
const titleOf = c => c.args[c.args.indexOf('--title') + 1];
const cardFor = v => listCards(v).find(c => c.key === forge(v).review_key);
const press = (v, status, reason = '') => {
  const c = cardFor(v);
  fs.writeFileSync(c.file, c.text.replace(/^status: .*$/m, `status: ${status}`).replace(/^decline_reason: .*$/m, `decline_reason: ${JSON.stringify(reason)}`));
};

test('stages: outputs are checked for their sections; plans parse into ordered tickets', () => {
  assert.deepEqual(checkOutput(STAGES[0], SPEC), []);
  assert.match(checkOutput(STAGES[0], '## Problem\nx').join(), /no "Users" section/);
  assert.match(checkOutput(STAGES[2], '## Candidates\n| Name | R |\n|---|---|\n| A | b |').join(), /at least 10 candidates/);
  assert.equal(candidates(NAMING)[0], 'Tidewell');
  const { tickets, problems } = parsePlan(PLAN);
  assert.deepEqual(problems, []);
  assert.deepEqual(tickets.map(t => [t.n, t.dependsOn]), [[1, []], [3, [2]], [2, [1]]]);
  assert.match(tickets[2].criteria, /list saves/, 'bold field labels parse too');
  assert.deepEqual(topoOrder(tickets).map(t => t.n), [1, 2, 3]);
  assert.match(parsePlan(PLAN.replace('Depends on: T2', 'Depends on: T9')).problems.join(), /missing T9/);
  assert.match(parsePlan(PLAN.replace('Depends on: none', 'Depends on: T3')).problems.join(), /cycle/);
  assert.match(parsePlan(PLAN.replace('Pointers:\n- ADR 0001', '')).problems.join(), /T1 has no Pointers/);
});

test('naming: free only on a clear 404, taken on 200, "?" when a lookup fails', async () => {
  const statuses = { 'tidewell.com': 404, 'tidewell.dev': 200 };
  const fetchImpl = async url => { if (url.includes('npmjs')) throw new Error('offline'); return { status: statuses[url.split('/').pop()] ?? 500 }; };
  const run = () => 'me/tidewell';
  assert.deepEqual(await checkName('Tidewell', { fetchImpl, run, owner: 'me' }), { name: 'Tidewell', slug: 'tidewell', com: 'free', dev: 'taken', npm: '?', github: 'taken' });
  const once = await addAvailability(NAMING, { fetchImpl: fetch404, run: fakeGh([]), owner: 'me' });
  const twice = await addAvailability(once.text, { fetchImpl: fetch404, run: fakeGh([]), owner: 'me' });
  assert.equal(twice.text.match(/## Availability/g).length, 1, 'the section is replaced, not stacked');
  assert.match(twice.text, /\| Tidewell \| `tidewell` \| free \| free \| free \| free \|/);
});

test('interview forge: questions, spec stop, feedback rerun, naming stop, plan, repo, done', async () => {
  const v = vault();
  const calls = [];
  const gh = [];
  const step = m => advanceForges(v, { now: at(m), runClaude: fakeClaude(calls), run: fakeGh(gh), fetchImpl: fetch404 });
  newForge(v, 'Shared shopping lists\nFor flatmates.', { now: NOW });
  assert.deepEqual(await step(1), ['forge shared-shopping-lists: questions']);
  assert.equal(cardFor(v).action, 'forge_questions');
  assert.deepEqual(await step(2), [], 'waits while the card is pending');
  press(v, 'done');
  assert.deepEqual(await step(3), ['forge shared-shopping-lists: answered']);
  assert.deepEqual(await step(4), ['forge shared-shopping-lists: review']);
  assert.match(calls.at(-1).prompt, /spec stage of the Product Forge\. The product outline/);
  press(v, 'rejected', 'Make it offline-first.');
  await step(5);
  await step(6);
  assert.match(calls.at(-1).prompt, /asked for this change; apply it:\nMake it offline-first\./, 'feedback reaches the rerun');
  press(v, 'done');
  assert.deepEqual(await step(7), ['forge shared-shopping-lists: approved']);
  assert.deepEqual(await step(8), ['forge shared-shopping-lists: next'], 'stack has no stop-point');
  assert.deepEqual(await step(9), ['forge shared-shopping-lists: review'], 'naming stops');
  assert.equal(forge(v).name, 'Tidewell', 'the top candidate becomes the name');
  assert.match(fs.readFileSync(path.join(forge(v).dir, 'naming.md'), 'utf8'), /## Availability/);
  press(v, 'done');
  await step(10);
  assert.deepEqual(await step(11), ['forge shared-shopping-lists: repo']);
  assert.equal(cardFor(v).action, 'forge_create_repo');
  assert.equal(cardFor(v).status, 'pending', 'creating a repo is always asked');
  press(v, 'approved');
  runOnce(v, { now: at(12), ghRunner: fakeGh(gh) });
  assert.equal(cardFor(v).status, 'done', cardFor(v).text);
  assert.deepEqual(await step(13), ['forge shared-shopping-lists: done']);
  assert.equal(forge(v).repo, 'https://github.com/me/tidewell');
  const issues = gh.filter(c => c.args[0] === 'issue').map(titleOf);
  assert.deepEqual(issues, ['T1: Scaffold the repo', 'T2: Make a list', 'T3: Share a list', 'epic: Tidewell v1'], 'dependency order, epic last');
  const t3 = gh.find(c => titleOf(c) === 'T3: Share a list');
  assert.match(t3.input, /Depends on: #2/);
  assert.ok(!t3.args.includes('agent:ready'), 'tickets with dependencies wait');
  assert.ok(gh.find(c => titleOf(c) === 'T1: Scaffold the repo').args.includes('agent:ready'));
  assert.ok(gh.some(c => c.args.includes('repos/me/tidewell/contents/docs/spec.md')), 'the spec goes to docs/');
});

test('autonomous forge without stops runs straight to the repo card; bad output retries once then fails', async () => {
  const v = vault();
  newForge(v, 'Plant tracker', { mode: 'autonomous', stopAfter: [], now: NOW });
  const calls = [];
  for (let i = 1; i <= 4; i++) await advanceForges(v, { now: at(i), runClaude: fakeClaude(calls), run: fakeGh([]), fetchImpl: fetch404 });
  assert.match(calls[0].prompt, /## Assumptions/, 'autonomous specs list their assumptions');
  assert.equal(forge(v).status, 'waiting');
  assert.equal(cardFor(v).action, 'forge_create_repo');

  const w = vault();
  newForge(w, 'Broken', { mode: 'autonomous', stopAfter: [], now: NOW });
  const bad = fakeClaude([], { 'spec.md': '## Problem\nonly this' });
  assert.deepEqual(await advanceForges(w, { now: at(1), runClaude: bad }), ['forge broken: retry']);
  assert.deepEqual(await advanceForges(w, { now: at(2), runClaude: bad }), ['forge broken: failed']);
  assert.match(forge(w).text, /giving up/);
});

test('snapshot rows carry headline fields only, never the outline', () => {
  const v = vault();
  newForge(v, 'Secret idea\nwith private details', { now: NOW });
  const rows = forgeRows(v);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['mode', 'slug', 'stage', 'status', 'title', 'updated']);
  assert.doesNotMatch(JSON.stringify(rows), /private details/);
  assert.match(newForge(v, 'Secret idea', { now: NOW }).error, /already exists/);
});
