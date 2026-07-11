import type { ProviderId } from './model';

/**
 * The canonical Settings shape, usable from main, preload, and renderer alike.
 * main/settings/schema.ts owns zod validation and must produce values assignable
 * to this type (enforced there via a compile-time check).
 */
export interface Settings {
  onboardingComplete: boolean;
  activeProvider: ProviderId;
  ollama: { baseUrl: string; model: string };
  bundled: { modelFilename: string };
  developer: { enabled: boolean; openrouterModel: string };
  mail: { enabled: boolean; host: string; port: number; secure: boolean; user: string };
  brief: { latitude: number | null; longitude: number | null };
}
