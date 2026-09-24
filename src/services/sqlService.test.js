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
const { executeSqlScript, executeSqlScriptsIndividually, fetchObjectDefinitionMap, fetchTypeSignatureMap, resolveObjectTypes, fetchObjectDependencies, fetchObjectDependencyEdges, buildObjectDependenciesQuery, buildResolveObjectTypesQuery } = require("./sqlService");

describe("executeSqlScriptsIndividually", () => {
  it("transports SQL credentials through stdin without persisting them in the wrapper", async () => {
    const password = "test-only-password';\u00f3";
    const end = jest.fn();
    execFile.mockImplementation((_command, args, _options, callback) => {
      expect(args.join(" ")).not.toContain(password);
      process.nextTick(() => callback(null, '{"ok":true}', ""));
      return { stdin: { on: jest.fn(), end }, stdout: new EventEmitter() };
    });
    await executeSqlScript({ serverName: "target", databaseName: "db", authenticationType: "Sql", username: "test", password }, "SELECT 1");
    const scriptText = fs.writeFileSync.mock.calls[0][1];
    expect(scriptText).not.toContain(password);
    expect(scriptText).not.toContain(password.replace(/'/g, "''"));
    expect(scriptText).toContain("$builder['Password'] = $PebloyPassword");
    expect(Buffer.from(end.mock.calls[0][0], "base64").toString("utf8")).toBe(password);
  });
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
    expect(scriptText).toContain("CommandText = 'BEGIN TRANSACTION;'");
    expect(scriptText).toContain("CommandText = 'COMMIT TRANSACTION;'");
    expect(scriptText).toContain("if ($connected) { throw $lastError }");
  });

  it("builds atomic grouped execution with initialization before connecting and no replay after connection", async () => {
    execFile.mockImplementation((_command, _args, _options, callback) => {
      process.nextTick(() => callback(null, '{"ok":true}', ""));
      return { stdout: new EventEmitter() };
    });
    await executeSqlScript({ serverName: "target", databaseName: "db", authenticationType: "Windows" }, "SELECT 1", { atomic: true });
    const scriptText = fs.writeFileSync.mock.calls[0][1];
    expect(scriptText.indexOf("$transaction = $null")).toBeLessThan(scriptText.indexOf("$connection.Open()"));
    expect(scriptText).toContain("$transaction = $connection.BeginTransaction()");
    expect(scriptText).toContain("$command.Transaction = $transaction");
    expect(scriptText).toContain("$transaction.Rollback()");
    expect(scriptText).toContain("if ($connected) { throw $lastError }");
  });

  it.each(["", "not-json", "null", "{}", '{"ok":false}'])("rejects missing or invalid grouped execution acknowledgement %s", async (output) => {
    execFile.mockImplementation((_command, _args, _options, callback) => {
      process.nextTick(() => callback(null, output, ""));
      return { stdout: new EventEmitter() };
    });
    await expect(executeSqlScript(
      { serverName: "target", databaseName: "db", authenticationType: "Windows" }, "SELECT 1"
    )).rejects.toThrow("Database outcome is uncertain");
  });

  it.each([
    "null\n", "{}\n", '{"key":"unexpected","ok":true}\n',
    '{"key":"PROCEDURE|dbo|ProcA","ok":"true"}\n',
    '{"key":"PROCEDURE|dbo|ProcA","ok":false,"error":null}\n',
    '{"key":"PROCEDURE|dbo|ProcA","ok":true}\n{"key":"PROCEDURE|dbo|ProcA","ok":true}\n',
  ])("rejects invalid structured execution results %s", async (output) => {
    execFile.mockImplementation((_command, _args, _options, callback) => {
      const stdout = new EventEmitter();
      process.nextTick(() => { stdout.emit("data", output); callback(null, "", ""); });
      return { stdout, kill: jest.fn() };
    });
    await expect(executeSqlScriptsIndividually(
      { serverName: "target", databaseName: "db", authenticationType: "Windows" },
      [{ key: "PROCEDURE|dbo|ProcA", sqlText: "SELECT 1" }]
    )).rejects.toThrow("Deployment status is uncertain");
  });

  it("rejects missing results even when PowerShell exits successfully", async () => {
    execFile.mockImplementation((_command, _args, _options, callback) => {
      process.nextTick(() => callback(null, "", ""));
      return { stdout: new EventEmitter() };
    });
    await expect(executeSqlScriptsIndividually(
      { serverName: "target", databaseName: "db", authenticationType: "Windows" },
      [{ key: "PROCEDURE|dbo|ProcA", sqlText: "SELECT 1" }]
    )).rejects.toThrow("Incomplete PowerShell execution output");
  });

  it("rejects malformed execution output without throwing from the stdout listener", async () => {
    const stdout = new EventEmitter();
    const kill = jest.fn();
    let complete;
    execFile.mockImplementation((_command, _args, _options, callback) => {
      complete = callback;
      return { stdout, kill };
    });

    const execution = executeSqlScriptsIndividually(
      {
        serverName: "dstServer",
        databaseName: "dstDb",
        authenticationType: "Windows",
      },
      [{ key: "PROCEDURE|dbo|ProcA", sqlText: "SELECT 1" }]
    );
    const rejection = expect(execution).rejects.toThrow("Invalid PowerShell execution output");

    expect(() => stdout.emit("data", "not-json\n")).not.toThrow();
    complete(new Error("Process terminated"), "", "");

    await rejection;
    expect(kill).toHaveBeenCalledTimes(1);
    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining("pebloy_uuid-1234.ps1"));
  });

  it("rejects truncated final output without throwing from the completion callback", async () => {
    const stdout = new EventEmitter();
    const kill = jest.fn();
    let complete;
    execFile.mockImplementation((_command, _args, _options, callback) => {
      complete = callback;
      return { stdout, kill };
    });

    const execution = executeSqlScriptsIndividually(
      { serverName: "dstServer", databaseName: "dstDb", authenticationType: "Windows" },
      [{ key: "PROCEDURE|dbo|ProcA", sqlText: "SELECT 1" }]
    );
    const rejection = expect(execution).rejects.toThrow("Deployment status is uncertain");

    stdout.emit("data", '{"key":"PROCEDURE|dbo|ProcA"');
    expect(() => complete(null, "", "")).not.toThrow();

    await rejection;
    expect(kill).not.toHaveBeenCalled();
    expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
  });

  it("rejects result-handler errors and ignores further output while stopping the child", async () => {
    const stdout = new EventEmitter();
    const kill = jest.fn();
    let complete;
    execFile.mockImplementation((_command, _args, _options, callback) => {
      complete = callback;
      return { stdout, kill };
    });
    const onResult = jest.fn(() => { throw new Error("Progress reporting failed"); });
    const execution = executeSqlScriptsIndividually(
      { serverName: "dstServer", databaseName: "dstDb", authenticationType: "Windows" },
      [{ key: "PROCEDURE|dbo|ProcA", sqlText: "SELECT 1" }],
      { onResult }
    );
    const rejection = expect(execution).rejects.toThrow("Progress reporting failed");
    const output = '{"key":"PROCEDURE|dbo|ProcA","ok":true,"error":null}\n';

    expect(() => stdout.emit("data", output + output)).not.toThrow();
    stdout.emit("data", output);
    complete(new Error("Process terminated"), "", "");

    await rejection;
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("preserves chunked results, CRLF boundaries, Unicode, and a final line without a newline", async () => {
    const expected = [
      { key: "PROCEDURE|dbo|ProcA", ok: true, error: null },
      { key: "PROCEDURE|dbo|ProcB", ok: false, error: "Detracci\u00f3n" },
    ];
    execFile.mockImplementation((_command, _args, _options, callback) => {
      const stdout = new EventEmitter();
      process.nextTick(() => {
        const first = JSON.stringify(expected[0]);
        stdout.emit("data", first.slice(0, 12));
        stdout.emit("data", first.slice(12) + "\r");
        stdout.emit("data", "\n\n" + JSON.stringify(expected[1]));
        callback(null, "", "");
      });
      return { stdout };
    });
    const onResult = jest.fn();

    const results = await executeSqlScriptsIndividually(
      { serverName: "dstServer", databaseName: "dstDb", authenticationType: "Windows" },
      expected.map(({ key }) => ({ key, sqlText: "SELECT 1" })),
      { continueOnError: true, onResult }
    );

    expect(results).toEqual(expected);
    expect(onResult.mock.calls).toEqual(expected.map((result) => [result]));
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

  it("forces UTF-8 PowerShell output for SQL query wrappers", async () => {
    execFile.mockImplementation((_command, _args, _options, callback) => {
      const stdout = new EventEmitter();
      const child = { stdout };

      process.nextTick(() => {
        callback(null, "[]", "");
      });

      return child;
    });

    await fetchObjectDefinitionMap(
      {
        serverName: "srcServer",
        databaseName: "srcDb",
        authenticationType: "Windows",
      },
      [{ objectType: "PROCEDURE", schemaName: "dbo", objectName: "ProcA" }]
    );

    const scriptText = fs.writeFileSync.mock.calls[0][1];

    expect(scriptText).toContain("$OutputEncoding = [System.Text.UTF8Encoding]::new($false)");
    expect(scriptText).toContain("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)");
  });

  it("builds first-hop dependency-list queries from selected root objects", async () => {
    execFile.mockImplementation((_command, _args, _options, callback) => {
      const stdout = new EventEmitter();
      const child = { stdout };

      process.nextTick(() => {
        callback(null, "[]", "");
      });

      return child;
    });

    await fetchObjectDependencies(
      {
        serverName: "srcServer",
        databaseName: "srcDb",
        authenticationType: "Windows",
      },
      [{ schemaName: "dbo", objectName: "ProcA" }],
      { dateWindow: { start: "2026-07-30T00:00:00.000Z", end: "2026-07-31T23:59:59.000Z" } }
    );

    const scriptText = fs.writeFileSync.mock.calls[0][1];
    const base64Query = scriptText.match(/FromBase64String\('([^']+)'\)/)?.[1];
    const decodedQuery = Buffer.from(base64Query, "base64").toString("utf8");

    expect(decodedQuery).toContain("sys.sql_expression_dependencies");
    expect(decodedQuery).toContain("sys.foreign_keys");
    expect(decodedQuery).not.toContain("RecursiveDependencies");
    expect(decodedQuery).not.toContain("MAXRECURSION");
    expect(decodedQuery).not.toContain("ObjectCatalog AS");
    expect(decodedQuery).toContain("#PebloyRoots");
    expect(decodedQuery).toContain("DependencyObjects AS");
    expect(decodedQuery).toContain("INNER JOIN sys.sql_expression_dependencies sed ON sed.referencing_id = root.objectId");
    expect(decodedQuery).toContain("INNER JOIN #PebloyEdges edge ON edge.sourceKey = root.catalogKey");
    expect(decodedQuery).toContain("parentObjectType");
    expect(decodedQuery).toContain("dep.modifiedDate >= CONVERT(datetime2");
    expect(decodedQuery).toContain("dep.modifiedDate <= CONVERT(datetime2");
    expect(decodedQuery).toContain("AS sortOrder");
    expect(decodedQuery).toContain("ORDER BY sortOrder, schemaName, objectName");
    // Roots and edges are materialized once instead of being recomputed per CTE reference.
    expect(decodedQuery).toContain("CREATE CLUSTERED INDEX IX_PebloyRoots");
    expect(decodedQuery).toContain("CREATE CLUSTERED INDEX IX_PebloyEdges");
    expect(decodedQuery).toContain("DROP TABLE #PebloyEdges;");
  });

  it("resolves schema-qualified names by id and only scans the catalog for unqualified input", () => {
    const qualified = buildResolveObjectTypesQuery([{ schemaName: "dbo", objectName: "ProcA" }]);
    const unqualified = buildResolveObjectTypesQuery([{ schemaName: "", objectName: "ProcA" }]);

    expect(qualified).toContain("OBJECT_ID(QUOTENAME(io.schemaName) + N'.' + QUOTENAME(io.objectName))");
    expect(qualified).not.toContain("ObjectCatalog");
    expect(qualified).not.toContain("sys.tables");
    expect(unqualified).toContain("ObjectCatalog AS");
    expect(unqualified).toContain("LOWER(oc.objectName) = LOWER(io.objectName)");
    expect(unqualified).toContain("NULLIF(LTRIM(RTRIM(io.schemaName)), '') IS NULL");
    for (const query of [qualified, unqualified]) {
      expect(query).toContain("N'NotFound'");
      expect(query).toContain("N'Ambiguous'");
      expect(query).toContain("ORDER BY io.inputRow;");
      expect(query).toContain("DROP TABLE #PebloyResolveInputs;");
    }
  });

  it("resolves schema-qualified roots by id without scanning the object catalog", () => {
    const query = buildObjectDependenciesQuery([
      { schemaName: "dbo", objectName: "ProcA" },
      { schemaName: "Reports", objectName: "ViewB" },
    ]);

    expect(query).toContain("OBJECT_ID(QUOTENAME(io.schemaName) + N'.' + QUOTENAME(io.objectName))");
    expect(query).toContain("TYPE_ID(QUOTENAME(io.schemaName) + N'.' + QUOTENAME(io.objectName))");
    expect(query).not.toContain("LOWER(o.name)");
    expect(query).not.toContain("LOWER(ty.name)");
  });

  it("falls back to a name match only when input has no schema", () => {
    const query = buildObjectDependenciesQuery([{ schemaName: "", objectName: "LooseName" }]);
    expect(query).toContain("LOWER(o.name) = LOWER(io.objectName)");
  });

  it("batches large selections into valid VALUES inserts", () => {
    const objects = Array.from({ length: 2500 }, (_unused, index) => ({ schemaName: "dbo", objectName: `Obj${index}` }));
    const query = buildObjectDependenciesQuery(objects);
    const inserts = query.match(/INSERT INTO #PebloyInputs \(schemaName, objectName\) VALUES/g) || [];

    expect(inserts).toHaveLength(3);
    for (const block of query.split("INSERT INTO #PebloyInputs (schemaName, objectName) VALUES").slice(1)) {
      expect((block.split(";")[0].match(/\(N'dbo', N'Obj\d+'\)/g) || []).length).toBeLessThanOrEqual(1000);
    }
  });

  it("builds dependency-edge queries for selected-object deployment ordering", async () => {
    execFile.mockImplementation((_command, _args, _options, callback) => {
      const stdout = new EventEmitter();
      const child = { stdout };

      process.nextTick(() => {
        callback(null, "[]", "");
      });

      return child;
    });

    await fetchObjectDependencyEdges(
      {
        serverName: "srcServer",
        databaseName: "srcDb",
        authenticationType: "Windows",
      },
      [
        { schemaName: "dbo", objectName: "ViewA" },
        { schemaName: "dbo", objectName: "ViewBase" },
      ]
    );

    const scriptText = fs.writeFileSync.mock.calls[0][1];
    const base64Query = scriptText.match(/FromBase64String\('([^']+)'\)/)?.[1];
    const decodedQuery = Buffer.from(base64Query, "base64").toString("utf8");

    expect(decodedQuery).toContain("#PebloySelected");
    expect(decodedQuery).toContain("dependencyObjectType");
    expect(decodedQuery).toContain("dep.catalogKey = edge.dependencyKey");
    // Edges must be restricted to the selection instead of the whole database.
    expect(decodedQuery).toContain("INNER JOIN #PebloySelected s ON s.objectId = sed.referencing_id");
    expect(decodedQuery).toContain("INNER JOIN #PebloySelected s ON s.objectId = c.object_id");
    expect(decodedQuery).toContain("VIEW DEFINITION");
    expect(decodedQuery).toContain("sys.parameters parameter ON parameter.object_id = s.objectId");
    expect(decodedQuery).toContain("childObject.parent_object_id = s.objectId");
    expect(decodedQuery).toContain("triggerObject.parent_class = 1");
    expect(decodedQuery).toContain("selected SET objectId = tableType.type_table_object_id");
    expect(decodedQuery).not.toContain("ObjectCatalog");
  });

  it("uses one explicit collation for every UDT signature UNION branch without truncating definitions", async () => {
    const detail = "CHECK_DEFINITION_" + "x".repeat(600);
    execFile.mockImplementation((_command, _args, _options, callback) => {
      process.nextTick(() => callback(null, JSON.stringify([
        { part: "TYPE", schemaName: "finance", objectName: "OverPaymentUsedType", ordinal: 0, detail: "table" },
        { part: "CHECK", schemaName: "finance", objectName: "OverPaymentUsedType", ordinal: 0, detail },
      ]), ""));
      return { stdout: new EventEmitter() };
    });
    const result = await fetchTypeSignatureMap({ serverName: "offline", databaseName: "fixture", authenticationType: "Windows" }, [
      { objectType: "USER_DEFINED_TYPE", schemaName: "finance", objectName: "OverPaymentUsedType" },
    ]);
    const scriptText = fs.writeFileSync.mock.calls[0][1];
    const query = Buffer.from(scriptText.match(/FromBase64String\('([^']+)'\)/)[1], "base64").toString("utf8");
    expect(query.match(/COLLATE DATABASE_DEFAULT AS detail/g)).toHaveLength(4);
    expect(query).toContain("User-defined type comparison requires VIEW DEFINITION on both databases.");
    expect(query).toContain("ch.definition COLLATE DATABASE_DEFAULT");
    expect(query).toContain("cc.definition, N'') COLLATE DATABASE_DEFAULT");
    expect(query).toContain("dc.definition, N'') COLLATE DATABASE_DEFAULT");
    expect(query).not.toContain("nvarchar(400)");
    expect(result.get("USER_DEFINED_TYPE|finance|overpaymentusedtype")).toContain(detail);
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
    // Authored comments above CREATE are part of the module and must survive.
    expect(result.get("PROCEDURE|dbo|ProcA").definition).toBe(
      "-- authored preamble\nCREATE PROCEDURE dbo.ProcA AS SELECT 1"
    );
  });

  it.each([
    ["CREATE OR ALTER PROCEDURE dbo.ProcA AS SELECT 1", "CREATE PROCEDURE dbo.ProcA AS SELECT 1"],
    ["/*\nCREATE OR ALTER PROCEDURE dbo.Example\n*/\nCREATE OR ALTER PROCEDURE dbo.ProcA AS SELECT N'\nCREATE OR ALTER PROCEDURE dbo.Literal'", "/*\nCREATE OR ALTER PROCEDURE dbo.Example\n*/\nCREATE PROCEDURE dbo.ProcA AS SELECT N'\nCREATE OR ALTER PROCEDURE dbo.Literal'"],
  ])("canonicalizes only the actual module declaration", async (definition, expected) => {
    execFile.mockImplementation((_command, _args, _options, callback) => {
      const stdout = new EventEmitter();
      const child = { stdout };

      process.nextTick(() => {
        callback(null, JSON.stringify([
          {
            objectType: "PROCEDURE",
            schemaName: "dbo",
            objectName: "ProcA",
            definition,
            usesAnsiNulls: 1,
            usesQuotedIdentifier: 1,
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

    expect(result.get("PROCEDURE|dbo|ProcA").definition).toBe(expected);
  });
});