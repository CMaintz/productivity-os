import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot } from '../snapshot.mjs';
import { loadConfig, pull, rest, syncDashboard } from '../sync.mjs';
import { createCard, listCards } from '../../actions/cards.mjs';
import { copyTemplate } from '../../vault/init.mjs';
import { fileURLToPath } from 'node:url';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'vault-template');

const NOW = new Date('2026-10-14T12:00:00Z');
const CONFIG = { url: 'https://x.supabase.co', serviceKey: 'svc', ownerId: '00000000-0000-0000-0000-000000000001' };

function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
  copyTemplate(TEMPLATE, v);
  for (const d of ['_system/actions', 'Projects', 'Inbox', 'Sessions', 'Daily']) fs.mkdirSync(path.join(v, d), { recursive: true });
  fs.writeFileSync(
    path.join(v, 'Projects', 'site.md'),
    '---\ntype: project\nstatus: active\npriority: 1\nnext: "ship editor"\nrepo: o/site\nci: failing\nopen_prs: 2\nfailing_prs: 1\nagent_blocked: 0\nupdated: 2026-10-13\n---\n# site\n\n## Tasks\n- [ ] secret task text\n',
  );
  fs.writeFileSync(path.join(v, 'Projects', 'gone.md'), '---\ntype: project\nstatus: archived\n---\n');
  fs.writeFileSync(
    path.join(v, 'Sessions', '2026-10-14-site-abc.md'),
    '---\ntype: session\nstatus: waiting\nproject: "[[Projects/site]]"\nwaiting_for: "Claude needs your permission to use Bash"\nprompts: 3\nlast_prompt: "my private prompt"\nstarted: "2026-10-14T09:00:00Z"\nupdated: "2026-10-14T11:00:00Z"\n---\n# x\n## Prompts\n- 09:00 my private prompt\n',
  );
  fs.writeFileSync(path.join(v, 'Daily', '2026-10-14.md'), '---\ntype: daily\n---\n# Tue\n\n## Top 3\n1. Fix CI\n2. Write post\n3. \n\n## Tasks\n- [ ] a\n- [x] b\n');
  fs.writeFileSync(path.join(v, 'Inbox', 'n.md'), 'x');
  createCard(v, { action: 'reminder', key: 'k1', title: 'Look at this', reason: 'because' }, NOW.toISOString());
  return v;
}

/** A tiny in-memory PostgREST: just the calls sync.mjs makes. */
function fakeSupabase(events = [], errors = []) {
  const db = { snapshot: null, events, errors, calls: [] };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    db.calls.push(`${init.method} ${u.pathname}`);
    assert.equal(init.headers.apikey, 'svc');
    const ok = body => ({ ok: true, status: body === null ? 204 : 200, json: async () => body, text: async () => '' });
    if (u.pathname.endsWith('/snapshot')) {
      db.snapshot = JSON.parse(init.body)[0];
      return ok(null);
    }
    if (u.pathname.endsWith('/widget_errors')) return ok(init.method === 'GET' ? db.errors : null);
    if (init.method === 'GET') return ok(db.events.filter(e => !e.applied_at));
    const id = Number(u.searchParams.get('id').replace('eq.', ''));
    Object.assign(
      db.events.find(e => e.id === id),
      JSON.parse(init.body),
    );
    return ok(null);
  };
  return { db, fetchImpl };
}

test('snapshot carries metadata only: no task text, prompt text or note bodies', () => {
  const s = buildSnapshot(vault(), { now: NOW, host: 'desk' });
  const rows = id => s.widgets[id].rows;
  assert.deepEqual(rows('today')[0].top3, ['Fix CI', 'Write post']);
  assert.equal(rows('today')[0].openTasks, 1);
  assert.deepEqual(s.counts, { pendingCards: 1, waitingSessions: 1, attention: 1, activeProjects: 1, inbox: 1 });
  assert.deepEqual(
    rows('projects').map(p => p.slug),
    ['site'],
    'archived projects are left out',
  );
  assert.equal(rows('projects')[0].next, 'ship editor');
  assert.equal(rows('sessions')[0].project, 'site');
  assert.equal(rows('cards')[0].title, 'Look at this');
  assert.equal(rows('cards')[0].file, '_system/actions/2026-10-14-look-at-this.md');
  const json = JSON.stringify(s);
  assert.doesNotMatch(json, /secret task text|my private prompt/);
});

test('pull applies presses the card is waiting on, ignores stale ones, marks every event', async () => {
  const v = vault();
  const file = '_system/actions/2026-10-14-look-at-this.md';
  const { db, fetchImpl } = fakeSupabase([
    { id: 1, card_file: file, card_key: 'k1', status: 'rejected', always: false, never: true, reason: 'not useful' },
    { id: 2, card_file: file, card_key: 'k1', status: 'approved', always: false, never: false, reason: '' },
    { id: 3, card_file: '_system/actions/nope.md', card_key: 'x', status: 'approved', always: false, never: false, reason: '' },
  ]);
  const out = await pull(v, CONFIG, rest(CONFIG, fetchImpl), NOW);
  assert.deepEqual(
    out.map(o => o.outcome),
    ['applied', 'ignored: card is rejected', 'card not found'],
  );
  const c = listCards(v)[0];
  assert.equal(c.status, 'rejected');
  assert.equal(c.never, true);
  assert.equal(c.decline_reason, 'not useful');
  assert.ok(db.events.every(e => e.applied_at));
});

test('a press on a snoozed card clears the snooze bookkeeping so the executor records the decision', async () => {
  const v = vault();
  const file = '_system/actions/2026-10-14-look-at-this.md';
  const card = listCards(v)[0];
  fs.writeFileSync(card.file, card.text.replace('status: pending', 'status: snoozed').replace('decided_at: ""', 'decided_at: "2026-10-14T10:00:00Z"'));
  const { fetchImpl } = fakeSupabase([{ id: 1, card_file: file, card_key: 'k1', status: 'rejected', always: false, never: true, reason: '' }]);
  await pull(v, CONFIG, rest(CONFIG, fetchImpl), NOW);
  const c = listCards(v)[0];
  assert.equal(c.status, 'rejected');
  assert.equal(c.decided_at, '');
  const { runOnce } = await import('../../actions/executor.mjs');
  runOnce(v, { now: NOW });
  assert.match(fs.readFileSync(path.join(v, '_system', 'policy.md'), 'utf8'), /- `k1`/, 'never reaches the never list');
});

test('card results never leave the PC, only their outcome', () => {
  const v = vault();
  const card = listCards(v)[0];
  fs.writeFileSync(card.file, `${card.text}**Done (2026-10-14 13:00):** quoted a private note here\n`);
  const s = buildSnapshot(v, { now: NOW });
  assert.equal(s.widgets.cards.rows[0].result, 'Done (2026-10-14 13:00)');
  assert.doesNotMatch(JSON.stringify(s), /private note/);
});

test('a broken dashboard.json is ignored, not fatal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  fs.writeFileSync(path.join(dir, 'dashboard.json'), '{ not json');
  assert.equal(loadConfig(path.join(dir, 'dashboard.json')), null);
});

test('syncDashboard pushes the snapshot for the owner and never throws', async () => {
  const v = vault();
  const { db, fetchImpl } = fakeSupabase();
  const r = await syncDashboard(v, { config: CONFIG, fetchImpl, now: NOW });
  assert.deepEqual(r, { applied: [], disabled: [] });
  assert.ok(db.calls.includes('DELETE /rest/v1/widget_errors'), 'old crash reports are pruned');
  assert.equal(db.snapshot.owner_id, CONFIG.ownerId);
  assert.equal(db.snapshot.data.counts.pendingCards, 1);
  assert.equal(db.snapshot.data.version, 2);
  const broken = await syncDashboard(v, { config: CONFIG, fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }), now: NOW });
  assert.match(broken.error, /500 boom/);
  assert.deepEqual(await syncDashboard(v, { config: null }), { skipped: 'not configured' });
});

test('syncDashboard switches off a widget the dashboard keeps reporting crashes for', async () => {
  const v = vault();
  fs.mkdirSync(path.join(v, '_system', 'layouts'), { recursive: true });
  fs.writeFileSync(path.join(v, '_system', 'layouts', 'dashboard.json'), JSON.stringify({ widgets: [{ id: 'projects' }] }));
  const crash = { widget_id: 'projects', message: 'boom', created_at: '2026-10-14T11:00:00Z' };
  const { fetchImpl, db } = fakeSupabase([], [crash, crash, crash]);
  assert.deepEqual((await syncDashboard(v, { config: CONFIG, fetchImpl, now: NOW })).disabled, ['projects']);
  assert.deepEqual(db.snapshot.data.layout, [{ id: 'projects', disabled: true }], 'the published layout tells the Board to skip it');
});
