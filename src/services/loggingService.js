const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");
const { ensureDir } = require("./storage");
const { writeSqlFileSync } = require("./sqlFileEncoding");

const ARTIFACT_DIR = process.env.ARTIFACTS_DIR || path.resolve(__dirname, "..", "..", "artifacts");
const LOG_DIR = process.env.LOGS_DIR || path.join(ARTIFACT_DIR, "logs");
const LOG_ARCHIVE_DIR = process.env.LOG_ARCHIVE_DIR || path.join(LOG_DIR, "archive");
const SCRIPT_DIR = process.env.SCRIPTS_DIR || path.join(ARTIFACT_DIR, "scripts");
const REPORT_DIR = process.env.REPORTS_DIR || path.join(ARTIFACT_DIR, "reports");
const MAX_ACTIVE_TASK_LOGS = Math.max(1, Number.parseInt(process.env.MAX_ACTIVE_TASK_LOGS || "200", 10) || 200);
const MAX_LOG_FILE_BYTES = Math.max(1024, Number.parseInt(process.env.MAX_LOG_FILE_BYTES || String(2 * 1024 * 1024), 10) || 2 * 1024 * 1024);

ensureDir(LOG_DIR);
ensureDir(LOG_ARCHIVE_DIR);
ensureDir(SCRIPT_DIR);
ensureDir(REPORT_DIR);

function timestampStamp() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

// In-memory event buffer: taskId → events[]. Prevents concurrent read-modify-write on the JSON log.
const _taskEventBuffers = new Map();
const _taskSummaryIndex = new Map();
let _logIndexLoaded = false;
const VALID_LOG_LEVELS = new Set(["Verbose", "Normal", "ErrorsOnly"]);
const EVENT_SEVERITY_ORDER = { ERROR: 3, WARN: 2, WARNING: 2, INFO: 1 };

function normalizeLogLevel(value) {
  return VALID_LOG_LEVELS.has(value) ? value : "Normal";
}

function normalizeSelectionReadiness(raw = {}) {
  const source = raw.selectionReadiness || raw || {};
  return {
    sorting: source.sorting || "Ready",
    ordering: source.ordering || "Ready",
    filtering: source.filtering || "Ready",
  };
}

function buildTextPath(jsonPath, raw = {}) {
  if (raw.textPath) {
    return raw.textPath;
  }
  return jsonPath ? jsonPath.replace(/\.json$/i, ".log") : null;
}

function summarizeEvents(events = []) {
  const eventCounts = { INFO: 0, WARN: 0, ERROR: 0 };
  let highestLevel = "";
  let highestRank = 0;

  for (const rawEvent of Array.isArray(events) ? events : []) {
    const normalizedLevel = String(rawEvent?.level || "INFO").toUpperCase();
    const canonicalLevel = normalizedLevel === "WARNING" ? "WARN" : normalizedLevel;
    if (canonicalLevel === "INFO" || canonicalLevel === "WARN" || canonicalLevel === "ERROR") {
      eventCounts[canonicalLevel] += 1;
    }

    const rank = EVENT_SEVERITY_ORDER[normalizedLevel] || EVENT_SEVERITY_ORDER[canonicalLevel] || 0;
    if (rank > highestRank) {
      highestRank = rank;
      highestLevel = canonicalLevel;
    }
  }

  return { eventCounts, highestLevel };
}

function buildLogSummary(raw, jsonPath) {
  const { eventCounts, highestLevel } = summarizeEvents(raw.events || []);
  return {
    taskId: raw.taskId,
    taskType: raw.taskType,
    status: raw.status,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt || null,
    summary: raw.summary || null,
    sourceProfileLabel: raw.sourceProfileLabel || null,
    destinationProfileLabel: raw.destinationProfileLabel || null,
    selectionReadiness: normalizeSelectionReadiness(raw),
    logLevel: normalizeLogLevel(raw.logLevel),
    eventCounts,
    highestLevel,
    objectCount: (raw.selectedObjects || []).length,
    textPath: buildTextPath(jsonPath, raw),
    jsonPath,
  };
}

function loadLogIndex() {
  if (_logIndexLoaded) {
    return;
  }

  _taskSummaryIndex.clear();
  const files = fs.readdirSync(LOG_DIR).filter((name) => name.endsWith(".json"));
  for (const name of files) {
    const fullPath = path.join(LOG_DIR, name);
    try {
      const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (!raw.taskId) continue;
      _taskSummaryIndex.set(raw.taskId, buildLogSummary(raw, fullPath));
    } catch (_e) {
      // Skip malformed log files.
    }
  }

  _logIndexLoaded = true;
}

function moveLogFileToArchive(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  const archivedPath = path.join(LOG_ARCHIVE_DIR, path.basename(filePath));
  fs.renameSync(filePath, archivedPath);
  return archivedPath;
}

function archiveCompletedLogs() {
  const jsonFiles = fs.readdirSync(LOG_DIR).filter((name) => name.endsWith(".json"));
  if (jsonFiles.length <= MAX_ACTIVE_TASK_LOGS) {
    return 0;
  }

  const completedLogs = [];
  for (const name of jsonFiles) {
    const fullPath = path.join(LOG_DIR, name);
    try {
      const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (raw.status === "Running") continue;
      completedLogs.push({
        taskId: raw.taskId,
        startedAt: raw.startedAt || "",
        jsonPath: fullPath,
        textPath: buildTextPath(fullPath, raw),
      });
    } catch (_error) {
      // Leave unreadable logs in place rather than risking data loss.
    }
  }

  if (jsonFiles.length - completedLogs.length >= MAX_ACTIVE_TASK_LOGS) {
    return 0;
  }

  completedLogs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const removeCount = Math.max(0, jsonFiles.length - MAX_ACTIVE_TASK_LOGS);
  const toArchive = completedLogs.slice(0, removeCount);

  for (const entry of toArchive) {
    moveLogFileToArchive(entry.jsonPath);
    moveLogFileToArchive(entry.textPath);
    if (entry.taskId) {
      _taskSummaryIndex.delete(entry.taskId);
    }
  }

  return toArchive.length;
}

function upsertLogSummary(summary) {
  if (!summary?.taskId) {
    return;
  }
  _taskSummaryIndex.set(summary.taskId, summary);
}

function createTaskLog(taskType, context = {}) {
  const taskId = randomUUID();
  const stamp = timestampStamp();
  const baseName = `${stamp}_${taskType}_${taskId}`;
  const textPath = path.join(LOG_DIR, `${baseName}.log`);
  const jsonPath = path.join(LOG_DIR, `${baseName}.json`);
  const logLevel = normalizeLogLevel(context.logLevel);

  const meta = {
    taskId,
    taskType,
    logLevel,
    startedAt: new Date().toISOString(),
    startedBy: os.userInfo().username,
    machine: os.hostname(),
    sourceProfileLabel: context.sourceProfileLabel || null,
    destinationProfileLabel: context.destinationProfileLabel || null,
    selectionReadiness: normalizeSelectionReadiness(context),
    selectedObjects: context.selectedObjects || [],
    events: [],
    status: "Running",
    textPath,
    jsonPath,
  };

  fs.writeFileSync(textPath, `TASK START ${meta.startedAt}\nTaskId=${taskId}\n`, "utf8");
  fs.writeFileSync(jsonPath, JSON.stringify(meta, null, 2), "utf8");
  _taskEventBuffers.set(taskId, []);
  upsertLogSummary(buildLogSummary(meta, jsonPath));

  return {
    taskId,
    taskType,
    logLevel,
    textPath,
    jsonPath,
  };
}

const SENSITIVE_KEYS = new Set(["password", "secret", "secretreference", "cipher", "pwd", "credentials"]);

function filterSensitive(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(filterSensitive);
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : filterSensitive(v);
  }
  return result;
}

function shouldPersistEvent(logLevel, level, options = {}) {
  if (options.alwaysLog) {
    return true;
  }

  const normalizedLevel = String(level || "INFO").toUpperCase();
  if (logLevel === "ErrorsOnly") {
    return normalizedLevel === "ERROR" || normalizedLevel === "WARN" || normalizedLevel === "WARNING";
  }

  return true;
}

function shouldKeepDetails(logLevel, level, options = {}) {
  if (options.keepDetails) {
    return true;
  }

  if (logLevel === "Verbose") {
    return true;
  }

  const normalizedLevel = String(level || "INFO").toUpperCase();
  return normalizedLevel === "ERROR" || normalizedLevel === "WARN" || normalizedLevel === "WARNING";
}

function trimLogFileIfOversized(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= MAX_LOG_FILE_BYTES) return;
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    // Keep the first line (TASK START header) and the last 200 lines
    const head = lines[0] || "";
    const tail = lines.slice(-200).join("\n");
    fs.writeFileSync(filePath, `${head}\n[...log trimmed — exceeded ${MAX_LOG_FILE_BYTES} bytes...]\n${tail}`, "utf8");
  } catch (_err) {
    // Do not fail task logging due to trim errors
  }
}

function appendTaskEvent(task, level, message, details = null) {
  const logLevel = normalizeLogLevel(task?.logLevel);
  if (!shouldPersistEvent(logLevel, level)) {
    return;
  }

  const safeDetails = shouldKeepDetails(logLevel, level) ? filterSensitive(details) : null;
  const timestamp = new Date().toISOString();
  const line = `${timestamp} [${level}] ${message}${safeDetails ? ` | ${JSON.stringify(safeDetails)}` : ""}\n`;
  fs.appendFileSync(task.textPath, line, "utf8");
  trimLogFileIfOversized(task.textPath);

  const buf = _taskEventBuffers.get(task.taskId);
  if (buf) {
    const previous = buf[buf.length - 1];
    const previousDetails = previous?.details ? JSON.stringify(previous.details) : "";
    const nextDetails = safeDetails ? JSON.stringify(safeDetails) : "";
    if (previous && previous.level === level && previous.message === message && previousDetails === nextDetails) {
      return;
    }

    buf.push({ timestamp, level, message, details: safeDetails });
    const summary = _taskSummaryIndex.get(task.taskId);
    if (summary) {
      upsertLogSummary(buildLogSummary({
        ...summary,
        taskId: task.taskId,
        taskType: task.taskType,
        logLevel,
        selectedObjects: summary.objectCount ? new Array(summary.objectCount) : [],
        events: buf,
      }, summary.jsonPath));
    }
  }
}

function finalizeTaskLog(task, status, summary = {}) {
  const completedAt = new Date().toISOString();
  fs.appendFileSync(task.textPath, `TASK END ${completedAt} Status=${status}\n`, "utf8");

  let json;
  try {
    json = JSON.parse(fs.readFileSync(task.jsonPath, "utf8"));
  } catch (_err) {
    json = { taskId: task.taskId, taskType: task.taskType, events: [] };
  }

  json.status = status;
  json.completedAt = completedAt;
  json.summary = summary;
  json.events = _taskEventBuffers.get(task.taskId) || json.events || [];
  _taskEventBuffers.delete(task.taskId);
  fs.writeFileSync(task.jsonPath, JSON.stringify(json, null, 2), "utf8");
  archiveCompletedLogs();
  upsertLogSummary(buildLogSummary(json, task.jsonPath));
}

function writeScriptArtifact(taskId, taskType, objectType, schemaName, objectName, sqlText) {
  const stamp = timestampStamp();
  const safe = [taskType, objectType, schemaName, objectName]
    .filter(Boolean)
    .join("_")
    .replace(/[^a-zA-Z0-9._-]/g, "_");

  const filePath = path.join(SCRIPT_DIR, `${stamp}_${taskId}_${safe}.sql`);
  writeSqlFileSync(filePath, sqlText);
  return filePath;
}

function writeReportArtifact(prefix, extension, content) {
  const stamp = timestampStamp();
  const safePrefix = prefix.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(REPORT_DIR, `${stamp}_${safePrefix}.${extension}`);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function listLogFiles() {
  loadLogIndex();
  return [..._taskSummaryIndex.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

function getTaskLog(taskId) {
  loadLogIndex();
  const summary = _taskSummaryIndex.get(taskId);
  if (!summary?.jsonPath || !fs.existsSync(summary.jsonPath)) {
    return null;
  }

  try {
    const obj = JSON.parse(fs.readFileSync(summary.jsonPath, "utf8"));
    const buffered = _taskEventBuffers.get(taskId);
    if (buffered) {
      obj.events = buffered;
    }
    obj.logLevel = normalizeLogLevel(obj.logLevel);
    obj.textPath = obj.textPath || summary.textPath || buildTextPath(summary.jsonPath, obj);
    obj.jsonPath = obj.jsonPath || summary.jsonPath;
    obj.selectionReadiness = normalizeSelectionReadiness(obj);
    return obj;
  } catch (_e) {
    return null;
  }
}

function clearAllLogs() {
  const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".log") || f.endsWith(".json"));
  for (const f of files) {
    try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch (_) {}
  }
  _taskEventBuffers.clear();
  _taskSummaryIndex.clear();
  _logIndexLoaded = true;
  return { cleared: files.length };
}

loadLogIndex();
archiveCompletedLogs();

module.exports = {
  createTaskLog,
  appendTaskEvent,
  finalizeTaskLog,
  writeScriptArtifact,
  writeReportArtifact,
  listLogFiles,
  getTaskLog,
  clearAllLogs,
  LOG_ARCHIVE_DIR,
};
