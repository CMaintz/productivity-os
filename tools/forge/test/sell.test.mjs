// Sell or hand over: drafts for selling and a handover pack, facts by code, nothing published.
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { listForges } from '../forge.mjs';
import { worktreeOf } from '../workers.mjs';
import { createCard } from '../../actions/cards.mjs';
import { harness } from './build-fakes.mjs';

const { NOW, at, building, pass, cardBy, press } = harness();
const DRAFTS = ['landing', 'one-pager', 'pitch', 'video-script', 'listing', 'architecture', 'runbook'];
const forge = w => listForges(w.v)[0];
const packWt = w => worktreeOf(path.join(w.v, 'Projects', 'tidewell'), 'pack');
const packed = w => path.join(forge(w).dir, 'pack');
// Fake secrets, assembled at runtime so no scanner mistakes this file for a leak.
const STRIPE = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_');
const GH_TOKEN = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const read = (w, rel) => fs.readFileSync(path.join(packed(w), rel), 'utf8');

/** A product repo with secrets in its config and a lockfile with one copyleft dependency. */
function productRepo(w) {
  const r = packWt(w);
  fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.writeFileSync(path.join(r, 'src', 'db.ts'), "const url = process.env.SUPABASE_URL;\nconst key = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;\nconst s = process.env['STRIPE_SECRET_KEY'];\n");
  fs.writeFileSync(path.join(r, '.env.example'), 'SUPABASE_URL=\nRESEND_API_KEY=\n');
  fs.writeFileSync(path.join(r, '.env'), `STRIPE_SECRET_KEY=${STRIPE}\nRESEND_API_KEY=re_supersecretvalue123\n`);
  fs.writeFileSync(path.join(r, 'wrangler.jsonc'), '{\n  // the worker\n  "name": "tidewell",\n  "vars": { "APP_ENV": "preview" }\n}\n');
  fs.writeFileSync(path.join(r, 'package-lock.json'), JSON.stringify({ packages: {
    '': { name: 'tidewell' },
    'node_modules/astro': { license: 'MIT' },
    'node_modules/sharp': { license: 'Apache-2.0' },
    'node_modules/either': { license: '(MIT OR GPL-3.0)' },
    'node_modules/gpl-thing': { license: 'GPL-3.0' },
    'node_modules/vitest': { license: 'GPL-3.0', dev: true },
  } }));
  fs.mkdirSync(path.join(r, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(r, 'node_modules', 'x', 'i.js'), 'process.env.NOT_OURS');
}

/** A forge whose demo is done: verify left a low finding and an accepted one, the demo a gap; the sell card waits. */
function demoed() {
  const w = building();
  const f = forge(w);
  const b = {
    slug: 'tidy-flat', name: 'Tidewell', repo: 'me/tidewell', clone: path.join(w.v, 'Projects', 'tidewell'), owner: 'me', started: NOW.toISOString(), tickets: {},
    verify: { low: ['Unused helper in lib/'], accepted: ['Share link expires too early'] },
    demo: { preview: { url: 'https://demo-tidewell.me.workers.dev' }, gaps: ['story 2 has no screenshot'] },
  };
  fs.mkdirSync(path.join(w.v, '_system', 'forge-builds'), { recursive: true });
  fs.writeFileSync(path.join(w.v, '_system', 'forge-builds', 'tidy-flat.json'), JSON.stringify(b));
  fs.writeFileSync(path.join(f.dir, 'naming.md'), '## Candidates\n| # | Name | Why |\n|---|---|---|\n| 1 | Tidewell | calm |\n| 2 | Flatmate | plain |\n');
  fs.writeFileSync(path.join(f.dir, 'demo.md'), '# Tidewell: demo\n## What was built\nA shared shopping list.\n');
  createCard(w.v, { action: 'forge_sell', key: 'forge-sell:tidy-flat', risk: 'low', title: 'x', reason: 'x', params: { slug: 'tidy-flat', stage: 'demoed' } }, NOW.toISOString());
  fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('stage: build', 'stage: demoed').replace(/^status: .*$/m, 'status: waiting').replace('review_key: ""', 'review_key: "forge-sell:tidy-flat"'));
  productRepo(w);
  return w;
}

const approve = async (w, m = 1) => { press(cardBy(w, 'forge_sell'), 'done'); return pass(w, m); };

/** The drafting run writes these drafts into forge-pack/ and reports. */
function finishDrafts(w, names = DRAFTS, text = n => `# ${n}\nDraft text.\n`) {
  const run = [...w.sys.started].reverse().find(r => /^You are the sell/.test(r.prompt));
  fs.mkdirSync(path.join(run.cwd, 'forge-pack'), { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(run.cwd, 'forge-pack', `${n}.md`), text(n));
  w.sys.finish('Drafted.\n```json\n' + JSON.stringify({ files: names.map(n => `forge-pack/${n}.md`) }) + '\n```\n', false, /^You are the sell/);
}

test('a demoed product asks first; approving starts a drafting run that can write only its own folder and reach nothing outside', async () => {
  const w = demoed();
  assert.equal(w.sys.started.length, 0);
  assert.match((await approve(w)).join(), /drafting the sell and handover pack/);
  assert.equal(forge(w).stage, 'sell');
  const run = w.sys.started.at(-1);
  assert.match(run.prompt, /^You are the sell/);
  assert.equal(run.cwd, packWt(w));
  assert.deepEqual(run.tools.split(',').sort(), ['Edit(forge-pack/**)', 'Glob', 'Grep', 'Read', 'Write(forge-pack/**)']);
  assert.ok(run.env && run.env.GIT_CONFIG_NOSYSTEM === '1', 'without your credentials');
  assert.match(run.prompt, /SUPABASE_URL/, 'it gets the facts code found');
});

test('No on the sell card leaves the product demoed, with nothing drafted', async () => {
  const w = demoed();
  press(cardBy(w, 'forge_sell'), 'rejected');
  await pass(w, 1);
  assert.equal(forge(w).stage, 'demoed');
  assert.equal(forge(w).status, 'done');
  assert.equal(w.sys.started.length, 0);
});

test('the secrets inventory lists names and where they are used, never values', async () => {
  const w = demoed();
  await approve(w);
  finishDrafts(w);
  await pass(w, 2);
  const inv = read(w, 'handover/secrets-inventory.md');
  for (const n of ['SUPABASE_URL', 'PUBLIC_SUPABASE_ANON_KEY', 'STRIPE_SECRET_KEY', 'RESEND_API_KEY', 'APP_ENV']) assert.match(inv, new RegExp(`\\b${n}\\b`), n);
  assert.match(inv, /src\/db\.ts/);
  assert.doesNotMatch(inv, /NOT_OURS/, 'dependencies are not the product');
  assert.doesNotMatch(inv, /sk_live|supersecret/);
});

test('the license audit flags production dependencies that are not permissive; dev ones are left out', async () => {
  const w = demoed();
  await approve(w);
  finishDrafts(w);
  await pass(w, 2);
  const audit = read(w, 'handover/license-audit.md');
  assert.match(audit, /gpl-thing.*GPL-3\.0.*check/i);
  assert.doesNotMatch(audit, /either.*check/i, 'MIT OR GPL can be used as MIT');
  assert.doesNotMatch(audit, /vitest/);
  assert.match(audit, /astro.*MIT/);
});

test('known issues and the transfer checklist come from the forge, not the model', async () => {
  const w = demoed();
  await approve(w);
  finishDrafts(w);
  await pass(w, 2);
  const issues = read(w, 'handover/known-issues.md');
  for (const t of ['Unused helper in lib/', 'Share link expires too early', 'story 2 has no screenshot']) assert.ok(issues.includes(t), t);
  const list = read(w, 'handover/transfer-checklist.md');
  for (const t of ['github.com/me/tidewell', 'Flatmate', 'tidewell', 'STRIPE_SECRET_KEY']) assert.ok(list.includes(t), t);
});

test('secret-looking values and your .env values are redacted from the drafts before they reach the vault', async () => {
  const w = demoed();
  await approve(w);
  finishDrafts(w, DRAFTS, n => (n === 'runbook'
    ? `# Runbook\nSet the key to ${STRIPE} and RESEND to re_supersecretvalue123.\nA token: ${GH_TOKEN}\n-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----\n`
    : `# ${n}\nfine\n`));
  await pass(w, 2);
  const runbook = read(w, 'handover/runbook.md');
  for (const leak of ['sk_live', 'supersecret', 'ghp_', 'MIIEvQ']) assert.ok(!runbook.includes(leak), leak);
  assert.match(runbook, /\[redacted\]/);
  assert.match(cardBy(w, 'reminder').text, /redacted 4/i);
});

test('the pack: every draft marked DRAFT, handover files apart, nothing published, and only real files from its folder', async () => {
  const w = demoed();
  await approve(w);
  const run = w.sys.started.at(-1);
  fs.mkdirSync(path.join(run.cwd, 'forge-pack'), { recursive: true });
  fs.writeFileSync(path.join(w.v, 'outside.md'), '# private vault note');
  fs.symlinkSync(path.join(w.v, 'outside.md'), path.join(run.cwd, 'forge-pack', 'one-pager.md'));
  finishDrafts(w, DRAFTS.filter(n => n !== 'one-pager'));
  assert.match((await pass(w, 2)).join(), /retrying/, 'a missing draft gets one more try');
  finishDrafts(w, DRAFTS.filter(n => n !== 'one-pager'));
  assert.match((await pass(w, 3)).join(), /pack ready/);
  assert.equal(forge(w).stage, 'packed');
  for (const f of ['landing.md', 'pitch.md', 'video-script.md', 'listing.md', 'handover/architecture.md', 'handover/runbook.md', 'handover/secrets-inventory.md']) assert.match(read(w, f), /^> DRAFT: not published/, f);
  assert.ok(!fs.existsSync(path.join(packed(w), 'one-pager.md')), 'a symlink out of the folder is not followed');
  const card = cardBy(w, 'reminder');
  assert.match(card.text, /nothing was published, listed or sent/i);
  assert.match(card.text, /missing: one-pager/);
});

test('a usage limit while drafting waits for the window; it is not a failed pack', async () => {
  const w = demoed();
  await approve(w);
  w.sys.finish('Claude usage limit reached. Try again at 3pm.', true, /^You are the sell/);
  assert.match((await pass(w, 2)).join(), /usage limit/);
  assert.equal(forge(w).stage, 'sell');
  await pass(w, 30);
  assert.equal(w.sys.started.length, 1);
  await pass(w, 70);
  assert.equal(w.sys.started.length, 2);
});

