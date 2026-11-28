import { describe, it, expect } from 'vitest';
import { pageRows, totalsByKind } from '../../src/ui/resultsPaging';
import type { AggregateRow, DiffRow } from '../../src/core/types';

const r = (kind: DiffRow['kind'], k: string): DiffRow => ({ kind, key: [k], changedColumns: [] });
const rows = [r('added', '1'), r('changed', '2'), r('added', '3'), r('removed', '4')];

describe('resultsPaging', () => {
  it('counts held rows by kind', () => {
    expect(totalsByKind(rows)).toEqual({ all: 4, added: 2, removed: 1, changed: 1 });
  });
  it('serves filtered pages', () => {
    expect(pageRows(rows, 'added', 0, 10).map((x) => x.key[0])).toEqual(['1', '3']);
    expect(pageRows(rows, 'added', 1, 1).map((x) => x.key[0])).toEqual(['3']);
    expect(pageRows(rows, 'all', 2, 200).map((x) => x.key[0])).toEqual(['3', '4']);
  });
});

describe('resultsPaging clamping', () => {
  it('clamps limit to 1..200 and offset to >= 0', () => {
    const many = Array.from({ length: 500 }, (_, i) => r('added', String(i)));
    expect(pageRows(many, 'all', 0, 100000).length).toBe(200);
    expect(pageRows(many, 'all', 0, 0).length).toBe(1);
    expect(pageRows(many, 'all', -5, 2).map((x) => x.key[0])).toEqual(['0', '1']);
  });
});

describe('resultsPaging (aggregate rows)', () => {
  const a = (kind: DiffRow['kind'], g: string): AggregateRow => ({ kind, group: [g], left: [], right: [], diff: [], differs: [] });
  const arows = [a('changed', 'x'), a('added', 'y'), a('changed', 'z')];
  it('is generic over aggregate rows', () => {
    expect(totalsByKind(arows)).toEqual({ all: 3, added: 1, removed: 0, changed: 2 });
    expect(pageRows(arows, 'changed', 1, 10).map((r) => r.group[0])).toEqual(['z']);
  });
});
