import { listDatabasesQuery, listSchemasQuery, schemaColumnsQuery } from '../sql/queries';
import {
  diffSchemas, groupSchemaRows, reportFileName, reportSummary, schemaReportCsv,
  type SchemaColumnRow,
} from '../schemaCompare/report';

export interface SchemaSide { profileId: string; database: string; schema: string }

export interface SchemaCompareEnv {
  profiles(): { id: string; name: string }[];
  /** Returns the picked value; the preferred item is listed first. */
  pick(items: string[] | { label: string; value: string }[], placeHolder: string, preferred?: string): Promise<string | undefined>;
  /** Opens a connection, runs the query and closes it. */
  query<T>(side: { profileId: string; database: string }, sql: string): Promise<T[]>;
  lastChoice(): { left: SchemaSide; right: SchemaSide } | undefined;
  saveChoice(c: { left: SchemaSide; right: SchemaSide }): Promise<void>;
  withProgress<T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T>;
  saveDialog(defaultFileName: string): Promise<string | undefined>;
  writeFile(path: string, text: string): Promise<void>;
  open(path: string): Promise<void>;
  info(message: string, ...items: string[]): Promise<string | undefined>;
  error(message: string): void;
}

const LEFT = 'Left (the schema to check)';
const RIGHT = 'Right (the schema it should match)';

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
  try {
    const last = env.lastChoice();
    const left = await pickSide(env, LEFT, last?.left);
    if (!left) return;
    const right = await pickSide(env, RIGHT, last?.right);
    if (!right) return;
    await env.saveChoice({ left, right });

    const findings = await env.withProgress('Table Diff: comparing schemas', async (report) => {
      report(`Reading ${left.schema} and ${right.schema}…`);
      const [l, r] = await Promise.all([
        env.query<SchemaColumnRow>(left, schemaColumnsQuery(left.schema)),
        env.query<SchemaColumnRow>(right, schemaColumnsQuery(right.schema)),
      ]);
      report('Comparing…');
      return diffSchemas(groupSchemaRows(l), groupSchemaRows(r));
    });

    const path = await env.saveDialog(reportFileName(left, right, now()));
    if (!path) return;
    await env.writeFile(path, schemaReportCsv(findings));
    await env.open(path);
    const choice = await env.info(reportSummary(findings), 'Open again');
    if (choice === 'Open again') await env.open(path);
  } catch (err) {
    env.error(`Schema compare failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
