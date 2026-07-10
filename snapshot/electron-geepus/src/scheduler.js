'use strict';

/**
 * scheduler.js — Cron-style task scheduler for proactive Geepus runs.
 *
 * Stores scheduled tasks in a JSON file inside Electron's userData directory.
 * Each task has a cron expression (or simple interval), an objective, optional
 * workspace, run limits, and execution mode. The scheduler evaluates due tasks
 * every 30 seconds and dispatches them via the agent loop.
 *
 * Depends on: settings.js, agent-loop.js, notifications.js
 */

const path = require('path');
const fs = require('fs/promises');
const { app } = require('electron');

const { readSettings, normalizeRunLimits, DEFAULT_RUN_LIMITS } = require('./settings');
const { runObjectiveCore } = require('./agent-loop');
const { appendAuditEvent } = require('./audit');
const {
  notifyTaskComplete,
  notifyTaskFailed,
  notifyTaskNeedsAttention,
} = require('./notifications');

const SCHEDULER_FILE = 'scheduled-tasks.json';
const TICK_INTERVAL_MS = 30_000; // 30 seconds
const MAX_CONCURRENT_SCHEDULED = 1;

let scheduledTasks = [];
let tickTimer = null;
let runningCount = 0;
let lastTickTs = 0;

function schedulerPath() {
  return path.join(app.getPath('userData'), SCHEDULER_FILE);
}

// ---------------------------------------------------------------------------
// Cron-lite parser (minute, hour, day-of-month, month, day-of-week)
// Supports: *, specific numbers, comma-lists, ranges (e.g. 1-5), */N steps
// ---------------------------------------------------------------------------

function parseCronField(field, min, max) {
  if (field === '*') return null; // matches any
  const parts = field.split(',');
  const values = new Set();

  for (const part of parts) {
    const stepMatch = part.match(/^(?:\*|(\d+)-(\d+))\/(\d+)$/);
    if (stepMatch) {
      const start = stepMatch[1] !== undefined ? Number(stepMatch[1]) : min;
      const end = stepMatch[2] !== undefined ? Number(stepMatch[2]) : max;
      const step = Number(stepMatch[3]) || 1;
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      for (let i = lo; i <= hi; i++) values.add(i);
      continue;
    }
    const num = Number(part);
    if (Number.isFinite(num) && num >= min && num <= max) {
      values.add(num);
    }
  }

  return values.size > 0 ? values : null;
}

function parseCron(expression) {
  const parts = String(expression || '').trim().split(/\s+/);
  if (parts.length < 5) return null;
  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    dayOfMonth: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    dayOfWeek: parseCronField(parts[4], 0, 6), // 0 = Sunday
  };
}

function cronMatches(parsed, date) {
  if (!parsed) return false;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();
  if (parsed.minute && !parsed.minute.has(minute)) return false;
  if (parsed.hour && !parsed.hour.has(hour)) return false;
  if (parsed.dayOfMonth && !parsed.dayOfMonth.has(dom)) return false;
  if (parsed.month && !parsed.month.has(month)) return false;
  if (parsed.dayOfWeek && !parsed.dayOfWeek.has(dow)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Interval support: "every 30m", "every 2h", "every 1d"
// ---------------------------------------------------------------------------

function parseInterval(expression) {
  const match = String(expression || '').match(/^every\s+(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('m')) return amount * 60 * 1000;
  if (unit.startsWith('h')) return amount * 60 * 60 * 1000;
  if (unit.startsWith('d')) return amount * 24 * 60 * 60 * 1000;
  return 0;
}

// ---------------------------------------------------------------------------
// Task schema
// ---------------------------------------------------------------------------

function makeTaskId() {
  return `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Special schedule keyword: "loop" means run continuously — restart immediately after each completion.
const LOOP_SCHEDULE = 'loop';

function isLoopSchedule(schedule) {
  return String(schedule || '').trim().toLowerCase() === LOOP_SCHEDULE;
}

function normalizeTask(raw) {
  const task = raw && typeof raw === 'object' ? raw : {};
  const schedule = String(task.schedule || '');
  // loopMode: true if schedule is "loop" OR if loopMode flag is explicitly set
  const loopMode = isLoopSchedule(schedule) || task.loopMode === true;
  return {
    id: String(task.id || makeTaskId()),
    name: String(task.name || 'Untitled task'),
    objective: String(task.objective || ''),
    schedule,
    workspaceRoot: String(task.workspaceRoot || ''),
    executionMode: task.executionMode === 'research' ? 'research' : (task.executionMode === 'auto' ? 'auto' : 'action'),
    teamMode: task.teamMode === 'solo' ? 'solo' : 'teams',
    runLimits: normalizeRunLimits(task.runLimits || {}, DEFAULT_RUN_LIMITS),
    loopMode,
    loopDelaySeconds: Math.max(0, Number(task.loopDelaySeconds) || 0),
    // 0 = never auto-pause on failures; try everything
    maxConsecutiveFailures: Math.max(0, Number(task.maxConsecutiveFailures) || 0),
    enabled: task.enabled !== false,
    lastRunAt: task.lastRunAt || null,
    lastRunId: task.lastRunId || '',
    lastRunState: task.lastRunState || '',
    loopConsecutiveFailures: Math.max(0, Number(task.loopConsecutiveFailures) || 0),
    loopTotalRuns: Math.max(0, Number(task.loopTotalRuns) || 0),
    // Accumulated journal of every loop run — injected into the next run as context
    loopJournal: Array.isArray(task.loopJournal) ? task.loopJournal : [],
    nextRunAt: task.nextRunAt || null,
    createdAt: task.createdAt || new Date().toISOString(),
    updatedAt: task.updatedAt || new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function loadScheduledTasks() {
  try {
    const content = await fs.readFile(schedulerPath(), 'utf8');
    const parsed = JSON.parse(content);
    scheduledTasks = Array.isArray(parsed) ? parsed.map(normalizeTask) : [];
  } catch {
    scheduledTasks = [];
  }
  return scheduledTasks;
}

async function saveScheduledTasks() {
  const file = schedulerPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(scheduledTasks, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Task CRUD
// ---------------------------------------------------------------------------

async function addScheduledTask(taskDef) {
  const task = normalizeTask({ ...taskDef, id: makeTaskId() });
  if (!task.objective) throw new Error('Scheduled task needs an objective.');
  if (!task.loopMode && !task.schedule) throw new Error('Scheduled task needs a schedule (cron, interval, or enable Loop mode).');
  computeNextRun(task);
  scheduledTasks.push(task);
  await saveScheduledTasks();
  await appendAuditEvent({ type: 'scheduled_task_created', task_id: task.id, name: task.name });
  return task;
}

async function updateScheduledTask(taskId, patch) {
  const index = scheduledTasks.findIndex((t) => t.id === taskId);
  if (index === -1) throw new Error(`Scheduled task "${taskId}" not found.`);
  const current = scheduledTasks[index];
  const updated = normalizeTask({ ...current, ...patch, id: current.id, createdAt: current.createdAt });
  updated.updatedAt = new Date().toISOString();
  computeNextRun(updated);
  scheduledTasks[index] = updated;
  await saveScheduledTasks();
  return updated;
}

async function removeScheduledTask(taskId) {
  const index = scheduledTasks.findIndex((t) => t.id === taskId);
  if (index === -1) throw new Error(`Scheduled task "${taskId}" not found.`);
  const removed = scheduledTasks.splice(index, 1)[0];
  await saveScheduledTasks();
  await appendAuditEvent({ type: 'scheduled_task_removed', task_id: removed.id, name: removed.name });
  return removed;
}

function listScheduledTasks() {
  return scheduledTasks.map((t) => ({ ...t }));
}

function getScheduledTask(taskId) {
  return scheduledTasks.find((t) => t.id === taskId) || null;
}

// ---------------------------------------------------------------------------
// Next-run computation
// ---------------------------------------------------------------------------

function computeNextRun(task) {
  const now = new Date();

  // Loop mode: re-queue immediately (plus optional cool-down delay)
  if (task.loopMode) {
    const delayMs = (task.loopDelaySeconds || 0) * 1000;
    task.nextRunAt = new Date(now.getTime() + delayMs).toISOString();
    return;
  }

  const intervalMs = parseInterval(task.schedule);

  if (intervalMs > 0) {
    const base = task.lastRunAt ? new Date(task.lastRunAt) : now;
    task.nextRunAt = new Date(base.getTime() + intervalMs).toISOString();
    return;
  }

  const parsed = parseCron(task.schedule);
  if (!parsed) {
    task.nextRunAt = null;
    return;
  }

  // Walk forward minute-by-minute for up to 48 hours to find next match
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxLookahead = 48 * 60; // 48 hours in minutes
  for (let i = 0; i < maxLookahead; i++) {
    if (cronMatches(parsed, candidate)) {
      task.nextRunAt = candidate.toISOString();
      return;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  task.nextRunAt = null;
}

// ---------------------------------------------------------------------------
// Task execution
// ---------------------------------------------------------------------------

const LOOP_JOURNAL_MAX_ENTRIES = 20; // keep last 20 runs in context

/**
 * Append one entry to the task's loopJournal after a run finishes.
 * Captures outcome, stop reason, what succeeded, what failed, and key findings.
 */
function appendJournalEntry(task, result, error) {
  if (!task.loopJournal) task.loopJournal = [];
  const runNum = task.loopTotalRuns || 1;
  const ts = new Date().toISOString();

  let entry;
  if (error) {
    entry = {
      run: runNum,
      ts,
      outcome: 'error',
      reason: String(error.message || error).slice(0, 300),
      succeeded: [],
      failed: [],
      findings: '',
    };
  } else {
    // Parse structured info out of the run result for a clean journal entry
    const report = String(result.report || '').trim();
    const reason = String(result.reason || '').trim();

    // Extract succeeded/failed action summaries from the report text
    const succeededMatch = report.match(/(\d+) completed/);
    const failedMatch = report.match(/(\d+) failed/);

    // Pull out any "latest failures" lines from the report
    const failureLines = [];
    const failureSection = report.match(/- (\w+): .+/g);
    if (failureSection) failureLines.push(...failureSection.slice(0, 5));

    entry = {
      run: runNum,
      ts,
      outcome: result.state || 'stopped',
      reason: reason.slice(0, 300),
      succeeded: succeededMatch ? [`${succeededMatch[1]} actions`] : [],
      failed: failedMatch ? [`${failedMatch[1]} actions`] : [],
      failureDetails: failureLines.join('\n').slice(0, 500),
      findings: report.slice(0, 800),
    };
  }

  task.loopJournal.push(entry);
  // Trim to cap — keep the most recent entries
  if (task.loopJournal.length > LOOP_JOURNAL_MAX_ENTRIES) {
    task.loopJournal = task.loopJournal.slice(-LOOP_JOURNAL_MAX_ENTRIES);
  }
}

/**
 * Build the inter-run context injected at the start of every loop run.
 * The agent reads its own history and uses it to avoid repeating failures
 * and build on what worked.
 */
function buildLoopContext(task) {
  const journal = task.loopJournal;
  if (!journal || journal.length === 0) return '';

  const lines = [
    `=== LOOP TASK HISTORY (${journal.length} previous run${journal.length === 1 ? '' : 's'}) ===`,
    `Objective: ${task.objective}`,
    '',
    'You have run this task before. Study the history below to avoid repeating failed approaches',
    'and build on what worked. Your goal this run is to make progress beyond previous attempts.',
    '',
  ];

  for (const entry of journal) {
    lines.push(`--- Run #${entry.run} (${entry.ts.slice(0, 16).replace('T', ' ')} UTC) ---`);
    lines.push(`Outcome: ${entry.outcome}`);
    if (entry.reason) lines.push(`Stopped because: ${entry.reason}`);
    if (entry.succeeded && entry.succeeded.length > 0) lines.push(`Succeeded: ${entry.succeeded.join(', ')}`);
    if (entry.failed && entry.failed.length > 0) lines.push(`Failed: ${entry.failed.join(', ')}`);
    if (entry.failureDetails) lines.push(`Failure details:\n${entry.failureDetails}`);
    if (entry.findings && entry.findings !== entry.reason) lines.push(`Run notes:\n${entry.findings.slice(0, 400)}`);
    lines.push('');
  }

  lines.push('=== END HISTORY ===');
  lines.push('');
  lines.push('INSTRUCTIONS FOR THIS RUN:');
  lines.push('1. Do NOT repeat approaches that failed in previous runs unless you have a clear reason they might work now.');
  lines.push('2. Build on what succeeded. If something partially worked, go further with it.');
  lines.push('3. If all obvious approaches have been tried, get creative — try a completely different method.');
  lines.push('4. Write a brief note at the start of your first plan explaining what you will try differently this run.');

  return lines.join('\n');
}

async function executeScheduledTask(task) {
  runningCount += 1;
  task.lastRunAt = new Date().toISOString();
  task.updatedAt = task.lastRunAt;
  task.lastRunState = 'running';

  try {
    const settings = await readSettings();

    // In loop mode, inject context from the previous run so the agent can adapt
    const loopContext = task.loopMode ? buildLoopContext(task) : '';

    const request = {
      task: task.objective,
      executionMode: task.executionMode,
      teamMode: task.teamMode,
      workspaceRoot: task.workspaceRoot || undefined,
      runLimits: task.runLimits,
      allowRisky: true,
      scheduledTaskId: task.id,
      threadContext: loopContext || undefined,
    };

    const result = await runObjectiveCore(settings, request);

    task.lastRunId = result.runId || '';
    task.lastRunState = result.state || 'completed';
    task.loopTotalRuns = (task.loopTotalRuns || 0) + 1;

    const succeeded = result.state === 'completed';

    if (task.loopMode) {
      task.loopConsecutiveFailures = succeeded ? 0 : (task.loopConsecutiveFailures || 0) + 1;
      appendJournalEntry(task, result, null);
    }

    if (succeeded) {
      notifyTaskComplete(task.name, result.reason || result.report || 'Task completed.');
    } else if (result.requiresApproval) {
      task.lastRunState = 'paused_approval';
      notifyTaskNeedsAttention(task.name, 'Execution paused — approval needed.');
    } else {
      notifyTaskComplete(task.name, `Task stopped: ${result.reason || 'limit or policy'}`);
    }

    await appendAuditEvent({
      type: 'scheduled_task_completed',
      task_id: task.id,
      name: task.name,
      run_id: task.lastRunId,
      state: task.lastRunState,
    });
  } catch (error) {
    task.lastRunState = 'failed';
    task.loopTotalRuns = (task.loopTotalRuns || 0) + 1;
    if (task.loopMode) {
      task.loopConsecutiveFailures = (task.loopConsecutiveFailures || 0) + 1;
      appendJournalEntry(task, null, error);
    }
    notifyTaskFailed(task.name, error.message || String(error));
    await appendAuditEvent({
      type: 'scheduled_task_failed',
      task_id: task.id,
      name: task.name,
      error: String(error.message || error).slice(0, 500),
    });
  } finally {
    runningCount -= 1;

    // In loop mode: pause if consecutive failures hit the limit; otherwise re-queue
    if (task.loopMode) {
      const maxFails = task.maxConsecutiveFailures || 3;
      if (maxFails > 0 && task.loopConsecutiveFailures >= maxFails) {
        task.enabled = false;
        task.nextRunAt = null;
        notifyTaskNeedsAttention(
          task.name,
          `Loop paused after ${task.loopConsecutiveFailures} consecutive failures. Check the task and re-enable when ready.`,
        );
      } else {
        computeNextRun(task);
      }
    } else {
      computeNextRun(task);
    }

    task.updatedAt = new Date().toISOString();
    await saveScheduledTasks().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Tick loop — called every TICK_INTERVAL_MS
// ---------------------------------------------------------------------------

async function tick() {
  const now = Date.now();
  if (now - lastTickTs < TICK_INTERVAL_MS - 2000) return;
  lastTickTs = now;

  if (runningCount >= MAX_CONCURRENT_SCHEDULED) return;

  for (const task of scheduledTasks) {
    if (!task.enabled) continue;
    if (!task.nextRunAt) continue;
    if (task.lastRunState === 'running') continue;
    if (runningCount >= MAX_CONCURRENT_SCHEDULED) break;

    const nextRun = new Date(task.nextRunAt).getTime();
    if (now >= nextRun) {
      // Fire and don't await — let it run in background
      executeScheduledTask(task).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduler lifecycle
// ---------------------------------------------------------------------------

async function startScheduler() {
  if (tickTimer) return;
  await loadScheduledTasks();
  lastTickTs = Date.now();
  tickTimer = setInterval(tick, TICK_INTERVAL_MS);
  tick().catch(() => {}); // immediate first check
}

function stopScheduler() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/**
 * Manually trigger a scheduled task immediately, regardless of schedule.
 */
async function runScheduledTaskNow(taskId) {
  const task = scheduledTasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Scheduled task "${taskId}" not found.`);
  if (task.lastRunState === 'running') throw new Error('Task is already running.');
  await executeScheduledTask(task);
  return task;
}

module.exports = {
  loadScheduledTasks,
  saveScheduledTasks,
  addScheduledTask,
  updateScheduledTask,
  removeScheduledTask,
  listScheduledTasks,
  getScheduledTask,
  runScheduledTaskNow,
  startScheduler,
  stopScheduler,
  // Exposed for testing
  parseCron,
  cronMatches,
  parseInterval,
  normalizeTask,
};
