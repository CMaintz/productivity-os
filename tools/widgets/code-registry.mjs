#!/usr/bin/env node
// Code widgets live in dashboard/src/widgets/code/<id>/ (widget.ts, widget.json, fixture.json).
// This writes code/registry.ts, the one list the web Board, the Obsidian bundle and demo mode
// read them from, so adding a folder is all it takes. A test fails when the file is stale.
// Usage: node tools/widgets/code-registry.mjs [--check]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID_PATTERN } from './manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CODE_DIR = path.join(ROOT, 'dashboard', 'src', 'widgets', 'code');
export const REGISTRY_FILE = path.join(CODE_DIR, 'registry.ts');
const PARTS = ['widget.ts', 'widget.json', 'fixture.json'];

/** Widget ids: folders under code/ that have all three files. */
export function codeWidgetIds(dir = CODE_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && ID_PATTERN.test(d.name) && PARTS.every(f => fs.existsSync(path.join(dir, d.name, f))))
    .map(d => d.name).sort();
}

const ident = (id, i) => `w${i}_${id.replace(/-/g, '_')}`;

export function renderRegistry(ids = codeWidgetIds()) {
  const imports = ids.flatMap((id, i) => [
    `import { createWidget as ${ident(id, i)} } from './${id}/widget';`,
    `import ${ident(id, i)}_manifest from './${id}/widget.json';`,
    `import ${ident(id, i)}_fixture from './${id}/fixture.json';`,
  ]);
  const entries = ids.map((id, i) => `  '${id}': { create: ${ident(id, i)}, manifest: ${ident(id, i)}_manifest as unknown as Manifest, fixture: ${ident(id, i)}_fixture.rows },`);
  return `import type { CodeWidget, Manifest, Row } from '../types';
${imports.join('\n')}

export interface CodeEntry { create: CodeWidget; manifest: Manifest; fixture: Row[] }

export const codeWidgets: Record<string, CodeEntry> = {
${entries.join('\n')}
};
`;
}

function main() {
  const text = renderRegistry();
  if (process.argv.includes('--check')) {
    const ok = fs.existsSync(REGISTRY_FILE) && fs.readFileSync(REGISTRY_FILE, 'utf8') === text;
    console.log(ok ? 'code registry is up to date' : 'code registry is stale: run node tools/widgets/code-registry.mjs');
    process.exit(ok ? 0 : 1);
  }
  fs.writeFileSync(REGISTRY_FILE, text);
  console.log(`wrote ${path.relative(ROOT, REGISTRY_FILE)} (${codeWidgetIds().length} widget(s))`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'code-registry.mjs') main();
