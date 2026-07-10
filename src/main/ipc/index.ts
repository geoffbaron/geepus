import { registerAppIpc } from './app';
import { registerModelsIpc } from './models';
import { registerSettingsIpc } from './settings';

/**
 * Mounts every namespaced IPC module. Add one line here per new namespace
 * (setup, runtime, memory, schedule, browser, ...) as milestones land —
 * never grow a single flat handler file again (see PLAN.md §10, ipc-handlers.js).
 */
export function registerIpcHandlers(): void {
  registerAppIpc();
  registerModelsIpc();
  registerSettingsIpc();
}
