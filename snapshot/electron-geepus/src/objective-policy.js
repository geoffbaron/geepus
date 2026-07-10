'use strict';

const { ensureObject } = require('./utils');

const GENERIC_OBJECTIVE_WORDS = new Set([
  'okay',
  'ok',
  'project',
  'research',
  'build',
  'app',
  'application',
  'task',
  'please',
  'proceed',
  'continue',
  'start',
  'stop',
  'work',
  'things',
  'something',
  'anything',
  'help',
  'make',
  'want',
  'need',
  'what',
  'should',
  'would',
  'could',
  'about',
  'our',
  'we',
  'with',
  'that',
  'this',
  'from',
  'into',
  'your',
  'my',
  'the',
  'for',
  'and',
  'not',
  'dont',
  "don't",
  'only',
  'plan',
  'planning',
  'mode',
  'action',
]);

const INFRA_KEYWORDS = [
  'aws',
  'amplify',
  'cloudformation',
  'terraform',
  'kubernetes',
  'docker',
  'devops',
  'deployment',
  'serverless',
  'ec2',
  'iam',
  'vpc',
  'lambda',
  's3',
];

const READ_ONLY_COMMANDS = new Set(['ls', 'pwd', 'cat', 'find', 'head', 'tail', 'wc']);

const TEAM_OWNER_ORDER = ['chief', 'strategist', 'research', 'product', 'design', 'engineering', 'qa'];
const RESEARCH_TEAM_OWNER_ORDER = ['chief', 'strategist', 'research'];
const MARKETING_TEAM_OWNER_ORDER = ['chief', 'content_strategist', 'copywriter', 'social_media', 'growth', 'brand'];
const OPS_TEAM_OWNER_ORDER = ['chief', 'cost_monitor', 'optimizer', 'infra_advisor'];
const ALL_TEAM_OWNER_ORDER = ['chief', 'strategist', 'research', 'product', 'design', 'engineering', 'qa', 'content_strategist', 'copywriter', 'social_media', 'growth', 'brand', 'cost_monitor', 'optimizer', 'infra_advisor'];

function ownerOrderForTeamMode(teamMode) {
  if (teamMode === 'all') return ALL_TEAM_OWNER_ORDER;
  if (teamMode === 'marketing') return MARKETING_TEAM_OWNER_ORDER;
  if (teamMode === 'ops') return OPS_TEAM_OWNER_ORDER;
  if (teamMode === 'research') return RESEARCH_TEAM_OWNER_ORDER;
  return TEAM_OWNER_ORDER;
}

// ---------------------------------------------------------------------------
// detectTeamMode — auto-select the best team based on objective text
// ---------------------------------------------------------------------------
const MARKETING_SIGNALS = [
  'marketing', 'content', 'seo', 'social media', 'brand', 'branding',
  'campaign', 'ads', 'advertising', 'email marketing', 'copywriting',
  'landing page', 'funnel', 'newsletter', 'blog post', 'editorial',
  'go-to-market', 'gtm', 'audience', 'engagement', 'influencer',
  'twitter', 'instagram', 'tiktok', 'linkedin', 'facebook',
  'press release', 'pr ', 'copy ', 'headline', 'tagline',
  'conversion rate', 'click-through', 'ctr', 'open rate',
  'content calendar', 'editorial calendar', 'social post',
];

const OPS_SIGNALS = [
  'cost', 'budget', 'spending', 'optimize', 'optimization',
  'performance', 'latency', 'throughput', 'infrastructure',
  'monitor', 'monitoring', 'scale', 'scaling', 'caching',
  'token usage', 'api cost', 'rate limit', 'quota',
  'batch', 'batching', 'queue', 'worker', 'load balancer',
  'uptime', 'downtime', 'incident', 'alert', 'metric',
  'cpu', 'memory usage', 'disk', 'bandwidth',
  'devops', 'ci/cd', 'pipeline', 'deploy',
];

const RESEARCH_SIGNALS = [
  'research', 'analyze', 'analysis', 'investigate', 'findings', 'report',
  'reddit', 'subreddit', 'market', 'trend', 'benchmark', 'compare',
  'landscape', 'evidence', 'sources',
];

const BUILD_SIGNALS = [
  'build', 'create', 'implement', 'develop', 'code', 'scaffold', 'refactor',
  'fix', 'debug', 'deploy', 'test', 'qa',
];

function detectTeamMode(objective) {
  const text = String(objective || '').toLowerCase();

  let marketingScore = 0;
  let opsScore = 0;

  for (const signal of MARKETING_SIGNALS) {
    if (text.includes(signal)) marketingScore++;
  }
  for (const signal of OPS_SIGNALS) {
    if (text.includes(signal)) opsScore++;
  }

  const researchScore = RESEARCH_SIGNALS.reduce((count, signal) => (
    text.includes(signal) ? count + 1 : count
  ), 0);
  const buildScore = BUILD_SIGNALS.reduce((count, signal) => (
    text.includes(signal) ? count + 1 : count
  ), 0);

  // Require at least 2 signal matches to avoid false positives
  if (researchScore >= 2 && buildScore === 0) return 'research';
  if (marketingScore >= 2 && marketingScore > opsScore) return 'marketing';
  if (opsScore >= 2 && opsScore > marketingScore) return 'ops';
  if (researchScore === 1 && buildScore === 0) return 'research';
  // Single strong signal is enough for unambiguous cases
  if (marketingScore === 1 && opsScore === 0) return 'marketing';
  if (opsScore === 1 && marketingScore === 0) return 'ops';

  return 'dev';
}

function wordsForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
    .filter((item) => !GENERIC_OBJECTIVE_WORDS.has(item));
}

function detectObjectivePolicy(objective) {
  const text = String(objective || '').toLowerCase();
  const researchSignals = ['research', 'analyze', 'analysis', 'market', 'trend', 'reddit', 'news', 'findings'];
  const noBuildSignals = [
    "don't build",
    'dont build',
    'do not build',
    'no build',
    'research only',
    'planning only',
    "don't code",
    'do not code',
    'no coding',
  ];
  const buildSignals = [
    'build', 'create', 'make', 'implement', 'develop', 'code', 'write',
    'plugin', 'extension', 'app', 'website', 'site', 'tool', 'script',
    'chrome', 'firefox', 'react', 'node', 'python', 'deploy', 'scaffold',
  ];
  const webSignals = ['reddit', 'web', 'news', 'internet', 'online', 'subreddit', 'browser'];
  const localSignals = ['workspace', 'repo', 'repository', 'codebase', 'folder', 'file', 'local'];
  const reportSignals = ['report', 'doc', 'document', 'summary', 'findings', 'notes', 'brief'];

  const hasResearchSignal = researchSignals.some((signal) => text.includes(signal));
  const hasBuildSignal = buildSignals.some((signal) => text.includes(signal));
  const noBuild = noBuildSignals.some((signal) => text.includes(signal));

  // Only mark as research-only if there is NO build intent in the objective.
  // "Research X, build Y" is a build task with a research phase — NOT research-only.
  const researchOnly = hasResearchSignal && !hasBuildSignal && !noBuild ? true : (noBuild ? true : false);
  const localResearchMentioned = localSignals.some((signal) => text.includes(signal));
  const webMentioned = webSignals.some((signal) => text.includes(signal));
  const webResearchPreferred = researchOnly && (webMentioned || !localResearchMentioned);
  const reportRequested = reportSignals.some((signal) => text.includes(signal));

  return {
    researchOnly,
    noBuild,
    webResearchPreferred,
    reportRequested,
  };
}

function objectivePolicyPrompt(policy) {
  const lines = [];
  if (policy.researchOnly) {
    lines.push('- Objective mode: research-only. Focus on findings, analysis, and documentation.');
  }
  if (policy.noBuild) {
    lines.push('- Hard rule: do NOT build software, configure infrastructure, run build/test pipelines, or scaffold code.');
  }
  if (policy.webResearchPreferred) {
    lines.push('- Prefer web_search and web_scrape tools for web research. Use run_playwright only for interactive or JS-heavy sites.');
    lines.push('- Keep local file inspection minimal and only for writing/organizing research notes.');
  }
  if (policy.reportRequested) {
    lines.push('- Deliverable expected: a concise report document with findings and clear structure.');
  }
  return lines.join('\n');
}

function applyExecutionModePolicy(basePolicy, executionMode) {
  const mode = String(executionMode || '').trim().toLowerCase();
  const policy = ensureObject(basePolicy);
  if (mode === 'research') {
    return {
      researchOnly: true,
      noBuild: true,
      webResearchPreferred: true,
      reportRequested: true,
    };
  }
  // 'auto' and 'action' both allow full execution
  return {
    researchOnly: Boolean(policy.researchOnly),
    noBuild: Boolean(policy.noBuild),
    webResearchPreferred: Boolean(policy.webResearchPreferred),
    reportRequested: Boolean(policy.reportRequested),
  };
}

function objectiveOverlapScore(text, objectiveWords) {
  const haystack = String(text || '').toLowerCase();
  let score = 0;
  for (const word of objectiveWords) {
    if (haystack.includes(word)) {
      score += 1;
    }
  }
  return score;
}

function allowedOwnersForPolicy(policy, teamMode) {
  if (!policy || (!policy.researchOnly && !policy.noBuild)) {
    return new Set(ownerOrderForTeamMode(teamMode || 'dev'));
  }
  return new Set(RESEARCH_TEAM_OWNER_ORDER);
}

function fallbackOwnerForPolicy(action, policy, teamMode) {
  const allowed = allowedOwnersForPolicy(policy, teamMode);
  const intent = String(action.intent || '').toLowerCase();
  if (allowed.has('chief') && (
    intent.includes('orchestrate')
    || intent.includes('delegate')
    || intent.includes('handoff')
    || intent.includes('prioritize')
  )) {
    return 'chief';
  }
  if (allowed.has('strategist') && (
    intent.includes('strategy')
    || intent.includes('tradeoff')
    || intent.includes('synthesis')
    || intent.includes('recommendation')
  )) {
    return 'strategist';
  }
  // Marketing team fallbacks
  if (allowed.has('content_strategist') && (
    intent.includes('content') || intent.includes('seo') || intent.includes('editorial')
    || intent.includes('strategy')
  )) {
    return 'content_strategist';
  }
  if (allowed.has('copywriter') && (
    intent.includes('copy') || intent.includes('write') || intent.includes('draft')
  )) {
    return 'copywriter';
  }
  // Ops team fallbacks
  if (allowed.has('cost_monitor') && (
    intent.includes('cost') || intent.includes('budget') || intent.includes('spending')
  )) {
    return 'cost_monitor';
  }
  if (allowed.has('optimizer') && (
    intent.includes('optimize') || intent.includes('performance') || intent.includes('latency')
  )) {
    return 'optimizer';
  }
  if (allowed.has('research')) {
    return 'research';
  }
  return Array.from(allowed)[0] || 'research';
}

function actionText(action) {
  const args = ensureObject(action.exact_args);
  return [
    String(action.intent || ''),
    String(action.tool || ''),
    String(args.command || ''),
    Array.isArray(args.args) ? args.args.join(' ') : '',
    String(args.path || ''),
  ].join(' ').toLowerCase();
}

function objectiveMentionsInfra(objective) {
  const text = String(objective || '').toLowerCase();
  return INFRA_KEYWORDS.some((keyword) => text.includes(keyword));
}

function isOutOfScopeInfraAction(action, objective) {
  if (objectiveMentionsInfra(objective)) {
    return false;
  }
  const text = actionText(action);
  return INFRA_KEYWORDS.some((keyword) => text.includes(keyword));
}

function isDisallowedByObjectivePolicy(action, policy) {
  const tool = String(action.tool || '');
  const args = ensureObject(action.exact_args);
  const command = String(args.command || '').toLowerCase();
  const cmdArgs = Array.isArray(args.args) ? args.args.map((item) => String(item).toLowerCase()) : [];
  const pathArg = String(args.path || '').toLowerCase();

  if (!policy.noBuild && !policy.researchOnly) {
    return false;
  }

  if (policy.webResearchPreferred) {
    if (tool === 'list_files' || tool === 'read_file' || tool === 'run_command') {
      return true;
    }
  }

  if (tool === 'run_command') {
    if (!READ_ONLY_COMMANDS.has(command) && command !== 'open') {
      return true;
    }
    if (command === 'open' && cmdArgs.some((value) => value.includes('code') || value.includes('xcode'))) {
      return true;
    }
    return false;
  }

  if (tool === 'write_file' || tool === 'append_file') {
    if (!policy.reportRequested) {
      return true;
    }
    return !(
      pathArg.endsWith('.md')
      || pathArg.endsWith('.txt')
      || pathArg.endsWith('.csv')
      || pathArg.endsWith('.json')
    );
  }

  if (tool === 'run_playwright' || tool === 'list_files' || tool === 'read_file') {
    return false;
  }

  // Network lookup tools are never disallowed — they are core to research AND lookup tasks
  if (tool === 'web_search' || tool === 'web_scrape' || tool === 'web_fetch' || tool === 'http_request' || tool === 'think' || tool === 'delegate') {
    return false;
  }

  // Browser tools are never disallowed — they are required for web research and automation
  if (tool === 'browser_launch' || tool === 'browser_action' || tool === 'browser_close') {
    return false;
  }

  // Analysis and search tools are always allowed
  if (tool === 'analyze_image' || tool === 'search_files') {
    return false;
  }

  return true;
}

module.exports = {
  GENERIC_OBJECTIVE_WORDS,
  INFRA_KEYWORDS,
  READ_ONLY_COMMANDS,
  TEAM_OWNER_ORDER,
  RESEARCH_TEAM_OWNER_ORDER,
  MARKETING_TEAM_OWNER_ORDER,
  OPS_TEAM_OWNER_ORDER,
  ALL_TEAM_OWNER_ORDER,
  ownerOrderForTeamMode,
  detectTeamMode,
  wordsForMatch,
  detectObjectivePolicy,
  objectivePolicyPrompt,
  applyExecutionModePolicy,
  objectiveOverlapScore,
  allowedOwnersForPolicy,
  fallbackOwnerForPolicy,
  actionText,
  objectiveMentionsInfra,
  isOutOfScopeInfraAction,
  isDisallowedByObjectivePolicy,
};
