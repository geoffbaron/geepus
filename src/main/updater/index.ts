import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '@shared/update';

/**
 * Wraps electron-updater for GitHub-Releases auto-update with differential (blockmap)
 * downloads — a version bump fetches only the changed bytes, not the whole app.
 *
 * Deliberately silent about failure: a friend on a plane, an unsigned build, a
 * still-private repo, or simply "you're already on the latest" must never surface an
 * alarming banner. The renderer only reacts to 'downloading'/'ready'; every other state
 * (including 'error') is invisible unless the user opens Settings → Advanced.
 */

let lastStatus: UpdateStatus = { state: 'idle' };

export function getUpdateStatus(): UpdateStatus {
  return lastStatus;
}

function broadcast(status: UpdateStatus): void {
  lastStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('updates.status', status);
  }
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export function initUpdater(): void {
  // Only a packaged app has an update feed to check. In dev/unpackaged, electron-updater
  // throws ("dev-app-update.yml not found") — so no-op rather than spam the console.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true; // grab the delta in the background the moment one exists
  autoUpdater.autoInstallOnAppQuit = true; // fallback: apply on next quit if the user ignores the banner

  autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => broadcast({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => broadcast({ state: 'idle' }));
  autoUpdater.on('download-progress', (p) => broadcast({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => broadcast({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => broadcast({ state: 'error', message: err.message }));

  void checkForUpdates();
  setInterval(() => void checkForUpdates(), SIX_HOURS_MS);
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // Offline, no release yet, private repo, unsigned — all land here and stay quiet.
    broadcast({ state: 'error', message: (err as Error).message });
  }
}

/** Quit and swap in the already-downloaded update. Only meaningful after 'ready'. */
export function installUpdateNow(): void {
  if (!app.isPackaged) return;
  autoUpdater.quitAndInstall();
}
