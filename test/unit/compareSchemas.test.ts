import { describe, it, expect } from 'vitest';
import { runSchemaCompare, type SchemaCompareEnv, type SchemaSide } from '../../src/commands/compareSchemas';
import { listDatabasesQuery, listSchemasQuery, schemaColumnsQuery } from '../../src/sql/queries';
import { reportFileName, reportSummary, schemaReportCsv, diffSchemas, groupSchemaRows } from '../../src/schemaCompare/report';

const col = (object_name: string, column_name: string, type_name = 'int') => ({
  object_name, object_type: 'U ', column_name, type_name,
  max_length: 4, precision: 10, scale: 0, is_nullable: false, column_id: 1,
});

function makeEnv(over: Partial<SchemaCompareEnv> & { answers?: (string | undefined)[]; rows?: Record<string, unknown[]> } = {}) {
  const calls: string[] = [];
  const picks: { items: unknown; placeHolder: string; preferred?: string }[] = [];
  const queries: { side: { profileId: string; database: string }; sql: string }[] = [];
  const written: { path: string; text: string }[] = [];
  const opened: string[] = [];
  const infos: { message: string; items: string[] }[] = [];
  const errors: string[] = [];
  const progress: string[] = [];
  const saved: { left: SchemaSide; right: SchemaSide }[] = [];
  const dialogs: string[] = [];
  const answers = over.answers ?? ['p1', 'dbL', 'sL', 'p2', 'dbR', 'sR'];
  let n = 0;
  const rows = over.rows ?? {};
  const env: SchemaCompareEnv = {
    profiles: () => [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
    pick: async (items, placeHolder, preferred) => {
      picks.push({ items, placeHolder, preferred });
      return answers[n++];
    },
    query: async <T,>(side: { profileId: string; database: string }, sql: string) => {
      queries.push({ side, sql });
      if (sql === schemaColumnsQuery('sL')) return (rows.L ?? [col('t1', 'a')]) as T[];
      if (sql === schemaColumnsQuery('sR')) return (rows.R ?? [col('t1', 'a', 'bigint')]) as T[];
      return [{ name: 'x' }, { name: 'y' }] as T[];
    },
    lastChoice: () => undefined,
    saveChoice: async (c) => { saved.push(c); },
    withProgress: async (_t, task) => task((m) => progress.push(m)),
    saveDialog: async (name) => { dialogs.push(name); return 'C:/out/report.csv'; },
    writeFile: async (path, text) => { written.push({ path, text }); },
    open: async (p) => { opened.push(p); },
    info: async (message, ...items) => { infos.push({ message, items }); return undefined; },
    error: (m) => { errors.push(m); },
    ...over,
  };
  return { env, calls, picks, queries, written, opened, infos, errors, progress, saved, dialogs };
}

const now = () => new Date(2026, 10, 28, 9, 5);

describe('runSchemaCompare', () => {
  it('shows an info message and stops when no databases are found', async () => {
    const t = makeEnv({ answers: ['p1'], query: async () => [] });
    await runSchemaCompare(t.env, now);
    expect(t.infos.map((i) => i.message)).toEqual(['No databases found on One.']);
    expect(t.picks).toHaveLength(1);
    expect(t.saved).toEqual([]);
  });

  it('shows an info message and stops when no schemas are found', async () => {
    const t = makeEnv({
      answers: ['p1', 'dbL'],
      query: async <T,>(_s: unknown, sql: string) => (sql === listSchemasQuery() ? [] : [{ name: 'x' }]) as T[],
    });
    await runSchemaCompare(t.env, now);
    expect(t.infos.map((i) => i.message)).toEqual(['No schemas found in dbL.']);
    expect(t.picks).toHaveLength(2);
    expect(t.saved).toEqual([]);
  });

  it('runs the six picks in order and writes the report', async () => {
    const t = makeEnv();
    await runSchemaCompare(t.env, now);
    expect(t.picks.map((p) => p.placeHolder)).toEqual([
      'Left (the schema to check): connection',
      'Left (the schema to check): database',
      'Left (the schema to check): schema',
      'Right (the schema it should match): connection',
      'Right (the schema it should match): database',
      'Right (the schema it should match): schema',
    ]);
    expect(t.picks[0].items).toEqual([{ label: 'One', value: 'p1' }, { label: 'Two', value: 'p2' }]);
    expect(t.picks[1].items).toEqual(['x', 'y']);
    const dbQ = t.queries.find((q) => q.sql === listDatabasesQuery());
    expect(dbQ).toBeDefined();
    expect(t.queries.some((q) => q.sql === listSchemasQuery() && q.side.database === 'dbL')).toBe(true);
    expect(t.queries.filter((q) => q.sql.includes('sys.columns')).map((q) => q.side))
      .toEqual([{ profileId: 'p1', database: 'dbL', schema: 'sL' }, { profileId: 'p2', database: 'dbR', schema: 'sR' }]);

    const l = { database: 'dbL', schema: 'sL' }; const r = { database: 'dbR', schema: 'sR' };
    const findings = diffSchemas(
      groupSchemaRows([col('t1', 'a')]), groupSchemaRows([col('t1', 'a', 'bigint')]));
    expect(t.dialogs).toEqual([reportFileName(l, r, now())]);
    expect(t.written).toEqual([{ path: 'C:/out/report.csv', text: schemaReportCsv(findings) }]);
    expect(t.opened).toEqual(['C:/out/report.csv']);
    expect(t.infos).toEqual([{ message: reportSummary(findings), items: ['Open again'] }]);
    expect(t.saved).toEqual([{ left: { profileId: 'p1', database: 'dbL', schema: 'sL' }, right: { profileId: 'p2', database: 'dbR', schema: 'sR' } }]);
    expect(t.progress).toEqual(['Reading sL and sR…', 'Comparing…']);
  });

  it('reopens the file when Open again is clicked', async () => {
    const t = makeEnv({ info: async () => 'Open again' });
    await runSchemaCompare(t.env, now);
    expect(t.opened).toEqual(['C:/out/report.csv', 'C:/out/report.csv']);
  });

  it('says to add a connection when there are none', async () => {
    const t = makeEnv({ profiles: () => [] });
    const errs: string[] = [];
    t.env.info = async (m) => { errs.push(m); return undefined; };
    await runSchemaCompare(t.env, now);
    expect(errs).toEqual(['Add a connection first.']);
    expect(t.picks).toHaveLength(0);
  });

  it('stops at a cancelled pick without further queries or writes', async () => {
    const t = makeEnv({ answers: ['p1', 'dbL', 'sL', undefined] });
    await runSchemaCompare(t.env, now);
    expect(t.picks).toHaveLength(4);
    expect(t.queries.filter((q) => q.side.profileId === 'p2')).toHaveLength(0);
    expect(t.written).toHaveLength(0);
    expect(t.saved).toHaveLength(0);
  });

  it('does not write when the save dialog is cancelled', async () => {
    const t = makeEnv({ saveDialog: async () => undefined });
    await runSchemaCompare(t.env, now);
    expect(t.written).toHaveLength(0);
    expect(t.opened).toHaveLength(0);
  });

  it('reports query errors and writes nothing', async () => {
    const t = makeEnv();
    const base = t.env.query;
    t.env.query = (async (side: { profileId: string; database: string }, sql: string) => {
      if (sql === schemaColumnsQuery('sR')) throw new Error('boom');
      return base(side, sql);
    }) as SchemaCompareEnv['query'];
    await runSchemaCompare(t.env, now);
    expect(t.errors).toEqual(['Schema compare failed: boom']);
    expect(t.written).toHaveLength(0);
  });

  it('passes the remembered choice as preferred', async () => {
    const t = makeEnv({
      lastChoice: () => ({
        left: { profileId: 'p2', database: 'dL', schema: 'xL' },
        right: { profileId: 'p1', database: 'dR', schema: 'xR' },
      }),
    });
    await runSchemaCompare(t.env, now);
    expect(t.picks.map((p) => p.preferred)).toEqual(['p2', 'dL', 'xL', 'p1', 'dR', 'xR']);
  });
});
