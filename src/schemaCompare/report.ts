import type { ColumnInfo } from '../core/types';
import { objectKindOf, type ObjectKind } from '../sql/queries';
import { csvLine } from '../export/csv';

export interface SchemaColumnRow {
  object_name: string; object_type: string; column_name: string; type_name: string;
  max_length: number; precision: number; scale: number; is_nullable: boolean; column_id: number;
}
export interface SchemaObject { name: string; kind: ObjectKind; columns: ColumnInfo[] }
export type IssueType = 'missing_table' | 'extra_table' | 'missing_column' | 'extra_column' | 'type_mismatch' | 'size_mismatch';
export interface Finding { issue: IssueType; table: string; column: string; leftType: string; rightType: string; details: string }

const ISSUE_ORDER: IssueType[] = ['missing_table', 'extra_table', 'missing_column', 'extra_column', 'type_mismatch', 'size_mismatch'];
const ISSUE_LABEL: Record<IssueType, [string, string]> = {
  missing_table: ['missing table', 'missing tables'],
  extra_table: ['extra table', 'extra tables'],
  missing_column: ['missing column', 'missing columns'],
  extra_column: ['extra column', 'extra columns'],
  type_mismatch: ['type mismatch', 'type mismatches'],
  size_mismatch: ['size mismatch', 'size mismatches'],
};

export function groupSchemaRows(rows: SchemaColumnRow[]): SchemaObject[] {
  const map = new Map<string, SchemaObject>();
  for (const r of rows) {
    let o = map.get(r.object_name);
    if (!o) {
      o = { name: r.object_name, kind: objectKindOf(r.object_type), columns: [] };
      map.set(r.object_name, o);
    }
    o.columns.push({
      name: r.column_name,
      type: String(r.type_name).toLowerCase(),
      maxLength: r.max_length,
      precision: r.precision,
      scale: r.scale,
      nullable: r.is_nullable,
      ordinal: r.column_id,
    });
  }
  const out = [...map.values()];
  for (const o of out) o.columns.sort((a, b) => a.ordinal - b.ordinal);
  return out;
}

export function typeText(c: ColumnInfo): string {
  const t = c.type;
  switch (t) {
    case 'char': case 'varchar': case 'binary': case 'varbinary':
      return `${t}(${c.maxLength === -1 ? 'max' : c.maxLength})`;
    case 'nchar': case 'nvarchar':
      return `${t}(${c.maxLength === -1 ? 'max' : c.maxLength / 2})`;
    case 'decimal': case 'numeric':
      return `${t}(${c.precision},${c.scale})`;
    case 'datetime2': case 'time': case 'datetimeoffset':
      return `${t}(${c.scale})`;
    default:
      return t;
  }
}

const key = (s: string) => s.toLowerCase();
const cmp = (a: string, b: string) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

export function diffSchemas(left: SchemaObject[], right: SchemaObject[]): Finding[] {
  const out: Finding[] = [];
  const rightMap = new Map(right.map((o) => [key(o.name), o]));
  const leftKeys = new Set(left.map((o) => key(o.name)));

  for (const l of left) {
    const r = rightMap.get(key(l.name));
    if (!r) {
      out.push({
        issue: 'missing_table', table: l.name, column: '', leftType: '', rightType: '',
        details: `${l.kind} on the left; no table, view or external table with this name on the right`,
      });
      continue;
    }
    const rCols = new Map(r.columns.map((c) => [key(c.name), c]));
    const lKeys = new Set(l.columns.map((c) => key(c.name)));
    for (const lc of l.columns) {
      const rc = rCols.get(key(lc.name));
      if (!rc) {
        out.push({ issue: 'missing_column', table: l.name, column: lc.name, leftType: typeText(lc), rightType: '', details: `not in the right ${r.kind}` });
        continue;
      }
      const lt = typeText(lc);
      const rt = typeText(rc);
      if (key(lc.type) !== key(rc.type)) {
        out.push({ issue: 'type_mismatch', table: l.name, column: lc.name, leftType: lt, rightType: rt, details: '' });
      } else if (lt !== rt) {
        out.push({ issue: 'size_mismatch', table: l.name, column: lc.name, leftType: lt, rightType: rt, details: `${lt} vs ${rt}` });
      }
    }
    for (const rc of r.columns) {
      if (!lKeys.has(key(rc.name))) {
        out.push({ issue: 'extra_column', table: l.name, column: rc.name, leftType: '', rightType: typeText(rc), details: `not in the left ${l.kind}` });
      }
    }
  }
  for (const r of right) {
    if (!leftKeys.has(key(r.name))) {
      out.push({ issue: 'extra_table', table: r.name, column: '', leftType: '', rightType: '', details: `${r.kind} on the right; not on the left` });
    }
  }
  return out.sort(
    (a, b) => cmp(a.table, b.table) || ISSUE_ORDER.indexOf(a.issue) - ISSUE_ORDER.indexOf(b.issue) || cmp(a.column, b.column),
  );
}

export function schemaReportCsv(findings: Finding[]): string {
  let s = '﻿' + csvLine(['issue', 'table', 'column', 'left_type', 'right_type', 'details', 'status']);
  for (const f of findings) s += csvLine([f.issue, f.table, f.column, f.leftType, f.rightType, f.details, '']);
  return s;
}

export function reportSummary(findings: Finding[]): string {
  if (findings.length === 0) return 'No differences found.';
  const parts: string[] = [];
  for (const i of ISSUE_ORDER) {
    const n = findings.filter((f) => f.issue === i).length;
    if (n > 0) parts.push(`${n} ${ISSUE_LABEL[i][n === 1 ? 0 : 1]}`);
  }
  const total = findings.length;
  return `${total} ${total === 1 ? 'finding' : 'findings'}: ${parts.join(', ')}`;
}

export function reportFileName(
  l: { database: string; schema: string }, r: { database: string; schema: string }, now: Date,
): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `schema-diff_${l.database}.${l.schema}_vs_${r.database}.${r.schema}_${stamp}.csv`;
}
