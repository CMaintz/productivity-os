import type { Row } from './types';

const CI: Record<string, string> = { passing: '✅ passing', failing: '❌ failing', pending: '⏳ pending', none: '·' };
const SESSION: Record<string, string> = { waiting: '⏸ waiting', running: '▶ running', idle: '· idle', ended: '■ ended' };
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d/;

export function ago(iso: unknown, now: number) {
  if (typeof iso !== 'string' || !iso) return '—';
  const m = Math.max(0, Math.round((now - new Date(iso).valueOf()) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

export const plainLink = (s: string) => s.replace(/\[\[(?:[^\]|]*\/)?([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1');

export const label = (field: string) => (field === 'slug' ? 'project' : field.replace(/_/g, ' '));

export function cell(field: string, value: unknown, now: number): string {
  if (value === null || value === undefined || value === '') return '';
  if (field === 'ci') return CI[String(value)] ?? String(value);
  if (field === 'status' && SESSION[String(value)]) return SESSION[String(value)];
  if (Array.isArray(value)) return value.map(v => plainLink(String(v))).join(', ');
  if (typeof value === 'string' && ISO.test(value)) return ago(value, now);
  return plainLink(String(value));
}

export const titleOf = (row: Row) => String(row.title ?? row.slug ?? row.project ?? row.path ?? '');
export const isNumeric = (field: string, rows: Row[]) => rows.length > 0 && rows.every(r => r[field] === null || r[field] === undefined || typeof r[field] === 'number');
