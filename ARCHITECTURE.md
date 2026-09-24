# Pebloy — Architecture

## 1. Overview

Pebloy is a local web app for SQL object lifecycle workflows:

- **Code Diff:** Compare object scripts between source and destination databases using fresh scripts pulled at runtime.
- **Backup:** Generate object scripts from a source database using `scripts/powershell/DBObjectsBulkScriptGenerator.ps1`.
- **Deploy:** Generate scripts and execute them against the destination DB with object-type-aware strategies.

## 2. Stack

| Layer | Technology |
| ----- | ---------- |
| Frontend | Vanilla HTML/CSS/JS in `public/` |
| Backend | Node.js + Express in `src/server.js` |
| Desktop shell | Electron (optional) |
| DB scripting | PowerShell + SQL Server SMO |
| Secret storage | Windows DPAPI |

## 3. Service Layer

| Service | Responsibility |
| ------- | -------------- |
| `src/services/scriptAutomationService.js` | Shared PowerShell orchestration — wraps `scripts/powershell/DBObjectsBulkScriptGenerator.ps1`, builds Connection Alias/date/database output roots, parses `BuildPaths`, and normalizes deploy-time executable SQL. |
| `src/services/scriptGenerationService.js` | Shared script-generation entry points used by Backup, Code Diff, and Deploy for normalized selections, exact-definition synchronization, canonical source-artifact validation, and task-specific output roots. |
| `src/services/diffService.js` | Object diff, line-by-line rendering data, and stage-based compare progress updates. |
| `src/services/backupService.js` | Backup orchestration and backup-stage progress updates. |
| `src/services/deploymentService.js` | Deploy orchestration, deduplicated execution planning, table delta routing, and per-object result aggregation. |
| `src/services/folderSourceService.js` | Bounded, fresh folder inspection through ScriptDom; catalog-backed selection and source-preserving materialization. |
| `src/services/deploymentBatchService.js` | Resolved target identity checks, content/plan-bound batch approval, sequential target execution and isolated artifacts. |
| `src/services/scheduleService.js` | Atomic reviewed schedule storage, recurrence, no overlap, and interrupted/failed-run recovery requiring reapproval. |
| `src/services/windowsScheduleService.js` | Optional signed-in-user Windows Task Scheduler wake-up; no credentials, elevation, or direct SQL in task arguments. |
| `src/services/sqlService.js` | SQL execution plus DB metadata discovery and true object type resolution via PowerShell ADO.NET. |
| `src/services/profileService.js` | Connection profile CRUD. |
| `src/services/formatterService.js` | Shared generated-SQL formatter entry points plus the interactive formatter route backed by a local worker thread. |
| `src/services/formatterOptions.js` | Formatter option normalization and capability metadata; enabled generated-SQL formatting reuses the saved options. |
| `src/services/sqlBatchService.js` | Shared SQL-aware GO splitting and replacements that preserve strings, quoted identifiers, and nested comments. |
| `src/services/diffWorker.js` | Bounded worker-thread comparison of freshly generated scripts. |
| `src/services/tsqlFormatterProvider.js` | Offline T-SQL formatting provider that preserves GO batches, comments, BOM, EOL style, and trailing newline. |
| `src/services/appStateService.js` | File-backed UI/app-state persistence in `data/app-state.json` for preferences and working inputs. |
| `src/services/settingsService.js` | File-backed folder naming, formatting, time, and execution preferences in `data/settings.json`. Legacy deployment-order preferences are ignored. |
| `src/services/factoryResetService.js` | Clears runtime data, artifacts, and saved preferences for a clean shareable workspace state. |
| `src/services/loggingService.js` | Per-task audit logs, reports, and script artifacts. |
| `src/services/systemService.js` | Shared native dialog helpers for folder picking, file picking, and path opening. Used by Backup, Deploy, Settings, and object-list import flows. |
| `src/services/secretStore.js` | DPAPI password encryption/decryption. |
| `src/services/storage.js` | Atomic JSON writes and last-known-good recovery for settings/app state. |
| `src/services/runtimeLockService.js` | Exclusive runtime-directory ownership using OS-managed named pipes on Windows. |
| `src/services/reconciliationService.js` | Read-only comparison of the target's current module definitions against the source after an uncertain run. |
| `src/services/migrationPrepService.js` | Builds a reviewable migration scaffold from target permissions, ownership, signatures, sequence state, and dependents. Never executed. |
| `src/services/utils.js` | Auth type normalization and SQL name helpers. |

## 4. Profiles and Object Selection

- Profiles are managed in the Connections tab and persisted in `data/profiles.json`.
- Encrypted secrets are stored separately in `data/secrets.json` (DPAPI-protected).
- UI preferences and working tab inputs are persisted in `data/app-state.json`.
- Interactive formatter options and editor toggles are also persisted in `data/app-state.json`, but they stay separate from `settings.formatting.formatGeneratedSql`.
- Script-generation customization is persisted in `data/settings.json`.
- A shared object list drives Diff, Backup, and Deploy tabs.
- Object list items are normalized to `{ objectType, schemaName, objectName }`.

## 5. Tab Behavior Contracts

### 5.1 Code Diff

Purpose: Compare selected objects between source and destination DB and show side-by-side line-level diff.

Flow:

1. UI posts selected objects and source/destination profile IDs to `/api/diff/compare`.
2. Backend generates **fresh scripts** directly from DB1 (source) and DB2 (destination) at runtime via `scriptAutomationService`. Stale or previously generated files are never used.
3. Diff service computes:
   - Summary: `added`, `missing`, `changed`, `unchanged`
   - Object details
   - Line-level side-by-side rows (`lineDiff`)
4. UI displays object list and line-by-line compare grid.
5. User can export Markdown, HTML, syntax-highlighted standalone HTML, or JSON and copy a Markdown diff. These actions reuse the displayed report without querying the database again.

Report rows keep source on the left and target on the right, and paired modified rows carry `leftChanges`/`rightChanges` word ranges (skipped for lines over 4,000 characters combined). The viewer and Markdown/HTML exports present them as target (current) → source (incoming), matching GitHub compare: + lines are what deploying the source would introduce. Syntax coloring runs in the browser on escaped text; nothing from the report is inserted as HTML.

### Folder Inputs and Batch Scheduling

SQL Folder is an explicit Object Selection source mode, not an implicit fallback to old generated files. Each request scans the folder again, skips combined-procedure/deployment artifacts, and inspects one declaration per file through ScriptDom. The scanner rejects symlinks, duplicate/case-ambiguous keys, oversized files, extra executable statements, and unsupported declarations. Optional ANSI_NULLS/QUOTED_IDENTIFIER headers must precede the declaration; absent settings default to ON. The folder fingerprint participates in deployment confirmation. Dynamic SQL dependencies still require manual review. Tables can be copied/compared, but folder table deployment is refused because CompareTablesGenerateDelta requires a live source.

Multi-target plans resolve all database identities before execution and reject source/target aliases or duplicate targets. Targets execute sequentially under one runtime workflow lock with individual logs and `Target_<profile-id>` output bases containing the unchanged alias/date/database layout. Earlier targets may remain committed after a later failure. Continue-within-target and continue-across-target policies are separately reviewed.

Schedules persist only whitelisted request fields in `data/schedules.json`; credentials are resolved from current profiles at execution. A schedule save requires a fresh matching batch fingerprint. A 15-second runtime timer revalidates that approval through the batch service when due. This protects plan/identity consistency, not a snapshot of live SQL definitions. One overdue occurrence runs when the app next starts, with no backlog replay; future daily/weekly times follow the machine-local clock. Running records are written before execution and become disabled Interrupted records after a crash. Failure or ReviewRequired disables further runs until the timing and plan are confirmed again.

Optional Windows wake-up uses an interactive limited principal and the existing desktop executable. The user must be signed in, and existing Electron/runtime locks prevent a second backend. App-open scheduling remains available without Windows registration. Pausing/removing a schedule removes its wake-up task; factory reset is blocked until schedules have been deleted. Schedule definitions are intentionally excluded from general data import/export so importing preferences cannot authorize unattended writes.

### 5.2 Backup

Purpose: Generate `CREATE` object scripts from the source database. Script-generation only — does not compare, execute, or modify any database.

Flow:

1. UI posts source profile, selected objects, and output path to `/api/backup/run`.
2. `backupService` calls the shared `scriptGenerationService.generateScriptsForProfile(...)` entry point.
3. Service invokes `scripts/powershell/DBObjectsBulkScriptGenerator.ps1` with server/database/auth from the selected profile, temp object list file, and output base path.
4. Script outputs Connection Alias/date/db/schema/type/file structure and BuildPaths manifest.
5. `scriptGenerationService` refreshes exact definitions where available and keeps BuildPaths-listed programmable-object source files headerless and canonical for SSDT/DACPAC-style consumers.
6. API returns generated root path, build path file, and run metadata.

### 5.3 Deploy

Purpose: Execute scripts against the destination DB. The only mode that executes SQL.

Deployment strategy by object type:

- **Stored Procedures:** The existing combined procedure artifact, using `CREATE OR ALTER`, executes as one transaction. Its result applies to all procedures in that group.
- **Tables:** Delta ALTER script from `scripts/powershell/CompareTablesGenerateDelta.ps1`, executed as one transaction; never generic drop/recreate. Missing/manual-review output is rejected before that delta executes.
- **Table delta casing:** Returned catalog/SMO names retain their spelling, including the database in `USE` and schema-qualified user-defined column types. SQL name lookup uses native catalog collation; in-memory keys follow its case-sensitivity flag rather than lowercasing identifiers. Source tables that would collide on a case-insensitive target are rejected. Default/computed/index definition comparisons are ordinal and case-sensitive, so case-only literal changes are surfaced for review. This does not rename existing objects merely to change their casing or provide a complete SQL linguistic-collation implementation in memory.
- **Views, Functions, Triggers, Synonyms, Sequences, UDTs:** DROP + CREATE, with per-object transactions. Explicit target permissions, ownership, signatures, and referenced types cause safe refusal rather than silent metadata loss or dropping unselected dependencies.

Flow:

1. UI snapshots source/destination profiles, selected objects, mode, and output path, then requests `/api/deploy/plan`. A required modal displays the ordered actions and connection details. Cancel/Escape sends no execution request. Confirmation posts that snapshot and `options.confirmedPlanFingerprint` to `/api/deploy/run`.
2. `deploymentService` regenerates fresh non-table source artifacts through `scriptGenerationService`, which keeps the per-object BuildPaths-listed source files headerless and canonical.
3. Deploy-time SQL rehydrates `SET ANSI_NULLS` / `SET QUOTED_IDENTIFIER` from exact module metadata. Procedures use the combined artifact; other programmable objects use guarded drop/create.
4. Tables bypass generic table export and use `scripts/powershell/CompareTablesGenerateDelta.ps1`.
5. Executable scripts are saved under the run's `Deployment Scripts` folder.
6. Selection is deduplicated and execution groups are ordered from current source SQL metadata, including expression, foreign-key, parameter/column type, constraint, trigger-parent, and local synonym dependencies among selected objects. Metadata lookup requires database VIEW DEFINITION for multi-object plans; failure stops planning. Type/date/name priorities only break ties between unrelated objects. Configurable type order is removed. Mandatory table/procedure groups remain intact, and combined procedure content follows the planned order. Incompatible group cycles, identical resolved source/target databases, and missing fresh source scripts are rejected for ordinary deployment. `ExecuteDirectly`, `Rollback`, `DryRun`, and the separately confirmed `FormatAndExecuteSource` action use the Legacy engine.
7. Per-object results are aggregated and logged.

Execution rereads dependencies and checks the fingerprint before generating scripts.
Changed order, dependency edges, mode, or configured connection identity requires a
new confirmation. This is a plan-consistency check, not a SQL-content snapshot or
an authorization token. Dynamic SQL and external dependencies may require manual
review; target comparison can still skip unchanged objects or refuse unsafe work.

Transactions are per execution group/object, not across the entire deployment.
Earlier groups can remain committed after a later failure. Rollback validation
executes SQL in a transaction and requests rollback; it is not a sandbox for
external effects, explicit transaction control, or non-transactional operations.
Timeouts and missing acknowledgements report an uncertain database outcome; check
the target and logs before retrying. DacFx is available for comparison/validation,
not deployment. See [security notes](SECURITY.md) for the guard limitations.

**Format & Execute in Source:** the Backup formatting menu opens a source-execution
plan and confirmation without navigating to Deployment. It is absent from the
Deployment mode dropdown. The guarded `/api/deploy/run` endpoint still owns execution;
the payload targets the Backup source profile, without changing the Deployment tab's
target selection. The user confirms the source server/database before each request.
Generation forcibly formats fresh scripts
without changing global formatting settings. Procedures use the combined artifact;
views/functions/triggers use guarded DROP/CREATE. Tables and other non-module
objects are skipped. Ordinary Backup remains generation-only. Signed modules and
protected metadata require a reviewed migration, rather than silent metadata loss.

Known metadata/dependency/table-delta guard refusals are `ReviewRequired`, shown
separately from execution failures and excluded from Retry Failed. The app never
automatically re-signs modules, drops unselected dependencies, or reconstructs
unknown ownership/permission policies.

UDTs use a separate structural metadata comparison with explicit database collation
on signature text, avoiding catalog/database collation conflicts. Both connections
must grant VIEW DEFINITION. A comparison error or missing source type metadata stops
deployment before executing SQL; the coarse base-type description is not a fallback
for equality. Equal signatures produce `Skipped` / `NoChange`, even when unrelated
definition comparison fails. A changed type with existing dependencies still
requires a reviewed migration; dynamic ordering does not authorize dropping them.

### 5.4 Formatter

Purpose: Format local SQL text without database access. When generated-SQL
formatting is enabled separately in settings, generation uses the same formatter
and saved options in a worker thread. Editing local formatter text does not deploy it.

Flow:

1. UI loads Monaco locally from the packaged `monaco-editor` dependency.
2. UI fetches `/api/format/capabilities` to render the interactive formatter options panel.
3. UI posts SQL text plus interactive-only options to `/api/format`.
4. `formatterService` normalizes the interactive request and routes execution through `formatterWorker.js`.
5. `tsqlFormatterProvider` formats each GO-delimited batch independently, preserving comments, BOM, EOL style, trailing newline, and string literal content.
6. If a batch cannot be parsed safely, the original batch text is returned unchanged.
7. UI can show the result either in a single Monaco editor or a Monaco diff view with the pre-format snapshot.

### 5.5 Text Controls

| Surface | Implementation |
| ------- | -------------- |
| Manual object entry | Monaco plaintext model via `manualEntryEditor.js`; a synchronized native textarea remains as the loading/failure fallback. |
| SQL Formatter and its comparison panes | Monaco SQL models via `formatterWorkbench.js`; the original comparison pane is read-only. |
| Connections, passwords, paths, filters, numeric settings, shortcuts, and formatter options | Native HTML inputs/selects with shared application styling, not Monaco. |
| Code Diff results, logs, and diagnostics | Read-only HTML tables/preformatted text, not editable textboxes. |

The two editing surfaces use the same bundled Monaco engine, theme palette, and
root font-size preference, with separate models and purpose-specific options.
Both retain a monospace font; the UI font-family setting applies to native fields.
Native selects own their Enter key. Enter-to-search applies to the discovery name
input, and Enter-to-save applies to eligible Settings text/number inputs.

## 6. Object Discovery

Two modes for building the object list:

**Discover mode:** Browses live objects with type/schema filters. Selection survives
50-row pagination and sorting. Select All Visible / Unselect All Visible affect the
current page; adding discovered objects includes checked objects across pages.
The selected grid is paginated too, while export includes the entire filtered/sorted list.

Filter metadata responses are applied only for the latest request, connection, and
discovery mode. Same-connection refreshes preserve live filter values and reuse
unchanged option nodes. Type/schema/name changes are saved directly and restored
after metadata loads on startup. A new connection shows loading controls instead
of stale filters; failed loads report an error without overwriting newer choices.

**Specify mode:** User pastes `schema.name` or an unqualified object name and clicks "Detect & Add Objects". `sqlService` queries DB metadata to detect the true object type at runtime — never hardcoded. Unqualified names are accepted only when they resolve to a single object.

Both modes produce normalized `{ objectType, schemaName, objectName }` entries.

## 7. PowerShell Script Integration

| Script | Role |
| ------ | ---- |
| `scripts/powershell/DBObjectsBulkScriptGenerator.ps1` | Extracts SQL scripts for selected objects from source DB via SQL Server SMO. Used by Backup and Deploy. |
| `scripts/powershell/CompareTablesGenerateDelta.ps1` | Compares table schemas between source and destination and generates conditional `ALTER TABLE` / `CREATE TABLE` delta statements. Used by Deploy for table objects. |

`scriptAutomationService.js` handles:

- Writing a temporary object-list file passed to both scripts.
- Passing connection, auth, and path parameters dynamically.
- Building Connection Alias/date/database output roots.
- Parsing the generated `BuildPaths.txt` manifest to locate output scripts.
- Error capture and structured logging per task.

## 8. API Endpoint Reference

| Method | Path | Handler |
| ------ | ---- | ------- |
| GET | `/api/status` | Local status and running task count |
| GET | `/api/session` | Per-process mutation token; no-store response |
| GET | `/api/events` | SSE task events and reconnect snapshot |
| GET/POST | `/api/profiles` | List / create connection profiles |
| GET/PUT/DELETE | `/api/profiles/:id` | Read / update / delete a profile |
| POST | `/api/profiles/:id/test` | Test connection |
| POST | `/api/profiles/:id/diagnostics` | TCP + SQL login path diagnostics |
| GET | `/api/objects` | Discover live DB objects (type/schema filters) |
| POST | `/api/objects/resolve-types` | Resolve true object types for a pasted object list |
| POST | `/api/diff/compare` | Run code diff (generates fresh scripts, returns diff) |
| POST | `/api/backup/run` | Run backup (script generation only) |
| POST | `/api/deploy/run` | Run deployment (execute, rollback, source formatting, or dry run) |
| POST | `/api/deploy/migration-prep` | Write a reviewable migration scaffold for guarded objects |
| POST | `/api/tasks/:taskId/reconcile` | Read-only check of what the target currently holds |
| GET | `/api/logs` | List task log files |
| GET | `/api/tasks/:taskId` | Read a specific task log |
| POST | `/api/logs/:taskId/open` | Open the preferred local task log file |
| DELETE | `/api/logs` | Delete all log files |
| GET | `/api/format/capabilities` | Read interactive formatter capability metadata |
| POST | `/api/format` | Format local SQL text with interactive-only options |
| GET | `/api/app-state` | Read persistent app state |
| PUT | `/api/app-state` | Write persistent app state |
| POST | `/api/factory-reset` | Clear all saved data, logs, and artifacts |
| POST | `/api/system/pick-folder` | Open native folder picker dialog |
| POST | `/api/system/pick-file` | Open native file picker dialog |
| POST | `/api/deploy/plan` | Derive current selected-object order and return a plan fingerprint; requires source and destination profile IDs |
| GET | `/api/settings` | Read folder, formatting, time, and execution settings |
| PUT | `/api/settings` | Write settings; omit obsolete deployment-order preferences |

## 10. System Dialogs

Endpoints:

- `/api/system/pick-folder`
- `/api/system/pick-file`

Runtime behavior:

- Electron launch path can use native IPC-backed dialogs from the desktop shell.
- Backend endpoints remain available as fallback dialog paths.
- Folder pickers support optional dialog descriptions and initial paths.
- File pickers are used for object-list import and similar file-selection flows.
- The formatter save-as path also uses Electron IPC so `.sql` and `.txt` files stay local.

## 11. Logging and Artifacts

All task runs generate logs under `artifacts/logs/`:

- `.log` — human-readable text timeline
- `.json` — structured task record with events and summary

The log summary index keeps both paths, and the Logs tab prefers opening the `.log` file for operators.

Text events append immediately; JSON checkpoints coalesce at 500 ms and finalize
atomically. Normal shutdown drains the task registry as well as HTTP connections,
including work whose client disconnected, then flushes logs. Each backend owns
exclusive locks on configured runtime directories and records a unique runtime ID.
Running logs from an abandoned runtime become Interrupted with an unknown database
outcome, even if the PID was reused. The OS releases Windows ownership locks on exit.
This is crash detection, not proof of SQL rollback or a force-cancellation protocol.

Settings/app-state saves keep a previous valid `.last-good` snapshot. Malformed JSON
is preserved as a uniquely named `.corrupt` file before recovery; invalid primary
and recovery copies fail without resetting data. Credential stores remain fail-closed
and are not automatically rolled back. Explicit factory reset removes preference
recovery copies. Do not run older Pebloy versions or external writers against the
same runtime directories; they do not participate in ownership enforcement.

Script and report outputs:

- `artifacts/scripts/` — timestamped SQL script artifacts saved before execution
- `artifacts/reports/` — diff exports (md/html/json)

## 12. Monitoring and Health

The backend exposes local status at `/api/status`. Mutations require a per-process
session token and strict same-origin/loopback checks. Database workflows cannot
overlap within one backend process. Selection and metadata requests are limited to
5000 objects, imports to 100 profiles, and SSE to 16 clients. Snapshot events restore
active task and per-object progress after reconnect.

Formatting is limited to two workers and 20 MB per input. Line diff workers have a
32 MB input bound, 256 MB memory limit, and 30-second timeout. DacFx commands have
timeouts and output limits. These limits reject oversized work; they do not make
arbitrary SQL safe to execute.

For process monitoring with PM2:

```text
npm install -g pm2
pm2 start src/server.js --name pebloy
pm2 status
```

PM2 will restart the server on crash and provides log streaming and metrics.

## 13. Process Flow

```mermaid
flowchart TD
  A[Select Profiles + Objects] --> B{Choose Mode}
  B --> C[Code Diff]
  B --> D[Backup]
  B --> E[Deploy]

  C --> C1[/api/diff/compare]
  C1 --> C2[Generate fresh scripts from DB1 + DB2]
  C2 --> C3[Build line-by-line side-by-side diff]
  C3 --> C4[Render in UI + export html/md]

  D --> D1[/api/backup/run]
  D1 --> D2[Create temp object list]
  D2 --> D3[Run DBObjectsBulkScriptGenerator.ps1]
  D3 --> D4[Return generated root + BuildPaths]

  E --> E1[/api/deploy/run]
  E1 --> E2[Run DBObjectsBulkScriptGenerator.ps1]
  E2 --> E3[Route by object type]
  E3 --> E3a[Procedures: combined execution]
  E3 --> E3b[Tables: CompareTablesGenerateDelta.ps1 + delta execution]
  E3 --> E3c[Others: DROP + CREATE execution]
  E3a & E3b & E3c --> E4[Aggregate results + write task logs]
```

## 14. Operational Notes

- For SQL authentication profiles, username/password must be valid and stored in the profile secret store.
- Use Backup for generation only; removed deployment modes are rejected.
- Deployment requests must specify `ExecuteDirectly`, `Rollback`, `FormatAndExecuteSource`, or `DryRun` explicitly.
- `DryRun` writes every deployment script, including the table delta, and executes nothing.
- Query timeout, PowerShell timeout, and the active task-log cap are configurable in Settings and validated on save.
- Matching source/target identities are blocked for ordinary deployment. Format & Execute requires matching identities and fresh source confirmation; it is not a general override.
- Prefer SQL Server hostname over raw IP for Windows authentication — DNS resolution is more reliable.
