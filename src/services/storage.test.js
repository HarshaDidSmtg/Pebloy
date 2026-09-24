const fs = require("fs");
const os = require("os");
const path = require("path");
const { readJson, writeJson, writeJsonAtomic, readRecoverableJson, writeRecoverableJson } = require("./storage");

describe("atomic JSON persistence", () => {
  let directory;
  let filePath;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-storage-"));
    filePath = path.join(directory, "state.json");
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("shared saves atomically replace valid JSON without using a fixed temp path", () => {
    fs.writeFileSync(`${filePath}.tmp`, "unrelated pending write");
    writeJson(filePath, { version: 1 });
    writeJsonAtomic(filePath, { version: 2 });
    expect(readJson(filePath, {})).toEqual({ version: 2 });
    expect(fs.readFileSync(`${filePath}.tmp`, "utf8")).toBe("unrelated pending write");
    expect(fs.readdirSync(directory).sort()).toEqual(["state.json", "state.json.tmp"]);
  });

  test("a failed replacement preserves the previous state and cleans its temp file", () => {
    writeJson(filePath, { version: 1 });
    jest.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("Access denied"); });
    expect(() => writeJson(filePath, { version: 2 })).toThrow("Access denied");
    expect(readJson(filePath, {})).toEqual({ version: 1 });
    expect(fs.readdirSync(directory)).toEqual(["state.json"]);
  });

  test("flushes file contents before replacing the target", () => {
    const flush = jest.spyOn(fs, "fsyncSync");
    const rename = jest.spyOn(fs, "renameSync");
    writeJson(filePath, { version: 1 });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(rename.mock.invocationCallOrder[0]);
  });

  test("recovers preferences from a valid snapshot while preserving corrupt evidence", () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    writeRecoverableJson(filePath, { version: 1 });
    writeRecoverableJson(filePath, { version: 2 });
    fs.writeFileSync(filePath, "{broken");
    expect(readRecoverableJson(filePath, {})).toEqual({ version: 1 });
    const corrupt = fs.readdirSync(directory).find((name) => name.endsWith(".corrupt"));
    expect(fs.readFileSync(path.join(directory, corrupt), "utf8")).toBe("{broken");
    expect(warning).toHaveBeenCalled();
  });

  test("never overwrites corrupt preferences when both copies are invalid", () => {
    fs.writeFileSync(filePath, "{broken");
    fs.writeFileSync(`${filePath}.last-good`, "[]");
    expect(() => readRecoverableJson(filePath, {})).toThrow("no valid recovery copy");
    expect(() => writeRecoverableJson(filePath, {})).toThrow();
    expect(fs.readFileSync(filePath, "utf8")).toBe("{broken");
  });

  test("an explicit factory reset removes preference recovery copies", () => {
    const previousDataDir = process.env.DATA_DIR;
    const previousArtifactsDir = process.env.ARTIFACTS_DIR;
    process.env.DATA_DIR = directory;
    process.env.ARTIFACTS_DIR = path.join(directory, "artifacts");
    try {
      for (const name of ["settings", "app-state"]) {
        writeRecoverableJson(path.join(directory, `${name}.json`), { old: "preferences" });
        fs.writeFileSync(path.join(directory, `${name}.json.123abc.corrupt`), "broken");
      }
      jest.isolateModules(() => require("./factoryResetService").performFactoryReset());
      expect(fs.readdirSync(directory).some((name) => /\.last-good$|\.corrupt$/.test(name))).toBe(false);
    } finally {
      if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
      if (previousArtifactsDir === undefined) delete process.env.ARTIFACTS_DIR; else process.env.ARTIFACTS_DIR = previousArtifactsDir;
    }
  });
});