'use strict';

const path = require('path');
const fs = require('fs/promises');
const { app } = require('electron');

const { ensureObject } = require('./utils');
const { sha256 } = require('./audit');
const { wordsForMatch, objectiveOverlapScore, detectObjectivePolicy } = require('./objective-policy');

const MEMORY_DIR = 'agent-memory';
const GLOBAL_MEMORY_FILE = 'global-memory.json';

// Lazy reference set during initialisation by main.js
let _collectKnownPathsForObjective = null;

function setCollectKnownPaths(fn) {
  _collectKnownPathsForObjective = fn;
}

function memoryDir() {
  return path.join(app.getPath('userData'), MEMORY_DIR);
}

function globalMemoryPath() {
  return path.join(memoryDir(), GLOBAL_MEMORY_FILE);
}

function projectMemoryPath(workspaceRoot) {
  return path.join(memoryDir(), `${sha256(String(workspaceRoot || '').toLowerCase())}.json`);
}

function normalizeMemory(memory) {
  const value = ensureObject(memory);
  return {
    notes: Array.isArray(value.notes) ? value.notes.slice(0, 60).map((item) => String(item).trim()).filter(Boolean) : [],
    recentObjectives: Array.isArray(value.recentObjectives)
      ? value.recentObjectives.slice(0, 20).map((item) => String(item).trim()).filter(Boolean)
      : [],
    artifactPaths: Array.isArray(value.artifactPaths)
      ? value.artifactPaths.slice(0, 160).map((item) => String(item).trim()).filter(Boolean)
      : [],
    updatedAt: value.updatedAt || null,
  };
}

async function readProjectMemory(workspaceRoot) {
  try {
    const raw = await fs.readFile(projectMemoryPath(workspaceRoot), 'utf8');
    return normalizeMemory(JSON.parse(raw));
  } catch {
    return normalizeMemory({});
  }
}

async function writeProjectMemory(workspaceRoot, memory) {
  const file = projectMemoryPath(workspaceRoot);
  const payload = normalizeMemory({
    ...memory,
    updatedAt: new Date().toISOString(),
  });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function toMemoryPrompt(memory) {
  const notes = Array.isArray(memory.notes) ? memory.notes : [];
  const objectives = Array.isArray(memory.recentObjectives) ? memory.recentObjectives : [];
  const artifacts = Array.isArray(memory.artifactPaths) ? memory.artifactPaths : [];
  if (notes.length === 0 && objectives.length === 0 && artifacts.length === 0) {
    return 'No prior memory captured for this project yet.';
  }

  const blocks = [];
  if (objectives.length > 0) {
    blocks.push(`Recent objectives:\n${objectives.slice(-6).map((item) => `- ${item}`).join('\n')}`);
  }
  if (notes.length > 0) {
    blocks.push(`Persistent notes:\n${notes.slice(-10).map((item) => `- ${item}`).join('\n')}`);
  }
  if (artifacts.length > 0) {
    blocks.push(`Known project artifacts:\n${artifacts.slice(-20).map((item) => `- ${item}`).join('\n')}`);
  }
  return blocks.join('\n\n');
}

function normalizeGlobalMemory(memory) {
  const value = ensureObject(memory);
  const projects = Array.isArray(value.projects) ? value.projects : [];
  return {
    userNotes: Array.isArray(value.userNotes)
      ? value.userNotes.map((item) => String(item).trim()).filter(Boolean).slice(-80)
      : [],
    projects: projects.map((project) => {
      const item = ensureObject(project);
      return {
        workspaceRoot: String(item.workspaceRoot || '').trim(),
        label: String(item.label || '').trim(),
        lastObjective: String(item.lastObjective || '').trim(),
        lastStatus: String(item.lastStatus || '').trim(),
        artifactPaths: Array.isArray(item.artifactPaths)
          ? item.artifactPaths.map((entry) => String(entry).trim()).filter(Boolean).slice(-120)
          : [],
        updatedAt: item.updatedAt || null,
      };
    }).filter((item) => item.workspaceRoot).slice(-20),
    activeWorkspaceRoot: String(value.activeWorkspaceRoot || '').trim(),
    updatedAt: value.updatedAt || null,
  };
}

async function readGlobalMemory() {
  try {
    const raw = await fs.readFile(globalMemoryPath(), 'utf8');
    return normalizeGlobalMemory(JSON.parse(raw));
  } catch {
    return normalizeGlobalMemory({});
  }
}

async function writeGlobalMemory(memory) {
  const payload = normalizeGlobalMemory({
    ...memory,
    updatedAt: new Date().toISOString(),
  });
  const file = globalMemoryPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function toGlobalMemoryPrompt(globalMemory, objective, workspaceRoot) {
  const policy = detectObjectivePolicy(objective);
  const objectiveWords = wordsForMatch(objective);
  const rawNotes = Array.isArray(globalMemory.userNotes) ? globalMemory.userNotes.slice(-24) : [];
  const notes = objectiveWords.length === 0
    ? rawNotes.slice(-6)
    : rawNotes
      .map((note) => ({
        note,
        score: objectiveOverlapScore(note, objectiveWords),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 6)
      .map((item) => item.note);
  // Truncate individual notes to keep prompt compact for local models
  const trimmedNotes = notes.map((n) => {
    const s = String(n).trim();
    return s.length > 200 ? s.slice(0, 200) + '...' : s;
  });
  const knownPaths = policy.webResearchPreferred
    ? []
    : (_collectKnownPathsForObjective
      ? _collectKnownPathsForObjective(globalMemory, objective, workspaceRoot)
      : []);
  // Limit artifact paths to keep prompt compact
  const trimmedPaths = knownPaths.slice(0, 15);
  const lines = [];
  if (trimmedNotes.length > 0) {
    lines.push(`User/project notes:\n${trimmedNotes.map((item) => `- ${item}`).join('\n')}`);
  }
  if (trimmedPaths.length > 0) {
    lines.push(`Known relevant artifact paths:\n${trimmedPaths.map((item) => `- ${item}`).join('\n')}`);
  }
  if (lines.length === 0) {
    return 'No global context memory yet.';
  }
  return lines.join('\n\n');
}

function collectArtifactsFromResults(results) {
  const output = [];
  for (const result of results || []) {
    const metadata = ensureObject(result.metadata);
    if (typeof metadata.path === 'string' && metadata.path.trim().length > 0) {
      output.push(metadata.path.trim());
    }
    if (metadata.kind === 'playwright') {
      const outputText = String(result.output || '');
      const match = outputText.match(/"screenshotPath"\s*:\s*"([^"]+)"/);
      if (match && match[1]) {
        output.push(match[1]);
      }
    }
  }
  return Array.from(new Set(output)).slice(0, 120);
}

function collectWrittenArtifactsFromRun(runState) {
  const results = Array.isArray(runState?.results) ? runState.results : [];
  const workspaceRoot = String(runState?.workspaceRoot || '').trim();
  const paths = [];
  for (const result of results) {
    if (!result || result.ok !== true) {
      continue;
    }
    const tool = String(result.tool || '');
    if (tool !== 'write_file' && tool !== 'append_file') {
      continue;
    }
    const metadata = ensureObject(result.metadata);
    const raw = String(metadata.path || '').trim();
    if (!raw) {
      continue;
    }
    const absolute = path.isAbsolute(raw)
      ? path.resolve(raw)
      : (workspaceRoot ? path.resolve(workspaceRoot, raw) : raw);
    paths.push(absolute);
  }
  return Array.from(new Set(paths)).slice(0, 200);
}

function inferProjectLabel(workspaceRoot, objective) {
  const workspaceName = path.basename(workspaceRoot);
  const objectiveWords = wordsForMatch(objective).slice(0, 4);
  if (objectiveWords.length === 0) {
    return workspaceName || 'project';
  }
  return `${workspaceName}: ${objectiveWords.join(' ')}`;
}

module.exports = {
  MEMORY_DIR,
  GLOBAL_MEMORY_FILE,
  setCollectKnownPaths,
  memoryDir,
  globalMemoryPath,
  projectMemoryPath,
  normalizeMemory,
  readProjectMemory,
  writeProjectMemory,
  toMemoryPrompt,
  normalizeGlobalMemory,
  readGlobalMemory,
  writeGlobalMemory,
  toGlobalMemoryPrompt,
  collectArtifactsFromResults,
  collectWrittenArtifactsFromRun,
  inferProjectLabel,
};
