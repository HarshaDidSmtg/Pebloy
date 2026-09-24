const path = require("path");
const { randomUUID } = require("crypto");
const { readJson, writeJsonAtomic, ensureJsonFile } = require("./storage");
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "..", "..", "data");
const SCHEDULE_FILE = path.join(DATA_DIR, "schedules.json");
const types = new Set(["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SYNONYM", "SEQUENCE", "USER_DEFINED_TYPE"]);
let ticking = false;

function readSchedules() {
  ensureJsonFile(SCHEDULE_FILE, []);
  const records = readJson(SCHEDULE_FILE, []);
  if (!Array.isArray(records)) throw new Error("The schedule store is invalid. No scheduled task will run.");
  return records;
}

function cleanRequest(input = {}) {
  if (!["ExecuteDirectly", "Rollback", "DryRun"].includes(input.mode)) throw new Error("Schedules require Apply, Rollback, or Dry Run.");
  if ((!input.sourceProfileId && !input.sourceFolder) || !Array.isArray(input.targetProfileIds) || !input.targetProfileIds.length || input.targetProfileIds.length > 20 || new Set(input.targetProfileIds).size !== input.targetProfileIds.length || input.targetProfileIds.some((id) => typeof id !== "string" || !id)) throw new Error("Schedules require a source and 1 to 20 distinct targets.");
  if (!Array.isArray(input.selectedObjects) || !input.selectedObjects.length || input.selectedObjects.length > 5000 || input.selectedObjects.some((item) => !item || !types.has(item.objectType) || [item.schemaName, item.objectName].some((name) => typeof name !== "string" || !name.trim() || name.length > 128 || /[\r\n\0]/.test(name)))) throw new Error("Schedules require 1 to 5000 valid objects.");
  if (!/^[a-f0-9]{64}$/.test(input.options?.confirmedBatchFingerprint || "")) throw new Error("Review and confirm the scheduled deployment plan first.");
  if ([input.sourceProfileId, input.sourceFolder, input.options?.scriptOutputPath].some((value) => value != null && (typeof value !== "string" || value.length > 2048 || /[\r\n\0]/.test(value)))) throw new Error("Invalid schedule source or output path.");
  return { sourceProfileId: input.sourceFolder ? undefined : input.sourceProfileId, sourceFolder: input.sourceFolder || undefined,
    targetProfileIds: [...input.targetProfileIds], selectedObjects: input.selectedObjects.map(({ objectType, schemaName, objectName }) => ({ objectType, schemaName, objectName })),
    mode: input.mode, engine: "Legacy", continueOnError: Boolean(input.continueOnError), continueTargetsOnError: Boolean(input.continueTargetsOnError),
    logLevel: ["Normal", "ErrorsOnly", "Verbose"].includes(input.logLevel) ? input.logLevel : "Normal",
    options: { scriptOutputPath: input.options?.scriptOutputPath || "", confirmedBatchFingerprint: input.options.confirmedBatchFingerprint } };
}

function saveSchedule(input, id = null, now = Date.now(), enabled = true) {
  if (input.confirmed !== true) throw new Error("Explicit schedule confirmation is required.");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 100) throw new Error("Enter a schedule name of 1 to 100 characters.");
  if (!["once", "daily", "weekly"].includes(input.repeat)) throw new Error("Choose Once, Daily, or Weekly.");
  const nextRun = Date.parse(input.nextRunAt);
  if (!Number.isFinite(nextRun) || nextRun <= now) throw new Error("Choose a future first-run time.");
  const records = readSchedules();
  const existing = id ? records.find((entry) => entry.id === id) : null;
  if (id && !existing) throw new Error("Schedule not found.");
  if (existing?.lastStatus === "Running") throw new Error("Wait for the running schedule to finish before editing.");
  if (!id && records.length >= 100) throw new Error("A maximum of 100 schedules is supported.");
  const record = { id: existing?.id || randomUUID(), name: input.name.trim(), repeat: input.repeat,
    nextRunAt: new Date(nextRun).toISOString(), enabled, wakeApplication: Boolean(input.wakeApplication),
    request: cleanRequest(input.request), createdAt: existing?.createdAt || new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    lastStatus: existing?.lastStatus || "NotRun", lastRunAt: existing?.lastRunAt || null, lastResult: existing?.lastResult || null };
  writeJsonAtomic(SCHEDULE_FILE, existing ? records.map((entry) => entry.id === id ? record : entry) : [...records, record]);
  return record;
}

function pauseSchedule(id, error = null) {
  const records = readSchedules();
  const record = records.find((entry) => entry.id === id);
  if (!record) throw new Error("Schedule not found.");
  record.enabled = false;
  if (error) record.lastError = error;
  record.updatedAt = new Date().toISOString();
  writeJsonAtomic(SCHEDULE_FILE, records);
  return record;
}

function activateSchedule(id, expectedVersion) {
  const records = readSchedules();
  const record = records.find((entry) => entry.id === id);
  if (!record || record.updatedAt !== expectedVersion) throw new Error("Schedule changed during registration. Review it again.");
  record.enabled = true;
  writeJsonAtomic(SCHEDULE_FILE, records);
  return record;
}

function deleteSchedule(id) {
  const records = readSchedules();
  const record = records.find((entry) => entry.id === id);
  if (!record) throw new Error("Schedule not found.");
  if (record.lastStatus === "Running") throw new Error("Wait for this schedule to finish before deleting.");
  writeJsonAtomic(SCHEDULE_FILE, records.filter((entry) => entry.id !== id));
}

function recoverInterruptedSchedules() {
  const records = readSchedules();
  let changed = false;
  for (const record of records) {
    if (record.lastStatus !== "Running") continue;
    record.enabled = false;
    record.lastStatus = "Interrupted";
    record.lastError = "The previous runtime ended during execution. Inspect the target and task logs; reauthorize before running again.";
    changed = true;
  }
  if (changed) writeJsonAtomic(SCHEDULE_FILE, records);
}

function nextOccurrence(record, now) {
  if (record.repeat === "once") return null;
  const next = new Date(record.nextRunAt);
  const step = record.repeat === "weekly" ? 7 : 1;
  const elapsedDays = Math.max(0, Math.floor((now - next.getTime()) / 86400000));
  next.setDate(next.getDate() + Math.floor(elapsedDays / step) * step);
  while (next.getTime() <= now) next.setDate(next.getDate() + step);
  return next.toISOString();
}

async function runDueSchedules({ execute, isBusy = () => false, now = Date.now() }) {
  if (ticking || isBusy()) return [];
  ticking = true;
  const outcomes = [];
  try {
    const due = readSchedules().filter((record) => record.enabled && Date.parse(record.nextRunAt) <= now).sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt));
    for (const candidate of due) {
      if (isBusy()) break;
      const records = readSchedules();
      const record = records.find((entry) => entry.id === candidate.id);
      if (!record?.enabled) continue;
      record.lastStatus = "Running";
      record.lastRunAt = new Date(now).toISOString();
      record.nextRunAt = nextOccurrence(record, now);
      if (!record.nextRunAt) record.enabled = false;
      writeJsonAtomic(SCHEDULE_FILE, records);
      let result;
      let error;
      try { result = await execute(cleanRequest(record.request)); }
      catch (failure) { error = failure.message; }
      const fresh = readSchedules();
      const finished = fresh.find((entry) => entry.id === record.id);
      if (!finished) continue;
      finished.lastStatus = error ? "NeedsReview" : result.summary?.failed || result.summary?.reviewRequired ? "NeedsReview" : "Success";
      finished.lastError = error || null;
      finished.lastResult = result ? { taskId: result.taskId, logFilePath: result.logFilePath, summary: result.summary } : null;
      if (finished.lastStatus === "NeedsReview") finished.enabled = false;
      writeJsonAtomic(SCHEDULE_FILE, fresh);
      outcomes.push({ id: record.id, status: finished.lastStatus });
    }
    return outcomes;
  } finally { ticking = false; }
}

module.exports = { readSchedules, saveSchedule, pauseSchedule, activateSchedule, deleteSchedule, recoverInterruptedSchedules, runDueSchedules, cleanRequest, SCHEDULE_FILE };