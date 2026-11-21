import type { ChangeKind, DiffRow } from './types';

export function formatValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return '0x' + v.toString('hex').toUpperCase();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v);
}

function norm(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export function buildDiffRow(
  kind: ChangeKind,
  keyCount: number,
  compared: string[],
  left?: Record<string, unknown>,
  right?: Record<string, unknown>,
): DiffRow {
  const src = left ?? right ?? {};
  const key: string[] = [];
  for (let i = 0; i < keyCount; i++) key.push(formatValue(src[`k_${i}`]) ?? '');
  const cells = (row: Record<string, unknown>) => compared.map((_, i) => formatValue(row[`v_${i}`]));
  const out: DiffRow = { kind, key, changedColumns: [] };
  if (left) out.left = cells(left);
  if (right) out.right = cells(right);
  if (left && right) {
    compared.forEach((name, i) => {
      if (norm(left[`n_${i}`]) !== norm(right[`n_${i}`])) out.changedColumns.push(name);
    });
  }
  return out;
}
