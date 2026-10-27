#!/usr/bin/env node
// The executor: picks up what the user decided on action cards and does it.
//   - records each decision (approve, reject, undo) in the trust ladder and in
//     _system/actions/ledger.jsonl, and proposes promotions as new cards
//   - runs approved cards through their handler, writes the result onto the card
//   - un-snoozes cards after a day, expires stale ones, performs Undo
//   - moves one Product Forge one stage (tools/forge/forge.mjs)
//
// Runs on the main PC only (mainHost in _system/tools.json) and one at a time (a lock file).
// Usage: node tools/actions/executor.mjs [--once] [--watch] [--vault <dir>] [--force]
//   --once (default) processes everything and exits.
//   --watch keeps running: a pass every minute, plus the suggestion rules every hour.
//           Start it hidden at logon (see docs/VAULT.md).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyDecision, levelFor, parsePolicy, renderPolicy } from './policy.mjs';
import { HANDLERS, runClaude, undoAction } from './handlers.mjs';
import { appendResult, cardsDir, createCard, listCards, updateCard } from './cards.mjs';
import { suggestAll } from './suggest.mjs';
import { loadConfig, pull, pullWidgetErrors, push, rest } from '../dashboard/sync.mjs';
import { readToolsConfig } from '../lib/tools-config.mjs';
import { installMerged } from '../widgets/code-widgets.mjs';
import { gh } from '../lib/gh.mjs';
import { advanceForges } from '../forge/forge.mjs';
import { syncSessions } from '../sessions/transcripts.mjs';
import { writeFileAtomic } from '../lib/atomic-write.mjs';

const SNOOZE_HOURS = 24;
const LOCK_STALE_MIN = 45;
const WATCH_SECONDS = 60;
const SUGGEST_MINUTES = 60;
const INSTALL_MINUTES = 10;
const STUCK_HOURS = 2;

const hoursSince = (iso, now) => (now - new Date(iso)) / 36e5;
const stamp = now => now.toISOString().slice(0, 16).replace('T', ' ');

function context(vault, now, runner, ghRunner) {
  const policyFile = path.join(vault, '_system', 'policy.md');
  const policy = parsePolicy(fs.existsSync(policyFile) ? fs.readFileSync(policyFile, 'utf8') : '');
  return { vault, now, runClaude: runner, gh: ghRunner, policy, policyFile, promotions: [], log: [] };
}

function save(card, text) {
  writeFileAtomic(card.file, text);
  return text;
}

function decide(ctx, card, kind) {
  const r = applyDecision(ctx.policy, { action: card.action, kind, always: card.always === true, never: card.never === true, key: card.key });
  ctx.policy = r.policy;
  if (r.promote) ctx.promotions.push(r.promote);
  const line = { ts: ctx.now.toISOString(), action: card.action, key: card.key, kind, by: 'you', reason: card.decline_reason || undefined };
  fs.appendFileSync(path.join(cardsDir(ctx.vault), 'ledger.jsonl'), JSON.stringify(line) + '\n');
}

/** Bookkeeping for decisions made since the last run. Returns the (possibly updated) card text. */
function handleDecision(ctx, card) {
  const now = ctx.now.toISOString();
  if (['approved', 'rejected'].includes(card.status) && !card.decided_at) {
    decide(ctx, card, card.status);
    return save(card, updateCard(card.text, { decided_at: now, decided_by: 'you' }));
  }
  if (card.status === 'snoozed') {
    if (!card.decided_at) return save(card, updateCard(card.text, { decided_at: now }));
    if (hoursSince(card.decided_at, ctx.now) >= SNOOZE_HOURS) return save(card, updateCard(card.text, { status: 'pending', decided_at: '' }));
  }
  if (card.status === 'pending' && card.expires && card.expires < now.slice(0, 10)) return save(card, updateCard(card.text, { status: 'expired' }));
  if (card.status === 'undone' && !card.undone_at) return handleUndo(ctx, card);
  if (card.status === 'running' && hoursSince(card.decided_at || card.created, ctx.now) >= STUCK_HOURS) {
    ctx.log.push(`interrupted ${card.action} ${card.key}`);
    return save(
      card,
      appendResult(
        updateCard(card.text, { status: 'failed', finished_at: now }),
        `**Failed (${stamp(ctx.now)}):** interrupted (the PC slept or the executor stopped mid-run). Approve a new card to retry.`,
      ),
    );
  }
  return card.text;
}

function handleUndo(ctx, card) {
  const r = card.finished_at ? undoAction(card, ctx) : { ok: true, summary: 'Undone before it ran.' };
  decide(ctx, card, 'undone');
  ctx.log.push(`undo ${card.action} ${card.key}: ${r.ok ? 'ok' : 'manual'}`);
  return save(card, appendResult(updateCard(card.text, { undone_at: ctx.now.toISOString() }), `**Undo (${stamp(ctx.now)}):** ${r.summary}`));
}

/** A card approved by the policy rather than a person only runs if the policy still allows it. */
const allowedToRun = (ctx, card) => card.decided_by !== 'policy' || levelFor(ctx.policy, card.action) !== 'suggest';

function execute(ctx, card, text) {
  if (!allowedToRun(ctx, card)) {
    ctx.log.push(`refused ${card.action} ${card.key}`);
    return save(
      card,
      appendResult(
        updateCard(text, { status: 'pending', decided_by: '', decided_at: '' }),
        `**Held (${stamp(ctx.now)}):** \`${card.action}\` needs your approval at its current level, so this went back to pending.`,
      ),
    );
  }
  const handler = HANDLERS[card.action];
  let out = save(card, updateCard(text, { status: 'running' }));
  let r;
  try {
    r = handler ? handler(card, ctx) : { ok: false, summary: `No handler for action type \`${card.action}\`.` };
  } catch (e) {
    r = { ok: false, summary: `Error: ${e.message}` };
  }
  const fields = { status: r.ok ? 'done' : 'failed', finished_at: ctx.now.toISOString() };
  if (r.sessionId) fields.session_id = r.sessionId;
  if (r.undo) fields.undo = r.undo;
  out = updateCard(out, fields);
  ctx.log.push(`${r.ok ? 'done' : 'failed'} ${card.action} ${card.key}`);
  return save(card, appendResult(out, `**${r.ok ? 'Done' : 'Failed'} (${stamp(ctx.now)}):** ${r.summary}`));
}

function promotionSpec({ action, to }) {
  return {
    action: 'promote_policy',
    key: `promote:${action}:${to}`,
    risk: 'low',
    title: `Let ${action} run as ${to}`,
    reason: `You've approved ${action} enough times in a row to earn the next level.`,
    explain: `future ${action} cards ${to === 'silent' ? 'run without a card, only logged' : 'run on their own and show up as done, with Undo'}. Any reject or undo drops it back a level.`,
    undo: `set its level back in _system/policy.md, or reject a future ${action} card.`,
    params: { action, to },
  };
}

/** One full pass over the vault. Exported for tests; `runner` replaces `claude -p`, `ghRunner` the gh CLI. */
export function runOnce(vault, { now = new Date(), runner = runClaude, ghRunner = gh } = {}) {
  const ctx = context(vault, now, runner, ghRunner);
  for (const card of listCards(vault)) {
    const text = handleDecision(ctx, card);
    if (card.status === 'approved' && !card.finished_at) execute(ctx, { ...card, text }, text);
  }
  fs.mkdirSync(path.dirname(ctx.policyFile), { recursive: true });
  writeFileAtomic(ctx.policyFile, renderPolicy(ctx.policy));
  for (const p of ctx.promotions) createCard(vault, promotionSpec(p), now.toISOString());
  if (ctx.log.length) {
    const lines = ctx.log.map(l => `- ${stamp(now)} executor ${l}`).join('\n');
    fs.appendFileSync(path.join(vault, '_system', 'changelog.md'), `${lines}\n`);
  }
  return ctx.log;
}

// ---------- guards: main PC only, one at a time ----------
export function onMainHost(vault, host = os.hostname()) {
  const main = readToolsConfig(vault).mainHost;
  return !main || main === host;
}

/** Runs fn (sync or async) while holding the vault's executor lock; skips if another run holds it. */
export async function withLock(vault, fn, now = new Date()) {
  const lock = path.join(vault, '_system', 'executor.lock');
  if (fs.existsSync(lock)) {
    const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
    if ((now - new Date(held.at)) / 6e4 < LOCK_STALE_MIN) return { skipped: `locked by pid ${held.pid} on ${held.host}` };
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), at: now.toISOString() }));
  try {
    return { result: await fn() };
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/**
 * One pass, all under the lock: dashboard presses become card decisions, session notes are
 * synced from the transcripts, the cards run, then the snapshot goes up. Dashboard errors are logged, never fatal.
 */
async function lockedPass(vault, dash) {
  const call = dash ? rest(dash) : null;
  const report = msg => console.error(`dashboard: ${msg}`);
  return withLock(vault, async () => {
    if (call)
      await pull(vault, dash, call)
        .then(a => a.length && console.log(`dashboard: ${a.length} press(es) applied`))
        .catch(e => report(e.message));
    if (call)
      await pullWidgetErrors(vault, dash, call)
        .then(off => off.length && console.log(`dashboard: switched off ${off.join(', ')}`))
        .catch(e => report(e.message));
    // Session notes from Claude Code's transcripts; a problem here never stops the cards.
    try {
      syncSessions(vault);
    } catch (e) {
      console.error(`sessions: ${e.message}`);
    }
    const log = runOnce(vault);
    log.push(...(await advanceForges(vault, { runClaude }).catch(e => [`forge: ${e.message}`])));
    if (call) await push(vault, dash, call).catch(e => report(e.message));
    return log;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--vault');
  const vault = i >= 0 ? args[i + 1] : process.env.PRODUCTIVITY_VAULT || path.join(os.homedir(), 'Vault');
  if (!fs.existsSync(cardsDir(vault))) {
    console.error(`No ${cardsDir(vault)}; run npm run vault first.`);
    process.exit(1);
  }
  if (!onMainHost(vault) && !args.includes('--force')) {
    console.error('Not the main PC (mainHost in _system/tools.json); exiting. Use --force to override.');
    process.exit(0);
  }
  const dash = loadConfig();
  let busy = false;
  // setInterval doesn't wait for async work: never start a pass while the last one runs.
  const pass = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await lockedPass(vault, dash);
      console.log(r.skipped ? `executor: skipped, ${r.skipped}` : `executor: ${r.result.length ? r.result.join('; ') : 'nothing to do'}`);
    } finally {
      busy = false;
    }
  };
  await pass();
  if (!args.includes('--watch')) return;
  const suggest = () => {
    const n = suggestAll(vault).length;
    if (n) console.log(`suggest: ${n} new card(s)`);
  };
  suggest();
  setInterval(pass, WATCH_SECONDS * 1000);
  setInterval(suggest, SUGGEST_MINUTES * 60 * 1000);
  // Code widgets CI merged since the last look (needs gh logged in; offline is fine).
  const install = () =>
    withLock(vault, () => installMerged(vault))
      .then(r => r.result?.length && console.log(`code widgets: ${r.result.join('; ')}`))
      .catch(e => console.error(`code widgets: ${e.message.split('\n')[0]}`));
  await install();
  setInterval(install, INSTALL_MINUTES * 60 * 1000);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'executor.mjs')
  main().catch(e => {
    console.error(`executor: ${e.stack || e.message}`);
    process.exit(1);
  });
