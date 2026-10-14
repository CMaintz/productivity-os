import type { CodeView, Ctx, Host, LayoutEntry, Manifest, Row, Widget } from './types';
import { primitives } from './primitives';
import { modules } from './modules';
import { codeWidgets } from './code/registry';

export type { Ctx, Host, Widget, Row, Press, LayoutEntry } from './types';
export { codeWidgets } from './code/registry';

const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

export function createViews(host: Host) {
  const { h } = host;
  const views: Record<string, (p: never) => unknown> = { ...primitives(host), ...modules(host) };
  const code: Record<string, CodeView> = {};
  for (const [id, entry] of Object.entries(codeWidgets)) code[`code:${id}`] = entry.create(host);

  const failed = (ctx: Ctx, id: string, e: unknown) => {
    ctx.reportError?.(id, message(e));
    return h('p', { class: 'error' }, `This widget crashed: ${message(e)}`);
  };

  function IsolatedCodeView({ m, rows, ctx }: { m: Manifest; rows: Row[]; ctx: Ctx }) {
    try { return code[m.view]({ m, rows, ctx }); } catch (e) { return failed(ctx, m.id, e); }
  }

  function body(m: Manifest, rows: Row[], ctx: Ctx) {
    if (code[m.view]) {
      const view = h(IsolatedCodeView, { m, rows, ctx });
      return host.Boundary ? h(host.Boundary, { onError: (e: unknown) => failed(ctx, m.id, e) }, view) : view;
    }
    const View = views[m.view] as unknown as (p: unknown) => unknown;
    return View ? h(View, { m, rows, ctx }) : h('p', { class: 'error' }, `Unknown view "${m.view}"`);
  }

  function WidgetView({ widget, ctx, size }: { widget: Widget; ctx: Ctx; size?: string }) {
    const { manifest: m, rows, error } = widget;
    const content = error ? h('p', { class: 'error' }, `This widget can't render: ${error}`) : body(m, rows, ctx);
    const count = m.view === 'cards' ? rows.filter(r => r.status === 'pending').length : m.view === 'today' ? null : rows.length;
    return h('section', { id: m.id, class: `panel size-${size ?? m.size ?? 'm'}`, 'data-view': m.view },
      h('h2', null, m.title, count === null ? null : h('span', { class: 'count' }, String(count))), content);
  }

  function Board({ layout, widgets, ctx }: { layout: LayoutEntry[]; widgets: Record<string, Widget>; ctx: Ctx }) {
    const shown = layout.filter(l => widgets[l.id] && !l.disabled);
    return h('div', { class: 'board' }, shown.map(l => h(WidgetView, { key: l.id, widget: widgets[l.id], ctx, size: l.size })));
  }

  return { WidgetView, Board, views };
}
