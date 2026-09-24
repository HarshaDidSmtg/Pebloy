const fs = require("fs");
const path = require("path");
const os = require("os");
jest.mock("./dacfxService", () => ({ inspectScripts: jest.fn() }));
jest.mock("./scriptAutomationService", () => ({
  buildProfileOutputBasePath: (root, alias) => require("path").join(root, alias),
  buildRunRoot: (root, database) => require("path").join(root, "test-date", database),
}));
jest.mock("./scriptGenerationService", () => ({ buildCombinedStoredProcedureText: (scripts) => scripts.filter((script) => script.objectType === "PROCEDURE").map((script) => script.definitionText).join("\nGO\n") }));
const { inspectScripts } = require("./dacfxService");
const { loadFolderSource, selectFolderScripts, materializeFolderSource } = require("./folderSourceService");

describe("folder sources", () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-folder-"));
    fs.mkdirSync(path.join(root, "source"));
    inspectScripts.mockImplementation(async (inputs) => inputs.map((input) => ({ fileName: input.fileName, objectType: "PROCEDURE", schemaName: "dbo", objectName: path.basename(input.fileName, ".sql"), definitionText: input.sqlText, dependencies: [], moduleMetadata: { usesAnsiNulls: true, usesQuotedIdentifier: true } })));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  test("fingerprints fresh contents and materializes without modifying source files", async () => {
    const source = path.join(root, "source");
    fs.writeFileSync(path.join(source, "Proc.sql"), "CREATE PROCEDURE dbo.Proc AS SELECT 1");
    fs.writeFileSync(path.join(source, "AllStoredProcedures_old.sql"), "ignored combined artifact");
    const profile = await loadFolderSource(source);
    expect(profile.folderScripts).toHaveLength(1);
    const generated = await materializeFolderSource({ profile, selectedObjects: profile.folderScripts, outputBasePath: path.join(root, "output") });
    expect(generated.combinedStoredProceduresPath).toMatch(/AllStoredProcedures_\d{8}_\d{6}\.sql$/);
    expect(fs.readFileSync(generated.scripts[0].scriptPath, "utf8")).toContain("CREATE PROCEDURE");
    expect(fs.readFileSync(path.join(source, "Proc.sql"), "utf8")).toBe("CREATE PROCEDURE dbo.Proc AS SELECT 1");
    fs.appendFileSync(path.join(source, "Proc.sql"), ";");
    expect((await loadFolderSource(source)).folderFingerprint).not.toBe(profile.folderFingerprint);
    expect(() => selectFolderScripts(profile, [{ objectType: "VIEW", schemaName: "dbo", objectName: "Missing" }])).toThrow("not found");
    await expect(materializeFolderSource({ profile, selectedObjects: profile.folderScripts, outputBasePath: source })).rejects.toThrow("outside");
  });
  test("refuses empty folders, duplicate declarations, and oversized inputs", async () => {
    const source = path.join(root, "source");
    await expect(loadFolderSource(source)).rejects.toThrow("No per-object");
    fs.writeFileSync(path.join(source, "One.sql"), "SELECT 1");
    fs.writeFileSync(path.join(source, "Two.sql"), "SELECT 2");
    inspectScripts.mockImplementation(async (inputs) => inputs.map((input) => ({ fileName: input.fileName, objectType: "VIEW", schemaName: "dbo", objectName: "Same" })));
    await expect(loadFolderSource(source)).rejects.toThrow("Duplicate");
    fs.writeFileSync(path.join(source, "Large.sql"), "x".repeat(5 * 1024 * 1024 + 1));
    await expect(loadFolderSource(source)).rejects.toThrow("limited");
  });

  test("selects only catalog-backed objects and ignores stale client definitions", async () => {
    fs.writeFileSync(path.join(root, "source", "Proc.sql"), "CREATE PROCEDURE dbo.Proc AS SELECT 1");
    const profile = await loadFolderSource(path.join(root, "source"));
    const selected = selectFolderScripts(profile, [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "Proc", definitionText: "DROP DATABASE unsafe" }]);
    expect(selected[0].definitionText).toBe("CREATE PROCEDURE dbo.Proc AS SELECT 1");
  });

  test("the published offline parser recognizes supported types and rejects executable extras", async () => {
    const { inspectScripts: inspectRealScripts } = jest.requireActual("./dacfxService");
    const declarations = [
      ["PROCEDURE", "SET ANSI_NULLS OFF;\nGO\nCREATE PROCEDURE App.Run AS SELECT * FROM Items;"],
      ["VIEW", "CREATE VIEW dbo.Sample AS SELECT 1 AS Value;"],
      ["FUNCTION", "CREATE FUNCTION dbo.Sample() RETURNS int AS BEGIN RETURN 1; END"],
      ["TABLE", "CREATE TABLE dbo.Sample (Id int);"],
      ["TRIGGER", "CREATE TRIGGER dbo.Sample ON dbo.Items AFTER INSERT AS SELECT 1;"],
      ["SYNONYM", "CREATE SYNONYM dbo.Sample FOR dbo.Items;"],
      ["SEQUENCE", "CREATE SEQUENCE dbo.Sample AS int START WITH 1;"],
      ["USER_DEFINED_TYPE", "CREATE TYPE dbo.Sample FROM int;"],
      ["USER_DEFINED_TYPE", "CREATE TYPE dbo.Sample AS TABLE (Id int);"],
    ];
    const parsed = await inspectRealScripts(declarations.map(([objectType, sqlText], index) => ({ fileName: `${objectType}_${index}.sql`, sqlText })));
    expect(parsed.map((item) => item.objectType)).toEqual(declarations.map(([objectType]) => objectType));
    expect(parsed[0].moduleMetadata.usesAnsiNulls).toBe(false);
    expect(parsed[0].dependencies).toEqual(expect.arrayContaining([{ schemaName: "App", objectName: "Items" }, { schemaName: "dbo", objectName: "Items" }]));
    await expect(inspectRealScripts([{ fileName: "unsafe.sql", sqlText: "CREATE TABLE dbo.Sample (Id int); DROP TABLE dbo.Other;" }])).rejects.toThrow();
    await expect(inspectRealScripts([{ fileName: "late.sql", sqlText: "CREATE TABLE dbo.Sample (Id int); SET ANSI_NULLS OFF;" }])).rejects.toThrow();
  }, 30000);
});