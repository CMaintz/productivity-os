#!/usr/bin/env node
// Read-only inventory of project folders. Never modifies anything it scans.
//
// Usage:
//   node tools/inventory/inventory.mjs [--root <dir>]... [--home <dir>] [--out <dir>] [--github <user>]
//
// Defaults (Windows): scans %USERPROFILE%\Projects plus sibling IDE folders
// (PhpStormProjects, IdeaProjects, WebstormProjects, ..., source\repos).
// Writes inventory.json + inventory.md to --out (default: ./out).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const SKIP_DIRS = new Set([
  'node_modules', 'vendor', '.venv', 'venv', 'env', '__pycache__', 'bin', 'obj',
  'target', 'dist', 'build', 'out', '.next', '.nuxt', '.astro', '.gradle', '.idea',
  '.vs', '.vscode', '.git', '.svn', '.cache', 'coverage', 'Pods', 'DerivedData',
]);

const PROJECT_MARKERS = [
  'package.json', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Cargo.toml',
  'go.mod', 'Gemfile', 'pubspec.yaml', 'Package.swift', 'CMakeLists.txt', 'Makefile',
  'astro.config.mjs', 'astro.config.ts', '.project.yaml',
];
const PROJECT_MARKER_EXT = ['.sln', '.csproj', '.fsproj', '.xcodeproj', '.uproject'];

const LANG_BY_EXT = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript',
  '.astro': 'Astro', '.vue': 'Vue', '.svelte': 'Svelte', '.cs': 'C#', '.fs': 'F#', '.java': 'Java',
  '.kt': 'Kotlin', '.php': 'PHP', '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.rb': 'Ruby',
  '.swift': 'Swift', '.dart': 'Dart', '.c': 'C', '.cpp': 'C++', '.h': 'C/C++', '.html': 'HTML',
  '.css': 'CSS', '.scss': 'CSS', '.sql': 'SQL', '.ipynb': 'Jupyter', '.gd': 'GDScript',
};

const DOC_RULES = [
  [/(^|\/)docs?\/(adr|adrs|architecture\/decisions)\//i, 'adr'],
  [/(^|\/)adr-?\d+/i, 'adr'],
  [/(^|\/)docs?\/decisions?\//i, 'decision'],
  [/audit/i, 'audit'],
  [/(^|\/)claude\.md$|(^|\/)agents\.md$/i, 'agent-instructions'],
  [/(^|\/)readme\.md$/i, 'readme'],
  [/(^|\/)changelog\.md$/i, 'changelog'],
  [/(spec|prd|rfc|design)/i, 'spec'],
];

const MAX_WALK_FILES = 20000; // per project, guards against huge trees

// ---------- args ----------
function parseArgs(argv) {
  const a = { roots: [], home: os.homedir(), out: 'out', github: null, depth: 4 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--root') { a.roots.push(v); i++; }
    else if (k === '--home') { a.home = v; i++; }
    else if (k === '--out') { a.out = v; i++; }
    else if (k === '--github') { a.github = v; i++; }
    else if (k === '--depth') { a.depth = Number(v); i++; }
    else if (k === '-h' || k === '--help') { console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 9).join('\n')); process.exit(0); }
  }
  return a;
}

export function defaultRoots(home) {
  const roots = [];
  let entries = [];
  try { entries = fs.readdirSync(home, { withFileTypes: true }); } catch { return roots; }
  for (const e of entries) {
    if (e.isDirectory() && /projects$/i.test(e.name)) roots.push(path.join(home, e.name));
  }
  const vsRepos = path.join(home, 'source', 'repos');
  if (fs.existsSync(vsRepos)) roots.push(vsRepos);
  return roots;
}

// ---------- helpers ----------
function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();
  } catch { return null; }
}

function isProjectDir(dir, names) {
  if (names.includes('.git')) return true;
  if (names.some(n => PROJECT_MARKERS.includes(n))) return true;
  return names.some(n => PROJECT_MARKER_EXT.some(ext => n.toLowerCase().endsWith(ext)));
}

// Claude Code stores per-project history under ~/.claude/projects/<encoded cwd>,
// where every non-alphanumeric character becomes '-'.
export function claudeEncode(p) { return p.replace(/[^a-zA-Z0-9]/g, '-'); }

const isDocFile = name => /\.(md|mdx|pdf)$/i.test(name);

export function classifyDoc(rel) {
  if (/\.pdf$/i.test(rel)) return 'pdf';
  const r = rel.replace(/\\/g, '/');
  for (const [re, type] of DOC_RULES) if (re.test(r)) return type;
  return 'note';
}

function normRemote(url) {
  if (!url) return null;
  const m = url.match(/github\.com[:/]+([^/]+)\/([^/\s]+?)(\.git)?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : url.toLowerCase();
}

// ---------- discovery ----------
export function findProjects(root, maxDepth) {
  const found = [];
  const containers = []; // folders that only hold other projects (grouping dirs)
  const loose = []; // md/pdf files sitting outside any project
  function walk(dir, depth) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = ents.map(e => e.name);
    if (depth > 0 && isProjectDir(dir, names)) { found.push(dir); return; }
    if (depth >= maxDepth) { if (depth > 0) found.push(dir); return; }
    const subdirs = ents.filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'));
    const looseFiles = ents.filter(e => e.isFile()).length;
    for (const e of ents) {
      if (e.isFile() && isDocFile(e.name) && !(depth > 0 && subdirs.length === 0)) {
        const full = path.join(dir, e.name);
        let st; try { st = fs.statSync(full); } catch { continue; }
        loose.push({ path: full, type: classifyDoc(path.relative(root, full)), size: st.size, modified: new Date(st.mtimeMs).toISOString() });
      }
    }
    if (depth > 0) {
      if (subdirs.length === 0) { found.push(dir); return; } // leaf folder with loose files
      containers.push({ path: dir, looseFiles });
    }
    for (const s of subdirs) walk(path.join(dir, s.name), depth + 1);
  }
  walk(root, 0);
  return { projects: found, containers, loose };
}

// ---------- per-project facts ----------
function scanFiles(dir) {
  const langs = {}; const docs = []; let bytes = 0; let files = 0; let newest = 0;
  const heavy = []; const nestedGit = [];
  const stack = [dir];
  while (stack.length && files < MAX_WALK_FILES) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git') { if (d !== dir) nestedGit.push(path.relative(dir, d)); continue; }
        if (SKIP_DIRS.has(e.name)) { if (['node_modules', 'vendor', '.venv', 'venv', 'target', 'bin', 'obj'].includes(e.name)) heavy.push(path.relative(dir, full)); continue; }
        stack.push(full);
      } else if (e.isFile()) {
        files++;
        let st; try { st = fs.statSync(full); } catch { continue; }
        bytes += st.size; if (st.mtimeMs > newest) newest = st.mtimeMs;
        const ext = path.extname(e.name).toLowerCase();
        if (LANG_BY_EXT[ext]) langs[LANG_BY_EXT[ext]] = (langs[LANG_BY_EXT[ext]] || 0) + 1;
        if (isDocFile(e.name)) {
          const rel = path.relative(dir, full);
          docs.push({ path: rel.replace(/\\/g, '/'), type: classifyDoc(rel), modified: new Date(st.mtimeMs).toISOString() });
        }
      }
    }
  }
  const languages = Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l]) => l);
  return { languages, docs, bytes, files, truncated: files >= MAX_WALK_FILES, newest: newest ? new Date(newest).toISOString() : null, heavyDirs: heavy.slice(0, 10), nestedGit };
}

function gitFacts(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return { isGit: false };
  const remotesRaw = git(dir, ['remote', '-v']) || '';
  const remotes = [...new Set(remotesRaw.split('\n').filter(Boolean).map(l => l.split(/\s+/)[1]))];
  const status = git(dir, ['status', '--porcelain']) ?? '';
  const statusLines = status ? status.split('\n') : [];
  const last = git(dir, ['log', '-1', '--format=%cI%x09%s']);
  const [lastCommitDate, lastCommitSubject] = last ? last.split('\t') : [null, null];
  // branches with commits not on their upstream, and branches with no upstream at all
  const branchInfo = git(dir, ['for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)', 'refs/heads']) || '';
  const unpushed = []; const noUpstream = [];
  for (const line of branchInfo.split('\n').filter(Boolean)) {
    const [name, up, track] = line.split('\t');
    if (!up) noUpstream.push(name);
    else if (/ahead/.test(track || '')) unpushed.push(`${name} ${track}`);
  }
  const stash = git(dir, ['stash', 'list']);
  return {
    isGit: true,
    branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    remotes,
    github: remotes.map(normRemote).find(r => r && !r.includes(':')) || null,
    lastCommitDate, lastCommitSubject,
    dirty: statusLines.filter(l => !l.startsWith('??')).length,
    untracked: statusLines.filter(l => l.startsWith('??')).length,
    unpushed, noUpstream: remotes.length ? noUpstream : [],
    stashes: stash ? stash.split('\n').length : 0,
  };
}

export function inspectProject(dir, root, home) {
  const names = (() => { try { return fs.readdirSync(dir); } catch { return []; } })();
  const g = gitFacts(dir);
  const f = scanFiles(dir);
  const claudeHistory = path.join(home, '.claude', 'projects', claudeEncode(dir));
  const flags = [];
  if (g.isGit && g.dirty) flags.push(`uncommitted:${g.dirty}`);
  if (g.isGit && g.unpushed?.length) flags.push('unpushed');
  if (g.isGit && g.stashes) flags.push(`stashes:${g.stashes}`);
  if (g.isGit && !g.remotes.length) flags.push('no-remote');
  if (!g.isGit) flags.push('not-git');
  if (f.files === 0) flags.push('empty');
  if (f.nestedGit.length) flags.push('nested-git');
  if (f.heavyDirs.some(h => /venv/.test(h))) flags.push('venv(rebuild after move)');
  return {
    name: path.basename(dir),
    path: dir,
    root,
    relative: path.relative(root, dir),
    ide: ['.idea', '.vscode', '.vs'].filter(n => names.includes(n)),
    hasClaudeMd: names.some(n => /^claude\.md$/i.test(n)),
    claudeHistory: fs.existsSync(claudeHistory) ? claudeHistory : null,
    ...g,
    ...f,
    flags,
  };
}

// ---------- GitHub cross-check (optional, via gh CLI) ----------
function githubRepos(user) {
  try {
    const out = execFileSync('gh', ['repo', 'list', user, '--limit', '500', '--json', 'nameWithOwner,isArchived,isFork,pushedAt,visibility'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out);
  } catch { return null; }
}

// ---------- report ----------
const fmtBytes = b => b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`;
const day = s => s ? s.slice(0, 10) : '—';

export function renderMarkdown(inv) {
  const L = [];
  L.push(`# Projects inventory`, '', `Generated ${inv.generatedAt} — ${inv.projects.length} projects across ${inv.roots.length} roots. Read-only scan; nothing was changed.`, '');
  L.push('## Roots', ...inv.roots.map(r => `- \`${r}\``), '');
  const needsSaving = inv.projects.filter(p => p.flags.some(f => /uncommitted|unpushed|stashes|no-remote/.test(f)));
  if (needsSaving.length) {
    L.push('## ⚠ Save before moving', '', '| Project | Flags |', '|---|---|');
    for (const p of needsSaving) L.push(`| \`${p.root.split(/[\\/]/).pop()}/${p.relative}\` | ${p.flags.join(', ')} |`);
    L.push('');
  }
  if (inv.duplicates.length) {
    L.push('## Same remote cloned more than once', ...inv.duplicates.map(d => `- **${d.github}**: ${d.paths.map(p => `\`${p}\``).join(', ')}`), '');
  }
  if (inv.containers.length) {
    L.push('## Existing grouping folders', ...inv.containers.map(c => `- \`${c.path}\`${c.looseFiles ? ` (${c.looseFiles} loose files)` : ''}`), '');
  }
  if (inv.loose.length) {
    L.push(`## Loose docs outside projects (${inv.loose.length})`, '', '| File | Type | Modified | Size |', '|---|---|---|---|');
    for (const d of [...inv.loose].sort((a, b) => b.modified.localeCompare(a.modified))) L.push(`| \`${d.path}\` | ${d.type} | ${day(d.modified)} | ${fmtBytes(d.size)} |`);
    L.push('');
  }
  const scattered = inv.projects.filter(p => p.docs.filter(d => d.type === 'note' && !d.path.includes('/')).length >= 3);
  if (scattered.length) {
    L.push('## Projects with many loose root-level notes', ...scattered.map(p => `- \`${p.relative}\`: ${p.docs.filter(d => d.type === 'note' && !d.path.includes('/')).map(d => d.path).join(', ')}`), '');
  }
  L.push('## All projects', '', '| Project | Root | Lang | Last commit | Last file change | Size | GitHub | Docs | Flags |', '|---|---|---|---|---|---|---|---|---|');
  for (const p of [...inv.projects].sort((a, b) => (b.lastCommitDate || b.newest || '').localeCompare(a.lastCommitDate || a.newest || ''))) {
    const docCounts = Object.entries(p.docs.reduce((m, d) => (m[d.type] = (m[d.type] || 0) + 1, m), {})).map(([t, n]) => `${t}:${n}`).join(' ');
    L.push(`| \`${p.relative}\` | ${p.root.split(/[\\/]/).pop()} | ${p.languages.join(', ')} | ${day(p.lastCommitDate)} | ${day(p.newest)} | ${fmtBytes(p.bytes)}${p.truncated ? '+' : ''} | ${p.github || '—'} | ${docCounts || '—'} | ${p.flags.join(', ')} |`);
  }
  L.push('');
  if (inv.githubOnly) {
    L.push('## On GitHub but not cloned locally', ...inv.githubOnly.map(r => `- ${r.nameWithOwner}${r.isArchived ? ' (archived)' : ''}${r.isFork ? ' (fork)' : ''} — pushed ${day(r.pushedAt)}`), '');
  } else {
    L.push('_GitHub cross-check skipped (pass `--github <user>` with the `gh` CLI logged in)._', '');
  }
  return L.join('\n');
}

export function buildInventory({ roots, home, github }) {
  const projects = []; const containers = []; const loose = [];
  for (const root of roots) {
    const r = findProjects(root, 4);
    containers.push(...r.containers);
    loose.push(...r.loose);
    for (const dir of r.projects) projects.push(inspectProject(dir, root, home));
  }
  const byRemote = {};
  for (const p of projects) if (p.github) (byRemote[p.github] ||= []).push(p.path);
  const duplicates = Object.entries(byRemote).filter(([, v]) => v.length > 1).map(([github, paths]) => ({ github, paths }));
  let githubOnly = null;
  if (github) {
    const repos = githubRepos(github);
    if (repos) githubOnly = repos.filter(r => !byRemote[r.nameWithOwner.toLowerCase()]);
  }
  return { generatedAt: new Date().toISOString(), roots, projects, containers, loose, duplicates, githubOnly };
}

// ---------- main ----------
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('inventory.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  const roots = (args.roots.length ? args.roots : defaultRoots(args.home)).map(r => path.resolve(r));
  if (!roots.length) { console.error('No roots found. Pass --root <dir>.'); process.exit(1); }
  console.error(`Scanning:\n  ${roots.join('\n  ')}`);
  const inv = buildInventory({ roots, home: args.home, github: args.github });
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, 'inventory.json'), JSON.stringify(inv, null, 2));
  fs.writeFileSync(path.join(args.out, 'inventory.md'), renderMarkdown(inv));
  console.error(`Done: ${inv.projects.length} projects → ${path.join(args.out, 'inventory.md')}`);
}
