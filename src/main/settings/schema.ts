import { z } from 'zod';
import type { Settings as SharedSettings } from '@shared/settings';

export const ProviderIdSchema = z.enum(['ollama', 'bundled', 'openrouter']);

/**
 * Non-secret settings only — API keys live in secrets.bin via safeStorage
 * (src/main/settings/store.ts), never in this file (PLAN.md §9 / §10, replacing
 * the prototype's plaintext settings.json).
 */
export const SettingsSchema = z.object({
  onboardingComplete: z.boolean().default(false),
  activeProvider: ProviderIdSchema.default('bundled'),
  ollama: z
    .object({
      baseUrl: z.string().default('http://127.0.0.1:11434'),
      model: z.string().default(''),
    })
    .default({}),
  bundled: z
    .object({
      modelFilename: z.string().default('qwen2.5-1.5b-instruct-q4_k_m.gguf'),
    })
    .default({}),
  /**
   * Hidden by default in the renderer — never shown to the friend-facing onboarding
   * wizard (PLAN.md §3). `enabled` gates the Settings UI toggle; the OpenRouter API
   * key itself is a secret (see store.ts) so it isn't duplicated here.
   */
  developer: z
    .object({
      enabled: z.boolean().default(false),
      openrouterModel: z.string().default('openai/gpt-4o-mini'),
    })
    .default({}),
  /** IMAP app-password itself lives in secrets.bin, never here (PLAN.md §9). */
  mail: z
    .object({
      enabled: z.boolean().default(false),
      host: z.string().default(''),
      port: z.number().default(993),
      secure: z.boolean().default(true),
      user: z.string().default(''),
    })
    .default({}),
  /** Used only for the Daily Brief's weather section — null skips it entirely. */
  brief: z
    .object({
      latitude: z.number().nullable().default(null),
      longitude: z.number().nullable().default(null),
    })
    .default({}),
});

export type Settings = z.infer<typeof SettingsSchema>;

// Compile-time check: the zod-inferred shape must stay assignable to the shared
// Settings type that flows through IPC — if this errors, update shared/settings.ts too.
type _AssertAssignable = Settings extends SharedSettings ? true : never;
const _assertAssignable: _AssertAssignable = true;
void _assertAssignable;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});
