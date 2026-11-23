# Table Diff

Compare two tables the way `git diff` compares files: a summary first, then every added,
removed and changed row, down to the cell. Built for Azure Synapse **dedicated** and
**serverless** SQL pools, and it also works with SQL Server.

> **Status: tested automatically only against a local SQL Server 2022.** Behaviour on real
> Synapse pools must be confirmed with `docs/smoke-test-checklist.md` (in the repository)
> before you rely on a result.

## Features

- Compare two tables, views or external tables, on the same pool or across a dedicated and a serverless pool.
- Schema diff: added or removed columns, and type, nullability and position changes.
- Data diff matched by one or more key columns: added, removed and changed rows, with the
  changed cells named.
- Never copies whole tables into VS Code. Comparison runs as a fixed number of checksum
  passes. Only the rows in the checksum buckets that contain the shown differences are read for
  display, and only the differing rows among them are kept.
- Key problems (duplicate and NULL keys) are reported on their own tab. They are never
  silently counted as matches.
- Export differences to CSV, or open them in VS Code's diff editor.
- Read-only. The extension never writes to either side.

## Install from the .vsix

1. Build the package (see Building) or obtain `synapse-table-diff-0.3.2.vsix`.
2. In VS Code, open the Extensions view, choose **...** > **Install from VSIX…**, and select the file.
   Or run `code --install-extension synapse-table-diff-0.3.2.vsix`.
3. Reload the window if VS Code asks.

## The Table Diff sidebar

Click the **Table Diff** icon in the activity bar on the left to open the sidebar. You can do
everything from there without the Command Palette:

- **Connections:** your saved connections. Use **+** in the title bar to add one, and the bin icon
  on a row (or right-click > Remove Connection) to remove it.
- **Recent Comparisons:** your last 10 comparisons. Click one to open it pre-filled in the setup
  form, or press **▶** to run it again straight away.
- **New comparison** (the diff icon in the title bar) opens the setup form.

When a list is empty, the sidebar shows buttons to add a connection or start a comparison. Every
action is also available as a `Table Diff:` command in the Command Palette.

## Adding connections

Click **+** in the sidebar's Connections title bar, or run **Table Diff: Add Connection** from the
Command Palette (`Ctrl+Shift+P`).

> **Use a read-only login.** The extension only reads, but give it a login or Entra identity that
> can only read (for example the `db_datareader` role) on both sides, especially production. That
> is the real safeguard if a filter or a future bug ever sends something unexpected.

1. Enter a name, the server (for example `myworkspace.sql.azuresynapse.net`) and the database.
2. Choose the authentication method:
   - **Entra ID:** sign in through VS Code's Microsoft account. You can give an optional tenant ID.
     VS Code handles MFA and Conditional Access interactively.
   - **SQL login:** enter the user name and password. The password is stored in VS Code's
     SecretStorage, never in settings.
3. The extension tests the connection and reports the pool type: `Connected: dedicated SQL pool.`
   or `Connected: serverless SQL pool.` If the test fails, you can still save the connection.

A dedicated pool that is **paused** shows `Pool "<database>" on <server> is paused.` Resume the
pool in the Azure portal and try again.

To remove a connection, run **Table Diff: Remove Connection**.

## Running a comparison

1. Run **Table Diff: Compare Tables…**.
2. Choose the **Left** and **Right** connection, then the schema and table, view or external table on each side.
3. Choose one or more **key columns**. Declared primary or unique keys are pre-filled when they exist.
4. Choose **Columns to compare**. By default every shared column is compared. Exclude load
   timestamps or other columns that should not count as differences. To compare only a few columns,
   click **Exclude all**, then untick the ones you want; **Include all** clears the list. Key columns
   are never excluded, and the form shows how many columns will be compared.
5. Optionally enter a **filter**: a T-SQL `WHERE` condition applied to both sides, for example a date range.
   It must be a single condition: `;`, `/* */` comments, unbalanced parentheses and statement words such as
   `INSERT`, `UPDATE`, `DELETE`, `DROP`, `EXEC`, `INTO` or `GO` are rejected (inside quoted strings or
   `[bracketed]` names they are fine).
6. Optionally tick **ignore case**, **ignore trailing spaces**, or **treat NULL and blank text as the
   same**. By default comparisons are exact.
7. Start the comparison. The progress notification is titled with the two tables and shows what is
   happening, with the elapsed time ticking every few seconds:
   - connecting, then which connections and pool types were reached;
   - which columns are compared, and that each table is being scanned for checksums;
   - row counts on each side and how many checksum groups differ (about how many rows that covers);
   - live counts while keys are compared (`Compared 150,000 of about 1,200,000 rows: 12 changed, 3 added, 0 removed so far…`);
   - the totals found and how many rows are being fetched to show.

   When it finishes, a notification summarises the result (time taken, changed / added / removed and
   row counts). You can cancel at any time. Cancelling stops the queries on both sides and shows
   `Comparison cancelled.`

Recent comparisons are saved. Run **Table Diff: Re-run Recent…** to reopen one in the setup form.

## Reading the results

The summary header shows:

| Item | Meaning |
|---|---|
| Left rows / Right rows | Rows compared on each side, within the filter. |
| Changed | Keys present on both sides with different values in at least one compared column. |
| Added | Keys present only on the right side. |
| Removed | Keys present only on the left side. |
| Schema differences | Count of column-level differences in the Schema tab. |
| Duration | Total run time. |
| Pools | The pool type detected for each side. |

A warning banner appears if the result is incomplete, for example because of duplicate keys, because
only some of the differing rows are shown, or because some shared columns were not compared (their types
differ or are unsupported). A cancelled or failed run opens no results: cancelling shows the message
`Comparison cancelled.`, and an error shows an error message.

The tabs are:

- **Schema:** the columns side by side with their status. Columns that cannot be compared (for
  example different type families such as `varchar` against `int`) are listed under *Excluded
  columns* with the reason.
- **Data:** the differing rows, filterable by All, Changed, Added or Removed. Changed rows show both
  values with the changed cells highlighted. Added and removed rows are green and red.
- **Key problems:** duplicate and NULL key samples. Those keys are left out of the data diff, so
  the result is incomplete for them.

Use **Open in diff editor** to see the differences side by side in VS Code's diff editor. Each
differing key is a block that sits on exactly the same lines on both sides:

```
== CHANGED  order_id=200          | == CHANGED  order_id=200
   amount  : 1.23                 |    amount  : 1.2400
```

For changed rows only the fields that differ are listed, one per line, so the diff editor highlights
exactly those fields. Added and removed rows list every column on the side that has the row, with a
note on the other side. NULL shows as `NULL` and an empty string as `''`.

Use **Export CSV** to save the differences. The export is streamed to disk. Values that a spreadsheet would treat as a
formula (starting with `=`, `+`, `-`, `@` or a tab, other than plain numbers such as `-5`) are written with a
leading `'`, so opening the file in Excel cannot run them.

## Settings

All settings are under `tableDiff.*` and are read at the start of each run.

| Setting | Default | Purpose |
|---|---|---|
| `tableDiff.pairLimit` | `2000000` | Maximum number of row pairs compared in the narrowing pass. If more mismatched rows than this remain, the extension re-buckets once more, which on serverless asks for confirmation first. |
| `tableDiff.detailLimit` | `100000` | Maximum number of differing rows fetched for the browsable Data tab (at most 1,000,000). Counts are always exact. The UI says so when the cap is hit. |
| `tableDiff.inListCap` | `5000` | Maximum number of bucket ids per narrowing or detail filter (1 to 20,000). The Data tab shows only the differences in the first this-many detail buckets, so with many differences it can show fewer rows than `detailLimit`; counts stay exact and a banner says how many rows are shown. |
| `tableDiff.queryTimeoutSeconds` | `3600` | Query timeout in seconds (at least 30). |

The **Trust the server certificate?** prompt in Add Connection is opt-in (default **No**). Choose **Yes**
only for a local or development server with a self-signed certificate. Trusting a certificate on a
production or untrusted network exposes the connection to interception.

## Serverless cost note

Serverless pools are billed per data processed. A comparison involving a serverless side scans its
data about **three times**: once for the checksums, once for the narrowing pass and once for the changed
rows. This cannot be avoided with this approach. If the narrowing pass needs one more scan, the extension
asks you to confirm with a modal dialog before it runs. Choosing **Cancel** finishes the comparison
without that extra scan.

## How values are compared

- **Treat NULL and blank text as the same** (off by default): in compared text columns, NULL, an empty
  string and a spaces-only string all count as equal. It does not apply to key columns, or to
  non-text columns (a number can't be blank).

- Columns are matched by name, case-insensitively. Column order does not matter.
- Columns of the same family (for example `varchar` and `nvarchar`, or `datetime` and `datetime2`)
  are compared by value, so storage type alone does not produce differences.
- Strings are compared exactly by default: case-sensitive, accent-sensitive, with trailing spaces significant.

## Limitations

- **No key-less comparison.** Every comparison needs at least one key column. Whole-row multiset
  comparison is not supported.
- **No column renames.** Columns are matched by name only. A renamed column appears as one removed
  column and one added column.
- **Read-only.** The extension never writes to either database and does not generate sync scripts.
- **Testing scope.** The automated tests run only against a local SQL Server 2022. Synapse behaviour
  is confirmed by the manual smoke-test checklist (`docs/smoke-test-checklist.md`, in the repository).
- **Other engines.** Only SQL Server and Synapse are supported.

## Building

Requirements: Node.js 18 or later, and Docker for the integration tests.

```sh
npm install
npm run compile        # bundles dist/extension.js and the webviews
npm run typecheck
npm test               # unit tests, no database needed
npm run test:integration   # needs the local SQL Server: docker compose up -d, and .env (see .env.example)
npm run package        # writes synapse-table-diff-0.3.2.vsix
```

`npm run package` runs `vsce package --allow-missing-repository --skip-license`. The package has no
repository URL and no licence file yet, so those two checks are skipped. Remove the flags once the
package has a repository and a `LICENSE`. The `.vsix` excludes `test/`, `src/`, `docs/`, `.env*`,
`coverage/` and `.superpowers/`, as set in `.vscodeignore`. The runtime `mssql` driver is bundled into
`dist/extension.js`, so `node_modules` is not shipped.

The `.env` file is for the local integration tests only and is never packaged. Do not commit it.
