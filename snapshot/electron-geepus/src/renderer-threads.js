/**
 * renderer-threads.js — Thread CRUD, storage, rendering, and run-thread mapping.
 *
 * Depends on: renderer-state.js (state, el, THREADS_STORAGE_KEY, CURRENT_THREAD_STORAGE_KEY)
 *             renderer-utils.js (makeId, setStatus, formatRelativeTime, hardFocusPrompt, escapeHtml)
 */

function threadTitle(objective) {
  const first = String(objective || '').split('\n')[0].trim().replace(/\s+/g, ' ');
  if (!first) {
    return 'Untitled task';
  }
  return first.length > 90 ? `${first.slice(0, 87)}...` : first;
}

function threadKeyFromRun(run) {
  const workspace = String(run.workspaceRoot || '').trim().toLowerCase();
  const objective = String(run.objective || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 180);
  return `${workspace}::${objective}`;
}

function statusLabel(stateValue) {
  const stateText = String(stateValue || '').toLowerCase();
  if (stateText === 'running') return 'Running';
  if (stateText === 'completed') return 'Completed';
  if (stateText === 'paused_approval') return 'Needs approval';
  if (stateText === 'stopped') return 'Stopped';
  return 'Unknown';
}

function normalizeThread(raw) {
  const thread = raw && typeof raw === 'object' ? raw : {};
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  return {
    id: String(thread.id || makeId('thread')),
    runKey: String(thread.runKey || ''),
    title: String(thread.title || 'New Thread'),
    objective: String(thread.objective || ''),
    workspaceRoot: String(thread.workspaceRoot || ''),
    latestRunId: String(thread.latestRunId || ''),
    latestState: String(thread.latestState || ''),
    latestReason: String(thread.latestReason || ''),
    latestUpdatedAt: thread.latestUpdatedAt || null,
    runCount: Number.isFinite(Number(thread.runCount)) ? Number(thread.runCount) : 0,
    resumeRunId: String(thread.resumeRunId || ''),
    budgetLimit: Number.isFinite(Number(thread.budgetLimit)) ? Number(thread.budgetLimit) : 1.0,
    messages: messages
      .filter((message) => message && typeof message === 'object')
      .map((message) => ({
        id: String(message.id || makeId('msg')),
        role: String(message.role || 'assistant'),
        content: String(message.content || ''),
        technical: message.technical === true,
        ts: message.ts || new Date().toISOString(),
      })),
    createdAt: thread.createdAt || new Date().toISOString(),
    updatedAt: thread.updatedAt || new Date().toISOString(),
  };
}

function saveThreadsToStorage() {
  try {
    const payload = state.threads.map((thread) => ({
      ...thread,
      messages: thread.messages.slice(-400),
    }));
    window.localStorage.setItem(THREADS_STORAGE_KEY, JSON.stringify(payload));
    window.localStorage.setItem(CURRENT_THREAD_STORAGE_KEY, state.currentThreadId || '');
  } catch {
    // Ignore storage issues.
  }
}

function loadThreadsFromStorage() {
  try {
    const raw = window.localStorage.getItem(THREADS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    state.threads = Array.isArray(parsed) ? parsed.map(normalizeThread) : [];
    const savedCurrent = String(window.localStorage.getItem(CURRENT_THREAD_STORAGE_KEY) || '').trim();
    if (savedCurrent && state.threads.some((thread) => thread.id === savedCurrent)) {
      state.currentThreadId = savedCurrent;
    }
  } catch {
    state.threads = [];
  }
}

function createNewThread({ title = 'New Thread', objective = '', workspaceRoot = '' } = {}) {
  const now = new Date().toISOString();
  const thread = normalizeThread({
    id: makeId('thread'),
    title,
    objective,
    workspaceRoot,
    messages: [],
    createdAt: now,
    updatedAt: now,
  });
  state.threads.unshift(thread);
  state.currentThreadId = thread.id;
  state.threadQuery = '';
  if (el.threadSearchInput) {
    el.threadSearchInput.value = '';
  }
  state.transientResponse = null;
  saveThreadsToStorage();
  renderThreads();
  renderCurrentThread();
  if (typeof renderMissionControl === 'function') {
    renderMissionControl();
  }
  return thread;
}

function currentThread() {
  return state.threads.find((thread) => thread.id === state.currentThreadId) || null;
}

function runForThread(thread) {
  if (!thread) return null;
  const candidateIds = [
    String(thread.latestRunId || '').trim(),
    String(thread.resumeRunId || '').trim(),
  ].filter(Boolean);
  if (candidateIds.length === 0) return null;
  const runs = Array.isArray(state.runs) ? state.runs : [];
  return runs.find((run) => candidateIds.includes(String(run.runId || '').trim())) || null;
}

function currentThreadRun() {
  return runForThread(currentThread());
}

function ensureCurrentThread() {
  let thread = currentThread();
  if (thread) {
    return thread;
  }
  if (state.threads.length === 0) {
    thread = createNewThread();
  } else {
    thread = state.threads[0];
    state.currentThreadId = thread.id;
  }
  saveThreadsToStorage();
  return thread;
}

function selectThread(threadId) {
  const target = state.threads.find((thread) => thread.id === threadId);
  if (!target) {
    return;
  }
  state.currentThreadId = target.id;
  const selectedRun = runForThread(target);
  state.currentRunId = selectedRun ? String(selectedRun.runId || '').trim() : '';
  state.transientResponse = null;
  saveThreadsToStorage();
  renderThreads();
  renderCurrentThread();
  if (typeof renderMissionControl === 'function') {
    renderMissionControl();
  }
}

function updateCurrentThreadTitleFromMessage(thread, content) {
  if (!thread) return;
  const candidate = threadTitle(content);
  if (!thread.title || thread.title === 'New Thread' || thread.title === 'Untitled task') {
    thread.title = candidate;
  }
  if (!thread.objective) {
    thread.objective = String(content || '').trim();
  }
}

function appendMessageToCurrentThread(role, content, { technical = false } = {}) {
  const thread = ensureCurrentThread();
  const trimmed = String(content || '').trim();
  if (!trimmed) {
    return;
  }
  thread.messages.push({
    id: makeId('msg'),
    role: String(role || 'assistant'),
    content: trimmed,
    technical,
    ts: new Date().toISOString(),
  });
  if (role === 'user') {
    updateCurrentThreadTitleFromMessage(thread, trimmed);
  }
  thread.updatedAt = new Date().toISOString();
  saveThreadsToStorage();
  renderThreads();
  renderCurrentThread();
}

function summarizeThreads(runs) {
  const map = new Map();
  (Array.isArray(runs) ? runs : []).forEach((run) => {
    const key = threadKeyFromRun(run);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        id: key,
        title: threadTitle(run.objective),
        objective: String(run.objective || ''),
        workspaceRoot: String(run.workspaceRoot || ''),
        latestRunId: run.runId,
        latestState: run.state,
        latestReason: String(run.reason || ''),
        latestUpdatedAt: run.updatedAt || run.startedAt || run.createdAt || null,
        runCount: 1,
        resumeRunId: run.state !== 'completed' ? run.runId : '',
      });
      return;
    }

    existing.runCount += 1;
    if (!existing.resumeRunId && run.state !== 'completed') {
      existing.resumeRunId = run.runId;
    }
  });

  return Array.from(map.values()).sort((left, right) => {
    const l = new Date(left.latestUpdatedAt || 0).getTime();
    const r = new Date(right.latestUpdatedAt || 0).getTime();
    return r - l;
  });
}

function upsertRunThreads(runSummaries) {
  const byRunKey = new Map();
  state.threads.forEach((thread) => {
    if (thread.runKey) {
      byRunKey.set(thread.runKey, thread);
    }
  });

  runSummaries.forEach((summary) => {
    let existing = byRunKey.get(summary.id);

    // Also match threads by objective+workspace if they don't have a runKey yet
    // (prevents duplicates when a user-created thread matches a run summary)
    if (!existing) {
      existing = state.threads.find((t) => !t.runKey && t.objective && summary.objective
        && t.objective.trim().toLowerCase().slice(0, 180) === summary.objective.trim().toLowerCase().slice(0, 180)
        && (
          // Allow matching when either side has no workspace root (draft threads)
          !(t.workspaceRoot || '').trim() ||
          !(summary.workspaceRoot || '').trim() ||
          (t.workspaceRoot || '').trim().toLowerCase() === (summary.workspaceRoot || '').trim().toLowerCase()
        ));
      if (existing) {
        existing.runKey = summary.id;
        byRunKey.set(summary.id, existing);
      }
    }

    if (existing) {
      existing.title = existing.title === 'New Thread' ? summary.title : existing.title;
      existing.objective = existing.objective || summary.objective;
      existing.workspaceRoot = summary.workspaceRoot || existing.workspaceRoot;
      existing.latestRunId = summary.latestRunId || existing.latestRunId;
      existing.latestState = summary.latestState || existing.latestState;
      existing.latestReason = summary.latestReason || existing.latestReason;
      existing.latestUpdatedAt = summary.latestUpdatedAt || existing.latestUpdatedAt;
      existing.runCount = summary.runCount;
      existing.resumeRunId = summary.resumeRunId || '';
      existing.runKey = summary.id;
      existing.updatedAt = existing.latestUpdatedAt || existing.updatedAt;
      return;
    }

    const thread = normalizeThread({
      id: makeId('thread'),
      runKey: summary.id,
      title: summary.title,
      objective: summary.objective,
      workspaceRoot: summary.workspaceRoot,
      latestRunId: summary.latestRunId,
      latestState: summary.latestState,
      latestReason: summary.latestReason,
      latestUpdatedAt: summary.latestUpdatedAt,
      runCount: summary.runCount,
      resumeRunId: summary.resumeRunId,
      messages: [],
      updatedAt: summary.latestUpdatedAt || new Date().toISOString(),
    });
    state.threads.push(thread);
    byRunKey.set(summary.id, thread);
  });

  // Sort only on initial load, not during active runs (prevents visual bouncing)
  // The sort happens once when threads are first created; subsequent upserts
  // just update data in-place without reordering
  if (!state.working) {
    state.threads.sort((left, right) => {
      const l = new Date(left.latestUpdatedAt || left.updatedAt || 0).getTime();
      const r = new Date(right.latestUpdatedAt || right.updatedAt || 0).getTime();
      return r - l;
    });
  }
}

async function continueThread(thread) {
  if (!thread) {
    return;
  }
  selectThread(thread.id);

  if (thread.workspaceRoot) {
    el.workspaceRootInput.value = thread.workspaceRoot;
    state.workspaceRoot = thread.workspaceRoot;
  }

  if (thread.resumeRunId) {
    setStatus(`Continuing "${thread.title}"...`);
    await resumeRunById(thread.resumeRunId);
    return;
  }

  el.promptInput.value = thread.objective;
  setStatus(`Reopening "${thread.title}"...`);
  await runAgentTask({
    taskOverride: thread.objective,
    workspaceOverride: thread.workspaceRoot,
  });
}

function loadThreadToComposer(thread) {
  if (!thread) {
    return;
  }
  selectThread(thread.id);
  el.promptInput.value = thread.objective;
  if (thread.workspaceRoot) {
    el.workspaceRootInput.value = thread.workspaceRoot;
    state.workspaceRoot = thread.workspaceRoot;
  }
  setStatus(`Loaded "${thread.title}" into the composer.`);
  hardFocusPrompt();
}

function renderThreads() {
  if (!el.threadList) {
    return;
  }
  const query = String(state.threadQuery || '').trim().toLowerCase();
  const rows = state.threads.filter((thread) => {
    // Hide empty ghost threads (no objective, no title, no messages)
    if (!thread.objective && (!thread.title || thread.title === 'New Thread' || thread.title === 'Untitled task')
        && thread.messages.length === 0 && thread.id !== state.currentThreadId) {
      return false;
    }
    if (!query) return true;
    const blob = [
      thread.title,
      thread.objective,
      thread.workspaceRoot,
      thread.latestState,
    ].join(' ').toLowerCase();
    return blob.includes(query);
  });

  el.threadList.innerHTML = '';
  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'thread-empty';
    empty.textContent = state.threads.length === 0
      ? 'No threads yet. Start a task and it will appear here.'
      : 'No matches for your search.';
    el.threadList.appendChild(empty);
    return;
  }

  rows.slice(0, 120).forEach((thread) => {
    const card = document.createElement('article');
    card.className = `thread-item${thread.id === state.currentThreadId ? ' active' : ''}`;
    card.addEventListener('click', () => {
      selectThread(thread.id);
    });

    const title = document.createElement('h3');
    title.className = 'thread-title';
    title.textContent = thread.title;

    const meta = document.createElement('p');
    meta.className = 'thread-meta';
    if (thread.latestState) {
      meta.textContent = `${statusLabel(thread.latestState)} • ${thread.runCount} run(s) • ${formatRelativeTime(thread.latestUpdatedAt)}`;
    } else {
      meta.textContent = `Draft thread • ${thread.messages.length} message(s) • ${formatRelativeTime(thread.updatedAt)}`;
    }

    const workspace = document.createElement('p');
    workspace.className = 'thread-workspace';
    workspace.textContent = thread.workspaceRoot || '(auto project detection)';

    const actions = document.createElement('div');
    actions.className = 'thread-actions';

    const continueButton = document.createElement('button');
    continueButton.className = 'btn';
    continueButton.textContent = thread.resumeRunId ? 'Continue' : 'Reopen';
    continueButton.disabled = state.working || (!thread.resumeRunId && !thread.objective);
    continueButton.addEventListener('click', (event) => {
      event.stopPropagation();
      continueThread(thread).catch((error) => {
        setStatus(error.message || String(error));
      });
    });

    const watchButton = document.createElement('button');
    watchButton.className = 'btn';
    watchButton.textContent = 'Watch';
    watchButton.disabled = !thread.latestRunId && !thread.resumeRunId;
    watchButton.addEventListener('click', (event) => {
      event.stopPropagation();
      openWatchTaskWindow(thread.latestRunId || thread.resumeRunId || '').catch((error) => {
        setStatus(error.message || String(error));
      });
    });

    const loadButton = document.createElement('button');
    loadButton.className = 'btn';
    loadButton.textContent = 'Load';
    loadButton.disabled = !thread.objective;
    loadButton.addEventListener('click', (event) => {
      event.stopPropagation();
      loadThreadToComposer(thread);
    });

    actions.appendChild(continueButton);
    actions.appendChild(watchButton);
    actions.appendChild(loadButton);

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(workspace);
    card.appendChild(actions);
    el.threadList.appendChild(card);
  });
}
