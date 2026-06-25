const fs = require("fs");
const { CODEDIFF_DIR } = require("./paths");
const {
  generateObjectScripts,
  listGeneratedObjectScripts,
  findLatestCombinedStoredProcedureScript,
  normalizeExecutableSql,
} = require("./scriptAutomationService");
const { fetchObjectDefinitionMap, normalizeBitFlag } = require("./sqlService");

const EXACT_DEFINITION_OBJECT_TYPES = new Set(["PROCEDURE", "VIEW", "FUNCTION", "TRIGGER"]);
const MODULE_TYPE_PATTERNS = {
  PROCEDURE: /^(?:CREATE|ALTER)\s+(?:PROCEDURE|PROC)\b/i,
  VIEW: /^(?:CREATE|ALTER)\s+VIEW\b/i,
  FUNCTION: /^(?:CREATE|ALTER)\s+FUNCTION\b/i,
  TRIGGER: /^(?:CREATE|ALTER)\s+TRIGGER\b/i,
};
const DEPLOY_WRAPPER_PATTERN = /^\s*(?:IF\s+(?:OBJECT_ID|TYPE_ID)\s*\(|DROP\s+(?:VIEW|FUNCTION|TRIGGER|SYNONYM|SEQUENCE|TYPE)\b)/i;
const LEADING_MODULE_HEADER_PATTERN = /^\s*SET\s+(?:ANSI_NULLS|QUOTED_IDENTIFIER)\s+(?:ON|OFF)\b/i;
const CREATE_OR_ALTER_PATTERN = /^\s*CREATE\s+OR\s+ALTER\s+(?:PROCEDURE|PROC|VIEW|FUNCTION|TRIGGER)\b/i;

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

function readScriptText(script = {}) {
  if (script.definitionText) {
    return String(script.definitionText || "");
  }
  if (!script.scriptPath) {
    return "";
  }
  return fs.readFileSync(script.scriptPath, "utf8");
}

function buildWarning(message, details = {}) {
  return {
    severity: "warning",
    message,
    ...details,
  };
}

function buildModuleMetadata(definition = {}) {
  return {
    usesAnsiNulls: normalizeBitFlag(definition.usesAnsiNulls),
    usesQuotedIdentifier: normalizeBitFlag(definition.usesQuotedIdentifier),
    definitionSource: "exact",
  };
}

function getExpectedModulePattern(objectType) {
  return MODULE_TYPE_PATTERNS[String(objectType || "").toUpperCase()] || null;
}

function validateScriptStartsWithExpectedModule(text, objectType) {
  const pattern = getExpectedModulePattern(objectType);
  if (!pattern) {
    return null;
  }

  const trimmed = normalizeExactDefinitionText(text);
  if (!pattern.test(trimmed)) {
    return `Expected the canonical ${String(objectType || "").toUpperCase()} source to start with CREATE/ALTER ${String(objectType || "").toUpperCase()}.`;
  }

  return null;
}

function validateCanonicalSourceArtifacts(scripts = []) {
  const errors = [];

  for (const script of scripts || []) {
    const objectType = String(script.objectType || "").toUpperCase();
    const text = normalizeExactDefinitionText(readScriptText(script));
    const objectLabel = `${script.schemaName || "dbo"}.${script.objectName || "<unknown>"}`;

    if (!text) {
      errors.push(`${objectType || "OBJECT"} ${objectLabel} is empty.`);
      continue;
    }

    if (objectType === "TABLE") {
      if (!/^CREATE\s+TABLE\b/i.test(text)) {
        errors.push(`TABLE ${objectLabel} must start with CREATE TABLE for deterministic DACPAC-safe source output.`);
      }
      if (DEPLOY_WRAPPER_PATTERN.test(text) || LEADING_MODULE_HEADER_PATTERN.test(text)) {
        errors.push(`TABLE ${objectLabel} contains deploy-only wrapper text or session-setting headers.`);
      }
      continue;
    }

    if (!EXACT_DEFINITION_OBJECT_TYPES.has(objectType)) {
      continue;
    }

    if (LEADING_MODULE_HEADER_PATTERN.test(text)) {
      errors.push(`${objectType} ${objectLabel} includes a leading SET ANSI_NULLS / SET QUOTED_IDENTIFIER batch header, which is not allowed in canonical source artifacts.`);
    }

    if (CREATE_OR_ALTER_PATTERN.test(text)) {
      errors.push(`${objectType} ${objectLabel} starts with CREATE OR ALTER, which is deploy-only and not allowed in canonical source artifacts.`);
    }

    if (DEPLOY_WRAPPER_PATTERN.test(text)) {
      errors.push(`${objectType} ${objectLabel} includes deploy-only wrappers such as IF OBJECT_ID or DROP guards.`);
    }

    const startError = validateScriptStartsWithExpectedModule(text, objectType);
    if (startError) {
      errors.push(`${objectType} ${objectLabel}: ${startError}`);
    }
  }

  if (errors.length) {
    throw new Error(`Canonical source artifact validation failed:\n- ${errors.join("\n- ")}`);
  }
}

function buildCombinedStoredProcedureText(scripts = []) {
  const parts = [];
  for (const script of scripts) {
    const sqlText = toWindowsLineEndings(
      normalizeExecutableSql(readScriptText(script), "PROCEDURE", {}, { strategy: "createOrAlter" })
    ).trim();
    if (!sqlText) continue;
    parts.push(sqlText, "GO");
  }
  return parts.join("\r\n\r\n").trim();
}

async function syncProgrammableScriptsWithExactDefinitions({ profile, scripts = [], combinedStoredProceduresPath = null }) {
  const programmableScripts = (scripts || []).filter((item) => EXACT_DEFINITION_OBJECT_TYPES.has(String(item.objectType || "").toUpperCase()));
  if (!programmableScripts.length) {
    return { exactDefinitionsApplied: 0, exactDefinitionWarning: null, generationWarnings: [] };
  }

  let definitions;
  try {
    definitions = await fetchObjectDefinitionMap(profile, programmableScripts);
  } catch (error) {
    return {
      exactDefinitionsApplied: 0,
      exactDefinitionWarning: error.message || String(error),
      generationWarnings: [
        buildWarning("Exact-definition lookup failed; using generated programmable object files as a lower-fidelity fallback.", {
          code: "EXACT_DEFINITION_LOOKUP_FAILED",
          detail: error.message || String(error),
        }),
      ],
    };
  }

  const definitionMap = new Map();
  for (const definition of definitionRows(definitions)) {
    const definitionText = normalizeExactDefinitionText(definition.definition);
    if (!definitionText) continue;
    definitionMap.set(objectKey(definition), {
      ...definition,
      definition: definitionText,
    });
  }

  let exactDefinitionsApplied = 0;
  const generationWarnings = [];
  for (const script of programmableScripts) {
    const definition = definitionMap.get(objectKey(script));
    if (!definition) {
      generationWarnings.push(buildWarning(
        `Exact-definition text was not available for ${script.schemaName}.${script.objectName}; keeping generated source artifact as a lower-fidelity fallback.`,
        {
          code: "EXACT_DEFINITION_OBJECT_MISSING",
          objectType: script.objectType,
          schemaName: script.schemaName,
          objectName: script.objectName,
          scriptPath: script.scriptPath || null,
        }
      ));
      script.moduleMetadata = {
        usesAnsiNulls: null,
        usesQuotedIdentifier: null,
        definitionSource: "generated",
      };
      continue;
    }
    if (!script.scriptPath) continue;

    const exactText = toWindowsLineEndings(definition.definition);
    fs.writeFileSync(script.scriptPath, exactText, "utf8");
    script.definitionText = exactText;
    script.moduleMetadata = buildModuleMetadata(definition);
    if (script.moduleMetadata.usesAnsiNulls == null || script.moduleMetadata.usesQuotedIdentifier == null) {
      generationWarnings.push(buildWarning(
        `Exact-definition metadata for ${script.schemaName}.${script.objectName} is incomplete; deploy artifacts may use default session-setting behavior.`,
        {
          code: "EXACT_DEFINITION_METADATA_INCOMPLETE",
          objectType: script.objectType,
          schemaName: script.schemaName,
          objectName: script.objectName,
          scriptPath: script.scriptPath || null,
        }
      ));
    }
    exactDefinitionsApplied += 1;
  }

  if (combinedStoredProceduresPath) {
    const combinedText = buildCombinedStoredProcedureText(
      (scripts || []).filter((item) => String(item.objectType || "").toUpperCase() === "PROCEDURE")
    );
    if (combinedText) {
      fs.writeFileSync(combinedStoredProceduresPath, combinedText, "utf8");
    }
  }

  return { exactDefinitionsApplied, exactDefinitionWarning: null, generationWarnings };
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
  validateCanonicalSourceArtifacts(scripts);

  return {
    generated,
    scripts,
    combinedStoredProceduresPath,
    selectedObjects: cleanObjects,
    ...definitionSync,
  };
}

function getCodeDiffOutputPaths(taskId) {
  return {
    sourceOut: require("path").join(CODEDIFF_DIR, `${taskId}_source`),
    destOut: require("path").join(CODEDIFF_DIR, `${taskId}_dest`),
  };
}

module.exports = {
  buildCombinedStoredProcedureText,
  validateCanonicalSourceArtifacts,
  normalizeSelectedObjects,
  generateScriptsForProfile,
  getCodeDiffOutputPaths,
  syncProgrammableScriptsWithExactDefinitions,
};
