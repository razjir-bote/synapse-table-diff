# Manual smoke-test checklist: Synapse dedicated and serverless pools

The automated tests run only against a local SQL Server 2022. This checklist is the
manual check against **your real Synapse pools**. Run it before relying on a release.
Anything that fails here is a bug to report, with the step number and the observed
message.

## Setup

- Extension installed from `synapse-table-diff-0.1.0.vsix` (see README).
- An Entra ID account with `SELECT` on the test tables on both pools.
- A test table on the dedicated pool and a matching table on serverless (an external
  table or view over the same data), for example `dbo.orders`.
- Record the pool name, database and table names used in each step's notes.

Run **step 15 first**. It checks the local build before any real pool is touched.

Marks: `[ ] Pass` and `[ ] Fail`. For each Fail, write what happened next to it.

---

### 1. Entra connection to the dedicated pool

**Action:** `Table Diff: Add Connection`. Server `<workspace>.sql.azuresynapse.net`,
database `<dedicated pool>`, authentication `Entra ID`. Sign in when prompted.

**Expected:** The message `Connected: dedicated SQL pool.` appears. The connection is
saved and listed in the Compare form. Its pool type is detected as `dedicated`.

- [ ] Pass
- [ ] Fail

### 2. Entra connection to serverless

**Action:** `Table Diff: Add Connection`. Server `<workspace>-ondemand.sql.azuresynapse.net`,
database `<database on serverless>`, authentication `Entra ID`.

**Expected:** The message `Connected: serverless SQL pool.` appears. The pool type is
detected as `serverless`. The Compare form shows the serverless cost note when this side is chosen.

- [ ] Pass
- [ ] Fail

### 3. Connect with the dedicated pool paused

**Action:** Pause the dedicated pool in the Azure portal and wait until its status is
Paused. Run `Table Diff: Compare Tables…` and pick a table on that pool.

**Expected:** Within seconds, an error reads `Pool "<database>" on <server> is paused.
Resume it in the Azure portal and try again.` The run does not hang or show a generic
timeout. Resume the pool afterwards.

- [ ] Pass
- [ ] Fail

### 4. Schema-only differences between two tables

**Action:** Pick two tables with the same key and data but different columns: one column
added on one side, one column with a changed type, one with a changed nullability. Compare them.

**Expected:** The Schema tab lists each added or removed column with its status. Type and
nullability changes show as `changed (type, nullability)` or the matching subset. The
summary's `Schema differences` count is correct. The data counts use only shared,
non-excluded columns.

- [ ] Pass
- [ ] Fail

### 5. Dedicated vs serverless data diff on a table of 10 million or more rows

**Action:** Compare the dedicated table with its serverless counterpart (at least 10M
rows). Note the start and end times and the **Duration** shown in the summary. On the
serverless side, note the data-processed figure for the run (Azure portal, Data processed).

**Expected:** The comparison completes without a timeout. Duration and counts are shown.
Re-running the same comparison gives the same counts.

- Duration: ______  Serverless data processed: ______

- [ ] Pass
- [ ] Fail

### 6. String-heavy table: varchar UTF-8 collation (serverless) vs nvarchar (dedicated)

**Action:** Compare a table with many `varchar` columns in a UTF-8 collation on serverless
with the same data stored as `nvarchar` on dedicated. Use the default options (ignore case off,
ignore trailing spaces off).

**Expected:** No changed rows caused by the type or collation difference. Only real data
differences appear, and the Schema tab does not report the type change as a data difference.
Accented and non-ASCII values match exactly.

- [ ] Pass
- [ ] Fail

### 7. Wide row with nvarchar(max) values over 8,000 bytes

**Action:** Compare a table with an `nvarchar(max)` column holding values longer than
8,000 bytes, on both pools.

**Expected:** The comparison completes on both pools with no `HASHBYTES` input-length
error. Equal long values show no differences. Changing one character in a long value on
one side shows that row as changed.

- [ ] Pass
- [ ] Fail

### 8. datetimeoffset column

**Action:** Compare a table with a `datetimeoffset` column where the same instant is stored
with different offsets on each side.

**Expected:** The comparison completes on both pools. `SWITCHOFFSET` works, and equal
instants do not show as changed.

- [ ] Pass
- [ ] Fail

### 9. Cancel mid-run

**Action:** Start a comparison of a large table on the dedicated pool. Click cancel in the
progress notification once the stage is `Computing checksums…` or later.

**Expected:** The message `Comparison cancelled.` appears and no results panel opens. Then
run this in Synapse Studio against the dedicated pool:

```sql
SELECT request_id, status, command
FROM sys.dm_pdw_exec_requests
WHERE status NOT IN ('Completed', 'Failed', 'Cancelled');
```

No request from this extension may still be `Running` or `Suspended`.

- [ ] Pass
- [ ] Fail

### 10. Export CSV and open in Excel

**Action:** Open a result with differences, click `Export CSV`, save the file, and open it in Excel.

**Expected:** The save dialog appears. The message `Exported N rows.` appears, or the capped
form `Exported N rows (first N of M differences).` if the detail limit was hit. Excel opens
the file with the same values as the grid, and non-ASCII text is not mangled.

- [ ] Pass
- [ ] Fail

### 11. Open in diff editor

**Action:** On a result with differences, click `Open in diff editor`.

**Expected:** VS Code's diff editor opens with the left and right rows aligned by key, one
row per line. Changed rows are visibly different on the two sides.

- [ ] Pass
- [ ] Fail

### 12. Many differing buckets (more than about 1,000 mismatched buckets)

**Action:** Compare a pair of tables whose data differs widely, so that more than about 1,000
buckets mismatch. Run it with a dedicated side, then with a serverless side, and record each duration.

**Expected:** Both runs complete with no SQL error. This exercises the generated `UNION ALL`
bucket-filter query on both pool types.
Duration: dedicated ______  serverless ______

- [ ] Pass
- [ ] Fail

### 13. Re-bucketing prompt on serverless

**Action:** Set `tableDiff.pairLimit` to `1000`. Compare tables with differences, with a
serverless side. Run it twice: once choosing **Continue**, once choosing **Cancel**. Restore
the setting afterwards.

**Expected:** A modal appears with `Many differences found. Narrowing further needs one more
scan of the serverless side(s) (billed per data processed). Continue?`. With **Continue**, the
comparison completes with results. With **Cancel**, the comparison still completes without the
extra scan.

- [ ] Pass
- [ ] Fail

### 14. Error on one side mid-run

**Action:** Start a comparison. Mid-run, either revoke `SELECT` on the table for the signed-in
user, or pause the dedicated pool.

**Expected:** A clear error appears within seconds (`Comparison failed: …`, or the paused-pool
message). The run does not hang, and no results panel opens for the failed run.

- [ ] Pass
- [ ] Fail

### 15. Local build against the Docker SQL Server (run first)

**Action:**

1. In the repository, run `npm run compile`.
2. Seed the local databases once with `npm run test:integration`.
3. Press **F5** in VS Code to open an Extension Development Host.
4. In the host window, run `Table Diff: Add Connection`. Server `localhost,14333`, database
   `tablediff_a`, authentication `SQL login`, user `sa`, with the password from your `.env`
   (see `.env.example`, `TABLEDIFF_TEST_CONN`). Use the same settings for `tablediff_b`.
   At the prompt `Trust the server certificate?`, choose **Yes**. The local Docker server uses a
   self-signed certificate; only do this for local or dev servers.
5. Run `Table Diff: Compare Tables…`: left `tablediff_a.dbo.orders`, right
   `tablediff_b.dbo.orders`, key column `order_id`.

**Expected:** The summary shows Removed 10, Added 5, Changed 54. The run completes in a few seconds.
A banner says `1 column(s) were not compared because their types differ or are unsupported; see the
Schema tab.` (`qty` is `varchar` on the left and `int` on the right).

- [ ] Pass
- [ ] Fail

### 16. External table on serverless

**Action:** On the serverless pool, open the table list for a database that has an external table.
Pick the external table on one side (and a matching table or external table on the other) and compare.

**Expected:** The external table is listed as `<schema>.<name> (external table)`. The comparison
completes with no SQL error and the counts match what you expect.

- [ ] Pass
- [ ] Fail

### 17. More than 5,000 differences on a large table

**Action:** Compare two large tables (10 million rows or more) that differ in more than 5,000 rows
spread across the table, with default settings. Record the duration.

**Expected:** The counts are exact. A banner says `Showing the first N of M differing rows.` with N at
most the number of rows in 5,000 detail buckets (about 5,000) and M the full count. The changed-rows
stage does not take noticeably longer than the checksum stage.
Duration ______

- [ ] Pass
- [ ] Fail
