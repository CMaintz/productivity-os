import type { Ctx, Host, Manifest, Row } from './types';
import { cell, isNumeric, label, titleOf } from './format';

const empty = (h: Host['h'], text = 'Nothing here.') => h('p', { class: 'empty' }, text);

export function primitives({ h }: Host) {
  function StatView({ m, rows }: { m: Manifest; rows: Row[] }) {
    const value = m.valueField ? rows.reduce((n, r) => n + (Number(r[m.valueField as string]) || 0), 0) : rows.length;
    return h('p', { class: 'stat' }, h('span', { class: 'stat-value' }, String(value)), h('span', { class: 'muted' }, m.valueField ? label(m.valueField) : 'items'));
  }

  function ListView({ m, rows, ctx }: { m: Manifest; rows: Row[]; ctx: Ctx }) {
    if (!rows.length) return empty(h);
    const sub = (r: Row) =>
      (m.fields ?? [])
        .map(f => cell(f, r[f], ctx.now))
        .filter(Boolean)
        .join(' · ');
    return h(
      'ul',
      { class: 'list' },
      rows.map((r, i) => h('li', { key: i }, h('span', null, titleOf(r)), h('span', { class: 'muted' }, sub(r)))),
    );
  }

  function TableView({ m, rows, ctx }: { m: Manifest; rows: Row[]; ctx: Ctx }) {
    if (!rows.length) return empty(h);
    const fields = m.fields?.length ? m.fields : Object.keys(rows[0]);
    const num = (f: string) => (isNumeric(f, rows) ? 'num' : undefined);
    const head = h(
      'tr',
      null,
      fields.map(f => h('th', { key: f, class: num(f) }, label(f))),
    );
    const body = rows.map((r, i) =>
      h(
        'tr',
        { key: i, 'data-status': r.status },
        fields.map(f => h('td', { key: f, class: num(f) }, cell(f, r[f], ctx.now))),
      ),
    );
    return h('table', null, h('thead', null, head), h('tbody', null, body));
  }

  function KanbanView({ m, rows, ctx }: { m: Manifest; rows: Row[]; ctx: Ctx }) {
    if (!rows.length) return empty(h);
    const by = m.groupBy as string;
    const groups = [...new Set(rows.map(r => String(r[by] ?? '—')))];
    const rest = (m.fields ?? []).filter(f => f !== by);
    const item = (r: Row, i: number) =>
      h(
        'li',
        { key: i },
        titleOf(r),
        rest.length
          ? h(
              'span',
              { class: 'muted' },
              rest
                .map(f => cell(f, r[f], ctx.now))
                .filter(Boolean)
                .join(' · '),
            )
          : null,
      );
    return h(
      'div',
      { class: 'kanban' },
      groups.map(g =>
        h('section', { key: g }, h('h3', { class: 'sub' }, `${g} (${rows.filter(r => String(r[by] ?? '—') === g).length})`), h('ul', null, rows.filter(r => String(r[by] ?? '—') === g).map(item))),
      ),
    );
  }

  function BarView({ m, rows }: { m: Manifest; rows: Row[] }) {
    if (!rows.length) return empty(h);
    const pairs: [string, number][] = m.groupBy
      ? [...new Set(rows.map(r => String(r[m.groupBy as string] ?? '—')))].map(g => [g, rows.filter(r => String(r[m.groupBy as string] ?? '—') === g).length])
      : rows.map(r => [titleOf(r), Number(r[m.valueField as string]) || 0]);
    const max = Math.max(1, ...pairs.map(([, n]) => n));
    return h(
      'ul',
      { class: 'bars' },
      pairs.map(([k, n]) =>
        h('li', { key: k }, h('span', { class: 'bar-label' }, k), h('span', { class: 'bar', style: `width:${Math.round((n / max) * 100)}%` }), h('span', { class: 'bar-value' }, String(n))),
      ),
    );
  }

  return { stat: StatView, list: ListView, table: TableView, kanban: KanbanView, bar: BarView };
}
