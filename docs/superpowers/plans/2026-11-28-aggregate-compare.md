# Aggregate Compare Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Aggregates mode to Compare Tables that compares SUM / COUNT / COUNT(DISTINCT) of paired
(possibly renamed) measure columns, grouped by paired (possibly renamed) columns, and shows differing groups.

**Architecture:** New pure modules plan the aggregate (`aggregatePlan.ts`), build one GROUP BY query per side
(`aggregateQueries.ts`) and compare the two result sets (`aggregateCompare.ts`). A new pipeline entry
(`runAggregateComparison`) runs both queries in parallel, streaming with a group cap. The existing setup form
gains a mode switch and pair editors; the existing results panel and webview gain an aggregate variant.

**Tech Stack:** TypeScript, VS Code webview API, mssql (tedious), vitest (+ jsdom for webview tests), T-SQL
for SQL Server / Synapse dedicated / serverless.

**Spec:** `docs/superpowers/specs/2026-11-28-aggregate-compare-design.md`

## Global Constraints

- Execute in its own git worktree: another session is concurrently changing `src/sql/queries.ts`,
  `src/export/csv.ts`, `src/commands/compareSchemas.ts` and their tests. Put new code in the new files named
  below; edit shared files (`types.ts`, `allowList.ts`, `extension.ts`, `compare.ts`, protocol, webviews) only
  where the task says.
- Every generated SQL string must pass `assertAllowedSql` (`src/sql/allowList.ts`); a unit test asserts it.
- `CompareRequest.mode` absent means rows mode; stored recents without `mode` must keep working unchanged.
- Aggregate values travel as strings (`varchar` casts in SQL) — never let the driver return decimal sums as JS
  numbers.
- Character and other text group/distinct expressions use `COLLATE Latin1_General_100_BIN2`.
- Δ is always `right − left`. NULL sum counts as 0 for comparison and displays as an empty cell.
- Tolerance: inclusive (`|Δ| <= tol`); `%` is relative to `max(|left|, |right|)`; the effective tolerance on
  float sums is the larger of the user's and `1e-9 × max(|left|, |right|)`; counts and row count are exact.
- Commands: `npm test` (unit), `npm run typecheck`, `npm run test:integration` (needs `TABLEDIFF_TEST_CONN`).

**User decisions (already made):**
- Choose aggregates per measure: Sum, Count, Distinct count (Count = COUNT(column)); row count always shown.
- Several measure pairs per run.
- Tolerance proposal accepted: exact by default, optional Sum tolerance as `0.01` or `0.1%`, built-in tiny
  float tolerance.
- Approach A: a Rows | Aggregates mode in the existing Compare Tables form, results in the existing panel.
- Separate left and right filters in Aggregates mode ("Same filter for both sides", ticked by default).

## Review Focus

1. A group value that is NULL on one side and the string `'NULL'` on the other must be two different groups
   (Task 4 test `keeps NULL distinct from the string "NULL"`).
2. A database with a case-insensitive collation must not merge `'x'` and `'X'` into one group
   (Task 9 integration assertion on `leftGroups`).
3. Decimal sums beyond 2^53 must compare exactly (Task 4 test `compares huge decimal sums exactly`).
4. An all-NULL measure on one side and zeros on the other must not be reported as a sum difference
   (Task 4 test `treats a NULL sum as 0`).
5. Re-opening a recent aggregate comparison must restore the Aggregates form with its pairs, dropping pairs
   whose columns no longer exist (Task 8 reducer test `restores a pending aggregate spec`).

---

## Interfaces (shared names — defined once, used across tasks)

Added to `src/core/types.ts` (Task 1):

```ts
export type CompareMode = 'rows' | 'aggregate';
export interface ColumnPair { left: string; right: string }
export type AggKind = 'sum' | 'count' | 'distinct';
export interface MeasureSpec extends ColumnPair { aggs: AggKind[] }
export interface AggregateSpec {
  groupBy: ColumnPair[];
  measures: MeasureSpec[];
  sumTolerance?: string;
  /** Right side's filter when it differs from `filter`; '' = no right filter; absent = `filter` on both sides. */
  rightFilter?: string;
}
// CompareRequest gains: mode?: CompareMode; aggregate?: AggregateSpec;

export type SumMode = { kind: 'exact'; scale: number } | { kind: 'float' };
export interface GroupPlan { leftName: string; rightName: string; label: string; norm: ColumnNorm; trailingSignificant: boolean }
export interface MeasurePlan {
  leftName: string; rightName: string; aggs: AggKind[];
  /** Normalization for count/distinct; undefined when the types cannot be planned (count then uses the raw column). */
  norm?: ColumnNorm;
  sum?: SumMode;
}
export interface AggTarget {
  /** e.g. 'Rows', 'amount · sum', 'cust ↔ customer · distinct count' */
  label: string;
  agg: AggKind | 'rows';
  /** -1 for the row count */
  measure: number;
  /** SQL column alias: 'rc' or `m_${measure}_${agg}` */
  alias: string;
}
export interface AggregatePlan { groups: GroupPlan[]; measures: MeasurePlan[]; targets: AggTarget[] }

export interface AggregateRow {
  kind: ChangeKind;            // changed = in both & differs; removed = only left; added = only right
  group: (string | null)[];    // normalized group values (right side's for 'added')
  left: (string | null)[];     // per target; all null for 'added'
  right: (string | null)[];    // per target; all null for 'removed'
  diff: (string | null)[];     // right − left per target; null unless 'changed'
  differs: boolean[];          // per target
}
export interface AggregateResult {
  mode: 'aggregate';
  request: CompareRequest;
  plan: AggregatePlan;
  leftGroups: number; rightGroups: number;
  changed: number; added: number; removed: number; matching: number;
  rows: AggregateRow[];        // sorted by group (numeric-aware collator on group.join('\u0000')), capped at detailLimit
  detailCapped: boolean;
  warnings: string[];
  durationMs: number;
  poolTypes: { left: PoolType; right: PoolType };
}
// CompareResult gains: mode?: 'rows';
// Stage gains: 'aggregates'
```

---

### Task 1: Request and result types

**Goal:** Add the shared aggregate types, the new stage, and an aggregate-aware recent label.

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/commands/compare.ts` (`STAGE_MESSAGES`, `recentLabel`)
- Modify: `src/ui/sidebar.ts:32` (use `recentLabel` instead of the inline label)
- Test: `test/unit/sidebar.test.ts` (or the existing test that covers `recentLabel`)

**Acceptance Criteria:**
- [ ] All types in the Interfaces block exist and `npm run typecheck` passes.
- [ ] `STAGE_MESSAGES.aggregates === 'Computing aggregates…'`.
- [ ] `recentLabel` returns `Σ dbo.a ↔ dbo.b` for `mode: 'aggregate'` and the unchanged `dbo.a ↔ dbo.b` otherwise; the sidebar shows the same text.

**Verify:** `npm run typecheck && npm test` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test** — `recentLabel({...req, mode: 'aggregate'})` → `'Σ dbo.a ↔ dbo.b'`; without mode → `'dbo.a ↔ dbo.b'`; sidebar recent item label equals `recentLabel(r)`.
- [ ] **Step 2: Run** `npm test -- sidebar` → FAIL.
- [ ] **Step 3: Implement** the types (verbatim from Interfaces), the stage message, `recentLabel`, and the sidebar call.
- [ ] **Step 4: Run** `npm run typecheck && npm test` → PASS.
- [ ] **Step 5: Commit** `feat(aggregate): request, plan and result types`

```json:metadata
{"files": ["src/core/types.ts", "src/commands/compare.ts", "src/ui/sidebar.ts", "test/unit/sidebar.test.ts"], "verifyCommand": "npm run typecheck && npm test", "acceptanceCriteria": ["Interface types exist and typecheck passes", "STAGE_MESSAGES.aggregates is 'Computing aggregates…'", "recentLabel prefixes Σ for aggregate mode; sidebar uses recentLabel"], "modelTier": "mechanical"}
```

---

### Task 2: Aggregate planning

**Goal:** Turn the request plus both sides' columns into an `AggregatePlan`, or a `ComparePlanError` naming the bad pair.

**Files:**
- Create: `src/core/aggregatePlan.ts`
- Test: `test/unit/aggregatePlan.test.ts`

**Acceptance Criteria:**
- [ ] `planAggregate(left: ColumnInfo[], right: ColumnInfo[], req: CompareRequest): AggregatePlan` exported.
- [ ] `sumModeFor(l: ColumnInfo, r: ColumnInfo): SumMode | undefined` exported (undefined = not numeric).
- [ ] Errors (`ComparePlanError`) with these messages:
  - no measures → `Add at least one measure.`
  - measure with no aggs → `Measure amount ↔ amt: choose at least one aggregate.`
  - column not found (case-insensitive) → `Column amt is not in the right table.` (`left`/`right`)
  - sum on non-numeric → `Measure name ↔ name: Sum needs numeric columns.`
  - group pair `planColumnPair` fails → `Group by region ↔ area cannot be compared: <reason>`
  - distinct on a pair `planColumnPair` cannot plan → `Measure x ↔ y: Distinct count cannot be compared: <reason>`
  (The tolerance is validated by `parseTolerance` in Task 4, not here.)
- [ ] Group norms use options `{ignoreCase, ignoreTrailingSpaces, nullEqualsBlank, ignoreDataTypes}` from the request; measure norms the same.
- [ ] `trailingSignificant` = norm family is `character` (or `perSide` set) and `norm.rtrim` is false.
- [ ] Sum mode: both families in {integer, exactDecimal} (integer counts as decimal(19,0), money/smallmoney per `decimalShape` in `normalize.ts`) and `max(intDigits) + max(scale) <= 38` → `{kind:'exact', scale: max(scale)}`; otherwise any numeric pair → `{kind:'float'}`.
- [ ] Targets: first `{label:'Rows', agg:'rows', measure:-1, alias:'rc'}`, then per measure in order, per agg in the order sum, count, distinct (only ticked): alias `m_<i>_<agg>`, label `<name> · <sum|count|distinct count>` where `<name>` is the left name if names match case-insensitively, else `left ↔ right`. Group `label` follows the same naming rule.

**Verify:** `npm test -- aggregatePlan` → PASS

**Steps:**

- [ ] **Step 1: Write failing tests** covering: renamed pairs resolve case-insensitively; int↔decimal(10,2) → `{exact, scale 2}`; decimal(38,10)↔decimal(38,0) → `float`; int↔float → `float`; varchar↔int sum → error text above; targets order/labels/aliases for measures `[{amount↔amt, [count,sum]}, {cust↔cust, [distinct]}]` → `['Rows','amount ↔ amt · sum','amount ↔ amt · count','cust · distinct count']`, aliases `['rc','m_0_sum','m_0_count','m_1_distinct']`; `trailingSignificant` false under ignoreTrailingSpaces, true otherwise for varchar; each error message.
- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** in `src/core/aggregatePlan.ts`, reusing `planColumnPair`/`familyOf` from `src/sql/normalize.ts` (export `decimalShape` from there if needed).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(aggregate): plan group-by and measure pairs`

```json:metadata
{"files": ["src/core/aggregatePlan.ts", "src/sql/normalize.ts", "test/unit/aggregatePlan.test.ts"], "verifyCommand": "npm test -- aggregatePlan", "acceptanceCriteria": ["planAggregate and sumModeFor exported", "error messages as listed", "sum mode exact/float rule", "targets order, labels and aliases"], "modelTier": "standard"}
```

---

### Task 3: Aggregate query text

**Goal:** Build each side's GROUP BY query from the plan.

**Files:**
- Create: `src/sql/aggregateQueries.ts`
- Modify: `src/sql/allowList.ts` (allow `COLLATE`, `Latin1_General_100_BIN2`, aliases `g_\d+`, `rc`, `m_\d+_(sum|count|distinct)`)
- Test: `test/unit/aggregateQueries.test.ts`

**Acceptance Criteria:**
- [ ] `aggregateQuery(plan: AggregatePlan, side: Side, t: TableRef, filter: string | undefined): string` exported.
- [ ] Throws `ComparePlanError(filterProblem(...))` for an unsafe filter (same as `hashedTable`).
- [ ] Shape (`G_i` = `normalizeExpr(quoteIdent(name), norm, side)`, `B` = `COLLATE Latin1_General_100_BIN2`):
  ```sql
  SELECT (G_0) B AS g_0, ..., CAST(COUNT_BIG(*) AS varchar(20)) AS rc, <targets>
  FROM <qualifiedName(t)>[ WHERE (\n<filter>\n)]
  [GROUP BY (G_0) B[, DATALENGTH(G_0)], ...]
  ```
  `DATALENGTH(G_i)` is added only when `trailingSignificant`. No GROUP BY when there are no groups.
- [ ] Targets: count → `CAST(COUNT_BIG(M) AS varchar(20))` with `M` = normalized expr if `norm` else raw quoted column; distinct → `CAST(COUNT_BIG(DISTINCT (M + N'|') B) AS varchar(20))` when norm is character-family with `rtrim` false, otherwise `CAST(COUNT_BIG(DISTINCT (M) B) AS varchar(20))`; sum exact → `CAST(SUM(CAST(<raw> AS decimal(38,<scale>))) AS varchar(45))`; sum float → `CONVERT(varchar(30), SUM(CAST(<raw> AS float)), 3)`.
- [ ] Left side uses `leftName`s, right side `rightName`s.
- [ ] Every generated query passes `assertAllowedSql`.

**Verify:** `npm test -- aggregateQueries allowList` → PASS

**Steps:**

- [ ] **Step 1: Write failing tests**: exact expected SQL string for one group (varchar, no options) + measure `amount↔amt [sum,count]` decimal(10,2)↔decimal(18,4) on the right side (uses `area`, `amt`, `decimal(38,4)`); no-groups query has no `GROUP BY`; ignoreTrailingSpaces drops `DATALENGTH`; renamed/odd identifiers are quoted (`[it's]`); unsafe filter throws; `assertAllowedSql` passes for all of them.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `aggregateQuery` and the allow-list additions.
- [ ] **Step 4: Run** → PASS (existing allowList tests still pass).
- [ ] **Step 5: Commit** `feat(aggregate): GROUP BY query per side`

```json:metadata
{"files": ["src/sql/aggregateQueries.ts", "src/sql/allowList.ts", "test/unit/aggregateQueries.test.ts"], "verifyCommand": "npm test -- aggregateQueries allowList", "acceptanceCriteria": ["aggregateQuery exported with the specified shape", "unsafe filter throws ComparePlanError", "BIN2 collation and DATALENGTH rule", "all queries pass assertAllowedSql"], "modelTier": "standard"}
```

---

### Task 4: Tolerance and group comparison

**Goal:** Compare the two sides' aggregate rows into `AggregateRow`s with counts.

**Files:**
- Create: `src/core/aggregateCompare.ts`
- Test: `test/unit/aggregateCompare.test.ts`

**Acceptance Criteria:**
- [ ] `parseTolerance(text: string | undefined): Tolerance` where `type Tolerance = { kind: 'none' } | { kind: 'abs'; value: string } | { kind: 'pct'; value: string }`; trims; empty/undefined → none; accepts `/^\d+(\.\d+)?%?$/`; anything else throws `ComparePlanError('Sum tolerance must be a number like 0.01 or a percentage like 0.1%.')`.
- [ ] `compareAggregates(left: Record<string, unknown>[], right: Record<string, unknown>[], plan: AggregatePlan, tol: Tolerance, detailLimit: number): Omit<AggregateResult, 'mode' | 'request' | 'plan' | 'warnings' | 'durationMs' | 'poolTypes'>`.
- [ ] Groups keyed by `JSON.stringify(groupValues)` (values read from `g_0..g_n`, `null` kept as null).
- [ ] Counts/row count compared as BigInt, exactly. Exact sums compared as scaled BigInt (no floating point at any step, including tolerance and %). Float sums as numbers with the effective tolerance rule in Global Constraints. NULL sum = 0.
- [ ] `diff` text: counts → BigInt string; exact sums → decimal string with the plan scale (e.g. `0.0100`, `-1.50`); float → `String(r - l)`.
- [ ] Rows sorted by `new Intl.Collator(undefined, {numeric: true})` on `group.map(v => v ?? '').join('\u0000')`; first `detailLimit` kept; `detailCapped` true when more existed; counts are exact regardless.

**Verify:** `npm test -- aggregateCompare` → PASS

**Steps:**

- [ ] **Step 1: Write failing tests**:
  - `keeps NULL distinct from the string "NULL"`: left group `[null]`, right group `['NULL']` → one removed, one added.
  - `treats a NULL sum as 0`: sum null vs `'0.00'` → matching.
  - `compares huge decimal sums exactly`: `'12345678901234567890.01'` vs `'12345678901234567890.02'` → changed, diff `'0.01'`.
  - tolerance `0.01` makes a 0.01 diff equal (inclusive) and 0.0101 differ; `1%` on 100 vs 101 → equal, 100 vs 101.5 → differs; both zero → equal under `%`.
  - float `0.30000000000000004` vs `0.3` → equal with no tolerance; `1` vs `1.1` → differs.
  - counts differ by 1 → changed with diff `'1'`; row count difference alone marks changed.
  - only-left / only-right rows have all-null other side and null diff; `matching` counted.
  - sorting `['10'],['9'],['a']` → `9, 10, a`; `detailLimit: 1` → 1 row, `detailCapped: true`, counts unchanged.
  - `parseTolerance` accepts `' 0.5 '`, `'2%'`; rejects `'-1'`, `'abc'`, `'1e3'` with the message.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `parseTolerance`, `compareAggregates` and small scaled-decimal helpers in the same file.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(aggregate): compare groups with tolerance`

```json:metadata
{"files": ["src/core/aggregateCompare.ts", "test/unit/aggregateCompare.test.ts"], "verifyCommand": "npm test -- aggregateCompare", "acceptanceCriteria": ["parseTolerance rules and message", "exact BigInt decimal comparison", "float built-in tolerance", "NULL sum = 0", "NULL group distinct from 'NULL'", "sorting and detailLimit cap"], "modelTier": "standard"}
```

---

### Task 5: Aggregate pipeline

**Goal:** Run both sides' aggregate queries and produce an `AggregateResult`.

**Files:**
- Create: `src/core/aggregatePipeline.ts`
- Modify: `src/core/pipeline.ts` (export `withRunners` and `toColumn`; no behavior change)
- Test: `test/unit/aggregatePipeline.test.ts` (fake connectors with canned rows, like existing pipeline helper tests)

**Acceptance Criteria:**
- [ ] `runAggregateComparison(req: CompareRequest, deps: PipelineDeps): Promise<AggregateResult>`.
- [ ] Validates `filterProblem(req.filter)` and `filterProblem(rightFilter)` before connecting; right filter = `req.aggregate.rightFilter` when defined (`''` = none), else `req.filter`.
- [ ] Progress: `schema` (reading columns via `columnsQuery`, both sides), then `aggregates` with detail `Computing aggregates on both tables (one scan of each)…`, then `compare`.
- [ ] Streams each side with `runner.stream`; when a side exceeds `deps.limits.pairLimit` groups it throws `ComparePlanError('The left table has more than 2,000,000 groups. Group by fewer columns, or raise the tableDiff.pairLimit setting.')` (side and formatted limit substituted) — `withRunners` then cancels the other side.
- [ ] Warnings: `Showing the first N of M differing groups.` when `detailCapped`.
- [ ] Cancellation behaves like `runComparison` (aborted signal → `CompareCancelledError`).

**Verify:** `npm test -- aggregatePipeline` → PASS

**Steps:**

- [ ] **Step 1: Write failing tests**: happy path counts from canned rows; right filter used for the right query only (inspect SQL passed to the fake runner); `''` right filter → right query has no WHERE; unsafe right filter rejects before `open()` is called; group cap error text with `pairLimit: 2` and 3 canned rows; aborted signal → `CompareCancelledError`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** using `withRunners`, `planAggregate`, `aggregateQuery`, `parseTolerance`, `compareAggregates`.
- [ ] **Step 4: Run** `npm test` → PASS (whole suite: pipeline.ts export change is safe).
- [ ] **Step 5: Commit** `feat(aggregate): pipeline with group cap`

```json:metadata
{"files": ["src/core/aggregatePipeline.ts", "src/core/pipeline.ts", "test/unit/aggregatePipeline.test.ts"], "verifyCommand": "npm test", "acceptanceCriteria": ["runAggregateComparison returns AggregateResult", "per-side filters validated before connecting", "group cap error text", "progress stages", "cancellation"], "modelTier": "standard"}
```

---

### Task 6: Command, CSV and extension wiring

Runs after Task 7, because `ResultsPanel.show` must accept `AggregateResult` first.

**Goal:** Run aggregate requests from the form/recents, show a done message, and export aggregate CSV.

**Files:**
- Modify: `src/commands/compare.ts` (`CompareEnv`, `runFromRequest`, `doneMessage`)
- Create: `src/export/aggregateCsv.ts`
- Modify: `src/extension.ts` (env `runAggregateComparison`, `showResults` branch)
- Test: `test/unit/aggregateCsv.test.ts`, the existing `runFromRequest`/`doneMessage` test file (find with `grep -l doneMessage test/unit`)

**Acceptance Criteria:**
- [ ] `CompareEnv` gains `runAggregateComparison(req, deps): Promise<AggregateResult>`; `showResults(result: CompareResult | AggregateResult)`. `runFromRequest` calls it when `req.mode === 'aggregate'` (no `confirmExtraScan`), everything else unchanged.
- [ ] `doneMessage` for an aggregate result: `Table Diff finished in 0:03: all 412 groups match.` or `Table Diff finished in 0:03: 9 groups differ, 2 only on left, 1 only on right (412 vs 411 groups).` plus the existing ` See the warnings in the results.` suffix rule.
- [ ] `writeAggregateCsv(result: AggregateResult, out: NodeJS.WritableStream): Promise<void>`: BOM; header `change_type, <group labels>, then per target "<label> left", "<label> right", "<label> diff"`; `change_type` is `differs` / `only_left` / `only_right`; uses `csvLine` from `src/export/csv.ts` (export it if not already) and the same drain/error handling as `writeCsv`.
- [ ] `aggregateExportMessage(result)` → `Exported N groups.`
- [ ] In `extension.ts`, aggregate results open `ResultsPanel` without a diff document; `openDiff` is a no-op for them; export uses `writeAggregateCsv` with default file name `aggregate-diff.csv`.

**Verify:** `npm run typecheck && npm test` → PASS

**Steps:**

- [ ] **Step 1: Write failing tests**: `doneMessage` both texts; `runFromRequest` with `mode:'aggregate'` calls `runAggregateComparison` not `runComparison`; CSV header and one row of each kind, formula neutralization on a group value `=1+1`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test` → PASS.
- [ ] **Step 5: Commit** `feat(aggregate): run, done message and CSV export`

```json:metadata
{"files": ["src/commands/compare.ts", "src/export/aggregateCsv.ts", "src/export/csv.ts", "src/extension.ts", "test/unit/aggregateCsv.test.ts"], "verifyCommand": "npm run typecheck && npm test", "acceptanceCriteria": ["runFromRequest dispatches by mode", "doneMessage texts", "writeAggregateCsv header and change_type values", "extension wiring without diff document"], "modelTier": "standard"}
```

---

### Task 7: Results panel and webview

**Goal:** Show aggregate results with tabs-by-kind, a grid of L / R / Δ per aggregate, and CSV export.

**Files:**
- Modify: `src/ui/protocol.ts`, `src/ui/resultsPanel.ts`, `src/ui/resultsPaging.ts`
- Modify: `webview/results/main.ts`, `webview/results/render.ts`, `webview/results/virtualGrid.ts`
- Test: `test/unit/resultsPaging.test.ts`, `test/unit/resultsRender.test.ts`, `test/unit/virtualGrid.test.ts`

**Acceptance Criteria:**
- [ ] `HostToResults` gains `{ type: 'aggregateSummary'; summary: Omit<AggregateResult, 'rows'>; totalByKind }` and `{ type: 'aggregateRows'; kind; offset; rows: AggregateRow[] }`. `ResultsPanel.show` accepts `CompareResult | AggregateResult` and sends the matching message types.
- [ ] `pageRows` / `totalsByKind` are generic over `T extends { kind: ChangeKind }`.
- [ ] `renderAggregateSummary(root, s)`: h1 `Σ <left> ↔ <right>`; stats Left groups, Right groups, Differ (changed), Only on left, Only on right, Matching, Duration; pools line; warnings.
- [ ] Aggregate view has only the Data pane (no Schema / Key problems tabs); filter options `All / Differs / Only on right / Only on left` mapped to `all / changed / added / removed`; no "Open in diff editor" button; Export CSV posts `exportCsv`.
- [ ] `VirtualGrid` constructor takes an optional `buildRow` function; `buildAggregateRow(row: AggregateRow, groupCount: number): HTMLElement` renders group cells (NULL shown as the existing `null` span), then per target three cells left/right/Δ; null aggregate values render empty; the three cells of a differing target get class `cell-changed`.
- [ ] Grid header: group labels, then per target `<label> L`, `<label> R`, `<label> Δ`.

**Verify:** `npm test -- results virtualGrid` → PASS

**Steps:**

- [ ] **Step 1: Write failing tests** (jsdom): summary stat labels/values; `buildAggregateRow` cell count `1 + groups + 3 × targets`, `cell-changed` only on the differing target, empty text for a null sum; paging generic over aggregate rows.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(aggregate): results view`

```json:metadata
{"files": ["src/ui/protocol.ts", "src/ui/resultsPanel.ts", "src/ui/resultsPaging.ts", "webview/results/main.ts", "webview/results/render.ts", "webview/results/virtualGrid.ts", "test/unit/resultsPaging.test.ts", "test/unit/resultsRender.test.ts", "test/unit/virtualGrid.test.ts"], "verifyCommand": "npm test", "acceptanceCriteria": ["protocol aggregate messages", "generic paging", "aggregate summary render", "data-only view with renamed filter options and no diff button", "buildAggregateRow cells and highlighting"], "modelTier": "standard"}
```

---

### Task 8: Setup form Aggregates mode

**Goal:** Mode switch, pair editors, tolerance, per-side filters, validation, run and restore in the Compare Tables form.

**Files:**
- Create: `webview/setup/aggregateForm.ts` (pure helpers)
- Modify: `webview/setup/render.ts`, `webview/setup/reducer.ts`, `webview/setup/main.ts`
- Test: `test/unit/aggregateForm.test.ts`, `test/unit/setupRender.test.ts`, the reducer test (`grep -l applyHostMessage test/unit`)

**Acceptance Criteria:**
- [ ] `SetupState` gains `mode: CompareMode; groupBy: ColumnPair[]; measures: MeasureSpec[]; sumTolerance: string; sameFilter: boolean; rightFilter: string; pendingAggregate?: AggregateSpec` (defaults rows, [], [], '', true, '').
- [ ] `SetupActions` gains `onMode, onAddGroup, onGroup(i, side, col), onRemoveGroup(i), onAddMeasure, onMeasure(i, side, col), onMeasureAgg(i, agg, on), onRemoveMeasure(i), onSumTolerance, onSameFilter, onRightFilter`.
- [ ] `aggregateForm.ts` exports: `newPair(state, existing: ColumnPair[]): ColumnPair` (first left column not already in `existing`, right = same name case-insensitively if present else first right column); `newMeasure(state): MeasureSpec` (newPair + aggs `['count']`, plus `'sum'` first when numeric); `isNumericPair(state, pair): boolean`; `pruneAggregate(state): void` (drops pairs whose columns are missing on either side); `aggregateProblem(state): string | undefined` (calls `planAggregate` from Task 2 and `parseTolerance` from Task 4 with the form's request and returns the error message; also checks both filters with `filterProblem`); `aggregateRequest(state): Pick<CompareRequest, 'mode' | 'aggregate' | 'filter' | 'keyColumns' | 'excludedColumns'>`.
- [ ] `canRun` in aggregate mode: side checks as today, then `aggregateProblem`; key-column checks don't apply.
- [ ] Render in aggregate mode: buttons `data-role="mode-rows"` / `"mode-aggregate"` (active one has class `active`); Group by list (`data-role="group-left"` / `"group-right"` selects with `data-index`, remove `data-role="group-remove"`, add `data-role="group-add"` text `+ Add group by`); Measures list (same pattern with `measure-*`, checkboxes `data-role="measure-agg"` with `data-agg`, Sum checkbox disabled when `!isNumericPair`; add text `+ Add measure`); hint under Group by `No group by: compares whole-table totals.` when empty; `Sum tolerance (optional, e.g. 0.01 or 0.1%)` input `data-role="sum-tolerance"`; checkbox `data-role="same-filter"` `Same filter for both sides`; when unticked, textareas labelled `Left filter` / `Right filter` (`data-role="filter"` / `"right-filter"`); serverless note `AGG_SERVERLESS_NOTE = "This side is a serverless pool: an aggregate comparison scans its data once, and you're billed per data processed."`. Rows mode renders exactly as today (existing tests unchanged), plus the mode buttons.
- [ ] Switching mode keeps sides, tables and the other mode's settings.
- [ ] Reducer: on `described` with both sides described — if `pendingAggregate`, copy its pairs into state then `pruneAggregate` and clear it; otherwise `pruneAggregate`.
- [ ] `main.ts` `init`: an initial request with `mode:'aggregate'` sets `mode`, `pendingAggregate`, `sumTolerance`, `sameFilter = rightFilter === undefined`, `rightFilter`; `onRun` in aggregate mode posts `{...sides, ...aggregateRequest(state), ignoreCase, ignoreTrailingSpaces, nullEqualsBlank, ignoreDataTypes}`. Changing a table in aggregate mode does not clear pairs (pruned after describe).

**Verify:** `npm test -- setup aggregateForm` → PASS

**Steps:**

- [ ] **Step 1: Write failing tests**: `newPair` with left `[Region, Amount]`, right `[area, amount]` → first `{Region, area}`, then `{Amount, amount}`; `isNumericPair` int↔decimal true, int↔varchar false; `pruneAggregate` drops a pair naming a vanished column; `aggregateProblem` returns `Add at least one measure.` for no measures and the tolerance message for `abc`; render: aggregate mode shows pair selects and hides key/exclude lists, Sum disabled for a varchar pair, right-filter textarea only when same-filter unticked; reducer test `restores a pending aggregate spec` (pending pair with a missing column is dropped, others kept, pending cleared); `aggregateRequest` with sameFilter false and empty right filter → `rightFilter: ''`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(aggregate): setup form mode and pair editors`

```json:metadata
{"files": ["webview/setup/aggregateForm.ts", "webview/setup/render.ts", "webview/setup/reducer.ts", "webview/setup/main.ts", "test/unit/aggregateForm.test.ts", "test/unit/setupRender.test.ts"], "verifyCommand": "npm test", "acceptanceCriteria": ["SetupState and SetupActions additions", "aggregateForm helpers", "canRun aggregate branch", "aggregate render with data-roles", "mode switch preserves settings", "reducer restores and prunes pending aggregate", "init/onRun aggregate request"], "modelTier": "standard"}
```

---

### Task 9: Integration test against SQL Server

**Goal:** Prove the generated SQL and comparison work end to end on the local SQL Server, including collation and trailing spaces.

**Files:**
- Modify: `test/integration/seed.sql` (add tables in the `tablediff_a` and `tablediff_b` sections)
- Create: `test/integration/aggregate.test.ts` (connectors as in `pipeline.test.ts`)

**Acceptance Criteria:**
- [ ] Seed `tablediff_a.dbo.agg_l (region varchar(10) NULL, amount decimal(10,2) NULL, cust varchar(10) NULL)` rows: `('N',10.00,'c1') ('N',5.50,'c2') ('S',7.00,'c1') ('a',1.00,'c3') (NULL,2.00,'c4') ('x',1.00,'c5') ('X',2.00,'c6')`.
- [ ] Seed `tablediff_b.dbo.agg_r (area nvarchar(10) NULL, amt decimal(18,4) NULL, customer nvarchar(10) NULL)` rows: `('N',10.0000,'c1') ('N',5.5000,'c2') ('S',7.0100,'c1') ('A ',1.0000,'c3') ('x',1.0000,'c5') ('X',2.0000,'c6') ('W',3.0000,'c9')`.
- [ ] Case 1 — groupBy `region↔area`, measures `amount↔amt [sum,count]`, `cust↔customer [distinct]`, no options: `leftGroups 6, rightGroups 6, changed 1 (S, sum diff '0.0100'), removed 2, added 2, matching 3`.
- [ ] Case 2 — same + `sumTolerance '0.01'`, ignoreCase, ignoreTrailingSpaces: `changed 0, removed 1 (group [null]), added 1 (group ['W'])`, and `a`/`A ` matched.
- [ ] Case 3 — no group by: one group, `changed 1`, left sum `'28.5000'`, right sum `'29.5100'`, row counts `'7'` both.
- [ ] Case 4 — no group by, `filter "region = 'N'"`, `rightFilter "area = 'N'"`: `changed 0, matching 1`.
- [ ] Case 5 — `pairLimit: 3` → rejects with `/more than 3 groups/`.

**Verify:** `npm run test:integration -- aggregate` → PASS

**Steps:**

- [ ] **Step 1: Add the seed rows and write the five tests.**
- [ ] **Step 2: Run** `npm run test:integration -- aggregate`; fix any SQL issues in Tasks 3/5 code (e.g. GROUP BY on nvarchar(max) normalized expressions) until PASS. Report the observed output.
- [ ] **Step 3: Run** the full `npm run test:integration` → PASS (existing tests unaffected by the new seed tables).
- [ ] **Step 4: Commit** `test(aggregate): integration tests on SQL Server`

```json:metadata
{"files": ["test/integration/seed.sql", "test/integration/aggregate.test.ts"], "verifyCommand": "npm run test:integration -- aggregate", "acceptanceCriteria": ["seed tables as listed", "case 1 counts", "case 2 tolerance and options", "case 3 whole-table totals", "case 4 per-side filters", "case 5 group cap"], "modelTier": "standard"}
```
