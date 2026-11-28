import { describe, expect, it } from 'vitest';
import { BOM } from '../../src/export/csv';
import type { ColumnInfo } from '../../src/core/types';
import {
  diffSchemas, groupSchemaRows, reportFileName, reportSummary, schemaReportCsv, typeText,
  type Finding, type SchemaColumnRow, type SchemaObject,
} from '../../src/schemaCompare/report';

const col = (name: string, type: string, o: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name, type, maxLength: 4, precision: 0, scale: 0, nullable: true, ordinal: 1, ...o,
});

describe('typeText', () => {
  it('formats per spec', () => {
    expect(typeText(col('a', 'varchar', { maxLength: 50 }))).toBe('varchar(50)');
    expect(typeText(col('a', 'varchar', { maxLength: -1 }))).toBe('varchar(max)');
    expect(typeText(col('a', 'nvarchar', { maxLength: 50 }))).toBe('nvarchar(25)');
    expect(typeText(col('a', 'nvarchar', { maxLength: -1 }))).toBe('nvarchar(max)');
    expect(typeText(col('a', 'decimal', { precision: 10, scale: 2 }))).toBe('decimal(10,2)');
    expect(typeText(col('a', 'datetime2', { scale: 7 }))).toBe('datetime2(7)');
    expect(typeText(col('a', 'int'))).toBe('int');
  });
});

describe('groupSchemaRows', () => {
  it('groups by object, orders by column_id, lower-cases type, maps kind', () => {
    const r = (o: string, t: string, c: string, id: number, ty = 'INT'): SchemaColumnRow => ({
      object_name: o, object_type: t, column_name: c, type_name: ty,
      max_length: 4, precision: 10, scale: 0, is_nullable: true, column_id: id,
    });
    const g = groupSchemaRows([r('V1', 'V', 'b', 2), r('V1', 'V', 'a', 1), r('T', 'U ', 'x', 1)]);
    expect(g).toHaveLength(2);
    const v = g.find((o) => o.name === 'V1')!;
    expect(v.kind).toBe('view');
    expect(v.columns.map((c) => c.name)).toEqual(['a', 'b']);
    expect(v.columns[0].type).toBe('int');
    expect(g.find((o) => o.name === 'T')!.kind).toBe('table');
  });
});

const left: SchemaObject[] = [
  { name: 'Orders', kind: 'table', columns: [
    col('ID', 'int'), col('Name', 'varchar', { maxLength: 50 }),
    col('Amt', 'decimal', { precision: 10, scale: 2 }), col('Note', 'nvarchar', { maxLength: 200 })] },
  { name: 'Lines', kind: 'view', columns: [col('a', 'int')] },
];
const right: SchemaObject[] = [
  { name: 'orders', kind: 'external table', columns: [
    col('id', 'int'), col('name', 'nvarchar', { maxLength: 100 }),
    col('amt', 'decimal', { precision: 18, scale: 4 }), col('extra', 'int')] },
  { name: 'Stage', kind: 'table', columns: [col('a', 'int')] },
];

describe('diffSchemas', () => {
  const f = diffSchemas(left, right);
  it('reports all issue types in sorted order', () => {
    expect(f.map((x) => [x.table, x.issue, x.column])).toEqual([
      ['Lines', 'missing_table', ''],
      ['Orders', 'missing_column', 'Note'],
      ['Orders', 'extra_column', 'extra'],
      ['Orders', 'type_mismatch', 'Name'],
      ['Orders', 'size_mismatch', 'Amt'],
      ['Stage', 'extra_table', ''],
    ]);
  });
  it('has the expected details', () => {
    const by = (i: string) => f.find((x) => x.issue === i)!;
    expect(by('missing_table').details).toBe('view on the left; no table, view or external table with this name on the right');
    expect(by('extra_table').details).toBe('table on the right; not on the left');
    expect(by('missing_column').details).toBe('not in the right external table');
    expect(by('extra_column').details).toBe('not in the left table');
    expect(by('type_mismatch').details).toBe('');
    expect(by('size_mismatch').details).toBe('decimal(10,2) vs decimal(18,4)');
    expect(by('size_mismatch').leftType).toBe('decimal(10,2)');
    expect(by('size_mismatch').rightType).toBe('decimal(18,4)');
    expect(by('missing_column').leftType).toBe('nvarchar(100)');
    expect(by('missing_column').rightType).toBe('');
    expect(by('extra_column').rightType).toBe('int');
    expect(by('missing_table').column).toBe('');
    expect(by('missing_table').leftType).toBe('');
  });
  it('compares nvarchar max against nvarchar(4000) as a size mismatch', () => {
    const mk = (n: number): SchemaObject[] => [{ name: 'T', kind: 'table', columns: [col('c', 'nvarchar', { maxLength: n })] }];
    const r = diffSchemas(mk(-1), mk(8000));
    expect(r).toHaveLength(1);
    expect(r[0].issue).toBe('size_mismatch');
    expect(r[0].leftType).toBe('nvarchar(max)');
    expect(r[0].rightType).toBe('nvarchar(4000)');
    expect(r[0].details).toBe('nvarchar(max) vs nvarchar(4000)');
  });
  it('nvarchar(50) vs varchar(50) is a type mismatch', () => {
    const mk = (t: string, n: number): SchemaObject[] => [{ name: 'T', kind: 'table', columns: [col('c', t, { maxLength: n })] }];
    const r = diffSchemas(mk('nvarchar', 100), mk('varchar', 50));
    expect(r.map((x) => x.issue)).toEqual(['type_mismatch']);
  });
  it('identical inputs give no findings', () => {
    expect(diffSchemas(left, left)).toEqual([]);
  });
});

describe('schemaReportCsv', () => {
  it('has BOM, header, CRLF and neutralizes formulas', () => {
    const fs: Finding[] = [{ issue: 'extra_column', table: 't', column: '=cmd', leftType: '', rightType: 'int', details: 'a,b' }];
    const csv = schemaReportCsv(fs);
    expect(csv.startsWith(BOM + 'issue,table,column,left_type,right_type,details,status\r\n')).toBe(true);
    expect(csv).toContain("'=cmd");
    expect(csv).toContain('"a,b",\r\n');
  });
});

describe('reportSummary', () => {
  it('empty', () => expect(reportSummary([])).toBe('No differences found.'));
  it('counts with singular/plural', () => {
    const mk = (issue: Finding['issue']): Finding => ({ issue, table: 't', column: '', leftType: '', rightType: '', details: '' });
    expect(reportSummary([mk('missing_table'), mk('missing_table'), mk('type_mismatch')]))
      .toBe('3 findings: 2 missing tables, 1 type mismatch');
    expect(reportSummary([mk('extra_column')])).toBe('1 finding: 1 extra column');
  });
});

describe('reportFileName', () => {
  it('formats local time', () => {
    expect(reportFileName({ database: 'dw', schema: 'dbo' }, { database: 'lake', schema: 'ext' }, new Date(2026, 10, 28, 9, 5)))
      .toBe('schema-diff_dw.dbo_vs_lake.ext_20261128-0905.csv');
  });
});

describe('reportSummary with row counts', () => {
  const f = (issue: Finding['issue']): Finding => ({ issue, table: 't', column: '', leftType: '', rightType: '', details: '' });
  it('row count mismatch', () => expect(reportSummary([f('row_count_mismatch')])).toBe('1 finding: 1 row count mismatch'));
  it('row count errors plural', () => expect(reportSummary([f('row_count_error'), f('row_count_error')])).toBe('2 findings: 2 row count errors'));
  it('no findings', () => expect(reportSummary([], 12)).toBe('No differences found; row counts match for 12 tables.'));
  it('suffix', () => expect(reportSummary([f('missing_column')], 1)).toBe('1 finding: 1 missing column; row counts match for 1 table'));
  it('no suffix when row count findings exist', () => expect(reportSummary([f('row_count_mismatch')], 3)).toBe('1 finding: 1 row count mismatch'));
});
