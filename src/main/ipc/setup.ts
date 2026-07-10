import { app, ipcMain } from 'electron';
import type { DiscoveryReport, MachineProfile } from '@shared/setup';
import { probeHardware } from '../setup/hardware';
import { discoverRuntimes } from '../setup/discovery';
import { recommendForMachine } from '../setup/recommend';
import { determineSetupPath, downloadAndInstallOllama, launchOllamaApp } from '../setup/installer';
import { showWelcomeNotification } from '../setup/permissions';
import { pullOllamaModel } from '../models/ollama';
import { loadSettings, saveSettings } from '../settings/store';

export function registerSetupIpc(): void {
  ipcMain.handle('setup.probeHardware', () => probeHardware(app.getPath('userData')));
  ipcMain.handle('setup.discover', () => discoverRuntimes());
  ipcMain.handle('setup.recommend', (_event, profile: MachineProfile) => recommendForMachine(profile));
  ipcMain.handle('setup.determinePath', (_event, profile: MachineProfile, discovery: DiscoveryReport) =>
    determineSetupPath(profile, discovery),
  );

  ipcMain.handle('setup.adoptOllamaModel', async (_event, modelName: string) => {
    const userDataDir = app.getPath('userData');
    const settings = await loadSettings(userDataDir);
    const next = { ...settings, activeProvider: 'ollama' as const, ollama: { ...settings.ollama, model: modelName } };
    await saveSettings(userDataDir, next);
    return next;
  });

  ipcMain.handle('setup.useBundled', async () => {
    const userDataDir = app.getPath('userData');
    const settings = await loadSettings(userDataDir);
    const next = { ...settings, activeProvider: 'bundled' as const };
    await saveSettings(userDataDir, next);
    return next;
  });

  // Fixed (non-correlated) progress channels — the onboarding wizard is inherently a
  // single sequential flow, unlike chat, so there's no need for per-request IDs here.
  ipcMain.handle('setup.pullModel', async (event, tag: string) => {
    try {
      for await (const progress of pullOllamaModel(tag)) {
        event.sender.send('setup.pullProgress', progress);
      }
    } catch (err) {
      event.sender.send('setup.pullProgress', { model: tag, status: `error: ${(err as Error).message}`, done: true });
    }
  });

  ipcMain.handle('setup.installOllama', (event) =>
    downloadAndInstallOllama({
      onProgress: (downloadedBytes, totalBytes) =>
        event.sender.send('setup.installProgress', { downloadedBytes, totalBytes }),
    }),
  );

  ipcMain.handle('setup.launchOllama', (_event, appPath?: string) => launchOllamaApp(appPath));

  ipcMain.handle('setup.requestNotificationPermission', () => showWelcomeNotification());

  ipcMain.handle('setup.completeOnboarding', async () => {
    const userDataDir = app.getPath('userData');
    const settings = await loadSettings(userDataDir);
    const next = { ...settings, onboardingComplete: true };
    await saveSettings(userDataDir, next);
    return next;
  });
}
