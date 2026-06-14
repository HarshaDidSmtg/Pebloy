const fs = require("fs");
const path = require("path");
const { ensureDir } = require("./storage");

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const LEGACY_SETTINGS_PATH = path.resolve(__dirname, "..", "..", "artifacts", "settings.json");

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
  deploymentOrder: [
    "USER_DEFINED_TYPE",
    "SEQUENCE",
    "TABLE",
    "VIEW",
    "FUNCTION",
    "PROCEDURE",
    "SYNONYM",
    "TRIGGER",
  ],
};

const VALID_OBJECT_TYPES = new Set([
  ...Object.keys(DEFAULTS.folderNames),
  ...DEFAULTS.deploymentOrder,
]);

function sanitizeDeploymentOrder(order) {
  const chosen = Array.isArray(order) ? order : [];
  const seen = new Set();
  const normalized = [];

  for (const item of chosen) {
    const objectType = String(item || "").trim().toUpperCase();
    if (!VALID_OBJECT_TYPES.has(objectType) || seen.has(objectType)) continue;
    seen.add(objectType);
    normalized.push(objectType);
  }

  for (const objectType of DEFAULTS.deploymentOrder) {
    if (!seen.has(objectType)) normalized.push(objectType);
  }

  return normalized;
}

function sanitizeFolderNames(folderNames) {
  const safe = {};
  const source = folderNames && typeof folderNames === "object" ? folderNames : {};

  for (const [objectType, defaultName] of Object.entries(DEFAULTS.folderNames)) {
    const raw = source[objectType];
    const value = typeof raw === "string" ? raw.trim() : "";
    safe[objectType] = value || defaultName;
  }

  return safe;
}

function sanitizeSettings(raw = {}) {
  return {
    folderNames: sanitizeFolderNames(raw.folderNames),
    deploymentOrder: sanitizeDeploymentOrder(raw.deploymentOrder),
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
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      return sanitizeSettings(parsed);
    }
  } catch (_e) {
    // Fall through to defaults on any parse/read error
  }
  return sanitizeSettings(DEFAULTS);
}

function saveSettings(partial = {}) {
  const current = getSettings();
  const updated = sanitizeSettings({
    folderNames: { ...current.folderNames, ...(partial.folderNames || {}) },
    deploymentOrder: Array.isArray(partial.deploymentOrder) ? partial.deploymentOrder : current.deploymentOrder,
  });
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(updated, null, 2), "utf8");
  return updated;
}

module.exports = { DEFAULTS, getSettings, saveSettings, SETTINGS_PATH, LEGACY_SETTINGS_PATH };
