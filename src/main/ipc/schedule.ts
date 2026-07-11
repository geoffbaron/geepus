import { ipcMain } from 'electron';
import type { FileWatchTriggerInput, ScheduledTaskInput } from '@shared/schedule';
import { getScheduler, getTriggerEngine } from '../schedule/instance';

export function registerScheduleIpc(): void {
  ipcMain.handle('schedule.list', () => getScheduler().list());
  ipcMain.handle('schedule.add', (_event, input: ScheduledTaskInput) => getScheduler().add(input));
  ipcMain.handle('schedule.update', (_event, id: string, patch: Partial<ScheduledTaskInput>) => getScheduler().update(id, patch));
  ipcMain.handle('schedule.remove', (_event, id: string) => getScheduler().remove(id));
  ipcMain.handle('schedule.runNow', (_event, id: string) => getScheduler().runNow(id));

  ipcMain.handle('schedule.listTriggers', () => getTriggerEngine().list());
  ipcMain.handle('schedule.addTrigger', (_event, input: FileWatchTriggerInput) => getTriggerEngine().add(input));
  ipcMain.handle('schedule.removeTrigger', (_event, id: string) => getTriggerEngine().remove(id));
}
