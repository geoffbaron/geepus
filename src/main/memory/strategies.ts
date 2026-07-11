import type { EmbeddingConfig } from './embeddings';
import { embedTexts } from './embeddings';
import { redactSecrets } from './redact';
import { STRATEGIES_NAMESPACE } from './rag';
import type { VectorStore } from './vectorStore';

export interface LearnedStrategy {
  id: string;
  text: string;
  attempts: number;
  successes: number;
  banned: boolean;
}

/** "Is this basically the same strategy already recorded" — high on purpose, so near-
 * duplicate reflections merge into one counter instead of piling up as separate entries. */
const SIMILARITY_MATCH_THRESHOLD = 0.9;
const BAN_MIN_ATTEMPTS = 3;
const BAN_MAX_SUCCESS_RATE = 0.34;

function toStrategy(id: string, text: string, metadata: Record<string, unknown>): LearnedStrategy {
  return {
    id,
    text,
    attempts: Number(metadata['attempts'] ?? 0),
    successes: Number(metadata['successes'] ?? 0),
    banned: Boolean(metadata['banned']),
  };
}

/**
 * Records a run's reflection as a learned strategy — merges into an existing near-
 * duplicate (bumping its counters) rather than creating endless near-identical entries,
 * and demotes repeatedly-failing strategies to banned so they stop being suggested
 * (PLAN.md §8 item 2).
 */
export async function recordStrategyOutcome(
  store: VectorStore,
  text: string,
  success: boolean,
  embeddingConfig?: EmbeddingConfig,
): Promise<LearnedStrategy> {
  const redacted = redactSecrets(text.trim());
  const [embedding] = await embedTexts([redacted], embeddingConfig);
  if (!embedding) throw new Error('failed to embed strategy text');

  const matches = await store.search(STRATEGIES_NAMESPACE, embedding.vector, embedding.model, {
    topK: 1,
    minSimilarity: SIMILARITY_MATCH_THRESHOLD,
  });
  const match = matches[0];

  const priorAttempts = match ? Number(match.metadata['attempts'] ?? 0) : 0;
  const priorSuccesses = match ? Number(match.metadata['successes'] ?? 0) : 0;
  const attempts = priorAttempts + 1;
  const successes = priorSuccesses + (success ? 1 : 0);
  const banned = attempts >= BAN_MIN_ATTEMPTS && successes / attempts < BAN_MAX_SUCCESS_RATE;

  const entry = await store.add(STRATEGIES_NAMESPACE, match?.text ?? redacted, embedding.vector, embedding.model, {
    attempts,
    successes,
    banned,
  });

  return toStrategy(entry.id, entry.text, entry.metadata);
}

/** Non-banned strategies relevant to an objective, for injection into the planner prompt. */
export async function getRelevantStrategies(
  store: VectorStore,
  objective: string,
  topK = 3,
  embeddingConfig?: EmbeddingConfig,
): Promise<LearnedStrategy[]> {
  const [embedding] = await embedTexts([objective], embeddingConfig);
  if (!embedding) return [];

  const hits = await store.search(STRATEGIES_NAMESPACE, embedding.vector, embedding.model, {
    topK: topK * 3,
    minSimilarity: 0.1,
  });
  return hits
    .map((hit) => toStrategy(hit.id, hit.text, hit.metadata))
    .filter((strategy) => !strategy.banned)
    .slice(0, topK);
}

export async function listAllStrategies(store: VectorStore): Promise<LearnedStrategy[]> {
  const entries = await store.list(STRATEGIES_NAMESPACE);
  return entries.map((entry) => toStrategy(entry.id, entry.text, entry.metadata));
}
