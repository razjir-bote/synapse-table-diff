import { describe, it, expect } from 'vitest';
import sql from 'mssql';
import { openRunner } from '../../src/db/runner';
import { countRowsQuery, listSchemasQuery, schemaColumnsQuery } from '../../src/sql/queries';
import { countMatchedTables, matchedPairs, rowCountFindings } from '../../src/schemaCompare/rowCounts';
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
  it('lists user schemas, including empty ones, without system schemas', async () => {
    const names = (await run<{ name: string }>('tablediff_a', listSchemasQuery())).map((r) => r.name);
    expect(names).toContain('cmp_l');
    expect(names).toContain('dbo');
    expect(names).not.toContain('sys');
    expect(names).not.toContain('guest');
    expect(names).not.toContain('INFORMATION_SCHEMA');
    expect(names).not.toContain('db_owner');
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

  it('counts matched tables and reports mismatches and failing views', async () => {
    const left = groupSchemaRows(await run<SchemaColumnRow>('tablediff_a', schemaColumnsQuery('cmp_l')));
    const right = groupSchemaRows(await run<SchemaColumnRow>('tablediff_b', schemaColumnsQuery('cmp_r')));
    const results = await countMatchedTables(
      matchedPairs(left, right),
      (side, name) =>
        run<{ cnt: unknown }>(
          side === 'left' ? 'tablediff_a' : 'tablediff_b',
          countRowsQuery({ schema: side === 'left' ? 'cmp_l' : 'cmp_r', name }),
        ).then((r) => r[0].cnt),
      { limit: 4 },
    );
    expect(results.find((r) => r.table === 't4')).toEqual({ table: 't4', left: 2n, right: 2n });
    const findings = rowCountFindings(results);
    expect(findings.map((f) => [f.table, f.issue])).toEqual([
      ['t1', 'row_count_mismatch'],
      ['v1', 'row_count_mismatch'],
      ['v2', 'row_count_error'],
    ]);
    expect(findings[0].details).toBe('left 3 rows, right 2 rows (1 fewer on the right)');
    expect(findings[2].details.startsWith('right: ')).toBe(true);
  });
});
