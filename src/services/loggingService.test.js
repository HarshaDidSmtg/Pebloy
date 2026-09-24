"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function makeTempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-logs-"));
  return {
    root,
    logs: path.join(root, "logs"),
    scripts: path.join(root, "scripts"),
    reports: path.join(root, "reports"),
  };
}

describe("loggingService", () => {
  let dirs;
  let service;

  beforeEach(() => {
    jest.resetModules();
    dirs = makeTempDirs();
    process.env.ARTIFACTS_DIR = dirs.root;
    process.env.LOGS_DIR = dirs.logs;
    process.env.SCRIPTS_DIR = dirs.scripts;
    process.env.REPORTS_DIR = dirs.reports;
    service = require("./loggingService");
  });

  afterEach(() => {
    service.flushTaskLogs();
    delete process.env.ARTIFACTS_DIR;
    delete process.env.LOGS_DIR;
    delete process.env.LOG_ARCHIVE_DIR;
    delete process.env.SCRIPTS_DIR;
    delete process.env.REPORTS_DIR;
    delete process.env.MAX_ACTIVE_TASK_LOGS;
    delete process.env.MAX_LOG_FILE_BYTES;
    delete process.env.PEBLOY_RUNTIME_ID;
    fs.rmSync(dirs.root, { recursive: true, force: true });
  });

  it("lists cached summaries without rescanning the log directory on repeated calls", () => {
    const task = service.createTaskLog("Backup", {
      sourceProfileLabel: "DEV",
      selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" }],
    });
    service.finalizeTaskLog(task, "Success", { objectCount: 1 });

    const readdirSpy = jest.spyOn(fs, "readdirSync");

    const first = service.listLogFiles();
    const callsAfterFirst = readdirSpy.mock.calls.length;
    const second = service.listLogFiles();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].taskId).toBe(task.taskId);
    expect(first[0].status).toBe("Success");
    expect(readdirSpy.mock.calls.length).toBe(callsAfterFirst);
    readdirSpy.mockRestore();
  });

  it("reads task details correctly after list caching", () => {
    const task = service.createTaskLog("Deploy", {
      sourceProfileLabel: "DEV",
      destinationProfileLabel: "QA",
      selectedObjects: [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" }],
    });
    service.appendTaskEvent(task, "INFO", "Started work");
    service.finalizeTaskLog(task, "Success", { success: 1 });

    service.listLogFiles();
    const detail = service.getTaskLog(task.taskId);

    expect(detail.taskId).toBe(task.taskId);
    expect(detail.status).toBe("Success");
    expect(detail.events).toHaveLength(1);
    expect(detail.summary.success).toBe(1);
  });

  it.each(["Backup", "Diff", "Deploy"])("includes a tab-separated object list in %s text logs", (taskType) => {
    const selectedObjects = [
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA", definition: "not-in-object-list" },
      { objectType: "VIEW", schemaName: "Reporting", objectName: "MixedCaseView" },
      { objectType: "TABLE", schemaName: "sales", objectName: "Order Items" },
    ];
    const task = service.createTaskLog(taskType, { selectedObjects, logLevel: "ErrorsOnly" });
    const expected = "Selected Objects\nObject Type\tSchema.Object\nPROCEDURE\tdbo.ProcA\nVIEW\tReporting.MixedCaseView\nTABLE\tsales.Order Items\n";
    expect(fs.readFileSync(task.textPath, "utf8")).toContain(expected);
    service.appendTaskEvent(task, "ERROR", "One object failed");
    service.finalizeTaskLog(task, "Failed", { failed: 1 });
    const text = fs.readFileSync(task.textPath, "utf8");
    expect(text).toContain(expected);
    expect(text).not.toContain("not-in-object-list");
    expect(text.indexOf("Selected Objects")).toBeLessThan(text.indexOf("One object failed"));
    expect(service.getTaskLog(task.taskId).selectedObjects).toEqual(selectedObjects);
  });

  it("keeps tab-separated object rows intact for names containing control characters", () => {
    const task = service.createTaskLog("Backup", {
      selectedObjects: [{ objectType: "VIEW", schemaName: "report\ting", objectName: "Line\r\nBreak" }],
    });
    expect(fs.readFileSync(task.textPath, "utf8")).toContain("VIEW\treport ing.Line  Break\n");
    service.finalizeTaskLog(task, "Success");
  });

  it("shows an empty object list when no selection was recorded", () => {
    const task = service.createTaskLog("Backup");
    expect(fs.readFileSync(task.textPath, "utf8")).toContain("Object Type\tSchema.Object\n(No objects recorded)\n");
    service.finalizeTaskLog(task, "Success");
  });

  it("preserves the object list and latest events through repeated byte-bounded trimming", () => {
    process.env.MAX_LOG_FILE_BYTES = "2048";
    jest.resetModules();
    service = require("./loggingService");
    const task = service.createTaskLog("Backup", {
      selectedObjects: [{ objectType: "VIEW", schemaName: "Reporting", objectName: "MixedCase" }],
    });
    for (let index = 0; index < 300; index += 1) {
      service.appendTaskEvent(task, "INFO", `Event ${index}: ${"text ".repeat(50)}`);
    }
    const text = fs.readFileSync(task.textPath, "utf8");
    expect(text).toContain(`TaskId=${task.taskId}`);
    expect(text).toContain("Object Type\tSchema.Object\nVIEW\tReporting.MixedCase");
    expect(text.match(/Selected Objects/g)).toHaveLength(1);
    expect(text).toContain("Event 299:");
    expect(text).not.toContain("Event 0:");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(2048);
    service.finalizeTaskLog(task, "Success");
    expect(service.getTaskLog(task.taskId).events).toHaveLength(300);
  });

  it("checkpoints active events and protects running logs from deletion", () => {
    const task = service.createTaskLog("Deploy");
    service.appendTaskEvent(task, "WARN", "Review object permissions");
    expect(() => service.clearAllLogs()).toThrow("while a task is running");
    service.flushTaskLogs();
    const saved = JSON.parse(fs.readFileSync(task.jsonPath, "utf8"));
    expect(saved.events).toHaveLength(1);
    expect(saved.processId).toBe(process.pid);
    service.finalizeTaskLog(task, "Failed", { password: "not-for-logs" });
    expect(service.getTaskLog(task.taskId).summary.password).toBe("[REDACTED]");
  });

  it("detects an abandoned runtime even when its process ID has been reused", () => {
    process.env.PEBLOY_RUNTIME_ID = "old-owner";
    const task = service.createTaskLog("Deploy");
    expect(JSON.parse(fs.readFileSync(task.jsonPath, "utf8")).processId).toBe(process.pid);
    jest.resetModules();
    process.env.PEBLOY_RUNTIME_ID = "new-exclusive-owner";
    service = require("./loggingService");
    const [entry] = service.listLogFiles();
    expect(entry.status).toBe("Interrupted");
    expect(entry.summary.error).toContain("outcome is unknown");
  });

  it("marks tasks owned by a stopped process as interrupted without claiming rollback", () => {
    const task = service.createTaskLog("Deploy");
    const saved = JSON.parse(fs.readFileSync(task.jsonPath, "utf8"));
    saved.processId = 2147483647;
    fs.writeFileSync(task.jsonPath, JSON.stringify(saved));
    jest.resetModules();
    service = require("./loggingService");
    const [entry] = service.listLogFiles();
    expect(entry.status).toBe("Interrupted");
    expect(entry.summary.error).toContain("outcome is unknown");
  });

  it("includes text path and readiness defaults in log summaries", () => {
    const task = service.createTaskLog("Backup", {
      sourceProfileLabel: "DEV",
      selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" }],
    });
    service.finalizeTaskLog(task, "Success", { objectCount: 1 });

    const [summary] = service.listLogFiles();

    expect(summary.textPath).toBe(task.textPath);
    expect(summary.jsonPath).toBe(task.jsonPath);
    expect(summary.selectionReadiness).toEqual({
      sorting: "Ready",
      ordering: "Ready",
      filtering: "Ready",
    });
  });

  it("suppresses consecutive duplicate events and trims info details for normal logs", () => {
    const task = service.createTaskLog("Deploy", {
      sourceProfileLabel: "DEV",
      logLevel: "Normal",
      selectedObjects: [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" }],
    });

    service.appendTaskEvent(task, "INFO", "Deploying object", { scriptPath: "C:/temp/ProcA.sql" });
    service.appendTaskEvent(task, "INFO", "Deploying object", { scriptPath: "C:/temp/ProcA.sql" });
    service.appendTaskEvent(task, "ERROR", "Deployment failed", { password: "secret", objectName: "ProcA" });
    service.finalizeTaskLog(task, "Failed", { failed: 1 });

    const detail = service.getTaskLog(task.taskId);

    expect(detail.events).toHaveLength(2);
    expect(detail.events[0]).toMatchObject({ level: "INFO", message: "Deploying object", details: null });
    expect(detail.events[1]).toMatchObject({
      level: "ERROR",
      message: "Deployment failed",
      details: { password: "[REDACTED]", objectName: "ProcA" },
    });
  });

  it("stores only warnings and errors for errors-only logs", () => {
    const task = service.createTaskLog("Backup", {
      sourceProfileLabel: "DEV",
      logLevel: "ErrorsOnly",
      selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" }],
    });

    service.appendTaskEvent(task, "INFO", "Backup task started", { objectCount: 1 });
    service.appendTaskEvent(task, "WARN", "One object was skipped", { objectName: "ViewA" });
    service.appendTaskEvent(task, "ERROR", "Backup task failed", { error: "Permission denied" });
    service.finalizeTaskLog(task, "Failed", { failed: 1 });

    const detail = service.getTaskLog(task.taskId);

    expect(detail.logLevel).toBe("ErrorsOnly");
    expect(detail.events).toHaveLength(2);
    expect(detail.events.map((event) => event.level)).toEqual(["WARN", "ERROR"]);
  });

  it("tracks event counts and highest severity in log summaries", () => {
    const task = service.createTaskLog("Deploy", {
      sourceProfileLabel: "DEV",
      logLevel: "Verbose",
      selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" }],
    });

    service.appendTaskEvent(task, "INFO", "Started work");
    service.appendTaskEvent(task, "WARN", "Dependency missing");
    service.appendTaskEvent(task, "ERROR", "Deploy failed", { error: "bad sql" });

    const [runningSummary] = service.listLogFiles();
    expect(runningSummary.eventCounts).toEqual({ INFO: 1, WARN: 1, ERROR: 1 });
    expect(runningSummary.highestLevel).toBe("ERROR");

    service.finalizeTaskLog(task, "Failed", { failed: 1 });

    const [finalSummary] = service.listLogFiles();
    expect(finalSummary.eventCounts).toEqual({ INFO: 1, WARN: 1, ERROR: 1 });
    expect(finalSummary.highestLevel).toBe("ERROR");
  });

  it("requires an unchanged confirmed archive preview and leaves active or malformed logs alone", () => {
    const archive = service.LOG_ARCHIVE_DIR;
    fs.writeFileSync(path.join(archive, "old.json"), JSON.stringify({ status: "Success", completedAt: "2020-01-01T00:00:00Z" }));
    fs.writeFileSync(path.join(archive, "old.log"), "old text");
    fs.writeFileSync(path.join(archive, "running.json"), JSON.stringify({ status: "Running", completedAt: "2020-01-01T00:00:00Z" }));
    fs.writeFileSync(path.join(archive, "bad.json"), "broken");
    const task = service.createTaskLog("Backup");
    const preview = service.previewArchiveCleanup(30);
    expect(preview.files.map((file) => file.name)).toEqual(["old.json", "old.log"]);
    expect(() => service.executeArchiveCleanup(preview.token, false)).toThrow("confirmation");
    fs.appendFileSync(path.join(archive, "old.log"), "changed");
    expect(() => service.executeArchiveCleanup(preview.token, true)).toThrow("Archive changed");
    const fresh = service.previewArchiveCleanup(30);
    expect(service.executeArchiveCleanup(fresh.token, true)).toEqual({ deleted: 2 });
    expect(fs.existsSync(task.jsonPath)).toBe(true);
    expect(fs.readdirSync(archive)).toEqual(["bad.json", "running.json"]);
    expect(() => service.executeArchiveCleanup(fresh.token, true)).toThrow("expired");
    expect(() => service.previewArchiveCleanup(0)).toThrow("Archive age");
    service.finalizeTaskLog(task, "Success");
  });

  it("archives older completed logs once the active log limit is exceeded", () => {
    process.env.MAX_ACTIVE_TASK_LOGS = "2";
    jest.resetModules();
    service = require("./loggingService");

    const first = service.createTaskLog("Backup", { selectedObjects: [] });
    service.finalizeTaskLog(first, "Success", { objectCount: 0 });

    const second = service.createTaskLog("Diff", { selectedObjects: [] });
    service.finalizeTaskLog(second, "Success", { changed: 1 });

    const third = service.createTaskLog("Deploy", { selectedObjects: [] });
    service.finalizeTaskLog(third, "Success", { success: 1 });

    const activeLogs = service.listLogFiles();
    const archivedFiles = fs.readdirSync(service.LOG_ARCHIVE_DIR);

    expect(activeLogs).toHaveLength(2);
    expect(activeLogs.map((item) => item.taskId)).toEqual([third.taskId, second.taskId]);
    expect(archivedFiles.some((name) => name.endsWith(".json"))).toBe(true);
    expect(archivedFiles.some((name) => name.endsWith(".log"))).toBe(true);
  });
});
