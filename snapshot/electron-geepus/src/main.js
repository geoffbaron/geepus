'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');

// Prevent unhandled errors from crashing the process.
process.on('uncaughtException', (err) => {
  console.error('[Geepus] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Geepus] Unhandled rejection:', reason);
});

// Wire lazy dependency injections.
const providers = require('./providers');
const settings = require('./settings');
const memory = require('./memory');
const workspace = require('./workspace');

providers.setWriteSettings(settings.writeSettings);
memory.setCollectKnownPaths(workspace.collectKnownPathsForObjective);

// Register all IPC handlers.
const { registerIpcHandlers } = require('./ipc-handlers');
registerIpcHandlers();

const { extensionBridge } = require('./extension-bridge');

// Start the proactive scheduler.
const { startScheduler, stopScheduler } = require('./scheduler');
const { initTriggers, stopAllWatchers } = require('./triggers');
const { stopOllamaServe } = require('./ollama-manager');

// Block macOS from opening files dragged onto the dock icon or app window.
app.on('open-file', (event) => {
  event.preventDefault();
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 640,
    title: 'Geepus',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // The only file:// URL this window is ever allowed to navigate to.
  const appUrl = require('url').pathToFileURL(path.join(__dirname, 'index.html')).href;
  // All app assets live in the same directory, so allow anything under src/.
  const appDir = require('url').pathToFileURL(path.join(__dirname, '')).href;
  const isTrustedAppUrl = (url) => typeof url === 'string' && url.startsWith(appDir);

  // Block all navigation except back to our own index.html.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== appUrl) {
      event.preventDefault();
    }
  });

  // Intercept at the session/network layer (catches loadURL() too).
  // No URL filter — the filter syntax for file:// is unreliable; we check manually.
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const { url } = details;
    if (url.startsWith('file://') && !url.startsWith(appDir)) {
      // Dropped file or external file:// URL — block it.
      callback({ cancel: true });
    } else {
      callback({});
    }
  });

  // Allow microphone access for our local app pages so browser speech APIs can run.
  const TRUSTED_MEDIA_PERMISSIONS = new Set(['media', 'microphone', 'audioCapture']);
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestUrl = String((details && details.requestingUrl) || webContents?.getURL?.() || '');
    const trusted = isTrustedAppUrl(requestUrl);
    callback(trusted && TRUSTED_MEDIA_PERMISSIONS.has(String(permission || '')));
  });

  win.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const origin = String(requestingOrigin || webContents?.getURL?.() || '');
    const trusted = isTrustedAppUrl(origin);
    return trusted && TRUSTED_MEDIA_PERMISSIONS.has(String(permission || ''));
  });

  // Block new windows entirely.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Last-resort safety net: if the page somehow navigates away, reload the app.
  win.webContents.on('did-navigate', (_event, url) => {
    if (url !== appUrl) {
      win.loadFile(path.join(__dirname, 'index.html'));
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(async () => {
  createWindow();
  await initTriggers();
  await startScheduler();
  extensionBridge.start();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  extensionBridge.stop();
  stopAllWatchers();
  stopScheduler();
  stopOllamaServe();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
