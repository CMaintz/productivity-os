// A forge's state note (Forge/<slug>.md): reading it, and writing fields and log lines back
// without clobbering edits you made while a stage or build step ran.

import fs from 'node:fs';
import path from 'node:path';
import { fieldsOf, setFrontmatter } from '../lib/frontmatter.mjs';
import { FORGE_DIR, STAGE_IDS } from './stages.mjs';
import { writeFileAtomic } from '../lib/atomic-write.mjs';

const q = v => JSON.stringify(v);
export const stops = v => (Array.isArray(v) ? v : String(v ?? '').split(',')).map(s => String(s).trim()).filter(s => STAGE_IDS.includes(s));
const load = file => {
  const text = fs.readFileSync(file, 'utf8');
  return { file, text, ...fieldsOf(text) };
};

export function listForges(vault) {
  const dir = path.join(vault, FORGE_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(n => n.endsWith('.md'))
    .map(n => load(path.join(dir, n)))
    .filter(f => f.type === 'forge' && /^[a-z0-9-]+$/.test(String(f.slug)))
    .map(f => ({ ...f, dir: path.join(dir, f.slug), stop_after: stops(f.stop_after) }));
}

const encode = v => (typeof v === 'string' || typeof v === 'object' ? q(v) : v);

/**
 * Writes fields (and a log line) onto the note as it is *now*: an edit you made while a stage ran
 * survives, and if you set `status: stopped` meanwhile, the forge stays stopped.
 */
export function save(f, fields, now, log) {
  const current = load(f.file);
  const stoppedByYou = current.status === 'stopped' && f.status !== 'stopped';
  const apply = stoppedByYou ? {} : fields;
  let text = Object.entries({ ...apply, updated: now.toISOString() }).reduce((t, [k, v]) => setFrontmatter(t, k, encode(v)), current.text);
  const line = stoppedByYou ? `${log ?? f.stage} (you stopped the forge meanwhile; it stays stopped)` : log;
  if (line) text = `${text.trimEnd()}\n- ${now.toISOString().slice(0, 16).replace('T', ' ')} ${line}\n`;
  writeFileAtomic(f.file, text);
  Object.assign(f, load(f.file), { stop_after: stops(fieldsOf(text).stop_after) });
}
