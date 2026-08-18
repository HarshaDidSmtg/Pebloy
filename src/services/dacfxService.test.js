const fs = require("fs");
const os = require("os");
const path = require("path");

const { validateGeneratedArtifacts } = require("./dacfxService");

describe("dacfxService worker ordering", () => {
  jest.setTimeout(120000);

  it("compiles a non-dbo alias type before its dependent table", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-dacfx-order-"));

    try {
      const tablePath = path.join(tempDir, "tbl_identical.sql");
      const typePath = path.join(tempDir, "tt_identical.sql");

      fs.writeFileSync(
        tablePath,
        "CREATE TABLE [bdeploy_test].[tbl_identical] ([value] [bdeploy_test].[tt_identical] NOT NULL);",
        "utf8"
      );
      fs.writeFileSync(
        typePath,
        "CREATE TYPE [bdeploy_test].[tt_identical] FROM NVARCHAR(20) NOT NULL;",
        "utf8"
      );

      const result = await validateGeneratedArtifacts({
        taskId: "dacfx-ordering-regression",
        scripts: [
          {
            objectType: "TABLE",
            schemaName: "bdeploy_test",
            objectName: "tbl_identical",
            scriptPath: tablePath,
          },
          {
            objectType: "USER_DEFINED_TYPE",
            schemaName: "bdeploy_test",
            objectName: "tt_identical",
            scriptPath: typePath,
          },
        ],
      });

      expect(result.objectCount).toBe(2);
      expect(result.warnings).toEqual([]);
      expect(result.objects).toEqual([
        expect.objectContaining({
          objectType: "USER_DEFINED_TYPE",
          schemaName: "bdeploy_test",
          objectName: "tt_identical",
        }),
        expect.objectContaining({
          objectType: "TABLE",
          schemaName: "bdeploy_test",
          objectName: "tbl_identical",
        }),
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});