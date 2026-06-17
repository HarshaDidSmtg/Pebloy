const { execFile } = require("child_process");
const fs = require("fs");

const POWERSHELL_CANDIDATES = ["powershell.exe", "powershell", "pwsh.exe", "pwsh"];

function sanitizeForPs(value) {
  return String(value || "").replace(/[\r\n\0]/g, " ").replace(/'/g, "''");
}

function buildDialogPreamble() {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class DpiHelper {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();

  [DllImport("shcore.dll")]
  public static extern int SetProcessDpiAwareness(int awareness);

  public static void Enable() {
    try { SetProcessDpiAwareness(2); } catch { }
    try { SetProcessDPIAware(); } catch { }
  }
}
"@
[DpiHelper]::Enable()
Add-Type -AssemblyName System.Windows.Forms
try { [System.Windows.Forms.Application]::EnableVisualStyles() } catch { }
`;
}

function executePowerShell(script, { sta = false } = {}) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  return new Promise((resolve, reject) => {
    let index = 0;

    const runNext = (lastError) => {
      if (index >= POWERSHELL_CANDIDATES.length) {
        reject(lastError || new Error("No supported PowerShell executable was found."));
        return;
      }

      const command = POWERSHELL_CANDIDATES[index++];
      const args = ["-NoProfile", "-EncodedCommand", encoded];
      if (sta) args.splice(1, 0, "-STA");

      execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
        if (error) {
          runNext(new Error(String(stderr || error.message || "").trim() || `Failed to run ${command}`));
          return;
        }

        resolve(String(stdout || "").trim());
      });
    };

    runNext();
  });
}

function buildExplorerFolderScript(description, initialPath) {
  return `
${buildDialogPreamble()}
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '${description}'
$dialog.ValidateNames = $false
$dialog.CheckFileExists = $false
$dialog.CheckPathExists = $true
$dialog.FileName = 'Select Folder'
$dialog.Filter = 'Folders|*.'
$dialog.Multiselect = $false
if ('${initialPath}' -and (Test-Path -LiteralPath '${initialPath}')) {
  $dialog.InitialDirectory = '${initialPath}'
} else {
  $dialog.InitialDirectory = [Environment]::GetFolderPath('Desktop')
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.FileName) {
  $selected = [System.IO.Path]::GetDirectoryName($dialog.FileName)
  if (-not $selected -or -not (Test-Path -LiteralPath $selected)) {
    $selected = $dialog.InitialDirectory
  }
  Write-Output $selected
}
`;
}

function buildFolderBrowserScript(description, initialPath) {
  return `
${buildDialogPreamble()}
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${description}'
$dialog.ShowNewFolderButton = $true
if ('${initialPath}' -and (Test-Path -LiteralPath '${initialPath}')) {
  $dialog.SelectedPath = '${initialPath}'
} else {
  $dialog.SelectedPath = [Environment]::GetFolderPath('Desktop')
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
  Write-Output $dialog.SelectedPath
}
`;
}

function buildFilePickerScript(description, initialPath, filterText) {
  return `
${buildDialogPreamble()}
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '${description}'
$dialog.Filter = '${filterText}'
$dialog.Multiselect = $false
$dialog.CheckFileExists = $true
$dialog.CheckPathExists = $true
if ('${initialPath}' -and (Test-Path -LiteralPath '${initialPath}')) {
  if ((Get-Item -LiteralPath '${initialPath}').PSIsContainer) {
    $dialog.InitialDirectory = '${initialPath}'
  } else {
    $dialog.InitialDirectory = Split-Path -Parent '${initialPath}'
  }
} else {
  $dialog.InitialDirectory = [Environment]::GetFolderPath('Desktop')
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.FileName) {
  Write-Output $dialog.FileName
}
`;
}

async function pickFolder(options = {}) {
  const description = sanitizeForPs(options.description || "Select a folder");
  const initialPath = sanitizeForPs(options.initialPath || "");

  try {
    const selectedPath = await executePowerShell(buildExplorerFolderScript(description, initialPath), { sta: true });
    return selectedPath || null;
  } catch (_primaryError) {
    try {
      const selectedPath = await executePowerShell(buildFolderBrowserScript(description, initialPath), { sta: true });
      return selectedPath || null;
    } catch (fallbackError) {
      throw new Error(`Unable to open folder picker. ${fallbackError.message || ""}`.trim());
    }
  }
}

async function pickFile(options = {}) {
  const description = sanitizeForPs(options.description || "Select a file");
  const initialPath = sanitizeForPs(options.initialPath || "");
  const filterText = sanitizeForPs(options.filterText || "Text Files (*.txt;*.csv)|*.txt;*.csv|All Files (*.*)|*.*");

  try {
    const selectedPath = await executePowerShell(buildFilePickerScript(description, initialPath, filterText), { sta: true });
    if (!selectedPath) return null;

    return {
      selectedPath,
      fileName: selectedPath.split(/[\\/]/).pop() || selectedPath,
      content: fs.readFileSync(selectedPath, "utf8"),
    };
  } catch (error) {
    throw new Error(`Unable to open file picker. ${error.message || ""}`.trim());
  }
}

function openPath(targetPath, options = {}) {
  return new Promise((resolve, reject) => {
    if (!targetPath) {
      reject(new Error("No path provided."));
      return;
    }

    const escapedPath = sanitizeForPs(targetPath);
    const promptForApp = options && options.promptForApp === true;
    const script = `
$ErrorActionPreference = 'Stop'
$target = '${escapedPath}'
if (-not (Test-Path -LiteralPath $target)) {
  throw "Path not found: $target"
}
$resolved = (Resolve-Path -LiteralPath $target).Path
if (${promptForApp ? "$true" : "$false"} -and $IsWindows) {
  Start-Process -FilePath 'rundll32.exe' -ArgumentList @('shell32.dll,OpenAs_RunDLL', $resolved) | Out-Null
} else {
  Invoke-Item -LiteralPath $resolved | Out-Null
}
Write-Output $resolved
`;
    executePowerShell(script)
      .then(resolve)
      .catch((error) => reject(new Error(`Unable to open path. ${String(error.message || "").trim()}`.trim())));
  });
}

module.exports = {
  pickFile,
  pickFolder,
  openPath,
};
