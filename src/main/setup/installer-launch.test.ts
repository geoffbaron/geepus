import { afterEach, describe, expect, it, vi } from 'vitest';

// Isolated from installer.test.ts, which relies on the REAL child_process/spctl for its
// live signature checks — mocking child_process here would break those.
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null, res: { stdout: string; stderr: string }) => void) =>
    cb(null, { stdout: '', stderr: '' }),
  ),
}));

describe('launchOllamaApp', () => {
  afterEach(() => {
    vi.doUnmock('../models/ollama');
    vi.resetModules();
  });

  it('opens the app and returns true once the server responds', async () => {
    vi.doMock('../models/ollama', () => ({ isOllamaServerUp: vi.fn().mockResolvedValue(true) }));
    const { launchOllamaApp } = await import('./installer');
    await expect(launchOllamaApp('/Applications/Ollama.app', 2000)).resolves.toBe(true);
  });

  it('returns false if the server never comes up within the timeout', async () => {
    vi.doMock('../models/ollama', () => ({ isOllamaServerUp: vi.fn().mockResolvedValue(false) }));
    const { launchOllamaApp } = await import('./installer');
    await expect(launchOllamaApp('/Applications/Ollama.app', 100)).resolves.toBe(false);
  });
});
