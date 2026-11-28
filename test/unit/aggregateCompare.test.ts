import { describe, it, expect } from 'vitest';
import { compareAggregates, parseTolerance } from '../../src/core/aggregateCompare';
import { ComparePlanError } from '../../src/core/errors';
import type { AggregatePlan, SumMode } from '../../src/core/types';

const norm = { expr: '', kind: 'text' } as never;
function plan(sum?: SumMode, withCount = false): AggregatePlan {
  const targets: AggregatePlan['targets'] = [{ label: 'Rows', agg: 'rows', measure: -1, alias: 'rc' }];
  if (sum) targets.push({ label: 'amount · sum', agg: 'sum', measure: 0, alias: 'm_0_sum' });
  if (withCount) targets.push({ label: 'amount · count', agg: 'count', measure: 0, alias: 'm_0_count' });
  return {
    groups: [{ leftName: 'g', rightName: 'g', label: 'g', norm, trailingSignificant: false }],
    measures: [{ leftName: 'a', rightName: 'a', aggs: ['sum'], sum }],
    targets,
  };
}
const row = (g: string | null, extra: Record<string, unknown> = {}) => ({ g_0: g, rc: '1', ...extra });
const none = parseTolerance(undefined);
const cmp = (l: any[], r: any[], p: AggregatePlan, t = none, limit = 100) => compareAggregates(l, r, p, t, limit);
const exact2 = plan({ kind: 'exact', scale: 2 });

describe('parseTolerance', () => {
  it('accepts numbers and percentages', () => {
    expect(parseTolerance(' 0.5 ')).toEqual({ kind: 'abs', value: '0.5' });
    expect(parseTolerance('2%')).toEqual({ kind: 'pct', value: '2' });
    expect(parseTolerance('')).toEqual({ kind: 'none' });
    expect(parseTolerance(undefined)).toEqual({ kind: 'none' });
  });
  it('rejects bad input', () => {
    for (const bad of ['-1', 'abc', '1e3']) {
      expect(() => parseTolerance(bad)).toThrow(ComparePlanError);
      expect(() => parseTolerance(bad)).toThrow('Sum tolerance must be a number like 0.01 or a percentage like 0.1%.');
    }
  });
});

describe('compareAggregates', () => {
  it('keeps NULL distinct from the string "NULL"', () => {
    const r = cmp([row(null)], [row('NULL')], plan());
    expect(r.removed).toBe(1);
    expect(r.added).toBe(1);
    expect(r.changed).toBe(0);
  });
  it('treats a NULL sum as 0', () => {
    const r = cmp([row('a', { m_0_sum: null })], [row('a', { m_0_sum: '0.00' })], exact2);
    expect(r.matching).toBe(1);
    expect(r.rows).toEqual([]);
  });
  it('compares huge decimal sums exactly', () => {
    const r = cmp([row('a', { m_0_sum: '12345678901234567890.01' })], [row('a', { m_0_sum: '12345678901234567890.02' })], exact2);
    expect(r.changed).toBe(1);
    expect(r.rows[0].kind).toBe('changed');
    expect(r.rows[0].diff).toEqual(['0', '0.01']);
    expect(r.rows[0].differs).toEqual([false, true]);
  });
  it('formats negative exact diffs with scale', () => {
    const r = cmp([row('a', { m_0_sum: '1.00' })], [row('a', { m_0_sum: '-0.50' })], exact2);
    expect(r.rows[0].diff[1]).toBe('-1.50');
  });
  it('applies absolute tolerance inclusively', () => {
    const t = parseTolerance('0.01');
    expect(cmp([row('a', { m_0_sum: '1.00' })], [row('a', { m_0_sum: '1.01' })], exact2, t).matching).toBe(1);
    const p = plan({ kind: 'exact', scale: 4 });
    expect(cmp([row('a', { m_0_sum: '1.0000' })], [row('a', { m_0_sum: '1.0101' })], p, t).changed).toBe(1);
    expect(cmp([row('a', { m_0_sum: '1.0000' })], [row('a', { m_0_sum: '1.0100' })], p, t).matching).toBe(1);
  });
  it('applies percentage tolerance relative to max', () => {
    const t = parseTolerance('1%');
    const p = plan({ kind: 'exact', scale: 1 });
    expect(cmp([row('a', { m_0_sum: '100.0' })], [row('a', { m_0_sum: '101.0' })], p, t).matching).toBe(1);
    expect(cmp([row('a', { m_0_sum: '100.0' })], [row('a', { m_0_sum: '101.5' })], p, t).changed).toBe(1);
    expect(cmp([row('a', { m_0_sum: '0.0' })], [row('a', { m_0_sum: null })], p, t).matching).toBe(1);
  });
  it('float sums use built-in tolerance', () => {
    const p = plan({ kind: 'float' });
    expect(cmp([row('a', { m_0_sum: '0.30000000000000004' })], [row('a', { m_0_sum: '0.3' })], p).matching).toBe(1);
    const r = cmp([row('a', { m_0_sum: '1' })], [row('a', { m_0_sum: '1.1' })], p);
    expect(r.changed).toBe(1);
    expect(r.rows[0].diff[1]).toBe(String(1.1 - 1));
  });
  it('user tolerance applies to float sums', () => {
    const p = plan({ kind: 'float' });
    expect(cmp([row('a', { m_0_sum: '1' })], [row('a', { m_0_sum: '1.1' })], p, parseTolerance('0.2')).matching).toBe(1);
    expect(cmp([row('a', { m_0_sum: '100' })], [row('a', { m_0_sum: '101' })], p, parseTolerance('1%')).matching).toBe(1);
  });
  it('counts are exact and ignore tolerance', () => {
    const p = plan({ kind: 'exact', scale: 2 }, true);
    const r = cmp(
      [row('a', { m_0_sum: '1.00', m_0_count: '5' })], [row('a', { m_0_sum: '1.00', m_0_count: '6' })],
      p, parseTolerance('50%'),
    );
    expect(r.rows[0].diff).toEqual(['0', '0.00', '1']);
    expect(r.rows[0].differs).toEqual([false, false, true]);
  });
  it('row count difference alone marks changed', () => {
    const r = cmp([{ g_0: 'a', rc: '2' }], [{ g_0: 'a', rc: '3' }], plan());
    expect(r.changed).toBe(1);
    expect(r.rows[0].diff).toEqual(['1']);
  });
  it('one-sided rows have null other side and diff', () => {
    const r = cmp([row('a'), row('b')], [row('b'), row('c')], plan());
    expect(r).toMatchObject({ leftGroups: 2, rightGroups: 2, removed: 1, added: 1, matching: 1, changed: 0 });
    const rem = r.rows.find((x) => x.kind === 'removed')!;
    expect(rem.right).toEqual([null]);
    expect(rem.diff).toEqual([null]);
    expect(rem.left).toEqual(['1']);
    const add = r.rows.find((x) => x.kind === 'added')!;
    expect(add.left).toEqual([null]);
    expect(add.group).toEqual(['c']);
  });
  it('sorts numerically and caps detail', () => {
    const r = cmp([row('10'), row('9'), row('a')], [], plan());
    expect(r.rows.map((x) => x.group[0])).toEqual(['9', '10', 'a']);
    const c = cmp([row('10'), row('9'), row('a')], [], plan(), none, 1);
    expect(c.rows).toHaveLength(1);
    expect(c.detailCapped).toBe(true);
    expect(c.removed).toBe(3);
    expect(r.detailCapped).toBe(false);
  });
});
