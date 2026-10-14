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
function pr({ base = {}, head = {}, changed, codeIds = ['ci'] }) {
  const paths = changed ?? [...new Set([...Object.keys(base), ...Object.keys(head)])].filter(p => base[p] !== head[p]);
  return checkChange({ changed: paths, readBase: p => base[p] ?? null, readHead: p => head[p] ?? null, codeIds });
}

const newWidget = { [`${DIR}/widget.json`]: manifest(), [`${DIR}/widget.ts`]: 'x', [`${DIR}/fixture.json`]: '{}', 'dashboard/src/widgets/code/registry.ts': 'r', 'vault-template/_system/widgets/views.md': 'v' };

test('a new widget inside its folder, with generated files, may merge itself', () => {
  const r = pr({ head: newWidget });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.ids, ['ci']);
});

test('touching anything outside the code widget folders needs review', () => {
  const r = pr({ head: { ...newWidget, 'dashboard/src/lib/data.ts': 'fetch(evil)', '.github/workflows/x.yml': 'x', [`${DIR}/helper.js`]: 'fetch(evil)' } });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /dashboard\/src\/lib\/data.ts, outside/);
  assert.match(r.problems.join('\n'), /workflows\/x.yml, outside/);
  assert.match(r.problems.join('\n'), /ci\/helper.js, outside/, 'only .ts and .json inside a widget folder');
});

test('a widget that reads more than its base version needs review', () => {
  const base = { [`${DIR}/widget.json`]: manifest() };
  const wider = manifest(['ci', 'status', 'next'], { fields: ['ci', 'next'] });
  const r = pr({ base, head: { [`${DIR}/widget.json`]: wider } });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /widens its permissions \(fields:next\)/);
  assert.equal(pr({ base, head: { [`${DIR}/widget.json`]: manifest(), [`${DIR}/widget.ts`]: 'y' }, changed: [`${DIR}/widget.ts`] }).ok, true, 'a code-only change is fine');
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
  assert.match(pr({ head: { 'dashboard/src/widgets/code/registry.ts': 'r' } }).problems.join(), /changes no code widget/);
});

test('removing a widget (an Undo revert) may merge itself', () => {
  const r = pr({ base: newWidget, head: { 'dashboard/src/widgets/code/registry.ts': 'r2', 'vault-template/_system/widgets/views.md': 'v2' }, codeIds: [] });
  assert.deepEqual(r.problems, []);
});
