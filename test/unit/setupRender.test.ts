// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderSetup, canRun, sharedColumns, defaultKey, SERVERLESS_NOTE, type SetupState } from '../../webview/setup/render';
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
    keyColumns: [], excludedColumns: [], filter: '', ignoreCase: false, ignoreTrailingSpaces: false, ...over,
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
