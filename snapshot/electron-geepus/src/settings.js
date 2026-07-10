'use strict';

const path = require('path');
const fs = require('fs/promises');
const { app } = require('electron');

const { ensureObject, clampNumber } = require('./utils');
const { normalizeProvider, defaultBaseUrlForProvider } = require('./providers');

const SETTINGS_FILE = 'settings.json';
const DEFAULT_WORKSPACE_ROOT = app.getPath('home');

const VALID_TEAM_MODES = new Set(['all', 'dev', 'teams', 'research', 'marketing', 'ops', 'solo']);
const VALID_EXECUTION_CORES = new Set(['geepus', 'nanobot']);

function normalizeTeamMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'solo') return 'solo';
  if (mode === 'teams') return 'dev';  // backward compat
  return VALID_TEAM_MODES.has(mode) ? mode : 'dev';
}

function normalizeExecutionCore(value) {
  const core = String(value || '').trim().toLowerCase();
  return VALID_EXECUTION_CORES.has(core) ? core : 'geepus';
}

const DEFAULT_RUN_LIMITS = {
  maxIterations: 20,
  maxRuntimeMinutes: 90,
  maxActions: 250,
  maxModelCallsPerMinute: 30,
  maxToolCallsPerMinute: 60,
  idleTimeoutSeconds: 75,
  consecutiveDriftLimit: 3,
  budgetLimit: 1.00, // default $1.00 per run — thread budget overrides this
};

const DEFAULT_SECURITY_CONTROLS = {
  highRiskAutoApproveUntil: 0,
  browserControlUntil: Number.MAX_SAFE_INTEGER,
  internetAccessUntil: Number.MAX_SAFE_INTEGER,
  remoteAccessUntil: 0,
};

const DEFAULT_VOICE_SETTINGS = {
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
};

const DEFAULT_USER_PROFILE = {
  defaultLocation: '',
  defaultLocationCoords: null,
  knownLocations: [],
  learnedStrategies: [],
  skillStats: [],
  bannedApproaches: [],
  updatedAt: null,
};

const DEFAULT_MEMORY_AUTONOMY = {
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
};

const DEFAULT_WEB_IDENTITY = {
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
};

// Limits for local models (Ollama) — free inference, let them cook.
// Only drift detection keeps its teeth to stop genuinely stuck loops.
const LOCAL_RUN_LIMITS = {
  maxIterations: 500,
  maxRuntimeMinutes: 1440,       // 24 hours
  maxActions: 10000,
  maxModelCallsPerMinute: 999,   // effectively unlimited
  maxToolCallsPerMinute: 999,    // effectively unlimited
  idleTimeoutSeconds: 1800,      // 30 min idle before stopping — local models can be slow
  consecutiveDriftLimit: 10,
  budgetLimit: 0,
};

function settingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

function normalizeWorkspaceRoot(workspaceRoot) {
  const value = typeof workspaceRoot === 'string' ? workspaceRoot.trim() : '';
  return value.length > 0 ? value : DEFAULT_WORKSPACE_ROOT;
}

function normalizeRunLimits(raw, fallback = DEFAULT_RUN_LIMITS, { provider } = {}) {
  const isLocal = provider === 'ollama';
  const defaults = isLocal ? LOCAL_RUN_LIMITS : DEFAULT_RUN_LIMITS;
  const source = ensureObject(raw);
  const base = ensureObject(fallback);
  return {
    maxIterations: clampNumber(Number(source.maxIterations ?? base.maxIterations ?? defaults.maxIterations), 1, isLocal ? 9999 : 120, defaults.maxIterations),
    maxRuntimeMinutes: clampNumber(Number(source.maxRuntimeMinutes ?? base.maxRuntimeMinutes ?? defaults.maxRuntimeMinutes), 1, isLocal ? 14400 : 720, defaults.maxRuntimeMinutes),
    maxActions: clampNumber(Number(source.maxActions ?? base.maxActions ?? defaults.maxActions), 1, isLocal ? 99999 : 4000, defaults.maxActions),
    maxModelCallsPerMinute: clampNumber(Number(source.maxModelCallsPerMinute ?? base.maxModelCallsPerMinute ?? defaults.maxModelCallsPerMinute), 1, isLocal ? 9999 : 240, defaults.maxModelCallsPerMinute),
    maxToolCallsPerMinute: clampNumber(Number(source.maxToolCallsPerMinute ?? base.maxToolCallsPerMinute ?? defaults.maxToolCallsPerMinute), 1, isLocal ? 9999 : 480, defaults.maxToolCallsPerMinute),
    idleTimeoutSeconds: clampNumber(Number(source.idleTimeoutSeconds ?? base.idleTimeoutSeconds ?? defaults.idleTimeoutSeconds), 30, isLocal ? 3600 : 1800, defaults.idleTimeoutSeconds),
    consecutiveDriftLimit: clampNumber(Number(source.consecutiveDriftLimit ?? base.consecutiveDriftLimit ?? defaults.consecutiveDriftLimit), 1, isLocal ? 50 : 20, defaults.consecutiveDriftLimit),
    budgetLimit: Math.max(0, Number(source.budgetLimit ?? base.budgetLimit ?? defaults.budgetLimit) || 0),
  };
}

function normalizeTimestamp(value) {
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) return 0;
  return Math.max(0, Math.floor(asNumber));
}

function normalizeLocationCoords(raw, fallback = null) {
  const source = ensureObject(raw);
  const base = ensureObject(fallback);
  const lat = Number(source.lat ?? base.lat);
  const lon = Number(source.lon ?? base.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
  };
}

function normalizeSecurityControls(raw, fallback = DEFAULT_SECURITY_CONTROLS) {
  const source = ensureObject(raw);
  const base = ensureObject(fallback);
  return {
    highRiskAutoApproveUntil: normalizeTimestamp(source.highRiskAutoApproveUntil ?? base.highRiskAutoApproveUntil),
    browserControlUntil: normalizeTimestamp(source.browserControlUntil ?? base.browserControlUntil),
    internetAccessUntil: normalizeTimestamp(source.internetAccessUntil ?? base.internetAccessUntil),
    remoteAccessUntil: normalizeTimestamp(source.remoteAccessUntil ?? base.remoteAccessUntil),
  };
}

function normalizeVoiceSettings(raw, fallback = DEFAULT_VOICE_SETTINGS) {
  const source = ensureObject(raw);
  const base = ensureObject(fallback);
  const styleRaw = String(source.replyStyle ?? base.replyStyle ?? DEFAULT_VOICE_SETTINGS.replyStyle).trim().toLowerCase();
  const replyStyle = styleRaw === 'balanced' ? 'balanced' : 'concise';
  return {
    enabled: Boolean(source.enabled ?? base.enabled ?? DEFAULT_VOICE_SETTINGS.enabled),
    autoSpeak: Boolean(source.autoSpeak ?? base.autoSpeak ?? DEFAULT_VOICE_SETTINGS.autoSpeak),
    autoSend: Boolean(source.autoSend ?? base.autoSend ?? DEFAULT_VOICE_SETTINGS.autoSend),
    realtimeDictation: Boolean(source.realtimeDictation ?? base.realtimeDictation ?? DEFAULT_VOICE_SETTINGS.realtimeDictation),
    openaiApiKey: String(source.openaiApiKey ?? base.openaiApiKey ?? DEFAULT_VOICE_SETTINGS.openaiApiKey).trim(),
    transcriptionModel: String(source.transcriptionModel ?? base.transcriptionModel ?? DEFAULT_VOICE_SETTINGS.transcriptionModel).trim(),
    voiceName: String(source.voiceName ?? base.voiceName ?? DEFAULT_VOICE_SETTINGS.voiceName).trim(),
    inputDeviceId: String(source.inputDeviceId ?? base.inputDeviceId ?? DEFAULT_VOICE_SETTINGS.inputDeviceId).trim(),
    replyStyle,
    rate: clampNumber(Number(source.rate ?? base.rate ?? DEFAULT_VOICE_SETTINGS.rate), 0.75, 1.35, DEFAULT_VOICE_SETTINGS.rate),
    pitch: clampNumber(Number(source.pitch ?? base.pitch ?? DEFAULT_VOICE_SETTINGS.pitch), 0.8, 1.2, DEFAULT_VOICE_SETTINGS.pitch),
    volume: clampNumber(Number(source.volume ?? base.volume ?? DEFAULT_VOICE_SETTINGS.volume), 0.1, 1, DEFAULT_VOICE_SETTINGS.volume),
    maxReplyChars: clampNumber(
      Number(source.maxReplyChars ?? base.maxReplyChars ?? DEFAULT_VOICE_SETTINGS.maxReplyChars),
      80,
      900,
      DEFAULT_VOICE_SETTINGS.maxReplyChars,
    ),
  };
}

function normalizeUserProfile(raw, fallback = DEFAULT_USER_PROFILE) {
  const source = ensureObject(raw);
  const base = ensureObject(fallback);
  const knownLocationsRaw = Array.isArray(source.knownLocations)
    ? source.knownLocations
    : Array.isArray(base.knownLocations) ? base.knownLocations : [];
  const learnedStrategiesRaw = Array.isArray(source.learnedStrategies)
    ? source.learnedStrategies
    : Array.isArray(base.learnedStrategies) ? base.learnedStrategies : [];
  const knownLocations = Array.from(new Set(
    knownLocationsRaw
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  )).slice(0, 20);
  const learnedStrategies = Array.from(new Set(
    learnedStrategiesRaw
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  )).slice(0, 40);
  const skillStatsRaw = Array.isArray(source.skillStats)
    ? source.skillStats
    : Array.isArray(base.skillStats) ? base.skillStats : [];
  const skillStats = skillStatsRaw
    .map((entry) => {
      const item = ensureObject(entry);
      const name = String(item.name || '').trim();
      if (!name) return null;
      const domain = String(item.domain || 'general').trim() || 'general';
      const attempts = clampNumber(Number(item.attempts), 0, 100000, 0);
      const successes = clampNumber(Number(item.successes), 0, 100000, 0);
      const failures = clampNumber(Number(item.failures), 0, 100000, 0);
      const lastOutcomeRaw = String(item.lastOutcome || '').trim().toLowerCase();
      const lastOutcome = lastOutcomeRaw === 'success' || lastOutcomeRaw === 'failure'
        ? lastOutcomeRaw
        : 'unknown';
      const notes = Array.from(new Set(
        (Array.isArray(item.notes) ? item.notes : [])
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      )).slice(0, 8);
      const updatedAt = String(item.updatedAt || '').trim() || null;
      return {
        name,
        domain,
        attempts,
        successes: Math.min(successes, attempts || successes),
        failures: Math.min(failures, attempts || failures),
        lastOutcome,
        notes,
        updatedAt,
      };
    })
    .filter(Boolean)
    .slice(0, 80);
  const bannedApproachesRaw = Array.isArray(source.bannedApproaches)
    ? source.bannedApproaches
    : Array.isArray(base.bannedApproaches) ? base.bannedApproaches : [];
  const bannedApproaches = bannedApproachesRaw
    .map((entry) => {
      const item = ensureObject(entry);
      const signature = String(item.signature || item.key || '').trim();
      if (!signature) return null;
      return {
        signature,
        key: signature,
        tool: String(item.tool || '').trim() || 'tool',
        count: clampNumber(Number(item.count), 1, 100000, 1),
        error: String(item.error || '').trim().slice(0, 300),
        domain: String(item.domain || 'general').trim() || 'general',
        updatedAt: String(item.updatedAt || '').trim() || null,
      };
    })
    .filter(Boolean)
    .slice(0, 120);
  const defaultLocationRaw = String(
    source.defaultLocation
    ?? base.defaultLocation
    ?? DEFAULT_USER_PROFILE.defaultLocation,
  ).trim();
  const defaultLocation = defaultLocationRaw || knownLocations[0] || '';
  if (defaultLocation && !knownLocations.includes(defaultLocation)) {
    knownLocations.unshift(defaultLocation);
  }
  const defaultLocationCoords = normalizeLocationCoords(
    source.defaultLocationCoords,
    base.defaultLocationCoords ?? DEFAULT_USER_PROFILE.defaultLocationCoords,
  );
  return {
    defaultLocation,
    defaultLocationCoords,
    knownLocations,
    learnedStrategies,
    skillStats,
    bannedApproaches,
    updatedAt: String(source.updatedAt || base.updatedAt || '').trim() || null,
  };
}

function normalizeMemoryAutonomy(raw, fallback = DEFAULT_MEMORY_AUTONOMY) {
  const source = ensureObject(raw);
  const base = ensureObject(fallback);
  const flushEnabled = Boolean(
    source?.compaction?.memoryFlush?.enabled
    ?? base?.compaction?.memoryFlush?.enabled
    ?? DEFAULT_MEMORY_AUTONOMY.compaction.memoryFlush.enabled,
  );
  const sessionMemory = Boolean(
    source?.memorySearch?.experimental?.sessionMemory
    ?? base?.memorySearch?.experimental?.sessionMemory
    ?? DEFAULT_MEMORY_AUTONOMY.memorySearch.experimental.sessionMemory,
  );
  const sourcesRaw = Array.isArray(source?.memorySearch?.experimental?.sources)
    ? source.memorySearch.experimental.sources
    : (Array.isArray(base?.memorySearch?.experimental?.sources)
      ? base.memorySearch.experimental.sources
      : DEFAULT_MEMORY_AUTONOMY.memorySearch.experimental.sources);
  const sources = Array.from(new Set(
    sourcesRaw
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((item) => item === 'memory' || item === 'sessions'),
  ));
  if (sources.length === 0) {
    sources.push('memory');
  }
  const autoSkillReview = Boolean(
    source?.learning?.autoSkillReview
    ?? base?.learning?.autoSkillReview
    ?? DEFAULT_MEMORY_AUTONOMY.learning.autoSkillReview,
  );
  return {
    compaction: {
      memoryFlush: {
        enabled: flushEnabled,
      },
    },
    memorySearch: {
      experimental: {
        sessionMemory,
        sources,
      },
    },
    learning: {
      autoSkillReview,
    },
  };
}

function normalizeWebIdentity(raw, fallback = DEFAULT_WEB_IDENTITY) {
  const source = ensureObject(raw);
  const base = ensureObject(fallback);
  const birthDate = String(source.birthDate ?? base.birthDate ?? DEFAULT_WEB_IDENTITY.birthDate).trim();
  const modeRaw = String(
    source.emailVerificationMode
    ?? base.emailVerificationMode
    ?? DEFAULT_WEB_IDENTITY.emailVerificationMode,
  ).trim().toLowerCase();
  const emailVerificationMode = modeRaw === 'resend' ? 'resend' : 'webmail';
  return {
    email: String(source.email ?? base.email ?? DEFAULT_WEB_IDENTITY.email).trim(),
    emailPassword: String(source.emailPassword ?? base.emailPassword ?? DEFAULT_WEB_IDENTITY.emailPassword),
    displayName: String(source.displayName ?? base.displayName ?? DEFAULT_WEB_IDENTITY.displayName).trim(),
    usernamePreference: String(source.usernamePreference ?? base.usernamePreference ?? DEFAULT_WEB_IDENTITY.usernamePreference).trim(),
    phoneNumber: String(source.phoneNumber ?? base.phoneNumber ?? DEFAULT_WEB_IDENTITY.phoneNumber).trim(),
    birthDate: /^\d{4}-\d{2}-\d{2}$/.test(birthDate) ? birthDate : '',
    generateStrongPasswords: Boolean(source.generateStrongPasswords ?? base.generateStrongPasswords ?? DEFAULT_WEB_IDENTITY.generateStrongPasswords),
    emailVerificationMode,
    resendInboxApiUrl: String(source.resendInboxApiUrl ?? base.resendInboxApiUrl ?? DEFAULT_WEB_IDENTITY.resendInboxApiUrl).trim(),
    resendApiKey: String(source.resendApiKey ?? base.resendApiKey ?? DEFAULT_WEB_IDENTITY.resendApiKey),
    resendApiBaseUrl: String(source.resendApiBaseUrl ?? base.resendApiBaseUrl ?? DEFAULT_WEB_IDENTITY.resendApiBaseUrl).trim().replace(/\/+$/, ''),
    resendFromFilter: String(source.resendFromFilter ?? base.resendFromFilter ?? DEFAULT_WEB_IDENTITY.resendFromFilter).trim(),
  };
}

function normalizeBaseUrl(baseUrl, provider) {
  const resolvedProvider = normalizeProvider(provider);
  const fallback = defaultBaseUrlForProvider(resolvedProvider);
  const raw = (baseUrl || fallback).trim();
  const normalized = raw.replace(/\/+$/, '');
  if (!normalized) return fallback;

  // Self-heal stale settings where provider and default endpoint drifted apart
  // (for example: provider=openai but baseUrl=api.anthropic.com/v1).
  const knownProviders = ['openai', 'anthropic', 'ollama'];
  const isAnotherProviderDefault = knownProviders.some((candidate) => {
    if (candidate === resolvedProvider) return false;
    return normalized === defaultBaseUrlForProvider(candidate);
  });
  if (isAnotherProviderDefault) {
    return fallback;
  }

  return normalized;
}

function normalizeExecutionMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'research') return 'research';
  if (mode === 'auto') return 'auto';
  return 'action';
}

function normalizeIntegrations(raw) {
  const src = ensureObject(raw);
  return {
    githubToken: typeof src.githubToken === 'string' ? src.githubToken : '',
    githubDefaultRepo: typeof src.githubDefaultRepo === 'string' ? src.githubDefaultRepo : '',
    webhookUrl: typeof src.webhookUrl === 'string' ? src.webhookUrl : '',
    emailApiUrl: typeof src.emailApiUrl === 'string' ? src.emailApiUrl : '',
    emailApiKey: typeof src.emailApiKey === 'string' ? src.emailApiKey : '',
    emailTo: typeof src.emailTo === 'string' ? src.emailTo : '',
    emailVerificationMode: typeof src.emailVerificationMode === 'string' ? src.emailVerificationMode : '',
    resendInboxApiUrl: typeof src.resendInboxApiUrl === 'string' ? src.resendInboxApiUrl : '',
    resendApiKey: typeof src.resendApiKey === 'string' ? src.resendApiKey : '',
    resendApiBaseUrl: typeof src.resendApiBaseUrl === 'string' ? src.resendApiBaseUrl : '',
    resendFromFilter: typeof src.resendFromFilter === 'string' ? src.resendFromFilter : '',
  };
}

function normalizeApiKeys(raw, legacyKey, legacyProvider) {
  const keys = ensureObject(raw);
  const result = {
    openai: typeof keys.openai === 'string' ? keys.openai : '',
    anthropic: typeof keys.anthropic === 'string' ? keys.anthropic : '',
  };
  if (legacyKey && legacyProvider && !result[legacyProvider]) {
    result[legacyProvider] = legacyKey;
  }
  return result;
}

async function readSettings() {
  try {
    const content = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(content);
    const provider = parsed.provider === 'auto' ? 'auto' : normalizeProvider(parsed.provider);
    const apiKeys = normalizeApiKeys(parsed.apiKeys, typeof parsed.apiKey === 'string' ? parsed.apiKey : '', provider === 'auto' ? 'openai' : provider);
    return {
      provider,
      apiKeys,
      model: typeof parsed.model === 'string' ? parsed.model : '',
      executionCore: normalizeExecutionCore(parsed.executionCore),
      baseUrl: normalizeBaseUrl(typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '', provider === 'auto' ? 'openai' : provider),
      autoDiscover: parsed.autoDiscover !== false,
      workspaceRoot: normalizeWorkspaceRoot(parsed.workspaceRoot),
      teamMode: parsed.teamMode === 'solo' ? 'solo' : normalizeTeamMode(parsed.teamMode),
      runLimits: normalizeRunLimits(parsed.runLimits),
      securityControls: normalizeSecurityControls(parsed.securityControls),
      voice: normalizeVoiceSettings(parsed.voice),
      userProfile: normalizeUserProfile(parsed.userProfile),
      memoryAutonomy: normalizeMemoryAutonomy(parsed.memoryAutonomy),
      braveSearchApiKey: typeof parsed.braveSearchApiKey === 'string' ? parsed.braveSearchApiKey : '',
      firecrawlApiKey: typeof parsed.firecrawlApiKey === 'string' ? parsed.firecrawlApiKey : '',
      integrations: normalizeIntegrations(parsed.integrations),
      webIdentity: normalizeWebIdentity(parsed.webIdentity),
    };
  } catch {
    const provider = normalizeProvider();
    return {
      provider,
      apiKeys: { openai: '', anthropic: '' },
      model: '',
      executionCore: normalizeExecutionCore('geepus'),
      baseUrl: defaultBaseUrlForProvider(provider),
      autoDiscover: true,
      workspaceRoot: DEFAULT_WORKSPACE_ROOT,
      teamMode: 'dev',
      runLimits: normalizeRunLimits({}),
      securityControls: normalizeSecurityControls({}),
      voice: normalizeVoiceSettings({}),
      userProfile: normalizeUserProfile({}),
      memoryAutonomy: normalizeMemoryAutonomy({}),
      braveSearchApiKey: '',
      firecrawlApiKey: '',
      integrations: normalizeIntegrations({}),
      webIdentity: normalizeWebIdentity({}),
    };
  }
}

async function writeSettings(next) {
  const provider = next.provider === 'auto' ? 'auto' : normalizeProvider(next.provider);
  const payload = {
    provider,
    apiKeys: normalizeApiKeys(next.apiKeys),
    model: next.model || '',
    executionCore: normalizeExecutionCore(next.executionCore),
    baseUrl: normalizeBaseUrl(next.baseUrl, provider === 'auto' ? 'openai' : provider),
    autoDiscover: next.autoDiscover !== false,
    workspaceRoot: normalizeWorkspaceRoot(next.workspaceRoot),
    teamMode: next.teamMode === 'solo' ? 'solo' : normalizeTeamMode(next.teamMode),
    runLimits: normalizeRunLimits(next.runLimits, next.runLimits || DEFAULT_RUN_LIMITS),
    securityControls: normalizeSecurityControls(next.securityControls, next.securityControls || DEFAULT_SECURITY_CONTROLS),
    voice: normalizeVoiceSettings(next.voice, next.voice || DEFAULT_VOICE_SETTINGS),
    userProfile: normalizeUserProfile(next.userProfile, next.userProfile || DEFAULT_USER_PROFILE),
    memoryAutonomy: normalizeMemoryAutonomy(next.memoryAutonomy, next.memoryAutonomy || DEFAULT_MEMORY_AUTONOMY),
    braveSearchApiKey: typeof next.braveSearchApiKey === 'string' ? next.braveSearchApiKey : '',
    firecrawlApiKey: typeof next.firecrawlApiKey === 'string' ? next.firecrawlApiKey : '',
    integrations: normalizeIntegrations(next.integrations),
    webIdentity: normalizeWebIdentity(next.webIdentity),
  };
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return payload;
}

module.exports = {
  SETTINGS_FILE,
  DEFAULT_WORKSPACE_ROOT,
  DEFAULT_RUN_LIMITS,
  LOCAL_RUN_LIMITS,
  DEFAULT_SECURITY_CONTROLS,
  DEFAULT_VOICE_SETTINGS,
  DEFAULT_USER_PROFILE,
  DEFAULT_MEMORY_AUTONOMY,
  DEFAULT_WEB_IDENTITY,
  VALID_TEAM_MODES,
  VALID_EXECUTION_CORES,
  settingsPath,
  normalizeWorkspaceRoot,
  normalizeRunLimits,
  normalizeSecurityControls,
  normalizeVoiceSettings,
  normalizeUserProfile,
  normalizeMemoryAutonomy,
  normalizeBaseUrl,
  normalizeExecutionMode,
  normalizeIntegrations,
  normalizeWebIdentity,
  normalizeTeamMode,
  normalizeExecutionCore,
  readSettings,
  writeSettings,
};
