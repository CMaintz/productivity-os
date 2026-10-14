// The one query engine for widgets: filter, sort, limit and pick fields from rows.
// Plain JS with no imports, because it runs in three places: on the PC (rows for the
// snapshot), in the browser demo, and bundled into Obsidian's views.md for Datacore.

const cmp = (a, b) => (a === b ? 0 : a === null || a === undefined ? 1 : b === null || b === undefined ? -1 : a < b ? -1 : 1);

const OPS = {
  eq: (v, x) => v === x,
  ne: (v, x) => v !== x,
  gt: (v, x) => v !== null && v !== undefined && v > x,
  lt: (v, x) => v !== null && v !== undefined && v < x,
  in: (v, x) => x.includes(v),
  contains: (v, x) => (Array.isArray(v) ? v.includes(x) : String(v ?? '').includes(x)),
  exists: (v, x) => (v !== null && v !== undefined && v !== '') === x,
};

/** `where` is { field: value | { op: value } }, all must hold; `$or: [where, ...]` needs any. */
export function matches(row, where = {}) {
  return Object.entries(where).every(([field, cond]) => {
    if (field === '$or') return cond.some(w => matches(row, w));
    if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) return OPS.eq(row[field], cond);
    return Object.entries(cond).every(([op, x]) => OPS[op]?.(row[field], x) ?? false);
  });
}

/** `sort` is [{ field, dir: "asc"|"desc" }]; nulls always last. */
function sorter(sort = []) {
  return (a, b) => {
    for (const { field, dir = 'asc' } of sort) {
      const c = cmp(a[field], b[field]);
      if (c) return dir === 'desc' && a[field] != null && b[field] != null ? -c : c;
    }
    return 0;
  };
}

const pick = (row, fields) => (fields ? Object.fromEntries(['title', 'path', ...fields].filter(k => k in row).map(k => [k, row[k]])) : row);

export function runQuery(rows, { where, sort, limit } = {}, fields) {
  return rows.filter(r => matches(r, where)).sort(sorter(sort)).slice(0, limit ?? 200).map(r => pick(r, fields));
}
