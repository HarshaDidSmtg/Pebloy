const fs = require("fs");
const path = require("path");
const { executeSql, executeSqlScript, executeSqlScriptsIndividually } = require("./sqlService");
const { writeScriptArtifact } = require("./loggingService");
const { getSettings } = require("./settingsService");
const {
  buildProfileOutputBasePath,
  buildRunRoot,
  generateTableDelta,
  normalizeExecutableSql,
} = require("./scriptAutomationService");
const { generateScriptsForProfile } = require("./scriptGenerationService");

function normalizeLookupName(value) {
  return String(value || "").trim().toLowerCase();
}

function buildTypeOrder() {
  const settings = getSettings();
  const order = settings.deploymentOrder || [];
  const result = {};
  order.forEach((type, index) => {
    result[String(type).toUpperCase()] = index + 1;
  });
  return result;
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

    return normalized;
  });
}

function toSortableTimestamp(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
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
  return [...items].sort((a, b) => {
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
}

function keyOf(item) {
  return `${String(item.objectType || "").toUpperCase()}|${normalizeLookupName(item.schemaName)}|${normalizeLookupName(item.objectName)}`;
}

async function executeSqlBatches(profile, sqlText) {
  await executeSqlScript(profile, sqlText);
}

function escapeSqlString(str) {
  return String(str || "").replace(/'/g, "''");
}

function buildRollbackSql(batches) {
  // Wraps each batch in EXEC() inside a transaction that ALWAYS rolls back.
  // XACT_ABORT OFF so individual EXEC() errors don't abort the whole batch —
  // we let PS/Node surface them as warnings, then rollback unconditionally.
  const execLines = batches
    .map((b) => `EXEC('${escapeSqlString(b)}');`)
    .join("\n");
  return `SET XACT_ABORT OFF;\nBEGIN TRANSACTION;\n${execLines}\nROLLBACK TRANSACTION;`;
}

function splitBatches(sqlText) {
  return String(sqlText || "")
    .split(/^\s*GO\s*$/gim)
    .map((part) => part.trim())
    .filter(Boolean);
}

function writeDeploymentSql(outputDir, fileName, sqlText) {
  const safeName = String(fileName || "deployment_script").replace(/[^a-zA-Z0-9._-]/g, "_");
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${safeName}.sql`);
  fs.writeFileSync(filePath, String(sqlText || ""), "utf8");
  return filePath;
}

function supportsCreateOrAlter(objectType) {
  return ["PROCEDURE", "VIEW", "FUNCTION", "TRIGGER"].includes(String(objectType || "").toUpperCase());
}

function getDirectStrategy(objectType) {
  return supportsCreateOrAlter(objectType) ? "createOrAlter" : "dropCreate";
}

function getActionForObjectType(objectType) {
  const type = String(objectType || "").toUpperCase();
  if (type === "TABLE") return "AlterDelta";
  if (type === "PROCEDURE") return "ExecuteIndividually";
  if (supportsCreateOrAlter(type)) return "CreateOrAlterIndividually";
  return "DropAndCreate";
}

function getRollbackStrategy(objectType) {
  return supportsCreateOrAlter(objectType) ? "createOrAlter" : "dropCreate";
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

function buildDeploymentPlan(selectedObjects) {
  const unique = dedupeSelection(selectedObjects);
  const ordered = sortedByDependency(unique);
  return ordered.map((item) => ({
    ...item,
    action: getActionForObjectType(item.objectType),
  }));
}

async function runDeployment({
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
  const ordered = sortedByDependency(dedupeSelection(selectedObjects));
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

  const scriptOutputRoot = options?.scriptOutputPath || path.resolve(__dirname, "..", "..", "artifacts", "exports");
  const exportedSourceObjects = ordered.filter((item) => item.objectType !== "TABLE");
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
  fs.mkdirSync(generated.runRoot, { recursive: true });
  const deploymentScriptDir = path.join(generated.runRoot, "Deployment Scripts");
  const generatedScripts = generatedInfo.scripts;
  const generatedScriptMap = new Map(generatedScripts.map((entry) => [keyOf(entry), entry]));
  const combinedStoredProceduresPath = generatedInfo.combinedStoredProceduresPath;
  const hasTables = ordered.some((item) => item.objectType === "TABLE");

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
      const executableSql = normalizeExecutableSql(rawSql, genItem.objectType, {
        schemaName: genItem.schemaName,
        objectName: genItem.objectName,
      }, {
        strategy: getRollbackStrategy(genItem.objectType),
      });
      current.scriptPath = writeDeploymentSql(
        deploymentScriptDir,
        `${task.taskId}_${item.objectType}_${item.schemaName}_${item.objectName}`,
        executableSql
      );
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
          if (current && current.scriptPath && current.status !== "Failed") {
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
        logEvent("INFO", "Rollback validation completed. No DB changes made.");
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
      rollbackApplied: true,
    };
  }

  // ExecuteDirectly mode - execute non-table scripts independently through a
  // shared session, preserving exact object attribution without reconnecting
  // for every script. Tables remain a grouped delta operation at their order position.
  let tablesProcessed = false;
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
          };
        }
      }
      while (index < ordered.length && ordered[index].objectType === "TABLE") {
        index += 1;
      }
      continue;
    }

    const executionGroup = [];
    while (index < ordered.length && ordered[index].objectType !== "TABLE") {
      const groupItem = ordered[index];
      index += 1;
      const genItem = generatedScriptMap.get(keyOf(groupItem));
      const current = resultsByKey.get(keyOf(groupItem));
      if (!genItem || !current) continue;

      const rawSql = fs.readFileSync(genItem.scriptPath, "utf8");
      const executableSql = normalizeExecutableSql(rawSql, genItem.objectType, {
        schemaName: genItem.schemaName,
        objectName: genItem.objectName,
      }, {
        strategy: getDirectStrategy(genItem.objectType),
      });
      const deploymentScriptPath = writeDeploymentSql(
        deploymentScriptDir,
        `${task.taskId}_${groupItem.objectType}_${groupItem.schemaName}_${groupItem.objectName}`,
        executableSql
      );
      current.scriptPath = deploymentScriptPath;
      current.errorMessage = null;
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
      logEvent("ERROR", "Object deployment failed", {
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
    };
  }

  return {
    plan: ordered,
    results: [...resultsByKey.values()],
    generatedRoot: generated.runRoot,
    buildPathFile: generated.latestBuildPathFile,
  };
}

module.exports = {
  runDeployment,
  buildDeploymentPlan,
};
