import { app } from 'electron';
import { BrowserSession, defaultBrowserProfileDir } from './session';

let session: BrowserSession | null = null;

/** One shared browser session per app run — mirrors the prototype's global
 * activeContext/activePage singleton (a single-user desktop app only ever needs one
 * browser the agent is driving at a time). */
export function getBrowserSession(): BrowserSession {
  if (!session) {
    session = new BrowserSession(defaultBrowserProfileDir(app.getPath('userData')));
  }
  return session;
}

export async function closeBrowserSession(): Promise<void> {
  await session?.close();
  session = null;
}
