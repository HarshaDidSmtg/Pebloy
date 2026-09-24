let currentDiffReport = null;
let currentDiffIndex = -1;
let sharedSelectedObjects = [];
let sharedDiscoveredObjects = [];
const discoveredSelectedObjects = new Set();
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
let _selectionPage = 1;
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

let sessionTokenPromise = null;

async function api(path, options = {}) {
  const { timeoutMs = 0, ...fetchOptions } = options;
  const method = String(fetchOptions.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...fetchOptions.headers };
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    if (!sessionTokenPromise) {
      sessionTokenPromise = fetch("/api/session", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error("Unable to authorize this session. Reload Pebloy.");
          return (await response.json()).token;
        })
        .catch((error) => { sessionTokenPromise = null; throw error; });
    }
    headers["X-Pebloy-Token"] = await sessionTokenPromise;
  }
  let timeoutId = null;
  if (timeoutMs > 0) {
    const controller = new AbortController();
    fetchOptions.signal = controller.signal;
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  let response;
  try {
    response = await fetch(path, {
      ...fetchOptions,
      headers,
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
    if (response.status === 403) sessionTokenPromise = null;
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
      folderSourcePath: $("folderSourcePath")?.value.trim() || "",
      objectsTypeFilter: $("sharedTypeFilter")?.value || "",
      objectsSchemaFilter: $("sharedSchemaFilter")?.value || "",
      objectsNameFilter: $("sharedNameFilter")?.value.trim() || "",
      discoverPageSize: Number($("discoverPageSize")?.value || 50),
      archiveRetentionDays: Number($("archiveRetentionDays")?.value || 90),
      sharedObjectText: getSharedObjectTextValue(),
      sharedSelectedObjects: cloneJson(sharedSelectedObjects),
      diffSourceProfileId: $("diffSourceProfile")?.value || "",
      diffDestProfileId: $("diffDestProfile")?.value || "",
      diffEngine: $("diffEngine")?.value || "Legacy",
      backupProfileId: $("backupProfile")?.value || "",
      backupPath: $("backupPath")?.value.trim() || "",
      deploySourceProfileId: $("deploySourceProfile")?.value || "",
      deployDestProfileId: $("deployDestProfile")?.value || "",
      diffView: { ...diffViewPrefs },
      deployTargetMode: $("deployTargetMode").value,
      deployTargetIds: [...document.querySelectorAll("[data-batch-target]:checked")].map((input) => input.value),
      continueTargetsOnError: $("continueTargetsOnError").checked,
      deployEngine: $("deployEngine")?.value || "Legacy",
      // Writing to the source is a deliberate one-off action, never a restored default.
      deployMode: $("deployMode")?.value === "FormatAndExecuteSource" ? "ExecuteDirectly" : ($("deployMode")?.value || "ExecuteDirectly"),
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
    $("folderSourcePath").value = ui.folderSourcePath || "";
    $("discoverPageSize").value = String([25, 50, 100].includes(ui.discoverPageSize) ? ui.discoverPageSize : 50);
    $("archiveRetentionDays").value = String(ui.archiveRetentionDays || 90);
    applyObjectModeUI();

    setSharedObjectTextValue(ui.sharedObjectText || "");
    sharedSelectedObjects = dedupeObjects(Array.isArray(ui.sharedSelectedObjects) ? ui.sharedSelectedObjects : []);
    renderSharedSelectionTable();

    if ($("diffSourceProfile")) $("diffSourceProfile").value = ui.diffSourceProfileId || "";
    if ($("diffDestProfile")) $("diffDestProfile").value = ui.diffDestProfileId || "";
    if ($("diffEngine")) $("diffEngine").value = ui.diffEngine || "Legacy";
    const diffView = ui.diffView || {};
    if (["split", "unified"].includes(diffView.mode)) diffViewPrefs.mode = diffView.mode;
    if (["3", "10", "full"].includes(String(diffView.context))) diffViewPrefs.context = String(diffView.context);
    if (typeof diffView.wrap === "boolean") diffViewPrefs.wrap = diffView.wrap;

    if ($("backupProfile")) $("backupProfile").value = ui.backupProfileId || "";
    if ($("backupPath")) {
      $("backupPath").value = ui.backupPath || prefs.defaultBackupPath || "";
    }

    if ($("deploySourceProfile")) $("deploySourceProfile").value = ui.deploySourceProfileId || "";
    if ($("deployDestProfile")) $("deployDestProfile").value = ui.deployDestProfileId || "";
    $("deployTargetMode").value = ui.deployTargetMode === "multiple" ? "multiple" : "single";
    $("deployTargetMode").dispatchEvent(new Event("change"));
    $("continueTargetsOnError").checked = Boolean(ui.continueTargetsOnError);
    document.querySelectorAll("[data-batch-target]").forEach((input) => { input.checked = (ui.deployTargetIds || []).includes(input.value); });
    if ($("deployEngine")) {
      $("deployEngine").value = "Legacy";
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
  populateDiscoverDropdowns();
}

function bindAppStatePersistence() {
  const textIds = ["sharedObjectText", "sharedNameFilter", "folderSourcePath", "backupPath", "deployScriptPath", "defaultBackupPath", "defaultScriptPath"];
  const changeIds = [
    "objectsProfile",
    "objectsMode",
    "sharedTypeFilter",
    "sharedSchemaFilter",
    "discoverPageSize",
    "archiveRetentionDays",
    "diffSourceProfile",
    "diffDestProfile",
    "diffEngine",
    "backupProfile",
    "deploySourceProfile",
    "deployDestProfile",
    "deployTargetMode",
    "continueTargetsOnError",
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
  bar.removeAttribute("aria-valuenow");
  bar.style.width = "40%";
  bar.style.background = "linear-gradient(90deg, var(--accent), var(--accent-2))";
  text.textContent = label || "Running...";
}

function updateTaskProgress(key, label, percent = null) {
  const bar = $(`${key}ProgressBar`);
  const text = $(`${key}ProgressText`);
  if (!bar || !text) return;

  if (!Number.isFinite(percent)) {
    bar.classList.add("is-indeterminate");
    bar.removeAttribute("aria-valuenow");
    bar.style.width = "40%";
  } else {
    bar.classList.remove("is-indeterminate");
    bar.setAttribute("aria-valuenow", String(Math.max(0, Math.min(100, percent))));
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
  bar.setAttribute("aria-valuenow", "100");
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
  bar.setAttribute("aria-valuenow", "0");
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

const FORMAT_SQL_CONTROL_IDS = ["formatGeneratedSqlToggle", "formatSqlDeploy", "formatSqlDiff"];

function applyFeatureSettings(features) {
  const enabled = features?.schedules === true;
  $("scheduleSection").classList.toggle("hidden", !enabled);
  $("schedulesFeatureToggle").checked = enabled;
  document.dispatchEvent(new CustomEvent("pebloy:schedules-feature", { detail: { enabled } }));
}

function applyFormattingSettings(formatting) {
  const enabled = Boolean(formatting?.formatGeneratedSql);
  for (const id of FORMAT_SQL_CONTROL_IDS) {
    const el = $(id);
    if (el) el.checked = enabled;
  }
  const backupMode = $("backupFormatMode");
  if (backupMode) {
    backupMode.value = enabled ? "format" : "off";
  }
}

function isFormatGeneratedSqlEnabled() {
  return Boolean($("formatGeneratedSqlToggle")?.checked);
}

function applyExecutionSettings(execution) {
  for (const key of ["queryTimeoutSeconds", "powershellTimeoutSeconds", "maxActiveTaskLogs"]) {
    const field = $(key);
    if (field && execution?.[key] != null) field.value = execution[key];
  }
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
      if (backupMode.value === "formatExecute") {
        backupMode.value = isFormatGeneratedSqlEnabled() ? "format" : "off";
        runSourceFormatAndExecute();
        return;
      }
      persistFormatting(backupMode.value === "format");
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
  const sortedProfiles = sortProfiles(profiles, _profileSort).sort((left, right) => (left.groupName || "").localeCompare(right.groupName || ""));
  const { items, pages } = paginate(sortedProfiles, page, pageSize);
  const rows = items
    .map(
      (p, index) => `${index === 0 || (p.groupName || "") !== (items[index - 1].groupName || "") ? `<tr class="profile-group"><th colspan="6" scope="rowgroup">${escapeHtml(p.groupName || "Ungrouped")}</th></tr>` : ""}<tr>
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
  $("profileGroup").value = p.groupName || "";
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
  $("profileGroup").value = "";
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

function renderSharedSelectionTable(page = _selectionPage) {
  syncSharedObjectSummary();

  if (sharedSelectedObjects.length === 0) {
    $("sharedSelectionTable").innerHTML = "<p>No objects selected.</p>";
    return;
  }

  const { filterText, filtered, sorted } = getSharedSelectionViewObjects();
  const selectedIndices = new Map(sharedSelectedObjects.map((object, index) => [object, index]));
  const pages = Math.max(1, Math.ceil(sorted.length / DISCOVER_PAGE_SIZE));
  _selectionPage = Math.min(Math.max(1, page), pages);
  const visible = sorted.slice((_selectionPage - 1) * DISCOVER_PAGE_SIZE, _selectionPage * DISCOVER_PAGE_SIZE);

  const rows = visible
    .map(
      (o) => {
        const realIdx = selectedIndices.get(o);
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
<div class="table-viewport">
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
</table></div>
${pages > 1 ? `<div class="selection-paging">
<button type="button" id="selectionPrev" ${_selectionPage === 1 ? "disabled" : ""}>Prev</button>
<span>Page ${_selectionPage} of ${pages} (${sorted.length} objects)</span>
<button type="button" id="selectionNext" ${_selectionPage === pages ? "disabled" : ""}>Next</button>
</div>` : ""}`;
  if ($("selectionPrev")) $("selectionPrev").onclick = () => renderSharedSelectionTable(_selectionPage - 1);
  if ($("selectionNext")) $("selectionNext").onclick = () => renderSharedSelectionTable(_selectionPage + 1);

  document.querySelectorAll("[data-sort-sel]").forEach((th) => {
    th.tabIndex = 0;
    th.setAttribute("aria-sort", _selectionSort.col === th.dataset.sortSel ? (_selectionSort.dir === "asc" ? "ascending" : "descending") : "none");
    th.onkeydown = (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); th.click(); } };
    th.onclick = () => {
      const col = th.dataset.sortSel;
      if (_selectionSort.col === col) {
        _selectionSort.dir = _selectionSort.dir === "asc" ? "desc" : "asc";
      } else {
        _selectionSort = { col, dir: "asc" };
      }
      renderSharedSelectionTable(1);
      $("sharedSelectionTable").querySelector(`[data-sort-sel="${col}"]`)?.focus();
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
  const pageSize = Number($("discoverPageSize").value) || DISCOVER_PAGE_SIZE;
  const sortedDiscovered = sortObjects(sharedDiscoveredObjects, _discoveredSort);
  const discoveredIndices = new Map(sharedDiscoveredObjects.map((object, index) => [object, index]));
  const sortArrow = (col) => _discoveredSort.col === col ? (_discoveredSort.dir === "asc" ? " ↑" : " ↓") : "";

  const total = sortedDiscovered.length;
  const usePagination = total > pageSize;
  const pages = usePagination ? Math.ceil(total / pageSize) : 1;
  _discoverPage = Math.min(Math.max(1, page ?? _discoverPage), pages);
  const pageItems = usePagination
    ? sortedDiscovered.slice((_discoverPage - 1) * pageSize, _discoverPage * pageSize)
    : sortedDiscovered;

  const rows = pageItems
    .map((o) => {
      const origIdx = discoveredIndices.get(o);
      return `<tr>
    <td><input type='checkbox' data-discovered='${origIdx}' aria-label='Select ${escapeHtml(`${o.schemaName}.${o.objectName}`)}' ${discoveredSelectedObjects.has(o) ? "checked" : ""} /></td>
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
    const start = (_discoverPage - 1) * pageSize + 1;
    const end = Math.min(_discoverPage * pageSize, total);
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
<div class="discovery-actions">
  <button type="button" id="discoverSelectVisible">Select All Visible</button>
  <button type="button" id="discoverUnselectVisible">Unselect All Visible</button>
  <span id="discoveredSelectionCount" class="muted"></span>
</div>
<div class="table-viewport">
<table class='table'>
<thead><tr>
  <th><input type='checkbox' id='selectAllDiscoveredCb' title='Select or clear visible objects' aria-label='Select or clear visible objects' /></th>
  <th data-sort-disc="type" style="cursor:pointer;user-select:none">Type${sortArrow("type")}</th>
  <th data-sort-disc="object" style="cursor:pointer;user-select:none">Object${sortArrow("object")}</th>
  <th data-sort-disc="created" style="cursor:pointer;user-select:none">Created${sortArrow("created")}</th>
  <th data-sort-disc="modified" style="cursor:pointer;user-select:none">Modified${sortArrow("modified")}</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>
${paginationHtml}`;

  $("discoverSelectVisible").onclick = () => setVisibleDiscoveredSelection(true);
  $("discoverUnselectVisible").onclick = () => setVisibleDiscoveredSelection(false);
  syncDiscoveredSelectionHeader();

  document.querySelectorAll("[data-sort-disc]").forEach((th) => {
    th.tabIndex = 0;
    th.setAttribute("aria-sort", _discoveredSort.col === th.dataset.sortDisc ? (_discoveredSort.dir === "asc" ? "ascending" : "descending") : "none");
    th.onkeydown = (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); th.click(); } };
    th.onclick = () => {
      const col = th.dataset.sortDisc;
      if (_discoveredSort.col === col) {
        _discoveredSort.dir = _discoveredSort.dir === "asc" ? "desc" : "asc";
      } else {
        _discoveredSort = { col, dir: "asc" };
      }
      _discoverPage = 1;
      renderSharedObjectPicker(1);
      $("sharedObjectPicker").querySelector(`[data-sort-disc="${col}"]`)?.focus();
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

function syncDiscoveredSelectionHeader() {
  const checkboxes = [...$("sharedObjectPicker").querySelectorAll("input[data-discovered]")];
  const selectedCount = checkboxes.filter((checkbox) => checkbox.checked).length;
  const header = $("selectAllDiscoveredCb");
  if (header) {
    header.checked = checkboxes.length > 0 && selectedCount === checkboxes.length;
    header.indeterminate = selectedCount > 0 && selectedCount < checkboxes.length;
  }
  const count = $("discoveredSelectionCount");
  if (count) count.textContent = `${discoveredSelectedObjects.size} selected`;
}

function setVisibleDiscoveredSelection(selected) {
  $("sharedObjectPicker").querySelectorAll("input[data-discovered]").forEach((checkbox) => {
    const object = sharedDiscoveredObjects[Number(checkbox.dataset.discovered)];
    if (!object) return;
    if (selected) discoveredSelectedObjects.add(object);
    else discoveredSelectedObjects.delete(object);
    checkbox.checked = selected;
  });
  syncDiscoveredSelectionHeader();
}

async function refreshProfiles() {
  const profiles = await api("/api/profiles");
  renderProfilesTable(profiles);
  const existingTargets = document.querySelectorAll("[data-batch-target]");
  const selectedTargets = new Set(existingTargets.length ? [...existingTargets].filter((input) => input.checked).map((input) => input.value) : appState?.ui?.deployTargetIds || []);
  $("deployBatchTargets").innerHTML = profiles.map((profile) => `<label class="flag-label"><input type="checkbox" data-batch-target value="${escapeHtml(profile.id)}" ${selectedTargets.has(profile.id) ? "checked" : ""} /> ${escapeHtml(profile.groupName ? `${profile.groupName} / ${profile.profileLabel}` : profile.profileLabel)} (${escapeHtml(profile.databaseName)})</label>`).join("");

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
    select.replaceChildren(new Option("Select connection", ""));
    const groups = new Map();
    profiles.forEach((p) => {
        const groupName = p.groupName || "Ungrouped";
        if (!groups.has(groupName)) {
          const group = document.createElement("optgroup");
          group.label = groupName;
          groups.set(groupName, group);
        }
        const h = _profileHealth.get(p.id);
        const healthNote = !h ? " [never tested]" : h.status === "ok" ? ` [OK ${_timeAgo(h.testedAt)}]` : ` [FAIL]`;
        groups.get(groupName).append(new Option(`${p.profileLabel} (${p.serverName}/${p.databaseName})${healthNote}`, p.id));
    });
    [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).forEach(([, group]) => select.append(group));
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
      groupName: $("profileGroup").value,
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

function sourceRequestFields(profileId) {
  return $("objectsMode").value === "Folder" ? { sourceFolder: $("folderSourcePath").value.trim() } : { sourceProfileId: profileId };
}

function applyObjectModeUI() {
  const mode = $("objectsMode").value;
  $("objectsSpecifySection").classList.toggle("hidden", mode !== "Specify");
  $("objectsDiscoverSection").classList.toggle("hidden", mode !== "Discover");
  const folder = mode === "Folder";
  $("objectsFolderSection").classList.toggle("hidden", !folder);
  $("specifyWrap").classList.toggle("hidden", folder);
  ["objectsProfile", "diffSourceProfile", "backupProfile", "deploySourceProfile", "refreshSelectedObjects", "fetchObjectDependencies"].forEach((id) => { $(id).disabled = folder; });
  document.querySelectorAll(".folder-source-label").forEach((element) => {
    element.classList.toggle("hidden", !folder);
    element.textContent = `Folder source: ${$("folderSourcePath").value || "(not selected)"}`;
  });
  $("backupFormatMode").querySelector('[value="formatExecute"]').disabled = folder;
  if (folder && $("backupFormatMode").value === "formatExecute") $("backupFormatMode").value = "off";
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
  discoveredSelectedObjects.clear();
  sharedDiscoveredObjects.forEach((object) => discoveredSelectedObjects.add(object));
  _discoverPage = 1;
  updateTaskProgress("objects", `Rendering ${sharedDiscoveredObjects.length} discovered objects...`, 85);
  renderSharedObjectPicker(1);
  endTaskProgress("objects", true, "Objects");
  showToast(`Discovered ${sharedDiscoveredObjects.length} objects`);
}

let discoverDropdownRequest = 0;
let discoverDropdownProfileId = null;

function updateDiscoverFilter(select, values, label, selectedValue = "") {
  const options = [{ value: "", label }, ...values.map((value) => ({ value, label: value }))];
  if (select.options.length !== options.length || options.some((option, index) =>
    select.options[index]?.value !== option.value || select.options[index]?.textContent !== option.label)) {
    select.replaceChildren(...options.map((option) => new Option(option.label, option.value)));
  }
  select.value = values.includes(selectedValue) ? selectedValue : "";
}

async function populateDiscoverDropdowns() {
  const request = ++discoverDropdownRequest;
  const profileId = $("objectsProfile").value;
  const typeSel = $("sharedTypeFilter");
  const schemaSel = $("sharedSchemaFilter");
  const isCurrent = () => request === discoverDropdownRequest && $("objectsProfile").value === profileId && $("objectsMode").value === "Discover";
  if (!profileId) {
    updateDiscoverFilter(typeSel, [], "(All Types)");
    updateDiscoverFilter(schemaSel, [], "(All Schemas)");
    typeSel.disabled = schemaSel.disabled = true;
    discoverDropdownProfileId = null;
    return;
  }
  if ($("objectsMode").value !== "Discover") return;
  const sameProfile = discoverDropdownProfileId === profileId;
  const remembered = discoverDropdownProfileId === null && appState?.ui?.objectsProfileId === profileId ? appState.ui : {};
  if (!sameProfile) {
    updateDiscoverFilter(typeSel, [], "(Loading types...)");
    updateDiscoverFilter(schemaSel, [], "(Loading schemas...)");
    typeSel.disabled = schemaSel.disabled = true;
  }
  try {
    const params = new URLSearchParams({ profileId });
    const { types: typeOptions, schemas: schemaOptions } = await api(`/api/objects/filters?${params.toString()}`);
    if (!isCurrent()) return;
    updateDiscoverFilter(typeSel, typeOptions, "(All Types)", sameProfile ? typeSel.value : remembered.objectsTypeFilter);
    updateDiscoverFilter(schemaSel, schemaOptions, "(All Schemas)", sameProfile ? schemaSel.value : remembered.objectsSchemaFilter);
    if (discoverDropdownProfileId === null && !$("sharedNameFilter").value) $("sharedNameFilter").value = remembered.objectsNameFilter || "";
    discoverDropdownProfileId = profileId;
    typeSel.disabled = schemaSel.disabled = false;
  } catch (error) {
    if (!isCurrent()) return;
    if (!sameProfile) {
      updateDiscoverFilter(typeSel, [], "(Types unavailable)");
      updateDiscoverFilter(schemaSel, [], "(Schemas unavailable)");
    }
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

    const dialogId = ++modalDialogSequence;
    const overlay = document.createElement("div");
    overlay.className = "confirm-modal-overlay dependency-modal-overlay";
    overlay.innerHTML = `
      <div class="confirm-modal dependency-modal" role="dialog" aria-modal="true" aria-labelledby="dependencyModalTitle-${dialogId}">
        <div class="dependency-modal-header">
          <div>
            <h4 id="dependencyModalTitle-${dialogId}">Fetch Dependencies</h4>
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
          <input id="dependencySearchInput" class="dependency-search-input" aria-label="Search dependencies" placeholder="Search by type, schema, object, or parent..." />
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

    let releaseFocus = () => {};
    const close = (value) => {
      if (closed) return;
      closed = true;
      overlay.remove();
      releaseFocus();
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
    releaseFocus = trapModalFocus(overlay);
    render();
    const importButton = overlay.querySelector("[data-dependency-action='import']");
    (importButton.disabled ? overlay.querySelector(".dependency-modal-close") : importButton).focus();

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
  $("folderSourcePath").addEventListener("input", applyObjectModeUI);
  $("folderSourceBrowse").onclick = async () => {
    try { await chooseFolderForInput("folderSourcePath", "Choose source SQL folder"); applyObjectModeUI(); }
    catch (error) { showToast(error.message, true); }
  };
  $("loadFolderSource").onclick = async function () {
    const restore = setButtonLoading(this, "Reading SQL...");
    try {
      const result = await api("/api/sources/folder", { method: "POST", body: JSON.stringify({ folderPath: $("folderSourcePath").value }) });
      $("folderSourcePath").value = result.folderPath;
      sharedSelectedObjects = dedupeObjects(result.objects);
      renderSharedSelectionTable();
      applyObjectModeUI();
      persistCurrentAppState({ delay: 0 });
      showToast(`Loaded ${sharedSelectedObjects.length} folder objects`);
    } catch (error) { showToast(error.message, true); }
    finally { restore(); }
  };
  $("discoverPageSize").onchange = () => renderSharedObjectPicker(1);
  $("objectsProfile").onchange = () => {
    populateDiscoverDropdowns();
  };
  $("objectsMode").onchange = () => {
    applyObjectModeUI();
    populateDiscoverDropdowns();
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

  $("sharedNameFilter").addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || e.isComposing || e.defaultPrevented) return;
    e.preventDefault();
    try { await discoverSharedObjects(); } catch (err) { showToast(err.message, true); }
  });

  $("addDiscoveredObjects").onclick = () => {
    const chosen = sharedDiscoveredObjects.filter((object) => discoveredSelectedObjects.has(object));

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
      setVisibleDiscoveredSelection(e.target.checked);
    } else if (e.target.matches("input[data-discovered]")) {
      const object = sharedDiscoveredObjects[Number(e.target.dataset.discovered)];
      if (object && e.target.checked) discoveredSelectedObjects.add(object);
      else discoveredSelectedObjects.delete(object);
      syncDiscoveredSelectionHeader();
    }
  });

  $("clearSharedObjects").onclick = () => {
    const hadSelection = sharedSelectedObjects.length > 0;
    if (hadSelection && !confirm(`Clear all ${sharedSelectedObjects.length} selected object(s)?`)) return;
    const resetState = editorHelpers.getClearSelectionUiState(hadSelection);
    sharedSelectedObjects = [];
    if (resetState.clearDiscovered) {
      sharedDiscoveredObjects = [];
      discoveredSelectedObjects.clear();
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
    filterInput.addEventListener("input", () => renderSharedSelectionTable(1));
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
  $("exportDiff").onclick = async function () {
    if (!currentDiffReport) return;
    const restore = setButtonLoading(this, "Exporting...");
    try {
      const result = await api("/api/diff/export", { method: "POST", body: JSON.stringify({ format: $("diffExportFormat").value, report: currentDiffReport }) });
      $("diffExportResult").classList.remove("hidden");
      $("diffExportResult").textContent = result.filePath;
      showToast("Diff exported");
    } catch (error) { showToast(error.message, true); }
    finally { restore(); }
  };
  $("copyDiff").onclick = async () => {
    if (!currentDiffReport) return;
    try {
      const result = await api("/api/diff/clipboard", { method: "POST", body: JSON.stringify({ report: currentDiffReport }) });
      await navigator.clipboard.writeText(result.text);
      showToast("Diff Markdown copied");
    } catch (error) { showToast(`Could not copy diff: ${error.message}`, true); }
  };
  document.addEventListener("keydown", (event) => {
    if (getActiveTabName() !== "diff" || !event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== "c" || event.target.closest("input, textarea, [contenteditable], .monaco-editor")) return;
    event.preventDefault();
    $("copyDiff").click();
  });
  // Alt+Up/Down matches the WinMerge/Beyond Compare next-difference convention.
  document.addEventListener("keydown", (event) => {
    if (getActiveTabName() !== "diff" || !event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key) || event.target.closest("input, textarea, select, [contenteditable], .monaco-editor")) return;
    event.preventDefault();
    moveDiffChange(event.key === "ArrowDown" ? 1 : -1);
  });
  narrowDiffQuery.addEventListener("change", () => {
    if (currentDiffReport && $("diffViewer")) renderDiffViewer(currentDiffReport);
  });

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
          ...sourceRequestFields(sourceProfileId),
          destinationProfileId,
          engine: $("diffEngine")?.value || "Legacy",
          selectedObjects: sharedSelectedObjects,
        }),
      });

      const filteredReport = filterDiffBySharedObjects(result.report);
      currentDiffReport = filteredReport;
      currentDiffIndex = -1;
      diffExpandedGaps = new Map();
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

const DIFF_FILTER_LABELS = { all: "All", changed: "Changed", added: "Added", missing: "Missing" };
const DIFF_STATUS_GLYPHS = { changed: ["~", "Different in source and target"], added: ["+", "Only in source"], missing: ["\u2212", "Only in target"] };
const DIFF_ROW_STATUSES = new Set(["unchanged", "modified", "added", "removed"]);
const diffViewPrefs = { mode: "split", context: "3", wrap: true };
const diffListFilter = { status: "all", query: "" };
let diffExpandedGaps = new Map();
let diffActiveChange = 0;
const diffTokenCache = new WeakMap();
const diffReviewRowCache = new WeakMap();
const DIFF_REVIEW_STATUS = { added: "removed", removed: "added", modified: "modified", unchanged: "unchanged" };
const narrowDiffQuery = window.matchMedia("(max-width: 760px)");

// Reports store source on the left; review shows target (current) -> source (incoming), as deployment would apply it.
function getReviewRows(detail) {
  let rows = diffReviewRowCache.get(detail);
  if (!rows) {
    rows = (detail?.lineDiff || []).map((row) => ({
      status: DIFF_REVIEW_STATUS[row.status] || "modified",
      leftLineNumber: row.rightLineNumber,
      leftText: row.rightText,
      leftChanges: row.rightChanges,
      rightLineNumber: row.leftLineNumber,
      rightText: row.leftText,
      rightChanges: row.leftChanges,
    }));
    diffReviewRowCache.set(detail, rows);
  }
  return rows;
}

function renderDiff(report) {
  $("exportDiff").disabled = $("copyDiff").disabled = !report;
  $("diffSummary").innerHTML = `
<div class='card'><strong>Added</strong><div>${report.summary.added}</div></div>
<div class='card'><strong>Missing</strong><div>${report.summary.missing}</div></div>
<div class='card'><strong>Changed</strong><div>${report.summary.changed}</div></div>
<div class='card'><strong>Unchanged</strong><div>${report.summary.unchanged}</div></div>`;

  const changed = report.details.map((detail, index) => ({ detail, index })).filter(({ detail }) => detail.status !== "Unchanged");
  if (!changed.length) {
    $("diffList").innerHTML = "<p class='diff-empty'>No differences found for the selected object list.</p>";
    return;
  }
  if (!changed.some(({ index }) => index === currentDiffIndex)) {
    currentDiffIndex = changed[0].index;
    diffActiveChange = 0;
  }
  const counts = { all: changed.length, changed: 0, added: 0, missing: 0 };
  for (const { detail } of changed) {
    const status = String(detail.status).toLowerCase();
    if (status in counts) counts[status] += 1;
  }
  if (!counts[diffListFilter.status]) diffListFilter.status = "all";

  $("diffList").innerHTML = `<div class="diff-layout">
<aside class="diff-object-list" aria-label="Changed objects">
  <div class="diff-object-list-header">
    <span class="diff-object-list-title">Changed objects</span>
    <span class="diff-count-badge">${changed.length}</span>
  </div>
  <input id="diffObjectSearch" class="diff-object-search" type="search" placeholder="Filter by name or type" aria-label="Filter changed objects" value="${escapeHtml(diffListFilter.query)}" />
  <div class="diff-filter-chips" role="group" aria-label="Filter by status">
    ${Object.keys(DIFF_FILTER_LABELS).map((key) => `<button type="button" class="diff-chip" data-diff-filter="${key}" aria-pressed="${diffListFilter.status === key}"${counts[key] ? "" : " disabled"}>${DIFF_FILTER_LABELS[key]}<span class="diff-chip-count">${counts[key]}</span></button>`).join("")}
  </div>
  <div id="diffObjectItems" class="diff-object-items"></div>
</aside>
<section id="diffViewer" class="diff-view"></section>
</div>`;

  $("diffObjectSearch").addEventListener("input", (event) => {
    diffListFilter.query = event.target.value;
    renderDiffObjectItems(report);
  });
  $("diffList").querySelectorAll("[data-diff-filter]").forEach((chip) => {
    chip.onclick = () => {
      diffListFilter.status = chip.dataset.diffFilter;
      $("diffList").querySelectorAll("[data-diff-filter]").forEach((other) => other.setAttribute("aria-pressed", String(other === chip)));
      renderDiffObjectItems(report);
    };
  });
  renderDiffObjectItems(report);
  renderDiffViewer(report);
}

function diffLineStats(detail) {
  let added = 0;
  let removed = 0;
  for (const row of getReviewRows(detail)) {
    if (row.status === "added" || row.status === "modified") added += 1;
    if (row.status === "removed" || row.status === "modified") removed += 1;
  }
  return { added, removed };
}

function renderDiffObjectItems(report) {
  const container = $("diffObjectItems");
  if (!container) return;
  const query = diffListFilter.query.trim().toLowerCase();
  const items = report.details.map((detail, index) => ({ detail, index })).filter(({ detail }) => {
    const status = String(detail.status).toLowerCase();
    if (status === "unchanged" || (diffListFilter.status !== "all" && status !== diffListFilter.status)) return false;
    return !query || `${detail.objectType} ${detail.schemaName}.${detail.objectName}`.toLowerCase().includes(query);
  });
  container.innerHTML = items.length ? items.map(({ detail, index }) => {
    const status = String(detail.status).toLowerCase();
    const [glyph, title] = DIFF_STATUS_GLYPHS[status] || ["?", String(detail.status)];
    const stats = diffLineStats(detail);
    const name = `${detail.schemaName}.${detail.objectName}`;
    return `<button type="button" class="diff-object-item" data-diff-index="${index}"${index === currentDiffIndex ? ' aria-current="true"' : ""} title="${escapeHtml(`${detail.objectType} ${name} \u2014 ${title}`)}">
  <span class="diff-object-glyph diff-glyph-${status}" aria-hidden="true">${glyph}</span>
  <span class="diff-object-main"><span class="diff-object-name">${escapeHtml(name)}</span><span class="diff-object-type">${escapeHtml(detail.objectType)}</span></span>
  <span class="diff-object-counts" title="${stats.added} lines added and ${stats.removed} removed if the source is applied to the target"><span class="diff-stat-add">+${stats.added}</span><span class="diff-stat-del">\u2212${stats.removed}</span></span>
</button>`;
  }).join("") : "<p class='diff-empty'>No objects match this filter.</p>";
  container.querySelectorAll("[data-diff-index]").forEach((button) => {
    button.onclick = () => {
      currentDiffIndex = Number(button.dataset.diffIndex);
      diffActiveChange = 0;
      renderDiffObjectItems(report);
      renderDiffViewer(report);
    };
  });
}

const SQL_KEYWORDS = new Set(("ADD AFTER ALL ALTER AND ANSI_NULLS ANY APPLY AS ASC AUTHORIZATION BEGIN BETWEEN BREAK BY CASCADE CASE CAST CATCH CHECK " +
  "CLOSE CLUSTERED COALESCE COLLATE COLUMN COMMIT CONSTRAINT CONTINUE CONVERT CREATE CROSS CURSOR DATABASE DEALLOCATE DECLARE DEFAULT DELETE DESC " +
  "DISTINCT DROP ELSE END ESCAPE EXCEPT EXEC EXECUTE EXISTS FETCH FOR FOREIGN FROM FULL FUNCTION GO GOTO GRANT GROUP HAVING IDENTITY IF IN INDEX INNER " +
  "INSERT INSTEAD INTERSECT INTO IS JOIN KEY LEFT LIKE MATCHED MERGE NOCHECK NOCOUNT NONCLUSTERED NOT NULL NULLIF OF OFF ON OPEN OPTION OR ORDER OUT " +
  "OUTER OUTPUT OVER PARTITION PERCENT PIVOT PRIMARY PRINT PROC PROCEDURE QUOTED_IDENTIFIER RAISERROR READONLY REFERENCES RETURN RETURNS REVOKE " +
  "RIGHT ROLLBACK ROWCOUNT SCHEMA SCHEMABINDING SELECT SEQUENCE SET SOME SYNONYM TABLE THEN THROW TOP TRAN TRANSACTION TRIGGER TRUNCATE TRY TYPE " +
  "UNION UNIQUE UNPIVOT UPDATE USE USING VALUES VIEW WHEN WHERE WHILE WITH").split(" "));
const SQL_TYPES = new Set(("BIGINT BINARY BIT CHAR DATE DATETIME DATETIME2 DATETIMEOFFSET DECIMAL FLOAT GEOGRAPHY HIERARCHYID INT MAX MONEY NCHAR " +
  "NUMERIC NVARCHAR REAL ROWVERSION SMALLDATETIME SMALLINT SMALLMONEY SQL_VARIANT SYSNAME TIME TINYINT UNIQUEIDENTIFIER VARBINARY VARCHAR XML").split(" "));
const SQL_WORD = /[A-Za-z_@#][\w@#$]*/y;
const SQL_NUMBER = /\d+(?:\.\d+)?/y;

// State carries block comments and quoted text across lines of one side of the diff.
function tokenizeSqlLine(text, state) {
  const tokens = [];
  let position = 0;
  const push = (type, end) => {
    if (end <= position) return;
    const value = text.slice(position, end);
    const last = tokens[tokens.length - 1];
    if (last && last.type === type) last.text += value;
    else tokens.push({ type, text: value });
    position = end;
  };
  while (position < text.length) {
    if (state.comment > 0) {
      let end = position;
      while (end < text.length && state.comment > 0) {
        if (text.startsWith("/*", end)) { state.comment += 1; end += 2; }
        else if (text.startsWith("*/", end)) { state.comment -= 1; end += 2; }
        else end += 1;
      }
      push("com", end);
      continue;
    }
    if (state.quote) {
      const close = state.quote === "[" ? "]" : state.quote;
      let end = position;
      while (end < text.length) {
        if (text[end] !== close) { end += 1; continue; }
        if (text[end + 1] === close) { end += 2; continue; }
        end += 1;
        state.quote = null;
        break;
      }
      push(close === "'" ? "str" : "ident", end);
      continue;
    }
    const char = text[position];
    if (text.startsWith("--", position)) { push("com", text.length); continue; }
    if (text.startsWith("/*", position)) { state.comment = 1; push("com", position + 2); continue; }
    if (char === "'" || ((char === "N" || char === "n") && text[position + 1] === "'")) {
      state.quote = "'";
      push("str", position + (char === "'" ? 1 : 2));
      continue;
    }
    if (char === "[" || char === "\"") { state.quote = char; push("ident", position + 1); continue; }
    SQL_NUMBER.lastIndex = position;
    const number = /\w/.test(text[position - 1] || "") ? null : SQL_NUMBER.exec(text);
    if (number) { push("num", position + number[0].length); continue; }
    SQL_WORD.lastIndex = position;
    const word = SQL_WORD.exec(text);
    if (word) {
      const upper = word[0].toUpperCase();
      push(word[0][0] === "@" ? "var" : SQL_KEYWORDS.has(upper) ? "kw" : SQL_TYPES.has(upper) ? "type" : "", position + word[0].length);
      continue;
    }
    push("", position + 1);
  }
  return tokens;
}

function getDiffTokens(detail) {
  let cached = diffTokenCache.get(detail);
  if (cached) return cached;
  const left = { comment: 0, quote: null };
  const right = { comment: 0, quote: null };
  cached = getReviewRows(detail).map((row) => ({
    left: row.leftLineNumber == null ? null : tokenizeSqlLine(String(row.leftText || ""), left),
    right: row.rightLineNumber == null ? null : tokenizeSqlLine(String(row.rightText || ""), right),
  }));
  diffTokenCache.set(detail, cached);
  return cached;
}

// Splits syntax tokens at word-change boundaries so both highlights can apply to one character run.
function renderSqlTokens(tokens, changes, changeClass) {
  let html = "";
  let offset = 0;
  let changeIndex = 0;
  for (const token of tokens) {
    let position = 0;
    while (position < token.text.length) {
      const absolute = offset + position;
      while (changeIndex < changes.length && changes[changeIndex][1] <= absolute) changeIndex += 1;
      const change = changes[changeIndex];
      const inChange = Boolean(change && change[0] <= absolute);
      const limit = inChange ? change[1] : change ? change[0] : Infinity;
      const end = Math.min(token.text.length, limit - offset);
      const classes = [token.type && `tk-${token.type}`, inChange && changeClass].filter(Boolean).join(" ");
      const piece = escapeHtml(token.text.slice(position, end));
      html += classes ? `<span class="${classes}">${piece}</span>` : piece;
      position = end;
    }
    offset += token.text.length;
  }
  return html;
}

function collectDiffChanges(rows) {
  const changes = [];
  rows.forEach((row, index) => {
    if (row.status === "unchanged") return;
    if (index && rows[index - 1].status !== "unchanged") changes[changes.length - 1].end = index;
    else changes.push({ start: index, end: index });
  });
  return changes;
}

function mapDiffChanges(rows, changes) {
  const changeOf = new Int32Array(rows.length).fill(-1);
  changes.forEach((change, index) => changeOf.fill(index, change.start, change.end + 1));
  return changeOf;
}

function buildDiffSegments(rows, context, expanded) {
  const visible = new Uint8Array(rows.length).fill(context === "full" ? 1 : 0);
  if (context !== "full") {
    const radius = Number(context) || 3;
    rows.forEach((row, index) => {
      if (row.status !== "unchanged") visible.fill(1, Math.max(0, index - radius), Math.min(rows.length, index + radius + 1));
    });
  }
  const items = [];
  for (let index = 0; index < rows.length;) {
    if (visible[index]) { items.push({ row: index }); index += 1; continue; }
    let end = index;
    while (end < rows.length && !visible[end]) end += 1;
    if (expanded.has(index)) for (let row = index; row < end; row += 1) items.push({ row });
    else items.push({ gapStart: index, gapEnd: end });
    index = end;
  }
  return items;
}

function describeDiffHunk(rows, items, position) {
  let leftStart = null;
  let rightStart = null;
  let leftCount = 0;
  let rightCount = 0;
  for (let next = position + 1; next < items.length && items[next].row !== undefined; next += 1) {
    const row = rows[items[next].row];
    if (row.leftLineNumber != null) { leftStart ??= row.leftLineNumber; leftCount += 1; }
    if (row.rightLineNumber != null) { rightStart ??= row.rightLineNumber; rightCount += 1; }
  }
  return leftCount || rightCount ? `@@ -${leftStart ?? 0},${leftCount} +${rightStart ?? 0},${rightCount} @@` : "";
}

function renderDiffGapRow(rows, items, position, columns) {
  const { gapStart, gapEnd } = items[position];
  const count = gapEnd - gapStart;
  return `<tr class="diff-gap"><td colspan="${columns}"><button type="button" class="diff-expand" data-gap="${gapStart}"><span aria-hidden="true">\u2195</span> Show ${count} unchanged line${count === 1 ? "" : "s"}</button><span class="diff-hunk-header">${escapeHtml(describeDiffHunk(rows, items, position))}</span></td></tr>`;
}

function renderDiffNumber(number, kind) {
  return `<td class="diff-num diff-num-${kind}"${Number.isInteger(number) ? ` data-line="${number}"` : ""}></td>`;
}

function renderDiffCodeCell(tokens, changes, kind) {
  if (kind === "empty" || !tokens) return "<td class='diff-code diff-code-empty'></td>";
  const marker = kind === "del" ? "-" : kind === "ins" ? "+" : " ";
  return `<td class="diff-code diff-code-${kind}" data-marker="${marker}">${renderSqlTokens(tokens, Array.isArray(changes) ? changes : [], `diff-word-${kind}`)}</td>`;
}

function renderSplitDiffRows(rows, items, tokens, changes) {
  const changeOf = mapDiffChanges(rows, changes);
  return items.map((item, position) => {
    if (item.row === undefined) return renderDiffGapRow(rows, items, position, 4);
    const row = rows[item.row];
    const status = DIFF_ROW_STATUSES.has(row.status) ? row.status : "modified";
    const unchanged = status === "unchanged";
    const leftKind = unchanged ? "ctx" : row.leftLineNumber == null ? "empty" : "del";
    const rightKind = unchanged ? "ctx" : row.rightLineNumber == null ? "empty" : "ins";
    return `<tr class="diff-row diff-row-${status}"${unchanged ? "" : ` data-change="${changeOf[item.row]}"`}>${renderDiffNumber(row.leftLineNumber, leftKind)}${renderDiffCodeCell(tokens[item.row].left, row.leftChanges, leftKind)}${renderDiffNumber(row.rightLineNumber, rightKind)}${renderDiffCodeCell(tokens[item.row].right, row.rightChanges, rightKind)}</tr>`;
  }).join("");
}

// Unified view lists each change block's removed lines before its added lines, as git does.
function renderUnifiedDiffRows(rows, items, tokens, changes) {
  const changeOf = mapDiffChanges(rows, changes);
  const html = [];
  for (let position = 0; position < items.length; position += 1) {
    const item = items[position];
    if (item.row === undefined) { html.push(renderDiffGapRow(rows, items, position, 3)); continue; }
    const row = rows[item.row];
    if (row.status === "unchanged") {
      html.push(`<tr class="diff-row diff-row-unchanged">${renderDiffNumber(row.leftLineNumber, "ctx")}${renderDiffNumber(row.rightLineNumber, "ctx")}${renderDiffCodeCell(tokens[item.row].left, null, "ctx")}</tr>`);
      continue;
    }
    let last = position;
    while (last + 1 < items.length && items[last + 1].row !== undefined && rows[items[last + 1].row].status !== "unchanged") last += 1;
    const block = items.slice(position, last + 1).map((entry) => entry.row);
    for (const index of block) {
      if (rows[index].leftLineNumber == null) continue;
      html.push(`<tr class="diff-row diff-row-removed" data-change="${changeOf[index]}">${renderDiffNumber(rows[index].leftLineNumber, "del")}${renderDiffNumber(null, "del")}${renderDiffCodeCell(tokens[index].left, rows[index].leftChanges, "del")}</tr>`);
    }
    for (const index of block) {
      if (rows[index].rightLineNumber == null) continue;
      html.push(`<tr class="diff-row diff-row-added" data-change="${changeOf[index]}">${renderDiffNumber(null, "ins")}${renderDiffNumber(rows[index].rightLineNumber, "ins")}${renderDiffCodeCell(tokens[index].right, rows[index].rightChanges, "ins")}</tr>`);
    }
    position = last;
  }
  return html.join("");
}

function renderDiffMinimap(rows, changes) {
  const total = Math.max(rows.length, 1);
  return changes.map((change, index) => {
    const block = rows.slice(change.start, change.end + 1);
    const kind = block.every((row) => row.status === "added") ? "ins" : block.every((row) => row.status === "removed") ? "del" : "mod";
    const top = ((change.start / total) * 100).toFixed(3);
    const height = (((change.end - change.start + 1) / total) * 100).toFixed(3);
    return `<span class="diff-mark diff-mark-${kind}" data-change="${index}" style="top:${top}%;height:${height}%"></span>`;
  }).join("");
}

function renderDiffStatBar({ added, removed }) {
  const total = added + removed;
  const adds = total ? Math.round((added / total) * 5) : 0;
  const dels = total ? 5 - adds : 0;
  return `<span class="diff-stat-bar" aria-hidden="true">${"<i class='add'></i>".repeat(adds)}${"<i class='del'></i>".repeat(dels)}${"<i></i>".repeat(5 - adds - dels)}</span>`;
}

function renderDiffViewer(report) {
  const viewer = $("diffViewer");
  const detail = report?.details?.[currentDiffIndex];
  if (!viewer || !detail) return;
  const sameObject = viewer.dataset.index === String(currentDiffIndex);
  const previousScroll = sameObject ? viewer.querySelector(".diff-scroll")?.scrollTop || 0 : 0;
  const rows = getReviewRows(detail);
  const status = String(detail.status).toLowerCase();
  const stats = diffLineStats(detail);
  const narrow = narrowDiffQuery.matches;
  const mode = diffViewPrefs.mode === "split" && !narrow ? "split" : "unified";
  const sourceLabel = getSelectedConnectionLabel("diffSourceProfile", "Source");
  const targetLabel = getSelectedConnectionLabel("diffDestProfile", "Target");
  const changes = collectDiffChanges(rows);
  const expanded = diffExpandedGaps.get(currentDiffIndex) || new Set();
  const items = buildDiffSegments(rows, diffViewPrefs.context, expanded);
  const tokens = getDiffTokens(detail);
  const [glyph, glyphTitle] = DIFF_STATUS_GLYPHS[status] || ["", String(detail.status)];
  const body = mode === "split" ? renderSplitDiffRows(rows, items, tokens, changes) : renderUnifiedDiffRows(rows, items, tokens, changes);
  const columns = mode === "split"
    ? "<col class='diff-col-num' /><col /><col class='diff-col-num' /><col />"
    : "<col class='diff-col-num' /><col class='diff-col-num' /><col />";
  const heads = mode === "split"
    ? `<tr><th colspan="2" scope="colgroup"><span class="diff-side-label">Target (current)</span>${escapeHtml(targetLabel)}</th><th colspan="2" scope="colgroup"><span class="diff-side-label">Source (incoming)</span>${escapeHtml(sourceLabel)}</th></tr>`
    : `<tr><th colspan="3" scope="colgroup"><span class="diff-side-label">Target (current)</span>${escapeHtml(targetLabel)} <span aria-hidden="true">\u2192</span> <span class="diff-side-label">Source (incoming)</span>${escapeHtml(sourceLabel)}</th></tr>`;
  const emptyMessage = status === "changed"
    ? "Only structural differences were reported for this object; there are no line-level text changes."
    : "This object has no script text to compare.";

  viewer.innerHTML = `<article class="diff-file">
<header class="diff-file-header">
  <div class="diff-file-title">
    <span class="diff-object-glyph diff-glyph-${status}" title="${escapeHtml(glyphTitle)}" aria-hidden="true">${glyph}</span>
    <span class="diff-type-badge">${escapeHtml(detail.objectType)}</span>
    <h3 class="diff-file-name">${escapeHtml(`${detail.schemaName}.${detail.objectName}`)}</h3>
    <span class="diff-status-pill diff-status-${status}" title="${escapeHtml(glyphTitle)}">${escapeHtml(detail.status)}</span>
  </div>
  <div class="diff-file-stats" title="Changes if the source is applied to the target" aria-label="${stats.added} lines added, ${stats.removed} lines removed">
    <span class="diff-stat-add">+${stats.added}</span><span class="diff-stat-del">\u2212${stats.removed}</span>${renderDiffStatBar(stats)}
  </div>
</header>
<div class="diff-toolbar" role="toolbar" aria-label="Diff view options">
  <div class="diff-segmented" role="group" aria-label="Layout">
    <button type="button" data-diff-mode="split" aria-pressed="${mode === "split"}"${narrow ? " disabled title='Split view needs a wider window'" : ""}>Split</button>
    <button type="button" data-diff-mode="unified" aria-pressed="${mode === "unified"}">Unified</button>
  </div>
  <label class="diff-toolbar-field">Context
    <select id="diffContext"><option value="3">3 lines</option><option value="10">10 lines</option><option value="full">Full object</option></select>
  </label>
  <label class="flag-label"><input type="checkbox" id="diffWrap"${diffViewPrefs.wrap ? " checked" : ""} /> Wrap lines</label>
  <div class="diff-nav" role="group" aria-label="Change navigation">
    <button type="button" id="diffPrevChange" class="btn-ghost" title="Previous change (Alt+Up)" aria-label="Previous change">\u2191</button>
    <span id="diffChangePosition" class="diff-change-position" aria-live="polite"></span>
    <button type="button" id="diffNextChange" class="btn-ghost" title="Next change (Alt+Down)" aria-label="Next change">\u2193</button>
  </div>
</div>
${rows.length ? `<div class="diff-body">
  <div class="diff-scroll" tabindex="0" aria-label="Line differences">
    <table class="diff-grid diff-grid-${mode}${diffViewPrefs.wrap ? "" : " diff-nowrap"}"><colgroup>${columns}</colgroup><thead>${heads}</thead><tbody>${body}</tbody></table>
  </div>
  <div class="diff-minimap" title="Change overview. Select a marker to jump to it.">${renderDiffMinimap(rows, changes)}</div>
</div>` : `<p class="diff-empty">${emptyMessage}</p>`}
</article>`;
  viewer.dataset.index = String(currentDiffIndex);

  viewer.querySelectorAll("[data-diff-mode]").forEach((button) => {
    button.onclick = () => {
      diffViewPrefs.mode = button.dataset.diffMode;
      persistCurrentAppState({ delay: 0 });
      renderDiffViewer(report);
    };
  });
  $("diffContext").value = diffViewPrefs.context;
  $("diffContext").onchange = (event) => {
    diffViewPrefs.context = event.target.value;
    persistCurrentAppState({ delay: 0 });
    renderDiffViewer(report);
  };
  $("diffWrap").onchange = (event) => {
    diffViewPrefs.wrap = event.target.checked;
    persistCurrentAppState({ delay: 0 });
    renderDiffViewer(report);
  };
  $("diffPrevChange").onclick = () => moveDiffChange(-1);
  $("diffNextChange").onclick = () => moveDiffChange(1);
  viewer.querySelectorAll("[data-gap]").forEach((button) => {
    button.onclick = () => {
      expanded.add(Number(button.dataset.gap));
      diffExpandedGaps.set(currentDiffIndex, expanded);
      renderDiffViewer(report);
    };
  });
  viewer.querySelector(".diff-minimap")?.addEventListener("click", (event) => {
    const mark = event.target.closest("[data-change]");
    if (mark) focusDiffChange(Number(mark.dataset.change), true);
  });
  const scroll = viewer.querySelector(".diff-scroll");
  if (scroll) scroll.scrollTop = previousScroll;
  focusDiffChange(diffActiveChange, !sameObject && diffViewPrefs.context === "full");
}

function focusDiffChange(index, scrollIntoView) {
  const viewer = $("diffViewer");
  const position = $("diffChangePosition");
  if (!viewer || !position) return;
  const marks = viewer.querySelectorAll(".diff-minimap [data-change]");
  if (!marks.length) {
    position.textContent = "No line changes";
    $("diffPrevChange").disabled = $("diffNextChange").disabled = true;
    return;
  }
  diffActiveChange = Math.min(Math.max(index, 0), marks.length - 1);
  viewer.querySelectorAll(".diff-row-current, .diff-mark-current").forEach((element) => element.classList.remove("diff-row-current", "diff-mark-current"));
  const rows = viewer.querySelectorAll(`tr[data-change="${diffActiveChange}"]`);
  rows.forEach((row) => row.classList.add("diff-row-current"));
  marks[diffActiveChange].classList.add("diff-mark-current");
  position.textContent = `Change ${diffActiveChange + 1} of ${marks.length}`;
  $("diffPrevChange").disabled = diffActiveChange === 0;
  $("diffNextChange").disabled = diffActiveChange === marks.length - 1;
  const scroll = viewer.querySelector(".diff-scroll");
  if (scrollIntoView && rows[0] && scroll) {
    scroll.scrollTop += rows[0].getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientHeight / 3;
  }
}

function moveDiffChange(delta) {
  focusDiffChange(diffActiveChange + delta, true);
}

function getSelectedConnectionLabel(selectId, fallback) {
  const select = $(selectId);
  const option = select?.selectedOptions?.[0];
  return option?.textContent?.trim() || fallback;
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
          ...sourceRequestFields($("backupProfile").value),
          selectedObjects: sharedSelectedObjects,
          options: {
            destinationPath: $("backupPath").value,
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

function renderDeploymentPlanTable(plan) {
  const hasTargets = plan.some((item) => item.targetLabel);
  const actionLabels = {
    AlterDelta: "Table delta (combined)",
    ExecuteCombinedProcedures: "CREATE OR ALTER (combined procedures)",
    DropAndCreate: "Guarded DROP + CREATE",
    NoStoredModuleText: "Skip: no stored module text",
  };
  let step = 0;
  let previousGroup = null;
  const rows = plan.map((item) => {
    const group = ["TABLE", "PROCEDURE"].includes(item.objectType) ? `${item.targetLabel || ""}|${item.objectType}` : item;
    if (group !== previousGroup) step += 1;
    previousGroup = group;
    return `<tr><td>${step}</td>${hasTargets ? `<td>${escapeHtml(item.targetLabel || "")}</td>` : ""}<td>${escapeHtml(item.objectType)}</td>
      <td>${escapeHtml(item.schemaName)}.${escapeHtml(item.objectName)}</td>
      <td>${escapeHtml(actionLabels[item.action] || item.action)}</td></tr>`;
  }).join("");
  return `<div class="deployment-plan-scroll" tabindex="0" role="region" aria-label="Ordered deployment actions">
    <table class="table"><thead><tr><th>Step</th>${hasTargets ? "<th>Target</th>" : ""}<th>Type</th><th>Object</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function collectDeploymentRequest() {
  return { ...sourceRequestFields($("deploySourceProfile").value), destinationProfileId: $("deployDestProfile").value,
    targetProfileIds: $("deployTargetMode").value === "multiple" ? [...document.querySelectorAll("[data-batch-target]:checked")].map((input) => input.value) : [$("deployDestProfile").value].filter(Boolean),
    mode: $("deployMode").value, engine: "Legacy", continueOnError: $("continueOnError").checked,
    continueTargetsOnError: $("continueTargetsOnError").checked, selectedObjects: structuredClone(sharedSelectedObjects),
    logLevel: $("logLevelSelect").value, options: { scriptOutputPath: $("deployScriptPath").value } };
}

async function reviewBatchDeploymentRequest(request, { title = "Confirm Multi-Target Deployment", confirmLabel = "Confirm & Run Targets", extraMessage = "" } = {}) {
  const payload = structuredClone(request);
  if (!payload.selectedObjects.length || !payload.targetProfileIds.length) throw new Error("Select objects and target connections first.");
  const reviewed = await api("/api/deploy/batch/plan", { method: "POST", body: JSON.stringify(payload) });
  if (payload.sourceFolder ? reviewed.sourceConnection?.kind !== "Folder" : reviewed.sourceConnection?.id !== payload.sourceProfileId) throw new Error("The reviewed source does not match the requested source.");
  if (!/^[a-f0-9]{64}$/.test(reviewed.fingerprint || "") || !Array.isArray(reviewed.plans) || reviewed.plans.length !== payload.targetProfileIds.length || reviewed.plans.some((item, index) => item.targetConnection?.id !== payload.targetProfileIds[index] || !item.plan?.length)) throw new Error("A valid target batch plan was not returned.");
  const plan = reviewed.plans.flatMap((item) => item.plan.map((object) => ({ ...object, targetLabel: item.targetConnection.profileLabel })));
  const message = [extraMessage, `Source: ${reviewed.sourceConnection.profileLabel} (${reviewed.sourceConnection.serverName}/${reviewed.sourceConnection.databaseName})`, `Mode: ${payload.mode}`,
    payload.sourceFolder ? "Folder SQL uses ANSI_NULLS and QUOTED_IDENTIFIER ON unless the files specify otherwise. Confirmation is bound to the inspected folder content." : "",
    ...reviewed.plans.map((item) => `${item.targetConnection.profileLabel}: ${item.targetConnection.serverName}/${item.targetConnection.databaseName}${/prod/i.test(item.targetConnection.environmentTag || "") ? " [PRODUCTION]" : ""}`),
    `Continue within a target on error: ${payload.continueOnError ? "Yes" : "No"}`,
    `Continue to later targets after failure: ${payload.continueTargetsOnError ? "Yes" : "No"}`,
    payload.mode === "DryRun" ? "Scripts only; nothing executes." : "Targets execute sequentially. Earlier successful targets remain committed. Rollback does not cover external effects.",
  ].filter(Boolean).join("\n");
  const answer = await showConfirmModal({ title, message, plan, buttons: [confirmLabel, "Cancel"], defaultButton: 1 });
  if (answer !== confirmLabel) return null;
  payload.options.confirmedBatchFingerprint = reviewed.fingerprint;
  return payload;
}

function renderBatchResult(result) {
  $("deployResult").innerHTML = `<h3>Target Results</h3><div class="table-viewport"><table class="table"><thead><tr><th>Target</th><th>Status</th><th>Objects</th><th>Log</th></tr></thead><tbody>${result.targets.map((target) => `<tr><td>${escapeHtml(target.targetConnection.profileLabel)}</td><td>${escapeHtml(target.status)}${target.error ? `<br>${escapeHtml(target.error)}` : ""}</td><td>${target.summary?.total || 0}</td><td>${escapeHtml(target.logFilePath || "")}</td></tr>`).join("")}</tbody></table></div>${result.targets.map((target) => `<details><summary>${escapeHtml(target.targetConnection.profileLabel)}: ${escapeHtml(target.status)}</summary><pre>${escapeHtml((target.itemResults || []).map((item) => `${item.objectType}\t${item.schemaName}.${item.objectName}\t${item.status}${item.errorMessage ? `: ${item.errorMessage}` : ""}`).join("\n"))}</pre></details>`).join("")}`;
}

async function reviewDeploymentRequest(request) {
  const payload = structuredClone(request);
  if (!payload.selectedObjects.length) throw new Error("No objects selected. Use the Object Selection tab first.");
  if ((!payload.sourceProfileId && !payload.sourceFolder) || !payload.destinationProfileId) throw new Error("Choose a source and target connection before planning deployment.");
  const sourceExecution = payload.mode === "FormatAndExecuteSource";
  const { plan, fingerprint, sourceConnection: source, targetConnection: target } = await api("/api/deploy/plan", { method: "POST", body: JSON.stringify(payload) });
  if (!Array.isArray(plan) || !plan.length || !/^[a-f0-9]{64}$/.test(fingerprint || "") ||
      (payload.sourceFolder ? source?.kind !== "Folder" : source?.id !== payload.sourceProfileId) || target?.id !== payload.destinationProfileId ||
      !source?.serverName || !source?.databaseName || !target?.serverName || !target?.databaseName) {
    throw new Error("A valid deployment plan was not returned. Nothing was executed.");
  }
  const modes = {
    ExecuteDirectly: "Apply Changes",
    Rollback: "Validate Only (Rollback)",
    DryRun: "Dry Run (generate scripts only)",
    FormatAndExecuteSource: "Format & Execute in Source",
  };
  const warnings = payload.mode === "DryRun"
    ? "Scripts only. No SQL will be executed."
    : payload.mode === "Rollback"
      ? "SQL will execute inside a transaction that rolls back. External and non-transactional effects are not covered."
      : "Earlier successful objects or combined groups remain committed if a later step fails. Protected objects may require manual review.";
  const message = [
    `Source: ${source.profileLabel} | ${source.serverName}/${source.databaseName}`,
    `Target: ${target.profileLabel} | ${target.serverName}/${target.databaseName}`,
    `Mode: ${modes[payload.mode]} | ${plan.length} objects`,
    `Continue on error: ${payload.continueOnError ? "Yes" : "No"}`,
    /prod/i.test(target.environmentTag || "") ? `PRODUCTION TARGET: ${target.environmentTag}` : "",
    sourceExecution ? "This modifies SOURCE procedures, views, functions, and triggers. Other object types are skipped." : "",
    payload.sourceFolder ? `Folder: ${source.folderPath}. Module settings default to ANSI_NULLS ON and QUOTED_IDENTIFIER ON unless supplied in each SQL file. File contents are bound to this confirmation.` : "",
    warnings,
    "Order is based on current source metadata. Dynamic SQL and external dependencies may require manual review. Unchanged objects may be skipped after comparison.",
  ].filter(Boolean).join("\n");
  const confirmLabel = payload.mode === "DryRun" ? "Confirm & Generate Scripts" : sourceExecution ? "Confirm & Execute in Source" : "Confirm & Run";
  const answer = await showConfirmModal({
    title: sourceExecution ? "Confirm Source Execution" : "Confirm Deployment Plan",
    message, plan, buttons: [confirmLabel, "Cancel"], defaultButton: 1,
  });
  if (answer !== confirmLabel) return null;
  payload.options = { ...payload.options, confirmedPlanFingerprint: fingerprint,
    ...(sourceExecution ? { confirmedSourceDatabase: source.databaseName } : {}),
  };
  return payload;
}

async function runSourceFormatAndExecute() {
  const button = $("runBackup");
  if (button.disabled) return;
  const restore = setButtonLoading(button, "Loading plan...");
  $("backupFormatMode").disabled = true;
  let started = false;
  try {
    const payload = await reviewDeploymentRequest({
      logLevel: $("logLevelSelect")?.value || "Normal", engine: "Legacy", mode: "FormatAndExecuteSource",
      sourceProfileId: $("backupProfile").value, destinationProfileId: $("backupProfile").value,
      selectedObjects: sharedSelectedObjects, continueOnError: false,
      options: { scriptOutputPath: $("backupPath").value },
    });
    if (!payload) return;
    started = true;
    beginTaskProgress("backup", "Formatting and executing source modules...");
    button.textContent = "Executing in Source...";
    const result = await api("/api/deploy/run", { method: "POST", body: JSON.stringify(payload) });
    const failed = (result.summary?.failed || 0) + (result.summary?.reviewRequired || 0);
    endTaskProgress("backup", !failed, "Source execution");
    $("backupResult").textContent = ["Format & Execute in Source", `Task ID: ${result.taskId}`,
      ...(result.itemResults || []).map((item) => `${item.objectType} ${item.schemaName}.${item.objectName}: ${item.status}${item.errorMessage ? ` - ${item.errorMessage}` : ""}`),
      `Log: ${result.logFilePath || "See Task Logs"}`,
    ].join("\n");
    showToast(`Source execution: ${result.summary?.success || 0} succeeded, ${failed} failed or require review`, Boolean(failed));
    await refreshLogs();
  } catch (error) {
    if (started) endTaskProgress("backup", false, "Source execution");
    showToast(error.message, true);
  } finally {
    $("backupFormatMode").disabled = false;
    restore();
    $("backupFormatMode").focus();
  }
}

function setupSchedules() {
  let entries = [];
  let editing = null;
  async function refresh() {
    const result = await api("/api/schedules");
    entries = result.items;
    $("scheduleWake").disabled = !result.capabilities.wakeApplication;
    $("scheduleRuntime").textContent = `${result.timeZone} | ${result.capabilities.wakeApplication ? "Windows wake-up available (signed-in user)" : "App-open scheduling"}`;
    $("scheduleList").innerHTML = entries.length ? `<table class="table"><thead><tr><th>Name / Mode</th><th>Next Run</th><th>Status</th><th>Last Result</th><th>Actions</th></tr></thead><tbody>${entries.map((entry) => `<tr><td>${escapeHtml(entry.name)}<br>${escapeHtml(entry.request.mode)} / ${entry.request.targetProfileIds.length} target(s)</td><td>${escapeHtml(entry.nextRunAt ? new Date(entry.nextRunAt).toLocaleString("en-GB", { hour12: false }) : "-")}<br>${escapeHtml(entry.repeat)}</td><td>${entry.enabled ? "Enabled" : "Paused"}<br>${escapeHtml(entry.lastStatus)}</td><td>${escapeHtml(entry.lastError || entry.lastResult?.logFilePath || "-")}</td><td><button type="button" data-schedule-action="edit" data-id="${escapeHtml(entry.id)}">Edit Timing</button> <button type="button" data-schedule-action="run" data-id="${escapeHtml(entry.id)}">Run Once</button> <button type="button" data-schedule-action="pause" data-id="${escapeHtml(entry.id)}" ${entry.enabled ? "" : "disabled"}>Pause</button> <button type="button" data-schedule-action="delete" data-id="${escapeHtml(entry.id)}">Delete</button></td></tr>`).join("")}</tbody></table>` : '<p class="muted">No schedules.</p>';
  }
  function reset() {
    editing = null;
    $("scheduleName").value = "";
    $("scheduleTime").value = "";
    $("saveSchedule").textContent = "Review & Save Schedule";
  }
  $("newSchedule").onclick = reset;
  $("refreshSchedules").onclick = () => refresh().catch((error) => showToast(error.message, true));
  $("saveSchedule").onclick = async function () {
    const restore = setButtonLoading(this, "Loading plan...");
    try {
      const date = new Date($("scheduleTime").value);
      if (!$("scheduleName").value.trim() || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error("Enter a schedule name and a future first-run time.");
      const schedule = { name: $("scheduleName").value.trim(), repeat: $("scheduleRepeat").value, nextRunAt: date.toISOString(), wakeApplication: $("scheduleWake").checked, confirmed: true };
      const request = await reviewBatchDeploymentRequest(editing ? editing.request : collectDeploymentRequest(), {
        title: "Confirm Scheduled Deployment", confirmLabel: "Confirm & Save Schedule",
        extraMessage: `Schedule: ${schedule.name}\nFirst run: ${date.toLocaleString("en-GB")}\nRepeat: ${schedule.repeat}\n${schedule.wakeApplication ? "Windows will launch Pebloy while this user is signed in." : "Pebloy must be running."}\nIf a run is missed, one run occurs on the next startup; missed intervals are not replayed. Failures, interruptions, or changed plans require reapproval.`,
      });
      if (!request) return;
      await api(editing ? `/api/schedules/${encodeURIComponent(editing.id)}` : "/api/schedules", { method: editing ? "PUT" : "POST", body: JSON.stringify({ ...schedule, request }) });
      reset();
      await refresh();
      showToast("Schedule saved.");
    } catch (error) { showToast(error.message, true); }
    finally { restore(); }
  };
  $("scheduleList").onclick = async (event) => {
    const button = event.target.closest("[data-schedule-action]");
    if (!button) return;
    const record = entries.find((entry) => entry.id === button.dataset.id);
    if (!record) return;
    const restore = setButtonLoading(button, "Working...");
    try {
      const action = button.dataset.scheduleAction;
      if (action === "edit") {
        editing = structuredClone(record);
        $("scheduleName").value = record.name;
        $("scheduleRepeat").value = record.repeat;
        $("scheduleWake").checked = record.wakeApplication;
        const date = new Date(record.nextRunAt || Date.now() + 3600000);
        date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
        $("scheduleTime").value = date.toISOString().slice(0, 16);
        $("saveSchedule").textContent = "Review & Update Schedule";
        $("scheduleTime").focus();
      } else if (action === "run") {
        const request = await reviewBatchDeploymentRequest(record.request);
        if (request) {
          beginTaskProgress("deploy", "Running scheduled selection...");
          const result = await api("/api/deploy/batch/run", { method: "POST", body: JSON.stringify(request) });
          renderBatchResult(result);
          endTaskProgress("deploy", !(result.summary.failed || result.summary.reviewRequired), "Scheduled selection");
          await refreshLogs();
        }
      } else if (action === "pause") {
        await api(`/api/schedules/${encodeURIComponent(record.id)}/pause`, { method: "POST", body: "{}" });
      } else if (action === "delete") {
        const answer = await showConfirmModal({ title: "Delete Schedule", message: `Delete ${record.name} and its Windows wake-up task? Existing logs and scripts are retained.`, buttons: ["Delete", "Cancel"], defaultButton: 1 });
        if (answer !== "Delete") return;
        await api(`/api/schedules/${encodeURIComponent(record.id)}`, { method: "DELETE", body: JSON.stringify({ confirmed: true }) });
        if (editing?.id === record.id) reset();
      }
      await refresh();
    } catch (error) { endTaskProgress("deploy", false, "Schedule action"); showToast(error.message, true); }
    finally { restore(); }
  };
  document.addEventListener("pebloy:schedules-feature", (event) => {
    if (event.detail.enabled) void refresh().catch((error) => showToast(error.message, true));
  });
}

function setupDeployment() {
  setupSchedules();
  $("deployTargetMode").onchange = () => {
    const multiple = $("deployTargetMode").value === "multiple";
    $("deployBatchSection").classList.toggle("hidden", !multiple);
    $("deployDestProfile").disabled = multiple;
    $("previewDeployPlan").disabled = multiple;
  };
  $("deployBatchTargets").addEventListener("change", () => persistCurrentAppState({ delay: 0 }));
  $("goToObjects").onclick = () => setActiveTab("objects");
  const progressEl = $("deployObjectProgress");
  const retryRow = $("deployRetryRow");
  const previewBtn = $("previewDeployPlan");
  const previewEl = $("deployPlanPreview");
  const deployResultEl = $("deployResult");
  let previewRequestToken = 0;

  const deployModeHints = {
    ExecuteDirectly: "",
    Rollback: "Validation executes SQL and rolls back its transaction. External and non-transactional effects are not covered.",
    DryRun: "Dry Run generates every deployment script, including the table delta, and writes them for review. No SQL is executed.",
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
    if ($("deployTargetMode").value === "multiple") { hideDeployPlanPreview(); return; }
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
          ...sourceRequestFields($("deploySourceProfile")?.value || ""),
          destinationProfileId: $("deployDestProfile")?.value || "",
          mode: $("deployMode").value,
          selectedObjects: sharedSelectedObjects,
          engine: $("deployEngine")?.value || "Legacy",
        }),
      });

      if (requestToken !== previewRequestToken) return;

      previewEl.innerHTML = `<h4>Execution Plan (${plan.length} objects)</h4>${renderDeploymentPlanTable(plan)}`;
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
    $("deployDestProfile").disabled = $("deployTargetMode").value === "multiple";
    const baseHint = deployModeHints[$("deployMode").value] || "";
    const engineHint = "Legacy mode uses the existing per-type execution flow and table delta PowerShell path.";
    const hint = [engineHint, baseHint].filter(Boolean).join(" ");
    const hintEl = $("deployModeHint");
    if (hintEl) hintEl.textContent = hint;
  }

  $("deployMode").addEventListener("change", () => { updateDeployModeHint(); refreshDeploymentPlanPreview(); });
  $("deployEngine").addEventListener("change", () => {
    updateDeployModeHint();
    refreshDeploymentPlanPreview();
  });
  updateDeployModeHint();

  $("deploySourceProfile")?.addEventListener("change", () => { updateDeployModeHint(); refreshDeploymentPlanPreview(); });
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
    const restoreBtn = setButtonLoading(this, "Loading plan...");
    let started = false;

    try {
      if ($("deployTargetMode").value === "multiple") {
        const payload = await reviewBatchDeploymentRequest(collectDeploymentRequest());
        if (!payload) return;
        started = true;
        resetDeployRunArtifacts();
        beginTaskProgress("deploy", "Preparing target batch...");
        const result = await api("/api/deploy/batch/run", { method: "POST", body: JSON.stringify(payload) });
        renderBatchResult(result);
        endTaskProgress("deploy", !(result.summary.failed || result.summary.reviewRequired), "Deployment batch");
        await refreshLogs();
        return;
      }
      const payload = await reviewDeploymentRequest({
          logLevel: $("logLevelSelect")?.value || "Normal",
          ...sourceRequestFields($("deploySourceProfile").value),
          destinationProfileId: $("deployDestProfile").value,
          engine: $("deployEngine")?.value || "Legacy",
          mode: $("deployMode").value,
          continueOnError: $("continueOnError").checked,
          selectedObjects: sharedSelectedObjects,
          options: {
            scriptOutputPath: $("deployScriptPath").value,
          },
      });
      if (!payload) return;
      started = true;
      resetDeployRunArtifacts();
      beginTaskProgress("deploy", "Preparing deployment...");
      this.textContent = "Running...";
      progressEl?.classList.remove("hidden");
      const result = await api("/api/deploy/run", { method: "POST", body: JSON.stringify(payload) });

      endTaskProgress("deploy", (result.summary?.failed || 0) + (result.summary?.reviewRequired || 0) === 0, "Deployment");
      _lastDeployResults = result.itemResults || [];
      renderDeployResult(result);
      if (progressEl) progressEl.classList.add("hidden");

      // Show retry button if any failed
      if ((result.summary?.failed ?? 0) > 0) {
        if (retryRow) retryRow.classList.remove("hidden");
      }
      renderMigrationPrepAction(result);

      if (result.rollbackApplied) {
        const validated = result.summary.rolledBack ?? 0;
        const failed = result.summary.failed ?? 0;
        showToast(failed > 0
          ? `Validation finished with ${failed} error(s). Inspect the target and logs.`
          : `Transaction rolled back for ${validated} object(s). External effects are not covered.`);
      } else {
        showToast(`Deployment done. Success=${result.summary.success}, Failed=${result.summary.failed}, Review Required=${result.summary.reviewRequired || 0}`, Boolean(result.summary.failed || result.summary.reviewRequired));
      }
      await refreshLogs();
    } catch (error) {
      if (started) endTaskProgress("deploy", false, "Deployment");
      if (progressEl) progressEl.classList.add("hidden");
      showToast(error.message, true);
    } finally {
      restoreBtn();
      this.focus();
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
      sharedSelectedObjects = dedupeObjects(items);
      renderSharedSelectionTable();
      persistCurrentAppState({ delay: 0 });
      $("deployRetryRow").classList.add("hidden");
      setActiveTab("objects");
      showToast(`Selection replaced with ${failed.length} failed object(s)`);
    };
  }
}

function renderMigrationPrepAction(result) {
  const row = $("deployRetryRow");
  if (!row) return;
  document.getElementById("generateMigrationPrep")?.remove();
  const needsReview = (result.itemResults || []).filter((item) => item.status === "ReviewRequired");
  if (!needsReview.length) return;

  row.classList.remove("hidden");
  const button = document.createElement("button");
  button.id = "generateMigrationPrep";
  button.type = "button";
  button.className = "btn-ghost";
  button.textContent = `Generate migration script (${needsReview.length})`;
  button.title = "Captures the permissions, ownership, signatures, and dependents that blocked these objects. Nothing is executed.";
  button.onclick = async () => {
    const restore = setButtonLoading(button, "Generating…");
    try {
      const prep = await api("/api/deploy/migration-prep", {
        method: "POST",
        body: JSON.stringify({
          destinationProfileId: $("deployDestProfile").value,
          taskId: result.taskId,
          selectedObjects: needsReview.map(({ objectType, schemaName, objectName }) => ({ objectType, schemaName, objectName })),
        }),
      });
      showToast(`Migration script written for review: ${prep.outputPath}`);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      restore();
    }
  };
  row.appendChild(button);
}

function renderDeployResult(result) {  const s = result.summary || {};
  const isRollback = result.rollbackApplied === true;
  const statusClass = { Success: "deploy-status-success", Failed: "deploy-status-failed", ReviewRequired: "deploy-status-warning", RolledBack: "deploy-status-accent", Skipped: "deploy-status-skipped", PendingDelta: "deploy-status-warning" };
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
      const statusLabel = item.status === "RolledBack" ? "Validated (not applied)" : item.status === "ReviewRequired" ? "Review Required" : item.status;
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
    ? `<p class="muted" style="margin:0 0 0.5rem;font-size:0.82rem">Validation transaction rolled back. External and non-transactional effects are not covered.</p>`
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
  ${(s.reviewRequired || 0) > 0 ? `<div class="card"><strong>Review Required</strong><div>${s.reviewRequired}</div></div>` : ""}
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
let _activeDeployTaskId = null;

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

  es.addEventListener("snapshot", (event) => {
    const { tasks = [] } = JSON.parse(event.data);
    const activeIds = new Set(tasks.map((task) => task.taskId));
    for (const [taskId, task] of _runningTasksMap) {
      if (!activeIds.has(taskId)) endTaskProgress(taskTypeToProgressKey[task.taskType], false, "Task ended while disconnected; inspect Logs");
    }
    _runningTasksMap.clear();
    _activeDeployTaskId = null;
    for (const task of tasks) {
      _runningTasksMap.set(task.taskId, task);
      const key = taskTypeToProgressKey[task.taskType];
      if (key) {
        beginTaskProgress(key, task.progressLabel || `${task.taskType} running...`);
        updateTaskProgress(key, task.progressLabel || `${task.taskType} running...`, task.percent ?? 0);
      }
      if (task.taskType === "Deploy") {
        _activeDeployTaskId = task.taskId;
        const container = $("deployObjectProgress");
        if (container) { container.innerHTML = ""; container.classList.remove("hidden"); }
        for (const progress of task.objectProgress || []) es.dispatchEvent(new MessageEvent("deployProgress", { data: JSON.stringify(progress) }));
      }
    }
    renderTaskbar();
    renderParallelTasksPanel();
    $("parallelTasksPanel")?.classList.toggle("hidden", tasks.length === 0);
    if (tasks.length) startLogAutoRefresh();
    else if (_logAutoRefreshTimer) { clearInterval(_logAutoRefreshTimer); _logAutoRefreshTimer = null; }
    refreshLogs();
  });

  es.addEventListener("taskStart", (e) => {
    const data = JSON.parse(e.data);
    _runningTasksMap.set(data.taskId, { ...data, percent: 0, progressLabel: "Starting…" });
    if (data.taskType === "Deploy") {
      _activeDeployTaskId = data.taskId;
      const container = $("deployObjectProgress");
      if (container) { container.innerHTML = ""; container.classList.remove("hidden"); }
    }
    renderTaskbar();
    renderParallelTasksPanel();
    const panel = $("parallelTasksPanel");
    if (panel) panel.classList.remove("hidden");
    startLogAutoRefresh();
  });

  es.addEventListener("taskEnd", (e) => {
    const data = JSON.parse(e.data);
    _runningTasksMap.delete(data.taskId);
    if (_activeDeployTaskId === data.taskId) _activeDeployTaskId = null;
    const progressKey = taskTypeToProgressKey[data.taskType];
    if (progressKey) endTaskProgress(progressKey, data.status === "Success", data.taskType);
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
    if (data.taskId !== _activeDeployTaskId) return;
    const el = $("deployObjectProgress");
    if (!el || el.classList.contains("hidden")) return;
    const pct = data.total > 0 ? Math.round((data.done / data.total) * 100) : 0;
    const statusIcon = data.status === "Success" ? "✓" : data.status === "Failed" ? "✗" : "…";
    const statusCls = data.status === "Success" ? "progress-ok" : data.status === "Failed" ? "progress-err" : "";
    const name = data.schemaName && data.objectName
      ? `${data.objectType} ${data.schemaName}.${data.objectName}`
      : `${data.objectType} ${data.objectName || ""}`;

    // Find or create row for this object
    let row = el.querySelector(`[data-dp-key="${CSS.escape(`${data.objectType}|${data.schemaName}|${data.objectName}`)}"]`);
    if (!row) {
      row = document.createElement("div");
      row.className = "deploy-progress-row";
      row.dataset.dpKey = `${data.objectType}|${data.schemaName}|${data.objectName}`;
      el.appendChild(row);
    }
    row.innerHTML = `<span class="dp-icon ${statusCls}">${statusIcon}</span><span class="dp-name">${escapeHtml(name)}</span>${data.error ? `<span class="dp-error muted">${escapeHtml(data.error.slice(0, 80))}</span>` : ""}`;

    // Update bar in deploy progress
    updateTaskProgress("deploy", `Deploying objects ${data.done}/${data.total} · ${name}`, pct);
  });

  es.addEventListener("taskProgress", (e) => {
    const data = JSON.parse(e.data);
    if (!_runningTasksMap.has(data.taskId)) return;
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
  ${["Interrupted", "Failed", "ReviewRequired"].includes(l.status) ? `<button class="btn-ghost" style="padding:0.2rem 0.5rem;font-size:0.76rem" data-log-verify='${escapeHtml(l.taskId)}' title="Read-only: compare the target's current state against the source">Verify Target</button>` : ""}
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
  document.querySelectorAll("button[data-log-verify]").forEach((btn) => {
    btn.onclick = async () => {
      const restore = setButtonLoading(btn, "Checking…");
      try {
        const report = await api(`/api/tasks/${btn.dataset.logVerify}/reconcile`, {
          method: "POST",
          body: JSON.stringify({
            sourceProfileId: $("deploySourceProfile")?.value || $("diffSourceProfile")?.value || "",
            destinationProfileId: $("deployDestProfile")?.value || $("diffDestProfile")?.value || "",
          }),
        });
        const pre = $("logDetail");
        pre.classList.remove("hidden");
        pre.textContent = [
          `Target verification — task ${report.taskId} (${report.taskStatus})`,
          `Checked at        : ${formatDateTime(report.checkedAt)}`,
          `Matches source    : ${report.summary.MatchesSource}`,
          `Differs from src  : ${report.summary.DiffersFromSource}`,
          `Missing in target : ${report.summary.MissingInTarget}`,
          `Not comparable    : ${report.summary.NotComparable}`,
          "",
          report.limitation,
          "",
          ...report.details.map((d) => `${d.state.padEnd(18)} ${d.objectType} ${d.schemaName}.${d.objectName}${d.note ? ` — ${d.note}` : ""}`),
        ].join("\n");
        pre.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch (error) {
        showToast(error.message, true);
      } finally {
        restore();
      }
    };
  });

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
  const selectedObjects = Array.isArray(detail.selectedObjects) ? detail.selectedObjects.filter(Boolean) : [];
  const objectRows = selectedObjects.map((item) => [item.objectType || "", [item.schemaName, item.objectName].filter(Boolean).join(".")]
    .map((value) => String(value).replace(/[\t\r\n]/g, " ")).join("\t"));
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
    "Selected Objects",
    "Object Type\tSchema.Object",
    ...(objectRows.length ? objectRows : ["(No objects recorded)"]),
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
  const systemScheme = window.matchMedia("(prefers-color-scheme: dark)");
  $("checkSqlModule").onclick = async function () {
    const restore = setButtonLoading(this, "Checking...");
    try {
      const status = await api("/api/prerequisites/sqlserver");
      $("sqlModuleStatus").textContent = `SqlServer ${status.version}: ${status.filesPresent ? "module files present" : "missing"}\n${status.modulePath}${!status.filesPresent && status.repairInstallation ? "\nRepair the Pebloy installation." : ""}`;
      $("installSqlModule").disabled = status.filesPresent || status.repairInstallation;
    } catch (error) { showToast(error.message, true); }
    finally { restore(); }
  };
  $("installSqlModule").onclick = async function () {
    const restore = setButtonLoading(this, "Installing...");
    try {
      await api("/api/prerequisites/sqlserver/install", { method: "POST", body: "{}" });
      await $("checkSqlModule").onclick();
    } catch (error) { showToast(error.message, true); }
    finally { restore(); }
  };
  const themes = Array.isArray(globalThis.PebloyThemes) && globalThis.PebloyThemes.length
    ? globalThis.PebloyThemes
    : [];
  const themeMap = new Map(themes.map((t) => [t.id, t]));
  const fallbackThemeId = themeMap.has(DEFAULT_APPEARANCE_THEME) ? DEFAULT_APPEARANCE_THEME : themes[0]?.id;
  const validThemes = themes.map((t) => t.id);
  const savedTheme = appState?.preferences?.theme || readAppPreference("theme", "system");
  const legacyThemes = new Map([["light", "pebloy-light"], ["dark", "pebloy-dark"], ["azure", "pebloy-dark"], ["batman", "graphite"]]);
  const resolvedTheme = legacyThemes.get(savedTheme) || savedTheme;
  const saved = resolvedTheme === "system" || validThemes.includes(resolvedTheme) ? resolvedTheme : fallbackThemeId;

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
    const followsSystem = themeId === "system";
    const theme = themeMap.get(followsSystem ? systemScheme.matches ? "pebloy-dark" : "pebloy-light" : themeId) || themeMap.get(fallbackThemeId);
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
    $("followSystemTheme").checked = followsSystem;

    if (persist) scheduleAppStateSave({ preferences: { theme: followsSystem ? "system" : theme.id } }, { delay: 0 });
  }

  $("followSystemTheme").onchange = () => applyTheme($("followSystemTheme").checked ? "system" : themeSelect.value);
  systemScheme.addEventListener("change", () => { if ($("followSystemTheme").checked) applyTheme("system", false); });
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

const modalInertLocks = new WeakMap();
let activeModalCount = 0;
let modalDialogSequence = 0;
let modalFocusOrigin = null;

function trapModalFocus(overlay) {
  if (activeModalCount === 0) modalFocusOrigin = document.activeElement;
  activeModalCount += 1;
  const siblings = [...document.body.children].filter((element) => element !== overlay);
  siblings.forEach((element) => {
    const lock = modalInertLocks.get(element);
    if (lock) lock.count += 1;
    else modalInertLocks.set(element, { count: 1, originalInert: element.inert });
    element.inert = true;
  });
  const handleKey = (event) => {
    if (event.key !== "Tab") return;
    const controls = [...overlay.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')]
      .filter((element) => !element.disabled && element.getClientRects().length);
    const first = controls[0];
    const last = controls.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  overlay.addEventListener("keydown", handleKey);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    overlay.removeEventListener("keydown", handleKey);
    siblings.forEach((element) => {
      const lock = modalInertLocks.get(element);
      if (!lock) return;
      lock.count -= 1;
      if (lock.count > 0) return;
      element.inert = lock.originalInert;
      modalInertLocks.delete(element);
    });
    activeModalCount = Math.max(0, activeModalCount - 1);
    if (activeModalCount > 0) {
      const activeOverlay = [...document.querySelectorAll(".confirm-modal-overlay")].at(-1);
      const focusTarget = [...(activeOverlay?.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]') || [])]
        .find((element) => !element.disabled && element.getClientRects().length);
      focusTarget?.focus();
      return;
    }
    const focusOrigin = modalFocusOrigin;
    modalFocusOrigin = null;
    if (focusOrigin?.isConnected && !focusOrigin.inert) focusOrigin.focus();
  };
}

function showConfirmModal({ title, message, buttons, plan = null, defaultButton = 0 }) {
  return new Promise((resolve) => {
    const dialogId = ++modalDialogSequence;
    const overlay = document.createElement("div");
    overlay.className = "confirm-modal-overlay";
    overlay.innerHTML = `
      <div class="confirm-modal${plan ? " deployment-plan-modal" : ""}" role="dialog" aria-modal="true" aria-labelledby="confirmModalTitle-${dialogId}" aria-describedby="confirmModalMessage-${dialogId}">
        <h4 id="confirmModalTitle-${dialogId}">${escapeHtml(title)}</h4>
        <p id="confirmModalMessage-${dialogId}">${escapeHtml(message)}</p>
        ${plan ? renderDeploymentPlanTable(plan) : ""}
        <div class="confirm-modal-actions">
          ${buttons.map((b, i) => `<button type="button" class="confirm-modal-btn${i === 0 ? " btn-primary" : i === buttons.length - 1 ? " btn-ghost" : ""}" data-idx="${i}">${escapeHtml(b)}</button>`).join("")}
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const releaseFocus = trapModalFocus(overlay);
    let closed = false;
    const close = (value) => {
      if (closed) return;
      closed = true;
      overlay.remove();
      releaseFocus();
      resolve(value);
    };
    overlay.querySelectorAll(".confirm-modal-btn").forEach((btn) => {
      btn.onclick = () => close(buttons[Number(btn.dataset.idx)]);
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close(null);
    });
    overlay.querySelectorAll(".confirm-modal-btn")[defaultButton].focus();
  });
}

function setupCustomize() {
  let currentSettings = null;

  function normalizeCustomizeSettings(settings) {
    const safeFolderNames = { ...DEFAULT_FOLDER_NAMES, ...((settings && settings.folderNames) || {}) };

    return {
      folderNames: safeFolderNames,
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
      execution: {
        queryTimeoutSeconds: Number(settings?.execution?.queryTimeoutSeconds) || 120,
        powershellTimeoutSeconds: Number(settings?.execution?.powershellTimeoutSeconds) || 180,
        maxActiveTaskLogs: Number(settings?.execution?.maxActiveTaskLogs) || 200,
      },
      features: {
        schedules: settings?.features?.schedules === true,
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
    try {
      currentSettings = normalizeCustomizeSettings(await api("/api/settings"));
      renderFolderNames(currentSettings.folderNames);
      if ($("dacfxValidationEnabled")) {
        $("dacfxValidationEnabled").checked = Boolean(currentSettings.dacfx?.validationEnabled);
      }
      applyTimeSettings(currentSettings.time);
      applyFormattingSettings(currentSettings.formatting);
      applyExecutionSettings(currentSettings.execution);
      applyFeatureSettings(currentSettings.features);
    } catch (error) {
      currentSettings = normalizeCustomizeSettings();
      renderFolderNames(currentSettings.folderNames);
      if ($("dacfxValidationEnabled")) {
        $("dacfxValidationEnabled").checked = Boolean(currentSettings.dacfx?.validationEnabled);
      }
      applyTimeSettings(currentSettings.time);
      applyFormattingSettings(currentSettings.formatting);
      applyExecutionSettings(currentSettings.execution);
      applyFeatureSettings(currentSettings.features);
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
      const execution = {
        queryTimeoutSeconds: Number($("queryTimeoutSeconds")?.value) || undefined,
        powershellTimeoutSeconds: Number($("powershellTimeoutSeconds")?.value) || undefined,
        maxActiveTaskLogs: Number($("maxActiveTaskLogs")?.value) || undefined,
      };
      const saved = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ folderNames, dacfx, time, formatting, execution, features: { schedules: $("schedulesFeatureToggle").checked } }),
      });
      currentSettings = normalizeCustomizeSettings(saved);
      applyTimeSettings(currentSettings.time);
      applyFormattingSettings(currentSettings.formatting);
      applyExecutionSettings(currentSettings.execution);
      applyFeatureSettings(currentSettings.features);

      showToast("All settings saved");
    } catch (error) {
      $("schedulesFeatureToggle").checked = currentSettings?.features?.schedules === true;
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
        body: JSON.stringify({ folderNames: DEFAULT_FOLDER_NAMES, dacfx: { validationEnabled: false } }),
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

  $("tab-customize").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing || e.defaultPrevented) return;
    if (e.target.classList?.contains("shortcut-input") && !e.target.readOnly) return;
    if (e.target.tagName !== "INPUT" || !["text", "number", "search", "url", "email"].includes(e.target.type)) return;
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
  let archiveCleanupPreview = null;
  $("archiveRetentionDays").addEventListener("input", () => {
    archiveCleanupPreview = null;
    $("deleteArchiveFiles").disabled = true;
  });
  $("previewArchiveCleanup").onclick = async function () {
    const restore = setButtonLoading(this, "Checking...");
    archiveCleanupPreview = null;
    $("deleteArchiveFiles").disabled = true;
    try {
      archiveCleanupPreview = await api("/api/logs/archive/preview", { method: "POST", body: JSON.stringify({ olderThanDays: Number($("archiveRetentionDays").value) }) });
      $("logDetail").classList.remove("hidden");
      $("logDetail").textContent = [`Archive cleanup: ${archiveCleanupPreview.files.length} files (${archiveCleanupPreview.totalBytes} bytes)`, `Completed before: ${formatDateTime(archiveCleanupPreview.cutoff)}`, "", ...archiveCleanupPreview.files.map((file) => `${file.name}\t${file.bytes} bytes`)].join("\n");
      $("deleteArchiveFiles").disabled = !archiveCleanupPreview.files.length;
    } catch (error) { showToast(error.message, true); }
    finally { restore(); }
  };
  $("deleteArchiveFiles").onclick = async function () {
    const preview = archiveCleanupPreview;
    if (!preview) return;
    const answer = await showConfirmModal({ title: "Delete archived logs?", message: `Permanently delete the ${preview.files.length} files shown in the preview (${preview.totalBytes} bytes)?`, buttons: ["Delete Files", "Cancel"], defaultButton: 1 });
    if (answer !== "Delete Files") return;
    const restore = setButtonLoading(this, "Deleting...");
    try {
      const result = await api("/api/logs/archive/cleanup", { method: "POST", body: JSON.stringify({ token: preview.token, confirmed: true }) });
      $("logDetail").textContent = `Deleted ${result.deleted} archived files.`;
      showToast(`Deleted ${result.deleted} archived files`);
    } catch (error) { showToast(error.message, true); }
    finally { restore(); archiveCleanupPreview = null; $("deleteArchiveFiles").disabled = true; }
  };
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
