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
  it('starts both sides together: the left source can wait for the right one to be pulled', async () => {
    let rightPulled!: () => void;
    const rightStarted = new Promise<void>((res) => { rightPulled = res; });
    async function* left(): AsyncGenerator<PairRow> {
      await rightStarted; // a serial start would deadlock here
      yield p(1, 1);
    }
    async function* right(): AsyncGenerator<PairRow> {
      rightPulled();
      yield p(1, 2);
    }
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('serial start')), 1000));
    const r = await Promise.race([mergePairs(left(), right(), 10), timeout]);
    expect(r.changed).toBe(1);
  });
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
  it('right-side dup excludes the kh; left run 1 vs right run 2', async () => {
    const r = await mergePairs(gen([p(1, 1), p(2, 1)]), gen([p(1, 1), p(1, 2), p(3, 1)]), 100);
    expect([r.added, r.removed, r.changed]).toEqual([1, 1, 0]);
    expect(r.duplicateSamples).toEqual([{ side: 'right', key: ['1'], count: 2 }]);
    expect(r.selected.map((s) => s.khHex)).toEqual(['000002', '000003']);
  });
  it('dup run with no counterpart is sampled and not counted', async () => {
    const r = await mergePairs(gen([p(1, 1), p(1, 2), p(1, 3), p(1, 4)]), gen([]), 100);
    expect([r.added, r.removed, r.changed]).toEqual([0, 0, 0]);
    expect(r.duplicateSamples).toEqual([{ side: 'left', key: ['1'], count: 4 }]);
    const r2 = await mergePairs(gen([]), gen([p(5, 1), p(5, 1)]), 100);
    expect([r2.added, r2.removed]).toEqual([0, 0]);
    expect(r2.duplicateSamples).toEqual([{ side: 'right', key: ['5'], count: 2 }]);
  });
  it('knull row mixed into a run with a real row of the same kh is not a duplicate', async () => {
    const nk = p(1, 7, { knull: 1, b2: -1, keys: [null] });
    const r = await mergePairs(gen([nk, p(1, 1)]), gen([p(1, 2)]), 100);
    expect(r.changed).toBe(1);
    expect(r.duplicateSamples).toEqual([]);
    expect(r.nullKeySamples).toEqual([{ side: 'left', key: [null] }]);
  });
  it('caps samples at 100 per side for dups and null keys', async () => {
    const L: PairRow[] = [];
    const R: PairRow[] = [];
    for (let i = 1; i <= 120; i++) {
      L.push(p(i, 1), p(i, 2));
      R.push(p(i, 1), p(i, 2));
    }
    const nk = (n: number) => Array.from({ length: n }, () => p(0, 1, { knull: 1, b2: -1, keys: [null] }));
    const r = await mergePairs(gen([...nk(150), ...L]), gen([...nk(110), ...R]), 100);
    expect(r.duplicateSamples.filter((s) => s.side === 'left')).toHaveLength(100);
    expect(r.duplicateSamples.filter((s) => s.side === 'right')).toHaveLength(100);
    expect(r.nullKeySamples.filter((s) => s.side === 'left')).toHaveLength(100);
    expect(r.nullKeySamples.filter((s) => s.side === 'right')).toHaveLength(100);
  });
  it('records b2 on selected entries', async () => {
    const r = await mergePairs(gen([p(1, 1, { b2: 11 })]), gen([p(1, 2, { b2: 11 }), p(2, 1, { b2: 22 })]), 100);
    expect(r.selected).toEqual([
      { kind: 'changed', khHex: '000001', b2: 11 },
      { kind: 'added', khHex: '000002', b2: 22 },
    ]);
  });
  it('aborts mid-stream via the 10,000-row check', async () => {
    const ac = new AbortController();
    async function* big(): AsyncGenerator<PairRow> {
      for (let i = 0; i < 30_000; i++) {
        if (i === 100) ac.abort();
        yield { kh: Buffer.from([0, (i >> 8) & 255, i & 255]), rh: Buffer.from([1]), knull: 0, b2: 0, keys: [i] };
      }
    }
    await expect(mergePairs(big(), gen([]), 10, ac.signal)).rejects.toBeInstanceOf(CompareCancelledError);
  });
  it('throws CompareCancelledError when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(mergePairs(gen([p(1, 1)]), gen([]), 10, ac.signal)).rejects.toBeInstanceOf(CompareCancelledError);
  });
});

describe('mergePairs progress', () => {
  it('reports running counts every 50,000 rows read', async () => {
    const mk = (i: number, rh: number): PairRow => {
      const kh = Buffer.alloc(32);
      kh.writeUInt32BE(i, 0);
      const h = Buffer.alloc(32);
      h.writeUInt32BE(rh, 0);
      return { kh, rh: h, knull: 0, b2: 0, keys: [i] };
    };
    const left = Array.from({ length: 30_000 }, (_, i) => mk(i, i % 1000 === 0 ? 1 : 0));
    const right = Array.from({ length: 30_000 }, (_, i) => mk(i, 0));
    const seen: { rowsRead: number; changed: number }[] = [];
    const res = await mergePairs(gen(left), gen(right), 10, undefined, (p) => seen.push({ rowsRead: p.rowsRead, changed: p.changed }));
    expect(res.changed).toBe(30);
    expect(seen.map((s) => s.rowsRead)).toEqual([50_000]);
    expect(seen[0].changed).toBeGreaterThan(0);
    expect(seen[0].changed).toBeLessThanOrEqual(30);
  });
});
