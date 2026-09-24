const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const {
  testConnection,
  discoverObjects,
  resolveObjectTypes,
  fetchObjectDefinitionMap,
  executeSqlScript,
  executeSqlScriptsIndividually,
} = require("./sqlService");
const { runBackup } = require("./backupService");
const { compareObjects } = require("./diffService");
const { runDeployment } = require("./deploymentService");

jest.setTimeout(240000);

const profilesPath = path.resolve(__dirname, "../../data/profiles.json");
const devFixturePath = path.resolve(__dirname, "../../tests/fixtures/setup-dev.sql");
const sliceFixturePath = path.resolve(__dirname, "../../tests/fixtures/setup-slice.sql");
const integrationOutputRoot = path.resolve(__dirname, "../../artifacts/exports/integration-tests");

function loadProfileByEnvironmentTag(environmentTag) {
  const profiles = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
  const profile = profiles.find((item) => String(item.environmentTag || "").toUpperCase() === environmentTag);
  if (!profile) {
    throw new Error(`Profile not found for environment tag ${environmentTag}.`);
  }
  return profile;
}

async function applyFixture(profile, fixturePath) {
  const scriptText = fs.readFileSync(fixturePath, "utf8");
  await executeSqlScript(profile, scriptText, { atomic: true });
}

function artifactPath(name) {
  return path.join(integrationOutputRoot, name);
}

function getDefinition(map, objectType, schemaName, objectName) {
  return map.get(`${objectType}|${schemaName}|${objectName}`)?.definition || "";
}

function hasProfile(tag) {
  try {
    const profiles = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
    return profiles.some((p) => String(p.environmentTag || "").toUpperCase() === tag);
  } catch { return false; }
}

function isIntegrationEnabled(environment, profileExists) {
  return environment.PEBLOY_RUN_SQL_INTEGRATION === "1" && profileExists("DEV") && profileExists("INT");
}

function assertDisposableDatabasePair(identities) {
  if (identities.length !== 2 || identities.some((identity) =>
    !identity || typeof identity.serverName !== "string" || !identity.serverName.trim() ||
    typeof identity.databaseName !== "string" || !/_PebloyTest$/i.test(identity.databaseName))) {
    throw new Error("Live tests require two resolved disposable databases named with the _PebloyTest suffix.");
  }
  const keys = identities.map((identity) => JSON.stringify([identity.serverName.toLowerCase(), identity.databaseName.toLowerCase()]));
  if (keys[0] === keys[1]) throw new Error("Live tests require two distinct databases.");
}

describe("Live SQL integration safety", () => {
  test("requires disposable, distinct, resolved database identities", () => {
    const source = { serverName: "host", databaseName: "Source_PebloyTest" };
    const target = { serverName: "host", databaseName: "Target_PebloyTest" };
    expect(() => assertDisposableDatabasePair([source, target])).not.toThrow();
    expect(() => assertDisposableDatabasePair([source, { databaseName: "SOURCE_PEBLOYTEST", serverName: "HOST", extra: "ignored" }])).toThrow("distinct");
    for (const invalid of [null, {}, { databaseName: "Target_PebloyTest" }, { ...target, databaseName: "SharedDevelopment" }]) {
      expect(() => assertDisposableDatabasePair([source, invalid])).toThrow("disposable");
    }
  });
  test("tracked fixtures begin with a disposable-database guard", () => {
    for (const fixturePath of [devFixturePath, sliceFixturePath]) {
      const script = fs.readFileSync(fixturePath, "utf8");
      expect(script.replace(/\r\n/g, "\n").startsWith("IF DB_NAME() NOT LIKE N'%[_]PebloyTest'\n    THROW")).toBe(true);
    }
  });
  test.each([
    [undefined, ["DEV", "INT"], false],
    ["0", ["DEV", "INT"], false],
    ["true", ["DEV", "INT"], false],
    ["1", ["DEV"], false],
    ["1", ["DEV", "INT"], true],
  ])("opt-in %s with profiles %j enables live tests: %s", (flag, profiles, expected) => {
    const profileExists = jest.fn((tag) => profiles.includes(tag));

    expect(isIntegrationEnabled({ PEBLOY_RUN_SQL_INTEGRATION: flag }, profileExists)).toBe(expected);
    if (flag !== "1") {
      expect(profileExists).not.toHaveBeenCalled();
    }
  });
});

const describeIntegration = isIntegrationEnabled(process.env, hasProfile) ? describe : describe.skip;

describeIntegration("Integration: seeded database workflows", () => {
  let devProfile;
  let sliceProfile;

  beforeAll(async () => {
    devProfile = loadProfileByEnvironmentTag("DEV");
    sliceProfile = loadProfileByEnvironmentTag("INT");

    assertDisposableDatabasePair([devProfile, sliceProfile]);
    const { getProfileWithSecret } = require("./profileService");
    devProfile = getProfileWithSecret(devProfile.id);
    sliceProfile = getProfileWithSecret(sliceProfile.id);
    const identities = await Promise.all([testConnection(devProfile), testConnection(sliceProfile)]);
    assertDisposableDatabasePair(identities);
    for (const [index, profile] of [devProfile, sliceProfile].entries()) {
      if (identities[index].databaseName.toLowerCase() !== profile.databaseName.toLowerCase()) throw new Error("Resolved database differs from the configured disposable test database.");
    }

    await applyFixture(devProfile, devFixturePath);
    await applyFixture(sliceProfile, sliceFixturePath);
  });

  test("database connections succeed for DEV and SLICE", async () => {
    const [devConnection, sliceConnection] = await Promise.all([
      testConnection(devProfile),
      testConnection(sliceProfile),
    ]);

    expect(devConnection).toBeTruthy();
    expect(devConnection.serverName).toBeTruthy();
    expect(String(devConnection.databaseName).toUpperCase()).toBe(String(devProfile.databaseName).toUpperCase());

    expect(sliceConnection).toBeTruthy();
    expect(sliceConnection.serverName).toBeTruthy();
    expect(String(sliceConnection.databaseName).toUpperCase()).toBe(String(sliceProfile.databaseName).toUpperCase());
  });

  test("resolveObjectTypes returns actual database object types", async () => {
    const resolved = await resolveObjectTypes(devProfile, [
      { schemaName: "bdeploy_test", objectName: "tbl_modified" },
      { schemaName: "bdeploy_test", objectName: "vw_modified" },
      { schemaName: "bdeploy_test", objectName: "fn_modified" },
      { schemaName: "bdeploy_test", objectName: "usp_modified" },
      { schemaName: "bdeploy_test", objectName: "syn_test" },
      { schemaName: "bdeploy_test", objectName: "seq_modified" },
      { schemaName: "bdeploy_test", objectName: "tt_identical" },
    ]);

    const byName = new Map(resolved.map((item) => [`${item.schemaName}.${item.objectName}`, item.objectType]));

    expect(byName.get("bdeploy_test.tbl_modified")).toBe("TABLE");
    expect(byName.get("bdeploy_test.vw_modified")).toBe("VIEW");
    expect(byName.get("bdeploy_test.fn_modified")).toBe("FUNCTION");
    expect(byName.get("bdeploy_test.usp_modified")).toBe("PROCEDURE");
    expect(byName.get("bdeploy_test.syn_test")).toBe("SYNONYM");
    expect(byName.get("bdeploy_test.seq_modified")).toBe("SEQUENCE");
    expect(byName.get("bdeploy_test.tt_identical")).toBe("USER_DEFINED_TYPE");
  });

  test("discoverObjects returns seeded objects and respects filters", async () => {
    const modifiedObjects = await discoverObjects(devProfile, {
      schema: "bdeploy_test",
      search: "modified",
    });
    const tables = await discoverObjects(devProfile, {
      schema: "bdeploy_test",
      type: "TABLE",
    });

    expect(modifiedObjects.length).toBeGreaterThanOrEqual(4);
    expect(modifiedObjects.every((item) => item.schemaName === "bdeploy_test")).toBe(true);
    expect(modifiedObjects.some((item) => item.objectType === "TABLE" && item.objectName === "tbl_modified")).toBe(true);
    expect(modifiedObjects.some((item) => item.objectType === "VIEW" && item.objectName === "vw_modified")).toBe(true);
    expect(modifiedObjects.some((item) => item.objectType === "FUNCTION" && item.objectName === "fn_modified")).toBe(true);
    expect(modifiedObjects.some((item) => item.objectType === "PROCEDURE" && item.objectName === "usp_modified")).toBe(true);

    expect(tables.length).toBeGreaterThanOrEqual(4);
    expect(tables.every((item) => item.objectType === "TABLE")).toBe(true);
  });

  test("backup mode generates scripts from seeded objects", async () => {
    const selectedObjects = [
      { objectType: "TABLE", schemaName: "bdeploy_test", objectName: "tbl_modified" },
      { objectType: "VIEW", schemaName: "bdeploy_test", objectName: "vw_modified" },
      { objectType: "PROCEDURE", schemaName: "bdeploy_test", objectName: "usp_modified" },
    ];

    const result = await runBackup(
      devProfile,
      selectedObjects,
      { destinationPath: artifactPath("backup") },
      { taskId: `integration-backup-${randomUUID()}` }
    );

    expect(result.backupMode).toBe("ObjectScriptGenerationOnly");
    expect(result.objectCount).toBe(selectedObjects.length);
    expect(fs.existsSync(result.generatedRoot)).toBe(true);
    expect(fs.existsSync(result.buildPathFile)).toBe(true);
    expect(result.generationWarnings || []).toEqual([]);

    const procedurePath = path.join(result.generatedRoot, "bdeploy_test", "Stored Procedures", "usp_modified.sql");
    expect(fs.existsSync(procedurePath)).toBe(true);
    const procedureText = fs.readFileSync(procedurePath, "utf8").trim();
    expect(procedureText).toMatch(/^(?:CREATE|ALTER)\s+(?:PROCEDURE|PROC)\b/i);
    expect(procedureText).not.toMatch(/^\s*SET\s+(?:ANSI_NULLS|QUOTED_IDENTIFIER)\b/i);
    expect(procedureText).not.toMatch(/^\s*CREATE\s+OR\s+ALTER\b/i);

    const combinedStoredProcedurePath = fs
      .readdirSync(result.generatedRoot)
      .filter((name) => /^AllStoredProcedures_\d{8}_\d{6}\.sql$/i.test(name))
      .sort()
      .map((name) => path.join(result.generatedRoot, name))
      .pop();

    expect(combinedStoredProcedurePath).toBeTruthy();
    expect(fs.readFileSync(combinedStoredProcedurePath, "utf8")).toContain("CREATE OR ALTER PROCEDURE");
  });

  test("codediff regenerates scripts and detects changed plus unchanged objects", async () => {
    const selectedObjects = [
      { objectType: "TABLE", schemaName: "bdeploy_test", objectName: "tbl_identical" },
      { objectType: "TABLE", schemaName: "bdeploy_test", objectName: "tbl_modified" },
      { objectType: "FUNCTION", schemaName: "bdeploy_test", objectName: "fn_modified" },
      { objectType: "PROCEDURE", schemaName: "bdeploy_test", objectName: "usp_modified" },
    ];

    const result = await compareObjects(devProfile, sliceProfile, selectedObjects, {
      taskId: `integration-diff-${randomUUID()}`,
    });

    expect(result.summary.changed).toBeGreaterThanOrEqual(3);
    expect(result.summary.unchanged).toBeGreaterThanOrEqual(1);
    expect(result.details.some((item) => item.objectName === "tbl_modified" && item.status === "Changed")).toBe(true);
    expect(result.details.some((item) => item.objectName === "tbl_identical" && item.status === "Unchanged")).toBe(true);
  });

  test("deploy rollback validates table delta without persisting changes", async () => {
    const selectedObjects = [
      { objectType: "TABLE", schemaName: "bdeploy_test", objectName: "tbl_modified" },
    ];
    const beforeMap = await fetchObjectDefinitionMap(sliceProfile, selectedObjects);

    const result = await runDeployment({
      sourceProfile: devProfile,
      destinationProfile: sliceProfile,
      selectedObjects,
      mode: "Rollback",
      continueOnError: false,
      options: { scriptOutputPath: artifactPath("deploy-rollback") },
      task: { taskId: `integration-deploy-rollback-${randomUUID()}` },
      logEvent: () => {},
    });

    const afterMap = await fetchObjectDefinitionMap(sliceProfile, selectedObjects);
    expect(result.rollbackApplied).toBe(true);
    expect(result.results[0].status).toBe("RolledBack");
    expect(getDefinition(afterMap, "TABLE", "bdeploy_test", "tbl_modified")).toBe(
      getDefinition(beforeMap, "TABLE", "bdeploy_test", "tbl_modified")
    );
    await executeSqlScript(sliceProfile, "IF (SELECT COUNT(*) FROM bdeploy_test.tbl_modified WHERE id = 1) <> 1 THROW 51000, 'Rollback changed fixture data.', 1;");
  });

  test("atomic execution rolls back earlier batches when a later batch fails", async () => {
    await expect(executeSqlScript(sliceProfile,
      "ALTER TABLE bdeploy_test.tbl_modified ADD AtomicProbe INT NULL;\nGO\nUPDATE bdeploy_test.tbl_modified SET id = 2; THROW 51000, 'Expected atomic fixture failure.', 1;",
      { atomic: true }
    )).rejects.toThrow("Expected atomic fixture failure");
    await executeSqlScript(sliceProfile, "IF COL_LENGTH(N'bdeploy_test.tbl_modified', N'AtomicProbe') IS NOT NULL THROW 51000, 'DDL survived failed transaction.', 1; IF (SELECT COUNT(*) FROM bdeploy_test.tbl_modified WHERE id = 1) <> 1 THROW 51000, 'Data survived failed transaction.', 1;");
  });

  test("independent execution rolls back a failed object before continuing", async () => {
    const results = await executeSqlScriptsIndividually(sliceProfile, [
      { key: "failed", sqlText: "UPDATE bdeploy_test.tbl_modified SET id = 2; THROW 51000, 'Expected object failure.', 1;" },
      { key: "verify", sqlText: "IF (SELECT COUNT(*) FROM bdeploy_test.tbl_modified WHERE id = 1) <> 1 THROW 51000, 'Failed object changes were not rolled back.', 1;" },
    ], { continueOnError: true });
    expect(results).toEqual([expect.objectContaining({ key: "failed", ok: false }), expect.objectContaining({ key: "verify", ok: true })]);
  });

  test("format-and-execute applies source modules without modifying table data", async () => {
    try {
      const result = await runDeployment({ sourceProfile: devProfile, destinationProfile: devProfile,
        selectedObjects: [{ objectType: "PROCEDURE", schemaName: "bdeploy_test", objectName: "usp_modified" }, { objectType: "TABLE", schemaName: "bdeploy_test", objectName: "tbl_modified" }],
        mode: "FormatAndExecuteSource", continueOnError: false,
        options: { confirmedSourceDatabase: devProfile.databaseName, scriptOutputPath: artifactPath("format-execute") },
        task: { taskId: `integration-format-execute-${randomUUID()}` }, logEvent: () => {},
      });
      expect(result.results.find((item) => item.objectType === "PROCEDURE").status).toBe("Success");
      expect(result.results.find((item) => item.objectType === "TABLE")).toMatchObject({ status: "Skipped", action: "NoStoredModuleText" });
      await executeSqlScript(devProfile, "IF (SELECT COUNT(*) FROM bdeploy_test.tbl_modified WHERE id = 1 AND description = N'preserve this row') <> 1 THROW 51000, 'Format execution changed table data.', 1;");
    } finally { await applyFixture(devProfile, devFixturePath); }
  });

  test("deploy mode executes combined stored procedure script against target", async () => {
    const selectedObjects = [
      { objectType: "PROCEDURE", schemaName: "bdeploy_test", objectName: "usp_modified" },
    ];
    const beforeMap = await fetchObjectDefinitionMap(sliceProfile, selectedObjects);

    expect(getDefinition(beforeMap, "PROCEDURE", "bdeploy_test", "usp_modified")).not.toContain("verbose mode");

    try {
      const result = await runDeployment({
        sourceProfile: devProfile,
        destinationProfile: sliceProfile,
        selectedObjects,
        mode: "ExecuteDirectly",
        continueOnError: false,
        options: { scriptOutputPath: artifactPath("deploy-direct") },
        task: { taskId: `integration-deploy-direct-${randomUUID()}` },
        logEvent: () => {},
      });

      const afterMap = await fetchObjectDefinitionMap(sliceProfile, selectedObjects);
      expect(result.results[0].status).toBe("Success");
      expect(getDefinition(afterMap, "PROCEDURE", "bdeploy_test", "usp_modified")).toContain("verbose mode");
    } finally {
      await applyFixture(sliceProfile, sliceFixturePath);
    }
  });
});
