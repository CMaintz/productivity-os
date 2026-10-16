import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { advanceForges, listForges, newForge, forgeRows } from '../forge.mjs';
import { createForgeRepo } from '../repo.mjs';
import { STAGES, checkOutput, parsePlan, topoOrder, candidates } from '../stages.mjs';
import { addAvailability, checkName } from '../naming.mjs';
import { listCards } from '../../actions/cards.mjs';
import { runOnce } from '../../actions/executor.mjs';
import { NAMING, PLAN, SPEC, ADR, fakeClaude, fakeGh, fetch404 } from './fixtures.mjs';

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
  assert.deepEqual(await step(13), ['forge shared-shopping-lists: building']);
  assert.equal(forge(v).stage, 'build');
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
  assert.deepEqual(Object.keys(rows[0]).sort(), ['mode', 'progress', 'slug', 'stage', 'status', 'title', 'updated']);
  assert.doesNotMatch(JSON.stringify(rows), /private details/);
  assert.match(newForge(v, 'Secret idea', { now: NOW }).error, /already exists/);
});

/** A forge already at `stage`, with the earlier stage files in place. */
function forgeAt(stage, { stopAfter = [], files = {} } = {}) {
  const v = vault();
  newForge(v, 'Tidy flat', { mode: 'autonomous', stopAfter, now: NOW });
  const f = forge(v);
  fs.writeFileSync(f.file, f.text.replace('stage: spec', `stage: ${stage}`));
  for (const [rel, text] of Object.entries({ 'spec.md': SPEC, 'decisions/0001-stack.md': ADR, ...files })) {
    fs.mkdirSync(path.dirname(path.join(f.dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(f.dir, rel), text);
  }
  return v;
}
const go = (v, m, runClaude = fakeClaude([])) => advanceForges(v, { now: at(m), runClaude, run: fakeGh([]), fetchImpl: fetch404 });

test('the model works in a folder that excludes the state note, with no web tools for the spec', async () => {
  const v = vault();
  newForge(v, 'Plant tracker', { mode: 'autonomous', stopAfter: [], now: NOW });
  const calls = [];
  const tools = [];
  await advanceForges(v, { now: at(1), runClaude: (p, cwd, t) => { tools.push(t); return fakeClaude(calls)(p, cwd); }, run: fakeGh([]), fetchImpl: fetch404 });
  assert.equal(path.relative(path.join(v, 'Forge'), calls[0].cwd), 'plant-tracker');
  assert.ok(fs.existsSync(path.join(v, 'Forge', 'plant-tracker.md')), 'state lives next to the workspace, not in it');
  assert.match(calls[0].prompt, /Outline:\nPlant tracker/, 'the outline arrives in the prompt');
  assert.doesNotMatch(tools[0], /Web/, 'no web tools while the outline is the input');
});

test('rejecting the naming stop picks a new name, but your own rename sticks', async () => {
  const v = forgeAt('naming', { stopAfter: ['naming'] });
  await go(v, 1);
  assert.equal(forge(v).name, 'Tidewell');
  press(v, 'rejected', 'Something calmer');
  await go(v, 2);
  await go(v, 3, fakeClaude([], { 'naming.md': NAMING.replace('Tidewell', 'Stillwater') }));
  assert.equal(forge(v).name, 'Stillwater', 'the rejected name is replaced');
  fs.writeFileSync(forge(v).file, forge(v).text.replace('name: "Stillwater"', 'name: "My Pick"'));
  press(v, 'rejected', 'again');
  await go(v, 4);
  await go(v, 5);
  assert.equal(forge(v).name, 'My Pick', 'a name you typed is never overwritten');
});

test('stopping during a long stage sticks; an output not rewritten this run is not accepted', async () => {
  const v = forgeAt('stack');
  const stopMidRun = (p, cwd) => { const f = forge(v); fs.writeFileSync(f.file, f.text.replace('status: "running"', 'status: stopped').replace('status: running', 'status: stopped')); return fakeClaude([])(p, cwd); };
  await go(v, 1, stopMidRun);
  assert.equal(forge(v).status, 'stopped');
  assert.match(forge(v).text, /you stopped the forge meanwhile/);
  const w = forgeAt('stack', { files: { 'decisions/0001-stack.md': ADR } });
  assert.deepEqual(await go(w, 1, () => ({ ok: true, text: 'did nothing' })), ['forge tidy-flat: retry']);
  assert.match(forge(w).text, /wasn't written this run/);
});

test('repo creation resumes after a failure without duplicates', () => {
  const v = forgeAt('plan', { files: { 'plan.md': PLAN, 'naming.md': NAMING } });
  const f = forge(v);
  fs.writeFileSync(f.file, f.text.replace('name: ""', 'name: "Tidewell"'));
  const calls = [];
  const run = fakeGh(calls, { failOn: 'T2: Make a list' });
  const card = { params: { slug: 'tidy-flat', name: 'Tidewell', repo: 'me/tidewell' } };
  assert.throws(() => createForgeRepo(card, { vault: v, gh: run }), /502/);
  assert.equal(createForgeRepo(card, { vault: v, gh: run }).ok, true);
  const issues = calls.filter(c => c.args[0] === 'issue').map(c => c.args[c.args.indexOf('--title') + 1]);
  assert.deepEqual(issues, ['T1: Scaffold the repo', 'T2: Make a list', 'T2: Make a list', 'T3: Share a list', 'epic: Tidewell v1'], 'T1 is not created twice');
  assert.equal(calls.filter(c => c.args[0] === 'repo' && c.args[1] === 'create').length, 1, 'the repo is created once');
  assert.ok(calls.filter(c => c.args[0] === 'issue').every(c => c.args.includes('agent-feature') || c.args.includes('epic')));
  const put = calls.find(c => c.args.includes('PUT'));
  assert.ok(put.args.includes('--input') && JSON.parse(put.input).content, 'docs go over stdin');
  assert.equal(createForgeRepo({ params: { ...card.params, repo: 'me/other' } }, { vault: v, gh: run }).ok, false, 'a stale card is refused');
});

test('plan and naming parser edge cases; one broken forge never blocks the others', async () => {
  const ranked = NAMING.replace('| Name | Rationale |\n|---|---|', '| Rank | Name | Rationale |\n|---|---|---|').replace(/^\| (\w[\w ]*) \| short \|$/gm, '| 1 | $1 | short |');
  assert.equal(candidates(ranked)[0], 'Tidewell', 'the Name column, not Rank');
  assert.match(parsePlan(PLAN.replace('### T3: Share', '### T2: Share')).problems.join(), /share a number/);
  assert.equal(parsePlan(PLAN.replace('Intent: As the owner', 'Intentionally vague.\nIntent: As the owner')).tickets[0].intent.startsWith('As the owner'), true);
  const v = vault();
  newForge(v, 'Broken one', { now: NOW });
  newForge(v, 'Good one', { mode: 'autonomous', stopAfter: [], now: at(1) });
  const broken = listForges(v).find(f => f.slug === 'broken-one');
  fs.writeFileSync(broken.file, broken.text.replace(/^stop_after: .*$/m, 'stop_after: spec, naming'));
  assert.deepEqual(listForges(v).find(f => f.slug === 'broken-one').stop_after, ['spec', 'naming'], 'a comma list still works');
  const boom = (p, cwd) => { if (cwd.endsWith('broken-one')) throw new Error('kaput'); return fakeClaude([])(p, cwd); };
  assert.deepEqual(await go(v, 2, boom), ['forge broken-one: failed']);
  assert.deepEqual(await go(v, 3, boom), ['forge good-one: next'], 'the next forge still runs');
});
