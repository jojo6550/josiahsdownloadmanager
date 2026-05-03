'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startDownload: (url) => ipcRenderer.invoke('download:start', { url }),
  pauseDownload: (id) => ipcRenderer.invoke('download:pause', { id }),
  resumeDownload: (id) => ipcRenderer.invoke('download:resume', { id }),
  cancelDownload: (id) => ipcRenderer.invoke('download:cancel', { id }),
  getLogEntries: (limit, level) => ipcRenderer.invoke('log:get-entries', { limit, level }),
  onProgress: (cb) => {
    const wrapped = (e, data) => cb(data);
    ipcRenderer.on('download:progress', wrapped);
    return () => ipcRenderer.removeListener('download:progress', wrapped);
  },
  onStatusChange: (cb) => {
    const wrapped = (e, data) => cb(data);
    ipcRenderer.on('download:status', wrapped);
    return () => ipcRenderer.removeListener('download:status', wrapped);
  },
  onLogEntry: (cb) => {
    const wrapped = (e, data) => cb(data);
    ipcRenderer.on('log:entry', wrapped);
    return () => ipcRenderer.removeListener('log:entry', wrapped);
  },
});
