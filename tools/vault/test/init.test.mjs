import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTemplate, updateSystem, writeToolsConfig } from '../init.mjs';
import { syncProjects, projectNote, DOCS_START } from '../projects.mjs';
import { setFrontmatter } from '../../lib/frontmatter.mjs';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'vault-template');
const TODAY = new Date('2026-10-11');
const tmpVault = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));

const explorer = (dir = 'C:\\Users\\akash\\Projects\\movie-explorer') => ({
  name: 'Movie Explorer', path: dir, github: 'cmaintz/movie-explorer',
  lastCommitDate: '2026-10-01T10:00:00Z', languages: ['TypeScript'],
  docs: [
    { type: 'adr', path: 'docs/adr/0001 use astro.md', modified: '2026-09-01T00:00:00Z', tracked: true },
    { type: 'note', path: 'scratch.md', modified: '2026-10-02T00:00:00Z', tracked: false },
  ],
});

test('copies template and never overwrites existing files', () => {
  const v = tmpVault();
  fs.writeFileSync(path.join(v, 'Home.md'), 'mine');
  const r = copyTemplate(TEMPLATE, v);
  assert.equal(fs.readFileSync(path.join(v, 'Home.md'), 'utf8'), 'mine');
  assert.ok(r.skipped.some(f => f.endsWith('Home.md')));
  assert.ok(fs.existsSync(path.join(v, '.claude', 'skills', 'today', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(v, 'Bases', 'Sessions.base')));
  assert.equal(copyTemplate(TEMPLATE, v).created.length, 0);
});

test('new project notes get schema frontmatter and Repo / Local-only doc lists', () => {
  const v = tmpVault();
  const old = { name: 'old', path: '/p/old', lastCommitDate: '2024-01-01T00:00:00Z', docs: [] };
  assert.equal(syncProjects(v, { projects: [explorer(), old] }, TODAY).created.length, 2);
  const note = fs.readFileSync(path.join(v, 'Projects', 'movie-explorer.md'), 'utf8');
  assert.match(note, /^---\ntype: project\nstatus: active\n/);
  assert.match(note, /path: "C:\\\\Users\\\\akash\\\\Projects\\\\movie-explorer"/);
  assert.match(note, /\*\*Repo\*\* \(1\)\n- adr · \[docs\/adr\/0001 use astro.md\]\(https:\/\/github.com\/cmaintz\/movie-explorer\/blob\/HEAD\/docs\/adr\/0001%20use%20astro.md\)/);
  assert.match(note, /\*\*Local only\*\* \(1\)\n- note · \[scratch.md\]\(file:\/\/\/C:\/Users\/akash\/Projects\/movie-explorer\/scratch.md\)/);
  assert.match(projectNote(old, TODAY), /status: paused/);
});

test('re-sync after a move refreshes path and docs but keeps what the user wrote', () => {
  const v = tmpVault();
  syncProjects(v, { projects: [explorer()] }, TODAY);
  const file = path.join(v, 'Projects', 'movie-explorer.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: active', 'status: paused').replace('## Tasks\n', '## Tasks\n- [ ] my task\n'));
  const moved = explorer('C:\\Users\\akash\\Projects\\web\\movie-explorer');
  moved.docs.push({ type: 'audit', path: 'AUDIT.md', modified: '2026-10-05T00:00:00Z', tracked: true });
  const r = syncProjects(v, { projects: [moved] }, TODAY);
  assert.equal(r.refreshed.length, 1);
  const note = fs.readFileSync(file, 'utf8');
  assert.match(note, /path: "C:\\\\Users\\\\akash\\\\Projects\\\\web\\\\movie-explorer"/);
  assert.match(note, /status: paused/);
  assert.match(note, /- \[ \] my task/);
  assert.match(note, /\*\*Repo\*\* \(2\)/);
  assert.equal(note.split(DOCS_START).length, 2);
  assert.equal(syncProjects(v, { projects: [moved] }, TODAY).unchanged.length, 1);
});

test('clones of one repo keep their own notes and worktrees get none', () => {
  const v = tmpVault();
  const school = { ...explorer('C:\\Users\\akash\\Projects\\school\\movie-explorer'), name: 'movie-explorer' };
  const archive = { ...explorer('C:\\Users\\akash\\Projects\\_archive\\movie-explorer'), name: 'movie-explorer' };
  const wt = { ...explorer('C:\\Users\\akash\\Projects\\school\\_wt\\feature'), name: 'feature', worktree: true };
  const r = syncProjects(v, { projects: [school, archive, wt] }, TODAY);
  assert.deepEqual(r.created.map(f => path.basename(f)), ['movie-explorer.md', 'archive-movie-explorer.md']);
  const pathOf = f => fs.readFileSync(path.join(v, 'Projects', f), 'utf8').match(/^path: (.*)$/m)[1];
  const again = syncProjects(v, { projects: [archive, school, wt] }, TODAY);
  assert.equal(again.unchanged.length, 2);
  assert.equal(JSON.parse(pathOf('movie-explorer.md')), school.path);
  assert.equal(JSON.parse(pathOf('archive-movie-explorer.md')), archive.path);
});

test('a moved checkout takes its old note only when no project sits at that note\'s path', () => {
  const v = tmpVault();
  syncProjects(v, { projects: [explorer()] }, TODAY);
  const moved = explorer('C:\\Users\\akash\\Projects\\web\\movie-explorer');
  const clone = explorer();
  const r = syncProjects(v, { projects: [moved, clone] }, TODAY);
  assert.equal(r.unchanged.length, 1, 'the clone still at the old path keeps the note');
  assert.deepEqual(r.created.map(f => path.basename(f)), ['web-movie-explorer.md']);
});

test('older notes without a docs block get one before the Log', () => {
  const v = tmpVault();
  fs.mkdirSync(path.join(v, 'Projects'));
  fs.writeFileSync(path.join(v, 'Projects', 'movie-explorer.md'), '---\ntype: project\nrepo: cmaintz/movie-explorer\n---\n# X\n\n## Log\n- did a thing\n');
  syncProjects(v, { projects: [explorer()] }, TODAY);
  const note = fs.readFileSync(path.join(v, 'Projects', 'movie-explorer.md'), 'utf8');
  assert.match(note, /## Docs\n<!-- docs:start[\s\S]*<!-- docs:end -->\n\n## Log\n- did a thing/);
  assert.match(note, /^path: "C:/m);
});

test('setFrontmatter replaces or adds a key', () => {
  assert.equal(setFrontmatter('---\na: 1\n---\nx', 'a', '$2'), '---\na: $2\n---\nx');
  assert.equal(setFrontmatter('---\na: 1\n---\nx', 'b', '2'), '---\na: 1\nb: 2\n---\nx');
});

test('--update-system refreshes system files only, with a backup', () => {
  const v = tmpVault();
  copyTemplate(TEMPLATE, v);
  fs.writeFileSync(path.join(v, 'CLAUDE.md'), 'old contract');
  fs.writeFileSync(path.join(v, 'Home.md'), 'my home');
  const updated = updateSystem(TEMPLATE, v, 42);
  assert.deepEqual(updated, ['CLAUDE.md']);
  assert.equal(fs.readFileSync(path.join(v, '_system', 'backup', '42', 'CLAUDE.md'), 'utf8'), 'old contract');
  assert.equal(fs.readFileSync(path.join(v, 'Home.md'), 'utf8'), 'my home');
  assert.deepEqual(updateSystem(TEMPLATE, v, 43), []);
});

test('tools.json points the vault skills at this repo', () => {
  const v = tmpVault();
  writeToolsConfig(v, 'C:\\Users\\akash\\Projects\\productivity-os');
  const cfg = JSON.parse(fs.readFileSync(path.join(v, '_system', 'tools.json'), 'utf8'));
  assert.equal(cfg.productivityOs, 'C:/Users/akash/Projects/productivity-os');
});

test('a renamed folder keeps its note even when a new clone of another repo takes its old name', () => {
  const v = tmpVault();
  syncProjects(v, { projects: [explorer()] }, TODAY);
  const renamed = { ...explorer('C:\\Users\\akash\\Projects\\web\\films'), name: 'films' };
  const other = { ...explorer('C:\\Users\\akash\\Projects\\work\\movie-explorer'), name: 'movie-explorer', github: 'someone/movie-explorer' };
  const r = syncProjects(v, { projects: [other, renamed] }, TODAY);
  assert.equal(r.refreshed.length, 1);
  assert.deepEqual(r.created.map(f => path.basename(f)), ['work-movie-explorer.md']);
  assert.match(fs.readFileSync(path.join(v, 'Projects', 'movie-explorer.md'), 'utf8'), /^path: ".*web\\\\films"$/m);
});
