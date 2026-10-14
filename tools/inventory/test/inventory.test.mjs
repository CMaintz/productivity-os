import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildInventory, defaultRoots, claudeEncode, classifyDoc, renderMarkdown } from '../inventory.mjs';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const write = (p, s = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-'));
  const P = path.join(home, 'Projects');
  // clean git repo with remote + ADR
  const a = path.join(P, 'web', 'site');
  write(path.join(a, 'package.json'), '{}'); write(path.join(a, 'src/index.ts'));
  write(path.join(a, 'docs/adr/0001-use-astro.md')); write(path.join(a, 'README.md'));
  write(path.join(a, 'node_modules/big/index.js'));
  sh(a, 'init', '-q'); sh(a, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  sh(a, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  sh(a, 'remote', 'add', 'origin', 'https://github.com/CMaintz/site.git');
  // dirty repo, no remote
  const b = path.join(P, 'scratch');
  write(path.join(b, 'main.py')); sh(b, 'init', '-q');
  sh(b, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  sh(b, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  write(path.join(b, 'main.py'), 'changed');
  // sibling IDE folder, non-git project
  write(path.join(home, 'IdeaProjects', 'javaThing', 'pom.xml'));
  write(path.join(home, 'IdeaProjects', 'javaThing', 'src/Main.java'));
  write(path.join(home, 'IdeaProjects', 'javaThing', 'SECURITY-AUDIT.md'));
  // loose docs outside projects
  write(path.join(P, 'ideas.md')); write(path.join(P, 'web', 'site-notes.md')); write(path.join(P, 'spec.pdf'));
  // claude history for site
  fs.mkdirSync(path.join(home, '.claude', 'projects', claudeEncode(a)), { recursive: true });
  return { home, a, b };
}

test('default roots pick up *Projects siblings', () => {
  const { home } = fixture();
  const roots = defaultRoots(home).map(r => path.basename(r)).sort();
  assert.deepEqual(roots, ['IdeaProjects', 'Projects']);
});

test('inventory finds projects, git state, docs and flags', () => {
  const { home, a, b } = fixture();
  const inv = buildInventory({ roots: defaultRoots(home), home, github: null });
  const byName = Object.fromEntries(inv.projects.map(p => [p.name, p]));
  assert.deepEqual(Object.keys(byName).sort(), ['javaThing', 'scratch', 'site']);

  const site = byName.site;
  assert.equal(site.github, 'cmaintz/site');
  assert.equal(site.dirty, 0);
  assert.ok(site.docs.some(d => d.type === 'adr' && d.tracked));
  write(path.join(a, 'scratch-notes.md'));
  const again = buildInventory({ roots: [path.join(home, 'Projects')], home, github: null }).projects.find(p => p.name === 'site');
  assert.equal(again.docs.find(d => d.path === 'scratch-notes.md').tracked, false);
  assert.ok(site.heavyDirs.includes('node_modules'));
  assert.ok(!site.docs.some(d => d.path.includes('node_modules')));
  assert.equal(site.claudeHistory !== null, true);
  assert.equal(site.relative, path.join('web', 'site'));

  assert.ok(byName.scratch.flags.includes('uncommitted:1'));
  assert.ok(byName.scratch.flags.includes('no-remote'));
  assert.ok(byName.javaThing.flags.includes('not-git'));
  assert.ok(byName.javaThing.docs.some(d => d.type === 'audit'));
  assert.ok(inv.containers.some(c => c.path.endsWith('web')));

  const loose = inv.loose.map(d => path.basename(d.path)).sort();
  assert.deepEqual(loose, ['ideas.md', 'site-notes.md', 'spec.pdf']);
  assert.equal(inv.loose.find(d => d.path.endsWith('spec.pdf')).type, 'pdf');

  const md = renderMarkdown(inv);
  assert.match(md, /Loose docs outside projects \(3\)/);
  assert.match(md, /Save before moving/);
  assert.match(md, /scratch/);
  // read-only: scanned repo untouched
  assert.equal(fs.readFileSync(path.join(b, 'main.py'), 'utf8'), 'changed');
  assert.ok(fs.existsSync(path.join(a, 'node_modules/big/index.js')));
});

test('folders inside _notes and _archive are docs, not projects, unless they are repos', () => {
  const { home } = fixture();
  const P = path.join(home, 'Projects');
  write(path.join(P, '_notes', 'atlas', 'research', 'about', 'deeper', 'page.md'));
  write(path.join(P, 'fam', '_Notes', 'audits', '2026-10-03.md'));
  write(path.join(P, '_archive', 'proto', 'design', 'SPEC.md'));
  write(path.join(P, '_archive', 'old-repo', 'pom.xml'));
  const gitRepo = path.join(P, '_archive', 'a', 'b', 'c', 'git-repo');
  write(path.join(gitRepo, 'x.txt')); sh(gitRepo, 'init', '-q');
  const inv = buildInventory({ roots: [P], home, github: null });
  const names = inv.projects.map(p => p.name);
  assert.ok(names.includes('old-repo'));
  assert.ok(names.includes('git-repo'), 'repo below the depth cap inside _archive');
  for (const junk of ['about', 'deeper', 'audits', 'design', 'research', 'proto']) assert.ok(!names.includes(junk), junk);
  const loose = inv.loose.map(d => path.basename(d.path)).sort();
  assert.deepEqual(loose, ['2026-10-03.md', 'SPEC.md', 'ideas.md', 'page.md', 'site-notes.md', 'spec.pdf']);
});

test('helpers', () => {
  assert.equal(claudeEncode('C:\\Users\\akash\\Projects\\foo'), 'C--Users-akash-Projects-foo');
  assert.equal(classifyDoc('docs/decisions/2026-01-01-x.md'), 'decision');
  assert.equal(classifyDoc('CLAUDE.md'), 'agent-instructions');
  assert.equal(classifyDoc('notes/random.md'), 'note');
});
