'use strict';

/**
 * rag.js — Retrieval-Augmented Generation pipeline.
 *
 * High-level module that ties embeddings.js + vector-store.js together.
 * Provides:
 *   - indexMemory / indexRunSummary / indexFreeText  — ingestion
 *   - retrieveContext(query, settings, options)      — retrieval
 *   - toRAGPrompt(hits)                             — prompt formatting
 *
 * Namespaces:
 *   "project:<sha256>"  — per-workspace memory chunks
 *   "global"            — cross-project user notes
 *   "runs"              — objective outcomes & summaries
 */

const { sha256 } = require('./audit');
const {
  generateEmbedding,
  generateEmbeddings,
} = require('./embeddings');
const {
  addVector,
  addVectors,
  search,
  searchMultiple,
  getNamespaceStats,
  listNamespaces,
  removeVectorsByMetadata,
} = require('./vector-store');

// ---------------------------------------------------------------------------
// Namespace helpers
// ---------------------------------------------------------------------------

function projectNamespace(workspaceRoot) {
  return `project_${sha256(String(workspaceRoot || '').toLowerCase())}`;
}

const GLOBAL_NS = 'global';
const RUNS_NS = 'runs';

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Split a long text into overlapping chunks suitable for embedding.
 * Target ~400 tokens per chunk with 50-token overlap.
 */
function chunkText(text, maxChars = 1600, overlapChars = 200) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks = [];
  let start = 0;
  while (start < trimmed.length) {
    const end = Math.min(start + maxChars, trimmed.length);
    chunks.push(trimmed.slice(start, end));
    if (end >= trimmed.length) break;
    start = end - overlapChars;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Ingestion functions
// ---------------------------------------------------------------------------

/**
 * Index project memory notes + recent objectives into the project namespace.
 * Called after each run completes (from agent-loop.js).
 */
async function indexProjectMemory(workspaceRoot, memory, settings) {
  if (!workspaceRoot) return 0;
  const ns = projectNamespace(workspaceRoot);

  const texts = [];
  const metadataList = [];

  // Notes
  const notes = Array.isArray(memory.notes) ? memory.notes : [];
  for (const note of notes) {
    const trimmed = String(note).trim();
    if (trimmed.length < 8) continue;
    texts.push(trimmed);
    metadataList.push({ type: 'note', source: 'project_memory', workspaceRoot });
  }

  // Recent objectives
  const objectives = Array.isArray(memory.recentObjectives) ? memory.recentObjectives : [];
  for (const obj of objectives) {
    const trimmed = String(obj).trim();
    if (trimmed.length < 8) continue;
    texts.push(trimmed);
    metadataList.push({ type: 'objective', source: 'project_memory', workspaceRoot });
  }

  if (texts.length === 0) return 0;

  const embeddings = await generateEmbeddings(texts, settings);
  const items = [];
  for (let i = 0; i < texts.length; i++) {
    if (!embeddings[i]) continue;
    items.push({ text: texts[i], embedding: embeddings[i], metadata: metadataList[i] });
  }

  return addVectors(ns, items);
}

/**
 * Index a completed run's summary into the "runs" namespace.
 * Includes the objective, outcome, and key notes.
 */
async function indexRunSummary(runState, settings) {
  const objective = String(runState.objective || '').trim();
  const report = String(runState.report || runState.reason || '').trim();
  const workspace = String(runState.workspaceRoot || '').trim();
  const state = String(runState.state || '').trim();
  const runId = String(runState.runId || '').trim();

  if (!objective) return 0;

  // Build a summary document that captures the run's essence
  const parts = [
    `Objective: ${objective}`,
    `Outcome: ${state}`,
    workspace ? `Project: ${workspace}` : '',
    report ? `Summary: ${report.slice(0, 2000)}` : '',
  ].filter(Boolean);

  const fullText = parts.join('\n');
  const chunks = chunkText(fullText);

  const embeddings = await generateEmbeddings(chunks, settings);
  const items = [];
  for (let i = 0; i < chunks.length; i++) {
    if (!embeddings[i]) continue;
    items.push({
      text: chunks[i],
      embedding: embeddings[i],
      metadata: {
        type: 'run_summary',
        runId,
        state,
        workspaceRoot: workspace,
        objective: objective.slice(0, 200),
        indexedAt: new Date().toISOString(),
      },
    });
  }

  return addVectors(RUNS_NS, items);
}

/**
 * Index global memory notes.
 */
async function indexGlobalMemory(globalMemory, settings) {
  const notes = Array.isArray(globalMemory.userNotes) ? globalMemory.userNotes : [];
  if (notes.length === 0) return 0;

  const texts = [];
  const metadataList = [];

  for (const note of notes.slice(-40)) {
    const trimmed = String(note).trim();
    if (trimmed.length < 8) continue;
    texts.push(trimmed);
    metadataList.push({ type: 'global_note', source: 'global_memory' });
  }

  if (texts.length === 0) return 0;

  const embeddings = await generateEmbeddings(texts, settings);
  const items = [];
  for (let i = 0; i < texts.length; i++) {
    if (!embeddings[i]) continue;
    items.push({ text: texts[i], embedding: embeddings[i], metadata: metadataList[i] });
  }

  return addVectors(GLOBAL_NS, items);
}

/**
 * Index arbitrary text (e.g., from a user adding knowledge manually).
 */
async function indexFreeText(text, namespace, metadata, settings) {
  const chunks = chunkText(text);
  if (chunks.length === 0) return 0;

  const embeddings = await generateEmbeddings(chunks, settings);
  const items = [];
  for (let i = 0; i < chunks.length; i++) {
    if (!embeddings[i]) continue;
    items.push({
      text: chunks[i],
      embedding: embeddings[i],
      metadata: { ...metadata, chunkIndex: i, indexedAt: new Date().toISOString() },
    });
  }

  return addVectors(namespace, items);
}

// ---------------------------------------------------------------------------
// Retrieval functions
// ---------------------------------------------------------------------------

/**
 * Retrieve semantically relevant context for a given query.
 *
 * @param {string} query        — the objective or question
 * @param {object} settings     — { apiKey, baseUrl, provider, ... }
 * @param {object} options
 *   workspaceRoot: string   — scope to this project's namespace too
 *   topK: number            — max results (default 10)
 *   minSimilarity: number   — threshold (default 0.2)
 *   includeRuns: boolean    — search run summaries (default true)
 *   includeGlobal: boolean  — search global notes (default true)
 * @returns {{ text, metadata, similarity, namespace }[]}
 */
async function retrieveContext(query, settings, options = {}) {
  const {
    workspaceRoot = '',
    topK = 10,
    minSimilarity = 0.2,
    includeRuns = true,
    includeGlobal = true,
  } = options;

  const queryEmbedding = await generateEmbedding(query, settings);
  if (!queryEmbedding) return [];

  const namespacesToSearch = [];
  if (workspaceRoot) {
    namespacesToSearch.push(projectNamespace(workspaceRoot));
  }
  if (includeRuns) {
    namespacesToSearch.push(RUNS_NS);
  }
  if (includeGlobal) {
    namespacesToSearch.push(GLOBAL_NS);
  }

  if (namespacesToSearch.length === 0) return [];

  return searchMultiple(namespacesToSearch, queryEmbedding, {
    topK,
    minSimilarity,
  });
}

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

/**
 * Format retrieved RAG hits into a prompt section for the planner.
 */
function toRAGPrompt(hits) {
  if (!Array.isArray(hits) || hits.length === 0) {
    return '';
  }

  const lines = ['Relevant context from memory (semantic search):'];
  for (const hit of hits) {
    const source = hit.metadata?.type || 'unknown';
    const sim = hit.similarity ? ` (relevance: ${hit.similarity})` : '';
    const workspace = hit.metadata?.workspaceRoot
      ? ` [${hit.metadata.workspaceRoot}]`
      : '';
    lines.push(`- [${source}${workspace}${sim}] ${hit.text.slice(0, 500)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Stats / management
// ---------------------------------------------------------------------------

async function getRAGStats() {
  const nsList = await listNamespaces();
  const stats = [];
  for (const ns of nsList) {
    stats.push(await getNamespaceStats(ns));
  }
  return {
    namespaces: stats,
    totalVectors: stats.reduce((sum, s) => sum + s.count, 0),
  };
}

async function clearProjectVectors(workspaceRoot) {
  const ns = projectNamespace(workspaceRoot);
  const { clearNamespace } = require('./vector-store');
  await clearNamespace(ns);
}

module.exports = {
  // Namespaces
  projectNamespace,
  GLOBAL_NS,
  RUNS_NS,
  // Chunking
  chunkText,
  // Ingestion
  indexProjectMemory,
  indexRunSummary,
  indexGlobalMemory,
  indexFreeText,
  // Retrieval
  retrieveContext,
  // Prompt
  toRAGPrompt,
  // Management
  getRAGStats,
  clearProjectVectors,
};
