import { registerAppIpc } from './app';

/**
 * Mounts every namespaced IPC module. Add one line here per new namespace
 * (setup, models, runtime, memory, schedule, browser, settings, ...) as milestones land —
 * never grow a single flat handler file again (see PLAN.md §10, ipc-handlers.js).
 */
export function registerIpcHandlers(): void {
  registerAppIpc();
}
