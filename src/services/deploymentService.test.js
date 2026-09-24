"use strict";

jest.mock("./sqlService", () => ({
  testConnection: jest.fn(async (profile) => ({ serverName: profile.serverName, databaseName: profile.databaseName })),
  executeSql: jest.fn().mockResolvedValue(undefined),
  executeSqlScript: jest.fn().mockResolvedValue(undefined),
  executeSqlScriptsIndividually: jest.fn().mockImplementation((_profile, scripts) => Promise.resolve(
    scripts.map((script) => ({ key: script.key, ok: true, error: null }))
  )),
  fetchObjectDefinitionMap: jest.fn().mockResolvedValue(new Map()),
  fetchTypeSignatureMap: jest.fn().mockResolvedValue(new Map()),
  fetchObjectDependencyEdges: jest.fn().mockResolvedValue([]),
}));
jest.mock("./loggingService", () => ({
  writeScriptArtifact: jest.fn(),
}));
jest.mock("./dacfxService", () => ({
  compareGeneratedArtifacts: jest.fn(),
  deployGeneratedArtifacts: jest.fn(),
  isDacFxEngine: jest.fn((value) => String(value || "").trim() === "DacFx"),
  normalizeEngine: jest.fn((value) => (String(value || "DacFx").trim() === "Legacy" ? "Legacy" : "DacFx")),
  validateGeneratedArtifacts: jest.fn(),
}));
jest.mock("./scriptAutomationService", () => ({
  buildProfileOutputBasePath: jest.fn((outputBasePath, profileLabel) => `${outputBasePath}/profiles/${profileLabel || "default"}`),
  buildRunRoot: jest.fn((outputBasePath, databaseName) => `${outputBasePath}/run/${databaseName}`),
  generateTableDelta: jest.fn(),
  normalizeExecutableSql: jest.fn((sql, objectType, context = {}, options = {}) => {
    const metadata = options.moduleMetadata || {};
    const type = String(objectType || "").toUpperCase();
    let text = sql;
    if (["PROCEDURE", "VIEW", "FUNCTION", "TRIGGER"].includes(type)) {
      const headerLines = [];
      if (metadata.usesAnsiNulls != null) {
        headerLines.push(`SET ANSI_NULLS ${metadata.usesAnsiNulls ? "ON" : "OFF"}`);
      }
      if (metadata.usesQuotedIdentifier != null) {
        headerLines.push(`SET QUOTED_IDENTIFIER ${metadata.usesQuotedIdentifier ? "ON" : "OFF"}`);
      }
      if (headerLines.length) {
        text = `${headerLines.join("\nGO\n")}\nGO\n${text}`;
      }
    }

    if (options.strategy === "dropCreate" && context.schemaName && context.objectName && ["VIEW", "FUNCTION", "TRIGGER", "SYNONYM", "SEQUENCE", "USER_DEFINED_TYPE"].includes(type)) {
      text = `DROP_CREATE:${type}:${context.schemaName}.${context.objectName}\n${text}`;
    }

    return text;
  }),
}));
jest.mock("./scriptGenerationService", () => ({
  generateScriptsForProfile: jest.fn(),
}));
jest.mock("./settingsService", () => ({
  getSettings: jest.fn(() => ({
    folderNames: {
      PROCEDURE: "Stored Procedures",
      VIEW: "Views",
      FUNCTION: "Functions",
      TABLE: "Tables",
      SYNONYM: "Synonyms",
      SEQUENCE: "Sequences",
      USER_DEFINED_TYPE: "User Defined Types",
    },
    deploymentOrder: ["USER_DEFINED_TYPE", "SEQUENCE", "TABLE", "VIEW", "FUNCTION", "PROCEDURE", "SYNONYM", "TRIGGER"],
  })),
}));
jest.mock("fs", () => ({
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(() => "CREATE OR ALTER PROCEDURE dbo.GetUser AS SELECT 1"),
  writeFileSync: jest.fn(),
  existsSync: jest.fn(() => false),
}));

const {
  generateTableDelta,
  normalizeExecutableSql,
} = require("./scriptAutomationService");
const { testConnection, fetchObjectDefinitionMap, fetchObjectDependencyEdges } = require("./sqlService");
const { compareGeneratedArtifacts, deployGeneratedArtifacts } = require("./dacfxService");
const { generateScriptsForProfile } = require("./scriptGenerationService");
const { runDeployment, buildDeploymentPlan, buildDerivedDeploymentPlan, deploymentPlanFingerprint } = require("./deploymentService");

const srcProfile = { serverName: "srcServer", databaseName: "srcDb" };
const dstProfile = { serverName: "dstServer", databaseName: "dstDb" };
const task = { taskId: "test-task-001" };
const logEvent = jest.fn();

function makeGeneratedInfo(runRoot = "/out", scripts = []) {
  const hasProcedures = scripts.some((script) => script.objectType === "PROCEDURE");
  return {
    generated: { runRoot, latestBuildPathFile: `${runRoot}/BuildPaths.txt` },
    scripts,
    combinedStoredProceduresPath: hasProcedures ? `${runRoot}/AllStoredProcedures_20260706_120000.sql` : null,
    selectedObjects: [],
    generationWarnings: [],
  };
}

describe("runDeployment", () => {
  const udt = { objectType: "USER_DEFINED_TYPE", schemaName: "finance", objectName: "OverPaymentUsedType" };

  it("skips an identical user-defined type instead of dropping and recreating it", async () => {
    const { fetchTypeSignatureMap, executeSqlScriptsIndividually } = require("./sqlService");
    const signature = new Map([["USER_DEFINED_TYPE|finance|overpaymentusedtype", "TYPE#0#decimal:9:19:4::0:0"]]);
    fetchTypeSignatureMap.mockResolvedValueOnce(signature).mockResolvedValueOnce(new Map(signature));
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { ...udt, scriptPath: "/out/finance.OverPaymentUsedType.sql" },
    ]));

    const result = await runDeployment({ sourceProfile: srcProfile, destinationProfile: dstProfile,
      selectedObjects: [udt], mode: "ExecuteDirectly", options: {}, task, logEvent,
    });

    expect(result.results[0]).toMatchObject({ status: "Skipped", action: "NoChange" });
    expect(executeSqlScriptsIndividually).not.toHaveBeenCalled();
  });

  it("still deploys a user-defined type whose shape changed", async () => {
    const { fetchTypeSignatureMap, executeSqlScriptsIndividually } = require("./sqlService");
    fetchTypeSignatureMap
      .mockResolvedValueOnce(new Map([["USER_DEFINED_TYPE|finance|overpaymentusedtype", "TYPE#0#decimal:9:19:4::0:0"]]))
      .mockResolvedValueOnce(new Map([["USER_DEFINED_TYPE|finance|overpaymentusedtype", "TYPE#0#decimal:9:19:2::0:0"]]));
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { ...udt, scriptPath: "/out/finance.OverPaymentUsedType.sql" },
    ]));

    const result = await runDeployment({ sourceProfile: srcProfile, destinationProfile: dstProfile,
      selectedObjects: [udt], mode: "ExecuteDirectly", options: {}, task, logEvent,
    });

    expect(result.results[0].status).toBe("Success");
    expect(executeSqlScriptsIndividually).toHaveBeenCalled();
  });

  it.each(["ExecuteDirectly", "Rollback", "DryRun"])("stops %s when UDT comparison fails, even with continue-on-error", async (mode) => {
    const sql = require("./sqlService");
    sql.fetchTypeSignatureMap.mockRejectedValueOnce(new Error("Cannot resolve collation conflict in UNION ALL column 5"));
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { ...udt, scriptPath: "/out/type.sql" },
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "Consumer", scriptPath: "/out/consumer.sql" },
    ]));
    await expect(runDeployment({ sourceProfile: srcProfile, destinationProfile: dstProfile,
      selectedObjects: [udt, { objectType: "PROCEDURE", schemaName: "dbo", objectName: "Consumer" }],
      mode, continueOnError: true, options: {}, task, logEvent,
    })).rejects.toThrow("User-defined type comparison failed; no deployment SQL was executed.");
    expect(sql.executeSqlScript).not.toHaveBeenCalled();
    expect(sql.executeSqlScriptsIndividually).not.toHaveBeenCalled();
    expect(sql.executeSql).not.toHaveBeenCalled();
    expect(generateTableDelta).not.toHaveBeenCalled();
  });

  it("does not treat missing structural metadata as equal based on coarse type definitions", async () => {
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [{ ...udt, scriptPath: "/out/type.sql" }]));
    await expect(runDeployment({ sourceProfile: srcProfile, destinationProfile: dstProfile,
      selectedObjects: [udt], mode: "ExecuteDirectly", options: {}, task, logEvent,
    })).rejects.toThrow("Source type metadata is missing for finance.OverPaymentUsedType");
    expect(fetchObjectDefinitionMap).not.toHaveBeenCalled();
    expect(require("./sqlService").executeSqlScriptsIndividually).not.toHaveBeenCalled();
  });

  it("retains an identical UDT skip when unrelated definition comparison fails", async () => {
    const sql = require("./sqlService");
    const signatures = new Map([["USER_DEFINED_TYPE|finance|overpaymentusedtype", "TYPE#0#table"]]);
    sql.fetchTypeSignatureMap.mockResolvedValueOnce(signatures).mockResolvedValueOnce(new Map(signatures));
    fetchObjectDefinitionMap.mockRejectedValueOnce(new Error("Module metadata unavailable"));
    const view = { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" };
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { ...udt, scriptPath: "/out/type.sql" }, { ...view, scriptPath: "/out/view.sql" },
    ]));
    const result = await runDeployment({ sourceProfile: srcProfile, destinationProfile: dstProfile,
      selectedObjects: [udt, view], mode: "ExecuteDirectly", options: {}, task, logEvent,
    });
    expect(result.results.find((item) => item.objectType === "USER_DEFINED_TYPE")).toMatchObject({ status: "Skipped", action: "NoChange" });
    expect(sql.executeSqlScriptsIndividually.mock.calls[0][1]).toHaveLength(1);
    expect(sql.executeSqlScriptsIndividually.mock.calls[0][1][0].key).toBe("VIEW|dbo|viewa");
  });

  it("creates a UDT absent from the target when source metadata is available", async () => {
    const sql = require("./sqlService");
    sql.fetchTypeSignatureMap.mockResolvedValueOnce(new Map([["USER_DEFINED_TYPE|finance|overpaymentusedtype", "TYPE#0#table"]]))
      .mockResolvedValueOnce(new Map());
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [{ ...udt, scriptPath: "/out/type.sql" }]));
    const result = await runDeployment({ sourceProfile: srcProfile, destinationProfile: dstProfile,
      selectedObjects: [udt], mode: "ExecuteDirectly", options: {}, task, logEvent,
    });
    expect(result.results[0].status).toBe("Success");
    expect(logEvent).toHaveBeenCalledWith("INFO", "User-defined type comparison completed", expect.objectContaining({ comparison: "MissingOnTarget" }));
  });

  it("DryRun writes every script for review and executes nothing", async () => {
    const fs = require("fs");
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA", scriptPath: "/out/dbo.ViewA.sql" },
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA", scriptPath: "/out/dbo.ProcA.sql" },
    ]));
    generateTableDelta.mockResolvedValue({ scriptText: "ALTER TABLE dbo.T ADD C INT NULL;", outputPath: "/out/delta.sql" });

    const result = await runDeployment({ sourceProfile: srcProfile, destinationProfile: dstProfile,
      selectedObjects: [
        { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" },
        { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" },
        { objectType: "TABLE", schemaName: "dbo", objectName: "T" },
      ],
      mode: "DryRun", options: {}, task, logEvent,
    });

    expect(result.dryRun).toBe(true);
    expect(result.results.every((item) => item.status === "ScriptGenerated")).toBe(true);
    expect(result.results.find((item) => item.objectType === "TABLE").scriptPath).toBe("/out/delta.sql");
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining("VIEW_dbo_ViewA.sql"), expect.any(String), "utf8");
    const sql = require("./sqlService");
    expect(sql.executeSqlScript).not.toHaveBeenCalled();
    expect(sql.executeSqlScriptsIndividually).not.toHaveBeenCalled();
    expect(sql.executeSql).not.toHaveBeenCalled();
  });

  it("reports guarded table migrations as ReviewRequired without executing the delta", async () => {
    generateTableDelta.mockRejectedValueOnce(new Error("Table delta requires manual review; no table delta was executed."));
    const progress = jest.fn();
    const result = await runDeployment({ sourceProfile: srcProfile, destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "TABLE", schemaName: "dbo", objectName: "Data" }], mode: "ExecuteDirectly", options: {}, task, logEvent, broadcastProgress: progress,
    });
    expect(result.results[0].status).toBe("ReviewRequired");
    expect(progress).toHaveBeenCalledWith("deployProgress", expect.objectContaining({ status: "ReviewRequired" }));
    expect(require("./sqlService").executeSqlScript).not.toHaveBeenCalled();
  });

  it("formats all fresh source objects and executes only supported modules", async () => {
    generateScriptsForProfile.mockResolvedValue({
      ...makeGeneratedInfo("/out", [
        { objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser", scriptPath: "/out/dbo.GetUser.sql" },
        { objectType: "TABLE", schemaName: "dbo", objectName: "Data", scriptPath: "/out/dbo.Data.sql" },
      ]),
      formattingApplied: true,
    });
    const result = await runDeployment({ sourceProfile: srcProfile, destinationProfile: srcProfile,
      selectedObjects: [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser" }, { objectType: "TABLE", schemaName: "dbo", objectName: "Data" }],
      mode: "FormatAndExecuteSource", options: { confirmedSourceDatabase: srcProfile.databaseName }, task, logEvent,
    });
    expect(generateScriptsForProfile).toHaveBeenCalledWith(expect.objectContaining({ forceFormatting: true, appTaskMode: "deploy", selectedObjects: [
      expect.objectContaining({ objectType: "TABLE" }),
      expect.objectContaining({ objectType: "PROCEDURE" }),
    ] }));
    expect(require("./sqlService").executeSqlScript).toHaveBeenCalledWith(srcProfile, expect.stringContaining("PROCEDURE"), { atomic: true });
    expect(generateTableDelta).not.toHaveBeenCalled();
    expect(result.results.find((item) => item.objectType === "TABLE")).toMatchObject({
      status: "Skipped", action: "NoStoredModuleText", scriptPath: "/out/dbo.Data.sql",
    });
    expect(result.results.find((item) => item.objectType === "PROCEDURE").status).toBe("Success");
  });

  it("refuses format-and-execute when target identity differs from the confirmed source", async () => {
    await expect(runDeployment({ sourceProfile: srcProfile, destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" }],
      mode: "FormatAndExecuteSource", options: { confirmedSourceDatabase: srcProfile.databaseName }, task, logEvent,
    })).rejects.toThrow("must target the confirmed source");
    expect(generateScriptsForProfile).not.toHaveBeenCalled();
  });

  it("requires explicit source confirmation before format-and-execute connects or generates", async () => {
    await expect(runDeployment({ sourceProfile: srcProfile, destinationProfile: srcProfile,
      selectedObjects: [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" }],
      mode: "FormatAndExecuteSource", options: {}, task, logEvent,
    })).rejects.toThrow("Confirm the source database");
    expect(testConnection).not.toHaveBeenCalled();
    expect(generateScriptsForProfile).not.toHaveBeenCalled();
  });

  it("rejects a changed confirmed plan before generating or executing scripts", async () => {
    const selectedObjects = [{ objectType: "VIEW", schemaName: "dbo", objectName: "Current" }];
    const confirmedPlanFingerprint = deploymentPlanFingerprint([
      { objectType: "VIEW", schemaName: "dbo", objectName: "Previous" },
    ], srcProfile, dstProfile, "ExecuteDirectly");
    await expect(runDeployment({ sourceProfile: srcProfile, destinationProfile: dstProfile,
      selectedObjects, mode: "ExecuteDirectly", options: { confirmedPlanFingerprint }, task, logEvent,
    })).rejects.toThrow("Review and confirm a fresh plan");
    expect(generateScriptsForProfile).not.toHaveBeenCalled();
    expect(require("./sqlService").executeSqlScript).not.toHaveBeenCalled();
  });

  it("binds confirmation to connection identity, mode, and dependency edges", () => {
    const plan = [{ objectType: "VIEW", schemaName: "dbo", objectName: "Current" }];
    const fingerprint = deploymentPlanFingerprint(plan, srcProfile, dstProfile, "ExecuteDirectly");
    expect(deploymentPlanFingerprint(plan, srcProfile, { ...dstProfile, databaseName: "Other" }, "ExecuteDirectly")).not.toBe(fingerprint);
    expect(deploymentPlanFingerprint(plan, srcProfile, dstProfile, "Rollback")).not.toBe(fingerprint);
    expect(deploymentPlanFingerprint([{ ...plan[0], dependencies: ["dbo.New"] }], srcProfile, dstProfile, "ExecuteDirectly")).not.toBe(fingerprint);
  });

  it("places all external dependencies before a combined procedure group", () => {
    const plan = buildDeploymentPlan([
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" },
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcB", dependencies: ["dbo.LateSynonym"] },
      { objectType: "SYNONYM", schemaName: "dbo", objectName: "LateSynonym" },
    ]);
    expect(plan.map((item) => item.objectName)).toEqual(["LateSynonym", "ProcA", "ProcB"]);
  });

  it("rejects a dependency cycle introduced by mandatory grouping", () => {
    expect(() => buildDeploymentPlan([
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" },
      { objectType: "SYNONYM", schemaName: "dbo", objectName: "Bridge", dependencies: ["dbo.ProcA"] },
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcB", dependencies: ["dbo.Bridge"] },
    ])).toThrow("cycle across combined deployment groups");
  });

  it("rejects distinct aliases that resolve to the same physical database", async () => {
    testConnection.mockResolvedValueOnce({ serverName: "SQLHOST", databaseName: "ActualDb" })
      .mockResolvedValueOnce({ serverName: "sqlhost", databaseName: "actualdb" });
    await expect(runDeployment({ sourceProfile: srcProfile, destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" }],
      mode: "ExecuteDirectly", options: {}, task, logEvent,
    })).rejects.toThrow("resolve to the same database");
    expect(generateScriptsForProfile).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    const fs = require("fs");
    fs.existsSync.mockImplementation((filePath) => String(filePath).includes("AllStoredProcedures_"));
    fs.readFileSync.mockImplementation((filePath) => {
      if (String(filePath).includes("AllStoredProcedures_")) {
        return "CREATE OR ALTER PROCEDURE dbo.GetUser AS SELECT 1";
      }
      return "CREATE OR ALTER PROCEDURE dbo.GetUser AS SELECT 1";
    });
  });

  it("executes SQL for non-table objects in ExecuteDirectly mode", async () => {
    const fs = require("fs");
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser", scriptPath: "/out/dbo.GetUser.sql" },
    ]));
    const result = await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser" }],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: { engine: "Legacy" },
      task,
      logEvent,
    });

    expect(result.results[0].status).toBe("Success");
    expect(result.results[0].action).toBe("ExecuteCombinedProcedures");
    expect(result.results[0].scriptPath).toContain("AllStoredProcedures_");
    expect(require("./sqlService").executeSqlScript).toHaveBeenCalledTimes(1);
    expect(require("./sqlService").executeSqlScriptsIndividually).not.toHaveBeenCalled();
    expect(generateScriptsForProfile).toHaveBeenCalledWith(expect.objectContaining({ appTaskMode: "deploy" }));
  });

  it.each([false, true])("reports rollback acknowledgement accurately when execution fails: %s", async (executionFails) => {
    const fs = require("fs");
    if (executionFails) require("./sqlService").executeSql.mockRejectedValueOnce(new Error("Database outcome is uncertain"));
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser", scriptPath: "/out/dbo.GetUser.sql" },
    ]));

    const result = await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser" }],
      mode: "Rollback",
      continueOnError: false,
      options: { engine: "Legacy" },
      task,
      logEvent,
    });

    expect(result.results[0].status).toBe(executionFails ? "Failed" : "RolledBack");
    expect(result.rollbackApplied).toBe(!executionFails);
    // executeSql is called once with the rollback transaction wrapper
    expect(require("./sqlService").executeSql).toHaveBeenCalledTimes(1);
    const sqlArg = require("./sqlService").executeSql.mock.calls[0][1];
    expect(sqlArg).toContain("BEGIN TRANSACTION");
    expect(sqlArg).toContain("ROLLBACK TRANSACTION");
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("rollback_validation.sql"),
      expect.stringContaining("ROLLBACK TRANSACTION"),
      "utf8"
    );
  });

  it("uses dropCreate strategy for view rollback batches and emits progress", async () => {
    const broadcastProgress = jest.fn();
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA", scriptPath: "/out/dbo.ViewA.sql" },
    ]));

    const result = await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" }],
      mode: "Rollback",
      continueOnError: false,
      options: { engine: "Legacy" },
      task,
      logEvent,
      broadcastProgress,
    });

    expect(result.results[0].status).toBe("RolledBack");
    expect(normalizeExecutableSql).toHaveBeenCalledWith(
      expect.any(String),
      "VIEW",
      expect.objectContaining({ schemaName: "dbo", objectName: "ViewA" }),
      expect.objectContaining({ strategy: "dropCreate" })
    );
    expect(broadcastProgress).toHaveBeenCalledWith(
      "deployProgress",
      expect.objectContaining({ objectType: "VIEW", objectName: "ViewA", status: "RolledBack", done: 1, total: 1 })
    );
  });

  it("rehydrates non-default programmable object metadata into drop-create deploy artifacts", async () => {
    const fs = require("fs");
    fs.readFileSync.mockImplementation(() => "CREATE VIEW dbo.ViewA AS SELECT 1");
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      {
        objectType: "VIEW",
        schemaName: "dbo",
        objectName: "ViewA",
        scriptPath: "/out/dbo.ViewA.sql",
        moduleMetadata: { usesAnsiNulls: false, usesQuotedIdentifier: true, definitionSource: "exact" },
      },
    ]));

    await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" }],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: { engine: "Legacy" },
      task,
      logEvent,
    });

    expect(normalizeExecutableSql).toHaveBeenCalledWith(
      "CREATE VIEW dbo.ViewA AS SELECT 1",
      "VIEW",
      expect.objectContaining({ schemaName: "dbo", objectName: "ViewA" }),
      expect.objectContaining({
        strategy: "dropCreate",
        moduleMetadata: { usesAnsiNulls: false, usesQuotedIdentifier: true, definitionSource: "exact" },
      })
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("VIEW_dbo_ViewA.sql"),
      expect.stringContaining("DROP_CREATE:VIEW:dbo.ViewA\r\nSET ANSI_NULLS OFF\r\nGO\r\nSET QUOTED_IDENTIFIER ON\r\nGO\r\nCREATE VIEW dbo.ViewA AS SELECT 1"),
      "utf8"
    );
  });

  it("fails before execution when a fresh source script is missing", async () => {
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", []));

    await expect(runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "Missing" }],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: { engine: "Legacy" },
      task,
      logEvent,
    })).rejects.toThrow("no fresh source script was generated");
    expect(require("./sqlService").executeSqlScript).not.toHaveBeenCalled();
    expect(require("./sqlService").executeSqlScriptsIndividually).not.toHaveBeenCalled();
  });

  it.each(["ExecuteDirectly", "Rollback"])("requires the fresh combined procedure artifact before any execution in %s", async (mode) => {
    generateScriptsForProfile.mockResolvedValue({
      ...makeGeneratedInfo("/out", [
        { objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser", scriptPath: "/out/dbo.GetUser.sql" },
      ]),
      combinedStoredProceduresPath: null,
    });
    await expect(runDeployment({ sourceProfile: srcProfile, destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser" }],
      mode, options: {}, task, logEvent,
    })).rejects.toThrow("nonempty combined stored procedure");
    expect(require("./sqlService").executeSql).not.toHaveBeenCalled();
    expect(require("./sqlService").executeSqlScript).not.toHaveBeenCalled();
    expect(require("./sqlService").executeSqlScriptsIndividually).not.toHaveBeenCalled();
  });

  it("matches generated scripts case-insensitively when PowerShell emits different filename casing", async () => {
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { objectType: "PROCEDURE", schemaName: "Reports", objectName: "usppendingrefundrequestsreport", scriptPath: "/out/Reports.usppendingrefundrequestsreport.sql" },
    ]));

    const result = await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "PROCEDURE", schemaName: "Reports", objectName: "UspPendingRefundRequestsReport" }],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: { engine: "Legacy" },
      task,
      logEvent,
    });

    expect(result.results[0].status).toBe("Success");
    expect(result.results[0].scriptPath).toContain("AllStoredProcedures_");
  });

  it("marks object as Failed on SQL execution error and stops when continueOnError=false", async () => {
    const { executeSqlScript } = require("./sqlService");
    executeSqlScript.mockRejectedValueOnce(new Error("SQL error"));

    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "BrokenProc", scriptPath: "/out/dbo.BrokenProc.sql" },
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "GoodProc", scriptPath: "/out/dbo.GoodProc.sql" },
    ]));

    const result = await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [
        { objectType: "PROCEDURE", schemaName: "dbo", objectName: "BrokenProc" },
        { objectType: "PROCEDURE", schemaName: "dbo", objectName: "GoodProc" },
      ],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: { engine: "Legacy" },
      task,
      logEvent,
    });

    const broken = result.results.find((r) => r.objectName === "BrokenProc");
    expect(broken.status).toBe("Failed");
    expect(broken.errorMessage).toBe("SQL error");
  });

  it("deduplicates duplicate synonym selections before deployment execution", async () => {
    const fs = require("fs");
    const { executeSqlScriptsIndividually } = require("./sqlService");
    fs.readFileSync.mockImplementation(() => "CREATE SYNONYM [dbo].[SynA] FOR [other].[BaseA]");

    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { objectType: "SYNONYM", schemaName: "dbo", objectName: "SynA", scriptPath: "/out/dbo.SynA.sql" },
    ]));

    const result = await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [
        { objectType: "SYNONYM", schemaName: "dbo", objectName: "SynA" },
        { objectType: "SYNONYM", schemaName: "dbo", objectName: "SynA" },
      ],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: { engine: "Legacy" },
      task,
      logEvent,
    });

    expect(executeSqlScriptsIndividually).toHaveBeenCalledTimes(1);
    expect(executeSqlScriptsIndividually.mock.calls[0][1]).toHaveLength(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].objectType).toBe("SYNONYM");
  });

  it("labels modules for individual execution and runs objects in deployment order", async () => {
    const fs = require("fs");
    const { executeSqlScriptsIndividually } = require("./sqlService");
    fs.readFileSync.mockImplementation((filePath) => (
      String(filePath).includes("AllStoredProcedures_")
        ? "CREATE OR ALTER PROCEDURE dbo.ProcA AS SELECT 1"
        : String(filePath).includes("ViewA")
        ? "CREATE VIEW dbo.ViewA AS SELECT 1"
        : "CREATE PROCEDURE dbo.ProcA AS SELECT 1"
    ));

    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA", scriptPath: "/out/dbo.ProcA.sql" },
      { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA", scriptPath: "/out/dbo.ViewA.sql" },
    ]));

    const plan = buildDeploymentPlan([
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" },
      { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" },
    ]);
    expect(plan.find((item) => item.objectType === "PROCEDURE").action).toBe("ExecuteCombinedProcedures");
    expect(plan.find((item) => item.objectType === "VIEW").action).toBe("DropAndCreate");

    await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [
        { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" },
        { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" },
      ],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: { engine: "Legacy" },
      task,
      logEvent,
    });

    expect(require("./sqlService").executeSqlScript).toHaveBeenCalledTimes(1);
    expect(executeSqlScriptsIndividually).toHaveBeenCalledTimes(1);
    expect(executeSqlScriptsIndividually.mock.calls[0][1][0].sqlText).toContain("DROP_CREATE:VIEW:dbo.ViewA");
    expect(require("./sqlService").executeSqlScript.mock.calls[0][1]).toContain("ProcA");
    expect(normalizeExecutableSql).toHaveBeenCalledWith(
      expect.any(String),
      "VIEW",
      expect.any(Object),
      expect.objectContaining({ strategy: "dropCreate" })
    );
  });

  it("reports per-procedure status when the combined procedure script succeeds", async () => {
    const fs = require("fs");
    const { executeSqlScript, executeSqlScriptsIndividually } = require("./sqlService");
    const broadcastProgress = jest.fn();
    fs.readFileSync.mockImplementation((filePath) => (
      String(filePath).includes("AllStoredProcedures_")
        ? "CREATE OR ALTER PROCEDURE dbo.ProcA AS SELECT 1\nGO\nCREATE OR ALTER PROCEDURE dbo.ProcB AS SELECT 2"
        : `CREATE PROCEDURE dbo.${String(filePath).includes("ProcA") ? "ProcA" : "ProcB"} AS SELECT 1`
    ));
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA", scriptPath: "/out/dbo.ProcA.sql" },
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcB", scriptPath: "/out/dbo.ProcB.sql" },
    ]));

    const result = await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [
        { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" },
        { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcB" },
      ],
      mode: "ExecuteDirectly",
      continueOnError: true,
      options: { engine: "Legacy" },
      task,
      logEvent,
      broadcastProgress,
    });

    expect(executeSqlScript).toHaveBeenCalledTimes(1);
    expect(executeSqlScriptsIndividually).not.toHaveBeenCalled();
    expect(executeSqlScript.mock.calls[0][1]).toContain("ProcA");
    expect(executeSqlScript.mock.calls[0][1]).toContain("ProcB");
    expect(result.results.find((item) => item.objectName === "ProcA").status).toBe("Success");
    expect(result.results.find((item) => item.objectName === "ProcB").status).toBe("Success");
    expect(broadcastProgress).toHaveBeenCalledWith(
      "deployProgress",
      expect.objectContaining({ objectName: "ProcA", status: "Success", done: 1 })
    );
    expect(broadcastProgress).toHaveBeenCalledWith(
      "deployProgress",
      expect.objectContaining({ objectName: "ProcB", status: "Success", done: 2 })
    );
    expect(result.results.every((item) => String(item.scriptPath || "").includes("AllStoredProcedures_"))).toBe(true);
  });

  it("handles TABLE objects via delta generation", async () => {
    generateTableDelta.mockResolvedValue({ scriptText: "ALTER TABLE dbo.Users ADD col1 INT NULL", outputPath: "/out/delta.sql" });

    const result = await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "TABLE", schemaName: "dbo", objectName: "Users" }],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: { engine: "Legacy" },
      task,
      logEvent,
    });

    const tableResult = result.results.find((r) => r.objectName === "Users");
    expect(tableResult.status).toBe("Success");
    expect(generateScriptsForProfile).not.toHaveBeenCalled();
    expect(generateTableDelta).toHaveBeenCalledWith(expect.objectContaining({
      outputDir: expect.stringContaining("Deployment Scripts"),
    }));
  });

  it("rejects unsupported DacFx deployment before generating or executing SQL", async () => {
    const fs = require("fs");
    fs.readFileSync.mockImplementation(() => "CREATE VIEW dbo.ViewA AS SELECT 1");
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA", scriptPath: "/out/dbo.ViewA.sql" },
    ]));

    await expect(runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" }],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: { engine: "DacFx" },
      task,
      logEvent,
    })).rejects.toThrow("DacFx deployment is not supported");

    expect(compareGeneratedArtifacts).not.toHaveBeenCalled();
    expect(deployGeneratedArtifacts).not.toHaveBeenCalled();
    expect(require("./sqlService").executeSqlScriptsIndividually).not.toHaveBeenCalled();
    expect(generateScriptsForProfile).not.toHaveBeenCalled();
    expect(generateTableDelta).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "GenerateScriptOnly", "rollback", "invalid"])("rejects invalid mode %s before execution", async (mode) => {
    await expect(runDeployment({ sourceProfile: srcProfile, destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" }],
      mode, options: {}, task, logEvent,
    })).rejects.toThrow("Invalid deployment mode");
    expect(generateScriptsForProfile).not.toHaveBeenCalled();
  });

  it("builds a legacy execution plan even when DacFx engine is selected", () => {
    const plan = buildDeploymentPlan(
      [{ objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" }],
      { engine: "DacFx" }
    );

    expect(plan).toEqual([
      expect.objectContaining({ objectType: "VIEW", schemaName: "dbo", objectName: "ViewA", action: "DropAndCreate" }),
    ]);
  });

  it("marks unchanged alias-type direct deploy artifacts as no-op skips", async () => {
    const fs = require("fs");
    fs.readFileSync.mockImplementation(() => "CREATE TYPE [dbo].[AliasA] FROM [nvarchar](20) NOT NULL");
    const signature = new Map([["USER_DEFINED_TYPE|dbo|aliasa", "TYPE#0#nvarchar:40:0:0:Latin1_General_CI_AS:0:0"]]);
    require("./sqlService").fetchTypeSignatureMap.mockResolvedValueOnce(signature).mockResolvedValueOnce(new Map(signature));
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { objectType: "USER_DEFINED_TYPE", schemaName: "dbo", objectName: "AliasA", scriptPath: "/out/dbo.AliasA.sql" },
    ]));

    const result = await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "USER_DEFINED_TYPE", schemaName: "dbo", objectName: "AliasA" }],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: { engine: "Legacy" },
      task,
      logEvent,
    });

    expect(require("./sqlService").executeSqlScriptsIndividually).not.toHaveBeenCalled();
    expect(result.results[0].status).toBe("Skipped");
    expect(result.results[0].action).toBe("NoChange");
    expect(result.results[0].scriptPath).toContain("USER_DEFINED_TYPE_dbo_AliasA.sql");
  });

  it("marks unchanged direct rollback artifacts as no-op skips when no rollback batch is needed", async () => {
    const fs = require("fs");
    const broadcastProgress = jest.fn();
    fs.readFileSync.mockImplementation(() => "CREATE VIEW dbo.ViewA AS SELECT 1");
    fetchObjectDefinitionMap
      .mockResolvedValueOnce(new Map([
        ["VIEW|dbo|ViewA", { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA", definition: "SELECT 1" }],
      ]))
      .mockResolvedValueOnce(new Map([
        ["VIEW|dbo|ViewA", { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA", definition: "SELECT 1" }],
      ]));
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA", scriptPath: "/out/dbo.ViewA.sql" },
    ]));

    const result = await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" }],
      mode: "Rollback",
      continueOnError: false,
      options: { engine: "Legacy" },
      task,
      logEvent,
      broadcastProgress,
    });

    expect(require("./sqlService").executeSql).not.toHaveBeenCalled();
    expect(result.results[0].status).toBe("Skipped");
    expect(result.results[0].action).toBe("NoChange");
    expect(broadcastProgress).toHaveBeenCalledWith(
      "deployProgress",
      expect.objectContaining({ objectType: "VIEW", objectName: "ViewA", status: "Skipped", done: 1, total: 1 })
    );
  });

  it("executes table deltas before object types that follow TABLE in deployment order", async () => {
    const fs = require("fs");
    const { executeSqlScript, executeSqlScriptsIndividually } = require("./sqlService");
    fs.readFileSync.mockImplementation(() => "CREATE VIEW dbo.ViewA AS SELECT 1");
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA", scriptPath: "/out/dbo.ViewA.sql" },
      { objectType: "TABLE", schemaName: "dbo", objectName: "Users", scriptPath: "/out/dbo.Users.sql" },
    ]));
    generateTableDelta.mockResolvedValue({ scriptText: "ALTER TABLE dbo.Users ADD col1 INT NULL", outputPath: "/out/delta.sql" });

    await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [
        { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" },
        { objectType: "TABLE", schemaName: "dbo", objectName: "Users" },
      ],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: { engine: "Legacy" },
      task,
      logEvent,
    });

    expect(executeSqlScript).toHaveBeenCalledTimes(1);
    expect(executeSqlScript.mock.calls[0][1]).toContain("ALTER TABLE dbo.Users");
    expect(executeSqlScriptsIndividually).toHaveBeenCalledTimes(1);
    expect(executeSqlScriptsIndividually.mock.calls[0][1][0].sqlText).toContain("CREATE VIEW dbo.ViewA");
    expect(generateScriptsForProfile.mock.calls[0][0].selectedObjects).toEqual([
      expect.objectContaining({ objectType: "VIEW", objectName: "ViewA" }),
    ]);
  });

  it("batches deploy PowerShell calls: one bulk object generation for non-tables and one table delta for tables", async () => {
    const fs = require("fs");
    fs.readFileSync.mockImplementation((filePath) => {
      if (String(filePath).includes("ViewA")) return "CREATE VIEW dbo.ViewA AS SELECT 1";
      if (String(filePath).includes("FuncA")) return "CREATE FUNCTION dbo.FuncA() RETURNS INT AS BEGIN RETURN 1 END";
      return "CREATE OR ALTER PROCEDURE dbo.ProcA AS SELECT 1";
    });
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA", scriptPath: "/out/dbo.ViewA.sql" },
      { objectType: "FUNCTION", schemaName: "dbo", objectName: "FuncA", scriptPath: "/out/dbo.FuncA.sql" },
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA", scriptPath: "/out/dbo.ProcA.sql" },
    ]));
    generateTableDelta.mockResolvedValue({ scriptText: "ALTER TABLE dbo.Users ADD col1 INT NULL", outputPath: "/out/delta.sql" });

    await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [
        { objectType: "TABLE", schemaName: "dbo", objectName: "Users" },
        { objectType: "TABLE", schemaName: "dbo", objectName: "Orders" },
        { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" },
        { objectType: "FUNCTION", schemaName: "dbo", objectName: "FuncA" },
        { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" },
      ],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: { engine: "Legacy" },
      task,
      logEvent,
    });

    expect(generateScriptsForProfile).toHaveBeenCalledTimes(1);
    expect(generateScriptsForProfile).toHaveBeenCalledWith(expect.objectContaining({
      appTaskMode: "deploy",
      selectedObjects: [
        { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" },
        { objectType: "FUNCTION", schemaName: "dbo", objectName: "FuncA" },
        { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" },
      ],
    }));
    expect(generateTableDelta).toHaveBeenCalledTimes(1);
    expect(generateTableDelta).toHaveBeenCalledWith(expect.objectContaining({
      selectedObjects: [
        { objectType: "TABLE", schemaName: "dbo", objectName: "Orders" },
        { objectType: "TABLE", schemaName: "dbo", objectName: "Users" },
      ],
    }));
  });

  it("dependency ordering: UDTs before tables before procedures", () => {
    const plan = buildDeploymentPlan([
        { objectType: "PROCEDURE", schemaName: "dbo", objectName: "P1" },
        { objectType: "TABLE", schemaName: "dbo", objectName: "T1" },
        { objectType: "USER_DEFINED_TYPE", schemaName: "dbo", objectName: "U1" },
    ]);

    const planTypes = plan.map((item) => item.objectType);
    expect(planTypes[0]).toBe("USER_DEFINED_TYPE");
    expect(planTypes[1]).toBe("TABLE");
    expect(planTypes[2]).toBe("PROCEDURE");
  });

  it("orders objects of the same type by created date after type dependency order", () => {
    const plan = buildDeploymentPlan([
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcNewer", createdDate: "2026-06-11T08:30:00.000Z" },
      { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA", createdDate: "2026-06-15T08:30:00.000Z" },
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcOlder", createdDate: "2026-06-10T08:30:00.000Z" },
    ]);

    expect(plan.map((item) => `${item.objectType}:${item.objectName}`)).toEqual([
      "VIEW:ViewA",
      "PROCEDURE:ProcOlder",
      "PROCEDURE:ProcNewer",
    ]);
  });

  it("orders same-type objects from SQL dependency metadata before created-date fallback", async () => {
    fetchObjectDependencyEdges.mockResolvedValueOnce([
      {
        objectType: "VIEW",
        schemaName: "dbo",
        objectName: "ViewConsumer",
        dependencyObjectType: "VIEW",
        dependencySchemaName: "dbo",
        dependencyObjectName: "ViewBase",
      },
    ]);

    const plan = await buildDerivedDeploymentPlan(srcProfile, [
      { objectType: "VIEW", schemaName: "dbo", objectName: "ViewConsumer", createdDate: "2026-06-01T08:30:00.000Z" },
      { objectType: "VIEW", schemaName: "dbo", objectName: "ViewBase", createdDate: "2026-06-02T08:30:00.000Z" },
    ], logEvent);

    expect(plan.map((item) => item.objectName)).toEqual(["ViewBase", "ViewConsumer"]);
  });

  it("uses live dependencies ahead of type priorities and ignores legacy order settings", async () => {
    const settings = require("./settingsService").getSettings;
    settings.mockImplementationOnce(() => { throw new Error("Legacy order must not be read"); });
    fetchObjectDependencyEdges.mockResolvedValueOnce([{
      objectType: "TABLE", schemaName: "dbo", objectName: "Data",
      dependencyObjectType: "FUNCTION", dependencySchemaName: "dbo", dependencyObjectName: "Compute",
    }]);
    const plan = await buildDerivedDeploymentPlan(srcProfile, [
      { objectType: "TABLE", schemaName: "dbo", objectName: "Data" },
      { objectType: "FUNCTION", schemaName: "dbo", objectName: "Compute" },
    ]);
    expect(plan.map((item) => item.objectName)).toEqual(["Compute", "Data"]);
    expect(settings).not.toHaveBeenCalled();
    settings.mockReset();
  });

  it("stops planning when dependency metadata cannot be read", async () => {
    fetchObjectDependencyEdges.mockRejectedValueOnce(new Error("Permission denied"));
    await expect(buildDerivedDeploymentPlan(srcProfile, [
      { objectType: "VIEW", schemaName: "dbo", objectName: "Base" },
      { objectType: "VIEW", schemaName: "dbo", objectName: "Consumer" },
    ])).rejects.toThrow("Unable to determine deployment dependencies: Permission denied");
    expect(generateScriptsForProfile).not.toHaveBeenCalled();
  });

  it("distinguishes a type from an object with the same schema and name", () => {
    const plan = buildDeploymentPlan([
      { objectType: "TABLE", schemaName: "dbo", objectName: "Shared", dependencies: [
        { objectType: "USER_DEFINED_TYPE", schemaName: "dbo", objectName: "Shared" },
      ] },
      { objectType: "USER_DEFINED_TYPE", schemaName: "dbo", objectName: "Shared" },
    ]);
    expect(plan.map((item) => item.objectType)).toEqual(["USER_DEFINED_TYPE", "TABLE"]);
  });

  it("does not merge stale client dependencies into the live graph", async () => {
    const plan = await buildDerivedDeploymentPlan(srcProfile, [
      { objectType: "VIEW", schemaName: "dbo", objectName: "Base", dependencies: ["dbo.Consumer"] },
      { objectType: "VIEW", schemaName: "dbo", objectName: "Consumer", dependencies: ["dbo.Base"] },
    ]);
    expect(plan.map((item) => item.objectName)).toEqual(["Base", "Consumer"]);
  });
});
