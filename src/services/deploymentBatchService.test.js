jest.mock("./deploymentService", () => ({ buildDerivedDeploymentPlan: jest.fn(), deploymentPlanFingerprint: jest.fn((plan, source, target) => `${source.id}:${target.id}`), runDeployment: jest.fn() }));
jest.mock("./sqlService", () => ({ testConnection: jest.fn(async (profile) => profile) }));
jest.mock("./loggingService", () => ({ createTaskLog: jest.fn((type, context) => ({ taskId: context.destinationProfileLabel, textPath: `${context.destinationProfileLabel}.log` })), appendTaskEvent: jest.fn(), finalizeTaskLog: jest.fn() }));
const { buildDerivedDeploymentPlan, runDeployment } = require("./deploymentService");
const { buildBatchPlan, runDeploymentBatch } = require("./deploymentBatchService");
const { testConnection } = require("./sqlService");

describe("multi-target deployment", () => {
  let request;
  beforeEach(() => {
    jest.clearAllMocks();
    request = { sourceProfile: { id: "src", serverName: "host", databaseName: "Source" }, targetProfiles: [
      { id: "qa", profileLabel: "QA", serverName: "host", databaseName: "QA" },
      { id: "uat", profileLabel: "UAT", serverName: "host", databaseName: "UAT" },
    ], selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "Fixture" }], mode: "DryRun", options: {} };
    buildDerivedDeploymentPlan.mockResolvedValue(request.selectedObjects);
    runDeployment.mockResolvedValue({ results: [{ status: "ScriptGenerated" }], generatedRoot: "output" });
    testConnection.mockImplementation(async (profile) => profile);
  });
  test("requires a current batch confirmation and produces separate target logs", async () => {
    await expect(runDeploymentBatch(request)).rejects.toThrow("confirm");
    expect(runDeployment).not.toHaveBeenCalled();
    request.options.confirmedBatchFingerprint = (await buildBatchPlan(request)).fingerprint;
    const result = await runDeploymentBatch(request);
    expect(result.targets.map((target) => target.logFilePath)).toEqual(["QA.log", "UAT.log"]);
    expect(runDeployment.mock.calls[0][0].options.scriptOutputPath).not.toBe(runDeployment.mock.calls[1][0].options.scriptOutputPath);
    expect(result.summary.success).toBe(2);
  });
  test("stops after a failed target unless continuing was explicitly reviewed", async () => {
    request.options.confirmedBatchFingerprint = (await buildBatchPlan(request)).fingerprint;
    runDeployment.mockRejectedValueOnce(new Error("target failure"));
    const result = await runDeploymentBatch(request);
    expect(result.targets.map((target) => target.status)).toEqual(["Failed", "NotStarted"]);
    expect(runDeployment).toHaveBeenCalledTimes(1);
    request.continueTargetsOnError = true;
    await expect(runDeploymentBatch(request)).rejects.toThrow("plan changed");
  });
  test("refuses aliases resolving to one target before execution", async () => {
    request.options.confirmedBatchFingerprint = (await buildBatchPlan(request)).fingerprint;
    testConnection.mockResolvedValue({ serverName: "actual", databaseName: "same" });
    await expect(runDeploymentBatch(request)).rejects.toThrow("same database");
    expect(runDeployment).not.toHaveBeenCalled();
  });
});