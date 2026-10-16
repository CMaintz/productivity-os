// Builds the dashboard snapshot from the vault. What leaves the PC, on purpose: headlines
// (today's Top 3, each project's `next`, card titles and reasons, Claude's "waiting for"
// notice), statuses and counts. What never leaves: note bodies, task checklists, prompts,
// and card results (Claude's output can quote notes), so a card only reports done/failed.

import fs from 'node:fs';
import path from 'node:path';
import { fieldsOf, readFrontmatter } from '../lib/frontmatter.mjs';
import { listCards } from '../actions/cards.mjs';
import { loadWidgets } from '../widgets/widgets.mjs';
import { forgeRows } from '../forge/forge.mjs';

const MAX_CARDS = 60;
const SESSION_DAYS = 7;

const mdIn = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.md')) : []);
const titleOf = text => readFrontmatter(text).body.match(/^# (.+)$/m)?.[1] ?? '';

function projects(vault) {
  const dir = path.join(vault, 'Projects');
  return mdIn(dir).map(f => {
    const x = fieldsOf(fs.readFileSync(path.join(dir, f), 'utf8'));
    const pick = ['status', 'priority', 'next', 'repo', 'ci', 'open_prs', 'failing_prs', 'agent_blocked', 'updated'];
    const slug = path.basename(f, '.md');
    return { title: slug, slug, ...Object.fromEntries(pick.map(k => [k, x[k] ?? null])) };
  }).filter(p => p.status !== 'archived');
}

/** Just the outcome of the last result line ("Done (2026-10-14 11:14)"), never its text. */
const lastOutcome = text => [...(text.split(/^## Result$/m)[1] ?? '').matchAll(/\*\*((?:Done|Failed|Held|Undo) \([^)]*\)):\*\*/g)].pop()?.[1] ?? null;

function cards(vault) {
  return listCards(vault)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))
    .slice(0, MAX_CARDS)
    .map(c => ({
      file: path.relative(vault, c.file).replace(/\\/g, '/'),
      key: c.key, title: titleOf(c.text), action: c.action, risk: c.risk, status: c.status,
      reason: c.reason, context: c.context, created: c.created, expires: c.expires,
      decided_by: c.decided_by || null, finished_at: c.finished_at || null, result: lastOutcome(c.text),
    }));
}

function sessions(vault, now) {
  const dir = path.join(vault, 'Sessions');
  return mdIn(dir).map(f => fieldsOf(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter(s => s.type === 'session' && (now - new Date(s.updated)) / 864e5 <= SESSION_DAYS)
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
    .map(s => ({ project: String(s.project).replace(/^\[\[Projects\/|\]\]$/g, ''), status: s.status, waiting_for: s.waiting_for || null, prompts: s.prompts, started: s.started, updated: s.updated }));
}

/** Today's Top 3 and open task count from the daily note, if there is one. */
function today(vault, now) {
  const date = now.toLocaleDateString('sv-SE');
  const file = path.join(vault, 'Daily', `${date}.md`);
  if (!fs.existsSync(file)) return { date, top3: [], openTasks: 0 };
  const body = readFrontmatter(fs.readFileSync(file, 'utf8')).body;
  const top = (body.split(/^## Top 3$/m)[1] ?? '').split(/^## /m)[0];
  const top3 = [...top.matchAll(/^\d+\.\s+(.+)$/gm)].map(m => m[1].trim()).filter(Boolean);
  return { date, top3, openTasks: (body.match(/^- \[ \]/gm) ?? []).length };
}

/** The vault as widget-ready collections: what `snapshot` sources query. */
export function collections(vault, now = new Date()) {
  return { projects: projects(vault), cards: cards(vault), sessions: sessions(vault, now), today: [today(vault, now)], forges: forgeRows(vault) };
}

export function buildSnapshot(vault, { now = new Date(), host = '' } = {}) {
  const c = collections(vault, now);
  const { layout, widgets } = loadWidgets(vault, c);
  return {
    version: 2, generatedAt: now.toISOString(), host,
    counts: {
      pendingCards: c.cards.filter(x => x.status === 'pending').length,
      waitingSessions: c.sessions.filter(x => x.status === 'waiting').length,
      attention: c.projects.filter(p => p.ci === 'failing' || p.failing_prs > 0 || p.agent_blocked > 0).length,
      activeProjects: c.projects.filter(p => p.status === 'active').length,
      inbox: mdIn(path.join(vault, 'Inbox')).length,
    },
    layout, widgets,
  };
}
