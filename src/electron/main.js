"use strict";

const { app, BrowserWindow, shell, Menu, dialog, ipcMain } = require("electron");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { fork } = require("child_process");
const http = require("http");
const https = require("https");
const os = require("os");

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
// Updater
// ---------------------------------------------------------------------------

const GITHUB_OWNER = "HarshaDidSmtg";
const GITHUB_REPO = "Pebloy";

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map(Number);
  const pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": `${GITHUB_REPO}/${app.getVersion()}` } }, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error("Invalid JSON from GitHub API")); }
      });
    }).on("error", reject);
  });
}

ipcMain.handle("app:getVersion", () => app.getVersion());

ipcMain.handle("updater:check", async () => {
  const current = app.getVersion();
  const release = await httpsGetJson(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
  );
  if (release.message === "Not Found") throw new Error("No releases published yet.");
  const latest = String(release.tag_name || "").replace(/^v/, "");
  const hasUpdate = compareVersions(latest, current) > 0;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const installer = assets.find((a) => /\.exe$/i.test(a.name) && !/portable/i.test(a.name))
    || assets.find((a) => /\.exe$/i.test(a.name));
  return {
    current,
    latest,
    hasUpdate,
    downloadUrl: installer ? installer.browser_download_url : null,
    releaseName: release.name || `v${latest}`,
    releaseNotes: (release.body || "").slice(0, 500),
    releaseUrl: release.html_url || "",
  };
});

ipcMain.handle("updater:download-and-install", async (event, downloadUrl) => {
  const fileName = downloadUrl.split("/").pop() || "PebloySetup.exe";
  const destPath = path.join(os.tmpdir(), fileName);

  await new Promise((resolve, reject) => {
    const file = fsSync.createWriteStream(destPath);

    function fetch(url, hops = 0) {
      if (hops > 6) return reject(new Error("Too many redirects"));
      const mod = url.startsWith("https") ? https : http;
      mod.get(url, { headers: { "User-Agent": `${GITHUB_REPO}/${app.getVersion()}` } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetch(res.headers.location, hops + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers["content-length"] || "0", 10);
        let received = 0;
        res.on("data", (chunk) => {
          received += chunk.length;
          if (total > 0) event.sender.send("updater:progress", Math.round((received / total) * 100));
        });
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
        file.on("error", reject);
        res.on("error", reject);
      }).on("error", reject);
    }

    fetch(downloadUrl);
  });

  shell.openPath(destPath);
  setTimeout(() => app.quit(), 1500);
  return { ok: true };
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
      const match = text.match(/listening on http:\/\/([^\s/:]+):(\d+)/i);
      if (match) {
        clearTimeout(startTimeout);
        resolve({
          host: match[1],
          port: Number.parseInt(match[2], 10),
        });
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

  mainWindow.loadURL(`http://${port.host}:${port.port}`);

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
    const serverAddress = await startExpressServer();
    createWindow(serverAddress);
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
