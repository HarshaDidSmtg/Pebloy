const fs = require("fs");
const path = require("path");
const { ensureDir, readRecoverableJson, writeRecoverableJson } = require("./storage");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const ARTIFACT_DIR = process.env.ARTIFACTS_DIR || path.join(ROOT_DIR, "artifacts");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const LEGACY_SETTINGS_PATH = path.join(ARTIFACT_DIR, "settings.json");

const DEFAULTS = {
  folderNames: {
    PROCEDURE: "Stored Procedures",
    VIEW: "Views",
    FUNCTION: "Functions",
    TABLE: "Tables",
    SYNONYM: "Synonyms",
    SEQUENCE: "Sequences",
    USER_DEFINED_TYPE: "User Defined Types",
  },
  dacfx: {
    validationEnabled: false,
  },
  time: {
    useSystemTime: true,
    timeZone: "",
  },
  formatting: {
    formatGeneratedSql: false,
  },
  execution: {
    queryTimeoutSeconds: 120,
    powershellTimeoutSeconds: 180,
    maxActiveTaskLogs: 200,
  },
  features: {
    schedules: false,
  },
};

const EXECUTION_LIMITS = {
  queryTimeoutSeconds: { min: 5, max: 3600 },
  powershellTimeoutSeconds: { min: 30, max: 7200 },
  maxActiveTaskLogs: { min: 10, max: 5000 },
};

function sanitizeFolderNames(folderNames) {
  const safe = {};
  const source = folderNames && typeof folderNames === "object" ? folderNames : {};
  const usedNames = new Set();

  for (const [objectType, defaultName] of Object.entries(DEFAULTS.folderNames)) {
    const raw = source[objectType];
    const value = typeof raw === "string" ? raw.trim() : "";
    const folderName = value || defaultName;
    if (folderName.length > 100 || /[<>:"/\\|?*\x00-\x1f]/.test(folderName) ||
        /[. ]$/.test(folderName) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(folderName)) {
      throw new Error(`Invalid folder name for ${objectType}. Use a single Windows folder name, not a path.`);
    }
    const key = folderName.toLowerCase();
    if (usedNames.has(key)) throw new Error(`Folder names must be unique: ${folderName}.`);
    usedNames.add(key);
    safe[objectType] = folderName;
  }

  return safe;
}

function sanitizeExecution(execution) {
  const source = execution && typeof execution === "object" ? execution : {};
  const safe = {};
  for (const [key, fallback] of Object.entries(DEFAULTS.execution)) {
    const raw = source[key];
    if (raw === undefined || raw === null || raw === "") {
      safe[key] = fallback;
      continue;
    }
    const value = Number(raw);
    const { min, max } = EXECUTION_LIMITS[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${key} must be a whole number between ${min} and ${max}.`);
    }
    safe[key] = value;
  }
  if (safe.powershellTimeoutSeconds < safe.queryTimeoutSeconds) {
    throw new Error("powershellTimeoutSeconds must be at least queryTimeoutSeconds so a running query is not killed early.");
  }
  return safe;
}

function sanitizeSettings(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    folderNames: sanitizeFolderNames(source.folderNames),
    dacfx: {
      validationEnabled: Boolean(source.dacfx?.validationEnabled),
    },
    time: {
      useSystemTime: source.time?.useSystemTime === undefined ? true : Boolean(source.time.useSystemTime),
      timeZone: typeof source.time?.timeZone === "string" ? source.time.timeZone : "",
    },
    formatting: {
      formatGeneratedSql: Boolean(source.formatting?.formatGeneratedSql),
    },
    execution: sanitizeExecution(source.execution),
    features: {
      schedules: source.features?.schedules === true,
    },
  };
}

function migrateLegacySettings() {
  if (!fs.existsSync(SETTINGS_PATH) && fs.existsSync(LEGACY_SETTINGS_PATH)) {
    ensureDir(path.dirname(SETTINGS_PATH));
    fs.copyFileSync(LEGACY_SETTINGS_PATH, SETTINGS_PATH);
  }
}

function getSettings() {
  try {
    migrateLegacySettings();
    return sanitizeSettings(readRecoverableJson(SETTINGS_PATH, DEFAULTS));
  } catch (error) {
    throw new Error(`Cannot load settings: ${error.message}. The existing settings file has not been replaced.`);
  }
}

function saveSettings(partial = {}) {
  const current = getSettings();
  const updated = sanitizeSettings({
    folderNames: { ...current.folderNames, ...(partial.folderNames || {}) },
    dacfx: partial.dacfx && typeof partial.dacfx === "object" ? partial.dacfx : current.dacfx,
    time: partial.time && typeof partial.time === "object" ? partial.time : current.time,
    formatting: partial.formatting && typeof partial.formatting === "object" ? partial.formatting : current.formatting,
    execution: { ...current.execution, ...(partial.execution || {}) },
    features: { ...current.features, ...(partial.features && typeof partial.features === "object" ? partial.features : {}) },
  });
  writeRecoverableJson(SETTINGS_PATH, updated);
  return updated;
}

module.exports = { DEFAULTS, EXECUTION_LIMITS, getSettings, saveSettings, SETTINGS_PATH, LEGACY_SETTINGS_PATH };
