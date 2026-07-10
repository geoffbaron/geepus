import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSettings, saveSettings } from './store';
import { DEFAULT_SETTINGS } from './schema';

// safeStorage-backed secrets (loadSecrets/saveSecrets) require the real Electron
// runtime and are covered by e2e tests, not here — see PLAN.md milestone e2e/ plans.
describe('settings store', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geepus-settings-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns defaults when no settings file exists yet', async () => {
    expect(await loadSettings(dir)).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips saved settings', async () => {
    const settings = { ...DEFAULT_SETTINGS, activeProvider: 'ollama' as const };
    await saveSettings(dir, settings);
    expect(await loadSettings(dir)).toEqual(settings);
  });

  it('falls back to defaults when the settings file is corrupted', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'settings.json'), 'not valid json{{{');
    expect(await loadSettings(dir)).toEqual(DEFAULT_SETTINGS);
  });

  it('fills in defaults for a partial/old settings file (schema migration safety)', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ activeProvider: 'openrouter' }));
    const loaded = await loadSettings(dir);
    expect(loaded.activeProvider).toBe('openrouter');
    expect(loaded.ollama).toEqual(DEFAULT_SETTINGS.ollama);
  });
});
