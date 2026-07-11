import { app, ipcMain } from 'electron';
import { getMemoryService } from '../memory/instance';
import { loadSettings } from '../settings/store';

async function memory() {
  const settings = await loadSettings(app.getPath('userData'));
  return getMemoryService(settings.ollama.baseUrl);
}

export function registerMemoryIpc(): void {
  ipcMain.handle('memory.listEntries', async () => {
    const service = await memory();
    const namespaces = await service.store.listNamespaces();
    const all = await Promise.all(
      namespaces.map(async (namespace) => {
        const entries = await service.store.list(namespace);
        return entries.map((e) => ({ namespace, id: e.id, text: e.text, metadata: e.metadata }));
      }),
    );
    return all.flat();
  });

  ipcMain.handle('memory.remember', async (_event, text: string) => {
    const service = await memory();
    await service.remember(text);
  });

  ipcMain.handle('memory.forget', async (_event, namespace: string, id: string) => {
    const service = await memory();
    return service.store.remove(namespace, id);
  });

  ipcMain.handle('memory.consolidate', async () => {
    const service = await memory();
    return service.consolidate();
  });
}
