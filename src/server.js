const express = require("express");
const fs = require("fs");
const path = require("path");

const {
  listProfiles,
  getProfileWithSecret,
  createProfile,
  updateProfile,
  deleteProfile,
  getProfile,
} = require("./services/profileService");
const { testConnection, runConnectionDiagnostics, discoverObjects, resolveObjectTypes } = require("./services/sqlService");

const { pickFile, pickFolder, openPath } = require("./services/systemService");
const { compareObjects, exportReport } = require("./services/diffService");
const { runBackup } = require("./services/backupService");
const { runDeployment, buildDeploymentPlan } = require("./services/deploymentService");
const {
  createTaskLog,
  appendTaskEvent,
  finalizeTaskLog,
  listLogFiles,
  getTaskLog,
  clearAllLogs,
} = require("./services/loggingService");
const { ensureSqlServerModule } = require("./services/scriptAutomationService");
const { getSettings, saveSettings } = require("./services/settingsService");
const { getAppState, saveAppState } = require("./services/appStateService");
const { performFactoryReset } = require("./services/factoryResetService");
const { buildClientError } = require("./services/errorService");


const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.resolve(__dirname, "..", "public")));

// Fetch unique object types for discover dropdown
app.get("/api/objects/types", async (req, res) => {
  try {
    const profile = requireProfile(req.query.profileId);
    const rows = await discoverObjects(profile, {});
    const types = Array.from(new Set(rows.map(r => r.objectType))).sort();
    res.json(types);
  } catch (error) {
    httpError(res, error);
  }
});

app.get("/api/objects/filters", async (req, res) => {
  try {
    const profile = requireProfile(req.query.profileId);
    const rows = await discoverObjects(profile, {});
    const types = Array.from(new Set(rows.map((row) => row.objectType))).sort();
    const schemas = Array.from(new Set(rows.map((row) => row.schemaName))).sort();
    res.json({ types, schemas });
  } catch (error) {
    httpError(res, error);
  }
});

// Fetch unique schemas for discover dropdown
app.get("/api/objects/schemas", async (req, res) => {
  try {
    const profile = requireProfile(req.query.profileId);
    const rows = await discoverObjects(profile, {});
    const schemas = Array.from(new Set(rows.map(r => r.schemaName))).sort();
    res.json(schemas);
  } catch (error) {
    httpError(res, error);
  }
});

const runningTasks = new Map(); // taskId → { taskType, objectCount, startedAt }
const sseClients = new Set();

function broadcastEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_e) { sseClients.delete(res); }
  }
}

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  sseClients.add(res);
  const keepAlive = setInterval(() => { try { res.write(":ping\n\n"); } catch (_e) {} }, 20000);
  req.on("close", () => { clearInterval(keepAlive); sseClients.delete(res); });
  // Send current running tasks immediately on connect
  for (const [taskId, info] of runningTasks) {
    try { res.write(`event: taskStart\ndata: ${JSON.stringify({ taskId, ...info })}\n\n`); } catch (_e) {}
  }
});

function httpError(res, error, status = 400) {
  const clientError = buildClientError(error, status);
  res.status(clientError.status).json(clientError);
}


// Helper to get profile with secret or throw
function requireProfile(id) {
  const profile = getProfileWithSecret(id);
  if (!profile) throw new Error("Profile not found: " + id);
  return profile;
}

const DEFAULT_PORT = 5089;
const MAX_PORT_SCAN_ATTEMPTS = 50;
const SERVER_INFO_FILE = path.resolve(__dirname, "..", "data", "server-info.json");

function parseDesiredPort(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_PORT;
  }
  return parsed;
}

function writeServerInfo(port) {
  fs.mkdirSync(path.dirname(SERVER_INFO_FILE), { recursive: true });
  fs.writeFileSync(
    SERVER_INFO_FILE,
    JSON.stringify(
      {
        app: "Pebloy",
        port,
        url: `http://localhost:${port}`,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

function listenOnAvailablePort(appInstance, desiredPort) {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    function tryListen(portToTry) {
      if (portToTry > 65535 || attempts >= MAX_PORT_SCAN_ATTEMPTS) {
        reject(new Error(`No available port found starting at ${desiredPort}.`));
        return;
      }

      attempts += 1;
      const server = appInstance.listen(portToTry);

      server.once("listening", () => resolve({ server, port: portToTry }));
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE" || error.code === "EACCES") {
          server.close(() => tryListen(portToTry + 1));
          return;
        }
        reject(error);
      });
    }

    tryListen(desiredPort);
  });
}

app.get("/api/profiles", (req, res) => {
  res.json(listProfiles());
});


app.post("/api/profiles", (req, res) => {
  try {
    const profile = createProfile(req.body || {});
    res.status(201).json(profile);
  } catch (error) {
    httpError(res, error);
  }
});


app.put("/api/profiles/:id", (req, res) => {
  try {
    const profile = updateProfile(req.params.id, req.body || {});
    res.json(profile);
  } catch (error) {
    httpError(res, error);
  }
});

app.delete("/api/profiles/:id", (req, res) => {
  try {
    if (runningTasks.size > 0) {
      return res.status(409).json({
        error: "Cannot delete profile while a task is running.",
      });
    }

    deleteProfile(req.params.id);
    res.status(204).send();
  } catch (error) {
    httpError(res, error);
  }
});

app.post("/api/profiles/:id/test", async (req, res) => {
  try {
    const profile = requireProfile(req.params.id);
    const result = await testConnection(profile);
    res.json({ ok: true, result });
  } catch (error) {
    httpError(res, error);
  }
});

app.post("/api/profiles/:id/diagnostics", async (req, res) => {
  try {
    const profile = requireProfile(req.params.id);
    const result = await runConnectionDiagnostics(profile);
    res.json(result);
  } catch (error) {
    httpError(res, error);
  }
});

app.get("/api/objects", async (req, res) => {
  try {
    const profile = requireProfile(req.query.profileId);
    const rows = await discoverObjects(profile, {
      type: req.query.type,
      schema: req.query.schema,
      search: req.query.search,
    });
    res.json(rows);
  } catch (error) {
    httpError(res, error);
  }
});

app.post("/api/system/pick-folder", async (req, res) => {
  try {
    const selectedPath = await pickFolder(req.body || {});
    res.json({ selectedPath });
  } catch (error) {
    httpError(res, error);
  }
});

app.post("/api/system/pick-file", async (req, res) => {
  try {
    const result = await pickFile(req.body || {});
    res.json(result);
  } catch (error) {
    httpError(res, error);
  }
});

app.post("/api/objects/resolve-types", async (req, res) => {
  try {
    const profile = requireProfile(req.body.profileId);
    const objects = req.body.objects || [];
    const result = await resolveObjectTypes(profile, objects);
    res.json(result);
  } catch (error) {
    httpError(res, error);
  }
});

app.post("/api/diff/compare", async (req, res) => {
  let task;
  try {
    const sourceProfile = requireProfile(req.body.sourceProfileId);
    const destinationProfile = requireProfile(req.body.destinationProfileId);

    task = createTaskLog("Diff", {
      sourceProfileLabel: sourceProfile.profileLabel,
      destinationProfileLabel: destinationProfile.profileLabel,
      logLevel: req.body.logLevel,
      selectedObjects: req.body.selectedObjects || [],
    });
    const diffInfo = { taskType: "Diff", objectCount: (req.body.selectedObjects || []).length, startedAt: new Date().toISOString() };
    runningTasks.set(task.taskId, diffInfo);
    broadcastEvent("taskStart", { taskId: task.taskId, ...diffInfo });

    appendTaskEvent(task, "INFO", "Diff task started");
    const report = await compareObjects(sourceProfile, destinationProfile, req.body.selectedObjects || [], {
      taskId: task.taskId,
      onProgress: (data) => broadcastEvent("taskProgress", { taskId: task.taskId, ...data }),
    });
    appendTaskEvent(task, "INFO", "Diff task completed", report.summary);
    finalizeTaskLog(task, "Success", report.summary);

    broadcastEvent("taskEnd", { taskId: task.taskId, taskType: "Diff", status: "Success", summary: report.summary });
    res.json({ taskId: task.taskId, report, logFilePath: task.textPath });
  } catch (error) {
    if (task) {
      appendTaskEvent(task, "ERROR", "Diff task failed", { error: error.message });
      finalizeTaskLog(task, "Failed", { error: error.message });
      broadcastEvent("taskEnd", { taskId: task.taskId, taskType: "Diff", status: "Failed", error: error.message });
    }
    httpError(res, error);
  } finally {
    if (task) {
      runningTasks.delete(task.taskId);
    }
  }
});

app.post("/api/diff/export", (req, res) => {
  try {
    const ALLOWED_FORMATS = ["md", "html"];
    if (!ALLOWED_FORMATS.includes(req.body.format)) {
      return res.status(400).json({ error: `Invalid export format. Allowed: ${ALLOWED_FORMATS.join(", ")}` });
    }
    const filePath = exportReport(req.body.format, req.body.report);
    res.json({ filePath });
  } catch (error) {
    httpError(res, error);
  }
});

app.post("/api/deploy/plan", (req, res) => {
  try {
    const plan = buildDeploymentPlan(req.body.selectedObjects || []);
    res.json({ plan });
  } catch (error) {
    httpError(res, error);
  }
});

app.get("/api/profiles/export", (req, res) => {
  const profiles = listProfiles();
  res.json(profiles);
});

app.post("/api/profiles/import", async (req, res) => {
  const incoming = req.body.profiles || [];
  const created = [];
  const errors = [];
  for (const p of incoming) {
    try {
      const newProfile = createProfile({
        profileLabel: p.profileLabel || "Imported Connection",
        serverName: p.serverName || "",
        databaseName: p.databaseName || "",
        authenticationType: p.authenticationType || "Windows",
        username: p.username || "",
        password: "",
        environmentTag: p.environmentTag || "",
      });
      created.push(newProfile);
    } catch (e) {
      errors.push({ profileLabel: p.profileLabel, error: e.message });
    }
  }
  res.json({ created: created.length, errors });
});

app.post("/api/backup/run", async (req, res) => {
  let task;
  try {
    const sourceProfile = requireProfile(req.body.sourceProfileId);
    if (!(req.body.selectedObjects || []).length) {
      throw new Error("Backup requires at least one selected object.");
    }
    task = createTaskLog("Backup", {
      sourceProfileLabel: sourceProfile.profileLabel,
      logLevel: req.body.logLevel,
      selectedObjects: req.body.selectedObjects || [],
    });
    const backupInfo = { taskType: "Backup", objectCount: (req.body.selectedObjects || []).length, startedAt: new Date().toISOString() };
    runningTasks.set(task.taskId, backupInfo);
    broadcastEvent("taskStart", { taskId: task.taskId, ...backupInfo });

    appendTaskEvent(task, "INFO", "Backup task started");
    const result = await runBackup(sourceProfile, req.body.selectedObjects || [], req.body.options || {}, task, (data) => {
      broadcastEvent("taskProgress", { taskId: task.taskId, ...data });
    });
    appendTaskEvent(task, "INFO", "Backup task completed", result);
    finalizeTaskLog(task, "Success", result);

    broadcastEvent("taskEnd", { taskId: task.taskId, taskType: "Backup", status: "Success", summary: { objectCount: result.objectCount } });
    res.json({
      taskId: task.taskId,
      selectedObjectCount: (req.body.selectedObjects || []).length,
      ...result,
      logFilePath: task.textPath,
    });
  } catch (error) {
    if (task) {
      appendTaskEvent(task, "ERROR", "Backup task failed", { error: error.message });
      finalizeTaskLog(task, "Failed", { error: error.message });
      broadcastEvent("taskEnd", { taskId: task.taskId, taskType: "Backup", status: "Failed", error: error.message });
    }
    httpError(res, error);
  } finally {
    if (task) {
      runningTasks.delete(task.taskId);
    }
  }
});

app.post("/api/deploy/run", async (req, res) => {
  let task;
  try {
    const sourceProfile = requireProfile(req.body.sourceProfileId);
    const destinationProfile = requireProfile(req.body.destinationProfileId);

    if (
      sourceProfile.serverName === destinationProfile.serverName &&
      sourceProfile.databaseName === destinationProfile.databaseName &&
      !req.body.allowSameSourceDestination
    ) {
      throw new Error("Source and destination are identical. Confirm override to proceed.");
    }

    task = createTaskLog("Deploy", {
      sourceProfileLabel: sourceProfile.profileLabel,
      destinationProfileLabel: destinationProfile.profileLabel,
      logLevel: req.body.logLevel,
      selectedObjects: req.body.selectedObjects || [],
    });
    const deployInfo = { taskType: "Deploy", objectCount: (req.body.selectedObjects || []).length, startedAt: new Date().toISOString() };
    runningTasks.set(task.taskId, deployInfo);
    broadcastEvent("taskStart", { taskId: task.taskId, ...deployInfo });

    appendTaskEvent(task, "INFO", "Deployment task started");

    const result = await runDeployment({
      sourceProfile,
      destinationProfile,
      selectedObjects: req.body.selectedObjects || [],
      mode: req.body.mode || "ExecuteDirectly",
      continueOnError: Boolean(req.body.continueOnError),
      options: req.body.options || {},
      task,
      logEvent: (level, message, details) => appendTaskEvent(task, level, message, details),
      broadcastProgress: (event, data) => broadcastEvent(event, data),
    });

    const summary = {
      total: result.results.length,
      success: result.results.filter((x) => x.status === "Success").length,
      rolledBack: result.results.filter((x) => x.status === "RolledBack").length,
      failed: result.results.filter((x) => x.status === "Failed").length,
      skipped: result.results.filter((x) => x.status === "Skipped").length,
    };

    const overallStatus = summary.failed > 0 ? "Failed" : "Success";

    appendTaskEvent(task, "INFO", "Deployment task completed", summary);
    finalizeTaskLog(task, overallStatus, summary);
    broadcastEvent("taskEnd", { taskId: task.taskId, taskType: "Deploy", status: overallStatus, summary });

    res.json({
      taskId: task.taskId,
      mode: req.body.mode,
      executionPlan: result.plan,
      itemResults: result.results,
      generatedRoot: result.generatedRoot || null,
      buildPathFile: result.buildPathFile || null,
      rollbackApplied: Boolean(result.rollbackApplied),
      summary,
      logFilePath: task.textPath,
    });
  } catch (error) {
    if (task) {
      appendTaskEvent(task, "ERROR", "Deployment task failed", { error: error.message });
      finalizeTaskLog(task, "Failed", { error: error.message });
      broadcastEvent("taskEnd", { taskId: task.taskId, taskType: "Deploy", status: "Failed", error: error.message });
    }
    httpError(res, error);
  } finally {
    if (task) {
      runningTasks.delete(task.taskId);
    }
  }
});

app.get("/api/logs", (req, res) => {
  res.json(listLogFiles());
});

app.delete("/api/logs", (req, res) => {
  try {
    const result = clearAllLogs();
    res.json(result);
  } catch (error) {
    httpError(res, error);
  }
});

app.get("/api/tasks/:taskId", (req, res) => {
  const task = getTaskLog(req.params.taskId);
  if (!task) {
    return httpError(res, new Error("Task not found."), 404);
  }
  res.json(task);
});

app.post("/api/logs/:taskId/open", async (req, res) => {
  try {
    const task = getTaskLog(req.params.taskId);
    if (!task) {
      return httpError(res, new Error("Task not found."), 404);
    }

    const logEntry = listLogFiles().find((item) => item.taskId === req.params.taskId);
    const openCandidates = [logEntry?.textPath, logEntry?.jsonPath].filter((candidate) => candidate && fs.existsSync(candidate));
    if (!openCandidates.length) {
      return httpError(res, new Error("Log file path not found."), 404);
    }

    await openPath(openCandidates[0], { promptForApp: true });
    res.json({ opened: true, path: openCandidates[0], promptForApp: true });
  } catch (error) {
    httpError(res, error);
  }
});

app.get("/api/settings", (req, res) => {
  res.json(getSettings());
});

app.put("/api/settings", (req, res) => {
  try {
    const updated = saveSettings(req.body || {});
    res.json(updated);
  } catch (error) {
    httpError(res, error);
  }
});

app.get("/api/app-state", (req, res) => {
  res.json(getAppState());
});

app.put("/api/app-state", (req, res) => {
  try {
    const updated = saveAppState(req.body || {});
    res.json(updated);
  } catch (error) {
    httpError(res, error);
  }
});

app.post("/api/factory-reset", (req, res) => {
  try {
    if (runningTasks.size > 0) {
      return httpError(res, new Error("Cannot run factory reset while a task is running."), 409);
    }

    const result = performFactoryReset();
    res.json(result);
  } catch (error) {
    httpError(res, error);
  }
});

app.get("/api/data-export", (req, res) => {
  try {
    res.json({
      profiles: listProfiles(),
      settings: getSettings(),
      appState: getAppState(),
    });
  } catch (error) {
    httpError(res, error);
  }
});

app.post("/api/data-import", (req, res) => {
  try {
    const { profiles = [], settings, appState } = req.body || {};
    let created = 0;
    const errors = [];
    for (const p of profiles) {
      try {
        createProfile(p);
        created++;
      } catch (e) {
        errors.push({ label: p.profileLabel || p.id, error: e.message });
      }
    }
    if (settings && typeof settings === "object") saveSettings(settings);
    if (appState && typeof appState === "object") saveAppState(appState);
    res.json({ restored: true, profilesImported: created, errors });
  } catch (error) {
    httpError(res, error);
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    app: "Pebloy",
    version: "1.0.0",
    runningTasks: runningTasks.size,
    profiles: listProfiles().length,
    port: req.socket.localPort,
  });
});

const desiredPort = parseDesiredPort(process.env.PORT);

listenOnAvailablePort(app, desiredPort)
  .then(({ port }) => {
    writeServerInfo(port);
    const fallbackMessage = port === desiredPort ? "" : ` (requested ${desiredPort}; selected next available port)`;
    console.log(`Pebloy listening on http://localhost:${port}${fallbackMessage}`);
    ensureSqlServerModule()
      .then(() => console.log("SqlServer PowerShell module ready."))
      .catch((err) => console.warn(`SqlServer module setup: ${err.message}`));
  })
  .catch((error) => {
    console.error(`Pebloy failed to start: ${error.message}`);
    process.exit(1);
  });
