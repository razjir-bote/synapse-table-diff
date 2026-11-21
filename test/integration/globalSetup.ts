// Global setup for integration tests: (re)creates the tablediff_a / tablediff_b fixture databases.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import sql from 'mssql';

async function connectWithRetry(config: sql.config, attempts = 30, delayMs = 2000): Promise<sql.ConnectionPool> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const pool = new sql.ConnectionPool(config);
    try {
      return await pool.connect();
    } catch (err) {
      lastErr = err;
      try { await pool.close(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

export function seedBatches(text: string, bigRows: number): string[] {
  return text
    .replace(/\$\(BIG_ROWS\)/g, String(bigRows))
    .split(/^GO[ \t]*\r?$/m)
    .map((b) => b.trim())
    .filter((b) => b.replace(/^--.*$/gm, '').trim() !== '');
}

export default async function setup(): Promise<void> {
  const conn = process.env.TABLEDIFF_TEST_CONN;
  if (!conn) throw new Error('TABLEDIFF_TEST_CONN is not set');
  const bigRows = Number(process.env.TABLEDIFF_BIG_ROWS ?? 3_000_000);
  if (!Number.isInteger(bigRows) || bigRows < 0) throw new Error('TABLEDIFF_BIG_ROWS must be a non-negative integer');

  const config = (sql.ConnectionPool as unknown as { parseConnectionString(s: string): sql.config })
    .parseConnectionString(conn);
  const pool = await connectWithRetry({ ...config, requestTimeout: 30 * 60 * 1000, pool: { max: 1 } });
  const started = Date.now();
  try {
    const text = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');
    for (const batch of seedBatches(text, bigRows)) {
      await pool.request().batch(batch);
    }
  } finally {
    await pool.close();
  }
  // eslint-disable-next-line no-console
  console.log(`[globalSetup] seeded tablediff_a/tablediff_b (big = ${bigRows} rows) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
