# BDeploy — Installation Guide

## Prerequisites

| Requirement | Version | Notes |
| ----------- | ------- | ----- |
| Windows | 10 or 11 (64-bit) | Required — DPAPI and PowerShell integration are Windows-only |
| Node.js | 18 LTS or newer | [nodejs.org](https://nodejs.org) |
| PowerShell | 5.1 or 7+ | PowerShell 7 recommended |
| SQL Server module | latest | `Install-Module -Name SqlServer -Scope CurrentUser` |
| SQL Server | 2016 or newer | Source and/or destination databases |

---

## Option A — Run from Source

Clone the repository and run from the repository root:

```powershell
git clone https://github.com/SriHarshaSpidey/BDeploy.git
cd BDeploy
npm install
npm start
```

Open `http://localhost:5089` in your browser.

To launch the desktop app directly, use **Launch-BDeploy.cmd** or **scripts/powershell/Launch-BDeploy.ps1**. The launcher verifies Electron dependencies, starts the Electron shell, and refreshes the `BDeploy.lnk` desktop shortcut.

---

## Option B — Electron Desktop App

```powershell
npm run electron
```

Launches BDeploy as a native desktop window (no browser needed).

If you want the full desktop shortcut refresh flow, prefer `scripts/powershell/Launch-BDeploy.ps1`.

For development with hot-reload:

```powershell
npm run electron:dev
```

---

## Option C — Build Windows Installer

1. Confirm the generated app icon files exist:

   - `build/icon.ico`
   - `public/logo.png`

   See [build/README.md](build/README.md) if you need to regenerate them from `public/logo.svg`.

2. Build the installer:

```powershell
npm run build
```

Output: `dist/BDeploy Setup <version>.exe`

---

## Environment Variables

Copy `.env.example` to `.env` to override defaults:

```env
PORT=5089
DB_OBJECTS_SCRIPT=C:/path/to/scripts/powershell/DBObjectsBulkScriptGenerator.ps1
TABLE_DELTA_SCRIPT=C:/path/to/scripts/powershell/CompareTablesGenerateDelta.ps1
ARTIFACTS_DIR=C:/path/to/artifacts
TEMP_DIR=C:/path/to/temp
```

If `.env` is not present, defaults defined in the source are used.

---

## First-Run Setup

1. Open BDeploy in the browser or Electron window.
2. Go to the **Connections** tab.
3. Click **New Profile**, fill in server, database, and authentication details.
4. Click **Test** to confirm connectivity.
5. Repeat for any additional source/destination environments.

You are now ready to use Code Diff, Backup, and Deployment.

Generated script output now nests under the selected Connection Alias before the run date and database name. Example:

```text
<output root>/DEV/28-05-2026/MyDatabase/... 
```

---

## Installing the SQL Server PowerShell Module

BDeploy requires the `SqlServer` module for all database operations:

```powershell
Install-Module -Name SqlServer -Scope CurrentUser -Force
```

To verify:

```powershell
Get-Module -ListAvailable SqlServer
```

If you see a version listed, the module is ready.

---

## Troubleshooting Installation

| Issue | Fix |
| ----- | --- |
| `npm install` fails | Ensure Node.js 18+ is installed. Run `node --version` to check. |
| Port 5089 already in use | The launcher auto-selects the next port. Check `data/server-info.json` for the active URL. |
| PowerShell script blocked by execution policy | Run: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `SqlServer` module not found | Run: `Install-Module -Name SqlServer -Scope CurrentUser` |
| Electron app does not open | Run `scripts/powershell/Launch-BDeploy.ps1` or `Launch-BDeploy.cmd` so dependency checks and Electron startup happen in one path. |
| Electron window is blank | Run `npm start` first to check for server errors, then retry `npm run electron`, `scripts/powershell/Launch-BDeploy.ps1`, or `Launch-BDeploy.cmd`. |

For runtime issues, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
