const fs = require("fs");
const path = require("path");
const {
  generateObjectScripts,
  listGeneratedObjectScripts,
  findLatestCombinedStoredProcedureScript,
  normalizeExecutableSql,
} = require("./scriptAutomationService");
const { fetchObjectDefinitionMap } = require("./sqlService");

const EXACT_DEFINITION_OBJECT_TYPES = new Set(["PROCEDURE", "VIEW", "FUNCTION", "TRIGGER"]);

function objectKey(item = {}) {
  return [
    String(item.objectType || "").toUpperCase().trim(),
    String(item.schemaName || "").trim().toLowerCase(),
    String(item.objectName || "").trim().toLowerCase(),
  ].join("|");
}

function normalizeExactDefinitionText(text) {
  return String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
}

function toWindowsLineEndings(text) {
  return String(text || "").replace(/\r?\n/g, "\r\n");
}

function definitionRows(definitions) {
  if (definitions instanceof Map) {
    return [...definitions.values()];
  }
  if (Array.isArray(definitions)) {
    return definitions;
  }
  return [];
}

function buildCombinedStoredProcedureText(scripts = []) {
  const parts = [];
  for (const script of scripts) {
    const sqlText = toWindowsLineEndings(
      normalizeExecutableSql(script.definitionText || "", "PROCEDURE", {}, { strategy: "createOrAlter" })
    ).trim();
    if (!sqlText) continue;
    parts.push(sqlText, "GO");
  }
  return parts.join("\r\n\r\n").trim();
}

async function syncProgrammableScriptsWithExactDefinitions({ profile, scripts = [], combinedStoredProceduresPath = null }) {
  const programmableScripts = (scripts || []).filter((item) => EXACT_DEFINITION_OBJECT_TYPES.has(String(item.objectType || "").toUpperCase()));
  if (!programmableScripts.length) {
    return { exactDefinitionsApplied: 0, exactDefinitionWarning: null };
  }

  let definitions;
  try {
    definitions = await fetchObjectDefinitionMap(profile, programmableScripts);
  } catch (error) {
    return {
      exactDefinitionsApplied: 0,
      exactDefinitionWarning: error.message || String(error),
    };
  }

  const definitionMap = new Map();
  for (const definition of definitionRows(definitions)) {
    const definitionText = normalizeExactDefinitionText(definition.definition);
    if (!definitionText) continue;
    definitionMap.set(objectKey(definition), definitionText);
  }

  let exactDefinitionsApplied = 0;
  for (const script of programmableScripts) {
    const definitionText = definitionMap.get(objectKey(script));
    if (!definitionText || !script.scriptPath) continue;

    const exactText = toWindowsLineEndings(definitionText);

    fs.writeFileSync(script.scriptPath, exactText, "utf8");
    script.definitionText = exactText;
    exactDefinitionsApplied += 1;
  }

  if (combinedStoredProceduresPath) {
    const combinedText = buildCombinedStoredProcedureText(
      (scripts || []).filter((item) => String(item.objectType || "").toUpperCase() === "PROCEDURE" && item.definitionText)
    );
    if (combinedText) {
      fs.writeFileSync(combinedStoredProceduresPath, combinedText, "utf8");
    }
  }

  return { exactDefinitionsApplied, exactDefinitionWarning: null };
}

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
  const definitionSync = await syncProgrammableScriptsWithExactDefinitions({
    profile,
    scripts,
    combinedStoredProceduresPath,
  });

  return {
    generated,
    scripts,
    combinedStoredProceduresPath,
    selectedObjects: cleanObjects,
    ...definitionSync,
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
  buildCombinedStoredProcedureText,
  normalizeSelectedObjects,
  generateScriptsForProfile,
  getCodeDiffOutputPaths,
  syncProgrammableScriptsWithExactDefinitions,
};
