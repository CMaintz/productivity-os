// The lead agent for a stuck ticket. It runs read-only (claude -p in the clone, no write tools)
// and ends with one decision line; this module carries the decision out on the forge's repo:
//   UNBLOCK: <comment>   comment on the ticket and hand it back to the workers
//   REPLAN: <tickets>     create replacement tickets, close the old one
//   ESCALATE: <question>  ask the owner on a card; their answer releases the ticket

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCard, listCards } from '../actions/cards.mjs';
import { createIssue } from '../lib/gh.mjs';
import { parsePlan } from './stages.mjs';
import { ticketBody } from './repo.mjs';

const PROMPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts', 'lead.md');
const LEAD_TOOLS = 'Read,Glob,Grep,Bash(gh issue view:*),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(git log:*),Bash(git diff:*)';
const DECISION = /^(UNBLOCK|REPLAN|ESCALATE):[ \t]*/gm;

/** The last decision in the lead's output: { kind, body }, or null when there's none. */
export function parseDecision(text) {
  const all = [...String(text).matchAll(DECISION)];
  const last = all.at(-1);
  return last ? { kind: last[1], body: String(text).slice(last.index + last[0].length).trim() } : null;
}

const comment = (ctx, b, issue, body) => ctx.gh(['issue', 'comment', String(issue), '--repo', b.repo, '--body-file', '-'], body);
const relabel = (ctx, b, issue, add, remove) => ctx.gh(['issue', 'edit', String(issue), '--repo', b.repo, ...add.flatMap(l => ['--add-label', l]), ...remove.flatMap(l => ['--remove-label', l])]);

/** Hands a ticket back to the workers with guidance. */
export function release(ctx, b, n, guidance) {
  const t = b.tickets[n];
  comment(ctx, b, t.issue, guidance);
  relabel(ctx, b, t.issue, ['agent:ready'], ['agent:blocked']);
  Object.assign(t, { state: 'ready', attempts: 0, blocked: null, lead: null });
}

function replan(ctx, b, n, body) {
  const { tickets, problems } = parsePlan(body);
  if (!tickets.length || problems.length) return `the lead's re-plan didn't parse (${problems.join('; ') || 'no tickets'})`;
  const next = Math.max(...Object.keys(b.tickets).map(Number)) + 1;
  const local = new Map(tickets.map((t, i) => [t.n, next + i]));
  const issueOf = Object.fromEntries(Object.entries(b.tickets).map(([k, t]) => [k, t.issue]));
  const made = [];
  for (const t of tickets) {
    const num = local.get(t.n);
    const deps = t.dependsOn.map(d => local.get(d) ?? d).filter(d => d !== Number(n));
    const url = createIssue(ctx.gh, b.repo, { title: `T${num}: ${t.title}`, body: ticketBody({ ...t, n: num, dependsOn: deps }, issueOf), labels: ['agent-feature'] });
    const issue = Number(String(url).match(/\/issues\/(\d+)/)?.[1]);
    issueOf[num] = issue;
    b.tickets[num] = { issue, deps, state: 'waiting', attempts: 0 };
    made.push(`#${issue}`);
  }
  ctx.gh(['issue', 'close', String(b.tickets[n].issue), '--repo', b.repo, '--comment', `Replaced by ${made.join(', ')} (Product Forge lead agent re-plan).`]);
  Object.assign(b.tickets[n], { state: 'replaced', replacedBy: [...local.values()] });
  return null;
}

function escalate(vault, ctx, b, n, question) {
  const t = b.tickets[n];
  const key = `forge-q:${b.slug}:T${n}:${ctx.now.toISOString().slice(0, 16)}`;
  createCard(vault, {
    action: 'forge_question', key, risk: 'low', title: `Forge ${b.name}: T${n} needs your call`,
    reason: question.slice(0, 300), context: `https://github.com/${b.repo}/issues/${t.issue}`,
    explain: 'write your answer under "## Answer" at the end of this note, then press Do it. The answer goes to the ticket as a comment and the agents pick it up again.',
    undo: 'nothing to undo; the ticket stays blocked until you answer.',
    params: { slug: b.slug, n: Number(n) }, expiresDays: 14,
  }, ctx.now.toISOString());
  Object.assign(t, { state: 'asked', question: key });
}

/** Runs the lead on one blocked ticket and applies its decision. Returns a log line. */
export function lead(vault, ctx, b, n) {
  const t = b.tickets[n];
  const vars = { REPO: b.repo, ISSUE: String(t.issue), ISSUE_URL: `https://github.com/${b.repo}/issues/${t.issue}`, N: String(n), FAILURE: t.blocked ?? 'The ticket is labelled agent:blocked.' };
  const prompt = Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), fs.readFileSync(PROMPT, 'utf8'));
  const r = ctx.runClaude(prompt, b.clone, LEAD_TOOLS);
  t.lead = t.blocked ?? 'blocked';
  const d = r.ok ? parseDecision(r.text) : null;
  if (d?.kind === 'UNBLOCK' && d.body) { release(ctx, b, n, `Lead agent: ${d.body}`); return `T${n}: lead unblocked it`; }
  if (d?.kind === 'REPLAN') {
    const problem = replan(ctx, b, n, d.body);
    if (!problem) return `T${n}: lead re-planned it into ${b.tickets[n].replacedBy.map(x => `T${x}`).join(', ')}`;
    escalate(vault, ctx, b, n, `The lead tried to re-plan T${n}, but ${problem}. How should it be split?`);
    return `T${n}: re-plan failed, asked you`;
  }
  const question = d?.kind === 'ESCALATE' && d.body ? d.body : `The lead couldn't decide on T${n} (${r.ok ? 'no decision line' : 'the run failed'}). What should happen with it?`;
  escalate(vault, ctx, b, n, question);
  return `T${n}: asked you`;
}

// Your text under "## Answer", minus the executor's own result lines appended after it.
const answerOf = text => (String(text).split(/^## Answer\s*$/m)[1] ?? '').split(/^## /m)[0]
  .split('\n').filter(l => !/^\*\*(Done|Failed|Held|Undo) \(/.test(l)).join('\n').trim();

/** An asked ticket whose card you answered: the answer goes to the ticket, which is released. */
export function collectAnswer(vault, ctx, b, n) {
  const t = b.tickets[n];
  const card = listCards(vault).find(c => c.key === t.question);
  if (!card || card.status !== 'done') return null;
  const answer = answerOf(card.text) || card.decline_reason;
  if (!answer) { t.state = 'blocked'; return `T${n}: your answer was empty; it stays blocked`; }
  release(ctx, b, n, `The owner answered: ${answer}`);
  return `T${n}: released with your answer`;
}
