# BDeploy — Product Requirements

## 1. Product Overview

BDeploy is a Windows desktop/web app for deploying SQL Server database objects from a source environment to a destination environment safely and repeatably.

Primary goals:
- Standardize database object deployments across environments (DEV → QA → UAT → PROD).
- Reduce manual scripting effort and deployment risk.
- Provide visibility through code diff, task-level logs, and script-based backup.

## 2. Problem Statement

Current deployment flow relies on manual scripts and ad hoc execution, which can cause:
- Human error during object selection and execution order.
- Difficulty tracking what changed, when, and by whom.
- Limited rollback confidence without mandatory backups.

BDeploy provides a guided, auditable, and reusable deployment workflow.

## 3. Users and Roles

Primary users:
- Database developers
- DBAs
- Release engineers

Role capabilities:
- Operator: run compare/deploy/backup using predefined connections.
- Admin: manage connection profiles and global settings.

## 4. In-Scope Object Types

The app must support scripting, diff, and deployment for:
- Tables
- Views
- Stored procedures
- Functions (scalar, inline table-valued, multi-statement table-valued)
- Synonyms
- Sequences
- User-defined data types (UDTs)
- Triggers
- Indexes and constraints (as part of table deployment)

Architecture must allow adding more object types later without major redesign.

## 5. Functional Requirements

### 5.1 Profile Reuse

- Connection profiles are a single source of truth.
- Any connection selector in any tab must read from the shared profile store.
- If a profile is updated, all tabs must reflect the update immediately.

### 5.2 Validation Rules

- Validate server/database reachability before task start.
- Validate authentication details before running compare/deploy/backup.
- Validate source and destination are not identical unless user confirms.

### 5.3 Dependency and Ordering

Enforce safe deployment ordering:
1. User-defined types / sequences
2. Tables and constraints
3. Views
4. Functions
5. Stored procedures
6. Synonyms
7. Triggers

Provide explicit override option for advanced users.

### 5.4 Error Handling

- Clear error messages with object context.
- Partial deployment report with resumable recommendations.
- Retry failed objects without rerunning successful ones.

### 5.5 Script Traceability

All scripts executed (deployment, diff, backup) must be saved to disk with a unique timestamped filename before execution. The path to each executed script must be referenced in the corresponding task log, and task records must retain both human-readable and structured log artifact paths.

## 6. Core Mode Behaviors

### 6.1 Backup Mode

- Generates SQL object scripts from the source database only.
- Scripts are saved to structured folders matching `DBObjectsBulkScriptGenerator.ps1` output, including Connection Alias → run date → database → schema → object type.
- Does NOT compare anything, does NOT execute SQL, does NOT modify any database.
- Internally reuses the same script generation logic as CodeDiff and Deploy.

### 6.2 CodeDiff Mode

- Every run generates fresh scripts directly from DB1 (source) and DB2 (destination).
- Stale or previously generated files are never used — always pull latest definitions.
- Comparison only — no SQL execution, no database modification.

### 6.3 Deploy Mode

- Only mode that executes SQL against the destination database.
- Selected objects must be deduplicated before execution so the same object is not deployed twice in one run.
- Deployment strategy differs by object type:
  - **Stored Procedures:** individually tracked executable scripts.
  - **Tables:** delta ALTER script via `CompareTablesGenerateDelta.ps1` — never drop/recreate.
  - **All other objects (Views, Functions, Synonyms, Sequences, UDTs, Triggers):** DROP + CREATE.

## 7. Non-Functional Requirements

- **Performance:** Compare 500+ objects within acceptable time window.
- **Reliability:** No silent failures; all failures logged and shown.
- **Security:** Encrypt secrets at rest. Do not print secrets in console/logs.
- **Usability:** Main actions discoverable in under 3 clicks.
- **Compatibility:** Windows-first. SQL Server 2016 or newer.
- **Async:** Avoid freezing UI during generation, comparison, or deployment.

## 8. Data Model

### ConnectionProfile

| Field | Type | Notes |
| ----- | ---- | ----- |
| Id | GUID | |
| ProfileLabel | string | unique, user-friendly |
| ServerName | string | |
| DatabaseName | string | |
| AuthenticationType | enum | Windows / Sql |
| Username | string | nullable, SQL auth only |
| SecretReference | string | nullable, secure vault key |
| EnvironmentTag | string | nullable (DEV/QA/UAT/PROD) |
| CreatedAt | datetime | |
| UpdatedAt | datetime | |

### TaskRun

| Field | Type |
| ----- | ---- |
| TaskId | GUID |
| TaskType | enum (Diff / Backup / Deploy) |
| StartedAt | datetime |
| CompletedAt | datetime |
| StartedBy | string |
| SourceProfileId | GUID |
| DestinationProfileId | GUID |
| Status | string |
| SummaryJsonPath | string |
| LogFilePath | string |

### DeploymentItemResult

| Field | Type |
| ----- | ---- |
| TaskId | GUID |
| ObjectType | string |
| SchemaName | string |
| ObjectName | string |
| Action | enum (Create / Alter / Skip / Error) |
| Status | string |
| ErrorMessage | string (nullable) |

## 9. Suggested Technical Direction

Use existing PowerShell scripts as implementation baseline:
- `DBObjectsBulkScriptGenerator.ps1` — object extraction and script generation by type.
- `CompareTablesGenerateDelta.ps1` — table schema comparison and incremental delta script generation.

Wrap script capabilities behind an internal service layer so UI and automation APIs share one orchestration engine.

## 10. Acceptance Criteria (MVP)

- User can create at least two connection profiles with Windows and SQL auth options.
- Profiles are selectable and reusable in Diff, Backup, and Deployment tabs.
- User can compare source vs destination and view/export diff.
- User can run a backup task (script generation) and view completion in logs.
- User can deploy selected object types and see per-object status.
- System generates one dedicated log file per task run.
- User can switch between Light, Dark, Spider-Man, and Batman themes.

## 11. Out of Scope (MVP)

- Non-SQL Server database engines.
- Full schema migration history engine replacement.
- Highly customized data migration transformations.

## 12. Delivery Phases

- **Phase 1:** Connections + Diff + Deployment for core objects + task logging.
- **Phase 2:** Backup enforcement + rollback assistant + approvals.
- **Phase 3:** Scheduling, notifications, CLI, advanced dependency visualization.
