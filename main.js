const { app, BrowserWindow } = require('electron');
const path = require('path');

if (!process.env.JDM_DOWNLOAD_DIR) {
  process.env.JDM_DOWNLOAD_DIR = path.join(app.getPath('downloads'), 'JDM');
}

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
