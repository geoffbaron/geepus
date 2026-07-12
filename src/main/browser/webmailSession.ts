import { app } from 'electron';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { EmailSummary } from '@shared/mail';
import type { WebmailProviderId } from '@shared/webmail';
import { BrowserSession } from './session';
import { GMAIL_INBOX_URL, GMAIL_LOGIN_URL, isGmailUrlSignedIn, readGmailUnread } from './providers/gmail';

/**
 * The "Geepus Browser" webmail session (PLAN2.md N2) — a real, visible, separate browser
 * profile from the agent's own headless browsing profile (src/main/browser/instance.ts).
 * The user signs in here exactly like they always do, password and 2FA included; Geepus
 * never sees the password, only whatever the resulting session cookie lets it read.
 */

const PROVIDER_CONFIG: Record<WebmailProviderId, { loginUrl: string; inboxUrl: string; isSignedIn: (url: string) => boolean }> = {
  gmail: { loginUrl: GMAIL_LOGIN_URL, inboxUrl: GMAIL_INBOX_URL, isSignedIn: isGmailUrlSignedIn },
};

function webmailProfileDir(userDataDir: string): string {
  return join(userDataDir, 'browser-profiles', 'webmail');
}

let session: BrowserSession | null = null;
let sessionHeadless = true;

/**
 * Mode-aware session reuse. The connect flow NEEDS a visible window (the user signs in
 * there); routine inbox reads must NOT pop one (a daily brief that flashes a browser
 * window every morning fails "simple to operate"). Both modes share one profile dir —
 * Chromium locks profiles to a single running instance, so an open session is reused
 * as-is by readers regardless of mode (never yank a window out from under a mid-sign-in
 * user); only connect() force-relaunches when the existing session is headless.
 */
function getWebmailSession(options: { requireVisible: boolean } = { requireVisible: false }): BrowserSession {
  if (!session) {
    sessionHeadless = !options.requireVisible;
    session = new BrowserSession(webmailProfileDir(app.getPath('userData')), { headless: sessionHeadless });
  }
  return session;
}

/** Opens (or focuses) a real, visible window at the provider's real sign-in page. Returns
 * as soon as the page is up — the user completes sign-in in their own time; the app polls
 * checkConnectionStatus() separately rather than blocking here. */
export async function connectWebmailProvider(providerId: WebmailProviderId): Promise<void> {
  const config = PROVIDER_CONFIG[providerId];
  if (session && sessionHeadless) {
    // An invisible session (from a background inbox read) holds the profile lock — swap
    // it for a visible one; connect is user-initiated so a brief relaunch is expected.
    await session.close();
    session = null;
  }
  const browserSession = getWebmailSession({ requireVisible: true });
  await browserSession.goto(config.loginUrl);
  await browserSession.focus();
}

/** Navigates to the provider's inbox and checks whether the profile is already signed in
 * (URL-based — no DOM dependency, so a Gmail redesign can't silently break this). */
export async function checkWebmailConnectionStatus(providerId: WebmailProviderId): Promise<boolean> {
  const config = PROVIDER_CONFIG[providerId];
  const browserSession = getWebmailSession();
  await browserSession.goto(config.inboxUrl);
  const url = browserSession.currentUrl() ?? '';
  const connected = config.isSignedIn(url);
  if (connected && !sessionHeadless) {
    // Sign-in finished — don't leave the visible window lingering. The session cookies
    // live on disk in the profile; every future read relaunches invisibly.
    await browserSession.close();
    session = null;
  }
  return connected;
}

export async function readWebmailUnread(providerId: WebmailProviderId, limit = 20): Promise<EmailSummary[]> {
  const config = PROVIDER_CONFIG[providerId];
  const browserSession = getWebmailSession();
  await browserSession.goto(config.inboxUrl);
  if (!config.isSignedIn(browserSession.currentUrl() ?? '')) {
    throw new Error('Not signed in — reconnect this email account.');
  }
  if (providerId === 'gmail') {
    return browserSession.withPage((page) => readGmailUnread(page, limit));
  }
  throw new Error(`No inbox reader implemented for provider "${providerId}" yet.`);
}

/** Closes the browser context and deletes the profile directory entirely — matches
 * Settings → Connections "sign out" from PLAN2.md N5: a clean, complete disconnect, not
 * just clearing a flag while cookies linger on disk. */
export async function disconnectWebmail(): Promise<void> {
  await session?.close();
  session = null;
  await rm(webmailProfileDir(app.getPath('userData')), { recursive: true, force: true }).catch(() => {});
}
