/**
 * renderer-scheduler.js — Scheduler and trigger UI interactions.
 *
 * Depends on: renderer-state.js (el — extended below)
 *             renderer-utils.js (setStatus, formatRelativeTime, escapeHtml)
 */

// --- Extend el with scheduler DOM refs ---
el.addScheduledTaskButton = document.getElementById('addScheduledTaskButton');
el.scheduledTaskList = document.getElementById('scheduledTaskList');
el.schedulerForm = document.getElementById('schedulerForm');
el.schedulerFormTitle = document.getElementById('schedulerFormTitle');
el.schedTaskNameInput = document.getElementById('schedTaskNameInput');
el.schedTaskObjectiveInput = document.getElementById('schedTaskObjectiveInput');
el.schedTaskScheduleInput = document.getElementById('schedTaskScheduleInput');
el.schedTaskLoopMode = document.getElementById('schedTaskLoopMode');
el.schedTaskLoopDelayRow = document.getElementById('schedTaskLoopDelayRow');
el.schedTaskLoopDelay = document.getElementById('schedTaskLoopDelay');
el.schedTaskMaxFails = document.getElementById('schedTaskMaxFails');
el.schedTaskWorkspaceInput = document.getElementById('schedTaskWorkspaceInput');
el.schedTaskModeSelect = document.getElementById('schedTaskModeSelect');
el.schedTaskTeamSelect = document.getElementById('schedTaskTeamSelect');
el.schedTaskSaveButton = document.getElementById('schedTaskSaveButton');
el.schedTaskCancelButton = document.getElementById('schedTaskCancelButton');
el.schedTaskEditId = document.getElementById('schedTaskEditId');
el.addTriggerButton = document.getElementById('addTriggerButton');
el.triggerList = document.getElementById('triggerList');
el.triggerForm = document.getElementById('triggerForm');
el.triggerFormTitle = document.getElementById('triggerFormTitle');
el.triggerNameInput = document.getElementById('triggerNameInput');
el.triggerWatchPathInput = document.getElementById('triggerWatchPathInput');
el.triggerPatternInput = document.getElementById('triggerPatternInput');
el.triggerTaskSelect = document.getElementById('triggerTaskSelect');
el.triggerSaveButton = document.getElementById('triggerSaveButton');
el.triggerCancelButton = document.getElementById('triggerCancelButton');
el.triggerEditId = document.getElementById('triggerEditId');

// --- Local state for scheduler UI ---
let schedulerTasks = [];
let schedulerTriggers = [];

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function scheduleLabel(task) {
  if (task.loopMode) {
    const delay = task.loopDelaySeconds || 0;
    return delay > 0 ? `Loop (${delay}s cool-down)` : 'Loop (continuous)';
  }
  const schedule = task.schedule || '';
  if (!schedule) return 'No schedule';
  if (/^every\s+/i.test(schedule)) return schedule;
  return `cron: ${schedule}`;
}

function taskStateLabel(lastRunState) {
  if (!lastRunState) return 'Never run';
  if (lastRunState === 'running') return 'Running';
  if (lastRunState === 'completed') return 'Completed';
  if (lastRunState === 'failed') return 'Failed';
  if (lastRunState === 'paused_approval') return 'Needs approval';
  return lastRunState;
}

function renderScheduledTasks() {
  if (!el.scheduledTaskList) return;
  el.scheduledTaskList.innerHTML = '';

  if (schedulerTasks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'sched-empty';
    empty.textContent = 'No scheduled tasks yet. Click + Task to create one.';
    el.scheduledTaskList.appendChild(empty);
    return;
  }

  schedulerTasks.forEach((task) => {
    const card = document.createElement('div');
    card.className = `sched-task-item${task.enabled ? '' : ' disabled'}`;

    const header = document.createElement('div');
    header.className = 'sched-task-header';

    const name = document.createElement('strong');
    name.textContent = task.name;
    name.className = 'sched-task-name';

    const badge = document.createElement('span');
    badge.className = `sched-badge ${task.enabled ? 'badge-ok' : 'badge-warn'}`;
    badge.textContent = task.enabled ? (task.loopMode ? 'Looping' : 'Active') : 'Paused';

    header.appendChild(name);
    header.appendChild(badge);

    const meta = document.createElement('p');
    meta.className = 'sched-task-meta';
    const parts = [
      scheduleLabel(task),
      taskStateLabel(task.lastRunState),
    ];
    if (task.loopMode && task.loopTotalRuns > 0) {
      parts.push(`Runs: ${task.loopTotalRuns}`);
    }
    if (task.loopMode && task.loopConsecutiveFailures > 0) {
      parts.push(`Fails in a row: ${task.loopConsecutiveFailures}`);
    }
    if (task.nextRunAt) {
      parts.push(`Next: ${formatRelativeTime(task.nextRunAt)}`);
    }
    if (task.lastRunAt) {
      parts.push(`Last: ${formatRelativeTime(task.lastRunAt)}`);
    }
    meta.textContent = parts.join(' • ');

    const objective = document.createElement('p');
    objective.className = 'sched-task-objective';
    objective.textContent = task.objective.length > 100
      ? `${task.objective.slice(0, 97)}...`
      : task.objective;

    const actions = document.createElement('div');
    actions.className = 'sched-task-actions';

    const runNowBtn = document.createElement('button');
    runNowBtn.className = 'btn btn-small';
    runNowBtn.textContent = 'Run Now';
    runNowBtn.disabled = task.lastRunState === 'running';
    runNowBtn.addEventListener('click', () => runScheduledTaskNow(task.id));

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn btn-small';
    toggleBtn.textContent = task.enabled ? 'Pause' : 'Enable';
    toggleBtn.addEventListener('click', () => toggleScheduledTask(task.id, !task.enabled));

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-small';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openScheduledTaskForm(task));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-small';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteScheduledTask(task.id));

    actions.appendChild(runNowBtn);
    actions.appendChild(toggleBtn);
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    card.appendChild(header);
    card.appendChild(meta);
    card.appendChild(objective);
    card.appendChild(actions);
    el.scheduledTaskList.appendChild(card);
  });
}

function renderTriggers() {
  if (!el.triggerList) return;
  el.triggerList.innerHTML = '';

  if (schedulerTriggers.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'sched-empty';
    empty.textContent = 'No triggers yet. Click + Trigger to create one.';
    el.triggerList.appendChild(empty);
    return;
  }

  schedulerTriggers.forEach((trigger) => {
    const card = document.createElement('div');
    card.className = `sched-task-item${trigger.enabled ? '' : ' disabled'}`;

    const header = document.createElement('div');
    header.className = 'sched-task-header';

    const name = document.createElement('strong');
    name.textContent = trigger.name;
    name.className = 'sched-task-name';

    const badge = document.createElement('span');
    badge.className = `sched-badge ${trigger.enabled ? 'badge-ok' : 'badge-warn'}`;
    badge.textContent = trigger.enabled ? 'Watching' : 'Paused';

    header.appendChild(name);
    header.appendChild(badge);

    const meta = document.createElement('p');
    meta.className = 'sched-task-meta';
    const linkedTask = schedulerTasks.find((t) => t.id === trigger.taskId);
    const taskLabel = linkedTask ? linkedTask.name : '(unknown task)';
    const parts = [
      `Watch: ${trigger.watchPath || '(none)'}`,
      `Pattern: ${trigger.pattern}`,
      `Task: ${taskLabel}`,
    ];
    if (trigger.lastFiredAt) {
      parts.push(`Last fired: ${formatRelativeTime(trigger.lastFiredAt)}`);
    }
    if (trigger.firedCount > 0) {
      parts.push(`Fired ${trigger.firedCount}x`);
    }
    meta.textContent = parts.join(' • ');

    const actions = document.createElement('div');
    actions.className = 'sched-task-actions';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn btn-small';
    toggleBtn.textContent = trigger.enabled ? 'Pause' : 'Enable';
    toggleBtn.addEventListener('click', () => toggleTrigger(trigger.id, !trigger.enabled));

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-small';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openTriggerForm(trigger));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-small';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteTrigger(trigger.id));

    actions.appendChild(toggleBtn);
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    card.appendChild(header);
    card.appendChild(meta);
    card.appendChild(actions);
    el.triggerList.appendChild(card);
  });
}

function populateTriggerTaskSelect() {
  if (!el.triggerTaskSelect) return;
  el.triggerTaskSelect.innerHTML = '';
  if (schedulerTasks.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Create a scheduled task first';
    el.triggerTaskSelect.appendChild(opt);
    return;
  }
  schedulerTasks.forEach((task) => {
    const opt = document.createElement('option');
    opt.value = task.id;
    opt.textContent = task.name;
    el.triggerTaskSelect.appendChild(opt);
  });
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function refreshSchedulerData() {
  try {
    schedulerTasks = await window.geepus.listScheduledTasks();
    schedulerTriggers = await window.geepus.listTriggers();
  } catch {
    schedulerTasks = [];
    schedulerTriggers = [];
  }
  renderScheduledTasks();
  renderTriggers();
}

// ---------------------------------------------------------------------------
// Scheduled Task form
// ---------------------------------------------------------------------------

function openScheduledTaskForm(existingTask) {
  const editing = existingTask && existingTask.id;
  el.schedulerFormTitle.textContent = editing ? 'Edit Scheduled Task' : 'New Scheduled Task';
  el.schedTaskEditId.value = editing ? existingTask.id : '';
  el.schedTaskNameInput.value = editing ? existingTask.name : '';
  el.schedTaskObjectiveInput.value = editing ? existingTask.objective : '';
  el.schedTaskScheduleInput.value = editing ? (existingTask.loopMode ? '' : existingTask.schedule) : '';
  el.schedTaskWorkspaceInput.value = editing ? existingTask.workspaceRoot : '';
  el.schedTaskModeSelect.value = editing ? existingTask.executionMode : 'action';
  el.schedTaskTeamSelect.value = editing ? existingTask.teamMode : 'teams';
  if (el.schedTaskLoopMode) {
    const isLoop = editing ? Boolean(existingTask.loopMode) : false;
    el.schedTaskLoopMode.checked = isLoop;
    if (el.schedTaskLoopDelay) el.schedTaskLoopDelay.value = editing ? (existingTask.loopDelaySeconds || 0) : 0;
    if (el.schedTaskMaxFails) el.schedTaskMaxFails.value = editing ? (existingTask.maxConsecutiveFailures ?? 3) : 3;
    if (el.schedTaskLoopDelayRow) el.schedTaskLoopDelayRow.style.display = isLoop ? '' : 'none';
  }
  el.schedulerForm.hidden = false;
  el.schedTaskNameInput.focus({ preventScroll: true });
}

function closeScheduledTaskForm() {
  el.schedulerForm.hidden = true;
  el.schedTaskEditId.value = '';
}

async function saveScheduledTaskFromForm() {
  const name = el.schedTaskNameInput.value.trim();
  const objective = el.schedTaskObjectiveInput.value.trim();
  const schedule = el.schedTaskScheduleInput.value.trim();
  const workspaceRoot = el.schedTaskWorkspaceInput.value.trim();
  const executionMode = el.schedTaskModeSelect.value;
  const teamMode = el.schedTaskTeamSelect.value;
  const editId = el.schedTaskEditId.value.trim();
  const loopMode = el.schedTaskLoopMode ? el.schedTaskLoopMode.checked : false;
  const loopDelaySeconds = el.schedTaskLoopDelay ? Number(el.schedTaskLoopDelay.value) || 0 : 0;
  const maxConsecutiveFailures = el.schedTaskMaxFails ? Number(el.schedTaskMaxFails.value) ?? 3 : 3;

  if (!name) { setStatus('Task needs a name.'); return; }
  if (!objective) { setStatus('Task needs an objective.'); return; }
  if (!loopMode && !schedule) { setStatus('Task needs a schedule (cron or interval) — or enable Loop mode.'); return; }

  const taskData = { name, objective, schedule, workspaceRoot, executionMode, teamMode, loopMode, loopDelaySeconds, maxConsecutiveFailures };

  try {
    if (editId) {
      await window.geepus.updateScheduledTask(editId, taskData);
      setStatus(`Updated scheduled task "${name}".`);
    } else {
      await window.geepus.addScheduledTask(taskData);
      setStatus(`Created scheduled task "${name}".`);
    }
    closeScheduledTaskForm();
    await refreshSchedulerData();
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function deleteScheduledTask(taskId) {
  try {
    await window.geepus.removeScheduledTask(taskId);
    setStatus('Scheduled task removed.');
    await refreshSchedulerData();
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function toggleScheduledTask(taskId, enabled) {
  try {
    await window.geepus.updateScheduledTask(taskId, { enabled });
    setStatus(enabled ? 'Task enabled.' : 'Task paused.');
    await refreshSchedulerData();
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function runScheduledTaskNow(taskId) {
  try {
    setStatus('Running scheduled task now...');
    await window.geepus.runScheduledTaskNow(taskId);
    setStatus('Scheduled task completed.');
    await refreshSchedulerData();
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

// ---------------------------------------------------------------------------
// Trigger form
// ---------------------------------------------------------------------------

function openTriggerForm(existingTrigger) {
  const editing = existingTrigger && existingTrigger.id;
  populateTriggerTaskSelect();
  el.triggerFormTitle.textContent = editing ? 'Edit File Trigger' : 'New File Trigger';
  el.triggerEditId.value = editing ? existingTrigger.id : '';
  el.triggerNameInput.value = editing ? existingTrigger.name : '';
  el.triggerWatchPathInput.value = editing ? existingTrigger.watchPath : '';
  el.triggerPatternInput.value = editing ? existingTrigger.pattern : '*';
  if (editing && existingTrigger.taskId) {
    el.triggerTaskSelect.value = existingTrigger.taskId;
  }
  el.triggerForm.hidden = false;
  el.triggerNameInput.focus({ preventScroll: true });
}

function closeTriggerForm() {
  el.triggerForm.hidden = true;
  el.triggerEditId.value = '';
}

async function saveTriggerFromForm() {
  const name = el.triggerNameInput.value.trim();
  const watchPath = el.triggerWatchPathInput.value.trim();
  const pattern = el.triggerPatternInput.value.trim() || '*';
  const taskId = el.triggerTaskSelect.value;
  const editId = el.triggerEditId.value.trim();

  if (!name) { setStatus('Trigger needs a name.'); return; }
  if (!watchPath) { setStatus('Trigger needs a watch directory.'); return; }
  if (!taskId) { setStatus('Trigger needs a linked task. Create a scheduled task first.'); return; }

  try {
    if (editId) {
      await window.geepus.updateTrigger(editId, { name, watchPath, pattern, taskId });
      setStatus(`Updated trigger "${name}".`);
    } else {
      await window.geepus.addTrigger({ name, watchPath, pattern, taskId });
      setStatus(`Created trigger "${name}".`);
    }
    closeTriggerForm();
    await refreshSchedulerData();
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function deleteTrigger(triggerId) {
  try {
    await window.geepus.removeTrigger(triggerId);
    setStatus('Trigger removed.');
    await refreshSchedulerData();
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function toggleTrigger(triggerId, enabled) {
  try {
    await window.geepus.updateTrigger(triggerId, { enabled });
    setStatus(enabled ? 'Trigger enabled.' : 'Trigger paused.');
    await refreshSchedulerData();
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

// ---------------------------------------------------------------------------
// Event wiring (called from renderer.js installEvents)
// ---------------------------------------------------------------------------

function installSchedulerEvents() {
  el.addScheduledTaskButton.addEventListener('click', () => {
    openScheduledTaskForm(null);
  });
  el.schedTaskSaveButton.addEventListener('click', () => {
    saveScheduledTaskFromForm().catch((error) => {
      setStatus(error.message || String(error));
    });
  });
  el.schedTaskCancelButton.addEventListener('click', () => {
    closeScheduledTaskForm();
  });

  // Toggle cool-down row visibility when Loop mode checkbox changes
  if (el.schedTaskLoopMode && el.schedTaskLoopDelayRow) {
    el.schedTaskLoopMode.addEventListener('change', () => {
      el.schedTaskLoopDelayRow.style.display = el.schedTaskLoopMode.checked ? '' : 'none';
    });
  }

  el.addTriggerButton.addEventListener('click', () => {
    populateTriggerTaskSelect();
    openTriggerForm(null);
  });
  el.triggerSaveButton.addEventListener('click', () => {
    saveTriggerFromForm().catch((error) => {
      setStatus(error.message || String(error));
    });
  });
  el.triggerCancelButton.addEventListener('click', () => {
    closeTriggerForm();
  });
}
