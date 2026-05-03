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

let _registered = false;
function registerIpcHandlers() {
  if (_registered) return;
  _registered = true;
  // Invoke handlers (renderer → main, returns value)
  ipcMain.handle('download:start', async (event, { url } = {}) => {
    if (typeof url !== 'string') throw new Error('url must be a string');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http/https URLs are supported');
    }
    let filename = path.basename(parsed.pathname).replace(/[/\\]/g, '') || `download-${Date.now()}`;
    const dest = path.join(process.env.JDM_DOWNLOAD_DIR, filename);
    if (!dest.startsWith(process.env.JDM_DOWNLOAD_DIR + path.sep) && dest !== process.env.JDM_DOWNLOAD_DIR) {
      throw new Error('Resolved destination escapes download directory');
    }
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
