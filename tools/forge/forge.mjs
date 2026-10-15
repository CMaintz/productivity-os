#!/usr/bin/env node
// The Product Forge, stages 1-4: an outline in Forge/<slug>/forge.md becomes spec.md, a stack
// ADR, naming.md (with availability checks) and plan.md, one stage per executor pass. Each
// stage is a `claude -p` run in the forge folder; the runner checks its output before moving on.
// Stop-points wait on a forge_review card: approve continues, reject-with-reason reruns the
// stage with that feedback. The plan ends in a forge_create_repo card (see repo.mjs).
//
// CLI: node tools/forge/forge.mjs new "<outline>" [--mode interview|autonomous] [--stop-after spec,naming] [--vault <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fieldsOf, readFrontmatter, setFrontmatter } from '../lib/frontmatter.mjs';
import { createCard, listCards } from '../actions/cards.mjs';
import { vaultFromArgs } from '../lib/cli.mjs';
import { gh } from '../lib/gh.mjs';
import { STAGE_IDS, candidates, checkOutput, nextStage, stageById } from './stages.mjs';
import { addAvailability, slugOf } from './naming.mjs';
import { ownerOf } from './repo.mjs';

export const FORGE_DIR = 'Forge';
const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
const TOOLS = 'Read,Write,Edit,Glob,Grep,WebSearch,WebFetch';
const MAX_ATTEMPTS = 2;
const ACTIVE = ['running', 'waiting'];

const q = v => JSON.stringify(v);
const forgeFile = (vault, slug) => path.join(vault, FORGE_DIR, slug, 'forge.md');
const prompt = (name, vars = {}) => Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, v), fs.readFileSync(path.join(PROMPTS, `${name}.md`), 'utf8'));

export function newForge(vault, outline, { mode = 'interview', stopAfter = ['spec', 'naming'], now = new Date() } = {}) {
  const title = String(outline).split('\n')[0].slice(0, 60).trim();
  const slug = slugOf(title) || `forge-${now.valueOf()}`;
  const file = forgeFile(vault, slug);
  if (fs.existsSync(file)) return { error: `Forge/${slug} already exists` };
  if (!['interview', 'autonomous'].includes(mode)) return { error: 'mode must be interview or autonomous' };
  const stops = stopAfter.filter(s => STAGE_IDS.includes(s));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fm = { type: 'forge', slug, name: q(''), stage: 'spec', mode, stop_after: q(stops), status: 'running', attempts: 0, answered: false, review_key: q(''), feedback: q(''), repo: q(''), created: q(now.toISOString()), updated: q(now.toISOString()) };
  fs.writeFileSync(file, `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n# ${title}\n\n## Outline\n${outline.trim()}\n\n## Log\n`);
  return { file, slug };
}

export function listForges(vault) {
  const dir = path.join(vault, FORGE_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(s => fs.existsSync(forgeFile(vault, s))).map(s => {
    const text = fs.readFileSync(forgeFile(vault, s), 'utf8');
    return { file: forgeFile(vault, s), dir: path.join(dir, s), text, ...fieldsOf(text) };
  }).filter(f => f.type === 'forge');
}

/** Writes fields (and optionally a log line) back to forge.md. */
function save(f, fields, now, log) {
  let text = Object.entries({ ...fields, updated: now.toISOString() }).reduce((t, [k, v]) => setFrontmatter(t, k, typeof v === 'string' ? q(v) : typeof v === 'object' ? q(v) : v), f.text);
  if (log) text = `${text.trimEnd()}\n- ${now.toISOString().slice(0, 16).replace('T', ' ')} ${log}\n`;
  fs.writeFileSync(f.file, text);
  Object.assign(f, fields, { text });
}

function reviewCard(vault, f, stage, now) {
  const key = `forge:${f.slug}:${stage}:${now.toISOString().slice(0, 16)}`;
  const forgeLink = `[[${FORGE_DIR}/${f.slug}/forge]]`;
  const spec = stage === 'questions'
    ? { action: 'forge_questions', title: `Forge ${f.slug}: answer a few questions`, reason: 'The spec needs your answers first.', explain: `answer them in [[${FORGE_DIR}/${f.slug}/questions]], then press Do it to write the spec.` }
    : { action: 'forge_review', title: `Forge ${f.name || f.slug}: ${stage} is ready`, reason: `Stop-point after ${stage}. Read it in ${FORGE_DIR}/${f.slug}/.`, explain: 'the forge continues with the next stage. To change it instead, press No and type what to change: the stage reruns with that feedback.' };
  createCard(vault, { ...spec, key, risk: 'low', context: forgeLink, undo: `set status: stopped in ${FORGE_DIR}/${f.slug}/forge.md.`, params: { slug: f.slug, stage }, expiresDays: 14 }, now.toISOString());
  return key;
}

/** A waiting forge: what its card says decides the next step. */
function resume(vault, f, now) {
  const card = listCards(vault).find(c => c.key === f.review_key);
  const status = card?.status ?? 'missing';
  if (['pending', 'snoozed', 'approved', 'running'].includes(status)) return null;
  if (status === 'rejected') { save(f, { status: 'running', feedback: card.decline_reason || 'The owner rejected this; try a clearly different approach.' }, now, `${f.stage}: rerun with feedback "${card.decline_reason ?? ''}"`); return 'feedback'; }
  if (status === 'failed') { save(f, { status: 'failed' }, now, `${f.stage}: ${card.action} failed, see the card`); return 'failed'; }
  if (status !== 'done') { save(f, { status: 'stopped' }, now, `stopped: review card is ${status}`); return 'stopped'; }
  if (card.action === 'forge_questions') { save(f, { status: 'running', answered: true }, now, 'questions answered'); return 'answered'; }
  if (card.action === 'forge_create_repo') { save(f, { status: 'done' }, now, 'repo and tickets created; ready to build'); return 'done'; }
  save(f, { status: 'running', stage: nextStage(f.stage), feedback: '' }, now, `${f.stage}: approved`);
  return 'approved';
}

function runStage(f, ctx) {
  const vars = { MODE: f.mode === 'autonomous' ? '- ## Assumptions: every decision you made without asking, one line each, so the owner can review them.\n' : '', NAME: f.name || f.slug };
  const base = f.stage === 'spec' && f.mode === 'interview' && !f.answered ? 'spec-questions' : f.stage;
  const feedback = f.feedback ? `\n\nThe owner reviewed the previous version and asked for this change; apply it:\n${f.feedback}\n` : '';
  return { base, result: ctx.runClaude(prompt(base, vars) + feedback, f.dir, TOOLS) };
}

async function finishStage(vault, f, ctx) {
  const stage = stageById(f.stage);
  const file = path.join(f.dir, stage.output);
  if (stage.id === 'naming' && fs.existsSync(file)) {
    const { text } = await addAvailability(fs.readFileSync(file, 'utf8'), { fetchImpl: ctx.fetchImpl, run: ctx.gh, owner: ownerOf(vault) });
    fs.writeFileSync(file, text);
  }
  const problems = checkOutput(stage, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  if (problems.length) {
    const attempts = Number(f.attempts) + 1;
    save(f, { attempts, status: attempts >= MAX_ATTEMPTS ? 'failed' : 'running' }, ctx.now, `${f.stage}: output not ready (${problems.join('; ')})${attempts >= MAX_ATTEMPTS ? ', giving up' : ', retrying'}`);
    return attempts >= MAX_ATTEMPTS ? 'failed' : 'retry';
  }
  const fields = { attempts: 0, feedback: '' };
  if (stage.id === 'naming' && !f.name) fields.name = candidates(fs.readFileSync(file, 'utf8'))[0] ?? f.slug;
  if (stage.id === 'plan') return proposeRepo(vault, f, fields, ctx.now);
  if (f.stop_after.includes(stage.id)) { save(f, { ...fields, status: 'waiting', review_key: reviewCard(vault, f, stage.id, ctx.now) }, ctx.now, `${stage.id}: done, waiting for your review`); return 'review'; }
  save(f, { ...fields, stage: nextStage(stage.id) }, ctx.now, `${stage.id}: done`);
  return 'next';
}

function proposeRepo(vault, f, fields, now) {
  const name = f.name || f.slug;
  const owner = ownerOf(vault);
  const key = `forge-repo:${f.slug}:${now.toISOString().slice(0, 16)}`;
  createCard(vault, {
    action: 'forge_create_repo', key, risk: 'medium', title: `Forge ${name}: create the repo and tickets`,
    reason: `The plan is ready in ${FORGE_DIR}/${f.slug}/plan.md.`, context: `[[${FORGE_DIR}/${f.slug}/plan]]`,
    explain: `creates the private repo ${owner}/${slugOf(name)} with the spec, ADR and plan in docs/, Foundry's labels, an epic and one agent-feature issue per ticket (tickets without dependencies get agent:ready). To change the plan instead, press No with what to change.`,
    undo: `not automatic (deleting is yours to do): gh repo delete ${owner}/${slugOf(name)}`,
    params: { slug: f.slug, name, owner }, expiresDays: 14,
  }, now.toISOString());
  save(f, { ...fields, status: 'waiting', review_key: key }, now, 'plan: done, waiting for you to create the repo');
  return 'repo';
}

/** One step for one forge. Returns what happened, or null when it's waiting on you. */
export async function advance(vault, f, ctx) {
  if (f.status === 'waiting') return resume(vault, f, ctx.now);
  if (f.status !== 'running') return null;
  const { base, result } = runStage(f, ctx);
  if (!result.ok) { save(f, { status: 'failed' }, ctx.now, `${f.stage}: claude failed: ${String(result.text).slice(0, 200)}`); return 'failed'; }
  if (base === 'spec-questions') {
    if (!fs.existsSync(path.join(f.dir, 'questions.md'))) { save(f, { status: 'failed' }, ctx.now, 'spec: no questions.md written'); return 'failed'; }
    save(f, { status: 'waiting', review_key: reviewCard(vault, f, 'questions', ctx.now) }, ctx.now, 'spec: questions written, waiting for your answers');
    return 'questions';
  }
  return finishStage(vault, f, ctx);
}

/** The executor's hook: moves at most one active forge one step (claude runs are long). */
export async function advanceForges(vault, { now = new Date(), runClaude, run = gh, fetchImpl = fetch } = {}) {
  const ctx = { now, runClaude, gh: run, fetchImpl };
  for (const f of listForges(vault).filter(x => ACTIVE.includes(x.status)).sort((a, b) => String(a.updated).localeCompare(String(b.updated)))) {
    const r = await advance(vault, f, ctx);
    if (r) return [`forge ${f.slug}: ${r}`];
  }
  return [];
}

/** Headline fields for the dashboard snapshot: never the outline, spec or plan text. */
export const forgeRows = vault => listForges(vault).map(f => ({ title: f.name || readFrontmatter(f.text).body.match(/^# (.+)$/m)?.[1] || f.slug, slug: f.slug, stage: f.stage, status: f.status, mode: f.mode, updated: f.updated }));

function main() {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  if (args[0] !== 'new' || !args[1]) { console.error('Usage: forge.mjs new "<outline>" [--mode interview|autonomous] [--stop-after spec,naming] [--vault <dir>]'); process.exit(2); }
  const r = newForge(vaultFromArgs(), args[1], { mode: opt('--mode') ?? 'interview', stopAfter: (opt('--stop-after') ?? 'spec,naming').split(',').filter(Boolean) });
  if (r.error) { console.error(r.error); process.exit(1); }
  console.log(`Started ${FORGE_DIR}/${r.slug}. The executor runs one stage per pass; stop-points show up as cards.`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'forge.mjs') main();
