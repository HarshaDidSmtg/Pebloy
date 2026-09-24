let mockFiles = {};

jest.mock("fs", () => ({
  existsSync: jest.fn((filePath) => Object.prototype.hasOwnProperty.call(mockFiles, filePath)),
  readFileSync: jest.fn((filePath) => mockFiles[filePath]),
  writeFileSync: jest.fn((filePath, content) => { mockFiles[filePath] = content; }),
  copyFileSync: jest.fn((from, to) => { mockFiles[to] = mockFiles[from]; }),
  mkdirSync: jest.fn(),
}));

jest.mock("./storage", () => ({
  ensureDir: jest.fn(),
  writeRecoverableJson: jest.fn((filePath, value) => { mockFiles[filePath] = JSON.stringify(value); }),
  readRecoverableJson: jest.fn((filePath, defaults) => mockFiles[filePath] === undefined ? defaults : JSON.parse(mockFiles[filePath])),
}));

const {
  DEFAULTS,
  SETTINGS_PATH,
  getSettings,
  saveSettings,
} = require("./settingsService");

beforeEach(() => {
  mockFiles = {};
});

describe("settingsService", () => {
  test("discards legacy deployment order without resetting other preferences", () => {
    mockFiles[SETTINGS_PATH] = JSON.stringify({ ...DEFAULTS, deploymentOrder: ["PROCEDURE", "TABLE"], formatting: { formatGeneratedSql: true } });
    expect(getSettings()).not.toHaveProperty("deploymentOrder");
    const saved = saveSettings({ deploymentOrder: ["TABLE"], folderNames: { VIEW: "Custom Views" } });
    expect(saved).not.toHaveProperty("deploymentOrder");
    expect(saved.formatting.formatGeneratedSql).toBe(true);
    expect(saved.folderNames.VIEW).toBe("Custom Views");
    expect(JSON.parse(mockFiles[SETTINGS_PATH])).not.toHaveProperty("deploymentOrder");
  });

  test.each([
    ["queryTimeoutSeconds", 4], ["queryTimeoutSeconds", 3601], ["queryTimeoutSeconds", 12.5], ["queryTimeoutSeconds", "abc"],
    ["powershellTimeoutSeconds", 29], ["maxActiveTaskLogs", 9], ["maxActiveTaskLogs", 5001],
  ])("rejects out-of-range execution setting %s=%p", (key, value) => {
    expect(() => saveSettings({ execution: { [key]: value } })).toThrow();
    expect(mockFiles[SETTINGS_PATH]).toBeUndefined();
  });

  test("rejects a shell timeout shorter than the query timeout", () => {
    expect(() => saveSettings({ execution: { queryTimeoutSeconds: 600, powershellTimeoutSeconds: 120 } }))
      .toThrow("at least queryTimeoutSeconds");
  });

  test("round-trips execution settings and keeps defaults for omitted keys", () => {
    const saved = saveSettings({ execution: { queryTimeoutSeconds: 600, powershellTimeoutSeconds: 900 } });
    expect(saved.execution).toEqual({ queryTimeoutSeconds: 600, powershellTimeoutSeconds: 900, maxActiveTaskLogs: 200 });
    expect(getSettings().execution.queryTimeoutSeconds).toBe(600);
    expect(saveSettings({ folderNames: { VIEW: "Custom" } }).execution.queryTimeoutSeconds).toBe(600);
  });

  test.each(["..", "../outside", "C:\\temp", "folder/name", "NUL", "COM1.sql", "Views."])("rejects unsafe folder %s", (folderName) => {
    expect(() => saveSettings({ folderNames: { VIEW: folderName } })).toThrow("Invalid folder name");
    expect(mockFiles[SETTINGS_PATH]).toBeUndefined();
  });

  test("rejects duplicate case-insensitive folder names", () => {
    expect(() => saveSettings({ folderNames: { VIEW: "tables" } })).toThrow("must be unique");
  });

  test("does not silently replace corrupt configuration", () => {
    mockFiles[SETTINGS_PATH] = "{broken";
    expect(() => saveSettings({})).toThrow("Cannot load settings");
    expect(mockFiles[SETTINGS_PATH]).toBe("{broken");
  });

  it("returns defaults for newer settings fields", () => {
    const settings = getSettings();

    expect(settings.dacfx).toEqual(DEFAULTS.dacfx);
    expect(settings.time).toEqual(DEFAULTS.time);
    expect(settings.formatting).toEqual(DEFAULTS.formatting);
    expect(settings.features).toEqual({ schedules: false });
  });

  it("keeps Scheduled Deployments opt-in and preserves the choice across unrelated saves", () => {
    expect(saveSettings({ features: { schedules: "yes" } }).features.schedules).toBe(false);
    expect(saveSettings({ features: { schedules: true } }).features.schedules).toBe(true);
    expect(saveSettings({ folderNames: { VIEW: "Views 2" } }).features.schedules).toBe(true);
    expect(JSON.parse(mockFiles[SETTINGS_PATH]).features).toEqual({ schedules: true });
  });

  it("round-trips restored DacFx, time, and formatter settings", () => {
    const saved = saveSettings({
      dacfx: { validationEnabled: true },
      time: { useSystemTime: false, timeZone: "Asia/Kolkata" },
      formatting: { formatGeneratedSql: true },
    });

    expect(saved.dacfx.validationEnabled).toBe(true);
    expect(saved.time).toEqual({ useSystemTime: false, timeZone: "Asia/Kolkata" });
    expect(saved.formatting.formatGeneratedSql).toBe(true);
    expect(JSON.parse(mockFiles[SETTINGS_PATH])).toMatchObject({
      dacfx: { validationEnabled: true },
      time: { useSystemTime: false, timeZone: "Asia/Kolkata" },
      formatting: { formatGeneratedSql: true },
    });
  });

  it("preserves newer settings when saving legacy folder settings", () => {
    saveSettings({
      dacfx: { validationEnabled: true },
      time: { useSystemTime: false, timeZone: "Asia/Kolkata" },
      formatting: { formatGeneratedSql: true },
    });

    const saved = saveSettings({ folderNames: { VIEW: "Custom Views" } });

    expect(saved.folderNames.VIEW).toBe("Custom Views");
    expect(saved.dacfx.validationEnabled).toBe(true);
    expect(saved.time.useSystemTime).toBe(false);
    expect(saved.formatting.formatGeneratedSql).toBe(true);
  });
});
