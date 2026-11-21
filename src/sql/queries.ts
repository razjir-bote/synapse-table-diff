import type { ColumnPairPlan, ComparePlan, Side, TableRef } from '../core/types';
import { normalizeExpr } from './normalize';
import { qualifiedName, quoteIdent, sqlString } from './sqlText';

export interface BucketFilter { level: 1 | 2; ids: number[] }

export function engineEditionQuery(): string {
  return "SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS engine_edition";
}

export function listDatabasesQuery(): string {
  return 'SELECT name FROM sys.databases ORDER BY name';
}

export function listObjectsQuery(): string {
  return [
    'SELECT s.name AS schema_name, o.name AS object_name, o.type AS object_type',
    'FROM sys.objects AS o',
    'INNER JOIN sys.schemas AS s ON o.schema_id = s.schema_id',
    "WHERE o.type IN ('U', 'V')",
    'ORDER BY s.name, o.name',
  ].join('\n');
}

export function columnsQuery(t: { schema: string; name: string }): string {
  return [
    'SELECT c.name AS name, t.name AS type_name, c.max_length AS max_length, c.precision AS precision,',
    'c.scale AS scale, c.is_nullable AS is_nullable, c.column_id AS column_id',
    'FROM sys.columns AS c',
    'INNER JOIN sys.types AS t ON c.user_type_id = t.user_type_id',
    `WHERE c.object_id = OBJECT_ID(${sqlString(qualifiedName(t))})`,
    'ORDER BY c.column_id',
  ].join('\n');
}

export function declaredKeyQuery(t: { schema: string; name: string }): string {
  return [
    'SELECT i.index_id AS index_id, i.is_primary_key AS is_primary_key, c.name AS name, ic.key_ordinal AS key_ordinal',
    'FROM sys.indexes AS i',
    'INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id',
    'INNER JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id',
    `WHERE i.object_id = OBJECT_ID(${sqlString(qualifiedName(t))})`,
    'AND (i.is_primary_key = 1 OR i.is_unique_constraint = 1) AND ic.key_ordinal > 0',
    'ORDER BY i.index_id, ic.key_ordinal',
  ].join('\n');
}

function segment(v: string): string {
  return `CASE WHEN ${v} IS NULL THEN N'~' ELSE N'#' + CAST(DATALENGTH(${v})/2 AS nvarchar(20)) + N':' + ${v} END`;
}

function rawCol(c: ColumnPairPlan, side: Side): string {
  return quoteIdent(side === 'left' ? c.leftName : c.rightName);
}

function hashOf(cols: ColumnPairPlan[], side: Side): string {
  if (cols.length === 0) return "HASHBYTES('SHA2_256', N'')";
  const segs = cols.map((c) => segment(normalizeExpr(rawCol(c, side), c.norm)));
  return `HASHBYTES('SHA2_256', ${segs.join(' + ')})`;
}

function bucketExpr(level: 1 | 2): string {
  return `CASE WHEN knull=1 THEN -1 ELSE b24/${level === 1 ? 4096 : 16} END`;
}

function hashedTable(
  plan: ComparePlan,
  side: Side,
  t: TableRef,
  filter: string | undefined,
  extra: string[],
  within: BucketFilter | undefined,
): { from: string; where: string } {
  const knull = `CASE WHEN ${plan.keys.map((k) => `${rawCol(k, side)} IS NULL`).join(' OR ')} THEN 1 ELSE 0 END`;
  const inner = [
    `${hashOf(plan.keys, side)} AS kh`,
    `${hashOf(plan.compared, side)} AS rh`,
    `${knull} AS knull`,
    ...extra,
  ].join(', ');
  const where = filter !== undefined && filter.trim() !== '' ? ` WHERE (\n${filter}\n)` : '';
  const from =
    `FROM (SELECT h.*, CAST(SUBSTRING(h.kh,1,3) AS int) AS b24 FROM (SELECT ${inner} ` +
    `FROM ${qualifiedName(t)}${where}) AS h) AS x`;
  // Join to a constant id table rather than `<bucket expr> IN (...)`: SQL Server expands a long IN list on
  // a computed expression into ORs and re-evaluates the key hash for each element (minutes on millions of rows).
  if (!within || within.ids.length === 0) return { from, where: '' };
  const ids = [...new Set(within.ids.map((b) => Math.trunc(Number(b))))].sort((a, b) => a - b);
  const idTable = ids.map((b) => `SELECT ${b} AS b`).join(' UNION ALL ');
  return { from: `${from}\nINNER JOIN (${idTable}) AS f ON f.b = ${bucketExpr(within.level)}`, where: '' };
}

export function bucketQuery(
  plan: ComparePlan,
  side: Side,
  t: TableRef,
  filter: string | undefined,
  level: 1 | 2,
  within?: BucketFilter,
): string {
  const { from, where } = hashedTable(plan, side, t, filter, [], within);
  const b = bucketExpr(level);
  const alias = level === 1 ? 'b1' : 'b2';
  const sum = (a: number) => `SUM(CAST(CAST(SUBSTRING(rh,${a},8) AS bigint) AS decimal(38,0)))`;
  return (
    `SELECT ${b} AS ${alias}, COUNT_BIG(*) AS cnt, COUNT_BIG(DISTINCT kh) AS dk, ` +
    `${sum(1)} AS s1, ${sum(9)} AS s2\n${from}${where}\nGROUP BY ${b}`
  );
}

export function pairQuery(
  plan: ComparePlan,
  side: Side,
  t: TableRef,
  filter: string | undefined,
  within: BucketFilter,
): string {
  const extra = plan.keys.map((k, i) => `${rawCol(k, side)} AS k_${i}`);
  const { from, where } = hashedTable(plan, side, t, filter, extra, within);
  const ks = plan.keys.map((_, i) => `k_${i}`).join(', ');
  return `SELECT kh, rh, knull, ${bucketExpr(2)} AS b2, ${ks}\n${from}${where}\nORDER BY kh`;
}

export function detailQuery(
  plan: ComparePlan,
  side: Side,
  t: TableRef,
  filter: string | undefined,
  within: BucketFilter,
): string {
  const extra = [
    ...plan.keys.map((k, i) => `${rawCol(k, side)} AS k_${i}`),
    ...plan.compared.map((c, i) => `${rawCol(c, side)} AS v_${i}`),
    ...plan.compared.map((c, i) => `${normalizeExpr(rawCol(c, side), c.norm)} AS n_${i}`),
  ];
  const { from, where } = hashedTable(plan, side, t, filter, extra, within);
  const cols = [
    'kh',
    ...plan.keys.map((_, i) => `k_${i}`),
    ...plan.compared.map((_, i) => `v_${i}`),
    ...plan.compared.map((_, i) => `n_${i}`),
  ].join(', ');
  return `SELECT ${cols}\n${from}${where}\nORDER BY kh`;
}
