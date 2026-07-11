import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consolidateAll } from './consolidate';
import { VectorStore } from './vectorStore';

describe('consolidateAll', () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geepus-consolidate-test-'));
    store = new VectorStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reduces a namespace seeded with duplicates (M4 accept criteria)', async () => {
    // Simulate duplicates that slipped past add()'s exact-text dedup — e.g. written by an
    // older version of the code, or restored from a backup — by writing raw entries directly.
    const { writeFile, mkdir: mkdirp } = await import('node:fs/promises');
    await mkdirp(dir, { recursive: true });
    await writeFile(
      join(dir, 'global.json'),
      JSON.stringify({
        entries: [
          { id: '1', text: 'duplicate note', embedding: [1, 0], embeddingModel: 'm', metadata: {}, createdAt: 1 },
          { id: '2', text: 'duplicate note', embedding: [1, 0], embeddingModel: 'm', metadata: {}, createdAt: 2 },
          { id: '3', text: 'unique note', embedding: [0, 1], embeddingModel: 'm', metadata: {}, createdAt: 3 },
        ],
      }),
    );

    const reports = await consolidateAll(store);
    const globalReport = reports.find((r) => r.namespace === 'global');
    expect(globalReport?.duplicatesRemoved).toBe(1);

    const remaining = await store.list('global');
    expect(remaining).toHaveLength(2);
  });

  it('returns an empty report list when there are no namespaces yet', async () => {
    expect(await consolidateAll(store)).toEqual([]);
  });

  it('is a no-op (zero duplicates removed) on an already-clean namespace', async () => {
    await store.add('ns1', 'a', [1, 0], 'm');
    await store.add('ns1', 'b', [0, 1], 'm');
    const reports = await consolidateAll(store);
    expect(reports.find((r) => r.namespace === 'ns1')?.duplicatesRemoved).toBe(0);
  });
});
