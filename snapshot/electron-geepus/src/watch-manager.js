'use strict';

const path = require('path');
const { BrowserWindow } = require('electron');

const { DEFAULT_PROVIDER } = require('./providers');
const { normalizeExecutionMode } = require('./settings');
const { normalizeOwner, inferOwnerFromAction, ownerLabel } = require('./team');
const { TEAM_OWNER_ORDER, RESEARCH_TEAM_OWNER_ORDER } = require('./objective-policy');
const { appendRunDebugEvent } = require('./run-state');

const watchWindows = new Set();
const watchStateByRun = new Map();

// Bring the main Geepus window to the foreground (any non-watch window).
// Called when a run completes so the chat report is visible without
// the user having to manually switch away from the Watch window.
function focusMainWindow() {
  try {
    const main = BrowserWindow.getAllWindows().find((w) => !watchWindows.has(w) && !w.isDestroyed());
    if (main) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
    }
  } catch { /* non-fatal */ }
}

function watchOwners(teamMode = 'teams', executionMode = 'action') {
  const mode = normalizeExecutionMode(executionMode);
  if (mode === 'research') {
    return RESEARCH_TEAM_OWNER_ORDER;
  }
  // 'auto' and 'action' both use full team
  return teamMode === 'solo' ? ['engineering'] : TEAM_OWNER_ORDER;
}

function defaultWatchAgents(teamMode = 'teams', executionMode = 'action') {
  const owners = watchOwners(teamMode, executionMode);
  return owners.reduce((acc, owner) => {
    acc[owner] = {
      label: ownerLabel(owner),
      status: 'idle',
      currentAction: '',
      updatedAt: new Date().toISOString(),
      completedActions: 0,
      failedActions: 0,
    };
    return acc;
  }, {});
}

function syncWatchAgents(watchState) {
  if (!watchState) {
    return;
  }
  const owners = watchOwners(watchState.teamMode, watchState.executionMode);
  const next = {};
  for (const owner of owners) {
    if (watchState.agents && watchState.agents[owner]) {
      next[owner] = watchState.agents[owner];
      continue;
    }
    next[owner] = {
      label: ownerLabel(owner),
      status: 'idle',
      currentAction: '',
      updatedAt: new Date().toISOString(),
      completedActions: 0,
      failedActions: 0,
    };
  }
  watchState.agents = next;
}

function ensureWatchState(runId, seed = {}) {
  if (!runId) {
    return null;
  }
  if (!watchStateByRun.has(runId)) {
    const seedTeamMode = String(seed.teamMode || '').trim().toLowerCase();
    watchStateByRun.set(runId, {
      runId,
      objective: String(seed.objective || ''),
      state: String(seed.state || 'running'),
      provider: String(seed.provider || DEFAULT_PROVIDER),
      model: String(seed.model || ''),
      workspaceRoot: String(seed.workspaceRoot || ''),
      teamMode: seedTeamMode || 'teams',
      executionMode: normalizeExecutionMode(seed.executionMode || 'action'),
      activeLearnedStrategies: Array.isArray(seed.activeLearnedStrategies) ? seed.activeLearnedStrategies.slice(0, 6) : [],
      activeBannedApproaches: Array.isArray(seed.activeBannedApproaches) ? seed.activeBannedApproaches.slice(0, 6) : [],
      agents: defaultWatchAgents(seed.teamMode, seed.executionMode),
      events: [],
      createdAt: seed.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  const current = watchStateByRun.get(runId);
  current.executionMode = normalizeExecutionMode(current.executionMode || seed.executionMode || 'action');
  if (!current.agents || typeof current.agents !== 'object') {
    current.agents = defaultWatchAgents(current.teamMode, current.executionMode);
  }
  syncWatchAgents(current);
  return current;
}

function updateWatchAgentState(watchState, event) {
  if (!watchState) {
    return;
  }
  const fallbackOwner = watchState.executionMode === 'research' ? 'research' : 'engineering';
  const owner = normalizeOwner(event.owner) || fallbackOwner;
  if (!watchState.agents[owner]) {
    watchState.agents[owner] = {
      label: ownerLabel(owner),
      status: 'idle',
      currentAction: '',
      updatedAt: new Date().toISOString(),
      completedActions: 0,
      failedActions: 0,
    };
  }
  const agent = watchState.agents[owner];
  const now = new Date().toISOString();

  if (event.type === 'run_started' || event.type === 'run_resumed') {
    const chief = watchState.agents.chief || agent;
    chief.status = 'working';
    chief.currentAction = String(event.summary || 'Orchestrating task run.').trim();
    chief.updatedAt = now;
    return;
  }
  if (event.type === 'planning_started') {
    const chief = watchState.agents.chief || agent;
    chief.status = 'planning';
    chief.currentAction = String(event.summary || 'Planning in progress.').trim();
    chief.updatedAt = now;
    return;
  }
  if (event.type === 'planning_completed') {
    const chief = watchState.agents.chief || agent;
    chief.status = 'working';
    chief.currentAction = String(event.summary || 'Plan ready — starting execution.').trim();
    chief.updatedAt = now;
    return;
  }
  if (event.type === 'evaluating_completion') {
    const chief = watchState.agents.chief || agent;
    chief.status = 'working';
    chief.currentAction = String(event.summary || 'Verifying objective is complete...');
    chief.updatedAt = now;
    return;
  }
  if (event.type === 'acceptance_review') {
    const chief = watchState.agents.chief || agent;
    chief.status = 'working';
    chief.currentAction = String(event.summary || 'Reviewing final output...').trim();
    chief.updatedAt = now;
    return;
  }
  if (event.type === 'progress_check' || event.type === 'iteration_update') {
    const chief = watchState.agents.chief || agent;
    chief.status = 'working';
    chief.currentAction = String(event.summary || 'Tracking native runtime progress...').trim();
    chief.updatedAt = now;
    return;
  }
  if (event.type === 'team_brief_started') {
    agent.status = 'planning';
    agent.currentAction = String(event.summary || 'Preparing guidance.').trim();
    agent.updatedAt = now;
    return;
  }
  if (event.type === 'research_pivot') {
    const research = watchState.agents.research || watchState.agents.chief || agent;
    research.status = 'working';
    research.currentAction = String(event.summary || 'Researching alternative approach.').trim();
    research.updatedAt = now;
    return;
  }
  if (event.type === 'team_brief') {
    agent.status = 'planning';
    agent.currentAction = String(event.summary || '').trim();
    agent.updatedAt = now;
    return;
  }
  if (event.type === 'team_brief_failed') {
    agent.status = 'blocked';
    agent.currentAction = String(event.summary || 'Team brief failed.').trim();
    agent.updatedAt = now;
    agent.failedActions += 1;
    return;
  }
  if (event.type === 'team_brief_skipped') {
    agent.status = 'idle';
    agent.currentAction = String(event.summary || 'Not needed for this objective.').trim();
    agent.updatedAt = now;
    return;
  }
  if (event.type === 'login_required') {
    agent.status = 'awaiting_login';
    agent.currentAction = String(event.summary || 'Waiting for you to log in in the browser window.').trim();
    agent.updatedAt = now;
    return;
  }
  if (event.type === 'login_completed') {
    agent.status = 'working';
    agent.currentAction = String(event.summary || 'Login completed. Continuing task.').trim();
    agent.updatedAt = now;
    return;
  }
  if (event.type === 'heartbeat') {
    const chief = watchState.agents.chief || agent;
    if (chief.status === 'idle') {
      chief.status = 'working';
    }
    chief.currentAction = String(event.summary || chief.currentAction || 'Working...').trim();
    chief.updatedAt = now;
    return;
  }
  if (event.type === 'action_started') {
    agent.status = 'working';
    agent.currentAction = String(event.intent || '').trim();
    agent.updatedAt = now;
    return;
  }
  if (event.type === 'delegate_started') {
    agent.status = 'working';
    agent.currentAction = String(event.task || 'Consulting specialist...').trim();
    agent.updatedAt = now;
    return;
  }
  if (event.type === 'delegate_finished') {
    agent.status = event.ok ? 'idle' : 'blocked';
    agent.currentAction = event.ok ? '' : String(event.summary || '').trim();
    agent.updatedAt = now;
    if (event.ok) {
      agent.completedActions += 1;
    } else {
      agent.failedActions += 1;
    }
    return;
  }
  if (event.type === 'action_finished') {
    agent.status = event.ok ? 'idle' : 'blocked';
    agent.currentAction = event.ok ? '' : String(event.summary || event.intent || '').trim();
    agent.updatedAt = now;
    if (event.ok) {
      agent.completedActions += 1;
    } else {
      agent.failedActions += 1;
    }
    return;
  }
  if (event.type === 'run_paused') {
    Object.values(watchState.agents).forEach((item) => {
      item.status = 'paused';
      item.updatedAt = now;
    });
    return;
  }
  if (event.type === 'run_stop_requested') {
    Object.values(watchState.agents).forEach((item) => {
      item.status = 'paused';
      item.updatedAt = now;
    });
    if (watchState.agents.chief) {
      watchState.agents.chief.currentAction = String(event.summary || 'Stopping task...').trim();
    }
    return;
  }
  if (event.type === 'run_finished') {
    Object.values(watchState.agents).forEach((item) => {
      item.status = watchState.state === 'completed' ? 'done' : (watchState.state === 'paused_approval' ? 'paused' : 'idle');
      item.currentAction = '';
      item.updatedAt = now;
    });
    if (event.report) watchState.completionReport = String(event.report);
  }
}

function appendWatchEvent(runId, event, seed = {}) {
  const watchState = ensureWatchState(runId, seed);
  if (!watchState) {
    return null;
  }

  watchState.objective = String(seed.objective || watchState.objective || '');
  watchState.state = String(seed.state || watchState.state || 'running');
  watchState.provider = String(seed.provider || watchState.provider || DEFAULT_PROVIDER);
  watchState.model = String(seed.model || watchState.model || '');
  watchState.workspaceRoot = String(seed.workspaceRoot || watchState.workspaceRoot || '');
  const nextTeamMode = String(seed.teamMode || watchState.teamMode || 'teams').trim().toLowerCase();
  watchState.teamMode = nextTeamMode || 'teams';
  watchState.executionMode = normalizeExecutionMode(seed.executionMode || watchState.executionMode || 'action');
  if (seed.activeSkillName !== undefined) watchState.activeSkillName = seed.activeSkillName || null;
  if (seed.activeLearnedStrategies !== undefined) {
    watchState.activeLearnedStrategies = Array.isArray(seed.activeLearnedStrategies) ? seed.activeLearnedStrategies.slice(0, 6) : [];
  }
  if (seed.activeBannedApproaches !== undefined) {
    watchState.activeBannedApproaches = Array.isArray(seed.activeBannedApproaches) ? seed.activeBannedApproaches.slice(0, 6) : [];
  }
  syncWatchAgents(watchState);
  watchState.updatedAt = new Date().toISOString();

  const payload = {
    ts: new Date().toISOString(),
    runId,
    ...event,
  };

  // Heartbeats update agent state (Chief card) but don't clutter the timeline.
  // This prevents heartbeat spam from wiping out useful action/planning events.
  if (event.type !== 'heartbeat') {
    watchState.events.push(payload);
    if (watchState.events.length > 600) {
      watchState.events = watchState.events.slice(-600);
    }
  }

  updateWatchAgentState(watchState, payload);
  watchStateByRun.set(runId, watchState);
  return payload;
}

function broadcastWatchEvent(runId, event, seed = {}) {
  const payload = appendWatchEvent(runId, event, seed);
  if (!payload) {
    return;
  }
  appendRunDebugEvent(runId, `watch:${String(payload.type || 'event')}`, {
    summary: payload.summary || '',
    detail: payload.detail || '',
    iteration: Number(payload.iteration || 0),
    owner: payload.owner || '',
    status: payload.status || '',
    state: payload.state || '',
  }).catch(() => {});
  for (const win of watchWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send('watch:update', payload);
    }
  }
}

function startWatchHeartbeat(runId, seed = {}, summary = 'Working...', intervalMs = 5000) {
  if (!runId) {
    return () => {};
  }
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    const text = typeof summary === 'function' ? summary(tick) : String(summary || 'Working...');
    broadcastWatchEvent(runId, {
      type: 'heartbeat',
      owner: 'chief',
      summary: text,
    }, seed);
  }, Math.max(1500, intervalMs));

  return () => {
    clearInterval(timer);
  };
}

function watchSnapshot(runId) {
  const current = watchStateByRun.get(runId);
  if (!current) {
    return null;
  }
  return {
    runId: current.runId,
    objective: current.objective,
    state: current.state,
    provider: current.provider,
    model: current.model,
    workspaceRoot: current.workspaceRoot,
    teamMode: current.teamMode,
    executionMode: current.executionMode,
    activeSkillName: current.activeSkillName || null,
    activeLearnedStrategies: Array.isArray(current.activeLearnedStrategies) ? current.activeLearnedStrategies.slice(0, 6) : [],
    activeBannedApproaches: Array.isArray(current.activeBannedApproaches) ? current.activeBannedApproaches.slice(0, 6) : [],
    completionReport: current.completionReport || null,
    agents: current.agents,
    events: current.events.slice(-300),
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
  };
}

function hydrateWatchFromRunState(runState) {
  const runId = String(runState?.runId || '');
  if (!runId) {
    return null;
  }
  const watchState = ensureWatchState(runId, {
    objective: runState.objective,
    state: runState.state,
    provider: runState.provider,
    model: runState.model,
    workspaceRoot: runState.workspaceRoot,
    teamMode: runState.teamMode,
    executionMode: runState.executionMode,
    createdAt: runState.createdAt,
    activeLearnedStrategies: Array.isArray(runState.activeLearnedStrategies) ? runState.activeLearnedStrategies.slice(0, 6) : [],
    activeBannedApproaches: Array.isArray(runState.activeBannedApproaches) ? runState.activeBannedApproaches.slice(0, 6) : [],
  });
  if (!watchState) {
    return null;
  }

  watchState.events = [];
  watchState.agents = defaultWatchAgents(runState.teamMode, runState.executionMode);
  const iterations = Array.isArray(runState.iterations) ? runState.iterations : [];
  for (const iteration of iterations) {
    const results = Array.isArray(iteration.results) ? iteration.results : [];
    for (const result of results) {
      const owner = normalizeOwner(result.owner) || inferOwnerFromAction(result);
      appendWatchEvent(runId, {
        type: 'action_finished',
        iteration: iteration.iteration,
        owner,
        intent: result.intent,
        tool: result.tool,
        ok: result.ok === true,
        summary: result.summary,
      }, {
        objective: runState.objective,
        state: runState.state,
        provider: runState.provider,
        model: runState.model,
        workspaceRoot: runState.workspaceRoot,
        teamMode: runState.teamMode,
        executionMode: runState.executionMode,
      });
    }
  }

  watchState.state = String(runState.state || watchState.state);
  watchState.objective = String(runState.objective || watchState.objective);
  watchState.provider = String(runState.provider || watchState.provider);
  watchState.model = String(runState.model || watchState.model);
  watchState.workspaceRoot = String(runState.workspaceRoot || watchState.workspaceRoot);
  watchState.executionMode = normalizeExecutionMode(runState.executionMode || watchState.executionMode || 'action');
  syncWatchAgents(watchState);
  watchState.updatedAt = new Date().toISOString();
  watchStateByRun.set(runId, watchState);
  return watchState;
}

function createWatchWindow(runId = '') {
  const win = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    title: 'Watch Geepus Task',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (runId) {
    win.loadFile(path.join(__dirname, 'watch.html'), { query: { runId } });
  } else {
    win.loadFile(path.join(__dirname, 'watch.html'));
  }
  watchWindows.add(win);
  win.on('closed', () => {
    watchWindows.delete(win);
  });
  return win;
}

module.exports = {
  watchWindows,
  watchStateByRun,
  focusMainWindow,
  watchOwners,
  defaultWatchAgents,
  syncWatchAgents,
  ensureWatchState,
  updateWatchAgentState,
  appendWatchEvent,
  broadcastWatchEvent,
  startWatchHeartbeat,
  watchSnapshot,
  hydrateWatchFromRunState,
  createWatchWindow,
};
