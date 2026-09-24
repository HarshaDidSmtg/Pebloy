const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureJsonFile(filePath, defaultValue) {
  ensureDir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf8");
  }
}

function readJson(filePath, defaultValue) {
  ensureJsonFile(filePath, defaultValue);
  const text = fs.readFileSync(filePath, "utf8");
  return JSON.parse(text);
}

function writeJson(filePath, value) {
  writeJsonAtomic(filePath, value);
}

function parsePreferenceJson(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("Preference storage must contain a JSON object.");
  return parsed;
}

function readRecoverableJson(filePath, defaultValue) {
  const backupPath = `${filePath}.last-good`;
  if (!fs.existsSync(filePath) && !fs.existsSync(backupPath)) return defaultValue;
  try { return parsePreferenceJson(filePath); }
  catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== "ENOENT") throw error;
    let recovered;
    try { recovered = parsePreferenceJson(backupPath); }
    catch { throw new Error(`Cannot read ${path.basename(filePath)} and no valid recovery copy is available. Existing files were not replaced.`); }
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.${randomUUID()}.corrupt`, fs.constants.COPYFILE_EXCL);
    writeJsonAtomic(filePath, recovered);
    console.warn(`Recovered ${path.basename(filePath)} from its last-known-good copy. Review the restored preferences before running a workflow.`);
    return recovered;
  }
}

function writeRecoverableJson(filePath, value) {
  const previous = fs.existsSync(filePath) ? parsePreferenceJson(filePath) : value;
  writeJsonAtomic(`${filePath}.last-good`, previous);
  writeJsonAtomic(filePath, value);
}

// Write-to-temp-then-rename so a mid-write crash cannot corrupt the target file.
function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = {
  ensureDir,
  ensureJsonFile,
  readJson,
  writeJson,
  writeJsonAtomic,
  readRecoverableJson,
  writeRecoverableJson,
};
