// The code widget lifecycle on the PC, with a fake gh: request card -> ticket, merged PR ->
// auto-notice install, Undo -> removal (and a card to remove the code), crashes -> off-switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTemplate } from '../../vault/init.mjs';
import { listCards } from '../../actions/cards.mjs';
import { runOnce } from '../../actions/executor.mjs';
import { applyWidgetErrors, installMerged, proposeCodeWidget } from '../code-widgets.mjs';
import { loadWidgets, readLayout } from '../widgets.mjs';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'vault-template');
const NOW = new Date('2026-10-14T12:00:00Z');
const MANIFEST = JSON.parse(fs.readFileSync(new URL('../../../dashboard/src/widgets/code/ci-status/widget.json', import.meta.url), 'utf8'));

function codeVault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'code-'));
  copyTemplate(TEMPLATE, v);
  fs.writeFileSync(path.join(v, '_system', 'tools.json'), JSON.stringify({ productivityOs: '/repos/productivity-os', githubRepo: 'me/pos' }));
  return v;
}

/** gh stand-in: answers `pr list`, `api .../contents` and `issue create`; records every call. */
function fakeGh({ prs = [], onMain = {} } = {}) {
  const calls = [];
  const run = (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'pr') return JSON.stringify(prs);
    if (args[0] === 'api') {
      const id = args[1].match(/code\/([^/]+)\/widget\.json/)[1];
      if (!onMain[id]) throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'HTTP 404' });
      return Buffer.from(JSON.stringify(onMain[id])).toString('base64');
    }
    if (args[0] === 'issue') return 'Creating issue\nhttps://github.com/me/pos/issues/42\n';
    return '';
  };
  return { run, calls };
}

const cardBy = (v, action) => listCards(v).find(c => c.action === action);
const press = (c, status) => fs.writeFileSync(c.file, c.text.replace(/^status: .*$/m, `status: ${status}`));

test('build_code_widget: proposed as a card; approving opens a widget:code agent ticket', () => {
  const v = codeVault();
  assert.match(proposeCodeWidget(v, { id: 'ci', title: 'CI', source: { kind: 'snapshot', collection: 'projects' } }).errors.join(), /purpose/);
  assert.match(proposeCodeWidget(v, { id: 'x', title: 'X', purpose: 'p', source: { kind: 'snapshot', collection: 'today' } }).errors.join(), /may only read/);
  const spec = { id: 'pr-queue', title: 'PR queue', purpose: 'See which PRs wait on me.', source: { kind: 'snapshot', collection: 'projects', where: { open_prs: { gt: 0 } } }, fields: ['slug', 'open_prs'] };
  proposeCodeWidget(v, spec, NOW.toISOString());
  const card = cardBy(v, 'build_code_widget');
  assert.equal(card.status, 'pending', 'builds are always asked');
  press(card, 'approved');
  const gh = fakeGh();
  runOnce(v, { now: NOW, ghRunner: gh.run });
  assert.equal(cardBy(v, 'build_code_widget').status, 'done');
  const issue = gh.calls.find(c => c.args[0] === 'issue');
  assert.deepEqual(issue.args.slice(0, 4), ['issue', 'create', '--repo', 'me/pos']);
  assert.ok(issue.args.includes('widget:code') && issue.args.includes('agent:ready'));
  assert.match(issue.input, /### Intent[\s\S]*### Acceptance criteria[\s\S]*### Scope boundaries[\s\S]*### Pointers/);
  assert.match(issue.input, /"fields": \[\s*"open_prs",\s*"slug"\s*\]/, 'the ticket carries the exact permissions');
  assert.ok(gh.calls.some(c => c.args.join(' ').startsWith('label create widget:code')), 'labels are ensured');
});

test('a merged widget PR installs itself with a notice card; Undo removes it and offers code removal', () => {
  const v = codeVault();
  const gh = fakeGh({ prs: [{ number: 7, title: 'feat(widget): CI status', files: [{ path: 'dashboard/src/widgets/code/ci-status/widget.json' }] }], onMain: { 'ci-status': MANIFEST } });
  assert.deepEqual(installMerged(v, { run: gh.run, now: NOW.toISOString() }), ['install ci-status']);
  assert.deepEqual(installMerged(v, { run: gh.run }), [], 'each PR once');
  const card = cardBy(v, 'install_code_widget');
  assert.equal(card.status, 'approved', 'auto-notice: it runs without a click');
  runOnce(v, { now: NOW });
  assert.equal(cardBy(v, 'install_code_widget').status, 'done');
  assert.ok(readLayout(v).widgets.some(w => w.id === 'ci-status'));
  assert.equal(loadWidgets(v, { projects: [{ slug: 'a', status: 'active', ci: 'failing', secret: 'x' }] }).widgets['ci-status'].rows[0].secret, undefined, 'rows are cut to the permissions');
  press(cardBy(v, 'install_code_widget'), 'undone');
  runOnce(v, { now: NOW });
  assert.equal(readLayout(v).widgets.some(w => w.id === 'ci-status'), false);
  const removal = listCards(v).find(c => c.key === 'remove-code-widget:ci-status');
  assert.equal(removal.status, 'pending');
  assert.match(removal.params.prompt, /--label widget:code/);
  assert.equal(removal.params.cwd, '/repos/productivity-os');
});

test('a GitHub hiccup is retried later, never read as "removed"', () => {
  const v = codeVault();
  fs.writeFileSync(path.join(v, '_system', 'widgets', 'ci-status.json'), JSON.stringify(MANIFEST));
  const prs = [{ number: 9, title: 'x', files: [{ path: 'dashboard/src/widgets/code/ci-status/widget.json' }] }];
  const flaky = (args) => { if (args[0] === 'pr') return JSON.stringify(prs); throw Object.assign(new Error('HTTP 502: Bad Gateway'), { stderr: 'gh: HTTP 502' }); };
  assert.match(installMerged(v, { run: flaky }).join(), /retry #9 later/);
  assert.ok(fs.existsSync(path.join(v, '_system', 'widgets', 'ci-status.json')), 'still installed');
  assert.deepEqual(installMerged(v, { run: fakeGh({ prs, onMain: { 'ci-status': MANIFEST } }).run }), ['install ci-status'], 'and picked up on the next pass');
});

test('a widget removed from main (a revert PR) leaves the vault too', () => {
  const v = codeVault();
  fs.writeFileSync(path.join(v, '_system', 'widgets', 'ci-status.json'), JSON.stringify(MANIFEST));
  const gh = fakeGh({ prs: [{ number: 9, title: 'revert', files: [{ path: 'dashboard/src/widgets/code/ci-status/widget.json' }] }] });
  assert.deepEqual(installMerged(v, { run: gh.run }), ['removed ci-status']);
  assert.equal(fs.existsSync(path.join(v, '_system', 'widgets', 'ci-status.json')), false);
});

test('off-switch: 3 crashes in 24h since (re)enabling disable a widget and propose a fix ticket', () => {
  const v = codeVault();
  fs.writeFileSync(path.join(v, '_system', 'widgets', 'ci-status.json'), JSON.stringify(MANIFEST));
  fs.writeFileSync(path.join(v, '_system', 'layouts', 'dashboard.json'), JSON.stringify({ widgets: [{ id: 'cards' }, { id: 'ci-status', since: '2026-10-14T09:00:00Z' }] }));
  const err = (h, id = 'ci-status') => ({ widget_id: id, message: `TypeError: boom ${h}`, created_at: `2026-10-14T${String(h).padStart(2, '0')}:00:00Z` });
  assert.deepEqual(applyWidgetErrors(v, [err(8), err(8), err(10), err(11)], NOW), [], 'errors before it was (re)enabled do not count');
  assert.deepEqual(applyWidgetErrors(v, [err(9, 'cards'), err(9, 'cards'), err(10), err(11), err(11)], NOW), ['ci-status']);
  assert.equal(readLayout(v).widgets.find(w => w.id === 'ci-status').disabled, true);
  assert.equal(loadWidgets(v, {}).widgets['ci-status'], undefined, 'a disabled widget is not computed');
  assert.ok(loadWidgets(v, {}).layout.find(w => w.id === 'ci-status').disabled, 'and the Board is told to skip it');
  const fix = cardBy(v, 'fix_widget');
  assert.deepEqual(fix.params.errors, ['TypeError: boom 11', 'TypeError: boom 11', 'TypeError: boom 10']);
  press(fix, 'approved');
  const gh = fakeGh();
  runOnce(v, { now: NOW, ghRunner: gh.run });
  const ticket = gh.calls.find(c => c.args[0] === 'issue').input;
  assert.doesNotMatch(ticket, /boom/, 'crash messages can quote rows, so they stay out of GitHub');
  assert.match(ticket, /Error types: `TypeError`/);
  const reinstall = { prs: [{ number: 12, title: 'fix', files: [{ path: 'dashboard/src/widgets/code/ci-status/widget.json' }] }], onMain: { 'ci-status': MANIFEST } };
  installMerged(v, { run: fakeGh(reinstall).run, now: NOW.toISOString() });
  runOnce(v, { now: NOW });
  const entry = readLayout(v).widgets.find(w => w.id === 'ci-status');
  assert.equal(entry.disabled, false, 'the fix switches it back on');
  assert.equal(entry.since, NOW.toISOString());
});
