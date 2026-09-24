jest.mock("./secretStore", () => ({
  encryptPassword: jest.fn((value) => `test-cipher:${value}`),
  decryptPassword: jest.fn((value) => value.slice("test-cipher:".length)),
}));

const fs = require("fs");
const os = require("os");
const path = require("path");

describe("profile credential consistency", () => {
  let directory;
  let previousDataDir;
  let service;
  const payload = { profileLabel: "Test", serverName: "offline", databaseName: "fixture", authenticationType: "Sql", username: "tester", password: "old-test-password" };
  beforeEach(() => {
    jest.resetModules();
    previousDataDir = process.env.DATA_DIR;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-profile-"));
    process.env.DATA_DIR = directory;
    service = require("./profileService");
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("stores connection groups and preserves them on legacy updates", () => {
    const original = service.createProfile({ ...payload, groupName: "  Finance  " });
    expect(original.groupName).toBe("Finance");
    expect(service.listProfiles()[0].groupName).toBe("Finance");
    expect(service.updateProfile(original.id, { ...payload, password: "" }).groupName).toBe("Finance");
    expect(service.updateProfile(original.id, { ...payload, groupName: "" }).groupName).toBeNull();
    expect(() => service.updateProfile(original.id, { ...payload, groupName: "x".repeat(81) })).toThrow("Connection group");
  });

  test.each(["Sql", "Windows"])("preserves the existing credential when a %s update fails", (authenticationType) => {
    const original = service.createProfile(payload);
    const rename = fs.renameSync;
    jest.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (target === path.join(directory, "profiles.json")) throw new Error("Simulated profile write failure");
      return rename(source, target);
    });
    expect(() => service.updateProfile(original.id, { ...payload, authenticationType, password: "new-test-password" })).toThrow("Simulated profile write failure");
    expect(service.getProfileWithSecret(original.id).password).toBe("old-test-password");
    expect(service.getProfile(original.id).secretReference).toBe(original.secretReference);
  });

  test("retires the old encrypted credential only after saving its replacement", () => {
    const original = service.createProfile(payload);
    const updated = service.updateProfile(original.id, { ...payload, password: "new-test-password" });
    expect(updated.secretReference).not.toBe(original.secretReference);
    expect(service.getProfileWithSecret(original.id).password).toBe("new-test-password");
    const secrets = JSON.parse(fs.readFileSync(path.join(directory, "secrets.json"), "utf8"));
    expect(secrets[original.secretReference]).toBeUndefined();
    expect(Object.keys(secrets)).toEqual([updated.secretReference]);
  });
});