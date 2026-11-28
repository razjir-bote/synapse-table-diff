import type { AggregateResult, ColumnInfo, CompareResult, ExcludedColumn, KeyProblems, SchemaDiff } from '../../src/core/types';

type Summary = Omit<CompareResult, 'rows'>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export const fmt = (n: number): string => n.toLocaleString('en-US');

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function renderSummary(root: HTMLElement, s: Summary): void {
  root.textContent = '';
  root.appendChild(el('h1', undefined, `${s.request.left.schema}.${s.request.left.name} ↔ ${s.request.right.schema}.${s.request.right.name}`));
  const stats = el('div', 'stats');
  const stat = (label: string, value: string, cls = '') => {
    const d = el('div', `stat ${cls}`.trim());
    d.append(el('div', 'stat-value', value), el('div', 'stat-label', label));
    stats.appendChild(d);
  };
  stat('Left rows', fmt(s.leftRows));
  stat('Right rows', fmt(s.rightRows));
  stat('Changed', fmt(s.changed), 'changed');
  stat('Added', fmt(s.added), 'added');
  stat('Removed', fmt(s.removed), 'removed');
  stat('Schema differences', fmt(s.schema.differenceCount));
  stat('Duration', formatDuration(s.durationMs));
  root.appendChild(stats);
  root.appendChild(el('div', 'pools', `Pools: left ${s.poolTypes.left}, right ${s.poolTypes.right}`));
  for (const w of s.warnings) root.appendChild(el('div', 'warning', w));
}

const dash = '—';

/** Type with its length, precision or scale, e.g. varchar(50), nvarchar(max), decimal(12,4), datetime2(7). */
export function typeDesc(c: ColumnInfo): string {
  const len = (bytesPerChar: number) => (c.maxLength === -1 ? 'max' : String(c.maxLength / bytesPerChar));
  switch (c.type) {
    case 'char': case 'varchar': case 'binary': case 'varbinary':
      return `${c.type}(${len(1)})`;
    case 'nchar': case 'nvarchar':
      return `${c.type}(${len(2)})`;
    case 'decimal': case 'numeric':
      return `${c.type}(${c.precision},${c.scale})`;
    case 'datetime2': case 'time': case 'datetimeoffset':
      return `${c.type}(${c.scale})`;
    default:
      return c.type;
  }
}

function colDesc(c: ColumnInfo | undefined): string {
  if (!c) return dash;
  return `${typeDesc(c)} ${c.nullable ? 'NULL' : 'NOT NULL'}`;
}

function table(headers: string[]): { table: HTMLTableElement; body: HTMLTableSectionElement } {
  const t = el('table', 'schema-table');
  const hr = el('tr');
  for (const h of headers) hr.appendChild(el('th', undefined, h));
  t.appendChild(el('thead')).appendChild(hr);
  const body = el('tbody');
  t.appendChild(body);
  return { table: t, body };
}

export function renderSchemaTab(root: HTMLElement, s: SchemaDiff, excluded: ExcludedColumn[]): void {
  root.textContent = '';
  const { table: t, body } = table(['Column', 'Left', 'Right', 'Status']);
  for (const c of s.columns) {
    const tr = el('tr', c.status);
    tr.appendChild(el('td', undefined, c.name));
    tr.appendChild(el('td', undefined, colDesc(c.left)));
    tr.appendChild(el('td', undefined, colDesc(c.right)));
    tr.appendChild(el('td', undefined, c.status === 'changed' ? `changed (${c.changes.join(', ')})` : c.status));
    body.appendChild(tr);
  }
  root.appendChild(t);
  if (excluded.length > 0) {
    root.appendChild(el('h2', undefined, 'Excluded columns'));
    const ul = el('ul', 'excluded');
    for (const e of excluded) ul.appendChild(el('li', undefined, `${e.name} — ${e.reason}`));
    root.appendChild(ul);
  }
}

export function renderKeyProblems(root: HTMLElement, k: KeyProblems): void {
  root.textContent = '';
  const totals = el('div', 'totals');
  const total = (label: string, n: number) => {
    const d = el('div', 'total');
    d.append(el('span', 'total-value', fmt(n)), document.createTextNode(` ${label}`));
    totals.appendChild(d);
  };
  total('left duplicate-key rows', k.leftDupRows);
  total('right duplicate-key rows', k.rightDupRows);
  total('left NULL-key rows', k.leftNullKeyRows);
  total('right NULL-key rows', k.rightNullKeyRows);
  root.appendChild(totals);
  if (k.duplicateKeys.length === 0 && k.nullKeys.length === 0 && k.leftDupRows + k.rightDupRows + k.leftNullKeyRows + k.rightNullKeyRows === 0) {
    root.appendChild(el('p', 'hint', 'No key problems found.'));
  }
  const keyCell = (key: (string | null)[]): HTMLElement => {
    const td = el('td');
    key.forEach((v, i) => {
      if (i > 0) td.appendChild(document.createTextNode(', '));
      if (v === null) td.appendChild(el('span', 'null', 'NULL'));
      else td.appendChild(document.createTextNode(v));
    });
    return td;
  };
  if (k.duplicateKeys.length > 0) {
    root.appendChild(el('h2', undefined, 'Duplicate key samples'));
    const { table: t, body } = table(['Side', 'Key', 'Count']);
    for (const d of k.duplicateKeys) {
      const tr = el('tr');
      tr.append(el('td', undefined, d.side), keyCell(d.key), el('td', undefined, fmt(d.count)));
      body.appendChild(tr);
    }
    root.appendChild(t);
  }
  if (k.nullKeys.length > 0) {
    root.appendChild(el('h2', undefined, 'NULL key samples'));
    const { table: t, body } = table(['Side', 'Key']);
    for (const d of k.nullKeys) {
      const tr = el('tr');
      tr.append(el('td', undefined, d.side), keyCell(d.key));
      body.appendChild(tr);
    }
    root.appendChild(t);
  }
}

export function renderAggregateSummary(root: HTMLElement, s: Omit<AggregateResult, 'rows'>): void {
  root.textContent = '';
  const { left, right } = s.request;
  root.appendChild(el('h1', undefined, `Σ ${left.schema}.${left.name} ↔ ${right.schema}.${right.name}`));
  const stats = el('div', 'stats');
  const stat = (label: string, value: string, cls = '') => {
    const d = el('div', `stat ${cls}`.trim());
    d.append(el('div', 'stat-value', value), el('div', 'stat-label', label));
    stats.appendChild(d);
  };
  stat('Left groups', fmt(s.leftGroups));
  stat('Right groups', fmt(s.rightGroups));
  stat('Differ (changed)', fmt(s.changed), 'changed');
  stat('Only on left', fmt(s.removed), 'removed');
  stat('Only on right', fmt(s.added), 'added');
  stat('Matching', fmt(s.matching));
  stat('Duration', formatDuration(s.durationMs));
  root.appendChild(stats);
  root.appendChild(el('div', 'pools', `Pools: left ${s.poolTypes.left}, right ${s.poolTypes.right}`));
  for (const w of s.warnings) root.appendChild(el('div', 'warning', w));
}
