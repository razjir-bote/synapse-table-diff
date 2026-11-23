import { describe, it, expect } from 'vitest';
import { diffSchema } from '../../src/core/schemaDiff';
import { ComparePlanError } from '../../src/core/errors';
import type { ColumnInfo, CompareRequest } from '../../src/core/types';

function col(name: string, type: string, o: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, type, maxLength: 0, precision: 0, scale: 0, nullable: true, ordinal: 0, ...o };
}
function ordered(cols: ColumnInfo[]): ColumnInfo[] {
  return cols.map((c, i) => ({ ...c, ordinal: i + 1 }));
}
const ref = { profileId: 'p', database: 'd', schema: 's', name: 't' };
function req(o: Partial<CompareRequest> = {}): CompareRequest {
  return {
    left: ref, right: ref, keyColumns: ['id'], excludedColumns: [],
    ignoreCase: false, ignoreTrailingSpaces: false, ...o,
  };
}

const left = ordered([
  col('id', 'int', { nullable: false }),
  col('amount', 'decimal', { precision: 10, scale: 2 }),
  col('code', 'varchar', { maxLength: 10 }),
  col('created', 'datetime2', { scale: 3 }),
  col('note', 'nvarchar', { maxLength: 100 }),
  col('status', 'varchar', { maxLength: 10 }),
  col('load_ts', 'datetime2', { scale: 7 }),
  col('qty', 'varchar', { maxLength: 10 }),
  col('legacy_flag', 'bit'),
]);
const right = ordered([
  col('ID', 'int', { nullable: false }),
  col('amount', 'decimal', { precision: 12, scale: 4 }),
  col('code', 'varchar', { maxLength: 10 }),
  col('created', 'datetime2', { scale: 3 }),
  col('note', 'nvarchar', { maxLength: 100 }),
  col('status', 'varchar', { maxLength: 10 }),
  col('load_ts', 'datetime2', { scale: 7 }),
  col('qty', 'int'),
  col('region', 'varchar', { maxLength: 5 }),
]);
const r = () => req({ excludedColumns: ['load_ts'] });
const find = (res: ReturnType<typeof diffSchema>, n: string) =>
  res.schema.columns.find((c) => c.name.toLowerCase() === n)!;

describe('diffSchema', () => {
  it('matches names case-insensitively and plans the key', () => {
    const res = diffSchema(left, right, r());
    expect(find(res, 'id').status).toBe('same');
    expect(res.plan.keys).toHaveLength(1);
    expect(res.plan.keys[0]).toMatchObject({ name: 'id', leftName: 'id', rightName: 'ID' });
  });

  it('reports added and removed columns', () => {
    const res = diffSchema(left, right, r());
    expect(find(res, 'region')).toMatchObject({ status: 'added', changes: [] });
    expect(find(res, 'legacy_flag')).toMatchObject({ status: 'removed', changes: [] });
  });

  it('flags type changes but keeps the column compared', () => {
    const res = diffSchema(left, right, r());
    expect(find(res, 'amount')).toMatchObject({ status: 'changed', changes: ['type'] });
    expect(res.plan.compared.map((c) => c.name)).toContain('amount');
  });

  it('excludes incompatible columns with the planner reason', () => {
    const res = diffSchema(left, right, r());
    expect(find(res, 'qty').status).toBe('changed');
    expect(res.plan.excluded).toContainEqual({ name: 'qty', reason: 'incompatible types varchar vs int' });
    expect(res.plan.compared.map((c) => c.name)).not.toContain('qty');
  });

  it('excludes user-excluded columns', () => {
    const res = diffSchema(left, right, r());
    expect(res.plan.excluded).toContainEqual({ name: 'load_ts', reason: 'excluded by user' });
  });

  it('sorts compared columns by lower-case name', () => {
    const res = diffSchema(left, right, r());
    expect(res.plan.compared.map((c) => c.name)).toEqual(['amount', 'code', 'created', 'note', 'status']);
  });

  it('detects nullability and position changes', () => {
    const l = ordered([col('id', 'int'), col('a', 'int'), col('b', 'int')]);
    const rr = ordered([col('id', 'int'), col('b', 'int', { nullable: false }), col('a', 'int')]);
    const res = diffSchema(l, rr, req());
    expect(find(res, 'a')).toMatchObject({ status: 'changed', changes: ['position'] });
    expect(find(res, 'b')).toMatchObject({ status: 'changed', changes: ['nullability', 'position'] });
    expect(res.schema.differenceCount).toBe(2);
  });

  it('counts non-same columns', () => {
    const res = diffSchema(left, right, r());
    // amount, qty, legacy_flag, region (+ position shifts: none before region/legacy_flag)
    expect(res.schema.differenceCount).toBe(
      res.schema.columns.filter((c) => c.status !== 'same').length,
    );
    expect(res.schema.differenceCount).toBe(4);
  });

  it('throws when a key column is missing on a side', () => {
    const l = ordered([col('order_id', 'int'), col('x', 'int')]);
    const rr = ordered([col('x', 'int')]);
    expect(() => diffSchema(l, rr, req({ keyColumns: ['order_id'] }))).toThrow(ComparePlanError);
    expect(() => diffSchema(l, rr, req({ keyColumns: ['order_id'] }))).toThrow(/order_id/);
  });

  it('throws for incompatible, excluded or empty keys', () => {
    expect(() => diffSchema(left, right, req({ keyColumns: ['qty'] }))).toThrow(/qty.*incompatible types varchar vs int/);
    expect(() => diffSchema(left, right, req({ keyColumns: ['id'], excludedColumns: ['ID'] }))).toThrow(/id/);
    expect(() => diffSchema(left, right, req({ keyColumns: [] }))).toThrow(ComparePlanError);
  });

  it('keeps key order as requested', () => {
    const res = diffSchema(left, right, req({ keyColumns: ['code', 'id'] }));
    expect(res.plan.keys.map((k) => k.name)).toEqual(['code', 'id']);
    expect(res.plan.compared.map((c) => c.name)).not.toContain('id');
  });

  it('does not flag position when columns are only added or removed', () => {
    const l = ordered([col('id', 'int'), col('a', 'int'), col('b', 'int')]);
    const rr = ordered([col('region', 'int'), col('id', 'int'), col('a', 'int'), col('b', 'int')]);
    const res = diffSchema(l, rr, req());
    expect(find(res, 'region').status).toBe('added');
    for (const n of ['id', 'a', 'b']) expect(find(res, n)).toMatchObject({ status: 'same', changes: [] });
    expect(res.schema.differenceCount).toBe(1);
    const res2 = diffSchema(rr, l, req());
    expect(find(res2, 'a').status).toBe('same');
  });

  it('rejects duplicate key columns case-insensitively', () => {
    expect(() => diffSchema(left, right, req({ keyColumns: ['id', 'ID'] }))).toThrow(ComparePlanError);
    expect(() => diffSchema(left, right, req({ keyColumns: ['id', 'ID'] }))).toThrow(/more than once/);
  });
});

describe('diffSchema nullEqualsBlank', () => {
  it('applies to compared columns but never to keys', () => {
    const cols = ordered([col('code', 'varchar'), col('note', 'nvarchar')]);
    const { plan } = diffSchema(cols, cols, req({ keyColumns: ['code'], nullEqualsBlank: true }));
    expect(plan.keys[0].norm.blankAsNull).toBeUndefined();
    expect(plan.compared.find((c) => c.name === 'note')?.norm.blankAsNull).toBe(true);
  });
});
