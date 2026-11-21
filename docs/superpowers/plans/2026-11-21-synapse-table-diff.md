# Synapse Table Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code extension that compares two SQL Server / Azure Synapse tables (schema plus data, matched by a user-chosen key) at tens of millions of rows, and shows a git-diff-like result.

**Architecture:** A pure TypeScript comparison engine (`src/core`, `src/sql`) generates Synapse-safe T-SQL. The engine runs a fixed three-pass pipeline on each side in parallel: bucket checksums, then a sorted `(key hash, row hash)` stream merged client-side, then a detail fetch. A thin database layer (`src/db`) wraps the `mssql` driver with fresh-connection-per-pass, streaming and cancellation. The VS Code layer (`src/ui`, `src/profiles`, `src/extension.ts`) adds connection profiles with Entra ID or SQL auth, a webview setup form, a webview results panel, a diff-editor view and CSV export.

**Tech Stack:** TypeScript 5.6, VS Code API `^1.90.0`, `mssql` ^11 (tedious), esbuild, Vitest 2 (+ jsdom for webview render tests), SQL Server 2022 in Docker for integration tests, `@vscode/vsce` for packaging. Node 20.

**Spec:** `docs/superpowers/specs/2026-11-21-synapse-table-diff-design.md`

## Global Constraints

- **Hash construction.** Both sides use the same construction, built only by `src/sql/queries.ts`:
  - Each column contributes a *segment*: `CASE WHEN v IS NULL THEN N'~' ELSE N'#' + CAST(DATALENGTH(v)/2 AS nvarchar(20)) + N':' + v END`, where `v` is the column's normalized `nvarchar` expression from `normalizeExpr`.
  - `kh = HASHBYTES('SHA2_256', <key segments in keyColumns order>)`.
  - `rh = HASHBYTES('SHA2_256', <segments of compared non-key columns sorted by lower-cased name>)`. With zero such columns, `rh = HASHBYTES('SHA2_256', N'')`.
- **Buckets.**
  - `b24 = CAST(SUBSTRING(kh,1,3) AS int)`.
  - Level 1: `b1 = CASE WHEN knull=1 THEN -1 ELSE b24/4096 END` (4096 buckets).
  - Level 2: `b2 = CASE WHEN knull=1 THEN -1 ELSE b24/16 END` (1,048,576 buckets; `b2/256 = b1`).
  - `knull = 1` when any key column is NULL.
- **Bucket checksum row.** `cnt = COUNT_BIG(*)`, `dk = COUNT_BIG(DISTINCT kh)`, `s1 = SUM(CAST(CAST(SUBSTRING(rh,1,8) AS bigint) AS decimal(38,0)))`, `s2` the same over `SUBSTRING(rh,9,8)`. Two buckets are equal iff `cnt`, `dk`, `s1` and `s2` all match.
- **Default limits:**
  - `pairLimit` = 2,000,000 rows across both sides in pass-2 buckets (above it, re-bucket to level 2);
  - `detailLimit` = 100,000 differing rows;
  - `inListCap` = 5,000 bucket ids (above it, fall back to the parent level-1 ids);
  - `queryTimeoutSeconds` = 3600.
  - All four are VS Code settings under `tableDiff.*`.
- **SQL safety.**
  - No query parameters (`sp_executesql`). Identifiers go through `quoteIdent` (bracket-escape `]` → `]]`) and literals through `sqlString` (`'` → `''`, `N` prefix).
  - Every generated query must pass `assertAllowedSql` (Task 3).
  - The user's WHERE filter is inserted verbatim as `WHERE (\n<filter>\n)`, and omitted when blank.
- **Left = base/"before", Right = "after".** Key only on the right means `added`; only on the left means `removed`; on both with a different `rh` means `changed`.
- **Duplicate and NULL keys** are excluded from added/removed/changed and reported under `keyProblems`. The result's `warnings` must say the diff is incomplete for those keys.
- **Exact counts.** Counts are exact. Only `rows` (details) is capped, and `detailCapped` says so.
- **Cancellation** rejects with `CompareCancelledError`. It never resolves with a partial result.
- **Command IDs:** `tableDiff.compare`, `tableDiff.addConnection`, `tableDiff.removeConnection`, `tableDiff.rerunRecent`. Diff-editor URI scheme: `tablediff`.

**User decisions (already made):**
- Approach A: a TypeScript extension with its own comparison engine.
- Rows are matched by a user-chosen key. No-key comparison is not in v1.
- Columns are matched by name only, case-insensitively. Differently named columns are not mapped.
- Target databases are Synapse dedicated and serverless pools; tables have tens of millions of rows or more.
- Tests run on a local SQL Server only. There's no access to real pools; the user runs a manual smoke checklist.
- Auth is Entra ID through VS Code, with SQL auth as the fallback.
- The extension is read-only: no sync scripts.

**Plan-time calls (not in the spec, decided here):**
- `char`/`nchar` columns are always RTRIMmed, because padding is a type artefact.
- `(max)` types are supported with no size exclusion.
- Key-problem samples are collected during the pass-2 merge, so they need no extra scan.
- Detail rows are the first `detailLimit` differing keys in key-hash order. That's a stable pseudo-random spread across the table.
- `integer` and `exactDecimal` are separate families, as the spec lists them.

## Review Focus

1. **Odd identifiers.** Schema, table or column names containing spaces, `]`, `'` or non-ASCII must compare correctly. Pinned by the `odd name]]x` fixture in Task 7, and by the quoting tests in Task 4.
2. **A WHERE filter ending in a `--` comment, or only whitespace**, must not break the query. Pinned in Task 4.
3. **One side empty, or both empty.** All rows come back as added (or removed), or zero differences, with no crash. Pinned in Task 7.
4. **A composite key with one part NULL** is reported as a NULL-key problem and doesn't crash the merge. Pinned in Task 7 (`lines` fixture).
5. **Cancelling mid-run** rejects with `CompareCancelledError` and closes connections, never a "no differences" result. Pinned in Task 7.

---

## File Structure

```
package.json, tsconfig.json, esbuild.mjs, vitest.config.ts, vitest.integration.config.ts
docker-compose.yml, .env.example, .gitignore, .vscodeignore, README.md
src/
  extension.ts            activation; command registration; progress + cancellation wiring
  core/types.ts           all shared types (single source of truth)
  core/errors.ts          CompareCancelledError, PausedPoolError, PoolUnavailableError
  core/schemaDiff.ts      column metadata → SchemaDiff + ComparePlan
  core/buckets.ts         bucket-result comparison (pure)
  core/merge.ts           streaming sorted merge of pass-2 pairs (pure, async iterables)
  core/cellDiff.ts        changed-cell detection + value formatting (pure)
  core/pipeline.ts        orchestrates the three passes
  sql/sqlText.ts          quoteIdent, sqlString, qualifiedName
  sql/normalize.ts        type families, column-pair planning, normalizeExpr
  sql/allowList.ts        assertAllowedSql
  sql/queries.ts          every generated query
  db/runner.ts            QueryRunner interface + mssql implementation (query, stream, cancel)
  db/errors.ts            mapConnectError
  db/auth.ts              Entra token + SQL auth config building
  profiles/profileStore.ts  connection profiles (globalState) + passwords (SecretStorage)
  profiles/recentStore.ts   recent CompareRequests
  ui/protocol.ts          webview ⇄ extension message types
  ui/setupPanel.ts        setup webview host
  ui/resultsPanel.ts      results webview host (serves pages of rows)
  ui/diffDocument.ts      TextDocumentContentProvider for scheme `tablediff`
  export/csv.ts           streaming CSV export
webview/
  setup/main.ts, setup/render.ts
  results/main.ts, results/render.ts, results/virtualGrid.ts
  shared/styles.css
test/unit/*.test.ts
test/integration/globalSetup.ts, test/integration/seed.sql, test/integration/*.test.ts
docs/smoke-test-checklist.md
```

---

### Task 0: Scaffold the project

**Goal:** A buildable, testable, empty extension skeleton in a new git repo, with a local SQL Server ready for integration tests.

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `vitest.config.ts`, `vitest.integration.config.ts`, `.gitignore`, `.vscodeignore`, `docker-compose.yml`, `.env.example`, `.env` (not committed), `src/extension.ts` (empty `activate`/`deactivate`), `test/unit/smoke.test.ts`

**Acceptance Criteria:**
- [ ] `git init` is done, and the first commit contains `docs/` plus the scaffold.
- [ ] `npm run compile` produces `dist/extension.js` and `dist/webview/` with no errors.
- [ ] `npm test` runs Vitest over `test/unit` and passes.
- [ ] `docker compose up -d` starts SQL Server 2022 on host port `14333`, and `npm run test:integration` connects (one trivial `SELECT 1` test passes).
- [ ] `.env` is gitignored. `.env.example` documents `MSSQL_SA_PASSWORD` and `TABLEDIFF_TEST_CONN` with placeholder values.

**Verify:** `npm run compile; npm test; npm run test:integration` → all exit 0

**Steps:**

- [ ] **Step 1: Check Docker.** Run `docker version`. If Docker isn't installed or running, stop and ask the user. Integration tests need it, and there's no fallback.
- [ ] **Step 2: Create the manifest.**
  - `package.json`: `name: "synapse-table-diff"`, `displayName: "Table Diff"`, `engines.vscode: "^1.90.0"`, `main: "./dist/extension.js"`, `activationEvents: []`.
  - `contributes.commands` for the four command IDs in Global Constraints, titled `Table Diff: Compare Tables…`, `Table Diff: Add Connection`, `Table Diff: Remove Connection`, `Table Diff: Re-run Recent…`.
  - `contributes.configuration` for `tableDiff.pairLimit` (2000000), `tableDiff.detailLimit` (100000), `tableDiff.inListCap` (5000) and `tableDiff.queryTimeoutSeconds` (3600).
  - Scripts: `compile` (`node esbuild.mjs`), `watch`, `test` (`vitest run -c vitest.config.ts`), `test:integration` (`vitest run -c vitest.integration.config.ts`), `typecheck` (`tsc --noEmit`), `package` (`vsce package`).
  - Dependencies: `mssql`. Dev dependencies: `typescript`, `esbuild`, `vitest`, `jsdom`, `dotenv`, `@types/vscode@1.90.0`, `@types/mssql`, `@types/node@20`, `@vscode/vsce`.
- [ ] **Step 3: Configure esbuild.** `esbuild.mjs` bundles `src/extension.ts` → `dist/extension.js` (cjs, node, `external: ['vscode']`), and `webview/setup/main.ts` and `webview/results/main.ts` → `dist/webview/{setup,results}.js` (iife, browser). It copies `webview/shared/styles.css` into `dist/webview/`.
- [ ] **Step 4: Configure Vitest.**
  - `vitest.config.ts`: include `test/unit/**/*.test.ts`, environment `node`. Render tests opt into jsdom per file.
  - `vitest.integration.config.ts`: include `test/integration/**/*.test.ts`, `setupFiles: ['dotenv/config']`, `globalSetup: 'test/integration/globalSetup.ts'` (a placeholder for now), `testTimeout: 600000`, `fileParallelism: false`.
- [ ] **Step 5: Set up local SQL Server.**
  - `docker-compose.yml`: service `mssql`, image `mcr.microsoft.com/mssql/server:2022-latest`, `ACCEPT_EULA=Y`, `MSSQL_SA_PASSWORD` from `env_file: .env`, port `14333:1433`.
  - Generate a random strong test password into `.env`. Don't echo it in chat.
  - Set `TABLEDIFF_TEST_CONN=Server=localhost,14333;Database=master;User Id=sa;Password=<same>;Encrypt=false;TrustServerCertificate=true`.
- [ ] **Step 6: Add the first tests.** `test/unit/smoke.test.ts`: `expect(1).toBe(1)`. `test/integration/connect.test.ts`: connect with `mssql` using `TABLEDIFF_TEST_CONN`, `SELECT 1 AS x` → `x === 1`.
- [ ] **Step 7: Run Verify, then commit.** `git init; git add -A; git commit -m "chore: scaffold Table Diff extension"`

```json:metadata
{"files": ["package.json", "tsconfig.json", "esbuild.mjs", "vitest.config.ts", "vitest.integration.config.ts", "docker-compose.yml", ".env.example", ".gitignore", ".vscodeignore", "src/extension.ts", "test/unit/smoke.test.ts", "test/integration/connect.test.ts"], "verifyCommand": "npm run compile; npm test; npm run test:integration", "acceptanceCriteria": ["git repo initialised with docs/ and scaffold committed", "npm run compile emits dist/extension.js and dist/webview/", "npm test passes", "docker SQL Server 2022 on 14333 and SELECT 1 integration test passes", ".env gitignored and .env.example documents both variables"], "modelTier": "mechanical"}
```

---

### Task 1: Shared types, SQL text helpers, and type normalization

**Goal:** The single type module, plus pure functions that decide, for each pair of columns, whether and how they can be compared and the T-SQL expression that normalizes them.

**Files:**
- Create: `src/core/types.ts`, `src/core/errors.ts`, `src/sql/sqlText.ts`, `src/sql/normalize.ts`
- Test: `test/unit/sqlText.test.ts`, `test/unit/normalize.test.ts`

**Interfaces (other tasks use these exactly):**
```ts
// types.ts
export type PoolType = 'dedicated' | 'serverless' | 'other';
export type Side = 'left' | 'right';
export interface TableRef { profileId: string; database: string; schema: string; name: string }
export interface CompareRequest { left: TableRef; right: TableRef; keyColumns: string[]; excludedColumns: string[]; filter?: string; ignoreCase: boolean; ignoreTrailingSpaces: boolean }
export interface ColumnInfo { name: string; type: string /* lower-case sys.types name */; maxLength: number; precision: number; scale: number; nullable: boolean; ordinal: number }
export type Family = 'integer'|'exactDecimal'|'approxFloat'|'character'|'datetime'|'time'|'datetimeoffset'|'bit'|'guid'|'binary'|'unsupported';
export type DtPrecision = 'day' | 'minute' | 0|1|2|3|4|5|6|7;
export interface ColumnNorm { family: Exclude<Family,'unsupported'>; decimalScale?: number; floatStyle?: 1|2; dtPrecision?: DtPrecision; rtrim: boolean; upper: boolean }
export interface ColumnPairPlan { name: string; leftName: string; rightName: string; norm: ColumnNorm }
export interface Limits { pairLimit: number; detailLimit: number; inListCap: number; queryTimeoutSeconds: number }
export const DEFAULT_LIMITS: Limits = { pairLimit: 2_000_000, detailLimit: 100_000, inListCap: 5_000, queryTimeoutSeconds: 3600 };
// errors.ts
export class CompareCancelledError extends Error {}
export class PausedPoolError extends Error { constructor(public server: string, public database: string) }
export class PoolUnavailableError extends Error {}
export class ComparePlanError extends Error {}   // e.g. key column missing/incompatible
```
Later tasks add result types (`SchemaDiff`, `ComparePlan`, `CompareResult`, …) to `types.ts`, each in the task that first produces them.

**Acceptance Criteria:**
- [ ] `familyOf` maps every SQL Server type name to its family per the table below.
- [ ] `planColumnPair` returns a plan when the families match, and an exclusion reason otherwise.
- [ ] `normalizeExpr` returns exactly the expressions below.

| Family | Types | normalizeExpr(c) |
|---|---|---|
| integer | tinyint smallint int bigint | `CONVERT(nvarchar(20), CAST(c AS bigint))` |
| exactDecimal | decimal numeric money(19,4) smallmoney(10,4) | `CONVERT(nvarchar(50), CAST(c AS decimal(38,S)))`, with S = max scale. Exclude if max(p−s) + S > 38 |
| approxFloat | float real | `CONVERT(nvarchar(30), CAST(c AS float), F)`, with F = 1 if either side is `real`, else 2 |
| character | char varchar nchar nvarchar | `CAST(c AS nvarchar(max))`, wrapped in `RTRIM(…)` if either side is char/nchar or ignoreTrailingSpaces, then in `UPPER(…)` if ignoreCase |
| datetime | date smalldatetime datetime datetime2 | P = coarsest of the two (order: day < minute < 0 < … < 7; date=day, smalldatetime=minute, datetime=3, datetime2=its scale). day: `CONVERT(nvarchar(10), CAST(c AS date), 23)`. minute: `LEFT(CONVERT(nvarchar(30), CAST(c AS datetime2(0)), 126), 16)`. n: `CONVERT(nvarchar(30), CAST(c AS datetime2(n)), 126)` |
| time | time | `CAST(CAST(c AS time(P)) AS nvarchar(16))`, with P = min scale |
| datetimeoffset | datetimeoffset | `CONVERT(nvarchar(30), CAST(SWITCHOFFSET(c, '+00:00') AS datetime2(P)), 126)`, with P = min scale |
| bit | bit | `CONVERT(nvarchar(1), c)` |
| guid | uniqueidentifier | `CONVERT(nvarchar(36), c)` |
| binary | binary varbinary | `CAST(CONVERT(varchar(max), c, 2) AS nvarchar(max))` |
| unsupported | xml sql_variant geography geometry hierarchyid image text ntext timestamp, and anything else | — (reason: `unsupported type <t>`) |

**Verify:** `npm test -- normalize sqlText` → all pass

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - `sqlText.test.ts`: `quoteIdent('odd]x') === '[odd]]x]'`; `sqlString("it's") === "N'it''s'"`; `qualifiedName({schema:'dbo',name:'a b'}) === '[dbo].[a b]'`.
  - `normalize.test.ts`: one `it` per table row asserting the exact `normalizeExpr('[c]', norm)` string. Plus:
    - `planColumnPair(decimal(10,2), decimal(12,4))` → scale 4;
    - `planColumnPair(varchar(10), int)` → `{ok:false, reason:'incompatible types varchar vs int'}`;
    - `datetime` vs `datetime2(7)` → dtPrecision 3;
    - `date` vs `datetime` → `'day'`;
    - `real` vs `float` → floatStyle 1;
    - `char(5)` vs `varchar(5)` → rtrim true;
    - `xml` on either side → excluded with reason `unsupported type xml`;
    - `decimal(38,0)` vs `decimal(38,10)` → excluded (needs 48 digits).
- [ ] **Step 2: Run the tests to confirm they fail.** `npm test -- normalize sqlText` → FAIL (modules missing).
- [ ] **Step 3: Implement.**
  - `sqlText.ts`: `quoteIdent(s: string): string`, `sqlString(s: string): string`, `qualifiedName(t: {schema:string; name:string}): string`.
  - `normalize.ts`: `familyOf(c: ColumnInfo): Family`; `planColumnPair(l: ColumnInfo, r: ColumnInfo, opts: {ignoreCase: boolean; ignoreTrailingSpaces: boolean}): {ok:true; norm: ColumnNorm} | {ok:false; reason:string}`; `normalizeExpr(colSql: string, norm: ColumnNorm): string`.
  - `types.ts` and `errors.ts` as in Interfaces.
- [ ] **Step 4: Run the tests to confirm they pass.** `npm test -- normalize sqlText` → PASS
- [ ] **Step 5: Commit.** `git commit -m "feat(sql): type families and normalization expressions"`

```json:metadata
{"files": ["src/core/types.ts", "src/core/errors.ts", "src/sql/sqlText.ts", "src/sql/normalize.ts", "test/unit/sqlText.test.ts", "test/unit/normalize.test.ts"], "verifyCommand": "npm test -- normalize sqlText", "acceptanceCriteria": ["familyOf maps every listed type to its family", "planColumnPair returns plan or exclusion reason per the table", "normalizeExpr returns the exact expressions in the table"], "modelTier": "standard"}
```

---

### Task 2: Schema diff and compare plan

**Goal:** Turn two column lists plus a `CompareRequest` into a user-facing `SchemaDiff` and the `ComparePlan` the SQL generator consumes.

**Files:**
- Create: `src/core/schemaDiff.ts`
- Modify: `src/core/types.ts` (add the types below)
- Test: `test/unit/schemaDiff.test.ts`

**Interfaces:**
```ts
export interface SchemaColumnDiff { name: string; status: 'same'|'added'|'removed'|'changed'; left?: ColumnInfo; right?: ColumnInfo; changes: ('type'|'nullability'|'position')[] }
export interface ExcludedColumn { name: string; reason: string /* 'excluded by user' | planColumnPair reason */ }
export interface SchemaDiff { columns: SchemaColumnDiff[]; differenceCount: number }
export interface ComparePlan { keys: ColumnPairPlan[]; compared: ColumnPairPlan[] /* sorted by lower-case name */; excluded: ExcludedColumn[] }
export function diffSchema(left: ColumnInfo[], right: ColumnInfo[], req: CompareRequest): { schema: SchemaDiff; plan: ComparePlan }
```

**Acceptance Criteria:**
- [ ] Columns are matched by case-insensitive name. A column present on one side only is `added` (right only) or `removed` (left only).
- [ ] `changes` lists `type` when the type name, length, precision or scale differ, `nullability` when nullability differs, and `position` when the ordinal rank differs.
- [ ] `differenceCount` = the number of columns whose status isn't `same`.
- [ ] Shared columns that are excluded by the user, or unplannable, go into `excluded` with a reason. Everything else that's shared and not a key goes into `compared`, sorted by lower-case name.
- [ ] A key column missing on either side, or incompatible, or listed in `excludedColumns`, throws `ComparePlanError` naming the column. An empty `keyColumns` list throws too.

**Verify:** `npm test -- schemaDiff` → all pass

**Steps:**

- [ ] **Step 1: Write the failing tests.** Cover:
  - `id`/`ID` matching;
  - `region` added and `legacy_flag` removed;
  - `amount decimal(10,2)` vs `decimal(12,4)` → status `changed`, `changes:['type']`, yet still in `compared`;
  - `qty varchar(10)` vs `int` → `changed` and in `excluded` with reason `incompatible types varchar vs int`;
  - a user-excluded `load_ts` → `excluded`, reason `excluded by user`;
  - key `order_id` missing on the right → throws `ComparePlanError` with `/order_id/`;
  - `compared` order is `['amount','code','created','note','status']` for the fixture columns.
- [ ] **Step 2: Run the tests to confirm they fail.**
- [ ] **Step 3: Implement `diffSchema`.**
- [ ] **Step 4: Run the tests to confirm they pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(core): schema diff and compare plan"`

```json:metadata
{"files": ["src/core/schemaDiff.ts", "src/core/types.ts", "test/unit/schemaDiff.test.ts"], "verifyCommand": "npm test -- schemaDiff", "acceptanceCriteria": ["case-insensitive matching with added/removed", "changes lists type/nullability/position", "differenceCount counts non-same", "excluded vs compared split with reasons, compared sorted", "bad key columns throw ComparePlanError"], "modelTier": "standard"}
```

---

### Task 3: SQL allow-list checker

**Goal:** A test-time guard that every generated query uses only constructs known to run on both dedicated and serverless pools.

**Files:**
- Create: `src/sql/allowList.ts`
- Test: `test/unit/allowList.test.ts`

**Interfaces:** `export function assertAllowedSql(sql: string): void`. It throws `Error('Disallowed SQL: <token>')`.

**Acceptance Criteria:**
- [ ] String literals (`N'…'` / `'…'` with `''` escapes) and bracketed identifiers (`[…]` with `]]`) are stripped before checking.
- [ ] Every word followed by `(` must be in `ALLOWED_FUNCTIONS` = `HASHBYTES CAST CONVERT SUBSTRING COUNT_BIG SUM DATALENGTH RTRIM UPPER LEFT SWITCHOFFSET OBJECT_ID SERVERPROPERTY IN nvarchar varchar decimal datetime2 time float bigint int date`. Matching is case-insensitive; type names appear in `CAST(... AS t(n))`.
- [ ] Every other bare word must be a keyword in `ALLOWED_KEYWORDS` = `SELECT FROM WHERE GROUP BY ORDER AS AND OR NOT IN IS NULL CASE WHEN THEN ELSE END DISTINCT TOP HAVING ASC JOIN ON INNER LEFT`, plus the type names above and `max`. It may also be an alias matching `^(kh|rh|knull|b24|b1|b2|cnt|dk|s1|s2|k_\d+|v_\d+|n_\d+|h|x|name|type_name|max_length|precision|scale|is_nullable|column_id|schema_name|object_name|object_type|is_primary_key|engine_edition|key_ordinal|c|t|s|o|i|ic|object_id|user_type_id|schema_id|type|index_id|is_unique)$`, a number, or a `sys.`-qualified catalog name (`sys.columns`, `sys.types`, `sys.objects`, `sys.schemas`, `sys.indexes`, `sys.index_columns`, `sys.databases`).
- [ ] A three-part dotted name outside brackets (`a.b.c`) is rejected. So are `MERGE`, `#temp`, `EXEC`, `sp_executesql` and `CONCAT`.

**Verify:** `npm test -- allowList` → all pass

**Steps:**

- [ ] **Step 1: Write the failing tests.** Accept `SELECT HASHBYTES('SHA2_256', N'a') AS kh FROM [s].[t]`. Reject each of `MERGE`, `EXEC x`, `SELECT CONCAT(1,2)`, `SELECT * FROM db.s.t`, `SELECT 1 FROM #t`. Accept a literal `N'MERGE'` and an identifier `[EXEC]`.
- [ ] **Step 2: Run the tests to confirm they fail.**
- [ ] **Step 3: Implement** a tokenizer and the checks above.
- [ ] **Step 4: Run the tests to confirm they pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(sql): Synapse-safe SQL allow-list checker"`

```json:metadata
{"files": ["src/sql/allowList.ts", "test/unit/allowList.test.ts"], "verifyCommand": "npm test -- allowList", "acceptanceCriteria": ["literals and bracketed identifiers ignored", "function calls limited to ALLOWED_FUNCTIONS", "bare words limited to keywords/aliases/sys catalog", "three-part names, MERGE, #temp, EXEC, sp_executesql, CONCAT rejected"], "modelTier": "mechanical"}
```

---

### Task 4: Query generator

**Goal:** Every SQL statement the extension sends, generated from a `ComparePlan`, side and table, all passing the allow-list.

**Files:**
- Create: `src/sql/queries.ts`
- Test: `test/unit/queries.test.ts`

**Interfaces:**
```ts
// Side is imported from core/types.ts
export interface BucketFilter { level: 1 | 2; ids: number[] }   // empty ids ⇒ no filter
export function engineEditionQuery(): string                    // SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS engine_edition
export function listDatabasesQuery(): string                    // name from sys.databases
export function listObjectsQuery(): string                      // schema_name, object_name, object_type for sys.objects type IN ('U','V')
export function columnsQuery(t: {schema: string; name: string}): string   // name, type_name, max_length, precision, scale, is_nullable, column_id via OBJECT_ID(<sqlString(qualifiedName)>)
export function declaredKeyQuery(t: {schema: string; name: string}): string // PK/unique columns via sys.indexes + sys.index_columns, ordered by key_ordinal
export function bucketQuery(plan: ComparePlan, side: Side, t: TableRef, filter: string|undefined, level: 1|2, within?: BucketFilter): string
export function pairQuery(plan: ComparePlan, side: Side, t: TableRef, filter: string|undefined, within: BucketFilter): string
export function detailQuery(plan: ComparePlan, side: Side, t: TableRef, filter: string|undefined, within: BucketFilter): string
```
Shape of the hashed derived table, shared by the last three (`kN`/`vN` are raw columns, `nN` normalized, `<seg>` per Global Constraints):
```sql
SELECT <outer cols> FROM (
  SELECT h.*, CAST(SUBSTRING(h.kh,1,3) AS int) AS b24 FROM (
    SELECT HASHBYTES('SHA2_256', <key segs>) AS kh, HASHBYTES('SHA2_256', <row segs>) AS rh,
           CASE WHEN <k0 IS NULL OR …> THEN 1 ELSE 0 END AS knull <, extra cols>
    FROM <qualifiedName> WHERE (
<filter>
)) AS h ) AS x
WHERE <bucket expr for within.level> IN (<ids>)          -- omitted when ids empty
```
- `bucketQuery` outer columns: `<bucket expr> AS b1|b2, cnt, dk, s1, s2`, `GROUP BY <bucket expr>`.
- `pairQuery`: `kh, rh, knull, <b2 expr> AS b2, k_0…k_n` (raw key values), `ORDER BY kh`.
- `detailQuery`: `kh, k_0…, v_0…` (raw compared values, in `plan.compared` order), `n_0…` (normalized compared values), `ORDER BY kh`.

The left side uses `leftName` and the right side `rightName` for each column. Names differ only in case.

**Acceptance Criteria:**
- [ ] Every function's output passes `assertAllowedSql` for the fixture plan.
- [ ] Hash, bucket and aggregate expressions match Global Constraints character-for-character. Assert on substrings.
- [ ] Odd identifiers are quoted: table `odd name]x` → `[dbo].[odd name]]x]`, column `it's` → `[it's]`.
- [ ] Filter handling: `undefined`, `''` and `'   '` → no inner WHERE. `"region = 'EU' -- eu only"` → `WHERE (\nregion = 'EU' -- eu only\n)`, with the closing paren on its own line. Exempt the filter text from the allow-list in this test by allow-listing the query generated with no filter, plus the substring check.
- [ ] With zero compared columns, `rh` is `HASHBYTES('SHA2_256', N'')`.
- [ ] A level-2 `within` with ids `[5, 9]` renders `CASE WHEN knull=1 THEN -1 ELSE b24/16 END IN (5,9)`.

**Verify:** `npm test -- queries` → all pass

**Steps:**

- [ ] **Step 1: Write the failing tests** for each criterion above, using a fixture `ComparePlan` built with `diffSchema` from Task 2.
- [ ] **Step 2: Run the tests to confirm they fail.**
- [ ] **Step 3: Implement `queries.ts`.** Build the segment expression with a helper `segment(v: string): string`.
- [ ] **Step 4: Run the tests to confirm they pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(sql): query generator for checksum, pair and detail passes"`

```json:metadata
{"files": ["src/sql/queries.ts", "test/unit/queries.test.ts"], "verifyCommand": "npm test -- queries", "acceptanceCriteria": ["all queries pass assertAllowedSql", "hash/bucket/aggregate expressions match Global Constraints", "odd identifiers quoted", "blank and comment-terminated filters handled", "zero compared columns uses empty-string hash", "level-2 bucket filter rendered exactly"], "modelTier": "standard"}
```

---

### Task 5: Database layer: runner, streaming, cancellation, error mapping

**Goal:** Open one connection per pass, run queries or stream rows with backpressure, cancel them with an `AbortSignal`, and turn Synapse connection errors into clear errors.

**Files:**
- Create: `src/db/runner.ts`, `src/db/errors.ts`
- Test: `test/unit/dbErrors.test.ts`, `test/integration/runner.test.ts`

**Interfaces:**
```ts
export interface QueryRunner {
  query<T = Record<string, unknown>>(sql: string, signal?: AbortSignal): Promise<T[]>;
  stream<T = Record<string, unknown>>(sql: string, signal?: AbortSignal): AsyncIterable<T>; // breaking out of the loop cancels the request
  close(): Promise<void>;
}
export interface SideConnector { label: string; poolType: PoolType; open(): Promise<QueryRunner> }  // open() fetches a fresh token each call
export function openRunner(config: import('mssql').config, timeoutSeconds: number): Promise<QueryRunner>
export function mapConnectError(err: unknown, server: string, database: string): Error
```

**Acceptance Criteria:**
- [ ] `mapConnectError`:
  - error number `42108` → `PausedPoolError` with message `Pool "<database>" on <server> is paused. Resume it in the Azure portal and try again.`;
  - `42109` → `PoolUnavailableError("Pool \"<database>\" is resuming; try again in a minute.")`;
  - `40613` → `PoolUnavailableError("<database> on <server> is not currently available.")`;
  - anything else is returned unchanged.
- [ ] `stream` yields rows in order, uses `request.pause()`/`resume()` so no more than 1,000 rows are buffered, and ends cleanly when the consumer `break`s (request cancelled, no unhandled rejection).
- [ ] An aborted signal cancels the running request and rejects, or throws from the iterator, with `CompareCancelledError`.
- [ ] `binary`/`varbinary` values (`kh`, `rh`) come back as `Buffer`.

**Verify:** `npm test -- dbErrors; npm run test:integration -- runner` → all pass

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - Unit: one test per error-number mapping, plus pass-through.
  - Integration, against `TABLEDIFF_TEST_CONN`:
    - `query('SELECT 1 AS x')`;
    - `stream` over `SELECT TOP 5000 …` from a numbers derived table counts 5000 rows;
    - a `break` after 10 rows leaves the runner usable for a following `query`;
    - aborting during `SELECT … WAITFOR`-free long stream rejects with `CompareCancelledError` (use a cross join of `sys.all_objects` to make it long; integration SQL isn't allow-list checked).
- [ ] **Step 2: Run the tests to confirm they fail.**
- [ ] **Step 3: Implement.** Use `new sql.ConnectionPool({...config, pool:{max:1}, requestTimeout: timeoutSeconds*1000})`. For streams, set `request.stream = true` and bridge the `row`/`done`/`error` events to an async iterator with a bounded queue.
- [ ] **Step 4: Run the tests to confirm they pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(db): query runner with streaming, cancellation and error mapping"`

```json:metadata
{"files": ["src/db/runner.ts", "src/db/errors.ts", "test/unit/dbErrors.test.ts", "test/integration/runner.test.ts"], "verifyCommand": "npm test -- dbErrors; npm run test:integration -- runner", "acceptanceCriteria": ["42108/42109/40613 mapped to exact messages", "stream yields in order with bounded buffering and clean break", "abort rejects with CompareCancelledError", "binary columns returned as Buffer"], "modelTier": "standard"}
```

---

### Task 6: Pure diff logic: bucket compare, streaming merge, cell diff

**Goal:** All in-memory comparison logic, independent of the database, as pure functions over plain data and async iterables.

**Files:**
- Create: `src/core/buckets.ts`, `src/core/merge.ts`, `src/core/cellDiff.ts`
- Modify: `src/core/types.ts`
- Test: `test/unit/buckets.test.ts`, `test/unit/merge.test.ts`, `test/unit/cellDiff.test.ts`

**Interfaces:**
```ts
export interface BucketRow { b: number; cnt: bigint; dk: bigint; s1: string; s2: string }  // s1/s2 as decimal strings
export interface BucketCompare { mismatched: number[]; problem: number[] /* cnt≠dk on either side, or b=-1 */; rowsInScope: number /* Σ cnt over mismatched ∪ problem, both sides */; leftRows: number; rightRows: number; leftDupRows: number; rightDupRows: number; leftNullKeyRows: number; rightNullKeyRows: number }
export function compareBuckets(left: BucketRow[], right: BucketRow[]): BucketCompare
export interface PairRow { kh: Buffer; rh: Buffer; knull: number; b2: number; keys: unknown[] }
export interface DiffKey { kind: ChangeKind; khHex: string; b2: number }
export type ChangeKind = 'added' | 'removed' | 'changed';
export interface KeyProblems { duplicateKeys: { side: Side; key: string[]; count: number }[]; nullKeys: { side: Side; key: (string|null)[] }[]; leftDupRows: number; rightDupRows: number; leftNullKeyRows: number; rightNullKeyRows: number }
export interface MergeResult { added: number; removed: number; changed: number; selected: DiffKey[] /* first detailLimit in kh order */; duplicateSamples: KeyProblems['duplicateKeys']; nullKeySamples: KeyProblems['nullKeys'] }
export async function mergePairs(left: AsyncIterable<PairRow>, right: AsyncIterable<PairRow>, detailLimit: number, signal?: AbortSignal): Promise<MergeResult>
export function formatValue(v: unknown): string | null       // null→null, Date→ISO, Buffer→0x hex upper, bigint/number→String, else String
export interface DiffRow { kind: ChangeKind; key: string[]; left?: (string|null)[]; right?: (string|null)[]; changedColumns: string[] }
export function buildDiffRow(kind: ChangeKind, keyCount: number, compared: string[], left?: Record<string, unknown>, right?: Record<string, unknown>): DiffRow  // uses n_i to decide changed cells, v_i/k_i for display
```

**Merge algorithm** (both inputs sorted by `kh` ascending, byte-wise, which equals lower-case hex string order):
- Read one *run* of equal `kh` from each side.
- Any row in a run with `knull=1` goes to `nullKeySamples` (up to 100 per side) and is skipped.
- A run of length > 1 on either side is a duplicate: record up to 100 samples per side, and skip that `kh` on both sides.
- Then advance the smaller `kh`, or both when equal:
  - left only → `removed`;
  - right only → `added`;
  - equal `kh` with a different `rh` → `changed`.
- Push to `selected` while `selected.length < detailLimit`.
- Check `signal` every 10,000 rows and throw `CompareCancelledError` if aborted.

**Acceptance Criteria:**
- [ ] `compareBuckets`:
  - a bucket on one side only is mismatched;
  - equal buckets aren't;
  - a bucket with `cnt≠dk` on either side is in `problem` even if equal;
  - `b=-1` is in `problem`;
  - dup rows = Σ(cnt−dk); null-key rows = cnt of `b=-1`.
- [ ] `mergePairs`:
  - exact counts on interleaved inputs;
  - duplicates on one side are excluded from both sides and sampled;
  - null-key rows are excluded and sampled;
  - `selected` is capped at `detailLimit` while counts keep growing;
  - empty left with 3 right rows → added 3;
  - both empty → zeros.
- [ ] `buildDiffRow`:
  - `changedColumns` lists the compared names whose `n_i` differ;
  - an added row has `right` only;
  - a NULL vs `''` difference is detected (n is `null` vs `''`).

**Verify:** `npm test -- buckets merge cellDiff` → all pass

**Steps:**

- [ ] **Step 1: Write the failing tests** for each criterion, using hand-built rows and async generators.
- [ ] **Step 2: Run the tests to confirm they fail.**
- [ ] **Step 3: Implement the three modules.**
- [ ] **Step 4: Run the tests to confirm they pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(core): bucket compare, streaming merge and cell diff"`

```json:metadata
{"files": ["src/core/buckets.ts", "src/core/merge.ts", "src/core/cellDiff.ts", "src/core/types.ts", "test/unit/buckets.test.ts", "test/unit/merge.test.ts", "test/unit/cellDiff.test.ts"], "verifyCommand": "npm test -- buckets merge cellDiff", "acceptanceCriteria": ["compareBuckets mismatched/problem/row tallies correct", "mergePairs exact counts, duplicates and null keys excluded and sampled, selected capped", "empty-side cases handled", "buildDiffRow changedColumns from normalized values incl NULL vs empty"], "modelTier": "standard"}
```

---

### Task 7: Comparison pipeline plus end-to-end integration tests

**Goal:** `runComparison`, which ties the schema step, pass 1 (with optional re-bucketing), pass 2 and pass 3 into a `CompareResult`. It's proven against seeded local databases covering every case in the spec.

**Files:**
- Create: `src/core/pipeline.ts`, `test/integration/seed.sql`, `test/integration/pipeline.test.ts`
- Modify: `test/integration/globalSetup.ts`, `src/core/types.ts`

**Interfaces:**
```ts
export type Stage = 'schema' | 'checksums' | 'rebucket' | 'compare' | 'details';
export interface CompareResult { request: CompareRequest; schema: SchemaDiff; plan: ComparePlan; leftRows: number; rightRows: number; added: number; removed: number; changed: number; rows: DiffRow[] /* sorted by key, numeric-aware */; detailCapped: boolean; keyProblems: KeyProblems; warnings: string[]; durationMs: number; poolTypes: { left: PoolType; right: PoolType } }
export interface PipelineDeps { left: SideConnector; right: SideConnector; limits: Limits; signal?: AbortSignal; onProgress?: (stage: Stage, detail?: string) => void; confirmExtraScan?: (serverlessSides: Side[]) => Promise<boolean> }
export function runComparison(req: CompareRequest, deps: PipelineDeps): Promise<CompareResult>
```

**Pipeline** (each step opens fresh runners via `open()` on both sides in parallel, and closes them in `finally`):
1. **schema:** run `columnsQuery` on each side → `diffSchema`.
2. **checksums:** run `bucketQuery` level 1 → `compareBuckets`.
   - If everything is equal and there are no problems, return zero differences, skipping passes 2 and 3.
3. **rebucket:** only if `rowsInScope > pairLimit`.
   - If any side is serverless and `confirmExtraScan` returns `false`, skip re-bucketing.
   - Otherwise run `bucketQuery` level 2 within the level-1 mismatched ids (excluding −1), and compare. The pass-2 filter becomes the mismatched or problem level-2 ids, plus `-1` if level 1 had it. Fall back to the level-1 ids when there are more than `inListCap`.
4. **compare:** run `pairQuery` streams on both sides → `mergePairs`.
5. **details:**
   - Fetch the distinct `b2` of `selected` (level-1 fallback over `inListCap`) with `detailQuery` streams.
   - Keep the rows whose `kh` is selected, and `break` once all expected `kh` for that side are found.
   - Build rows with `buildDiffRow`, then sort by key using `Intl.Collator(undefined, {numeric: true})` over the joined key parts.
6. **warnings:**
   - `"Duplicate or NULL keys found; those keys are excluded, so the data diff is incomplete for them."` when any key problem exists;
   - `"Showing the first N of M differing rows."` when capped.

**Seed** (`seed.sql`, run by `globalSetup` after `DROP DATABASE IF EXISTS`; batches split on `GO`). Databases `tablediff_a` (left) and `tablediff_b` (right), each `dbo`:
- `orders`, 50,000 rows, keys 1..50000.
  - Left columns: `order_id int, status varchar(20), amount decimal(10,2), created datetime, note nvarchar(max) NULL, code char(5), qty varchar(10), legacy_flag bit`.
  - Right columns: `ORDER_ID int, status nvarchar(20), amount decimal(12,4), created datetime2(7), note nvarchar(max) NULL, code varchar(5), qty int, region varchar(10)`.
  - Same values except:
    - keys 10–19 are missing on the right;
    - keys 50001–50005 exist only on the right;
    - `status` differs for 100–149;
    - `amount` 1.23 → 1.24 for key 200;
    - `note` NULL vs `''` for key 300;
    - `status` `'Open'` vs `'OPEN'` for key 400;
    - `note` `'x'` vs `'x '` for key 500.
- `lines` (`order_id int, line_no int NULL, sku varchar(10)`), 100 rows on each side.
  - Left has the key (1,1) twice.
  - Right has one row with `line_no` NULL.
  - Key (2,1) has a different `sku`.
- `[odd name]]x]` (`[it's] int, val nvarchar(10)`): 3 identical rows on each side.
- `empty_t (id int, v int)`: empty on the left, 3 rows on the right. Also add `empty_both`, empty on both sides.
- `big (id bigint, v int, w varchar(20))`: `TABLEDIFF_BIG_ROWS` rows (default 3,000,000) on each side, with `v` changed on the right for 1,000 ids spread across the range (`id % 3000 = 7`).

**Acceptance Criteria:**
- [ ] `orders` with the defaults:
  - removed 10, added 5, changed 54;
  - schema: `region` added, `legacy_flag` removed, `qty` excluded as incompatible;
  - amount, created, code and status type-only changes produce no data differences.
- [ ] `orders` with `ignoreCase` → changed 53. With `ignoreTrailingSpaces` → changed 53.
- [ ] `orders` with `detailLimit: 20` → `rows.length === 20`, `detailCapped`, counts unchanged.
- [ ] `orders` with `pairLimit: 100` → the `rebucket` stage runs and the counts are identical.
- [ ] `lines`: one duplicate sample on the left, one null-key sample on the right, changed 1, and the incomplete warning is present.
- [ ] Odd name: 0 differences. `empty_t`: added 3. `empty_both`: all zeros.
- [ ] Same database, two tables (`tablediff_a.dbo.orders` vs `tablediff_a.dbo.orders_copy`, an identical `SELECT INTO` copy made by the seed): 0 differences.
- [ ] `big`: changed 1000 with defaults, finishing in under 5 minutes locally.
- [ ] Aborting after the first `checksums` progress event rejects with `CompareCancelledError`, and every opened runner was closed (count opens and closes with a wrapping `SideConnector`).

**Verify:** `npm run test:integration -- pipeline` → all pass

**Steps:**

- [ ] **Step 1: Write `seed.sql` and extend `globalSetup`** to run it, with `TABLEDIFF_BIG_ROWS` substituted. Use a set-based numbers source such as a cross join of `sys.all_objects`; seed SQL isn't allow-list checked.
- [ ] **Step 2: Write the failing integration tests** for each criterion. The test helper builds `SideConnector`s from `TABLEDIFF_TEST_CONN` with `database` overridden per `TableRef`, and `poolType: 'other'`. For the rebucket test, use `poolType: 'serverless'` on one side and a `confirmExtraScan` spy that returns `true`, and assert it was called once.
- [ ] **Step 3: Run the tests to confirm they fail.**
- [ ] **Step 4: Implement `runComparison`.** Check `signal` between stages, and pass it to every query and stream.
- [ ] **Step 5: Run the tests to confirm they pass.** Record the `big` duration in the commit message.
- [ ] **Step 6: Commit.** `git commit -m "feat(core): three-pass comparison pipeline with end-to-end tests"`

```json:metadata
{"files": ["src/core/pipeline.ts", "src/core/types.ts", "test/integration/seed.sql", "test/integration/globalSetup.ts", "test/integration/pipeline.test.ts"], "verifyCommand": "npm run test:integration -- pipeline", "acceptanceCriteria": ["orders defaults: removed 10, added 5, changed 54, schema diffs as specified, no type-only data diffs", "ignoreCase and ignoreTrailingSpaces each give changed 53", "detailLimit 20 caps rows with exact counts", "pairLimit 100 triggers rebucket with identical counts and confirmExtraScan called once", "lines: duplicate and null-key samples, changed 1, warning", "odd name 0 diffs, empty_t added 3, empty_both zeros, same-db copy 0 diffs", "big: changed 1000 under 5 minutes", "abort rejects CompareCancelledError and closes all runners"], "modelTier": "frontier"}
```

---

### Task 8: Connection profiles and authentication

**Goal:** Saved connection profiles, Add and Remove Connection commands, and building `SideConnector`s with a fresh Entra token, or a stored SQL password, on every `open()`.

**Files:**
- Create: `src/profiles/profileStore.ts`, `src/db/auth.ts`, `src/profiles/recentStore.ts`
- Test: `test/unit/profileStore.test.ts`, `test/unit/auth.test.ts`, `test/unit/recentStore.test.ts`

**Interfaces:**
```ts
export interface ConnectionProfile { id: string; name: string; server: string; database: string; auth: 'entra' | 'sql'; user?: string; tenantId?: string }
export class ProfileStore { constructor(state: vscode.Memento, secrets: vscode.SecretStorage); list(): ConnectionProfile[]; get(id: string): ConnectionProfile | undefined; save(p: ConnectionProfile, password?: string): Promise<void>; remove(id: string): Promise<void>; password(id: string): Promise<string | undefined> }
// globalState key 'tableDiff.profiles'; secret key `tableDiff.pwd.${id}`
export type TokenProvider = (tenantId?: string) => Promise<string>;
export function entraTokenProvider(auth: typeof vscode.authentication): TokenProvider
// scopes: ['https://database.windows.net//.default'] plus `VSCODE_TENANT:${tenantId}` when set; createIfNone: true
export function buildMssqlConfig(p: ConnectionProfile, database: string, secret: { token?: string; password?: string }): import('mssql').config
// encrypt: true; entra → authentication {type:'azure-active-directory-access-token', options:{token}}; sql → user/password
export function makeConnector(p: ConnectionProfile, database: string, store: ProfileStore, tokens: TokenProvider, timeoutSeconds: number): Promise<SideConnector>
// detects poolType once via engineEditionQuery: 6→dedicated, 11→serverless, else other; every open() refetches token; connect errors pass through mapConnectError
export class RecentStore { constructor(state: vscode.Memento); list(): CompareRequest[]; add(r: CompareRequest): Promise<void> } // key 'tableDiff.recent', newest first, max 10, deduped by JSON equality
```

**Acceptance Criteria:**
- [ ] Passwords are stored only in `SecretStorage`, and never appear in the `globalState` value.
- [ ] `remove` deletes both the profile and its secret.
- [ ] `entraTokenProvider` requests the exact scopes above.
- [ ] `buildMssqlConfig` produces the exact auth blocks above, with `encrypt: true`.
- [ ] `makeConnector` calls the token provider on every `open()` (two opens → two calls).
- [ ] `RecentStore` keeps 10, newest first, deduped.

**Verify:** `npm test -- profileStore auth recentStore` → all pass

**Steps:**

- [ ] **Step 1: Write the failing tests**, using in-memory fakes for `Memento`, `SecretStorage` and `authentication.getSession`. Mock `openRunner` with `vi.mock('../../src/db/runner')`.
- [ ] **Step 2: Run the tests to confirm they fail.**
- [ ] **Step 3: Implement.** In `extension.ts`, register `tableDiff.addConnection`: InputBoxes for name, server and database, a QuickPick for auth (Entra ID / SQL login), an optional tenant ID, and user/password for SQL. Then run a test connection with `engineEditionQuery`. Report the detected pool type on success, or the mapped error, before saving. Register `tableDiff.removeConnection` as a QuickPick plus a modal confirm.
- [ ] **Step 4: Run the tests to confirm they pass.** Also run `npm run compile; npm run typecheck`.
- [ ] **Step 5: Commit.** `git commit -m "feat(profiles): connection profiles, Entra/SQL auth, recent comparisons"`

```json:metadata
{"files": ["src/profiles/profileStore.ts", "src/profiles/recentStore.ts", "src/db/auth.ts", "src/extension.ts", "test/unit/profileStore.test.ts", "test/unit/auth.test.ts", "test/unit/recentStore.test.ts"], "verifyCommand": "npm test -- profileStore auth recentStore", "acceptanceCriteria": ["passwords only in SecretStorage", "remove deletes profile and secret", "entra scopes exact incl tenant", "mssql config auth blocks exact with encrypt true", "token fetched on every open()", "RecentStore max 10 newest first deduped"], "modelTier": "standard"}
```

---

### Task 9: Setup panel (webview)

**Goal:** The "Compare Tables…" form. You pick a connection, database, schema and table for each side; choose key columns (pre-filled from declared keys); exclude columns; enter a filter; toggle the two string options; and press Run, which posts a valid `CompareRequest`.

**Files:**
- Create: `src/ui/protocol.ts`, `src/ui/setupPanel.ts`, `webview/setup/main.ts`, `webview/setup/render.ts`, `webview/shared/styles.css`
- Test: `test/unit/setupRender.test.ts` (jsdom)

**Interfaces:**
```ts
// protocol.ts — setup
export type SetupToHost =
  | { type: 'listDatabases'; side: Side; profileId: string }
  | { type: 'listObjects'; side: Side; profileId: string; database: string }
  | { type: 'describe'; side: Side; ref: TableRef }          // → columns + declared key + poolType
  | { type: 'run'; request: CompareRequest };
export type HostToSetup =
  | { type: 'init'; profiles: { id: string; name: string }[]; initial?: CompareRequest }
  | { type: 'databases'; side: Side; names: string[] }
  | { type: 'objects'; side: Side; objects: { schema: string; name: string; kind: 'table' | 'view' }[] }
  | { type: 'described'; side: Side; columns: ColumnInfo[]; declaredKey: string[]; poolType: PoolType }
  | { type: 'error'; message: string };
// render.ts
export interface SetupState { profiles: {id:string;name:string}[]; sides: Record<Side, { profileId?: string; database?: string; table?: {schema:string;name:string}; databases: string[]; objects: {schema:string;name:string;kind:string}[]; columns: ColumnInfo[]; declaredKey: string[]; poolType?: PoolType }>; keyColumns: string[]; excludedColumns: string[]; filter: string; ignoreCase: boolean; ignoreTrailingSpaces: boolean }
export function renderSetup(root: HTMLElement, state: SetupState): void
export function canRun(state: SetupState): { ok: boolean; reason?: string }
```

**Acceptance Criteria:**
- [ ] Key and exclude choices list only the columns shared by both sides (case-insensitive).
- [ ] When both sides are described, the keys are pre-filled from the left side's declared key if every declared column is shared; otherwise they're left empty.
- [ ] `canRun` is false, with a reason, when a side is incomplete, no key is chosen, or a key is also excluded.
- [ ] The serverless note `This side is a serverless pool: a comparison scans its data about three times, and you're billed per data processed.` shows when either side's `poolType` is `serverless`.
- [ ] The webview uses a strict CSP (`default-src 'none'`, nonce script, `${webview.cspSource}` styles) and VS Code theme CSS variables.
- [ ] Opening from Re-run Recent pre-fills from `initial`.

**Verify:** `npm test -- setupRender; npm run compile` → pass, then a manual check: F5 → "Table Diff: Compare Tables…" opens the form

**Steps:**

- [ ] **Step 1: Write the failing jsdom tests** for the shared-columns list, key pre-fill, the `canRun` cases and the serverless note.
- [ ] **Step 2: Run the tests to confirm they fail.**
- [ ] **Step 3: Implement.**
  - `render.ts` is pure DOM rendering from state.
  - `main.ts` holds state, posts messages and re-renders.
  - `setupPanel.ts` (`SetupPanel.show(ctx, deps, initial?)`) answers the messages with `listDatabasesQuery`, `listObjectsQuery`, `columnsQuery` and `declaredKeyQuery`. A failing `declaredKeyQuery` → `[]`.
  - On `run`, the panel calls `deps.onRun(request)`.
- [ ] **Step 4: Run the tests to confirm they pass, and compile.**
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): comparison setup panel"`

```json:metadata
{"files": ["src/ui/protocol.ts", "src/ui/setupPanel.ts", "webview/setup/main.ts", "webview/setup/render.ts", "webview/shared/styles.css", "test/unit/setupRender.test.ts"], "verifyCommand": "npm test -- setupRender; npm run compile", "acceptanceCriteria": ["key/exclude lists show only shared columns", "key prefilled from declared key when all shared", "canRun false with reason for incomplete side, no key, key excluded", "serverless note shown with exact text", "strict CSP and theme variables", "initial request pre-fills form"], "modelTier": "standard"}
```

---

### Task 10: Results panel (webview)

**Goal:** Show a `CompareResult`: a summary header with warnings, then Schema, Data and Key problems tabs. The Data tab has a kind filter and a virtualized grid fed by row pages from the host, with Open in diff editor and Export CSV buttons.

**Files:**
- Create: `src/ui/resultsPanel.ts`, `webview/results/main.ts`, `webview/results/render.ts`, `webview/results/virtualGrid.ts`
- Modify: `src/ui/protocol.ts`
- Test: `test/unit/resultsRender.test.ts`, `test/unit/virtualGrid.test.ts` (jsdom)

**Interfaces:**
```ts
export type ResultsToHost = { type: 'page'; kind: ChangeKind | 'all'; offset: number; limit: number } | { type: 'openDiff' } | { type: 'exportCsv' };
export type HostToResults =
  | { type: 'summary'; summary: Omit<CompareResult, 'rows'>; totalByKind: Record<ChangeKind | 'all', number> /* of rows held */ }
  | { type: 'rows'; kind: ChangeKind | 'all'; offset: number; rows: DiffRow[] };
export function renderSummary(root: HTMLElement, s: Omit<CompareResult,'rows'>): void
export function renderSchemaTab(root: HTMLElement, s: SchemaDiff, excluded: ExcludedColumn[]): void
export function renderKeyProblems(root: HTMLElement, k: KeyProblems): void
export class VirtualGrid { constructor(root: HTMLElement, columns: string[], rowHeight: number /* 24 */, fetchPage: (offset: number, limit: number) => void); setTotal(n: number): void; setRows(offset: number, rows: DiffRow[]): void; visibleRange(): { start: number; end: number } }
```

**Acceptance Criteria:**
- [ ] The summary shows left/right row counts, the changed/added/removed counts, the schema difference count and the duration, formatted with thousands separators (e.g. `42,100,000`).
- [ ] Every `warnings` entry appears in a banner with class `warning`.
- [ ] The Schema tab shows a side-by-side column table. Status classes `added`, `removed` and `changed` use the theme colours `--vscode-gitDecoration-addedResourceForeground`, `--vscode-gitDecoration-deletedResourceForeground` and `--vscode-gitDecoration-modifiedResourceForeground`. Excluded columns are listed with their reasons.
- [ ] Data grid columns: kind, then key columns, then one cell per compared column.
  - A changed row shows `left → right` in changed cells, with class `cell-changed`, and plain values elsewhere.
  - Added rows are green and removed rows red, using the same variables.
  - NULL is rendered as an italic `NULL`.
- [ ] `VirtualGrid` renders only the visible rows plus a 20-row overscan. Scrolling requests pages of 200 that aren't loaded yet.
- [ ] The host serves pages from the held `rows` filtered by kind.

**Verify:** `npm test -- resultsRender virtualGrid; npm run compile` → pass

**Steps:**

- [ ] **Step 1: Write the failing jsdom tests** for summary formatting, the warning banner, schema status classes, a changed cell showing `open → closed`, NULL rendering, and the virtual grid requesting offset 200 after scrolling past row 180 with a 600px viewport.
- [ ] **Step 2: Run the tests to confirm they fail.**
- [ ] **Step 3: Implement.** `ResultsPanel.show(ctx, result, actions: { openDiff(): void; exportCsv(): void })`.
- [ ] **Step 4: Run the tests to confirm they pass, and compile.**
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): results panel with virtualized diff grid"`

```json:metadata
{"files": ["src/ui/resultsPanel.ts", "src/ui/protocol.ts", "webview/results/main.ts", "webview/results/render.ts", "webview/results/virtualGrid.ts", "test/unit/resultsRender.test.ts", "test/unit/virtualGrid.test.ts"], "verifyCommand": "npm test -- resultsRender virtualGrid; npm run compile", "acceptanceCriteria": ["summary counts with thousands separators", "warnings in .warning banner", "schema tab status classes and excluded reasons", "grid shows left → right in .cell-changed, colours for added/removed, italic NULL", "virtual grid renders visible+20 overscan and pages of 200", "host serves pages filtered by kind"], "modelTier": "standard"}
```

---

### Task 11: Diff-editor view and CSV export

**Goal:** Render the detail rows as two aligned text documents for VS Code's diff editor, and stream them to CSV.

**Files:**
- Create: `src/ui/diffDocument.ts`, `src/export/csv.ts`
- Test: `test/unit/diffDocument.test.ts`, `test/unit/csv.test.ts`

**Interfaces:**
```ts
export function renderSideText(result: CompareResult, side: Side): string
// one line per row present on that side, in result.rows order: `<k1>=<v>, <k2>=<v> | <col>=<v> | …` (compared columns in plan order, NULL as `NULL`); header line `-- <db>.<schema>.<table> (showing N of M differences)`
export class DiffDocumentProvider implements vscode.TextDocumentContentProvider { set(runId: string, result: CompareResult): void; provideTextDocumentContent(uri: vscode.Uri): string } // uri tablediff:/<runId>/left.txt | right.txt
export async function writeCsv(result: CompareResult, out: NodeJS.WritableStream): Promise<void>
// header: change_type, <key cols>, then left_<col>, right_<col> per compared column; RFC 4180 quoting; NULL → empty field; UTF-8 BOM first
```

**Acceptance Criteria:**
- [ ] Added rows appear only in the right text and removed rows only in the left. Changed rows appear in both, on corresponding lines.
- [ ] The diff editor opens with title `Table Diff: <left table> ↔ <right table>`.
- [ ] CSV values containing a comma, quote or newline are quoted, with quotes doubled. The file starts with `﻿`.
- [ ] Export uses `showSaveDialog` (default name `table-diff.csv`), streams to `fs.createWriteStream`, and shows `Exported N rows (first N of M differences).` when capped.

**Verify:** `npm test -- diffDocument csv` → all pass

**Steps:**

- [ ] **Step 1: Write the failing tests** for line layout and side membership, the header line, CSV quoting of `a,"b"\nc`, the BOM, and the NULL → empty field.
- [ ] **Step 2: Run the tests to confirm they fail.**
- [ ] **Step 3: Implement both modules.**
- [ ] **Step 4: Run the tests to confirm they pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: diff-editor view and CSV export"`

```json:metadata
{"files": ["src/ui/diffDocument.ts", "src/export/csv.ts", "test/unit/diffDocument.test.ts", "test/unit/csv.test.ts"], "verifyCommand": "npm test -- diffDocument csv", "acceptanceCriteria": ["side texts contain correct rows in aligned order with header", "diff editor title exact", "CSV RFC 4180 quoting with BOM and NULL as empty", "export via save dialog and capped message"], "modelTier": "mechanical"}
```

---

### Task 12: Wire up the extension

**Goal:** Connect commands, settings, progress, cancellation, the serverless confirmation, recent comparisons, and the setup and results panels into a working extension.

**Files:**
- Modify: `src/extension.ts`
- Test: `test/unit/extensionWiring.test.ts`

**Interfaces:** `export function activate(ctx: vscode.ExtensionContext): void`. Internally `runFromRequest(req: CompareRequest): Promise<void>`:
- Read `Limits` from `tableDiff.*` settings.
- Build connectors with `makeConnector`.
- Run `vscode.window.withProgress({location: Notification, cancellable: true, title: 'Table Diff'})`, mapping each `Stage` to `Reading schemas…`, `Computing checksums…`, `Narrowing differences…`, `Comparing keys…` or `Fetching changed rows…`. The progress token's cancellation goes to an `AbortController`.
- `confirmExtraScan` = a modal `showWarningMessage('Many differences found. Narrowing further needs one more scan of the serverless side(s) (billed per data processed). Continue?', {modal: true}, 'Continue')`.
- On success: `RecentStore.add(req)`, then `ResultsPanel.show`.
- On `CompareCancelledError`: an info message `Comparison cancelled.`, and no panel.
- On `PausedPoolError`, `PoolUnavailableError` or `ComparePlanError`: an error message with the error text.
- Anything else: an error message `Comparison failed: <message>`.

**Acceptance Criteria:**
- [ ] The four commands are registered with the IDs from Global Constraints.
- [ ] `tableDiff.rerunRecent` shows a QuickPick of recent requests, labelled `left.schema.name ↔ right.schema.name`, and opens the setup panel pre-filled.
- [ ] Cancelling progress aborts the pipeline, and no results panel opens.
- [ ] Each error class maps to the message described above.
- [ ] Settings changes take effect on the next run.

**Verify:** `npm test -- extensionWiring; npm run typecheck; npm run compile` → pass, then a manual F5 run against the local Docker DB: compare `tablediff_a.dbo.orders` vs `tablediff_b.dbo.orders` and see removed 10, added 5, changed 54

**Steps:**

- [ ] **Step 1: Write the failing tests** with a mocked `vscode` module (`vi.mock('vscode', …)`) and a stubbed `runComparison`. Cover the cancel → `Comparison cancelled.` path, `PausedPoolError` → `showErrorMessage` with its message, success → `RecentStore.add` and `ResultsPanel.show` both called, and the rerunRecent label format.
- [ ] **Step 2: Run the tests to confirm they fail.**
- [ ] **Step 3: Implement the wiring.**
- [ ] **Step 4: Run the tests to confirm they pass. Then do the manual F5 check**, using a SQL-auth profile pointed at `localhost,14333` with the `.env` credentials.
- [ ] **Step 5: Commit.** `git commit -m "feat: wire commands, progress, cancellation and panels"`

```json:metadata
{"files": ["src/extension.ts", "test/unit/extensionWiring.test.ts"], "verifyCommand": "npm test -- extensionWiring; npm run typecheck; npm run compile", "acceptanceCriteria": ["four commands registered with exact ids", "rerunRecent quick pick labels and prefilled setup", "cancel aborts with no results panel", "error classes map to specified messages", "settings read per run", "manual F5 orders comparison shows removed 10, added 5, changed 54"], "modelTier": "standard"}
```

---

### Task 13: Smoke-test checklist, README, packaging

**Goal:** A manual checklist for the user's real pools, a README, and an installable `.vsix`.

**Files:**
- Create: `docs/smoke-test-checklist.md`, `README.md`
- Modify: `package.json` (`publisher`, `repository` placeholder, `icon` optional), `.vscodeignore`

**Acceptance Criteria:**
- [ ] The checklist has numbered steps, each with an expected result and a pass/fail box. It covers:
  1. Add an Entra connection to the dedicated pool → detected pool type `dedicated`.
  2. Add an Entra connection to serverless → `serverless`.
  3. Connect with the dedicated pool paused → the "is paused" message.
  4. Schema-only differences between two tables.
  5. Dedicated vs serverless data diff on a ≥10M-row table, recording duration and the serverless data processed.
  6. A string-heavy table with a `varchar` UTF-8 collation on serverless vs `nvarchar` on dedicated → no false differences.
  7. A wide row with `nvarchar(max)` values over 8,000 bytes → `HASHBYTES` works on both pools.
  8. A `datetimeoffset` column → `SWITCHOFFSET` works on both pools.
  9. Cancel mid-run → `Comparison cancelled.`, and no queries left running (check `sys.dm_pdw_exec_requests` on dedicated).
  10. Export CSV and open in Excel.
  11. Open in diff editor.
- [ ] The README covers install from the `.vsix`, adding connections, running a comparison, what the summary means, limits and settings, the serverless cost note, and known limitations (no key-less diff, no column renames, read-only).
- [ ] `npm run package` produces `synapse-table-diff-0.1.0.vsix`, which doesn't include `test/`, `docs/superpowers/`, `.env` or `src/`.

**Verify:** `npm run package; npx vsce ls` → the `.vsix` is created, and the listing has no `test/`, `.env` or `src/` entries

**Steps:**

- [ ] **Step 1: Write `docs/smoke-test-checklist.md` and `README.md`.**
- [ ] **Step 2: Set `.vscodeignore`** to exclude `src/**`, `test/**`, `webview/**/*.ts`, `docs/superpowers/**`, `.env*`, `docker-compose.yml` and `*.config.ts`.
- [ ] **Step 3: Run `npm run package; npx vsce ls`** and check the listing.
- [ ] **Step 4: Commit.** `git commit -m "docs: smoke-test checklist, README; packaging"`

```json:metadata
{"files": ["docs/smoke-test-checklist.md", "README.md", "package.json", ".vscodeignore"], "verifyCommand": "npm run package; npx vsce ls", "acceptanceCriteria": ["checklist covers the 11 listed real-pool scenarios with expected results", "README covers install, usage, limits, serverless cost, limitations", "vsix built without test/, docs/superpowers/, .env, src/"], "modelTier": "mechanical"}
```
