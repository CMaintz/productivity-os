import { runQuery, type Query } from '../../../tools/widgets/query.mjs';
import { validateManifest } from '../../../tools/widgets/manifest.mjs';
import { createViews } from './index';
import type { Host, Manifest, Row } from './types';

type Source = Query & { kind: 'snapshot' | 'notes'; collection?: string; folder?: string };
type FullManifest = Manifest & { source: Source };

interface DcPage {
  $path: string;
  $name: string;
  $frontmatter?: Record<string, unknown>;
  value(key: string): unknown;
}
export interface Dc {
  preact: { h: Host['h'] };
  useState: Host['useState'];
  useQuery(query: string): DcPage[];
  app: { vault: { adapter: { read(path: string): Promise<string> } } };
}

const FOLDERS: Record<string, string> = { projects: 'Projects', cards: '_system/actions', sessions: 'Sessions' };

const plain = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(plain);
  const o = v as { toISO?: () => string; obsidianLink?: () => string } | null;
  if (o?.obsidianLink) return o.obsidianLink();
  if (o?.toISO) return o.toISO();
  return v;
};

export function pageRow(p: DcPage, fields?: string[]): Row {
  const keys = fields ?? Object.keys(p.$frontmatter ?? {});
  const row: Row = { title: p.$name, path: p.$path, slug: p.$name };
  for (const k of keys) row[k] = plain(p.value(k));
  return row;
}

const folderOf = (s: Source) => (s.kind === 'notes' ? s.folder : FOLDERS[s.collection ?? '']);
const inFolder = (p: DcPage, folder: string) => p.$path.slice(0, p.$path.lastIndexOf('/')) === folder;
const TODAY_NOTE = "Today lives in today's daily note in Obsidian; this widget is for the web dashboard.";

export function createDatacoreWidgets(dc: Dc) {
  const host: Host = { h: dc.preact.h, useState: dc.useState };
  const { WidgetView } = createViews(host);

  function useRows(m: FullManifest): Row[] {
    const folder = folderOf(m.source);
    const pages = dc.useQuery(folder ? `@page and path("${folder.replace(/["\\]/g, '')}")` : '@page and false').filter(p => !!folder && inFolder(p, folder));
    const extra = [m.groupBy, m.valueField].filter(Boolean) as string[];
    const shown = m.fields && [...m.fields, ...extra];
    const read = m.source.kind === 'notes' ? shown : undefined;
    return runQuery(
      pages.map(p => pageRow(p, read)),
      m.source,
      shown,
    );
  }

  function Widget({ manifest }: { manifest: FullManifest }) {
    let rows: Row[] = [];
    let error = manifest.source.collection === 'today' ? TODAY_NOTE : undefined;
    try {
      rows = useRows(manifest);
    } catch (e) {
      error = `couldn't compute rows: ${(e as Error).message}`;
    }
    return host.h(WidgetView, { widget: { manifest, rows, error }, ctx: { now: Date.now() } });
  }

  return { Widget, useRows };
}

export async function widgetView(dc: Dc, id: string) {
  const manifest = JSON.parse(await dc.app.vault.adapter.read(`_system/widgets/${id.replace(/[^a-z0-9-]/g, '')}.json`)) as FullManifest;
  const errors = validateManifest(manifest) as string[];
  const { Widget } = createDatacoreWidgets(dc);
  if (errors.length)
    return function Invalid() {
      return dc.preact.h('p', { class: 'error' }, `Widget "${id}" is invalid: ${errors.join('; ')}`);
    };
  return function View() {
    return dc.preact.h(Widget, { manifest });
  };
}
