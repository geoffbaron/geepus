/**
 * renderer-projects.js — Multi-Project Manager sidebar UI.
 *
 * Depends on: renderer-state.js (el, state)
 *             renderer-utils.js (setStatus)
 *             renderer-settings.js (saveSettingsPatch)
 */

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatProjectCost(usd) {
  if (typeof usd !== 'number' || isNaN(usd) || usd === 0) return '';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function timeAgo(dateStr) {
  if (!dateStr) return 'never';
  const ms = Date.now() - new Date(dateStr).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  if (ms < 604_800_000) return `${Math.floor(ms / 86_400_000)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function statusBadge(status) {
  const map = {
    completed: { cls: 'proj-badge-ok', text: 'Completed' },
    stopped: { cls: 'proj-badge-warn', text: 'Stopped' },
    running: { cls: 'proj-badge-active', text: 'Running' },
    added: { cls: 'proj-badge-new', text: 'New' },
    paused_approval: { cls: 'proj-badge-warn', text: 'Paused' },
  };
  const entry = map[status] || { cls: 'proj-badge-dim', text: status || '—' };
  return `<span class="proj-badge ${entry.cls}">${entry.text}</span>`;
}

// ---------------------------------------------------------------------------
// Render project cards
// ---------------------------------------------------------------------------

async function renderProjectList() {
  const container = el.projectManagerContent;
  if (!container) return;

  try {
    const data = await window.geepus.listProjects();
    const projects = data.projects || [];

    if (projects.length === 0) {
      container.innerHTML = `
        <p class="hint">No projects tracked yet. Run a task or add a project manually.</p>
      `;
      return;
    }

    const cards = projects.map((p) => {
      const isActive = p.workspaceRoot === data.activeWorkspaceRoot;
      const techPills = p.techStack
        .map((t) => `<span class="proj-tech-pill" title="${t.tech}">${t.icon} ${t.tech}</span>`)
        .join('');
      const costStr = formatProjectCost(p.totalCost);
      const scriptHints = p.scripts.length > 0
        ? `<span class="proj-scripts-hint" title="${p.scripts.join(', ')}">📋 ${p.scripts.length} scripts</span>`
        : '';
      const makeHints = p.makeTargets.length > 0
        ? `<span class="proj-scripts-hint" title="${p.makeTargets.join(', ')}">🔨 ${p.makeTargets.length} targets</span>`
        : '';

      return `
        <div class="proj-card ${isActive ? 'proj-card-active' : ''} ${!p.exists ? 'proj-card-missing' : ''}"
             data-workspace="${encodeURIComponent(p.workspaceRoot)}">
          <div class="proj-card-head">
            <div class="proj-card-title">
              <strong>${escapeHtml(p.name)}</strong>
              ${isActive ? '<span class="proj-active-indicator">● Active</span>' : ''}
            </div>
            ${statusBadge(p.lastStatus || p.runStats.lastRunState)}
          </div>
          <div class="proj-card-path">${escapeHtml(p.workspaceRoot)}</div>
          ${p.lastObjective ? `<div class="proj-card-objective">${escapeHtml(truncateStr(p.lastObjective, 100))}</div>` : ''}
          <div class="proj-card-meta">
            ${techPills}
            ${scriptHints}
            ${makeHints}
          </div>
          <div class="proj-card-stats">
            <span title="Runs">🔄 ${p.runStats.total}</span>
            <span title="Completed">✅ ${p.runStats.completed}</span>
            ${p.runStats.failed > 0 ? `<span title="Failed">❌ ${p.runStats.failed}</span>` : ''}
            ${p.fileCount > 0 ? `<span title="Files">📄 ${p.fileCount}</span>` : ''}
            ${costStr ? `<span title="Total cost">💰 ${costStr}</span>` : ''}
            <span title="Last activity">${timeAgo(p.updatedAt)}</span>
          </div>
          <div class="proj-card-actions">
            ${!isActive && p.exists ? `<button class="btn btn-small proj-switch-btn" data-ws="${encodeURIComponent(p.workspaceRoot)}">Switch To</button>` : ''}
            <button class="btn btn-small proj-details-btn" data-ws="${encodeURIComponent(p.workspaceRoot)}">Details</button>
            <button class="btn btn-small proj-remove-btn" data-ws="${encodeURIComponent(p.workspaceRoot)}">Remove</button>
          </div>
          ${!p.exists ? '<div class="proj-card-warning">⚠ Folder not found</div>' : ''}
        </div>
      `;
    }).join('');

    container.innerHTML = cards;

    // Attach event handlers
    container.querySelectorAll('.proj-switch-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ws = decodeURIComponent(btn.dataset.ws);
        try {
          await window.geepus.setActiveProject(ws);
          await saveSettingsPatch({ workspaceRoot: ws });
          setStatus(`Switched to project: ${ws}`);
          renderProjectList();
        } catch (err) {
          setStatus(err.message || String(err));
        }
      });
    });

    container.querySelectorAll('.proj-remove-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ws = decodeURIComponent(btn.dataset.ws);
        try {
          await window.geepus.removeProject(ws);
          setStatus('Project removed from list.');
          renderProjectList();
        } catch (err) {
          setStatus(err.message || String(err));
        }
      });
    });

    container.querySelectorAll('.proj-details-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ws = decodeURIComponent(btn.dataset.ws);
        await renderProjectDetail(ws);
      });
    });
  } catch (error) {
    container.innerHTML = `<p class="hint">Unable to load projects: ${error.message || error}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Project detail view
// ---------------------------------------------------------------------------

async function renderProjectDetail(workspaceRoot) {
  const container = el.projectManagerContent;
  if (!container) return;

  try {
    const detail = await window.geepus.getProjectDetail(workspaceRoot);
    if (!detail) {
      container.innerHTML = '<p class="hint">Project not found.</p>';
      return;
    }

    const techPills = detail.techStack
      .map((t) => `<span class="proj-tech-pill">${t.icon} ${t.tech}</span>`)
      .join('');

    const scriptsHtml = detail.scripts.length > 0
      ? `<div class="proj-detail-section">
          <h4>Available Scripts</h4>
          <div class="proj-scripts-list">${detail.scripts.map((s) => `<code class="proj-script">${escapeHtml(s)}</code>`).join(' ')}</div>
        </div>`
      : '';

    const makeHtml = detail.makeTargets.length > 0
      ? `<div class="proj-detail-section">
          <h4>Make Targets</h4>
          <div class="proj-scripts-list">${detail.makeTargets.map((t) => `<code class="proj-script">${escapeHtml(t)}</code>`).join(' ')}</div>
        </div>`
      : '';

    const notesHtml = detail.memory.notes.length > 0
      ? `<div class="proj-detail-section">
          <h4>Agent Notes</h4>
          <ul class="proj-notes-list">${detail.memory.notes.slice(-8).map((n) => `<li>${escapeHtml(truncateStr(n, 120))}</li>`).join('')}</ul>
        </div>`
      : '';

    const objectivesHtml = detail.memory.recentObjectives.length > 0
      ? `<div class="proj-detail-section">
          <h4>Recent Objectives</h4>
          <ul class="proj-notes-list">${detail.memory.recentObjectives.slice(-6).map((o) => `<li>${escapeHtml(truncateStr(o, 100))}</li>`).join('')}</ul>
        </div>`
      : '';

    const runsHtml = detail.recentRuns.length > 0
      ? `<div class="proj-detail-section">
          <h4>Recent Runs</h4>
          <table class="cost-table">
            <thead><tr><th>Date</th><th>Status</th><th>Iterations</th><th>Actions</th></tr></thead>
            <tbody>
              ${detail.recentRuns.map((r) => `
                <tr>
                  <td>${timeAgo(r.updatedAt || r.startedAt)}</td>
                  <td>${statusBadge(r.state)}</td>
                  <td>${r.iterations}</td>
                  <td>${r.totalActions}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>`
      : '';

    container.innerHTML = `
      <div class="proj-detail">
        <button class="btn btn-small proj-back-btn" type="button">← Back to Projects</button>
        <h3>${escapeHtml(detail.name)}</h3>
        <div class="proj-card-path">${escapeHtml(detail.workspaceRoot)}</div>
        <div class="proj-card-meta">${techPills}</div>
        <div class="proj-card-stats">
          <span>🔄 ${detail.runStats.total} runs</span>
          <span>✅ ${detail.runStats.completed} OK</span>
          <span>📄 ${detail.fileCount} files</span>
          ${detail.totalCost > 0 ? `<span>💰 ${formatProjectCost(detail.totalCost)}</span>` : ''}
        </div>
        ${scriptsHtml}
        ${makeHtml}
        ${objectivesHtml}
        ${notesHtml}
        ${runsHtml}
      </div>
    `;

    container.querySelector('.proj-back-btn')?.addEventListener('click', () => {
      renderProjectList();
    });
  } catch (error) {
    container.innerHTML = `<p class="hint">Error: ${error.message || error}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Add project form handler
// ---------------------------------------------------------------------------

async function handleAddProject() {
  const input = el.addProjectPathInput;
  if (!input) return;

  const wsPath = input.value.trim();
  if (!wsPath) {
    setStatus('Enter a folder path to add.');
    return;
  }

  try {
    await window.geepus.addProject(wsPath);
    input.value = '';
    setStatus(`Project added: ${wsPath}`);
    renderProjectList();
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncateStr(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function installProjectManagerEvents() {
  const refreshBtn = el.projectRefreshButton;
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      renderProjectList();
    });
  }

  const addBtn = el.addProjectButton;
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      handleAddProject();
    });
  }

  const addInput = el.addProjectPathInput;
  if (addInput) {
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAddProject();
    });
  }
}
