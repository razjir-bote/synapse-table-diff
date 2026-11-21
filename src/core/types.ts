export type PoolType = 'dedicated' | 'serverless' | 'other';
export type Side = 'left' | 'right';
export interface TableRef { profileId: string; database: string; schema: string; name: string }
export interface CompareRequest {
  left: TableRef;
  right: TableRef;
  keyColumns: string[];
  excludedColumns: string[];
  filter?: string;
  ignoreCase: boolean;
  ignoreTrailingSpaces: boolean;
}
export interface ColumnInfo {
  name: string;
  type: string; // lower-case sys.types name
  maxLength: number;
  precision: number;
  scale: number;
  nullable: boolean;
  ordinal: number;
}
export type Family =
  | 'integer' | 'exactDecimal' | 'approxFloat' | 'character' | 'datetime' | 'time'
  | 'datetimeoffset' | 'bit' | 'guid' | 'binary' | 'unsupported';
export type DtPrecision = 'day' | 'minute' | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export interface ColumnNorm {
  family: Exclude<Family, 'unsupported'>;
  decimalScale?: number;
  floatStyle?: 1 | 2;
  dtPrecision?: DtPrecision;
  rtrim: boolean;
  upper: boolean;
}
export interface ColumnPairPlan { name: string; leftName: string; rightName: string; norm: ColumnNorm }
export interface Limits { pairLimit: number; detailLimit: number; inListCap: number; queryTimeoutSeconds: number }
export const DEFAULT_LIMITS: Limits = {
  pairLimit: 2_000_000,
  detailLimit: 100_000,
  inListCap: 5_000,
  queryTimeoutSeconds: 3600,
};

export interface SchemaColumnDiff {
  name: string;
  status: 'same' | 'added' | 'removed' | 'changed';
  left?: ColumnInfo;
  right?: ColumnInfo;
  changes: ('type' | 'nullability' | 'position')[];
}
export interface ExcludedColumn { name: string; reason: string }
export interface SchemaDiff { columns: SchemaColumnDiff[]; differenceCount: number }
export interface ComparePlan { keys: ColumnPairPlan[]; compared: ColumnPairPlan[]; excluded: ExcludedColumn[] }

export interface BucketRow { b: number; cnt: bigint; dk: bigint; s1: string; s2: string } // s1/s2 as decimal strings
export interface BucketCompare {
  mismatched: number[];
  problem: number[]; // cnt != dk on either side, or b = -1
  rowsInScope: number; // sum of cnt over mismatched + problem buckets, both sides
  leftRows: number;
  rightRows: number;
  leftDupRows: number;
  rightDupRows: number;
  leftNullKeyRows: number;
  rightNullKeyRows: number;
}
export type ChangeKind = 'added' | 'removed' | 'changed';
export interface PairRow { kh: Buffer; rh: Buffer; knull: number; b2: number; keys: unknown[] }
export interface DiffKey { kind: ChangeKind; khHex: string; b2: number }
export interface KeyProblems {
  duplicateKeys: { side: Side; key: string[]; count: number }[];
  nullKeys: { side: Side; key: (string | null)[] }[];
  leftDupRows: number;
  rightDupRows: number;
  leftNullKeyRows: number;
  rightNullKeyRows: number;
}
export interface MergeResult {
  added: number;
  removed: number;
  changed: number;
  selected: DiffKey[]; // first detailLimit in kh order
  duplicateSamples: KeyProblems['duplicateKeys'];
  nullKeySamples: KeyProblems['nullKeys'];
}
export interface DiffRow {
  kind: ChangeKind;
  key: string[];
  left?: (string | null)[];
  right?: (string | null)[];
  changedColumns: string[];
}
