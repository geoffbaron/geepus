import { contextBridge, ipcRenderer } from 'electron';
import type { IpcApi } from '@shared/ipc';
import type { ChatChunk } from '@shared/model';

const geepus: IpcApi = {
  app: {
    getVersion: () => ipcRenderer.invoke('app.getVersion'),
  },
  models: {
    listProviders: () => ipcRenderer.invoke('models.listProviders'),
    chat: (request, onChunk) => {
      const requestId = crypto.randomUUID();
      const channel = `models.chatChunk:${requestId}`;
      const listener = (_event: Electron.IpcRendererEvent, chunk: ChatChunk): void => onChunk(chunk);
      ipcRenderer.on(channel, listener);
      void ipcRenderer.invoke('models.chat', requestId, request);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    onBundledDownloadProgress: (onProgress) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: { downloadedBytes: number; totalBytes: number }): void =>
        onProgress(progress);
      ipcRenderer.on('models.bundledDownloadProgress', listener);
      return () => ipcRenderer.removeListener('models.bundledDownloadProgress', listener);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke('settings.get'),
    update: (partial) => ipcRenderer.invoke('settings.update', partial),
  },
};

contextBridge.exposeInMainWorld('geepus', geepus);
