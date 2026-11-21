import { describe, it, expect } from 'vitest';
import { buildDiffRow, formatValue } from '../../src/core/cellDiff';

describe('formatValue', () => {
  it('formats types', () => {
    expect(formatValue(null)).toBeNull();
    expect(formatValue(undefined)).toBeNull();
    expect(formatValue(Buffer.from([0xab, 1]))).toBe('0xAB01');
    expect(formatValue(new Date('2020-01-02T03:04:05.000Z'))).toBe('2020-01-02T03:04:05.000Z');
    expect(formatValue(12n)).toBe('12');
    expect(formatValue(1.5)).toBe('1.5');
    expect(formatValue(true)).toBe('1');
    expect(formatValue(false)).toBe('0');
    expect(formatValue('x')).toBe('x');
  });
});

describe('buildDiffRow', () => {
  it('lists changed columns by normalized value', () => {
    const l = { k_0: 1, v_0: 'a', n_0: 'a', v_1: 'x', n_1: 'x' };
    const r = { k_0: 1, v_0: 'A', n_0: 'a', v_1: 'y', n_1: 'y' };
    const d = buildDiffRow('changed', 1, ['c1', 'c2'], l, r);
    expect(d.changedColumns).toEqual(['c2']);
    expect(d.key).toEqual(['1']);
    expect(d.left).toEqual(['a', 'x']);
    expect(d.right).toEqual(['A', 'y']);
  });
  it('added row has right only', () => {
    const d = buildDiffRow('added', 1, ['c'], undefined, { k_0: 'K', v_0: 5, n_0: '5' });
    expect(d.left).toBeUndefined();
    expect(d.right).toEqual(['5']);
    expect(d.key).toEqual(['K']);
    expect(d.changedColumns).toEqual([]);
  });
  it('NULL vs empty string is detected', () => {
    const d = buildDiffRow('changed', 1, ['c'], { k_0: 1, v_0: null, n_0: null }, { k_0: 1, v_0: '', n_0: '' });
    expect(d.changedColumns).toEqual(['c']);
    expect(d.left).toEqual([null]);
    expect(d.right).toEqual(['']);
  });
});
