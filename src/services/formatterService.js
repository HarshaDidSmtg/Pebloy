const path = require("path");
const { Worker } = require("worker_threads");

const {
  DEFAULT_INTERACTIVE_FORMATTER_OPTIONS,
  FORMATTER_CAPABILITIES,
  normalizeFormatterOptions,
  normalizeFormatterRequest,
} = require("./formatterOptions");
const { getAppState } = require("./appStateService");
const { formatTextAsync, formatTextSync } = require("./tsqlFormatterProvider");

// One canonical option set so output is deterministic and idempotent.
// These are the Poor Man's T-SQL Formatter defaults (same as poorsql.com).
const FORMAT_OPTIONS = { ...DEFAULT_INTERACTIVE_FORMATTER_OPTIONS };

const FORMATTER_WORKER_PATH = path.resolve(__dirname, "formatterWorker.js");
let activeFormatterWorkers = 0;

function formatSql(text) {
  return formatTextSync(text, FORMAT_OPTIONS);
}

function getGeneratedSqlFormatOptions() {
  const formatterState = getAppState()?.ui?.formatter;
  const persistedOptions = formatterState && typeof formatterState === "object" && !Array.isArray(formatterState)
    ? formatterState.options
    : null;
  return normalizeFormatterOptions(persistedOptions || FORMAT_OPTIONS);
}

function formatGeneratedSql(text) {
  return formatTextSync(text, getGeneratedSqlFormatOptions());
}

async function formatGeneratedSqlAsync(text) {
  const result = await formatInteractiveSql(text, { options: getGeneratedSqlFormatOptions() });
  return result.formatted;
}

async function formatSqlAsync(text, { onProgress = null } = {}) {
  return formatTextAsync(text, FORMAT_OPTIONS, { onProgress });
}

function formatInteractiveSql(sql, rawRequest = {}, { onProgress = null } = {}) {
  const normalizedRequest = normalizeFormatterRequest(rawRequest);
  const input = String(sql ?? "");
  if (Buffer.byteLength(input, "utf8") > 20 * 1024 * 1024) return Promise.reject(new Error("SQL formatting input exceeds 20 MB."));
  if (!input.trim()) {
    return Promise.resolve({
      formatted: input,
      dialect: normalizedRequest.dialect,
      normalization: normalizedRequest.normalization,
      options: normalizedRequest.options,
    });
  }

  if (activeFormatterWorkers >= 2) return Promise.reject(new Error("Two formatting jobs are already running. Wait for one to finish."));
  return new Promise((resolve, reject) => {
    const worker = new Worker(FORMATTER_WORKER_PATH);
    activeFormatterWorkers += 1;
    let cleanedUp = false;
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    // A pathological input must never leave a worker thread running forever.
    const timeoutMs = 180000;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Formatting timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      activeFormatterWorkers -= 1;
      clearTimeout(timeout);
      worker.removeAllListeners();
      worker.terminate().catch(() => {});
    };

    worker.on("message", (message) => {
      if (!message || message.requestId !== requestId) return;
      if (message.type === "progress") {
        try { if (onProgress) onProgress({ done: message.done, total: message.total }); }
        catch (error) { cleanup(); reject(error); }
        return;
      }
      if (message.type === "result") {
        cleanup();
        resolve({
          formatted: message.formatted,
          dialect: normalizedRequest.dialect,
          normalization: normalizedRequest.normalization,
          options: normalizedRequest.options,
        });
        return;
      }
      if (message.type === "error") {
        cleanup();
        reject(new Error(message.error || "Formatting failed."));
      }
    });

    worker.on("error", (error) => {
      cleanup();
      reject(error);
    });

    worker.on("exit", (code) => {
      cleanup();
      reject(new Error(`Formatter worker exited before returning a result (code ${code}).`));
    });

    worker.postMessage({
      requestId,
      sql: input,
      mode: normalizedRequest.mode,
      options: normalizedRequest.options,
    });
  });
}

function getFormatterCapabilities() {
  return FORMATTER_CAPABILITIES;
}

module.exports = {
  DEFAULT_INTERACTIVE_FORMATTER_OPTIONS,
  FORMAT_OPTIONS,
  formatGeneratedSql,
  formatGeneratedSqlAsync,
  formatInteractiveSql,
  formatSql,
  formatSqlAsync,
  getFormatterCapabilities,
  normalizeFormatterRequest,
};
