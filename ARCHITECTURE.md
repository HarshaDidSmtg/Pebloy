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
| `src/services/sqlService.js` | SQL execution plus DB metadata discovery and true object type resolution via PowerShell ADO.NET. |
| `src/services/profileService.js` | Connection profile CRUD. |
| `src/services/appStateService.js` | File-backed UI/app-state persistence in `data/app-state.json` for preferences and working inputs. |
| `src/services/settingsService.js` | File-backed script-generation folder naming and deployment-order persistence in `data/settings.json`. |
| `src/services/factoryResetService.js` | Clears runtime data, artifacts, and saved preferences for a clean shareable workspace state. |
| `src/services/loggingService.js` | Per-task audit logs, reports, and script artifacts. |
| `src/services/systemService.js` | Shared native dialog helpers for folder picking, file picking, and path opening. Used by Backup, Deploy, Settings, and object-list import flows. |
| `src/services/secretStore.js` | DPAPI password encryption/decryption. |
| `src/services/storage.js` | JSON file I/O for profiles and runtime data. |
| `src/services/utils.js` | Auth type normalization and SQL name helpers. |

## 4. Profiles and Object Selection

- Profiles are managed in the Connections tab and persisted in `data/profiles.json`.
- Encrypted secrets are stored separately in `data/secrets.json` (DPAPI-protected).
- UI preferences and working tab inputs are persisted in `data/app-state.json`.
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
5. User can export: Markdown / HTML from the UI. The backend diff service also supports JSON report generation for tooling.

### 5.2 Backup

Purpose: Generate `CREATE` object scripts from the source database. Script-generation only — does not compare, execute, or modify any database.

Flow:

1. UI posts source profile, selected objects, and output path to `/api/backup/run`.
2. `backupService` calls `scriptAutomationService.generateObjectScripts(...)`.
3. Service invokes `scripts/powershell/DBObjectsBulkScriptGenerator.ps1` with server/database/auth from the selected profile, temp object list file, and output base path.
4. Script outputs Connection Alias/date/db/schema/type/file structure and BuildPaths manifest.
5. `scriptGenerationService` refreshes exact definitions where available and keeps BuildPaths-listed programmable-object source files headerless and canonical for SSDT/DACPAC-style consumers.
6. API returns generated root path, build path file, and run metadata.

### 5.3 Deploy

Purpose: Execute scripts against the destination DB. The only mode that executes SQL.

Deployment strategy by object type:

- **Stored Procedures, Views, Functions, Triggers:** `CREATE OR ALTER` executable SQL, executed as individually tracked scripts on a reused target connection.
- **Tables:** Delta ALTER script from `scripts/powershell/CompareTablesGenerateDelta.ps1` — never drop/recreate.
- **Synonyms, Sequences, UDTs:** DROP + CREATE, executed as individually tracked scripts on a reused target connection.

Flow:

1. UI posts source/destination profiles, selected objects, mode, and output path to `/api/deploy/run`.
2. `deploymentService` regenerates fresh non-table source artifacts through `scriptGenerationService`, which keeps the per-object BuildPaths-listed source files headerless and canonical.
3. Deploy-time executable SQL is built separately: programmable modules rehydrate `SET ANSI_NULLS` / `SET QUOTED_IDENTIFIER` from exact metadata and execute as individually tracked `CREATE OR ALTER` scripts, while non-modules use the existing drop/create strategy.
4. Tables bypass generic table export and use `scripts/powershell/CompareTablesGenerateDelta.ps1`.
5. Executable scripts are saved under the run's `Deployment Scripts` folder.
6. Selected objects are deduplicated before execution, then execute individually in configured order through a reused target connection, retaining exact failure attribution; tables execute through their delta batch.
7. Per-object results are aggregated and logged.

## 6. Object Discovery

Two modes for building the object list:

**Discover mode:** Browses live objects from the selected source database with type/schema filters. A header checkbox selects or clears the visible result set and supports an indeterminate state.

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
| GET | `/api/health` | Health check |
| GET/POST | `/api/profiles` | List / create connection profiles |
| GET/PUT/DELETE | `/api/profiles/:id` | Read / update / delete a profile |
| POST | `/api/profiles/:id/test` | Test connection |
| POST | `/api/profiles/:id/diagnostics` | TCP + SQL login path diagnostics |
| GET | `/api/objects/discover` | Discover live DB objects (type/schema filters) |
| POST | `/api/objects/resolve-types` | Resolve true object types for a pasted object list |
| POST | `/api/diff/compare` | Run code diff (generates fresh scripts, returns diff) |
| POST | `/api/backup/run` | Run backup (script generation only) |
| POST | `/api/deploy/run` | Run deployment (execute or rollback) |
| GET | `/api/logs` | List task log files |
| GET | `/api/tasks/:taskId` | Read a specific task log |
| POST | `/api/logs/:taskId/open` | Open the preferred local task log file |
| DELETE | `/api/logs` | Delete all log files |
| GET | `/api/app-state` | Read persistent app state |
| POST | `/api/app-state` | Write persistent app state |
| POST | `/api/factory-reset` | Clear all saved data, logs, and artifacts |
| POST | `/api/system/pick-folder` | Open native folder picker dialog |
| POST | `/api/system/pick-file` | Open native file picker dialog |
| GET | `/api/settings` | Read script-generation / deployment-order settings |
| POST | `/api/settings` | Write script-generation / deployment-order settings |

## 10. System Dialogs

Endpoints:

- `/api/system/pick-folder`
- `/api/system/pick-file`

Runtime behavior:

- Electron launch path can use native IPC-backed dialogs from the desktop shell.
- Backend endpoints remain available as fallback dialog paths.
- Folder pickers support optional dialog descriptions and initial paths.
- File pickers are used for object-list import and similar file-selection flows.

## 11. Logging and Artifacts

All task runs generate logs under `artifacts/logs/`:

- `.log` — human-readable text timeline
- `.json` — structured task record with events and summary

The log summary index keeps both paths, and the Logs tab prefers opening the `.log` file for operators.

Script and report outputs:

- `artifacts/scripts/` — timestamped SQL script artifacts saved before execution
- `artifacts/reports/` — diff exports (md/html/json)

## 12. Monitoring and Health

The backend exposes a health check at `/api/health`.

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
  E3 --> E3a[Programmable objects: individual tracked execution]
  E3 --> E3b[Tables: CompareTablesGenerateDelta.ps1 + delta execution]
  E3 --> E3c[Others: DROP + CREATE execution]
  E3a & E3b & E3c --> E4[Aggregate results + write task logs]
```

## 14. Operational Notes

- For SQL authentication profiles, username/password must be valid and stored in the profile secret store.
- Deploy mode `GenerateScriptOnly` does not execute any SQL against the destination DB.
- Deploy mode default is `Execute Directly`.
- If source and destination are the same DB, deployment is blocked unless explicitly overridden.
- Prefer SQL Server hostname over raw IP for Windows authentication — DNS resolution is more reliable.
