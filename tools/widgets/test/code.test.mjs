// Code widgets: every folder under dashboard/src/widgets/code renders its fixture, shows what the
// fixture says it should, and states exactly the data it reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { CODE_DIR, RENDERERS_FILE, codeWidgetIds, generatedFiles } from '../code-registry.mjs';
import { fieldsUsed, validateManifest } from '../manifest.mjs';
import { h, text } from './render.mjs';

async function loadRenderers() {
  const out = await build({ entryPoints: [RENDERERS_FILE], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

const readJson = (id, f) => JSON.parse(fs.readFileSync(path.join(CODE_DIR, id, f), 'utf8'));
const ROW_META = ['title', 'path', 'slug'];

test('the generated catalog and renderers are up to date with the code widget folders', () => {
  for (const [file, text] of generatedFiles()) assert.equal(fs.readFileSync(file, 'utf8'), text, 'run: node tools/widgets/code-registry.mjs');
});

for (const id of codeWidgetIds()) {
  test(`code widget ${id}: valid manifest, fixture within its permissions, renders what it promises`, async () => {
    const manifest = readJson(id, 'widget.json');
    const fixture = readJson(id, 'fixture.json');
    assert.equal(manifest.id, id, 'the folder name is the widget id');
    assert.equal(manifest.view, `code:${id}`);
    assert.deepEqual(validateManifest(manifest, { codeIds: codeWidgetIds() }), []);
    for (const row of fixture.rows) for (const k of Object.keys(row)) assert.ok([...fieldsUsed(manifest), ...ROW_META].includes(k), `fixture field "${k}" isn't in permissions`);
    const { codeRenderers } = await loadRenderers();
    const View = codeRenderers[id]({ h, useState: v => [v, () => {}] });
    const html = text(h(View, { m: manifest, rows: fixture.rows, ctx: { now: Date.parse('2026-10-14T12:00:00Z') } }));
    for (const s of fixture.expect ?? []) assert.ok(html.includes(s), `renders "${s}"`);
    assert.ok(text(h(View, { m: manifest, rows: [], ctx: { now: 0 } })).length > 0, 'renders an empty state');
  });
}

test('validateManifest: code views need exact permissions and no connectors', () => {
  const base = { id: 'x', title: 'X', view: 'code:x', source: { kind: 'snapshot', collection: 'projects', where: { status: 'active' } }, fields: ['ci'] };
  const ok = { ...base, permissions: { collections: ['projects'], fields: ['ci', 'status'], connectors: [] } };
  assert.deepEqual(validateManifest(ok), []);
  assert.match(validateManifest(base).join(), /permissions block/);
  assert.match(validateManifest({ ...ok, permissions: { ...ok.permissions, fields: ['ci'] } }).join(), /exactly the fields/, 'a filtered field must be declared');
  assert.match(validateManifest({ ...ok, permissions: { ...ok.permissions, connectors: ['outlook'] } }).join(), /connectors/);
  assert.match(validateManifest({ ...ok, permissions: { ...ok.permissions, collections: ['sessions'] } }).join(), /collections must match/);
  assert.match(validateManifest({ ...ok, source: { kind: 'snapshot', collection: 'today' }, fields: [], permissions: { collections: ['today'], fields: [], connectors: [] } }).join(), /may only read/);
  const notes = { ...ok, source: { kind: 'notes', folder: 'Journal' }, permissions: { collections: [], folders: ['Journal'], fields: ['ci'], connectors: [] } };
  assert.match(validateManifest(notes).join(), /may only read the snapshot collections/, 'no notes folders for code widgets');
  assert.match(validateManifest(ok, { codeIds: ['other'] }).join(), /no code widget "x"/);
  assert.match(validateManifest({ ...ok, view: 'code:../x' }).join(), /view must be/);
});
