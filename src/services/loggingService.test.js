"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function makeTempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bdeploy-logs-"));
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
    delete process.env.ARTIFACTS_DIR;
    delete process.env.LOGS_DIR;
    delete process.env.LOG_ARCHIVE_DIR;
    delete process.env.SCRIPTS_DIR;
    delete process.env.REPORTS_DIR;
    delete process.env.MAX_ACTIVE_TASK_LOGS;
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
