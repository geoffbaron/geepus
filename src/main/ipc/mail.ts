import { app, ipcMain } from 'electron';
import type { ImapAccountConfig } from '../mail/imap';
import { testImapConnection } from '../mail/imap';
import { runInboxAgent } from '../agents/inbox';
import { loadSecrets, loadSettings, saveSecrets, saveSettings } from '../settings/store';
import { getMemoryService } from '../memory/instance';

export interface SaveMailAccountInput {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

async function resolveImapConfig(): Promise<ImapAccountConfig | null> {
  const userDataDir = app.getPath('userData');
  const [settings, secrets] = await Promise.all([loadSettings(userDataDir), loadSecrets(userDataDir)]);
  if (!settings.mail.enabled || !settings.mail.host || !settings.mail.user || !secrets.imapPassword) return null;
  return {
    host: settings.mail.host,
    port: settings.mail.port,
    secure: settings.mail.secure,
    user: settings.mail.user,
    pass: secrets.imapPassword,
  };
}

export function registerMailIpc(): void {
  ipcMain.handle('mail.testConnection', (_event, config: ImapAccountConfig) => testImapConnection(config));

  ipcMain.handle('mail.saveAccount', async (_event, config: SaveMailAccountInput) => {
    const userDataDir = app.getPath('userData');
    const settings = await loadSettings(userDataDir);
    await saveSettings(userDataDir, {
      ...settings,
      mail: { enabled: true, host: config.host, port: config.port, secure: config.secure, user: config.user },
    });
    const secrets = await loadSecrets(userDataDir);
    await saveSecrets(userDataDir, { ...secrets, imapPassword: config.pass });
  });

  ipcMain.handle('mail.isConfigured', async () => (await resolveImapConfig()) !== null);

  ipcMain.handle('mail.runInboxNow', async () => {
    const config = await resolveImapConfig();
    if (!config) throw new Error('IMAP is not configured yet.');
    const settings = await loadSettings(app.getPath('userData'));
    const memory = getMemoryService(settings.ollama.baseUrl);
    return runInboxAgent({ imapConfig: config, memory });
  });
}
