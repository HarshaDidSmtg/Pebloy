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
  existsSync: jest.fn(() => false),
}));

const fs = require("fs");
const {
  generateObjectScripts,
  listGeneratedObjectScripts,
} = require("./scriptAutomationService");
const { fetchObjectDefinitionMap } = require("./sqlService");
const {
  buildCombinedStoredProcedureText,
  generateScriptsForProfile,
  validateCanonicalSourceArtifacts,
} = require("./scriptGenerationService");
const { UTF8_BOM } = require("./sqlFileEncoding");

describe("buildCombinedStoredProcedureText", () => {
  it("rehydrates each procedure's session metadata through the real executable normalizer", () => {
    const mockedNormalizer = require("./scriptAutomationService").normalizeExecutableSql;
    const realNormalizer = jest.requireActual("./scriptAutomationService").normalizeExecutableSql;
    mockedNormalizer.mockImplementationOnce(realNormalizer).mockImplementationOnce(realNormalizer);
    const text = buildCombinedStoredProcedureText([
      { definitionText: "CREATE PROCEDURE dbo.FirstProc AS SELECT N'A  B'", moduleMetadata: { usesAnsiNulls: false, usesQuotedIdentifier: false } },
      { definitionText: "CREATE PROCEDURE dbo.SecondProc AS SELECT 2", moduleMetadata: { usesAnsiNulls: true, usesQuotedIdentifier: true } },
    ]);
    expect(text).toContain("SET ANSI_NULLS OFF");
    expect(text).toContain("SET QUOTED_IDENTIFIER OFF");
    expect(text).toContain("SET ANSI_NULLS ON");
    expect(text).toContain("SET QUOTED_IDENTIFIER ON");
    expect(text).toContain("N'A  B'");
    expect(text.indexOf("CREATE OR ALTER PROCEDURE dbo.FirstProc")).toBeLessThan(text.indexOf("SET ANSI_NULLS ON"));
    expect(text.indexOf("SET QUOTED_IDENTIFIER ON")).toBeLessThan(text.indexOf("CREATE OR ALTER PROCEDURE dbo.SecondProc"));
  });

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
      combinedStoredProceduresPath: "/exports/run/db/AllStoredProcedures_20260617_120000.sql",
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
      `${UTF8_BOM}CREATE PROCEDURE Reports.UspUnifiedTripsIncrementalLoad\r\nAS\r\nSELECT 1`,
      "utf8"
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/exports/run/db/AllStoredProcedures_20260617_120000.sql",
      expect.stringContaining(`${UTF8_BOM}CREATE OR ALTER PROCEDURE Reports.UspUnifiedTripsIncrementalLoad`),
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

  it.each([false, true])("rebuilds combined procedures in planned order (metadata unavailable: %s)", async (metadataUnavailable) => {
    const objects = ["Provider", "Consumer"].map((objectName) => ({ objectType: "PROCEDURE", schemaName: "dbo", objectName }));
    generateObjectScripts.mockResolvedValue({ runRoot: "/out", combinedStoredProceduresPath: "/out/AllStoredProcedures.sql" });
    listGeneratedObjectScripts.mockReturnValue([...objects].reverse().map((item) => ({ ...item, scriptPath: `/out/${item.objectName}.sql` })));
    fetchObjectDefinitionMap.mockResolvedValue(new Map(objects.map((item) => [item.objectName, {
      ...item, definition: `CREATE PROCEDURE dbo.${item.objectName} AS SELECT 1`, usesAnsiNulls: true, usesQuotedIdentifier: true,
    }])));
    if (metadataUnavailable) fetchObjectDefinitionMap.mockRejectedValueOnce(new Error("Metadata unavailable"));
    fs.readFileSync.mockImplementation((filePath) => `CREATE PROCEDURE dbo.${String(filePath).includes("Provider") ? "Provider" : "Consumer"} AS SELECT 1`);
    await generateScriptsForProfile({ taskId: "ordered", profile: {}, selectedObjects: objects, outputBasePath: "/out", appTaskMode: "deploy" });
    const combined = fs.writeFileSync.mock.calls.find(([filePath]) => filePath === "/out/AllStoredProcedures.sql")[1];
    expect(combined.indexOf("dbo.Provider")).toBeLessThan(combined.indexOf("dbo.Consumer"));
  });

  it("keeps individual procedure files free of session-setting prefixes outside backup mode", async () => {
    generateObjectScripts.mockResolvedValue({
      runRoot: "/exports/run/db",
      latestBuildPathFile: "/exports/run/db/BuildPaths.txt",
      combinedStoredProceduresPath: "/exports/run/db/AllStoredProcedures_20260617_120000.sql",
    });
    listGeneratedObjectScripts.mockReturnValue([
      {
        objectType: "PROCEDURE",
        schemaName: "dbo",
        objectName: "ProcA",
        scriptPath: "/exports/run/db/dbo/Stored Procedures/ProcA.sql",
      },
    ]);
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

    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/exports/run/db/dbo/Stored Procedures/ProcA.sql",
      `${UTF8_BOM}CREATE PROCEDURE dbo.ProcA\r\nAS\r\nSELECT 1`,
      "utf8"
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/exports/run/db/AllStoredProcedures_20260617_120000.sql",
      expect.stringContaining(`${UTF8_BOM}CREATE OR ALTER PROCEDURE dbo.ProcA`),
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

  it("accepts programmable source with a leading comment before the first module DDL", () => {
    expect(() => validateCanonicalSourceArtifacts([
      {
        objectType: "FUNCTION",
        schemaName: "dbo",
        objectName: "fn_with_comment",
        definitionText: "-- some comment\nCREATE FUNCTION dbo.fn_with_comment() RETURNS INT AS BEGIN RETURN 1 END",
      },
    ])).not.toThrow();
  });

  it("accepts procedure source when a block comment closes immediately before CREATE", () => {
    expect(() => validateCanonicalSourceArtifacts([
      {
        objectType: "PROCEDURE",
        schemaName: "Reports",
        objectName: "UspGetEECCSummaryReport",
        definitionText: "/*\nEXEC [Reports].[UspGetEECCSummaryReport]\n*/CREATE         PROCEDURE Reports.UspGetEECCSummaryReport AS SELECT 1",
      },
    ])).not.toThrow();
  });

  it("does not treat CREATE text inside a leading block comment as module DDL", () => {
    expect(() => validateCanonicalSourceArtifacts([
      {
        objectType: "PROCEDURE",
        schemaName: "dbo",
        objectName: "BadCommentOnlyProc",
        definitionText: "/*\nCREATE PROCEDURE dbo.BadCommentOnlyProc AS SELECT 1\n*/\nRETURN 1",
      },
    ])).toThrow(/Expected the canonical PROCEDURE/);
  });

  it("rejects function source that never reaches a CREATE/ALTER module statement", () => {
    expect(() => validateCanonicalSourceArtifacts([
      {
        objectType: "FUNCTION",
        schemaName: "dbo",
        objectName: "fn_bad",
        definitionText: "-- some comment\nRETURN 1",
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

  it("rejects TABLE source with session-setting headers", () => {
    expect(() => validateCanonicalSourceArtifacts([
      {
        objectType: "TABLE",
        schemaName: "dbo",
        objectName: "Orders",
        definitionText: "SET ANSI_NULLS ON\nGO\nSET QUOTED_IDENTIFIER ON\nGO\nCREATE TABLE dbo.Orders (Id INT)",
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
    generateObjectScripts.mockResolvedValue({ runRoot: "/exports/run/db", latestBuildPathFile: null, combinedStoredProceduresPath: null });
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

  it("accepts exact definitions that were authored with CREATE OR ALTER after canonical rewrite", async () => {
    listGeneratedObjectScripts.mockReturnValue([
      makeScriptEntry("PROCEDURE", "dbo", "ProcDeploy", "CREATE OR ALTER PROCEDURE dbo.ProcDeploy AS SELECT 1"),
    ]);
    fetchObjectDefinitionMap.mockResolvedValue(new Map([
      ["PROCEDURE|dbo|procdeploy", {
        objectType: "PROCEDURE",
        schemaName: "dbo",
        objectName: "ProcDeploy",
        definition: "CREATE PROCEDURE dbo.ProcDeploy\nAS\nSELECT 1",
        usesAnsiNulls: true,
        usesQuotedIdentifier: true,
      }],
    ]));

    await expect(generateScriptsForProfile({
      taskId: "t4",
      profile: { serverName: "srv", databaseName: "db" },
      selectedObjects: [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcDeploy" }],
      outputBasePath: "/exports",
      appTaskMode: "deploy",
    })).resolves.toMatchObject({
      exactDefinitionsApplied: 1,
      exactDefinitionWarning: null,
    });

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/exports/run/db/dbo/PROCEDURE/ProcDeploy.sql",
      `${UTF8_BOM}CREATE PROCEDURE dbo.ProcDeploy\r\nAS\r\nSELECT 1`,
      "utf8"
    );
  });
});