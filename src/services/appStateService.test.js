let mockStore = {};

jest.mock("./storage", () => ({
  readJson: (_filePath, defaultValue) => {
    const raw = mockStore[_filePath];
    return raw === undefined ? defaultValue : JSON.parse(JSON.stringify(raw));
  },
  writeJson: (_filePath, data) => { mockStore[_filePath] = JSON.parse(JSON.stringify(data)); },
  writeJsonAtomic: (_filePath, data) => { mockStore[_filePath] = JSON.parse(JSON.stringify(data)); },
}));

const { getAppState, saveAppState, DEFAULT_SHORTCUTS, DEFAULT_THEME_FAVORITES } = require("./appStateService");

beforeEach(() => { mockStore = {}; });

describe("appStateService — shortcuts", () => {
  it("returns default shortcuts when no file exists", () => {
    const state = getAppState();
    expect(state.preferences.shortcuts).toEqual(DEFAULT_SHORTCUTS);
  });

  it("saves a custom shortcut and reads it back", () => {
    saveAppState({ preferences: { shortcuts: { uppercaseText: "Ctrl+Shift+U" } } });
    const state = getAppState();
    expect(state.preferences.shortcuts.uppercaseText).toBe("Ctrl+Shift+U");
  });

  it("deep-merges shortcuts — updating one key preserves others", () => {
    saveAppState({ preferences: { shortcuts: { uppercaseText: "Ctrl+Shift+U" } } });
    saveAppState({ preferences: { shortcuts: { lowercaseText: "Ctrl+Shift+L" } } });
    const state = getAppState();
    expect(state.preferences.shortcuts.uppercaseText).toBe("Ctrl+Shift+U");
    expect(state.preferences.shortcuts.lowercaseText).toBe("Ctrl+Shift+L");
  });

  it("rejects empty string shortcut — falls back to default", () => {
    saveAppState({ preferences: { shortcuts: { uppercaseText: "" } } });
    const state = getAppState();
    expect(state.preferences.shortcuts.uppercaseText).toBe(DEFAULT_SHORTCUTS.uppercaseText);
  });

  it("round-trips all shortcut keys in a full preferences save", () => {
    const custom = {
      resolveObjects:  "Ctrl+R",
      runActiveTab:    "Ctrl+Enter",
      findInEditor:    "Ctrl+F",
      replaceInEditor: "Ctrl+H",
      uppercaseText:   "Ctrl+Shift+U",
      lowercaseText:   "Ctrl+Shift+L",
    };
    saveAppState({ preferences: { shortcuts: custom } });
    const state = getAppState();
    expect(state.preferences.shortcuts).toEqual(custom);
  });

  it("strips unknown shortcut keys on sanitize", () => {
    saveAppState({ preferences: { shortcuts: { bogusKey: "Ctrl+Z" } } });
    const state = getAppState();
    expect(state.preferences.shortcuts.bogusKey).toBeUndefined();
  });

  it("shortcuts survive alongside other preference saves", () => {
    saveAppState({ preferences: { shortcuts: { uppercaseText: "Ctrl+Shift+U" }, theme: "cyberpunk" } });
    saveAppState({ preferences: { fontFamily: "JetBrains Mono" } });
    const state = getAppState();
    expect(state.preferences.shortcuts.uppercaseText).toBe("Ctrl+Shift+U");
    expect(state.preferences.theme).toBe("cyberpunk");
    expect(state.preferences.fontFamily).toBe("JetBrains Mono");
  });

  it("persists favorite themes and falls back to defaults when empty", () => {
    saveAppState({ preferences: { favoriteThemes: ["dark", "nord", "dark"] } });
    let state = getAppState();
    expect(state.preferences.favoriteThemes).toEqual(["dark", "nord"]);

    saveAppState({ preferences: { favoriteThemes: [] } });
    state = getAppState();
    expect(state.preferences.favoriteThemes).toEqual(DEFAULT_THEME_FAVORITES);
  });
});
