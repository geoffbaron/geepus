'use strict';

const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { dialog, Notification, BrowserWindow, shell } = require('electron');

const { ensureObject, clampNumber, truncate, extractFirstJSONObject, extractJSONObjects, sanitizeJsonString, isLikelyRefusal } = require('./utils');
const {
  detectObjectivePolicy,
  objectivePolicyPrompt,
  applyExecutionModePolicy,
  wordsForMatch,
  objectiveOverlapScore,
  allowedOwnersForPolicy,
  fallbackOwnerForPolicy,
  objectiveMentionsInfra,
  isOutOfScopeInfraAction,
  isDisallowedByObjectivePolicy,
  detectTeamMode,
  INFRA_KEYWORDS,
} = require('./objective-policy');
const {
  readSettings,
  writeSettings,
  normalizeExecutionMode,
  normalizeExecutionCore,
  normalizeRunLimits,
  DEFAULT_WORKSPACE_ROOT,
  DEFAULT_RUN_LIMITS,
  LOCAL_RUN_LIMITS,
} = require('./settings');
const { appendAuditEvent } = require('./audit');
const {
  PROVIDERS,
  DEFAULT_PROVIDER,
  callResponsesWithFallback,
  resolveAgentModel,
  extractOutputText,
  normalizeProvider,
  normalizeBaseUrl,
  defaultBaseUrlForProvider,
  pickBestModel,
  listModels,
  providerRequiresApiKey,
} = require('./providers');
const {
  TEAM_PROMPTS,
  teamPromptsForMode,
  normalizeOwner,
  inferOwnerFromAction,
  collectTeamBrief,
} = require('./team');
const {
  StopRequestedError,
  BudgetLimitError,
  enforcePerMinuteLimit,
  activeRunIds,
  registerRunChild,
  unregisterRunChild,
  persistRunState,
  readRunState,
  isRunStopRequested,
  getRunStopReason,
  requestRunStop,
  clearRunStopRequest,
  throwIfRunStopped,
  activeChildrenByRun,
  buildWorkflowView,
  appendRunDebugEvent,
} = require('./run-state');
const {
  broadcastWatchEvent,
  startWatchHeartbeat,
  focusMainWindow,
} = require('./watch-manager');
const {
  readProjectMemory,
  writeProjectMemory,
  toMemoryPrompt,
  readGlobalMemory,
  writeGlobalMemory,
  toGlobalMemoryPrompt,
  collectArtifactsFromResults,
  inferProjectLabel,
} = require('./memory');
const {
  resolveWorkspaceRoot,
  listWorkspaceFiles,
  isHomeWorkspace,
  chooseWorkspaceAndHints,
  loadProjectSkills,
  loadProjectAgents,
  toSkillPrompt,
  findBestSkillForObjective,
  saveGlobalSkill,
  collectKnownPathsForObjective,
} = require('./workspace');
const { executeWebSearch } = require('./web-research');
const {
  normalizeAction,
  normalizePlan,
  evaluateActionPolicy,
  executeAction,
} = require('./tools');
const {
  retrieveContext,
  toRAGPrompt,
  indexProjectMemory,
  indexRunSummary,
  indexGlobalMemory,
} = require('./rag');
const {
  inferRunTaskClass,
  buildReadinessChecklist,
  collectArtifactStats,
} = require('./readiness');
const {
  loadBrowserControllerSpecsSync,
  pickMatchingBrowserControllerSpec,
  saveProposedBrowserControllerSpec,
} = require('./browser-controller-registry');
const {
  extractUsageFromPayload,
  recordUsage,
  getRunUsage,
  restoreRunAccumulator,
  persistRunCost,
  finalizeRunCost,
} = require('./token-tracker');
const { ensureOllamaRunning } = require('./ollama-manager');
const { runNanobotNativeObjective } = require('./nanobot-runtime');

// ---------------------------------------------------------------------------
// Per-run caches to avoid redundant work across iterations
// ---------------------------------------------------------------------------
const _runCaches = new Map();

function getRunCache(runId) {
  if (!runId) return {};
  if (!_runCaches.has(runId)) {
    _runCaches.set(runId, {});
  }
  return _runCaches.get(runId);
}

function clearRunCache(runId) {
  _runCaches.delete(runId);
}

// ---------------------------------------------------------------------------
// isSmallLocalModel — detect tiny local models that need a shorter prompt
// ---------------------------------------------------------------------------

function isSmallLocalModel(model) {
  if (!model) return false;
  const m = String(model).toLowerCase();
  // Match patterns like llama3.2:3b, phi3:3.8b, gemma:2b, qwen:4b, etc.
  const sizeMatch = m.match(/:(\d+(?:\.\d+)?)b\b/);
  if (sizeMatch) {
    const params = parseFloat(sizeMatch[1]);
    if (params <= 7) return true; // Models under 7B are "small" for our purposes
  }
  // Named small models
  const smallNames = ['3b', '4b', '2b', '1b', '1.5b', '3.8b', 'phi3-mini', 'phi3.5-mini', 'qwen2.5-3b', 'gemma-2b', 'smollm'];
  return smallNames.some(n => m.includes(n));
}

function describeExecutionCore(executionCore = '') {
  const core = normalizeExecutionCore(executionCore || 'geepus');
  if (core === 'nanobot') {
    return 'Nanobot native runtime';
  }
  return 'Geepus classic loop';
}

function lessonTextForTaskClass(taskClass = '') {
  const task = String(taskClass || '').trim().toLowerCase();
  if (task === 'build') return ['build', 'test', 'qa', 'browser', 'console', 'artifact'];
  if (task === 'research') return ['research', 'report', 'source', 'evidence'];
  if (task === 'operations') return ['operations', 'email', 'browser', 'auth', 'workflow'];
  if (task === 'lookup' || task === 'general') return ['lookup', 'answer', 'response', 'evidence'];
  return [task];
}

function scoreLessonRelevance(text = '', taskClass = '') {
  const haystack = String(text || '').trim().toLowerCase();
  if (!haystack) return 0;
  const task = String(taskClass || '').trim().toLowerCase();
  let score = 0;
  if (haystack.includes('[autonomy]')) score += 1;
  if (task && haystack.includes(`[${task}]`)) score += 6;
  for (const token of lessonTextForTaskClass(task)) {
    if (token && haystack.includes(token)) score += 2;
  }
  if (task === 'build' && haystack.includes('verification')) score += 2;
  if (task === 'build' && haystack.includes('playwright')) score += 2;
  return score;
}

function selectRelevantLearnedStrategies(userProfile = {}, { objective = '', executionMode = 'action', objectivePolicy = null } = {}) {
  const profile = ensureObject(userProfile);
  const taskClass = inferRunTaskClass({ objective, executionMode, objectivePolicy });
  const strategies = Array.isArray(profile.learnedStrategies)
    ? profile.learnedStrategies.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  return strategies
    .map((item) => ({
      text: item,
      score: scoreLessonRelevance(item, taskClass),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map((item) => item.text);
}

function buildLearningNotebookPrompt(userProfile = {}, { objective = '', executionMode = 'action', objectivePolicy = null } = {}) {
  const profile = ensureObject(userProfile);
  const taskClass = inferRunTaskClass({ objective, executionMode, objectivePolicy });
  const skillStats = Array.isArray(profile.skillStats) ? profile.skillStats : [];
  const rankedStrategies = selectRelevantLearnedStrategies(profile, {
    objective,
    executionMode,
    objectivePolicy,
  });
  const rankedBannedApproaches = (Array.isArray(profile.bannedApproaches) ? profile.bannedApproaches : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      signature: String(item.signature || item.key || '').trim(),
      tool: String(item.tool || '').trim() || 'tool',
      count: Math.max(1, Number(item.count || 1)),
      error: String(item.error || '').trim(),
      domain: String(item.domain || 'general').trim() || 'general',
      relevance: scoreLessonRelevance(
        `${item.tool} ${item.error || ''} [${item.domain || 'general'}]`,
        taskClass,
      ) + (String(item.domain || '').includes(taskClass) ? 4 : 0),
    }))
    .filter((item) => item.signature)
    .sort((left, right) => {
      const relevanceDelta = right.relevance - left.relevance;
      if (relevanceDelta !== 0) return relevanceDelta;
      return right.count - left.count;
    })
    .slice(0, 6);
  const topSkills = skillStats
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      name: String(item.name || '').trim(),
      domain: String(item.domain || 'general').trim() || 'general',
      attempts: Math.max(0, Number(item.attempts || 0)),
      successes: Math.max(0, Number(item.successes || 0)),
      failures: Math.max(0, Number(item.failures || 0)),
      notes: Array.isArray(item.notes) ? item.notes.map((note) => String(note || '').trim()).filter(Boolean) : [],
      relevance: scoreLessonRelevance(
        [
          String(item.name || ''),
          String(item.domain || ''),
          ...(Array.isArray(item.notes) ? item.notes : []),
        ].join(' '),
        taskClass,
      ),
    }))
    .filter((item) => item.name)
    .sort((left, right) => {
      const relevanceDelta = right.relevance - left.relevance;
      if (relevanceDelta !== 0) return relevanceDelta;
      const successDelta = right.successes - left.successes;
      if (successDelta !== 0) return successDelta;
      return right.attempts - left.attempts;
    })
    .slice(0, 8);

  if (rankedStrategies.length === 0 && topSkills.length === 0 && rankedBannedApproaches.length === 0) {
    return '';
  }

  const lines = ['=== LEARNED EXECUTION NOTEBOOK ===', `Task class focus: ${taskClass || 'general'}`];
  if (rankedStrategies.length > 0) {
    lines.push('Most relevant learned strategies:');
    lines.push(...rankedStrategies.map((item) => `- ${item}`));
  }
  if (topSkills.length > 0) {
    lines.push('Observed skill performance:');
    lines.push(...topSkills.map((item) => {
      const latestNote = item.notes.length > 0 ? ` | note: ${truncate(item.notes[item.notes.length - 1], 120)}` : '';
      return `- ${item.name} [${item.domain}] success ${item.successes}/${item.attempts}, failures ${item.failures}${latestNote}`;
    }));
  }
  if (rankedBannedApproaches.length > 0) {
    lines.push('Cross-run banned approaches:');
    lines.push(...rankedBannedApproaches.map((item) =>
      `- Avoid ${item.tool} [${truncate(item.signature, 80)}] failed ${item.count}x: ${truncate(item.error || 'Repeatedly failed approach.', 120)}`
    ));
  }
  lines.push('Use this notebook to bias planning toward approaches that have already worked.');
  lines.push('=== END LEARNED EXECUTION NOTEBOOK ===');
  return lines.join('\n');
}

function summarizeRecentFailuresForRepair(results = [], maxItems = 4) {
  const failures = (Array.isArray(results) ? results : [])
    .filter((entry) => entry && entry.ok === false)
    .slice(-maxItems);
  if (failures.length === 0) {
    return [];
  }
  return failures.map((entry) => {
    const tool = String(entry.tool || 'step').trim() || 'step';
    const intent = truncate(String(entry.intent || '').trim() || 'No intent recorded.', 140);
    const output = truncate(String(entry.output || '').replace(/\s+/g, ' ').trim(), 180);
    return output
      ? `- ${tool}: ${intent} | Failure: ${output}`
      : `- ${tool}: ${intent}`;
  });
}

function suggestedRepairStrategy(checkId = '', detail = '') {
  const id = String(checkId || '').trim().toLowerCase();
  const text = String(detail || '').trim().toLowerCase();
  if (id === 'verification' || id === 'browser_console_clean') {
    return {
      toolHint: 'run_command or run_playwright',
      verificationHint: 'Prove the fix with a real test run or browser QA pass before stopping.',
    };
  }
  if (id === 'artifacts_exist' || id === 'artifacts_non_empty') {
    return {
      toolHint: 'write_file, patch_file, or run_command',
      verificationHint: 'Confirm the expected files exist on disk and are non-empty.',
    };
  }
  if (id === 'failure_ratio') {
    return {
      toolHint: 'read_file, run_command, or targeted edit',
      verificationHint: 'Eliminate repeated failures and avoid retrying the same broken action sequence.',
    };
  }
  if (id === 'meaningful_progress' || id === 'task_executed' || id === 'ops_action') {
    return {
      toolHint: 'Use the concrete execution tool for the task, not only read/search tools.',
      verificationHint: 'Reach a changed state that proves the requested action actually happened.',
    };
  }
  if (id === 'research_evidence' || id === 'deliverable') {
    return {
      toolHint: 'web_search, web_scrape, read_file, write_file',
      verificationHint: 'Gather source-backed evidence and produce the requested report artifact.',
    };
  }
  if (text.includes('console error')) {
    return {
      toolHint: 'run_playwright plus targeted file edits',
      verificationHint: 'Re-run browser QA until console errors are zero.',
    };
  }
  return {
    toolHint: 'Use the minimal tool sequence needed to fix the issue directly.',
    verificationHint: 'Produce concrete evidence that this specific issue is resolved.',
  };
}

function buildNativeRepairPlan({
  gateType = 'readiness',
  readiness = null,
  acceptance = null,
  results = [],
}) {
  const items = [];
  if (gateType === 'readiness' && readiness && Array.isArray(readiness.checks)) {
    readiness.checks
      .filter((check) => check && check.required && !check.passed)
      .slice(0, 6)
      .forEach((check, index) => {
        const strategy = suggestedRepairStrategy(check.id, check.detail);
        items.push({
          priority: index + 1,
          title: String(check.label || check.id || `Readiness check ${index + 1}`),
          why: String(check.detail || '').trim(),
          toolHint: strategy.toolHint,
          verificationHint: strategy.verificationHint,
        });
      });
  }
  if (gateType === 'acceptance' && acceptance) {
    const issues = Array.isArray(acceptance.issues) && acceptance.issues.length > 0
      ? acceptance.issues
      : ['General quality below user expectations.'];
    issues.slice(0, 8).forEach((issue, index) => {
      const strategy = suggestedRepairStrategy(`acceptance_${index + 1}`, issue);
      items.push({
        priority: index + 1,
        title: `Acceptance issue ${index + 1}`,
        why: String(issue || '').trim(),
        toolHint: strategy.toolHint,
        verificationHint: strategy.verificationHint,
      });
    });
  }
  const recentFailures = summarizeRecentFailuresForRepair(results, 4);
  if (recentFailures.length > 0) {
    items.push({
      priority: items.length + 1,
      title: 'Avoid repeated failed actions',
      why: recentFailures.join(' | '),
      toolHint: 'Change tactics instead of replaying the same failing action.',
      verificationHint: 'Demonstrate the replacement approach succeeds where the previous one failed.',
    });
  }
  return items.slice(0, 8);
}

function buildNativeRepairBrief({
  passNumber = 1,
  objective = '',
  gateType = 'readiness',
  readiness = null,
  acceptance = null,
  results = [],
}) {
  const repairPlan = buildNativeRepairPlan({
    gateType,
    readiness,
    acceptance,
    results,
  });
  const recentFailures = summarizeRecentFailuresForRepair(results, 4);
  const lines = [
    `Checkpoint repair contract for native pass ${passNumber}.`,
    `Objective: ${objective}`,
    `Gate failed: ${gateType}`,
    '',
    'Priority repair plan:',
  ];

  if (gateType === 'readiness' && readiness) {
    lines.push(`- Readiness summary: ${readiness.summary}`);
  }
  if (gateType === 'acceptance' && acceptance) {
    lines.push(`- Acceptance score: ${acceptance.score}/10`);
    lines.push(`- Acceptance verdict: ${acceptance.verdict}`);
  }
  repairPlan.forEach((item) => {
    lines.push(`${item.priority}. ${item.title}`);
    lines.push(`   Why: ${item.why}`);
    lines.push(`   Suggested tools: ${item.toolHint}`);
    lines.push(`   Exit proof: ${item.verificationHint}`);
  });
  if (recentFailures.length > 0) {
    lines.push('');
    lines.push('Recent failed actions to avoid repeating blindly:');
    lines.push(...recentFailures);
  }
  lines.push('');
  lines.push('Exit criteria before claiming completion again:');
  if (gateType === 'readiness') {
    lines.push('- Satisfy every failed readiness check above with real evidence.');
  } else {
    lines.push('- Fix every acceptance issue above and improve user-facing quality.');
  }
  lines.push('- Do not stop after code changes alone; run verification that proves the fix.');
  lines.push('- If a prior approach failed, use a different tactic instead of retrying the same broken step.');
  return lines.join('\n');
}

function mergeSkillStatEntry(skillStats = [], nextEntry = {}) {
  const entries = Array.isArray(skillStats) ? skillStats : [];
  const name = String(nextEntry.name || '').trim();
  if (!name) {
    return entries;
  }
  const domain = String(nextEntry.domain || 'general').trim() || 'general';
  const note = String(nextEntry.note || '').trim();
  const index = entries.findIndex((entry) => String(entry?.name || '').trim() === name);
  const current = index >= 0 ? ensureObject(entries[index]) : {};
  const merged = {
    name,
    domain,
    attempts: Math.max(0, Number(current.attempts || 0)) + Math.max(0, Number(nextEntry.attempts || 0)),
    successes: Math.max(0, Number(current.successes || 0)) + Math.max(0, Number(nextEntry.successes || 0)),
    failures: Math.max(0, Number(current.failures || 0)) + Math.max(0, Number(nextEntry.failures || 0)),
    lastOutcome: String(nextEntry.lastOutcome || current.lastOutcome || 'unknown').trim() || 'unknown',
    notes: Array.from(new Set([
      ...(Array.isArray(current.notes) ? current.notes : []),
      ...(note ? [note] : []),
    ].map((item) => String(item || '').trim()).filter(Boolean))).slice(-8),
    updatedAt: new Date().toISOString(),
  };
  if (index >= 0) {
    const copy = entries.slice();
    copy[index] = merged;
    return copy;
  }
  return [...entries, merged].slice(-80);
}

async function persistNativeLearningOutcome({ settings, runState, objective, doneReason = '' }) {
  const nativeState = runState?.nativeRuntimeState && typeof runState.nativeRuntimeState === 'object'
    ? runState.nativeRuntimeState
    : null;
  if (!nativeState || String(nativeState.executionCore || '') !== 'nanobot') {
    return;
  }

  const currentProfile = ensureObject(settings.userProfile || {});
  const learnedStrategies = Array.isArray(currentProfile.learnedStrategies)
    ? currentProfile.learnedStrategies.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  let skillStats = Array.isArray(currentProfile.skillStats) ? currentProfile.skillStats : [];
  const nextStrategies = [];
  const gate = nativeState.checkpointGate && typeof nativeState.checkpointGate === 'object'
    ? nativeState.checkpointGate
    : null;
  const repairBriefs = Array.isArray(nativeState.repairBriefs)
    ? nativeState.repairBriefs.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const readiness = runState?.readiness && typeof runState.readiness === 'object' ? runState.readiness : null;
  const taskClass = String(readiness?.taskClass || inferRunTaskClass({ objective, executionMode: runState?.executionMode || 'action' }) || 'general').trim().toLowerCase();
  const requiredFailedChecks = Array.isArray(readiness?.checks)
    ? readiness.checks.filter((check) => check && check.required && !check.passed)
    : [];
  const completed = runState?.state === 'completed';
  const taskPrefix = `[${taskClass}] [autonomy]`;

  if (gate?.status === 'approved') {
    nextStrategies.push(`${taskPrefix} For native runs, stop only after readiness passes and the checkpoint gate records approval.`);
    if (repairBriefs.length > 0) {
      nextStrategies.push(`${taskPrefix} When native checkpoint review fails, convert it into a prioritized repair contract with exit proof before retrying.`);
    }
  }
  if (gate?.status === 'repair_exhausted' || nativeState.status === 'fallback') {
    nextStrategies.push(`${taskPrefix} If native repair passes are exhausted, change execution strategy early instead of repeating the same failing QA loop.`);
  }
  if (requiredFailedChecks.some((check) => String(check.id || '') === 'verification')) {
    nextStrategies.push(`${taskPrefix} Never claim build completion without real verification evidence from tests or browser QA.`);
  }
  if (requiredFailedChecks.some((check) => String(check.id || '') === 'browser_console_clean')) {
    nextStrategies.push(`${taskPrefix} For web tasks, require a clean browser QA pass with zero console errors before completion.`);
  }

  const statusNote = gate?.summary
    || truncate(String(doneReason || runState?.reason || '').trim(), 180)
    || 'Native run completed.';
  skillStats = mergeSkillStatEntry(skillStats, {
    name: 'native_checkpoint_qa',
    domain: `${taskClass}:autonomy`,
    attempts: 1,
    successes: completed && gate?.status === 'approved' ? 1 : 0,
    failures: completed && gate?.status === 'approved' ? 0 : 1,
    lastOutcome: completed && gate?.status === 'approved' ? 'success' : 'failure',
    note: statusNote,
  });
  if (repairBriefs.length > 0) {
    skillStats = mergeSkillStatEntry(skillStats, {
      name: 'native_repair_loop',
      domain: `${taskClass}:autonomy`,
      attempts: 1,
      successes: completed ? 1 : 0,
      failures: completed ? 0 : 1,
      lastOutcome: completed ? 'success' : 'failure',
      note: truncate(repairBriefs[repairBriefs.length - 1] || statusNote, 180),
    });
  }

  const nextProfile = {
    ...currentProfile,
    learnedStrategies: Array.from(new Set([
      ...learnedStrategies,
      ...nextStrategies,
    ])).slice(-40),
    skillStats,
    updatedAt: new Date().toISOString(),
  };
  if (JSON.stringify(nextProfile) === JSON.stringify(currentProfile)) {
    return;
  }
  await writeSettings({
    ...settings,
    userProfile: nextProfile,
  });
}

async function persistCrossRunBannedApproaches({ settings, runState, objective = '', objectivePolicy = null }) {
  const currentProfile = ensureObject(settings.userProfile || {});
  const currentStored = Array.isArray(currentProfile.bannedApproaches) ? currentProfile.bannedApproaches : [];
  const taskClass = inferRunTaskClass({
    objective,
    executionMode: runState?.executionMode || 'action',
    objectivePolicy,
  });
  const currentRunBans = computeBannedApproaches(runState?.iterations || []).map((entry) => ({
    ...entry,
    domain: taskClass,
    updatedAt: new Date().toISOString(),
  }));
  if (currentRunBans.length === 0) {
    return;
  }
  const merged = mergeBannedApproachLists(currentStored, currentRunBans)
    .map((entry) => ({
      signature: String(entry.signature || entry.key || '').trim(),
      key: String(entry.signature || entry.key || '').trim(),
      tool: String(entry.tool || '').trim() || 'tool',
      count: Math.max(1, Number(entry.count || 1)),
      error: String(entry.error || '').trim().slice(0, 300),
      domain: String(entry.domain || 'general').trim() || 'general',
      updatedAt: String(entry.updatedAt || '').trim() || new Date().toISOString(),
    }))
    .slice(0, 120);
  const nextProfile = {
    ...currentProfile,
    bannedApproaches: merged,
    updatedAt: new Date().toISOString(),
  };
  if (JSON.stringify(nextProfile) === JSON.stringify(currentProfile)) {
    return;
  }
  await writeSettings({
    ...settings,
    userProfile: nextProfile,
  });
}

async function persistGeneralLearningOutcome({ settings, runState, objective = '', objectivePolicy = null, doneReason = '' }) {
  const currentProfile = ensureObject(settings.userProfile || {});
  const learnedStrategies = Array.isArray(currentProfile.learnedStrategies)
    ? currentProfile.learnedStrategies.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  let skillStats = Array.isArray(currentProfile.skillStats) ? currentProfile.skillStats : [];
  const taskClass = inferRunTaskClass({
    objective,
    executionMode: runState?.executionMode || 'action',
    objectivePolicy,
  });
  const safeguardLoops = countConsecutiveSafeguardIterations(runState?.iterations || []);
  const noProgressLoops = countConsecutiveNoProgressIterations(runState?.iterations || [], taskClass);
  const hasRealProgress = iterationHasRealProgress(runState?.results || [], taskClass);
  const completed = runState?.state === 'completed';
  const taskPrefix = `[${taskClass}] [autonomy]`;
  const nextStrategies = [];

  if (completed && hasRealProgress) {
    nextStrategies.push(`${taskPrefix} Reuse the last successful path first, but only after confirming the next action still directly advances the objective.`);
  }
  if (safeguardLoops >= 2) {
    nextStrategies.push(`${taskPrefix} If actions are rejected by safeguard filters twice in a row, reset to the exact objective and choose one narrower allowed action instead of retrying variants.`);
  }
  if (noProgressLoops >= 3) {
    nextStrategies.push(`${taskPrefix} If three iterations pass without real-world progress, stop the loop, re-anchor on the objective, and change strategy immediately.`);
  }
  if (!completed && !hasRealProgress) {
    nextStrategies.push(`${taskPrefix} Never claim progress from think/read/list steps alone. Count progress only when a tool changes the world or returns directly relevant external evidence.`);
  }

  const outcomeNote = truncate(String(doneReason || runState?.reason || 'Run completed.').trim(), 180);
  skillStats = mergeSkillStatEntry(skillStats, {
    name: 'objective_lock',
    domain: `${taskClass}:autonomy`,
    attempts: 1,
    successes: completed && hasRealProgress ? 1 : 0,
    failures: completed && hasRealProgress ? 0 : 1,
    lastOutcome: completed && hasRealProgress ? 'success' : 'failure',
    note: outcomeNote,
  });
  if (safeguardLoops >= 2) {
    skillStats = mergeSkillStatEntry(skillStats, {
      name: 'safeguard_loop_breaker',
      domain: `${taskClass}:autonomy`,
      attempts: 1,
      successes: completed ? 1 : 0,
      failures: completed ? 0 : 1,
      lastOutcome: completed ? 'success' : 'failure',
      note: `Recent safeguard-only streak: ${safeguardLoops}. ${outcomeNote}`,
    });
  }
  if (noProgressLoops >= 3 || !hasRealProgress) {
    skillStats = mergeSkillStatEntry(skillStats, {
      name: 'progress_governor',
      domain: `${taskClass}:autonomy`,
      attempts: 1,
      successes: completed && hasRealProgress ? 1 : 0,
      failures: completed && hasRealProgress ? 0 : 1,
      lastOutcome: completed && hasRealProgress ? 'success' : 'failure',
      note: `Recent no-progress streak: ${Math.max(noProgressLoops, hasRealProgress ? 0 : 1)}. ${outcomeNote}`,
    });
  }

  const nextProfile = {
    ...currentProfile,
    learnedStrategies: Array.from(new Set([
      ...learnedStrategies,
      ...nextStrategies,
    ])).slice(-60),
    skillStats,
    updatedAt: new Date().toISOString(),
  };
  if (JSON.stringify(nextProfile) === JSON.stringify(currentProfile)) {
    return;
  }
  await writeSettings({
    ...settings,
    userProfile: nextProfile,
  });
}

function normalizeNativeRuntimeToolName(name = '') {
  const tool = String(name || '').trim().toLowerCase();
  if (tool === 'exec') return 'run_command';
  if (tool === 'edit_file') return 'patch_file';
  if (tool === 'list_dir') return 'list_files';
  if (tool === 'web_fetch') return 'web_scrape';
  if (tool === 'spawn') return 'delegate';
  return tool || 'tool';
}

function parseNativeRuntimeArguments(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildNativeRuntimeResultEntry({ toolName = '', argumentsText = '', output = '', ok = true } = {}) {
  const normalizedTool = normalizeNativeRuntimeToolName(toolName);
  const parsedArgs = parseNativeRuntimeArguments(argumentsText);
  const metadata = {
    executionCore: 'nanobot',
    nativeRuntime: true,
  };
  if (normalizedTool === 'run_command') {
    const command = String(parsedArgs.command || '').trim();
    const workingDir = String(parsedArgs.working_dir || parsedArgs.cwd || '').trim();
    if (command) metadata.command = command;
    if (Array.isArray(parsedArgs.args)) metadata.args = parsedArgs.args.map((item) => String(item || ''));
    if (workingDir) metadata.cwd = workingDir;
  } else if (normalizedTool === 'patch_file') {
    const targetPath = String(parsedArgs.path || '').trim();
    if (targetPath) metadata.path = targetPath;
  } else if (normalizedTool === 'write_file' || normalizedTool === 'read_file' || normalizedTool === 'list_files') {
    const targetPath = String(parsedArgs.path || '').trim();
    if (targetPath) metadata.path = targetPath;
  } else if (normalizedTool === 'web_search') {
    const query = String(parsedArgs.query || '').trim();
    if (query) metadata.query = query;
  } else if (normalizedTool === 'web_scrape') {
    const url = String(parsedArgs.url || '').trim();
    if (url) metadata.url = url;
  }
  return {
    tool: normalizedTool,
    intent: argumentsText
      ? `${normalizedTool} ${truncate(argumentsText, 180)}`.trim()
      : `Native runtime executed ${normalizedTool}`,
    ok: ok !== false,
    output: truncate(String(output || '').trim(), 6000),
    metadata,
  };
}

function nativeRuntimeMessagesToResults(messages = [], toolsUsed = []) {
  const entries = Array.isArray(messages) ? messages : [];
  const results = [];
  const assistantToolCalls = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.role === 'assistant' && Array.isArray(entry.tool_calls)) {
      for (const toolCall of entry.tool_calls) {
        if (!toolCall || typeof toolCall !== 'object') continue;
        assistantToolCalls.push({
          id: String(toolCall.id || '').trim(),
          name: normalizeNativeRuntimeToolName(toolCall.name),
          arguments: String(toolCall.arguments || '').trim(),
        });
      }
      continue;
    }
    if (entry.role !== 'tool') continue;
    const toolName = normalizeNativeRuntimeToolName(entry.name);
    const output = String(entry.content || '').trim();
    const linkedCall = assistantToolCalls.find((toolCall) => toolCall.id && toolCall.id === String(entry.tool_call_id || '').trim());
    const looksFailed = /^error[:\s]/i.test(output) || /\b(traceback|exception|failed)\b/i.test(output);
    results.push(buildNativeRuntimeResultEntry({
      toolName,
      argumentsText: linkedCall?.arguments || '',
      output,
      ok: !looksFailed,
    }));
  }

  if (results.length === 0 && Array.isArray(toolsUsed) && toolsUsed.length > 0) {
    return toolsUsed.slice(0, 20).map((toolName) => ({
      ...buildNativeRuntimeResultEntry({
        toolName,
        argumentsText: '',
        output: '',
        ok: true,
      }),
    }));
  }

  return results;
}

// ---------------------------------------------------------------------------
// buildCompactPlannerPrompt — stripped-down prompt for small (<8B) local models
// ---------------------------------------------------------------------------

function buildCompactPlannerPrompt({ task, rootObjective, workspaceFiles = [], webIdentity = {}, userProfile = {}, executionCore = 'geepus', bannedApproaches = [] }) {
  const objective = rootObjective || task;
  const hasIdentity = !!(webIdentity.email);
  const taskClass = inferRunTaskClass({ objective, executionMode: 'action' });
  const learningNotebook = buildLearningNotebookPrompt(userProfile, {
    objective,
    executionMode: 'action',
  });
  const bannedAlternatives = buildBannedApproachAlternativesGuidance(bannedApproaches, {
    objective,
    taskClass,
  });
  const bootstrapGuidance = buildBootstrapGuidance(workspaceFiles, objective);
  const verificationMode = String(webIdentity.emailVerificationMode || 'webmail').trim().toLowerCase() === 'resend'
    ? 'resend'
    : 'webmail';
  const resendInboxApiUrl = String(webIdentity.resendInboxApiUrl || '').trim();
  const identityBlock = hasIdentity
    ? [
      '=== YOUR IDENTITY (USE THESE EXACTLY — DO NOT INVENT DIFFERENT CREDENTIALS) ===',
      `Email: ${webIdentity.email}`,
      `Password: ${webIdentity.emailPassword || '(not set)'}`,
      `Display name: ${webIdentity.displayName || webIdentity.usernamePreference || 'GeepusAgent'}`,
      `Phone number: ${webIdentity.phoneNumber || '(not set)'}`,
      `Birth date: ${webIdentity.birthDate || '(not set)'}`,
      `Email verification mode: ${verificationMode}`,
      verificationMode === 'resend' && resendInboxApiUrl ? `Resend inbox endpoint: ${resendInboxApiUrl}` : '',
      '=== END IDENTITY ===',
      '',
    ].join('\n')
    : '';

  const identityRule = hasIdentity
    ? `- Your email is ${webIdentity.email}. NEVER use any other email address. NEVER make one up.`
    : '';

  return [
    identityBlock,
    `You are an autonomous AI agent using the ${describeExecutionCore(executionCore)}. Output a JSON plan ONLY. No explanations.`,
    learningNotebook,
    bannedAlternatives,
    bootstrapGuidance,
    '',
    'SCHEMA: {"summary":"string","done":false,"actions":[{"intent":"string","tool":"TOOL_NAME","exact_args":{...},"risk_level":"low"}]}',
    '',
    'TOOLS (use EXACT names as listed):',
    'web_search     {"query":"...","count":5}',
    'web_scrape     {"url":"https://...","max_length":5000}',
    'http_request   {"url":"...","method":"GET","headers":{}}',
    'browser_launch {"url":"https://..."}',
    'browser_action {"action":"goto|click|type|fill|press|read|aria_snapshot","target":{"role":"...","text":"..."},"text":"...","key":"..."}',
    'browser_close  {}',
    'read_file      {"path":"relative/path"}',
    'write_file     {"path":"relative/path","content":"..."}',
    'search_files   {"pattern":"text","path":"."}',
    'run_command    {"command":"npm|node|python3|curl|git|...","args":["..."],"cwd":"."}',
    'think          {"thought":"reasoning..."}',
    '',
    'RULES:',
    '- For information tasks (search, find, look up): use web_search or http_request FIRST.',
    '- For web browsing tasks: ALWAYS use web_search FIRST to find the exact signup/registration URL. NEVER guess or invent a URL. Then browser_launch the real URL you found.',
    '- For account creation tasks: web_search "[site name] sign up" or "[site name] create account", then use the FIRST result URL to browser_launch.',
    '- NEVER navigate to /support/ or /help/ pages. Only navigate to actual registration or signup pages.',
    verificationMode === 'resend' && resendInboxApiUrl
      ? '- In resend mode, verify accounts by polling the Resend inbox endpoint via http_request and opening extracted verification URLs. Do not open webmail UI unless endpoint polling fails repeatedly.'
      : '',
    '- For coding tasks: use write_file to create files, run_command to run them.',
    '- When done, set "done":true and summarize what you found/did.',
    '- NEVER use tool names not listed above.',
    identityRule,
    '',
    `OBJECTIVE: ${objective}`,
  ].filter(line => line !== undefined).join('\n');
}

// ---------------------------------------------------------------------------
// createUpfrontPlan — one LLM call that returns ALL steps for the objective
// ---------------------------------------------------------------------------
//
// Instead of calling the LLM once per iteration (which grows history until
// context overflow), this asks the model to produce a complete ordered plan
// upfront. The execution loop then pops steps one-by-one without replanning.
//
// Used automatically for small local models and any multi-step web task.

async function createUpfrontPlan({
  settings,
  model,
  objective,
  workspaceFiles = [],
  webIdentity = {},
  userProfile = {},
  executionCore = 'geepus',
  bannedApproaches = [],
  callGuards = null,
}) {
  const { normalizeAction } = require('./tools');
  const hasIdentity = !!(webIdentity.email);
  const taskClass = inferRunTaskClass({ objective, executionMode: 'action' });
  const verificationMode = String(webIdentity.emailVerificationMode || 'webmail').trim().toLowerCase() === 'resend'
    ? 'resend'
    : 'webmail';
  const resendInboxApiUrl = String(webIdentity.resendInboxApiUrl || '').trim();
  const identityBlock = hasIdentity
    ? [
      '=== YOUR IDENTITY (USE THESE EXACTLY) ===',
      `Email: ${webIdentity.email}`,
      `Password: ${webIdentity.emailPassword || '(not set)'}`,
      `Display name: ${webIdentity.displayName || webIdentity.usernamePreference || 'GeepusAgent'}`,
      `Phone number: ${webIdentity.phoneNumber || '(not set)'}`,
      `Birth date: ${webIdentity.birthDate || '(not set)'}`,
      `Email verification mode: ${verificationMode}`,
      verificationMode === 'resend' && resendInboxApiUrl ? `Resend inbox endpoint: ${resendInboxApiUrl}` : '',
      '=== END IDENTITY ===',
      '',
    ].join('\n')
    : '';

  const learningNotebook = buildLearningNotebookPrompt(userProfile, {
    objective,
    executionMode: 'action',
  });
  const bannedAlternatives = buildBannedApproachAlternativesGuidance(bannedApproaches, {
    objective,
    taskClass,
  });
  const bootstrapGuidance = buildBootstrapGuidance(workspaceFiles, objective);
  const systemPrompt = [
    identityBlock,
    `You are an autonomous AI agent task planner using the ${describeExecutionCore(executionCore)}.`,
    learningNotebook,
    bannedAlternatives,
    bootstrapGuidance,
    'Your job is to produce a complete, ordered step-by-step plan for the objective.',
    '',
    `OBJECTIVE: ${objective}`,
    '',
    'OUTPUT a JSON object with this exact schema:',
    '{"summary":"one-line summary","steps":[',
    '  {"intent":"what this step does","tool":"TOOL_NAME","exact_args":{...},"risk_level":"low"},',
    '  ...',
    ']}',
    '',
    'AVAILABLE TOOLS (use the EXACT names listed):',
    '  web_search     {"query":"...","count":5}',
    '  web_scrape     {"url":"https://...","max_length":5000}',
    '  http_request   {"url":"...","method":"GET","headers":{}}',
    '  browser_launch {"url":"https://..."}',
    '  browser_action {"action":"goto|click|type|fill|press|read|aria_snapshot","target":{"role":"...","text":"..."},"text":"...","key":"..."}',
    '  browser_close  {}',
    '  read_file      {"path":"relative/path"}',
    '  write_file     {"path":"relative/path","content":"..."}',
    '  run_command    {"command":"npm|node|python3|curl|git|...","args":["..."],"cwd":"."}',
    '  think          {"thought":"reasoning..."}',
    '',
    'RULES:',
    '- For account creation or signup tasks: ALWAYS start with web_search to find the actual signup URL. NEVER guess URLs.',
    '- For browser tasks: browser_launch first, then one browser_action per step (goto, type, click, etc).',
    hasIdentity ? `- Use email "${webIdentity.email}" for any login or signup forms. NEVER use a different email.` : '',
    verificationMode === 'resend' && resendInboxApiUrl
      ? '- For email verification, use http_request against the Resend inbox endpoint to fetch verification links, then browser_action goto to open the verification URL.'
      : '',
    '- Keep steps small and atomic — one meaningful action per step.',
    '- Plan 5-15 steps maximum. Be complete but concise.',
    '- Output JSON ONLY. No markdown, no explanations.',
  ].filter(Boolean).join('\n');

  const response = await callResponsesWithFallback({
    settings,
    model,
    callGuards,
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Plan all steps needed to: ${objective}` },
    ],
    temperature: 0.2,
    guidance: ['Return JSON only.', 'No markdown.', 'No explanations.'],
  });

  const outputText = String(response?.output_text || response?.choices?.[0]?.message?.content || '');
  const { extractJSONObjects, sanitizeJsonString } = require('./utils');
  const jsonTexts = extractJSONObjects(outputText);
  if (!jsonTexts || jsonTexts.length === 0) {
    throw new Error('[upfront-plan] LLM did not return a JSON plan.');
  }

  let parsed;
  try {
    parsed = JSON.parse(sanitizeJsonString(jsonTexts[0]));
  } catch (e) {
    throw new Error('[upfront-plan] Failed to parse plan JSON: ' + e.message);
  }

  // Accept {steps:[...]} or {actions:[...]} or a bare array
  const rawSteps = parsed.steps || parsed.actions || (Array.isArray(parsed) ? parsed : []);
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error('[upfront-plan] Plan contained no steps.');
  }

  const steps = rawSteps.map(s => normalizeAction(s)).filter(s => s && s.tool);
  console.log('[upfront-plan] Generated', steps.length, 'steps for:', objective.slice(0, 80));
  return { summary: String(parsed.summary || 'Upfront plan'), steps };
}



// ---------------------------------------------------------------------------
// buildAgentPlannerPrompt

// ---------------------------------------------------------------------------

function buildIdentityAndVerificationPrompt(userProfile = {}, webIdentity = {}, integrations = {}) {
  if (!userProfile.displayName && !webIdentity.email) return '';
  const resendConfig = resolveResendVerificationConfig({ webIdentity, integrations });
  const verificationMode = resendConfig.mode;
  const resendConfigured = Boolean(resendConfig.enabled);
  const resendEndpoint = resendConfig.primaryPollUrl;
  const workflowSection = resendConfigured
    ? [
      '=== EMAIL VERIFICATION WORKFLOW (RESEND MODE) ===',
      'Many services send a verification email after signup. Use the Resend inbox endpoint flow:',
      `1. Poll this endpoint with http_request to fetch the latest inbound email payload: ${resendEndpoint}`,
      '2. Extract the verification URL from the payload body.',
      '3. Open that verification URL with browser_action {"action":"goto","url":"..."}',
      '4. Continue the original task after verification succeeds.',
      '',
      'DO NOT open consumer webmail UIs in this mode unless the Resend endpoint fails repeatedly.',
      '',
    ].join('\n')
    : [
      '=== EMAIL VERIFICATION WORKFLOW ===',
      'Many services send a verification email after signup. When that happens:',
      '1. Determine the webmail URL from the Agent Email domain (e.g. gmail.com → mail.google.com, proton.me → proton.me/mail, outlook.com → outlook.live.com, yahoo.com → mail.yahoo.com, etc.)',
      '2. Navigate to that webmail URL in the browser',
      '3. Log in with Agent Email and Agent Email Password',
      '4. Find the verification email and click the link inside it',
      '5. Wait for the email to arrive: MUST run browser_action {"action":"wait_for","condition":{"load":"load"}}, or explicitly wait 5 seconds before checking the inbox ARIA tree. Emails take time to arrive.',
      '6. In the inbox: look for an email from the signup service. Click it immediately.',
      '7. In the email: find the verification link/button and click it.',
      '8. Continue the original task',
      '',
      'DO NOT ask the user to click verification links. Do NOT take screenshots in the inbox — use the ARIA snapshot to find and click the verification email directly. After completing a signup form, IMMEDIATELY navigate to the agent webmail — in the SAME run, without waiting. Do not stop. Use the stored credentials to do it autonomously.',
      '',
    ].join('\n');
  return [
    '=== IDENTITY & CREDENTIALS ===',
    `- You are acting on behalf of: ${userProfile.displayName || 'The User'}`,
    `- Agent Email: ${webIdentity.email || userProfile.email || 'None provided'}`,
    `- Agent Email Password: ${webIdentity.emailPassword || 'None provided'}`,
    `- Agent Username Preference: ${webIdentity.usernamePreference || 'None provided'}`,
    `- Agent Phone Number: ${webIdentity.phoneNumber || 'None provided'}`,
    `- Agent Birth Date: ${webIdentity.birthDate || 'None provided'}`,
    `- Email Verification Mode: ${verificationMode}${resendConfigured ? ' (Resend endpoint configured)' : ''}`,
    '',
    workflowSection,
    '*For all automated signups and form fills, use the stored agent identity fields unless the user provides different credentials.*',
  ].join('\n');
}

function buildAgentPlannerPrompt({
  task,
  rootObjective = '',
  workspaceRoot,
  workspaceFiles,
  memoryNotes = '',
  globalMemoryNotes = '',
  ragContext = '',
  discoveryNotes = '',
  skillNotes = '',
  teamBrief = '',
  teamMode = 'dev',
  objectivePolicy = null,
  executionMode = 'action',
  bannedApproaches = [],
  scopeGuardNotes = '',
  mediaQualityNotes = '',
  smallChangeGuardNotes = '',
  executionCore = 'geepus',
  coreNotes = '',
  userProfile = {},
  webIdentity = {},
  integrations = {},
}) {
  const policy = objectivePolicy || detectObjectivePolicy(rootObjective || task);
  const policyNotes = objectivePolicyPrompt(policy);
  const taskClass = inferRunTaskClass({ objective: rootObjective || task, executionMode, objectivePolicy: policy });

  const isAuto = executionMode === 'auto';
  const identityAndVerificationPrompt = buildIdentityAndVerificationPrompt(userProfile, webIdentity, integrations);
  const learningNotebook = buildLearningNotebookPrompt(userProfile, {
    objective: rootObjective || task,
    executionMode,
    objectivePolicy: policy,
  });
  const bannedAlternatives = buildBannedApproachAlternativesGuidance(bannedApproaches, {
    objective: rootObjective || task,
    taskClass,
  });
  const bootstrapGuidance = buildBootstrapGuidance(workspaceFiles, rootObjective || task);

  return [
    'You are Geepus, an autonomous coding agent. You reason, act, and observe in a loop.',
    `Execution core: ${describeExecutionCore(executionCore)}.`,
    'Return ONLY valid JSON. No markdown wrapping.',
    '',
    'JSON schema:',
    '{"summary":"string","done":false,"actions":[{"intent":"string","tool":"...","exact_args":{...},"risk_level":"low|medium|high"}]}',
    '',
    'Set "done":true when the objective is fully complete with passing tests. Otherwise false.',
    '',
    learningNotebook,
    bannedAlternatives,
    bootstrapGuidance,
    '',
    '=== TOOLS ===',
    'list_files: {"path":"relative/path","max_depth":2}',
    'read_file: {"path":"relative/path"}',
    'write_file: {"path":"relative/path","content":"full file content"}',
    'patch_file: {"path":"relative/path","search":"exact text to find","replace":"replacement text"} — surgical edit',
    'append_file: {"path":"relative/path","content":"text to append"}',
    'search_files: {"pattern":"text or regex","path":"optional/subdir","is_regex":false,"max_results":50}',
    'run_command: {"command":"npm|npx|node|python3|git|...","args":["..."],"cwd":".","timeout_ms":180000}',
    'think: {"thought":"reasoning..."} — no side effects, use for complex decisions',
    'respond: {"message":"reply text"} — send a direct reply to the user; use for conversational or general tasks that need no tool action',
    'delegate: {"role":"engineering|design|qa|research|strategist|product","task":"specific question or analysis request","context":"relevant details"} — dispatch a specialist subagent for focused analysis. The subagent runs in isolated context and returns a summary. Use when you need expert input.',
    'http_request: {"url":"...","method":"GET","headers":{},"body":"...","timeout_ms":15000}',
    'browser_launch: {"url":"https://..."} - opens a browser session and navigates to the URL.',
    'browser_action: {"action":"ACTION","target":TARGET,"text":"...","key":"...","condition":CONDITION,"frame_index":1} - semantic browser interaction.',
    '  Actions: goto | find | click | type | fill | press | select | wait_for | read | scroll | hover | back | forward | reload | aria_snapshot | frames | evaluate | screenshot | mouse_click | mouse_move | type_at',
    '  target (for click/type/find/select/hover): semantic query object — one of:',
    '    {"role":"button","text":"Next"}  {"label":"Email address"}  {"placeholder":"Search"}',
    '    {"text":"Sign in"}  {"name":"username"}  {"css":"#email-input"}',
    '  Examples:',
    '    click button:  {"action":"click","target":{"role":"button","text":"Next"}}',
    '    type in field: {"action":"type","target":{"label":"First name"},"text":"Alice"}',
    '    type by placeholder: {"action":"type","target":{"placeholder":"Enter email"},"text":"user@example.com"}',
    '    press Enter:   {"action":"press","key":"Enter"}',
    '    select option: {"action":"select","target":{"label":"Country"},"value":"US"}',
    '    navigate:      {"action":"goto","url":"https://example.com/login"}',
    '    wait for URL:  {"action":"wait_for","condition":{"url_contains":"/dashboard"}}',
    '    wait for load: {"action":"wait_for","condition":{"load":"load"}}',
    '    wait for text: {"action":"wait_for","condition":{"text":"Welcome"}}',
    '    wait for elem: {"action":"wait_for","condition":{"element":{"label":"Phone number"}}}',
    '    read field val:{"action":"read","target":{"label":"Email"},"query":{"attr":"value"}}',
    '    read page text:{"action":"read","query":"text"}',
    '    aria snapshot: {"action":"aria_snapshot"} or {"action":"aria_snapshot","target":{"role":"combobox","text":"Month"}} - returns the ARIA tree; use to inspect custom dropdowns/listboxes before interacting',
    '    JS injection:  {"action":"evaluate","script":"document.querySelector(\'select[name=month]\').value=\'11\'"} - raw JS escape hatch for custom components',
    'browser_close: {} - ends the browser session.',
    'analyze_image: {"path":"/ABSOLUTE/path/to/image.png","prompt":"what to inspect"} (DO NOT invent or use relative paths. Use the exact absolute path returned by the last action)',
    'web_search: {"query":"search terms","count":8}',
    'web_scrape: {"url":"https://...","max_length":8000}',
    'web_fetch: {"url":"https://...","max_length":8000} - uses Firecrawl API if configured, bypassing anti-bot measures to extract clean markdown.',
    '',
    '=== HOW TO WORK ===',
    '- ACT FIRST. Create real output on iteration 1.',
    '  For code/UI tasks: write_file to create source files.',
    '  For info/lookup tasks (weather, prices, facts, questions): use web_search or http_request directly — the search result IS the deliverable.',
    '  For download/fetch tasks (images, files, data from URLs): web_search for direct URLs, then run_command curl to download — NOT a Python script.',
    '- For BUILD tasks: never spend an iteration on only research with no files produced.',
    '- For LOOKUP/INFO tasks: web_search, http_request, web_scrape ARE real output. Report the answer and set done=true.',
    '',
    '=== EFFICIENCY — BATCH ACTIONS ===',
    '- CRITICAL: For straightforward tasks ("hello world website", "simple script", "landing page", single-file tasks),',
    '  you MUST batch ALL work into 1-2 iterations total:',
    '  Iteration 1: write_file (create the file) + run_command (start server) + run_playwright (verify). Done.',
    '  Do NOT waste iterations on: reading existing files you plan to overwrite, listing directories you already know,',
    '  or re-verifying work that already passed.',
    '- NEVER read a file more than once. If you already read it in a prior iteration, you have its content — use it.',
    '- If you plan to overwrite/replace a file entirely, skip reading it first — just write the new version.',
    '- Combine read + write + verify in ONE iteration whenever possible. An iteration with only 1 read_file and nothing else is wasted.',
    '- Use delegate to consult specialists ONLY when you have a specific question (e.g., delegate to design for color palette, delegate to qa for test strategy). Do NOT delegate before you have code.',
    '- Each iteration: produce tangible output. For build tasks: write files, run commands. For info tasks: search, fetch, and report.',
    '- Use patch_file for small edits, write_file for new files or full rewrites.',
    '- Use search_files to find code before editing. Use think for complex debugging.',
    '- If the user references a screenshot/image attachment, call analyze_image first before proposing fixes.',
    isAuto ? '- AUTO MODE: Full autonomy. git push, ssh, rsync allowed.' : '- No git push without approval.',
    '- Install dependencies yourself (npm install, pip install, etc.).',
    '- To use dev tools (VS Code, Xcode, compilers, linters, etc.), use run_command. Example: run_command with command="code" or command="xcodebuild".',
    '- NEVER ask the user for anything. You are fully autonomous.',
    '',
    '=== QUALITY ===',
    '- Build COMPLETE, POLISHED products. No stubs, placeholders, or TODO comments.',
    '- Every UI must be styled: colors, spacing, typography, hover states. Unstyled HTML is unacceptable.',
    '- Every function must have real logic. console.log-only handlers are failures.',
    '- Before done=true you MUST verify your work. Run the appropriate verification for your task type:',
    '    • Web/HTML apps → start a local HTTP server, then run run_playwright; confirm zero console errors',
    '    • iOS/macOS apps → xcodebuild build and xcodebuild test; confirm BUILD SUCCEEDED + TEST SUCCEEDED',
    '    • Python scripts → python3 -m pytest (or run the script) and confirm expected output',
    '    • Documents/spreadsheets/slides → open or read the output file and confirm it is complete and correct',
    '    • Info/lookup tasks → present the answer clearly in your summary. No build verification needed.',
    '    • Any other task → determine the right verification and run it; evidence required before done=true',
    '- If a SKILL PLAYBOOK is loaded (above), its "Verification Steps" section is the definitive QA guide. Run those exact steps.',
    '- NEVER fabricate test results. NEVER create a test-results.md file. Run real verification tools.',
    '- Static HTML/CSS/JS sites: NEVER install Jest/mocha/vitest. Use http.server + run_playwright only.',
    '- NEVER pass a file:// path to run_playwright. For local files: start python3 -m http.server 8081 first.',
    '- FILE DOWNLOAD TASKS: use run_command with curl directly. Do not write scripts.',
    '',
    '=== BROWSER AUTOMATION ===',
    '- Use browser_launch / browser_action / browser_close for any multi-step web task.',
    '- Do NOT write Playwright scripts. Use browser_action primitives directly.',
    '- For every browser interaction, follow the OBSERVE → PLAN → ACT → VERIFY loop:',
    '    OBSERVE: Read the URL, title, visible elements, and page text from the action output.',
    '    PLAN:    State the goal and the measurable success condition (e.g., "URL contains /dashboard").',
    '    ACT:     Use ONE primitive action (click, type, press, etc.).',
    '    VERIFY:  Check a concrete post-condition: URL changed? Expected text appeared? Field has correct value?',
    '- TARGET elements semantically — never guess. Use the most stable identifier available:',
    '    BEST: {"label":"Email address"} or {"role":"button","text":"Sign in"} (accessible, stable)',
    '    GOOD: {"placeholder":"Enter your email"} or {"name":"email"}',
    '    LAST: {"text":"some link text"} or {"css":"#specific-id"}',
    '    IMPORTANT: for role-based queries, the "text" should match the ACCESSIBLE NAME, which may come from aria-label/aria-labelledby rather than visible text.',
    '- RULES:',
    '  1. After every action, check the output URL and page text to confirm the expected change.',
    '  2. If an action fails with "no elements found", the ARIA tree output shows you the correct approach. Read the tree:',
    '     - If you see: textbox "Email"  →  use {"role":"textbox","text":"Email"} or {"label":"Email"}',
    '     - If you see: button "Sign Up" →  use {"role":"button","text":"Sign Up"}',
    '     - Try query keys in this order: role+text → label → placeholder → name → css',
    '     - If role+text fails on a custom widget, immediately try the control label or aria name shown in the ARIA snapshot before using CSS.',
    '  3. For forms: type ALL visible fields on a page, THEN click Next/Submit.',
    '  4. Never assume the page layout. Always read what is actually in the output.',
    '  5. Never hardcode site-specific flows. All behavior must come from observing the actual page.',
    '  6. Do NOT scroll just to observe — read the visible elements from the output directly.',
    '  7. Do NOT take screenshots just to observe state — the ARIA tree in every action output is sufficient. ONLY take a screenshot when you are about to use the vision fallback (Step 5 in FALLBACK STRATEGY below).',
    '  7b. When using the vision fallback, you MUST split it across TWO TURNS. Turn 1: Call `browser_action` with `{"action":"screenshot"}` to get the path. Turn 2: Call `analyze_image` using the exact absolute path returned. NEVER try to call both in the same turn, and NEVER guess the path.',
    '  8. If a flow has multiple pages, keep advancing: fill → next → fill → next → ... until done.',
    '  9. Stop and set needs_info ONLY when an element on screen actively asks for external info you cannot provide (SMS code visible, CAPTCHA visible).',
    '  FALLBACK STRATEGY for custom components (ARIA comboboxes, date pickers, framework dropdowns):',
    '    Step 1 — Try: click the component, then type or select as normal.',
    '    Step 2 — If that fails: use aria_snapshot to see the full ARIA tree (all child options/states). Match the component by its accessible name, not just its visible text.',
    '    Step 3 — CROSS-ORIGIN IFRAMES: Use the `frames` action to list all iframes. If the element is inside an iframe, you MUST pass `frame_index` to your Action (e.g. {"action":"type", "target":{"name":"username"}, "text":"geepus", "frame_index":1}).',
    '    Step 4 — After opening a dropdown/combobox, use wait_for with condition.element before clicking an option. Do not assume the options are already present.',
    '    Step 5 — If still stuck: use evaluate (or evaluate with frame_index) to set the value directly via JavaScript.',
    '      Example: {"action":"evaluate","script":"document.querySelector(\'[role=combobox]\').click()"}',
    '    Step 6 — VISION FALLBACK (most robust, works on any site): if DOM/ARIA/JS all fail:',
    '      a) Turn 1: {"action":"screenshot"} — this will return an absolute file path.',
    '      b) Turn 2: Call analyze_image with that path — ask it "what are the x,y pixel coordinates of [element]?"',
    '      c) Turn 3: {"action":"mouse_click","x":N,"y":M} — clicks at the exact pixel coordinate',
    '      d) Optional: {"action":"type_at","x":N,"y":M,"text":"value"} — click + type at coordinates',
    '      This bypasses ALL DOM, ARIA, iframe and anti-automation protections.',
    mediaQualityNotes || '',
    '',
    '=== DISCIPLINE ===',
    '- Do NOT repeat actions that already succeeded. Build on prior results.',
    '- ZERO research-only iterations allowed. If you need research, do it AND write code in the SAME iteration.',
    '- Never web_search the same query twice.',
    '- If stuck, try a different approach. Never blindly retry.',
    '- Aim for 3-8 actions per iteration. One action per iteration is too slow — always batch related actions together.',
    '- For simple tasks: aim to finish in 1-3 iterations total (write + verify + done).',
    '- SCRIPT VERSIONING is a failure pattern: if you have already written 2+ scripts (.py, .sh) that failed, STOP writing scripts.',
    '  Use a completely different tool or approach (e.g., switch from Python scripts to direct curl commands).',
    '- If patch_file fails with "search string not found", STOP using patch_file for that file. Use read_file to see the actual content, then write_file with the corrected version.',
    '- If the same action fails 3+ times, SKIP it entirely and move on to the next part of the objective.',
    '- If a tool, program, or dependency is unavailable, DO NOT give up. Either:',
    '  1. Install it yourself (npm install, pip install, brew install, etc.)',
    '  2. Create it from scratch (write the config, script, or file you need)',
    '  3. Use an alternative tool that achieves the same result',
    '  4. Use run_command to invoke any CLI program on the system',
    '- NEVER tell the user "I can\'t do this" or stop because something isn\'t installed. You are a builder — make it work.',
    '',
    '=== FIND vs CREATE — CRITICAL INFERENCE RULE ===',
    '- When the user says "find", "search for", "get", "download", "fetch", or "look up" content (images, videos,',
    '  documents, data, files), they mean REAL content from the internet — NOT something you invent.',
    '  "Find me 5 pictures of cats" = curl 5 actual cat photos from real URLs.',
    '  Creating SVG drawings, HTML canvas art, placeholder images, or generated illustrations is FABRICATION.',
    '  Fabrication is a FAILURE for find/search/get/download tasks — it is NOT an acceptable fallback.',
    '- The "create from scratch" fallback rule NEVER applies to content the user asked you to find or fetch.',
    '  It only applies to code, configs, documents, or deliverables the user asked you to build/write/create.',
    '- If you cannot find real downloadable URLs for a resource after 2 web_search attempts, stop and',
    '  report exactly what you could not find — do NOT substitute a fabrication.',
    '- Rule of thumb: ask yourself "did the user ask me to BUILD this or to FIND this?"',
    '  BUILD → you can create it. FIND → it must come from a real external source.',
    '',
    scopeGuardNotes || '',
    smallChangeGuardNotes || '',
    coreNotes || '',
    '',
    buildBannedApproachesWarning(bannedApproaches),
    policyNotes || '',
    (policy.researchOnly || policy.noBuild)
      ? '- Research/no-build mode: focus on evidence gathering and reports, not code.'
      : '',
    '',
    `Workspace: ${workspaceRoot}`,
    `Files:\n${workspaceFiles.slice(0, 60).map((e) => `- ${e}`).join('\n')}`,
    identityAndVerificationPrompt ? `\n${identityAndVerificationPrompt}` : '',
    memoryNotes ? `\nMemory:\n${truncate(memoryNotes, 800)}` : '',
    globalMemoryNotes ? `\nGlobal:\n${truncate(globalMemoryNotes, 500)}` : '',
    ragContext ? `\n${truncate(ragContext, 800)}` : '',
    discoveryNotes ? `\nHints:\n${truncate(discoveryNotes, 400)}` : '',
    skillNotes ? `\nSkills:\n${truncate(skillNotes, 400)}` : '',
    teamBrief ? `\nSpecialist input:\n${teamBrief}` : '',
    '',
    `Objective: ${rootObjective || task}`,
    `Current focus: ${task}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// fallbackActionForObjectivePolicy  (local helper)
// ---------------------------------------------------------------------------

function fallbackActionForObjectivePolicy(objective, policy) {
  const objectiveText = String(objective || '').toLowerCase();
  if (policy.webResearchPreferred || objectiveText.includes('reddit')) {
    const defaultResearchUrl = (
      objectiveText.includes('reddit')
      || objectiveText.includes('app')
      || objectiveText.includes('idea')
      || objectiveText.includes('startup')
    )
      ? 'https://www.reddit.com/'
      : 'https://news.ycombinator.com/';
    return normalizeAction({
      intent: 'Browse relevant web sources for research and capture key findings.',
      owner: 'research',
      tool: 'run_playwright',
      exact_args: {
        url: defaultResearchUrl,
        headless: true,
      },
      expected_diff: 'Capture page content and links as evidence for research findings.',
      rollback_plan: 'No rollback needed. Read-only research action.',
      risk_level: 'medium',
    });
  }
  return normalizeAction({
    intent: 'Inspect current workspace for any existing research notes relevant to the objective.',
    owner: 'research',
    tool: 'list_files',
    exact_args: {
      path: '.',
      max_depth: 2,
    },
    expected_diff: 'No file changes. Inventory of relevant documents for research.',
    rollback_plan: 'No rollback needed. Read-only action.',
    risk_level: 'low',
  });
}

// ---------------------------------------------------------------------------
// applyObjectivePolicyToActions
// ---------------------------------------------------------------------------

function extractObjectiveAnchors(objective, threadContext = '', max = 18) {
  const combined = `${String(objective || '')}\n${String(threadContext || '')}`;
  const raw = wordsForMatch(combined);
  const stop = new Set([
    'user', 'assistant', 'geepus', 'task', 'project', 'objective',
    'build', 'create', 'make', 'implement', 'develop', 'work',
    'continue', 'proceed', 'mode', 'action', 'research', 'planning',
  ]);
  return raw
    .filter((token) => token.length >= 4)
    .filter((token) => !stop.has(token))
    .filter((token, index, list) => list.indexOf(token) === index)
    .slice(0, max);
}

function actionMentionsObjectiveAnchors(action, anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) {
    return true;
  }
  const tool = String(action.tool || '').toLowerCase();
  if (tool === 'think' || tool === 'delegate' || tool === 'list_files' || tool === 'read_file' || tool === 'search_files') {
    return true;
  }
  if (tool === 'browser_launch' || tool === 'browser_action' || tool === 'browser_close') {
    return true;
  }
  if (tool === 'run_playwright') {
    return true;
  }
  // Network action tools (web_search, web_scrape, web_fetch, http_request) are the primary
  // deliverable for lookup/info tasks — don't filter them by anchor matching.
  if (tool === 'web_search' || tool === 'web_scrape' || tool === 'web_fetch' || tool === 'http_request') {
    return true;
  }
  const args = ensureObject(action.exact_args || {});
  const command = String(args.command || '').toLowerCase();
  const argText = Array.isArray(args.args) ? args.args.map((item) => String(item).toLowerCase()).join(' ') : '';
  const pathText = String(args.path || '').toLowerCase();
  const text = [
    String(action.intent || '').toLowerCase(),
    tool,
    command,
    argText,
    pathText,
  ].join(' ');

  // Verification and utility commands are often generic and should not be filtered.
  if (tool === 'run_command') {
    const utilityCommand = ['python3', 'python', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'bash', 'sh', 'ls', 'find', 'cat'].includes(command);
    const verificationIntent = /\b(test|lint|build|verify|playwright|http\.server|pytest)\b/.test(`${command} ${argText}`);
    if (utilityCommand && verificationIntent) return true;
    if (command === 'python3' && argText.includes('-m http.server')) return true;
  }
  if (tool === 'run_playwright') {
    const url = String(args.url || '').toLowerCase();
    if (url.includes('localhost') || url.includes('127.0.0.1')) return true;
  }
  return anchors.some((anchor) => text.includes(anchor));
}

function extractFirstUrlFromSearchOutput(output = '') {
  const text = String(output || '');
  const match = text.match(/^\s*URL:\s*(https?:\/\/\S+)/m);
  return match ? String(match[1]).trim() : '';
}

function objectiveImpliesSignup(text = '') {
  const value = String(text || '');
  return /\b(sign.?up|signup|register)\b/i.test(value)
    || (/\bcreate\b/i.test(value) && /\baccount\b/i.test(value));
}

function objectiveImpliesLogin(text = '') {
  return /\b(log.?in|login|sign.?in|signin)\b/i.test(String(text || ''));
}

function extractObjectiveDomain(text = '') {
  const match = String(text || '').toLowerCase().match(/\b([a-z0-9-]+\.[a-z]{2,})\b/);
  return match ? String(match[1]).trim() : '';
}

function isFirstPartyUrlForDomain(url = '', domain = '') {
  if (!url || !domain) return false;
  try {
    const parsed = new URL(url);
    const hostname = String(parsed.hostname || '').toLowerCase();
    const normalizedDomain = String(domain || '').toLowerCase().replace(/^www\./, '');
    return hostname === normalizedDomain || hostname === `www.${normalizedDomain}`;
  } catch {
    return false;
  }
}

function scoreBrowserRecoveryUrl(url = '', objective = '') {
  if (!url) return -1;
  let score = 0;
  const lowerUrl = String(url).toLowerCase();
  const lowerObjective = String(objective || '').toLowerCase();
  if (lowerUrl.startsWith('https://')) score += 20;
  if (objectiveImpliesSignup(lowerObjective)
    && /\/(sign[\-_]?up|signup|register|create[\-_]?account)\b/.test(lowerUrl)) {
    score += 100;
  } else if (objectiveImpliesLogin(lowerObjective)
    && /\/(log[\-_]?in|login|sign[\-_]?in|signin)\b/.test(lowerUrl)) {
    score += 100;
  } else if (lowerUrl.split('/').length > 3) {
    score += 10;
  }
  return score;
}

function extractCanonicalBrowserUrl(objective, priorResults = []) {
  const objectiveDomain = extractObjectiveDomain(objective);
  if (!objectiveDomain) return '';

  let bestUrl = '';
  let bestScore = -1;
  for (const result of Array.isArray(priorResults) ? priorResults : []) {
    if (!result || result.ok !== true || String(result.tool || '') === 'web_search') continue;
    const candidateUrls = new Set();
    const metadata = ensureObject(result.metadata || {});
    for (const raw of [metadata.url, metadata.pageUrl, extractFirstUrlFromSearchOutput(result.output || '')]) {
      const url = String(raw || '').trim();
      if (url) candidateUrls.add(url);
    }
    for (const url of candidateUrls) {
      if (!isFirstPartyUrlForDomain(url, objectiveDomain)) continue;
      const score = scoreBrowserRecoveryUrl(url, objective);
      if (score > bestScore) {
        bestUrl = url;
        bestScore = score;
      }
    }
  }
  return bestUrl;
}

function detectInteractiveBrowserTask(objective = '', threadContext = '') {
  const text = `${String(objective || '')}\n${String(threadContext || '')}`;
  const lower = text.toLowerCase();
  const domain = extractObjectiveDomain(text);
  const signupIntent = objectiveImpliesSignup(lower);
  const loginIntent = objectiveImpliesLogin(lower);
  const verificationIntent = /\b(verify|verification|confirm email|check inbox|otp|2fa|captcha|code)\b/.test(lower);
  const checkoutIntent = /\b(checkout|place order|submit order|pay now|purchase|buy)\b/.test(lower);
  const bookingIntent = /\b(book|booking|reserve|reservation|schedule|appointment|demo)\b/.test(lower);
  const onboardingIntent = /\b(onboarding|onboard|finish setup|complete setup|get started|welcome flow)\b/.test(lower);
  const exportIntent = /\b(export|download|csv|pdf|report|statement)\b/.test(lower);
  const browserIntent = signupIntent
    || loginIntent
    || verificationIntent
    || checkoutIntent
    || bookingIntent
    || onboardingIntent
    || exportIntent
    || /\b(book|buy|checkout|apply|submit form|browser|website|web)\b/.test(lower);
  return {
    enabled: Boolean(domain && browserIntent),
    domain,
    signupIntent,
    loginIntent,
    verificationIntent,
    checkoutIntent,
    bookingIntent,
    onboardingIntent,
    exportIntent,
    objectiveText: text,
  };
}

function resolveUrlAgainstBase(candidate = '', baseUrl = '') {
  const raw = String(candidate || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, baseUrl || undefined).toString();
  } catch {
    return '';
  }
}

function extractObservedLinksFromBrowserOutput(output = '', baseUrl = '') {
  const lines = String(output || '').split('\n');
  const links = [];
  for (let i = 0; i < lines.length; i += 1) {
    const labelMatch = lines[i].match(/link\s+"([^"]+)"/i);
    if (!labelMatch) continue;
    const label = String(labelMatch[1] || '').trim();
    let href = '';
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
      const hrefMatch = lines[j].match(/\/url:\s*(\S+)/);
      if (hrefMatch) {
        href = resolveUrlAgainstBase(hrefMatch[1], baseUrl);
        break;
      }
    }
    links.push({ label, href });
  }
  return links;
}

function latestSuccessfulResult(priorResults = [], predicate = () => true) {
  return [...(Array.isArray(priorResults) ? priorResults : [])]
    .reverse()
    .find((result) => result && result.ok === true && predicate(result));
}

function collectBrowserObservedUrls(objective, priorResults = []) {
  const task = detectInteractiveBrowserTask(objective, '');
  const urls = new Set();
  for (const result of Array.isArray(priorResults) ? priorResults : []) {
    if (!result || result.ok !== true) continue;
    const metadata = ensureObject(result.metadata || {});
    for (const raw of [metadata.url, metadata.pageUrl, extractFirstUrlFromSearchOutput(result.output || '')]) {
      const resolved = resolveUrlAgainstBase(raw, metadata.pageUrl || metadata.url || '');
      if (resolved && (!task.domain || isFirstPartyUrlForDomain(resolved, task.domain))) {
        urls.add(resolved);
      }
    }
    const baseUrl = String(metadata.pageUrl || metadata.url || '');
    const observedLinks = extractObservedLinksFromBrowserOutput(result.output || '', baseUrl);
    for (const link of observedLinks) {
      if (link.href && (!task.domain || isFirstPartyUrlForDomain(link.href, task.domain))) {
        urls.add(link.href);
      }
    }
  }
  return [...urls];
}

function scoreInteractiveBrowserTarget(url = '', objective = '') {
  const lowerUrl = String(url || '').toLowerCase();
  const lowerObjective = String(objective || '').toLowerCase();
  let score = scoreBrowserRecoveryUrl(lowerUrl, lowerObjective);
  if (objectiveImpliesSignup(lowerObjective)) {
    if (/\/signup\b/.test(lowerUrl)) score += 200;
    if (/\/register\b/.test(lowerUrl)) score += 180;
    if (/\/login\b/.test(lowerUrl)) score -= 40;
  }
  if (objectiveImpliesLogin(lowerObjective)) {
    if (/\/login\b/.test(lowerUrl)) score += 200;
    if (/\/signin\b/.test(lowerUrl)) score += 180;
    if (/\/signup\b/.test(lowerUrl)) score -= 40;
  }
  if (/\b(checkout|place order|submit order|pay now|purchase|buy)\b/.test(lowerObjective)) {
    if (/\/checkout\b/.test(lowerUrl)) score += 200;
    if (/\/cart\b/.test(lowerUrl)) score += 140;
    if (/\/pricing\b/.test(lowerUrl)) score += 80;
  }
  if (/\b(book|booking|reserve|reservation|schedule|appointment|demo)\b/.test(lowerObjective)) {
    if (/\/book\b/.test(lowerUrl)) score += 200;
    if (/\/booking\b/.test(lowerUrl)) score += 180;
    if (/\/schedule\b/.test(lowerUrl)) score += 160;
    if (/\/demo\b/.test(lowerUrl)) score += 140;
  }
  if (/\b(onboarding|onboard|finish setup|complete setup|get started|welcome flow)\b/.test(lowerObjective)) {
    if (/\/welcome\b/.test(lowerUrl)) score += 180;
    if (/\/onboarding\b/.test(lowerUrl)) score += 200;
    if (/\/setup\b/.test(lowerUrl)) score += 170;
    if (/\/getting-started\b/.test(lowerUrl)) score += 160;
  }
  if (/\b(export|download|csv|pdf|report|statement)\b/.test(lowerObjective)) {
    if (/\/export\b/.test(lowerUrl)) score += 200;
    if (/\/reports\b/.test(lowerUrl)) score += 160;
    if (/\/downloads\b/.test(lowerUrl)) score += 140;
    if (/\/statements\b/.test(lowerUrl)) score += 140;
  }
  if (/^https:\/\//.test(lowerUrl)) score += 10;
  return score;
}

function pickBestInteractiveBrowserTarget(objective, priorResults = []) {
  const candidates = collectBrowserObservedUrls(objective, priorResults);
  let bestUrl = '';
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = scoreInteractiveBrowserTarget(candidate, objective);
    if (score > bestScore) {
      bestUrl = candidate;
      bestScore = score;
    }
  }
  return bestUrl;
}

function buildOwnedBrowserLaunchAction(url, intent) {
  return normalizeAction({
    owner: 'research',
    tool: 'browser_launch',
    intent,
    exact_args: {
      url,
      session_mode: 'owned',
      prefer_extension: false,
      headless: false,
    },
    expected_diff: `A controlled browser session is opened at ${url}.`,
    rollback_plan: 'Close the browser session if navigation is wrong.',
    risk_level: 'medium',
  });
}

function inferWebmailUrl(email = '') {
  const raw = String(email || '').trim().toLowerCase();
  const domain = raw.split('@')[1] || '';
  if (!domain) return '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'https://mail.google.com/mail/u/0/#inbox';
  if (['proton.me', 'protonmail.com', 'protonmail.ch'].includes(domain)) return 'https://mail.proton.me/u/0/inbox';
  if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) return 'https://outlook.live.com/mail/0/';
  if (domain === 'yahoo.com') return 'https://mail.yahoo.com/';
  if (domain === 'icloud.com' || domain === 'me.com') return 'https://www.icloud.com/mail';
  return `https://mail.${domain}`;
}

function inferWebmailProvider(email = '') {
  const raw = String(email || '').trim().toLowerCase();
  const domain = raw.split('@')[1] || '';
  if (!domain) return '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'gmail';
  if (['proton.me', 'protonmail.com', 'protonmail.ch'].includes(domain)) return 'proton';
  if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) return 'outlook';
  if (domain === 'yahoo.com') return 'yahoo';
  if (domain === 'icloud.com' || domain === 'me.com') return 'icloud';
  return 'generic';
}

function inferEmailVerificationMode(webIdentity = {}, integrations = {}) {
  const modeRaw = String(
    webIdentity.emailVerificationMode
    || integrations.emailVerificationMode
    || 'webmail',
  ).trim().toLowerCase();
  return modeRaw === 'resend' ? 'resend' : 'webmail';
}

function resolveResendVerificationConfig({ webIdentity = {}, integrations = {} } = {}) {
  const mode = inferEmailVerificationMode(webIdentity, integrations);
  const inboxApiUrl = String(webIdentity.resendInboxApiUrl || integrations.resendInboxApiUrl || '').trim();
  const apiKey = String(webIdentity.resendApiKey || integrations.resendApiKey || '').trim();
  const fromFilter = String(webIdentity.resendFromFilter || integrations.resendFromFilter || '').trim();
  const apiBaseUrl = String(
    webIdentity.resendApiBaseUrl
    || integrations.resendApiBaseUrl
    || 'https://api.resend.com',
  ).trim().replace(/\/+$/, '');
  const receivingListUrl = apiBaseUrl ? `${apiBaseUrl}/emails/receiving` : '';
  const primaryPollUrl = inboxApiUrl || (apiKey ? receivingListUrl : '');
  return {
    mode,
    enabled: mode === 'resend' && Boolean(primaryPollUrl),
    inboxApiUrl,
    receivingListUrl,
    primaryPollUrl,
    apiKey,
    apiBaseUrl,
    fromFilter,
  };
}

function isWebmailFlowActive(currentUrl = '', webmailUrl = '', webmailProvider = '') {
  const currentUrlLower = String(currentUrl || '').trim().toLowerCase();
  const provider = String(webmailProvider || '').trim().toLowerCase();
  const host = (() => {
    try {
      return new URL(String(webmailUrl || '').trim()).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  const onWebmailHost = host && currentUrlLower.includes(host);
  const onProviderAuthPage = (
    (provider === 'proton' && (currentUrlLower.includes('account.proton.me/mail') || currentUrlLower.includes('account.proton.me/authorize')))
    || (provider === 'gmail' && currentUrlLower.includes('accounts.google.com'))
    || (provider === 'outlook' && currentUrlLower.includes('login.live.com'))
    || (provider === 'yahoo' && currentUrlLower.includes('login.yahoo.com'))
    || (provider === 'icloud' && (currentUrlLower.includes('icloud.com') || currentUrlLower.includes('appleid.apple.com')))
  );
  return Boolean(onWebmailHost || onProviderAuthPage);
}

function parseHttpRequestBodyFromOutput(output = '') {
  const text = String(output || '');
  const marker = '\nbody:\n';
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) {
    return text.slice(markerIndex + marker.length).trim();
  }
  return text.trim();
}

function normalizeExtractedUrlCandidate(value = '') {
  return String(value || '')
    .trim()
    .replace(/^['"(]+/, '')
    .replace(/[)'".,!;:]+$/, '');
}

function extractVerificationLinkFromText(rawText = '', hintKeywords = []) {
  const text = String(rawText || '');
  if (!text) return '';
  const links = text.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  if (links.length === 0) return '';

  const normalizedHints = (Array.isArray(hintKeywords) ? hintKeywords : [])
    .map((item) => String(item || '').toLowerCase())
    .filter(Boolean);

  let bestLink = '';
  let bestScore = -1;
  for (const rawLink of links) {
    const link = normalizeExtractedUrlCandidate(rawLink);
    if (!/^https?:\/\//i.test(link)) continue;
    const lower = link.toLowerCase();
    let score = 0;
    if (lower.includes('verify')) score += 6;
    if (lower.includes('confirm')) score += 5;
    if (lower.includes('activate')) score += 5;
    if (lower.includes('token')) score += 4;
    if (lower.includes('signup') || lower.includes('sign-up')) score += 3;
    if (lower.includes('email')) score += 2;
    for (const hint of normalizedHints) {
      if (lower.includes(hint)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLink = link;
    }
  }
  return bestLink;
}

function extractResendVerificationLinkFromResults(priorResults = [], inboxApiUrl = '', hintKeywords = []) {
  const endpoint = String(inboxApiUrl || '').trim();
  const ordered = Array.isArray(priorResults) ? [...priorResults].reverse() : [];
  for (const result of ordered) {
    if (!result || result.ok !== true || String(result.tool || '') !== 'http_request') continue;
    const metaUrl = String(result?.metadata?.url || '').trim();
    if (endpoint && metaUrl && metaUrl !== endpoint) continue;
    const body = parseHttpRequestBodyFromOutput(result.output || '');
    const link = extractVerificationLinkFromText(body, hintKeywords);
    if (link) return link;
  }
  return '';
}

function scoreResendReceivedEmailCandidate(item = {}, {
  agentEmail = '',
  fromFilter = '',
  subjectHints = [],
  requireExactRecipient = false,
} = {}) {
  const id = String(item?.id || item?.email_id || '').trim();
  if (!id) return -1000;
  const subject = String(item?.subject || '').trim().toLowerCase();
  const from = String(item?.from || '').trim().toLowerCase();
  const toList = Array.isArray(item?.to) ? item.to : [];
  const lowerToList = toList.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean);
  const normalizedAgentEmail = String(agentEmail || '').trim().toLowerCase();
  const normalizedFromFilter = String(fromFilter || '').trim().toLowerCase();
  const normalizedHints = (Array.isArray(subjectHints) ? subjectHints : [])
    .map((hint) => String(hint || '').trim().toLowerCase())
    .filter(Boolean);

  let score = 0;
  if (normalizedAgentEmail) {
    const hasExactRecipient = lowerToList.includes(normalizedAgentEmail);
    const hasPartialRecipient = lowerToList.some((addr) => addr.includes(normalizedAgentEmail));
    if (requireExactRecipient && !hasExactRecipient) return -1000;
    if (hasExactRecipient) score += 80;
    else if (hasPartialRecipient) score += 60;
    else score -= 120;
  }

  if (normalizedFromFilter) {
    if (from.includes(normalizedFromFilter)) score += 18;
    else score -= 8;
  }

  if (subject.includes('verify')) score += 18;
  if (subject.includes('confirmation') || subject.includes('confirm')) score += 16;
  if (subject.includes('activate') || subject.includes('activation')) score += 14;
  if (subject.includes('welcome')) score += 4;

  for (const hint of normalizedHints) {
    if (hint && subject.includes(hint)) score += 6;
  }

  return score;
}

function extractResendDetailIdsFromResults(priorResults = [], receivingListUrl = '') {
  const listUrl = String(receivingListUrl || '').trim();
  if (!listUrl) return [];
  const ids = [];
  const seen = new Set();
  for (const result of Array.isArray(priorResults) ? priorResults : []) {
    if (!result || result.ok !== true || String(result.tool || '') !== 'http_request') continue;
    const url = String(result?.metadata?.url || '').trim();
    const prefix = `${listUrl}/`;
    if (!url.startsWith(prefix)) continue;
    const id = String(url.slice(prefix.length)).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function extractResendReceivedEmailIdFromResults(priorResults = [], receivingListUrl = '', options = {}) {
  const expected = String(receivingListUrl || '').trim();
  if (!expected) return '';
  const excludeIds = new Set(Array.isArray(options.excludeIds) ? options.excludeIds.map((value) => String(value || '').trim()).filter(Boolean) : []);
  const minimumScore = Number.isFinite(Number(options.minimumScore)) ? Number(options.minimumScore) : 1;
  const ordered = Array.isArray(priorResults) ? [...priorResults].reverse() : [];
  for (const result of ordered) {
    if (!result || result.ok !== true || String(result.tool || '') !== 'http_request') continue;
    const metaUrl = String(result?.metadata?.url || '').trim();
    if (metaUrl !== expected) continue;
    const body = parseHttpRequestBodyFromOutput(result.output || '');
    if (!body) continue;
    try {
      const parsed = JSON.parse(body);
      const items = Array.isArray(parsed?.data)
        ? parsed.data
        : (Array.isArray(parsed?.emails) ? parsed.emails : []);
      let bestId = '';
      let bestScore = -1000;
      for (const entry of items) {
        if (!entry || typeof entry !== 'object') continue;
        const candidateId = String(entry?.id || entry?.email_id || '').trim();
        if (!candidateId || excludeIds.has(candidateId)) continue;
        const score = scoreResendReceivedEmailCandidate(entry, options);
        if (score > bestScore) {
          bestScore = score;
          bestId = candidateId;
        }
      }
      if (bestId && bestScore >= minimumScore) return bestId;
    } catch {
      if (options.requireExactRecipient && String(options.agentEmail || '').trim()) {
        return '';
      }
      const idMatch = body.match(/"id"\s*:\s*"([a-zA-Z0-9_-]{10,})"/);
      if (idMatch && idMatch[1] && !excludeIds.has(idMatch[1])) return idMatch[1];
    }
  }
  return '';
}

function inferServiceKeywords(objective = '', priorResults = []) {
  const domain = extractObjectiveDomain(objective);
  const keywords = new Set();
  if (domain) {
    keywords.add(domain.toLowerCase());
    keywords.add(domain.replace(/^www\./, '').toLowerCase());
    keywords.add(domain.replace(/^www\./, '').split('.')[0].toLowerCase());
  }
  for (const result of Array.isArray(priorResults) ? priorResults : []) {
    const meta = ensureObject(result?.metadata || {});
    const title = String(meta.title || meta.pageTitle || '').trim();
    if (!title) continue;
    const titleHead = title.split(/[|—:-]/)[0].trim().toLowerCase();
    if (titleHead) keywords.add(titleHead);
  }
  return [...keywords].filter(Boolean);
}

function getControllerSpecPreferredUrl(spec, task) {
  const route = ensureObject(spec?.route || {});
  const preferred = Array.isArray(route.preferredEntryUrls) ? route.preferredEntryUrls : [];
  const fallback = Array.isArray(route.fallbackEntryUrls) ? route.fallbackEntryUrls : [];
  const candidates = (
    task?.signupIntent
    || task?.loginIntent
    || task?.checkoutIntent
    || task?.bookingIntent
    || task?.onboardingIntent
    || task?.exportIntent
  ) ? preferred : [];
  return String((candidates[0] || fallback[0] || '')).trim();
}

function sortObservedLinks(pageLinks = [], objective = '', controllerSpec = null) {
  const preferredTexts = Array.isArray(controllerSpec?.route?.linkTextPriority)
    ? controllerSpec.route.linkTextPriority.map((item) => String(item || '').toLowerCase())
    : [];
  return [...pageLinks]
    .map((link) => {
      const label = String(link.label || '').toLowerCase();
      const preferredIndex = preferredTexts.findIndex((item) => label.includes(item));
      return {
        ...link,
        score: scoreInteractiveBrowserTarget(link.href, objective) + (preferredIndex >= 0 ? (100 - preferredIndex) : 0),
      };
    })
    .sort((a, b) => b.score - a.score);
}

function textContainsAny(haystack = '', needles = []) {
  const text = String(haystack || '').toLowerCase();
  return needles.some((needle) => needle && text.includes(String(needle).toLowerCase()));
}

function extractAccessibilityTreeText(output = '') {
  const text = String(output || '');
  const marker = 'Accessibility Tree:';
  const index = text.indexOf(marker);
  if (index >= 0) {
    return text.slice(index + marker.length).trim();
  }
  return text;
}

function classifyBrowserScreen({ output = '', currentUrl = '', task = null } = {}) {
  const uiText = extractAccessibilityTreeText(output);
  const lower = uiText.toLowerCase();
  const url = String(currentUrl || '').toLowerCase();

  const hasEmailField = /\b(textbox\s+"email"|textbox\s+"email or username"|email or username|email)\b/.test(lower);
  const hasPasswordField = /\b(textbox\s+"password"|password)\b/.test(lower);
  const hasCreateAccount = /\b(create account|sign up with email|join\b|sign up\b|register\b)\b/.test(lower);
  const hasSignIn = /\b(sign in|log in|login|keep me signed in)\b/.test(lower);
  const hasCreateAccountButton = /\bbutton\s+"(?:create account|sign up|register|join)\b/.test(lower);
  const hasSignInButton = /\bbutton\s+"(?:sign in|log in|login)\b/.test(lower);
  const hasSignupHeading = /\bheading\s+"(?:join|sign up|create account|register)\b/.test(lower);
  const hasLoginHeading = /\bheading\s+"(?:sign in|log in|login|welcome back)\b/.test(lower);
  const hasAlert = /\balert\b/.test(lower);
  const hasVerificationPrompt = /\b(check your email|verify your email|verification email|confirm your email|click the confirmation link|click the link in your inbox)\b/.test(lower);
  const hasInboxSignals = /\b(inbox|compose|new message|search mail|all mail|drafts|sent)\b/.test(lower);
  const hasMessageSignals = /\b(reply|forward|from:|subject:|unsubscribe|verify email|confirm email|activate account)\b/.test(lower);
  const hasCheckoutSignals = /\b(checkout|pay now|place order|shipping|billing|card number)\b/.test(lower);
  const hasBookingSignals = /\b(book now|reserve|schedule|appointment|confirm booking)\b/.test(lower);
  const hasOnboardingSignals = /\b(get started|continue|finish|complete setup|welcome)\b/.test(lower);
  const hasExportSignals = /\b(export|download csv|download pdf|download)\b/.test(lower);

  if (hasVerificationPrompt) {
    return { type: 'verification_prompt', uiText, lower };
  }
  if (/\/signup\b|\/register\b|\/create-account\b/.test(url) && hasEmailField && hasPasswordField && (hasCreateAccount || hasCreateAccountButton || hasSignupHeading)) {
    return { type: 'auth_signup', uiText, lower };
  }
  if (/\/login\b|\/signin\b/.test(url) && hasEmailField && hasPasswordField && (hasSignIn || hasSignInButton || hasLoginHeading)) {
    return { type: 'auth_login', uiText, lower };
  }
  if (hasEmailField && hasPasswordField) {
    const signupSignals = [
      hasCreateAccount,
      hasCreateAccountButton,
      hasSignupHeading,
      Boolean(task?.signupIntent),
    ].filter(Boolean).length;
    const loginSignals = [
      hasSignIn,
      hasSignInButton,
      hasLoginHeading,
      Boolean(task?.loginIntent),
    ].filter(Boolean).length;
    if (signupSignals > loginSignals) {
      return { type: 'auth_signup', uiText, lower };
    }
    if (loginSignals > signupSignals) {
      return { type: 'auth_login', uiText, lower };
    }
  }
  if (hasInboxSignals) {
    return { type: 'inbox', uiText, lower };
  }
  if (hasMessageSignals) {
    return { type: 'message_view', uiText, lower };
  }
  if (hasCheckoutSignals) {
    return { type: 'checkout', uiText, lower };
  }
  if (hasBookingSignals) {
    return { type: 'booking', uiText, lower };
  }
  if (hasExportSignals) {
    return { type: 'export', uiText, lower };
  }
  if (hasOnboardingSignals) {
    return { type: 'onboarding', uiText, lower };
  }
  if (hasAlert) {
    return { type: 'alert_state', uiText, lower };
  }
  return { type: 'unknown', uiText, lower };
}

function buildBrowserActionStep(intent, exact_args, expected_diff, risk_level = 'medium') {
  return normalizeAction({
    owner: 'research',
    tool: 'browser_action',
    intent,
    exact_args,
    expected_diff,
    rollback_plan: 'Retry from the current page state if the step does not work.',
    risk_level,
    });
}

function buildHttpRequestStep(intent, exact_args, expected_diff, risk_level = 'low') {
  return normalizeAction({
    owner: 'research',
    tool: 'http_request',
    intent,
    exact_args,
    expected_diff,
    rollback_plan: 'Retry the request if the inbox endpoint is temporarily unavailable.',
    risk_level,
  });
}

function buildThinkStep(intent, thought, risk_level = 'low') {
  return normalizeAction({
    owner: 'research',
    tool: 'think',
    intent,
    exact_args: {
      thought: String(thought || '').trim(),
    },
    expected_diff: 'The run records a concrete next-step requirement before continuing.',
    rollback_plan: 'No rollback needed.',
    risk_level,
  });
}

function toControllerIntentTags(task) {
  const tags = [];
  if (task?.signupIntent) tags.push('signup');
  if (task?.loginIntent) tags.push('login');
  if (task?.verificationIntent) tags.push('verification');
  if (task?.checkoutIntent) tags.push('checkout');
  if (task?.bookingIntent) tags.push('booking');
  if (task?.onboardingIntent) tags.push('onboarding');
  if (task?.exportIntent) tags.push('export');
  return tags;
}

function inferInteractiveTaskLabel(task = {}) {
  if (task.signupIntent) return 'signup';
  if (task.loginIntent) return 'login';
  if (task.verificationIntent) return 'verification';
  if (task.checkoutIntent) return 'checkout';
  if (task.bookingIntent) return 'booking';
  if (task.onboardingIntent) return 'onboarding';
  if (task.exportIntent) return 'export';
  return 'interactive';
}

function selectVisibleBrowserActionText(latestOutput = '', candidates = []) {
  const text = String(latestOutput || '').toLowerCase();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const normalized = String(candidate || '').trim();
    if (!normalized) continue;
    if (text.includes(normalized.toLowerCase())) return normalized;
  }
  return '';
}

function inferControllerDisplayName(webIdentity = {}) {
  const explicit = String(webIdentity.displayName || '').trim();
  if (explicit) return explicit;
  const preferred = String(webIdentity.usernamePreference || '').trim();
  if (preferred) return preferred;
  const email = String(webIdentity.email || '').trim();
  if (email.includes('@')) {
    return email.split('@')[0].replace(/[._-]+/g, ' ').trim();
  }
  return '';
}

function inferControllerBirthDate(webIdentity = {}) {
  return String(webIdentity.birthDate || '').trim();
}

function recentBrowserActionMatches(priorResults = [], predicate, count = 3) {
  const recent = Array.isArray(priorResults) ? priorResults.slice(-Math.max(1, count)) : [];
  return recent.some((result) => {
    if (!result || result.ok !== true || String(result.tool || '') !== 'browser_action') return false;
    return predicate(result);
  });
}

function recentBrowserActionFailures(priorResults = [], predicate, count = 4) {
  const recent = Array.isArray(priorResults) ? priorResults.slice(-Math.max(1, count)) : [];
  return recent.filter((result) => {
    if (!result || result.ok === true || String(result.tool || '') !== 'browser_action') return false;
    return predicate(result);
  });
}

function countRecentBrowserActions(priorResults = [], predicate, count = 4) {
  const recent = Array.isArray(priorResults) ? priorResults.slice(-Math.max(1, count)) : [];
  return recent.filter((result) => {
    if (!result || result.ok !== true || String(result.tool || '') !== 'browser_action') return false;
    return predicate(result);
  }).length;
}

function buildAdaptiveSubmitRecoveryPlan({
  summary,
  inspectIntent,
  buttonText,
  postClickIntent,
  postClickExpectedDiff,
}) {
  return {
    summary,
    actions: [
      buildBrowserActionStep(
        inspectIntent,
        { action: 'aria_snapshot', target: { role: 'alert' } },
        'Any validation or transient page state is visible before trying a different interaction.',
        'low',
      ),
      buildBrowserActionStep(
        `Try the primary "${buttonText}" action using a broader text-based interaction target.`,
        { action: 'click', target: { text: buttonText, exact: false } },
        postClickExpectedDiff,
      ),
      buildBrowserActionStep(
        postClickIntent,
        { action: 'wait_for', condition: { ms: 2500 } },
        'The page has additional time to settle after the alternate interaction.',
        'low',
      ),
    ],
    plannerDone: false,
    teamBriefs: [],
  };
}

function maybeAddIdentityFieldActions(actions, latestOutput, webIdentity = {}, options = {}) {
  const output = String(latestOutput || '');
  const email = String(webIdentity.email || '').trim();
  const displayName = inferControllerDisplayName(webIdentity);
  const phoneNumber = String(webIdentity.phoneNumber || '').trim();
  const birthDate = inferControllerBirthDate(webIdentity);
  const includeName = options.includeName !== false;
  const includeEmail = options.includeEmail !== false;
  const includePhone = options.includePhone !== false;
  const includeBirthDate = options.includeBirthDate !== false;
  const nameTargets = Array.isArray(options.nameTargets) ? options.nameTargets : ['Full name', 'Name'];
  const emailTargets = Array.isArray(options.emailTargets) ? options.emailTargets : ['Email'];
  const phoneTargets = Array.isArray(options.phoneTargets) ? options.phoneTargets : ['Phone', 'Phone number', 'Mobile number'];
  const birthTargets = Array.isArray(options.birthTargets) ? options.birthTargets : ['Birthday', 'Birth date', 'Date of birth'];

  const hasNameField = /\b(full name|your name|name)\b/i.test(output);
  const hasEmailField = /\bemail\b/i.test(output);
  const hasPhoneField = /\b(phone|mobile|cell)\b/i.test(output);
  const hasBirthField = /\b(birthday|birth date|date of birth|dob)\b/i.test(output);

  if (includeName && displayName && hasNameField) {
    const nameLabel = nameTargets.find((candidate) => new RegExp(`\\b${candidate.replace(/\s+/g, '\\s+')}\\b`, 'i').test(output)) || nameTargets[0];
    actions.push(buildBrowserActionStep(
      `Enter the known name into the ${nameLabel} field.`,
      { action: 'fill', target: { label: nameLabel }, text: displayName },
      `${nameLabel} is populated.`,
    ));
  }

  if (includeEmail && email && hasEmailField) {
    const emailLabel = emailTargets.find((candidate) => new RegExp(`\\b${candidate.replace(/\s+/g, '\\s+')}\\b`, 'i').test(output)) || emailTargets[0];
    actions.push(buildBrowserActionStep(
      `Enter the agent email address into the ${emailLabel} field.`,
      { action: 'fill', target: { label: emailLabel }, text: email },
      `${emailLabel} is populated.`,
    ));
  }

  if (includePhone && phoneNumber && hasPhoneField) {
    const phoneLabel = phoneTargets.find((candidate) => new RegExp(`\\b${candidate.replace(/\s+/g, '\\s+')}\\b`, 'i').test(output)) || phoneTargets[0];
    actions.push(buildBrowserActionStep(
      `Enter the stored phone number into the ${phoneLabel} field.`,
      { action: 'fill', target: { label: phoneLabel }, text: phoneNumber },
      `${phoneLabel} is populated.`,
    ));
  }

  if (includeBirthDate && birthDate && hasBirthField) {
    const birthLabel = birthTargets.find((candidate) => new RegExp(`\\b${candidate.replace(/\s+/g, '\\s+')}\\b`, 'i').test(output)) || birthTargets[0];
    actions.push(buildBrowserActionStep(
      `Enter the stored birth date into the ${birthLabel} field.`,
      { action: 'fill', target: { label: birthLabel }, text: birthDate },
      `${birthLabel} is populated.`,
    ));
  }
}

function extractControllerPlaybookSteps(priorResults = []) {
  const steps = [];
  for (const result of Array.isArray(priorResults) ? priorResults : []) {
    if (!result || result.ok !== true) continue;
    const tool = String(result.tool || '');
    const metadata = ensureObject(result.metadata || {});
    const pageTitle = String(metadata.pageTitle || metadata.title || '').trim();
    const titleHead = pageTitle.split(/[|—:-]/)[0].trim();
    if (tool === 'browser_launch') {
      const url = String(metadata.pageUrl || metadata.url || '').trim();
      if (url) {
        steps.push({
          kind: 'launch',
          action: 'goto',
          url,
          requiresTexts: titleHead ? [titleHead] : [],
        });
      }
      continue;
    }
    if (tool !== 'browser_action') continue;
    const action = String(metadata.action || result.exact_args?.action || '').trim().toLowerCase();
    if (!action || ['wait_for', 'aria_snapshot', 'find', 'read', 'frames', 'hover', 'scroll'].includes(action)) continue;
    const target = ensureObject(metadata.target || result.exact_args?.target || {});
    const step = {
      kind: 'action',
      action,
      targetText: String(target.text || '').trim(),
      targetLabel: String(target.label || '').trim(),
      url: String(metadata.url || result.exact_args?.url || '').trim(),
      requiresTexts: titleHead ? [titleHead] : [],
    };
    steps.push(step);
  }
  const seen = new Set();
  return steps.filter((step) => {
    const key = JSON.stringify(step);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function normalizeControllerPlaybookSteps(playbook = {}) {
  const steps = Array.isArray(playbook?.steps) ? playbook.steps : [];
  return steps.map((step) => ({
    kind: String(step?.kind || '').trim().toLowerCase(),
    action: String(step?.action || '').trim().toLowerCase(),
    targetText: String(step?.targetText || '').trim(),
    targetLabel: String(step?.targetLabel || '').trim(),
    url: String(step?.url || '').trim(),
    requiresTexts: Array.isArray(step?.requiresTexts)
      ? step.requiresTexts.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
  })).filter((step) => step.kind && step.action);
}

function playbookStepsMatch(expected = {}, actual = {}) {
  if (String(expected.action || '').toLowerCase() !== String(actual.action || '').toLowerCase()) return false;
  if (expected.url && String(expected.url || '').trim() !== String(actual.url || '').trim()) return false;
  if (expected.targetText && String(expected.targetText || '').trim() !== String(actual.targetText || '').trim()) return false;
  if (expected.targetLabel && String(expected.targetLabel || '').trim() !== String(actual.targetLabel || '').trim()) return false;
  return true;
}

function findNextPlaybookStep(playbookSteps = [], executedSteps = []) {
  let matchedCount = 0;
  for (const expected of playbookSteps) {
    const actual = executedSteps[matchedCount];
    if (actual && playbookStepsMatch(expected, actual)) {
      matchedCount += 1;
      continue;
    }
    return expected;
  }
  return null;
}

function resolvePlaybookFillValue(step = {}, webIdentity = {}) {
  const label = `${String(step.targetLabel || '')} ${String(step.targetText || '')}`.toLowerCase();
  if (label.includes('email')) return String(webIdentity.email || '').trim();
  if (label.includes('password')) return String(webIdentity.emailPassword || '').trim();
  if (label.includes('name')) return inferControllerDisplayName(webIdentity);
  if (label.includes('phone') || label.includes('mobile') || label.includes('cell')) return String(webIdentity.phoneNumber || '').trim();
  if (label.includes('birth') || label.includes('birthday') || label.includes('dob')) return inferControllerBirthDate(webIdentity);
  return '';
}

function isPlaybookStepApplicable(step = {}, latestOutput = '', currentUrl = '') {
  if (!step || !step.action) return false;
  const output = String(latestOutput || '').toLowerCase();
  const requiresTexts = Array.isArray(step.requiresTexts) ? step.requiresTexts : [];
  if (requiresTexts.length > 0 && !requiresTexts.some((text) => output.includes(String(text || '').toLowerCase()))) {
    return false;
  }
  if (step.action === 'goto') {
    return Boolean(step.url && String(step.url).trim() !== String(currentUrl || '').trim());
  }
  if (step.action === 'click') {
    return Boolean(step.targetText && output.includes(String(step.targetText).toLowerCase()));
  }
  if (step.action === 'fill') {
    return Boolean(step.targetLabel && output.includes(String(step.targetLabel).toLowerCase()));
  }
  return false;
}

function buildPlanFromPlaybookStep(step = {}, { webIdentity = {} } = {}) {
  if (!step || !step.action) return null;
  if (step.action === 'goto' && step.url) {
    return {
      summary: `Follow learned step: open ${step.url}`,
      actions: [buildBrowserActionStep(
        `Follow the learned controller step by navigating to ${step.url}.`,
        { action: 'goto', url: step.url },
        `The browser is on ${step.url}.`,
      )],
      plannerDone: false,
      teamBriefs: [],
      controller: 'interactive-browser',
    };
  }
  if (step.action === 'click' && step.targetText) {
    return {
      summary: `Follow learned step: click ${step.targetText}`,
      actions: [
        buildBrowserActionStep(
          `Follow the learned controller step by clicking ${step.targetText}.`,
          { action: 'click', target: { text: step.targetText, exact: false } },
          `The learned click target ${step.targetText} is activated.`,
        ),
        buildBrowserActionStep(
          'Wait briefly for the next page state to render.',
          { action: 'wait_for', condition: { ms: 1200 } },
          'The page settles after the learned click step.',
          'low',
        ),
      ],
      plannerDone: false,
      teamBriefs: [],
      controller: 'interactive-browser',
    };
  }
  if (step.action === 'fill' && step.targetLabel) {
    const value = resolvePlaybookFillValue(step, webIdentity);
    if (!value) return null;
    return {
      summary: `Follow learned step: fill ${step.targetLabel}`,
      actions: [buildBrowserActionStep(
        `Follow the learned controller step by filling ${step.targetLabel}.`,
        { action: 'fill', target: { label: step.targetLabel }, text: value },
        `${step.targetLabel} is populated.`,
      )],
      plannerDone: false,
      teamBriefs: [],
      controller: 'interactive-browser',
    };
  }
  return null;
}

function buildSuggestedControllerSpec({ task, priorResults = [], controllerSpec = null }) {
  if (!task?.enabled || controllerSpec) return null;
  const observedUrls = collectBrowserObservedUrls(task.objectiveText, priorResults)
    .filter((url) => isFirstPartyUrlForDomain(url, task.domain));
  const sortedUrls = [...observedUrls].sort((a, b) =>
    scoreInteractiveBrowserTarget(b, task.objectiveText) - scoreInteractiveBrowserTarget(a, task.objectiveText));
  const preferredEntryUrl = sortedUrls[0] || '';
  const fallbackUrl = task.domain ? `https://${task.domain.replace(/^www\./, '')}` : '';
  const latestBrowserResult = latestSuccessfulResult(
    priorResults,
    (result) => ['browser_launch', 'browser_action'].includes(String(result.tool || ''))
      && extractBrowserStateFromMetadata(result.metadata),
  );
  const latestOutput = String(latestBrowserResult?.output || '');
  const pageLinks = sortObservedLinks(
    extractObservedLinksFromBrowserOutput(latestOutput, latestBrowserResult?.metadata?.pageUrl || latestBrowserResult?.metadata?.url || ''),
    task.objectiveText,
    null,
  );
  const preferredLinkTexts = pageLinks
    .map((link) => String(link.label || '').trim())
    .filter(Boolean)
    .slice(0, 5);
  const domainStem = String(task.domain || '').replace(/^www\./, '').split('.')[0];
  return {
    version: 1,
    id: `${domainStem}-${toControllerIntentTags(task).join('-') || 'interactive'}`,
    name: `${domainStem} ${toControllerIntentTags(task).join(' ') || 'interactive'} controller`,
    match: {
      domains: [task.domain],
      intents: toControllerIntentTags(task),
    },
    route: {
      preferredEntryUrls: preferredEntryUrl ? [preferredEntryUrl] : [],
      fallbackEntryUrls: fallbackUrl ? [fallbackUrl] : [],
      linkTextPriority: preferredLinkTexts,
      emailVerification: {
        inboxSubjectKeywords: inferServiceKeywords(task.objectiveText, priorResults).slice(0, 4),
        verifyLinkTexts: ['Verify Email', 'Confirm Email', 'Activate Account'],
      },
    },
    playbook: {
      steps: extractControllerPlaybookSteps(priorResults),
    },
  };
}

async function maybePersistBrowserControllerProposal({ workspaceRoot, objective, threadContext = '', priorResults = [] }) {
  if (!workspaceRoot) return '';
  const task = detectInteractiveBrowserTask(objective, threadContext);
  if (!task.enabled) return '';
  const specs = loadBrowserControllerSpecsSync(workspaceRoot);
  const activeSpec = pickMatchingBrowserControllerSpec(specs, {
    objective: task.objectiveText,
    domain: task.domain,
  });
  if (activeSpec) return '';
  const suggested = buildSuggestedControllerSpec({ task, priorResults, controllerSpec: activeSpec });
  if (!suggested || !Array.isArray(suggested.route?.preferredEntryUrls) || suggested.route.preferredEntryUrls.length === 0) {
    return '';
  }
  try {
    return await saveProposedBrowserControllerSpec(workspaceRoot, suggested);
  } catch {
    return '';
  }
}

function buildEmailVerificationControllerPlan({
  task,
  settings = {},
  webIdentity,
  latestBrowserState,
  latestOutput,
  priorResults,
  controllerSpec,
  forceActiveRecovery = false,
}) {
  if (!task || !task.enabled || !webIdentity?.email || !latestBrowserState) {
    return null;
  }

  const integrations = ensureObject(settings?.integrations || {});
  const resendConfig = resolveResendVerificationConfig({ webIdentity, integrations });
  if (resendConfig.mode === 'resend' && !resendConfig.enabled) {
    return {
      summary: 'Resend mode selected but not configured',
      actions: [
        buildThinkStep(
          'Stop webmail fallback and require Resend configuration before email verification continues.',
          'Email verification mode is set to resend, but no usable source is configured. Configure either webIdentity.resendInboxApiUrl OR webIdentity.resendApiKey (with resendApiBaseUrl) before continuing.',
        ),
      ],
      plannerDone: false,
      teamBriefs: [],
      controller: 'email-verification',
    };
  }
  const requiresWebmailCredentials = !resendConfig.enabled;
  if (requiresWebmailCredentials && !webIdentity?.emailPassword) {
    return null;
  }

  const webmailUrl = inferWebmailUrl(webIdentity.email);
  if (!webmailUrl && requiresWebmailCredentials) return null;
  const webmailProvider = inferWebmailProvider(webIdentity.email);

  const currentUrl = String(latestBrowserState.pageUrl || '');
  const currentUrlLower = currentUrl.toLowerCase();
  const screen = classifyBrowserScreen({ output: latestOutput, currentUrl, task });
  const uiText = screen.uiText;
  const onWebmailFlow = isWebmailFlowActive(currentUrl, webmailUrl, webmailProvider);
  const specKeywords = Array.isArray(controllerSpec?.route?.emailVerification?.inboxSubjectKeywords)
    ? controllerSpec.route.emailVerification.inboxSubjectKeywords
    : [];
  const verifyTexts = Array.isArray(controllerSpec?.route?.emailVerification?.verifyLinkTexts)
    ? controllerSpec.route.emailVerification.verifyLinkTexts
    : [];
  const serviceKeywords = [...inferServiceKeywords(task.objectiveText, priorResults), ...specKeywords];
  const resendHintKeywords = [
    ...serviceKeywords,
    ...verifyTexts.map((item) => String(item || '').toLowerCase()),
    resendConfig.fromFilter,
  ].filter(Boolean);
  const resendHeaders = resendConfig.apiKey
    ? { Authorization: `Bearer ${resendConfig.apiKey}`, Accept: 'application/json' }
    : { Accept: 'application/json' };
  const seenResendDetailIds = resendConfig.enabled
    ? extractResendDetailIdsFromResults(priorResults, resendConfig.receivingListUrl)
    : [];
  const resendReceivedEmailId = resendConfig.enabled
    ? extractResendReceivedEmailIdFromResults(priorResults, resendConfig.receivingListUrl, {
      agentEmail: webIdentity.email,
      fromFilter: resendConfig.fromFilter,
      subjectHints: resendHintKeywords,
      excludeIds: seenResendDetailIds,
      requireExactRecipient: true,
      minimumScore: 1,
    })
    : '';
  const resendDetailUrl = (resendConfig.enabled && resendReceivedEmailId && resendConfig.receivingListUrl)
    ? `${resendConfig.receivingListUrl}/${resendReceivedEmailId}`
    : '';
  const resendRequestHistory = Array.isArray(priorResults)
    ? priorResults.filter((result) => {
      if (!result || result.ok !== true || String(result.tool || '') !== 'http_request') return false;
      const url = String(result?.metadata?.url || '').trim();
      return Boolean(
        url
        && (
          (resendConfig.primaryPollUrl && url === resendConfig.primaryPollUrl)
          || (resendConfig.receivingListUrl && url.startsWith(`${resendConfig.receivingListUrl}/`))
        )
      );
    })
    : [];
  const resendMaxAttemptsReached = resendRequestHistory.length >= 6;
  const latestResendRequestUrl = resendRequestHistory.length > 0
    ? String(resendRequestHistory[resendRequestHistory.length - 1]?.metadata?.url || '').trim()
    : '';
  const repeatedSameResendRequest = resendRequestHistory.length >= 3
    && resendRequestHistory.slice(-3).every((result) => String(result?.metadata?.url || '').trim() === latestResendRequestUrl);
  const resendVerificationLink = resendConfig.enabled
    ? (extractResendVerificationLinkFromResults(priorResults, resendConfig.inboxApiUrl, resendHintKeywords)
      || extractResendVerificationLinkFromResults(priorResults, resendDetailUrl, resendHintKeywords))
    : '';
  const verificationPromptVisible = textContainsAny(uiText, [
    'check your email',
    'verify your email',
    'verification email',
    'confirm your email',
    'we sent you an email',
    'we sent a verification',
    'open your inbox',
    'click the link in the email',
  ]);
  const verificationLinkVisible = textContainsAny(uiText, [
    'verify email',
    'confirm email',
    'activate account',
    'complete signup',
    'complete sign up',
    'confirm account',
    ...verifyTexts,
  ]);
  const inboxVisible = textContainsAny(uiText, [
    'inbox',
    'compose',
    'new message',
    'search mail',
    'all mail',
    'sent',
    'drafts',
  ]);
  const emailLabel = serviceKeywords.find((keyword) => textContainsAny(uiText, [keyword]));
  const pageHasEmail = /\b(email|username)\b/i.test(uiText);
  const pageHasPassword = /\bpassword\b/i.test(uiText);
  const signInVisible = textContainsAny(uiText, ['sign in', 'keep me signed in', 'email or username']);
  const authLoadingVisible = textContainsAny(uiText, [
    'loading proton account',
    'signing in',
    'loading',
  ]);
  const knownTitle = `${String(latestBrowserState.pageTitle || '')}\n${String(latestOutput || '')}`.toLowerCase();
  const emailFieldLabel = textContainsAny(uiText, ['email or username']) ? 'Email or username' : 'Email';
  const recentWebmailSubmitFailures = onWebmailFlow ? recentBrowserActionFailures(priorResults, (result) => {
    const output = String(result.output || '').toLowerCase();
    const intent = String(result.intent || '').trim().toLowerCase();
    return intent.includes('submit the webmail login form') || output.includes('sign in');
  }, 5) : [];
  const recentWebmailAuthSettleActions = onWebmailFlow ? countRecentBrowserActions(priorResults, (result) => {
    const intent = String(result.intent || '').trim().toLowerCase();
    return intent.includes('webmail authentication transition')
      || intent.includes('refresh the mailbox accessibility tree after the authentication transition');
  }, 6) : 0;
  const browserFrames = Array.isArray(latestBrowserState.frames) ? latestBrowserState.frames : [];
  const protonLoginFrame = browserFrames.find((frame) => String(frame?.url || '').toLowerCase().includes('name=login'));
  const protonChallengeFrame = browserFrames.find((frame) => String(frame?.url || '').toLowerCase().includes('account-api.proton.me/challenge'));
  const protonChallengeVisible = Boolean(protonChallengeFrame);
  const protonSignInPageVisible = webmailProvider === 'proton' && (
    currentUrlLower.includes('account.proton.me/mail')
    || knownTitle.includes('proton mail: sign-in')
    || knownTitle.includes('to continue to proton mail')
  );

  if (resendConfig.enabled && (task.signupIntent || task.verificationIntent) && resendVerificationLink) {
    return {
      summary: 'Open verification link from Resend inbox endpoint',
      actions: [
        buildBrowserActionStep(
          'Navigate directly to the verification URL extracted from the latest Resend inbox payload.',
          { action: 'goto', url: resendVerificationLink },
          'The browser opens the account verification destination from the email payload.',
        ),
        buildBrowserActionStep(
          'Wait briefly for the verification destination to load.',
          { action: 'wait_for', condition: { ms: 1500 } },
          'The verification page has time to fully render.',
          'low',
        ),
      ],
      plannerDone: false,
      teamBriefs: [],
      controller: 'email-verification',
    };
  }

  if (resendConfig.enabled && (task.signupIntent || task.verificationIntent) && !resendVerificationLink && (resendMaxAttemptsReached || repeatedSameResendRequest)) {
    return {
      summary: 'Stop Resend polling loop and require narrower inbox filter',
      actions: [
        buildThinkStep(
          'Abort repeated Resend inbox polling to avoid burning API usage on unrelated messages.',
          [
            'Repeated Resend polling did not find a verification link and has reached the safety cap.',
            `Most recent request URL: ${latestResendRequestUrl || '(none)'}`,
            `Agent email expected in recipient list: ${webIdentity.email || '(not set)'}`,
            'Set a stricter Resend filter (recipient and/or sender), then start a fresh run.',
          ].join(' '),
        ),
      ],
      plannerDone: false,
      teamBriefs: [],
      controller: 'email-verification',
    };
  }

  if (resendConfig.enabled && onWebmailFlow) {
    const backToTargetUrl = pickBestInteractiveBrowserTarget(task.objectiveText, priorResults)
      || extractCanonicalBrowserUrl(task.objectiveText, priorResults);
    const actions = [];
    if (backToTargetUrl) {
      actions.push(buildBrowserActionStep(
        `Leave webmail UI and return to the primary signup flow at ${backToTargetUrl}.`,
        { action: 'goto', url: backToTargetUrl },
        'The browser returns to the signup flow while verification runs through Resend endpoint polling.',
      ));
    }
    actions.push(buildHttpRequestStep(
      resendDetailUrl
        ? 'Fetch the latest received email detail from Resend so the verification URL can be extracted.'
        : 'Poll the configured Resend inbox endpoint for the newest verification email payload.',
      { url: resendDetailUrl || resendConfig.primaryPollUrl, method: 'GET', headers: resendHeaders, timeout_ms: 15000 },
      resendDetailUrl
        ? 'Detailed email payload is available for verification-link extraction.'
        : 'The latest email payload is retrieved so the verification URL can be extracted.',
    ));
    return {
      summary: 'Bypass webmail UI and use Resend inbox endpoint',
      actions,
      plannerDone: false,
      teamBriefs: [],
      controller: 'email-verification',
    };
  }

  if ((task.signupIntent || task.verificationIntent) && screen.type === 'verification_prompt' && !onWebmailFlow) {
    if (resendConfig.enabled) {
      return {
        summary: resendDetailUrl
          ? 'Fetch latest Resend email detail for verification URL extraction'
          : 'Poll Resend inbox endpoint for the verification link',
        actions: [
          buildHttpRequestStep(
            resendDetailUrl
              ? 'Fetch the most recent received-email detail from Resend to obtain the full verification message body.'
              : 'Fetch the latest inbound verification email payload from the configured Resend inbox endpoint.',
            { url: resendDetailUrl || resendConfig.primaryPollUrl, method: 'GET', headers: resendHeaders, timeout_ms: 15000 },
            resendDetailUrl
              ? 'Full received-email detail is available so verification links can be extracted.'
              : 'Verification email payload is available so the link can be extracted on the next planning step.',
          ),
          buildBrowserActionStep(
            'Wait briefly before re-checking for the verification payload.',
            { action: 'wait_for', condition: { ms: 1200 } },
            'The inbox endpoint has time to receive a newly sent verification email.',
            'low',
          ),
        ],
        plannerDone: false,
        teamBriefs: [],
        controller: 'email-verification',
      };
    }
    return {
      summary: `Open webmail at ${webmailUrl}`,
      actions: [
        buildOwnedBrowserLaunchAction(
          webmailUrl,
          `Open the agent inbox to complete email verification at ${webmailUrl}.`,
        ),
      ],
      plannerDone: false,
      teamBriefs: [],
      controller: 'email-verification',
    };
  }

  if (onWebmailFlow && protonSignInPageVisible && protonChallengeVisible && protonLoginFrame && webIdentity.email && webIdentity.emailPassword && recentWebmailAuthSettleActions >= 2) {
    return {
      summary: 'Complete Proton challenge login',
      actions: [
        buildBrowserActionStep(
          'Inspect the Proton login challenge frame before interacting with it.',
          { action: 'aria_snapshot', frame_index: Number(protonLoginFrame.index) },
          'The Proton challenge frame contents are visible for the next step.',
          'low',
        ),
        buildBrowserActionStep(
          'Enter the agent email address into the Proton login challenge frame.',
          { action: 'fill', target: { label: 'Email or username' }, text: webIdentity.email, frame_index: Number(protonLoginFrame.index) },
          'The Proton email field inside the challenge frame is populated.',
        ),
        buildBrowserActionStep(
          'Enter the stored agent password into the Proton login challenge frame.',
          { action: 'fill', target: { label: 'Password' }, text: webIdentity.emailPassword, frame_index: Number(protonLoginFrame.index) },
          'The Proton password field inside the challenge frame is populated.',
        ),
        buildBrowserActionStep(
          'Submit the Proton login challenge frame.',
          { action: 'click', target: { role: 'button', text: 'Sign in' }, frame_index: Number(protonLoginFrame.index) },
          'The mailbox or next authenticated state appears.',
        ),
        buildBrowserActionStep(
          'Wait briefly for the mailbox or next authenticated Proton state to appear.',
          { action: 'wait_for', condition: { ms: 2500 } },
          'The Proton authentication flow has time to settle after the frame submission.',
          'low',
        ),
      ],
      plannerDone: false,
      teamBriefs: [],
      controller: 'email-verification',
    };
  }

  if (onWebmailFlow && forceActiveRecovery && (authLoadingVisible || screen.type === 'unknown')) {
    const authFrame = browserFrames.find((frame) => String(frame?.url || '').toLowerCase().includes('name=login'))
      || browserFrames.find((frame) => {
        const url = String(frame?.url || '').toLowerCase();
        return url.includes('/challenge/')
          || url.includes('/auth')
          || url.includes('account-api');
      });
    const frameIndexArgs = Number.isInteger(Number(authFrame?.index))
      ? { frame_index: Number(authFrame.index) }
      : {};
    const actions = [];
    if (pageHasEmail && webIdentity.email) {
      actions.push(buildBrowserActionStep(
        'Re-enter the agent email in the current webmail authentication step.',
        { action: 'fill', target: { label: emailFieldLabel }, text: webIdentity.email, ...frameIndexArgs },
        'The webmail email field is populated for another login attempt.',
      ));
    }
    if (pageHasPassword && webIdentity.emailPassword) {
      actions.push(buildBrowserActionStep(
        'Re-enter the stored agent password in the current webmail authentication step.',
        { action: 'fill', target: { label: 'Password' }, text: webIdentity.emailPassword, ...frameIndexArgs },
        'The webmail password field is populated for another login attempt.',
      ));
    }
    actions.push(
      buildBrowserActionStep(
        'Attempt the primary webmail authentication action now instead of waiting again.',
        { action: 'click', target: { text: textContainsAny(uiText, ['sign in', 'log in']) ? 'Sign in' : 'Continue', exact: false }, ...frameIndexArgs },
        'The mailbox login flow advances or shows an actionable error state.',
      ),
      buildBrowserActionStep(
        'Wait briefly for the mailbox state to change after the active recovery action.',
        { action: 'wait_for', condition: { ms: 1500 } },
        'The webmail page has time to update after the active action.',
        'low',
      ),
    );
    return {
      summary: 'Escalate webmail authentication recovery',
      actions,
      plannerDone: false,
      teamBriefs: [],
      controller: 'email-verification',
    };
  }

  if (onWebmailFlow && (authLoadingVisible || screen.type === 'unknown')) {
    return {
      summary: 'Wait for webmail authentication to settle',
      actions: [
        buildBrowserActionStep(
          'Wait briefly for the webmail authentication transition to complete.',
          { action: 'wait_for', condition: { ms: 3000 } },
          'The mailbox login transition has additional time to complete.',
          'low',
        ),
        buildBrowserActionStep(
          'Refresh the mailbox accessibility tree after the authentication transition.',
          { action: 'aria_snapshot' },
          'The current mailbox state is visible for the next step.',
          'low',
        ),
      ],
      plannerDone: false,
      teamBriefs: [],
      controller: 'email-verification',
    };
  }

  if (onWebmailFlow && screen.type === 'auth_login' && pageHasEmail && pageHasPassword && signInVisible) {
    if (recentWebmailSubmitFailures.length > 0) {
      return {
        ...buildAdaptiveSubmitRecoveryPlan({
          summary: 'Try an alternate webmail login approach',
          inspectIntent: 'Inspect the webmail login state before trying a different sign-in interaction.',
          buttonText: 'Sign in',
          postClickIntent: 'Wait briefly for the mailbox or next authenticated state to appear.',
          postClickExpectedDiff: 'The inbox or next authenticated state appears.',
        }),
        controller: 'email-verification',
      };
    }
    return {
      summary: 'Complete webmail login',
      actions: [
        buildBrowserActionStep(
          'Enter the agent email address into the webmail login form.',
          { action: 'fill', target: { label: emailFieldLabel }, text: webIdentity.email },
          'The webmail email field is populated.',
        ),
        buildBrowserActionStep(
          'Enter the stored agent password into the webmail login form.',
          { action: 'fill', target: { label: 'Password' }, text: webIdentity.emailPassword },
          'The webmail password field is populated.',
        ),
        buildBrowserActionStep(
          'Submit the webmail login form.',
          { action: 'click', target: { role: 'button', text: 'Sign in' } },
          'The inbox or next authenticated state appears.',
        ),
        buildBrowserActionStep(
          'Wait briefly for the inbox to load.',
          { action: 'wait_for', condition: { ms: 1500 } },
          'The inbox has time to render.',
          'low',
        ),
      ],
      plannerDone: false,
      teamBriefs: [],
      controller: 'email-verification',
    };
  }

  if (onWebmailFlow && pageHasEmail && !pageHasPassword) {
    return {
      summary: 'Sign in to webmail',
      actions: [
        buildBrowserActionStep(
          'Enter the agent email address into the webmail login form.',
          { action: 'fill', target: { label: emailFieldLabel }, text: webIdentity.email },
          'The webmail email field is populated.',
        ),
        buildBrowserActionStep(
          'Advance from the email entry step in webmail.',
          { action: 'click', target: { role: 'button', text: 'Next' } },
          'The password entry step or inbox appears.',
        ),
      ],
      plannerDone: false,
      teamBriefs: [],
      controller: 'email-verification',
    };
  }

  if (onWebmailFlow && screen.type === 'inbox' && inboxVisible && emailLabel) {
    return {
      summary: 'Open the verification email',
      actions: [
        buildBrowserActionStep(
          `Open the inbox message related to ${emailLabel}.`,
          { action: 'click', target: { text: emailLabel, exact: false } },
          'The verification email message is open.',
        ),
      ],
      plannerDone: false,
      teamBriefs: [],
      controller: 'email-verification',
    };
  }

  if (onWebmailFlow && (screen.type === 'message_view' || verificationLinkVisible)) {
    return {
      summary: 'Click the verification link',
      actions: [
        buildBrowserActionStep(
          'Click the verification link or button inside the email.',
          { action: 'click', target: { text: 'Verify', exact: false } },
          'The account verification link is activated.',
        ),
        buildBrowserActionStep(
          'Wait briefly for the verification page to load.',
          { action: 'wait_for', condition: { ms: 1500 } },
          'The verification destination has time to render.',
          'low',
        ),
      ],
      plannerDone: false,
      teamBriefs: [],
      controller: 'email-verification',
    };
  }

  return null;
}

function buildAccountTaskControllerPlan({
  objective,
  threadContext = '',
  priorResults = [],
  settings = {},
  controllerSpec = null,
  task = null,
  webIdentity = {},
  latestBrowserResult = null,
  latestBrowserState = null,
  latestOutput = '',
}) {
  if (!task.enabled) return null;

  const bestTargetUrl = getControllerSpecPreferredUrl(controllerSpec, task)
    || pickBestInteractiveBrowserTarget(objective, priorResults)
    || extractCanonicalBrowserUrl(objective, priorResults);
  const webmailUrl = inferWebmailUrl(webIdentity.email);
  const webmailProvider = inferWebmailProvider(webIdentity.email);

  if (!latestBrowserState) {
    if (bestTargetUrl) {
      return {
        summary: `Open ${bestTargetUrl}`,
        actions: [
          buildOwnedBrowserLaunchAction(
            bestTargetUrl,
            `Open the best first-party page already discovered for this task: ${bestTargetUrl}.`,
          ),
        ],
        plannerDone: false,
        teamBriefs: [],
        controller: 'interactive-browser',
      };
    }

    const explicitUrlMatch = String(objective || '').match(/https?:\/\/[^\s)]+/i);
    if (explicitUrlMatch) {
      const explicitUrl = String(explicitUrlMatch[0]).trim();
      return {
        summary: `Open ${explicitUrl}`,
        actions: [
          buildOwnedBrowserLaunchAction(
            explicitUrl,
            `Open the provided website and begin the requested task at ${explicitUrl}.`,
          ),
        ],
        plannerDone: false,
        teamBriefs: [],
        controller: 'interactive-browser',
      };
    }

    const homepageUrl = task.domain ? `https://${task.domain.replace(/^www\./, '')}` : '';
    if (homepageUrl) {
      return {
        summary: `Inspect ${homepageUrl}`,
        actions: [normalizeAction({
          owner: 'research',
          tool: 'web_scrape',
          intent: `Inspect the first-party homepage for ${task.domain} to discover the correct interactive entry point.`,
          exact_args: { url: homepageUrl, max_length: 5000 },
          expected_diff: `Homepage structure and first-party links are available for routing the browser task on ${task.domain}.`,
          rollback_plan: 'No rollback needed. Read-only inspection.',
          risk_level: 'low',
        })],
        plannerDone: false,
        teamBriefs: [],
        controller: 'interactive-browser',
      };
    }

    return null;
  }

  const currentUrl = String(latestBrowserState.pageUrl || '');
  const currentUrlLower = currentUrl.toLowerCase();
  const screen = classifyBrowserScreen({ output: latestOutput, currentUrl, task });
  const onWebmailFlow = isWebmailFlowActive(currentUrl, webmailUrl, webmailProvider);
  if (onWebmailFlow) {
    return null;
  }
  const pageLinks = extractObservedLinksFromBrowserOutput(latestOutput, currentUrl);
  const pageHasEmail = /\bemail\b/i.test(latestOutput);
  const pageHasPassword = /\bpassword\b/i.test(latestOutput);
  const pageHasCreateAccount = /\b(create account|sign up with email|join kombom|sign up)\b/i.test(latestOutput);
  const pageHasLoginSubmit = /\b(log in|login|sign in|signin)\b/i.test(latestOutput);
  const hasDownloadedArtifact = Boolean(latestBrowserState.downloadPath);
  const checkoutActionText = selectVisibleBrowserActionText(latestOutput, [
    'Continue to Checkout',
    'Checkout',
    'Continue',
    'Pay Now',
    'Place Order',
    'Submit Order',
  ]);
  const bookingActionText = selectVisibleBrowserActionText(latestOutput, [
    'Book Now',
    'Reserve',
    'Schedule',
    'Continue',
    'Next',
    'Confirm Booking',
  ]);
  const onboardingActionText = selectVisibleBrowserActionText(latestOutput, [
    'Get Started',
    'Continue',
    'Next',
    'Finish',
    'Done',
    'Skip',
  ]);
  const exportActionText = selectVisibleBrowserActionText(latestOutput, [
    'Export CSV',
    'Download CSV',
    'Export PDF',
    'Download PDF',
    'Export',
    'Download',
  ]);

  const preferredObservedLink = sortObservedLinks(pageLinks, objective, controllerSpec)[0];
  const taskLabel = inferInteractiveTaskLabel(task);
  const controllerPlaybookSteps = normalizeControllerPlaybookSteps(controllerSpec?.playbook);
  const executedPlaybookSteps = extractControllerPlaybookSteps(priorResults);
  const nextPlaybookStep = findNextPlaybookStep(controllerPlaybookSteps, executedPlaybookSteps);
  const recentBrowserUrls = [...priorResults]
    .filter((result) => result && result.ok === true && ['browser_launch', 'browser_action'].includes(String(result.tool || '')))
    .map((result) => String(result?.metadata?.pageUrl || result?.metadata?.url || '').trim())
    .filter(Boolean)
    .slice(-4);
  const signupLikeUrl = (value) => /\/signup\b|\/register\b|\/create-account\b/i.test(String(value || ''));
  const loginLikeUrl = (value) => /\/login\b|\/signin\b/i.test(String(value || ''));
  const bouncedBetweenAuthPages = recentBrowserUrls.length >= 2 && (
    recentBrowserUrls.some(signupLikeUrl) && recentBrowserUrls.some(loginLikeUrl)
  );
  const onSignupForm = task.signupIntent && screen.type === 'auth_signup';
  const onLoginForm = task.loginIntent && screen.type === 'auth_login';
  const recentSignupSubmit = onSignupForm && recentBrowserActionMatches(priorResults, (result) => {
    const action = String(result?.metadata?.action || '').trim().toLowerCase();
    const intent = String(result.intent || '').trim().toLowerCase();
    return (action === 'click' && intent.includes('submit the signup form')) || (action === 'wait_for' && intent.includes('post-signup'));
  }, 4);
  const recentSignupSubmitFailures = onSignupForm ? recentBrowserActionFailures(priorResults, (result) => {
    const output = String(result.output || '').toLowerCase();
    const intent = String(result.intent || '').trim().toLowerCase();
    return intent.includes('submit the signup form') || output.includes('create account');
  }, 5) : [];
  const recentLoginSubmit = onLoginForm && recentBrowserActionMatches(priorResults, (result) => {
    const action = String(result?.metadata?.action || '').trim().toLowerCase();
    const intent = String(result.intent || '').trim().toLowerCase();
    return (action === 'click' && intent.includes('submit the login form')) || (action === 'wait_for' && intent.includes('post-login'));
  }, 4);
  const recentLoginSubmitFailures = onLoginForm ? recentBrowserActionFailures(priorResults, (result) => {
    const output = String(result.output || '').toLowerCase();
    const intent = String(result.intent || '').trim().toLowerCase();
    return intent.includes('submit the login form') || output.includes("sign in'") || output.includes('log in');
  }, 5) : [];

  if (nextPlaybookStep && isPlaybookStepApplicable(nextPlaybookStep, latestOutput, currentUrl)) {
    const playbookPlan = buildPlanFromPlaybookStep(nextPlaybookStep, { webIdentity });
    if (playbookPlan) {
      return playbookPlan;
    }
  }

  if (onSignupForm) {
    if (recentSignupSubmitFailures.length > 0) {
      return {
        ...buildAdaptiveSubmitRecoveryPlan({
          summary: 'Try an alternate signup submission approach',
          inspectIntent: 'Inspect the signup page alert or validation state before trying a different submission approach.',
          buttonText: 'Create Account',
          postClickIntent: 'Wait for the post-signup page state to appear after the alternate submit interaction.',
          postClickExpectedDiff: 'The signup form is submitted and the next state is visible.',
        }),
        controller: 'interactive-browser',
      };
    }
    if (recentSignupSubmit) {
      return {
        summary: 'Inspect signup validation state',
        actions: [buildBrowserActionStep(
          'Inspect the signup page alert or validation state before retrying submission.',
          { action: 'aria_snapshot', target: { role: 'alert' } },
          'Any signup validation error is visible for the next step.',
          'low',
        )],
        plannerDone: false,
        teamBriefs: [],
        controller: 'interactive-browser',
      };
    }
    const actions = [];
    maybeAddIdentityFieldActions(actions, latestOutput, webIdentity, {
      includeEmail: false,
      nameTargets: ['Full name', 'Name'],
      phoneTargets: ['Phone', 'Phone number', 'Mobile number'],
      birthTargets: ['Birthday', 'Birth date', 'Date of birth'],
    });
    if (webIdentity.email) {
      actions.push(normalizeAction({
        owner: 'research',
        tool: 'browser_action',
        intent: 'Enter the agent email address into the signup form.',
        exact_args: {
          action: 'fill',
          target: { label: 'Email' },
          text: webIdentity.email,
        },
        expected_diff: 'The signup email field is populated.',
        rollback_plan: 'Clear and retype if the wrong email was entered.',
        risk_level: 'medium',
      }));
    }
    if (webIdentity.emailPassword) {
      actions.push(normalizeAction({
        owner: 'research',
        tool: 'browser_action',
        intent: 'Enter the stored agent password into the signup form.',
        exact_args: {
          action: 'fill',
          target: { label: 'Password' },
          text: webIdentity.emailPassword,
        },
        expected_diff: 'The signup password field is populated.',
        rollback_plan: 'Clear and retype if the wrong password was entered.',
        risk_level: 'medium',
      }));
    }
    if (pageHasCreateAccount) {
      actions.push(normalizeAction({
        owner: 'research',
        tool: 'browser_action',
        intent: 'Submit the signup form.',
        exact_args: {
          action: 'click',
          target: { role: 'button', text: 'Create Account' },
        },
        expected_diff: 'The signup form is submitted and the next state is visible.',
        rollback_plan: 'Navigate back to retry if submission fails.',
        risk_level: 'medium',
      }));
      actions.push(normalizeAction({
        owner: 'research',
        tool: 'browser_action',
        intent: 'Wait briefly for the post-signup page state to appear.',
        exact_args: {
          action: 'wait_for',
          condition: { ms: 1500 },
        },
        expected_diff: 'The browser settles after signup submission.',
        rollback_plan: 'No rollback needed.',
        risk_level: 'low',
      }));
    }
    if (actions.length > 0) {
      return {
        summary: 'Progress the signup form',
        actions,
        plannerDone: false,
        teamBriefs: [],
        controller: 'interactive-browser',
      };
    }
  }

  if (onLoginForm) {
    if (recentLoginSubmitFailures.length > 0) {
      return {
        ...buildAdaptiveSubmitRecoveryPlan({
          summary: 'Try an alternate login submission approach',
          inspectIntent: 'Inspect the login page alert or validation state before trying a different submission approach.',
          buttonText: 'Sign In',
          postClickIntent: 'Wait for the post-login page state to appear after the alternate submit interaction.',
          postClickExpectedDiff: 'The authenticated page or next state is visible.',
        }),
        controller: 'interactive-browser',
      };
    }
    if (recentLoginSubmit) {
      return {
        summary: 'Inspect login validation state',
        actions: [buildBrowserActionStep(
          'Inspect the login page alert or validation state before retrying submission.',
          { action: 'aria_snapshot', target: { role: 'alert' } },
          'Any login validation error is visible for the next step.',
          'low',
        )],
        plannerDone: false,
        teamBriefs: [],
        controller: 'interactive-browser',
      };
    }
    const actions = [];
    maybeAddIdentityFieldActions(actions, latestOutput, webIdentity, {
      includeEmail: false,
      includeBirthDate: false,
      nameTargets: ['Full name', 'Name'],
      phoneTargets: ['Phone', 'Phone number', 'Mobile number'],
    });
    if (webIdentity.email) {
      actions.push(normalizeAction({
        owner: 'research',
        tool: 'browser_action',
        intent: 'Enter the agent email address into the login form.',
        exact_args: {
          action: 'fill',
          target: { label: 'Email' },
          text: webIdentity.email,
        },
        expected_diff: 'The login email field is populated.',
        rollback_plan: 'Clear and retype if the wrong email was entered.',
        risk_level: 'medium',
      }));
    }
    if (webIdentity.emailPassword) {
      actions.push(normalizeAction({
        owner: 'research',
        tool: 'browser_action',
        intent: 'Enter the stored agent password into the login form.',
        exact_args: {
          action: 'fill',
          target: { label: 'Password' },
          text: webIdentity.emailPassword,
        },
        expected_diff: 'The login password field is populated.',
        rollback_plan: 'Clear and retype if the wrong password was entered.',
        risk_level: 'medium',
      }));
    }
    if (pageHasLoginSubmit) {
      actions.push(normalizeAction({
        owner: 'research',
        tool: 'browser_action',
        intent: 'Submit the login form.',
        exact_args: {
          action: 'click',
          target: { role: 'button', text: 'Login' },
        },
        expected_diff: 'The login form is submitted and the next state is visible.',
        rollback_plan: 'Navigate back to retry if submission fails.',
        risk_level: 'medium',
      }));
      actions.push(normalizeAction({
        owner: 'research',
        tool: 'browser_action',
        intent: 'Wait briefly for the post-login page state to appear.',
        exact_args: {
          action: 'wait_for',
          condition: { ms: 1500 },
        },
        expected_diff: 'The browser settles after login submission.',
        rollback_plan: 'No rollback needed.',
        risk_level: 'low',
      }));
    }
    if (actions.length > 0) {
      return {
        summary: 'Progress the login form',
        actions,
        plannerDone: false,
        teamBriefs: [],
        controller: 'interactive-browser',
      };
    }
  }

  const canFollowObservedLink = Boolean(
    preferredObservedLink?.href
    && preferredObservedLink.href !== currentUrl
    && !(task.signupIntent && onSignupForm)
    && !(task.loginIntent && onLoginForm)
    && !(bouncedBetweenAuthPages && task.signupIntent && loginLikeUrl(preferredObservedLink?.href))
    && !(bouncedBetweenAuthPages && task.loginIntent && signupLikeUrl(preferredObservedLink?.href))
  );

  if ((task.signupIntent || task.loginIntent || task.checkoutIntent || task.bookingIntent || task.onboardingIntent || task.exportIntent)
      && canFollowObservedLink) {
    return {
      summary: `Move to ${preferredObservedLink.href}`,
      actions: [normalizeAction({
        owner: 'research',
        tool: 'browser_action',
        intent: `Navigate directly to the first-party ${taskLabel} page discovered from the current page.`,
        exact_args: {
          action: 'goto',
          url: preferredObservedLink.href,
        },
        expected_diff: `The browser is on ${preferredObservedLink.href}.`,
        rollback_plan: 'Navigate back if the target page is wrong.',
        risk_level: 'medium',
      })],
      plannerDone: false,
      teamBriefs: [],
      controller: 'interactive-browser',
    };
  }

  if (task.checkoutIntent && checkoutActionText) {
    const actions = [];
    maybeAddIdentityFieldActions(actions, latestOutput, webIdentity, {
      nameTargets: ['Full name', 'Name'],
      emailTargets: ['Email', 'Email address'],
    });
    actions.push(
      buildBrowserActionStep(
        `Click the next checkout action: ${checkoutActionText}.`,
        { action: 'click', target: { role: 'button', text: checkoutActionText } },
        'The checkout flow advances to the next step or completes.',
      ),
      buildBrowserActionStep(
        'Wait briefly for the next checkout state to render.',
        { action: 'wait_for', condition: { ms: 1500 } },
        'The checkout page settles after the action.',
        'low',
      ),
    );
    return {
      summary: `Progress checkout with ${checkoutActionText}`,
      actions,
      plannerDone: false,
      teamBriefs: [],
      controller: 'interactive-browser',
    };
  }

  if (task.bookingIntent && bookingActionText) {
    const actions = [];
    maybeAddIdentityFieldActions(actions, latestOutput, webIdentity, {
      nameTargets: ['Full name', 'Name'],
      emailTargets: ['Email', 'Work email', 'Email address'],
    });
    actions.push(
      buildBrowserActionStep(
        `Click the next booking action: ${bookingActionText}.`,
        { action: 'click', target: { role: 'button', text: bookingActionText } },
        'The booking flow advances to the next step or confirmation state.',
      ),
      buildBrowserActionStep(
        'Wait briefly for the next booking state to render.',
        { action: 'wait_for', condition: { ms: 1500 } },
        'The booking page settles after the action.',
        'low',
      ),
    );
    return {
      summary: `Progress booking with ${bookingActionText}`,
      actions,
      plannerDone: false,
      teamBriefs: [],
      controller: 'interactive-browser',
    };
  }

  if (task.onboardingIntent && onboardingActionText) {
    return {
      summary: `Progress onboarding with ${onboardingActionText}`,
      actions: [
        buildBrowserActionStep(
          `Click the next onboarding action: ${onboardingActionText}.`,
          { action: 'click', target: { role: 'button', text: onboardingActionText } },
          'The onboarding flow advances to the next step or completes.',
        ),
        buildBrowserActionStep(
          'Wait briefly for the onboarding page to update.',
          { action: 'wait_for', condition: { ms: 1200 } },
          'The onboarding flow has time to render its next step.',
          'low',
        ),
      ],
      plannerDone: false,
      teamBriefs: [],
      controller: 'interactive-browser',
    };
  }

  if (task.exportIntent && hasDownloadedArtifact) {
    return {
      summary: 'Export completed',
      actions: [],
      plannerDone: true,
      teamBriefs: [],
      controller: 'interactive-browser',
    };
  }

  if (task.exportIntent && exportActionText) {
    return {
      summary: `Trigger export with ${exportActionText}`,
      actions: [
        buildBrowserActionStep(
          `Click the export or download action: ${exportActionText}.`,
          { action: 'click', target: { role: 'button', text: exportActionText } },
          'The export or download action is triggered.',
        ),
        buildBrowserActionStep(
          'Wait briefly for the export action to start.',
          { action: 'wait_for', condition: { ms: 1200 } },
          'The page has time to start the export or reveal the download state.',
          'low',
        ),
      ],
      plannerDone: false,
      teamBriefs: [],
      controller: 'interactive-browser',
    };
  }

  if (latestBrowserState.pageUrl) {
    return {
      summary: 'Re-observe the current browser state',
      actions: [normalizeAction({
        owner: 'research',
        tool: 'browser_action',
        intent: 'Refresh the accessibility tree to decide the next concrete browser step from the current page.',
        exact_args: {
          action: 'aria_snapshot',
        },
        expected_diff: 'A fresh structured view of the current page is available.',
        rollback_plan: 'No rollback needed.',
        risk_level: 'low',
      })],
      plannerDone: false,
      teamBriefs: [],
      controller: 'interactive-browser',
    };
  }

  return null;
}

const INTERACTIVE_BROWSER_CONTROLLER_BUILDERS = [
  buildEmailVerificationControllerPlan,
  buildAccountTaskControllerPlan,
];

function buildInteractiveBrowserPlan(args = {}) {
  const task = detectInteractiveBrowserTask(args.objective, args.threadContext);
  if (!task.enabled) return null;

  const webIdentity = ensureObject(args.settings?.webIdentity || {});
  const controllerSpecs = loadBrowserControllerSpecsSync(args.workspaceRoot || '');
  const controllerSpec = pickMatchingBrowserControllerSpec(controllerSpecs, {
    objective: task.objectiveText,
    domain: task.domain,
  });
  const latestBrowserResult = latestSuccessfulResult(
    args.priorResults,
    (result) => ['browser_launch', 'browser_action'].includes(String(result.tool || ''))
      && extractBrowserStateFromMetadata(result.metadata),
  );
  const latestBrowserState = latestBrowserResult ? extractBrowserStateFromMetadata(latestBrowserResult.metadata) : null;
  const latestOutput = String(latestBrowserResult?.output || '');

  for (const builder of INTERACTIVE_BROWSER_CONTROLLER_BUILDERS) {
    const plan = builder({
      ...args,
      task,
      webIdentity,
      controllerSpec,
      latestBrowserResult,
      latestBrowserState,
      latestOutput,
    });
    if (plan) return plan;
  }
  return null;
}

function inferBrowserRecoveryActions(objective, threadContext = '', priorResults = []) {
  const text = `${String(objective || '')}\n${String(threadContext || '')}`;
  const lower = text.toLowerCase();
  const hasBrowserIntent = objectiveImpliesSignup(text)
    || objectiveImpliesLogin(text)
    || /\b(account|website|browser|web|form|email|verification|verify)\b/i.test(text);
  if (!hasBrowserIntent) {
    return [];
  }

  const canonicalUrl = extractCanonicalBrowserUrl(text, priorResults);
  if (canonicalUrl) {
    return [normalizeAction({
      owner: 'research',
      tool: 'browser_launch',
      intent: `Open the first-party URL already discovered for this browser task: ${canonicalUrl}.`,
      exact_args: {
        url: canonicalUrl,
        session_mode: 'owned',
        prefer_extension: false,
        headless: false,
      },
      expected_diff: `A controlled browser session is opened at ${canonicalUrl}.`,
      rollback_plan: 'Close the browser session if navigation is wrong.',
      risk_level: 'medium',
    })];
  }

  const latestSearch = [...(Array.isArray(priorResults) ? priorResults : [])]
    .reverse()
    .find((result) => result && result.ok === true && String(result.tool || '') === 'web_search');
  const recoveredUrl = extractFirstUrlFromSearchOutput(latestSearch?.output || '');
  if (recoveredUrl) {
    return [normalizeAction({
      owner: 'research',
      tool: 'browser_launch',
      intent: `Open the best candidate URL already found for this browser task: ${recoveredUrl}.`,
      exact_args: {
        url: recoveredUrl,
        session_mode: 'owned',
        prefer_extension: false,
        headless: false,
      },
      expected_diff: `A live browser session is opened at ${recoveredUrl}.`,
      rollback_plan: 'Close the browser session if the site is irrelevant.',
      risk_level: 'medium',
    })];
  }

  const explicitUrlMatch = text.match(/https?:\/\/[^\s)]+/i);
  if (explicitUrlMatch) {
    const url = String(explicitUrlMatch[0]).trim();
    return [normalizeAction({
      owner: 'research',
      tool: 'browser_launch',
      intent: `Open the provided website and begin the requested browser task at ${url}.`,
      exact_args: {
        url,
        session_mode: 'owned',
        prefer_extension: false,
        headless: false,
      },
      expected_diff: `A live browser session is opened at ${url}.`,
      rollback_plan: 'Close the browser session if navigation is wrong.',
      risk_level: 'medium',
    })];
  }

  const domainMatch = text.match(/\b([a-z0-9-]+\.[a-z]{2,})\b/i);
  const siteLabel = domainMatch ? String(domainMatch[1]).toLowerCase() : 'the requested site';
  const query = objectiveImpliesSignup(text)
    ? `${siteLabel} sign up`
    : objectiveImpliesLogin(text)
      ? `${siteLabel} login`
      : `${siteLabel} official website`;

  return [normalizeAction({
    owner: 'research',
    tool: 'web_search',
    intent: `Find the real ${objectiveImpliesLogin(text) ? 'login' : 'signup'} URL for ${siteLabel}.`,
    exact_args: {
      query,
      count: 5,
    },
    expected_diff: 'Search results identify the exact destination URL needed for the browser task.',
    rollback_plan: 'No rollback needed. Read-only web lookup.',
    risk_level: 'low',
  })];
}

function applyObjectivePolicyToActions(actions, objective, policy, teamMode, threadContext = '', priorResults = []) {
  const normalized = Array.isArray(actions) ? actions.map((action) => normalizeAction(action)) : [];
  const allowedOwners = allowedOwnersForPolicy(policy, teamMode);
  const anchors = extractObjectiveAnchors(objective, threadContext);
  const filtered = normalized
    .map((action) => {
      const next = { ...action };
      if (!allowedOwners.has(next.owner)) {
        next.owner = fallbackOwnerForPolicy(next, policy, teamMode);
      }
      return next;
    })
    .filter((action) => {
      if (isOutOfScopeInfraAction(action, objective)) {
        return false;
      }
      if (isDisallowedByObjectivePolicy(action, policy)) {
        return false;
      }
      const ok = actionMentionsObjectiveAnchors(action, anchors);
      if (!ok) {
        console.log("REJECTED BY ANCHORS:", require('util').inspect(action, { depth: 3 }), "Anchors:", anchors);
      }
      return ok;
    });
  if (filtered.length > 0) {
    return filtered;
  }

  const browserRecovery = inferBrowserRecoveryActions(objective, threadContext, priorResults);
  if (browserRecovery.length > 0) {
    return browserRecovery;
  }

  // Previously we returned a silent fallback to list_files, but this masked
  // the fact that the agent's actions were being filtered out and caused loops.
  // Now we return a hardcoded sentinel action that will explicitly fail.
  return [{
    tool: 'safeguard_rejected',
    owner: 'research',
    intent: 'Actions were blocked by safety or objective anchor filters.',
    exact_args: {
      reason: 'None of your proposed actions matched the objective keywords or they used disallowed tools. Ensure you use proper tools and stay on-topic.',
      anchors: anchors
    },
    risk_level: 'low',
    policy_allowed: true,
    policy_reason: 'Explicit rejection fallback to train the model.'
  }];
}

// ---------------------------------------------------------------------------
// hasVerificationAction / hasWriteAction
// ---------------------------------------------------------------------------

function hasVerificationAction(actions) {
  return actions.some((action) => {
    // run_playwright always counts as verification
    if (action.tool === 'run_playwright') return true;
    if (action.tool !== 'run_command') {
      return false;
    }
    const args = Array.isArray(action.exact_args?.args) ? action.exact_args.args.map((item) => String(item).toLowerCase()) : [];
    const joined = args.join(' ');
    const intent = String(action.intent || '').toLowerCase();
    return joined.includes('test') || joined.includes('lint') || joined.includes('build') || intent.includes('test') || intent.includes('lint');
  });
}

function hasWriteAction(actions) {
  return actions.some((action) => action.tool === 'write_file' || action.tool === 'append_file');
}

function hasBuildExecutionAction(actions) {
  const list = Array.isArray(actions) ? actions : [];
  return list.some((action) => BUILD_TOOLS.has(String(action.tool || '')));
}

function inferPreferredWorkspaceCwd(workspaceFiles = [], objective = '') {
  const files = (Array.isArray(workspaceFiles) ? workspaceFiles : [])
    .map((item) => String(item || '').trim().replace(/^\.\//, ''))
    .filter(Boolean);
  const objectiveWords = new Set(
    String(objective || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((item) => item.trim())
      .filter((item) => item.length >= 3),
  );
  const manifestCandidates = [];

  for (const relPath of files) {
    const normalized = relPath.replace(/\/$/, '');
    const base = path.basename(normalized).toLowerCase();
    if (![
      'package.json',
      'pyproject.toml',
      'requirements.txt',
      'poetry.lock',
      'uv.lock',
      'cargo.toml',
      'go.mod',
      'package.swift',
    ].includes(base)) {
      continue;
    }
    const dir = path.dirname(normalized);
    if (!dir || dir === '.') continue;
    manifestCandidates.push({ dir, base });
  }

  const scopedCandidates = manifestCandidates.filter(({ dir }) => /^(apps|packages|services|projects|clients|server|frontend|backend)\//i.test(dir));
  const candidates = (scopedCandidates.length > 0 ? scopedCandidates : manifestCandidates)
    .filter((item, index, array) => array.findIndex((other) => other.dir === item.dir) === index);
  if (candidates.length === 0) {
    return '.';
  }
  if (candidates.length === 1) {
    return candidates[0].dir;
  }

  const scored = candidates
    .map((candidate) => {
      const parts = candidate.dir.toLowerCase().split(/[\/_-]+/g).filter(Boolean);
      let score = 0;
      for (const part of parts) {
        if (objectiveWords.has(part)) score += 3;
        if (part.length >= 4) {
          for (const word of objectiveWords) {
            if (word.includes(part) || part.includes(word)) {
              score += 1;
            }
          }
        }
      }
      if (/(web|frontend|ui)/.test(candidate.dir) && /\b(web|frontend|ui|site|landing)\b/.test(String(objective || '').toLowerCase())) score += 2;
      if (/(api|server|backend)/.test(candidate.dir) && /\b(api|server|backend)\b/.test(String(objective || '').toLowerCase())) score += 2;
      return { ...candidate, score };
    })
    .sort((left, right) => right.score - left.score || left.dir.localeCompare(right.dir));

  return scored[0]?.score > 0 ? scored[0].dir : '.';
}

function detectWorkspaceBootstrapProfile(workspaceFiles = [], objective = '') {
  const files = new Set((Array.isArray(workspaceFiles) ? workspaceFiles : [])
    .map((item) => String(item || '').trim().replace(/^\.\//, ''))
    .filter(Boolean));
  const has = (name) => files.has(name) || Array.from(files).some((entry) => entry.endsWith(`/${name}`));
  const objectiveText = String(objective || '').toLowerCase();
  const preferredCwd = inferPreferredWorkspaceCwd(workspaceFiles, objective);
  const profile = {
    taskClass: inferRunTaskClass({ objective, executionMode: 'action' }),
    stack: 'generic',
    rationale: '',
    preferredCwd,
    commands: [],
  };

  if (has('pnpm-lock.yaml') || (has('package.json') && (objectiveText.includes('pnpm') || objectiveText.includes('turbo') || objectiveText.includes('monorepo')))) {
    profile.stack = 'node';
    profile.rationale = 'pnpm workspace/package detected';
    profile.commands.push({
      command: 'pnpm',
      args: has('pnpm-lock.yaml') ? ['install', '--frozen-lockfile'] : ['install'],
      cwd: preferredCwd,
      timeout_ms: 600000,
      intent: 'Bootstrap Node dependencies with pnpm before coding and QA',
      expected_diff: 'Workspace dependencies are installed and ready for build/test commands.',
    });
    return profile;
  }
  if (has('yarn.lock')) {
    profile.stack = 'node';
    profile.rationale = 'Yarn lockfile detected';
    profile.commands.push({
      command: 'yarn',
      args: ['install', '--frozen-lockfile'],
      cwd: preferredCwd,
      timeout_ms: 600000,
      intent: 'Bootstrap Node dependencies with Yarn before coding and QA',
      expected_diff: 'Workspace dependencies are installed and ready for build/test commands.',
    });
    return profile;
  }
  if (has('bun.lockb') || has('bun.lock')) {
    profile.stack = 'node';
    profile.rationale = 'Bun lockfile detected';
    profile.commands.push({
      command: 'bun',
      args: ['install'],
      cwd: preferredCwd,
      timeout_ms: 600000,
      intent: 'Bootstrap Bun dependencies before coding and QA',
      expected_diff: 'Workspace dependencies are installed and ready for build/test commands.',
    });
    return profile;
  }
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) {
    profile.stack = 'node';
    profile.rationale = 'npm lockfile detected';
    profile.commands.push({
      command: 'npm',
      args: ['ci'],
      cwd: preferredCwd,
      timeout_ms: 600000,
      intent: 'Bootstrap Node dependencies with npm ci before coding and QA',
      expected_diff: 'Workspace dependencies are installed and ready for build/test commands.',
    });
    return profile;
  }
  if (has('package.json')) {
    profile.stack = 'node';
    profile.rationale = 'package.json detected';
    profile.commands.push({
      command: 'npm',
      args: ['install'],
      cwd: preferredCwd,
      timeout_ms: 600000,
      intent: 'Bootstrap Node dependencies before coding and QA',
      expected_diff: 'Workspace dependencies are installed and ready for build/test commands.',
    });
    return profile;
  }
  if (has('uv.lock')) {
    profile.stack = 'python';
    profile.rationale = 'uv lockfile detected';
    profile.commands.push({
      command: 'uv',
      args: ['sync'],
      cwd: preferredCwd,
      timeout_ms: 600000,
      intent: 'Bootstrap Python dependencies with uv before coding and QA',
      expected_diff: 'Python environment is synchronized and ready for tests.',
    });
    return profile;
  }
  if (has('poetry.lock')) {
    profile.stack = 'python';
    profile.rationale = 'Poetry lockfile detected';
    profile.commands.push({
      command: 'poetry',
      args: ['install'],
      cwd: preferredCwd,
      timeout_ms: 600000,
      intent: 'Bootstrap Python dependencies with Poetry before coding and QA',
      expected_diff: 'Python environment is installed and ready for tests.',
    });
    return profile;
  }
  if (has('requirements.txt')) {
    profile.stack = 'python';
    profile.rationale = 'requirements.txt detected';
    profile.commands.push({
      command: 'python3',
      args: ['-m', 'pip', 'install', '-r', 'requirements.txt'],
      cwd: preferredCwd,
      timeout_ms: 600000,
      intent: 'Bootstrap Python dependencies from requirements.txt before coding and QA',
      expected_diff: 'Python environment is installed and ready for tests.',
    });
    return profile;
  }
  if (has('pyproject.toml')) {
    profile.stack = 'python';
    profile.rationale = 'pyproject.toml detected';
    profile.commands.push({
      command: 'python3',
      args: ['-m', 'pip', 'install', '-e', '.'],
      cwd: preferredCwd,
      timeout_ms: 600000,
      intent: 'Bootstrap the Python project in editable mode before coding and QA',
      expected_diff: 'Python environment is installed and ready for tests.',
    });
    return profile;
  }
  if (has('Cargo.toml')) {
    profile.stack = 'rust';
    profile.rationale = 'Cargo.toml detected';
    profile.commands.push({
      command: 'cargo',
      args: ['fetch'],
      cwd: preferredCwd,
      timeout_ms: 600000,
      intent: 'Bootstrap Rust dependencies before coding and QA',
      expected_diff: 'Cargo dependencies are downloaded and ready for build/test commands.',
    });
    return profile;
  }
  if (has('go.mod')) {
    profile.stack = 'go';
    profile.rationale = 'go.mod detected';
    profile.commands.push({
      command: 'go',
      args: ['mod', 'download'],
      cwd: preferredCwd,
      timeout_ms: 600000,
      intent: 'Bootstrap Go dependencies before coding and QA',
      expected_diff: 'Go module dependencies are downloaded and ready for tests.',
    });
    return profile;
  }
  if (has('Package.swift')) {
    profile.stack = 'swift';
    profile.rationale = 'Swift package manifest detected';
    profile.commands.push({
      command: 'swift',
      args: ['package', 'resolve'],
      cwd: preferredCwd,
      timeout_ms: 600000,
      intent: 'Bootstrap Swift package dependencies before coding and QA',
      expected_diff: 'Swift package dependencies are resolved and ready for build/test commands.',
    });
    return profile;
  }

  return profile;
}

function commandLooksLikeBootstrap(command = '', args = []) {
  const cmd = String(command || '').trim().toLowerCase();
  const joinedArgs = Array.isArray(args) ? args.map((item) => String(item || '').toLowerCase()).join(' ') : '';
  const haystack = `${cmd} ${joinedArgs}`.trim();
  return (
    haystack.includes('npm install')
    || haystack.includes('npm ci')
    || haystack.includes('pnpm install')
    || haystack.includes('yarn install')
    || haystack.includes('bun install')
    || haystack.includes('pip install')
    || haystack.includes('uv sync')
    || haystack.includes('poetry install')
    || haystack.includes('cargo fetch')
    || haystack.includes('go mod download')
    || haystack.includes('swift package resolve')
  );
}

function hasBootstrapAction(actions = []) {
  return (Array.isArray(actions) ? actions : []).some((action) => {
    if (String(action.tool || '') !== 'run_command') return false;
    const exactArgs = ensureObject(action.exact_args);
    return commandLooksLikeBootstrap(exactArgs.command, exactArgs.args);
  });
}

function inferBootstrapActions(actions, workspaceFiles = [], objectivePolicy = null, objective = '') {
  if (objectivePolicy && (objectivePolicy.researchOnly || objectivePolicy.noBuild)) {
    return [];
  }
  const profile = detectWorkspaceBootstrapProfile(workspaceFiles, objective);
  if (profile.taskClass !== 'build' || profile.commands.length === 0) {
    return [];
  }
  const actionList = Array.isArray(actions) ? actions : [];
  if (hasBootstrapAction(actionList)) {
    return [];
  }
  const alreadyRunsCommands = actionList.some((action) => String(action.tool || '') === 'run_command');
  const alreadyWritesFiles = hasWriteAction(actionList) || hasBuildExecutionAction(actionList);
  if (!alreadyRunsCommands && !alreadyWritesFiles) {
    return [];
  }
  return profile.commands.slice(0, 1).map((commandSpec) => normalizeAction({
    owner: 'engineering',
    intent: commandSpec.intent,
    tool: 'run_command',
    exact_args: {
      command: commandSpec.command,
      args: commandSpec.args,
      cwd: commandSpec.cwd,
      timeout_ms: commandSpec.timeout_ms,
    },
    expected_diff: commandSpec.expected_diff,
    rollback_plan: 'No rollback needed. This bootstraps the local environment.',
    risk_level: 'low',
  }));
}

function injectBootstrapActionsIfNeeded(actions, workspaceFiles = [], objectivePolicy = null, objective = '') {
  const bootstrapActions = inferBootstrapActions(actions, workspaceFiles, objectivePolicy, objective);
  if (bootstrapActions.length === 0) {
    return Array.isArray(actions) ? actions : [];
  }
  return [...bootstrapActions, ...(Array.isArray(actions) ? actions : [])];
}

function buildBootstrapGuidance(workspaceFiles = [], objective = '') {
  const profile = detectWorkspaceBootstrapProfile(workspaceFiles, objective);
  if (profile.taskClass !== 'build' || profile.commands.length === 0) {
    return '';
  }
  const commandHint = profile.commands[0];
  const commandText = [commandHint.command, ...(Array.isArray(commandHint.args) ? commandHint.args : [])].join(' ');
  return [
    'BOOTSTRAP CONTRACT:',
    `- Detected stack: ${profile.stack} (${profile.rationale}).`,
    `- Preferred working directory: ${profile.preferredCwd || '.'}`,
    profile.preferredCwd && profile.preferredCwd !== '.'
      ? '- This looks like a multi-project workspace. Prefer commands and edits inside the targeted subproject unless the objective clearly requires repo-root changes.'
      : '- Use repo root commands only when the workspace does not indicate a more specific app/package target.',
    `- Before running tests/builds, bootstrap the workspace with: ${commandText}${commandHint.cwd && commandHint.cwd !== '.' ? ` (run inside ${commandHint.cwd})` : ''}`,
    '- Treat dependency/environment setup as first-class work, not an optional cleanup step.',
    '- Do not claim completion until the workspace has been bootstrapped and verification commands run successfully.',
  ].join('\n');
}

function inferKickoffBuildActions(objective, workspaceFiles = []) {
  const lower = String(objective || '').toLowerCase();
  const files = (Array.isArray(workspaceFiles) ? workspaceFiles : []).map((item) => String(item).toLowerCase());
  const hasManifest = files.some((item) => item.endsWith('manifest.json'));
  const hasPopupHtml = files.some((item) => item.endsWith('popup.html'));
  const actions = [];

  if ((lower.includes('chrome') || lower.includes('browser')) && (lower.includes('extension') || lower.includes('plugin'))) {
    if (!hasManifest) {
      actions.push(normalizeAction({
        owner: 'engineering',
        intent: 'Kickoff build: create a valid Chrome extension manifest so implementation can begin immediately.',
        tool: 'write_file',
        exact_args: {
          path: 'manifest.json',
          content: JSON.stringify({
            manifest_version: 3,
            name: 'Geepus Extension',
            version: '0.1.0',
            description: 'Productivity helper extension',
            action: { default_popup: 'popup.html' },
            permissions: ['storage'],
            host_permissions: ['<all_urls>'],
          }, null, 2),
        },
        expected_diff: 'Creates a valid extension entry-point manifest.',
        rollback_plan: 'Delete manifest.json if objective changes.',
        risk_level: 'low',
      }));
    }
    if (!hasPopupHtml) {
      actions.push(normalizeAction({
        owner: 'design',
        intent: 'Kickoff build: create popup shell for the extension UI.',
        tool: 'write_file',
        exact_args: {
          path: 'popup.html',
          content: '<!doctype html>\n<html><head><meta charset="utf-8"><title>Extension</title></head><body><main id="app">Loading...</main><script src="popup.js"></script></body></html>\n',
        },
        expected_diff: 'Creates a tangible UI surface to iterate on immediately.',
        rollback_plan: 'Delete popup.html if objective changes.',
        risk_level: 'low',
      }));
    }
    return actions.slice(0, 2);
  }

  if (lower.includes('web') || lower.includes('website') || lower.includes('landing page') || lower.includes('frontend')) {
    const hasIndex = files.some((item) => item.endsWith('index.html'));
    if (!hasIndex) {
      actions.push(normalizeAction({
        owner: 'engineering',
        intent: 'Kickoff build: create base index.html so implementation starts this iteration.',
        tool: 'write_file',
        exact_args: {
          path: 'index.html',
          content: '<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App</title></head><body><main id="app"></main><script src="app.js"></script></body></html>\n',
        },
        expected_diff: 'Creates concrete starting point for the web objective.',
        rollback_plan: 'Delete index.html if objective changes.',
        risk_level: 'low',
      }));
    }
    return actions.slice(0, 1);
  }

  return [];
}

const REFINEMENT_HINTS = [
  'iterate', 'iteration', 'refine', 'tweak', 'adjust', 'improve', 'update',
  'small change', 'small fix', 'minor', 'polish', 'align', 'fix this', 'keep everything else',
];

const IMAGE_NOUNS = [
  'image', 'images', 'photo', 'photos', 'picture', 'pictures', 'wallpaper', 'gallery',
];

const FETCH_HINTS = ['find', 'search', 'get', 'download', 'fetch', 'collect', 'source', 'pick'];

const TOPIC_STOPWORDS = new Set([
  'find', 'search', 'get', 'download', 'fetch', 'collect', 'source', 'pick',
  'image', 'images', 'photo', 'photos', 'picture', 'pictures', 'wallpaper', 'gallery',
  'for', 'with', 'from', 'into', 'that', 'this', 'these', 'those', 'your', 'my',
  'and', 'the', 'a', 'an', 'some', 'few', 'best', 'good', 'nice', 'high', 'quality',
  'please', 'need', 'want', 'me', 'to', 'of', 'in', 'on', 'at', 'by', 'is', 'are',
]);

function inferImageTaskMeta(objective, contextText = '') {
  const text = `${String(objective || '')}\n${String(contextText || '')}`.toLowerCase();
  const hasImageNoun = IMAGE_NOUNS.some((token) => text.includes(token));
  const hasFetchIntent = FETCH_HINTS.some((token) => text.includes(token));
  const hasRelevanceIntent = /\b(relevant|relevance|align|match|theme|topical|appropriate|fits)\b/i.test(text);
  const descriptorMatches = Array.from(text.matchAll(/([a-z0-9][a-z0-9\s-]{0,40})\s+(?:images?|photos?|pictures?|wallpapers?)/gi))
    .map((match) => String(match[1] || '').trim())
    .filter(Boolean);
  const descriptorKeywords = descriptorMatches
    .flatMap((segment) => segment.split(/[^a-z0-9]+/g))
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .filter((token) => !TOPIC_STOPWORDS.has(token));
  const isImageSelectionTask = hasImageNoun && (hasFetchIntent || hasRelevanceIntent || descriptorKeywords.length > 0);
  if (!isImageSelectionTask) {
    return { isImageSelectionTask: false, requestedCount: 0, topicKeywords: [] };
  }

  let requestedCount = 0;
  const countMatch = text.match(/\b(\d{1,2})\s+(?:images?|photos?|pictures?)\b/);
  if (countMatch) {
    requestedCount = Math.max(0, Math.min(20, Number(countMatch[1]) || 0));
  }

  const topicKeywords = [...descriptorKeywords, ...text
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .filter((token) => !TOPIC_STOPWORDS.has(token))
  ]
    .filter((token, index, array) => array.indexOf(token) === index)
    .slice(0, 8);

  return {
    isImageSelectionTask: true,
    requestedCount,
    topicKeywords,
  };
}

function buildImageQualityNotes(objective, contextText = '') {
  const meta = inferImageTaskMeta(objective, contextText);
  if (!meta.isImageSelectionTask) {
    return '';
  }
  const topicText = meta.topicKeywords.length > 0
    ? meta.topicKeywords.join(', ')
    : 'the requested theme';
  const countText = meta.requestedCount > 0
    ? `Validate at least ${Math.min(meta.requestedCount, 8)} candidate image(s) with analyze_image before finalizing.`
    : 'Validate each selected image with analyze_image before finalizing.';
  return [
    'IMAGE RELEVANCE GUARD:',
    `- The image topic is: ${topicText}.`,
    '- Off-topic images are failures. Replace any image that does not clearly match the requested theme.',
    `- ${countText}`,
    '- done=true is only valid when the selected images are topically relevant.',
  ].join('\n');
}

function buildObjectiveContractNotes(objective, threadContext = '', executionMode = 'action', policy = null) {
  const anchors = extractObjectiveAnchors(objective, threadContext, 14);
  const referential = /\b(this|that|it|same)\s+(project|task|app|issue|one)\b/i.test(String(objective || ''));
  const mode = String(executionMode || 'action').toLowerCase();
  const lines = [
    'OBJECTIVE CONTRACT:',
    `- Primary objective: ${truncate(String(objective || ''), 220)}`,
    `- Active mode: ${mode}.`,
  ];
  if (anchors.length > 0) {
    lines.push(`- Scope anchors (stay focused on these): ${anchors.join(', ')}.`);
  }
  if (referential) {
    lines.push('- Objective contains referential language ("this project"/"it"). Use thread context to resolve meaning; do not start unrelated work.');
  }
  if (policy && (policy.researchOnly || policy.noBuild || mode === 'research')) {
    lines.push('- Research contract: produce findings/report artifacts only. No coding or infrastructure changes.');
  }
  lines.push('- If an action does not clearly advance this objective, skip it and choose a narrower in-scope action.');
  return lines.join('\n');
}

function collectPreviouslyTouchedFiles(results, limit = 12) {
  const items = Array.isArray(results) ? results : [];
  const touched = [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const relPath = String(items[i]?.metadata?.path || '').trim();
    if (!relPath) continue;
    if (!touched.includes(relPath)) {
      touched.push(relPath);
    }
    if (touched.length >= limit) break;
  }
  return touched.reverse();
}

function detectRefinementIntent(objective, threadContext = '', priorIterationCount = 0) {
  const objectiveText = String(objective || '').toLowerCase();
  const contextText = String(threadContext || '').toLowerCase();
  const hasRefinementHint = REFINEMENT_HINTS.some((token) => objectiveText.includes(token) || contextText.includes(token));
  if (hasRefinementHint) return true;
  return priorIterationCount > 0 && (
    objectiveText.includes('same task')
    || objectiveText.includes('continue')
    || objectiveText.includes('keep')
    || objectiveText.includes('improve')
  );
}

function detectSmallChangeIntent(objective, threadContext = '') {
  const text = `${String(objective || '')}\n${String(threadContext || '')}`.toLowerCase();
  const words = text.split(/\s+/g).filter(Boolean).length;
  const smallSignals = [
    'simple change', 'small change', 'minor change', 'minor update', 'tweak',
    'adjust', 'iterate', 'iteration', 'refine', 'polish', 'keep everything else',
    "don't rebuild", 'dont rebuild', 'just change', 'only change',
    'simple fix', 'quick fix',
  ];
  const broadBuildSignals = [
    'from scratch', 'new project', 'new app', 'full rewrite', 'rewrite everything',
    'rebuild entire', 'start over', 'scaffold', 'create-vite', 'create-react-app',
  ];
  const hasSmallSignal = smallSignals.some((token) => text.includes(token));
  const hasBroadBuild = broadBuildSignals.some((token) => text.includes(token));
  const hasEditVerb = /\b(change|update|fix|adjust|improve|polish|refine|iterate)\b/.test(text);
  return (hasSmallSignal || (hasEditVerb && words <= 90)) && !hasBroadBuild;
}

function objectiveLooksLikeBuildRequest(objective) {
  const text = String(objective || '').toLowerCase();
  const buildVerbs = ['build', 'create', 'implement', 'develop', 'code', 'ship', 'complete', 'fix'];
  const buildTargets = [
    'extension', 'plugin', 'app', 'application', 'website', 'web app', 'landing page',
    'tool', 'script', 'feature', 'mvp', 'prototype',
  ];
  const hasVerb = buildVerbs.some((token) => text.includes(token));
  const hasTarget = buildTargets.some((token) => text.includes(token));
  return hasVerb && hasTarget;
}

function buildObjectiveGuards({
  objective,
  threadContext = '',
  executionMode = 'action',
  objectivePolicy = null,
  runIsRefinement = false,
}) {
  const mode = String(executionMode || 'action').toLowerCase();
  const policy = objectivePolicy || {};
  const smallChange = (
    mode !== 'research'
    && !policy.researchOnly
    && !policy.noBuild
    && (runIsRefinement || detectSmallChangeIntent(objective, threadContext))
  )
    ? {
      enabled: true,
      maxTouchedFiles: 4,
      maxNewFiles: 1,
      requirePatchForExisting: true,
      forbidScaffoldCommands: true,
    }
    : {
      enabled: false,
    };
  return { smallChange };
}

function buildSmallChangeGuardNotes(objectiveGuards) {
  const guard = ensureObject(objectiveGuards?.smallChange);
  if (!guard.enabled) {
    return '';
  }
  return [
    'SMALL-CHANGE GUARD (hard rule):',
    '- This objective is an incremental update, not a rebuild.',
    '- Use patch_file for existing files. Avoid full write_file rewrites of existing files.',
    `- Touch at most ${guard.maxTouchedFiles || 4} file(s) and create at most ${guard.maxNewFiles || 1} new file(s) this iteration.`,
    '- Do NOT scaffold, re-init, or generate a new project structure.',
  ].join('\n');
}

function detectRestartBehavior(iterationResults) {
  const results = Array.isArray(iterationResults) ? iterationResults : [];
  const restartSignals = [];

  for (const result of results) {
    if (!result || !result.ok) continue;
    const tool = String(result.tool || '').trim();
    if (tool === 'write_file') {
      const isNew = Boolean(result?.metadata?.createdNewFile);
      const filePath = String(result?.metadata?.path || '');
      if (isNew && (filePath === 'package.json' || filePath.endsWith('/package.json'))) {
        restartSignals.push(`created ${filePath}`);
      }
      continue;
    }
    if (tool !== 'run_command') continue;
    const command = String(result?.metadata?.command || '').toLowerCase();
    const args = Array.isArray(result?.metadata?.args)
      ? result.metadata.args.map((item) => String(item).toLowerCase())
      : [];
    const joined = `${command} ${args.join(' ')}`;
    if (
      (command === 'npm' && args.includes('init'))
      || (command === 'git' && (args[0] === 'clone' || args[0] === 'init'))
      || (command === 'npx' && args.some((arg) => arg.includes('create-') || arg === 'create'))
      || joined.includes('create-vite')
      || joined.includes('create-next-app')
      || joined.includes('create-react-app')
      || joined.includes('flutter create')
    ) {
      restartSignals.push(`ran ${command} ${args.slice(0, 3).join(' ')}`.trim());
    }
  }

  return {
    restartDetected: restartSignals.length > 0,
    restartSignals,
  };
}

function extractImageOutputPathsFromActions(actions) {
  const imagePaths = [];
  const pushPath = (rawPath) => {
    const value = String(rawPath || '').trim().replace(/^['"]|['"]$/g, '');
    if (!value) return;
    if (!/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(value)) return;
    if (!imagePaths.includes(value)) {
      imagePaths.push(value);
    }
  };

  for (const action of (Array.isArray(actions) ? actions : [])) {
    if (!action || String(action.tool || '') !== 'run_command') continue;
    const args = ensureObject(action.exact_args || {});
    const command = String(args.command || '').toLowerCase();
    const cmdArgs = Array.isArray(args.args) ? args.args.map((item) => String(item)) : [];

    if (command === 'curl' || command === 'wget') {
      for (let i = 0; i < cmdArgs.length; i += 1) {
        const token = cmdArgs[i];
        if ((token === '-o' || token === '--output') && cmdArgs[i + 1]) {
          pushPath(cmdArgs[i + 1]);
          i += 1;
        }
      }
      continue;
    }

    if (command === 'bash' && cmdArgs[0] === '-c' && cmdArgs[1]) {
      const script = String(cmdArgs[1]);
      const regex = /(?:^|\s)(?:curl|wget)[^;\n]*?(?:-o|--output)\s+["']?([^"'\s;]+)/gi;
      let match = regex.exec(script);
      while (match) {
        pushPath(match[1]);
        match = regex.exec(script);
      }
    }
  }

  return imagePaths;
}

// ---------------------------------------------------------------------------
// extractSkillVerification / recommendQualityCommands / injectQualityActionIfNeeded
// ---------------------------------------------------------------------------

/**
 * Parse the verification strategy from a SKILL.md file.
 *
 * Reads the "## Verification Steps" section (also accepts "## Completion Criteria"
 * or "## Acceptance Criteria") and looks for a [strategy: xxx] tag.
 *
 * Supported strategies:
 *   web            → python3 http.server + run_playwright + consoleErrorCount: 0
 *   build-and-test → run build/test command; check "BUILD SUCCEEDED / TEST SUCCEEDED"
 *   run-output     → run the main script; check stdout matches expected
 *   file-verify    → verify output file(s) exist with content (documents, PDFs, etc.)
 *   general        → agent determines verification from context; system enforces minimal evidence
 *
 * @returns {{ strategy: string|null, commandHints: string[], successSignals: string[], sectionText: string }}
 */
function extractSkillVerification(skillContent) {
  if (!skillContent) return { strategy: null, commandHints: [], successSignals: [], sectionText: '' };

  // Priority order: Verification Steps > Acceptance Criteria > Completion Criteria
  // Completion Criteria always comes before Verification Steps in SKILL.md files, so we
  // must prefer Verification Steps explicitly — do not combine into one alternation.
  const headerPatterns = [
    /^##\s+Verification Steps?\s*$/m,
    /^##\s+Acceptance Criteria\s*$/m,
    /^##\s+Completion Criteria\s*$/m,
  ];

  let headerMatch = null;
  for (const pattern of headerPatterns) {
    headerMatch = skillContent.match(pattern);
    if (headerMatch) break;
  }

  let sectionText = '';
  if (headerMatch) {
    // Slice from just after the matched header line to the next ## heading (or end of file)
    const afterHeader = skillContent.slice(headerMatch.index + headerMatch[0].length);
    const nextHeaderMatch = afterHeader.match(/\n##\s/);
    sectionText = (nextHeaderMatch ? afterHeader.slice(0, nextHeaderMatch.index) : afterHeader).trim();
  }

  // Extract [strategy: xxx] tag — search section first, then full skill body as fallback
  const searchArea = sectionText || skillContent;
  const strategyMatch = searchArea.match(/\[strategy:\s*([\w-]+)\]/i);
  const strategy = strategyMatch ? strategyMatch[1].toLowerCase() : null;

  // Collect backtick command hints from the section text
  const commandHints = [];
  const codePattern = /`([^`\n]{4,160})`/g;
  let m;
  while ((m = codePattern.exec(sectionText)) !== null) {
    const hint = m[1].trim();
    // Only treat as a runnable command/path if it contains a space or slash
    if ((hint.includes(' ') || hint.includes('/')) && !hint.startsWith('consoleError')) {
      commandHints.push(hint);
    }
  }

  // Collect Gate/success signal phrases from the section
  const successSignals = [];
  const gatePattern = /(?:Gate|Must contain|Success if|Confirm):?\s*["']?([^"\n]{4,120})["']?/gi;
  let gm;
  while ((gm = gatePattern.exec(sectionText)) !== null) {
    successSignals.push(gm[1].trim());
  }

  return { strategy, commandHints, successSignals, sectionText };
}

function recommendQualityCommands(workspaceFiles, objective = '') {
  const files = new Set((workspaceFiles || []).map((item) => String(item).replace(/\/$/, '')));
  const commands = [];
  const bootstrapProfile = detectWorkspaceBootstrapProfile(workspaceFiles, objective);
  const preferredCwd = bootstrapProfile.preferredCwd || '.';

  // Static HTML project: has .html files but no real test infrastructure.
  // Using npm test here would fail (no test script) or run Jest on HTML (wrong).
  // These projects use http.server + run_playwright instead — handled by injectQualityActionIfNeeded.
  const fileList = [...files];
  const isStaticHtmlProject = fileList.some((f) => f.endsWith('.html'))
    && !fileList.some((f) => /\.(test|spec)\.[jt]sx?$/.test(f) || f === '__tests__' || f.startsWith('__tests__/') || f.includes('/__tests__/'));

  if (files.has('package.json') && !isStaticHtmlProject) {
    commands.push({
      command: 'npm',
      args: ['test'],
      cwd: preferredCwd,
      timeout_ms: 240000,
      intent: 'Run automated tests',
      expected_diff: 'No file change. Test output validates implementation.',
    });
    commands.push({
      command: 'npm',
      args: ['run', 'lint'],
      cwd: preferredCwd,
      timeout_ms: 240000,
      intent: 'Run linter checks',
      expected_diff: 'No file change. Lint output confirms code quality.',
    });
  }
  if (files.has('Package.swift')) {
    commands.push({
      command: 'swift',
      args: ['test'],
      cwd: preferredCwd,
      timeout_ms: 240000,
      intent: 'Run Swift tests',
      expected_diff: 'No file change. Swift test output validates behavior.',
    });
  }
  if (files.has('pyproject.toml') || files.has('requirements.txt')) {
    commands.push({
      command: 'python3',
      args: ['-m', 'pytest'],
      cwd: preferredCwd,
      timeout_ms: 240000,
      intent: 'Run Python tests',
      expected_diff: 'No file change. Pytest output validates behavior.',
    });
  }
  return commands;
}

function injectWebVerification(actions, workspaceFiles) {
  const writtenPaths = actions
    .filter((a) => a.tool === 'write_file' || a.tool === 'append_file')
    .map((a) => String(a.exact_args?.path || '').toLowerCase());
  const wsFiles = (workspaceFiles || []).map((f) => String(f).toLowerCase());

  const allHtmlPaths = [
    ...writtenPaths.filter((p) => p.endsWith('.html')),
    ...wsFiles.filter((p) => p.endsWith('.html')),
  ];
  const entryHtml = allHtmlPaths.find((p) => p === 'index.html' || p.endsWith('/index.html'))
    || allHtmlPaths[0]
    || 'index.html';
  const htmlDir = entryHtml.includes('/') ? entryHtml.replace(/\/[^/]+$/, '') : '.';
  const htmlFile = entryHtml.includes('/') ? entryHtml.replace(/.*\//, '') : entryHtml;
  const serveDir = htmlDir === '.' ? '.' : htmlDir;
  const pageUrl = `http://localhost:8081/${htmlFile}`;

  const serverAction = normalizeAction({
    owner: 'qa',
    intent: `Start local HTTP server serving ${serveDir} for browser verification`,
    tool: 'run_command',
    exact_args: {
      command: 'bash',
      args: ['-c', `lsof -ti:8081 | xargs kill -9 2>/dev/null; sleep 0.3; python3 -m http.server 8081 --directory ${serveDir} &`],
      cwd: '.',
      timeout_ms: 8000,
    },
    expected_diff: 'Server started on port 8081.',
    rollback_plan: 'Kill with: lsof -ti:8081 | xargs kill -9',
    risk_level: 'low',
  });
  const playwrightAction = normalizeAction({
    owner: 'qa',
    intent: `Verify ${entryHtml} loads with zero console errors in browser`,
    tool: 'run_playwright',
    exact_args: { url: pageUrl, headless: true },
    expected_diff: 'consoleErrorCount: 0 confirmed. Page loads without errors.',
    rollback_plan: 'No rollback needed. Read-only verification.',
    risk_level: 'low',
  });
  return [...actions, serverAction, playwrightAction];
}

function injectQualityActionIfNeeded(actions, workspaceFiles, teamMode, objectivePolicy = null, activeSkillContent = '', objective = '') {
  if (objectivePolicy && (objectivePolicy.researchOnly || objectivePolicy.noBuild)) {
    return actions;
  }
  if (teamMode === 'solo') {
    return actions;
  }
  if (!hasWriteAction(actions) || hasVerificationAction(actions)) {
    const mediaMeta = inferImageTaskMeta(objective);
    if (!mediaMeta.isImageSelectionTask) {
      return actions;
    }
    const hasImageAnalysis = actions.some((action) => String(action.tool || '') === 'analyze_image');
    if (hasImageAnalysis) {
      return actions;
    }
    const outputPaths = extractImageOutputPathsFromActions(actions);
    if (outputPaths.length === 0) {
      return actions;
    }
    const topicText = mediaMeta.topicKeywords.length > 0 ? mediaMeta.topicKeywords.join(', ') : 'the requested theme';
    const maxChecks = mediaMeta.requestedCount > 0 ? Math.min(mediaMeta.requestedCount, 8) : 4;
    const mediaQaActions = outputPaths.slice(0, maxChecks).map((imagePath) => normalizeAction({
      owner: 'qa',
      intent: `Verify image relevance for "${topicText}" on ${imagePath}`,
      tool: 'analyze_image',
      exact_args: {
        path: imagePath,
        prompt: `Check whether this image matches the requested theme (${topicText}). Respond with: relevant/not relevant and one short reason.`,
      },
      expected_diff: 'Image relevance verified before completion.',
      rollback_plan: 'No rollback needed. Read-only verification.',
      risk_level: 'low',
    }));
    return [...actions, ...mediaQaActions];
  }

  // === SKILL-DRIVEN INJECTION (highest priority) ===
  // When a skill is active, honour its defined verification strategy instead
  // of guessing from file types. This makes QA adapt to any task type.
  const skillVer = extractSkillVerification(activeSkillContent);
  if (skillVer.strategy) {
    if (skillVer.strategy === 'web') {
      return injectWebVerification(actions, workspaceFiles);
    }

    if (skillVer.strategy === 'build-and-test' || skillVer.strategy === 'run-output') {
      // Use first explicit command hint from the skill's Verification Steps
      const hint = skillVer.commandHints[0];
      if (hint) {
        const qaAction = normalizeAction({
          owner: 'qa',
          intent: `Verify: ${hint}`,
          tool: 'run_command',
          exact_args: { command: 'bash', args: ['-c', hint], cwd: '.', timeout_ms: 300000 },
          expected_diff: skillVer.successSignals[0] || 'Verification command completes successfully.',
          rollback_plan: 'No rollback needed.',
          risk_level: 'low',
        });
        return [...actions, qaAction];
      }
      // No explicit hint — fall through to file-type heuristics
    }

    if (skillVer.strategy === 'file-verify') {
      // Inject a read of the primary output file mentioned as a command hint
      const hint = skillVer.commandHints[0];
      if (hint) {
        const qaAction = normalizeAction({
          owner: 'qa',
          intent: `Verify output file exists and has expected content: ${hint}`,
          tool: 'read_file',
          exact_args: { path: hint },
          expected_diff: 'File content confirms the task is complete.',
          rollback_plan: 'No rollback needed.',
          risk_level: 'low',
        });
        return [...actions, qaAction];
      }
    }

    if (skillVer.strategy === 'general') {
      // The agent is expected to include its own verification steps guided by the
      // skill and system prompt. Return unchanged — hasWriteAction guard already
      // ensures we only reach here if something was written this iteration.
      return actions;
    }
  }

  // === FILE-TYPE HEURISTICS (fallback when no skill strategy defined) ===
  const writtenPaths = actions
    .filter((a) => a.tool === 'write_file' || a.tool === 'append_file')
    .map((a) => String(a.exact_args?.path || '').toLowerCase());
  const wsFiles = (workspaceFiles || []).map((f) => String(f).toLowerCase());
  const isWebProject = [...writtenPaths, ...wsFiles].some((p) => p.endsWith('.html'));

  if (isWebProject) {
    return injectWebVerification(actions, workspaceFiles);
  }

  const candidates = recommendQualityCommands(workspaceFiles, objective);
  if (candidates.length === 0) {
    return actions;
  }

  const chosen = candidates[0];
  const qaAction = normalizeAction({
    intent: chosen.intent,
    tool: 'run_command',
    exact_args: {
      command: chosen.command,
      args: chosen.args,
      cwd: chosen.cwd,
      timeout_ms: chosen.timeout_ms,
    },
    expected_diff: chosen.expected_diff,
    rollback_plan: 'No rollback needed. This is a verification step.',
    risk_level: 'low',
  });

  return [...actions, qaAction];
}

function isTimedPermissionActive(untilTs, now = Date.now()) {
  return Number(untilTs || 0) > now;
}

function applySecurityControlsToPolicy(action, policy, securityControls) {
  const now = Date.now();
  const controls = ensureObject(securityControls);
  const hasBrowser = isTimedPermissionActive(controls.browserControlUntil, now);
  const hasInternet = isTimedPermissionActive(controls.internetAccessUntil, now);
  const hasRemote = isTimedPermissionActive(controls.remoteAccessUntil, now);
  const next = { ...policy };
  const tool = String(action.tool || '').trim();

  if (tool === 'run_playwright' && !hasBrowser) {
    return {
      ...next,
      allowed: 'gated',
      effectiveRisk: 'high',
      reason: 'Browser control is locked. Enable it in Security Settings for a time window.',
    };
  }
  if ((tool === 'web_search' || tool === 'web_scrape' || tool === 'http_request') && !hasInternet) {
    return {
      ...next,
      allowed: 'gated',
      effectiveRisk: 'high',
      reason: 'Internet access is locked. Enable it in Security Settings for a time window.',
    };
  }
  if (tool === 'run_command') {
    const command = String(action.exact_args?.command || '').trim().toLowerCase();
    const args = Array.isArray(action.exact_args?.args)
      ? action.exact_args.args.map((item) => String(item).toLowerCase())
      : [];
    const gitPush = command === 'git' && args[0] === 'push';
    const remoteCli = command === 'ssh' || command === 'scp' || command === 'rsync';
    const internetCli = command === 'curl' || command === 'wget';
    const browserCli = command === 'open';
    if ((gitPush || remoteCli) && hasRemote) {
      return {
        ...next,
        allowed: true,
        effectiveRisk: 'medium',
        reason: 'Remote access temporarily unlocked in Security Settings.',
      };
    }
    if ((gitPush || remoteCli) && !hasRemote) {
      return {
        ...next,
        allowed: 'gated',
        effectiveRisk: 'high',
        reason: 'Remote publish/server access is locked. Enable it in Security Settings for a time window.',
      };
    }
    if (internetCli && !hasInternet) {
      return {
        ...next,
        allowed: 'gated',
        effectiveRisk: 'high',
        reason: 'Internet access is locked. Enable it in Security Settings for a time window.',
      };
    }
    if (browserCli && !hasBrowser) {
      return {
        ...next,
        allowed: 'gated',
        effectiveRisk: 'high',
        reason: 'Browser control is locked. Enable it in Security Settings for a time window.',
      };
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// createAgentPlan
// ---------------------------------------------------------------------------

async function createAgentPlan({
  settings,
  model,
  task,
  rootObjective = '',
  workspaceRoot,
  priorResults = [],
  teamMode = 'teams',
  historySummary = '',
  discoveryHints = [],
  runId = '',
  iteration = 0,
  objectiveForWatch = '',
  objectivePolicy = null,
  callGuards = null,
  onTeamEvent = null,
  threadContext = '',
  executionMode = 'action',
  bannedApproaches = [],
  activeSkillContent = '',
  scopeGuardNotes = '',
  mediaQualityNotes = '',
  objectiveGuards = null,
  executionCore = '',
}) {
  const effectiveObjective = rootObjective || objectiveForWatch || task;
  const policy = objectivePolicy || detectObjectivePolicy(effectiveObjective);
  const cache = getRunCache(runId);

  // --- Workspace file listing: cache across iterations, refresh every 3 ---
  let files;
  if (policy.webResearchPreferred) {
    files = ['(web research mode: local workspace scan minimized)'];
  } else if (cache.workspaceFiles && iteration - (cache.workspaceFilesIteration || 0) < 3) {
    files = cache.workspaceFiles;
  } else {
    files = await listWorkspaceFiles(workspaceRoot, 2, 180);
    cache.workspaceFiles = files;
    cache.workspaceFilesIteration = iteration;
  }

  const memory = await readProjectMemory(workspaceRoot);
  const globalMemory = await readGlobalMemory();
  const skills = await loadProjectSkills(workspaceRoot, 12);
  const core = normalizeExecutionCore(executionCore || settings.executionCore);
  const skillCatalog = skills;
  const agents = await loadProjectAgents(workspaceRoot, 8);
  const memoryNotes = toMemoryPrompt(memory);
  const globalMemoryNotes = toGlobalMemoryPrompt(globalMemory, effectiveObjective, workspaceRoot);

  // RAG: refresh every 4 iterations so new findings from the run can be indexed
  let ragContext = '';
  const ragStale = cache.ragContext === undefined
    || (iteration - (cache.ragIteration || 0)) >= 4;
  if (!ragStale && cache.ragContext !== undefined) {
    ragContext = cache.ragContext;
  } else {
    try {
      const ragHits = await retrieveContext(effectiveObjective, settings, {
        workspaceRoot,
        topK: 8,
        minSimilarity: 0.2,
      });
      ragContext = toRAGPrompt(ragHits);
      cache.ragContext = ragContext;
      cache.ragIteration = iteration;
    } catch {
      cache.ragContext = cache.ragContext || '';
      cache.ragIteration = iteration;
    }
  }

  const discoveryNotes = Array.isArray(discoveryHints) && discoveryHints.length > 0
    ? discoveryHints.map((item) => `- ${item}`).join('\n')
    : '';
  const skillNotes = activeSkillContent
    ? [
      '=== ACTIVE SKILL PLAYBOOK ===',
      'A step-by-step playbook was found for this task. Follow it:',
      truncate(activeSkillContent, 1500),
      '=== END SKILL PLAYBOOK ===',
      '',
      'Other available skills:',
      toSkillPrompt(skillCatalog),
    ].join('\n')
    : toSkillPrompt(skillCatalog);
  const coreNotes = '';

  // ── Single-agent architecture ──────────────────────────────────────────
  // No more team brief pipeline.  The planner is ONE agent that reasons and
  // acts in a loop.  Specialist roles are available on-demand via the
  // `delegate` tool — the agent calls them when it has a specific question,
  // not as a mandatory pre-planning step every iteration.
  // ───────────────────────────────────────────────────────────────────────
  let teamBrief = '';
  const teamBriefs = [];

  // Derive skill name from the loaded content (no extra param needed)
  const _skillNameForWatch = activeSkillContent
    ? (activeSkillContent.match(/^#\s+Skill:\s*(.+)$/m) || [])[1]?.trim() || null
    : null;

  if (runId) {
    broadcastWatchEvent(runId, {
      type: 'planning_started',
      iteration,
      summary: `Planning iteration ${iteration}`,
      detail: `${model} — ${truncate(task.split('\n')[0].replace(/^(Primary objective:|Current focus for this iteration:|Objective:)/i, '').trim(), 160)}`,
    }, {
      objective: objectiveForWatch || task,
      provider: settings.provider,
      model,
      workspaceRoot,
      teamMode,
      activeSkillName: _skillNameForWatch,
    });
    await appendRunDebugEvent(runId, 'planning_started', {
      iteration,
      model,
      teamMode,
      objective: truncate(effectiveObjective, 500),
      task: truncate(task, 500),
      workspaceRoot,
    }).catch(() => {});
  }

  const plannerPrompt = isSmallLocalModel(model)
    ? buildCompactPlannerPrompt({
      task,
      rootObjective: effectiveObjective,
      workspaceFiles: files,
      webIdentity: settings.webIdentity || {},
      userProfile: settings.userProfile || {},
      executionCore: core,
      bannedApproaches,
    })
    : buildAgentPlannerPrompt({
      task,
      rootObjective: effectiveObjective,
      workspaceRoot,
      workspaceFiles: files,
      memoryNotes,
      globalMemoryNotes,
      ragContext,
      discoveryNotes,
      skillNotes,
      teamBrief,
      teamMode,
      objectivePolicy: policy,
      executionMode,
      bannedApproaches,
      scopeGuardNotes,
      mediaQualityNotes,
      smallChangeGuardNotes: buildSmallChangeGuardNotes(objectiveGuards),
      executionCore: core,
      coreNotes,
      userProfile: settings.userProfile || {},
      webIdentity: settings.webIdentity || {},
      integrations: settings.integrations || {},
    });
  const guidance = [
    'Return JSON only.',
    'No markdown.',
    'No explanations.',
    'No refusal language.',
    historySummary ? `Use this latest history for continuity:\n${historySummary}` : '',
  ].join(' ');

  let lastOutput = '';
  let lastError = '';

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await callResponsesWithFallback({
      settings,
      model,
      callGuards,
      input: [
        {
          role: 'system',
          content: 'You output strict JSON execution plans for a safe local coding agent.',
        },
        {
          role: 'user',
          content: `${plannerPrompt}\n\n${guidance}`,
        },
        ...(attempt > 1
          ? [
            {
              role: 'user',
              content: `Attempt ${attempt}: previous output was invalid (${truncate(lastError || 'unknown issue', 280)}). Return ONLY a JSON object that matches the schema and includes actions.`,
            },
          ]
          : []),
      ],
      temperature: 0.05,
    });

    const outputText = extractOutputText(settings.provider, result.payload);
    model = result.model || model;
    lastOutput = outputText;

    if (isLikelyRefusal(outputText)) {
      lastError = 'Model returned refusal text instead of actions.';
      continue;
    }

    const jsonTexts = extractJSONObjects(outputText);
    if (!jsonTexts || jsonTexts.length === 0) {
      console.log('[agent-loop] No JSON found in model output. First 500 chars:', outputText.slice(0, 500));
      lastError = 'Model did not return JSON.';
      continue;
    }

    let parsed = { actions: [] };
    let parseFailed = false;

    // A well-behaved model returns {"actions":[...]} or [...].
    // If it returned multiple loose {} objects (e.g. multiple tools back-to-back),
    // we aggregate them all into a single parsed.actions array.
    for (const text of jsonTexts) {
      try {
        const obj = JSON.parse(sanitizeJsonString(text));
        if (Array.isArray(obj)) {
          parsed.actions.push(...obj);
        } else if (obj.actions && Array.isArray(obj.actions)) {
          parsed.actions.push(...obj.actions);
          // Only take summary/done from an object that actually provides them
          if ('summary' in obj) parsed.summary = obj.summary;
          if ('done' in obj) parsed.done = obj.done;
        } else {
          // It's a single tool object not wrapped in {"actions":[]}
          parsed.actions.push(obj);
        }
      } catch (error) {
        console.log('[agent-loop] JSON parse failed on fragment:', text.slice(0, 300));
        lastError = `Failed to parse plan JSON fragment: ${error.message}`;
        parseFailed = true;
        break;
      }
    }

    if (parseFailed) continue;

    // Log raw model output structure for debugging local models
    console.log('[agent-loop] Raw output (first 300):', outputText.slice(0, 300));
    console.log('[agent-loop] Parsed JSON keys:', Object.keys(parsed).join(', '),
      '| Is array:', Array.isArray(parsed));

    let plan;
    try {
      plan = normalizePlan(parsed);
    } catch (normalizeError) {
      lastError = normalizeError.message;
      continue;
    }
    // Debug: log parsed plan tools for local model troubleshooting
    console.log('[agent-loop] Parsed plan tools:', plan.actions.map(a => `${a.tool || '(empty)'}`).join(', '));
    // If the planner says done with no actions, return immediately as a completion signal
    if (plan.done && plan.actions.length === 0) {
      if (runId) {
        await appendRunDebugEvent(runId, 'planning_completed', {
          iteration,
          model: result.model,
          plannerDone: true,
          summary: plan.summary || '',
          actionCount: 0,
        }).catch(() => {});
      }
      await appendAuditEvent({
        type: 'agent_plan_created',
        model: result.model,
        workspace_root: workspaceRoot,
        task_summary: truncate(task, 400),
        action_count: 0,
        done: true,
      });
      return {
        model: result.model,
        summary: plan.summary,
        plannerDone: true,
        actions: [],
        teamMode,
        skillsLoaded: skillCatalog.length,
        customAgentsLoaded: agents.length,
        teamBriefs,
      };
    }

    try {
      require('fs').appendFileSync('/tmp/raw-llm.log', "====== RAW LLM ACTIONS ITERATION " + iteration + " ======\n" + require('util').inspect(plan.actions, { depth: null }) + "\n==========================================================\n");
    } catch (e) { }

    const policyScopedActions = applyObjectivePolicyToActions(
      plan.actions,
      effectiveObjective,
      policy,
      teamMode,
      threadContext,
      priorResults,
    );
    let actions = policyScopedActions;

    const shouldForceBuildKickoff = executionMode !== 'research' && !policy.researchOnly && !policy.noBuild;
    if (shouldForceBuildKickoff && !hasBuildExecutionAction(actions)) {
      const kickoff = inferKickoffBuildActions(effectiveObjective, files);
      if (kickoff.length > 0) {
        actions = [...kickoff, ...actions].slice(0, 10);
      }
    }
    actions = injectBootstrapActionsIfNeeded(actions, files, policy, effectiveObjective);
    actions = injectQualityActionIfNeeded(
      actions,
      files,
      teamMode,
      policy,
      activeSkillContent,
      `${effectiveObjective}\n${threadContext}`,
    ).map((action) => {
      const actionPolicy = evaluateActionPolicy(action);
      return {
        ...action,
        policy_allowed: actionPolicy.allowed,
        policy_reason: actionPolicy.reason,
        effective_risk: actionPolicy.effectiveRisk,
      };
    });

    await appendAuditEvent({
      type: 'agent_plan_created',
      model: result.model,
      workspace_root: workspaceRoot,
      task_summary: truncate(task, 400),
      action_count: actions.length,
      team_mode: teamMode,
      skills_loaded: skillCatalog.length,
      custom_agents_loaded: agents.length,
      team_roles: teamBriefs.length || teamPromptsForMode(teamMode).length,
    });

    if (runId) {
      const actionBreakdown = actions.slice(0, 10).map((a, i) =>
        `${i + 1}. ${a.tool}: ${truncate(a.intent || '', 80)}`
      ).join('\n');
      await appendRunDebugEvent(runId, 'planning_completed', {
        iteration,
        model: result.model,
        plannerDone: plan.done === true,
        summary: plan.summary || '',
        actionCount: actions.length,
        actions: actions.slice(0, 12).map((action) => ({
          tool: String(action.tool || ''),
          intent: truncate(String(action.intent || ''), 220),
          policyAllowed: action.policy_allowed,
          policyReason: truncate(String(action.policy_reason || ''), 220),
          risk: String(action.effective_risk || action.risk_level || ''),
        })),
      }).catch(() => {});
      broadcastWatchEvent(runId, {
        type: 'planning_completed',
        iteration,
        summary: `Plan ready: ${actions.length} action${actions.length === 1 ? '' : 's'}`,
        detail: actionBreakdown,
        planSummary: truncate(plan.summary, 200),
      }, {
        objective: objectiveForWatch || task,
        provider: settings.provider,
        model: result.model,
        workspaceRoot,
        teamMode,
      });
    }

    return {
      model: result.model,
      summary: plan.summary,
      plannerDone: plan.done === true,
      actions,
      teamMode,
      skillsLoaded: skillCatalog.length,
      customAgentsLoaded: agents.length,
      teamBriefs,
    };
  }

  await appendAuditEvent({
    type: 'agent_plan_failed',
    model,
    workspace_root: workspaceRoot,
    task_summary: truncate(task, 400),
    reason: truncate(lastError || 'Unknown planner failure', 500),
  });

  throw new Error(
    `Planner failed to generate executable actions. ${lastError}\n\nLast model output:\n${truncate(lastOutput, 1200)}`,
  );
}

// ---------------------------------------------------------------------------
// extractHumanError — strip stack traces and technical noise from error output
// ---------------------------------------------------------------------------

function extractHumanError(rawOutput) {
  const text = String(rawOutput || '').trim();
  if (!text) return '';

  // Try to find a clear "Error: ..." line
  const errorLine = text.match(/(?:^|\n)\s*((?:Error|TypeError|ReferenceError|SyntaxError|ModuleNotFoundError|Cannot find)[^\n]{10,200})/i);
  if (errorLine) {
    return errorLine[1].trim();
  }

  // Try "FAILED" or "error:" prefixed lines
  const failLine = text.match(/(?:^|\n)\s*((?:FAIL|FAILED|error:)[^\n]{5,200})/i);
  if (failLine) {
    return failLine[1].trim();
  }

  // Strip common noise patterns and return first meaningful lines
  const lines = text.split('\n')
    .filter((l) => l.trim())
    .filter((l) => !/^\s*at\s+/.test(l))                  // stack trace lines
    .filter((l) => !/node:internal/.test(l))               // node internals
    .filter((l) => !/^\s*\^/.test(l))                      // caret pointers
    .filter((l) => !/^\s*cwd:/.test(l))                    // cwd lines
    .filter((l) => !/^\s*exitCode:/.test(l))               // exitCode lines
    .filter((l) => !/^\s*stdout:/.test(l))                 // stdout label
    .filter((l) => !/^\s*stderr:/.test(l))                 // stderr label
    .filter((l) => !/^\s*timedOut:/.test(l))               // timedOut label
    .filter((l) => !/\.\.\.\[truncated\]/.test(l));        // truncation marker

  const clean = lines.slice(0, 3).join(' ').trim();
  return truncate(clean, 200);
}

// ---------------------------------------------------------------------------
// summarizeExecution
// ---------------------------------------------------------------------------

async function summarizeExecution({
  settings,
  model,
  task,
  workspaceRoot,
  plan,
  results,
  finalState = 'stopped',
  callGuards = null,
  taskClass = '',
}) {
  const failed = (results || []).filter((item) => item.ok === false);
  const writtenFiles = collectWrittenFilePaths(results);
  const writtenFilesBlock = writtenFiles.length > 0
    ? `Verified files created/updated:\n${writtenFiles.map((item) => `- ${item}`).join('\n')}`
    : 'Verified files created/updated: none';
  if (failed.length > 0 && finalState !== 'completed') {
    const first = failed[0];
    // Extract a clean, human-readable error — strip stack traces and technical noise
    const rawError = String(first.output || first.summary || 'Unknown error');
    const cleanError = extractHumanError(rawError);
    return {
      model,
      report: [
        `Still working on it — hit a snag with ${first.intent || 'a step'}.`,
        cleanError ? `The issue: ${cleanError}` : '',
      ].filter(Boolean).join('\n'),
    };
  }

  // Note: completed-with-failures falls through to the LLM report so the
  // user still gets actionable "How to Use It" instructions.
  const hadHiccups = failed.length > 0 && finalState === 'completed';

  // Collect commands that were run (useful for "how to use" instructions)
  const commandsRun = (results || []).filter(r => r.ok && r.tool === 'run_command')
    .map(r => String((r.metadata && r.metadata.command) || r.intent || '').trim())
    .filter(Boolean);

  // Resolve absolute paths for written files so the report can reference them
  const writtenAbsolute = writtenFiles.map(f => {
    if (path.isAbsolute(f)) return f;
    return path.resolve(workspaceRoot, f);
  });

  // Detect the "main" HTML file for auto-open hint
  const htmlFiles = writtenAbsolute.filter(f => /\.html?$/i.test(f));
  const mainHtml = htmlFiles.find(f => /index\.html?$/i.test(f)) || htmlFiles[0] || '';

  const executionSummary = [
    `Task: ${task}`,
    `Workspace: ${workspaceRoot}`,
    `Plan summary: ${plan.summary}`,
    hadHiccups ? `Note: ${failed.length} step(s) failed but the task still completed successfully.` : '',
    writtenFilesBlock,
    writtenAbsolute.length > 0
      ? `Absolute file paths:\n${writtenAbsolute.map(f => `- ${f}`).join('\n')}`
      : '',
    mainHtml ? `Main HTML file: ${mainHtml}` : '',
    commandsRun.length > 0 ? `Commands executed:\n${commandsRun.map(c => `$ ${c}`).join('\n')}` : '',
    'Action results:',
    ...results.map((result, index) => {
      return `${index + 1}. ${result.intent} | ${result.tool} | ${result.ok ? 'ok' : 'failed'}\n${truncate(result.output || '', 800)}`;
    }),
  ].filter(Boolean).join('\n\n');

  // Choose the right summarizer prompt based on task class.
  // Lookup / general / operations tasks need a concise conversational answer,
  // NOT a build report with "What I Built" / "Try It Out".
  const isLookupTask = taskClass === 'lookup' || taskClass === 'general' || taskClass === 'operations';

  const buildReportPrompt = [
    'You are Geepus, reporting the results of a coding task to your non-technical human coworker. Act like a helpful, friendly coworker casually walking them through what you just finished. Do NOT use sterile robotic headings like "What I Built" or "Files Created". Write in a natural, conversational tone starting with something like "Hey, I\'ve got that done for you."',
    '',
    'Your casual update should include:',
    '1. A quick conversational summary of what you did and how it works (no bold section headers).',
    '2. A brief mention of the main files you touched (just weave it into the conversation naturally based on the "Verified files" list).',
    '3. If there is nothing to show visually (e.g. backend script, config edit, or operations task), simply provide a bulleted list of the tasks completed.',
    hadHiccups ? '4. Briefly mention you ran into a couple of hiccups but got them sorted out.' : '',
    '',
    'CRITICAL: If you built a visual UI (web page, HTML, app):',
    'Instead of giving terminal commands, just give them a direct Markdown link to the main file or server.',
    'Use the ABSOLUTE file paths from the context (not relative paths), formatted as file:// URIs or http:// URLs.',
    '',
    'Example for an HTML file:',
    '  "You can click here to open it right up: [View app](file:///absolute/path/to/index.html)"',
    '',
    'Example for a running Node/Python server:',
    '  "I\'ve got the local server running for you. You can check it out here: [Open in browser](http://localhost:8080)"',
    '',
    'Do NOT tell the user to manually run `cd ... && npm start` if you already wrote the code. Tell them the final result is ready or give them the file:/// link.',
    '',
    'If a server was started during the build and is still running, just give them the active URL link.',
    'Keep it short, friendly, and natural. No robotic section headers.',
  ].filter(Boolean).join('\n');

  const lookupReportPrompt = [
    'The user asked a question or requested information, and an autonomous agent gathered data via web searches and page scrapes.',
    'Your job: synthesize the raw search/scrape results below into a **concise, human-friendly answer**.',
    '',
    'Rules:',
    '- Answer the user\'s question directly in 1-4 sentences, like a knowledgeable friend would.',
    '- Pull out the key facts, numbers, and details that matter.',
    '- Do NOT dump raw HTML, URLs, or search snippets at the user.',
    '- Do NOT describe what tools were used or how the search was performed.',
    '- Do NOT use headings like "What I Built" or "Try It Out" — this is NOT a build report.',
    '- If sources conflict, mention the range (e.g. "between 42°F and 47°F depending on the source").',
    '- If the data is time-sensitive (weather, stocks, scores), note any freshness caveats only if relevant.',
    '- Keep the tone warm and conversational.',
    '',
    'Example — if the user asked "check the weather" and scrape results show forecast data:',
    'Good: "It\'ll be chilly today — expect a high around 45°F with a good chance of rain throughout the day. You might want a jacket!"',
    'Bad: "Here are the search results I found: [raw HTML dump]"',
    '',
    `The user\'s original question was: "${task}"`,
  ].join('\n');

  try {
    const response = await callResponsesWithFallback({
      settings,
      model,
      callGuards,
      input: [
        {
          role: 'system',
          content: isLookupTask ? lookupReportPrompt : buildReportPrompt,
        },
        {
          role: 'user',
          content: executionSummary,
        },
      ],
      temperature: isLookupTask ? 0.4 : 0.3,
    });
    return {
      model: response.model,
      report: extractOutputText(settings.provider, response.payload),
      openFile: isLookupTask ? null : (mainHtml || null),
    };
  } catch {
    return {
      model,
      report: executionSummary,
      openFile: isLookupTask ? null : (mainHtml || null),
    };
  }
}

// ---------------------------------------------------------------------------
// summarizeRunHistory
// ---------------------------------------------------------------------------

function summarizeRunHistory(iterations, maxEntries = 8) {
  if (!Array.isArray(iterations) || iterations.length === 0) {
    return 'No previous iterations.';
  }

  // Show all iterations, but compress older ones more aggressively
  const lines = [];
  for (let i = 0; i < iterations.length; i++) {
    const iteration = iterations[i];
    const isRecent = i >= iterations.length - maxEntries;
    const results = Array.isArray(iteration.results) ? iteration.results : [];
    // Recent iterations: show more detail including outputs/findings
    if (isRecent) {
      const actionDetails = results.slice(0, 10).map((result) => {
        const status = result.ok ? 'ok' : 'FAILED';
        const base = `  ${status}: ${result.tool} — ${result.intent}`;
        // Include key findings/outputs for research, read, and failed actions
        if (result.output && (result.tool === 'web_search' || result.tool === 'web_scrape'
          || result.tool === 'read_file' || !result.ok)) {
          return `${base}\n    → ${truncate(result.output, 300).replace(/\n/g, '\n    ')}`;
        }
        if (result.output && result.tool === 'run_command') {
          return `${base}\n    → ${truncate(result.output, 200).replace(/\n/g, '\n    ')}`;
        }
        return base;
      }).join('\n');
      lines.push(`Iteration ${iteration.iteration}: ${iteration.summary}\n${actionDetails}`);
    } else {
      // Older iterations: one-line summary only
      const actionSummary = results
        .slice(0, 4)
        .map((result) => `${result.ok ? 'ok' : 'FAILED'}:${result.tool}`)
        .join(', ');
      lines.push(`Iteration ${iteration.iteration}: ${iteration.summary} [${actionSummary}]`);
    }
  }
  return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// pickPersistentNotesFromResults
// ---------------------------------------------------------------------------

function pickPersistentNotesFromResults(results, limit = 8) {
  const lines = [];
  for (const result of results || []) {
    const summary = String(result.summary || '').trim();
    if (summary) {
      lines.push(summary);
    }
    if (lines.length >= limit) {
      break;
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// consolidateMemoryWithLLM — LLM-driven memory extraction
// Sends the run results to the LLM and asks: "What should be remembered?"
// Falls back to pickPersistentNotesFromResults on failure.
// ---------------------------------------------------------------------------

async function consolidateMemoryWithLLM({
  settings,
  model,
  objective,
  results,
  existingNotes = [],
  callGuards = null,
}) {
  // Build a compact summary of what happened
  const resultSummaries = (results || []).slice(-30).map((r) => {
    const status = r.ok ? 'OK' : 'FAILED';
    return `${status} | ${r.tool} | ${truncate(r.intent || '', 100)} | ${truncate(r.output || r.summary || '', 150)}`;
  }).join('\n');

  const prompt = [
    'You are a memory consolidation agent. Given the results of a coding session,',
    'extract the MOST IMPORTANT lessons, patterns, and facts worth remembering for future sessions.',
    '',
    'Guidelines:',
    '- Focus on: what worked, what failed and why, key architectural decisions, useful commands/patterns',
    '- CRITICAL: If a tool or approach failed multiple times, or the run was aborted, you MUST extract a strong negative lesson so the agent does not repeat the mistake.',
    '- These negative lessons should be prefixed with "LEARNED:" (e.g. "LEARNED: browser_action tool failed with timeout, use run_playwright instead").',
    '- Skip: routine file writes, obvious successes, generic information',
    '- Each note should be self-contained and useful without additional context. Always specify the exact tool or file path when discussing failures.',
    '- Deduplicate against existing notes — do not repeat what is already known',
    '- Return 3-8 notes, one per line, prefixed with "- "',
    '- Return ONLY the notes, nothing else',
    '',
    `Objective: ${truncate(objective, 300)}`,
    '',
    existingNotes.length > 0 ? `Existing notes (do NOT repeat these):\n${existingNotes.slice(-20).join('\n')}\n` : '',
    'Session results:',
    resultSummaries,
  ].join('\n');

  try {
    const response = await callResponsesWithFallback({
      settings,
      model,
      input: prompt,
      label: 'memory-consolidation',
      callGuards,
      temperature: 0.1,
    });
    const output = extractOutputText(settings.provider || DEFAULT_PROVIDER, response);
    // Parse lines starting with "- "
    const notes = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
      .filter(Boolean)
      .slice(0, 10);
    return notes.length > 0 ? notes : pickPersistentNotesFromResults(results, 8);
  } catch {
    // LLM consolidation failed — fall back to rule-based extraction
    return pickPersistentNotesFromResults(results, 8);
  }
}

// ---------------------------------------------------------------------------
// collectWrittenFilePaths
// ---------------------------------------------------------------------------

function collectWrittenFilePaths(results) {
  const paths = [];
  for (const result of results || []) {
    if (!result || result.ok !== true) {
      continue;
    }
    const tool = String(result.tool || '');
    if (tool !== 'write_file' && tool !== 'append_file') {
      continue;
    }
    const metadata = ensureObject(result.metadata);
    const filePath = String(metadata.path || '').trim();
    if (filePath) {
      paths.push(filePath);
    }
  }
  return Array.from(new Set(paths)).slice(0, 40);
}

// ---------------------------------------------------------------------------
// hasSuccessfulReviewEvidence
// ---------------------------------------------------------------------------

/**
 * Returns true only if results contain genuine QA evidence.
 * Guards against:
 *  1. Agent reading back files it wrote in the same run (circular evidence)
 *  2. Trivial placeholder tests (e.g. "1 passed, 1 total" with generic names)
 *  3. run_playwright counted unconditionally (must have non-error output)
 */
function hasSuccessfulReviewEvidence(results) {
  const writtenPaths = collectWrittenFilePaths(results);
  const writtenSet = new Set(writtenPaths.map((p) => p.toLowerCase()));

  // Check if a read_file path overlaps with a file written in this run
  function isCircularRead(result) {
    if (String(result.tool || '') !== 'read_file') return false;
    const readPath = String(result.metadata?.path || '').toLowerCase().trim();
    if (!readPath) return false;
    // Exact match or suffix match (relative vs absolute)
    return writtenSet.has(readPath) || [...writtenSet].some((wp) => wp.endsWith(readPath) || readPath.endsWith(wp));
  }

  // Detect trivial test output: "Tests: 1 passed, 1 total" with no meaningful coverage
  function isTrivialTestOutput(output) {
    const lower = String(output || '').toLowerCase();
    // Jest pattern: "Tests:  1 passed, 1 total"
    const jestMatch = lower.match(/tests?:\s*(\d+)\s*passed,\s*(\d+)\s*total/);
    if (jestMatch) {
      const passed = parseInt(jestMatch[1], 10);
      const total = parseInt(jestMatch[2], 10);
      if (total <= 1) {
        // Check for generic test names
        const genericNames = ['sample', 'example', 'placeholder', 'dummy', 'hello', 'basic math', 'adds 1'];
        if (genericNames.some((g) => lower.includes(g))) return true;
      }
    }
    // pytest pattern: "1 passed" with no real test names
    const pytestMatch = lower.match(/(\d+)\s*passed/);
    if (pytestMatch && parseInt(pytestMatch[1], 10) <= 1) {
      const genericNames = ['sample', 'example', 'placeholder', 'test_sample', 'test_dummy'];
      if (genericNames.some((g) => lower.includes(g))) return true;
    }
    return false;
  }

  // Check if a result's summary/output looks like fabricated result content
  function isFabricatedVerification(result) {
    const tool = String(result.tool || '');
    // read_file of a fake results document
    if (tool === 'read_file') {
      const output = String(result.output || '').toLowerCase();
      const fabricationSignals = [
        'manual testing results', 'verification results', 'qa results',
        'all features verified', 'all tests passed', 'verified all features',
        'testing complete', 'verification complete',
      ];
      if (fabricationSignals.some((s) => output.includes(s))) return true;
    }
    // write_file creating a "results" document
    if (tool === 'write_file' || tool === 'append_file') {
      const path = String(result.metadata?.path || '').toLowerCase();
      const intent = String(result.intent || '').toLowerCase();
      const fabricationPaths = ['test-results', 'testing-results', 'verification', 'manual-testing', 'qa-results'];
      if (fabricationPaths.some((s) => path.includes(s) || intent.includes(s))) return true;
    }
    return false;
  }

  return (results || []).some((result) => {
    if (!result || result.ok !== true) return false;
    // Skip circular self-reads
    if (isCircularRead(result)) return false;
    // Skip fabricated verification files
    if (isFabricatedVerification(result)) return false;

    // run_playwright: count as evidence only if it did real verification
    if (result.tool === 'run_playwright') {
      const rawOutput = String(result.output || '');
      const output = rawOutput.toLowerCase();
      // Must have some content, not just a brief error
      if (output.includes('error') && rawOutput.length < 200) return false;
      // Parse output as JSON to reliably read consoleErrorCount (not regex on stringified JSON)
      let parsed = null;
      try { parsed = JSON.parse(rawOutput); } catch { /* not JSON, fall through */ }
      if (parsed !== null) {
        const normalized = {};
        for (const [key, value] of Object.entries(parsed)) {
          normalized[String(key).toLowerCase()] = value;
        }
        const consoleErrorCountRaw = normalized.consoleerrorcount;
        const consoleErrorCount = Number.isFinite(Number(consoleErrorCountRaw))
          ? Number(consoleErrorCountRaw)
          : 0;
        const extensionLoaded = Boolean(normalized.extensionloaded);
        const extensionDetected = Boolean(normalized.extensiondetected);
        const evaluateJsResult = String(
          normalized.evaluatejsresult
          || normalized.evaluate_js_result
          || '',
        ).trim();
        const title = String(normalized.title || '').trim();

        // Hard gate: any console errors = not passing QA
        if (consoleErrorCount > 0) return false;
        // Extension check
        if (extensionLoaded) {
          return Boolean(extensionDetected || evaluateJsResult);
        }
        // evaluate_js result is real verification
        if (evaluateJsResult) return true;
        // Page loaded with a real title and zero errors = passing
        if (title) {
          const lowerTitle = title.toLowerCase();
          const blockedTitles = new Set(['test page', 'test_page', 'testpage', 'untitled']);
          if (!blockedTitles.has(lowerTitle)) return true;
        }
        return false;
      }
      // Fallback for non-JSON output (shouldn't normally happen)
      if (output.includes('consoleerrorcount') && output.includes('> 0')) return false;
      if (output.includes('evaluatejsresult')) return true;
      if (
        output.includes('"title"')
        && !output.includes('test page')
        && !output.includes('test_page')
        && !output.includes('testpage')
      ) return true;
      return false;
    }

    if (result.tool !== 'run_command') return false;

    const summary = String(result.summary || '').toLowerCase();
    const output = String(result.output || '').toLowerCase();
    const rawOutput = String(result.output || '');

    // Native app build/test success (xcodebuild, gradle, swift build, etc.)
    const buildSuccessPatterns = [
      /BUILD\s+SUCCEEDED/,
      /TEST\s+SUCCEEDED/,
      /BUILD\s+COMPLETE/,
      /COMPILATION\s+SUCCESSFUL/,
      /TESTS?\s+PASSED/i,
      /\d+\s+tests?\s+passed/i,
      /✅\s*(?:build|test|pass)/i,
    ];
    if (buildSuccessPatterns.some((p) => p.test(rawOutput))) return true;

    // General script/command success: exit 0 + non-trivial output that isn't an error
    // Only count if the intent/summary clearly describes a verification action
    const verificationIntentKeywords = [
      'verify', 'check', 'validate', 'test', 'confirm', 'qa', 'review', 'lint',
    ];
    const hasVerificationIntent = verificationIntentKeywords.some(
      (k) => String(result.intent || '').toLowerCase().includes(k),
    );
    if (hasVerificationIntent && rawOutput.length > 50 && !output.includes('error:') && !output.includes('failed')) {
      return true;
    }

    // Must be an actual test command, not just build/lint
    const testKeywords = [' test', 'pytest', 'jest', 'mocha', 'vitest', 'playwright', 'npm test', 'npx test', 'yarn test'];
    const hasTestKeyword = testKeywords.some((token) => summary.includes(token) || output.includes(token));
    if (!hasTestKeyword) return false;

    // Reject trivial placeholder tests
    if (isTrivialTestOutput(output)) return false;

    // Must show passing test output — not just that the command ran
    const passPatterns = [
      /\d+\s*pass/i,              // "X passed" or "X passing"
      /tests?:\s*\d+\s*passed/i,  // Jest: "Tests: N passed"
      /all\s+tests?\s+passed/i,   // generic "all tests passed"
      /\bpass\b.*\bfail\b/i,       // test summary with pass/fail counts
      /ok\s+\d+/i,               // TAP: "ok 1"
      /\bpassed\b/i,             // generic "passed"
    ];
    const hasPassingOutput = passPatterns.some((pattern) => pattern.test(output));
    // Also accept if the test command exited 0 and has test-related output (already gated by ok===true)
    return hasPassingOutput;
  });
}

// ---------------------------------------------------------------------------
// objectiveNeedsPlaywright
// ---------------------------------------------------------------------------

function objectiveNeedsPlaywright(objective) {
  const lower = String(objective || '').toLowerCase();
  const signals = ['web game', 'browser game', 'snake game', 'webapp', 'website', 'frontend'];
  return signals.some((token) => lower.includes(token));
}

// ---------------------------------------------------------------------------
// isIterationDrifted
// ---------------------------------------------------------------------------

function isIterationDrifted(iterationResults, objective, policy, workspaceFiles, allPriorResults) {
  const results = Array.isArray(iterationResults) ? iterationResults : [];
  if (results.length === 0) {
    return true;
  }
  const hasSuccessfulBuildAction = results.some((result) =>
    result
    && result.ok === true
    && BUILD_TOOLS.has(String(result.tool || '').trim()),
  );

  const text = results
    .map((result) => `${result.intent || ''} ${result.summary || ''} ${result.output || ''}`)
    .join(' ')
    .toLowerCase();

  if (!objectiveMentionsInfra(objective) && INFRA_KEYWORDS.some((token) => text.includes(token))) {
    return true;
  }

  // Detect: test framework installation on a static HTML project.
  // If the iteration tries to install Jest/mocha/vitest on a project that has
  // .html files but no real build system, that is unambiguous drift.
  const wsFiles = (workspaceFiles || []).map((f) => String(f).toLowerCase());
  const isHtmlProject = wsFiles.some((f) => f.endsWith('.html'))
    || results.some((r) => String(r?.metadata?.path || '').toLowerCase().endsWith('.html'));
  if (isHtmlProject) {
    const TEST_FRAMEWORK_SIGNALS = ['jest', 'mocha', 'vitest', 'jasmine', 'karma', 'cypress'];
    const isInstallingTestFramework = TEST_FRAMEWORK_SIGNALS.some((sig) => text.includes(sig))
      && (text.includes('npm install') || text.includes('npm i ') || text.includes('"devdependencies"') || text.includes('"jest"'));
    if (isInstallingTestFramework) {
      return true;
    }
  }

  if (policy && (policy.researchOnly || policy.noBuild)) {
    for (const result of results) {
      if (String(result.tool || '') === 'run_command') {
        return true;
      }
      if (String(result.tool || '') === 'write_file' || String(result.tool || '') === 'append_file') {
        const pathValue = String(result?.metadata?.path || '').toLowerCase();
        if (
          pathValue
          && !pathValue.endsWith('.md')
          && !pathValue.endsWith('.txt')
          && !pathValue.endsWith('.csv')
          && !pathValue.endsWith('.json')
        ) {
          return true;
        }
      }
    }
  }

  // Detect: agent fabricating content instead of fetching it.
  // When the objective uses "find/search/get/download/fetch" verbs and the agent
  // writes image or media files via write_file (rather than curl-downloading them),
  // that is fabrication — the user wanted real content, not generated illustrations.
  const FETCH_VERBS = ['find', 'search', 'get me', 'download', 'fetch', 'look up', 'locate', 'retrieve'];
  const MEDIA_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.pdf', '.mp3', '.mp4', '.mov', '.svg']);
  const objLower = String(objective || '').toLowerCase();
  const objectiveIsFetch = FETCH_VERBS.some((v) => objLower.includes(v));
  if (objectiveIsFetch) {
    const fabricatedMedia = results.some(
      (r) => (r.tool === 'write_file' || r.tool === 'append_file')
        && MEDIA_EXTS.has(path.extname(String(r.metadata?.path || '').toLowerCase())),
    );
    if (fabricatedMedia) {
      return true; // Fabrication drift: wrote media files instead of fetching real ones
    }
  }

  // Detect script-versioning loop: agent has written 3+ script files across the run
  // (.py, .sh) and is still writing more — a sign it's rewriting failed scripts
  // rather than switching to a direct approach (curl, wget, etc.).
  if (Array.isArray(allPriorResults) && allPriorResults.length > 0) {
    const scriptExts = new Set(['.py', '.sh', '.bash']);
    const countScripts = (arr) => arr.filter(
      (r) => r.ok !== false
        && (r.tool === 'write_file' || r.tool === 'append_file')
        && scriptExts.has(path.extname(String(r.metadata?.path || '').toLowerCase())),
    ).length;
    const priorScriptCount = countScripts(allPriorResults);
    const currentScriptCount = countScripts(results);
    if (priorScriptCount >= 3 && currentScriptCount > 0) {
      return true; // Script versioning drift: stop rewriting failed scripts
    }
  }

  const objectiveWords = wordsForMatch(objective);
  if (objectiveWords.length === 0) {
    return false;
  }
  const overlap = objectiveOverlapScore(text, objectiveWords);
  // If the iteration produced successful build output or network action, do not mark it as drift
  // based only on keyword overlap heuristics. Explicit drift checks above still apply.
  const hasSuccessfulNetworkAction = results.some((result) =>
    result
    && result.ok === true
    && (result.tool === 'web_search' || result.tool === 'web_scrape' || result.tool === 'http_request')
  );
  if (overlap === 0 && (hasSuccessfulBuildAction || hasSuccessfulNetworkAction)) {
    return false;
  }
  return overlap === 0;
}

function hasSuccessfulBuildOutput(iterationResults) {
  const results = Array.isArray(iterationResults) ? iterationResults : [];
  return results.some((result) =>
    result
    && result.ok === true
    && BUILD_TOOLS.has(String(result.tool || '').trim()),
  );
}

// ---------------------------------------------------------------------------
// Research loop detection
// ---------------------------------------------------------------------------

const RESEARCH_TOOLS = new Set(['web_search', 'web_scrape', 'read_file', 'list_files']);
const BUILD_TOOLS = new Set(['write_file', 'patch_file', 'append_file', 'run_command', 'run_playwright', 'browser_launch', 'browser_action']);

/**
 * Returns true if an iteration consists entirely of research/read actions
 * with no building actions (write_file, run_command, etc.).
 */
function isResearchOnlyIteration(iterationResults) {
  const results = Array.isArray(iterationResults) ? iterationResults : [];
  if (results.length === 0) return false;
  // think-only iterations are completion confirmations, not research loops.
  // Don't penalise an agent that is wrapping up with a summary/think.
  const nonThinkResults = results.filter((r) => String(r.tool || '') !== 'think');
  if (nonThinkResults.length === 0) return false; // pure think = completion step, not research
  const hasBuildAction = nonThinkResults.some((r) => BUILD_TOOLS.has(String(r.tool || '')));
  return !hasBuildAction;
}

/**
 * Count how many consecutive recent iterations are research-only.
 */
function countConsecutiveResearchIterations(iterations) {
  let count = 0;
  for (let i = (iterations || []).length - 1; i >= 0; i--) {
    const iter = iterations[i];
    const results = Array.isArray(iter.results) ? iter.results : [];
    if (isResearchOnlyIteration(results)) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Collect all URLs that have been web_searched or web_scraped across the entire run.
 * Returns a Set of normalized URL strings.
 */
function collectResearchedUrls(iterations) {
  const urls = new Set();
  for (const iter of (iterations || [])) {
    for (const result of (iter.results || [])) {
      const tool = String(result.tool || '');
      if (tool === 'web_scrape' || tool === 'run_playwright') {
        const url = String(result.metadata?.url || result.metadata?.args?.[0] || '').trim().toLowerCase();
        if (url) urls.add(url);
      }
      if (tool === 'web_search') {
        const query = String(result.metadata?.query || result.metadata?.args?.[0] || '').trim().toLowerCase();
        if (query) urls.add(`search:${query}`);
      }
    }
  }
  return urls;
}

/**
 * Detect duplicate URLs/queries in the current iteration — same URL scraped or same query searched.
 */
function findDuplicateResearchInIteration(iterationResults, priorUrls) {
  const duplicates = [];
  for (const result of (iterationResults || [])) {
    const tool = String(result.tool || '');
    let key = '';
    if (tool === 'web_scrape' || tool === 'run_playwright') {
      key = String(result.metadata?.url || result.metadata?.args?.[0] || '').trim().toLowerCase();
    } else if (tool === 'web_search') {
      key = `search:${String(result.metadata?.query || result.metadata?.args?.[0] || '').trim().toLowerCase()}`;
    }
    if (key && priorUrls.has(key)) {
      duplicates.push(key);
    }
  }
  return duplicates;
}

// ---------------------------------------------------------------------------
// Failure pattern detection & adaptive research pivot
// ---------------------------------------------------------------------------

function extractActionSignature(action) {
  if (!action) return null;
  const tool = String(action.tool || '');
  if (tool === 'think') return null; // Ignore purely internal thought actions
  let argsStr;
  try {
    argsStr = JSON.stringify(action.exact_args || {});
  } catch (_e) {
    // exact_args contains a circular reference (e.g. from normalizeAction)
    argsStr = require('util').inspect(action.exact_args || {}, { depth: 2 });
  }
  return `${tool}::${argsStr}`;
}

function detectActionThrashing(iterations) {
  if (!iterations || iterations.length < 4) return false;
  // Look at the last 4 completed iterations
  const recent = iterations.slice(-4);
  const signaturesPerIter = recent.map((iter) => {
    return (iter.results || [])
      .map(extractActionSignature)
      .filter(Boolean)
      .join('|'); // create a single string representing all substantive actions in this iter
  });

  // If no substantive actions happened, don't flag as thrashing just yet
  if (!signaturesPerIter[0]) return false;

  // They are thrashing if all 4 recent iterations had the exact same action signatures
  const firstSig = signaturesPerIter[0];
  return signaturesPerIter.every(sig => sig === firstSig);
}

function detectPassiveBrowserObservationLoop(iterations) {
  if (!Array.isArray(iterations) || iterations.length < 3) return null;
  const recent = iterations.slice(-3);
  const browserStates = [];
  for (const iter of recent) {
    const results = Array.isArray(iter?.results) ? iter.results : [];
    if (results.length === 0) return null;
    const passiveOnly = results.every((result) => {
      if (!result || result.ok !== true || String(result.tool || '') !== 'browser_action') return false;
      const action = String(result?.metadata?.action || result?.exact_args?.action || '').trim().toLowerCase();
      return action === 'wait_for' || action === 'aria_snapshot' || action === 'frames' || action === 'read';
    });
    if (!passiveOnly) return null;
    const latestBrowserResult = [...results].reverse().find((result) => extractBrowserStateFromMetadata(result.metadata));
    const state = latestBrowserResult ? extractBrowserStateFromMetadata(latestBrowserResult.metadata) : null;
    if (!state || !state.pageUrl) return null;
    browserStates.push({
      pageUrl: String(state.pageUrl || ''),
      pageTitle: String(state.pageTitle || ''),
      frames: Array.isArray(state.frames) ? state.frames.map((frame) => String(frame?.url || '')).filter(Boolean) : [],
    });
  }
  const first = browserStates[0];
  const samePage = browserStates.every((state) => (
    state.pageUrl === first.pageUrl
    && state.pageTitle === first.pageTitle
    && JSON.stringify(state.frames) === JSON.stringify(first.frames)
  ));
  if (!samePage) return null;
  return first;
}

function isPassiveBrowserAction(action) {
  if (!action || String(action.tool || '') !== 'browser_action') return false;
  const browserAction = String(action?.exact_args?.action || '').trim().toLowerCase();
  return browserAction === 'wait_for'
    || browserAction === 'aria_snapshot'
    || browserAction === 'frames'
    || browserAction === 'read';
}

function isPassiveOnlyBrowserPlan(plan) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  if (actions.length === 0) return false;
  return actions.every((action) => isPassiveBrowserAction(action));
}

function buildForcedActiveBrowserRecoveryFromState({ objective = '', priorResults = [] } = {}) {
  const latestBrowserResult = latestSuccessfulResult(
    priorResults,
    (result) => ['browser_launch', 'browser_action'].includes(String(result.tool || ''))
      && extractBrowserStateFromMetadata(result.metadata),
  );
  if (!latestBrowserResult) return null;
  const latestBrowserState = extractBrowserStateFromMetadata(latestBrowserResult.metadata);
  if (!latestBrowserState || !latestBrowserState.pageUrl) return null;
  const latestOutput = String(latestBrowserResult.output || '');

  const primaryActionText = selectVisibleBrowserActionText(latestOutput, [
    'Sign in',
    'Log in',
    'Continue',
    'Next',
    'Create Account',
    'Verify',
    'Submit',
  ]);
  if (primaryActionText) {
    return {
      summary: `Forced active recovery: click ${primaryActionText}`,
      actions: [
        buildBrowserActionStep(
          `Forced recovery: click "${primaryActionText}" to break the passive browser loop.`,
          { action: 'click', target: { text: primaryActionText, exact: false } },
          'The browser state changes after the forced recovery click.',
        ),
        buildBrowserActionStep(
          'Wait briefly for the browser state to update after forced recovery.',
          { action: 'wait_for', condition: { ms: 1500 } },
          'The browser has time to render the next state after forced recovery.',
          'low',
        ),
      ],
      plannerDone: false,
      teamBriefs: [],
      controller: 'forced-recovery',
    };
  }

  const currentUrl = String(latestBrowserState.pageUrl || '').trim();
  const targetUrl = pickBestInteractiveBrowserTarget(objective, priorResults) || extractCanonicalBrowserUrl(objective, priorResults);
  if (targetUrl && targetUrl !== currentUrl) {
    return {
      summary: `Forced active recovery: return to ${targetUrl}`,
      actions: [
        buildBrowserActionStep(
          `Forced recovery: navigate directly to ${targetUrl} to resume task progress.`,
          { action: 'goto', url: targetUrl },
          `The browser is on ${targetUrl} after forced recovery.`,
        ),
      ],
      plannerDone: false,
      teamBriefs: [],
      controller: 'forced-recovery',
    };
  }

  return {
    summary: 'Forced active recovery: attempt primary action',
    actions: [
      buildBrowserActionStep(
        'Forced recovery: try the primary visible authentication/action button.',
        { action: 'click', target: { text: 'Sign in', exact: false } },
        'The page transitions or reveals an actionable error state.',
      ),
      buildBrowserActionStep(
        'Wait briefly for the page to update after forced recovery.',
        { action: 'wait_for', condition: { ms: 1200 } },
        'The page has time to update after forced recovery.',
        'low',
      ),
    ],
    plannerDone: false,
    teamBriefs: [],
    controller: 'forced-recovery',
  };
}

function enforceActiveRecoveryForPassiveLoop({
  plan,
  iterations = [],
  objective = '',
  threadContext = '',
  priorResults = [],
  settings = {},
  workspaceRoot = '',
} = {}) {
  if (!plan || !isPassiveOnlyBrowserPlan(plan)) {
    return { plan, replaced: false, reason: '' };
  }
  const passiveBrowserLoop = detectPassiveBrowserObservationLoop(iterations);
  if (!passiveBrowserLoop) {
    return { plan, replaced: false, reason: '' };
  }

  let forcedPlan = buildInteractiveBrowserPlan({
    objective,
    threadContext,
    priorResults,
    settings,
    workspaceRoot,
    forceActiveRecovery: true,
  });
  if (!forcedPlan || isPassiveOnlyBrowserPlan(forcedPlan)) {
    forcedPlan = buildForcedActiveBrowserRecoveryFromState({
      objective,
      priorResults,
    });
  }
  if (!forcedPlan || isPassiveOnlyBrowserPlan(forcedPlan)) {
    return { plan, replaced: false, reason: '' };
  }
  return {
    plan: forcedPlan,
    replaced: true,
    reason: passiveBrowserLoop.pageUrl,
  };
}

function extractFailureSignature(result) {
  if (!result || result.ok !== false) return null;
  const tool = String(result.tool || '').trim();
  const output = String(result.output || result.summary || '').toLowerCase();
  // Normalize the error to a short signature for comparison
  // Strip variable parts (paths, numbers) to detect recurring patterns
  const normalized = output
    .replace(/\/[^\s]+/g, '<path>')       // file paths
    .replace(/https?:\/\/[^\s]+/g, '<url>') // URLs
    .replace(/\d+/g, '<n>')               // numbers
    .slice(0, 120);
  return `${tool}::${normalized}`;
}

function detectRepeatedFailures(iterations) {
  const signatureCounts = {};
  const signatureErrors = {};
  for (const iter of iterations || []) {
    for (const result of iter.results || []) {
      const sig = extractFailureSignature(result);
      if (sig) {
        signatureCounts[sig] = (signatureCounts[sig] || 0) + 1;
        signatureErrors[sig] = String(result.output || result.summary || '').slice(0, 300);
      }
    }
  }
  const repeated = [];
  for (const [sig, count] of Object.entries(signatureCounts)) {
    if (count >= 2) {
      const [tool] = sig.split('::', 2);
      repeated.push({ signature: sig, tool, count, error: signatureErrors[sig] });
    }
  }
  return repeated.sort((a, b) => b.count - a.count);
}

const PASSIVE_RESULT_TOOLS = new Set([
  'think',
  'list_files',
  'read_file',
  'search_files',
  'safeguard_rejected',
]);

function resultCountsAsRealProgress(result, taskClass = 'general') {
  if (!result || result.ok !== true) return false;
  const tool = String(result.tool || '').trim();
  if (!tool || PASSIVE_RESULT_TOOLS.has(tool)) return false;
  if (tool === 'browser_action') {
    const action = String(result?.metadata?.action || '').trim().toLowerCase();
    if (['read', 'aria_snapshot', 'frames', 'wait_for', 'screenshot'].includes(action)) {
      return false;
    }
  }
  if (tool === 'browser_launch' || tool === 'run_playwright' || tool === 'run_command') {
    return true;
  }
  if (tool === 'web_search' || tool === 'web_scrape' || tool === 'http_request') {
    return taskClass === 'research' || taskClass === 'lookup' || taskClass === 'general';
  }
  return true;
}

function iterationHasRealProgress(results, taskClass = 'general') {
  return (Array.isArray(results) ? results : []).some((result) => resultCountsAsRealProgress(result, taskClass));
}

function iterationIsSafeguardOnly(results) {
  const entries = Array.isArray(results) ? results.filter(Boolean) : [];
  if (entries.length === 0) return true;
  let sawSafeguard = false;
  for (const result of entries) {
    const tool = String(result.tool || '').trim();
    if (tool === 'safeguard_rejected') {
      sawSafeguard = true;
      continue;
    }
    if (tool === 'think') {
      continue;
    }
    return false;
  }
  return sawSafeguard;
}

function countConsecutiveSafeguardIterations(iterations) {
  const recent = Array.isArray(iterations) ? iterations : [];
  let count = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    if (!iterationIsSafeguardOnly(recent[index]?.results)) break;
    count += 1;
  }
  return count;
}

function countConsecutiveNoProgressIterations(iterations, taskClass = 'general') {
  const recent = Array.isArray(iterations) ? iterations : [];
  let count = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const results = Array.isArray(recent[index]?.results) ? recent[index].results : [];
    if (iterationHasRealProgress(results, taskClass)) break;
    count += 1;
  }
  return count;
}

function buildObjectiveLockRecoveryFocus({
  objective = '',
  taskClass = 'general',
  reason = '',
  recentFailure = '',
}) {
  const taskHint = taskClass === 'build'
    ? 'Make one concrete code or verification action next.'
    : 'Make one concrete external action next.';
  return [
    'OBJECTIVE LOCK RECOVERY:',
    `Primary objective: ${truncate(String(objective || '').trim(), 220)}`,
    reason ? `Failure pattern: ${truncate(String(reason || '').trim(), 220)}` : '',
    recentFailure ? `Latest blocked path: ${truncate(String(recentFailure || '').trim(), 220)}` : '',
    'Do not brainstorm. Do not repeat blocked actions. Do not declare done.',
    'Pick exactly one allowed action that changes the world or gathers directly relevant evidence for this objective.',
    taskHint,
  ].filter(Boolean).join('\n');
}

function isPlaywrightLocalConnectivityFailure(result) {
  if (!result || result.ok !== false) return false;
  if (String(result.tool || '').trim() !== 'run_playwright') return false;
  const output = String(result.output || result.summary || '').toLowerCase();
  const urlText = String(result.metadata?.url || '').toLowerCase();
  const localUrlMentioned = urlText.includes('localhost')
    || urlText.includes('127.0.0.1')
    || output.includes('http://localhost')
    || output.includes('http://127.0.0.1');
  const connectivityError = output.includes('err_empty_response')
    || output.includes('err_connection_refused')
    || output.includes('net::err')
    || output.includes('econnrefused')
    || output.includes('connection refused');
  return localUrlMentioned && connectivityError;
}

function isLocalPlaywrightSuccess(result) {
  if (!result || result.ok !== true) return false;
  if (String(result.tool || '').trim() !== 'run_playwright') return false;
  const output = String(result.output || result.summary || '').toLowerCase();
  const urlText = String(result.metadata?.url || '').toLowerCase();
  return (
    urlText.includes('localhost')
    || urlText.includes('127.0.0.1')
    || output.includes('http://localhost')
    || output.includes('http://127.0.0.1')
  );
}

function wasLocalPlaywrightFailureRecoveredInIteration(iteration, failedResult) {
  const failedIndex = Number(failedResult?.index || 0);
  for (const result of (iteration?.results || [])) {
    if (!result || result.ok !== true) continue;
    if (String(result.tool || '').trim() !== 'run_playwright') continue;
    const metadata = ensureObject(result.metadata);
    if (metadata.isAutoRetryReplay !== true) continue;
    if (failedIndex > 0 && Number(result.index || 0) !== failedIndex) continue;
    return true;
  }
  return false;
}

function countRecentPlaywrightLocalConnectivityFailures(iterations, recentIterations = 4) {
  const recent = (iterations || []).slice(-Math.max(1, recentIterations));
  let count = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const iter = recent[i];
    let iterFailures = 0;
    let iterHasLocalPlaywrightSuccess = false;
    let iterHadPlaywrightAttempt = false;
    for (const result of (iter.results || [])) {
      if (String(result?.tool || '').trim() === 'run_playwright') {
        iterHadPlaywrightAttempt = true;
      }
      if (
        isPlaywrightLocalConnectivityFailure(result)
        && !wasLocalPlaywrightFailureRecoveredInIteration(iter, result)
      ) {
        iterFailures += 1;
      }
      if (isLocalPlaywrightSuccess(result)) {
        iterHasLocalPlaywrightSuccess = true;
      }
    }
    if (iterFailures > 0) {
      count += iterFailures;
      continue;
    }
    if (iterHasLocalPlaywrightSuccess || iterHadPlaywrightAttempt) {
      break;
    }
    // Non-Playwright iteration means connectivity failures are no longer consecutive.
    break;
  }
  return count;
}

// ---------------------------------------------------------------------------
// detectRepeatedNoOps — successful actions that return the same output every
// time are useless loops. Track them so the planner can be warned or blocked.
// Write/patch operations are exempt (same file can be written with new content).
// ---------------------------------------------------------------------------
const NOISY_TOOLS_EXEMPT = new Set(['write_file', 'patch_file', 'create_file', 'append_file', 'think', 'memory_store']);

function extractSuccessKey(result) {
  if (!result || result.ok === false) return null;
  const tool = String(result.tool || '').trim();
  if (NOISY_TOOLS_EXEMPT.has(tool)) return null; // writes are intentionally repetitive
  const meta = result.metadata || {};
  // Extract primary discriminating argument
  let primary = '';
  if (tool === 'run_playwright') {
    primary = String(meta.url || meta.args?.[0] || '').trim().toLowerCase();
  } else if (tool === 'run_command') {
    primary = String(meta.command || meta.args?.[0] || '').trim().toLowerCase().slice(0, 80);
  } else if (tool === 'read_file') {
    primary = String(meta.path || meta.args?.[0] || '').trim().toLowerCase();
  } else if (tool === 'web_search') {
    primary = String(meta.query || meta.args?.[0] || '').trim().toLowerCase().slice(0, 60);
  } else if (tool === 'web_scrape' || tool === 'web_fetch') {
    primary = String(meta.url || meta.args?.[0] || '').trim().toLowerCase();
  } else {
    primary = String(meta.args?.[0] || '').trim().toLowerCase().slice(0, 60);
  }
  if (!primary) return null;
  // Include a short digest of the output to detect same-result repetition
  const outputDigest = String(result.output || result.summary || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
  return `${tool}::${primary}::${outputDigest}`;
}

function detectRepeatedNoOps(iterations, windowSize = 5) {
  // Only look at recent iterations
  const recent = (iterations || []).slice(-windowSize);
  const keyCounts = {};
  for (const iter of recent) {
    const keysThisIter = new Set();
    for (const result of iter.results || []) {
      const key = extractSuccessKey(result);
      if (key) keysThisIter.add(key);
    }
    for (const key of keysThisIter) {
      keyCounts[key] = (keyCounts[key] || 0) + 1;
    }
  }
  // Return keys that appear in 3+ of the recent iterations
  return Object.entries(keyCounts)
    .filter(([, count]) => count >= 3)
    .map(([key, count]) => {
      const [tool, primary] = key.split('::', 3);
      return { signature: key, tool, primary, count };
    })
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// computeBannedApproaches — when same failure repeats 3+ times, ban it so the
// planner stops generating the same failing action.
// ---------------------------------------------------------------------------
const FAILURE_BAN_THRESHOLD = 3;

/**
 * Returns true for errors that are transient/recoverable (network hiccups,
 * model load timeouts, connection refused, etc.) rather than fatal (auth
 * errors, bad API key, configuration mistakes).  Transient errors should
 * be retried with backoff; fatal errors should terminate the run immediately.
 */
function isTransientError(error) {
  const msg = String(error?.message || error).toLowerCase();
  return (
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('connection failed') ||
    msg.includes('connection refused') ||
    msg.includes('econnrefused') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('aborterror') ||
    error?.name === 'AbortError'
  );
}

function computeBannedApproaches(iterations) {
  const recent = (iterations || []).slice(-12);
  const counts = new Map();

  for (const iter of recent) {
    for (const result of (iter.results || [])) {
      if (!result || result.ok !== false) continue;
      const key = extractBannableKeyFromResult(result);
      if (!key) continue;
      const prev = counts.get(key) || {
        key,
        signature: key,
        tool: String(result.tool || '').trim(),
        count: 0,
        error: String(result.output || result.summary || '').slice(0, 300),
      };
      prev.count += 1;
      if (!prev.error && (result.output || result.summary)) {
        prev.error = String(result.output || result.summary).slice(0, 300);
      }
      counts.set(key, prev);
    }
  }

  return Array.from(counts.values())
    .filter((entry) => entry.count >= FAILURE_BAN_THRESHOLD)
    .sort((a, b) => b.count - a.count);
}

function buildBannedApproachesWarning(bannedApproaches) {
  if (!bannedApproaches || bannedApproaches.length === 0) return '';
  return [
    '',
    '=== BANNED APPROACHES (repeatedly failed — DO NOT USE) ===',
    ...bannedApproaches.map((b) => `- ${b.tool} [${truncate(b.key || b.signature || '', 80)}] (failed ${b.count}x): ${truncate(b.error, 120)}`),
    'You MUST use a completely different tool or strategy. If patch_file keeps failing, use read_file then write_file instead.',
    'If a fundamental approach is broken, SKIP that task and move to the next part of the objective.',
    '',
  ].join('\n');
}

// Check if a planned action matches a banned approach signature
function isActionBanned(action, bannedApproaches) {
  if (!bannedApproaches || bannedApproaches.length === 0) return false;
  const key = extractBannableKeyFromAction(action);
  if (!key) return false;
  return bannedApproaches.some((b) => (b.key || b.signature) === key);
}

function mergeBannedApproachLists(...lists) {
  const merged = new Map();
  lists.flat().forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const signature = String(entry.signature || entry.key || '').trim();
    if (!signature) return;
    const current = merged.get(signature) || {
      signature,
      key: signature,
      tool: String(entry.tool || '').trim() || 'tool',
      count: 0,
      error: '',
      domain: String(entry.domain || 'general').trim() || 'general',
      updatedAt: String(entry.updatedAt || '').trim() || null,
    };
    current.count = Math.max(current.count, Number(entry.count || 0)) + (merged.has(signature) ? 0 : 0);
    if (!current.error && entry.error) current.error = String(entry.error || '').trim();
    if ((!current.domain || current.domain === 'general') && entry.domain) current.domain = String(entry.domain || '').trim() || 'general';
    if (entry.updatedAt) current.updatedAt = String(entry.updatedAt || '').trim() || current.updatedAt;
    if (entry.tool && current.tool === 'tool') current.tool = String(entry.tool || '').trim() || current.tool;
    const incomingCount = Math.max(1, Number(entry.count || 1));
    current.count = Math.max(current.count, incomingCount);
    merged.set(signature, current);
  });
  return Array.from(merged.values()).sort((left, right) => right.count - left.count);
}

function relevantCrossRunBannedApproaches(userProfile = {}, { objective = '', executionMode = 'action', objectivePolicy = null } = {}) {
  const taskClass = inferRunTaskClass({ objective, executionMode, objectivePolicy });
  const stored = Array.isArray(userProfile?.bannedApproaches) ? userProfile.bannedApproaches : [];
  return stored
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      ...entry,
      relevance: scoreLessonRelevance(
        `${entry.tool || ''} ${entry.error || ''} [${entry.domain || 'general'}]`,
        taskClass,
      ) + (String(entry.domain || '').includes(taskClass) ? 4 : 0),
    }))
    .filter((entry) => entry.relevance > 0 || String(entry.domain || '') === 'general')
    .sort((left, right) => {
      const relevanceDelta = right.relevance - left.relevance;
      if (relevanceDelta !== 0) return relevanceDelta;
      return Number(right.count || 0) - Number(left.count || 0);
    })
    .slice(0, 12)
    .map(({ relevance, ...entry }) => entry);
}

function buildFallbackAlternativeForBannedAction(action = {}, { objective = '', taskClass = 'general' } = {}) {
  const tool = String(action?.tool || '').trim();
  const args = ensureObject(action?.exact_args || {});
  const intent = String(action?.intent || '').trim();
  const objectiveText = String(objective || '').trim();
  const isBuildTask = taskClass === 'build';
  const isResearchTask = taskClass === 'research';
  const isOpsTask = taskClass === 'operations';
  const likelyWebTask = /\b(web|website|browser|frontend|html|css|landing page)\b/i.test(`${objectiveText} ${intent}`);

  if (tool === 'patch_file' || tool === 'write_file' || tool === 'append_file') {
    const path = String(args.path || '').trim();
    if (path) {
      if (isBuildTask) {
        return normalizeAction({
          owner: action.owner || 'engineering',
          tool: 'search_files',
          intent: `Find the surrounding code for ${path} and prepare a different implementation path because direct ${tool} is banned`,
          exact_args: { pattern: path.split('/').pop() || path, path: '.', is_regex: false, max_results: 20 },
          risk_level: 'low',
        });
      }
      return normalizeAction({
        owner: action.owner || 'engineering',
        tool: 'read_file',
        intent: `Inspect ${path} and choose a different edit strategy because direct ${tool} is banned`,
        exact_args: { path },
        risk_level: 'low',
      });
    }
  }

  if (tool === 'run_command') {
    const cwd = String(args.cwd || '.').trim() || '.';
    const command = String(args.command || '').trim().toLowerCase();
    if (isBuildTask && (command.includes('test') || command.includes('lint') || command.includes('build'))) {
      return normalizeAction({
        owner: action.owner || 'qa',
        tool: likelyWebTask ? 'run_playwright' : 'search_files',
        intent: likelyWebTask
          ? 'Use browser QA as an alternate verification path because the prior command fingerprint is banned'
          : 'Inspect the repository for alternate verification entry points because the prior command fingerprint is banned',
        exact_args: likelyWebTask
          ? { url: 'http://localhost:8081/', headless: true }
          : { pattern: 'test|spec|playwright|vitest|jest|pytest', path: '.', is_regex: true, max_results: 20 },
        risk_level: 'low',
      });
    }
    return normalizeAction({
      owner: action.owner || 'engineering',
      tool: 'list_files',
      intent: `Inspect ${cwd} and choose a different approach because this command fingerprint is banned`,
      exact_args: { path: cwd, max_depth: 2 },
      risk_level: 'low',
    });
  }

  if (tool === 'web_scrape') {
    const url = String(args.url || '').trim();
    let query = intent || url;
    try {
      if (url) {
        const parsed = new URL(url);
        query = parsed.hostname.replace(/^www\./, '');
      }
    } catch {
      // ignore url parse failures
    }
    return normalizeAction({
      owner: action.owner || 'research',
      tool: isResearchTask ? 'web_search' : 'http_request',
      intent: isResearchTask
        ? 'Search for alternate sources because direct scrape is banned'
        : 'Fetch the source through a different access path because direct scrape is banned',
      exact_args: isResearchTask
        ? { query: query || intent || 'find alternate source', count: 5 }
        : { url: url || query || 'https://example.com', method: 'GET', headers: {} },
      risk_level: 'low',
    });
  }

  if (tool === 'web_search') {
    if (isResearchTask) {
      return normalizeAction({
        owner: action.owner || 'research',
        tool: 'web_scrape',
        intent: 'Open a concrete source directly because the prior search fingerprint is banned',
        exact_args: { url: 'https://example.com', max_length: 5000 },
        risk_level: 'low',
      });
    }
    return normalizeAction({
      owner: action.owner || 'research',
      tool: 'think',
      intent: `Plan a different evidence-gathering tactic because this search fingerprint is banned`,
      exact_args: { thought: `Avoid repeating banned search approach: ${intent || tool}` },
      risk_level: 'low',
    });
  }

  if (tool === 'run_playwright' || tool === 'browser_action' || tool === 'browser_launch') {
    if (isBuildTask && likelyWebTask) {
      return normalizeAction({
        owner: action.owner || 'qa',
        tool: 'run_command',
        intent: 'Inspect available local web entry points and choose a different browser verification path',
        exact_args: { command: 'find', args: ['.', '-maxdepth', '2', '-name', '*.html'], cwd: '.', timeout_ms: 20000 },
        risk_level: 'low',
      });
    }
    if (isOpsTask) {
      return normalizeAction({
        owner: action.owner || 'ops',
        tool: 'think',
        intent: 'Choose a different operational workflow because this browser path is banned',
        exact_args: { thought: `Avoid repeating banned browser workflow for: ${intent || objectiveText || tool}` },
        risk_level: 'low',
      });
    }
    return normalizeAction({
      owner: action.owner || 'qa',
      tool: 'think',
      intent: `Choose a different browser verification tactic because this browser fingerprint is banned`,
      exact_args: { thought: `Avoid repeating banned browser approach: ${intent || tool}` },
      risk_level: 'low',
    });
  }

  return normalizeAction({
    owner: action.owner || 'chief',
    tool: 'think',
    intent: `Choose a materially different tactic because this action fingerprint is banned`,
    exact_args: { thought: `Avoid repeating banned action: ${intent || tool}` },
    risk_level: 'low',
  });
}

function buildBannedApproachAlternativesGuidance(bannedApproaches = [], { objective = '', taskClass = 'general' } = {}) {
  const entries = Array.isArray(bannedApproaches) ? bannedApproaches.slice(0, 6) : [];
  if (entries.length === 0) return '';
  const lines = ['=== BANNED APPROACH ALTERNATIVES ==='];
  entries.forEach((entry, index) => {
    const blockedTool = String(entry.tool || 'tool').trim() || 'tool';
    const syntheticAction = normalizeAction({
      owner: 'chief',
      tool: blockedTool,
      intent: `Avoid banned fingerprint ${entry.signature || entry.key || blockedTool}`,
      exact_args: {},
      risk_level: 'low',
    });
    const fallback = buildFallbackAlternativeForBannedAction(syntheticAction, { objective, taskClass });
    lines.push(`${index + 1}. If ${blockedTool} is blocked by a banned fingerprint, prefer ${fallback.tool}: ${truncate(fallback.intent || '', 120)}`);
  });
  lines.push('When a banned fingerprint is relevant, choose one of the suggested alternatives directly in your plan instead of proposing the banned step.');
  lines.push('=== END BANNED APPROACH ALTERNATIVES ===');
  return lines.join('\n');
}

function normalizeBanToken(value, fallback = '') {
  const token = String(value || fallback || '').trim().toLowerCase();
  return token.replace(/\s+/g, ' ').slice(0, 160);
}

function parseUrlBanToken(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const host = String(parsed.hostname || '').toLowerCase();
    const protocol = String(parsed.protocol || '').toLowerCase();
    const port = parsed.port || (protocol === 'https:' ? '443' : '80');
    const pathToken = `${parsed.pathname || '/'}${parsed.search || ''}`;
    return `${protocol}//${host}:${port}${pathToken}`.toLowerCase().slice(0, 160);
  } catch {
    return normalizeBanToken(raw);
  }
}

function extractBannableKeyFromResult(result) {
  if (!result || result.ok !== false) return '';
  const tool = String(result.tool || '').trim().toLowerCase();
  const metadata = ensureObject(result.metadata);
  const outputToken = normalizeBanToken(result.output || result.summary || '');

  if (tool === 'run_command') {
    const command = normalizeBanToken(metadata.command);
    if (!command) return '';
    const args = Array.isArray(metadata.args) ? metadata.args.slice(0, 3).map((arg) => normalizeBanToken(arg)).filter(Boolean).join(' ') : '';
    return `run_command|${command}|${args}`.slice(0, 220);
  }
  if (tool === 'run_playwright') {
    const urlToken = parseUrlBanToken(metadata.url);
    return urlToken ? `run_playwright|${urlToken}`.slice(0, 220) : '';
  }
  if (tool === 'write_file' || tool === 'append_file' || tool === 'patch_file' || tool === 'read_file') {
    const pathToken = normalizeBanToken(metadata.path);
    return pathToken ? `${tool}|${pathToken}`.slice(0, 220) : '';
  }
  if (tool === 'search_files') {
    const patternToken = normalizeBanToken(metadata.pattern || metadata.query || outputToken);
    return patternToken ? `search_files|${patternToken}`.slice(0, 220) : '';
  }
  if (tool === 'web_search') {
    const queryToken = normalizeBanToken(metadata.query || outputToken);
    return queryToken ? `web_search|${queryToken}`.slice(0, 220) : '';
  }
  if (tool === 'web_scrape') {
    const urlToken = parseUrlBanToken(metadata.url);
    return urlToken ? `web_scrape|${urlToken}`.slice(0, 220) : '';
  }
  if (!tool) return '';
  if (!outputToken) return '';
  return `${tool}|${outputToken}`.slice(0, 220);
}

function extractBannableKeyFromAction(action) {
  const tool = String(action?.tool || '').trim().toLowerCase();
  const args = ensureObject(action?.exact_args || {});

  if (tool === 'run_command') {
    const command = normalizeBanToken(args.command);
    if (!command) return '';
    const cmdArgs = Array.isArray(args.args) ? args.args.slice(0, 3).map((arg) => normalizeBanToken(arg)).filter(Boolean).join(' ') : '';
    return `run_command|${command}|${cmdArgs}`.slice(0, 220);
  }
  if (tool === 'run_playwright') {
    const urlToken = parseUrlBanToken(args.url);
    return urlToken ? `run_playwright|${urlToken}`.slice(0, 220) : '';
  }
  if (tool === 'write_file' || tool === 'append_file' || tool === 'patch_file' || tool === 'read_file') {
    const pathToken = normalizeBanToken(args.path);
    return pathToken ? `${tool}|${pathToken}`.slice(0, 220) : '';
  }
  if (tool === 'search_files') {
    const patternToken = normalizeBanToken(args.pattern || args.query || args.search);
    return patternToken ? `search_files|${patternToken}`.slice(0, 220) : '';
  }
  if (tool === 'web_search') {
    const queryToken = normalizeBanToken(args.query);
    return queryToken ? `web_search|${queryToken}`.slice(0, 220) : '';
  }
  if (tool === 'web_scrape') {
    const urlToken = parseUrlBanToken(args.url);
    return urlToken ? `web_scrape|${urlToken}`.slice(0, 220) : '';
  }
  if (!tool) return '';
  const intentToken = normalizeBanToken(action.intent);
  return intentToken ? `${tool}|${intentToken}`.slice(0, 220) : '';
}

function buildResearchPivotFocus(failedResult, repeatedFailures, objective) {
  const tool = String(failedResult?.tool || '').trim();
  const error = String(failedResult?.output || failedResult?.summary || '').trim();
  const intent = String(failedResult?.intent || '').trim();

  // Check if this specific failure has been repeating
  const sig = extractFailureSignature(failedResult);
  const isRepeating = repeatedFailures.some((f) => f.signature === sig);

  if (!isRepeating) {
    // First-time failure: normal recovery
    return null;
  }

  // Repeated failure → build a research pivot instruction
  const searchQuery = `${tool} ${intent} alternative approach ${error.slice(0, 60)}`.trim();

  return [
    'ADAPTIVE PIVOT REQUIRED: The previous approach has failed multiple times with the same error.',
    `Repeated failure: ${tool} — ${truncate(error, 200)}`,
    '',
    'DO NOT retry the same approach. Instead:',
    '1. Use think to analyze WHY it keeps failing and brainstorm alternatives.',
    '2. Use read_file to see the ACTUAL current content of any file you need to edit.',
    '3. If patch_file keeps failing, use write_file with the complete corrected file content instead.',
    '4. Use search_files to find the actual code/config that needs changing.',
    '5. If a tool fundamentally cannot do something, SKIP that task and move on to the next part of the objective.',
    '',
    'CRITICAL: If you have failed at the same thing 3+ times, MOVE ON. Do not keep retrying.',
    'An imperfect but working product is better than an infinite loop of failures.',
    '',
    `Original intent: ${intent}`,
    `Objective: ${truncate(objective, 200)}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// captureAndSaveSkill
// ---------------------------------------------------------------------------
// After a task completes, synthesize a SKILL.md playbook so Geepus learns
// what "done" looks like for this type of work and can reference it in future.

async function captureAndSaveSkill({ settings, model, objective, runSummary, callGuards, workspaceRoot }) {
  try {
    // ── Dedup guard: don't create a new skill if a broad category already
    //    covers this type of work.  This prevents proliferation of hyper-
    //    specific skills like "Build and Launch a Revenue-Generating Website"
    //    when "Web Development" already exists. ──
    const existing = await findBestSkillForObjective(objective, workspaceRoot || require('os').homedir()).catch(() => null);
    if (existing) {
      // A matching skill already covers this task type — skip creation.
      return null;
    }

    const prompt = [
      'You are building a reusable SKILL.md playbook for an autonomous AI business agent.',
      'This task just completed successfully. Create a skill guide so future similar tasks are handled consistently.',
      '',
      `Completed objective: ${truncate(objective, 300)}`,
      `Run summary:\n${truncate(runSummary, 1200)}`,
      '',
      'CRITICAL: The skill title MUST be a BROAD CATEGORY (2-4 words max), NOT a task-specific description.',
      'Good: "Web Development", "Data Analysis", "Chrome Extension Development"',
      'BAD:  "Build and Launch a Simple Revenue-Generating Business Website"',
      'BAD:  "Infinite Scroll with Lazy-Loaded Content Poetry Images"',
      '',
      'Write a SKILL.md using EXACTLY this format (no other text):',
      '',
      '# Skill: <broad category title, 2-4 words>',
      '**Tags:** tag1, tag2, tag3',
      '',
      '## Overview',
      '<What this skill covers and when it applies.>',
      '',
      '## Completion Criteria',
      '<Specific, testable criteria for done=true. What evidence is required? Be concrete.>',
      '',
      '## Steps',
      '<High-level approach that worked, numbered.>',
      '',
      '## Guardrails',
      '<What to never do or always check.>',
      '',
      '## Known Failure Modes',
      '<Common mistakes and how to recover from them.>',
      '',
      'Return ONLY the markdown. No explanations, no code fences.',
    ].join('\n');

    const response = await callResponsesWithFallback({
      settings,
      model,
      callGuards,
      input: [
        { role: 'system', content: 'Write a SKILL.md playbook for an autonomous business AI agent. The skill title must be a BROAD CATEGORY (2-4 words), never a task-specific description. Return only markdown.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    });

    const content = extractOutputText(settings.provider, response.payload);
    if (!content || content.length < 80) return null;

    // Extract skill name from the # Skill: heading
    const titleMatch = content.match(/^#\s+Skill:\s*(.+)$/m);
    let skillName = titleMatch ? titleMatch[1].trim() : truncate(objective, 50);

    // Reject overly specific names (>6 words) — truncate to first 4 words.
    const nameWords = skillName.split(/\s+/);
    if (nameWords.length > 6) {
      skillName = nameWords.slice(0, 4).join(' ');
    }

    // Final dedup: check if the generated name is too close to an existing skill.
    const allSkills = await loadProjectSkills(workspaceRoot || require('os').homedir(), 50).catch(() => []);
    const lowerName = skillName.toLowerCase();
    const duplicate = allSkills.some((s) => {
      const existing = s.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const proposed = lowerName.replace(/[^a-z0-9]+/g, ' ').trim();
      return existing === proposed || existing.includes(proposed) || proposed.includes(existing);
    });
    if (duplicate) return null;

    const savedPath = await saveGlobalSkill(skillName, content);
    return savedPath;
  } catch {
    return null; // non-fatal
  }
}

// ---------------------------------------------------------------------------
// developSkillForObjective
// ---------------------------------------------------------------------------
// Called when keyword matching finds no existing skill for an objective.
// Step 1: Ask the LLM whether any existing skill *semantically* covers the task
//         (keyword matching misses this because "build", "app" etc. are stopwords).
// Step 2: If no existing skill fits, research via web search and synthesize a
//         new SKILL.md at the broadest useful category level — never task-specific.

async function developSkillForObjective({ objective, settings, model, callGuards, runId, workspaceRoot }) {
  try {
    if (runId) {
      broadcastWatchEvent(runId, {
        type: 'skill_developing',
        summary: 'Checking skill playbooks...',
        detail: `Semantic check — no keyword match for: ${truncate(objective, 100)}`,
      });
    }

    // ------------------------------------------------------------------
    // Step 1: Semantic match — keyword scoring missed this task because
    // words like "build" and "app" are stopwords. Ask the LLM to judge.
    // ------------------------------------------------------------------
    const existingSkills = await loadProjectSkills(workspaceRoot, 30).catch(() => []);
    if (existingSkills.length > 0) {
      const skillList = existingSkills
        .map((s) => {
          const tagsLine = (s.preview || '').split('\n').find((l) => l.includes('Tags:')) || '';
          return `- ${s.name}${tagsLine ? ` (${tagsLine.replace(/\*\*/g, '').replace('Tags:', '').trim()})` : ''}`;
        })
        .join('\n');

      const matchResp = await callResponsesWithFallback({
        settings,
        model,
        callGuards,
        input: [
          { role: 'system', content: 'You classify tasks against a skill list. Reply MATCH:<exact skill name from the list> or NONE. One line only, no explanation.' },
          {
            role: 'user',
            content: [
              'Available skill playbooks:',
              skillList,
              '',
              `New task: ${truncate(objective, 250)}`,
              '',
              'Does any existing skill playbook cover this task type?',
              '',
              'CRITICAL RULES:',
              '1. ALWAYS prefer the BROADEST / shortest-named skill that covers the task category.',
              '   e.g. if both "Web Development" and "Build and Launch a Revenue-Generating Website" exist,',
              '   ALWAYS pick "Web Development" — it is the right category-level match.',
              '2. NEVER pick a specific skill that adds scope beyond what the user asked for.',
              '   e.g. "build a hello world website" should NOT match a revenue/monetization skill.',
              '3. Only match skills whose category genuinely applies. When in doubt, reply NONE.',
              '',
              'Examples:',
              '  "Build a shopping app" → MATCH:Web Development',
              '  "Build a hello world website" → MATCH:Web Development (NOT a revenue skill)',
              '  "Do my taxes" → NONE (if no tax skill exists)',
              '',
              'Reply MATCH:<name> or NONE.',
            ].join('\n'),
          },
        ],
        temperature: 0,
      }).catch(() => null);

      if (matchResp) {
        const matchText = extractOutputText(settings.provider, matchResp.payload).trim();
        const m = matchText.match(/^MATCH:\s*(.+)$/i);
        if (m) {
          const matchedName = m[1].trim();
          const found = existingSkills.find((s) =>
            s.name.toLowerCase() === matchedName.toLowerCase()
            || s.name.toLowerCase().includes(matchedName.toLowerCase())
            || matchedName.toLowerCase().includes(s.name.toLowerCase()),
          );
          if (found) {
            try {
              const skillPath = path.isAbsolute(found.path)
                ? found.path
                : path.join(workspaceRoot, found.path);
              const content = await fs.readFile(skillPath, 'utf8');
              if (runId) {
                broadcastWatchEvent(runId, {
                  type: 'skill_matched',
                  summary: `Using skill: ${found.name}`,
                  detail: `Matched existing "${found.name}" playbook to this task.`,
                });
              }
              return { name: found.name, content };
            } catch { /* fall through to synthesis */ }
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // Step 2: No matching skill — synthesize a new one.
    // Generalize to the broadest useful category (e.g. not "EV Shopping App"
    // but "E-Commerce Frontend App" or just "Web App Development").
    // ------------------------------------------------------------------
    if (runId) {
      broadcastWatchEvent(runId, {
        type: 'skill_developing',
        summary: 'Developing new skill playbook...',
        detail: `No existing skill fits. Researching: ${truncate(objective, 100)}`,
      });
    }

    // Optional web searches — silently skipped if Brave key is missing or search fails.
    let researchContext = '';
    for (const query of [
      `how to build: ${truncate(objective, 70)} — step by step best practices`,
      `checklist and requirements for: ${truncate(objective, 70)}`,
    ]) {
      try {
        const result = await executeWebSearch({ query, count: 5 });
        if (result && result.ok) researchContext += `\n\n=== Search: ${query} ===\n${truncate(result.output, 800)}`;
      } catch { /* optional */ }
    }

    const prompt = [
      'You are building a reusable SKILL.md playbook for an autonomous AI business agent named Geepus.',
      '',
      `Specific task requested: ${truncate(objective, 300)}`,
      '',
      researchContext
        ? `=== RESEARCH CONTEXT ===\n${truncate(researchContext, 2000)}\n=== END ===`
        : '(No web research — use your own knowledge.)',
      '',
      'CRITICAL: Write the skill for the BROADEST USEFUL CATEGORY of this task.',
      'The title MUST be 2-4 words. NEVER more than 4 words.',
      'NEVER include specific domains, brands, product names, or client details in the title.',
      'NEVER include implementation details like "infinite scroll", "lazy loading", "revenue-generating".',
      'The skill must be reusable for ANY similar task in that broad category.',
      '',
      'Category examples (use THIS level of abstraction — 2-4 words):',
      '  "Build a shopping app for EVs" → Web App Development',
      '  "Build a hello world website" → Web Development',
      '  "Build a revenue-generating site" → Web Development',
      '  "Create infinite scroll page" → Web Development',
      '  "Build a Chrome extension" → Browser Extension Development',
      '  "File my 2024 taxes in TurboTax" → Tax Filing',
      '  "Write a proposal for Acme Corp" → Business Proposal Writing',
      '  "Analyze Q3 sales data" → Data Analysis',
      '  "Research competitors for our SaaS" → Market Research',
      '',
      'VERIFICATION STRATEGY — pick exactly one tag for the ## Verification Steps section:',
      '  [strategy: web]            = served in a browser (websites, web apps, browser extensions)',
      '  [strategy: build-and-test] = compiled projects with a test suite (iOS, Android, Swift, C++, Java)',
      '  [strategy: run-output]     = scripts whose terminal output IS the proof (Python, Shell, R, Node)',
      '  [strategy: file-verify]    = deliverables that are files to read/open (docs, spreadsheets, PDFs)',
      '  [strategy: general]        = operations, config, research, taxes, or anything else',
      '',
      'Use EXACTLY this format (no other text, no code fences):',
      '',
      '# Skill: <broad category title>',
      '**Tags:** tag1, tag2, tag3',
      '',
      '## Overview',
      '',
      '## Completion Criteria',
      '',
      '## Steps',
      '',
      '## Guardrails',
      '',
      '## Known Failure Modes',
      '',
      '## Verification Steps [strategy: <one of the tags above>]',
      'CMD: <concrete verification command 1>',
      'SUCCESS: <what output confirms success>',
      'CMD: <concrete verification command 2>',
      'SUCCESS: <what output confirms success>',
    ].filter(Boolean).join('\n');

    const response = await callResponsesWithFallback({
      settings,
      model,
      callGuards,
      input: [
        {
          role: 'system',
          content: [
            'Write a SKILL.md playbook for an AI business agent. Use the broadest useful category title. Return only markdown.',
            'You MUST include a "## Verification Steps [strategy: X]" section — X must be exactly one of:',
            'web, build-and-test, run-output, file-verify, general.',
            'Under it list 2-4 CMD: and SUCCESS: lines tailored to this skill category.',
          ].join(' '),
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    });

    const content = extractOutputText(settings.provider, response.payload);
    if (!content || content.length < 80) return null;

    const titleMatch = content.match(/^#\s+Skill:\s*(.+)$/m);
    let skillName = titleMatch ? titleMatch[1].trim() : truncate(objective, 50);

    // Enforce broad-category naming: cap at 4 words.
    const nameWords = skillName.split(/\s+/);
    if (nameWords.length > 6) {
      skillName = nameWords.slice(0, 4).join(' ');
    }

    // Dedup: don't save if an existing broad skill already covers this category.
    const allSkills = await loadProjectSkills(workspaceRoot, 50).catch(() => []);
    const lowerName = skillName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const duplicate = allSkills.some((s) => {
      const existing = s.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return existing === lowerName || existing.includes(lowerName) || lowerName.includes(existing);
    });
    if (duplicate) {
      // An existing skill already covers this — find and return it instead.
      const match = allSkills.find((s) => {
        const existing = s.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        return existing === lowerName || existing.includes(lowerName) || lowerName.includes(existing);
      });
      if (match) {
        try {
          const skillPath = path.isAbsolute(match.path)
            ? match.path
            : path.join(workspaceRoot, match.path);
          const existingContent = await fs.readFile(skillPath, 'utf8');
          return { name: match.name, content: existingContent };
        } catch { /* fall through */ }
      }
      return null;
    }

    if (runId) {
      broadcastWatchEvent(runId, {
        type: 'skill_developed',
        summary: `Skill playbook ready: ${skillName}`,
        detail: `Using a provisional "${skillName}" playbook for this run only. It will be promoted only after a successful completion.`,
      });
    }

    return { name: skillName, content, provisional: true };
  } catch {
    return null; // non-fatal — run continues without a skill
  }
}

// ---------------------------------------------------------------------------
// evaluateObjectiveProgress
// ---------------------------------------------------------------------------

async function evaluateObjectiveProgress({
  settings,
  model,
  objective,
  workspaceRoot,
  iterationSummary,
  priorProgressSummary = '',
  threadContext = '',
  latestResults = [],
  remainingIterations,
  callGuards = null,
  repeatedFailures = [],
  activeSkillContent = '',
}) {
  const latestBrowserState = (() => {
    const browserEntries = (Array.isArray(latestResults) ? latestResults : [])
      .filter((entry) => entry && entry.ok === true)
      .filter((entry) => {
        const tool = String(entry.tool || '');
        return tool === 'browser_action' || tool === 'browser_launch';
      });
    const latest = browserEntries[browserEntries.length - 1];
    if (!latest) return '';
    const meta = ensureObject(latest.metadata);
    const lines = [
      'Latest structured browser state:',
      `- Tool: ${String(latest.tool || '')}`,
      `- Action: ${String(meta.action || 'launch')}`,
    ];
    if (meta.pageUrl) lines.push(`- URL: ${String(meta.pageUrl)}`);
    if (meta.pageTitle) lines.push(`- Title: ${String(meta.pageTitle)}`);
    if (meta.screenshotPath) lines.push(`- Screenshot: ${String(meta.screenshotPath)}`);
    if (meta.downloadPath) lines.push(`- Download: ${String(meta.downloadPath)}`);
    if (Array.isArray(meta.frames) && meta.frames.length > 0) {
      lines.push(`- Frames: ${meta.frames.map((frame) => {
        const frameId = Number.isFinite(Number(frame.frameId)) ? ` id=${Number(frame.frameId)}` : '';
        const parentFrameId = Number.isFinite(Number(frame.parentFrameId)) ? ` parent=${Number(frame.parentFrameId)}` : '';
        return `[${Number(frame.index)}${frameId}${parentFrameId}] ${String(frame.url || '')}`;
      }).join(' | ')}`);
    }
    return lines.join('\n');
  })();

  const repeatedWarning = repeatedFailures.length > 0
    ? [
      '',
      'IMPORTANT — These failures have been recurring across multiple iterations:',
      ...repeatedFailures.map((f) => `- ${f.tool} failed ${f.count} times: ${truncate(f.error, 120)}`),
      'If not done, next_focus MUST suggest a completely different approach — do NOT suggest retrying the same tool/method.',
      'Suggest using web_search to research alternatives if no obvious workaround exists.',
    ].join('\n')
    : '';

  const agentCredentials = settings?.webIdentity?.email ? `
=== IDENTITY & CREDENTIALS ===
Geepus bot email: ${settings.webIdentity.email}
Geepus bot password: ${settings.webIdentity.emailPassword}
Geepus bot phone number: ${settings.webIdentity.phoneNumber || 'None provided'}
Geepus bot birth date: ${settings.webIdentity.birthDate || 'None provided'}
Use these credentials autonomously. NEVER ask the user for them if you already have them.
` : '';

  const skillBlock = activeSkillContent
    ? [
      '=== SKILL PLAYBOOK ===',
      'A reusable playbook was found for this task type. Use its "Completion Criteria" section as the',
      'PRIMARY definition of done=true. The generic task-type rules below are fallbacks only.',
      '',
      truncate(activeSkillContent, 1800),
      '=== END SKILL PLAYBOOK ===',
    ].join('\n')
    : '';

  const prompt = [
    'You are a completion judge for an autonomous coding agent run.',
    'Return JSON only with schema:',
    '{"done":true|false,"needs_info":true|false,"questions":["string"],"reason":"string","next_focus":"string"},',
    '',
    'EFFICIENCY RULE: If the agent has already written files, started a server, and run_playwright shows',
    'consoleErrorCount=0 with the correct title/heading, the work IS done. Do NOT ask for more verification.',
    'One successful Playwright pass is sufficient \u2014 do not require multiple passes or re-verification.',
    'For simple objectives (hello world, basic page, single-file tasks), be lenient on polish requirements.',
    '',
    skillBlock,
    skillBlock ? 'FALLBACK TASK STANDARDS (only if skill playbook above does not fully apply):' : 'TASK: First identify what TYPE of task this is, then apply the matching verification standard.',
    '',
    '- Static website / front-end only (HTML/CSS/JS with no backend or test framework):',
    '  done=true if all requested features are built, the UI is polished (not unstyled plain HTML),',
    '  and the page was loaded in a real browser (playwright, http-server, or open command) without errors.',
    '  IMPORTANT: simply using "open /path/index.html" is NOT sufficient verification by itself.',
    '  Require a run_playwright result with consoleErrorCount=0.',
    '  A test framework (jest, pytest, etc.) is NOT required for a static site.',
    '',
    '- Web app / CLI tool / backend service / library / script with a test framework:',
    '  done=true ONLY if a real test runner ran AND all tests passed with zero failures.',
    '  Lint or build passing alone is not sufficient.',
    '',
    '- Chrome/browser extension:',
    '  done=true if the extension loaded in a real browser via playwright, core features were exercised,',
    '  and no _ prefixed files/folders exist in the extension root (Chrome rejects them).',
    '',
    '- Research / documentation / planning:',
    '  done=true if the deliverable (report, doc, spec, plan) is written and thorough.',
    '',
    '- Lookup / information retrieval (weather, facts, prices, scores, definitions, "what is X"):',
    '  done=true if the agent successfully retrieved relevant information via web_search, web_scrape,',
    '  or http_request. The data does NOT need to be written to a file — having the answer in tool',
    '  output is sufficient. do NOT require browser verification, test suites, or file creation.',
    '',
    '- Configuration / setup / infra:',
    '  done=true if verified working (server starts, build passes, tool runs successfully).',
    '',
    '- File delivery (download images/PDFs/data, export files, save documents to a folder):',
    '  done=true ONLY if files physically exist in the target folder, confirmed by list_files or',
    '  run_command ls showing the expected count of non-empty files. Scripts that were written',
    '  to download but never successfully run do NOT count. An empty folder = NOT done.',
    '  If the objective specifies topical relevance (e.g., a theme/category), done=true ONLY if',
    '  there is explicit evidence that selected files match that theme (analyze_image checks or equivalent).',
    '  FABRICATION CHECK: if the objective used the words "find", "search for", "get", "download",',
    '  or "fetch" — any files that were created via write_file instead of downloaded via curl/wget/http_request',
    '  are FABRICATED and do NOT satisfy the objective. done=false if all delivered files are fabrications.',
    '',
    'ALWAYS set done=false if ANY of these are true:',
    '- Implementation is a skeleton (console.log only, empty functions, TODO comments)',
    '- UI is unstyled plain HTML — polished design is required',
    '- The only "evidence" is files the agent wrote then immediately read back (circular)',
    '- The agent produced a fabricated "Manual Testing Results" or "Verification Results" document',
    '- Any test runner reported failures',
    '- Any run_playwright output shows one or more browser console errors',
    '- An advertised feature does not actually work',
    '- The task is an iteration/refinement request, but the agent restarted/scaffolded a new project instead of editing existing work',
    '',
    'If not done, provide next_focus as one concrete actionable next step.',
    'For technical tasks: NEVER suggest asking the user — the agent must solve them independently.',
    'EXCEPTION — set needs_info=true ONLY when the task fundamentally requires personal data or credentials',
    'the agent cannot possess: e.g. W-2 documents, tax filing status, personal preferences,',
    'private documents, or specific user choices that determine the entire task path.',
    agentCredentials ? 'CRITICAL: An IDENTITY & CREDENTIALS block is listed above. This means the agent ALREADY has its email address and password. NEVER set needs_info=true to ask for the email, password, login credentials, or Geepus bot account details — those are already provided and available. Asking for them is INCORRECT.' : '',
    'When needs_info=true: populate "questions" with the minimum concrete questions needed to proceed.',
    'Do NOT use needs_info because the task is hard — only when user facts are truly required.',
    'BROWSER STATE AWARENESS: If the agent is mid-browser-session, check the most recent browser_action output (URL, title, and element tree) to determine the actual page state BEFORE setting needs_info=true. Never assume page state from the objective text alone.',
    'EXTERNAL DEPENDENCY RULE: Only set needs_info=true for a verification code (SMS/2FA/CAPTCHA) when the element tree in the most recent browser_action output explicitly shows an active input field requesting such a code (e.g., a numeric input or field labeled "verification", "code", "OTP" is visible on screen). Do not set needs_info because the objective mentions a phone number — wait until the agent actually reaches that screen.',
    'EMAIL VERIFICATION: If a task involves signing up for a service that sends a verification email, NEVER set needs_info=true to ask the user. The system prompt IDENTITY & CREDENTIALS section contains the agent email and password. The agent MUST autonomously: (1) navigate to the correct webmail URL, (2) sign in, (3) find the email, (4) click the link. Set needs_info=false and set next_focus to "Navigate to [webmail URL] and log in to click the verification email" — the agent has not finished yet.',
    'FORWARD PROGRESS RULE: If the agent is mid-way through a multi-step web form and has not yet reached the external-dependency step, always set needs_info=false and set next_focus to the specific next form step the agent should take. Keep the agent moving forward autonomously through all form pages it can complete on its own.',
    'Never set both done=true and needs_info=true.',
    'If needs_info=false or absent, leave questions as an empty array [].',
    '',
    `Objective: ${objective}`,
    `Workspace: ${workspaceRoot}`,
    `Remaining iterations budget: ${remainingIterations}`,
    agentCredentials,
    '',
    latestBrowserState ? `${latestBrowserState}\n` : '',
    threadContext ? `Conversation context:\n${truncate(threadContext, 2000)}\n` : '',
    priorProgressSummary ? `Prior iterations completed:\n${truncate(priorProgressSummary, 2000)}\n` : '',
    `Latest execution summary:\n${iterationSummary}`,
    '',
    'next_focus MUST build on what was already accomplished — do NOT re-suggest completed steps.',
    'BUDGET EXHAUSTION RULE: If remaining iterations budget is 0, NEVER set needs_info=true unless the very last action was explicitly blocked by a missing credential. Being out of time is NOT a reason to request info. Set needs_info=false and reason="Iteration budget exhausted before completion."',
    repeatedWarning,
  ].join('\n');

  try {
    const response = await callResponsesWithFallback({
      settings,
      model,
      callGuards,
      input: [
        {
          role: 'system',
          content: 'You are a strict JSON completion classifier.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.1,
    });

    const output = extractOutputText(settings.provider, response.payload);
    const jsonTexts = extractJSONObjects(output);
    if (!jsonTexts || jsonTexts.length === 0) {
      return {
        model: response.model,
        done: false,
        reason: 'No completion JSON returned.',
        next_focus: 'Continue implementation and validation based on uncovered gaps.',
      };
    }

    const parsed = ensureObject(JSON.parse(jsonTexts[0]));
    const needsInfo = parsed.needs_info === true && !parsed.done;
    let questions = needsInfo && Array.isArray(parsed.questions) ? parsed.questions.map(String).filter(Boolean) : [];
    // Hard guard: if we already have stored agent credentials, suppress questions asking for them.
    // The judge model sometimes hallucinates credential requests even when explicitly told not to.
    if (questions.length > 0 && settings?.webIdentity?.email) {
      const credentialKeywords = /\b(email|password|credentials?|login|account|geepus bot|bot account)\b/i;
      questions = questions.filter(q => !credentialKeywords.test(q));
    }
    return {
      model: response.model,
      done: parsed.done === true,
      needs_info: needsInfo,
      questions,
      reason: String(parsed.reason || '').trim() || 'No reason provided.',
      next_focus: String(parsed.next_focus || '').trim() || 'Continue implementation and validation.',
    };
  } catch {
    return {
      model,
      done: false,
      reason: 'Completion check failed.',
      next_focus: 'Continue implementation and validation.',
    };
  }
}

async function computeRunReadiness({
  objective,
  threadContext = '',
  executionMode,
  objectivePolicy,
  workspaceRoot,
  results,
}) {
  const artifactStats = await collectArtifactStats(workspaceRoot, results);
  return buildReadinessChecklist({
    objective,
    threadContext,
    executionMode,
    objectivePolicy,
    results,
    artifactStats,
  });
}

// ---------------------------------------------------------------------------
// evaluateUserAcceptance — "fake user" / market-fit quality gate
// ---------------------------------------------------------------------------

async function evaluateUserAcceptance({
  settings,
  model,
  objective,
  workspaceRoot,
  iterationSummary,
  writtenFiles,
  callGuards = null,
}) {
  // Read up to 8 key artifact files so the reviewer can judge actual output quality
  const artifactContents = [];
  const uiExtensions = new Set(['.html', '.css', '.js', '.jsx', '.tsx', '.vue', '.svelte', '.json', '.py', '.swift']);
  const filesToInspect = (writtenFiles || [])
    .filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return uiExtensions.has(ext);
    })
    .slice(0, 8);

  for (const relPath of filesToInspect) {
    try {
      const absPath = path.resolve(workspaceRoot, relPath);
      const content = await fs.readFile(absPath, 'utf8');
      const trimmed = content.length > 3000 ? content.slice(0, 3000) + '\n... (truncated)' : content;
      artifactContents.push(`--- ${relPath} ---\n${trimmed}`);
    } catch { /* skip unreadable files */ }
  }

  const artifactBlock = artifactContents.length > 0
    ? `\nActual file contents of key artifacts:\n\n${artifactContents.join('\n\n')}`
    : '\n(No artifact file contents available for review)';

  const prompt = [
    'You are a REAL USER — not a developer, not a QA engineer. You are the person who would actually download, install, and use this product.',
    'You are evaluating whether this product is ready to ship to real users.',
    '',
    'Return JSON only with schema:',
    '{"acceptable":true|false,"score":1-10,"issues":["string",...],"verdict":"string"}',
    '',
    'Evaluate on these criteria:',
    '1. FIRST IMPRESSION: Does it look professional? Would you take it seriously at first glance, or does it look like a student homework assignment?',
    '2. COMPLETENESS: Does every feature actually work? Are there placeholder buttons, TODO comments, console.log-only handlers, or empty files?',
    '3. VISUAL QUALITY: Is there real styling (colors, spacing, typography, icons)? Or is it unstyled default HTML?',
    '4. USABILITY: Is the UX intuitive? Are interactive elements properly labeled? Is there feedback when you click things?',
    '5. POLISH: Are there loading states, error handling, empty states, hover effects? Or does it feel rough/unfinished?',
    '',
    'Score guide:',
    '- 1-3: Embarrassing — placeholder/skeleton, would never use this',
    '- 4-5: Below average — technically works but feels unfinished, ugly, or confusing',
    '- 6-7: Acceptable — functional and looks decent, minor rough edges',
    '- 8-9: Good — polished, professional, enjoyable to use',
    '- 10: Exceptional — delightful, exceeds expectations',
    '',
    'Set acceptable=true ONLY if score >= 7. Products below 7 need more work.',
    'If not acceptable, list specific issues the developer should fix (be concrete: "the timer button only console.logs", not "needs improvement").',
    '',
    'PACKAGING & DEPLOYMENT CHECK (auto-fail if any apply):',
    '- Chrome extensions: folders/files starting with _ or . (e.g., __tests__, .cache) will cause Chrome to REJECT the extension. Score 1 if present.',
    '- Chrome extensions: manifest.json must be valid with correct manifest_version, permissions, and script paths.',
    '- npm packages: package.json must have valid name, version, description, and real test scripts.',
    '- Any installable product: the install/setup process must actually work from scratch. Missing dependencies = auto-fail.',
    '- README must accurately describe the product and how to use it.',
    '',
    `Product objective: ${objective}`,
    `Workspace: ${workspaceRoot}`,
    '',
    `Latest build summary:\n${iterationSummary}`,
    artifactBlock,
  ].join('\n');

  try {
    const response = await callResponsesWithFallback({
      settings,
      model,
      callGuards,
      input: [
        {
          role: 'system',
          content: 'You are a discerning product user. Return JSON only. No markdown.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
    });

    const output = extractOutputText(settings.provider, response.payload);
    const jsonText = extractFirstJSONObject(output);
    if (!jsonText) {
      return { model: response.model, acceptable: true, score: 7, issues: [], verdict: 'Could not parse acceptance review.' };
    }

    const parsed = ensureObject(JSON.parse(jsonText));
    const score = Math.max(1, Math.min(10, parseInt(parsed.score, 10) || 5));
    return {
      model: response.model,
      acceptable: score >= 7,
      score,
      issues: Array.isArray(parsed.issues) ? parsed.issues.map((i) => String(i)) : [],
      verdict: String(parsed.verdict || '').trim() || 'No verdict provided.',
    };
  } catch {
    // On failure, don't block — let it pass
    return { model, acceptable: true, score: 7, issues: [], verdict: 'Acceptance review failed (non-blocking).' };
  }
}

// ---------------------------------------------------------------------------
// executeDelegateWithTools — mini ReAct loop for delegate subagents
// Gives the subagent access to read-only tools so it can inspect code,
// search files, and reason before answering.  No write/exec/delegate
// to prevent side effects and recursion.
// ---------------------------------------------------------------------------

const DELEGATE_BASE_TOOLS = new Set([
  'read_file', 'list_files', 'search_files', 'think',
]);
// QA delegates can execute — they need to actually run the app, not just read code.
const DELEGATE_QA_TOOLS = new Set([
  'read_file', 'list_files', 'search_files', 'think', 'run_playwright', 'browser_launch', 'browser_action', 'browser_close', 'run_command',
]);
function getDelegateTools(role) {
  if (role === 'qa') return DELEGATE_QA_TOOLS;
  return DELEGATE_BASE_TOOLS;
}
const DELEGATE_MAX_TURNS = 8;

async function executeDelegateWithTools({
  settings,
  model,
  role,
  roleLabel,
  roleInstructions,
  task,
  context,
  workspaceRoot,
  runId = '',
  callGuards = null,
  activeSkillContent = '',
}) {
  const allowedTools = getDelegateTools(role);
  const isQa = role === 'qa';
  const toolDocs = [
    '- read_file: {"tool":"read_file","args":{"path":"relative/path"}}',
    '- list_files: {"tool":"list_files","args":{"path":".","max_depth":2}}',
    '- search_files: {"tool":"search_files","args":{"pattern":"text","path":"optional/subdir"}}',
    '- think: {"tool":"think","args":{"thought":"reasoning..."}}',
  ];
  if (isQa) {
    toolDocs.push(
      '- run_command: {"tool":"run_command","args":{"command":"python3","args":["-m","http.server","8081","&"]}} — start a server or run shell commands',
      '- run_playwright: {"tool":"run_playwright","args":{"url":"http://localhost:8081","headless":true}} — load page in browser. ALWAYS check consoleErrorCount and consoleErrors in the result. If consoleErrorCount > 0, report every error.',
    );
  }
  const skillSection = activeSkillContent
    ? `\n=== ACTIVE SKILL (follow its Completion Criteria) ===\n${truncate(activeSkillContent, 1200)}\n===`
    : '';
  const systemPrompt = [
    `You are a ${roleLabel} specialist.`,
    roleInstructions,
    skillSection,
    '',
    isQa
      ? 'You MUST actually execute tests — do not just describe them. Use run_command to start a server if needed, then run_playwright to check for console errors. Report consoleErrors verbatim.'
      : 'You can use tools to inspect the codebase before answering.',
    'Available tools (return JSON to use them):',
    ...toolDocs,
    '',
    'To use a tool, respond with ONLY the JSON object above.',
    'When done, respond with plain text (no JSON). Be direct and actionable — specify exact fixes, not vague suggestions.',
    `You have up to ${DELEGATE_MAX_TURNS} tool calls. Be efficient.`,
  ].join('\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `${task}${context ? `\n\nContext:\n${context}` : ''}` },
  ];

  let finalAnswer = '';

  for (let turn = 0; turn < DELEGATE_MAX_TURNS + 1; turn++) {
    if (runId) throwIfRunStopped(runId);

    const result = await callResponsesWithFallback({
      settings,
      model,
      input: messages,
      label: `delegate-${role}`,
      callGuards,
      temperature: 0.1,
    });
    const outputText = extractOutputText(settings.provider || DEFAULT_PROVIDER, result);

    // Check if the response is a tool call (starts with { and has "tool" key)
    const trimmed = outputText.trim();
    let toolCall = null;
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.tool && allowedTools.has(parsed.tool)) {
          toolCall = parsed;
        }
      } catch {
        // Not valid JSON — treat as final answer
      }
    }

    if (!toolCall) {
      // This is the final answer
      finalAnswer = outputText;
      break;
    }

    // Execute the tool
    messages.push({ role: 'assistant', content: trimmed });

    try {
      const toolResult = await executeAction(
        { tool: toolCall.tool, exact_args: ensureObject(toolCall.args) },
        workspaceRoot,
        runId,
        false,
        { settings, model },
      );
      messages.push({
        role: 'user',
        content: `Tool result (${toolCall.tool}):\n${truncate(toolResult.output || toolResult.summary || '', 8000)}`,
      });
    } catch (toolErr) {
      if (toolErr instanceof StopRequestedError || toolErr instanceof BudgetLimitError) throw toolErr;
      messages.push({
        role: 'user',
        content: `Tool error (${toolCall.tool}): ${toolErr.message}`,
      });
    }
  }

  if (!finalAnswer) {
    finalAnswer = 'Delegate exhausted tool turns without providing a final answer.';
  }

  return {
    ok: true,
    summary: `${roleLabel} responded (with tool access)`,
    output: truncate(finalAnswer, 5000),
    metadata: { delegateRole: role, delegateTask: truncate(task, 200), toolCapable: true },
  };
}

// ---------------------------------------------------------------------------
// executePlannedActions
// ---------------------------------------------------------------------------

function extractBrowserStateFromMetadata(metadata = {}) {
  const meta = ensureObject(metadata);
  const hasBrowserState = Boolean(
    meta.pageUrl
    || meta.pageTitle
    || meta.screenshotPath
    || meta.downloadPath
    || (Array.isArray(meta.frames) && meta.frames.length > 0)
  );
  if (!hasBrowserState) return null;
  return {
    pageUrl: String(meta.pageUrl || ''),
    pageTitle: String(meta.pageTitle || ''),
    screenshotPath: String(meta.screenshotPath || ''),
    downloadPath: String(meta.downloadPath || ''),
    downloadFilename: String(meta.downloadFilename || ''),
    frames: Array.isArray(meta.frames)
      ? meta.frames.map((frame) => ({
        index: Number(frame.index),
        frameId: Number.isFinite(Number(frame.frameId)) ? Number(frame.frameId) : null,
        parentFrameId: Number.isFinite(Number(frame.parentFrameId)) ? Number(frame.parentFrameId) : null,
        url: String(frame.url || ''),
        errorOccurred: frame.errorOccurred === true,
      }))
      : [],
  };
}

// Wall-clock cap for the entire execution phase of one iteration.
// This prevents a batch of slow/stuck actions from blocking the loop for hours.
const EXECUTION_WALL_CLOCK_MS = 10 * 60 * 1000; // 10 minutes

async function executePlannedActions({
  settings,
  model,
  task,
  workspaceRoot,
  priorResults = [],
  planSummary,
  actions,
  allowRisky,
  securityControls = {},
  maxActions,
  teamMode = 'teams',
  callGuards = null,
  runMeta = {},
  activeSkillContent = '',
  objectiveGuards = null,
  heartbeatAction = null,
}) {
  const executionDeadline = Date.now() + EXECUTION_WALL_CLOCK_MS;
  const highRiskTemporarilyUnlocked = isTimedPermissionActive(securityControls.highRiskAutoApproveUntil);

  const normalizedPlan = {
    summary: String(planSummary || 'Agent plan'),
    actions: Array.isArray(actions) ? actions.map((action) => normalizeAction(action)) : [],
  };
  const smallChangeGuard = ensureObject(objectiveGuards && objectiveGuards.smallChange);
  const touchedPaths = new Set();
  let newFileCount = 0;
  const registerTouchedPath = (metadata = {}) => {
    if (!smallChangeGuard.enabled) return;
    const rel = String(metadata.path || '').trim();
    if (!rel) return;
    touchedPaths.add(rel);
    if (metadata.createdNewFile === true) {
      newFileCount += 1;
    }
  };

  if (normalizedPlan.actions.length === 0) {
    throw new Error('Plan is missing actions.');
  }

  // -----------------------------------------------------------------------
  // Inline adaptive retry — ask the model for an immediate fix when an action
  // fails, instead of waiting for the next full planning cycle.
  // -----------------------------------------------------------------------
  const MAX_INLINE_RETRIES = 2;
  function isLocalPlaywrightConnectivityError(failedAction, errorOutput) {
    if (!failedAction || failedAction.tool !== 'run_playwright') {
      return false;
    }
    const text = String(errorOutput || '').toLowerCase();
    const urlText = String(failedAction.exact_args?.url || '').toLowerCase();
    const hasLocalUrl = urlText.includes('localhost') || urlText.includes('127.0.0.1');
    const hasConnectivityError = (
      text.includes('err_empty_response')
      || text.includes('err_connection_refused')
      || text.includes('econnrefused')
      || text.includes('net::err')
      || text.includes('connection refused')
    );
    return hasLocalUrl && hasConnectivityError;
  }

  async function buildLocalPlaywrightServerRecoveryAction(failedAction) {
    const rawUrl = String(failedAction.exact_args?.url || '').trim();
    if (!rawUrl) return null;

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return null;
    }

    const host = String(parsed.hostname || '').toLowerCase();
    if (host !== 'localhost' && host !== '127.0.0.1') {
      return null;
    }

    const port = Number(parsed.port) || 8081;
    const rawPath = decodeURIComponent(String(parsed.pathname || '/'));
    const relPath = rawPath.replace(/^\/+/, '');
    const candidateFile = relPath ? path.resolve(workspaceRoot, relPath) : '';
    const candidateDirFromPath = relPath ? path.resolve(workspaceRoot, path.dirname(relPath)) : '';

    let serveDir = workspaceRoot;
    if (candidateFile) {
      try {
        const stat = await fs.stat(candidateFile);
        if (stat.isFile()) {
          serveDir = path.dirname(candidateFile);
        } else if (stat.isDirectory()) {
          serveDir = candidateFile;
        }
      } catch {
        // Keep fallback resolution.
      }
    }
    if (serveDir === workspaceRoot && candidateDirFromPath) {
      try {
        const stat = await fs.stat(candidateDirFromPath);
        if (stat.isDirectory()) {
          serveDir = candidateDirFromPath;
        }
      } catch {
        // Keep workspace root.
      }
    }

    // Safety belt: never serve outside the workspace root.
    if (!(serveDir === workspaceRoot || serveDir.startsWith(`${workspaceRoot}${path.sep}`))) {
      serveDir = workspaceRoot;
    }

    const escapedServeDir = serveDir.replace(/"/g, '\\"');
    const replayPath = `${parsed.pathname || '/'}${parsed.search || ''}${parsed.hash || ''}`
      .replace(/\\/g, '\\\\')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`')
      .replace(/"/g, '\\"');
    const hostCandidates = host === '127.0.0.1'
      ? ['127.0.0.1', 'localhost']
      : ['localhost', '127.0.0.1'];
    const hostCandidateList = hostCandidates.join(' ');
    const serveDirRel = path.relative(workspaceRoot, serveDir) || '.';
    const fallbackPorts = [8081, 8080, 3000, 5173, 4173]
      .filter((candidatePort) => Number(candidatePort) !== port)
      .slice(0, 4);
    const fallbackPortList = fallbackPorts.join(' ');
    const rollbackPorts = [port, ...fallbackPorts]
      .map((candidatePort) => `-ti:${candidatePort}`)
      .join(' ');
    const verifySeconds = 4;
    const script = [
      `SERVE_DIR="${escapedServeDir}"`,
      `PRIMARY_PORT=${port}`,
      `REPLAY_PATH="${replayPath}"`,
      `HOSTS="${hostCandidateList}"`,
      'PY_BIN="$(command -v python3 || command -v python3.11 || command -v python || true)"',
      'if [ -z "$PY_BIN" ]; then',
      '  echo "GEEPUS_RECOVERY_ERROR=no_python_runtime"',
      '  exit 0',
      'fi',
      'probe_url() {',
      '  local p="$1"',
      '  for h in $HOSTS; do',
      `    if curl -fsS --max-time ${verifySeconds} "http://$h:$p$REPLAY_PATH" >/dev/null 2>&1; then`,
      '      echo "http://$h:$p$REPLAY_PATH"',
      '      return 0',
      '    fi',
      '  done',
      '  return 1',
      '}',
      'start_server() {',
      '  nohup "$PY_BIN" -m http.server "$1" --directory "$SERVE_DIR" >/tmp/geepus-http-"$1".log 2>&1 &',
      '  sleep 0.9',
      '}',
      'lsof -ti:"$PRIMARY_PORT" | xargs kill -9 2>/dev/null || true',
      'sleep 0.2',
      'start_server "$PRIMARY_PORT"',
      'FOUND_URL="$(probe_url "$PRIMARY_PORT" || true)"',
      'if [ -n "$FOUND_URL" ]; then',
      '  echo "GEEPUS_RECOVERY_URL=$FOUND_URL"',
      '  exit 0',
      'fi',
      `for p in ${fallbackPortList}; do`,
      '  FOUND_URL="$(probe_url "$p" || true)"',
      '  if [ -n "$FOUND_URL" ]; then',
      '    echo "GEEPUS_RECOVERY_URL=$FOUND_URL"',
      '    exit 0',
      '  fi',
      '  start_server "$p"',
      '  FOUND_URL="$(probe_url "$p" || true)"',
      '  if [ -n "$FOUND_URL" ]; then',
      '    echo "GEEPUS_RECOVERY_URL=$FOUND_URL"',
      '    exit 0',
      '  fi',
      'done',
      'echo "GEEPUS_RECOVERY_URL=http://localhost:$PRIMARY_PORT$REPLAY_PATH"',
      'exit 0',
    ].join('\n');
    return normalizeAction({
      owner: 'qa',
      intent: `Recovery: start local HTTP server from ${serveDirRel}; if ${port} fails, probe fallback localhost ports before replay.`,
      tool: 'run_command',
      exact_args: {
        command: 'bash',
        args: ['-c', script],
        cwd: '.',
        timeout_ms: 20000,
      },
      expected_diff: `A reachable local server is available, preferring ${port} with localhost fallbacks.`,
      rollback_plan: `Stop recovery servers: lsof ${rollbackPorts} | xargs kill -9`,
      risk_level: 'low',
    });
  }

  function extractRecoveredLocalhostUrl(recoveryOutcome) {
    const combined = `${String(recoveryOutcome?.summary || '')}\n${String(recoveryOutcome?.output || '')}`;
    const match = combined.match(/GEEPUS_RECOVERY_URL=(https?:\/\/[^\s]+)/i);
    return match ? String(match[1]).trim() : '';
  }

function buildPlaywrightReplayActionAfterRecovery({
  failedAction,
  recoveryAction,
  recoveryOutcome,
    errorText,
  }) {
    if (!failedAction || failedAction.tool !== 'run_playwright') return null;
    if (!recoveryAction || recoveryAction.tool !== 'run_command') return null;
    if (!recoveryOutcome || recoveryOutcome.ok !== true) return null;
    if (!isLocalPlaywrightConnectivityError(failedAction, errorText)) return null;

    const replayAction = normalizeAction({
      ...failedAction,
      exact_args: { ...ensureObject(failedAction.exact_args) },
    });
    const recoveredUrl = extractRecoveredLocalhostUrl(recoveryOutcome);
    if (recoveredUrl) {
      replayAction.exact_args.url = recoveredUrl;
  }
  return replayAction;
}

  function summarizeLatestBrowserMetadataForRetry() {
    const browserEntries = (Array.isArray(priorResults) ? priorResults : [])
      .filter((entry) => entry && entry.ok === true)
      .filter((entry) => {
        const tool = String(entry.tool || '');
        return tool === 'browser_action' || tool === 'browser_launch';
      });
    const latest = browserEntries[browserEntries.length - 1];
    if (!latest) return '';
    const meta = ensureObject(latest.metadata);
    const lines = [
      'Latest browser metadata:',
      `- Tool: ${String(latest.tool || '')}`,
      `- Action: ${String(meta.action || 'launch')}`,
    ];
    if (meta.pageUrl) lines.push(`- URL: ${String(meta.pageUrl)}`);
    if (meta.pageTitle) lines.push(`- Title: ${String(meta.pageTitle)}`);
    if (meta.downloadPath) lines.push(`- Download: ${String(meta.downloadPath)}`);
    if (Array.isArray(meta.frames) && meta.frames.length > 0) {
      lines.push(`- Frames: ${meta.frames.map((frame) => {
        const frameId = Number.isFinite(Number(frame.frameId)) ? ` id=${Number(frame.frameId)}` : '';
        const parentFrameId = Number.isFinite(Number(frame.parentFrameId)) ? ` parent=${Number(frame.parentFrameId)}` : '';
        return `[${Number(frame.index)}${frameId}${parentFrameId}] ${String(frame.url || '')}`;
      }).join(' | ')}`);
    }
    if (meta.screenshotPath) lines.push(`- Screenshot: ${String(meta.screenshotPath)}`);
    return lines.join('\n');
  }

  async function attemptInlineRetry(failedAction, errorOutput, retryCount) {
    if (retryCount >= MAX_INLINE_RETRIES) return null;
    if (isRunStopRequested(runMeta.run_id || '')) return null;

    // Deterministic recovery for localhost Playwright connectivity failures:
    // start/verify local server first, without paying for another model call.
    if (isLocalPlaywrightConnectivityError(failedAction, errorOutput)) {
      const serverAction = await buildLocalPlaywrightServerRecoveryAction(failedAction);
      if (serverAction) {
        const serverPolicy = applySecurityControlsToPolicy(
          serverAction,
          evaluateActionPolicy(serverAction),
          securityControls,
        );
        if (serverPolicy.allowed) {
          return { action: serverAction, policy: serverPolicy };
        }
      }
    }

    const isPatchFileFailure = failedAction.tool === 'patch_file'
      && (errorOutput.includes('search string not found') || errorOutput.includes('not found in'));

    // For run_playwright with a file:// or non-http URL, directly inject the server-start action
    // as a deterministic recovery — no LLM call needed.
    const isFileUrlPlaywrightFailure = failedAction.tool === 'run_playwright'
      && errorOutput.includes('file://')
      && errorOutput.includes('Playwright requires http/https');
    if (isFileUrlPlaywrightFailure) {
      const badUrl = String(failedAction.exact_args?.url || '');
      const filePath = badUrl.replace(/^file:\/\//, '');
      const dir = filePath.includes('/') ? filePath.replace(/\/[^/]+$/, '') : '.';
      const file = filePath.includes('/') ? filePath.replace(/.*\//, '') : filePath;
      const serverAction = normalizeAction({
        owner: 'qa',
        intent: `Recovery: start HTTP server to serve ${file} so Playwright can load it via http://`,
        tool: 'run_command',
        exact_args: {
          command: 'bash',
          args: ['-c', `lsof -ti:8081 | xargs kill -9 2>/dev/null; sleep 0.3; python3 -m http.server 8081 --directory ${dir} &`],
          cwd: '.',
          timeout_ms: 8000,
        },
        expected_diff: 'HTTP server started on port 8081.',
        rollback_plan: 'lsof -ti:8081 | xargs kill -9',
        risk_level: 'low',
      });
      const serverPolicy = applySecurityControlsToPolicy(serverAction, evaluateActionPolicy(serverAction), securityControls);
      if (serverPolicy.allowed) return { action: serverAction, policy: serverPolicy };
    }

    // For patch_file "search string not found" — directly recover with read_file
    // so the next attempt can use write_file with exact content
    const patchRecoveryHint = isPatchFileFailure
      ? [
        '',
        'CRITICAL: patch_file failed because the search string does not match the actual file content.',
        'Do NOT retry patch_file. Instead use read_file to see the ACTUAL content of the file.',
        `Respond with: {"tool":"read_file","exact_args":{"path":"${failedAction.exact_args?.path || ''}"},"intent":"Recovery: read actual file content to fix with write_file"}`,
      ].join('\n')
      : '';

    const browserRecoveryHint = (
      String(failedAction?.tool || '') === 'browser_action'
      || String(failedAction?.tool || '') === 'browser_launch'
    ) ? summarizeLatestBrowserMetadataForRetry() : '';

    const retryPrompt = [
      'An action just failed. You must produce ONE alternative action (JSON) to accomplish the same goal a DIFFERENT way.',
      'Do NOT repeat the exact same action. Think creatively:',
      '- If a file path was wrong, try listing files first to find the right path',
      '- If a command failed, try a different command or install a missing dependency',
      '- If patch_file failed with "search string not found", use read_file to see the actual content, then write_file the corrected version',
      '- If a package is missing, install it',
      '- If permissions are denied, try a different approach entirely',
      '- If browser_action failed to find an element, do NOT blindly retry the same selector. Prefer: aria_snapshot -> frames (if iframe suspected) -> wait_for element/text -> try label/placeholder/name -> screenshot fallback only if semantic options fail',
      '- If a browser role+text query failed on a custom widget, the accessible name may differ from visible text because of aria-label or aria-labelledby. Use the accessible name shown in the ARIA snapshot',
      '- If clicking a combobox/dropdown succeeded but an option was not found yet, the next action should usually be wait_for with condition.element before clicking the option',
      patchRecoveryHint,
      browserRecoveryHint,
      '',
      `Failed action: ${failedAction.tool} — ${failedAction.intent}`,
      `Error: ${truncate(errorOutput, 400)}`,
      `Original goal: ${truncate(task, 300)}`,
      '',
      'Return ONE action as JSON: {"tool":"...","exact_args":{...},"intent":"Recovery: ..."}',
      'Available tools: list_files, read_file, write_file, patch_file, append_file, search_files, run_command, think, respond, http_request, web_search, web_scrape, run_playwright, browser_launch, browser_action, browser_close, analyze_image',
      'Return ONLY the JSON object, no markdown.',
    ].join('\n');

    try {
      const response = await callResponsesWithFallback({
        settings,
        model,
        input: retryPrompt,
        label: 'inline-retry',
        callGuards,
      });
      const text = extractOutputText(settings.provider || DEFAULT_PROVIDER, response);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]);
      const recoveryAction = normalizeAction(parsed);
      // Safety: don't allow the recovery to be the exact same action
      if (recoveryAction.tool === failedAction.tool &&
        JSON.stringify(recoveryAction.exact_args) === JSON.stringify(failedAction.exact_args)) {
        return null;
      }
      const policy = applySecurityControlsToPolicy(recoveryAction, evaluateActionPolicy(recoveryAction), securityControls);
      if (!policy.allowed) return null;
      return { action: recoveryAction, policy };
    } catch {
      return null; // Recovery generation failed — that's fine, continue normally
    }
  }

  const cappedActions = normalizedPlan.actions.slice(0, Math.max(1, maxActions));
  const actionsWithPolicy = cappedActions.map((action) => {
    const policy = applySecurityControlsToPolicy(action, evaluateActionPolicy(action), securityControls);
    return { action, policy };
  });

  // Handle denied actions gracefully — skip them with error results instead
  // of throwing and killing the entire execution batch.
  const denied = actionsWithPolicy.filter((entry) => !entry.policy.allowed);
  if (denied.length > 0) {
    for (const entry of denied) {
      await appendAuditEvent({
        type: 'agent_action_policy_skip',
        model,
        workspace_root: workspaceRoot,
        tool: entry.action.tool,
        reason: entry.policy.reason,
        task_summary: truncate(task, 400),
        ...runMeta,
      });
    }
  }
  // Remove denied actions from execution — they'll get skip results below
  const allowedActions = actionsWithPolicy.filter((entry) => entry.policy.allowed || entry.policy.allowed === 'gated');
  const deniedResults = denied.map((entry, idx) => ({
    index: idx + 1,
    owner: normalizeOwner(entry.action.owner) || inferOwnerFromAction(entry.action, teamMode),
    intent: entry.action.intent,
    tool: entry.action.tool,
    risk_level: entry.policy.effectiveRisk,
    ok: false,
    summary: `Skipped: ${entry.policy.reason}`,
    output: `Action was blocked by policy:\nReason: ${entry.policy.reason}\n${entry.action.tool === 'run_command'
      ? 'Note: the command you attempted is restricted. Use run_command with a different command, or ask the user for approval.'
      : `Tool "${entry.action.tool}" is not fully recognized or is blocked. To use standard external programs, use run_command with the program name as the command.`
      }`,
    metadata: { denied: true },
  }));

  // Per-action high-risk approval is handled inline in the execution loop below.
  // This allows the run to continue for low/medium-risk actions while only gating
  // individual high-risk ones with a native dialog prompt.

  const results = [...deniedResults];
  let stoppedByUser = false;
  for (let index = 0; index < allowedActions.length; index += 1) {
    throwIfRunStopped(runMeta.run_id || '');

    // Execution wall-clock cap — stop processing more actions if we've exceeded
    // the time limit. Already-collected results are returned normally so the
    // iteration still contributes useful context for the next planning cycle.
    if (Date.now() > executionDeadline) {
      console.warn(`[executePlannedActions] Wall-clock cap reached (${EXECUTION_WALL_CLOCK_MS / 1000}s). ${allowedActions.length - index} actions remaining — deferring to next iteration.`);
      results.push({
        index: index + 1,
        owner: normalizeOwner(allowedActions[index].action.owner) || 'engineering',
        intent: `Deferred: execution time limit reached (${EXECUTION_WALL_CLOCK_MS / 60000} min cap)`,
        tool: 'think',
        ok: false,
        summary: `Execution time limit reached — ${allowedActions.length - index} remaining actions deferred to next iteration.`,
        output: `The execution phase hit its ${EXECUTION_WALL_CLOCK_MS / 60000}-minute wall-clock cap. Reduce the number of actions per iteration or simplify them.`,
        metadata: { wallClockCapped: true },
      });
      break;
    }

    const entry = allowedActions[index];
    const owner = normalizeOwner(entry.action.owner) || inferOwnerFromAction(entry.action, teamMode);
    const tool = String(entry.action.tool || '').trim();
    const actionArgs = ensureObject(entry.action.exact_args || {});

    // Small-change guard: for iterative/simple edits, prevent project-wide rebuilds.
    if (smallChangeGuard.enabled) {
      const toAbsPath = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return { raw: '', abs: '', rel: '' };
        const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspaceRoot, raw);
        const rel = path.relative(workspaceRoot, abs);
        return { raw, abs, rel };
      };

      if (smallChangeGuard.forbidScaffoldCommands && tool === 'run_command') {
        const command = String(actionArgs.command || '').toLowerCase();
        const argsText = Array.isArray(actionArgs.args)
          ? actionArgs.args.map((item) => String(item).toLowerCase()).join(' ')
          : '';
        const cmdText = `${command} ${argsText}`;
        const scaffoldSignals = [
          'npm init', 'git init', 'git clone', 'create-react-app', 'create-next-app',
          'create-vite', 'npx create', 'pnpm create', 'yarn create', 'flutter create',
          'vite@latest', 'scaffold', 'start over',
        ];
        if (scaffoldSignals.some((signal) => cmdText.includes(signal))) {
          const summary = 'Blocked by small-change guard: rebuild/scaffolding command is not allowed for iterative edits.';
          results.push({
            index: index + 1,
            owner,
            intent: entry.action.intent,
            tool: entry.action.tool,
            risk_level: entry.policy.effectiveRisk,
            ok: false,
            summary,
            output: `Blocked command: ${truncate(cmdText, 180)}`,
            metadata: { guardBlocked: 'small_change_scaffold' },
          });
          if (runMeta.run_id) {
            broadcastWatchEvent(runMeta.run_id, {
              type: 'action_finished',
              iteration: runMeta.iteration || 0,
              actionIndex: index + 1,
              owner,
              tool: entry.action.tool,
              intent: entry.action.intent,
              ok: false,
              summary,
            }, { state: 'running', model, workspaceRoot });
          }
          continue;
        }
      }

      if (tool === 'write_file' || tool === 'patch_file' || tool === 'append_file') {
        const p = toAbsPath(actionArgs.path);
        if (p.rel && !p.rel.startsWith('..')) {
          const alreadyTouched = touchedPaths.has(p.rel);
          const maxTouchedFiles = Number(smallChangeGuard.maxTouchedFiles || 4);
          if (!alreadyTouched && touchedPaths.size >= maxTouchedFiles) {
            const summary = `Blocked by small-change guard: touching more than ${maxTouchedFiles} files in one iteration.`;
            results.push({
              index: index + 1,
              owner,
              intent: entry.action.intent,
              tool: entry.action.tool,
              risk_level: entry.policy.effectiveRisk,
              ok: false,
              summary,
              output: `Blocked path: ${p.rel}`,
              metadata: { guardBlocked: 'small_change_touch_limit', path: p.rel },
            });
            continue;
          }

          if (tool === 'write_file') {
            let exists = false;
            try {
              await fs.access(p.abs);
              exists = true;
            } catch {
              exists = false;
            }

            if (exists && smallChangeGuard.requirePatchForExisting) {
              const isArtifact = p.rel.startsWith('artifacts/') || p.rel.startsWith('tmp/');
              if (!isArtifact) {
                const summary = 'Blocked by small-change guard: use patch_file for existing files instead of full write_file rewrite.';
                results.push({
                  index: index + 1,
                  owner,
                  intent: entry.action.intent,
                  tool: entry.action.tool,
                  risk_level: entry.policy.effectiveRisk,
                  ok: false,
                  summary,
                  output: `Existing file: ${p.rel}`,
                  metadata: { guardBlocked: 'small_change_require_patch', path: p.rel },
                });
                continue;
              }
            }

            if (!exists) {
              const maxNewFiles = Number(smallChangeGuard.maxNewFiles || 1);
              if (newFileCount >= maxNewFiles) {
                const summary = `Blocked by small-change guard: creating more than ${maxNewFiles} new files is out of scope.`;
                results.push({
                  index: index + 1,
                  owner,
                  intent: entry.action.intent,
                  tool: entry.action.tool,
                  risk_level: entry.policy.effectiveRisk,
                  ok: false,
                  summary,
                  output: `New file blocked: ${p.rel}`,
                  metadata: { guardBlocked: 'small_change_new_file_limit', path: p.rel },
                });
                continue;
              }
            }
          }
        }
      }
    }

    // Update the heartbeat ref so the Chief card shows what's happening right now
    if (heartbeatAction) {
      heartbeatAction.tool = entry.action.tool || '';
      heartbeatAction.intent = entry.action.intent || '';
      heartbeatAction.owner = owner;
      heartbeatAction.index = index + 1;
      heartbeatAction.total = allowedActions.length;
    }

    if (runMeta.run_id) {
      broadcastWatchEvent(runMeta.run_id, {
        type: 'action_started',
        iteration: runMeta.iteration || 0,
        actionIndex: index + 1,
        owner,
        tool: entry.action.tool,
        intent: entry.action.intent,
      }, {
        state: 'running',
        model,
        workspaceRoot,
      });
    }
    try {
      if (callGuards && typeof callGuards.beforeToolCall === 'function') {
        await callGuards.beforeToolCall(entry.action);
      }

      // -----------------------------------------------------------------------
      // Per-action high-risk gate — prompt the user with a native dialog
      // -----------------------------------------------------------------------
      if (entry.policy.effectiveRisk === 'high' && !(allowRisky || highRiskTemporarilyUnlocked)) {
        // Send desktop notification to grab attention
        if (Notification.isSupported()) {
          const note = new Notification({
            title: 'Geepus needs approval',
            body: `High-risk action: ${entry.action.tool} — ${truncate(entry.action.intent, 120)}`,
            subtitle: 'Action requires your OK',
            silent: false,
          });
          note.show();
        }

        const parentWin = BrowserWindow.getAllWindows().find(w => !w.isDestroyed()) || null;
        const dialogResult = await dialog.showMessageBox(parentWin, {
          type: 'warning',
          title: 'High-Risk Action — Approval Required',
          message: `${entry.action.tool}: ${entry.action.intent}`,
          detail: [
            `Risk: ${entry.policy.effectiveRisk}`,
            `Reason: ${entry.policy.reason}`,
            '',
            `Tool: ${entry.action.tool}`,
            `Args: ${JSON.stringify(entry.action.exact_args || {}, null, 2).slice(0, 400)}`,
          ].join('\n'),
          buttons: ['Allow', 'Skip', 'Allow All Remaining'],
          defaultId: 0,
          cancelId: 1,
        });

        if (dialogResult.response === 1) {
          // User chose Skip
          await appendAuditEvent({
            type: 'agent_action_denied',
            model,
            workspace_root: workspaceRoot,
            action_index: index + 1,
            owner,
            tool: entry.action.tool,
            intent: truncate(entry.action.intent, 240),
            risk: entry.policy.effectiveRisk,
            ...runMeta,
          });
          results.push({
            index: index + 1,
            owner,
            intent: entry.action.intent,
            tool: entry.action.tool,
            risk_level: entry.policy.effectiveRisk,
            ok: false,
            summary: 'Skipped by user (high-risk action denied).',
            output: '',
            metadata: { denied: true },
          });
          if (runMeta.run_id) {
            broadcastWatchEvent(runMeta.run_id, {
              type: 'action_finished',
              iteration: runMeta.iteration || 0,
              actionIndex: index + 1,
              owner,
              tool: entry.action.tool,
              intent: entry.action.intent,
              ok: false,
              summary: 'Denied by user.',
            }, { state: 'running', model, workspaceRoot });
          }
          continue;
        }
        if (dialogResult.response === 2) {
          // User chose "Allow All Remaining" — upgrade to allowRisky for rest of iteration
          allowRisky = true;
        }
        // dialogResult.response === 0 → Allow, fall through to execute
      }

      // -----------------------------------------------------------------------
      // Delegate tool — run a specialist subagent with tool access
      // The subagent gets a mini ReAct loop with read-only tools (read_file,
      // list_files, search_files, think) so it can gather real context before
      // answering.  No write/exec/delegate to prevent side effects & recursion.
      // -----------------------------------------------------------------------
      let outcome;
      if (entry.action.tool === 'delegate') {
        const delegateArgs = ensureObject(entry.action.exact_args);
        const delegateRole = String(delegateArgs.role || 'engineering').toLowerCase();
        const delegateTask = String(delegateArgs.task || delegateArgs.question || '');
        const delegateContext = delegateArgs.context ? String(delegateArgs.context) : '';

        // Find the matching role prompt from TEAM_PROMPTS
        const rolePrompt = TEAM_PROMPTS.find(p => p.role === delegateRole);
        const roleInstructions = rolePrompt
          ? rolePrompt.instructions
          : `You are a ${delegateRole} specialist. Provide expert analysis.`;

        if (runMeta.run_id) {
          broadcastWatchEvent(runMeta.run_id, {
            type: 'delegate_started',
            iteration: runMeta.iteration || 0,
            owner: delegateRole,
            task: truncate(delegateTask, 200),
          }, { state: 'running', model, workspaceRoot });
        }

        try {
          outcome = await executeDelegateWithTools({
            settings,
            model,
            role: delegateRole,
            roleLabel: rolePrompt ? rolePrompt.label : delegateRole,
            roleInstructions,
            task: delegateTask,
            context: delegateContext,
            workspaceRoot,
            runId: runMeta.run_id || '',
            callGuards,
            activeSkillContent,
          });
        } catch (delegateErr) {
          if (delegateErr instanceof StopRequestedError || delegateErr instanceof BudgetLimitError) throw delegateErr;
          outcome = {
            ok: false,
            summary: `Delegate ${delegateRole} failed: ${delegateErr.message}`,
            output: String(delegateErr.message),
            metadata: { delegateRole, error: true },
          };
        }

        if (runMeta.run_id) {
          broadcastWatchEvent(runMeta.run_id, {
            type: 'delegate_finished',
            iteration: runMeta.iteration || 0,
            owner: delegateRole,
            ok: outcome.ok,
            summary: truncate(outcome.summary, 200),
          }, { state: 'running', model, workspaceRoot });
        }
      } else {
        outcome = await executeAction(entry.action, workspaceRoot, runMeta.run_id || '', (allowRisky || highRiskTemporarilyUnlocked), {
          settings,
          model,
          securityControls,
        });
      }
      await appendAuditEvent({
        type: 'agent_action_executed',
        model,
        workspace_root: workspaceRoot,
        action_index: index + 1,
        owner,
        tool: entry.action.tool,
        intent: truncate(entry.action.intent, 240),
        risk: entry.policy.effectiveRisk,
        ok: outcome.ok,
        ...runMeta,
      });
      results.push({
        index: index + 1,
        owner,
        intent: entry.action.intent,
        tool: entry.action.tool,
        expected_diff: entry.action.expected_diff,
        rollback_plan: entry.action.rollback_plan,
        risk_level: entry.policy.effectiveRisk,
        ok: outcome.ok,
        summary: outcome.summary,
        output: truncate(outcome.output || '', 5000),
        metadata: ensureObject(outcome.metadata),
      });
      registerTouchedPath(ensureObject(outcome.metadata));

      if (runMeta.run_id) {
        const browserState = extractBrowserStateFromMetadata(outcome.metadata);
        broadcastWatchEvent(runMeta.run_id, {
          type: 'action_finished',
          iteration: runMeta.iteration || 0,
          actionIndex: index + 1,
          owner,
          tool: entry.action.tool,
          intent: entry.action.intent,
          ok: outcome.ok,
          summary: outcome.summary,
          browserState,
        }, {
          state: outcome.ok ? 'running' : 'running',
          model,
          workspaceRoot,
        });
      }

      // Don't break on failure — try inline recovery first, then continue.
      if (!outcome.ok) {
        // Attempt an immediate adaptive retry
        const recovery = await attemptInlineRetry(entry.action, outcome.output || outcome.summary || '', 0);
        if (recovery) {
          if (runMeta.run_id) {
            broadcastWatchEvent(runMeta.run_id, {
              type: 'action_started',
              iteration: runMeta.iteration || 0,
              actionIndex: index + 1,
              owner: normalizeOwner(recovery.action.owner) || owner,
              tool: recovery.action.tool,
              intent: `[Auto-retry] ${recovery.action.intent}`,
            }, { state: 'running', model, workspaceRoot });
          }
          try {
            if (callGuards && typeof callGuards.beforeToolCall === 'function') {
              await callGuards.beforeToolCall(recovery.action);
            }
            const retryOutcome = await executeAction(recovery.action, workspaceRoot, runMeta.run_id || '', (allowRisky || highRiskTemporarilyUnlocked), {
              settings,
              model,
              securityControls,
            });
            results.push({
              index: index + 1,
              owner: normalizeOwner(recovery.action.owner) || owner,
              intent: `[Auto-retry] ${recovery.action.intent}`,
              tool: recovery.action.tool,
              expected_diff: recovery.action.expected_diff,
              rollback_plan: recovery.action.rollback_plan,
              risk_level: recovery.policy.effectiveRisk,
              ok: retryOutcome.ok,
              summary: retryOutcome.summary,
              output: truncate(retryOutcome.output || '', 5000),
              metadata: { ...ensureObject(retryOutcome.metadata), isAutoRetry: true },
            });
            registerTouchedPath(ensureObject(retryOutcome.metadata));
            if (runMeta.run_id) {
              const retryBrowserState = extractBrowserStateFromMetadata(retryOutcome.metadata);
              broadcastWatchEvent(runMeta.run_id, {
                type: 'action_finished',
                iteration: runMeta.iteration || 0,
                actionIndex: index + 1,
                owner: normalizeOwner(recovery.action.owner) || owner,
                tool: recovery.action.tool,
                intent: `[Auto-retry] ${recovery.action.intent}`,
                ok: retryOutcome.ok,
                summary: retryOutcome.summary,
                browserState: retryBrowserState,
              }, { state: 'running', model, workspaceRoot });
            }

            const replayAction = buildPlaywrightReplayActionAfterRecovery({
              failedAction: entry.action,
              recoveryAction: recovery.action,
              recoveryOutcome: retryOutcome,
              errorText: outcome.output || outcome.summary || '',
            });
            if (replayAction) {
              const replayOutcome = await executeAction(replayAction, workspaceRoot, runMeta.run_id || '', (allowRisky || highRiskTemporarilyUnlocked), {
                settings,
                model,
                securityControls,
              });
              results.push({
                index: index + 1,
                owner,
                intent: `[Auto-retry] Replay ${replayAction.intent}`,
                tool: replayAction.tool,
                expected_diff: replayAction.expected_diff,
                rollback_plan: replayAction.rollback_plan,
                risk_level: entry.policy.effectiveRisk,
                ok: replayOutcome.ok,
                summary: replayOutcome.summary,
                output: truncate(replayOutcome.output || '', 5000),
                metadata: { ...ensureObject(replayOutcome.metadata), isAutoRetryReplay: true },
              });
              registerTouchedPath(ensureObject(replayOutcome.metadata));
              if (runMeta.run_id) {
                const replayBrowserState = extractBrowserStateFromMetadata(replayOutcome.metadata);
                broadcastWatchEvent(runMeta.run_id, {
                  type: 'action_finished',
                  iteration: runMeta.iteration || 0,
                  actionIndex: index + 1,
                  owner,
                  tool: replayAction.tool,
                  intent: `[Auto-retry] Replay ${replayAction.intent}`,
                  ok: replayOutcome.ok,
                  summary: replayOutcome.summary,
                  browserState: replayBrowserState,
                }, { state: 'running', model, workspaceRoot });
              }
            }
          } catch (retryErr) {
            if (retryErr instanceof StopRequestedError || retryErr instanceof BudgetLimitError) throw retryErr;
            // Inline retry also failed — that's fine, move on
          }
        }
      }
    } catch (error) {
      if (error instanceof BudgetLimitError) {
        throw error;
      }
      if (error instanceof StopRequestedError) {
        stoppedByUser = true;
        results.push({
          index: index + 1,
          owner,
          intent: entry.action.intent,
          tool: entry.action.tool,
          expected_diff: entry.action.expected_diff,
          rollback_plan: entry.action.rollback_plan,
          risk_level: entry.policy.effectiveRisk,
          ok: false,
          summary: 'Stopped by user',
          output: String(error.message || error),
          metadata: {},
        });
        if (runMeta.run_id) {
          broadcastWatchEvent(runMeta.run_id, {
            type: 'run_stop_requested',
            iteration: runMeta.iteration || 0,
            owner: 'chief',
            summary: String(error.message || 'Stop requested by user.'),
          }, {
            state: 'stopped',
            model,
            workspaceRoot,
          });
        }
        break;
      }
      await appendAuditEvent({
        type: 'agent_action_failed',
        model,
        workspace_root: workspaceRoot,
        action_index: index + 1,
        owner,
        tool: entry.action.tool,
        intent: truncate(entry.action.intent, 240),
        risk: entry.policy.effectiveRisk,
        ok: false,
        error: truncate(error.message || String(error), 500),
        ...runMeta,
      });
      results.push({
        index: index + 1,
        owner,
        intent: entry.action.intent,
        tool: entry.action.tool,
        expected_diff: entry.action.expected_diff,
        rollback_plan: entry.action.rollback_plan,
        risk_level: entry.policy.effectiveRisk,
        ok: false,
        summary: 'Execution failed',
        output: String(error.message || error),
        metadata: {},
      });

      if (runMeta.run_id) {
        broadcastWatchEvent(runMeta.run_id, {
          type: 'action_finished',
          iteration: runMeta.iteration || 0,
          actionIndex: index + 1,
          owner,
          tool: entry.action.tool,
          intent: entry.action.intent,
          ok: false,
          summary: String(error.message || error),
        }, {
          state: 'running',
          model,
          workspaceRoot,
        });
      }
      // Don't break on failure — try inline recovery, then continue
      const recovery = await attemptInlineRetry(entry.action, String(error.message || error), 0);
      if (recovery) {
        try {
          if (callGuards && typeof callGuards.beforeToolCall === 'function') {
            await callGuards.beforeToolCall(recovery.action);
          }
          if (runMeta.run_id) {
            broadcastWatchEvent(runMeta.run_id, {
              type: 'action_started',
              iteration: runMeta.iteration || 0,
              actionIndex: index + 1,
              owner: normalizeOwner(recovery.action.owner) || owner,
              tool: recovery.action.tool,
              intent: `[Auto-retry] ${recovery.action.intent}`,
            }, { state: 'running', model, workspaceRoot });
          }
          const retryOutcome = await executeAction(recovery.action, workspaceRoot, runMeta.run_id || '', (allowRisky || highRiskTemporarilyUnlocked), {
            settings,
            model,
            securityControls,
          });
          results.push({
            index: index + 1,
            owner: normalizeOwner(recovery.action.owner) || owner,
            intent: `[Auto-retry] ${recovery.action.intent}`,
            tool: recovery.action.tool,
            expected_diff: recovery.action.expected_diff,
            rollback_plan: recovery.action.rollback_plan,
            risk_level: recovery.policy.effectiveRisk,
            ok: retryOutcome.ok,
            summary: retryOutcome.summary,
            output: truncate(retryOutcome.output || '', 5000),
            metadata: { ...ensureObject(retryOutcome.metadata), isAutoRetry: true },
          });
          registerTouchedPath(ensureObject(retryOutcome.metadata));
          if (runMeta.run_id) {
            broadcastWatchEvent(runMeta.run_id, {
              type: 'action_finished',
              iteration: runMeta.iteration || 0,
              actionIndex: index + 1,
              owner: normalizeOwner(recovery.action.owner) || owner,
              tool: recovery.action.tool,
              intent: `[Auto-retry] ${recovery.action.intent}`,
              ok: retryOutcome.ok,
              summary: retryOutcome.summary,
            }, { state: 'running', model, workspaceRoot });
          }

          const replayAction = buildPlaywrightReplayActionAfterRecovery({
            failedAction: entry.action,
            recoveryAction: recovery.action,
            recoveryOutcome: retryOutcome,
            errorText: String(error.message || error),
          });
          if (replayAction) {
            const replayOutcome = await executeAction(replayAction, workspaceRoot, runMeta.run_id || '', (allowRisky || highRiskTemporarilyUnlocked), {
              settings,
              model,
              securityControls,
            });
            results.push({
              index: index + 1,
              owner,
              intent: `[Auto-retry] Replay ${replayAction.intent}`,
              tool: replayAction.tool,
              expected_diff: replayAction.expected_diff,
              rollback_plan: replayAction.rollback_plan,
              risk_level: entry.policy.effectiveRisk,
              ok: replayOutcome.ok,
              summary: replayOutcome.summary,
              output: truncate(replayOutcome.output || '', 5000),
              metadata: { ...ensureObject(replayOutcome.metadata), isAutoRetryReplay: true },
            });
            registerTouchedPath(ensureObject(replayOutcome.metadata));
            if (runMeta.run_id) {
              broadcastWatchEvent(runMeta.run_id, {
                type: 'action_finished',
                iteration: runMeta.iteration || 0,
                actionIndex: index + 1,
                owner,
                tool: replayAction.tool,
                intent: `[Auto-retry] Replay ${replayAction.intent}`,
                ok: replayOutcome.ok,
                summary: replayOutcome.summary,
              }, { state: 'running', model, workspaceRoot });
            }
          }
        } catch (retryErr) {
          if (retryErr instanceof StopRequestedError || retryErr instanceof BudgetLimitError) throw retryErr;
        }
      }
    }
  }

  // Iteration is 'completed' if at least some actions ran successfully.
  // Individual failures are noted in results but don't stop the entire iteration.
  // Only fully failed iterations (0 successes) count as 'stopped'.
  const anySuccess = results.some((entry) => entry.ok);
  const finalState = anySuccess ? 'completed' : 'stopped';
  return {
    requiresApproval: false,
    state: finalState,
    stoppedByUser,
    stopReason: stoppedByUser ? (getRunStopReason(runMeta.run_id || '') || 'Stopped by user request.') : '',
    summary: normalizedPlan.summary,
    model,
    results,
  };
}

// ---------------------------------------------------------------------------
// runObjectiveCore
// ---------------------------------------------------------------------------

async function runObjectiveCore(settings, request) {
  const resumeRunId = typeof request?.resumeRunId === 'string' ? request.resumeRunId.trim() : '';
  const requestedExecutionMode = normalizeExecutionMode(request?.executionMode || 'action');
  const requestedExecutionCore = normalizeExecutionCore(request?.executionCore || settings.executionCore || 'geepus');
  // Auto mode always allows risky actions (trusted autonomous execution)
  const allowRisky = request?.allowRisky === true || requestedExecutionMode === 'auto';
  // Auto mode: detect the best team from the objective instead of using user selection
  const selectedTeamMode = request?.teamMode === 'solo'
    ? 'solo'
    : requestedExecutionMode === 'auto'
      ? detectTeamMode(String(request?.task || ''))
      : (settings.teamMode || 'dev');
  const requestThreadContext = typeof request?.threadContext === 'string' ? request.threadContext.trim() : '';
  const onProgress = typeof request?.onProgress === 'function' ? request.onProgress : null;
  const sessionStartedAt = Date.now();
  const resumeBudgetAdjustments = [];

  if (!resumeRunId && activeRunIds.size > 0) {
    const existingRunId = Array.from(activeRunIds)[0] || '';
    throw new Error(
      `A task is already running (${existingRunId}). Click Stop, then start a new task.`,
    );
  }

  let runState;
  if (resumeRunId) {
    if (activeRunIds.has(resumeRunId)) {
      throw new Error(`Run ${resumeRunId} is already active.`);
    }
    try {
      runState = await readRunState(resumeRunId);
    } catch {
      throw new Error(`Run not found: ${resumeRunId}`);
    }
    if (runState.state === 'completed') {
      throw new Error(`Run ${resumeRunId} is already completed.`);
    }
    if (runState.state === 'needs_info' && runState.reason === 'Budget limit reached.') {
      const answer = String(requestThreadContext || '').trim().toLowerCase();
      if (answer === 'yes' || answer === 'y') {
        runState.provider = 'ollama';
        runState.model = '';
        runState.reason = 'Switched to local model after budget limit reached.';
        // Clear the budget limit so it doesn't immediately trigger again
        if (runState.runLimits) {
          runState.runLimits.budgetLimit = 0;
        }
        if (request && request.runLimits) {
          request.runLimits.budgetLimit = 0;
        }
      } else if (answer === 'no' || answer === 'n') {
        throw new StopRequestedError('Stopped by user at budget limit.');
      }
    }
  } else {
    const objective = String(request?.task || '').trim();
    if (!objective) {
      throw new Error('Please provide an objective first.');
    }
    const threadContext = truncate(requestThreadContext, 4000);
    const _initProviderRaw = String(request?.provider || '').trim().toLowerCase();
    const effectiveProvider = normalizeProvider((_initProviderRaw === 'auto' ? '' : _initProviderRaw) || settings.provider);
    const isLocal = effectiveProvider === 'ollama';
    const limitsDefaults = isLocal ? LOCAL_RUN_LIMITS : DEFAULT_RUN_LIMITS;
    const initialLimits = normalizeRunLimits(request?.runLimits, settings.runLimits || limitsDefaults, { provider: effectiveProvider });
    const initialNextFocus = threadContext
      ? `${objective}\n\nConversation context:\n${threadContext}`
      : objective;
    runState = {
      runId: crypto.randomUUID(),
      objective,
      state: 'running',
      reason: '',
      nextFocus: initialNextFocus,
      iterations: [],
      results: [],
      remainingActions: initialLimits.maxActions,
      maxIterations: initialLimits.maxIterations,
      maxRuntimeMinutes: initialLimits.maxRuntimeMinutes,
      maxModelCallsPerMinute: initialLimits.maxModelCallsPerMinute,
      maxToolCallsPerMinute: initialLimits.maxToolCallsPerMinute,
      idleTimeoutSeconds: initialLimits.idleTimeoutSeconds,
      consecutiveDriftLimit: initialLimits.consecutiveDriftLimit,
      consecutiveDriftIterations: 0,
      runLimits: initialLimits,
      lastProgressAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      teamMode: selectedTeamMode,
      executionMode: requestedExecutionMode,
      executionCore: requestedExecutionCore,
      provider: normalizeProvider(request?.provider || settings.provider),
      baseUrl: normalizeBaseUrl(request?.baseUrl || settings.baseUrl, request?.provider || settings.provider),
      threadContext,
      readiness: null,
    };
  }

  const activeRunId = String(runState.runId || '');
  if (activeRunId) {
    activeRunIds.add(activeRunId);
    clearRunStopRequest(activeRunId);
  }

  if (activeRunId) {
    await appendRunDebugEvent(activeRunId, resumeRunId ? 'run_resumed' : 'run_started', {
      objective: String(runState.objective || ''),
      executionMode: String(runState.executionMode || ''),
      executionCore: String(runState.executionCore || ''),
      provider: String(runState.provider || ''),
      model: String(runState.model || ''),
      workspaceRoot: String(runState.workspaceRoot || request?.workspaceRoot || ''),
      teamMode: String(runState.teamMode || ''),
      threadContext: String(runState.threadContext || ''),
      resumeRunId: resumeRunId || '',
      requestedTask: String(request?.task || ''),
      requestWorkspaceRoot: String(request?.workspaceRoot || ''),
    }).catch(() => {});
  }

  try {
    const objective = String(runState.objective || '').trim();
    if (!objective) {
      throw new Error('Run objective is empty.');
    }
    const effectiveThreadContext = truncate(
      String(requestThreadContext || runState.threadContext || '').trim(),
      4000,
    );
    runState.threadContext = effectiveThreadContext;
    runState.executionMode = resumeRunId
      ? normalizeExecutionMode(runState.executionMode || requestedExecutionMode)
      : requestedExecutionMode;
    runState.executionCore = normalizeExecutionCore(
      request?.executionCore || runState.executionCore || settings.executionCore || requestedExecutionCore,
    );
    // Non-technical users often leave the mode on Research while asking to build.
    // Auto-correct obvious build objectives so Geepus executes instead of looping in research.
    if (runState.executionMode === 'research' && objectiveLooksLikeBuildRequest(objective)) {
      runState.executionMode = 'action';
      runState.reason = 'Auto-switched to Action Mode because this objective requests implementation.';
    }
    const objectivePolicy = applyExecutionModePolicy(
      detectObjectivePolicy(objective),
      runState.executionMode,
    );
    const objectivePolicyNotes = objectivePolicyPrompt(objectivePolicy);
    // LLM-based task classification — runs once per new run, cached on runState.
    // Drives validateNanobotPlan and the completion gate so the whole system
    // uses LLM understanding rather than keyword regex.
    if (!runState.taskClass && !resumeRunId) {
      try {
        const classifyMessages = [
          {
            role: 'system',
            content: [
              'You are a task classifier. Classify the user\'s objective into exactly one category:',
              '  conversational — a greeting, small talk, or question needing only a direct reply',
              '  lookup        — fetch info, check status, answer a factual question, search',
              '  research      — investigate, analyze, compile a report from multiple sources',
              '  operations    — send email/message, schedule, manage files or external services',
              '  build         — create, implement, fix, or refactor code, apps, or websites',
              '  general       — anything that does not clearly fit the above',
              'Reply with exactly one word from the list above.',
            ].join('\n'),
          },
          { role: 'user', content: objective },
        ];
        const { payload: classifyPayload } = await callResponsesWithFallback({
          settings,
          model,
          input: classifyMessages,
          temperature: 0,
        });
        const raw = extractOutputText(settings.provider, classifyPayload).trim().toLowerCase();
        const VALID_CLASSES = new Set(['conversational', 'lookup', 'research', 'operations', 'build', 'general']);
        runState.taskClass = VALID_CLASSES.has(raw) ? raw : 'general';
        console.log(`[agent-loop] Task classified as: ${runState.taskClass} for "${objective.slice(0, 60)}"`);
      } catch (classifyErr) {
        console.warn('[agent-loop] Task classification failed, falling back to inferRunTaskClass:', classifyErr?.message);
        runState.taskClass = inferRunTaskClass({ objective, executionMode: runState.executionMode, objectivePolicy });
      }
    }
    const activeLearnedStrategies = selectRelevantLearnedStrategies(settings.userProfile || {}, {
      objective,
      executionMode: runState.executionMode,
      objectivePolicy,
    });
    const activeCrossRunBans = relevantCrossRunBannedApproaches(settings.userProfile || {}, {
      objective,
      executionMode: runState.executionMode,
      objectivePolicy,
    });

    runState.iterations = Array.isArray(runState.iterations) ? runState.iterations : [];
    runState.results = Array.isArray(runState.results) ? runState.results : [];
    runState.readiness = runState.readiness && typeof runState.readiness === 'object' ? runState.readiness : null;
    runState.nativeRuntimeState = runState.nativeRuntimeState && typeof runState.nativeRuntimeState === 'object'
      ? { ...runState.nativeRuntimeState }
      : null;
    runState.activeLearnedStrategies = activeLearnedStrategies.slice(0, 6);
    runState.activeBannedApproaches = activeCrossRunBans.slice(0, 6);
    runState.nextFocus = String(runState.nextFocus || objective);
    if (effectiveThreadContext && runState.iterations.length === 0) {
      const nextFocusLower = runState.nextFocus.toLowerCase();
      if (!nextFocusLower.includes('conversation context:')) {
        runState.nextFocus = `${objective}\n\nConversation context:\n${effectiveThreadContext}`;
      }
    }
    const requestedTeamMode = String(request?.teamMode || '').trim().toLowerCase();
    const inferredTeamMode = detectTeamMode(`${objective}\n${effectiveThreadContext}`);
    const forceResearchTeam = runState.executionMode === 'research'
      || objectivePolicy.researchOnly
      || objectivePolicy.noBuild;
    if (requestedTeamMode === 'solo' || runState.teamMode === 'solo') {
      runState.teamMode = 'solo';
    } else if (forceResearchTeam) {
      runState.teamMode = 'research';
    } else if (!resumeRunId && (!requestedTeamMode || requestedTeamMode === 'teams' || requestedTeamMode === 'dev')) {
      runState.teamMode = inferredTeamMode || selectedTeamMode || 'dev';
    } else if (requestedTeamMode) {
      runState.teamMode = requestedTeamMode;
    } else {
      runState.teamMode = runState.teamMode || selectedTeamMode || 'dev';
    }
    const _reqProviderRaw = String(request?.provider || '').trim().toLowerCase();
    const _reqProvider = _reqProviderRaw === 'auto' ? '' : _reqProviderRaw;
    runState.provider = normalizeProvider(_reqProvider || runState.provider || settings.provider);
    const requestedRunLimits = {
      ...(ensureObject(request?.runLimits)),
    };
    if (request?.maxIterations !== undefined) {
      requestedRunLimits.maxIterations = request.maxIterations;
    }
    if (request?.maxRuntimeMinutes !== undefined) {
      requestedRunLimits.maxRuntimeMinutes = request.maxRuntimeMinutes;
    }
    if (request?.maxActions !== undefined) {
      requestedRunLimits.maxActions = request.maxActions;
    }
    const runProvider = normalizeProvider(runState.provider || settings.provider);
    const effectiveApiKey = settings.apiKey || settings.apiKeys?.openai || settings.apiKeys?.anthropic || '';
    if (!effectiveApiKey && providerRequiresApiKey(runProvider)) {
      throw new Error('Add your API key first.');
    }
    if (runProvider === 'ollama') {
      const started = await ensureOllamaRunning();
      if (!started) {
        throw new Error('Ollama is not running and could not be started. Open the Ollama app or run `ollama serve`.');
      }
    }
    const isLocalRun = runProvider === 'ollama';
    const limitsDefault = isLocalRun ? LOCAL_RUN_LIMITS : DEFAULT_RUN_LIMITS;
    const effectiveRunLimits = normalizeRunLimits(
      Object.keys(requestedRunLimits).length > 0 ? requestedRunLimits : runState.runLimits,
      settings.runLimits || limitsDefault,
      { provider: runProvider },
    );
    runState.maxIterations = effectiveRunLimits.maxIterations;
    runState.maxRuntimeMinutes = effectiveRunLimits.maxRuntimeMinutes;
    runState.maxModelCallsPerMinute = effectiveRunLimits.maxModelCallsPerMinute;
    runState.maxToolCallsPerMinute = effectiveRunLimits.maxToolCallsPerMinute;
    runState.idleTimeoutSeconds = effectiveRunLimits.idleTimeoutSeconds;
    runState.consecutiveDriftLimit = effectiveRunLimits.consecutiveDriftLimit;

    // --- Scope guards for non-local runs ---
    // Keep cloud runs from burning tokens endlessly on routine fixes.
    if (!isLocalRun) {
      const objectiveWords = objective.split(/\s+/).filter(Boolean).length;
      const hasBuildIntent = /\b(build|create|implement|develop|design|scaffold|generate|from scratch|new app|new project)\b/i.test(objective);
      const hasQuickFixIntent = /\b(fix|bug|broken|issue|error|not working|doesn't work|align|layout|loading|does not load|button|typo|small|quick)\b/i.test(objective);

      const applyRunCaps = ({ maxIterations, maxActions, maxRuntimeMinutes, idleTimeoutSeconds, consecutiveDriftLimit }) => {
        const currentActions = Number(runState.remainingActions ?? effectiveRunLimits.maxActions);
        runState.maxIterations = Math.min(runState.maxIterations, maxIterations);
        runState.remainingActions = Number.isFinite(currentActions)
          ? Math.min(currentActions, maxActions)
          : maxActions;
        runState.maxRuntimeMinutes = Math.min(runState.maxRuntimeMinutes, maxRuntimeMinutes);
        runState.idleTimeoutSeconds = Math.min(runState.idleTimeoutSeconds, idleTimeoutSeconds);
        runState.consecutiveDriftLimit = Math.min(runState.consecutiveDriftLimit, consecutiveDriftLimit);
      };

      // Simple/trivial tasks: very short objectives asking for basic things should finish in ~3-5 iterations.
      const isSimpleTask = objectiveWords <= 12 && /\b(hello world|simple|basic|landing page|single page|one page|placeholder|boilerplate|template|starter)\b/i.test(objective);
      if (isSimpleTask) {
        applyRunCaps({
          maxIterations: 6,
          maxActions: 40,
          maxRuntimeMinutes: 15,
          idleTimeoutSeconds: 45,
          consecutiveDriftLimit: 2,
        });
        runState._isSimpleTask = true;
        console.log(`[agent-loop] Simple-task guard active: capped to 6 iterations for objective "${objective.slice(0, 80)}"`);
        // Quick-fix/debug tasks should converge quickly or stop early with a clear report.
      } else if (hasQuickFixIntent && objectiveWords <= 36 && !hasBuildIntent) {
        applyRunCaps({
          maxIterations: 12,
          maxActions: 120,
          maxRuntimeMinutes: 45,
          idleTimeoutSeconds: 60,
          consecutiveDriftLimit: 2,
        });
        console.log(`[agent-loop] Quick-fix guard active: capped run limits for objective "${objective.slice(0, 80)}"`);
      } else if (objectiveWords <= 20 && !hasBuildIntent) {
        // Generic short objective guard — BUT give browser/signup tasks more room.
        const hasBrowserIntent = /\b(sign.?up|signup|register|create.?account|log.?in|login|navigate|browse|open|click|fill|form|website|web|url|http|email|verify|verification)\b/i.test(objective);
        applyRunCaps({
          maxIterations: hasBrowserIntent ? 60 : 12,
          maxActions: hasBrowserIntent ? 200 : 120,
          maxRuntimeMinutes: hasBrowserIntent ? 90 : 45,
          idleTimeoutSeconds: 60,
          consecutiveDriftLimit: hasBrowserIntent ? 6 : 3,
        });
        console.log(`[agent-loop] Minor-task guard active (browser=${hasBrowserIntent}): capped run limits for objective "${objective.slice(0, 80)}"`);
      }
    }
    const maxActionsClamp = isLocalRun ? 99999 : 4000;
    runState.remainingActions = clampNumber(
      Number(runState.remainingActions ?? effectiveRunLimits.maxActions),
      0,
      maxActionsClamp,
      effectiveRunLimits.maxActions,
    );
    if (resumeRunId) {
      const completedIterationsAtResume = Array.isArray(runState.iterations) ? runState.iterations.length : 0;
      const resumeIterationHardCap = isLocalRun ? 9999 : 500;
      if (completedIterationsAtResume >= Number(runState.maxIterations || 0)) {
        const defaultTopUp = isLocalRun ? 40 : 12;
        const targetMaxIterations = Math.min(
          resumeIterationHardCap,
          Math.max(
            completedIterationsAtResume + 1,
            Number(runState.maxIterations || 0) + defaultTopUp,
          ),
        );
        if (targetMaxIterations > Number(runState.maxIterations || 0)) {
          const delta = targetMaxIterations - completedIterationsAtResume;
          runState.maxIterations = targetMaxIterations;
          resumeBudgetAdjustments.push(`iterations +${delta} (new cap ${targetMaxIterations})`);
        }
      }
      if (Number(runState.remainingActions || 0) <= 0) {
        const topUpActions = Math.min(maxActionsClamp, isLocalRun ? 200 : 80);
        runState.remainingActions = topUpActions;
        resumeBudgetAdjustments.push(`actions +${topUpActions}`);
      }
    }
    runState.runLimits = {
      ...effectiveRunLimits,
      maxIterations: runState.maxIterations,
      maxActions: runState.remainingActions,
    };
    // Always reset lastProgressAt on resume so the idle timeout counts from *this* session,
    // not from whenever the previous run session last made progress (which could be hours ago).
    runState.lastProgressAt = new Date().toISOString();
    runState.consecutiveDriftIterations = clampNumber(
      Number(runState.consecutiveDriftIterations || 0),
      0,
      999,
      0,
    );
    runState.iterationBudgetExtensions = clampNumber(
      Number(runState.iterationBudgetExtensions || 0),
      0,
      200,
      0,
    );
    const _runProviderRaw = String(runState.provider || '').trim().toLowerCase();
    const effectiveProvider = normalizeProvider((_runProviderRaw === 'auto' ? '' : _runProviderRaw) || settings.provider);
    const effectiveBaseUrl = normalizeBaseUrl(
      request?.baseUrl
      || runState.baseUrl
      || (settings.provider === effectiveProvider ? settings.baseUrl : defaultBaseUrlForProvider(effectiveProvider)),
      effectiveProvider,
    );
    const executionSettings = {
      ...settings,
      provider: effectiveProvider,
      baseUrl: effectiveBaseUrl,
      teamMode: runState.teamMode,
      executionCore: runState.executionCore,
      runLimits: settings.runLimits || limitsDefault,
    };
    const globalMemoryStart = await readGlobalMemory();

    const requestedModelHint = String(request?.model || runState.model || executionSettings.model || '').trim();
    let model = requestedModelHint;
    if (!model || model === 'auto') {
      const resolvedModel = await resolveAgentModel(
        executionSettings,
        request?.model || runState.model || executionSettings.model,
        objective
      );
      model = resolvedModel.model;
    } else if (resumeRunId) {
      // Resume self-heal: older runs may carry a stale model from another provider.
      const resolvedModel = await resolveAgentModel(executionSettings, model, objective);
      if (!Array.isArray(resolvedModel.models) || !resolvedModel.models.includes(model)) {
        model = resolvedModel.model;
        runState.nextFocus = [
          String(runState.nextFocus || objective),
          '',
          `Resume self-heal: switched model to ${model} for provider ${executionSettings.provider}.`,
        ].join('\n');
      }
    }
    const requestedWorkspaceRaw = String(request?.workspaceRoot || '').trim();
    const requestedWorkspace = requestedWorkspaceRaw || runState.workspaceRoot || executionSettings.workspaceRoot;
    const requestedWorkspaceIsHome = requestedWorkspaceRaw ? isHomeWorkspace(requestedWorkspaceRaw) : false;
    const shouldAutoResolveWorkspace = (
      (!requestedWorkspaceRaw || requestedWorkspaceIsHome)
      && (!requestedWorkspace || isHomeWorkspace(requestedWorkspace))
    );
    const workspaceChoice = shouldAutoResolveWorkspace
      ? await chooseWorkspaceAndHints({
        objective: effectiveThreadContext ? `${objective}\n${effectiveThreadContext}` : objective,
        requestedWorkspace: requestedWorkspaceIsHome ? '' : requestedWorkspace,
        globalMemory: globalMemoryStart,
        threadContext: effectiveThreadContext,
      })
      : {
        workspaceRoot: requestedWorkspace || DEFAULT_WORKSPACE_ROOT,
        discoveredPaths: [],
        source: 'existing',
      };
    const workspaceRoot = resolveWorkspaceRoot(workspaceChoice.workspaceRoot || requestedWorkspace || DEFAULT_WORKSPACE_ROOT);
    const discoveryHints = Array.from(new Set(
      (Array.isArray(workspaceChoice.discoveredPaths) ? workspaceChoice.discoveredPaths : [])
        .map((item) => String(item).trim())
        .filter(Boolean),
    )).slice(0, 30);
    await writeSettings({
      ...settings,
      provider: effectiveProvider,
      baseUrl: effectiveBaseUrl,
      model,
      workspaceRoot,
      teamMode: runState.teamMode,
      executionCore: runState.executionCore,
    });

    runState.model = model;
    runState.baseUrl = effectiveBaseUrl;
    runState.provider = effectiveProvider;
    runState.workspaceRoot = workspaceRoot;
    runState.workspaceDiscoverySource = workspaceChoice.source || 'existing';
    runState.discoveryHints = Array.isArray(runState.discoveryHints) && runState.discoveryHints.length > 0
      ? Array.from(new Set([...runState.discoveryHints, ...discoveryHints])).slice(-40)
      : discoveryHints;
    if (objectivePolicy.webResearchPreferred) {
      runState.discoveryHints = [];
    }
    if (runState.iterations.length === 0 && !objectivePolicy.webResearchPreferred) {
      const knownPaths = collectKnownPathsForObjective(globalMemoryStart, objective, workspaceRoot);
      const hintPaths = Array.from(new Set([...knownPaths, ...(runState.discoveryHints || [])])).slice(0, 30);
      if (hintPaths.length > 0) {
        runState.nextFocus = [
          runState.nextFocus || objective,
          '',
          'Known relevant artifact paths:',
          ...hintPaths.map((item) => `- ${item}`),
        ].join('\n');
      }
    }
    if (resumeRunId
      && runState.executionCore === 'nanobot'
      && runState.nativeRuntimeState?.status === 'running'
      && !activeChildrenByRun.has(runState.runId)) {
      runState.executionCore = 'geepus';
      runState.reason = [
        'Recovered from an interrupted Nanobot native run.',
        'Continuing in Geepus classic from the persisted partial state.',
      ].join(' ');
      runState.nativeRuntimeState = {
        ...runState.nativeRuntimeState,
        status: 'recovered',
        recoveredAt: new Date().toISOString(),
        recoveryMode: 'fallback_to_geepus',
      };
    }
    runState.state = 'running';
    if (!(resumeRunId && runState.reason)) {
      runState.reason = '';
    }
    delete runState.blockedActions;
    runState = await persistRunState(runState);

    broadcastWatchEvent(runState.runId, {
      type: resumeRunId ? 'run_resumed' : 'run_started',
      summary: resumeRunId ? 'Run resumed.' : 'Run started.',
    }, {
      objective,
      state: runState.state,
      provider: runState.provider,
      model: runState.model,
      workspaceRoot,
      teamMode: runState.teamMode,
      executionMode: runState.executionMode,
      executionCore: runState.executionCore,
      createdAt: runState.createdAt,
      activeLearnedStrategies: runState.activeLearnedStrategies,
      activeBannedApproaches: runState.activeBannedApproaches,
    });
    if (resumeRunId && resumeBudgetAdjustments.length > 0) {
      broadcastWatchEvent(runState.runId, {
        type: 'run_budget_extended',
        summary: 'Resume budget top-up applied.',
        detail: resumeBudgetAdjustments.join(' | '),
      }, {
        objective,
        state: runState.state,
        provider: runState.provider,
        model: runState.model,
        workspaceRoot,
        teamMode: runState.teamMode,
        executionMode: runState.executionMode,
        executionCore: runState.executionCore,
        createdAt: runState.createdAt,
        activeLearnedStrategies: runState.activeLearnedStrategies,
        activeBannedApproaches: runState.activeBannedApproaches,
      });
    }

    if (resumeRunId) {
      await appendAuditEvent({
        type: 'objective_run_resumed',
        run_id: runState.runId,
        model,
        provider: runState.provider,
        team_mode: runState.teamMode,
        execution_mode: runState.executionMode,
        execution_core: runState.executionCore,
        workspace_root: workspaceRoot,
        workspace_discovery_source: runState.workspaceDiscoverySource,
        objective: truncate(objective, 500),
        max_model_calls_per_minute: runState.maxModelCallsPerMinute,
        max_tool_calls_per_minute: runState.maxToolCallsPerMinute,
        idle_timeout_seconds: runState.idleTimeoutSeconds,
        consecutive_drift_limit: runState.consecutiveDriftLimit,
      });
    } else {
      await appendAuditEvent({
        type: 'objective_run_started',
        run_id: runState.runId,
        model,
        provider: runState.provider,
        team_mode: runState.teamMode,
        execution_mode: runState.executionMode,
        execution_core: runState.executionCore,
        workspace_root: workspaceRoot,
        workspace_discovery_source: runState.workspaceDiscoverySource,
        objective: truncate(objective, 500),
        max_iterations: runState.maxIterations,
        max_runtime_minutes: runState.maxRuntimeMinutes,
        max_actions: runState.remainingActions,
        max_model_calls_per_minute: runState.maxModelCallsPerMinute,
        max_tool_calls_per_minute: runState.maxToolCallsPerMinute,
        idle_timeout_seconds: runState.idleTimeoutSeconds,
        consecutive_drift_limit: runState.consecutiveDriftLimit,
      });
    }

    let done = false;
    let doneReason = 'Max iteration budget reached.';
    let consecutiveFailedIterations = 0;
    let consecutivePlanningFailures = 0;
    let consecutivePlannerDoneRejections = 0; // tracks how many times planner said done but evaluator disagreed

    if (runState.executionCore === 'nanobot' && runState.iterations.length === 0) {
      const nativeLiveResults = [];
      const nativeLiveCalls = [];
      const nativeMilestones = [];
      const nativeVerificationSignals = [];
      const nativeRepairBriefs = [];
      const maxNativePasses = 3;
      let nativePass = 0;
      let nativeCheckpointReviewInFlight = false;
      let nativeCheckpointResolved = false;
      let nativeSnapshotTimer = null;
      let nativePersistInFlight = false;
      const nativeWatchSeed = {
        objective,
        state: runState.state,
        provider: runState.provider,
        model,
        workspaceRoot,
        teamMode: runState.teamMode,
        executionMode: runState.executionMode,
        executionCore: runState.executionCore,
      };
      const recordNativeMilestone = (phase, summary, detail = '') => {
        const normalizedPhase = String(phase || '').trim().toLowerCase();
        if (!normalizedPhase) return { changed: false, previousPhase: '' };
        const previousPhase = String(nativeMilestones[nativeMilestones.length - 1]?.phase || '').trim().toLowerCase();
        if (previousPhase === normalizedPhase) {
          return { changed: false, previousPhase };
        }
        nativeMilestones.push({
          phase: normalizedPhase,
          summary: String(summary || '').trim(),
          detail: String(detail || '').trim(),
          ts: new Date().toISOString(),
        });
        return { changed: true, previousPhase };
      };
      const ensureNativeIteration = (results) => {
        const snapshotResults = Array.isArray(results) ? results : [];
        runState.iterations = [{
          iteration: 1,
          summary: 'Nanobot native runtime execution',
          model,
          status: 'in_progress',
          results: snapshotResults,
        }];
        runState.results = snapshotResults.slice();
      };
      const syncNativeSnapshot = async () => {
        if (nativePersistInFlight) return;
        nativePersistInFlight = true;
        try {
          const snapshotResults = nativeLiveResults.slice(-120);
          ensureNativeIteration(snapshotResults);
          runState.lastProgressAt = new Date().toISOString();
          runState.reason = 'Nanobot native runtime in progress.';
          runState.nativeRuntimeState = {
            executionCore: 'nanobot',
            status: 'running',
            startedAt: String(runState.nativeRuntimeState?.startedAt || runState.startedAt || new Date().toISOString()),
            lastEventAt: runState.lastProgressAt,
            partialResults: snapshotResults.length,
            toolCalls: nativeLiveCalls.length,
            currentPhase: String(nativeMilestones[nativeMilestones.length - 1]?.phase || 'planning'),
            milestones: nativeMilestones.slice(-20),
            verificationSignals: nativeVerificationSignals.slice(-20),
            checkpointGate: runState.nativeRuntimeState?.checkpointGate || null,
            passCount: nativePass,
            repairBriefs: nativeRepairBriefs.slice(-5),
          };
          await persistRunState(runState);
        } catch {
          // Best-effort snapshotting only.
        } finally {
          nativePersistInFlight = false;
        }
      };
      const scheduleNativeSnapshot = () => {
        if (nativeSnapshotTimer) {
          clearTimeout(nativeSnapshotTimer);
        }
        nativeSnapshotTimer = setTimeout(() => {
          nativeSnapshotTimer = null;
          syncNativeSnapshot().catch(() => {});
        }, 120);
      };
      broadcastWatchEvent(runState.runId, {
        type: 'execution_core',
        summary: 'Starting Nanobot native runtime...',
      }, {
        objective,
        state: runState.state,
        provider: runState.provider,
        model,
        workspaceRoot,
        teamMode: runState.teamMode,
        executionMode: runState.executionMode,
        executionCore: runState.executionCore,
      });
      recordNativeMilestone('planning', 'Nanobot is planning the objective.');
      ensureNativeIteration([]);
      runState.reason = 'Nanobot native runtime in progress.';
      runState.nativeRuntimeState = {
        executionCore: 'nanobot',
        status: 'running',
        startedAt: new Date().toISOString(),
        lastEventAt: new Date().toISOString(),
        partialResults: 0,
        toolCalls: 0,
        currentPhase: 'planning',
        milestones: nativeMilestones.slice(),
        verificationSignals: [],
        checkpointGate: null,
        passCount: 0,
        repairBriefs: [],
      };
      runState = await persistRunState(runState);
      let nativeResult = null;
      while (nativePass < maxNativePasses) {
        nativePass += 1;
        runState.nativeRuntimeState = {
          ...(runState.nativeRuntimeState || {}),
          executionCore: 'nanobot',
          status: 'running',
          passCount: nativePass,
          repairBriefs: nativeRepairBriefs.slice(-5),
        };
        runState = await persistRunState(runState);
        const nativeObjective = nativeRepairBriefs.length === 0
          ? objective
          : [
            objective,
            '',
            `Checkpoint repair pass ${nativePass}: address every item below before claiming completion.`,
            'Work from highest priority to lowest priority.',
            'Do not stop after edits alone. Produce the exit proof requested for each item you touch.',
            ...nativeRepairBriefs.slice(-2).map((brief, index) => `Repair brief ${index + 1}:\n${brief}`),
          ].join('\n');
        if (nativePass > 1) {
          broadcastWatchEvent(runState.runId, {
            type: 'failure_recovery',
            iteration: 1,
            owner: 'chief',
            summary: `Starting Nanobot repair pass ${nativePass}/${maxNativePasses}.`,
            detail: truncate(nativeRepairBriefs[nativeRepairBriefs.length - 1] || '', 800),
          }, nativeWatchSeed);
        }
        nativeResult = await runNanobotNativeObjective({
          objective: nativeObjective,
          threadContext: effectiveThreadContext,
          workspaceRoot,
          provider: effectiveProvider,
          apiKey: effectiveApiKey,
          baseUrl: effectiveBaseUrl,
          model,
          braveSearchApiKey: settings.braveSearchApiKey || '',
          maxToolIterations: Math.max(1, Math.min(Number(runState.remainingActions || 40), 400)),
          runId: runState.runId,
          onCheckpoint: async (event) => {
            const eventType = String(event?.type || '').trim().toLowerCase();
            const shouldCheck = (
              (eventType === 'verification_signal' && event?.ok !== false)
              || (eventType === 'milestone' && String(event?.phase || '').trim().toLowerCase() === 'acceptance')
            );
            if (!shouldCheck || nativeCheckpointResolved || nativeCheckpointReviewInFlight) {
              return null;
            }
            nativeCheckpointReviewInFlight = true;
            try {
              const checkpointResults = nativeLiveResults.slice();
              if (checkpointResults.length === 0) {
                return null;
              }
              const readiness = await computeRunReadiness({
                objective,
                threadContext: effectiveThreadContext,
                executionMode: runState.executionMode,
                objectivePolicy,
                workspaceRoot,
                results: checkpointResults,
              });
              runState.readiness = readiness;
              if (!readiness.ready) {
                const repairBrief = buildNativeRepairBrief({
                  passNumber: nativePass,
                  objective,
                  gateType: 'readiness',
                  readiness,
                  results: checkpointResults,
                });
                nativeRepairBriefs.push(repairBrief);
                runState.nextFocus = readiness.nextFocus || repairBrief;
                runState.nativeRuntimeState = {
                  ...(runState.nativeRuntimeState || {}),
                  executionCore: 'nanobot',
                  status: 'running',
                  checkpointGate: {
                    status: 'repair_requested',
                    checkedAt: new Date().toISOString(),
                    summary: readiness.summary,
                    nextFocus: readiness.nextFocus || '',
                    repairBrief,
                  },
                  passCount: nativePass,
                  repairBriefs: nativeRepairBriefs.slice(-5),
                };
                await persistRunState(runState);
                broadcastWatchEvent(runState.runId, {
                  type: 'readiness_blocked',
                  iteration: 1,
                  owner: 'product',
                  summary: `Native checkpoint blocked completion: ${readiness.summary}`,
                  detail: truncate(repairBrief, 800),
                }, nativeWatchSeed);
                return {
                  stop: true,
                  disposition: 'repair',
                  reason: `Native checkpoint requested repair after pass ${nativePass}.`,
                  summary: readiness.summary,
                  report: repairBrief,
                  repairBrief,
                };
              }

              const taskClass = runState.readiness?.taskClass || '';
              const hasPlaywrightPass = checkpointResults.some((r) =>
                r.ok && r.tool === 'run_playwright'
                && typeof r.output === 'string'
                && r.output.includes('consoleErrorCount')
                && /"consoleErrorCount"\s*:\s*0/.test(r.output)
              );
              const skipAcceptance = taskClass === 'lookup' || taskClass === 'general' || taskClass === 'operations'
                || (runState._isSimpleTask && hasPlaywrightPass);
              let acceptance = {
                acceptable: true,
                score: 7,
                verdict: 'Acceptance review skipped for this task class.',
                issues: [],
                model,
              };
              if (!skipAcceptance) {
                broadcastWatchEvent(runState.runId, {
                  type: 'acceptance_review',
                  iteration: 1,
                  owner: 'product',
                  summary: 'Running native checkpoint acceptance review...',
                }, nativeWatchSeed);
                acceptance = await evaluateUserAcceptance({
                  settings: executionSettings,
                  model,
                  objective,
                  workspaceRoot,
                  iterationSummary: summarizeRunHistory([{
                    iteration: 1,
                    summary: 'Nanobot native runtime execution',
                    results: checkpointResults,
                  }], 1),
                  writtenFiles: collectWrittenFilePaths(checkpointResults),
                  callGuards: null,
                });
                model = acceptance.model || model;
                runState.model = model;
                runState.lastAcceptanceScore = acceptance.score;
                if (!acceptance.acceptable) {
                  const repairBrief = buildNativeRepairBrief({
                    passNumber: nativePass,
                    objective,
                    gateType: 'acceptance',
                    readiness,
                    acceptance,
                    results: checkpointResults,
                  });
                  nativeRepairBriefs.push(repairBrief);
                  runState.nextFocus = repairBrief;
                  runState.nativeRuntimeState = {
                    ...(runState.nativeRuntimeState || {}),
                    executionCore: 'nanobot',
                    status: 'running',
                    checkpointGate: {
                      status: 'repair_requested',
                      checkedAt: new Date().toISOString(),
                      summary: acceptance.verdict,
                      issues: acceptance.issues.slice(0, 8),
                      score: acceptance.score,
                      repairBrief,
                    },
                    passCount: nativePass,
                    repairBriefs: nativeRepairBriefs.slice(-5),
                  };
                  await persistRunState(runState);
                  broadcastWatchEvent(runState.runId, {
                    type: 'acceptance_failed',
                    iteration: 1,
                    owner: 'product',
                    summary: `Native checkpoint acceptance failed: ${acceptance.score}/10`,
                    detail: truncate(repairBrief, 800),
                  }, nativeWatchSeed);
                  return {
                    stop: true,
                    disposition: 'repair',
                    reason: `Native checkpoint acceptance failed after pass ${nativePass}.`,
                    summary: acceptance.verdict,
                    report: repairBrief,
                    repairBrief,
                  };
                }
                runState.acceptancePassed = true;
                broadcastWatchEvent(runState.runId, {
                  type: 'acceptance_passed',
                  iteration: 1,
                  owner: 'product',
                  summary: `Native checkpoint acceptance passed: ${acceptance.score}/10`,
                  detail: truncate(acceptance.verdict, 400),
                }, nativeWatchSeed);
              }

              nativeCheckpointResolved = true;
              runState.nativeRuntimeState = {
                ...(runState.nativeRuntimeState || {}),
                executionCore: 'nanobot',
                status: 'running',
                checkpointGate: {
                  status: 'approved',
                  checkedAt: new Date().toISOString(),
                  summary: readiness.summary,
                  acceptanceScore: acceptance.score,
                  acceptanceVerdict: acceptance.verdict,
                },
                passCount: nativePass,
                repairBriefs: nativeRepairBriefs.slice(-5),
              };
              await persistRunState(runState);
              return {
                stop: true,
                disposition: 'complete',
                reason: 'Completed at native checkpoint after readiness and acceptance passed.',
                summary: skipAcceptance
                  ? `Native checkpoint passed readiness: ${readiness.summary}`
                  : `Native checkpoint passed readiness and acceptance (${acceptance.score}/10).`,
                report: acceptance.verdict || readiness.summary,
              };
            } finally {
              nativeCheckpointReviewInFlight = false;
            }
          },
          onChildProcess: (child) => {
            registerRunChild(runState.runId, child);
          },
          onChildProcessDone: (child) => {
            unregisterRunChild(runState.runId, child);
          },
          onProgress: (event) => {
          const eventType = String(event?.type || '').trim().toLowerCase();
          if (eventType === 'milestone') {
            const phase = String(event?.phase || '').trim().toLowerCase();
            const summary = String(event?.summary || '').trim();
            const detail = String(event?.detail || '').trim();
            const milestone = recordNativeMilestone(phase, summary, detail);
            if (!milestone.changed) {
              return;
            }
            scheduleNativeSnapshot();
            if (phase === 'planning') {
              broadcastWatchEvent(runState.runId, {
                type: 'planning_started',
                iteration: 1,
                owner: 'chief',
                summary: summary || 'Nanobot is planning the objective.',
                detail: truncate(detail, 800),
              }, nativeWatchSeed);
              return;
            }
            if (milestone.previousPhase === 'planning') {
              broadcastWatchEvent(runState.runId, {
                type: 'planning_completed',
                iteration: 1,
                owner: 'chief',
                summary: 'Nanobot finished planning and started execution.',
                detail: truncate(summary || detail, 800),
              }, nativeWatchSeed);
            }
            if (phase === 'verifying') {
              broadcastWatchEvent(runState.runId, {
                type: 'evaluating_completion',
                iteration: 1,
                owner: 'chief',
                summary: summary || 'Nanobot is running verification.',
                detail: truncate(detail, 800),
              }, nativeWatchSeed);
              return;
            }
            if (phase === 'acceptance') {
              broadcastWatchEvent(runState.runId, {
                type: 'acceptance_review',
                iteration: 1,
                owner: 'chief',
                summary: summary || 'Nanobot is preparing final acceptance output.',
                detail: truncate(detail, 800),
              }, nativeWatchSeed);
              return;
            }
            broadcastWatchEvent(runState.runId, {
              type: 'iteration_update',
              iteration: 1,
              owner: 'chief',
              summary: summary || `Nanobot phase: ${phase}`,
              detail: truncate(detail, 800),
            }, nativeWatchSeed);
            return;
          }
          if (eventType === 'verification_signal') {
            nativeVerificationSignals.push({
              stage: String(event?.stage || '').trim() || 'verification',
              ok: event?.ok !== false,
              summary: String(event?.summary || '').trim(),
              detail: String(event?.detail || '').trim(),
              output: truncate(String(event?.output || '').trim(), 1200),
              ts: new Date().toISOString(),
            });
            scheduleNativeSnapshot();
            broadcastWatchEvent(runState.runId, {
              type: 'progress_check',
              iteration: 1,
              owner: 'chief',
              summary: String(event?.summary || '').trim() || 'Nanobot verification signal recorded.',
              detail: truncate(String(event?.detail || event?.output || '').trim(), 1000),
            }, nativeWatchSeed);
            return;
          }
          if (eventType === 'tool_call') {
            const tool = String(event?.tool || '').trim() || 'tool';
            const argumentsText = String(event?.arguments || '').trim();
            const preview = buildNativeRuntimeResultEntry({
              toolName: tool,
              argumentsText,
              output: '',
              ok: true,
            });
            nativeLiveCalls.push({
              tool,
              arguments: argumentsText,
            });
            broadcastWatchEvent(runState.runId, {
              type: 'action_started',
              iteration: 1,
              owner: inferOwnerFromAction(preview),
              tool: preview.tool,
              intent: preview.intent,
              summary: `Nanobot calling ${preview.tool}`,
              detail: truncate(argumentsText, 240),
            }, nativeWatchSeed);
            return;
          }
          if (eventType === 'tool_result') {
            const tool = String(event?.tool || '').trim() || 'tool';
            const ok = event?.ok !== false;
            const matchingCall = [...nativeLiveCalls].reverse().find((entry) => entry.tool === tool) || null;
            const resultEntry = buildNativeRuntimeResultEntry({
              toolName: tool,
              argumentsText: matchingCall?.arguments || '',
              output: String(event?.output || ''),
              ok,
            });
            nativeLiveResults.push(resultEntry);
            scheduleNativeSnapshot();
            broadcastWatchEvent(runState.runId, {
              type: 'action_finished',
              iteration: 1,
              owner: inferOwnerFromAction(resultEntry),
              tool: resultEntry.tool,
              intent: resultEntry.intent,
              ok,
              summary: resultEntry.intent,
              detail: truncate(String(event?.output || '').trim(), 400),
            }, nativeWatchSeed);
            return;
          }
          if (typeof onProgress === 'function') {
            onProgress({
              type: 'native_runtime_progress',
              owner: 'chief',
              summary: String(event?.content || '').trim() || 'Nanobot native runtime progressing...',
            });
          }
          },
        });
        if (!(nativeResult?.checkpointStopped && nativeResult?.checkpointDisposition === 'repair' && nativePass < maxNativePasses)) {
          break;
        }
      }
      if (nativeResult.used) {
        if (nativeSnapshotTimer) {
          clearTimeout(nativeSnapshotTimer);
          nativeSnapshotTimer = null;
        }
        if (nativeResult.checkpointStopped && nativeResult.checkpointDisposition === 'repair') {
          throwIfRunStopped(runState.runId);
          runState.executionCore = 'geepus';
          executionSettings.executionCore = 'geepus';
          runState.reason = `Nanobot exhausted native repair passes. Falling back to Geepus classic: ${truncate(nativeResult.repairBrief || nativeResult.reason || 'repair requested', 320)}`;
          runState.nextFocus = nativeResult.repairBrief || runState.nextFocus;
          runState.nativeRuntimeState = {
            ...(runState.nativeRuntimeState || {}),
            executionCore: 'nanobot',
            status: 'fallback',
            failedAt: new Date().toISOString(),
            partialResults: nativeLiveResults.length,
            toolCalls: nativeLiveCalls.length,
            currentPhase: String(nativeMilestones[nativeMilestones.length - 1]?.phase || 'verifying'),
            milestones: nativeMilestones.slice(-20),
            verificationSignals: nativeVerificationSignals.slice(-20),
            checkpointGate: {
              ...(runState.nativeRuntimeState?.checkpointGate || {}),
              status: 'repair_exhausted',
            },
            passCount: nativePass,
            repairBriefs: nativeRepairBriefs.slice(-5),
            reason: truncate(nativeResult.reason || 'Native repair passes exhausted', 500),
          };
          runState = await persistRunState(runState);
          broadcastWatchEvent(runState.runId, {
            type: 'execution_core_fallback',
            summary: 'Nanobot exhausted native repair passes. Falling back to Geepus classic.',
            detail: truncate(nativeResult.repairBrief || nativeResult.reason || '', 400),
          }, {
            objective,
            state: runState.state,
            provider: runState.provider,
            model,
            workspaceRoot,
            teamMode: runState.teamMode,
            executionMode: runState.executionMode,
            executionCore: 'geepus',
          });
        } else {
        throwIfRunStopped(runState.runId);
        const nativeOutput = String(nativeResult.response || nativeResult.checkpointSummary || '').trim();
        const nativeStructuredResults = nativeRuntimeMessagesToResults(nativeResult.messages, nativeResult.toolsUsed);
        const nativeResultEntry = nativeStructuredResults.length > 0
          ? nativeStructuredResults
          : nativeLiveResults.length > 0
            ? nativeLiveResults
            : [{
              tool: 'native_runtime',
              intent: 'Execute objective with Nanobot native runtime',
              ok: true,
              output: truncate(nativeOutput, 12000),
              metadata: {
                executionCore: 'nanobot',
                nativeRuntime: true,
              },
            }];
        runState.iterations = [{
          iteration: 1,
          summary: 'Nanobot native runtime execution',
          model,
          results: nativeResultEntry,
        }];
        runState.results = nativeResultEntry.slice();
        runState.remainingActions = Math.max(0, Number(runState.remainingActions || 0) - nativeResultEntry.length);
        runState.nativeRuntimeReport = nativeOutput;
        runState.maxIterations = runState.iterations.length;
        runState.lastProgressAt = new Date().toISOString();
        runState.reason = nativeResult.reason || 'Completed via Nanobot native runtime.';
        runState.nativeRuntimeState = {
          executionCore: 'nanobot',
          status: 'completed',
          completedAt: runState.lastProgressAt,
          partialResults: nativeResultEntry.length,
          toolCalls: nativeLiveCalls.length,
          currentPhase: String(nativeResult.milestones?.[nativeResult.milestones.length - 1] || nativeMilestones[nativeMilestones.length - 1]?.phase || 'acceptance'),
          milestones: nativeMilestones.slice(-20),
          verificationSignals: nativeVerificationSignals.slice(-20),
          checkpointGate: runState.nativeRuntimeState?.checkpointGate || null,
          passCount: nativePass,
          repairBriefs: nativeRepairBriefs.slice(-5),
        };
        try {
          runState.readiness = await computeRunReadiness({
            objective,
            threadContext: effectiveThreadContext,
            executionMode: runState.executionMode,
            objectivePolicy,
            workspaceRoot,
            results: runState.results,
          });
        } catch {
          runState.readiness = null;
        }
        runState = await persistRunState(runState);
        broadcastWatchEvent(runState.runId, {
          type: 'iteration_summary',
          iteration: 1,
          summary: `Nanobot native runtime completed ${nativeResultEntry.filter((entry) => entry.ok).length} action(s) with ${nativeResultEntry.filter((entry) => !entry.ok).length} failure(s).`,
          detail: nativeResultEntry.map((entry) => `${entry.ok ? '✓' : '✗'} ${entry.tool}: ${truncate(entry.intent || '', 80)}`).join('\n'),
        }, {
          objective,
          state: runState.state,
          provider: runState.provider,
          model,
          workspaceRoot,
          teamMode: runState.teamMode,
          executionMode: runState.executionMode,
          executionCore: runState.executionCore,
        });
        done = true;
        doneReason = nativeResult.reason || 'Completed via Nanobot native runtime.';
        }
      } else {
        if (nativeSnapshotTimer) {
          clearTimeout(nativeSnapshotTimer);
          nativeSnapshotTimer = null;
        }
        throwIfRunStopped(runState.runId);
        runState.executionCore = 'geepus';
        executionSettings.executionCore = 'geepus';
        runState.reason = `Nanobot runtime unavailable, falling back to Geepus classic: ${truncate(nativeResult.reason || 'unknown reason', 240)}`;
        runState.nativeRuntimeState = {
          executionCore: 'nanobot',
          status: 'fallback',
          failedAt: new Date().toISOString(),
          partialResults: nativeLiveResults.length,
          toolCalls: nativeLiveCalls.length,
          currentPhase: String(nativeMilestones[nativeMilestones.length - 1]?.phase || 'planning'),
          milestones: nativeMilestones.slice(-20),
          verificationSignals: nativeVerificationSignals.slice(-20),
          reason: truncate(nativeResult.reason || 'unknown reason', 500),
        };
        runState = await persistRunState(runState);
        broadcastWatchEvent(runState.runId, {
          type: 'execution_core_fallback',
          summary: 'Nanobot runtime unavailable. Falling back to Geepus classic.',
          detail: truncate(nativeResult.reason || '', 240),
        }, {
          objective,
          state: runState.state,
          provider: runState.provider,
          model,
          workspaceRoot,
          teamMode: runState.teamMode,
          executionMode: runState.executionMode,
          executionCore: 'geepus',
        });
      }
    }

    if (done) {
      runState.activeSkillName = null;
      runState.activeSkillContent = '';
    }

    // Load the best-matching skill playbook for this objective.
    // This gives the planner step-by-step guidance and the evaluator
    // a concrete definition of done — specific to the task type.
    // If no existing skill matches, auto-develop one via web research + LLM synthesis.
    let activeSkill = null;
    if (!done) {
      activeSkill = await findBestSkillForObjective(objective, workspaceRoot).catch(() => null);
      if (!activeSkill) {
        activeSkill = await developSkillForObjective({
          objective,
          settings: executionSettings,
          model,
          callGuards: null, // callGuards not yet initialised — skill dev runs before the main loop
          runId: runState.runId,
          workspaceRoot,
        }).catch(() => null);
      }
      if (activeSkill) {
        runState.activeSkillName = activeSkill.name;
        runState.activeSkillContent = activeSkill.content || '';
      } else {
        runState.activeSkillName = null;
        runState.activeSkillContent = '';
      }
    }
    const runIsRefinement = detectRefinementIntent(objective, effectiveThreadContext, runState.iterations.length);
    const objectiveGuards = buildObjectiveGuards({
      objective,
      threadContext: effectiveThreadContext,
      executionMode: runState.executionMode,
      objectivePolicy,
      runIsRefinement,
    });
    const mediaQualityNotes = buildImageQualityNotes(objective, effectiveThreadContext);
    const objectiveContractNotes = buildObjectiveContractNotes(
      objective,
      effectiveThreadContext,
      runState.executionMode,
      objectivePolicy,
    );
    const completedIterations = Array.isArray(runState.iterations) ? runState.iterations.length : 0;
    const modelCallHits = [];
    const toolCallHits = [];
    const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    const callGuards = {
      beforeModelCall: async () => {
        const waitMs = enforcePerMinuteLimit(modelCallHits, runState.maxModelCallsPerMinute, 'model call');
        if (waitMs > 0) await delay(waitMs);
        enforcePerMinuteLimit(modelCallHits, runState.maxModelCallsPerMinute, 'model call'); // re-record after wait
        runState.lastProgressAt = new Date().toISOString();
      },
      afterModelCall: ({ payload, model: calledModel }) => {
        try {
          const usage = extractUsageFromPayload(payload);
          if (usage.inputTokens > 0 || usage.outputTokens > 0) {
            recordUsage(runState.runId, calledModel, usage.inputTokens, usage.outputTokens);
          }
        } catch { /* non-fatal */ }

        const currentUsage = getRunUsage(runState.runId);
        if (currentUsage && runState.runLimits && runState.runLimits.budgetLimit > 0) {
          if (currentUsage.totalCost > runState.runLimits.budgetLimit) {
            throw new BudgetLimitError(`Budget limit of $${runState.runLimits.budgetLimit.toFixed(2)} exceeded (current cost: $${currentUsage.totalCost.toFixed(2)}).`);
          }
        }
      },
      beforeToolCall: async () => {
        const waitMs = enforcePerMinuteLimit(toolCallHits, runState.maxToolCallsPerMinute, 'tool call');
        if (waitMs > 0) await delay(waitMs);
        enforcePerMinuteLimit(toolCallHits, runState.maxToolCallsPerMinute, 'tool call'); // re-record after wait
        runState.lastProgressAt = new Date().toISOString();
      },
    };

    // Restore prior cost accumulator on resume so budget enforcement sees prior spend.
    // Without this, a resumed run would start at $0 and effectively bypass the budget.
    if (resumeRunId) {
      try {
        const restored = await restoreRunAccumulator(runState.runId);
        if (restored) {
          console.log(`[agent-loop] Restored prior cost accumulator for run ${runState.runId}: $${restored.totalCost.toFixed(4)} (${restored.calls} calls)`);
        }
      } catch { /* non-fatal */ }
    }
    // Also persist a snapshot now so a mid-run crash doesn't lose cost tracking
    try { await persistRunCost(runState.runId); } catch { /* non-fatal */ }

    const unstoppableMode = runState.executionMode === 'auto';
    const maxAutoIterationExtensions = isLocalRun ? 40 : (unstoppableMode ? 10 : 4);
    const iterationExtensionHardCap = isLocalRun ? 9999 : (unstoppableMode ? 60 : 40);

    // Helper: check whether the cost budget is already exhausted.
    // If so, no extension should be granted — the run must stop.
    const isBudgetExhausted = () => {
      const limit = Number(runState.runLimits?.budgetLimit || 0);
      if (limit <= 0) return false; // 0 = unlimited
      try {
        const usage = getRunUsage(runState.runId);
        if (usage && usage.totalCost >= limit) return true;
      } catch { /* non-fatal */ }
      return false;
    };

    const tryExtendIterationBudget = async ({ iteration, reason }) => {
      const currentMax = Number(runState.maxIterations || 0);
      const extensionCount = Number(runState.iterationBudgetExtensions || 0);
      if (extensionCount >= maxAutoIterationExtensions) return false;
      if (currentMax >= iterationExtensionHardCap) return false;
      if (Number(runState.remainingActions || 0) <= 0) return false;
      if (isBudgetExhausted()) return false;

      const extensionStep = isLocalRun ? 40 : 6;
      const nextMax = Math.min(
        iterationExtensionHardCap,
        Math.max(currentMax + extensionStep, Number(iteration || 0) + 1),
      );
      if (nextMax <= currentMax) return false;

      runState.maxIterations = nextMax;
      runState.iterationBudgetExtensions = extensionCount + 1;
      runState.runLimits = {
        ...(ensureObject(runState.runLimits)),
        maxIterations: runState.maxIterations,
        maxActions: runState.remainingActions,
      };
      runState.reason = `Auto-extended iteration budget to ${nextMax}.`;
      runState = await persistRunState(runState);
      broadcastWatchEvent(runState.runId, {
        type: 'iteration_budget_extended',
        iteration,
        summary: `Extended iteration budget to ${nextMax} (extension ${runState.iterationBudgetExtensions}/${maxAutoIterationExtensions}).`,
        detail: truncate(String(reason || 'Evaluator requested more work.'), 220),
      }, { state: 'running', model, workspaceRoot });
      return true;
    };
    const maxAutoActionExtensions = isLocalRun ? 50 : (unstoppableMode ? 10 : 4);
    const actionExtensionHardCap = isLocalRun ? 99999 : (unstoppableMode ? 4000 : 2000);
    const tryExtendActionBudget = async ({ iteration, reason }) => {
      const currentRemaining = Number(runState.remainingActions || 0);
      const extensionCount = Number(runState.actionBudgetExtensions || 0);
      if (extensionCount >= maxAutoActionExtensions) return false;
      if (currentRemaining >= actionExtensionHardCap) return false;
      if (isBudgetExhausted()) return false;
      const extensionStep = isLocalRun ? 300 : (unstoppableMode ? 220 : 80);
      const nextRemaining = Math.min(actionExtensionHardCap, Math.max(currentRemaining, 0) + extensionStep);
      if (nextRemaining <= currentRemaining) return false;

      runState.remainingActions = nextRemaining;
      runState.actionBudgetExtensions = extensionCount + 1;
      runState.runLimits = {
        ...(ensureObject(runState.runLimits)),
        maxActions: Math.max(Number(runState.runLimits?.maxActions || 0), nextRemaining),
      };
      runState.reason = `Auto-extended action budget to ${nextRemaining}.`;
      runState = await persistRunState(runState);
      broadcastWatchEvent(runState.runId, {
        type: 'action_budget_extended',
        iteration,
        summary: `Extended action budget to ${nextRemaining} (extension ${runState.actionBudgetExtensions}/${maxAutoActionExtensions}).`,
        detail: truncate(String(reason || 'Run needed more execution steps.'), 220),
      }, { state: 'running', model, workspaceRoot });
      return true;
    };
    const maxAutoRuntimeExtensions = isLocalRun ? 40 : (unstoppableMode ? 10 : 4);
    const runtimeExtensionHardCapMinutes = isLocalRun ? (24 * 60) : (unstoppableMode ? 240 : 120);
    const tryExtendRuntimeBudget = async ({ iteration, reason }) => {
      const currentRuntime = Number(runState.maxRuntimeMinutes || 0);
      const extensionCount = Number(runState.runtimeBudgetExtensions || 0);
      if (extensionCount >= maxAutoRuntimeExtensions) return false;
      if (currentRuntime >= runtimeExtensionHardCapMinutes) return false;
      if (isBudgetExhausted()) return false;
      const extensionStep = isLocalRun ? 120 : (unstoppableMode ? 45 : 15);
      const nextRuntime = Math.min(runtimeExtensionHardCapMinutes, Math.max(currentRuntime, 0) + extensionStep);
      if (nextRuntime <= currentRuntime) return false;

      runState.maxRuntimeMinutes = nextRuntime;
      runState.runtimeBudgetExtensions = extensionCount + 1;
      runState.runLimits = {
        ...(ensureObject(runState.runLimits)),
        maxRuntimeMinutes: nextRuntime,
      };
      runState.reason = `Auto-extended runtime budget to ${nextRuntime} minutes.`;
      runState = await persistRunState(runState);
      broadcastWatchEvent(runState.runId, {
        type: 'runtime_budget_extended',
        iteration,
        summary: `Extended runtime budget to ${nextRuntime} minute(s) (extension ${runState.runtimeBudgetExtensions}/${maxAutoRuntimeExtensions}).`,
        detail: truncate(String(reason || 'Run needed more wall-clock time.'), 220),
      }, { state: 'running', model, workspaceRoot });
      return true;
    };
    const recoveryEscalationLimit = isLocalRun ? 120 : (unstoppableMode ? 20 : 8);
    const escalateRecoveryMode = async ({
      iteration,
      gate,
      reason,
      nextFocus,
      extendIterations = true,
      extendActions = true,
      extendRuntime = true,
    }) => {
      const used = Number(runState.recoveryEscalations || 0);
      if (used >= recoveryEscalationLimit) return false;
      runState.recoveryEscalations = used + 1;

      const details = [];
      if (extendIterations) {
        const extended = await tryExtendIterationBudget({ iteration, reason: `Recovery gate "${gate}": ${reason}` });
        if (extended) details.push('iteration budget extended');
      }
      if (extendActions) {
        const extended = await tryExtendActionBudget({ iteration, reason: `Recovery gate "${gate}": ${reason}` });
        if (extended) details.push('action budget extended');
      }
      if (extendRuntime) {
        const extended = await tryExtendRuntimeBudget({ iteration, reason: `Recovery gate "${gate}": ${reason}` });
        if (extended) details.push('runtime budget extended');
      }

      const normalizedFocus = String(nextFocus || '').trim();
      runState.nextFocus = normalizedFocus || [
        `UNSTOPPABLE RECOVERY MODE (${runState.recoveryEscalations}/${recoveryEscalationLimit})`,
        `Recovery gate: ${gate}`,
        `Reason: ${truncate(String(reason || ''), 240)}`,
        'Do not repeat previously failing action fingerprints.',
        'Choose a materially different tool chain and execute concrete build actions this iteration.',
      ].join('\n');
      runState.reason = `Recovery escalation [${gate}] — ${truncate(String(reason || ''), 200)}`;
      runState.lastProgressAt = new Date().toISOString();
      runState = await persistRunState(runState);
      broadcastWatchEvent(runState.runId, {
        type: 'failure_recovery',
        iteration,
        summary: `Recovery escalation [${gate}] (${runState.recoveryEscalations}/${recoveryEscalationLimit}).`,
        detail: details.length > 0
          ? `${details.join(' • ')} • ${truncate(String(reason || ''), 180)}`
          : truncate(String(reason || ''), 180),
      }, { state: 'running', model, workspaceRoot });
      return true;
    };

    // HARD ABSOLUTE ITERATION CAP — cannot be bypassed by any extension logic.
    // This is the ultimate safety net against runaway loops.
    const ABSOLUTE_ITERATION_CAP = isLocalRun ? 9999 : 60;

    // ── PHASE 1: Upfront task decomposition ───────────────────────────────
    // For small/local models, generate ALL steps in a single LLM call before
    // the iteration loop starts. This prevents context growth, eliminates the
    // 100+ LLM call loop pattern, and avoids safeguard loops caused by API
    // errors that occur when context overflows.
    //
    // If upfront planning fails (e.g. model can't produce valid JSON), we fall
    // back gracefully to the existing per-iteration reactive planning.
    // ─────────────────────────────────────────────────────────────────────────
    // Use upfront planning for ALL local (Ollama) models — not just small ones.
    // Even large local models like qwen3-coder:30b ignore the objective in the
    // reactive loop because the planner prompt is too noisy. A single focused
    // planning call produces much more accurate results.
    const shouldUseUpfrontPlan = isLocalRun
      && !resumeRunId
      && !detectInteractiveBrowserTask(objective, effectiveThreadContext).enabled;
    if (shouldUseUpfrontPlan && !(runState.upfrontPlanSteps && runState.upfrontPlanSteps.length > 0)) {
      try {
        const upfrontWorkspaceFiles = await listWorkspaceFiles(workspaceRoot, 2, 180).catch(() => []);
        broadcastWatchEvent(runState.runId, {
          type: 'upfront_planning',
          summary: 'Generating complete task plan upfront...',
        }, { state: 'running', model, workspaceRoot });
        const upfrontResult = await createUpfrontPlan({
          settings: executionSettings,
          model,
          objective,
          workspaceFiles: upfrontWorkspaceFiles,
          webIdentity: executionSettings.webIdentity || {},
          userProfile: executionSettings.userProfile || {},
          executionCore: runState.executionCore,
          bannedApproaches: mergeBannedApproachLists(
            computeBannedApproaches(runState.iterations),
            relevantCrossRunBannedApproaches(executionSettings.userProfile || {}, {
              objective,
              executionMode: runState.executionMode,
              objectivePolicy,
            }),
          ),
          callGuards: null, // callGuards not fully init yet — non-fatal if null
        });
        runState.upfrontPlanSteps = upfrontResult.steps;
        runState.upfrontPlanStepIndex = 0;
        runState.upfrontPlanSummary = upfrontResult.summary;
        console.log('[agent-loop] Upfront plan ready:', upfrontResult.steps.length, 'steps');
        broadcastWatchEvent(runState.runId, {
          type: 'upfront_planning_complete',
          summary: `Plan ready: ${upfrontResult.steps.length} steps — ${upfrontResult.summary}`,
        }, { state: 'running', model, workspaceRoot });
      } catch (upfrontErr) {
        console.warn('[agent-loop] Upfront plan generation failed, falling back to reactive planning:', upfrontErr?.message);
        runState.upfrontPlanSteps = [];
        runState.upfrontPlanStepIndex = 0;
      }
    }

    for (let iteration = completedIterations + 1; iteration <= runState.maxIterations; iteration += 1) {
      // --- Hard cap: absolutely no more iterations beyond this ---
      if (iteration > ABSOLUTE_ITERATION_CAP) {
        doneReason = `Hard iteration cap (${ABSOLUTE_ITERATION_CAP}) reached. Stopping run.`;
        console.warn(`[agent-loop] HARD CAP: iteration ${iteration} exceeds absolute cap ${ABSOLUTE_ITERATION_CAP}. Forcing stop.`);
        break;
      }
      // --- Budget check at the top of each iteration ---
      if (isBudgetExhausted()) {
        doneReason = `Budget limit of $${Number(runState.runLimits?.budgetLimit || 0).toFixed(2)} exhausted.`;
        break;
      }
      if (isRunStopRequested(runState.runId)) {
        doneReason = getRunStopReason(runState.runId) || 'Stopped by user request.';
        break;
      }
      const currentRuntimeMs = Math.max(1, Number(runState.maxRuntimeMinutes || 0)) * 60 * 1000;
      if (Date.now() - sessionStartedAt > currentRuntimeMs) {
        const extended = await tryExtendRuntimeBudget({
          iteration,
          reason: 'Runtime cap reached while objective is still in progress.',
        });
        if (extended) {
          continue;
        }
        doneReason = 'Stopped at runtime limit after exhausting recovery extensions.';
        break;
      }
      if (runState.remainingActions <= 0) {
        const extended = await tryExtendActionBudget({
          iteration,
          reason: 'Action budget depleted while objective is still in progress.',
        });
        if (extended) {
          continue;
        }
        doneReason = 'Stopped at action budget limit after exhausting recovery extensions.';
        break;
      }
      const lastProgressMs = new Date(runState.lastProgressAt || runState.updatedAt || runState.startedAt || Date.now()).getTime();
      if (Number.isFinite(lastProgressMs) && (Date.now() - lastProgressMs) > (runState.idleTimeoutSeconds * 1000)) {
        const recovered = await escalateRecoveryMode({
          iteration,
          gate: 'idle_timeout',
          reason: `No measurable progress for ${runState.idleTimeoutSeconds}s.`,
          nextFocus: [
            'IDLE TIMEOUT RECOVERY:',
            `No progress for ${runState.idleTimeoutSeconds}s.`,
            'Immediately execute a concrete unblocking action (run_command/write_file/patch_file/run_playwright).',
            'Avoid repeated planning-only steps.',
          ].join('\n'),
        });
        if (recovered) {
          continue;
        }
        doneReason = `Stopped after ${runState.idleTimeoutSeconds}s with no progress and exhausted recovery escalations.`;
        break;
      }

      // --- Auto-pivot: detect tool-unavailable / blocked patterns and force a different approach ---
      const lastIterResults = runState.iterations.length > 0
        ? runState.iterations[runState.iterations.length - 1].results || []
        : [];
      const toolBlockedResults = lastIterResults.filter((r) =>
        !r.ok && (
          (r.summary && (r.summary.includes('Unsupported tool') || r.summary.includes('Unknown tool') || r.summary.includes('Skipped:')))
          || (r.output && (r.output.includes('is not recognized') || r.output.includes('is not a built-in tool') || r.output.includes('command not found')))
        ),
      );
      if (toolBlockedResults.length > 0 && !runState.nextFocus) {
        const blockedTools = toolBlockedResults.map((r) => r.tool).filter(Boolean).join(', ');
        runState.nextFocus = [
          `TOOL UNAVAILABLE: ${blockedTools} could not be used.`,
          'DO NOT retry the same tools. Instead:',
          '- Use run_command to invoke CLI programs directly (e.g., run_command with command="code", command="xcodebuild")',
          '- Install missing dependencies with run_command (npm install, pip install, brew install)',
          '- Create needed files/configs from scratch with write_file',
          '- Use an alternative tool or approach that achieves the same goal',
          'You are autonomous — find a way to make it work.',
        ].join('\n');
      }

      // ---------- Self-healing context management ----------
      // After repeated planning failures (timeouts / connection errors), the accumulated
      // history is likely too large for the model's context window.  Trim aggressively
      // so the next attempt actually fits in context and doesn't timeout again.
      const historyEntries = consecutivePlanningFailures >= 2 ? 2 : 5;
      const progressSummary = summarizeRunHistory(runState.iterations, historyEntries);
      const nextFocus = String(runState.nextFocus || objective);
      const touchedFiles = runIsRefinement ? collectPreviouslyTouchedFiles(runState.results, 12) : [];
      const scopeGuardNotes = runIsRefinement
        ? [
          'ITERATION SCOPE LOCK:',
          '- This is an iteration/refinement task. Do NOT restart or scaffold a new project.',
          '- Modify existing implementation first; create new files only when strictly required for the requested change.',
          '- Keep unrelated files untouched.',
          touchedFiles.length > 0
            ? `- Prior touched files (prefer these): ${touchedFiles.join(', ')}`
            : '- No prior touched files recorded yet; make the smallest possible change set.',
        ].join('\n')
        : '';
      // Include thread context so the planner knows what was discussed/decided
      const threadContextBlock = effectiveThreadContext
        ? `\nConversation context (prior discussion in this thread):\n${effectiveThreadContext}\n`
        : '';

      // --- Reflect-on-results prompt (nanobot-inspired) ---
      // After iteration 1+, force the planner to reflect on what just happened
      // before planning the next actions.  This prevents blind repetition.
      let reflectionBlock = '';
      if (runState.iterations.length > 0) {
        const lastIter = runState.iterations[runState.iterations.length - 1];
        const lastResults = Array.isArray(lastIter.results) ? lastIter.results : [];
        const successes = lastResults.filter((r) => r.ok);
        const failures = lastResults.filter((r) => !r.ok);
        const lastWasPlannerDone = lastResults.length === 0; // planner declared done with no actions
        const evaluatorRejection = runState.lastEvaluatorRejection || '';
        // Detect success no-ops: same action with same output, repeated across iterations
        const repeatedNoOps = detectRepeatedNoOps(runState.iterations);
        const noOpWarning = repeatedNoOps.length > 0
          ? `NO-OP LOOP DETECTED: The following actions keep returning the same result and are making NO progress:\n${repeatedNoOps.map((n) => `- ${n.tool} (repeated ${n.count}x with same output: "${truncate(n.primary, 60)}")`).join('\n')}\nSTOP doing these. They are not moving you forward. Try a completely different approach.`
          : '';
        reflectionBlock = [
          '',
          '=== REFLECT ON LAST ITERATION ===',
          lastWasPlannerDone
            ? 'Last iteration: you declared done and took NO actions.'
            : `Last iteration had ${successes.length} success(es) and ${failures.length} failure(s).`,
          failures.length > 0
            ? `Failed actions: ${failures.map((f) => `${f.tool}: ${truncate(f.output || f.summary || '', 120)}`).join('; ')}`
            : '',
          evaluatorRejection
            ? `EVALUATOR REJECTED COMPLETION: ${evaluatorRejection}\nYou MUST take concrete action to fix this — do not declare done again until it is fixed.`
            : '',
          consecutivePlannerDoneRejections >= 2
            ? `WARNING: You have incorrectly declared done ${consecutivePlannerDoneRejections} times in a row. The evaluator keeps rejecting it. TAKE ACTION instead of asserting done.`
            : '',
          noOpWarning || '',
          'Before planning new actions, consider:',
          '1. What worked? Build on those results — do NOT redo them.',
          '2. What failed? Why? Choose a DIFFERENT approach — never blindly retry.',
          '3. What is the shortest path from current state to done?',
          '4. NEVER read a file you already read in a previous iteration. You have that data — use it.',
          '5. If Playwright already verified the page (consoleErrorCount=0, title/heading correct) — the work PASSED. Set done=true.',
          '================================',
          '',
        ].filter(Boolean).join('\n');
      }

      const iterationObjective = [
        `Primary objective: ${objective}`,
        `Execution mode: ${runState.executionMode}`,
        threadContextBlock,
        `Current focus for this iteration: ${nextFocus}`,
        'Non-negotiable: stay on this objective only.',
        'Ignore unrelated previous tasks unless explicitly requested in the current objective.',
        'IMPORTANT: Review "Progress so far" carefully. Do NOT repeat research, file reads, or actions already completed successfully. Build on prior results.',
        objectivePolicyNotes ? `Objective policy:\n${objectivePolicyNotes}` : '',
        objectiveContractNotes,
        scopeGuardNotes,
        mediaQualityNotes,
        '',
        'Progress so far:',
        progressSummary,
        reflectionBlock,
        'Plan the next best actions only. Do NOT redo work already completed above.',
      ].join('\n');

      const watchSeed = {
        objective,
        state: 'running',
        provider: runState.provider,
        model,
        workspaceRoot,
        teamMode: runState.teamMode,
        executionMode: runState.executionMode,
      };
      const planningDetail = { phase: 'calling' };
      const stopPlanningHeartbeat = startWatchHeartbeat(
        runState.runId,
        watchSeed,
        (tick) => {
          const elapsed = tick * 5;
          const phase = planningDetail.phase || 'calling';
          if (elapsed <= 10) return `Calling ${model}...`;
          if (phase === 'team_brief') return `Team briefing in progress... (${elapsed}s)`;
          if (phase === 'parsing') return `Parsing plan from ${model}... (${elapsed}s)`;
          if (elapsed <= 60) return `${model} thinking... (${elapsed}s)`;
          if (elapsed <= 120) return `${model} still generating plan... (${elapsed}s) — complex objective may take a few minutes`;
          return `Long planning cycle — ${model} (${elapsed}s) — will auto-timeout if stuck`;
        },
        5000,
      );
      let plan;
      try {
        throwIfRunStopped(runState.runId);

        // \u2500\u2500 PHASE 2: Consume next pre-planned step (no LLM call needed) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        const stepQueue = Array.isArray(runState.upfrontPlanSteps) ? runState.upfrontPlanSteps : [];
        const stepIdx = Number(runState.upfrontPlanStepIndex || 0);

        if (stepQueue.length > 0 && stepIdx < stepQueue.length) {
          // Still have pre-planned steps to execute
          const nextStep = stepQueue[stepIdx];
          runState.upfrontPlanStepIndex = stepIdx + 1;
          const remaining = stepQueue.length - stepIdx - 1;
          console.log(`[upfront-plan] Executing step ${stepIdx + 1}/${stepQueue.length}: ${nextStep.tool} (${remaining} remaining)`);
          stopPlanningHeartbeat();
          plan = {
            summary: nextStep.intent || `Step ${stepIdx + 1}: ${nextStep.tool}`,
            actions: [nextStep],
            done: false,
          };
        } else {
          const browserControllerPlan = buildInteractiveBrowserPlan({
            objective,
            threadContext: effectiveThreadContext,
            priorResults: runState.results,
            settings: executionSettings,
            workspaceRoot,
          });
          if (browserControllerPlan) {
            console.log(`[browser-controller] ${browserControllerPlan.summary}`);
            stopPlanningHeartbeat();
            plan = browserControllerPlan;
          } else {
            // Queue empty or not using upfront plan \u2014 fall back to reactive planning
            if (stepQueue.length > 0 && stepIdx >= stepQueue.length) {
              console.log('[upfront-plan] All pre-planned steps executed. Checking completion with evaluator.');
            }
            plan = await createAgentPlan({
              settings: executionSettings,
              model,
              task: iterationObjective,
              rootObjective: objective,
              workspaceRoot,
              priorResults: runState.results,
              teamMode: runState.teamMode,
              historySummary: progressSummary,
              discoveryHints: runState.discoveryHints || [],
              runId: runState.runId,
              iteration,
              objectiveForWatch: objective,
              objectivePolicy,
              callGuards,
              threadContext: effectiveThreadContext,
              executionMode: runState.executionMode,
              executionCore: runState.executionCore,
              bannedApproaches: mergeBannedApproachLists(
                computeBannedApproaches(runState.iterations),
                relevantCrossRunBannedApproaches(executionSettings.userProfile || {}, {
                  objective,
                  executionMode: runState.executionMode,
                  objectivePolicy,
                }),
              ),
              activeSkillContent: runState.activeSkillContent || '',
              scopeGuardNotes,
              mediaQualityNotes,
              objectiveGuards,
              onTeamEvent: (event) => {
                broadcastWatchEvent(runState.runId, {
                  ...event,
                  iteration,
                }, watchSeed);
              },
            });
          }
        }
      } catch (error) {
        if (error instanceof StopRequestedError) {
          doneReason = error.message || 'Stopped by user request.';
          break;
        }
        if (error instanceof BudgetLimitError) {
          runState.state = 'needs_info';
          runState.pendingQuestions = [
            `Budget limit reached (${error.message}). Do you want to switch to a free local model to continue? (Reply "yes" to switch to local, or "no" to stop)`
          ];
          runState.reason = 'Budget limit reached.';
          runState = await persistRunState(runState);
          broadcastWatchEvent(runState.runId, {
            type: 'user_input_required',
            summary: 'Budget limit reached.',
            detail: runState.pendingQuestions[0],
          });
          break;
        }
        if (!isTransientError(error)) {
          throw error;
        }

        // ===================================================================
        // SELF-HEALING RECOVERY: Transient error (timeout, network, etc.)
        // Instead of blindly retrying the same bloated context, diagnose the
        // problem and adapt: trim history, restart Ollama if needed, and
        // inject a focused recovery prompt so the model changes its approach.
        // ===================================================================
        consecutivePlanningFailures += 1;
        const errMsg = String(error?.message || error);
        const isTimeout = errMsg.includes('timed out') || errMsg.includes('timeout') || errMsg.includes('wall-clock');
        console.warn(`[agent-loop] Planning transient error (attempt ${consecutivePlanningFailures}): ${errMsg}`);

        // --- Phase 1: Diagnose & log ---
        const diagnosis = isTimeout
          ? 'The model response timed out — likely context overflow or runaway generation.'
          : `Network/connection error: ${truncate(errMsg, 100)}`;

        runState.iterations.push({
          iteration,
          summary: `Planning failed (${isTimeout ? 'timeout' : 'transient'} — self-healing recovery active): ${truncate(errMsg, 200)}`,
          model,
          results: [{
            tool: 'think',
            intent: 'Self-healing: diagnosing planning failure and adapting strategy',
            ok: false,
            output: [
              `Diagnosis: ${diagnosis}`,
              `Consecutive failures: ${consecutivePlanningFailures}`,
              consecutivePlanningFailures >= 2 ? 'Recovery: trimming context history to last 2 iterations.' : '',
              consecutivePlanningFailures >= 3 && isLocalRun ? 'Recovery: will restart Ollama to clear stuck inference.' : '',
            ].filter(Boolean).join(' | '),
            iteration,
          }],
        });
        runState.lastProgressAt = new Date().toISOString();

        // --- Phase 2: Reset Ollama connection if stuck (local runs, 3+ failures) ---
        // Instead of killing Ollama (which causes 'address in use' errors), just
        // wait longer for it to finish the stuck request and become available.
        if (isLocalRun && consecutivePlanningFailures >= 3 && isTimeout) {
          console.warn('[agent-loop] Self-healing: waiting for Ollama to recover from stuck inference...');
          broadcastWatchEvent(runState.runId, {
            type: 'self_healing',
            iteration,
            summary: `Self-healing: waiting for Ollama to clear stuck inference (attempt ${consecutivePlanningFailures})`,
          }, { state: 'running', model, workspaceRoot });

          // Wait up to 30s for Ollama to become responsive
          let ollamaReady = false;
          for (let waitAttempt = 0; waitAttempt < 10; waitAttempt++) {
            await new Promise((r) => setTimeout(r, 3000));
            try {
              const resp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(5000) });
              if (resp.ok) {
                console.log('[agent-loop] Self-healing: Ollama is responsive.');
                ollamaReady = true;
                break;
              }
            } catch { /* not ready yet */ }
          }

          // If Ollama is still unresponsive after 30s, try a graceful restart
          if (!ollamaReady) {
            try {
              const { execSync } = require('child_process');
              console.warn('[agent-loop] Self-healing: Ollama still unresponsive, attempting graceful restart...');
              execSync('killall ollama 2>/dev/null || true', { stdio: 'ignore', timeout: 5000, shell: true });
              await new Promise((r) => setTimeout(r, 5000));
              // Ollama's macOS app auto-restarts; if not, this is a best-effort nudge
              for (let waitAttempt = 0; waitAttempt < 10; waitAttempt++) {
                await new Promise((r) => setTimeout(r, 3000));
                try {
                  const resp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(5000) });
                  if (resp.ok) {
                    console.log('[agent-loop] Self-healing: Ollama is back online after restart.');
                    break;
                  }
                } catch { /* not ready yet */ }
              }
            } catch (restartErr) {
              console.warn('[agent-loop] Self-healing: Ollama restart attempt failed:', restartErr?.message);
            }
          }
        }

        // --- Phase 3: Inject self-healing focus for next iteration ---
        if (consecutivePlanningFailures >= 2) {
          runState.nextFocus = [
            `SELF-HEALING MODE: ${consecutivePlanningFailures} consecutive planning failures (${isTimeout ? 'timeout' : 'connection error'}).`,
            'DIAGNOSIS: The previous planning attempts exceeded the model\'s capacity.',
            'MANDATORY RECOVERY ACTIONS:',
            '1. SIMPLIFY: Plan only 2-3 small, focused actions this iteration — no huge file writes.',
            '2. DO NOT re-read files you already know the content of.',
            '3. If the previous approach was too complex, break it into a smaller sub-task.',
            '4. Prefer patch_file over write_file for edits (smaller output).',
            '5. If you were generating a large file, split it into multiple smaller write_file calls across iterations.',
            `Original objective: ${truncate(objective, 200)}`,
          ].join('\n');
        }

        runState = await persistRunState(runState);

        broadcastWatchEvent(runState.runId, {
          type: 'failure_recovery',
          iteration,
          summary: consecutivePlanningFailures >= 2
            ? `Self-healing recovery (${consecutivePlanningFailures}/${isLocalRun ? 10 : 3}): ${isTimeout ? 'trimming context + simplifying approach' : 'retrying with adapted strategy'}...`
            : `Planning error (${consecutivePlanningFailures} consecutive): ${truncate(errMsg, 120)}. Retrying...`,
        }, { state: 'running', model, workspaceRoot });

        // Local (Ollama) runs: allow more planning failures before giving up — the model may need
        // time to load or may have brief connection drops between iterations.
        const planningFailureLimit = isLocalRun ? 10 : (unstoppableMode ? 8 : 3);
        if (consecutivePlanningFailures >= planningFailureLimit) {
          const recovered = await escalateRecoveryMode({
            iteration,
            gate: 'planning_failures',
            reason: `Planning failed ${consecutivePlanningFailures} time(s): ${truncate(errMsg, 200)}`,
            nextFocus: [
              `PLANNING FAILURE ESCALATION: ${consecutivePlanningFailures} consecutive planning failures.`,
              'Switch to a radically simpler plan with 1-3 concrete execution actions.',
              'Avoid any read-only loops and execute at least one tangible build action immediately.',
              `Latest planner error: ${truncate(errMsg, 200)}`,
            ].join('\n'),
          });
          if (recovered) {
            consecutivePlanningFailures = 0;
            continue;
          }
          doneReason = `Stopped after ${consecutivePlanningFailures} consecutive planning failures. Last error: ${truncate(errMsg, 200)}`;
          break;
        }

        // Adaptive back-off: longer waits after more failures, especially after Ollama restart
        const backoffMs = consecutivePlanningFailures >= 3 && isLocalRun
          ? 30000  // 30s after Ollama restart to let model fully load
          : Math.min(5000 * consecutivePlanningFailures, 20000);
        await new Promise((resolve) => { setTimeout(resolve, backoffMs); });
        continue;
      } finally {
        stopPlanningHeartbeat();
      }
      consecutivePlanningFailures = 0;
      model = plan.model || model;
      runState.lastProgressAt = new Date().toISOString();

      // -----------------------------------------------------------------------
      // Planner said "done" with zero actions — skip execution, jump to
      // progress evaluation to confirm completion.
      // -----------------------------------------------------------------------
      if (plan.plannerDone && plan.actions.length === 0) {
        console.log('[agent-loop] Planner signalled done with 0 actions — skipping execution.');
        if (runState.runId) {
          broadcastWatchEvent(runState.runId, {
            type: 'evaluating_completion',
            iteration,
            summary: 'Verifying objective is complete...',
          }, { state: 'running', model, workspaceRoot });
        }
        // Proceed directly to completion evaluation below
        const iterationResults = [];
        const iterationSummaryText = 'No actions executed — planner declared objective complete.';

        runState.iterations.push({
          iteration,
          results: iterationResults,
          timestamp: new Date().toISOString(),
        });
        runState.totalActions += 0;
        runState = await persistRunState(runState);

        let progress;
        try {
          progress = await evaluateObjectiveProgress({
            settings: executionSettings,
            model,
            objective,
            workspaceRoot,
            iterationSummary: iterationSummaryText,
            priorProgressSummary: summarizeRunHistory(runState.iterations.slice(0, -1), 4),
            threadContext: effectiveThreadContext,
            latestResults: iterationResults,
            remainingIterations: runState.maxIterations - iteration,
            callGuards,
            repeatedFailures: detectRepeatedFailures(runState.iterations),
            activeSkillContent: runState.activeSkillContent || '',
          });
        } catch (evalError) {
          if (evalError instanceof BudgetLimitError) {
            runState.state = 'needs_info';
            runState.pendingQuestions = [
              `Budget limit reached (${evalError.message}). Do you want to switch to a free local model to continue? (Reply "yes" to switch to local, or "no" to stop)`
            ];
            runState.reason = 'Budget limit reached.';
            runState = await persistRunState(runState);
            broadcastWatchEvent(runState.runId, {
              type: 'user_input_required',
              summary: 'Budget limit reached.',
              detail: runState.pendingQuestions[0],
            });
            break;
          }
          throw evalError;
        }

        if (progress.needs_info) {
          runState.state = 'needs_info';
          runState.pendingQuestions = progress.questions;
          runState.reason = progress.reason || 'Waiting for user input.';
          runState = await persistRunState(runState);
          broadcastWatchEvent(runState.runId, {
            type: 'user_input_required',
            summary: 'Geepus needs more information to continue.',
            detail: (progress.questions || []).join(' | '),
          });
          break;
        }
        if (progress.done) {
          done = true;
          doneReason = progress.reason || 'Objective completed.';
          runState.finalSummary = progress.summary || plan.summary;
          break;
        }
        // Evaluator disagrees — record it explicitly and feed it back to the planner
        consecutivePlannerDoneRejections += 1;
        const rejectionNext = progress.next_focus || '';
        const rejectionReason = progress.reason || 'Evaluator says not done yet.';
        runState.lastEvaluatorRejection = rejectionReason + (rejectionNext ? `\nRequired action: ${rejectionNext}` : '');
        runState.nextFocus = rejectionNext
          ? `EVALUATOR REJECTED — you must fix this before declaring done again:\n${rejectionReason}\nRequired next action: ${rejectionNext}`
          : rejectionReason;
        runState.reason = rejectionReason;
        if (runState.runId) {
          broadcastWatchEvent(runState.runId, {
            type: 'progress_not_done',
            iteration,
            summary: `Not complete (attempt ${consecutivePlannerDoneRejections}): ${truncate(rejectionReason, 120)}`,
          }, { state: 'running', model, workspaceRoot });
        }
        // Hard-stop: if planner keeps declaring done but evaluator keeps disagreeing,
        // the planner is unable to make forward progress. Bail out with a clear message.
        // Local runs are exempt — let Ollama keep trying all night.
        if (consecutivePlannerDoneRejections >= 5 && !isLocalRun) {
          const recovered = await escalateRecoveryMode({
            iteration,
            gate: 'planner_done_rejected',
            reason: `Planner declared done ${consecutivePlannerDoneRejections} times but evaluator rejected completion.`,
            nextFocus: [
              `COMPLETION FALSE-POSITIVE LOOP: evaluator rejected completion ${consecutivePlannerDoneRejections} times.`,
              'Do not declare done this iteration.',
              'Execute concrete fixes for the evaluator feedback, then rerun validation.',
              `Evaluator reason: ${truncate(rejectionReason, 220)}`,
            ].join('\n'),
          });
          if (recovered) {
            consecutivePlannerDoneRejections = 0;
            continue;
          }
          doneReason = `Stopped: planner declared the objective complete ${consecutivePlannerDoneRejections} times in a row but the evaluator disagreed each time. ${rejectionReason}`;
          break;
        }
        runState = await persistRunState(runState);
        continue;
      }

      const activeRecovery = enforceActiveRecoveryForPassiveLoop({
        plan,
        iterations: runState.iterations,
        objective,
        threadContext: effectiveThreadContext,
        priorResults: runState.results,
        settings: executionSettings,
        workspaceRoot,
      });
      if (activeRecovery.replaced) {
        plan = activeRecovery.plan;
        broadcastWatchEvent(runState.runId, {
          type: 'active_recovery_forced',
          iteration,
          summary: 'Passive browser loop detected — forcing an active recovery plan.',
          detail: truncate(`Loop state: ${activeRecovery.reason} | New plan: ${plan.summary}`, 220),
        }, { state: 'running', model, workspaceRoot });
      }

      // Mutable ref so the heartbeat callback always sees the current action
      const heartbeatAction = { tool: '', intent: '', owner: '', index: 0, total: 0 };
      const stopExecutionHeartbeat = startWatchHeartbeat(
        runState.runId,
        watchSeed,
        (tick) => {
          const elapsed = tick * 5;
          const { tool, intent, index, total } = heartbeatAction;
          if (tool) {
            const step = total > 1 ? `[${index}/${total}] ` : '';
            const desc = intent ? truncate(intent, 80) : tool;
            return `${step}${tool}: ${desc} (${elapsed}s)`;
          }
          return `Running actions... (${elapsed}s)`;
        },
        5000,
      );
      let execution;
      try {
        throwIfRunStopped(runState.runId);

        // Filter out actions that match banned approach signatures
        const currentBanned = mergeBannedApproachLists(
          computeBannedApproaches(runState.iterations),
          relevantCrossRunBannedApproaches(executionSettings.userProfile || {}, {
            objective,
            executionMode: runState.executionMode,
            objectivePolicy,
          }),
        );
        const currentTaskClass = inferRunTaskClass({
          objective,
          executionMode: runState.executionMode,
          objectivePolicy,
        });
        const blockedPlannedActions = plan.actions.filter((action) => isActionBanned(action, currentBanned));
        const filteredActions = plan.actions.filter((action) => !isActionBanned(action, currentBanned));
        const fallbackActions = blockedPlannedActions
          .map((action) => buildFallbackAlternativeForBannedAction(action, {
            objective,
            taskClass: currentTaskClass,
          }))
          .filter((action) => action && !isActionBanned(action, currentBanned))
          .slice(0, Math.max(1, blockedPlannedActions.length));
        const blockedActions = plan.actions.length - filteredActions.length;
        if (blockedActions > 0) {
          const fallbackPreview = fallbackActions
            .slice(0, 4)
            .map((action) => `${action.tool}: ${truncate(action.intent || '', 72)}`)
            .join(' | ');
          runState.lastPlanConstraint = {
            type: 'banned_approach',
            blockedActions,
            summary: `${blockedActions} planned action(s) were blocked by stored failure fingerprints.${fallbackActions.length > 0 ? ` Injected ${fallbackActions.length} fallback action(s).` : ''}`,
            detail: currentBanned
              .slice(0, 5)
              .map((entry) => `${entry.tool}[${truncate(entry.key || entry.signature || '', 56)}]`)
              .join(', ') + (fallbackPreview ? ` | Fallbacks: ${fallbackPreview}` : ''),
            updatedAt: new Date().toISOString(),
          };
          broadcastWatchEvent(runState.runId, {
            type: 'iteration_update',
            iteration,
            owner: 'chief',
            summary: runState.lastPlanConstraint.summary,
            detail: runState.lastPlanConstraint.detail,
          }, {
            objective,
            state: runState.state,
            provider: runState.provider,
            model,
            workspaceRoot,
            teamMode: runState.teamMode,
            executionMode: runState.executionMode,
            executionCore: runState.executionCore,
            activeLearnedStrategies: runState.activeLearnedStrategies,
            activeBannedApproaches: runState.activeBannedApproaches,
          });
        } else {
          runState.lastPlanConstraint = null;
        }
        const executableActions = [...filteredActions, ...fallbackActions];

        if (executableActions.length === 0) {
          const bannedPreview = currentBanned
            .slice(0, 5)
            .map((entry) => `${entry.tool}[${truncate(entry.key || '', 56)}]`)
            .join(', ');
          runState.nextFocus = [
            'BAN-TRAP RECOVERY: Every proposed action matched a previously failed fingerprint.',
            'You must produce a plan using different concrete targets (new file path, new command, new URL, or different tool).',
            'Do not repeat the same command/path/URL that has already failed 3+ times.',
            bannedPreview ? `Blocked fingerprints: ${bannedPreview}` : '',
            `Objective reminder: ${truncate(objective, 220)}`,
          ].filter(Boolean).join('\n');
          runState.reason = 'Planner proposed only banned action fingerprints; forcing recovery pivot.';
          // All actions were banned — keep iteration lightweight and avoid executing unsafe repeats.
          execution = {
            state: 'completed',
            results: [{
              tool: 'think',
              intent: 'All planned actions matched banned failure fingerprints — forcing recovery pivot',
              ok: false,
              output: 'Every action fingerprint in this plan has repeatedly failed. Pivoting next iteration with new concrete targets.',
              metadata: {
                allBannedSkip: true,
                bannedCount: currentBanned.length,
              },
            }],
            requiresApproval: false,
            plannerDone: plan.plannerDone,
          };
        } else {
          execution = await executePlannedActions({
            settings: executionSettings,
            model,
            task: objective,
            workspaceRoot,
            priorResults: runState.results,
            planSummary: plan.summary,
            actions: executableActions,
            allowRisky,
            securityControls: executionSettings.securityControls || {},
            maxActions: runState.remainingActions,
            teamMode: runState.teamMode || executionSettings.teamMode || 'teams',
            callGuards,
            activeSkillContent: runState.activeSkillContent || '',
            objectiveGuards,
            heartbeatAction,
            runMeta: {
              run_id: runState.runId,
              iteration,
            },
          });
        }
      } catch (error) {
        if (error instanceof StopRequestedError) {
          doneReason = error.message || 'Stopped by user request.';
          break;
        }
        if (error instanceof BudgetLimitError) {
          runState.state = 'needs_info';
          runState.pendingQuestions = [
            `Budget limit reached (${error.message}). Do you want to switch to a free local model to continue? (Reply "yes" to switch to local, or "no" to stop)`
          ];
          runState.reason = 'Budget limit reached.';
          runState = await persistRunState(runState);
          broadcastWatchEvent(runState.runId, {
            type: 'user_input_required',
            summary: 'Budget limit reached.',
            detail: runState.pendingQuestions[0],
          });
          break;
        }
        if (!isTransientError(error)) {
          throw error;
        }
        // Transient error during execution — inject a failed result and recover
        const errMsg = String(error?.message || error);
        console.warn(`[agent-loop] Execution transient error: ${errMsg}`);
        execution = {
          state: 'failed',
          requiresApproval: false,
          stoppedByUser: false,
          plannerDone: false,
          results: [{
            tool: 'think',
            intent: 'Execution interrupted by transient error',
            ok: false,
            output: `Transient error during execution: ${errMsg}. Will retry with a different approach.`,
          }],
        };
      } finally {
        stopExecutionHeartbeat();
      }

      if (execution.requiresApproval) {
        runState.state = 'paused_approval';
        runState.reason = 'Paused for risky action approval.';
        runState.blockedActions = execution.blockedActions;
        runState = await persistRunState(runState);
        await appendAuditEvent({
          type: 'objective_run_paused_for_approval',
          run_id: runState.runId,
          model,
          execution_mode: runState.executionMode,
          execution_core: runState.executionCore,
          workspace_root: workspaceRoot,
          iteration,
        });
        broadcastWatchEvent(runState.runId, {
          type: 'run_paused',
          iteration,
          summary: 'Paused for approval.',
        }, {
          objective,
          state: runState.state,
          provider: runState.provider,
          model,
          workspaceRoot,
          teamMode: runState.teamMode,
          executionMode: runState.executionMode,
          executionCore: runState.executionCore,
        });
        return {
          requiresApproval: true,
          runId: runState.runId,
          model,
          provider: runState.provider,
          teamMode: runState.teamMode,
          executionMode: runState.executionMode,
          executionCore: runState.executionCore,
          runLimits: runState.runLimits,
          workspaceDiscoverySource: runState.workspaceDiscoverySource,
          workspaceRoot,
          iteration,
          summary: plan.summary,
          blockedActions: execution.blockedActions,
          workflow: buildWorkflowView(runState),
        };
      }

      if (execution.stoppedByUser) {
        doneReason = execution.stopReason || getRunStopReason(runState.runId) || 'Stopped by user request.';
        break;
      }

      const iterationResults = execution.results.map((result) => ({
        ...result,
        iteration,
      }));

      runState.iterations.push({
        iteration,
        summary: plan.summary,
        model,
        teamBriefs: Array.isArray(plan.teamBriefs) ? plan.teamBriefs : [],
        results: iterationResults,
      });
      await appendRunDebugEvent(runState.runId, 'iteration_completed', {
        iteration,
        summary: plan.summary || '',
        model,
        resultCount: iterationResults.length,
        okCount: iterationResults.filter((entry) => entry && entry.ok).length,
        failCount: iterationResults.filter((entry) => !entry || !entry.ok).length,
        results: iterationResults.slice(0, 20).map((result) => ({
          tool: String(result.tool || ''),
          ok: result.ok !== false,
          intent: truncate(String(result.intent || ''), 220),
          summary: truncate(String(result.summary || ''), 220),
          output: truncate(String(result.output || ''), 500),
        })),
      }).catch(() => {});
      runState.results.push(...iterationResults);
      runState.remainingActions -= execution.results.length;
      runState.model = model;
      runState.lastProgressAt = new Date().toISOString();
      // Reset planner-done-rejection counter when the planner actually takes real actions
      const hadRealActions = iterationResults.some((r) => r.ok && ['write_file', 'patch_file', 'append_file', 'run_command', 'run_playwright', 'browser_launch', 'browser_action'].includes(r.tool));
      if (hadRealActions) {
        consecutivePlannerDoneRejections = 0;
        runState.lastEvaluatorRejection = '';
      }
      if (runIsRefinement) {
        const restartCheck = detectRestartBehavior(iterationResults);
        if (restartCheck.restartDetected) {
          const detail = restartCheck.restartSignals.slice(0, 3).join('; ');
          runState.nextFocus = [
            'Iteration scope violation detected.',
            'Do NOT restart or scaffold a new project for refinement tasks.',
            'Apply the requested change to the existing files only.',
            detail ? `Blocked restart-like steps: ${detail}` : '',
          ].filter(Boolean).join('\n');
          runState.reason = 'Stopped to prevent project restart during refinement.';
          runState.consecutiveDriftIterations = Number(runState.consecutiveDriftIterations || 0) + 1;
          runState = await persistRunState(runState);
          broadcastWatchEvent(runState.runId, {
            type: 'scope_violation',
            iteration,
            summary: 'Stopped restart-like actions for an iteration task.',
            detail,
          }, { state: 'running', model, workspaceRoot });
          const recovered = await escalateRecoveryMode({
            iteration,
            gate: 'refinement_scope_violation',
            reason: 'Restart/scaffolding actions were attempted during a refinement task.',
            nextFocus: [
              'REFINEMENT SCOPE RECOVERY:',
              'Do not scaffold or restart.',
              'Patch existing files only and verify the requested refinement directly.',
              detail ? `Blocked restart signals: ${detail}` : '',
            ].filter(Boolean).join('\n'),
            extendRuntime: false,
          });
          if (recovered) {
            continue;
          }
          doneReason = 'Stopped: refinement task attempted restart/scaffolding actions unrelated to requested iteration.';
          break;
        }
      }
      const drifted = isIterationDrifted(iterationResults, objective, objectivePolicy, plan.workspaceFiles, runState.results);
      if (drifted) {
        const FETCH_VERBS_WARN = ['find', 'search', 'get me', 'download', 'fetch', 'look up', 'locate', 'retrieve'];
        const MEDIA_EXTS_WARN = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.pdf', '.mp3', '.mp4', '.mov', '.svg']);
        const objLowerWarn = String(objective || '').toLowerCase();
        const objectiveIsFetch = FETCH_VERBS_WARN.some((v) => objLowerWarn.includes(v));
        const wroteMediaThisIter = iterationResults.some(
          (r) => (r.tool === 'write_file' || r.tool === 'append_file')
            && MEDIA_EXTS_WARN.has(path.extname(String(r.metadata?.path || '').toLowerCase())),
        );
        if (objectiveIsFetch && wroteMediaThisIter) {
          runState.nextFocus = [
            'FABRICATION DETECTED: You created image/media files using write_file instead of downloading real ones.',
            'The user asked you to FIND real content — not generate illustrations or placeholder images.',
            'Delete any fabricated files you created. Then:',
            '  1. Use web_search to find pages with the real images (e.g. site:tesla.com press photo).',
            '  2. Use web_scrape or http_request to extract direct image URLs (.jpg or .png).',
            '  3. Use run_command bash -c \'curl -L -o "folder/name.jpg" "<real-url>"\'  for each image.',
            '  4. Confirm with ls -la that each file is >0 bytes.',
          ].join('\n');
        } else {
          // Detect script-versioning loop
          const scriptExts = new Set(['.py', '.sh', '.bash']);
          const totalScripts = runState.results.filter(
            (r) => r.ok !== false && (r.tool === 'write_file' || r.tool === 'append_file')
              && scriptExts.has(path.extname(String(r.metadata?.path || '').toLowerCase())),
          ).length;
          if (totalScripts >= 3) {
            runState.nextFocus = [
              `SCRIPT VERSIONING LOOP DETECTED: You have written ${totalScripts} script files and none have worked.`,
              'STOP writing scripts. Use run_command curl directly for downloads, or http_request for data.',
            ].join('\n');
          }
        }
      }
      const allBannedSkipIteration = iterationResults.some((result) => result?.metadata?.allBannedSkip === true);
      if (allBannedSkipIteration) {
        runState.consecutiveDriftIterations = 0;
      } else {
        runState.consecutiveDriftIterations = drifted
          ? (Number(runState.consecutiveDriftIterations || 0) + 1)
          : 0;
      }
      const currentTaskClass = inferRunTaskClass({
        objective,
        executionMode: runState.executionMode,
        objectivePolicy,
      });
      const consecutiveSafeguardIterations = countConsecutiveSafeguardIterations(runState.iterations);
      const consecutiveNoProgressIterations = countConsecutiveNoProgressIterations(runState.iterations, currentTaskClass);

      if (consecutiveSafeguardIterations >= 2) {
        const recentSafeguard = [...iterationResults].reverse().find((result) => String(result?.tool || '') === 'safeguard_rejected');
        const recentReason = recentSafeguard
          ? String(recentSafeguard.output || recentSafeguard.summary || recentSafeguard.intent || '').trim()
          : '';
        const safeguardFocus = buildObjectiveLockRecoveryFocus({
          objective,
          taskClass: currentTaskClass,
          reason: `${consecutiveSafeguardIterations} consecutive safeguard-only iteration(s).`,
          recentFailure: recentReason,
        });
        runState.nextFocus = safeguardFocus;
        runState.reason = `Safeguard loop detected after ${consecutiveSafeguardIterations} blocked iteration(s).`;
        await appendRunDebugEvent(runState.runId, 'safeguard_loop_detected', {
          iteration,
          taskClass: currentTaskClass,
          consecutiveSafeguardIterations,
          recentReason: truncate(recentReason, 220),
        }).catch(() => {});
        const recovered = await escalateRecoveryMode({
          iteration,
          gate: 'safeguard_loop',
          reason: `${consecutiveSafeguardIterations} consecutive safeguard-only iteration(s).`,
          nextFocus: safeguardFocus,
          extendActions: false,
        });
        if (recovered) {
          continue;
        }
        doneReason = `Stopped after ${consecutiveSafeguardIterations} consecutive safeguard-only iterations with no objective-aligned action.`;
        break;
      }

      const noProgressThreshold = currentTaskClass === 'build'
        ? (isLocalRun ? 4 : 3)
        : 3;
      if (consecutiveNoProgressIterations >= noProgressThreshold) {
        const recentFailures = detectRepeatedFailures(runState.iterations).slice(0, 2);
        const progressFocus = buildObjectiveLockRecoveryFocus({
          objective,
          taskClass: currentTaskClass,
          reason: `${consecutiveNoProgressIterations} consecutive iteration(s) without real progress.`,
          recentFailure: recentFailures.map((entry) => `${entry.tool} (${entry.count}x): ${truncate(entry.error, 80)}`).join(' | '),
        });
        runState.nextFocus = progressFocus;
        runState.reason = `No-progress loop detected after ${consecutiveNoProgressIterations} iteration(s).`;
        await appendRunDebugEvent(runState.runId, 'no_progress_loop_detected', {
          iteration,
          taskClass: currentTaskClass,
          consecutiveNoProgressIterations,
          recentFailures,
        }).catch(() => {});
        const recovered = await escalateRecoveryMode({
          iteration,
          gate: 'no_progress_loop',
          reason: `${consecutiveNoProgressIterations} consecutive iteration(s) without real progress.`,
          nextFocus: progressFocus,
          extendActions: false,
        });
        if (recovered) {
          continue;
        }
        doneReason = `Stopped after ${consecutiveNoProgressIterations} consecutive iterations without real progress.`;
        break;
      }

      // --- Research loop detection ---
      const consecutiveResearchIters = countConsecutiveResearchIterations(runState.iterations);
      const priorUrls = collectResearchedUrls(runState.iterations.slice(0, -1));
      const dupUrls = findDuplicateResearchInIteration(iterationResults, priorUrls);

      // Warn about duplicate research
      if (dupUrls.length > 0) {
        const dedupWarning = `DUPLICATE RESEARCH DETECTED: You already researched these — do NOT repeat: ${dupUrls.slice(0, 5).join(', ')}. Use the data you already have.`;
        runState.nextFocus = runState.nextFocus
          ? `${runState.nextFocus}\n${dedupWarning}`
          : dedupWarning;
      }

      const buildIntentObjective = objectiveLooksLikeBuildRequest(objective);

      // Force build pivot after 1+ consecutive research-only iterations
      if (consecutiveResearchIters >= 1 && !(objectivePolicy && objectivePolicy.researchOnly) && buildIntentObjective) {
        runState.nextFocus = [
          `RESEARCH LOOP: You have spent ${consecutiveResearchIters} iteration(s) doing ONLY research with ZERO files created.`,
          'STOP RESEARCHING. START BUILDING NOW.',
          'Your VERY FIRST action MUST be write_file to create a real source file.',
          'Use what you have learned so far. An imperfect implementation is infinitely better than more research.',
          consecutiveResearchIters >= 2
            ? 'FINAL WARNING: One more research-only iteration and the run will be stopped.'
            : 'Next iteration MUST produce code files or the run will be stopped.',
        ].join('\n');
        if (typeof onProgress === 'function') {
          onProgress({
            type: 'research_loop_warning',
            owner: 'chief',
            summary: `Research loop detected (${consecutiveResearchIters} iterations). Forcing build pivot.`,
          });
        }
      }

      // Hard stop after 3+ consecutive research-only iterations — complete waste.
      // Exception 1: if the evaluator has not rejected completion (consecutivePlannerDoneRejections === 0
      // after real work was done), the agent is in a natural winding-down phase, not a stuck loop.
      // Exception 2: local (Ollama) runs — they're free; allow up to 10 research iterations before bailing.
      const hasCompletedRealWork = runState.results.some((r) => r.ok && BUILD_TOOLS.has(String(r.tool || '')));
      const evaluatorHappyWithDone = consecutivePlannerDoneRejections === 0 && hasCompletedRealWork;
      const researchHardStopThreshold = isLocalRun
        ? (buildIntentObjective ? 2 : 10)
        : (buildIntentObjective ? 2 : 3);
      if (consecutiveResearchIters >= researchHardStopThreshold && !(objectivePolicy && objectivePolicy.researchOnly) && !evaluatorHappyWithDone && buildIntentObjective) {
        const recovered = await escalateRecoveryMode({
          iteration,
          gate: 'research_loop',
          reason: `Research-only loop detected (${consecutiveResearchIters} consecutive iterations).`,
          nextFocus: [
            `RESEARCH LOOP ESCALATION: ${consecutiveResearchIters} consecutive research-only iterations.`,
            'Next iteration MUST include at least one concrete build action (write_file/patch_file/run_command/run_playwright).',
            'Prefer implementing a minimal working version over more research.',
          ].join('\n'),
        });
        if (recovered) {
          continue;
        }
        doneReason = `Stopped after ${consecutiveResearchIters} consecutive research-only iterations with no files created. The agent failed to transition from research to building.`;
        break;
      }

      runState = await persistRunState(runState);

      const browserControllerProposalPath = await maybePersistBrowserControllerProposal({
        workspaceRoot,
        objective,
        threadContext: effectiveThreadContext,
        priorResults: runState.results,
      });
      if (browserControllerProposalPath) {
        runState.discoveryHints = Array.from(new Set([...(runState.discoveryHints || []), browserControllerProposalPath])).slice(-40);
        runState = await persistRunState(runState);
      }

      // Persist cost accumulator periodically so resumed runs see prior spend
      try { await persistRunCost(runState.runId); } catch { /* non-fatal */ }

      // Cost-control safeguard: repeated localhost Playwright connectivity errors
      // indicate environment/server setup is broken, not progress. Stop early.
      const recentLocalPlaywrightFailures = countRecentPlaywrightLocalConnectivityFailures(runState.iterations, 4);
      if (recentLocalPlaywrightFailures >= 3) {
        const localhostRecoveryFocus = [
          'Local preview server could not be reached repeatedly.',
          'Try a different preview strategy now:',
          '1) Detect the project start command from package scripts and run it.',
          '2) If no app server exists, start python3 -m http.server from the output folder.',
          '3) Verify with run_command curl against localhost before run_playwright.',
          '4) If localhost still fails, run artifact-level validation instead of browser QA for this iteration.',
        ].join('\n');
        doneReason = `Stopped early after ${recentLocalPlaywrightFailures} repeated local browser connectivity failures (localhost unavailable). Geepus attempted self-healing and avoided further costly retries.`;
        runState.nextFocus = localhostRecoveryFocus;
        const recovered = await escalateRecoveryMode({
          iteration,
          gate: 'localhost_connectivity',
          reason: `${recentLocalPlaywrightFailures} repeated localhost connectivity failures.`,
          nextFocus: localhostRecoveryFocus,
        });
        if (recovered) {
          continue;
        }
        runState.nextFocus = [
          'Local preview server could not be reached repeatedly.',
          'Fix server/workspace path, then click Resume Last.',
          'Tip: verify the page loads in your browser before QA retries.',
        ].join('\n');
        runState.reason = doneReason;
        runState = await persistRunState(runState);
        broadcastWatchEvent(runState.runId, {
          type: 'cost_guard_stop',
          iteration,
          summary: doneReason,
        }, { state: 'stopped', model, workspaceRoot });
        break;
      }

      if (runState.consecutiveDriftIterations >= runState.consecutiveDriftLimit) {
        const recoveredByBuildOutput = hasSuccessfulBuildOutput(iterationResults);
        if (recoveredByBuildOutput) {
          runState.consecutiveDriftIterations = 0;
          runState.reason = 'Recovered from drift: latest iteration produced concrete build output.';
          runState = await persistRunState(runState);
          broadcastWatchEvent(runState.runId, {
            type: 'drift_recovered',
            iteration,
            summary: 'Drift counter reset after successful build output.',
          }, { state: 'running', model, workspaceRoot });
        } else {
          const recovered = await escalateRecoveryMode({
            iteration,
            gate: 'off_track',
            reason: `${runState.consecutiveDriftIterations} off-track iteration(s) reached the drift limit.`,
            nextFocus: [
              `OFF-TRACK ESCALATION: ${runState.consecutiveDriftIterations} consecutive drifted iterations.`,
              'Use the last failed iteration details and execute a narrow, objective-aligned fix.',
              'Do not start unrelated work. Do not repeat banned fingerprints.',
            ].join('\n'),
          });
          if (recovered) {
            runState.consecutiveDriftIterations = 0;
            continue;
          }
          doneReason = `Stopped after ${runState.consecutiveDriftIterations} off-track iteration(s). Consider restarting with a clearer objective.`;
          break;
        }
      }

      if (execution.state !== 'completed') {
        consecutiveFailedIterations += 1;
        const failed = iterationResults.find((item) => item.ok === false);
        const failedText = failed
          ? `${failed.tool} - ${failed.intent}. ${truncate(failed.output || failed.summary || '', 280)}`
          : 'Unknown execution failure.';

        // Detect repeated failure patterns across all iterations
        const repeatedFailures = detectRepeatedFailures(runState.iterations);

        // Hard stop: if ANY single failure signature has hit the ban threshold,
        // the agent is hopelessly stuck — stop the run entirely.
        // Local (Ollama) runs are exempt — the model may recover on its own; let it keep trying.
        const banned = repeatedFailures.filter((f) => f.count >= FAILURE_BAN_THRESHOLD);
        if (banned.length > 0 && !isLocalRun) {
          const worst = banned[0];
          const recovered = await escalateRecoveryMode({
            iteration,
            gate: 'banned_failure_pattern',
            reason: `"${worst.tool}" failed ${worst.count} times with the same error.`,
            nextFocus: [
              `BANNED FAILURE ESCALATION: ${worst.tool} failed ${worst.count}x with the same error.`,
              `Error signature: ${truncate(worst.error, 220)}`,
              'Choose an alternative tool chain and different concrete targets (paths/ports/commands).',
            ].join('\n'),
          });
          if (recovered) {
            consecutiveFailedIterations = 0;
            continue;
          }
          doneReason = `Stopped: "${worst.tool}" failed ${worst.count} times with the same error. The agent could not recover. Error: ${truncate(worst.error, 200)}`;
          break;
        }

        const pivotFocus = buildResearchPivotFocus(failed, repeatedFailures, objective);

        if (pivotFocus) {
          // Repeated failure → force a research pivot instead of blind retry
          runState.nextFocus = pivotFocus;
          runState.reason = `Iteration ${iteration} failed with recurring error; pivoting to research alternative approaches.`;

          broadcastWatchEvent(runState.runId, {
            type: 'research_pivot',
            iteration,
            summary: `Repeated failure detected (${failed?.tool}). Researching alternative approaches.`,
          }, {
            objective,
            state: 'running',
            provider: runState.provider,
            model,
            workspaceRoot,
            teamMode: runState.teamMode,
            executionMode: runState.executionMode,
          });
        } else {
          runState.nextFocus = `Recover from previous execution failure: ${failedText}`;
          runState.reason = `Iteration ${iteration} failed; retrying with recovery plan.`;
        }

        broadcastWatchEvent(runState.runId, {
          type: 'failure_recovery',
          iteration,
          summary: `Iteration ${iteration} failed (${consecutiveFailedIterations} consecutive). ${truncate(failedText, 120)}`,
          detail: repeatedFailures.length > 0
            ? `Recurring failures: ${repeatedFailures.map((f) => `${f.tool} (${f.count}x)`).join(', ')}`
            : '',
        }, { state: 'running', model, workspaceRoot });

        runState = await persistRunState(runState);

        // Local (Ollama) runs tolerate more consecutive failures — the model may be slow to warm up
        // or temporarily confused but can self-correct without intervention.
        const consecutiveFailedLimit = isLocalRun ? 12 : 4;
        if (consecutiveFailedIterations >= consecutiveFailedLimit) {
          const recovered = await escalateRecoveryMode({
            iteration,
            gate: 'consecutive_failures',
            reason: `${consecutiveFailedIterations} consecutive failed iterations.`,
            nextFocus: [
              `CONSECUTIVE FAILURE ESCALATION: ${consecutiveFailedIterations} failed iterations in a row.`,
              'Break objective into smaller executable slices and complete one slice end-to-end now.',
              'Avoid repeating the previous failing strategy.',
            ].join('\n'),
          });
          if (recovered) {
            consecutiveFailedIterations = 0;
            continue;
          }
          doneReason = `Stopped after ${consecutiveFailedIterations} consecutive failed iterations. The objective may need to be broken into smaller tasks.`;
          break;
        }
        continue;
      }

      // If we just recovered from failures, save the lesson to project memory
      if (consecutiveFailedIterations > 0) {
        try {
          const priorFailed = runState.iterations
            .slice(-consecutiveFailedIterations - 1, -1)
            .flatMap((iter) => (iter.results || []).filter((r) => !r.ok))
            .slice(0, 3);
          const whatWorked = iterationResults
            .filter((r) => r.ok)
            .map((r) => `${r.tool}: ${r.intent}`)
            .join('; ');
          if (priorFailed.length > 0 && whatWorked) {
            const lesson = `LEARNED: When "${priorFailed[0]?.tool}" fails with "${truncate(priorFailed[0]?.output || '', 80)}", use instead: ${truncate(whatWorked, 200)}`;
            const existingMemory = await readProjectMemory(workspaceRoot);
            const updatedNotes = [...(existingMemory.notes || []), lesson]
              .filter((item, index, array) => array.indexOf(item) === index)
              .slice(-60);
            await writeProjectMemory(workspaceRoot, {
              ...existingMemory,
              notes: updatedNotes,
            });
          }
        } catch { /* non-fatal — don't break the run for memory save failure */ }
      }

      consecutiveFailedIterations = 0;

      // -----------------------------------------------------------------------
      // Total failure ratio check — even if iterations "complete" (some actions
      // succeed), an excessive failure count means the agent is thrashing.
      // Exclude denied actions (normalization failures) and 'think' (no-ops) from
      // the ratio — only count REAL execution successes/failures.
      // Local (Ollama) runs: much higher tolerance — the model produces more
      // normalization artifacts and needs more iterations to make progress.
      // -----------------------------------------------------------------------
      if (iteration >= 3 && !isLocalRun) {
        const allResults = runState.iterations.flatMap((iter) => iter.results || []);
        // Don't count denied actions or think/planning failure artifacts
        const realResults = allResults.filter((r) => !r.metadata?.denied && r.tool !== 'think');
        const totalFails = realResults.filter((r) => !r.ok).length;
        const totalOks = realResults.filter((r) => r.ok).length;
        if (totalFails > 0 && totalFails > 2 * Math.max(totalOks, 1)) {
          const recovered = await escalateRecoveryMode({
            iteration,
            gate: 'failure_ratio',
            reason: `Failure ratio too high (${totalFails} failures vs ${totalOks} successes).`,
            nextFocus: [
              `FAILURE-RATIO ESCALATION: ${totalFails} failures vs ${totalOks} successes.`,
              'Select one high-confidence path and execute minimal viable completion steps.',
              'Reduce action count and verify after each concrete change.',
            ].join('\n'),
          });
          if (recovered) {
            continue;
          }
          doneReason = `Stopped: excessive failure ratio (${totalFails} failures vs ${totalOks} successes across ${iteration} iterations). The approach needs rethinking.`;
          break;
        }
      }

      const iterationSummaryText = iterationResults
        .map((result) => `${result.ok ? 'OK' : 'FAILED'} ${result.tool}: ${result.intent}\n${truncate(result.output || '', 500)}`)
        .join('\n\n');

      // Always refresh readiness so the UI can show whether this run is truly
      // complete-ready or still missing critical evidence.
      try {
        runState.readiness = await computeRunReadiness({
          objective,
          threadContext: effectiveThreadContext,
          executionMode: runState.executionMode,
          objectivePolicy,
          workspaceRoot,
          results: runState.results,
        });
      } catch {
        runState.readiness = null;
      }

      // -----------------------------------------------------------------------
      // Completion check optimization: when the planner explicitly says done=false
      // we skip the separate evaluateObjectiveProgress LLM call (saves ~$0.02-0.10
      // per iteration). Only run the full progress evaluation when the planner
      // signals done=true, or on the last few iterations as a safety net.
      // -----------------------------------------------------------------------
      // Broadcast iteration results summary
      {
        const okCount = iterationResults.filter((r) => r.ok).length;
        const failCount = iterationResults.filter((r) => !r.ok).length;
        const totalDone = runState.results.filter((r) => r.ok).length;
        const totalFailed = runState.results.filter((r) => !r.ok).length;
        const latestBrowserResult = [...iterationResults].reverse().find((r) => extractBrowserStateFromMetadata(r.metadata));
        broadcastWatchEvent(runState.runId, {
          type: 'iteration_summary',
          iteration,
          summary: `Iteration ${iteration}: ${okCount} ok, ${failCount} failed (total: ${totalDone} ok, ${totalFailed} failed)`,
          detail: iterationResults.map((r) => `${r.ok ? '✓' : '✗'} ${r.tool}: ${truncate(r.intent || '', 60)}`).join('\n'),
          browserState: latestBrowserResult ? extractBrowserStateFromMetadata(latestBrowserResult.metadata) : null,
        }, { state: 'running', model, workspaceRoot });
      }

      const nearEnd = (runState.maxIterations - iteration) <= 2;
      const isThrashing = detectActionThrashing(runState.iterations);
      const passiveBrowserLoop = detectPassiveBrowserObservationLoop(runState.iterations);
      if (passiveBrowserLoop) {
        const frameHint = passiveBrowserLoop.frames.length > 1
          ? `Frames remained unchanged: ${passiveBrowserLoop.frames.slice(0, 4).join(' | ')}`
          : '';
        runState.nextFocus = [
          'PASSIVE BROWSER LOOP DETECTED.',
          `You have re-observed the same browser state repeatedly at ${passiveBrowserLoop.pageUrl}.`,
          'Do not spend the next iteration on another wait_for, aria_snapshot, read, or frames action unless a concrete click/fill/goto just happened.',
          'Act like a human operator: choose one concrete next move now.',
          'Preferred order: target the relevant frame -> fill visible credentials or fields -> click the primary action -> if the page is wrong, navigate back to the task page.',
          frameHint,
        ].filter(Boolean).join('\n');
      }

      if (!plan.plannerDone && !nearEnd && !isThrashing) {
        // Planner says it's not done — trust it and continue without an extra LLM call
        // IMPORTANT: preserve nextFocus if it was set by research loop detection or other warnings
        if (!runState.nextFocus) {
          runState.reason = `Iteration ${iteration} completed; planner indicates more work needed.`;
        }
        broadcastWatchEvent(runState.runId, {
          type: 'progress_skip',
          iteration,
          summary: `Planner says not done — continuing to iteration ${iteration + 1}`,
          detail: runState.nextFocus ? `Next focus: ${truncate(runState.nextFocus, 150)}` : '',
        }, { state: 'running', model, workspaceRoot });
        runState = await persistRunState(runState);
        continue;
      }

      broadcastWatchEvent(runState.runId, {
        type: 'progress_check',
        iteration,
        summary: isThrashing ? 'Identical action loop detected — forcing evaluation...' : (plan.plannerDone ? 'Planner says done — evaluating completion...' : 'Near iteration limit — evaluating progress...'),
      }, { state: 'running', model, workspaceRoot });

      let progress;
      try {
        progress = await evaluateObjectiveProgress({
          settings: executionSettings,
          model,
          objective,
          workspaceRoot,
          iterationSummary: iterationSummaryText,
          priorProgressSummary: summarizeRunHistory(runState.iterations.slice(0, -1), 4),
          threadContext: effectiveThreadContext,
          latestResults: iterationResults,
          remainingIterations: runState.maxIterations - iteration,
          callGuards,
          repeatedFailures: detectRepeatedFailures(runState.iterations),
          activeSkillContent: runState.activeSkillContent || '',
        });
      } catch (evalError) {
        if (evalError instanceof BudgetLimitError) {
          runState.state = 'needs_info';
          runState.pendingQuestions = [
            `Budget limit reached (${evalError.message}). Do you want to switch to a free local model to continue? (Reply "yes" to switch to local, or "no" to stop)`
          ];
          runState.reason = 'Budget limit reached.';
          runState = await persistRunState(runState);
          broadcastWatchEvent(runState.runId, {
            type: 'user_input_required',
            summary: 'Budget limit reached.',
            detail: runState.pendingQuestions[0],
          });
          break;
        }
        throw evalError;
      }

      model = progress.model || model;
      runState.model = model;
      runState.nextFocus = progress.next_focus;

      if (!progress.done) {
        // Record evaluator rejection so the planner sees it in the next reflectionBlock
        consecutivePlannerDoneRejections += 1;
        runState.lastEvaluatorRejection = (progress.reason || '') + (progress.next_focus ? `\nRequired action: ${progress.next_focus}` : '');
      } else {
        consecutivePlannerDoneRejections = 0;
        runState.lastEvaluatorRejection = '';
      }

      if (progress.needs_info) {
        runState.state = 'needs_info';
        runState.pendingQuestions = progress.questions;
        runState.reason = progress.reason || 'Waiting for user input.';
        runState = await persistRunState(runState);
        broadcastWatchEvent(runState.runId, {
          type: 'user_input_required',
          summary: 'Geepus needs more information to continue.',
          detail: (progress.questions || []).join(' | '),
        }, { state: 'needs_info', model, workspaceRoot });
        break;
      }

      if (!progress.done) {
        broadcastWatchEvent(runState.runId, {
          type: 'progress_not_done',
          iteration,
          summary: `Evaluator: not done — ${truncate(progress.next_focus, 120)}`,
          detail: progress.reason,
        }, { state: 'running', model, workspaceRoot });
      }

      // The evaluator LLM is authoritative — trust its judgment on what verification is
      // appropriate for the task type.  The only exception we enforce in harness code is
      // pure fabrication: if the agent produced zero real tool output (no writes, no
      // command runs, no browser checks) the evaluator can't legitimately say done.
      if (progress.done) {
        const latestIteration = runState.iterations[runState.iterations.length - 1] || {};
        const latestResults = Array.isArray(latestIteration.results) ? latestIteration.results : [];
        const blockingRecentFailures = latestResults.filter((entry) => (
          entry
          && entry.ok === false
          && !(entry.metadata && entry.metadata.denied)
          && String(entry.tool || '') !== 'think'
        ));
        if (blockingRecentFailures.length > 0) {
          const topFailure = blockingRecentFailures[0];
          runState.nextFocus = [
            'Completion blocked: the latest iteration still has unresolved failed actions.',
            `Fix this first: ${topFailure.tool} — ${truncate(topFailure.intent || topFailure.summary || '', 160)}`,
          ].join('\n');
          runState.reason = 'Latest iteration contains unresolved failures.';
          runState = await persistRunState(runState);
          broadcastWatchEvent(runState.runId, {
            type: 'readiness_blocked',
            iteration,
            summary: 'Not ready to finish: unresolved failures in the latest iteration.',
            detail: truncate(String(topFailure.output || topFailure.summary || ''), 180),
          }, { state: 'running', model, workspaceRoot });
          continue;
        }
        const taskClass = runState.taskClass || inferRunTaskClass({ objective, executionMode: runState.executionMode, objectivePolicy });
        let hasAnyRealOutput = false;
        if (taskClass === 'build') {
          hasAnyRealOutput = runState.results.some((r) =>
            r.ok && (
              r.tool === 'write_file' ||
              r.tool === 'patch_file' ||
              r.tool === 'run_command' ||
              r.tool === 'run_playwright' ||
              r.tool === 'browser_launch' ||
              r.tool === 'browser_action' ||
              r.tool === 'respond'
            )
          );
        } else if (taskClass === 'conversational' || taskClass === 'general') {
          // For conversational and general tasks, think + respond both count — the agent's
          // reasoning or direct reply IS the deliverable.
          hasAnyRealOutput = runState.results.some((r) => r.ok);
        } else {
          // lookup / research / operations: any successful non-think action counts
          hasAnyRealOutput = runState.results.some((r) => r.ok && (r.tool !== 'think' || r.tool === 'respond'));
        }

        if (!hasAnyRealOutput) {
          runState.nextFocus = taskClass === 'build'
            ? 'No real output was produced this run. Write files, run commands, or load the result in a browser to make real progress before completing.'
            : 'No real actions were completed this run. You must successfully execute at least one tool before completing.';
          runState = await persistRunState(runState);
          continue;
        }

        const readiness = runState.readiness || await computeRunReadiness({
          objective,
          threadContext: effectiveThreadContext,
          executionMode: runState.executionMode,
          objectivePolicy,
          workspaceRoot,
          results: runState.results,
        });
        runState.readiness = readiness;
        if (!readiness.ready) {
          runState.nextFocus = readiness.nextFocus || 'Finish missing readiness checks before completing.';
          runState.reason = `Completion blocked by readiness checks: ${readiness.summary}`;
          if (iteration >= runState.maxIterations) {
            const extended = await tryExtendIterationBudget({
              iteration,
              reason: `Readiness checks pending: ${readiness.summary}`,
            });
            if (!extended) {
              doneReason = `Max iteration budget reached before readiness checks passed: ${readiness.summary}`;
            }
          }
          runState = await persistRunState(runState);
          broadcastWatchEvent(runState.runId, {
            type: 'readiness_blocked',
            iteration,
            summary: `Not ready to finish: ${readiness.summary}`,
            detail: readiness.nextFocus || '',
          }, { state: 'running', model, workspaceRoot });
          continue;
        }
      }

      // --- User Acceptance Review (market-fit gate) ---
      // Only run if the technical evaluator says "done" and we haven't already passed acceptance.
      // Skip for lookup/general tasks that don't produce build artifacts.
      const _taskClass = runState.readiness?.taskClass || '';
      // Skip acceptance review for: lookup/general/operations tasks, AND simple tasks
      // that already passed Playwright verification (consoleErrorCount=0).
      const _hasPlaywrightPass = runState.results.some((r) =>
        r.ok && r.tool === 'run_playwright'
        && typeof r.output === 'string'
        && r.output.includes('consoleErrorCount')
        && /"consoleErrorCount"\s*:\s*0/.test(r.output)
      );
      const _skipAcceptance = _taskClass === 'lookup' || _taskClass === 'general' || _taskClass === 'operations'
        || (runState._isSimpleTask && _hasPlaywrightPass);
      if (progress.done && !runState.acceptancePassed && !_skipAcceptance) {
        const writtenFiles = collectWrittenFilePaths(runState.results);
        if (typeof onProgress === 'function') {
          onProgress({
            type: 'acceptance_review',
            owner: 'product',
            summary: 'Running user acceptance review...',
          });
        }
        let acceptance;
        try {
          acceptance = await evaluateUserAcceptance({
            settings: executionSettings,
            model,
            objective,
            workspaceRoot,
            iterationSummary: iterationSummaryText,
            writtenFiles,
            callGuards,
          });
        } catch (acceptErr) {
          if (acceptErr instanceof BudgetLimitError) {
            runState.state = 'needs_info';
            runState.pendingQuestions = [
              `Budget limit reached (${acceptErr.message}). Do you want to switch to a free local model to continue? (Reply "yes" to switch to local, or "no" to stop)`
            ];
            runState.reason = 'Budget limit reached.';
            runState = await persistRunState(runState);
            broadcastWatchEvent(runState.runId, {
              type: 'user_input_required',
              summary: 'Budget limit reached.',
              detail: runState.pendingQuestions[0],
            });
            break;
          }
          throw acceptErr;
        }
        model = acceptance.model || model;
        runState.model = model;
        runState.lastAcceptanceScore = acceptance.score;

        if (!acceptance.acceptable) {
          const issueList = acceptance.issues.length > 0
            ? acceptance.issues.map((i) => `- ${i}`).join('\n')
            : '- General quality below user expectations';
          runState.nextFocus = [
            `USER ACCEPTANCE FAILED (score: ${acceptance.score}/10). A real user reviewed your output and rejected it.`,
            `Verdict: ${acceptance.verdict}`,
            'Issues to fix:',
            issueList,
            '',
            'Fix ALL of these issues before the next evaluation. Focus on making the product polished, complete, and something a real user would actually want to use.',
          ].join('\n');
          if (iteration >= runState.maxIterations) {
            const extended = await tryExtendIterationBudget({
              iteration,
              reason: `User acceptance pending (${acceptance.score}/10).`,
            });
            if (!extended) {
              doneReason = `Max iteration budget reached before user acceptance passed (${acceptance.score}/10).`;
            }
          }
          runState = await persistRunState(runState);
          if (typeof onProgress === 'function') {
            onProgress({
              type: 'acceptance_failed',
              owner: 'product',
              summary: `User acceptance: ${acceptance.score}/10 — ${acceptance.verdict}`,
            });
          }
          continue;
        }

        // Passed acceptance — mark it so we don't re-run
        runState.acceptancePassed = true;
        if (typeof onProgress === 'function') {
          onProgress({
            type: 'acceptance_passed',
            owner: 'product',
            summary: `User acceptance: ${acceptance.score}/10 — ${acceptance.verdict}`,
          });
        }
      }

      if (progress.done) {
        broadcastWatchEvent(runState.runId, {
          type: 'progress_done',
          iteration,
          summary: `Evaluator + readiness checks passed — ${truncate(progress.reason, 120)}`,
          detail: progress.reason,
        }, { state: 'running', model, workspaceRoot });
        done = true;
        doneReason = progress.reason || `Objective completed in ${iteration} iteration(s).`;
        break;
      }
      if (iteration >= runState.maxIterations) {
        const extended = await tryExtendIterationBudget({
          iteration,
          reason: progress.reason || progress.next_focus || 'Evaluator reports the objective is not done yet.',
        });
        if (!extended) {
          doneReason = doneReason || 'Max iteration budget reached.';
          break;
        }
        continue;
      }
    }

    const finalState = done ? 'completed' : (runState.state === 'needs_info' ? 'needs_info' : 'stopped');
    runState.state = finalState;
    runState.reason = doneReason;
    runState.model = model;

    try {
      await persistCrossRunBannedApproaches({
        settings: executionSettings,
        runState,
        objective,
        objectivePolicy,
      });
    } catch {
      // Banned-approach persistence is best-effort only.
    }

    try {
      await persistGeneralLearningOutcome({
        settings: executionSettings,
        runState,
        objective,
        objectivePolicy,
        doneReason,
      });
    } catch {
      // General learning persistence is best-effort only.
    }

    if (runState.executionCore === 'nanobot' || runState.nativeRuntimeState) {
      try {
        await persistNativeLearningOutcome({
          settings: executionSettings,
          runState,
          objective,
          doneReason,
        });
      } catch {
        // Learning persistence is best-effort only.
      }
    }

    // Skill capture: on successful completion, synthesize a SKILL.md playbook
    // from what was learned so Geepus can apply the same approach to future
    // similar tasks. Fire-and-forget — never blocks completion.
    if (done) {
      const runSummaryForSkill = summarizeRunHistory(runState.iterations, 6);
      captureAndSaveSkill({
        settings: executionSettings,
        model,
        objective,
        runSummary: runSummaryForSkill,
        callGuards,
        workspaceRoot,
      }).catch(() => { });
    }

    const stoppedByUser = doneReason.toLowerCase().includes('stopped by user');
    const needsInfoFinal = finalState === 'needs_info';
    const stoppedNotComplete = finalState === 'stopped' && !stoppedByUser;
    const nativeRuntimeReport = String(runState.nativeRuntimeReport || '').trim();
    const report = needsInfoFinal
      ? {
        model,
        report: [
          '**Geepus needs a few answers before continuing:**',
          '',
          ...(runState.pendingQuestions || []).map((q, i) => `${i + 1}. ${q}`),
          '',
          'Type your answers in the input box and click **Resume Last** to continue.',
        ].join('\n'),
      }
      : stoppedByUser
        ? {
          model,
          report: `Stopped. Got through ${runState.iterations.length} round${runState.iterations.length === 1 ? '' : 's'} and ${runState.results.length} step${runState.results.length === 1 ? '' : 's'} before you pulled the plug.`,
        }
        : stoppedNotComplete
          ? (() => {
            const failed = runState.results.filter((result) => !result.ok);
            const succeeded = runState.results.filter((result) => result.ok);
            const latestFailures = failed.slice(-3).map((result) => {
              const tool = result.tool || 'step';
              const intent = truncate(result.intent || '', 120);
              const reason = truncate(String(result.output || '').replace(/\s+/g, ' ').trim(), 180);
              return `- ${tool}: ${intent || 'No intent recorded'}${reason ? `\n  Reason: ${reason}` : ''}`;
            });
            return {
              model,
              report: [
                '**Status: Needs attention**',
                '',
                'The run stopped before the objective was completed.',
                `Reason: ${doneReason || 'Run stopped before completion.'}`,
                '',
                `Progress: ${succeeded.length} completed • ${failed.length} failed • ${runState.results.length} total actions across ${runState.iterations.length} iteration(s).`,
                '',
                ...(latestFailures.length > 0
                  ? ['Most recent issues:', ...latestFailures, '']
                  : []),
                'Next step: click **Resume Last** to continue from this exact run context.',
              ].join('\n'),
            };
          })() :
          nativeRuntimeReport
            ? await (async () => {
              // Detect lookup/general/operations tasks and synthesize a concise answer
              // instead of dumping raw scrape/search output at the user.
              const _tc = (runState.readiness?.taskClass
                || inferRunTaskClass({ objective, executionMode: runState.executionMode })
                || '');
              const _isLookup = _tc === 'lookup' || _tc === 'general' || _tc === 'operations';
              if (_isLookup) {
                try {
                  return await summarizeExecution({
                    settings: executionSettings,
                    model,
                    task: objective,
                    workspaceRoot,
                    plan: { summary: `Autonomous run (${runState.iterations.length} iteration(s))` },
                    results: runState.results,
                    finalState,
                    callGuards,
                    taskClass: _tc,
                  });
                } catch (sumErr) {
                  // Budget or transient error during summary — don't crash the completed run
                  return { model, report: nativeRuntimeReport };
                }
              }
              return { model, report: nativeRuntimeReport };
            })()
            : await (async () => {
              try {
                return await summarizeExecution({
                  settings: executionSettings,
                  model,
                  task: objective,
                  workspaceRoot,
                  plan: { summary: `Autonomous run (${runState.iterations.length} iteration(s))` },
                  results: runState.results,
                  finalState,
                  callGuards,
                  taskClass: runState.readiness?.taskClass || '',
                });
              } catch (sumErr) {
                // Budget or transient error during summary — don't crash the completed run
                const okCount = runState.results.filter((r) => r.ok).length;
                const failCount = runState.results.filter((r) => !r.ok).length;
                return {
                  model,
                  report: `Run ${finalState} in ${runState.iterations.length} iteration(s). ${okCount} actions succeeded, ${failCount} failed. (Summary generation skipped due to budget limit.)`,
                };
              }
            })();

    runState.model = report.model || model;
    runState.report = report.report;

    // Auto-open the main HTML file in the user's browser so they can see the
    // result immediately without copying commands from the report.
    if (finalState === 'completed' && report.openFile) {
      try {
        const filePath = String(report.openFile);
        if (fs.existsSync(filePath)) {
          const fileUrl = require('url').pathToFileURL(filePath).href;
          shell.openExternal(fileUrl);
        }
      } catch { /* non-fatal — user can still open manually per the report */ }
    }

    const existingMemory = await readProjectMemory(workspaceRoot);
    const globalMemory = await readGlobalMemory();
    const discoveredArtifacts = (runState.discoveryHints || []).map((item) => {
      const raw = String(item || '').trim();
      if (!raw) {
        return '';
      }
      const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspaceRoot, raw);
      if (absolute === workspaceRoot || absolute.startsWith(`${workspaceRoot}${path.sep}`)) {
        return path.relative(workspaceRoot, absolute) || '.';
      }
      return absolute;
    }).filter(Boolean);
    const runArtifacts = [...collectArtifactsFromResults(runState.results), ...discoveredArtifacts];
    const newObjectives = [objective, ...existingMemory.recentObjectives]
      .map((item) => String(item).trim())
      .filter(Boolean)
      .filter((item, index, array) => array.indexOf(item) === index)
      .slice(0, 20);

    let consolidatedNotes;
    // Always run LLM consolidation, even on failed/stopped runs, to extract "LEARNED:" notes
    try {
      consolidatedNotes = await consolidateMemoryWithLLM({
        settings: executionSettings,
        model,
        objective,
        results: runState.results,
        existingNotes: existingMemory.notes || [],
        callGuards,
      });
    } catch {
      consolidatedNotes = pickPersistentNotesFromResults(runState.results, 8);
    }

    const learnedLessons = consolidatedNotes.filter(n => n.startsWith('LEARNED:'));
    const projectSpecificNotes = consolidatedNotes.filter(n => !n.startsWith('LEARNED:'));

    const newNotes = [
      doneReason,
      runState.nextFocus,
      ...projectSpecificNotes,
      ...learnedLessons,
    ]
      .map((item) => String(item).trim())
      .filter(Boolean);
    const mergedNotes = [...existingMemory.notes, ...newNotes]
      .filter((item, index, array) => array.indexOf(item) === index)
      .slice(-60);
    const mergedArtifacts = [...existingMemory.artifactPaths, ...runArtifacts]
      .map((item) => String(item).trim())
      .filter(Boolean)
      .filter((item, index, array) => array.indexOf(item) === index)
      .slice(-160);
    await writeProjectMemory(workspaceRoot, {
      recentObjectives: newObjectives,
      notes: mergedNotes,
      artifactPaths: mergedArtifacts,
    });

    // RAG: index project memory and run summary into vector store
    try {
      await indexProjectMemory(workspaceRoot, {
        notes: mergedNotes,
        recentObjectives: newObjectives,
      }, executionSettings);
      await indexRunSummary(runState, executionSettings);
    } catch {
      // RAG indexing failure is non-fatal
    }

    const nextProjects = [...globalMemory.projects];
    const existingProjectIndex = nextProjects.findIndex((item) => item.workspaceRoot === workspaceRoot);
    const projectEntry = {
      workspaceRoot,
      label: inferProjectLabel(workspaceRoot, objective),
      lastObjective: objective,
      lastStatus: finalState,
      artifactPaths: mergedArtifacts,
      updatedAt: new Date().toISOString(),
    };
    if (existingProjectIndex >= 0) {
      nextProjects[existingProjectIndex] = projectEntry;
    } else {
      nextProjects.push(projectEntry);
    }

    const globalNotes = [
      ...globalMemory.userNotes,
      `${new Date().toISOString()} | ${workspaceRoot} | ${finalState} | ${truncate(objective, 180)}`,
      doneReason,
      ...learnedLessons, // Promote general learned lessons to global memory
    ].slice(-80);

    await writeGlobalMemory({
      ...globalMemory,
      activeWorkspaceRoot: workspaceRoot,
      projects: nextProjects.slice(-20),
      userNotes: globalNotes,
    });

    // RAG: index global memory
    try {
      await indexGlobalMemory({
        userNotes: globalNotes,
      }, executionSettings);
    } catch {
      // Non-fatal
    }

    runState = await persistRunState(runState);

    await appendAuditEvent({
      type: 'objective_run_finished',
      run_id: runState.runId,
      model: runState.model,
      provider: runState.provider,
      team_mode: runState.teamMode,
      execution_mode: runState.executionMode,
      execution_core: runState.executionCore,
      workspace_root: workspaceRoot,
      state: finalState,
      reason: truncate(doneReason, 500),
      iterations: runState.iterations.length,
      total_actions: runState.results.length,
    });
    await appendRunDebugEvent(runState.runId, 'run_finished', {
      state: finalState,
      reason: doneReason,
      iterations: runState.iterations.length,
      totalActions: runState.results.length,
      workspaceRoot,
      readiness: runState.readiness || null,
    }).catch(() => {});

    broadcastWatchEvent(runState.runId, {
      type: 'run_finished',
      summary: doneReason,
      report: runState.report || '',
    }, {
      objective,
      state: finalState,
      provider: runState.provider,
      model: runState.model,
      workspaceRoot,
      teamMode: runState.teamMode,
      executionMode: runState.executionMode,
      executionCore: runState.executionCore,
    });

    // Bring the main chat window to the front so the user sees the report
    // without needing to manually close or switch away from the Watch window.
    if (finalState === 'completed') focusMainWindow();

    // Finalize token cost tracking
    let costData = null;
    try {
      costData = await finalizeRunCost(runState.runId);
    } catch { /* non-fatal */ }

    return {
      requiresApproval: false,
      runId: runState.runId,
      state: finalState,
      reason: doneReason,
      model: runState.model,
      provider: runState.provider,
      teamMode: runState.teamMode,
      executionMode: runState.executionMode,
      executionCore: runState.executionCore,
      runLimits: runState.runLimits,
      workspaceDiscoverySource: runState.workspaceDiscoverySource,
      workspaceRoot,
      objective,
      iterations: runState.iterations,
      results: runState.results,
      report: runState.report,
      readiness: runState.readiness || null,
      workflow: buildWorkflowView(runState),
      cost: costData,
    };
  } catch (error) {
    const runId = String(runState?.runId || activeRunId || '').trim();
    const objective = String(runState?.objective || request?.task || '').trim();
    const workspaceRoot = String(
      runState?.workspaceRoot
      || request?.workspaceRoot
      || settings?.workspaceRoot
      || DEFAULT_WORKSPACE_ROOT,
    ).trim() || DEFAULT_WORKSPACE_ROOT;
    const failureText = String(error?.message || error || 'unknown error').trim() || 'unknown error';
    const isStop = error instanceof StopRequestedError;
    const stopReason = runId ? (getRunStopReason(runId) || 'Stopped by user request.') : 'Stopped by user request.';
    const reason = isStop
      ? stopReason
      : `Run failed before completion: ${truncate(failureText, 500)}`;

    if (runState && runId) {
      try {
        runState.state = 'stopped';
        runState.reason = reason;
        runState.report = [
          '**Status: Needs attention**',
          '',
          'The run stopped before the objective was completed.',
          `Reason: ${reason}`,
          '',
          `Progress: ${Array.isArray(runState.results) ? runState.results.filter((entry) => entry && entry.ok).length : 0} completed • ${Array.isArray(runState.results) ? runState.results.filter((entry) => entry && !entry.ok).length : 0} failed • ${Array.isArray(runState.results) ? runState.results.length : 0} total actions across ${Array.isArray(runState.iterations) ? runState.iterations.length : 0} iteration(s).`,
          '',
          isStop
            ? 'Next step: click **Resume Last** to continue from this exact run context.'
            : 'Next step: click **Resume Last** to continue, now with the recorded failure reason above.',
        ].join('\n');
        runState = await persistRunState(runState);
      } catch {
        // If state persistence fails, still emit audit/throw original error.
      }

      try {
        await appendAuditEvent({
          type: isStop ? 'objective_run_stopped_exception' : 'objective_run_failed',
          run_id: runId,
          model: runState.model || '',
          provider: runState.provider || normalizeProvider(settings.provider),
          team_mode: runState.teamMode || '',
          execution_mode: runState.executionMode || '',
          execution_core: runState.executionCore || '',
          workspace_root: workspaceRoot,
          state: 'stopped',
          reason: truncate(reason, 500),
          error: isStop ? '' : truncate(failureText, 900),
          iterations: Array.isArray(runState.iterations) ? runState.iterations.length : 0,
          total_actions: Array.isArray(runState.results) ? runState.results.length : 0,
        });
      } catch {
        // Non-fatal.
      }

      await appendRunDebugEvent(runId, isStop ? 'run_stopped_exception' : 'run_failed', {
        state: 'stopped',
        reason,
        error: isStop ? '' : failureText,
        iterations: Array.isArray(runState.iterations) ? runState.iterations.length : 0,
        totalActions: Array.isArray(runState.results) ? runState.results.length : 0,
        workspaceRoot,
      }).catch(() => {});

      try {
        broadcastWatchEvent(runId, {
          type: 'run_failed',
          summary: reason,
          detail: isStop ? '' : truncate(failureText, 1200),
          report: runState.report || '',
        }, {
          objective,
          state: 'stopped',
          provider: runState.provider || normalizeProvider(settings.provider),
          model: runState.model || '',
          workspaceRoot,
          teamMode: runState.teamMode || '',
          executionMode: runState.executionMode || '',
          executionCore: runState.executionCore || '',
        });
      } catch {
        // Non-fatal.
      }
    }
    throw error;
  } finally {
    if (activeRunId) {
      activeRunIds.delete(activeRunId);
      activeChildrenByRun.delete(activeRunId);
      clearRunStopRequest(activeRunId);
      clearRunCache(activeRunId);
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildAgentPlannerPrompt,
  fallbackActionForObjectivePolicy,
  applyObjectivePolicyToActions,
  hasVerificationAction,
  hasWriteAction,
  recommendQualityCommands,
  injectQualityActionIfNeeded,
  createAgentPlan,
  summarizeExecution,
  summarizeRunHistory,
  pickPersistentNotesFromResults,
  collectWrittenFilePaths,
  hasSuccessfulReviewEvidence,
  objectiveNeedsPlaywright,
  isIterationDrifted,
  isResearchOnlyIteration,
  countConsecutiveResearchIterations,
  collectResearchedUrls,
  findDuplicateResearchInIteration,
  extractFailureSignature,
  detectRepeatedFailures,
  computeBannedApproaches,
  buildBannedApproachesWarning,
  isActionBanned,
  buildResearchPivotFocus,
  buildInteractiveBrowserPlan,
  classifyBrowserScreen,
  detectPassiveBrowserObservationLoop,
  isPassiveOnlyBrowserPlan,
  buildForcedActiveBrowserRecoveryFromState,
  enforceActiveRecoveryForPassiveLoop,
  captureAndSaveSkill,
  evaluateObjectiveProgress,
  evaluateUserAcceptance,
  executePlannedActions,
  runObjectiveCore,
};
