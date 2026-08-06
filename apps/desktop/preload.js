"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getStatus: () => ipcRenderer.invoke("desktop:status"),
  startAll: () => ipcRenderer.invoke("desktop:start"),
  stopAll: () => ipcRenderer.invoke("desktop:stop"),
  openLogs: () => ipcRenderer.invoke("desktop:open-logs"),
  openExternalAdmin: () => ipcRenderer.invoke("desktop:open-admin"),
  reloadAdmin: () => ipcRenderer.invoke("desktop:reload-admin"),
  pickPortable: () => ipcRenderer.invoke("desktop:pick-portable"),
  getPrefs: () => ipcRenderer.invoke("desktop:get-prefs"),
  setPrefs: (patch) => ipcRenderer.invoke("desktop:set-prefs", patch),
  onStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("desktop:status-push", handler);
    return () => ipcRenderer.removeListener("desktop:status-push", handler);
  },
  onLog: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("desktop:log", handler);
    return () => ipcRenderer.removeListener("desktop:log", handler);
  },
  onLogClear: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("desktop:log-clear", handler);
    return () => ipcRenderer.removeListener("desktop:log-clear", handler);
  },
  onFocusAdmin: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("desktop:focus-admin", handler);
    return () => ipcRenderer.removeListener("desktop:focus-admin", handler);
  },
  onReloadAdmin: (cb) => {
    const handler = (_e, url) => cb(url);
    ipcRenderer.on("desktop:reload-admin", handler);
    return () => ipcRenderer.removeListener("desktop:reload-admin", handler);
  },
});
