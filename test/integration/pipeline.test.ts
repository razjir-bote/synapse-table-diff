import { describe, it, expect, vi } from 'vitest';
import sql from 'mssql';
import { openRunner, type QueryRunner, type SideConnector } from '../../src/db/runner';
import { runComparison, type PipelineDeps } from '../../src/core/pipeline';
import { CompareCancelledError } from '../../src/core/errors';
import {
  DEFAULT_LIMITS, type CompareRequest, type Limits, type PoolType, type Stage, type TableRef,
} from '../../src/core/types';

const conn = process.env.TABLEDIFF_TEST_CONN;
if (!conn) throw new Error('TABLEDIFF_TEST_CONN is not set');
const baseConfig = (sql.ConnectionPool as unknown as { parseConnectionString(s: string): sql.config })
  .parseConnectionString(conn);

const DB_A = 'tablediff_a';
const DB_B = 'tablediff_b';

function connector(database: string, poolType: PoolType = 'other'): SideConnector {
  return {
    label: database,
    poolType,
    open: () => openRunner({ ...baseConfig, database }, 600),
  };
}

/** Wraps a connector, counting opens and closes. */
function counting(inner: SideConnector) {
  const stats = { opens: 0, closes: 0 };
  const c: SideConnector = {
    label: inner.label,
    poolType: inner.poolType,
    async open(): Promise<QueryRunner> {
      const r = await inner.open();
      stats.opens++;
      return {
        query: (s, sig) => r.query(s, sig),
        stream: (s, sig) => r.stream(s, sig),
        close: async () => { stats.closes++; await r.close(); },
      };
    },
  };
  return { c, stats };
}

const t = (database: string, name: string): TableRef => ({ profileId: 'test', database, schema: 'dbo', name });

function req(name: string, keyColumns: string[], over: Partial<CompareRequest> = {}): CompareRequest {
  return {
    left: t(DB_A, name),
    right: t(DB_B, name),
    keyColumns,
    excludedColumns: [],
    ignoreCase: false,
    ignoreTrailingSpaces: false,
    ...over,
  };
}

function deps(over: Partial<PipelineDeps> = {}, limits: Partial<Limits> = {}): PipelineDeps {
  return {
    left: connector(DB_A),
    right: connector(DB_B),
    limits: { ...DEFAULT_LIMITS, ...limits },
    ...over,
  };
}

describe('runComparison: orders', () => {
  it('defaults: removed 10, added 5, changed 54, schema diffs, no type-only data diffs', async () => {
    const res = await runComparison(req('orders', ['order_id']), deps());
    expect({ removed: res.removed, added: res.added, changed: res.changed }).toEqual({ removed: 10, added: 5, changed: 54 });
    expect(res.leftRows).toBe(50000);
    expect(res.rightRows).toBe(49995);
    expect(res.detailCapped).toBe(false);
    expect(res.warnings).toEqual([]);
    expect(res.poolTypes).toEqual({ left: 'other', right: 'other' });

    const col = (n: string) => res.schema.columns.find((c) => c.name.toLowerCase() === n);
    expect(col('region')?.status).toBe('added');
    expect(col('legacy_flag')?.status).toBe('removed');
    for (const n of ['amount', 'created', 'code', 'status', 'qty']) expect(col(n)?.changes).toContain('type');
    expect(res.plan.excluded.map((e) => e.name.toLowerCase())).toEqual(['qty']);
    expect(res.plan.compared.map((c) => c.name.toLowerCase())).toEqual(['amount', 'code', 'created', 'note', 'status']);

    // rows: all 69 differences, sorted numerically by key
    expect(res.rows).toHaveLength(69);
    const keys = res.rows.map((r) => Number(r.key[0]));
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
    const byKey = new Map(res.rows.map((r) => [r.key[0], r]));
    for (let k = 10; k <= 19; k++) expect(byKey.get(String(k))?.kind).toBe('removed');
    for (let k = 50001; k <= 50005; k++) expect(byKey.get(String(k))?.kind).toBe('added');
    expect(byKey.get('200')?.changedColumns).toEqual(['amount']);
    expect(byKey.get('300')?.changedColumns).toEqual(['note']);
    expect(byKey.get('400')?.changedColumns).toEqual(['status']);
    expect(byKey.get('500')?.changedColumns).toEqual(['note']);
    expect(byKey.get('120')?.changedColumns).toEqual(['status']);
    // type-only columns never show up as changed
    const changedCols = new Set(res.rows.flatMap((r) => r.changedColumns));
    expect([...changedCols].sort()).toEqual(['amount', 'note', 'status']);
    const removed = byKey.get('10')!;
    expect(removed.left).toBeDefined();
    expect(removed.right).toBeUndefined();
    const added = byKey.get('50001')!;
    expect(added.right).toBeDefined();
    expect(added.left).toBeUndefined();
    const st = res.plan.compared.findIndex((c) => c.name === 'status');
    expect(byKey.get('400')?.left?.[st]).toBe('Open');
    expect(byKey.get('400')?.right?.[st]).toBe('OPEN');
  });

  it('ignoreCase gives changed 53', async () => {
    const res = await runComparison(req('orders', ['order_id'], { ignoreCase: true }), deps());
    expect({ removed: res.removed, added: res.added, changed: res.changed }).toEqual({ removed: 10, added: 5, changed: 53 });
  });

  it('ignoreTrailingSpaces gives changed 53', async () => {
    const res = await runComparison(req('orders', ['order_id'], { ignoreTrailingSpaces: true }), deps());
    expect({ removed: res.removed, added: res.added, changed: res.changed }).toEqual({ removed: 10, added: 5, changed: 53 });
  });

  it('detailLimit 20 caps rows, counts unchanged', async () => {
    const res = await runComparison(req('orders', ['order_id']), deps({}, { detailLimit: 20 }));
    expect({ removed: res.removed, added: res.added, changed: res.changed }).toEqual({ removed: 10, added: 5, changed: 54 });
    expect(res.rows).toHaveLength(20);
    expect(res.detailCapped).toBe(true);
    expect(res.warnings).toContain('Showing the first 20 of 69 differing rows.');
  });

  it('pairLimit 100 re-buckets with identical counts; confirmExtraScan called once', async () => {
    const stages: Stage[] = [];
    const confirmExtraScan = vi.fn(async () => true);
    const res = await runComparison(
      req('orders', ['order_id']),
      deps({
        right: connector(DB_B, 'serverless'),
        confirmExtraScan,
        onProgress: (s) => { stages.push(s); },
      }, { pairLimit: 100 }),
    );
    expect(stages).toContain('rebucket');
    expect(confirmExtraScan).toHaveBeenCalledTimes(1);
    expect(confirmExtraScan).toHaveBeenCalledWith(['right']);
    expect({ removed: res.removed, added: res.added, changed: res.changed }).toEqual({ removed: 10, added: 5, changed: 54 });
    expect(res.rows).toHaveLength(69);
    expect(res.poolTypes).toEqual({ left: 'other', right: 'serverless' });
  });

  it('pairLimit 100 with serverless and confirm=false skips re-bucketing, counts identical', async () => {
    const stages: Stage[] = [];
    const res = await runComparison(
      req('orders', ['order_id']),
      deps({
        left: connector(DB_A, 'serverless'),
        confirmExtraScan: async () => false,
        onProgress: (s) => { stages.push(s); },
      }, { pairLimit: 100 }),
    );
    expect(stages).not.toContain('rebucket');
    expect({ removed: res.removed, added: res.added, changed: res.changed }).toEqual({ removed: 10, added: 5, changed: 54 });
  });

  it('pairLimit 100 with inListCap 10 falls back to level-1 ids, counts identical', async () => {
    const res = await runComparison(req('orders', ['order_id']), deps({}, { pairLimit: 100, inListCap: 10 }));
    expect({ removed: res.removed, added: res.added, changed: res.changed }).toEqual({ removed: 10, added: 5, changed: 54 });
    expect(res.rows).toHaveLength(69);
  });

  it('same database, two tables: 0 differences', async () => {
    const res = await runComparison(
      { ...req('orders', ['order_id']), right: t(DB_A, 'orders_copy') },
      deps({ right: connector(DB_A) }),
    );
    expect({ removed: res.removed, added: res.added, changed: res.changed }).toEqual({ removed: 0, added: 0, changed: 0 });
    expect(res.schema.differenceCount).toBe(0);
    expect(res.rows).toEqual([]);
    expect(res.leftRows).toBe(50000);
    expect(res.rightRows).toBe(50000);
  });
});

describe('runComparison: key problems and edge tables', () => {
  it('lines: duplicate sample left, null-key sample right, changed 1, warning', async () => {
    const res = await runComparison(req('lines', ['order_id', 'line_no']), deps());
    expect({ removed: res.removed, added: res.added, changed: res.changed }).toEqual({ removed: 0, added: 0, changed: 1 });
    expect(res.keyProblems.duplicateKeys).toEqual([{ side: 'left', key: ['1', '1'], count: 2 }]);
    expect(res.keyProblems.nullKeys).toEqual([{ side: 'right', key: ['50', null] }]);
    expect(res.keyProblems.leftDupRows).toBe(1);
    expect(res.keyProblems.rightNullKeyRows).toBe(1);
    expect(res.warnings).toContain(
      'Duplicate or NULL keys found; those keys are excluded, so the data diff is incomplete for them.',
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ kind: 'changed', key: ['2', '1'], changedColumns: ['sku'] });
  });

  it('odd name]x: 0 differences', async () => {
    const res = await runComparison(req('odd name]x', ["it's"]), deps());
    expect({ removed: res.removed, added: res.added, changed: res.changed }).toEqual({ removed: 0, added: 0, changed: 0 });
    expect(res.leftRows).toBe(3);
    expect(res.rightRows).toBe(3);
  });

  it('empty_t: added 3', async () => {
    const res = await runComparison(req('empty_t', ['id']), deps());
    expect({ removed: res.removed, added: res.added, changed: res.changed }).toEqual({ removed: 0, added: 3, changed: 0 });
    expect(res.leftRows).toBe(0);
    expect(res.rightRows).toBe(3);
    expect(res.rows.map((r) => r.key[0])).toEqual(['1', '2', '3']);
  });

  it('empty_both: all zeros', async () => {
    const res = await runComparison(req('empty_both', ['id']), deps());
    expect({
      removed: res.removed, added: res.added, changed: res.changed, leftRows: res.leftRows, rightRows: res.rightRows,
    }).toEqual({ removed: 0, added: 0, changed: 0, leftRows: 0, rightRows: 0 });
    expect(res.rows).toEqual([]);
    expect(res.warnings).toEqual([]);
  });
});

describe('runComparison: cancellation', () => {
  it('abort after the first checksums event rejects and closes every runner', async () => {
    const L = counting(connector(DB_A));
    const R = counting(connector(DB_B));
    const ac = new AbortController();
    const p = runComparison(req('orders', ['order_id']), {
      left: L.c,
      right: R.c,
      limits: DEFAULT_LIMITS,
      signal: ac.signal,
      onProgress: (s) => { if (s === 'checksums') ac.abort(); },
    });
    await expect(p).rejects.toBeInstanceOf(CompareCancelledError);
    expect(L.stats.opens).toBeGreaterThan(0);
    expect(L.stats.closes).toBe(L.stats.opens);
    expect(R.stats.closes).toBe(R.stats.opens);
  });

  it('abort mid-checksum query (big) rejects and closes every runner', async () => {
    const L = counting(connector(DB_A));
    const R = counting(connector(DB_B));
    const ac = new AbortController();
    const p = runComparison(req('big', ['id']), {
      left: L.c,
      right: R.c,
      limits: DEFAULT_LIMITS,
      signal: ac.signal,
      onProgress: (s) => { if (s === 'checksums') setTimeout(() => ac.abort(), 500); },
    });
    await expect(p).rejects.toBeInstanceOf(CompareCancelledError);
    expect(L.stats.closes).toBe(L.stats.opens);
    expect(R.stats.closes).toBe(R.stats.opens);
  });
});

const BIG_ROWS = Number(process.env.TABLEDIFF_BIG_ROWS ?? 3_000_000);
const BIG_CHANGED = BIG_ROWS >= 7 ? Math.floor((BIG_ROWS - 7) / 3000) + 1 : 0; // ids with id % 3000 = 7

describe('runComparison: big', () => {
  it(`changed ${BIG_CHANGED} (${BIG_ROWS} rows/side) with defaults in under 5 minutes`, async () => {
    const stages: string[] = [];
    const started = Date.now();
    const res = await runComparison(req('big', ['id']), deps({
      onProgress: (s) => { stages.push(`${s}@${((Date.now() - started) / 1000).toFixed(1)}s`); },
    }));
    const ms = Date.now() - started;
    // eslint-disable-next-line no-console
    console.log(`[big] ${res.leftRows} rows/side, changed ${res.changed} in ${(ms / 1000).toFixed(1)}s; stages: ${stages.join(', ')}`);
    expect({ removed: res.removed, added: res.added, changed: res.changed }).toEqual({ removed: 0, added: 0, changed: BIG_CHANGED });
    expect(res.leftRows).toBe(BIG_ROWS);
    expect(res.rows).toHaveLength(BIG_CHANGED);
    expect(res.rows.every((r) => Number(r.key[0]) % 3000 === 7 && r.changedColumns.join() === 'v')).toBe(true);
    expect(ms).toBeLessThan(5 * 60 * 1000);
  });
});
