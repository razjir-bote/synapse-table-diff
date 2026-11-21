import { describe, it, expect } from 'vitest';
import { mapConnectError } from '../../src/db/errors';
import { PausedPoolError, PoolUnavailableError } from '../../src/core/errors';

describe('mapConnectError', () => {
  it('maps 42108 to PausedPoolError', () => {
    const e = mapConnectError({ number: 42108 }, 'srv', 'db');
    expect(e).toBeInstanceOf(PausedPoolError);
    expect(e.message).toBe('Pool "db" on srv is paused. Resume it in the Azure portal and try again.');
  });
  it('maps 42109 (nested tedious number) to PoolUnavailableError', () => {
    const e = mapConnectError({ originalError: { info: { number: 42109 } } }, 'srv', 'db');
    expect(e).toBeInstanceOf(PoolUnavailableError);
    expect(e.message).toBe('Pool "db" is resuming; try again in a minute.');
  });
  it('maps 40613', () => {
    const e = mapConnectError({ number: 40613 }, 'srv', 'db');
    expect(e).toBeInstanceOf(PoolUnavailableError);
    expect(e.message).toBe('db on srv is not currently available.');
  });
  it('passes through anything else', () => {
    const orig = new Error('x');
    expect(mapConnectError(orig, 's', 'd')).toBe(orig);
  });
});
