import type { AggregateRow, ChangeKind } from '../../src/core/types';
import type { HostToResults, ResultsToHost } from '../../src/ui/protocol';
import { renderAggregateSummary, renderKeyProblems, renderSchemaTab, renderSummary } from './render';
import { buildAggregateRow, VirtualGrid } from './virtualGrid';

declare function acquireVsCodeApi(): { postMessage(m: ResultsToHost): void };
const vscode = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLElement;
const post = (m: ResultsToHost) => vscode.postMessage(m);

type Filter = ChangeKind | 'all';
let grid: VirtualGrid | undefined;
let aggGrid: VirtualGrid<AggregateRow> | undefined;
let filter: Filter = 'all';
let totals: Record<Filter, number> = { all: 0, added: 0, removed: 0, changed: 0 };

function div(cls: string): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function build(m: Extract<HostToResults, { type: 'summary' }>): void {
  root.textContent = '';
  totals = m.totalByKind;
  filter = 'all';
  aggGrid = undefined;
  const s = m.summary;
  const summary = div('summary');
  renderSummary(summary, s);
  root.appendChild(summary);

  const tabs = div('tabs');
  const panes: Record<string, HTMLElement> = { schema: div('pane'), data: div('pane'), keys: div('pane') };
  const names: [string, string][] = [['schema', 'Schema'], ['data', 'Data'], ['keys', 'Key problems']];
  const tabButtons: Record<string, HTMLButtonElement> = {};
  const select = (id: string) => {
    for (const [k, p] of Object.entries(panes)) {
      p.hidden = k !== id;
      tabButtons[k].classList.toggle('active', k === id);
    }
    if (id === 'data') grid?.refresh();
  };
  for (const [id, label] of names) {
    const b = button(label, () => select(id));
    b.className = 'tab';
    tabButtons[id] = b;
    tabs.appendChild(b);
  }
  root.append(tabs, panes.schema, panes.data, panes.keys);

  renderSchemaTab(panes.schema, s.schema, s.plan.excluded);
  renderKeyProblems(panes.keys, s.keyProblems);

  const toolbar = div('toolbar');
  const sel = document.createElement('select');
  const opts: [Filter, string][] = [['all', 'All'], ['changed', 'Changed'], ['added', 'Added'], ['removed', 'Removed']];
  for (const [v, label] of opts) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = `${label} (${totals[v].toLocaleString('en-US')})`;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    filter = sel.value as Filter;
    grid?.reset(totals[filter]);
  });
  toolbar.append(sel, button('Open in diff editor', () => post({ type: 'openDiff' })), button('Export CSV', () => post({ type: 'exportCsv' })));
  const gridRoot = div('grid');
  panes.data.append(toolbar, gridRoot);

  const columns = [...s.plan.keys.map((k) => k.name), ...s.plan.compared.map((c) => c.name)];
  grid = new VirtualGrid(gridRoot, columns, 24, (offset, limit) => post({ type: 'page', kind: filter, offset, limit }));
  select('data');
  grid.setTotal(totals.all);
}

function buildAggregate(m: Extract<HostToResults, { type: 'aggregateSummary' }>): void {
  root.textContent = '';
  totals = m.totalByKind;
  filter = 'all';
  grid = undefined;
  const s = m.summary;
  const summary = div('summary');
  renderAggregateSummary(summary, s);
  root.appendChild(summary);

  const tabs = div('tabs');
  const dataTab = button('Data', () => aggGrid?.refresh());
  dataTab.className = 'tab active';
  tabs.appendChild(dataTab);
  const pane = div('pane');
  root.append(tabs, pane);

  const toolbar = div('toolbar');
  const sel = document.createElement('select');
  const opts: [Filter, string][] = [['all', 'All'], ['changed', 'Differs'], ['added', 'Only on right'], ['removed', 'Only on left']];
  for (const [v, label] of opts) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = `${label} (${totals[v].toLocaleString('en-US')})`;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    filter = sel.value as Filter;
    aggGrid?.reset(totals[filter]);
  });
  toolbar.append(sel, button('Export CSV', () => post({ type: 'exportCsv' })));
  const gridRoot = div('grid');
  pane.append(toolbar, gridRoot);

  const groupCount = s.plan.groups.length;
  const columns = [...s.plan.groups.map((g) => g.label), ...s.plan.targets.flatMap((t) => [`${t.label} L`, `${t.label} R`, `${t.label} Δ`])];
  aggGrid = new VirtualGrid<AggregateRow>(gridRoot, columns, 24, (offset, limit) => post({ type: 'page', kind: filter, offset, limit }), {}, (r) => buildAggregateRow(r, groupCount));
  aggGrid.setTotal(totals.all);
}

window.addEventListener('message', (e: MessageEvent<HostToResults>) => {
  const m = e.data;
  if (m.type === 'summary') build(m);
  else if (m.type === 'rows' && m.kind === filter) grid?.setRows(m.offset, m.rows);
  else if (m.type === 'aggregateSummary') buildAggregate(m);
  else if (m.type === 'aggregateRows' && m.kind === filter) aggGrid?.setRows(m.offset, m.rows);
});
post({ type: 'ready' });
