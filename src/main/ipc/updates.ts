import { ipcMain } from 'electron';
import { checkForUpdates, getUpdateStatus, installUpdateNow } from '../updater';

export function registerUpdatesIpc(): void {
  ipcMain.handle('updates.getStatus', () => getUpdateStatus());
  ipcMain.handle('updates.check', () => checkForUpdates());
  ipcMain.handle('updates.installNow', () => {
    installUpdateNow();
  });
}
