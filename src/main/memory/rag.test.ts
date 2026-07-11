import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_NAMESPACE, chunkText, indexText, retrieveContext, toRagPrompt, workspaceNamespace } from './rag';
import { VectorStore } from './vectorStore';

describe('workspaceNamespace', () => {
  it('is deterministic and case-insensitive', () => {
    expect(workspaceNamespace('/Users/geoff/project')).toBe(workspaceNamespace('/Users/geoff/PROJECT'));
  });

  it('differs for different workspaces', () => {
    expect(workspaceNamespace('/a')).not.toBe(workspaceNamespace('/b'));
  });
});

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('hello world')).toEqual(['hello world']);
  });

  it('returns nothing for empty/whitespace text', () => {
    expect(chunkText('   ')).toEqual([]);
  });

  it('splits long text into overlapping chunks', () => {
    const text = 'a'.repeat(5000);
    const chunks = chunkText(text, 1600, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 1600)).toBe(true);
  });
});

describe('indexText / retrieveContext / toRagPrompt', () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geepus-rag-test-'));
    store = new VectorStore(dir);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in unit tests — use local hash embeddings')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('indexes text and makes it retrievable by a semantically similar query', async () => {
    await indexText(store, GLOBAL_NAMESPACE, 'the user prefers dark mode in all apps', { type: 'note' });
    const hits = await retrieveContext(store, 'what theme does the user prefer', [GLOBAL_NAMESPACE], { minSimilarity: 0 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toContain('dark mode');
  });

  // Regression: this is the M4 accept criteria's explicit requirement — a secret must
  // never reach disk, not even transiently, because indexText is the one choke point
  // everything writes through.
  it('regression: never persists a secret to the vector store file on disk', async () => {
    await indexText(
      store,
      GLOBAL_NAMESPACE,
      'the API key is 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',
      { type: 'note' },
    );

    const files = await import('node:fs/promises').then((fs) => fs.readdir(dir));
    for (const file of files) {
      const content = await readFile(join(dir, file), 'utf8');
      expect(content).not.toContain('mWqHDSC56xLqZIgTfvEUHkJoJR6acYBSpsxUoirf4L3X7kdSLwb');
      expect(content).toContain('[REDACTED_API_KEY]');
    }
  });

  it('retrieveContext returns nothing for an empty namespace', async () => {
    expect(await retrieveContext(store, 'anything', ['never-indexed'])).toEqual([]);
  });

  it('searches across multiple namespaces and merges/sorts by similarity', async () => {
    await indexText(store, 'ns-a', 'the weather in Blaine is sunny today', { type: 'note' });
    await indexText(store, 'ns-b', 'completely unrelated text about cooking pasta', { type: 'note' });
    const hits = await retrieveContext(store, 'weather in Blaine', ['ns-a', 'ns-b'], { minSimilarity: 0 });
    expect(hits[0]?.namespace).toBe('ns-a');
  });
});

describe('toRagPrompt', () => {
  it('returns an empty string for no hits', () => {
    expect(toRagPrompt([])).toBe('');
  });

  it('formats hits with type and relevance', () => {
    const prompt = toRagPrompt([{ text: 'a fact', metadata: { type: 'note' }, similarity: 0.5, namespace: 'global' }]);
    expect(prompt).toContain('a fact');
    expect(prompt).toContain('note');
    expect(prompt).toContain('0.5');
  });
});
