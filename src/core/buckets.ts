import type { BucketRow, BucketCompare } from './types';

const ZERO = { cnt: 0n, dk: 0n, s1: '0', s2: '0' };

function index(rows: BucketRow[]): Map<number, BucketRow> {
  const m = new Map<number, BucketRow>();
  for (const r of rows) m.set(Number(r.b), r);
  return m;
}

export function compareBuckets(left: BucketRow[], right: BucketRow[]): BucketCompare {
  const l = index(left);
  const r = index(right);
  const ids = new Set<number>([...l.keys(), ...r.keys()]);
  const mismatched: number[] = [];
  const problem: number[] = [];
  let rowsInScope = 0;
  const out: BucketCompare = {
    mismatched, problem, rowsInScope: 0, leftRows: 0, rightRows: 0,
    leftDupRows: 0, rightDupRows: 0, leftNullKeyRows: 0, rightNullKeyRows: 0,
  };

  for (const row of left) {
    out.leftRows += Number(row.cnt);
    if (Number(row.b) === -1) out.leftNullKeyRows += Number(row.cnt);
    else out.leftDupRows += Number(row.cnt - row.dk);
  }
  for (const row of right) {
    out.rightRows += Number(row.cnt);
    if (Number(row.b) === -1) out.rightNullKeyRows += Number(row.cnt);
    else out.rightDupRows += Number(row.cnt - row.dk);
  }

  for (const b of ids) {
    const a = l.get(b) ?? ZERO;
    const c = r.get(b) ?? ZERO;
    const isProblem = b === -1 || a.cnt !== a.dk || c.cnt !== c.dk;
    const equal = a.cnt === c.cnt && a.dk === c.dk && String(a.s1) === String(c.s1) && String(a.s2) === String(c.s2);
    if (isProblem) problem.push(b);
    else if (!equal) mismatched.push(b);
    else continue;
    rowsInScope += Number(a.cnt) + Number(c.cnt);
  }
  mismatched.sort((x, y) => x - y);
  problem.sort((x, y) => x - y);
  out.rowsInScope = rowsInScope;
  return out;
}
