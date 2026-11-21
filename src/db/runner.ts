import sql from 'mssql';
import type { PoolType } from '../core/types';
import { CompareCancelledError } from '../core/errors';
import { mapConnectError } from './errors';

export interface QueryRunner {
  query<T = Record<string, unknown>>(sql: string, signal?: AbortSignal): Promise<T[]>;
  stream<T = Record<string, unknown>>(sql: string, signal?: AbortSignal): AsyncIterable<T>; // breaking out of the loop cancels the request
  close(): Promise<void>;
}

export interface SideConnector {
  label: string;
  poolType: PoolType;
  open(): Promise<QueryRunner>; // fetches a fresh token each call
}

const HIGH_WATER = 1000;

export async function openRunner(config: sql.config, timeoutSeconds: number): Promise<QueryRunner> {
  const pool = new sql.ConnectionPool({
    ...config,
    pool: { ...config.pool, max: 1 },
    requestTimeout: timeoutSeconds * 1000,
  });
  try {
    await pool.connect();
  } catch (err) {
    try { await pool.close(); } catch { /* ignore */ }
    throw mapConnectError(err, String(config.server ?? ''), String(config.database ?? ''));
  }
  pool.on('error', () => { /* connection-level failures surface via the active request; avoid uncaught exception */ });
  return new MssqlRunner(pool);
}

class MssqlRunner implements QueryRunner {
  constructor(private readonly pool: sql.ConnectionPool) {}

  async query<T = Record<string, unknown>>(text: string, signal?: AbortSignal): Promise<T[]> {
    if (signal?.aborted) throw new CompareCancelledError('Compare cancelled');
    const request = this.pool.request();
    const onAbort = () => request.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await request.query(text);
      return result.recordset as unknown as T[];
    } catch (err) {
      if (signal?.aborted) throw new CompareCancelledError('Compare cancelled');
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  stream<T = Record<string, unknown>>(text: string, signal?: AbortSignal): AsyncIterable<T> {
    const pool = this.pool;
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        const queue: T[] = [];
        let done = false;
        let error: unknown;
        let paused = false;
        let started = false;
        let finished = false; // consumer finished (break/return)
        let wake: (() => void) | undefined;
        const request = pool.request();
        request.stream = true;

        const notify = () => { const w = wake; wake = undefined; w?.(); };
        const cancel = () => { try { request.cancel(); } catch { /* ignore */ } };
        const onAbort = () => { cancel(); notify(); };

        const cleanup = () => signal?.removeEventListener('abort', onAbort);

        const start = () => {
          started = true;
          signal?.addEventListener('abort', onAbort, { once: true });
          request.on('row', (row: T) => {
            if (finished) return;
            queue.push(row);
            if (queue.length >= HIGH_WATER && !paused) { paused = true; request.pause(); }
            notify();
          });
          request.on('error', (err: unknown) => { error = err; done = true; notify(); });
          request.on('done', () => { done = true; notify(); });
          const p = request.query(text) as unknown as Promise<unknown> | undefined;
          if (p && typeof p.catch === 'function') p.catch(() => {});
        };

        const finish = () => {
          if (finished) return;
          finished = true;
          queue.length = 0;
          cleanup();
          if (started && !done) {
            cancel();
            done = true;
            if (paused) { paused = false; request.resume(); }
          }
        };

        return {
          async next(): Promise<IteratorResult<T>> {
            if (signal?.aborted) { finish(); throw new CompareCancelledError('Compare cancelled'); }
            if (!started) start();
            for (;;) {
              if (signal?.aborted) { finish(); throw new CompareCancelledError('Compare cancelled'); }
              if (queue.length > 0) {
                const row = queue.shift() as T;
                if (paused && queue.length < HIGH_WATER / 2) { paused = false; request.resume(); }
                return { value: row, done: false };
              }
              if (done) {
                finish();
                if (error) throw error;
                return { value: undefined, done: true };
              }
              await new Promise<void>((resolve) => { wake = resolve; });
            }
          },
          async return(): Promise<IteratorResult<T>> {
            if (started && !done && !finished) {
              // wait for cancellation to settle so the connection is reusable
              const settled = new Promise<void>((resolve) => {
                request.once('error', () => resolve());
                request.once('done', () => resolve());
              });
              if (paused) { paused = false; request.resume(); }
              finish();
              done = false;
              let timer: NodeJS.Timeout | undefined;
              const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, 30000); });
              await Promise.race([settled, timeout]);
              if (timer) clearTimeout(timer);
              done = true;
            } else {
              finish();
            }
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}
