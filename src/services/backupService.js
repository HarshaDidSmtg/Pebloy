const path = require("path");
const { ensureDir } = require("./storage");
const { generateScriptsForProfile, normalizeSelectedObjects } = require("./scriptGenerationService");

async function runBackup(profile, selectedObjects, options, task, onProgress = () => {}) {
  const cleanObjects = normalizeSelectedObjects(selectedObjects);
  if (!cleanObjects.length) {
    throw new Error("Select one or more objects to back up.");
  }

  const backupRoot = options.destinationPath || path.resolve(__dirname, "..", "..", "artifacts", "exports");
  ensureDir(backupRoot);

  onProgress({ taskType: "Backup", key: "backup", operation: "Generating scripts...", percent: 35 });

  const { generated } = await generateScriptsForProfile({
    taskId: task.taskId,
    profile,
    selectedObjects: cleanObjects,
    outputBasePath: backupRoot,
    appTaskMode: "backup",
  });

  onProgress({ taskType: "Backup", key: "backup", operation: "Finalizing backup output...", percent: 90 });

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
    scriptStdout: generated.scriptStdout,
  };
}

module.exports = {
  runBackup,
};
