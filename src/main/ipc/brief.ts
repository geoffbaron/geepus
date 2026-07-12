import { app, ipcMain } from 'electron';
import { composeDailyBrief, fetchWeatherSummary } from '../agents/brief';
import { generateSuggestions } from '../agents/suggest';
import { runInboxAgent, type InboxRunResult } from '../agents/inbox';
import { runWebmailInboxAgent } from '../agents/webmailInbox';
import { getScheduler } from '../schedule/instance';
import { getMemoryService } from '../memory/instance';
import { loadSecrets, loadSettings } from '../settings/store';

/** Webmail (Geepus Browser, PLAN2.md N2) is the default, zero-app-password inbox source;
 * IMAP is the Settings → Advanced fallback for people who already set it up. Either
 * produces the same InboxRunResult, so composeDailyBrief never needs to know which ran. */
async function resolveInbox(
  settings: Awaited<ReturnType<typeof loadSettings>>,
  secrets: Awaited<ReturnType<typeof loadSecrets>>,
  memory: ReturnType<typeof getMemoryService>,
): Promise<InboxRunResult | undefined> {
  if (settings.webmail.provider) {
    try {
      return await runWebmailInboxAgent({ provider: settings.webmail.provider, memory });
    } catch {
      return undefined; // session expired or not signed in — brief still renders without the inbox section
    }
  }
  if (settings.mail.enabled && settings.mail.host && secrets.imapPassword) {
    try {
      return await runInboxAgent({
        imapConfig: {
          host: settings.mail.host,
          port: settings.mail.port,
          secure: settings.mail.secure,
          user: settings.mail.user,
          pass: secrets.imapPassword,
        },
        memory,
      });
    } catch {
      return undefined; // IMAP unreachable — brief still renders without the inbox section
    }
  }
  return undefined;
}

export function registerBriefIpc(): void {
  ipcMain.handle('brief.generate', async () => {
    const userDataDir = app.getPath('userData');
    const [settings, secrets] = await Promise.all([loadSettings(userDataDir), loadSecrets(userDataDir)]);
    const memory = getMemoryService(settings.ollama.baseUrl);

    const inbox = await resolveInbox(settings, secrets, memory);

    const upcomingTasks = getScheduler()
      .list()
      .filter((t) => t.enabled);
    const suggestions = await generateSuggestions(memory);
    const weatherSummary =
      settings.brief.latitude != null && settings.brief.longitude != null
        ? await fetchWeatherSummary(settings.brief.latitude, settings.brief.longitude)
        : null;

    return composeDailyBrief({ inbox, upcomingTasks, suggestions, weatherSummary });
  });
}
