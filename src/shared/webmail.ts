/**
 * "Geepus Browser" webmail sessions (PLAN2.md N2) — the user signs into their email once,
 * in a real, visible browser window, exactly like they always do (password + 2FA and all).
 * Geepus never sees or stores the password; the session lives in an OS-encrypted browser
 * profile like any other browser. This replaces IMAP/app-passwords as the default path —
 * IMAP survives as a Settings → Advanced fallback for people who prefer it.
 */

export type WebmailProviderId = 'gmail';

export interface WebmailProviderInfo {
  id: WebmailProviderId;
  label: string;
  /** Shown in the "connect your email" tile before a session exists. */
  domains: string[];
}

export const WEBMAIL_PROVIDERS: WebmailProviderInfo[] = [
  { id: 'gmail', label: 'Gmail', domains: ['gmail.com', 'googlemail.com'] },
];

export interface WebmailConnectionStatus {
  connected: boolean;
  provider: WebmailProviderId | null;
}
