import { describe, it, expect, afterAll } from 'vitest';
import sql from 'mssql';

const conn = process.env.TABLEDIFF_TEST_CONN;
if (!conn) throw new Error('TABLEDIFF_TEST_CONN is not set');

async function connectWithRetry(connStr: string, attempts = 30, delayMs = 2000) {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await sql.connect(connStr);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

describe('SQL Server connection', () => {
  const poolPromise = connectWithRetry(conn as string);

  afterAll(async () => {
    const pool = await poolPromise;
    await pool.close();
  });

  it('SELECT 1 returns 1', async () => {
    const pool = await poolPromise;
    const result = await pool.request().query('SELECT 1 AS x');
    expect(result.recordset[0].x).toBe(1);
  });
});
