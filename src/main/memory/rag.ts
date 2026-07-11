import { createHash } from 'node:crypto';
import { embedTexts, type EmbeddingConfig } from './embeddings';
import { redactSecrets } from './redact';
import type { VectorStore } from './vectorStore';

export function workspaceNamespace(workspaceRoot: string): string {
  const hash = createHash('sha256').update(workspaceRoot.toLowerCase()).digest('hex');
  return `project_${hash}`;
}

export const GLOBAL_NAMESPACE = 'global';
export const RUNS_NAMESPACE = 'runs';
export const STRATEGIES_NAMESPACE = 'strategies';
export const SKILLS_NAMESPACE = 'skills';

export function chunkText(text: string, maxChars = 1600, overlapChars = 200): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    const end = Math.min(start + maxChars, trimmed.length);
    chunks.push(trimmed.slice(start, end));
    if (end >= trimmed.length) break;
    start = end - overlapChars;
  }
  return chunks;
}

export interface IndexOptions {
  embeddingConfig?: EmbeddingConfig;
}

/**
 * Every write to the vector store goes through this — redaction happens here,
 * structurally, so no code path can accidentally persist a secret (M4 accept criteria).
 */
export async function indexText(
  store: VectorStore,
  namespace: string,
  text: string,
  metadata: Record<string, unknown>,
  options: IndexOptions = {},
): Promise<number> {
  const redacted = redactSecrets(text);
  const chunks = chunkText(redacted);
  if (chunks.length === 0) return 0;

  const embeddings = await embedTexts(chunks, options.embeddingConfig);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const embedding = embeddings[i]!;
    await store.add(namespace, chunk, embedding.vector, embedding.model, { ...metadata, chunkIndex: i });
  }
  return chunks.length;
}

export interface RetrievedHit {
  text: string;
  metadata: Record<string, unknown>;
  similarity: number;
  namespace: string;
}

export async function retrieveContext(
  store: VectorStore,
  query: string,
  namespaces: string[],
  options: { topK?: number; minSimilarity?: number; embeddingConfig?: EmbeddingConfig } = {},
): Promise<RetrievedHit[]> {
  const [queryEmbedding] = await embedTexts([query], options.embeddingConfig);
  if (!queryEmbedding) return [];

  const results: RetrievedHit[] = [];
  for (const namespace of namespaces) {
    const hits = await store.search(namespace, queryEmbedding.vector, queryEmbedding.model, {
      topK: options.topK,
      minSimilarity: options.minSimilarity,
      reembed: async (text) => {
        const [reembedded] = await embedTexts([text], options.embeddingConfig);
        return { vector: reembedded!.vector, model: reembedded!.model };
      },
    });
    for (const hit of hits) results.push({ ...hit, namespace });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, options.topK ?? 10);
}

export function toRagPrompt(hits: RetrievedHit[]): string {
  if (hits.length === 0) return '';
  const lines = ['Relevant context from memory:'];
  for (const hit of hits) {
    const type = String(hit.metadata['type'] ?? 'note');
    lines.push(`- [${type}, relevance ${hit.similarity}] ${hit.text.slice(0, 400)}`);
  }
  return lines.join('\n');
}
