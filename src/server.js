const express = require("express");
const fs = require("fs");
const path = require("path");
const packageMetadata = require("../package.json");
const { randomUUID } = require("crypto");
const { acquireRuntimeLocks } = require("./services/runtimeLockService");
const { STARTUP_FAILURE_PREFIX } = require("./services/startupFailure");

const {
  listProfiles,
  getProfileWithSecret,
  createProfile,
  updateProfile,
  deleteProfile,
  getProfile,
} = require("./services/profileService");
const { testConnection, runConnectionDiagnostics, discoverObjects, resolveObjectTypes, fetchObjectDependencies, buildObjectDependenciesQuery } = require("./services/sqlService");

const { pickFile, pickFolder, openPath } = require("./services/systemService");
const { compareObjects, exportReport, formatMarkdownReport } = require("./services/diffService");
const { runBackup } = require("./services/backupService");
const { runDeployment, buildDerivedDeploymentPlan, deploymentPlanFingerprint } = require("./services/deploymentService");
const { reconcileObjects } = require("./services/reconciliationService");
const { buildMigrationPrep } = require("./services/migrationPrepService");
const { loadFolderSource } = require("./services/folderSourceService");
const { buildBatchPlan, runDeploymentBatch } = require("./services/deploymentBatchService");
const schedules = require("./services/scheduleService");
const windowsSchedules = require("./services/windowsScheduleService");
const {
  createTaskLog,
  appendTaskEvent,
  finalizeTaskLog,
  flushTaskLogs,
  listLogFiles,
  getTaskLog,
  clearAllLogs,
  previewArchiveCleanup,
  executeArchiveCleanup,
  LOG_DIR,
} = require("./services/loggingService");
const { ensureSqlServerModule, getSqlServerModuleStatus } = require("./services/scriptAutomationService");
const { getSettings, saveSettings } = require("./services/settingsService");
const { getAppState, saveAppState } = require("./services/appStateService");
const { performFactoryReset } = require("./services/factoryResetService");
const { buildClientError } = require("./services/errorService");
const { LOOPBACK_HOST, isLoopbackRequest, isLocalBrowserRequest, isAuthorizedMutation } = require("./services/formatterAccessService");


const { formatInteractiveSql, getFormatterCapabilities } = require("./services/formatterService");

const app = express();
const requestToken = randomUUID();
let shuttingDown = false;
let schedulerRunning = false;
let finishShutdown = () => {};
app.disable("x-powered-by");

// The server binds to loopback, but a remote page can still reach it via DNS rebinding
// or a cross-site form post; Host/Origin are what actually distinguish those.
app.use((req, res, next) => {
  if (shuttingDown) return res.status(503).json({ error: "Pebloy is shutting down. Wait for active workflows to finish." });
  if (isLocalBrowserRequest(req)) {
    return next();
  }
  res.status(403).json({ error: "Pebloy accepts local requests only.", status: 403 });
});

app.get("/api/session", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ token: requestToken });
});

app.use((req, res, next) => {
  if (!isAuthorizedMutation(req, requestToken)) {
    return res.status(403).json({ error: "Session authorization required. Reload Pebloy before retrying." });
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.use(express.json({ limit: "20mb" }));
app.use("/vendor/monaco", express.static(path.resolve(__dirname, "..", "node_modules", "monaco-editor", "min")));
app.use(express.static(path.resolve(__dirname, "..", "public")));

app.get("/api/dashboard", (req, res) => {
  try {
    const profiles = listProfiles();
    const logs = listLogFiles();
    const recent = logs.slice(0, 5);
    const byType = {};
    for (const log of logs) {
      byType[log.taskType] = (byType[log.taskType] || 0) + 1;
    }
    res.json({
      profileCount: profiles.length,
      totalTasks: logs.length,
      taskBreakdown: byType,
      recentTasks: recent.map((l) => ({
        taskId: l.taskId,
        taskType: l.taskType,
        status: l.status,
        startedAt: l.startedAt,
        objectCount: l.objectCount || 0,
        sourceProfileLabel: l.sourceProfileLabel,
        destinationProfileLabel: l.destinationProfileLabel,
      })),
    });
  } catch (error) {
    httpError(res, error);
  }
});

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
const protectedWorkflows = new Set(["/api/backup/run", "/api/deploy/run", "/api/deploy/batch/run", "/api/diff/compare", "/api/data-import"]);
const selectionWorkflows = new Set(["/api/backup/run", "/api/deploy/run", "/api/deploy/plan", "/api/deploy/batch/plan", "/api/deploy/batch/run", "/api/diff/compare"]);
const metadataWorkflows = new Set(["/api/objects/resolve-types", "/api/objects/dependencies", "/api/objects/dependencies/query"]);const supportedObjectTypes = new Set(["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SYNONYM", "SEQUENCE", "USER_DEFINED_TYPE"]);

app.use((req, res, next) => {
  if (req.method === "POST" && metadataWorkflows.has(req.path)) {
    const objects = req.body?.objects;
    if (!Array.isArray(objects) || objects.length < 1 || objects.length > 5000 || objects.some((object) =>
      !object || typeof object.objectName !== "string" || !object.objectName.trim() || object.objectName.length > 128 || /[\r\n\0]/.test(object.objectName) ||
      (object.schemaName != null && (typeof object.schemaName !== "string" || object.schemaName.length > 128 || /[\r\n\0]/.test(object.schemaName))))) {
      return res.status(400).json({ error: "Metadata requests require 1 to 5000 objects with valid names (maximum 128 characters)." });
    }
  }
  if (req.method === "POST" && req.path === "/api/data-import") {
    const profiles = req.body?.profiles ?? [];
    if (!Array.isArray(profiles) || profiles.length > 100 || profiles.some((profile) => !profile || typeof profile !== "object" || Array.isArray(profile))) {
      return res.status(400).json({ error: "Import accepts at most 100 profile records per request." });
    }
  }
  if (req.method === "POST" && selectionWorkflows.has(req.path)) {
    const objects = req.body?.selectedObjects;
    if (!Array.isArray(objects) || objects.length < 1 || objects.length > 5000 || objects.some((object) =>
      !object || !supportedObjectTypes.has(object.objectType) ||
      [object.schemaName, object.objectName].some((name) => typeof name !== "string" || !name.trim() || name.length > 128 || /[\r\n\0]/.test(name)))) {
      return res.status(400).json({ error: "Supply 1 to 5000 objects with supported types and valid schema/object names (maximum 128 characters)." });
    }
    if (req.path.startsWith("/api/deploy/") && [req.body.engine, req.body.options?.engine].some((engine) => engine && engine !== "Legacy")) {
      return res.status(400).json({ error: "Only Legacy deployment is supported. DacFx is available for comparison and validation." });
    }
    if (req.path === "/api/deploy/run" && !["ExecuteDirectly", "Rollback", "FormatAndExecuteSource", "DryRun"].includes(req.body.mode)) {
      return res.status(400).json({ error: "Choose a supported execution mode before deploying." });
    }
    if (req.path === "/api/deploy/run" && req.body.mode === "FormatAndExecuteSource" &&
        (!req.body.sourceProfileId || req.body.destinationProfileId !== req.body.sourceProfileId || !req.body.options?.confirmedSourceDatabase)) {
      return res.status(400).json({ error: "Format & Execute requires the same source/target profile and explicit source database confirmation." });
    }
  }
  if (req.method === "POST" && protectedWorkflows.has(req.path) && runningTasks.size) {
    return res.status(409).json({ error: "A database workflow is already running. Wait for it to finish before starting another." });
  }
  next();
});

function broadcastEvent(event, data) {
  const task = runningTasks.get(data.taskId);
  if (task && event === "taskProgress") {
    task.percent = data.percent;
    task.progressLabel = data.operation;
  }
  if (task && event === "deployProgress") {
    task.objectProgress ||= Object.create(null);
    task.objectProgress[JSON.stringify([data.objectType, data.schemaName, data.objectName])] = data;
  }
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { if (!res.write(payload)) { sseClients.delete(res); res.destroy(); } }
    catch (_e) { sseClients.delete(res); }
  }
}

app.get("/api/events", (req, res) => {
  if (sseClients.size >= 16) return res.status(429).json({ error: "Too many event connections. Close unused Pebloy tabs." });
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  sseClients.add(res);
  const keepAlive = setInterval(() => { try { res.write(":ping\n\n"); } catch (_e) {} }, 20000);
  req.on("close", () => { clearInterval(keepAlive); sseClients.delete(res); });
  const tasks = [...runningTasks].map(([taskId, info]) => ({ ...info, taskId, objectProgress: Object.values(info.objectProgress || {}) }));
  res.write(`event: snapshot\ndata: ${JSON.stringify({ tasks })}\n\n`);
});

function httpError(res, error, status = 400) {
  const clientError = buildClientError(error, status);
  res.status(clientError.status).json(clientError);
}

function isContainedIn(candidatePath, baseDir) {
  const base = path.resolve(baseDir);
  const target = path.resolve(String(candidatePath));
  return target === base || target.startsWith(base + path.sep);
}

function ensureLoopbackFormatterRequest(req, res) {
  if (isLoopbackRequest(req)) {
    return true;
  }

  httpError(res, new Error("Pebloy formatter endpoints are local-only and accept loopback requests only."), 403);
  return false;
}


// Helper to get profile with secret or throw
function requireProfile(id) {
  const profile = getProfileWithSecret(id);
  if (!profile) throw new Error("Profile not found: " + id);
  if (profile.secretError) throw new Error(profile.secretError);
  return profile;
}

const DEFAULT_PORT = 5089;
const MAX_PORT_SCAN_ATTEMPTS = 50;
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "..", "data");
const SERVER_INFO_FILE = path.join(DATA_DIR, "server-info.json");

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
        url: `http://${LOOPBACK_HOST}:${port}`,
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
  const server = appInstance.listen(portToTry, LOOPBACK_HOST);

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

app.post("/api/objects/dependencies", async (req, res) => {
  try {
    const profile = requireProfile(req.body.profileId);
    const objects = req.body.objects || [];
    const dependencies = await fetchObjectDependencies(profile, objects, {
      dateWindow: req.body.dateWindow || null,
    });
    res.json({ requestedCount: objects.length, dependencies });
  } catch (error) {
    httpError(res, error);
  }
});

app.post("/api/objects/dependencies/query", async (req, res) => {
  try {
    requireProfile(req.body.profileId);
    const objects = req.body.objects || [];
    const query = buildObjectDependenciesQuery(objects, {
      dateWindow: req.body.dateWindow || null,
    });
    res.json({ requestedCount: objects.length, query });
  } catch (error) {
    httpError(res, error);
  }
});

async function requireSource(body) {
  return body.sourceFolder ? loadFolderSource(body.sourceFolder) : requireProfile(body.sourceProfileId);
}

app.post("/api/sources/folder", async (req, res) => {
  try {
    const source = await loadFolderSource(req.body.folderPath);
    res.json({ folderPath: source.folderPath, fingerprint: source.folderFingerprint,
      objects: source.folderScripts.map(({ objectType, schemaName, objectName }) => ({ objectType, schemaName, objectName })) });
  } catch (error) { httpError(res, error); }
});

app.post("/api/diff/compare", async (req, res) => {
  let task;
  try {
    const sourceProfile = await requireSource(req.body);
    if (runningTasks.size) throw new Error("A database workflow is already running.");
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
      engine: req.body.engine,
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
      finishShutdown();
    }
  }
});

app.post("/api/diff/clipboard", (req, res) => {
  try { res.json({ text: formatMarkdownReport(req.body.report) }); }
  catch (error) { httpError(res, error); }
});

app.post("/api/diff/export", (req, res) => {
  try {
    const ALLOWED_FORMATS = ["md", "html", "html-highlighted", "json"];
    if (!ALLOWED_FORMATS.includes(req.body.format)) {
      return res.status(400).json({ error: `Invalid export format. Allowed: ${ALLOWED_FORMATS.join(", ")}` });
    }
    const filePath = exportReport(req.body.format, req.body.report);
    res.json({ filePath });
  } catch (error) {
    httpError(res, error);
  }
});

app.post("/api/deploy/plan", async (req, res) => {
  try {
    const sourceProfile = await requireSource(req.body);
    const destinationProfile = requireProfile(req.body.destinationProfileId);
    const mode = req.body.mode || "ExecuteDirectly";
    if (!["ExecuteDirectly", "Rollback", "FormatAndExecuteSource", "DryRun"].includes(mode)) throw new Error("Invalid deployment mode.");
    if (mode !== "FormatAndExecuteSource" && sourceProfile.serverName === destinationProfile.serverName &&
        sourceProfile.databaseName === destinationProfile.databaseName) throw new Error("Source and target are identical. Choose a different target connection.");
    const plan = await buildDerivedDeploymentPlan(sourceProfile, req.body.selectedObjects || [], undefined, mode);
    const describeConnection = (profile) => ({ id: profile.id, profileLabel: profile.profileLabel,
      serverName: profile.serverName, databaseName: profile.databaseName, environmentTag: profile.environmentTag, kind: profile.kind, folderPath: profile.folderPath });
    res.json({ plan, fingerprint: deploymentPlanFingerprint(plan, sourceProfile, destinationProfile, mode),
      sourceConnection: describeConnection(sourceProfile), targetConnection: describeConnection(destinationProfile) });
  } catch (error) {
    httpError(res, error);
  }
});

async function resolveBatchRequest(body) {
  if (!Array.isArray(body.targetProfileIds) || !body.targetProfileIds.length || body.targetProfileIds.length > 20) throw new Error("Choose 1 to 20 target connections.");
  return { sourceProfile: await requireSource(body), targetProfiles: body.targetProfileIds.map(requireProfile),
    selectedObjects: body.selectedObjects, mode: body.mode, continueOnError: Boolean(body.continueOnError),
    continueTargetsOnError: Boolean(body.continueTargetsOnError), options: body.options || {}, logLevel: body.logLevel };
}

app.post("/api/deploy/batch/plan", async (req, res) => {
  try { res.json(await buildBatchPlan(await resolveBatchRequest(req.body))); }
  catch (error) { httpError(res, error); }
});

async function executeBatchWorkflow(body) {
  if (runningTasks.size) throw new Error("A database workflow is already running. Wait for it to finish.");
  if (!/^[a-f0-9]{64}$/.test(body.options?.confirmedBatchFingerprint || "")) throw new Error("Review and confirm the multi-target plan first.");
  const task = createTaskLog("Deploy", { sourceProfileLabel: body.sourceFolder || body.sourceProfileId,
    destinationProfileLabel: "Multiple targets", selectedObjects: body.selectedObjects, logLevel: body.logLevel });
  const info = { taskType: "Deploy", objectCount: body.selectedObjects.length, startedAt: new Date().toISOString() };
  runningTasks.set(task.taskId, info);
  broadcastEvent("taskStart", { taskId: task.taskId, ...info });
  try {
    const request = await resolveBatchRequest(body);
    const result = await runDeploymentBatch({ ...request, onProgress: (event, data) => {
      if (event === "targetStart") appendTaskEvent(task, "INFO", `Target ${data.index}/${data.total}: ${data.target.profileLabel}`, { targetTaskId: data.taskId });
      else broadcastEvent(event, { ...data, targetTaskId: data.taskId, taskId: task.taskId,
        ...(event === "taskProgress" ? { operation: `${data.targetProfileLabel}: ${data.operation}` } : {}) });
    } });
    const status = result.summary.failed ? "Failed" : result.summary.reviewRequired ? "ReviewRequired" : "Success";
    appendTaskEvent(task, "INFO", "Target batch completed", { summary: result.summary, targets: result.targets.map((target) => ({ target: target.targetConnection.profileLabel, taskId: target.taskId, status: target.status })) });
    finalizeTaskLog(task, status, result.summary);
    broadcastEvent("taskEnd", { taskId: task.taskId, taskType: "Deploy", status, summary: result.summary });
    return { ...result, taskId: task.taskId, logFilePath: task.textPath, mode: body.mode };
  } catch (error) {
    appendTaskEvent(task, "ERROR", "Target batch failed", { error: error.message });
    finalizeTaskLog(task, "Failed", { error: error.message });
    broadcastEvent("taskEnd", { taskId: task.taskId, taskType: "Deploy", status: "Failed", error: error.message });
    throw error;
  } finally { runningTasks.delete(task.taskId); finishShutdown(); }
}

app.post("/api/deploy/batch/run", async (req, res) => {
  try { res.json(await executeBatchWorkflow(req.body)); }
  catch (error) { httpError(res, error); }
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
        groupName: p.groupName || "",
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
    const sourceProfile = await requireSource(req.body);
    if (runningTasks.size) throw new Error("A database workflow is already running.");
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
      finishShutdown();
    }
  }
});

app.post("/api/deploy/run", async (req, res) => {
  let task;
  try {
    if (!/^[a-f0-9]{64}$/.test(req.body.options?.confirmedPlanFingerprint || "")) {
      return httpError(res, new Error("Review and confirm the deployment plan before running deployment."), 400);
    }
    const sourceProfile = await requireSource(req.body);
    if (runningTasks.size) throw new Error("A database workflow is already running.");
    const destinationProfile = requireProfile(req.body.destinationProfileId);
    const formatInSource = req.body.mode === "FormatAndExecuteSource";
    if (formatInSource && req.body.options?.confirmedSourceDatabase !== sourceProfile.databaseName) {
      throw new Error("The source database changed. Confirm it again before executing.");
    }

    if (
      !formatInSource &&
      sourceProfile.serverName === destinationProfile.serverName &&
      sourceProfile.databaseName === destinationProfile.databaseName
    ) {
      throw new Error("Source and destination are identical. Deployment was not started.");
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
      mode: req.body.mode,
      continueOnError: Boolean(req.body.continueOnError),
      options: { ...(req.body.options || {}), engine: req.body.engine || req.body.options?.engine || "Legacy" },
      task,
      logEvent: (level, message, details) => appendTaskEvent(task, level, message, details),
      broadcastProgress: (event, data) => broadcastEvent(event, data),
    });

    const summary = {
      total: result.results.length,
      success: result.results.filter((x) => x.status === "Success").length,
      rolledBack: result.results.filter((x) => x.status === "RolledBack").length,
      failed: result.results.filter((x) => x.status === "Failed").length,
      reviewRequired: result.results.filter((x) => x.status === "ReviewRequired").length,
      skipped: result.results.filter((x) => x.status === "Skipped").length,
    };

    const overallStatus = summary.failed > 0 ? "Failed" : summary.reviewRequired > 0 ? "ReviewRequired" : "Success";

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
      generationWarnings: result.generationWarnings || [],
      dacfxValidation: result.dacfxValidation || { enabled: false },
      engine: result.engine || req.body.engine || null,
      deployScriptPath: result.deployScriptPath || null,
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
      finishShutdown();
    }
  }
});

app.post("/api/logs/archive/preview", (req, res) => {
  try { res.json(previewArchiveCleanup(req.body.olderThanDays)); }
  catch (error) { httpError(res, error); }
});

app.post("/api/logs/archive/cleanup", (req, res) => {
  try { res.json(executeArchiveCleanup(req.body.token, req.body.confirmed)); }
  catch (error) { httpError(res, error); }
});

app.get("/api/logs", (req, res) => {
  res.json(listLogFiles());
});

app.delete("/api/logs", (req, res) => {
  try {
    if (runningTasks.size) return httpError(res, new Error("Cannot clear logs while a task is running."), 409);
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

app.post("/api/deploy/migration-prep", async (req, res) => {
  try {
    const destinationProfile = requireProfile(req.body.destinationProfileId);
    const objects = req.body.selectedObjects || [];
    if (!Array.isArray(objects) || !objects.length || objects.length > 500) {
      throw new Error("Supply 1 to 500 objects that need a reviewed migration.");
    }
    const result = await buildMigrationPrep(destinationProfile, objects, { taskId: req.body.taskId });
    res.json({ outputPath: result.outputPath, objectCount: result.objectCount,
      protectedObjectCount: result.protectedObjectCount, executed: false });
  } catch (error) {
    httpError(res, error);
  }
});

app.post("/api/tasks/:taskId/reconcile", async (req, res) => {  try {
    const task = getTaskLog(req.params.taskId);
    if (!task) {
      return httpError(res, new Error("Task not found."), 404);
    }
    const sourceProfile = requireProfile(req.body.sourceProfileId);
    const destinationProfile = requireProfile(req.body.destinationProfileId);
    const result = await reconcileObjects(sourceProfile, destinationProfile, task.selectedObjects || []);
    res.json({ taskId: task.taskId, taskStatus: task.status, ...result });
  } catch (error) {
    httpError(res, error);
  }
});

app.post("/api/logs/:taskId/open", async (req, res) => {
  try {
    const task = getTaskLog(req.params.taskId);
    if (!task) {
      return httpError(res, new Error("Task not found."), 404);
    }

    const logEntry = listLogFiles().find((item) => item.taskId === req.params.taskId);
    const openCandidates = [logEntry?.textPath, logEntry?.jsonPath]
      .filter((candidate) => candidate && isContainedIn(candidate, LOG_DIR))
      .filter((candidate) => fs.existsSync(candidate));
    if (!openCandidates.length) {
      return httpError(res, new Error("Log file path not found."), 404);
    }

    await openPath(openCandidates[0], { promptForApp: true });
    res.json({ opened: true, path: openCandidates[0], promptForApp: true });
  } catch (error) {
    httpError(res, error);
  }
});

app.post("/api/format", async (req, res) => {
  if (!ensureLoopbackFormatterRequest(req, res)) {
    return;
  }

  try {
    const sql = String(req.body?.sql ?? "");
    const startedAt = Date.now();
    const result = await formatInteractiveSql(sql, {
      dialect: req.body?.dialect,
      mode: req.body?.mode,
      options: req.body?.options,
    });
    res.json({
      formatted: result.formatted,
      dialect: result.dialect,
      normalization: result.normalization,
      options: result.options,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    httpError(res, error);
  }
});

app.get("/api/format/capabilities", (req, res) => {
  if (!ensureLoopbackFormatterRequest(req, res)) {
    return;
  }

  res.json(getFormatterCapabilities());
});

app.post("/api/formatter/save", (req, res) => {
  if (!ensureLoopbackFormatterRequest(req, res)) {
    return;
  }

  httpError(
    res,
    new Error("Formatter Save only overwrites the .sql or .txt file opened or created in the current Pebloy desktop session. Use Save As for any new path."),
    409
  );
});

app.get("/api/settings", (req, res) => {
  res.json(getSettings());
});

function schedulesEnabled() {
  return getSettings().features.schedules === true;
}

function assertSchedulesCanBeDisabled(partial) {
  if (partial?.features?.schedules === false && schedules.readSchedules().length) {
    throw new Error("Delete saved schedules before turning off Scheduled Deployments so their Windows wake-up tasks are removed.");
  }
}

app.put("/api/settings", (req, res) => {
  try {
    assertSchedulesCanBeDisabled(req.body);
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
    if (schedules.readSchedules().length) throw new Error("Delete saved schedules before factory reset so their Windows wake-up tasks are removed.");

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
    if (settings && typeof settings === "object") {
      assertSchedulesCanBeDisabled(settings);
      saveSettings(settings);
    }
    if (appState && typeof appState === "object") saveAppState(appState);
    res.json({ restored: true, profilesImported: created, errors });
  } catch (error) {
    httpError(res, error);
  }
});

app.get("/api/prerequisites/sqlserver", (req, res) => res.json(getSqlServerModuleStatus()));
app.post("/api/prerequisites/sqlserver/install", async (req, res) => {
  try { await ensureSqlServerModule(); res.json(getSqlServerModuleStatus()); }
  catch (error) { httpError(res, error); }
});

app.get("/api/schedules", (req, res) => {
  try { res.json({ enabled: schedulesEnabled(), items: schedules.readSchedules(), capabilities: windowsSchedules.capabilities(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }); }
  catch (error) { httpError(res, error); }
});

async function saveReviewedSchedule(req, res) {
  let record;
  try {
    if (!schedulesEnabled()) throw new Error("Scheduled Deployments are turned off. Enable them in Settings first.");
    const request = schedules.cleanRequest(req.body.request);
    const reviewed = await buildBatchPlan(await resolveBatchRequest(request));
    if (reviewed.fingerprint !== request.options.confirmedBatchFingerprint) throw new Error("The scheduled plan changed. Review and confirm it again.");
    const previous = req.params.id ? schedules.readSchedules().find((item) => item.id === req.params.id) : null;
    record = schedules.saveSchedule({ ...req.body, request }, req.params.id || null, Date.now(), false);
    if (record.wakeApplication) await windowsSchedules.updateWindowsTask(record);
    else if (previous?.wakeApplication) await windowsSchedules.updateWindowsTask(previous, true);
    res.json(schedules.activateSchedule(record.id, record.updatedAt));
  } catch (error) {
    if (record) schedules.pauseSchedule(record.id, error.message);
    httpError(res, error);
  }
}
app.post("/api/schedules", saveReviewedSchedule);
app.put("/api/schedules/:id", saveReviewedSchedule);
app.post("/api/schedules/:id/pause", async (req, res) => {
  try {
    const record = schedules.pauseSchedule(req.params.id);
    if (record.wakeApplication) await windowsSchedules.updateWindowsTask(record, true);
    res.json(record);
  } catch (error) { httpError(res, error); }
});
app.delete("/api/schedules/:id", async (req, res) => {
  try {
    if (req.body.confirmed !== true) throw new Error("Confirm schedule deletion first.");
    const record = schedules.readSchedules().find((item) => item.id === req.params.id);
    if (!record) throw new Error("Schedule not found.");
    if (record.lastStatus === "Running") throw new Error("Wait for the schedule to finish before deleting.");
    schedules.pauseSchedule(record.id);
    if (record.wakeApplication) await windowsSchedules.updateWindowsTask(record, true);
    schedules.deleteSchedule(record.id);
    res.json({ deleted: true });
  } catch (error) { httpError(res, error); }
});

app.get("/api/status", (req, res) => {
  res.json({
    app: "Pebloy",
    version: packageMetadata.version,
    runningTasks: runningTasks.size + (schedulerRunning ? 1 : 0),
    profiles: listProfiles().length,
    port: req.socket.localPort,
  });
});

const desiredPort = parseDesiredPort(process.env.PORT);

const artifactRoot = process.env.ARTIFACTS_DIR || path.resolve(__dirname, "..", "artifacts");
acquireRuntimeLocks([DATA_DIR, artifactRoot, LOG_DIR, ...["EXPORTS_DIR", "SCRIPTS_DIR", "REPORTS_DIR", "TEMP_DIR", "CODEDIFF_DIR", "LOG_ARCHIVE_DIR"].map((key) => process.env[key]).filter(Boolean)])
  .then(async (ownership) => {
    process.env.PEBLOY_RUNTIME_ID = ownership.runtimeId;
    try {
      schedules.recoverInterruptedSchedules();
      return { ...await listenOnAvailablePort(app, desiredPort), ownership };
    }
    catch (error) { await ownership.release(); throw error; }
  })
  .then(({ server, port, ownership }) => {
    let httpClosed = false;
    let exiting = false;
    const tickSchedules = async () => {
      if (schedulerRunning || shuttingDown) return;
      try { if (!schedulesEnabled()) return; }
      catch (error) { console.error(`Scheduling skipped: ${error.message}`); return; }
      schedulerRunning = true;
      try { await schedules.runDueSchedules({ execute: executeBatchWorkflow, isBusy: () => shuttingDown || runningTasks.size > 0 }); }
      catch (error) { console.error(`Scheduling stopped: ${error.message}`); }
      finally { schedulerRunning = false; finishShutdown(); }
    };
    const schedulerTimer = setInterval(tickSchedules, 15000);
    schedulerTimer.unref();
    finishShutdown = () => {
      if (!shuttingDown || !httpClosed || runningTasks.size || schedulerRunning || exiting) return;
      exiting = true;
      try { flushTaskLogs(); }
      catch (error) { console.error(`Final task log flush failed: ${error.message}`); process.exitCode = 1; }
      ownership.release().then(() => process.exit(process.exitCode || 0));
    };
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(schedulerTimer);
      flushTaskLogs();
      for (const client of sseClients) client.end();
      sseClients.clear();
      server.close(() => { httpClosed = true; finishShutdown(); });
      server.closeIdleConnections?.();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    if (process.connected) {
      process.once("disconnect", shutdown);
      process.on("message", (message) => { if (message === "shutdown") shutdown(); });
    }
    process.once("exit", () => {
      try { flushTaskLogs(); } catch (error) { console.error(`Task log flush failed: ${error.message}`); }
    });
    writeServerInfo(port);
    const fallbackMessage = port === desiredPort ? "" : ` (requested ${desiredPort}; selected next available port)`;
    console.log(`Pebloy listening on http://${LOOPBACK_HOST}:${port}${fallbackMessage}`);
    void tickSchedules();
    ensureSqlServerModule()
      .then(() => console.log("SqlServer PowerShell module ready."))
      .catch((err) => console.warn(`SqlServer module setup: ${err.message}`));
  })
  .catch((error) => {
    console.error(`${STARTUP_FAILURE_PREFIX} ${error.message}`);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  });
