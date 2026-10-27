// The trust ladder. _system/policy.md holds, per action type, its current level, the highest
// level it may ever reach, how many approvals in a row earn a promotion, and the current
// streak. It's a markdown table so the user can read and edit it; this module parses and
// rewrites it. Promotions are proposed as action cards and never happen silently.

export const LEVELS = ['suggest', 'auto-notice', 'silent'];
const rank = level => Math.max(0, LEVELS.indexOf(level));

// Defaults for action types the system knows. `max` is the hard ceiling for that type.
export const DEFAULTS = {
  triage_inbox: { level: 'auto-notice', max: 'silent', promoteAfter: 5 },
  pause_stale_project: { level: 'suggest', max: 'auto-notice', promoteAfter: 5 },
  fix_ci: { level: 'suggest', max: 'auto-notice', promoteAfter: 10 },
  create_widget: { level: 'suggest', max: 'auto-notice', promoteAfter: 5 },
  // Builds spend usage and open tickets, so they're always asked. Installs follow a guarded,
  // green auto-merge, so they just show up with Undo.
  build_code_widget: { level: 'suggest', max: 'suggest', promoteAfter: 0 },
  install_code_widget: { level: 'auto-notice', max: 'auto-notice', promoteAfter: 0 },
  fix_widget: { level: 'suggest', max: 'suggest', promoteAfter: 0 },
  // Forge stop-points are yours by definition; creating a repo is outward.
  forge_review: { level: 'suggest', max: 'suggest', promoteAfter: 0 },
  forge_questions: { level: 'suggest', max: 'suggest', promoteAfter: 0 },
  forge_create_repo: { level: 'suggest', max: 'suggest', promoteAfter: 0 },
  // Merging is a hard ceiling until you promote it: green checks only, one exact commit.
  forge_merge_pr: { level: 'suggest', max: 'auto-notice', promoteAfter: 5 },
  forge_question: { level: 'suggest', max: 'suggest', promoteAfter: 0 },
  // A preview under your Cloudflare login, never production: asked until you promote it.
  forge_demo: { level: 'suggest', max: 'auto-notice', promoteAfter: 5 },
  // Drafts only, but about selling your product: always asked.
  forge_sell: { level: 'suggest', max: 'suggest', promoteAfter: 0 },
  reminder: { level: 'suggest', max: 'suggest', promoteAfter: 0 },
  claude_task: { level: 'suggest', max: 'suggest', promoteAfter: 0 },
  promote_policy: { level: 'suggest', max: 'suggest', promoteAfter: 0 },
};
const FALLBACK = { level: 'suggest', max: 'suggest', promoteAfter: 0 };

const cells = line =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(c => c.trim());
const num = v => (/^\d+$/.test(v) ? Number(v) : 0);

/** One table row. Accepts the current 5-column form and the older 4-column one (no `max`). */
function parseRow(c) {
  const [action, level] = c;
  const base = DEFAULTS[action] ?? FALLBACK;
  const max = c.length >= 5 && LEVELS.includes(c[2]) ? c[2] : base.max;
  const [promote, streak] = c.length >= 5 ? [c[3], c[4]] : [c[2], c[3]];
  return [action, { level: LEVELS.includes(level) ? level : base.level, max, promoteAfter: num(promote) || base.promoteAfter, streak: num(streak) }];
}

export function parsePolicy(md = '') {
  const rows = new Map(Object.entries(DEFAULTS).map(([a, d]) => [a, { ...d, streak: 0 }]));
  for (const line of md.split(/\r?\n/).filter(l => /^\|/.test(l.trim()))) {
    const c = cells(line);
    if (!c[0] || c[0] === 'action' || /^-+$/.test(c[0])) continue;
    const [action, row] = parseRow(c);
    rows.set(action, row);
  }
  const never = [...(md.split(/^## Never suggest/m)[1] ?? '').split(/^## /m)[0].matchAll(/^- `([^`]+)`/gm)].map(m => m[1]);
  return { rows, never };
}

const HEADER = `---
type: policy
---
# Autonomy policy

Each action type has a trust level:
- **suggest:** the action needs a click.
- **auto-notice:** it runs on its own, shows up as done, and has an Undo button.
- **silent:** it only gets logged.

After *promote after* approvals in a row, a card proposes the next level (up to *max*). The promotion itself needs your approval. Any reject or undo drops the type one level and resets the streak. You can edit this table by hand; the executor rewrites it after each decision.
`;

const CEILINGS = `## Hard ceilings (max stays at suggest)
- Sending anything to other people.
- Spending money.
- Deleting.
- Touching anything outside the vault and repos.
- Pushing to main or merging.
`;

export function renderPolicy({ rows, never }) {
  const table = [
    '| action | level | max | promote after | approvals in a row |',
    '|---|---|---|---|---|',
    ...[...rows].map(([a, r]) => `| ${a} | ${r.level} | ${r.max} | ${r.promoteAfter || '—'} | ${r.streak} |`),
  ];
  const neverList = never.length ? never.map(k => `- \`${k}\``).join('\n') : '- (none yet)';
  return `${HEADER}\n${table.join('\n')}\n\n## Never suggest\nCards whose action type or key is listed here are never created.\n${neverList}\n\n${CEILINGS}`;
}

export const rowFor = (policy, action) => policy.rows.get(action) ?? { ...(DEFAULTS[action] ?? FALLBACK), streak: 0 };
export const levelFor = (policy, action) => rowFor(policy, action).level;
const nextLevel = level => LEVELS[Math.min(rank(level) + 1, LEVELS.length - 1)];
const capped = (level, max) => (rank(level) > rank(max) ? max : level);

/**
 * Applies one human decision (approved, rejected or undone) to a copy of the policy.
 * Returns the new policy and, when the streak has earned it, the promotion to propose.
 */
export function applyDecision(policy, { action, kind, always = false, never = false, key = null }) {
  const rows = new Map(policy.rows);
  const row = { ...rowFor(policy, action) };
  const neverList = never && key && !policy.never.includes(key) ? [...policy.never, key] : policy.never;
  if (kind === 'approved') {
    row.streak += 1;
    if (always) row.level = capped(LEVELS[Math.max(rank(row.level), 1)], row.max);
  } else {
    row.streak = 0;
    row.level = LEVELS[Math.max(rank(row.level) - 1, 0)];
  }
  rows.set(action, row);
  const target = nextLevel(row.level);
  const earned = kind === 'approved' && row.promoteAfter > 0 && row.streak >= row.promoteAfter && rank(target) > rank(row.level) && rank(target) <= rank(row.max);
  return { policy: { rows, never: neverList }, promote: earned ? { action, to: target } : null };
}

/** Sets a type's level directly (an approved promotion card), within its max. */
export function promote(policy, action, to) {
  const rows = new Map(policy.rows);
  const row = { ...rowFor(policy, action) };
  row.level = capped(to, row.max);
  row.streak = 0;
  rows.set(action, row);
  return { ...policy, rows };
}

export const isNever = (policy, { action, key }) => policy.never.includes(action) || policy.never.includes(key);
