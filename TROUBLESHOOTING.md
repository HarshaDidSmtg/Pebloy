# BDeploy — Troubleshooting

## Connection Issues

**Connection test fails**
- Recheck server name, database name, authentication mode, username, and password.
- Prefer the SQL Server hostname over a raw IP address for Windows authentication (e.g., `MYDBSERVER` instead of `10.200.x.x`). Hostname resolution is faster and more reliable.
- For `host,port` format entries, diagnostics tests that explicit port. Named instances use the default SQL Browser configuration for the actual SMO connection.
- Confirm network access and SQL Server login permissions.
- Click **Diagnostics** in the Connections table — this runs a TCP + SQL login path check and shows exactly where the connection is failing.

**Windows Authentication fails even though credentials are correct**
- Ensure the machine running BDeploy is domain-joined and that the Windows account has SQL Server access.
- Try using the hostname instead of the IP.
- Check that the SQL Server Browser service is running (for named instances).

**SQL Authentication fails**
- Verify the login exists on the SQL Server: `SELECT name FROM sys.sql_logins WHERE name = 'yourlogin'`
- Ensure SQL Server Authentication mode is enabled on the server.

---

## Object Discovery Issues

**No objects appear in Discover mode**
- Verify the source profile points to the correct database (check Database Name field exactly — no brackets).
- Clear all type/schema filters and retry.
- Confirm the SQL login has at least `VIEW DEFINITION` permission on the objects.

**Specify mode resolves the wrong type**
- Verify the object exists in the selected source database and that the name is schema-qualified.
- Remove square brackets if pasted from SSMS, or paste `schema.name` and let the app normalize it.
- Confirm the login has metadata visibility (`VIEW DEFINITION`) on that object.

---

## Backup Issues

**Backup returns no files**
- Check that the output folder path is valid and writable.
- Open **Logs** and find the backup task to inspect the PowerShell output.
- Ensure the `SqlServer` module is installed: `Install-Module -Name SqlServer -Scope CurrentUser`

**Backup folder structure looks wrong**
- The structure is defined by `DBObjectsBulkScriptGenerator.ps1`. Current shared-generation output is organized as `ConnectionAlias\dd-mm-yyyy\DatabaseName\Schema\ObjectType\File.sql`.
- Do not rename or reorganize generated folders — the script expects its own naming convention.

---

## Code Diff Issues

**Diff shows CREATE and PROCEDURE (or similar DDL keywords) on separate lines**
- This is a known SMO formatting quirk — the SQL Server Management Objects library sometimes emits `CREATE\nPROCEDURE`, `ALTER\nVIEW`, or `CREATE\nOR ALTER\nPROCEDURE` with keyword pairs split across lines.
- BDeploy normalizes these at all three comparison layers (deploy path, diff path, and live DB definition path) via `normalizeDdlKeywords()`. If you still see split keywords in the diff viewer, re-run the diff — a stale browser cache may be showing an older result.
- If the symptom persists, check that you are running the latest version of `DBObjectsBulkScriptGenerator.ps1` which includes `Format-DdlKeywords` for normalization at script generation time.

**Diff shows changes that don't exist**
- Re-run the diff to regenerate fresh scripts from both databases.
- Check whether the difference is caused by formatting-only changes in generated SQL.
- Inspect the task log in `artifacts/logs/` to confirm both source and target export paths were regenerated for the current run.

**Diff is empty even though databases are different**
- Verify both source and destination profiles are selected.
- Ensure the selected objects actually exist in both databases.
- Check Logs for error events from the diff task.

---

## Deployment Issues

**All objects show "Skipped"**
- Check that the database name in the profile matches exactly what SQL Server uses (no extra brackets or spaces).
- Verify the source database has the selected objects.

**Deploy error on a specific object**
- Open **Logs**, find the task, and click **View** for the full event log and generated script path.
- Open the generated script in SSMS to run it manually and see the exact error.
- For tables: check the delta script in `artifacts/scripts/` — it may contain a conflict with existing constraints.

**Table deployment fails**
- Tables use delta ALTER scripts (not DROP + CREATE). If the delta script contains an incompatible change (e.g., changing a NOT NULL column that has data), you must resolve the data conflict manually first.

**PowerShell execution fails**
- Ensure the `SqlServer` module is installed and available: `Get-Module -ListAvailable SqlServer`
- Check execution policy: `Get-ExecutionPolicy -Scope CurrentUser`
- If policy is `Restricted`, run: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

**Deployment partially succeeds then stops**
- Default behavior is stop-on-error. Enable **Continue on Error** mode to process all objects and collect a full failure list.

---

## Logs and Artifacts

**Log files are too large**
- This is a known issue. See [IMPROVEMENTS.md](IMPROVEMENTS.md) for the planned logging optimization.
- For now, manually clear old logs from `artifacts/logs/`.

**Can't find a generated script**
- The Logs tab **Open File** action now opens the preferred `.log` artifact directly.
- Task logs (`.json` files in `artifacts/logs/`) contain the exact file path of every generated script.
- Open the task log and search for `scriptPath`.

**Dates in the object grid or logs look different than older screenshots**
- Current object-grid dates render as `dd:mm:yyyy`.
- Logs and task detail timestamps render as `dd:mm:yyyy hh:mm:ss`.
- Older screenshots or docs may still show the previous locale-based format.

---

## Electron-Specific Issues

**Electron window is blank or shows an error**
- Run `npm start` first to check for server startup errors in the terminal.
- Check that port 5089 is not blocked by a firewall or antivirus.

**Electron app does not open**
- Run `Launch-BDeploy.ps1` or `Launch-BDeploy.cmd`; that path checks dependencies and starts Electron directly.
- Verify `node_modules/.bin/electron.cmd` exists by running `npm install` if Electron was not installed yet.

**Desktop shortcut still shows the old icon**
- The launcher refreshes `BDeploy.lnk` to use `build/icon.ico`.
- If Windows still shows the old icon temporarily, close Explorer windows or let the icon cache refresh.

**File picker and folder picker look inconsistent**
- Launch the app through Electron instead of a browser tab so both flows use the native desktop dialog path when available.
