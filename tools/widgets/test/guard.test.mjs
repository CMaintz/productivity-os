import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkChange } from '../guard.mjs';

const DIR = 'dashboard/src/widgets/code/ci';
const manifest = (fields = ['ci', 'status'], extra = {}) => JSON.stringify({
  id: 'ci', title: 'CI', view: 'code:ci', fields: ['ci'],
  source: { kind: 'snapshot', collection: 'projects', where: { status: 'active' } },
  permissions: { collections: ['projects'], fields, connectors: [] }, ...extra,
});

/** A PR: `base` and `head` map paths to file text; `changed` defaults to every path that differs. */
const CATALOG = 'dashboard/src/widgets/code/catalog.ts';
const RENDERERS = 'dashboard/src/widgets/code/renderers.ts';

function pr({ base = {}, head = {}, changed, codeIds = ['ci'], expected = [[CATALOG, head[CATALOG] ?? null], [RENDERERS, head[RENDERERS] ?? null]] }) {
  const paths = changed ?? [...new Set([...Object.keys(base), ...Object.keys(head)])].filter(p => base[p] !== head[p]);
  return checkChange({ changed: paths, readBase: p => base[p] ?? null, readHead: p => head[p] ?? null, codeIds, expected });
}

const newWidget = { [`${DIR}/widget.json`]: manifest(), [`${DIR}/widget.ts`]: 'x', [`${DIR}/fixture.json`]: '{}', [CATALOG]: 'c', [RENDERERS]: 'r' };

test('a new widget inside its folder, with generated files, may merge itself', () => {
  const r = pr({ head: newWidget });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.ids, ['ci']);
});

test('touching anything outside the code widget folders needs review', () => {
  const r = pr({ head: { ...newWidget, 'dashboard/src/lib/data.ts': 'fetch(evil)', '.github/workflows/x.yml': 'x', [`${DIR}/helper.js`]: 'fetch(evil)', 'vault-template/_system/widgets/views.md': 'v' } });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /dashboard\/src\/lib\/data.ts, outside/);
  assert.match(r.problems.join('\n'), /workflows\/x.yml, outside/);
  assert.match(r.problems.join('\n'), /ci\/helper.js, outside/, 'only .ts and .json inside a widget folder');
  assert.match(r.problems.join('\n'), /views.md, outside/, 'the Obsidian bundle never changes with a widget');
});

test('a widget that reads more than its base version needs review', () => {
  const base = { [`${DIR}/widget.json`]: manifest() };
  const wider = manifest(['ci', 'status', 'next'], { fields: ['ci', 'next'] });
  const r = pr({ base, head: { [`${DIR}/widget.json`]: wider } });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /widens its permissions \(fields:next\)/);
  assert.equal(pr({ base, head: { [`${DIR}/widget.json`]: manifest(), [`${DIR}/widget.ts`]: 'y' }, changed: [`${DIR}/widget.ts`] }).ok, true, 'a code-only change is fine');
  const unfiltered = manifest(['ci'], { source: { kind: 'snapshot', collection: 'projects' } });
  assert.match(pr({ base, head: { [`${DIR}/widget.json`]: unfiltered } }).problems.join(), /changes which rows it gets/, 'dropping a filter is widening too');
});

test('a widget may not borrow another renderer, and generated files must be exactly generated', () => {
  assert.match(pr({ head: { [`${DIR}/widget.json`]: manifest(undefined, { view: 'code:ci-status' }) } }).problems.join(), /view must be "code:ci"/);
  const tampered = pr({ head: newWidget, expected: [[CATALOG, 'c'], [RENDERERS, 'what the generator writes']] });
  assert.match(tampered.problems.join(), /renderers.ts isn't what tools\/widgets\/code-registry.mjs generates/);
  assert.match(pr({ head: newWidget, expected: [] }).problems.join(), /catalog.ts isn't what/, 'unchecked generated files never pass');
});

test('manifests must be valid: exact permissions, no private fields, no connectors', () => {
  const undeclared = pr({ head: { [`${DIR}/widget.json`]: manifest(['ci']) } });
  assert.match(undeclared.problems.join(), /exactly the fields/);
  const connector = pr({ head: { [`${DIR}/widget.json`]: JSON.stringify({ ...JSON.parse(manifest()), permissions: { collections: ['projects'], fields: ['ci', 'status'], connectors: ['outlook'] } }) } });
  assert.match(connector.problems.join(), /connectors/);
  const secret = manifest(['ci', 'status', 'last_prompt'], { fields: ['ci', 'last_prompt'] });
  assert.match(pr({ head: { [`${DIR}/widget.json`]: secret } }).problems.join(), /private/);
  assert.match(pr({ head: { [`${DIR}/widget.json`]: manifest(undefined, { id: 'other' }) } }).problems.join(), /doesn't match its folder/);
  assert.match(pr({ head: { [`${DIR}/widget.json`]: '{nope' } }).problems.join(), /isn't valid JSON/);
});

test('half a widget, or a PR with no widget at all, needs review', () => {
  assert.match(pr({ head: { [`${DIR}/widget.ts`]: 'x' }, codeIds: [] }).problems.join(), /needs widget.ts, widget.json and fixture.json/);
  assert.match(pr({ head: { [CATALOG]: 'c' } }).problems.join(), /changes no code widget/);
});

test('removing a widget (an Undo revert) may merge itself', () => {
  const r = pr({ base: newWidget, head: { [CATALOG]: 'c2', [RENDERERS]: 'r2' }, codeIds: [] });
  assert.deepEqual(r.problems, []);
});
