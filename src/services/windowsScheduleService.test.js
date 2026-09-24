jest.mock("child_process", () => ({ execFile: jest.fn() }));
const { execFile } = require("child_process");
const { updateWindowsTask } = require("./windowsScheduleService");
test("Windows schedules use a limited interactive principal and safely encoded values", async () => {
  if (process.platform !== "win32") return;
  const previous = process.env.PEBLOY_SCHEDULE_EXECUTABLE;
  process.env.PEBLOY_SCHEDULE_EXECUTABLE = "C:\\App's Folder\\Pebloy.exe";
  execFile.mockImplementation((_file, _args, _options, callback) => callback(null, "", ""));
  try {
    await updateWindowsTask({ id: "12345678-1234-1234-1234-123456789abc", repeat: "daily", nextRunAt: "2030-01-01T13:00:00Z" });
    const [executable, args] = execFile.mock.calls[0];
    expect(executable).toBe(require("path").join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    const script = Buffer.from(args[3], "base64").toString("utf16le");
    expect(script).toContain("-LogonType Interactive -RunLevel Limited");
    expect(script).toContain("-MultipleInstances IgnoreNew");
    expect(script).not.toContain("C:\\App's Folder");
    await updateWindowsTask({ id: "12345678-1234-1234-1234-123456789abc" }, true);
    expect(Buffer.from(execFile.mock.calls[1][1][3], "base64").toString("utf16le")).toContain("Unregister-ScheduledTask");
  } finally {
    if (previous === undefined) delete process.env.PEBLOY_SCHEDULE_EXECUTABLE; else process.env.PEBLOY_SCHEDULE_EXECUTABLE = previous;
  }
});