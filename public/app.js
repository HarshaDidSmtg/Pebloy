let currentDiffReport = null;
let currentDiffRows = [];
let currentDiffIndex = 0;
let sharedSelectedObjects = [];
let sharedDiscoveredObjects = [];
const progressTimers = {};
let appState = null;
let pendingAppStatePatch = null;
let appStateSaveTimer = null;
let isApplyingAppState = false;
const enhancedTextEditors = new Map();
const DEFAULT_TAB = "credentials";
const DEFAULT_APPEARANCE_THEME = "sepia";
const DEFAULT_APPEARANCE_FONT_FAMILY = "JetBrains Mono";
const DEFAULT_APPEARANCE_FONT_SIZE = 14;
const _profileHealth = new Map(); // profileId → { status: 'ok'|'error'|'unknown', testedAt: ISO|null }
let _lastDeployResults = []; // for retry failed
let _profileSort = { col: "profileLabel", dir: "asc" };
let _selectionSort  = { col: null, dir: "asc" };
let _discoveredSort = { col: null, dir: "asc" };
let _discoverPage = 1;
const DISCOVER_PAGE_SIZE = 50;
const DEPENDENCY_REQUEST_TIMEOUT_MS = 45000;
let _logSort = { col: "startedAt", dir: "desc" };
let _deployResultSort = { col: null, dir: "asc" };
const dependencyFetchCache = new Map();
const editorHelpers = globalThis.PebloyEditorHelpers || {
  normalizeFindMatchIndex(matchIdx, matchCount) {
    if (!matchCount) return -1;
    if (matchIdx < 0) return -1;
    return Math.min(matchIdx, matchCount - 1);
  },
  getNextFindMatchIndex(matchIdx, matchCount, direction) {
    if (!matchCount) return -1;
    if (matchIdx < 0) return direction < 0 ? matchCount - 1 : 0;
    let next = (matchIdx + direction) % matchCount;
    if (next < 0) next += matchCount;
    return next;
  },
  getFindCountText(matchCount, matchIdx) {
    if (!matchCount) return "No results";
    if (matchIdx < 0) return `${matchCount} result${matchCount === 1 ? "" : "s"}`;
    return `${matchIdx + 1}/${matchCount}`;
  },
  getClearSelectionUiState(hadSelection) {
    return {
      nextMode: "Specify",
      clearDiscovered: true,
      focusTargetId: "sharedObjectText",
      toastMessage: hadSelection ? "Cleared object selection" : "Ready for manual object entry",
    };
  },
};

function sortObjects(objects, { col, dir }) {
  if (!col) return objects;
  return [...objects].sort((a, b) => {
    let av = "";
    let bv = "";
    if (col === "type")     { av = a.objectType   || ""; bv = b.objectType   || ""; }
    if (col === "object")   { av = `${a.schemaName || ""}.${a.objectName || ""}`; bv = `${b.schemaName || ""}.${b.objectName || ""}`; }
    if (col === "created")  { av = a.createdDate  || ""; bv = b.createdDate  || ""; }
    if (col === "modified") { av = a.modifiedDate || ""; bv = b.modifiedDate || ""; }
    const cmp = String(av).localeCompare(String(bv), undefined, { sensitivity: "base", numeric: true });
    return dir === "asc" ? cmp : -cmp;
  });
}

function sortProfiles(profiles, { col, dir }) {
  if (!col) return profiles;
  return [...profiles].sort((a, b) => {
    const valueFor = (profile) => {
      if (col === "profileLabel") return profile.profileLabel || "";
      if (col === "serverName") return profile.serverName || "";
      if (col === "databaseName") return profile.databaseName || "";
      if (col === "authenticationType") return formatAuthenticationTypeLabel(profile.authenticationType);
      if (col === "environmentTag") return profile.environmentTag || "";
      return "";
    };
    const cmp = String(valueFor(a)).localeCompare(String(valueFor(b)), undefined, { sensitivity: "base", numeric: true });
    return dir === "asc" ? cmp : -cmp;
  });
}

function sortDeployResults(items, { col, dir }) {
  if (!col) return items;
  return [...items].sort((a, b) => {
    const valueFor = (item) => {
      if (col === "type") return item.objectType || "";
      if (col === "object") return `${item.schemaName || ""}.${item.objectName || ""}`;
      if (col === "action") return item.action || "";
      if (col === "status") return item.status || "";
      if (col === "error") return item.errorMessage || "";
      return "";
    };
    const cmp = String(valueFor(a)).localeCompare(String(valueFor(b)), undefined, { sensitivity: "base", numeric: true });
    return dir === "asc" ? cmp : -cmp;
  });
}

function sortLogs(logs, { col, dir }) {
  if (!col) return logs;
  return [...logs].sort((a, b) => {
    let av;
    let bv;

    if (col === "taskType") {
      av = a.taskType || "";
      bv = b.taskType || "";
    } else if (col === "status") {
      av = a.status || "";
      bv = b.status || "";
    } else if (col === "eventLevel") {
      av = a.highestLevel || "";
      bv = b.highestLevel || "";
    } else if (col === "connectionFlow") {
      av = `${a.sourceProfileLabel || ""}${a.destinationProfileLabel ? ` -> ${a.destinationProfileLabel}` : ""}`;
      bv = `${b.sourceProfileLabel || ""}${b.destinationProfileLabel ? ` -> ${b.destinationProfileLabel}` : ""}`;
    } else if (col === "objectCount") {
      av = Number(a.objectCount || 0);
      bv = Number(b.objectCount || 0);
      const cmp = av - bv;
      return dir === "asc" ? cmp : -cmp;
    } else if (col === "startedAt") {
      av = new Date(a.startedAt || 0).getTime();
      bv = new Date(b.startedAt || 0).getTime();
      const cmp = av - bv;
      return dir === "asc" ? cmp : -cmp;
    } else if (col === "duration") {
      av = a.startedAt ? Math.max(0, new Date(a.completedAt || Date.now()).getTime() - new Date(a.startedAt).getTime()) : -1;
      bv = b.startedAt ? Math.max(0, new Date(b.completedAt || Date.now()).getTime() - new Date(b.startedAt).getTime()) : -1;
      const cmp = av - bv;
      return dir === "asc" ? cmp : -cmp;
    } else {
      av = "";
      bv = "";
    }

    const cmp = String(av).localeCompare(String(bv));
    return dir === "asc" ? cmp : -cmp;
  });
}

function matchesShortcut(event, shortcutStr = "") {
  if (!shortcutStr) return false;
  const parts = shortcutStr.toLowerCase().split("+");
  const key = parts.find((p) => !["ctrl", "shift", "alt", "meta"].includes(p)) || "";
  return (
    (event.ctrlKey || event.metaKey) === parts.includes("ctrl") &&
    event.shiftKey === parts.includes("shift") &&
    event.altKey   === parts.includes("alt") &&
    event.key.toLowerCase() === key
  );
}

function formatAuthenticationTypeLabel(value) {
  const type = String(value || "").trim().toLowerCase();
  if (type === "sql") return "SQL";
  if (type === "windows") return "Windows";
  return String(value || "");
}

function getShortcuts() {
  return appState?.preferences?.shortcuts || {};
}

function renderShortcutBadges() {
  const sc = getShortcuts();
  const targets = [
    { id: "resolveAndAddObjects", key: sc.resolveObjects },
    { id: "runDiff",              key: sc.runActiveTab },
    { id: "runBackup",            key: sc.runActiveTab },
    { id: "runDeployment",        key: sc.runActiveTab },
  ];
  targets.forEach(({ id, key }) => {
    const btn = document.getElementById(id);
    if (!btn || !key) return;
    let badge = btn.querySelector(".kbd-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "kbd-badge";
      btn.appendChild(badge);
    }
    badge.textContent = key;
  });

  // Update the Specify textarea placeholder with the current shortcut
  const ta = document.getElementById("sharedObjectText");
  if (ta && sc.resolveObjects) {
    const placeholder =
      "Paste schema.name (one per line)\n" +
      "Example: dbo.MyProc\n" +
      "         dbo.vw_Orders\n" +
      "         reporting.usp_get_summary\n\n" +
      `Shortcuts: ${sc.resolveObjects} = Resolve & Add  ·  ` +
      `${sc.findInEditor || "Ctrl+F"} = Find  ·  ` +
      `${sc.replaceInEditor || "Ctrl+H"} = Replace  ·  ` +
      `${sc.uppercaseText || "Ctrl+Shift+U"} = UPPER  ·  ` +
      `${sc.lowercaseText || "Ctrl+Shift+L"} = lower`;
    ta.placeholder = placeholder;
    getEnhancedTextEditor("sharedObjectText")?.updatePlaceholder?.(placeholder);
  }
}

function $(id) {
  return document.getElementById(id);
}

function getEnhancedTextEditor(textareaOrId) {
  const textareaId = typeof textareaOrId === "string" ? textareaOrId : textareaOrId?.id;
  return textareaId ? enhancedTextEditors.get(textareaId) || null : null;
}

function getTextEditorValue(textareaId) {
  return getEnhancedTextEditor(textareaId)?.getValue?.() ?? $(textareaId)?.value ?? "";
}

function setTextEditorValue(textareaId, value, { emit = false } = {}) {
  const nextValue = String(value ?? "");
  const editor = getEnhancedTextEditor(textareaId);
  if (editor?.setValue) {
    editor.setValue(nextValue, { emit });
    return;
  }

  const textarea = $(textareaId);
  if (!textarea) return;
  textarea.value = nextValue;
  if (emit) {
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function focusTextEditor(textareaId) {
  const editor = getEnhancedTextEditor(textareaId);
  if (editor?.focus) {
    editor.layout?.();
    editor.focus();
    return;
  }
  $(textareaId)?.focus();
}

function getSharedObjectTextValue() {
  return getTextEditorValue("sharedObjectText");
}

function setSharedObjectTextValue(value, options) {
  setTextEditorValue("sharedObjectText", value, options);
}

function focusSharedObjectEntry() {
  focusTextEditor("sharedObjectText");
}

async function setupEnhancedTextEditors() {
  const createEditor =
    globalThis.PebloyManualEntryEditor?.createEnhancedTextareaEditor ||
    globalThis.PebloyManualEntryEditor?.createManualEntryEditor;
  if (!createEditor) {
    return;
  }

  const hosts = Array.from(document.querySelectorAll(".enhanced-text-editor[data-enhanced-textarea]"));
  const failures = [];

  for (const host of hosts) {
    const textareaId = host.dataset.enhancedTextarea;
    const textarea = textareaId ? $(textareaId) : null;
    if (!textareaId || !textarea) continue;

    const existingEditor = getEnhancedTextEditor(textareaId);
    if (existingEditor?.dispose) {
      existingEditor.dispose();
      enhancedTextEditors.delete(textareaId);
    }

    try {
      const editor = await createEditor({
        host,
        textarea,
        initialValue: textarea.value,
        placeholder: textarea.placeholder,
      });
      enhancedTextEditors.set(textareaId, editor);
    } catch (error) {
      failures.push(`${textareaId}: ${error.message}`);
    }
  }

  if (failures.length) {
    throw new Error(failures.join("; "));
  }
}

function getElectronApi() {
  return typeof window !== "undefined" ? window.electronAPI : null;
}

function getFormatterWorkbench() {
  return globalThis.pebloyFormatterWorkbench || null;
}

async function chooseTextFile(options = {}) {
  const electronApi = getElectronApi();
  if (electronApi?.pickFile) {
    return electronApi.pickFile(options);
  }

  try {
    const result = await api("/api/system/pick-file", {
      method: "POST",
      body: JSON.stringify({
        description: options.description || "Choose a file",
        initialPath: options.initialPath || "",
        filterText: options.filterText || "Text Files (*.txt;*.csv)|*.txt;*.csv|All Files (*.*)|*.*",
      }),
    });
    if (result?.selectedPath || result?.content) {
      return {
        filePath: result.selectedPath || "",
        fileName: result.fileName || "",
        content: result.content || "",
      };
    }
  } catch (_error) {
    // Fall back to the browser picker only when the backend picker is unavailable.
  }

  const fallbackInput = $("sharedObjectFile");
  if (!fallbackInput) return null;

  return new Promise((resolve) => {
    const handleChange = async (event) => {
      fallbackInput.removeEventListener("change", handleChange);
      const file = event.target.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }

      const content = await file.text();
      resolve({
        filePath: "",
        fileName: file.name,
        content,
      });
      fallbackInput.value = "";
    };

    fallbackInput.addEventListener("change", handleChange, { once: true });
    fallbackInput.click();
  });
}

function renderGenerationWarnings(warnings, containerId) {
  const existing = document.getElementById(containerId + "_warnings");
  if (existing) existing.remove();
  if (!warnings || !warnings.length) return;

  const panel = document.createElement("div");
  panel.id = containerId + "_warnings";
  panel.style.cssText = "border-left:3px solid var(--warning);background:color-mix(in srgb,var(--warning) 8%,transparent);border-radius:4px;padding:0.5rem 0.75rem;margin-top:0.5rem;font-size:0.82rem";

  const header = document.createElement("div");
  header.style.cssText = "font-weight:600;color:var(--warning);margin-bottom:0.25rem";
  header.textContent = `${warnings.length} Generation Warning${warnings.length === 1 ? "" : "s"}`;
  panel.appendChild(header);

  const list = document.createElement("ul");
  list.style.cssText = "margin:0;padding-left:1.2rem;color:var(--text-2)";
  for (const w of warnings) {
    const li = document.createElement("li");
    const role = w.profileRole ? ` [${w.profileRole}]` : "";
    const obj = (w.schemaName && w.objectName) ? ` — ${w.schemaName}.${w.objectName}` : "";
    li.textContent = `${w.message}${obj}${role}`;
    list.appendChild(li);
  }
  panel.appendChild(list);

  const anchor = document.getElementById(containerId);
  if (anchor) anchor.after(panel);
}

function showToast(message, isError = false) {
  const toast = $("toast");

  if (toast._dismissTimer) clearTimeout(toast._dismissTimer);
  if (toast._dismissHandler) {
    toast.removeEventListener("click", toast._dismissHandler);
    toast._dismissHandler = null;
  }

  toast.textContent = message + (isError ? "  ✕" : "");
  toast.classList.toggle("toast-error", isError);
  toast.classList.toggle("toast-success", !isError);
  toast.classList.add("visible");

  if (isError) {
    toast.style.cursor = "pointer";
    const handler = () => {
      toast.classList.remove("visible");
      toast.removeEventListener("click", handler);
      toast._dismissHandler = null;
      clearTimeout(toast._dismissTimer);
    };
    toast._dismissHandler = handler;
    toast.addEventListener("click", handler);
    toast._dismissTimer = setTimeout(() => {
      toast.classList.remove("visible");
      toast.removeEventListener("click", handler);
      toast._dismissHandler = null;
    }, 10000);
  } else {
    toast.style.cursor = "";
    toast._dismissTimer = setTimeout(() => toast.classList.remove("visible"), 2500);
  }
}

function setButtonLoading(button, loadingText) {
  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.classList.add("btn-loading");
  button.dataset.loadingLabel = loadingText;
  button.setAttribute("aria-busy", "true");
  return () => {
    button.disabled = false;
    button.classList.remove("btn-loading");
    button.removeAttribute("aria-busy");
    delete button.dataset.loadingLabel;
    button.innerHTML = originalHtml;
  };
}

async function api(path, options = {}) {
  const { timeoutMs = 0, ...fetchOptions } = options;
  let timeoutId = null;
  if (timeoutMs > 0) {
    const controller = new AbortController();
    fetchOptions.signal = controller.signal;
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  let response;
  try {
    response = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...fetchOptions,
    });
  } catch (error) {
    if (timeoutMs > 0 && error?.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds. Try again, refresh the dependency cache, or reduce the selected objects.`);
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const steps = Array.isArray(body.resolutionSteps) && body.resolutionSteps.length
      ? ` Next: ${body.resolutionSteps.join(" ")}`
      : "";
    throw new Error((body.error || `Request failed: ${response.status}`) + steps);
  }

  if (response.status === 204) return null;
  return response.json();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeAppState(base = {}, patch = {}) {
  return {
    preferences: {
      ...(base.preferences || {}),
      ...(patch.preferences || {}),
    },
    ui: {
      ...(base.ui || {}),
      ...(patch.ui || {}),
    },
  };
}

function readLegacyPreference(key, fallback = "") {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : value;
  } catch (_error) {
    return fallback;
  }
}

function readAppPreference(key, fallback = "") {
  return readLegacyPreference(`pebloy.${key}`, fallback);
}

async function loadPersistedAppState() {
  appState = await api("/api/app-state");
  return appState;
}

function scheduleAppStateSave(partial, { delay = 250, silent = true } = {}) {
  if (isApplyingAppState) return;

  pendingAppStatePatch = mergeAppState(pendingAppStatePatch || {}, partial || {});
  appState = mergeAppState(appState || {}, partial || {});

  const flush = async () => {
    const payload = pendingAppStatePatch;
    pendingAppStatePatch = null;
    appStateSaveTimer = null;
    try {
      appState = await api("/api/app-state", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (!silent) showToast(`Failed to save app state: ${error.message}`, true);
    }
  };

  if (appStateSaveTimer) clearTimeout(appStateSaveTimer);
  if (delay <= 0) {
    flush();
    return;
  }

  appStateSaveTimer = setTimeout(flush, delay);
}

function getActiveTabName() {
  return document.querySelector(".tab.active")?.dataset.tab || DEFAULT_TAB;
}

function getDefaultVisibleTabButton() {
  return document.querySelector(`.tab[data-tab='${DEFAULT_TAB}']:not(.hidden)`) ||
    document.querySelector(".tab[data-tab]:not(.hidden)");
}

function collectCurrentAppState() {
  // Collect shortcut values from DOM if the table is rendered, else preserve loaded state
  const shortcutInputs = document.querySelectorAll(".shortcut-input[data-key]");
  const shortcuts = shortcutInputs.length
    ? Object.fromEntries([...shortcutInputs].map((el) => [el.dataset.key, el.value && !el.value.startsWith("Press") ? el.value : (appState?.preferences?.shortcuts?.[el.dataset.key] || "")]))
    : { ...(appState?.preferences?.shortcuts || {}) };

  return {
    preferences: {
      notificationsEnabled: Boolean($("notificationsToggle")?.checked),
      defaultBackupPath: $("defaultBackupPath")?.value.trim() || "",
      defaultScriptPath: $("defaultScriptPath")?.value.trim() || "",
      theme: document.body.dataset.theme || DEFAULT_APPEARANCE_THEME,
      fontFamily: $("fontSelector")?.value || DEFAULT_APPEARANCE_FONT_FAMILY,
      fontSize: Number($("fontSizeRange")?.value || DEFAULT_APPEARANCE_FONT_SIZE),
      logLevel: $("logLevelSelect")?.value || "Normal",
      hiddenTabs: Array.from(document.querySelectorAll(".tab[data-tab].hidden")).map((b) => b.dataset.tab),
      shortcuts,
    },
    ui: {
      activeTab: getActiveTabName(),
      objectsProfileId: $("objectsProfile")?.value || "",
      objectsMode: $("objectsMode")?.value || "Specify",
      sharedObjectText: getSharedObjectTextValue(),
      sharedSelectedObjects: cloneJson(sharedSelectedObjects),
      diffSourceProfileId: $("diffSourceProfile")?.value || "",
      diffDestProfileId: $("diffDestProfile")?.value || "",
      diffEngine: $("diffEngine")?.value || "Legacy",
      backupProfileId: $("backupProfile")?.value || "",
      backupPath: $("backupPath")?.value.trim() || "",
      deploySourceProfileId: $("deploySourceProfile")?.value || "",
      deployDestProfileId: $("deployDestProfile")?.value || "",
      deployEngine: $("deployEngine")?.value || "Legacy",
      deployMode: $("deployMode")?.value || "ExecuteDirectly",
      deployScriptPath: $("deployScriptPath")?.value.trim() || "",
      continueOnError: Boolean($("continueOnError")?.checked),
      formatter: cloneJson(getFormatterWorkbench()?.getPersistedState?.() || appState?.ui?.formatter || {}),
    },
  };
}

function persistCurrentAppState(options) {
  scheduleAppStateSave(collectCurrentAppState(), options);
}

function applyPersistedUiState() {
  if (!appState) return;

  const prefs = appState.preferences || {};
  const ui = appState.ui || {};

  isApplyingAppState = true;
  try {
    if ($("notificationsToggle")) $("notificationsToggle").checked = Boolean(prefs.notificationsEnabled);
    if ($("defaultBackupPath")) $("defaultBackupPath").value = prefs.defaultBackupPath || readAppPreference("defaultBackupPath", "");
    if ($("defaultScriptPath")) $("defaultScriptPath").value = prefs.defaultScriptPath || readAppPreference("defaultScriptPath", "");
    if ($("logLevelSelect") && prefs.logLevel) $("logLevelSelect").value = prefs.logLevel;

    if ($("objectsProfile")) $("objectsProfile").value = ui.objectsProfileId || "";
    if ($("objectsMode")) $("objectsMode").value = ui.objectsMode || "Specify";
    applyObjectModeUI();

    setSharedObjectTextValue(ui.sharedObjectText || "");
    sharedSelectedObjects = dedupeObjects(Array.isArray(ui.sharedSelectedObjects) ? ui.sharedSelectedObjects : []);
    renderSharedSelectionTable();

    if ($("diffSourceProfile")) $("diffSourceProfile").value = ui.diffSourceProfileId || "";
    if ($("diffDestProfile")) $("diffDestProfile").value = ui.diffDestProfileId || "";
    if ($("diffEngine")) $("diffEngine").value = ui.diffEngine || "Legacy";

    if ($("backupProfile")) $("backupProfile").value = ui.backupProfileId || "";
    if ($("backupPath")) {
      $("backupPath").value = ui.backupPath || prefs.defaultBackupPath || "";
    }

    if ($("deploySourceProfile")) $("deploySourceProfile").value = ui.deploySourceProfileId || "";
    if ($("deployDestProfile")) $("deployDestProfile").value = ui.deployDestProfileId || "";
    if ($("deployEngine")) {
      $("deployEngine").value = ui.deployEngine || "Legacy";
      $("deployEngine").dispatchEvent(new Event("change"));
    }
    if ($("deployMode")) {
      $("deployMode").value = ui.deployMode || "ExecuteDirectly";
      $("deployMode").dispatchEvent(new Event("change"));
    }
    if ($("deployScriptPath")) {
      $("deployScriptPath").value = ui.deployScriptPath || prefs.defaultScriptPath || "";
    }
    if ($("continueOnError")) $("continueOnError").checked = Boolean(ui.continueOnError);

    getFormatterWorkbench()?.applyPersistedState?.(ui.formatter || {});

    applyTabVisibility(prefs.hiddenTabs || []);
    if (ui.activeTab) setActiveTab(ui.activeTab);
  } finally {
    isApplyingAppState = false;
  }
}

function bindAppStatePersistence() {
  const textIds = ["sharedObjectText", "backupPath", "deployScriptPath", "defaultBackupPath", "defaultScriptPath"];
  const changeIds = [
    "objectsProfile",
    "objectsMode",
    "diffSourceProfile",
    "diffDestProfile",
    "diffEngine",
    "backupProfile",
    "deploySourceProfile",
    "deployDestProfile",
    "deployEngine",
    "deployMode",
    "continueOnError",
    "notificationsToggle",
    "fontSelector",
    "fontSizeRange",
    "logLevelSelect",
  ];

  textIds.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("input", () => persistCurrentAppState({ delay: 300 }));
    el.addEventListener("change", () => persistCurrentAppState({ delay: 0 }));
  });

  changeIds.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", () => persistCurrentAppState({ delay: 0 }));
  });

  // Source/Target profile sync across tabs: selecting a profile in one tab
  // mirrors to every other tab in the same group (Source or Target). Prevents
  // having to set the same dropdown three times.
  const SOURCE_IDS = ["objectsProfile", "diffSourceProfile", "backupProfile", "deploySourceProfile"];
  const TARGET_IDS = ["diffDestProfile", "deployDestProfile"];

  function wireProfileSync(groupIds) {
    groupIds.forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("change", (evt) => {
        if (evt && evt.detail === "syncPeer") return;
        const value = el.value;
        groupIds.forEach((peerId) => {
          if (peerId === id) return;
          const peer = $(peerId);
          if (peer && peer.value !== value) {
            peer.value = value;
            peer.dispatchEvent(new CustomEvent("change", { detail: "syncPeer" }));
          }
        });
      });
    });
  }
  wireProfileSync(SOURCE_IDS);
  wireProfileSync(TARGET_IDS);

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      scheduleAppStateSave({ ui: { activeTab: tab.dataset.tab } }, { delay: 0 });
    });
  });
}

async function chooseFolderForInput(inputId, description) {
  const input = $(inputId);
  if (!input) return;

  try {
    const electronApi = getElectronApi();
    const selectedPath = electronApi?.pickFolder
      ? await electronApi.pickFolder({
        description,
        initialPath: input.value,
      })
      : (await api("/api/system/pick-folder", {
        method: "POST",
        body: JSON.stringify({
          description,
          initialPath: input.value,
        }),
      }))?.selectedPath;

    if (selectedPath) {
      input.value = selectedPath;
      persistCurrentAppState({ delay: 0 });
      showToast(`Folder selected: ${selectedPath}`);
    }
  } catch (error) {
    showToast(`Folder picker failed: ${error.message}`, true);
  }
}

function beginTaskProgress(key, label) {
  const bar = $(`${key}ProgressBar`);
  const text = $(`${key}ProgressText`);
  if (!bar || !text) return;

  if (progressTimers[key]) {
    clearInterval(progressTimers[key]);
  }

  bar.classList.add("is-indeterminate");
  bar.style.width = "40%";
  bar.style.background = "linear-gradient(90deg, var(--accent), var(--accent-2))";
  text.textContent = label || "Running...";
}

function updateTaskProgress(key, label, percent = null) {
  const bar = $(`${key}ProgressBar`);
  const text = $(`${key}ProgressText`);
  if (!bar || !text) return;

  if (percent === null || percent === undefined) {
    bar.classList.add("is-indeterminate");
    bar.style.width = "40%";
  } else {
    bar.classList.remove("is-indeterminate");
    bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
  bar.style.background = "linear-gradient(90deg, var(--accent), var(--accent-2))";
  text.textContent = label || "Running...";
}

function endTaskProgress(key, ok, label) {
  const bar = $(`${key}ProgressBar`);
  const text = $(`${key}ProgressText`);
  if (!bar || !text) return;

  if (progressTimers[key]) {
    clearInterval(progressTimers[key]);
    delete progressTimers[key];
  }

  bar.classList.remove("is-indeterminate");
  bar.style.width = "100%";
  text.textContent = ok ? `${label} completed` : `${label} failed`;
  if (!ok) {
    bar.style.background = "var(--danger)";
  } else {
    bar.style.background = "var(--accent)";
  }
}

function resetTaskProgress(key) {
  const bar = $(`${key}ProgressBar`);
  const text = $(`${key}ProgressText`);
  if (!bar || !text) return;

  if (progressTimers[key]) {
    clearInterval(progressTimers[key]);
    delete progressTimers[key];
  }

  bar.classList.remove("is-indeterminate");
  bar.style.width = "0%";
  bar.style.background = "var(--accent)";
  text.textContent = "Idle";
}

function normalizeObject(item) {
  return {
    objectType: String(item.objectType || "").toUpperCase(),
    schemaName: String(item.schemaName || "").trim(),
    objectName: String(item.objectName || "").trim(),
  };
}

function objectKey(item) {
  const normalized = normalizeObject(item);
  return `${normalized.objectType}|${normalized.schemaName.toLowerCase()}|${normalized.objectName.toLowerCase()}`;
}

function dedupeObjects(items) {
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const normalized = normalizeObject(raw);
    if (!normalized.objectType || !normalized.schemaName || !normalized.objectName) continue;
    const key = objectKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...raw, ...normalized });
  }
  return out;
}

function objectOrigin(item) {
  return String(item?.origin || item?.selectionOrigin || "original").toLowerCase() === "dependency"
    ? "dependency"
    : "original";
}

function objectOriginLabel(item) {
  return objectOrigin(item) === "dependency" ? "Imported Dependency" : "Original";
}

function parseObjectLines(text) {
  const seen = new Set();
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      line = line.replace(/[\[\]]/g, "").trim();
      const csv = line.split(",").map((x) => x.trim());
      if (csv.length >= 3) {
        return { objectType: csv[0].toUpperCase(), schemaName: csv[1], objectName: csv[2] };
      }
      const parts = line.split(".");
      if (parts.length === 2) {
        return { objectType: "", schemaName: parts[0].trim(), objectName: parts[1].trim() };
      }
      if (parts.length === 1) {
        return { objectType: "", schemaName: "", objectName: parts[0].trim() };
      }
      return null;
    })
    .filter(Boolean)
    .filter((item) => {
      if (!item.objectName) return false;
      const key = `${item.schemaName.toLowerCase()}|${item.objectName.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

// When null, dates render in the machine's local timezone (Use System Time).
// Set from settings to render every timestamp in the configured timezone.
let activeTimeZone = null;

// One "Format Generated SQL" preference drives the Settings toggle and the
// per-mode checkboxes on Deployment and Code Diff. Backup uses a three-state
// dropdown instead: its off/format states mirror the shared preference, while
// "Format & Execute in Source" is a per-run choice that never persists.
const FORMAT_SQL_CONTROL_IDS = ["formatGeneratedSqlToggle", "formatSqlDeploy", "formatSqlDiff"];

function applyFormattingSettings(formatting) {
  const enabled = Boolean(formatting?.formatGeneratedSql);
  for (const id of FORMAT_SQL_CONTROL_IDS) {
    const el = $(id);
    if (el) el.checked = enabled;
  }
  const backupMode = $("backupFormatMode");
  if (backupMode && backupMode.value !== "formatExecute") {
    backupMode.value = enabled ? "format" : "off";
  }
}

function isFormatGeneratedSqlEnabled() {
  return Boolean($("formatGeneratedSqlToggle")?.checked);
}

function setupFormatSqlCheckboxes() {
  const persistFormatting = async (enabled) => {
    applyFormattingSettings({ formatGeneratedSql: enabled });
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ formatting: { formatGeneratedSql: enabled } }),
      });
    } catch (error) {
      showToast("Failed to save formatting preference: " + error.message, true);
    }
  };

  for (const id of FORMAT_SQL_CONTROL_IDS) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener("change", () => persistFormatting(el.checked));
  }

  const backupMode = $("backupFormatMode");
  if (backupMode) {
    backupMode.addEventListener("change", () => {
      // "formatExecute" is a per-run backup choice; only the off/format
      // states feed the shared Format Generated SQL preference.
      if (backupMode.value !== "formatExecute") {
        persistFormatting(backupMode.value === "format");
      }
    });
  }
}

function formatDateParts(value) {
  if (value === null || value === undefined || value === "" || (typeof value === "object" && !(value instanceof Date))) {
    return null;
  }

  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return null;
  }

  if (activeTimeZone) {
    try {
      const formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone: activeTimeZone,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hourCycle: "h23",
      });
      const p = {};
      for (const part of formatter.formatToParts(date)) {
        if (part.type !== "literal") p[part.type] = part.value;
      }
      return { dd: p.day, mm: p.month, yyyy: p.year, hh: p.hour, mi: p.minute, ss: p.second };
    } catch (_e) {
      // Invalid zone — fall through to local time
    }
  }

  return {
    dd: padDatePart(date.getDate()),
    mm: padDatePart(date.getMonth() + 1),
    yyyy: String(date.getFullYear()),
    hh: padDatePart(date.getHours()),
    mi: padDatePart(date.getMinutes()),
    ss: padDatePart(date.getSeconds()),
  };
}

function formatDate(d) {
  const parts = formatDateParts(d);
  return parts ? `${parts.dd}/${parts.mm}/${parts.yyyy}` : "—";
}

function formatDateTime(d) {
  const parts = formatDateParts(d);
  return parts ? `${parts.dd}/${parts.mm}/${parts.yyyy} ${parts.hh}:${parts.mi}:${parts.ss}` : "—";
}

function parseDateMs(value) {
  if (value === null || value === undefined || value === "" || (typeof value === "object" && !(value instanceof Date))) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;

  // SQL/JSON placeholder values such as 0 or 1970-01-01 are not meaningful
  // object modified dates and should never stretch the dependency window back
  // to 1969 after the one-day buffer is applied.
  const earliestMeaningfulDate = Date.UTC(1990, 0, 1);
  return timestamp >= earliestMeaningfulDate ? timestamp : null;
}

function buildDependencyTimeWindow(objects) {
  const modifiedTimestamps = (objects || [])
    .map((item) => parseDateMs(item.modifiedDate))
    .filter((timestamp) => timestamp !== null);
  if (!modifiedTimestamps.length) return null;

  const oneDayMs = 24 * 60 * 60 * 1000;
  const minDate = new Date(Math.min(...modifiedTimestamps) - oneDayMs);
  const maxDate = new Date(Math.max(...modifiedTimestamps));
  return { minDate, maxDate };
}

function isWithinDependencyTimeWindow(item, timeWindow) {
  if (!timeWindow) return true;
  const modified = parseDateMs(item.modifiedDate);
  if (modified === null) return false;
  return modified >= timeWindow.minDate.getTime() && modified <= timeWindow.maxDate.getTime();
}

function getDependencyParentRefs(item) {
  const refs = [];
  if (Array.isArray(item?.parentObjects)) {
    for (const parent of item.parentObjects) {
      const normalized = normalizeObject(parent);
      if (normalized.schemaName && normalized.objectName) refs.push(normalized);
    }
  }

  if (item?.parentSchemaName && item?.parentObjectName) {
    refs.push(normalizeObject({
      objectType: item.parentObjectType || "",
      schemaName: item.parentSchemaName,
      objectName: item.parentObjectName,
    }));
  }

  return refs.filter((ref, index, all) =>
    all.findIndex((candidate) => objectKey(candidate) === objectKey(ref)) === index
  );
}

function formatDependencyParentRefs(item) {
  const refs = getDependencyParentRefs(item);
  return refs.length
    ? refs.map((ref) => `${ref.schemaName}.${ref.objectName}`).join(", ")
    : "—";
}

function mergeDependencyCandidates(items) {
  const byKey = new Map();
  for (const raw of items || []) {
    const normalized = normalizeObject(raw);
    if (!normalized.objectType || !normalized.schemaName || !normalized.objectName) continue;
    const key = objectKey(normalized);
    const existing = byKey.get(key);
    const parentObjects = [
      ...(existing?.parentObjects || []),
      ...getDependencyParentRefs(raw),
    ];
    const mergedParents = parentObjects.filter((ref, index, all) =>
      all.findIndex((candidate) => objectKey(candidate) === objectKey(ref)) === index
    );

    byKey.set(key, {
      ...(existing || {}),
      ...raw,
      ...normalized,
      parentObjects: mergedParents,
    });
  }
  return [...byKey.values()];
}

function dependencyRootKey(item) {
  const normalized = normalizeObject(item);
  return `${normalized.objectType}|${normalized.schemaName.toLowerCase()}|${normalized.objectName.toLowerCase()}`;
}

function getDependencyProfileCache(profileId) {
  const key = String(profileId || "");
  if (!dependencyFetchCache.has(key)) {
    dependencyFetchCache.set(key, {
      all: { processedRoots: new Set(), rowsByRoot: new Map() },
      window: { processedRoots: new Set(), rowsByRoot: new Map() },
    });
  }
  return dependencyFetchCache.get(key);
}

function clearDependencyProfileCache(profileId) {
  dependencyFetchCache.delete(String(profileId || ""));
}

function dependencyWindowKey(timeWindow) {
  if (!timeWindow) return "no-window";
  return `${timeWindow.minDate.toISOString()}|${timeWindow.maxDate.toISOString()}`;
}

function getDependencyScopeCache(profileCache, scope, timeWindow) {
  if (scope === "allDependencies") return profileCache.all;
  return profileCache.window;
}

function getDependencyRowsForRoot(scopeCache, root) {
  return scopeCache.rowsByRoot.get(dependencyRootKey(root)) || [];
}

function setDependencyRowsForRoot(scopeCache, root, rows) {
  const rootKey = dependencyRootKey(root);
  scopeCache.processedRoots.add(rootKey);
  scopeCache.rowsByRoot.set(rootKey, mergeDependencyCandidates(rows));
}

function collectDependencyRows(scopeCache, roots) {
  return mergeDependencyCandidates((roots || []).flatMap((root) => getDependencyRowsForRoot(scopeCache, root)));
}

function groupDependencyRowsByParent(rows, roots) {
  const rootKeySet = new Set((roots || []).map((root) => dependencyRootKey(root)));
  const rowsByRoot = new Map();
  for (const row of rows || []) {
    const parents = getDependencyParentRefs(row).filter((parent) => rootKeySet.has(dependencyRootKey(parent)));
    for (const parent of parents) {
      const key = dependencyRootKey(parent);
      if (!rowsByRoot.has(key)) rowsByRoot.set(key, []);
      rowsByRoot.get(key).push(row);
    }
  }
  return rowsByRoot;
}

function filterObjectsNotInSelection(items, selectedObjects) {
  const selectedKeys = new Set((selectedObjects || []).map((item) => objectKey(normalizeObject(item))));
  return mergeDependencyCandidates(items || []).filter((item) => !selectedKeys.has(objectKey(item)));
}

function formatTimeOnly(d) {
  const parts = formatDateParts(d);
  return parts ? `${parts.hh}:${parts.mi}:${parts.ss}` : "—";
}

function buildTimestampFileSuffix(date = new Date()) {
  const parts = formatDateParts(date);
  return parts ? `${parts.yyyy}${parts.mm}${parts.dd}_${parts.hh}${parts.mi}${parts.ss}` : "export";
}

function formatDurationMmSs(startValue, endValue = Date.now()) {
  const start = new Date(startValue).getTime();
  const end = endValue instanceof Date ? endValue.getTime() : new Date(endValue).getTime();
  if (isNaN(start) || isNaN(end)) {
    return "—";
  }

  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${padDatePart(minutes)}:${padDatePart(seconds)}`;
}

function getSharedSelectionViewObjects() {
  const filterText = ($("objectsFilterInput")?.value || "").toLowerCase().trim();
  const filtered = filterText
    ? sharedSelectedObjects.filter((o) => {
        const combined = `${o.schemaName || ""}.${o.objectName || ""}`;
        return [o.objectType, combined].some((s) => String(s || "").toLowerCase().includes(filterText));
      })
    : sharedSelectedObjects;

  return {
    filterText,
    filtered,
    sorted: sortObjects(filtered, _selectionSort),
  };
}

function exportSharedSelectionList() {
  const { sorted } = getSharedSelectionViewObjects();
  if (!sorted.length) {
    showToast("No objects to export", true);
    return;
  }

  const csvEscape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["Type", "Object", "Created", "Modified", "Origin"],
    ...sorted.map((item) => [
      item.objectType || "",
      `${item.schemaName || ""}.${item.objectName || ""}`.replace(/^\./, ""),
      formatDateTime(item.createdDate),
      formatDateTime(item.modifiedDate),
      objectOriginLabel(item),
    ]),
  ].map((row) => row.map(csvEscape).join(",")).join("\n");

  const blob = new Blob([lines], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `object-list_${buildTimestampFileSuffix()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${sorted.length} objects`);
}

function setupPanelToggles({ maximizeToggleId, wrapperId, bodyId, focusTargetId = null }) {
  const maximizeToggle = $(maximizeToggleId);
  const wrap = $(wrapperId);
  const body = $(bodyId);
  const focusTarget = focusTargetId ? $(focusTargetId) : null;
  if (!maximizeToggle || !wrap || !body) return;

  const syncState = () => {
    const maximized = wrap.classList.contains("maximized");

    maximizeToggle.innerHTML = maximized ? "&#x2199;" : "&#x2197;";
    maximizeToggle.title = maximized ? "Restore" : "Maximize";
    maximizeToggle.setAttribute("aria-pressed", String(maximized));
    maximizeToggle.setAttribute("aria-label", maximized ? "Restore section" : "Maximize section");
    body.removeAttribute("aria-hidden");
    body.hidden = false;
  };

  maximizeToggle.addEventListener("click", () => {
    const shouldMaximize = !wrap.classList.contains("maximized");

    document.querySelectorAll(".maximizable-wrap.maximized").forEach((panel) => {
      if (panel !== wrap) {
        panel.classList.remove("maximized");
      }
    });

    wrap.classList.toggle("maximized", shouldMaximize);
    syncState();

    if (shouldMaximize) {
      if (focusTargetId === "sharedObjectText" || focusTargetId === "sharedObjectEditor") {
        focusSharedObjectEntry();
      } else if (focusTarget && typeof focusTarget.focus === "function") {
        focusTarget.focus({ preventScroll: true });
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && wrap.classList.contains("maximized")) {
      wrap.classList.remove("maximized");
      syncState();
    }
  });

  syncState();
}

function tabInit() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
      button.classList.add("active");
      $(`tab-${button.dataset.tab}`).classList.add("active");
      if (button.dataset.tab === "formatter") {
        requestAnimationFrame(() => getFormatterWorkbench()?.layout?.());
      }
    });
  });
}

function setActiveTab(tabName) {
  const tabButton = document.querySelector(`.tab[data-tab='${tabName}']`);
  if (tabButton && !tabButton.classList.contains("hidden")) {
    tabButton.click();
    return;
  }

  getDefaultVisibleTabButton()?.click();
}

function applyTabVisibility(hiddenTabs) {
  const hiddenSet = new Set(Array.isArray(hiddenTabs) ? hiddenTabs : []);
  document.querySelectorAll(".tab[data-tab]").forEach((btn) => {
    if (btn.dataset.tab === "customize") return;
    btn.classList.toggle("hidden", hiddenSet.has(btn.dataset.tab));
  });
  document.querySelectorAll("[data-tab-vis]").forEach((cb) => {
    cb.checked = !hiddenSet.has(cb.dataset.tabVis);
  });
  const activeTab = getActiveTabName();
  if (hiddenSet.has(activeTab)) {
    getDefaultVisibleTabButton()?.click();
  }
}

// ─── Parallel Tasks Panel ──────────────────────────────────────────────────

function renderParallelTasksPanel() {
  const panel = $("parallelTasksPanel");
  const list = $("parallelTasksList");
  const badge = $("tasksBadge");
  const showBtn = $("showTasksBtn");
  if (!panel || !list) return;

  const tasks = [..._runningTasksMap.values()];
  const count = tasks.length;

  if (badge) badge.textContent = String(count);
  if (showBtn) showBtn.classList.toggle("hidden", count === 0);

  const title = $("parallelTasksTitle");
  if (title) title.textContent = `Active Tasks (${count})`;

  list.innerHTML = tasks.map((t) => {
    const pct = t.percent ?? 0;
    const typeKey = (t.taskType || "").toLowerCase();
    const label = t.progressLabel || t.operation || "Running…";
    return `<div class="parallel-task-row" data-task-id="${escapeHtml(t.taskId)}">
      <div class="parallel-task-row-header">
        <span class="parallel-task-name">${escapeHtml(t.taskType || "Task")}</span>
        <span class="parallel-task-type type-${typeKey}">${escapeHtml(t.taskType || "")}</span>
      </div>
      <div class="parallel-task-bar-track"><div class="parallel-task-bar-fill" style="width:${pct}%"></div></div>
      <div class="parallel-task-label">${escapeHtml(label)}</div>
    </div>`;
  }).join("");

  if (count > 0 && !panel.classList.contains("hidden")) panel.classList.remove("hidden");
}

function setupParallelTasksPanel() {
  const closeBtn = $("closeParallelPanel");
  if (closeBtn) closeBtn.onclick = () => $("parallelTasksPanel")?.classList.add("hidden");

  const showBtn = $("showTasksBtn");
  if (showBtn) showBtn.onclick = () => {
    const panel = $("parallelTasksPanel");
    if (panel) panel.classList.toggle("hidden");
  };
}

// Simple pagination utility
function paginate(array, page = 1, pageSize = 20) {
  const total = array.length;
  const pages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  return {
    items: array.slice(start, end),
    page,
    pages,
    total,
  };
}

function healthDot(profileId) {
  const h = _profileHealth.get(profileId);
  if (!h) return `<span class="health-dot health-unknown" title="Not tested"></span>`;
  if (h.status === "ok") {
    const ago = h.testedAt ? `Tested ${_timeAgo(h.testedAt)}` : "OK";
    return `<span class="health-dot health-ok" title="${ago}"></span>`;
  }
  const msg = h.errorMessage ? `Error: ${h.errorMessage}` : "Connection failed";
  return `<span class="health-dot health-error" title="${msg}"></span>`;
}

function _timeAgo(iso) {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function renderProfilesTable(profiles, page = 1, pageSize = 20) {
  const sortedProfiles = sortProfiles(profiles, _profileSort);
  const { items, pages } = paginate(sortedProfiles, page, pageSize);
  const rows = items
    .map(
      (p) => `<tr>
<td>${healthDot(p.id)} ${escapeHtml(p.profileLabel)}</td>
<td>${escapeHtml(p.serverName)}</td>
<td>${escapeHtml(p.databaseName)}</td>
        <td>${escapeHtml(formatAuthenticationTypeLabel(p.authenticationType))}</td>
<td>${escapeHtml(p.environmentTag || "")}</td>
<td>
  <button data-edit='${p.id}'>Edit</button>
  <button data-test='${p.id}'>Test</button>
  <button data-diag='${p.id}'>Diagnose</button>
  <button data-delete='${p.id}'>Delete</button>
</td>
</tr>`
    )
    .join("");

  let paginationHtml = "";
  if (pages > 1) {
    paginationHtml = `<div class='pagination'>`;
    for (let i = 1; i <= pages; i++) {
      paginationHtml += `<button class='page-btn' data-page='${i}'>${i}</button>`;
    }
    paginationHtml += `</div>`;
  }

  const sortArrow = (col) => _profileSort.col === col ? (_profileSort.dir === "asc" ? " ↑" : " ↓") : "";
  const profileSortHeader = (col, label) => `<th data-sort-profile="${col}" style="cursor:pointer;user-select:none">${label}${sortArrow(col)}</th>`;

  $("profilesTable").innerHTML = `
<table class='table'>
<thead><tr>${profileSortHeader("profileLabel", "Connection Alias")}${profileSortHeader("serverName", "SQL Server")}${profileSortHeader("databaseName", "Database")}${profileSortHeader("authenticationType", "Authentication")}${profileSortHeader("environmentTag", "Environment")}<th>Actions</th></tr></thead>
<tbody>${rows}</tbody>
</table>
${paginationHtml}`;

  document.querySelectorAll("[data-sort-profile]").forEach((th) => {
    th.onclick = () => {
      const col = th.dataset.sortProfile;
      if (_profileSort.col === col) {
        _profileSort.dir = _profileSort.dir === "asc" ? "desc" : "asc";
      } else {
        _profileSort = { col, dir: "asc" };
      }
      renderProfilesTable(profiles, 1, pageSize);
    };
  });

  document.querySelectorAll("button[data-edit]").forEach((btn) => {
    btn.onclick = () => beginEditProfile(btn.dataset.edit, profiles);
  });

  document.querySelectorAll("button[data-test]").forEach((btn) => {
    btn.onclick = async () => {
      const restore = setButtonLoading(btn, "Connecting...");
      try {
        showToast("Connecting...", false);
        const result = await api(`/api/profiles/${btn.dataset.test}/test`, { method: "POST" });
        _profileHealth.set(btn.dataset.test, { status: "ok", testedAt: new Date().toISOString() });
        showToast(`Connection OK: ${result.result.serverName} / ${result.result.databaseName}`);
        await refreshProfiles();
      } catch (error) {
        _profileHealth.set(btn.dataset.test, { status: "error", testedAt: new Date().toISOString(), errorMessage: error.message });
        showToast(error.message, true);
        await refreshProfiles();
      } finally {
        restore();
      }
    };
  });

  document.querySelectorAll("button[data-delete]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("Delete this profile?")) return;
      try {
        await api(`/api/profiles/${btn.dataset.delete}`, { method: "DELETE" });
        showToast("Connection deleted");
        await refreshProfiles();
      } catch (error) {
        showToast(error.message, true);
      }
    };
  });

  document.querySelectorAll("button[data-diag]").forEach((btn) => {
    btn.onclick = async () => {
      const restore = setButtonLoading(btn, "Diagnosing...");
      try {
        $("diagnosticsResult").textContent = "Running diagnostics...";
        showToast("Running diagnostics...", false);
        const result = await api(`/api/profiles/${btn.dataset.diag}/diagnostics`, { method: "POST" });
        $("diagnosticsResult").textContent = JSON.stringify(result, null, 2);
        showToast(`Diagnostics complete: ${result.summary.status}`);
      } catch (error) {
        showToast(error.message, true);
      } finally {
        restore();
      }
    };
  });

  document.querySelectorAll(".page-btn").forEach((btn) => {
    btn.onclick = () => renderProfilesTable(profiles, Number(btn.dataset.page), pageSize);
  });
}

function beginEditProfile(id, profiles) {
  const p = profiles.find((x) => x.id === id);
  if (!p) return;
  $("profileId").value = p.id;
  $("profileLabel").value = p.profileLabel;
  $("serverName").value = p.serverName;
  $("databaseName").value = p.databaseName;
  $("authenticationType").value = p.authenticationType;
  $("username").value = p.username || "";
  $("password").value = "";
  const pwdField = $("password");
  if (pwdField) {
    pwdField.placeholder = p.passwordSet && p.authenticationType === "Sql"
      ? "Leave blank to keep saved password"
      : "Enter password";
  }
  $("environmentTag").value = p.environmentTag || "";
  updateAuthenticationFieldVisibility();
  showToast("Loaded connection details", false);
}

function clearProfileForm() {
  $("profileId").value = "";
  $("profileLabel").value = "";
  $("serverName").value = "";
  $("databaseName").value = "";
  $("authenticationType").value = "Windows";
  $("username").value = "";
  $("password").value = "";
  const pwdField = $("password");
  if (pwdField) pwdField.placeholder = "Enter password";
  $("environmentTag").value = "";
  updateAuthenticationFieldVisibility();
  showToast("Cleared connection form", false);
}

function syncSharedObjectSummary() {
  const count = sharedSelectedObjects.length;
  const text = count > 0 ? `Objects selected: ${count}` : "No objects selected. Open the Object Selection tab.";

  $("diffObjectSummary").textContent = text;
  $("backupObjectSummary").textContent = text;
  $("deployObjectSummary").textContent = text;
}

function renderSharedSelectionTable() {
  syncSharedObjectSummary();

  if (sharedSelectedObjects.length === 0) {
    $("sharedSelectionTable").innerHTML = "<p>No objects selected.</p>";
    return;
  }

  const { filterText, filtered, sorted } = getSharedSelectionViewObjects();

  const rows = sorted
    .map(
      (o) => {
        const realIdx = sharedSelectedObjects.indexOf(o);
        const fullName = escapeHtml(`${o.schemaName}.${o.objectName}`);
        return `<tr>
<td>${escapeHtml(o.objectType)}</td>
<td class="obj-name-cell"><span class="obj-schema">${escapeHtml(o.schemaName)}</span><span class="obj-dot">.</span><span class="obj-name">${escapeHtml(o.objectName)}</span>
  <button class="btn-copy-inline" data-copy="${fullName}" title="Copy name">&#x2398;</button></td>
<td>${formatDateTime(o.createdDate)}</td><td>${formatDateTime(o.modifiedDate)}</td>
<td><span class="selection-origin selection-origin-${objectOrigin(o)}">${objectOriginLabel(o)}</span></td>
<td><button data-remove-shared='${realIdx}'>Remove</button></td>
</tr>`;
      }
    )
    .join("");

  const countNote = filterText && filtered.length !== sharedSelectedObjects.length
    ? `<div class="muted" style="font-size:0.78rem;margin-bottom:0.4rem">Showing ${filtered.length} of ${sharedSelectedObjects.length} objects</div>`
    : "";

  const sortArrow = (col) => _selectionSort.col === col ? (_selectionSort.dir === "asc" ? " ↑" : " ↓") : "";
  const thClass = (col) => `style="cursor:pointer;user-select:none"`;

  $("sharedSelectionTable").innerHTML = `${countNote}
<table class='table'>
<thead><tr>
  <th data-sort-sel="type" ${thClass("type")}>Type${sortArrow("type")}</th>
  <th data-sort-sel="object" ${thClass("object")}>Object${sortArrow("object")}</th>
  <th data-sort-sel="created" ${thClass("created")}>Created${sortArrow("created")}</th>
  <th data-sort-sel="modified" ${thClass("modified")}>Modified${sortArrow("modified")}</th>
  <th>Origin</th>
  <th></th>
</tr></thead>
<tbody>${rows || "<tr><td colspan='6' class='muted' style='text-align:center;padding:1rem'>No objects match filter.</td></tr>"}</tbody>
</table>`;

  document.querySelectorAll("[data-sort-sel]").forEach((th) => {
    th.onclick = () => {
      const col = th.dataset.sortSel;
      if (_selectionSort.col === col) {
        _selectionSort.dir = _selectionSort.dir === "asc" ? "desc" : "asc";
      } else {
        _selectionSort = { col, dir: "asc" };
      }
      renderSharedSelectionTable();
    };
  });

  document.querySelectorAll("button[data-remove-shared]").forEach((btn) => {
    btn.onclick = () => {
      const index = Number(btn.dataset.removeShared);
      sharedSelectedObjects.splice(index, 1);
      renderSharedSelectionTable();
      persistCurrentAppState({ delay: 0 });
      showToast("Removed object from selection");
    };
  });

  document.querySelectorAll(".btn-copy-inline").forEach((btn) => {
    btn.onclick = () => copyToClipboard(btn.dataset.copy);
  });

  document.dispatchEvent(new CustomEvent("pebloy:selection-changed", {
    detail: { count: sharedSelectedObjects.length },
  }));
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(
    () => showToast(`Copied: ${text}`),
    () => showToast("Copy failed", true)
  );
}

function addToSharedSelection(items) {
  sharedSelectedObjects = dedupeObjects([...sharedSelectedObjects, ...items]);
  renderSharedSelectionTable();
  persistCurrentAppState({ delay: 0 });
}

function renderSharedObjectPicker(page) {
  const sortedDiscovered = sortObjects(sharedDiscoveredObjects, _discoveredSort);
  const sortArrow = (col) => _discoveredSort.col === col ? (_discoveredSort.dir === "asc" ? " ↑" : " ↓") : "";

  const total = sortedDiscovered.length;
  const usePagination = total > DISCOVER_PAGE_SIZE;
  const pages = usePagination ? Math.ceil(total / DISCOVER_PAGE_SIZE) : 1;
  _discoverPage = Math.min(Math.max(1, page ?? _discoverPage), pages);
  const pageItems = usePagination
    ? sortedDiscovered.slice((_discoverPage - 1) * DISCOVER_PAGE_SIZE, _discoverPage * DISCOVER_PAGE_SIZE)
    : sortedDiscovered;

  const rows = pageItems
    .map((o) => {
      const origIdx = sharedDiscoveredObjects.indexOf(o);
      return `<tr>
<td><input type='checkbox' data-discovered='${origIdx}' checked /></td>
<td>${escapeHtml(o.objectType)}</td>
<td class="obj-name-cell"><span class="obj-schema">${escapeHtml(o.schemaName)}</span><span class="obj-dot">.</span><span class="obj-name">${escapeHtml(o.objectName)}</span></td>
<td>${formatDateTime(o.createdDate)}</td><td>${formatDateTime(o.modifiedDate)}</td>
</tr>`;
    })
    .join("");

  let paginationHtml = "";
  if (usePagination) {
    const prevDisabled = _discoverPage === 1 ? " disabled" : "";
    const nextDisabled = _discoverPage === pages ? " disabled" : "";
    const start = (_discoverPage - 1) * DISCOVER_PAGE_SIZE + 1;
    const end = Math.min(_discoverPage * DISCOVER_PAGE_SIZE, total);
    paginationHtml = `
<div class="pagination" style="display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap;margin-top:0.4rem">
  <button class="page-btn" id="discoverPrev"${prevDisabled}>&#8249; Prev</button>
  <span class="muted" style="font-size:0.82rem">${start}–${end} of ${total}</span>
  <button class="page-btn" id="discoverNext"${nextDisabled}>Next &#8250;</button>
  <label style="font-size:0.82rem;margin-left:0.5rem">Page
    <input id="discoverJumpPage" type="number" min="1" max="${pages}" value="${_discoverPage}"
      style="width:3.5rem;margin-left:0.25rem;padding:0.1rem 0.3rem;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text)" />
    of ${pages}
  </label>
</div>`;
  }

  $("sharedObjectPicker").innerHTML = `
<table class='table'>
<thead><tr>
  <th><input type='checkbox' id='selectAllDiscoveredCb' title='Select or clear all' checked /></th>
  <th data-sort-disc="type" style="cursor:pointer;user-select:none">Type${sortArrow("type")}</th>
  <th data-sort-disc="object" style="cursor:pointer;user-select:none">Object${sortArrow("object")}</th>
  <th data-sort-disc="created" style="cursor:pointer;user-select:none">Created${sortArrow("created")}</th>
  <th data-sort-disc="modified" style="cursor:pointer;user-select:none">Modified${sortArrow("modified")}</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>
${paginationHtml}`;

  document.querySelectorAll("[data-sort-disc]").forEach((th) => {
    th.onclick = () => {
      const col = th.dataset.sortDisc;
      if (_discoveredSort.col === col) {
        _discoveredSort.dir = _discoveredSort.dir === "asc" ? "desc" : "asc";
      } else {
        _discoveredSort = { col, dir: "asc" };
      }
      _discoverPage = 1;
      renderSharedObjectPicker(1);
    };
  });

  if (usePagination) {
    const prevBtn = document.getElementById("discoverPrev");
    const nextBtn = document.getElementById("discoverNext");
    const jumpInput = document.getElementById("discoverJumpPage");
    if (prevBtn) prevBtn.onclick = () => renderSharedObjectPicker(_discoverPage - 1);
    if (nextBtn) nextBtn.onclick = () => renderSharedObjectPicker(_discoverPage + 1);
    if (jumpInput) {
      jumpInput.onchange = () => {
        const p = Math.min(Math.max(1, Number.parseInt(jumpInput.value, 10) || 1), pages);
        renderSharedObjectPicker(p);
      };
    }
  }
}

async function refreshProfiles() {
  const profiles = await api("/api/profiles");
  renderProfilesTable(profiles);

  [
    "objectsProfile",
    "diffSourceProfile",
    "diffDestProfile",
    "backupProfile",
    "deploySourceProfile",
    "deployDestProfile",
  ].forEach((id) => {
    const select = $(id);
    if (!select) return;
    const current = select.value;
    select.innerHTML = `<option value=''>Select connection</option>${profiles
      .map((p) => {
        const h = _profileHealth.get(p.id);
        const healthNote = !h ? " [never tested]" : h.status === "ok" ? ` [OK ${_timeAgo(h.testedAt)}]` : ` [FAIL]`;
        return `<option value='${p.id}'>${escapeHtml(p.profileLabel)} (${escapeHtml(p.serverName)}/${escapeHtml(p.databaseName)})${healthNote}</option>`;
      })
      .join("")}`;
    if (profiles.some((p) => p.id === current)) {
      select.value = current;
    }
  });
}

function setupProfileForm() {
  const authTypeEl = $("authenticationType");
  if (authTypeEl) {
    authTypeEl.addEventListener("change", () => {
      const pwdField = $("password");
      if (pwdField && authTypeEl.value !== "Sql") {
        pwdField.placeholder = "Enter password";
      }
      updateAuthenticationFieldVisibility();
    });
    updateAuthenticationFieldVisibility();
  }

  $("profileForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      profileLabel: $("profileLabel").value,
      serverName: $("serverName").value,
      databaseName: $("databaseName").value,
      authenticationType: $("authenticationType").value,
      username: $("username").value,
      password: $("password").value,
      environmentTag: $("environmentTag").value,
    };

    try {
      if ($("profileId").value) {
        showToast("Saving connection changes...", false);
        await api(`/api/profiles/${$("profileId").value}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        showToast("Connection updated");
      } else {
        showToast("Creating connection...", false);
        await api("/api/profiles", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        showToast("Connection created");
      }
      clearProfileForm();
      await refreshProfiles();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("clearProfile").onclick = clearProfileForm;
}

function updateAuthenticationFieldVisibility() {
  const authType = $("authenticationType")?.value;
  const isSql = authType === "Sql";
  ["usernameField", "passwordField"].forEach((id) => {
    const field = $(id);
    if (field) field.classList.toggle("hidden", !isSql);
  });

  const username = $("username");
  const password = $("password");
  if (username) username.disabled = !isSql;
  if (password) password.disabled = !isSql;
}

function applyObjectModeUI() {
  const mode = $("objectsMode").value;
  $("objectsSpecifySection").classList.toggle("hidden", mode !== "Specify");
  $("objectsDiscoverSection").classList.toggle("hidden", mode !== "Discover");
}

async function discoverSharedObjects() {
  const profileId = $("objectsProfile").value;
  if (!profileId) {
    endTaskProgress("objects", false, "Objects");
    showToast("Choose a source connection on the Objects tab", true);
    return;
  }

  const params = new URLSearchParams({
    profileId,
    type: $("sharedTypeFilter").value,
    schema: $("sharedSchemaFilter").value,
    search: $("sharedNameFilter").value,
  });

  beginTaskProgress("objects", "Loading database objects...");
  showToast("Loading database objects...", false);
  sharedDiscoveredObjects = dedupeObjects(await api(`/api/objects?${params.toString()}`));
  _discoverPage = 1;
  updateTaskProgress("objects", `Rendering ${sharedDiscoveredObjects.length} discovered objects...`, 85);
  renderSharedObjectPicker(1);
  endTaskProgress("objects", true, "Objects");
  showToast(`Discovered ${sharedDiscoveredObjects.length} objects`);
}

async function populateDiscoverDropdowns() {
  const profileId = $("objectsProfile").value;
  if (!profileId) return;
  try {
    const params = new URLSearchParams({ profileId });
    const { types: typeOptions, schemas: schemaOptions } = await api(`/api/objects/filters?${params.toString()}`);
    const typeSel = $("sharedTypeFilter");
    const schemaSel = $("sharedSchemaFilter");
    typeSel.innerHTML = '<option value="">(All Types)</option>' + typeOptions.map(t => `<option value="${t}">${t}</option>`).join("");
    schemaSel.innerHTML = '<option value="">(All Schemas)</option>' + schemaOptions.map(s => `<option value="${s}">${s}</option>`).join("");
  } catch (error) {
    showToast(`Could not load discover dropdowns: ${error.message}`, true);
  }
}

async function resolveAndAdd() {
  const profileId = $("objectsProfile").value;
  if (!profileId) {
    endTaskProgress("objects", false, "Objects");
    showToast("Choose a source connection first", true);
    return;
  }
  const parsed = parseObjectLines(getSharedObjectTextValue());
  if (!parsed.length) {
    endTaskProgress("objects", false, "Objects");
    showToast("No valid object names found", true);
    return;
  }

  try {
    beginTaskProgress("objects", `Resolving ${parsed.length} object type${parsed.length === 1 ? "" : "s"}...`);
    showToast("Resolving object types...", false);
    const resolved = await api("/api/objects/resolve-types", {
      method: "POST",
      body: JSON.stringify({
        profileId,
        objects: parsed.map((o) => ({ schemaName: o.schemaName, objectName: o.objectName })),
      }),
    });
    // Build case-insensitive lookup keyed by user input; value is the DB-authoritative record
    const resolvedMap = new Map();
    const resolutionSummary = { ambiguous: 0, notFound: 0 };
    for (const r of resolved) {
      const key = `${String(r.inputSchemaName || "").trim().toLowerCase()}|${String(r.inputObjectName || "").trim().toLowerCase()}`;
      if (r.matchStatus === "Ambiguous") resolutionSummary.ambiguous += 1;
      if (r.matchStatus === "NotFound") resolutionSummary.notFound += 1;
      resolvedMap.set(key, {
        objectType:   String(r.objectType || "").toUpperCase(),
        schemaName:   String(r.schemaName || "").trim(),   // DB-authoritative casing
        objectName:   String(r.objectName || "").trim(),   // DB-authoritative casing
        createdDate:  r.createdDate ?? null,
        modifiedDate: r.modifiedDate ?? null,
        matchStatus:  r.matchStatus || "Resolved",
      });
    }
    for (const o of parsed) {
      const key = `${String(o.schemaName || "").toLowerCase()}|${String(o.objectName || "").toLowerCase()}`;
      const res = resolvedMap.get(key);
      if (res) {
        o.objectType  = res.objectType;
        o.schemaName  = res.schemaName;   // replace with DB-authoritative casing
        o.objectName  = res.objectName;   // replace with DB-authoritative casing
        o.createdDate = res.createdDate;
        o.modifiedDate = res.modifiedDate;
      }
    }
    updateTaskProgress("objects", "Applying resolved object metadata...", 80);
  } catch (error) {
    endTaskProgress("objects", false, "Objects");
    showToast(`Type resolution failed: ${error.message}`, true);
    return;
  }

  const valid = parsed.filter((o) => o.objectType && o.schemaName && o.objectName);
  const unresolved = parsed.length - valid.length;
  if (!valid.length) {
    endTaskProgress("objects", false, "Objects");
    showToast("No objects could be resolved. Check the profile and object names.", true);
    return;
  }

  addToSharedSelection(valid);
  setSharedObjectTextValue("");
  persistCurrentAppState({ delay: 0 });
  endTaskProgress("objects", true, "Objects");
  showToast(
    unresolved > 0
      ? `Added ${valid.length} objects (${unresolved} unresolved: use schema-qualified names when duplicates exist or verify missing objects in Discover mode.)`
      : `Added ${valid.length} objects with resolved types`
  );
}

async function fetchDependenciesForSelection() {
  const profileId = $("objectsProfile").value;
  if (!profileId) {
    showToast("Choose a source connection first", true);
    return;
  }
  if (!sharedSelectedObjects.length) {
    showToast("Select at least one object before fetching dependencies", true);
    return;
  }

  const selectedCountBeforeCleanup = sharedSelectedObjects.length;
  sharedSelectedObjects = dedupeObjects(sharedSelectedObjects);
  const cleanedExistingDuplicates = selectedCountBeforeCleanup - sharedSelectedObjects.length;
  if (cleanedExistingDuplicates > 0) {
    renderSharedSelectionTable();
    persistCurrentAppState({ delay: 0 });
  }

  const sourceObjects = [...sharedSelectedObjects];
  const timeWindow = buildDependencyTimeWindow(sourceObjects);
  beginTaskProgress("objects", `Opening dependency picker for ${sharedSelectedObjects.length} selected object${sharedSelectedObjects.length === 1 ? "" : "s"}...`);

  const selectedDependencies = await showDependencyPickerModal({
    requestedCount: sourceObjects.length,
    timeWindow,
    loadCandidates: (scope) => loadDependencyPickerCandidates({ profileId, sourceObjects, timeWindow, scope }),
    exportQuery: (scope) => exportDependencyQuery({ profileId, sourceObjects, timeWindow, scope }),
    refreshCache: () => clearDependencyProfileCache(profileId),
  });

  if (selectedDependencies === null) {
    endTaskProgress("objects", true, "Objects");
    showToast(cleanedExistingDuplicates > 0
      ? `Dependency import cancelled; removed ${cleanedExistingDuplicates} duplicate selected object${cleanedExistingDuplicates === 1 ? "" : "s"}`
      : "Dependency import cancelled");
    return;
  }

  if (!selectedDependencies.length) {
    endTaskProgress("objects", true, "Objects");
    showToast(cleanedExistingDuplicates > 0
      ? `No dependencies selected; removed ${cleanedExistingDuplicates} duplicate selected object${cleanedExistingDuplicates === 1 ? "" : "s"}`
      : "No dependencies selected for import");
    return;
  }

  const before = sharedSelectedObjects.length;
  const beforeUnique = dedupeObjects(sharedSelectedObjects).length;
  const importedDependencies = selectedDependencies.map((item) => ({ ...item, origin: "dependency" }));
  sharedSelectedObjects = dedupeObjects([...sharedSelectedObjects, ...importedDependencies]);
  renderSharedSelectionTable();
  persistCurrentAppState({ delay: 0 });
  endTaskProgress("objects", true, "Objects");

  const added = Math.max(0, sharedSelectedObjects.length - beforeUnique);
  const existingDuplicatesRemoved = cleanedExistingDuplicates + Math.max(0, before - beforeUnique);
  if (added > 0 && existingDuplicatesRemoved > 0) {
    showToast(`Added ${added} dependenc${added === 1 ? "y" : "ies"}; removed ${existingDuplicatesRemoved} duplicate selected object${existingDuplicatesRemoved === 1 ? "" : "s"}`);
  } else if (added > 0) {
    showToast(`Added ${added} dependenc${added === 1 ? "y" : "ies"} to the selection`);
  } else if (existingDuplicatesRemoved > 0) {
    showToast(`No new dependencies added; removed ${existingDuplicatesRemoved} duplicate selected object${existingDuplicatesRemoved === 1 ? "" : "s"}`);
  } else {
    showToast("Selected dependencies were already in the list");
  }
}

async function loadDependencyPickerCandidates({ profileId, sourceObjects, timeWindow, scope }) {
  const roots = dedupeObjects(sourceObjects);
  const activeScope = scope === "allDependencies" ? "allDependencies" : "windowDependencies";
  const profileCache = getDependencyProfileCache(profileId);
  const scopeCache = getDependencyScopeCache(profileCache, activeScope, timeWindow);
  const rootsToFetch = roots.filter((root) => !scopeCache.processedRoots.has(dependencyRootKey(root)));

  if (rootsToFetch.length) {
    updateTaskProgress("objects", `Fetching dependencies for ${rootsToFetch.length} new object${rootsToFetch.length === 1 ? "" : "s"}...`, 35);
    const result = await api("/api/objects/dependencies", {
      method: "POST",
      timeoutMs: DEPENDENCY_REQUEST_TIMEOUT_MS,
      body: JSON.stringify({
        profileId,
        objects: rootsToFetch,
        dateWindow: activeScope === "windowDependencies" && timeWindow
          ? { start: timeWindow.minDate.toISOString(), end: timeWindow.maxDate.toISOString() }
          : null,
      }),
    });

    const rowsByRoot = groupDependencyRowsByParent(
      Array.isArray(result.dependencies) ? result.dependencies : [],
      rootsToFetch
    );
    for (const root of rootsToFetch) {
      setDependencyRowsForRoot(scopeCache, root, rowsByRoot.get(dependencyRootKey(root)) || []);
    }
  } else {
    updateTaskProgress("objects", "Using cached dependency results...", 75);
  }

  const dependencies = filterObjectsNotInSelection(collectDependencyRows(scopeCache, roots), roots);

  updateTaskProgress("objects", "Preparing dependency picker...", 90);
  return {
    dependencies,
    requestedCount: roots.length,
    fetchedRootCount: rootsToFetch.length,
    cachedRootCount: roots.length - rootsToFetch.length,
  };
}

async function exportDependencyQuery({ profileId, sourceObjects, timeWindow, scope }) {
  const activeScope = scope === "allDependencies" ? "allDependencies" : "windowDependencies";
  const result = await api("/api/objects/dependencies/query", {
    method: "POST",
    timeoutMs: DEPENDENCY_REQUEST_TIMEOUT_MS,
    body: JSON.stringify({
      profileId,
      objects: dedupeObjects(sourceObjects),
      dateWindow: activeScope === "windowDependencies" && timeWindow
        ? { start: timeWindow.minDate.toISOString(), end: timeWindow.maxDate.toISOString() }
        : null,
    }),
  });

  const query = String(result.query || "").trim();
  if (!query) {
    showToast("No dependency query to export", true);
    return;
  }

  const suffix = activeScope === "allDependencies" ? "all" : "window";
  downloadTextFile(`fetch-dependencies_${suffix}_${buildTimestampFileSuffix()}.sql`, query + "\n", "text/x-sql");
  showToast("Dependency query exported");
}

function showDependencyPickerModal({ dependencies = [], requestedCount, timeWindow, loadCandidates = null, exportQuery = null, refreshCache = null }) {
  return new Promise((resolve) => {
    let dependencyItems = sortObjects(mergeDependencyCandidates(dependencies), { col: "modified", dir: "desc" });
    const selectedKeys = new Set();
    let scope = timeWindow ? "windowDependencies" : "allDependencies";
    let searchText = "";
    let loading = typeof loadCandidates === "function";
    let loadError = null;
    let initializedSelection = false;
    let closed = false;
    let loadGeneration = 0;
    let fetchedRootCount = 0;
    let cachedRootCount = 0;

    const dependencyWindowItems = () => timeWindow
      ? dependencyItems.filter((item) => isWithinDependencyTimeWindow(item, timeWindow))
      : [];

    const resetScopeIfNeeded = () => {
      if (scope === "windowDependencies" && dependencyWindowItems().length > 0) return;
      if (scope === "allDependencies" && dependencyItems.length > 0) return;
      if (timeWindow) scope = "windowDependencies";
      else scope = "allDependencies";
    };

    resetScopeIfNeeded();

    const visibleItems = () => {
      const scopedItems = scope === "windowDependencies" ? dependencyWindowItems() : dependencyItems;
      const query = searchText.trim().toLowerCase();
      if (!query) return scopedItems;
      return scopedItems.filter((item) => {
        const parentText = formatDependencyParentRefs(item);
        return [item.objectType, item.schemaName, item.objectName, parentText]
          .some((value) => String(value || "").toLowerCase().includes(query));
      });
    };

    const selectVisibleDefaults = () => {
      if (initializedSelection) return;
      const shown = visibleItems();
      if (!shown.length) return;
      for (const item of shown) {
        selectedKeys.add(objectKey(item));
      }
      initializedSelection = true;
    };

    selectVisibleDefaults();

    const overlay = document.createElement("div");
    overlay.className = "confirm-modal-overlay dependency-modal-overlay";
    overlay.innerHTML = `
      <div class="confirm-modal dependency-modal" role="dialog" aria-modal="true" aria-labelledby="dependencyModalTitle">
        <div class="dependency-modal-header">
          <div>
            <h4 id="dependencyModalTitle">Fetch Dependencies</h4>
            <p class="dependency-modal-summary"></p>
          </div>
          <button type="button" class="btn-ghost dependency-modal-close" title="Close">Close</button>
        </div>
        <div class="dependency-window-card">
          <strong>Time Window</strong>
          <span>${timeWindow ? `${formatDateTime(timeWindow.minDate)} to ${formatDateTime(timeWindow.maxDate)}` : "No valid modified dates on the current list; showing all dependencies."}</span>
        </div>
        <div class="dependency-modal-controls">
          <label class="flag-label"><input type="radio" name="dependencyScope" value="windowDependencies" /> <span data-dependency-label="windowDependencies"></span></label>
          <label class="flag-label"><input type="radio" name="dependencyScope" value="allDependencies" /> <span data-dependency-label="allDependencies"></span></label>
        </div>
        <div class="dependency-modal-search-row">
          <input id="dependencySearchInput" class="dependency-search-input" placeholder="Search by type, schema, object, or parent..." />
          <button type="button" class="btn-ghost btn-sm" data-dependency-select="all">Select All</button>
          <button type="button" class="btn-ghost btn-sm" data-dependency-select="none">Deselect All</button>
          <button type="button" class="btn-ghost btn-sm" data-dependency-export-query>Export Query</button>
          <button type="button" class="btn-ghost btn-sm" data-dependency-refresh-cache>Refresh Cache</button>
        </div>
        <div class="dependency-modal-count muted"></div>
        <div class="dependency-modal-table"></div>
        <div class="confirm-modal-actions dependency-modal-actions">
          <button type="button" class="btn-ghost" data-dependency-action="cancel">Cancel</button>
          <button type="button" class="btn-primary" data-dependency-action="import">Import Selected</button>
        </div>
      </div>`;

    const close = (value) => {
      closed = true;
      overlay.remove();
      resolve(value);
    };

    const render = () => {
      const windowCount = dependencyWindowItems().length;
      const shown = visibleItems();
      const selectedVisible = shown.filter((item) => selectedKeys.has(objectKey(item))).length;
      const summary = overlay.querySelector(".dependency-modal-summary");
      const table = overlay.querySelector(".dependency-modal-table");
      const count = overlay.querySelector(".dependency-modal-count");
      const importButton = overlay.querySelector("[data-dependency-action='import']");
      const selectAllButton = overlay.querySelector("[data-dependency-select='all']");
      const unselectAllButton = overlay.querySelector("[data-dependency-select='none']");
      const exportQueryButton = overlay.querySelector("[data-dependency-export-query]");
      const refreshCacheButton = overlay.querySelector("[data-dependency-refresh-cache]");

      summary.textContent = loading
        ? `Loading dependency candidates for ${requestedCount} selected object${requestedCount === 1 ? "" : "s"}...`
        : loadError
          ? `Could not load dependency candidates: ${loadError.message}`
          : `Fetched ${dependencyItems.length} missing dependenc${dependencyItems.length === 1 ? "y" : "ies"} from ${requestedCount} selected object${requestedCount === 1 ? "" : "s"}. ${cachedRootCount} root${cachedRootCount === 1 ? "" : "s"} reused from cache; ${fetchedRootCount} queried.`;

      overlay.querySelectorAll("input[name='dependencyScope']").forEach((input) => {
        input.checked = input.value === scope;
        input.disabled = loading || Boolean(loadError) ||
          (input.value === "windowDependencies" && !timeWindow) ||
          (input.value === "allDependencies" && dependencyItems.length === 0);
      });
      overlay.querySelector("[data-dependency-label='windowDependencies']").textContent = `Modified within calculated time window (${windowCount})`;
      overlay.querySelector("[data-dependency-label='allDependencies']").textContent = `All dependencies (${dependencyItems.length})`;

      count.textContent = loading
        ? "Loading..."
        : loadError
          ? "Loading failed. Close this window and try again."
          : `Showing ${shown.length} object${shown.length === 1 ? "" : "s"}; ${selectedVisible} selected in this view, ${selectedKeys.size} selected total.`;

      importButton.disabled = loading || Boolean(loadError) || selectedKeys.size === 0;
      selectAllButton.disabled = loading || Boolean(loadError) || shown.length === 0;
      unselectAllButton.disabled = loading || Boolean(loadError) || shown.length === 0;
      exportQueryButton.disabled = loading || typeof exportQuery !== "function";
      refreshCacheButton.disabled = loading || typeof refreshCache !== "function" || typeof loadCandidates !== "function";

      if (loading || loadError) {
        const message = loading ? "Loading dependency candidates..." : escapeHtml(loadError.message || "Unable to load dependency candidates.");
        table.innerHTML = `<table class="table"><tbody><tr><td class="muted dependency-empty-cell">${message}</td></tr></tbody></table>`;
        return;
      }

      const rows = shown.map((item, index) => {
        const key = objectKey(item);
        return `<tr>
<td><input type="checkbox" data-dependency-index="${index}" ${selectedKeys.has(key) ? "checked" : ""} /></td>
<td>${escapeHtml(item.objectType)}</td>
      <td>${escapeHtml(item.schemaName)}</td>
      <td>${escapeHtml(item.objectName)}</td>
<td>${formatDateTime(item.createdDate)}</td>
<td>${formatDateTime(item.modifiedDate)}</td>
      <td>${escapeHtml(formatDependencyParentRefs(item))}</td>
</tr>`;
      }).join("");

      table.innerHTML = `<table class="table">
      <thead><tr><th></th><th>Type</th><th>Schema</th><th>Object</th><th>Created</th><th>Modified</th><th>Parent Object</th></tr></thead>
      <tbody>${rows || "<tr><td colspan='7' class='muted dependency-empty-cell'>No dependencies match this scope or search.</td></tr>"}</tbody>
</table>`;

      table.querySelectorAll("[data-dependency-index]").forEach((checkbox) => {
        checkbox.onchange = () => {
          const item = shown[Number(checkbox.dataset.dependencyIndex)];
          const key = objectKey(item);
          if (checkbox.checked) selectedKeys.add(key);
          else selectedKeys.delete(key);
          render();
        };
      });
    };

    overlay.querySelectorAll("input[name='dependencyScope']").forEach((input) => {
      input.onchange = () => {
        scope = input.value;
        if (loadCandidates) loadScope(scope);
        else render();
      };
    });
    overlay.querySelector("#dependencySearchInput").oninput = (event) => {
      searchText = event.target.value || "";
      render();
    };
    overlay.querySelector("[data-dependency-select='all']").onclick = () => {
      for (const item of visibleItems()) selectedKeys.add(objectKey(item));
      render();
    };
    overlay.querySelector("[data-dependency-select='none']").onclick = () => {
      for (const item of visibleItems()) selectedKeys.delete(objectKey(item));
      render();
    };
    overlay.querySelector("[data-dependency-export-query]").onclick = async () => {
      if (typeof exportQuery !== "function") return;
      try {
        await exportQuery(scope);
      } catch (error) {
        showToast(`Export query failed: ${error.message}`, true);
      }
    };
    overlay.querySelector("[data-dependency-refresh-cache]").onclick = () => {
      if (typeof refreshCache !== "function" || typeof loadCandidates !== "function") return;
      refreshCache();
      selectedKeys.clear();
      initializedSelection = false;
      loadScope(scope);
      showToast("Dependency cache refreshed");
    };
    overlay.querySelector("[data-dependency-action='cancel']").onclick = () => close(null);
    overlay.querySelector(".dependency-modal-close").onclick = () => close(null);
    overlay.querySelector("[data-dependency-action='import']").onclick = () => {
      close(dependencyItems.filter((item) => selectedKeys.has(objectKey(item))));
    };
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close(null);
    });

    document.body.appendChild(overlay);
    render();
    overlay.querySelector("[data-dependency-action='import']").focus();

    function loadScope(nextScope) {
      const generation = ++loadGeneration;
      loading = true;
      loadError = null;
      render();

      Promise.resolve()
        .then(() => loadCandidates(nextScope))
        .then((result) => {
          if (closed || generation !== loadGeneration) return;
          requestedCount = result?.requestedCount || requestedCount;
          dependencyItems = sortObjects(mergeDependencyCandidates(result?.dependencies || []), { col: "modified", dir: "desc" });
          fetchedRootCount = Number(result?.fetchedRootCount || 0);
          cachedRootCount = Number(result?.cachedRootCount || 0);
          loading = false;
          resetScopeIfNeeded();
          selectVisibleDefaults();
          render();
        })
        .catch((error) => {
          if (closed || generation !== loadGeneration) return;
          loading = false;
          loadError = error instanceof Error ? error : new Error(String(error));
          render();
        });
    }

    if (loadCandidates) {
      loadScope(scope);
    }
  });
}

function transformSelection(ta, fn) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (s === e) {
    ta.value = fn(ta.value);
  } else {
    const before = ta.value.substring(0, s);
    const selected = ta.value.substring(s, e);
    const after = ta.value.substring(e);
    const transformed = fn(selected);
    ta.value = before + transformed + after;
    ta.setSelectionRange(s, s + transformed.length);
  }
}

function setupEditorShortcuts() {
  const ta = $("sharedObjectText");
  const findBar = $("editorFindBar");
  if (!ta || !findBar) return;

  let _matches = [], _matchIdx = 0;

  function getActiveEditorField() {
    const active = document.activeElement;
    return active === ta || active === $("findBarQuery") || active === $("findBarReplace");
  }

  function updateMatchCount() {
    $("findBarCount").textContent = editorHelpers.getFindCountText(_matches.length, _matchIdx);
  }

  function stepMatch(direction) {
    if (!_matches.length) return;
    selectMatch(editorHelpers.getNextFindMatchIndex(_matchIdx, _matches.length, direction));
  }

  function openFind(withReplace) {
    findBar.classList.remove("hidden");
    $("findBarReplaceRow").classList.toggle("hidden", !withReplace);
    const sel = ta.value.substring(ta.selectionStart, ta.selectionEnd);
    if (sel && !sel.includes("\n")) $("findBarQuery").value = sel;
    _matchIdx = -1;
    runFind({ keepFocus: true });
    $("findBarQuery").focus();
    $("findBarQuery").select();
  }

  function closeFind() {
    findBar.classList.add("hidden");
    ta.focus();
    _matches = [];
    _matchIdx = -1;
    $("findBarCount").textContent = "";
  }

  function runFind({ keepFocus = false } = {}) {
    const q = $("findBarQuery").value;
    _matches = [];
    if (!q) {
      _matchIdx = -1;
      $("findBarCount").textContent = "";
      return;
    }
    const text = ta.value;
    let pos = 0;
    while (pos <= text.length) {
      const idx = text.indexOf(q, pos);
      if (idx === -1) break;
      _matches.push(idx);
      pos = idx + Math.max(q.length, 1);
    }
    if (!_matches.length) {
      _matchIdx = -1;
    } else {
      _matchIdx = editorHelpers.normalizeFindMatchIndex(_matchIdx, _matches.length);
    }
    updateMatchCount();
    if (_matches.length && !keepFocus) selectMatch(_matchIdx);
  }

  function selectMatch(idx) {
    if (!_matches.length) return;
    _matchIdx = ((idx % _matches.length) + _matches.length) % _matches.length;
    const q = $("findBarQuery").value;
    ta.focus();
    ta.setSelectionRange(_matches[_matchIdx], _matches[_matchIdx] + q.length);
    updateMatchCount();
  }

  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  $("findBarQuery").addEventListener("input", () => {
    _matchIdx = -1;
    runFind({ keepFocus: true });
  });
  $("findBarPrev").onclick = () => stepMatch(-1);
  $("findBarNext").onclick = () => stepMatch(1);
  $("findBarToggleReplace").onclick = () => $("findBarReplaceRow").classList.toggle("hidden");
  $("findBarClose").onclick = closeFind;

  $("findBarReplaceOne").onclick = () => {
    if (!_matches.length) return;
    const q = $("findBarQuery").value;
    const r = $("findBarReplace").value;
    const pos = _matches[_matchIdx];
    ta.value = ta.value.substring(0, pos) + r + ta.value.substring(pos + q.length);
    ta.setSelectionRange(pos + r.length, pos + r.length);
    runFind({ keepFocus: true });
    $("findBarQuery").focus();
  };
  $("findBarReplaceAll").onclick = () => {
    const q = $("findBarQuery").value;
    const r = $("findBarReplace").value;
    if (!q) return;
    const count = (ta.value.match(new RegExp(escapeRegex(q), "g")) || []).length;
    ta.value = ta.value.split(q).join(r);
    _matchIdx = 0;
    runFind({ keepFocus: true });
    showToast(`Replaced ${count} occurrence(s)`);
    $("findBarQuery").focus();
  };

  $("findBarQuery").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); }
    if (e.key === "ArrowUp") { e.preventDefault(); stepMatch(-1); }
    if (e.key === "ArrowDown") { e.preventDefault(); stepMatch(1); }
    if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });

  $("findBarReplace").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("findBarReplaceOne").click(); }
    if (e.key === "ArrowUp") { e.preventDefault(); stepMatch(-1); }
    if (e.key === "ArrowDown") { e.preventDefault(); stepMatch(1); }
    if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });

  document.addEventListener("keydown", (e) => {
    const sc = getShortcuts();
    const objectsTabActive = document.querySelector(".tab.active")?.dataset.tab === "objects";
    if (!objectsTabActive || !getActiveEditorField()) return;

    if (matchesShortcut(e, sc.findInEditor || "Ctrl+F")) {
      e.preventDefault();
      e.stopPropagation();
      openFind(false);
      return;
    }
    if (matchesShortcut(e, sc.replaceInEditor || "Ctrl+H")) {
      e.preventDefault();
      e.stopPropagation();
      openFind(true);
    }
  }, true);

  ta.addEventListener("keydown", (e) => {
    const sc = getShortcuts();
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "d") {
      e.preventDefault();
      $("resolveAndAddObjects").click();
      return;
    }
    if (matchesShortcut(e, sc.findInEditor    || "Ctrl+F")) { e.preventDefault(); openFind(false); return; }
    if (matchesShortcut(e, sc.replaceInEditor || "Ctrl+H")) { e.preventDefault(); openFind(true);  return; }
    if (matchesShortcut(e, sc.uppercaseText   || "Ctrl+Shift+U")) { e.preventDefault(); transformSelection(ta, (s) => s.toUpperCase()); return; }
    if (matchesShortcut(e, sc.lowercaseText   || "Ctrl+Shift+L")) { e.preventDefault(); transformSelection(ta, (s) => s.toLowerCase()); return; }
  });
}

function setupEnhancedEditorShortcuts() {
  document.addEventListener("keydown", (e) => {
    const sc = getShortcuts();
    const objectsTabActive = document.querySelector(".tab.active")?.dataset.tab === "objects";
    const editor = getEnhancedTextEditor("sharedObjectText");
    if (!objectsTabActive || !editor?.isTextFocused?.()) return;

    if (matchesShortcut(e, sc.resolveObjects || "Ctrl+D")) {
      e.preventDefault();
      e.stopPropagation();
      $("resolveAndAddObjects")?.click();
      return;
    }
    if (matchesShortcut(e, sc.findInEditor || "Ctrl+F")) {
      e.preventDefault();
      e.stopPropagation();
      editor.openFind?.();
      return;
    }
    if (matchesShortcut(e, sc.replaceInEditor || "Ctrl+H")) {
      e.preventDefault();
      e.stopPropagation();
      editor.openReplace?.();
      return;
    }
    if (matchesShortcut(e, sc.uppercaseText || "Ctrl+Shift+U")) {
      e.preventDefault();
      e.stopPropagation();
      editor.transformSelection?.((text) => text.toUpperCase());
      return;
    }
    if (matchesShortcut(e, sc.lowercaseText || "Ctrl+Shift+L")) {
      e.preventDefault();
      e.stopPropagation();
      editor.transformSelection?.((text) => text.toLowerCase());
    }
  }, true);
}

async function setupObjectsTab() {
  $("objectsProfile").onchange = () => {
    if ($("objectsMode").value === "Discover") {
      populateDiscoverDropdowns();
    }
  };
  $("objectsMode").onchange = () => {
    applyObjectModeUI();
    if ($("objectsMode").value === "Discover") {
      populateDiscoverDropdowns();
    }
  };

  const sharedObjectFileName = $("sharedObjectFileName");
  const sharedObjectFileInput = $("sharedObjectFile");
  $("sharedObjectFileBrowse").onclick = async () => {
    try {
      if (sharedObjectFileInput) {
        sharedObjectFileInput.value = "";
      }
      const file = await chooseTextFile({
        description: "Choose object list file",
        filters: [{ name: "Object List Files", extensions: ["txt", "csv"] }],
      });
      if (!file) return;

      setSharedObjectTextValue(file.content, { emit: true });
      if (sharedObjectFileName) sharedObjectFileName.textContent = file.fileName || "File selected";
      persistCurrentAppState({ delay: 0 });
      showToast(`Loaded object list: ${file.fileName || "selected file"}`);
    } catch (error) {
      showToast(error.message, true);
    }
  };

  setupEditorShortcuts();
  setupEnhancedEditorShortcuts();
  try {
    await setupEnhancedTextEditors();
  } catch (error) {
    showToast(`Monaco editor unavailable: ${error.message}`, true);
  }

  $("resolveAndAddObjects").onclick = async () => {
    const restore = setButtonLoading($("resolveAndAddObjects"), "Resolving...");
    try {
      await resolveAndAdd();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      restore();
    }
  };

  $("discoverSharedObjects").onclick = async () => {
    try {
      await discoverSharedObjects();
    } catch (error) {
      showToast(error.message, true);
    }
  };

  // Allow pressing Enter in any discover filter field to trigger search.
  ["sharedNameFilter", "sharedTypeFilter", "sharedSchemaFilter"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        try { await discoverSharedObjects(); } catch (err) { showToast(err.message, true); }
      }
    });
  });

  $("addDiscoveredObjects").onclick = () => {
    const chosen = Array.from(document.querySelectorAll("input[data-discovered]:checked"))
      .map((el) => sharedDiscoveredObjects[Number(el.dataset.discovered)])
      .filter(Boolean);

    if (chosen.length === 0) {
      showToast("Select one or more discovered objects", true);
      return;
    }

    addToSharedSelection(chosen);
    showToast(`Added ${chosen.length} objects from search results`);
  };

  // Single delegated listener for the discover grid (registered once, not per-render).
  // Handles both header "select all" and individual row checkbox state sync.
  $("sharedObjectPicker").addEventListener("change", (e) => {
    const hdrCb = document.getElementById("selectAllDiscoveredCb");
    if (!hdrCb) return;
    if (e.target.id === "selectAllDiscoveredCb") {
      document.querySelectorAll("input[data-discovered]").forEach((cb) => { cb.checked = e.target.checked; });
    } else if (e.target.matches("input[data-discovered]")) {
      const all = [...document.querySelectorAll("input[data-discovered]")];
      const checked = all.filter((cb) => cb.checked);
      hdrCb.indeterminate = checked.length > 0 && checked.length < all.length;
      hdrCb.checked = checked.length === all.length;
    }
  });

  $("clearSharedObjects").onclick = () => {
    const hadSelection = sharedSelectedObjects.length > 0;
    if (hadSelection && !confirm(`Clear all ${sharedSelectedObjects.length} selected object(s)?`)) return;
    const resetState = editorHelpers.getClearSelectionUiState(hadSelection);
    sharedSelectedObjects = [];
    if (resetState.clearDiscovered) {
      sharedDiscoveredObjects = [];
      $("sharedObjectPicker").innerHTML = "";
    }
    if (sharedObjectFileInput) sharedObjectFileInput.value = "";
    if (sharedObjectFileName) sharedObjectFileName.textContent = "No file selected";
    $("objectsMode").value = resetState.nextMode;
    applyObjectModeUI();
    renderSharedSelectionTable();
    persistCurrentAppState({ delay: 0 });
    if (resetState.focusTargetId === "sharedObjectText" || resetState.focusTargetId === "sharedObjectEditor") {
      focusSharedObjectEntry();
    } else {
      const input = $(resetState.focusTargetId);
      if (input) input.focus();
    }
    showToast(resetState.toastMessage);
  };

  const filterInput = $("objectsFilterInput");
  if (filterInput) {
    filterInput.addEventListener("input", () => renderSharedSelectionTable());
  }

  const saveListBtn = $("saveObjectList");
  if (saveListBtn) {
    saveListBtn.onclick = () => exportSharedSelectionList();
  }

  const refreshBtn = $("refreshSelectedObjects");
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      const restore = setButtonLoading(refreshBtn, "Refreshing...");
      try {
        await refreshSharedSelection();
      } catch (error) {
        endTaskProgress("objects", false, "Objects");
        showToast(`Refresh failed: ${error.message}`, true);
      } finally {
        restore();
      }
    };
  }

  const dependenciesBtn = $("fetchObjectDependencies");
  if (dependenciesBtn) {
    dependenciesBtn.onclick = async () => {
      const restore = setButtonLoading(dependenciesBtn, "Fetching...");
      try {
        await fetchDependenciesForSelection();
      } catch (error) {
        endTaskProgress("objects", false, "Objects");
        showToast(`Fetch dependencies failed: ${error.message}`, true);
      } finally {
        restore();
      }
    };
  }

  renderSharedSelectionTable();
  applyObjectModeUI();
}

// Reload metadata for the current selection straight from the database.
// Keeps the selection, filter text, and sort intact; only object metadata
// (authoritative casing, type, created/modified dates) is updated.
async function refreshSharedSelection() {
  const profileId = $("objectsProfile").value;
  if (!profileId) {
    showToast("Choose a source connection first", true);
    return;
  }
  if (!sharedSelectedObjects.length) {
    showToast("No selected objects to refresh", true);
    return;
  }

  beginTaskProgress("objects", `Refreshing ${sharedSelectedObjects.length} selected object${sharedSelectedObjects.length === 1 ? "" : "s"} from database...`);

  const resolved = await api("/api/objects/resolve-types", {
    method: "POST",
    body: JSON.stringify({
      profileId,
      objects: sharedSelectedObjects.map((o) => ({ schemaName: o.schemaName, objectName: o.objectName })),
    }),
  });

  const resolvedMap = new Map();
  for (const r of resolved) {
    const key = `${String(r.inputSchemaName || "").trim().toLowerCase()}|${String(r.inputObjectName || "").trim().toLowerCase()}`;
    resolvedMap.set(key, r);
  }

  let refreshed = 0;
  let missing = 0;
  for (const o of sharedSelectedObjects) {
    const key = `${String(o.schemaName || "").toLowerCase()}|${String(o.objectName || "").toLowerCase()}`;
    const r = resolvedMap.get(key);
    if (!r || r.matchStatus === "NotFound") {
      missing += 1;
      continue;
    }
    o.objectType = String(r.objectType || o.objectType || "").toUpperCase();
    o.schemaName = String(r.schemaName || o.schemaName).trim();
    o.objectName = String(r.objectName || o.objectName).trim();
    o.createdDate = r.createdDate ?? o.createdDate ?? null;
    o.modifiedDate = r.modifiedDate ?? o.modifiedDate ?? null;
    refreshed += 1;
  }

  sharedSelectedObjects = dedupeObjects(sharedSelectedObjects);
  renderSharedSelectionTable();
  persistCurrentAppState({ delay: 0 });
  endTaskProgress("objects", true, "Objects");
  showToast(
    missing > 0
      ? `Refreshed ${refreshed} object${refreshed === 1 ? "" : "s"}; ${missing} not found in the database (kept in selection)`
      : `Refreshed ${refreshed} object${refreshed === 1 ? "" : "s"} from database`,
    missing > 0
  );
}

function filterDiffBySharedObjects(report) {
  if (!sharedSelectedObjects.length) {
    return report;
  }

  const selectedKeys = new Set(sharedSelectedObjects.map((o) => objectKey(o)));
  const filteredDetails = report.details.filter((d) =>
    selectedKeys.has(objectKey({ objectType: d.objectType, schemaName: d.schemaName, objectName: d.objectName }))
  );

  const summary = {
    added: filteredDetails.filter((d) => d.status === "Added").length,
    missing: filteredDetails.filter((d) => d.status === "Missing").length,
    changed: filteredDetails.filter((d) => d.status === "Changed").length,
    unchanged: filteredDetails.filter((d) => d.status === "Unchanged").length,
  };

  return {
    summary,
    details: filteredDetails,
  };
}

function setupDiff() {
  $("goToObjectsFromDiff").onclick = () => setActiveTab("objects");

  function updateDiffEngineHint() {
    const engine = $("diffEngine")?.value || "Legacy";
    const hint = engine === "DacFx"
      ? "DacFx runs only for structural comparisons like tables and types. Other selections fall back automatically to fresh-script text diff."
      : "Legacy Text Compare is the default for speed and uses fresh scripts from both databases.";
    const hintEl = $("diffEngineHint");
    if (hintEl) hintEl.textContent = hint;
  }

  $("diffEngine")?.addEventListener("change", updateDiffEngineHint);
  updateDiffEngineHint();

  $("runDiff").onclick = async function () {
    const restoreBtn = setButtonLoading(this, "Running…");
    try {
      beginTaskProgress("diff", "Preparing latest scripts...");
      showToast("Comparing database objects...", false);
      const sourceProfileId = $("diffSourceProfile").value;
      const destinationProfileId = $("diffDestProfile").value;
      const result = await api("/api/diff/compare", {
        method: "POST",
        body: JSON.stringify({
          logLevel: $("logLevelSelect")?.value || "Normal",
          sourceProfileId,
          destinationProfileId,
          engine: $("diffEngine")?.value || "Legacy",
          selectedObjects: sharedSelectedObjects,
        }),
      });

      const filteredReport = filterDiffBySharedObjects(result.report);
      currentDiffReport = filteredReport;
      currentDiffRows = filteredReport.details.filter((x) => x.status !== "Unchanged");
      currentDiffIndex = 0;
      renderDiff(filteredReport);
      renderGenerationWarnings(result.report?.generationWarnings, "diffSummary");
      endTaskProgress("diff", true, "Diff");
      showToast(`Diff complete. Task: ${result.taskId}`);
    } catch (error) {
      endTaskProgress("diff", false, "Diff");
      showToast(error.message, true);
    } finally {
      restoreBtn();
    }
  };

}

function renderDiff(report) {
  $("diffSummary").innerHTML = `
<div class='card'><strong>Added</strong><div>${report.summary.added}</div></div>
<div class='card'><strong>Missing</strong><div>${report.summary.missing}</div></div>
<div class='card'><strong>Changed</strong><div>${report.summary.changed}</div></div>
<div class='card'><strong>Unchanged</strong><div>${report.summary.unchanged}</div></div>`;

  const changedRows = report.details.filter((x) => x.status !== "Unchanged");
  if (changedRows.length === 0) {
    $("diffList").innerHTML = "<p>No differences found for the selected object list.</p>";
    return;
  }

  const listHtml = changedRows
    .map(
      (d, idx) => `<button class='diff-object-item ${idx === currentDiffIndex ? "active" : ""}' data-diff-index='${idx}'>
  <span class='diff-object-main'>
    <span class='diff-object-type'>${d.objectType}</span>
    <span class='diff-object-name'>${d.schemaName}.${d.objectName}</span>
  </span>
  <span class='diff-object-status diff-object-status-${String(d.status || "").toLowerCase()}'>${d.status}</span>
</button>`
    )
    .join("");

  const selected = changedRows[currentDiffIndex] || changedRows[0];
  const sourceLabel = getSelectedConnectionLabel("diffSourceProfile", "Source");
  const targetLabel = getSelectedConnectionLabel("diffDestProfile", "Target");
  const overview = buildDiffOverview(selected);

  $("diffList").innerHTML = `<div class='diff-layout'>
<aside class='diff-object-list'>
  <div class='diff-object-list-header'>
    <div class='diff-object-list-title'>Changed Objects</div>
    <div class='diff-object-list-meta'>${changedRows.length} item${changedRows.length === 1 ? "" : "s"}</div>
  </div>
  ${listHtml}
</aside>
<section class='diff-view'>
  <div class='diff-block diff-ado-shell'>
    <div class='diff-head diff-head-detail'>
      <div class='diff-head-main'>
        <div class='diff-head-title'>${selected.objectType} ${selected.schemaName}.${selected.objectName}</div>
        <div class='diff-head-subtitle'>${escapeHtml(sourceLabel)} vs ${escapeHtml(targetLabel)}</div>
      </div>
      <span class='diff-status-pill diff-status-${String(selected.status || "").toLowerCase()}'>${selected.status}</span>
    </div>
    <div class='diff-overview-bar'>
      <div class='diff-overview-card'>
        <span class='diff-overview-label'>Source Lines</span>
        <strong class='diff-overview-value'>${overview.sourceLines}</strong>
        <span class='diff-overview-note'>${escapeHtml(sourceLabel)}</span>
      </div>
      <div class='diff-overview-card'>
        <span class='diff-overview-label'>Target Lines</span>
        <strong class='diff-overview-value'>${overview.targetLines}</strong>
        <span class='diff-overview-note'>${escapeHtml(targetLabel)}</span>
      </div>
      <div class='diff-overview-card'>
        <span class='diff-overview-label'>Modified Rows</span>
        <strong class='diff-overview-value'>${overview.modifiedRows}</strong>
        <span class='diff-overview-note'>Changed on both sides</span>
      </div>
      <div class='diff-overview-card'>
        <span class='diff-overview-label'>Added / Removed</span>
        <strong class='diff-overview-value'>+${overview.addedRows} / -${overview.removedRows}</strong>
        <span class='diff-overview-note'>Target / Source only</span>
      </div>
    </div>
    ${renderDiffSideBySide(selected, { sourceLabel, targetLabel })}
  </div>
</section>
</div>`;

  document.querySelectorAll("button[data-diff-index]").forEach((btn) => {
    btn.onclick = () => {
      currentDiffIndex = Number(btn.dataset.diffIndex);
      renderDiff(currentDiffReport || report);
    };
  });
}

function getSelectedConnectionLabel(selectId, fallback) {
  const select = $(selectId);
  const option = select?.selectedOptions?.[0];
  return option?.textContent?.trim() || fallback;
}

function splitLinesPreserve(text) {
  const value = String(text || "").replace(/\r\n/g, "\n");
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function countDefinitionLines(text) {
  return splitLinesPreserve(String(text || "")).length;
}

function buildDiffOverview(detail) {
  const overview = {
    sourceLines: countDefinitionLines(detail?.sourceDefinition),
    targetLines: countDefinitionLines(detail?.destinationDefinition),
    modifiedRows: 0,
    addedRows: 0,
    removedRows: 0,
  };

  for (const row of detail?.lineDiff || []) {
    const status = String(row.status || "").toLowerCase();
    if (status === "modified") overview.modifiedRows += 1;
    if (status === "added") overview.addedRows += 1;
    if (status === "removed") overview.removedRows += 1;
  }

  return overview;
}

function renderDiffSideBySide(detail, labels = {}) {
  const lineDiff = detail?.lineDiff || [];
  if (!lineDiff.length) {
    return "<div class='diff-empty muted'>No line changes.</div>";
  }

  const CONTEXT = 3;

  const all = lineDiff.map((row) => ({
    ...row,
    normalizedStatus: String(row.status || "").toLowerCase(),
  }));

  const changed = new Set();
  all.forEach((row, index) => {
    if (row.normalizedStatus !== "unchanged") changed.add(index);
  });
  const visible = new Set();
  for (const idx of changed) {
    for (let d = -CONTEXT; d <= CONTEXT; d++) {
      const n = idx + d;
      if (n >= 0 && n < all.length) visible.add(n);
    }
  }

  if (visible.size === 0) {
    return "<div class='diff-empty muted'>Objects are identical.</div>";
  }

  let html = "";
  let lastIdx = -1;

  for (let i = 0; i < all.length; i++) {
    if (!visible.has(i)) continue;

    if (lastIdx !== -1 && i > lastIdx + 1) {
      const skipped = i - lastIdx - 1;
      html += `<tr class="diff-hunk"><td colspan="4">@@ ${skipped} unchanged line${skipped !== 1 ? "s" : ""} @@</td></tr>`;
    }

    const row = all[i];
    const status = row.normalizedStatus;
    const leftType = status === "added" ? "ghost" : status === "modified" ? "del" : status === "removed" ? "del" : "ctx";
    const rightType = status === "removed" ? "ghost" : status === "modified" ? "ins" : status === "added" ? "ins" : "ctx";
    const leftLine = row.leftLineNumber == null ? "" : String(row.leftLineNumber);
    const rightLine = row.rightLineNumber == null ? "" : String(row.rightLineNumber);
    html += `<tr class="diff-ado-row diff-status-${status}">
<td class="diff-ado-cell diff-ado-cell-${leftType}">
  <span class="diff-ado-ln">${leftLine}</span>
  <span class="diff-ado-code mono">${escapeHtml(row.leftText || "")}</span>
</td>
<td class="diff-ado-cell diff-ado-cell-${rightType}">
  <span class="diff-ado-ln">${rightLine}</span>
  <span class="diff-ado-code mono">${escapeHtml(row.rightText || "")}</span>
</td>
</tr>`;
    lastIdx = i;
  }

  return `<div class="diff-unified-wrap diff-ado-wrap">
  <div class="diff-ado-headers">
    <div class="diff-ado-header-pane">
      <span class="diff-ado-header-label">Left</span>
      <strong>${escapeHtml(labels.sourceLabel || "Source")}</strong>
    </div>
    <div class="diff-ado-header-pane">
      <span class="diff-ado-header-label">Right</span>
      <strong>${escapeHtml(labels.targetLabel || "Target")}</strong>
    </div>
  </div>
  <table class="diff-ado-table">
    <tbody>${html}</tbody>
  </table>
</div>`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setupBackup() {
  $("goToObjectsFromBackup").onclick = () => setActiveTab("objects");

  $("backupPathBrowse").onclick = async () => {
    try {
      await chooseFolderForInput("backupPath", "Choose folder for object script backup");
    } catch (error) {
      showToast(error.message, true);
    }
  };

  $("runBackup").onclick = async function () {
    const formatAndExecute = $("backupFormatMode")?.value === "formatExecute";
    if (formatAndExecute) {
      const profileLabel = $("backupProfile").selectedOptions?.[0]?.textContent || "the source connection";
      if (!confirm(
        `Format & Execute in Source is on.\n\nAfter generating scripts, every procedure, view, function, and trigger will be re-applied to ${profileLabel} with its formatted definition (CREATE OR ALTER).\n\nContinue?`
      )) return;
    }
    const restoreBtn = setButtonLoading(this, "Running…");
    try {
      beginTaskProgress("backup", "Generating scripts...");
      showToast("Generating backup scripts...", false);
      if (sharedSelectedObjects.length === 0) {
        endTaskProgress("backup", false, "Backup");
        showToast("No objects selected. Use the Object Selection tab first.", true);
        return;
      }
      const result = await api("/api/backup/run", {
        method: "POST",
        body: JSON.stringify({
          logLevel: $("logLevelSelect")?.value || "Normal",
          sourceProfileId: $("backupProfile").value,
          selectedObjects: sharedSelectedObjects,
          options: {
            destinationPath: $("backupPath").value,
            formatAndExecute,
          },
        }),
      });
      const fx = result.formatAndExecute || { enabled: false };
      endTaskProgress("backup", fx.failedCount ? false : true, "Backup");
      const lines = [
        `Objects backed up : ${result.objectCount}`,
        `Output folder     : ${result.generatedRoot || result.backupFolder}`,
        `Build path file   : ${result.buildPathFile || "(none)"}`,
        `Exact SQL sync    : ${result.exactDefinitionsApplied || 0} programmable object${(result.exactDefinitionsApplied || 0) === 1 ? "" : "s"}`,
        `DacFx validation  : ${result.dacfxValidation?.enabled ? `Enabled (${result.dacfxValidation.objectCount || 0} objects)` : "Disabled"}`,
      ];
      if (fx.enabled) {
        lines.push(`Format & Execute  : ${fx.executedCount} executed in source, ${fx.failedCount} failed, ${fx.skippedCount} skipped (non-module objects)`);
        for (const failure of fx.failures || []) {
          lines.push(`  FAILED ${failure.object}: ${failure.error}`);
        }
      }
      lines.push(
        `Generated at      : ${formatDateTime(result.restoreReadiness?.generatedAt || new Date())}`,
        `Task ID           : ${result.taskId}`
      );
      $("backupResult").textContent = lines.join("\n");
      renderGenerationWarnings(result.generationWarnings, "backupResult");
      if (fx.enabled && fx.failedCount) {
        showToast(`Backup finished, but ${fx.failedCount} object${fx.failedCount === 1 ? "" : "s"} failed to execute in source — see result panel`, true);
      } else if (fx.enabled) {
        showToast(`Backup complete — ${fx.executedCount} formatted module${fx.executedCount === 1 ? "" : "s"} applied to source`);
      } else {
        showToast(`Backup scripts generated in ${result.generatedRoot || result.backupFolder}`);
      }
      await refreshLogs();
    } catch (error) {
      endTaskProgress("backup", false, "Backup");
      showToast(error.message, true);
    } finally {
      restoreBtn();
    }
  };
}

function setupDeployment() {
  $("goToObjects").onclick = () => setActiveTab("objects");
  const progressEl = $("deployObjectProgress");
  const retryRow = $("deployRetryRow");
  const previewBtn = $("previewDeployPlan");
  const previewEl = $("deployPlanPreview");
  const deployResultEl = $("deployResult");
  let previewRequestToken = 0;

  const deployModeHints = {
    ExecuteDirectly: "",
    Rollback: "Validate Only: scripts run in a transaction that is always rolled back, so no database changes are committed.",
  };

  function syncPreviewButtonLabel() {
    if (!previewBtn) return;
    previewBtn.textContent = previewEl && !previewEl.classList.contains("hidden") ? "Hide Preview" : "Preview Plan";
  }

  function hideDeployPlanPreview() {
    if (!previewEl) return;
    previewEl.classList.add("hidden");
    previewEl.innerHTML = "";
    syncPreviewButtonLabel();
  }

  async function refreshDeploymentPlanPreview(forceOpen = false) {
    if (!previewEl || !previewBtn) return;
    if (!forceOpen && previewEl.classList.contains("hidden")) return;

    const requestToken = ++previewRequestToken;
    const originalText = previewBtn.textContent;
    previewBtn.disabled = true;
    previewBtn.classList.add("btn-loading");
    previewBtn.textContent = forceOpen ? "Loading…" : "Refreshing…";

    try {
      if (!sharedSelectedObjects.length) {
        hideDeployPlanPreview();
        showToast("No objects selected.", true);
        return;
      }

      const { plan } = await api("/api/deploy/plan", {
        method: "POST",
        body: JSON.stringify({
          sourceProfileId: $("deploySourceProfile")?.value || "",
          selectedObjects: sharedSelectedObjects,
          engine: $("deployEngine")?.value || "Legacy",
        }),
      });

      if (requestToken !== previewRequestToken) return;

      const actionLabels = {
        AlterDelta: "Generate and apply table delta",
        ExecuteIndividually: "Execute object script individually",
        ExecuteCombinedProcedures: "Execute combined stored procedure script",
        CreateOrAlterIndividually: "Create or alter object script individually",
        DropAndCreate: "Drop and recreate object",
        DacFxDeploy: "Preview and deploy through DacFx",
        DacFxCreate: "Create through DacFx",
        DacFxAlter: "Alter through DacFx",
        DacFxDrop: "Drop through DacFx",
        NoChange: "No semantic change",
      };
      const rows = plan.map((item, i) => `<tr>
<td class="muted">${i + 1}</td>
<td>${escapeHtml(item.objectType)}</td>
<td>${escapeHtml(item.schemaName)}.${escapeHtml(item.objectName)}</td>
<td class="muted">${escapeHtml(actionLabels[item.action] || item.action)}</td>
</tr>`).join("");
      previewEl.innerHTML = `<h4 style="margin:0 0 0.4rem">Execution Plan (${plan.length} objects)</h4>
<table class="table"><thead><tr><th>#</th><th>Type</th><th>Object</th><th>Action</th></tr></thead>
<tbody>${rows}</tbody></table>`;
      previewEl.classList.remove("hidden");
    } catch (error) {
      if (requestToken !== previewRequestToken) return;
      showToast(error.message, true);
    } finally {
      if (requestToken === previewRequestToken) {
        previewBtn.disabled = false;
        previewBtn.classList.remove("btn-loading");
        previewBtn.textContent = originalText;
        syncPreviewButtonLabel();
      }
    }
  }

  function resetDeployRunArtifacts() {
    if (progressEl) {
      progressEl.innerHTML = "";
      progressEl.classList.add("hidden");
    }
    if (retryRow) {
      retryRow.classList.add("hidden");
    }
    if (deployResultEl) {
      deployResultEl.innerHTML = "";
    }
    _lastDeployResults = [];
    hideDeployPlanPreview();
  }

  function updateDeployModeHint() {
    const engine = $("deployEngine")?.value || "Legacy";
    const baseHint = deployModeHints[$("deployMode").value] || "";
    const engineHint = engine === "DacFx"
      ? "DacFx mode uses semantic schema compare and a generated deployment script."
      : "Legacy mode uses the existing per-type execution flow and table delta PowerShell path.";
    const hint = [engineHint, baseHint].filter(Boolean).join(" ");
    const hintEl = $("deployModeHint");
    if (hintEl) hintEl.textContent = hint;
  }

  $("deployMode").addEventListener("change", updateDeployModeHint);
  $("deployEngine").addEventListener("change", () => {
    updateDeployModeHint();
    refreshDeploymentPlanPreview();
  });
  updateDeployModeHint();

  $("deploySourceProfile")?.addEventListener("change", () => refreshDeploymentPlanPreview());
  $("deployDestProfile")?.addEventListener("change", () => refreshDeploymentPlanPreview());
  document.addEventListener("pebloy:selection-changed", () => refreshDeploymentPlanPreview());

  $("deployPathBrowse").onclick = async () => {
    try {
      await chooseFolderForInput("deployScriptPath", "Choose folder for deployment script generation");
    } catch (error) {
      showToast(error.message, true);
    }
  };

  $("previewDeployPlan").onclick = async function () {
    if (previewEl && !previewEl.classList.contains("hidden")) {
      hideDeployPlanPreview();
      return;
    }

    await refreshDeploymentPlanPreview(true);
  };

  syncPreviewButtonLabel();

  $("runDeployment").onclick = async function () {
    const restoreBtn = setButtonLoading(this, "Running…");
    resetDeployRunArtifacts();

    try {
      beginTaskProgress("deploy", "Preparing deployment...");
      showToast("Processing deployment...", false);
      if (sharedSelectedObjects.length === 0) {
        endTaskProgress("deploy", false, "Deployment");
        if (progressEl) progressEl.classList.add("hidden");
        showToast("No objects selected. Use the Object Selection tab first.", true);
        return;
      }

      if (progressEl) {
        progressEl.classList.remove("hidden");
      }

      // Environment guardrail
      const destProfileId = $("deployDestProfile").value;
      const srcProfileId = $("deploySourceProfile").value;
      const allProfiles = await api("/api/profiles");
      const destProfile = allProfiles.find((p) => p.id === destProfileId);
      const srcProfile = allProfiles.find((p) => p.id === srcProfileId);
      if (destProfile?.environmentTag && /prod/i.test(destProfile.environmentTag)) {
        const srcTag = srcProfile?.environmentTag || "";
        const warning = srcTag
          ? `You are deploying FROM ${srcTag} TO ${destProfile.environmentTag} (PRODUCTION).\n\nAre you sure you want to apply changes to the production database?`
          : `Target connection "${destProfile.profileLabel}" is tagged as PRODUCTION.\n\nAre you sure you want to apply changes to the production database?`;
        if (!confirm(warning)) {
          resetTaskProgress("deploy");
          progressEl.classList.add("hidden");
          showToast("Deployment canceled");
          return;
        }
      }

      const result = await api("/api/deploy/run", {
        method: "POST",
        body: JSON.stringify({
          logLevel: $("logLevelSelect")?.value || "Normal",
          sourceProfileId: srcProfileId,
          destinationProfileId: destProfileId,
          engine: $("deployEngine")?.value || "Legacy",
          mode: $("deployMode").value,
          continueOnError: $("continueOnError").checked,
          selectedObjects: sharedSelectedObjects,
          options: {
            scriptOutputPath: $("deployScriptPath").value,
          },
        }),
      });

      endTaskProgress("deploy", true, "Deployment");
      _lastDeployResults = result.itemResults || [];
      renderDeployResult(result);
      if (progressEl) progressEl.classList.add("hidden");

      // Show retry button if any failed
      if ((result.summary?.failed ?? 0) > 0) {
        if (retryRow) retryRow.classList.remove("hidden");
      }

      if (result.rollbackApplied) {
        const validated = result.summary.rolledBack ?? 0;
        const failed = result.summary.failed ?? 0;
        showToast(failed > 0
          ? `Test Run complete. ${failed} error(s) found. No DB changes made.`
          : `Test Run complete. ${validated} object(s) validated. No DB changes made.`);
      } else {
        showToast(`Deployment done. Success=${result.summary.success}, Failed=${result.summary.failed}`);
      }
      await refreshLogs();
    } catch (error) {
      endTaskProgress("deploy", false, "Deployment");
      if (progressEl) progressEl.classList.add("hidden");
      showToast(error.message, true);
    } finally {
      restoreBtn();
    }
  };

  const retryBtn = $("retryFailedObjects");
  if (retryBtn) {
    retryBtn.onclick = () => {
      const failed = _lastDeployResults.filter((r) => r.status === "Failed");
      if (!failed.length) {
        showToast("No failed objects to retry", true);
        return;
      }
      const items = failed.map((r) => ({
        objectType: r.objectType,
        schemaName: r.schemaName,
        objectName: r.objectName,
      }));
      sharedSelectedObjects = dedupeObjects([...sharedSelectedObjects, ...items]);
      renderSharedSelectionTable();
      persistCurrentAppState({ delay: 0 });
      $("deployRetryRow").classList.add("hidden");
      setActiveTab("objects");
      showToast(`${failed.length} failed object(s) added back to selection`);
    };
  }
}

function renderDeployResult(result) {
  const s = result.summary || {};
  const isRollback = result.rollbackApplied === true;
  const statusClass = { Success: "deploy-status-success", Failed: "deploy-status-failed", RolledBack: "deploy-status-accent", Skipped: "deploy-status-skipped", PendingDelta: "deploy-status-warning" };
  const validationSummary = result.dacfxValidation?.enabled
    ? `Enabled (${result.dacfxValidation.objectCount || 0} objects)`
    : "Disabled";
  const showMetadata = Boolean(result.engine || result.deployScriptPath || result.dacfxValidation?.enabled);
  const sortedItems = sortDeployResults(result.itemResults || [], _deployResultSort);
  const sortArrow = (col) => _deployResultSort.col === col ? (_deployResultSort.dir === "asc" ? " ↑" : " ↓") : "";
  const resultSortHeader = (col, label) => `<th data-sort-deploy-result="${col}" style="cursor:pointer;user-select:none">${label}${sortArrow(col)}</th>`;
  const rows = sortedItems
    .map((item) => {
      const cls = statusClass[item.status] || "";
      const name = `${item.schemaName}.${item.objectName}`;
      const err = item.errorMessage ? escapeHtml(item.errorMessage) : "";
      const statusLabel = item.status === "RolledBack" ? "Validated (not applied)" : item.status;
      return `<tr>
<td>${escapeHtml(item.objectType)}</td>
<td>${escapeHtml(name)} <button class="btn-copy-inline" data-copy="${escapeHtml(name)}" title="Copy">&#x2398;</button></td>
<td>${escapeHtml(item.action || "")}</td>
<td class="${cls} fw-600">${statusLabel}</td>
<td class="deploy-error-cell">${err}</td>
</tr>`;
    })
    .join("");

  const rollbackNote = isRollback
    ? `<p class="muted" style="margin:0 0 0.5rem;font-size:0.82rem">Rollback (Test Run) — no changes were committed to the database.</p>`
    : "";

  const rolledBackCount = s.rolledBack ?? 0;
  const rolledBackCard = isRollback
    ? `<div class="card"><strong class="text-accent">Validated</strong><div>${rolledBackCount}</div></div>`
    : "";
  const metadataBlock = showMetadata
    ? `<div class="mono" style="white-space:pre-wrap;margin:0 0 0.75rem;font-size:0.82rem">${[
        `Engine           : ${escapeHtml(result.engine || "")}`,
        `DacFx validation : ${escapeHtml(validationSummary)}`,
        `Deploy script    : ${escapeHtml(result.deployScriptPath || "(none)")}`,
      ].join("\n")}</div>`
    : "";

  $("deployResult").innerHTML = `
${rollbackNote}
${metadataBlock}
<div class="summary-cards" style="margin-bottom:0.6rem">
  <div class="card"><strong>Total</strong><div>${s.total ?? 0}</div></div>
  ${isRollback ? rolledBackCard : `<div class="card"><strong class="text-success">Success</strong><div>${s.success ?? 0}</div></div>`}
  <div class="card"><strong class="text-danger">Failed</strong><div>${s.failed ?? 0}</div></div>
  <div class="card"><strong class="text-muted">Skipped</strong><div>${s.skipped ?? 0}</div></div>
</div>
<div style="overflow:auto;max-height:18rem">
<table class="table">
<thead><tr>${resultSortHeader("type", "Type")}${resultSortHeader("object", "Object")}${resultSortHeader("action", "Action")}${resultSortHeader("status", "Status")}${resultSortHeader("error", "Error")}</tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;

  $("deployResult").querySelectorAll("[data-sort-deploy-result]").forEach((th) => {
    th.onclick = () => {
      const col = th.dataset.sortDeployResult;
      if (_deployResultSort.col === col) {
        _deployResultSort.dir = _deployResultSort.dir === "asc" ? "desc" : "asc";
      } else {
        _deployResultSort = { col, dir: "asc" };
      }
      renderDeployResult(result);
    };
  });

  $("deployResult").querySelectorAll(".btn-copy-inline").forEach((btn) => {
    btn.onclick = () => copyToClipboard(btn.dataset.copy);
  });
  renderGenerationWarnings(result.generationWarnings, "deployResult");
}

// ─── Log auto-refresh & SSE ────────────────────────────────────────────────

let _logAutoRefreshTimer = null;
const _runningTasksMap = new Map(); // taskId → { taskType, objectCount, startedAt }

function startLogAutoRefresh() {
  if (_logAutoRefreshTimer) return;
  _logAutoRefreshTimer = setInterval(() => {
    if (_runningTasksMap.size > 0) refreshLogs();
  }, 8000);
}

function connectSSE() {
  const es = new EventSource("/api/events");
  const taskTypeToProgressKey = {
    Backup: "backup",
    Diff: "diff",
    Deploy: "deploy",
  };

  es.addEventListener("taskStart", (e) => {
    const data = JSON.parse(e.data);
    _runningTasksMap.set(data.taskId, { ...data, percent: 0, progressLabel: "Starting…" });
    renderTaskbar();
    renderParallelTasksPanel();
    const panel = $("parallelTasksPanel");
    if (panel) panel.classList.remove("hidden");
    startLogAutoRefresh();
  });

  es.addEventListener("taskEnd", (e) => {
    const data = JSON.parse(e.data);
    _runningTasksMap.delete(data.taskId);
    renderTaskbar();
    renderParallelTasksPanel();
    if (_runningTasksMap.size === 0) {
      setTimeout(() => $("parallelTasksPanel")?.classList.add("hidden"), 2500);
    }
    renderTaskbarSummary(data);
    refreshLogs();
    sendDesktopNotification(data);
    if (_runningTasksMap.size === 0 && _logAutoRefreshTimer) {
      clearInterval(_logAutoRefreshTimer);
      _logAutoRefreshTimer = null;
    }
  });

  es.addEventListener("deployProgress", (e) => {
    const data = JSON.parse(e.data);
    const el = $("deployObjectProgress");
    if (!el || el.classList.contains("hidden")) return;
    const pct = data.total > 0 ? Math.round((data.done / data.total) * 100) : 0;
    const statusIcon = data.status === "Success" ? "✓" : data.status === "Failed" ? "✗" : "…";
    const statusCls = data.status === "Success" ? "progress-ok" : data.status === "Failed" ? "progress-err" : "";
    const name = data.schemaName && data.objectName
      ? `${data.objectType} ${data.schemaName}.${data.objectName}`
      : `${data.objectType} ${data.objectName || ""}`;

    // Find or create row for this object
    let row = el.querySelector(`[data-dp-key="${data.objectType}|${data.schemaName}|${data.objectName}"]`);
    if (!row) {
      row = document.createElement("div");
      row.className = "deploy-progress-row";
      row.dataset.dpKey = `${data.objectType}|${data.schemaName}|${data.objectName}`;
      el.appendChild(row);
    }
    row.innerHTML = `<span class="dp-icon ${statusCls}">${statusIcon}</span><span class="dp-name">${escapeHtml(name)}</span>${data.error ? `<span class="dp-error muted">${escapeHtml(data.error.slice(0, 80))}</span>` : ""}`;

    // Update bar in deploy progress
    const bar = $("deployProgressBar");
    const txt = $("deployProgressText");
    if (bar) bar.style.width = pct + "%";
    if (txt) txt.textContent = `Deploying objects ${data.done}/${data.total} · ${name}`;
  });

  es.addEventListener("taskProgress", (e) => {
    const data = JSON.parse(e.data);
    const key = data.key || taskTypeToProgressKey[data.taskType];
    if (key) updateTaskProgress(key, data.operation || `${data.taskType} running...`, data.percent);
    const task = data.taskId ? _runningTasksMap.get(data.taskId) : null;
    if (task) {
      task.percent = data.percent ?? task.percent;
      task.progressLabel = data.operation || task.progressLabel;
      renderParallelTasksPanel();
    }
  });

  es.onerror = () => {
    // SSE will auto-reconnect; update label if visible
    const lbl = $("logAutoRefreshLabel");
    if (lbl) lbl.textContent = "";
  };
}

// ─── Taskbar ───────────────────────────────────────────────────────────────

function renderTaskbar() {
  const bar = $("taskbar");
  const runEl = $("taskbarRunning");
  if (!bar || !runEl) return;

  if (_runningTasksMap.size === 0) {
    runEl.innerHTML = "";
    // Don't hide if summary is visible
    if (!$("taskbarSummary").innerHTML.trim()) bar.style.display = "none";
    return;
  }

  bar.style.display = "flex";
  const chips = [..._runningTasksMap.values()].map((t) => {
    const elapsed = Math.floor((Date.now() - new Date(t.startedAt).getTime()) / 1000);
    return `<span class="taskbar-chip">
      <span class="taskbar-spinner"></span>
      <strong>${escapeHtml(t.taskType)}</strong>
      <span>${t.objectCount} object${t.objectCount !== 1 ? "s" : ""}</span>
      <span class="muted">${elapsed}s</span>
    </span>`;
  }).join("");
  runEl.innerHTML = chips;
}

function renderTaskbarSummary(data) {
  const el = $("taskbarSummary");
  const bar = $("taskbar");
  if (!el || !bar) return;

  const icon = data.status === "Success" ? "✓" : "✗";
  const cls = data.status === "Success" ? "taskbar-ok" : "taskbar-fail";
  let detail = "";
  if (data.summary) {
    if (data.taskType === "Deploy") {
      detail = ` · ${data.summary.success ?? 0} success / ${data.summary.failed ?? 0} failed`;
    } else if (data.taskType === "Diff") {
      detail = ` · ${(data.summary.changed ?? 0) + (data.summary.added ?? 0) + (data.summary.missing ?? 0)} changes`;
    } else if (data.taskType === "Backup") {
      detail = ` · ${data.summary.objectCount ?? ""} objects`;
    }
  } else if (data.error) {
    detail = ` · ${escapeHtml(String(data.error).slice(0, 80))}`;
  }

  el.innerHTML = `<span class="taskbar-chip ${cls}">
    <span>${icon}</span>
    <strong>${escapeHtml(data.taskType)}</strong> completed${escapeHtml(detail)}
    <button class="btn-ghost taskbar-dismiss" style="padding:0 0.3rem;font-size:0.75rem;box-shadow:none" title="Dismiss">✕</button>
  </span>`;

  bar.style.display = "flex";

  el.querySelector(".taskbar-dismiss").onclick = () => {
    el.innerHTML = "";
    if (!$("taskbarRunning").innerHTML.trim()) bar.style.display = "none";
  };
}

// ─── Desktop notifications ─────────────────────────────────────────────────

let _notificationPermission = "default";

async function requestNotificationPermission() {
  if (!("Notification" in window)) {
    _notificationPermission = "unsupported";
    return;
  }
  _notificationPermission = Notification.permission;
  if (_notificationPermission === "granted") { return; }
  if (_notificationPermission !== "denied") {
    const result = await Notification.requestPermission();
    _notificationPermission = result;
  }
}

function sendDesktopNotification(data) {
  if (!appState?.preferences?.notificationsEnabled) return;
  if (!("Notification" in window)) return;
  _notificationPermission = Notification.permission;
  if (_notificationPermission !== "granted") return;
  const title = `Pebloy — ${data.taskType} ${data.status}`;
  let body = "";
  if (data.status === "Success" && data.summary) {
    if (data.taskType === "Deploy") body = `${data.summary.success ?? 0} succeeded, ${data.summary.failed ?? 0} failed`;
    else if (data.taskType === "Diff") body = `${(data.summary.changed ?? 0) + (data.summary.added ?? 0) + (data.summary.missing ?? 0)} changes found`;
    else if (data.taskType === "Backup") body = `${data.summary.objectCount ?? ""} objects backed up`;
  } else if (data.error) {
    body = String(data.error).slice(0, 100);
  }
  try { new Notification(title, { body, icon: "/logo.svg" }); } catch (_e) {}
}

// ─── Logs table ────────────────────────────────────────────────────────────

async function refreshLogs(page = 1, pageSize = 20) {
  let logs;
  try { logs = await api("/api/logs"); } catch { return; }

  // Apply filters from UI
  const typeFilter = $("logFilterType") ? $("logFilterType").value : "";
  const statusFilter = $("logFilterStatus") ? $("logFilterStatus").value : "";
  const levelFilter = $("logFilterLevel") ? $("logFilterLevel").value : "";
  const dateFilter = $("logFilterDate") ? $("logFilterDate").value : "";

  const filtered = logs.filter((l) => {
    if (typeFilter && l.taskType !== typeFilter) return false;
    if (statusFilter && l.status !== statusFilter) return false;
    if (levelFilter) {
      const eventCounts = l.eventCounts || {};
      const normalized = levelFilter === "WARNING" ? "WARN" : levelFilter;
      if (!(eventCounts[normalized] > 0)) return false;
    }
    if (dateFilter) {
      const d = (l.startedAt || "").slice(0, 10);
      if (d !== dateFilter) return false;
    }
    return true;
  });

  const sortedLogs = sortLogs(filtered, _logSort);

  const { items, pages } = paginate(sortedLogs, page, pageSize);

  function statusBadge(s) {
    const map = { Success: "badge-success", Failed: "badge-failed", Running: "badge-running" };
    const cls = map[s] || "badge-muted";
    return `<span class="badge ${cls}">${escapeHtml(s || "")}</span>`;
  }

  function eventBadge(log) {
    const level = String(log.highestLevel || "").toUpperCase();
    const label = level || "—";
    const cls = { ERROR: "log-badge-error", WARN: "log-badge-warn", INFO: "log-badge-info" }[level] || "log-badge-muted";
    return `<span class="log-badge ${cls}">${escapeHtml(label)}</span>`;
  }

  const rows = items.map((l) => {
    const dur = l.startedAt
      ? formatDurationMmSs(l.startedAt, l.completedAt || Date.now())
      : l.status === "Running" ? "…" : "";
    return `<tr>
<td><strong>${escapeHtml(l.taskType || "")}</strong></td>
<td>${statusBadge(l.status)}</td>
<td>${eventBadge(l)}</td>
<td class="muted" style="font-size:0.78rem">${escapeHtml(l.sourceProfileLabel || "")}${l.destinationProfileLabel ? " → " + escapeHtml(l.destinationProfileLabel) : ""}</td>
<td style="font-size:0.78rem">${l.objectCount || 0} obj</td>
<td style="font-size:0.78rem">${formatDateTime(l.startedAt)}</td>
<td style="font-size:0.78rem">${dur}</td>
<td style="white-space:nowrap">
  <button class="btn-ghost" style="padding:0.2rem 0.5rem;font-size:0.76rem" data-log-view='${escapeHtml(l.taskId)}'>Detail</button>
  <button class="btn-ghost" style="padding:0.2rem 0.5rem;font-size:0.76rem" data-log-open='${escapeHtml(l.taskId)}'>Open With…</button>
</td>
</tr>`;
  }).join("");

  const countLabel = `${filtered.length} log${filtered.length !== 1 ? "s" : ""}`;
  let paginationHtml = "";
  if (pages > 1) {
    paginationHtml = `<div class='logs-pagination'>`;
    for (let i = 1; i <= pages; i++) {
      paginationHtml += `<button class='log-page-btn${i === page ? " active" : ""}' data-logpage='${i}'>${i}</button>`;
    }
    paginationHtml += `</div>`;
  }

  const sortArrow = (col) => _logSort.col === col ? (_logSort.dir === "asc" ? " ↑" : " ↓") : "";
  const logSortHeader = (col, label) => `<th data-sort-log="${col}" style="cursor:pointer;user-select:none">${label}${sortArrow(col)}</th>`;

  $("logsTable").innerHTML = `
<div style="font-size:0.78rem;color:var(--muted);margin-bottom:0.4rem">${countLabel}</div>
<table class='table'>
<thead><tr>
  ${logSortHeader("taskType", "Task Type")}${logSortHeader("status", "Status")}${logSortHeader("eventLevel", "Event Level")}${logSortHeader("connectionFlow", "Connection Flow")}${logSortHeader("objectCount", "Objects")}${logSortHeader("startedAt", "Started At")}${logSortHeader("duration", "Duration")}<th>Actions</th>
</tr></thead>
<tbody>${rows || "<tr><td colspan='8' class='muted' style='text-align:center;padding:1rem'>No logs match filters.</td></tr>"}</tbody>
</table>
${paginationHtml}`;

  const lbl = $("logAutoRefreshLabel");
  if (lbl) lbl.textContent = `Updated ${formatTimeOnly(new Date())}`;

  // Wire up View buttons
  document.querySelectorAll("button[data-log-view]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        const detail = await api(`/api/tasks/${btn.dataset.logView}`);
        const pre = $("logDetail");
        pre.classList.remove("hidden");
        pre.textContent = formatLogDetail(detail);
        pre.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch (error) {
        showToast(error.message, true);
      }
    };
  });

  // Wire up Open File buttons
  document.querySelectorAll("button[data-log-open]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        const opened = await api(`/api/logs/${btn.dataset.logOpen}/open`, { method: "POST" });
        showToast(opened.promptForApp ? `Choose an app for: ${opened.path}` : `Opened: ${opened.path}`);
      } catch (error) {
        showToast(error.message, true);
      }
    };
  });

  // Wire up pagination — use specific class to avoid conflict with profiles pagination
  document.querySelectorAll("button[data-logpage]").forEach((btn) => {
    btn.onclick = () => refreshLogs(Number(btn.dataset.logpage), pageSize);
  });

  document.querySelectorAll("[data-sort-log]").forEach((th) => {
    th.onclick = () => {
      const col = th.dataset.sortLog;
      if (_logSort.col === col) {
        _logSort.dir = _logSort.dir === "asc" ? "desc" : "asc";
      } else {
        _logSort = { col, dir: col === "startedAt" ? "desc" : "asc" };
      }
      refreshLogs(1, pageSize);
    };
  });
}

function formatLogDetail(detail) {
  const levelFilter = $("logFilterLevel")?.value || "";
  const shouldShowLevel = (level) => {
    if (!levelFilter) return true;
    const normalizedLevel = String(level || "").toUpperCase();
    return (levelFilter === "WARN" && (normalizedLevel === "WARN" || normalizedLevel === "WARNING")) || normalizedLevel === levelFilter;
  };

  const lines = [
    `Task ID   : ${detail.taskId}`,
    `Task Type : ${detail.taskType}`,
    `Status    : ${detail.status}`,
    `Started   : ${formatDateTime(detail.startedAt)}`,
    `Completed : ${detail.completedAt ? formatDateTime(detail.completedAt) : "(running)"}`,
    `Duration  : ${detail.startedAt ? formatDurationMmSs(detail.startedAt, detail.completedAt || Date.now()) : "—"}`,
    `Started By: ${detail.startedBy} @ ${detail.machine}`,
    `Source    : ${detail.sourceProfileLabel || "-"}`,
    `Target    : ${detail.destinationProfileLabel || "-"}`,
    `Objects   : ${(detail.selectedObjects || []).length}`,
    `Sorting   : ${detail.selectionReadiness?.sorting || "Ready"}`,
    `Ordering  : ${detail.selectionReadiness?.ordering || "Ready"}`,
    `Filtering : ${detail.selectionReadiness?.filtering || "Ready"}`,
    `Log Level : ${detail.logLevel || "Normal"}`,
    "",
    "── Events ──────────────────────────────────────",
  ];
  let lastDateLabel = "";
  for (const ev of detail.events || []) {
    if (!shouldShowLevel(ev.level)) continue;
    const eventDate = ev.timestamp ? formatDate(ev.timestamp) : "Unknown Date";
    if (eventDate !== lastDateLabel) {
      lines.push(``, `  ${eventDate}`, `  ${"-".repeat(Math.max(eventDate.length, 10))}`);
      lastDateLabel = eventDate;
    }
    const ts = formatTimeOnly(ev.timestamp);
    lines.push(`[${ts}] ${ev.level.padEnd(5)} ${ev.message}`);
    if (ev.details && typeof ev.details === "object") {
      const err = ev.details.error || ev.details.errorMessage;
      if (err) lines.push(`         ERROR: ${String(err).slice(0, 200)}`);
    }
  }
  if (detail.summary && Object.keys(detail.summary).length) {
    lines.push("", "── Summary ─────────────────────────────────────");
    for (const [k, v] of Object.entries(detail.summary)) {
      if (typeof v !== "object") lines.push(`  ${k}: ${v}`);
    }
  }
  return lines.join("\n");
}

function setupUpdater() {
  const api = window.electronAPI;
  const checkBtn = $("checkForUpdatesBtn");
  const installBtn = $("downloadInstallBtn");
  const releaseLink = $("releasePageLink");
  const statusEl = $("updateStatus");
  const versionLabel = $("currentVersionLabel");
  const progressWrap = $("updateProgressWrap");
  const progressBar = $("updateProgressBar");
  const progressPct = $("updateProgressPct");

  if (!checkBtn) return;

  if (!api) {
    checkBtn.textContent = "Updates unavailable (web mode)";
    checkBtn.disabled = true;
    return;
  }

  api.getVersion().then((v) => { if (versionLabel) versionLabel.textContent = v; }).catch(() => {});

  let removeProgressListener = null;
  let pendingDownloadUrl = null;

  function setStatus(msg, type = "") {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = "update-status" + (type ? ` update-status--${type}` : "");
  }

  checkBtn.addEventListener("click", async () => {
    checkBtn.disabled = true;
    installBtn.hidden = true;
    releaseLink.hidden = true;
    progressWrap.hidden = true;
    setStatus("Checking for updates…");

    try {
      const info = await api.checkForUpdates();
      if (!info.hasUpdate) {
        setStatus(`You're up to date (v${info.current}).`, "ok");
      } else {
        pendingDownloadUrl = info.downloadUrl;
        if (info.downloadUrl) {
          const assetName = info.installerAssetName ? ` (${info.installerAssetName})` : "";
          setStatus(`v${info.latest} is available${info.releaseName ? ` — ${info.releaseName}` : ""}${assetName}.`, "available");
          installBtn.hidden = false;
        } else {
          setStatus(`v${info.latest} is available, but the GitHub release has no installable Setup .exe asset.`, "error");
        }
        if (info.releaseUrl) {
          releaseLink.href = info.releaseUrl;
          releaseLink.hidden = false;
        }
      }
    } catch (err) {
      setStatus(`Check failed: ${err.message}`, "error");
    } finally {
      checkBtn.disabled = false;
    }
  });

  installBtn.addEventListener("click", async () => {
    if (!pendingDownloadUrl) return;
    installBtn.disabled = true;
    checkBtn.disabled = true;
    progressWrap.hidden = false;
    progressBar.style.width = "0%";
    progressPct.textContent = "0%";
    setStatus("Downloading update…");

    if (removeProgressListener) removeProgressListener();
    removeProgressListener = api.onUpdateProgress((pct) => {
      progressBar.style.width = `${pct}%`;
      progressPct.textContent = `${pct}%`;
    });

    try {
      await api.downloadAndInstall(pendingDownloadUrl);
      setStatus("Download complete. Launching installer — the app will close.", "ok");
      progressBar.style.width = "100%";
      progressPct.textContent = "100%";
    } catch (err) {
      setStatus(`Download failed: ${err.message}`, "error");
      installBtn.disabled = false;
      checkBtn.disabled = false;
    } finally {
      if (removeProgressListener) { removeProgressListener(); removeProgressListener = null; }
    }
  });
}

function setupTheme() {
  const themes = Array.isArray(globalThis.PebloyThemes) && globalThis.PebloyThemes.length
    ? globalThis.PebloyThemes
    : [];
  const themeMap = new Map(themes.map((t) => [t.id, t]));
  const fallbackThemeId = themeMap.has(DEFAULT_APPEARANCE_THEME) ? DEFAULT_APPEARANCE_THEME : themes[0]?.id;
  const validThemes = themes.map((t) => t.id);
  const savedTheme = appState?.preferences?.theme || readAppPreference("theme", DEFAULT_APPEARANCE_THEME);
  const saved = validThemes.includes(savedTheme) ? savedTheme : fallbackThemeId;

  const themeSelect = $("themeSelect");

  if (themeSelect) {
    themeSelect.innerHTML = themes.map((t) =>
      `<option value="${escapeHtml(t.id)}">${escapeHtml(t.glyph || "")} ${escapeHtml(t.label)}</option>`
    ).join("");
    themeSelect.value = saved;
    themeSelect.addEventListener("change", () => applyTheme(themeSelect.value));
  }

  // Union of every token any theme defines. Tokens the incoming theme does
  // not set must be REMOVED from body's inline style, otherwise the previous
  // theme's value leaks through (e.g. unreadable toast/dialog colors).
  const allThemeTokens = new Set(themes.flatMap((t) => Object.keys(t.tokens || {})));

  function applyTheme(themeId, persist = true) {
    const theme = themeMap.get(themeId) || themeMap.get(fallbackThemeId);
    if (!theme) return;

    document.body.setAttribute("data-theme", theme.id);
    document.documentElement.style.colorScheme = theme.colorScheme || "dark";
    const tokens = theme.tokens || {};
    for (const token of allThemeTokens) {
      if (Object.prototype.hasOwnProperty.call(tokens, token)) {
        document.body.style.setProperty(`--${token}`, tokens[token]);
      } else {
        document.body.style.removeProperty(`--${token}`);
      }
    }
    if (themeSelect) themeSelect.value = theme.id;

    if (persist) scheduleAppStateSave({ preferences: { theme: theme.id } }, { delay: 0 });
  }

  applyTheme(saved, false);
}

const OBJECT_TYPE_LABELS = {
  PROCEDURE: "Stored Procedure",
  VIEW: "View",
  FUNCTION: "Function",
  TABLE: "Table",
  SYNONYM: "Synonym",
  SEQUENCE: "Sequence",
  USER_DEFINED_TYPE: "User Defined Type",
  TRIGGER: "Trigger",
};

const DEFAULT_FOLDER_NAMES = {
  PROCEDURE: "Stored Procedures",
  VIEW: "Views",
  FUNCTION: "Functions",
  TABLE: "Tables",
  SYNONYM: "Synonyms",
  SEQUENCE: "Sequences",
  USER_DEFINED_TYPE: "User Defined Types",
};

const DEFAULT_DEPLOYMENT_ORDER = [
  "USER_DEFINED_TYPE", "SEQUENCE", "TABLE", "VIEW", "FUNCTION", "PROCEDURE", "SYNONYM", "TRIGGER",
];

function showConfirmModal({ title, message, buttons }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-modal-overlay";
    overlay.innerHTML = `
      <div class="confirm-modal" role="dialog" aria-modal="true">
        <h4>${escapeHtml(title)}</h4>
        <p>${escapeHtml(message)}</p>
        <div class="confirm-modal-actions">
          ${buttons.map((b, i) => `<button type="button" class="confirm-modal-btn${i === 0 ? " btn-primary" : i === buttons.length - 1 ? " btn-ghost" : ""}" data-idx="${i}">${escapeHtml(b)}</button>`).join("")}
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll(".confirm-modal-btn").forEach((btn) => {
      btn.onclick = () => { overlay.remove(); resolve(buttons[Number(btn.dataset.idx)]); };
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { overlay.remove(); resolve(null); }
    });
    overlay.querySelector(".confirm-modal-btn").focus();
  });
}

function setupCustomize() {
  let currentSettings = null;

  function normalizeCustomizeSettings(settings) {
    const safeFolderNames = { ...DEFAULT_FOLDER_NAMES, ...((settings && settings.folderNames) || {}) };
    const validTypes = new Set([...Object.keys(DEFAULT_FOLDER_NAMES), ...DEFAULT_DEPLOYMENT_ORDER]);
    const chosenOrder = Array.isArray(settings?.deploymentOrder) ? settings.deploymentOrder : [];
    const seen = new Set();
    const safeOrder = [];

    chosenOrder.forEach((type) => {
      const objectType = String(type || "").trim().toUpperCase();
      if (!validTypes.has(objectType) || seen.has(objectType)) return;
      seen.add(objectType);
      safeOrder.push(objectType);
    });

    DEFAULT_DEPLOYMENT_ORDER.forEach((type) => {
      if (!seen.has(type)) safeOrder.push(type);
    });

    return {
      folderNames: safeFolderNames,
      deploymentOrder: safeOrder,
      dacfx: {
        validationEnabled: Boolean(settings?.dacfx?.validationEnabled),
      },
      time: {
        useSystemTime: settings?.time?.useSystemTime === undefined ? true : Boolean(settings.time.useSystemTime),
        timeZone: typeof settings?.time?.timeZone === "string" ? settings.time.timeZone : "",
      },
      formatting: {
        formatGeneratedSql: Boolean(settings?.formatting?.formatGeneratedSql),
      },
    };
  }

  const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function populateTimeZoneSelect() {
    const select = $("timeZoneSelect");
    if (!select || select.options.length) return;
    const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [systemTimeZone];
    select.innerHTML = zones.map((z) => `<option value="${escapeHtml(z)}">${escapeHtml(z)}</option>`).join("");
    select.value = systemTimeZone;
  }

  // Applies the time settings to the whole UI: the timezone every rendered
  // timestamp uses, plus the Settings card controls and active-zone label.
  function applyTimeSettings(time) {
    populateTimeZoneSelect();
    const useSystem = time?.useSystemTime !== false;
    const zone = time?.timeZone || systemTimeZone;

    const toggle = $("useSystemTimeToggle");
    const select = $("timeZoneSelect");
    const label = $("activeTimeZoneLabel");

    if (toggle) toggle.checked = useSystem;
    if (select) {
      select.disabled = useSystem;
      if (time?.timeZone) select.value = time.timeZone;
    }

    activeTimeZone = useSystem ? null : zone;
    if (label) label.textContent = useSystem ? `${systemTimeZone} (system)` : zone;

    // Re-render tables that show timestamps so they pick up the new zone.
    renderSharedSelectionTable();
  }

  async function loadSettings() {
    renderFolderNames(DEFAULT_FOLDER_NAMES);
    renderDeployOrder(DEFAULT_DEPLOYMENT_ORDER);
    try {
      currentSettings = normalizeCustomizeSettings(await api("/api/settings"));
      renderFolderNames(currentSettings.folderNames);
      renderDeployOrder(currentSettings.deploymentOrder);
      if ($("dacfxValidationEnabled")) {
        $("dacfxValidationEnabled").checked = Boolean(currentSettings.dacfx?.validationEnabled);
      }
      applyTimeSettings(currentSettings.time);
      applyFormattingSettings(currentSettings.formatting);
    } catch (error) {
      currentSettings = normalizeCustomizeSettings();
      renderFolderNames(currentSettings.folderNames);
      renderDeployOrder(currentSettings.deploymentOrder);
      if ($("dacfxValidationEnabled")) {
        $("dacfxValidationEnabled").checked = Boolean(currentSettings.dacfx?.validationEnabled);
      }
      applyTimeSettings(currentSettings.time);
      applyFormattingSettings(currentSettings.formatting);
      showToast("Failed to load settings: " + error.message, true);
    }
  }

  function renderFolderNames(folderNames) {
    const tbody = $("folderNamesBody");
    if (!tbody) return;
    tbody.innerHTML = Object.entries(DEFAULT_FOLDER_NAMES)
      .map(([type, defaultName]) => {
        const current = folderNames[type] || defaultName;
        return `<tr>
<td>${OBJECT_TYPE_LABELS[type] || type}</td>
<td><input class="folder-name-input" data-type="${type}" value="${escapeHtml(current)}" style="width:100%" /></td>
</tr>`;
      })
      .join("");
  }

  function renderDeployOrder(order) {
    const list = $("deployOrderList");
    if (!list) return;
    const safeOrder = Array.isArray(order) && order.length ? order : [...DEFAULT_DEPLOYMENT_ORDER];
    list.innerHTML = safeOrder
      .map((type, idx) => `<li class="deploy-order-item" data-type="${type}">
<span class="deploy-order-label">${OBJECT_TYPE_LABELS[type] || type}</span>
<div class="deploy-order-actions">
  <button type="button" class="btn-icon" data-move-up="${idx}" title="Move up" ${idx === 0 ? "disabled" : ""}>↑</button>
  <button type="button" class="btn-icon" data-move-down="${idx}" title="Move down" ${idx === safeOrder.length - 1 ? "disabled" : ""}>↓</button>
</div>
</li>`)
      .join("");

    list.querySelectorAll("[data-move-up]").forEach((btn) => {
      btn.onclick = () => {
        const i = Number(btn.dataset.moveUp);
        if (i === 0) return;
        const newOrder = [...((currentSettings && currentSettings.deploymentOrder) || DEFAULT_DEPLOYMENT_ORDER)];
        [newOrder[i - 1], newOrder[i]] = [newOrder[i], newOrder[i - 1]];
        currentSettings.deploymentOrder = newOrder;
        renderDeployOrder(newOrder);
      };
    });

    list.querySelectorAll("[data-move-down]").forEach((btn) => {
      btn.onclick = () => {
        const i = Number(btn.dataset.moveDown);
        const newOrder = [...((currentSettings && currentSettings.deploymentOrder) || DEFAULT_DEPLOYMENT_ORDER)];
        if (i >= newOrder.length - 1) return;
        [newOrder[i], newOrder[i + 1]] = [newOrder[i + 1], newOrder[i]];
        currentSettings.deploymentOrder = newOrder;
        renderDeployOrder(newOrder);
      };
    });
  }

  function collectFolderNames() {
    const result = {};
    document.querySelectorAll(".folder-name-input").forEach((input) => {
      const type = input.dataset.type;
      const val = input.value.trim();
      if (type && val) result[type] = val;
    });
    return result;
  }

  $("saveAllSettings").onclick = async function () {
    const restore = setButtonLoading(this, "Saving…");
    try {
      const notifToggleEl = $("notificationsToggle");
      if (notifToggleEl && notifToggleEl.checked) await requestNotificationPermission();

      const defBackup = $("defaultBackupPath")?.value.trim();
      if (defBackup) {
        const bp = $("backupPath");
        if (bp && !bp.value) bp.value = defBackup;
      }
      const defScript = $("defaultScriptPath")?.value.trim();
      if (defScript) {
        const dp = $("deployScriptPath");
        if (dp && !dp.value) dp.value = defScript;
      }

      showToast("Saving settings…", false);
      persistCurrentAppState({ delay: 0, silent: false });

      const folderNames = collectFolderNames();
      const deploymentOrder = currentSettings?.deploymentOrder || DEFAULT_DEPLOYMENT_ORDER;
      const dacfx = {
        validationEnabled: Boolean($("dacfxValidationEnabled")?.checked),
      };
      const time = {
        useSystemTime: $("useSystemTimeToggle") ? Boolean($("useSystemTimeToggle").checked) : true,
        timeZone: $("timeZoneSelect")?.value || "",
      };
      const formatting = {
        formatGeneratedSql: Boolean($("formatGeneratedSqlToggle")?.checked),
      };
      const saved = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ folderNames, deploymentOrder, dacfx, time, formatting }),
      });
      currentSettings = normalizeCustomizeSettings(saved);
      applyTimeSettings(currentSettings.time);
      applyFormattingSettings(currentSettings.formatting);

      showToast("All settings saved");
    } catch (error) {
      showToast("Failed to save: " + error.message, true);
    } finally {
      restore();
    }
  };

  // Live preview for the timezone controls (persisted on Save All)
  const useSystemTimeToggle = $("useSystemTimeToggle");
  const timeZoneSelect = $("timeZoneSelect");
  if (useSystemTimeToggle) {
    useSystemTimeToggle.addEventListener("change", () => {
      applyTimeSettings({
        useSystemTime: useSystemTimeToggle.checked,
        timeZone: timeZoneSelect?.value || "",
      });
    });
  }
  if (timeZoneSelect) {
    timeZoneSelect.addEventListener("change", () => {
      applyTimeSettings({
        useSystemTime: Boolean(useSystemTimeToggle?.checked),
        timeZone: timeZoneSelect.value,
      });
    });
  }

  $("resetCustomize").onclick = async function () {
    if (!confirm("Reset all customize settings to defaults?")) return;
    const restore = setButtonLoading(this, "Resetting…");
    try {
      showToast("Resetting script settings...", false);
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ folderNames: DEFAULT_FOLDER_NAMES, deploymentOrder: DEFAULT_DEPLOYMENT_ORDER, dacfx: { validationEnabled: false } }),
      });
      await loadSettings();
      applyTabVisibility([]);
      const themeSelect = $("themeSelect");
      if (themeSelect) {
        themeSelect.value = DEFAULT_APPEARANCE_THEME;
        themeSelect.dispatchEvent(new Event("change"));
      }
      const fontSelect = $("fontSelector");
      if (fontSelect) {
        fontSelect.value = DEFAULT_APPEARANCE_FONT_FAMILY;
        fontSelect.dispatchEvent(new Event("change"));
      }
      const fontSizeRange = $("fontSizeRange");
      if (fontSizeRange) {
        fontSizeRange.value = DEFAULT_APPEARANCE_FONT_SIZE;
        fontSizeRange.dispatchEvent(new Event("input"));
      }
      persistCurrentAppState();
      showToast("Settings reset to defaults");
    } catch (error) {
      showToast("Failed to reset: " + error.message, true);
    } finally {
      restore();
    }
  };

  // ── Tab visibility ───────────────────────────────────────────────────────
  document.querySelectorAll("[data-tab-vis]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const hiddenTabs = Array.from(document.querySelectorAll("[data-tab-vis]"))
        .filter((c) => !c.checked)
        .map((c) => c.dataset.tabVis);
      applyTabVisibility(hiddenTabs);
      persistCurrentAppState();
    });
  });

  // ── Behavior settings ────────────────────────────────────────────────────
  const notifToggle = $("notificationsToggle");
  const defBackupInput = $("defaultBackupPath");
  const defScriptInput = $("defaultScriptPath");

  // Restore saved preferences
  if (notifToggle) notifToggle.checked = Boolean(appState?.preferences?.notificationsEnabled);
  if (notifToggle) {
    notifToggle.addEventListener("change", async () => {
      if (!notifToggle.checked) return;
      await requestNotificationPermission();
      if (_notificationPermission !== "granted") {
        notifToggle.checked = false;
        scheduleAppStateSave({ preferences: { notificationsEnabled: false } }, { delay: 0, silent: false });
        showToast("Desktop notifications are blocked in this window. Allow notifications and try again.", true);
      }
    });
  }
  if (defBackupInput) defBackupInput.value = appState?.preferences?.defaultBackupPath || readAppPreference("defaultBackupPath", "");
  if (defScriptInput) defScriptInput.value = appState?.preferences?.defaultScriptPath || readAppPreference("defaultScriptPath", "");

  // Browse buttons for default paths
  const defBackupBrowse = $("defaultBackupBrowse");
  const defScriptBrowse = $("defaultScriptBrowse");
  if (defBackupBrowse) {
    defBackupBrowse.onclick = async () => {
      try {
        await chooseFolderForInput("defaultBackupPath", "Choose default backup folder");
      } catch (error) {
        showToast(error.message, true);
      }
    };
  }
  if (defScriptBrowse) {
    defScriptBrowse.onclick = async () => {
      try {
        await chooseFolderForInput("defaultScriptPath", "Choose default script output folder");
      } catch (error) {
        showToast(error.message, true);
      }
    };
  }

  // Enter-to-Save: pressing Enter anywhere in the Settings panel triggers Save All
  $("tab-customize").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.target.classList?.contains("shortcut-input") && !e.target.readOnly) return;
    if (e.target.tagName === "TEXTAREA" || e.target.tagName === "BUTTON") return;
    e.preventDefault();
    $("saveAllSettings").click();
  });

  $("factoryResetApp").onclick = async function () {
    const choice = await showConfirmModal({
      title: "Factory Reset",
      message: "This will permanently erase all profiles, preferences, logs, and generated files. Export a backup first?",
      buttons: ["Export & Reset", "Reset Without Saving", "Cancel"],
    });

    if (!choice || choice === "Cancel") return;

    if (choice === "Export & Reset") {
      try {
        showToast("Preparing backup…", false);
        const bundle = await api("/api/data-export");
        const date = new Date().toISOString().slice(0, 10);
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `pebloy-backup-${date}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast("Backup downloaded. Proceeding with reset…", false);
      } catch (error) {
        showToast(`Export failed: ${error.message}`, true);
        return;
      }
    }

    const restore = setButtonLoading(this, "Resetting…");
    try {
      showToast("Clearing saved app data...", false);
      await api("/api/factory-reset", { method: "POST" });
      try { localStorage.clear(); } catch (_e) {}
      showToast("Factory reset completed. Reloading...");
      window.location.reload();
    } catch (error) {
      showToast(`Factory reset failed: ${error.message}`, true);
    } finally {
      restore();
    }
  };

  // ── Keyboard Shortcuts ──────────────────────────────────────────────────
  const SHORTCUT_CONFIG = {
    resolveObjects: {
      label:       "Resolve & Add Objects",
      default:     "Ctrl+D",
      description: "Parses pasted object names, looks up each one's real type and schema from the source database, then adds them to the working set.",
    },
    runActiveTab: {
      label:       "Run Active Tab Action",
      default:     "Ctrl+Enter",
      description: "Triggers the primary 'go' button on whichever tab is active — Resolve & Add (Objects), Run Diff, Run Backup, or Run Deployment. Mirrors SSMS F5 (Execute) behavior, context-aware per tab.",
    },
    findInEditor: {
      label:       "Find in Editor",
      default:     "Ctrl+F",
      description: "Opens the inline find bar inside the Specify Objects editor. Same key as VS Code and SSMS Edit > Find and Replace > Quick Find.",
    },
    replaceInEditor: {
      label:       "Find & Replace in Editor",
      default:     "Ctrl+H",
      description: "Opens the find bar with replace fields visible in the Specify Objects editor. Same key as VS Code and SSMS Edit > Find and Replace > Quick Replace.",
    },
    uppercaseText: {
      label:       "Uppercase Selection",
      default:     "Ctrl+Shift+U",
      description: "Converts the currently-selected text in the editor to UPPERCASE. Mirrors SSMS Edit > Advanced > Make Uppercase.",
    },
    lowercaseText: {
      label:       "Lowercase Selection",
      default:     "Ctrl+Shift+L",
      description: "Converts the currently-selected text in the editor to lowercase. Mirrors SSMS Edit > Advanced > Make Lowercase.",
    },
  };

  function renderShortcutsTable() {
    const tbody = $("shortcutsBody");
    if (!tbody) return;
    const sc = appState?.preferences?.shortcuts || {};
    tbody.innerHTML = Object.entries(SHORTCUT_CONFIG)
      .map(([key, cfg]) => {
        const current = sc[key] || "";
        const isDefault = current === cfg.default;
        const rowTitle = escapeHtml(`${cfg.label} — ${cfg.description}\n\nDefault: ${cfg.default}`);
        return `<tr title="${rowTitle}" class="shortcut-row">
<td class="shortcut-label-cell">
  <div class="shortcut-label">${escapeHtml(cfg.label)}</div>
  <div class="shortcut-desc muted">${escapeHtml(cfg.description)}</div>
</td>
<td class="shortcut-input-cell">
  <div class="shortcut-input-row">
    <input class="shortcut-input" data-key="${key}" value="${escapeHtml(current)}" readonly placeholder="Click to record…" />
    <button type="button" class="shortcut-reset btn-icon" data-key="${key}" data-default="${escapeHtml(cfg.default)}" title="Reset to default (${escapeHtml(cfg.default)})" ${isDefault ? "disabled" : ""}>↺</button>
  </div>
  <div class="shortcut-default-hint muted">Default: <code>${escapeHtml(cfg.default)}</code></div>
</td>
</tr>`;
      })
      .join("");

    function commitShortcut(input, val) {
      const key = input.dataset.key;
      const next = { ...getShortcuts(), [key]: val };
      scheduleAppStateSave({ preferences: { shortcuts: next } }, { delay: 0, silent: false });
      renderShortcutBadges();
      // Update the inline reset button's disabled state based on whether the new value matches default
      const resetBtn = tbody.querySelector(`.shortcut-reset[data-key="${key}"]`);
      if (resetBtn) resetBtn.disabled = (val === SHORTCUT_CONFIG[key]?.default);
      showToast(`Shortcut saved: ${val}`);
    }

    tbody.querySelectorAll(".shortcut-reset").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.key;
        const def = btn.dataset.default;
        const input = tbody.querySelector(`.shortcut-input[data-key="${key}"]`);
        if (!input) return;
        input.value = def;
        commitShortcut(input, def);
      });
    });

    tbody.querySelectorAll(".shortcut-input").forEach((input) => {
      const savedVal = () => appState?.preferences?.shortcuts?.[input.dataset.key] || "";
      let recording = "";

      input.addEventListener("focus", () => {
        input.readOnly = false;
        recording = "";
        input.value = "Press combo, then Enter to save…";
      });

      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          recording = "";
          input.value = savedVal();
          input.blur();
          return;
        }
        e.preventDefault();

        if (e.key === "Enter" && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
          if (recording) {
            input.value = recording;
            commitShortcut(input, recording);
            recording = "";
          }
          input.blur();
          return;
        }

        if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

        const parts = [];
        if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
        if (e.shiftKey) parts.push("Shift");
        if (e.altKey)   parts.push("Alt");
        parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
        recording = parts.join("+");
        input.value = recording + "  (press Enter to save)";
      });

      input.addEventListener("blur", () => {
        input.readOnly = true;
        if (recording) {
          commitShortcut(input, recording);
          input.value = recording;
          recording = "";
        } else if (input.value.startsWith("Press combo") || input.value.includes("press Enter")) {
          input.value = savedVal();
        }
      });
    });
  }

  renderShortcutsTable();

  // ── Restore from Backup ─────────────────────────────────────────────────
  const restoreBtn = $("restoreBackupBtn");
  const restoreFile = $("restoreBackupFile");
  if (restoreBtn && restoreFile) {
    restoreBtn.onclick = () => restoreFile.click();
    restoreFile.onchange = async () => {
      const file = restoreFile.files?.[0];
      if (!file) return;
      restoreFile.value = "";
      try {
        const text = await file.text();
        const bundle = JSON.parse(text);
        if (typeof bundle !== "object" || Array.isArray(bundle)) {
          throw new Error("Invalid backup file format.");
        }
        const restore = setButtonLoading(restoreBtn, "Restoring…");
        try {
          const result = await api("/api/data-import", {
            method: "POST",
            body: JSON.stringify(bundle),
          });
          const count = result.profilesImported ?? (bundle.profiles?.length ?? 0);
          showToast(`Restored ${count} connection(s). Reloading…`);
          setTimeout(() => window.location.reload(), 1200);
        } finally {
          restore();
        }
      } catch (error) {
        showToast(`Restore failed: ${error.message}`, true);
      }
    };
  }

  // Load settings when the Customize tab becomes active
  document.querySelector(".tab[data-tab='customize']").addEventListener("click", loadSettings);
  loadSettings();
}

function setupFontSelector() {
  const fontEl = document.getElementById("fontSelector");
  const sizeEl = document.getElementById("fontSizeRange");
  const sizeLabel = document.getElementById("fontSizeLabel");

  function applyFont(font, persist = true) {
    document.body.style.fontFamily = `'${font}', -apple-system, BlinkMacSystemFont, sans-serif`;
    if (fontEl) fontEl.value = font;
    if (persist) scheduleAppStateSave({ preferences: { fontFamily: font } }, { delay: 0 });
  }

  function applyFontSize(size, persist = true) {
    document.documentElement.style.fontSize = size + "px";
    if (sizeEl) sizeEl.value = size;
    if (sizeLabel) sizeLabel.textContent = size + "px";
    if (persist) scheduleAppStateSave({ preferences: { fontSize: size } }, { delay: 0 });
  }

  const savedFont = appState?.preferences?.fontFamily || readAppPreference("font", DEFAULT_APPEARANCE_FONT_FAMILY);
  if (savedFont) applyFont(savedFont, false);

  const savedSize = appState?.preferences?.fontSize || Number(readAppPreference("fontSize", DEFAULT_APPEARANCE_FONT_SIZE));
  if (savedSize) applyFontSize(Number(savedSize), false);
  else if (sizeLabel) sizeLabel.textContent = sizeEl ? sizeEl.value + "px" : `${DEFAULT_APPEARANCE_FONT_SIZE}px`;

  if (fontEl) fontEl.onchange = () => applyFont(fontEl.value);
  if (sizeEl) sizeEl.oninput = () => applyFontSize(Number(sizeEl.value));
}

function setupProfileImportExport() {
  const exportBtn = $("exportProfiles");
  const importBtn = $("importProfilesBtn");
  const importFile = $("importProfilesFile");

  if (exportBtn) {
    exportBtn.onclick = async () => {
      const restore = setButtonLoading(exportBtn, "Exporting...");
      try {
        const profiles = await api("/api/profiles/export");
        const blob = new Blob([JSON.stringify(profiles, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "pebloy-connections.json";
        a.click();
        URL.revokeObjectURL(url);
        showToast(`Exported ${profiles.length} connection(s)`);
      } catch (error) {
        showToast(error.message, true);
      } finally {
        restore();
      }
    };
  }

  if (importBtn && importFile) {
    importBtn.onclick = () => importFile.click();
    importFile.onchange = async () => {
      const file = importFile.files?.[0];
      if (!file) return;
      importFile.value = "";
      const restore = setButtonLoading(importBtn, "Importing...");
      try {
        const text = await file.text();
        const profiles = JSON.parse(text);
        if (!Array.isArray(profiles)) throw new Error("Expected a JSON array of connections.");
        const result = await api("/api/profiles/import", {
          method: "POST",
          body: JSON.stringify({ profiles }),
        });
        await refreshProfiles();
        const errMsg = result.errors?.length
          ? ` (${result.errors.length} skipped: ${result.errors[0].error})`
          : "";
        showToast(`Imported ${result.created} connection(s)${errMsg}`);
      } catch (error) {
        showToast(`Import failed: ${error.message}`, true);
      } finally {
        restore();
      }
    };
  }
}

function downloadTextFile(fileName, content, mimeType = "text/plain") {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function setupFormatter() {
  const host = $("formatterShell");
  if (!host) return;

  if (getFormatterWorkbench()?.destroy) {
    getFormatterWorkbench().destroy();
    globalThis.pebloyFormatterWorkbench = null;
  }

  if (!globalThis.PebloyFormatterWorkbench?.createFormatterWorkbench) {
    throw new Error("Formatter workbench assets failed to load.");
  }

  globalThis.pebloyFormatterWorkbench = await globalThis.PebloyFormatterWorkbench.createFormatterWorkbench({
    api,
    beginTaskProgress,
    buildTimestampFileSuffix,
    downloadTextFile,
    electronAPI: getElectronApi(),
    endTaskProgress,
    initialState: cloneJson(appState?.ui?.formatter || {}),
    onStateChange(formatterState, { delay = 250 } = {}) {
      scheduleAppStateSave({ ui: { formatter: formatterState } }, { delay, silent: true });
    },
    resetTaskProgress,
    showToast,
    updateTaskProgress,
  });
  requestAnimationFrame(() => getFormatterWorkbench()?.layout?.());
}

function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    const sc = getShortcuts();
    const runBtnIds = { objects: "resolveAndAddObjects", diff: "runDiff", backup: "runBackup", deploy: "runDeployment", formatter: "formatterFormatBtn" };
    if (matchesShortcut(e, sc.runActiveTab || "Ctrl+Enter")) {
      e.preventDefault();
      const btn = $(runBtnIds[getActiveTabName()]);
      if (btn) btn.click();
    }
  });
}

async function start() {
  await loadPersistedAppState();
  tabInit();
  setupTheme();
  setupFontSelector();
  setupPanelToggles({
    maximizeToggleId: "specifyToggle",
    wrapperId: "specifyWrap",
    bodyId: "objectsSpecifySection",
    focusTargetId: "sharedObjectText",
  });
  setupPanelToggles({
    maximizeToggleId: "diffViewerToggle",
    wrapperId: "diffMaxWrap",
    bodyId: "diffList",
  });
  setupProfileForm();
  setupProfileImportExport();
  await setupObjectsTab();
  setupDiff();
  setupBackup();
  setupDeployment();
  setupCustomize();
  await setupFormatter();
  setupFormatSqlCheckboxes();
  setupUpdater();
  setupParallelTasksPanel();
  setupKeyboardShortcuts();
  renderShortcutBadges();
  bindAppStatePersistence();

  $("refreshLogs").onclick = () => refreshLogs(1);
  $("clearLogDetail").onclick = () => {
    const pre = $("logDetail");
    pre.classList.add("hidden");
    pre.textContent = "";
  };

  $("clearAllLogs").onclick = async function () {
    if (!confirm("Delete all log files? This cannot be undone.")) return;
    const restore = setButtonLoading(this, "Clearing…");
    try {
      showToast("Clearing log files...", false);
      await api("/api/logs", { method: "DELETE" });
      await refreshLogs(1);
      showToast("All logs cleared");
    } catch (error) {
      showToast("Failed to clear logs: " + error.message, true);
    } finally {
      restore();
    }
  };
  ["logFilterType", "logFilterStatus", "logFilterLevel", "logFilterDate"].forEach((id) => {
    const el = $(id);
    if (el) el.onchange = () => refreshLogs(1);
  });

  connectSSE();

  await refreshProfiles();
  applyPersistedUiState();
  await refreshLogs();
  syncSharedObjectSummary();

  if (appState?.preferences?.notificationsEnabled) {
    requestNotificationPermission();
  }
}

start().catch((error) => showToast(error.message, true));
