'use strict';

/**
 * embeddings.js — Embedding generation for the vector memory system.
 *
 * Supports OpenAI embeddings API (`text-embedding-3-small`) and falls back
 * to a lightweight local bag-of-words hash when no API key is available.
 *
 * Exports:
 *   generateEmbedding(text, settings)  → Float64Array  (1536-dim or 256-dim local)
 *   generateEmbeddings(texts, settings) → Float64Array[]
 *   cosineSimilarity(a, b) → number
 *   EMBEDDING_DIM
 */

const { readSettings } = require('./settings');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
const OPENAI_EMBEDDING_DIM = 1536;
const LOCAL_EMBEDDING_DIM = 256;

// Cache: content hash → embedding vector (avoids redundant API calls)
const embeddingCache = new Map();
const MAX_CACHE_SIZE = 2000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function simpleHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return hash;
}

function contentKey(text) {
  // Fast, deterministic key for caching
  const trimmed = text.trim().toLowerCase().slice(0, 4000);
  return `${simpleHash(trimmed)}:${trimmed.length}`;
}

// ---------------------------------------------------------------------------
// Local fallback embeddings (bag-of-words hash projection)
// ---------------------------------------------------------------------------

/**
 * When no embedding API is available, project a bag-of-words representation
 * into a fixed-dimension vector using deterministic hashing.  Not as good
 * as a real transformer embedding, but enables RAG functionality offline.
 */
function localEmbedding(text) {
  const tokens = text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);

  const vec = new Float64Array(LOCAL_EMBEDDING_DIM);

  // Unigrams
  for (const token of tokens) {
    const h = Math.abs(simpleHash(token));
    const idx = h % LOCAL_EMBEDDING_DIM;
    vec[idx] += (h & 1) ? 1 : -1;
  }

  // Bigrams for phrase awareness
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]} ${tokens[i + 1]}`;
    const h = Math.abs(simpleHash(bigram));
    const idx = h % LOCAL_EMBEDDING_DIM;
    vec[idx] += (h & 1) ? 0.5 : -0.5;
  }

  // L2-normalize
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;

  return vec;
}

// ---------------------------------------------------------------------------
// OpenAI embedding API
// ---------------------------------------------------------------------------

async function openaiEmbedding(text, apiKey, baseUrl) {
  const url = `${baseUrl}/embeddings`;
  const body = {
    model: OPENAI_EMBEDDING_MODEL,
    input: text.slice(0, 8000), // text-embedding-3-small context limit
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Embedding API error ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const json = await response.json();
  const data = json?.data?.[0]?.embedding;
  if (!Array.isArray(data)) {
    throw new Error('Unexpected embedding response shape');
  }
  return new Float64Array(data);
}

async function openaiEmbeddingBatch(texts, apiKey, baseUrl) {
  const url = `${baseUrl}/embeddings`;
  const body = {
    model: OPENAI_EMBEDDING_MODEL,
    input: texts.map((t) => t.slice(0, 8000)),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Embedding API error ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const json = await response.json();
  const items = json?.data;
  if (!Array.isArray(items)) {
    throw new Error('Unexpected embedding batch response shape');
  }
  // Sort by index (API may return out of order)
  items.sort((a, b) => a.index - b.index);
  return items.map((item) => new Float64Array(item.embedding));
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the current embedding settings.  Returns:
 *  { useApi: boolean, apiKey: string, baseUrl: string, dim: number }
 */
function resolveEmbeddingConfig(settingsOverride) {
  const settings = settingsOverride || {};
  const provider = settings.provider || 'openai';
  const apiKey = settings.apiKey || '';
  const baseUrl = (settings.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const useApi = provider === 'openai' && apiKey.length > 0;
  return {
    useApi,
    apiKey,
    baseUrl,
    dim: useApi ? OPENAI_EMBEDDING_DIM : LOCAL_EMBEDDING_DIM,
  };
}

/**
 * Generate an embedding for a single text string.
 * Uses the OpenAI embeddings API if an API key is available, otherwise
 * falls back to a local bag-of-words hash embedding.
 */
async function generateEmbedding(text, settingsOverride) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  const key = contentKey(trimmed);
  if (embeddingCache.has(key)) return embeddingCache.get(key);

  const config = resolveEmbeddingConfig(settingsOverride);
  let vec;

  if (config.useApi) {
    try {
      vec = await openaiEmbedding(trimmed, config.apiKey, config.baseUrl);
    } catch {
      // Fall back to local if API fails
      vec = localEmbedding(trimmed);
    }
  } else {
    vec = localEmbedding(trimmed);
  }

  // Manage cache size
  if (embeddingCache.size >= MAX_CACHE_SIZE) {
    const firstKey = embeddingCache.keys().next().value;
    embeddingCache.delete(firstKey);
  }
  embeddingCache.set(key, vec);
  return vec;
}

/**
 * Generate embeddings for multiple texts.  Batches OpenAI API calls
 * (max 100 per request) for efficiency.
 */
async function generateEmbeddings(texts, settingsOverride) {
  const config = resolveEmbeddingConfig(settingsOverride);
  const results = new Array(texts.length);

  // Check cache first
  const uncached = []; // { index, text }
  for (let i = 0; i < texts.length; i++) {
    const trimmed = String(texts[i] || '').trim();
    if (!trimmed) {
      results[i] = null;
      continue;
    }
    const key = contentKey(trimmed);
    if (embeddingCache.has(key)) {
      results[i] = embeddingCache.get(key);
    } else {
      uncached.push({ index: i, text: trimmed });
    }
  }

  if (uncached.length === 0) return results;

  if (config.useApi) {
    // Batch in groups of 100 (OpenAI limit)
    const BATCH_SIZE = 100;
    for (let start = 0; start < uncached.length; start += BATCH_SIZE) {
      const batch = uncached.slice(start, start + BATCH_SIZE);
      try {
        const vecs = await openaiEmbeddingBatch(
          batch.map((item) => item.text),
          config.apiKey,
          config.baseUrl,
        );
        for (let j = 0; j < batch.length; j++) {
          const item = batch[j];
          results[item.index] = vecs[j];
          const key = contentKey(item.text);
          if (embeddingCache.size >= MAX_CACHE_SIZE) {
            const firstKey = embeddingCache.keys().next().value;
            embeddingCache.delete(firstKey);
          }
          embeddingCache.set(key, vecs[j]);
        }
      } catch {
        // Fall back to local for this batch
        for (const item of batch) {
          const vec = localEmbedding(item.text);
          results[item.index] = vec;
          const key = contentKey(item.text);
          embeddingCache.set(key, vec);
        }
      }
    }
  } else {
    // All local
    for (const item of uncached) {
      const vec = localEmbedding(item.text);
      results[item.index] = vec;
      const key = contentKey(item.text);
      if (embeddingCache.size >= MAX_CACHE_SIZE) {
        const firstKey = embeddingCache.keys().next().value;
        embeddingCache.delete(firstKey);
      }
      embeddingCache.set(key, vec);
    }
  }

  return results;
}

/**
 * Return the current embedding dimension based on available config.
 */
function getEmbeddingDim(settingsOverride) {
  return resolveEmbeddingConfig(settingsOverride).dim;
}

module.exports = {
  OPENAI_EMBEDDING_DIM,
  LOCAL_EMBEDDING_DIM,
  generateEmbedding,
  generateEmbeddings,
  cosineSimilarity,
  getEmbeddingDim,
  resolveEmbeddingConfig,
  // Exposed for testing
  localEmbedding,
};
