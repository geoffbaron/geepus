import { contextBridge, ipcRenderer } from 'electron';
import type { IpcApi } from '@shared/ipc';
import type { ChatChunk, OllamaPullProgress } from '@shared/model';
import type { AgentEvent, PendingApproval } from '@shared/agent';

const geepus: IpcApi = {
  app: {
    getVersion: () => ipcRenderer.invoke('app.getVersion'),
    openHelpLink: (url) => ipcRenderer.invoke('app.openHelpLink', url),
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
  runtime: {
    run: (request, onEvent) => {
      const requestId = crypto.randomUUID();
      const channel = `runtime.event:${requestId}`;
      const listener = (_event: Electron.IpcRendererEvent, agentEvent: AgentEvent): void => onEvent(agentEvent);
      ipcRenderer.on(channel, listener);
      void ipcRenderer.invoke('runtime.run', requestId, request);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    listPendingApprovals: () => ipcRenderer.invoke('runtime.listPendingApprovals'),
    resolveApproval: (id, approved) => ipcRenderer.invoke('runtime.resolveApproval', id, approved),
    onApprovalRequested: (onApproval) => {
      const listener = (_event: Electron.IpcRendererEvent, approval: PendingApproval): void => onApproval(approval);
      ipcRenderer.on('runtime.approvalRequested', listener);
      return () => ipcRenderer.removeListener('runtime.approvalRequested', listener);
    },
  },
  memory: {
    listEntries: () => ipcRenderer.invoke('memory.listEntries'),
    remember: (text) => ipcRenderer.invoke('memory.remember', text),
    forget: (namespace, id) => ipcRenderer.invoke('memory.forget', namespace, id),
    consolidate: () => ipcRenderer.invoke('memory.consolidate'),
  },
  schedule: {
    list: () => ipcRenderer.invoke('schedule.list'),
    add: (input) => ipcRenderer.invoke('schedule.add', input),
    update: (id, patch) => ipcRenderer.invoke('schedule.update', id, patch),
    remove: (id) => ipcRenderer.invoke('schedule.remove', id),
    runNow: (id) => ipcRenderer.invoke('schedule.runNow', id),
    listTriggers: () => ipcRenderer.invoke('schedule.listTriggers'),
    addTrigger: (input) => ipcRenderer.invoke('schedule.addTrigger', input),
    removeTrigger: (id) => ipcRenderer.invoke('schedule.removeTrigger', id),
  },
  mail: {
    testConnection: (config) => ipcRenderer.invoke('mail.testConnection', config),
    saveAccount: (config) => ipcRenderer.invoke('mail.saveAccount', config),
    isConfigured: () => ipcRenderer.invoke('mail.isConfigured'),
    runInboxNow: () => ipcRenderer.invoke('mail.runInboxNow'),
  },
  brief: {
    generate: () => ipcRenderer.invoke('brief.generate'),
  },
  browser: {
    listProposedControllers: (workspaceRoot) => ipcRenderer.invoke('browser.listProposedControllers', workspaceRoot),
    promoteController: (specId, workspaceRoot) => ipcRenderer.invoke('browser.promoteController', specId, workspaceRoot),
  },
  handoff: {
    openMailDraft: (draft) => ipcRenderer.invoke('handoff.openMailDraft', draft),
    openCalendarFile: (path) => ipcRenderer.invoke('handoff.openCalendarFile', path),
  },
  webmail: {
    listProviders: () => ipcRenderer.invoke('webmail.listProviders'),
    connect: (providerId) => ipcRenderer.invoke('webmail.connect', providerId),
    checkStatus: (providerId) => ipcRenderer.invoke('webmail.checkStatus', providerId),
    getStatus: () => ipcRenderer.invoke('webmail.getStatus'),
    disconnect: () => ipcRenderer.invoke('webmail.disconnect'),
    runInboxNow: () => ipcRenderer.invoke('webmail.runInboxNow'),
  },
};

contextBridge.exposeInMainWorld('geepus', geepus);
