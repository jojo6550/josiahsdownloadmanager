'use strict';

const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

if (!process.env.JDM_DOWNLOAD_DIR) {
  process.env.JDM_DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'JDM');
}
fs.mkdirSync(process.env.JDM_DOWNLOAD_DIR, { recursive: true });

const { registerIpcHandlers } = require('./src/ipcHandlers');
const { startServer }         = require('./src/api/server');

const WIN_W = 360;
const WIN_H = 560;

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    width:       WIN_W,
    height:      WIN_H,
    x:           sw - WIN_W - 20,
    y:           sh - WIN_H - 20,
    frame:       false,
    transparent: true,
    alwaysOnTop: true,
    resizable:   false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  win.loadFile('renderer/index.html');
}

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch {
    // Daemon already running (another instance) — GUI connects as client only
  }

  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
