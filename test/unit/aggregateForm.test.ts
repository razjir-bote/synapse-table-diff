import { describe, it, expect } from 'vitest';
import { aggregateProblem, aggregateRequest, isNumericPair, newMeasure, newPair, pruneAggregate } from '../../webview/setup/aggregateForm';
import type { SetupState } from '../../webview/setup/render';
import type { ColumnInfo } from '../../src/core/types';

const c = (name: string, type: string, ordinal: number): ColumnInfo => ({ name, type, maxLength: 50, precision: 18, scale: 2, nullable: true, ordinal });
const side = (cols: ColumnInfo[]) => ({
  profileId: 'p', database: 'db', table: { schema: 'dbo', name: 't' },
  databases: [], objects: [], columns: cols, declaredKey: [],
});
function state(over: Partial<SetupState> = {}): SetupState {
  return {
    profiles: [],
    sides: {
      left: side([c('Region', 'varchar', 1), c('Amount', 'decimal', 2)]),
      right: side([c('area', 'varchar', 1), c('amount', 'int', 2)]),
    },
    keyColumns: [], excludedColumns: [], filter: '', ignoreCase: false, ignoreTrailingSpaces: false,
    nullEqualsBlank: false, ignoreDataTypes: false,
    mode: 'aggregate', groupBy: [], measures: [], sumTolerance: '', sameFilter: true, rightFilter: '', ...over,
  };
}

describe('newPair', () => {
  it('picks the first unused left column, then the next', () => {
    const s = state();
    const first = newPair(s, []);
    expect(first).toEqual({ left: 'Region', right: 'area' });
    expect(newPair(s, [first])).toEqual({ left: 'Amount', right: 'amount' });
  });
  it('matches names case-insensitively, else falls back to the first right column', () => {
    const s = state();
    s.sides.right.columns = [c('REGION', 'varchar', 1)];
    expect(newPair(s, [])).toEqual({ left: 'Region', right: 'REGION' });
  });
});

describe('isNumericPair / newMeasure', () => {
  it('is true for int vs decimal, false for int vs varchar', () => {
    expect(isNumericPair(state(), { left: 'Amount', right: 'amount' })).toBe(true);
    expect(isNumericPair(state(), { left: 'Amount', right: 'area' })).toBe(false);
    expect(isNumericPair(state(), { left: 'Nope', right: 'amount' })).toBe(false);
  });
  it('newMeasure defaults to sum+count for numeric, count otherwise', () => {
    const s = state();
    expect(newMeasure(s)).toEqual({ left: 'Region', right: 'area', aggs: ['count'] });
    s.measures = [{ left: 'Region', right: 'area', aggs: ['count'] }];
    expect(newMeasure(s)).toEqual({ left: 'Amount', right: 'amount', aggs: ['sum', 'count'] });
  });
});

describe('pruneAggregate', () => {
  it('drops pairs naming a vanished column on either side', () => {
    const s = state({
      groupBy: [{ left: 'Region', right: 'area' }, { left: 'Gone', right: 'area' }],
      measures: [{ left: 'Amount', right: 'amount', aggs: ['sum'] }, { left: 'Amount', right: 'gone', aggs: ['count'] }],
    });
    pruneAggregate(s);
    expect(s.groupBy).toEqual([{ left: 'Region', right: 'area' }]);
    expect(s.measures).toEqual([{ left: 'Amount', right: 'amount', aggs: ['sum'] }]);
  });
});

describe('aggregateProblem', () => {
  it('requires a measure', () => {
    expect(aggregateProblem(state())).toBe('Add at least one measure.');
  });
  const withMeasure = { measures: [{ left: 'Amount', right: 'amount', aggs: ['sum' as const] }] };
  it('is undefined for a valid form', () => {
    expect(aggregateProblem(state(withMeasure))).toBeUndefined();
  });
  it('reports a bad tolerance', () => {
    expect(aggregateProblem(state({ ...withMeasure, sumTolerance: 'abc' }))).toMatch(/tolerance/i);
  });
  it('checks the right filter only when filters differ', () => {
    const bad = '1=1; DROP TABLE t';
    expect(aggregateProblem(state({ ...withMeasure, rightFilter: bad }))).toBeUndefined();
    expect(aggregateProblem(state({ ...withMeasure, rightFilter: bad, sameFilter: false }))).toMatch(/";"/);
    expect(aggregateProblem(state({ ...withMeasure, filter: bad }))).toMatch(/";"/);
  });
});

describe('aggregateRequest', () => {
  it('shares the filter by default and trims values', () => {
    const r = aggregateRequest(state({ filter: ' a=1 ', sumTolerance: ' 0.1% ', groupBy: [{ left: 'Region', right: 'area' }] }));
    expect(r).toEqual({
      mode: 'aggregate', keyColumns: [], excludedColumns: [], filter: 'a=1',
      aggregate: { groupBy: [{ left: 'Region', right: 'area' }], measures: [], sumTolerance: '0.1%', rightFilter: undefined },
    });
  });
  it("sends rightFilter '' when filters differ and the right one is empty", () => {
    const r = aggregateRequest(state({ sameFilter: false, filter: '' }));
    expect(r.filter).toBeUndefined();
    expect(r.aggregate!.rightFilter).toBe('');
    expect(r.aggregate!.sumTolerance).toBeUndefined();
  });
});
