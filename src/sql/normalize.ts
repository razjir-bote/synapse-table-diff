import type { ColumnInfo, ColumnNorm, DtPrecision, Family, Side } from '../core/types';

const FAMILIES: Record<string, Family> = {
  tinyint: 'integer', smallint: 'integer', int: 'integer', bigint: 'integer',
  decimal: 'exactDecimal', numeric: 'exactDecimal', money: 'exactDecimal', smallmoney: 'exactDecimal',
  float: 'approxFloat', real: 'approxFloat',
  char: 'character', varchar: 'character', nchar: 'character', nvarchar: 'character',
  date: 'datetime', smalldatetime: 'datetime', datetime: 'datetime', datetime2: 'datetime',
  time: 'time',
  datetimeoffset: 'datetimeoffset',
  bit: 'bit',
  uniqueidentifier: 'guid',
  binary: 'binary', varbinary: 'binary',
};

export function familyOf(c: ColumnInfo): Family {
  return FAMILIES[c.type] ?? 'unsupported';
}

type Opts = { ignoreCase: boolean; ignoreTrailingSpaces: boolean; nullEqualsBlank?: boolean; ignoreDataTypes?: boolean };
type PlanResult = { ok: true; norm: ColumnNorm } | { ok: false; reason: string };

/** Precision and scale of an exact numeric column (money types have fixed values). */
function decimalShape(c: ColumnInfo): { p: number; s: number } {
  if (c.type === 'money') return { p: 19, s: 4 };
  if (c.type === 'smallmoney') return { p: 10, s: 4 };
  return { p: c.precision, s: c.scale };
}

/** Datetime precision as a rank: day < minute < 0 < ... < 7. */
function dtRank(c: ColumnInfo): number {
  switch (c.type) {
    case 'date': return -2;
    case 'smalldatetime': return -1;
    case 'datetime': return 3;
    default: return c.scale; // datetime2
  }
}

function rankToPrecision(rank: number): DtPrecision {
  if (rank === -2) return 'day';
  if (rank === -1) return 'minute';
  return rank as DtPrecision;
}

/** Types with no family of their own that can still be read as text when data types are ignored. */
const TEXT_ONLY = new Set(['text', 'ntext', 'xml']);

const isNumeric = (f: Family) => f === 'integer' || f === 'exactDecimal' || f === 'approxFloat';

/** A column's shape when two numeric families meet: integers count as decimal(19,0). */
function asDecimal(c: ColumnInfo): ColumnInfo {
  return familyOf(c) === 'integer' ? { ...c, type: 'decimal', precision: 19, scale: 0 } : c;
}

/**
 * Plan for two columns of different types when the user chose to ignore data types. Two numbers compare as
 * numbers (integer with decimal as decimal, anything with float as float); everything else compares as text,
 * each side rendered by its own type's canonical form.
 */
function planMixed(l: ColumnInfo, r: ColumnInfo, lf: Family, rf: Family, opts: Opts): PlanResult {
  if (isNumeric(lf) && isNumeric(rf)) {
    if (lf !== 'approxFloat' && rf !== 'approxFloat') {
      const p = planColumnPair(asDecimal(l), asDecimal(r), { ...opts, ignoreDataTypes: false });
      if (p.ok) return p;
    }
    const style = l.type === 'real' || r.type === 'real' ? 1 : 2;
    return { ok: true, norm: { family: 'approxFloat', floatStyle: style, rtrim: false, upper: false } };
  }
  const own = (c: ColumnInfo, f: Family): ColumnNorm | undefined => {
    if (f === 'unsupported') return TEXT_ONLY.has(c.type) ? { family: 'character', rtrim: false, upper: false } : undefined;
    const p = planColumnPair(c, c, { ignoreCase: false, ignoreTrailingSpaces: false });
    return p.ok ? p.norm : undefined;
  };
  const ln = own(l, lf);
  const rn = own(r, rf);
  if (!ln) return { ok: false, reason: `unsupported type ${l.type}` };
  if (!rn) return { ok: false, reason: `unsupported type ${r.type}` };
  const fixedChar = (c: ColumnInfo) => c.type === 'char' || c.type === 'nchar';
  const norm: ColumnNorm = {
    family: 'character',
    rtrim: fixedChar(l) || fixedChar(r) || opts.ignoreTrailingSpaces,
    upper: opts.ignoreCase,
    perSide: { left: ln, right: rn },
  };
  if (opts.nullEqualsBlank) norm.blankAsNull = true;
  return { ok: true, norm };
}

export function planColumnPair(l: ColumnInfo, r: ColumnInfo, opts: Opts): PlanResult {
  const lf = familyOf(l);
  const rf = familyOf(r);
  if (opts.ignoreDataTypes && (lf !== rf || lf === 'unsupported')) return planMixed(l, r, lf, rf, opts);
  if (lf === 'unsupported') return { ok: false, reason: `unsupported type ${l.type}` };
  if (rf === 'unsupported') return { ok: false, reason: `unsupported type ${r.type}` };
  if (lf !== rf) return { ok: false, reason: `incompatible types ${l.type} vs ${r.type}` };

  const norm: ColumnNorm = { family: lf, rtrim: false, upper: false };
  switch (lf) {
    case 'exactDecimal': {
      const a = decimalShape(l);
      const b = decimalShape(r);
      const scale = Math.max(a.s, b.s);
      const intDigits = Math.max(a.p - a.s, b.p - b.s);
      if (intDigits + scale > 38) {
        // Ignoring data types: fall back to comparing as float rather than skipping the column.
        if (opts.ignoreDataTypes) return { ok: true, norm: { family: 'approxFloat', floatStyle: 2, rtrim: false, upper: false } };
        return { ok: false, reason: `decimal precision too large (${intDigits + scale} digits needed)` };
      }
      norm.decimalScale = scale;
      break;
    }
    case 'approxFloat':
      norm.floatStyle = l.type === 'real' || r.type === 'real' ? 1 : 2;
      break;
    case 'character':
      norm.rtrim = l.type === 'char' || l.type === 'nchar' || r.type === 'char' || r.type === 'nchar'
        || opts.ignoreTrailingSpaces;
      norm.upper = opts.ignoreCase;
      if (opts.nullEqualsBlank) norm.blankAsNull = true;
      break;
    case 'datetime':
      norm.dtPrecision = rankToPrecision(Math.min(dtRank(l), dtRank(r)));
      break;
    case 'time':
    case 'datetimeoffset':
      norm.dtPrecision = Math.min(l.scale, r.scale) as DtPrecision;
      break;
    default:
      break;
  }
  return { ok: true, norm };
}

/**
 * The normalized text of one side's column. Columns of different types (`norm.perSide`) are first rendered by
 * their own type's normalization, then compared as text.
 */
export function normalizeExpr(colSql: string, norm: ColumnNorm, side: Side = 'left'): string {
  const c = norm.perSide ? `(${normalizeExpr(colSql, norm.perSide[side])})` : colSql;
  switch (norm.family) {
    case 'integer':
      return `CONVERT(nvarchar(20), CAST(${c} AS bigint))`;
    case 'exactDecimal':
      return `CONVERT(nvarchar(50), CAST(${c} AS decimal(38,${norm.decimalScale ?? 0})))`;
    case 'approxFloat':
      return `CONVERT(nvarchar(30), CAST(${c} AS float), ${norm.floatStyle ?? 2})`;
    case 'character': {
      let e = `CAST(${c} AS nvarchar(max))`;
      if (norm.rtrim) e = `RTRIM(${e})`;
      if (norm.upper) e = `UPPER(${e})`;
      // T-SQL "=" pads with spaces, so this also matches spaces-only text.
      if (norm.blankAsNull) e = `CASE WHEN ${e} = N'' THEN NULL ELSE ${e} END`;
      return e;
    }
    case 'datetime': {
      const p = norm.dtPrecision;
      if (p === 'day') return `CONVERT(nvarchar(10), CAST(${c} AS date), 23)`;
      if (p === 'minute') {
        // Round to the nearest minute (seconds >= 30 round up), as SQL Server does when it stores a value in
        // smalldatetime: add 30 seconds, then truncate. Values within 30 s of the datetime2 maximum cannot be
        // shifted, so they are truncated instead (no smalldatetime can equal them anyway).
        const v = `CAST(${c} AS datetime2(7))`;
        return `CASE WHEN ${v} >= '9999-12-31T23:59:30' THEN N'9999-12-31T23:59' `
          + `ELSE LEFT(CONVERT(nvarchar(30), DATEADD(second, 30, ${v}), 126), 16) END`;
      }
      return `CONVERT(nvarchar(30), CAST(${c} AS datetime2(${p ?? 7})), 126)`;
    }
    case 'time':
      return `CAST(CAST(${c} AS time(${norm.dtPrecision ?? 7})) AS nvarchar(16))`;
    case 'datetimeoffset':
      return `CONVERT(nvarchar(30), CAST(SWITCHOFFSET(${c}, '+00:00') AS datetime2(${norm.dtPrecision ?? 7})), 126)`;
    case 'bit':
      return `CONVERT(nvarchar(1), ${c})`;
    case 'guid':
      return `CONVERT(nvarchar(36), ${c})`;
    case 'binary':
      return `CAST(CONVERT(varchar(max), ${c}, 2) AS nvarchar(max))`;
  }
}
