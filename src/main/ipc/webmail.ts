import { app, ipcMain } from 'electron';
import type { WebmailProviderId, WebmailConnectionStatus } from '@shared/webmail';
import { WEBMAIL_PROVIDERS } from '@shared/webmail';
import { checkWebmailConnectionStatus, connectWebmailProvider, disconnectWebmail } from '../browser/webmailSession';
import { runWebmailInboxAgent } from '../agents/webmailInbox';
import { loadSettings, saveSettings } from '../settings/store';
import { getMemoryService } from '../memory/instance';

export function registerWebmailIpc(): void {
  ipcMain.handle('webmail.listProviders', () => WEBMAIL_PROVIDERS);

  ipcMain.handle('webmail.connect', async (_event, providerId: WebmailProviderId) => {
    await connectWebmailProvider(providerId);
  });

  ipcMain.handle('webmail.checkStatus', async (_event, providerId: WebmailProviderId): Promise<WebmailConnectionStatus> => {
    const connected = await checkWebmailConnectionStatus(providerId);
    if (connected) {
      const userDataDir = app.getPath('userData');
      const settings = await loadSettings(userDataDir);
      await saveSettings(userDataDir, { ...settings, webmail: { provider: providerId } });
    }
    return { connected, provider: connected ? providerId : null };
  });

  ipcMain.handle('webmail.getStatus', async (): Promise<WebmailConnectionStatus> => {
    const settings = await loadSettings(app.getPath('userData'));
    return { connected: settings.webmail.provider !== null, provider: settings.webmail.provider };
  });

  ipcMain.handle('webmail.disconnect', async () => {
    await disconnectWebmail();
    const userDataDir = app.getPath('userData');
    const settings = await loadSettings(userDataDir);
    await saveSettings(userDataDir, { ...settings, webmail: { provider: null } });
  });

  ipcMain.handle('webmail.runInboxNow', async () => {
    const userDataDir = app.getPath('userData');
    const settings = await loadSettings(userDataDir);
    if (!settings.webmail.provider) throw new Error('No email account connected yet.');
    const memory = getMemoryService(settings.ollama.baseUrl);
    return runWebmailInboxAgent({ provider: settings.webmail.provider, memory });
  });
}
