import { CompareCancelledError } from './errors';
import type { DiffKey, MergeResult, PairRow, Side } from './types';
import { formatValue } from './cellDiff';

export { formatValue };

const SAMPLE_CAP = 100;
const CANCEL_EVERY = 10_000;

interface Run { khHex: string; rows: PairRow[] }

/** Reads runs of rows with equal kh from a sorted async source. */
class RunReader {
  private cur: PairRow | undefined;
  private it: AsyncIterator<PairRow>;
  private started = false;
  constructor(src: AsyncIterable<PairRow>, private onRow: () => void) {
    this.it = src[Symbol.asyncIterator]();
  }
  private async pull(): Promise<PairRow | undefined> {
    const r = await this.it.next();
    if (r.done) return undefined;
    this.onRow();
    return r.value;
  }
  async next(): Promise<Run | undefined> {
    if (!this.started) { this.cur = await this.pull(); this.started = true; }
    if (!this.cur) return undefined;
    const khHex = this.cur.kh.toString('hex');
    const rows = [this.cur];
    for (;;) {
      this.cur = await this.pull();
      if (!this.cur || this.cur.kh.toString('hex') !== khHex) break;
      rows.push(this.cur);
    }
    return { khHex, rows };
  }
}

export async function mergePairs(
  left: AsyncIterable<PairRow>,
  right: AsyncIterable<PairRow>,
  detailLimit: number,
  signal?: AbortSignal,
): Promise<MergeResult> {
  const res: MergeResult = { added: 0, removed: 0, changed: 0, selected: [], duplicateSamples: [], nullKeySamples: [] };
  const cancelled = () => new CompareCancelledError('Comparison cancelled');
  if (signal?.aborted) throw cancelled();
  let seen = 0;
  const tick = () => {
    if (++seen % CANCEL_EVERY === 0 && signal?.aborted) throw cancelled();
  };
  const dupSamples: Record<Side, number> = { left: 0, right: 0 };
  const nullSamples: Record<Side, number> = { left: 0, right: 0 };

  // Strips null-key rows (sampling them); returns true if the remaining run is a duplicate.
  const classify = (side: Side, run: Run): boolean => {
    run.rows = run.rows.filter((row) => {
      if (row.knull !== 1) return true;
      if (nullSamples[side] < SAMPLE_CAP) {
        nullSamples[side]++;
        res.nullKeySamples.push({ side, key: row.keys.map(formatValue) });
      }
      return false;
    });
    if (run.rows.length > 1) {
      if (dupSamples[side] < SAMPLE_CAP) {
        dupSamples[side]++;
        res.duplicateSamples.push({ side, key: run.rows[0].keys.map((k) => formatValue(k) ?? ''), count: run.rows.length });
      }
      return true;
    }
    return false;
  };

  const lr = new RunReader(left, tick);
  const rr = new RunReader(right, tick);
  const nextRun = async (rd: RunReader, side: Side): Promise<{ run: Run; dup: boolean } | undefined> => {
    for (;;) {
      const run = await rd.next();
      if (!run) return undefined;
      const dup = classify(side, run);
      if (run.rows.length > 0) return { run, dup };
    }
  };
  const push = (kind: DiffKey['kind'], run: Run) => {
    if (res.selected.length < detailLimit) res.selected.push({ kind, khHex: run.khHex, b2: run.rows[0].b2 });
  };

  let l = await nextRun(lr, 'left');
  let r = await nextRun(rr, 'right');
  while (l || r) {
    const cmp = !l ? 1 : !r ? -1 : l.run.khHex < r.run.khHex ? -1 : l.run.khHex > r.run.khHex ? 1 : 0;
    if (cmp === 0) {
      if (!l!.dup && !r!.dup && !l!.run.rows[0].rh.equals(r!.run.rows[0].rh)) {
        res.changed++;
        push('changed', l!.run);
      }
      l = await nextRun(lr, 'left');
      r = await nextRun(rr, 'right');
    } else if (cmp < 0) {
      if (!l!.dup) { res.removed++; push('removed', l!.run); }
      l = await nextRun(lr, 'left');
    } else {
      if (!r!.dup) { res.added++; push('added', r!.run); }
      r = await nextRun(rr, 'right');
    }
  }
  return res;
}
