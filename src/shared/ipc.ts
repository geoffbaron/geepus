/**
 * The IPC contract shared by main, preload, and renderer.
 *
 * Namespaced channels (`app.*`, `setup.*`, `chat.*`, ...) keep this file the single source of
 * truth instead of 78 flat strings — see PLAN.md §10 (do not repeat ipc-handlers.js's mistake).
 * Each milestone adds its own namespace here and a matching module under src/main/ipc/.
 */

import type { ChatChunk, ChatRequest, OllamaPullProgress, ProviderStatus } from './model';
import type { Settings } from './settings';
import type { DiscoveryReport, InstallOllamaResult, MachineProfile, Recommendation, SetupPlan } from './setup';

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
}

export interface IpcApi {
  app: {
    getVersion: () => Promise<string>;
  };
  models: {
    listProviders: () => Promise<ProviderStatus[]>;
    /** Streams chunks via onChunk as they arrive; returns an unsubscribe function. */
    chat: (request: ChatRequest, onChunk: (chunk: ChatChunk) => void) => () => void;
    onBundledDownloadProgress: (onProgress: (progress: DownloadProgress) => void) => () => void;
  };
  settings: {
    get: () => Promise<Settings>;
    update: (partial: Partial<Settings>) => Promise<Settings>;
  };
  setup: {
    probeHardware: () => Promise<MachineProfile>;
    discover: () => Promise<DiscoveryReport>;
    recommend: (profile: MachineProfile) => Promise<Recommendation>;
    determinePath: (profile: MachineProfile, discovery: DiscoveryReport) => Promise<SetupPlan>;
    adoptOllamaModel: (modelName: string) => Promise<Settings>;
    useBundled: () => Promise<Settings>;
    pullModel: (tag: string, onProgress: (progress: OllamaPullProgress) => void) => () => void;
    installOllama: (onProgress: (progress: DownloadProgress) => void) => Promise<InstallOllamaResult>;
    launchOllama: () => Promise<boolean>;
    requestNotificationPermission: () => Promise<boolean>;
    completeOnboarding: () => Promise<Settings>;
  };
}

export type IpcNamespace = keyof IpcApi;
export type IpcChannel = {
  [N in IpcNamespace]: `${N}.${string & keyof IpcApi[N]}`;
}[IpcNamespace];
