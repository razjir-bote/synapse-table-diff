import type { QueryRunner } from '../db/runner';
import { aggregateQuery } from '../sql/aggregateQueries';
import { filterProblem } from '../sql/filterGuard';
import { columnsQuery } from '../sql/queries';
import { compareAggregates, parseTolerance } from './aggregateCompare';
import { planAggregate } from './aggregatePlan';
import { CompareCancelledError, ComparePlanError } from './errors';
import { toColumn, withRunners, type PipelineDeps } from './pipeline';
import type { AggregateResult, CompareRequest, Side, Stage, TableRef } from './types';

const SIDES: Side[] = ['left', 'right'];
const num = (n: number) => n.toLocaleString('en-US');

export async function runAggregateComparison(req: CompareRequest, deps: PipelineDeps): Promise<AggregateResult> {
  const started = Date.now();
  const spec = req.aggregate;
  if (!spec) throw new ComparePlanError('Aggregate comparison needs an aggregate specification.');
  const filters: Record<Side, string | undefined> = {
    left: req.filter,
    right: spec.rightFilter !== undefined ? spec.rightFilter : req.filter,
  };
  // Reject unsafe filters and a bad tolerance before opening any connection.
  for (const s of SIDES) {
    const issue = filterProblem(filters[s]);
    if (issue) throw new ComparePlanError(issue);
  }
  const tol = parseTolerance(spec.sumTolerance);
  const { signal, limits } = deps;
  const progress = (stage: Stage, detail?: string) => deps.onProgress?.(stage, detail);
  const tables: Record<Side, TableRef> = { left: req.left, right: req.right };
  const poolTypes = { left: deps.left.poolType, right: deps.right.poolType };
  const cancelled = () => new CompareCancelledError('Comparison cancelled');
  const checkAbort = () => { if (signal?.aborted) throw cancelled(); };

  try {
    const where = (s: Side) => `${tables[s].schema}.${tables[s].name} on ${deps[s].label}`;
    progress('schema', `Reading the columns of ${where('left')} and ${where('right')}…`);
    const cols = await withRunners(deps, async (r, sig) => {
      const [l, rr] = await Promise.all(SIDES.map((s) => r[s].query(columnsQuery(tables[s]), sig)));
      return { left: l.map(toColumn), right: rr.map(toColumn) };
    });
    checkAbort();
    const plan = planAggregate(cols.left, cols.right, req);

    progress('aggregates', 'Computing aggregates on both tables (one scan of each)…');
    const readSide = async (r: QueryRunner, side: Side, sig: AbortSignal) => {
      const rows: Record<string, unknown>[] = [];
      const sql = aggregateQuery(plan, side, tables[side], filters[side]);
      for await (const row of r.stream<Record<string, unknown>>(sql, sig)) {
        rows.push(row);
        if (rows.length > limits.pairLimit) {
          throw new ComparePlanError(
            `The ${side} table has more than ${num(limits.pairLimit)} groups. ` +
            'Group by fewer columns, or raise the tableDiff.pairLimit setting.',
          );
        }
      }
      return rows;
    };
    const data = await withRunners(deps, async (r, sig) => {
      const [left, right] = await Promise.all(SIDES.map((s) => readSide(r[s], s, sig)));
      return { left, right };
    });
    checkAbort();

    progress('compare', 'Comparing groups…');
    const out = compareAggregates(data.left, data.right, plan, tol, limits.detailLimit);
    const warnings: string[] = [];
    if (out.detailCapped) {
      warnings.push(
        `Showing the first ${num(out.rows.length)} of ${num(out.changed + out.added + out.removed)} differing groups.`,
      );
    }
    return {
      mode: 'aggregate', request: req, plan, ...out, warnings, durationMs: Date.now() - started, poolTypes,
    };
  } catch (err) {
    if (signal?.aborted && !(err instanceof CompareCancelledError)) throw cancelled();
    throw err;
  }
}
