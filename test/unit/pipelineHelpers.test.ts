import { describe, it, expect } from 'vitest';
import { browsableKeys, estimatedLevel2Ids, rebucketCanFit } from '../../src/core/pipeline';
import type { DiffKey } from '../../src/core/types';

const range = (n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i);

describe('estimatedLevel2Ids', () => {
  it('is ~m for few buckets, grows faster near saturation, infinite when every bucket differs', () => {
    expect(estimatedLevel2Ids(0)).toBe(0);
    expect(estimatedLevel2Ids(1)).toBeCloseTo(1, 2);
    expect(estimatedLevel2Ids(60)).toBeGreaterThan(60);
    expect(estimatedLevel2Ids(60)).toBeLessThan(61);
    expect(estimatedLevel2Ids(2891)).toBeLessThanOrEqual(5000);
    expect(estimatedLevel2Ids(2892)).toBeGreaterThan(5000);
    expect(estimatedLevel2Ids(4096)).toBe(Infinity);
  });
});

describe('rebucketCanFit (cap 5000)', () => {
  it('fits just below the threshold and not just above', () => {
    expect(rebucketCanFit(range(2891), 5000)).toBe(true);
    expect(rebucketCanFit(range(2892), 5000)).toBe(false);
  });

  it('counts the -1 bucket', () => {
    expect(rebucketCanFit([-1, ...range(2890)], 5000)).toBe(true);
    expect(rebucketCanFit([-1, ...range(2891)], 5000)).toBe(false);
  });

  it('never re-buckets only the -1 bucket, and never when level-1 ids alone exceed the cap', () => {
    expect(rebucketCanFit([-1], 5000)).toBe(false);
    expect(rebucketCanFit([], 5000)).toBe(false);
    expect(rebucketCanFit(range(10), 10)).toBe(true);
    expect(rebucketCanFit([0], 1)).toBe(true);
    expect(rebucketCanFit(range(11), 10)).toBe(false);
    expect(rebucketCanFit([-1, 3], 2)).toBe(true);
    expect(rebucketCanFit([-1, 3, 4], 2)).toBe(false);
    expect(rebucketCanFit([3], 2)).toBe(true);
  });
});

describe('browsableKeys', () => {
  const key = (b2: number, i: number): DiffKey => ({ kind: 'changed', khHex: `${b2}-${i}`, b2 });

  it('keeps keys in the first cap distinct b2 values, in order', () => {
    const sel = [key(1, 0), key(1, 1), key(5, 0), key(9, 0), key(9, 1), key(12, 0)];
    expect(browsableKeys(sel, 2)).toEqual({ keys: sel.slice(0, 3), b2: [1, 5] });
    expect(browsableKeys(sel, 3)).toEqual({ keys: sel.slice(0, 5), b2: [1, 5, 9] });
    expect(browsableKeys(sel, 10)).toEqual({ keys: sel, b2: [1, 5, 9, 12] });
    expect(browsableKeys([], 3)).toEqual({ keys: [], b2: [] });
  });
});
