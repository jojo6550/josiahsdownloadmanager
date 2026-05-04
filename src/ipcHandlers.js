'use strict';

const { ipcMain, BrowserWindow, shell } = require('electron');
const path   = require('node:path');
const os     = require('node:os');
const queue  = require('./api/queue');
const logger = require('./logger/Logger');
const ytDlp  = require('./scraper/ytDlp');

function broadcast(channel, payload) {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  });
}

let _registered = false;
function registerIpcHandlers() {
  if (_registered) return;
  _registered = true;

  ipcMain.handle('download:start', async (_e, { url } = {}) => {
    if (typeof url !== 'string') throw new Error('url must be a string');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http/https URLs are supported');
    }
    const filename = (path.basename(parsed.pathname) || parsed.hostname || `download-${Date.now()}`).replace(/[/\\]/g, '');
    const dest = path.join(process.env.JDM_DOWNLOAD_DIR, filename);
    if (!dest.startsWith(process.env.JDM_DOWNLOAD_DIR + path.sep) && dest !== process.env.JDM_DOWNLOAD_DIR) {
      throw new Error('Resolved destination escapes download directory');
    }
    const { id } = queue.add(url, dest);
    return { id };
  });

  ipcMain.handle('download:pause',  (_e, { id }) => { queue.pause(id); });
  ipcMain.handle('download:resume', (_e, { id }) => { queue.resume(id); });
  ipcMain.handle('download:cancel', (_e, { id }) => { queue.cancel(id); });

  ipcMain.handle('scraper:probe', async (_e, { url } = {}) => {
    if (typeof url !== 'string') throw new Error('url must be a string');
    return ytDlp.probe(url);
  });

  ipcMain.handle('scraper:start', async (_e, { url, formatId } = {}) => {
    if (typeof url !== 'string' || typeof formatId !== 'string') {
      throw new Error('url and formatId must be strings');
    }
    const dir  = process.env.JDM_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'JDM');
    const dest = path.join(dir, `%(title)s.%(ext)s`);
    const { id } = queue.addYtDlp(url, formatId, dest);
    return { id };
  });
  ipcMain.handle('log:get-entries', (_e, { limit, level }) => logger.getEntries(limit, level));

  ipcMain.handle('file:open', async (_e, { dest }) => {
    if (typeof dest !== 'string') throw new Error('dest must be a string');
    if (!dest.startsWith(process.env.JDM_DOWNLOAD_DIR + path.sep)) {
      throw new Error('Path is outside download directory');
    }
    await shell.openPath(dest);
  });

  ipcMain.handle('window:minimize', (_e) => {
    BrowserWindow.fromWebContents(_e.sender)?.minimize();
  });

  ipcMain.handle('window:close', (_e) => {
    BrowserWindow.fromWebContents(_e.sender)?.close();
  });

  queue.on('job:progress', (p) => broadcast('download:progress', p));
  queue.on('job:status', ({ id, status, filename, dest, error }) => {
    broadcast('download:status', {
      id, status, filename, dest,
      error: error instanceof Error ? error.message : error,
    });
  });
  logger.on('entry',       (e) => broadcast('log:entry',         e));
}

module.exports = { registerIpcHandlers };
