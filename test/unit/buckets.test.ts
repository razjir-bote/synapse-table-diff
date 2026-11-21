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
  it('b=-1 is a problem; null-key rows counted', () => {
    const r = compareBuckets([row(-1, 2, 1)], [row(-1, 5, 1), row(0, 1)]);
    expect(r.problem).toEqual([-1]);
    expect(r.leftNullKeyRows).toBe(2);
    expect(r.rightNullKeyRows).toBe(5);
    expect(r.mismatched).toEqual([0]);
  });
});
