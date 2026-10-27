import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarise, githubBlock, githubFields, GH_START } from '../github.mjs';
import { syncVault, notesWithRepo } from '../sync.mjs';

const NOW = new Date('2026-10-13T08:30:00Z');
const rollup = state => ({ statusCheckRollup: state ? { state } : null });
const pr = (number, extra = {}, state = 'SUCCESS') => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  isDraft: false,
  reviewDecision: 'REVIEW_REQUIRED',
  updatedAt: '2026-10-12T00:00:00Z',
  commits: { nodes: [{ commit: rollup(state) }] },
  ...extra,
});
const issue = (number, labels = []) => ({ number, title: `Issue ${number}`, url: `https://github.com/o/r/issues/${number}`, labels: { nodes: labels.map(name => ({ name })) } });

const REPO = {
  url: 'https://github.com/o/r',
  isArchived: false,
  defaultBranchRef: { name: 'main', target: rollup('FAILURE') },
  pullRequests: { totalCount: 2, nodes: [pr(91, { reviewDecision: 'APPROVED' }), pr(92, { isDraft: true }, 'FAILURE')] },
  issues: { totalCount: 3, nodes: [issue(5, ['agent:blocked']), issue(6, ['agent:ready']), issue(7, ['bug'])] },
};

test('summary, block and frontmatter fields', () => {
  const s = summarise(REPO);
  assert.equal(s.ci, 'failing');
  assert.equal(s.agent.blocked.length, 1);
  assert.deepEqual(
    s.otherIssues.map(i => i.number),
    [7],
  );
  const block = githubBlock(s, NOW.toISOString());
  assert.match(block, /\*\*main:\*\* ❌ failing · \[repo\]\(https:\/\/github.com\/o\/r\) · synced 2026-10-13 08:30/);
  assert.match(block, /- \[#91\]\(https:\/\/github.com\/o\/r\/pull\/91\) PR 91 · CI ✅ · approved/);
  assert.match(block, /- \[#92\]\(.*\) PR 92 · CI ❌ · needs review · draft/);
  assert.match(block, /\*\*Agent tickets:\*\* ready 1 · working 0 · blocked 1\n- ⛔ \[#5\]/);
  assert.match(block, /\*\*Open issues\*\* \(3\)\n- \[#7\]/);
  assert.deepEqual(githubFields(s, NOW.toISOString()), { ci: 'failing', open_prs: 2, failing_prs: 1, agent_blocked: 1, github_synced: '2026-10-13' });
});

test('sync writes the block before Docs, updates frontmatter, and keeps going past failures', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'));
  fs.mkdirSync(path.join(vault, 'Projects'));
  const note = '---\ntype: project\nstatus: active\nrepo: o/r\n---\n# r\n\n## Tasks\n- [ ] keep me\n\n## Docs\nx\n\n## Log\n';
  fs.writeFileSync(path.join(vault, 'Projects', 'r.md'), note);
  fs.writeFileSync(path.join(vault, 'Projects', 'gone.md'), '---\nrepo: o/gone\n---\n');
  fs.writeFileSync(path.join(vault, 'Projects', 'local.md'), '---\nrepo: \n---\n');
  assert.equal(notesWithRepo(vault).length, 2);
  const fetch = repo => {
    if (repo === 'o/gone') throw new Error('Could not resolve to a Repository');
    return REPO;
  };
  const r = syncVault(vault, { fetch, now: NOW });
  assert.deepEqual(r.updated, ['o/r']);
  assert.match(r.failed[0].error, /Could not resolve/);
  const out = fs.readFileSync(path.join(vault, 'Projects', 'r.md'), 'utf8');
  assert.match(out, /^ci: failing$/m);
  assert.match(out, /^open_prs: 2$/m);
  assert.match(out, /- \[ \] keep me/);
  assert.match(out, /## GitHub\n<!-- github:start[\s\S]*<!-- github:end -->\n\n## Docs/);
  syncVault(vault, { fetch, now: NOW });
  assert.equal(fs.readFileSync(path.join(vault, 'Projects', 'r.md'), 'utf8').split(GH_START).length, 2);
});
