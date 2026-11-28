# Aggregate Compare: design

## Intent

Compare Tables finds row-level differences, but it needs a key and the two tables must share column names.
The user also wants a quicker check that reconciles totals: for one or more measure columns, compare SUM,
COUNT and COUNT(DISTINCT) on each side, grouped by chosen fields, where the measure and group-by columns may
have different names on the two sides. Not every aggregate fits every column, so the user picks which
aggregates run for each measure.

When a group's totals don't match, the natural next step is a row diff of the same tables. So this is a
mode of the existing form, not a separate tool.

## Goals

- A **Rows | Aggregates** mode switch at the top of the Compare Tables form. The side pickers (connection,
  database, table), filter and text options stay. In Aggregates mode the Key columns and Excluded columns
  lists are replaced by two pair editors:
  - **Group by**: zero or more pairs `left column ↔ right column`. Zero pairs means whole-table totals
    (one group).
  - **Measures**: one or more pairs `left column ↔ right column`, each with checkboxes **Sum**, **Count**,
    **Distinct count** (at least one ticked per measure). Sum is disabled unless both columns are numeric
    (integer, exact decimal, float families).
- Names may differ between sides; any column can be paired with any column.
- **Count** means COUNT(column) (non-NULL values). A group row count, COUNT_BIG(*), is always computed and
  shown, and is compared like an aggregate.
- **Group matching**: groups match on their group-by values after normalization. Ignore case, Ignore
  trailing spaces, NULL = blank and Ignore data types apply to group-by values exactly as they apply to key
  columns today (keys don't get NULL = blank today; group-by values *do*, since it's the user's explicit
  choice for grouping text). A NULL group value is its own group, as in SQL `GROUP BY`.
- **Measure normalization**: Count and Distinct count use the same normalized expression as row compare (so
  with Ignore case, `'a'` and `'A'` are one distinct value; with NULL = blank, blanks aren't counted).
  Sum uses the numeric value, not text.
- **Equality**:
  - Counts are exact.
  - Integer/decimal sums are exact by default.
  - Float sums allow a small built-in relative tolerance (1e-9 of the larger magnitude) to absorb
    summation-order noise between pools.
  - One optional **Sum tolerance** field: a number (`0.01`, absolute) or a percentage (`0.1%`, relative to the
    larger absolute value of the two sums). Applies to sums only. Empty = exact.
- **Results** open in the existing results panel:
  - Summary: groups on left, groups on right, groups that differ, only on left, only on right, duration,
    pool types, warnings.
  - Tabs reuse the existing kinds: Changed = in both, some aggregate differs; Removed = only on left;
    Added = only on right; All.
  - Grid: group-by columns (named like measures: the left name when both match case-insensitively, otherwise `left ↔ right`), then for each aggregate (row count first, then each
    measure's chosen aggregates in order): left, right, difference. Differing cells are highlighted as
    changed cells are today. Matching groups are not listed.
  - CSV export of the same columns, with the existing BOM/quoting/formula neutralization.
- **Filters (user's decision).** In Aggregates mode there is a "Same filter for both sides" checkbox,
  ticked by default. Unticked, a second textarea appears and the two are labelled Left filter / Right filter,
  because renamed columns make a shared filter fail on one side. Each filter passes `filterProblem`.
  Rows mode is unchanged (one shared filter).
- Recent comparisons remember the mode and the aggregate settings; re-running or opening one restores the
  Aggregates form.
- Cost: one aggregate query per side, run in parallel; on serverless that's one scan per side. The serverless
  note changes wording in Aggregates mode accordingly.

## Non-goals

- Other aggregates (MIN, MAX, AVG).
- Expressions as group-by or measure columns (only plain columns).
- Drilling from a differing group into its rows automatically (switching mode keeps the tables selected;
  that is the drill path for now).
- The pending Schema Compare work is unrelated and untouched.

## Anti-goals

- False differences from float noise or type differences (int vs bigint, varchar vs nvarchar) in group values.
- Silently wrong sums from overflow or driver rounding (decimal coming back as a JS double).

## Approaches considered

- **Mode in the existing form (chosen by the user).** Reuses pickers, filter, options, recents and the
  results panel; keeps the tables selected when switching to a row diff. Cost: the form state and Run
  handle two request shapes.
- Separate "Compare Aggregates" command and form. Simpler forms individually, but a second webview and
  re-picking tables to drill down. Not chosen.
- Quick-pick prompts (as Schema Compare uses). Too many paired inputs with checkboxes. Dropped.

## How it works

1. **Request shape.** `CompareRequest` gains `mode?: 'rows' | 'aggregate'` (absent = rows, so stored recents
   keep working) and `aggregate?: AggregateSpec`:
   ```ts
   interface ColumnPair { left: string; right: string }
   type AggKind = 'sum' | 'count' | 'distinct';
   interface MeasureSpec extends ColumnPair { aggs: AggKind[] }
   interface AggregateSpec {
     groupBy: ColumnPair[]; measures: MeasureSpec[]; sumTolerance?: string;
     /** Right side's filter when it differs; absent = the request's `filter` applies to both sides. */
     rightFilter?: string;
   }
   ```
   `keyColumns`/`excludedColumns` are ignored (empty) in aggregate mode. `filter` is the left (or shared)
   filter.
2. **Form.** Mode switch; in Aggregates mode, pair editors with a left-column select, a right-column select,
   (measures: the three checkboxes) and a remove button, plus "+ Add group by" / "+ Add measure". A new row
   preselects the first unused left column and the right column with the same name if there is one.
   `canRun` checks: both sides described; at least one measure; each measure has ≥ 1 agg; Sum only on
   numeric pairs; each pair's types can be planned (via `planColumnPair` with the current options);
   tolerance parses; filter passes `filterProblem`. Changing a table clears pairs that reference columns no
   longer present.
3. **Plan.** A pure `planAggregate(leftCols, rightCols, req)` returns per-pair `ColumnNorm`s (reusing
   `planColumnPair`) or a `ComparePlanError` naming the pair.
4. **Query** (one per side, new `aggregateQuery` in `queries.ts`):
   ```sql
   SELECT <normalizeExpr(g_i)> AS g_0, ...,
          CAST(COUNT_BIG(*) AS varchar(20)) AS rc,
          <per measure, per chosen agg> AS m_<i>_<agg>
   FROM <table> WHERE (<filter>)
   GROUP BY <normalizeExpr(g_i)>, ...
   ```
   - count: `COUNT_BIG(<normalized m>)`; distinct: `COUNT_BIG(DISTINCT <normalized m>)`.
   - sum, integer/decimal: `CAST(SUM(CAST(<m> AS decimal(38, s))) AS varchar(45))` with `s` the larger
     scale of the two sides, so both sides return exact text at the same scale.
   - sum, float: `CONVERT(varchar(30), SUM(CAST(<m> AS float)), 3)`.
   - All aggregates come back as strings; the client compares counts as BigInt, decimal sums as exact
     decimals (BigInt scaled), float sums as numbers.
5. **Compare.** Pure `compareAggregates(leftRows, rightRows, spec)`: index each side by the tuple of group
   values (NULL distinct from any string), then classify each group as only-left, only-right, differs or
   equal, computing differences and applying tolerances. Output rows reuse `DiffRow`-like paging in the
   results panel.
6. **Pipeline.** A separate `runAggregateCompare` next to `runCompare` (reusing `withRunners`, abort and
   progress); stages: schema (describe both tables), aggregates, compare.
7. **Limits.** If a side returns more than `limits.pairLimit` groups, stop with a clear error (group by
   fewer fields). Rows held for display are capped at `detailLimit`, as today, with the summary counts
   still exact.

## Calls made after the builder review (designer's calls, not the user's)

- **NULL sums.** A group whose measure is all NULL gives SUM = NULL. For comparison NULL sum = 0; the cell
  displays blank. The Count aggregate exposes the NULL-vs-values case when ticked.
- **Collation-independent grouping.** Character group expressions (and Distinct count's character
  expressions) get `COLLATE Latin1_General_100_BIN2`, so a case-insensitive database collation can't merge
  `'a'` / `'A'` on one side only. Because `GROUP BY` / `DISTINCT` ignore trailing spaces under any collation,
  when trailing spaces are significant (no rtrim in the norm) the expression also carries the length, e.g.
  grouped by `(expr COLLATE BIN2, DATALENGTH(expr))` and distinct-counted on `expr + N'|'`. Ignore case /
  Ignore trailing spaces are then applied only by the normalization, the same on both sides.
- **Displayed group values** are the normalized strings that were matched (upper-cased under Ignore case,
  canonical date/number text). Only-right groups show the right side's normalized values.
- **Mixed numeric sum pairs.** If both columns are integer/exact decimal and the aligned shape fits 38 digits,
  the sum is exact decimal; otherwise both sides sum as float and the built-in float tolerance applies.
  Sum stays enabled for every numeric pair.
- **Tolerance rules.** The effective sum tolerance is the larger of the user's tolerance and (float sums
  only) the built-in one. Comparison is inclusive (`|l − r| <= tol`). Two zero sums are equal; a percentage
  tolerance is relative to `max(|l|, |r|)`. Counts and the row count are always exact.
- **Group limit** is per side and enforced while streaming rows: as soon as a side exceeds `pairLimit`
  groups, the pass aborts (both queries cancelled) with the error, so memory stays bounded.

## Known gaps

- Generated aggregate SQL (GROUP BY / COUNT(DISTINCT) on nvarchar(max) normalized expressions with COLLATE, CONVERT style 3 for float sums) is verified on local SQL Server only; run one aggregate compare on a dedicated and a serverless pool before release.

## Left to the builder

- Exact grid header text (e.g. `amount ↔ amt · sum (L / R / Δ)`) and how the difference is formatted.
- Whether aggregate rows extend `DiffRow`/the existing results renderer or get a sibling renderer in the same
  panel, as long as paging, tabs and CSV export behave as above.
- Arithmetic overflow handling: if `decimal(38, s)` overflows on SUM, surface the SQL error with the measure
  name.
- Tests: unit tests for planning, query text, tolerance parsing/application, group matching and the form
  reducer/render; an integration test against the local SQL Server comparing two seeded tables with renamed
  columns.
