import { app, ipcMain } from 'electron';
import type { Settings } from '@shared/settings';
import { SettingsSchema } from '../settings/schema';
import { loadSettings, saveSettings } from '../settings/store';

export function registerSettingsIpc(): void {
  ipcMain.handle('settings.get', async () => loadSettings(app.getPath('userData')));

  ipcMain.handle('settings.update', async (_event, partial: Partial<Settings>) => {
    const userDataDir = app.getPath('userData');
    const current = await loadSettings(userDataDir);
    const merged = SettingsSchema.parse({ ...current, ...partial });
    await saveSettings(userDataDir, merged);
    return merged;
  });
}
