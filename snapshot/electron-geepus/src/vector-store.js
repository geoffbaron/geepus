'use strict';

/**
 * vector-store.js — Local file-backed vector database for semantic memory.
 *
 * Stores embeddings as JSON alongside metadata.  Uses brute-force cosine
 * similarity for retrieval (fast enough for <10K vectors).
 *
 * Supports namespaces to separate different kinds of knowledge:
 *   - "project:<hash>"  — per-workspace memories
 *   - "global"          — cross-project notes
 *   - "runs"            — run summaries and outcomes
 *
 * Persistence: one JSON file per namespace in userData/vector-store/
 */

const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { app } = require('electron');
const { cosineSimilarity } = require('./embeddings');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORE_DIR = 'vector-store';
const MAX_VECTORS_PER_NS = 5000;
const DEFAULT_TOP_K = 8;
const MIN_SIMILARITY = 0.15;

// ---------------------------------------------------------------------------
// In-memory index  (namespace → VectorEntry[])
// ---------------------------------------------------------------------------

/**
 * VectorEntry shape:
 *   { id: string, text: string, embedding: number[], metadata: object, createdAt: string }
 */
const namespaces = new Map();

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function storeDir() {
  return path.join(app.getPath('userData'), STORE_DIR);
}

function namespaceFile(namespace) {
  const safe = namespace.replace(/[^a-z0-9_-]/gi, '_');
  return path.join(storeDir(), `${safe}.json`);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function loadNamespace(namespace) {
  if (namespaces.has(namespace)) return namespaces.get(namespace);
  try {
    const raw = await fs.readFile(namespaceFile(namespace), 'utf8');
    const data = JSON.parse(raw);
    const entries = Array.isArray(data) ? data : [];
    namespaces.set(namespace, entries);
    return entries;
  } catch {
    namespaces.set(namespace, []);
    return [];
  }
}

async function saveNamespace(namespace) {
  const entries = namespaces.get(namespace) || [];
  const file = namespaceFile(namespace);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(entries), 'utf8');
}

// ---------------------------------------------------------------------------
// CRUD Operations
// ---------------------------------------------------------------------------

/**
 * Add a vector entry to a namespace.
 * @param {string} namespace
 * @param {string} text        — the original text chunk
 * @param {number[]} embedding — the embedding vector
 * @param {object}  metadata   — arbitrary metadata (source, type, etc.)
 * @returns {object} the created entry
 */
async function addVector(namespace, text, embedding, metadata = {}) {
  const entries = await loadNamespace(namespace);

  // Dedup: if identical text already exists, update its embedding
  const existingIdx = entries.findIndex((e) => e.text === text);
  if (existingIdx !== -1) {
    entries[existingIdx].embedding = Array.from(embedding);
    entries[existingIdx].metadata = { ...entries[existingIdx].metadata, ...metadata };
    entries[existingIdx].updatedAt = new Date().toISOString();
    await saveNamespace(namespace);
    return entries[existingIdx];
  }

  const entry = {
    id: crypto.randomUUID(),
    text: text.slice(0, 8000),
    embedding: Array.from(embedding),
    metadata: metadata || {},
    createdAt: new Date().toISOString(),
  };

  entries.push(entry);

  // Evict oldest if over limit
  while (entries.length > MAX_VECTORS_PER_NS) {
    entries.shift();
  }

  await saveNamespace(namespace);
  return entry;
}

/**
 * Add multiple vectors in a single batch (fewer disk writes).
 */
async function addVectors(namespace, items) {
  const entries = await loadNamespace(namespace);

  for (const item of items) {
    const { text, embedding, metadata = {} } = item;
    const existingIdx = entries.findIndex((e) => e.text === text);
    if (existingIdx !== -1) {
      entries[existingIdx].embedding = Array.from(embedding);
      entries[existingIdx].metadata = { ...entries[existingIdx].metadata, ...metadata };
      entries[existingIdx].updatedAt = new Date().toISOString();
      continue;
    }

    entries.push({
      id: crypto.randomUUID(),
      text: String(text).slice(0, 8000),
      embedding: Array.from(embedding),
      metadata: metadata || {},
      createdAt: new Date().toISOString(),
    });
  }

  while (entries.length > MAX_VECTORS_PER_NS) {
    entries.shift();
  }

  await saveNamespace(namespace);
  return entries.length;
}

/**
 * Remove a vector by id.
 */
async function removeVector(namespace, id) {
  const entries = await loadNamespace(namespace);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  entries.splice(idx, 1);
  await saveNamespace(namespace);
  return true;
}

/**
 * Remove all vectors matching a metadata filter.
 */
async function removeVectorsByMetadata(namespace, filterFn) {
  const entries = await loadNamespace(namespace);
  const before = entries.length;
  const kept = entries.filter((e) => !filterFn(e.metadata));
  namespaces.set(namespace, kept);
  if (kept.length !== before) {
    await saveNamespace(namespace);
  }
  return before - kept.length;
}

/**
 * Semantic search within a namespace.
 *
 * @param {string}    namespace
 * @param {number[]}  queryEmbedding  — the query vector
 * @param {object}    options
 *   topK:         max results (default 8)
 *   minSimilarity: threshold  (default 0.15)
 *   metadataFilter: fn(metadata) → bool (optional pre-filter)
 * @returns {{ id, text, metadata, similarity }[]}
 */
async function search(namespace, queryEmbedding, options = {}) {
  const {
    topK = DEFAULT_TOP_K,
    minSimilarity = MIN_SIMILARITY,
    metadataFilter = null,
  } = options;

  const entries = await loadNamespace(namespace);
  if (entries.length === 0) return [];

  const queryVec = queryEmbedding instanceof Float64Array
    ? queryEmbedding
    : new Float64Array(queryEmbedding);

  const scored = [];
  for (const entry of entries) {
    if (metadataFilter && !metadataFilter(entry.metadata)) continue;

    const entryVec = entry.embedding instanceof Float64Array
      ? entry.embedding
      : new Float64Array(entry.embedding);

    // Dimension mismatch → skip (happens when switching between local/API embeddings)
    if (entryVec.length !== queryVec.length) continue;

    const sim = cosineSimilarity(queryVec, entryVec);
    if (sim >= minSimilarity) {
      scored.push({
        id: entry.id,
        text: entry.text,
        metadata: entry.metadata,
        similarity: Math.round(sim * 1000) / 1000,
      });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}

/**
 * Search across multiple namespaces and merge results.
 */
async function searchMultiple(namespaceList, queryEmbedding, options = {}) {
  const results = [];
  for (const ns of namespaceList) {
    const hits = await search(ns, queryEmbedding, options);
    for (const hit of hits) {
      results.push({ ...hit, namespace: ns });
    }
  }
  results.sort((a, b) => b.similarity - a.similarity);
  const topK = options.topK || DEFAULT_TOP_K;
  return results.slice(0, topK);
}

/**
 * Get stats for a namespace.
 */
async function getNamespaceStats(namespace) {
  const entries = await loadNamespace(namespace);
  return {
    namespace,
    count: entries.length,
    oldestAt: entries.length > 0 ? entries[0].createdAt : null,
    newestAt: entries.length > 0 ? entries[entries.length - 1].createdAt : null,
  };
}

/**
 * List all known namespace files.
 */
async function listNamespaces() {
  try {
    const dir = storeDir();
    const files = await fs.readdir(dir);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

/**
 * Clear a namespace.
 */
async function clearNamespace(namespace) {
  namespaces.set(namespace, []);
  await saveNamespace(namespace);
}

module.exports = {
  STORE_DIR,
  MAX_VECTORS_PER_NS,
  addVector,
  addVectors,
  removeVector,
  removeVectorsByMetadata,
  search,
  searchMultiple,
  getNamespaceStats,
  listNamespaces,
  clearNamespace,
  loadNamespace,
  // For testing
  storeDir,
};
