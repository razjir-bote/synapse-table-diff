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

const NOTE = '-- Each block is one key; for changed rows only the fields that differ are listed.';

describe('renderSideText', () => {
  it('renders left: one aligned block per key, placeholder for rows only on the right', () => {
    expect(renderSideText(makeResult(rows), 'left')).toBe(
      [
        '-- db.dbo.orders (showing 3 of 3 differences)',
        NOTE,
        '',
        '== CHANGED  id=1, region=eu',
        '   name : a',
        '   qty  : x',
        '',
        '== REMOVED  id=2, region=eu',
        '   name : NULL',
        '   qty  : 5',
        '',
        '== ADDED    id=3, region=eu',
        '   (no row with this key in the left table; it is only in dbo.orders_new)',
        '',
        '',
      ].join('\n'),
    );
  });

  it('renders right with the same block sizes, so keys line up line for line', () => {
    const right = renderSideText(makeResult(rows), 'right');
    expect(right).toBe(
      [
        '-- db2.dbo.orders_new (showing 3 of 3 differences)',
        NOTE,
        '',
        '== CHANGED  id=1, region=eu',
        '   name : A',
        '   qty  : y',
        '',
        '== REMOVED  id=2, region=eu',
        '   (no row with this key in the right table; it is only in dbo.orders)',
        '',
        '',
        '== ADDED    id=3, region=eu',
        '   name : c',
        '   qty  : 7',
        '',
      ].join('\n'),
    );
    const l = renderSideText(makeResult(rows), 'left').split('\n');
    const r = right.split('\n');
    expect(r).toHaveLength(l.length);
    l.forEach((line, i) => {
      if (line.startsWith('== ')) expect(r[i]).toBe(line);
    });
  });

  it('lists only the fields that differ for a changed row', () => {
    const one = makeResult([{ kind: 'changed', key: ['9', 'us'], left: ['same', '1'], right: ['same', '2'], changedColumns: ['qty'] }]);
    expect(renderSideText(one, 'left').split('\n').slice(3, 6)).toEqual(['== CHANGED  id=9, region=us', '   qty  : 1', '']);
    expect(renderSideText(one, 'right').split('\n').slice(3, 6)).toEqual(['== CHANGED  id=9, region=us', '   qty  : 2', '']);
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
    expect(renderSideText(makeResult([]), 'left')).toBe(`-- db.dbo.orders (showing 0 of 0 differences)\n${NOTE}\n`);
  });
});

describe('value escaping', () => {
  it('escapes CR and LF so each field stays on one line', () => {
    const r = makeResult([{ kind: 'removed', key: ['1'], left: ['a\r\nb', 'c\nd'], changedColumns: [] }]);
    const lines = renderSideText(r, 'left').split('\n');
    expect(lines).toHaveLength(7); // header, note, blank, block header, 2 fields, trailing empty
    expect(lines[4]).toBe('   name : a\\r\\nb');
    expect(lines[5]).toBe('   qty  : c\\nd');
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

  it('add() registers a result under a fresh run id and delete() forgets it', () => {
    const result = makeResult(rows);
    const provider = new DiffDocumentProvider();
    const a = provider.add(result);
    const b = provider.add(result);
    expect(a).not.toBe(b);
    expect(provider.size).toBe(2);
    expect(provider.provideTextDocumentContent(uriOf(`/${a}/left.txt`))).toBe(renderSideText(result, 'left'));
    provider.delete(a);
    expect(provider.size).toBe(1);
    expect(provider.provideTextDocumentContent(uriOf(`/${a}/left.txt`))).toBe('');
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

describe('empty strings', () => {
  it("show as '' so they differ visibly from NULL", () => {
    const r = makeResult([{ kind: 'changed', key: ['1', 'eu'], left: [null, '1'], right: ['', '1'], changedColumns: ['name'] }]);
    expect(renderSideText(r, 'left').split('\n')[4]).toBe('   name : NULL');
    expect(renderSideText(r, 'right').split('\n')[4]).toBe("   name : ''");
  });
});
