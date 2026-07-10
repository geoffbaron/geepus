/**
 * The IPC contract shared by main, preload, and renderer.
 *
 * Namespaced channels (`app.*`, `setup.*`, `chat.*`, ...) keep this file the single source of
 * truth instead of 78 flat strings — see PLAN.md §10 (do not repeat ipc-handlers.js's mistake).
 * Each milestone adds its own namespace here and a matching module under src/main/ipc/.
 */

export interface IpcApi {
  app: {
    getVersion: () => Promise<string>;
  };
}

export type IpcNamespace = keyof IpcApi;
export type IpcChannel = {
  [N in IpcNamespace]: `${N}.${string & keyof IpcApi[N]}`;
}[IpcNamespace];
