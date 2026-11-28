import { describe, it, expect } from 'vitest';
import sql from 'mssql';
import { openRunner } from '../../src/db/runner';
import { listSchemasQuery, schemaColumnsQuery } from '../../src/sql/queries';
import { diffSchemas, groupSchemaRows, type SchemaColumnRow } from '../../src/schemaCompare/report';

const conn = process.env.TABLEDIFF_TEST_CONN;
if (!conn) throw new Error('TABLEDIFF_TEST_CONN is not set');
const baseConfig = (sql.ConnectionPool as unknown as { parseConnectionString(s: string): sql.config })
  .parseConnectionString(conn);

async function run<T>(database: string, query: string): Promise<T[]> {
  const runner = await openRunner({ ...baseConfig, database }, 600);
  try {
    return (await runner.query(query)) as T[];
  } finally {
    await runner.close();
  }
}

describe('schema compare metadata queries', () => {
  it('lists schemas holding tables or views, without system schemas', async () => {
    const names = (await run<{ name: string }>('tablediff_a', listSchemasQuery())).map((r) => r.name);
    expect(names).toContain('cmp_l');
    expect(names).toContain('dbo');
    expect(names).not.toContain('sys');
    expect(names).not.toContain('guest');
  });

  it('finds exactly the seeded differences between cmp_l and cmp_r', async () => {
    const left = groupSchemaRows(await run<SchemaColumnRow>('tablediff_a', schemaColumnsQuery('cmp_l')));
    const right = groupSchemaRows(await run<SchemaColumnRow>('tablediff_b', schemaColumnsQuery('cmp_r')));
    const findings = diffSchemas(left, right).map((f) => [f.table, f.issue, f.column]);
    expect(findings).toEqual([
      ['t1', 'missing_column', 'note'],
      ['t1', 'extra_column', 'extra'],
      ['t1', 'type_mismatch', 'name'],
      ['t1', 'size_mismatch', 'amt'],
      ['t2', 'missing_table', ''],
      ['t3', 'extra_table', ''],
    ]);
  });
});
