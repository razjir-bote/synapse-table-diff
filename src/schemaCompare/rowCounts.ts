import { CompareCancelledError } from '../core/errors';
import type { Finding, SchemaObject } from './report';

export interface TablePair { left: string; right: string }
export interface RowCountResult { table: string; left: bigint | Error; right: bigint | Error }

const lower = (s: string) => s.toLowerCase();

/** Names present on both sides (case-insensitive), with each side's spelling, sorted by left name. */
export function matchedPairs(left: SchemaObject[], right: SchemaObject[]): TablePair[] {
  const rightMap = new Map(right.map((o) => [lower(o.name), o.name]));
  const out: TablePair[] = [];
  for (const l of left) {
    const r = rightMap.get(lower(l.name));
    if (r !== undefined) out.push({ left: l.name, right: r });
  }
  return out.sort((a, b) => (lower(a.left) < lower(b.left) ? -1 : lower(a.left) > lower(b.left) ? 1 : 0));
}

async function countSide(
  count: (side: 'left' | 'right', name: string) => Promise<unknown>, side: 'left' | 'right', name: string,
): Promise<bigint | Error> {
  try {
    return BigInt(String(await count(side, name)));
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/** `count` returns the `cnt` value of one side's count query. At most `limit` tables are in flight. */
export async function countMatchedTables(
  pairs: TablePair[],
  count: (side: 'left' | 'right', name: string) => Promise<unknown>,
  opts: { limit: number; signal?: AbortSignal; onStart?: (index: number, total: number, pair: TablePair) => void },
): Promise<RowCountResult[]> {
  const results: RowCountResult[] = new Array(pairs.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (opts.signal?.aborted) throw new CompareCancelledError();
      const i = next++;
      if (i >= pairs.length) return;
      const pair = pairs[i];
      opts.onStart?.(i, pairs.length, pair);
      const [left, right] = await Promise.all([countSide(count, 'left', pair.left), countSide(count, 'right', pair.right)]);
      if (opts.signal?.aborted) throw new CompareCancelledError();
      results[i] = { table: pair.left, left, right };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.limit, pairs.length || 1)) }, worker));
  return results;
}

/** 1204331n -> '1,204,331', whatever the locale. */
export function formatCount(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const rows = (n: bigint) => `${formatCount(n)} ${n === 1n ? 'row' : 'rows'}`;
const base = (table: string) => ({ table, column: '', leftType: '', rightType: '' });

export function rowCountFindings(results: RowCountResult[]): Finding[] {
  const out: Finding[] = [];
  for (const r of results) {
    if (r.left instanceof Error || r.right instanceof Error) {
      const parts: string[] = [];
      if (r.left instanceof Error) parts.push(`left: ${r.left.message}`);
      if (r.right instanceof Error) parts.push(`right: ${r.right.message}`);
      out.push({ issue: 'row_count_error', ...base(r.table), details: parts.join('; ') });
    } else if (r.left !== r.right) {
      const d = r.left > r.right ? r.left - r.right : r.right - r.left;
      const dir = r.left > r.right ? 'fewer' : 'more';
      out.push({
        issue: 'row_count_mismatch', ...base(r.table),
        details: `left ${rows(r.left)}, right ${rows(r.right)} (${formatCount(d)} ${dir} on the right)`,
      });
    }
  }
  return out;
}
