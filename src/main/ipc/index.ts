import { registerAppIpc } from './app';
import { registerModelsIpc } from './models';
import { registerSettingsIpc } from './settings';
import { registerSetupIpc } from './setup';
import { registerRuntimeIpc } from './runtime';
import { registerMemoryIpc } from './memory';

/**
 * Mounts every namespaced IPC module. Add one line here per new namespace
 * (schedule, browser, ...) as milestones land —
 * never grow a single flat handler file again (see PLAN.md §10, ipc-handlers.js).
 */
export function registerIpcHandlers(): void {
  registerAppIpc();
  registerModelsIpc();
  registerSettingsIpc();
  registerSetupIpc();
  registerRuntimeIpc();
  registerMemoryIpc();
}
