/**
 * renderer.js — Thin boot file: event wiring and application startup.
 *
 * All logic lives in the companion modules loaded before this file:
 *   renderer-state.js    — state, constants, DOM refs
 *   renderer-utils.js    — utility helpers
 *   renderer-markdown.js — text formatting
 *   renderer-intent.js   — prompt intent detection
 *   renderer-threads.js  — thread CRUD and storage
 *   renderer-chat.js     — message rendering
 *   renderer-settings.js — setup wizard, models, connection
 *   renderer-workflow.js — workflow board and run formatters
 *   renderer-actions.js  — API calls and agent operations
 */

/**
 * Hide or show the API-key row based on the provider. Ollama (local) doesn't
 * need a key, so we hide the entire row and change the connect button label.
 */
/**
 * Render the attachment chips row below the prompt textarea.
 */
function renderAttachmentChips() {
  const chips = el.attachmentChips;
  if (!chips) return;
  if (state.attachedFiles.length === 0) {
    chips.hidden = true;
    chips.innerHTML = '';
    return;
  }
  chips.hidden = false;
  chips.innerHTML = '';
  state.attachedFiles.forEach((file, idx) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    const icon = file.type === 'image' ? '\uD83D\uDDBC\uFE0F' : '\uD83D\uDCC4';
    chip.innerHTML = `<span class="attachment-chip-icon">${icon}</span><span class="attachment-chip-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span><button class="attachment-chip-remove" title="Remove" aria-label="Remove">\u00D7</button>`;
    chip.querySelector('.attachment-chip-remove').addEventListener('click', () => {
      state.attachedFiles.splice(idx, 1);
      renderAttachmentChips();
    });
    chips.appendChild(chip);
  });
}

/**
 * Read a dropped File object and append to state.attachedFiles.
 * Images are saved to ~/.geepus/attachments/ via IPC.
 * Text files are read inline.
 */
async function processDroppedFile(file) {
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml']);
  const MAX_TEXT_BYTES = 80000;

  if (IMAGE_TYPES.has(file.type) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name)) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    // Chunked base64 encoding — avoids RangeError on large files
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const base64 = btoa(binary);
    try {
      const result = await window.geepus.saveAttachment(file.name, base64);
      if (result && result.ok) {
        state.attachedFiles.push({ name: file.name, type: 'image', path: result.path, mimeType: file.type || 'image/png' });
      }
    } catch (err) {
      setStatus('Could not save attachment: ' + (err.message || String(err)));
    }
  } else {
    const text = await file.text().catch(() => null);
    if (text !== null) {
      state.attachedFiles.push({ name: file.name, type: 'text', content: text.slice(0, MAX_TEXT_BYTES) });
    }
  }
}

function updateApiKeyVisibility(provider) {
  const isLocal = provider === 'ollama';
  const keyLabel = document.querySelector('.key-label');
  if (keyLabel) keyLabel.hidden = isLocal;
  if (el.saveKeyButton) {
    el.saveKeyButton.textContent = isLocal ? 'Connect to Ollama' : 'Connect Geepus';
  }
}

function applyPromptTemplate(button) {
  if (!(button instanceof HTMLElement) || !el.promptInput) return;
  const prompt = String(button.dataset.prompt || '').trim();
  if (!prompt) return;
  el.promptInput.value = prompt;
  hardFocusPrompt();
  setStatus('Prompt loaded. Edit it or run it now.');
  if (button.dataset.runNow === 'true') {
    runPrimaryAction().catch((error) => {
      setStatus(error.message || String(error));
    });
  }
}

function installEvents() {
  el.refreshRunsButton.addEventListener('click', () => {
    refreshRunList().catch((error) => {
      setStatus(error.message || String(error));
    });
  });
  el.resumeRunButton.addEventListener('click', () => {
    resumeLatestRun().catch((error) => {
      setStatus(error.message || String(error));
    });
  });
  el.watchTaskButton.addEventListener('click', () => {
    openWatchTaskWindow().catch((error) => {
      setStatus(error.message || String(error));
    });
  });
  el.newThreadButton.addEventListener('click', () => {
    const hadActiveRun = Array.isArray(state.runs)
      && state.runs.some((run) => run.state === 'running' || run.state === 'paused_approval' || run.state === 'needs_info');
    createNewThread();
    state.currentRunId = '';
    el.promptInput.value = '';
    setStatus(hadActiveRun
      ? 'Started a new thread. Another task is still active in a different thread.'
      : 'Started a new thread.');
    hardFocusPrompt();
  });
  el.threadSearchInput.addEventListener('input', () => {
    state.threadQuery = el.threadSearchInput.value || '';
    renderThreads();
  });

  if (el.threadBudgetInput) {
    el.threadBudgetInput.addEventListener('change', () => {
      const thread = ensureCurrentThread();
      if (thread) {
        thread.budgetLimit = Math.max(0, Number(el.threadBudgetInput.value) || 0);
        saveThreadsToStorage();
      }
    });
  }

  el.askButton.addEventListener('click', () => {
    runPrimaryAction().catch((error) => {
      setStatus(error.message || String(error));
    });
  });
  el.planningModeButton.addEventListener('click', () => {
    setInteractionMode('planning');
    setStatus(INTERACTION_MODES.planning.status);
  });
  el.researchModeButton.addEventListener('click', () => {
    setInteractionMode('research');
    setStatus(INTERACTION_MODES.research.status);
  });
  el.actionModeButton.addEventListener('click', () => {
    setInteractionMode('action');
    setStatus(INTERACTION_MODES.action.status);
  });
  el.autoModeButton.addEventListener('click', () => {
    setInteractionMode('auto');
    setStatus(INTERACTION_MODES.auto.status);
  });

  el.promptInput.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      runPrimaryAction().catch((error) => {
        setStatus(error.message || String(error));
      });
    }
  });

  el.clearPromptButton.addEventListener('click', () => {
    el.promptInput.value = '';
    hardFocusPrompt();
  });

  el.stopTaskButton.addEventListener('click', () => {
    stopCurrentTask().catch((error) => {
      setStatus(error.message || String(error));
    });
  });

  el.showSetupButton.addEventListener('click', () => {
    state.showSetupPanels = !state.showSetupPanels;
    updateSetupWizard();
    if (state.showSetupPanels) {
      openSettingsPanel();
    }
  });
  el.openSettingsPageButton.addEventListener('click', () => {
    openSettingsPanel();
  });
  el.closeSettingsPageButton.addEventListener('click', () => {
    closeSettingsPanel();
  });

  if (el.openSettingsFromSetup) {
    el.openSettingsFromSetup.addEventListener('click', () => {
      openSettingsPanel();
      if (typeof setSettingsTab === 'function') {
        setSettingsTab('core', { persist: true, refresh: true });
      }
    });
  }

  // Close settings page with Escape key
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && el.settingsPage && !el.settingsPage.hidden) {
      closeSettingsPanel();
    }
  });

  document.addEventListener('click', (event) => {
    const button = event.target instanceof HTMLElement
      ? event.target.closest('.quick-command, .capability-tile')
      : null;
    if (button) {
      applyPromptTemplate(button);
    }
  });

  el.toggleOpenAiKeyButton.addEventListener('click', () => {
    const isPassword = el.openaiApiKeyInput.type === 'password';
    el.openaiApiKeyInput.type = isPassword ? 'text' : 'password';
    el.toggleOpenAiKeyButton.textContent = isPassword ? 'Hide' : 'Show';
    el.openaiApiKeyInput.focus({ preventScroll: true });
  });

  el.toggleAnthropicKeyButton.addEventListener('click', () => {
    const isPassword = el.anthropicApiKeyInput.type === 'password';
    el.anthropicApiKeyInput.type = isPassword ? 'text' : 'password';
    el.toggleAnthropicKeyButton.textContent = isPassword ? 'Hide' : 'Show';
    el.anthropicApiKeyInput.focus({ preventScroll: true });
  });

  el.saveKeyButton.addEventListener('click', async () => {
    const provider = el.providerSelect.value;
    const isLocal = provider === 'ollama';
    const MASK = '••••••••';
    const openaiRaw = el.openaiApiKeyInput.value.trim();
    const anthropicRaw = el.anthropicApiKeyInput.value.trim();
    // If an input still contains the masked placeholder, do not overwrite
    // the stored key. Passing empty string preserves the existing key.
    const openaiKey = openaiRaw === MASK ? '' : openaiRaw;
    const anthropicKey = anthropicRaw === MASK ? '' : anthropicRaw;

    try {
      setBusy(true);
      const patch = {
        provider,
        teamMode: el.teamModeSelect.value,
        baseUrl: isLocal ? 'http://localhost:11434/v1' : el.baseUrlInput.value.trim(),
        workspaceRoot: el.workspaceRootInput.value.trim(),
        apiKeys: {
          openai: openaiKey,
          anthropic: anthropicKey,
        }
      };
      await saveSettingsPatch(patch);
      if (isLocal) {
        state.apiKeyPresent = true;
        updateConnectionBadge();
        // Trigger the full Ollama setup flow
        await refreshOllamaStatus();
        return;
      }
      el.openaiApiKeyInput.value = '';
      el.anthropicApiKeyInput.value = '';
      // Test the connection and show result
      setConnectionBadge('testing', 'Testing connection…');
      setStatus('Verifying API keys…');
      try {
        const results = await window.geepus.testConnector();
        setConnectionBadgeFromResults(Array.isArray(results) ? results : [results]);
        setStatus('Connected. Loading your available models…');
        await refreshModels({ silent: true });
        setStatus('Setup complete. You can start a task now.');
        hardFocusPrompt();
      } catch (testErr) {
        setConnectionBadge('error', 'Connection failed', testErr.message || String(testErr));
        setStatus(testErr.message || String(testErr));
      }
    } catch (error) {
      setStatus(error.message || String(error));
    } finally {
      setBusy(false);
    }
  });

  el.clearKeyButton.addEventListener('click', async () => {
    try {
      setBusy(true);
      const next = await window.geepus.clearKey();
      state.apiKeyPresent = Boolean(next.apiKeyPresent);
      if (el.openaiApiKeyInput) el.openaiApiKeyInput.value = '';
      if (el.anthropicApiKeyInput) el.anthropicApiKeyInput.value = '';
      updateConnectionBadge();
      renderModels([], '');
      setStatus('Connection removed.');
    } catch (error) {
      setStatus(error.message || String(error));
    } finally {
      setBusy(false);
      hardFocusPrompt();
    }
  });

  el.listModelsButton.addEventListener('click', () => {
    refreshModels().catch((error) => {
      setStatus(error.message || String(error));
    });
  });
  el.refreshModelsInlineButton.addEventListener('click', () => {
    refreshModels().catch((error) => {
      setStatus(error.message || String(error));
    });
  });

  el.providerSelect.addEventListener('change', async () => {
    try {
      setBusy(true);
      const provider = el.providerSelect.value;
      updateApiKeyVisibility(provider);
      const next = await saveSettingsPatch({ provider });
      state.provider = next.provider || state.provider;
      state.baseUrl = next.baseUrl || state.baseUrl;

      // Auto-apply relaxed limits for local models, default limits otherwise
      const effectiveDefaults = state.provider === 'ollama' ? LOCAL_RUN_LIMITS : DEFAULT_RUN_LIMITS;
      state.runLimits = normalizeRunLimits(effectiveDefaults);
      applyRunLimitsToInputs(state.runLimits);
      saveSettingsPatch({ runLimits: state.runLimits });

      setStatus(`Service set to ${state.provider}.`);

      if (provider === 'ollama') {
        // Show the local models panel and check Ollama status
        await refreshOllamaStatus();
      } else {
        renderLocalModelsPanel();
        await refreshModels({ silent: true });
        setStatus('Models refreshed for selected service.');
      }
    } catch (error) {
      setStatus(error.message || String(error));
    } finally {
      setBusy(false);
    }
  });

  el.teamModeSelect.addEventListener('change', async () => {
    state.teamMode = el.teamModeSelect.value;
    try {
      await saveSettingsPatch({ teamMode: state.teamMode });
      const labels = { all: 'All Agents', dev: 'Dev Team', marketing: 'Marketing Team', ops: 'Ops & Cost Team', solo: 'Solo mode' };
      setStatus(`Agent team set to ${labels[state.teamMode] || state.teamMode}.`);
    } catch (error) {
      setStatus(error.message || String(error));
    }
  });

  if (el.executionCoreSelect) {
    el.executionCoreSelect.addEventListener('change', async () => {
      state.executionCore = el.executionCoreSelect.value || 'geepus';
      try {
        await saveSettingsPatch({ executionCore: state.executionCore });
        const label = state.executionCore === 'geepus' ? 'Geepus Classic' : state.executionCore;
        setStatus(`Execution core set to ${label}.`);
      } catch (error) {
        setStatus(error.message || String(error));
      }
    });
  }

  const runLimitInputs = [
    el.limitMaxRuntimeMinutes,
    el.limitBudgetLimit,
    el.limitMaxIterations,
    el.limitMaxActions,
    el.limitMaxModelCallsPerMinute,
    el.limitMaxToolCallsPerMinute,
    el.limitIdleTimeoutSeconds,
    el.limitConsecutiveDriftLimit,
  ];
  runLimitInputs.forEach((input) => {
    input.addEventListener('change', () => {
      scheduleRunLimitsSave();
    });
  });

  el.modelSelect.addEventListener('change', async () => {
    state.model = el.modelSelect.value;
    syncModelSelectors(state.model);
    try {
      await saveSettingsPatch({ model: state.model });
      setStatus(`Selected ${state.model}.`);
    } catch (error) {
      setStatus(error.message || String(error));
    }
  });
  el.modelQuickSelect.addEventListener('change', async () => {
    state.model = el.modelQuickSelect.value;
    syncModelSelectors(state.model);
    try {
      await saveSettingsPatch({ model: state.model });
      setStatus(`Selected ${state.model}.`);
    } catch (error) {
      setStatus(error.message || String(error));
    }
  });

  el.workspaceRootInput.addEventListener('change', async () => {
    state.workspaceRoot = el.workspaceRootInput.value.trim();
    try {
      await saveSettingsPatch({ workspaceRoot: state.workspaceRoot });
      setStatus(state.workspaceRoot
        ? 'Project folder saved.'
        : 'Auto-find enabled.');
    } catch (error) {
      setStatus(error.message || String(error));
    }
  });

  el.useAutoFindButton.addEventListener('click', async () => {
    try {
      state.workspaceRoot = '';
      el.workspaceRootInput.value = '';
      await saveSettingsPatch({ workspaceRoot: '' });
      setStatus('Auto-find enabled. Geepus will locate relevant project files automatically.');
    } catch (error) {
      setStatus(error.message || String(error));
    }
  });

  if (el.braveSearchApiKeyInput) {
    el.braveSearchApiKeyInput.addEventListener('change', async () => {
      const val = el.braveSearchApiKeyInput.value.trim();
      if (val && val !== '••••••••') {
        try {
          await saveSettingsPatch({ braveSearchApiKey: val });
          el.braveSearchApiKeyInput.value = '••••••••';
          setStatus('Brave Search API key saved. web_search tool is now active.');
        } catch (error) {
          setStatus(error.message || String(error));
        }
      }
    });
  }

  if (el.firecrawlApiKeyInput) {
    el.firecrawlApiKeyInput.addEventListener('change', async () => {
      const val = el.firecrawlApiKeyInput.value.trim();
      if (val && val !== '••••••••') {
        try {
          await saveSettingsPatch({ firecrawlApiKey: val });
          el.firecrawlApiKeyInput.value = '••••••••';
          setStatus('Firecrawl API key saved. web_fetch tool is now active for anti-bot bypass.');
        } catch (error) {
          setStatus(error.message || String(error));
        }
      }
    });
  }

  el.testButton.addEventListener('click', () => {
    testConnection().catch((error) => {
      setStatus(error.message || String(error));
    });
  });

  el.restartButton.addEventListener('click', async () => {
    setStatus('Restarting app...');
    await window.geepus.restartApp();
  });

  // ── Attach files button (reliable alternative to drag-and-drop) ──
  if (el.attachFileButton && el.attachFileInput) {
    el.attachFileButton.addEventListener('click', () => {
      el.attachFileInput.value = '';
      el.attachFileInput.click();
    });

    el.attachFileInput.addEventListener('change', async () => {
      const files = Array.from(el.attachFileInput.files || []);
      if (files.length === 0) return;
      setStatus(`Processing ${files.length} file(s)...`);
      for (const file of files) {
        await processDroppedFile(file);
      }
      el.attachFileInput.value = '';
      renderAttachmentChips();
      setStatus(state.attachedFiles.length > 0
        ? `${state.attachedFiles.length} file(s) attached — type your message and submit.`
        : 'Ready.');
      el.promptInput.focus();
    });
  }

  // ── Attachment drag-and-drop ──
  // Use capture phase (true) so our handlers fire before any internal Electron
  // handlers, and return false to stop propagation in addition to preventDefault.
  document.addEventListener('dragover', (e) => { e.preventDefault(); return false; }, true);
  document.addEventListener('drop', (e) => { e.preventDefault(); return false; }, true);

  // Full-window file drop handler
  let dragCounter = 0;

  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragCounter++;
    if (el.dropOverlay) el.dropOverlay.hidden = false;
  }, true);

  document.addEventListener('dragleave', (e) => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      if (el.dropOverlay) el.dropOverlay.hidden = true;
    }
  }, true);

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    if (el.dropOverlay) el.dropOverlay.hidden = true;

    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length === 0) return;

    setStatus(`Processing ${files.length} file(s)...`);
    for (const file of files) {
      await processDroppedFile(file);
    }
    renderAttachmentChips();
    setStatus(state.attachedFiles.length > 0 ? `${state.attachedFiles.length} file(s) attached — type your message and submit.` : 'Ready.');
    el.promptInput.focus();
  }, true);

  // --- Integration settings ---
  const saveGithubButton = document.getElementById('saveGithubButton');
  const saveWebhookButton = document.getElementById('saveWebhookButton');
  const testWebhookButton = document.getElementById('testWebhookButton');
  const saveEmailButton = document.getElementById('saveEmailButton');

  if (saveGithubButton) {
    saveGithubButton.addEventListener('click', async () => {
      const token = document.getElementById('githubTokenInput').value.trim();
      const repo = document.getElementById('githubDefaultRepoInput').value.trim();
      try {
        await saveSettingsPatch({ integrations: { githubToken: token, githubDefaultRepo: repo } });
        document.getElementById('githubTokenInput').value = token ? '••••••••' : '';
        setStatus('GitHub settings saved.');
      } catch (e) { setStatus(e.message); }
    });
  }

  if (saveWebhookButton) {
    saveWebhookButton.addEventListener('click', async () => {
      const url = document.getElementById('webhookUrlInput').value.trim();
      try {
        await saveSettingsPatch({ integrations: { webhookUrl: url } });
        setStatus('Webhook URL saved.');
      } catch (e) { setStatus(e.message); }
    });
  }

  if (testWebhookButton) {
    testWebhookButton.addEventListener('click', async () => {
      const url = document.getElementById('webhookUrlInput').value.trim();
      try {
        await window.geepus.testWebhook(url);
        setStatus('Webhook test sent successfully!');
      } catch (e) { setStatus('Webhook test failed: ' + e.message); }
    });
  }

  if (saveEmailButton) {
    saveEmailButton.addEventListener('click', async () => {
      const apiUrl = document.getElementById('emailApiUrlInput').value.trim();
      const apiKey = document.getElementById('emailApiKeyInput').value.trim();
      const emailTo = document.getElementById('emailToInput').value.trim();
      try {
        await saveSettingsPatch({ integrations: { emailApiUrl: apiUrl, emailApiKey: apiKey, emailTo: emailTo } });
        if (apiKey) document.getElementById('emailApiKeyInput').value = '••••••••';
        setStatus('Email settings saved.');
      } catch (e) { setStatus(e.message); }
    });
  }

  // --- Web Identity settings ---
  const saveIdentityButton = document.getElementById('saveIdentityButton');
  const toggleIdentityPasswordButton = document.getElementById('toggleIdentityPasswordButton');
  const toggleResendApiKeyButton = document.getElementById('toggleResendApiKeyButton');

  if (toggleIdentityPasswordButton) {
    toggleIdentityPasswordButton.addEventListener('click', () => {
      const pwInput = document.getElementById('identityEmailPasswordInput');
      if (!pwInput) return;
      const isPassword = pwInput.type === 'password';
      pwInput.type = isPassword ? 'text' : 'password';
      toggleIdentityPasswordButton.textContent = isPassword ? 'Hide' : 'Show';
      pwInput.focus({ preventScroll: true });
    });
  }

  if (toggleResendApiKeyButton) {
    toggleResendApiKeyButton.addEventListener('click', () => {
      const keyInput = document.getElementById('identityResendApiKeyInput');
      if (!keyInput) return;
      const isPassword = keyInput.type === 'password';
      keyInput.type = isPassword ? 'text' : 'password';
      toggleResendApiKeyButton.textContent = isPassword ? 'Hide' : 'Show';
      keyInput.focus({ preventScroll: true });
    });
  }

  if (saveIdentityButton) {
    saveIdentityButton.addEventListener('click', async () => {
      const email = (document.getElementById('identityEmailInput')?.value || '').trim();
      const emailPassword = (document.getElementById('identityEmailPasswordInput')?.value || '').trim();
      const emailVerificationMode = (document.getElementById('identityEmailVerificationModeSelect')?.value || 'webmail').trim().toLowerCase() === 'resend'
        ? 'resend'
        : 'webmail';
      const resendInboxApiUrl = (document.getElementById('identityResendInboxApiUrlInput')?.value || '').trim();
      const resendApiKey = (document.getElementById('identityResendApiKeyInput')?.value || '').trim();
      const resendApiBaseUrl = (document.getElementById('identityResendApiBaseUrlInput')?.value || '').trim();
      const resendFromFilter = (document.getElementById('identityResendFromFilterInput')?.value || '').trim();
      const displayName = (document.getElementById('identityDisplayNameInput')?.value || '').trim();
      const usernamePreference = (document.getElementById('identityUsernameInput')?.value || '').trim();
      const phoneNumber = (document.getElementById('identityPhoneInput')?.value || '').trim();
      const birthDate = (document.getElementById('identityBirthDateInput')?.value || '').trim();
      const generateStrongPasswords = document.getElementById('identityStrongPasswordsToggle')?.checked !== false;

      const patch = {
        email,
        displayName,
        usernamePreference,
        phoneNumber,
        birthDate,
        generateStrongPasswords,
        emailVerificationMode,
        resendInboxApiUrl,
        resendApiBaseUrl,
        resendFromFilter,
      };
      // Only include password if it was actually changed (not the masked placeholder)
      if (emailPassword && emailPassword !== '••••••••') {
        patch.emailPassword = emailPassword;
      }
      if (resendApiKey && resendApiKey !== '••••••••') {
        patch.resendApiKey = resendApiKey;
      }

      try {
        await saveSettingsPatch({ webIdentity: patch });
        const pwInput = document.getElementById('identityEmailPasswordInput');
        const resendApiKeyInput = document.getElementById('identityResendApiKeyInput');
        if (pwInput && emailPassword && emailPassword !== '••••••••') {
          pwInput.value = '••••••••';
          pwInput.type = 'password';
          if (toggleIdentityPasswordButton) toggleIdentityPasswordButton.textContent = 'Show';
        }
        if (resendApiKeyInput && resendApiKey && resendApiKey !== '••••••••') {
          resendApiKeyInput.value = '••••••••';
          resendApiKeyInput.type = 'password';
          if (toggleResendApiKeyButton) toggleResendApiKeyButton.textContent = 'Show';
        }
        setStatus('Web identity saved.');
      } catch (e) { setStatus(e.message); }
    });
  }
}

(async function boot() {
  installEvents();
  installSchedulerEvents();
  installMemoryEvents();
  if (typeof installLearningEvents === 'function') installLearningEvents();
  installViewerEvents();
  installPipelineEvents();
  initCostDashboard();
  installProjectManagerEvents();
  installLocalModelEvents();
  if (typeof installVoiceEvents === 'function') installVoiceEvents();
  installFocusGuards();
  restoreInteractionMode();

  try {
    await loadInitialState();
    updateApiKeyVisibility(state.provider);
    await refreshSchedulerData();
    await refreshMemoryStats();
    if (typeof refreshLearningPanel === 'function') await refreshLearningPanel();
    await refreshPipelineData();
    if (state.provider === 'ollama') {
      await refreshOllamaStatus();
    }
  } catch (error) {
    setStatus(error.message || String(error));
  }

  hardFocusPrompt();
})();

// ---------------------------------------------------------------------------
// External link handler — open http(s)/file:// links in the user's browser
// ---------------------------------------------------------------------------
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
