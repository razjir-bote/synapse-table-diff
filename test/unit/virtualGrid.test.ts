// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { VirtualGrid } from '../../webview/results/virtualGrid';
import type { DiffRow } from '../../src/core/types';

const mk = (i: number): DiffRow => ({ kind: 'changed', key: [String(i)], left: ['open'], right: ['closed'], changedColumns: ['Status'] });
const rowsFrom = (offset: number, n: number) => Array.from({ length: n }, (_, i) => mk(offset + i));

function setup(scrollTop = 0, clientHeight = 600) {
  const root = document.createElement('div');
  const fetchPage = vi.fn();
  const grid = new VirtualGrid(root, ['Id', 'Status'], 24, fetchPage, { scrollTop: () => scrollTop, clientHeight: () => clientHeight });
  const setScroll = (t: number) => { scrollTop = t; };
  return { root, fetchPage, grid, setScroll };
}

describe('VirtualGrid', () => {
  it('computes visibleRange with 20-row overscan', () => {
    const { grid, setScroll } = setup(0);
    grid.setTotal(1000);
    expect(grid.visibleRange()).toEqual({ start: 0, end: 45 }); // 600/24=25 visible + 20
    setScroll(24 * 180);
    expect(grid.visibleRange()).toEqual({ start: 160, end: 225 });
  });
  it('clamps the range to the total', () => {
    const { grid } = setup(0);
    grid.setTotal(10);
    expect(grid.visibleRange()).toEqual({ start: 0, end: 10 });
  });
  it('requests page offset 200 after scrolling past row 180', () => {
    const { grid, fetchPage, setScroll } = setup(0);
    grid.setTotal(1000);
    grid.setRows(0, rowsFrom(0, 200));
    fetchPage.mockClear();
    setScroll(24 * 181);
    grid.refresh();
    expect(fetchPage).toHaveBeenCalledWith(200, 200);
    expect(fetchPage).not.toHaveBeenCalledWith(0, 200);
  });
  it('does not re-request a page already pending or loaded', () => {
    const { grid, fetchPage } = setup(0);
    grid.setTotal(1000);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    grid.refresh();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
  it('renders only the visible rows, with spacer for full height', () => {
    const { root, grid } = setup(0);
    grid.setTotal(1000);
    grid.setRows(0, rowsFrom(0, 200));
    expect(root.querySelectorAll('.grid-row').length).toBe(45);
    expect((root.querySelector('.grid-spacer') as HTMLElement).style.height).toBe('24000px');
  });
  it('renders changed cells as left → right and NULL in italics', () => {
    const { root, grid } = setup(0);
    grid.setTotal(2);
    grid.setRows(0, [mk(1), { kind: 'removed', key: ['2'], left: [null], changedColumns: [] }]);
    const changed = root.querySelector('.cell-changed') as HTMLElement;
    expect(changed.textContent).toBe('open → closed');
    expect(root.querySelector('.null')?.textContent).toBe('NULL');
    expect(root.querySelector('.grid-row.removed')).not.toBeNull();
  });
  it('re-requests the first page after reset', () => {
    const { grid, fetchPage } = setup(0);
    grid.setTotal(1000);
    grid.setRows(0, rowsFrom(0, 200));
    grid.reset(500);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
  it('never sets a style attribute (CSP blocks inline style attributes)', () => {
    const spy = vi.spyOn(Element.prototype, 'setAttribute');
    const { root, grid } = setup(0);
    grid.setTotal(100);
    grid.setRows(0, rowsFrom(0, 100));
    expect(spy.mock.calls.some(([n]) => String(n).toLowerCase() === 'style')).toBe(false);
    const row = root.querySelector('.grid-row') as HTMLElement;
    expect(row.style.height).toBe('24px');
    expect(row.style.gridTemplateColumns).not.toBe('');
    spy.mockRestore();
  });
});
