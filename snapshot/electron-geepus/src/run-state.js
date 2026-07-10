'use strict';

const path = require('path');
const fs = require('fs/promises');
const { app } = require('electron');

const { DEFAULT_PROVIDER } = require('./providers');
const { normalizeExecutionMode } = require('./settings');
const { ownerLabel } = require('./team');

const RUNS_DIR = 'agent-runs';
const RUN_DEBUG_LOG_SUFFIX = '.events.ndjson';

const activeRunIds = new Set();
const stopRequestsByRun = new Map();
const activeChildrenByRun = new Map();

function runStateDir() {
  return path.join(app.getPath('userData'), RUNS_DIR);
}

function runStatePath(runId) {
  return path.join(runStateDir(), `${runId}.json`);
}

function runDebugLogPath(runId) {
  return path.join(runStateDir(), `${runId}${RUN_DEBUG_LOG_SUFFIX}`);
}

function sanitizeDebugValue(value, depth = 0) {
  if (depth > 4) {
    return '[max-depth]';
  }
  if (value == null) {
    return value;
  }
  if (typeof value === 'string') {
    return value.length > 4000 ? `${value.slice(0, 4000)}...[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => sanitizeDebugValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const next = {};
    for (const [key, raw] of Object.entries(value).slice(0, 60)) {
      next[key] = sanitizeDebugValue(raw, depth + 1);
    }
    return next;
  }
  return String(value);
}

async function appendRunDebugEvent(runId, eventType, payload = {}) {
  const key = String(runId || '').trim();
  const type = String(eventType || '').trim();
  if (!key || !type) {
    return;
  }
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    runId: key,
    eventType: type,
    payload: sanitizeDebugValue(payload),
  });
  await fs.mkdir(runStateDir(), { recursive: true });
  await fs.appendFile(runDebugLogPath(key), `${line}\n`, 'utf8');
}

async function persistRunState(runState) {
  const payload = {
    ...runState,
    debugLogPath: runState?.runId ? runDebugLogPath(runState.runId) : String(runState?.debugLogPath || ''),
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(runStateDir(), { recursive: true });
  await fs.writeFile(runStatePath(payload.runId), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

async function readRunState(runId) {
  const content = await fs.readFile(runStatePath(runId), 'utf8');
  return JSON.parse(content);
}

function summarizeRunForList(runState) {
  return {
    runId: runState.runId,
    objective: String(runState.objective || ''),
    state: String(runState.state || 'unknown'),
    reason: String(runState.reason || ''),
    provider: String(runState.provider || DEFAULT_PROVIDER),
    teamMode: String(runState.teamMode || 'teams'),
    executionMode: normalizeExecutionMode(runState.executionMode || 'action'),
    workspaceDiscoverySource: String(runState.workspaceDiscoverySource || ''),
    model: String(runState.model || ''),
    workspaceRoot: String(runState.workspaceRoot || ''),
    debugLogPath: String(runState.debugLogPath || (runState.runId ? runDebugLogPath(runState.runId) : '')),
    createdAt: runState.createdAt || null,
    startedAt: runState.startedAt || null,
    updatedAt: runState.updatedAt || null,
    readiness: runState.readiness && typeof runState.readiness === 'object' ? runState.readiness : null,
    iterations: Array.isArray(runState.iterations) ? runState.iterations.length : 0,
    totalActions: Array.isArray(runState.results) ? runState.results.length : 0,
    maxIterations: Number(runState.maxIterations || 0),
    maxRuntimeMinutes: Number(runState.maxRuntimeMinutes || 0),
    maxActions: Number((runState.runLimits && runState.runLimits.maxActions) || runState.remainingActions || 0),
    maxModelCallsPerMinute: Number(runState.maxModelCallsPerMinute || 0),
    maxToolCallsPerMinute: Number(runState.maxToolCallsPerMinute || 0),
    idleTimeoutSeconds: Number(runState.idleTimeoutSeconds || 0),
    consecutiveDriftLimit: Number(runState.consecutiveDriftLimit || 0),
    activeLearnedStrategies: Array.isArray(runState.activeLearnedStrategies) ? runState.activeLearnedStrategies.slice(0, 6) : [],
    activeBannedApproaches: Array.isArray(runState.activeBannedApproaches) ? runState.activeBannedApproaches.slice(0, 6) : [],
    lastPlanConstraint: runState.lastPlanConstraint && typeof runState.lastPlanConstraint === 'object'
      ? { ...runState.lastPlanConstraint }
      : null,
    nativeRuntimeState: runState.nativeRuntimeState && typeof runState.nativeRuntimeState === 'object'
      ? { ...runState.nativeRuntimeState }
      : null,
  };
}

function classifyReviewAction(result) {
  const summary = String(result.summary || '').toLowerCase();
  const intent = String(result.intent || '').toLowerCase();
  if (result.tool === 'read_file' || result.tool === 'list_files') {
    return true;
  }
  if (result.tool !== 'run_command') {
    return false;
  }
  return (
    summary.includes(' test') ||
    summary.includes(' lint') ||
    summary.includes(' build') ||
    intent.includes('test') ||
    intent.includes('lint') ||
    intent.includes('verify') ||
    intent.includes('review')
  );
}

function buildWorkflowView(runState) {
  const iterations = Array.isArray(runState.iterations) ? runState.iterations : [];
  const planner = [];
  const builder = [];
  const reviewer = [];
  const checkpoints = [];
  const nativeRuntimeState = runState.nativeRuntimeState && typeof runState.nativeRuntimeState === 'object'
    ? runState.nativeRuntimeState
    : null;

  if (nativeRuntimeState) {
    const statusMap = {
      running: 'in_progress',
      recovered: 'failed',
      fallback: 'failed',
      interrupted: 'failed',
      completed: 'done',
    };
    const checkpointStatus = statusMap[String(nativeRuntimeState.status || '').toLowerCase()] || 'pending';
    const summaryBits = ['Nanobot native runtime'];
    if (nativeRuntimeState.status) {
      summaryBits.push(String(nativeRuntimeState.status));
    }
    if (Number.isFinite(Number(nativeRuntimeState.partialResults)) && Number(nativeRuntimeState.partialResults) > 0) {
      summaryBits.push(`${Number(nativeRuntimeState.partialResults)} partial action(s)`);
    }
    checkpoints.push({
      iteration: 0,
      status: checkpointStatus,
      summary: summaryBits.join(' • '),
      actions: Number(nativeRuntimeState.partialResults || 0),
      okActions: checkpointStatus === 'done' ? Number(nativeRuntimeState.partialResults || 0) : 0,
    });
  }

  iterations.forEach((iteration) => {
    planner.push({
      id: `planner-${iteration.iteration}`,
      iteration: iteration.iteration,
      text: iteration.summary,
      status: iteration.results.every((item) => item.ok) ? 'done' : 'failed',
    });

    iteration.results.forEach((result, index) => {
      const base = {
        id: `iter-${iteration.iteration}-action-${index + 1}`,
        iteration: iteration.iteration,
        text: `${ownerLabel(result.owner)} • ${result.tool}: ${result.intent}`,
        status: result.ok ? 'done' : 'failed',
      };
      if (classifyReviewAction(result)) {
        reviewer.push(base);
      } else {
        builder.push(base);
      }
    });

    checkpoints.push({
      iteration: iteration.iteration,
      status: iteration.results.every((item) => item.ok) ? 'done' : 'failed',
      summary: iteration.summary,
      actions: iteration.results.length,
      okActions: iteration.results.filter((item) => item.ok).length,
    });
  });

  return {
    lanes: {
      planner,
      builder,
      reviewer,
    },
    checkpoints,
  };
}

async function listRunStates(limit = 40) {
  await fs.mkdir(runStateDir(), { recursive: true });
  const files = await fs.readdir(runStateDir());
  const runFiles = files.filter((file) => file.endsWith('.json'));
  const runs = [];

  for (const file of runFiles) {
    try {
      const content = await fs.readFile(path.join(runStateDir(), file), 'utf8');
      const parsed = JSON.parse(content);
      if (
        parsed
        && parsed.runId
        && parsed.state === 'running'
        && !activeRunIds.has(parsed.runId)
      ) {
        parsed.state = 'stopped';
        parsed.reason = parsed.reason || 'Run interrupted. You can resume it.';
        if (parsed.nativeRuntimeState && typeof parsed.nativeRuntimeState === 'object' && parsed.nativeRuntimeState.status === 'running') {
          parsed.nativeRuntimeState = {
            ...parsed.nativeRuntimeState,
            status: 'interrupted',
            interruptedAt: new Date().toISOString(),
          };
        }
        parsed.updatedAt = new Date().toISOString();
        await fs.writeFile(
          runStatePath(parsed.runId),
          JSON.stringify(parsed, null, 2),
          'utf8',
        );
      }
      runs.push(parsed);
    } catch {
      // Ignore malformed files.
    }
  }

  runs.sort((left, right) => {
    const l = new Date(left.updatedAt || left.startedAt || 0).getTime();
    const r = new Date(right.updatedAt || right.startedAt || 0).getTime();
    return r - l;
  });

  return runs.slice(0, limit);
}

class StopRequestedError extends Error {
  constructor(message = 'Run stopped by user.') {
    super(message);
    this.name = 'StopRequestedError';
  }
}

class BudgetLimitError extends Error {
  constructor(message = 'Run stopped at budget limit.') {
    super(message);
    this.name = 'BudgetLimitError';
  }
}

function enforcePerMinuteLimit(hits, limitPerMinute, label) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  while (hits.length > 0 && (now - hits[0]) >= windowMs) {
    hits.shift();
  }
  if (hits.length >= limitPerMinute) {
    // Instead of killing the run, calculate how long to wait
    const oldestInWindow = hits[0];
    const waitMs = windowMs - (now - oldestInWindow) + 100; // +100ms buffer
    return waitMs; // Return ms to sleep; caller should await a delay
  }
  hits.push(now);
  return 0; // No wait needed
}

function registerRunChild(runId, child) {
  const key = String(runId || '').trim();
  if (!key || !child) {
    return;
  }
  if (!activeChildrenByRun.has(key)) {
    activeChildrenByRun.set(key, new Set());
  }
  activeChildrenByRun.get(key).add(child);
}

function unregisterRunChild(runId, child) {
  const key = String(runId || '').trim();
  if (!key || !child) {
    return;
  }
  const set = activeChildrenByRun.get(key);
  if (!set) {
    return;
  }
  set.delete(child);
  if (set.size === 0) {
    activeChildrenByRun.delete(key);
  }
}

function isRunStopRequested(runId) {
  const key = String(runId || '').trim();
  if (!key) {
    return false;
  }
  return stopRequestsByRun.has(key);
}

function getRunStopReason(runId) {
  const key = String(runId || '').trim();
  if (!key) {
    return '';
  }
  return String(stopRequestsByRun.get(key) || '');
}

function requestRunStop(runId, reason = 'Stopped by user request.') {
  const key = String(runId || '').trim();
  if (!key) {
    return false;
  }
  stopRequestsByRun.set(key, reason);
  const children = activeChildrenByRun.get(key);
  if (children && children.size > 0) {
    for (const child of children) {
      try {
        if (child && !child.killed) {
          child.kill('SIGTERM');
        }
      } catch {
        // Ignore kill errors.
      }
    }
  }
  return true;
}

function clearRunStopRequest(runId) {
  const key = String(runId || '').trim();
  if (!key) {
    return;
  }
  stopRequestsByRun.delete(key);
}

function throwIfRunStopped(runId) {
  if (!isRunStopRequested(runId)) {
    return;
  }
  throw new StopRequestedError(getRunStopReason(runId) || 'Run stopped by user request.');
}

module.exports = {
  RUNS_DIR,
  activeRunIds,
  stopRequestsByRun,
  activeChildrenByRun,
  runStateDir,
  runStatePath,
  runDebugLogPath,
  appendRunDebugEvent,
  persistRunState,
  readRunState,
  summarizeRunForList,
  classifyReviewAction,
  buildWorkflowView,
  listRunStates,
  StopRequestedError,
  BudgetLimitError,
  enforcePerMinuteLimit,
  registerRunChild,
  unregisterRunChild,
  isRunStopRequested,
  getRunStopReason,
  requestRunStop,
  clearRunStopRequest,
  throwIfRunStopped,
};
