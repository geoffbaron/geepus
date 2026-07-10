import { app, ipcMain } from 'electron';
import type { ChatRequest } from '@shared/model';
import { getBundledModelPath } from '../models/bootstrap';
import { getProviderStatuses, resolveActiveProvider } from '../models/service';
import { loadSecrets, loadSettings } from '../settings/store';

export function registerModelsIpc(): void {
  ipcMain.handle('models.listProviders', async () => {
    const userDataDir = app.getPath('userData');
    const [settings, secrets] = await Promise.all([loadSettings(userDataDir), loadSecrets(userDataDir)]);
    return getProviderStatuses({ settings, secrets, bundledModelPath: getBundledModelPath() });
  });

  ipcMain.handle('models.chat', async (event, requestId: string, request: ChatRequest) => {
    const channel = `models.chatChunk:${requestId}`;
    const userDataDir = app.getPath('userData');
    try {
      const [settings, secrets] = await Promise.all([loadSettings(userDataDir), loadSecrets(userDataDir)]);
      const provider = resolveActiveProvider({ settings, secrets, bundledModelPath: getBundledModelPath() });
      for await (const chunk of provider.chat(request)) {
        event.sender.send(channel, chunk);
      }
    } catch (err) {
      event.sender.send(channel, { type: 'error', message: (err as Error).message });
    }
  });
}
