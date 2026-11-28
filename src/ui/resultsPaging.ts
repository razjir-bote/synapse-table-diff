import type { ChangeKind } from '../core/types';

export const MAX_PAGE = 200;
export type KindFilter = ChangeKind | 'all';

export function totalsByKind<T extends { kind: ChangeKind }>(rows: T[]): Record<KindFilter, number> {
  const t: Record<KindFilter, number> = { all: rows.length, added: 0, removed: 0, changed: 0 };
  for (const r of rows) t[r.kind]++;
  return t;
}

/** One page of the held rows, filtered by kind (order preserved). */
export function pageRows<T extends { kind: ChangeKind }>(rows: T[], kind: KindFilter, offset: number, limit: number): T[] {
  const src = kind === 'all' ? rows : rows.filter((r) => r.kind === kind);
  const o = Math.max(0, Math.floor(Number(offset)) || 0);
  const l = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(limit)) || 1));
  return src.slice(o, o + l);
}
