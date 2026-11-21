import { ComparePlanError } from './errors';
import { planColumnPair } from '../sql/normalize';
import type {
  ColumnInfo, ColumnPairPlan, ComparePlan, CompareRequest, ExcludedColumn, SchemaColumnDiff, SchemaDiff,
} from './types';

type Indexed = { col: ColumnInfo; rank: number };

function index(cols: ColumnInfo[]): Map<string, Indexed> {
  const sorted = [...cols].sort((a, b) => a.ordinal - b.ordinal);
  const m = new Map<string, Indexed>();
  sorted.forEach((col, i) => m.set(col.name.toLowerCase(), { col, rank: i + 1 }));
  return m;
}

export function diffSchema(
  left: ColumnInfo[], right: ColumnInfo[], req: CompareRequest,
): { schema: SchemaDiff; plan: ComparePlan } {
  const L = index(left);
  const R = index(right);
  const opts = { ignoreCase: req.ignoreCase, ignoreTrailingSpaces: req.ignoreTrailingSpaces };

  const columns: SchemaColumnDiff[] = [];
  for (const [k, l] of L) {
    const r = R.get(k);
    if (!r) {
      columns.push({ name: l.col.name, status: 'removed', left: l.col, changes: [] });
      continue;
    }
    const changes: SchemaColumnDiff['changes'] = [];
    const a = l.col;
    const b = r.col;
    if (a.type !== b.type || a.maxLength !== b.maxLength || a.precision !== b.precision || a.scale !== b.scale) {
      changes.push('type');
    }
    if (a.nullable !== b.nullable) changes.push('nullability');
    if (l.rank !== r.rank) changes.push('position');
    columns.push({
      name: a.name, status: changes.length ? 'changed' : 'same', left: a, right: b, changes,
    });
  }
  for (const [k, r] of R) {
    if (!L.has(k)) columns.push({ name: r.col.name, status: 'added', right: r.col, changes: [] });
  }
  const schema: SchemaDiff = {
    columns,
    differenceCount: columns.filter((c) => c.status !== 'same').length,
  };

  const excludedByUser = new Set(req.excludedColumns.map((c) => c.toLowerCase()));
  const toPlan = (l: ColumnInfo, r: ColumnInfo) => {
    const p = planColumnPair(l, r, opts);
    return p.ok
      ? { ok: true as const, plan: { name: l.name, leftName: l.name, rightName: r.name, norm: p.norm } as ColumnPairPlan }
      : { ok: false as const, reason: p.reason };
  };

  if (req.keyColumns.length === 0) throw new ComparePlanError('At least one key column is required');
  const keyLower = new Set<string>();
  const keys: ColumnPairPlan[] = [];
  for (const name of req.keyColumns) {
    const k = name.toLowerCase();
    if (excludedByUser.has(k)) throw new ComparePlanError(`Key column ${name} cannot also be excluded`);
    const l = L.get(k);
    const r = R.get(k);
    if (!l || !r) {
      throw new ComparePlanError(`Key column ${name} is missing on the ${!l && !r ? 'left and right sides' : !l ? 'left side' : 'right side'}`);
    }
    const p = toPlan(l.col, r.col);
    if (!p.ok) throw new ComparePlanError(`Key column ${name} cannot be compared: ${p.reason}`);
    keyLower.add(k);
    keys.push(p.plan);
  }

  const compared: ColumnPairPlan[] = [];
  const excluded: ExcludedColumn[] = [];
  const shared = [...L.keys()].filter((k) => R.has(k) && !keyLower.has(k)).sort();
  for (const k of shared) {
    const l = L.get(k)!.col;
    const r = R.get(k)!.col;
    if (excludedByUser.has(k)) {
      excluded.push({ name: l.name, reason: 'excluded by user' });
      continue;
    }
    const p = toPlan(l, r);
    if (p.ok) compared.push(p.plan);
    else excluded.push({ name: l.name, reason: p.reason });
  }
  return { schema, plan: { keys, compared, excluded } };
}
