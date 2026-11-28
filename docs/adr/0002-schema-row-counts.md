# ADR 0002: Row counts in Compare Schemas

- **Status:** Accepted, shipped in v0.6.0 (2026-11-28)
- **Design:** [`docs/superpowers/specs/2026-11-28-schema-row-counts-design.md`](../superpowers/specs/2026-11-28-schema-row-counts-design.md)
- **Plan:** [`docs/superpowers/plans/2026-11-28-schema-row-counts.md`](../superpowers/plans/2026-11-28-schema-row-counts.md)
- **Branch:** `feat/schema-row-counts`, merged locally into `main` (no pull request)

Each decision below is marked **User** (chosen by the product owner during design) or **Designer** (a call
made while designing or building, recorded so it can be revisited).

## Context

Compare Schemas (v0.4.0) reports structural gaps between two schemas, such as a dedicated SQL pool schema and
a Synapse serverless schema: missing and extra tables and columns, and type and size mismatches. The user
compares two datasets that should be identical, so after structure the next question is whether each matched
table holds the same number of rows. Compare Tables can answer that, but only one table at a time.

## Decisions

### 1. An add-on to Compare Schemas, not a separate command — User

After the four schema picks, a fifth quick pick, **Compare row counts too?**, offers **Structure only** or
**Structure and row counts**. The answer is remembered with the other picks
(`tableDiff.schemaCompare.last`, new field `rowCounts`). Row-count findings go into the same CSV report.

- *Why:* one run gives one checklist covering both structure and volume, and the pickers, remembered choices,
  save dialog and CSV writer are reused.
- *Alternative rejected:* a separate "Compare Row Counts…" command with its own CSV listing every table,
  matches included. It would work better as evidence that the datasets agree, but it means two runs and two
  files to work through.
- "Structure only" stays the default and behaves as before.

### 2. Exact counts, no filters — User

Each side runs `SELECT COUNT_BIG(*) AS cnt FROM [schema].[object]` with its own spelling of the name, and the
query passes the SQL allow-list. There is no per-table date filter or sampling.

- *Why:* the datasets should be identical, so any difference is a finding. A filter would only be needed if
  one side were behind by design.

### 3. A real COUNT_BIG(*) on the dedicated side too, not stored statistics — Designer

The dedicated pool can report row counts from partition statistics without a scan, but those can drift on
columnstore tables after deletes.

- *Why:* one false mismatch would undermine trust in the whole report. A full count is fast on a dedicated
  pool anyway.
- *Cost:* on serverless each count reads the table's files, so it is billed for the data scanned. The pick's
  description and the README say so.

### 4. Only names found on both sides are counted — Designer

Tables on one side only are already reported as `missing_table` or `extra_table` and aren't counted. Names
match case-insensitively, as elsewhere in Compare Schemas. A table can match a view or an external table.

### 5. Four tables at a time, with both sides of a table in parallel — Designer

`countMatchedTables` in `src/schemaCompare/rowCounts.ts` is a pool of 4 workers. Each worker counts one
table, left and right in parallel.

- *Why:* a large schema still finishes in a reasonable time without flooding the serverless pool.

### 6. Connections are reused per side while counting — Designer (from the final review)

The first build opened a connection for every count. Each open also ran a probe login, so every count cost
two logins per side. For a schema with hundreds of tables on Synapse, that added minutes. The env now offers
`session(side)`:

- it builds the connector once;
- it keeps a small pool of open runners, reusing a runner after a successful query and closing and discarding
  it after any error;
- it closes all runners when counting ends.

Structure queries still use one connection per query.

### 7. New issue types, with counts in `details` — Designer

- `row_count_mismatch`: details read `left 1,204,331 rows, right 1,204,300 rows (31 fewer on the right)`,
  or `… more on the right`.
- `row_count_error`: the count failed on one side or both. Details read `left: <message>` and/or
  `right: <message>`. There is one finding per table, and the other tables are still counted.
- Both come after `size_mismatch` in the issue order, and their `column`, `left_type` and `right_type` are
  empty.
- *Why counts go in `details`:* the existing CSV header (`issue, table, column, left_type, right_type,
  details, status`) keeps its meaning.
- Counts are compared as `BigInt`, never as JS numbers, so counts above 2^53 stay exact. Numbers use `,`
  as the thousands separator whatever the locale.
- When counting ran and every count matched, the summary adds `row counts match for N tables`.

### 8. Cancel abandons the whole run — Designer

The progress notification can be cancelled. Cancel stops new counts from starting, aborts running queries
through an `AbortSignal` passed to `runner.query`, and ends the run with no save dialog, file or message.

- *Why:* a half-checked report could be mistaken for a complete one, and the structure part is quick to
  re-run.
- Only errors raised inside the progress phase count as a cancel. An error from the save dialog or file
  write after the progress has finished still shows `Schema compare failed: …`.

## Consequences

- One run can now confirm that two datasets match in structure and volume. The report lists the gaps, and
  the user ticks them off in the `status` column.
- `SchemaCompareEnv` changed:
  - `query` takes an optional signal;
  - `withProgress` passes a signal;
  - `pick` items take a `description`;
  - there is a new `session(side)`.
- Remembered choices saved before v0.6.0 have no `rowCounts` and default to "Structure only".
- The progress notification for a structure-only run now has a Cancel button too.
- While packaging v0.6.0, `.claude/**` was added to `.vscodeignore`. A local agent worktree under `.claude/`
  held a copy of `.env`, and without this rule the package would have included it.
- **Known gaps:**
  - It is tested only on SQL Server. Counting has not been tried on Synapse dedicated or serverless pools.
  - If a count finishes just as the run is cancelled, its connection can stay open until VS Code closes it.
    The fix would be a `closed` flag on the session pool.
  - If one side has two names that differ only by case (possible under a case-sensitive collation), only
    one of them is counted. Compare Schemas' structure diff has the same limitation.

## Not decided (out of scope)

Per-table filters or watermarks, approximate counts from statistics, counting tables found on one side only,
a partial report on cancel, and retrying transient failures.
