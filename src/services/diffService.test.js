"use strict";

jest.mock("./scriptGenerationService", () => ({
  generateScriptsForProfile: jest.fn(),
  getCodeDiffOutputPaths: jest.fn(() => ({ sourceOut: "/codediff/source", destOut: "/codediff/dest" })),
}));
jest.mock("./dacfxService", () => ({
  compareGeneratedArtifacts: jest.fn(),
  normalizeEngine: jest.fn((value) => (String(value || "DacFx").trim() === "Legacy" ? "Legacy" : "DacFx")),
  validateGeneratedArtifacts: jest.fn(),
}));
jest.mock("./settingsService", () => ({
  getSettings: jest.fn(() => ({ dacfx: { validationEnabled: false } })),
}));
jest.mock("./loggingService", () => ({
  writeReportArtifact: jest.fn((name, ext) => `/artifacts/${name}.${ext}`),
}));
jest.mock("fs", () => ({
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(),
}));

const fs = require("fs");
const { generateScriptsForProfile } = require("./scriptGenerationService");
const { compareGeneratedArtifacts } = require("./dacfxService");
const { compareObjects, exportReport } = require("./diffService");

function makeGeneratedInfo(scripts) {
  return {
    generated: { runRoot: "/out", latestBuildPathFile: "/out/BuildPaths.txt" },
    scripts,
    combinedStoredProceduresPath: null,
    selectedObjects: scripts,
  };
}

describe("compareObjects", () => {
  beforeEach(() => jest.clearAllMocks());

  it("reports Added when object exists in source but not destination", async () => {
    generateScriptsForProfile
      .mockResolvedValueOnce(
        makeGeneratedInfo([{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser", scriptPath: "/src/GetUser.sql" }])
      )
      .mockResolvedValueOnce(makeGeneratedInfo([]));
    fs.readFileSync.mockImplementation((filePath) => (filePath === "/src/GetUser.sql" ? "CREATE PROC..." : ""));

    const result = await compareObjects({}, {}, [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser" }], { engine: "Legacy" });
    expect(result.summary.added).toBe(1);
    expect(result.details[0].status).toBe("Added");
  });

  it("reports Missing when object exists in destination but not source", async () => {
    generateScriptsForProfile
      .mockResolvedValueOnce(makeGeneratedInfo([]))
      .mockResolvedValueOnce(
        makeGeneratedInfo([{ objectType: "VIEW", schemaName: "dbo", objectName: "vOrders", scriptPath: "/dst/vOrders.sql" }])
      );
    fs.readFileSync.mockImplementation((filePath) => (filePath === "/dst/vOrders.sql" ? "SELECT..." : ""));

    const result = await compareObjects({}, {}, [{ objectType: "VIEW", schemaName: "dbo", objectName: "vOrders" }], { engine: "Legacy" });
    expect(result.summary.missing).toBe(1);
    expect(result.details[0].status).toBe("Missing");
  });

  it("reports Unchanged when definitions are identical", async () => {
    generateScriptsForProfile
      .mockResolvedValueOnce(
        makeGeneratedInfo([{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser", scriptPath: "/src/GetUser.sql" }])
      )
      .mockResolvedValueOnce(
        makeGeneratedInfo([{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser", scriptPath: "/dst/GetUser.sql" }])
      );
    fs.readFileSync.mockImplementation(() => "CREATE PROCEDURE dbo.GetUser AS SELECT 1");

    const result = await compareObjects({}, {}, [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser" }], { engine: "Legacy" });
    expect(result.summary.unchanged).toBe(1);
    expect(result.details[0].status).toBe("Unchanged");
  });

  it("compares generated definitionText from both connections when present", async () => {
    generateScriptsForProfile
      .mockResolvedValueOnce(
        makeGeneratedInfo([{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser", scriptPath: "/src/GetUser.sql", definitionText: "\uFEFFFORMATTED SQL" }])
      )
      .mockResolvedValueOnce(
        makeGeneratedInfo([{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser", scriptPath: "/dst/GetUser.sql", definitionText: "FORMATTED SQL" }])
      );
    fs.readFileSync.mockImplementation(() => "UNFORMATTED DIFFERENT SQL");

    const result = await compareObjects({}, {}, [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser" }], { engine: "Legacy" });

    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(result.summary.unchanged).toBe(1);
  });

  it("reports Changed when definitions differ", async () => {
    generateScriptsForProfile
      .mockResolvedValueOnce(
        makeGeneratedInfo([{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser", scriptPath: "/src/GetUser.sql" }])
      )
      .mockResolvedValueOnce(
        makeGeneratedInfo([{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser", scriptPath: "/dst/GetUser.sql" }])
      );
    fs.readFileSync.mockImplementation((filePath) => (filePath.startsWith("/src") ? "v1" : "v2"));

    const result = await compareObjects({}, {}, [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser" }], { engine: "Legacy" });
    expect(result.summary.changed).toBe(1);
    expect(result.details[0].status).toBe("Changed");
    expect(result.details[0].lineDiff.length).toBeGreaterThan(0);
  });

  it("throws when selection is empty", async () => {
    await expect(compareObjects({}, {}, [], { engine: "Legacy" })).rejects.toThrow("Select at least one object before running CodeDiff.");
  });

  it("batches the full selected object list once per database", async () => {
    const selectedObjects = [
      { objectType: "TABLE", schemaName: "dbo", objectName: "Users" },
      { objectType: "VIEW", schemaName: "dbo", objectName: "UserView" },
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "SyncUsers" },
    ];

    generateScriptsForProfile
      .mockResolvedValueOnce(makeGeneratedInfo([]))
      .mockResolvedValueOnce(makeGeneratedInfo([]));

    await compareObjects({ serverName: "src" }, { serverName: "dst" }, selectedObjects, { taskId: "diff-task", engine: "Legacy" });

    expect(generateScriptsForProfile).toHaveBeenCalledTimes(2);
    expect(generateScriptsForProfile).toHaveBeenNthCalledWith(1, {
      taskId: "diff-task_src",
      profile: { serverName: "src" },
      selectedObjects,
      outputBasePath: "/codediff/source",
      appTaskMode: "code_diff",
    });
    expect(generateScriptsForProfile).toHaveBeenNthCalledWith(2, {
      taskId: "diff-task_dst",
      profile: { serverName: "dst" },
      selectedObjects,
      outputBasePath: "/codediff/dest",
      appTaskMode: "code_diff",
    });
  });

  it("uses DacFx semantic compare when that engine is selected for structural objects", async () => {
    generateScriptsForProfile
      .mockResolvedValueOnce(
        makeGeneratedInfo([{ objectType: "TABLE", schemaName: "dbo", objectName: "Users", scriptPath: "/src/Users.sql" }])
      )
      .mockResolvedValueOnce(
        makeGeneratedInfo([{ objectType: "TABLE", schemaName: "dbo", objectName: "Users", scriptPath: "/dst/Users.sql" }])
      );
    fs.readFileSync.mockImplementation((filePath) => (filePath.startsWith("/src") ? "select 1" : "SELECT 1"));
    compareGeneratedArtifacts.mockResolvedValue({ hasChanges: false, changes: [], alerts: [], warnings: [] });

    const result = await compareObjects(
      { serverName: "src" },
      { serverName: "dst", databaseName: "dstDb" },
      [{ objectType: "TABLE", schemaName: "dbo", objectName: "Users" }],
      { engine: "DacFx", taskId: "diff-dacfx" }
    );

    expect(compareGeneratedArtifacts).toHaveBeenCalledWith({
      taskId: "diff-dacfx",
      sourceScripts: [
        { objectType: "TABLE", schemaName: "dbo", objectName: "Users", scriptPath: "/src/Users.sql" },
      ],
      destinationProfile: { serverName: "dst", databaseName: "dstDb" },
    });
    expect(result.engine).toBe("DacFx");
    expect(result.summary.unchanged).toBe(1);
  });

  it("skips DacFx semantic compare for non-table selections and returns textual diff immediately", async () => {
    generateScriptsForProfile
      .mockResolvedValueOnce(
        makeGeneratedInfo([{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser", scriptPath: "/src/GetUser.sql" }])
      )
      .mockResolvedValueOnce(
        makeGeneratedInfo([{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser", scriptPath: "/dst/GetUser.sql" }])
      );
    fs.readFileSync.mockImplementation((filePath) => (filePath.startsWith("/src") ? "select 1" : "select 2"));

    const result = await compareObjects(
      { serverName: "src" },
      { serverName: "dst", databaseName: "dstDb" },
      [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser" }],
      { engine: "DacFx", taskId: "diff-dacfx-skip" }
    );

    expect(compareGeneratedArtifacts).not.toHaveBeenCalled();
    expect(result.engine).toBe("Legacy");
    expect(result.summary.changed).toBe(1);
    expect(result.semanticWarnings).toEqual([
      expect.stringContaining("DacFx semantic compare was skipped for a non-table selection to keep CodeDiff responsive"),
    ]);
  });

  it("falls back to fresh-script textual diff when DacFx semantic compare fails", async () => {
    generateScriptsForProfile
      .mockResolvedValueOnce(
        makeGeneratedInfo([{ objectType: "TABLE", schemaName: "dbo", objectName: "Users", scriptPath: "/src/Users.sql" }])
      )
      .mockResolvedValueOnce(
        makeGeneratedInfo([{ objectType: "TABLE", schemaName: "dbo", objectName: "Users", scriptPath: "/dst/Users.sql" }])
      );
    fs.readFileSync.mockImplementation((filePath) => (filePath.startsWith("/src") ? "select 1" : "select 2"));
    compareGeneratedArtifacts.mockRejectedValue(new Error("SQL71501 unresolved reference"));

    const result = await compareObjects(
      { serverName: "src" },
      { serverName: "dst", databaseName: "dstDb" },
      [{ objectType: "TABLE", schemaName: "dbo", objectName: "Users" }],
      { engine: "DacFx", taskId: "diff-dacfx-fallback" }
    );

    expect(result.engine).toBe("DacFx");
    expect(result.summary.changed).toBe(1);
    expect(result.details[0].status).toBe("Changed");
    expect(result.semanticWarnings).toEqual([
      expect.stringContaining("DacFx semantic compare failed; returning fresh-script textual diff instead: SQL71501 unresolved reference"),
    ]);
    expect(result.semanticAlerts).toEqual([]);
  });

  it("falls back to fresh-script textual diff when DacFx semantic compare hangs", async () => {
    jest.useFakeTimers();
    try {
      generateScriptsForProfile
        .mockResolvedValueOnce(
          makeGeneratedInfo([{ objectType: "TABLE", schemaName: "dbo", objectName: "Users", scriptPath: "/src/Users.sql" }])
        )
        .mockResolvedValueOnce(
          makeGeneratedInfo([{ objectType: "TABLE", schemaName: "dbo", objectName: "Users", scriptPath: "/dst/Users.sql" }])
        );
      fs.readFileSync.mockImplementation((filePath) => (filePath.startsWith("/src") ? "select 1" : "select 2"));
      compareGeneratedArtifacts.mockImplementation(() => new Promise(() => {}));

      const comparePromise = compareObjects(
        { serverName: "src" },
        { serverName: "dst", databaseName: "dstDb" },
        [{ objectType: "TABLE", schemaName: "dbo", objectName: "Users" }],
        { engine: "DacFx", taskId: "diff-dacfx-timeout" }
      );

      await jest.advanceTimersByTimeAsync(30000);

      await expect(comparePromise).resolves.toMatchObject({
        engine: "DacFx",
        summary: expect.objectContaining({ changed: 1 }),
        details: [expect.objectContaining({ status: "Changed" })],
        semanticWarnings: [expect.stringContaining("DacFx semantic compare timed out after 30000 ms")],
        semanticAlerts: [],
      });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("exportReport", () => {
  const report = {
    summary: { added: 1, missing: 0, changed: 1, unchanged: 2 },
    details: [
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "GetUser", status: "Added", sourceDefinition: "v1", destinationDefinition: "", lineDiff: [] },
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "UpdateUser", status: "Changed", sourceDefinition: "v1", destinationDefinition: "v2", diffText: "---\n+++", lineDiff: [] },
    ],
  };

  it("exports JSON and returns a path", () => {
    const p = exportReport("json", report);
    expect(p).toMatch(/diff_report\.json$/);
  });

  it("exports Markdown and returns a path", () => {
    const p = exportReport("md", report);
    expect(p).toMatch(/diff_report\.md$/);
  });

  it("exports HTML and returns a path", () => {
    const p = exportReport("html", report);
    expect(p).toMatch(/diff_report\.html$/);
  });

  it("throws on unsupported format", () => {
    expect(() => exportReport("csv", report)).toThrow("Unsupported export format");
  });
});
