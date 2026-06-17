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
const _profileHealth = new Map(); // profileId → { status: 'ok'|'error'|'unknown', testedAt: ISO|null }
let _lastDeployResults = []; // for retry failed
let _selectionSort  = { col: null, dir: "asc" };
let _discoveredSort = { col: null, dir: "asc" };
let _logSort = { col: "startedAt", dir: "desc" };
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
    let av, bv;
    if (col === "created")  { av = a.createdDate  || ""; bv = b.createdDate  || ""; }
    if (col === "modified") { av = a.modifiedDate || ""; bv = b.modifiedDate || ""; }
    const cmp = String(av).localeCompare(String(bv));
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
    ta.placeholder =
      "Paste schema.name (one per line)\n" +
      "Example: dbo.MyProc\n" +
      "         dbo.vw_Orders\n" +
      "         reporting.usp_get_summary\n\n" +
      `Shortcuts: ${sc.resolveObjects} = Resolve & Add  ·  ` +
      `${sc.findInEditor || "Ctrl+F"} = Find  ·  ` +
      `${sc.replaceInEditor || "Ctrl+H"} = Replace  ·  ` +
      `${sc.uppercaseText || "Ctrl+Shift+U"} = UPPER  ·  ` +
      `${sc.lowercaseText || "Ctrl+Shift+L"} = lower`;
  }
}

function $(id) {
  return document.getElementById(id);
}

function getElectronApi() {
  return typeof window !== "undefined" ? window.electronAPI : null;
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

function showToast(message, isError = false) {
  const toast = $("toast");

  if (toast._dismissTimer) clearTimeout(toast._dismissTimer);
  if (toast._dismissHandler) {
    toast.removeEventListener("click", toast._dismissHandler);
    toast._dismissHandler = null;
  }

  toast.textContent = message + (isError ? "  ✕" : "");
  toast.style.background = isError ? "#a3142f" : "#0f2f2f";
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
  const originalText = button.textContent;
  button.disabled = true;
  button.classList.add("btn-loading");
  button.textContent = loadingText;
  return () => {
    button.disabled = false;
    button.classList.remove("btn-loading");
    button.textContent = originalText;
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

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
  return readLegacyPreference(
    `pebloy.${key}`,
    readLegacyPreference(`bdeploy.${key}`, readLegacyPreference(`dbbridge.${key}`, fallback))
  );
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
  return document.querySelector(".tab.active")?.dataset.tab || "credentials";
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
      theme: document.body.dataset.theme || "dark",
      fontFamily: $("fontSelector")?.value || "Space Grotesk",
      fontSize: Number($("fontSizeRange")?.value || 14),
      logLevel: $("logLevelSelect")?.value || "Normal",
      shortcuts,
    },
    ui: {
      activeTab: getActiveTabName(),
      objectsProfileId: $("objectsProfile")?.value || "",
      objectsMode: $("objectsMode")?.value || "Specify",
      sharedObjectText: $("sharedObjectText")?.value || "",
      sharedSelectedObjects: cloneJson(sharedSelectedObjects),
      diffSourceProfileId: $("diffSourceProfile")?.value || "",
      diffDestProfileId: $("diffDestProfile")?.value || "",
      diffExportFormat: $("diffExportFormat")?.value || "md",
      backupProfileId: $("backupProfile")?.value || "",
      backupPath: $("backupPath")?.value.trim() || "",
      deploySourceProfileId: $("deploySourceProfile")?.value || "",
      deployDestProfileId: $("deployDestProfile")?.value || "",
      deployMode: $("deployMode")?.value || "ExecuteDirectly",
      deployScriptPath: $("deployScriptPath")?.value.trim() || "",
      continueOnError: Boolean($("continueOnError")?.checked),
      allowSameSource: Boolean($("allowSameSource")?.checked),
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

    if ($("sharedObjectText")) $("sharedObjectText").value = ui.sharedObjectText || "";
    sharedSelectedObjects = dedupeObjects(Array.isArray(ui.sharedSelectedObjects) ? ui.sharedSelectedObjects : []);
    renderSharedSelectionTable();

    if ($("diffSourceProfile")) $("diffSourceProfile").value = ui.diffSourceProfileId || "";
    if ($("diffDestProfile")) $("diffDestProfile").value = ui.diffDestProfileId || "";
    if ($("diffExportFormat")) $("diffExportFormat").value = ui.diffExportFormat || "md";

    if ($("backupProfile")) $("backupProfile").value = ui.backupProfileId || "";
    if ($("backupPath")) {
      $("backupPath").value = ui.backupPath || prefs.defaultBackupPath || "";
    }

    if ($("deploySourceProfile")) $("deploySourceProfile").value = ui.deploySourceProfileId || "";
    if ($("deployDestProfile")) $("deployDestProfile").value = ui.deployDestProfileId || "";
    if ($("deployMode")) {
      $("deployMode").value = ui.deployMode || "ExecuteDirectly";
      $("deployMode").dispatchEvent(new Event("change"));
    }
    if ($("deployScriptPath")) {
      $("deployScriptPath").value = ui.deployScriptPath || prefs.defaultScriptPath || "";
    }
    if ($("continueOnError")) $("continueOnError").checked = Boolean(ui.continueOnError);
    if ($("allowSameSource")) $("allowSameSource").checked = Boolean(ui.allowSameSource);

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
    "diffExportFormat",
    "backupProfile",
    "deploySourceProfile",
    "deployDestProfile",
    "deployMode",
    "continueOnError",
    "allowSameSource",
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
    bar.style.background = "linear-gradient(90deg, #c1121f, #ef233c)";
  } else {
    bar.style.background = "linear-gradient(90deg, var(--accent), var(--accent-2))";
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
  bar.style.background = "linear-gradient(90deg, var(--accent), var(--accent-2))";
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
  return `${item.objectType}|${item.schemaName}|${item.objectName}`;
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

function formatDateParts(value) {
  if (value === null || value === undefined || value === "" || (typeof value === "object" && !(value instanceof Date))) {
    return null;
  }

  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return null;
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
  return parts ? `${parts.dd}:${parts.mm}:${parts.yyyy}` : "—";
}

function formatDateTime(d) {
  const parts = formatDateParts(d);
  return parts ? `${parts.dd}:${parts.mm}:${parts.yyyy} ${parts.hh}:${parts.mi}:${parts.ss}` : "—";
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
    ["Type", "Object", "Created", "Modified"],
    ...sorted.map((item) => [
      item.objectType || "",
      `${item.schemaName || ""}.${item.objectName || ""}`.replace(/^\./, ""),
      formatDateTime(item.createdDate),
      formatDateTime(item.modifiedDate),
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

    if (shouldMaximize && focusTarget && typeof focusTarget.focus === "function") {
      focusTarget.focus({ preventScroll: true });
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
    });
  });
}

function setActiveTab(tabName) {
  const tabButton = document.querySelector(`.tab[data-tab='${tabName}']`);
  if (tabButton) {
    tabButton.click();
  }
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
  const { items, pages } = paginate(profiles, page, pageSize);
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

  $("profilesTable").innerHTML = `
<table class='table'>
<thead><tr><th>Connection Alias</th><th>SQL Server</th><th>Database</th><th>Authentication</th><th>Environment</th><th>Actions</th></tr></thead>
<tbody>${rows}</tbody>
</table>
${paginationHtml}`;

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
  <th></th>
</tr></thead>
<tbody>${rows || "<tr><td colspan='5' class='muted' style='text-align:center;padding:1rem'>No objects match filter.</td></tr>"}</tbody>
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

function renderSharedObjectPicker() {
  const sortedDiscovered = sortObjects(sharedDiscoveredObjects, _discoveredSort);
  const sortArrow = (col) => _discoveredSort.col === col ? (_discoveredSort.dir === "asc" ? " ↑" : " ↓") : "";

  const rows = sortedDiscovered
    .map(
      (o, i) => {
        // map back to original index for selection tracking
        const origIdx = sharedDiscoveredObjects.indexOf(o);
        return `<tr>
<td><input type='checkbox' data-discovered='${origIdx}' checked /></td>
<td>${escapeHtml(o.objectType)}</td>
<td class="obj-name-cell"><span class="obj-schema">${escapeHtml(o.schemaName)}</span><span class="obj-dot">.</span><span class="obj-name">${escapeHtml(o.objectName)}</span></td>
      <td>${formatDateTime(o.createdDate)}</td><td>${formatDateTime(o.modifiedDate)}</td>
</tr>`;
      }
    )
    .join("");

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
</table>`;

  document.querySelectorAll("[data-sort-disc]").forEach((th) => {
    th.onclick = () => {
      const col = th.dataset.sortDisc;
      if (_discoveredSort.col === col) {
        _discoveredSort.dir = _discoveredSort.dir === "asc" ? "desc" : "asc";
      } else {
        _discoveredSort = { col, dir: "asc" };
      }
      renderSharedObjectPicker();
    };
  });

  const hdrCb = document.getElementById("selectAllDiscoveredCb");
  const rowCbs = () => [...document.querySelectorAll("input[data-discovered]")];

  hdrCb.addEventListener("change", () => {
    rowCbs().forEach((cb) => { cb.checked = hdrCb.checked; });
  });

  $("sharedObjectPicker").addEventListener("change", (e) => {
    if (!e.target.matches("input[data-discovered]")) return;
    const all = rowCbs();
    const checked = all.filter((cb) => cb.checked);
    hdrCb.indeterminate = checked.length > 0 && checked.length < all.length;
    hdrCb.checked = checked.length === all.length;
  });
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
  updateTaskProgress("objects", `Rendering ${sharedDiscoveredObjects.length} discovered objects...`, 85);
  renderSharedObjectPicker();
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
  const parsed = parseObjectLines($("sharedObjectText").value);
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
  $("sharedObjectText").value = "";
  persistCurrentAppState({ delay: 0 });
  endTaskProgress("objects", true, "Objects");
  showToast(
    unresolved > 0
      ? `Added ${valid.length} objects (${unresolved} unresolved: use schema-qualified names when duplicates exist or verify missing objects in Discover mode.)`
      : `Added ${valid.length} objects with resolved types`
  );
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

function setupObjectsTab() {
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

      $("sharedObjectText").value = file.content;
      if (sharedObjectFileName) sharedObjectFileName.textContent = file.fileName || "File selected";
      persistCurrentAppState({ delay: 0 });
      showToast(`Loaded object list: ${file.fileName || "selected file"}`);
    } catch (error) {
      showToast(error.message, true);
    }
  };

  setupEditorShortcuts();

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
    const input = $(resetState.focusTargetId);
    if (input) input.focus();
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

  renderSharedSelectionTable();
  applyObjectModeUI();
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
          selectedObjects: sharedSelectedObjects,
        }),
      });

      const filteredReport = filterDiffBySharedObjects(result.report);
      currentDiffReport = filteredReport;
      currentDiffRows = filteredReport.details.filter((x) => x.status !== "Unchanged");
      currentDiffIndex = 0;
      renderDiff(filteredReport);
      endTaskProgress("diff", true, "Diff");
      showToast(`Diff complete. Task: ${result.taskId}`);
    } catch (error) {
      endTaskProgress("diff", false, "Diff");
      showToast(error.message, true);
    } finally {
      restoreBtn();
    }
  };

  $("exportDiff").onclick = async () => {
    if (!currentDiffReport) {
      showToast("Run a comparison first", true);
      return;
    }

    try {
      const format = $("diffExportFormat").value;
      showToast("Exporting diff report...", false);
      const result = await api("/api/diff/export", {
        method: "POST",
        body: JSON.stringify({ format, report: currentDiffReport }),
      });
      showToast(`Comparison report exported: ${result.filePath}`);
    } catch (error) {
      showToast(error.message, true);
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
  <span>${d.objectType} ${d.schemaName}.${d.objectName}</span>
  <span class='muted'>${d.status}</span>
</button>`
    )
    .join("");

  const selected = changedRows[currentDiffIndex] || changedRows[0];

  $("diffList").innerHTML = `<div class='diff-layout'>
<aside class='diff-object-list'>${listHtml}</aside>
<section class='diff-view'>
  <div class='diff-block'>
    <div class='diff-head'>${selected.objectType} ${selected.schemaName}.${selected.objectName} - ${selected.status}</div>
    ${renderDiffUnified(selected.lineDiff || [])}
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

function renderDiffUnified(lineDiff) {
  if (!lineDiff.length) {
    return "<div class='diff-empty muted'>No line changes.</div>";
  }

  const CONTEXT = 3;

  // Flatten modified rows into del + ins
  const all = lineDiff.flatMap((row) => {
    if (row.status === "modified") {
      return [
        { type: "del", ln1: row.leftLineNumber, ln2: null, text: row.leftText || "" },
        { type: "ins", ln1: null, ln2: row.rightLineNumber, text: row.rightText || "" },
      ];
    }
    if (row.status === "added" || row.status === "Added") {
      return [{ type: "ins", ln1: null, ln2: row.rightLineNumber, text: row.rightText || "" }];
    }
    if (row.status === "removed" || row.status === "Removed") {
      return [{ type: "del", ln1: row.leftLineNumber, ln2: null, text: row.leftText || "" }];
    }
    return [{ type: "ctx", ln1: row.leftLineNumber, ln2: row.rightLineNumber, text: row.leftText || "" }];
  });

  // Determine which indices are visible (changed ± CONTEXT)
  const changed = new Set();
  all.forEach((l, i) => { if (l.type !== "ctx") changed.add(i); });
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
      html += `<tr class="diff-hunk"><td></td><td></td><td></td><td>@@ ${skipped} unchanged line${skipped !== 1 ? "s" : ""} @@</td></tr>`;
    }

    const l = all[i];
    const prefix = l.type === "ins" ? "+" : l.type === "del" ? "-" : " ";
    const cls = l.type === "ins" ? "diff-ins" : l.type === "del" ? "diff-del" : "diff-ctx";
    const ln1 = l.ln1 != null ? l.ln1 : "";
    const ln2 = l.ln2 != null ? l.ln2 : "";
    html += `<tr class="diff-line ${cls}">
<td class="diff-ln">${ln1}</td>
<td class="diff-ln">${ln2}</td>
<td class="diff-prefix">${prefix}</td>
<td class="diff-code mono">${escapeHtml(l.text)}</td>
</tr>`;
    lastIdx = i;
  }

  return `<div class="diff-unified-wrap"><table class="diff-unified"><tbody>${html}</tbody></table></div>`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
          sourceProfileId: $("backupProfile").value,
          selectedObjects: sharedSelectedObjects,
          options: {
            destinationPath: $("backupPath").value,
          },
        }),
      });
      endTaskProgress("backup", true, "Backup");
      $("backupResult").textContent = [
        `Objects backed up : ${result.objectCount}`,
        `Output folder     : ${result.generatedRoot || result.backupFolder}`,
        `Build path file   : ${result.buildPathFile || "(none)"}`,
        `Exact SQL sync    : ${result.exactDefinitionsApplied || 0} programmable object${(result.exactDefinitionsApplied || 0) === 1 ? "" : "s"}`,
        `Exact SQL warning : ${result.exactDefinitionWarning || "(none)"}`,
        `Generated at      : ${formatDateTime(result.restoreReadiness?.generatedAt || new Date())}`,
        `Task ID           : ${result.taskId}`,
      ].join("\n");
      showToast(`Backup scripts generated in ${result.generatedRoot || result.backupFolder}`);
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
    const hint = deployModeHints[$("deployMode").value] || "";
    const hintEl = $("deployModeHint");
    if (hintEl) hintEl.textContent = hint;
  }

  $("deployMode").addEventListener("change", updateDeployModeHint);
  updateDeployModeHint();

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

    const button = this;
    const originalText = button.textContent;
    button.disabled = true;
    button.classList.add("btn-loading");
    button.textContent = "Loading…";
    try {
      if (!sharedSelectedObjects.length) {
        showToast("No objects selected.", true);
        return;
      }
      const { plan } = await api("/api/deploy/plan", {
        method: "POST",
        body: JSON.stringify({ selectedObjects: sharedSelectedObjects }),
      });
      const actionLabels = {
        AlterDelta: "Generate and apply table delta",
        ExecuteIndividually: "Execute object script individually",
        CreateOrAlterIndividually: "Create or alter object script individually",
        DropAndCreate: "Drop and recreate object",
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
      showToast(error.message, true);
    } finally {
      button.disabled = false;
      button.classList.remove("btn-loading");
      button.textContent = originalText;
      syncPreviewButtonLabel();
    }
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
          mode: $("deployMode").value,
          continueOnError: $("continueOnError").checked,
          allowSameSourceDestination: $("allowSameSource").checked,
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
  const statusColor = { Success: "var(--success)", Failed: "var(--danger)", RolledBack: "var(--accent)", Skipped: "var(--muted)", PendingDelta: "var(--warning)" };
  const rows = (result.itemResults || [])
    .map((item) => {
      const color = statusColor[item.status] || "var(--text-2)";
      const name = `${item.schemaName}.${item.objectName}`;
      const err = item.errorMessage ? escapeHtml(item.errorMessage) : "";
      const statusLabel = item.status === "RolledBack" ? "Validated (not applied)" : item.status;
      return `<tr>
<td>${escapeHtml(item.objectType)}</td>
<td>${escapeHtml(name)} <button class="btn-copy-inline" data-copy="${escapeHtml(name)}" title="Copy">&#x2398;</button></td>
<td>${escapeHtml(item.action || "")}</td>
<td style="color:${color};font-weight:600">${statusLabel}</td>
<td style="color:var(--danger);font-size:0.85em">${err}</td>
</tr>`;
    })
    .join("");

  const rollbackNote = isRollback
    ? `<p class="muted" style="margin:0 0 0.5rem;font-size:0.82rem">Rollback (Test Run) — no changes were committed to the database.</p>`
    : "";

  const rolledBackCount = s.rolledBack ?? 0;
  const rolledBackCard = isRollback
    ? `<div class="card"><strong style="color:var(--accent)">Validated</strong><div>${rolledBackCount}</div></div>`
    : "";

  $("deployResult").innerHTML = `
${rollbackNote}
<div class="summary-cards" style="margin-bottom:0.6rem">
  <div class="card"><strong>Total</strong><div>${s.total ?? 0}</div></div>
  ${isRollback ? rolledBackCard : `<div class="card"><strong style="color:var(--success)">Success</strong><div>${s.success ?? 0}</div></div>`}
  <div class="card"><strong style="color:var(--danger)">Failed</strong><div>${s.failed ?? 0}</div></div>
  <div class="card"><strong style="color:var(--muted)">Skipped</strong><div>${s.skipped ?? 0}</div></div>
</div>
<div style="overflow:auto;max-height:18rem">
<table class="table">
<thead><tr><th>Type</th><th>Object</th><th>Action</th><th>Status</th><th>Error</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;

  $("deployResult").querySelectorAll(".btn-copy-inline").forEach((btn) => {
    btn.onclick = () => copyToClipboard(btn.dataset.copy);
  });
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
    _runningTasksMap.set(data.taskId, data);
    renderTaskbar();
    startLogAutoRefresh();
  });

  es.addEventListener("taskEnd", (e) => {
    const data = JSON.parse(e.data);
    _runningTasksMap.delete(data.taskId);
    renderTaskbar();
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
    if (!key) return;
    updateTaskProgress(key, data.operation || `${data.taskType} running...`, data.percent);
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
    const map = { Success: "var(--success-ink)", Failed: "var(--danger-ink)", Running: "var(--info-ink)" };
    const color = map[s] || "#888";
    return `<span style="color:${color};font-weight:600;font-size:0.8rem">${escapeHtml(s || "")}</span>`;
  }

  function eventBadge(log) {
    const level = String(log.highestLevel || "").toUpperCase();
    const label = level || "—";
    const colors = { ERROR: "var(--danger-ink)", WARN: "var(--warning-ink)", INFO: "var(--text-2)" };
    return `<span style="color:${colors[level] || "var(--muted)"};font-weight:600;font-size:0.78rem">${escapeHtml(label)}</span>`;
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
  ${logSortHeader("taskType", "Task Type")}${logSortHeader("status", "Status")}<th>Event Level</th>${logSortHeader("connectionFlow", "Connection Flow")}${logSortHeader("objectCount", "Objects")}${logSortHeader("startedAt", "Started At")}${logSortHeader("duration", "Duration")}<th>Actions</th>
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

function setupTheme() {
  const themes = Array.isArray(globalThis.PebloyThemes) && globalThis.PebloyThemes.length
    ? globalThis.PebloyThemes
    : [];
  const themeMap = new Map(themes.map((theme) => [theme.id, theme]));
  const fallbackThemeId = themeMap.has("dark") ? "dark" : themes[0]?.id;
  const validThemes = themes.map((theme) => theme.id);
  const savedTheme = appState?.preferences?.theme || readAppPreference("theme", "dark");
  const saved = validThemes.includes(savedTheme) ? savedTheme : fallbackThemeId;

  const headerPicker = $("themePicker");
  const settingsPicker = $("themePickerInline");
  const previewPanel = $("themePreviewPanel");

  const getFavoriteThemeIds = () => {
    const savedFavorites = Array.isArray(appState?.preferences?.favoriteThemes)
      ? appState.preferences.favoriteThemes.map((value) => String(value || "").trim()).filter((value) => themeMap.has(value))
      : [];
    return savedFavorites.length ? [...new Set(savedFavorites)] : validThemes;
  };

  const renderHeaderPicker = () => {
    if (!headerPicker) return;
    const favoriteIds = getFavoriteThemeIds();
    headerPicker.innerHTML = favoriteIds.map((themeId) => {
      const theme = themeMap.get(themeId);
      if (!theme) return "";
      return `
      <div class="theme-swatch-wrap">
        <button
          type="button"
          class="theme-swatch theme-swatch--header"
          data-theme="${escapeHtml(theme.id)}"
          data-theme-title="${escapeHtml(theme.label)}"
          title="${escapeHtml(theme.label)}"
          aria-label="Switch to ${escapeHtml(theme.label)} theme"
          style="${previewStyle(theme)}"
        >
          <span class="swatch-emoji">${escapeHtml(theme.glyph || theme.emoji || theme.label.slice(0, 1))}</span>
          <span class="swatch-name">${escapeHtml(theme.label)}</span>
        </button>
      </div>`;
    }).join("");
  };

  const previewStyle = (theme) => {
    const colors = Array.isArray(theme.preview) && theme.preview.length >= 3
      ? theme.preview
      : [theme.tokens?.surface, theme.tokens?.["surface-2"], theme.tokens?.accent].filter(Boolean);
    return `--theme-preview-1:${colors[0] || "#111111"};--theme-preview-2:${colors[1] || colors[0] || "#222222"};--theme-preview-3:${colors[2] || theme.tokens?.accent || "#ff2340"};`;
  };

  renderHeaderPicker();

  if (settingsPicker) {
    settingsPicker.innerHTML = themes.map((theme) => `
      <div
        class="theme-option-card"
        data-theme-inline="${escapeHtml(theme.id)}"
        role="button"
        tabindex="0"
        aria-label="Choose ${escapeHtml(theme.label)} theme"
        style="${previewStyle(theme)}"
      >
        <button
          type="button"
          class="theme-favorite-toggle"
          data-theme-favorite="${escapeHtml(theme.id)}"
          title="Toggle ${escapeHtml(theme.label)} favorite"
          aria-label="Toggle ${escapeHtml(theme.label)} favorite"
          aria-pressed="false"
        >
          ☆
        </button>
        <span class="theme-option-preview" aria-hidden="true">
          <span class="theme-option-preview-orb"></span>
          <span class="theme-option-preview-grid"></span>
          <span class="theme-option-preview-line theme-option-preview-line--one"></span>
          <span class="theme-option-preview-line theme-option-preview-line--two"></span>
        </span>
        <span class="theme-option-copy">
          <strong>${escapeHtml(theme.glyph || "")}&nbsp;${escapeHtml(theme.label)}</strong>
          <span>${escapeHtml(theme.description || "")}</span>
        </span>
      </div>
    `).join("");
  }

  const syncFavoriteState = () => {
    const favoriteIds = new Set(getFavoriteThemeIds());
    document.querySelectorAll("[data-theme-favorite]").forEach((button) => {
      const isFavorite = favoriteIds.has(button.dataset.themeFavorite);
      button.classList.toggle("active", isFavorite);
      button.setAttribute("aria-pressed", String(isFavorite));
      button.textContent = isFavorite ? "★" : "☆";
      button.title = `${isFavorite ? "Remove" : "Add"} ${button.dataset.themeFavorite} ${isFavorite ? "from" : "to"} favorites`;
    });
  };

  function renderThemePreview(theme) {
    if (!previewPanel || !theme) return;
    previewPanel.innerHTML = `
      <div class="theme-preview-panel__header">
        <div>
          <div class="theme-preview-kicker">Current Theme</div>
          <h4>${escapeHtml(theme.glyph || "")}&nbsp;${escapeHtml(theme.label)}</h4>
        </div>
      </div>
      <p class="theme-preview-panel__copy">${escapeHtml(theme.description || "")}</p>
      <div class="theme-preview-metrics">
        <div class="theme-preview-metric"><span>Accent</span><strong>${escapeHtml(theme.tokens?.accent || "-")}</strong></div>
        <div class="theme-preview-metric"><span>Surface</span><strong>${escapeHtml(theme.tokens?.surface || "-")}</strong></div>
        <div class="theme-preview-metric"><span>Theme Sync</span><strong>${escapeHtml(theme.sync || "Local")}</strong></div>
      </div>
      <p class="theme-preview-note">Theme tokens now drive borders, hover states, progress chrome, and icon framing in addition to the base palette.</p>
    `;
  }

  function applyTheme(theme, persist = true) {
    const nextTheme = themeMap.get(theme) || themeMap.get(fallbackThemeId);
    if (!nextTheme) return;

    document.body.setAttribute("data-theme", nextTheme.id);
    document.documentElement.style.colorScheme = nextTheme.colorScheme || "dark";
    for (const [token, value] of Object.entries(nextTheme.tokens || {})) {
      document.body.style.setProperty(`--${token}`, value);
    }

    document.querySelectorAll("[data-theme]").forEach((btn) => {
      const active = btn.dataset.theme === nextTheme.id;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    document.querySelectorAll("[data-theme-inline]").forEach((btn) => {
      const active = btn.dataset.themeInline === nextTheme.id;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    renderThemePreview(nextTheme);
    syncFavoriteState();

    if (persist) scheduleAppStateSave({ preferences: { theme: nextTheme.id } }, { delay: 0 });
  }

  function setFavoriteThemes(nextFavoriteIds) {
    const normalized = [...new Set(nextFavoriteIds.filter((value) => themeMap.has(value)))];
    const safeFavorites = normalized.length ? normalized : [document.body.dataset.theme || fallbackThemeId];
    scheduleAppStateSave({ preferences: { favoriteThemes: safeFavorites } }, { delay: 0 });
    appState = mergeAppState(appState || {}, { preferences: { favoriteThemes: safeFavorites } });
    renderHeaderPicker();
    syncFavoriteState();
    bindThemeEvents();
  }

  function bindThemeEvents() {
    document.querySelectorAll("[data-theme]").forEach((btn) => {
      btn.onclick = () => applyTheme(btn.dataset.theme);
    });

    document.querySelectorAll("[data-theme-inline]").forEach((card) => {
      const activate = () => applyTheme(card.dataset.themeInline);
      card.onclick = (event) => {
        if (event.target.closest("[data-theme-favorite]")) return;
        activate();
      };
      card.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      };
    });

    document.querySelectorAll("[data-theme-favorite]").forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        const themeId = button.dataset.themeFavorite;
        const favorites = getFavoriteThemeIds();
        const exists = favorites.includes(themeId);
        const nextFavorites = exists ? favorites.filter((value) => value !== themeId) : [...favorites, themeId];
        setFavoriteThemes(nextFavorites);
      };
    });
  }

  applyTheme(saved, false);
  bindThemeEvents();
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
    };
  }

  async function loadSettings() {
    renderFolderNames(DEFAULT_FOLDER_NAMES);
    renderDeployOrder(DEFAULT_DEPLOYMENT_ORDER);
    try {
      currentSettings = normalizeCustomizeSettings(await api("/api/settings"));
      renderFolderNames(currentSettings.folderNames);
      renderDeployOrder(currentSettings.deploymentOrder);
    } catch (error) {
      currentSettings = normalizeCustomizeSettings();
      renderFolderNames(currentSettings.folderNames);
      renderDeployOrder(currentSettings.deploymentOrder);
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
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ folderNames, deploymentOrder }),
      });

      showToast("All settings saved");
    } catch (error) {
      showToast("Failed to save: " + error.message, true);
    } finally {
      restore();
    }
  };

  $("resetCustomize").onclick = async function () {
    if (!confirm("Reset all customize settings to defaults?")) return;
    const restore = setButtonLoading(this, "Resetting…");
    try {
      showToast("Resetting script settings...", false);
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ folderNames: DEFAULT_FOLDER_NAMES, deploymentOrder: DEFAULT_DEPLOYMENT_ORDER }),
      });
      await loadSettings();
      showToast("Settings reset to defaults");
    } catch (error) {
      showToast("Failed to reset: " + error.message, true);
    } finally {
      restore();
    }
  };

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

  const savedFont = appState?.preferences?.fontFamily || readAppPreference("font", "Space Grotesk");
  if (savedFont) applyFont(savedFont, false);

  const savedSize = appState?.preferences?.fontSize || Number(readAppPreference("fontSize", 14));
  if (savedSize) applyFontSize(Number(savedSize), false);
  else if (sizeLabel) sizeLabel.textContent = sizeEl ? sizeEl.value + "px" : "14px";

  if (fontEl) fontEl.onchange = () => applyFont(fontEl.value);
  if (sizeEl) sizeEl.oninput = () => applyFontSize(Number(sizeEl.value));
}

function setupProfileImportExport() {
  const exportBtn = $("exportProfiles");
  const importBtn = $("importProfilesBtn");
  const importFile = $("importProfilesFile");

  if (exportBtn) {
    exportBtn.onclick = async () => {
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
      }
    };
  }

  if (importBtn && importFile) {
    importBtn.onclick = () => importFile.click();
    importFile.onchange = async () => {
      const file = importFile.files?.[0];
      if (!file) return;
      importFile.value = "";
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
      }
    };
  }
}

function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    const sc = getShortcuts();
    const runBtnIds = { objects: "resolveAndAddObjects", diff: "runDiff", backup: "runBackup", deploy: "runDeployment" };
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
  setupObjectsTab();
  setupDiff();
  setupBackup();
  setupDeployment();
  setupCustomize();
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
