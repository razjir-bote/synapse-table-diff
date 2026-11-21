import type { QueryRunner, SideConnector } from '../db/runner';
import { bucketQuery, columnsQuery, detailQuery, pairQuery, type BucketFilter } from '../sql/queries';
import { compareBuckets } from './buckets';
import { buildDiffRow } from './cellDiff';
import { CompareCancelledError } from './errors';
import { mergePairs } from './merge';
import { diffSchema } from './schemaDiff';
import type {
  BucketCompare, BucketRow, ChangeKind, ColumnInfo, ComparePlan, CompareRequest, CompareResult, DiffKey, DiffRow,
  KeyProblems, Limits, PairRow, Side, Stage, TableRef,
} from './types';

export interface PipelineDeps {
  left: SideConnector;
  right: SideConnector;
  limits: Limits;
  signal?: AbortSignal;
  onProgress?: (stage: Stage, detail?: string) => void;
  confirmExtraScan?: (serverlessSides: Side[]) => Promise<boolean>;
}

export const KEY_PROBLEM_WARNING =
  'Duplicate or NULL keys found; those keys are excluded, so the data diff is incomplete for them.';

type Runners = Record<Side, QueryRunner>;
const SIDES: Side[] = ['left', 'right'];

function cancelled(): CompareCancelledError {
  return new CompareCancelledError('Comparison cancelled');
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

/** Opens both sides in parallel, runs `fn`, and always closes whatever was opened. */
async function withRunners<T>(deps: PipelineDeps, fn: (r: Runners) => Promise<T>): Promise<T> {
  checkAbort(deps.signal);
  const opened = await Promise.allSettled([deps.left.open(), deps.right.open()]);
  const close = async () => {
    await Promise.allSettled(
      opened.map((o) => (o.status === 'fulfilled' ? o.value.close() : Promise.resolve())),
    );
  };
  try {
    for (const o of opened) if (o.status === 'rejected') throw o.reason;
    const runners: Runners = {
      left: (opened[0] as PromiseFulfilledResult<QueryRunner>).value,
      right: (opened[1] as PromiseFulfilledResult<QueryRunner>).value,
    };
    checkAbort(deps.signal);
    return await fn(runners);
  } finally {
    await close();
  }
}

function toColumn(r: Record<string, unknown>): ColumnInfo {
  return {
    name: String(r.name),
    type: String(r.type_name).toLowerCase(),
    maxLength: Number(r.max_length),
    precision: Number(r.precision),
    scale: Number(r.scale),
    nullable: Boolean(r.is_nullable),
    ordinal: Number(r.column_id),
  };
}

function toBucket(r: Record<string, unknown>, level: 1 | 2): BucketRow {
  return {
    b: Number(level === 1 ? r.b1 : r.b2),
    cnt: BigInt(String(r.cnt)),
    dk: BigInt(String(r.dk)),
    s1: String(r.s1),
    s2: String(r.s2),
  };
}

async function* toPairs(src: AsyncIterable<Record<string, unknown>>, keyCount: number): AsyncIterable<PairRow> {
  for await (const r of src) {
    const keys: unknown[] = [];
    for (let i = 0; i < keyCount; i++) keys.push(r[`k_${i}`]);
    yield { kh: r.kh as Buffer, rh: r.rh as Buffer, knull: Number(r.knull), b2: Number(r.b2), keys };
  }
}

const uniqSorted = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

/** Level-1 parent ids of level-2 ids (keeps -1 as -1). */
const parents = (ids: number[]) => uniqSorted(ids.map((b) => (b === -1 ? -1 : Math.floor(b / 256))));

/** Bucket filter at `level`, falling back to level 1 and then to no filter when the list is too long. */
function capFilter(level: 1 | 2, ids: number[], cap: number): BucketFilter {
  if (level === 2 && ids.length > cap) return capFilter(1, parents(ids), cap);
  if (ids.length > cap) return { level: 1, ids: [] }; // empty list = whole table
  return { level, ids };
}

export async function runComparison(req: CompareRequest, deps: PipelineDeps): Promise<CompareResult> {
  const started = Date.now();
  const { signal, limits } = deps;
  const progress = (stage: Stage, detail?: string) => deps.onProgress?.(stage, detail);
  const tables: Record<Side, TableRef> = { left: req.left, right: req.right };
  const poolTypes = { left: deps.left.poolType, right: deps.right.poolType };

  try {
    // 1. schema
    progress('schema');
    const cols = await withRunners(deps, async (r) => {
      const [l, rr] = await Promise.all(SIDES.map((s) => r[s].query(columnsQuery(tables[s]), signal)));
      return { left: l.map(toColumn), right: rr.map(toColumn) };
    });
    checkAbort(signal);
    const { schema, plan } = diffSchema(cols.left, cols.right, req);

    // 2. level-1 checksums
    progress('checksums');
    const bucketsAt = (level: 1 | 2, within?: BucketFilter) =>
      withRunners(deps, async (r) => {
        const [l, rr] = await Promise.all(
          SIDES.map((s) => r[s].query(bucketQuery(plan, s, tables[s], req.filter, level, within), signal)),
        );
        return compareBuckets(l.map((x) => toBucket(x, level)), rr.map((x) => toBucket(x, level)));
      });
    const l1 = await bucketsAt(1);
    checkAbort(signal);

    const keyProblemsBase = (bc: BucketCompare): KeyProblems => ({
      duplicateKeys: [],
      nullKeys: [],
      leftDupRows: bc.leftDupRows,
      rightDupRows: bc.rightDupRows,
      leftNullKeyRows: bc.leftNullKeyRows,
      rightNullKeyRows: bc.rightNullKeyRows,
    });
    const base = {
      request: req, schema, plan, leftRows: l1.leftRows, rightRows: l1.rightRows, poolTypes,
    };

    if (l1.mismatched.length === 0 && l1.problem.length === 0) {
      return {
        ...base, added: 0, removed: 0, changed: 0, rows: [], detailCapped: false,
        keyProblems: keyProblemsBase(l1), warnings: [], durationMs: Date.now() - started,
      };
    }

    // 3. optional level-2 re-bucketing
    const l1Ids = uniqSorted([...l1.mismatched, ...l1.problem]);
    let pairFilter = capFilter(1, l1Ids, limits.inListCap);
    if (l1.rowsInScope > limits.pairLimit) {
      const serverless = SIDES.filter((s) => deps[s].poolType === 'serverless');
      const go = serverless.length === 0 || !deps.confirmExtraScan || (await deps.confirmExtraScan(serverless));
      checkAbort(signal);
      const within = l1Ids.filter((b) => b !== -1);
      if (go && within.length > 0) {
        progress('rebucket');
        const l2 = await bucketsAt(2, capFilter(1, within, limits.inListCap));
        checkAbort(signal);
        const l2Ids = [...l2.mismatched, ...l2.problem];
        if (l1Ids.includes(-1)) l2Ids.push(-1);
        pairFilter = capFilter(2, uniqSorted(l2Ids), limits.inListCap);
      }
    }

    // 4. pair compare
    progress('compare');
    const merge = await withRunners(deps, (r) =>
      mergePairs(
        toPairs(r.left.stream(pairQuery(plan, 'left', tables.left, req.filter, pairFilter), signal), plan.keys.length),
        toPairs(r.right.stream(pairQuery(plan, 'right', tables.right, req.filter, pairFilter), signal), plan.keys.length),
        limits.detailLimit,
        signal,
      ));
    checkAbort(signal);

    // 5. details
    const rows = merge.selected.length > 0 ? await fetchDetails(req, plan, merge.selected, tables, deps, progress) : [];
    checkAbort(signal);

    // 6. result
    const total = merge.added + merge.removed + merge.changed;
    const detailCapped = rows.length < total;
    const keyProblems: KeyProblems = {
      ...keyProblemsBase(l1),
      duplicateKeys: merge.duplicateSamples,
      nullKeys: merge.nullKeySamples,
    };
    const warnings: string[] = [];
    const hasKeyProblems = keyProblems.leftDupRows + keyProblems.rightDupRows + keyProblems.leftNullKeyRows
      + keyProblems.rightNullKeyRows > 0 || merge.duplicateSamples.length > 0 || merge.nullKeySamples.length > 0;
    if (hasKeyProblems) warnings.push(KEY_PROBLEM_WARNING);
    if (detailCapped) warnings.push(`Showing the first ${rows.length} of ${total} differing rows.`);

    return {
      ...base,
      added: merge.added,
      removed: merge.removed,
      changed: merge.changed,
      rows,
      detailCapped,
      keyProblems,
      warnings,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    if (signal?.aborted && !(err instanceof CompareCancelledError)) throw cancelled();
    throw err;
  }
}

async function fetchDetails(
  req: CompareRequest,
  plan: ComparePlan,
  selected: DiffKey[],
  tables: Record<Side, TableRef>,
  deps: PipelineDeps,
  progress: (stage: Stage, detail?: string) => void,
): Promise<DiffRow[]> {
  const { signal, limits } = deps;
  progress('details');
  const expected: Record<Side, Set<string>> = { left: new Set(), right: new Set() };
  for (const k of selected) {
    if (k.kind !== 'added') expected.left.add(k.khHex);
    if (k.kind !== 'removed') expected.right.add(k.khHex);
  }
  const filter = capFilter(2, uniqSorted(selected.map((k) => k.b2)), limits.inListCap);

  const found = await withRunners(deps, async (r) => {
    const collect = async (side: Side): Promise<Map<string, Record<string, unknown>>> => {
      const want = expected[side];
      const out = new Map<string, Record<string, unknown>>();
      if (want.size === 0) return out;
      const q = detailQuery(plan, side, tables[side], req.filter, filter);
      for await (const row of r[side].stream<Record<string, unknown>>(q, signal)) {
        const hex = (row.kh as Buffer).toString('hex');
        if (want.has(hex) && !out.has(hex)) {
          out.set(hex, row);
          if (out.size === want.size) break;
        }
      }
      return out;
    };
    const [left, right] = await Promise.all([collect('left'), collect('right')]);
    return { left, right };
  });

  const compared = plan.compared.map((c) => c.name);
  const keyCount = plan.keys.length;
  const rows: DiffRow[] = [];
  for (const k of selected) {
    const kind: ChangeKind = k.kind;
    const left = kind !== 'added' ? found.left.get(k.khHex) : undefined;
    const right = kind !== 'removed' ? found.right.get(k.khHex) : undefined;
    // A row can vanish if the table changed between passes; it is still counted but has no detail.
    if ((kind !== 'added' && !left) || (kind !== 'removed' && !right)) continue;
    rows.push(buildDiffRow(kind, keyCount, compared, left, right));
  }
  const collator = new Intl.Collator(undefined, { numeric: true });
  const sortKey = (row: DiffRow) => row.key.join('\u0000');
  return rows.sort((a, b) => collator.compare(sortKey(a), sortKey(b)));
}
