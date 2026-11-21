# Table Diff

Compare two tables the way `git diff` compares files: a summary first, then every added,
removed and changed row, down to the cell. Built for Azure Synapse **dedicated** and
**serverless** SQL pools, and it also works with SQL Server.

> **Status: tested automatically only against a local SQL Server 2022.** Behaviour on real
> Synapse pools must be confirmed with `docs/smoke-test-checklist.md` (in the repository)
> before you rely on a result.

## Features

- Compare two tables or views, on the same pool or across a dedicated and a serverless pool.
- Schema diff: added or removed columns, and type, nullability and position changes.
- Data diff matched by one or more key columns: added, removed and changed rows, with the
  changed cells named.
- Never copies whole tables into VS Code. Comparison runs as a fixed number of checksum
  passes, and only the differing rows are fetched.
- Key problems (duplicate and NULL keys) are reported on their own tab. They are never
  silently counted as matches.
- Export differences to CSV, or open them in VS Code's diff editor.
- Read-only. The extension never writes to either side.

## Install from the .vsix

1. Build the package (see Building) or obtain `synapse-table-diff-0.1.0.vsix`.
2. In VS Code, open the Extensions view, choose **...** > **Install from VSIX…**, and select the file.
   Or run `code --install-extension synapse-table-diff-0.1.0.vsix`.
3. Reload the window if VS Code asks.

## Adding connections

Run **Table Diff: Add Connection** from the Command Palette (`Ctrl+Shift+P`).

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
2. Choose the **Left** and **Right** connection, then the schema and table or view on each side.
3. Choose one or more **key columns**. Declared primary or unique keys are pre-filled when they exist.
4. Choose **Columns to compare**. By default every shared column is compared. Exclude load
   timestamps or other columns that should not count as differences.
5. Optionally enter a **filter**: a T-SQL `WHERE` condition applied to both sides, for example a date range.
6. Optionally tick **ignore case** or **ignore trailing spaces**. By default comparisons are exact.
7. Start the comparison. Progress shows each stage: schema, checksums, narrowing, key comparison and
   changed rows. You can cancel at any time. Cancelling stops the queries on both sides and shows
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

A warning banner appears if the result is incomplete, for example because of duplicate keys, a
cancellation or an error.

The tabs are:

- **Schema:** the columns side by side with their status. Columns that cannot be compared (for
  example different type families such as `varchar` against `int`) are listed under *Excluded
  columns* with the reason.
- **Data:** the differing rows, filterable by All, Changed, Added or Removed. Changed rows show both
  values with the changed cells highlighted. Added and removed rows are green and red.
- **Key problems:** duplicate and NULL key samples. Those keys are left out of the data diff, so
  the result is incomplete for them.

Use **Open in diff editor** to see the differences as aligned text in VS Code's diff editor, or
**Export CSV** to save them. The export is streamed to disk.

## Settings

All settings are under `tableDiff.*` and are read at the start of each run.

| Setting | Default | Purpose |
|---|---|---|
| `tableDiff.pairLimit` | `2000000` | Maximum number of row pairs compared in the narrowing pass. If more mismatched rows than this remain, the extension re-buckets once more, which on serverless asks for confirmation first. |
| `tableDiff.detailLimit` | `100000` | Maximum number of differing rows fetched for the browsable Data tab. Counts are always exact. The UI says so when the cap is hit. |
| `tableDiff.inListCap` | `5000` | Maximum number of keys in one `IN` list. |
| `tableDiff.queryTimeoutSeconds` | `3600` | Query timeout in seconds. |

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
npm run package        # writes synapse-table-diff-0.1.0.vsix
```

`npm run package` runs `vsce package --allow-missing-repository --skip-license`. The package has no
repository URL and no licence file yet, so those two checks are skipped. Remove the flags once the
package has a repository and a `LICENSE`. The `.vsix` excludes `test/`, `src/`, `docs/`, `.env*`,
`coverage/` and `.superpowers/`, as set in `.vscodeignore`. The runtime `mssql` driver is bundled into
`dist/extension.js`, so `node_modules` is not shipped.

The `.env` file is for the local integration tests only and is never packaged. Do not commit it.
