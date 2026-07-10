import { ipcMain, app } from 'electron';

export function registerAppIpc(): void {
  ipcMain.handle('app.getVersion', () => app.getVersion());
}
