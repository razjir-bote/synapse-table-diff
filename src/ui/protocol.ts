import type { ChangeKind, ColumnInfo, CompareRequest, CompareResult, DiffRow, PoolType, Side, TableRef } from '../core/types';

export type SetupToHost =
  | { type: 'ready' }
  | { type: 'listDatabases'; side: Side; profileId: string }
  | { type: 'listObjects'; side: Side; profileId: string; database: string }
  | { type: 'describe'; side: Side; ref: TableRef }
  | { type: 'run'; request: CompareRequest };

export type HostToSetup =
  | { type: 'init'; profiles: { id: string; name: string }[]; initial?: CompareRequest }
  | { type: 'databases'; side: Side; profileId: string; names: string[] }
  | { type: 'objects'; side: Side; profileId: string; database: string; objects: { schema: string; name: string; kind: 'table' | 'view' }[] }
  | { type: 'described'; side: Side; ref: TableRef; columns: ColumnInfo[]; declaredKey: string[]; poolType: PoolType }
  | { type: 'error'; message: string; side?: Side };

export type ResultsToHost =
  | { type: 'ready' }
  | { type: 'page'; kind: ChangeKind | 'all'; offset: number; limit: number }
  | { type: 'openDiff' }
  | { type: 'exportCsv' };

export type HostToResults =
  | { type: 'summary'; summary: Omit<CompareResult, 'rows'>; totalByKind: Record<ChangeKind | 'all', number> /* of rows held */ }
  | { type: 'rows'; kind: ChangeKind | 'all'; offset: number; rows: DiffRow[] };
