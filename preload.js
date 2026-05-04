'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startDownload:  (url)          => ipcRenderer.invoke('download:start',  { url }),
  pauseDownload:  (id)           => ipcRenderer.invoke('download:pause',  { id }),
  resumeDownload: (id)           => ipcRenderer.invoke('download:resume', { id }),
  cancelDownload: (id)           => ipcRenderer.invoke('download:cancel', { id }),
  getLogEntries:  (limit, level) => ipcRenderer.invoke('log:get-entries', { limit, level }),
  openFile:       (dest)         => ipcRenderer.invoke('file:open',       { dest }),
  minimizeWindow: ()             => ipcRenderer.invoke('window:minimize'),
  closeWindow:    ()             => ipcRenderer.invoke('window:close'),

  onProgress: (cb) => {
    const fn = (_, d) => cb(d);
    ipcRenderer.on('download:progress', fn);
    return () => ipcRenderer.removeListener('download:progress', fn);
  },
  onStatusChange: (cb) => {
    const fn = (_, d) => cb(d);
    ipcRenderer.on('download:status', fn);
    return () => ipcRenderer.removeListener('download:status', fn);
  },
  onLogEntry: (cb) => {
    const fn = (_, d) => cb(d);
    ipcRenderer.on('log:entry', fn);
    return () => ipcRenderer.removeListener('log:entry', fn);
  },
});
