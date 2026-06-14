const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { execFile } = require("child_process");
const { ensureDir } = require("./storage");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const TEMP_DIR = process.env.TEMP_DIR || path.resolve(ROOT_DIR, "artifacts", "temp");
const VENDOR_MODULES_DIR = path.resolve(ROOT_DIR, "vendor", "ps-modules");

function resolvePowerShellScriptPath(envValue, scriptName) {
  if (envValue) {
    return envValue;
  }

  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.resolve(process.resourcesPath, "scripts", "powershell", scriptName));
  }
  candidates.push(path.resolve(ROOT_DIR, "scripts", "powershell", scriptName));

  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[candidates.length - 1];
}

const DB_OBJECTS_SCRIPT = resolvePowerShellScriptPath(process.env.DB_OBJECTS_SCRIPT, "DBObjectsBulkScriptGenerator.ps1");
const TABLE_DELTA_SCRIPT = resolvePowerShellScriptPath(process.env.TABLE_DELTA_SCRIPT, "CompareTablesGenerateDelta.ps1");

function timestampForFile() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

function getRunDateFolderName(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function sanitizePathSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "_")
    .replace(/\.+$/g, "");
}

function buildProfileOutputBasePath(outputBasePath, profileLabel) {
  const aliasSegment = sanitizePathSegment(profileLabel);
  return aliasSegment ? path.join(outputBasePath, aliasSegment) : outputBasePath;
}

function buildRunRoot(outputBasePath, databaseName) {
  return path.join(outputBasePath, getRunDateFolderName(), normalizeSqlName(databaseName));
}

const { normalizeAuthType, normalizeSqlName } = require("./utils");
const { getSettings } = require("./settingsService");

function dedupeObjectNames(selectedObjects = []) {
  const set = new Set();
  for (const item of selectedObjects) {
    const schemaName = String(item.schemaName || "").trim();
    const objectName = String(item.objectName || "").trim();
    if (!schemaName || !objectName) continue;
    set.add(`${schemaName}.${objectName}`);
  }
  return [...set];
}

function createObjectListFile(taskId, selectedObjects) {
  ensureDir(TEMP_DIR);
  const objectNames = dedupeObjectNames(selectedObjects);
  if (!objectNames.length) {
    throw new Error("No valid objects supplied.");
  }

  const filePath = path.join(TEMP_DIR, `${timestampForFile()}_${taskId}_objects.txt`);
  fs.writeFileSync(filePath, `${objectNames.join(os.EOL)}${os.EOL}`, "utf8");

  // Sidecar JSON file with pre-resolved object types so the PS scripter can
  // skip its own sys.objects discovery query. Back-compat: PS script tries
  // the sidecar first and falls back to parsing the .txt if absent.
  const typed = selectedObjects
    .map((item) => {
      const schemaName = String(item.schemaName || "").trim();
      const objectName = String(item.objectName || "").trim();
      const objectType = String(item.objectType || "").trim().toUpperCase();
      if (!schemaName || !objectName || !objectType) return null;
      return { schemaName, objectName, objectType };
    })
    .filter(Boolean);

  if (typed.length === objectNames.length) {
    const sidecarPath = filePath.replace(/\.txt$/i, ".json");
    fs.writeFileSync(sidecarPath, JSON.stringify(typed, null, 2), "utf8");
  }

  return filePath;
}

function buildPsModulePath() {
  const userHome = os.homedir();
  const candidates = [
    VENDOR_MODULES_DIR,
    path.join(userHome, "Documents", "PowerShell", "Modules"),
  ];
  const existing = candidates.filter((p) => fs.existsSync(p));
  return existing.join(path.delimiter);
}

let _sqlServerModulePromise = null;
function ensureSqlServerModule() {
  if (_sqlServerModulePromise) return _sqlServerModulePromise;

  const moduleDir = path.join(VENDOR_MODULES_DIR, "SqlServer");
  if (fs.existsSync(moduleDir)) {
    _sqlServerModulePromise = Promise.resolve();
    return _sqlServerModulePromise;
  }

  fs.mkdirSync(VENDOR_MODULES_DIR, { recursive: true });
  const installScript = `Save-Module -Name SqlServer -Path '${VENDOR_MODULES_DIR.replace(/'/g, "''")}' -Force -ErrorAction Stop`;

  _sqlServerModulePromise = new Promise((resolve, reject) => {
    execFile(
      "pwsh",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", installScript],
      { encoding: "utf8", timeout: 300000 },
      (error, stdout, stderr) => {
        if (error) {
          // Drop the cache so a retry can attempt re-install
          _sqlServerModulePromise = null;
          reject(new Error(`SqlServer module install failed: ${String(stderr || stdout || error.message).trim()}`));
        } else {
          resolve();
        }
      }
    );
  });
  return _sqlServerModulePromise;
}

function runPowerShellFile(scriptPath, args, timeoutMs = 900000) {
  return new Promise((resolve, reject) => {
    const fullArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args];

    const extraModulePaths = buildPsModulePath();
    const env = { ...process.env };
    if (extraModulePaths) {
      env.PSModulePath = extraModulePaths + path.delimiter + (env.PSModulePath || "");
    }

    execFile("pwsh", fullArgs, { encoding: "utf8", maxBuffer: 1024 * 1024 * 50, timeout: timeoutMs, env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || stdout || error.message || "PowerShell script failed").trim()));
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function hasSqlCredentials(profile) {
  return Boolean(String(profile.username || "").trim() && String(profile.password || "").trim());
}

function getProfileAuthType(profile) {
  return normalizeAuthType(profile.authenticationType);
}

function buildDbObjectsGeneratorArgs(profile, objectListPath, outputBasePath, options = {}) {
  const authType = profile.authenticationType ? String(profile.authenticationType).trim() : "Windows";
  const args = [
    "-Server",
    normalizeSqlName(profile.serverName),
    "-Databases",
    normalizeSqlName(profile.databaseName),
    "-ObjectListPath",
    objectListPath,
    "-OutputBasePath",
    outputBasePath,
    "-BuildPathFileName",
    "BuildPaths.txt",
    "-AuthenticationType",
    getProfileAuthType(profile),
  ];

  if (getProfileAuthType(profile) === "Sql" && hasSqlCredentials(profile)) {
    args.push("-Username", String(profile.username).trim(), "-Password", String(profile.password));
  }

  args.push("-FolderNameOverrides", buildFolderNameOverridesJson());
  args.push("-app_task_mode", options.appTaskMode || "backup");

  return args;
}

async function generateObjectScripts({ taskId, profile, selectedObjects, outputBasePath, appTaskMode = "backup" }) {
  const objectListPath = createObjectListFile(taskId || randomUUID(), selectedObjects || []);
  const effectiveOutputBasePath = buildProfileOutputBasePath(outputBasePath, profile?.profileLabel);
  ensureDir(effectiveOutputBasePath);

  const args = buildDbObjectsGeneratorArgs(profile, objectListPath, effectiveOutputBasePath, { appTaskMode });
  try {
    const runResult = await runPowerShellFile(DB_OBJECTS_SCRIPT, args);

    const runRoot = buildRunRoot(effectiveOutputBasePath, profile.databaseName);
    const buildPathFiles = fs.existsSync(runRoot)
      ? fs
          .readdirSync(runRoot)
          .filter((name) => /^BuildPaths_\d{8}_\d{6}\.txt$/i.test(name))
          .sort()
      : [];

    const latestBuildPathFile = buildPathFiles.length ? path.join(runRoot, buildPathFiles[buildPathFiles.length - 1]) : null;

    return {
      objectListPath,
      outputBasePath: effectiveOutputBasePath,
      runRoot,
      latestBuildPathFile,
      scriptStdout: runResult.stdout,
    };
  } catch (error) {
    throw new Error(`Bulk script generation failed: ${error.message}`);
  }
}

function mapFolderTypeToObjectType(folderName) {
  const name = String(folderName || "").trim().toLowerCase();
  // Check against current settings-based folder names first
  const settings = getSettings();
  for (const [objectType, folder] of Object.entries(settings.folderNames)) {
    if (folder.toLowerCase() === name) return objectType;
  }
  // Fallback to defaults in case settings differ
  if (name === "stored procedures") return "PROCEDURE";
  if (name === "views") return "VIEW";
  if (name === "functions") return "FUNCTION";
  if (name === "synonyms") return "SYNONYM";
  if (name === "sequences") return "SEQUENCE";
  if (name === "user defined types") return "USER_DEFINED_TYPE";
  if (name === "tables") return "TABLE";
  return "OTHER";
}

function buildFolderNameOverridesJson() {
  const settings = getSettings();
  const fn = settings.folderNames;
  // Map from PS TypeDesc keys to folder names
  const overrides = {
    USER_TABLE: fn.TABLE || "Tables",
    VIEW: fn.VIEW || "Views",
    SQL_STORED_PROCEDURE: fn.PROCEDURE || "Stored Procedures",
    SYNONYM: fn.SYNONYM || "Synonyms",
    SEQUENCE_OBJECT: fn.SEQUENCE || "Sequences",
    USER_TABLE_TYPE: fn.USER_DEFINED_TYPE || "User Defined Types",
    FUNCTION: fn.FUNCTION || "Functions",
  };
  return JSON.stringify(overrides);
}

function listGeneratedObjectScripts(runRoot, buildPathsFile) {
  if (!runRoot || !fs.existsSync(runRoot)) {
    return [];
  }

  const entries = [];
  if (buildPathsFile && fs.existsSync(buildPathsFile)) {
    const lines = fs
      .readFileSync(buildPathsFile, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const match = line.match(/<Build Include="([^"]+)"\s*\/>/i);
      if (!match) continue;
      const relative = match[1].replace(/\\/g, path.sep);
      const fullPath = path.join(runRoot, relative);
      if (!fs.existsSync(fullPath)) continue;

      const parts = relative.split(/[\\/]/);
      const schemaName = parts[0] || "dbo";
      const folderName = parts[1] || "";
      const objectType = mapFolderTypeToObjectType(folderName);
      const fileName = path.basename(fullPath, ".sql");

      entries.push({
        schemaName,
        objectName: fileName,
        objectType,
        scriptPath: fullPath,
      });
    }
  }

  return entries;
}

function findLatestCombinedStoredProcedureScript(runRoot) {
  if (!runRoot || !fs.existsSync(runRoot)) {
    return null;
  }

  const candidateNames = fs
    .readdirSync(runRoot)
    .filter((name) => /^AllStoredProcedures_\d{8}_\d{6}\.sql$/i.test(name))
    .sort();

  if (!candidateNames.length) {
    return null;
  }

  return path.join(runRoot, candidateNames[candidateNames.length - 1]);
}

function buildTableObjectList(selectedObjects = []) {
  return (selectedObjects || []).filter((x) => String(x.objectType || "").toUpperCase() === "TABLE");
}

async function generateTableDelta({
  taskId,
  sourceProfile,
  destinationProfile,
  selectedObjects,
  outputDir,
}) {
  const tableObjects = buildTableObjectList(selectedObjects);
  if (!tableObjects.length) {
    return null;
  }

  ensureDir(outputDir);
  const objectListPath = createObjectListFile(`${taskId}_tables`, tableObjects);
  const outputPath = path.join(outputDir, `${timestampForFile()}_${taskId}_table_delta.sql`);

  const args = [
    "-SourceServer",
    normalizeSqlName(sourceProfile.serverName),
    "-SourceDatabase",
    normalizeSqlName(sourceProfile.databaseName),
    "-TargetServer",
    normalizeSqlName(destinationProfile.serverName),
    "-TargetDatabase",
    normalizeSqlName(destinationProfile.databaseName),
    "-ObjectListPath",
    objectListPath,
    "-OutputPath",
    outputPath,
    "-SourceAuthenticationType",
    getProfileAuthType(sourceProfile),
    "-TargetAuthenticationType",
    getProfileAuthType(destinationProfile),
  ];

  if (getProfileAuthType(sourceProfile) === "Sql" && hasSqlCredentials(sourceProfile)) {
    args.push("-SourceUsername", String(sourceProfile.username).trim(), "-SourcePassword", String(sourceProfile.password));
  }

  if (getProfileAuthType(destinationProfile) === "Sql" && hasSqlCredentials(destinationProfile)) {
    args.push("-TargetUsername", String(destinationProfile.username).trim(), "-TargetPassword", String(destinationProfile.password));
  }

  try {
    const runResult = await runPowerShellFile(TABLE_DELTA_SCRIPT, args);
    return {
      objectListPath,
      outputPath,
      scriptStdout: runResult.stdout,
      scriptText: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8").trim() : "",
    };
  } catch (error) {
    throw new Error(`Table delta generation failed: ${error.message}`);
  }
}

function normalizeDdlKeywords(text) {
  text = text.replace(/\bCREATE\s*\n\s*OR\s*\n?\s*ALTER\b/gi, "CREATE OR ALTER");
  text = text.replace(/\b(CREATE(?:\s+OR\s+ALTER)?|ALTER)\s*\n\s*(PROCEDURE|PROC|VIEW|FUNCTION|TRIGGER|TABLE|INDEX)\b/gi,
    (_, verb, noun) => `${verb.replace(/\s+/g, " ")} ${noun}`
  );
  return text;
}

function normalizeExecutableSql(sqlText, objectType, context = {}, options = {}) {
  let text = String(sqlText || "");
  text = normalizeDdlKeywords(text);
  text = text.replace(/^\s*GO\s*$/gim, "").trim();

  const type = String(objectType || "").toUpperCase();
  const strategy = options.strategy || "createOrAlter";

  if (strategy === "createOrAlter" && ["PROCEDURE", "VIEW", "FUNCTION", "TRIGGER"].includes(type)) {
    text = text
      .replace(/\bCREATE\s+PROCEDURE\b/i, "CREATE OR ALTER PROCEDURE")
      .replace(/\bCREATE\s+PROC\b/i, "CREATE OR ALTER PROCEDURE")
      .replace(/\bCREATE\s+VIEW\b/i, "CREATE OR ALTER VIEW")
      .replace(/\bCREATE\s+FUNCTION\b/i, "CREATE OR ALTER FUNCTION")
      .replace(/\bCREATE\s+TRIGGER\b/i, "CREATE OR ALTER TRIGGER");
  }

  const { schemaName, objectName } = context;
  if (schemaName && objectName) {
    const q = `[${String(schemaName).replace(/]/g, "]]")}].[${String(objectName).replace(/]/g, "]]")}]`;

    if (strategy === "dropCreate") {
      if (type === "VIEW") {
        text = `IF OBJECT_ID(N'${q}', 'V') IS NOT NULL DROP VIEW ${q};\n${text}`;
      } else if (type === "FUNCTION") {
        text = `IF OBJECT_ID(N'${q}', 'FN') IS NOT NULL DROP FUNCTION ${q};\nIF OBJECT_ID(N'${q}', 'TF') IS NOT NULL DROP FUNCTION ${q};\nIF OBJECT_ID(N'${q}', 'IF') IS NOT NULL DROP FUNCTION ${q};\n${text}`;
      } else if (type === "TRIGGER") {
        text = `IF OBJECT_ID(N'${q}', 'TR') IS NOT NULL DROP TRIGGER ${q};\n${text}`;
      } else if (type === "SYNONYM") {
        text = `IF OBJECT_ID(N'${q}', 'SN') IS NOT NULL DROP SYNONYM ${q};\n${text}`;
      } else if (type === "SEQUENCE") {
        text = `IF OBJECT_ID(N'${q}', 'SO') IS NOT NULL DROP SEQUENCE ${q};\n${text}`;
      } else if (type === "USER_DEFINED_TYPE") {
        text = `IF TYPE_ID('${q}') IS NOT NULL DROP TYPE ${q};\n${text}`;
      }
      return text;
    }

    if (type === "SYNONYM") {
      text = `IF OBJECT_ID(N'${q}', 'SN') IS NOT NULL DROP SYNONYM ${q};\n${text}`;
    } else if (type === "SEQUENCE") {
      text = `IF OBJECT_ID(N'${q}', 'SO') IS NOT NULL DROP SEQUENCE ${q};\n${text}`;
    } else if (type === "USER_DEFINED_TYPE") {
      text = `IF TYPE_ID('${q}') IS NOT NULL DROP TYPE ${q};\n${text}`;
    }
  }

  return text;
}

module.exports = {
  createObjectListFile,
  generateObjectScripts,
  listGeneratedObjectScripts,
  findLatestCombinedStoredProcedureScript,
  buildProfileOutputBasePath,
  buildRunRoot,
  generateTableDelta,
  normalizeExecutableSql,
  normalizeDdlKeywords,
  ensureSqlServerModule,
};
