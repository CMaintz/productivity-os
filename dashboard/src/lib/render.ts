import type { Card, Project, Session, Snapshot } from './types';

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return '—';
  const m = Math.max(0, Math.round((now - new Date(iso).valueOf()) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

const plainLink = (s: string) => s.replace(/\[\[(?:[^\]|]*\/)?([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1');

const CI = { passing: '✅ passing', failing: '❌ failing', pending: '⏳ pending', none: '·' } as Record<string, string>;
const SESSION = { waiting: '⏸ waiting', running: '▶ running', idle: '· idle', ended: '■ ended' } as Record<string, string>;

const section = (id: string, title: string, count: number | null, body: string) =>
  `<section id="${id}" class="panel"><h2>${esc(title)}${count === null ? '' : ` <span class="count">${count}</span>`}</h2>${body}</section>`;

const empty = (text: string) => `<p class="empty">${esc(text)}</p>`;

function today(s: Snapshot) {
  const items = s.today.top3.length
    ? `<ol class="top3">${s.today.top3.map(t => `<li>${esc(t)}</li>`).join('')}</ol>`
    : empty('No Top 3 yet. Run /today in the vault.');
  const stats = [`${s.today.openTasks} open tasks`, `${s.counts.inbox} in inbox`, `${s.counts.activeProjects} active projects`];
  return section('today', `Today · ${s.today.date}`, null, `${items}<p class="muted">${stats.map(esc).join(' · ')}</p>`);
}

const PENDING_BUTTONS: [string, string, string][] = [
  ['approved', 'Do it', 'primary'], ['snoozed', 'Not now', ''], ['rejected', 'No', 'danger'],
  ['approved:always', 'Always do this', 'quiet'], ['rejected:never', 'Never suggest this', 'quiet'],
];

function cardButtons(c: Card) {
  const data = `data-file="${esc(c.file)}" data-key="${esc(c.key)}"`;
  if (c.status === 'done' || (c.status === 'approved' && c.decided_by === 'policy')) {
    return `<div class="buttons"><button class="quiet" data-press="undone" ${data}>Undo</button></div>`;
  }
  const buttons = PENDING_BUTTONS.map(([press, label, cls]) => `<button class="${cls}" data-press="${press}" ${data}>${esc(label)}</button>`).join('');
  return `<div class="buttons">${buttons}</div><input class="reason" ${data} maxlength="200" placeholder="why not? (optional)" aria-label="Reason">`;
}

function cardItem(c: Card) {
  const meta = [`<span class="risk risk-${esc(c.risk)}">${esc(c.risk)}</span>`, esc(plainLink(c.context)), esc(ago(c.created))].filter(Boolean).join(' · ');
  const result = c.result ? `<p class="result">${esc(c.result.replace(/\*\*/g, ''))}</p>` : '';
  return `<li class="card" data-card="${esc(c.file)}"><h3>${esc(c.title)}</h3><p>${esc(c.reason)}</p><p class="muted">${meta}</p>${result}${cardButtons(c)}<p class="sent" hidden></p></li>`;
}

function cards(s: Snapshot) {
  const pending = s.cards.filter(c => c.status === 'pending');
  const auto = s.cards.filter(c => c.decided_by === 'policy' && ['done', 'failed', 'approved', 'running'].includes(c.status)).slice(0, 5);
  const body = (pending.length ? `<ul class="cards">${pending.map(cardItem).join('')}</ul>` : empty('Nothing waiting on you.'))
    + (auto.length ? `<h3 class="sub">Ran on their own</h3><ul class="cards auto">${auto.map(cardItem).join('')}</ul>` : '');
  return section('cards', 'Waiting on me', pending.length, body);
}

function sessionRow(x: Session) {
  return `<tr class="s-${esc(x.status)}"><td>${esc(x.project)}</td><td>${esc(SESSION[x.status] ?? x.status)}</td><td>${esc(x.waiting_for ?? '')}</td><td class="num">${esc(x.prompts)}</td><td>${esc(ago(x.updated))}</td></tr>`;
}

function sessions(s: Snapshot) {
  const live = s.sessions.filter(x => x.status !== 'ended').sort((a, b) => Number(b.status === 'waiting') - Number(a.status === 'waiting'));
  const body = live.length
    ? `<table><thead><tr><th>Project</th><th>Status</th><th>Waiting for</th><th class="num">Prompts</th><th>Updated</th></tr></thead><tbody>${live.map(sessionRow).join('')}</tbody></table>`
    : empty('No Claude Code sessions right now.');
  return section('sessions', 'Claude sessions', live.length, body);
}

const needsAttention = (p: Project) => p.ci === 'failing' || Number(p.failing_prs) > 0 || Number(p.agent_blocked) > 0;

function projectRow(p: Project) {
  const flags = [p.failing_prs ? `${p.failing_prs} failing PR${p.failing_prs > 1 ? 's' : ''}` : '', p.agent_blocked ? `${p.agent_blocked} blocked ticket${p.agent_blocked > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ');
  const name = p.repo ? `<a href="https://github.com/${esc(p.repo)}" rel="noopener">${esc(p.slug)}</a>` : esc(p.slug);
  return `<tr><td>${name}</td><td>${esc(CI[p.ci ?? 'none'] ?? p.ci)}</td><td class="num">${esc(p.open_prs ?? 0)}</td><td>${esc(flags)}</td><td>${esc(p.next ?? '')}</td></tr>`;
}

function projectTable(id: string, title: string, rows: Project[], none: string) {
  const body = rows.length
    ? `<table><thead><tr><th>Project</th><th>CI</th><th class="num">PRs</th><th>Flags</th><th>Next</th></tr></thead><tbody>${rows.map(projectRow).join('')}</tbody></table>`
    : empty(none);
  return section(id, title, rows.length, body);
}

export function renderDashboard(s: Snapshot, now = Date.now()) {
  const stale = now - new Date(s.generatedAt).valueOf() > 10 * 60_000;
  const banner = stale ? `<p class="banner" role="status">Last update from ${esc(s.host)} was ${esc(ago(s.generatedAt, now))}. Is the PC on and the executor running?</p>` : '';
  const active = s.projects.filter(p => p.status === 'active').sort((a, b) => Number(a.priority ?? 9) - Number(b.priority ?? 9));
  return banner + [
    today(s),
    cards(s),
    sessions(s),
    projectTable('attention', 'Needs attention', s.projects.filter(needsAttention), 'All green.'),
    projectTable('projects', 'Active projects', active, 'No active projects.'),
  ].join('') + `<p class="footer muted">Snapshot from ${esc(s.host)} · ${esc(ago(s.generatedAt, now))}</p>`;
}
