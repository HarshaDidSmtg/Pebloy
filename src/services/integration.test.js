const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { execFile } = require("child_process");

const {
  testConnection,
  discoverObjects,
  resolveObjectTypes,
  fetchObjectDefinitionMap,
} = require("./sqlService");
const { runBackup } = require("./backupService");
const { compareObjects } = require("./diffService");
const { runDeployment } = require("./deploymentService");

jest.setTimeout(240000);

const profilesPath = path.resolve(__dirname, "../../data/profiles.json");
const devFixturePath = path.resolve(__dirname, "../../test-output/setup-dev.sql");
const sliceFixturePath = path.resolve(__dirname, "../../test-output/setup-slice.sql");
const integrationOutputRoot = path.resolve(__dirname, "../../artifacts/exports/integration-tests");

function loadProfileByEnvironmentTag(environmentTag) {
  const profiles = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
  const profile = profiles.find((item) => String(item.environmentTag || "").toUpperCase() === environmentTag);
  if (!profile) {
    throw new Error(`Profile not found for environment tag ${environmentTag}.`);
  }
  return profile;
}

function splitSqlBatches(sqlText) {
  return String(sqlText || "")
    .split(/^\s*GO\s*$/gim)
    .map((batch) => batch.trim())
    .filter(Boolean);
}

async function executeSqlBatches(profile, sqlText) {
  const batches = splitSqlBatches(sqlText);
  const tempScriptPath = path.join(os.tmpdir(), `bdeploy_fixture_${randomUUID()}.ps1`);
  const payload = Buffer.from(
    JSON.stringify({
      profile,
      batches,
    }),
    "utf8"
  ).toString("base64");

  const psScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Data
$payload = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$profile = $payload.profile
$batches = @($payload.batches)
$connection = $null

try {
  $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
  $builder['Data Source'] = "tcp:$($profile.serverName)"
  $builder['Initial Catalog'] = $profile.databaseName
  $builder['TrustServerCertificate'] = $true
  $builder['Encrypt'] = $false
  $builder['Connect Timeout'] = 10
  $builder['Application Name'] = 'BDeployIntegrationTests'

  if ([string]::Equals([string]$profile.authenticationType, 'Windows', [System.StringComparison]::OrdinalIgnoreCase)) {
    $builder['Integrated Security'] = $true
  } else {
    $builder['Integrated Security'] = $false
    $builder['User ID'] = $profile.username
    $builder['Password'] = $profile.password
  }

  $connection = New-Object System.Data.SqlClient.SqlConnection($builder.ConnectionString)
  $connection.Open()

  foreach ($batch in $batches) {
    $text = [string]$batch
    if ([string]::IsNullOrWhiteSpace($text)) {
      continue
    }

    $command = $connection.CreateCommand()
    $command.CommandText = $text
    $command.CommandTimeout = 120
    [void]$command.ExecuteNonQuery()
    $command.Dispose()
  }
} finally {
  if ($null -ne $connection) {
    $connection.Close()
    $connection.Dispose()
  }
}
`;

  fs.writeFileSync(tempScriptPath, psScript, "utf8");

  try {
    await new Promise((resolve, reject) => {
      execFile(
        "pwsh",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tempScriptPath],
        {
          encoding: "utf8",
          timeout: 300000,
          maxBuffer: 1024 * 1024 * 10,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(String(stderr || stdout || error.message).trim() || "Fixture execution failed."));
            return;
          }
          resolve();
        }
      );
    });
  } finally {
    try {
      fs.unlinkSync(tempScriptPath);
    } catch (_error) {
      // Ignore temp file cleanup failures in tests.
    }
  }
}

async function applyFixture(profile, fixturePath) {
  const scriptText = fs.readFileSync(fixturePath, "utf8");
  await executeSqlBatches(profile, scriptText);
}

function artifactPath(name) {
  return path.join(integrationOutputRoot, name);
}

function getDefinition(map, objectType, schemaName, objectName) {
  return map.get(`${objectType}|${schemaName}|${objectName}`)?.definition || "";
}

describe("Integration: seeded database workflows", () => {
  let devProfile;
  let sliceProfile;

  beforeAll(async () => {
    devProfile = loadProfileByEnvironmentTag("DEV");
    sliceProfile = loadProfileByEnvironmentTag("INT");

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
