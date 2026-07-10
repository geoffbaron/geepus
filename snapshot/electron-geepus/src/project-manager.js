'use strict';

/**
 * project-manager.js — Multi-project manager with tech stack detection,
 * health tracking, and cross-project overview.
 *
 * Builds on the existing global memory project list, enriching each project
 * with auto-detected tech stack info, run statistics, and status indicators.
 *
 * Depends on: memory.js (readGlobalMemory, writeGlobalMemory)
 *             run-state.js (listRunStates, summarizeRunForList)
 *             token-tracker.js (getRunCostDetails)
 */

const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { app } = require('electron');

const { readGlobalMemory, writeGlobalMemory, readProjectMemory } = require('./memory');
const { listRunStates, summarizeRunForList } = require('./run-state');
const { getRunCostDetails } = require('./token-tracker');

// ---------------------------------------------------------------------------
// Tech stack detection
// ---------------------------------------------------------------------------

const TECH_INDICATORS = [
  { file: 'package.json',       tech: 'Node.js',   icon: '📦' },
  { file: 'tsconfig.json',      tech: 'TypeScript', icon: '🔷' },
  { file: 'Cargo.toml',         tech: 'Rust',       icon: '🦀' },
  { file: 'go.mod',             tech: 'Go',         icon: '🐹' },
  { file: 'requirements.txt',   tech: 'Python',     icon: '🐍' },
  { file: 'Pipfile',            tech: 'Python',     icon: '🐍' },
  { file: 'pyproject.toml',     tech: 'Python',     icon: '🐍' },
  { file: 'setup.py',           tech: 'Python',     icon: '🐍' },
  { file: 'Gemfile',            tech: 'Ruby',       icon: '💎' },
  { file: 'Package.swift',      tech: 'Swift',      icon: '🍏' },
  { file: 'pom.xml',            tech: 'Java',       icon: '☕' },
  { file: 'build.gradle',       tech: 'Java/Kotlin',icon: '🏗️' },
  { file: 'CMakeLists.txt',     tech: 'C/C++',      icon: '⚙️' },
  { file: 'Makefile',           tech: 'Make',        icon: '🔨' },
  { file: 'Dockerfile',         tech: 'Docker',      icon: '🐳' },
  { file: 'docker-compose.yml', tech: 'Docker',      icon: '🐳' },
  { file: '.github/workflows',  tech: 'GitHub Actions', icon: '🔄' },
  { file: 'next.config.js',     tech: 'Next.js',    icon: '▲' },
  { file: 'next.config.mjs',    tech: 'Next.js',    icon: '▲' },
  { file: 'vite.config.js',     tech: 'Vite',       icon: '⚡' },
  { file: 'vite.config.ts',     tech: 'Vite',       icon: '⚡' },
  { file: 'webpack.config.js',  tech: 'Webpack',     icon: '📦' },
  { file: 'tailwind.config.js', tech: 'Tailwind',    icon: '🎨' },
  { file: '.env',               tech: 'dotenv',      icon: '🔐' },
  { file: 'playwright.config.ts', tech: 'Playwright', icon: '🎭' },
  { file: 'jest.config.js',     tech: 'Jest',        icon: '🧪' },
  { file: 'vitest.config.ts',   tech: 'Vitest',      icon: '🧪' },
];

/**
 * Detect tech stack from files in the workspace root.
 * Returns an array of { tech, icon } objects (deduped by tech name).
 */
function detectTechStack(workspaceRoot) {
  if (!workspaceRoot || !fsSync.existsSync(workspaceRoot)) return [];

  const found = [];
  const seen = new Set();

  for (const indicator of TECH_INDICATORS) {
    const fullPath = path.join(workspaceRoot, indicator.file);
    if (fsSync.existsSync(fullPath)) {
      if (!seen.has(indicator.tech)) {
        seen.add(indicator.tech);
        found.push({ tech: indicator.tech, icon: indicator.icon });
      }
    }
  }

  return found;
}

/**
 * Read package.json scripts (if present) for quick-action suggestions.
 */
function readAvailableScripts(workspaceRoot) {
  try {
    const pkgPath = path.join(workspaceRoot, 'package.json');
    if (!fsSync.existsSync(pkgPath)) return [];
    const pkg = JSON.parse(fsSync.readFileSync(pkgPath, 'utf8'));
    if (!pkg.scripts || typeof pkg.scripts !== 'object') return [];
    return Object.keys(pkg.scripts).slice(0, 20);
  } catch {
    return [];
  }
}

/**
 * Read Makefile targets (if present).
 */
function readMakeTargets(workspaceRoot) {
  try {
    const makePath = path.join(workspaceRoot, 'Makefile');
    if (!fsSync.existsSync(makePath)) return [];
    const content = fsSync.readFileSync(makePath, 'utf8');
    const targets = [];
    for (const match of content.matchAll(/^([a-zA-Z_][\w-]*):/gm)) {
      if (!match[1].startsWith('_') && match[1] !== 'FORCE') {
        targets.push(match[1]);
      }
    }
    return [...new Set(targets)].slice(0, 20);
  } catch {
    return [];
  }
}

/**
 * Count files in a directory (non-recursive, just top-level + 1 depth).
 */
function countProjectFiles(workspaceRoot) {
  try {
    if (!fsSync.existsSync(workspaceRoot)) return 0;
    const entries = fsSync.readdirSync(workspaceRoot, { withFileTypes: true });
    let count = entries.filter((e) => e.isFile()).length;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        try {
          const sub = fsSync.readdirSync(path.join(workspaceRoot, entry.name));
          count += sub.length;
        } catch { /* skip */ }
      }
    }
    return count;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Project enrichment
// ---------------------------------------------------------------------------

/**
 * Enrich a project entry from global memory with tech stack, scripts, and health data.
 */
async function enrichProject(project, runs = []) {
  const root = project.workspaceRoot;
  const exists = fsSync.existsSync(root);

  const techStack = exists ? detectTechStack(root) : [];
  const scripts = exists ? readAvailableScripts(root) : [];
  const makeTargets = exists ? readMakeTargets(root) : [];
  const fileCount = exists ? countProjectFiles(root) : 0;

  // Gather run stats for this project
  const projectRuns = runs.filter((r) => r.workspaceRoot === root);
  const completedRuns = projectRuns.filter((r) => r.state === 'completed');
  const failedRuns = projectRuns.filter((r) => r.state === 'stopped');
  const lastRun = projectRuns[0] || null;

  // Calculate total cost across all project runs
  let totalCost = 0;
  for (const run of projectRuns.slice(0, 50)) {
    try {
      const costData = await getRunCostDetails(run.runId);
      if (costData && costData.totalCost) {
        totalCost += costData.totalCost;
      }
    } catch { /* skip */ }
  }

  return {
    ...project,
    exists,
    techStack,
    scripts,
    makeTargets,
    fileCount,
    runStats: {
      total: projectRuns.length,
      completed: completedRuns.length,
      failed: failedRuns.length,
      lastRunId: lastRun?.runId || null,
      lastRunState: lastRun?.state || null,
      lastRunDate: lastRun?.updatedAt || lastRun?.startedAt || null,
    },
    totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
    name: path.basename(root) || project.label || 'Unknown',
  };
}

// ---------------------------------------------------------------------------
// Project CRUD
// ---------------------------------------------------------------------------

/**
 * List all tracked projects with enrichment.
 */
async function listProjects() {
  const globalMemory = await readGlobalMemory();
  const runs = await listRunStates(200);
  const summarized = runs.map(summarizeRunForList);

  const projects = [];
  for (const project of globalMemory.projects) {
    const enriched = await enrichProject(project, summarized);
    projects.push(enriched);
  }

  return {
    projects,
    activeWorkspaceRoot: globalMemory.activeWorkspaceRoot || '',
  };
}

/**
 * Add or update a project in the global memory.
 */
async function addProject(workspaceRoot, label) {
  const root = path.resolve(workspaceRoot);
  if (!fsSync.existsSync(root)) {
    throw new Error(`Folder does not exist: ${root}`);
  }

  const globalMemory = await readGlobalMemory();
  const existing = globalMemory.projects.findIndex((p) => p.workspaceRoot === root);

  const entry = {
    workspaceRoot: root,
    label: label || path.basename(root),
    lastObjective: '',
    lastStatus: 'added',
    artifactPaths: [],
    updatedAt: new Date().toISOString(),
  };

  if (existing >= 0) {
    globalMemory.projects[existing] = {
      ...globalMemory.projects[existing],
      label: label || globalMemory.projects[existing].label,
      updatedAt: new Date().toISOString(),
    };
  } else {
    globalMemory.projects.push(entry);
  }

  await writeGlobalMemory(globalMemory);
  return entry;
}

/**
 * Remove a project from the global memory (does NOT delete files).
 */
async function removeProject(workspaceRoot) {
  const globalMemory = await readGlobalMemory();
  globalMemory.projects = globalMemory.projects.filter((p) => p.workspaceRoot !== workspaceRoot);
  await writeGlobalMemory(globalMemory);
  return { ok: true };
}

/**
 * Update a project's label or notes.
 */
async function updateProject(workspaceRoot, patch) {
  const globalMemory = await readGlobalMemory();
  const index = globalMemory.projects.findIndex((p) => p.workspaceRoot === workspaceRoot);
  if (index < 0) {
    throw new Error(`Project not found: ${workspaceRoot}`);
  }

  if (patch.label) {
    globalMemory.projects[index].label = String(patch.label).trim();
  }
  globalMemory.projects[index].updatedAt = new Date().toISOString();

  await writeGlobalMemory(globalMemory);
  return globalMemory.projects[index];
}

/**
 * Set the active workspace root (used for workspace switching).
 */
async function setActiveProject(workspaceRoot) {
  const globalMemory = await readGlobalMemory();
  globalMemory.activeWorkspaceRoot = workspaceRoot;
  await writeGlobalMemory(globalMemory);
  return { ok: true, activeWorkspaceRoot: workspaceRoot };
}

/**
 * Get detailed info for a single project.
 */
async function getProjectDetail(workspaceRoot) {
  const globalMemory = await readGlobalMemory();
  const project = globalMemory.projects.find((p) => p.workspaceRoot === workspaceRoot);
  if (!project) return null;

  const runs = await listRunStates(200);
  const summarized = runs.map(summarizeRunForList);
  const enriched = await enrichProject(project, summarized);

  // Also include project memory (notes, recent objectives)
  const memory = await readProjectMemory(workspaceRoot);

  return {
    ...enriched,
    memory: {
      notes: memory.notes.slice(-20),
      recentObjectives: memory.recentObjectives.slice(-10),
      artifactPaths: memory.artifactPaths.slice(-40),
    },
    recentRuns: summarized
      .filter((r) => r.workspaceRoot === workspaceRoot)
      .slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  detectTechStack,
  readAvailableScripts,
  readMakeTargets,
  countProjectFiles,
  enrichProject,
  listProjects,
  addProject,
  removeProject,
  updateProject,
  setActiveProject,
  getProjectDetail,
};
