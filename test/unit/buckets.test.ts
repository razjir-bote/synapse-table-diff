import { describe, it, expect } from 'vitest';
import { compareBuckets } from '../../src/core/buckets';
import type { BucketRow } from '../../src/core/types';

const row = (b: number, cnt: number, dk = cnt, s1 = '1', s2 = '2'): BucketRow => ({ b, cnt: BigInt(cnt), dk: BigInt(dk), s1, s2 });

describe('compareBuckets', () => {
  it('one-sided bucket is mismatched; equal buckets are not', () => {
    const r = compareBuckets([row(1, 2), row(2, 3)], [row(2, 3), row(5, 1)]);
    expect(r.mismatched).toEqual([1, 5]);
    expect(r.problem).toEqual([]);
    expect(r.rowsInScope).toBe(3);
    expect(r.leftRows).toBe(5);
    expect(r.rightRows).toBe(4);
  });
  it('differing checksum is mismatched', () => {
    expect(compareBuckets([row(1, 2, 2, '5')], [row(1, 2, 2, '6')]).mismatched).toEqual([1]);
  });
  it('cnt != dk is a problem even if equal, and is not also mismatched', () => {
    const r = compareBuckets([row(3, 4, 3)], [row(3, 4, 3)]);
    expect(r.problem).toEqual([3]);
    expect(r.mismatched).toEqual([]);
    expect(r.leftDupRows).toBe(1);
    expect(r.rightDupRows).toBe(1);
    expect(r.rowsInScope).toBe(8);
  });
  it('dup on one side only: problem, tallied on that side', () => {
    const r = compareBuckets([row(4, 5, 3)], [row(4, 3, 3)]);
    expect(r.problem).toEqual([4]);
    expect(r.mismatched).toEqual([]);
    expect(r.leftDupRows).toBe(2);
    expect(r.rightDupRows).toBe(0);
    expect(r.rowsInScope).toBe(8);
  });
  it('handles large bigint cnt/dk exactly in comparison', () => {
    const big = 2n ** 40n;
    const a: BucketRow = { b: 1, cnt: big, dk: big, s1: '10', s2: '20' };
    const r = compareBuckets([a], [{ ...a }]);
    expect(r.mismatched).toEqual([]);
    expect(r.problem).toEqual([]);
    const r2 = compareBuckets([a], [{ ...a, cnt: big + 1n, dk: big + 1n }]);
    expect(r2.mismatched).toEqual([1]);
    expect(r2.leftRows).toBe(Number(big));
    expect(r2.rowsInScope).toBe(Number(big) * 2 + 1);
  });
  it('b=-1 is a problem; null-key rows counted', () => {
    const r = compareBuckets([row(-1, 2, 1)], [row(-1, 5, 1), row(0, 1)]);
    expect(r.problem).toEqual([-1]);
    expect(r.leftNullKeyRows).toBe(2);
    expect(r.rightNullKeyRows).toBe(5);
    expect(r.mismatched).toEqual([0]);
  });
});
