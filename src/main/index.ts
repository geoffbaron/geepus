import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { is } from './util/env';
import { registerIpcHandlers } from './ipc';
import { bootstrapBundledModel } from './models/bootstrap';

process.on('uncaughtException', (err) => {
  console.error('[Geepus] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Geepus] Unhandled rejection:', reason);
});

// Dragging a file onto the dock icon must never open it as a window.
app.on('open-file', (event) => {
  event.preventDefault();
});

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 640,
    title: 'Geepus',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  const appDirUrl = pathToFileURL(join(__dirname, '../renderer/')).href;
  const isTrustedAppUrl = (url: string): boolean =>
    typeof url === 'string' && (url.startsWith(appDirUrl) || url.startsWith('devtools://'));

  // Block all navigation except within the app's own bundled assets.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault();
  });

  // Catches loadURL()/dropped-file navigation too — file:// filter syntax is unreliable,
  // so this checks the prefix manually (ported from the prototype's main.js).
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith('file://') && !isTrustedAppUrl(details.url)) {
      callback({ cancel: true });
    } else {
      callback({});
    }
  });

  const TRUSTED_MEDIA_PERMISSIONS = new Set(['media', 'microphone', 'audioCapture']);
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestUrl = String(details?.requestingUrl ?? webContents?.getURL?.() ?? '');
    callback(isTrustedAppUrl(requestUrl) && TRUSTED_MEDIA_PERMISSIONS.has(permission));
  });
  win.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const origin = String(requestingOrigin || webContents?.getURL?.() || '');
    return isTrustedAppUrl(origin) && TRUSTED_MEDIA_PERMISSIONS.has(permission);
  });

  // No child windows, ever — browser tasks run through the Playwright/extension backends,
  // never by letting the renderer pop a real BrowserWindow.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

app.whenReady().then(() => {
  registerIpcHandlers();
  const win = createWindow();

  // Runs in the background — the window is usable immediately, and providers
  // just wait on getBundledModelPath() resolving (PLAN.md §6.5).
  void bootstrapBundledModel((downloadedBytes, totalBytes) => {
    win.webContents.send('models.bundledDownloadProgress', { downloadedBytes, totalBytes });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
