# Contributing to Pebloy

Thank you for your interest in contributing! This guide explains how to get started.

## Development Setup

Clone the repository and work from the repository root:

Use Windows, Node.js 24 LTS, PowerShell 7 (`pwsh`), and the .NET 8 SDK for the
full development/test toolchain. Windows PowerShell 5.1 is also used for DPAPI.

```bash
git clone https://github.com/HarshaDidSmtg/Pebloy.git
cd Pebloy
npm ci
npm run dev          # Start Express server with auto-reload
# or
npm run electron:dev # Start Electron app in development mode
```

## Project Layout

```text
src/
  server.js             — Express routes
  electron/main.js      — Electron entry point
  services/
    scriptGenerationService.js — Shared generation entry points
    sqlService.js       — All SQL via PowerShell ADO.NET
    diffService.js      — Side-by-side object definition diff
    deploymentService.js — Deployment orchestration
    backupService.js    — Script-based backup
    scriptAutomationService.js — Wraps the two PS scripts
    profileService.js   — Connection profile CRUD + DPAPI secrets
    appStateService.js  — Persistent UI/app-state storage
    settingsService.js  — Folder names, formatting, time, and execution settings
    factoryResetService.js — Runtime data/artifact reset
    loggingService.js   — Per-task log files (text + JSON)
    systemService.js    — Windows folder picker / file open
    secretStore.js      — DPAPI encryption/decryption
    storage.js          — JSON file I/O helpers
    utils.js            — normalizeAuthType, normalizeSqlName
public/
  index.html            — Single-page UI shell
  app.js                — Vanilla JS frontend
  style.css             — CSS custom-property themes
  logo.svg              — Application logo
scripts/powershell/CompareTablesGenerateDelta.ps1
scripts/powershell/DBObjectsBulkScriptGenerator.ps1
```

## Running Tests

```bash
npm test              # Jest; live SQL remains opt-in
npm run check         # Syntax-check JS files used by the app
npx playwright install chromium
npm run test:browser  # Desktop/mobile, isolated temporary data, no SQL writes
npm run build:dir     # Prepare resources and build unpacked Windows app
npm run test:desktop  # Native save/overwrite smoke test of that build
```

Live SQL Server tests are skipped by default, even when saved profiles exist.
They require explicit opt-in via `PEBLOY_RUN_SQL_INTEGRATION=1`, profiles tagged
`DEV` and `INT` in the workspace profile store, and two distinct disposable
databases whose configured and resolved names end in `_PebloyTest`.
The tracked [source fixture](tests/fixtures/setup-dev.sql) and
[target fixture](tests/fixtures/setup-slice.sql) reset the `bdeploy_test` schema's
test objects. They also reject database names without the required suffix.
Never rename or repoint shared DEV/INT databases to bypass this guard. Configure
dedicated disposable test profiles before opting in; seeding destroys fixture data.

Useful targeted commands during development:

```bash
npx jest src/services/scriptAutomationService.test.js src/services/backupService.test.js src/services/diffService.test.js src/services/deploymentService.test.js src/services/loggingService.test.js --runInBand
```

The script-automation suite runs `tests/powershell/table-delta.tests.ps1` with PowerShell 7.
It parses the actual delta generator and exercises its functions and generation loops
with in-memory metadata, without loading SMO or connecting to SQL Server. It checks
metadata casing, case-sensitive/insensitive identifier matching, case-only expression
changes, alias-type spelling, and target-name collisions.

Run live integration tests separately from the unit suite in PowerShell:

```powershell
$env:PEBLOY_RUN_SQL_INTEGRATION = "1"
try {
  npx jest src/services/integration.test.js --runInBand
} finally {
  Remove-Item Env:PEBLOY_RUN_SQL_INTEGRATION
}
```

The live integration suite exercises real PowerShell and SQL paths, writes to both
test databases, and can take a few minutes to complete. Do not opt in against shared
development, UAT, or production databases.

The [Windows CI workflow](.github/workflows/validate.yml) sets
`PEBLOY_RUN_SQL_INTEGRATION=0` and runs syntax checks, Jest, npm audit, and browser
tests. Its manual `package_smoke` option builds and tests the unpacked app but does
not sign, publish, or install a release. A real disposable-SQL run is a separate
release gate for database execution changes; mocked PowerShell tests do not prove
transaction behavior on SQL Server.

Live cases include row retention, rollback after a later batch fails, independent
object rollback before continuing, and the confirmed source Format & Execute action.
Offline lifecycle tests use temporary runtimes and mocked generation to verify that
shutdown waits for work after its HTTP client disconnects. Runtime-lock tests
terminate only isolated test children; no real database workflow is canceled.

## Code Style

- **Node services**: plain CommonJS, no transpilation
- **Frontend**: vanilla JS (no frameworks)
- **SQL execution**: always via PowerShell — no native Node SQL drivers
- **Indentation**: 2 spaces (JS), 4 spaces (PS)

Run `npm run check` before submitting. It discovers and validates every JavaScript
file under `src`, `public`, and `scripts`, including new services, tests, and workers.

## Pull Request Checklist

- [ ] `npm run check` passes (no syntax errors)
- [ ] `npm test` passes (existing tests green)
- [ ] UI changes pass `npm run test:browser`; packaging changes pass a fresh build and `npm run test:desktop`
- [ ] No credentials, tokens, or connection strings committed
- [ ] PS script logic preserved where possible (service layer wraps, not rewrites)
- [ ] Changed API and execution contracts documented in the architecture/security guides
- [ ] New UI behavior tested manually with at least one profile

## Reporting Issues

Please open a GitHub Issue at [HarshaDidSmtg/Pebloy Issues](https://github.com/HarshaDidSmtg/Pebloy/issues) with:

- OS version and Node.js version
- Steps to reproduce
- What you expected vs what happened
- Relevant log output from `artifacts/logs/`

## Security Issues

Do not report security vulnerabilities in a public issue. Use GitHub private
vulnerability reporting if the repository has it enabled, or another private
maintainer channel for the published project.
