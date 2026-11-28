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
  /** Treat NULL and blank (empty or spaces-only) text as equal in compared columns. Keys are unaffected. */
  nullEqualsBlank?: boolean;
  /**
   * Compare columns whose data types differ instead of excluding them: numbers are compared as numbers where
   * possible, anything else as text (each side converted to a canonical text form).
   */
  ignoreDataTypes?: boolean;
  mode?: CompareMode;
  aggregate?: AggregateSpec;
}

export type CompareMode = 'rows' | 'aggregate';
export interface ColumnPair { left: string; right: string }
export type AggKind = 'sum' | 'count' | 'distinct';
export interface MeasureSpec extends ColumnPair { aggs: AggKind[] }
export interface AggregateSpec {
  groupBy: ColumnPair[];
  measures: MeasureSpec[];
  sumTolerance?: string;
  /** Right side's filter when it differs from `filter`; '' = no right filter; absent = `filter` on both sides. */
  rightFilter?: string;
}

export type SumMode = { kind: 'exact'; scale: number } | { kind: 'float' };
export interface GroupPlan { leftName: string; rightName: string; label: string; norm: ColumnNorm; trailingSignificant: boolean }
export interface MeasurePlan {
  leftName: string; rightName: string; aggs: AggKind[];
  /** Normalization for count/distinct; undefined when the types cannot be planned (count then uses the raw column). */
  norm?: ColumnNorm;
  sum?: SumMode;
}
export interface AggTarget {
  /** e.g. 'Rows', 'amount · sum', 'cust ↔ customer · distinct count' */
  label: string;
  agg: AggKind | 'rows';
  /** -1 for the row count */
  measure: number;
  /** SQL column alias: 'rc' or `m_${measure}_${agg}` */
  alias: string;
}
export interface AggregatePlan { groups: GroupPlan[]; measures: MeasurePlan[]; targets: AggTarget[] }

export interface AggregateRow {
  kind: ChangeKind;            // changed = in both & differs; removed = only left; added = only right
  group: (string | null)[];    // normalized group values (right side's for 'added')
  left: (string | null)[];     // per target; all null for 'added'
  right: (string | null)[];    // per target; all null for 'removed'
  diff: (string | null)[];     // right − left per target; null unless 'changed'
  differs: boolean[];          // per target
}
export interface AggregateResult {
  mode: 'aggregate';
  request: CompareRequest;
  plan: AggregatePlan;
  leftGroups: number; rightGroups: number;
  changed: number; added: number; removed: number; matching: number;
  rows: AggregateRow[];        // sorted by group (numeric-aware collator on group.join('\u0000')), capped at detailLimit
  detailCapped: boolean;
  warnings: string[];
  durationMs: number;
  poolTypes: { left: PoolType; right: PoolType };
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
  /** Character columns only: blank text normalizes to NULL. */
  blankAsNull?: boolean;
  /**
   * Set when the two sides have different types and are compared as text: each side is first rendered with its
   * own type's normalization, then compared as nvarchar(max) with this norm's rtrim/upper/blankAsNull.
   */
  perSide?: { left: ColumnNorm; right: ColumnNorm };
}
export interface ColumnPairPlan {
  name: string;
  leftName: string;
  rightName: string;
  norm: ColumnNorm;
  /** Each side's own column, used for display values (absent in some hand-built test plans). */
  leftCol?: ColumnInfo;
  rightCol?: ColumnInfo;
}
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

export type Stage = 'schema' | 'checksums' | 'rebucket' | 'compare' | 'details' | 'aggregates';
export interface CompareResult {
  mode?: 'rows';
  request: CompareRequest;
  schema: SchemaDiff;
  plan: ComparePlan;
  leftRows: number;
  rightRows: number;
  added: number;
  removed: number;
  changed: number;
  rows: DiffRow[]; // sorted by key, numeric-aware
  detailCapped: boolean;
  keyProblems: KeyProblems;
  warnings: string[];
  durationMs: number;
  poolTypes: { left: PoolType; right: PoolType };
}
