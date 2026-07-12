import type { ProviderId } from './model';
import type { WebmailProviderId } from './webmail';

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
  /** The Geepus Browser webmail connection (PLAN2.md N2) — the default, zero-app-password
   * path. `mail` above (IMAP) is the Settings → Advanced fallback. Connection liveness
   * itself is never cached here; it's checked fresh against the real browser session. */
  webmail: { provider: WebmailProviderId | null };
  brief: { latitude: number | null; longitude: number | null };
}
