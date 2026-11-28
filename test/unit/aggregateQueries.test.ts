import { describe, it, expect } from 'vitest';
import { aggregateQuery } from '../../src/sql/aggregateQueries';
import { planAggregate } from '../../src/core/aggregatePlan';
import { normalizeExpr } from '../../src/sql/normalize';
import { assertAllowedSql } from '../../src/sql/allowList';
import { ComparePlanError } from '../../src/core/errors';
import type { AggregateSpec, ColumnInfo, CompareRequest } from '../../src/core/types';

function col(name: string, type: string, o: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, type, maxLength: 0, precision: 0, scale: 0, nullable: true, ordinal: 0, ...o };
}
const ref = { profileId: 'p', database: 'd', schema: 's', name: 't' };
function req(aggregate: AggregateSpec, o: Partial<CompareRequest> = {}): CompareRequest {
  return {
    left: ref, right: ref, keyColumns: [], excludedColumns: [],
    ignoreCase: false, ignoreTrailingSpaces: false, mode: 'aggregate', aggregate, ...o,
  };
}
const left = [
  col('region', 'varchar', { maxLength: 10 }), col('amount', 'int'), col("it's", 'varchar', { maxLength: 10 }),
  col('cust', 'varchar', { maxLength: 20 }), col('d', 'float'),
];
const right = [
  col('area', 'varchar', { maxLength: 10 }), col('amt', 'decimal', { precision: 18, scale: 4 }),
  col("it's", 'varchar', { maxLength: 10 }), col('customer', 'varchar', { maxLength: 20 }), col('d', 'float'),
];
const B = 'COLLATE Latin1_General_100_BIN2';

describe('aggregateQuery', () => {
  const r = req({
    groupBy: [{ left: 'region', right: 'area' }],
    measures: [{ left: 'amount', right: 'amt', aggs: ['sum', 'count'] }],
  });
  const plan = planAggregate(left, right, r);
  const g = (n: string, side: 'left' | 'right') => normalizeExpr(`[${n}]`, plan.groups[0].norm, side);

  it('right side exact SQL', () => {
    const G = g('area', 'right');
    expect(aggregateQuery(plan, 'right', ref, undefined)).toBe(
      `SELECT (${G}) ${B} AS g_0, CAST(COUNT_BIG(*) AS varchar(20)) AS rc, ` +
      `CAST(SUM(CAST([amt] AS decimal(38,4))) AS varchar(45)) AS m_0_sum, ` +
      `CAST(COUNT_BIG([amt]) AS varchar(20)) AS m_0_count\n` +
      `FROM [s].[t]\nGROUP BY (${G}) ${B}, DATALENGTH(${G})`,
    );
  });

  it('left side uses left names and filter', () => {
    const q = aggregateQuery(plan, 'left', ref, '[amount] > 1');
    expect(q).toContain('[region]');
    expect(q).not.toContain('[area]');
    expect(q).toContain('FROM [s].[t] WHERE (\n[amount] > 1\n)\nGROUP BY');
    assertAllowedSql(q);
  });

  it('no groups means no GROUP BY', () => {
    const p = planAggregate(left, right, req({ groupBy: [], measures: [{ left: 'amount', right: 'amt', aggs: ['count'] }] }));
    const q = aggregateQuery(p, 'left', ref, undefined);
    expect(q).not.toContain('GROUP BY');
    expect(q.startsWith('SELECT CAST(COUNT_BIG(*)')).toBe(true);
    assertAllowedSql(q);
  });

  it('ignoreTrailingSpaces drops DATALENGTH', () => {
    const p = planAggregate(left, right, { ...r, ignoreTrailingSpaces: true });
    const q = aggregateQuery(p, 'left', ref, undefined);
    expect(q).not.toContain('DATALENGTH');
    assertAllowedSql(q);
  });

  it('quotes odd identifiers', () => {
    const p = planAggregate(left, right, req({
      groupBy: [{ left: "it's", right: "it's" }], measures: [{ left: 'amount', right: 'amt', aggs: ['count'] }],
    }));
    const q = aggregateQuery(p, 'left', ref, undefined);
    expect(q).toContain("[it's]");
    assertAllowedSql(q);
  });

  it('distinct (with and without trailing marker) and float sum', () => {
    const spec: AggregateSpec = {
      groupBy: [],
      measures: [
        { left: 'cust', right: 'customer', aggs: ['distinct'] },
        { left: 'd', right: 'd', aggs: ['sum'] },
      ],
    };
    const p = planAggregate(left, right, req(spec));
    const q = aggregateQuery(p, 'right', ref, undefined);
    const M = normalizeExpr('[customer]', p.measures[0].norm!, 'right');
    expect(q).toContain(`CAST(COUNT_BIG(DISTINCT (${M} + N'|') ${B}) AS varchar(20)) AS m_0_distinct`);
    expect(q).toContain('CONVERT(varchar(30), SUM(CAST([d] AS float)), 3) AS m_1_sum');
    assertAllowedSql(q);

    const trimmed = planAggregate(left, right, req(spec, { ignoreTrailingSpaces: true }));
    const q2 = aggregateQuery(trimmed, 'left', ref, undefined);
    expect(q2).toContain(`COUNT_BIG(DISTINCT (${normalizeExpr('[cust]', trimmed.measures[0].norm!, 'left')}) ${B})`);
    expect(q2).not.toContain("N'|'");
    assertAllowedSql(q2);
  });

  it('unsafe filter throws', () => {
    expect(() => aggregateQuery(plan, 'left', ref, '1=1; DROP TABLE x')).toThrow(ComparePlanError);
  });
});
