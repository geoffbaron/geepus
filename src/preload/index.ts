import { contextBridge, ipcRenderer } from 'electron';
import type { IpcApi } from '@shared/ipc';
import type { ChatChunk, OllamaPullProgress } from '@shared/model';

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
  setup: {
    probeHardware: () => ipcRenderer.invoke('setup.probeHardware'),
    discover: () => ipcRenderer.invoke('setup.discover'),
    recommend: (profile) => ipcRenderer.invoke('setup.recommend', profile),
    determinePath: (profile, discovery) => ipcRenderer.invoke('setup.determinePath', profile, discovery),
    adoptOllamaModel: (modelName) => ipcRenderer.invoke('setup.adoptOllamaModel', modelName),
    useBundled: () => ipcRenderer.invoke('setup.useBundled'),
    pullModel: (tag, onProgress) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: OllamaPullProgress): void => onProgress(progress);
      ipcRenderer.on('setup.pullProgress', listener);
      void ipcRenderer.invoke('setup.pullModel', tag);
      return () => ipcRenderer.removeListener('setup.pullProgress', listener);
    },
    installOllama: (onProgress) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: { downloadedBytes: number; totalBytes: number }): void =>
        onProgress(progress);
      ipcRenderer.on('setup.installProgress', listener);
      return ipcRenderer.invoke('setup.installOllama').finally(() => {
        ipcRenderer.removeListener('setup.installProgress', listener);
      });
    },
    launchOllama: () => ipcRenderer.invoke('setup.launchOllama'),
    requestNotificationPermission: () => ipcRenderer.invoke('setup.requestNotificationPermission'),
    completeOnboarding: () => ipcRenderer.invoke('setup.completeOnboarding'),
  },
};

contextBridge.exposeInMainWorld('geepus', geepus);
