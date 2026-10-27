import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runQuery, matches } from '../query.mjs';
import { validateManifest } from '../manifest.mjs';
import { loadWidgets, proposeWidget } from '../widgets.mjs';
import { buildSnapshot } from '../../dashboard/snapshot.mjs';
import { runOnce } from '../../actions/executor.mjs';
import { listCards } from '../../actions/cards.mjs';
import { copyTemplate } from '../../vault/init.mjs';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'vault-template');
const NOW = new Date('2026-10-14T12:00:00Z');

function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'wid-'));
  copyTemplate(TEMPLATE, v);
  fs.writeFileSync(path.join(v, 'Projects', 'site.md'), '---\ntype: project\nstatus: active\npriority: 1\nci: failing\nnext: "fix ci"\n---\n# site\n- [ ] secret checklist\n');
  fs.writeFileSync(path.join(v, 'Projects', 'old.md'), '---\ntype: project\nstatus: paused\n---\n');
  fs.writeFileSync(path.join(v, 'Writing', 'post-a.md'), '---\ntype: post\nstatus: draft\npublish_date: 2026-11-01\nsecret_field: hidden\n---\n# Post A\n\nPrivate draft body text.\n');
  fs.writeFileSync(path.join(v, 'Writing', 'post-b.md'), '---\ntype: post\nstatus: published\n---\n# Post B\n');
  return v;
}

test('query: where (incl. $or and operators), nulls-last sort, limit, field pick', () => {
  const rows = [
    { a: 1, s: 'x', t: ['k'] },
    { a: 3, s: 'y' },
    { a: null, s: 'x' },
    { a: 2, s: 'z' },
  ];
  assert.deepEqual(
    runQuery(rows, { sort: [{ field: 'a', dir: 'desc' }] }).map(r => r.a),
    [3, 2, 1, null],
  );
  assert.deepEqual(
    runQuery(rows, { where: { $or: [{ s: 'y' }, { a: { lt: 2 } }] } }).map(r => r.a),
    [1, 3],
  );
  assert.equal(matches({ t: ['k'] }, { t: { contains: 'k' } }), true);
  assert.equal(matches({ a: '' }, { a: { exists: false } }), true);
  assert.deepEqual(runQuery(rows, { limit: 1 }, ['a']), [{ a: 1 }]);
});

test('manifest validation catches bad shapes, unsafe folders and private fields', () => {
  const ok = { id: 'w', title: 'W', view: 'table', fields: ['status'], source: { kind: 'notes', folder: 'Writing' } };
  assert.deepEqual(validateManifest(ok), []);
  const bad = validateManifest({
    id: 'Bad Id',
    title: '',
    view: 'pie',
    size: 'xl',
    fields: ['last_prompt'],
    source: { kind: 'notes', folder: '../etc', where: { status: { like: 'x' } }, limit: 500 },
  });
  for (const msg of ['id must', 'title must', 'view must', 'size must', 'private', 'folder', 'unknown operator', 'limit'])
    assert.ok(
      bad.some(e => e.includes(msg)),
      msg,
    );
  assert.ok(validateManifest({ ...ok, view: 'kanban' }).some(e => e.includes('groupBy')));
  assert.ok(validateManifest({ ...ok, fields: undefined }).some(e => e.includes('must list the fields')));
});

test('snapshot v2 renders the default layout from widgets and leaks nothing beyond whitelisted fields', () => {
  const s = buildSnapshot(vault(), { now: NOW, host: 'desk' });
  assert.equal(s.version, 2);
  assert.deepEqual(
    s.layout.map(w => w.id),
    ['today', 'attention', 'cards', 'sessions', 'forges', 'writing', 'projects'],
  );
  for (const id of Object.keys(s.widgets)) assert.equal(s.widgets[id].error, undefined, `${id}: ${s.widgets[id].error}`);
  assert.deepEqual(
    s.widgets.attention.rows.map(r => r.slug),
    ['site'],
  );
  assert.deepEqual(
    s.widgets.projects.rows.map(r => r.slug),
    ['site'],
  );
  assert.deepEqual(s.widgets.writing.rows, [{ title: 'Post A', path: 'Writing/post-a.md', status: 'draft', publish_date: '2026-11-01' }]);
  assert.doesNotMatch(JSON.stringify(s), /secret checklist|Private draft body|secret_field|hidden/);
});

test('broken or missing widgets degrade to an error tile instead of breaking the snapshot', () => {
  const v = vault();
  fs.writeFileSync(path.join(v, '_system', 'widgets', 'writing.json'), '{ nope');
  fs.writeFileSync(path.join(v, '_system', 'layouts', 'dashboard.json'), JSON.stringify({ widgets: [{ id: 'writing' }, { id: 'ghost' }, { id: 'today' }] }));
  const { widgets } = loadWidgets(v, { today: [{ date: 'x', top3: [], openTasks: 0 }] });
  assert.match(widgets.writing.error, /invalid JSON/);
  assert.match(widgets.ghost.error, /no widget "ghost"/);
  assert.equal(widgets.today.error, undefined);
});

test('create_widget: proposed as a card, approval writes file + layout, Undo removes both', () => {
  const v = vault();
  assert.ok(proposeWidget(v, { id: 'bad', title: 'x', view: 'nope', source: {} }).errors.length);
  const m = { id: 'ideas', title: 'Ideas', view: 'list', fields: ['status'], source: { kind: 'notes', folder: 'Writing', where: { status: 'idea' } } };
  const { file } = proposeWidget(v, m, NOW.toISOString());
  const card = () => listCards(v).find(c => c.file === file);
  assert.equal(card().status, 'pending');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: pending', 'status: approved'));
  runOnce(v, { now: NOW });
  assert.equal(card().status, 'done');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(v, '_system', 'widgets', 'ideas.json'), 'utf8')), m);
  assert.ok(JSON.parse(fs.readFileSync(path.join(v, '_system', 'layouts', 'dashboard.json'), 'utf8')).widgets.some(w => w.id === 'ideas'));
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/status: "?done"?/, 'status: undone'));
  runOnce(v, { now: NOW });
  assert.equal(fs.existsSync(path.join(v, '_system', 'widgets', 'ideas.json')), false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(v, '_system', 'layouts', 'dashboard.json'), 'utf8')).widgets.some(w => w.id === 'ideas'),
    false,
  );
});

test('a tampered create_widget card cannot write outside the widgets folder', () => {
  const v = vault();
  const { file } = proposeWidget(v, { id: 'ok-one', title: 'x', view: 'list', fields: ['status'], source: { kind: 'notes', folder: 'Writing' } }, NOW.toISOString());
  const text = fs.readFileSync(file, 'utf8').replace('"id":"ok-one"', '"id":"../../evil"').replace('status: pending', 'status: approved');
  fs.writeFileSync(file, text);
  runOnce(v, { now: NOW });
  assert.equal(listCards(v).find(c => c.file === file).status, 'failed');
  assert.equal(fs.existsSync(path.join(v, 'evil.json')), false);
});

test('the dashboard demo snapshot is up to date with the pipeline', async () => {
  const { DEMO_FILE, demoJson } = await import('../demo.mjs');
  assert.equal(fs.readFileSync(DEMO_FILE, 'utf8'), demoJson(), 'run: node tools/widgets/demo.mjs');
});

test('manifests reject wrong operator types and private where/sort fields and folders; one bad widget stays isolated; undo stays in the widgets folder', () => {
  const base = { id: 'w', title: 'W', view: 'list', fields: ['status'], source: { kind: 'notes', folder: 'Writing' } };
  const errs = src => validateManifest({ ...base, source: { ...base.source, ...src } });
  assert.ok(errs({ where: { status: { in: 5 } } }).some(e => e.includes('wrong value type')));
  assert.ok(errs({ where: { status: { exists: 'yes' } } }).some(e => e.includes('wrong value type')));
  assert.ok(errs({ where: { status: { a: 1 } } }).some(e => e.includes('unknown operator')));
  assert.ok(errs({ where: { last_prompt: { contains: 'password' } } }).some(e => e.includes("private and can't be queried")));
  assert.ok(errs({ sort: [{ field: 'cwd' }] }).some(e => e.includes('private')));
  for (const folder of ['Sessions', '_system/actions', '.', 'Writing/../_system', 'C:/x']) assert.ok(errs({ folder }).length, folder);
  assert.deepEqual(errs({ folder: 'Writing/Drafts' }), []);

  const v = vault();
  const w = (id, m) => fs.writeFileSync(path.join(v, '_system', 'widgets', `${id}.json`), JSON.stringify(m));
  w('dup-a', { ...base, id: 'dup' });
  w('dup-b', { ...base, id: 'dup' });
  w('k', { id: 'k', title: 'K', view: 'kanban', groupBy: 'status', fields: ['next'], source: { kind: 'snapshot', collection: 'projects' } });
  fs.writeFileSync(path.join(v, '_system', 'layouts', 'dashboard.json'), JSON.stringify({ widgets: [{ id: 'dup' }, { id: 'k', size: 's' }, { id: 'today', size: 'huge' }] }));
  const s = buildSnapshot(v, { now: NOW });
  assert.match(s.widgets.dup.error, /two widget files use the id "dup"/);
  assert.equal(s.widgets.k.rows.find(r => r.title === 'site').status, 'active', 'groupBy field kept for snapshot sources');
  assert.deepEqual(s.layout, [{ id: 'dup' }, { id: 'k', size: 's' }, { id: 'today' }]);

  const victim = path.join(v, 'keep.json');
  fs.writeFileSync(victim, '{}');
  const { file } = proposeWidget(v, { ...base, id: 'ok-two' }, NOW.toISOString());
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: pending', 'status: approved'));
  runOnce(v, { now: NOW });
  const done = fs
    .readFileSync(file, 'utf8')
    .replace(/status: "?done"?/, 'status: undone')
    .replace('"removeWidget":"ok-two"', '"removeWidget":"../../keep"');
  fs.writeFileSync(file, done);
  runOnce(v, { now: NOW });
  assert.ok(fs.existsSync(victim), 'a tampered undo cannot delete outside the widgets folder');
  assert.match(fs.readFileSync(file, 'utf8'), /Refused/);
});
