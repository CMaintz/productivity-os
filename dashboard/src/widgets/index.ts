import type { Ctx, Host, LayoutEntry, Manifest, Row, Widget } from './types';
import { primitives } from './primitives';
import { modules } from './modules';

export type { Ctx, Host, Widget, Row, Press, LayoutEntry } from './types';

export function createViews(host: Host) {
  const { h } = host;
  const views: Record<string, (p: never) => unknown> = { ...primitives(host), ...modules(host) };

  function body(m: Manifest, rows: Row[], ctx: Ctx) {
    if (m.view.startsWith('code:')) {
      return host.CodeFrame ? h(host.CodeFrame, { m, rows, ctx }) : h('p', { class: 'muted' }, 'Code widgets render on the web dashboard.');
    }
    const View = views[m.view] as unknown as (p: unknown) => unknown;
    return View ? h(View, { m, rows, ctx }) : h('p', { class: 'error' }, `Unknown view "${m.view}"`);
  }

  function WidgetView({ widget, ctx, size }: { widget: Widget; ctx: Ctx; size?: string }) {
    const { manifest: m, rows, error } = widget;
    const content = error ? h('p', { class: 'error' }, `This widget can't render: ${error}`) : body(m, rows, ctx);
    const count = m.view === 'cards' ? rows.filter(r => r.status === 'pending').length : m.view === 'today' ? null : rows.length;
    return h(
      'section',
      { id: m.id, class: `panel size-${size ?? m.size ?? 'm'}`, 'data-view': m.view },
      h('h2', null, m.title, count === null ? null : h('span', { class: 'count' }, String(count))),
      content,
    );
  }

  function Board({ layout, widgets, ctx }: { layout: LayoutEntry[]; widgets: Record<string, Widget>; ctx: Ctx }) {
    const shown = layout.filter(l => widgets[l.id] && !l.disabled);
    return h(
      'div',
      { class: 'board' },
      shown.map(l => h(WidgetView, { key: l.id, widget: widgets[l.id], ctx, size: l.size })),
    );
  }

  return { WidgetView, Board, views };
}
