'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Set download dir BEFORE requiring ipcHandlers (Logger reads it at first write)
if (!process.env.JDM_DOWNLOAD_DIR) {
  process.env.JDM_DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'JDM');
}

// Ensure the downloads directory exists
fs.mkdirSync(process.env.JDM_DOWNLOAD_DIR, { recursive: true });

const { registerIpcHandlers } = require('./src/ipcHandlers');

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 650,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('renderer/index.html');
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
