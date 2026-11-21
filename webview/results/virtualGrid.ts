import type { DiffRow } from '../../src/core/types';

export const PAGE_SIZE = 200;
export const OVERSCAN = 20;
const KIND_SYMBOL: Record<DiffRow['kind'], string> = { added: '+', removed: '−', changed: '~' };

export interface GridMetrics {
  scrollTop?: () => number;
  clientHeight?: () => number;
}

function valueNode(v: string | null | undefined): Node {
  if (v === null || v === undefined) {
    const s = document.createElement('span');
    s.className = 'null';
    s.textContent = 'NULL';
    return s;
  }
  return document.createTextNode(v);
}

function cellText(v: string | null | undefined): string {
  return v === null || v === undefined ? 'NULL' : v;
}

/** Build one grid row element. `columns` = key column names followed by compared column names. */
export function buildRow(row: DiffRow, columns: string[]): HTMLElement {
  const el = document.createElement('div');
  el.className = `grid-row ${row.kind}`;
  const kind = document.createElement('div');
  kind.className = `cell cell-kind ${row.kind}`;
  kind.textContent = KIND_SYMBOL[row.kind];
  el.appendChild(kind);
  const keyCount = row.key.length;
  for (let i = 0; i < columns.length; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    if (i < keyCount) {
      cell.appendChild(valueNode(row.key[i]));
    } else {
      const j = i - keyCount;
      const name = columns[i];
      if (row.kind === 'changed' && row.changedColumns.includes(name)) {
        cell.classList.add('cell-changed');
        cell.appendChild(valueNode(row.left?.[j]));
        cell.appendChild(document.createTextNode(' → '));
        cell.appendChild(valueNode(row.right?.[j]));
        cell.title = `${cellText(row.left?.[j])} → ${cellText(row.right?.[j])}`;
      } else {
        const v = row.kind === 'added' ? row.right?.[j] : (row.left ?? row.right)?.[j];
        cell.appendChild(valueNode(v));
        cell.title = cellText(v);
      }
    }
    el.appendChild(cell);
  }
  return el;
}

export class VirtualGrid {
  private total = 0;
  private readonly rows = new Map<number, DiffRow>();
  private readonly loaded = new Set<number>();
  private readonly pending = new Set<number>();
  private readonly scroller: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly body: HTMLElement;
  private readonly template: string;

  constructor(
    root: HTMLElement,
    private readonly columns: string[],
    private readonly rowHeight: number,
    private readonly fetchPage: (offset: number, limit: number) => void,
    private readonly metrics: GridMetrics = {},
  ) {
    this.template = `grid-template-columns: 2.5em repeat(${columns.length}, minmax(120px, 1fr))`;
    root.textContent = '';
    this.scroller = document.createElement('div');
    this.scroller.className = 'grid-scroller';
    const header = document.createElement('div');
    header.className = 'grid-header';
    header.setAttribute('style', this.template);
    for (const name of ['', ...columns]) {
      const h = document.createElement('div');
      h.className = 'cell';
      h.textContent = name;
      header.appendChild(h);
    }
    this.spacer = document.createElement('div');
    this.spacer.className = 'grid-spacer';
    this.spacer.style.minWidth = `${40 + columns.length * 120}px`;
    this.body = document.createElement('div');
    this.body.className = 'grid-body';
    this.spacer.appendChild(this.body);
    this.scroller.append(header, this.spacer);
    root.appendChild(this.scroller);
    this.scroller.addEventListener('scroll', () => this.refresh());
  }

  setTotal(n: number): void {
    this.total = n;
    this.spacer.style.height = `${n * this.rowHeight}px`;
    this.refresh();
  }

  /** Discard cached rows (e.g. filter changed) and start over with a new total. */
  reset(total: number): void {
    this.rows.clear();
    this.loaded.clear();
    this.pending.clear();
    this.scroller.scrollTop = 0;
    this.setTotal(total);
  }

  setRows(offset: number, rows: DiffRow[]): void {
    rows.forEach((r, i) => this.rows.set(offset + i, r));
    const page = Math.floor(offset / PAGE_SIZE);
    this.pending.delete(page);
    this.loaded.add(page);
    this.render();
  }

  visibleRange(): { start: number; end: number } {
    const top = this.metrics.scrollTop ? this.metrics.scrollTop() : this.scroller.scrollTop;
    const h = this.metrics.clientHeight ? this.metrics.clientHeight() : this.scroller.clientHeight;
    const start = Math.max(0, Math.floor(top / this.rowHeight) - OVERSCAN);
    const end = Math.min(this.total, Math.ceil((top + h) / this.rowHeight) + OVERSCAN);
    return { start, end: Math.max(start, end) };
  }

  refresh(): void {
    const { start, end } = this.visibleRange();
    if (end > start) {
      for (let p = Math.floor(start / PAGE_SIZE); p <= Math.floor((end - 1) / PAGE_SIZE); p++) {
        if (this.loaded.has(p) || this.pending.has(p)) continue;
        this.pending.add(p);
        this.fetchPage(p * PAGE_SIZE, PAGE_SIZE);
      }
    }
    this.render();
  }

  private render(): void {
    const { start, end } = this.visibleRange();
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const row = this.rows.get(i);
      let el: HTMLElement;
      if (row) {
        el = buildRow(row, this.columns);
      } else {
        el = document.createElement('div');
        el.className = 'grid-row placeholder';
      }
      el.setAttribute('style', `${this.template}; top: ${i * this.rowHeight}px; height: ${this.rowHeight}px`);
      frag.appendChild(el);
    }
    this.body.replaceChildren(frag);
  }
}
