// The GitHub CLI on the user's own login: issues, labels and repos without an API key.
// Every caller takes the runner as a parameter, so tests pass a fake with the same shape.
import { execFileSync } from 'node:child_process';

/** Runs `gh <args>`; `input` goes to stdin. Returns stdout. */
export const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });

/** Foundry's agent labels plus the ones this repo's flows use. */
export const LABELS = {
  'agent-feature': '1d76db', 'agent:ready': '0e8a16', 'agent:working': 'fbca04', 'agent:blocked': 'b60205',
  'widget:code': '5319e7', 'widget:needs-review': 'd93f0b', epic: '3e4b9e',
};

/** Creates or updates the given labels on a repo (idempotent). */
export function ensureLabels(run, repo, names) {
  for (const name of names) run(['label', 'create', name, '--repo', repo, '--color', LABELS[name] ?? 'ededed', '--force']);
}

/** Opens an issue (body on stdin) and returns its URL. */
export function createIssue(run, repo, { title, body, labels = [] }) {
  const out = run(['issue', 'create', '--repo', repo, '--title', title, ...labels.flatMap(l => ['--label', l]), '--body-file', '-'], body);
  return out.trim().split('\n').pop();
}
