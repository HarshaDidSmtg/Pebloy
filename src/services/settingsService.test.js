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
  it("returns defaults for newer settings fields", () => {
    const settings = getSettings();

    expect(settings.dacfx).toEqual(DEFAULTS.dacfx);
    expect(settings.time).toEqual(DEFAULTS.time);
    expect(settings.formatting).toEqual(DEFAULTS.formatting);
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
