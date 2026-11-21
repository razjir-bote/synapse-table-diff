import { describe, it, expect } from 'vitest';
import { familyOf, planColumnPair, normalizeExpr } from '../../src/sql/normalize';
import type { ColumnInfo, ColumnNorm } from '../../src/core/types';

function col(type: string, o: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name: 'c', type, maxLength: 0, precision: 0, scale: 0, nullable: true, ordinal: 1, ...o };
}
const opts = { ignoreCase: false, ignoreTrailingSpaces: false };
function norm(l: ColumnInfo, r: ColumnInfo, o = opts): ColumnNorm {
  const p = planColumnPair(l, r, o);
  if (!p.ok) throw new Error(p.reason);
  return p.norm;
}
const base = { rtrim: false, upper: false };

describe('familyOf', () => {
  it.each([
    ['tinyint', 'integer'], ['smallint', 'integer'], ['int', 'integer'], ['bigint', 'integer'],
    ['decimal', 'exactDecimal'], ['numeric', 'exactDecimal'], ['money', 'exactDecimal'], ['smallmoney', 'exactDecimal'],
    ['float', 'approxFloat'], ['real', 'approxFloat'],
    ['char', 'character'], ['varchar', 'character'], ['nchar', 'character'], ['nvarchar', 'character'],
    ['date', 'datetime'], ['smalldatetime', 'datetime'], ['datetime', 'datetime'], ['datetime2', 'datetime'],
    ['time', 'time'], ['datetimeoffset', 'datetimeoffset'], ['bit', 'bit'], ['uniqueidentifier', 'guid'],
    ['binary', 'binary'], ['varbinary', 'binary'],
    ['xml', 'unsupported'], ['sql_variant', 'unsupported'], ['geography', 'unsupported'], ['geometry', 'unsupported'],
    ['hierarchyid', 'unsupported'], ['image', 'unsupported'], ['text', 'unsupported'], ['ntext', 'unsupported'],
    ['timestamp', 'unsupported'], ['whatever', 'unsupported'],
  ])('%s -> %s', (t, f) => {
    expect(familyOf(col(t))).toBe(f);
  });
});

describe('normalizeExpr', () => {
  it('integer', () => {
    expect(normalizeExpr('[c]', { ...base, family: 'integer' })).toBe('CONVERT(nvarchar(20), CAST([c] AS bigint))');
  });
  it('exactDecimal', () => {
    expect(normalizeExpr('[c]', { ...base, family: 'exactDecimal', decimalScale: 4 })).toBe(
      'CONVERT(nvarchar(50), CAST([c] AS decimal(38,4)))');
  });
  it('approxFloat', () => {
    expect(normalizeExpr('[c]', { ...base, family: 'approxFloat', floatStyle: 2 })).toBe(
      'CONVERT(nvarchar(30), CAST([c] AS float), 2)');
    expect(normalizeExpr('[c]', { ...base, family: 'approxFloat', floatStyle: 1 })).toBe(
      'CONVERT(nvarchar(30), CAST([c] AS float), 1)');
  });
  it('character plain / rtrim / upper / both', () => {
    const n = { family: 'character' as const };
    expect(normalizeExpr('[c]', { ...n, rtrim: false, upper: false })).toBe('CAST([c] AS nvarchar(max))');
    expect(normalizeExpr('[c]', { ...n, rtrim: true, upper: false })).toBe('RTRIM(CAST([c] AS nvarchar(max)))');
    expect(normalizeExpr('[c]', { ...n, rtrim: false, upper: true })).toBe('UPPER(CAST([c] AS nvarchar(max)))');
    expect(normalizeExpr('[c]', { ...n, rtrim: true, upper: true })).toBe('UPPER(RTRIM(CAST([c] AS nvarchar(max))))');
  });
  it('datetime day / minute / n', () => {
    expect(normalizeExpr('[c]', { ...base, family: 'datetime', dtPrecision: 'day' })).toBe(
      'CONVERT(nvarchar(10), CAST([c] AS date), 23)');
    expect(normalizeExpr('[c]', { ...base, family: 'datetime', dtPrecision: 'minute' })).toBe(
      'LEFT(CONVERT(nvarchar(30), CAST([c] AS datetime2(0)), 126), 16)');
    expect(normalizeExpr('[c]', { ...base, family: 'datetime', dtPrecision: 3 })).toBe(
      'CONVERT(nvarchar(30), CAST([c] AS datetime2(3)), 126)');
  });
  it('time', () => {
    expect(normalizeExpr('[c]', { ...base, family: 'time', dtPrecision: 3 })).toBe(
      'CAST(CAST([c] AS time(3)) AS nvarchar(16))');
  });
  it('datetimeoffset', () => {
    expect(normalizeExpr('[c]', { ...base, family: 'datetimeoffset', dtPrecision: 5 })).toBe(
      "CONVERT(nvarchar(30), CAST(SWITCHOFFSET([c], '+00:00') AS datetime2(5)), 126)");
  });
  it('bit', () => {
    expect(normalizeExpr('[c]', { ...base, family: 'bit' })).toBe('CONVERT(nvarchar(1), [c])');
  });
  it('guid', () => {
    expect(normalizeExpr('[c]', { ...base, family: 'guid' })).toBe('CONVERT(nvarchar(36), [c])');
  });
  it('binary', () => {
    expect(normalizeExpr('[c]', { ...base, family: 'binary' })).toBe(
      'CAST(CONVERT(varchar(max), [c], 2) AS nvarchar(max))');
  });
});

describe('planColumnPair', () => {
  it('decimal(10,2) vs decimal(12,4) -> scale 4', () => {
    const n = norm(col('decimal', { precision: 10, scale: 2 }), col('decimal', { precision: 12, scale: 4 }));
    expect(n.family).toBe('exactDecimal');
    expect(n.decimalScale).toBe(4);
  });
  it('money vs decimal uses fixed money precision/scale', () => {
    const n = norm(col('money'), col('decimal', { precision: 10, scale: 2 }));
    expect(n.decimalScale).toBe(4);
  });
  it('varchar vs int is incompatible', () => {
    expect(planColumnPair(col('varchar', { maxLength: 10 }), col('int'), opts)).toEqual({
      ok: false, reason: 'incompatible types varchar vs int' });
  });
  it('datetime vs datetime2(7) -> 3', () => {
    expect(norm(col('datetime'), col('datetime2', { scale: 7 })).dtPrecision).toBe(3);
  });
  it('date vs datetime -> day', () => {
    expect(norm(col('date'), col('datetime')).dtPrecision).toBe('day');
  });
  it('smalldatetime vs datetime -> minute', () => {
    expect(norm(col('smalldatetime'), col('datetime')).dtPrecision).toBe('minute');
  });
  it('time and datetimeoffset use min scale', () => {
    expect(norm(col('time', { scale: 7 }), col('time', { scale: 3 })).dtPrecision).toBe(3);
    expect(norm(col('datetimeoffset', { scale: 2 }), col('datetimeoffset', { scale: 7 })).dtPrecision).toBe(2);
  });
  it('real vs float -> floatStyle 1; float vs float -> 2', () => {
    expect(norm(col('real'), col('float')).floatStyle).toBe(1);
    expect(norm(col('float'), col('float')).floatStyle).toBe(2);
  });
  it('char vs varchar -> rtrim true', () => {
    expect(norm(col('char', { maxLength: 5 }), col('varchar', { maxLength: 5 })).rtrim).toBe(true);
    expect(norm(col('varchar'), col('varchar')).rtrim).toBe(false);
  });
  it('ignore options', () => {
    const n = norm(col('varchar'), col('nvarchar'), { ignoreCase: true, ignoreTrailingSpaces: true });
    expect(n.rtrim).toBe(true);
    expect(n.upper).toBe(true);
  });
  it('xml on either side excluded', () => {
    expect(planColumnPair(col('xml'), col('xml'), opts)).toEqual({ ok: false, reason: 'unsupported type xml' });
    expect(planColumnPair(col('int'), col('xml'), opts)).toEqual({ ok: false, reason: 'unsupported type xml' });
    expect(planColumnPair(col('xml'), col('int'), opts)).toEqual({ ok: false, reason: 'unsupported type xml' });
  });
  it('decimal(38,0) vs decimal(38,10) excluded', () => {
    const r = planColumnPair(col('decimal', { precision: 38, scale: 0 }), col('decimal', { precision: 38, scale: 10 }), opts);
    expect(r).toEqual({ ok: false, reason: 'decimal precision too large (48 digits needed)' });
  });
});
