# Pebloy — Roadmap

Tracked improvements and planned features. Items are grouped by scope; there are no committed release targets.

---

## Near-Term Improvements

### Settings

- **Configurable query and script timeouts** — `SQL_QUERY_TIMEOUT_MS` (120 s) and `POWERSHELL_TIMEOUT_MS` (180 s) are currently hardcoded constants in `src/services/sqlService.js`. Expose them as fields in the Settings tab and persist to `data/settings.json` so long-running scripts on slow servers don't time out silently.

- **Deployment order drag-to-reorder** — the object-type execution order in Settings is persisted but can only be changed by editing. Add drag-and-drop reordering for the deployment order list.

### Connections

- **Connection profile grouping** — when many profiles exist (DEV/QA/UAT/PROD sets for multiple projects) the flat list becomes hard to scan. Add an optional Group field to profiles and group rows by it in the Connections table.

- **SQL Server module install helper** — the Connections tab could check whether the `SqlServer` PS module is present and offer a one-click Install-Module button when it is missing, instead of leaving users to discover this only after a failed operation.

### Object Discovery

- **Schema filter memory** — the type/schema filters in Discover mode reset on every visit. Persist the last-used filter values in app state.

- **Discover pagination page-size control** — currently fixed at 50 per page. Let users pick 25/50/100.

### Build

- **prebuild-win.js download fallback** — `scripts/prebuild-win.js` can only extract an already-cached winCodeSign archive; it skips silently if none is present, leaving the symlink error to surface at build time. Extend it to download the archive itself (same URL electron-builder uses) so `npm run build` always succeeds on a clean machine without Developer Mode.

### Logging

- **Log retention cap** — `loggingService` trims individual `.log` files at 2 MB but does not cap the total number of task logs. Add an optional auto-delete policy (e.g. keep last N tasks) configurable in Settings.

---

## Medium-Term Features

### Folder-as-Source Workflows

All Backup, Diff, and Deploy modes currently require live database profiles. A folder-as-source mode would let users point the diff or deploy at a directory of previously generated SQL scripts instead of a live DB — useful for offline review, auditing historical backups, or integrating with a source-controlled scripts folder.

### SQL Parser / Build Validation (DacFx)

Current canonical-source validation is pattern-based (prefix checks, keyword scans). Compiler-grade validation using `sqlproj` / DacFx would catch syntax errors, unresolved references, and compatibility issues before execution. This requires a .NET toolchain dependency; the backend remains PowerShell-first.

### Check for Updates — Release Publishing

The updater IPC flow is implemented and covered by service tests for release checks, installer asset selection, download progress, `shell.openPath`, and app quit scheduling. A real user-facing update still requires publishing a semantic-versioned GitHub release with a non-portable Setup `.exe` asset, for example `Pebloy-Setup.exe`.

### Diff Export Improvements

- Export currently supports Markdown, HTML, and JSON. Add a side-by-side **HTML with syntax highlighting** option that can be opened standalone in a browser.
- Add a **"copy diff to clipboard"** shortcut for quick pasting into PR descriptions or Jira tickets.

### Deploy — Dry-Run Report

Deploy plan preview exists (`/api/deploy/plan`), but the plan only shows execution order and object list. Add a dry-run report that generates all scripts (including table delta) without executing, and writes them to `artifacts/scripts/` so they can be reviewed in SSMS before committing.

---

## Longer-Term / Exploratory

### Multi-Database Batch Operations

Run Backup or Deploy across multiple destination profiles in one task (e.g. deploy to QA and UAT simultaneously). Requires per-destination result aggregation and per-destination log artifacts.

### Scheduled Deployments

Allow a deploy task to be saved as a scheduled job (Windows Task Scheduler via `schtasks`), with a saved object list and destination profile. Useful for repeating nightly sync jobs.

### Dark Mode Auto-Detection

Respect `prefers-color-scheme` when no theme has been explicitly saved, defaulting to Light or Dark without requiring a manual Settings change on first launch.

### Integration Test Database

The integration test suite in `src/services/integration.test.js` skips entirely when no DEV and INT profiles are found in `data/profiles.json`. Provide a documented test-database setup script (create lightweight SQL Server Express instance with sample objects) so the integration suite can run in CI.

---

## Known Limitations

| Area | Limitation |
| ---- | ---------- |
| Platform | Windows only — DPAPI and PowerShell SMO are Windows-specific. No Linux/macOS support planned. |
| SQL Server | Tested against SQL Server 2016–2022. Azure SQL and SQL Managed Instance may work but are not validated. |
| Tables | Delta script generation requires both source and destination to be accessible simultaneously. Offline table diff is not supported. |
| Symlink extraction | `npm run build` requires winCodeSign pre-extraction on Windows without Developer Mode. `scripts/prebuild-win.js` handles this if the archive is already cached; a fresh machine still needs one failed build attempt to populate the cache. |
| Exact definitions | Some object types (synonyms, sequences, UDTs) do not have exact-definition metadata and fall back to SMO-generated scripts, which may differ slightly in whitespace or casing from the original DDL. |
