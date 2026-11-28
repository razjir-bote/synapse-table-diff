import { describe, it, expect } from 'vitest';
import sql from 'mssql';
import { openRunner, type SideConnector } from '../../src/db/runner';
import { runAggregateComparison } from '../../src/core/aggregatePipeline';
import type { PipelineDeps } from '../../src/core/pipeline';
import { DEFAULT_LIMITS, type AggregateSpec, type CompareRequest, type Limits, type TableRef } from '../../src/core/types';

const conn = process.env.TABLEDIFF_TEST_CONN;
if (!conn) throw new Error('TABLEDIFF_TEST_CONN is not set');
const baseConfig = (sql.ConnectionPool as unknown as { parseConnectionString(s: string): sql.config })
  .parseConnectionString(conn);

const DB_A = 'tablediff_a';
const DB_B = 'tablediff_b';

const connector = (database: string): SideConnector => ({
  label: database,
  poolType: 'other',
  open: () => openRunner({ ...baseConfig, database }, 600),
});
const t = (database: string, name: string): TableRef => ({ profileId: 'test', database, schema: 'dbo', name });

const spec = (over: Partial<AggregateSpec> = {}): AggregateSpec => ({
  groupBy: [{ left: 'region', right: 'area' }],
  measures: [
    { left: 'amount', right: 'amt', aggs: ['sum', 'count'] },
    { left: 'cust', right: 'customer', aggs: ['distinct'] },
  ],
  ...over,
});
const req = (aggregate: AggregateSpec, over: Partial<CompareRequest> = {}): CompareRequest => ({
  left: t(DB_A, 'agg_l'),
  right: t(DB_B, 'agg_r'),
  keyColumns: [],
  excludedColumns: [],
  ignoreCase: false,
  ignoreTrailingSpaces: false,
  mode: 'aggregate',
  aggregate,
  ...over,
});
const deps = (limits: Partial<Limits> = {}): PipelineDeps => ({
  left: connector(DB_A), right: connector(DB_B), limits: { ...DEFAULT_LIMITS, ...limits },
});

describe('runAggregateComparison: agg_l vs agg_r', () => {
  it('case 1: grouped, exact, binary collation', async () => {
    const res = await runAggregateComparison(req(spec()), deps());
    expect({
      l: res.leftGroups, r: res.rightGroups, changed: res.changed, removed: res.removed, added: res.added, matching: res.matching,
    }).toEqual({ l: 6, r: 6, changed: 1, removed: 2, added: 2, matching: 3 });
    const changed = res.rows.find((r) => r.kind === 'changed')!;
    expect(changed.group).toEqual(['S']);
    const sumIdx = res.plan.targets.findIndex((x) => x.agg === 'sum');
    expect(changed.diff[sumIdx]).toBe('0.0100');
  });

  it('case 2: tolerance, ignoreCase, ignoreTrailingSpaces', async () => {
    const res = await runAggregateComparison(
      req(spec({ sumTolerance: '0.01' }), { ignoreCase: true, ignoreTrailingSpaces: true }), deps());
    expect({ changed: res.changed, removed: res.removed, added: res.added }).toEqual({ changed: 0, removed: 1, added: 1 });
    const removed = res.rows.filter((r) => r.kind === 'removed');
    const added = res.rows.filter((r) => r.kind === 'added');
    expect(removed.map((r) => r.group)).toEqual([[null]]);
    expect(added.map((r) => r.group)).toEqual([['W']]);
    // 'a' on the left and 'A ' on the right matched: no removed/added row for it
    const all = [...removed, ...added].map((r) => String(r.group[0]).trim().toLowerCase());
    expect(all).not.toContain('a');
  });

  it('case 3: no group by compares whole-table totals', async () => {
    const res = await runAggregateComparison(req(spec({ groupBy: [] })), deps());
    expect(res.leftGroups).toBe(1);
    expect(res.rightGroups).toBe(1);
    expect(res.changed).toBe(1);
    const row = res.rows[0];
    const rc = res.plan.targets.findIndex((x) => x.agg === 'rows');
    const sumIdx = res.plan.targets.findIndex((x) => x.agg === 'sum');
    expect(row.left[sumIdx]).toBe('28.5000');
    expect(row.right[sumIdx]).toBe('29.5100');
    expect(row.left[rc]).toBe('7');
    expect(row.right[rc]).toBe('7');
  });

  it('case 4: per-side filters', async () => {
    const res = await runAggregateComparison(
      req(spec({ groupBy: [], rightFilter: "area = 'N'" }), { filter: "region = 'N'" }), deps());
    expect({ changed: res.changed, matching: res.matching }).toEqual({ changed: 0, matching: 1 });
  });

  it('case 5: group cap', async () => {
    await expect(runAggregateComparison(req(spec()), deps({ pairLimit: 3 }))).rejects.toThrow(/more than 3 groups/);
  });
});
