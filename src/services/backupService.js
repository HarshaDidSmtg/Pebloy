const fs = require("fs");
const path = require("path");

const { ensureDir } = require("./storage");
const { generateScriptsForProfile, normalizeSelectedObjects } = require("./scriptGenerationService");
const { normalizeExecutableSql } = require("./scriptAutomationService");
const { executeSqlScriptsIndividually } = require("./sqlService");
const { formatGeneratedSql } = require("./formatterService");
const { validateGeneratedArtifacts } = require("./dacfxService");
const { getSettings } = require("./settingsService");
const { EXPORTS_DIR } = require("./paths");
const { writeSqlFileSync } = require("./sqlFileEncoding");

// Object types whose formatted definition can be re-applied to the source
// database (SQL Server stores the module text, so CREATE OR ALTER makes the
// formatted script the stored definition). Everything else has no stored
// SQL text to format, so execution is skipped for it.
const FORMAT_EXECUTABLE_TYPES = new Set(["PROCEDURE", "VIEW", "FUNCTION", "TRIGGER"]);

function readScriptText(script) {
  if (script.definitionText) return String(script.definitionText);
  if (script.scriptPath && fs.existsSync(script.scriptPath)) {
    return fs.readFileSync(script.scriptPath, "utf8");
  }
  return "";
}

function toWindowsLineEndings(text) {
  return String(text || "").replace(/\r?\n/g, "\r\n");
}

function writeFormatExecuteSql(outputDir, taskId, script, sqlText) {
  const safeName = `${taskId}_${String(script.objectType || "OBJECT").toUpperCase()}_${script.schemaName}_${script.objectName}`
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${safeName}.sql`);
  writeSqlFileSync(filePath, sqlText);
  return filePath;
}

// Formats every generated script file in place, then re-applies the
// formatted definition of each programmable module back to the SOURCE
// connection via CREATE OR ALTER (non-destructive: permissions and
// references stay intact). Returns a per-object result summary.
async function formatAndExecuteInSource(profile, scripts, { taskId, generatedRoot }, onProgress) {
  onProgress({ taskType: "Backup", key: "backup", operation: "Formatting generated scripts...", percent: 55 });

  let formattedCount = 0;
  for (const script of scripts || []) {
    const original = readScriptText(script);
    if (!original.trim() || !script.scriptPath) continue;
    const formatted = formatGeneratedSql(original);
    if (formatted !== original) {
      writeSqlFileSync(script.scriptPath, formatted);
      script.definitionText = formatted;
      formattedCount += 1;
    }
  }

  const executable = (scripts || []).filter((script) =>
    FORMAT_EXECUTABLE_TYPES.has(String(script.objectType || "").toUpperCase())
  );
  const skipped = (scripts || []).length - executable.length;

  const deploymentScriptDir = path.join(generatedRoot || EXPORTS_DIR, "Deployment Scripts");
  const entries = executable.map((script) => {
    const executableSql = toWindowsLineEndings(normalizeExecutableSql(
      readScriptText(script),
      script.objectType,
      { schemaName: script.schemaName, objectName: script.objectName },
      { strategy: "createOrAlter", moduleMetadata: script.moduleMetadata || null }
    ));
    return {
      key: `${String(script.objectType || "").toUpperCase()}|${String(script.schemaName || "").toLowerCase()}|${String(script.objectName || "").toLowerCase()}`,
      objectLabel: `${String(script.objectType).toUpperCase()} ${script.schemaName}.${script.objectName}`,
      scriptPath: writeFormatExecuteSql(deploymentScriptDir, taskId, script, executableSql),
      sqlText: executableSql,
    };
  });

  if (!entries.length) {
    return {
      enabled: true,
      formattedCount,
      executedCount: 0,
      failedCount: 0,
      skippedCount: skipped,
      failures: [],
    };
  }

  onProgress({
    taskType: "Backup",
    key: "backup",
    operation: `Executing ${entries.length} formatted module${entries.length === 1 ? "" : "s"} in source...`,
    percent: 75,
  });

  const executionResults = await executeSqlScriptsIndividually(profile, entries, { continueOnError: true });
  const resultByKey = new Map((executionResults || []).map((result) => [result.key, result]));

  const failures = [];
  let executedCount = 0;
  for (const entry of entries) {
    const result = resultByKey.get(entry.key);
    if (result && result.ok) {
      executedCount += 1;
    } else {
      failures.push({
        object: entry.objectLabel,
        scriptPath: entry.scriptPath,
        error: result?.errorMessage || "Execution result missing (session may have aborted).",
      });
    }
  }

  return {
    enabled: true,
    formattedCount,
    executedCount,
    failedCount: failures.length,
    skippedCount: skipped,
    failures,
    deploymentScriptDir,
  };
}

async function runBackup(profile, selectedObjects, options, task, onProgress = () => {}) {
  const cleanObjects = normalizeSelectedObjects(selectedObjects);
  if (!cleanObjects.length) {
    throw new Error("Select one or more objects to back up.");
  }

  const backupRoot = options.destinationPath || EXPORTS_DIR;
  ensureDir(backupRoot);

  onProgress({ taskType: "Backup", key: "backup", operation: "Generating scripts...", percent: 35 });

  const { generated, scripts = [], exactDefinitionsApplied, exactDefinitionWarning, generationWarnings = [] } = await generateScriptsForProfile({
    taskId: task.taskId,
    profile,
    selectedObjects: cleanObjects,
    outputBasePath: backupRoot,
    appTaskMode: "backup",
  });

  let formatAndExecute = { enabled: false };
  if (options.formatAndExecute) {
    formatAndExecute = await formatAndExecuteInSource(profile, scripts, {
      taskId: task.taskId,
      generatedRoot: generated.runRoot,
    }, onProgress);
  }

  let dacfxValidation = { enabled: false };
  if (getSettings().dacfx?.validationEnabled) {
    onProgress({ taskType: "Backup", key: "backup", operation: "Validating generated scripts with DacFx...", percent: 85 });
    const validationResult = await validateGeneratedArtifacts({
      taskId: `${task.taskId}_backup_validate`,
      scripts,
    });
    dacfxValidation = {
      enabled: true,
      ...validationResult,
    };
  }

  onProgress({ taskType: "Backup", key: "backup", operation: "Finalizing backup output...", percent: 95 });

  return {
    backupMode: options.formatAndExecute ? "ScriptGenerationWithFormatExecute" : "ObjectScriptGenerationOnly",
    objectCount: cleanObjects.length,
    backupFolder: backupRoot,
    generatedRoot: generated.runRoot,
    buildPathFile: generated.latestBuildPathFile,
    objectListPath: generated.objectListPath,
    restoreReadiness: {
      databaseName: profile.databaseName,
      serverName: profile.serverName,
      generatedAt: new Date().toISOString(),
      generatedRoot: generated.runRoot,
    },
    exactDefinitionsApplied,
    exactDefinitionWarning,
    generationWarnings,
    formatAndExecute,
    dacfxValidation,
    scriptStdout: generated.scriptStdout,
  };
}

module.exports = {
  runBackup,
};
