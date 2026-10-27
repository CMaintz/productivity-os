#!/usr/bin/env node
// Declarative widgets on the PC: loads the manifests and layout from the vault, computes each
// widget's rows (only whitelisted frontmatter for `notes` sources), and lets the orchestrator
// propose a new widget as a `create_widget` action card.
//
// CLI: node tools/widgets/widgets.mjs create '<manifest json>' [--vault <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { fieldsOf, readFrontmatter } from '../lib/frontmatter.mjs';
import { runQuery } from './query.mjs';
import { validateManifest } from './manifest.mjs';
import { createCard } from '../actions/cards.mjs';
import { vaultFromArgs } from '../lib/cli.mjs';
import { writeFileAtomic } from '../lib/atomic-write.mjs';

export const WIDGETS_DIR = path.join('_system', 'widgets');
const LAYOUT_FILE = path.join('_system', 'layouts', 'dashboard.json');
const DEFAULT_LAYOUT = ['today', 'cards', 'sessions', 'attention', 'projects'].map(id => ({ id }));

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/** The raw layout file (entries keep every field, e.g. `disabled` and `since`). */
export const readLayout = vault => {
  const file = path.join(vault, LAYOUT_FILE);
  return fs.existsSync(file) ? readJson(file) : { widgets: [] };
};
export const writeLayout = (vault, layout) => {
  fs.mkdirSync(path.dirname(path.join(vault, LAYOUT_FILE)), { recursive: true });
  writeFileAtomic(path.join(vault, LAYOUT_FILE), JSON.stringify(layout, null, 2) + '\n');
};
const titleOf = (text, file) => readFrontmatter(text).body.match(/^# (.+)$/m)?.[1] ?? path.basename(file, '.md');

/** A folder's notes as rows: title, vault path and the frontmatter values only. */
export function noteRows(vault, folder) {
  const dir = path.join(vault, folder);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      return { ...fieldsOf(text), title: titleOf(text, f), path: `${folder}/${f}`.replace(/\\/g, '/') };
    });
}

/** One widget's rows. `notes` rows are reduced to the manifest's whitelisted fields. */
export function widgetRows(vault, m, collections) {
  const s = m.source;
  const extra = [m.groupBy, m.valueField].filter(Boolean);
  if (s.kind === 'snapshot') return runQuery(collections[s.collection] ?? [], s, m.fields && [...m.fields, ...extra]);
  return runQuery(noteRows(vault, s.folder), s, [...m.fields, ...extra]);
}

/** Manifests by id, keyed by file name when the id is missing; duplicate ids become an error. */
function loadManifests(vault) {
  const dir = path.join(vault, WIDGETS_DIR);
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
    let m;
    try {
      m = readJson(path.join(dir, f));
    } catch (e) {
      m = { error: `invalid JSON in ${f}: ${e.message}` };
    }
    const id = typeof m.id === 'string' ? m.id : path.basename(f, '.json');
    out.set(id, out.has(id) ? { error: `two widget files use the id "${id}"` } : m);
  }
  return out;
}

const errorTile = (id, error) => ({ manifest: { id, title: id, view: 'list' }, rows: [], error });

function buildWidget(vault, id, m, collections) {
  if (!m) return errorTile(id, `no widget "${id}" in ${WIDGETS_DIR}`);
  if (m.error) return errorTile(id, m.error);
  const errors = validateManifest(m);
  if (errors.length) return errorTile(id, errors.join('; '));
  try {
    return { manifest: m, rows: widgetRows(vault, m, collections) };
  } catch (e) {
    return errorTile(id, `couldn't compute rows: ${e.message}`);
  }
}

function loadLayout(vault) {
  const file = path.join(vault, LAYOUT_FILE);
  const SIZES = ['s', 'm', 'l', 'full'];
  const entry = w => ({ id: w.id, ...(SIZES.includes(w.size) ? { size: w.size } : {}), ...(w.disabled === true ? { disabled: true } : {}) });
  try {
    return fs.existsSync(file)
      ? readJson(file)
          .widgets.filter(w => typeof w?.id === 'string')
          .map(entry)
      : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** Layout plus each laid-out widget's manifest and rows (or the reason it can't render). */
export function loadWidgets(vault, collections) {
  const manifests = loadManifests(vault);
  const layout = loadLayout(vault);
  const widgets = {};
  for (const { id, disabled } of layout) if (!disabled) widgets[id] = buildWidget(vault, id, manifests.get(id), collections);
  return { layout, widgets };
}

/** Proposes a validated manifest as a create_widget card; approving it writes the file. */
export function proposeWidget(vault, manifest, now = new Date().toISOString()) {
  const errors = validateManifest(manifest);
  if (errors.length) return { errors };
  const file = createCard(
    vault,
    {
      action: 'create_widget',
      key: `widget:${manifest.id}`,
      risk: 'low',
      title: `Add widget "${manifest.title}"`,
      reason: manifest.reason ?? `A ${manifest.view} widget over ${manifest.source.kind === 'notes' ? manifest.source.folder : manifest.source.collection}.`,
      explain: `writes ${WIDGETS_DIR}/${manifest.id}.json and adds it to the dashboard layout.`,
      undo: 'press Undo here; the file and its layout entry are removed.',
      params: { manifest: { ...manifest, reason: undefined } },
    },
    now,
  );
  return { file };
}

function main() {
  const [cmd, json] = process.argv.slice(2);
  const vault = vaultFromArgs();
  if (cmd !== 'create' || !json) {
    console.error("Usage: widgets.mjs create '<manifest json>' [--vault <dir>]");
    process.exit(2);
  }
  const r = proposeWidget(vault, JSON.parse(json));
  if (r.errors) {
    console.error(`Invalid manifest:\n- ${r.errors.join('\n- ')}`);
    process.exit(1);
  }
  console.log(r.file ? `Proposed as ${path.relative(vault, r.file)}` : 'Skipped: an open card for this widget exists, or it is on the never list.');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'widgets.mjs') main();
