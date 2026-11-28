import { describe, it, expect } from 'vitest';
import { planAggregate, sumModeFor } from '../../src/core/aggregatePlan';
import { ComparePlanError } from '../../src/core/errors';
import type { AggregateSpec, ColumnInfo, CompareRequest } from '../../src/core/types';

function col(name: string, type: string, o: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, type, maxLength: 0, precision: 0, scale: 0, nullable: true, ordinal: 0, ...o };
}
const ref = { profileId: 'p', database: 'd', schema: 's', name: 't' };
function req(aggregate: AggregateSpec | undefined, o: Partial<CompareRequest> = {}): CompareRequest {
  return {
    left: ref, right: ref, keyColumns: [], excludedColumns: [],
    ignoreCase: false, ignoreTrailingSpaces: false, mode: 'aggregate', aggregate, ...o,
  };
}
const left = [
  col('region', 'varchar', { maxLength: 10 }), col('amount', 'int'), col('cust', 'varchar', { maxLength: 20 }),
  col('name', 'varchar', { maxLength: 20 }),
];
const right = [
  col('AREA', 'varchar', { maxLength: 10 }), col('amt', 'decimal', { precision: 10, scale: 2 }),
  col('Cust', 'varchar', { maxLength: 20 }), col('name', 'varchar', { maxLength: 20 }),
];
const msg = (fn: () => unknown) => {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(ComparePlanError); return (e as Error).message; }
  return '';
};

describe('sumModeFor', () => {
  it('int vs decimal(10,2) is exact scale 2', () => {
    expect(sumModeFor(col('a', 'int'), col('b', 'decimal', { precision: 10, scale: 2 }))).toEqual({ kind: 'exact', scale: 2 });
  });
  it('too wide decimals fall to float', () => {
    expect(sumModeFor(
      col('a', 'decimal', { precision: 38, scale: 10 }), col('b', 'decimal', { precision: 38, scale: 0 }),
    )).toEqual({ kind: 'float' });
  });
  it('int vs float is float; text is undefined', () => {
    expect(sumModeFor(col('a', 'int'), col('b', 'float'))).toEqual({ kind: 'float' });
    expect(sumModeFor(col('a', 'varchar'), col('b', 'int'))).toBeUndefined();
  });
  it('money is decimal(19,4)', () => {
    expect(sumModeFor(col('a', 'money'), col('b', 'smallmoney'))).toEqual({ kind: 'exact', scale: 4 });
  });
});

describe('planAggregate', () => {
  const spec: AggregateSpec = {
    groupBy: [{ left: 'region', right: 'area' }],
    measures: [{ left: 'amount', right: 'amt', aggs: ['count', 'sum'] }, { left: 'cust', right: 'cust', aggs: ['distinct'] }],
  };
  it('builds targets in order with labels and aliases', () => {
    const p = planAggregate(left, right, req(spec));
    expect(p.targets.map((t) => t.label)).toEqual(['Rows', 'amount ↔ amt · sum', 'amount ↔ amt · count', 'cust · distinct count']);
    expect(p.targets.map((t) => t.alias)).toEqual(['rc', 'm_0_sum', 'm_0_count', 'm_1_distinct']);
    expect(p.targets[0]).toEqual({ label: 'Rows', agg: 'rows', measure: -1, alias: 'rc' });
    expect(p.groups[0].label).toBe('region ↔ area');
    expect(p.groups[0].rightName).toBe('AREA');
    expect(p.measures[0].sum).toEqual({ kind: 'exact', scale: 2 });
    expect(p.measures[1].rightName).toBe('Cust');
  });
  it('trailingSignificant', () => {
    expect(planAggregate(left, right, req(spec)).groups[0].trailingSignificant).toBe(true);
    expect(planAggregate(left, right, req(spec, { ignoreTrailingSpaces: true })).groups[0].trailingSignificant).toBe(false);
  });
  it('errors', () => {
    const m = (measures: AggregateSpec['measures'], groupBy: AggregateSpec['groupBy'] = []) =>
      msg(() => planAggregate(left, right, req({ groupBy, measures })));
    expect(msg(() => planAggregate(left, right, req(undefined)))).toBe('Add at least one measure.');
    expect(m([])).toBe('Add at least one measure.');
    expect(m([{ left: 'amount', right: 'amt', aggs: [] }])).toBe('Measure amount ↔ amt: choose at least one aggregate.');
    expect(m([{ left: 'amount', right: 'zzz', aggs: ['sum'] }])).toBe('Column zzz is not in the right table.');
    expect(m([{ left: 'zzz', right: 'amt', aggs: ['sum'] }])).toBe('Column zzz is not in the left table.');
    expect(m([{ left: 'name', right: 'name', aggs: ['sum'] }])).toBe('Measure name ↔ name: Sum needs numeric columns.');
    expect(m([{ left: 'amount', right: 'amt', aggs: ['count'] }], [{ left: 'region', right: 'amt' }]))
      .toBe('Group by region ↔ amt cannot be compared: incompatible types varchar vs decimal');
    expect(m([{ left: 'region', right: 'amt', aggs: ['distinct'] }]))
      .toBe('Measure region ↔ amt: Distinct count cannot be compared: incompatible types varchar vs decimal');
  });
  it('count-only on unplannable pair still succeeds without norm', () => {
    const p = planAggregate(left, right, req({ groupBy: [], measures: [{ left: 'region', right: 'amt', aggs: ['count'] }] }));
    expect(p.measures[0].norm).toBeUndefined();
  });
});
