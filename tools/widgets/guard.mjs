#!/usr/bin/env node
// Decides whether a code-widget PR may merge itself. It passes only when the change stays inside
// code widget folders (plus the two generated files) and no widget can see more than before:
// valid manifests, exact permissions, no connectors, nothing widened against the base branch.
// Anything else needs a person. CI runs it on PRs labelled widget:code.
// Usage: node tools/widgets/guard.mjs [base-ref]   (default origin/main)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateManifest } from './manifest.mjs';
import { codeWidgetIds, generatedFiles } from './code-registry.mjs';

// Flat .ts/.json files only: the sandbox ESLint rule covers .ts, so a .js helper would slip past it.
const WIDGET_FILE = /^dashboard\/src\/widgets\/code\/([a-z0-9][a-z0-9-]{0,40})\/[\w.-]+\.(ts|json)$/;
const GENERATED = ['dashboard/src/widgets/code/catalog.ts', 'dashboard/src/widgets/code/renderers.ts'];
const manifestPath = id => `dashboard/src/widgets/code/${id}/widget.json`;

/** What a manifest's permissions grant, as flat "kind:value" entries. */
const grants = m => Object.entries(m?.permissions ?? {}).flatMap(([kind, list]) => (Array.isArray(list) ? list.map(v => `${kind}:${v}`) : []));

function parse(text, id, problems) {
  if (text === null) return null;
  try { return JSON.parse(text); } catch (e) { problems.push(`${id}: widget.json isn't valid JSON (${e.message})`); return null; }
}

function checkWidget(id, { changed, readBase, readHead, codeIds }, problems) {
  const head = parse(readHead(manifestPath(id)), id, problems);
  if (!head) {
    const left = changed.filter(p => WIDGET_FILE.exec(p)?.[1] === id && readHead(p) !== null);
    if (left.length) problems.push(`${id}: a code widget needs widget.ts, widget.json and fixture.json`);
    return;
  }
  if (head.id !== id) problems.push(`${id}: widget.json id "${head.id}" doesn't match its folder`);
  if (head.view !== `code:${id}`) problems.push(`${id}: view must be "code:${id}"`);
  for (const e of validateManifest(head, { codeIds })) problems.push(`${id}: ${e}`);
  const base = parse(readBase(manifestPath(id)), id, problems);
  if (!base) return;
  const before = new Set(grants(base));
  const added = grants(head).filter(g => !before.has(g));
  if (added.length) problems.push(`${id}: widens its permissions (${added.join(', ')})`);
  if (JSON.stringify(head.source) !== JSON.stringify(base.source)) problems.push(`${id}: changes which rows it gets (source)`);
}

/** Generated files are only accepted when they're exactly what the generator writes. */
function checkGenerated(changed, readHead, expected, problems) {
  const want = new Map(expected);
  for (const file of changed.filter(p => GENERATED.includes(p))) if (readHead(file) !== want.get(file)) problems.push(`${file} isn't what tools/widgets/code-registry.mjs generates`);
}

/**
 * `changed` is the list of paths the PR touches; `readBase`/`readHead` return a file's text on
 * each side (null when absent); `codeIds` are the widget folders on the head side; `expected` is
 * [[path, text]] for each generated file.
 */
export function checkChange({ changed, readBase, readHead, codeIds, expected = [] }) {
  const problems = [];
  checkGenerated(changed, readHead, expected, problems);
  const outside = changed.filter(p => !WIDGET_FILE.test(p) && !GENERATED.includes(p));
  for (const p of outside) problems.push(`touches ${p}, outside code widget folders`);
  const ids = [...new Set(changed.map(p => WIDGET_FILE.exec(p)?.[1]).filter(Boolean))];
  if (!ids.length) problems.push('changes no code widget');
  for (const id of ids) checkWidget(id, { changed, readBase, readHead, codeIds }, problems);
  return { ok: problems.length === 0, ids, problems };
}

function main() {
  const base = process.argv[2] ?? 'origin/main';
  const git = args => execFileSync('git', args, { encoding: 'utf8' });
  const mb = git(['merge-base', base, 'HEAD']).trim();
  const changed = git(['diff', '--name-only', '--no-renames', mb, 'HEAD']).split('\n').filter(Boolean);
  const readBase = p => { try { return git(['show', `${mb}:${p}`]); } catch { return null; } };
  const readHead = p => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  const expected = generatedFiles().map(([file, text]) => [path.relative(process.cwd(), file).replace(/\\/g, '/'), text]);
  const r = checkChange({ changed, readBase, readHead, codeIds: codeWidgetIds(), expected });
  if (r.ok) console.log(`guard: ok, ${r.ids.join(', ')} may merge without review`);
  else console.log(`guard: needs review\n- ${r.problems.join('\n- ')}`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'guard.mjs') main();
