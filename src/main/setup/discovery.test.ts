import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverRuntimes } from './discovery';

describe('discoverRuntimes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports ollama unavailable and lmstudio unavailable when nothing responds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const report = await discoverRuntimes();

    const ollama = report.runtimes.find((r) => r.id === 'ollama');
    const lmstudio = report.runtimes.find((r) => r.id === 'lmstudio');
    expect(ollama?.available).toBe(false);
    expect(lmstudio?.available).toBe(false);
  });

  it('reports lmstudio models when its server responds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('1234')) {
          return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }), { status: 200 }));
        }
        return Promise.reject(new Error('ECONNREFUSED'));
      }),
    );
    const report = await discoverRuntimes();
    const lmstudio = report.runtimes.find((r) => r.id === 'lmstudio');
    expect(lmstudio?.available).toBe(true);
    expect(lmstudio?.models).toEqual([{ name: 'qwen2.5-7b-instruct', sizeGb: 0, chatCapable: true }]);
  });

  it('never throws even if every probe fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('nope')));
    await expect(discoverRuntimes()).resolves.toBeDefined();
  });
});
