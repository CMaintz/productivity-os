// Widget manifests: what a widget shows (view), where its rows come from (source) and how big
// it is. Every manifest is validated before anything renders or leaves the PC.

export const VIEWS = ['stat', 'list', 'table', 'kanban', 'bar', 'today', 'cards'];
export const SIZES = ['s', 'm', 'l', 'full'];
export const COLLECTIONS = ['projects', 'cards', 'sessions', 'today', 'forges'];
const SCALAR = v => ['string', 'number', 'boolean'].includes(typeof v) || v === null;
const OP_VALUE = {
  eq: SCALAR,
  ne: SCALAR,
  gt: v => ['string', 'number'].includes(typeof v),
  lt: v => ['string', 'number'].includes(typeof v),
  in: v => Array.isArray(v) && v.every(SCALAR),
  contains: v => ['string', 'number'].includes(typeof v),
  exists: v => typeof v === 'boolean',
};
const FIELD = /^[A-Za-z_][\w-]{0,40}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
// A coded widget's view: `code:<id>`, rendered by dashboard/src/widgets/code/<id>/widget.ts.
export const CODE_VIEW = /^code:([a-z0-9][a-z0-9-]{0,40})$/;
// What a code widget may read. No connectors exist yet, so a widget asking for one never validates.
export const CODE_COLLECTIONS = ['projects', 'cards', 'sessions'];

// Frontmatter that must never leave the PC, or be filtered or sorted on, whatever a manifest asks for.
export const PRIVATE_FIELDS = ['last_prompt', 'decline_reason', 'params', 'undo', 'cwd', 'session_id'];
// Folders a notes widget may not read: sessions and system state are only exposed through the
// curated `snapshot` collections.
const PRIVATE_FOLDERS = ['_system', 'Sessions', 'Forge', '.obsidian', '.claude', '.git'];

function checkOps(ops, errors, at) {
  for (const [op, x] of Object.entries(ops)) {
    if (!OP_VALUE[op]) errors.push(`${at}: unknown operator "${op}"`);
    else if (!OP_VALUE[op](x)) errors.push(`${at}.${op}: wrong value type`);
  }
}

function checkWhere(where, errors, at = 'where') {
  if (where === undefined) return;
  if (typeof where !== 'object' || where === null || Array.isArray(where)) return errors.push(`${at} must be an object`);
  for (const [k, v] of Object.entries(where)) {
    if (k === '$or') {
      Array.isArray(v) ? v.forEach((w, i) => checkWhere(w, errors, `${at}.$or[${i}]`)) : errors.push(`${at}.$or must be an array`);
      continue;
    }
    if (!FIELD.test(k)) errors.push(`${at}: bad field "${k}"`);
    if (PRIVATE_FIELDS.includes(k)) errors.push(`${at}: field "${k}" is private and can't be queried`);
    if (v && typeof v === 'object' && !Array.isArray(v)) checkOps(v, errors, `${at}.${k}`);
    else if (!SCALAR(v)) errors.push(`${at}.${k}: value must be a string, number, boolean or null`);
  }
}

function checkSource(s, errors) {
  if (!s || typeof s !== 'object') return errors.push('source is required');
  if (s.kind === 'snapshot') {
    if (!COLLECTIONS.includes(s.collection)) errors.push(`source.collection must be one of ${COLLECTIONS.join(', ')}`);
  } else if (s.kind === 'notes') {
    const parts = typeof s.folder === 'string' ? s.folder.split(/[\\/]/) : [];
    if (!parts.length || parts.some(p => !p || p === '.' || p === '..') || /^[A-Za-z]:/.test(s.folder)) errors.push('source.folder must be a vault folder');
    else if (PRIVATE_FOLDERS.includes(parts[0])) errors.push(`source.folder "${parts[0]}" is private; use a snapshot source instead`);
  } else errors.push('source.kind must be "snapshot" or "notes"');
  checkWhere(s.where, errors, 'source.where');
  if (s.sort !== undefined && (!Array.isArray(s.sort) || s.sort.some(x => !FIELD.test(x?.field ?? '') || !['asc', 'desc', undefined].includes(x.dir))))
    errors.push('source.sort must be [{ field, dir }]');
  else for (const x of s.sort ?? []) if (PRIVATE_FIELDS.includes(x.field)) errors.push(`source.sort: field "${x.field}" is private`);
  if (s.limit !== undefined && !(Number.isInteger(s.limit) && s.limit > 0 && s.limit <= 200)) errors.push('source.limit must be 1-200');
}

function checkFields(m, errors) {
  if (m.fields !== undefined && (!Array.isArray(m.fields) || m.fields.some(f => !FIELD.test(f)))) errors.push('fields must be field names');
  for (const f of [...(m.fields ?? []), m.groupBy, m.valueField].filter(Boolean)) if (PRIVATE_FIELDS.includes(f)) errors.push(`field "${f}" is private and can't be shown`);
  if (m.view === 'kanban' && !FIELD.test(m.groupBy ?? '')) errors.push('kanban needs groupBy');
  if (m.view === 'bar' && !FIELD.test(m.groupBy ?? '') && !FIELD.test(m.valueField ?? '')) errors.push('bar needs groupBy or valueField');
  if (m.source?.kind === 'notes' && !m.fields?.length) errors.push('notes widgets must list the fields they show');
}

const whereFields = (w = {}) => Object.entries(w).flatMap(([k, v]) => (k === '$or' && Array.isArray(v) ? v.flatMap(whereFields) : [k]));

/** Every field a manifest reads: shown, grouped, summed, filtered or sorted on. */
export function fieldsUsed(m) {
  const s = m.source ?? {};
  return [...new Set([...(m.fields ?? []), m.groupBy, m.valueField, ...whereFields(s.where), ...(s.sort ?? []).map(x => x?.field)].filter(Boolean))].sort();
}

const sorted = list => JSON.stringify([...list].sort());
const sameSet = (a, b) => Array.isArray(a) && sorted(a) === sorted(b);

/** A code widget states exactly what it reads, so a reviewer (or the guard) can see any widening. */
function checkPermissions(m, errors) {
  const p = m.permissions;
  if (!p || typeof p !== 'object') return errors.push('code widgets need a permissions block');
  const s = m.source ?? {};
  if (s.kind !== 'snapshot' || !CODE_COLLECTIONS.includes(s.collection)) errors.push(`code widgets may only read the snapshot collections ${CODE_COLLECTIONS.join(', ')}`);
  if (!sameSet(p.collections ?? [], s.kind === 'snapshot' ? [s.collection] : [])) errors.push('permissions.collections must match source.collection');
  if (!sameSet(p.folders ?? [], s.kind === 'notes' ? [s.folder] : [])) errors.push('permissions.folders must match source.folder');
  if (!sameSet(p.fields, fieldsUsed(m))) errors.push(`permissions.fields must list exactly the fields it reads: ${fieldsUsed(m).join(', ')}`);
  if (!Array.isArray(p.connectors) || p.connectors.length) errors.push('permissions.connectors must be [] (connectors need your review)');
}

function checkView(m, codeIds, errors) {
  const code = CODE_VIEW.exec(m.view ?? '');
  if (!code) {
    if (!VIEWS.includes(m.view)) errors.push(`view must be one of ${VIEWS.join(', ')} or code:<id>`);
    return;
  }
  if (codeIds && !codeIds.includes(code[1])) errors.push(`no code widget "${code[1]}" is deployed`);
  checkPermissions(m, errors);
}

/**
 * Returns the list of problems; an empty list means the manifest is valid. `codeIds`, when
 * given, is the list of code widgets this build has; without it any well-formed code view passes.
 */
export function validateManifest(m, { codeIds } = {}) {
  const errors = [];
  if (!m || typeof m !== 'object') return ['manifest must be an object'];
  if (!ID.test(m.id ?? '')) errors.push('id must be lowercase-kebab, max 41 chars');
  if (typeof m.title !== 'string' || !m.title.trim() || m.title.length > 80) errors.push('title must be 1-80 chars');
  checkView(m, codeIds, errors);
  if (m.size !== undefined && !SIZES.includes(m.size)) errors.push(`size must be one of ${SIZES.join(', ')}`);
  checkSource(m.source, errors);
  checkFields(m, errors);
  return errors;
}

export const ID_PATTERN = ID;
