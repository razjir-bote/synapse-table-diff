import { describe, it, expect } from 'vitest';
import { diffSchema } from '../../src/core/schemaDiff';
import type { ColumnInfo, ComparePlan, CompareRequest, TableRef } from '../../src/core/types';
import { assertAllowedSql } from '../../src/sql/allowList';
import { normalizeExpr } from '../../src/sql/normalize';
import {
  bucketQuery, columnsQuery, declaredKeyQuery, detailQuery, engineEditionQuery,
  listDatabasesQuery, listObjectsQuery, needsMaxStart, objectKindOf, pairQuery,
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
const MAX = "CAST(N'' AS nvarchar(max))";
const SEG = (v: string) =>
  `CASE WHEN ${v} IS NULL THEN N'~' ELSE N'#' + CAST(DATALENGTH(${v})/2 AS nvarchar(20)) + N':' + ${v} END`;

describe('queries', () => {
  it('refuses an unsafe filter instead of embedding it', () => {
    expect(() => bucketQuery(plan, 'left', ref, '1=1; DROP TABLE dbo.t', 1)).toThrow(/";"/);
    expect(() => pairQuery(plan, 'left', ref, 'a = 1) OR (1 = 1', { level: 1, ids: [] })).toThrow(/matching/);
  });

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
    expect(q).toContain('CAST(SUM(CAST(CAST(SUBSTRING(rh,1,8) AS bigint) AS decimal(38,0))) AS varchar(40)) AS s1');
    expect(q).toContain('CAST(SUM(CAST(CAST(SUBSTRING(rh,9,8) AS bigint) AS decimal(38,0))) AS varchar(40)) AS s2');
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
    expect(p).toContain(') AS x\nINNER JOIN (SELECT 3 AS b UNION ALL SELECT 4 AS b) AS f ON f.b = CASE WHEN knull=1 THEN -1 ELSE b24/4096 END\nORDER BY kh');
    expect(p).not.toContain(' IN (');
    const d = detailQuery(plan, 'left', ref, undefined, { level: 2, ids: [5] });
    expect(d).toMatch(/^SELECT kh, k_0, v_0, v_1, n_0, n_1\n/);
    expect(d).toContain('CONVERT(nvarchar(60), [amount]) AS v_0');
    expect(d).toContain('[code] AS v_1');
    expect(d).toContain('CAST([code] AS nvarchar(max)) AS n_1');
    // rows go into a map keyed by kh: no sort
    expect(d).not.toContain('ORDER BY');
    expect(d.endsWith('AS f ON f.b = CASE WHEN knull=1 THEN -1 ELSE b24/16 END')).toBe(true);
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
    expect(q).toContain('INNER JOIN (SELECT 5 AS b UNION ALL SELECT 9 AS b) AS f ON f.b = CASE WHEN knull=1 THEN -1 ELSE b24/16 END');
    const none = pairQuery(plan, 'left', ref, undefined, { level: 2, ids: [] });
    expect(none).not.toContain('IN (');
    expect(none).not.toContain('JOIN');
  });

  // A large IN list on the computed bucket expression made SQL Server re-evaluate the key hash once per
  // list element (a 70-id list took ~12s on 50k rows vs <1s for a full scan). A join to a constant id
  // table evaluates it once per row.
  it('filters buckets with a join to a de-duplicated id list (also for the bucket query, -1 included)', () => {
    const q = bucketQuery(plan, 'left', ref, "x = 1", 2, { level: 1, ids: [7, -1, 7] });
    expect(q).toContain('INNER JOIN (SELECT -1 AS b UNION ALL SELECT 7 AS b) AS f ON f.b = CASE WHEN knull=1 THEN -1 ELSE b24/4096 END\nGROUP BY');
    expect(() => assertAllowedSql(q)).not.toThrow();
    const ids = Array.from({ length: 5000 }, (_, i) => i);
    expect(() => assertAllowedSql(detailQuery(plan, 'left', ref, undefined, { level: 2, ids }))).not.toThrow();
  });

  it('rejects non-integer bucket ids', () => {
    for (const bad of [1.5, NaN, Infinity]) {
      expect(() => pairQuery(plan, 'left', ref, undefined, { level: 1, ids: [3, bad] })).toThrow(/bucket id/i);
    }
    expect(() => pairQuery(plan, 'left', ref, undefined, { level: 1, ids: ['1; DROP TABLE x' as unknown as number] }))
      .toThrow(/bucket id/i);
  });

  it('has no comments', () => {
    expect(bucketQuery(plan, 'left', ref, undefined, 1)).not.toMatch(/--|\/\*/);
  });

  // A `+` chain of non-max nvarchar segments is typed nvarchar(<=4000) and silently truncated (~90+ numeric
  // columns), so such a chain must start from an nvarchar(max) value.
  it('starts a hash from nvarchar(max) when its leading non-max segments could exceed 4000 characters', () => {
    const ints = (n: number, prefix = 'c') => Array.from({ length: n }, (_, i) => col(`${prefix}${String(i).padStart(3, '0')}`, 'bigint'));
    const many = ints(250);
    const p = planFor([col('id', 'int'), ...many], [col('id', 'int'), ...many], ['id']);
    for (const q of [bucketQuery(p, 'left', ref, undefined, 1), pairQuery(p, 'right', ref, undefined, within1)]) {
      // the key hash (one int) stays non-max; the 250-column row hash starts from nvarchar(max)
      expect(q).toContain("HASHBYTES('SHA2_256', CASE WHEN CONVERT(nvarchar(20), CAST([id] AS bigint))");
      expect(q).toContain(`HASHBYTES('SHA2_256', ${MAX} + CASE WHEN CONVERT(nvarchar(20), CAST([c000] AS bigint))`);
      expect(() => assertAllowedSql(q)).not.toThrow();
    }
    const at = (n: number) => planFor([col('id', 'int'), ...ints(n)], [col('id', 'int'), ...ints(n)], ['id']);
    expect(needsMaxStart(at(55).compared)).toBe(false); // 55 * 72 = 3960
    expect(needsMaxStart(at(56).compared)).toBe(true); // 56 * 72 = 4032
    // a max (string) segment early in the chain makes the rest nvarchar(max) already
    const strFirst = [col('a_str', 'varchar', { maxLength: 10 }), ...ints(100)];
    expect(needsMaxStart(planFor([col('id', 'int'), ...strFirst], [col('id', 'int'), ...strFirst], ['id']).compared)).toBe(false);
    // ... but not when it comes after more than 55 non-max segments
    const strLate = [...ints(60, 'a'), col('z_str', 'varchar', { maxLength: 10 })];
    expect(needsMaxStart(planFor([col('id', 'int'), ...strLate], [col('id', 'int'), ...strLate], ['id']).compared)).toBe(true);
  });

  it('every non-max normalized expression is at most nvarchar(50) (the 72-character segment bound)', () => {
    const types: ColumnInfo[] = [
      col('a', 'bigint'), col('b', 'decimal', { precision: 38, scale: 38 }), col('c', 'float'), col('d', 'real'),
      col('e', 'date'), col('f', 'smalldatetime'), col('g', 'datetime'), col('h', 'datetime2', { scale: 7 }),
      col('i', 'time', { scale: 7 }), col('j', 'datetimeoffset', { scale: 7 }), col('k', 'bit'), col('l', 'uniqueidentifier'),
    ];
    const mixed = [col('m', 'datetime2', { scale: 7 })];
    const l = [col('id', 'int'), ...types, ...mixed];
    const r = [col('id', 'int'), ...types, col('m', 'smalldatetime')];
    const p = planFor(l, r, ['id']);
    expect(p.compared).toHaveLength(13);
    for (const c of p.compared) {
      const e = normalizeExpr('[x]', c.norm);
      expect(e).not.toContain('max');
      for (const m of e.matchAll(/nvarchar\((\d+)\)/g)) expect(Number(m[1])).toBeLessThanOrEqual(50);
      expect(e).toMatch(/nvarchar\(\d+\)/);
    }
  });

  it('lists tables, views and external tables', () => {
    expect(listObjectsQuery()).toContain("WHERE o.type IN ('U', 'V', 'ET')");
    expect(objectKindOf('U ')).toBe('table');
    expect(objectKindOf('V ')).toBe('view');
    expect(objectKindOf('ET')).toBe('external table');
  });

  it('detailQuery only accepts a non-empty level-2 filter', () => {
    expect(() => detailQuery(plan, 'left', ref, undefined, within1)).toThrow(/level-2/);
    expect(() => detailQuery(plan, 'left', ref, undefined, { level: 2, ids: [] })).toThrow(/level-2/);
  });

  it("detail display values are exact server-side strings per type, using each side's own type", () => {
    const types: [ColumnInfo, string][] = [
      [col('a_dec', 'decimal', { precision: 38, scale: 10 }), 'CONVERT(nvarchar(60), [a_dec])'],
      [col('b_num', 'numeric', { precision: 12, scale: 4 }), 'CONVERT(nvarchar(60), [b_num])'],
      [col('c_money', 'money'), 'CONVERT(nvarchar(60), [c_money], 2)'],
      [col('d_date', 'date'), 'CONVERT(nvarchar(10), [d_date], 23)'],
      [col('e_sdt', 'smalldatetime'), 'CONVERT(nvarchar(19), [e_sdt], 120)'],
      [col('f_dt', 'datetime'), 'CONVERT(nvarchar(27), [f_dt], 121)'],
      [col('g_dt2', 'datetime2', { scale: 7 }), 'CONVERT(nvarchar(27), [g_dt2], 121)'],
      [col('h_dto', 'datetimeoffset', { scale: 7 }), 'CONVERT(nvarchar(34), [h_dto], 121)'],
      [col('i_time', 'time', { scale: 7 }), 'CONVERT(nvarchar(16), [i_time])'],
      [col('j_int', 'int'), '[j_int]'],
      [col('k_bin', 'varbinary', { maxLength: 10 }), '[k_bin]'],
      [col('l_str', 'nvarchar', { maxLength: 20 }), '[l_str]'],
    ];
    const cols = types.map(([c]) => c);
    const key = col('id', 'decimal', { precision: 20, scale: 2 });
    const p = planFor([key, ...cols], [key, ...cols], ['id']);
    const d = detailQuery(p, 'left', ref, undefined, { level: 2, ids: [1] });
    expect(d).toContain('CONVERT(nvarchar(60), [id]) AS k_0');
    types.forEach(([, expr], i) => expect(d).toContain(`${expr} AS v_${i}`));
    expect(() => assertAllowedSql(d)).not.toThrow();
    // a datetime vs date pair displays each side with its own type
    const mixed = planFor([col('id', 'int'), col('t', 'datetime')], [col('id', 'int'), col('t', 'date')], ['id']);
    expect(detailQuery(mixed, 'left', ref, undefined, { level: 2, ids: [1] })).toContain('CONVERT(nvarchar(27), [t], 121) AS v_0');
    expect(detailQuery(mixed, 'right', ref, undefined, { level: 2, ids: [1] })).toContain('CONVERT(nvarchar(10), [t], 23) AS v_0');
  });

  it('minute-precision normalization passes the allow-list', () => {
    const p = planFor(
      [col('id', 'int'), col('t', 'smalldatetime')], [col('id', 'int'), col('t', 'datetime2', { scale: 7 })], ['id'],
    );
    const q = bucketQuery(p, 'left', ref, undefined, 1);
    expect(q).toContain('DATEADD(second, 30, CAST([t] AS datetime2(7)))');
    expect(() => assertAllowedSql(q)).not.toThrow();
  });
});
