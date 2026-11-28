import { describe, it, expect } from 'vitest';
import { rowCountFindings } from '../../src/schemaCompare/rowCounts';
import { runSchemaCompare, type SchemaCompareEnv, type SchemaSide } from '../../src/commands/compareSchemas';
import { countRowsQuery, listDatabasesQuery, listSchemasQuery, schemaColumnsQuery } from '../../src/sql/queries';
import { reportFileName, reportSummary, schemaReportCsv, diffSchemas, groupSchemaRows, sortFindings } from '../../src/schemaCompare/report';

const col = (object_name: string, column_name: string, type_name = 'int') => ({
  object_name, object_type: 'U ', column_name, type_name,
  max_length: 4, precision: 10, scale: 0, is_nullable: false, column_id: 1,
});

function makeEnv(over: Partial<SchemaCompareEnv> & { answers?: (string | undefined)[]; rows?: Record<string, unknown[]>; counts?: Record<string, unknown> } = {}) {
  const calls: string[] = [];
  const picks: { items: unknown; placeHolder: string; preferred?: string }[] = [];
  const queries: { side: { profileId: string; database: string }; sql: string; signal?: AbortSignal }[] = [];
  const countQueries: { database: string; sql: string }[] = [];
  const written: { path: string; text: string }[] = [];
  const opened: string[] = [];
  const infos: { message: string; items: string[] }[] = [];
  const errors: string[] = [];
  const progress: string[] = [];
  const saved: { left: SchemaSide; right: SchemaSide; rowCounts?: boolean }[] = [];
  const dialogs: string[] = [];
  const answers = over.answers ?? ['p1', 'dbL', 'sL', 'p2', 'dbR', 'sR', 'structure'];
  let n = 0;
  const rows = over.rows ?? {};
  const counts = over.counts ?? {};
  const env: SchemaCompareEnv = {
    profiles: () => [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
    pick: async (items, placeHolder, preferred) => {
      picks.push({ items, placeHolder, preferred });
      return answers[n++];
    },
    query: async <T,>(side: { profileId: string; database: string }, sql: string, signal?: AbortSignal) => {
      queries.push({ side, sql, signal });
      if (sql.includes('COUNT_BIG')) {
        countQueries.push({ database: side.database, sql });
        const m = /\[([^\]]+)\]$/.exec(sql);
        return [{ cnt: counts[`${side.database}:${m?.[1]}`] }] as T[];
      }
      if (sql === schemaColumnsQuery('sL')) return (rows.L ?? [col('t1', 'a')]) as T[];
      if (sql === schemaColumnsQuery('sR')) return (rows.R ?? [col('t1', 'a', 'bigint')]) as T[];
      return [{ name: 'x' }, { name: 'y' }] as T[];
    },
    lastChoice: () => undefined,
    saveChoice: async (c) => { saved.push(c); },
    withProgress: async (_t, task) => task((m) => progress.push(m), new AbortController().signal),
    saveDialog: async (name) => { dialogs.push(name); return 'C:/out/report.csv'; },
    writeFile: async (path, text) => { written.push({ path, text }); },
    open: async (p) => { opened.push(p); },
    info: async (message, ...items) => { infos.push({ message, items }); return undefined; },
    error: (m) => { errors.push(m); },
    ...over,
  };
  return { env, countQueries, calls, picks, queries, written, opened, infos, errors, progress, saved, dialogs };
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

  it('runs the seven picks in order and writes the report', async () => {
    const t = makeEnv();
    await runSchemaCompare(t.env, now);
    expect(t.picks.map((p) => p.placeHolder)).toEqual([
      'Left (the schema to check): connection',
      'Left (the schema to check): database',
      'Left (the schema to check): schema',
      'Right (the schema it should match): connection',
      'Right (the schema it should match): database',
      'Right (the schema it should match): schema',
      'Compare row counts too?',
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
    expect(t.saved).toEqual([{ left: { profileId: 'p1', database: 'dbL', schema: 'sL' }, right: { profileId: 'p2', database: 'dbR', schema: 'sR' }, rowCounts: false }]);
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
    expect(t.picks.map((p) => p.preferred)).toEqual(['p2', 'dL', 'xL', 'p1', 'dR', 'xR', 'structure']);
  });

  const structureItem = { label: 'Structure only', value: 'structure' };
  const countsItem = {
    label: 'Structure and row counts', value: 'counts',
    description: "Counts every table found on both sides; serverless reads each table's files",
  };
  const withCounts = ['p1', 'dbL', 'sL', 'p2', 'dbR', 'sR', 'counts'];

  it('asks about row counts after the schemas', async () => {
    const t = makeEnv();
    await runSchemaCompare(t.env, now);
    expect(t.picks[6].placeHolder).toBe('Compare row counts too?');
    expect(t.picks[6].items).toEqual([structureItem, countsItem]);
    expect(t.picks[6].preferred).toBe('structure');
    const t2 = makeEnv({
      lastChoice: () => ({
        left: { profileId: 'p1', database: 'dbL', schema: 'sL' },
        right: { profileId: 'p2', database: 'dbR', schema: 'sR' }, rowCounts: true,
      }),
    });
    await runSchemaCompare(t2.env, now);
    expect(t2.picks[6].preferred).toBe('counts');
  });

  it('dismissing the row-count pick stops', async () => {
    const t = makeEnv({ answers: ['p1', 'dbL', 'sL', 'p2', 'dbR', 'sR', undefined] });
    await runSchemaCompare(t.env, now);
    expect(t.saved).toEqual([]);
    expect(t.queries.some((q) => q.sql.includes('sys.columns'))).toBe(false);
    expect(t.dialogs).toEqual([]);
  });

  it('structure only is unchanged', async () => {
    const t = makeEnv();
    await runSchemaCompare(t.env, now);
    const findings = diffSchemas(groupSchemaRows([col('t1', 'a')]), groupSchemaRows([col('t1', 'a', 'bigint')]));
    expect(t.countQueries).toEqual([]);
    expect(t.infos[0].message).toBe(reportSummary(findings));
    expect(t.saved[0].rowCounts).toBe(false);
  });

  it('counts rows of matched tables', async () => {
    const t = makeEnv({
      answers: withCounts,
      rows: { L: [col('t1', 'a')], R: [col('T1', 'a')] },
      counts: { 'dbL:t1': 3, 'dbR:T1': '2' },
    });
    await runSchemaCompare(t.env, now);
    expect(t.countQueries).toHaveLength(2);
    expect(t.countQueries).toEqual(expect.arrayContaining([
      { database: 'dbL', sql: countRowsQuery({ schema: 'sL', name: 't1' }) },
      { database: 'dbR', sql: countRowsQuery({ schema: 'sR', name: 'T1' }) },
    ]));
    expect(t.progress).toContain('Counting rows 1 of 1: sL.t1…');
    expect(t.saved[0].rowCounts).toBe(true);
    expect(t.written[0].text).toContain('row_count_mismatch,t1,,,,"left 3 rows, right 2 rows (1 fewer on the right)",');
    const findings = sortFindings([
      ...diffSchemas(groupSchemaRows([col('t1', 'a')]), groupSchemaRows([col('T1', 'a')])),
      ...rowCountFindings([{ table: 't1', left: 3n, right: 2n }]),
    ]);
    expect(t.infos[0].message).toBe(reportSummary(findings, 1));
  });

  it('cancel during counting abandons the run', async () => {
    const ac = new AbortController();
    const t = makeEnv({
      answers: withCounts,
      rows: { L: [col('t1', 'a'), col('t2', 'a')], R: [col('t1', 'a'), col('t2', 'a')] },
      counts: { 'dbL:t1': 1, 'dbR:t1': 1, 'dbL:t2': 1, 'dbR:t2': 1 },
      withProgress: async (_t: string, task: (r: (m: string) => void, s: AbortSignal) => Promise<unknown>) =>
        task(() => {}, ac.signal) as never,
    });
    const base = t.env.query;
    let counted = 0;
    t.env.query = (async (side: { profileId: string; database: string }, sql: string, signal?: AbortSignal) => {
      if (sql.includes('COUNT_BIG')) { counted++; ac.abort(); throw new Error('cancelled'); }
      return base(side, sql, signal);
    }) as SchemaCompareEnv['query'];
    await runSchemaCompare(t.env, now);
    expect(t.dialogs).toEqual([]);
    expect(t.infos).toEqual([]);
    expect(t.errors).toEqual([]);
    expect(t.written).toEqual([]);
    expect(counted).toBeLessThanOrEqual(4);
  });
});
