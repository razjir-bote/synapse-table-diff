import type { CompareRequest, Side } from '../../src/core/types';
import type { HostToSetup, SetupToHost } from '../../src/ui/protocol';
import { aggregateRequest, isNumericPair, newMeasure, newPair } from './aggregateForm';
import { applyHostMessage, initialPending } from './reducer';
import { canRun, excludeAllColumns, renderSetup, type SetupActions, type SetupState } from './render';

declare function acquireVsCodeApi(): { postMessage(m: SetupToHost): void };
const vscode = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLElement;

const emptySide = (): SetupState['sides']['left'] => ({ databases: [], objects: [], columns: [], declaredKey: [] });
let state: SetupState = {
  profiles: [],
  sides: { left: emptySide(), right: emptySide() },
  keyColumns: [],
  excludedColumns: [],
  filter: '',
  ignoreCase: false,
  ignoreTrailingSpaces: false,
  nullEqualsBlank: false,
  ignoreDataTypes: false,
  mode: 'rows',
  groupBy: [],
  measures: [],
  sumTolerance: '',
  sameFilter: true,
  rightFilter: '',
};
const lc = (s: string) => s.toLowerCase();
const post = (m: SetupToHost) => vscode.postMessage(m);
const draw = () => renderSetup(root, state, actions);

function resetColumns(): void {
  if (state.mode === 'aggregate') return; // pairs are pruned after the sides are described
  state.pendingInitial = undefined;
  state.keyColumns = [];
  state.excludedColumns = [];
}

const actions: SetupActions = {
  onProfile(side, profileId) {
    state.sides[side] = { ...emptySide(), profileId: profileId || undefined };
    resetColumns();
    if (profileId) post({ type: 'listDatabases', side, profileId });
    draw();
  },
  onDatabase(side, database) {
    const s = state.sides[side];
    state.sides[side] = { ...emptySide(), profileId: s.profileId, databases: s.databases, database: database || undefined };
    resetColumns();
    if (database && s.profileId) post({ type: 'listObjects', side, profileId: s.profileId, database });
    draw();
  },
  onTable(side, table) {
    const s = state.sides[side];
    s.table = table;
    s.columns = [];
    s.declaredKey = [];
    s.poolType = undefined;
    resetColumns();
    if (table && s.profileId && s.database) {
      post({ type: 'describe', side, ref: { profileId: s.profileId, database: s.database, schema: table.schema, name: table.name } });
    }
    draw();
  },
  onToggleKey(col, on) {
    state.keyColumns = state.keyColumns.filter((c) => lc(c) !== lc(col));
    if (on) {
      state.keyColumns.push(col);
      state.excludedColumns = state.excludedColumns.filter((c) => lc(c) !== lc(col));
    }
    draw();
  },
  onToggleExclude(col, on) {
    state.excludedColumns = state.excludedColumns.filter((c) => lc(c) !== lc(col));
    if (on) state.excludedColumns.push(col);
    draw();
  },
  onFilter(text) {
    state.filter = text;
  },
  onIgnoreCase(on) {
    state.ignoreCase = on;
  },
  onIgnoreTrailing(on) {
    state.ignoreTrailingSpaces = on;
  },
  onNullEqualsBlank(on) {
    state.nullEqualsBlank = on;
  },
  onIgnoreDataTypes(on) {
    state.ignoreDataTypes = on;
  },
  onExcludeAll(on) {
    state.excludedColumns = excludeAllColumns(state, on);
    draw();
  },
  onMode(mode) {
    state.mode = mode;
    draw();
  },
  onAddGroup() {
    state.groupBy.push(newPair(state, state.groupBy));
    draw();
  },
  onGroup(i, side, col) {
    if (state.groupBy[i]) state.groupBy[i][side] = col;
    draw();
  },
  onRemoveGroup(i) {
    state.groupBy.splice(i, 1);
    draw();
  },
  onAddMeasure() {
    state.measures.push(newMeasure(state));
    draw();
  },
  onMeasure(i, side, col) {
    const m = state.measures[i];
    if (m) {
      m[side] = col;
      if (!isNumericPair(state, m)) m.aggs = m.aggs.filter((a) => a !== 'sum');
    }
    draw();
  },
  onMeasureAgg(i, agg, on) {
    const m = state.measures[i];
    if (m) {
      m.aggs = m.aggs.filter((a) => a !== agg);
      if (on) m.aggs.push(agg);
    }
    draw();
  },
  onRemoveMeasure(i) {
    state.measures.splice(i, 1);
    draw();
  },
  onSumTolerance(text) {
    state.sumTolerance = text; // render refreshes the Run button itself; redrawing would drop input focus
  },
  onSameFilter(on) {
    state.sameFilter = on;
    draw();
  },
  onRightFilter(text) {
    state.rightFilter = text;
  },
  onRun() {
    if (!canRun(state).ok) return;
    const l = state.sides.left;
    const r = state.sides.right;
    const request: CompareRequest = {
      left: { profileId: l.profileId!, database: l.database!, schema: l.table!.schema, name: l.table!.name },
      right: { profileId: r.profileId!, database: r.database!, schema: r.table!.schema, name: r.table!.name },
      ...(state.mode === 'aggregate'
        ? aggregateRequest(state)
        : {
            keyColumns: [...state.keyColumns],
            excludedColumns: [...state.excludedColumns],
            filter: state.filter.trim() === '' ? undefined : state.filter,
          }),
      ignoreCase: state.ignoreCase,
      ignoreTrailingSpaces: state.ignoreTrailingSpaces,
      nullEqualsBlank: state.nullEqualsBlank,
      ignoreDataTypes: state.ignoreDataTypes,
    };
    post({ type: 'run', request });
  },
};

function init(profiles: { id: string; name: string }[], initial?: CompareRequest): void {
  state.profiles = profiles;
  if (!initial) {
    draw();
    return;
  }
  state = {
    profiles,
    sides: { left: emptySide(), right: emptySide() },
    keyColumns: [...initial.keyColumns],
    excludedColumns: [...initial.excludedColumns],
    filter: initial.filter ?? '',
    ignoreCase: initial.ignoreCase,
    ignoreTrailingSpaces: initial.ignoreTrailingSpaces,
    nullEqualsBlank: initial.nullEqualsBlank === true,
    ignoreDataTypes: initial.ignoreDataTypes === true,
    mode: initial.mode === 'aggregate' ? 'aggregate' : 'rows',
    groupBy: [],
    measures: [],
    sumTolerance: initial.aggregate?.sumTolerance ?? '',
    sameFilter: initial.aggregate?.rightFilter === undefined,
    rightFilter: initial.aggregate?.rightFilter ?? '',
  };
  if (initial.mode === 'aggregate' && initial.aggregate) state.pendingAggregate = initial.aggregate;
  state.pendingInitial = initialPending(initial);
  for (const side of ['left', 'right'] as Side[]) {
    const t = initial[side];
    state.sides[side].profileId = t.profileId;
    state.sides[side].database = t.database;
    state.sides[side].table = { schema: t.schema, name: t.name };
    post({ type: 'listDatabases', side, profileId: t.profileId });
    post({ type: 'listObjects', side, profileId: t.profileId, database: t.database });
    post({ type: 'describe', side, ref: t });
  }
  draw();
}

window.addEventListener('message', (e: MessageEvent<HostToSetup>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      init(m.profiles, m.initial);
      break;
    default:
      if (applyHostMessage(state, m)) draw();
      break;
  }
});

draw();
post({ type: 'ready' });
