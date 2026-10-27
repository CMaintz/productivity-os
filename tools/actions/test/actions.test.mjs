import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePolicy, renderPolicy, applyDecision, levelFor, promote } from '../policy.mjs';
import { suggestions } from '../rules.mjs';
import { createCard, listCards, renderCard } from '../cards.mjs';
import { runOnce, withLock, onMainHost } from '../executor.mjs';
import { suggestAll } from '../suggest.mjs';
import { fieldsOf, setFrontmatter } from '../../lib/frontmatter.mjs';

const NOW = new Date('2026-10-14T12:00:00Z');
const later = h => new Date(NOW.valueOf() + h * 36e5);

function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'act-'));
  for (const d of ['_system/actions', 'Projects', 'Inbox']) fs.mkdirSync(path.join(v, d), { recursive: true });
  fs.writeFileSync(path.join(v, '_system', 'changelog.md'), '# log\n');
  return v;
}
const project = (v, slug, fm) =>
  fs.writeFileSync(
    path.join(v, 'Projects', `${slug}.md`),
    `---\ntype: project\n${Object.entries(fm)
      .map(([k, x]) => `${k}: ${x}`)
      .join('\n')}\n---\n# ${slug}\n`,
  );
const setStatus = (file, fields) =>
  fs.writeFileSync(
    file,
    Object.entries(fields).reduce((t, [k, x]) => setFrontmatter(t, k, x), fs.readFileSync(file, 'utf8')),
  );
const card = v => listCards(v)[0];
const fakeClaude = calls => (prompt, cwd, tools) => {
  calls.push({ prompt, cwd, tools });
  return { ok: true, text: 'Fixed it. PR: https://github.com/o/r/pull/9', sessionId: 'sess-1' };
};

test('policy: parses old and new tables, round-trips, and keeps never list', () => {
  const old = parsePolicy('| action | level | promote after | approvals in a row |\n|---|---|---|---|\n| triage_inbox | auto-notice | — | 0 |\n| file_note | suggest | 5 | 2 |');
  assert.equal(old.rows.get('file_note').streak, 2);
  assert.equal(old.rows.get('fix_ci').level, 'suggest');
  const p = { ...old, never: ['pause:x:2026-01-01'] };
  const again = parsePolicy(renderPolicy(p));
  assert.deepEqual([...again.rows.keys()].sort(), [...p.rows.keys()].sort());
  assert.deepEqual(again.never, ['pause:x:2026-01-01']);
});

test('policy: streak earns a promotion within max; reject demotes; always jumps; never is remembered', () => {
  let p = parsePolicy('');
  let promoted = null;
  for (let i = 0; i < 5; i++) ({ policy: p, promote: promoted } = applyDecision(p, { action: 'pause_stale_project', kind: 'approved' }));
  assert.deepEqual(promoted, { action: 'pause_stale_project', to: 'auto-notice' });
  p = promote(p, 'pause_stale_project', 'auto-notice');
  for (let i = 0; i < 5; i++) ({ policy: p, promote: promoted } = applyDecision(p, { action: 'pause_stale_project', kind: 'approved' }));
  assert.equal(promoted, null, 'never proposed past its max, however long the streak');
  p = applyDecision(p, { action: 'fix_ci', kind: 'approved', always: true }).policy;
  assert.equal(levelFor(p, 'fix_ci'), 'auto-notice');
  p = applyDecision(p, { action: 'fix_ci', kind: 'undone' }).policy;
  assert.equal(levelFor(p, 'fix_ci'), 'suggest');
  p = applyDecision(p, { action: 'claude_task', kind: 'approved', always: true }).policy;
  assert.equal(levelFor(p, 'claude_task'), 'suggest', 'max caps "always"');
  p = applyDecision(p, { action: 'reminder', kind: 'rejected', never: true, key: 'blocked:o/r:1' }).policy;
  assert.deepEqual(p.never, ['blocked:o/r:1']);
});

test('rules: failing CI, stale project, blocked tickets, full inbox', () => {
  const specs = suggestions(
    {
      projects: [
        { slug: 'site', repo: 'o/site', path: '/p/site', status: 'active', updated: '2026-10-13', ci: 'failing', agent_blocked: 1 },
        { slug: 'old', status: 'active', updated: '2026-08-01' },
        { slug: 'paused', status: 'paused', updated: '2025-01-01', ci: 'failing' },
      ],
      inboxCount: 6,
    },
    NOW,
  );
  assert.deepEqual(
    specs.map(s => s.action),
    ['fix_ci', 'reminder', 'pause_stale_project', 'triage_inbox'],
  );
  assert.match(specs[0].params.prompt, /Never push to main/);
});

test('cards: buttons only change fields; dedupe by key; never list blocks; policy level auto-approves', () => {
  const md = renderCard({ action: 'reminder', key: 'k', title: 'T', reason: 'R' }, { now: NOW.toISOString() });
  assert.match(md, /```meta-bind-button[\s\S]*type: updateMetadata[\s\S]*bindTarget: status[\s\S]*value: approved/);
  assert.match(md, /`BUTTON\[do-it, not-now, no\]`/);
  assert.doesNotMatch(md, /type: command|type: js/);
  const v = vault();
  const spec = { action: 'triage_inbox', key: 'triage:1', title: 'Triage', reason: 'r', params: { prompt: 'p' } };
  assert.ok(createCard(v, spec, NOW.toISOString()));
  assert.equal(createCard(v, spec, NOW.toISOString()), null);
  const c = card(v);
  assert.equal(c.status, 'approved', 'triage_inbox defaults to auto-notice');
  assert.equal(c.decided_by, 'policy');
  fs.writeFileSync(path.join(v, '_system', 'policy.md'), renderPolicy({ ...parsePolicy(''), never: ['reminder'] }));
  assert.equal(createCard(v, { action: 'reminder', key: 'x', title: 'X', reason: 'r' }, NOW.toISOString()), null);
});

test('executor: approve runs the handler, records the decision, writes the result', () => {
  const v = vault();
  project(v, 'site', { status: 'active', repo: 'o/site', path: JSON.stringify(v), ci: 'failing', updated: '2026-10-13' });
  suggestAll(v, NOW);
  const c = card(v);
  assert.equal(c.status, 'pending');
  const calls = [];
  runOnce(v, { now: NOW, runner: fakeClaude(calls) });
  assert.equal(calls.length, 0, 'nothing runs before approval');
  setStatus(c.file, { status: 'approved' });
  runOnce(v, { now: later(1), runner: fakeClaude(calls) });
  assert.equal(calls.length, 1);
  assert.match(calls[0].tools, /Bash\(git:\*\)/);
  const done = card(v);
  assert.equal(done.status, 'done');
  assert.equal(done.session_id, 'sess-1');
  assert.equal(done.decided_by, 'you');
  assert.match(done.text, /\*\*Done \(2026-10-14 13:00\):\*\* Fixed it/);
  assert.match(fs.readFileSync(path.join(v, '_system', 'policy.md'), 'utf8'), /\| fix_ci \| suggest \| auto-notice \| 10 \| 1 \|/);
  assert.match(fs.readFileSync(path.join(v, '_system', 'actions', 'ledger.jsonl'), 'utf8'), /"kind":"approved"/);
  runOnce(v, { now: later(2), runner: fakeClaude(calls) });
  assert.equal(calls.length, 1, 'runs exactly once');
});

test('executor: pause card, then Undo restores the field and demotes; reject records reason', () => {
  const v = vault();
  project(v, 'old', { status: 'active', updated: '2026-08-01' });
  suggestAll(v, NOW);
  const c = card(v);
  setStatus(c.file, { status: 'approved' });
  runOnce(v, { now: NOW });
  assert.match(fs.readFileSync(path.join(v, 'Projects', 'old.md'), 'utf8'), /^status: paused$/m);
  assert.deepEqual(card(v).undo, { file: 'Projects/old.md', key: 'status', value: 'active' });
  setStatus(c.file, { status: 'undone' });
  runOnce(v, { now: later(1) });
  assert.match(fs.readFileSync(path.join(v, 'Projects', 'old.md'), 'utf8'), /^status: active$/m);
  assert.match(card(v).text, /\*\*Undo .*Restored `status: active`/);
  assert.match(fs.readFileSync(path.join(v, '_system', 'changelog.md'), 'utf8'), /executor undo pause_stale_project/);
});

test('executor: snooze returns after a day, pending cards expire, promotions become cards', () => {
  const v = vault();
  createCard(v, { action: 'reminder', key: 's', title: 'Snooze me', reason: 'r' }, NOW.toISOString());
  const c = card(v);
  setStatus(c.file, { status: 'snoozed' });
  runOnce(v, { now: NOW });
  runOnce(v, { now: later(25) });
  assert.equal(card(v).status, 'pending');
  runOnce(v, { now: later(24 * 9) });
  assert.equal(card(v).status, 'expired');
  let p = parsePolicy('');
  for (let i = 0; i < 4; i++) p = applyDecision(p, { action: 'pause_stale_project', kind: 'approved' }).policy;
  fs.writeFileSync(path.join(v, '_system', 'policy.md'), renderPolicy(p));
  project(v, 'old', { status: 'active', updated: '2026-08-01' });
  suggestAll(v, NOW);
  setStatus(listCards(v).find(x => x.action === 'pause_stale_project').file, { status: 'approved' });
  runOnce(v, { now: NOW });
  const promo = listCards(v).find(x => x.action === 'promote_policy');
  assert.equal(promo.key, 'promote:pause_stale_project:auto-notice');
  setStatus(promo.file, { status: 'approved' });
  runOnce(v, { now: later(1) });
  assert.equal(levelFor(parsePolicy(fs.readFileSync(path.join(v, '_system', 'policy.md'), 'utf8')), 'pause_stale_project'), 'auto-notice');
});

test('executor: a card stuck in running is marked failed after two hours', () => {
  const v = vault();
  createCard(v, { action: 'reminder', key: 'r', title: 'Stuck', reason: 'r' }, NOW.toISOString());
  setStatus(card(v).file, { status: 'running', decided_at: JSON.stringify(NOW.toISOString()) });
  runOnce(v, { now: later(3) });
  assert.equal(card(v).status, 'failed');
  assert.match(card(v).text, /interrupted/);
});

test('executor: a policy-approved card is held when its type is still at suggest', () => {
  const v = vault();
  createCard(v, { action: 'claude_task', key: 'c', title: 'Sneaky', reason: 'r', params: { cwd: v, prompt: 'p' } }, NOW.toISOString());
  setStatus(card(v).file, { status: 'approved', decided_by: 'policy', decided_at: JSON.stringify(NOW.toISOString()) });
  const calls = [];
  runOnce(v, { now: NOW, runner: fakeClaude(calls) });
  assert.equal(calls.length, 0);
  assert.equal(card(v).status, 'pending');
  assert.match(card(v).text, /\*\*Held/);
});

test('guards: lock blocks a second run; main host check', async () => {
  const v = vault();
  fs.writeFileSync(path.join(v, '_system', 'executor.lock'), JSON.stringify({ pid: 1, host: 'h', at: NOW.toISOString() }));
  assert.match((await withLock(v, () => 'ran', later(0.1))).skipped, /locked by pid 1/);
  assert.equal((await withLock(v, async () => 'ran', later(2))).result, 'ran', 'stale lock is taken over');
  fs.writeFileSync(path.join(v, '_system', 'tools.json'), JSON.stringify({ mainHost: 'desk' }));
  assert.equal(onMainHost(v, 'desk'), true);
  assert.equal(onMainHost(v, 'laptop'), false);
  assert.ok(fieldsOf('---\na: {"x":1}\n---\n').a.x === 1);
});
