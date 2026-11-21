# Synapse Table Diff — VS Code Extension Design

Date: 2026-11-21
Status: Draft for review

## Intent

A VS Code extension that compares two database tables and shows the differences the way `git diff` shows code changes: what was added, removed and changed, down to the individual cell. The user works mainly with **Azure Synapse dedicated SQL pools** and **Synapse serverless SQL pools**, where tables commonly hold **tens of millions of rows or more**.

All three of these situations matter and must be supported:

1. **The same table in two environments**, e.g. dev vs prod, or before vs after a migration. The two sides can be on different pools, including dedicated vs serverless.
2. **Two tables in one database**, e.g. a staging table vs the live table.
3. **Tables whose columns differ.** The schema differences are themselves part of the diff.

## Goals

- Compare any two tables (or views) reachable over the SQL Server protocol, with first-class support for Synapse dedicated and serverless pools.
- Report schema differences: columns added or removed, type, nullability and order changes.
- Report data differences matched by a user-chosen key: rows added, rows removed, and rows changed, with the changed cells named.
- Stay practical at tens of millions of rows and beyond: never pull whole tables to the client.
- Present results in a git-diff-like way: a summary first, then a browsable list of differences.

## Non-goals (for v1)

- Comparing tables **without** a unique key (whole-row multiset diff). This may be added later.
- Database engines other than SQL Server / Synapse (Postgres, Snowflake, etc.).
- Writing fixes back, e.g. generating sync scripts. Read-only only.
- Scheduled or CI-run comparisons.
- Mapping differently named columns. Columns are matched by name only, case-insensitively. A renamed column shows up as one removed and one added column in the schema diff (user decision).

## Anti-goals (a failure even if it technically works)

- Pulling full tables into VS Code. That is slow, can exhaust memory, and on serverless the cost scales with data scanned.
- Reporting differences that aren't real. Type-only differences across environments (e.g. `varchar` vs `nvarchar`, `datetime` vs `datetime2` holding the same value) must not show up as data changes.
- Silently reporting "no differences" when a comparison was incomplete, e.g. because of duplicate keys, a timeout or a cancelled query.
- A paused dedicated pool showing up as an opaque timeout.

## Constraints

- **No cross-database queries.** Dedicated pools don't support them, and a dedicated pool can't query a serverless one. The extension must query each side separately and compare client-side.
- **Keys aren't enforced.** Synapse `PRIMARY KEY` / `UNIQUE` constraints are `NOT ENFORCED` and often absent, so duplicate keys are possible and must be detected.
- **SQL dialect differences.** Dedicated and serverless pools support slightly different T-SQL. Every generated query must run on both.
- **Serverless billing** is per data processed. The checksum pass scans each table once, which can't be avoided. Narrowing passes should touch as little data as possible.
- **Serverless pools have no native tables.** Their objects are external tables or views over data-lake files (Parquet, Delta, CSV). A key-hash filter can't prune files, so *every* query against a serverless side is effectively a full scan. That is why the pipeline below is capped at a fixed number of passes, not repeated recursive splits.
- Must run in VS Code on Windows (the user's platform), and should also work on macOS and Linux.

## Approaches considered

| Option | Summary | Trade-off |
|---|---|---|
| **A. TypeScript extension with its own comparison engine** (chosen) | Node `mssql` driver; the extension generates Synapse-compatible checksum queries; a webview shows the results | One language, normal install, full control over SQL that must work on both pool types. We write the diff algorithm ourselves. |
| B. Wrap a Python diff tool (`reladiff`, the fork of Datafold `data-diff`) | Extension shells out to Python | The algorithm exists already, but Python and ODBC installs are required, Synapse dialect gaps would need patching in someone else's code, and the UI is still ours to build. |
| C. Run the comparison as Synapse jobs | Extension starts SQL or notebook jobs | Can't compare across the two pools, which is a core case, and adds many moving parts. |

**The user picked A.** B adds setup pain and dialect risk for little gain, and C fails the cross-pool case.

## Design (decided)

### Connections and authentication

- Connections are saved as named profiles: server, database, auth method and pool type (dedicated or serverless, auto-detected where possible).
- **Primary auth: Microsoft Entra ID** through VS Code's built-in `microsoft` authentication provider, with a token for `https://database.windows.net/`.
- **Fallback: SQL authentication.** Passwords are kept in VS Code `SecretStorage`, never in settings.
- Before a run, detect a paused or unreachable dedicated pool and show a clear message, e.g. "Pool `sqlpool01` is paused."
- Tokens are requested fresh for each new connection. Each pipeline pass opens its own connection, so a long run never depends on one token outliving its lifetime. VS Code's auth provider handles MFA and Conditional Access sign-in interactively.

### Starting a comparison

A command, **"Table Diff: Compare Tables…"**, opens a setup form in a webview panel:

- **Left** and **Right**: a connection, then schema and table/view, each picked from a list.
- **Key columns**: one or more. The form pre-fills declared PK/unique columns if any exist, and the user can always change them.
- **Columns to compare**: defaults to every column present on both sides. The user can exclude some, such as load timestamps.
- **Optional row filter**: a `WHERE` clause applied to both sides, e.g. a date range.
- Recent comparisons are saved so they can be re-run in one click.

### The comparison pipeline

1. **Schema diff.** Read column metadata from both sides (`INFORMATION_SCHEMA.COLUMNS` / `sys.columns`, whichever works on both pool types). Report added and removed columns and type, nullability and position changes. The data diff runs over shared, non-excluded columns only.
2. **Bucket checksums (pass 1).** On each side, assign every row to one of *N* buckets by a hash of its normalized key. Per bucket, return the **row count**, the **distinct key count** (so the key check costs no extra scan), and **two independent sums of 64-bit per-row hashes**. Two sums make a false "match" from collisions or cancelling values negligibly likely. A match in both counts and both sums is accepted as equal. There's no separate verification pass.
3. **Key check.** Any bucket where row count ≠ distinct key count has duplicate keys. NULL keys go into a dedicated bucket. Duplicate and NULL keys are fetched (keys plus a sample of rows), **excluded from the data diff**, and listed on their own "Key problems" tab. The summary banner says the result is incomplete for those keys. The comparison continues for all other keys.
4. **Narrowing (pass 2).** One query per side fetches `(key, row hash)` for **all** mismatched buckets at once (`WHERE bucket IN (…)`). These pairs are compared in memory, which classifies each key as added, removed or changed. If the mismatched buckets together would return more than a configurable limit of pairs, the extension first re-buckets just those buckets with a larger *N* (one extra pass). It warns before doing so on a serverless side.
5. **Detail fetch (pass 3).** Fetch full rows only for differing keys, in batches, up to the **detail limit** (default 100,000 differing rows, configurable). Work out which cells changed. Counts of added, removed and changed rows are always exact. Only the browsable details are capped, and the UI says so when the cap is hit.

On a serverless side this is about three scans per run, which is inherent to the approach. The setup form shows a short note to that effect.

**What gets hashed.** The row hash covers exactly the compared columns: shared, non-excluded and non-key. Columns are taken in a fixed order, sorted by column name using case-insensitive matching, so column order on either side doesn't matter. The extension generates this SQL per run from the schema-diff result, using the same column list and normalization expressions on both sides.

**Cross-type columns.** For a shared column whose types differ between sides:
- **Same family** (integer types; `decimal`/`numeric`/`money`; `float`/`real`; character types; date/time types; `bit`): normalize **by value**, so `1.0` equals `1.00`, and `datetime` `12:00:00.000` equals `datetime2` `12:00:00.0000000`. Date/time values are compared at the coarser of the two precisions. Floats are compared at a fixed number of significant digits.
- **Different families** (e.g. `varchar` vs `int`): the column is **excluded from the data diff** and flagged in the schema diff with an explanation. It is never hashed as-is.
- Unsupported types (spatial, `xml`, `sql_variant`, large LOBs beyond a size limit) are excluded with a warning in the same way.

**String semantics.** Default is **exact**: case-sensitive and accent-sensitive, with trailing spaces significant. This is achieved by hashing binary `nvarchar` (UTF-16) content, so the two sides' collations don't affect the result. The setup form has two toggles: **ignore case** and **ignore trailing spaces**. These apply to both key matching and value comparison.

**Normalization rule (critical).** Before hashing, each value must be turned into a canonical string so that values that are logically equal hash the same across environments and types:
- strings in one consistent Unicode form, cast to `nvarchar`;
- date/time values in ISO 8601 (`CONVERT(..., 126)`) at a fixed precision;
- numbers with a canonical representation, with floats at fixed precision;
- `NULL` written as a sentinel that can't collide with any real value;
- a column separator that can't appear in values, or length-prefixed values.

Key-hash bucketing works for any key type, including composite and non-integer keys, and it spreads rows evenly. A per-row hash plus a summed or similar aggregate catches changes that `CHECKSUM`/`BINARY_CHECKSUM` would miss.

### Results view (webview panel)

- **Summary header:** rows compared on each side, counts of changed, added and removed rows, schema-difference count, duration, and a warning banner if anything was incomplete (duplicate keys, a cancellation, errors).
- **Schema tab:** a side-by-side column list with differences highlighted.
- **Data tab:** a virtualized, paged grid of differing rows, filterable by added, removed or changed. Changed rows show left and right values, with the changed cells highlighted. Added and removed rows are coloured like git: green and red.
- **Open in diff editor:** writes the differing rows on each side as aligned text, one row per line, sorted by key, and opens VS Code's built-in diff editor for the classic view.
- **Export** of the differences to CSV.

### Running behaviour

- Progress is shown with a VS Code progress notification by stage (schema, checksums, narrowing, details), and the run can be cancelled. Cancelling stops queries on both sides.
- The two sides are queried in parallel.
- Query timeouts are configurable, with sensible defaults for long checksum scans.

## Testing

The builder has **no access to real Synapse pools** (user decision). So:

- **Automated tests run against a local SQL Server**, e.g. SQL Server Developer edition in Docker, or LocalDB on Windows. These cover the whole pipeline end to end with seeded tables designed to hit every case: added, removed and changed rows; cross-type columns; duplicate and NULL keys; case and trailing-space differences; a large table of several million rows to check bucketing.
- **A local SQL Server doesn't apply Synapse's SQL restrictions**, so all generated SQL is built from a short, documented **allow-list of constructs known to work on both dedicated and serverless pools**, collected in one SQL-generation module. A unit test checks the generated SQL against that list and fails on anything outside it, such as cross-database names, `MERGE`, temp-table tricks or unsupported functions.
- **A manual smoke-test checklist**, for the user to run against their real dedicated and serverless pools before relying on a release. It covers connecting with Entra ID, a paused pool, a schema diff, a dedicated-vs-serverless data diff, and cancellation. Anything that fails there comes back as a bug report.

## Left to the builder

- The exact hash and aggregate functions, chosen to run on **both** dedicated and serverless pools (e.g. `HASHBYTES('SHA2_256', …)` truncated to `BIGINT`, summed as `DECIMAL(38,0)` to avoid overflow). Check the input-length limits and function support on each pool type.
- Bucket count *N*, the pass-2 pair limit and the re-bucketing factor. Choose these from measurements on realistic tables.
- Where results live. In memory is fine up to the detail limit. Stream the CSV export.
- How the normalization handles less common types (`varbinary`, `uniqueidentifier`, `decimal` with different scales, `time`, spatial types). Reasonable: support common types first, and report unsupported column types clearly instead of hashing them inconsistently.
- The webview framework (plain TS or a small framework) and the grid component.
- Project structure, test strategy and packaging (`vsce`).
- Whether to also read connection profiles from the official MSSQL extension. It's nice to have, not required.
