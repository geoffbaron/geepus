import type { ProviderStatus } from '@shared/model';
import type { Settings } from '@shared/settings';
import type { Secrets } from '../settings/store';
import type { ModelProvider } from './provider';
import { OllamaProvider } from './ollama';
import { OpenRouterProvider } from './openrouter';
import { BundledProvider } from './bundled';

export interface ResolveProviderDeps {
  settings: Settings;
  secrets: Secrets;
  /** null until ensureBundledModel() has resolved a verified local file. */
  bundledModelPath: string | null;
}

/**
 * Picks which ModelProvider backs the current chat. The GEEPUS_DEV_PROVIDER env
 * override always wins — that's Geoff's dev/testing path since his own machine
 * can't run the larger local models (PLAN.md §3); it's never exposed to the
 * friend-facing settings UI.
 */
export function resolveActiveProvider(deps: ResolveProviderDeps): ModelProvider {
  const devProvider = process.env['GEEPUS_DEV_PROVIDER'];
  const devKey = process.env['OPENROUTER_API_KEY'];
  if (devProvider === 'openrouter' && devKey) {
    return new OpenRouterProvider({
      apiKey: devKey,
      model: process.env['OPENROUTER_MODEL'] || deps.settings.developer.openrouterModel,
    });
  }

  switch (deps.settings.activeProvider) {
    case 'ollama':
      return new OllamaProvider({ baseUrl: deps.settings.ollama.baseUrl, model: deps.settings.ollama.model });
    case 'openrouter':
      if (!deps.secrets.openrouterApiKey) {
        throw new Error('OpenRouter is selected but no API key is configured');
      }
      return new OpenRouterProvider({
        apiKey: deps.secrets.openrouterApiKey,
        model: deps.settings.developer.openrouterModel,
      });
    case 'bundled':
    default:
      if (!deps.bundledModelPath) {
        throw new Error('the bundled model is not ready yet');
      }
      return new BundledProvider(deps.bundledModelPath);
  }
}

export async function getProviderStatuses(deps: ResolveProviderDeps): Promise<ProviderStatus[]> {
  const ollama = new OllamaProvider({ baseUrl: deps.settings.ollama.baseUrl, model: deps.settings.ollama.model });
  const openrouter = new OpenRouterProvider({
    apiKey: deps.secrets.openrouterApiKey ?? '',
    model: deps.settings.developer.openrouterModel,
  });
  const bundled = deps.bundledModelPath ? new BundledProvider(deps.bundledModelPath) : null;

  return [
    { id: 'ollama', available: await ollama.isAvailable() },
    { id: 'bundled', available: bundled ? await bundled.isAvailable() : false },
    { id: 'openrouter', available: await openrouter.isAvailable() },
  ];
}
