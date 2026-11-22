import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import type { CompareResult, DiffRow } from '../../src/core/types';
import { writeCsv, exportMessage, neutralizeFormula } from '../../src/export/csv';

function makeResult(rows: DiffRow[], overrides: Partial<CompareResult> = {}): CompareResult {
  const count = (kind: DiffRow['kind']) => rows.filter((r) => r.kind === kind).length;
  const col = (name: string) => ({ name, leftName: name, rightName: name, norm: { family: 'character' as const, rtrim: false, upper: false } });
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
    plan: { keys: [col('id'), col('region')], compared: [col('name'), col('qty')], excluded: [] },
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

/** Collects everything written to it. A small highWaterMark forces write() to return false. */
function collector() {
  const chunks: string[] = [];
  let backpressure = 0;
  const w = new Writable({
    highWaterMark: 4,
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      setImmediate(cb);
    },
  });
  const origWrite = w.write.bind(w);
  w.write = ((chunk: unknown, ...rest: unknown[]) => {
    const ok = origWrite(chunk as string);
    if (!ok) backpressure++;
    return ok;
  }) as typeof w.write;
  return { w, text: () => chunks.join(''), backpressure: () => backpressure };
}

describe('writeCsv', () => {
  it('starts with a UTF-8 BOM and writes the header then one row per DiffRow with CRLF endings', async () => {
    const c = collector();
    await writeCsv(makeResult(rows), c.w);
    const text = c.text();
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1).split('\r\n')).toEqual([
      'change_type,id,region,left_name,right_name,left_qty,right_qty',
      'changed,1,eu,a,A,x,y',
      'removed,2,eu,,,5,',
      'added,3,eu,,c,,7',
      '',
    ]);
  });

  it('writes NULL values as empty fields', async () => {
    const c = collector();
    await writeCsv(makeResult([{ kind: 'removed', key: ['2', 'eu'], left: [null, null], changedColumns: [] }]), c.w);
    expect(c.text().slice(1).split('\r\n')[1]).toBe('removed,2,eu,,,,');
  });

  it('quotes fields containing comma, quote, CR or LF and doubles embedded quotes', async () => {
    const c = collector();
    const tricky: DiffRow = {
      kind: 'changed',
      key: ['1', 'eu'],
      left: ['a,"b"\nc', 'plain'],
      right: ['x\ry', 'say "hi"'],
      changedColumns: ['name', 'qty'],
    };
    await writeCsv(makeResult([tricky]), c.w);
    expect(c.text().slice(1)).toBe(
      'change_type,id,region,left_name,right_name,left_qty,right_qty\r\n' +
        'changed,1,eu,"a,""b""\nc","x\ry",plain,"say ""hi"""\r\n',
    );
  });

  it('writes header only when there are no rows', async () => {
    const c = collector();
    await writeCsv(makeResult([]), c.w);
    expect(c.text()).toBe('﻿change_type,id,region,left_name,right_name,left_qty,right_qty\r\n');
  });

  it('respects backpressure and resolves once the stream has finished', async () => {
    const many: DiffRow[] = Array.from({ length: 500 }, (_, i) => ({
      kind: 'added' as const,
      key: [String(i), 'eu'],
      right: [`n${i}`, String(i)],
      changedColumns: [],
    }));
    const c = collector();
    await writeCsv(makeResult(many), c.w);
    expect(c.backpressure()).toBeGreaterThan(0);
    expect(c.text().split('\r\n')).toHaveLength(502); // BOM-prefixed header + 500 rows + trailing ''
    expect(c.w.writableFinished).toBe(true);
  });
});

describe('exportMessage', () => {
  it('reports the row count when not capped', () => {
    expect(exportMessage(makeResult(rows))).toBe('Exported 3 rows.');
  });

  it('reports shown and total differences when capped', () => {
    const capped = makeResult(rows, { added: 4, removed: 0, changed: 1, detailCapped: true });
    expect(exportMessage(capped)).toBe('Exported 3 rows (first 3 of 5 differences).');
  });
});

describe('writeCsv error handling', () => {
  const manyRows: DiffRow[] = Array.from({ length: 3000 }, (_, i) => ({
    kind: 'added' as const,
    key: [String(i), 'eu'],
    right: [`name-${i}-${'x'.repeat(40)}`, String(i)],
    changedColumns: [],
  }));

  it('rejects when the first write fails, without an unhandled error', async () => {
    const w = new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error('disk full'));
      },
    });
    await expect(writeCsv(makeResult(rows), w)).rejects.toThrow('disk full');
  });

  it('rejects when the stream is destroyed mid-stream while writes keep succeeding', async () => {
    let destroyed = false;
    const w = new Writable({
      highWaterMark: 1024 * 1024,
      write(_chunk, _enc, cb) {
        if (!destroyed) {
          destroyed = true;
          this.destroy(new Error('connection reset'));
        }
        cb();
      },
    });
    await expect(writeCsv(makeResult(manyRows), w)).rejects.toThrow();
  });

  it('rejects while waiting for drain when the stream is destroyed', async () => {
    const w = new Writable({
      highWaterMark: 1,
      write(_chunk, _enc, _cb) {
        // Never acknowledge: write() returns false and writeCsv waits for drain.
        setTimeout(() => this.destroy(new Error('drain wait failure')), 5);
      },
    });
    await expect(writeCsv(makeResult(rows), w)).rejects.toThrow('drain wait failure');
  });

  it('rejects instead of hanging when the stream errors after the last chunk, before finish', async () => {
    const w = new Writable({
      highWaterMark: 1024 * 1024,
      write(_chunk, _enc, _cb) {
        // Never acknowledge the write; error arrives while end() is pending.
        setTimeout(() => this.destroy(new Error('late failure')), 5);
      },
    });
    await expect(writeCsv(makeResult(rows), w)).rejects.toThrow('late failure');
  });
});

describe('neutralizeFormula', () => {
  it.each([
    ['=HYPERLINK("http://x","y")', `'=HYPERLINK("http://x","y")`],
    ['+cmd|/c calc', "'+cmd|/c calc"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tx', "'\tx"],
  ])('prefixes formula-like %j', (v, out) => {
    expect(neutralizeFormula(v)).toBe(out);
  });
  it.each(['-5', '+1.5e3', '-0.25', 'plain', 'a=b', ''])('leaves %j alone', (v) => {
    expect(neutralizeFormula(v)).toBe(v);
  });
  it('is applied to exported fields', async () => {
    const chunks: string[] = [];
    const out = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
    const row: DiffRow = { kind: 'changed', key: ['=1+1'], left: ['@x'], right: ['-7'], changedColumns: ['note'] };
    await writeCsv(makeResult([row]), out);
    const body = chunks.join('');
    expect(body).toContain("'=1+1");
    expect(body).toContain("'@x");
    expect(body).toMatch(/,-7(\r\n|,)/);
  });
});
