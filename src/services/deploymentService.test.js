"use strict";

jest.mock("./sqlService", () => ({
  executeSql: jest.fn().mockResolvedValue(undefined),
  executeSqlScript: jest.fn().mockResolvedValue(undefined),
  executeSqlScriptsIndividually: jest.fn().mockImplementation((_profile, scripts) => Promise.resolve(
    scripts.map((script) => ({ key: script.key, ok: true, error: null }))
  )),
}));
jest.mock("./loggingService", () => ({
  writeScriptArtifact: jest.fn(),
}));
jest.mock("./scriptAutomationService", () => ({
  buildProfileOutputBasePath: jest.fn((outputBasePath, profileLabel) => `${outputBasePath}/profiles/${profileLabel || "default"}`),
  buildRunRoot: jest.fn((outputBasePath, databaseName) => `${outputBasePath}/run/${databaseName}`),
  generateTableDelta: jest.fn(),
  normalizeExecutableSql: jest.fn((sql, objectType, _context, options = {}) => {
    const metadata = options.moduleMetadata || {};
    const type = String(objectType || "").toUpperCase();
    if (!["PROCEDURE", "VIEW", "FUNCTION", "TRIGGER"].includes(type)) {
      return sql;
    }

    const headerLines = [];
    if (metadata.usesAnsiNulls != null) {
      headerLines.push(`SET ANSI_NULLS ${metadata.usesAnsiNulls ? "ON" : "OFF"}`);
    }
    if (metadata.usesQuotedIdentifier != null) {
      headerLines.push(`SET QUOTED_IDENTIFIER ${metadata.usesQuotedIdentifier ? "ON" : "OFF"}`);
    }
    if (!headerLines.length) {
      return sql;
    }

    return `${headerLines.join("\nGO\n")}\nGO\n${sql}`;
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
const { generateScriptsForProfile } = require("./scriptGenerationService");
const { runDeployment, buildDeploymentPlan } = require("./deploymentService");

const srcProfile = { serverName: "srcServer", databaseName: "srcDb" };
const dstProfile = { serverName: "dstServer", databaseName: "dstDb" };
const task = { taskId: "test-task-001" };
const logEvent = jest.fn();

function makeGeneratedInfo(runRoot = "/out", scripts = []) {
  return {
    generated: { runRoot, latestBuildPathFile: `${runRoot}/BuildPaths.txt` },
    scripts,
    combinedStoredProceduresPath: null,
    selectedObjects: [],
    generationWarnings: [],
  };
}

describe("runDeployment", () => {
  beforeEach(() => jest.clearAllMocks());

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
      options: {},
      task,
      logEvent,
    });

    expect(result.results[0].status).toBe("Success");
    expect(require("./sqlService").executeSqlScriptsIndividually).toHaveBeenCalledTimes(1);
    expect(generateScriptsForProfile).toHaveBeenCalledWith(expect.objectContaining({ appTaskMode: "deploy" }));
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("Deployment Scripts"),
      expect.stringContaining("CREATE OR ALTER PROCEDURE"),
      "utf8"
    );
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
      options: {},
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

  it("uses createOrAlter strategy for view rollback batches and emits progress", async () => {
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
      options: {},
      task,
      logEvent,
      broadcastProgress,
    });

    expect(result.results[0].status).toBe("RolledBack");
    expect(normalizeExecutableSql).toHaveBeenCalledWith(
      expect.any(String),
      "VIEW",
      expect.objectContaining({ schemaName: "dbo", objectName: "ViewA" }),
      expect.objectContaining({ strategy: "createOrAlter" })
    );
    expect(broadcastProgress).toHaveBeenCalledWith(
      "deployProgress",
      expect.objectContaining({ objectType: "VIEW", objectName: "ViewA", status: "RolledBack", done: 1, total: 1 })
    );
  });

  it("rehydrates non-default programmable object metadata into deploy execution artifacts", async () => {
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
      options: {},
      task,
      logEvent,
    });

    expect(normalizeExecutableSql).toHaveBeenCalledWith(
      "CREATE VIEW dbo.ViewA AS SELECT 1",
      "VIEW",
      expect.objectContaining({ schemaName: "dbo", objectName: "ViewA" }),
      expect.objectContaining({
        strategy: "createOrAlter",
        moduleMetadata: { usesAnsiNulls: false, usesQuotedIdentifier: true, definitionSource: "exact" },
      })
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("VIEW_dbo_ViewA.sql"),
      expect.stringContaining("SET ANSI_NULLS OFF\r\nGO\r\nSET QUOTED_IDENTIFIER ON\r\nGO\r\nCREATE VIEW dbo.ViewA AS SELECT 1"),
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
      options: {},
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
      options: {},
      task,
      logEvent,
    });

    expect(result.results[0].status).toBe("Success");
    expect(result.results[0].scriptPath).toContain("UspPendingRefundRequestsReport");
  });

  it("marks object as Failed on SQL execution error and stops when continueOnError=false", async () => {
    const { executeSqlScriptsIndividually } = require("./sqlService");
    executeSqlScriptsIndividually.mockResolvedValueOnce([
      { key: "PROCEDURE|dbo|brokenproc", ok: false, error: "SQL error" },
    ]);

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
      options: {},
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
      options: {},
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
      String(filePath).includes("ViewA")
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
    expect(plan.find((item) => item.objectType === "PROCEDURE").action).toBe("ExecuteIndividually");
    expect(plan.find((item) => item.objectType === "VIEW").action).toBe("CreateOrAlterIndividually");

    await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [
        { objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" },
        { objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" },
      ],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: {},
      task,
      logEvent,
    });

    expect(executeSqlScriptsIndividually).toHaveBeenCalledTimes(1);
    expect(executeSqlScriptsIndividually.mock.calls[0][1][0].sqlText).toContain("CREATE VIEW dbo.ViewA AS SELECT 1");
    expect(executeSqlScriptsIndividually.mock.calls[0][1][1].sqlText).toContain("CREATE PROCEDURE dbo.ProcA AS SELECT 1");
    expect(normalizeExecutableSql).toHaveBeenCalledWith(
      expect.any(String),
      "VIEW",
      expect.any(Object),
      expect.objectContaining({ strategy: "createOrAlter" })
    );
  });

  it("executes separate procedure scripts in one session and identifies the failed procedure", async () => {
    const fs = require("fs");
    const { executeSqlScriptsIndividually } = require("./sqlService");
    const broadcastProgress = jest.fn();
    fs.readFileSync.mockImplementation((filePath) => `CREATE PROCEDURE dbo.${String(filePath).includes("ProcA") ? "ProcA" : "ProcB"} AS SELECT 1`);
    executeSqlScriptsIndividually.mockImplementationOnce(async (_profile, _scripts, options) => {
      const results = [
        { key: "PROCEDURE|dbo|proca", ok: true, error: null },
        { key: "PROCEDURE|dbo|procb", ok: false, error: "ProcB failed" },
      ];
      results.forEach((item) => options.onResult(item));
      return results;
    });
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
      options: {},
      task,
      logEvent,
      broadcastProgress,
    });

    expect(executeSqlScriptsIndividually).toHaveBeenCalledTimes(1);
    expect(executeSqlScriptsIndividually.mock.calls[0][1][0].sqlText).toContain("ProcA");
    expect(executeSqlScriptsIndividually.mock.calls[0][1][1].sqlText).toContain("ProcB");
    expect(result.results.find((item) => item.objectName === "ProcA").status).toBe("Success");
    expect(result.results.find((item) => item.objectName === "ProcB")).toEqual(expect.objectContaining({
      status: "Failed",
      errorMessage: "ProcB failed",
    }));
    expect(broadcastProgress).toHaveBeenCalledWith(
      "deployProgress",
      expect.objectContaining({ objectName: "ProcA", status: "Success", done: 1 })
    );
    expect(broadcastProgress).toHaveBeenCalledWith(
      "deployProgress",
      expect.objectContaining({ objectName: "ProcB", status: "Failed", done: 2 })
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("PROCEDURE_dbo_ProcB.sql"),
      expect.stringContaining("ProcB"),
      "utf8"
    );
  });

  it("handles TABLE objects via delta generation", async () => {
    generateTableDelta.mockResolvedValue({ scriptText: "ALTER TABLE dbo.Users ADD col1 INT NULL", outputPath: "/out/delta.sql" });

    const result = await runDeployment({
      sourceProfile: srcProfile,
      destinationProfile: dstProfile,
      selectedObjects: [{ objectType: "TABLE", schemaName: "dbo", objectName: "Users" }],
      mode: "ExecuteDirectly",
      continueOnError: false,
      options: {},
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
      options: {},
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
      options: {},
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
      options: {},
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
});
