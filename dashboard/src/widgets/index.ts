import type { Ctx, Host, Widget } from './types';
import { primitives } from './primitives';
import { modules } from './modules';

export type { Ctx, Host, Widget, Row, Press } from './types';

export function createViews(host: Host) {
  const { h } = host;
  const views: Record<string, (p: never) => unknown> = { ...primitives(host), ...modules(host) };

  function WidgetView({ widget, ctx, size }: { widget: Widget; ctx: Ctx; size?: string }) {
    const { manifest: m, rows, error } = widget;
    const View = views[m.view] as unknown as (p: unknown) => unknown;
    const body = error ? h('p', { class: 'error' }, `This widget can't render: ${error}`) : View ? h(View, { m, rows, ctx }) : h('p', { class: 'error' }, `Unknown view "${m.view}"`);
    const count = m.view === 'cards' ? rows.filter(r => r.status === 'pending').length : m.view === 'today' ? null : rows.length;
    return h('section', { id: m.id, class: `panel size-${size ?? m.size ?? 'm'}`, 'data-view': m.view },
      h('h2', null, m.title, count === null ? null : h('span', { class: 'count' }, String(count))), body);
  }

  function Board({ layout, widgets, ctx }: { layout: { id: string; size?: string }[]; widgets: Record<string, Widget>; ctx: Ctx }) {
    return h('div', { class: 'board' }, layout.filter(l => widgets[l.id]).map(l => h(WidgetView, { key: l.id, widget: widgets[l.id], ctx, size: l.size })));
  }

  return { WidgetView, Board, views };
}
