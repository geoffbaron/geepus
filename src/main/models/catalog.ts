import type { ModelCatalogEntry, RamTier } from '@shared/model';

/**
 * Every entry's `ollamaTag` must exist in the Ollama registry — verified by
 * `npm run verify:catalog` (scripts/verify-catalog.mjs) and in CI, so this list
 * never drifts into the speculative/unreleased tags the prototype shipped
 * (PLAN.md §10 — ollama-manager.js catalog was never checked against reality).
 */
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  { ollamaTag: 'llama3.2:3b', family: 'llama3.2', paramsB: 3, quant: 'q4_K_M', sizeGb: 2.0, minRamGb: 8, tier: 'basic' },
  { ollamaTag: 'llama3.1:8b', family: 'llama3.1', paramsB: 8, quant: 'q4_K_M', sizeGb: 4.7, minRamGb: 16, tier: 'good' },
  { ollamaTag: 'qwen2.5:14b', family: 'qwen2.5', paramsB: 14, quant: 'q4_K_M', sizeGb: 9.0, minRamGb: 32, tier: 'great' },
  { ollamaTag: 'qwen2.5:32b', family: 'qwen2.5', paramsB: 32, quant: 'q4_K_M', sizeGb: 19.8, minRamGb: 64, tier: 'monster' },
  {
    ollamaTag: 'nomic-embed-text:latest',
    family: 'nomic-embed-text',
    paramsB: 0.137,
    quant: 'f16',
    sizeGb: 0.27,
    minRamGb: 4,
    tier: 'minimal',
    embedding: true,
  },
];

const TIER_ORDER: RamTier[] = ['minimal', 'basic', 'good', 'great', 'monster'];

/** Below 8GB there's no safe local chat-model recommendation — bundled tiny model only. */
export function ramTierFor(ramGb: number): RamTier {
  if (ramGb >= 64) return 'monster';
  if (ramGb >= 32) return 'great';
  if (ramGb >= 16) return 'good';
  if (ramGb >= 8) return 'basic';
  return 'minimal';
}

/**
 * Best chat model for a RAM tier: the entry pinned to that tier if present,
 * else the richest entry that still fits under the tier's ceiling.
 */
export function recommendChatModel(ramGb: number): ModelCatalogEntry | null {
  const tier = ramTierFor(ramGb);
  const tierIndex = TIER_ORDER.indexOf(tier);
  const candidates = MODEL_CATALOG.filter((m) => !m.embedding && m.minRamGb <= ramGb);
  if (candidates.length === 0) return null;

  const exact = candidates.find((m) => m.tier === tier);
  if (exact) return exact;

  // Fall back to the highest tier at or below this machine's tier.
  return candidates
    .filter((m) => TIER_ORDER.indexOf(m.tier) <= tierIndex)
    .sort((a, b) => b.minRamGb - a.minRamGb)[0] ?? null;
}

export function recommendEmbeddingModel(): ModelCatalogEntry {
  const entry = MODEL_CATALOG.find((m) => m.embedding);
  if (!entry) throw new Error('no embedding model in catalog');
  return entry;
}

export function fitsRam(entry: ModelCatalogEntry, ramGb: number): boolean {
  return ramGb >= entry.minRamGb;
}
