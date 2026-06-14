const path = require("path");
const {
  generateObjectScripts,
  listGeneratedObjectScripts,
  findLatestCombinedStoredProcedureScript,
} = require("./scriptAutomationService");

function normalizeSelectedObjects(selectedObjects = []) {
  return (selectedObjects || [])
    .map((item) => ({
      objectType: String(item.objectType || "").toUpperCase().trim(),
      schemaName: String(item.schemaName || "").trim(),
      objectName: String(item.objectName || "").trim(),
    }))
    .filter((item) => item.objectType && item.schemaName && item.objectName);
}

async function generateScriptsForProfile({ taskId, profile, selectedObjects, outputBasePath, appTaskMode = "backup" }) {
  const cleanObjects = normalizeSelectedObjects(selectedObjects);
  if (!cleanObjects.length) {
    throw new Error("No valid objects supplied.");
  }

  const generated = await generateObjectScripts({
    taskId,
    profile,
    selectedObjects: cleanObjects,
    outputBasePath,
    appTaskMode,
  });

  const scripts = listGeneratedObjectScripts(generated.runRoot, generated.latestBuildPathFile);
  const combinedStoredProceduresPath = appTaskMode === "backup"
    ? findLatestCombinedStoredProcedureScript(generated.runRoot)
    : null;

  return {
    generated,
    scripts,
    combinedStoredProceduresPath,
    selectedObjects: cleanObjects,
  };
}

function getCodeDiffOutputPaths(taskId) {
  const codediffRoot = path.resolve(__dirname, "..", "..", "artifacts", "exports", "codediff");
  return {
    sourceOut: path.join(codediffRoot, `${taskId}_source`),
    destOut: path.join(codediffRoot, `${taskId}_dest`),
  };
}

module.exports = {
  normalizeSelectedObjects,
  generateScriptsForProfile,
  getCodeDiffOutputPaths,
};
