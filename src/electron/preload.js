"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  pickFolder: (options = {}) => ipcRenderer.invoke("system:pickFolder", options),
  pickFile: (options = {}) => ipcRenderer.invoke("system:pickFile", options),
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  checkForUpdates: () => ipcRenderer.invoke("updater:check"),
  downloadAndInstall: (url) => ipcRenderer.invoke("updater:download-and-install", url),
  onUpdateProgress: (cb) => {
    const handler = (_event, pct) => cb(pct);
    ipcRenderer.on("updater:progress", handler);
    return () => ipcRenderer.removeListener("updater:progress", handler);
  },
});