'use strict';

const path = require('path');
const fs = require('fs/promises');

const RESEARCH_KEYWORDS = [
  'research', 'analyze', 'analysis', 'market', 'reddit', 'trend', 'findings', 'report',
  'compare', 'survey', 'investigate', 'discovery',
];
const BUILD_KEYWORDS = [
  'build', 'create', 'make', 'implement', 'develop', 'code', 'app', 'website', 'tool',
  'feature', 'fix', 'refactor', 'web game', 'plugin',
];
const OPERATIONS_KEYWORDS = [
  'email', 'calendar', 'schedule', 'message', 'inbox', 'reply', 'send', 'notify',
  'crm', 'lead', 'sales', 'invoice', 'customer',
];

const DOC_EXTS = new Set(['.md', '.txt', '.csv', '.json', '.yaml', '.yml', '.pdf', '.docx']);
const REAL_WORK_TOOLS = new Set([
  'write_file', 'append_file', 'patch_file', 'run_command', 'run_playwright', 'analyze_image',
  'web_search', 'web_scrape', 'http_request',
  'github_create_issue', 'github_create_pr', 'github_add_comment', 'github_reply_review',
  'notify_webhook', 'send_email',
]);
const RESEARCH_TOOLS = new Set([
  'web_search', 'web_scrape', 'run_playwright', 'http_request', 'read_file', 'list_files', 'search_files', 'analyze_image',
]);

const MEDIA_NOUNS = ['image', 'images', 'photo', 'photos', 'picture', 'pictures', 'wallpaper', 'gallery'];
const MEDIA_FETCH_HINTS = ['find', 'search', 'get', 'download', 'fetch', 'collect', 'source', 'pick'];
const MEDIA_TOPIC_STOPWORDS = new Set([
  'find', 'search', 'get', 'download', 'fetch', 'collect', 'source', 'pick',
  'image', 'images', 'photo', 'photos', 'picture', 'pictures', 'wallpaper', 'gallery',
  'for', 'with', 'from', 'into', 'that', 'this', 'these', 'those', 'your', 'my', 'our',
  'and', 'the', 'a', 'an', 'some', 'few', 'best', 'good', 'nice', 'high', 'quality',
  'please', 'need', 'want', 'me', 'to', 'of', 'in', 'on', 'at', 'by', 'is', 'are',
]);

function lowerText(value) {
  return String(value || '').toLowerCase();
}

function hasAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function inferMediaSelectionMeta(objective = '', threadContext = '') {
  const text = lowerText(`${objective}\n${threadContext}`);
  const hasMedia = MEDIA_NOUNS.some((word) => text.includes(word));
  const hasFetchIntent = MEDIA_FETCH_HINTS.some((word) => text.includes(word));
  const hasRelevanceIntent = /\b(relevant|relevance|align|match|theme|topical|appropriate|fits)\b/i.test(text);
  const descriptorMatches = Array.from(text.matchAll(/([a-z0-9][a-z0-9\s-]{0,40})\s+(?:images?|photos?|pictures?|wallpapers?)/gi))
    .map((match) => String(match[1] || '').trim())
    .filter(Boolean);
  const descriptorKeywords = descriptorMatches
    .flatMap((segment) => segment.split(/[^a-z0-9]+/g))
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .filter((token) => !MEDIA_TOPIC_STOPWORDS.has(token));
  if (!hasMedia || (!hasFetchIntent && !hasRelevanceIntent && descriptorKeywords.length === 0)) {
    return { isMediaSelection: false, requestedCount: 0, topicKeywords: [] };
  }
  const countMatch = text.match(/\b(\d{1,2})\s+(?:images?|photos?|pictures?)\b/);
  const requestedCount = countMatch ? Math.max(0, Math.min(20, Number(countMatch[1]) || 0)) : 0;
  const topicKeywords = [...descriptorKeywords, ...text
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .filter((token) => !MEDIA_TOPIC_STOPWORDS.has(token))
  ]
    .filter((token, index, array) => array.indexOf(token) === index)
    .slice(0, 10);
  return { isMediaSelection: true, requestedCount, topicKeywords };
}

function mediaAnalysisMatchesTopic(outputText, intentText, keywords) {
  const haystack = `${lowerText(outputText)} ${lowerText(intentText)}`;
  if (keywords.length === 0) {
    return haystack.length > 0;
  }
  return keywords.some((keyword) => {
    if (haystack.includes(keyword)) return true;
    if (keyword.length >= 5 && haystack.includes(keyword.slice(0, 5))) return true;
    return false;
  });
}

const LOOKUP_KEYWORDS = [
  'check', 'weather', 'price', 'stock', 'score', 'status', 'search',
  'look up', 'find out', 'tell me', 'show me', 'get me', 'what is', "what's",
  'who is', 'when is', 'where is', 'how to', 'how do', 'latest', 'current',
  'today', 'news', 'update', 'query', 'fetch', 'retrieve', 'answer',
  'calculate', 'convert', 'translate', 'summarize', 'explain', 'define',
  'recommend', 'suggest', 'list', 'compare', 'review',
];

function inferRunTaskClass({ objective = '', executionMode = 'action', objectivePolicy = null }) {
  const mode = String(executionMode || '').toLowerCase();
  const policy = objectivePolicy || {};
  const objectiveText = lowerText(objective);

  if (mode === 'research' || policy.researchOnly || policy.noBuild) {
    return 'research';
  }
  const hasResearch = hasAny(objectiveText, RESEARCH_KEYWORDS);
  const hasBuild = hasAny(objectiveText, BUILD_KEYWORDS);
  if (hasResearch && !hasBuild) {
    return 'research';
  }
  if (hasAny(objectiveText, OPERATIONS_KEYWORDS)) {
    return 'operations';
  }
  if (hasBuild) {
    return 'build';
  }
  // Lookup/general tasks: questions, info lookups, calculations, etc.
  // These don't require build verification or research deliverables.
  if (hasAny(objectiveText, LOOKUP_KEYWORDS)) {
    return 'lookup';
  }
  // Default: general task — don't assume build verification requirements
  // for objectives that contain no build-related keywords.
  return 'general';
}

function commandLooksLikeVerification(result) {
  const meta = result && result.metadata ? result.metadata : {};
  const command = lowerText(meta.command);
  const args = Array.isArray(meta.args) ? meta.args.map((item) => lowerText(item)).join(' ') : '';
  const intent = lowerText(result.intent);
  const summary = lowerText(result.summary);
  const output = lowerText(result.output);
  const haystack = `${command} ${args} ${intent} ${summary} ${output}`;
  const nonVerifiers = ['open', 'cat', 'ls', 'find', 'head', 'tail'];
  if (nonVerifiers.includes(command)) {
    return false;
  }
  return (
    haystack.includes(' test')
    || haystack.includes(' pytest')
    || haystack.includes(' jest')
    || haystack.includes(' vitest')
    || haystack.includes(' playwright')
    || haystack.includes(' xctest')
    || haystack.includes(' ctest')
    || haystack.includes(' xcodebuild')
    || haystack.includes(' swift test')
    || haystack.includes(' qa ')
  );
}

function commandLooksLikeBootstrap(result) {
  const meta = result && result.metadata ? result.metadata : {};
  const command = lowerText(meta.command);
  const args = Array.isArray(meta.args) ? meta.args.map((item) => lowerText(item)).join(' ') : '';
  const haystack = `${command} ${args}`;
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

function artifactStatsSuggestInstallableWorkspace(artifactStats = null) {
  const manifests = [
    ...(Array.isArray(artifactStats?.workspaceManifests) ? artifactStats.workspaceManifests : []),
    ...(Array.isArray(artifactStats?.nestedWorkspaceManifests) ? artifactStats.nestedWorkspaceManifests : []),
  ];
  return manifests.some((item) => [
    'package.json',
    'requirements.txt',
    'pyproject.toml',
    'poetry.lock',
    'uv.lock',
    'Cargo.toml',
    'go.mod',
    'Package.swift',
  ].includes(String(item || '')));
}

function browserActionLooksOperational(result) {
  const metadata = result && result.metadata ? result.metadata : {};
  const action = lowerText(
    metadata.action
    || (result && result.exact_args && result.exact_args.action)
    || '',
  );
  if (!action) return false;
  const nonOperational = new Set([
    'goto', 'wait_for', 'aria_snapshot', 'frames', 'find', 'read', 'hover', 'scroll',
  ]);
  return !nonOperational.has(action);
}

function latestSuccessfulBrowserResult(results = []) {
  const normalized = normalizeResults(results);
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const entry = normalized[index];
    if (!entry || !entry.ok) continue;
    const tool = String(entry.tool || '').trim();
    if (tool === 'browser_launch' || tool === 'browser_action') {
      return entry;
    }
  }
  return null;
}

function authFlowStillOnEntryForm(objective = '', results = []) {
  const text = lowerText(objective);
  const authIntent = /\b(sign[\s-]?up|signup|register|create account|login|log in|sign in|account)\b/.test(text);
  if (!authIntent) return false;
  const latest = latestSuccessfulBrowserResult(results);
  if (!latest) return false;
  const metadata = latest.metadata && typeof latest.metadata === 'object' ? latest.metadata : {};
  const pageUrl = lowerText(metadata.pageUrl || metadata.url || '');
  const output = lowerText(latest.output || '');
  const onAuthUrl = /\/signup\b|\/register\b|\/create-account\b|\/login\b|\/signin\b/.test(pageUrl);
  const hasAuthFields = output.includes('textbox "email"') && output.includes('textbox "password"');
  return onAuthUrl && hasAuthFields;
}

function isLikelyWebBuildObjective(objective = '', results = []) {
  const text = lowerText(objective);
  const webKeywords = [
    'web', 'website', 'web app', 'html', 'css', 'javascript', 'frontend',
    'browser', 'landing page',
  ];
  if (webKeywords.some((token) => text.includes(token))) {
    return true;
  }
  const normalized = normalizeResults(results);
  const touchedWebFiles = normalized.some((entry) => {
    const tool = String(entry.tool || '').trim();
    if (tool !== 'write_file' && tool !== 'append_file' && tool !== 'patch_file') {
      return false;
    }
    const p = String(entry?.metadata?.path || '').toLowerCase();
    if (p.endsWith('.html') || p.endsWith('.css')) return true;
    if ((p.endsWith('.js') || p.endsWith('.mjs')) && (text.includes('web') || text.includes('browser') || text.includes('frontend') || text.includes('html'))) {
      return true;
    }
    return false;
  });
  return touchedWebFiles;
}

function extractPlaywrightConsoleErrorCount(entry) {
  const metadata = entry && entry.metadata ? entry.metadata : {};
  if (Number.isFinite(Number(metadata.consoleErrorCount))) {
    return Number(metadata.consoleErrorCount);
  }
  const output = String((entry && entry.output) || '').trim();
  if (!output) return null;
  try {
    const parsed = JSON.parse(output);
    if (Number.isFinite(Number(parsed.consoleErrorCount))) {
      return Number(parsed.consoleErrorCount);
    }
  } catch {
    // Ignore parse errors — fallback regex below.
  }
  const match = output.match(/"consoleErrorCount"\s*:\s*(\d+)/i);
  if (match) {
    return Number(match[1] || 0);
  }
  return null;
}

function normalizeResults(results) {
  const entries = Array.isArray(results) ? results : [];
  return entries.filter((entry) => entry && typeof entry === 'object');
}

function buildReadinessChecklist({
  objective = '',
  threadContext = '',
  executionMode = 'action',
  objectivePolicy = null,
  results = [],
  artifactStats = null,
}) {
  const taskClass = inferRunTaskClass({ objective, executionMode, objectivePolicy });
  const normalized = normalizeResults(results);

  const successful = normalized.filter((entry) => entry.ok && !(entry.metadata && entry.metadata.denied));
  const failed = normalized.filter((entry) => !entry.ok && !(entry.metadata && entry.metadata.denied));
  const successfulReal = successful.filter((entry) => REAL_WORK_TOOLS.has(String(entry.tool || '').trim()));
  const writeLike = successful.filter((entry) => {
    const tool = String(entry.tool || '').trim();
    return tool === 'write_file' || tool === 'append_file' || tool === 'patch_file';
  });
  const wroteDocs = writeLike.some((entry) => {
    const p = entry && entry.metadata ? String(entry.metadata.path || '') : '';
    return DOC_EXTS.has(path.extname(p).toLowerCase());
  });
  const hasResearchEvidence = successful.some((entry) => RESEARCH_TOOLS.has(String(entry.tool || '').trim()));
  const hasVerificationEvidence = successful.some((entry) => {
    const tool = String(entry.tool || '').trim();
    if (tool === 'run_playwright') return true;
    if (tool === 'run_command') return commandLooksLikeVerification(entry);
    return false;
  });
  const playwrightRuns = successful.filter((entry) => String(entry.tool || '').trim() === 'run_playwright');
  const cleanPlaywrightRun = playwrightRuns.some((entry) => {
    const count = extractPlaywrightConsoleErrorCount(entry);
    return count === 0;
  });
  const hasOpsAction = successful.some((entry) => {
    const tool = String(entry.tool || '').trim();
    return tool === 'run_command'
      || tool === 'run_playwright'
      || (tool === 'browser_action' && browserActionLooksOperational(entry))
      || tool === 'send_email'
      || tool === 'notify_webhook'
      || tool.startsWith('github_');
  });
  const authStillOnForm = authFlowStillOnEntryForm(objective, normalized);
  const mediaMeta = inferMediaSelectionMeta(objective, threadContext);
  const mediaAnalysis = successful.filter((entry) => String(entry.tool || '').trim() === 'analyze_image');
  const mediaMatches = mediaAnalysis.filter((entry) =>
    mediaAnalysisMatchesTopic(entry.output || '', entry.intent || '', mediaMeta.topicKeywords)
  );

  const checks = [];
  const addCheck = (id, label, passed, detail, required = true) => {
    checks.push({ id, label, passed: Boolean(passed), detail: String(detail || ''), required: Boolean(required) });
  };

  addCheck(
    'meaningful_progress',
    'Did Geepus perform real work?',
    successfulReal.length > 0 || (taskClass === 'operations' && hasOpsAction),
    successfulReal.length > 0
      ? `${successfulReal.length} real action(s) completed.`
      : 'No successful real actions yet.',
    true,
  );

  const failureTooHigh = failed.length >= 4 && failed.length > successful.length;
  addCheck(
    'failure_ratio',
    'Are failures under control?',
    !failureTooHigh,
    failureTooHigh
      ? `${failed.length} failures vs ${successful.length} successes.`
      : `${failed.length} failure(s), ${successful.length} success(es).`,
    true,
  );

  if (taskClass === 'build') {
    const webBuild = isLikelyWebBuildObjective(objective, normalized);
    const installableWorkspace = artifactStatsSuggestInstallableWorkspace(artifactStats);
    const hasBootstrapEvidence = successful.some((entry) => {
      const tool = String(entry.tool || '').trim();
      if (tool !== 'run_command') return false;
      return commandLooksLikeBootstrap(entry) || commandLooksLikeVerification(entry);
    });
    const hasStrongVerificationEvidence = successful.some((entry) => {
      const tool = String(entry.tool || '').trim();
      if (tool === 'run_playwright') {
        return extractPlaywrightConsoleErrorCount(entry) === 0;
      }
      if (tool === 'run_command') {
        return commandLooksLikeVerification(entry);
      }
      return false;
    });
    addCheck(
      'verification',
      'Was there strong proof it works?',
      hasStrongVerificationEvidence,
      hasStrongVerificationEvidence
        ? 'Passing test/browser verification evidence found.'
        : 'No passing test/browser verification found yet. Run real tests or browser QA before completion.',
      true,
    );
    addCheck(
      'environment_ready',
      'Was the workspace environment actually bootstrapped?',
      installableWorkspace ? hasBootstrapEvidence : true,
      installableWorkspace
        ? (
          hasBootstrapEvidence
            ? 'A bootstrap/test/build command proved the workspace environment is usable.'
            : 'Installable workspace detected, but no successful bootstrap/setup command was recorded yet.'
        )
        : 'No installable workspace manifest detected.',
      installableWorkspace,
    );
    if (webBuild) {
      addCheck(
        'browser_console_clean',
        'Did browser QA pass with zero console errors?',
        cleanPlaywrightRun,
        cleanPlaywrightRun
          ? 'At least one Playwright run reported zero console errors.'
          : 'Web task requires run_playwright with consoleErrorCount=0 before completion.',
        true,
      );
    }
  } else if (taskClass === 'research') {
    addCheck(
      'research_evidence',
      'Was actual research performed?',
      hasResearchEvidence,
      hasResearchEvidence
        ? 'Research actions were executed.'
        : 'No credible research actions found yet.',
      true,
    );
    const reportExpected = Boolean(objectivePolicy && objectivePolicy.reportRequested);
    addCheck(
      'deliverable',
      'Was a report/document delivered?',
      reportExpected ? wroteDocs : true,
      reportExpected
        ? (wroteDocs ? 'Research deliverable file detected.' : 'Expected a written report/document output.')
        : 'No explicit report requested.',
      reportExpected,
    );
  } else if (taskClass === 'lookup' || taskClass === 'general') {
    // Lookup/general tasks: the agent just needs to have performed some
    // successful real work (web search, http request, command, etc.).
    // No build verification or research report is required.
    addCheck(
      'task_executed',
      'Was the requested task performed?',
      successfulReal.length > 0 || hasResearchEvidence,
      successfulReal.length > 0
        ? `${successfulReal.length} action(s) completed successfully.`
        : (hasResearchEvidence ? 'Information gathered.' : 'No actions completed yet.'),
      true,
    );
  } else {
    addCheck(
      'ops_action',
      'Was the requested action actually performed?',
      hasOpsAction && !authStillOnForm,
      authStillOnForm
        ? 'Auth flow is still on the entry form. Submission did not reach a new state yet.'
        : (hasOpsAction ? 'Operational action evidence detected.' : 'No completed operational action detected.'),
      true,
    );
  }

  if (artifactStats && artifactStats.totalTargets > 0) {
    addCheck(
      'artifacts_exist',
      'Do output files exist on disk?',
      artifactStats.missingPaths.length === 0,
      artifactStats.missingPaths.length === 0
        ? `${artifactStats.existingTargets}/${artifactStats.totalTargets} output file(s) found.`
        : `Missing: ${artifactStats.missingPaths.slice(0, 3).join(', ')}`,
      true,
    );
    if (artifactStats.writeTargets > 0) {
      addCheck(
        'artifacts_non_empty',
        'Are written files non-empty?',
        artifactStats.emptyWritePaths.length === 0,
        artifactStats.emptyWritePaths.length === 0
          ? `${artifactStats.nonEmptyWriteTargets}/${artifactStats.writeTargets} written file(s) are non-empty.`
          : `Empty file(s): ${artifactStats.emptyWritePaths.slice(0, 3).join(', ')}`,
        true,
      );
    }
  }

  if (mediaMeta.isMediaSelection) {
    const minAnalyses = mediaMeta.requestedCount > 0 ? Math.min(mediaMeta.requestedCount, 8) : 2;
    const hasEnoughAnalyses = mediaAnalysis.length >= minAnalyses;
    const relevancePassed = hasEnoughAnalyses
      && mediaAnalysis.length > 0
      && mediaMatches.length === mediaAnalysis.length;
    addCheck(
      'media_relevance',
      'Do selected media files match the requested theme?',
      relevancePassed,
      !hasEnoughAnalyses
        ? `Only ${mediaAnalysis.length}/${minAnalyses} media analyses found. Run analyze_image on selected files before finishing.`
        : `Theme matches in ${mediaMatches.length}/${mediaAnalysis.length} analyzed files (keywords: ${mediaMeta.topicKeywords.join(', ') || 'requested theme'}).`,
      true,
    );
  }

  const required = checks.filter((check) => check.required);
  const failedRequired = required.filter((check) => !check.passed);
  const ready = failedRequired.length === 0;

  let nextFocus = '';
  if (!ready) {
    const top = failedRequired[0];
    nextFocus = [
      `${top.label} is not satisfied. ${top.detail}`,
      'Choose one concrete action that directly satisfies this missing proof before trying to complete the run again.',
    ].join(' ');
  }

  return {
    taskClass,
    ready,
    summary: ready
      ? 'Ready for completion.'
      : `Not ready: ${failedRequired.map((item) => item.label).join(' • ')}`,
    checks,
    successCount: successful.length,
    failureCount: failed.length,
    nextFocus,
  };
}

async function collectArtifactStats(workspaceRoot, results) {
  const normalized = normalizeResults(results);
  const candidates = new Map();
  for (const result of normalized) {
    if (!result.ok) continue;
    const tool = String(result.tool || '').trim();
    if (tool !== 'write_file' && tool !== 'append_file' && tool !== 'patch_file') continue;
    const relPath = String(result?.metadata?.path || '').trim();
    if (!relPath) continue;
    if (!candidates.has(relPath)) {
      candidates.set(relPath, { path: relPath, tool });
    }
  }

  const entries = Array.from(candidates.values()).slice(0, 100);
  const workspaceManifests = [];
  const nestedWorkspaceManifests = [];
  const missingPaths = [];
  const emptyWritePaths = [];
  let existingTargets = 0;
  let nonEmptyWriteTargets = 0;
  let writeTargets = 0;

  for (const manifestName of [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    'requirements.txt',
    'pyproject.toml',
    'poetry.lock',
    'uv.lock',
    'Cargo.toml',
    'go.mod',
    'Package.swift',
  ]) {
    try {
      const stat = await fs.stat(path.resolve(workspaceRoot, manifestName));
      if (stat.isFile()) {
        workspaceManifests.push(manifestName);
      }
    } catch {
      // Ignore missing manifest files.
    }
  }

  for (const result of normalized) {
    const metadataPath = String(result?.metadata?.path || '').trim();
    if (!metadataPath) continue;
    const normalizedPath = metadataPath.replace(/^\.\//, '');
    const baseName = path.basename(normalizedPath);
    if (![
      'package.json',
      'requirements.txt',
      'pyproject.toml',
      'poetry.lock',
      'uv.lock',
      'Cargo.toml',
      'go.mod',
      'Package.swift',
    ].includes(baseName)) {
      continue;
    }
    if (!nestedWorkspaceManifests.includes(normalizedPath) && normalizedPath.includes('/')) {
      nestedWorkspaceManifests.push(normalizedPath);
    }
  }

  for (const item of entries) {
    const abs = path.resolve(workspaceRoot, item.path);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) {
        missingPaths.push(item.path);
        continue;
      }
      existingTargets += 1;
      const isWriteTarget = item.tool === 'write_file' || item.tool === 'append_file';
      if (isWriteTarget) {
        writeTargets += 1;
        if (stat.size > 0) {
          nonEmptyWriteTargets += 1;
        } else {
          emptyWritePaths.push(item.path);
        }
      }
    } catch {
      missingPaths.push(item.path);
      if (item.tool === 'write_file' || item.tool === 'append_file') {
        writeTargets += 1;
      }
    }
  }

  return {
    totalTargets: entries.length,
    existingTargets,
    workspaceManifests,
    nestedWorkspaceManifests,
    missingPaths,
    writeTargets,
    nonEmptyWriteTargets,
    emptyWritePaths,
  };
}

module.exports = {
  inferRunTaskClass,
  buildReadinessChecklist,
  collectArtifactStats,
};
