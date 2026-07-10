import { safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from './schema';

export async function loadSettings(userDataDir: string): Promise<Settings> {
  try {
    const raw = await readFile(join(userDataDir, 'settings.json'), 'utf8');
    return SettingsSchema.parse(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(userDataDir: string, settings: Settings): Promise<void> {
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, 'settings.json'), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

/** Secrets never touch settings.json — encrypted at rest via the OS keychain (PLAN.md §9). */
export interface Secrets {
  openrouterApiKey?: string;
}

export async function loadSecrets(userDataDir: string): Promise<Secrets> {
  try {
    const encrypted = await readFile(join(userDataDir, 'secrets.bin'));
    if (!safeStorage.isEncryptionAvailable()) return {};
    return JSON.parse(safeStorage.decryptString(encrypted)) as Secrets;
  } catch {
    return {};
  }
}

export async function saveSecrets(userDataDir: string, secrets: Secrets): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level secret encryption is not available on this machine');
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(secrets));
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, 'secrets.bin'), encrypted, { mode: 0o600 });
}
