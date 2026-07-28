"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getStatus: () => ipcRenderer.invoke("desktop:status"),
  startAll: () => ipcRenderer.invoke("desktop:start"),
  stopAll: () => ipcRenderer.invoke("desktop:stop"),
  openLogs: () => ipcRenderer.invoke("desktop:open-logs"),
  openExternalAdmin: () => ipcRenderer.invoke("desktop:open-admin"),
  onStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("desktop:status-push", handler);
    return () => ipcRenderer.removeListener("desktop:status-push", handler);
  },
});
