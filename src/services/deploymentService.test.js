"use strict";

jest.mock("./sqlService", () => ({
  executeSql: jest.fn().mockResolvedValue(undefined),
  executeSqlScript: jest.fn().mockResolvedValue(undefined),
  executeSqlScriptsIndividually: jest.fn().mockImplementation((_profile, scripts) => Promise.resolve(
    scripts.map((script) => ({ key: script.key, ok: true, error: null }))
  )),
  fetchObjectDefinitionMap: jest.fn().mockResolvedValue(new Map()),
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
const { fetchObjectDefinitionMap, fetchObjectDependencyEdges } = require("./sqlService");
const { compareGeneratedArtifacts, deployGeneratedArtifacts } = require("./dacfxService");
const { generateScriptsForProfile } = require("./scriptGenerationService");
const { runDeployment, buildDeploymentPlan, buildDerivedDeploymentPlan } = require("./deploymentService");

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

  it("validates objects in Rollback mode without committing changes", async () => {
    const fs = require("fs");
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

    expect(result.results[0].status).toBe("RolledBack");
    expect(result.rollbackApplied).toBe(true);
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

  it("marks object as Skipped when no generated script is found", async () => {
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", []));

    const result = await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "Missing" }],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: { engine: "Legacy" },
      task,
      logEvent,
    });

    expect(result.results[0].status).toBe("Skipped");
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

  it("uses legacy object-type deployment behavior even when DacFx engine is selected", async () => {
    const fs = require("fs");
    fs.readFileSync.mockImplementation(() => "CREATE VIEW dbo.ViewA AS SELECT 1");
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", [
      { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA", scriptPath: "/out/dbo.ViewA.sql" },
    ]));

    const result = await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" }],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: { engine: "DacFx" },
      task,
      logEvent,
    });

    expect(compareGeneratedArtifacts).not.toHaveBeenCalled();
    expect(deployGeneratedArtifacts).not.toHaveBeenCalled();
    expect(require("./sqlService").executeSqlScriptsIndividually).toHaveBeenCalledTimes(1);
    expect(result.results[0].status).toBe("Success");
    expect(result.results[0].action).toBe("DropAndCreate");
    expect(result.generationWarnings).toEqual([]);
    expect(result.dacfxValidation).toEqual({ enabled: false });
    expect(result.engine).toBe("Legacy");
    expect(result.deployScriptPath).toBeNull();
    expect(generateTableDelta).not.toHaveBeenCalled();
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
    fetchObjectDefinitionMap
      .mockResolvedValueOnce(new Map([
        ["USER_DEFINED_TYPE|dbo|AliasA", { objectType: "USER_DEFINED_TYPE", schemaName: "dbo", objectName: "AliasA", definition: "AliasA based on nvarchar" }],
      ]))
      .mockResolvedValueOnce(new Map([
        ["USER_DEFINED_TYPE|dbo|AliasA", { objectType: "USER_DEFINED_TYPE", schemaName: "dbo", objectName: "AliasA", definition: "AliasA based on nvarchar" }],
      ]));
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

  it("dependency ordering: UDTs before tables before procedures", async () => {
    generateScriptsForProfile.mockResolvedValue(makeGeneratedInfo("/out", []));
    generateTableDelta.mockResolvedValue({ scriptText: "", outputPath: "/out/delta.sql" });

    const result = await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [
        { objectType: "PROCEDURE", schemaName: "dbo", objectName: "P1" },
        { objectType: "TABLE", schemaName: "dbo", objectName: "T1" },
        { objectType: "USER_DEFINED_TYPE", schemaName: "dbo", objectName: "U1" },
      ],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: { engine: "Legacy" },
      task,
      logEvent,
    });

    const planTypes = result.plan.map((x) => x.objectType);
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
});
