#!/usr/bin/env node
// Generates dashboard/src/lib/demo-snapshot.json by running a fixture vault through the real
// pipeline (vault template -> widgets -> snapshot), so demo mode can never drift from what the
// PC actually publishes. A test fails if the committed file is out of date.
// Usage: node tools/widgets/demo.mjs [--check]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTemplate } from '../vault/init.mjs';
import { createCard, listCards, updateCard, appendResult } from '../actions/cards.mjs';
import { buildSnapshot } from '../dashboard/snapshot.mjs';
import { newForge } from '../forge/forge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEMO_FILE = path.join(ROOT, 'dashboard', 'src', 'lib', 'demo-snapshot.json');
const NOW = new Date('2026-10-14T12:00:00Z');
const at = minutesAgo => new Date(NOW.valueOf() - minutesAgo * 60_000).toISOString();

const note = (v, rel, fm, body = '') => {
  fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true });
  fs.writeFileSync(path.join(v, rel), `---\n${Object.entries(fm).map(([k, x]) => `${k}: ${JSON.stringify(x)}`).join('\n')}\n---\n${body}`);
};

function projects(v) {
  const p = (slug, fm) => note(v, `Projects/${slug}.md`, { type: 'project', repo: `cmaintz/${slug}`, ...fm }, `# ${slug}\n`);
  p('cmaintz-site', { status: 'active', priority: 1, next: 'Ship the Keystatic editor', ci: 'failing', open_prs: 2, failing_prs: 1, agent_blocked: 0, updated: '2026-10-13' });
  p('foundry', { status: 'active', priority: 1, next: 'Extract ticket-to-PR', ci: 'passing', open_prs: 1, failing_prs: 0, agent_blocked: 1, updated: '2026-10-14' });
  p('productivity-os', { status: 'active', priority: 2, next: 'Widget runtime', ci: 'passing', open_prs: 1, failing_prs: 0, agent_blocked: 0, updated: '2026-10-14' });
  p('yatzyweb', { status: 'paused', priority: 3, ci: 'none', updated: '2026-08-01' });
}

function sessions(v) {
  const s = (id, project, status, mins, extra = {}) => note(v, `Sessions/2026-10-14-${project}-${id}.md`,
    { type: 'session', status, project: `[[Projects/${project}]]`, prompts: 5, started: at(mins + 60), updated: at(mins), ...extra }, `# ${project}\n`);
  s('aaaa1111', 'productivity-os', 'waiting', 3, { waiting_for: 'Claude needs your permission to use Bash' });
  s('bbbb2222', 'foundry', 'running', 1);
  s('cccc3333', 'cmaintz-site', 'idle', 240);
}

function cards(v) {
  createCard(v, { action: 'fix_ci', key: 'fix_ci:cmaintz/cmaintz-site', risk: 'medium', title: 'Fix failing CI on cmaintz-site', reason: 'The default branch of cmaintz/cmaintz-site is failing.', context: '[[Projects/cmaintz-site]]' }, at(40));
  createCard(v, { action: 'pause_stale_project', key: 'pause:yatzyweb', title: 'Mark yatzyweb as paused', reason: 'Active, but nothing has happened for 74 days.', context: '[[Projects/yatzyweb]]' }, at(90));
  createCard(v, { action: 'triage_inbox', key: 'triage:2026-10-14', title: 'Triage 6 inbox notes', reason: '6 notes are waiting in Inbox/.', context: '[[Inbox]]' }, at(200));
  const triage = listCards(v).find(c => c.action === 'triage_inbox');
  fs.writeFileSync(triage.file, appendResult(updateCard(triage.text, { status: 'done', finished_at: at(190) }), '**Done (2026-10-14 08:50):** filed the notes.'));
}

function writing(v) {
  const w = (slug, status, date) => note(v, `Writing/${slug}.md`, { type: 'post', status, ...(date ? { publish_date: date } : {}) }, `# ${slug.replace(/-/g, ' ')}\n`);
  w('one-rule-set-three-placements', 'published', '2026-09-28');
  w('foundry-and-agents', 'draft', '2026-10-20');
  w('vault-as-an-os', 'idea');
  w('why-keystatic', 'edit', '2026-10-17');
}

export function demoSnapshot() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-vault-'));
  copyTemplate(path.join(ROOT, 'vault-template'), v);
  projects(v); sessions(v); cards(v); writing(v);
  newForge(v, 'Shared shopping lists for flatmates', { now: new Date(at(30)) });
  note(v, 'Daily/2026-10-14.md', { type: 'daily' }, '# Today\n\n## Top 3\n1. Fix CI on cmaintz-site\n2. Draft the Foundry post\n3. Review agent ticket #12\n\n## Tasks\n- [ ] a\n- [ ] b\n- [ ] c\n- [x] d\n');
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(v, 'Inbox', `n${i}.md`), 'x');
  const snap = buildSnapshot(v, { now: NOW, host: 'demo-pc' });
  fs.rmSync(v, { recursive: true, force: true });
  return snap;
}

export const demoJson = () => JSON.stringify(demoSnapshot(), null, 2) + '\n';

function main() {
  if (process.argv.includes('--check')) {
    const ok = fs.existsSync(DEMO_FILE) && fs.readFileSync(DEMO_FILE, 'utf8') === demoJson();
    console.log(ok ? 'demo snapshot is up to date' : 'demo snapshot is stale: run node tools/widgets/demo.mjs');
    process.exit(ok ? 0 : 1);
  }
  fs.writeFileSync(DEMO_FILE, demoJson());
  console.log(`wrote ${path.relative(ROOT, DEMO_FILE)}`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'demo.mjs') main();
