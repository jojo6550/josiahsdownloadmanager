const { ipcMain, BrowserWindow } = require('electron');
const downloader = require('./downloader');

function broadcast(channel, data) {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data);
  });
}

function registerIpcHandlers() {
  downloader.on('progress', (data) => broadcast('download:progress', data));
  downloader.on('status', (data) => broadcast('download:status', data));

  ipcMain.handle('download:start', (_event, url) => {
    const id = Date.now().toString();
    return downloader.startDownload(url, id);
  });

  ipcMain.handle('download:pause', (_event, id) => {
    downloader.pauseDownload(id);
  });

  ipcMain.handle('download:resume', (_event, id) => {
    downloader.resumeDownload(id);
  });
}

module.exports = { registerIpcHandlers };
