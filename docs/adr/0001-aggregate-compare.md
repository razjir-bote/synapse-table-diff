# ADR 0001: Aggregate compare mode

- **Status:** Accepted, shipped in v0.5.0 (2026-11-28)
- **Design:** [`docs/superpowers/specs/2026-11-28-aggregate-compare-design.md`](../superpowers/specs/2026-11-28-aggregate-compare-design.md)
- **Plan:** [`docs/superpowers/plans/2026-11-28-aggregate-compare.md`](../superpowers/plans/2026-11-28-aggregate-compare.md)
- **Pull request:** razjir-bote/synapse-table-diff#1

Each decision below is marked **User** (chosen by the product owner during design) or **Designer** (a call
made while designing or building, recorded so it can be revisited).

## Context

Compare Tables finds row-level differences. It needs a key column, and it pairs columns only by name
(case-insensitively). Users also need a cheaper reconciliation check: totals per group, where the measure and
group-by columns may be named differently on the two sides (for example a dedicated pool table against a
serverless external table or view). When totals don't match, the next step is usually a row diff of the same
two tables.

## Decisions

### 1. A mode of the existing Compare Tables form, not a separate tool — User

A **Rows | Aggregates** switch at the top of the form. The connection, database and table pickers, the filter
and the text options are shared. Results open in the existing results panel, and recents remember the mode.

- *Why:* reuses the pickers, the filter guard, the recents and the results panel. Switching modes keeps the
  tables selected, so drilling from a mismatched total into a row diff takes one click.
- *Alternatives rejected:* a separate "Compare Aggregates" command and webview (a second form to maintain, and
  the tables have to be picked again to drill down); quick-pick prompts like Compare Schemas (too many paired
  inputs with checkboxes).
- *Cost:* the setup form state and the Run path handle two request shapes.

### 2. Several measure pairs per run, aggregates chosen per measure — User

Each measure row pairs a left column with a right column and has its own **Sum**, **Count** and
**Distinct count** ticks. Group-by is a list of pairs too, and zero pairs means whole-table totals.

- *Why:* not every aggregate makes sense for every column. All measures share one scan per side, so adding a
  measure costs no extra scan.

### 3. Count means COUNT(column); the row count is always compared — Designer

Count counts non-NULL values, so all three aggregates describe the chosen column. COUNT_BIG(*) per group is
always shown and compared, because it is cheap and explains most sum mismatches.

### 4. One GROUP BY query per side, matched in memory — Designer

Each side runs a single `GROUP BY` query (new module `src/sql/aggregateQueries.ts`). The two result sets are
streamed in parallel and matched on their group values in TypeScript (`src/core/aggregateCompare.ts`). The
row-diff checksum pipeline is not used.

- *Why:* simpler than the bucket pipeline, and a serverless side is scanned once (a row diff scans about three
  times).
- *Cost:* every group is held in memory, so the number of groups is capped (decision 10).

### 5. Columns are paired explicitly; names may differ — User

Any left column can be paired with any right column. Pairs are planned with the existing `planColumnPair`
normalization, so Ignore case, Ignore trailing spaces, NULL = blank and Ignore data types behave as they do
in row compares. For group values, NULL = blank applies too, since grouping text is the user's explicit choice.

### 6. Grouping does not depend on database collation — Designer

Group expressions and Distinct count use `COLLATE Latin1_General_100_BIN2`. When trailing spaces are
significant, the group also includes `DATALENGTH(expr)`, and Distinct count uses `expr + N'|'`.

- *Why:* a case-insensitive collation on one side would otherwise merge `'a'` and `'A'` on that side only and
  report false differences. SQL Server ignores trailing spaces in `GROUP BY` and `DISTINCT` under every
  collation.
- *Consequence:* group values are shown as they were matched, for example upper-cased under Ignore case.

### 7. Exact arithmetic for counts and decimal sums — Designer

Every aggregate comes back from SQL as text. Counts and integer/decimal sums are compared as scaled `BigInt`.
Both sides' decimal sums are cast to `decimal(38, s)` with the larger scale. Pairs that would need more than
38 digits, or that involve float, are summed as float.

- *Why:* the driver returns decimals as JS doubles, which would silently round large sums.
- An overflow of `decimal(38, s)` is reported with the measure's name.

### 8. Tolerance rules — User (proposal accepted), details Designer

- Matching is exact by default.
- There is one optional **Sum tolerance**: an absolute amount (`0.01`) or a percentage (`0.1%`) of
  `max(|left|, |right|)`. It applies to sums only.
- Float sums also get a built-in tolerance of `1e-9 × max(|left|, |right|)`, and the larger tolerance wins.
- Comparisons are inclusive (`|Δ| <= tolerance`). Two zero sums are always equal.
- A NULL sum (all values NULL) counts as 0 and is shown blank. Count shows the difference between "no values"
  and "zeros".

### 9. Separate left and right filters — User

In Aggregates mode, **Same filter for both sides** is ticked by default. Unticked, it shows a right-side
filter (stored as `AggregateSpec.rightFilter`; `''` means no filter). Both filters go through the existing
`filterProblem` guard in the form, the pipeline and the query builder.

- *Why:* with renamed columns, a shared filter fails on the side where the column has a different name.

### 10. The group cap is per side and enforced while streaming — Designer

If a side returns more than `tableDiff.pairLimit` groups, the comparison stops at once, the other side's
query is cancelled and the user is told to group by fewer columns. Rows held for display are capped at
`tableDiff.detailLimit`, and the summary counts stay exact.

### 11. Results presentation — Designer

- The existing kinds are reused: Changed = **Differs**, Removed = **Only on left**, Added = **Only on right**.
- The grid shows, per aggregate (row count first), the left value, the right value and Δ = right − left. The
  cells of a differing aggregate are highlighted. Matching groups are not listed.
- For a differing group, Δ is filled for every aggregate (0 where it matches).
- Group and measure headers use the left name when both names match case-insensitively, otherwise
  `left ↔ right`.
- The aggregate view has no diff-editor button. CSV export writes the same columns, with
  `change_type` = `differs` / `only_left` / `only_right`. When results were capped, the export message adds
  "(first N of M differences)", matching the rows export.
- Float sums are shown as plain JS numbers, and Δ is trimmed to 15 significant digits.

## Consequences

- A user can check totals between differently named tables with one scan per side, then switch to Rows to
  find the mismatched rows.
- `CompareRequest` gained optional `mode` and `aggregate` fields. Recents saved before v0.5.0 have no `mode`
  and still open in Rows mode.
- Rows mode is unchanged. The shared code that changed (results paging, the CSV stream helper, the sidebar
  label and the pipeline exports) was refactored without behaviour changes.
- **Known gap:** the generated SQL has been tested only on SQL Server. It runs `GROUP BY` and
  `COUNT(DISTINCT)` over `nvarchar(max)` expressions with `COLLATE`, and uses `CONVERT(…, 3)` for float sums.
  It has not been tried on Synapse dedicated or serverless pools. One aggregate compare on each pool type
  should confirm it, and grouping on `nvarchar(4000)` instead is a possible optimization if LOB grouping
  turns out to be slow.

## Not decided (out of scope)

MIN / MAX / AVG, expressions as group-by or measure columns, and an automatic drill-down from a differing
group to its rows.
