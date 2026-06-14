# BDeploy — Implementation History

## 2026-05-28 (Session 10)

### Export, Progress, and Log Usability Polish

- **Root cause:** The selected-object export was writing a raw unsorted object list, progress bars only showed generic running/completed labels, and the Logs screen always opened the JSON artifact even though operators usually want the readable text log.
- **Fix:** Updated `public/app.js` to export the exact visible selection grid snapshot, standardized UI date/time and `mm:ss` duration formatting, wired Backup/Diff/Deploy stage progress through SSE, and changed log-open behavior to prefer the text log recorded by `loggingService`.
- **Result:** Operators now export what they actually see in the grid, long-running tasks show clearer stage text, and the Logs screen opens the `.log` artifact directly.

### Alias-Based Output Roots and Metadata Casing

- **Root cause:** Generated artifact paths did not include the Connection Alias and `DBObjectsBulkScriptGenerator.ps1` could write schema/object paths using the user's pasted casing instead of the resolved database metadata.
- **Fix:** Added alias-aware output root building in `scriptAutomationService.js` and updated `DBObjectsBulkScriptGenerator.ps1` to use resolved `SchemaName` / `ObjectName` metadata when writing schema folders, filenames, and `BuildPaths` entries.
- **Result:** Generated output now lands under `ConnectionAlias\dd-mm-yyyy\DatabaseName\...`, and filesystem/build-path casing matches the real database metadata.

### Deploy Deduplication for Duplicate Selections

- **Root cause:** Deployment execution normalized selected objects but did not deduplicate them before execution, so duplicate picks could replay the same synonym or other object more than once.
- **Fix:** Added deduplication at the deployment planning and execution entry point in `deploymentService.js` and covered it with a synonym-specific regression test.
- **Result:** Duplicate selections no longer create duplicate deployment entries or repeated execution for the same object.

## 2026-05-22 (Session 9)

### Desktop Launcher, Shortcut, and App Logo Assets

- **Root cause:** Desktop launch behavior was split between browser-first and Electron-first entry points, and the Windows shortcut/icon path was not aligned with the actual BDeploy logo assets.
- **Fix:** Updated the BDeploy launch scripts to start Electron directly, retain `Launch-DBBridge.*` as compatibility wrappers, refresh `BDeploy.lnk` on the desktop, and generate `public/logo.png` plus `build/icon.ico` from the current BDeploy logo design.
- **Result:** Launching from the provided scripts now opens the Electron desktop app reliably, the desktop shortcut uses the app logo, and Electron has a matching window icon asset.

### Native Picker Runtime Alignment

- **Root cause:** File and folder pickers looked inconsistent because some paths were exercised through the browser runtime while others used native Electron or backend dialogs.
- **Fix:** Kept native dialog support wired through the Electron shell while preserving backend picker endpoints as fallback behavior.
- **Result:** When launched through Electron, object-list file selection and folder browsing now follow the same native dialog path more consistently.

## 2026-05-22 (Session 8)

### Persistent App State and Factory Reset

- **Root cause:** Default paths, theme, font, and working tab inputs were stored in browser `localStorage`, which was not reliable enough for the Electron app lifecycle and could not be cleared cleanly as shareable project data.
- **Fix:** Added `src/services/appStateService.js` with `data/app-state.json` as the file-backed store for UI preferences and working inputs, moved script settings persistence into `data/settings.json`, and exposed `/api/app-state` plus `/api/factory-reset` endpoints in `src/server.js`.
- **Result:** Default saved paths persist across restarts, current working inputs are stored in a separate clearable data file, and the new Factory Reset button clears saved app data, logs, generated scripts, exports, reports, and temp artifacts in one action.

### Progress Indicator Accuracy

- **Root cause:** The progress bar used synthetic percentages that deliberately stalled at 92%, which made long-running tasks look inaccurate and jump suddenly to completion.
- **Fix:** Replaced the fake percentage loop in `public/app.js` with an indeterminate running state and added animated progress styling in `public/style.css`.
- **Result:** Running tasks now show activity without misleading percentage values, then transition directly to completed or failed states.

### In-Tab Maximize Simplification

- Removed the fullscreen/minimize path from `public/app.js` and reduced the Diff/Specify control to a single maximize/restore toggle.
- Updated the maximized layouts in `public/style.css` so expansion stays inside the current tab while still giving the Specify textarea and Code Diff viewer substantially more working space.

## 2026-05-22 (Session 7)

### Panel Toggle Behavior Restored

- **Root cause:** The Diff Viewer and Specify panels had been reduced to a single maximize/restore toggle. That removed true minimize behavior, so the panels no longer matched the intended collapse/expand workflow.
- **Fix:** Replaced the maximize-only handler in `public/app.js` with shared panel toggle logic that tracks separate `minimized` and `maximized` states, added dedicated minimize and maximize buttons in `public/index.html`, and updated `public/style.css` so minimized panels actually collapse their body content.
- **Result:** The Diff Viewer and Enter Objects panels now support minimize, expand, maximize, restore, and `Esc`-to-exit-maximize behavior consistently.

### CodeDiff Stale Comparison To-Do Closed

- Verified `compareObjects()` in `src/services/diffService.js` generates fresh scripts for both source and destination profiles on every diff run.
- Verified `getCodeDiffOutputPaths(taskId)` in `src/services/scriptGenerationService.js` writes each run to task-specific `artifacts/exports/codediff/<taskId>_source` and `<taskId>_dest` folders, preventing reuse of prior diff artifacts.
- Updated documentation to remove the stale "CodeDiff compares stale scripts" active bug from the pending issue list.

## 2026-05-22 (Session 6)

### Unified Folder Picker Behavior

- **Root cause:** The Customize tab's default-path Browse buttons had drifted from the working Backup and Deployment folder-picker flow. That left default-path browsing inconsistent and broke the expected Windows folder chooser behavior.
- **Fix:** Consolidated folder browsing in `public/app.js` through a shared `chooseFolderForInput(inputId, description)` helper that calls `/api/system/pick-folder` and seeds the picker with the current input value as `initialPath`.
- **Result:** Backup, Deployment, and Customize now all use the same folder-selection behavior, the default-path Browse buttons work again, and folder/path chooser UX is consistent wherever the app asks for an output folder.

## 2026-05-22 (Session 5)

### Date Columns Now Show Time

- `formatDate()` in `public/app.js` updated to use `toLocaleString` with `hour: "2-digit", minute: "2-digit"` options. This historical behavior was later superseded by the 2026-05-28 formatting standardization to `dd:mm:yyyy` in object grids and `dd:mm:yyyy hh:mm:ss` in logs/task details.

### Script Whitespace Trimming

- Added `.trim()` to `fs.readFileSync` in `scriptAutomationService.js` (`generateTableDelta` return value) and `diffService.js` (`scriptsToMap`). Generated scripts no longer carry leading/trailing blank lines in artifacts or diffs.

### DDL Keyword Line-Break Normalization

- **Root cause:** SMO sometimes emits `CREATE\nPROCEDURE` or `CREATE\nOR\nALTER\nPROCEDURE` with keyword pairs split across lines. This caused spurious code diff results and broke the `CREATE OR ALTER` substitution regex.
- **Fix:** Added `normalizeDdlKeywords(text)` helper in `scriptAutomationService.js` (exported). Applied at the top of `normalizeExecutableSql()`, in `diffService.js` when reading script files for diffing, and in `sqlService.js`'s `normalizeDefinition()` for live DB definitions. All three paths now produce canonical single-line DDL keywords.

### Fullscreen Maximize / Restore

- Added `setupMaximizable(toggleId, wrapperId)` helper in `public/app.js`. Toggles a `.maximized` CSS class and flips the button icon between ↗ (maximize) and ↙ (restore). ESC key also restores the panel.
- **Specify section** (`#specifyWrap`): ↗ maximize button in `.maximizable-header` expands the Enter Objects panel to cover the full screen (`position: fixed; inset: 0; z-index: 9999`). ↙ or ESC restores.
- **Code Diff viewer** (`#diffMaxWrap`): ↗ maximize button above the diff output expands the viewer to cover the full screen. ↙ or ESC restores.
- Added `.maximizable-wrap`, `.maximizable-header`, `.maximize-toggle`, and `.maximizable-wrap.maximized` styles to `public/style.css`. Maximized state uses `position: fixed; inset: 0; background: var(--bg); overflow-y: auto`. The header inside gets `position: sticky; top: 0` so the ↙ button stays visible while scrolling.

### Customize Tab Redesign

- Rebuilt the Customize tab in `public/index.html` with three named sections: **Appearance**, **Behavior**, and **Script Generation**.
- **Appearance** card: font family selector, font size slider (11–20 px with live label), and inline theme swatches — all without leaving the tab.
- **Behavior** card: iOS-style desktop notifications toggle (`#notificationsToggle`), default Backup output folder (`#defaultBackupPath`), and default Script Output folder (`#defaultScriptPath`) — each with a Browse button.
- **Script Generation** section: folder name customization table and deployment order list (unchanged from before, now organized under a labelled section).
- `setupCustomize()` in `app.js` extended to handle notifications toggle (OS permission request on first enable), default-path Browse buttons (via shared `chooseFolderForInput()`), and Save button persistence to `localStorage`.
- `start()` pre-fills `#backupPath` and `#deployScriptPath` from `localStorage` saved defaults on every app load.
- Added CSS classes: `.customize-field`, `.path-input-row`, `.toggle-field`, `.toggle-switch`, `.toggle-slider`, `.theme-picker-inline`, `.customize-section-title`, `.customize-behavior-actions`.

---

## 2026-05-22 (Session 4)

### Bug Fix: Rollback Mode Failing on Tables — "Incorrect syntax near 'GO'"

- **Root cause:** The table delta script generated by `CompareTablesGenerateDelta.ps1` contains `GO` batch separators. The rollback code wrapped the raw `delta.scriptText` directly in a `BEGIN TRANSACTION ... ROLLBACK TRANSACTION` block and sent it to `ExecuteNonQuery()`. ADO.NET does not understand `GO` (it's a client-side batch separator), causing "Incorrect syntax near 'GO'".
- **Fix:** Strip all `GO` lines from `delta.scriptText` before wrapping in the rollback transaction in `deploymentService.js`. Table delta scripts only contain ALTER TABLE/ADD CONSTRAINT/DROP CONSTRAINT statements, which do not require separate batches.

### Fix: CompareTablesGenerateDelta only receives TABLE objects

- `deploymentService.js` was passing the full `ordered` list (containing procedures, views, etc.) to `generateTableDelta()` in both Rollback and ExecuteDirectly modes.
- Both call sites now pre-filter to `objectType === "TABLE"` before calling `generateTableDelta()`. The intent is now explicit at the call site.

### Fix: Dates Returning as /Date(ms)/ — PowerShell WCF JSON Format

- **Root cause:** PowerShell's `ConvertTo-Json` serializes `System.DateTime` values using the WCF JSON format `/Date(milliseconds)/` instead of ISO 8601. JavaScript's `new Date("/Date(...)/")`returns "Invalid Date".
- **Fix:** Updated the row-serialization loop in `runSmoQuery()` (`sqlService.js`) to detect `System.DateTime` values and call `.ToString('yyyy-MM-ddTHH:mm:ss')` before serialization. Dates now arrive as `"2025-03-14T05:17:15"`.

### Removed: JSON Export Option from Code Diff

- JSON format option removed from the Export dropdown in Code Diff tab. Only Markdown and HTML exports remain.

### UI: Objects Tab Moved Next to Credentials

- Tab order changed: Credentials → **Objects** → Code Diff → Backup → Deployment → Logs → Customize

### Test Results (All Scenarios)

| Scenario | Result |
| --- | --- |
| Discover mode (dates) | PASS — dates show as `2025-03-14` |
| Specify/Resolve mode (7 objects) | PASS — types + dates resolved correctly |
| Code Diff (DEV vs SLICE) | PASS — summary returned correctly |
| Backup (2 procedures, DEV) | PASS — scripts generated |
| Rollback Deploy (2 procs + 1 table, DEV→SLICE) | PASS — all 3 RolledBack, 0 Failed |

---

## 2026-05-22 (Session 3)

### Bug Fix: "Invalid Date" in Discover Grid

- **Root cause 1 (PowerShell):** `System.Data.SqlClient.SqlDataAdapter` stores SQL `NULL` as `System.DBNull.Value`. PowerShell's `ConvertTo-Json` serializes `DBNull` as `{}` (empty object), not JSON `null`. JavaScript then saw `{}` as truthy, called `new Date({})`, and got "Invalid Date".
- **Fix (backend):** Updated the row-serialization loop in `runSmoQuery()` (`sqlService.js`) to check `$val -is [System.DBNull]` and explicitly emit `$null` instead, so JSON output contains `null` for missing dates.
- **Root cause 2 (frontend):** `formatDate()` only checked `!d`, which passes for `null` but not for `{}`. Also had no guard against `isNaN` on an Invalid Date instance.
- **Fix (frontend):** `formatDate()` now rejects any object that is not a `Date` instance, and explicitly checks `isNaN(date.getTime())` before formatting.

### Feature: Dates in Specify Mode (Selected Objects Table)

- `resolveAndAdd()` now captures `createdDate` and `modifiedDate` from the `/api/objects/resolve-types` API response alongside `objectType`.
- Dates are written onto each parsed item before passing to `addToSharedSelection()`.
- `renderSharedSelectionTable()` updated to show **Created** and **Modified** columns alongside Type / Schema / Name.

---

## 2026-05-22 (Session 2)

### Bug Fix: Specify Mode Rejecting All Objects

- **Root cause:** `parseObjectLines()` called `dedupeObjects()` which required a non-empty `objectType` to pass items through. Objects entered in `schema.name` format always have `objectType: ""` at parse time, so all of them were silently dropped before type resolution ran.
- **Fix:** Replaced `dedupeObjects()` call in `parseObjectLines()` with an inline deduplication keyed on `schemaName.toLowerCase()|objectName.toLowerCase()` — objectType is not required. Items now flow through to the `/api/objects/resolve-types` API correctly.
- Inputs like `casemanager.uspaddnewcasetypes` or `tollplus.usp_get_customer_plan_balances_by_accountstatus` now work as expected.

### Error Toast Persistence

- **Problem:** All toasts auto-dismissed after 2500ms — errors were unreadable.
- **Fix:** Error toasts now stay visible for 10 seconds and show a `✕` indicator. Clicking the toast dismisses it immediately. Success toasts still auto-dismiss at 2.5 seconds.
- `pointer-events: none` removed from `#toast` base; added back only in `#toast.visible` so interaction is possible when shown.

### Specify Textarea Improvements

- Textarea (`#sharedObjectText`) is now full-width in the specify section.
- Layout changed to column direction so the textarea takes the full width below the file upload input.
- Min-height increased to `10rem`; monospace font applied for readability.
- Fixed `rows` attribute removed — height is now controlled by CSS and the textarea remains user-resizable.

### Code Diff Viewer Height

- `.diff-object-list` and `.diff-unified-wrap` `max-height` increased from `28rem` to `70vh` — the diff viewer now uses most of the screen for large diffs.

### Code Diff Export — Documentation

- **Markdown:** Saves a `.md` file with summary table and per-object diff blocks. For Confluence, GitHub PRs, deployment tickets.
- **HTML:** Self-contained file with colored diff lines. For sharing with non-technical stakeholders.
- **JSON:** Raw diff data structure. For programmatic processing or tooling integration.
- Exported file path is shown in the toast after export completes.

---

## 2026-05-22 (Session 1)

### App Rename: EasyDeploy / DBBridge → BDeploy

- Updated `<title>`, `<h1>`, and logo `alt` in `public/index.html`
- Updated `logo.svg` aria-label and text node
- Updated `package.json`: `name`, `appId`, `productName`, `copyright`, `shortcutName`, `artifactName`
- Updated notification title in `public/app.js` from "DBBridge" to "BDeploy"

### Logo Fix

- `index.html` referenced `src="new-logo.svg"` which did not exist — corrected to `src="logo.svg"`

### Nothing OS UI Redesign

- Added **Space Grotesk** font to Google Fonts import in `style.css`
- Updated `body` font-family to prefer Space Grotesk
- Replaced `:root` defaults with Nothing OS palette: pure black (`#000`), dark surfaces (`#0d0d0d`, `#141414`), red accent (`#ff2340`), off-white text (`#f0f0f0`)
- Separated `:root` from `body[data-theme='light']` — light theme preserved independently
- Updated `body[data-theme='dark']` to match Nothing OS values
- Reduced `--radius` to `4px` and `--radius-lg` to `6px` across all themes
- Flat buttons: removed `linear-gradient()` from button backgrounds; now uses `background: var(--accent)`
- Removed box-shadow from buttons
- Added dot-grid background texture via `radial-gradient` on `body`

### Label Field Improvements (`public/index.html`)

- "Profile Label" → "Connection Name"
- "Server Name" → "SQL Server Host"
- "Source" (Code Diff tab) → "Source Database"
- "Destination" (Code Diff tab) → "Target Database"
- "Profile" (Backup tab) → "Source Database"
- "Destination Path" (Backup tab) → "Output Folder"
- "Source" (Deployment tab) → "Source Database"
- "Destination" (Deployment tab) → "Target Database"
- "Script Output Path" → "Script Output Folder"
- "Mode" (Objects tab) → "Input Mode"

### Specify Mode Improvements

- Bracket stripping added to `parseObjectLines()` in `app.js` — inputs like `[dbo].[MyProc]` are now cleaned automatically
- Removed duplicate "Add From Specify Input" button; single "Detect & Add Objects" button remains
- Updated textarea placeholder to clarify `schema.name` format

### Discover Grid Improvements

- Added `createdDate` and `modifiedDate` columns to `discoverObjects()` SQL in `sqlService.js` (all 5 UNION branches)
- Added date COALESCE lookups to `resolveObjectTypes()` SQL in `sqlService.js`
- Updated `dedupeObjects()` in `app.js` to preserve extra fields (`createdDate`, `modifiedDate`) when deduplicating
- Added `formatDate()` helper in `app.js`
- `renderSharedObjectPicker()` now shows Created and Modified date columns
- "Select All" and "Unselect All" buttons replaced with a header checkbox with indeterminate state support

---

## 2026-05-21

### Theme System

- Fixed theme persistence for Spider-Man and Batman themes — added both to `validThemes` array in `setupTheme()`
- Themes now correctly save to and restore from `localStorage`

### Font Selector

- Added `setupFontSelector()` function in `app.js`
- Font selection persists in `localStorage` and applies on load
- Added font options: Inter, JetBrains Mono, Fira Code, Segoe UI, Roboto, Poppins, Arial, Times New Roman
- Font selector wired to the Customize tab's `<select id="fontSelector">`

### Logging

- Added "Clear All Logs" button in Logs tab
- Added `clearAllLogs()` in `loggingService.js` — deletes all `.log` and `.json` files from the logs directory
- Added `DELETE /api/logs` endpoint in `server.js`

### Tab Order

- Tabs reordered to match workflow: Credentials → Code Diff → Backup → Deployment → Objects → Logs → Customize

### Security — PowerShell Scripts

- `CompareTablesGenerateDelta.ps1`: Removed 9 hardcoded defaults (server IPs, database names, username, plaintext password, file paths)
- `DBObjectsBulkScriptGenerator.ps1`: Removed hardcoded `ObjectListPath` default (`C:\Users\Public\ObjectList.txt`)

---

## 2026-05-20

### Documentation Reorganization

- Created `REQUIREMENTS.md`, `FEATURES.md`, `ISSUES.md`, `IMPROVEMENTS.md`, `ARCHITECTURE.md`, `INSTALLATION.md`, `TROUBLESHOOTING.md`, `SECURITY.md`, `THEMES.md`, `CHANGELOG.md`
- Removed obsolete/redundant documentation files
- Cleaned up `artifacts/`, `data/` and other generated directories from tracked files
