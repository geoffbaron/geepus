import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSuggestions } from './suggest';
import { MemoryService } from '../memory/service';

describe('generateSuggestions', () => {
  let dir: string;
  let memory: MemoryService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geepus-suggest-test-'));
    memory = new MemoryService({ dataDir: dir });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('use local hash embeddings in tests')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('suggests retrying a failed run', async () => {
    await memory.recordRunOutcome({ objective: 'deploy the staging environment', workspaceRoot: '/tmp/ws', success: false, toolSequence: [] });
    const suggestions = await generateSuggestions(memory);
    expect(suggestions.some((s) => s.objective === 'deploy the staging environment')).toBe(true);
    expect(suggestions.find((s) => s.objective === 'deploy the staging environment')?.text).toContain('Retry');
  });

  it('does not suggest a successful run', async () => {
    await memory.recordRunOutcome({ objective: 'check the weather', workspaceRoot: '/tmp/ws', success: true, toolSequence: ['http_get'] });
    const suggestions = await generateSuggestions(memory);
    expect(suggestions.some((s) => s.objective === 'check the weather')).toBe(false);
  });

  it('deduplicates repeated failures of the same objective', async () => {
    await memory.recordRunOutcome({ objective: 'sync the calendar', workspaceRoot: '/tmp/ws', success: false, toolSequence: [] });
    await memory.recordRunOutcome({ objective: 'sync the calendar', workspaceRoot: '/tmp/ws', success: false, toolSequence: [] });
    const suggestions = await generateSuggestions(memory);
    expect(suggestions.filter((s) => s.objective === 'sync the calendar')).toHaveLength(1);
  });

  it('respects the limit', async () => {
    for (let i = 0; i < 8; i++) {
      await memory.recordRunOutcome({ objective: `failed task number ${i}`, workspaceRoot: '/tmp/ws', success: false, toolSequence: [] });
    }
    const suggestions = await generateSuggestions(memory, 3);
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  it('returns an empty array when there is no run history', async () => {
    expect(await generateSuggestions(memory)).toEqual([]);
  });
});
