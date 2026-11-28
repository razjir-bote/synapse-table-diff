import { ComparePlanError } from './errors';
import { decimalShape, familyOf, planColumnPair } from '../sql/normalize';
import type {
  AggKind, AggregatePlan, AggTarget, ColumnInfo, CompareRequest, GroupPlan, MeasurePlan, SumMode,
} from './types';

const AGG_ORDER: AggKind[] = ['sum', 'count', 'distinct'];
const AGG_LABEL: Record<AggKind, string> = { sum: 'sum', count: 'count', distinct: 'distinct count' };

/** Exact decimal sum when both sides fit in 38 digits, float otherwise; undefined when either side is not numeric. */
export function sumModeFor(l: ColumnInfo, r: ColumnInfo): SumMode | undefined {
  const lf = familyOf(l);
  const rf = familyOf(r);
  const num = (f: string) => f === 'integer' || f === 'exactDecimal' || f === 'approxFloat';
  if (!num(lf) || !num(rf)) return undefined;
  const exact = (f: string) => f === 'integer' || f === 'exactDecimal';
  if (exact(lf) && exact(rf)) {
    const shape = (c: ColumnInfo) => (familyOf(c) === 'integer' ? { p: 19, s: 0 } : decimalShape(c));
    const a = shape(l);
    const b = shape(r);
    const scale = Math.max(a.s, b.s);
    const intDigits = Math.max(a.p - a.s, b.p - b.s);
    if (intDigits + scale <= 38) return { kind: 'exact', scale };
  }
  return { kind: 'float' };
}

function find(cols: ColumnInfo[], name: string, side: 'left' | 'right'): ColumnInfo {
  const k = name.toLowerCase();
  const c = cols.find((x) => x.name.toLowerCase() === k);
  if (!c) throw new ComparePlanError(`Column ${name} is not in the ${side} table.`);
  return c;
}

/** Display name for a pair: the left name when both match case-insensitively, else `left ↔ right`. */
function pairName(l: string, r: string): string {
  return l.toLowerCase() === r.toLowerCase() ? l : `${l} ↔ ${r}`;
}

export function planAggregate(left: ColumnInfo[], right: ColumnInfo[], req: CompareRequest): AggregatePlan {
  const spec = req.aggregate;
  if (!spec || spec.measures.length === 0) throw new ComparePlanError('Add at least one measure.');
  const opts = {
    ignoreCase: req.ignoreCase,
    ignoreTrailingSpaces: req.ignoreTrailingSpaces,
    nullEqualsBlank: req.nullEqualsBlank === true,
    ignoreDataTypes: req.ignoreDataTypes === true,
  };

  const groups: GroupPlan[] = spec.groupBy.map((g) => {
    const l = find(left, g.left, 'left');
    const r = find(right, g.right, 'right');
    const label = pairName(g.left, g.right);
    const p = planColumnPair(l, r, opts);
    if (!p.ok) throw new ComparePlanError(`Group by ${g.left} ↔ ${g.right} cannot be compared: ${p.reason}`);
    return {
      leftName: l.name, rightName: r.name, label, norm: p.norm,
      trailingSignificant: (p.norm.family === 'character' || p.norm.perSide !== undefined) && !p.norm.rtrim,
    };
  });

  const measures: MeasurePlan[] = [];
  const targets: AggTarget[] = [{ label: 'Rows', agg: 'rows', measure: -1, alias: 'rc' }];
  spec.measures.forEach((m, i) => {
    const title = `${m.left} ↔ ${m.right}`;
    if (m.aggs.length === 0) throw new ComparePlanError(`Measure ${title}: choose at least one aggregate.`);
    const l = find(left, m.left, 'left');
    const r = find(right, m.right, 'right');
    const aggs = AGG_ORDER.filter((a) => m.aggs.includes(a));
    const plan: MeasurePlan = { leftName: l.name, rightName: r.name, aggs };
    if (aggs.includes('sum')) {
      const sum = sumModeFor(l, r);
      if (!sum) throw new ComparePlanError(`Measure ${title}: Sum needs numeric columns.`);
      plan.sum = sum;
    }
    const p = planColumnPair(l, r, opts);
    if (p.ok) plan.norm = p.norm;
    else if (aggs.includes('distinct')) {
      throw new ComparePlanError(`Measure ${title}: Distinct count cannot be compared: ${p.reason}`);
    }
    measures.push(plan);
    const name = pairName(m.left, m.right);
    for (const agg of aggs) {
      targets.push({ label: `${name} · ${AGG_LABEL[agg]}`, agg, measure: i, alias: `m_${i}_${agg}` });
    }
  });
  return { groups, measures, targets };
}
