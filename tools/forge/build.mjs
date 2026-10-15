// The Forge's build stage (slice 2): once the repo and tickets exist, each executor pass
//   1. syncs ticket state from GitHub (closed issues, blocked labels, open PRs)
//   2. collects finished workers (a PR, a retry, or blocked after two failures)
//   3. proposes a merge card for every PR whose checks are all green
//   4. runs the lead agent on one stuck ticket, or picks up your answer to its question
//   5. releases tickets whose dependencies are done, and starts workers up to `concurrency`,
//      unless the usage window is nearly spent
//   6. marks the forge built when every ticket is done
// Build state lives in _system/forge-builds/<slug>.json, outside every agent's working folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCard } from '../actions/cards.mjs';
import { readToolsConfig } from '../lib/tools-config.mjs';
import { save } from './state.mjs';
import { slugOf } from './naming.mjs';
import { collectAnswer, lead } from './lead.mjs';
import { startWorker, system, workerStatus } from './workers.mjs';
import { parsePlan } from './stages.mjs';
import { fieldsOf } from '../lib/frontmatter.mjs';

const BUILD_DIR = path.join('_system', 'forge-builds');
const MAX_ATTEMPTS = 2;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_USAGE_LIMIT = 80;

const buildFile = (vault, slug) => path.join(vault, BUILD_DIR, `${slug}.json`);
export const loadBuild = (vault, slug) => { try { return JSON.parse(fs.readFileSync(buildFile(vault, slug), 'utf8')); } catch { return null; } };
const saveBuild = (vault, b) => { fs.mkdirSync(path.join(vault, BUILD_DIR), { recursive: true }); fs.writeFileSync(buildFile(vault, b.slug), JSON.stringify(b, null, 2) + '\n'); };
const json = (run, args) => JSON.parse(run(args) || '[]');

/** Repo cloned, tickets taken from the plan and the issues the repo card created. */
export function enterBuild(vault, f, ctx) {
  const cfg = readToolsConfig(vault);
  const repo = String(f.repo).replace('https://github.com/', '');
  const clone = path.join(cfg.projectsRoot || path.join(os.homedir(), 'Projects'), slugOf(f.name || f.slug));
  if (!fs.existsSync(clone)) ctx.gh(['repo', 'clone', repo, clone]);
  const { tickets } = parsePlan(fs.readFileSync(path.join(f.dir, 'plan.md'), 'utf8'));
  const issues = fieldsOf(fs.readFileSync(f.file, 'utf8')).issues || {};
  const b = {
    slug: f.slug, name: f.name || f.slug, repo, clone, concurrency: DEFAULT_CONCURRENCY, started: ctx.now.toISOString(),
    tickets: Object.fromEntries(tickets.map(t => [t.n, { issue: issues[t.n], deps: t.dependsOn, state: t.dependsOn.length ? 'waiting' : 'ready', attempts: 0 }])),
  };
  saveBuild(vault, b);
  return b;
}

const isDone = (b, n) => {
  const t = b.tickets[n];
  return !!t && (t.state === 'done' || (t.state === 'replaced' && t.replacedBy.every(r => isDone(b, r))));
};

/** Closed issues, blocked labels and open PRs from GitHub. */
function sync(b, ctx) {
  const issues = new Map(json(ctx.gh, ['issue', 'list', '--repo', b.repo, '--state', 'all', '--label', 'agent-feature', '--limit', '300', '--json', 'number,state,labels']).map(i => [i.number, i]));
  const prs = json(ctx.gh, ['pr', 'list', '--repo', b.repo, '--state', 'open', '--limit', '100', '--json', 'number,headRefName,headRefOid,closingIssuesReferences']);
  for (const [n, t] of Object.entries(b.tickets)) {
    const issue = issues.get(t.issue);
    if (!issue || ['done', 'replaced'].includes(t.state)) continue;
    if (issue.state === 'CLOSED') { Object.assign(t, { state: 'done', run: null }); continue; }
    const pr = prs.find(p => p.headRefName === `forge/T${n}` || (p.closingIssuesReferences ?? []).some(r => r.number === t.issue));
    if (pr) Object.assign(t, { pr: pr.number, sha: pr.headRefOid, ...(t.run ? {} : { state: 'pr' }) });
    const blocked = (issue.labels ?? []).some(l => l.name === 'agent:blocked');
    t.flagged = blocked;
    if (blocked && !t.run && !['asked', 'blocked'].includes(t.state)) Object.assign(t, { state: 'blocked', blocked: t.blocked ?? 'The worker labelled it agent:blocked.' });
  }
}

const relabel = (ctx, b, t, add, remove) => ctx.gh(['issue', 'edit', String(t.issue), '--repo', b.repo, ...add.flatMap(l => ['--add-label', l]), ...remove.flatMap(l => ['--remove-label', l])]);

function block(ctx, b, n, why) {
  const t = b.tickets[n];
  relabel(ctx, b, t, ['agent:blocked'], ['agent:working']);
  ctx.gh(['issue', 'comment', String(t.issue), '--repo', b.repo, '--body-file', '-'], `Product Forge: this ticket failed ${MAX_ATTEMPTS} times. Last result:\n\n${why.slice(0, 1500)}`);
  Object.assign(t, { state: 'blocked', blocked: why.slice(0, 1500), run: null });
}

/** Finished or stuck workers. Returns log lines; may pause the forge for usage. */
function collect(b, ctx, log) {
  for (const [n, t] of Object.entries(b.tickets).filter(([, x]) => x.run)) {
    let s = workerStatus(t.run, { now: ctx.now, sys: ctx.sys });
    if (s === 'running') continue;
    if (s === 'timeout') { ctx.sys.kill(t.run.pid); s = { ok: false, text: `no result after the time limit`, usageLimit: false }; }
    if (s.usageLimit) { Object.assign(t, { state: 'ready', run: null }); b.paused_until = ctx.usage?.resetsAt ?? new Date(ctx.now.valueOf() + 36e5).toISOString(); log.push(`T${n}: hit the usage limit; paused until ${b.paused_until}`); continue; }
    if (t.pr) { Object.assign(t, { state: 'pr', run: null }); log.push(`T${n}: worker finished with PR #${t.pr}`); continue; }
    if (t.flagged) { Object.assign(t, { state: 'blocked', blocked: s.text || 'The worker labelled it agent:blocked.', run: null }); log.push(`T${n}: the worker says it's blocked`); continue; }
    t.attempts += 1;
    if (t.attempts >= MAX_ATTEMPTS) { block(ctx, b, n, s.text || 'no output'); log.push(`T${n}: blocked after ${t.attempts} tries`); continue; }
    Object.assign(t, { state: 'ready', run: null });
    log.push(`T${n}: worker ended without a PR; retrying`);
  }
}

/** A merge card for every ticket PR with all checks green. */
function proposeMerges(vault, b, ctx, log) {
  for (const [n, t] of Object.entries(b.tickets).filter(([, x]) => x.state === 'pr' && x.merge_sha !== x.sha)) {
    const checks = json(ctx.gh, ['pr', 'checks', String(t.pr), '--repo', b.repo, '--json', 'name,bucket']);
    if (!checks.length || !checks.every(c => ['pass', 'skipping'].includes(c.bucket))) continue;
    createCard(vault, {
      action: 'forge_merge_pr', key: `forge-merge:${b.slug}:${t.pr}:${t.sha}`, risk: 'medium', title: `Forge ${b.name}: merge T${n} (#${t.pr})`,
      reason: `Every check on PR #${t.pr} is green.`, context: `https://github.com/${b.repo}/pull/${t.pr}`,
      explain: `squash-merges #${t.pr} at ${String(t.sha).slice(0, 7)} (only that commit; a newer push needs a new card).`, undo: `revert the merge commit on main (git revert -m 1 <sha>) in a PR.`,
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
  b.paused_until = ctx.usage.resetsAt ?? new Date(ctx.now.valueOf() + 36e5).toISOString();
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
  const ready = Object.entries(b.tickets).filter(([, t]) => t.state === 'ready').sort(([a], [c]) => a - c);
  for (const [n, t] of ready.slice(0, Math.max(0, (Number(b.concurrency) || DEFAULT_CONCURRENCY) - running))) {
    t.run = startWorker({ clone: b.clone, n, issueUrl: `https://github.com/${b.repo}/issues/${t.issue}`, logDir: path.join(vault, BUILD_DIR, b.slug), now: ctx.now, sys: ctx.sys });
    relabel(ctx, b, t, ['agent:working'], ['agent:ready']);
    t.state = 'running';
    log.push(`T${n}: worker started`);
  }
}

function readUsage(vault) {
  try { return JSON.parse(fs.readFileSync(path.join(vault, '_system', 'usage.json'), 'utf8')); } catch { return null; }
}

/** One build pass for a forge in the build stage. Returns its log lines (empty when nothing changed). */
export function buildStep(vault, f, { now, gh, runClaude, sys = system }) {
  const ctx = { now, gh, runClaude, sys, usage: readUsage(vault) };
  const b = loadBuild(vault, f.slug) ?? enterBuild(vault, f, ctx);
  const log = [];
  sync(b, ctx);
  collect(b, ctx, log);
  proposeMerges(vault, b, ctx, log);
  const asked = Object.keys(b.tickets).find(n => b.tickets[n].state === 'asked' && collectAnswer(vault, ctx, b, n));
  if (asked) log.push(`T${asked}: released with your answer`);
  const stuck = Object.keys(b.tickets).find(n => b.tickets[n].state === 'blocked' && b.tickets[n].lead !== (b.tickets[n].blocked ?? 'blocked'));
  if (stuck) log.push(lead(vault, ctx, b, stuck));
  releaseAndStart(vault, b, ctx, log);
  const all = Object.keys(b.tickets);
  if (all.every(n => isDone(b, n))) {
    b.finished = now.toISOString();
    createCard(vault, { action: 'reminder', key: `forge-built:${b.slug}`, risk: 'low', title: `Forge ${b.name}: built`, reason: `All ${all.length} tickets are done (started ${b.started.slice(0, 10)}).`, context: `https://github.com/${b.repo}`, explain: 'nothing runs; verify (slice 3) comes next.', params: {} }, now.toISOString());
    save(f, { stage: 'built', status: 'done' }, now, `build: all ${all.length} tickets done`);
  } else if (log.length) save(f, {}, now, `build: ${log.join('; ')}`);
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

/** forge_merge_pr: merges only that exact commit, and only while every check is still green. */
export function mergeTicketPr(card, ctx) {
  const { repo, pr, sha } = card.params;
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo)) || !Number.isInteger(Number(pr))) return { ok: false, summary: 'Bad merge card.' };
  const checks = json(ctx.gh, ['pr', 'checks', String(pr), '--repo', repo, '--json', 'name,bucket']);
  if (!checks.length || !checks.every(c => ['pass', 'skipping'].includes(c.bucket))) return { ok: false, summary: `#${pr} isn't all green any more; the forge proposes a new card when it is.` };
  ctx.gh(['pr', 'merge', String(pr), '--repo', repo, '--squash', '--delete-branch', '--match-head-commit', String(sha)]);
  // A PR without "Closes #n" leaves its ticket open; close it so its dependents get released.
  const issue = Number(card.params.issue);
  if (Number.isInteger(issue) && issue > 0) { try { ctx.gh(['issue', 'close', String(issue), '--repo', repo, '--comment', `Done in #${pr}.`]); } catch { /* already closed */ } }
  return { ok: true, summary: `Merged #${pr}.` };
}
