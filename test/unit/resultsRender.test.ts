// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderSummary, renderSchemaTab, renderKeyProblems, formatDuration, typeDesc } from '../../webview/results/render';
import type { ColumnInfo, CompareResult, SchemaDiff, KeyProblems } from '../../src/core/types';

const ref = (name: string) => ({ profileId: 'p', database: 'db', schema: 'dbo', name });
function summary(over: Partial<Omit<CompareResult, 'rows'>> = {}): Omit<CompareResult, 'rows'> {
  return {
    request: { left: ref('a'), right: ref('b'), keyColumns: ['Id'], excludedColumns: [], ignoreCase: false, ignoreTrailingSpaces: false },
    schema: { columns: [], differenceCount: 3 },
    plan: { keys: [], compared: [], excluded: [] },
    leftRows: 42_100_000, rightRows: 42_100_005, added: 1234, removed: 5, changed: 1_000_000,
    detailCapped: false,
    keyProblems: { duplicateKeys: [], nullKeys: [], leftDupRows: 0, rightDupRows: 0, leftNullKeyRows: 0, rightNullKeyRows: 0 },
    warnings: [], durationMs: 12_345, poolTypes: { left: 'dedicated', right: 'serverless' }, ...over,
  };
}

describe('formatDuration', () => {
  it('formats ms and seconds', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(12_345)).toBe('12.3 s');
  });
});

describe('renderSummary', () => {
  it('shows counts with thousands separators, duration and pools', () => {
    const root = document.createElement('div');
    renderSummary(root, summary());
    const t = root.textContent ?? '';
    expect(t).toContain('42,100,000');
    expect(t).toContain('42,100,005');
    expect(t).toContain('1,234');
    expect(t).toContain('1,000,000');
    expect(t).toContain('12.3 s');
    expect(t).toContain('dedicated');
    expect(t).toContain('serverless');
  });
  it('renders each warning in a .warning banner via textContent', () => {
    const root = document.createElement('div');
    renderSummary(root, summary({ warnings: ['Detail <b>capped</b>', 'second'] }));
    const w = root.querySelectorAll('.warning');
    expect(w.length).toBe(2);
    expect(w[0].textContent).toBe('Detail <b>capped</b>');
    expect(w[0].querySelector('b')).toBeNull();
  });
});

describe('renderSchemaTab', () => {
  const col = (name: string, type: string) => ({ name, type, maxLength: 4, precision: 10, scale: 0, nullable: false, ordinal: 1 });
  const schema: SchemaDiff = {
    differenceCount: 3,
    columns: [
      { name: 'A', status: 'same', left: col('A', 'int'), right: col('A', 'int'), changes: [] },
      { name: 'B', status: 'added', right: col('B', 'int'), changes: [] },
      { name: 'C', status: 'removed', left: col('C', 'int'), changes: [] },
      { name: 'D', status: 'changed', left: col('D', 'int'), right: col('D', 'bigint'), changes: ['type'] },
    ],
  };
  it('renders status classes and excluded reasons', () => {
    const root = document.createElement('div');
    renderSchemaTab(root, schema, [{ name: 'Blob', reason: 'unsupported type' }]);
    expect(root.querySelectorAll('tr.added').length).toBe(1);
    expect(root.querySelectorAll('tr.removed').length).toBe(1);
    expect(root.querySelectorAll('tr.changed').length).toBe(1);
    expect(root.textContent).toContain('bigint');
    expect(root.textContent).toContain('Blob');
    expect(root.textContent).toContain('unsupported type');
  });
});

describe('typeDesc', () => {
  const c = (type: string, o: Partial<ColumnInfo> = {}): ColumnInfo =>
    ({ name: 'x', type, maxLength: 0, precision: 0, scale: 0, nullable: true, ordinal: 1, ...o });
  it('includes length, precision and scale', () => {
    expect(typeDesc(c('varchar', { maxLength: 50 }))).toBe('varchar(50)');
    expect(typeDesc(c('nvarchar', { maxLength: 40 }))).toBe('nvarchar(20)');
    expect(typeDesc(c('nvarchar', { maxLength: -1 }))).toBe('nvarchar(max)');
    expect(typeDesc(c('varbinary', { maxLength: -1 }))).toBe('varbinary(max)');
    expect(typeDesc(c('char', { maxLength: 5 }))).toBe('char(5)');
    expect(typeDesc(c('decimal', { precision: 12, scale: 4 }))).toBe('decimal(12,4)');
    expect(typeDesc(c('datetime2', { scale: 7 }))).toBe('datetime2(7)');
    expect(typeDesc(c('time', { scale: 3 }))).toBe('time(3)');
    expect(typeDesc(c('int', { maxLength: 4, precision: 10 }))).toBe('int');
    expect(typeDesc(c('datetime', { maxLength: 8, precision: 23, scale: 3 }))).toBe('datetime');
  });
  it('is shown in the schema tab', () => {
    const root = document.createElement('div');
    renderSchemaTab(root, {
      columns: [{ name: 'A', status: 'changed', left: c('varchar', { maxLength: 50 }), right: c('decimal', { precision: 12, scale: 4 }), changes: ['type'] }],
      differenceCount: 1,
    }, []);
    expect(root.textContent).toContain('varchar(50) NULL');
    expect(root.textContent).toContain('decimal(12,4) NULL');
  });
});

describe('renderKeyProblems', () => {
  it('shows totals and samples', () => {
    const k: KeyProblems = {
      duplicateKeys: [{ side: 'left', key: ['1', 'x'], count: 3 }],
      nullKeys: [{ side: 'right', key: [null, 'y'] }],
      leftDupRows: 3, rightDupRows: 0, leftNullKeyRows: 0, rightNullKeyRows: 1,
    };
    const root = document.createElement('div');
    renderKeyProblems(root, k);
    const t = root.textContent ?? '';
    expect(t).toContain('left');
    expect(t).toContain('1, x');
    expect(t).toContain('NULL, y');
    expect(root.querySelectorAll('.total').length).toBe(4);
  });
  it('says none when empty', () => {
    const root = document.createElement('div');
    renderKeyProblems(root, { duplicateKeys: [], nullKeys: [], leftDupRows: 0, rightDupRows: 0, leftNullKeyRows: 0, rightNullKeyRows: 0 });
    expect(root.textContent).toContain('No key problems');
  });
});
