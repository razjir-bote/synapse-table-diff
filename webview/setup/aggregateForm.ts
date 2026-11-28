import type { ColumnPair, CompareRequest, MeasureSpec } from '../../src/core/types';
import { parseTolerance } from '../../src/core/aggregateCompare';
import { planAggregate } from '../../src/core/aggregatePlan';
import { familyOf } from '../../src/sql/normalize';
import { filterProblem } from '../../src/sql/filterGuard';
import type { SetupState } from './render';

const lc = (s: string) => s.toLowerCase();
const NUMERIC = new Set(['integer', 'exactDecimal', 'approxFloat']);

/** First left column not already used in `existing`; right = same name (case-insensitive) if present, else first right column. */
export function newPair(state: SetupState, existing: ColumnPair[]): ColumnPair {
  const { left, right } = state.sides;
  const used = new Set(existing.map((p) => lc(p.left)));
  const l = left.columns.find((c) => !used.has(lc(c.name))) ?? left.columns[0];
  const r = l ? right.columns.find((c) => lc(c.name) === lc(l.name)) ?? right.columns[0] : undefined;
  return { left: l?.name ?? '', right: r?.name ?? '' };
}

export function isNumericPair(state: SetupState, pair: ColumnPair): boolean {
  const l = state.sides.left.columns.find((c) => lc(c.name) === lc(pair.left));
  const r = state.sides.right.columns.find((c) => lc(c.name) === lc(pair.right));
  return !!l && !!r && NUMERIC.has(familyOf(l)) && NUMERIC.has(familyOf(r));
}

export function newMeasure(state: SetupState): MeasureSpec {
  const pair = newPair(state, state.measures);
  return { ...pair, aggs: isNumericPair(state, pair) ? ['sum', 'count'] : ['count'] };
}

function exists(state: SetupState, p: ColumnPair): boolean {
  return (
    state.sides.left.columns.some((c) => lc(c.name) === lc(p.left)) &&
    state.sides.right.columns.some((c) => lc(c.name) === lc(p.right))
  );
}

/** Drops pairs whose columns are missing on either side. */
export function pruneAggregate(state: SetupState): void {
  state.groupBy = state.groupBy.filter((p) => exists(state, p));
  state.measures = state.measures.filter((p) => exists(state, p));
}

export function aggregateRequest(
  state: SetupState,
): Pick<CompareRequest, 'mode' | 'aggregate' | 'filter' | 'keyColumns' | 'excludedColumns'> {
  const filter = state.filter.trim();
  const tol = state.sumTolerance.trim();
  return {
    mode: 'aggregate',
    keyColumns: [],
    excludedColumns: [],
    filter: filter === '' ? undefined : filter,
    aggregate: {
      groupBy: state.groupBy.map((g) => ({ ...g })),
      measures: state.measures.map((m) => ({ ...m, aggs: [...m.aggs] })),
      sumTolerance: tol === '' ? undefined : tol,
      rightFilter: state.sameFilter ? undefined : state.rightFilter.trim(),
    },
  };
}

export function aggregateProblem(state: SetupState): string | undefined {
  const ref = (s: 'left' | 'right') => {
    const x = state.sides[s];
    return { profileId: x.profileId ?? '', database: x.database ?? '', schema: x.table?.schema ?? '', name: x.table?.name ?? '' };
  };
  const req: CompareRequest = {
    left: ref('left'),
    right: ref('right'),
    ...aggregateRequest(state),
    ignoreCase: state.ignoreCase,
    ignoreTrailingSpaces: state.ignoreTrailingSpaces,
    nullEqualsBlank: state.nullEqualsBlank,
    ignoreDataTypes: state.ignoreDataTypes,
  };
  try {
    planAggregate(state.sides.left.columns, state.sides.right.columns, req);
    parseTolerance(state.sumTolerance);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return filterProblem(state.filter) ?? (state.sameFilter ? undefined : filterProblem(state.rightFilter));
}
