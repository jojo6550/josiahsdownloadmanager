'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startDownload: (url) => ipcRenderer.invoke('download:start', { url }),
  pauseDownload: (id) => ipcRenderer.invoke('download:pause', { id }),
  resumeDownload: (id) => ipcRenderer.invoke('download:resume', { id }),
  cancelDownload: (id) => ipcRenderer.invoke('download:cancel', { id }),
  getLogEntries: (limit, level) => ipcRenderer.invoke('log:get-entries', { limit, level }),
  onProgress: (cb) => ipcRenderer.on('download:progress', (e, data) => cb(data)),
  onStatusChange: (cb) => ipcRenderer.on('download:status', (e, data) => cb(data)),
  onLogEntry: (cb) => ipcRenderer.on('log:entry', (e, data) => cb(data)),
});
