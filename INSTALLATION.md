# Pebloy — Installation Guide

## Prerequisites

| Requirement | Version | Notes |
| ----------- | ------- | ----- |
| Windows | 10 or 11 (64-bit) | Required — DPAPI and PowerShell integration are Windows-only |
| Node.js | 24 LTS recommended | Source development/builds; bundled by Electron for packaged use |
| PowerShell | 7 (`pwsh`) plus Windows PowerShell 5.1 | SQL helpers require `pwsh`; DPAPI/native helpers use Windows PowerShell |
| SQL Server module | 22.4.5.1 | Pinned version; bundled in packaged apps |
| .NET SDK | 8.0 | Source DacFx development, offline compiler tests, and packaging only |
| SQL Server | 2016 SP1 or newer | `CREATE OR ALTER` requires SP1 or newer |

---

## Option A — Run from Source

Clone the repository and run from the repository root:

```powershell
git clone https://github.com/HarshaDidSmtg/Pebloy.git
cd Pebloy
npm ci
npm start
```

Open `http://127.0.0.1:5089` or the next available URL printed at startup.

To launch the desktop app directly, use **Launch-Pebloy.cmd** or **scripts/powershell/Launch-Pebloy.ps1**. The launcher verifies Electron dependencies, starts the Electron shell, and refreshes the `Pebloy.lnk` desktop shortcut.

---

## Option B — Electron Desktop App

```powershell
npm run electron
```

Launches Pebloy as a native desktop window (no browser needed).

If you want the full desktop shortcut refresh flow, prefer `scripts/powershell/Launch-Pebloy.ps1`.

For development with hot-reload:

```powershell
npm run electron:dev
```

---

## Option C — Build Windows Installer

1. Confirm the tracked source logo exists; the build generates a missing ICO automatically:

   - `build/icon.ico`
   - `public/logo.png`

   See [build/README.md](build/README.md) if you need to regenerate them from `public/logo.svg`.

2. Build the installer:

```powershell
npm run build
```

Output: `dist/Pebloy-Setup.exe`

The build first prepares the pinned SMO module and publishes the .NET 8 DacFx worker
as self-contained `win-x64` resources. This preparation needs network access on a
clean checkout. Packaged runtime does not fall back to `dotnet run` or download a
missing module; reinstall/repair the package if resources are absent. PowerShell 7
is still an external runtime prerequisite.

Run `npm run build:dir` followed by `npm run test:desktop` to smoke-test the unpacked
application without installing it. Building does not prove an installer is signed.
In-app updates require a trusted release URL, GitHub SHA-256 asset digest, and a valid
Authenticode signature matching the currently installed app's signing certificate.
Unsigned releases/builds are refused. A changed signing certificate requires a
separately verified manual upgrade.

The generated Setup `.exe` installs per user under the current Windows account. It does not request administrator credentials because the installer is configured with `perMachine: false`, `allowElevation: false`, and `requestedExecutionLevel: asInvoker`.

---

## Environment Variables

### Local Schedules

Scheduled Deployments are off by default. Turn them on in **Settings > Behavior > Scheduled Deployments** and select **Save All**; the Deployment tab then shows the Schedules section. Delete saved schedules before turning the feature off, so no Windows wake-up task is left behind. While it is off, no schedule can be created or edited and none runs.

Deployment then includes once/daily/weekly schedules. Review the selected objects, target databases, execution mode, timing, and continuation policies before saving. Saving does not execute SQL immediately. Without Windows wake-up, Pebloy must be running; an overdue schedule runs once at the next startup, not once per missed interval.

In the desktop app, **Start Pebloy via Windows Task Scheduler** registers a task for the current signed-in user at limited privilege. No password or SQL credential is stored in Windows task arguments. The machine must be awake and the user signed in; this is not a Windows service or unattended logged-off execution. Keep the installed/portable executable at its registered location, or edit and save the schedule again after moving it. Windows registration failures leave the schedule paused.

Plan changes, target identity changes, folder-content changes, failures, and interrupted runs require reapproval. Inspect logs and database state before reauthorizing uncertain executions. Delete schedules in Pebloy before uninstalling or factory-resetting it; pausing/removing them also removes their Windows wake-up tasks. No live schedule or SQL execution is part of the offline test suite.

### Runtime Configuration

Set environment variables in the launching PowerShell session. The server does not
automatically load a `.env` file:

```powershell
$env:PORT = "5089"
$env:ARTIFACTS_DIR = "C:/Pebloy/artifacts"
npm start
```

Unset variables use source defaults. Electron normally stores runtime data under
its per-user application data directory; source mode uses the workspace. The
absolute `PEBLOY_RUNTIME_ROOT` override exists for isolated desktop testing.

Only one backend may own a configured data/artifact directory at a time. Close the
other backend before launching against the same runtime storage. If settings/app
state become malformed, a previous valid snapshot is restored and the corrupt
file is retained for inspection. Recheck recovered preferences before deployment.

---

## First-Run Setup

1. Open Pebloy in the browser or Electron window.
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

Source mode prepares the pinned `SqlServer` module locally for SMO scripting:

```powershell
npm run prepare:resources
```

This also builds DacFx and therefore requires the .NET 8 SDK. Module setup uses
`Save-Module` for version 22.4.5.1 under the project's vendor directory, without
requiring a machine-wide installation. Packaged apps include that directory.

---

## Troubleshooting Installation

| Issue | Fix |
| ----- | --- |
| `npm ci` fails | Use Node.js 24 LTS and the tracked dependency lockfile. Run `node --version` to check. |
| Port 5089 already in use | The launcher auto-selects the next port. Check `data/server-info.json` for the active URL. |
| PowerShell script blocked by execution policy | Run: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `SqlServer` module not found | Source: run `npm run prepare:resources`. Packaged: repair/reinstall the app. |
| Electron app does not open | Run `scripts/powershell/Launch-Pebloy.ps1` or `Launch-Pebloy.cmd` so dependency checks and Electron startup happen in one path. |
| Electron window is blank | Run `npm start` first to check for server errors, then retry `npm run electron`, `scripts/powershell/Launch-Pebloy.ps1`, or `Launch-Pebloy.cmd`. |

For runtime issues, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
