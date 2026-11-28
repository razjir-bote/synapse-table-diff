# Schema Compare: design (short)

## Intent

The user keeps a dedicated SQL pool schema and a Synapse serverless schema that should line up: every
table in the dedicated schema should exist in the serverless schema, usually as an external table or a view,
with the same columns and types. Today they can only check this one table at a time. They want one run that
lists every gap as a CSV report they can work through in Excel, ticking items off in a `status` column.

## Goals

- Compare two schemas (left = the schema you check, right = the one it should match) by object name.
  Names match case-insensitively. Tables, views and external tables all count on either side.
- Report, one CSV line per finding:
  - `missing_table`: in the left schema, no object of that name in the right schema.
  - `extra_table`: only in the right schema.
  - `missing_column`: the column is in the left object and not in the right one.
  - `extra_column`: the column is only in the right object.
  - `type_mismatch`: the base type differs (`int` vs `varchar`, `varchar` vs `nvarchar`).
  - `size_mismatch`: same base type, different length, precision or scale (`varchar(50)` vs
    `varchar(8000)`). Kept separate so serverless widening doesn't bury real mismatches.
- CSV columns: `issue, table, column, left_type, right_type, details, status`. `status` is always empty.
  Types are written as declared (`varchar(50)`, `nvarchar(max)`, `decimal(10,2)`). Rows are sorted by
  table, then issue (tables first), then column.
- Same CSV safety as the existing export: a UTF-8 BOM, RFC 4180 quoting, and formula neutralization.

## Non-goals

- Row data, nullability, column order, keys or indexes.
- Mapping differently named tables or columns.
- Fixing anything (no generated DDL).
- More than one schema per side in a run.

## Approaches considered

- **Step-by-step pickers (chosen by the user).** A "Compare schemas…" sidebar action and command opens
  VS Code quick picks for connection → database → schema, for left and then right. Each pick defaults to the
  last choice, so a re-run is six Enters. It needs the least code and looks native.
- Form webview like Compare Tables. It's easier to change one value, but it's a second webview to build
  and maintain for a mostly repeated check. Not chosen.

## How it works

1. Command `tableDiff.compareSchemas` ("Table Diff: Compare Schemas…"). Also a button in the Connections
   view title bar and a welcome-view link next to "Compare tables".
2. Pickers: saved connection (from the profile store), then database (`listDatabasesQuery`), then schema
   (a new `listSchemasQuery`: the schemas that hold at least one table, view or external table). The last
   choices are remembered in `globalState`.
3. One metadata query per side: every column of every `U`/`V`/`ET` object in the schema
   (`sys.objects` ⋈ `sys.columns` ⋈ `sys.types`, schema name bound as a string literal through `sqlString`).
   This runs on dedicated and serverless pools, and both sides run in parallel under a progress notification.
4. A pure function `diffSchemas(left, right)` returns the findings. A pure `schemaReportCsv(findings)`
   writes the text.
5. A save dialog defaults to `schema-diff_<leftdb>.<schema>_vs_<rightdb>.<schema>_<yyyymmdd-hhmm>.csv`
   in the first workspace folder. The file then opens with the OS default app (Excel), and an info
   notification summarizes the counts per issue type. With no findings, it says so and still offers to
   save.

## Left to the builder

- Type text: `max_length = -1` → `(max)`; `nchar`/`nvarchar` lengths in characters (bytes / 2).
  Precision/scale only for decimal/numeric; scale only for datetime2/time/datetimeoffset.
- `details` wording, e.g. `left object: table, right object: external table` on matched-table issues, or
  `length 50 vs 8000`.
- Tests: unit tests for the diff, type text and CSV. An integration test against the local SQL Server
  with two seeded schemas.
