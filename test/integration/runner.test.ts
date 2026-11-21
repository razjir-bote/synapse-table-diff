import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sql from 'mssql';
import { openRunner, type QueryRunner } from '../../src/db/runner';
import { CompareCancelledError } from '../../src/core/errors';

const conn = process.env.TABLEDIFF_TEST_CONN;
if (!conn) throw new Error('TABLEDIFF_TEST_CONN is not set');

const NUMBERS = (n: number) =>
  `SELECT TOP ${n} ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b`;

async function openWithRetry(attempts = 30, delayMs = 2000): Promise<QueryRunner> {
  const config = (sql.ConnectionPool as unknown as { parseConnectionString(s: string): sql.config })
    .parseConnectionString(conn as string);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await openRunner(config, 120);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

describe('openRunner', () => {
  let runner: QueryRunner;
  beforeAll(async () => { runner = await openWithRetry(); });
  afterAll(async () => { await runner?.close(); });

  it('query returns rows', async () => {
    expect(await runner.query<{ x: number }>('SELECT 1 AS x')).toEqual([{ x: 1 }]);
  });

  it('stream yields 5000 rows in order', async () => {
    let count = 0;
    let prev = 0;
    for await (const row of runner.stream<{ n: number | bigint }>(NUMBERS(5000))) {
      const n = Number(row.n);
      expect(n).toBeGreaterThan(prev);
      prev = n;
      count++;
    }
    expect(count).toBe(5000);
  });

  it('break after 10 rows leaves runner usable', async () => {
    let count = 0;
    for await (const _ of runner.stream(NUMBERS(100000))) {
      if (++count === 10) break;
    }
    expect(count).toBe(10);
    expect(await runner.query<{ x: number }>('SELECT 2 AS x')).toEqual([{ x: 2 }]);
  });

  it('abort during stream rejects with CompareCancelledError', async () => {
    const ac = new AbortController();
    let count = 0;
    const run = async () => {
      for await (const _ of runner.stream(
        'SELECT a.object_id FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c',
        ac.signal,
      )) {
        if (++count === 5) ac.abort();
      }
    };
    await expect(run()).rejects.toBeInstanceOf(CompareCancelledError);
    expect(await runner.query<{ x: number }>('SELECT 3 AS x')).toEqual([{ x: 3 }]);
  });

  it('abort during query rejects with CompareCancelledError', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await expect(
      runner.query("WAITFOR DELAY '00:00:30'", ac.signal),
    ).rejects.toBeInstanceOf(CompareCancelledError);
  });

  it('returns binary columns as Buffer', async () => {
    const rows = await runner.query<{ kh: Buffer; rh: Buffer }>(
      'SELECT CAST(0x0102 AS binary(2)) AS kh, CAST(0x03 AS varbinary(8)) AS rh',
    );
    expect(Buffer.isBuffer(rows[0].kh)).toBe(true);
    expect(Buffer.isBuffer(rows[0].rh)).toBe(true);
  });
});
