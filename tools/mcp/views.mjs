// What the read tools return. Every row is cut from the dashboard snapshot's collections, so
// MCP results (which go to the client's model) carry exactly what the dashboard already
// publishes: headlines, statuses and counts. A finished card is reduced to its status,
// because even the snapshot's outcome stamp is more than "what's on my plate" needs.

import { OPEN } from '../actions/cards.mjs';

const isOpen = c => OPEN.includes(c.status);
const openCard = ({ key, title, action, risk, status, reason, context, created, expires }) => ({ key, title, action, risk, status, reason, context, created, expires });
const finishedCard = ({ key, title, status, finished_at }) => ({ key, title, status, finished_at });

export const today = c => c.today[0];

export const projects = c => c.projects.map(p => ({
  name: p.slug, status: p.status, priority: p.priority, next: p.next, ci: p.ci, open_prs: p.open_prs, failing_prs: p.failing_prs,
}));

export const openCards = c => c.cards.filter(isOpen).map(openCard);

/** The open card with this key, else the newest finished one; null when there is none. */
export function card(c, key) {
  const match = c.cards.filter(x => x.key === key);
  const open = match.find(isOpen);
  if (open) return openCard(open);
  return match[0] ? finishedCard(match[0]) : null;
}
