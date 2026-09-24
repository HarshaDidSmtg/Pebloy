let mockStore = {};

jest.mock("./storage", () => ({
  readRecoverableJson: (_filePath, defaultValue) => {
    const raw = mockStore[_filePath];
    return raw === undefined ? defaultValue : JSON.parse(JSON.stringify(raw));
  },
  writeJson: (_filePath, data) => { mockStore[_filePath] = JSON.parse(JSON.stringify(data)); },
  writeRecoverableJson: (_filePath, data) => { mockStore[_filePath] = JSON.parse(JSON.stringify(data)); },
}));

const { getAppState, saveAppState, DEFAULT_APP_STATE, DEFAULT_SHORTCUTS, DEFAULT_THEME_FAVORITES } = require("./appStateService");

beforeEach(() => { mockStore = {}; });

describe("appStateService — shortcuts", () => {
  it("never restores the source-writing deploy mode", () => {
    saveAppState({ ui: { deployMode: "FormatAndExecuteSource", deployDestProfileId: "target-profile" } });
    const state = getAppState();
    expect(state.ui.deployMode).toBe("ExecuteDirectly");
    expect(state.ui.deployDestProfileId).toBe("target-profile");
  });

  it("keeps other deploy modes", () => {
    saveAppState({ ui: { deployMode: "DryRun" } });
    expect(getAppState().ui.deployMode).toBe("DryRun");
  });

  it("remembers discovery filters and bounds their length", () => {
    saveAppState({ ui: { objectsTypeFilter: "PROCEDURE", objectsSchemaFilter: "Reports", objectsNameFilter: "x".repeat(200) } });
    const state = getAppState();
    expect(state.ui.objectsTypeFilter).toBe("PROCEDURE");
    expect(state.ui.objectsSchemaFilter).toBe("Reports");
    expect(state.ui.objectsNameFilter).toHaveLength(128);
    expect(getAppState().ui.objectsTypeFilter).toBe("PROCEDURE");
  });

  it("returns default shortcuts when no file exists", () => {
    const state = getAppState();
    expect(state.preferences.shortcuts).toEqual(DEFAULT_SHORTCUTS);
    expect(state.preferences.hiddenTabs).toEqual([]);
  });

  it("uses Sepia, JetBrains Mono, and 14px as durable appearance defaults", () => {
    const state = getAppState();
    expect(state.preferences.theme).toBe("system");
    expect(state.preferences.fontFamily).toBe("JetBrains Mono");
    expect(state.preferences.fontSize).toBe(14);
    expect(DEFAULT_APP_STATE.preferences).toEqual(expect.objectContaining({
      theme: "system",
      fontFamily: "JetBrains Mono",
      fontSize: 14,
    }));
  });

  it("uses Legacy deploy engine by default and drops retired same-source deploy override", () => {
    saveAppState({ ui: { allowSameSource: true } });
    const state = getAppState();
    expect(state.ui.deployEngine).toBe("Legacy");
    expect(state.ui.allowSameSource).toBeUndefined();
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

  it("persists hidden tabs across saves while keeping settings visible", () => {
    saveAppState({ preferences: { hiddenTabs: ["deploy", "dashboard", "customize", "deploy", "not-a-tab"] } });
    saveAppState({ preferences: { theme: "cyberpunk" } });

    const state = getAppState();
    expect(state.preferences.hiddenTabs).toEqual(["deploy"]);
    expect(state.preferences.theme).toBe("cyberpunk");
  });

  it("falls back to credentials when a persisted active tab was retired", () => {
    saveAppState({ ui: { activeTab: "dashboard" } });

    const state = getAppState();
    expect(state.ui.activeTab).toBe("credentials");
  });

  it("keeps valid active tabs when sanitizing persisted state", () => {
    saveAppState({ ui: { activeTab: "diff" } });

    const state = getAppState();
    expect(state.ui.activeTab).toBe("diff");
  });

  it("preserves formatter UI state across saves", () => {
    saveAppState({
      ui: {
        formatter: {
          compareMode: true,
          options: { uppercaseKeywords: false, maxLineWidth: 120 },
          editor: { wordWrap: true },
        },
      },
    });
    saveAppState({ preferences: { theme: "nord" } });

    const state = getAppState();
    expect(state.ui.formatter).toEqual({
      compareMode: true,
      options: { uppercaseKeywords: false, maxLineWidth: 120 },
      editor: { wordWrap: true },
    });
  });
});
