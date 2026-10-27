// Which project a session belongs to (tools/vault/projects.mjs): used by the session notes
// built from Claude Code's transcripts (tools/sessions/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectFor } from '../../vault/projects.mjs';

test('sessions link to the note whose path is their checkout, and worktrees to their main checkout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const vault = path.join(root, 'Vault');
  const main = path.join(root, 'school', 'site');
  const clone = path.join(root, '_archive', 'site');
  const wt = path.join(root, 'school', '_wt', 'feature');
  for (const d of [main, clone]) {
    fs.mkdirSync(d, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: d });
  }
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main });
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature', wt], { cwd: main });
  fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Projects', 'site.md'), `---\npath: ${JSON.stringify(main)}\n---\n`);
  fs.writeFileSync(path.join(vault, 'Projects', 'archive-site.md'), `---\npath: ${JSON.stringify(clone)}\n---\n`);
  assert.deepEqual(projectFor(path.join(main, 'src'), vault), { slug: 'site', note: 'Projects/site' });
  assert.deepEqual(projectFor(clone, vault), { slug: 'archive-site', note: 'Projects/archive-site' });
  assert.deepEqual(projectFor(wt, vault), { slug: 'site', note: 'Projects/site' });
});
