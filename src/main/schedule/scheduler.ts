import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ScheduledTask, ScheduledTaskInput } from '@shared/schedule';
import { nextCronMatch, parseInterval } from './cron';

export interface RunOutcome {
  success: boolean;
  reason: string;
}

export type ObjectiveExecutor = (task: ScheduledTask) => Promise<RunOutcome>;

export interface SchedulerNotifier {
  onTaskCompleted?: (task: ScheduledTask, outcome: RunOutcome) => void;
  onTaskFailed?: (task: ScheduledTask, error: Error) => void;
  onLoopPaused?: (task: ScheduledTask) => void;
}

function makeTaskId(): string {
  return `sched_${randomUUID()}`;
}

function normalizeTask(input: Partial<ScheduledTask> & { objective: string }): ScheduledTask {
  const schedule = input.schedule ?? '';
  const loopMode = schedule.trim().toLowerCase() === 'loop' || input.loopMode === true;
  const now = new Date().toISOString();
  return {
    id: input.id ?? makeTaskId(),
    name: input.name ?? 'Untitled task',
    objective: input.objective,
    schedule,
    workspaceRoot: input.workspaceRoot ?? '',
    loopMode,
    loopDelaySeconds: Math.max(0, input.loopDelaySeconds ?? 0),
    maxConsecutiveFailures: Math.max(0, input.maxConsecutiveFailures ?? 3),
    enabled: input.enabled !== false,
    lastRunAt: input.lastRunAt ?? null,
    lastRunState: input.lastRunState ?? '',
    loopConsecutiveFailures: Math.max(0, input.loopConsecutiveFailures ?? 0),
    loopTotalRuns: Math.max(0, input.loopTotalRuns ?? 0),
    nextRunAt: input.nextRunAt ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

export function computeNextRun(task: ScheduledTask, from: Date = new Date()): string | null {
  if (task.loopMode) {
    return new Date(from.getTime() + task.loopDelaySeconds * 1000).toISOString();
  }

  const intervalMs = parseInterval(task.schedule);
  if (intervalMs > 0) {
    const base = task.lastRunAt ? new Date(task.lastRunAt) : from;
    return new Date(base.getTime() + intervalMs).toISOString();
  }

  const next = nextCronMatch(task.schedule, from);
  return next ? next.toISOString() : null;
}

const TICK_INTERVAL_MS = 30_000;
const MAX_CONCURRENT = 1;

/**
 * Ported from the prototype's scheduler.js, adapted to run against the M3 AgentRuntime
 * via an injected executor (dependency injection keeps this testable without a real
 * model/provider) and trimmed of the loop-journal history feature — not required for
 * M5's accept criteria (see PLAN.md M5).
 */
export class Scheduler {
  private tasks: ScheduledTask[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private runningCount = 0;

  constructor(
    private readonly filePath: string,
    private readonly executor: ObjectiveExecutor,
    private readonly notifier: SchedulerNotifier = {},
  ) {}

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.tasks, null, 2), { mode: 0o600 });
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      this.tasks = Array.isArray(parsed) ? parsed.map((t) => normalizeTask(t as ScheduledTask)) : [];
    } catch {
      this.tasks = [];
    }
  }

  list(): ScheduledTask[] {
    return this.tasks.map((t) => ({ ...t }));
  }

  get(taskId: string): ScheduledTask | null {
    return this.tasks.find((t) => t.id === taskId) ?? null;
  }

  async add(input: ScheduledTaskInput): Promise<ScheduledTask> {
    if (!input.objective) throw new Error('Scheduled task needs an objective.');
    const isLoop = input.loopMode || input.schedule?.trim().toLowerCase() === 'loop';
    if (!isLoop && !input.schedule) {
      throw new Error('Scheduled task needs a schedule (cron, interval, or loop mode).');
    }
    const task = normalizeTask(input);
    task.nextRunAt = computeNextRun(task);
    this.tasks.push(task);
    await this.save();
    return task;
  }

  async update(taskId: string, patch: Partial<ScheduledTaskInput>): Promise<ScheduledTask> {
    const index = this.tasks.findIndex((t) => t.id === taskId);
    if (index === -1) throw new Error(`Scheduled task "${taskId}" not found.`);
    const current = this.tasks[index]!;
    const updated = normalizeTask({ ...current, ...patch, id: current.id, createdAt: current.createdAt });
    updated.updatedAt = new Date().toISOString();
    updated.nextRunAt = computeNextRun(updated);
    this.tasks[index] = updated;
    await this.save();
    return updated;
  }

  async remove(taskId: string): Promise<ScheduledTask> {
    const index = this.tasks.findIndex((t) => t.id === taskId);
    if (index === -1) throw new Error(`Scheduled task "${taskId}" not found.`);
    const [removed] = this.tasks.splice(index, 1);
    await this.save();
    return removed!;
  }

  async runNow(taskId: string): Promise<ScheduledTask> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Scheduled task "${taskId}" not found.`);
    if (task.lastRunState === 'running') throw new Error('Task is already running.');
    await this.execute(task);
    return task;
  }

  private async execute(task: ScheduledTask): Promise<void> {
    this.runningCount += 1;
    task.lastRunAt = new Date().toISOString();
    task.updatedAt = task.lastRunAt;
    task.lastRunState = 'running';

    try {
      const outcome = await this.executor(task);
      task.lastRunState = outcome.success ? 'completed' : 'failed';
      task.loopTotalRuns += 1;
      if (task.loopMode) {
        task.loopConsecutiveFailures = outcome.success ? 0 : task.loopConsecutiveFailures + 1;
      }
      this.notifier.onTaskCompleted?.(task, outcome);
    } catch (err) {
      task.lastRunState = 'failed';
      task.loopTotalRuns += 1;
      if (task.loopMode) task.loopConsecutiveFailures += 1;
      this.notifier.onTaskFailed?.(task, err as Error);
    } finally {
      this.runningCount -= 1;

      if (task.loopMode && task.maxConsecutiveFailures > 0 && task.loopConsecutiveFailures >= task.maxConsecutiveFailures) {
        task.enabled = false;
        task.nextRunAt = null;
        this.notifier.onLoopPaused?.(task);
      } else {
        task.nextRunAt = computeNextRun(task);
      }

      task.updatedAt = new Date().toISOString();
      await this.save().catch(() => {});
    }
  }

  /** One tick: fire every due, enabled, non-running task (fire-and-forget, capped at
   * MAX_CONCURRENT). Exposed directly so tests can drive it without real timers. */
  async tick(): Promise<void> {
    if (this.runningCount >= MAX_CONCURRENT) return;
    const now = Date.now();

    for (const task of this.tasks) {
      if (!task.enabled || !task.nextRunAt || task.lastRunState === 'running') continue;
      if (this.runningCount >= MAX_CONCURRENT) break;
      if (now >= new Date(task.nextRunAt).getTime()) {
        void this.execute(task);
      }
    }
  }

  async start(): Promise<void> {
    if (this.tickTimer) return;
    await this.load();
    this.tickTimer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    await this.tick();
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }
}
