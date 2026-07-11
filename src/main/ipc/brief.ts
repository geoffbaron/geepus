import { app, ipcMain } from 'electron';
import { composeDailyBrief, fetchWeatherSummary } from '../agents/brief';
import { generateSuggestions } from '../agents/suggest';
import { runInboxAgent, type InboxRunResult } from '../agents/inbox';
import { getScheduler } from '../schedule/instance';
import { getMemoryService } from '../memory/instance';
import { loadSecrets, loadSettings } from '../settings/store';

export function registerBriefIpc(): void {
  ipcMain.handle('brief.generate', async () => {
    const userDataDir = app.getPath('userData');
    const [settings, secrets] = await Promise.all([loadSettings(userDataDir), loadSecrets(userDataDir)]);
    const memory = getMemoryService(settings.ollama.baseUrl);

    let inbox: InboxRunResult | undefined;
    if (settings.mail.enabled && settings.mail.host && secrets.imapPassword) {
      try {
        inbox = await runInboxAgent({
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
        inbox = undefined; // IMAP unreachable — brief still renders without the inbox section
      }
    }

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
