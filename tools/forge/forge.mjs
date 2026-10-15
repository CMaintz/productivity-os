#!/usr/bin/env node
// The Product Forge, stages 1-4: an outline becomes spec.md, a stack ADR, naming.md (with
// availability checks) and plan.md, one stage per executor pass. Each stage is a `claude -p`
// run whose output the runner checks before moving on. Stop-points wait on a forge_review card:
// approve continues, reject-with-reason reruns the stage with that feedback. The plan ends in a
// forge_create_repo card (see repo.mjs).
//
// Layout: Forge/<slug>.md is the forge's state and log (yours to read and edit: `status: stopped`
// halts it, `name:` renames it). Forge/<slug>/ is the workspace the model writes in. Claude runs
// with that folder as its cwd, so it can't edit the state note; the outline reaches it in the prompt.
//
// CLI: node tools/forge/forge.mjs new "<outline>" [--mode interview|autonomous] [--stop-after spec,naming] [--vault <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontmatter } from '../lib/frontmatter.mjs';
import { createCard, listCards } from '../actions/cards.mjs';
import { vaultFromArgs } from '../lib/cli.mjs';
import { gh } from '../lib/gh.mjs';
import { FORGE_DIR, candidates, checkOutput, forgeNote, nextStage, stageById } from './stages.mjs';
import { listForges, save, stops } from './state.mjs';

export { listForges };
import { addAvailability, slugOf } from './naming.mjs';
import { ownerOf, proposeRepo } from './repo.mjs';
import { buildStep, progressOf } from './build.mjs';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
// No web access while the outline and spec are the input; research only where it helps.
const FILE_TOOLS = 'Read,Write,Edit,Glob,Grep';
const STAGE_TOOLS = { spec: FILE_TOOLS, stack: `${FILE_TOOLS},WebSearch,WebFetch`, naming: `${FILE_TOOLS},WebSearch`, plan: FILE_TOOLS };
const MAX_ATTEMPTS = 2;
const ACTIVE = ['running', 'waiting'];

const q = v => JSON.stringify(v);
const prompt = (name, vars) => Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, v), fs.readFileSync(path.join(PROMPTS, `${name}.md`), 'utf8'));
const outlineOf = text => (readFrontmatter(text).body.split(/^## Outline\s*$/m)[1] ?? '').split(/^## /m)[0].trim();

export function newForge(vault, outline, { mode = 'interview', stopAfter = ['spec', 'naming'], now = new Date() } = {}) {
  const title = String(outline).split('\n')[0].slice(0, 60).trim();
  const slug = slugOf(title) || `forge-${now.valueOf()}`;
  const file = forgeNote(vault, slug);
  if (fs.existsSync(file)) return { error: `${FORGE_DIR}/${slug} already exists` };
  if (!['interview', 'autonomous'].includes(mode)) return { error: 'mode must be interview or autonomous' };
  fs.mkdirSync(path.join(vault, FORGE_DIR, slug), { recursive: true });
  const fm = { type: 'forge', slug, name: q(''), auto_name: q(''), stage: 'spec', mode, stop_after: q(stops(stopAfter)), status: 'running', attempts: 0, answered: false, review_key: q(''), feedback: q(''), repo: q(''), created: q(now.toISOString()), updated: q(now.toISOString()) };
  fs.writeFileSync(file, `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n# ${title}\n\n## Outline\n${outline.trim()}\n\n## Log\n`);
  return { file, slug };
}

function reviewCard(vault, f, stage, now) {
  const key = `forge:${f.slug}:${stage}:${now.toISOString().slice(0, 16)}`;
  const spec = stage === 'questions'
    ? { action: 'forge_questions', title: `Forge ${f.slug}: answer a few questions`, reason: 'The spec needs your answers first.', explain: `answer them in [[${FORGE_DIR}/${f.slug}/questions]], then press Do it to write the spec.` }
    : { action: 'forge_review', title: `Forge ${f.name || f.slug}: ${stage} is ready`, reason: `Stop-point after ${stage}. Read it in ${FORGE_DIR}/${f.slug}/.`, explain: 'the forge continues with the next stage. To change it instead, press No and type what to change: the stage reruns with that feedback.' };
  createCard(vault, { ...spec, key, risk: 'low', context: `[[${FORGE_DIR}/${f.slug}]]`, undo: `set status: stopped in ${FORGE_DIR}/${f.slug}.md.`, params: { slug: f.slug, stage }, expiresDays: 14 }, now.toISOString());
  return key;
}

/** A waiting forge: what its card says decides the next step. */
function resume(vault, f, now) {
  const card = listCards(vault).find(c => c.key === f.review_key);
  const status = card?.status ?? 'missing';
  if (['pending', 'snoozed', 'approved', 'running'].includes(status)) return null;
  if (status === 'rejected') { save(f, { status: 'running', feedback: card.decline_reason || 'The owner rejected this; try a clearly different approach.' }, now, `${f.stage}: rerun with your feedback`); return 'feedback'; }
  if (status === 'failed' && card.action === 'forge_create_repo') { save(f, { review_key: proposeRepo(vault, f, now) }, now, 'creating the repo failed (see the card); offering it again'); return 'repo-retry'; }
  if (status !== 'done') { save(f, { status: 'stopped' }, now, `stopped: the review card is ${status}`); return 'stopped'; }
  if (card.action === 'forge_questions') { save(f, { status: 'running', answered: true, feedback: '' }, now, 'questions answered'); return 'answered'; }
  if (card.action === 'forge_create_repo') { save(f, { stage: 'build', status: 'running' }, now, 'repo and tickets created; building'); return 'building'; }
  save(f, { status: 'running', stage: nextStage(f.stage), feedback: '' }, now, `${f.stage}: approved`);
  return 'approved';
}

const mtime = file => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0);

function runStage(f, ctx) {
  const asking = f.stage === 'spec' && f.mode === 'interview' && !f.answered;
  const base = asking ? 'spec-questions' : f.stage;
  const output = path.join(f.dir, asking ? 'questions.md' : stageById(f.stage).output);
  const vars = { OUTLINE: outlineOf(f.text), MODE: f.mode === 'autonomous' ? '- ## Assumptions: every decision you made without asking, one line each, so the owner can review them.\n' : '', NAME: f.name || f.slug };
  const feedback = f.feedback ? `\n\nThe owner reviewed the previous version and asked for this change; apply it:\n${f.feedback}\n` : '';
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const before = mtime(output);
  const result = ctx.runClaude(prompt(base, vars) + feedback, f.dir, STAGE_TOOLS[f.stage]);
  return { asking, output, result, rewritten: mtime(output) > before };
}

function namingFields(f, text) {
  const top = candidates(text)[0] ?? f.slug;
  const keepYours = f.name && f.name !== f.auto_name;
  return keepYours ? { auto_name: top } : { name: top, auto_name: top };
}

async function finishStage(vault, f, ctx, rewritten) {
  const stage = stageById(f.stage);
  const file = path.join(f.dir, stage.output);
  if (rewritten && stage.id === 'naming') {
    const { text } = await addAvailability(fs.readFileSync(file, 'utf8'), { fetchImpl: ctx.fetchImpl, run: ctx.gh, owner: ownerOf(vault) });
    fs.writeFileSync(file, text);
  }
  const problems = rewritten ? checkOutput(stage, fs.readFileSync(file, 'utf8')) : [`${stage.output} wasn't written this run`];
  if (problems.length) {
    const attempts = Number(f.attempts) + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    save(f, { attempts, status: failed ? 'failed' : 'running' }, ctx.now, `${f.stage}: output not ready (${problems.join('; ')})${failed ? ', giving up' : ', retrying'}`);
    return failed ? 'failed' : 'retry';
  }
  const fields = { attempts: 0, feedback: '', ...(stage.id === 'naming' ? namingFields(f, fs.readFileSync(file, 'utf8')) : {}) };
  if (stage.id === 'plan') { save(f, { ...fields, status: 'waiting', review_key: proposeRepo(vault, f, ctx.now) }, ctx.now, 'plan: done, waiting for you to create the repo'); return 'repo'; }
  if (f.stop_after.includes(stage.id)) { save(f, { ...fields, status: 'waiting', review_key: reviewCard(vault, f, stage.id, ctx.now) }, ctx.now, `${stage.id}: done, waiting for your review`); return 'review'; }
  save(f, { ...fields, stage: nextStage(stage.id) }, ctx.now, `${stage.id}: done`);
  return 'next';
}

/** One step for one forge. Returns what happened, or null when it's waiting on you. */
export async function advance(vault, f, ctx) {
  if (f.status === 'waiting') return resume(vault, f, ctx.now);
  if (f.status !== 'running') return null;
  if (f.stage === 'build') {
    const lines = buildStep(vault, f, ctx);
    return lines.length ? `build: ${lines.join('; ')}` : null;
  }
  const { asking, output, result, rewritten } = runStage(f, ctx);
  if (!result.ok) { save(f, { status: 'failed' }, ctx.now, `${f.stage}: claude failed: ${String(result.text).slice(0, 200)}`); return 'failed'; }
  if (!asking) return finishStage(vault, f, ctx, rewritten);
  if (!rewritten || !fs.existsSync(output)) { save(f, { status: 'failed' }, ctx.now, 'spec: no questions.md written'); return 'failed'; }
  save(f, { status: 'waiting', feedback: '', review_key: reviewCard(vault, f, 'questions', ctx.now) }, ctx.now, 'spec: questions written, waiting for your answers');
  return 'questions';
}

/** The executor's hook: moves at most one active forge one step (claude runs are long). */
export async function advanceForges(vault, { now = new Date(), runClaude, run = gh, fetchImpl = fetch, sys } = {}) {
  const ctx = { now, runClaude, gh: run, fetchImpl, ...(sys ? { sys } : {}) };
  for (const f of listForges(vault).filter(x => ACTIVE.includes(x.status)).sort((a, b) => String(a.updated).localeCompare(String(b.updated)))) {
    let r;
    try { r = await advance(vault, f, ctx); } catch (e) { save(f, { status: 'failed' }, now, `${f.stage}: error: ${e.message}`); r = 'failed'; }
    if (r) return [`forge ${f.slug}: ${r}`];
  }
  return [];
}

/** Headline fields for the dashboard snapshot: the chosen name or slug, never the outline. */
export const forgeRows = vault => listForges(vault).map(f => ({ title: f.name || f.slug, slug: f.slug, stage: f.stage, status: f.status, mode: f.mode, progress: progressOf(vault, f.slug), updated: f.updated }));

function main() {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  if (args[0] !== 'new' || !args[1]) { console.error('Usage: forge.mjs new "<outline>" [--mode interview|autonomous] [--stop-after spec,naming] [--vault <dir>]'); process.exit(2); }
  const r = newForge(vaultFromArgs(), args[1], { mode: opt('--mode') ?? 'interview', stopAfter: (opt('--stop-after') ?? 'spec,naming').split(',') });
  if (r.error) { console.error(r.error); process.exit(1); }
  console.log(`Started ${FORGE_DIR}/${r.slug}. The executor runs one stage per pass; stop-points show up as cards.`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'forge.mjs') main();
