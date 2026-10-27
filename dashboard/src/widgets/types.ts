export type Row = Record<string, unknown>;

export interface Manifest {
  id: string;
  title: string;
  view: 'stat' | 'list' | 'table' | 'kanban' | 'bar' | 'today' | 'cards' | `code:${string}`;
  size?: 's' | 'm' | 'l' | 'full';
  fields?: string[];
  groupBy?: string;
  valueField?: string;
}

export interface Widget {
  manifest: Manifest;
  rows: Row[];
  error?: string;
}

export type Press = { status: 'approved' | 'snoozed' | 'rejected' | 'undone'; always?: boolean; never?: boolean };

export interface Ctx {
  now: number;
  demo?: boolean;
  press?: (card: Row, press: Press, reason: string) => Promise<string>;
  reportError?: (widgetId: string, message: string) => void;
}

type H = (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
type UseState = <T>(initial: T) => [T, (v: T) => void];
export interface Host {
  h: H;
  useState: UseState;
  CodeFrame?: unknown;
}

export interface LayoutEntry {
  id: string;
  size?: string;
  disabled?: boolean;
}

export type CodeView = (p: { m: Manifest; rows: Row[]; ctx: Ctx }) => unknown;
export type CodeWidget = (host: Host) => CodeView;
