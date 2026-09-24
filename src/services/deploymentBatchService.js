const path = require("path");
const { createHash } = require("crypto");
const { buildDerivedDeploymentPlan, deploymentPlanFingerprint, runDeployment } = require("./deploymentService");
const { testConnection } = require("./sqlService");
const { createTaskLog, appendTaskEvent, finalizeTaskLog } = require("./loggingService");
const { EXPORTS_DIR } = require("./paths");

function describeConnection(profile) {
  return { id: profile.id, profileLabel: profile.profileLabel, serverName: profile.serverName,
    databaseName: profile.databaseName, environmentTag: profile.environmentTag, kind: profile.kind, folderPath: profile.folderPath };
}

function validateBatch(targetProfiles, mode) {
  if (!Array.isArray(targetProfiles) || !targetProfiles.length || targetProfiles.length > 20) throw new Error("Choose 1 to 20 target connections.");
  if (new Set(targetProfiles.map((profile) => profile.id)).size !== targetProfiles.length) throw new Error("Duplicate target connections are not allowed.");
  if (!["ExecuteDirectly", "Rollback", "DryRun"].includes(mode)) throw new Error("Batch deployment supports Apply, Rollback, or Dry Run only.");
}

async function buildBatchPlan({ sourceProfile, targetProfiles, selectedObjects, mode, continueOnError = false, continueTargetsOnError = false }) {
  validateBatch(targetProfiles, mode);
  const identity = (value) => {
    if (!value?.serverName || !value?.databaseName) throw new Error("Could not verify database identity.");
    return { serverName: value.serverName, databaseName: value.databaseName };
  };
  const sourceIdentity = sourceProfile.kind === "Folder" ? null : identity(await testConnection(sourceProfile));
  const targetIdentities = (await Promise.all(targetProfiles.map(testConnection))).map(identity);
  const identityKey = (value) => JSON.stringify([value.serverName.toLowerCase(), value.databaseName.toLowerCase()]);
  const identities = new Set(sourceIdentity ? [identityKey(sourceIdentity)] : []);
  for (const target of targetIdentities) {
    if (identities.has(identityKey(target))) throw new Error("Two connections resolve to the same database. No deployment started.");
    identities.add(identityKey(target));
  }
  const plan = await buildDerivedDeploymentPlan(sourceProfile, selectedObjects, undefined, mode);
  const plans = targetProfiles.map((target, index) => {
    if (sourceProfile.kind !== "Folder" && sourceProfile.serverName.toLowerCase() === target.serverName.toLowerCase() && sourceProfile.databaseName.toLowerCase() === target.databaseName.toLowerCase()) throw new Error("A target is the source database. Choose different targets.");
    return { plan, fingerprint: deploymentPlanFingerprint(plan, sourceProfile, target, mode), targetConnection: describeConnection(target), resolvedIdentity: targetIdentities[index] };
  });
  const fingerprint = createHash("sha256").update(JSON.stringify([sourceIdentity, mode, plans.map((item) => [item.fingerprint, item.resolvedIdentity]), Boolean(continueOnError), Boolean(continueTargetsOnError)])).digest("hex");
  return { sourceConnection: describeConnection(sourceProfile), sourceIdentity, plans, fingerprint };
}

function summarizeResults(results = []) {
  return { total: results.length, success: results.filter((item) => item.status === "Success").length,
    rolledBack: results.filter((item) => item.status === "RolledBack").length,
    generated: results.filter((item) => item.status === "ScriptGenerated").length,
    failed: results.filter((item) => item.status === "Failed").length,
    reviewRequired: results.filter((item) => item.status === "ReviewRequired").length,
    skipped: results.filter((item) => item.status === "Skipped").length };
}

async function runDeploymentBatch(request) {
  const { sourceProfile, targetProfiles, selectedObjects, mode, options = {}, continueOnError = false, continueTargetsOnError = false, logLevel, onProgress = () => {} } = request;
  const reviewed = await buildBatchPlan(request);
  if (options.confirmedBatchFingerprint !== reviewed.fingerprint) throw new Error("The multi-target plan changed. Review and confirm it again.");
  const targets = [];
  let stopped = false;
  for (const [index, target] of targetProfiles.entries()) {
    if (stopped) { targets.push({ targetConnection: describeConnection(target), status: "NotStarted", summary: summarizeResults(), itemResults: [] }); continue; }
    const task = createTaskLog("Deploy", { sourceProfileLabel: sourceProfile.profileLabel, destinationProfileLabel: target.profileLabel, selectedObjects, logLevel });
    try {
      onProgress("targetStart", { target: describeConnection(target), index: index + 1, total: targetProfiles.length, taskId: task.taskId });
      const result = await runDeployment({ sourceProfile, destinationProfile: target, selectedObjects, mode, continueOnError,
        options: { ...options, confirmedPlanFingerprint: reviewed.plans[index].fingerprint,
          confirmedSourceIdentity: reviewed.sourceIdentity, confirmedTargetIdentity: reviewed.plans[index].resolvedIdentity,
          scriptOutputPath: path.join(options.scriptOutputPath || EXPORTS_DIR, `Target_${String(target.id).replace(/[^a-zA-Z0-9_-]/g, "_")}`) },
        task, logEvent: (level, message, details) => appendTaskEvent(task, level, message, details),
        broadcastProgress: (event, data) => onProgress(event, { ...data, targetProfileId: target.id, targetProfileLabel: target.profileLabel }),
      });
      const summary = summarizeResults(result.results);
      const status = summary.failed ? "Failed" : summary.reviewRequired ? "ReviewRequired" : "Success";
      finalizeTaskLog(task, status, summary);
      targets.push({ targetConnection: describeConnection(target), taskId: task.taskId, status, summary,
        itemResults: result.results, generatedRoot: result.generatedRoot, logFilePath: task.textPath });
      if (status !== "Success" && !continueTargetsOnError) stopped = true;
    } catch (error) {
      appendTaskEvent(task, "ERROR", "Target deployment failed", { errorMessage: error.message });
      finalizeTaskLog(task, "Failed", { error: error.message });
      targets.push({ targetConnection: describeConnection(target), taskId: task.taskId, status: "Failed", error: error.message, summary: { ...summarizeResults(), failed: 1 }, itemResults: [], logFilePath: task.textPath });
      if (!continueTargetsOnError) stopped = true;
    }
  }
  return { targets, summary: { total: targets.length, success: targets.filter((target) => target.status === "Success").length,
    failed: targets.filter((target) => target.status === "Failed").length, reviewRequired: targets.filter((target) => target.status === "ReviewRequired").length,
    notStarted: targets.filter((target) => target.status === "NotStarted").length } };
}

module.exports = { buildBatchPlan, runDeploymentBatch, summarizeResults };