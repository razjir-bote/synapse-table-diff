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
