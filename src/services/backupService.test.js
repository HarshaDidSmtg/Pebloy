"use strict";

jest.mock("./storage", () => ({
  ensureDir: jest.fn(),
}));
jest.mock("./scriptGenerationService", () => ({
  generateScriptsForProfile: jest.fn(),
  normalizeSelectedObjects: jest.fn((items) => items),
}));
jest.mock("./dacfxService", () => ({
  validateGeneratedArtifacts: jest.fn(),
}));
jest.mock("./settingsService", () => ({
  getSettings: jest.fn(() => ({ dacfx: { validationEnabled: false } })),
}));
jest.mock("fs", () => ({
  writeFileSync: jest.fn(),
  readFileSync: jest.fn(() => ""),
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
}));
jest.mock("./sqlService", () => ({
  executeSqlScriptsIndividually: jest.fn(),
}));
jest.mock("./scriptAutomationService", () => ({
  normalizeExecutableSql: jest.fn((text) => `EXECUTABLE:${text}`),
}));
jest.mock("./formatterService", () => ({
  formatGeneratedSql: jest.fn((text) => `FORMATTED:${text}`),
}));

const fs = require("fs");
const { generateScriptsForProfile } = require("./scriptGenerationService");
const { validateGeneratedArtifacts } = require("./dacfxService");
const { getSettings } = require("./settingsService");
const { executeSqlScriptsIndividually } = require("./sqlService");
const { normalizeExecutableSql } = require("./scriptAutomationService");
const { runBackup } = require("./backupService");

describe("runBackup", () => {
  beforeEach(() => jest.clearAllMocks());

  it("passes the full selected object list in one bulk generation call", async () => {
    const selectedObjects = [
      { objectType: "TABLE", schemaName: "dbo", objectName: "Users" },
      { objectType: "VIEW", schemaName: "dbo", objectName: "UserView" },
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "SyncUsers" },
    ];
    generateScriptsForProfile.mockResolvedValue({
      generated: {
        runRoot: "/exports/run/srcDb",
        latestBuildPathFile: "/exports/run/srcDb/BuildPaths.txt",
        objectListPath: "/temp/task_objects.txt",
        scriptStdout: "ok",
      },
    });

    await runBackup(
      { serverName: "srcServer", databaseName: "srcDb" },
      selectedObjects,
      { destinationPath: "/exports" },
      { taskId: "backup-task" }
    );

    expect(generateScriptsForProfile).toHaveBeenCalledTimes(1);
    expect(generateScriptsForProfile).toHaveBeenCalledWith({
      taskId: "backup-task",
      profile: { serverName: "srcServer", databaseName: "srcDb" },
      selectedObjects,
      outputBasePath: "/exports",
      appTaskMode: "backup",
    });
    expect(validateGeneratedArtifacts).not.toHaveBeenCalled();
  });

  it("runs shared DacFx validation when enabled", async () => {
    getSettings.mockReturnValue({ dacfx: { validationEnabled: true } });
    generateScriptsForProfile.mockResolvedValue({
      generated: {
        runRoot: "/exports/run/srcDb",
        latestBuildPathFile: "/exports/run/srcDb/BuildPaths.txt",
        objectListPath: "/temp/task_objects.txt",
        scriptStdout: "ok",
      },
      scripts: [
        { objectType: "VIEW", schemaName: "dbo", objectName: "UserView", scriptPath: "/exports/run/srcDb/dbo/Views/UserView.sql" },
      ],
    });
    validateGeneratedArtifacts.mockResolvedValue({ objectCount: 1, packagePath: "/tmp/package.dacpac", warnings: [] });

    const result = await runBackup(
      { serverName: "srcServer", databaseName: "srcDb" },
      [{ objectType: "VIEW", schemaName: "dbo", objectName: "UserView" }],
      { destinationPath: "/exports" },
      { taskId: "backup-task" }
    );

    expect(validateGeneratedArtifacts).toHaveBeenCalledWith({
      taskId: "backup-task_backup_validate",
      scripts: [
        { objectType: "VIEW", schemaName: "dbo", objectName: "UserView", scriptPath: "/exports/run/srcDb/dbo/Views/UserView.sql" },
      ],
    });
    expect(result.dacfxValidation).toEqual({
      enabled: true,
      objectCount: 1,
      packagePath: "/tmp/package.dacpac",
      warnings: [],
    });
  });

  it("does not format or execute anything when formatAndExecute is off", async () => {
    generateScriptsForProfile.mockResolvedValue({
      generated: { runRoot: "/exports/run/srcDb" },
      scripts: [
        { objectType: "PROCEDURE", schemaName: "dbo", objectName: "P1", scriptPath: "/x/p1.sql", definitionText: "create procedure dbo.P1 as select 1" },
      ],
    });

    const result = await runBackup(
      { serverName: "srcServer", databaseName: "srcDb" },
      [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "P1" }],
      { destinationPath: "/exports" },
      { taskId: "backup-task" }
    );

    expect(executeSqlScriptsIndividually).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(result.formatAndExecute).toEqual({ enabled: false });
    expect(result.backupMode).toBe("ObjectScriptGenerationOnly");
  });

  it("rejects source execution requested through Backup", async () => {
    const profile = { serverName: "srcServer", databaseName: "srcDb" };
    const scripts = [
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "P1", scriptPath: "/x/p1.sql", definitionText: "create procedure dbo.P1 as select 1" },
      { objectType: "TABLE", schemaName: "dbo", objectName: "T1", scriptPath: "/x/t1.sql", definitionText: "create table dbo.T1(i int)" },
      { objectType: "VIEW", schemaName: "dbo", objectName: "V1", scriptPath: "/x/v1.sql", definitionText: "create view dbo.V1 as select 1" },
    ];
    generateScriptsForProfile.mockResolvedValue({ generated: { runRoot: "/exports/run/srcDb" }, scripts });
    executeSqlScriptsIndividually.mockResolvedValue([
      { key: "PROCEDURE|dbo|p1", ok: true },
      { key: "VIEW|dbo|v1", ok: false, errorMessage: "boom" },
    ]);

    await expect(runBackup(
      profile,
      scripts.map(({ objectType, schemaName, objectName }) => ({ objectType, schemaName, objectName })),
      { destinationPath: "/exports", formatAndExecute: true },
      { taskId: "backup-task" }
    )).rejects.toThrow("script generation only");
    expect(executeSqlScriptsIndividually).not.toHaveBeenCalled();
    expect(generateScriptsForProfile).not.toHaveBeenCalled();
  });
});