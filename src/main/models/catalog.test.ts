import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG, fitsRam, ramTierFor, recommendChatModel, recommendEmbeddingModel } from './catalog';

describe('ramTierFor', () => {
  it.each([
    [4, 'minimal'],
    [8, 'basic'],
    [15, 'basic'],
    [16, 'good'],
    [31, 'good'],
    [32, 'great'],
    [63, 'great'],
    [64, 'monster'],
    [128, 'monster'],
  ] as const)('%dGB -> %s', (ram, tier) => {
    expect(ramTierFor(ram)).toBe(tier);
  });
});

describe('recommendChatModel', () => {
  it('returns null under the minimum supported RAM', () => {
    expect(recommendChatModel(4)).toBeNull();
  });

  it('recommends the 3B model at 8GB', () => {
    expect(recommendChatModel(8)?.ollamaTag).toBe('llama3.2:3b');
  });

  it('recommends the 8B model at 16GB', () => {
    expect(recommendChatModel(16)?.ollamaTag).toBe('llama3.1:8b');
  });

  it('recommends the 14B model at 32GB', () => {
    expect(recommendChatModel(32)?.ollamaTag).toBe('qwen2.5:14b');
  });

  it('recommends the 32B model at 64GB+', () => {
    expect(recommendChatModel(64)?.ollamaTag).toBe('qwen2.5:32b');
    expect(recommendChatModel(128)?.ollamaTag).toBe('qwen2.5:32b');
  });

  it('never recommends a model that does not fit in RAM', () => {
    for (let ram = 4; ram <= 128; ram += 4) {
      const model = recommendChatModel(ram);
      if (model) expect(fitsRam(model, ram)).toBe(true);
    }
  });

  it('never recommends the embedding-only model as a chat model', () => {
    for (let ram = 4; ram <= 128; ram += 4) {
      expect(recommendChatModel(ram)?.embedding).not.toBe(true);
    }
  });
});

describe('recommendEmbeddingModel', () => {
  it('always returns the embedding entry', () => {
    expect(recommendEmbeddingModel().embedding).toBe(true);
  });
});

describe('catalog integrity', () => {
  it('has exactly one embedding entry', () => {
    expect(MODEL_CATALOG.filter((m) => m.embedding)).toHaveLength(1);
  });

  it('has unique ollama tags', () => {
    const tags = MODEL_CATALOG.map((m) => m.ollamaTag);
    expect(new Set(tags).size).toBe(tags.length);
  });
});
