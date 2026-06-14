const fs = require("fs");
const path = require("path");
const os = require("os");

const { buildProfileOutputBasePath, createObjectListFile, normalizeExecutableSql } = require("./scriptAutomationService");

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

  it("leaves TABLE DDL unchanged (no OR ALTER for tables)", () => {
    const sql = "CREATE TABLE [dbo].[t] (id INT NOT NULL)";
    const out = normalizeExecutableSql(sql, "TABLE");
    expect(out).not.toMatch(/CREATE OR ALTER/);
  });

  it("wraps SYNONYM in IF OBJECT_ID DROP guard", () => {
    const out = normalizeExecutableSql("CREATE SYNONYM [dbo].[s] FOR [other].[t]", "SYNONYM", { schemaName: "dbo", objectName: "s" });
    expect(out).toMatch(/IF OBJECT_ID\(N'\[dbo\]\.\[s\]', 'SN'\) IS NOT NULL DROP SYNONYM/);
  });
});
