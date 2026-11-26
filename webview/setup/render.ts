import type { ColumnInfo, PoolType, Side } from '../../src/core/types';
import { filterProblem } from '../../src/sql/filterGuard';

export interface SideState {
  profileId?: string;
  database?: string;
  table?: { schema: string; name: string };
  databases: string[];
  objects: { schema: string; name: string; kind: string }[];
  columns: ColumnInfo[];
  declaredKey: string[];
  poolType?: PoolType;
}
export interface SetupState {
  profiles: { id: string; name: string }[];
  sides: Record<Side, SideState>;
  keyColumns: string[];
  excludedColumns: string[];
  filter: string;
  ignoreCase: boolean;
  ignoreTrailingSpaces: boolean;
  nullEqualsBlank: boolean;
  ignoreDataTypes: boolean;
  error?: string;
  /** Keys/exclusions from a pre-filled request, applied once both sides are described. */
  pendingInitial?: { keys: string[]; excluded: string[] };
}
export interface SetupActions {
  onProfile(side: Side, profileId: string): void;
  onDatabase(side: Side, database: string): void;
  onTable(side: Side, table: { schema: string; name: string } | undefined): void;
  onToggleKey(col: string, on: boolean): void;
  onToggleExclude(col: string, on: boolean): void;
  onFilter(text: string): void;
  onIgnoreCase(on: boolean): void;
  onIgnoreTrailing(on: boolean): void;
  onNullEqualsBlank(on: boolean): void;
  onIgnoreDataTypes(on: boolean): void;
  /** true: exclude every shared non-key column; false: exclude none. */
  onExcludeAll(on: boolean): void;
  onRun(): void;
}

/** The excluded list after "Exclude all" (every shared column except the keys) or "Include all" (none). */
export function excludeAllColumns(state: SetupState, on: boolean): string[] {
  if (!on) return [];
  const keys = new Set(state.keyColumns.map(lc));
  return sharedColumns(state).filter((c) => !keys.has(lc(c)));
}

export const SERVERLESS_NOTE =
  "This side is a serverless pool: a comparison scans its data about three times, and you're billed per data processed.";

const lc = (s: string) => s.toLowerCase();

/** Columns present on both sides (case-insensitive), named as on the left, in left order. */
export function sharedColumns(state: SetupState): string[] {
  const right = new Set(state.sides.right.columns.map((c) => lc(c.name)));
  return state.sides.left.columns.filter((c) => right.has(lc(c.name))).map((c) => c.name);
}

/** Left declared key if both sides are described and every declared column is shared; else []. */
export function defaultKey(state: SetupState): string[] {
  const { left, right } = state.sides;
  if (left.columns.length === 0 || right.columns.length === 0) return [];
  if (left.declaredKey.length === 0) return [];
  const shared = new Set(sharedColumns(state).map(lc));
  return left.declaredKey.every((k) => shared.has(lc(k))) ? [...left.declaredKey] : [];
}

export function canRun(state: SetupState): { ok: boolean; reason?: string } {
  for (const s of ['left', 'right'] as const) {
    const x = state.sides[s];
    if (!x.profileId || !x.database || !x.table || x.columns.length === 0) {
      return { ok: false, reason: `Choose a connection, database and table for the ${s} side.` };
    }
  }
  if (state.keyColumns.length === 0) return { ok: false, reason: 'Choose at least one key column.' };
  const ex = new Set(state.excludedColumns.map(lc));
  const clash = state.keyColumns.find((k) => ex.has(lc(k)));
  if (clash !== undefined) return { ok: false, reason: `Key column "${clash}" is also excluded.` };
  const filterIssue = filterProblem(state.filter);
  if (filterIssue) return { ok: false, reason: filterIssue };
  return { ok: true };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function option(value: string, label: string, selected: boolean): HTMLOptionElement {
  const o = el('option', undefined, label);
  o.value = value;
  o.selected = selected;
  return o;
}

function renderSide(side: Side, s: SideState, state: SetupState, a: SetupActions): HTMLElement {
  const box = el('fieldset', 'side');
  box.appendChild(el('legend', undefined, side === 'left' ? 'Left' : 'Right'));

  const prof = el('select');
  prof.dataset.role = `${side}-profile`;
  prof.appendChild(option('', '(choose connection)', !s.profileId));
  for (const p of state.profiles) prof.appendChild(option(p.id, p.name, p.id === s.profileId));
  prof.addEventListener('change', () => a.onProfile(side, prof.value));

  const db = el('select');
  db.dataset.role = `${side}-database`;
  db.appendChild(option('', '(choose database)', !s.database));
  const dbs = s.database && !s.databases.includes(s.database) ? [s.database, ...s.databases] : s.databases;
  for (const d of dbs) db.appendChild(option(d, d, d === s.database));
  db.addEventListener('change', () => a.onDatabase(side, db.value));

  const tbl = el('select');
  tbl.dataset.role = `${side}-table`;
  tbl.appendChild(option('', '(choose table or view)', !s.table));
  s.objects.forEach((o, i) => {
    const sel = !!s.table && s.table.schema === o.schema && s.table.name === o.name;
    tbl.appendChild(option(String(i), `${o.schema}.${o.name}${o.kind === 'table' ? '' : ` (${o.kind})`}`, sel));
  });
  tbl.addEventListener('change', () => {
    const o = tbl.value === '' ? undefined : s.objects[Number(tbl.value)];
    a.onTable(side, o ? { schema: o.schema, name: o.name } : undefined);
  });

  const controls: [string, HTMLElement][] = [
    ['Connection', prof],
    ['Database', db],
    ['Table', tbl],
  ];
  for (const [label, ctl] of controls) {
    const row = el('label', 'row');
    row.appendChild(el('span', 'label', label));
    row.appendChild(ctl);
    box.appendChild(row);
  }
  return box;
}

function checklist(
  title: string,
  role: 'key' | 'exclude',
  cols: string[],
  selected: string[],
  onToggle: (c: string, on: boolean) => void,
  bulk?: { onAll: (on: boolean) => void; hint: string },
): HTMLElement {
  const box = el('fieldset', 'cols');
  box.appendChild(el('legend', undefined, title));
  if (cols.length === 0) box.appendChild(el('div', 'hint', 'Select both tables to list shared columns.'));
  if (bulk && cols.length > 0) {
    const bar = el('div', 'bulk');
    const all = el('button', 'secondary', 'Exclude all');
    all.type = 'button';
    all.dataset.role = 'exclude-all';
    all.addEventListener('click', () => bulk.onAll(true));
    const none = el('button', 'secondary', 'Include all');
    none.type = 'button';
    none.dataset.role = 'include-all';
    none.addEventListener('click', () => bulk.onAll(false));
    bar.appendChild(all);
    bar.appendChild(none);
    box.appendChild(bar);
    box.appendChild(el('div', 'hint', bulk.hint));
  }
  const sel = new Set(selected.map(lc));
  for (const c of cols) {
    const label = el('label', 'check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.dataset.role = role;
    cb.dataset.col = c;
    cb.checked = sel.has(lc(c));
    cb.addEventListener('change', () => onToggle(c, cb.checked));
    label.appendChild(cb);
    label.appendChild(el('span', undefined, c));
    box.appendChild(label);
  }
  return box;
}

const noop = (): void => undefined;
const NO_ACTIONS: SetupActions = {
  onProfile: noop,
  onDatabase: noop,
  onTable: noop,
  onToggleKey: noop,
  onToggleExclude: noop,
  onFilter: noop,
  onIgnoreCase: noop,
  onIgnoreTrailing: noop,
  onNullEqualsBlank: noop,
  onIgnoreDataTypes: noop,
  onExcludeAll: noop,
  onRun: noop,
};

export function renderSetup(root: HTMLElement, state: SetupState, actions: SetupActions = NO_ACTIONS): void {
  root.textContent = '';
  root.appendChild(el('h1', undefined, 'Compare Tables'));

  const sides = el('div', 'sides');
  sides.appendChild(renderSide('left', state.sides.left, state, actions));
  sides.appendChild(renderSide('right', state.sides.right, state, actions));
  root.appendChild(sides);

  if (state.sides.left.poolType === 'serverless' || state.sides.right.poolType === 'serverless') {
    const note = el('div', 'note', SERVERLESS_NOTE);
    note.dataset.role = 'serverless-note';
    root.appendChild(note);
  }

  const shared = sharedColumns(state);
  const lists = el('div', 'sides');
  lists.appendChild(checklist('Key columns', 'key', shared, state.keyColumns, actions.onToggleKey));
  const compared = shared.length - state.excludedColumns.length
    - state.keyColumns.filter((k) => !state.excludedColumns.some((e) => lc(e) === lc(k))).length;
  lists.appendChild(checklist('Excluded columns', 'exclude', shared, state.excludedColumns, actions.onToggleExclude, {
    onAll: actions.onExcludeAll,
    hint: `Comparing ${Math.max(0, compared)} of ${shared.length} shared columns (keys are always used for matching). ` +
      'To compare only a few columns, click Exclude all, then untick the ones you want.',
  }));
  root.appendChild(lists);

  const fl = el('label', 'row stack');
  fl.appendChild(el('span', 'label', 'Filter (optional T-SQL WHERE condition, applied to both sides)'));
  const ta = el('textarea');
  ta.dataset.role = 'filter';
  ta.rows = 3;
  ta.value = state.filter;
  ta.addEventListener('input', () => actions.onFilter(ta.value));
  fl.appendChild(ta);
  root.appendChild(fl);

  const opts = el('div', 'opts');
  const optDefs: [string, string, boolean, (on: boolean) => void][] = [
    ['ignoreCase', 'Ignore case', state.ignoreCase, actions.onIgnoreCase],
    ['ignoreTrailing', 'Ignore trailing spaces', state.ignoreTrailingSpaces, actions.onIgnoreTrailing],
    ['nullEqualsBlank', 'Treat NULL and blank text as the same', state.nullEqualsBlank, actions.onNullEqualsBlank],
    ['ignoreDataTypes', 'Ignore data types (compare columns whose types differ instead of skipping them)', state.ignoreDataTypes, actions.onIgnoreDataTypes],
  ];
  for (const [role, text, on, cb] of optDefs) {
    const label = el('label', 'check');
    const c = el('input');
    c.type = 'checkbox';
    c.dataset.role = role;
    c.checked = on;
    c.addEventListener('change', () => cb(c.checked));
    label.appendChild(c);
    label.appendChild(el('span', undefined, text));
    opts.appendChild(label);
  }
  root.appendChild(opts);

  const verdict = canRun(state);
  const run = el('button', undefined, 'Run');
  run.dataset.role = 'run';
  run.disabled = !verdict.ok;
  run.addEventListener('click', () => actions.onRun());
  root.appendChild(run);
  const reason = el('div', 'hint', verdict.ok ? '' : verdict.reason ?? '');
  reason.dataset.role = 'reason';
  root.appendChild(reason);

  const err = el('div', 'error', state.error ?? '');
  err.dataset.role = 'error';
  root.appendChild(err);
}
