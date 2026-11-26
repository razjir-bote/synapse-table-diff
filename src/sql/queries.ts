import type { ColumnInfo, ColumnPairPlan, ComparePlan, Side, TableRef } from '../core/types';
import { normalizeExpr } from './normalize';
import { qualifiedName, quoteIdent, sqlString } from './sqlText';
import { filterProblem } from './filterGuard';
import { ComparePlanError } from '../core/errors';

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
    "WHERE o.type IN ('U', 'V', 'ET')",
    'ORDER BY s.name, o.name',
  ].join('\n');
}

export type ObjectKind = 'table' | 'view' | 'external table';

/** Maps a sys.objects type code from listObjectsQuery to the kind shown in the table list. */
export function objectKindOf(objectType: unknown): ObjectKind {
  const t = String(objectType).trim().toUpperCase();
  if (t === 'V') return 'view';
  if (t === 'ET') return 'external table';
  return 'table';
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

const MAX_START = "CAST(N'' AS nvarchar(max))";

/** Families whose normalized expression is nvarchar(max). */
const isMaxFamily = (c: ColumnPairPlan) => c.norm.family === 'character' || c.norm.family === 'binary';

/**
 * Upper bound of a non-max segment's declared length in characters: every non-max normalized expression is at
 * most nvarchar(50), plus `#`, the nvarchar(20) length and `:`.
 */
const NON_MAX_SEGMENT_CHARS = 72;

/**
 * `a + b + c` is evaluated left to right, and a sum of non-max nvarchar values is typed nvarchar(n) with n capped
 * at 4000, so longer data is silently truncated (dropping later columns from the hash). Once an nvarchar(max)
 * value enters the chain, every later sum is nvarchar(max). So when the non-max segments before the first max
 * segment could exceed 4000 characters, the chain starts from an nvarchar(max) empty string.
 * It is not added otherwise: an nvarchar(max) key hash doubles the pass-2 time (LOB hashing per row).
 */
export function needsMaxStart(cols: ColumnPairPlan[]): boolean {
  const firstMax = cols.findIndex(isMaxFamily);
  const leading = firstMax === -1 ? cols.length : firstMax;
  return leading * NON_MAX_SEGMENT_CHARS > 4000;
}

function hashOf(cols: ColumnPairPlan[], side: Side): string {
  if (cols.length === 0) return "HASHBYTES('SHA2_256', N'')";
  const segs = cols.map((c) => segment(normalizeExpr(rawCol(c, side), c.norm, side)));
  if (needsMaxStart(cols)) segs.unshift(MAX_START);
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
  const problem = filterProblem(filter);
  if (problem) throw new ComparePlanError(problem);
  const where = filter !== undefined && filter.trim() !== '' ? ` WHERE (\n${filter}\n)` : '';
  const from =
    `FROM (SELECT h.*, CAST(SUBSTRING(h.kh,1,3) AS int) AS b24 FROM (SELECT ${inner} ` +
    `FROM ${qualifiedName(t)}${where}) AS h) AS x`;
  // Join to a constant id table rather than `<bucket expr> IN (...)`: SQL Server expands a long IN list on
  // a computed expression into ORs and re-evaluates the key hash for each element (minutes on millions of rows).
  if (!within || within.ids.length === 0) return { from, where: '' };
  for (const b of within.ids) {
    if (!Number.isInteger(b)) throw new Error(`Invalid bucket id: ${String(b)}`);
  }
  const ids = [...new Set(within.ids)].sort((a, b) => a - b);
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
  // Cast to varchar so the 38-digit sums reach the client exactly (the driver returns decimal as a JS double).
  const sum = (a: number) => `CAST(SUM(CAST(CAST(SUBSTRING(rh,${a},8) AS bigint) AS decimal(38,0))) AS varchar(40))`;
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

/**
 * Display value of a detail column, computed server-side as an exact string where the driver would lose
 * information (decimal -> double, datetime2/time -> Date in ms, datetimeoffset -> UTC). Other types are
 * returned raw and formatted by `formatValue`.
 */
export function displayExpr(colSql: string, col: ColumnInfo | undefined): string {
  switch (col?.type) {
    case 'decimal':
    case 'numeric':
      return `CONVERT(nvarchar(60), ${colSql})`;
    case 'money':
    case 'smallmoney':
      return `CONVERT(nvarchar(60), ${colSql}, 2)`;
    case 'date':
      return `CONVERT(nvarchar(10), ${colSql}, 23)`;
    case 'smalldatetime':
      return `CONVERT(nvarchar(19), ${colSql}, 120)`;
    case 'datetime':
    case 'datetime2':
      return `CONVERT(nvarchar(27), ${colSql}, 121)`;
    case 'datetimeoffset':
      return `CONVERT(nvarchar(34), ${colSql}, 121)`;
    case 'time':
      return `CONVERT(nvarchar(16), ${colSql})`;
    default:
      return colSql;
  }
}

const sideCol = (c: ColumnPairPlan, side: Side) => (side === 'left' ? c.leftCol : c.rightCol);

/** Detail rows of the given level-2 buckets, unordered (the caller looks rows up by kh). */
export function detailQuery(
  plan: ComparePlan,
  side: Side,
  t: TableRef,
  filter: string | undefined,
  within: BucketFilter,
): string {
  if (within.level !== 2 || within.ids.length === 0) throw new Error('detailQuery needs a level-2 bucket filter');
  const extra = [
    ...plan.keys.map((k, i) => `${displayExpr(rawCol(k, side), sideCol(k, side))} AS k_${i}`),
    ...plan.compared.map((c, i) => `${displayExpr(rawCol(c, side), sideCol(c, side))} AS v_${i}`),
    ...plan.compared.map((c, i) => `${normalizeExpr(rawCol(c, side), c.norm, side)} AS n_${i}`),
  ];
  const { from, where } = hashedTable(plan, side, t, filter, extra, within);
  const cols = [
    'kh',
    ...plan.keys.map((_, i) => `k_${i}`),
    ...plan.compared.map((_, i) => `v_${i}`),
    ...plan.compared.map((_, i) => `n_${i}`),
  ].join(', ');
  return `SELECT ${cols}\n${from}${where}`;
}
