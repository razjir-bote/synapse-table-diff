import type { CompareRequest } from '../../src/core/types';
import type { HostToSetup } from '../../src/ui/protocol';
import { pruneAggregate } from './aggregateForm';
import { defaultKey, sharedColumns, type SetupState } from './render';

const lc = (s: string) => s.toLowerCase();

function applyDescribed(state: SetupState): void {
  const { left, right } = state.sides;
  if (left.columns.length === 0 || right.columns.length === 0) return;
  if (state.pendingAggregate) {
    state.groupBy = state.pendingAggregate.groupBy.map((g) => ({ ...g }));
    state.measures = state.pendingAggregate.measures.map((m) => ({ ...m, aggs: [...m.aggs] }));
    state.pendingAggregate = undefined;
  }
  pruneAggregate(state);
  const shared = new Set(sharedColumns(state).map(lc));
  if (state.pendingInitial) {
    state.keyColumns = state.pendingInitial.keys.filter((k) => shared.has(lc(k)));
    state.excludedColumns = state.pendingInitial.excluded.filter((k) => shared.has(lc(k)));
    state.pendingInitial = undefined;
  } else {
    state.keyColumns = defaultKey(state);
    state.excludedColumns = [];
  }
}

/**
 * Keys/exclusions to restore once the sides are described. Aggregate requests carry no row keys, so they
 * restore nothing here and a later switch to Rows applies the declared default key.
 */
export function initialPending(initial: CompareRequest): SetupState['pendingInitial'] {
  if (initial.mode === 'aggregate') return undefined;
  return { keys: initial.keyColumns, excluded: initial.excludedColumns };
}

/**
 * Applies a host message (other than init) to the state in place. Responses that no longer match the
 * side's current profile/database/table are dropped. Returns true when the state changed.
 */
export function applyHostMessage(state: SetupState, m: HostToSetup): boolean {
  switch (m.type) {
    case 'databases': {
      const s = state.sides[m.side];
      if (s.profileId !== m.profileId) return false;
      s.databases = m.names;
      return true;
    }
    case 'objects': {
      const s = state.sides[m.side];
      if (s.profileId !== m.profileId || s.database !== m.database) return false;
      s.objects = m.objects;
      return true;
    }
    case 'described': {
      const s = state.sides[m.side];
      if (
        s.profileId !== m.ref.profileId ||
        s.database !== m.ref.database ||
        s.table?.schema !== m.ref.schema ||
        s.table?.name !== m.ref.name
      ) {
        return false;
      }
      s.columns = m.columns;
      s.declaredKey = m.declaredKey;
      s.poolType = m.poolType;
      state.error = undefined;
      applyDescribed(state);
      return true;
    }
    case 'error':
      state.error = m.message;
      if (m.side) {
        state.pendingInitial = undefined;
        state.pendingAggregate = undefined;
      }
      return true;
    default:
      return false;
  }
}
