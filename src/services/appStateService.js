const path = require("path");
const { readRecoverableJson, writeRecoverableJson } = require("./storage");

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "..", "..", "data");
const APP_STATE_PATH = path.join(DATA_DIR, "app-state.json");

const DEFAULT_SHORTCUTS = {
  resolveObjects:  "Ctrl+D",
  runActiveTab:    "Ctrl+Enter",
  findInEditor:    "Ctrl+F",
  replaceInEditor: "Ctrl+H",
  uppercaseText:   "Ctrl+Shift+U",
  lowercaseText:   "Ctrl+Shift+L",
};

const DEFAULT_THEME_FAVORITES = [
  "sepia",
  "light",
  "dark",
  "cyberpunk",
  "dracula",
  "monokai",
  "nord",
  "spiderman",
  "batman",
];

const KNOWN_TAB_IDS = [
  "credentials",
  "objects",
  "diff",
  "backup",
  "deploy",
  "logs",
  "customize",
];

const PROTECTED_TAB_ID = "customize";

const DEFAULT_APP_STATE = {
  preferences: {
    notificationsEnabled: false,
    defaultBackupPath: "",
    defaultScriptPath: "",
    theme: "system",
    favoriteThemes: [...DEFAULT_THEME_FAVORITES],
    fontFamily: "JetBrains Mono",
    fontSize: 14,
    logLevel: "Normal",
    hiddenTabs: [],
    shortcuts: { ...DEFAULT_SHORTCUTS },
  },
  ui: {
    activeTab: "credentials",
    objectsProfileId: "",
    objectsMode: "Specify",
    objectsTypeFilter: "",
    objectsSchemaFilter: "",
    objectsNameFilter: "",
    sharedObjectText: "",
    sharedSelectedObjects: [],
    diffSourceProfileId: "",
    diffDestProfileId: "",
    backupProfileId: "",
    backupPath: "",
    deploySourceProfileId: "",
    deployDestProfileId: "",
    deployEngine: "Legacy",
    deployMode: "ExecuteDirectly",
    deployScriptPath: "",
    continueOnError: false,
    formatter: {},
  },
};

function mergeState(current, partial) {
  return {
    preferences: {
      ...DEFAULT_APP_STATE.preferences,
      ...(current?.preferences || {}),
      ...(partial?.preferences || {}),
      shortcuts: {
        ...DEFAULT_SHORTCUTS,
        ...(current?.preferences?.shortcuts || {}),
        ...(partial?.preferences?.shortcuts || {}),
      },
    },
    ui: {
      ...DEFAULT_APP_STATE.ui,
      ...(current?.ui || {}),
      ...(partial?.ui || {}),
    },
  };
}

function sanitizeState(raw = {}) {
  const merged = mergeState(DEFAULT_APP_STATE, raw);
  const favoriteThemes = Array.isArray(merged.preferences.favoriteThemes)
    ? [...new Set(merged.preferences.favoriteThemes.map((value) => String(value || "").trim()).filter(Boolean))]
    : [...DEFAULT_THEME_FAVORITES];
  const activeTab = String(merged.ui.activeTab || DEFAULT_APP_STATE.ui.activeTab).trim();
  const hiddenTabs = Array.isArray(merged.preferences.hiddenTabs)
    ? [...new Set(
        merged.preferences.hiddenTabs
          .map((value) => String(value || "").trim())
          .filter((value) => value && value !== PROTECTED_TAB_ID && KNOWN_TAB_IDS.includes(value))
      )]
    : [];

  return {
    preferences: {
      notificationsEnabled: Boolean(merged.preferences.notificationsEnabled),
      defaultBackupPath: String(merged.preferences.defaultBackupPath || ""),
      defaultScriptPath: String(merged.preferences.defaultScriptPath || ""),
      theme: String(merged.preferences.theme || DEFAULT_APP_STATE.preferences.theme),
      favoriteThemes: favoriteThemes.length ? favoriteThemes : [...DEFAULT_THEME_FAVORITES],
      fontFamily: String(merged.preferences.fontFamily || DEFAULT_APP_STATE.preferences.fontFamily),
      fontSize: Number(merged.preferences.fontSize) || DEFAULT_APP_STATE.preferences.fontSize,
      logLevel: ["Verbose", "Normal", "ErrorsOnly"].includes(merged.preferences.logLevel)
        ? merged.preferences.logLevel
        : DEFAULT_APP_STATE.preferences.logLevel,
      hiddenTabs,
      shortcuts: Object.fromEntries(
        Object.keys(DEFAULT_SHORTCUTS).map((k) => [
          k,
          typeof merged.preferences.shortcuts?.[k] === "string" && merged.preferences.shortcuts[k]
            ? merged.preferences.shortcuts[k]
            : DEFAULT_SHORTCUTS[k],
        ])
      ),
    },
    ui: {
      activeTab: KNOWN_TAB_IDS.includes(activeTab) ? activeTab : DEFAULT_APP_STATE.ui.activeTab,
      objectsProfileId: String(merged.ui.objectsProfileId || ""),
      objectsMode: String(merged.ui.objectsMode || DEFAULT_APP_STATE.ui.objectsMode),
      objectsTypeFilter: String(merged.ui.objectsTypeFilter || "").slice(0, 128),
      objectsSchemaFilter: String(merged.ui.objectsSchemaFilter || "").slice(0, 128),
      objectsNameFilter: String(merged.ui.objectsNameFilter || "").slice(0, 128),
      sharedObjectText: String(merged.ui.sharedObjectText || ""),
      sharedSelectedObjects: Array.isArray(merged.ui.sharedSelectedObjects) ? merged.ui.sharedSelectedObjects : [],
      diffSourceProfileId: String(merged.ui.diffSourceProfileId || ""),
      diffDestProfileId: String(merged.ui.diffDestProfileId || ""),
      backupProfileId: String(merged.ui.backupProfileId || ""),
      backupPath: String(merged.ui.backupPath || ""),
      deploySourceProfileId: String(merged.ui.deploySourceProfileId || ""),
      deployDestProfileId: String(merged.ui.deployDestProfileId || ""),
      deployEngine: String(merged.ui.deployEngine || DEFAULT_APP_STATE.ui.deployEngine),
      deployMode: String(merged.ui.deployMode) === "FormatAndExecuteSource"
        ? DEFAULT_APP_STATE.ui.deployMode
        : String(merged.ui.deployMode || DEFAULT_APP_STATE.ui.deployMode),
      deployScriptPath: String(merged.ui.deployScriptPath || ""),
      continueOnError: Boolean(merged.ui.continueOnError),
      formatter: merged.ui.formatter && typeof merged.ui.formatter === "object" && !Array.isArray(merged.ui.formatter)
        ? merged.ui.formatter
        : {},
    },
  };
}

function getAppState() {
  return sanitizeState(readRecoverableJson(APP_STATE_PATH, DEFAULT_APP_STATE));
}

function saveAppState(partial = {}) {
  const updated = sanitizeState(mergeState(getAppState(), partial));
  writeRecoverableJson(APP_STATE_PATH, updated);
  return updated;
}

function resetAppState() {
  writeRecoverableJson(APP_STATE_PATH, DEFAULT_APP_STATE);
  return getAppState();
}

module.exports = {
  APP_STATE_PATH,
  DEFAULT_APP_STATE,
  DEFAULT_SHORTCUTS,
  DEFAULT_THEME_FAVORITES,
  getAppState,
  saveAppState,
  resetAppState,
};