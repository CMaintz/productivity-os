// The demo stage: a Cloudflare preview (never production), a screenshot tour of every story, and a
// summary with known gaps and what the run cost.
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { worktreeOf } from '../workers.mjs';
import { preview } from '../demo.mjs';
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
const wrangler = w => w.sys.ran.filter(r => r.cmd === 'npx' && r.args.includes('wrangler'));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

/** The preview's detached script, run in-process here so the test sees what it does at once. */
const previewInline = w => { w.sys.spawnNode = (script, args) => { fs.writeFileSync(args.at(-1), JSON.stringify(preview(w.sys, args[1]))); return ++w.sys.pid; }; };

/** A Cloudflare-ready product repo: a wrangler config and a recent wrangler that prints a preview URL. */
function cloudflareReady(w, version = '4.140.0') {
  fs.mkdirSync(demoDir(w), { recursive: true });
  fs.writeFileSync(path.join(demoDir(w), 'wrangler.jsonc'), '{ "name": "tidewell" }');
  w.sys.respond = (cmd, args) => {
    if (args.includes('--version')) return ` ⛅️ wrangler ${version}\n`;
    if (args.includes('preview')) return `Uploaded tidewell\nPreview: ${URL}\n`;
    return '';
  };
}

/** Verified in one clean round, each check reporting COST; the demo card is waiting. */
async function verified({ usage } = {}) {
  const w = await readyToVerify();
  previewInline(w);
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
  for (const n of stories) fs.writeFileSync(path.join(tour.cwd, 'forge-demo', `story-${n}.png`), PNG);
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
  assert.deepEqual(wrangler(w).map(r => r.args.join(' ')), ['--no-install wrangler --version', '--no-install wrangler preview --name demo'], "the repo's own wrangler, never one fetched on the fly");
  assert.ok(w.sys.ran.every(r => r.cwd === demoDir(w)), 'in its own checkout of main');
  const tour = w.sys.started.at(-1);
  assert.match(tour.prompt, /^You are the demo/);
  assert.ok(tour.prompt.includes(URL));
  assert.doesNotMatch(tour.tools, /wrangler|Bash\(gh|Bash\(git|Bash\(npx:\*\)|Bash\(npm:\*\)/, 'no deploy or push commands');
});

test('the tour runs without your Cloudflare and GitHub credentials, and writes only its own folder', async () => {
  process.env.CLOUDFLARE_API_TOKEN = 'cf-secret';
  process.env.GH_TOKEN = 'gh-secret';
  try {
    const w = await verified();
    cloudflareReady(w);
    await approve(w);
    const { env, tools } = w.sys.started.at(-1);
    assert.ok(env, 'the tour gets its own environment');
    for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GH_TOKEN', 'GITHUB_TOKEN']) assert.equal(env[k], undefined, k);
    for (const k of ['XDG_CONFIG_HOME', 'GH_CONFIG_DIR']) assert.deepEqual(fs.readdirSync(env[k]), [], `${k} is an empty folder, so no stored login is found`);
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1', 'no credential helper from git config');
    assert.equal(fs.readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8'), '');
    assert.deepEqual(tools.split(',').filter(t => /^(Write|Edit)/.test(t)), ['Write(forge-demo/**)', 'Edit(forge-demo/**)']);
  } finally {
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.GH_TOKEN;
  }
});

test('the preview runs detached: the executor neither waits for it nor starts it twice', async () => {
  const w = await verified();
  cloudflareReady(w);
  w.sys.spawnNode = (script, args, log) => { const pid = ++w.sys.pid; w.sys.nodes.push({ pid, script, args, log }); return pid; };
  const alive = w.sys.alive;
  w.sys.alive = pid => w.sys.nodes.some(n => n.pid === pid && !n.done) || alive(pid);
  assert.match((await approve(w)).join(), /making the preview/);
  assert.equal(w.sys.ran.length, 0, 'nothing built inside the executor pass');
  await pass(w, 50);
  assert.equal(w.sys.nodes.length, 1, 'not started again while it runs');
  assert.ok(!w.sys.started.some(r => /^You are the demo/.test(r.prompt)), 'no tour before the preview');
  const [node] = w.sys.nodes;
  fs.writeFileSync(node.args.at(-1), JSON.stringify({ url: URL }));
  node.done = true;
  assert.match((await pass(w, 51)).join(), new RegExp(`preview at ${URL}.*tour started`));
});

test('the preview checkout is always main, even if a forge/demo branch exists', async () => {
  const w = await verified();
  cloudflareReady(w);
  const calls = [];
  w.sys.git = args => { calls.push(args); return args[0] === 'ls-remote' ? 'abc\trefs/heads/forge/demo\n' : ''; };
  await approve(w);
  assert.equal(calls.find(a => a[0] === 'worktree' && a[1] === 'add').at(-1), 'origin/main');
});

test('without a usable Cloudflare setup the demo runs locally and says why', async () => {
  for (const [setup, why] of [[() => {}, /no wrangler config/], [w => cloudflareReady(w, '4.100.0'), /wrangler 4\.100\.0 is older than 4\.135/]]) {
    const w = await verified();
    setup(w);
    await approve(w);
    assert.ok(!wrangler(w).some(r => r.args.includes('preview')), 'no preview attempted');
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
  w.sys.respond = (cmd, args, cwd) => { if (args.includes('preview')) throw new Error('Authentication error [code: 10000]'); return ready(cmd, args, cwd); };
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
  const card = cardBy(w, 'forge_sell');
  assert.ok(card.text.includes(URL), 'the demo card offers the sell/handover pack, with the preview link');
  assert.match(card.text, /demo\.md/);
  assert.equal(forge(w).status, 'waiting');
});

test('a screenshot path outside the tour checkout is never copied', async () => {
  const w = await verified();
  cloudflareReady(w);
  await approve(w);
  const outside = path.join(w.v, 'private.png');
  fs.writeFileSync(outside, PNG);
  const cwd = w.sys.started.at(-1).cwd;
  fs.mkdirSync(path.join(cwd, 'forge-demo'), { recursive: true });
  fs.symlinkSync(outside, path.join(cwd, 'forge-demo', 'story-3.png'));
  fs.writeFileSync(path.join(cwd, 'forge-demo', 'story-4.png'), 'not an image');
  fs.symlinkSync(w.v, path.join(cwd, 'linked'));
  const shots = [[1, path.relative(cwd, outside)], [2, outside], [3, 'forge-demo/story-3.png'], [4, 'forge-demo/story-4.png'], [5, 'linked/private.png']].map(([story, file]) => ({ story, file }));
  w.sys.finish(tourReport(shots), false, /^You are the demo/);
  await pass(w, 6);
  assert.deepEqual(fs.readdirSync(path.join(forge(w).dir, 'demo')), [], 'not via ../, an absolute path, a linked file or a linked folder, and only real PNGs');
  assert.match(summary(w), /story 1 has no screenshot[\s\S]*story 2 has no screenshot/);
});

test('a crash while writing the summary keeps the tour: the next pass only finishes the summary', async () => {
  const w = await verified();
  cloudflareReady(w);
  await approve(w);
  fs.mkdirSync(path.join(forge(w).dir, 'demo.md'));
  finishTour(w);
  assert.match((await pass(w, 6)).join(), /error/);
  fs.rmdirSync(path.join(forge(w).dir, 'demo.md'));
  assert.match((await pass(w, 7)).join(), /demo ready/);
  assert.equal(w.sys.started.filter(r => /^You are the demo/.test(r.prompt)).length, 1, 'no second tour');
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
  assert.equal(wrangler(w).filter(r => r.args.includes('preview')).length, 1, 'the preview is not made again');
});

test('accepting a product with open findings lists them as known gaps in the demo', async () => {
  const w = await readyToVerify();
  previewInline(w);
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
