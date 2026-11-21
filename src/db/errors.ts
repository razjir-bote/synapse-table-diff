import { PausedPoolError, PoolUnavailableError } from '../core/errors';

function errorNumber(err: unknown): number | undefined {
  const e = err as { number?: unknown; originalError?: { info?: { number?: unknown } } } | null;
  const n = e?.number ?? e?.originalError?.info?.number;
  return typeof n === 'number' ? n : undefined;
}

export function mapConnectError(err: unknown, server: string, database: string): Error {
  switch (errorNumber(err)) {
    case 42108:
      return new PausedPoolError(server, database);
    case 42109:
      return new PoolUnavailableError(`Pool "${database}" is resuming; try again in a minute.`);
    case 40613:
      return new PoolUnavailableError(`${database} on ${server} is not currently available.`);
    default:
      return err as Error;
  }
}
