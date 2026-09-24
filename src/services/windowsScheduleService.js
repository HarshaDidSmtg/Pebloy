const path = require("path");
const { createHash } = require("crypto");
const { execFile } = require("child_process");

function capabilities() {
  return { wakeApplication: process.platform === "win32" && Boolean(process.env.PEBLOY_SCHEDULE_EXECUTABLE) };
}

function taskName(id) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid schedule identifier.");
  const owner = createHash("sha256").update(path.resolve(process.env.DATA_DIR || "data").toLowerCase()).digest("hex").slice(0, 16);
  return `Pebloy_${owner}_${id}`;
}

function updateWindowsTask(record, remove = false) {
  if (process.platform !== "win32" || (!remove && !capabilities().wakeApplication)) {
    throw new Error("Windows wake-up scheduling requires the Pebloy desktop application.");
  }
  const payload = { name: taskName(record.id), executable: process.env.PEBLOY_SCHEDULE_EXECUTABLE,
    arguments: process.env.PEBLOY_SCHEDULE_ARGUMENTS || "", nextRunAt: record.nextRunAt, repeat: record.repeat };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const command = `$ErrorActionPreference = 'Stop'
$job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
${remove ? `Get-ScheduledTask -TaskName $job.name -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false` : `
$when = [DateTimeOffset]::Parse($job.nextRunAt).LocalDateTime
$action = New-ScheduledTaskAction -Execute $job.executable -Argument $job.arguments
$trigger = switch ($job.repeat) {
  'daily' { New-ScheduledTaskTrigger -Daily -At $when }
  'weekly' { New-ScheduledTaskTrigger -Weekly -DaysOfWeek $when.DayOfWeek -At $when }
  default { New-ScheduledTaskTrigger -Once -At $when }
}
$trigger.StartBoundary = $when.ToString('yyyy-MM-ddTHH:mm:ss')
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $job.name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Start Pebloy for an explicitly reviewed local schedule.' -Force | Out-Null`}`;
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    execFile(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`Windows scheduling failed: ${String(stderr || stdout || error.message).trim()}`));
        else resolve();
      });
  });
}

module.exports = { capabilities, updateWindowsTask };