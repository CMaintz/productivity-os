// Reading and writing note frontmatter. Values are kept as raw YAML text; `scalar` turns
// the simple ones we write (quoted strings, numbers, booleans, inline JSON) back into values.

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Reads `key: value` pairs (values kept as raw YAML) and the body after the frontmatter. */
export function readFrontmatter(note) {
  const m = note?.match(FM);
  if (!m) return { fields: {}, body: note ?? '' };
  const pairs = m[1].split(/\r?\n/).map(l => l.match(/^(\w+):\s?(.*)$/)).filter(Boolean);
  return { fields: Object.fromEntries(pairs.map(x => [x[1], x[2]])), body: note.slice(m[0].length) };
}

/** Sets `key: value` inside the frontmatter, adding the key if it's missing. */
export function setFrontmatter(note, key, value) {
  const m = note.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return note;
  const re = new RegExp(`^${key}:.*$`, 'm');
  const fm = re.test(m[1]) ? m[1].replace(re, () => `${key}: ${value}`) : `${m[1]}\n${key}: ${value}`;
  return note.replace(m[1], () => fm);
}

/** A raw YAML value as a JS value, for the shapes we write ourselves. */
export function scalar(raw) {
  const v = String(raw ?? '').trim();
  if (v === '') return '';
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^["{[]/.test(v)) { try { return JSON.parse(v); } catch { /* not JSON: fall through */ } }
  return v;
}

/** All frontmatter fields as JS values. */
export const fieldsOf = note => Object.fromEntries(Object.entries(readFrontmatter(note).fields).map(([k, v]) => [k, scalar(v)]));
