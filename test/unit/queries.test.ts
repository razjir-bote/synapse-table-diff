import { describe, it, expect } from 'vitest';
import { diffSchema } from '../../src/core/schemaDiff';
import type { ColumnInfo, ComparePlan, CompareRequest, TableRef } from '../../src/core/types';
import { assertAllowedSql } from '../../src/sql/allowList';
import {
  bucketQuery, columnsQuery, declaredKeyQuery, detailQuery, engineEditionQuery,
  listDatabasesQuery, listObjectsQuery, pairQuery,
} from '../../src/sql/queries';

function col(name: string, type: string, o: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, type, maxLength: 0, precision: 0, scale: 0, nullable: true, ordinal: 0, ...o };
}
const ordered = (cols: ColumnInfo[]) => cols.map((c, i) => ({ ...c, ordinal: i + 1 }));
const ref: TableRef = { profileId: 'p', database: 'd', schema: 'dbo', name: 'orders' };
function planFor(l: ColumnInfo[], r: ColumnInfo[], keys: string[]): ComparePlan {
  const req: CompareRequest = {
    left: ref, right: ref, keyColumns: keys, excludedColumns: [], ignoreCase: false, ignoreTrailingSpaces: false,
  };
  return diffSchema(ordered(l), ordered(r), req).plan;
}
const plan = planFor(
  [col('id', 'int', { nullable: false }), col('code', 'varchar', { maxLength: 10 }), col('amount', 'decimal', { precision: 10, scale: 2 })],
  [col('ID', 'int', { nullable: false }), col('code', 'varchar', { maxLength: 10 }), col('amount', 'decimal', { precision: 10, scale: 2 })],
  ['id'],
);
const within1 = { level: 1 as const, ids: [3, 4] };
const SEG = (v: string) =>
  `CASE WHEN ${v} IS NULL THEN N'~' ELSE N'#' + CAST(DATALENGTH(${v})/2 AS nvarchar(20)) + N':' + ${v} END`;

describe('queries', () => {
  it('all generated queries pass the allow-list', () => {
    const all = [
      engineEditionQuery(), listDatabasesQuery(), listObjectsQuery(),
      columnsQuery(ref), declaredKeyQuery(ref),
      bucketQuery(plan, 'left', ref, undefined, 1),
      bucketQuery(plan, 'right', ref, undefined, 2, within1),
      pairQuery(plan, 'left', ref, undefined, within1),
      detailQuery(plan, 'right', ref, undefined, { level: 2, ids: [5, 9] }),
    ];
    for (const q of all) expect(() => assertAllowedSql(q), q).not.toThrow();
  });

  it('catalog queries use OBJECT_ID with a quoted name', () => {
    expect(columnsQuery(ref)).toContain("OBJECT_ID(N'[dbo].[orders]')");
    expect(declaredKeyQuery(ref)).toContain('key_ordinal');
    expect(engineEditionQuery()).toBe("SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS engine_edition");
  });

  it('builds hash, bucket and aggregate expressions exactly', () => {
    const q = bucketQuery(plan, 'right', ref, undefined, 1);
    const key = SEG('CONVERT(nvarchar(20), CAST([ID] AS bigint))');
    expect(q).toContain(`HASHBYTES('SHA2_256', ${key}) AS kh`);
    expect(q).toContain('CAST(SUBSTRING(h.kh,1,3) AS int) AS b24');
    expect(q).toContain('CASE WHEN [ID] IS NULL THEN 1 ELSE 0 END AS knull');
    expect(q).toContain('CASE WHEN knull=1 THEN -1 ELSE b24/4096 END AS b1');
    expect(q).toContain('GROUP BY CASE WHEN knull=1 THEN -1 ELSE b24/4096 END');
    expect(q).toContain('COUNT_BIG(*) AS cnt, COUNT_BIG(DISTINCT kh) AS dk');
    expect(q).toContain('SUM(CAST(CAST(SUBSTRING(rh,1,8) AS bigint) AS decimal(38,0))) AS s1');
    expect(q).toContain('SUM(CAST(CAST(SUBSTRING(rh,9,8) AS bigint) AS decimal(38,0))) AS s2');
    const rowSegs = plan.compared.map((c) => SEG(
      c.name === 'code' ? 'CAST([code] AS nvarchar(max))' : 'CONVERT(nvarchar(50), CAST([amount] AS decimal(38,2)))',
    ));
    expect(q).toContain(`HASHBYTES('SHA2_256', ${rowSegs.join(' + ')}) AS rh`);
    expect(bucketQuery(plan, 'left', ref, undefined, 2)).toContain('CASE WHEN knull=1 THEN -1 ELSE b24/16 END AS b2');
    expect(q).toContain('[ID]');
    expect(bucketQuery(plan, 'left', ref, undefined, 1)).toContain('[id]');
  });

  it('pairQuery and detailQuery column lists', () => {
    const p = pairQuery(plan, 'left', ref, undefined, within1);
    expect(p).toMatch(/^SELECT kh, rh, knull, CASE WHEN knull=1 THEN -1 ELSE b24\/16 END AS b2, k_0\n/);
    expect(p).toContain('[id] AS k_0');
    expect(p.endsWith('ORDER BY kh')).toBe(true);
    expect(p).toContain('WHERE CASE WHEN knull=1 THEN -1 ELSE b24/4096 END IN (3,4)');
    const d = detailQuery(plan, 'left', ref, undefined, within1);
    expect(d).toMatch(/^SELECT kh, k_0, v_0, v_1, n_0, n_1\n/);
    expect(d).toContain('[amount] AS v_0');
    expect(d).toContain('CAST([code] AS nvarchar(max)) AS n_1');
    expect(d.endsWith('ORDER BY kh')).toBe(true);
  });

  it('quotes odd identifiers', () => {
    const odd = { ...ref, name: 'odd name]x' };
    const p = planFor(
      [col("it's", 'int', { nullable: false })], [col("it's", 'int', { nullable: false })], ["it's"],
    );
    const q = bucketQuery(p, 'left', odd, undefined, 1);
    expect(q).toContain('FROM [dbo].[odd name]]x]');
    expect(q).toContain("[it's]");
    expect(() => assertAllowedSql(q)).not.toThrow();
  });

  it('handles filters', () => {
    for (const f of [undefined, '', '   ']) {
      expect(bucketQuery(plan, 'left', ref, f, 1)).not.toContain('WHERE');
    }
    const f = "region = 'EU' -- eu only";
    const q = bucketQuery(plan, 'left', ref, f, 1);
    expect(q).toContain("WHERE (\nregion = 'EU' -- eu only\n)) AS h");
    expect(q.replace(f, '1=1')).toContain('WHERE (\n1=1\n)');
    expect(() => assertAllowedSql(bucketQuery(plan, 'left', ref, undefined, 1))).not.toThrow();
  });

  it('uses the empty-string hash with zero compared columns', () => {
    const p = planFor([col('id', 'int')], [col('id', 'int')], ['id']);
    expect(p.compared).toHaveLength(0);
    expect(bucketQuery(p, 'left', ref, undefined, 1)).toContain("HASHBYTES('SHA2_256', N'') AS rh");
  });

  it('renders level-2 within filters and omits empty ones', () => {
    const q = pairQuery(plan, 'left', ref, undefined, { level: 2, ids: [5, 9] });
    expect(q).toContain('CASE WHEN knull=1 THEN -1 ELSE b24/16 END IN (5,9)');
    expect(pairQuery(plan, 'left', ref, undefined, { level: 2, ids: [] })).not.toContain('IN (');
  });

  it('has no comments', () => {
    expect(bucketQuery(plan, 'left', ref, undefined, 1)).not.toMatch(/--|\/\*/);
  });
});
