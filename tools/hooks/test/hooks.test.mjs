import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateNote, activityLine } from '../sessions.mjs';
import { readFrontmatter } from '../../lib/frontmatter.mjs';
import { withHook, withoutHook, hookCommand, EVENTS } from '../install.mjs';
import { projectFor } from '../session-hook.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'session-hook.mjs');
const project = { slug: 'site', note: 'Projects/site' };
const ev = (hook_event_name, extra = {}) => ({ hook_event_name, session_id: 'abcdef1234', cwd: '/p/site', ...extra });

test('session note follows the event stream', () => {
  let note = updateNote(null, ev('SessionStart'), project, '2026-10-11T09:00:00.000Z');
  note = updateNote(note, ev('UserPromptSubmit', { prompt: 'fix the\nbuild please' }), project, '2026-10-11T09:01:00.000Z');
  let f = readFrontmatter(note).fields;
  assert.equal(f.status, 'running');
  assert.equal(f.prompts, '1');
  assert.equal(f.project, '"[[Projects/site]]"');
  assert.equal(f.last_prompt, '"fix the build please"');
  note = updateNote(note, ev('Notification', { message: 'Claude needs your permission to use Bash' }), project, '2026-10-11T09:02:00.000Z');
  f = readFrontmatter(note).fields;
  assert.equal(f.status, 'waiting');
  assert.match(f.waiting_for, /permission/);
  note = updateNote(note, ev('Stop'), project, '2026-10-11T09:03:00.000Z');
  f = readFrontmatter(note).fields;
  assert.equal(f.status, 'idle');
  assert.equal(f.waiting_for, '""');
  assert.equal(f.started, '"2026-10-11T09:00:00.000Z"');
  assert.match(note, /## Prompts\n- 09:01 fix the build please\n$/);
});

test('long prompts are shortened in the note but kept whole in the activity log', () => {
  const long = 'x'.repeat(500);
  const note = updateNote(null, ev('UserPromptSubmit', { prompt: long }), project, '2026-10-11T09:00:00.000Z');
  assert.ok(readFrontmatter(note).fields.last_prompt.length < 170);
  assert.equal(JSON.parse(activityLine(ev('UserPromptSubmit', { prompt: long }), project, 'now')).prompt, long);
});

test('installer adds one hook per event, idempotently, and keeps other hooks', () => {
  const other = { hooks: [{ type: 'command', command: 'echo other' }] };
  const start = { model: 'x', hooks: { Stop: [other] } };
  const once = withHook(start, hookCommand('C:\\tools\\session-hook.mjs'));
  const twice = withHook(once, hookCommand('C:\\new\\session-hook.mjs'));
  assert.deepEqual(Object.keys(twice.hooks).sort(), [...EVENTS].sort());
  assert.equal(twice.hooks.Stop.length, 2);
  assert.equal(twice.hooks.Stop[1].hooks[0].command, 'node "C:/new/session-hook.mjs"');
  assert.equal(twice.model, 'x');
  assert.deepEqual(withoutHook(twice).hooks, { Stop: [other] });
});

test('hook script writes the session note, prints nothing, and reuses the note across days', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-'));
  fs.mkdirSync(path.join(vault, 'Sessions'));
  fs.mkdirSync(path.join(vault, 'Projects'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  fs.mkdirSync(path.join(repo, '.git'));
  const run = input => execFileSync('node', [HOOK], { input: JSON.stringify(input), env: { ...process.env, PRODUCTIVITY_VAULT: vault }, encoding: 'utf8' });
  assert.equal(run(ev('SessionStart', { cwd: path.join(repo) })), '');
  fs.renameSync(path.join(vault, 'Sessions', fs.readdirSync(path.join(vault, 'Sessions'))[0]), path.join(vault, 'Sessions', '2020-01-01-x-abcdef12.md'));
  assert.equal(run(ev('UserPromptSubmit', { cwd: repo, prompt: 'hi' })), '');
  assert.deepEqual(fs.readdirSync(path.join(vault, 'Sessions')), ['2020-01-01-x-abcdef12.md']);
  assert.equal(fs.readFileSync(path.join(vault, '_system', 'activity.jsonl'), 'utf8').trim().split('\n').length, 2);
  assert.equal(run({ garbage: true }), '');
});

test('hook does nothing when the vault is missing', () => {
  const out = execFileSync('node', [HOOK], { input: JSON.stringify(ev('Stop')), env: { ...process.env, PRODUCTIVITY_VAULT: '/nonexistent/vault' }, encoding: 'utf8' });
  assert.equal(out, '');
});

test('sessions link to the note whose path is their checkout, and worktrees to their main checkout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const vault = path.join(root, 'Vault');
  const main = path.join(root, 'school', 'site');
  const clone = path.join(root, '_archive', 'site');
  const wt = path.join(root, 'school', '_wt', 'feature');
  for (const d of [main, clone]) { fs.mkdirSync(d, { recursive: true }); execFileSync('git', ['init', '-q'], { cwd: d }); }
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main });
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature', wt], { cwd: main });
  fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Projects', 'site.md'), `---\npath: ${JSON.stringify(main)}\n---\n`);
  fs.writeFileSync(path.join(vault, 'Projects', 'archive-site.md'), `---\npath: ${JSON.stringify(clone)}\n---\n`);
  assert.deepEqual(projectFor(path.join(main, 'src'), vault), { slug: 'site', note: 'Projects/site' });
  assert.deepEqual(projectFor(clone, vault), { slug: 'archive-site', note: 'Projects/archive-site' });
  assert.deepEqual(projectFor(wt, vault), { slug: 'site', note: 'Projects/site' });
});
