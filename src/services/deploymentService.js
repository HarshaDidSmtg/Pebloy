const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { executeSql, executeSqlScript, executeSqlScriptsIndividually, fetchObjectDefinitionMap, fetchTypeSignatureMap, fetchObjectDependencyEdges, testConnection } = require("./sqlService");
const { writeScriptArtifact } = require("./loggingService");
const { writeSqlFileSync } = require("./sqlFileEncoding");
const {
  compareGeneratedArtifacts,
  deployGeneratedArtifacts,
  isDacFxEngine,
  normalizeEngine,
  validateGeneratedArtifacts,
} = require("./dacfxService");
const { getSettings } = require("./settingsService");
const {
  buildProfileOutputBasePath,
  buildRunRoot,
  generateTableDelta,
  normalizeExecutableSql,
} = require("./scriptAutomationService");
const { generateScriptsForProfile } = require("./scriptGenerationService");
const { EXPORTS_DIR } = require("./paths");
const { splitSqlBatches } = require("./sqlBatchService");
const FORMAT_EXECUTABLE_TYPES = new Set(["PROCEDURE", "VIEW", "FUNCTION", "TRIGGER"]);
const { requiresManualReview } = require("./errorService");

function toWindowsLineEndings(text) {
  return String(text || "").replace(/\r?\n/g, "\r\n");
}

function normalizeLookupName(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDefinitionForCompare(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function buildTypeOrder() {
  return Object.fromEntries([
    "USER_DEFINED_TYPE", "SEQUENCE", "TABLE", "VIEW", "FUNCTION", "PROCEDURE", "SYNONYM", "TRIGGER",
  ].map((type, index) => [type, index + 1]));
}

function normalizeSelection(items = []) {
  return items.map((x) => {
    const normalized = {
      objectType: String(x.objectType || "").toUpperCase(),
      schemaName: x.schemaName,
      objectName: x.objectName,
    };

    const createdDate = x.createdDate || x.createDate;
    if (createdDate) {
      normalized.createdDate = createdDate;
    }

    const modifiedDate = x.modifiedDate || x.modifyDate;
    if (modifiedDate) {
      normalized.modifiedDate = modifiedDate;
    }

    if (Array.isArray(x.dependencies)) {
      normalized.dependencies = x.dependencies;
    } else if (Array.isArray(x.dependsOn)) {
      normalized.dependencies = x.dependsOn;
    }

    return normalized;
  });
}

function toSortableTimestamp(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getDependencyNames(item) {
  return (Array.isArray(item.dependencies) ? item.dependencies : [])
    .map((dependency) => {
      if (typeof dependency === "string") return normalizeLookupName(dependency);
      if (!dependency || typeof dependency !== "object") return "";
      const schemaName = dependency.schemaName || dependency.schema || "";
      const objectName = dependency.objectName || dependency.name || "";
      if (dependency.objectType) return normalizeLookupName(keyOf({ ...dependency, schemaName, objectName }));
      return normalizeLookupName(`${schemaName}.${objectName}`);
    })
    .filter(Boolean);
}

function dedupeSelection(items = []) {
  const seen = new Set();
  return normalizeSelection(items).filter((item) => {
    const itemKey = keyOf(item);
    if (seen.has(itemKey)) {
      return false;
    }
    seen.add(itemKey);
    return true;
  });
}

function sortedByDependency(items) {
  const TYPE_ORDER = buildTypeOrder();
  const baseOrdered = [...items].sort((a, b) => {
    const ao = TYPE_ORDER[a.objectType] || 999;
    const bo = TYPE_ORDER[b.objectType] || 999;
    if (ao !== bo) return ao - bo;

    const aCreated = toSortableTimestamp(a.createdDate || a.createDate);
    const bCreated = toSortableTimestamp(b.createdDate || b.createDate);
    if (aCreated != null && bCreated != null && aCreated !== bCreated) {
      return aCreated - bCreated;
    }
    if (aCreated != null && bCreated == null) return -1;
    if (aCreated == null && bCreated != null) return 1;

    if (a.schemaName !== b.schemaName) return a.schemaName.localeCompare(b.schemaName);
    return a.objectName.localeCompare(b.objectName);
  });

  const indexed = baseOrdered.map((item) => ({ item, key: keyOf(item) }));
  const byKey = new Map(indexed.map((entry) => [normalizeLookupName(entry.key), entry]));
  const byName = new Map(indexed.map((entry) => [normalizeLookupName(`${entry.item.schemaName}.${entry.item.objectName}`), entry]));
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];

  function visit(entry) {
    if (visited.has(entry.key)) return;
    if (visiting.has(entry.key)) return;
    visiting.add(entry.key);

    for (const dependencyName of getDependencyNames(entry.item)) {
      const dependency = byName.get(dependencyName) || byKey.get(dependencyName);
      if (dependency) visit(dependency);
    }

    visiting.delete(entry.key);
    visited.add(entry.key);
    ordered.push(entry.item);
  }

  indexed.forEach(visit);
  return ordered;
}

async function deriveSelectionDependencies(sourceProfile, selectedObjects, logEvent = () => {}) {
  const unique = dedupeSelection(selectedObjects).map((item) => {
    if (!sourceProfile) return item;
    const { dependencies, ...selection } = item;
    return selection;
  });
  if (sourceProfile?.kind === "Folder") {
    if (unique.some((item) => item.objectType === "TABLE")) throw new Error("Folder-source table deployment is not supported. Use a live source database for data-preserving table deltas.");
    const scripts = require("./folderSourceService").selectFolderScripts(sourceProfile, unique);
    return scripts.map((script) => ({ objectType: script.objectType, schemaName: script.schemaName, objectName: script.objectName,
      dependencies: (script.dependencies || []).flatMap((dependency) => unique.filter((candidate) =>
        normalizeLookupName(candidate.schemaName) === normalizeLookupName(dependency.schemaName) &&
        normalizeLookupName(candidate.objectName) === normalizeLookupName(dependency.objectName) && keyOf(candidate) !== keyOf(script))) }));
  }
  if (!sourceProfile || unique.length < 2) {
    return unique;
  }

  try {
    const edges = await fetchObjectDependencyEdges(sourceProfile, unique);
    if (!Array.isArray(edges)) throw new Error("Dependency metadata returned an invalid response.");
    if (!edges.length) {
      return unique;
    }

    const selectedKeys = new Set(unique.map(keyOf));
    const dependenciesByKey = new Map();

    for (const edge of edges) {
      const item = {
        objectType: edge.objectType,
        schemaName: edge.schemaName,
        objectName: edge.objectName,
      };
      const dependency = {
        objectType: edge.dependencyObjectType,
        schemaName: edge.dependencySchemaName,
        objectName: edge.dependencyObjectName,
      };
      const itemKey = keyOf(item);
      const dependencyKey = keyOf(dependency);
      if (!selectedKeys.has(itemKey) || !selectedKeys.has(dependencyKey) || itemKey === dependencyKey) {
        continue;
      }

      if (!dependenciesByKey.has(itemKey)) dependenciesByKey.set(itemKey, new Map());
      dependenciesByKey.get(itemKey).set(dependencyKey, dependency);
    }

    return unique.map((item) => {
      const existing = Array.isArray(item.dependencies) ? item.dependencies : [];
      const derived = [...(dependenciesByKey.get(keyOf(item))?.values() || [])];
      return derived.length ? { ...item, dependencies: [...existing, ...derived] } : item;
    });
  } catch (error) {
    logEvent("ERROR", "Unable to derive deployment order from SQL dependency metadata; deployment planning stopped.", {
      errorMessage: error.message,
    });
    throw new Error(`Unable to determine deployment dependencies: ${error.message}`);
  }
}

async function buildDependencyOrderedSelection(sourceProfile, selectedObjects, logEvent = () => {}) {
  const enriched = await deriveSelectionDependencies(sourceProfile, selectedObjects, logEvent);
  return orderExecutionGroups(enriched);
}

function orderExecutionGroups(items) {
  const ordered = sortedByDependency(items);
  const groups = new Map();
  const groupByName = new Map();
  for (const item of ordered) {
    const groupKey = ["TABLE", "PROCEDURE"].includes(item.objectType) ? item.objectType : keyOf(item);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(item);
    groupByName.set(normalizeLookupName(`${item.schemaName}.${item.objectName}`), groupKey);
    groupByName.set(normalizeLookupName(keyOf(item)), groupKey);
  }
  const visited = new Set();
  const visiting = new Set();
  const result = [];
  function visit(groupKey) {
    if (visited.has(groupKey)) return;
    if (visiting.has(groupKey)) throw new Error("Selected dependencies form a cycle across combined deployment groups. Review the selection before deploying.");
    visiting.add(groupKey);
    for (const item of groups.get(groupKey)) {
      for (const dependencyName of getDependencyNames(item)) {
        const dependencyGroup = groupByName.get(dependencyName);
        if (dependencyGroup && dependencyGroup !== groupKey) visit(dependencyGroup);
      }
    }
    visiting.delete(groupKey);
    visited.add(groupKey);
    result.push(...groups.get(groupKey));
  }
  for (const groupKey of groups.keys()) visit(groupKey);
  return result;
}

function keyOf(item) {
  return `${String(item.objectType || "").toUpperCase()}|${normalizeLookupName(item.schemaName)}|${normalizeLookupName(item.objectName)}`;
}

async function executeSqlBatches(profile, sqlText) {
  await executeSqlScript(profile, sqlText, { atomic: true });
}

function escapeSqlString(str) {
  return String(str || "").replace(/'/g, "''");
}

function buildRollbackSql(batches) {
  const execLines = batches
    .map((batch) => `EXEC(N'${escapeSqlString(batch)}');`)
    .join("\n");
  return `SET XACT_ABORT ON;\nBEGIN TRY\nBEGIN TRANSACTION;\n${execLines}\nROLLBACK TRANSACTION;\nEND TRY\nBEGIN CATCH\nIF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;\nTHROW;\nEND CATCH;`;
}

function splitBatches(sqlText) {
  return splitSqlBatches(sqlText);
}

function writeDeploymentSql(outputDir, fileName, sqlText) {
  const safeName = String(fileName || "deployment_script").replace(/[^a-zA-Z0-9._-]/g, "_");
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${safeName}.sql`);
  writeSqlFileSync(filePath, sqlText);
  return filePath;
}

function supportsCreateOrAlter(objectType) {
  return ["PROCEDURE"].includes(String(objectType || "").toUpperCase());
}

function getDirectStrategy(objectType) {
  return supportsCreateOrAlter(objectType) ? "createOrAlter" : "dropCreate";
}

function getActionForObjectType(objectType) {
  const type = String(objectType || "").toUpperCase();
  if (type === "TABLE") return "AlterDelta";
  if (type === "PROCEDURE") return "ExecuteCombinedProcedures";
  if (supportsCreateOrAlter(type)) return "CreateOrAlterIndividually";
  return "DropAndCreate";
}

function getRollbackStrategy(objectType) {
  return supportsCreateOrAlter(objectType) ? "createOrAlter" : "dropCreate";
}

function buildLegacyDeploymentMetadata(generationWarnings = []) {
  return {
    generationWarnings,
    dacfxValidation: { enabled: false },
    engine: "Legacy",
    deployScriptPath: null,
  };
}

function getActionForEngine(objectType, engine) {
  return isDacFxEngine(engine) ? "DacFxDeploy" : getActionForObjectType(objectType);
}

function mapDacFxAction(operation) {
  const normalized = String(operation || "Deploy").trim();
  return normalized ? `DacFx${normalized}` : "DacFxDeploy";
}

function markProcedureResults(resultsByKey, selectedProcedures, status, errorMessage, scriptPath) {
  for (const item of selectedProcedures) {
    const current = resultsByKey.get(keyOf(item));
    if (!current) continue;
    current.status = status;
    current.errorMessage = errorMessage || null;
    current.scriptPath = scriptPath || current.scriptPath || null;
  }
}

function broadcastProcedureResults({
  resultsByKey,
  selectedProcedures,
  taskId,
  status,
  errorMessage = null,
  total,
  doneCount,
  broadcastProgress,
}) {
  let nextDoneCount = doneCount;
  for (const item of selectedProcedures) {
    const current = resultsByKey.get(keyOf(item));
    if (!current) continue;

    current.status = status;
    current.errorMessage = errorMessage;
    nextDoneCount += 1;
    broadcastProgress("deployProgress", {
      taskId,
      objectType: current.objectType,
      schemaName: current.schemaName,
      objectName: current.objectName,
      status,
      error: errorMessage || undefined,
      done: nextDoneCount,
      total,
    });
  }

  return nextDoneCount;
}

function buildDeploymentPlan(selectedObjects) {
  const unique = dedupeSelection(selectedObjects);
  const ordered = orderExecutionGroups(unique);
  return ordered.map((item) => ({
    ...item,
    action: getActionForObjectType(item.objectType),
  }));
}

async function buildDerivedDeploymentPlan(sourceProfile, selectedObjects, logEvent = () => {}, mode = "ExecuteDirectly") {
  if (sourceProfile?.kind === "Folder" && mode === "FormatAndExecuteSource") throw new Error("Format & Execute in Source requires a live database.");
  const ordered = await buildDependencyOrderedSelection(sourceProfile, selectedObjects, logEvent);
  return ordered.map((item) => ({
    ...item,
    action: mode === "FormatAndExecuteSource" && !FORMAT_EXECUTABLE_TYPES.has(item.objectType)
      ? "NoStoredModuleText" : getActionForObjectType(item.objectType),
  }));
}

function deploymentPlanFingerprint(plan, sourceProfile, destinationProfile, mode) {
  const profileIdentity = (profile) => [profile?.id, profile?.profileLabel, profile?.serverName,
    profile?.databaseName, profile?.authenticationType, profile?.username, profile?.environmentTag, profile?.folderFingerprint];
  return createHash("sha256").update(JSON.stringify({
    source: profileIdentity(sourceProfile), target: profileIdentity(destinationProfile), mode,
    objects: plan.map((item) => [keyOf(item), [...new Set(getDependencyNames(item))].sort()]),
  })).digest("hex");
}

function buildDefinitionLookup(definitions) {
  const lookup = new Map();
  if (!definitions || typeof definitions.values !== "function") {
    return lookup;
  }

  for (const definition of definitions.values()) {
    lookup.set(keyOf(definition), definition);
  }

  return lookup;
}

async function findUnchangedDirectExecutionKeys({ sourceProfile, destinationProfile, selectedObjects, logEvent }) {
  if (sourceProfile?.kind === "Folder") return new Set();
  const comparableObjects = (selectedObjects || []).filter(
    (item) => !["TABLE", "PROCEDURE"].includes(String(item.objectType || "").toUpperCase())
  );
  if (!comparableObjects.length) {
    return new Set();
  }

  const unchangedKeys = new Set();
  const typeObjects = comparableObjects.filter((item) => item.objectType === "USER_DEFINED_TYPE");
  if (typeObjects.length) {
    try {
      const [sourceTypes, destinationTypes] = await Promise.all([
        fetchTypeSignatureMap(sourceProfile, typeObjects),
        fetchTypeSignatureMap(destinationProfile, typeObjects),
      ]);
      for (const item of typeObjects) {
        const itemKey = keyOf(item);
        const sourceSignature = sourceTypes.get(itemKey);
        const destinationSignature = destinationTypes.get(itemKey);
        if (!sourceSignature) throw new Error(`Source type metadata is missing for ${item.schemaName}.${item.objectName}.`);
        const unchanged = sourceSignature === destinationSignature;
        if (unchanged) unchangedKeys.add(itemKey);
        logEvent("INFO", "User-defined type comparison completed", {
          objectType: item.objectType, schemaName: item.schemaName, objectName: item.objectName,
          comparison: unchanged ? "Identical" : destinationSignature ? "Changed" : "MissingOnTarget",
        });
      }
    } catch (error) {
      logEvent("ERROR", "User-defined type comparison failed; deployment stopped before SQL execution.", {
        errorMessage: error.message,
      });
      throw new Error(`User-defined type comparison failed; no deployment SQL was executed. ${error.message}`);
    }
  }

  const definitionObjects = comparableObjects.filter((item) => item.objectType !== "USER_DEFINED_TYPE");
  if (!definitionObjects.length) return unchangedKeys;

  try {
    const [sourceDefinitions, destinationDefinitions] = await Promise.all([
      fetchObjectDefinitionMap(sourceProfile, definitionObjects),
      fetchObjectDefinitionMap(destinationProfile, definitionObjects),
    ]);
    const sourceLookup = buildDefinitionLookup(sourceDefinitions);
    const destinationLookup = buildDefinitionLookup(destinationDefinitions);

    for (const item of definitionObjects) {
      const itemKey = keyOf(item);
      const sourceDefinition = sourceLookup.get(itemKey);
      const destinationDefinition = destinationLookup.get(itemKey);
      if (!sourceDefinition || !destinationDefinition) {
        continue;
      }

      if (normalizeDefinitionForCompare(sourceDefinition.definition) === normalizeDefinitionForCompare(destinationDefinition.definition)) {
        unchangedKeys.add(itemKey);
      }
    }

    return unchangedKeys;
  } catch (error) {
    logEvent("WARN", "Unable to pre-compare non-type deploy objects; continuing with generated scripts for those objects.", {
      errorMessage: error.message,
    });
    return unchangedKeys;
  }
}

async function runDacFxDeployment({
  sourceProfile,
  destinationProfile,
  selectedObjects,
  mode,
  options,
  task,
  logEvent,
  broadcastProgress = () => {},
}) {
  const ordered = await buildDependencyOrderedSelection(sourceProfile, selectedObjects, logEvent);
  const total = ordered.length;
  let doneCount = 0;
  const resultsByKey = new Map();
  for (const item of ordered) {
    resultsByKey.set(keyOf(item), {
      ...item,
      action: "DacFxDeploy",
      status: "Skipped",
      errorMessage: "No generated script found.",
      scriptPath: null,
    });
  }

  const scriptOutputRoot = options?.scriptOutputPath || EXPORTS_DIR;
  broadcastProgress("taskProgress", {
    taskId: task.taskId,
    taskType: "Deploy",
    key: "deploy",
    operation: "Generating latest source scripts...",
    percent: 20,
  });

  const generatedInfo = await generateScriptsForProfile({
    taskId: task.taskId,
    profile: sourceProfile,
    selectedObjects: ordered,
    outputBasePath: scriptOutputRoot,
    appTaskMode: "deploy",
  });

  const generated = generatedInfo.generated;
  fs.mkdirSync(generated.runRoot, { recursive: true });
  const deploymentScriptDir = path.join(generated.runRoot, "Deployment Scripts");
  const generatedScripts = generatedInfo.scripts || [];
  const generatedScriptMap = new Map(generatedScripts.map((entry) => [keyOf(entry), entry]));
  const generationWarnings = generatedInfo.generationWarnings || [];

  generationWarnings.forEach((warning) => {
    logEvent("WARN", warning.message, warning);
  });

  let dacfxValidation = { enabled: false };
  if (getSettings().dacfx?.validationEnabled) {
    broadcastProgress("taskProgress", {
      taskId: task.taskId,
      taskType: "Deploy",
      key: "deploy",
      operation: "Validating generated scripts with DacFx...",
      percent: 45,
    });
    const validationResult = await validateGeneratedArtifacts({
      taskId: `${task.taskId}_deploy_validate`,
      scripts: generatedScripts,
    });
    dacfxValidation = {
      enabled: true,
      ...validationResult,
    };
  }

  broadcastProgress("taskProgress", {
    taskId: task.taskId,
    taskType: "Deploy",
    key: "deploy",
    operation: mode === "Rollback" ? "Generating DacFx deployment preview..." : "Generating DacFx deployment script...",
    percent: 65,
  });

  const preview = await compareGeneratedArtifacts({
    taskId: `${task.taskId}_preview`,
    sourceScripts: generatedScripts,
    destinationProfile,
  });

  const deployScriptText = String(preview.deployScript || "");
  let deploymentScriptPath = null;
  if (deployScriptText.trim()) {
    deploymentScriptPath = writeDeploymentSql(
      deploymentScriptDir,
      `${task.taskId}_${mode === "Rollback" ? "dacfx_preview" : "dacfx_deploy"}`,
      deployScriptText
    );
    writeScriptArtifact(task.taskId, "deploy", "DACFX", sourceProfile.databaseName, destinationProfile.databaseName, deployScriptText);
  }

  (preview.alerts || []).forEach((alert) => {
    logEvent("WARN", `DacFx alert: ${alert.name || alert.severity || "Alert"}`, alert);
  });
  (preview.warnings || []).forEach((warning) => {
    logEvent("WARN", warning, { source: "dacfx-preview" });
  });

  if (mode !== "Rollback") {
    broadcastProgress("taskProgress", {
      taskId: task.taskId,
      taskType: "Deploy",
      key: "deploy",
      operation: "Applying DacFx deployment...",
      percent: 82,
    });
    try {
      await deployGeneratedArtifacts({
        taskId: task.taskId,
        sourceScripts: generatedScripts,
        destinationProfile,
        mode: "apply",
      });
    } catch (error) {
      for (const item of ordered) {
        const current = resultsByKey.get(keyOf(item));
        if (!current) continue;
        current.status = "Failed";
        current.errorMessage = error.message || "DacFx deployment failed.";
        current.scriptPath = deploymentScriptPath;
        doneCount += 1;
        broadcastProgress("deployProgress", {
          taskId: task.taskId,
          objectType: current.objectType,
          schemaName: current.schemaName,
          objectName: current.objectName,
          status: "Failed",
          error: current.errorMessage,
          done: doneCount,
          total,
        });
      }

      return {
        plan: ordered,
        results: [...resultsByKey.values()],
        generatedRoot: generated.runRoot,
        buildPathFile: generated.latestBuildPathFile,
        rollbackApplied: false,
        generationWarnings,
        dacfxValidation,
        engine: "DacFx",
        deployScriptPath: deploymentScriptPath,
      };
    }
  }

  const changeByKey = new Map(
    (preview.changes || []).map((change) => [keyOf(change), change])
  );

  for (const item of ordered) {
    const current = resultsByKey.get(keyOf(item));
    if (!current) continue;
    const generatedScript = generatedScriptMap.get(keyOf(item));
    const change = changeByKey.get(keyOf(item));
    current.scriptPath = deploymentScriptPath;
    current.errorMessage = null;

    if (!generatedScript) {
      current.status = "Skipped";
      current.errorMessage = "No generated script found.";
    } else if (change) {
      current.status = mode === "Rollback" ? "RolledBack" : "Success";
      current.action = mapDacFxAction(change.operation);
    } else {
      current.status = "Skipped";
      current.action = "NoChange";
    }

    doneCount += 1;
    broadcastProgress("deployProgress", {
      taskId: task.taskId,
      objectType: current.objectType,
      schemaName: current.schemaName,
      objectName: current.objectName,
      status: current.status,
      done: doneCount,
      total,
    });
  }

  logEvent("INFO", mode === "Rollback" ? "DacFx deployment preview completed" : "DacFx deployment completed", {
    generatedRoot: generated.runRoot,
    buildPathFile: generated.latestBuildPathFile,
    deployScriptPath: deploymentScriptPath,
    changeCount: preview.changes?.length || 0,
  });

  return {
    plan: ordered,
    results: [...resultsByKey.values()],
    generatedRoot: generated.runRoot,
    buildPathFile: generated.latestBuildPathFile,
    rollbackApplied: mode === "Rollback",
    generationWarnings,
    dacfxValidation,
    engine: "DacFx",
    deployScriptPath: deploymentScriptPath,
  };
}

async function executeDeployment({
  sourceProfile,
  destinationProfile,
  selectedObjects,
  mode,
  continueOnError,
  options,
  task,
  logEvent,
  broadcastProgress = () => {},
}) {
  if (!["ExecuteDirectly", "Rollback", "FormatAndExecuteSource", "DryRun"].includes(mode)) {
    throw new Error("Invalid deployment mode. Choose ExecuteDirectly, Rollback, FormatAndExecuteSource, or DryRun.");
  }
  const formatInSource = mode === "FormatAndExecuteSource";
  if (formatInSource && options?.confirmedSourceDatabase !== sourceProfile?.databaseName) {
    throw new Error("Confirm the source database before formatting and executing its modules.");
  }
  if (options?.engine && options.engine !== "Legacy") {
    throw new Error("DacFx deployment is not supported. Choose Legacy; DacFx remains available for comparison and validation.");
  }
  if (!Array.isArray(selectedObjects) || !selectedObjects.length) {
    throw new Error("Select at least one object before deploying.");
  }
  const folderSource = sourceProfile?.kind === "Folder";
  if (folderSource && (formatInSource || selectedObjects.some((item) => item.objectType === "TABLE"))) throw new Error("Folder deployment supports non-table objects only; source execution and table deltas require a live database.");
  const identities = await Promise.all([folderSource ? Promise.resolve(sourceProfile) : testConnection(sourceProfile), testConnection(destinationProfile)]);
  if (identities.some((identity) => !identity?.serverName || !identity?.databaseName)) {
    throw new Error("Could not verify source and target database identity. Deployment was not started.");
  }
  for (const [expected, actual] of [[options?.confirmedSourceIdentity, identities[0]], [options?.confirmedTargetIdentity, identities[1]]]) {
    if (expected && (normalizeLookupName(expected.serverName) !== normalizeLookupName(actual.serverName) || normalizeLookupName(expected.databaseName) !== normalizeLookupName(actual.databaseName))) {
      throw new Error("A database identity changed after confirmation. Review a fresh deployment plan.");
    }
  }
  const sameDatabase = normalizeLookupName(identities[0].serverName) === normalizeLookupName(identities[1].serverName) &&
    normalizeLookupName(identities[0].databaseName) === normalizeLookupName(identities[1].databaseName);
  if (formatInSource && !sameDatabase) {
    throw new Error("Format & Execute must target the confirmed source database.");
  }
  if (!formatInSource && sameDatabase) {
    throw new Error("Source and target resolve to the same database. Deployment was not started.");
  }

  const ordered = await buildDependencyOrderedSelection(sourceProfile, selectedObjects, logEvent);
  if (options?.confirmedPlanFingerprint && options.confirmedPlanFingerprint !==
      deploymentPlanFingerprint(ordered, sourceProfile, destinationProfile, mode)) {
    throw new Error("The deployment plan or connections changed. Review and confirm a fresh plan before deploying.");
  }
  const total = ordered.length;
  let doneCount = 0;
  const resultsByKey = new Map();
  for (const item of ordered) {
    resultsByKey.set(keyOf(item), {
      ...item,
      action: getActionForObjectType(item.objectType),
      status: "Skipped",
      errorMessage: "No generated script found.",
      scriptPath: null,
    });
  }

  const scriptOutputRoot = options?.scriptOutputPath || EXPORTS_DIR;
  const exportedSourceObjects = formatInSource
    ? ordered
    : ordered.filter((item) => item.objectType !== "TABLE");
  if (formatInSource && !exportedSourceObjects.length) throw new Error("Select at least one procedure, view, function, or trigger to format and execute.");
  broadcastProgress("taskProgress", {
    taskId: task.taskId,
    taskType: "Deploy",
    key: "deploy",
    operation: "Generating latest source scripts...",
    percent: 20,
  });
  const generatedInfo = exportedSourceObjects.length
    ? await generateScriptsForProfile({
        taskId: task.taskId,
        profile: sourceProfile,
        selectedObjects: exportedSourceObjects,
        outputBasePath: scriptOutputRoot,
        appTaskMode: "deploy",
        ...(formatInSource ? { forceFormatting: true } : {}),
      })
    : {
        generated: {
          runRoot: buildRunRoot(
            buildProfileOutputBasePath(scriptOutputRoot, sourceProfile.profileLabel),
            sourceProfile.databaseName
          ),
          latestBuildPathFile: null,
        },
        scripts: [],
        combinedStoredProceduresPath: null,
      };
  const generated = generatedInfo.generated;
  if (formatInSource && generatedInfo.formattingApplied !== true) throw new Error("Source execution was not started: formatting did not complete.");
  fs.mkdirSync(generated.runRoot, { recursive: true });
  const deploymentScriptDir = path.join(generated.runRoot, "Deployment Scripts");
  const generatedScripts = generatedInfo.scripts;
  const generatedScriptMap = new Map(generatedScripts.map((entry) => [keyOf(entry), entry]));
  const missingScripts = exportedSourceObjects.filter((item) => !generatedScriptMap.has(keyOf(item)));
  if (missingScripts.length) {
    throw new Error(`Deployment was not started: no fresh source script was generated for ${missingScripts.map((item) => `${item.objectType} ${item.schemaName}.${item.objectName}`).join(", ")}.`);
  }
  const combinedStoredProceduresPath = generatedInfo.combinedStoredProceduresPath;
  if (ordered.some((item) => item.objectType === "PROCEDURE") &&
      (!combinedStoredProceduresPath || !fs.existsSync(combinedStoredProceduresPath) || !fs.readFileSync(combinedStoredProceduresPath, "utf8").trim())) {
    throw new Error("Deployment was not started: a nonempty combined stored procedure deployment script is required.");
  }
  const hasTables = !formatInSource && ordered.some((item) => item.objectType === "TABLE");
  const generationWarnings = generatedInfo.generationWarnings || [];
  const deploymentMetadata = buildLegacyDeploymentMetadata(generationWarnings);
  const unchangedDirectExecutionKeys = formatInSource ? new Set() : await findUnchangedDirectExecutionKeys({
    sourceProfile,
    destinationProfile,
    selectedObjects: ordered,
    logEvent,
  });

  generationWarnings.forEach((warning) => {
    logEvent("WARN", warning.message, warning);
  });

  logEvent("INFO", "Deployment source scripts prepared", {
    generatedRoot: generated.runRoot,
    buildPathFile: generated.latestBuildPathFile,
    combinedStoredProceduresPath,
    tableObjectsUseDeltaOnly: hasTables,
  });
  broadcastProgress("taskProgress", {
    taskId: task.taskId,
    taskType: "Deploy",
    key: "deploy",
    operation: hasTables ? "Preparing table delta and deployment scripts..." : "Preparing deployment scripts...",
    percent: 45,
  });
  const selectedProcedures = ordered.filter((item) => item.objectType === "PROCEDURE");
  const isRollback = mode === "Rollback";

  if (mode === "DryRun") {
    let tableDeltaPath = null;
    if (hasTables) {
      const delta = await generateTableDelta({
        taskId: task.taskId,
        sourceProfile,
        destinationProfile,
        selectedObjects: ordered.filter((item) => item.objectType === "TABLE"),
        outputDir: deploymentScriptDir,
      });
      tableDeltaPath = delta?.outputPath || null;
      logEvent("INFO", "Table delta generated for review", { outputPath: tableDeltaPath });
    }

    for (const item of ordered) {
      const current = resultsByKey.get(keyOf(item));
      if (!current) continue;
      current.status = "ScriptGenerated";
      current.errorMessage = null;
      if (item.objectType === "TABLE") {
        current.action = "AlterDelta";
        current.scriptPath = tableDeltaPath;
      } else if (item.objectType === "PROCEDURE") {
        current.action = "ExecuteCombinedProcedures";
        current.scriptPath = combinedStoredProceduresPath;
      } else {
        const genItem = generatedScriptMap.get(keyOf(item));
        const executableSql = toWindowsLineEndings(normalizeExecutableSql(
          fs.readFileSync(genItem.scriptPath, "utf8"), genItem.objectType,
          { schemaName: genItem.schemaName, objectName: genItem.objectName },
          { strategy: getDirectStrategy(genItem.objectType), moduleMetadata: genItem.moduleMetadata || null }
        ));
        current.scriptPath = writeDeploymentSql(deploymentScriptDir,
          `${task.taskId}_${item.objectType}_${item.schemaName}_${item.objectName}`, executableSql);
      }
      doneCount += 1;
      broadcastProgress("deployProgress", { taskId: task.taskId, objectType: current.objectType,
        schemaName: current.schemaName, objectName: current.objectName, status: "ScriptGenerated", done: doneCount, total });
    }

    logEvent("INFO", "Dry run complete. Scripts were written for review; nothing was executed.", { deploymentScriptDir });
    return {
      plan: ordered,
      results: [...resultsByKey.values()],
      generatedRoot: generated.runRoot,
      buildPathFile: generated.latestBuildPathFile,
      dryRun: true,
      deploymentScriptDir,
      ...deploymentMetadata,
    };
  }

  if (isRollback) {
    // Rollback mode: validate the ordered deployment plan inside a transaction that always rolls back.
    const rollbackBatches = [];
    let combinedProceduresAdded = false;
    let tableDeltaAdded = false;
    let tableDelta = null;
    let tableRollbackBatches = [];

    if (hasTables) {
      try {
        broadcastProgress("taskProgress", {
          taskId: task.taskId,
          taskType: "Deploy",
          key: "deploy",
          operation: "Generating table delta...",
          percent: 55,
        });
        tableDelta = await generateTableDelta({
          taskId: task.taskId,
          sourceProfile,
          destinationProfile,
          selectedObjects: ordered.filter((x) => x.objectType === "TABLE"),
          outputDir: deploymentScriptDir,
        });

        if (tableDelta && String(tableDelta.scriptText || "").trim()) {
          writeScriptArtifact(task.taskId, "deploy", "TABLE_DELTA", "dbo", destinationProfile.databaseName, tableDelta.scriptText || "");
          logEvent("INFO", "Table delta generated", { outputPath: tableDelta.outputPath });
          tableRollbackBatches = splitBatches(String(tableDelta.scriptText || ""));
        }
      } catch (error) {
        const tableError = error.message || "Table delta rollback test failed.";
        logEvent("ERROR", "Table delta rollback test failed", { errorMessage: tableError });
        for (const item of ordered.filter((x) => x.objectType === "TABLE")) {
          const current = resultsByKey.get(keyOf(item));
          if (!current) continue;
          current.status = "Failed";
          current.errorMessage = tableError;
          doneCount += 1;
          broadcastProgress("deployProgress", {
            taskId: task.taskId,
            objectType: current.objectType,
            schemaName: current.schemaName,
            objectName: current.objectName,
            status: "Failed",
            error: current.errorMessage,
            done: doneCount,
            total,
          });
        }
      }
    }

    for (const item of ordered) {
      const current = resultsByKey.get(keyOf(item));
      if (!current) continue;

      if (item.objectType === "TABLE") {
        current.action = "AlterDelta";
        current.scriptPath = tableDelta?.outputPath || null;
        current.errorMessage = current.status === "Failed" ? current.errorMessage : null;
        if (!tableDeltaAdded && tableRollbackBatches.length) {
          rollbackBatches.push(...tableRollbackBatches);
          tableDeltaAdded = true;
        }
        continue;
      }

      if (item.objectType === "PROCEDURE" && combinedStoredProceduresPath && fs.existsSync(combinedStoredProceduresPath)) {
        current.scriptPath = combinedStoredProceduresPath;
        current.errorMessage = null;
        if (!combinedProceduresAdded) {
          const combinedSql = fs.readFileSync(combinedStoredProceduresPath, "utf8");
          rollbackBatches.push(...splitBatches(combinedSql));
          combinedProceduresAdded = true;
        }
        continue;
      }

      const genItem = generatedScriptMap.get(keyOf(item));
      if (!genItem) continue;
      current.scriptPath = genItem.scriptPath;
      current.errorMessage = null;

      const rawSql = fs.readFileSync(genItem.scriptPath, "utf8");
      const executableSql = toWindowsLineEndings(normalizeExecutableSql(rawSql, genItem.objectType, {
        schemaName: genItem.schemaName,
        objectName: genItem.objectName,
      }, {
        strategy: getRollbackStrategy(genItem.objectType),
        moduleMetadata: genItem.moduleMetadata || null,
      }));
      current.scriptPath = writeDeploymentSql(
        deploymentScriptDir,
        `${task.taskId}_${item.objectType}_${item.schemaName}_${item.objectName}`,
        executableSql
      );
      if (unchangedDirectExecutionKeys.has(keyOf(item))) {
        current.status = "Skipped";
        current.action = "NoChange";
        current.errorMessage = null;
        doneCount += 1;
        broadcastProgress("deployProgress", {
          taskId: task.taskId,
          objectType: current.objectType,
          schemaName: current.schemaName,
          objectName: current.objectName,
          status: "Skipped",
          done: doneCount,
          total,
        });
        continue;
      }
      rollbackBatches.push(...splitBatches(executableSql));
    }

    if (rollbackBatches.length > 0) {
      try {
        const rollbackSql = buildRollbackSql(rollbackBatches);
        const rollbackScriptPath = writeDeploymentSql(deploymentScriptDir, `${task.taskId}_rollback_validation`, rollbackSql);
        logEvent("INFO", "Rollback validation SQL generated", { outputPath: rollbackScriptPath });
        await executeSql(destinationProfile, rollbackSql);
        for (const item of ordered) {
          const current = resultsByKey.get(keyOf(item));
          if (current && current.scriptPath && current.status !== "Failed" && current.status !== "RolledBack" && current.action !== "NoChange") {
            current.status = "RolledBack";
            current.errorMessage = null;
            doneCount += 1;
            broadcastProgress("deployProgress", {
              taskId: task.taskId,
              objectType: current.objectType,
              schemaName: current.schemaName,
              objectName: current.objectName,
              status: "RolledBack",
              done: doneCount,
              total,
            });
          }
        }
        logEvent("INFO", "Rollback validation completed and its transaction was rolled back. External effects and non-transactional operations are not covered.");
      } catch (error) {
        logEvent("ERROR", "Rollback test encountered an error", { errorMessage: error.message });
        for (const item of ordered) {
          const current = resultsByKey.get(keyOf(item));
          if (!current || !current.scriptPath) continue;
          current.status = "Failed";
          current.errorMessage = error.message || "Rollback test failed.";
          doneCount += 1;
          broadcastProgress("deployProgress", {
            taskId: task.taskId,
            objectType: current.objectType,
            schemaName: current.schemaName,
            objectName: current.objectName,
            status: "Failed",
            error: current.errorMessage,
            done: doneCount,
            total,
          });
        }
      }
    }

    return {
      plan: ordered,
      results: [...resultsByKey.values()],
      generatedRoot: generated.runRoot,
      buildPathFile: generated.latestBuildPathFile,
      rollbackApplied: [...resultsByKey.values()].some((item) => item.status === "RolledBack") && ![...resultsByKey.values()].some((item) => item.status === "Failed"),
      ...deploymentMetadata,
    };
  }

  // ExecuteDirectly mode - execute non-table scripts independently through a
  // shared session, preserving exact object attribution without reconnecting
  // for every script. Tables remain a grouped delta operation at their order position.
  let tablesProcessed = false;
  let proceduresProcessed = false;
  let stopDirectExecution = false;
  broadcastProgress("taskProgress", {
    taskId: task.taskId,
    taskType: "Deploy",
    key: "deploy",
    operation: "Deploying objects...",
    percent: hasTables ? 60 : 50,
  });
  for (let index = 0; index < ordered.length && !stopDirectExecution;) {
    const item = ordered[index];
    if (formatInSource && !FORMAT_EXECUTABLE_TYPES.has(item.objectType)) {
      const current = resultsByKey.get(keyOf(item));
      current.action = "NoStoredModuleText";
      current.scriptPath = generatedScriptMap.get(keyOf(item))?.scriptPath || null;
      current.errorMessage = null;
      doneCount += 1;
      broadcastProgress("deployProgress", { taskId: task.taskId, ...item, status: "Skipped", done: doneCount, total });
      index += 1;
      continue;
    }
    if (item.objectType === "PROCEDURE") {
      if (proceduresProcessed) {
        index += 1;
        continue;
      }
      proceduresProcessed = true;

      const procedureItems = ordered.filter((x) => x.objectType === "PROCEDURE");
      if (!combinedStoredProceduresPath || !fs.existsSync(combinedStoredProceduresPath)) {
        const procedureError = "Combined stored procedure deployment script was not generated.";
        logEvent("ERROR", "Stored procedure deployment skipped because the combined script is missing", {
          combinedStoredProceduresPath,
          errorMessage: procedureError,
        });
        markProcedureResults(resultsByKey, procedureItems, "Failed", procedureError, combinedStoredProceduresPath);
        doneCount = broadcastProcedureResults({
          resultsByKey,
          selectedProcedures: procedureItems,
          taskId: task.taskId,
          status: "Failed",
          errorMessage: procedureError,
          total,
          doneCount,
          broadcastProgress,
        });
        if (!continueOnError) {
          return {
            plan: ordered,
            results: [...resultsByKey.values()],
            generatedRoot: generated.runRoot,
            buildPathFile: generated.latestBuildPathFile,
            ...deploymentMetadata,
          };
        }
        while (index < ordered.length && ordered[index].objectType === "PROCEDURE") {
          index += 1;
        }
        continue;
      }

      markProcedureResults(resultsByKey, procedureItems, "PendingExecution", null, combinedStoredProceduresPath);

      try {
        const combinedSql = fs.readFileSync(combinedStoredProceduresPath, "utf8");
        await executeSqlBatches(destinationProfile, combinedSql);
        logEvent("INFO", "Stored procedures deployed from combined script", {
          scriptPath: combinedStoredProceduresPath,
          objectCount: procedureItems.length,
        });
        markProcedureResults(resultsByKey, procedureItems, "Success", null, combinedStoredProceduresPath);
        doneCount = broadcastProcedureResults({
          resultsByKey,
          selectedProcedures: procedureItems,
          taskId: task.taskId,
          status: "Success",
          total,
          doneCount,
          broadcastProgress,
        });
      } catch (error) {
        const procedureError = error.message || "Stored procedure deployment failed.";
        logEvent("ERROR", "Stored procedure deployment failed", {
          scriptPath: combinedStoredProceduresPath,
          errorMessage: procedureError,
        });
        markProcedureResults(resultsByKey, procedureItems, "Failed", procedureError, combinedStoredProceduresPath);
        doneCount = broadcastProcedureResults({
          resultsByKey,
          selectedProcedures: procedureItems,
          taskId: task.taskId,
          status: "Failed",
          errorMessage: procedureError,
          total,
          doneCount,
          broadcastProgress,
        });
        if (!continueOnError) {
          return {
            plan: ordered,
            results: [...resultsByKey.values()],
            generatedRoot: generated.runRoot,
            buildPathFile: generated.latestBuildPathFile,
            ...deploymentMetadata,
          };
        }
      }

      while (index < ordered.length && ordered[index].objectType === "PROCEDURE") {
        index += 1;
      }
      continue;
    }

    if (item.objectType === "TABLE") {
      if (tablesProcessed) {
        index += 1;
        continue;
      }
      tablesProcessed = true;
      const tableItems = ordered.filter((x) => x.objectType === "TABLE");
      for (const tableItem of tableItems) {
        const current = resultsByKey.get(keyOf(tableItem));
        if (!current) continue;
        current.errorMessage = null;
        current.status = "PendingDelta";
        current.action = "AlterDelta";
      }

      try {
        const delta = await generateTableDelta({
          taskId: task.taskId,
          sourceProfile,
          destinationProfile,
          selectedObjects: tableItems,
          outputDir: deploymentScriptDir,
        });

        if (delta) {
          writeScriptArtifact(task.taskId, "deploy", "TABLE_DELTA", "dbo", destinationProfile.databaseName, delta.scriptText || "");
          logEvent("INFO", "Table delta generated from CompareTablesGenerateDelta", {
            outputPath: delta.outputPath,
          });

          if (String(delta.scriptText || "").trim()) {
            await executeSqlBatches(destinationProfile, delta.scriptText);
            logEvent("INFO", "Table delta executed", { outputPath: delta.outputPath });
          }

          for (const tableItem of tableItems) {
            const current = resultsByKey.get(keyOf(tableItem));
            if (!current) continue;
            current.scriptPath = delta.outputPath;
            current.status = "Success";
            current.errorMessage = null;
            doneCount++;
            broadcastProgress("deployProgress", { taskId: task.taskId, objectType: "TABLE", schemaName: tableItem.schemaName, objectName: tableItem.objectName, status: "Success", done: doneCount, total });
          }
        }
      } catch (error) {
        const tableError = error.message || "Table delta generation/execution failed.";
        logEvent("ERROR", "Table delta processing failed", { errorMessage: tableError });
        for (const tableItem of tableItems) {
          const current = resultsByKey.get(keyOf(tableItem));
          if (!current) continue;
          current.status = "Failed";
          current.errorMessage = tableError;
          doneCount++;
          broadcastProgress("deployProgress", { taskId: task.taskId, objectType: "TABLE", schemaName: tableItem.schemaName, objectName: tableItem.objectName, status: "Failed", error: tableError, done: doneCount, total });
        }
        if (!continueOnError) {
          return {
            plan: ordered,
            results: [...resultsByKey.values()],
            generatedRoot: generated.runRoot,
            buildPathFile: generated.latestBuildPathFile,
            ...deploymentMetadata,
          };
        }
      }
      while (index < ordered.length && ordered[index].objectType === "TABLE") {
        index += 1;
      }
      continue;
    }

    const executionGroup = [];
    while (
      index < ordered.length &&
      ordered[index].objectType !== "TABLE" &&
      ordered[index].objectType !== "PROCEDURE"
    ) {
      const groupItem = ordered[index];
      index += 1;
      const genItem = generatedScriptMap.get(keyOf(groupItem));
      const current = resultsByKey.get(keyOf(groupItem));
      if (!genItem || !current) continue;

      const rawSql = fs.readFileSync(genItem.scriptPath, "utf8");
      const executableSql = toWindowsLineEndings(normalizeExecutableSql(rawSql, genItem.objectType, {
        schemaName: genItem.schemaName,
        objectName: genItem.objectName,
      }, {
        strategy: getDirectStrategy(genItem.objectType),
        moduleMetadata: genItem.moduleMetadata || null,
      }));
      const deploymentScriptPath = writeDeploymentSql(
        deploymentScriptDir,
        `${task.taskId}_${groupItem.objectType}_${groupItem.schemaName}_${groupItem.objectName}`,
        executableSql
      );
      current.scriptPath = deploymentScriptPath;
      current.errorMessage = null;
      if (unchangedDirectExecutionKeys.has(keyOf(groupItem))) {
        current.status = "Skipped";
        current.action = "NoChange";
        logEvent("INFO", "Object already matches source; skipping live execution of generated script.", {
          objectType: current.objectType,
          schemaName: current.schemaName,
          objectName: current.objectName,
          scriptPath: current.scriptPath,
          sourceScriptPath: genItem.scriptPath,
        });
        doneCount++;
        broadcastProgress("deployProgress", {
          taskId: task.taskId,
          objectType: current.objectType,
          schemaName: current.schemaName,
          objectName: current.objectName,
          status: "Skipped",
          done: doneCount,
          total,
        });
        continue;
      }
      executionGroup.push({ item: groupItem, current, genItem, sqlText: executableSql });
    }
    if (!executionGroup.length) continue;

    const entriesByExecutionKey = new Map(
      executionGroup.map((entry) => [keyOf(entry.item), entry])
    );
    const reportedKeys = new Set();
    const recordExecutionResult = (executionResult) => {
      const entry = entriesByExecutionKey.get(executionResult.key);
      if (!entry || reportedKeys.has(executionResult.key)) return;
      reportedKeys.add(executionResult.key);

      if (executionResult.ok) {
        entry.current.status = "Success";
        entry.current.action = getActionForObjectType(entry.genItem.objectType);
        logEvent("INFO", "Object deployed from generated script", {
          objectType: entry.current.objectType,
          schemaName: entry.current.schemaName,
          objectName: entry.current.objectName,
          scriptPath: entry.current.scriptPath,
          sourceScriptPath: entry.genItem.scriptPath,
        });
        doneCount++;
        broadcastProgress("deployProgress", { taskId: task.taskId, objectType: entry.current.objectType, schemaName: entry.current.schemaName, objectName: entry.current.objectName, status: "Success", done: doneCount, total });
        return;
      }

      entry.current.status = "Failed";
      entry.current.errorMessage = executionResult.error || "Deployment failed.";
      const needsReview = requiresManualReview(entry.current.errorMessage);
      logEvent(needsReview ? "WARN" : "ERROR",
        needsReview ? "Object needs a reviewed migration" : "Object deployment failed", {
        objectType: entry.current.objectType,
        schemaName: entry.current.schemaName,
        objectName: entry.current.objectName,
        scriptPath: entry.current.scriptPath,
        sourceScriptPath: entry.genItem.scriptPath,
        errorMessage: entry.current.errorMessage,
      });
      doneCount++;
      broadcastProgress("deployProgress", { taskId: task.taskId, objectType: entry.current.objectType, schemaName: entry.current.schemaName, objectName: entry.current.objectName, status: "Failed", error: entry.current.errorMessage, done: doneCount, total });
      if (!continueOnError) {
        stopDirectExecution = true;
      }
    };

    try {
      const executionResults = await executeSqlScriptsIndividually(
        destinationProfile,
        executionGroup.map((entry) => ({ key: keyOf(entry.item), sqlText: entry.sqlText })),
        { continueOnError, onResult: recordExecutionResult }
      );
      executionResults.forEach(recordExecutionResult);
    } catch (error) {
      const executionError = error.message || "Deployment failed.";
      for (const entry of executionGroup) {
        if (reportedKeys.has(keyOf(entry.item))) continue;
        entry.current.status = "Failed";
        entry.current.errorMessage = executionError;
        logEvent("ERROR", "Object deployment connection failed", {
          objectType: entry.current.objectType,
          schemaName: entry.current.schemaName,
          objectName: entry.current.objectName,
          scriptPath: entry.current.scriptPath,
          sourceScriptPath: entry.genItem.scriptPath,
          errorMessage: entry.current.errorMessage,
        });
        doneCount++;
        broadcastProgress("deployProgress", { taskId: task.taskId, objectType: entry.current.objectType, schemaName: entry.current.schemaName, objectName: entry.current.objectName, status: "Failed", error: entry.current.errorMessage, done: doneCount, total });
      }
      stopDirectExecution = !continueOnError;
    }
  }

  const shouldStopOnFailure =
    !continueOnError &&
    [...resultsByKey.values()].some((item) => item.status === "Failed" && item.objectType !== "TABLE");

  if (shouldStopOnFailure) {
    return {
      plan: ordered,
      results: [...resultsByKey.values()],
      generatedRoot: generated.runRoot,
      buildPathFile: generated.latestBuildPathFile,
      ...deploymentMetadata,
    };
  }

  return {
    plan: ordered,
    results: [...resultsByKey.values()],
    generatedRoot: generated.runRoot,
    buildPathFile: generated.latestBuildPathFile,
    ...deploymentMetadata,
  };
}

async function runDeployment(request) {
  const reportProgress = request.broadcastProgress || (() => {});
  const result = await executeDeployment({
    ...request,
    broadcastProgress: (event, data) => reportProgress(event,
      data.status === "Failed" && requiresManualReview(data.error) ? { ...data, status: "ReviewRequired" } : data),
  });
  result.results = result.results.map((item) => item.status === "Failed" && requiresManualReview(item.errorMessage)
    ? { ...item, status: "ReviewRequired" } : item);
  return result;
}

module.exports = {
  runDeployment,
  buildDeploymentPlan,
  buildDerivedDeploymentPlan,
  deploymentPlanFingerprint,
};
