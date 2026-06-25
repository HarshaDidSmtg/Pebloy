"use strict";

jest.mock("fs", () => ({
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
}));
jest.mock("os", () => ({
  tmpdir: jest.fn(() => "/tmp"),
}));
jest.mock("crypto", () => ({
  randomUUID: jest.fn(() => "uuid-1234"),
}));
jest.mock("child_process", () => ({
  execFile: jest.fn(),
}));
jest.mock("./scriptAutomationService", () => ({
  normalizeDdlKeywords: jest.fn((sql) => sql),
}));

const { EventEmitter } = require("events");
const fs = require("fs");
const { execFile } = require("child_process");
const { executeSqlScriptsIndividually, fetchObjectDefinitionMap, resolveObjectTypes } = require("./sqlService");

describe("executeSqlScriptsIndividually", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    execFile.mockImplementation((_command, _args, _options, callback) => {
      const stdout = new EventEmitter();
      const child = { stdout };

      process.nextTick(() => {
        stdout.emit("data", '{"key":"PROCEDURE|dbo|ProcA","ok":true,"error":null}\n');
        callback(null, "", "");
      });

      return child;
    });
  });

  it("generates shared-session cleanup guards around each independent object execution", async () => {
    const results = await executeSqlScriptsIndividually(
      {
        serverName: "dstServer",
        databaseName: "dstDb",
        authenticationType: "Windows",
      },
      [{ key: "PROCEDURE|dbo|ProcA", sqlText: "CREATE OR ALTER PROCEDURE dbo.ProcA AS SELECT 1" }],
      { continueOnError: true }
    );

    expect(results).toEqual([{ key: "PROCEDURE|dbo|ProcA", ok: true, error: null }]);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("pebloy_uuid-1234.ps1"),
      expect.stringContaining("function Get-TransactionCount($connection)"),
      "utf8"
    );

    const scriptText = fs.writeFileSync.mock.calls[0][1];
    expect(scriptText).toContain("Shared SQL session was not clean before");
    expect(scriptText).toContain("Script left the shared SQL session with @@TRANCOUNT=");
    expect(scriptText).toContain("IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION; SELECT @@TRANCOUNT;");
  });

  it("builds resolve-object queries that support name-only input and ambiguous-match detection", async () => {
    execFile.mockImplementation((_command, _args, _options, callback) => {
      const stdout = new EventEmitter();
      const child = { stdout };

      process.nextTick(() => {
        callback(null, "[]", "");
      });

      return child;
    });

    await resolveObjectTypes(
      {
        serverName: "srcServer",
        databaseName: "srcDb",
        authenticationType: "Windows",
      },
      [{ schemaName: "", objectName: "ProcA" }]
    );

    const scriptText = fs.writeFileSync.mock.calls[0][1];
    const base64Query = scriptText.match(/FromBase64String\('([^']+)'\)/)?.[1];
    const decodedQuery = Buffer.from(base64Query, "base64").toString("utf8");

    expect(decodedQuery).toContain("LOWER(oc.objectName) = LOWER(io.objectName)");
    expect(decodedQuery).toContain("NULLIF(LTRIM(RTRIM(io.schemaName)), '') IS NULL");
    expect(decodedQuery).toContain("ELSE N'Ambiguous'");
    expect(decodedQuery).toContain("inputSchemaName");
  });

  it("formats module definitions with metadata-backed session-setting batches", async () => {
    execFile.mockImplementation((_command, _args, _options, callback) => {
      const stdout = new EventEmitter();
      const child = { stdout };

      process.nextTick(() => {
        callback(null, JSON.stringify([
          {
            objectType: "PROCEDURE",
            schemaName: "dbo",
            objectName: "ProcA",
            definition: "-- authored preamble\nCREATE PROCEDURE dbo.ProcA AS SELECT 1",
            usesAnsiNulls: 1,
            usesQuotedIdentifier: 0,
          },
        ]), "");
      });

      return child;
    });

    const result = await fetchObjectDefinitionMap(
      {
        serverName: "srcServer",
        databaseName: "srcDb",
        authenticationType: "Windows",
      },
      [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" }]
    );

    const scriptText = fs.writeFileSync.mock.calls[0][1];
    const base64Query = scriptText.match(/FromBase64String\('([^']+)'\)/)?.[1];
    const decodedQuery = Buffer.from(base64Query, "base64").toString("utf8");

    expect(decodedQuery).toContain("m.uses_ansi_nulls AS usesAnsiNulls");
    expect(decodedQuery).toContain("m.uses_quoted_identifier AS usesQuotedIdentifier");
    expect(result.get("PROCEDURE|dbo|ProcA").definition).toBe(
      "CREATE PROCEDURE dbo.ProcA AS SELECT 1"
    );
  });
});