const params = new URLSearchParams(window.location.search);
let runId = params.get('runId') || '';
let unsubscribe = null;
let snapshotPollTimer = null;
let currentSnapshot = null;
let planningStartedAt = null;   // timestamp (ms) when we entered a planning phase
let planningElapsedTimer = null; // interval that refreshes the phase bar during long planning

const el = {
  runSummary: document.getElementById('runSummary'),
  objectiveText: document.getElementById('objectiveText'),
  agentGrid: document.getElementById('agentGrid'),
  eventList: document.getElementById('eventList'),
  phaseBar: document.getElementById('phaseBar'),
  phaseIcon: document.getElementById('phaseIcon'),
  phaseLabel: document.getElementById('phaseLabel'),
  phaseProgressFill: document.getElementById('phaseProgressFill'),
  phaseDetail: document.getElementById('phaseDetail'),
  completionCard: document.getElementById('completionCard'),
  completionTitle: document.getElementById('completionTitle'),
  completionReport: document.getElementById('completionReport'),
};
let memoryCardEl = null;

// Minimal markdown → HTML (no external deps)
function mdToHtml(md) {
  const escaped = String(md || '');
  // Fenced code blocks first
  const blocks = [];
  const withPlaceholders = escaped.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code></pre>`);
    return `\x00BLOCK${blocks.length - 1}\x00`;
  });
  let html = withPlaceholders
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="external-link" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[^"=])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" class="external-link" target="_blank" rel="noopener">$2</a>');
  // Bullet lists
  html = html.replace(/((?:^- .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n')
      .map((l) => `<li>${l.replace(/^- /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });
  // Paragraphs
  html = html.split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => /^<[hup]|^<pre|^\x00BLOCK/.test(p) ? p : `<p>${p.replace(/\n/g, ' ')}</p>`)
    .join('\n');
  // Restore code blocks
  blocks.forEach((b, i) => { html = html.replace(`\x00BLOCK${i}\x00`, b); });
  return html;
}

function formatTs(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleTimeString();
}

function stateLabel(state) {
  if (!state) return 'unknown';
  return String(state).replaceAll('_', ' ');
}

function ensureMemoryCard() {
  if (memoryCardEl && memoryCardEl.isConnected) {
    return memoryCardEl;
  }
  if (!el.objectiveText || !el.objectiveText.parentNode) {
    return null;
  }
  const card = document.createElement('section');
  card.className = 'event-item';
  card.style.marginTop = '10px';
  card.hidden = true;
  el.objectiveText.parentNode.insertBefore(card, el.objectiveText.nextSibling);
  memoryCardEl = card;
  return card;
}

function renderActiveMemory(snapshot) {
  const card = ensureMemoryCard();
  if (!card) return;
  const strategies = Array.isArray(snapshot?.activeLearnedStrategies) ? snapshot.activeLearnedStrategies : [];
  const bans = Array.isArray(snapshot?.activeBannedApproaches) ? snapshot.activeBannedApproaches : [];
  if (strategies.length === 0 && bans.length === 0) {
    card.hidden = true;
    card.innerHTML = '';
    return;
  }
  const sections = [];
  if (strategies.length > 0) {
    sections.push(`<div class="event-meta">Active learned strategies</div>`);
    sections.push(`<div class="event-text">${strategies.map((item) => `• ${String(item || '')}`).join('<br>')}</div>`);
  }
  if (bans.length > 0) {
    sections.push(`<div class="event-meta" style="margin-top:10px;">Active cross-run bans</div>`);
    sections.push(`<div class="event-text">${bans.map((item) => {
      const tool = String(item?.tool || 'tool');
      const detail = String(item?.error || item?.signature || '').slice(0, 120);
      const count = Number(item?.count || 0);
      return `• Avoid ${tool}${count > 0 ? ` (${count}x)` : ''}: ${detail}`;
    }).join('<br>')}</div>`);
  }
  card.innerHTML = sections.join('');
  card.hidden = false;
}

// ---------------------------------------------------------------------------
// Phase detection — derive the current phase from agent states + events
// ---------------------------------------------------------------------------
function detectPhase(snapshot) {
  if (!snapshot) return { icon: '⏳', label: 'Starting...', detail: '', progress: 'indeterminate' };

  const state = String(snapshot.state || '').toLowerCase();
  if (state === 'completed') {
    const agentList = Object.values(snapshot.agents || {});
    const totalDone = agentList.reduce((s, a) => s + (a.completedActions || 0), 0);
    return { icon: '✅', label: 'Task Complete', detail: totalDone ? `${totalDone} actions completed` : '', progress: '100' };
  }
  if (state === 'stopped') {
    return { icon: '⚠️', label: 'Needs Attention', detail: 'Run stopped before completion.', progress: '100' };
  }
  if (state === 'paused_approval') return { icon: '🔐', label: 'Waiting for Approval', detail: 'A risky action needs your OK before continuing.', progress: '50' };
  if (state === 'needs_info') return { icon: '❓', label: 'Needs Your Input', detail: 'Answer the questions in the response area, then click Resume Last.', progress: '50' };
  if (state !== 'running') return { icon: '⏸', label: stateLabel(state), detail: '', progress: '0' };

  const agents = snapshot.agents || {};
  const agentList = Object.values(agents);
  const working = agentList.filter((a) => a.status === 'working');
  const planning = agentList.filter((a) => a.status === 'planning');

  // Look at recent events for context
  const events = snapshot.events || [];
  const recent = events.slice(-10);
  const lastAction = [...recent].reverse().find((e) => e.type === 'action_started' || e.type === 'action_finished');
  const lastPlanning = [...recent].reverse().find((e) => e.type === 'planning_started');

  // Count completed actions across all agents
  const totalDone = agentList.reduce((s, a) => s + (a.completedActions || 0), 0);
  const totalFailed = agentList.reduce((s, a) => s + (a.failedActions || 0), 0);

  if (working.length > 0 && lastAction) {
    // Show the Chief's heartbeat text if it has useful detail (tool + intent),
    // otherwise fall back to the working agent's currentAction.
    const chief = agents.chief;
    const chiefAction = chief?.currentAction || '';
    const hasChiefDetail = chiefAction && !chiefAction.startsWith('Running actions');
    const actionAgent = working[0];
    const actionText = hasChiefDetail
      ? chiefAction
      : (actionAgent.currentAction || lastAction.intent || lastAction.summary || 'Executing...');
    return {
      icon: '🔨',
      label: 'Executing Actions',
      detail: `${actionText}${totalDone ? ` (${totalDone} done${totalFailed ? `, ${totalFailed} failed` : ''})` : ''}`,
      progress: 'indeterminate',
    };
  }

  if (planning.length > 0) {
    const planningAgents = planning.map((a) => a.label || 'Agent').join(', ');
    // Show how long we've been waiting — planningStartedAt is set in renderPhaseBar
    let elapsedStr = '';
    if (planningStartedAt) {
      const secs = Math.floor((Date.now() - planningStartedAt) / 1000);
      if (secs >= 10) {
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        elapsedStr = m > 0 ? ` — ${m}m ${s}s` : ` — ${s}s`;
      }
    }
    const skillName = snapshot.activeSkillName ? ` | Skill: ${snapshot.activeSkillName}` : '';
    const lastIter = [...(snapshot.events || [])].reverse().find((e) => e.type === 'planning_started');
    const iterStr = lastIter ? ` | iter ${lastIter.iteration}` : '';
    return {
      icon: '🧠',
      label: `Planning${elapsedStr}`,
      detail: `${planningAgents}${iterStr}${skillName}${elapsedStr ? ' — waiting for model response' : ''}`,
      progress: 'indeterminate',
    };
  }

  if (totalDone > 0) {
    return { icon: '🔄', label: 'Processing', detail: `${totalDone} actions completed so far.`, progress: 'indeterminate' };
  }

  // Show chief's current action if available (from heartbeat updates)
  const chiefFallback = agents.chief?.currentAction || '';
  const fallbackDetail = chiefFallback && chiefFallback !== 'Working...'
    ? chiefFallback
    : 'Geepus is active.';
  return { icon: '⚙️', label: 'Working...', detail: fallbackDetail, progress: 'indeterminate' };
}

function renderPhaseBar(snapshot) {
  const agents = snapshot ? Object.values(snapshot.agents || {}) : [];
  const isPlanning = agents.some((a) => a.status === 'planning');
  const isWorking = agents.some((a) => a.status === 'working');

  // Track when we entered planning so we can show elapsed time
  if (isPlanning && !planningStartedAt) {
    planningStartedAt = Date.now();
    // Refresh the phase bar every 5 s so the elapsed counter ticks
    if (!planningElapsedTimer) {
      planningElapsedTimer = setInterval(() => {
        if (currentSnapshot) renderPhaseBar(currentSnapshot);
      }, 5000);
    }
  } else if (!isPlanning) {
    planningStartedAt = null;
    if (planningElapsedTimer) { clearInterval(planningElapsedTimer); planningElapsedTimer = null; }
  }

  const phase = detectPhase(snapshot);
  el.phaseBar.hidden = false;
  el.phaseIcon.textContent = phase.icon;
  el.phaseLabel.textContent = phase.label;
  el.phaseDetail.textContent = phase.detail;

  if (phase.progress === 'indeterminate') {
    el.phaseProgressFill.className = 'phase-progress-fill indeterminate';
    el.phaseProgressFill.style.width = '';
  } else {
    el.phaseProgressFill.className = 'phase-progress-fill';
    el.phaseProgressFill.style.width = `${phase.progress}%`;
  }
}

// ---------------------------------------------------------------------------

function renderAgents(agents) {
  el.agentGrid.innerHTML = '';
  const entries = Object.entries(agents || {});
  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'agent-action';
    empty.textContent = 'No agent activity yet.';
    el.agentGrid.appendChild(empty);
    return;
  }

  entries.forEach(([owner, data]) => {
    const card = document.createElement('article');
    const statusName = (data.status || 'idle').toLowerCase();
    const isActive = statusName === 'working' || statusName === 'planning';
    card.className = `agent-card${isActive ? ' is-active' : ''}`;

    const head = document.createElement('div');
    head.className = 'agent-head';

    const name = document.createElement('span');
    name.className = 'agent-name';
    name.textContent = data.label || owner;

    const status = document.createElement('span');
    status.className = `agent-status ${statusName}`;
    status.textContent = stateLabel(statusName);

    head.appendChild(name);
    head.appendChild(status);

    const action = document.createElement('p');
    action.className = 'agent-action';
    if (isActive && !data.currentAction) {
      action.innerHTML = '<span class="thinking-dots">Thinking</span>';
    } else {
      action.textContent = data.currentAction || 'Waiting...';
    }

    const metrics = document.createElement('div');
    metrics.className = 'agent-metrics';
    metrics.textContent = `done: ${data.completedActions || 0} • failed: ${data.failedActions || 0} • updated: ${formatTs(data.updatedAt) || '-'}`;

    card.appendChild(head);
    card.appendChild(action);
    card.appendChild(metrics);
    el.agentGrid.appendChild(card);
  });
}

function renderEvents(events) {
  el.eventList.innerHTML = '';
  const items = Array.isArray(events) ? events.slice(-200).reverse() : [];
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'event-item';
    empty.textContent = 'No events yet.';
    el.eventList.appendChild(empty);
    return;
  }

  // Collapse consecutive heartbeats — show only the latest
  const collapsed = [];
  for (let i = 0; i < items.length; i++) {
    const ev = items[i];
    if (ev.type === 'heartbeat' && i > 0 && items[i - 1].type === 'heartbeat') {
      continue; // skip older heartbeats next to newer ones
    }
    collapsed.push(ev);
  }

  collapsed.forEach((event) => {
    const item = document.createElement('article');
    const eventType = event.type || 'event';
    item.className = `event-item event-${eventType}`;

    const meta = document.createElement('div');
    meta.className = 'event-meta';
    const ownerLabel = event.owner
      ? ((currentSnapshot?.agents && currentSnapshot.agents[event.owner]?.label) || event.owner)
      : '';
    const owner = ownerLabel ? ` • ${ownerLabel}` : '';
    const iter = Number.isFinite(Number(event.iteration)) ? ` • iter ${event.iteration}` : '';

    // Type icon mapping
    const typeIcons = {
      planning_started: '🧠',
      planning_completed: '📋',
      action_started: '⚡',
      action_finished: '✓',
      delegate_started: '🔀',
      delegate_finished: '🔀',
      iteration_summary: '📊',
      progress_check: '🔍',
      progress_done: '✅',
      progress_not_done: '➡️',
      progress_skip: '⏩',
      failure_recovery: '🔧',
      research_pivot: '🔄',
      research_loop_warning: '⚠️',
      acceptance_review: '👤',
      acceptance_passed: '✅',
      acceptance_failed: '❌',
      iteration_update: 'ℹ️',
      heartbeat: '💓',
      skill_matched: '🎯',
      skill_developing: '🔬',
      skill_developed: '📚',
      run_started: '🚀',
      run_resumed: '▶️',
    };
    const icon = typeIcons[eventType] || '•';
    meta.textContent = `${formatTs(event.ts)} • ${icon} ${eventType.replace(/_/g, ' ')}${owner}${iter}`;

    const text = document.createElement('p');
    text.className = 'event-text';
    const line = event.summary || event.intent || event.tool || '...';

    // For action_finished, prepend ok/fail indicator
    if (eventType === 'action_finished') {
      const toolName = String(event.tool || '').trim();
      const intentText = String(event.intent || '').trim();
      const summaryText = String(event.summary || '').trim();
      const genericIntent = !intentText || intentText === toolName || intentText === 'browser_action' || intentText === 'browser_launch';
      const detailText = genericIntent ? (summaryText || intentText || toolName || '...') : intentText;
      text.textContent = `${event.ok ? '✓' : '✗'} ${toolName || 'action'}: ${detailText}`;
      if (!event.ok) {
        text.classList.add('event-text-fail');
      }
    } else {
      text.textContent = line;
    }

    item.appendChild(meta);
    item.appendChild(text);

    // Show detail block if present (action breakdown, error details, etc.)
    if (event.detail) {
      const detail = document.createElement('pre');
      detail.className = 'event-detail';
      detail.textContent = event.detail;
      item.appendChild(detail);
    }

    if (event.browserState && typeof event.browserState === 'object') {
      const state = event.browserState;
      const browserMeta = document.createElement('div');
      browserMeta.className = 'event-browser-state';
      const lines = [];
      if (state.pageTitle || state.pageUrl) {
        lines.push(`${state.pageTitle || '(untitled)'}${state.pageUrl ? ` — ${state.pageUrl}` : ''}`);
      }
      if (Array.isArray(state.frames) && state.frames.length > 0) {
        lines.push(`Frames: ${state.frames.map((frame) => {
          const frameId = Number.isFinite(Number(frame.frameId)) ? ` id=${Number(frame.frameId)}` : '';
          const parentFrameId = Number.isFinite(Number(frame.parentFrameId)) ? ` parent=${Number(frame.parentFrameId)}` : '';
          return `[${frame.index}${frameId}${parentFrameId}] ${frame.url}`;
        }).join(' | ')}`);
      }
      if (state.downloadPath) {
        lines.push(`Download: ${state.downloadPath}`);
      }
      if (state.screenshotPath) {
        lines.push(`Screenshot: ${state.screenshotPath}`);
      }
      browserMeta.textContent = lines.join('\n');
      if (browserMeta.textContent) {
        item.appendChild(browserMeta);
      }
    }

    // Show plan summary if present
    if (event.planSummary) {
      const ps = document.createElement('p');
      ps.className = 'event-plan-summary';
      ps.textContent = `Plan: ${event.planSummary}`;
      item.appendChild(ps);
    }

    el.eventList.appendChild(item);
  });
}

function renderCompletionReport(snapshot) {
  if (!el.completionCard || !el.completionReport || !el.completionTitle) return;
  const report = snapshot && snapshot.completionReport;
  if (!report) {
    el.completionCard.classList.remove('completed', 'stopped', 'needs-info', 'approval-needed', 'summary');
    el.completionCard.hidden = true;
    return;
  }
  const state = String(snapshot?.state || '').toLowerCase();
  let title = '\u2139\ufe0f Run Summary';
  let stateClass = 'summary';
  if (state === 'completed') {
    title = '\u2705 Task Complete';
    stateClass = 'completed';
  } else if (state === 'stopped') {
    title = '\u26a0\ufe0f Needs Attention';
    stateClass = 'stopped';
  } else if (state === 'needs_info') {
    title = '\u2753 Need Your Input';
    stateClass = 'needs-info';
  } else if (state === 'paused_approval') {
    title = '\ud83d\udd10 Approval Needed';
    stateClass = 'approval-needed';
  }
  el.completionTitle.textContent = title;
  el.completionCard.classList.remove('completed', 'stopped', 'needs-info', 'approval-needed', 'summary');
  el.completionCard.classList.add(stateClass);
  el.completionCard.hidden = false;
  el.completionReport.innerHTML = mdToHtml(report);
}

function renderSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }

  currentSnapshot = snapshot;
  runId = snapshot.runId || runId;
  const status = stateLabel(snapshot.state || 'unknown');
  const executionMode = String(snapshot.executionMode || 'action').toLowerCase();
  const modeLabel = executionMode === 'research' ? 'research' : 'action';
  const updated = formatTs(snapshot.updatedAt);
  el.runSummary.textContent = `run ${runId || '(none)'} • ${status} • ${modeLabel} • ${snapshot.provider || 'provider?'} • ${snapshot.model || 'model?'}${updated ? ` • updated ${updated}` : ''}`;
  el.objectiveText.textContent = snapshot.objective || 'No objective yet.';

  renderActiveMemory(snapshot);
  renderPhaseBar(snapshot);
  renderCompletionReport(snapshot);
  renderAgents(snapshot.agents || {});
  renderEvents(snapshot.events || []);
}

async function loadInitial() {
  const snapshot = await window.geepus.getWatchSnapshot({ runId });
  renderSnapshot(snapshot);
}

function isSnapshotStale(snapshot) {
  if (!snapshot || !snapshot.updatedAt) {
    return true;
  }
  const ts = new Date(snapshot.updatedAt).getTime();
  if (Number.isNaN(ts)) {
    return true;
  }
  return (Date.now() - ts) > 45000;
}

function applyEvent(event) {
  if (!event) {
    return;
  }
  if (runId && event.runId && event.runId !== runId) {
    const canFollowNewRun = !currentSnapshot
      || currentSnapshot.state !== 'running'
      || isSnapshotStale(currentSnapshot);
    if (canFollowNewRun) {
      runId = event.runId;
    } else {
      return;
    }
  }
  if (!runId && event.runId) {
    runId = event.runId;
  }

  window.geepus.getWatchSnapshot({ runId }).then(renderSnapshot).catch(() => {
    // Ignore transient errors.
  });
}

(async function boot() {
  await loadInitial();
  unsubscribe = window.geepus.onWatchUpdate(applyEvent);
  snapshotPollTimer = window.setInterval(() => {
    window.geepus.getWatchSnapshot({ runId }).then(renderSnapshot).catch(() => {
      // Ignore transient errors.
    });
  }, 2000);
})();

window.addEventListener('beforeunload', () => {
  if (typeof unsubscribe === 'function') {
    unsubscribe();
  }
  if (snapshotPollTimer) {
    window.clearInterval(snapshotPollTimer);
    snapshotPollTimer = null;
  }
});

// External link handler — open http(s)/file:// links in the user's browser
document.body.addEventListener('click', (e) => {
  const link = e.target.closest('a.external-link, a[target="_blank"]');
  if (!link) return;
  const href = (link.getAttribute('href') || '').trim();
  if (!href) return;
  e.preventDefault();
  if (window.geepus && typeof window.geepus.openExternal === 'function') {
    window.geepus.openExternal(href);
  }
});
