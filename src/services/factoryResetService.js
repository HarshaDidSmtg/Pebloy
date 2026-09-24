const fs = require("fs");
const path = require("path");
const { writeJson, ensureDir } = require("./storage");
const { DEFAULTS: DEFAULT_SETTINGS, LEGACY_SETTINGS_PATH } = require("./settingsService");
const { DEFAULT_APP_STATE } = require("./appStateService");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const ARTIFACT_DIR = process.env.ARTIFACTS_DIR || path.join(ROOT_DIR, "artifacts");

const RESET_FILES = [
  { path: path.join(DATA_DIR, "profiles.json"), value: [] },
  { path: path.join(DATA_DIR, "secrets.json"), value: {} },
  { path: path.join(DATA_DIR, "settings.json"), value: DEFAULT_SETTINGS },
  { path: path.join(DATA_DIR, "app-state.json"), value: DEFAULT_APP_STATE },
];

const DELETE_FILES = [
  path.join(DATA_DIR, "server-info.json"),
  path.join(DATA_DIR, "server-stderr.log"),
  path.join(DATA_DIR, "server-stdout.log"),
  LEGACY_SETTINGS_PATH,
  path.join(ARTIFACT_DIR, "server-final-live.err.log"),
  path.join(ARTIFACT_DIR, "server-final-live.out.log"),
  path.join(ARTIFACT_DIR, "server-live.err.log"),
  path.join(ARTIFACT_DIR, "server-live.out.log"),
];

const CLEAR_DIRS = [
  path.join(ARTIFACT_DIR, "logs"),
  path.join(ARTIFACT_DIR, "scripts"),
  path.join(ARTIFACT_DIR, "reports"),
  path.join(ARTIFACT_DIR, "exports"),
  path.join(ARTIFACT_DIR, "temp"),
];

function clearDirContents(dirPath) {
  let removed = 0;
  if (!fs.existsSync(dirPath)) {
    ensureDir(dirPath);
    return removed;
  }

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    fs.rmSync(fullPath, { recursive: true, force: true });
    removed += 1;
  }

  ensureDir(dirPath);
  return removed;
}

function deleteFile(filePath) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
    return 1;
  }
  return 0;
}

function performFactoryReset() {
  let resetFiles = 0;
  let deletedFiles = 0;
  let clearedEntries = 0;

  for (const entry of RESET_FILES) {
    writeJson(entry.path, entry.value);
    resetFiles += 1;
  }

  for (const filePath of DELETE_FILES) {
    deletedFiles += deleteFile(filePath);
  }
  for (const name of fs.readdirSync(DATA_DIR)) {
    if (/^(settings|app-state)\.json(?:\.last-good|\.[a-f0-9-]+\.corrupt)$/.test(name)) {
      deletedFiles += deleteFile(path.join(DATA_DIR, name));
    }
  }

  for (const dirPath of CLEAR_DIRS) {
    clearedEntries += clearDirContents(dirPath);
  }

  return {
    resetFiles,
    deletedFiles,
    clearedEntries,
  };
}

module.exports = {
  performFactoryReset,
};