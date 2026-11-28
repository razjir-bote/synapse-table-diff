import { describe, it, expect, vi } from 'vitest';
import { ProfileStore, type ConnectionProfile } from '../../src/profiles/profileStore';
import { RecentStore } from '../../src/profiles/recentStore';
import { ConnectionsProvider, RecentProvider, connectionRow, recentRow } from '../../src/ui/sidebar';
import { recentLabel, STAGE_MESSAGES } from '../../src/commands/compare';
import type { CompareRequest } from '../../src/core/types';
import { FakeMemento, FakeSecrets } from './fakes';

const prof = (id: string, name: string, over: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id, name, server: `${name}.sql.azuresynapse.net`, database: 'sqlpool01', auth: 'entra', ...over,
});
const req = (over: Partial<CompareRequest> = {}): CompareRequest => ({
  left: { profileId: 'a', database: 'dbA', schema: 'dbo', name: 'orders' },
  right: { profileId: 'b', database: 'dbB', schema: 'stage', name: 'orders' },
  keyColumns: ['order_id'], excludedColumns: [], ignoreCase: false, ignoreTrailingSpaces: false, ...over,
});
const stores = () => {
  const store = new ProfileStore(new FakeMemento() as never, new FakeSecrets() as never);
  const recent = new RecentStore(new FakeMemento() as never);
  return { store, recent };
};

describe('sidebar rows', () => {
  it('describes a connection by auth type and database', () => {
    const r = connectionRow(prof('a', 'Prod', { auth: 'sql', user: 'reader' }));
    expect(r).toMatchObject({ label: 'Prod', description: 'SQL · sqlpool01', contextValue: 'connection', icon: 'database' });
    expect(r.tooltip).toContain('Prod.sql.azuresynapse.net');
    expect(r.tooltip).toContain('SQL login reader');
  });

  it('describes a recent comparison with both connection names, and flags a missing one', () => {
    const r = recentRow(req({ filter: " region = 'EU' " }), (id) => (id === 'a' ? 'Prod' : undefined));
    expect(r.label).toBe('dbo.orders ↔ stage.orders');
    expect(r.description).toBe('Prod → (missing connection)');
    expect(r.tooltip).toContain("Filter: region = 'EU'");
    expect(r.contextValue).toBe('recent');
  });

  it('labels aggregate recents with a Σ prefix and keeps rows-mode labels unchanged', () => {
    const rows = req();
    expect(recentLabel({ ...rows, mode: 'aggregate' })).toBe('Σ dbo.orders ↔ stage.orders');
    expect(recentLabel({ ...rows, mode: 'rows' })).toBe('dbo.orders ↔ stage.orders');
    expect(recentLabel(rows)).toBe('dbo.orders ↔ stage.orders');
  });

  it('sidebar recent label is exactly recentLabel(r) for both modes', () => {
    const agg = req({ mode: 'aggregate' });
    expect(recentRow(agg, () => 'Prod').label).toBe(recentLabel(agg));
    expect(recentRow(req(), () => 'Prod').label).toBe(recentLabel(req()));
  });

  it('has a progress message for the aggregates stage', () => {
    expect(STAGE_MESSAGES.aggregates).toBe('Computing aggregates…');
  });
});

describe('sidebar providers', () => {
  it('lists connections sorted by name and refreshes when the store changes', async () => {
    const { store } = stores();
    const p = new ConnectionsProvider(store);
    const fired = vi.fn();
    p.onDidChangeTreeData(fired);
    store.onDidChange(() => p.refresh());
    await store.save(prof('2', 'zeta'));
    await store.save(prof('1', 'Alpha'));
    expect(p.getChildren().map((x) => x.name)).toEqual(['Alpha', 'zeta']);
    await store.remove('2');
    expect(p.getChildren().map((x) => x.name)).toEqual(['Alpha']);
    expect(fired).toHaveBeenCalledTimes(3);
  });

  it('recent items open the setup form on click and refresh after a run is saved', async () => {
    const { store, recent } = stores();
    await store.save(prof('a', 'Prod'));
    const p = new RecentProvider(recent, store);
    const fired = vi.fn();
    p.onDidChangeTreeData(fired);
    recent.onDidChange(() => p.refresh());
    await recent.add(req());
    const [r] = p.getChildren();
    const item = p.getTreeItem(r);
    expect(item.command).toEqual({ command: 'tableDiff.openRecent', title: 'Open in setup form', arguments: [r] });
    expect(item.contextValue).toBe('recent');
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('store listeners can unsubscribe', async () => {
    const { store } = stores();
    const l = vi.fn();
    const off = store.onDidChange(l);
    await store.save(prof('1', 'A'));
    off();
    await store.save(prof('2', 'B'));
    expect(l).toHaveBeenCalledTimes(1);
  });
});
