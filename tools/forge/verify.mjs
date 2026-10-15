// The Forge's verify stage (slice 3): after the build, three detached checks run on merged main:
//   qa            writes/updates an E2E test per user story (via a PR) and runs them, axe,
//                 Lighthouse, npm audit and a license check
//   architecture  read-only review against the ADRs
//   spec          read-only review against docs/spec.md
// Each ends with a JSON report. Code, not the agents, decides what counts: every story in the spec
// must have a qa check, and a run without a usable report is itself a high finding. Medium and
// high findings go back into the build as tickets; then verify runs again. After 3 rounds, or a
// round no better than the last, it stops and asks you.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCard } from '../actions/cards.mjs';
import { createIssue } from '../lib/gh.mjs';
import { save } from './state.mjs';
import { prepareWorktree, startRun, WORKER_TOOLS, workerStatus } from './workers.mjs';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
const MAX_ROUNDS = 3;
const SEVERITIES = ['low', 'medium', 'high'];
const RUNS = [
  { id: 'qa', label: 'qa check', prompt: 'verify-qa', tools: WORKER_TOOLS, worktree: true },
  { id: 'architecture', label: 'architecture review', prompt: 'verify-architecture', tools: 'Read,Glob,Grep' },
  { id: 'spec', label: 'spec review', prompt: 'verify-spec', tools: 'Read,Glob,Grep' },
];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The last fenced ```json block of a run's answer, validated: { report } or { error }. */
export function parseReport(text) {
  const blocks = [...String(text).matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (!blocks.length) return { error: 'no JSON report' };
  let r;
  try { r = JSON.parse(blocks.at(-1)[1]); } catch (e) { return { error: `the JSON report doesn't parse (${e.message})` }; }
  if (!Array.isArray(r?.checks) || r.checks.some(c => typeof c?.name !== 'string' || typeof c.ok !== 'boolean')) return { error: 'checks must be [{ name, ok }]' };
  if (!Array.isArray(r.findings) || r.findings.some(f => typeof f?.title !== 'string' || !SEVERITIES.includes(f.severity))) return { error: `findings need a title and a severity of ${SEVERITIES.join('/')}` };
  return { report: r };
}

/** The numbered user stories in the spec. */
export function storyNumbers(spec) {
  const section = (String(spec).split(/^## +User stories.*$/m)[1] ?? '').split(/^## /m)[0];
  return [...section.matchAll(/^(\d+)\.\s/gm)].map(m => Number(m[1]));
}

const prompt = (name, vars) => Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, v), fs.readFileSync(path.join(PROMPTS, `${name}.md`), 'utf8'));

/** Starts the three checks of the next round. */
export function startRound(vault, f, b, ctx) {
  const v = b.verify ?? (b.verify = { round: 0, history: [], extra: 0 });
  v.round += 1;
  v.runs = {};
  for (const r of RUNS) {
    const cwd = prepareWorktree(ctx.sys, b.clone, r.worktree ? `verify-${v.round}` : `review-${v.round}`);
    v.runs[r.id] = startRun({ prompt: prompt(r.prompt, { ROUND: String(v.round), REPO: b.repo, OWNER: b.owner }), cwd, tools: r.tools, logDir: ctx.logDir, name: `verify-${v.round}-${r.id}`, now: ctx.now, sys: ctx.sys });
    ctx.persist();
  }
  save(f, { stage: 'verify', status: 'running' }, ctx.now);
  return `verify round ${v.round}: qa, architecture and spec checks started`;
}

/** Findings from the three reports, plus the ones code adds: missing reports, untested stories, failed checks. */
function assess(f, results) {
  const findings = [];
  const reports = {};
  for (const r of RUNS) {
    const parsed = results[r.id].ok ? parseReport(results[r.id].text) : { error: 'the run failed' };
    if (parsed.error) { findings.push({ title: `${r.label} produced no usable report`, severity: 'high', details: parsed.error, source: r.id }); continue; }
    reports[r.id] = parsed.report;
    findings.push(...parsed.report.findings.map(x => ({ ...x, source: r.id })));
  }
  if (reports.qa) {
    const covered = new Set(reports.qa.checks.map(c => c.name.match(/^story (\d+)$/i)?.[1]).filter(Boolean).map(Number));
    const spec = fs.existsSync(path.join(f.dir, 'spec.md')) ? fs.readFileSync(path.join(f.dir, 'spec.md'), 'utf8') : '';
    for (const n of storyNumbers(spec).filter(s => !covered.has(s))) findings.push({ title: `story ${n} has no E2E check`, severity: 'high', story: n, details: 'docs/spec.md has this story; the qa run reported no "story n" check for it.', source: 'qa' });
    for (const c of reports.qa.checks.filter(x => !x.ok)) if (!findings.some(x => x.source === 'qa' && x.title.includes(c.name))) findings.push({ title: `${c.name} failed`, severity: 'medium', details: String(c.details ?? ''), source: 'qa' });
  }
  return findings;
}

const ticketTitle = finding => `verify: ${finding.title}`.slice(0, 120);

/** Medium+ findings as tickets (an open ticket with the same title is reused), back to the build. */
function fixLoop(vault, f, b, ctx, actionable) {
  const open = new Map(JSON.parse(ctx.gh(['issue', 'list', '--repo', b.repo, '--state', 'open', '--label', 'verify', '--limit', '200', '--json', 'number,title']) || '[]').map(i => [i.title, i.number]));
  let next = Math.max(0, ...Object.keys(b.tickets).map(Number)) + 1;
  for (const x of actionable) {
    const title = ticketTitle(x);
    const known = Object.values(b.tickets).find(t => t.issue === open.get(title));
    if (known) { Object.assign(known, { state: 'ready', attempts: 0 }); continue; }
    const body = `### Intent\n${x.details || x.title}\n\n### Acceptance criteria\n- [ ] Fixed when the next verify round's ${x.source} check no longer reports: "${x.title}"\n\n### Scope boundaries\n- Only what this finding needs.\n\n### Pointers\n- docs/spec.md${x.story ? ` (story ${x.story})` : ''}, docs/decisions/\n`;
    const url = createIssue(ctx.gh, b.repo, { title, body, labels: ['agent-feature', 'verify', 'agent:ready'] });
    b.tickets[next++] = { issue: Number(String(url).match(/\/issues\/(\d+)/)?.[1]), deps: [], state: 'ready', attempts: 0, blocks: 0, verify: x.title };
    ctx.persist();
  }
  save(f, { stage: 'build', status: 'running' }, ctx.now);
  return `verify round ${b.verify.round}: ${plural(actionable.length, 'finding')} to fix; back to build`;
}

function ask(vault, f, b, ctx, actionable, why) {
  const key = `forge-verify:${b.slug}:${b.verify.round}`;
  createCard(vault, {
    action: 'forge_review', key, risk: 'low', title: `Forge ${b.name}: verify needs your call`, reason: why,
    context: `https://github.com/${b.repo}`,
    explain: `files these as tickets, builds the fixes and verifies once more:\n${actionable.map(x => `- ${x.severity}: ${x.title}`).join('\n')}\n\nNo accepts the product as it is.`,
    undo: 'nothing to undo.', params: { slug: b.slug, stage: 'verify' }, expiresDays: 14,
  }, ctx.now.toISOString());
  b.verify.pending = actionable;
  save(f, { status: 'waiting', review_key: key }, ctx.now);
  return `verify isn't converging (${why.split(': ')[1] ?? why}); asking you`;
}

function verified(vault, f, b, ctx, findings) {
  createCard(vault, { action: 'reminder', key: `forge-verified:${b.slug}`, risk: 'low', title: `Forge ${b.name}: verified`, reason: `Verified in ${plural(b.verify.round, 'round')}. ${findings.length ? `Low findings left: ${findings.map(x => x.title).join('; ')}.` : 'No findings left.'}`, context: `https://github.com/${b.repo}`, explain: 'nothing runs; the demo (slice 4) comes next.', params: {} }, ctx.now.toISOString());
  save(f, { stage: 'verified', status: 'done' }, ctx.now);
  return `verified in ${plural(b.verify.round, 'round')}`;
}

/** One verify pass: wait for the round's runs, then decide. Returns log lines. */
export function verifyStep(vault, f, b, ctx) {
  const v = b.verify;
  if (!v?.runs) return [startRound(vault, f, b, ctx)];
  const results = {};
  for (const [id, run] of Object.entries(v.runs)) {
    const s = workerStatus(run, { now: ctx.now, sys: ctx.sys });
    if (s === 'running') return [];
    if (s === 'timeout') ctx.sys.kill(run.pid);
    results[id] = s === 'timeout' ? { ok: false, text: 'timed out' } : s;
  }
  v.runs = null;
  const findings = assess(f, results);
  const low = findings.filter(x => x.severity === 'low');
  const actionable = findings.filter(x => x.severity !== 'low');
  if (low.length) save(f, {}, ctx.now, `verify round ${v.round} low findings (not ticketed): ${low.map(x => `low: ${x.title}`).join('; ')}`);
  if (!actionable.length) return [verified(vault, f, b, ctx, low)];
  const last = v.history.at(-1);
  v.history.push(actionable.length);
  if (v.round >= MAX_ROUNDS + v.extra) return [ask(vault, f, b, ctx, actionable, `still ${plural(actionable.length, 'finding')} after ${plural(v.round, 'round')}: ${actionable.length} open after ${v.round} rounds`)];
  if (last !== undefined && actionable.length >= last) return [ask(vault, f, b, ctx, actionable, `round ${v.round} found no fewer problems than round ${v.round - 1}: ${plural(actionable.length, 'finding')}, ${last} last round`)];
  return [fixLoop(vault, f, b, ctx, actionable)];
}

/** Your answer on a "verify needs your call" card: Do it fixes what's open and verifies again; No accepts. */
export function resumeVerify(vault, f, b, ctx, accepted) {
  const pending = b.verify?.pending ?? [];
  b.verify.pending = null;
  if (accepted) {
    save(f, { stage: 'verified', status: 'done' }, ctx.now, `verify: accepted with ${plural(pending.length, 'open finding')}`);
    return `accepted with ${plural(pending.length, 'open finding')}`;
  }
  b.verify.extra += 1;
  return fixLoop(vault, f, b, ctx, pending);
}
