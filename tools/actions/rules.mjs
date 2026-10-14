// Deterministic suggestion rules: vault state in, card specs out. No model calls here;
// these cover the obvious cases cheaply. The /suggest skill adds judgement-based cards
// on top (as `claude_task`), through cards.mjs.

const STALE_DAYS = 21;
const INBOX_THRESHOLD = 5;

const daysSince = (date, now) => (date ? (now - new Date(date)) / 864e5 : Infinity);
const linkTo = p => `[[Projects/${p.slug}]]`;

function fixCi(p) {
  return {
    action: 'fix_ci', key: `fix_ci:${p.repo}`, risk: 'medium',
    title: `Fix failing CI on ${p.slug}`,
    reason: `The default branch of ${p.repo} is failing.`,
    context: linkTo(p),
    explain: `a Claude Code session in ${p.path} finds the cause, fixes it on a new branch and opens a PR. It never pushes to main or merges.`,
    undo: 'close the PR and delete its branch.',
    params: {
      cwd: p.path,
      prompt: `CI on the default branch of ${p.repo} is failing. Find the failing check (gh run list / gh run view --log-failed), reproduce it locally, fix the root cause on a new branch named fix/ci-<short-description>, run the repo's own checks, then push the branch and open a PR with gh pr create. Never push to main, never merge, never skip or disable a test. End with a 3-line summary: cause, fix, PR URL.`,
    },
  };
}

function pauseStale(p, now) {
  return {
    action: 'pause_stale_project', key: `pause:${p.slug}:${p.updated}`, risk: 'low',
    title: `Mark ${p.slug} as paused`,
    reason: `Active, but nothing has happened for ${Math.floor(daysSince(p.updated, now))} days.`,
    context: linkTo(p),
    explain: 'its status becomes `paused`, so it drops out of the Active list and /next stops nagging about it.',
    undo: 'press Undo here, or set status back to active.',
    params: { file: `Projects/${p.slug}.md`, key: 'status', value: 'paused' },
  };
}

function blockedTicket(p) {
  return {
    action: 'reminder', key: `blocked:${p.repo}:${p.agent_blocked}`, risk: 'low',
    title: `Agent ticket blocked on ${p.slug}`,
    reason: `${p.agent_blocked} Foundry ticket(s) labelled agent:blocked are waiting on you.`,
    context: linkTo(p),
    explain: 'nothing runs. This is a reminder; see the GitHub section of the project note for the issue links.',
    undo: 'nothing to undo.',
    params: {},
  };
}

function triageInbox(count, now) {
  return {
    action: 'triage_inbox', key: `triage:${now.toISOString().slice(0, 10)}`, risk: 'low',
    title: `Triage ${count} inbox notes`,
    reason: `${count} notes are waiting in Inbox/.`,
    context: '[[Inbox]]',
    explain: 'Claude files each one per CLAUDE.md (project task, writing idea, spec, or left in Inbox if unsure) and logs every move.',
    undo: 'revert the vault commit for this run.',
    params: { prompt: 'Triage every note in Inbox/ following CLAUDE.md and the /capture rules. Log each move to _system/changelog.md. If unsure about a note, leave it. End with one line per note: where it went.' },
  };
}

/**
 * projects: [{ slug, repo, path, status, updated, ci, agent_blocked }], inboxCount: number.
 * Returns card specs; cards.mjs drops duplicates and anything on the never list.
 */
export function suggestions({ projects = [], inboxCount = 0 }, now = new Date()) {
  const out = [];
  for (const p of projects.filter(x => x.status === 'active')) {
    if (p.ci === 'failing' && p.repo && p.path) out.push(fixCi(p));
    if (daysSince(p.updated, now) >= STALE_DAYS) out.push(pauseStale(p, now));
    if (Number(p.agent_blocked) > 0 && p.repo) out.push(blockedTicket(p));
  }
  if (inboxCount >= INBOX_THRESHOLD) out.push(triageInbox(inboxCount, now));
  return out;
}
