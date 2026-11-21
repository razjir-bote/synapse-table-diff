import type { ChangeKind, DiffRow } from '../core/types';

export type KindFilter = ChangeKind | 'all';

export function totalsByKind(rows: DiffRow[]): Record<KindFilter, number> {
  const t: Record<KindFilter, number> = { all: rows.length, added: 0, removed: 0, changed: 0 };
  for (const r of rows) t[r.kind]++;
  return t;
}

/** One page of the held rows, filtered by kind (order preserved). */
export function pageRows(rows: DiffRow[], kind: KindFilter, offset: number, limit: number): DiffRow[] {
  const src = kind === 'all' ? rows : rows.filter((r) => r.kind === kind);
  return src.slice(offset, offset + limit);
}
