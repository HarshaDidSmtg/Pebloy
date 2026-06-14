# Changelog

All notable changes to BDeploy are documented here.

## [1.3.1] — 2026-05-28

### Added

- **Selection export parity** — saving the object list now exports the same filtered and sorted grid snapshot shown in the UI, including headers for Type, Schema, Object, Created, and Modified
- **Stage-based task progress** — Backup, Code Diff, and Deploy now emit operation-level progress text while Deploy continues to stream per-object execution results
- **Log readiness metadata** — structured task logs now carry sorting, ordering, and filtering readiness defaults alongside both text and JSON log paths

### Changed

- **Generated output roots now include the Connection Alias** before the date/database path for shared script generation
- **UI date formatting standardized** — object dates now render as `dd:mm:yyyy`; logs and task details use `dd:mm:yyyy hh:mm:ss`; durations render as `mm:ss`
- **Open File behavior** now prefers the `.log` text artifact instead of forcing the `.json` record

### Fixed

- **PowerShell metadata casing** — `DBObjectsBulkScriptGenerator.ps1` now uses resolved database metadata casing for schema/object folder names, filenames, and `BuildPaths` entries
- **Duplicate deploy execution** — duplicate selected objects, including synonyms, are deduplicated before execution so they are not replayed more than once
- **Stale deploy docs mismatch** — documentation now reflects that deploy uses individually tracked programmable-object scripts rather than combined stored procedure execution outside backup mode

## [1.3.0] — 2026-05-25

### Added

- **Per-shortcut Reset button** in Settings → Keyboard Shortcuts; each row now shows label, description, current value, default hint, and a ↺ reset-to-default button (disabled when already at default)
- **Hover tooltips** on every shortcut row describing the action and noting the SSMS / VS Code equivalent
- **Shortcut badges** rendered next to Resolve & Add, Run Diff, Run Backup, Run Deployment buttons; placeholder in Specify textarea now shows current Find / Replace / UPPER / lower shortcuts dynamically
- **Save All** consolidated button in Settings top-right action bar — one click persists both `appState` and `settings` backends
- **Enter-to-Save** anywhere inside the Settings panel triggers Save All
- **Custom 3-button confirm modal** (`showConfirmModal`) replaces chained native `confirm()` for Factory Reset (`Export & Reset` / `Reset Without Saving` / `Cancel`)
- **Shortcut auto-commit** with explicit Enter confirmation; blur acts as a safety-net save
- **Source/Target profile sync across tabs** — selecting a profile in Objects/Diff/Backup/Deploy mirrors it to the other tabs in the same Source or Target group
- **Pre-typed object list sidecar** — JS writes a `.json` next to the existing `.txt` object list with pre-resolved object types so `DBObjectsBulkScriptGenerator.ps1` can skip its per-database `sys.objects` discovery query

### Changed

- **`resolveObjectTypes` returns DB-authoritative casing** — schema and object names come from `sys.schemas`/`sys.tables`/`sys.objects`/`sys.synonyms`/`sys.sequences`/`sys.types` instead of echoing the user's pasted casing. The JS `resolveAndAdd` substitution finally takes effect
- **Deploy executes stored procedures individually** instead of as a single combined batch; a failed SP is reported in isolation and `continueOnError` lets the rest proceed
- **Settings buttons relocated to top-right** action bar; old scattered Save Preferences / Save Script Settings / Factory Reset rows removed
- **`ensureSqlServerModule` memoized** — runs once per server process instead of on every PS-backed operation

### Fixed

- **Ctrl+F / Ctrl+H find bar** — opening the bar no longer steals focus from the search input; Replace operations correctly reset match indices and advance the cursor; infinite loop on edge-case empty queries prevented
- **Shortcut Settings input** — previous premature capture (saving `Ctrl+Shift` instead of `Ctrl+Shift+U`) replaced with explicit Enter-to-confirm
- **Table delta script** wraps `ALTER TABLE ... ADD CONSTRAINT ... PRIMARY KEY` and `... UNIQUE` in `IF NOT EXISTS (SELECT 1 FROM sys.key_constraints ...)` guards — re-running a partially-applied delta no longer fails with "Table already has a primary key defined on it"
- **Shortcut persistence** — auto-saves no longer depend on a single fragile blur path; commit triggers refresh of shortcut badges in real time

## [1.2.0]

### Added

- **Space Grotesk** font added to UI (Nothing OS aesthetic)
- **Discover grid date+time columns** — Created and Modified timestamps (date + time) shown for each discovered object and in the Specify mode selection table
- **Header checkbox** in discover grid replaces Select All / Unselect All buttons; supports indeterminate state
- Date resolution in `resolveObjectTypes()` SQL — Specify mode results now carry `createdDate` / `modifiedDate`
- **Fullscreen maximize/restore** — ↗/↙ buttons on "Enter Objects" and "Diff Viewer" expand to cover the full screen; ESC restores
- **Customize tab redesigned** — organized into Appearance, Behavior, and Script Generation sections
- **Font size slider** in Customize tab (11–20 px, persisted in `localStorage`)
- **Desktop notifications toggle** in Customize tab — enables/disables OS task-completion notifications
- **Default path settings** in Customize tab — pre-fill Backup and Deploy script-output paths on app start
- **Inline theme swatches** in Customize tab — switch theme without going to the header
- **DDL keyword normalization** — `CREATE\nPROCEDURE` and similar SMO line-break splits collapsed to single-line keywords at three layers: `DBObjectsBulkScriptGenerator.ps1` (source), `normalizeExecutableSql()` (deploy), and `scriptsToMap()` (diff). Eliminates spurious code diff results caused by SMO formatting differences
- **Script whitespace trimming** — generated `.sql` files trimmed before storing or diffing; no leading/trailing blank lines in artifacts
- **Factory Reset** button clears saved profiles, preferences, logs, generated scripts, exports, reports, and temp artifacts
- **Persistent app-state file** stores UI preferences and working inputs in `data/app-state.json`
- **Desktop launcher refresh** — `Launch-BDeploy.ps1` / `Launch-BDeploy.cmd` now create or refresh the `BDeploy.lnk` desktop shortcut during launch

### Changed

- App renamed from DBBridge / EasyDeploy to **BDeploy** across all files
- Broken logo reference (`new-logo.svg`) fixed — reverted to `logo.svg`
- Nothing OS UI redesign: pure black background, `#ff2340` red accent, flat buttons (no gradients), dot-grid texture, 4px border radius
- Dark theme updated to match Nothing OS palette; light theme preserved as independent theme
- Label fields improved: "Profile Label"→"Connection Name", "Server Name"→"SQL Server Host", "Destination"→"Target Database", "Destination Path"→"Output Folder", "Script Output Path"→"Script Output Folder", "Mode"→"Input Mode"
- Deployment modes updated to "Execute Directly" and "Rollback (Test Run)" — Rollback wraps all scripts in a transaction that always rolls back for safe dry-run validation
- Specify mode simplified to single "Detect & Add Objects" button
- Specify mode now strips `[` `]` brackets from pasted input automatically
- `dedupeObjects()` preserves extra fields (`createdDate`, `modifiedDate`) while normalizing keys
- Objects tab placed immediately after Credentials in tab order for faster workflow

### Fixed

- Specify mode always resolved to PROCEDURE — now queries actual database metadata for correct type
- No bulk selection in Discover mode — replaced with header checkbox
- Rollback mode failing on tables with `GO` separator — `GO` lines are now stripped from table delta scripts before wrapping in rollback transaction
- `CompareTablesGenerateDelta.ps1` receiving non-TABLE objects — both call sites now pre-filter to `objectType === "TABLE"`
- Dates returning as `/Date(ms)/` (WCF JSON format) — PowerShell DateTime values now serialized as ISO 8601 strings
- SQL `NULL` values serializing as `{}` (empty object) instead of `null` in PowerShell `ConvertTo-Json` output
- CodeDiff now regenerates scripts into task-specific source and destination export folders before comparing, so stale generated files are not reused
- Electron window and desktop shortcut now use generated app-logo assets from `public/logo.png` and `build/icon.ico`

## [1.1.0]

### Added

- Spider-Man and Batman themes
- Electron desktop app support (`npm run electron`)
- Object discovery with type and schema filters
- Specify mode for manual object entry with schema-qualified names
- Side-by-side line-level diff viewer
- Diff export: Markdown, HTML, JSON
- `CompareTablesGenerateDelta.ps1` integration for table delta deployment
- Windows Forms folder picker dialog (`/api/system/pick-folder`)
- 3-attempt connection retry in `scriptAutomationService` (direct → tcp: prefix → alternate auth)
- Health check endpoint at `/api/health`
- Per-task structured JSON logs alongside human-readable `.log` files
- `diagnostics` endpoint for TCP + SQL login path validation

### Fixed

- PowerShell subprocess uses `pwsh` (PowerShell 7) instead of `powershell.exe` to avoid PS5/SMO module conflicts
- SMO server variable renamed from `$server` to `$smoServer` to avoid collision with PowerShell built-in `$host`
- SQL execution uses `$db.ExecuteWithResults` instead of `Invoke-Sqlcmd`

### Changed

- SQL passwords encrypted with Windows DPAPI — no longer stored in plaintext
- All database queries use `escapeSqlLiteral` parameterization

## [1.0.0] — Initial Release

### Added

- Credentials tab with Windows and SQL authentication profile management
- Code Diff tab with object-level comparison
- Backup tab for SQL script generation
- Deployment tab with Generate, Preview, and Execute modes
- Light and Dark themes
- Per-task audit logging to `artifacts/logs/`
- `DBObjectsBulkScriptGenerator.ps1` integration for bulk object scripting
