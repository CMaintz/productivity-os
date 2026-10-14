export type QueryRow = Record<string, unknown>;
export interface Query { where?: Record<string, unknown>; sort?: { field: string; dir?: 'asc' | 'desc' }[]; limit?: number }
export function matches(row: QueryRow, where?: Record<string, unknown>): boolean;
export function runQuery(rows: QueryRow[], query?: Query, fields?: string[]): QueryRow[];
