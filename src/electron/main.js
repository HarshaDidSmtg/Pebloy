"use strict";

const { app, BrowserWindow, shell, Menu, dialog, ipcMain } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const { fork } = require("child_process");
const { createHash, randomUUID } = require("crypto");
const { createFormatterFileAuthority, isFormatterSavePath } = require("../services/formatterAccessService");
const { checkForUpdates, downloadAndLaunchInstaller } = require("../services/updaterService");
const { extractStartupFailureReason } = require("../services/startupFailure");

const IS_DEV = process.argv.includes("--dev");
const SERVER_SCRIPT = path.join(__dirname, "..", "server.js");
const APP_ROOT = path.join(__dirname, "..", "..");
const SERVER_CWD = app.isPackaged ? path.dirname(process.execPath) : APP_ROOT;
const LOGO_PATH = path.join(APP_ROOT, "public", "logo.png");
const WINDOWS_APP_ID = "com.pebloy.app";
if (process.platform === "win32") app.setAppUserModelId(WINDOWS_APP_ID);
const runtimeOverride = process.env.PEBLOY_RUNTIME_ROOT;
if (runtimeOverride) {
  if (!path.isAbsolute(runtimeOverride)) throw new Error("PEBLOY_RUNTIME_ROOT must be an absolute path.");
  app.setPath("userData", runtimeOverride);
}

let mainWindow = null;
let serverProcess = null;
let appUrl = null;
let pendingUpdate = null;
let allowClose = false;
const fileAuthority = createFormatterFileAuthority();
const fileVersions = new Map();
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

function handleTrusted(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        new URL(event.senderFrame.url).origin !== appUrl) {
      throw new Error("Untrusted desktop request.");
    }
    return handler(event, ...args);
  });
}

async function authorizeFile(filePath) {
  const authorization = fileAuthority.authorize(filePath);
  if (authorization) fileVersions.set(authorization.fileToken, createHash("sha256").update(await fs.readFile(filePath)).digest("hex"));
  return authorization;
}

async function writeFormatterFile(filePath, content) {
  if (!isFormatterSavePath(filePath)) throw new Error("Only absolute .sql and .txt paths can be saved.");
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > 20 * 1024 * 1024) throw new Error("SQL text must be under 20 MB.");
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

handleTrusted("system:pickFolder", async (_event, options = {}) => {
  const browserWindow = BrowserWindow.getFocusedWindow() || mainWindow;
  const title = String(options.description || "Select a folder");
  const defaultPath = String(options.initialPath || "").trim() || undefined;

  const result = await dialog.showOpenDialog(browserWindow || undefined, {
    title,
    defaultPath,
    properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
  });

  if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

handleTrusted("system:pickFile", async (_event, options = {}) => {
  const browserWindow = BrowserWindow.getFocusedWindow() || mainWindow;
  const title = String(options.description || "Select a file");
  const defaultPath = String(options.initialPath || "").trim() || undefined;
  const filters = Array.isArray(options.filters) && options.filters.length
    ? options.filters
    : [{ name: "Text Files", extensions: ["txt", "csv"] }];

  const result = await dialog.showOpenDialog(browserWindow || undefined, {
    title,
    defaultPath,
    filters,
    properties: ["openFile", "dontAddToRecent"],
  });

  if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  if ((await fs.stat(filePath)).size > 20 * 1024 * 1024) throw new Error("The selected file exceeds 20 MB.");
  const content = await fs.readFile(filePath, "utf8");
  return {
    filePath,
    fileName: path.basename(filePath),
    content,
    ...(options.allowOverwrite ? await authorizeFile(filePath) : {}),
  };
});

handleTrusted("formatter:saveAs", async (_event, options = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save SQL file", defaultPath: String(options.defaultPath || "formatted.sql"),
    filters: [{ name: "SQL and text", extensions: ["sql", "txt"] }],
  });
  if (result.canceled || !result.filePath) return null;
  await writeFormatterFile(result.filePath, options.content);
  return authorizeFile(result.filePath);
});

handleTrusted("formatter:overwrite", async (_event, options = {}) => {
  const file = fileAuthority.resolve(options.fileToken);
  if (!file) throw new Error("File authorization expired. Open the file again.");
  const currentHash = createHash("sha256").update(await fs.readFile(file.filePath)).digest("hex");
  if (currentHash !== fileVersions.get(options.fileToken)) throw new Error("The file changed outside Pebloy. Use Save As or reopen it before overwriting.");
  await writeFormatterFile(file.filePath, options.content);
  fileVersions.set(options.fileToken, createHash("sha256").update(options.content).digest("hex"));
  return { ...file, fileToken: options.fileToken };
});

// ---------------------------------------------------------------------------
// Updater
// ---------------------------------------------------------------------------

const GITHUB_OWNER = "HarshaDidSmtg";
const GITHUB_REPO = "Pebloy";

handleTrusted("app:getVersion", () => app.getVersion());

handleTrusted("updater:check", async () => {
  pendingUpdate = await checkForUpdates({
    currentVersion: app.getVersion(),
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
  });
  return pendingUpdate;
});

handleTrusted("updater:download-and-install", async (event, downloadUrl) => {
  if (!pendingUpdate?.canInstall || downloadUrl !== pendingUpdate.downloadUrl) throw new Error("Check for a verified release before installing.");
  const status = await fetch(`${appUrl}/api/status`).then((response) => response.json());
  if (status.runningTasks) throw new Error("Wait for running tasks to finish before updating.");
  return downloadAndLaunchInstaller({
    downloadUrl: pendingUpdate.downloadUrl,
    digest: pendingUpdate.digest,
    shell,
    quit: () => app.quit(),
    currentVersion: app.getVersion(),
    onProgress: (percent) => event.sender.send("updater:progress", percent),
  });
});

// ---------------------------------------------------------------------------
// Express server lifecycle
// ---------------------------------------------------------------------------

function startExpressServer() {
  return new Promise((resolve, reject) => {
    const runtimeRoot = runtimeOverride || (app.isPackaged ? app.getPath("userData") : APP_ROOT);
    const artifactDir = path.join(runtimeRoot, "artifacts");
    serverProcess = fork(SERVER_SCRIPT, [], {
      cwd: SERVER_CWD,
      env: {
        ...process.env,
        ELECTRON: "1",
        PEBLOY_SCHEDULE_EXECUTABLE: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
        PEBLOY_SCHEDULE_ARGUMENTS: app.isPackaged ? "--scheduled" : `"${APP_ROOT}" --scheduled`,
        DATA_DIR: path.join(runtimeRoot, "data"),
        ARTIFACTS_DIR: artifactDir,
        EXPORTS_DIR: path.join(artifactDir, "exports"),
        LOGS_DIR: path.join(artifactDir, "logs"),
        SCRIPTS_DIR: path.join(artifactDir, "scripts"),
        REPORTS_DIR: path.join(artifactDir, "reports"),
        TEMP_DIR: path.join(artifactDir, "temp"),
        PS_MODULES_DIR: path.join(app.isPackaged ? process.resourcesPath : runtimeRoot, "vendor", "ps-modules"),
        ...(app.isPackaged ? { PEBLOY_RESOURCES_PATH: process.resourcesPath } : {}),
      },
      silent: true,
    });

    const startTimeout = setTimeout(() => {
      stopExpressServer();
      reject(new Error("Pebloy server failed to start within 30 seconds."));
    }, 30000);

    let startupOutput = "";
    let startupErrors = "";
    serverProcess.stdout.on("data", (chunk) => {
      startupOutput = (startupOutput + String(chunk)).slice(-8192);
      const match = startupOutput.match(/listening on http:\/\/([^\s/:]+):(\d+)/i);
      if (match) {
        clearTimeout(startTimeout);
        resolve({
          host: match[1],
          port: Number.parseInt(match[2], 10),
        });
      }
    });

    serverProcess.stderr.on("data", (chunk) => {
      startupErrors = (startupErrors + String(chunk)).slice(-8192);
      if (IS_DEV) console.error("[Server]", String(chunk).trim());
    });

    serverProcess.on("error", (err) => {
      clearTimeout(startTimeout);
      reject(err);
    });

    serverProcess.on("exit", (code) => {
      clearTimeout(startTimeout);
      const reason = extractStartupFailureReason(startupErrors);
      reject(new Error(reason || `Pebloy server exited before startup completed (code ${code}).`));
      if (code && code !== 0) {
        console.error(`[Server] exited unexpectedly with code ${code}`);
      }
    });
  });
}

function stopExpressServer() {
  if (serverProcess) {
    if (serverProcess.connected) serverProcess.send("shutdown", (error) => { if (error) console.error(`Server shutdown request failed: ${error.message}`); });
    else serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
}

// ---------------------------------------------------------------------------
// Browser window
// ---------------------------------------------------------------------------

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "Pebloy",
    icon: LOGO_PATH,
    backgroundColor: "#f4f4f4",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
    },
    show: false,
  });

  if (process.platform === "win32") {
    mainWindow.setAppDetails({
      appId: WINDOWS_APP_ID,
      appIconPath: app.isPackaged ? process.execPath : path.join(APP_ROOT, "build", "icon.ico"),
      appIconIndex: 0,
      relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${APP_ROOT}"`,
      relaunchDisplayName: "Pebloy",
    });
  }

  // Remove the default application menu
  Menu.setApplicationMenu(null);

  appUrl = `http://${port.host}:${port.port}`;
  mainWindow.loadURL(appUrl);
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== appUrl) event.preventDefault();
  });
  mainWindow.webContents.on("will-prevent-unload", (event) => {
    if (allowClose) {
      event.preventDefault();
      return;
    }
    const response = dialog.showMessageBoxSync(mainWindow, { type: "warning", buttons: ["Keep Editing", "Discard Changes"], defaultId: 0, cancelId: 0, message: "Discard unsaved SQL changes?" });
    if (response === 1) event.preventDefault();
    else allowClose = false;
  });
  mainWindow.on("close", async (event) => {
    if (allowClose) return;
    event.preventDefault();
    try {
      const status = await fetch(`${appUrl}/api/status`, { signal: AbortSignal.timeout(3000) }).then((response) => response.json());
      if (status.runningTasks) {
        await dialog.showMessageBox(mainWindow, { type: "warning", message: "A database workflow is running. Wait for it to finish before closing Pebloy." });
        return;
      }
    } catch (_error) {
      if (serverProcess && serverProcess.exitCode === null) {
        await dialog.showMessageBox(mainWindow, { type: "warning", message: "Cannot verify task status. Keep Pebloy open until the backend responds." });
        return;
      }
    }
    allowClose = true;
    mainWindow.close();
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools();
  });

  // Open any <a target="_blank"> links in the OS default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (["http:", "https:"].includes(new URL(url).protocol)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

if (hasInstanceLock) app.whenReady().then(async () => {
  try {
    const serverAddress = await startExpressServer();
    createWindow(serverAddress);
  } catch (err) {
    console.error("[Electron] Failed to start:", err.message);
    stopExpressServer();
    dialog.showErrorBox("Pebloy could not start", err.message);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  stopExpressServer();
  app.quit();
});

app.on("second-instance", () => { mainWindow?.show(); mainWindow?.focus(); });

app.on("before-quit", (event) => {
  if (mainWindow && !allowClose) {
    event.preventDefault();
    mainWindow.close();
    return;
  }
  stopExpressServer();
});

// Safety net: kill server on process exit
process.on("exit", () => stopExpressServer());
