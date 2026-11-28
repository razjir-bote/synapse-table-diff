import { ComparePlanError } from './errors';
import type { AggregatePlan, AggregateResult, AggregateRow } from './types';

export type Tolerance = { kind: 'none' } | { kind: 'abs'; value: string } | { kind: 'pct'; value: string };

const TOL_RE = /^\d+(\.\d+)?%?$/;

export function parseTolerance(text: string | undefined): Tolerance {
  const t = (text ?? '').trim();
  if (!t) return { kind: 'none' };
  if (!TOL_RE.test(t)) throw new ComparePlanError('Sum tolerance must be a number like 0.01 or a percentage like 0.1%.');
  return t.endsWith('%') ? { kind: 'pct', value: t.slice(0, -1) } : { kind: 'abs', value: t };
}

// --- scaled decimal helpers -------------------------------------------------

function decimalScale(text: string): number {
  const i = text.indexOf('.');
  return i < 0 ? 0 : text.length - i - 1;
}

/** Parse a plain decimal string into a BigInt scaled by 10^scale (extra fraction digits are truncated). */
function toScaled(text: string | null | undefined, scale: number): bigint {
  if (text === null || text === undefined || text === '') return 0n;
  let s = String(text).trim();
  let neg = false;
  if (s.startsWith('-')) { neg = true; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  const [intPart, frac = ''] = s.split('.');
  const v = BigInt((intPart || '0') + frac.padEnd(scale, '0').slice(0, scale));
  return neg ? -v : v;
}

function fromScaled(v: bigint, scale: number): string {
  if (scale === 0) return v.toString();
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -scale)}.${s.slice(-scale)}`;
}

const abs = (v: bigint) => (v < 0n ? -v : v);

function exactSumEqual(l: string | null, r: string | null, scale: number, tol: Tolerance): boolean {
  if (tol.kind === 'none') return toScaled(l, scale) === toScaled(r, scale);
  const ts = decimalScale(tol.value);
  const w = Math.max(scale, ts);
  const lv = toScaled(l, w);
  const rv = toScaled(r, w);
  const delta = abs(rv - lv);
  if (tol.kind === 'abs') return delta <= toScaled(tol.value, w);
  // |Δ| × 100 <= (pct / 10^ts) × max  <=>  |Δ| × 100 × 10^ts <= pct × max
  const m = abs(lv) > abs(rv) ? abs(lv) : abs(rv);
  return delta * 100n * 10n ** BigInt(ts) <= toScaled(tol.value, ts) * m;
}

const num = (v: string | null): number => Number(v ?? 0) || 0;

function floatSumEqual(l: string | null, r: string | null, tol: Tolerance): boolean {
  const lv = num(l);
  const rv = num(r);
  const m = Math.max(Math.abs(lv), Math.abs(rv));
  let user = 0;
  if (tol.kind === 'abs') user = Number(tol.value);
  else if (tol.kind === 'pct') user = (Number(tol.value) / 100) * m;
  return Math.abs(rv - lv) <= Math.max(user, 1e-9 * m);
}

function big(v: string | null): bigint {
  return v === null || v === '' ? 0n : BigInt(v);
}

const cell = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function compareTarget(
  plan: AggregatePlan, ti: number, ls: string | null, rs: string | null, tol: Tolerance,
): { differs: boolean; diff: string } {
  const t = plan.targets[ti];
  if (t.agg === 'sum') {
    const mode = plan.measures[t.measure]?.sum;
    if (mode?.kind === 'exact') {
      const s = mode.scale;
      return { differs: !exactSumEqual(ls, rs, s, tol), diff: fromScaled(toScaled(rs, s) - toScaled(ls, s), s) };
    }
    return { differs: !floatSumEqual(ls, rs, tol), diff: String(Number((num(rs) - num(ls)).toPrecision(15))) };
  }
  const lb = big(ls);
  const rb = big(rs);
  return { differs: lb !== rb, diff: (rb - lb).toString() };
}

export function compareAggregates(
  left: Record<string, unknown>[],
  right: Record<string, unknown>[],
  plan: AggregatePlan,
  tol: Tolerance,
  detailLimit: number,
): Omit<AggregateResult, 'mode' | 'request' | 'plan' | 'warnings' | 'durationMs' | 'poolTypes'> {
  const n = plan.groups.length;
  type Entry = { group: (string | null)[]; vals: (string | null)[] };
  const index = (rows: Record<string, unknown>[]) => {
    const m = new Map<string, Entry>();
    for (const row of rows) {
      const group: (string | null)[] = [];
      for (let i = 0; i < n; i++) group.push(cell(row[`g_${i}`]));
      const vals = plan.targets.map((t) => {
        const v = cell(row[t.alias]);
        const isFloat = t.agg === 'sum' && plan.measures[t.measure]?.sum?.kind === 'float';
        return isFloat && v !== null ? String(Number(v)) : v;
      });
      m.set(JSON.stringify(group), { group, vals });
    }
    return m;
  };
  const lm = index(left);
  const rm = index(right);
  const nulls = () => plan.targets.map(() => null as string | null);
  const falses = () => plan.targets.map(() => false);

  const all: AggregateRow[] = [];
  let changed = 0, added = 0, removed = 0, matching = 0;
  for (const [key, l] of lm) {
    const r = rm.get(key);
    if (!r) {
      removed++;
      all.push({ kind: 'removed', group: l.group, left: l.vals, right: nulls(), diff: nulls(), differs: falses() });
      continue;
    }
    const cmps = plan.targets.map((_, i) => compareTarget(plan, i, l.vals[i], r.vals[i], tol));
    if (cmps.some((c) => c.differs)) {
      changed++;
      all.push({
        kind: 'changed', group: l.group, left: l.vals, right: r.vals,
        diff: cmps.map((c) => c.diff), differs: cmps.map((c) => c.differs),
      });
    } else matching++;
  }
  for (const [key, r] of rm) {
    if (lm.has(key)) continue;
    added++;
    all.push({ kind: 'added', group: r.group, left: nulls(), right: r.vals, diff: nulls(), differs: falses() });
  }

  const collator = new Intl.Collator(undefined, { numeric: true });
  const sortKey = (g: (string | null)[]) => g.map((v) => v ?? '').join('\u0000');
  all.sort((a, b) => collator.compare(sortKey(a.group), sortKey(b.group)));

  return {
    leftGroups: lm.size,
    rightGroups: rm.size,
    changed, added, removed, matching,
    rows: all.slice(0, detailLimit),
    detailCapped: all.length > detailLimit,
  };
}
