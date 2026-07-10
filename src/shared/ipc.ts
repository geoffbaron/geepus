/**
 * The IPC contract shared by main, preload, and renderer.
 *
 * Namespaced channels (`app.*`, `setup.*`, `chat.*`, ...) keep this file the single source of
 * truth instead of 78 flat strings — see PLAN.md §10 (do not repeat ipc-handlers.js's mistake).
 * Each milestone adds its own namespace here and a matching module under src/main/ipc/.
 */

import type { ChatChunk, ChatRequest, ProviderStatus } from './model';
import type { Settings } from './settings';

export interface IpcApi {
  app: {
    getVersion: () => Promise<string>;
  };
  models: {
    listProviders: () => Promise<ProviderStatus[]>;
    /** Streams chunks via onChunk as they arrive; returns an unsubscribe function. */
    chat: (request: ChatRequest, onChunk: (chunk: ChatChunk) => void) => () => void;
    onBundledDownloadProgress: (
      onProgress: (progress: { downloadedBytes: number; totalBytes: number }) => void,
    ) => () => void;
  };
  settings: {
    get: () => Promise<Settings>;
    update: (partial: Partial<Settings>) => Promise<Settings>;
  };
}

export type IpcNamespace = keyof IpcApi;
export type IpcChannel = {
  [N in IpcNamespace]: `${N}.${string & keyof IpcApi[N]}`;
}[IpcNamespace];
