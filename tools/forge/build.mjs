// The Forge's build stage (slice 2): once the repo and tickets exist, each executor pass
//   1. syncs ticket state from GitHub (closed issues, blocked labels, PRs and whether they merged)
//   2. collects finished workers and lead runs (a PR, a retry, blocked after two failures)
//   3. proposes a merge card for a PR GitHub calls clean with every check green; red counts as a failed try
//   4. starts the lead agent on one stuck ticket, or passes on your answer to its question
//   5. releases tickets whose dependencies are done and starts workers up to `concurrency`,
//      unless the usage window is nearly spent
//   6. marks the forge built when every ticket is done
// Build state lives in _system/forge-builds/<slug>.json, outside every agent's working folder, and
// is saved after every spawn or issue created. A GitHub error skips the pass; it never fails the forge.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCard } from '../actions/cards.mjs';
import { readToolsConfig } from '../lib/tools-config.mjs';
import { fieldsOf } from '../lib/frontmatter.mjs';
import { save } from './state.mjs';
import { slugOf } from './naming.mjs';
import { collectAnswer, finishLead, startLead } from './lead.mjs';
import { addSpend, startWorker, system, workerStatus } from './workers.mjs';
import { parsePlan } from './stages.mjs';
import { ownerOf } from './repo.mjs';
import { resumeVerify, verifyStep } from './verify.mjs';
import { demoStep } from './demo.mjs';
import { sellStep } from './sell.mjs';

const BUILD_DIR = path.join('_system', 'forge-builds');
const MAX_ATTEMPTS = 2;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_USAGE_LIMIT = 80;
const HOUR = 36e5;

const buildFile = (vault, slug) => path.join(vault, BUILD_DIR, `${slug}.json`);
export const loadBuild = (vault, slug) => { try { return JSON.parse(fs.readFileSync(buildFile(vault, slug), 'utf8')); } catch { return null; } };
const saveBuild = (vault, b) => { fs.mkdirSync(path.join(vault, BUILD_DIR), { recursive: true }); fs.writeFileSync(buildFile(vault, b.slug), JSON.stringify(b, null, 2) + '\n'); };
const json = (run, args) => JSON.parse(run(args) || '[]');

/** gh pr checks exits non-zero when a check failed or is pending; its JSON is still on stdout. */
function checksOf(run, repo, pr) {
  try { return json(run, ['pr', 'checks', String(pr), '--repo', repo, '--json', 'name,bucket']); } catch (e) {
    try { return JSON.parse(String(e.stdout || '[]')); } catch { return []; }
  }
}
const allGreen = checks => checks.length > 0 && checks.every(c => ['pass', 'skipping'].includes(c.bucket));
const isRed = c => c.bucket === 'fail' || c.bucket === 'cancel';

/** Green checks and GitHub's own verdict (required checks reported, no conflicts). */
function mergeable(run, repo, pr) {
  const checks = checksOf(run, repo, pr);
  if (checks.some(isRed)) return { red: checks.filter(isRed).map(c => c.name) };
  const view = JSON.parse(run(['pr', 'view', String(pr), '--repo', repo, '--json', 'mergeStateStatus,headRefOid']) || '{}');
  return { ok: allGreen(checks) && view.mergeStateStatus === 'CLEAN', sha: view.headRefOid };
}

/** Repo cloned, tickets taken from the plan and the issues the repo card created. */
export function enterBuild(vault, f, ctx) {
  const cfg = readToolsConfig(vault);
  const repo = String(f.repo).replace('https://github.com/', '');
  const clone = path.join(cfg.projectsRoot || path.join(os.homedir(), 'Projects'), slugOf(f.name || f.slug));
  if (!fs.existsSync(clone)) ctx.gh(['repo', 'clone', repo, clone]);
  const { tickets } = parsePlan(fs.readFileSync(path.join(f.dir, 'plan.md'), 'utf8'));
  const issues = fieldsOf(fs.readFileSync(f.file, 'utf8')).issues || {};
  const b = {
    slug: f.slug, name: f.name || f.slug, repo, clone, owner: ownerOf(vault), concurrency: DEFAULT_CONCURRENCY, started: ctx.now.toISOString(),
    tickets: Object.fromEntries(tickets.map(t => [t.n, { issue: issues[t.n], deps: t.dependsOn, state: t.dependsOn.length ? 'waiting' : 'ready', attempts: 0, blocks: 0 }])),
  };
  saveBuild(vault, b);
  return b;
}

const isDone = (b, n) => {
  const t = b.tickets[n];
  return !!t && (t.state === 'done' || (t.state === 'replaced' && t.replacedBy.every(r => isDone(b, r))));
};
const relabel = (ctx, b, t, add, remove) => ctx.gh(['issue', 'edit', String(t.issue), '--repo', b.repo, ...add.flatMap(l => ['--add-label', l]), ...remove.flatMap(l => ['--remove-label', l])]);
const markBlocked = (t, why) => Object.assign(t, { state: 'blocked', blocked: String(why).slice(0, 1500), blocks: (t.blocks ?? 0) + 1 });

/** Closed issues, merged PRs and blocked labels from GitHub. Only a finished worker moves a ticket to `pr`. */
function sync(b, ctx, log) {
  const issues = new Map(json(ctx.gh, ['issue', 'list', '--repo', b.repo, '--state', 'all', '--label', 'agent-feature', '--limit', '300', '--json', 'number,state,labels']).map(i => [i.number, i]));
  const prs = json(ctx.gh, ['pr', 'list', '--repo', b.repo, '--state', 'all', '--limit', '200', '--json', 'number,state,headRefName,headRefOid,closingIssuesReferences']);
  for (const [n, t] of Object.entries(b.tickets)) {
    const issue = issues.get(t.issue);
    if (!issue || ['done', 'replaced'].includes(t.state)) continue;
    const pr = prs.find(p => p.number === t.pr) ?? prs.find(p => p.state === 'OPEN' && (p.headRefName === `forge/T${n}` || (p.closingIssuesReferences ?? []).some(r => r.number === t.issue)));
    if (issue.state === 'CLOSED' || pr?.state === 'MERGED') {
      if (issue.state !== 'CLOSED') ctx.gh(['issue', 'close', String(t.issue), '--repo', b.repo, '--comment', `Done in #${pr.number}.`]);
      Object.assign(t, { state: 'done', run: null });
      log.push(`T${n}: done`);
      continue;
    }
    if (pr?.state === 'OPEN') Object.assign(t, { pr: pr.number, sha: pr.headRefOid });
    const flagged = (issue.labels ?? []).some(l => l.name === 'agent:blocked');
    t.flagged = flagged;
    if (flagged && !t.run && ['ready', 'waiting', 'pr'].includes(t.state)) markBlocked(t, t.blocked ?? 'Labelled agent:blocked.');
    if (!flagged && t.state === 'blocked' && !t.leadRun && t.lead === t.blocks) { Object.assign(t, { state: 'ready', attempts: 0 }); log.push(`T${n}: unblocked on GitHub; ready`); }
  }
}

function fail(ctx, b, n, why, log) {
  const t = b.tickets[n];
  t.attempts += 1;
  t.run = null;
  if (t.attempts < MAX_ATTEMPTS) { t.state = 'ready'; log.push(`T${n}: ${why.split('\n')[0].slice(0, 120)}; retrying`); return; }
  relabel(ctx, b, t, ['agent:blocked'], ['agent:working']);
  ctx.gh(['issue', 'comment', String(t.issue), '--repo', b.repo, '--body-file', '-'], `Product Forge: this ticket failed ${MAX_ATTEMPTS} times. Last result:\n\n${why.slice(0, 1500)}`);
  markBlocked(t, why);
  t.flagged = true;
  log.push(`T${n}: blocked after ${t.attempts} tries`);
}

const pauseUntil = (usage, now) => (usage?.resetsAt && new Date(usage.resetsAt) > now ? usage.resetsAt : new Date(now.valueOf() + HOUR).toISOString());

function collectLead(vault, b, ctx, n, log) {
  const t = b.tickets[n];
  const s = workerStatus(t.leadRun, { now: ctx.now, sys: ctx.sys });
  if (s === 'running') return;
  addSpend(b, s);
  if (s === 'timeout') ctx.sys.kill(t.leadRun.pid);
  log.push(finishLead(vault, ctx, b, n, s === 'timeout' ? { ok: false, text: 'timed out' } : s));
}

/** Finished or stuck workers and lead runs. */
function collect(vault, b, ctx, log) {
  for (const [n, t] of Object.entries(b.tickets)) {
    if (t.leadRun) collectLead(vault, b, ctx, n, log);
    if (!t.run) continue;
    let s = workerStatus(t.run, { now: ctx.now, sys: ctx.sys });
    if (s === 'running') continue;
    addSpend(b, s);
    if (s === 'timeout') { ctx.sys.kill(t.run.pid); s = { ok: false, text: 'no result after the time limit', usageLimit: false }; }
    if (s.usageLimit) { Object.assign(t, { state: 'ready', run: null }); b.paused_until = pauseUntil(ctx.usage, ctx.now); log.push(`T${n}: hit the usage limit; paused until ${b.paused_until}`); continue; }
    if (t.flagged) { t.run = null; markBlocked(t, s.text || 'The worker labelled it agent:blocked.'); log.push(`T${n}: the worker says it's blocked`); continue; }
    if (t.pr) { Object.assign(t, { state: 'pr', run: null }); log.push(`T${n}: worker finished with PR #${t.pr}`); continue; }
    fail(ctx, b, n, s.text || 'the worker ended without a PR', log);
  }
}

/** Merge cards for clean, all-green PRs; a red PR counts as a failed try. */
function reviewPrs(vault, b, ctx, log) {
  for (const [n, t] of Object.entries(b.tickets).filter(([, x]) => x.state === 'pr')) {
    const m = mergeable(ctx.gh, b.repo, t.pr);
    if (m.red) { fail(ctx, b, n, `PR #${t.pr} has failing checks: ${m.red.join(', ')}`, log); continue; }
    if (!m.ok || m.sha !== t.sha || t.merge_sha === t.sha) continue;
    createCard(vault, {
      action: 'forge_merge_pr', key: `forge-merge:${b.slug}:${t.pr}:${t.sha}`, risk: 'medium', title: `Forge ${b.name}: merge T${n} (#${t.pr})`,
      reason: `PR #${t.pr} is clean: every check green and nothing conflicting.`, context: `https://github.com/${b.repo}/pull/${t.pr}`,
      explain: `squash-merges #${t.pr} at ${String(t.sha).slice(0, 7)} (only that commit; a newer push needs a new card).`, undo: 'revert the merge commit on main (git revert -m 1 <sha>) in a PR.',
      params: { repo: b.repo, pr: t.pr, sha: t.sha, issue: t.issue }, expiresDays: 7,
    }, ctx.now.toISOString());
    t.merge_sha = t.sha;
    log.push(`T${n}: PR #${t.pr} is green; merge card proposed`);
  }
}

/** The usage window: paused when at or over the limit, or inside an earlier pause. */
function usagePaused(vault, b, ctx, log) {
  if (b.paused_until && new Date(b.paused_until) > ctx.now) return true;
  b.paused_until = null;
  if (!ctx.usage) { if (!b.unpaced_noted) { log.push('no _system/usage.json, so the build runs unpaced'); b.unpaced_noted = true; } return false; }
  const limit = Number(readToolsConfig(vault).usageLimit) || DEFAULT_USAGE_LIMIT;
  const pct = Math.max(Number(ctx.usage.fiveHourPct) || 0, Number(ctx.usage.weeklyPct) || 0);
  if (pct < limit) return false;
  b.paused_until = pauseUntil(ctx.usage, ctx.now);
  log.push(`usage at ${pct}% (limit ${limit}%); paused until ${b.paused_until}`);
  return true;
}

function releaseAndStart(vault, b, ctx, log) {
  for (const [n, t] of Object.entries(b.tickets).filter(([, x]) => x.state === 'waiting' && x.deps.every(d => isDone(b, d)))) {
    relabel(ctx, b, t, ['agent:ready'], []);
    t.state = 'ready';
    log.push(`T${n}: dependencies done; ready`);
  }
  if (usagePaused(vault, b, ctx, log)) return;
  const running = Object.values(b.tickets).filter(t => t.run).length;
  const ready = Object.entries(b.tickets).filter(([, t]) => t.state === 'ready' && !t.run).sort(([a], [c]) => a - c);
  for (const [n, t] of ready.slice(0, Math.max(0, (Number(b.concurrency) || DEFAULT_CONCURRENCY) - running))) {
    t.run = startWorker({ clone: b.clone, n, issueUrl: `https://github.com/${b.repo}/issues/${t.issue}`, owner: b.owner, logDir: ctx.logDir, now: ctx.now, attempt: t.attempts, sys: ctx.sys });
    t.state = 'running';
    ctx.persist();
    relabel(ctx, b, t, ['agent:working'], ['agent:ready']);
    log.push(`T${n}: worker started`);
  }
}

const STALE_MIN = 30;

/** The status line's last usage record, or null when there is none or it is too old to say anything about now. */
function freshUsage(vault, now) {
  let u;
  try { u = JSON.parse(fs.readFileSync(path.join(vault, '_system', 'usage.json'), 'utf8')); } catch { return null; }
  return u.recordedAt && (now - new Date(u.recordedAt)) / 6e4 <= STALE_MIN ? u : { stale: u.recordedAt ?? 'unknown' };
}

/** The usage record for pacing; a stale one is logged once and ignored. */
function readUsage(vault, now, b, log) {
  const u = freshUsage(vault, now);
  if (!u?.stale) { if (u) b.stale_noted = null; return u; }
  if (b.stale_noted !== u.stale) log.push(`usage record is from ${u.stale}, too old to trust; unpaced for now`);
  b.stale_noted = u.stale;
  return null;
}

function finish(vault, f, b, now) {
  const all = Object.keys(b.tickets);
  b.finished = now.toISOString();
  if (b.verify) { save(f, { stage: 'verify', status: 'running' }, now, 'build: verify fixes done; verifying again'); return; }
  const key = `forge-built:${b.slug}`;
  createCard(vault, { action: 'forge_review', key, risk: 'low', title: `Forge ${b.name}: built`, reason: `All ${all.length} tickets are done (started ${b.started.slice(0, 10)}).`, context: `https://github.com/${b.repo}`, explain: 'marks the build reviewed. Verifying end-to-end (slice 3) comes next.', params: { slug: b.slug, stage: 'built' } }, now.toISOString());
  save(f, { stage: 'built', status: 'waiting', review_key: key }, now, `build: all ${all.length} tickets done`);
}

function pass(vault, b, ctx, log) {
  sync(b, ctx, log);
  collect(vault, b, ctx, log);
  reviewPrs(vault, b, ctx, log);
  for (const n of Object.keys(b.tickets).filter(x => b.tickets[x].state === 'asked')) { const line = collectAnswer(vault, ctx, b, n); if (line) log.push(line); }
  const stuck = Object.keys(b.tickets).find(n => b.tickets[n].state === 'blocked' && !b.tickets[n].leadRun && b.tickets[n].lead !== b.tickets[n].blocks);
  if (stuck) log.push(startLead(vault, ctx, b, stuck));
  releaseAndStart(vault, b, ctx, log);
}

/** The build state and the context build, verify and demo passes share. */
function open(vault, f, { now, gh, sys = system }) {
  const ctx = { now, gh, sys, vault, logDir: path.join(vault, BUILD_DIR, f.slug) };
  const b = loadBuild(vault, f.slug) ?? enterBuild(vault, f, ctx);
  ctx.persist = () => saveBuild(vault, b);
  // Weekly usage when the run was first seen with a fresh record, and now: the demo reports the difference.
  const u = freshUsage(vault, now);
  ctx.weekly = u && !u.stale && Number.isFinite(u.weeklyPct) ? u.weeklyPct : null;
  if (b.weekly_start == null && ctx.weekly != null) b.weekly_start = ctx.weekly;
  return { b, ctx };
}

const STEPS = { verify: verifyStep, demo: demoStep, sell: sellStep };

/** One pass of the build, verify, demo or sell stage (a finished build can hand over to verify in the same pass). */
export function buildOrVerify(vault, f, opts) {
  const lines = f.stage === 'build' ? buildStep(vault, f, opts).map(l => `build: ${l}`) : [];
  const step = STEPS[f.stage];
  if (!step || f.status !== 'running') return lines;
  const { b, ctx } = open(vault, f, opts);
  lines.push(...step(vault, f, b, ctx));
  saveBuild(vault, b);
  return lines;
}

/** Your answer on a "verify needs your call" card. */
export function verifyDecision(vault, f, opts, accepted) {
  const { b, ctx } = open(vault, f, opts);
  const line = resumeVerify(vault, f, b, ctx, accepted);
  saveBuild(vault, b);
  return line;
}

/** One build pass for a forge in the build stage. Returns its log lines (empty when nothing changed). */
export function buildStep(vault, f, opts) {
  const log = [];
  const { b, ctx } = open(vault, f, opts);
  const { now } = opts;
  ctx.usage = readUsage(vault, now, b, log);
  try {
    pass(vault, b, ctx, log);
    b.gh_error = null;
  } catch (e) {
    const msg = String(e.message).split('\n')[0].slice(0, 200);
    if (b.gh_error !== msg) log.push(`GitHub error, trying again next pass: ${msg}`);
    b.gh_error = msg;
  }
  if (Object.keys(b.tickets).every(n => isDone(b, n))) finish(vault, f, b, now);
  else if (log.length) save(f, {}, now, `build: ${log.join('; ')}`);
  saveBuild(vault, b);
  return log;
}

/** Ticket progress for the dashboard: "done/total", or null before the build. */
export function progressOf(vault, slug) {
  const b = loadBuild(vault, slug);
  if (!b) return null;
  const all = Object.keys(b.tickets);
  return `${all.filter(n => isDone(b, n)).length}/${all.length}`;
}

/** forge_merge_pr: merges only that exact commit, and only while GitHub calls it clean and every check is green. */
export function mergeTicketPr(card, ctx) {
  const { repo, pr, sha } = card.params;
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo)) || !Number.isInteger(Number(pr))) return { ok: false, summary: 'Bad merge card.' };
  const m = mergeable(ctx.gh, repo, pr);
  if (!m.ok || m.sha !== sha) return { ok: false, summary: `#${pr} isn't clean and green at that commit any more; the forge proposes a new card when it is.` };
  ctx.gh(['pr', 'merge', String(pr), '--repo', repo, '--squash', '--delete-branch', '--match-head-commit', String(sha)]);
  return { ok: true, summary: `Merged #${pr}. The forge closes its ticket on the next pass.` };
}
