"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  pickFolder: (options = {}) => ipcRenderer.invoke("system:pickFolder", options),
  pickFile: (options = {}) => ipcRenderer.invoke("system:pickFile", options),
});