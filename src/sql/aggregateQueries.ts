import { ComparePlanError } from '../core/errors';
import type { AggregatePlan, MeasurePlan, Side, TableRef } from '../core/types';
import { filterProblem } from './filterGuard';
import { normalizeExpr } from './normalize';
import { qualifiedName, quoteIdent } from './sqlText';

const BIN2 = 'COLLATE Latin1_General_100_BIN2';

function measureTarget(m: MeasurePlan, agg: string, side: Side, alias: string): string {
  const name = side === 'left' ? m.leftName : m.rightName;
  const raw = quoteIdent(name);
  const norm = m.norm ? normalizeExpr(raw, m.norm, side) : undefined;
  switch (agg) {
    case 'count':
      return `CAST(COUNT_BIG(${norm ?? raw}) AS varchar(20)) AS ${alias}`;
    case 'distinct': {
      const n = norm ?? raw;
      const trailing = m.norm !== undefined &&
        (m.norm.family === 'character' || m.norm.perSide !== undefined) && !m.norm.rtrim;
      const e = trailing ? `${n} + N'|'` : n;
      return `CAST(COUNT_BIG(DISTINCT (${e}) ${BIN2}) AS varchar(20)) AS ${alias}`;
    }
    default:
      return m.sum?.kind === 'exact'
        ? `CAST(SUM(CAST(${raw} AS decimal(38,${m.sum.scale}))) AS varchar(45)) AS ${alias}`
        : `CONVERT(varchar(30), SUM(CAST(${raw} AS float)), 3) AS ${alias}`;
  }
}

/** One side's GROUP BY query: normalized group values, the row count and each chosen aggregate, all as text. */
export function aggregateQuery(plan: AggregatePlan, side: Side, t: TableRef, filter: string | undefined): string {
  const problem = filterProblem(filter);
  if (problem) throw new ComparePlanError(problem);
  const gexprs = plan.groups.map((g) =>
    normalizeExpr(quoteIdent(side === 'left' ? g.leftName : g.rightName), g.norm, side));
  const select = [
    ...gexprs.map((e, i) => `(${e}) ${BIN2} AS g_${i}`),
    ...plan.targets.map((tg) =>
      tg.agg === 'rows'
        ? `CAST(COUNT_BIG(*) AS varchar(20)) AS ${tg.alias}`
        : measureTarget(plan.measures[tg.measure], tg.agg, side, tg.alias)),
  ];
  const where = filter !== undefined && filter.trim() !== '' ? ` WHERE (\n${filter}\n)` : '';
  let sql = `SELECT ${select.join(', ')}\nFROM ${qualifiedName(t)}${where}`;
  if (gexprs.length > 0) {
    const by = gexprs.flatMap((e, i) =>
      plan.groups[i].trailingSignificant ? [`(${e}) ${BIN2}`, `DATALENGTH(${e})`] : [`(${e}) ${BIN2}`]);
    sql += `\nGROUP BY ${by.join(', ')}`;
  }
  return sql;
}
