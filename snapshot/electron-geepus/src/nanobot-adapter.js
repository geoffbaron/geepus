'use strict';

const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');

const RESEARCH_TOOLS = new Set([
  'think',
  'list_files',
  'read_file',
  'search_files',
  'web_search',
  'web_scrape',
  'http_request',
  'analyze_image',
]);

const BUILD_TOOLS = new Set([
  'write_file',
  'patch_file',
  'append_file',
  'run_command',
  'run_playwright',
  'delegate',
  'respond',
]);

const PREP_INSPECTION_TOOLS = new Set([
  'think',
  'list_files',
  'read_file',
  'search_files',
  'analyze_image',
]);

const FALLBACK_SKILLS = [
  { name: 'memory', preview: 'Use long-term memory and searchable history to keep context across runs.' },
  { name: 'summarize', preview: 'Turn long findings into concise, decision-ready summaries.' },
  { name: 'github', preview: 'Handle repository workflows and PR-oriented delivery.' },
  { name: 'cron', preview: 'Schedule recurring jobs and reminders.' },
  { name: 'skill-creator', preview: 'Create reusable playbooks (skills) for repeated task types.' },
];

const FALLBACK_BOOTSTRAP = [
  'Nanobot loop mode is active.',
  '- Build context from memory + history + skills before planning.',
  '- Execute tools in short loops: observe -> decide -> act -> verify.',
  '- Stay tightly scoped to the user objective; no side quests.',
  '- Never declare done without real verification evidence from tools.',
  '- Persist durable lessons so future runs improve automatically.',
].join('\n');

let _cache = {
  loaded: false,
  bootstrap: FALLBACK_BOOTSTRAP,
  skills: FALLBACK_SKILLS.map((entry) => ({
    ...entry,
    source: 'nanobot-builtin',
    path: `nanobot/skills/${entry.name}/SKILL.md`,
  })),
};

function candidateNanobotRoots() {
  const explicit = String(process.env.GEEPUS_NANOBOT_PATH || '').trim();
  const roots = [
    explicit,
    path.resolve(__dirname, '..', '..', 'vendor', 'nanobot'),
    path.resolve(__dirname, '..', 'vendor', 'nanobot'),
    path.resolve(process.cwd(), 'vendor', 'nanobot'),
  ].filter(Boolean);
  return Array.from(new Set(roots));
}

function trimMarkdown(content, maxLines = 24, maxChars = 1200) {
  const lines = String(content || '').split('\n').slice(0, maxLines).join('\n').trim();
  return lines.length > maxChars ? `${lines.slice(0, maxChars)}…` : lines;
}

async function tryRead(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function collectSkillSummaries(skillRoot, limit = 12) {
  let entries = [];
  try {
    entries = await fs.readdir(skillRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillRoot, entry.name, 'SKILL.md');
    if (!fsSync.existsSync(skillFile)) continue;
    const content = await tryRead(skillFile);
    if (!content) continue;
    summaries.push({
      name: entry.name,
      path: skillFile,
      source: 'nanobot-builtin',
      preview: trimMarkdown(content, 16, 550),
    });
    if (summaries.length >= limit) break;
  }
  return summaries;
}

async function loadNanobotAssets(force = false) {
  if (_cache.loaded && !force) return _cache;
  for (const root of candidateNanobotRoots()) {
    const templatesRoot = path.join(root, 'nanobot', 'templates');
    const skillsRoot = path.join(root, 'nanobot', 'skills');
    if (!fsSync.existsSync(templatesRoot) || !fsSync.existsSync(skillsRoot)) continue;

    const [agents, tools, user, soul] = await Promise.all([
      tryRead(path.join(templatesRoot, 'AGENTS.md')),
      tryRead(path.join(templatesRoot, 'TOOLS.md')),
      tryRead(path.join(templatesRoot, 'USER.md')),
      tryRead(path.join(templatesRoot, 'SOUL.md')),
    ]);

    const bootstrap = [
      'Nanobot templates loaded from local vendor bundle.',
      trimMarkdown(agents, 22, 900),
      trimMarkdown(tools, 18, 900),
      trimMarkdown(user, 14, 550),
      trimMarkdown(soul, 14, 550),
    ].filter(Boolean).join('\n\n');

    const skills = await collectSkillSummaries(skillsRoot, 16);
    _cache = {
      loaded: true,
      bootstrap: bootstrap || FALLBACK_BOOTSTRAP,
      skills: skills.length > 0 ? skills : _cache.skills,
    };
    return _cache;
  }

  _cache = { ..._cache, loaded: true };
  return _cache;
}

function mergeNanobotSkills(projectSkills, nanobotSkills, limit = 18) {
  const all = [];
  const seen = new Set();
  for (const skill of [...(projectSkills || []), ...(nanobotSkills || [])]) {
    const name = String(skill?.name || '').trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    all.push(skill);
    if (all.length >= limit) break;
  }
  return all;
}

function buildNanobotPlannerNotes({
  objective = '',
  executionMode = 'action',
  threadContext = '',
  bootstrap = FALLBACK_BOOTSTRAP,
}) {
  return [
    '=== NANO LOOP ADAPTER ===',
    bootstrap,
    '',
    'Loop policy for this run:',
    '- On every iteration, choose the smallest real action that moves objective completion forward.',
    '- Prefer concrete output over discussion. If implementation is requested, write/patch files early.',
    '- When blocked, change strategy quickly; do not repeat the same failing action pattern.',
    '- Keep objective and thread context as the single source of truth.',
    executionMode === 'research'
      ? '- Research mode: gather evidence and produce artifacts, but do not implement product code.'
      : '- Action/Auto mode: transition from research to implementation quickly; avoid research-only loops.',
    '',
    `Objective anchor: ${objective}`,
    threadContext ? `Thread context anchor:\n${threadContext}` : '',
    '=== END NANO LOOP ADAPTER ===',
  ].filter(Boolean).join('\n');
}

function isResearchOnlyAction(action) {
  const tool = String(action?.tool || '').trim().toLowerCase();
  return RESEARCH_TOOLS.has(tool);
}

function hasRealBuildAction(actions) {
  return (actions || []).some((entry) => BUILD_TOOLS.has(String(entry?.tool || '').trim().toLowerCase()));
}

function isBuildLikeObjective(text) {
  const value = String(text || '').toLowerCase();
  return /\b(build|create|implement|develop|ship|fix|refactor|extension|app|website|plugin|tool)\b/.test(value);
}

function isPrepInspectionIteration(actions) {
  const list = Array.isArray(actions) ? actions : [];
  if (list.length === 0 || list.length > 5) return false;
  const tools = list.map((entry) => String(entry?.tool || '').trim().toLowerCase());
  const allPrep = tools.every((tool) => PREP_INSPECTION_TOOLS.has(tool));
  const hasConcreteInspection = tools.some((tool) => (
    tool === 'analyze_image'
    || tool === 'read_file'
    || tool === 'search_files'
    || tool === 'list_files'
  ));
  return allPrep && hasConcreteInspection;
}

// Network-action tools that produce real output for lookup/fetch tasks.
// These are NOT "just research" — they are the primary deliverable for
// objectives like "check the weather", "look up stock prices", etc.
const NETWORK_ACTION_TOOLS = new Set([
  'web_search',
  'web_scrape',
  'http_request',
]);

function hasNetworkAction(actions) {
  return (actions || []).some((entry) => NETWORK_ACTION_TOOLS.has(String(entry?.tool || '').trim().toLowerCase()));
}

function isLookupObjective(text) {
  const value = String(text || '').toLowerCase();
  return /\b(check|look\s*up|find\s*out|what\s+is|what'?s|weather|price|stock|score|status|search|query|get\s+me|tell\s+me|show\s+me|how\s+to|how\s+do|who\s+is|when\s+is|where\s+is|latest|current|today|news|update|fetch|retrieve|answer|calculate|convert|translate|summarize|explain|define|recommend|suggest|list|compare|review)\b/.test(value)
    && !isBuildLikeObjective(value);
}

function validateNanobotPlan({ actions, executionMode, objectivePolicy, objective }) {
  const policy = objectivePolicy || {};
  if (executionMode === 'research' || policy.researchOnly || policy.noBuild) {
    return { ok: true, reason: '' };
  }
  if (!Array.isArray(actions) || actions.length === 0) {
    return { ok: false, reason: 'Planner returned no actions.' };
  }
  const researchOnly = actions.every((entry) => isResearchOnlyAction(entry));
  if (researchOnly) {
    // Allow a short "inspect first" iteration (e.g., screenshot + file read) in
    // Action/Auto mode. This prevents hard-failing valid refinement tasks.
    if (isPrepInspectionIteration(actions)) {
      return { ok: true, reason: '' };
    }
    // Allow network-action plans (web_search, http_request, web_scrape) for
    // lookup/fetch objectives. These ARE the deliverable, not just research.
    if (hasNetworkAction(actions)) {
      return { ok: true, reason: '' };
    }
    // If the objective is clearly a lookup/info task, allow research tools.
    if (isLookupObjective(objective)) {
      return { ok: true, reason: '' };
    }
    return { ok: false, reason: 'Planner returned research-only actions in Action/Auto mode.' };
  }
  if (isBuildLikeObjective(objective) && !hasRealBuildAction(actions) && !isPrepInspectionIteration(actions)) {
    return { ok: false, reason: 'Objective requires implementation but no build action was planned.' };
  }
  return { ok: true, reason: '' };
}

module.exports = {
  loadNanobotAssets,
  mergeNanobotSkills,
  buildNanobotPlannerNotes,
  isPrepInspectionIteration,
  validateNanobotPlan,
};
