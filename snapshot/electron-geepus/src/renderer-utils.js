/**
 * renderer-utils.js — Small utility functions used across the renderer.
 *
 * Depends on: renderer-state.js (state, el, DEFAULT_RUN_LIMITS, LOCAL_RUN_LIMITS, runLimitsSaveTimer)
 */

function setStatus(message) {
  el.statusLine.textContent = message;
  if (typeof renderMissionControl === 'function') {
    renderMissionControl();
  }
}

function renderMissionControl() {
  const selectedThread = typeof currentThread === 'function' ? currentThread() : null;
  const selectedRun = typeof currentThreadRun === 'function' ? currentThreadRun() : null;
  const anyActiveRun = Array.isArray(state.runs)
    ? state.runs.find((run) => run.state === 'running' || run.state === 'paused_approval' || run.state === 'needs_info')
    : null;
  if (el.missionStatusLine) {
    let status = String(el.statusLine?.textContent || '').trim() || 'Ready for your next instruction.';
    if (!state.working && !selectedRun && selectedThread && !selectedThread.latestRunId && !selectedThread.resumeRunId && anyActiveRun) {
      status = 'Fresh thread selected. Another task is still active in a different thread.';
    }
    el.missionStatusLine.textContent = status;
  }

  if (el.missionWorkspaceLine) {
    const workspace = String(state.workspaceRoot || '').trim();
    el.missionWorkspaceLine.textContent = workspace
      ? `Workspace: ${workspace}`
      : 'Workspace: Auto-discovering context.';
  }

  if (el.missionModelLine) {
    const providerLabel = state.provider === 'ollama' ? 'Ollama' : state.provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
    const model = String(state.model || '').trim();
    el.missionModelLine.textContent = model
      ? `Model: ${providerLabel} • ${model}`
      : `Model: ${providerLabel} • auto-select pending`;
  }

  if (el.missionModePill) {
    const mode = String(state.interactionMode || 'auto').trim().toLowerCase();
    const label = mode === 'research' ? 'Research' : mode === 'action' ? 'Action' : 'Auto';
    el.missionModePill.textContent = `${label} mode`;
  }

  if (el.missionConnectionPill) {
    const isConnected = Boolean(state.apiKeyPresent) || state.provider === 'ollama';
    el.missionConnectionPill.textContent = isConnected ? (state.provider === 'ollama' ? 'Local core' : 'Connected') : 'Offline';
    el.missionConnectionPill.classList.toggle('live', isConnected);
  }

  if (el.missionRunPill) {
    const active = selectedRun || anyActiveRun;
    let label = 'Idle';
    if (selectedRun?.state === 'running') label = 'Running';
    else if (selectedRun?.state === 'paused_approval') label = 'Needs approval';
    else if (selectedRun?.state === 'needs_info') label = 'Needs input';
    else if (!selectedRun && selectedThread && !selectedThread.latestRunId && !selectedThread.resumeRunId) label = 'Idle';
    else if (active?.state === 'running') label = 'Running';
    else if (active?.state === 'paused_approval') label = 'Needs approval';
    else if (active?.state === 'needs_info') label = 'Needs input';
    else if (state.working) label = 'Working';
    el.missionRunPill.textContent = label;
    el.missionRunPill.classList.toggle('live', label !== 'Idle');
  }
}

function normalizeRunLimits(raw) {
  const isLocal = state.provider === 'ollama';
  const defaults = isLocal ? LOCAL_RUN_LIMITS : DEFAULT_RUN_LIMITS;
  const next = raw && typeof raw === 'object' ? raw : {};
  const value = (key) => Number(next[key] ?? defaults[key]);
  const clamp = (num, min, max, fallback) => {
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(num)));
  };
  return {
    maxIterations: clamp(value('maxIterations'), 1, isLocal ? 9999 : 120, defaults.maxIterations),
    maxRuntimeMinutes: clamp(value('maxRuntimeMinutes'), 1, isLocal ? 14400 : 720, defaults.maxRuntimeMinutes),
    maxActions: clamp(value('maxActions'), 1, isLocal ? 99999 : 4000, defaults.maxActions),
    maxModelCallsPerMinute: clamp(value('maxModelCallsPerMinute'), 1, isLocal ? 9999 : 240, defaults.maxModelCallsPerMinute),
    maxToolCallsPerMinute: clamp(value('maxToolCallsPerMinute'), 1, isLocal ? 9999 : 480, defaults.maxToolCallsPerMinute),
    idleTimeoutSeconds: clamp(value('idleTimeoutSeconds'), 30, isLocal ? 3600 : 1800, defaults.idleTimeoutSeconds),
    consecutiveDriftLimit: clamp(value('consecutiveDriftLimit'), 1, isLocal ? 50 : 20, defaults.consecutiveDriftLimit),
  };
}

function applyRunLimitsToInputs(limits) {
  const next = normalizeRunLimits(limits);
  state.runLimits = next;
  el.limitMaxRuntimeMinutes.value = String(next.maxRuntimeMinutes);
  el.limitMaxIterations.value = String(next.maxIterations);
  el.limitMaxActions.value = String(next.maxActions);
  el.limitMaxModelCallsPerMinute.value = String(next.maxModelCallsPerMinute);
  el.limitMaxToolCallsPerMinute.value = String(next.maxToolCallsPerMinute);
  el.limitIdleTimeoutSeconds.value = String(next.idleTimeoutSeconds);
  el.limitConsecutiveDriftLimit.value = String(next.consecutiveDriftLimit);
  if (el.limitBudgetLimit) {
    el.limitBudgetLimit.value = String(next.budgetLimit || 0);
  }
}

function readRunLimitsFromInputs() {
  return normalizeRunLimits({
    maxRuntimeMinutes: el.limitMaxRuntimeMinutes.value,
    maxIterations: el.limitMaxIterations.value,
    maxActions: el.limitMaxActions.value,
    maxModelCallsPerMinute: el.limitMaxModelCallsPerMinute.value,
    maxToolCallsPerMinute: el.limitMaxToolCallsPerMinute.value,
    idleTimeoutSeconds: el.limitIdleTimeoutSeconds.value,
    consecutiveDriftLimit: el.limitConsecutiveDriftLimit.value,
    budgetLimit: el.limitBudgetLimit ? el.limitBudgetLimit.value : 0,
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function makeId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatRunTimestamp(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString();
}

function formatRelativeTime(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const deltaMs = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (deltaMs < minute) return 'just now';
  if (deltaMs < hour) return `${Math.max(1, Math.floor(deltaMs / minute))}m ago`;
  if (deltaMs < day) return `${Math.max(1, Math.floor(deltaMs / hour))}h ago`;
  return `${Math.max(1, Math.floor(deltaMs / day))}d ago`;
}

function shortText(value, max = 280) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 3))}...`;
}

function hardFocusPrompt() {
  if (document.activeElement !== el.promptInput) {
    el.promptInput.focus({ preventScroll: true });
    el.promptInput.setSelectionRange(el.promptInput.value.length, el.promptInput.value.length);
  }
}

function installFocusGuards() {
  const retry = () => {
    setTimeout(hardFocusPrompt, 40);
    setTimeout(hardFocusPrompt, 140);
    setTimeout(hardFocusPrompt, 320);
  };

  window.addEventListener('focus', retry);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      retry();
    }
  });

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      hardFocusPrompt();
    }
  });

  const askCard = document.getElementById('askCard');
  askCard.addEventListener('pointerdown', (event) => {
    const target = event.target;
    const isInteractive = target instanceof HTMLElement
      && Boolean(target.closest('button, input, textarea, select, option, summary, details, a, [role="button"]'));
    if (!isInteractive) {
      requestAnimationFrame(hardFocusPrompt);
    }
  });

  retry();
}

function scheduleRunLimitsSave() {
  state.runLimits = readRunLimitsFromInputs();
  if (runLimitsSaveTimer) {
    window.clearTimeout(runLimitsSaveTimer);
    runLimitsSaveTimer = null;
  }
  runLimitsSaveTimer = window.setTimeout(async () => {
    try {
      await saveSettingsPatch({ runLimits: state.runLimits });
      setStatus('Run limits updated.');
    } catch (error) {
      setStatus(error.message || String(error));
    } finally {
      runLimitsSaveTimer = null;
    }
  }, 200);
}
