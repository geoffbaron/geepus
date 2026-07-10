/**
 * renderer-pipelines.js — Pipeline (multi-step workflow) UI interactions.
 *
 * Depends on: renderer-state.js (el), renderer-utils.js (setStatus, formatRelativeTime)
 */

// --- Extend el with pipeline DOM refs ---
el.addPipelineButton = document.getElementById('addPipelineButton');
el.pipelineList = document.getElementById('pipelineList');
el.pipelineForm = document.getElementById('pipelineForm');
el.pipelineFormTitle = document.getElementById('pipelineFormTitle');
el.pipelineNameInput = document.getElementById('pipelineNameInput');
el.pipelineDescInput = document.getElementById('pipelineDescInput');
el.pipelineStepsContainer = document.getElementById('pipelineStepsContainer');
el.pipelineAddStepButton = document.getElementById('pipelineAddStepButton');
el.pipelineSaveButton = document.getElementById('pipelineSaveButton');
el.pipelineCancelButton = document.getElementById('pipelineCancelButton');
el.pipelineEditId = document.getElementById('pipelineEditId');
el.pipelineRunList = document.getElementById('pipelineRunList');
el.refreshPipelineRunsButton = document.getElementById('refreshPipelineRunsButton');

// --- Local state ---
let pipelineTemplates = [];
let pipelineRuns = [];
let editingSteps = []; // steps currently in the form

// ---------------------------------------------------------------------------
// Step form builder (dynamic steps inside the pipeline form)
// ---------------------------------------------------------------------------

function createStepRow(step, index) {
  const row = document.createElement('div');
  row.className = 'pipeline-step-row';
  row.dataset.index = index;

  row.innerHTML = `
    <div class="pipeline-step-header">
      <strong>Step ${index + 1}</strong>
      <button class="btn btn-small pipeline-remove-step" type="button">&times;</button>
    </div>
    <div class="sched-form-row">
      <input type="text" class="step-name-input" placeholder="Step name" value="${escapeAttr(step.name || '')}" />
    </div>
    <div class="sched-form-row">
      <textarea class="step-objective-input" rows="2" placeholder="Objective for this step">${escapeAttr(step.objective || '')}</textarea>
    </div>
    <div class="sched-form-row" style="display:flex;gap:6px;">
      <label style="flex:1">
        Mode
        <select class="step-mode-select">
          <option value="action" ${step.executionMode === 'action' ? 'selected' : ''}>Action</option>
          <option value="research" ${step.executionMode === 'research' ? 'selected' : ''}>Research</option>
          <option value="auto" ${step.executionMode === 'auto' ? 'selected' : ''}>Auto</option>
        </select>
      </label>
      <label style="flex:1">
        Style
        <select class="step-team-select">
          <option value="teams" ${step.teamMode !== 'solo' ? 'selected' : ''}>Team</option>
          <option value="solo" ${step.teamMode === 'solo' ? 'selected' : ''}>Solo</option>
        </select>
      </label>
    </div>
    <div class="sched-form-row">
      <input type="text" class="step-workspace-input" placeholder="Workspace (optional)" value="${escapeAttr(step.workspaceRoot || '')}" />
    </div>
    <div class="sched-form-row" style="display:flex;gap:8px;align-items:center;">
      <label style="display:flex;gap:4px;align-items:center;">
        <input type="checkbox" class="step-approval-check" ${step.requiresApproval ? 'checked' : ''} />
        Requires approval
      </label>
      <label style="flex:1">
        Condition
        <select class="step-condition-select">
          <option value="previous_success" ${step.condition !== 'always' && step.condition !== 'previous_failure' ? 'selected' : ''}>Previous succeeds</option>
          <option value="always" ${step.condition === 'always' ? 'selected' : ''}>Always run</option>
          <option value="previous_failure" ${step.condition === 'previous_failure' ? 'selected' : ''}>Previous fails</option>
        </select>
      </label>
    </div>
  `;

  row.querySelector('.pipeline-remove-step').addEventListener('click', () => {
    editingSteps.splice(index, 1);
    renderStepsInForm();
  });

  return row;
}

function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function collectStepsFromForm() {
  const rows = el.pipelineStepsContainer.querySelectorAll('.pipeline-step-row');
  const steps = [];
  rows.forEach((row, i) => {
    steps.push({
      index: i,
      name: row.querySelector('.step-name-input').value.trim(),
      objective: row.querySelector('.step-objective-input').value.trim(),
      executionMode: row.querySelector('.step-mode-select').value,
      teamMode: row.querySelector('.step-team-select').value,
      workspaceRoot: row.querySelector('.step-workspace-input').value.trim(),
      requiresApproval: row.querySelector('.step-approval-check').checked,
      condition: row.querySelector('.step-condition-select').value,
    });
  });
  return steps;
}

function renderStepsInForm() {
  el.pipelineStepsContainer.innerHTML = '';
  editingSteps.forEach((step, i) => {
    el.pipelineStepsContainer.appendChild(createStepRow(step, i));
  });
}

// ---------------------------------------------------------------------------
// Pipeline template rendering
// ---------------------------------------------------------------------------

function renderPipelineList() {
  el.pipelineList.innerHTML = '';

  if (pipelineTemplates.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'sched-empty';
    empty.textContent = 'No pipelines yet. Click + Pipeline to create one.';
    el.pipelineList.appendChild(empty);
    return;
  }

  pipelineTemplates.forEach((pipeline) => {
    const card = document.createElement('div');
    card.className = 'sched-task-item';

    const header = document.createElement('div');
    header.className = 'sched-task-header';

    const name = document.createElement('strong');
    name.className = 'sched-task-name';
    name.textContent = pipeline.name;

    const badge = document.createElement('span');
    badge.className = 'sched-badge badge-ok';
    badge.textContent = `${pipeline.stepCount} step${pipeline.stepCount !== 1 ? 's' : ''}`;

    header.appendChild(name);
    header.appendChild(badge);

    const desc = document.createElement('p');
    desc.className = 'sched-task-objective';
    desc.textContent = pipeline.description || '(no description)';

    const actions = document.createElement('div');
    actions.className = 'sched-task-actions';

    const runBtn = document.createElement('button');
    runBtn.className = 'btn btn-small';
    runBtn.textContent = 'Run';
    runBtn.addEventListener('click', () => startPipeline(pipeline.id));

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-small';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openPipelineForm(pipeline.id));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-small';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deletePipeline(pipeline.id));

    actions.appendChild(runBtn);
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    card.appendChild(header);
    card.appendChild(desc);
    card.appendChild(actions);
    el.pipelineList.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// Pipeline run rendering
// ---------------------------------------------------------------------------

function stepStateIcon(state) {
  switch (state) {
    case 'completed': return '\u2705';
    case 'failed': return '\u274c';
    case 'running': return '\u23f3';
    case 'waiting_approval': return '\u270b';
    case 'skipped': return '\u23ed\ufe0f';
    default: return '\u25cb';
  }
}

function renderPipelineRuns() {
  el.pipelineRunList.innerHTML = '';

  if (pipelineRuns.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'sched-empty';
    empty.textContent = 'No pipeline runs yet.';
    el.pipelineRunList.appendChild(empty);
    return;
  }

  pipelineRuns.slice(0, 20).forEach((run) => {
    const card = document.createElement('div');
    card.className = 'sched-task-item';

    const header = document.createElement('div');
    header.className = 'sched-task-header';

    const name = document.createElement('strong');
    name.className = 'sched-task-name';
    name.textContent = run.pipelineName || 'Pipeline';

    const badge = document.createElement('span');
    const badgeClass = run.state === 'completed' ? 'badge-ok'
      : run.state === 'paused' ? 'badge-warn'
      : run.state === 'failed' ? 'badge-warn'
      : 'badge-ok';
    badge.className = `sched-badge ${badgeClass}`;
    badge.textContent = run.state;

    header.appendChild(name);
    header.appendChild(badge);

    const meta = document.createElement('p');
    meta.className = 'sched-task-meta';
    meta.textContent = `Step ${run.currentStepIndex}/${run.totalSteps} \u2022 ${formatRelativeTime(run.updatedAt)}`;

    const actions = document.createElement('div');
    actions.className = 'sched-task-actions';

    if (run.state === 'paused') {
      const approveBtn = document.createElement('button');
      approveBtn.className = 'btn btn-small';
      approveBtn.textContent = 'Approve & Continue';
      approveBtn.addEventListener('click', () => approvePipeline(run.id));
      actions.appendChild(approveBtn);

      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'btn btn-small';
      rejectBtn.textContent = 'Reject';
      rejectBtn.addEventListener('click', () => rejectPipeline(run.id));
      actions.appendChild(rejectBtn);
    }

    if (run.state === 'running' || run.state === 'paused') {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-small';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => cancelPipeline(run.id));
      actions.appendChild(cancelBtn);
    }

    const detailBtn = document.createElement('button');
    detailBtn.className = 'btn btn-small';
    detailBtn.textContent = 'Details';
    detailBtn.addEventListener('click', () => showPipelineRunDetails(run.id));
    actions.appendChild(detailBtn);

    card.appendChild(header);
    card.appendChild(meta);
    card.appendChild(actions);
    el.pipelineRunList.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function refreshPipelineData() {
  try {
    pipelineTemplates = await window.geepus.listPipelines();
    pipelineRuns = await window.geepus.listPipelineRuns();
  } catch {
    pipelineTemplates = [];
    pipelineRuns = [];
  }
  renderPipelineList();
  renderPipelineRuns();
}

// ---------------------------------------------------------------------------
// Pipeline template form
// ---------------------------------------------------------------------------

async function openPipelineForm(existingId) {
  if (existingId) {
    const pipeline = await window.geepus.getPipeline(existingId);
    if (!pipeline) { setStatus('Pipeline not found.'); return; }
    el.pipelineFormTitle.textContent = 'Edit Pipeline';
    el.pipelineEditId.value = pipeline.id;
    el.pipelineNameInput.value = pipeline.name;
    el.pipelineDescInput.value = pipeline.description;
    editingSteps = pipeline.steps.map((s, i) => ({ ...s, index: i }));
  } else {
    el.pipelineFormTitle.textContent = 'New Pipeline';
    el.pipelineEditId.value = '';
    el.pipelineNameInput.value = '';
    el.pipelineDescInput.value = '';
    editingSteps = [
      { name: 'Research', objective: '', executionMode: 'research', teamMode: 'teams', workspaceRoot: '', requiresApproval: false, condition: 'previous_success' },
      { name: 'Implement', objective: '', executionMode: 'action', teamMode: 'teams', workspaceRoot: '', requiresApproval: true, condition: 'previous_success' },
    ];
  }

  renderStepsInForm();
  el.pipelineForm.hidden = false;
  el.pipelineNameInput.focus({ preventScroll: true });
}

function closePipelineForm() {
  el.pipelineForm.hidden = true;
  el.pipelineEditId.value = '';
  editingSteps = [];
}

async function savePipelineFromForm() {
  const name = el.pipelineNameInput.value.trim();
  const description = el.pipelineDescInput.value.trim();
  const steps = collectStepsFromForm();
  const editId = el.pipelineEditId.value.trim();

  if (!name) { setStatus('Pipeline needs a name.'); return; }
  if (steps.length === 0) { setStatus('Pipeline needs at least one step.'); return; }
  const missingObjective = steps.find((s) => !s.objective);
  if (missingObjective) {
    setStatus(`Step "${missingObjective.name || missingObjective.index + 1}" needs an objective.`);
    return;
  }

  try {
    if (editId) {
      await window.geepus.updatePipeline(editId, { name, description, steps });
      setStatus(`Updated pipeline "${name}".`);
    } else {
      await window.geepus.addPipeline({ name, description, steps });
      setStatus(`Created pipeline "${name}".`);
    }
    closePipelineForm();
    await refreshPipelineData();
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function deletePipeline(id) {
  try {
    await window.geepus.removePipeline(id);
    setStatus('Pipeline deleted.');
    await refreshPipelineData();
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

// ---------------------------------------------------------------------------
// Pipeline execution actions
// ---------------------------------------------------------------------------

async function startPipeline(pipelineId) {
  try {
    setStatus('Starting pipeline...');
    await window.geepus.runPipeline(pipelineId);
    setStatus('Pipeline finished.');
    await refreshPipelineData();
  } catch (error) {
    setStatus(error.message || String(error));
    await refreshPipelineData();
  }
}

async function approvePipeline(runId) {
  try {
    setStatus('Approving step and continuing pipeline...');
    await window.geepus.approvePipelineStep(runId);
    setStatus('Pipeline step approved, execution resumed.');
    await refreshPipelineData();
  } catch (error) {
    setStatus(error.message || String(error));
    await refreshPipelineData();
  }
}

async function rejectPipeline(runId) {
  try {
    await window.geepus.rejectPipelineStep(runId);
    setStatus('Pipeline step rejected.');
    await refreshPipelineData();
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function cancelPipeline(runId) {
  try {
    await window.geepus.cancelPipelineRun(runId);
    setStatus('Pipeline cancelled.');
    await refreshPipelineData();
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function showPipelineRunDetails(runId) {
  try {
    const run = await window.geepus.getPipelineRun(runId);
    if (!run) { setStatus('Run not found.'); return; }

    // Build a detail view in the run list area
    const container = el.pipelineRunList;
    container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'pipeline-detail-header';
    header.innerHTML = `<strong>${escapeAttr(run.pipelineName || 'Pipeline')}</strong> — ${run.state}`;
    container.appendChild(header);

    (run.steps || []).forEach((step, i) => {
      const stepEl = document.createElement('div');
      stepEl.className = `pipeline-step-status ${step.state}`;
      const icon = stepStateIcon(step.state);
      let detail = step.objective ? ` — ${step.objective.slice(0, 80)}` : '';
      if (step.error) detail += ` (${step.error.slice(0, 60)})`;
      if (step.result?.reason) detail += ` — ${step.result.reason.slice(0, 80)}`;
      stepEl.textContent = `${icon} Step ${i + 1}: ${step.name}${detail}`;
      container.appendChild(stepEl);
    });

    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn-small';
    backBtn.textContent = 'Back to list';
    backBtn.style.marginTop = '8px';
    backBtn.addEventListener('click', () => {
      renderPipelineRuns();
    });
    container.appendChild(backBtn);
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function installPipelineEvents() {
  el.addPipelineButton.addEventListener('click', () => {
    openPipelineForm(null);
  });

  el.pipelineAddStepButton.addEventListener('click', () => {
    editingSteps = collectStepsFromForm();
    editingSteps.push({
      name: `Step ${editingSteps.length + 1}`,
      objective: '',
      executionMode: 'action',
      teamMode: 'teams',
      workspaceRoot: '',
      requiresApproval: false,
      condition: 'previous_success',
    });
    renderStepsInForm();
  });

  el.pipelineSaveButton.addEventListener('click', () => {
    savePipelineFromForm().catch((error) => {
      setStatus(error.message || String(error));
    });
  });

  el.pipelineCancelButton.addEventListener('click', () => {
    closePipelineForm();
  });

  el.refreshPipelineRunsButton.addEventListener('click', () => {
    refreshPipelineData().catch((error) => {
      setStatus(error.message || String(error));
    });
  });
}
