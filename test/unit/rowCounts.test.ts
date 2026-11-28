import { describe, expect, it } from 'vitest';
import { CompareCancelledError } from '../../src/core/errors';
import { countMatchedTables, matchedPairs, rowCountFindings, type TablePair } from '../../src/schemaCompare/rowCounts';
import type { SchemaObject } from '../../src/schemaCompare/report';

const obj = (name: string): SchemaObject => ({ name, kind: 'table', columns: [] });
const tick = () => new Promise((r) => setTimeout(r, 1));

describe('matchedPairs', () => {
  it('keeps each side\'s spelling', () => {
    expect(matchedPairs([obj('t2'), obj('T1'), obj('v1')], [obj('t1'), obj('v1'), obj('t3')])).toEqual([
      { left: 'T1', right: 't1' }, { left: 'v1', right: 'v1' },
    ]);
  });
});

describe('countMatchedTables', () => {
  const mk = (n: number): TablePair[] => Array.from({ length: n }, (_, i) => ({ left: `t${i}`, right: `t${i}` }));

  it('limits concurrency to 4 and keeps order', async () => {
    let inFlight = 0; let max = 0;
    const pending = new Map<string, number>();
    const count = async (side: 'left' | 'right', name: string) => {
      if (side === 'left') { inFlight++; max = Math.max(max, inFlight); }
      await tick();
      pending.set(name, (pending.get(name) ?? 0) + 1);
      if (pending.get(name) === 2) inFlight--;
      return side === 'left' ? 1 : 2;
    };
    const pairs = mk(10);
    const res = await countMatchedTables(pairs, count, { limit: 4 });
    expect(max).toBeLessThanOrEqual(4);
    expect(res.map((r) => r.table)).toEqual(pairs.map((p) => p.left));
    expect(res[0]).toEqual({ table: 't0', left: 1n, right: 2n });
  });

  it('records a side\'s failure', async () => {
    const count = async (side: 'left' | 'right') => {
      if (side === 'right') throw new Error('files missing');
      return 5;
    };
    const res = await countMatchedTables([{ left: 'x', right: 'x' }], count, { limit: 4 });
    expect(res).toEqual([{ table: 'x', left: 5n, right: new Error('files missing') }]);
  });

  it('treats an unconvertible value as an error', async () => {
    const res = await countMatchedTables([{ left: 'x', right: 'x' }], async (s) => (s === 'left' ? '12' : 'abc'), { limit: 1 });
    expect(res[0].left).toBe(12n);
    expect(res[0].right).toBeInstanceOf(Error);
  });

  it('stops on abort', async () => {
    const ac = new AbortController();
    const called = new Set<string>();
    const count = async (_s: 'left' | 'right', name: string) => { called.add(name); await tick(); return 1; };
    const p = countMatchedTables(mk(10), count, { limit: 4, signal: ac.signal, onStart: () => ac.abort() });
    await expect(p).rejects.toBeInstanceOf(CompareCancelledError);
    expect(called.size).toBeLessThanOrEqual(4);
  });
});

describe('rowCountFindings', () => {
  const one = (left: bigint | Error, right: bigint | Error) => rowCountFindings([{ table: 't', left, right }]);
  it('fewer on the right', () => {
    expect(one(1204331n, 1204300n)).toEqual([{
      issue: 'row_count_mismatch', table: 't', column: '', leftType: '', rightType: '',
      details: 'left 1,204,331 rows, right 1,204,300 rows (31 fewer on the right)',
    }]);
  });
  it('singular', () => expect(one(1n, 0n)[0].details).toBe('left 1 row, right 0 rows (1 fewer on the right)'));
  it('more on the right', () => expect(one(2n, 5n)[0].details).toBe('left 2 rows, right 5 rows (3 more on the right)'));
  it('equal emits nothing', () => expect(one(3n, 3n)).toEqual([]));
  it('compares as BigInt', () => expect(one(BigInt('9007199254740993'), BigInt('9007199254740992'))).toHaveLength(1));
  it('both sides error: one finding', () => {
    const f = one(new Error('a'), new Error('b'));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ issue: 'row_count_error', details: 'left: a; right: b' });
  });
  it('one side error', () => expect(one(1n, new Error('b'))[0].details).toBe('right: b'));
});
