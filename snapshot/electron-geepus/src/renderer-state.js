/**
 * renderer-state.js — Global UI state, constants, DOM element references.
 *
 * Loaded first. All other renderer modules depend on these top-level bindings.
 * Browser globals: state, INTERACTION_MODES, DEFAULT_RUN_LIMITS,
 *   THREADS_STORAGE_KEY, CURRENT_THREAD_STORAGE_KEY, runLimitsSaveTimer, el
 */

const state = {
  apiKeyPresent: false,
  setupComplete: false,
  interactionMode: 'auto',
  provider: 'openai',
  executionCore: 'geepus',
  teamMode: 'teams',
  baseUrl: 'https://api.openai.com/v1',
  models: [],
  model: '',
  workspaceRoot: '',
  runs: [],
  threads: [],
  currentThreadId: '',
  threadQuery: '',
  transientResponse: null,
  working: false,
  currentRunId: '',
  runPollTimer: null,
  showSetupPanels: false,
  attachedFiles: [], // { name, type: 'image'|'text', path?, content?, mimeType? }
  voice: {
    enabled: false,
    autoSpeak: true,
    autoSend: false,
    realtimeDictation: true,
    openaiApiKey: '',
    transcriptionModel: '',
    voiceName: '',
    inputDeviceId: '',
    replyStyle: 'concise',
    rate: 0.95,
    pitch: 1,
    volume: 0.9,
    maxReplyChars: 220,
  },
  voiceListening: false,
  voiceSupported: false,
  voiceCapturePrefix: '',
  userProfile: {
    defaultLocation: '',
    defaultLocationCoords: null,
    knownLocations: [],
    learnedStrategies: [],
    skillStats: [],
    updatedAt: null,
  },
  memoryAutonomy: {
    compaction: {
      memoryFlush: {
        enabled: false,
      },
    },
    memorySearch: {
      experimental: {
        sessionMemory: false,
        sources: ['memory'],
      },
    },
    learning: {
      autoSkillReview: true,
    },
  },
  securityControls: {
    highRiskAutoApproveUntil: 0,
    browserControlUntil: 0,
    internetAccessUntil: 0,
    remoteAccessUntil: 0,
  },
  runLimits: {
    maxIterations: 20,
    maxRuntimeMinutes: 90,
    maxActions: 250,
    maxModelCallsPerMinute: 30,
    maxToolCallsPerMinute: 60,
    idleTimeoutSeconds: 75,
    consecutiveDriftLimit: 3,
  },
  webIdentity: {
    email: '',
    emailPassword: '',
    displayName: '',
    usernamePreference: '',
    phoneNumber: '',
    birthDate: '',
    generateStrongPasswords: true,
    emailVerificationMode: 'webmail',
    resendInboxApiUrl: '',
    resendApiKey: '',
    resendApiBaseUrl: 'https://api.resend.com',
    resendFromFilter: '',
  },
};

const INTERACTION_MODES = {
  planning: {
    buttonLabel: 'Plan with Geepus',
    description: 'Planning Mode: Geepus helps you shape the plan. No actions are run.',
    status: 'Planning mode enabled. Collaborate on the approach first.',
  },
  research: {
    buttonLabel: 'Start Research',
    description: 'Research Mode: Geepus runs research actions only (web + notes), with no coding/building.',
    status: 'Research Mode enabled. Click Start Research to run safe research tasks.',
  },
  action: {
    buttonLabel: 'Start Task',
    description: 'Action Mode: Geepus executes the full task loop for build, implementation, and QA.',
    status: 'Action mode enabled. Geepus will execute the task loop.',
  },
  auto: {
    buttonLabel: 'Run',
    description: 'Auto Mode: Geepus decides when to plan, research, and act — fully autonomous end-to-end.',
    status: 'Auto mode enabled. Geepus will decide how to handle the work.',
  },
};

const DEFAULT_RUN_LIMITS = {
  maxIterations: 20,
  maxRuntimeMinutes: 90,
  maxActions: 250,
  maxModelCallsPerMinute: 30,
  maxToolCallsPerMinute: 60,
  idleTimeoutSeconds: 75,
  consecutiveDriftLimit: 3,
};

// Relaxed limits for local models (Ollama) — free inference, let them cook.
const LOCAL_RUN_LIMITS = {
  maxIterations: 500,
  maxRuntimeMinutes: 1440,
  maxActions: 10000,
  maxModelCallsPerMinute: 999,
  maxToolCallsPerMinute: 999,
  idleTimeoutSeconds: 900,
  consecutiveDriftLimit: 10,
};

const THREADS_STORAGE_KEY = 'geepus_chat_threads_v1';
const CURRENT_THREAD_STORAGE_KEY = 'geepus_current_thread_v1';
let runLimitsSaveTimer = null;

const el = {
  quickSetupCard: document.getElementById('quickSetupCard'),
  settingsPage: document.getElementById('settingsPage'),
  openSettingsPageButton: document.getElementById('openSettingsPageButton'),
  appVersionBadge: document.getElementById('appVersionBadge'),
  closeSettingsPageButton: document.getElementById('closeSettingsPageButton'),
  showSetupButton: document.getElementById('showSetupButton'),
  connectionBadge: document.getElementById('connectionBadge'),
  missionConnectionPill: document.getElementById('missionConnectionPill'),
  missionModePill: document.getElementById('missionModePill'),
  missionRunPill: document.getElementById('missionRunPill'),
  missionStatusLine: document.getElementById('missionStatusLine'),
  missionWorkspaceLine: document.getElementById('missionWorkspaceLine'),
  missionModelLine: document.getElementById('missionModelLine'),
  promptInput: document.getElementById('promptInput'),
  promptDropZone: document.getElementById('promptDropZone'),
  attachmentChips: document.getElementById('attachmentChips'),
  dropOverlay: document.getElementById('dropOverlay'),
  attachFileButton: document.getElementById('attachFileButton'),
  attachFileInput: document.getElementById('attachFileInput'),
  voiceMicButton: document.getElementById('voiceMicButton'),
  voiceInputLevelInline: document.getElementById('voiceInputLevelInline'),
  askButton: document.getElementById('askButton'),
  planningModeButton: document.getElementById('planningModeButton'),
  researchModeButton: document.getElementById('researchModeButton'),
  actionModeButton: document.getElementById('actionModeButton'),
  autoModeButton: document.getElementById('autoModeButton'),
  modeDescription: document.getElementById('modeDescription'),
  modelQuickSelect: document.getElementById('modelQuickSelect'),
  refreshModelsInlineButton: document.getElementById('refreshModelsInlineButton'),
  clearPromptButton: document.getElementById('clearPromptButton'),
  stopTaskButton: document.getElementById('stopTaskButton'),
  responseOutput: document.getElementById('responseOutput'),
  responseModel: document.getElementById('responseModel'),
  threadBudgetInput: document.getElementById('threadBudgetInput'),
  readinessBadge: document.getElementById('readinessBadge'),
  readinessSummary: document.getElementById('readinessSummary'),
  readinessChecklist: document.getElementById('readinessChecklist'),
  memoryConstraintBadge: document.getElementById('memoryConstraintBadge'),
  memoryConstraintSummary: document.getElementById('memoryConstraintSummary'),
  memoryConstraintList: document.getElementById('memoryConstraintList'),
  runMeta: document.getElementById('runMeta'),
  setupProgress: document.getElementById('setupProgress'),
  stepKeyStatus: document.getElementById('stepKeyStatus'),
  stepModelStatus: document.getElementById('stepModelStatus'),
  stepProjectStatus: document.getElementById('stepProjectStatus'),
  refreshRunsButton: document.getElementById('refreshRunsButton'),
  resumeRunButton: document.getElementById('resumeRunButton'),
  watchTaskButton: document.getElementById('watchTaskButton'),
  newThreadButton: document.getElementById('newThreadButton'),
  threadSearchInput: document.getElementById('threadSearchInput'),
  threadList: document.getElementById('threadList'),
  plannerLane: document.getElementById('plannerLane'),
  builderLane: document.getElementById('builderLane'),
  reviewerLane: document.getElementById('reviewerLane'),
  checkpointList: document.getElementById('checkpointList'),
  providerSelect: document.getElementById('providerSelect'),
  executionCoreSelect: document.getElementById('executionCoreSelect'),
  teamModeSelect: document.getElementById('teamModeSelect'),
  baseUrlInput: document.getElementById('baseUrlInput'),
  braveSearchApiKeyInput: document.getElementById('braveSearchApiKeyInput'),
  firecrawlApiKeyInput: document.getElementById('firecrawlApiKeyInput'),
  projectManagerCard: document.getElementById('projectManagerCard'),
  projectManagerContent: document.getElementById('projectManagerContent'),
  projectRefreshButton: document.getElementById('projectRefreshButton'),
  addProjectPathInput: document.getElementById('addProjectPathInput'),
  addProjectButton: document.getElementById('addProjectButton'),
  costDashboardCard: document.getElementById('costDashboardCard'),
  costDashboardContent: document.getElementById('costDashboardContent'),
  costRefreshButton: document.getElementById('costRefreshButton'),
  limitMaxRuntimeMinutes: document.getElementById('limitMaxRuntimeMinutes'),
  limitBudgetLimit: document.getElementById('limitBudgetLimit'),
  limitMaxIterations: document.getElementById('limitMaxIterations'),
  limitMaxActions: document.getElementById('limitMaxActions'),
  limitMaxModelCallsPerMinute: document.getElementById('limitMaxModelCallsPerMinute'),
  limitMaxToolCallsPerMinute: document.getElementById('limitMaxToolCallsPerMinute'),
  limitIdleTimeoutSeconds: document.getElementById('limitIdleTimeoutSeconds'),
  limitConsecutiveDriftLimit: document.getElementById('limitConsecutiveDriftLimit'),
  modelSelect: document.getElementById('modelSelect'),
  workspaceRootInput: document.getElementById('workspaceRootInput'),
  useAutoFindButton: document.getElementById('useAutoFindButton'),
  openaiApiKeyInput: document.getElementById('openaiApiKeyInput'),
  anthropicApiKeyInput: document.getElementById('anthropicApiKeyInput'),
  toggleOpenAiKeyButton: document.getElementById('toggleOpenAiKeyButton'),
  toggleAnthropicKeyButton: document.getElementById('toggleAnthropicKeyButton'),
  saveKeyButton: document.getElementById('saveKeyButton'),
  clearKeyButton: document.getElementById('clearKeyButton'),
  connectionStatusBadge: document.getElementById('connectionStatusBadge'),
  listModelsButton: document.getElementById('listModelsButton'),
  testButton: document.getElementById('testButton'),
  restartButton: document.getElementById('restartButton'),
  securityHighRiskDuration: document.getElementById('securityHighRiskDuration'),
  securityHighRiskAllowButton: document.getElementById('securityHighRiskAllowButton'),
  securityHighRiskRevokeButton: document.getElementById('securityHighRiskRevokeButton'),
  securityHighRiskStatus: document.getElementById('securityHighRiskStatus'),
  securityBrowserDuration: document.getElementById('securityBrowserDuration'),
  securityBrowserAllowButton: document.getElementById('securityBrowserAllowButton'),
  securityBrowserRevokeButton: document.getElementById('securityBrowserRevokeButton'),
  securityBrowserStatus: document.getElementById('securityBrowserStatus'),
  securityInternetDuration: document.getElementById('securityInternetDuration'),
  securityInternetAllowButton: document.getElementById('securityInternetAllowButton'),
  securityInternetRevokeButton: document.getElementById('securityInternetRevokeButton'),
  securityInternetStatus: document.getElementById('securityInternetStatus'),
  securityRemoteDuration: document.getElementById('securityRemoteDuration'),
  securityRemoteAllowButton: document.getElementById('securityRemoteAllowButton'),
  securityRemoteRevokeButton: document.getElementById('securityRemoteRevokeButton'),
  securityRemoteStatus: document.getElementById('securityRemoteStatus'),
  statusLine: document.getElementById('statusLine'),
  // Local Models (Ollama)
  localModelsPanel: document.getElementById('localModelsPanel'),
  ollamaStatusPill: document.getElementById('ollamaStatusPill'),
  ollamaHint: document.getElementById('ollamaHint'),
  localModelCatalog: document.getElementById('localModelCatalog'),
  ollamaInstallPrompt: document.getElementById('ollamaInstallPrompt'),
  ollamaInstallButton: document.getElementById('ollamaInstallButton'),
  openSettingsFromSetup: document.getElementById('openSettingsFromSetup'),
  voiceOpenaiKeyInput: document.getElementById('voiceOpenaiKeyInput'),
  voiceOpenaiKeyRow: document.getElementById('voiceOpenaiKeyRow'),
  voiceEnabledToggle: document.getElementById('voiceEnabledToggle'),
  voiceAutoSpeakToggle: document.getElementById('voiceAutoSpeakToggle'),
  voiceAutoSendToggle: document.getElementById('voiceAutoSendToggle'),
  voiceRealtimeToggle: document.getElementById('voiceRealtimeToggle'),
  voiceTranscriptionModelSelect: document.getElementById('voiceTranscriptionModelSelect'),
  voiceNameSelect: document.getElementById('voiceNameSelect'),
  voiceInputDeviceSelect: document.getElementById('voiceInputDeviceSelect'),
  voiceRefreshDevicesButton: document.getElementById('voiceRefreshDevicesButton'),
  voiceInputLevelHint: document.getElementById('voiceInputLevelHint'),
  voiceReplyStyleSelect: document.getElementById('voiceReplyStyleSelect'),
  voiceRateInput: document.getElementById('voiceRateInput'),
  voiceRateValue: document.getElementById('voiceRateValue'),
  voiceSupportHint: document.getElementById('voiceSupportHint'),
  learningRefreshButton: document.getElementById('learningRefreshButton'),
  learningDirectivePreview: document.getElementById('learningDirectivePreview'),
  learningMemoryFlushToggle: document.getElementById('learningMemoryFlushToggle'),
  learningSessionMemoryToggle: document.getElementById('learningSessionMemoryToggle'),
  learningSourceMemoryToggle: document.getElementById('learningSourceMemoryToggle'),
  learningSourceSessionsToggle: document.getElementById('learningSourceSessionsToggle'),
  learningAutoSkillReviewToggle: document.getElementById('learningAutoSkillReviewToggle'),
  learningDefaultLocationInput: document.getElementById('learningDefaultLocationInput'),
  learningStrategiesInput: document.getElementById('learningStrategiesInput'),
  learningGlobalNotesInput: document.getElementById('learningGlobalNotesInput'),
  learningApplyButton: document.getElementById('learningApplyButton'),
  learningResetSkillsButton: document.getElementById('learningResetSkillsButton'),
  learningResetStrategiesButton: document.getElementById('learningResetStrategiesButton'),
  learningSkillStatsList: document.getElementById('learningSkillStatsList'),
};

/**
 * Show a status badge in the Connection section.
 * @param {'ok'|'error'|'testing'} status
 * @param {string} title
 * @param {string} [sub]
 */
function setConnectionBadge(status, title, sub) {
  const badge = el.connectionStatusBadge;
  if (!badge) return;
  badge.hidden = false;
  badge.className = `conn-status ${status}`;
  const icon = status === 'ok' ? '\u2713' : status === 'error' ? '\u2717' : '\u27f3';
  badge.innerHTML = `
    <span class="conn-icon">${icon}</span>
    <span class="conn-detail">
      <span class="conn-title">${title}</span>
      ${sub ? `<span class="conn-sub">${sub}</span>` : ''}
    </span>`;
}

/**
 * Show per-provider test results returned by connector:test.
 * @param {Array<{provider:string, ok:boolean, model?:string, error?:string}>} results
 */
function setConnectionBadgeFromResults(results) {
  const badge = el.connectionStatusBadge;
  if (!badge) return;
  badge.hidden = false;
  const allOk = results.every((r) => r.ok);
  const anyOk = results.some((r) => r.ok);
  badge.className = `conn-status ${allOk ? 'ok' : anyOk ? 'partial' : 'error'}`;
  const rows = results.map((r) => {
    const icon = r.ok ? '\u2713' : '\u2717';
    const label = String(r.provider || '').replace(/^./, (c) => c.toUpperCase());
    const detail = r.ok ? (String(r.model || '').replace(/^[^/]+\//, '')) : (r.error || 'failed');
    return `<span class="conn-provider-row">
      <span class="conn-provider-icon ${r.ok ? 'ok' : 'error'}">${icon}</span>
      <span class="conn-provider-name">${label}</span>
      <span class="conn-provider-model">${detail}</span>
    </span>`;
  }).join('');
  badge.innerHTML = `<span class="conn-rows">${rows}</span>`;
}
