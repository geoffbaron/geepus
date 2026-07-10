import { describe, expect, it, afterEach, vi } from 'vitest';

describe('env.is.dev', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it('is true when the electron-vite dev server URL is set', async () => {
    vi.resetModules();
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173';
    delete process.env.NODE_ENV;
    const { is } = await import('./env');
    expect(is.dev).toBe(true);
  });

  it('is false in a packaged production run', async () => {
    vi.resetModules();
    delete process.env['ELECTRON_RENDERER_URL'];
    process.env.NODE_ENV = 'production';
    const { is } = await import('./env');
    expect(is.dev).toBe(false);
  });
});
