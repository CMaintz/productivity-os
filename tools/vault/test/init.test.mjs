import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTemplate, seedProjects, projectNote } from '../init.mjs';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'vault-template');

test('copies template and never overwrites existing files', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  fs.writeFileSync(path.join(v, 'Home.md'), 'mine');
  const r = copyTemplate(TEMPLATE, v);
  assert.equal(fs.readFileSync(path.join(v, 'Home.md'), 'utf8'), 'mine');
  assert.ok(r.skipped.some(f => f.endsWith('Home.md')));
  assert.ok(fs.existsSync(path.join(v, 'CLAUDE.md')));
  assert.ok(fs.existsSync(path.join(v, '.claude', 'skills', 'today', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(v, 'Bases', 'Projects.base')));
  const again = copyTemplate(TEMPLATE, v);
  assert.equal(again.created.length, 0);
});

test('seeds project notes from inventory with schema frontmatter', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const today = new Date('2026-10-11');
  const inv = { projects: [
    { name: 'Movie Explorer', path: 'C:\\Users\\akash\\Projects\\movie-explorer', github: 'cmaintz/movie-explorer', lastCommitDate: '2026-10-01T10:00:00Z', languages: ['TypeScript'], docs: [{ type: 'adr', path: 'docs/adr/0001.md' }, { type: 'note', path: 'x.md' }] },
    { name: 'old', path: '/p/old', lastCommitDate: '2024-01-01T00:00:00Z', docs: [] },
  ] };
  const r = seedProjects(v, inv, today);
  assert.equal(r.created.length, 2);
  const note = fs.readFileSync(path.join(v, 'Projects', 'movie-explorer.md'), 'utf8');
  assert.match(note, /^---\ntype: project\nstatus: active\n/);
  assert.match(note, /repo: cmaintz\/movie-explorer/);
  assert.match(note, /path: "C:\\\\Users\\\\akash\\\\Projects\\\\movie-explorer"/);
  assert.match(note, /adr: `docs\/adr\/0001.md`/);
  assert.doesNotMatch(note, /x\.md/);
  assert.match(projectNote(inv.projects[1], today), /status: paused/);
  assert.equal(seedProjects(v, inv, today).created.length, 0);
});
