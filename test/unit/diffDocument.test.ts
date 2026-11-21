import { describe, it, expect } from 'vitest';
import type * as vscode from 'vscode';
import type { CompareResult, DiffRow } from '../../src/core/types';
import { renderSideText, diffTitle, DiffDocumentProvider } from '../../src/ui/diffDocument';

function makeResult(rows: DiffRow[], overrides: Partial<CompareResult> = {}): CompareResult {
  const count = (kind: DiffRow['kind']) => rows.filter((r) => r.kind === kind).length;
  return {
    request: {
      left: { profileId: 'p1', database: 'db', schema: 'dbo', name: 'orders' },
      right: { profileId: 'p2', database: 'db2', schema: 'dbo', name: 'orders_new' },
      keyColumns: ['id', 'region'],
      excludedColumns: [],
      ignoreCase: false,
      ignoreTrailingSpaces: false,
    },
    schema: { columns: [], differenceCount: 0 },
    plan: {
      keys: [
        { name: 'id', leftName: 'id', rightName: 'id', norm: { family: 'integer', rtrim: false, upper: false } },
        { name: 'region', leftName: 'region', rightName: 'region', norm: { family: 'character', rtrim: false, upper: false } },
      ],
      compared: [
        { name: 'name', leftName: 'name', rightName: 'name', norm: { family: 'character', rtrim: false, upper: false } },
        { name: 'qty', leftName: 'qty', rightName: 'qty', norm: { family: 'integer', rtrim: false, upper: false } },
      ],
      excluded: [],
    },
    leftRows: 10,
    rightRows: 10,
    added: count('added'),
    removed: count('removed'),
    changed: count('changed'),
    rows,
    detailCapped: false,
    keyProblems: {
      duplicateKeys: [],
      nullKeys: [],
      leftDupRows: 0,
      rightDupRows: 0,
      leftNullKeyRows: 0,
      rightNullKeyRows: 0,
    },
    warnings: [],
    durationMs: 0,
    poolTypes: { left: 'dedicated', right: 'dedicated' },
    ...overrides,
  };
}

const rows: DiffRow[] = [
  { kind: 'changed', key: ['1', 'eu'], left: ['a', 'x'], right: ['A', 'y'], changedColumns: ['name', 'qty'] },
  { kind: 'removed', key: ['2', 'eu'], left: [null, '5'], changedColumns: [] },
  { kind: 'added', key: ['3', 'eu'], right: ['c', '7'], changedColumns: [] },
];

function uriOf(path: string): vscode.Uri {
  return { path } as unknown as vscode.Uri;
}

describe('renderSideText', () => {
  it('renders left: removed and changed rows only, with header', () => {
    expect(renderSideText(makeResult(rows), 'left')).toBe(
      [
        '-- db.dbo.orders (showing 3 of 3 differences)',
        'id=1, region=eu | name=a | qty=x',
        'id=2, region=eu | name=NULL | qty=5',
        '',
      ].join('\n'),
    );
  });

  it('renders right: added and changed rows only, with that side table in header', () => {
    expect(renderSideText(makeResult(rows), 'right')).toBe(
      [
        '-- db2.dbo.orders_new (showing 3 of 3 differences)',
        'id=1, region=eu | name=A | qty=y',
        'id=3, region=eu | name=c | qty=7',
        '',
      ].join('\n'),
    );
  });

  it('header shows rows shown of total differences when detail is capped', () => {
    const capped = makeResult(rows, { added: 4, removed: 0, changed: 1, detailCapped: true });
    expect(renderSideText(capped, 'right').split('\n')[0]).toBe(
      '-- db2.dbo.orders_new (showing 3 of 5 differences)',
    );
  });

  it('every line ends with a newline', () => {
    expect(renderSideText(makeResult(rows), 'left').endsWith('\n')).toBe(true);
  });

  it('renders only the header when there are no rows', () => {
    expect(renderSideText(makeResult([]), 'left')).toBe('-- db.dbo.orders (showing 0 of 0 differences)\n');
  });
});

describe('diffTitle', () => {
  it('names both tables with the arrow separator', () => {
    expect(diffTitle(makeResult(rows))).toBe('Table Diff: dbo.orders ↔ dbo.orders_new');
  });
});

describe('DiffDocumentProvider', () => {
  it('serves each side by runId and side from the uri path', () => {
    const result = makeResult(rows);
    const provider = new DiffDocumentProvider();
    provider.set('run1', result);
    expect(provider.provideTextDocumentContent(uriOf('/run1/left.txt'))).toBe(renderSideText(result, 'left'));
    expect(provider.provideTextDocumentContent(uriOf('/run1/right.txt'))).toBe(renderSideText(result, 'right'));
  });

  it('returns empty string for an unknown runId', () => {
    const provider = new DiffDocumentProvider();
    expect(provider.provideTextDocumentContent(uriOf('/nope/left.txt'))).toBe('');
  });

  it('returns empty string for an unknown file name', () => {
    const provider = new DiffDocumentProvider();
    provider.set('run1', makeResult(rows));
    expect(provider.provideTextDocumentContent(uriOf('/run1/other.txt'))).toBe('');
  });
});
