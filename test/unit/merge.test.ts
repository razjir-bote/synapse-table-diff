import { describe, it, expect } from 'vitest';
import { mergePairs } from '../../src/core/merge';
import { CompareCancelledError } from '../../src/core/errors';
import type { PairRow } from '../../src/core/types';

const kh = (n: number) => Buffer.from([0, 0, n]);
const p = (k: number, rh: number, extra: Partial<PairRow> = {}): PairRow => ({
  kh: kh(k), rh: Buffer.from([rh]), knull: 0, b2: 0, keys: [k], ...extra,
});
async function* gen(rows: PairRow[]): AsyncGenerator<PairRow> { for (const r of rows) yield r; }

describe('mergePairs', () => {
  it('exact counts on interleaved input', async () => {
    const L = [p(1, 1), p(2, 1), p(4, 1), p(6, 1)];
    const R = [p(2, 1), p(3, 1), p(4, 9), p(7, 1)];
    const r = await mergePairs(gen(L), gen(R), 100);
    expect(r.removed).toBe(2);
    expect(r.added).toBe(2);
    expect(r.changed).toBe(1);
    expect(r.selected.map((s) => [s.kind, s.khHex])).toEqual([
      ['removed', '000001'], ['added', '000003'], ['changed', '000004'], ['removed', '000006'], ['added', '000007'],
    ]);
  });
  it('duplicates on one side are excluded from both sides and sampled', async () => {
    const L = [p(1, 1), p(1, 2), p(2, 1)];
    const R = [p(1, 1), p(2, 1)];
    const r = await mergePairs(gen(L), gen(R), 100);
    expect([r.added, r.removed, r.changed]).toEqual([0, 0, 0]);
    expect(r.duplicateSamples).toEqual([{ side: 'left', key: ['1'], count: 2 }]);
  });
  it('null-key rows are excluded and sampled', async () => {
    const nk = (rh: number) => p(0, rh, { knull: 1, b2: -1, keys: [null] });
    const r = await mergePairs(gen([nk(1), nk(2), p(1, 1)]), gen([nk(3), p(1, 1)]), 100);
    expect([r.added, r.removed, r.changed]).toEqual([0, 0, 0]);
    expect(r.nullKeySamples.filter((s) => s.side === 'left')).toHaveLength(2);
    expect(r.nullKeySamples.filter((s) => s.side === 'right')).toEqual([{ side: 'right', key: [null] }]);
  });
  it('caps selected but keeps counting', async () => {
    const R = Array.from({ length: 10 }, (_, i) => p(i + 1, 1));
    const r = await mergePairs(gen([]), gen(R), 3);
    expect(r.added).toBe(10);
    expect(r.selected).toHaveLength(3);
  });
  it('empty sides', async () => {
    expect((await mergePairs(gen([]), gen([p(1, 1), p(2, 1), p(3, 1)]), 10)).added).toBe(3);
    const z = await mergePairs(gen([]), gen([]), 10);
    expect([z.added, z.removed, z.changed, z.selected.length]).toEqual([0, 0, 0, 0]);
  });
  it('throws CompareCancelledError when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(mergePairs(gen([p(1, 1)]), gen([]), 10, ac.signal)).rejects.toBeInstanceOf(CompareCancelledError);
  });
});
