# Schema Row Counts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare Schemas can also count the rows of every table found on both sides and report mismatches in the same CSV.

**Architecture:** A new pure-ish module `src/schemaCompare/rowCounts.ts` finds matched pairs, counts them with a bounded worker pool through an injected `count` callback, and turns the results into `Finding`s. `report.ts` learns two new issue types. `runSchemaCompare` gains a fifth pick, a cancellable progress phase and the merge of findings. `extension.ts` makes progress cancellable and passes an `AbortSignal` to `runner.query`.

**Tech Stack:** TypeScript, Vitest (unit and integration against SQL Server 2022 in Docker), mssql/tedious, VS Code API.

**Spec:** `docs/superpowers/specs/2026-11-28-schema-row-counts-design.md`

## Global Constraints

- Count query text, exactly: `SELECT COUNT_BIG(*) AS cnt FROM ` + `qualifiedName({ schema, name })`. It must pass `assertAllowedSql`.
- Each side is counted with its own spelling of the object name and its own schema.
- Only names on both sides (case-insensitive match) are counted, in the order of the left names sorted case-insensitively.
- At most 4 tables in flight at once. Each table runs its left and right count in parallel.
- Counts are compared as `BigInt` (`BigInt(String(cnt))`). Never `Number`.
- Issue order: `missing_table, extra_table, missing_column, extra_column, type_mismatch, size_mismatch, row_count_mismatch, row_count_error`.
- Labels: `row count mismatch` / `row count mismatches`, `row count error` / `row count errors`.
- `row_count_mismatch` details, exactly: `left <L> <row|rows>, right <R> <row|rows> (<D> fewer on the right)`, or `(<D> more on the right)`. Numbers use `,` as the thousands separator whatever the locale, e.g. `left 1,204,331 rows, right 1,204,300 rows (31 fewer on the right)`, `left 1 row, right 0 rows (1 fewer on the right)`.
- `row_count_error` details: `left: <message>`, `right: <message>`, or both joined by `; ` (left first). One finding per table.
- For both new issues `column`, `leftType` and `rightType` are `''`, and `table` is the left name.
- Fifth pick: placeholder `Compare row counts too?`. Items, in this order before the preferred one is moved first:
  `{ label: 'Structure only', value: 'structure' }`, and
  `{ label: 'Structure and row counts', value: 'counts', description: "Counts every table found on both sides; serverless reads each table's files" }`.
  Preferred is `'counts'` when the remembered choice has `rowCounts: true`, otherwise `'structure'`. Dismissing it (undefined) stops the run.
- Remembered choice shape: `{ left: SchemaSide; right: SchemaSide; rowCounts?: boolean }`, saved after the fifth pick.
- Progress message per table as it starts: `Counting rows <i> of <n>: <leftSchema>.<leftName>…` (1-based `i`, `…` is U+2026).
- Cancel: stops starting new counts, aborts running queries, and ends the run with no save dialog, no file, no info and no error message.
- Summary: `reportSummary(findings, countedTables?)`. When `countedTables` is given (> 0) and no `row_count_*` finding exists, append `; row counts match for <n> table|tables`. With no findings at all: `No differences found; row counts match for 12 tables.` (the existing `No differences found.` keeps its period at the very end). Without `countedTables` the output is unchanged.
- "Structure only" produces exactly today's queries, report and summary.

**User decisions (already made):**
- "Add to Compare Schemas" (not a separate command).
- The datasets "should be identical": exact counts, no filters.
- Approved design: exact `COUNT_BIG(*)` on both sides, 4 at a time, counts in `details`, cancel abandons the run.

## Review Focus

1. A count fails on one side (an external table whose files are gone, a broken view): one `row_count_error` finding, the other tables are still counted. Tests in Task 1 (unit) and Task 3 (integration).
2. Cancel while counts are running: no further queries start after cancel, and there is no save dialog, error or info. Test in Task 2.
3. Counts above 2^53 that come back as strings: `'9007199254740993'` vs `'9007199254740992'` must be a mismatch. Test in Task 1.
4. Names whose case differs by side (`t1` / `T1`): each side is queried with its own spelling. Tests in Task 1 and Task 3.
5. Names containing `]` or spaces: quoted with `quoteIdent` and accepted by the allow-list. Test in Task 1.

---

### Task 1: Row count core

**Goal:** Pure row-count logic and report support: query text, matched pairs, bounded counting, findings, summary.

**Files:**
- Create: `src/schemaCompare/rowCounts.ts`
- Modify: `src/schemaCompare/report.ts` (IssueType, ISSUE_ORDER, ISSUE_LABEL, reportSummary)
- Modify: `src/sql/queries.ts` (add `countRowsQuery`)
- Test: `test/unit/rowCounts.test.ts`, `test/unit/schemaReport.test.ts`, `test/unit/queries.test.ts`

**Acceptance Criteria:**
- [ ] `countRowsQuery({ schema: 'dbo', name: 'a]b c' })` returns `SELECT COUNT_BIG(*) AS cnt FROM [dbo].[a]]b c]`, and `assertAllowedSql` accepts it.
- [ ] `matchedPairs` returns only names present on both sides, with each side's spelling, sorted case-insensitively by left name.
- [ ] `countMatchedTables` never has more than `limit` tables in flight, keeps pair order in results, captures a per-side failure as an `Error`, and throws `CompareCancelledError` once the signal is aborted.
- [ ] `rowCountFindings` emits the exact details text from Global Constraints, compares as BigInt, and emits nothing for equal counts.
- [ ] `reportSummary` handles the two new issues and the `countedTables` suffix exactly as specified, and is unchanged without it.

**Verify:** `npm test` → all unit tests pass, including the new ones.

**Steps:**

- [ ] **Step 1: Write the failing tests** in `test/unit/rowCounts.test.ts` (plus additions to the two existing files):
  - `countRowsQuery quotes names and passes the allow-list` (the value above; `expect(() => assertAllowedSql(q)).not.toThrow()`).
  - `matchedPairs keeps each side's spelling`: left `[t2, T1, v1]`, right `[t1, v1, t3]` → `[{ left: 'T1', right: 't1' }, { left: 'v1', right: 'v1' }]`.
  - `countMatchedTables limits concurrency to 4`: 10 pairs, `count` resolves after a tick and records max in-flight *tables* → `<= 4`; results are in pair order.
  - `countMatchedTables records a side's failure`: `count('right', 'x')` rejects with `new Error('files missing')` → result `{ table: 'x', left: 5n, right: Error('files missing') }`.
  - `countMatchedTables stops on abort`: abort after the first `onStart` → rejects with `CompareCancelledError`, and `count` was called for at most the first 4 tables.
  - `rowCountFindings` cases:
    - `{ left: 1204331n, right: 1204300n }` → details `left 1,204,331 rows, right 1,204,300 rows (31 fewer on the right)`;
    - `1n` vs `0n` → `left 1 row, right 0 rows (1 fewer on the right)`;
    - `2n` vs `5n` → `left 2 rows, right 5 rows (3 more on the right)`;
    - equal → no finding;
    - `BigInt('9007199254740993')` vs `BigInt('9007199254740992')` → a mismatch;
    - left Error `a`, right Error `b` → one `row_count_error` with details `left: a; right: b`.
  - `schemaReport.test.ts`: `reportSummary` with one `row_count_mismatch` → `1 finding: 1 row count mismatch`. `reportSummary([], 12)` → `No differences found; row counts match for 12 tables.` One `missing_column` finding with `countedTables` 1 → `1 finding: 1 missing column; row counts match for 1 table`. `diffSchemas` output is unchanged.

- [ ] **Step 2: Run** `npx vitest run -c vitest.config.ts test/unit/rowCounts.test.ts test/unit/schemaReport.test.ts test/unit/queries.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** in `src/schemaCompare/rowCounts.ts`:

```ts
export interface TablePair { left: string; right: string }
export interface RowCountResult { table: string; left: bigint | Error; right: bigint | Error }
export function matchedPairs(left: SchemaObject[], right: SchemaObject[]): TablePair[];
/** `count` returns the `cnt` value of one side's count query. */
export function countMatchedTables(
  pairs: TablePair[],
  count: (side: 'left' | 'right', name: string) => Promise<unknown>,
  opts: { limit: number; signal?: AbortSignal; onStart?: (index: number, total: number, pair: TablePair) => void },
): Promise<RowCountResult[]>;
export function rowCountFindings(results: RowCountResult[]): Finding[];
export function formatCount(n: bigint): string; // 1204331n -> '1,204,331'
```

  - `countMatchedTables` is a worker pool of `limit` workers pulling the next index. A side's rejection becomes an `Error`, unless the signal is aborted, in which case the whole call rejects with `CompareCancelledError` (`src/core/errors.ts`). Check the signal before starting each table.
  - Add `countRowsQuery(t: { schema: string; name: string }): string` to `queries.ts`.
  - Extend `IssueType`, `ISSUE_ORDER`, `ISSUE_LABEL` and `reportSummary(findings: Finding[], countedTables?: number)` in `report.ts`.

- [ ] **Step 4: Run** the same command → PASS. Then `npm test` → all pass, and `npm run typecheck` (or `npx tsc --noEmit`) → clean.

- [ ] **Step 5: Commit**

```bash
git add src/schemaCompare/rowCounts.ts src/schemaCompare/report.ts src/sql/queries.ts test/unit/rowCounts.test.ts test/unit/schemaReport.test.ts test/unit/queries.test.ts
git commit -m "feat(row-counts): count matched tables and report mismatches"
```

```json:metadata
{"files": ["src/schemaCompare/rowCounts.ts", "src/schemaCompare/report.ts", "src/sql/queries.ts", "test/unit/rowCounts.test.ts", "test/unit/schemaReport.test.ts", "test/unit/queries.test.ts"], "verifyCommand": "npm test", "acceptanceCriteria": ["countRowsQuery quotes and passes allow-list", "matchedPairs keeps each side's spelling, sorted", "countMatchedTables limit, order, per-side Error, cancel", "rowCountFindings exact details, BigInt", "reportSummary new issues and countedTables suffix"], "modelTier": "standard"}
```

---

### Task 2: Fifth pick, counting phase, cancel and wiring

**Goal:** `runSchemaCompare` asks whether to count rows, counts with progress and cancel, merges findings and summary. The extension makes progress cancellable and passes the signal to queries.

**Files:**
- Modify: `src/commands/compareSchemas.ts`
- Modify: `src/extension.ts` (schemaEnv: `pick` passes `description`, `withProgress` cancellable, `query` takes a signal)
- Test: `test/unit/compareSchemas.test.ts`

**Acceptance Criteria:**
- [ ] The env interface becomes:
  - `pick(items: string[] | { label: string; value: string; description?: string }[], placeHolder, preferred?)`;
  - `query<T>(side, sql, signal?: AbortSignal)`;
  - `withProgress<T>(title, task: (report, signal: AbortSignal) => Promise<T>)`;
  - `lastChoice()` / `saveChoice()` use `{ left; right; rowCounts?: boolean }`.
- [ ] The fifth pick is shown after the right schema with the exact placeholder, items and preferred value from Global Constraints. Undefined stops with no save, no queries for columns.
- [ ] "Structure only" runs exactly the existing queries and summary (existing tests still pass, with their answer lists gaining `'structure'`).
- [ ] "Structure and row counts" runs `countRowsQuery` for every matched pair on both sides with each side's database, schema and spelling, reports `Counting rows i of n: schema.name…`, writes merged findings in the report's sort order, and calls `reportSummary(findings, pairs.length)`.
- [ ] Abort during counting: no save dialog, no info, no error, and no count query starts after the abort.
- [ ] `extension.ts`: `withProgress` uses `cancellable: true` and aborts an `AbortController` on `token.onCancellationRequested`. `query` forwards the signal to `runner.query(sql, signal)`.

**Verify:** `npm test` → all pass; `npm run compile` → builds.

**Steps:**

- [ ] **Step 1: Write failing tests** in `test/unit/compareSchemas.test.ts`. Extend `makeEnv` so `query` answers `countRowsQuery` calls from a `counts` map keyed by `` `${database}:${name}` `` and records the signal.
  - `asks about row counts after the schemas`: 7th pick placeholder `Compare row counts too?`, items as specified, preferred `'structure'` with no last choice, `'counts'` when `lastChoice()` has `rowCounts: true`.
  - `dismissing the row-count pick stops`: answers end with `undefined` → `saved` empty, no `schemaColumnsQuery` query, no dialog.
  - `structure only is unchanged`: answers with `'structure'` → no count queries; summary equals `reportSummary(findings)`; `saved[0].rowCounts === false`.
  - `counts rows of matched tables`: left `t1`, right `T1`, counts `dbL:t1 = 3`, `dbR:T1 = '2'` → count queries `countRowsQuery({ schema: 'sL', name: 't1' })` on `dbL` and `countRowsQuery({ schema: 'sR', name: 'T1' })` on `dbR`; progress includes `Counting rows 1 of 1: sL.t1…`; CSV contains `row_count_mismatch,t1,,,,"left 3 rows, right 2 rows (1 fewer on the right)",`.
  - `cancel during counting abandons the run`: `withProgress` fake aborts its controller inside the first count → no dialog, no info, no error.

- [ ] **Step 2: Run** `npx vitest run -c vitest.config.ts test/unit/compareSchemas.test.ts` → FAIL.

- [ ] **Step 3: Implement.** In `runSchemaCompare`, after the right side:
  - ask the fifth pick;
  - `saveChoice({ left, right, rowCounts })`;
  - inside `withProgress(title, (report, signal) => …)`, read both sides (passing `signal`) and diff. If counting, call `countMatchedTables(matchedPairs(lObjs, rObjs), …, { limit: 4, signal, onStart })` and merge `rowCountFindings` into the findings, re-sorting with the same comparator `diffSchemas` uses. Export that comparator from `report.ts` as `sortFindings(findings: Finding[]): Finding[]` rather than duplicating it.
  - In the outer `catch`, return silently when the error is a `CompareCancelledError` or the signal was aborted.
  - Wire `extension.ts` as in the acceptance criteria.

- [ ] **Step 4: Run** `npm test` → PASS, then `npm run compile` → builds.

- [ ] **Step 5: Commit**

```bash
git add src/commands/compareSchemas.ts src/extension.ts src/schemaCompare/report.ts test/unit/compareSchemas.test.ts
git commit -m "feat(row-counts): optional row counts in Compare Schemas with cancel"
```

```json:metadata
{"files": ["src/commands/compareSchemas.ts", "src/extension.ts", "src/schemaCompare/report.ts", "test/unit/compareSchemas.test.ts"], "verifyCommand": "npm test && npm run compile", "acceptanceCriteria": ["env interface extended", "fifth pick exact placeholder/items/preferred; undefined stops", "structure only unchanged", "counts matched tables per side, progress, merged sorted findings, summary with countedTables", "cancel abandons silently, no new counts", "extension cancellable progress and signal to runner.query"], "modelTier": "standard"}
```

---

### Task 3: Integration test and README

**Goal:** Prove counting against the local SQL Server, including a mismatch, a case-different name and a failing view, and document the option.

**Files:**
- Modify: `test/integration/seed.sql` (schema compare section)
- Modify: `test/integration/schemaCompare.test.ts`
- Modify: `README.md` ("Compare schemas" section)

**Acceptance Criteria:**
- [ ] Seed adds rows `cmp_l.t1` × 3, `cmp_r.T1` × 2. It also adds `cmp_l.v2 AS SELECT id FROM cmp_l.t1`, and on the right a view `cmp_r.v2 AS SELECT id FROM cmp_r.gone` whose table `cmp_r.gone` is created then dropped, so counting it fails.
- [ ] The existing schema findings test still expects exactly the same findings.
- [ ] New test: counting the matched pairs of `cmp_l`/`cmp_r` with the real runner gives exactly
  `[['t1','row_count_mismatch'], ['v1','row_count_mismatch'], ['v2','row_count_error']]`. The t1 details are `left 3 rows, right 2 rows (1 fewer on the right)`, and the v2 details start with `right: `.
- [ ] README documents the `Compare row counts too?` pick, that counts are exact and that serverless reads each table's files, the two new issue types, and that the counting can be cancelled.

**Verify:** `npm run test:integration` → all pass (Docker SQL Server running; `docker compose up -d` if not).

**Steps:**

- [ ] **Step 1: Write the test** in `schemaCompare.test.ts` using the existing `run` helper. Call `countMatchedTables(matchedPairs(left, right), (side, name) => run(side === 'left' ? 'tablediff_a' : 'tablediff_b', countRowsQuery({ schema: side === 'left' ? 'cmp_l' : 'cmp_r', name })).then((r) => r[0].cnt), { limit: 4 })`, then `rowCountFindings`.
- [ ] **Step 2: Update `seed.sql`** as in the acceptance criteria (use `GO` between view creation and the drop).
- [ ] **Step 3: Run** `npm run test:integration` → PASS (the global setup reseeds).
- [ ] **Step 4: Update README**: add the pick and the two issue types to the "Compare schemas" section.
- [ ] **Step 5: Commit**

```bash
git add test/integration/seed.sql test/integration/schemaCompare.test.ts README.md
git commit -m "test(row-counts): integration test against seeded schemas; README"
```

```json:metadata
{"files": ["test/integration/seed.sql", "test/integration/schemaCompare.test.ts", "README.md"], "verifyCommand": "npm run test:integration", "acceptanceCriteria": ["seed rows and broken right view v2", "existing schema findings unchanged", "row count findings exactly t1 mismatch, v1 mismatch, v2 error", "README documents pick, exactness, issue types, cancel"], "modelTier": "standard"}
```
