'use strict';

const { ipcMain, app, BrowserWindow, shell } = require('electron');
const os = require('os');
const fsSync = require('fs');
const pathMod = require('path');
const cryptoMod = require('crypto');

const { ensureObject, clampNumber, truncate, stripThinkTags } = require('./utils');
const { normalizeExecutionMode } = require('./settings');
const { readSettings, writeSettings, DEFAULT_RUN_LIMITS, LOCAL_RUN_LIMITS } = require('./settings');
const { normalizeRunLimits, normalizeSecurityControls, normalizeVoiceSettings, normalizeUserProfile, normalizeMemoryAutonomy, normalizeWebIdentity } = require('./settings');
const { appendAuditEvent } = require('./audit');
const {
  PROVIDERS,
  DEFAULT_PROVIDER,
  normalizeProvider,
  normalizeBaseUrl,
  defaultBaseUrlForProvider,
  pickBestModel,
  extractOutputText,
  listModels,
  callResponsesWithFallback,
  resolveAgentModel,
  providerRequiresApiKey,
  resolveProviderAndKey,
} = require('./providers');
const { activeRunIds, persistRunState, readRunState, listRunStates, summarizeRunForList, buildWorkflowView, requestRunStop, clearRunStopRequest, appendRunDebugEvent } = require('./run-state');
const { watchStateByRun, defaultWatchAgents, watchSnapshot, hydrateWatchFromRunState, createWatchWindow, broadcastWatchEvent } = require('./watch-manager');
const { resolveWorkspaceRoot } = require('./workspace');
const { normalizeAction, executePlannedActions, getSecurityProfile } = require('./tools');
const { createAgentPlan, summarizeExecution, runObjectiveCore, collectWrittenFilePaths } = require('./agent-loop');
const { collectWrittenArtifactsFromRun, readGlobalMemory, readProjectMemory, writeGlobalMemory } = require('./memory');
const { executeWebSearch, executeWebScrape, webSearch, webScrape } = require('./web-research');
const { getCostSummary, getRunCostDetails, getTodayCost, getRunUsage } = require('./token-tracker');
const { listProjects, addProject, removeProject, updateProject, setActiveProject, getProjectDetail } = require('./project-manager');
const {
  addScheduledTask,
  updateScheduledTask,
  removeScheduledTask,
  listScheduledTasks,
  runScheduledTaskNow,
} = require('./scheduler');
const {
  addTrigger,
  updateTrigger,
  removeTrigger,
  listTriggers,
} = require('./triggers');
const {
  retrieveContext,
  getRAGStats,
  indexFreeText,
  clearProjectVectors,
  projectNamespace,
  GLOBAL_NS,
} = require('./rag');
const {
  listPipelines,
  getPipeline,
  addPipeline,
  updatePipeline,
  removePipeline,
  executePipeline,
  approvePipelineStep,
  rejectPipelineStep,
  cancelPipelineRun,
  readPipelineRun,
  listPipelineRuns,
} = require('./workflow-engine');
const {
  executeIntegrationAction,
  approvePushForRun,
  revokePushApproval,
  postStatusWebhook,
} = require('./integrations');
const {
  ollamaStatus,
  ensureOllamaRunning,
  pullModel,
  deleteModel,
} = require('./ollama-manager');
const {
  loadBrowserControllerSpecsSync,
  listProposedBrowserControllerSpecs,
  promoteProposedBrowserControllerSpec,
} = require('./browser-controller-registry');

const QUICK_ROUTE_TIMEOUT_MS = 14000;
const SELF_HEAL_MAX_ATTEMPTS = 3;

function resolveOpenAiVoiceConfig(settings) {
  const voiceKey = String(settings.voice?.openaiApiKey || '').trim();
  const mainKeyForOpenai = String(settings.apiKeys?.openai || settings.apiKey || '').trim();
  const openaiKey = voiceKey || mainKeyForOpenai;
  if (!openaiKey) {
    throw new Error('Voice transcription needs an OpenAI API key. Add one in Settings -> Voice Assistant.');
  }
  const base = normalizeBaseUrl(
    settings.provider === 'openai'
      ? (settings.baseUrl || defaultBaseUrlForProvider('openai'))
      : defaultBaseUrlForProvider('openai'),
    'openai',
  );
  return { openaiKey, base };
}



function parseUserDeclaredLocation(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return '';
  const patterns = [
    /\bmy\s+location\s+is\s+([a-zA-Z0-9 .,'-]{2,80})/i,
    /\bi(?:'m| am)?\s+based\s+in\s+([a-zA-Z0-9 .,'-]{2,80})/i,
    /\bi(?:'m| am)?\s+located\s+in\s+([a-zA-Z0-9 .,'-]{2,80})/i,
    /\bi(?:'m| am)?\s+(?:currently\s+|actually\s+|now\s+)?in\s+([a-zA-Z0-9 .,'-]{2,80})/i,
    /\bi\s+moved\s+to\s+([a-zA-Z0-9 .,'-]{2,80})/i,
    /\bi\s+live\s+in\s+([a-zA-Z0-9 .,'-]{2,80})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || !match[1]) continue;
    return String(match[1]).replace(/[.?!]+$/, '').trim();
  }
  return '';
}

function parseUserDeclaredLocationsFromContext(threadContext = '') {
  const text = String(threadContext || '');
  if (!text) return [];
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const declared = parseUserDeclaredLocation(line);
    if (declared) out.push(declared);
    const cityState = line.match(/\b([A-Za-z .'-]{2,40}),\s*([A-Z]{2}|[A-Za-z .'-]{4,30})\b/);
    if (cityState) {
      out.push(`${cityState[1].trim()}, ${cityState[2].trim()}`);
    }
  }
  return dedupeAndLimit(out, 10);
}

function extractFirstJsonObject(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;
  const candidates = [text];
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.unshift(text.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // continue
    }
  }
  return null;
}

function dedupeAndLimit(values, limit = 8) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))).slice(0, Math.max(1, limit));
}

function extractKnowledgeObjectiveDomain(text = '') {
  const raw = String(text || '').trim();
  const urlMatch = raw.match(/https?:\/\/[^\s)]+/i);
  const candidates = [];
  if (urlMatch) candidates.push(urlMatch[0]);
  const bareDomainMatches = raw.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) || [];
  candidates.push(...bareDomainMatches);
  for (const candidate of candidates) {
    try {
      const url = candidate.includes('://') ? new URL(candidate) : new URL(`https://${candidate}`);
      const host = String(url.hostname || '').toLowerCase().replace(/^www\./, '');
      if (host) return host;
    } catch {
      // continue
    }
  }
  return '';
}

function objectiveMatchesControllerIntent(objective = '', intents = []) {
  const lower = String(objective || '').toLowerCase();
  const expected = Array.isArray(intents) ? intents.map((item) => String(item || '').toLowerCase()) : [];
  if (expected.length === 0) return true;
  const matched = new Set();
  if ((/\b(sign.?up|signup|register)\b/.test(lower) || (/\bcreate\b/.test(lower) && /\baccount\b/.test(lower)))) {
    matched.add('signup');
  }
  if (/\b(log.?in|login|sign.?in|signin)\b/.test(lower)) {
    matched.add('login');
  }
  if (/\b(verify|verification|confirm email|check inbox)\b/.test(lower)) {
    matched.add('verification');
  }
  if (/\b(checkout|place order|submit order|pay now|purchase|buy)\b/.test(lower)) {
    matched.add('checkout');
  }
  if (/\b(book|booking|reserve|reservation|schedule|appointment|demo)\b/.test(lower)) {
    matched.add('booking');
  }
  if (/\b(onboarding|onboard|finish setup|complete setup|get started|welcome flow)\b/.test(lower)) {
    matched.add('onboarding');
  }
  if (/\b(export|download|csv|pdf|report|statement)\b/.test(lower)) {
    matched.add('export');
  }
  return expected.some((intent) => matched.has(intent));
}

function summarizeBrowserControllerRunMaturity(runs = [], spec = {}) {
  const domains = Array.isArray(spec.match?.domains)
    ? spec.match.domains.map((item) => String(item || '').toLowerCase().replace(/^www\./, '')).filter(Boolean)
    : [];
  const intents = Array.isArray(spec.match?.intents) ? spec.match.intents : [];
  const relatedRuns = [];
  for (const run of Array.isArray(runs) ? runs : []) {
    const objective = String(run?.objective || '');
    const domain = extractKnowledgeObjectiveDomain(objective);
    if (domains.length > 0 && (!domain || !domains.includes(domain))) continue;
    if (!objectiveMatchesControllerIntent(objective, intents)) continue;
    relatedRuns.push(run);
  }

  let successfulRuns = 0;
  let browserActionRuns = 0;
  let lastSuccessAt = '';
  for (const run of relatedRuns) {
    const results = Array.isArray(run?.results) ? run.results : [];
    const browserResults = results.filter((result) => ['browser_launch', 'browser_action'].includes(String(result?.tool || '')));
    if (browserResults.length > 0) {
      browserActionRuns += 1;
    }
    const hadSuccessfulBrowserAction = browserResults.some((result) => result && result.ok === true);
    const hadFailedBrowserAction = browserResults.some((result) => result && result.ok !== true);
    const readinessOperational = run?.readiness && typeof run.readiness === 'object'
      ? run.readiness.operational?.ok === true
      : false;
    const completed = String(run?.state || '') === 'completed';
    if ((completed || readinessOperational) && hadSuccessfulBrowserAction && !hadFailedBrowserAction) {
      successfulRuns += 1;
      const ts = String(run.updatedAt || run.startedAt || run.createdAt || '');
      if (ts && (!lastSuccessAt || ts > lastSuccessAt)) {
        lastSuccessAt = ts;
      }
    }
  }

  const shouldPromote = successfulRuns >= 2;
  return {
    relatedRuns: relatedRuns.length,
    browserActionRuns,
    successfulRuns,
    lastSuccessAt: lastSuccessAt || null,
    shouldPromote,
    recommendation: shouldPromote
      ? `Observed ${successfulRuns} successful browser run(s) for this site. Ready to promote.`
      : (relatedRuns.length > 0
        ? `Observed ${successfulRuns}/${relatedRuns.length} successful related run(s). Keep validating before promotion.`
        : 'No related run history yet.'),
  };
}

function inferQuestionDomain(prompt) {
  const lower = String(prompt || '').toLowerCase();
  if (/\b(math|calcul|percent|average|sum|multiply|divide|equation|algebra|geometry)\b/.test(lower)) return 'math';
  if (/\b(code|coding|program|function|variable|bug|error|syntax|api|javascript|python|css|html|react|node)\b/.test(lower)) return 'programming';
  if (/\b(explain|definition|meaning|what is|what are|describe|concept)\b/.test(lower)) return 'explanation';
  if (/\b(compare|versus|vs\.?|better|difference|pros|cons|trade-?off)\b/.test(lower)) return 'comparison';
  if (/\b(how do|how can|how to|steps|instructions|guide|tutorial)\b/.test(lower)) return 'how-to';
  if (/\b(weather|temperature|forecast|rain|snow|wind)\b/.test(lower)) return 'weather';
  if (/\b(stock|market|price|invest|crypto|bitcoin)\b/.test(lower)) return 'finance';
  if (/\b(recipe|cook|food|ingredient|bake)\b/.test(lower)) return 'cooking';
  if (/\b(history|historical|century|war|president|king|queen)\b/.test(lower)) return 'history';
  if (/\b(science|physics|chemistry|biology|evolution|atom|molecule)\b/.test(lower)) return 'science';
  return 'general';
}

function isUsefulAutoAnswer(answer) {
  const text = String(answer || '').replace(/\s+/g, ' ').trim();
  if (text.length < 20) return false;
  const lower = text.toLowerCase();
  if (lower.includes('i can retry') || lower.includes('run deeper research')) return false;
  if (lower.includes('i hit an error') || lower.includes('timed out')) return false;
  return true;
}

function normalizeSkillEvent(raw, fallbackNote = '') {
  const event = ensureObject(raw);
  const name = String(event.name || '').trim();
  if (!name) return null;
  const domain = String(event.domain || 'general').trim() || 'general';
  const successValue = event.success;
  const success = successValue === true ? true : (successValue === false ? false : null);
  const note = String(event.note || fallbackNote || '').trim();
  return {
    name,
    domain,
    success,
    note,
    updatedAt: new Date().toISOString(),
  };
}

function applySkillEvents(profile, rawEvents) {
  const current = normalizeUserProfile(profile || {});
  const events = (Array.isArray(rawEvents) ? rawEvents : [])
    .map((item) => normalizeSkillEvent(item))
    .filter(Boolean);
  if (events.length === 0) {
    return current;
  }

  const byKey = new Map();
  for (const skill of Array.isArray(current.skillStats) ? current.skillStats : []) {
    const key = `${String(skill.name || '').toLowerCase()}::${String(skill.domain || 'general').toLowerCase()}`;
    byKey.set(key, {
      name: String(skill.name || '').trim(),
      domain: String(skill.domain || 'general').trim() || 'general',
      attempts: Number(skill.attempts) || 0,
      successes: Number(skill.successes) || 0,
      failures: Number(skill.failures) || 0,
      lastOutcome: String(skill.lastOutcome || 'unknown').trim() || 'unknown',
      notes: dedupeAndLimit(skill.notes, 8),
      updatedAt: String(skill.updatedAt || '').trim() || null,
    });
  }

  for (const event of events) {
    const key = `${event.name.toLowerCase()}::${event.domain.toLowerCase()}`;
    const existing = byKey.get(key) || {
      name: event.name,
      domain: event.domain,
      attempts: 0,
      successes: 0,
      failures: 0,
      lastOutcome: 'unknown',
      notes: [],
      updatedAt: null,
    };
    const next = {
      ...existing,
      attempts: existing.attempts + 1,
      updatedAt: event.updatedAt,
    };
    if (event.success === true) {
      next.successes += 1;
      next.lastOutcome = 'success';
    } else if (event.success === false) {
      next.failures += 1;
      next.lastOutcome = 'failure';
    } else {
      next.lastOutcome = 'unknown';
    }
    if (event.note) {
      next.notes = dedupeAndLimit([
        ...(existing.notes || []),
        event.note,
      ], 8);
    }
    byKey.set(key, next);
  }

  const skillStats = Array.from(byKey.values())
    .sort((left, right) => {
      const a = Number(new Date(right.updatedAt || 0)) - Number(new Date(left.updatedAt || 0));
      if (a !== 0) return a;
      return String(left.name || '').localeCompare(String(right.name || ''));
    })
    .slice(0, 80);

  return normalizeUserProfile({
    ...current,
    skillStats,
  });
}

function summarizeSkillNotebook(profile, globalNotes = [], sessionNotes = []) {
  const location = String(profile?.defaultLocation || '').trim();
  const knownLocations = Array.isArray(profile?.knownLocations) ? profile.knownLocations : [];
  const strategies = Array.isArray(profile?.learnedStrategies) ? profile.learnedStrategies : [];
  const skillStats = Array.isArray(profile?.skillStats) ? profile.skillStats : [];
  const notes = Array.isArray(globalNotes) ? globalNotes : [];
  const sessions = Array.isArray(sessionNotes) ? sessionNotes : [];
  const lines = [];
  if (location) {
    lines.push(`- Default location: ${location}`);
  }
  if (knownLocations.length > 0) {
    lines.push(`- Known locations: ${knownLocations.slice(0, 6).join(', ')}`);
  }
  if (strategies.length > 0) {
    // Deduplicate similar strategies and show most recent
    const uniqueStrategies = [];
    const seen = new Set();
    for (const entry of strategies.slice().reverse()) {
      const key = entry.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().slice(0, 60);
      if (!seen.has(key)) {
        seen.add(key);
        uniqueStrategies.push(entry);
      }
    }
    lines.push(...uniqueStrategies.slice(0, 8).reverse().map((entry) => `- Strategy: ${entry}`));
  }
  if (skillStats.length > 0) {
    // Separate reasoning skills from tool/routing skills for clearer context
    const reasoningSkills = skillStats.filter((s) => s.name === 'direct_reasoning');
    const otherSkills = skillStats.filter((s) => s.name !== 'direct_reasoning');

    if (reasoningSkills.length > 0) {
      const domainSummary = reasoningSkills
        .sort((a, b) => (Number(b.attempts) || 0) - (Number(a.attempts) || 0))
        .slice(0, 5)
        .map((s) => {
          const attempts = Math.max(0, Number(s.attempts) || 0);
          const successes = Math.max(0, Number(s.successes) || 0);
          return `${s.domain}(${successes}/${attempts})`;
        });
      lines.push(`- Question domains answered directly: ${domainSummary.join(', ')}`);
    }

    const topSkills = otherSkills
      .slice()
      .sort((left, right) => (Number(right.attempts) || 0) - (Number(left.attempts) || 0))
      .slice(0, 6);
    for (const skill of topSkills) {
      const attempts = Math.max(0, Number(skill.attempts) || 0);
      const successes = Math.max(0, Number(skill.successes) || 0);
      const rate = attempts > 0 ? Math.round((successes / attempts) * 100) : 0;
      lines.push(`- Skill: ${skill.name} (${skill.domain}) — success ${rate}% (${successes}/${attempts})`);
    }
  }
  if (notes.length > 0) {
    lines.push(...notes.slice(-10).map((entry) => `- Note: ${entry}`));
  }
  if (sessions.length > 0) {
    lines.push(...sessions.slice(-8).map((entry) => `- Session memory: ${entry}`));
  }
  return lines.length > 0 ? lines.join('\n') : '- No learned skills yet.';
}

function summarizeSessionRun(run) {
  const objective = String(run?.objective || run?.task || '').replace(/\s+/g, ' ').trim();
  const state = String(run?.state || '').trim().toLowerCase() || 'unknown';
  const reason = String(run?.reason || run?.report || '').replace(/\s+/g, ' ').trim();
  if (!objective && !reason) return '';
  const objectivePart = objective ? truncate(objective, 120) : 'Unnamed objective';
  const reasonPart = reason ? ` | ${truncate(reason, 140)}` : '';
  return `${state}: ${objectivePart}${reasonPart}`;
}

async function collectSessionMemoryNotes(limit = 8) {
  try {
    const runs = await listRunStates(Math.max(10, limit * 3));
    return runs
      .filter((run) => run && (run.state === 'completed' || run.state === 'stopped' || run.state === 'needs_info'))
      .map((run) => summarizeSessionRun(run))
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function buildMemoryDirectivePreview(memoryAutonomy) {
  const cfg = normalizeMemoryAutonomy(memoryAutonomy || {});
  const flush = cfg.compaction.memoryFlush.enabled;
  const sessionMemory = cfg.memorySearch.experimental.sessionMemory;
  const sources = cfg.memorySearch.experimental.sources;
  const sourcePhrase = sources.length > 0 ? sources.join(' and ') : 'memory';
  return [
    `Enable memory flush before compaction by setting compaction.memoryFlush.enabled to ${flush ? 'true' : 'false'}.`,
    `Set memorySearch.experimental.sessionMemory to ${sessionMemory ? 'true' : 'false'} with sources including ${sourcePhrase}.`,
    'Apply the config changes and use this memory policy for routing and learning updates.',
  ].join(' ');
}

async function persistLearningNotes(rawNotes) {
  const settings = await readSettings().catch(() => ({}));
  const memoryAutonomy = normalizeMemoryAutonomy(settings.memoryAutonomy || {});
  const flushBeforeCompaction = Boolean(memoryAutonomy?.compaction?.memoryFlush?.enabled);
  const normalizedInput = (Array.isArray(rawNotes) ? rawNotes : [])
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const flushedInput = flushBeforeCompaction
    ? normalizedInput.filter((note) => {
      const words = note.split(/\s+/).filter(Boolean);
      if (words.length < 3) return false;
      const lower = note.toLowerCase();
      if (lower.includes('unknown error') && words.length < 8) return false;
      return note.length >= 14;
    })
    : normalizedInput;
  const notes = dedupeAndLimit(flushedInput, 12);
  if (notes.length === 0) {
    return;
  }
  try {
    const memory = await readGlobalMemory();
    const existing = Array.isArray(memory?.userNotes) ? memory.userNotes : [];
    const merged = dedupeAndLimit([
      ...existing,
      ...notes,
    ], 80);
    await writeGlobalMemory({
      ...memory,
      userNotes: merged,
    });
  } catch {
    // Learning notes are best-effort; do not fail the main request.
  }
}

async function resolveAssistantModel(settings, requestedModel = '') {
  const requested = String(requestedModel || '').trim();
  if (requested) return requested;
  if (String(settings.model || '').trim()) return String(settings.model).trim();
  const { provider, apiKey, baseUrl } = resolveProviderAndKey(settings);
  if (!apiKey && providerRequiresApiKey(provider)) return '';
  try {
    const models = await listModels(provider, apiKey, baseUrl);
    if (models.length === 0) return '';
    const model = models[0];
    await writeSettings({ ...settings, model });
    return model;
  } catch {
    return '';
  }
}

async function persistUserProfilePatch(settings, patch = {}) {
  const currentProfile = normalizeUserProfile(settings.userProfile || {});
  const memoryAutonomy = normalizeMemoryAutonomy(settings.memoryAutonomy || {});
  const autoSkillReviewEnabled = memoryAutonomy?.learning?.autoSkillReview !== false;
  const patchObj = ensureObject(patch);
  const learnedStrategyValue = autoSkillReviewEnabled
    ? String(patchObj.learnedStrategy || '').trim()
    : '';
  const rawSkillEvents = Array.isArray(patchObj.skillEvents)
    ? patchObj.skillEvents
    : (patchObj.skillEvent ? [patchObj.skillEvent] : []);
  const normalizedSkillEvents = (autoSkillReviewEnabled ? rawSkillEvents : [])
    .map((item) => normalizeSkillEvent(item, patchObj.learnedStrategy || ''))
    .filter(Boolean);
  const profileWithSkills = normalizedSkillEvents.length > 0
    ? applySkillEvents(currentProfile, normalizedSkillEvents)
    : currentProfile;
  const nextProfile = normalizeUserProfile({
    ...profileWithSkills,
    ...patchObj,
    defaultLocation: String(patchObj.defaultLocation || profileWithSkills.defaultLocation || '').trim(),
    knownLocations: [
      ...(profileWithSkills.knownLocations || []),
      ...(Array.isArray(patchObj.knownLocations) ? patchObj.knownLocations : []),
      ...(patchObj.defaultLocation ? [patchObj.defaultLocation] : []),
    ],
    learnedStrategies: [
      ...(profileWithSkills.learnedStrategies || []),
      ...(Array.isArray(patchObj.learnedStrategies) ? patchObj.learnedStrategies : []),
      ...(learnedStrategyValue ? [learnedStrategyValue] : []),
    ],
    skillStats: profileWithSkills.skillStats || [],
    updatedAt: new Date().toISOString(),
  });
  if (JSON.stringify(nextProfile) === JSON.stringify(profileWithSkills)) {
    if (learnedStrategyValue) {
      await persistLearningNotes([learnedStrategyValue]);
    }
    return { updated: false, settings, profile: profileWithSkills };
  }
  const saved = await writeSettings({
    ...settings,
    userProfile: nextProfile,
  });
  if (learnedStrategyValue) {
    await persistLearningNotes([learnedStrategyValue]);
  }
  return {
    updated: true,
    settings: saved,
    profile: normalizeUserProfile(saved.userProfile || nextProfile),
  };
}

function heuristicAutoRoute(prompt, profile) {
  const text = String(prompt || '').trim();
  if (!text) return { route: 'ask_user', clarifyingQuestion: 'Tell me what you want me to work on.' };

  const lower = text.toLowerCase();
  const isQuestion = /\?\s*$/.test(text)
    || /^(what|when|where|who|why|how|is|are|can|could|should|do|does)\b/i.test(text);

  // Questions that need live/real-time data → research
  const needsLiveData = /\b(weather|forecast|temperature|stock|price|market|news|today|yesterday|latest|current|score|standings|election|results)\b/i.test(lower);

  if (isQuestion) {
    if (needsLiveData) {
      const queries = [text];
      if (profile?.defaultLocation) {
        queries.push(`${text} ${profile.defaultLocation}`);
      }
      return {
        route: 'research',
        researchQueries: queries,
        strategyNote: 'Use web research for time-sensitive or live data questions.',
      };
    }
    // General knowledge, reasoning, math, explanations → direct_answer
    return {
      route: 'direct_answer',
      strategyNote: 'Use direct reasoning for general knowledge and logic questions.',
    };
  }
  return { route: 'run_objective' };
}

async function buildAutoRoutePlan({
  settings,
  model,
  prompt,
  threadContext = '',
  profile,
  notebookText = '',
}) {
  if (!model || (!resolveProviderAndKey(settings).apiKey && providerRequiresApiKey(resolveProviderAndKey(settings).provider))) {
    return heuristicAutoRoute(prompt, profile);
  }
  try {
    const result = await callResponsesWithFallback({
      settings,
      model,
      input: [
        {
          role: 'system',
          content: [
            'You are Geepus Auto Router. Return ONLY JSON (no markdown).',
            'Goal: decide the best way to handle the user\'s request.',
            'JSON schema:',
            '{',
            '  "route":"direct_answer|research|ask_user|plan|run_objective",',
            '  "clarifyingQuestion":"",',
            '  "researchQueries":["..."],',
            '  "profileUpdate":{"defaultLocation":"", "learnedStrategy":""},',
            '  "finalStyle":"conversational"',
            '}',
            '',
            'Route selection guide:',
            '- direct_answer: Use when you can answer from general knowledge, reasoning, or logic.',
            '  Examples: math questions, definitions, explanations, comparisons, coding advice,',
            '  recommendations, "how does X work", grammar questions, conversational questions.',
            '  This is the DEFAULT for questions that do not need live/real-time data.',
            '- research: Use ONLY when the question needs fresh/real-time data you cannot know (current events, live prices, local conditions).',
            '  If context like location is needed and known, include it in the researchQueries.',
            '- ask_user: Use when CRITICAL context is genuinely missing for ANY request type (e.g., missing location for local queries, missing target for an action) and you cannot make a reasonable assumption.',
            '  IMPORTANT: You have an "Agent Identity" block in the user prompt. DO NOT ask the user for information (like email, username, or passwords) if you already have it in the Agent Identity block. Assume you will use those credentials and route to run_objective instead.',
            '  IMPORTANT: If the user is answering a previous clarifying question, DO NOT ask again. Use the context to answer the original question.',
            '- plan: Use for complex build/execute/change requests where the user wants to iterate on a plan before proceeding.',
            '  Examples: "Let\'s plan out the new feature", "How should we architect this?", "I want to build a new app, let\'s discuss".',
            '  Also use this if the request is large and ambiguous enough that jumping straight to execution is risky.',
            '- run_objective: Use ONLY for clear, specific build/execute/change requests (create files, write code, deploy) where the user wants immediate action.',
            '',
            'KEY PRINCIPLE: Most questions do NOT need web research. If a smart person could answer',
            'the question from memory, use direct_answer. Only use research for live/time-sensitive data.',
            '- If the user is answering a clarifying question, route based on the ORIGINAL request.',
            '- "What is the capital of France?" → direct_answer',
            '- "How do I center a div in CSS?" → direct_answer',
            '- "What is 15% of 230?" → direct_answer',
            '- "Compare React vs Vue" → direct_answer',
            '- "What is the weather today?" (location known) → research (include location in query)',
            '- "What is the weather today?" (location unknown) → ask_user',
            '- "Check the logs" (no logs specified) → ask_user',
            '- "What did the Fed announce yesterday?" → research',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `User request: ${prompt}`,
            `User's default location: ${profile?.defaultLocation || 'UNKNOWN'}`,
            settings?.webIdentity?.email ? `Agent Identity / Email: ${settings.webIdentity.email}` : '',
            settings?.webIdentity?.usernamePreference ? `Agent Username / Handle: ${settings.webIdentity.usernamePreference}` : '',
            '',
            `Learned skill notebook:\n${notebookText || summarizeSkillNotebook(profile)}`,
            '',
            threadContext ? `Recent thread context:\n${threadContext}` : 'Recent thread context: (none)',
          ].filter(Boolean).join('\n'),
        },
      ],
      temperature: 0,
    });
    const parsed = extractFirstJsonObject(stripThinkTags(extractOutputText(settings.provider, result.payload)));
    if (!parsed) return heuristicAutoRoute(prompt, profile);
    const route = String(parsed.route || '').trim().toLowerCase();
    const validRoutes = new Set(['direct_answer', 'research', 'ask_user', 'run_objective']);
    if (!validRoutes.has(route)) return heuristicAutoRoute(prompt, profile);
    return {
      route,
      clarifyingQuestion: String(parsed.clarifyingQuestion || '').trim(),
      researchQueries: dedupeAndLimit(parsed.researchQueries, 3),
      profileUpdate: ensureObject(parsed.profileUpdate),
    };
  } catch {
    return heuristicAutoRoute(prompt, profile);
  }
}

function heuristicSelfHealPlan({ prompt, failedRoute, failure, profile }) {
  const lowerPrompt = String(prompt || '').toLowerCase();

  if (/\b(stock|price|market|news|latest|today|schedule|score|standings)\b/i.test(`${prompt} ${failure}`)) {
    return {
      route: 'research',
      locationCandidates: [],
      researchQueries: dedupeAndLimit([
        prompt,
        `${prompt} latest official source`,
      ], 3),
      clarifyingQuestion: '',
    };
  }

  return {
    route: /\?\s*$/.test(String(prompt || '').trim()) ? 'research' : 'direct_answer',
    locationCandidates: [],
    researchQueries: dedupeAndLimit([
      prompt,
      `${prompt} official documentation`,
    ], 3),
    clarifyingQuestion: '',
  };
}

async function buildSelfHealPlan({
  settings,
  model,
  prompt,
  threadContext = '',
  profile,
  notebookText = '',
  failedRoute = '',
  failure = '',
}) {
  const heuristic = heuristicSelfHealPlan({ prompt, failedRoute, failure, profile });
  if (!model || (!resolveProviderAndKey(settings).apiKey && providerRequiresApiKey(resolveProviderAndKey(settings).provider))) {
    return heuristic;
  }
  try {
    const result = await callResponsesWithFallback({
      settings,
      model,
      input: [
        {
          role: 'system',
          content: [
            'You are Geepus Recovery Planner.',
            'A prior route failed or produced weak output.',
            'Return ONLY JSON (no markdown) using schema:',
            '{',
            '  "route":"research|direct_answer|ask_user|run_objective",',
            '  "locationCandidates":["..."],',
            '  "researchQueries":["..."],',
            '  "clarifyingQuestion":""',
            '}',
            'Rules:',
            '- Pick a DIFFERENT stronger approach if the previous approach failed.',
            '- Prefer autonomous recovery over asking the user.',
            '- Ask the user only when critical ambiguity remains after reasonable inference.',
            '- If the user is answering a previous clarifying question, DO NOT ask again. Use the context to answer the original question.',
            '- If location failed, infer likely canonical place from city/state/ZIP context and retry with research.',
            '- Prefer reusable tool patterns over task-specific fixes.',
            '- Treat this as a general problem-solving loop for arbitrary requests.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `Original request: ${prompt}`,
            `Failed route: ${failedRoute || '(unknown)'}`,
            `Failure detail: ${failure || '(none)'}`,
            `Previously attempted routes: ${Array.isArray(profile?.__attemptedRoutes) ? profile.__attemptedRoutes.join(', ') : '(none)'}`,
            '',
            `Skill notebook:\n${notebookText || summarizeSkillNotebook(profile)}`,
            '',
            threadContext ? `Recent thread context:\n${threadContext}` : 'Recent thread context: (none)',
          ].join('\n'),
        },
      ],
    });
    const parsed = extractFirstJsonObject(stripThinkTags(extractOutputText(settings.provider, result.payload)));
    if (!parsed) return heuristic;
    const route = String(parsed.route || '').trim().toLowerCase();
    const validRoutes = new Set(['research', 'direct_answer', 'ask_user', 'run_objective']);
    if (!validRoutes.has(route)) return heuristic;
    return {
      route,
      locationCandidates: dedupeAndLimit(parsed.locationCandidates, 8),
      researchQueries: dedupeAndLimit(parsed.researchQueries, 4),
      clarifyingQuestion: String(parsed.clarifyingQuestion || '').trim(),
    };
  } catch {
    return heuristic;
  }
}

async function answerWithEvidence({
  settings,
  model,
  prompt,
  threadContext = '',
  profile,
  notebookText = '',
  evidence = '',
}) {
  if (!model || (!resolveProviderAndKey(settings).apiKey && providerRequiresApiKey(resolveProviderAndKey(settings).provider))) {
    return 'I could not complete that answer right now — my API connection is not configured. Check your API key in settings.';
  }
  const hasEvidence = String(evidence || '').trim().length > 30;
  try {
    const result = await callResponsesWithFallback({
      settings,
      model,
      input: [
        {
          role: 'system',
          content: hasEvidence
            ? [
              'You are Geepus, a conversational digital assistant.',
              'Your job: synthesize the evidence below into a concise, human-friendly answer.',
              'RULES:',
              '- Answer in 1-4 sentences like a knowledgeable friend would.',
              '- Pull out the key facts, numbers, and details that matter.',
              '- NEVER dump raw URLs, HTML, search snippets, or scrape text at the user.',
              '- NEVER describe what tools were used or how the search was performed.',
              '- NEVER echo the evidence verbatim — always rephrase into natural language.',
              '- If information is uncertain, say so briefly.',
              'Example: for weather data, say "It\'ll be chilly — high around 45°F with rain likely" not a data dump.',
            ].join(' ')
            : [
              'You are Geepus, a conversational digital assistant.',
              'Your job: reason through the user\'s question and give a clear, correct answer.',
              'HOW TO THINK:',
              '- Understand what is being asked before answering.',
              '- For factual questions: recall what you know, state it clearly.',
              '- For math/logic/reasoning: work through it step by step in your head, then give the answer with brief justification.',
              '- For comparisons: state the key trade-offs, then your recommendation.',
              '- If the question has multiple valid interpretations, answer the most likely one.',
              '- If you are unsure, say what you know and flag the uncertain parts. Never guess confidently.',
              'RULES:',
              '- Be concise: 1-4 sentences for simple questions, more for complex ones.',
              '- Talk like a knowledgeable friend, not a textbook.',
              '- Answer the actual question — don\'t dodge with "it depends" unless it truly does.',
            ].join(' '),
        },
        {
          role: 'user',
          content: [
            `User question: ${prompt}`,
            '',
            threadContext ? `Recent thread context:\n${threadContext}` : '',
            '',
            hasEvidence ? `Evidence gathered (synthesize this — do NOT show raw):\n${evidence}` : '',
          ].filter(Boolean).join('\n'),
        },
      ],
      temperature: 0.4,
    });
    return stripThinkTags(extractOutputText(settings.provider, result.payload));
  } catch {
    // NEVER return raw evidence — it contains ugly search/scrape dumps.
    // Return a message that isUsefulAutoAnswer() rejects, so the self-healing
    // loop can try a different approach rather than showing this to the user.
    return 'I gathered some data but hit an issue synthesizing it. I can retry with a different approach.';
  }
}

function searchResultsToEvidence(batches, scraps = []) {
  const lines = [];
  for (const batch of batches || []) {
    const query = String(batch.query || '').trim();
    const results = Array.isArray(batch.results) ? batch.results : [];
    if (query) lines.push(`Query: ${query}`);
    for (const result of results.slice(0, 4)) {
      lines.push(`- ${result.title || 'Result'} | ${result.url || ''} | ${truncate(String(result.snippet || ''), 260)}`);
    }
    if (query) lines.push('');
  }
  for (const item of scraps || []) {
    lines.push(`Scrape: ${item.title || item.url}`);
    lines.push(`URL: ${item.url}`);
    lines.push(truncate(String(item.text || ''), 600));
    lines.push('');
  }
  return lines.join('\n').trim();
}

function looksUsableEvidence(evidenceText) {
  const text = String(evidenceText || '').trim();
  return text.length >= 80;
}

async function runResearchSynthesis({
  settings,
  model,
  prompt,
  threadContext = '',
  profile,
  notebookText = '',
  queries = [],
}) {
  const normalizedQueries = dedupeAndLimit(
    Array.isArray(queries) && queries.length > 0 ? queries : [prompt],
    4,
  );
  const searchBatches = [];
  for (const query of normalizedQueries) {
    try {
      const results = await webSearch(query, {
        count: 6,
        braveApiKey: settings.braveSearchApiKey || '',
      });
      searchBatches.push({ query, results });
    } catch (error) {
      searchBatches.push({ query, error: String(error?.message || error || '') });
    }
  }

  const urls = dedupeAndLimit(
    searchBatches.flatMap((batch) => (Array.isArray(batch.results) ? batch.results.map((item) => item.url) : [])),
    2,
  );
  const scraps = [];
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) continue;
    try {
      const scraped = await webScrape(url, { maxLength: 2200 });
      scraps.push(scraped);
    } catch {
      // Keep going with what we have.
    }
  }

  const evidence = searchResultsToEvidence(searchBatches, scraps);
  if (looksUsableEvidence(evidence)) {
    const answer = await answerWithEvidence({
      settings,
      model,
      prompt,
      threadContext,
      profile,
      notebookText,
      evidence,
    });
    return { ok: true, answer: String(answer || '').trim(), evidence };
  }

  const fallbackAnswer = await answerWithEvidence({
    settings,
    model,
    prompt,
    threadContext,
    profile,
    notebookText,
    evidence: 'Web retrieval returned low-confidence evidence. Provide a best-effort answer with uncertainty stated clearly.',
  });
  return {
    ok: false,
    answer: `${String(fallbackAnswer || '').trim()}\n\nIf you want higher confidence, say "run deep research" and I will widen sources.`,
    evidence,
  };
}

async function attemptSelfHealingInfoRecovery({
  settings,
  model,
  prompt,
  threadContext = '',
  profile,
  notebookText = '',
  failedRoute = '',
  failure = '',
  preferredLocation = '',
}) {
  const attemptedRoutes = [];
  let lastFailure = String(failure || 'unknown error').trim();
  let lastRoute = String(failedRoute || 'unknown').trim();
  let pendingAsk = null;

  for (let attempt = 1; attempt <= SELF_HEAL_MAX_ATTEMPTS; attempt += 1) {
    const recoveryProfile = {
      ...(ensureObject(profile)),
      __attemptedRoutes: attemptedRoutes.slice(),
    };
    const plan = await buildSelfHealPlan({
      settings,
      model,
      prompt,
      threadContext,
      profile: recoveryProfile,
      notebookText,
      failedRoute: lastRoute,
      failure: lastFailure,
    });
    const plannedRoute = String(plan.route || '').trim().toLowerCase();
    attemptedRoutes.push(plannedRoute || 'unknown');

    try {
      if (plannedRoute === 'run_objective') {
        return { handled: false };
      }
      if (plannedRoute === 'ask_user') {
        if (plan.clarifyingQuestion) {
          await persistLearningNotes([
            `Self-healing recovery asked user for clarification: "${plan.clarifyingQuestion}" regarding request: "${prompt}". The user's next message will likely contain the answer. Remember this answer for future similar requests.`
          ]);
        }
        pendingAsk = {
          handled: true,
          answer: plan.clarifyingQuestion || 'I need one more detail to continue.',
          needsInfo: true,
        };
        lastRoute = plannedRoute;
        lastFailure = 'Planner requested missing user detail.';
        continue;
      }

      if (plannedRoute === 'research') {
        const research = await runResearchSynthesis({
          settings,
          model,
          prompt,
          threadContext,
          profile,
          notebookText,
          queries: plan.researchQueries,
        });
        if (isUsefulAutoAnswer(research.answer)) {
          return { handled: true, answer: research.answer, recovered: true, attempts: attempt };
        }
        lastRoute = plannedRoute;
        lastFailure = 'Research synthesis returned weak output.';
        continue;
      }

      const direct = await answerWithEvidence({
        settings,
        model,
        prompt,
        threadContext,
        profile,
        notebookText,
        evidence: `Prior route failed (${lastRoute || 'unknown'}): ${lastFailure || 'unknown error'}. Provide the best direct response with transparent uncertainty and a concrete next step.`,
      });
      const answer = String(direct || '').trim();
      if (isUsefulAutoAnswer(answer)) {
        return { handled: true, answer, recovered: true, attempts: attempt };
      }
      lastRoute = plannedRoute;
      lastFailure = 'Direct answer path returned weak output.';
    } catch (error) {
      lastRoute = plannedRoute || lastRoute;
      lastFailure = String(error?.message || error || 'unknown recovery error');
    }
  }

  if (pendingAsk) return pendingAsk;
  return {
    handled: true,
    answer: 'I tried multiple recovery strategies but still could not produce a reliable answer yet. Give me one more detail and I will continue.',
    needsInfo: true,
  };
}

async function solveAutoInfoRequest({
  settings,
  model,
  prompt,
  threadContext = '',
}) {
  let workingSettings = settings;
  let profile = normalizeUserProfile(settings.userProfile || {});
  const memoryAutonomy = normalizeMemoryAutonomy(settings.memoryAutonomy || {});
  const searchSources = Array.isArray(memoryAutonomy?.memorySearch?.experimental?.sources)
    ? memoryAutonomy.memorySearch.experimental.sources
    : ['memory'];
  const includeGlobalMemory = searchSources.includes('memory');
  const includeSessionMemory = Boolean(memoryAutonomy?.memorySearch?.experimental?.sessionMemory)
    && searchSources.includes('sessions');
  let globalMemory = null;
  try {
    globalMemory = await readGlobalMemory();
  } catch {
    globalMemory = { userNotes: [] };
  }
  const sessionNotes = includeSessionMemory ? await collectSessionMemoryNotes(8) : [];
  const notebookText = summarizeSkillNotebook(
    profile,
    includeGlobalMemory && Array.isArray(globalMemory?.userNotes) ? globalMemory.userNotes : [],
    sessionNotes,
  );

  const declaredLocation = parseUserDeclaredLocation(prompt);
  if (declaredLocation) {
    const profileWrite = await persistUserProfilePatch(workingSettings, {
      defaultLocation: declaredLocation,
      knownLocations: [declaredLocation],
      learnedStrategy: 'Use saved default location for location-based informational requests.',
    });
    workingSettings = profileWrite.settings;
    profile = profileWrite.profile;
  }

  // Learn default location from thread context when possible.
  const contextualLocations = dedupeAndLimit([
    ...parseUserDeclaredLocationsFromContext(threadContext),
    String(profile?.defaultLocation || '').trim(),
  ].filter(Boolean), 6);
  if (!String(profile?.defaultLocation || '').trim() && contextualLocations.length > 0) {
    const inferredLocation = contextualLocations[0];
    const profileWrite = await persistUserProfilePatch(workingSettings, {
      defaultLocation: inferredLocation,
      knownLocations: contextualLocations,
      learnedStrategy: 'Infer and store default location from repeated context in conversation history.',
      skillEvent: {
        name: 'location_inference',
        domain: 'memory',
        success: true,
        note: `Learned default location from thread context: ${inferredLocation}`,
      },
    });
    workingSettings = profileWrite.settings;
    profile = profileWrite.profile;
  }

  // Extract any direct answers to previous clarifying questions from the thread context
  // and save them to memory so we don't have to ask again.
  if (threadContext) {
    const lines = threadContext.split('\n').map(l => l.trim()).filter(Boolean);
    const lastAssistantMsgIndex = lines.findLastIndex(l => l.startsWith('Assistant:'));
    if (lastAssistantMsgIndex >= 0 && lastAssistantMsgIndex < lines.length - 1) {
      const lastAssistantMsg = lines[lastAssistantMsgIndex];
      if (lastAssistantMsg.includes('?') && (lastAssistantMsg.toLowerCase().includes('what') || lastAssistantMsg.toLowerCase().includes('where') || lastAssistantMsg.toLowerCase().includes('which'))) {
        const userResponse = lines.slice(lastAssistantMsgIndex + 1).join(' ');
        if (userResponse.startsWith('User:')) {
          const cleanResponse = userResponse.replace(/^User:\s*/, '').trim();
          if (cleanResponse.length > 0 && cleanResponse.length < 100) {
            await persistLearningNotes([
              `User answered clarification question "${lastAssistantMsg.replace(/^Assistant:\s*/, '')}" with: "${cleanResponse}".`
            ]);
          }
        }
      }
    }
  }



  const routePlan = await Promise.race([
    buildAutoRoutePlan({
      settings: workingSettings,
      model,
      prompt,
      threadContext,
      profile,
      notebookText,
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Auto route timed out after ${Math.round(QUICK_ROUTE_TIMEOUT_MS / 1000)}s`)), QUICK_ROUTE_TIMEOUT_MS);
    }),
  ]);
  const plannedProfilePatch = ensureObject(routePlan.profileUpdate);
  if (Object.keys(plannedProfilePatch).length > 0) {
    const profileWrite = await persistUserProfilePatch(workingSettings, plannedProfilePatch);
    workingSettings = profileWrite.settings;
    profile = profileWrite.profile;
  }

  const route = String(routePlan.route || '').trim().toLowerCase();

  if (route === 'plan') {
    await persistUserProfilePatch(workingSettings, {
      learnedStrategy: 'Route complex or ambiguous requests to the planner for iteration.',
      skillEvent: {
        name: 'auto_route_planning',
        domain: 'routing',
        success: true,
        note: 'Classified request as needing planning and routed to planner.',
      },
    });
    return { handled: true, route: 'plan' };
  }

  if (route === 'run_objective') {
    await persistUserProfilePatch(workingSettings, {
      learnedStrategy: 'Route build/execute requests into the autonomous objective loop.',
      skillEvent: {
        name: 'auto_route_execution',
        domain: 'routing',
        success: true,
        note: 'Classified request as execution-oriented and routed to objective engine.',
      },
    });
    return { handled: false };
  }
  if (route === 'ask_user') {
    await persistUserProfilePatch(workingSettings, {
      learnedStrategy: 'Ask concise clarifying questions when critical inputs are missing.',
      skillEvent: {
        name: 'clarification_management',
        domain: 'dialog',
        success: true,
        note: 'Asked for required missing context before execution.',
      },
    });

    if (routePlan.clarifyingQuestion) {
      await persistLearningNotes([
        `Asked user for clarification: "${routePlan.clarifyingQuestion}" regarding request: "${prompt}". The user's next message will likely contain the answer. Remember this answer for future similar requests.`
      ]);
    }

    return {
      handled: true,
      answer: routePlan.clarifyingQuestion || 'I need one detail before I continue. What key info should I use?',
      needsInfo: true,
    };
  }

  if (route === 'research') {
    try {
      const research = await runResearchSynthesis({
        settings: workingSettings,
        model,
        prompt,
        threadContext,
        profile,
        notebookText,
        queries: routePlan.researchQueries,
      });
      await persistUserProfilePatch(workingSettings, {
        learnedStrategy: String(routePlan.profileUpdate?.learnedStrategy || routePlan.strategyNote || 'For fresh factual questions, perform web search then synthesize.').trim(),
        skillEvents: [
          {
            name: 'web_research_synthesis',
            domain: 'information',
            success: research.ok,
            note: research.ok
              ? 'Completed web research and generated synthesized answer.'
              : 'Web retrieval was weak; recovered with transparent best-effort answer.',
          },
          ...(research.ok ? [] : [{
            name: 'reasoning_recovery',
            domain: 'information',
            success: true,
            note: 'Recovered with transparent best-effort reasoning when retrieval was weak.',
          }]),
        ],
      });
      return {
        handled: true,
        answer: String(research.answer || '').trim() || 'I could not produce an answer from the current evidence.',
      };
    } catch (error) {
      const researchError = String(error?.message || error || 'unknown error');
      const healed = await attemptSelfHealingInfoRecovery({
        settings: workingSettings,
        model,
        prompt,
        threadContext,
        profile,
        notebookText,
        failedRoute: 'research',
        failure: researchError,
      });
      if (healed?.handled) {
        await persistUserProfilePatch(workingSettings, {
          learnedStrategy: 'When research synthesis fails, recover with autonomous route replanning.',
          skillEvent: {
            name: 'autonomous_info_recovery',
            domain: 'information',
            success: true,
            note: 'Recovered from research failure via self-healing route planner.',
          },
        });
        return healed;
      }
      throw error;
    }
  }

  const answer = await answerWithEvidence({
    settings: workingSettings,
    model,
    prompt,
    threadContext,
    profile,
    notebookText,
    evidence: '',
  });
  const answerText = String(answer || '').trim();
  const questionDomain = inferQuestionDomain(prompt);
  await persistUserProfilePatch(workingSettings, {
    learnedStrategy: String(
      routePlan.profileUpdate?.learnedStrategy
      || `For ${questionDomain} questions, use direct reasoning instead of web research.`
    ).trim(),
    skillEvent: {
      name: 'direct_reasoning',
      domain: questionDomain,
      success: isUsefulAutoAnswer(answerText),
      note: `Answered ${questionDomain} question via direct reasoning without web search.`,
    },
  });
  return { handled: true, answer: answerText || 'I can help with that. Tell me what outcome you want first.' };
}

async function persistObjectiveLearningOutcome({ request, result, source = 'run' } = {}) {
  try {
    const latestSettings = await readSettings();
    const state = String(result?.state || '').trim().toLowerCase() || 'unknown';
    const success = state === 'completed';
    const objective = String(result?.objective || request?.task || '').trim();
    const reason = String(result?.reason || result?.summary || result?.report || '').trim();
    const objectiveShort = objective ? truncate(objective, 180) : 'unspecified objective';
    const reasonShort = reason ? truncate(reason, 180) : '';

    await persistUserProfilePatch(latestSettings, {
      learnedStrategy: success
        ? 'Reuse iterative plan -> execute -> review loops for autonomous objective delivery.'
        : 'When objective runs stall or fail, diversify approach and ask for missing constraints early.',
      skillEvent: {
        name: 'autonomous_objective_execution',
        domain: 'execution',
        success,
        note: success
          ? `${source} completed: ${objectiveShort}`
          : `${source} ended (${state}): ${objectiveShort}${reasonShort ? ` | ${reasonShort}` : ''}`,
      },
    });

    if (reasonShort) {
      await persistLearningNotes([
        `${source} objective outcome (${state}): ${reasonShort}`,
      ]);
    }
  } catch {
    // Best-effort learning persistence.
  }
}

async function persistObjectiveLearningFailure({ request, error, source = 'run' } = {}) {
  const message = String(error?.message || error || 'unknown error').trim();
  try {
    const latestSettings = await readSettings();
    const objective = String(request?.task || '').trim();
    await persistUserProfilePatch(latestSettings, {
      learnedStrategy: 'When an objective run throws immediately, retry with safer parameters and alternate tools.',
      skillEvent: {
        name: 'autonomous_objective_execution',
        domain: 'execution',
        success: false,
        note: `${source} failed before completion: ${truncate(message, 180)}${objective ? ` | objective: ${truncate(objective, 120)}` : ''}`,
      },
    });
  } catch {
    // Best-effort learning persistence.
  }
}

const DEFAULT_TRANSCRIPTION_MODELS = [
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe-latest',
  'gpt-4o-transcribe',
  'whisper-1',
];

function isTranscriptionModelCandidate(modelId) {
  const lower = String(modelId || '').toLowerCase();
  if (!lower) return false;
  if (lower.includes('tts')) return false;
  return lower.includes('transcribe') || lower.includes('whisper');
}

function preferredTranscriptionModels(requestedModel = '') {
  return Array.from(new Set([
    String(requestedModel || '').trim(),
    ...DEFAULT_TRANSCRIPTION_MODELS,
  ].filter(isTranscriptionModelCandidate)));
}

function parseRealtimeEventText(payload) {
  const type = String(payload?.type || '');
  if (!type) return null;
  if (type === 'conversation.item.input_audio_transcription.delta') {
    return { kind: 'delta', text: String(payload?.delta || '').trim() };
  }
  if (type === 'conversation.item.input_audio_transcription.completed') {
    return { kind: 'final', text: String(payload?.transcript || '').trim() };
  }
  if (type.includes('transcription') || type.includes('transcript')) {
    const text = String(
      payload?.transcript
      || payload?.text
      || payload?.delta
      || payload?.item?.transcript
      || '',
    ).trim();
    if (text) {
      const kind = type.includes('delta') ? 'delta' : 'final';
      return { kind, text };
    }
  }
  return null;
}

function registerIpcHandlers() {
  const realtimeSessions = new Map();

  const sendRealtimeEvent = (session, payload) => {
    try {
      if (session && session.sender && !session.sender.isDestroyed()) {
        session.sender.send('audio:realtimeEvent', payload);
      }
    } catch {
      // Ignore renderer delivery failures.
    }
  };

  const sendRealtimeMessage = (session, payload) => {
    if (!session || session.closed) return;
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (!session.ready) {
      session.queue.push(raw);
      return;
    }
    try {
      session.ws.send(raw);
    } catch {
      // best-effort
    }
  };

  const closeRealtimeSession = (sessionId, { notify = false, reason = '' } = {}) => {
    const session = realtimeSessions.get(sessionId);
    if (!session) return;
    realtimeSessions.delete(sessionId);
    session.closed = true;
    try {
      if (session.ws && session.ws.readyState < 2) {
        session.ws.close();
      }
    } catch {
      // no-op
    }
    if (notify) {
      sendRealtimeEvent(session, {
        sessionId,
        type: 'closed',
        reason: String(reason || '').trim(),
      });
    }
  };

  ipcMain.handle('audio:realtimeStart', async (event, request) => {
    const settings = await readSettings();
    const { openaiKey, base } = resolveOpenAiVoiceConfig(settings);
    const preferredModel = String(request?.transcriptionModel || '').trim();
    let model = preferredTranscriptionModels(preferredModel)[0] || 'gpt-4o-mini-transcribe';
    try {
      const listResp = await fetch(`${base}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${openaiKey}`,
        },
      });
      if (listResp.ok) {
        const payload = await listResp.json().catch(() => ({}));
        const accessible = Array.isArray(payload?.data)
          ? payload.data
            .map((item) => String(item?.id || '').trim())
            .filter(Boolean)
          : [];
        const ranked = preferredTranscriptionModels(preferredModel);
        const discoveredChoice = ranked.find((id) => accessible.includes(id));
        if (discoveredChoice) {
          model = discoveredChoice;
        }
      }
    } catch {
      // Fall back to default transcription model order.
    }
    const sessionId = cryptoMod.randomUUID();
    const wsBase = String(base || 'https://api.openai.com/v1')
      .replace(/^https:/i, 'wss:')
      .replace(/^http:/i, 'ws:')
      .replace(/\/+$/, '');
    const wsUrl = `${wsBase}/realtime?intent=transcription&model=${encodeURIComponent(model)}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    const session = {
      id: sessionId,
      ws,
      sender: event.sender,
      queue: [],
      ready: false,
      closed: false,
      partialText: '',
      finalText: '',
      model,
    };
    realtimeSessions.set(sessionId, session);

    ws.addEventListener('open', () => {
      const current = realtimeSessions.get(sessionId);
      if (!current) return;
      current.ready = true;

      sendRealtimeMessage(current, {
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: {
                type: 'audio/pcm',
                rate: 24000,
              },
              noise_reduction: {
                type: 'near_field',
              },
              transcription: {
                model,
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
              },
            },
          },
          include: [
            'item.input_audio_transcription.logprobs',
          ],
        },
      });

      while (current.queue.length > 0) {
        const item = current.queue.shift();
        if (!item) continue;
        try { current.ws.send(item); } catch { /* no-op */ }
      }

      sendRealtimeEvent(current, { sessionId, type: 'ready', model });
    });

    ws.addEventListener('message', (eventPayload) => {
      const current = realtimeSessions.get(sessionId);
      if (!current) return;
      const raw = typeof eventPayload?.data === 'string'
        ? eventPayload.data
        : Buffer.from(eventPayload?.data || '').toString('utf8');
      let payload = {};
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        payload = {};
      }

      if (String(payload?.type || '') === 'error') {
        const message = String(payload?.error?.message || payload?.message || raw || 'Realtime voice error');
        sendRealtimeEvent(current, { sessionId, type: 'error', message });
        return;
      }

      const textEvent = parseRealtimeEventText(payload);
      if (textEvent && textEvent.text) {
        if (textEvent.kind === 'delta') {
          const next = `${String(current.partialText || '')} ${String(textEvent.text || '')}`.replace(/\s+/g, ' ').trim();
          current.partialText = next;
          sendRealtimeEvent(current, { sessionId, type: 'transcript_delta', text: current.partialText });
        } else {
          current.finalText = textEvent.text;
          current.partialText = '';
          sendRealtimeEvent(current, { sessionId, type: 'transcript_final', text: current.finalText });
        }
      }
    });

    ws.addEventListener('error', (error) => {
      const current = realtimeSessions.get(sessionId);
      if (!current) return;
      const message = String(error?.message || 'Realtime connection failed.');
      sendRealtimeEvent(current, { sessionId, type: 'error', message });
    });

    ws.addEventListener('close', () => {
      closeRealtimeSession(sessionId, { notify: true, reason: 'socket_closed' });
    });

    return { sessionId, model };
  });

  ipcMain.handle('audio:realtimeAppend', async (_event, request) => {
    const sessionId = String(request?.sessionId || '').trim();
    const audioBase64 = String(request?.audioBase64 || '').trim();
    if (!sessionId || !audioBase64) return { ok: false };
    const session = realtimeSessions.get(sessionId);
    if (!session || session.closed) return { ok: false };
    sendRealtimeMessage(session, {
      type: 'input_audio_buffer.append',
      audio: audioBase64,
    });
    return { ok: true };
  });

  ipcMain.handle('audio:realtimeCommit', async (_event, request) => {
    const sessionId = String(request?.sessionId || '').trim();
    if (!sessionId) return { ok: false };
    const session = realtimeSessions.get(sessionId);
    if (!session || session.closed) return { ok: false };
    sendRealtimeMessage(session, { type: 'input_audio_buffer.commit' });
    return { ok: true };
  });

  ipcMain.handle('audio:realtimeStop', async (_event, request) => {
    const sessionId = String(request?.sessionId || '').trim();
    if (!sessionId) return { ok: false };
    closeRealtimeSession(sessionId, { notify: false });
    return { ok: true };
  });

  ipcMain.handle('settings:load', async () => {
    const settings = await readSettings();
    const keys = settings.apiKeys || {};
    return {
      ...settings,
      availableProviders: ['auto', ...Object.keys(PROVIDERS)],
      apiKeyPresent: Boolean(keys.openai || keys.anthropic || settings.provider === 'ollama'),
      apiKeys: {
        openai: keys.openai ? '••••••••' : '',
        anthropic: keys.anthropic ? '••••••••' : '',
      },
      integrations: {
        ...(settings.integrations || {}),
        githubToken: settings.integrations?.githubToken ? '(set)' : '',
        emailApiKey: settings.integrations?.emailApiKey ? '(set)' : '',
        resendApiKey: settings.integrations?.resendApiKey ? '(set)' : '',
      },
      webIdentity: {
        ...(settings.webIdentity || {}),
        emailPassword: settings.webIdentity?.emailPassword ? '(set)' : '',
        resendApiKey: settings.webIdentity?.resendApiKey ? '(set)' : '',
      },
    };
  });

  ipcMain.handle('settings:save', async (_event, patch) => {
    const current = await readSettings();
    const next = {
      ...current,
      ...patch,
    };

    if (Object.prototype.hasOwnProperty.call(patch || {}, 'provider')) {
      next.provider = patch.provider === 'auto' ? 'auto' : normalizeProvider(patch.provider);
      const effectiveProvider = next.provider === 'auto' ? 'openai' : next.provider;
      if (!Object.prototype.hasOwnProperty.call(patch || {}, 'baseUrl')) {
        next.baseUrl = defaultBaseUrlForProvider(effectiveProvider);
      }
    }

    // Merge apiKeys partial object
    if (patch && typeof patch.apiKeys === 'object' && !Array.isArray(patch.apiKeys)) {
      const rawStored = await readSettings();
      const currentKeys = rawStored.apiKeys || {};
      next.apiKeys = {
        openai: typeof patch.apiKeys.openai === 'string' && patch.apiKeys.openai.trim() ? patch.apiKeys.openai.trim() : currentKeys.openai || '',
        anthropic: typeof patch.apiKeys.anthropic === 'string' && patch.apiKeys.anthropic.trim() ? patch.apiKeys.anthropic.trim() : currentKeys.anthropic || '',
      };
    }

    if (patch && typeof patch.runLimits === 'object' && !Array.isArray(patch.runLimits)) {
      next.runLimits = normalizeRunLimits({
        ...(current.runLimits || DEFAULT_RUN_LIMITS),
        ...patch.runLimits,
      }, current.runLimits || DEFAULT_RUN_LIMITS);
    }

    if (patch && typeof patch.securityControls === 'object' && !Array.isArray(patch.securityControls)) {
      next.securityControls = normalizeSecurityControls({
        ...(current.securityControls || {}),
        ...patch.securityControls,
      }, current.securityControls || {});
    }

    if (patch && typeof patch.voice === 'object' && !Array.isArray(patch.voice)) {
      next.voice = normalizeVoiceSettings({
        ...(current.voice || {}),
        ...patch.voice,
      }, current.voice || {});
    }

    if (patch && typeof patch.memoryAutonomy === 'object' && !Array.isArray(patch.memoryAutonomy)) {
      next.memoryAutonomy = normalizeMemoryAutonomy({
        ...(current.memoryAutonomy || {}),
        ...patch.memoryAutonomy,
      }, current.memoryAutonomy || {});
    }

    if (patch && typeof patch.userProfile === 'object' && !Array.isArray(patch.userProfile)) {
      next.userProfile = normalizeUserProfile({
        ...(current.userProfile || {}),
        ...patch.userProfile,
      }, current.userProfile || {});
    }

    // Merge integrations (partial patches, e.g. just webhookUrl)
    if (patch && typeof patch.integrations === 'object' && !Array.isArray(patch.integrations)) {
      const currentInteg = current.integrations || {};
      next.integrations = { ...currentInteg, ...patch.integrations };
    }

    // Merge webIdentity (partial patches)
    if (patch && typeof patch.webIdentity === 'object' && !Array.isArray(patch.webIdentity)) {
      const currentIdentity = current.webIdentity || {};
      next.webIdentity = { ...currentIdentity, ...patch.webIdentity };
    }

    const saved = await writeSettings(next);
    const savedKeys = saved.apiKeys || {};
    return {
      ...saved,
      availableProviders: ['auto', ...Object.keys(PROVIDERS)],
      apiKeyPresent: Boolean(savedKeys.openai || savedKeys.anthropic || saved.provider === 'ollama'),
      apiKeys: {
        openai: savedKeys.openai ? '••••••••' : '',
        anthropic: savedKeys.anthropic ? '••••••••' : '',
      },
      integrations: {
        ...(saved.integrations || {}),
        githubToken: saved.integrations?.githubToken ? '••••' : '',
        emailApiKey: saved.integrations?.emailApiKey ? '••••' : '',
        resendApiKey: saved.integrations?.resendApiKey ? '••••' : '',
      },
      webIdentity: {
        ...(saved.webIdentity || {}),
        emailPassword: saved.webIdentity?.emailPassword ? '••••' : '',
        resendApiKey: saved.webIdentity?.resendApiKey ? '••••' : '',
      },
    };
  });

  ipcMain.handle('settings:clearKey', async () => {
    const current = await readSettings();
    const saved = await writeSettings({
      ...current,
      apiKeys: { openai: '', anthropic: '' },
    });

    return {
      ...saved,
      availableProviders: ['auto', ...Object.keys(PROVIDERS)],
      apiKeyPresent: false,
      apiKeys: { openai: '', anthropic: '' },
    };
  });

  ipcMain.handle('models:list', async () => {
    const settings = await readSettings();
    const { provider, apiKey, baseUrl } = resolveProviderAndKey(settings);
    if (!apiKey && providerRequiresApiKey(provider)) {
      throw new Error('Add your API key first.');
    }

    const models = await listModels(provider, apiKey, baseUrl);
    if (models.length === 0) {
      throw new Error('No models were returned for this API key.');
    }

    const currentModel = settings.model;
    const model = (currentModel && models.includes(currentModel))
      ? currentModel
      : pickBestModel(models, currentModel);

    if (!currentModel && model) {
      await writeSettings({ ...settings, model });
    }

    return {
      provider,
      models,
      selectedModel: model,
    };
  });

  ipcMain.handle('connector:test', async (_event, preferredModel, options = {}) => {
    const settings = await readSettings();
    const apiKeys = settings.apiKeys || {};
    const candidates = [];

    const runAllProviders = options && options.allProviders === true;
    const resolved = resolveProviderAndKey(settings);

    if (!runAllProviders && resolved.provider && resolved.provider !== 'auto') {
      if (!resolved.apiKey && providerRequiresApiKey(resolved.provider)) {
        throw new Error('Add your API key first.');
      }
      candidates.push({
        provider: resolved.provider,
        apiKey: resolved.apiKey,
        baseUrl: normalizeBaseUrl(resolved.baseUrl || defaultBaseUrlForProvider(resolved.provider), resolved.provider),
      });
    } else {
      if (apiKeys.openai) {
        candidates.push({
          provider: 'openai',
          apiKey: apiKeys.openai,
          baseUrl: normalizeBaseUrl(settings.baseUrl || defaultBaseUrlForProvider('openai'), 'openai'),
        });
      }
      if (apiKeys.anthropic) {
        candidates.push({
          provider: 'anthropic',
          apiKey: apiKeys.anthropic,
          baseUrl: defaultBaseUrlForProvider('anthropic'),
        });
      }
    }

    if (candidates.length === 0) {
      // Fall back to resolveProviderAndKey (e.g. Ollama)
      const { provider, apiKey, baseUrl } = resolveProviderAndKey(settings);
      if (!apiKey && providerRequiresApiKey(provider)) throw new Error('Add your API key first.');
      candidates.push({ provider, apiKey, baseUrl });
    }

    const results = await Promise.all(candidates.map(async ({ provider, apiKey, baseUrl }) => {
      try {
        const models = await listModels(provider, apiKey, baseUrl);
        if (models.length === 0) return { provider, ok: false, error: 'No models available' };
        const model = pickBestModel(models, preferredModel || settings.model);
        const effectiveSettings = { ...settings, provider, apiKey, baseUrl };
        const result = await callResponsesWithFallback({
          settings: effectiveSettings,
          model,
          input: 'Reply with exactly: Geepus is connected.',
        });
        return { provider, ok: true, model: result.model, message: extractOutputText(provider, result.payload) };
      } catch (err) {
        return { provider, ok: false, error: String(err?.message || err) };
      }
    }));

    // Persist the best available model from the primary (first ok) result
    const primary = results.find((r) => r.ok);
    if (!primary) throw new Error(results.map((r) => `${r.provider}: ${r.error}`).join('; '));
    if (primary.model && primary.model !== settings.model) {
      await writeSettings({ ...settings, model: primary.model });
    }

    return results;
  });

  ipcMain.handle('assistant:ask', async (_event, request) => {
    const baseSettings = await readSettings();
    const _rawProvider = String(request?.provider || baseSettings.provider || '').trim().toLowerCase();
    const provider = _rawProvider === 'auto' ? _rawProvider : normalizeProvider(_rawProvider);
    const settings = {
      ...baseSettings,
      provider,
      baseUrl: normalizeBaseUrl(
        request?.baseUrl
        || (provider === baseSettings.provider ? baseSettings.baseUrl : defaultBaseUrlForProvider(provider)),
        provider,
      ),
    };
    const { apiKey: _askResolvedKey } = resolveProviderAndKey(settings);
    if (!_askResolvedKey && providerRequiresApiKey(settings.provider)) {
      throw new Error('Add your API key first.');
    }

    const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : '';
    if (!prompt) {
      throw new Error('Please type a request first.');
    }
    const history = Array.isArray(request?.history) ? request.history : [];
    const normalizedHistory = history
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        let content = String(item.content || '').trim();
        if (content.length > 800) content = content.slice(0, 800) + '...[truncated]';
        return {
          role: String(item.role || 'user').trim().toLowerCase() === 'assistant' ? 'assistant' : 'user',
          content,
        };
      })
      .filter((item) => item.content.length > 0)
      .slice(-12);

    const mode = String(request?.mode || 'chat').toLowerCase();

    const resolved = await resolveAgentModel(settings, request?.model, request?.message || '');
    const model = resolved.model;

    const systemPrompt = mode === 'planning'
      ? [
        'You are Geepus, helping the user plan what to build or do next.',
        'Talk like a sharp coworker — casual, direct, no jargon.',
        'Keep it short. Use plain language. Skip formalities.',
        'Don\'t execute anything or pretend you did.',
        'Wrap up with a quick "ready to go" checklist if it makes sense.',
      ].join(' ')
      : [
        'You are Geepus, the user\'s digital assistant.',
        'Talk like a smart friend — keep it casual, short, and clear.',
        'No technical jargon unless the user uses it first.',
        'Skip filler phrases like "Great question!" or "Certainly!".',
        '',
        'HOW TO THINK:',
        '- For factual questions: recall what you know, state key facts, give the answer.',
        '- For reasoning/math/logic: break the problem into steps. Show brief working if the answer is not obvious.',
        '- For "how do I" questions: give the most direct practical answer first, then context if needed.',
        '- For opinions/comparisons: state the trade-offs clearly, then give your recommendation.',
        '- If you are not sure about something, say what you do know and flag what you are uncertain about. Never make up facts.',
        '- If the question is ambiguous, answer the most likely interpretation and briefly note the other one.',
        '',
        'Keep answers concise (1-4 sentences for simple questions, longer for complex ones that need explanation).',
        'If they ask you to do something (build, create, fix), tell them to switch to Action Mode — one sentence, no lecture.',
        'Never claim you did something you didn\'t.',
      ].join('\n');

    const result = await callResponsesWithFallback({
      settings,
      model,
      input: [
        {
          role: 'system',
          content: systemPrompt,
        },
        ...normalizedHistory,
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.4,
    });

    return {
      provider: settings.provider,
      model: result.model,
      answer: stripThinkTags(extractOutputText(settings.provider, result.payload)),
    };
  });

  ipcMain.handle('assistant:autoAssist', async (_event, request) => {
    const baseSettings = await readSettings();
    const _rawProvider2 = String(request?.provider || baseSettings.provider || '').trim().toLowerCase();
    const provider = _rawProvider2 === 'auto' ? _rawProvider2 : normalizeProvider(_rawProvider2);
    const settings = {
      ...baseSettings,
      provider,
      baseUrl: normalizeBaseUrl(
        request?.baseUrl
        || (provider === baseSettings.provider ? baseSettings.baseUrl : defaultBaseUrlForProvider(provider)),
        provider,
      ),
    };

    const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : '';
    if (!prompt) {
      return { handled: false };
    }

    const threadContext = typeof request?.threadContext === 'string' ? request.threadContext.trim() : '';
    const model = await resolveAssistantModel(settings, request?.model);
    try {
      return await solveAutoInfoRequest({
        settings,
        model,
        prompt,
        threadContext,
      });
    } catch (error) {
      const failureText = String(error?.message || error || 'unknown error');
      try {
        const profile = normalizeUserProfile(settings.userProfile || {});
        const healed = await attemptSelfHealingInfoRecovery({
          settings,
          model,
          prompt,
          threadContext,
          profile,
          notebookText: summarizeSkillNotebook(profile),
          failedRoute: 'unknown',
          failure: failureText,
        });
        if (healed?.handled) {
          await persistUserProfilePatch(settings, {
            learnedStrategy: 'When auto-assist throws unexpectedly, run autonomous recovery planning before returning failure.',
            skillEvent: {
              name: 'autonomous_info_recovery',
              domain: 'information',
              success: true,
              note: 'Recovered from top-level auto-assist exception using self-healing planner.',
            },
          });
          return healed;
        }
      } catch {
        // Fall back to a transparent error if healing also fails.
      }
      return {
        handled: true,
        answer: `I hit an auto-assist error (${truncate(failureText, 180)}). I can retry with a different approach.`,
        error: failureText,
      };
    }
  });

  // -----------------------------------------------------------------------
  // Intent classification — fast LLM call to decide how to route a prompt
  // -----------------------------------------------------------------------
  ipcMain.handle('assistant:classifyIntent', async (_event, request) => {
    const baseSettings = await readSettings();
    const { provider, apiKey, baseUrl } = resolveProviderAndKey(baseSettings);
    const settings = { ...baseSettings, provider, apiKey, baseUrl };
    if (!apiKey && providerRequiresApiKey(provider)) {
      return { intent: 'unknown', confidence: 0 };
    }

    const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : '';
    if (!prompt) {
      return { intent: 'unknown', confidence: 0 };
    }

    const threadContext = typeof request?.threadContext === 'string' ? request.threadContext.trim() : '';
    let model = typeof request?.model === 'string' && request.model.trim().length > 0
      ? request.model.trim()
      : settings.model;

    try {
      const result = await callResponsesWithFallback({
        settings,
        model,
        input: [
          {
            role: 'system',
            content: [
              'You classify user messages into exactly one intent. Return ONLY a JSON object, no markdown.',
              'Intents:',
              '- "question": User is asking for information, instructions, explanations, or help understanding something. Includes "how do I", "what is", "can you explain", "give me instructions", "I want to use/try/understand", etc.',
              '- "action": User wants you to DO something — build, create, fix, test, deploy, research, write code, generate files, send things, etc. These are commands, not questions about how to do things.',
              '- "continuation": User is confirming or continuing a previous task — "yes", "go ahead", "proceed", "continue", "do it", "ok", "sounds good".',
              '- "file_lookup": User is explicitly asking where a file or report was saved — "where is the report", "can\'t find the file", "what path was it saved to".',
              'Schema: {"intent":"question|action|continuation|file_lookup"}',
              'If the user asks HOW to do something themselves, that\'s a question, not an action.',
              'If ambiguous, prefer "question" — it\'s better to answer than to launch a 5-minute task.',
            ].join('\n'),
          },
          ...(threadContext ? [{ role: 'user', content: `Recent conversation context:\n${threadContext}` }] : []),
          {
            role: 'user',
            content: `Classify this message:\n"${prompt}"`,
          },
        ],
        temperature: 0,
      });

      const output = stripThinkTags(extractOutputText(settings.provider, result.payload));
      // Extract JSON from response
      const jsonMatch = output.match(/\{[^}]*"intent"\s*:\s*"([^"]+)"[^}]*\}/);
      if (jsonMatch) {
        const intent = jsonMatch[1].toLowerCase().trim();
        const valid = new Set(['question', 'action', 'continuation', 'file_lookup']);
        if (valid.has(intent)) {
          return { intent, confidence: 1 };
        }
      }
      return { intent: 'unknown', confidence: 0 };
    } catch {
      return { intent: 'unknown', confidence: 0 };
    }
  });

  ipcMain.handle('assistant:askStreaming', async (event, request) => {
    const baseSettings = await readSettings();
    const _rawProvider3 = String(request?.provider || baseSettings.provider || '').trim().toLowerCase();
    const provider = _rawProvider3 === 'auto' ? _rawProvider3 : normalizeProvider(_rawProvider3);
    const settings = {
      ...baseSettings,
      provider,
      baseUrl: normalizeBaseUrl(
        request?.baseUrl
        || (provider === baseSettings.provider ? baseSettings.baseUrl : defaultBaseUrlForProvider(provider)),
        provider,
      ),
    };
    const { apiKey: _streamingResolvedKey } = resolveProviderAndKey(settings);
    if (!_streamingResolvedKey && providerRequiresApiKey(settings.provider)) {
      throw new Error('Add your API key first.');
    }

    const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : '';
    if (!prompt) {
      throw new Error('Please type a request first.');
    }
    const history = Array.isArray(request?.history) ? request.history : [];
    const normalizedHistory = history
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        let content = String(item.content || '').trim();
        if (content.length > 800) content = content.slice(0, 800) + '...[truncated]';
        return {
          role: String(item.role || 'user').trim().toLowerCase() === 'assistant' ? 'assistant' : 'user',
          content,
        };
      })
      .filter((item) => item.content.length > 0)
      .slice(-12);

    let model = typeof request?.model === 'string' && request.model.trim().length > 0
      ? request.model.trim()
      : settings.model;
    const mode = String(request?.mode || 'chat').toLowerCase();

    if (!model) {
      const { provider: rp, apiKey: rk, baseUrl: rb } = resolveProviderAndKey(settings);
      const models = await listModels(rp, rk, rb);
      if (models.length === 0) {
        throw new Error('No models available for this key.');
      }
      model = models[0];
      await writeSettings({ ...settings, model });
    }

    // Build context about the most recent run (if any) so chat responses
    // reference what Geepus just built instead of giving generic advice.
    let recentRunContext = '';
    try {
      const { listRunStates } = require('./run-state');
      const runs = await listRunStates();
      if (runs.length > 0) {
        const latest = runs[0];
        if (latest.state === 'completed' || latest.state === 'stopped') {
          const report = latest.report ? String(latest.report).slice(0, 600) : '';
          const objective = latest.objective || latest.task || '';
          const files = (latest.results || [])
            .filter(r => r && r.ok && (r.tool === 'write_file' || r.tool === 'append_file'))
            .map(r => (r.metadata && r.metadata.path) || '')
            .filter(Boolean)
            .slice(0, 10);
          recentRunContext = [
            '\n\nIMPORTANT CONTEXT — Most recent completed task:',
            `Objective: ${objective}`,
            files.length > 0 ? `Files created/updated: ${files.join(', ')}` : '',
            report ? `Summary: ${report}` : '',
          ].filter(Boolean).join('\n');
        }
      }
    } catch { /* non-fatal */ }

    const systemPrompt = mode === 'planning'
      ? [
        'You are Geepus, helping the user plan what to build or do next.',
        'Talk like a sharp coworker — casual, direct, no jargon.',
        'Keep it short. Use plain language. Skip formalities.',
        'Don\'t execute anything or pretend you did.',
        'Wrap up with a quick "ready to go" checklist if it makes sense.',
      ].join(' ')
      : [
        'You are Geepus, the user\'s digital assistant and autonomous coding agent.',
        'Talk like a smart friend — keep it casual, short, and clear.',
        'No technical jargon unless the user uses it first.',
        'Skip filler phrases like "Great question!" or "Certainly!".',
        '',
        'HOW TO THINK:',
        '- For factual questions: recall what you know, state key facts, give the answer.',
        '- For reasoning/math/logic: break the problem into steps. Show brief working if the answer is not obvious.',
        '- For "how do I" questions: give the most direct practical answer first, then context if needed.',
        '- For opinions/comparisons: state the trade-offs clearly, then give your recommendation.',
        '- If you are not sure about something, say what you do know and flag what you are uncertain about. Never make up facts.',
        '- If the question is ambiguous, answer the most likely interpretation and briefly note the other one.',
        '',
        'Keep answers concise (1-4 sentences for simple questions, longer for complex ones that need explanation).',
        'When the user asks about something you recently built, reference the specific files and explain how to use them.',
        'If they want you to do something new, tell them to switch to Action or Auto Mode — one sentence, no lecture.',
        'Never claim you did something you didn\'t.',
      ].join('\n') + recentRunContext;

    const sender = event.sender;

    const result = await callResponsesWithFallback({
      settings,
      model,
      input: [
        { role: 'system', content: systemPrompt },
        ...normalizedHistory,
        { role: 'user', content: prompt },
      ],
      temperature: 0.4,
      onChunk: (delta) => {
        try { sender.send('assistant:chunk', delta); } catch { /* window closed */ }
      },
    });

    return {
      provider: settings.provider,
      model: result.model,
      answer: stripThinkTags(extractOutputText(settings.provider, result.payload)),
    };
  });

  ipcMain.handle('audio:transcribe', async (_event, request) => {
    const settings = await readSettings();
    const { openaiKey, base } = resolveOpenAiVoiceConfig(settings);

    const dataBase64 = typeof request?.dataBase64 === 'string' ? request.dataBase64.trim() : '';
    if (!dataBase64) {
      throw new Error('No audio payload received.');
    }
    const mimeType = String(request?.mimeType || 'audio/webm').trim() || 'audio/webm';
    const filename = String(request?.filename || 'voice.webm').trim() || 'voice.webm';
    const audioBytes = Buffer.from(dataBase64, 'base64');
    if (!audioBytes || audioBytes.length === 0) {
      throw new Error('Audio payload was empty.');
    }

    const endpoint = `${base}/audio/transcriptions`;
    const requestedTranscriptionModel = String(request?.transcriptionModel || '').trim();
    const preferredModels = preferredTranscriptionModels(requestedTranscriptionModel);
    let modelsToTry = [...preferredModels];
    let discoveredModelIds = [];
    const modelErrors = [];

    // Discover accessible models for this exact key/project first.
    // This avoids misleading fallthrough errors from unavailable legacy models.
    try {
      const listResp = await fetch(`${base}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${openaiKey}`,
        },
      });
      if (listResp.ok) {
        const listPayload = await listResp.json().catch(() => ({}));
        const ids = Array.isArray(listPayload?.data)
          ? new Set(listPayload.data.map((item) => String(item?.id || '').trim()).filter(Boolean))
          : new Set();
        discoveredModelIds = Array.from(ids);
        const discovered = preferredModels.filter((id) => ids.has(id));
        if (discovered.length > 0) {
          modelsToTry = discovered;
        } else {
          const dynamic = Array.from(ids).filter((id) => /transcribe|whisper/i.test(id));
          if (dynamic.length > 0) {
            modelsToTry = dynamic;
          }
        }
      }
    } catch {
      // Ignore model discovery failures; fallback to preferred hardcoded list.
    }

    const parseChatAudioFormat = (type) => {
      const lower = String(type || '').toLowerCase();
      if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3';
      return 'wav';
    };

    const extractChatContentText = (payload) => {
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content === 'string') return content.trim();
      if (Array.isArray(content)) {
        return content
          .map((item) => {
            if (!item) return '';
            if (typeof item === 'string') return item;
            if (typeof item?.text === 'string') return item.text;
            if (item?.type === 'text' && typeof item?.text === 'string') return item.text;
            return '';
          })
          .join(' ')
          .trim();
      }
      return '';
    };

    const tryChatCompletionsAudioFallback = async (model) => {
      const audioFormat = parseChatAudioFormat(mimeType);
      const instruction = 'Transcribe this audio. Return only the transcript text. If no speech is present, return exactly [NO_SPEECH].';
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: instruction },
                { type: 'input_audio', input_audio: { data: dataBase64, format: audioFormat } },
              ],
            },
          ],
        }),
      });

      const raw = await response.text();
      let payload = {};
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        payload = {};
      }

      if (!response.ok) {
        const message = String(
          payload?.error?.message
          || payload?.message
          || raw
          || `${response.status} ${response.statusText}`,
        );
        throw new Error(message);
      }

      const text = String(extractChatContentText(payload) || '').trim();
      if (!text || text === '[NO_SPEECH]') {
        throw new Error('No transcribed speech was found in the recorded audio.');
      }
      return { ok: true, provider: 'openai', model, text };
    };

    // First try dedicated transcription endpoints/models.
    for (const model of modelsToTry) {
      try {
        const form = new FormData();
        form.append('model', model);
        form.append('temperature', '0');
        form.append('response_format', 'verbose_json');
        form.append('file', new Blob([audioBytes], { type: mimeType }), filename);

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${openaiKey}`,
          },
          body: form,
        });

        const raw = await response.text();
        let payload = {};
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch {
          payload = {};
        }

        if (!response.ok) {
          const message = String(
            payload?.error?.message
            || payload?.message
            || raw
            || `${response.status} ${response.statusText}`,
          );
          modelErrors.push({ model, status: response.status, message });
          const loweredMessage = message.toLowerCase();
          const modelUnavailable = response.status === 404
            || response.status === 400
            || response.status === 422
            || (response.status === 403 && (
              loweredMessage.includes('does not have access to model')
              || loweredMessage.includes('permission denied for model')
              || loweredMessage.includes('model not found')
            ));
          if (modelUnavailable) {
            continue;
          }
          throw new Error(message);
        }

        const segmentText = Array.isArray(payload?.segments)
          ? payload.segments
            .map((segment) => String(segment?.text || '').trim())
            .filter(Boolean)
            .join(' ')
          : '';
        const wordsText = Array.isArray(payload?.words)
          ? payload.words
            .map((word) => String(word?.word || word?.text || '').trim())
            .filter(Boolean)
            .join(' ')
          : '';
        const text = String(
          payload?.text
          || payload?.transcript
          || payload?.output_text
          || segmentText
          || wordsText
          || '',
        ).trim();
        if (!text) {
          throw new Error('No transcribed speech was found in the recorded audio.');
        }
        return { ok: true, provider: 'openai', model, text };
      } catch (error) {
        if (modelErrors.length === 0 || modelErrors[modelErrors.length - 1]?.model !== model) {
          modelErrors.push({ model, status: 0, message: String(error?.message || error || 'Unknown error') });
        }
      }
    }

    // Fallback: audio-capable chat-completions models.
    // OpenAI docs note audio input is not supported in Responses API; use chat/completions.
    const isAudioInputCapableModel = (id) => {
      const lower = String(id || '').toLowerCase();
      if (!lower) return false;
      if (lower.includes('tts')) return false;
      if (lower.startsWith('gpt-audio')) return true;
      return lower.includes('audio-preview')
        || lower.includes('-audio-')
        || lower.endsWith('-audio');
    };

    const discoveredAudioCandidates = discoveredModelIds.filter((id) => isAudioInputCapableModel(id));
    const chatModelCandidates = Array.from(new Set([
      requestedTranscriptionModel,
      ...discoveredAudioCandidates,
      String(request?.chatModel || '').trim(),
      String(settings.model || '').trim(),
      'gpt-audio',
      'gpt-audio-mini',
      'gpt-4o-audio-preview',
    ].filter((id) => isAudioInputCapableModel(id))));

    for (const model of chatModelCandidates) {
      try {
        return await tryChatCompletionsAudioFallback(model);
      } catch (error) {
        modelErrors.push({ model, status: 0, message: `chat-audio fallback failed: ${String(error?.message || error || 'Unknown error')}` });
      }
    }

    const summary = modelErrors
      .slice(0, 8)
      .map((entry) => `${entry.model}${entry.status ? ` (${entry.status})` : ''}: ${entry.message}`)
      .join(' | ');
    throw new Error(summary || 'Transcription failed.');
  });

  ipcMain.handle('agent:plan', async (_event, request) => {
    const baseSettings = await readSettings();
    const { provider, apiKey, baseUrl } = resolveProviderAndKey(baseSettings);
    const settings = {
      ...baseSettings,
      provider,
      apiKey,
      baseUrl,
      teamMode: request?.teamMode === 'solo' ? 'solo' : (baseSettings.teamMode === 'solo' ? 'solo' : 'teams'),
    };
    if (!apiKey && providerRequiresApiKey(provider)) {
      throw new Error('Add your API key first.');
    }

    const task = String(request?.task || '').trim();
    if (!task) {
      throw new Error('Please provide a task first.');
    }

    const resolvedModel = await resolveAgentModel(settings, request?.model, task);
    const model = resolvedModel.model;

    const workspaceRoot = resolveWorkspaceRoot(request?.workspaceRoot || settings.workspaceRoot);
    await writeSettings({ ...settings, model, workspaceRoot, provider: settings.provider, teamMode: settings.teamMode });

    return createAgentPlan({
      settings: {
        ...settings,
        model,
        workspaceRoot,
      },
      model,
      task,
      workspaceRoot,
      teamMode: settings.teamMode,
    });
  });

  ipcMain.handle('agent:execute', async (_event, request) => {
    const baseSettings = await readSettings();
    const { provider, apiKey, baseUrl } = resolveProviderAndKey(baseSettings);
    const settings = {
      ...baseSettings,
      provider,
      apiKey,
      baseUrl,
      teamMode: request?.teamMode === 'solo' ? 'solo' : (baseSettings.teamMode === 'solo' ? 'solo' : 'teams'),
    };
    if (!apiKey && providerRequiresApiKey(provider)) {
      throw new Error('Add your API key first.');
    }

    const task = String(request?.task || '').trim();
    if (!task) {
      throw new Error('Please provide a task first.');
    }

    const requestedModel = typeof request?.model === 'string' && request.model.trim().length > 0
      ? request.model.trim()
      : settings.model;
    const model = (await resolveAgentModel(settings, requestedModel, task)).model;
    const workspaceRoot = resolveWorkspaceRoot(request?.workspaceRoot || settings.workspaceRoot);
    const allowRisky = request?.allowRisky === true;
    const plan = ensureObject(request?.plan);
    const execution = await executePlannedActions({
      settings,
      model,
      task,
      workspaceRoot,
      planSummary: String(plan.summary || 'Agent plan'),
      actions: Array.isArray(plan.actions) ? plan.actions : [],
      allowRisky,
      maxActions: clampNumber(Number(request?.maxActions || 120), 1, 500, 120),
    });

    if (execution.requiresApproval) {
      return execution;
    }

    const finalState = execution.state;
    const report = await summarizeExecution({
      settings,
      model,
      task,
      workspaceRoot,
      plan: { summary: execution.summary },
      results: execution.results,
      finalState,
    });

    await appendAuditEvent({
      type: 'agent_execution_finished',
      model: report.model || model,
      workspace_root: workspaceRoot,
      state: finalState,
      total_actions: execution.results.length,
      succeeded_actions: execution.results.filter((entry) => entry.ok).length,
      task_summary: truncate(task, 400),
    });

    return {
      requiresApproval: false,
      state: finalState,
      provider: settings.provider,
      model: report.model || model,
      workspaceRoot,
      summary: execution.summary,
      results: execution.results,
      report: report.report,
    };
  });

  ipcMain.handle('agent:runObjective', async (_event, request) => {
    const baseSettings = await readSettings();
    const { provider, apiKey, baseUrl } = resolveProviderAndKey(baseSettings);
    const settings = { ...baseSettings, provider, apiKey, baseUrl };
    // Auto-start Ollama if needed for local model runs
    if (settings.provider === 'ollama') {
      const started = await ensureOllamaRunning();
      if (!started) {
        throw new Error('Ollama is not running and could not be started. Open the Ollama app or run `ollama serve`.');
      }
      // No pre-warm — Ollama is single-threaded, so a pre-warm request
      // competes with the real agent request and doubles load time.
      // The streaming path handles cold model loading gracefully with its
      // generous initial timeout.
    }
    try {
      const result = await runObjectiveCore(settings, request);
      await persistObjectiveLearningOutcome({ request, result, source: 'run' });
      return result;
    } catch (error) {
      await persistObjectiveLearningFailure({ request, error, source: 'run' });
      throw error;
    }
  });

  ipcMain.handle('agent:resumeObjective', async (_event, request) => {
    const baseSettings = await readSettings();
    const { provider, apiKey, baseUrl } = resolveProviderAndKey(baseSettings);
    const settings = { ...baseSettings, provider, apiKey, baseUrl };
    const resumedRequest = {
      ...request,
      resumeRunId: String(request?.runId || request?.resumeRunId || ''),
    };
    try {
      const result = await runObjectiveCore(settings, resumedRequest);
      await persistObjectiveLearningOutcome({ request: resumedRequest, result, source: 'resume' });
      return result;
    } catch (error) {
      await persistObjectiveLearningFailure({ request: resumedRequest, error, source: 'resume' });
      throw error;
    }
  });

  ipcMain.handle('agent:stopObjective', async (_event, request) => {
    const requestedRunId = String(request?.runId || '').trim();
    let runId = requestedRunId;

    if (!runId && activeRunIds.size > 0) {
      runId = Array.from(activeRunIds).slice(-1)[0] || '';
    }
    if (!runId) {
      const runs = await listRunStates(20);
      runId = (runs.find((run) => run.state === 'running' || run.state === 'paused_approval') || {}).runId || '';
    }
    if (!runId) {
      return {
        ok: false,
        runId: '',
        message: 'No running task found.',
      };
    }

    const reason = 'Stopped by user request.';
    requestRunStop(runId, reason);

    let runState = null;
    try {
      runState = await readRunState(runId);
      runState.state = 'stopped';
      runState.reason = reason;
      runState.updatedAt = new Date().toISOString();
      await persistRunState(runState);
    } catch {
      // If run file is unavailable, stop signal still applies to in-memory run.
    }

    await appendAuditEvent({
      type: 'objective_run_stop_requested',
      run_id: runId,
      reason,
    });
    await appendRunDebugEvent(runId, 'stop_requested', {
      reason,
      requestedRunId,
      resolvedRunId: runId,
      hadPersistedRunState: Boolean(runState && runState.runId),
      objective: String(runState?.objective || ''),
      stateBeforeStop: String(runState?.state || ''),
    }).catch(() => {});

    broadcastWatchEvent(runId, {
      type: 'run_stop_requested',
      owner: 'chief',
      summary: reason,
    }, {
      objective: runState?.objective || '',
      state: 'stopped',
      provider: runState?.provider || DEFAULT_PROVIDER,
      model: runState?.model || '',
      workspaceRoot: runState?.workspaceRoot || '',
      teamMode: runState?.teamMode || 'teams',
    });

    return {
      ok: true,
      runId,
      message: 'Stop requested. Geepus will halt this task shortly.',
    };
  });

  ipcMain.handle('agent:listRuns', async () => {
    const runs = await listRunStates(200);
    return runs.map((run) => ({
      ...summarizeRunForList(run),
      workflow: buildWorkflowView(run),
    }));
  });

  ipcMain.handle('agent:listArtifacts', async (_event, request) => {
    const limit = clampNumber(Number(request?.limit || 40), 1, 200, 40);
    const runs = await listRunStates(200);
    const output = [];
    const seen = new Set();

    for (const run of runs) {
      const paths = collectWrittenArtifactsFromRun(run);
      for (const artifactPath of paths) {
        if (!artifactPath || seen.has(artifactPath)) {
          continue;
        }
        seen.add(artifactPath);
        output.push({
          path: artifactPath,
          runId: String(run.runId || ''),
          objective: String(run.objective || ''),
          updatedAt: run.updatedAt || run.startedAt || run.createdAt || null,
          executionMode: normalizeExecutionMode(run.executionMode || 'action'),
        });
        if (output.length >= limit) {
          return output;
        }
      }
    }

    return output;
  });

  ipcMain.handle('watch:open', async (_event, request) => {
    const requestedRunId = String(request?.runId || '').trim();
    let runId = requestedRunId;

    if (!runId) {
      const runs = await listRunStates(1);
      runId = runs[0]?.runId || '';
    }

    if (runId && !watchStateByRun.has(runId)) {
      try {
        const runState = await readRunState(runId);
        hydrateWatchFromRunState(runState);
      } catch {
        // Ignore missing run state; window can still open and wait for events.
      }
    }

    createWatchWindow(runId);
    return { ok: true, runId };
  });

  ipcMain.handle('watch:snapshot', async (_event, request) => {
    const requestedRunId = String(request?.runId || '').trim();
    let runId = requestedRunId;
    if (!runId) {
      const runs = await listRunStates(1);
      runId = runs[0]?.runId || '';
    }
    if (!runId) {
      return {
        runId: '',
        objective: '',
        state: 'idle',
        provider: DEFAULT_PROVIDER,
        model: '',
        workspaceRoot: '',
        teamMode: 'teams',
        executionMode: 'action',
        agents: defaultWatchAgents('teams', 'action'),
        events: [],
      };
    }

    if (!watchStateByRun.has(runId)) {
      try {
        const runState = await readRunState(runId);
        hydrateWatchFromRunState(runState);
      } catch {
        // Ignore; fallback below.
      }
    }

    const snapshot = watchSnapshot(runId);
    if (snapshot) {
      return snapshot;
    }

    return {
      runId,
      objective: '',
      state: 'unknown',
      provider: DEFAULT_PROVIDER,
      model: '',
      workspaceRoot: '',
      teamMode: 'teams',
      executionMode: 'action',
      agents: defaultWatchAgents('teams', 'action'),
      events: [],
    };
  });

  // --- Scheduler IPC ---

  ipcMain.handle('scheduler:list', async () => {
    return listScheduledTasks();
  });

  ipcMain.handle('scheduler:add', async (_event, taskDef) => {
    return addScheduledTask(taskDef);
  });

  ipcMain.handle('scheduler:update', async (_event, taskId, patch) => {
    return updateScheduledTask(taskId, patch);
  });

  ipcMain.handle('scheduler:remove', async (_event, taskId) => {
    return removeScheduledTask(taskId);
  });

  ipcMain.handle('scheduler:runNow', async (_event, taskId) => {
    return runScheduledTaskNow(taskId);
  });

  // --- Trigger IPC ---

  ipcMain.handle('triggers:list', async () => {
    return listTriggers();
  });

  ipcMain.handle('triggers:add', async (_event, triggerDef) => {
    return await addTrigger(triggerDef);
  });

  ipcMain.handle('triggers:update', async (_event, triggerId, patch) => {
    return await updateTrigger(triggerId, patch);
  });

  ipcMain.handle('triggers:remove', async (_event, triggerId) => {
    return await removeTrigger(triggerId);
  });

  ipcMain.handle('app:restart', async () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('app:version', async () => {
    return {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron || '',
      chrome: process.versions.chrome || '',
      node: process.versions.node || '',
    };
  });

  ipcMain.handle('shell:openExternal', async (_event, url) => {
    const urlStr = String(url || '').trim();
    if (!urlStr) return;
    // Allow http(s) and file:// URLs
    if (/^(https?|file):\/\//i.test(urlStr)) {
      await shell.openExternal(urlStr);
    }
  });

  // --- Memory / RAG ---

  ipcMain.handle('memory:search', async (_event, query, options = {}) => {
    const settings = await readSettings();
    return retrieveContext(String(query || ''), settings, options);
  });

  ipcMain.handle('memory:stats', async () => {
    return getRAGStats();
  });

  ipcMain.handle('memory:index', async (_event, text, namespace, metadata = {}) => {
    const settings = await readSettings();
    return indexFreeText(String(text || ''), String(namespace || GLOBAL_NS), metadata, settings);
  });

  ipcMain.handle('memory:clear', async (_event, workspaceRoot) => {
    if (workspaceRoot) {
      await clearProjectVectors(workspaceRoot);
    }
    return { ok: true };
  });

  // --- Pipelines (workflow engine) ---

  ipcMain.handle('pipelines:list', async () => {
    return listPipelines();
  });

  ipcMain.handle('pipelines:get', async (_event, id) => {
    return getPipeline(id);
  });

  ipcMain.handle('pipelines:add', async (_event, data) => {
    return addPipeline(data);
  });

  ipcMain.handle('pipelines:update', async (_event, id, patch) => {
    return updatePipeline(id, patch);
  });

  ipcMain.handle('pipelines:remove', async (_event, id) => {
    return removePipeline(id);
  });

  ipcMain.handle('pipelines:run', async (_event, pipelineId) => {
    return executePipeline(pipelineId);
  });

  ipcMain.handle('pipelines:approve', async (_event, pipelineRunId) => {
    return approvePipelineStep(pipelineRunId);
  });

  ipcMain.handle('pipelines:reject', async (_event, pipelineRunId) => {
    return rejectPipelineStep(pipelineRunId);
  });

  ipcMain.handle('pipelines:cancel', async (_event, pipelineRunId) => {
    return cancelPipelineRun(pipelineRunId);
  });

  ipcMain.handle('pipelines:runs', async () => {
    return listPipelineRuns();
  });

  ipcMain.handle('pipelines:getRun', async (_event, runId) => {
    return readPipelineRun(runId);
  });

  // --- Web Research ---

  ipcMain.handle('web:search', async (_event, query, options = {}) => {
    return executeWebSearch({ query, count: options.count || 8 });
  });

  ipcMain.handle('web:scrape', async (_event, url, options = {}) => {
    return executeWebScrape({ url, max_length: options.max_length || 8000 });
  });

  // --- Cost Tracking ---

  ipcMain.handle('costs:today', async () => {
    return getTodayCost();
  });

  ipcMain.handle('costs:summary', async (_event, days = 30) => {
    return getCostSummary(days);
  });

  ipcMain.handle('costs:run', async (_event, runId) => {
    return getRunCostDetails(runId) || getRunUsage(runId);
  });

  // --- Project Manager ---

  ipcMain.handle('projects:list', async () => {
    return listProjects();
  });

  ipcMain.handle('projects:add', async (_event, workspaceRoot, label) => {
    return addProject(workspaceRoot, label);
  });

  ipcMain.handle('projects:remove', async (_event, workspaceRoot) => {
    return removeProject(workspaceRoot);
  });

  ipcMain.handle('projects:update', async (_event, workspaceRoot, patch) => {
    return updateProject(workspaceRoot, patch);
  });

  ipcMain.handle('projects:setActive', async (_event, workspaceRoot) => {
    return setActiveProject(workspaceRoot);
  });

  ipcMain.handle('projects:detail', async (_event, workspaceRoot) => {
    return getProjectDetail(workspaceRoot);
  });

  ipcMain.handle('browserControllers:list', async (_event, workspaceRoot) => {
    const root = resolveWorkspaceRoot(workspaceRoot || DEFAULT_WORKSPACE_ROOT);
    return {
      active: loadBrowserControllerSpecsSync(root),
      proposed: await listProposedBrowserControllerSpecs(root),
    };
  });

  ipcMain.handle('browserControllers:promote', async (_event, workspaceRoot, specId) => {
    const root = resolveWorkspaceRoot(workspaceRoot || DEFAULT_WORKSPACE_ROOT);
    const activePath = await promoteProposedBrowserControllerSpec(root, specId);
    return {
      ok: true,
      activePath,
      active: loadBrowserControllerSpecsSync(root),
      proposed: await listProposedBrowserControllerSpecs(root),
    };
  });

  // --- Integrations ---

  ipcMain.handle('integrations:github', async (_event, action, args) => {
    return executeIntegrationAction(String(action || ''), ensureObject(args));
  });

  ipcMain.handle('integrations:webhook', async (_event, message, webhookUrl) => {
    const settings = await readSettings();
    const url = webhookUrl || (ensureObject(settings.integrations).webhookUrl);
    return postStatusWebhook(url, String(message || ''));
  });

  ipcMain.handle('integrations:approvePush', async (_event, runId) => {
    approvePushForRun(String(runId || ''));
    return { ok: true, runId };
  });

  ipcMain.handle('integrations:revokePush', async (_event, runId) => {
    revokePushApproval(String(runId || ''));
    return { ok: true, runId };
  });

  ipcMain.handle('integrations:testWebhook', async (_event, webhookUrl) => {
    return postStatusWebhook(
      String(webhookUrl || ''),
      '🤖 Geepus webhook test — connection successful!'
    );
  });

  const loadLearningData = async () => {
    const settings = await readSettings();
    const userProfile = normalizeUserProfile(settings.userProfile || {});
    const memoryAutonomy = normalizeMemoryAutonomy(settings.memoryAutonomy || {});
    const globalMemory = await readGlobalMemory().catch(() => ({ userNotes: [] }));
    const sessionNotes = (memoryAutonomy?.memorySearch?.experimental?.sessionMemory
      && Array.isArray(memoryAutonomy?.memorySearch?.experimental?.sources)
      && memoryAutonomy.memorySearch.experimental.sources.includes('sessions'))
      ? await collectSessionMemoryNotes(12)
      : [];
    return {
      userProfile,
      memoryAutonomy,
      globalNotes: Array.isArray(globalMemory.userNotes) ? globalMemory.userNotes.slice(-80) : [],
      sessionNotes,
      memoryDirective: buildMemoryDirectivePreview(memoryAutonomy),
      updatedAt: new Date().toISOString(),
    };
  };

  ipcMain.handle('learning:getData', async () => {
    return loadLearningData();
  });

  ipcMain.handle('learning:saveData', async (_event, patch = {}) => {
    const current = await readSettings();
    let nextSettings = current;
    const patchObj = ensureObject(patch);

    if (patchObj && typeof patchObj.memoryAutonomy === 'object' && !Array.isArray(patchObj.memoryAutonomy)) {
      nextSettings = await writeSettings({
        ...nextSettings,
        memoryAutonomy: normalizeMemoryAutonomy({
          ...(nextSettings.memoryAutonomy || {}),
          ...patchObj.memoryAutonomy,
        }, nextSettings.memoryAutonomy || {}),
      });
    }

    if (patchObj && typeof patchObj.userProfile === 'object' && !Array.isArray(patchObj.userProfile)) {
      const profileWrite = await persistUserProfilePatch(nextSettings, patchObj.userProfile);
      nextSettings = profileWrite.settings;
    }

    if (Array.isArray(patchObj.globalNotes)) {
      const existing = await readGlobalMemory().catch(() => ({ userNotes: [] }));
      const notes = dedupeAndLimit(
        patchObj.globalNotes
          .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean),
        80,
      );
      await writeGlobalMemory({
        ...existing,
        userNotes: notes,
      });
    }

    return loadLearningData();
  });

  ipcMain.handle('learning:reset', async (_event, scope = 'skills') => {
    const normalizedScope = String(scope || '').trim().toLowerCase();
    const settings = await readSettings();
    if (normalizedScope === 'all') {
      const resetProfile = normalizeUserProfile({});
      await writeSettings({
        ...settings,
        userProfile: resetProfile,
      });
      const existing = await readGlobalMemory().catch(() => ({ userNotes: [], projects: [] }));
      await writeGlobalMemory({
        ...existing,
        userNotes: [],
      });
      return loadLearningData();
    }

    if (normalizedScope === 'strategies') {
      const currentProfile = normalizeUserProfile(settings.userProfile || {});
      const nextProfile = normalizeUserProfile({
        ...currentProfile,
        learnedStrategies: [],
      });
      await writeSettings({
        ...settings,
        userProfile: nextProfile,
      });
      return loadLearningData();
    }

    // Default: reset skill confidence/stats only.
    const currentProfile = normalizeUserProfile(settings.userProfile || {});
    const nextProfile = normalizeUserProfile({
      ...currentProfile,
      skillStats: [],
    });
    await writeSettings({
      ...settings,
      userProfile: nextProfile,
    });
    return loadLearningData();
  });

  // -----------------------------------------------------------------------
  // Knowledge Viewer — what Geepus knows
  // -----------------------------------------------------------------------

  ipcMain.handle('knowledge:getData', async () => {
    const settings = await readSettings();
    const workspaceRoot = settings.workspaceRoot || '';

    // Gather all knowledge sources
    const globalMemory = await readGlobalMemory();
    const projectMemory = workspaceRoot ? await readProjectMemory(workspaceRoot) : null;
    const ragStats = await getRAGStats();
    const recentRuns = await listRunStates(200);

    // Format for the UI
    const userNotes = (globalMemory.userNotes || []).slice(-20);
    const projects = (globalMemory.projects || []).map((p) => ({
      label: p.label || p.workspaceRoot,
      lastObjective: p.lastObjective || '',
      lastStatus: p.lastStatus || '',
      fileCount: (p.artifactPaths || []).length,
      updatedAt: p.updatedAt || null,
    }));

    const currentProject = projectMemory ? {
      notes: (projectMemory.notes || []).slice(-20),
      recentObjectives: (projectMemory.recentObjectives || []).slice(-10),
      knownFiles: (projectMemory.artifactPaths || []).slice(-30),
      updatedAt: projectMemory.updatedAt || null,
    } : null;
    const activeBrowserControllers = workspaceRoot
      ? loadBrowserControllerSpecsSync(workspaceRoot).map((spec) => ({
        id: spec.id,
        name: spec.name,
        match: spec.match || {},
        route: spec.route || {},
        sourcePath: spec.sourcePath || '',
      }))
      : [];
    const proposedBrowserControllers = workspaceRoot
      ? await listProposedBrowserControllerSpecs(workspaceRoot)
      : [];
    const proposedBrowserControllersWithMaturity = proposedBrowserControllers.map((spec) => ({
      ...spec,
      maturity: summarizeBrowserControllerRunMaturity(recentRuns, spec),
    }));

    return {
      userNotes,
      projects,
      currentProject,
      browserControllers: {
        active: activeBrowserControllers,
        proposed: proposedBrowserControllersWithMaturity,
      },
      activeWorkspace: workspaceRoot,
      vectorMemory: {
        totalVectors: ragStats.totalVectors || 0,
        namespaces: ragStats.namespaces || [],
      },
      lastUpdated: globalMemory.updatedAt || null,
    };
  });

  // -----------------------------------------------------------------------
  // Security Viewer — what Geepus can do
  // -----------------------------------------------------------------------

  ipcMain.handle('security:getData', async () => {
    const settings = await readSettings();
    const isLocal = (settings.provider || 'openai') === 'ollama';
    const defaults = isLocal ? LOCAL_RUN_LIMITS : DEFAULT_RUN_LIMITS;
    const limits = settings.runLimits || {};
    const profile = getSecurityProfile();
    const now = Date.now();
    const securityControls = normalizeSecurityControls(settings.securityControls || {});

    return {
      tools: profile.tools,
      blocked: profile.blocked,
      needsApproval: profile.needsApproval,
      allowedCategories: profile.allowedCategories,
      securityControls,
      now,
      isLocalModel: isLocal,
      runLimits: {
        maxRuntimeMinutes: limits.maxRuntimeMinutes || defaults.maxRuntimeMinutes,
        maxIterations: limits.maxIterations || defaults.maxIterations,
        maxActions: limits.maxActions || defaults.maxActions,
        modelCallsPerMinute: limits.maxModelCallsPerMinute || defaults.maxModelCallsPerMinute,
        toolCallsPerMinute: limits.maxToolCallsPerMinute || defaults.maxToolCallsPerMinute,
        idleTimeoutSeconds: limits.idleTimeoutSeconds || defaults.idleTimeoutSeconds,
      },
      provider: settings.provider || 'openai',
      model: settings.model || '',
    };
  });

  // -----------------------------------------------------------------------
  // Ollama — Local Model Management
  // -----------------------------------------------------------------------

  ipcMain.handle('ollama:status', async () => {
    try {
      return await ollamaStatus();
    } catch (err) {
      console.error('[Geepus] ollama:status error:', err);
      return { installed: false, running: false, catalog: [], localModels: [] };
    }
  });

  ipcMain.handle('ollama:start', async () => {
    const started = await ensureOllamaRunning();
    if (!started) {
      throw new Error(
        'Could not start Ollama. Please install it from https://ollama.com/download and try again.'
      );
    }
    return { ok: true };
  });

  ipcMain.handle('ollama:pull', async (event, modelId) => {
    // Ensure Ollama is running before pulling
    const running = await ensureOllamaRunning();
    if (!running) {
      throw new Error(
        'Ollama is not running. Please install it from https://ollama.com/download'
      );
    }

    const sender = event.sender;
    await pullModel(String(modelId || ''), (progress) => {
      try {
        sender.send('ollama:pullProgress', progress);
      } catch {
        // window may be closed
      }
    });

    return { ok: true, modelId };
  });

  ipcMain.handle('ollama:delete', async (_event, modelId) => {
    await deleteModel(String(modelId || ''));
    return { ok: true, modelId };
  });

  // -----------------------------------------------------------------------
  // File attachments — save dropped files to ~/.geepus/attachments/
  // -----------------------------------------------------------------------
  ipcMain.handle('fs:saveAttachment', async (_event, { filename, dataBase64 }) => {
    const safeFilename = pathMod.basename(String(filename || 'attachment')).replace(/[^a-zA-Z0-9._-]/g, '_');
    const uid = cryptoMod.randomUUID().slice(0, 8);
    const dir = pathMod.join(os.homedir(), '.geepus', 'attachments');
    fsSync.mkdirSync(dir, { recursive: true });
    const fullPath = pathMod.join(dir, `${uid}-${safeFilename}`);
    const buf = Buffer.from(String(dataBase64), 'base64');
    fsSync.writeFileSync(fullPath, buf);
    return { ok: true, path: fullPath };
  });
}

module.exports = { registerIpcHandlers };
