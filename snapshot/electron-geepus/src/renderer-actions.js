/**
 * renderer-actions.js — All user-initiated API calls and agent operations.
 *
 * Depends on: renderer-state.js (state, el)
 *             renderer-utils.js (setStatus, readRunLimitsFromInputs, hardFocusPrompt)
 *             renderer-intent.js (classifyIntentLocal, isContinuationPrompt,
 *                                 isReportLookupPrompt, answerFromRecentArtifacts,
 *                                 resolveExecutionTaskPrompt, buildThreadContextSnippet,
 *                                 recentThreadMessagesForLLM)
 *             renderer-threads.js (ensureCurrentThread, appendMessageToCurrentThread,
 *                                  saveThreadsToStorage, renderThreads, threadKeyFromRun,
 *                                  summarizeThreads, upsertRunThreads)
 *             renderer-chat.js (setResponse, renderCurrentThread)
 *             renderer-settings.js (setBusy, saveSettingsPatch, renderModels,
 *                                   updateStopButton, syncModelSelectors,
 *                                   updateConnectionBadge)
 *             renderer-workflow.js (renderWorkflow, setRunMeta, formatObjectiveRunResult,
 *                                   formatRunTimestamp)
 */

function stopRunPolling() {
  if (state.runPollTimer) {
    window.clearInterval(state.runPollTimer);
    state.runPollTimer = null;
  }
}

function selectedThreadRunId() {
  const thread = typeof currentThread === 'function' ? currentThread() : null;
  if (!thread) return '';
  const selectedRun = typeof runForThread === 'function' ? runForThread(thread) : null;
  if (selectedRun?.runId) {
    return String(selectedRun.runId || '').trim();
  }
  return String(thread.resumeRunId || thread.latestRunId || '').trim();
}

function normalizeRemoteErrorMessage(rawError) {
  const raw = String(rawError || '').trim();
  if (!raw) return 'Unknown error.';
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildConversationalErrorMessage(rawError) {
  const normalized = normalizeRemoteErrorMessage(rawError);
  const lower = normalized.toLowerCase();

  if (lower.includes("unsupported parameter") && lower.includes("temperature")) {
    return 'I hit an API settings mismatch for this model. I can retry without that parameter so the run continues.';
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return 'I hit a provider rate limit. Waiting briefly and retrying usually fixes this.';
  }
  if (lower.includes('api key') || lower.includes('unauthorized') || lower.includes('401')) {
    return 'I could not authenticate with the provider. Please recheck the API key and project access.';
  }
  if (lower.includes('context length') || lower.includes('maximum context')) {
    return 'The request was too large for this model context window. I should split the task into smaller steps.';
  }
  return `I ran into a problem: ${normalized}`;
}

function withTimeout(promise, timeoutMs, fallbackValue = null) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = window.setTimeout(() => resolve(fallbackValue), Math.max(50, Number(timeoutMs) || 50));
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) window.clearTimeout(timer);
  });
}

const AUTO_CHECKIN_LINES = [
  'Understood. Taking point now.',
  'Starting now. I will report back with progress.',
  'I am on it. Checking the first concrete step now.',
  'Beginning execution now.',
  'Working the task now.',
];

function pickAutoCheckinLine() {
  const index = Math.floor(Math.random() * AUTO_CHECKIN_LINES.length);
  return AUTO_CHECKIN_LINES[Math.max(0, Math.min(index, AUTO_CHECKIN_LINES.length - 1))];
}

function normalizeKickoffText(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  text = text.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (!/[.!?]$/.test(text)) text = `${text}.`;
  if (text.length > 180) {
    text = `${text.slice(0, 179).trim()}.`;
  }
  return text;
}

async function generateAutoModeKickoffMessage(task) {
  const fallback = 'Understood. I am starting with the first concrete step now and will report back.';
  const text = String(task || '').trim();
  if (!text) return fallback;
  if (!window.geepus || typeof window.geepus.ask !== 'function') return fallback;

  const prompt = [
    'Write exactly one short conversational sentence for the user before starting an autonomous run.',
    'Requirements:',
    '- Friendly and natural.',
    '- Mention the first concrete thing you will check or do.',
    '- NEVER ask questions or ask for confirmations. The task is ALREADY starting.',
    '- Do not claim completion.',
    '- No emojis.',
    '- Return only the sentence.',
    `User request: ${text.slice(0, 500)}`,
  ].join('\n');

  try {
    const result = await withTimeout(window.geepus.ask({
      prompt,
      model: state.model,
      provider: state.provider,
      baseUrl: state.baseUrl,
      mode: 'chat',
      history: [],
    }), 2400, null);
    const candidate = normalizeKickoffText(result?.answer || '');
    return candidate || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Build a text block describing files the user has attached via drag-and-drop.
 * Images are referenced by their saved path; text files are inlined.
 */
function buildAttachmentContextBlock(attachedFiles) {
  if (!Array.isArray(attachedFiles) || attachedFiles.length === 0) return '';
  const lines = ['User has attached the following file(s) for context:'];
  for (const file of attachedFiles) {
    if (file.type === 'image') {
      lines.push(`- ${file.name} [image, saved at: ${file.path}] — use analyze_image with this path before deciding fixes or QA outcomes`);
    } else {
      const preview = String(file.content || '').slice(0, 4000);
      lines.push(`- ${file.name} [text file]:\n\`\`\`\n${preview}${preview.length < (file.content || '').length ? '\n...[truncated]' : ''}\n\`\`\``);
    }
  }
  return lines.join('\n');
}

function startRunPolling(statusPrefix = 'Geepus is working') {
  stopRunPolling();
  state.runPollTimer = window.setInterval(async () => {
    try {
      await refreshRunList({ silent: true });
      const active = state.runs.find((run) => run.state === 'running' || run.state === 'paused_approval' || run.state === 'needs_info');
      if (active) {
        state.currentRunId = active.runId || state.currentRunId;
        const suffix = active.state === 'paused_approval'
          ? 'Waiting for approval.'
          : active.state === 'needs_info'
            ? 'Waiting for your answers.'
            : `Step ${active.iterations || 0} in progress...`;
        setStatus(`${statusPrefix}. ${suffix}`);
      }
    } catch {
      // Ignore transient polling errors.
    }
  }, 2000);
}

async function refreshRunList({ silent = false } = {}) {
  const runs = await window.geepus.listAgentRuns();
  state.runs = Array.isArray(runs) ? runs : [];
  const runSummaries = summarizeThreads(state.runs);
  upsertRunThreads(runSummaries);

  // During silent (polling) refreshes, only re-render when data actually changed
  // to prevent DOM thrashing / visual bouncing
  const threadsHash = state.threads.map(t => `${t.id}:${t.latestState}:${t.runCount}:${t.latestRunId ? '1' : '0'}`).join('|');
  if (!silent || threadsHash !== state._lastThreadsHash) {
    state._lastThreadsHash = threadsHash;
    saveThreadsToStorage();
    renderThreads();
  }
  const latest = state.runs[0];

  if (latest) {
    const when = formatRunTimestamp(latest.updatedAt);
    const stateLabel = latest.state === 'completed'
      ? 'Completed'
      : latest.state === 'needs_info'
        ? 'Needs your input'
        : (latest.state === 'running' ? 'Running' : 'Needs attention');
    const runMode = String(latest.executionMode || 'action').toLowerCase() === 'research'
      ? 'research'
      : String(latest.executionMode || 'action').toLowerCase() === 'auto'
        ? 'auto'
        : 'action';
    const source = latest.workspaceDiscoverySource ? ` • ${latest.workspaceDiscoverySource}` : '';
    setRunMeta(
      `${stateLabel} • ${runMode} • ${latest.iterations} step(s)${source}${when ? ` • ${when}` : ''}`,
    );
    renderWorkflow(latest.workflow || {});
    renderReadiness(latest.readiness || null);
    renderActiveMemoryPanel(latest);
  } else {
    setRunMeta('No active run');
    renderWorkflow({});
    renderReadiness(null);
    renderActiveMemoryPanel(null);
  }

  const resumable = state.runs.find((run) => run.state !== 'completed');
  el.resumeRunButton.disabled = state.working || !resumable;
  const selectedRunId = selectedThreadRunId();
  const selectedRun = selectedRunId
    ? state.runs.find((run) => String(run.runId || '').trim() === selectedRunId)
    : null;
  const active = state.runs.find((run) => run.state === 'running' || run.state === 'paused_approval' || run.state === 'needs_info');
  state.currentRunId = (selectedRun && selectedRun.runId) || (active && active.runId) || '';
  updateStopButton();

  if (!silent) {
    setStatus(`Loaded ${state.runs.length} run(s).`);
  } else if (typeof renderMissionControl === 'function') {
    renderMissionControl();
  }
}

async function resumeRunById(runId, options = {}) {
  if (!runId) {
    setStatus('No run selected to resume.');
    return;
  }
  setBusy(true);
  setStatus(`Resuming run ${runId}...`);
  setResponse('Resuming objective run...', { persist: false });
  state.currentRunId = runId;
  startRunPolling('Resuming run');
  state.runLimits = readRunLimitsFromInputs();
  const thread = ensureCurrentThread();
  const effectiveRunLimits = {
    ...state.runLimits,
    budgetLimit: thread && thread.budgetLimit !== undefined ? thread.budgetLimit : state.runLimits.budgetLimit
  };

  try {
    const execution = await window.geepus.resumeAgentObjective({
      runId,
      provider: state.provider,
      executionCore: state.executionCore,
      teamMode: state.teamMode,
      allowRisky: false,
      runLimits: effectiveRunLimits,
      threadContext: options.threadContext || '',
    });

    if (execution.model) {
      state.model = execution.model;
      if (el.modelSelect.value !== execution.model) {
        const known = Array.from(el.modelSelect.options).some((option) => option.value === execution.model);
        if (!known) {
          const option = document.createElement('option');
          option.value = execution.model;
          option.textContent = execution.model;
          el.modelSelect.appendChild(option);
        }
        el.modelSelect.value = execution.model;
      }
    }

    el.responseModel.textContent = execution.model
      ? `Provider: ${execution.provider || state.provider} • Model: ${execution.model}`
      : '';
    setResponse(formatObjectiveRunResult(execution));
    renderWorkflow(execution.workflow || {});
    renderReadiness(execution.readiness || null);
    renderActiveMemoryPanel(execution);
    setStatus(execution.state === 'completed' ? 'Objective completed.' : execution.state === 'needs_info' ? 'Geepus needs more information — answer the questions and click Resume Last.' : 'Objective stopped by limit or policy.');
    await refreshRunList({ silent: true });
  } catch (error) {
    const raw = error.message || String(error);
    const conversational = buildConversationalErrorMessage(raw);
    setResponse(conversational);
    if (normalizeRemoteErrorMessage(raw) !== normalizeRemoteErrorMessage(conversational)) {
      appendMessageToCurrentThread('assistant', normalizeRemoteErrorMessage(raw), { technical: true });
    }
    setStatus(conversational);
  } finally {
    stopRunPolling();
    setBusy(false);
    hardFocusPrompt();
  }
}

async function resumeLatestRun() {
  const resumable = state.runs.find((run) => run.state !== 'completed');
  if (!resumable) {
    setStatus('No resumable run found.');
    return;
  }
  if (resumable.state === 'needs_info') {
    const answers = (el.promptInput && el.promptInput.value.trim()) || '';
    if (!answers) {
      setStatus('Type your answers in the input box, then click Resume Last.');
      return;
    }
    el.promptInput.value = '';
    await resumeRunById(resumable.runId, { threadContext: answers });
    return;
  }
  await resumeRunById(resumable.runId);
}

let _refreshingModels = false;

async function refreshModels({ silent = false } = {}) {
  if (_refreshingModels) return; // prevent re-entrant calls
  _refreshingModels = true;
  setBusy(true);
  try {
    await saveSettingsPatch({
      provider: el.providerSelect.value,
      teamMode: el.teamModeSelect.value,
      baseUrl: el.baseUrlInput.value.trim(),
      model: state.model,
      workspaceRoot: el.workspaceRootInput.value.trim(),
    });

    const result = await window.geepus.listModels();
    renderModels(result.models, result.selectedModel);
    await saveSettingsPatch({ model: state.model });
    if (!silent) {
      setStatus(`Loaded ${result.models.length} model(s) for ${state.provider}. Selected ${result.selectedModel}.`);
    }
  } finally {
    setBusy(false);
    _refreshingModels = false;
  }
}

async function testConnection() {
  setBusy(true);
  try {
    await saveSettingsPatch({
      provider: el.providerSelect.value,
      teamMode: el.teamModeSelect.value,
      baseUrl: el.baseUrlInput.value.trim(),
      model: state.model,
      workspaceRoot: el.workspaceRootInput.value.trim(),
    });
    const result = await window.geepus.testConnector(state.model);
    el.responseModel.textContent = result.model ? `Provider: ${state.provider} • Model: ${result.model}` : '';
    setResponse(result.message || 'Connection test passed.');
    setStatus(`Connection test passed with ${result.model} (${state.provider}).`);
  } finally {
    setBusy(false);
  }
}

async function askGeepus({ planningOnly = false, promptOverride = '' } = {}) {
  const isLocal = state.provider === 'ollama';
  if (!state.apiKeyPresent && !isLocal) {
    setStatus('Please complete Step 1 first: connect Geepus.');
    el.apiKeyInput.focus();
    return;
  }

  const prompt = String(promptOverride || el.promptInput.value || '').trim();
  if (!prompt) {
    setStatus('Please type your request first.');
    hardFocusPrompt();
    return;
  }

  setBusy(true);
  setStatus(planningOnly ? 'Geepus is planning with you...' : 'Geepus is thinking...');
  setResponse(planningOnly ? 'Building your plan...' : 'Working on it...', { persist: false });

  try {
    const thread = ensureCurrentThread();
    const history = recentThreadMessagesForLLM(thread, 8, 400)
      .filter((item) => !(item.role === 'user' && item.content.toLowerCase() === prompt.toLowerCase()));

    await saveSettingsPatch({
      provider: el.providerSelect.value,
      teamMode: el.teamModeSelect.value,
      baseUrl: el.baseUrlInput.value.trim(),
      model: state.model,
      workspaceRoot: el.workspaceRootInput.value.trim(),
    });

    if (!state.model) {
      const modelResult = await window.geepus.listModels();
      renderModels(modelResult.models, modelResult.selectedModel);
      await saveSettingsPatch({ model: state.model });
    }

    const result = await window.geepus.askStreaming({
      prompt,
      model: state.model,
      provider: state.provider,
      baseUrl: state.baseUrl,
      mode: planningOnly ? 'planning' : 'chat',
      history,
    }, (delta) => {
      appendStreamChunk(delta);
    });

    el.responseModel.textContent = result.model ? `Provider: ${state.provider} • Model: ${result.model}` : '';
    setResponse(result.answer || '(No answer returned)');
    setStatus('Done.');
  } catch (error) {
    const raw = error.message || String(error);
    const conversational = buildConversationalErrorMessage(raw);
    setResponse(conversational);
    if (normalizeRemoteErrorMessage(raw) !== normalizeRemoteErrorMessage(conversational)) {
      appendMessageToCurrentThread('assistant', normalizeRemoteErrorMessage(raw), { technical: true });
    }
    setStatus(conversational);
  } finally {
    setBusy(false);
    hardFocusPrompt();
  }
}

async function runPrimaryAction() {
  const prompt = el.promptInput.value.trim();
  if (!prompt) {
    setStatus('Please type your request first.');
    hardFocusPrompt();
    return;
  }

  const continuationOnly = typeof isContinuationPrompt === 'function' && isContinuationPrompt(prompt);
  if (continuationOnly) {
    const resumable = state.runs.find((run) => run.state !== 'completed' && run.state !== 'needs_info');
    if (resumable) {
      appendMessageToCurrentThread('user', prompt);
      el.promptInput.value = '';
      await resumeRunById(resumable.runId);
      return;
    }
  }

  const thread = ensureCurrentThread();
  const executionMode = state.interactionMode === 'research' ? 'research'
    : state.interactionMode === 'auto' ? 'auto' : 'action';
  const resolvedTask = state.interactionMode === 'planning'
    ? prompt
    : resolveExecutionTaskPrompt(thread, prompt);
  let threadContext = buildThreadContextSnippet(thread, prompt, 20);

  // Build attachment context block from any dropped files
  const attachmentBlock = buildAttachmentContextBlock(state.attachedFiles);
  if (attachmentBlock) {
    threadContext = threadContext ? `${threadContext}\n\n${attachmentBlock}` : attachmentBlock;
  }
  // Clear attachments now — they've been folded into context
  if (state.attachedFiles.length > 0) {
    state.attachedFiles = [];
    if (typeof renderAttachmentChips === 'function') renderAttachmentChips();
  }

  appendMessageToCurrentThread('user', prompt);
  el.promptInput.value = '';

  if (state.interactionMode === 'planning') {
    await askGeepus({ planningOnly: true, promptOverride: attachmentBlock ? `${prompt}\n\n${attachmentBlock}` : prompt });
    return;
  }

  // Auto Mode: first run the learning auto-assist router.
  // It decides whether to answer now, ask for missing details, or launch the
  // full autonomous objective loop.
  if (state.interactionMode === 'auto') {
    let quickAckTimer = null;
    try {
      if (window.geepus && typeof window.geepus.autoAssist === 'function') {
        setStatus('Working on it...');
        quickAckTimer = window.setTimeout(() => {
          // Keep this occasional so the chat doesn't feel repetitive.
          if (Math.random() < 0.6) {
            setResponse(pickAutoCheckinLine(), { persist: false });
          }
        }, 1100);
        const isLikelyQuestion = /\?\s*$/.test(prompt)
          || /^(what|when|where|who|why|how|is|are|can|could|should|do|does)\b/i.test(prompt);
        const autoAssistTimeoutMs = isLikelyQuestion ? 25000 : 35000;
        const quick = await Promise.race([
          window.geepus.autoAssist({
            prompt: resolvedTask,
            model: state.model,
            provider: state.provider,
            baseUrl: state.baseUrl,
            threadContext,
          }),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Auto-assist timed out.')), autoAssistTimeoutMs);
          }),
        ]);
        const quickAnswer = String(quick?.answer || '').trim();
        if (quickAckTimer) {
          window.clearTimeout(quickAckTimer);
          quickAckTimer = null;
        }
        if (quick && quick.handled) {
          if (quick.route === 'plan') {
            // The auto-router decided this needs planning before execution.
            // We already appended the user message, so just ask Geepus to plan.
            await askGeepus({ planningOnly: true, promptOverride: prompt });
            return;
          } else if (quickAnswer) {
            setResponse(quickAnswer);
            setStatus(quick.needsInfo ? 'Needs your input.' : 'Done.');
            return;
          }
        }
      }
    } catch (error) {
      if (quickAckTimer) {
        window.clearTimeout(quickAckTimer);
        quickAckTimer = null;
      }
      const raw = String(error?.message || error || 'Auto-assist failed');
      const isLikelyQuestion = /\?\s*$/.test(prompt)
        || /^(what|when|where|who|why|how|is|are|can|could|should|do|does)\b/i.test(prompt);
      if (isLikelyQuestion) {
        try {
          const retry = await Promise.race([
            window.geepus.autoAssist({
              prompt: resolvedTask,
              model: state.model,
              provider: state.provider,
              baseUrl: state.baseUrl,
              threadContext: '',
            }),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('Retry timed out.')), 20000);
            }),
          ]);
          const retryAnswer = String(retry?.answer || '').trim();
          if (retry && retry.handled) {
            if (retry.route === 'plan') {
              await askGeepus({ planningOnly: true, promptOverride: prompt });
              return;
            } else if (retryAnswer) {
              setResponse(retryAnswer);
              setStatus(retry.needsInfo ? 'Needs your input.' : 'Done.');
              return;
            }
          }
        } catch {
          // Fall through to conversational fallback below.
        }
        setResponse('Sorry, I got stuck for a second. Ask again and I will answer directly.');
        setStatus('Auto-assist delayed. Ready to retry.');
        return;
      }
      // Fall through to full auto pipeline for execution-oriented requests.
    }
    if (quickAckTimer) {
      window.clearTimeout(quickAckTimer);
      quickAckTimer = null;
    }
    await runAgentTask({
      taskOverride: resolvedTask,
      executionMode,
      threadContext,
    });
    return;
  }

  // Action/Research mode is explicit user intent to execute. Keep routing simple:
  // only short-circuit file lookup questions; everything else runs the agent loop.
  if (isReportLookupPrompt(prompt)) {
    try {
      const handled = await answerFromRecentArtifacts(prompt);
      if (handled) return;
    } catch { /* fall through */ }
  }

  await runAgentTask({
    taskOverride: resolvedTask,
    executionMode,
    threadContext,
  });
}

async function runAgentTask(options = {}) {
  const isLocal = state.provider === 'ollama';
  if (!state.apiKeyPresent && !isLocal) {
    setStatus('Please complete Step 1 first: connect Geepus.');
    el.apiKeyInput.focus();
    return;
  }

  const task = String(options.taskOverride || el.promptInput.value || '').trim();
  if (!task) {
    setStatus('Please type your task first.');
    hardFocusPrompt();
    return;
  }

  const workspaceRoot = typeof options.workspaceOverride === 'string'
    ? options.workspaceOverride.trim()
    : el.workspaceRootInput.value.trim();
  const executionMode = options.executionMode === 'research'
    ? 'research'
    : options.executionMode === 'auto'
      ? 'auto'
      : 'action';
  const threadContext = String(options.threadContext || '').trim();
  const runningLabel = executionMode === 'research' ? 'research run' : 'autonomous run';
  const executingLabel = executionMode === 'research' ? 'researching your objective' : 'executing your objective';
  if (typeof options.workspaceOverride === 'string') {
    el.workspaceRootInput.value = workspaceRoot;
    state.workspaceRoot = workspaceRoot;
  }

  const thread = ensureCurrentThread();
  thread.objective = task;
  thread.workspaceRoot = workspaceRoot || thread.workspaceRoot;
  thread.runKey = threadKeyFromRun({
    objective: thread.objective || task,
    workspaceRoot: thread.workspaceRoot,
  });
  thread.updatedAt = new Date().toISOString();
  saveThreadsToStorage();
  renderThreads();

  setBusy(true);
  setStatus(`Starting ${runningLabel}...`);
  if (executionMode === 'auto') {
    setResponse('Understood. Taking point.', { persist: false });
    generateAutoModeKickoffMessage(task)
      .then((kickoff) => {
        const message = normalizeKickoffText(kickoff);
        if (!message) return;
        setResponse(message);
      })
      .catch(() => { });
  } else {
    setResponse(executionMode === 'research'
      ? 'Geepus is researching your objective...'
      : 'Geepus is running your objective...', { persist: false });
  }
  startRunPolling(executionMode === 'research' ? 'Geepus is researching'
    : executionMode === 'auto' ? 'Geepus is auto-executing' : 'Geepus is executing');
  state.runLimits = readRunLimitsFromInputs();
  const effectiveRunLimits = {
    ...state.runLimits,
    budgetLimit: thread && thread.budgetLimit !== undefined ? thread.budgetLimit : state.runLimits.budgetLimit
  };

  try {
    await saveSettingsPatch({
      provider: el.providerSelect.value,
      teamMode: el.teamModeSelect.value,
      baseUrl: el.baseUrlInput.value.trim(),
      model: state.model,
      workspaceRoot,
      runLimits: state.runLimits,
    });

    if (!state.model) {
      const modelResult = await window.geepus.listModels();
      renderModels(modelResult.models, modelResult.selectedModel);
      await saveSettingsPatch({ model: state.model });
    }

    setStatus(`Geepus is ${executingLabel}...`);
    const execution = await window.geepus.runAgentObjective({
      task,
      executionMode,
      model: state.model,
      provider: state.provider,
      executionCore: state.executionCore,
      teamMode: state.teamMode,
      baseUrl: state.baseUrl,
      workspaceRoot,
      allowRisky: false,
      runLimits: effectiveRunLimits,
      threadContext,
    });

    if (execution.model) {
      state.model = execution.model;
      if (el.modelSelect.value !== execution.model) {
        const known = Array.from(el.modelSelect.options).some((option) => option.value === execution.model);
        if (!known) {
          const option = document.createElement('option');
          option.value = execution.model;
          option.textContent = execution.model;
          el.modelSelect.appendChild(option);
        }
        el.modelSelect.value = execution.model;
      }
    }

    el.responseModel.textContent = execution.model
      ? `Provider: ${execution.provider || state.provider} • Model: ${execution.model}`
      : '';
    setResponse(formatObjectiveRunResult(execution));
    renderWorkflow(execution.workflow || {});
    renderReadiness(execution.readiness || null);
    renderActiveMemoryPanel(execution);
    const doneStatus = execution.state === 'completed'
      ? (executionMode === 'research' ? 'Research completed.'
        : executionMode === 'auto' ? 'Auto run completed.' : 'Objective completed.')
      : 'Objective stopped by limit or policy.';
    setStatus(doneStatus);
    await refreshRunList({ silent: true });
  } catch (error) {
    const raw = error.message || String(error);
    const conversational = buildConversationalErrorMessage(raw);
    setResponse(conversational);
    if (normalizeRemoteErrorMessage(raw) !== normalizeRemoteErrorMessage(conversational)) {
      appendMessageToCurrentThread('assistant', normalizeRemoteErrorMessage(raw), { technical: true });
    }
    setStatus(conversational);
  } finally {
    stopRunPolling();
    setBusy(false);
    hardFocusPrompt();
  }
}

async function openWatchTaskWindow(runIdOverride = '') {
  const selectedRunId = selectedThreadRunId();
  if (runIdOverride) {
    await window.geepus.openWatchTask({ runId: runIdOverride });
    return;
  }
  let runIdForWatch = '';
  try {
    const runs = await window.geepus.listAgentRuns();
    if (Array.isArray(runs) && runs.length > 0) {
      state.runs = runs;
      const preferred = selectedRunId
        ? runs.find((run) => String(run.runId || '').trim() === selectedRunId)
        : null;
      const active = runs.find((run) => run.state === 'running' || run.state === 'paused_approval' || run.state === 'needs_info');
      state.currentRunId = (preferred && preferred.runId) || (active && active.runId) || '';
      runIdForWatch = state.currentRunId || runs[0].runId || '';
    }
  } catch {
    // Fallback to cached run list.
  }
  const runId = runIdOverride || runIdForWatch || selectedRunId || state.currentRunId || (state.runs[0] && state.runs[0].runId) || '';
  await window.geepus.openWatchTask({ runId });
}

async function stopCurrentTask() {
  setStatus('Stopping task...');
  setResponse('Stopping current task...', { persist: false });
  try {
    const preferredRunId = selectedThreadRunId() || state.currentRunId || '';
    const result = await window.geepus.stopAgentObjective({ runId: preferredRunId });
    if (result && result.ok) {
      state.currentRunId = result.runId || state.currentRunId;
      setStatus('Stop requested. Geepus is shutting down this task.');
      setResponse(result.message || 'Stop requested.');
      await refreshRunList({ silent: true });
    } else {
      setStatus('No running task was found to stop.');
    }
  } catch (error) {
    setResponse(error.message || String(error), { technical: true });
    setStatus(error.message || String(error));
  }
}
