"use strict";

jest.mock("./storage", () => ({
  ensureDir: jest.fn(),
}));
jest.mock("./scriptGenerationService", () => ({
  generateScriptsForProfile: jest.fn(),
  normalizeSelectedObjects: jest.fn((items) => items),
}));

const { generateScriptsForProfile } = require("./scriptGenerationService");
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
  });
});