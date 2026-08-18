jest.mock("child_process", () => ({ execFile: jest.fn() }));
jest.mock("./settingsService", () => ({
  getSettings: () => ({
    folderNames: {
      TABLE: "Tables",
      VIEW: "Views",
      PROCEDURE: "Stored Procedures",
      SYNONYM: "Synonyms",
      SEQUENCE: "Sequences",
      USER_DEFINED_TYPE: "User Defined Types",
      FUNCTION: "Functions",
    },
  }),
}));

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const {
  buildProfileOutputBasePath,
  buildRunRoot,
  createObjectListFile,
  generateObjectScripts,
  normalizeExecutableSql,
} = require("./scriptAutomationService");

describe("buildProfileOutputBasePath", () => {
  it("adds a sanitized connection alias segment when provided", () => {
    const basePath = path.join(os.tmpdir(), "easydeploy-exports");
    const outputPath = buildProfileOutputBasePath(basePath, "DEV:Primary/SQL");
    expect(outputPath).toBe(path.join(basePath, "DEV_Primary_SQL"));
  });

  it("leaves the base path unchanged when alias is blank", () => {
    const basePath = path.join(os.tmpdir(), "easydeploy-exports");
    expect(buildProfileOutputBasePath(basePath, "   ")).toBe(basePath);
  });
});

describe("createObjectListFile — sidecar with object types", () => {
  it("writes both .txt and .json sidecar when all objects have types", () => {
    const taskId = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const objects = [
      { schemaName: "Reports", objectName: "UspMyProc", objectType: "PROCEDURE" },
      { schemaName: "dbo",     objectName: "tbl_x",     objectType: "TABLE" },
    ];

    const filePath = createObjectListFile(taskId, objects);
    expect(fs.existsSync(filePath)).toBe(true);

    const sidecarPath = filePath.replace(/\.txt$/i, ".json");
    expect(fs.existsSync(sidecarPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    expect(parsed).toEqual([
      { schemaName: "Reports", objectName: "UspMyProc", objectType: "PROCEDURE" },
      { schemaName: "dbo",     objectName: "tbl_x",     objectType: "TABLE" },
    ]);

    fs.unlinkSync(filePath);
    fs.unlinkSync(sidecarPath);
  });

  it("does NOT write sidecar when any object lacks a type (back-compat)", () => {
    const taskId = `test_notype_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const objects = [
      { schemaName: "Reports", objectName: "UspMyProc", objectType: "PROCEDURE" },
      { schemaName: "dbo",     objectName: "tbl_x" }, // missing objectType
    ];

    const filePath = createObjectListFile(taskId, objects);
    expect(fs.existsSync(filePath)).toBe(true);

    const sidecarPath = filePath.replace(/\.txt$/i, ".json");
    expect(fs.existsSync(sidecarPath)).toBe(false);

    fs.unlinkSync(filePath);
  });
});

describe("generateObjectScripts — run-scoped artifact resolution", () => {
  const profile = { serverName: "srv", databaseName: "TestDb", authenticationType: "Windows" };
  const selectedObjects = [{ schemaName: "dbo", objectName: "V", objectType: "VIEW" }];
  let base;
  let runRoot;

  beforeEach(() => {
    execFile.mockReset();
    base = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-runroot-"));
    runRoot = buildRunRoot(base, "TestDb");
    fs.mkdirSync(runRoot, { recursive: true });
    // Stale artifacts from an "earlier run today" that sort lexically LAST,
    // so the legacy latest-by-filename strategy would wrongly pick them.
    fs.writeFileSync(path.join(runRoot, "BuildPaths_20991231_235959.txt"), "stale");
    fs.writeFileSync(path.join(runRoot, "AllStoredProcedures_20991231_235959.sql"), "stale");
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  function cleanupObjectList(result) {
    for (const suffix of [".txt", ".json"]) {
      const p = result.objectListPath.replace(/\.txt$/i, suffix);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }

  it("uses the artifact paths printed on stdout, not older files in the shared folder", async () => {
    const newBuild = path.join(runRoot, "BuildPaths_20260710_090000.txt");
    const newSp = path.join(runRoot, "AllStoredProcedures_20260710_090000.sql");
    execFile.mockImplementation((cmd, args, opts, cb) => {
      fs.writeFileSync(newBuild, '<Build Include="dbo\\Views\\V.sql" />');
      fs.writeFileSync(newSp, "fresh");
      cb(null, `BuildPaths file: ${newBuild}\r\nCombined SP file: ${newSp}\r\n`, "");
    });

    const result = await generateObjectScripts({ taskId: "t-stdout", profile, selectedObjects, outputBasePath: base });
    expect(result.latestBuildPathFile).toBe(newBuild);
    expect(result.combinedStoredProceduresPath).toBe(newSp);
    expect(execFile.mock.calls[0][2]).not.toHaveProperty("timeout");
    cleanupObjectList(result);
  });

  it("falls back to files created during the run when stdout has no artifact lines", async () => {
    const newBuild = path.join(runRoot, "BuildPaths_20260710_090000.txt");
    execFile.mockImplementation((cmd, args, opts, cb) => {
      fs.writeFileSync(newBuild, '<Build Include="dbo\\Views\\V.sql" />');
      cb(null, "Completed DB: TestDb\r\n", "");
    });

    const result = await generateObjectScripts({ taskId: "t-diff", profile, selectedObjects, outputBasePath: base });
    expect(result.latestBuildPathFile).toBe(newBuild);
    // The stale combined SP file must NOT be picked up as this run's output.
    expect(result.combinedStoredProceduresPath).toBeNull();
    cleanupObjectList(result);
  });

  it("refuses to reuse an older run's manifest when the run produced none", async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => {
      cb(null, "Completed DB: TestDb\r\n", "");
    });

    await expect(
      generateObjectScripts({ taskId: "t-none", profile, selectedObjects, outputBasePath: base })
    ).rejects.toThrow(/did not produce a fresh BuildPaths manifest/i);
  });
});

describe("normalizeExecutableSql — CREATE OR ALTER conversion", () => {
  it("converts CREATE PROCEDURE → CREATE OR ALTER PROCEDURE", () => {
    const out = normalizeExecutableSql("CREATE PROCEDURE [dbo].[foo] AS SELECT 1", "PROCEDURE");
    expect(out).toMatch(/CREATE OR ALTER PROCEDURE/);
  });

  it("converts CREATE PROC (abbreviated) → CREATE OR ALTER PROCEDURE", () => {
    const out = normalizeExecutableSql("CREATE PROC [dbo].[foo] AS SELECT 1", "PROCEDURE");
    expect(out).toMatch(/CREATE OR ALTER PROCEDURE/);
  });

  it("converts CREATE VIEW → CREATE OR ALTER VIEW", () => {
    const out = normalizeExecutableSql("CREATE VIEW [dbo].[v] AS SELECT 1 AS x", "VIEW");
    expect(out).toMatch(/CREATE OR ALTER VIEW/);
  });

  it("converts CREATE FUNCTION → CREATE OR ALTER FUNCTION", () => {
    const out = normalizeExecutableSql("CREATE FUNCTION [dbo].[fn]() RETURNS INT AS BEGIN RETURN 1 END", "FUNCTION");
    expect(out).toMatch(/CREATE OR ALTER FUNCTION/);
  });

  it("splits leading SET options into a separate batch for procedures", () => {
    const sql = [
      "SET QUOTED_IDENTIFIER OFF",
      "/*** header ***/",
      "CREATE PROCEDURE [dbo].[foo] AS SELECT 1",
    ].join("\n");

    const out = normalizeExecutableSql(sql, "PROCEDURE");

    expect(out).toContain("SET QUOTED_IDENTIFIER OFF\nGO\n/*** header ***/\nCREATE OR ALTER PROCEDURE [dbo].[foo] AS SELECT 1");
  });

  it("rehydrates metadata-backed SET batches for headerless programmable deploy artifacts", () => {
    const out = normalizeExecutableSql("CREATE VIEW [dbo].[v] AS SELECT 1 AS x", "VIEW", {}, {
      strategy: "createOrAlter",
      moduleMetadata: {
        usesAnsiNulls: false,
        usesQuotedIdentifier: true,
      },
    });

    expect(out).toContain("SET ANSI_NULLS OFF\nGO\nSET QUOTED_IDENTIFIER ON\nGO\nCREATE OR ALTER VIEW [dbo].[v] AS SELECT 1 AS x");
  });

  it("leaves TABLE DDL unchanged (no OR ALTER for tables)", () => {
    const sql = "CREATE TABLE [dbo].[t] (id INT NOT NULL)";
    const out = normalizeExecutableSql(sql, "TABLE");
    expect(out).not.toMatch(/CREATE OR ALTER/);
  });

  it("wraps SYNONYM in IF OBJECT_ID DROP guard", () => {
    const out = normalizeExecutableSql("CREATE SYNONYM [dbo].[s] FOR [other].[t]", "SYNONYM", { schemaName: "dbo", objectName: "s" });
    expect(out).toMatch(/IF OBJECT_ID\(N'dbo\.s', 'SN'\) IS NOT NULL DROP SYNONYM \[dbo\]\.\[s\]/);
  });

  it("separates DROP guard and CREATE VIEW into different batches", () => {
    const out = normalizeExecutableSql("CREATE VIEW [dbo].[v] AS SELECT 1 AS x", "VIEW", { schemaName: "dbo", objectName: "v" }, { strategy: "dropCreate" });
    expect(out).toContain("IF OBJECT_ID(N'dbo.v', 'V') IS NOT NULL DROP VIEW [dbo].[v];\nGO\nCREATE VIEW [dbo].[v] AS SELECT 1 AS x");
  });

  it("separates DROP guards and CREATE FUNCTION into different batches", () => {
    const out = normalizeExecutableSql("CREATE FUNCTION [dbo].[fn]() RETURNS INT AS BEGIN RETURN 1 END", "FUNCTION", { schemaName: "dbo", objectName: "fn" }, { strategy: "dropCreate" });
    expect(out).toContain("IF OBJECT_ID(N'dbo.fn', 'FN') IS NOT NULL DROP FUNCTION [dbo].[fn];");
    expect(out).toContain("IF OBJECT_ID(N'dbo.fn', 'TF') IS NOT NULL DROP FUNCTION [dbo].[fn];");
    expect(out).toContain("IF OBJECT_ID(N'dbo.fn', 'IF') IS NOT NULL DROP FUNCTION [dbo].[fn];\nGO\nCREATE FUNCTION [dbo].[fn]() RETURNS INT AS BEGIN RETURN 1 END");
  });

  it("wraps SEQUENCE in a DROP guard using an OBJECT_ID lookup name SQL Server can resolve", () => {
    const out = normalizeExecutableSql("CREATE SEQUENCE [dbo].[seq_Id] START WITH 1 INCREMENT BY 1", "SEQUENCE", { schemaName: "dbo", objectName: "seq_Id" }, { strategy: "dropCreate" });
    expect(out).toContain("IF OBJECT_ID(N'dbo.seq_Id', 'SO') IS NOT NULL DROP SEQUENCE [dbo].[seq_Id];\nGO\nCREATE SEQUENCE [dbo].[seq_Id] START WITH 1 INCREMENT BY 1");
  });

  it("wraps USER_DEFINED_TYPE by dropping dependent modules before drop/create and then recreating them", () => {
    const out = normalizeExecutableSql("CREATE TYPE [dbo].[PhoneType] FROM NVARCHAR(20) NOT NULL", "USER_DEFINED_TYPE", { schemaName: "dbo", objectName: "PhoneType" }, { strategy: "dropCreate" });
    expect(out).toContain("DECLARE @PebloyTypeName nvarchar(776) = N'dbo.PhoneType';");
    expect(out).toContain("DECLARE @PebloyTypeDropSql nvarchar(max) = N'DROP TYPE [dbo].[PhoneType];';");
    expect(out).toContain("FROM sys.parameters p");
    expect(out).toContain("AND m.definition IS NOT NULL;");
    expect(out).toContain("EXEC(@PebloyDropSql);");
    expect(out).toContain("EXEC(@PebloyTypeDropSql);");
    expect(out).toContain("EXEC(N'CREATE TYPE [dbo].[PhoneType] FROM NVARCHAR(20) NOT NULL');");
    expect(out).toContain("EXEC(@PebloyCreateSql);");
  });
});
