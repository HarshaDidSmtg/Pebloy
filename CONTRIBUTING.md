# Contributing to Pebloy

Thank you for your interest in contributing! This guide explains how to get started.

## Development Setup

Clone the repository and work from the repository root:

```bash
git clone https://github.com/HarshaDidSmtg/Pebloy.git
cd Pebloy
npm install
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
    paths.js            — Centralized artifact/export paths
    sqlService.js       — All SQL via PowerShell ADO.NET
    diffService.js      — Side-by-side object definition diff
    deploymentService.js — Deployment orchestration
    backupService.js    — Script-based backup
    scriptAutomationService.js — Wraps the two PS scripts
    errorService.js     — User-facing error shaping
    profileService.js   — Connection profile CRUD + DPAPI secrets
    appStateService.js  — Persistent UI/app-state storage
    settingsService.js  — Folder-name + deployment-order settings
    factoryResetService.js — Runtime data/artifact reset
    loggingService.js   — Per-task log files (text + JSON)
    systemService.js    — Windows folder picker / file open
    secretStore.js      — DPAPI encryption/decryption
    storage.js          — JSON file I/O helpers
    utils.js            — normalizeAuthType, normalizeSqlName
public/
  index.html            — Single-page UI shell
  app.js                — Vanilla JS frontend
  editorHelpers.js      — Shared editor helper copy
  manualEntryEditor.js  — Monaco-backed enhanced textarea adapter
  style.css             — CSS custom-property themes
  logo.svg              — Application logo
scripts/powershell/CompareTablesGenerateDelta.ps1
scripts/powershell/DBObjectsBulkScriptGenerator.ps1
```

## Running Tests

```bash
npm test              # Run all Jest tests
npm run check         # Syntax-check JS files used by the app
```

Tests that need a live SQL Server set the `TEST_PROFILE_ID` and `TEST_TABLE_NAME`
environment variables (see `src/services/integration.test.js`).

Useful targeted commands during development:

```bash
npx jest src/services/scriptAutomationService.test.js src/services/backupService.test.js src/services/diffService.test.js src/services/deploymentService.test.js src/services/loggingService.test.js --runInBand
npx jest src/services/integration.test.js --runInBand
```

The live integration suite exercises real PowerShell and SQL paths and can take a few minutes to complete.

## Code Style

- **Node services**: plain CommonJS, no transpilation
- **Frontend**: vanilla JS (no frameworks)
- **SQL execution**: always via PowerShell — no native Node SQL drivers
- **Indentation**: 2 spaces (JS), 4 spaces (PS)

Run `npm run check` before submitting — it validates JS syntax across all service files.

## Pull Request Checklist

- [ ] `npm run check` passes (no syntax errors)
- [ ] `npm test` passes (existing tests green)
- [ ] No credentials, tokens, or connection strings committed
- [ ] PS script logic preserved where possible (service layer wraps, not rewrites)
- [ ] New endpoints documented with a brief comment in `server.js`
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
