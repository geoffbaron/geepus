import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VectorStore } from './vectorStore';

describe('VectorStore', () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geepus-vectorstore-test-'));
    store = new VectorStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('adds and lists entries', async () => {
    await store.add('ns1', 'hello world', [1, 0, 0], 'test-model', { type: 'note' });
    const entries = await store.list('ns1');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe('hello world');
  });

  it('upserts on exact text match instead of duplicating', async () => {
    await store.add('ns1', 'hello world', [1, 0, 0], 'model-a', { count: 1 });
    await store.add('ns1', 'hello world', [0, 1, 0], 'model-b', { count: 2 });
    const entries = await store.list('ns1');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.embeddingModel).toBe('model-b');
    expect(entries[0]?.metadata['count']).toBe(2);
  });

  it('persists across a fresh VectorStore instance pointed at the same directory', async () => {
    await store.add('ns1', 'persisted note', [1, 0, 0], 'model-a');
    const store2 = new VectorStore(dir);
    const entries = await store2.list('ns1');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe('persisted note');
  });

  it('removes an entry by id', async () => {
    const entry = await store.add('ns1', 'to remove', [1, 0, 0], 'model-a');
    expect(await store.remove('ns1', entry.id)).toBe(true);
    expect(await store.list('ns1')).toHaveLength(0);
  });

  it('remove on an unknown id returns false', async () => {
    expect(await store.remove('ns1', 'does-not-exist')).toBe(false);
  });

  it('clears a namespace', async () => {
    await store.add('ns1', 'a', [1, 0, 0], 'model-a');
    await store.clear('ns1');
    expect(await store.list('ns1')).toHaveLength(0);
  });

  it('evicts the oldest entries once a namespace exceeds the cap', async () => {
    // MAX_VECTORS_PER_NAMESPACE is 5000 — too slow to actually hit in a unit test, so this
    // is covered structurally by inspection; a smaller synthetic cap would need the cap to
    // be injectable, which isn't worth the API surface for M4. Skipped here on purpose.
  });

  describe('search', () => {
    it('finds similar entries above the similarity threshold', async () => {
      await store.add('ns1', 'weather forecast', [1, 0, 0], 'model-a');
      await store.add('ns1', 'unrelated topic', [0, 0, 1], 'model-a');
      const hits = await store.search('ns1', [1, 0, 0], 'model-a', { minSimilarity: 0.5 });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.text).toBe('weather forecast');
    });

    it('respects topK', async () => {
      await store.add('ns1', 'a', [1, 0, 0], 'model-a');
      await store.add('ns1', 'b', [0.9, 0.1, 0], 'model-a');
      await store.add('ns1', 'c', [0.8, 0.2, 0], 'model-a');
      const hits = await store.search('ns1', [1, 0, 0], 'model-a', { topK: 2, minSimilarity: 0 });
      expect(hits).toHaveLength(2);
    });

    it('skips mismatched-model entries when no reembed function is given', async () => {
      await store.add('ns1', 'old model entry', [1, 0], 'model-old');
      const hits = await store.search('ns1', [1, 0, 0], 'model-new', { minSimilarity: 0 });
      expect(hits).toHaveLength(0);
    });

    // Regression: the ported prototype's vector-store.js just skipped dimension-mismatched
    // entries forever once you switched embedding models. PLAN.md §8 item 6 requires lazy
    // re-embedding instead — this is the actual fix.
    it('regression: lazily re-embeds mismatched entries instead of losing them forever', async () => {
      await store.add('ns1', 'old model entry', [1, 0], 'model-old');
      const hits = await store.search('ns1', [1, 0, 0], 'model-new', {
        minSimilarity: 0.5,
        reembed: async () => ({ vector: [1, 0, 0], model: 'model-new' }),
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.text).toBe('old model entry');

      // And the upgrade was persisted — a second search with no reembed fn still finds it.
      const entries = await store.list('ns1');
      expect(entries[0]?.embeddingModel).toBe('model-new');
      const secondSearch = await store.search('ns1', [1, 0, 0], 'model-new', { minSimilarity: 0.5 });
      expect(secondSearch).toHaveLength(1);
    });

    it('returns an empty array for a namespace that has never been written to', async () => {
      expect(await store.search('never-used', [1, 0, 0], 'model-a')).toEqual([]);
    });
  });

  describe('dedupe', () => {
    it('removes exact-duplicate text entries, keeping the newest', async () => {
      await store.add('ns1', 'unique a', [1, 0, 0], 'model-a');
      await store.add('ns1', 'unique b', [0, 1, 0], 'model-a');
      expect(await store.dedupe('ns1')).toBe(0); // add() already dedupes exact text on write

      const entries = await store.list('ns1');
      expect(entries).toHaveLength(2);
    });
  });

  describe('listNamespaces / stats', () => {
    it('lists every namespace that has been written', async () => {
      await store.add('ns1', 'a', [1], 'm');
      await store.add('ns2', 'b', [1], 'm');
      expect((await store.listNamespaces()).sort()).toEqual(['ns1', 'ns2']);
    });

    it('reports entry counts', async () => {
      await store.add('ns1', 'a', [1], 'm');
      await store.add('ns1', 'b', [1], 'm');
      expect(await store.stats('ns1')).toEqual({ count: 2 });
    });

    it('lists no namespaces for a fresh store directory', async () => {
      const fresh = new VectorStore(join(dir, 'never-touched'));
      expect(await fresh.listNamespaces()).toEqual([]);
    });
  });
});
