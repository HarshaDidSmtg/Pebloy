"use strict";

jest.mock("./scriptAutomationService", () => ({
  generateObjectScripts: jest.fn(),
  listGeneratedObjectScripts: jest.fn(),
  findLatestCombinedStoredProcedureScript: jest.fn(),
  normalizeExecutableSql: jest.fn((sqlText) => {
    let text = String(sqlText || "").replace(/\r\n/g, "\n").trim();
    text = text.replace(/^\s*CREATE\s+(?:OR\s+ALTER\s+)?PROC(?:EDURE)?\b/im, "CREATE OR ALTER PROCEDURE");
    return text;
  }),
}));
jest.mock("./sqlService", () => ({
  fetchObjectDefinitionMap: jest.fn(),
  normalizeBitFlag: jest.fn((value) => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return null;
  }),
}));
jest.mock("fs", () => ({
  writeFileSync: jest.fn(),
  readFileSync: jest.fn(),
}));

const fs = require("fs");
const {
  generateObjectScripts,
  listGeneratedObjectScripts,
  findLatestCombinedStoredProcedureScript,
} = require("./scriptAutomationService");
const { fetchObjectDefinitionMap } = require("./sqlService");
const {
  buildCombinedStoredProcedureText,
  generateScriptsForProfile,
  validateCanonicalSourceArtifacts,
} = require("./scriptGenerationService");

describe("buildCombinedStoredProcedureText", () => {
  it("rewrites procedure headers to CREATE OR ALTER without session-setting prefixes", () => {
    const text = buildCombinedStoredProcedureText([
      { definitionText: "CREATE PROCEDURE [dbo].[ProcA]\nAS\nSELECT 1" },
      { definitionText: "CREATE PROC [dbo].[ProcB]\nAS\nSELECT 2" },
    ]);

    expect(text).not.toContain("SET ANSI_NULLS");
    expect(text).not.toContain("SET QUOTED_IDENTIFIER");
    expect(text).toContain("CREATE OR ALTER PROCEDURE [dbo].[ProcA]");
    expect(text).toContain("CREATE OR ALTER PROCEDURE [dbo].[ProcB]");
    expect(text.match(/\bGO\b/g)).toHaveLength(2);
  });
});

describe("generateScriptsForProfile", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.readFileSync.mockImplementation((filePath) => {
      if (String(filePath).includes("Tbl_UnifiedTrips")) {
        return "CREATE TABLE [dbo].[Tbl_UnifiedTrips] ([TripId] INT NOT NULL)";
      }
      if (String(filePath).includes("ViewA")) {
        return "CREATE VIEW dbo.ViewA AS SELECT 1 AS Value";
      }
      return "CREATE PROCEDURE dbo.ProcA AS SELECT 1";
    });
  });

  it("rewrites programmable object files from exact database definitions and refreshes the combined procedure script", async () => {
    generateObjectScripts.mockResolvedValue({
      runRoot: "/exports/run/db",
      latestBuildPathFile: "/exports/run/db/BuildPaths.txt",
    });
    listGeneratedObjectScripts.mockReturnValue([
      {
        objectType: "PROCEDURE",
        schemaName: "Reports",
        objectName: "UspUnifiedTripsIncrementalLoad",
        scriptPath: "/exports/run/db/Reports/Stored Procedures/UspUnifiedTripsIncrementalLoad.sql",
      },
      {
        objectType: "TABLE",
        schemaName: "dbo",
        objectName: "Tbl_UnifiedTrips",
        scriptPath: "/exports/run/db/dbo/Tables/Tbl_UnifiedTrips.sql",
      },
    ]);
    findLatestCombinedStoredProcedureScript.mockReturnValue("/exports/run/db/AllStoredProcedures_20260617_120000.sql");
    fetchObjectDefinitionMap.mockResolvedValue(new Map([
      [
        "PROCEDURE|Reports|UspUnifiedTripsIncrementalLoad",
        {
          objectType: "PROCEDURE",
          schemaName: "Reports",
          objectName: "UspUnifiedTripsIncrementalLoad",
          definition: "CREATE PROCEDURE Reports.UspUnifiedTripsIncrementalLoad\nAS\nSELECT 1",
          usesAnsiNulls: true,
          usesQuotedIdentifier: true,
        },
      ],
    ]));

    const result = await generateScriptsForProfile({
      taskId: "task-1",
      profile: { serverName: "src", databaseName: "db" },
      selectedObjects: [
        { objectType: "PROCEDURE", schemaName: "Reports", objectName: "UspUnifiedTripsIncrementalLoad" },
        { objectType: "TABLE", schemaName: "dbo", objectName: "Tbl_UnifiedTrips" },
      ],
      outputBasePath: "/exports",
      appTaskMode: "backup",
    });

    expect(fetchObjectDefinitionMap).toHaveBeenCalledWith(
      { serverName: "src", databaseName: "db" },
      expect.arrayContaining([
        expect.objectContaining({ objectType: "PROCEDURE", schemaName: "Reports", objectName: "UspUnifiedTripsIncrementalLoad" }),
      ])
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/exports/run/db/Reports/Stored Procedures/UspUnifiedTripsIncrementalLoad.sql",
      "CREATE PROCEDURE Reports.UspUnifiedTripsIncrementalLoad\r\nAS\r\nSELECT 1",
      "utf8"
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/exports/run/db/AllStoredProcedures_20260617_120000.sql",
      expect.stringContaining("CREATE OR ALTER PROCEDURE Reports.UspUnifiedTripsIncrementalLoad"),
      "utf8"
    );
    expect(result.exactDefinitionsApplied).toBe(1);
    expect(result.exactDefinitionWarning).toBeNull();
    expect(result.generationWarnings).toEqual([]);
    expect(result.scripts[0].moduleMetadata).toEqual({
      usesAnsiNulls: true,
      usesQuotedIdentifier: true,
      definitionSource: "exact",
    });
  });

  it("keeps individual procedure files free of session-setting prefixes outside backup mode", async () => {
    generateObjectScripts.mockResolvedValue({
      runRoot: "/exports/run/db",
      latestBuildPathFile: "/exports/run/db/BuildPaths.txt",
    });
    listGeneratedObjectScripts.mockReturnValue([
      {
        objectType: "PROCEDURE",
        schemaName: "dbo",
        objectName: "ProcA",
        scriptPath: "/exports/run/db/dbo/Stored Procedures/ProcA.sql",
      },
    ]);
    findLatestCombinedStoredProcedureScript.mockReturnValue("/exports/run/db/AllStoredProcedures_20260617_120000.sql");
    fetchObjectDefinitionMap.mockResolvedValue(new Map([
      [
        "PROCEDURE|dbo|proca",
        {
          objectType: "PROCEDURE",
          schemaName: "dbo",
          objectName: "ProcA",
          definition: "CREATE PROCEDURE dbo.ProcA\nAS\nSELECT 1",
        },
      ],
    ]));

    await generateScriptsForProfile({
      taskId: "task-3",
      profile: { serverName: "src", databaseName: "db" },
      selectedObjects: [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" }],
      outputBasePath: "/exports",
      appTaskMode: "code_diff",
    });

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/exports/run/db/dbo/Stored Procedures/ProcA.sql",
      "CREATE PROCEDURE dbo.ProcA\r\nAS\r\nSELECT 1",
      "utf8"
    );
  });

  it("falls back to the generated files when exact-definition lookup fails", async () => {
    generateObjectScripts.mockResolvedValue({
      runRoot: "/exports/run/db",
      latestBuildPathFile: "/exports/run/db/BuildPaths.txt",
    });
    listGeneratedObjectScripts.mockReturnValue([
      {
        objectType: "VIEW",
        schemaName: "dbo",
        objectName: "ViewA",
        scriptPath: "/exports/run/db/dbo/Views/ViewA.sql",
      },
    ]);
    findLatestCombinedStoredProcedureScript.mockReturnValue(null);
    fetchObjectDefinitionMap.mockRejectedValue(new Error("metadata lookup failed"));

    const result = await generateScriptsForProfile({
      taskId: "task-2",
      profile: { serverName: "src", databaseName: "db" },
      selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "ViewA" }],
      outputBasePath: "/exports",
      appTaskMode: "code_diff",
    });

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(result.exactDefinitionsApplied).toBe(0);
    expect(result.exactDefinitionWarning).toBe("metadata lookup failed");
    expect(result.generationWarnings).toEqual([
      expect.objectContaining({
        code: "EXACT_DEFINITION_LOOKUP_FAILED",
      }),
    ]);
  });
});

describe("validateCanonicalSourceArtifacts", () => {
  it("rejects deploy-only CREATE OR ALTER wrappers in canonical programmable source files", () => {
    expect(() => validateCanonicalSourceArtifacts([
      {
        objectType: "PROCEDURE",
        schemaName: "dbo",
        objectName: "BadProc",
        definitionText: "CREATE OR ALTER PROCEDURE dbo.BadProc AS SELECT 1",
      },
    ])).toThrow(/CREATE OR ALTER/);
  });

  it("rejects leading SET ANSI_NULLS headers in procedure source files", () => {
    expect(() => validateCanonicalSourceArtifacts([
      {
        objectType: "PROCEDURE",
        schemaName: "dbo",
        objectName: "ProcWithHeader",
        definitionText: "SET ANSI_NULLS ON\nGO\nCREATE PROCEDURE dbo.ProcWithHeader AS SELECT 1",
      },
    ])).toThrow(/SET ANSI_NULLS/);
  });

  it("rejects IF OBJECT_ID drop guards in canonical view source files", () => {
    expect(() => validateCanonicalSourceArtifacts([
      {
        objectType: "VIEW",
        schemaName: "dbo",
        objectName: "VwOrders",
        definitionText: "IF OBJECT_ID('dbo.VwOrders','V') IS NOT NULL DROP VIEW dbo.VwOrders;\nCREATE VIEW dbo.VwOrders AS SELECT 1 AS Id",
      },
    ])).toThrow(/deploy-only wrapper/);
  });

  it("rejects function source that does not start with CREATE/ALTER", () => {
    expect(() => validateCanonicalSourceArtifacts([
      {
        objectType: "FUNCTION",
        schemaName: "dbo",
        objectName: "fn_bad",
        definitionText: "-- some comment\nCREATE FUNCTION dbo.fn_bad() RETURNS INT AS BEGIN RETURN 1 END",
      },
    ])).toThrow(/Expected the canonical FUNCTION/);
  });

  it("rejects TABLE source that starts with CREATE OR ALTER", () => {
    expect(() => validateCanonicalSourceArtifacts([
      {
        objectType: "TABLE",
        schemaName: "dbo",
        objectName: "Orders",
        definitionText: "CREATE OR ALTER TABLE dbo.Orders (Id INT)",
      },
    ])).toThrow(/CREATE TABLE/);
  });

  it("rejects TABLE source with deploy-only session-setting headers", () => {
    expect(() => validateCanonicalSourceArtifacts([
      {
        objectType: "TABLE",
        schemaName: "dbo",
        objectName: "Orders",
        definitionText: "SET ANSI_NULLS ON\nGO\nCREATE TABLE dbo.Orders (Id INT)",
      },
    ])).toThrow(/session-setting headers/);
  });

  it("rejects empty source artifact", () => {
    expect(() => validateCanonicalSourceArtifacts([
      { objectType: "PROCEDURE", schemaName: "dbo", objectName: "EmptyProc", definitionText: "" },
    ])).toThrow(/is empty/);
  });

  it("accepts a valid VIEW source file", () => {
    expect(() => validateCanonicalSourceArtifacts([
      {
        objectType: "VIEW",
        schemaName: "reporting",
        objectName: "vw_ActiveCustomers",
        definitionText: "CREATE VIEW reporting.vw_ActiveCustomers AS SELECT Id, Name FROM dbo.Customers WHERE IsActive = 1",
      },
    ])).not.toThrow();
  });

  it("accepts a valid FUNCTION source file", () => {
    expect(() => validateCanonicalSourceArtifacts([
      {
        objectType: "FUNCTION",
        schemaName: "dbo",
        objectName: "fn_GetTotal",
        definitionText: "CREATE FUNCTION dbo.fn_GetTotal(@id INT)\nRETURNS DECIMAL(10,2)\nAS\nBEGIN\n  RETURN 0\nEND",
      },
    ])).not.toThrow();
  });

  it("accepts a valid TRIGGER source file", () => {
    expect(() => validateCanonicalSourceArtifacts([
      {
        objectType: "TRIGGER",
        schemaName: "dbo",
        objectName: "trg_OrderInsert",
        definitionText: "CREATE TRIGGER dbo.trg_OrderInsert ON dbo.Orders AFTER INSERT AS SELECT 1",
      },
    ])).not.toThrow();
  });

  it("accepts a valid TABLE source file", () => {
    expect(() => validateCanonicalSourceArtifacts([
      {
        objectType: "TABLE",
        schemaName: "dbo",
        objectName: "Customers",
        definitionText: "CREATE TABLE dbo.Customers (Id INT NOT NULL PRIMARY KEY, Name NVARCHAR(200) NOT NULL)",
      },
    ])).not.toThrow();
  });

  it("passes through non-module types (SYNONYM, SEQUENCE, USER_DEFINED_TYPE) without errors", () => {
    expect(() => validateCanonicalSourceArtifacts([
      { objectType: "SYNONYM", schemaName: "dbo", objectName: "syn_Orders", definitionText: "CREATE SYNONYM dbo.syn_Orders FOR archive.Orders" },
      { objectType: "SEQUENCE", schemaName: "dbo", objectName: "seq_Id", definitionText: "CREATE SEQUENCE dbo.seq_Id START WITH 1 INCREMENT BY 1" },
      { objectType: "USER_DEFINED_TYPE", schemaName: "dbo", objectName: "PhoneType", definitionText: "CREATE TYPE dbo.PhoneType FROM NVARCHAR(20)" },
    ])).not.toThrow();
  });
});

describe("buildCombinedStoredProcedureText — golden output", () => {
  it("produces deterministic output for a two-procedure set", () => {
    const result = buildCombinedStoredProcedureText([
      { definitionText: "CREATE PROCEDURE dbo.ProcAlpha\nAS\nSELECT 1" },
      { definitionText: "CREATE PROC dbo.ProcBeta\nAS\nSELECT 2" },
    ]);
    expect(result).toMatchSnapshot();
  });

  it("skips empty scripts without producing blank GO batches", () => {
    const result = buildCombinedStoredProcedureText([
      { definitionText: "" },
      { definitionText: "CREATE PROCEDURE dbo.OnlyReal\nAS\nSELECT 1" },
    ]);
    const goCount = (result.match(/\bGO\b/g) || []).length;
    expect(goCount).toBe(1);
  });
});

describe("generateScriptsForProfile — golden output for programmable object types", () => {
  function makeScriptEntry(objectType, schemaName, objectName, definitionText) {
    return { objectType, schemaName, objectName, scriptPath: `/exports/run/db/${schemaName}/${objectType}/${objectName}.sql`, definitionText };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    generateObjectScripts.mockResolvedValue({ runRoot: "/exports/run/db", latestBuildPathFile: null });
    findLatestCombinedStoredProcedureScript.mockReturnValue(null);
    fs.readFileSync.mockReturnValue("CREATE VIEW dbo.vw_Test AS SELECT 1");
  });

  it("emits EXACT_DEFINITION_OBJECT_MISSING warning and null moduleMetadata when definition not found in map", async () => {
    listGeneratedObjectScripts.mockReturnValue([
      makeScriptEntry("PROCEDURE", "dbo", "MissingProc", "CREATE PROCEDURE dbo.MissingProc AS SELECT 1"),
    ]);
    fetchObjectDefinitionMap.mockResolvedValue(new Map());

    const result = await generateScriptsForProfile({
      taskId: "t1",
      profile: { serverName: "srv", databaseName: "db" },
      selectedObjects: [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "MissingProc" }],
      outputBasePath: "/exports",
      appTaskMode: "backup",
    });

    expect(result.generationWarnings).toEqual([
      expect.objectContaining({ code: "EXACT_DEFINITION_OBJECT_MISSING", objectName: "MissingProc" }),
    ]);
    expect(result.scripts[0].moduleMetadata).toEqual({ usesAnsiNulls: null, usesQuotedIdentifier: null, definitionSource: "generated" });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("emits EXACT_DEFINITION_METADATA_INCOMPLETE warning when module flags are null", async () => {
    listGeneratedObjectScripts.mockReturnValue([
      makeScriptEntry("VIEW", "dbo", "vw_Test", "CREATE VIEW dbo.vw_Test AS SELECT 1"),
    ]);
    fetchObjectDefinitionMap.mockResolvedValue(new Map([
      ["VIEW|dbo|vw_test", { objectType: "VIEW", schemaName: "dbo", objectName: "vw_Test", definition: "CREATE VIEW dbo.vw_Test AS SELECT 1", usesAnsiNulls: null, usesQuotedIdentifier: null }],
    ]));

    const result = await generateScriptsForProfile({
      taskId: "t2",
      profile: { serverName: "srv", databaseName: "db" },
      selectedObjects: [{ objectType: "VIEW", schemaName: "dbo", objectName: "vw_Test" }],
      outputBasePath: "/exports",
      appTaskMode: "code_diff",
    });

    expect(result.generationWarnings).toEqual([
      expect.objectContaining({ code: "EXACT_DEFINITION_METADATA_INCOMPLETE", objectName: "vw_Test" }),
    ]);
  });

  it("writes windows line endings to generated per-object source file", async () => {
    listGeneratedObjectScripts.mockReturnValue([
      makeScriptEntry("FUNCTION", "dbo", "fn_Calc", "CREATE FUNCTION dbo.fn_Calc() RETURNS INT AS BEGIN RETURN 1 END"),
    ]);
    fetchObjectDefinitionMap.mockResolvedValue(new Map([
      ["FUNCTION|dbo|fn_calc", { objectType: "FUNCTION", schemaName: "dbo", objectName: "fn_Calc", definition: "CREATE FUNCTION dbo.fn_Calc()\nRETURNS INT\nAS\nBEGIN\n  RETURN 1\nEND", usesAnsiNulls: true, usesQuotedIdentifier: true }],
    ]));

    await generateScriptsForProfile({
      taskId: "t3",
      profile: { serverName: "srv", databaseName: "db" },
      selectedObjects: [{ objectType: "FUNCTION", schemaName: "dbo", objectName: "fn_Calc" }],
      outputBasePath: "/exports",
      appTaskMode: "deploy",
    });

    const writtenText = fs.writeFileSync.mock.calls[0][1];
    expect(writtenText).toContain("\r\n");
    expect(writtenText).not.toMatch(/(?<!\r)\n/);
  });
});