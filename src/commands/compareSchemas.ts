import { countRowsQuery, listDatabasesQuery, listSchemasQuery, schemaColumnsQuery } from '../sql/queries';
import {
  diffSchemas, groupSchemaRows, reportFileName, reportSummary, schemaReportCsv, sortFindings,
  type SchemaColumnRow,
} from '../schemaCompare/report';
import { countMatchedTables, matchedPairs, rowCountFindings } from '../schemaCompare/rowCounts';
import { CompareCancelledError } from '../core/errors';

export interface SchemaSide { profileId: string; database: string; schema: string }

export interface SchemaCompareEnv {
  profiles(): { id: string; name: string }[];
  /** Returns the picked value; the preferred item is listed first. */
  pick(items: string[] | { label: string; value: string; description?: string }[], placeHolder: string, preferred?: string): Promise<string | undefined>;
  /** Opens a connection, runs the query and closes it. */
  query<T>(side: { profileId: string; database: string }, sql: string, signal?: AbortSignal): Promise<T[]>;
  lastChoice(): { left: SchemaSide; right: SchemaSide; rowCounts?: boolean } | undefined;
  saveChoice(c: { left: SchemaSide; right: SchemaSide; rowCounts?: boolean }): Promise<void>;
  withProgress<T>(title: string, task: (report: (message: string) => void, signal: AbortSignal) => Promise<T>): Promise<T>;
  saveDialog(defaultFileName: string): Promise<string | undefined>;
  writeFile(path: string, text: string): Promise<void>;
  open(path: string): Promise<void>;
  info(message: string, ...items: string[]): Promise<string | undefined>;
  error(message: string): void;
}

const LEFT = 'Left (the schema to check)';
const RIGHT = 'Right (the schema it should match)';
const ROW_COUNT_ITEMS = [
  { label: 'Structure only', value: 'structure' },
  {
    label: 'Structure and row counts', value: 'counts',
    description: "Counts every table found on both sides; serverless reads each table's files",
  },
];

async function pickSide(
  env: SchemaCompareEnv,
  label: string,
  remembered: SchemaSide | undefined,
): Promise<SchemaSide | undefined> {
  const profileId = await env.pick(
    env.profiles().map((p) => ({ label: p.name, value: p.id })), `${label}: connection`, remembered?.profileId);
  // An empty database means the profile's own default; the env resolves it.
  if (profileId === undefined) return undefined;
  const dbs = await env.query<{ name: string }>({ profileId, database: '' }, listDatabasesQuery());
  if (dbs.length === 0) {
    const name = env.profiles().find((p) => p.id === profileId)?.name ?? profileId;
    await env.info(`No databases found on ${name}.`);
    return undefined;
  }
  const database = await env.pick(dbs.map((d) => d.name), `${label}: database`, remembered?.database);
  if (database === undefined) return undefined;
  const schemas = await env.query<{ name: string }>({ profileId, database }, listSchemasQuery());
  if (schemas.length === 0) {
    await env.info(`No schemas found in ${database}.`);
    return undefined;
  }
  const schema = await env.pick(schemas.map((s) => s.name), `${label}: schema`, remembered?.schema);
  if (schema === undefined) return undefined;
  return { profileId, database, schema };
}

export async function runSchemaCompare(
  env: SchemaCompareEnv,
  now: () => Date = () => new Date(),
): Promise<void> {
  if (env.profiles().length === 0) {
    await env.info('Add a connection first.');
    return;
  }
  let cancelSignal: AbortSignal | undefined;
  try {
    const last = env.lastChoice();
    const left = await pickSide(env, LEFT, last?.left);
    if (!left) return;
    const right = await pickSide(env, RIGHT, last?.right);
    if (!right) return;
    const mode = await env.pick(ROW_COUNT_ITEMS, 'Compare row counts too?', last?.rowCounts ? 'counts' : 'structure');
    if (mode === undefined) return;
    const rowCounts = mode === 'counts';
    await env.saveChoice({ left, right, rowCounts });

    const { findings, counted } = await env.withProgress('Table Diff: comparing schemas', async (report, signal) => {
      cancelSignal = signal;
      report(`Reading ${left.schema} and ${right.schema}…`);
      const [l, r] = await Promise.all([
        env.query<SchemaColumnRow>(left, schemaColumnsQuery(left.schema), signal),
        env.query<SchemaColumnRow>(right, schemaColumnsQuery(right.schema), signal),
      ]);
      report('Comparing…');
      const lObjs = groupSchemaRows(l);
      const rObjs = groupSchemaRows(r);
      const found = diffSchemas(lObjs, rObjs);
      if (!rowCounts) return { findings: found, counted: undefined };
      const pairs = matchedPairs(lObjs, rObjs);
      const results = await countMatchedTables(
        pairs,
        async (side, name) => {
          const s = side === 'left' ? left : right;
          return (await env.query<{ cnt: unknown }>(s, countRowsQuery({ schema: s.schema, name }), signal))[0]?.cnt;
        },
        {
          limit: 4, signal,
          onStart: (i, total, pair) => report(`Counting rows ${i + 1} of ${total}: ${left.schema}.${pair.left}…`),
        },
      );
      return { findings: sortFindings([...found, ...rowCountFindings(results)]), counted: pairs.length };
    });

    const path = await env.saveDialog(reportFileName(left, right, now()));
    if (!path) return;
    await env.writeFile(path, schemaReportCsv(findings));
    await env.open(path);
    const choice = await env.info(reportSummary(findings, counted), 'Open again');
    if (choice === 'Open again') await env.open(path);
  } catch (err) {
    if (err instanceof CompareCancelledError || cancelSignal?.aborted) return;
    env.error(`Schema compare failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
