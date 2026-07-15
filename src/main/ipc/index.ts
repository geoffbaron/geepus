import { registerAppIpc } from './app';
import { registerModelsIpc } from './models';
import { registerSettingsIpc } from './settings';
import { registerSetupIpc } from './setup';
import { registerRuntimeIpc } from './runtime';
import { registerMemoryIpc } from './memory';
import { registerScheduleIpc } from './schedule';
import { registerMailIpc } from './mail';
import { registerBriefIpc } from './brief';
import { registerBrowserIpc } from './browser';
import { registerHandoffIpc } from './handoff';
import { registerWebmailIpc } from './webmail';
import { registerUpdatesIpc } from './updates';

/**
 * Mounts every namespaced IPC module — never grow a single flat handler file again
 * (see PLAN.md §10, ipc-handlers.js).
 */
export function registerIpcHandlers(): void {
  registerAppIpc();
  registerModelsIpc();
  registerSettingsIpc();
  registerSetupIpc();
  registerRuntimeIpc();
  registerMemoryIpc();
  registerScheduleIpc();
  registerMailIpc();
  registerBriefIpc();
  registerBrowserIpc();
  registerHandoffIpc();
  registerWebmailIpc();
  registerUpdatesIpc();
}
