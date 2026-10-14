import type { Snapshot } from './types';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export function demoSnapshot(): Snapshot {
  return {
    version: 1,
    generatedAt: ago(1),
    host: 'demo-pc',
    today: { date: ago(0).slice(0, 10), top3: ['Fix CI on cmaintz-site', 'Draft the Foundry post', 'Review agent ticket #12'], openTasks: 4 },
    counts: { pendingCards: 2, waitingSessions: 1, attention: 2, activeProjects: 3, inbox: 6 },
    cards: [
      { file: '_system/actions/demo-fix-ci.md', key: 'fix_ci:cmaintz/cmaintz-site', title: 'Fix failing CI on cmaintz-site', action: 'fix_ci', risk: 'medium', status: 'pending', reason: 'The default branch of cmaintz/cmaintz-site is failing.', context: '[[Projects/cmaintz-site]]', created: ago(40), expires: ago(-60 * 24 * 6).slice(0, 10), decided_by: null, finished_at: null, result: null },
      { file: '_system/actions/demo-pause.md', key: 'pause:yatzyweb:2026-08-01', title: 'Mark yatzyweb as paused', action: 'pause_stale_project', risk: 'low', status: 'pending', reason: 'Active, but nothing has happened for 74 days.', context: '[[Projects/yatzyweb]]', created: ago(90), expires: ago(-60 * 24 * 6).slice(0, 10), decided_by: null, finished_at: null, result: null },
      { file: '_system/actions/demo-triage.md', key: 'triage:today', title: 'Triage 6 inbox notes', action: 'triage_inbox', risk: 'low', status: 'done', reason: '6 notes are waiting in Inbox/.', context: '[[Inbox]]', created: ago(200), expires: '', decided_by: 'policy', finished_at: ago(190), result: '**Done:** filed 5 notes, left 1 in Inbox (unclear).' },
    ],
    sessions: [
      { project: 'productivity-os', status: 'waiting', waiting_for: 'Claude needs your permission to use Bash', prompts: 12, started: ago(120), updated: ago(3) },
      { project: 'foundry', status: 'running', waiting_for: null, prompts: 4, started: ago(30), updated: ago(1) },
      { project: 'cmaintz-site', status: 'idle', waiting_for: null, prompts: 7, started: ago(300), updated: ago(240) },
    ],
    projects: [
      { slug: 'cmaintz-site', status: 'active', priority: 1, next: 'Ship the Keystatic editor', repo: 'cmaintz/cmaintz-site', ci: 'failing', open_prs: 2, failing_prs: 1, agent_blocked: 0, updated: ago(60 * 24).slice(0, 10) },
      { slug: 'foundry', status: 'active', priority: 1, next: 'Extract ticket-to-PR', repo: 'cmaintz/foundry', ci: 'passing', open_prs: 1, failing_prs: 0, agent_blocked: 1, updated: ago(60 * 5).slice(0, 10) },
      { slug: 'productivity-os', status: 'active', priority: 1, next: 'Web dashboard', repo: 'cmaintz/productivity-os', ci: 'passing', open_prs: 1, failing_prs: 0, agent_blocked: 0, updated: ago(10).slice(0, 10) },
      { slug: 'yatzyweb', status: 'paused', priority: 3, next: null, repo: 'cmaintz/yatzyweb', ci: 'none', open_prs: 0, failing_prs: 0, agent_blocked: 0, updated: '2026-08-01' },
    ],
  };
}
