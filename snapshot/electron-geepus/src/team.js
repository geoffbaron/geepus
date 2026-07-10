'use strict';

const { TEAM_OWNER_ORDER, RESEARCH_TEAM_OWNER_ORDER, MARKETING_TEAM_OWNER_ORDER, OPS_TEAM_OWNER_ORDER } = require('./objective-policy');
const { extractOutputText, callResponsesWithFallback } = require('./providers');
const { truncate, stripThinkTags } = require('./utils');
const { detectObjectivePolicy, objectivePolicyPrompt } = require('./objective-policy');

const TEAM_OWNER_LABELS = {
  chief: 'Chief of Staff',
  strategist: 'Strategist',
  research: 'Research Lead',
  product: 'Product Lead',
  design: 'Design Lead',
  engineering: 'Engineering Lead',
  qa: 'QA Lead',
  // Marketing roles
  content_strategist: 'Content Strategist',
  copywriter: 'Copywriter',
  social_media: 'Social Media Manager',
  growth: 'Growth & Analytics Lead',
  brand: 'Brand Manager',
  // Ops roles
  cost_monitor: 'Cost Monitor',
  optimizer: 'Performance Optimizer',
  infra_advisor: 'Infrastructure Advisor',
};

// ---------------------------------------------------------------------------
// Team presets — each maps to a set of role prompts
// ---------------------------------------------------------------------------

const TEAM_PROMPTS = [
  {
    role: 'chief',
    label: 'Chief of Staff',
    instructions: 'Orchestrate the team, set strategy, sequence work, and define "done" precisely. You combine Chief of Staff + Strategist + Product Lead responsibilities. Define: (1) the best technical approach and sequencing, (2) exact acceptance criteria — "done" means fully functional AND polished with zero console errors, styled UI, real logic, and verified in-browser, (3) which specialists are needed. QUALITY GATE: Before declaring anything done, verify output is complete and polished — never accept a skeleton or stub. If a teammate produces minimal output, send them back.',
  },
  {
    role: 'research',
    label: 'Research Lead',
    instructions: 'Gather and synthesize relevant technical/product context, constraints, and options. Use web_search and web_scrape aggressively to find solutions, documentation, and examples. If the team does not know how to do something, it is YOUR job to find the answer. Never say "research needed" without actually doing the research.',
  },
  {
    role: 'design',
    label: 'Design Lead',
    instructions: 'Define UX flow, copy tone, and visual constraints. Make concrete design decisions — specify exact hex colors, font families, spacing values, border radius, shadow values, and layout structure (flexbox/grid). Every UI must look modern and professional. Specify hover/active/focus states for interactive elements. Define responsive breakpoints if relevant. If building a Chrome extension popup, specify exact dimensions (min 350px wide), padding, and a cohesive color scheme. Do not ask the user for design preferences; use modern defaults that look great out of the box. Unstyled default-browser-chrome output is a design FAILURE.',
  },
  {
    role: 'engineering',
    label: 'Engineering Lead',
    instructions: 'Define implementation architecture and execution steps. For every feature specify: (1) exact files to create/modify, (2) key functions and signatures with FULL implementation — never stubs or placeholders, (3) error handling, (4) how it will be tested. Every function body must contain real working logic. console.log-only handlers and "// TODO" comments are engineering failures. If a dependency or tool is needed (npm package, pip library, system tool), include an action to install it. For Chrome extensions: define manifest.json permissions, content script targets, popup/background scripts, and message passing architecture. Popup CSS must be included in the architecture — unstyled HTML is not acceptable. Storage logic (chrome.storage), badge updates, and all advertised features must be fully implemented. Never suggest the user install anything — install it yourself via run_command.',
  },
  {
    role: 'qa',
    label: 'QA Lead',
    instructions: 'You have access to run_playwright and run_command. You MUST actually run the app and check for errors — do not just describe a test plan. For web/HTML projects: (1) start a local server (run_command: python3 -m http.server 8081 &), (2) run run_playwright on http://localhost:8081, (3) read the consoleErrorCount and consoleErrors fields in the result — every error must be investigated and fixed. consoleErrorCount > 0 means the project is NOT done. For Chrome extensions: use run_playwright with extension_path. For APIs/CLIs: run them and assert real output. If tests fail, specify exactly what to fix and verify the fix.',
  },
];

const RESEARCH_TEAM_PROMPTS = [
  {
    role: 'chief',
    label: 'Chief of Staff',
    instructions: 'Lead a research-only mission. Keep the team focused on the stated objective, define what evidence is needed, and prevent scope drift. Do not assign build or engineering work unless the objective explicitly asks for implementation.',
  },
  {
    role: 'strategist',
    label: 'Strategist',
    instructions: 'Turn research findings into clear recommendations, options, and next-step decisions. Keep outputs decision-ready and tied to objective success criteria.',
  },
  {
    role: 'research',
    label: 'Research Lead',
    instructions: 'Gather evidence from credible sources, synthesize findings, and produce concise deliverables (reports/briefs) that directly answer the objective. Avoid speculative or unrelated exploration.',
  },
];

const MARKETING_TEAM_PROMPTS = [
  {
    role: 'chief',
    label: 'Chief of Staff',
    instructions: 'Orchestrate the marketing team: decide priorities, sequence work across channels, and keep campaigns on track. Make all decisions autonomously — do not ask the user for approval or preferences. If you need market data, direct the team to research it.',
  },
  {
    role: 'content_strategist',
    label: 'Content Strategist',
    instructions: 'Define content pillars, editorial calendar themes, SEO keyword targets, and content distribution strategy. Identify gaps in current content and high-impact topics. If you need market data or competitor analysis, use web_search to get it — never say "research needed" without doing the research yourself. Make strategic decisions autonomously.',
  },
  {
    role: 'copywriter',
    label: 'Copywriter',
    instructions: 'Draft compelling copy: landing pages, email sequences, ad copy, blog posts, product descriptions. Match tone to target audience and optimize for conversion. Write full drafts — never outlines or placeholders. If you need brand examples or competitor copy for reference, web_search for them. Produce publish-ready content.',
  },
  {
    role: 'social_media',
    label: 'Social Media Manager',
    instructions: 'Plan social media posts, engagement strategies, posting schedules, hashtag strategy, and community building tactics across platforms (Twitter/X, LinkedIn, Instagram, TikTok, etc.). Write actual post copy, not just strategies. If you need trending topics or platform-specific best practices, web_search for current data. Make scheduling and platform decisions autonomously.',
  },
  {
    role: 'growth',
    label: 'Growth & Analytics Lead',
    instructions: 'Define KPIs, analyze funnel metrics, identify growth levers, design A/B tests, and recommend data-driven optimizations. Track CAC, LTV, conversion rates, and retention. If you need benchmarks or industry data, web_search for them. Make data-driven decisions autonomously — do not present options for the user to choose from.',
  },
  {
    role: 'brand',
    label: 'Brand Manager',
    instructions: 'Define brand voice, visual identity guidelines, positioning, competitive differentiation, and messaging framework. Ensure consistency across all touchpoints. If you need competitor brand analysis, web_search for it. Make definitive branding decisions — pick specific colors, fonts, and tone rather than listing options.',
  },
];

const OPS_TEAM_PROMPTS = [
  {
    role: 'chief',
    label: 'Chief of Staff',
    instructions: 'Orchestrate the operations team: prioritize cost savings, performance improvements, and infrastructure decisions. Make all decisions autonomously — never suggest asking the user for approval. If you need pricing data or service comparisons, direct the team to research it with web_search. Take decisive action.',
  },
  {
    role: 'cost_monitor',
    label: 'Cost Monitor',
    instructions: 'Analyze current spending across API calls, cloud resources, and third-party services. Flag unexpected cost spikes, identify waste, and recommend budget allocation. Track cost-per-task and cost-per-user metrics. If you need current pricing or rate information, web_search for it. Produce concrete cost-saving actions, not just observations.',
  },
  {
    role: 'optimizer',
    label: 'Performance Optimizer',
    instructions: 'Identify performance bottlenecks, recommend caching strategies, suggest model size/quality tradeoffs, optimize token usage, and reduce latency. Propose batching, prompt compression, and model routing strategies to cut costs without sacrificing quality. If you need benchmark data or library comparisons, web_search for them. Implement optimizations directly — do not just suggest them.',
  },
  {
    role: 'infra_advisor',
    label: 'Infrastructure Advisor',
    instructions: 'Evaluate infrastructure decisions: when to use local models vs API, optimal hardware utilization, scaling strategies, monitoring and alerting setup, backup and reliability improvements. If you need cloud provider comparisons or hardware specs, web_search for current data. Make concrete infrastructure recommendations with specific services, configurations, and estimated costs.',
  },
];

// All agents: merge every team's roles (Chief of Staff appears once)
const ALL_TEAM_PROMPTS = [
  TEAM_PROMPTS[0], // Chief of Staff (shared)
  ...TEAM_PROMPTS.slice(1),
  ...MARKETING_TEAM_PROMPTS.filter((r) => r.role !== 'chief'),
  ...OPS_TEAM_PROMPTS.filter((r) => r.role !== 'chief'),
];

// Map teamMode values to their prompt sets
const TEAM_PRESET_MAP = {
  dev: TEAM_PROMPTS,
  teams: TEAM_PROMPTS,          // backward compat — "teams" === "dev"
  research: RESEARCH_TEAM_PROMPTS,
  marketing: MARKETING_TEAM_PROMPTS,
  ops: OPS_TEAM_PROMPTS,
  all: ALL_TEAM_PROMPTS,
};

// Display labels for the UI
const TEAM_MODE_LABELS = {
  all: 'All Agents',
  dev: 'Dev Team',
  research: 'Research Team',
  marketing: 'Marketing Team',
  ops: 'Ops & Cost Team',
  solo: 'Solo (no team)',
};

function teamPromptsForMode(teamMode) {
  return TEAM_PRESET_MAP[teamMode] || TEAM_PROMPTS;
}

const ALL_KNOWN_OWNERS = new Set([
  ...TEAM_OWNER_ORDER,
  ...MARKETING_TEAM_OWNER_ORDER,
  ...OPS_TEAM_OWNER_ORDER,
]);

function normalizeOwner(rawOwner) {
  const value = String(rawOwner || '').trim().toLowerCase();
  if (ALL_KNOWN_OWNERS.has(value)) {
    return value;
  }
  return '';
}

function inferOwnerFromAction(action, teamMode) {
  const intent = String(action.intent || '').toLowerCase();
  const tool = String(action.tool || '').toLowerCase();

  // Marketing-specific inference
  if (teamMode === 'marketing') {
    if (intent.includes('content') || intent.includes('blog') || intent.includes('seo')
        || intent.includes('editorial') || intent.includes('keyword')) return 'content_strategist';
    if (intent.includes('copy') || intent.includes('headline') || intent.includes('email')
        || intent.includes('landing page') || intent.includes('ad ')) return 'copywriter';
    if (intent.includes('social') || intent.includes('post') || intent.includes('tweet')
        || intent.includes('instagram') || intent.includes('tiktok')
        || intent.includes('linkedin') || intent.includes('community')) return 'social_media';
    if (intent.includes('analytics') || intent.includes('metric') || intent.includes('kpi')
        || intent.includes('funnel') || intent.includes('conversion') || intent.includes('growth')
        || intent.includes('a/b') || intent.includes('retention')) return 'growth';
    if (intent.includes('brand') || intent.includes('voice') || intent.includes('identity')
        || intent.includes('positioning') || intent.includes('messaging')) return 'brand';
    if (intent.includes('strategy') || intent.includes('go-to-market')) return 'content_strategist';
    if (intent.includes('orchestrate') || intent.includes('delegate')) return 'chief';
    return 'content_strategist';
  }

  // Ops-specific inference
  if (teamMode === 'ops') {
    if (intent.includes('cost') || intent.includes('spend') || intent.includes('budget')
        || intent.includes('billing') || intent.includes('price') || intent.includes('expense')) return 'cost_monitor';
    if (intent.includes('optim') || intent.includes('performance') || intent.includes('cache')
        || intent.includes('latency') || intent.includes('token') || intent.includes('batch')
        || intent.includes('compress')) return 'optimizer';
    if (intent.includes('infra') || intent.includes('scale') || intent.includes('monitor')
        || intent.includes('deploy') || intent.includes('hardware') || intent.includes('local model')) return 'infra_advisor';
    if (intent.includes('orchestrate') || intent.includes('delegate')) return 'chief';
    return 'cost_monitor';
  }

  // Dev team inference (default)
  if (
    intent.includes('research')
    || intent.includes('investigate')
    || intent.includes('benchmark')
    || intent.includes('compare options')
  ) {
    return 'research';
  }
  if (
    intent.includes('strategy')
    || intent.includes('go-to-market')
    || intent.includes('positioning')
    || intent.includes('roadmap strategy')
  ) {
    return 'strategist';
  }
  if (
    intent.includes('orchestrate')
    || intent.includes('delegate')
    || intent.includes('handoff')
    || intent.includes('chief of staff')
  ) {
    return 'chief';
  }
  if (
    tool === 'run_playwright'
    || intent.includes('qa')
    || intent.includes('test')
    || intent.includes('lint')
    || intent.includes('verify')
    || intent.includes('review')
  ) {
    return 'qa';
  }
  if (
    intent.includes('ux')
    || intent.includes('ui')
    || intent.includes('design')
    || intent.includes('copy')
    || intent.includes('style')
  ) {
    return 'design';
  }
  if (
    intent.includes('plan')
    || intent.includes('scope')
    || intent.includes('requirements')
    || intent.includes('milestone')
    || intent.includes('roadmap')
    || intent.includes('prioritize')
  ) {
    return 'product';
  }
  return 'engineering';
}

function ownerLabel(owner) {
  return TEAM_OWNER_LABELS[owner] || TEAM_OWNER_LABELS.engineering;
}

function ownerFromRoleToken(value) {
  const token = String(value || '').toLowerCase();
  if (token.includes('chief')) return 'chief';
  if (token.includes('strateg')) return 'strategist';
  if (token.includes('research')) return 'research';
  if (token.includes('product')) return 'product';
  if (token.includes('design')) return 'design';
  if (token.includes('qa') || token.includes('quality')) return 'qa';
  if (token.includes('engineer') || token.includes('developer') || token.includes('dev')) return 'engineering';
  // Marketing roles
  if (token.includes('content') && token.includes('strateg')) return 'content_strategist';
  if (token.includes('content')) return 'content_strategist';
  if (token.includes('copy') || token.includes('writer')) return 'copywriter';
  if (token.includes('social') || token.includes('media')) return 'social_media';
  if (token.includes('growth') || token.includes('analytics')) return 'growth';
  if (token.includes('brand')) return 'brand';
  // Ops roles
  if (token.includes('cost') || token.includes('monitor')) return 'cost_monitor';
  if (token.includes('optim') || token.includes('performance')) return 'optimizer';
  if (token.includes('infra')) return 'infra_advisor';
  return 'engineering';
}

function roleAllowedByObjectivePolicy(owner, policy) {
  if (!policy || (!policy.researchOnly && !policy.noBuild)) {
    return true;
  }
  return new Set(RESEARCH_TEAM_OWNER_ORDER).has(owner);
}

function applyObjectivePolicyToRoles(rolePrompts, policy) {
  if (!Array.isArray(rolePrompts) || rolePrompts.length === 0) {
    return [];
  }
  const filtered = rolePrompts.filter((role) => {
    const owner = ownerFromRoleToken(role.role || role.label || role.instructions);
    return roleAllowedByObjectivePolicy(owner, policy);
  });
  return filtered.length > 0 ? filtered : rolePrompts;
}

async function collectTeamBrief({
  settings,
  model,
  task,
  rootObjective = '',
  workspaceRoot,
  workspaceFiles,
  memoryNotes,
  skillNotes,
  agentProfiles = [],
  objectivePolicy = null,
  callGuards = null,
  onProgress = null,
  teamMode = 'dev',
  historySummary = '',
}) {
  const briefs = [];
  let currentModel = model;
  const policy = objectivePolicy || detectObjectivePolicy(rootObjective || task);
  const policyNotes = objectivePolicyPrompt(policy);
  const strictResearchTeam = policy.researchOnly || policy.noBuild;
  const baseRoles = teamPromptsForMode(teamMode);
  const sourceRoles = strictResearchTeam
    ? baseRoles
    : (Array.isArray(agentProfiles) && agentProfiles.length > 0
    ? agentProfiles.map((agent) => ({
      role: String(agent.name || 'agent').toLowerCase(),
      label: String(agent.name || 'Custom Agent'),
      instructions: String(agent.prompt || '').trim() || 'Execute your specialist perspective.',
    }))
    : baseRoles);
  const rolePrompts = applyObjectivePolicyToRoles(sourceRoles, policy);

  // -----------------------------------------------------------------------
  // Two-phase team activation:
  //   Phase 1 — Chief of Staff triages which roles are actually needed
  //   Phase 2 — Only activated roles produce briefs (in parallel)
  // This avoids wasting API calls on roles that produce unused planning.
  // -----------------------------------------------------------------------

  // Find the chief role (always runs first)
  const chiefRole = rolePrompts.find((r) => r.role === 'chief');
  const nonChiefRoles = rolePrompts.filter((r) => r.role !== 'chief');

  // If there are ≤3 roles total (e.g. research team), skip triage — brief them all
  if (rolePrompts.length <= 3 || !chiefRole) {
    return _briefAllRoles({
      rolePrompts, settings, model: currentModel, task, rootObjective,
      workspaceRoot, workspaceFiles, memoryNotes, skillNotes, policyNotes,
      strictResearchTeam, callGuards, onProgress, historySummary,
    });
  }

  // --- Phase 1: Chief triage ---
  const availableRoleList = nonChiefRoles.map((r) => `${r.role}: ${r.label}`).join('\n');

  if (typeof onProgress === 'function') {
    onProgress({
      type: 'team_brief_started',
      owner: 'chief',
      summary: 'Chief of Staff is selecting needed specialists.',
    });
  }

  const triagePrompt = [
    'Available specialist roles:',
    availableRoleList,
    '',
    `Objective: ${rootObjective || task}`,
    policyNotes ? `Policy: ${truncate(policyNotes, 200)}` : '',
    historySummary ? `Progress so far:\n${truncate(historySummary, 800)}` : '',
    '',
    'YOUR TASK: Select 2-4 roles needed for this objective. Return ONLY a JSON object:',
    '{ "selected_roles": ["role_id", ...], "brief": "4-8 bullet guidance" }',
    '',
    'RULES:',
    '- Coding task → engineering + qa. Add research only if investigation needed.',
    '- Research task → research + strategist.',
    '- Marketing task → 2-3 most relevant marketing roles.',
    '- Do NOT select roles just to be thorough.',
    '- Return ONLY the JSON. No explanation, no markdown, no preamble.',
  ].join('\n');

  let selectedRoleIds = [];
  let chiefBriefContent = '';

  try {
    const chiefResponse = await callResponsesWithFallback({
      settings,
      model: currentModel,
      callGuards,
      input: [
        { role: 'system', content: 'You are Chief of Staff. Return JSON only. No markdown.' },
        { role: 'user', content: triagePrompt },
      ],
      temperature: 0.1,
    });
    currentModel = chiefResponse.model || currentModel;
    const chiefText = stripThinkTags(extractOutputText(settings.provider, chiefResponse.payload) || '');

    // Parse the chief's triage response
    try {
      const jsonMatch = chiefText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.selected_roles)) {
          selectedRoleIds = parsed.selected_roles.map((r) => String(r).toLowerCase().trim());
        }
        chiefBriefContent = String(parsed.brief || '').trim();
      }
    } catch {
      // If JSON parsing fails, fall back to briefing all roles
      chiefBriefContent = chiefText;
    }

    if (typeof onProgress === 'function') {
      onProgress({
        type: 'team_brief',
        owner: 'chief',
        summary: truncate(chiefBriefContent || 'Chief of Staff triage complete.', 220),
      });
    }
  } catch (error) {
    if (typeof onProgress === 'function') {
      onProgress({
        type: 'team_brief_failed',
        owner: 'chief',
        summary: `Chief of Staff failed: ${truncate(String(error?.message || error || 'unknown error'), 180)}`,
      });
    }
    // If chief fails, fall back to briefing all roles
    return _briefAllRoles({
      rolePrompts, settings, model: currentModel, task, rootObjective,
      workspaceRoot, workspaceFiles, memoryNotes, skillNotes, policyNotes,
      strictResearchTeam, callGuards, onProgress, historySummary,
    });
  }

  // Add chief brief
  briefs.push({
    role: 'chief',
    label: 'Chief of Staff',
    content: truncate(chiefBriefContent, 1400),
  });

  // --- Phase 2: Brief only selected roles ---
  const validRoleIds = new Set(nonChiefRoles.map((r) => r.role));
  const activatedIds = selectedRoleIds.filter((id) => validRoleIds.has(id));

  // Fallback: if chief selected nothing valid, pick engineering + qa (dev) or first 2 roles
  if (activatedIds.length === 0) {
    if (teamMode === 'dev' || teamMode === 'teams') {
      activatedIds.push('engineering');
      if (validRoleIds.has('qa')) activatedIds.push('qa');
    } else {
      const fallbackRoles = nonChiefRoles.slice(0, 2).map((r) => r.role);
      activatedIds.push(...fallbackRoles);
    }
  }

  const activatedRoles = nonChiefRoles.filter((r) => activatedIds.includes(r.role));

  // Mark non-activated roles as skipped
  for (const role of nonChiefRoles) {
    if (!activatedIds.includes(role.role) && typeof onProgress === 'function') {
      const owner = ownerFromRoleToken(role.role || role.label);
      onProgress({
        type: 'team_brief_skipped',
        owner,
        summary: `${role.label} not needed for this objective.`,
      });
    }
  }

  // Brief activated roles in parallel
  const briefPromises = activatedRoles.map((role) => {
    const owner = ownerFromRoleToken(role.role || role.label);
    if (typeof onProgress === 'function') {
      onProgress({
        type: 'team_brief_started',
        owner,
        summary: `${role.label} is preparing guidance.`,
      });
    }

    // Keep context compact for local models — only essential info
    const compactFiles = workspaceFiles.slice(0, 40).map((entry) => `- ${entry}`).join('\n');
    const compactMemory = truncate(memoryNotes, 600);
    const compactSkills = truncate(skillNotes, 400);

    const prompt = [
      // Context block first (reference only)
      '--- CONTEXT (reference only, do NOT summarize) ---',
      `Objective: ${rootObjective || task}`,
      `Iteration context: ${task}`,
      policyNotes ? `Policy: ${truncate(policyNotes, 300)}` : '',
      `Workspace: ${workspaceRoot}`,
      `Key files:\n${compactFiles}`,
      compactMemory !== 'No prior memory captured for this project yet.' ? `Memory notes:\n${compactMemory}` : '',
      compactSkills ? `Skills: ${compactSkills}` : '',
      historySummary ? `Progress so far:\n${truncate(historySummary, 1000)}` : '',
      '--- END CONTEXT ---',
      '',
      // Directive last so it's freshest in the model's attention
      `YOU ARE: ${role.label}`,
      `YOUR ROLE: ${role.instructions}`,
      strictResearchTeam
        ? 'CONSTRAINT: This is a research-only run. No coding or infrastructure.'
        : '',
      '',
      'YOUR TASK: Write 4-8 bullet points of concrete, actionable guidance for this objective.',
      'RULES:',
      '- Output ONLY your bullet points. No headers, no summaries, no preamble.',
      '- Do NOT summarize the context above. Use it as reference to inform your bullets.',
      '- Do NOT repeat work shown in "Progress so far". Only suggest NEW actions.',
      '- Each bullet must be a specific, actionable recommendation.',
      '- Be direct and concise. No filler.',
    ].join('\n');

    return callResponsesWithFallback({
      settings,
      model: currentModel,
      callGuards,
      input: [
        {
          role: 'system',
          content: `You are ${role.label}. Output ONLY bullet points. Never summarize the context.`,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.2,
    }).then((response) => {
      const brief = {
        role: role.role,
        label: role.label,
        content: truncate(stripThinkTags(extractOutputText(settings.provider, response.payload)), 1400),
      };
      if (typeof onProgress === 'function') {
        onProgress({
          type: 'team_brief',
          owner,
          summary: truncate(brief.content || `${role.label} brief ready.`, 220),
        });
      }
      return { brief, model: response.model };
    }).catch((error) => {
      if (typeof onProgress === 'function') {
        onProgress({
          type: 'team_brief_failed',
          owner,
          summary: `${role.label} failed: ${truncate(String(error?.message || error || 'unknown error'), 180)}`,
        });
      }
      throw error;
    });
  });

  const briefResults = await Promise.all(briefPromises);
  for (const result of briefResults) {
    briefs.push(result.brief);
    currentModel = result.model || currentModel;
  }

  const summary = briefs.map((item) => `${item.label}:\n${item.content}`).join('\n\n');
  return {
    model: currentModel,
    briefs,
    summary,
  };
}

// ---------------------------------------------------------------------------
// _briefAllRoles — fallback: brief every role in parallel (used for small teams
// or when chief triage fails)
// ---------------------------------------------------------------------------
async function _briefAllRoles({
  rolePrompts, settings, model, task, rootObjective,
  workspaceRoot, workspaceFiles, memoryNotes, skillNotes, policyNotes,
  strictResearchTeam, callGuards, onProgress, historySummary = '',
}) {
  const briefs = [];
  let currentModel = model;

  const briefPromises = rolePrompts.map((role, index) => {
    const owner = ownerFromRoleToken(role.role || role.label);
    if (typeof onProgress === 'function') {
      onProgress({
        type: 'team_brief_started',
        owner,
        summary: `${role.label} is preparing guidance (${index + 1}/${rolePrompts.length}).`,
      });
    }

    // Keep context compact for local models — only essential info
    const compactFiles = workspaceFiles.slice(0, 40).map((entry) => `- ${entry}`).join('\n');
    const compactMemory = truncate(memoryNotes, 600);
    const compactSkills = truncate(skillNotes, 400);

    const prompt = [
      // Context block first (reference only)
      '--- CONTEXT (reference only, do NOT summarize) ---',
      `Objective: ${rootObjective || task}`,
      `Iteration context: ${task}`,
      policyNotes ? `Policy: ${truncate(policyNotes, 300)}` : '',
      `Workspace: ${workspaceRoot}`,
      `Key files:\n${compactFiles}`,
      compactMemory !== 'No prior memory captured for this project yet.' ? `Memory notes:\n${compactMemory}` : '',
      compactSkills ? `Skills: ${compactSkills}` : '',
      historySummary ? `Progress so far:\n${truncate(historySummary, 1000)}` : '',
      '--- END CONTEXT ---',
      '',
      // Directive last so it's freshest in the model's attention
      `YOU ARE: ${role.label}`,
      `YOUR ROLE: ${role.instructions}`,
      strictResearchTeam
        ? 'CONSTRAINT: This is a research-only run. No coding or infrastructure.'
        : '',
      (strictResearchTeam && owner === 'chief')
        ? 'Chief rule: delegate only to Strategist and Research Lead.'
        : '',
      '',
      'YOUR TASK: Write 4-8 bullet points of concrete, actionable guidance for this objective.',
      'RULES:',
      '- Output ONLY your bullet points. No headers, no summaries, no preamble.',
      '- Do NOT summarize the context above. Use it as reference to inform your bullets.',
      '- Do NOT repeat work shown in "Progress so far". Only suggest NEW actions.',
      '- Each bullet must be a specific, actionable recommendation.',
      '- Be direct and concise. No filler.',
    ].join('\n');

    return callResponsesWithFallback({
      settings,
      model: currentModel,
      callGuards,
      input: [
        {
          role: 'system',
          content: `You are ${role.label}. Output ONLY bullet points. Never summarize the context.`,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.2,
    }).then((response) => {
      const brief = {
        role: role.role,
        label: role.label,
        content: truncate(stripThinkTags(extractOutputText(settings.provider, response.payload)), 1400),
      };
      if (typeof onProgress === 'function') {
        onProgress({
          type: 'team_brief',
          owner,
          summary: truncate(brief.content || `${role.label} brief ready.`, 220),
        });
      }
      return { brief, model: response.model };
    }).catch((error) => {
      if (typeof onProgress === 'function') {
        onProgress({
          type: 'team_brief_failed',
          owner,
          summary: `${role.label} failed: ${truncate(String(error?.message || error || 'unknown error'), 180)}`,
        });
      }
      throw error;
    });
  });

  const briefResults = await Promise.all(briefPromises);
  for (const result of briefResults) {
    briefs.push(result.brief);
    currentModel = result.model || currentModel;
  }

  const summary = briefs.map((item) => `${item.label}:\n${item.content}`).join('\n\n');
  return {
    model: currentModel,
    briefs,
    summary,
  };
}

module.exports = {
  TEAM_OWNER_LABELS,
  TEAM_PROMPTS,
  MARKETING_TEAM_PROMPTS,
  OPS_TEAM_PROMPTS,
  TEAM_PRESET_MAP,
  TEAM_MODE_LABELS,
  teamPromptsForMode,
  normalizeOwner,
  inferOwnerFromAction,
  ownerLabel,
  ownerFromRoleToken,
  roleAllowedByObjectivePolicy,
  applyObjectivePolicyToRoles,
  collectTeamBrief,
};
