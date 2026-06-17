"use strict";

jest.mock("./scriptAutomationService", () => ({
  generateObjectScripts: jest.fn(),
  listGeneratedObjectScripts: jest.fn(),
  findLatestCombinedStoredProcedureScript: jest.fn(),
  normalizeExecutableSql: jest.fn((sqlText) => {
    let text = String(sqlText || "").replace(/\r\n/g, "\n").trim();
    text = text.replace(/^\s*CREATE\s+(?:OR\s+ALTER\s+)?PROC(?:EDURE)?\b/im, "CREATE OR ALTER PROCEDURE");
    text = text.replace(
      /^SET ANSI_NULLS ON\nGO\nSET QUOTED_IDENTIFIER ON\n(?!GO\n)/im,
      "SET ANSI_NULLS ON\nGO\nSET QUOTED_IDENTIFIER ON\nGO\n"
    );
    return text;
  }),
}));
jest.mock("./sqlService", () => ({
  fetchObjectDefinitionMap: jest.fn(),
}));
jest.mock("fs", () => ({
  writeFileSync: jest.fn(),
}));

const fs = require("fs");
const {
  generateObjectScripts,
  listGeneratedObjectScripts,
  findLatestCombinedStoredProcedureScript,
} = require("./scriptAutomationService");
const { fetchObjectDefinitionMap } = require("./sqlService");
const { buildCombinedStoredProcedureText, generateScriptsForProfile } = require("./scriptGenerationService");

describe("buildCombinedStoredProcedureText", () => {
  it("preserves session-setting batches and rewrites procedure headers to CREATE OR ALTER", () => {
    const text = buildCombinedStoredProcedureText([
      { definitionText: "SET ANSI_NULLS ON\nGO\nSET QUOTED_IDENTIFIER ON\nGO\nCREATE PROCEDURE [dbo].[ProcA]\nAS\nSELECT 1" },
      { definitionText: "SET ANSI_NULLS ON\nGO\nSET QUOTED_IDENTIFIER ON\nGO\nCREATE PROC [dbo].[ProcB]\nAS\nSELECT 2" },
    ]);

    expect(text).toContain("SET ANSI_NULLS ON\r\nGO\r\nSET QUOTED_IDENTIFIER ON\r\nGO\r\nCREATE OR ALTER PROCEDURE [dbo].[ProcA]");
    expect(text).toContain("CREATE OR ALTER PROCEDURE [dbo].[ProcA]");
    expect(text).toContain("CREATE OR ALTER PROCEDURE [dbo].[ProcB]");
    expect(text.match(/\bGO\b/g)).toHaveLength(6);
  });
});

describe("generateScriptsForProfile", () => {
  beforeEach(() => jest.clearAllMocks());

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
          definition: "SET ANSI_NULLS ON\nGO\nSET QUOTED_IDENTIFIER ON\nGO\nCREATE PROCEDURE Reports.UspUnifiedTripsIncrementalLoad\nAS\nSELECT 1",
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
      "SET ANSI_NULLS ON\r\nGO\r\nSET QUOTED_IDENTIFIER ON\r\nGO\r\nCREATE PROCEDURE Reports.UspUnifiedTripsIncrementalLoad\r\nAS\r\nSELECT 1",
      "utf8"
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/exports/run/db/AllStoredProcedures_20260617_120000.sql",
      expect.stringContaining("SET ANSI_NULLS ON\r\nGO\r\nSET QUOTED_IDENTIFIER ON\r\nGO\r\nCREATE OR ALTER PROCEDURE Reports.UspUnifiedTripsIncrementalLoad"),
      "utf8"
    );
    expect(result.exactDefinitionsApplied).toBe(1);
    expect(result.exactDefinitionWarning).toBeNull();
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
  });
});