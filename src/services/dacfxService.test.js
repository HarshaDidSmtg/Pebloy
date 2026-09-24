const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const childProcess = require("child_process");

const { validateGeneratedArtifacts } = require("./dacfxService");

describe("DacFx process limits", () => {
  let child;
  let service;
  beforeEach(() => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = jest.fn();
    child.stdin.end = jest.fn();
    child.kill = jest.fn(() => child.emit("close", 1));
    jest.spyOn(childProcess, "spawn").mockReturnValue(child);
    jest.isolateModules(() => { service = require("./dacfxService"); });
  });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it("quotes connection-string values instead of allowing embedded properties", () => {
    const result = service.buildConnectionString({ serverName: "server", databaseName: "db;Other=value", authenticationType: "Sql", username: "user", password: 'quote";secret' });
    expect(result).toContain('Data Source="tcp:server"');
    expect(result).toContain('Initial Catalog="db;Other=value"');
    expect(result).toContain('Password="quote"";secret"');
  });

  it("terminates a timed-out comparison", async () => {
    jest.useFakeTimers();
    const comparison = service.compareGeneratedArtifacts({ taskId: "test", sourceScripts: [], destinationProfile: {} });
    const assertion = expect(comparison).rejects.toThrow("timed out");
    jest.advanceTimersByTime(30000);
    await assertion;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("terminates a worker that exceeds its output budget", async () => {
    const validation = service.validateGeneratedArtifacts({ taskId: "test", scripts: [] });
    const assertion = expect(validation).rejects.toThrow("exceeded 20 MB");
    child.stdout.emit("data", Buffer.alloc(20 * 1024 * 1024 + 1));
    await assertion;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

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