const { ensureDir } = require("./storage");
const { generateScriptsForProfile, normalizeSelectedObjects } = require("./scriptGenerationService");
const { validateGeneratedArtifacts } = require("./dacfxService");
const { getSettings } = require("./settingsService");
const { EXPORTS_DIR } = require("./paths");

async function runBackup(profile, selectedObjects, options, task, onProgress = () => {}) {
  if (options?.formatAndExecute) {
    throw new Error("Backup is script generation only. Use Deployment to execute changes.");
  }
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

  const formatAndExecute = { enabled: false };

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
    backupMode: "ObjectScriptGenerationOnly",
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
