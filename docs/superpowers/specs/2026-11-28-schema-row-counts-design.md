# Schema Row Counts: design (short)

## Intent

The user compares two datasets that should be identical: a dedicated SQL pool schema and a Synapse
serverless schema. Compare Schemas already reports structural gaps. They also want to know which matched
tables hold a different number of rows, in the same report they work through.

## Goals

- After the four schema picks, Compare Schemas asks one more quick pick:
  - `Structure only`
  - `Structure and row counts`, described as `Counts every table found on both sides; serverless reads each
    table's files`.
  The last answer is remembered with the other choices and listed first next time.
- Row counts are exact: `SELECT COUNT_BIG(*) AS cnt FROM <schema>.<object>` on each side, with each side's
  own spelling of the name (quoted with `quoteIdent`). No stored statistics and no filters, since the datasets
  should be identical.
- Only names found on both sides are counted. Missing and extra tables are already reported and aren't counted.
- New findings in the same CSV:
  - `row_count_mismatch`: `details` reads `left 1,204,331 rows, right 1,204,300 rows (31 fewer on the
    right)`, or `more on the right`.
  - `row_count_error`: the count failed on one side, for example when an external table's files are missing.
    `details` gives the side and the SQL error message. The run continues with the other tables.
  - `column` is empty. `left_type` and `right_type` are empty.
- Order: these two issues come after `size_mismatch` in the issue order. Rows are still sorted by table,
  then issue.
- The summary notification adds counts for the new issues, for example `3 row count mismatches`. When
  counting ran and every count matched, it says `row counts match for N tables`.
- "Structure only" behaves exactly as Compare Schemas does today.

## Non-goals

- Filters, sampling, approximate counts from stored statistics.
- Counting tables that are on one side only.
- Checking contents, which is what Compare Tables does.

## Approaches considered

- **Add-on to Compare Schemas (chosen by the user).** One run gives one checklist covering structure and
  volume.
- Separate "Compare Row Counts…" command with its own CSV listing every table. That is better as evidence,
  but it means two runs and two files. Not chosen.

## How it works

1. `countRowsQuery({ schema, name })` in `queries.ts` returns `SELECT COUNT_BIG(*) AS cnt FROM <qualifiedName>`.
   It must pass `assertAllowedSql`. `COUNT_BIG` is already allowed.
2. After the schema diff, the command takes the matched pairs (left name, right name), sorted by name, and
   counts them four tables at a time. Each table runs its two side queries in parallel. Counts arrive as
   bigint, possibly as strings, and are compared as `BigInt`.
3. Progress: `Counting rows 12 of 140: dbo.sales…`. The progress notification is cancellable. Cancel stops
   scheduling new counts, cancels running queries, and abandons the run without a save dialog, so there is
   no half-checked report. The schema part is cheap to re-run.
4. A pure `rowCountFindings(results)` turns `{ table, left: bigint | Error, right: bigint | Error }[]` into
   findings. They are merged with the schema findings before sorting and writing the CSV.

## Calls made by the designer (not the user's)

- Exact `COUNT_BIG(*)` instead of dedicated pool partition statistics. Statistics can drift on columnstore
  tables after deletes, and a false mismatch would undermine the report.
- Four tables at a time, so the serverless pool isn't flooded and a large schema still finishes in a
  reasonable time.
- Counts go in `details` rather than in the `left_type`/`right_type` columns, so the existing CSV header
  doesn't change meaning.
- Cancel abandons the whole run rather than writing a partial report.

## Left to the builder

- Whether counting reuses one connection per side or opens one per query (env `query` opens one per query
  today). Keep at most four in flight per side.
- Thousands separators in `details`: always `,`, independent of locale.
- Tests: unit tests for `rowCountFindings`, the query text and the allow-list, the extra pick and its
  remembered default, cancellation, and a failing count. An integration test against the local SQL Server
  with seeded tables whose counts match and differ.
