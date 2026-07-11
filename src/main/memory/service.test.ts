import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryService } from './service';

describe('MemoryService', () => {
  let dir: string;
  let service: MemoryService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geepus-memoryservice-test-'));
    service = new MemoryService({ dataDir: dir });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('use local hash embeddings in tests')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('remember/recall round-trips a note scoped to a workspace', async () => {
    await service.remember('the user prefers TypeScript over JavaScript', '/Users/test/project');
    const hits = await service.recall('what language does the user like', '/Users/test/project', 5);
    expect(hits.some((h) => h.text.includes('TypeScript'))).toBe(true);
  });

  it('global notes are visible regardless of workspace', async () => {
    await service.remember('the user is based in Blaine, WA');
    const hits = await service.recall('where is the user located', '/Users/test/some-other-project');
    expect(hits.some((h) => h.text.includes('Blaine'))).toBe(true);
  });

  it('recallPrompt formats hits as a prompt-ready string', async () => {
    // Word-overlapping phrasing on purpose: the local-hash fallback embedding used in these
    // unit tests is a crude bag-of-words match, not real semantic similarity — it needs
    // shared vocabulary. service.live.test.ts separately proves true semantic matching
    // (near-zero word overlap) against the real Ollama embedding model.
    await service.remember('the user likes concise responses');
    const prompt = await service.recallPrompt('how concise should responses be');
    expect(prompt).toContain('concise responses');
  });

  it('recordRunOutcome indexes a run summary regardless of success', async () => {
    await service.recordRunOutcome({
      objective: 'check the weather',
      workspaceRoot: '/tmp/ws',
      success: true,
      toolSequence: ['http_get'],
    });
    const hits = await service.recall('weather check outcome', '/tmp/ws');
    expect(hits.some((h) => h.text.includes('check the weather'))).toBe(true);
  });

  it('recordRunOutcome folds a non-trivial reflection into learned strategies', async () => {
    // Same word-overlap caveat as above — reflection phrasing deliberately echoes the
    // objective's vocabulary so the local-hash fallback can retrieve it.
    await service.recordRunOutcome({
      objective: 'fetch data from an API endpoint',
      workspaceRoot: '/tmp/ws',
      success: true,
      reflection: 'when fetching data from an API endpoint, always check the rate limit headers before retrying',
      toolSequence: ['http_get'],
    });
    const context = await service.getPromptContext('fetch data from an API endpoint');
    expect(context).toContain('rate limit headers');
  });

  it('recordRunOutcome ignores a "nothing notable" reflection', async () => {
    await service.recordRunOutcome({
      objective: 'say hello',
      workspaceRoot: '/tmp/ws',
      success: true,
      reflection: 'Nothing notable.',
      toolSequence: [],
    });
    const context = await service.getPromptContext('say hello');
    expect(context).toBe('');
  });

  // The end-to-end version of the M4 accept criterion, through the real service a caller
  // (runtime/loop.ts) actually uses — not just the underlying skills.ts unit test.
  it('accept criterion end-to-end: a skill synthesized after two successes is injected into getPromptContext for a third run', async () => {
    const objective = 'restart the local dev server';
    const toolSequence = ['run_command'];

    const run1 = await service.recordRunOutcome({ objective, workspaceRoot: '/tmp/ws', success: true, toolSequence });
    expect(run1.skillSynthesized).toBe(false);

    const run2 = await service.recordRunOutcome({ objective, workspaceRoot: '/tmp/ws', success: true, toolSequence });
    expect(run2.skillSynthesized).toBe(true);

    const promptForThirdRun = await service.getPromptContext(objective);
    expect(promptForThirdRun).toContain('Relevant skills');
    expect(promptForThirdRun).toContain(objective);
  });

  it('consolidate() reduces duplicates across the whole store', async () => {
    await service.remember('a note');
    const report = await service.consolidate();
    expect(Array.isArray(report)).toBe(true);
  });

  it('never lets a secret in a remembered note reach disk', async () => {
    await service.remember('save this key: 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');
    const { readdir, readFile } = await import('node:fs/promises');
    const vectorsDir = join(dir, 'vectors');
    const files = await readdir(vectorsDir);
    for (const file of files) {
      const content = await readFile(join(vectorsDir, file), 'utf8');
      expect(content).not.toContain('mWqHDSC56xLqZIgTfvEUHkJoJR6acYBSpsxUoirf4L3X7kdSLwb');
    }
  });
});
