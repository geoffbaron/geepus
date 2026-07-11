const LOCAL_HASH_DIM = 256;
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'nomic-embed-text';

function simpleHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return hash;
}

/** Deterministic bag-of-words hash projection — the fallback when no Ollama embedding
 * model is reachable, so RAG still works fully offline (ported from the prototype's
 * embeddings.js, minus the OpenAI path — local only, per PLAN.md §3). */
export function localHashEmbedding(text: string): number[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);

  // Indices are always in bounds by construction (modulo LOCAL_HASH_DIM); the `!`s just
  // work around noUncheckedIndexedAccess treating every indexed read as possibly undefined.
  const vec = new Float64Array(LOCAL_HASH_DIM);
  for (const token of tokens) {
    const h = Math.abs(simpleHash(token));
    const idx = h % LOCAL_HASH_DIM;
    vec[idx] = vec[idx]! + (h & 1 ? 1 : -1);
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]} ${tokens[i + 1]}`;
    const h = Math.abs(simpleHash(bigram));
    const idx = h % LOCAL_HASH_DIM;
    vec[idx] = vec[idx]! + (h & 1 ? 0.5 : -0.5);
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  const va = Float64Array.from(a);
  const vb = Float64Array.from(b);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < va.length; i++) {
    const x = va[i]!;
    const y = vb[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface EmbeddingConfig {
  ollamaBaseUrl?: string;
  ollamaModel?: string;
}

export interface EmbeddingResult {
  vector: number[];
  /** e.g. "ollama:nomic-embed-text" or "local-hash" — recorded per-entry so a store can
   * detect a model change and lazily re-embed instead of silently skipping mismatches
   * (PLAN.md §8 item 6, fixing the prototype's vector-store.js). */
  model: string;
}

async function ollamaEmbed(texts: string[], baseUrl: string, model: string): Promise<number[][] | null> {
  try {
    const res = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { embeddings?: number[][] };
    return Array.isArray(data.embeddings) ? data.embeddings : null;
  } catch {
    return null;
  }
}

export async function embedTexts(texts: string[], config: EmbeddingConfig = {}): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];
  const baseUrl = config.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL;
  const model = config.ollamaModel ?? DEFAULT_OLLAMA_MODEL;

  const ollamaResults = await ollamaEmbed(texts, baseUrl, model);
  if (ollamaResults && ollamaResults.length === texts.length) {
    return ollamaResults.map((vector) => ({ vector, model: `ollama:${model}` }));
  }

  return texts.map((text) => ({ vector: localHashEmbedding(text), model: 'local-hash' }));
}

export async function embedText(text: string, config: EmbeddingConfig = {}): Promise<EmbeddingResult> {
  const results = await embedTexts([text], config);
  // embedTexts always returns one result per non-empty input text.
  return results[0]!;
}
