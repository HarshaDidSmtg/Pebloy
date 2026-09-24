# Changelog

All notable changes to Pebloy are documented here.

## [Unreleased]

### Local Workflow Improvements

- Added SQL Folder sources for Backup, Code Diff, and guarded non-table deployment. ScriptDom resolves actual declaration metadata, rejects executable extras and duplicate/case-ambiguous objects, and fingerprints fresh folder content. Imported files remain untouched; generated copies honor formatting preferences. Offline table deployment remains blocked because table deltas require two live databases.
- Added sequential deployment to up to 20 distinct resolved targets, one combined confirmation, reviewed stop/continue policies, separate target logs/output roots, and per-target results. This is not a transaction across databases.
- Added confirmed once/daily/weekly schedules with credential-free persisted selections, fresh plan/identity checks, no overlapping execution, and fail-closed recovery. Optional Windows Task Scheduler wake-up runs as the signed-in user without elevation or stored passwords. A missed schedule runs once when Pebloy next starts; missed intervals are not replayed. Failures and interruptions pause the schedule for review.
- Scheduled Deployments are now an opt-in Settings feature (off by default). The server refuses schedule creation, editing, and due-time runs while it is off, and refuses to turn it off while saved schedules exist.
- Rebuilt the Code Diff viewer in the style of GitHub compare and Beyond Compare: split/unified layouts, word-level highlights computed by the diff engine, SQL syntax coloring (including multi-line comments and strings), expandable collapsed context with `@@` hunk headers, previous/next change navigation with Alt+Up/Down, a clickable change overview strip, per-object +/− counts, status filters, and search. Line numbers and +/− markers are not copied with code. Layout, context, and wrap choices persist; narrow windows use unified view.
- Code Diff views and Markdown/HTML exports now read target (current) → source (incoming), so + lines are what deploying the source would introduce. Stored report data is unchanged.
- Fixed triggers being silently skipped by the shared script generator: its name lookup excluded `TR` objects, so Code Diff and trigger deployment never received fresh trigger scripts. DML triggers are now scripted from `sys.sql_modules` into each schema's `Triggers` folder.
- Added connection groups, 25/50/100 discovery page sizes, read-only pinned SqlServer module status, and explicit missing-module installation for source runs. Packaged resource failures require installer repair.
- Added standalone syntax-highlighted HTML diff export, Markdown clipboard copying, and Ctrl+Shift+C on the Code Diff tab. Exports reuse the displayed report.
- Added configurable archive-age previews with expiring confirmation tokens; changed previews cannot delete files. No automatic archive pruning occurs. Oversized text logs preserve the selected-object header while retaining recent events; JSON retains the complete event history.
- First-launch appearance follows the operating system. Existing named theme choices remain unchanged, and Follow system can be toggled in Appearance.

### Safety and Reliability

- Opened task details now show the recorded selected objects in two tab-separated columns: object type and schema-qualified name. New text logs include the same list; event-level filters do not hide it, and narrow log panes scroll without splitting rows. Existing log files are not rewritten.
- Fixed discovery dropdowns being overwritten by late metadata responses, losing live choices during same-connection refreshes, and failing to restore saved filters on startup. Unchanged options are retained, filter edits persist directly, and loading/failed connections no longer display another connection's filters.
- Native dropdowns no longer lose Enter to discovery-search or Settings Save All shortcuts. Text-field Enter shortcuts remain available. Audited native versus Monaco text controls and fixed the formatter/diff font size not following the same preference as manual object entry.
- Fixed local Windows taskbar branding inheriting Electron's default icon. Local and packaged windows now set the Pebloy application ID, taskbar icon resource, display name, and relaunch command explicitly; native tests verify the actual Windows window properties.
- Table delta generation preserves metadata spelling for resolved schema/table/database names and schema-qualified user-defined column types. Name matching follows source/target identifier case sensitivity instead of forced lowercase; ambiguous case-distinct source tables on a case-insensitive target are refused. Case-only changes in defaults, computed columns, and filtered indexes require review rather than being silently ignored. Folder layout, filenames, SQL encoding, and generation-only behavior remain unchanged.
- Fixed UDT signature comparison failing on mixed catalog/database collations in its UNION detail column. All signature branches now use explicit database collation and retain full definition text. UDT comparison errors or missing source metadata stop deployment before SQL execution; coarse base-type descriptions no longer qualify a type as unchanged. Equal UDTs remain skipped even if another object's definition comparison fails.
- Deployment order now comes from fresh selected-object dependency metadata, including parameter types, constraints, and trigger parents. Metadata failures block planning; combined procedure scripts follow planned order. Removed configurable Deployment Order from Settings while preserving other preferences.
- Run Deployment now opens a required plan-confirmation popup for Apply, Rollback, and Dry Run. Cancel sends no execution request; changed dependencies or connection details require a fresh confirmation before script generation.
- Format & Execute in Source now stays in Backup with its own confirmed source plan. Removed it from Deployment's mode selector; execution still uses the guarded deployment service.
- Restored **Format & Execute in Source** through a separately confirmed Deployment action, reachable from the Backup formatting menu. Fresh source module scripts are formatted and applied; ordinary Backup remains read-only and tables/non-module objects are skipped.
- Added exclusive Windows runtime-directory locks, unique runtime task identities, shutdown draining after client disconnection, preference snapshots/corrupt-file recovery, installed-signer certificate pinning, and distinct ReviewRequired outcomes for guarded migrations.
- Corrected DROP/CREATE of stored ALTER definitions and guarded CREATE OR ALTER against silent module-signature loss. Added disabled-by-default live tests for data retention, transaction failure injection, and source formatting.
- Enforced generation-only Backup, fresh-script CodeDiff, and explicit Deploy modes. Procedures execute as a combined group; tables retain delta deployment; other objects use guarded DROP/CREATE.
- Added execution acknowledgements, no post-connect replay in deployment helpers, per-group/object transactions, resolved database identity checks, dependency-group ordering, and preflight failure for missing fresh scripts. Rollback/timeout reporting now distinguishes confirmed outcomes from uncertainty.
- Protected local mutations and Electron IPC; moved credentials to stdin; bounded DPAPI and workers; verified update digests/signatures; made JSON writes atomic and credential rotation failure-safe.
- Added persistent cross-page discovery selection, selected-grid pagination, retry-only-failed selection, mobile overflow fixes, keyboard dialog handling, dirty-editor protection, and accessible reconnect-safe progress.
- Added checkpointed/redacted logs and graceful shutdown, pinned packaged SMO/self-contained DacFx resources, Windows CI, browser/desktop smoke tests, and guarded tracked SQL fixtures. Live SQL tests remain opt-in; no shared database reset is part of validation.

### Added

- Consolidated the theme picker to Light, Dark, Porcelain, Batman, Sepia, Spider-Man, and Monochrome, each with a symbol. The new Light/Dark palettes replace their old versions, Graphite is now labeled Batman, and Azure DevOps is removed. Legacy saved IDs resolve to replacements; existing Sepia choices are preserved.
- Refined Sepia and Spider-Man with quieter surfaces and stronger text contrast. SQL syntax colors now follow the palette in both Monaco editors. Monochrome uses neutral UI, logo, syntax, and editor-diff colors while retaining status labels and diff markers. Desktop/mobile tests cover persistence, replacement mappings, editor rendering, and WCAG AA contrast for tested text, action, status, and rendered SQL-token pairs.
- **Canonical source-artifact quality gate** — `src/services/scriptGenerationService.js` now validates BuildPaths-listed per-object source artifacts before Backup or Code Diff uses them. Programmable-object source files must stay headerless, start with the expected `CREATE` / `ALTER` text, reject deploy-only wrappers such as `IF OBJECT_ID`, `DROP`, and `CREATE OR ALTER`, and tables must remain deterministic `CREATE TABLE` sources.
- **Generation warning surfacing (UI)** — generation warnings from Backup, Code Diff, and Deploy now render as a visible warning panel directly below the result area in each tab. Warnings are color-coded using `--warning` and list the affected object name and profile role (source/destination for diff).
- **Dashboard tab** — new first tab showing connection count, total task counts by type, quick-action buttons (Run Diff / Backup / Deploy / Select Objects), and a recent-tasks summary table. Dashboard refreshes on every tab visit.
- **Golden-file regression tests** — `scriptGenerationService.test.js` now covers all canonical source object types (PROCEDURE, VIEW, FUNCTION, TRIGGER, TABLE, SYNONYM, SEQUENCE, USER_DEFINED_TYPE) for valid and invalid artifact scenarios, plus `EXACT_DEFINITION_OBJECT_MISSING` and `EXACT_DEFINITION_METADATA_INCOMPLETE` warning cases, and Windows line-ending output for function artifacts.
- **Discover grid pagination** — the object picker now paginates at 50 objects per page for large result sets, with Prev/Next buttons and a jump-to-page input. Sorting resets to page 1. Lists under 50 objects render without pagination as before.
- **Log file size cap** — `loggingService` trims individual `.log` files that exceed `MAX_LOG_FILE_BYTES` (default 2 MB, overridable via env var), keeping the header line and last 200 lines.
- **Centralized artifact path config** — `src/services/paths.js` exports `EXPORTS_DIR` and `CODEDIFF_DIR`; `backupService`, `deploymentService`, and `scriptGenerationService` now derive output roots from this module rather than inlining `__dirname` chains. All paths remain env-var overridable.
- **Improved actionable error messages** — `errorService` now maps additional error patterns to resolution steps: bulk script generation failures, table delta failures, canonical source validation failures, no-objects-supplied, and network connection errors.
- **PowerShell error context extraction** — `scriptAutomationService` parses PS stderr for `At ...ps1:line N`, `CategoryInfo`, `FullyQualifiedErrorId`, and script-level `ERROR:` lines, appending them as a `[Detail]` suffix to thrown error messages for better log attribution.

### Changed

- Applied the approved Forward P logo to the sidebar/favicon, Electron window, and Windows packaging. Resource preparation now regenerates a 512 px PNG and a seven-size 32-bit ICO from the SVG master on every build, preventing stale single-size icons from being reused.
- **Tab order updated** — Dashboard is now the first tab (Dashboard → Connections → Objects → Code Diff → Backup → Deployment → Logs → Settings).
- **Headerless canonical programmable-object artifacts preserved** — per-object Backup / Code Diff source files for procedures, views, functions, and triggers remain SSDT / DACPAC-safe and do not carry leading `SET ANSI_NULLS` / `GO` / `SET QUOTED_IDENTIFIER` / `GO` batches in BuildPaths-listed artifacts.
- **Deploy-time session settings are now rehydrated from exact metadata** — executable deploy artifacts rebuild `SET ANSI_NULLS` and `SET QUOTED_IDENTIFIER` batches for procedures, views, functions, and triggers, while canonical source files remain headerless.
- **Exact-definition sync now preserves deploy metadata in memory** so source artifacts stay canonical while deployment still has access to module-level session-setting metadata.
- **Procedure deployment uses the combined artifact** while per-object source artifacts remain canonical and headerless. Group failures apply to all procedures in that transaction.

### Notes

- **Backend split** — PowerShell remains the scripting/execution backend; the .NET 8 DacFx worker provides offline validation and optional comparison, not deployment.
- **Validation scope** — unit, browser, and unpacked desktop tests are available locally and in CI. Live SQL transactional behavior and signed-installer/update installation require separate release validation.
- **Deployment plan preview** — confirmed fully implemented as of v1.3.0 (`POST /api/deploy/plan`, full UI with ordered execution plan).
- **Retry failed objects** — replaces the selection with failed objects only, avoiding replay of successful objects.
- **Utility consolidation** — `normalizeAuthType` and `normalizeSqlName` are defined once in `src/services/utils.js` with no duplication found across the service layer.
- **Folder-as-source workflows** - implemented for explicitly selected folders. Live-source Code Diff still regenerates fresh definitions; imported table scripts can be compared but cannot replace the mandatory live table-delta deployment path.
- **SQL parser/build validation (DacFx)** — the offline compiler path is implemented; it complements rather than replaces deployment testing on disposable databases.

## [1.3.1] — 2026-05-28

### Added

- **Selection export parity** — saving the object list now exports the same filtered and sorted grid snapshot shown in the UI, including headers for Type, Schema, Object, Created, and Modified
- **Stage-based task progress** — Backup, Code Diff, and Deploy now emit operation-level progress text while Deploy continues to stream per-object execution results
- **Log readiness metadata** — structured task logs now carry sorting, ordering, and filtering readiness defaults alongside both text and JSON log paths

### Changed

- **Generated output roots now include the Connection Alias** before the date/database path for shared script generation
- **UI date formatting standardized** — object dates now render as `dd/MM/YYYY`; logs and task details use `dd/MM/YYYY HH:mm:ss`; durations render as `mm:ss`
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
- **Desktop launcher refresh** — `Launch-Pebloy.ps1` / `Launch-Pebloy.cmd` now create or refresh the `Pebloy.lnk` desktop shortcut during launch

### Changed

- App renamed from DBBridge / EasyDeploy to **Pebloy** across all files
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
