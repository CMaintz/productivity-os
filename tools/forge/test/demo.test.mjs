// The demo stage: a Cloudflare preview (never production), a screenshot tour of every story, and a
// summary with known gaps and what the run cost.
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { worktreeOf } from '../workers.mjs';
import { runOnce } from '../../actions/executor.mjs';
import { harness } from './build-fakes.mjs';
import { verifyFakes } from './verify-fakes.mjs';

const h = harness();
const { at, pass, cardBy, press } = h;
const { report, forge, readyToVerify, finishRound } = verifyFakes(h);
const URL = 'https://demo-tidewell.me.workers.dev';
const COST = { total_cost_usd: 1.25, duration_ms: 60_000, usage: { input_tokens: 1000, output_tokens: 200 } };
const clone = w => path.join(w.v, 'Projects', 'tidewell');
const demoDir = w => worktreeOf(clone(w), 'demo');
const tourReport = shots => 'Toured.\n```json\n' + JSON.stringify({ summary: 'A shared shopping list.', shots }) + '\n```\n';
const wrangler = w => w.sys.ran.filter(r => r.cmd === 'npx' && r.args[0] === 'wrangler');

/** A Cloudflare-ready product repo: a wrangler config and a recent wrangler that prints a preview URL. */
function cloudflareReady(w, version = '4.140.0') {
  fs.mkdirSync(demoDir(w), { recursive: true });
  fs.writeFileSync(path.join(demoDir(w), 'wrangler.jsonc'), '{ "name": "tidewell" }');
  w.sys.respond = (cmd, args) => {
    if (args[1] === '--version') return ` ⛅️ wrangler ${version}\n`;
    if (args[1] === 'preview') return `Uploaded tidewell\nPreview: ${URL}\n`;
    return '';
  };
}

/** Verified in one clean round, each check reporting COST; the demo card is waiting. */
async function verified({ usage } = {}) {
  const w = await readyToVerify();
  if (usage) fs.writeFileSync(path.join(w.v, '_system', 'usage.json'), JSON.stringify({ fiveHourPct: 5, weeklyPct: usage, recordedAt: at(2).toISOString() }));
  await pass(w, 2);
  finishRound(w, { extra: COST });
  await pass(w, 3);
  return w;
}

const approve = async (w, m = 4) => { press(cardBy(w, 'forge_demo'), 'done'); runOnce(w.v, { now: at(m) }); return pass(w, m + 1); };

/** The tour run leaves these screenshots in its checkout and reports them. */
function finishTour(w, stories = [1, 2], extra = COST) {
  const tour = [...w.sys.started].reverse().find(r => /^You are the demo/.test(r.prompt));
  fs.mkdirSync(path.join(tour.cwd, 'forge-demo'), { recursive: true });
  for (const n of stories) fs.writeFileSync(path.join(tour.cwd, 'forge-demo', `story-${n}.png`), 'png');
  w.sys.finish(tourReport([1, 2].map(n => ({ story: n, file: `forge-demo/story-${n}.png` }))), false, /^You are the demo/, extra);
}

const summary = w => fs.readFileSync(path.join(forge(w).dir, 'demo.md'), 'utf8');

test('a verified product asks before anything goes to Cloudflare; approving makes a preview, never a production deploy', async () => {
  const w = await verified();
  cloudflareReady(w);
  assert.equal(forge(w).status, 'waiting');
  assert.match(cardBy(w, 'forge_demo').text, /preview/i);
  assert.equal(wrangler(w).length, 0, 'nothing deployed before you say so');
  assert.match((await approve(w)).join(), new RegExp(`preview at ${URL}`));
  assert.equal(forge(w).stage, 'demo');
  assert.deepEqual(w.sys.ran.filter(r => r.cmd === 'npm').map(r => r.args.join(' ')), ['ci', 'run build']);
  assert.deepEqual(wrangler(w).map(r => r.args.slice(1).join(' ')), ['--version', 'preview --name demo']);
  assert.ok(w.sys.ran.every(r => r.cwd === demoDir(w)), 'in its own checkout of main');
  const tour = w.sys.started.at(-1);
  assert.match(tour.prompt, /^You are the demo/);
  assert.ok(tour.prompt.includes(URL));
  assert.doesNotMatch(tour.tools, /wrangler|Bash\(gh|Bash\(git|Bash\(npx:\*\)|Bash\(npm:\*\)/, 'the tour can neither deploy nor push');
});

test('without a usable Cloudflare setup the demo runs locally and says why', async () => {
  for (const [setup, why] of [[() => {}, /no wrangler config/], [w => cloudflareReady(w, '4.100.0'), /wrangler 4\.100\.0 is older than 4\.135/]]) {
    const w = await verified();
    setup(w);
    await approve(w);
    assert.ok(!wrangler(w).some(r => r.args[1] === 'preview'), 'no preview attempted');
    assert.match(w.sys.started.at(-1).prompt, /npm run preview/);
    finishTour(w);
    await pass(w, 6);
    assert.match(summary(w), why);
  }
});

test('a failed preview command falls back to local instead of failing the demo', async () => {
  const w = await verified();
  cloudflareReady(w);
  const ready = w.sys.respond;
  w.sys.respond = (cmd, args, cwd) => { if (args[1] === 'preview') throw new Error('Authentication error [code: 10000]'); return ready(cmd, args, cwd); };
  await approve(w);
  assert.match(w.sys.started.at(-1).prompt, /npm run preview/);
  finishTour(w);
  await pass(w, 6);
  assert.match(summary(w), /Authentication error/);
  assert.equal(forge(w).stage, 'demoed');
});

test('every story needs a screenshot that exists; a missing one is a known gap, and the shots land in the vault', async () => {
  const w = await verified();
  cloudflareReady(w);
  await approve(w);
  finishTour(w, [1]);
  assert.match((await pass(w, 6)).join(), /demo ready/);
  assert.equal(forge(w).stage, 'demoed');
  assert.ok(fs.existsSync(path.join(forge(w).dir, 'demo', 'story-1.png')));
  const s = summary(w);
  assert.match(s, /## What was built\n[\s\S]*A shared shopping list/);
  assert.match(s, /!\[\[demo\/story-1\.png\]\]/);
  assert.match(s, /## Known gaps[\s\S]*story 2 has no screenshot/);
  const card = cardBy(w, 'reminder');
  assert.ok(card.text.includes(URL));
  assert.match(card.text, /demo\.md/);
});

test('a screenshot path outside the tour checkout is never copied', async () => {
  const w = await verified();
  cloudflareReady(w);
  await approve(w);
  const outside = path.join(w.v, 'private.png');
  fs.writeFileSync(outside, 'a private image');
  w.sys.finish(tourReport([{ story: 1, file: path.relative(w.sys.started.at(-1).cwd, outside) }, { story: 2, file: outside }]), false, /^You are the demo/);
  await pass(w, 6);
  assert.deepEqual(fs.readdirSync(path.join(forge(w).dir, 'demo')), []);
  assert.match(summary(w), /story 1 has no screenshot[\s\S]*story 2 has no screenshot/);
});

test('the summary shows what the whole run cost, from every agent run and the usage window', async () => {
  const w = await verified({ usage: 10 });
  cloudflareReady(w);
  await approve(w);
  fs.writeFileSync(path.join(w.v, '_system', 'usage.json'), JSON.stringify({ fiveHourPct: 40, weeklyPct: 25, recordedAt: at(6).toISOString() }));
  finishTour(w);
  await pass(w, 6);
  const s = summary(w);
  assert.match(s, /\$5\.00 API-equivalent/, 'three checks and the tour at $1.25 each');
  assert.match(s, /4,000 tokens in, 800 out/);
  assert.match(s, /15 points of your weekly usage/);
});

test('a usage limit during the tour waits for the window; it is not a failed demo', async () => {
  const w = await verified();
  cloudflareReady(w);
  await approve(w);
  const tours = () => w.sys.started.filter(r => /^You are the demo/.test(r.prompt)).length;
  w.sys.finish('Claude usage limit reached. Try again at 3pm.', true, /^You are the demo/);
  assert.match((await pass(w, 6)).join(), /usage limit/);
  assert.equal(forge(w).stage, 'demo');
  await pass(w, 30);
  assert.equal(tours(), 1, 'not before the hour is up');
  await pass(w, 70);
  assert.equal(tours(), 2);
  assert.equal(wrangler(w).filter(r => r.args[1] === 'preview').length, 1, 'the preview is not made again');
});

test('accepting a product with open findings lists them as known gaps in the demo', async () => {
  const w = await readyToVerify();
  await pass(w, 2);
  const one = n => report([], [{ title: `Problem ${n}`, severity: 'medium', details: 'd' }]);
  finishRound(w, { spec: one(1) });
  await pass(w, 3);
  for (const i of w.gh.issues.values()) i.state = 'CLOSED';
  await pass(w, 4);
  finishRound(w, { spec: one(2) });
  await pass(w, 5);
  press(cardBy(w, 'forge_review'), 'rejected');
  await pass(w, 6);
  assert.ok(cardBy(w, 'forge_demo'), 'accepting also offers the demo');
  cloudflareReady(w);
  await approve(w, 7);
  finishTour(w);
  await pass(w, 9);
  assert.match(summary(w), /## Known gaps[\s\S]*Problem 2/);
});

test('No on the demo card leaves the product verified, with nothing deployed', async () => {
  const w = await verified();
  cloudflareReady(w);
  press(cardBy(w, 'forge_demo'), 'rejected');
  await pass(w, 5);
  assert.equal(forge(w).stage, 'verified');
  assert.equal(forge(w).status, 'done');
  assert.equal(w.sys.ran.length, 0);
});
