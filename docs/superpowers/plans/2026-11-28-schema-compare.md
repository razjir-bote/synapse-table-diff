# Schema Compare Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Compare Schemas…" command. It compares every table, view and external table in one schema with another schema by name, then saves the findings (missing tables, missing columns, type and size differences) as a CSV report.

**Architecture:** A pure module `src/schemaCompare/report.ts` turns metadata rows into findings and CSV text. Two new metadata queries go in `src/sql/queries.ts`. A command module `src/commands/compareSchemas.ts` drives the quick-pick flow through an injectable env, so it can be unit tested. `extension.ts` wires that env to VS Code and the existing connector.

**Tech Stack:** TypeScript, the VS Code API (quick picks, save dialog, `env.openExternal`), mssql via the existing `makeConnector`, Vitest (unit tests plus integration tests against local SQL Server 2022 in Docker).

**Spec:** `docs/superpowers/specs/2026-11-28-schema-compare-design.md`

## Global Constraints

- **CSV format.** The header is exactly `issue,table,column,left_type,right_type,details,status`. The file starts with a UTF-8 BOM and lines end with CRLF. Fields use RFC 4180 quoting and go through `neutralizeFormula` from `src/export/csv.ts`. `status` is always empty.
- **Issue values.** They are exactly `missing_table`, `extra_table`, `missing_column`, `extra_column`, `type_mismatch` and `size_mismatch`.
- **Name matching.** Object and column names match case-insensitively. A `table`, `view` or `external table` matches any of the three kinds.
- **Sort order.** Rows sort by table name (case-insensitive), then by issue in the order listed above, then by column name (case-insensitive).
- **Type text:**

  | Type | Text |
  |---|---|
  | `char`/`varchar`/`binary`/`varbinary` | `(n)`, or `(max)` when `max_length = -1` |
  | `nchar`/`nvarchar` | `(max_length/2)`, or `(max)` |
  | `decimal`/`numeric` | `(p,s)` |
  | `datetime2`/`time`/`datetimeoffset` | `(scale)` |
  | everything else | the bare name |

- **Mismatch rules.** `type_mismatch` means the base type names differ (case-insensitive). `size_mismatch` means the base type is the same but the type text differs.
- **SQL.** All SQL is built through `sqlString`/`quoteIdent` and must pass `assertAllowedSql`. It must be read-only and run on both dedicated and serverless pools (only `sys.schemas`, `sys.objects`, `sys.columns` and `sys.types`).
- **Remembered picks.** The last picks are stored in `globalState` under key `tableDiff.schemaCompare.last`.

**User decisions (already made):**
- "A CSV file": the report is a CSV the user works through.
- "the pickers": quick-pick flow, not a form webview.
- Approved design: extra (right-only) tables are reported, `size_mismatch` is separate from `type_mismatch`, there's an empty `status` column, and the report only finds gaps (no DDL, nullability or row data).

## Review Focus

1. **Picking the same schema on both sides.** Expected: an empty report with the message "No differences", not an error.
2. **A schema with no objects on the right side.** Expected: every left table is `missing_table`, and there's no crash on the empty result.
3. **Names that differ only in case** (`Orders` vs `orders`, `ID` vs `id`). Expected: they match, and the report uses the left name.
4. **`nvarchar(max)` vs `nvarchar(4000)`, and `nvarchar(50)` vs `varchar(50)`.** Expected: the first is `size_mismatch` with `(max)` vs `(4000)`. The second is `type_mismatch`.
5. **A cancelled picker at any of the six steps, or a cancelled save dialog.** Expected: the command stops quietly, without querying or writing a file.

---

### Task 1: Report core (diff, type text, CSV)

**Goal:** Pure functions that turn two schemas' metadata into sorted findings, CSV text, a summary line and a file name.

**Files:**
- Create: `src/schemaCompare/report.ts`
- Test: `test/unit/schemaReport.test.ts`

**Interfaces:**
```ts
import type { ColumnInfo } from '../core/types';
import type { ObjectKind } from '../sql/queries';
export interface SchemaColumnRow {
  object_name: string; object_type: string; column_name: string; type_name: string;
  max_length: number; precision: number; scale: number; is_nullable: boolean; column_id: number;
}
export interface SchemaObject { name: string; kind: ObjectKind; columns: ColumnInfo[] }
export type IssueType = 'missing_table' | 'extra_table' | 'missing_column' | 'extra_column' | 'type_mismatch' | 'size_mismatch';
export interface Finding { issue: IssueType; table: string; column: string; leftType: string; rightType: string; details: string }
export function groupSchemaRows(rows: SchemaColumnRow[]): SchemaObject[];   // uses objectKindOf; columns ordered by column_id; type lower-cased
export function typeText(c: ColumnInfo): string;
export function diffSchemas(left: SchemaObject[], right: SchemaObject[]): Finding[];
export function schemaReportCsv(findings: Finding[]): string;
export function reportSummary(findings: Finding[]): string;
export function reportFileName(l: { database: string; schema: string }, r: { database: string; schema: string }, now: Date): string;
```

**Acceptance Criteria:**
- [ ] `typeText` gives `varchar(50)`, `varchar(max)`, `nvarchar(25)` (max_length 50), `nvarchar(max)`, `decimal(10,2)`, `datetime2(7)`, `int`.
- [ ] `diffSchemas` emits the six issue types as the spec defines them, matches names case-insensitively, uses left names for matched objects and columns, and sorts by the Global Constraints order.
- [ ] Details text:
  - `missing_table`: `<kind> on the left; no table, view or external table with this name on the right`
  - `extra_table`: `<kind> on the right; not on the left`
  - `missing_column`: `not in the right <kind>`
  - `extra_column`: `not in the left <kind>`
  - `type_mismatch`: empty
  - `size_mismatch`: `<leftType> vs <rightType>`
- [ ] `schemaReportCsv` output starts with BOM + header + CRLF, and a value `=cmd` is written as `'=cmd`.
- [ ] `reportSummary([])` is `No differences found.` Otherwise it reads `N findings: 2 missing tables, 1 type mismatch, …`, listing only non-zero issue types, in issue order, with the singular form for 1.
- [ ] `reportFileName({database:'dw',schema:'dbo'},{database:'lake',schema:'ext'}, new Date(2026,10,28,9,5))` returns `schema-diff_dw.dbo_vs_lake.ext_20261128-0905.csv`, using local time.

**Verify:** `npx vitest run test/unit/schemaReport.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write failing tests** in `test/unit/schemaReport.test.ts` that cover every acceptance criterion. Include these:
  - Left `Orders` (table: `ID int`, `Name varchar(50)`, `Amt decimal(10,2)`, `Note nvarchar(100)`) against right `orders` (external table: `id int`, `name nvarchar(50)`, `amt decimal(18,4)`, `extra int`). Expected: `type_mismatch` for Name; `size_mismatch` for Amt with details `decimal(10,2) vs decimal(18,4)`; `missing_column` for Note; `extra_column` for extra. Table is `Orders` and there's no finding for ID.
  - Left-only `Lines` gives `missing_table`. Right-only `Stage` gives `extra_table`.
  - The rows for the whole example come out in the specified sort order.
  - Identical inputs give `[]`.
- [ ] **Step 2: Run** `npx vitest run test/unit/schemaReport.test.ts`. Expected: FAIL, because the module doesn't exist yet.
- [ ] **Step 3: Implement** `src/schemaCompare/report.ts`. Reuse `neutralizeFormula` by exporting a `csvLine(fields)` helper from `src/export/csv.ts` (rename the existing private `line` and export it). Don't duplicate the quoting code.
- [ ] **Step 4: Run** `npx vitest run test/unit` and `npm run typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** with `git add src/schemaCompare test/unit/schemaReport.test.ts src/export/csv.ts`, then `git commit -m "feat(schema-compare): findings, type text and CSV report"`.

```json:metadata
{"files": ["src/schemaCompare/report.ts", "src/export/csv.ts", "test/unit/schemaReport.test.ts"], "verifyCommand": "npx vitest run test/unit/schemaReport.test.ts", "acceptanceCriteria": ["typeText formats per spec", "diffSchemas emits six issue types, case-insensitive, left names, sorted", "details text exact", "CSV BOM/header/CRLF/formula neutralized", "reportSummary format", "reportFileName format"], "modelTier": "standard"}
```

### Task 2: Metadata queries + integration test

**Goal:** SQL that lists schemas and reads every column of every table, view and external table in a schema, proven against the local SQL Server.

**Files:**
- Modify: `src/sql/queries.ts` (add next to `listObjectsQuery`)
- Modify: `test/unit/queries.test.ts`
- Modify: `test/integration/seed.sql` (append a section)
- Create: `test/integration/schemaCompare.test.ts`

**Interfaces:**
```ts
export function listSchemasQuery(): string;                 // rows: { name: string }; schemas holding >=1 U/V/ET object, ORDER BY name
export function schemaColumnsQuery(schema: string): string; // rows: SchemaColumnRow (Task 1); WHERE s.name = <sqlString(schema)> AND o.type IN ('U','V','ET'); ORDER BY o.name, c.column_id
```

**Acceptance Criteria:**
- [ ] Both queries pass `assertAllowedSql`. A schema name containing `'` is escaped (unit test with `o'brien`).
- [ ] The seed creates `cmp_l` in `tablediff_a` and `cmp_r` in `tablediff_b`:
  - `cmp_l`: `t1(id int, name varchar(50), amt decimal(10,2), note nvarchar(100))`, `t2(id int)`, and view `v1` (`SELECT id FROM cmp_l.t1`).
  - `cmp_r`: `T1(id int, name nvarchar(50), amt decimal(18,4), extra int)`, view `v1` (`SELECT id FROM cmp_r.T1`), and `t3(id int)`.
- [ ] The integration test runs both queries through `openRunner`, then `groupSchemaRows` and `diffSchemas`, and asserts exactly these findings in order:
  - t1: `type_mismatch` name, `size_mismatch` amt, `missing_column` note, `extra_column` extra
  - t2: `missing_table`
  - t3: `extra_table`
  - nothing for `v1`
- [ ] `listSchemasQuery` on `tablediff_a` includes `cmp_l` and `dbo`, and not `sys` or `guest`.

**Verify:** `npm run test:integration` → all pass (Docker SQL Server up via `docker compose up -d`)

**Steps:**

- [ ] **Step 1: Write failing tests.** Add unit tests for both queries to `queries.test.ts`, covering the allow-list and quoting. Add the seed section and `test/integration/schemaCompare.test.ts`, following `test/integration/pipeline.test.ts`'s `TABLEDIFF_TEST_CONN` and `parseConnectionString` setup.
- [ ] **Step 2: Run** `npx vitest run test/unit/queries.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both queries, joining `sys.objects` ⋈ `sys.schemas` ⋈ `sys.columns` ⋈ `sys.types` (`c.user_type_id = t.user_type_id`). If the allow-list rejects a needed keyword such as `EXISTS`, use a join with `DISTINCT` instead of widening the allow-list.
- [ ] **Step 4: Run** `npx vitest run test/unit` and `npm run test:integration`. Expected: all pass.
- [ ] **Step 5: Commit** with `git add src/sql/queries.ts test/unit/queries.test.ts test/integration`, then `git commit -m "feat(schema-compare): schema listing and column metadata queries"`.

```json:metadata
{"files": ["src/sql/queries.ts", "test/unit/queries.test.ts", "test/integration/seed.sql", "test/integration/schemaCompare.test.ts"], "verifyCommand": "npm run test:integration", "acceptanceCriteria": ["queries pass allow-list and escape quotes", "seed creates cmp_l/cmp_r", "integration asserts exact findings", "listSchemasQuery excludes empty system schemas"], "modelTier": "standard"}
```

### Task 3: Command, pickers and wiring

**Goal:** A "Table Diff: Compare Schemas…" command, available from the sidebar, that runs the six pickers, queries both sides in parallel, saves the CSV, opens it and shows the summary.

**Files:**
- Create: `src/commands/compareSchemas.ts`
- Modify: `src/extension.ts`, `package.json` (command `tableDiff.compareSchemas`, title `Compare Schemas…`, category `Table Diff`, icon `$(list-tree)`; Connections view title `navigation@3`; Connections welcome link `[Compare Schemas](command:tableDiff.compareSchemas)`), `README.md` (a "Compare schemas" section)
- Test: `test/unit/compareSchemas.test.ts`

**Interfaces:**
```ts
export interface SchemaSide { profileId: string; database: string; schema: string }
export interface SchemaCompareEnv {
  profiles(): { id: string; name: string }[];
  pick(items: string[] | { label: string; value: string }[], placeHolder: string, preferred?: string): Promise<string | undefined>; // returns value; preferred item listed first
  query<T>(side: { profileId: string; database: string }, sql: string): Promise<T[]>; // opens, runs, closes
  lastChoice(): { left: SchemaSide; right: SchemaSide } | undefined;
  saveChoice(c: { left: SchemaSide; right: SchemaSide }): Promise<void>;
  withProgress<T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T>;
  saveDialog(defaultFileName: string): Promise<string | undefined>; // fs path
  writeFile(path: string, text: string): Promise<void>;
  open(path: string): Promise<void>;
  info(message: string, ...items: string[]): Promise<string | undefined>;
  error(message: string): void;
}
export async function runSchemaCompare(env: SchemaCompareEnv, now?: () => Date): Promise<void>;
```

**Acceptance Criteria:**
- [ ] **Pick order:** left connection, database (from `listDatabasesQuery`), schema (from `listSchemasQuery`), then the same for the right. Placeholders read `Left (the schema to check): connection`, …, `Right (the schema it should match): schema`. Each pick passes the remembered value as `preferred`.
- [ ] **No connections:** the command shows `Add a connection first.` and never calls `pick`.
- [ ] **Cancelling** (`undefined` at any pick or at the save dialog) returns without calling `writeFile`. A cancelled pick also skips every query after it.
- [ ] **Both sides in parallel:** `schemaColumnsQuery` runs on both sides through `Promise.all` inside `withProgress('Table Diff: comparing schemas', …)`. The progress messages are `Reading left.schema…` and `Comparing…`.
- [ ] **Saving:** the choices are saved before querying. `saveDialog` gets `reportFileName(...)`. `writeFile` gets `schemaReportCsv(findings)`. Then `open(path)` runs, and `info(reportSummary(findings), 'Open again')` is shown.
- [ ] **Query errors** call `error('Schema compare failed: <message>')` and nothing is written.
- [ ] **Sidebar:** the command appears in the Connections view title bar and the welcome view. `extension.ts` implements the env with `vscode.window.showQuickPick`, `showSaveDialog` (default folder: the first workspace folder, or home), `fs.promises.writeFile`, `vscode.env.openExternal(vscode.Uri.file(path))`, `ctx.globalState` key `tableDiff.schemaCompare.last`, and `connect(...).open()` → `query` → `close()` in `finally`.

**Verify:** `npx vitest run test/unit && npm run typecheck && npm run compile` → all pass

**Steps:**

- [ ] **Step 1: Write failing tests** in `test/unit/compareSchemas.test.ts` with a fake env that records calls. Cover these cases:
  - The happy path: the six picks in order with their placeholders, the parallel queries, the file name, the CSV content passed to `writeFile`, the `open` call and the summary.
  - Cancel at the 4th pick: no query for that side, no write.
  - Cancel at the save dialog: no write.
  - No connections.
  - A query that rejects, giving an error message and no write.
  - The remembered choice passed as `preferred`.
- [ ] **Step 2: Run** `npx vitest run test/unit/compareSchemas.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `runSchemaCompare`. Then wire `extension.ts` and `package.json`, and write the README section: what it reports, the six issue types, matching rules, and how to read `size_mismatch` for serverless external tables.
- [ ] **Step 4: Run** `npx vitest run test/unit && npm run typecheck && npm run compile`. Expected: all pass.
- [ ] **Step 5: Commit** with `git add src/commands/compareSchemas.ts src/extension.ts package.json README.md test/unit/compareSchemas.test.ts`, then `git commit -m "feat(schema-compare): Compare Schemas command with pickers and CSV report"`.

```json:metadata
{"files": ["src/commands/compareSchemas.ts", "src/extension.ts", "package.json", "README.md", "test/unit/compareSchemas.test.ts"], "verifyCommand": "npx vitest run test/unit && npm run typecheck && npm run compile", "acceptanceCriteria": ["six picks in order with placeholders and preferred", "no connections message", "cancel stops without write", "parallel queries under progress", "save/open/summary", "query errors reported", "sidebar title button and welcome link"], "modelTier": "standard"}
```
