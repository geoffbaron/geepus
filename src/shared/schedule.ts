export interface ScheduledTask {
  id: string;
  name: string;
  objective: string;
  /** Cron expression ("0 8 * * *"), interval ("every 30m"), or "loop" for continuous re-queue. */
  schedule: string;
  workspaceRoot: string;
  loopMode: boolean;
  loopDelaySeconds: number;
  /** 0 = never auto-pause on failures. */
  maxConsecutiveFailures: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastRunState: string;
  loopConsecutiveFailures: number;
  loopTotalRuns: number;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskInput {
  name?: string;
  objective: string;
  schedule?: string;
  workspaceRoot?: string;
  loopMode?: boolean;
  loopDelaySeconds?: number;
  maxConsecutiveFailures?: number;
  enabled?: boolean;
}

export interface FileWatchTrigger {
  id: string;
  name: string;
  watchPath: string;
  /** Glob-ish: `*` and `**` supported. */
  pattern: string;
  taskId: string;
  enabled: boolean;
  lastFiredAt: string | null;
  firedCount: number;
  cooldownMs: number;
  createdAt: string;
}

export interface FileWatchTriggerInput {
  name?: string;
  watchPath: string;
  pattern?: string;
  taskId: string;
  enabled?: boolean;
  cooldownMs?: number;
}
