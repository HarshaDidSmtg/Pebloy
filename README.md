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
| **Deployment** | Object-type-aware execution: individually tracked module scripts for procedures/views/functions/triggers, delta ALTER for tables, DROP+CREATE for synonyms/sequences/UDTs. UI modes: Apply Changes (`ExecuteDirectly`) and Validate Only (Rollback). |
| **Object Selection** | Build one shared object list for Diff, Backup, and Deploy. Manual Entry uses a Monaco-based editor with find/replace and case-transform shortcuts; Browse Database supports type/schema filters, header-checkbox bulk selection, and 50-row pagination. |
| **Task Progress** | Backup, Code Diff, and Deploy emit stage-specific progress text, while Deploy also streams per-object status updates during execution. |
| **Deployment Plan Preview** | Review ordered per-object deployment actions before running a deployment. |
| **Native Picker Flow** | Folder browse actions and object-list file selection use the same native dialog flow when running in Electron, with backend picker fallbacks available. |
| **Persistent App State** | Default paths, theme, font, and working object inputs are stored in `data/app-state.json` so they survive app restarts. |
| **Factory Reset** | Clears saved profiles, preferences, logs, exports, reports, and temp artifacts so the project can be shared cleanly. |
| **Dependency Ordering** | UDTs → Sequences → Tables → Views → Functions → Procedures → Synonyms → Triggers. |
| **Audit Logging** | Every task produces a `.log` (human-readable) and `.json` (structured) file in `artifacts/logs/`, and the Logs tab opens the preferred text log directly. |
| **Themes** | Light, Azure, Dark, Spider-Man, Batman. The active selection persists per machine in file-backed app state. |

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

Open the URL shown in the terminal (default `http://localhost:5089`) or double-click **Launch-Pebloy.cmd**.

If port 5089 is already in use, Pebloy automatically selects the next available port and writes the active URL to `data/server-info.json`.

`Launch-Pebloy.cmd` starts the Electron desktop app and refreshes the `Pebloy.lnk` desktop shortcut.

For the Electron desktop app directly: `npm run electron`

See [INSTALLATION.md](INSTALLATION.md) for full setup options including the Windows installer build.

---

## Typical Workflow

1. **Connections** — Add source and target profiles, test connections.
2. **Code Diff** — Review what changed between environments.
3. **Backup** — Script the current source objects for reference (optional).
4. **Deploy** — Deploy selected objects with per-object status tracking.
5. **Logs** — Audit the task result.

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
│       ├── errorService.js             # User-facing error shaping + resolution steps
│       ├── paths.js                    # Centralized artifact/export paths
│       ├── profileService.js           # Connection profile CRUD
│       ├── appStateService.js          # Persistent UI/app-state storage
│       ├── settingsService.js          # Folder-name + deployment-order settings
│       ├── factoryResetService.js      # Runtime data/artifact reset
│       ├── loggingService.js           # Per-task audit logs
│       ├── systemService.js            # Folder picker / file open
│       ├── secretStore.js              # DPAPI password encryption
│       ├── storage.js                  # JSON file I/O
│       └── utils.js                    # Auth type + name helpers
├── scripts/
│   └── powershell/
│       ├── CompareTablesGenerateDelta.ps1 # Table schema delta generator
│       ├── DBObjectsBulkScriptGenerator.ps1 # Bulk object script generator
│       └── Launch-Pebloy.ps1           # Desktop launcher
├── public/                             # Frontend (vanilla HTML/CSS/JS)
│   ├── app.js                          # Main UI wiring
│   ├── editorHelpers.js                # Shared editor shortcut/help text
│   ├── manualEntryEditor.js            # Monaco-backed multiline editor adapter
│   └── index.html / style.css          # Shell + styling
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
