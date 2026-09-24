# Pebloy

> Streamlined SQL Server schema management — built for Windows developers and DBAs.

Pebloy is a **Windows desktop tool** (Electron + Node.js) that simplifies comparing, backing up, and deploying SQL Server database objects across environments (DEV -> QA -> UAT -> PROD).

Repository: [HarshaDidSmtg/Pebloy](https://github.com/HarshaDidSmtg/Pebloy)

---

## Features

| Feature | Description |
| ------- | ----------- |
| **Connection Profiles** | Named server/database connections. SQL passwords encrypted with Windows DPAPI — never plaintext. |
| **Live Code Diff** | Side-by-side diff of object definitions fetched directly from source and destination at runtime. Covers stored procedures, views, functions, triggers, tables (columns + indexes + PK + defaults), synonyms, sequences, and UDTs. |
| **Backup** | Scripts selected objects to SQL files under Connection Alias → run date → database → schema → object type. Script-generation only — no database modification. |
| **Deployment** | Object-type-aware execution: individually tracked module scripts for procedures/views/functions/triggers, delta ALTER for tables, DROP+CREATE for synonyms/sequences/UDTs. Modes: Execute Directly and Rollback (Test Run — wraps all scripts in a transaction that always rolls back). |
| **Object Discovery** | Browse live DB objects with type/schema filters and use the header checkbox to select or clear the visible result set. |
| **Task Progress** | Backup, Code Diff, and Deploy emit stage-specific progress text, while Deploy also streams per-object status updates during execution. |
| **Offline SQL Formatter** | Monaco-based T-SQL formatter workbench with local open/save/save-as, drag/drop, search/replace, compare mode, inline diff, and persisted interactive-only formatter preferences. |
| **Native Picker Flow** | Folder browse actions and object-list file selection use the same native dialog flow when running in Electron, with backend picker fallbacks available. |
| **Persistent App State** | Default paths, theme, font, working object inputs, and formatter UI/options are stored in `data/app-state.json` so they survive app restarts. |
| **SQL Folder Sources** | Explicitly load a single database's per-object scripts for Backup, Code Diff, or guarded non-table deployment. Original files are not modified; table deployment still requires a live source for delta generation. |
| **Multi-Target Deploy** | Review up to 20 target databases together, execute sequentially, and inspect separate target results and logs. Earlier targets may remain committed if a later target fails. |
| **Schedules** | Optional; turn on **Scheduled Deployments** in Settings > Behavior. Reviewed once/daily/weekly jobs with optional signed-in-user Windows wake-up, fresh plan checks, and pause-on-failure recovery. See [scheduling requirements](INSTALLATION.md#local-schedules). |
| **Code Diff Viewer** | GitHub/Beyond Compare-style review: split or unified view, word-level change highlighting, SQL syntax colors, expandable unchanged context, previous/next change navigation (Alt+Up/Down), a change overview strip, and object filtering. Reads target (current) → source (incoming), so + lines are what a deployment would introduce. |
| **Factory Reset** | Clears saved profiles, preferences, logs, exports, reports, and temp artifacts so the project can be shared cleanly. |
| **Dependency Ordering** | UDTs → Sequences → Tables → Views → Functions → Procedures → Synonyms → Triggers. |
| **Audit Logging** | Every task produces a `.log` (human-readable) and `.json` (structured) file in `artifacts/logs/`, and the Logs tab opens the preferred text log directly. |
| **Themes** | Light, Dark, Porcelain, Batman, Sepia, Spider-Man, and Monochrome. New profiles follow the system appearance; explicit choices remain saved. Legacy selections resolve to their replacement palettes. |

---

## Requirements

| Requirement | Version |
| ----------- | ------- |
| Windows | 10 or 11 (64-bit) |
| Node.js | 18 LTS or newer |
| PowerShell | 5.1 or PowerShell 7+ |
| SQL Server module | `Install-Module -Name SqlServer` |
| SQL Server | 2016 or newer |

---

## Quick Start

Clone the repository, then from the repository root run:

```powershell
git clone https://github.com/HarshaDidSmtg/Pebloy.git
cd Pebloy
npm install
npm start
```

Open `http://localhost:5089` or double-click **Launch-Pebloy.cmd**.

`Launch-Pebloy.cmd` starts the Electron desktop app and refreshes the `Pebloy.lnk` desktop shortcut.

For the Electron desktop app directly: `npm run electron`

See [INSTALLATION.md](INSTALLATION.md) for full setup options including the Windows installer build.

---

## Typical Workflow

1. **Connections** — Add source and target profiles, test connections.
2. **Code Diff** — Review what changed between environments.
3. **Backup** — Script the current source objects for reference (optional).
4. **Deploy** — Deploy selected objects with per-object status tracking.
5. **Formatter** — Open or paste local SQL, format it offline, and optionally review a before/after diff.
6. **Logs** — Audit the task result.

---

## SQL Formatter

The Formatter tab is a fully local T-SQL workbench. It never connects to SQL Server, never calls a remote API, and never emits telemetry.

What it supports:

- Monaco editing with folding, bracket matching, line numbers, multiple cursors, undo/redo, and find/replace.
- Open, drag/drop, save, save as, copy, and clear for local `.sql` and `.txt` files.
- Before/after comparison with Monaco diff view, including inline diff mode.
- Background formatting through a local worker-backed backend path so large scripts do not block the UI.
- Persisted interactive formatter options and editor toggles in `data/app-state.json`.

Safety boundaries:

- Interactive formatter options are stored separately from `settings.formatting.formatGeneratedSql`.
- Backup, Code Diff, and Deploy continue using Pebloy’s shared generated-SQL formatting path.
- The desktop shell binds the formatter backend to loopback only, and Save overwrites only the file opened or created in the current Pebloy session.
- GO separators, comments, BOM, EOL style, trailing newline, and string literal content are preserved.
- If a batch cannot be parsed safely, Pebloy keeps the original batch text instead of guessing.

Current option groups:

- Configurable: Formatting, Indentation, Keywords, Boolean, Output, Misc.
- Intentionally fixed in this release: Comma Style, CASE, and JOIN layout. The UI shows those groups explicitly as deterministic/fixed so their absence is never silent.

---

## Project Structure

```text
pebloy/
├── src/
│   ├── server.js                       # Express routes
│   ├── electron/main.js                # Electron entry point
│   └── services/
│       ├── scriptGenerationService.js  # Shared script-generation entry points
│       ├── scriptAutomationService.js  # Shared PowerShell orchestration
│       ├── diffService.js              # Object diff computation
│       ├── deploymentService.js        # Deployment orchestration
│       ├── backupService.js            # Backup orchestration
│       ├── sqlService.js               # SQL via PowerShell ADO.NET
│       ├── profileService.js           # Connection profile CRUD
│       ├── appStateService.js          # Persistent UI/app-state storage
│       ├── formatterOptions.js         # Interactive formatter option normalization + capabilities
│       ├── formatterService.js         # Shared generated-SQL formatting + interactive worker entry point
│       ├── formatterWorker.js          # Local worker-thread formatter execution
│       ├── settingsService.js          # Folder, formatting, time, execution settings
│       ├── factoryResetService.js      # Runtime data/artifact reset
│       ├── loggingService.js           # Per-task audit logs
│       ├── systemService.js            # Folder picker / file open
│       ├── secretStore.js              # DPAPI password encryption
│       ├── storage.js                  # JSON file I/O
│       ├── tsqlFormatterProvider.js    # Offline T-SQL formatter provider and post-fixes
│       └── utils.js                    # Auth type + name helpers
├── scripts/
│   └── powershell/
│       ├── CompareTablesGenerateDelta.ps1 # Table schema delta generator
│       ├── DBObjectsBulkScriptGenerator.ps1 # Bulk object script generator
│       └── Launch-Pebloy.ps1           # Desktop launcher
├── public/                             # Frontend (vanilla HTML/CSS/JS)
├── data/                               # Runtime: profiles + encrypted secrets
├── artifacts/                          # Runtime: logs, scripts, reports
└── build/                              # electron-builder assets
```

---

## Documentation

| Document | Contents |
| -------- | -------- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Technical architecture, service layer, API contracts |
| [INSTALLATION.md](INSTALLATION.md) | Full installation guide including Electron and installer |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common issues and fixes |
| [SECURITY.md](SECURITY.md) | Password storage, SQL injection prevention, log sanitization |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup and contribution guide |

---

## Security

- SQL passwords encrypted with **Windows DPAPI** — cannot be read on another machine.
- All queries use parameterized literals (`escapeSqlLiteral`) in `sqlService.js`.
- `data/` and `artifacts/` are excluded from git. Never commit these directories.

See [SECURITY.md](SECURITY.md) for full details.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and PR checklist.

For a public GitHub release, enable private vulnerability reporting or provide another non-public maintainer contact before inviting issue reports.

---

## License

[MIT](LICENSE)
