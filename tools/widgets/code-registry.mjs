#!/usr/bin/env node
// Code widgets live in dashboard/src/widgets/code/<id>/ (widget.ts, widget.json, fixture.json).
// This writes the generated lists everything reads them from, so adding a folder is all it takes.
// A test fails when they're stale.
// Usage: node tools/widgets/code-registry.mjs [--check]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID_PATTERN } from './manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CODE_DIR = path.join(ROOT, 'dashboard', 'src', 'widgets', 'code');
// Two generated files, on purpose: the dashboard page imports only the catalog (JSON: manifests and
// fixtures); widget code is imported by renderers.ts alone, which only the sandboxed frame bundles.
export const CATALOG_FILE = path.join(CODE_DIR, 'catalog.ts');
export const RENDERERS_FILE = path.join(CODE_DIR, 'renderers.ts');
const PARTS = ['widget.ts', 'widget.json', 'fixture.json'];

/** Widget ids: folders under code/ that have all three files. */
export function codeWidgetIds(dir = CODE_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && ID_PATTERN.test(d.name) && PARTS.every(f => fs.existsSync(path.join(dir, d.name, f))))
    .map(d => d.name)
    .sort();
}

const ident = (id, i) => `w${i}_${id.replace(/-/g, '_')}`;

export function renderCatalog(ids = codeWidgetIds()) {
  const imports = ids.flatMap((id, i) => [`import ${ident(id, i)}_manifest from './${id}/widget.json';`, `import ${ident(id, i)}_fixture from './${id}/fixture.json';`]);
  const entries = ids.map((id, i) => `  '${id}': { manifest: ${ident(id, i)}_manifest as unknown as Manifest, fixture: ${ident(id, i)}_fixture.rows },`);
  return `import type { Manifest, Row } from '../types';
${imports.join('\n')}

export const codeCatalog: Record<string, { manifest: Manifest; fixture: Row[] }> = {
${entries.join('\n')}
};
`;
}

export function renderRenderers(ids = codeWidgetIds()) {
  return `import type { CodeWidget } from '../types';
${ids.map((id, i) => `import { createWidget as ${ident(id, i)} } from './${id}/widget';`).join('\n')}

export const codeRenderers: Record<string, CodeWidget> = {
${ids.map((id, i) => `  '${id}': ${ident(id, i)},`).join('\n')}
};
`;
}

/** Each generated file and what it must contain for the current widget folders. */
export const generatedFiles = (ids = codeWidgetIds()) => [
  [CATALOG_FILE, renderCatalog(ids)],
  [RENDERERS_FILE, renderRenderers(ids)],
];

function main() {
  const files = generatedFiles();
  if (process.argv.includes('--check')) {
    const ok = files.every(([f, text]) => fs.existsSync(f) && fs.readFileSync(f, 'utf8') === text);
    console.log(ok ? 'code registry is up to date' : 'code registry is stale: run node tools/widgets/code-registry.mjs');
    process.exit(ok ? 0 : 1);
  }
  for (const [f, text] of files) fs.writeFileSync(f, text);
  console.log(`wrote ${files.map(([f]) => path.relative(ROOT, f)).join(', ')} (${codeWidgetIds().length} widget(s))`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'code-registry.mjs') main();
