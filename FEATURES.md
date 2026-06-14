# BDeploy — Features

## Feature Overview

| Feature | Description |
| ------- | ----------- |
| **Connection Profiles** | Store named server/database connections. SQL passwords are encrypted with Windows DPAPI — never stored in plaintext. |
| **Live Code Diff** | Side-by-side diff of object definitions fetched directly from source and destination databases at runtime. Fresh scripts always — no stale comparisons. |
| **Backup** | Scripts selected objects to SQL files organized under Connection Alias → run date → database → schema → object type. Script-generation only — no database modification. |
| **Deployment** | Executes ordered deployment scripts: CREATE OR ALTER for programmable modules, delta ALTER for tables, and DROP+CREATE where required. Duplicate object selections are deduplicated before execution. |
| **Object Discovery** | Browse live database objects by type and schema. The grid header checkbox selects or clears the visible result set and supports an indeterminate state. |
| **Object Specify** | Paste a schema-qualified name, or a bare object name when it is unambiguous — the app queries the DB and detects the true object type automatically. |
| **Selection Export** | Export the current selected-object grid exactly as shown, including the active filter, sort order, and Created / Modified columns. |
| **Native Picker Flow** | Folder browsing and object-list file selection use the native dialog path when running in Electron, with backend picker fallbacks available when needed. |
| **Fullscreen Maximize** | Diff Viewer and Enter Objects sections expand to cover the full screen (↗ to maximize, ↙ or ESC to restore). |
| **Persistent App State** | Default paths, theme, font, working object list, and panel selections are saved in `data/app-state.json` so they survive app restarts. |
| **Factory Reset** | Clears saved profiles, preferences, logs, generated scripts, exports, reports, and temporary artifacts in one action. |
| **Dependency Ordering** | Deploys object types in the customizable saved order shown in Settings. |
| **Audit Logging** | Every task produces a `.log` (human-readable) and `.json` (structured) file in `artifacts/logs/`, and the Logs tab opens the preferred text log directly. |
| **Task Progress** | Backup, Code Diff, and Deploy display stage-specific progress text; Deploy also streams per-object execution status. |
| **Themes** | Light, Dark, Cyberpunk, Dracula, Monokai, Nord, Spider-Man, Batman. Favorites can be pinned to the header picker, and the active selection persists in file-backed app state. |

---

## Connections Tab

Purpose: Create and manage reusable database connection profiles.

### Supported Actions

- Create profile
- Edit profile
- Delete profile
- Test connection
- Run diagnostics (TCP + SQL login path check)

### Profile Fields

| Field | Notes |
| ----- | ----- |
| Connection Name | Must be unique |
| SQL Server Host | Hostname or IP (hostname preferred for Windows auth) |
| Database Name | Exact name as SQL Server uses it |
| Authentication Type | Windows or SQL |
| Username | SQL auth only |
| Password | SQL auth only — encrypted at rest with DPAPI |
| Environment Tag | Optional: DEV / QA / UAT / PROD |

### Security

- SQL passwords are encrypted using Windows DPAPI via `ConvertTo-SecureString`.
- Passwords cannot be decrypted on another machine.
- Password values are masked in UI inputs and never printed in logs.

---

## Code Diff Tab

Purpose: Compare source and destination object definitions before deployment.

### How It Works

Every Code Diff run:

1. Fetches fresh object definitions directly from both source (DB1) and destination (DB2) at runtime.
2. Computes line-by-line diff.
3. Shows summary metrics: Added / Missing / Changed / Unchanged.
4. Renders side-by-side diff grid for changed objects.

Stale or previously generated files are never used as diff input.

### Diff Features

- Object-level comparison for all in-scope types
- Line-level side-by-side diff viewer with DDL keyword normalization (no spurious diffs from SMO line-break formatting)
- Summary metrics panel
- Export diff report: Markdown / HTML
- Fullscreen maximize (↗) for focused review; ESC or ↙ to restore

---

## Backup Tab

Purpose: Generate SQL object scripts from the source database.

Backup mode is **script-generation only**. It does not compare, execute, or modify any database.

### How It Works

1. Select source profile.
2. Choose objects to script (shared object list).
3. Choose destination output folder.
4. Scripts are generated with standard `CREATE` definitions and organized by Connection Alias, run date, database, schema, and object type, matching the folder structure produced by `DBObjectsBulkScriptGenerator.ps1`.
5. Run metadata and generated file paths are logged.

### What Backup Is Not

Backup is not a full database backup, differential backup, or incremental backup. It generates SQL scripts for selected DB objects only.

---

## Deployment Tab

Purpose: Execute selected SQL objects from source to destination.

### Deployment Modes

| Mode | Behavior |
| ---- | -------- |
| Execute Directly | Generates scripts from source and executes them against the destination immediately |
| Rollback (Test Run) | Wraps all scripts in a transaction that always rolls back — validates syntax and deployment plan without making any DB changes |

### Deployment Strategy by Object Type

| Object Type | Strategy |
| ----------- | -------- |
| Stored Procedures, Views, Functions, Triggers | `CREATE OR ALTER`, executed as individually tracked scripts on a reused target connection |
| Tables | Delta ALTER script via `CompareTablesGenerateDelta.ps1` — never drop/recreate (tables hold data) |
| Synonyms, Sequences, UDTs | DROP + CREATE, executed as individually tracked scripts on a reused target connection |

### Object Selection Methods

- Interactive discovery: browse and filter live DB objects in the Discover sub-tab
- Paste list: enter objects in the Specify sub-tab using `schema.name` or `TYPE,schema,name` format
- File upload: load a `.txt` or `.csv` object list
- Export list: save the current selected-object grid exactly as displayed, including active filter/sort state and Created / Modified columns

### Object List Input Format

```text
PROCEDURE,dbo,uspGetOrders
VIEW,dbo,vw_ActiveCustomers
dbo.uspGetOrders
dbo.vw_ActiveCustomers
```

### Per-Object Results

Each deployed object shows:

- Success
- Failed
- Skipped

### Execution Safety

- Pre-deployment validation
- Ordered execution by dependency-aware type order
- Stop on error (default) with optional continue-on-error mode

---

## Object Discovery and Specify Mode

### Discover Mode

Browse live objects from the source database with type and schema filters.

- **Header checkbox** — selects or clears every visible discovered object in one action.
- **Indeterminate state** — shows partial selection without losing the current filter context.
- **Created / Modified columns** — each object row shows its creation and last-modified date in `dd:mm:yyyy` format.
- Efficient for large object lists.

### Specify Mode

Paste a schema-qualified name (e.g., `dbo.MyObject`) and click **Detect & Add Objects**.

The app queries the database and detects the **true object type** — it will correctly identify VIEW, FUNCTION, TABLE, SYNONYM, etc. The type is always resolved from DB metadata, never hardcoded.

---

## Logs Tab

Purpose: View audit artifacts from diff, backup, and deployment tasks.

### Features

- Refresh log list
- Open task details
- Open the preferred text log file directly from the UI
- Review task metadata, readiness fields, event timeline, and `mm:ss` durations

### Artifacts Written to Disk

| Location | Contents |
| -------- | -------- |
| `artifacts/logs/` | `.log` (human-readable) and `.json` (structured) per task |
| `artifacts/scripts/` | Timestamped SQL script artifacts saved before execution |
| `artifacts/reports/` | Diff exports (md / html / json) |

---

## Customize Tab

Purpose: Personalize the app appearance and set default behavior preferences.

### Appearance

- **Font Family** — choose from Space Grotesk, Inter, JetBrains Mono, Fira Code, Segoe UI, Roboto, Poppins, Arial, Times New Roman.
- **Font Size** — slider from 11 px to 20 px; persisted across sessions.
- **Theme** — inline swatches to switch theme without leaving the tab.

### Behavior

- **Desktop Notifications** — toggle on/off; if enabled the OS requests permission on first enable.
- **Default Backup Folder** — pre-fills the Backup tab output path on app start.
- **Default Script Output Folder** — pre-fills the Deployment tab script output path on app start.

### Script Generation

- **Folder Names** — rename the output folder for each object type (used when generating scripts via `DBObjectsBulkScriptGenerator.ps1`).
- **Deployment Order** — reorder how object types are deployed using ↑/↓ arrows.

---

## End-to-End Workflow

1. **Connections** — Create source and destination profiles, test connections.
2. **Code Diff** — Review differences between environments.
3. **Backup** — Script the current source objects for reference (optional).
4. **Deployment** — Deploy selected objects with per-object status tracking.
5. **Logs** — Validate results and audit trail.
