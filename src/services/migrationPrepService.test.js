const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("./sqlService", () => ({ fetchObjectProtectionMetadata: jest.fn() }));
const { fetchObjectProtectionMetadata } = require("./sqlService");
const { buildMigrationPrep } = require("./migrationPrepService");

const profile = { serverName: "host", databaseName: "TargetDb" };
let outputDir;

beforeEach(() => {
  jest.clearAllMocks();
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-prep-"));
});
afterEach(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("captures permissions, ownership, signatures, sequence state, and dependents", async () => {
  fetchObjectProtectionMetadata.mockResolvedValue([
    { kind: "Permission", schemaName: "dbo", objectName: "vw_Secure", detail1: "SELECT", detail2: "GRANT", detail3: "ReportReader" },
    { kind: "Permission", schemaName: "dbo", objectName: "vw_Secure", detail1: "UPDATE", detail2: "DENY", detail3: "Temp" },
    { kind: "Owner", schemaName: "dbo", objectName: "vw_Secure", detail1: "dbo", detail2: null, detail3: null },
    { kind: "Signature", schemaName: "dbo", objectName: "vw_Secure", detail1: "AABB", detail2: "SIGNATURE BY CERTIFICATE", detail3: null },
    { kind: "SequenceState", schemaName: "dbo", objectName: "seq_Id", detail1: "4207", detail2: "1", detail3: "1" },
    { kind: "Dependent", schemaName: "dbo", objectName: "vw_Secure", detail1: "Reports", detail2: "usp_Daily", detail3: "SQL_STORED_PROCEDURE" },
  ]);

  const result = await buildMigrationPrep(profile, [
    { objectType: "VIEW", schemaName: "dbo", objectName: "vw_Secure" },
    { objectType: "SEQUENCE", schemaName: "dbo", objectName: "seq_Id" },
    { objectType: "VIEW", schemaName: "dbo", objectName: "vw_Plain" },
  ], { outputDir, taskId: "t1" });

  const script = fs.readFileSync(result.outputPath, "utf8");
  expect(result.executed).toBe(false);
  expect(script).toContain("GRANT SELECT ON OBJECT::[dbo].[vw_Secure] TO [ReportReader];");
  expect(script).toContain("DENY UPDATE ON OBJECT::[dbo].[vw_Secure] TO [Temp];");
  expect(script).toContain("ALTER AUTHORIZATION ON OBJECT::[dbo].[vw_Secure] TO [dbo];");
  expect(script).toContain("ALTER SEQUENCE [dbo].[seq_Id] RESTART WITH 4207;");
  expect(script).toContain("Reports.usp_Daily");
  expect(script).toContain("did not and will not execute");
  expect(script).toContain("-- No protected metadata found for this object.");
});

test("escapes bracketed identifiers", async () => {
  fetchObjectProtectionMetadata.mockResolvedValue([
    { kind: "Owner", schemaName: "dbo", objectName: "od]d", detail1: "dbo" },
  ]);
  const result = await buildMigrationPrep(profile, [{ objectType: "VIEW", schemaName: "dbo", objectName: "od]d" }], { outputDir });
  expect(fs.readFileSync(result.outputPath, "utf8")).toContain("[dbo].[od]]d]");
});
