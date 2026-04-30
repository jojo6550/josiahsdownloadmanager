const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startDownload: (url) => ipcRenderer.invoke('download:start', url),
  pauseDownload: (id) => ipcRenderer.invoke('download:pause', id),
  resumeDownload: (id) => ipcRenderer.invoke('download:resume', id),
  onProgress: (callback) => ipcRenderer.on('download:progress', (_event, data) => callback(data)),
  onStatusChange: (callback) => ipcRenderer.on('download:status', (_event, data) => callback(data)),
});
