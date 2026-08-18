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

const { timestampForFile } = require("./timeService");

// NOTE: deliberately system-time based (NOT the configurable app timezone).
// The PowerShell generator computes this same folder name with Get-Date on
// the local machine, and both sides must resolve the identical path.
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
const { writeSqlFileSync } = require("./sqlFileEncoding");

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

function stripAnsiCodes(text) {
  return String(text || "").replace(/\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function extractPsErrorContext(stderr, stdout) {
  const combined = stripAnsiCodes([stderr, stdout].filter(Boolean).join("\n"));

  // Pull the first non-empty "At ... line N" or "CategoryInfo" or "FullyQualifiedErrorId" fragment
  const atMatch = combined.match(/At\s+.+?\.ps1\s*:\s*line\s+\d+/i);
  const categoryMatch = combined.match(/CategoryInfo\s*:\s*([^\r\n]+)/i);
  const errorIdMatch = combined.match(/FullyQualifiedErrorId\s*:\s*([^\r\n]+)/i);
  // Extract the first ERROR: line written by our own scripts
  const scriptErrorMatch = combined.match(/^(?:ERROR|WARN)\s*:\s*(.+)$/im);

  const parts = [];
  if (scriptErrorMatch) parts.push(scriptErrorMatch[1].trim());
  if (atMatch) parts.push(atMatch[0].trim());
  if (categoryMatch) parts.push(`Category: ${categoryMatch[1].trim()}`);
  if (errorIdMatch) parts.push(`ErrorId: ${errorIdMatch[1].trim()}`);

  return parts.length ? parts.join(" | ") : null;
}

function runPowerShellFile(scriptPath, args, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const fullArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args];

    const extraModulePaths = buildPsModulePath();
    const env = { ...process.env };
    if (extraModulePaths) {
      env.PSModulePath = extraModulePaths + path.delimiter + (env.PSModulePath || "");
    }

    env.NO_COLOR = "1";
    env.TERM = "dumb";

    const execOptions = { encoding: "utf8", maxBuffer: 1024 * 1024 * 50, env };
    if (timeoutMs > 0) {
      execOptions.timeout = timeoutMs;
    }

    execFile("pwsh", fullArgs, execOptions, (error, stdout, stderr) => {
      if (error) {
        const context = extractPsErrorContext(String(stderr || ""), String(stdout || ""));
        const base = stripAnsiCodes(String(stderr || stdout || error.message || "PowerShell script failed")).trim();
        const message = context ? `${base}\n[Detail] ${context}` : base;
        reject(new Error(message));
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

function listRunArtifactNames(runRoot, pattern) {
  if (!runRoot || !fs.existsSync(runRoot)) {
    return [];
  }
  return fs.readdirSync(runRoot).filter((name) => pattern.test(name)).sort();
}

function parseStdoutArtifactPath(stdout, label) {
  const match = String(stdout || "").match(new RegExp(`^\\s*${label}:\\s*(.+?)\\s*$`, "im"));
  if (!match) return null;
  const candidate = match[1].trim();
  return candidate && fs.existsSync(candidate) ? candidate : null;
}

// The run folder is shared by every run of the same day, so "latest by
// filename" can belong to an earlier or concurrent run. Resolve THIS run's
// artifacts: the path the PS script printed, else a file that did not exist
// before the run started. Never silently fall back to an older run's file.
function resolveRunArtifact({ runRoot, stdout, stdoutLabel, pattern, preexistingNames }) {
  const fromStdout = parseStdoutArtifactPath(stdout, stdoutLabel);
  if (fromStdout) return fromStdout;

  const created = listRunArtifactNames(runRoot, pattern).filter((name) => !preexistingNames.has(name));
  return created.length ? path.join(runRoot, created[created.length - 1]) : null;
}

const BUILD_PATHS_PATTERN = /^BuildPaths_\d{8}_\d{6}\.txt$/i;
const COMBINED_SP_PATTERN = /^AllStoredProcedures_\d{8}_\d{6}\.sql$/i;

async function generateObjectScripts({ taskId, profile, selectedObjects, outputBasePath, appTaskMode = "backup" }) {
  const objectListPath = createObjectListFile(taskId || randomUUID(), selectedObjects || []);
  const effectiveOutputBasePath = buildProfileOutputBasePath(outputBasePath, profile?.profileLabel);
  ensureDir(effectiveOutputBasePath);

  const runRoot = buildRunRoot(effectiveOutputBasePath, profile.databaseName);
  const preexistingBuildPaths = new Set(listRunArtifactNames(runRoot, BUILD_PATHS_PATTERN));
  const preexistingCombinedSp = new Set(listRunArtifactNames(runRoot, COMBINED_SP_PATTERN));

  const args = buildDbObjectsGeneratorArgs(profile, objectListPath, effectiveOutputBasePath, { appTaskMode });
  try {
    const runResult = await runPowerShellFile(DB_OBJECTS_SCRIPT, args);

    const latestBuildPathFile = resolveRunArtifact({
      runRoot,
      stdout: runResult.stdout,
      stdoutLabel: "BuildPaths file",
      pattern: BUILD_PATHS_PATTERN,
      preexistingNames: preexistingBuildPaths,
    });

    if (!latestBuildPathFile) {
      throw new Error(
        "Script generation completed but did not produce a fresh BuildPaths manifest for this run. " +
        "Refusing to reuse artifacts from a previous run."
      );
    }

    const combinedStoredProceduresPath = resolveRunArtifact({
      runRoot,
      stdout: runResult.stdout,
      stdoutLabel: "Combined SP file",
      pattern: COMBINED_SP_PATTERN,
      preexistingNames: preexistingCombinedSp,
    });

    return {
      objectListPath,
      outputBasePath: effectiveOutputBasePath,
      runRoot,
      latestBuildPathFile,
      combinedStoredProceduresPath,
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
  if (name === "triggers") return "TRIGGER";
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
    let scriptText = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8").trim() : "";

    // Optional formatting (Settings → "Format Generated SQL"); best-effort —
    // the formatter keeps GO batches and falls back to original text on any
    // batch it cannot parse, so execution behavior is unchanged.
    try {
      if (scriptText && getSettings()?.formatting?.formatGeneratedSql) {
        const { formatGeneratedSql } = require("./formatterService");
        const formatted = formatGeneratedSql(scriptText);
        if (formatted !== scriptText) {
          writeSqlFileSync(outputPath, formatted);
          scriptText = formatted.trim();
        }
      }
    } catch (_e) {
      // keep unformatted delta
    }

    return {
      objectListPath,
      outputPath,
      scriptStdout: runResult.stdout,
      scriptText,
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

function supportsModuleBatchHeaders(objectType) {
  return ["PROCEDURE", "VIEW", "FUNCTION", "TRIGGER"].includes(String(objectType || "").toUpperCase());
}

function collectModuleBatchHeader(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const headerLines = [];
  let index = 0;

  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      if (!headerLines.length) {
        index += 1;
        continue;
      }
      break;
    }

    if (/^SET\s+(?:ANSI_NULLS|QUOTED_IDENTIFIER)\s+(?:ON|OFF)\s*;?$/i.test(trimmed)) {
      headerLines.push(trimmed.replace(/;$/, ""));
      index += 1;
      continue;
    }

    break;
  }

  const body = lines.slice(index).join("\n").trim();
  return { headerLines, body };
}

function buildMetadataHeaderLines(moduleMetadata = {}) {
  const headerLines = [];
  if (moduleMetadata.usesAnsiNulls != null) {
    headerLines.push(`SET ANSI_NULLS ${moduleMetadata.usesAnsiNulls ? "ON" : "OFF"}`);
  }
  if (moduleMetadata.usesQuotedIdentifier != null) {
    headerLines.push(`SET QUOTED_IDENTIFIER ${moduleMetadata.usesQuotedIdentifier ? "ON" : "OFF"}`);
  }
  return headerLines;
}

function normalizeModuleBatchHeaders(text, objectType, moduleMetadata = null) {
  const type = String(objectType || "").toUpperCase();
  if (!supportsModuleBatchHeaders(type)) {
    return String(text || "").trim();
  }

  const { headerLines: existingHeaderLines, body } = collectModuleBatchHeader(text);
  const headerLines = buildMetadataHeaderLines(moduleMetadata || {});
  const effectiveHeaderLines = headerLines.length ? headerLines : existingHeaderLines;

  if (!effectiveHeaderLines.length) {
    return body || String(text || "").trim();
  }

  if (!body) {
    return effectiveHeaderLines.join("\nGO\n");
  }

  return `${effectiveHeaderLines.join("\nGO\n")}\nGO\n${body}`.trim();
}

function wrapUserDefinedTypeDeploySql(sqlText, lookupName, qualifiedName) {
  const escapedSql = String(sqlText || "").replace(/'/g, "''");
  const escapedLookupName = String(lookupName || "").replace(/'/g, "''");
  const escapedDropSql = `DROP TYPE ${qualifiedName};`.replace(/'/g, "''");
  return [
    `DECLARE @PebloyTypeName nvarchar(776) = N'${escapedLookupName}';`,
    `DECLARE @PebloyTypeDropSql nvarchar(max) = N'${escapedDropSql}';`,
    "DECLARE @PebloyTypeId int = TYPE_ID(@PebloyTypeName);",
    "DECLARE @PebloyDependentModules TABLE (",
    "  schemaName sysname NOT NULL,",
    "  objectName sysname NOT NULL,",
    "  objectType char(2) NOT NULL,",
    "  definition nvarchar(max) NOT NULL,",
    "  PRIMARY KEY (schemaName, objectName, objectType)",
    ");",
    "",
    "IF @PebloyTypeId IS NOT NULL",
    "BEGIN",
    "  INSERT INTO @PebloyDependentModules (schemaName, objectName, objectType, definition)",
    "  SELECT DISTINCT s.name, o.name, o.type, m.definition",
    "  FROM (",
    "    SELECT p.object_id",
    "    FROM sys.parameters p",
    "    WHERE p.user_type_id = @PebloyTypeId",
    "    UNION",
    "    SELECT sed.referencing_id",
    "    FROM sys.sql_expression_dependencies sed",
    "    WHERE sed.referenced_class = 6 AND sed.referenced_id = @PebloyTypeId",
    "  ) dep",
    "  INNER JOIN sys.objects o ON o.object_id = dep.object_id",
    "  INNER JOIN sys.schemas s ON s.schema_id = o.schema_id",
    "  INNER JOIN sys.sql_modules m ON m.object_id = o.object_id",
    "  WHERE o.type IN ('P', 'FN', 'IF', 'TF')",
    "    AND m.definition IS NOT NULL;",
    "",
    "  DECLARE @PebloyDropSql nvarchar(max);",
    "  DECLARE PebloyDropCursor CURSOR LOCAL FAST_FORWARD FOR",
    "    SELECT CASE WHEN objectType = 'P' THEN N'DROP PROCEDURE ' ELSE N'DROP FUNCTION ' END +",
    "           QUOTENAME(schemaName) + N'.' + QUOTENAME(objectName) + N';'",
    "    FROM @PebloyDependentModules",
    "    ORDER BY CASE WHEN objectType = 'P' THEN 1 ELSE 2 END;",
    "  OPEN PebloyDropCursor;",
    "  FETCH NEXT FROM PebloyDropCursor INTO @PebloyDropSql;",
    "  WHILE @@FETCH_STATUS = 0",
    "  BEGIN",
    "    EXEC(@PebloyDropSql);",
    "    FETCH NEXT FROM PebloyDropCursor INTO @PebloyDropSql;",
    "  END",
    "  CLOSE PebloyDropCursor;",
    "  DEALLOCATE PebloyDropCursor;",
    "",
    "  EXEC(@PebloyTypeDropSql);",
    "END",
    "",
    `EXEC(N'${escapedSql}');`,
    "",
    "DECLARE @PebloyCreateSql nvarchar(max);",
    "DECLARE PebloyCreateCursor CURSOR LOCAL FAST_FORWARD FOR",
    "  SELECT definition",
    "  FROM @PebloyDependentModules",
    "  ORDER BY CASE WHEN objectType IN ('FN', 'IF', 'TF') THEN 1 ELSE 2 END;",
    "OPEN PebloyCreateCursor;",
    "FETCH NEXT FROM PebloyCreateCursor INTO @PebloyCreateSql;",
    "WHILE @@FETCH_STATUS = 0",
    "BEGIN",
    "  EXEC(@PebloyCreateSql);",
    "  FETCH NEXT FROM PebloyCreateCursor INTO @PebloyCreateSql;",
    "END",
    "CLOSE PebloyCreateCursor;",
    "DEALLOCATE PebloyCreateCursor;",
  ].join("\n");
}

function normalizeExecutableSql(sqlText, objectType, context = {}, options = {}) {
  let text = String(sqlText || "");
  text = normalizeDdlKeywords(text);
  text = text.trim();

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

  text = normalizeModuleBatchHeaders(text, type, options.moduleMetadata || null);

  const { schemaName, objectName } = context;
  if (schemaName && objectName) {
    const escapedSchemaName = String(schemaName).replace(/]/g, "]]");
    const escapedObjectName = String(objectName).replace(/]/g, "]]");
    const q = `[${escapedSchemaName}].[${escapedObjectName}]`;
    const lookupName = `${String(schemaName).replace(/'/g, "''")}.${String(objectName).replace(/'/g, "''")}`;

    if (strategy === "dropCreate") {
      if (type === "VIEW") {
        text = `IF OBJECT_ID(N'${lookupName}', 'V') IS NOT NULL DROP VIEW ${q};\nGO\n${text}`;
      } else if (type === "FUNCTION") {
        text = `IF OBJECT_ID(N'${lookupName}', 'FN') IS NOT NULL DROP FUNCTION ${q};\nIF OBJECT_ID(N'${lookupName}', 'TF') IS NOT NULL DROP FUNCTION ${q};\nIF OBJECT_ID(N'${lookupName}', 'IF') IS NOT NULL DROP FUNCTION ${q};\nGO\n${text}`;
      } else if (type === "TRIGGER") {
        text = `IF OBJECT_ID(N'${lookupName}', 'TR') IS NOT NULL DROP TRIGGER ${q};\nGO\n${text}`;
      } else if (type === "SYNONYM") {
        text = `IF OBJECT_ID(N'${lookupName}', 'SN') IS NOT NULL DROP SYNONYM ${q};\nGO\n${text}`;
      } else if (type === "SEQUENCE") {
        text = `IF OBJECT_ID(N'${lookupName}', 'SO') IS NOT NULL DROP SEQUENCE ${q};\nGO\n${text}`;
      } else if (type === "USER_DEFINED_TYPE") {
        text = wrapUserDefinedTypeDeploySql(text, lookupName, q);
      }
      return text;
    }

    if (type === "SYNONYM") {
      text = `IF OBJECT_ID(N'${lookupName}', 'SN') IS NOT NULL DROP SYNONYM ${q};\n${text}`;
    } else if (type === "SEQUENCE") {
      text = `IF OBJECT_ID(N'${lookupName}', 'SO') IS NOT NULL DROP SEQUENCE ${q};\nGO\n${text}`;
    } else if (type === "USER_DEFINED_TYPE") {
      text = wrapUserDefinedTypeDeploySql(text, lookupName, q);
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
