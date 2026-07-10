import { contextBridge, ipcRenderer } from 'electron';
import type { IpcApi } from '@shared/ipc';

const geepus: IpcApi = {
  app: {
    getVersion: () => ipcRenderer.invoke('app.getVersion'),
  },
};

contextBridge.exposeInMainWorld('geepus', geepus);
