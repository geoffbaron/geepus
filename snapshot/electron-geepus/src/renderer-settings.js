/**
 * renderer-settings.js — Setup wizard, model selectors, connection badge, and
 *   interaction mode switching.
 *
 * Depends on: renderer-state.js (state, el, INTERACTION_MODES, DEFAULT_RUN_LIMITS)
 *             renderer-utils.js (setStatus, normalizeRunLimits, applyRunLimitsToInputs,
 *                                hardFocusPrompt)
 *             renderer-threads.js (renderThreads, loadThreadsFromStorage, ensureCurrentThread,
 *                                  saveThreadsToStorage)
 *             renderer-chat.js (renderCurrentThread)
 */

function updateSetupPanelVisibility(setupComplete) {
  // Welcome card hides once setup is done (connection controls are in Settings page now)
  if (el.quickSetupCard) {
    el.quickSetupCard.hidden = setupComplete;
  }
  if (el.showSetupButton) {
    el.showSetupButton.hidden = true;  // No longer needed — provider controls live in Settings page
  }
}

const SETTINGS_TAB_STORAGE_KEY = 'geepus_settings_tab_v1';

function currentSettingsTab() {
  const active = document.querySelector('.settings-tab-btn.active');
  return String(active?.dataset?.settingsTabTarget || 'core').trim() || 'core';
}

function refreshSettingsTabData(tabName = 'core') {
  const tab = String(tabName || 'core').trim().toLowerCase();
  if (tab === 'learning') {
    if (typeof refreshMemoryStats === 'function') refreshMemoryStats();
    if (typeof refreshLearningPanel === 'function') refreshLearningPanel();
    if (typeof refreshKnowledgeViewer === 'function') refreshKnowledgeViewer();
    return;
  }
  if (tab === 'automation') {
    if (typeof refreshSchedulerData === 'function') refreshSchedulerData();
    if (typeof refreshPipelineData === 'function') refreshPipelineData();
    return;
  }
  if (tab === 'security') {
    if (typeof refreshSecurityViewer === 'function') refreshSecurityViewer();
    return;
  }
  if (tab === 'operations') {
    if (typeof renderCostDashboard === 'function') renderCostDashboard();
    if (typeof renderProjectList === 'function') renderProjectList();
    return;
  }
  if (tab === 'voice') {
    // Voice panel needs device list and support check refreshed
    if (typeof refreshVoiceDevices === 'function') refreshVoiceDevices();
    return;
  }
  if (tab === 'integrations' || tab === 'identity') {
    // Static forms — no dynamic data to refresh
    return;
  }
  if (tab === 'models') {
    // Always trigger Ollama status check when the Local Models tab is opened
    if (typeof refreshOllamaStatus === 'function') refreshOllamaStatus();
    return;
  }
  // Core tab
  if (state.provider === 'ollama' && typeof refreshOllamaStatus === 'function') {
    refreshOllamaStatus();
  }
}

function setSettingsTab(nextTab, { persist = true, refresh = true } = {}) {
  const tab = String(nextTab || 'core').trim().toLowerCase() || 'core';
  const buttons = Array.from(document.querySelectorAll('.settings-tab-btn[data-settings-tab-target]'));
  const panels = Array.from(document.querySelectorAll('.settings-tab-panel[data-settings-tab]'));
  if (buttons.length === 0 || panels.length === 0) return;

  const supported = new Set(buttons.map((btn) => String(btn.dataset.settingsTabTarget || '').trim().toLowerCase()).filter(Boolean));
  const effective = supported.has(tab) ? tab : 'core';

  buttons.forEach((button) => {
    const isActive = String(button.dataset.settingsTabTarget || '').trim().toLowerCase() === effective;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  panels.forEach((panel) => {
    const panelTab = String(panel.dataset.settingsTab || '').trim().toLowerCase();
    panel.hidden = panelTab !== effective;
  });

  if (persist) {
    try {
      window.localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, effective);
    } catch {
      // Ignore storage failures.
    }
  }
  if (refresh) {
    refreshSettingsTabData(effective);
  }
}

function installSettingsTabs() {
  const buttons = Array.from(document.querySelectorAll('.settings-tab-btn[data-settings-tab-target]'));
  if (buttons.length === 0) return;
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const target = String(button.dataset.settingsTabTarget || 'core');
      setSettingsTab(target, { persist: true, refresh: true });
    });
  });
}

function openSettingsPanel() {
  state.showSetupPanels = true;
  updateSetupWizard();
  if (el.settingsPage) {
    el.settingsPage.hidden = false;
  }
  const activeTab = currentSettingsTab();
  setSettingsTab(activeTab || 'core', { persist: false, refresh: true });
  setStatus('Settings opened.');
  if (el.modelQuickSelect && !el.modelQuickSelect.disabled) {
    el.modelQuickSelect.focus({ preventScroll: true });
    return;
  }
  if (el.modelSelect && !el.modelSelect.disabled) {
    el.modelSelect.focus({ preventScroll: true });
  }
}

function closeSettingsPanel() {
  if (el.settingsPage) {
    el.settingsPage.hidden = true;
  }
  setStatus('Settings closed.');
  hardFocusPrompt();
}

function setBusy(isBusy) {
  state.working = isBusy;

  el.askButton.disabled = isBusy;
  el.refreshRunsButton.disabled = isBusy;
  el.resumeRunButton.disabled = isBusy;
  el.watchTaskButton.disabled = false;
  el.listModelsButton.disabled = isBusy;
  el.refreshModelsInlineButton.disabled = isBusy;
  el.testButton.disabled = isBusy;
  el.providerSelect.disabled = isBusy;
  if (el.executionCoreSelect) el.executionCoreSelect.disabled = isBusy;
  el.teamModeSelect.disabled = isBusy;
  el.modelQuickSelect.disabled = isBusy;
  el.limitMaxRuntimeMinutes.disabled = isBusy;
  el.limitMaxIterations.disabled = isBusy;
  el.limitMaxActions.disabled = isBusy;
  el.limitMaxModelCallsPerMinute.disabled = isBusy;
  el.limitMaxToolCallsPerMinute.disabled = isBusy;
  el.limitIdleTimeoutSeconds.disabled = isBusy;
  el.limitConsecutiveDriftLimit.disabled = isBusy;
  if (el.securityHighRiskDuration) el.securityHighRiskDuration.disabled = isBusy;
  if (el.securityHighRiskAllowButton) el.securityHighRiskAllowButton.disabled = isBusy;
  if (el.securityHighRiskRevokeButton) el.securityHighRiskRevokeButton.disabled = isBusy;
  if (el.securityBrowserDuration) el.securityBrowserDuration.disabled = isBusy;
  if (el.securityBrowserAllowButton) el.securityBrowserAllowButton.disabled = isBusy;
  if (el.securityBrowserRevokeButton) el.securityBrowserRevokeButton.disabled = isBusy;
  if (el.securityInternetDuration) el.securityInternetDuration.disabled = isBusy;
  if (el.securityInternetAllowButton) el.securityInternetAllowButton.disabled = isBusy;
  if (el.securityInternetRevokeButton) el.securityInternetRevokeButton.disabled = isBusy;
  if (el.securityRemoteDuration) el.securityRemoteDuration.disabled = isBusy;
  if (el.securityRemoteAllowButton) el.securityRemoteAllowButton.disabled = isBusy;
  if (el.securityRemoteRevokeButton) el.securityRemoteRevokeButton.disabled = isBusy;
  if (el.voiceEnabledToggle) el.voiceEnabledToggle.disabled = isBusy;
  if (el.voiceAutoSpeakToggle) el.voiceAutoSpeakToggle.disabled = isBusy || !state.voice?.enabled;
  if (el.voiceAutoSendToggle) el.voiceAutoSendToggle.disabled = isBusy || !state.voice?.enabled;
  if (el.voiceRealtimeToggle) el.voiceRealtimeToggle.disabled = isBusy || !state.voice?.enabled;
  if (el.voiceTranscriptionModelSelect) el.voiceTranscriptionModelSelect.disabled = isBusy || !state.voice?.enabled;
  if (el.voiceNameSelect) el.voiceNameSelect.disabled = isBusy || !state.voice?.enabled;
  if (el.voiceInputDeviceSelect) el.voiceInputDeviceSelect.disabled = isBusy || !state.voice?.enabled;
  if (el.voiceRefreshDevicesButton) el.voiceRefreshDevicesButton.disabled = isBusy || !state.voice?.enabled;
  if (el.voiceReplyStyleSelect) el.voiceReplyStyleSelect.disabled = isBusy || !state.voice?.enabled;
  if (el.voiceRateInput) el.voiceRateInput.disabled = isBusy || !state.voice?.enabled;
  if (el.learningApplyButton) el.learningApplyButton.disabled = isBusy;
  if (el.learningRefreshButton) el.learningRefreshButton.disabled = isBusy;
  if (el.learningResetSkillsButton) el.learningResetSkillsButton.disabled = isBusy;
  if (el.learningResetStrategiesButton) el.learningResetStrategiesButton.disabled = isBusy;
  if (el.learningMemoryFlushToggle) el.learningMemoryFlushToggle.disabled = isBusy;
  if (el.learningSessionMemoryToggle) el.learningSessionMemoryToggle.disabled = isBusy;
  if (el.learningSourceMemoryToggle) el.learningSourceMemoryToggle.disabled = isBusy;
  if (el.learningSourceSessionsToggle) el.learningSourceSessionsToggle.disabled = isBusy;
  if (el.learningAutoSkillReviewToggle) el.learningAutoSkillReviewToggle.disabled = isBusy;
  if (el.learningDefaultLocationInput) el.learningDefaultLocationInput.disabled = isBusy;
  if (el.learningStrategiesInput) el.learningStrategiesInput.disabled = isBusy;
  if (el.learningGlobalNotesInput) el.learningGlobalNotesInput.disabled = isBusy;
  el.useAutoFindButton.disabled = isBusy;
  el.planningModeButton.disabled = isBusy;
  el.researchModeButton.disabled = isBusy;
  el.actionModeButton.disabled = isBusy;
  updateStopButton();
  if (typeof updateVoiceMicButton === 'function') updateVoiceMicButton();
  updateSetupWizard();
  renderThreads();
  if (typeof renderMissionControl === 'function') {
    renderMissionControl();
  }
}

function updateStopButton() {
  const canStop = state.working || Boolean(state.currentRunId);
  el.stopTaskButton.disabled = !canStop;
}

function updateConnectionBadge() {
  const isLocal = state.provider === 'ollama';
  if (state.apiKeyPresent || isLocal) {
    el.connectionBadge.textContent = isLocal ? 'Local' : 'Connected';
    el.connectionBadge.classList.remove('badge-warn');
    el.connectionBadge.classList.add('badge-ok');
  } else {
    el.connectionBadge.textContent = 'Not connected';
    el.connectionBadge.classList.remove('badge-ok');
    el.connectionBadge.classList.add('badge-warn');
  }
  if (typeof renderMissionControl === 'function') {
    renderMissionControl();
  }
}

function setStepPill(node, ready, text) {
  node.textContent = text;
  node.classList.remove('ready', 'pending');
  node.classList.add(ready ? 'ready' : 'pending');
}

function updateSetupWizard() {
  const isLocal = state.provider === 'ollama';
  const keyReady = state.apiKeyPresent || isLocal;
  const modelReady = keyReady && Boolean(state.model);
  const setupComplete = keyReady;
  const projectCustom = Boolean((state.workspaceRoot || '').trim());

  if (setupComplete && !state.setupComplete) {
    state.showSetupPanels = false;
  }
  state.setupComplete = setupComplete;

  setStepPill(el.stepKeyStatus, keyReady, keyReady ? 'Done' : 'Not ready');
  setStepPill(el.stepModelStatus, modelReady, modelReady ? 'Done' : 'Not ready');
  setStepPill(el.stepProjectStatus, true, projectCustom ? 'Custom folder' : 'Auto-find');

  if (!keyReady) {
    el.setupProgress.textContent = 'Step 1 of 3';
  } else if (!modelReady) {
    el.setupProgress.textContent = 'Connected (model can be auto-selected)';
  } else {
    el.setupProgress.textContent = projectCustom ? 'Setup complete' : 'Ready (Auto-find enabled)';
  }
  updateSetupPanelVisibility(setupComplete);
  if (!state.working) {
    el.askButton.disabled = !keyReady;
  }
}

function setInteractionMode(mode) {
  // Main UI is now always autonomous — Geepus decides plan/research/action.
  state.interactionMode = 'auto';
  const isPlanning = false;
  const isResearch = false;
  const isAuto = true;
  const config = INTERACTION_MODES.auto;

  try {
    window.localStorage.setItem('geepus_interaction_mode', 'auto');
  } catch {
    // Ignore storage issues.
  }

  el.planningModeButton.classList.toggle('active', isPlanning);
  el.researchModeButton.classList.toggle('active', isResearch);
  el.actionModeButton.classList.toggle('active', state.interactionMode === 'action');
  el.autoModeButton.classList.toggle('active', isAuto);
  el.askButton.textContent = config.buttonLabel;
  el.modeDescription.textContent = config.description;
  if (typeof renderMissionControl === 'function') {
    renderMissionControl();
  }
}

function restoreInteractionMode() {
  setInteractionMode('auto');
}

function setModelOptions(selectNode, models, placeholder) {
  if (!selectNode) return;
  selectNode.innerHTML = '';
  if (!Array.isArray(models) || models.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = placeholder || 'No models loaded yet';
    selectNode.appendChild(option);
    selectNode.value = '';
    return;
  }

  const autoOption = document.createElement('option');
  autoOption.value = 'auto';
  autoOption.textContent = 'Auto (Best for Task)';
  selectNode.appendChild(autoOption);

  models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    selectNode.appendChild(option);
  });
}

function syncModelSelectors(selectedModel) {
  const selected = String(selectedModel || '').trim();
  if (el.modelSelect && el.modelSelect.value !== selected) {
    el.modelSelect.value = selected;
  }
  if (el.modelQuickSelect && el.modelQuickSelect.value !== selected) {
    el.modelQuickSelect.value = selected;
  }
}

function renderModels(models, selected) {
  state.models = Array.isArray(models) ? models : [];
  if (state.models.length === 0) {
    setModelOptions(el.modelSelect, [], 'No models loaded yet');
    setModelOptions(el.modelQuickSelect, [], 'No models loaded yet');
    if (typeof refreshVoiceTranscriptionModelOptions === 'function') {
      refreshVoiceTranscriptionModelOptions();
    }
    // Keep state.model intact — it may hold the user's saved selection
    // which will be validated once the model list loads.
    updateSetupWizard();
    if (typeof renderMissionControl === 'function') {
      renderMissionControl();
    }
    return;
  }
  setModelOptions(el.modelSelect, state.models, 'No models loaded yet');
  setModelOptions(el.modelQuickSelect, state.models, 'No models loaded yet');
  if (typeof refreshVoiceTranscriptionModelOptions === 'function') {
    refreshVoiceTranscriptionModelOptions();
  }

  // Respect the user's explicit selection if it exists in the list.
  // Fall back to the suggested model, then the first in the list.
  const userSaved = state.model;
  const chosen = (userSaved === 'auto' || (userSaved && state.models.includes(userSaved)))
    ? userSaved
    : (selected === 'auto' || state.models.includes(selected) ? selected : state.models[0]);
  state.model = chosen;
  syncModelSelectors(chosen);
  updateSetupWizard();
  if (typeof renderMissionControl === 'function') {
    renderMissionControl();
  }
}

async function saveSettingsPatch(patch) {
  const next = await window.geepus.saveSettings(patch);
  state.apiKeyPresent = Boolean(next.apiKeyPresent || next.apiKeys?.openai || next.apiKeys?.anthropic);
  state.provider = next.provider || state.provider;
  state.executionCore = next.executionCore || state.executionCore || 'geepus';
  state.teamMode = next.teamMode || state.teamMode || 'dev';
  state.baseUrl = next.baseUrl || state.baseUrl;
  state.model = String(next.model || state.model || '').trim();
  state.runLimits = normalizeRunLimits(next.runLimits || state.runLimits || DEFAULT_RUN_LIMITS);
  state.securityControls = {
    ...(state.securityControls || {}),
    ...((next && typeof next.securityControls === 'object') ? next.securityControls : {}),
  };
  if (typeof normalizeVoiceSettings === 'function') {
    state.voice = normalizeVoiceSettings(next.voice || state.voice || {});
  } else if (next && typeof next.voice === 'object') {
    state.voice = { ...(state.voice || {}), ...next.voice };
  }
  if (next && typeof next.userProfile === 'object') {
    state.userProfile = { ...(state.userProfile || {}), ...next.userProfile };
  }
  if (next && typeof next.memoryAutonomy === 'object') {
    state.memoryAutonomy = next.memoryAutonomy;
  }
  if (next && typeof next.webIdentity === 'object') {
    state.webIdentity = { ...(state.webIdentity || {}), ...next.webIdentity };
  }
  state.workspaceRoot = next.workspaceRoot || state.workspaceRoot;
  if (el.providerSelect.value !== state.provider) {
    el.providerSelect.value = state.provider;
  }
  if (el.executionCoreSelect && el.executionCoreSelect.value !== state.executionCore) {
    el.executionCoreSelect.value = state.executionCore;
  }
  if (el.teamModeSelect.value !== state.teamMode) {
    el.teamModeSelect.value = state.teamMode;
  }
  if (el.baseUrlInput.value.trim() !== state.baseUrl) {
    el.baseUrlInput.value = state.baseUrl;
  }
  syncModelSelectors(state.model);
  applyRunLimitsToInputs(state.runLimits);
  if (state.workspaceRoot && el.workspaceRootInput.value.trim() !== state.workspaceRoot) {
    el.workspaceRootInput.value = state.workspaceRoot;
  }
  if (typeof hydrateVoiceSettings === 'function') {
    hydrateVoiceSettings(state.voice || {}, { persist: false });
  }
  if (typeof refreshLearningDirectivePreview === 'function') {
    refreshLearningDirectivePreview();
  }
  updateConnectionBadge();
  updateSetupWizard();
  if (typeof renderMissionControl === 'function') {
    renderMissionControl();
  }
  return next;
}

async function loadInitialState() {
  loadThreadsFromStorage();
  ensureCurrentThread();
  renderThreads();
  renderCurrentThread();

  try {
    const appInfo = await window.geepus.getAppVersion();
    if (el.appVersionBadge) {
      const version = String(appInfo?.version || '').trim();
      if (version) {
        el.appVersionBadge.textContent = `v${version}`;
        const node = String(appInfo?.node || '').trim();
        const electron = String(appInfo?.electron || '').trim();
        el.appVersionBadge.title = `Geepus ${version}${electron ? ` | Electron ${electron}` : ''}${node ? ` | Node ${node}` : ''}`;
      } else {
        el.appVersionBadge.textContent = 'v?';
      }
    }
  } catch {
    if (el.appVersionBadge) {
      el.appVersionBadge.textContent = 'v?';
    }
  }

  const settings = await window.geepus.loadSettings();

  state.apiKeyPresent = Boolean(settings.apiKeyPresent);
  state.provider = settings.provider || 'auto';
  state.executionCore = settings.executionCore || 'geepus';
  state.teamMode = settings.teamMode || 'dev';
  state.baseUrl = settings.baseUrl || 'https://api.openai.com/v1';
  state.braveSearchApiKey = settings.braveSearchApiKey || '';
  state.firecrawlApiKey = settings.firecrawlApiKey || '';
  state.runLimits = normalizeRunLimits(settings.runLimits || DEFAULT_RUN_LIMITS);
  state.securityControls = {
    ...(state.securityControls || {}),
    ...((settings && typeof settings.securityControls === 'object') ? settings.securityControls : {}),
  };
  if (typeof normalizeVoiceSettings === 'function') {
    state.voice = normalizeVoiceSettings(settings.voice || state.voice || {});
  } else if (settings && typeof settings.voice === 'object') {
    state.voice = { ...(state.voice || {}), ...settings.voice };
  }
  state.userProfile = settings && typeof settings.userProfile === 'object'
    ? { ...(state.userProfile || {}), ...settings.userProfile }
    : state.userProfile;
  state.memoryAutonomy = settings && typeof settings.memoryAutonomy === 'object'
    ? settings.memoryAutonomy
    : state.memoryAutonomy;
  updateConnectionBadge();
  updateSetupWizard();

  el.providerSelect.value = state.provider;
  if (el.executionCoreSelect) el.executionCoreSelect.value = state.executionCore;
  el.teamModeSelect.value = state.teamMode;
  el.baseUrlInput.value = state.baseUrl;
  if (el.braveSearchApiKeyInput) {
    el.braveSearchApiKeyInput.value = state.braveSearchApiKey ? '••••••••' : '';
  }
  if (el.firecrawlApiKeyInput) {
    el.firecrawlApiKeyInput.value = state.firecrawlApiKey ? '••••••••' : '';
  }
  applyRunLimitsToInputs(state.runLimits);
  if (typeof hydrateVoiceSettings === 'function') {
    hydrateVoiceSettings(state.voice || {}, { persist: false });
  }
  installSettingsTabs();
  try {
    const savedTab = window.localStorage.getItem(SETTINGS_TAB_STORAGE_KEY) || 'core';
    setSettingsTab(savedTab, { persist: false, refresh: false });
  } catch {
    setSettingsTab('core', { persist: false, refresh: false });
  }

  // Hydrate integration fields (show masked values if configured)
  const integ = settings.integrations || {};
  const ghTokenInput = document.getElementById('githubTokenInput');
  const ghRepoInput = document.getElementById('githubDefaultRepoInput');
  const webhookInput = document.getElementById('webhookUrlInput');
  const emailUrlInput = document.getElementById('emailApiUrlInput');
  const emailKeyInput = document.getElementById('emailApiKeyInput');
  const emailToInput = document.getElementById('emailToInput');
  if (ghTokenInput) ghTokenInput.value = integ.githubToken ? '••••••••' : '';
  if (ghRepoInput) ghRepoInput.value = integ.githubDefaultRepo || '';
  if (webhookInput) webhookInput.value = integ.webhookUrl || '';
  if (emailUrlInput) emailUrlInput.value = integ.emailApiUrl || '';
  if (emailKeyInput) emailKeyInput.value = integ.emailApiKey ? '••••••••' : '';
  if (emailToInput) emailToInput.value = integ.emailTo || '';

  // Hydrate API key fields (show masked values if configured)
  if (el.openaiApiKeyInput) el.openaiApiKeyInput.value = settings.apiKeys?.openai ? '••••••••' : '';
  if (el.anthropicApiKeyInput) el.anthropicApiKeyInput.value = settings.apiKeys?.anthropic ? '••••••••' : '';

  // Hydrate web identity fields
  const identity = settings.webIdentity || {};
  const idEmailInput = document.getElementById('identityEmailInput');
  const idPasswordInput = document.getElementById('identityEmailPasswordInput');
  const idDisplayInput = document.getElementById('identityDisplayNameInput');
  const idUsernameInput = document.getElementById('identityUsernameInput');
  const idPhoneInput = document.getElementById('identityPhoneInput');
  const idBirthDateInput = document.getElementById('identityBirthDateInput');
  const idStrongPwToggle = document.getElementById('identityStrongPasswordsToggle');
  const idVerificationModeSelect = document.getElementById('identityEmailVerificationModeSelect');
  const idResendInboxApiUrlInput = document.getElementById('identityResendInboxApiUrlInput');
  const idResendApiKeyInput = document.getElementById('identityResendApiKeyInput');
  const idResendApiBaseUrlInput = document.getElementById('identityResendApiBaseUrlInput');
  const idResendFromFilterInput = document.getElementById('identityResendFromFilterInput');
  if (idEmailInput) idEmailInput.value = identity.email || '';
  if (idPasswordInput) idPasswordInput.value = identity.emailPassword && identity.emailPassword !== '' ? '••••••••' : '';
  if (idVerificationModeSelect) idVerificationModeSelect.value = identity.emailVerificationMode === 'resend' ? 'resend' : 'webmail';
  if (idResendInboxApiUrlInput) idResendInboxApiUrlInput.value = identity.resendInboxApiUrl || '';
  if (idResendApiKeyInput) idResendApiKeyInput.value = identity.resendApiKey ? '••••••••' : '';
  if (idResendApiBaseUrlInput) idResendApiBaseUrlInput.value = identity.resendApiBaseUrl || 'https://api.resend.com';
  if (idResendFromFilterInput) idResendFromFilterInput.value = identity.resendFromFilter || '';
  if (idDisplayInput) idDisplayInput.value = identity.displayName || '';
  if (idUsernameInput) idUsernameInput.value = identity.usernamePreference || '';
  if (idPhoneInput) idPhoneInput.value = identity.phoneNumber || '';
  if (idBirthDateInput) idBirthDateInput.value = identity.birthDate || '';
  if (idStrongPwToggle) idStrongPwToggle.checked = identity.generateStrongPasswords !== false;
  state.webIdentity = identity;

  state.workspaceRoot = settings.workspaceRoot || '';
  el.workspaceRootInput.value = state.workspaceRoot;
  state.model = settings.model || '';
  renderModels([], state.model);
  await refreshRunList({ silent: true });
  ensureCurrentThread();
  renderCurrentThread();
  if (typeof renderMissionControl === 'function') {
    renderMissionControl();
  }

  if ((state.apiKeyPresent || state.provider === 'ollama') && settings.autoDiscover !== false) {
    try {
      await refreshModels({ silent: true });
      setStatus('Connection is live. Give Geepus an outcome to handle.');
    } catch (error) {
      if (state.provider === 'ollama') {
        setStatus('Ollama not reachable. Is it running?  Start it with: ollama serve');
      } else {
        setStatus(error.message || String(error));
      }
    }
    // Auto-verify connection and show badge
    if (state.apiKeyPresent && state.provider !== 'ollama') {
      try {
        setConnectionBadge('testing', 'Verifying connection…');
        const results = await window.geepus.testConnector();
        setConnectionBadgeFromResults(Array.isArray(results) ? results : [results]);
      } catch (testErr) {
        setConnectionBadge('error', 'Connection error', testErr.message || String(testErr));
      }
    }
  } else {
    setStatus('Start with setup: connect a provider, choose a model, and issue a command.');
  }
}
