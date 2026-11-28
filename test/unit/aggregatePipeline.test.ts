import { describe, it, expect } from 'vitest';
import { runAggregateComparison } from '../../src/core/aggregatePipeline';
import { CompareCancelledError, ComparePlanError } from '../../src/core/errors';
import type { PipelineDeps } from '../../src/core/pipeline';
import type { QueryRunner } from '../../src/db/runner';
import type { CompareRequest, Stage } from '../../src/core/types';
import { DEFAULT_LIMITS } from '../../src/core/types';

const ref = { profileId: 'p', database: 'd', schema: 's', name: 't' };
const colRow = (name: string, type_name: string, o: Record<string, unknown> = {}) => ({
  name, type_name, max_length: 10, precision: 0, scale: 0, is_nullable: 1, column_id: 1, ...o,
});
const COLS = [colRow('region', 'varchar'), colRow('amount', 'decimal', { precision: 10, scale: 2 })];

function makeSide(streamRows: Record<string, unknown>[], log: { sql: string[]; opened: number }) {
  return {
    label: 'srv',
    poolType: 'dedicated' as const,
    async open(): Promise<QueryRunner> {
      log.opened++;
      return {
        async query() { return COLS as never; },
        async *stream(sql: string) { log.sql.push(sql); for (const r of streamRows) yield r as never; },
        async close() {},
      } as unknown as QueryRunner;
    },
  };
}

function setup(left: Record<string, unknown>[], right: Record<string, unknown>[], o: Partial<PipelineDeps> = {}) {
  const ll = { sql: [] as string[], opened: 0 };
  const rl = { sql: [] as string[], opened: 0 };
  const stages: [Stage, string | undefined][] = [];
  const deps: PipelineDeps = {
    left: makeSide(left, ll), right: makeSide(right, rl), limits: DEFAULT_LIMITS,
    onProgress: (s, d) => stages.push([s, d]), ...o,
  };
  return { deps, ll, rl, stages };
}

function req(o: Partial<CompareRequest> = {}, agg: Record<string, unknown> = {}): CompareRequest {
  return {
    left: ref, right: ref, keyColumns: [], excludedColumns: [], ignoreCase: false, ignoreTrailingSpaces: false,
    mode: 'aggregate',
    aggregate: {
      groupBy: [{ left: 'region', right: 'region' }],
      measures: [{ left: 'amount', right: 'amount', aggs: ['sum'] }],
      ...agg,
    },
    ...o,
  };
}
const row = (g: string, rc: string, s: string) => ({ g_0: g, rc, m_0_sum: s });

describe('runAggregateComparison', () => {
  it('counts groups from canned rows and reports progress', async () => {
    const { deps, stages } = setup(
      [row('a', '1', '1.00'), row('b', '2', '2.00')],
      [row('a', '1', '1.00'), row('b', '2', '3.00'), row('c', '1', '1.00')],
    );
    const r = await runAggregateComparison(req(), deps);
    expect(r.mode).toBe('aggregate');
    expect([r.leftGroups, r.rightGroups, r.matching, r.changed, r.added, r.removed]).toEqual([2, 3, 1, 1, 1, 0]);
    expect(r.poolTypes).toEqual({ left: 'dedicated', right: 'dedicated' });
    expect(stages.map((s) => s[0])).toEqual(['schema', 'aggregates', 'compare']);
    expect(stages[1][1]).toBe('Computing aggregates on both tables (one scan of each)…');
  });

  it('uses the right filter for the right query only', async () => {
    const { deps, ll, rl } = setup([], []);
    await runAggregateComparison(req({ filter: 'x = 1' }, { rightFilter: 'y = 2' }), deps);
    expect(ll.sql[0]).toContain('x = 1');
    expect(ll.sql[0]).not.toContain('y = 2');
    expect(rl.sql[0]).toContain('y = 2');
    expect(rl.sql[0]).not.toContain('x = 1');
  });

  it("treats '' right filter as no filter", async () => {
    const { deps, ll, rl } = setup([], []);
    await runAggregateComparison(req({ filter: 'x = 1' }, { rightFilter: '' }), deps);
    expect(ll.sql[0]).toContain('WHERE');
    expect(rl.sql[0]).not.toContain('WHERE');
  });

  it('rejects an unsafe right filter before connecting', async () => {
    const { deps, ll, rl } = setup([], []);
    await expect(runAggregateComparison(req({}, { rightFilter: 'x; DROP TABLE t' }), deps)).rejects.toThrow(ComparePlanError);
    expect(ll.opened + rl.opened).toBe(0);
  });

  it('rejects a bad tolerance before connecting', async () => {
    const { deps, ll } = setup([], []);
    await expect(runAggregateComparison(req({}, { sumTolerance: 'abc' }), deps)).rejects.toThrow(ComparePlanError);
    expect(ll.opened).toBe(0);
  });

  it('throws the group cap error', async () => {
    const { deps } = setup([row('a', '1', '1'), row('b', '1', '1'), row('c', '1', '1')], [], {
      limits: { ...DEFAULT_LIMITS, pairLimit: 2 },
    });
    await expect(runAggregateComparison(req(), deps)).rejects.toThrow(
      'The left table has more than 2 groups. Group by fewer columns, or raise the tableDiff.pairLimit setting.',
    );
  });

  it('warns when the detail is capped', async () => {
    const { deps } = setup([row('a', '1', '1'), row('b', '1', '1')], [], {
      limits: { ...DEFAULT_LIMITS, detailLimit: 1 },
    });
    const r = await runAggregateComparison(req(), deps);
    expect(r.warnings).toEqual(['Showing the first 1 of 2 differing groups.']);
  });

  it('maps an aborted signal to CompareCancelledError', async () => {
    const ac = new AbortController();
    ac.abort();
    const { deps } = setup([], [], { signal: ac.signal });
    await expect(runAggregateComparison(req(), deps)).rejects.toThrow(CompareCancelledError);
  });
});
