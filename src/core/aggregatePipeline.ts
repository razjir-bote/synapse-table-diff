import type { QueryRunner } from '../db/runner';
import { aggregateQuery } from '../sql/aggregateQueries';
import { filterProblem } from '../sql/filterGuard';
import { columnsQuery } from '../sql/queries';
import { compareAggregates, parseTolerance } from './aggregateCompare';
import { planAggregate } from './aggregatePlan';
import { CompareCancelledError, ComparePlanError } from './errors';
import { toColumn, withRunners, type PipelineDeps } from './pipeline';
import type { AggregatePlan, AggregateResult, CompareRequest, Side, Stage, TableRef } from './types';

const SIDES: Side[] = ['left', 'right'];
const num = (n: number) => n.toLocaleString('en-US');

/** Names the exact-sum measure(s) whose decimal(38,s) SUM may have overflowed; undefined when there are none. */
function overflowMessage(plan: AggregatePlan, original: string): string | undefined {
  const sums: { label: string; scale: number }[] = [];
  for (const t of plan.targets) {
    if (t.agg !== 'sum') continue;
    const mode = plan.measures[t.measure]?.sum;
    if (mode?.kind === 'exact') sums.push({ label: t.label.replace(/ · sum$/, ''), scale: mode.scale });
  }
  if (sums.length === 0) return undefined;
  if (sums.length === 1) return `Sum of ${sums[0].label} overflowed decimal(38,${sums[0].scale}). ${original}`;
  const same = sums.every((s) => s.scale === sums[0].scale);
  const list = sums.map((s) => (same ? s.label : `${s.label} (scale ${s.scale})`)).join(', ');
  return `Sum overflowed decimal(38,${same ? sums[0].scale : '…'}) for one of: ${list}. ${original}`;
}

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
    let data: { left: Record<string, unknown>[]; right: Record<string, unknown>[] };
    try {
      data = await withRunners(deps, async (r, sig) => {
        const [left, right] = await Promise.all(SIDES.map((s) => readSide(r[s], s, sig)));
        return { left, right };
      });
    } catch (err) {
      if (!signal?.aborted && !(err instanceof CompareCancelledError) && !(err instanceof ComparePlanError) &&
        err instanceof Error && /arithmetic overflow/i.test(err.message)) {
        const named = overflowMessage(plan, err.message);
        if (named) throw new ComparePlanError(named);
      }
      throw err;
    }
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
