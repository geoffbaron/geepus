import { app } from 'electron';
import { join } from 'node:path';
import { BUNDLED_MODEL, ensureBundledModel } from './bundled';

let bundledModelPath: string | null = null;
let bundledModelError: string | null = null;

export function getBundledModelPath(): string | null {
  return bundledModelPath;
}

export function getBundledModelError(): string | null {
  return bundledModelError;
}

/**
 * Resolves the bundled tiny model at startup: the "full" build's baked resource if
 * present, else the "lite" build's userData cache, downloading it on first run.
 * Runs in the background — the window shows immediately; chat just waits on
 * getBundledModelPath() until this settles (PLAN.md §6.5).
 */
export async function bootstrapBundledModel(
  onProgress?: (downloadedBytes: number, totalBytes: number) => void,
): Promise<void> {
  const bakedPath = join(process.resourcesPath, 'models', BUNDLED_MODEL.filename);
  const cachePath = join(app.getPath('userData'), 'models', BUNDLED_MODEL.filename);
  try {
    bundledModelPath = await ensureBundledModel({ bakedPath, cachePath, onProgress });
  } catch (err) {
    bundledModelError = (err as Error).message;
  }
}
