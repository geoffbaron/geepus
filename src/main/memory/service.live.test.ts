// Not run in CI — hits the real Ollama embedding server. Run with:
// GEEPUS_LIVE_TESTS=1 npx vitest run service.live.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryService } from './service';

describe.skipIf(!process.env['GEEPUS_LIVE_TESTS'])('MemoryService (live, real Ollama embeddings)', () => {
  let dir: string;
  let service: MemoryService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geepus-memoryservice-live-test-'));
    service = new MemoryService({ dataDir: dir, embeddingConfig: { ollamaModel: 'nomic-embed-text' } });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it(
    'finds genuinely semantically related notes with almost no shared vocabulary',
    async () => {
      await service.remember('The user mentioned they live near the Canadian border in the Pacific Northwest.');
      await service.remember('Best practices for writing unit tests in TypeScript.');

      const hits = await service.recall('Where does the user reside?');
      expect(hits.length).toBeGreaterThan(0);
      // The geography note should rank above the unrelated testing note.
      expect(hits[0]?.text).toContain('Canadian border');

      const files = await import('node:fs/promises').then((fs) => fs.readdir(join(dir, 'vectors')));
      expect(files.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it(
    'records the real embedding model name against stored entries, not the local-hash fallback',
    async () => {
      await service.remember('a note that should use the real embedding model');
      const entries = await service.store.list('global');
      expect(entries.some((e) => e.embeddingModel === 'ollama:nomic-embed-text')).toBe(true);
    },
    30_000,
  );
});
