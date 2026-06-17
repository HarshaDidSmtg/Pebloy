"use strict";

const { app, BrowserWindow, shell, Menu, dialog, ipcMain } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const { fork } = require("child_process");
const http = require("http");

const IS_DEV = process.argv.includes("--dev");
const SERVER_SCRIPT = path.join(__dirname, "..", "server.js");
const APP_ROOT = path.join(__dirname, "..", "..");
const LOGO_PATH = path.join(APP_ROOT, "public", "logo.png");

let mainWindow = null;
let serverProcess = null;

ipcMain.handle("system:pickFolder", async (_event, options = {}) => {
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

ipcMain.handle("system:pickFile", async (_event, options = {}) => {
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
  const content = await fs.readFile(filePath, "utf8");
  return {
    filePath,
    fileName: path.basename(filePath),
    content,
  };
});

// ---------------------------------------------------------------------------
// Express server lifecycle
// ---------------------------------------------------------------------------

function startExpressServer() {
  return new Promise((resolve, reject) => {
    serverProcess = fork(SERVER_SCRIPT, [], {
      cwd: APP_ROOT,
      env: { ...process.env, ELECTRON: "1" },
      silent: true,
    });

    const startTimeout = setTimeout(() => {
      reject(new Error("Pebloy server failed to start within 30 seconds."));
    }, 30000);

    serverProcess.stdout.on("data", (chunk) => {
      const text = String(chunk);
      const match = text.match(/listening on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(startTimeout);
        resolve(Number.parseInt(match[1], 10));
      }
    });

    serverProcess.stderr.on("data", (chunk) => {
      if (IS_DEV) console.error("[Server]", String(chunk).trim());
    });

    serverProcess.on("error", (err) => {
      clearTimeout(startTimeout);
      reject(err);
    });

    serverProcess.on("exit", (code) => {
      if (code && code !== 0) {
        console.error(`[Server] exited unexpectedly with code ${code}`);
      }
    });
  });
}

function stopExpressServer() {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
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

  // Remove the default application menu
  Menu.setApplicationMenu(null);

  mainWindow.loadURL(`http://localhost:${port}`);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools();
  });

  // Open any <a target="_blank"> links in the OS default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  try {
    const port = await startExpressServer();
    createWindow(port);
  } catch (err) {
    console.error("[Electron] Failed to start:", err.message);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  stopExpressServer();
  app.quit();
});

app.on("before-quit", () => {
  stopExpressServer();
});

// Safety net: kill server on process exit
process.on("exit", () => stopExpressServer());
