'use strict';

const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');

const { truncate } = require('./utils');
const { wordsForMatch, objectiveOverlapScore } = require('./objective-policy');
const { normalizeWorkspaceRoot, DEFAULT_WORKSPACE_ROOT } = require('./settings');

const AUTO_SEARCH_SUBDIRS = ['Desktop', 'Documents', 'Downloads', 'Projects', 'Developer', 'Code', 'Repos'];

// Global skills directory — business playbooks that apply across all workspaces
const GLOBAL_SKILLS_DIR = path.join(os.homedir(), '.geepus', 'skills');
const AUTO_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  '.build',
  'Library',
  'Applications',
  '.Trash',
  '.cache',
  '.venv',
  'venv',
]);
const PROJECT_MARKER_FILES = ['package.json', 'pyproject.toml', 'Package.swift', '.git', 'index.html'];

function resolveWorkspaceRoot(workspaceRoot) {
  const resolved = path.resolve(normalizeWorkspaceRoot(workspaceRoot));
  if (!fsSync.existsSync(resolved)) {
    throw new Error(`Workspace folder not found: ${resolved}`);
  }
  const stat = fsSync.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Workspace must be a folder: ${resolved}`);
  }
  return resolved;
}

function isSensitivePath(absolutePath) {
  const lower = absolutePath.toLowerCase();
  const blockedParts = [
    `${path.sep}.ssh${path.sep}`,
    `${path.sep}.aws${path.sep}`,
    `${path.sep}.gnupg${path.sep}`,
    `${path.sep}library${path.sep}keychains${path.sep}`,
    `${path.sep}private${path.sep}var${path.sep}db${path.sep}`,
  ];
  return blockedParts.some((segment) => lower.includes(segment));
}

function resolveWorkspacePath(workspaceRoot, requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
    throw new Error('Missing file path.');
  }

  const target = requestedPath.trim();
  const absolute = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(workspaceRoot, target);

  if (!(absolute === workspaceRoot || absolute.startsWith(`${workspaceRoot}${path.sep}`))) {
    throw new Error(`Path is outside workspace: ${target}`);
  }

  if (isSensitivePath(absolute)) {
    throw new Error(`Path blocked by policy: ${target}`);
  }

  return absolute;
}

async function listWorkspaceFiles(root, maxDepth = 3, maxItems = 300) {
  const ignore = new Set(['.git', 'node_modules', 'dist', '.build', '.next', 'DerivedData']);
  const output = [];

  async function walk(current, depth) {
    if (output.length >= maxItems || depth > maxDepth) {
      return;
    }
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (output.length >= maxItems) {
        return;
      }
      if (ignore.has(entry.name)) {
        continue;
      }
      if (entry.name.startsWith('.') && entry.name !== '.claude' && entry.name !== '.geepus') {
        continue;
      }

      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute) || '.';
      output.push(entry.isDirectory() ? `${relative}/` : relative);

      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
      }
    }
  }

  await walk(root, 0);
  return output;
}

function isHomeWorkspace(candidate) {
  try {
    return path.resolve(String(candidate || '')) === path.resolve(DEFAULT_WORKSPACE_ROOT);
  } catch {
    return false;
  }
}

function scoreProjectForObjective(project, objective) {
  const objectiveWords = wordsForMatch(objective);
  if (objectiveWords.length === 0) {
    return 0;
  }
  const haystack = `${project.label} ${project.lastObjective} ${project.artifactPaths.join(' ')}`;
  const score = objectiveOverlapScore(haystack, objectiveWords);
  if (objectiveWords.length >= 2 && score < 2) {
    return 0;
  }
  if (String(project.lastStatus || '').toLowerCase() === 'completed') {
    return score + 1;
  }
  return score;
}

function pickWorkspaceFromGlobalMemory(globalMemory, objective) {
  const projects = Array.isArray(globalMemory.projects) ? globalMemory.projects : [];
  const ranked = projects
    .map((project) => ({
      project,
      score: scoreProjectForObjective(project, objective),
    }))
    .filter((item) => item.score >= 2 && fsSync.existsSync(item.project.workspaceRoot))
    .sort((left, right) => right.score - left.score);

  if (ranked.length > 0) {
    return ranked[0].project.workspaceRoot;
  }
  const active = String(globalMemory.activeWorkspaceRoot || '').trim();
  if (active && fsSync.existsSync(active)) {
    return active;
  }
  return '';
}

function buildDiscoveryTerms(objective) {
  const words = wordsForMatch(objective);
  const terms = new Set(words);
  const text = String(objective || '').toLowerCase();
  if (text.includes('snake')) {
    terms.add('snake');
  }
  if (text.includes('game')) {
    terms.add('game');
  }
  if (text.includes('web')) {
    terms.add('web');
    terms.add('html');
  }
  return Array.from(terms).slice(0, 10);
}

function isRelevantFileForObjective(fileNameLower, terms) {
  const allowedExt = ['.html', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.py', '.swift'];
  const hasInterestingExt = allowedExt.some((ext) => fileNameLower.endsWith(ext));
  if (!hasInterestingExt) {
    return false;
  }
  return terms.some((term) => fileNameLower.includes(term));
}

function findNearestProjectRoot(startPath) {
  let current = path.dirname(startPath);
  for (let steps = 0; steps < 6; steps += 1) {
    try {
      const entries = new Set(fsSync.readdirSync(current));
      if (PROJECT_MARKER_FILES.some((marker) => entries.has(marker))) {
        return current;
      }
    } catch {
      // Ignore unreadable directories.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return path.dirname(startPath);
}

async function discoverObjectiveArtifacts({
  objective,
  maxResults = 30,
  maxDirs = 1200,
  maxDepth = 4,
}) {
  const terms = buildDiscoveryTerms(objective);
  if (terms.length === 0) {
    return { discoveredPaths: [], suggestedWorkspace: '' };
  }

  const roots = [DEFAULT_WORKSPACE_ROOT];
  for (const sub of AUTO_SEARCH_SUBDIRS) {
    const candidate = path.join(DEFAULT_WORKSPACE_ROOT, sub);
    if (fsSync.existsSync(candidate) && fsSync.statSync(candidate).isDirectory()) {
      roots.unshift(candidate);
    }
  }

  const queue = roots.map((root) => ({ absolute: root, depth: 0 }));
  const discovered = [];
  let visitedDirs = 0;

  while (queue.length > 0 && visitedDirs < maxDirs && discovered.length < maxResults) {
    const current = queue.shift();
    visitedDirs += 1;

    let entries = [];
    try {
      entries = await fs.readdir(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const nameLower = entry.name.toLowerCase();
      const absolute = path.join(current.absolute, entry.name);

      if (entry.isDirectory()) {
        if (AUTO_IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        if (terms.some((term) => nameLower.includes(term))) {
          discovered.push(absolute);
          if (discovered.length >= maxResults) {
            break;
          }
        }
        if (current.depth < maxDepth) {
          queue.push({ absolute, depth: current.depth + 1 });
        }
        continue;
      }

      if (entry.isFile() && isRelevantFileForObjective(nameLower, terms)) {
        discovered.push(absolute);
        if (discovered.length >= maxResults) {
          break;
        }
      }
    }
  }

  const unique = Array.from(new Set(discovered)).slice(0, maxResults);
  const workspace = unique.length > 0 ? findNearestProjectRoot(unique[0]) : '';
  return {
    discoveredPaths: unique,
    suggestedWorkspace: workspace,
  };
}

function collectKnownPathsForObjective(globalMemory, objective, workspaceRoot) {
  const objectiveWords = new Set(wordsForMatch(objective));
  const projects = Array.isArray(globalMemory.projects) ? globalMemory.projects : [];
  const ranked = [];

  for (const project of projects) {
    const haystack = `${project.label} ${project.lastObjective} ${project.artifactPaths.join(' ')}`.toLowerCase();
    let score = 0;
    for (const word of objectiveWords) {
      if (haystack.includes(word)) {
        score += 1;
      }
    }
    if (project.workspaceRoot === workspaceRoot) {
      score += 3;
    }
    if (score > 0) {
      ranked.push({ project, score });
    }
  }

  ranked.sort((left, right) => right.score - left.score);
  const top = ranked.slice(0, 3).map((entry) => entry.project);
  const paths = [];
  for (const project of top) {
    for (const artifact of project.artifactPaths.slice(-20)) {
      const raw = String(artifact || '').trim();
      if (!raw) {
        continue;
      }
      if (path.isAbsolute(raw)) {
        paths.push(raw);
      } else {
        paths.push(path.join(project.workspaceRoot, raw));
      }
    }
  }
  return Array.from(new Set(paths)).slice(0, 20);
}

async function chooseWorkspaceAndHints({
  objective,
  requestedWorkspace,
  globalMemory,
}) {
  const direct = String(requestedWorkspace || '').trim();
  if (direct && fsSync.existsSync(direct)) {
    let directRoot = direct;
    try {
      const stat = fsSync.statSync(direct);
      if (stat.isFile()) {
        directRoot = path.dirname(direct);
      }
    } catch {
      // Keep direct value.
    }
    return {
      workspaceRoot: directRoot,
      discoveredPaths: [],
      source: 'requested',
    };
  }

  const memoryWorkspace = pickWorkspaceFromGlobalMemory(globalMemory, objective);
  if (memoryWorkspace) {
    let memoryRoot = memoryWorkspace;
    try {
      const stat = fsSync.statSync(memoryWorkspace);
      if (stat.isFile()) {
        memoryRoot = path.dirname(memoryWorkspace);
      }
    } catch {
      // Keep memory value.
    }
    return {
      workspaceRoot: memoryRoot,
      discoveredPaths: collectKnownPathsForObjective(globalMemory, objective, memoryRoot),
      source: 'memory',
    };
  }

  const discovery = await discoverObjectiveArtifacts({ objective });
  if (discovery.suggestedWorkspace && fsSync.existsSync(discovery.suggestedWorkspace)) {
    return {
      workspaceRoot: discovery.suggestedWorkspace,
      discoveredPaths: discovery.discoveredPaths,
      source: 'auto-discovery',
    };
  }

  return {
    workspaceRoot: DEFAULT_WORKSPACE_ROOT,
    discoveredPaths: [],
    source: 'fallback-home',
  };
}

async function findSkillMarkdownFiles(rootDir, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) {
    return [];
  }

  let entries = [];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const output = [];
  for (const entry of entries) {
    const absolute = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findSkillMarkdownFiles(absolute, depth + 1, maxDepth);
      output.push(...nested);
      continue;
    }

    const lower = entry.name.toLowerCase();
    if (lower === 'skill.md' || lower.endsWith('.skill.md') || lower.endsWith('.md')) {
      output.push(absolute);
    }
  }
  return output;
}

async function loadProjectSkills(workspaceRoot, limit = 10) {
  const roots = [
    GLOBAL_SKILLS_DIR, // global business skills (always searched)
  ];
  // Only add workspace-local skill dirs when a valid workspaceRoot is provided.
  if (workspaceRoot) {
    roots.unshift(
      path.join(workspaceRoot, '.claude', 'skills'),
      path.join(workspaceRoot, '.geepus', 'skills'),
      path.join(workspaceRoot, 'skills'),
    );
  }
  const files = [];
  for (const root of roots) {
    const matches = await findSkillMarkdownFiles(root, 0, 3);
    files.push(...matches);
  }

  const unique = Array.from(new Set(files)).slice(0, limit);
  const skills = [];
  for (const file of unique) {
    try {
      const content = await fs.readFile(file, 'utf8');
      const preview = content.split('\n').slice(0, 16).join('\n').trim();
      // Use absolute path for skills outside the workspace (e.g., global skills),
      // relative path for workspace-local skills.
      const relativePath = workspaceRoot ? path.relative(workspaceRoot, file) : '..';
      const skillPath = relativePath.startsWith('..') ? file : relativePath;
      skills.push({
        name: path.basename(path.dirname(file)),
        path: skillPath,
        preview: truncate(preview, 800),
      });
    } catch {
      // Ignore unreadable skill files.
    }
  }

  return skills;
}

async function loadProjectAgents(workspaceRoot, limit = 8) {
  const roots = [
    path.join(workspaceRoot, '.claude', 'agents'),
    path.join(workspaceRoot, '.geepus', 'agents'),
  ];
  const files = [];
  for (const root of roots) {
    const matches = await findSkillMarkdownFiles(root, 0, 3);
    files.push(...matches);
  }

  const unique = Array.from(new Set(files)).slice(0, limit);
  const agents = [];
  for (const file of unique) {
    try {
      const content = await fs.readFile(file, 'utf8');
      const preview = content.split('\n').slice(0, 16).join('\n').trim();
      agents.push({
        name: path.basename(file, path.extname(file)),
        path: path.relative(workspaceRoot, file),
        prompt: truncate(preview, 800),
      });
    } catch {
      // Ignore unreadable agent files.
    }
  }
  return agents;
}

function toSkillPrompt(skills) {
  if (!Array.isArray(skills) || skills.length === 0) {
    return '';
  }
  return [
    'SKILLS — playbooks for common task types. The agent reads the full file for step-by-step guidance and completion criteria.',
    ...skills.map((skill) => {
      const preview = (skill.preview || '').trim().slice(0, 400);
      return `\n### ${skill.name}\nPath: ${skill.path}\n${preview}`;
    }),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// extractCompletionCriteria
// ---------------------------------------------------------------------------

function extractCompletionCriteria(content) {
  const lines = String(content || '').split('\n');
  const startIdx = lines.findIndex((l) => /^#{1,3}\s+completion criteria/i.test(l));
  if (startIdx < 0) return '';
  const endIdx = lines.findIndex((l, i) => i > startIdx && /^#{1,3}\s+/.test(l));
  return (endIdx < 0 ? lines.slice(startIdx) : lines.slice(startIdx, endIdx)).join('\n').trim();
}

// ---------------------------------------------------------------------------
// findBestSkillForObjective
// ---------------------------------------------------------------------------

async function findBestSkillForObjective(objective, workspaceRoot) {
  if (!objective) return null;
  const skills = await loadProjectSkills(workspaceRoot, 30).catch(() => []);
  if (skills.length === 0) return null;

  const objWords = new Set(wordsForMatch(objective));

  // Score every skill; collect candidates above a minimum overlap.
  const candidates = [];
  for (const skill of skills) {
    const skillText = [skill.name, skill.preview || ''].join(' ');
    const skillWords = wordsForMatch(skillText);
    const overlap = skillWords.filter((w) => objWords.has(w)).length;
    if (overlap === 0) continue;
    const rawScore = overlap / Math.max(1, Math.sqrt(objWords.size * skillWords.length));

    // ── Breadth bonus / specificity penalty ──────────────────────────
    // Prefer broad-category skills (short names like "Web Development")
    // over hyper-specific ones ("Build and Launch a Simple Revenue-
    // Generating Business Website").
    const nameWordCount = skill.name.split(/[^a-z0-9]+/gi).filter(Boolean).length;
    // Broad skills (1-3 words) get a bonus; specific skills (>5 words) get penalised.
    const breadthFactor = nameWordCount <= 3 ? 1.5
      : nameWordCount <= 5 ? 1.0
      : 0.5;

    // ── Scope-mismatch penalty ───────────────────────────────────────
    // If the skill name introduces concepts absent from the objective
    // (e.g. "revenue", "monetization") the skill is probably too opinionated.
    const nameWords = wordsForMatch(skill.name);
    const extraWords = nameWords.filter((w) => !objWords.has(w)).length;
    const scopePenalty = extraWords > 3 ? 0.6 : 1.0;

    const score = rawScore * breadthFactor * scopePenalty;
    candidates.push({ skill, score, overlap });
  }

  if (candidates.length === 0) return null;

  // Sort by score descending, pick best.
  candidates.sort((a, b) => b.score - a.score);
  const { skill: bestSkill, score: bestScore, overlap: bestOverlap } = candidates[0];

  // Avoid loading unrelated skills that can push the planner off-track.
  const minScore = objWords.size >= 4 ? 0.12 : 0.16;
  const minOverlap = objWords.size >= 4 ? 2 : 1;
  if (bestScore < minScore || bestOverlap < minOverlap) return null;

  // Load full SKILL.md
  try {
    const fullPath = path.isAbsolute(bestSkill.path)
      ? bestSkill.path
      : path.join(workspaceRoot, bestSkill.path);
    const content = await fs.readFile(fullPath, 'utf8');
    return {
      ...bestSkill,
      content,
      completionCriteria: extractCompletionCriteria(content),
    };
  } catch {
    return {
      ...bestSkill,
      content: bestSkill.preview || '',
      completionCriteria: '',
    };
  }
}

// ---------------------------------------------------------------------------
// saveGlobalSkill
// ---------------------------------------------------------------------------

async function saveGlobalSkill(name, markdownContent) {
  const slug = String(name || 'skill')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60) || 'skill';
  const dir = path.join(GLOBAL_SKILLS_DIR, slug);
  await fs.mkdir(dir, { recursive: true });
  const skillPath = path.join(dir, 'SKILL.md');
  await fs.writeFile(skillPath, markdownContent, 'utf8');
  return skillPath;
}

module.exports = {
  GLOBAL_SKILLS_DIR,
  AUTO_SEARCH_SUBDIRS,
  AUTO_IGNORED_DIRS,
  PROJECT_MARKER_FILES,
  resolveWorkspaceRoot,
  isSensitivePath,
  resolveWorkspacePath,
  listWorkspaceFiles,
  isHomeWorkspace,
  scoreProjectForObjective,
  pickWorkspaceFromGlobalMemory,
  buildDiscoveryTerms,
  isRelevantFileForObjective,
  findNearestProjectRoot,
  discoverObjectiveArtifacts,
  collectKnownPathsForObjective,
  chooseWorkspaceAndHints,
  findSkillMarkdownFiles,
  loadProjectSkills,
  loadProjectAgents,
  toSkillPrompt,
  extractCompletionCriteria,
  findBestSkillForObjective,
  saveGlobalSkill,
};
