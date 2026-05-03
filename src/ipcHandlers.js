'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const path = require('node:path');
const DownloadQueue = require('./engine/DownloadQueue');
const logger = require('./logger/Logger');

const queue = new DownloadQueue();

function broadcast(channel, payload) {
  BrowserWindow.getAllWindows().forEach(w => {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  });
}

function registerIpcHandlers() {
  // Invoke handlers (renderer → main, returns value)
  ipcMain.handle('download:start', async (event, { url }) => {
    let filename = path.basename(new URL(url).pathname);
    if (!filename || filename === '/') {
      filename = `download-${Date.now()}`;
    }
    const dest = path.join(process.env.JDM_DOWNLOAD_DIR, filename);
    const { id } = queue.add(url, dest);
    return { id };
  });

  ipcMain.handle('download:pause', (event, { id }) => { queue.pause(id); });
  ipcMain.handle('download:resume', (event, { id }) => { queue.resume(id); });
  ipcMain.handle('download:cancel', (event, { id }) => { queue.cancel(id); });
  ipcMain.handle('log:get-entries', (event, { limit, level }) => logger.getEntries(limit, level));

  // Forward queue events → renderer push
  queue.on('job:progress', payload => broadcast('download:progress', payload));
  queue.on('job:status', payload => broadcast('download:status', payload));

  // Forward logger entries → renderer push
  logger.on('entry', entry => broadcast('log:entry', entry));
}

module.exports = { registerIpcHandlers };
