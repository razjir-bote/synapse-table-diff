// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderSetup, canRun, sharedColumns, defaultKey, excludeAllColumns, SERVERLESS_NOTE, AGG_SERVERLESS_NOTE, type SetupState } from '../../webview/setup/render';
import type { ColumnInfo } from '../../src/core/types';

const col = (name: string, ordinal = 1): ColumnInfo => ({ name, type: 'int', maxLength: 4, precision: 10, scale: 0, nullable: false, ordinal });

function side(cols: string[], declaredKey: string[] = [], extra: Partial<SetupState['sides']['left']> = {}): SetupState['sides']['left'] {
  return {
    profileId: 'p', database: 'db', table: { schema: 'dbo', name: 't' },
    databases: ['db'], objects: [{ schema: 'dbo', name: 't', kind: 'table' }],
    columns: cols.map((c, i) => col(c, i + 1)), declaredKey, poolType: 'dedicated', ...extra,
  };
}
function state(over: Partial<SetupState> = {}): SetupState {
  return {
    profiles: [{ id: 'p', name: 'Prof' }],
    sides: { left: side(['Id', 'Name', 'OnlyL'], ['Id']), right: side(['id', 'NAME', 'OnlyR']) },
    keyColumns: [], excludedColumns: [], filter: '', ignoreCase: false, ignoreTrailingSpaces: false, nullEqualsBlank: false, ignoreDataTypes: false,
    mode: 'rows', groupBy: [], measures: [], sumTolerance: '', sameFilter: true, rightFilter: '', ...over,
  };
}

describe('sharedColumns', () => {
  it('lists only columns on both sides, case-insensitively, using left names', () => {
    expect(sharedColumns(state())).toEqual(['Id', 'Name']);
  });
  it('renders only shared columns in key and exclude lists', () => {
    const root = document.createElement('div');
    renderSetup(root, state());
    const keys = Array.from(root.querySelectorAll('[data-role="key"]')).map((e) => (e as HTMLElement).dataset.col);
    const ex = Array.from(root.querySelectorAll('[data-role="exclude"]')).map((e) => (e as HTMLElement).dataset.col);
    expect(keys).toEqual(['Id', 'Name']);
    expect(ex).toEqual(['Id', 'Name']);
  });
});

describe('defaultKey', () => {
  it('uses left declared key when all columns are shared', () => {
    expect(defaultKey(state())).toEqual(['Id']);
  });
  it('is empty when a declared column is not shared', () => {
    const s = state();
    s.sides.left.declaredKey = ['Id', 'OnlyL'];
    expect(defaultKey(s)).toEqual([]);
  });
  it('is empty when a side is not described', () => {
    const s = state();
    s.sides.right.columns = [];
    expect(defaultKey(s)).toEqual([]);
  });
});

describe('canRun', () => {
  it('ok with a key', () => {
    expect(canRun(state({ keyColumns: ['Id'] })).ok).toBe(true);
  });
  it('false with an unsafe filter, with the reason', () => {
    const r = canRun(state({ keyColumns: ['Id'], filter: '1=1; DELETE FROM t' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/";"/);
  });
  it('false when a side is incomplete', () => {
    const s = state({ keyColumns: ['Id'] });
    s.sides.right.table = undefined;
    const r = canRun(s);
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });
  it('false when no key', () => {
    const r = canRun(state());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/key/i);
  });
  it('false when a key is excluded', () => {
    const r = canRun(state({ keyColumns: ['Id'], excludedColumns: ['id'] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/excluded/i);
  });
});

describe('serverless note', () => {
  it('shows when either side is serverless', () => {
    const s = state();
    s.sides.right.poolType = 'serverless';
    const root = document.createElement('div');
    renderSetup(root, s);
    expect(root.textContent).toContain("This side is a serverless pool: a comparison scans its data about three times, and you're billed per data processed.");
    expect(SERVERLESS_NOTE).toContain('serverless pool');
  });
  it('hidden otherwise', () => {
    const root = document.createElement('div');
    renderSetup(root, state());
    expect(root.textContent).not.toContain('serverless pool');
  });
});

describe('escaping and prefill', () => {
  it('escapes database-provided names', () => {
    const s = state();
    s.sides.left.columns = [col('<img src=x onerror=1>&"')];
    s.sides.right.columns = [col('<img src=x onerror=1>&"')];
    const root = document.createElement('div');
    renderSetup(root, s);
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror=1>&"');
  });
  it('reflects state for initial pre-fill', () => {
    const s = state({ keyColumns: ['Id'], excludedColumns: ['Name'], filter: 'a > 1', ignoreCase: true });
    const root = document.createElement('div');
    renderSetup(root, s);
    expect((root.querySelector('[data-role="key"][data-col="Id"]') as HTMLInputElement).checked).toBe(true);
    expect((root.querySelector('[data-role="exclude"][data-col="Name"]') as HTMLInputElement).checked).toBe(true);
    expect((root.querySelector('[data-role="filter"]') as HTMLTextAreaElement).value).toBe('a > 1');
    expect((root.querySelector('[data-role="ignoreCase"]') as HTMLInputElement).checked).toBe(true);
  });
});

import { applyHostMessage } from '../../webview/setup/reducer';

describe('applyHostMessage', () => {
  const ref = (name: string) => ({ profileId: 'p', database: 'db', schema: 'dbo', name });
  const described = (name: string, cols: string[]) => ({
    type: 'described' as const, side: 'left' as const, ref: ref(name),
    columns: cols.map((c, i) => col(c, i + 1)), declaredKey: [], poolType: 'dedicated' as const,
  });
  const fresh = () => {
    const s = state();
    s.sides.left = { ...side([]), table: { schema: 'dbo', name: 'B' }, columns: [] };
    return s;
  };

  it('drops a late described for a previously selected table', () => {
    const s = fresh();
    expect(applyHostMessage(s, described('A', ['x']))).toBe(false);
    expect(s.sides.left.columns).toEqual([]);
    expect(applyHostMessage(s, described('B', ['y']))).toBe(true);
    expect(s.sides.left.columns.map((c) => c.name)).toEqual(['y']);
  });
  it('drops described after the side was reset', () => {
    const s = fresh();
    s.sides.left = { databases: [], objects: [], columns: [], declaredKey: [], profileId: 'p' };
    expect(applyHostMessage(s, described('B', ['y']))).toBe(false);
    expect(s.sides.left.columns).toEqual([]);
  });
  it('drops late objects/databases for another profile or database', () => {
    const s = fresh();
    expect(applyHostMessage(s, { type: 'objects', side: 'left', profileId: 'p', database: 'other', objects: [{ schema: 'a', name: 'b', kind: 'table' }] })).toBe(false);
    expect(applyHostMessage(s, { type: 'databases', side: 'left', profileId: 'zzz', names: ['q'] })).toBe(false);
    expect(s.sides.left.objects).toHaveLength(1);
    expect(s.sides.left.databases).toEqual(['db']);
    expect(applyHostMessage(s, { type: 'databases', side: 'left', profileId: 'p', names: ['q'] })).toBe(true);
  });
  it('clears pendingInitial when a side errors', () => {
    const s = fresh();
    s.pendingInitial = { keys: ['Id'], excluded: [] };
    applyHostMessage(s, { type: 'error', message: 'boom', side: 'left' });
    expect(s.pendingInitial).toBeUndefined();
    expect(s.error).toBe('boom');
  });
});

describe('error persistence', () => {
  it('renders state.error and keeps it across re-renders', () => {
    const s = state({ error: 'Login failed <b>' });
    const root = document.createElement('div');
    renderSetup(root, s);
    renderSetup(root, s);
    expect(root.querySelector('[data-role="error"]')!.textContent).toBe('Login failed <b>');
    expect(root.querySelector('b')).toBeNull();
  });
});

describe('table list labels', () => {
  it('labels views and external tables, not plain tables', () => {
    const root = document.createElement('div');
    const objects = [
      { schema: 'dbo', name: 't', kind: 'table' },
      { schema: 'dbo', name: 'v', kind: 'view' },
      { schema: 'ext', name: 'e', kind: 'external table' },
    ];
    renderSetup(root, state({ sides: { left: side(['Id'], [], { objects }), right: side(['id']) } }));
    const labels = Array.from(root.querySelectorAll('[data-role="left-table"] option')).map((o) => o.textContent);
    expect(labels).toEqual(['(choose table or view)', 'dbo.t', 'dbo.v (view)', 'ext.e (external table)']);
  });
});

describe('exclude all / include all', () => {
  it('excludes every shared non-key column, or none', () => {
    const s = state({ keyColumns: ['Id'] });
    expect(excludeAllColumns(s, true)).toEqual(['Name']);
    expect(excludeAllColumns(s, false)).toEqual([]);
  });
  it('renders both buttons and the compared-column count', () => {
    const root = document.createElement('div');
    const calls: boolean[] = [];
    const noop = () => undefined;
    renderSetup(root, state({ keyColumns: ['Id'] }), {
      onProfile: noop, onDatabase: noop, onTable: noop, onToggleKey: noop, onToggleExclude: noop,
      onFilter: noop, onIgnoreCase: noop, onIgnoreTrailing: noop, onNullEqualsBlank: noop, onIgnoreDataTypes: noop,
      onExcludeAll: (on) => calls.push(on), onRun: noop,
      onMode: noop, onAddGroup: noop, onGroup: noop, onRemoveGroup: noop, onAddMeasure: noop, onMeasure: noop,
      onMeasureAgg: noop, onRemoveMeasure: noop, onSumTolerance: noop, onSameFilter: noop, onRightFilter: noop,
    });
    (root.querySelector('[data-role="exclude-all"]') as HTMLButtonElement).click();
    (root.querySelector('[data-role="include-all"]') as HTMLButtonElement).click();
    expect(calls).toEqual([true, false]);
    expect(root.textContent).toContain('Comparing 1 of 2 shared columns');
  });
  it('renders the NULL = blank option', () => {
    const root = document.createElement('div');
    renderSetup(root, state({ nullEqualsBlank: true }));
    const cb = root.querySelector('[data-role="nullEqualsBlank"]') as HTMLInputElement;
    expect(cb.checked).toBe(true);
    expect(cb.parentElement?.textContent).toContain('Treat NULL and blank text as the same');
  });
  it('renders the ignore data types option', () => {
    const root = document.createElement('div');
    renderSetup(root, state({ ignoreDataTypes: true }));
    const cb = root.querySelector('[data-role="ignoreDataTypes"]') as HTMLInputElement;
    expect(cb.checked).toBe(true);
    expect(cb.parentElement?.textContent).toContain('Ignore data types');
  });
});

describe('aggregate mode render', () => {
  const typed = (name: string, type: string, ordinal: number): ColumnInfo => ({ ...col(name, ordinal), type });
  const aggState = (over: Partial<SetupState> = {}): SetupState => {
    const s = state({ mode: 'aggregate', ...over });
    s.sides.left.columns = [typed('Region', 'varchar', 1), typed('Amount', 'decimal', 2)];
    s.sides.right.columns = [typed('area', 'varchar', 1), typed('amount', 'int', 2)];
    return s;
  };
  const render = (s: SetupState) => {
    const root = document.createElement('div');
    renderSetup(root, s);
    return root;
  };
  it('shows mode buttons with the active one marked, in both modes', () => {
    const a = render(aggState());
    expect(a.querySelector('[data-role="mode-aggregate"]')!.classList.contains('active')).toBe(true);
    expect(a.querySelector('[data-role="mode-rows"]')!.classList.contains('active')).toBe(false);
    const r = render(state());
    expect(r.querySelector('[data-role="mode-rows"]')!.classList.contains('active')).toBe(true);
  });
  it('hides key/exclude lists and shows pair selects', () => {
    const root = render(aggState({ groupBy: [{ left: 'Region', right: 'area' }], measures: [{ left: 'Amount', right: 'amount', aggs: ['sum'] }] }));
    expect(root.querySelector('[data-role="key"]')).toBeNull();
    expect(root.querySelector('[data-role="exclude"]')).toBeNull();
    expect(root.querySelectorAll('[data-role="group-left"]').length).toBe(1);
    expect(root.querySelectorAll('[data-role="measure-right"]').length).toBe(1);
    expect(root.querySelector('[data-role="group-add"]')!.textContent).toBe('+ Add group by');
    expect(root.querySelector('[data-role="measure-add"]')!.textContent).toBe('+ Add measure');
  });
  it('shows the whole-table hint with no group by', () => {
    expect(render(aggState()).textContent).toContain('No group by: compares whole-table totals.');
  });
  it('disables Sum for a non-numeric pair', () => {
    const root = render(aggState({ measures: [{ left: 'Region', right: 'area', aggs: ['count'] }, { left: 'Amount', right: 'amount', aggs: ['sum'] }] }));
    const sums = Array.from(root.querySelectorAll('[data-role="measure-agg"][data-agg="sum"]')) as HTMLInputElement[];
    expect(sums.map((c) => c.disabled)).toEqual([true, false]);
  });
  it('shows the right filter only when same-filter is unticked', () => {
    expect(render(aggState()).querySelector('[data-role="right-filter"]')).toBeNull();
    const root = render(aggState({ sameFilter: false }));
    expect(root.querySelector('[data-role="right-filter"]')).not.toBeNull();
    expect(root.textContent).toContain('Left filter');
  });
  it('uses the aggregate serverless note', () => {
    const s = aggState();
    s.sides.left.poolType = 'serverless';
    expect(render(s).querySelector('[data-role="serverless-note"]')!.textContent).toBe(AGG_SERVERLESS_NOTE);
  });
  it('canRun skips key checks and reports aggregate problems', () => {
    expect(canRun(aggState()).reason).toBe('Add at least one measure.');
    const ok = aggState({ measures: [{ left: 'Amount', right: 'amount', aggs: ['sum'] }] });
    expect(canRun(ok).ok).toBe(true);
    expect(canRun({ ...ok, sumTolerance: 'abc' }).ok).toBe(false);
  });
});

describe('sum tolerance input', () => {
  it('keeps the same element and refreshes Run on input', () => {
    const s = state({ mode: 'aggregate', measures: [{ left: 'Id', right: 'id', aggs: ['count'] }] });
    const root = document.createElement('div');
    const noop = () => undefined;
    const actions = {
      onProfile: noop, onDatabase: noop, onTable: noop, onToggleKey: noop, onToggleExclude: noop,
      onFilter: noop, onIgnoreCase: noop, onIgnoreTrailing: noop, onNullEqualsBlank: noop, onIgnoreDataTypes: noop,
      onExcludeAll: noop, onRun: noop, onMode: noop, onAddGroup: noop, onGroup: noop, onRemoveGroup: noop,
      onAddMeasure: noop, onMeasure: noop, onMeasureAgg: noop, onRemoveMeasure: noop, onSameFilter: noop, onRightFilter: noop,
      onSumTolerance: (t: string) => { s.sumTolerance = t; },
    };
    renderSetup(root, s, actions);
    const input = root.querySelector('[data-role="sum-tolerance"]') as HTMLInputElement;
    const run = root.querySelector('[data-role="run"]') as HTMLButtonElement;
    expect(run.disabled).toBe(false);
    input.value = 'abc';
    input.dispatchEvent(new Event('input'));
    expect(root.querySelector('[data-role="sum-tolerance"]')).toBe(input);
    expect(run.disabled).toBe(true);
    expect(root.querySelector('[data-role="reason"]')!.textContent).toMatch(/tolerance/i);
  });
});

describe('aggregate reducer', () => {
  it('restores a pending aggregate spec', () => {
    const s = state({ mode: 'aggregate' });
    s.sides.left.columns = [];
    s.sides.right.columns = [];
    s.pendingAggregate = {
      groupBy: [{ left: 'Id', right: 'id' }, { left: 'Gone', right: 'id' }],
      measures: [{ left: 'Name', right: 'NAME', aggs: ['count'] }],
    };
    const ref = { profileId: 'p', database: 'db', schema: 'dbo', name: 't' };
    const cols = (names: string[]) => names.map((n, i) => col(n, i + 1));
    applyHostMessage(s, { type: 'described', side: 'left', ref, columns: cols(['Id', 'Name']), declaredKey: [], poolType: 'dedicated' });
    expect(s.pendingAggregate).toBeDefined();
    applyHostMessage(s, { type: 'described', side: 'right', ref, columns: cols(['id', 'NAME']), declaredKey: [], poolType: 'dedicated' });
    expect(s.groupBy).toEqual([{ left: 'Id', right: 'id' }]);
    expect(s.measures).toEqual([{ left: 'Name', right: 'NAME', aggs: ['count'] }]);
    expect(s.pendingAggregate).toBeUndefined();
  });
});
