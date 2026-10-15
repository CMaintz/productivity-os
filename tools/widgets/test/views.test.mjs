// Loads the built views.md code block the way Datacore's dc.require does (as an async function body) and
// renders widgets against a fake `dc`, so the Obsidian path is tested without Obsidian.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VIEWS_FILE, bundleViews } from '../build-views.mjs';
import { h, text } from './render.mjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const codeBlock = md => md.match(/```js\n([\s\S]*?)```/)[1];
const loadViews = () => new AsyncFunction(codeBlock(fs.readFileSync(VIEWS_FILE, 'utf8')))();

const page = (path, fm) => ({ $path: path, $name: path.split('/').pop().replace(/\.md$/, ''), $frontmatter: fm, value: k => fm[k] });
function fakeDc(pages) {
  const queries = [];
  return {
    queries,
    dc: {
      preact: { h },
      useState: initial => [initial, () => {}],
      useQuery: q => { queries.push(q); const folder = q.match(/path\("([^"]+)"\)/)?.[1]; return pages.filter(p => p.$path.startsWith(`${folder}/`)); },
    },
  };
}

test('views.md is up to date with the dashboard source', async () => {
  assert.equal(fs.readFileSync(VIEWS_FILE, 'utf8'), await bundleViews(), 'run: node tools/widgets/build-views.mjs');
});

test('Datacore renders a notes kanban and a snapshot-style table with the shared views', async () => {
  const { createDatacoreWidgets } = await loadViews();
  const { dc, queries } = fakeDc([
    page('Writing/a.md', { type: 'post', status: 'draft', secret: 'x' }),
    page('Writing/b.md', { type: 'post', status: 'idea' }),
    page('Writing/c.md', { type: 'post', status: 'published' }),
    page('Projects/site.md', { status: 'active', ci: 'failing', priority: 1, updated: { toISO: () => '2026-10-13T00:00:00.000Z' } }),
    page('Projects/old.md', { status: 'paused' }),
  ]);
  const { Widget, useRows } = createDatacoreWidgets(dc);
  const writing = { id: 'writing', title: 'Writing', view: 'kanban', groupBy: 'status', fields: ['status'], source: { kind: 'notes', folder: 'Writing', where: { status: { ne: 'published' } } } };
  const html = text(h(Widget, { manifest: writing }));
  assert.match(html, /draft \(1\)/);
  assert.match(html, /idea \(1\)/);
  assert.doesNotMatch(html, /published/);
  assert.deepEqual(useRows(writing).map(r => Object.keys(r).sort()), [['path', 'status', 'title'], ['path', 'status', 'title']]);
  const projects = { id: 'projects', title: 'Projects', view: 'table', fields: ['slug', 'ci'], source: { kind: 'snapshot', collection: 'projects', where: { status: 'active' } } };
  assert.match(text(h(Widget, { manifest: projects })), /site.*❌ failing/);
  assert.ok(queries.includes('@page and path("Projects")'));
});

test('cards in Obsidian render without buttons (Meta Bind on the card note does that)', async () => {
  const { createDatacoreWidgets } = await loadViews();
  const { dc } = fakeDc([page('_system/actions/x.md', { type: 'action', status: 'pending', title: 'Fix CI', reason: 'red', risk: 'medium' })]);
  const html = text(h(createDatacoreWidgets(dc).Widget, { manifest: { id: 'cards', title: 'Cards', view: 'cards', source: { kind: 'snapshot', collection: 'cards' } } }));
  assert.match(html, /red/);
  assert.doesNotMatch(html, /<button>/);
});

test('widgetView loads a manifest by id from the vault and renders it', async () => {
  const { widgetView } = await loadViews();
  const { dc } = fakeDc([page('Writing/a.md', { type: 'post', status: 'draft' })]);
  const read = [];
  dc.app = { vault: { adapter: { read: async p => { read.push(p); return JSON.stringify({ id: 'writing', title: 'W', view: 'list', fields: ['status'], source: { kind: 'notes', folder: 'Writing' } }); } } } };
  const View = await widgetView(dc, 'writing');
  assert.match(text(h(View, {})), /draft/);
  await widgetView(dc, '../../etc/passwd');
  assert.deepEqual(read, ['_system/widgets/writing.json', '_system/widgets/etcpasswd.json'], 'ids are sanitised');
});

test('code widgets are web-only: Obsidian shows a pointer instead of running their code', async () => {
  const { widgetView } = await loadViews();
  const manifest = JSON.parse(fs.readFileSync('dashboard/src/widgets/code/ci-status/widget.json', 'utf8'));
  const { dc } = fakeDc([page('Projects/site.md', { status: 'active', ci: 'failing' })]);
  dc.app = { vault: { adapter: { read: async () => JSON.stringify(manifest) } } };
  assert.match(text(h(await widgetView(dc, 'ci-status'), {})), /render on the web dashboard/);
  assert.doesNotMatch(fs.readFileSync(VIEWS_FILE, 'utf8'), /CiStatus|ci-status/, 'no widget code in the Obsidian bundle');
});
