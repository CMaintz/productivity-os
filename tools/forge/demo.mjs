// The Forge's demo stage (slice 4), after you approve the demo card on a verified product:
//   1. preview  code, not a model: a fresh checkout of main is built and `wrangler preview --name
//               demo` uploads it under your Cloudflare login. That is an isolated preview; nothing
//               here ever runs `wrangler deploy`. No wrangler config, a wrangler too old for
//               previews, or a failed upload: the tour runs against a local server instead.
//   2. tour     a detached `claude -p` screenshots every user story. Code checks the shots exist
//               inside its checkout before copying them to the vault.
//   3. summary  Forge/<slug>/demo.md: what was built, a shot per story, known gaps (unshot
//               stories, verify's low and accepted findings, why there is no preview) and the cost.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCard } from '../actions/cards.mjs';
import { save } from './state.mjs';
import { stories } from './verify.mjs';
import { addSpend, jsonBlock, prepareWorktree, startRun, workerStatus } from './workers.mjs';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
const PREVIEW = ['wrangler', 'preview', '--name', 'demo'];
const MIN_WRANGLER = [4, 135];
const CONFIGS = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];
// Screenshots and the local server; no wrangler, gh or git, and no general npm/npx.
const TOUR_TOOLS = 'Read,Write,Edit,Glob,Grep,Bash(npm run preview:*),Bash(npx playwright:*)';
const MAX_ATTEMPTS = 2;
const HOUR = 36e5;

const firstLine = e => String(e?.stderr || e?.message || e).split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 200) ?? 'unknown error';
const older = (v, min) => v[0] < min[0] || (v[0] === min[0] && v[1] < min[1]);

/** Builds the checkout and makes the Cloudflare preview: { url } or { reason } there is none. */
function preview(sys, wt) {
  try {
    sys.run('npm', ['ci'], wt);
    sys.run('npm', ['run', 'build'], wt);
  } catch (e) { return { reason: `the build failed: ${firstLine(e)}` }; }
  if (!CONFIGS.some(c => fs.existsSync(path.join(wt, c)))) return { reason: 'the repo has no wrangler config' };
  try {
    const v = String(sys.run('npx', ['wrangler', '--version'], wt)).match(/(\d+)\.(\d+)\.(\d+)/);
    if (!v) return { reason: "couldn't read the wrangler version" };
    if (older([Number(v[1]), Number(v[2])], MIN_WRANGLER)) return { reason: `wrangler ${v[0]} is older than ${MIN_WRANGLER.join('.')}, which previews need` };
    const url = String(sys.run('npx', PREVIEW, wt)).match(/https:\/\/[\w.-]+\.workers\.dev\S*/)?.[0];
    return url ? { url } : { reason: 'wrangler preview printed no URL' };
  } catch (e) { return { reason: `wrangler preview failed: ${firstLine(e)}` }; }
}

const specOf = f => (fs.existsSync(path.join(f.dir, 'spec.md')) ? fs.readFileSync(path.join(f.dir, 'spec.md'), 'utf8') : '');

function startTour(f, b, ctx, d) {
  const target = d.preview.url ? `the preview at ${d.preview.url}` : 'a local server: build is done, so start `npm run preview` in the background and use the URL it prints';
  const list = stories(specOf(f)).map(s => `${s.n}. ${s.text}`).join('\n');
  const text = Object.entries({ TARGET: target, STORIES: list, NAME: b.name }).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, v), fs.readFileSync(path.join(PROMPTS, 'demo-tour.md'), 'utf8'));
  return startRun({ prompt: text, cwd: d.wt, tools: TOUR_TOOLS, logDir: ctx.logDir, name: 'demo-tour', now: ctx.now, sys: ctx.sys });
}

/** The tour's screenshots that really are files inside its checkout, copied to Forge/<slug>/demo/. */
function copyShots(f, d, report) {
  const out = path.join(f.dir, 'demo');
  fs.mkdirSync(out, { recursive: true });
  const root = path.resolve(d.wt);
  const shots = {};
  for (const s of Array.isArray(report?.shots) ? report.shots : []) {
    const n = Number(s?.story);
    const src = path.resolve(root, String(s?.file ?? ''));
    if (!Number.isInteger(n) || !src.startsWith(root + path.sep) || !/\.png$/i.test(src) || !fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(out, `story-${n}.png`));
    shots[n] = `demo/story-${n}.png`;
  }
  return shots;
}

const count = n => Math.round(n).toLocaleString('en-US');

function costLines(b, ctx) {
  const s = b.spent ?? { usd: 0, input: 0, output: 0, ms: 0, runs: 0 };
  const lines = [`- $${s.usd.toFixed(2)} API-equivalent over ${s.runs} agent runs (${count(s.ms / 6e4)} min). It ran on your subscription, so nothing was billed.`, `- ${count(s.input)} tokens in, ${count(s.output)} out.`];
  if (b.weekly_start != null && ctx.weekly != null) {
    const d = ctx.weekly - b.weekly_start;
    lines.push(d >= 0 ? `- ${count(d)} points of your weekly usage (${b.weekly_start}% → ${ctx.weekly}%).` : '- The weekly usage window reset during the run, so there is no weekly figure.');
  }
  return lines;
}

function writeSummary(f, b, ctx, d, report, failure) {
  const shots = copyShots(f, d, report);
  const all = stories(specOf(f));
  const gaps = [
    ...(d.preview.url ? [] : [`No Cloudflare preview: ${d.preview.reason}. The tour ran locally.`]),
    ...(failure ? [`The screenshot tour failed: ${failure}`] : []),
    ...all.filter(s => !shots[s.n]).map(s => `story ${s.n} has no screenshot`),
    ...(b.verify?.accepted ?? []).map(t => `open finding you accepted: ${t}`),
    ...(b.verify?.low ?? []).map(t => `low finding: ${t}`),
  ];
  const summary = String(report?.summary ?? '').trim() || '(the tour gave no summary)';
  const md = `# ${b.name}: demo

${d.preview.url ? `Preview: ${d.preview.url}` : 'Local only (no preview).'} Repo: https://github.com/${b.repo}

## What was built
${summary}

## Stories
${all.map(s => `- **${s.n}.** ${s.text}${shots[s.n] ? `\n  ![[${shots[s.n]}]]` : ''}`).join('\n')}

## Known gaps
${gaps.length ? gaps.map(g => `- ${g}`).join('\n') : '- None found.'}

## Cost
${costLines(b, ctx).join('\n')}
`;
  fs.writeFileSync(path.join(f.dir, 'demo.md'), md);
  return gaps.length;
}

function done(vault, f, b, ctx, d, report, failure) {
  const gaps = writeSummary(f, b, ctx, d, report, failure);
  const where = d.preview.url ?? 'local only';
  createCard(vault, {
    action: 'reminder', key: `forge-demoed:${b.slug}`, risk: 'low', title: `Forge ${b.name}: demo ready`,
    reason: `Preview: ${where}. Summary, screenshots and cost in [[Forge/${b.slug}/demo.md]] (${gaps} known gap${gaps === 1 ? '' : 's'}).`,
    context: d.preview.url ?? `https://github.com/${b.repo}`, explain: 'nothing runs; selling or handing over (slice 5) comes next.', params: {},
  }, ctx.now.toISOString());
  save(f, { stage: 'demoed', status: 'done' }, ctx.now, `demo: ready (${where})`);
  return `demo ready (${where})`;
}

/** One demo pass: make the preview once, run the tour (again after a usage stop), then write the summary. */
export function demoStep(vault, f, b, ctx) {
  const d = (b.demo ??= { attempts: 0 });
  const log = [];
  try {
    if (!d.preview) {
      d.wt = prepareWorktree(ctx.sys, b.clone, 'demo');
      d.preview = preview(ctx.sys, d.wt);
      ctx.persist();
      log.push(d.preview.url ? `demo: preview at ${d.preview.url}` : `demo: no preview (${d.preview.reason}); touring locally`);
    }
    if (!d.run) {
      if (d.retryAfter && new Date(d.retryAfter) > ctx.now) return log;
      Object.assign(d, { run: startTour(f, b, ctx, d), retryAfter: null });
      ctx.persist();
      log.push('demo: screenshot tour started');
      return log;
    }
    let s = workerStatus(d.run, { now: ctx.now, sys: ctx.sys });
    if (s === 'running') return log;
    addSpend(b, s);
    if (s === 'timeout') { ctx.sys.kill(d.run.pid); s = { ok: false, text: 'no result after the time limit' }; }
    d.run = null;
    if (s.usageLimit) {
      d.retryAfter = new Date(ctx.now.valueOf() + HOUR).toISOString();
      log.push(`demo: the tour hit the usage limit; trying again at ${d.retryAfter}`);
      return log;
    }
    const parsed = s.ok ? jsonBlock(s.text) : { error: firstLine(s.text) };
    if (parsed.error && ++d.attempts < MAX_ATTEMPTS) { log.push(`demo: the tour gave no usable report (${parsed.error}); retrying`); return log; }
    log.push(done(vault, f, b, ctx, d, parsed.value, parsed.error));
  } catch (e) {
    log.push(`demo: error, trying again next pass: ${firstLine(e)}`);
  }
  return log;
}
