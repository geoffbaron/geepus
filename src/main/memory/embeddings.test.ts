import { afterEach, describe, expect, it, vi } from 'vitest';
import { cosineSimilarity, embedText, embedTexts, localHashEmbedding } from './embeddings';

describe('localHashEmbedding', () => {
  it('is deterministic for the same text', () => {
    expect(localHashEmbedding('hello world')).toEqual(localHashEmbedding('hello world'));
  });

  it('produces different vectors for different text', () => {
    expect(localHashEmbedding('hello world')).not.toEqual(localHashEmbedding('goodbye moon'));
  });

  it('is L2-normalized', () => {
    const vec = localHashEmbedding('the quick brown fox jumps over the lazy dog');
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('handles empty text without throwing', () => {
    expect(() => localHashEmbedding('')).not.toThrow();
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('is higher for more similar text embeddings than for unrelated ones', () => {
    const a = localHashEmbedding('what is the weather in Blaine');
    const b = localHashEmbedding('check the weather in Blaine WA');
    const c = localHashEmbedding('write a todo app in React');
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
  });

  it('returns 0 for mismatched dimensions instead of throwing', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe('embedTexts', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the local hash fallback when Ollama is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const results = await embedTexts(['hello']);
    expect(results[0]?.model).toBe('local-hash');
    expect(results[0]?.vector).toEqual(localHashEmbedding('hello'));
  });

  it('uses Ollama embeddings when available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }), { status: 200 })),
    );
    const results = await embedTexts(['hello'], { ollamaModel: 'nomic-embed-text' });
    expect(results[0]?.model).toBe('ollama:nomic-embed-text');
    expect(results[0]?.vector).toEqual([0.1, 0.2, 0.3]);
  });

  it('falls back to local hash if Ollama returns a mismatched count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 })),
    );
    const results = await embedTexts(['hello', 'world']);
    expect(results.every((r) => r.model === 'local-hash')).toBe(true);
  });

  it('returns an empty array for no input', async () => {
    expect(await embedTexts([])).toEqual([]);
  });
});

describe('embedText', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('embeds a single string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const result = await embedText('hello');
    expect(result.vector).toHaveLength(256);
  });
});
