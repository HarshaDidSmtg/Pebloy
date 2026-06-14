$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$launcherCmd = Join-Path $root "Launch-BDeploy.cmd"
$electronCmd = Join-Path $root "node_modules\.bin\electron.cmd"
$desktopShortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "BDeploy.lnk"
$iconPath = Join-Path $root "build\icon.ico"

function Ensure-DesktopShortcut {
    if (!(Test-Path -LiteralPath $launcherCmd)) {
        Write-Host "[BDeploy] Launch-BDeploy.cmd not found. Skipping desktop shortcut creation."
        return
    }

    $wshShell = New-Object -ComObject WScript.Shell
    $shortcut = $wshShell.CreateShortcut($desktopShortcutPath)
    $shortcut.TargetPath = $launcherCmd
    $shortcut.WorkingDirectory = $root
    $shortcut.Description = "Open BDeploy"
    if (Test-Path -LiteralPath $iconPath) {
        # ,0 selects the first icon in the file — required for Windows to honor the icon
        $shortcut.IconLocation = "$iconPath,0"
    }
    $shortcut.Save()

    # Rebuild the shell icon cache so Windows picks up the new icon immediately
    try { & "$env:SystemRoot\System32\ie4uinit.exe" -show 2>$null } catch {}

    Write-Host "[BDeploy] Desktop shortcut ready: $desktopShortcutPath"
}

Set-Location $root

Ensure-DesktopShortcut

Write-Host "[BDeploy] Checking dependencies..."
if (!(Test-Path -LiteralPath (Join-Path $root "node_modules"))) {
    Write-Host "[BDeploy] node_modules not found. Running npm install..."
    npm install --include=dev
    if ($LASTEXITCODE -ne 0) {
        throw "npm install failed."
    }
}

if (!(Test-Path -LiteralPath $electronCmd)) {
    Write-Host "[BDeploy] Electron runtime not found. Installing dev dependencies..."
    npm install --include=dev
    if ($LASTEXITCODE -ne 0) {
        throw "npm install --include=dev failed."
    }
}

if (!(Test-Path -LiteralPath $electronCmd)) {
    throw "Electron executable was not installed to node_modules\.bin\electron.cmd"
}

Write-Host "[BDeploy] Starting Electron desktop app..."
$electronArgs = @(".")
Start-Process -FilePath $electronCmd -WorkingDirectory $root -ArgumentList $electronArgs -WindowStyle Normal | Out-Null
Write-Host "[BDeploy] Launch complete."
