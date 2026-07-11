import { app, Notification } from 'electron';
import { join } from 'node:path';
import { Scheduler, type RunOutcome } from './scheduler';
import { TriggerEngine } from './triggers';
import { runObjective } from '../runtime/loop';
import { defaultWorkspaceRoot } from '../runtime/workspace';
import { resolveActiveProvider } from '../models/service';
import { getBundledModelPath } from '../models/bootstrap';
import { loadSecrets, loadSettings } from '../settings/store';
import { AuditLog } from '../policy/audit';
import { getMemoryService } from '../memory/instance';
import type { ScheduledTask } from '@shared/schedule';

let scheduler: Scheduler | null = null;
let triggerEngine: TriggerEngine | null = null;

/** Scheduled runs get a much lower budget than interactive chat runs (PLAN.md §4 item 4) —
 * an unattended run going wrong should fail fast, not burn the machine for an hour. */
const SCHEDULED_RUN_BUDGETS = { maxIterations: 5, maxToolCalls: 10, maxRuntimeMs: 3 * 60_000 };

async function executeScheduledObjective(task: ScheduledTask): Promise<RunOutcome> {
  const userDataDir = app.getPath('userData');
  const [settings, secrets] = await Promise.all([loadSettings(userDataDir), loadSecrets(userDataDir)]);
  const provider = resolveActiveProvider({ settings, secrets, bundledModelPath: getBundledModelPath() });
  const auditLog = new AuditLog(join(userDataDir, 'audit.log'));
  await auditLog.init();
  const memory = getMemoryService(settings.ollama.baseUrl);
  const workspaceRoot = task.workspaceRoot || defaultWorkspaceRoot();

  let success = false;
  let reason = 'Run produced no outcome.';
  for await (const event of runObjective({
    objective: task.objective,
    workspaceRoot,
    provider,
    auditLog,
    memory,
    budgets: SCHEDULED_RUN_BUDGETS,
  })) {
    if (event.type === 'done') {
      success = event.success;
      reason = event.reason;
    }
  }
  return { success, reason };
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

export function getScheduler(): Scheduler {
  if (!scheduler) {
    scheduler = new Scheduler(join(app.getPath('userData'), 'scheduled-tasks.json'), executeScheduledObjective, {
      onTaskCompleted: (task, outcome) => notify(task.name, outcome.success ? 'Completed.' : `Stopped: ${outcome.reason}`),
      onTaskFailed: (task, error) => notify(`${task.name} failed`, error.message),
      onLoopPaused: (task) => notify(`${task.name} paused`, 'Too many consecutive failures — check the task.'),
    });
  }
  return scheduler;
}

export function getTriggerEngine(): TriggerEngine {
  if (!triggerEngine) {
    const sched = getScheduler();
    triggerEngine = new TriggerEngine(join(app.getPath('userData'), 'triggers.json'), {
      isTaskRunning: (taskId) => sched.get(taskId)?.lastRunState === 'running',
      runTaskNow: (taskId) => sched.runNow(taskId).then(() => undefined),
    });
  }
  return triggerEngine;
}

export async function startSchedulerAndTriggers(): Promise<void> {
  await getScheduler().start();
  await getTriggerEngine().start();
}

export function stopSchedulerAndTriggers(): void {
  scheduler?.stop();
  triggerEngine?.stopAll();
}
