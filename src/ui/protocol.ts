import type { ColumnInfo, CompareRequest, PoolType, Side, TableRef } from '../core/types';

export type SetupToHost =
  | { type: 'ready' }
  | { type: 'listDatabases'; side: Side; profileId: string }
  | { type: 'listObjects'; side: Side; profileId: string; database: string }
  | { type: 'describe'; side: Side; ref: TableRef }
  | { type: 'run'; request: CompareRequest };

export type HostToSetup =
  | { type: 'init'; profiles: { id: string; name: string }[]; initial?: CompareRequest }
  | { type: 'databases'; side: Side; names: string[] }
  | { type: 'objects'; side: Side; objects: { schema: string; name: string; kind: 'table' | 'view' }[] }
  | { type: 'described'; side: Side; columns: ColumnInfo[]; declaredKey: string[]; poolType: PoolType }
  | { type: 'error'; message: string };
