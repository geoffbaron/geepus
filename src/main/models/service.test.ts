import { afterEach, describe, expect, it } from 'vitest';
import { resolveActiveProvider } from './service';
import { DEFAULT_SETTINGS } from '../settings/schema';
import { OllamaProvider } from './ollama';
import { OpenRouterProvider } from './openrouter';
import { BundledProvider } from './bundled';

describe('resolveActiveProvider', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves the ollama provider when selected', () => {
    delete process.env['GEEPUS_DEV_PROVIDER'];
    const provider = resolveActiveProvider({
      settings: { ...DEFAULT_SETTINGS, activeProvider: 'ollama' },
      secrets: {},
      bundledModelPath: null,
    });
    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  it('resolves the bundled provider when selected and a model path is ready', () => {
    delete process.env['GEEPUS_DEV_PROVIDER'];
    const provider = resolveActiveProvider({
      settings: { ...DEFAULT_SETTINGS, activeProvider: 'bundled' },
      secrets: {},
      bundledModelPath: '/tmp/model.gguf',
    });
    expect(provider).toBeInstanceOf(BundledProvider);
  });

  it('throws when bundled is selected but no model has been resolved yet', () => {
    delete process.env['GEEPUS_DEV_PROVIDER'];
    expect(() =>
      resolveActiveProvider({
        settings: { ...DEFAULT_SETTINGS, activeProvider: 'bundled' },
        secrets: {},
        bundledModelPath: null,
      }),
    ).toThrow(/not ready/);
  });

  it('throws when openrouter is selected but no key is configured', () => {
    delete process.env['GEEPUS_DEV_PROVIDER'];
    expect(() =>
      resolveActiveProvider({
        settings: { ...DEFAULT_SETTINGS, activeProvider: 'openrouter' },
        secrets: {},
        bundledModelPath: null,
      }),
    ).toThrow(/no API key/);
  });

  it('resolves openrouter when selected and a key is configured', () => {
    delete process.env['GEEPUS_DEV_PROVIDER'];
    const provider = resolveActiveProvider({
      settings: { ...DEFAULT_SETTINGS, activeProvider: 'openrouter' },
      secrets: { openrouterApiKey: 'sk-or-test' },
      bundledModelPath: null,
    });
    expect(provider).toBeInstanceOf(OpenRouterProvider);
  });

  it('GEEPUS_DEV_PROVIDER=openrouter overrides settings when an API key env var is present', () => {
    process.env['GEEPUS_DEV_PROVIDER'] = 'openrouter';
    process.env['OPENROUTER_API_KEY'] = 'sk-or-dev';
    const provider = resolveActiveProvider({
      settings: { ...DEFAULT_SETTINGS, activeProvider: 'bundled' },
      secrets: {},
      bundledModelPath: null,
    });
    expect(provider).toBeInstanceOf(OpenRouterProvider);
  });

  it('ignores GEEPUS_DEV_PROVIDER when no API key env var is set', () => {
    process.env['GEEPUS_DEV_PROVIDER'] = 'openrouter';
    delete process.env['OPENROUTER_API_KEY'];
    const provider = resolveActiveProvider({
      settings: { ...DEFAULT_SETTINGS, activeProvider: 'ollama' },
      secrets: {},
      bundledModelPath: null,
    });
    expect(provider).toBeInstanceOf(OllamaProvider);
  });
});
